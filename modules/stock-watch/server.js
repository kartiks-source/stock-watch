'use strict';
/*
 * Catalys · Stock-out Watch — server. Plain Node, no dependencies.
 *
 *   npm start            → http://localhost:4400
 *   ADMIN_PASSWORD=...   → the page and /api ask for it (any user name). Required once Shopify is connected,
 *                          and with NODE_ENV=production (at least 12 characters).
 *   VIEW_PASSWORD=...    → optional second password: sees everything, changes nothing (src/access.js, SW-029)
 *   PORT, DATA_DIR       → optional
 *   Shopify (read-only) → see src/keys.js: client ID + secret from Azure Key Vault, or SHOPIFY_STORE + SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET
 *
 * Several stores (ADR-0015): src/stores.js lists them; every /api route and /ingest takes ?store=<id> (default: the
 * sw_store cookie, else the first store) and runs inside scope.run(id), so each store reads and writes only its own
 * folder, DATA_DIR/stores/<id>/. Passwords and sign-in are for every store; pulls run one store at a time.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const catalog = require('./src/catalog');
const groups = require('./src/groups');
const store = require('./src/store');
const engine = require('./src/engine');
const rows = require('./src/rows');
const demo = require('./src/demo');
const keys = require('./src/keys');
const alert = require('./src/alert');
const shopify = require('./src/shopify');
const backup = require('./src/backup');
const onorder = require('./src/onorder');
const access = require('./src/access');
const audit = require('./src/audit');
const runs = require('./src/runs');
const helpers = require('./src/helpers');   // why / order-by, PO CSV, Pause/Push, Decide (LOGIC.md §15)
const decide = require('./src/decide');
const suppliers = require('./src/suppliers');   // SW-040: supplier table + SKU map (suppliers.json)
const supplierRules = require('./src/supplier-rules');
const budget = require('./src/budget');   // SW-041: cash budget cut line
const period = require('./src/period');
const digests = require('./src/digest-service');
const scope = require('./src/scope');
const stores = require('./src/stores');
const migrate = require('./src/migrate');
const version = require('./src/version');   // app version + commit SHA (SW-056)
const TZ = require('./src/tz');             // the store's time zone (SW-049): every store-time day, hour and stamp
const log = require('./src/log');           // one-line JSON logs, tokens scrubbed (SW-054)
const lock = require('./src/lock');         // one app per data folder (SW-055)
const capacity = require('./src/capacity'); // size, rows and disk warnings (SW-055)
const sheetFetch = require('./src/sheet-fetch');   // Sheet sync: fenced redirects, size cap, timeout (SW-052)
const people = require('./src/people');   // per-store sign-ins made by the owner (SW-062, ADR-0016)
const history = require('./src/history');   // SW-063: past stock rebuilt from Shopify's change log
const weeks = require('./src/weeks');       // 1.3.0: weekly sales per variant (ShopifyQL) for confidence (LOGIC §4c)
const tokenScopes = require('./src/token-scopes');   // refuse our own apps' write scopes; note Performity's (SW-051)
const csvmap = require('./src/csvmap');     // import preview + column mapping, Shopify exports (SW-045)
const apiv1 = require('./src/apiv1');       // /api/v1: every /api route + summary and paginated rows (SW-050)
const weekly = require('./src/weekly');     // sprint 3 B-review: daily snapshots, this week vs last week (SW-043)
const targets = require('./src/targets');   // sprint 3 B-review: monthly targets on groups (SW-042)
const lists = require('./src/lists');       // sprint 3 B-review: saved product lists (SW-044)
const cache = require('./src/cache');       // 1.4.3: per-store answers in memory, keyed by the store's data version
const zlib = require('node:zlib');
const links = require('./src/links');       // 1.4.0: product image, Shopify admin and website links (LOGIC §19)
const year = require('./src/year');         // 1.4.0: 12 months of daily sales + stock from ShopifyQL (LOGIC §20)
const sell = require('./src/sell');         // 1.4.0: best sellers now, push / pause ads (LOGIC §23)
const truth = require('./src/truth'), screen = require('./src/screen'), ledger = require('./src/ledger');   // 2.0.0: RULE.md
const closed = require('./src/closed');     // 1.4.6: closed months keep the ₹ they closed with
const status = require('./src/status');     // 1.4.7: active / draft / archived, and when
const agency = require('./src/agency');     // 1.4.0: the brand report: best sellers out of stock, month by month (LOGIC §20–§22)

const PORT = /^\d+$/.test(process.env.PORT || '') ? Number(process.env.PORT) : 4400;   // PORT=0 picks a free port (tests)
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const PROD = process.env.NODE_ENV === 'production';
const MIN_PASSWORD = 12;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');   // same folder as src/store.js
const VIEW_PASSWORD = process.env.VIEW_PASSWORD || '';
const PASSWORDS = { admin: PASSWORD, view: VIEW_PASSWORD };
const PUBLIC = path.join(__dirname, 'public');
// How often to pull (minutes). Default 120: each pull asks Performity for a token, and the user
// wants few token calls (20 Nov 2026). Stock rows from a pull carry the pull's time, so after the first read a
// stock-out's start and end are each 0–2 h late (the change log only times the history before the first read,
// SW-063; LOGIC §1c, §2). The engine is told the interval (afterLastSale). SYNC_MINUTES env overrides (5..1440).
const SYNC_MIN = Math.min(1440, Math.max(5, Number(process.env.SYNC_MINUTES) || 120));
const SYNC_EVERY = SYNC_MIN * 60e3;
const STORE_COOKIE = 'sw_store';   // the store last chosen in the picker (public/stores.js); ?store= wins
const KEEP_DAYS = 120;   // same as src/store.js: older rows would be pruned on save, so they're reported as skipped
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

/* ---------- helpers ---------- */
/* 1.4.3: answers over 1 KB are gzipped when the browser accepts it (the 30-day report: 545 KB → 59 KB on Sammsara) */
const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
  let out = type.startsWith('application/json') ? JSON.stringify(body) : body;
  const gz = typeof out === 'string' && out.length > 1024 && /\bgzip\b/.test(String((res.req && res.req.headers['accept-encoding']) || ''));
  if (gz) out = zlib.gzipSync(out, { level: 6 });
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...(gz ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}), ...extra });
  res.end(out);
};
const fail = (res, code, message) => send(res, code, { ok: false, error: message });
const readBody = (req, limit = 25e6) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Upload too large'), { status: 413 })); req.removeAllListeners('data'); req.resume(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});
/* Constant-time compare: HMAC both sides with a per-process key, so neither the content nor the length leaks through timing. */
const CMP_KEY = crypto.randomBytes(32);
const mac = (x) => crypto.createHmac('sha256', CMP_KEY).update(String(x)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(mac(a), mac(b));
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
/** A JSON object body, else 400 (bad JSON, null, an array or a number are refused). */
function jsonObject(raw) {
  let b; try { b = JSON.parse(raw || '{}'); } catch { throw badRequest('The body must be JSON'); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw badRequest('The body must be a JSON object');
  return b;
}

/* ---------- login ----------
 * A sign-in page sets a signed cookie (works in every browser, including embedded ones that never
 * show a Basic-auth pop-up). Basic auth still works for scripts. One limiter covers both.
 * Session cookies are signed with a key made from a random secret in DATA_DIR/secret (mode 600)
 * plus a fingerprint of the password, so changing ADMIN_PASSWORD signs everyone out. */
const COOKIE = 'sw_session';
const SESSION_DAYS = 30;
function loadSecret() {
  const file = path.join(DATA_DIR, 'secret');
  try { const v = fs.readFileSync(file, 'utf8').trim(); if (v.length >= 32) { try { fs.chmodSync(file, 0o600); } catch { /* read-only volume: still usable */ } return v; } }
  catch (e) { if (e.code !== 'ENOENT') console.warn('session secret unreadable, making a new one:', e.code || e.message); }
  const v = crypto.randomBytes(32).toString('hex');
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(file, v + '\n', { mode: 0o600 }); }
  catch (e) { console.warn('session secret not saved (sign-ins end on restart):', e.code || e.message); }
  return v;
}
let sessionKey = null;
const keyOf = () => sessionKey || (sessionKey = crypto.createHmac('sha256', loadSecret()).update('password|' + crypto.createHash('sha256').update(PASSWORD).digest('hex')).digest());
const sign = (exp) => crypto.createHmac('sha256', keyOf()).update('session|' + exp).digest('base64url');
const cookieOf = (req, name) => { const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`)); return m ? m[1] : ''; };
const personRole = (p) => (p.role === 'admin' ? access.ADMIN : access.VIEW);   // SW-062: a person's sign-in sets req.person
const personSession = (req) => { const p = people.fromCookie(cookieOf(req, COOKIE), sign, safeEqual); if (!p) return null; req.person = p; return personRole(p); };
const sessionRole = (req) => access.cookieRole(cookieOf(req, COOKIE), sign, safeEqual, { view: VIEW_PASSWORD }) || personSession(req);
/** Who made a change, for the settings log: the role (a person: their name), plus "script" when it came with Basic auth. */
const whoOf = (req, role) => { const who = req.person ? req.person.name : role; return req.headers.authorization && !sessionRole(req) ? `${who} (script)` : who; };
const secure = (req) => req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
/** Client IP: the last X-Forwarded-For hop (added by Railway's proxy; earlier hops are whatever the client sent), else the socket. */
const ipOf = (req) => { const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean); return hops.length ? hops[hops.length - 1] : String(req.socket.remoteAddress || ''); };

/* Wrong-password limiter for the sign-in form and Basic auth: 10 per IP per 15 minutes, 100 across all IPs.
 * blocked() → 'ip' (this IP: refused without checking), 'global' (100 across all IPs: the password is still
 * checked, so a stranger's flood can't lock out the owner; a wrong one gets 429), or false. */
const LIMIT = { window: 15 * 60e3, perIp: 10, global: 100, maxIps: 10000 };
const fails = new Map();   // ip → { n, until }
let globalFails = [];      // times of the latest wrong passwords (at most LIMIT.global)
let lastSweep = 0;
const limiter = {
  blocked(ip, now = Date.now()) {
    if (now - lastSweep > 60e3) { lastSweep = now; for (const [k, f] of fails) if (now >= f.until) fails.delete(k); }
    globalFails = globalFails.filter((t) => now - t < LIMIT.window);
    const f = fails.get(ip);
    if (f && f.n >= LIMIT.perIp && now < f.until) return 'ip';
    return globalFails.length >= LIMIT.global ? 'global' : false;
  },
  fail(ip, now = Date.now()) {
    const f = fails.get(ip); const n = (f && now < f.until ? f.n : 0) + 1;
    fails.delete(ip); fails.set(ip, { n, until: now + LIMIT.window });
    while (fails.size > LIMIT.maxIps) fails.delete(fails.keys().next().value);   // oldest first
    globalFails.push(now); if (globalFails.length > LIMIT.global) globalFails.shift();
  },
  ok(ip) { fails.delete(ip); },
};
/** 'admin' | 'view' (signed in, SW-029) | 'none' (no credentials) | 'bad' (wrong password) | 'limited' (too many wrong tries). */
function auth(req) {
  if (!PASSWORD) return access.ADMIN;
  const r = sessionRole(req); if (r) return r;
  const m = String(req.headers.authorization || '').match(/^Basic\s+(\S+)$/i);
  if (!m) return 'none';
  const ip = ipOf(req);
  const block = limiter.blocked(ip);
  if (block === 'ip') return 'limited';
  const raw = Buffer.from(m[1], 'base64').toString('utf8'); const i = raw.indexOf(':');
  const pass = i >= 0 ? raw.slice(i + 1) : '';   // everything after the first ":" (passwords may contain ":")
  const role = access.roleForPassword(pass, PASSWORDS, safeEqual);
  if (role) { limiter.ok(ip); return role; }
  const person = people.find(pass);   // SW-062
  if (person) { limiter.ok(ip); req.person = person; return personRole(person); }
  limiter.fail(ip); return block ? 'limited' : 'bad';
}
const TOO_MANY = 'Too many wrong passwords. Wait 15 minutes.';
const signedIn = (a) => a === access.ADMIN || a === access.VIEW;
function loginPage(error = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Stock-out Watch</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap">
<style>
:root{--paper:#EEF3F8;--card:#FFFFFF;--ink:#0E1626;--soft:#5B6478;--line:#DDE3EC;--brand:#0978BE;--lost:#E0506E}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--paper);color:var(--ink);font:14px/1.5 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:16px}
form{background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:0 18px 40px -22px rgba(14,22,38,.28);padding:28px;width:100%;max-width:360px;display:grid;gap:14px}
.b{display:flex;align-items:center;gap:10px;font-weight:700;font-size:16px}h1{margin:0;font-size:22px;font-weight:600;letter-spacing:-.02em}
label{font-size:13px;font-weight:600;color:var(--soft)}input{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink)}input:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px #E9F4FB}
button{font:inherit;font-weight:700;padding:11px;border:0;border-radius:8px;background:var(--brand);color:#fff;cursor:pointer}.e{color:var(--lost);font-size:14px;margin:0}
@media(max-width:760px){input,button{font-size:16px;min-height:44px}}
</style></head><body><form method="post" action="/login">
<div class="b"><img src="/favicon.svg" alt="" width="28" height="28">Stock-out Watch</div><h1>Sign in</h1>
${error ? `<p class="e" role="alert">${error}</p>` : ''}
<div><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" autofocus required></div>
<button type="submit">Sign in</button></form></body></html>`;
}
const publicSettings = (s, role = access.ADMIN) => access.visibleSettings(s, role);
/* The planning assumptions people can tweak. Same limits whether trying a value or saving it. */
const LIMITS = { paceMonths: [3, 12], bestShare: [50, 95], leadDays: [0, 180], coverDays: [1, 365], safetyDays: [0, 60], demandWindowDays: [7, 90], smallTopUpDays: [1, 60], minPerDay: [0, 100], tzOffsetMin: [-720, 840], allocationCheck: [0, 1] };   // allocationCheck (1.3.0, LOGIC §6): 1 on, 0 off
const PLAN_KEYS = ['leadDays', 'coverDays', 'safetyDays'];   // the three shown under Plan settings
const clampSetting = (k, v) => (v == null || String(v).trim() === '' || !Number.isFinite(+v) ? undefined : Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], +v)));
/** Saved settings, with any ?leadDays=… style trial values on top (not saved). */
function settingsFor(url, saved) {
  const out = access.visibleSettings(saved, access.VIEW);   // reports echo these back; they never need the Flow key, for any role (SW-029)
  for (const k of Object.keys(LIMITS)) { const v = clampSetting(k, url.searchParams.get(k)); if (v !== undefined) out[k] = v; }
  if (out.tzOffsetMin !== saved.tzOffsetMin) out.timeZone = TZ.fromOffset(out.tzOffsetMin);   // an old ?tzOffsetMin= trial
  const z = TZ.canonical(url.searchParams.get('timeZone')); if (z) out.timeZone = z;           // SW-049
  return out;
}

