'use strict';
/*
 * 12 months of history from Shopify's own reports (1.4.0, LOGIC.md §20). No order download: two ShopifyQL aggregates
 * (read_reports scope, Admin API 2025-10), per variant per store-time day, for the last DAYS days (today included):
 *
 *   sales:  FROM sales SHOW net_items_sold, net_sales GROUP BY day, product_variant_id SINCE <d1> UNTIL <d2> …
 *   moves:  FROM inventory_adjustment_history SHOW inventory_adjustment_change WHERE inventory_state = 'available'
 *           GROUP BY day, product_variant_id SINCE <d1> UNTIL <d2> …
 *
 * Dates are explicit store-time days, BOTH ends included (checked on Sammsara 24 Nov 2026: SINCE 2026-11-14 UNTIL
 * 2026-11-14 returns that one day; relative UNTIL -Nd leaves day N out, LOGIC §1c). ShopifyQL returns at most 1,000 rows:
 * a window is sized from the rows per day of the window before (~800 rows), and a window that comes back with 1,000 rows is
 * read again in two halves (a single capped day → error 'cap'). Each read costs a lot of Shopify's query budget and
 * ShopifyQL has a per-minute limit, so a run makes at most `maxCalls` reads in at most `maxMs` and carries on at the next
 * pull ("night-time-safe": a store's first load is spread over a few pulls). Every read is counted and logged.
 *
 * Stored in <store folder>/year.json (FORMATS.md), not in store.json and not in backups (it can always be read again):
 *   { v, zone, days, at, triedAt, ok, note, done,
 *     sales: { from, to, by: { variantId: { day: [units, ₹ net] } }, all: { day: [units, ₹ net] } },   all = every row, the store total
 *     moves: { from, to, by: { variantId: { day: change } } },
 *     anchor: { at, day, levels: { variantId: stock } },   the catalog's stock at the run; moves include `day` so far
 *     calls: { last, total, runs: [{ at, n, ms }] } }
 *   from / to = the oldest / newest store day read in full (today is read too, and read again next time).
 * Pure parts: plan windows (windowsBack / windowsForward), parse, merge. run() never throws and never fails a pull; without
 * read_reports it is skipped with a note (Data page).
 */
const TZ = require('./tz');
const { sideFile } = require('./sidefile');

const VERSION = 1;
const DAYS = 365;             // the last 365 store days, today included
const CAP = 1000;             // ShopifyQL's row cap
const TARGET_ROWS = 800;      // aim per read, under the cap
const MAX_WINDOW = 62;        // days per read at most
const QL_VERSION = '2025-10';
const MAX_CALLS = Math.max(1, Number(process.env.YEAR_CALLS_PER_RUN) || 8);   // per run (after a pull); a first load spreads over pulls
const MAX_MS = 4 * 60e3;      // and no new read after 4 minutes
const Q = 'query Year($q: String!) { shopifyqlQuery(query: $q) { tableData { columns { name } rows } parseErrors } }';
const DAY = 864e5;

class YearError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

const keyPlus = (key, n) => new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const span = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY) + 1;   // days a..b, both in
const QL = {
  sales: (a, b) => `FROM sales SHOW net_items_sold, net_sales GROUP BY day, product_variant_id SINCE ${a} UNTIL ${b} ORDER BY day ASC LIMIT ${CAP}`,
  moves: (a, b) => `FROM inventory_adjustment_history SHOW inventory_adjustment_change WHERE inventory_state = 'available' GROUP BY day, product_variant_id SINCE ${a} UNTIL ${b} ORDER BY day ASC LIMIT ${CAP}`,
};