/* ---------- one data source per store (SW-006, ADR-0009) ----------
 * Once Shopify is connected it is the only source: Flow, Sheet and CSV rows use other keys and
 * would count the same sale twice. Clear and import also wait for a running pull. */
const ONE_SOURCE = 'Shopify is connected, so it is this store’s only data source. Flow, Sheet and CSV data are turned off so no sale is counted twice.';
const PULL_RUNNING = 'A Shopify pull is running. Try again in a minute.';

/* ---------- stores (ADR-0015): open each one once, then run its work inside scope.run ---------- */
const opened = new Map();   // store id → null (open) or the Error it failed with
/** Open a store once: its home store takes the old single-store files (src/migrate.js, once per DATA_DIR), a pending restore.json is
 *  applied (src/backup.js), then store.json and the side files load. Throws (and keeps throwing) when they can't. */
function openStore(id) {
  if (opened.has(id)) { const e = opened.get(id); if (e) throw e; return; }
  try {
    scope.run(id, () => {
      if (stores.home()?.id === id) migrate.run(scope.root(), id);
      backup.prepare();
      store.load(); onorder.all(); decide.all(); suppliers.all();
    });
    opened.set(id, null);
  } catch (e) { opened.set(id, e); throw e; }
}
/** fn() for one store, inside its scope. */
function inStore(id, fn) { openStore(id); return scope.run(id, fn); }
/** fn() for every store, one after the other (Performity's and Shopify's limits are per IP / per app). Never throws. */
async function eachStore(fn) {
  for (const s of stores.list()) {
    try { await inStore(s.id, fn); } catch (e) { console.warn(`store ${s.id}:`, e.message); }
  }
}
const isDemoName = (n) => !n || n === 'Demo Store' || /\(demo\)$/.test(n);
/** What people call the current store: the name set on Data & settings, else the registry's (brand name, handle, demo label). */
function storeName(id = scope.id()) {
  const nm = store.load().settings.storeName, e = stores.get(id);
  if (e && e.demo) return nm && !isDemoName(nm) ? nm : e.name;
  return nm && !isDemoName(nm) ? nm : (e ? e.name : id);
}

/** engine options from lossPaceOf: { lossPace, lossPrice } (none without the 12 months) */
const lossOpts = (m) => (m ? { lossPace: m.pace, lossPrice: m.price, weeksOpen: m.weeksOpen } : {});
/** 1.4.4: the parts of §4c per variant from a report, for the brand report (same rule on every page) */
const rowInfoOf = (rows) => Object.fromEntries((rows || []).map((x) => [String(x.id), { confidence: x.confidence, nrDays: x.nrDays, ordered: !!x.onOrder, allocation: !!x.allocation }]));
/** 1.4.0 (LOGIC §21): { variantId → units a day this month } from Shopify's 12 months (brand report pace × season), for
 *  ₹ lost of long stock-outs; cached per store until the year is read again or the pace setting changes. */
/** 1.4.3: what the brand report is built from: Shopify's 12 months (year.json) when read, else the rows held; the catalog
 *  (or, without Shopify, names and product IDs from the rows). Cached per store version. */
function brandInputs(d) {
  return cache.memo('brandInputs', '', 10 * 60e3, () => {
    const y = year.load(), zone = TZ.zoneOf(d.settings);
    const shopY = y && y.anchor && y.sales && y.sales.from ? y : null;
    const src = shopY || agency.fromRows(d.stock, d.orders, { dayOf: (t) => TZ.dayKey(t, zone) });
    let cat = d.catalog || {};
    if (!Object.keys(cat).length) {   // demo, Flow, Sheet, CSV: names and product IDs from the rows and the group catalog
      const gc = catalog.current(d.source, d.catalog).variants || {}; cat = Object.create(null);   // variant IDs are data: never Object.prototype keys
      for (const r of d.stock) { const id = String(r.variantId); cat[id] = { productId: (gc[id] && gc[id].productId) || id, product: r.product, variant: r.variant, sku: r.sku, price: r.price, active: true, tracked: true }; }
    }
    return { y: src, cat, basis: shopY ? 'shopify' : 'rows' };
  });
}
/** 1.5.0: (variantId, dayKey) → the stock at the end of that store day from our own readings (pulled rows, not rebuilt ones),
 *  or null when it isn't certain: no reading before that midnight, or a change seen in the pull window after it. */
function knownEndOf(d) {
  const zone = TZ.zoneOf(d.settings), by = new Map();
  for (const r of d.stock || []) { if (r.src === 'rebuilt' || r.now == null) continue; const id = String(r.variantId); if (!by.has(id)) by.set(id, []); by.get(id).push(r); }
  for (const l of by.values()) l.sort((x, y) => x.t - y.t);
  const mid = new Map(), after = SYNC_EVERY + 45 * 60e3;
  return (id, through) => {
    const l = by.get(String(id)); if (!l) return null;
    for (let n = 0, day = through; n < 10; n++, day = agency.keyPlus(day, -1)) {   // the latest day that is certain
      if (!mid.has(day)) mid.set(day, TZ.fromLocal(Date.parse(`${agency.keyPlus(day, 1)}T00:00:00Z`), zone));
      const t = mid.get(day); let last = null, sure = true;
      for (const r of l) { if (r.t < t) last = r; else { sure = r.t >= t + after; break; } }
      if (!last) return null;
      if (sure) return { day, level: Number(last.now) };
    }
    return null;
  };
}
/** The brand report's options on the saved settings (links added by the caller that sends products). */
function brandOptsOf(d, extra = {}) {
  const S = { ...engine.DEFAULT_SETTINGS, ...d.settings }, zone = TZ.zoneOf(d.settings), w = weeks.forReport(d.shopify);
  return { paceMonths: Math.round(+S.paceMonths || 6), bestShare: (+S.bestShare || 80) / 100, offOf: (c) => status.offSpells(status.of(c)), ...(d.source === 'live' ? { knownEnd: knownEndOf(d) } : {}), firstSeenDay: d.shopify && d.shopify.history && +d.shopify.history.until ? TZ.dayKey(+d.shopify.history.until, zone) : null, dayOf: (t) => TZ.dayKey(t, zone),
    rankBy: w ? Object.fromEntries(Object.entries(w.by).map(([k, v]) => [k, v.n])) : null, ...extra };   // 26 weeks, while the 12 months load
}
/** 1.4.3: the whole store's 12-month build with every variant's days (the drawer, ₹ lost pace), once per data version. */
function yearBuild(d) {
  const S = { ...engine.DEFAULT_SETTINGS, ...d.settings };
  return cache.memo('yearBuild', `${S.paceMonths}|${S.bestShare}|${TZ.zoneOf(d.settings)}`, 10 * 60e3, () => {
    const b = brandInputs(d);
    return { b, r: agency.build(b.y, b.cat, brandOptsOf(d, { detail: true })) };
  });
}
/* 2.0.0 (RULE.md): the one engine behind every number on the agency's screens. Months that are over are locked in ledger.json by the
   first report that can: only on Shopify's full record, never on demo or rows. on = this store is read from Shopify. */
function truthOf(d, shop = null) {
  const t = cache.memo('truth', '', 5 * 60e3, () => {
    const b = brandInputs(d), o = brandOptsOf(d), keep = b.basis === 'shopify' && !!(b.y && b.y.done);
    if (b.basis !== 'shopify') return { ok: false, on: false, basis: b.basis };
    const r = truth.report(b.y, b.cat, { dayOf: o.dayOf, firstSeenDay: o.firstSeenDay, offOf: o.offOf, knownEnd: o.knownEnd, now: Date.now(), ledger: keep ? ledger.get(truth.RULE) : null });
    if (r.ok && keep && r.lock && !readOnly()) { const n = ledger.add(truth.RULE, r.lock); if (n) console.log(`ledger: locked ${[...n.lists.map((k) => `list ${k}`), ...n.months].join(', ')} (rule ${truth.RULE})`); }
    delete r.lock;
    if (r.ok) status.annotate(r.rows, b.cat);
    return { ...r, basis: b.basis, on: true };
  });
  if (t.ok && shop && !t.linked) { links.annotate(t.rows, d.catalog, shop); t.linked = true; }
  return t;
}
/** A period report with its money from the one rule (Shopify stores only). */
function oneMoney(d, r, only = false) {
  const t = truthOf(d); if (!t.on || !r) return r;
  const dayOf = (x) => TZ.dayKey(x, TZ.zoneOf(d.settings));
  const end = t.ok ? t.span.to : dayOf(Date.now());
  return screen.period(r, t, { y: brandInputs(d).y, only, from: dayOf(r.from), to: r.toKey && r.toKey < end ? r.toKey : end });   // 4.1.0: a Custom period ends on its own last day
}
/** 1.4.4 (LOGIC §7a, §22): the one best-seller set: variant IDs of the brand report's best sellers (12 months, top 80%). */
function bestIdsOf(d) {
  const t = truthOf(d); if (t.on) return new Set(t.ok ? t.rows.filter((x) => x.best).map((x) => x.id) : []);   // 2.0.0: the quarter's list
  return cache.memo('bestIds', '', 10 * 60e3, () => { const r = yearBuild(d).r; const set = new Set(); if (r && r.ok) for (const p of r.products) if (p.best) for (const id of p.ids || [p.variantId]) set.add(String(id)); return set; });
}
function lossPaceOf(dir, d) {   // dir: kept for the callers; the cache is per store (src/cache.js)
  const y = year.load();
  if (!y || !y.anchor || !y.sales || !y.sales.from) return null;
  return cache.memo('lossPace', '', 10 * 60e3, () => { const r = yearBuild(d).r; return { ...lossMap(r), weeksOpen: agency.weeksOpen(r, weeks.forReport(d.shopify), (t) => TZ.dayKey(t, TZ.zoneOf(d.settings))) }; });
}
function lossMap(r) {
  /* 1.4.3: { pace: { variantId: { 'YYYY-MM': units a day, _: this month } }, price: { variantId: ₹ ex GST } } for every variant
     the year holds (pace 0 included: a product that sold nothing in a year misses nothing) */
  const pace = {}, price = {};
  for (const p of r.products || []) {
    const none = new Set(p.noPace || []);   // 1.4.6
    for (const [v, x] of Object.entries(p.monthPace || {})) if (!none.has(v)) pace[v] = x;
    for (const [v, x] of Object.entries(p.variantPrice || {})) if (x && x._ > 0 && !none.has(v)) price[v] = x;   // 2.0.0: { 'YYYY-MM': price, _: price }
  }
  return { pace, price };
}

weekly.useLossPace((d) => ({ ...lossOpts(lossPaceOf(scope.dir(), d)), bestIds: bestIdsOf(d) }), () => { const y = year.load(); return y && y.anchor ? 'y1' : ''; });   // snapshots use the same ₹ lost; retaken once the 12 months arrive

/** SW-040: each variant's supplier and terms for the current store (src/supplier-rules.js resolve). */
const supplierOf = (d) => supplierRules.resolve(d.stock, d.catalog, suppliers.all());

/* ---------- Google Sheet sync (published CSV links of the Stock log / Order log tabs) ---------- */
async function syncSheet() {
  const s = store.load().settings;
  if (!s.sheetStockCsv && !s.sheetOrderCsv) return { skipped: true };
  if (keys.status().source) return { skipped: true, reason: ONE_SOURCE };   // Shopify is the only source (SW-006)
  const out = { stock: 0, orders: 0 };
  const run = runs.begin('sheet');   // run history (SW-030)
  try {
    for (const [kind, url] of [['stock', s.sheetStockCsv], ['order', s.sheetOrderCsv]]) {
      if (!url) continue;
      let text;   // SW-052: docs.google.com only, ≤ 3 redirects to Google hosts, ≤ 20 MB, 20 s (src/sheet-fetch.js)
      try { text = await sheetFetch.sheetText(url); } catch (e) { throw new Error(`${kind} sheet: ${e.message}`); }
      let parsed;
      try { parsed = rows.fromCsv(text, kind === 'stock' ? 'stock' : 'order', { timeZone: TZ.zoneOf(s), keepDays: KEEP_DAYS }); }
      catch (e) { throw new Error(`${kind} sheet: ${e.message}`); }
      if (kind === 'stock') out.stock = store.add('stock', parsed.rows, 'sheet'); else out.orders = store.add('orders', parsed.rows, 'sheet');
    }
    Object.assign(run, { stock: out.stock, lines: out.orders }); runs.finish(store.load(), run);
    store.setSync({ lastSync: Date.now(), lastSyncError: null });
    return out;
  } catch (e) {
    Object.assign(run, { stock: out.stock, lines: out.orders }); runs.finish(store.load(), run, e.message);
    store.setSync({ lastSync: Date.now(), lastSyncError: e.message });
    throw e;
  }
}

/* ---------- demo data (Sammsara's public catalog, invented stock and sales); each demo store has its own mix ---------- */
function loadDemo() {
  const own = demo.STORES.find((x) => x.id === scope.id()) || demo.STORES[0];
  const g = demo.generate({ now: Date.now(), ...own.opts });
  store.replaceAll(g.stock, g.orders, 'demo');
  try { suppliers.seedDemo(demo.SUPPLIERS); } catch (e) { console.warn('demo suppliers not saved:', e.message); }   // SW-040: demo terms, only when the store has none (a read-only volume must not stop start-up)
  decide.clear();   // SW-032: decisions belong to the data they were made on
  weekly.clear(); setImmediate(() => weekly.catchUp());   // SW-043: so are the daily snapshots; the demo's are taken now, in the background
  const s = store.load().settings;
  store.setSettings({ demoVersion: demo.VERSION, ...(isDemoName(s.storeName) ? { storeName: own.name } : {}) });
  return g;
}

/* ---------- Shopify, read-only pull (stock every 2 hours by default, SYNC_MINUTES; new orders since the last pull) ----------
 * One pull at a time across all stores (one queue): Performity allows 30 calls/min per IP and the Shopify app's
 * rate limit is shared. A store already queued or pulling returns the same promise. */