/** tableData → rows { day, variantId|null, units, net } or { day, variantId, delta } + how many raw rows came back. */
function parse(td, kind) {
  const cols = ((td && td.columns) || []).map((c) => c && c.name);
  let rows = td && td.rows;
  if (typeof rows === 'string') { try { rows = JSON.parse(rows); } catch { rows = []; } }
  if (!Array.isArray(rows)) rows = [];
  const out = [];
  for (const raw of rows) {
    const o = Array.isArray(raw) ? Object.fromEntries(cols.map((c, i) => [c, raw[i]])) : (raw || {});
    const day = String(o.day == null ? '' : o.day).slice(0, 10);
    if (!/^\d{4}-\d\d-\d\d$/.test(day)) continue;
    const v = o.product_variant_id == null ? null : String(o.product_variant_id).replace(/^gid:\/\/shopify\/ProductVariant\//, '');
    const variantId = v && /^\d+$/.test(v) ? v : null;
    if (kind === 'sales') {
      const units = Number(o.net_items_sold), net = Number(o.net_sales);
      if (!Number.isFinite(units) && !Number.isFinite(net)) continue;
      out.push({ day, variantId, units: Number.isFinite(units) ? units : 0, net: Number.isFinite(net) ? net : 0 });
    } else {
      const delta = Number(o.inventory_adjustment_change);
      if (!variantId || !Number.isFinite(delta) || !delta) continue;
      out.push({ day, variantId, delta });
    }
  }
  return { rows: out, count: rows.length };
}

/** Window length for the next read from the rows per day seen so far (≥ 1, ≤ MAX_WINDOW). */
const nextLen = (perDay) => Math.max(1, Math.min(MAX_WINDOW, Math.floor(TARGET_ROWS / Math.max(1, perDay || 0))));

/** Put one window's rows into a stream (replacing those days). */
function merge(stream, kind, a, b, rows) {
  const by = stream.by || (stream.by = {});
  if (kind === 'sales') stream.all = stream.all || {};
  for (let k = a; k <= b; k = keyPlus(k, 1)) {   // a window read replaces its days whole
    if (kind === 'sales') delete stream.all[k];
  }
  for (const m of Object.values(by)) for (const k of Object.keys(m)) if (k >= a && k <= b) delete m[k];
  for (const r of rows) {
    if (r.day < a || r.day > b) continue;
    if (kind === 'sales') {
      const t = stream.all[r.day] || (stream.all[r.day] = [0, 0]);
      t[0] += r.units; t[1] = Math.round((t[1] + r.net) * 100) / 100;
      if (!r.variantId || (!r.units && !r.net)) continue;
      const m = by[r.variantId] || (by[r.variantId] = {});
      const x = m[r.day] || (m[r.day] = [0, 0]);
      x[0] += r.units; x[1] = Math.round((x[1] + r.net) * 100) / 100;
    } else {
      const m = by[r.variantId] || (by[r.variantId] = {});
      m[r.day] = (m[r.day] || 0) + r.delta;
    }
  }
  for (const [id, m] of Object.entries(by)) if (!Object.keys(m).length) delete by[id];
}

/** Drop days before `from` (the span moves forward a day at a time). */
function trim(stream, from) {
  for (const m of Object.values(stream.by || {})) for (const k of Object.keys(m)) if (k < from) delete m[k];
  for (const k of Object.keys(stream.all || {})) if (k < from) delete stream.all[k];
  for (const [id, m] of Object.entries(stream.by || {})) if (!Object.keys(m).length) delete stream.by[id];
  if (stream.from && stream.from < from) stream.from = from;
}

/** One ShopifyQL read. Throws YearError on a parse error or a missing table. */
async function one(q, ql, kind) {
  const d = await q(Q, { q: ql });
  const r = d && d.shopifyqlQuery;
  const pe = r && r.parseErrors;
  if (Array.isArray(pe) ? pe.length : pe) throw new YearError('parse', `Shopify didn’t accept the ${kind} query (${[].concat(pe).map((x) => (x && x.message) || x).join('; ').slice(0, 160)})`);
  if (!r || !r.tableData) throw new YearError('empty', `Shopify returned no ${kind} table`);
  return parse(r.tableData, kind);
}

/**
 * Read one stream for days a..b (both included) into `stream`, in windows sized to stay under the cap. dir 'back' reads
 * newest first (backfill: progress keeps the newest days); 'fwd' oldest first. budget = { calls, until, used, log }.
 * Returns the day range fully read: { a, b } (null when nothing was read) and whether it finished.
 */
async function readRange(q, kind, stream, a, b, dir, budget, perDay0 = 30) {
  let perDay = stream.perDay || perDay0, lo = null, hi = null;
  let todo = dir === 'back' ? b : a;   // next day to read from (back: the window's end; fwd: its start)
  while (dir === 'back' ? todo >= a : todo <= b) {
    if (budget.used >= budget.calls || Date.now() > budget.until) return { lo, hi, done: false };
    let len = nextLen(perDay);
    for (;;) {
      const x = dir === 'back' ? (keyPlus(todo, -(len - 1)) < a ? a : keyPlus(todo, -(len - 1))) : todo;
      const y = dir === 'back' ? todo : (keyPlus(todo, len - 1) > b ? b : keyPlus(todo, len - 1));
      budget.used++; budget.log.push(`${kind} ${x}..${y}`);
      const r = await one(q, QL[kind](x, y), kind);
      if (r.count >= CAP) {
        if (x === y) throw new YearError('cap', `more than ${CAP} ${kind} rows on ${x}`);
        len = Math.max(1, Math.floor(span(x, y) / 2));
        perDay = r.count / span(x, y) * 2; stream.perDay = Math.round(perDay * 10) / 10;
        if (budget.used >= budget.calls || Date.now() > budget.until) return { lo, hi, done: false };
        continue;
      }
      merge(stream, kind, x, y, r.rows);
      perDay = Math.max(1, r.count / span(x, y)); stream.perDay = Math.round(perDay * 10) / 10;
      lo = lo == null || x < lo ? x : lo; hi = hi == null || y > hi ? y : hi;
      todo = dir === 'back' ? keyPlus(x, -1) : keyPlus(y, 1);
      break;
    }
  }
  return { lo, hi, done: true };
}

const file = sideFile('year.json');
/** The stored year (never throws: a file that can't be read is treated as empty and read again from Shopify). */
function load() {
  try { const d = file.read(); return d && d.v === VERSION ? d : null; } catch (e) { console.warn('year.json unreadable, reading again from Shopify:', e.message); file.reset(); return null; }
}
const save = (d) => file.write(d);

/** True when this store should read: never read, older rules, backfill not finished, or not yet read today (store time). */
function due(y, now = Date.now(), zone = TZ.DEFAULT_ZONE) {
  if (!y || y.v !== VERSION) return true;
  if (!y.done) return true;
  const last = Math.max(+y.at || 0, +y.triedAt || 0);
  return TZ.dayKey(last, zone) !== TZ.dayKey(now, zone);
}

/** A failure in plain words for the Data page. */
function noteFor(e) {
  const m = String((e && e.message) || e || '');
  if (/lacks a read permission|access denied|read_reports|scope/i.test(m)) return '12-month history not read: the Shopify token can’t read reports (needs read_reports). The brand report uses the days we hold.';
  return `12-month history not read: ${m.slice(0, 160)}. It is tried again at the next pull.`;
}

/**
 * Read the current store's 12 months (call inside scope.run, after a good pull). Order: today's new days first (both
 * streams), then the backfill, newest to oldest, within the budget. The anchor (stock now) is the catalog's at this run.
 * Never throws; returns the summary saved in year.json.
 */
async function run({ q, now = Date.now(), days = DAYS, maxCalls = MAX_CALLS, maxMs = MAX_MS } = {}) {
  const store = require('./store');
  const shopify = require('./shopify');
  const ask = q || ((doc, vars) => shopify.gql(doc, vars, { version: QL_VERSION }));
  const d = store.load();
  const zone = TZ.zoneOf(d.settings);
  const today = TZ.dayKey(now, zone), start = keyPlus(today, -(days - 1));
  const prev = load();
  const y = prev && prev.zone === zone && prev.days === days ? prev : { v: VERSION, zone, days, sales: {}, moves: {}, calls: { total: 0, runs: [] } };
  const budget = { calls: maxCalls, until: Date.now() + maxMs, used: 0, log: [] };
  const t0 = Date.now();
  try {
    for (const kind of ['sales', 'moves']) {
      const s = y[kind];
      trim(s, start);
      if (s.to && s.to < start) { y[kind] = { perDay: s.perDay }; }
    }
    /* 1. new days (and today again): both streams, oldest first, so the anchor below matches the moves */
    let fresh = true;
    for (const kind of ['sales', 'moves']) {
      const s = y[kind];
      if (!s.to) continue;   // nothing yet: the backfill below starts at today
      const r = await readRange(ask, kind, s, s.to, today, 'fwd', budget);
      if (r.hi) s.to = r.hi >= today ? keyPlus(today, -1) : r.hi;
      if (!r.done) fresh = false;
    }
    /* 2. backfill, newest first, one window of each stream in turn (both streams reach back together, so a part-read
       year is usable for its newest months); the first read of a stream starts at today */
    for (let more = true; more && budget.used < maxCalls && Date.now() <= budget.until;) {
      more = false;
      for (const kind of ['sales', 'moves']) {
        const s = y[kind];
        const end = s.from ? keyPlus(s.from, -1) : today;
        if (end < start || budget.used >= maxCalls) continue;
        budget.calls = Math.min(maxCalls, budget.used + 1);   // one read (a capped one is sized down for the next turn)
        const before = budget.used;
        const r = await readRange(ask, kind, s, start, end, 'back', budget);
        budget.calls = maxCalls;
        if (r.lo) { s.from = r.lo; if (!s.to) s.to = r.hi >= today ? keyPlus(today, -1) : r.hi; }
        if (budget.used > before && s.from !== start) more = true;
      }
    }
    if (fresh && y.moves.to && (!y.anchor || y.moves.to >= keyPlus(today, -1))) {
      const levels = {};
      for (const [id, c] of Object.entries(d.catalog || {})) if (c && c.tracked !== false && Number.isFinite(Number(c.stock)) && c.stock != null) levels[id] = Number(c.stock);
      let seen = 0; for (const c of Object.values(d.catalog || {})) if (+c.seenAt > seen) seen = +c.seenAt;
      y.anchor = { at: seen || now, day: today, levels };
    }
    y.done = y.sales.from === start && y.moves.from === start && y.sales.to >= keyPlus(today, -1) && y.moves.to >= keyPlus(today, -1);
    y.ok = !!y.anchor; y.at = now; y.triedAt = now; y.note = y.done ? null : `Reading 12 months from Shopify: ${y.sales.from || today} to today so far; the rest follows at the next pulls.`;
  } catch (e) {
    console.warn('year: 12-month read stopped:', e.message);
    y.triedAt = now; y.note = noteFor(e); y.error = e.code || 'error';
    if (/read_reports|scope|permission|access denied/i.test(String(e.message))) y.done = true;   // not every pull: once a day
  }
  y.calls = y.calls || { total: 0, runs: [] };
  y.calls.last = budget.used; y.calls.total = (y.calls.total || 0) + budget.used;
  y.calls.runs = [...(y.calls.runs || []), { at: now, n: budget.used, ms: Date.now() - t0 }].slice(-30);
  try { save(y); } catch (e) { console.warn('year.json not saved:', e.message); }
  console.log(`year: ${budget.used} ShopifyQL calls in ${Math.round((Date.now() - t0) / 1000)} s (${budget.log.join(', ')}); sales ${y.sales.from || '–'}..${y.sales.to || '–'}, moves ${y.moves.from || '–'}..${y.moves.to || '–'}${y.done ? ', complete' : ''}`);
  return summary(y);
}

/** The year without its tables (Data page, /api/settings). */
const summary = (y) => (y ? { v: y.v, ok: !!y.ok, done: !!y.done, at: y.at || null, triedAt: y.triedAt || null, note: y.note || null, days: y.days,
  sales: { from: y.sales?.from || null, to: y.sales?.to || null }, moves: { from: y.moves?.from || null, to: y.moves?.to || null }, anchorAt: y.anchor?.at || null,
  calls: { last: y.calls?.last || 0, total: y.calls?.total || 0 } } : null);

const clear = () => { try { save({}); file.reset(); } catch { /* nothing to clear */ } };

module.exports = { VERSION, DAYS, CAP, QL, Q, QL_VERSION, MAX_CALLS, parse, merge, trim, nextLen, readRange, keyPlus, span, load, save, due, run, summary, noteFor, clear, YearError, FILE_NAME: 'year.json' };