const pulls = new Map();      // store id → its queued or running pull
const progress = new Map();   // store id → live counts of its running pull (SW-030)
let pullQueue = Promise.resolve();
function shopifyStatus(id = scope.id()) {
  const k = keys.status(id); const st = store.load().shopify;
  return { source: k.source, store: k.store, secretName: k.secretName || null, kind: k.kind || null, ready: k.ready, missing: k.missing,
    lastSync: st.lastSync, lastError: st.lastError, lastTry: st.lastTry, running: pulls.has(id), progress: runs.progress(progress.get(id) || null),
    backfilled: !!st.ordersCursor, scopes: shopify.SCOPES, apiVersion: shopify.API_VERSION, writeScopes: st.writeScopes || [], history: st.history || null, priceBasis: st.priceBasis || null, orderFields: st.orderFields || null,
    weekSales: st.weekSales ? (({ by: _by, ...w }) => w)(st.weekSales) : null, year: year.summary(year.load()) };   // 1.3.0: summary only, not the per-variant table
}
/** Pull one store from Shopify (default: the current store). Queued behind any other store's pull. */
function syncShopify(id = scope.id()) {
  if (!keys.status().source) return Promise.resolve({ skipped: true });
  if (pulls.has(id)) return pulls.get(id);
  const p = pullQueue.then(() => inStore(id, () => pullOne(id)));
  pullQueue = p.catch(() => {});
  const tracked = p.finally(() => { pulls.delete(id); });
  pulls.set(id, tracked);
  return tracked;
}
async function pullOne(id) {
  keys.beginPull(id);                                 // Performity POC API: fresh token before each pull
  const started = Date.now();
  const run = runs.begin('shopify', started);
  progress.set(id, run);
  try {
    store.endDemo();   // never mix demo with live data: rows, Mark ordered and decisions go (SW-007)
    if (store.load().settings.storeName && isDemoName(store.load().settings.storeName)) store.setSettings({ storeName: '' });   // the registry's name shows instead
    const sc = await tokenScopes.check(keys.status(id).source, id);   // SW-051: own app with write_* → refused; Performity → noted
    store.setShopify({ writeScopes: sc.write });
    const s = await shopify.pullStock(store.load().shopify.lastQty);
    stores.noteShop(id, keys.status(id).store);
    const stock = store.add('stock', s.rows, 'shopify');
    store.setCatalog(s.catalog, started);   // current stock + attributes, replaced whole (SW-002)
    if (s.shop) store.setShopify({ shopInfo: s.shop });   // 1.4.0: shop domain + website address for product links
    Object.assign(run, { stock, phase: 'orders', notes: runs.stockNotes(s.excluded) });
    store.setShopify({ lastQty: s.lastQty });
    let orders = 0;
    /* 1.1.1: order prices became ex tax (LOGIC §5); SW-064 / 1.1.3: lines keep `ordered` and their refunds (returns, LOGIC §9e).
       Orders read before any of these are read again once, from the 60-day backfill */
    const sh = store.load().shopify;
    /* 1.1.5: reversal events with their own dates (LOGIC §9e); the re-read starts them afresh */
    if (sh.priceBasis !== shopify.PRICE_BASIS || sh.orderFields !== shopify.ORDER_FIELDS) {
      if (sh.orderFields !== shopify.ORDER_FIELDS) store.load().reversals = [];
      store.setShopify({ ordersCursor: null, priceBasis: shopify.PRICE_BASIS, orderFields: shopify.ORDER_FIELDS });
    }
    await shopify.pullOrders(store.load().shopify.ordersCursor, {
      onPage: (names, rows, cursor, rv) => {
        const n = store.replaceOrders(names, rows, 'shopify').added; orders += n; run.orders += names.length; run.lines += n;
        if (rv) store.replaceReversals(rv.orders, rv.events);
        if (cursor) store.setShopify({ ordersCursor: cursor });
      },
    });
    runs.finish(store.load(), run);
    store.setShopify({ lastSync: Date.now(), lastTry: started, lastError: null });
    if (history.due(store.load().shopify)) await history.run().catch((e) => console.warn('history:', e.message));   // SW-063: once per store and rules version (1.1.1 redoes 1.1.0's), never fails the pull
    if (weeks.due(store.load().shopify, Date.now(), TZ.zoneOf(store.load().settings))) await weeks.run().catch((e) => console.warn('weeks:', e.message));   // 1.3.0: once a day per store, after the pull is saved; never fails it
    if (status.due()) await status.run();   // 1.4.7: once a day, never fails the pull
    if (year.due(year.load(), Date.now(), TZ.zoneOf(store.load().settings))) await year.run().catch((e) => console.warn('year:', e.message));   // 1.4.0: 12 months (LOGIC §20), a few reads per pull until done, then once a day; never fails the pull
    await catalog.refreshCollections().catch((e) => console.warn('collections:', e.message));   // Group by (SW-022): once a day, resumable
    log.info('shopify pull done', { store: id, stockChanges: stock, orderLines: orders, seconds: Math.round((Date.now() - started) / 1000) });
    alert.syncResult(true, '', { store: storeName(id), key: id }).catch(() => {});
    weekly.catchUp();   // SW-043: the day's snapshot once the pull reaches past store-midnight (in the background; never throws)
    setImmediate(() => { try { inStore(id, () => { const d2 = store.load(); yearBuild(d2); lossPaceOf(scope.dir(), d2); }); } catch (e) { console.warn('warm:', e.message); } });   // 1.4.3: the 12-month build ready before the first drawer opens
    return { stock, orders };
  } catch (e) {
    runs.finish(store.load(), run, e.message);
    store.setShopify({ lastTry: started, lastError: e.message });
    alert.syncResult(false, e.message, { store: storeName(id), key: id }).catch(() => {});
    throw e;
  } finally { progress.delete(id); }
}

/** 1.4.0: Data → Read 12 months now (admin). Queued like a pull; a bigger budget than the read after a pull. */
function readYear(id) {
  /* a pull first, so the stock the walk starts from is minutes old (LOGIC §20), then up to 60 reads */
  return syncShopify(id).catch((e) => console.warn('year: pull before the read failed:', e.message)).then(() => {
    const p = pullQueue.then(() => inStore(id, () => year.run({ maxCalls: 60, maxMs: 20 * 60e3 })));
    pullQueue = p.catch(() => {});
    return p;
  });
}

/** SW-063: Data → Rebuild stock history. Queued like a pull, so it never runs beside one. */
function rebuildHistory(id) {
  const p = pullQueue.then(() => inStore(id, () => history.run()));
  pullQueue = p.catch(() => {});
  return p;
}

/** The pull loop (every SYNC_MIN, 2 hours by default): brand list, then each store's sheet sync and Shopify pull, one store at a time. */
let pullingAll = null;
function pullAll() {
  if (pullingAll) return pullingAll;
  pullingAll = (async () => {
    await stores.refresh();
    for (const s of stores.list()) {
      try { await inStore(s.id, () => syncSheet()); } catch (e) { console.warn(`sheet sync (${s.id}):`, e.message); }
      if (keys.status().source) { try { await syncShopify(s.id); } catch (e) { console.warn(`shopify pull failed (${s.id}):`, e.message); } }
    }
  })().finally(() => { pullingAll = null; });
  return pullingAll;
}

/* ---------- freshness (SW-019): is the Shopify data recent? ---------- */
const STALE_MIN = Math.max(45, SYNC_MIN * 2 + 15);   // two missed pulls (+15 min slack)
const BOOT_AT = Date.now();
/** The current store's: age of its last good Shopify pull. Stale when it is more than STALE_MIN old (or none that long after start; 255 min at the default 2-hour pull). Off without Shopify. */
function freshness(now = Date.now()) {
  if (!keys.status().source) return { shopify: false, lastPull: null, ageMin: null, stale: false, staleAfterMin: STALE_MIN };
  const st = store.load().shopify; const ref = st.lastSync || BOOT_AT;
  return { shopify: true, lastPull: st.lastSync, ageMin: st.lastSync ? Math.floor((now - st.lastSync) / 60e3) : null,
    stale: now - ref > STALE_MIN * 60e3, staleAfterMin: STALE_MIN, running: pulls.has(scope.id()), pullFailing: !!st.lastError };
}
/** The current store's state for the picker dot: 'error' (last pull or sync failed), 'stale' (data too old), else 'ok'. */
function storeState() {
  const d = store.load(), f = freshness(), err = d.shopify.lastError || d.lastSyncError || null;
  return { lastSync: d.shopify.lastSync || d.lastSync || null, lastError: err, stale: f.stale, running: pulls.has(scope.id()), source: d.source, state: err ? 'error' : f.stale ? 'stale' : 'ok' };
}
/** GET /api/stores: every store with its name and status (a store that can't be opened shows as an error). */
function storeList(only = () => true) {
  return stores.list().filter((s) => only(s.id)).map((s) => {
    let status;
    try { status = inStore(s.id, storeState); } catch (e) { status = { lastSync: null, lastError: e.message, stale: false, running: false, source: null, state: 'error' }; }
    let name = s.name; try { name = inStore(s.id, () => storeName(s.id)); } catch { /* keep the registry's */ }
    return { id: s.id, name, demo: !!s.demo, shop: s.shop || null, status };
  });
}
/** Unauthenticated /status for uptime monitors: 503 when any store's data is stale or saving fails. Totals over every
 *  store; no names, ids, keys or error text. */
function statusBody() {
  const app = version.current();
  const out = { ok: true, version: app.version, sha: app.short, stale: false, ageMin: null, lastPull: null, shopify: !!keys.status().source, running: pulls.size > 0, pullFailing: false,
    saveOk: true, source: null, storeBytes: 0, stockRows: 0, orderRows: 0, variants: 0, stores: 0, uptimeMin: Math.floor((Date.now() - BOOT_AT) / 60e3) };
  const sources = new Set(), warn = [];
  for (const s of stores.list()) {
    out.stores++;
    try {
      inStore(s.id, () => {
        const h = store.health(), f = freshness(), d = store.load();
        if (!h.ok) out.saveOk = false;
        if (f.stale) out.stale = true;
        if (f.pullFailing) out.pullFailing = true;
        if (f.ageMin != null) out.ageMin = Math.max(out.ageMin ?? 0, f.ageMin);
        if (f.lastPull) out.lastPull = out.lastPull == null ? f.lastPull : Math.min(out.lastPull, f.lastPull);   // the oldest store's
        let bytes = 0; try { bytes = fs.statSync(store.file()).size; } catch { /* not written yet */ }
        out.storeBytes += bytes;
        out.stockRows += d.stock.length; out.orderRows += d.orders.length; out.variants += Object.keys(d.catalog || {}).length;
        for (const w of capacity.warnings({ storeBytes: bytes, rows: d.stock.length + d.orders.length })) if (!warn.some((x) => x.code === w.code)) warn.push(w);
        sources.add(d.source);
      });
    } catch { out.saveOk = false; }
  }
  out.source = sources.size === 1 ? [...sources][0] : sources.size ? 'mixed' : null;
  out.warnings = [...warn, ...capacity.warnings({ disk: capacity.diskUsed(DATA_DIR) })];   // SW-055: early notice, never fails the check
  out.writing = !readOnly();   // false: another copy holds the data folder (SW-055)
  out.ok = out.saveOk && !out.stale && out.stores > 0;
  return { code: out.ok ? 200 : 503, body: out };
}
/** /health: every store opened so far loaded, and its last save worked. */
function healthBody() {
  const h = store.healthAll();
  const problems = [...h.problems];
  for (const [id, e] of opened) if (e && !problems.includes(e.message)) problems.push(`store ${id}: ${e.message}`);
  const app = version.current(), v = { version: app.version, sha: app.short };
  return problems.length ? { code: 503, body: { ok: false, error: problems.join('; '), ...v } } : { code: 200, body: { ok: true, ...v } };
}

/* ---------- morning digest (SW-028): the report as of `now`, with yesterday; a fresh pull before sending ---------- */
const digestCtx = {
  report({ days, now }) {
    const d = store.load(), rowsAt = period.asOf(d.stock, d.orders, now);
    /* today's digest: the same options as /api/report (catalog snapshot, Mark ordered); a past "7 days before" comparison
       uses the rows as they stood then, plus only the catalog's inactive flags from before then (today's stock and price
       would be wrong for a past date; without the flags an archived-while-out variant never ends its stock-out, §17) */
    const base = { suppliers: supplierOf(d), reversals: d.reversals, weekSales: weeks.forReport(d.shopify), syncMinutes: SYNC_MIN, ...lossOpts(lossPaceOf(scope.dir(), d)), bestIds: bestIdsOf(d) };
    const live = Math.abs(Date.now() - now) < 36e5 ? { ...base, catalog: d.catalog, onOrder: onorder.all() }
      : { ...base, catalog: period.catalogAsOf(d.catalog, now), onOrder: onorder.asOf(now) };   // L7 (1.3.0): Mark ordered as it stood then, as weekly.compute does
    const { period: _kind, ...span } = period.range(days, now, TZ.zoneOf(d.settings));   // calendar days, as on the page (1.1.5)
    const r = helpers.enrich(engine.report(rowsAt.stock, rowsAt.orders, d.settings, { ...span, now, ...live }));   // still-out ₹/day, Pause list: the page's numbers (§15)
    r.yesterday = period.yesterdayFor(rowsAt.stock, rowsAt.orders, d.settings, r, live);
    return r;
  },
  async pull() { await syncSheet().catch((e) => console.warn('sheet sync:', e.message)); if (keys.status().source) await syncShopify(scope.id()); await weekly.catchUp(); },
  storeName: () => storeName(),
  storeId: () => scope.id(),
  review: () => { try { return weekly.digestLine(weekly.current()); } catch { return null; } },   // SW-043: one line, this week vs last week
};

/* ---------- API ---------- */
const SETTINGS_LIMIT = 64 * 1024;   // settings bodies are tiny; anything bigger is refused (413)
const MAX_INGEST_ROWS = 500;   // Flow sends one change per request; a leaked key can't flood the store
let keyInUrlWarned = 0;
async function api(req, res, url) {
  const p = url.pathname;
  const asked = url.searchParams.get('store');

  /* Shopify Flow → "Send HTTP request" (no login; protected by the store's X-Ingest-Key header). Flow sends no cookie:
     the store is ?store=<id>, else the first store. */
  const ingest = p.match(/^\/ingest\/(stock|order)$/);
  if (ingest && req.method === 'POST') {
    const pk = stores.pick(asked, '');
    if (pk.error) return fail(res, pk.error, pk.message);
    res.swStore = pk.id;   // for the request log line (SW-054)
    return inStore(pk.id, () => ingestRoute(req, res, url, ingest[1]));
  }

  const a = auth(req);
  if (a === 'limited') return send(res, 429, { ok: false, error: TOO_MANY }, undefined, { 'retry-after': '900' });
  if (!signedIn(a)) return send(res, 401, { ok: false, error: 'Login needed' });
  const role = a;
  if (stores.mode() === 'tokenapi' && !stores.list().length) await stores.refresh();   // first request before the first brand list
  const person = req.person || null;   // SW-062: a person sees only their stores; the owner and VIEW_PASSWORD see every store
  if (p === '/api/people' || p.startsWith('/api/people/')) {
    const r = await people.handle(req, p, readBody, { owner: role === access.ADMIN && !person, signIn: !!PASSWORD, stores: () => storeList().map((s) => ({ id: s.id, name: s.name })) });
    return send(res, r.code, r.body);
  }
  if (p === '/api/stores' && req.method === 'GET') {
    const pk = people.pick(stores, asked, cookieOf(req, STORE_COOKIE), person);
    return send(res, 200, { ok: true, stores: storeList((sid) => people.allows(person, sid)), current: pk.id || null, registry: stores.info() });
  }
  const pk = people.pick(stores, asked, cookieOf(req, STORE_COOKIE), person);
  if (pk.error) return fail(res, pk.error, pk.message);
  res.swStore = pk.id;
  return inStore(pk.id, () => storeApi(req, res, url, role, pk.id));
}

async function ingestRoute(req, res, url, kind) {
  const d = store.load();
  let key = req.headers['x-ingest-key'];
  if (!key && url.searchParams.has('key')) {   // old URLs: still accepted, but the key ends up in proxy and Flow logs
    key = url.searchParams.get('key');
    if (Date.now() - keyInUrlWarned > 3600e3) { keyInUrlWarned = Date.now(); console.warn('ingest: key in the URL (?key=) is deprecated, send the X-Ingest-Key header instead'); }
  }
  if (!key || !safeEqual(key, d.settings.ingestKey)) return fail(res, 401, 'Wrong or missing ingest key');
  if (keys.status().source) return fail(res, 409, ONE_SOURCE);
  const raw = await readBody(req, 2e6);
  let body = raw; try { body = JSON.parse(raw); } catch { /* a plain comma-separated line */ }
  if (Array.isArray(body) && body.length > MAX_INGEST_ROWS) return fail(res, 413, `At most ${MAX_INGEST_ROWS} rows per request`);
  const list = (Array.isArray(body) ? body : [body]).flatMap((b) => rows.fromWebhook(b, kind, { timeZone: TZ.zoneOf(d.settings) }));
  if (list.length > MAX_INGEST_ROWS) return fail(res, 413, `At most ${MAX_INGEST_ROWS} rows per request`);
  const n = store.add(kind === 'stock' ? 'stock' : 'orders', list, 'flow');
  return send(res, 200, { ok: true, received: list.length, added: n });
}

/** Every logged-in /api route, for one store (the current scope). */
async function storeApi(req, res, url, role, id) {
  const p = url.pathname;
  let d = store.load();
  const { period: periodKind, ...span } = period.range(url.searchParams.get('days'), Date.now(), TZ.zoneOf(d.settings));
  if (periodKind === 'custom' && req.method === 'GET' && span.now < Date.now() - 6e4) { const cut = period.asOf(d.stock, d.orders, span.now); d = { ...d, stock: cut.stock, orders: cut.orders }; }   // 4.1.0: a Custom period that ends in the past sees only what was known then   // { days } or { from } ("This month")
  const here = { id, name: storeName(id) };
  /* view-only (SW-029): one gate before every route, Sprint 1's included (Mark ordered, settings, import, backup) */
  if (access.refused(role, req.method, p)) return fail(res, 403, access.READ_ONLY);
  if (role !== access.ADMIN && p === '/api/export/backup.json') return fail(res, 403, access.READ_ONLY);   // the whole store: ingest key, change log
  if (backup.route(req, res, url)) return;   // GET /api/export/backup.json
  const oo = await onorder.handle(req, p, readBody, TZ.zoneOf(d.settings));   // "Mark ordered" (LOGIC.md §6b)
  if (oo) return send(res, oo.code, oo.body);
  const dg = await digests.handle(req, url, readBody, digestCtx, whoOf(req, role));   // settings changes go to the change log (SW-029)   // /api/digest… (SW-028); writes already refused above for view-only
  if (dg) return send(res, dg.code, dg.body, dg.type);

  /* SW-032: decisions are based on, and checked against, sales per day on the saved settings (never trial values) */
  /* Every report-shaped answer (report, groups, product, CSV) uses the same options, so their numbers agree. */
  const sups = supplierOf(d);   // SW-040: each variant's supplier and terms (lead time, MOQ, case pack)
  const shopLinks = () => ({ ...(d.shopify.shopInfo || {}), handle: keys.status(id).store || null });   // 1.4.0 (LOGIC §19)
  const lossPace = () => lossPaceOf(scope.dir(), d);   // 1.4.0 (LOGIC §21): seasonal pace for long stock-outs' ₹ lost
  const onlyBest = url.searchParams.get('best') === '1' && ['/api/report', '/api/groups', '/api/export/reorder.csv'].includes(p);   // 1.4.9: the Best sellers switch: the same report, best sellers only
  const reportOpts = (extra = {}) => ({ ...span, catalog: d.catalog, onOrder: onorder.all(), suppliers: sups, reversals: d.reversals, weekSales: weeks.forReport(d.shopify), syncMinutes: SYNC_MIN, ...lossOpts(lossPace()), bestIds: bestIdsOf(d), ...(onlyBest ? { only: bestIdsOf(d) } : {}), ...extra });   // span: { days } or { from } (SW-027)
  const savedRates = () => new Map(engine.report(d.stock, d.orders, d.settings, { days: 30, catalog: d.catalog, onOrder: onorder.all() }).products.map((x) => [String(x.id), x.perDay]));
  const dc = await decide.handle(req, p, readBody, (id) => savedRates().get(id));
  if (dc) return send(res, dc.code, dc.body);
  const v1 = apiv1.handle(req, url, () => {   // SW-050: /api/v1/summary, /api/v1/rows; the same report as /api/report
    const S = settingsFor(url, d.settings), trial = Object.keys(LIMITS).some((k) => S[k] !== d.settings[k]);
    const r = helpers.enrich(engine.report(d.stock, d.orders, S, reportOpts()), { decisions: decide.all(), rates: trial ? savedRates() : null });
    r.period = periodKind; if (span.to) r.toKey = span.to; r.yesterday = period.yesterdayFor(d.stock, d.orders, S, r, reportOpts()); return oneMoney(d, r);
  }, { store: here, freshness, source: d.source });
  if (v1) return send(res, v1.code, v1.body);
  const sp = await suppliers.handle(req, url, readBody, {   // SW-040: Data → Suppliers (writes: admin only, gated above)
    resolved: () => sups,
    products: () => engine.report(d.stock, d.orders, d.settings, reportOpts()).products.filter((x) => x.status !== 'Inactive').map((x) => ({ id: x.id, sku: x.sku, name: x.name })),
    log: (changes) => { if (changes.length) { audit.record(d, changes, whoOf(req, role)); store.save(true); } },
    fileName: (kind) => `${kind === 'map' ? 'supplier-map' : 'suppliers'}-${fileSlug(here.name)}${helpers.fileDate(Date.now(), TZ.zoneOf(d.settings))}.csv`,
  });
  if (sp) return send(res, sp.code, sp.body, sp.type, sp.headers);
  /* sprint 3 B-review: weekly review (SW-043), targets on groups (SW-042), saved lists (SW-044); month-to-date groups on the saved settings */
  const now = Date.now(), from = period.monthStart(now, TZ.zoneOf(d.settings));
  const monthGroups = (lens) => groups.build(engine.report(d.stock, d.orders, d.settings, { from, now, catalog: d.catalog, onOrder: onorder.all(), weekSales: weeks.forReport(d.shopify), syncMinutes: SYNC_MIN, ...lossOpts(lossPace()), bestIds: bestIdsOf(d) }).products, catalog.current(d.source, d.catalog), lens);
  for (const h of [weekly, targets, lists]) { const x = await h.handle(req, url, readBody, { role, by: whoOf(req, role), monthGroups, from, now, offMin: TZ.zoneOf(d.settings) }); if (x) return send(res, x.code, x.body); }
  /* 1.4.0: the brand report (LOGIC §20–§22). Shopify's 12 months when read (year.json), else the rows we hold. */
  const dayOf = (t) => TZ.dayKey(t, TZ.zoneOf(d.settings));
  const brandData = () => brandInputs(d);
  const brandOpts = () => brandOptsOf(d, { links: (c) => links.of(c, shopLinks()) });
  /* 1.4.3: the report for a period and trial settings, cached per store version for a minute (open stock-outs accrue) */
  const reportKey = (S) => JSON.stringify([onlyBest, span, Object.keys(LIMITS).map((k) => S[k]), S.timeZone]);
  const cachedReport = (S, trial) => cache.memo('report', reportKey(S), 60e3, () => {
    const r = helpers.enrich(engine.report(d.stock, d.orders, S, reportOpts()), { decisions: decide.all(), rates: trial ? savedRates() : null });
    r.period = periodKind; if (span.to) r.toKey = span.to; r.yesterday = period.yesterdayFor(d.stock, d.orders, S, r, reportOpts());   // SW-027
    links.annotateReport(r, d.catalog, shopLinks());   // 1.4.0: image + links on every product row
    status.annotate(r.products, d.catalog);
    oneMoney(d, r, onlyBest);   // 2.0.0: money from the one rule, full days only
    r.rev = cache.rev();
    return r;
  });
  const truthData = () => truthOf(d, shopLinks());
  if (p === '/api/brand' && req.method === 'GET') {
    const body = cache.memo('brand', url.searchParams.get('full') === '1' ? 'full' : '', 60e3, () => {
      const t = truthData(); if (!t.on) return brandBody();   // demo, Flow, Sheet, CSV
      return { ...(t.ok ? screen.brand(t, { stockOf: (v) => { const q = d.shopify && d.shopify.lastQty && d.shopify.lastQty[v]; return Number.isFinite(q) ? q : null; } }) : { ok: true, ready: false, reason: t.reason }), basis: t.basis, year: year.summary(year.load()), store: here, generatedAt: Date.now(), app: version.current() };
    });
    return send(res, 200, { ...body, rev: cache.rev() });
  }
  /** 1.4.6: the brand report's build (the parts of §4c, closed months as they closed) with every variant's days, shared by the
   *  brand report and the drawer, so both say the same money */
  function brandFull(given = null) {
    return cache.memo('brandFull', '', 5 * 60e3, () => {
      const rep = given || engine.report(d.stock, d.orders, d.settings, reportOpts({ days: 30, from: undefined }));
      const b = brandData(), o = { ...brandOpts(), rowInfo: rowInfoOf(rep.products), detail: true }, keep = b.basis === 'shopify' && b.y && b.y.done;
      const fk = closed.keyOf(o), r = agency.build(b.y, b.cat, { ...o, frozen: keep ? closed.get(fk) : null });
      if (keep && !readOnly() && !truthOf(d).on) closed.close(fk, r, b.y);   // 2.0.0: months are locked in ledger.json instead
      for (const x of r.products || []) { x.name = x.name || x.sku; if (b.cat[x.variantId] && b.cat[x.variantId].variant && x.variants === 1) x.name = `${x.name} · ${b.cat[x.variantId].variant}`; }
      status.annotate(r.products, b.cat);
      return { b, r };
    });
  }
  function brandBody() {
    /* 1.4.0 (§23): today's report (30 days, saved settings): best sellers now, ads, and website allocations (§6, kept apart) */
    const rep = links.annotateReport(helpers.enrich(engine.report(d.stock, d.orders, d.settings, reportOpts({ days: 30, from: undefined }))), d.catalog, shopLinks());
    status.annotate(rep.products, d.catalog);
    const { b, r } = brandFull(rep);
    const month = r.ok ? r.months[r.months.length - 1].key : null;
    const now = r.ok ? sell.bestNow(r, rep.products, month) : [], nowAll = r.ok ? sell.bestNow(r, rep.products, month, { all: true }).filter((x) => !x.best).map((x) => { const { season: _s, monthPace: _mp, variantPrice: _vp, noPace: _np, outFrom: _o, ...q } = x; return q; }) : [];   // 1.4.9: the other products, for All products
    const adl = sell.ads(r.ok ? r : null, rep.products, { ...engine.DEFAULT_SETTINGS, ...d.settings });
    const slim = (x) => { const { months: _m, season: _s, variantPace: _v, outFrom: _o, monthPace: _mp, variantPrice: _vp, noPace: _np, ...rest } = x; return url.searchParams.get('full') === '1' ? x : { ...rest, months: x.best || x.lost > 0 ? x.months : undefined }; };   // 1.4.4: months for every product with money missed (All products view)
    return { ok: true, ...r, products: (r.products || []).map(slim), now, nowAll, ads: adl, basis: b.basis, year: year.summary(year.load()), store: here, generatedAt: Date.now(), app: version.current() };
  }
  if (p === '/api/shopify/year' && req.method === 'POST') {   // 1.4.0: admin only; queued like a pull
    if (role !== access.ADMIN) return fail(res, 403, access.READ_ONLY);
    if (!keys.status().source) return fail(res, 400, 'Shopify isn’t connected');
    const done = await Promise.race([readYear(id), new Promise((r) => setTimeout(() => r(null), 25000))]);
    return done ? send(res, 200, { ok: true, year: done }) : send(res, 202, { ok: true, running: true });
  }
  if (p === '/api/report' && req.method === 'GET') {
    const S = settingsFor(url, d.settings), trial = Object.keys(LIMITS).some((k) => S[k] !== d.settings[k]);
    const r = cachedReport(S, trial);
    if (!readOnly()) setImmediate(() => weekly.catchUp());   // SW-043: the first report after store-midnight takes the day's snapshot (a read-only copy never writes, SW-055)
    return send(res, 200, { ok: true, ...r, store: here, source: d.source, lastSync: d.lastSync, lastSyncError: d.lastSyncError, shopify: shopifyStatus(), freshness: freshness(), app: version.current() });
  }
  if (p.startsWith('/api/product/') && req.method === 'GET') {
    let id; try { id = decodeURIComponent(p.slice('/api/product/'.length)); } catch { throw badRequest('Bad product ID in the address'); }
    const t0 = Date.now(), S0p = settingsFor(url, d.settings), trial = Object.keys(LIMITS).some((k) => S0p[k] !== d.settings[k]);
    const S = { ...engine.DEFAULT_SETTINGS, ...S0p }, rep = cachedReport(S0p, trial), now = rep.generatedAt;   // 1.4.3: the cached report of the same period
    const det = helpers.enrichDetail(engine.productDetail(id, d.stock, d.orders, S, reportOpts({ now, report: rep })), S, now);
    if (det && det.product) links.annotate([det.product], d.catalog, shopLinks());   // 1.4.0
    det.rev = cache.rev();
    /* 1.4.1 (LOGIC §24): the product profile from the 12 months (whole catalog, so rank, share and season are the store's) */
    try {
      const yb = brandFull(), b = yb.b, vid = String(id);
      const tr = truthData(), own = tr.on && tr.ok ? { ...yb.r, window: { from: tr.span.from, through: tr.span.to }, months: tr.months.map((m) => ({ key: m.key, label: agency.monthLabel(m.key), from: m.from, to: m.to, days: m.days, sold: m.sold })) } : yb.r;
      det.profile = agency.profile(own === yb.r ? yb.r : Object.defineProperty(own, 'details', { value: yb.r.details, enumerable: false }), b.y, b.cat, vid);
      if (tr.on) screen.profile(det.profile, tr, vid);
      if (det.profile.ok && det.product && det.product.allocation) det.profile.allocation = true;
      det.profile.basis = b.basis;
      const c = b.cat[vid] || {}, gc = catalog.current(d.source, d.catalog);
      det.profile.details = { type: c.type || '', vendor: String(c.vendor || '').trim(), tags: c.tags || [], createdAt: c.createdAt || null, publishedAt: c.publishedAt || null, published: !!c.published, oversell: !!c.oversell, periods: status.of(c), lastSold: Object.keys((b.y && b.y.sales.by[vid]) || {}).filter((k) => Number(b.y.sales.by[vid][k][0]) > 0).sort().pop() || null,
        collections: Object.values(gc.collections || {}).filter((x) => (x.productIds || []).map(String).includes(String(c.productId))).map((x) => x.title).filter((t) => !/^all( products)?$/i.test(t)).slice(0, 12) };
      det.profile.ms = Date.now() - t0;
    } catch (e) { det.profile = { ok: false, reason: e.message }; }
    return send(res, 200, { ok: true, ...det });
  }
  /* Group by (SW-022): ?lens=product|type|collection|tag, same period, trial values, catalog and on-order as /api/report,
     so group totals equal report totals. No lens: which lenses the catalog can offer. */
  if (p === '/api/groups' && req.method === 'GET') {
    const cat = catalog.current(d.source, d.catalog); const lens = url.searchParams.get('lens');
    if (!lens) return send(res, 200, { ok: true, lenses: groups.lensesFor(cat), catalog: catalog.info(cat) });
    if (!groups.LENSES.includes(lens)) return fail(res, 400, 'Unknown group');
    const r = engine.report(d.stock, d.orders, settingsFor(url, d.settings), reportOpts());
    return send(res, 200, { ok: true, ...groups.build(oneMoney(d, r, onlyBest).products, cat, lens, { showAll: url.searchParams.get('all') === '1' }), catalog: catalog.info(cat) });
  }
  if (p === '/api/settings' && req.method === 'GET') return send(res, 200, { ok: true, store: here, settings: publicSettings(d.settings, role), role, changes: role === access.ADMIN ? audit.recent(d, 50) : [], lastPlanChange: audit.lastOf(d, PLAN_KEYS), runs: runs.list(d), source: d.source, lastSync: d.lastSync, lastSyncError: d.lastSyncError, shopify: shopifyStatus(), ops: opsState(d) });
  if (p === '/api/shopify/sync' && req.method === 'POST') {
    if (!keys.status().source) return fail(res, 400, 'Shopify isn’t connected');
    const run = syncShopify(id);
    const done = await Promise.race([run.then((x) => x, (e) => ({ error: e.message })), new Promise((r) => setTimeout(() => r(null), 25000))]);
    if (!done) return send(res, 202, { ok: true, running: true });
    return done.error ? fail(res, 502, done.error) : send(res, 200, { ok: true, ...done });
  }
  if (p === '/api/shopify/history' && req.method === 'POST') {   // SW-063: admin only (view sessions refused above), same-origin like every write
    if (role !== access.ADMIN) return fail(res, 403, access.READ_ONLY);
    if (!keys.status().source) return fail(res, 400, 'Shopify isn’t connected');
    if (pulls.has(id)) return fail(res, 409, PULL_RUNNING);
    const done = await Promise.race([rebuildHistory(id), new Promise((r) => setTimeout(() => r(null), 25000))]);
    return done ? send(res, 200, { ok: true, history: done }) : send(res, 202, { ok: true, running: true });
  }
  if (p === '/api/settings' && req.method === 'PUT') {
    const b = jsonObject(await readBody(req, SETTINGS_LIMIT)); const patch = {};
    for (const k of Object.keys(LIMITS)) { const v = clampSetting(k, b[k]); if (v !== undefined) patch[k] = v; }
    if (patch.tzOffsetMin !== undefined && b.timeZone == null) { if (patch.tzOffsetMin === d.settings.tzOffsetMin) delete patch.tzOffsetMin; else patch.timeZone = TZ.fromOffset(patch.tzOffsetMin); }   // old clients: minutes → zone
    if (b.timeZone != null) {   // SW-049: one IANA zone per store ("Asia/Kolkata"), or a fixed "+05:30"
      const z = TZ.canonical(b.timeZone);
      if (!z) throw badRequest('Unknown time zone: pick one from the list (for example Asia/Kolkata)');
      patch.timeZone = z; delete patch.tzOffsetMin;   // the zone decides; reports work out the minutes per moment
    }
    if (typeof b.storeName === 'string') patch.storeName = b.storeName.slice(0, 60);
    for (const k of ['sheetStockCsv', 'sheetOrderCsv']) if (typeof b[k] === 'string') patch[k] = b[k].trim().slice(0, 500);
    if (b.newIngestKey === true) { patch.ingestKey = crypto.randomBytes(16).toString('hex'); patch.ingestKeyAt = Date.now(); }
    audit.record(d, audit.diff(d.settings, patch).filter((c) => c.key !== 'ingestKeyAt'), whoOf(req, role));   // saved with the settings below; the key's date rides with the masked key entry
    return send(res, 200, { ok: true, settings: store.setSettings(patch) });
  }
  if (p === '/api/import' && req.method === 'POST') {
    if (keys.status().source) return fail(res, 409, ONE_SOURCE);
    if (pulls.has(id)) return fail(res, 409, PULL_RUNNING);
    const kind = url.searchParams.get('kind') === 'order' ? 'order' : 'stock';
    // Throws status 400 naming any missing column, before anything is stored. The store clears the demo itself, with its
    // Mark ordered and decisions (store.endDemo, SW-007), as it does for Flow, Sheet and Shopify.
    // With ?map= (the page's preview) or a Shopify export: read through the column mapping, then remember it (SW-045).
    const text = await readBody(req), opts = csvImportOpts(d, text), mapped = url.searchParams.has('map') || opts.shopifyKind === kind;
    const parsed = mapped ? csvmap.parse(text, kind, url.searchParams.get('map'), opts)
      : rows.fromCsv(text, kind, { timeZone: TZ.zoneOf(d.settings), keepDays: KEEP_DAYS });
    const added = store.add(kind === 'stock' ? 'stock' : 'orders', parsed.rows, 'csv');
    if (mapped && url.searchParams.has('map')) csvmap.remember(parsed.head, parsed.kind, parsed.map);
    return send(res, 200, { ok: true, read: parsed.rows.length, added, skipped: parsed.skipped, skips: parsed.skips, ...(mapped ? { format: parsed.format, ignored: parsed.ignored } : {}) });
  }
  if (p === '/api/import/preview' && req.method === 'POST') {   // SW-045: what an import would read; writes nothing
    if (keys.status().source) return fail(res, 409, ONE_SOURCE);
    const text = await readBody(req, 4e6), k = url.searchParams.get('kind');
    const pv = csvmap.preview(text, k === 'order' || k === 'stock' ? k : '', url.searchParams.get('map'), { ...csvImportOpts(d, text), truncated: url.searchParams.get('head') === '1' });
    return send(res, 200, { ok: true, ...pv, tzOffsetMin: d.settings.tzOffsetMin, timeZone: TZ.zoneOf(d.settings) });
  }
  if (p === '/api/sync' && req.method === 'POST') {
    if (keys.status().source) return fail(res, 409, ONE_SOURCE);
    try { return send(res, 200, { ok: true, ...(await syncSheet()) }); } catch (e) { return fail(res, 502, e.message); }
  }
  if (p === '/api/demo' && req.method === 'POST') {
    if (keys.status().source) return fail(res, 409, 'Shopify is connected, so demo data is off (it would mix with real data)');
    if (d.source === 'live') return fail(res, 409, 'This store holds real data. Clear it first (Danger zone) if you really want the demo.');
    const g = loadDemo();
    return send(res, 200, { ok: true, stock: g.stock.length, orders: g.orders.length });
  }
  if (p === '/api/clear' && req.method === 'POST') { if (pulls.has(id)) return fail(res, 409, PULL_RUNNING); store.replaceAll([], [], 'empty'); onorder.clear(); decide.clear(); weekly.clear(); year.clear(); closed.clear(); ledger.clear(); status.clear(); return send(res, 200, { ok: true }); }
  if (p === '/api/export/reorder.csv' && req.method === 'GET') {
    /* SW-025: usable as a PO: the tab filter and search on the page, vendor, unit cost, variant ID (LOGIC.md §15b) */
    const r = links.annotateReport(helpers.enrich(engine.report(d.stock, d.orders, settingsFor(url, d.settings), reportOpts())), d.catalog, shopLinks());
    /* SW-040: Vendor = the product's supplier (SKU map, else Shopify vendor); ?supplier=<name> = that supplier's PO draft (lines to order only) */
    const filter = url.searchParams.get('filter') || 'all';
    const one = url.searchParams.has('supplier') ? supplierRules.cleanName(url.searchParams.get('supplier')).toLowerCase() : null;
    /* SW-041: ?budget=<₹> keeps only the rows above the cut line of the same view (src/budget.js, LOGIC.md §6d) */
    const B = filter === 'ordered' ? null : budget.parse(url.searchParams.get('budget'));
    const fit = B == null ? null : budget.cut(helpers.reorderRows(r.reorder, { filter, q: url.searchParams.get('q') || '' }), B).fit;
    const keep = one == null && !fit ? null : (x) => (one == null || (x.orderQty > 0 && String(x.supplier || '').toLowerCase() === one)) && (!fit || fit.has(String(x.id)));
    const lines = helpers.poLines(r, { filter, q: url.searchParams.get('q') || '', vendors: Object.fromEntries(Object.entries(sups).map(([k, v]) => [k, v.name])), keep });
    const what = one == null ? 'reorder' : `po-${fileSlug(url.searchParams.get('supplier')).replace(/-$/, '') || 'no-supplier'}`;
    return send(res, 200, helpers.csvText(lines), 'text/csv; charset=utf-8', { 'content-disposition': `attachment; filename="${what}-${fileSlug(here.name)}${helpers.fileDate(r.generatedAt, TZ.zoneOf(r.settings))}.csv"` });
  }
  return fail(res, 404, 'Not found');
}

/** Options for a mapped CSV import (SW-045): store time zone, the 120 days kept, SKU → variant ID already in this store,
 *  the mapping remembered for this file's headers; shopifyKind = 'stock' / 'order' for a Shopify export (read mapped without ?map=). */
function csvImportOpts(d, text) {
  let head = null; try { head = csvmap.headOf(text); } catch { /* empty: parse() says so */ }
  const f = head && csvmap.formatOf(head);
  return { timeZone: TZ.zoneOf(d.settings), tzOffsetMin: d.settings.tzOffsetMin, keepDays: KEEP_DAYS, idForSku: csvmap.idsBySku(d.stock, d.catalog), remembered: head ? csvmap.remembered(head) : null,
    shopifyKind: f && /^shopify-/.test(f.format || '') ? f.kind : null };
}

/** A store name for a file name: "sammsara-demo-" (letters, digits, dashes; '' when nothing is left). */
const fileSlug = (n) => { const x = String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); return x ? `${x}-` : ''; };

/* ---------- static ---------- */
function serveStatic(req, res, url) {
  if (!signedIn(auth(req))) {
    if (url.pathname === '/favicon.svg') { res.writeHead(200, { 'content-type': TYPES['.svg'] }); return fs.createReadStream(path.join(PUBLIC, 'favicon.svg')).pipe(res); }
    return send(res, 302, '', 'text/plain', { location: '/login' });
  }
  let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');   // not public-evil/…
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  const ext = path.extname(file), gz = ['.js', '.css', '.html', '.svg'].includes(ext) && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));   // 1.4.3
  res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': 'no-cache', ...(gz ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}) });
  if (gz) fs.createReadStream(file).pipe(zlib.createGzip()).pipe(res); else fs.createReadStream(file).pipe(res);
}

/* ---------- security headers + same-origin writes ---------- */
const CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://cdn.shopify.com", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"].join('; ');
function securityHeaders(req, res) {
  res.setHeader('content-security-policy', CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('strict-transport-security', 'max-age=15552000');
}
/** A browser write from another site (CSRF). Modern browsers say so in Sec-Fetch-Site; otherwise Origin must match
 *  our host (X-Forwarded-Host behind a proxy). Scripts (curl, Flow) send neither and pass. */
function crossSite(req) {
  const site = String(req.headers['sec-fetch-site'] || '');
  if (site && site !== 'same-origin' && site !== 'none') return true;   // cross-site, or same-site (another *.up.railway.app app)
  const origin = req.headers.origin;
  if (!origin || site === 'same-origin') return false;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  try { return new URL(origin).host.toLowerCase() !== host; } catch { return true; }   // includes Origin: null
}
const isWrite = (req) => !['GET', 'HEAD', 'OPTIONS'].includes(req.method);

const server = http.createServer(async (req, res) => {
  securityHeaders(req, res);
  let url;
  try { url = new URL(req.url, 'http://local'); } catch { return fail(res, 400, 'Bad address'); }
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ingest/')) {   // one line per API call: path only, never the query or a cookie
    const t0 = Date.now();
    res.on('finish', () => log.info('request', { store: res.swStore || null, method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - t0 }));
  }
  try {
    if (isWrite(req) && (url.pathname.startsWith('/api/') || url.pathname === '/login' || url.pathname === '/logout') && crossSite(req)) {
      return fail(res, 403, 'Cross-site request refused');
    }
    apiv1.rewrite(url);   // /api/v1/<x> answers as /api/<x> (SW-050); after the cross-site check, which covers both
    if (isWrite(req) && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ingest/')) && readOnly()) return fail(res, 503, readOnly());   // SW-055
    if (url.pathname === '/status') { const st = statusBody(); return send(res, st.code, st.body); }
    if (url.pathname === '/health') { const h = healthBody(); return send(res, h.code, h.body); }
    if (url.pathname === '/login' && req.method === 'GET') {
      if (signedIn(auth(req))) return send(res, 302, '', 'text/plain', { location: '/' });
      return send(res, 200, loginPage(), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      if (!PASSWORD) return send(res, 303, '', 'text/plain', { location: '/' });
      const ip = ipOf(req);
      const block = limiter.blocked(ip);
      if (block === 'ip') return send(res, 429, loginPage(TOO_MANY), 'text/html; charset=utf-8', { 'retry-after': '900' });
      const pass = new URLSearchParams(await readBody(req, 4096)).get('password') || '';
      const role = access.roleForPassword(pass, PASSWORDS, safeEqual);
      const person = role ? null : people.find(pass);   // SW-062: a person's own password
      if (!role && !person) {
        limiter.fail(ip);
        return block ? send(res, 429, loginPage(TOO_MANY), 'text/html; charset=utf-8', { 'retry-after': '900' }) : send(res, 401, loginPage('Wrong password.'), 'text/html; charset=utf-8');
      }
      limiter.ok(ip);
      const exp = Date.now() + SESSION_DAYS * 864e5;
      if (person && !readOnly()) people.touch(person);   // a read-only copy never writes (SW-055)
      const value = person ? people.cookieValue(exp, person, sign) : access.cookieValue(exp, role, sign, VIEW_PASSWORD);
      return send(res, 303, '', 'text/plain', { location: '/', 'set-cookie': `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure(req)}` });
    }
    if (url.pathname === '/logout') {   // POST only, so a link or image elsewhere can't sign people out
      if (req.method !== 'POST') return send(res, 303, '', 'text/plain', { location: '/' });
      return send(res, 303, '', 'text/plain', { location: '/login', 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(req)}` });
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ingest/')) return await api(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof URIError) return fail(res, 400, 'Bad address');
    if (e.status >= 400 && e.status < 500) return fail(res, e.status, e.message);
    console.error(e);
    return fail(res, 500, 'Something went wrong on the server');
  }
});

/* ---------- start and stop ---------- */
const timers = [];
let instance = null;   // the data folder lock (SW-055)
/** Why this copy doesn't write (plain words), or null when it holds the lock. */
const readOnly = () => (instance && !instance.held() ? instance.reason() : null);
/** Data page: this store's capacity warnings and the read-only reason (SW-055). */
function opsState(d) {
  let bytes = 0; try { bytes = fs.statSync(store.file()).size; } catch { /* not written yet */ }
  return { warnings: capacity.warnings({ storeBytes: bytes, rows: d.stock.length + d.orders.length, disk: capacity.diskUsed(DATA_DIR) }), readOnly: readOnly() };
}
let stopping = false;
/** SIGTERM / SIGINT (Railway redeploy, Ctrl-C): stop the timers, let a running pull finish (up to
 *  25 s), write the store, then close. A pull cut short resumes from its saved cursor next time. */
async function shutdown(signal) {
  if (stopping) return; stopping = true;
  console.log(`${signal}: stopping`);
  timers.forEach((t) => clearInterval(t));
  if (pulls.size) await Promise.race([Promise.allSettled([...pulls.values()]), new Promise((r) => setTimeout(r, Number(process.env.STOP_WAIT_MS) || 25000))]);
  const saved = readOnly() ? true : store.saveAll();   // a read-only copy never writes (SW-055)
  if (instance) instance.release();
  if (!saved) console.error('Stopped without saving the latest changes:', store.healthAll().problems.join('; '));
  const code = saved ? 0 : 1;
  server.close(() => process.exit(code));
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(code), 3000).unref();
}

/* SW-054: the boot line names which settings are set, never a value */
const BOOT_VARS = ['NODE_ENV', 'DATA_DIR', 'ADMIN_PASSWORD', 'VIEW_PASSWORD', 'PERFORMITY_POC_API_URL', 'PERFORMITY_POC_API_KEY', 'PERFORMITY_BRAND_ID', 'SHOPIFY_STORE',
  'AZURE_KEY_VAULT_URL', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'ALERT_WEBHOOK_URL', 'DIGEST_WEBHOOK_URL', 'PUBLIC_URL', 'KEEP_DAYS'];
function bootLine(list) {
  const app = version.current(), k = keys.status();
  log.info('boot', { version: app.version, sha: app.short || null, node: process.version, source: k.source || 'none', ready: k.source ? !!k.ready : null, stores: list.length, writing: !!(instance && instance.held()), keepDays: backup.KEEP, set: log.setVars(BOOT_VARS) });
}

async function main() {
  log.captureConsole();   // every console line from here on is one JSON line, tokens scrubbed (SW-054)
  if (PROD && PASSWORD.length < MIN_PASSWORD) {
    console.error(`Refusing to start: NODE_ENV=production needs ADMIN_PASSWORD set, at least ${MIN_PASSWORD} characters.`);
    process.exit(1);
  }
  if (keys.status().source && !PASSWORD) {
    console.error('Refusing to start: Shopify is connected, so set ADMIN_PASSWORD first.');
    process.exit(1);
  }
  const accessProblem = access.configProblem(PASSWORDS);
  if (accessProblem) { console.error('Refusing to start: ' + accessProblem); process.exit(1); }
  instance = lock.make(DATA_DIR);
  if (!instance.acquire()) log.warn('read-only', { why: instance.reason() });
  await stores.refresh();   // Performity: the brand list (the last good one when the API is down)
  const list = stores.list();
  if (!list.length) console.warn(`No store yet (${stores.info().lastError || 'empty brand list'}); retried every ${SYNC_MIN} minutes.`);
  /* every store opens now: the home store takes the old single-store files (src/migrate.js, once ever), pending restores apply;
     a store that can't be read stops the start, so nothing is overwritten (SW-004, critic r2 X1) */
  for (const s of list) {
    try { openStore(s.id); } catch (e) { console.error(`Refusing to start: ${e.message}`); process.exit(1); }
  }
  if (fs.existsSync(path.join(DATA_DIR, 'restore.json'))) console.warn('DATA_DIR/restore.json is not read: put it in DATA_DIR/stores/<id>/restore.json (docs/RUNBOOK.md).');
  /* SW-055: only the copy holding the data folder lock writes; a read-only one starts this when it takes the lock over */
  const work = () => {
  backup.start({ each: (fn) => eachStore(fn) });   // before-replace snapshots; daily backups, every store, hourly
  /* demo only on a store that has never held real data (SW-007) */
  if (!keys.status().source) {
    for (const s of list) {
      inStore(s.id, () => {
        const d = store.load(), stale = d.source === 'demo' && d.settings.demoVersion !== demo.VERSION;
        if (!d.everLive && (stale || (d.source === 'empty' && !d.stock.length && !d.orders.length))) {
          loadDemo();
          console.log(`Loaded demo data into ${s.name} (replace it from Data & settings).`);
        }
      });
    }
  }
  const loop = () => pullAll().catch((e) => console.warn('pull loop:', e.message));
  timers.push(setInterval(loop, SYNC_EVERY));
  if (keys.status().source) timers.push(setTimeout(loop, 5000));
  timers.push(digests.schedule(digestCtx, (fn) => eachStore(fn)));   // SW-028: every minute, each store; sends at its set hour
  timers.forEach((t) => t.unref());
  };
  if (instance.held()) work();
  const beat = setInterval(() => {
    const was = instance.held(), now = instance.beat();
    if (!was && now) { log.info('took over the data folder lock'); work(); }
    if (was && !now) { log.error('lost the data folder lock: another copy took over; this one stops writing', { why: instance.reason() }); timers.forEach((t) => clearInterval(t)); }
  }, lock.BEAT_MS);
  beat.unref(); timers.push(beat);
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => shutdown(sig));
  bootLine(list);
  const app = version.current();
  server.listen(PORT, () => console.log(`Stock-out Watch on http://localhost:${server.address().port}${PASSWORD ? ' (password on)' : ''} · ${list.length} store${list.length === 1 ? '' : 's'} · v${app.version} (${app.short || 'dev'})`));
}
if (require.main === module) main().catch((e) => { console.error(`Refusing to start: ${e.message}`); process.exit(1); });

module.exports = { server, syncShopify, pullAll, digestCtx, inStore, openStore };
