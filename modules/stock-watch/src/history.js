'use strict';
/*
 * Stock history rebuild (SW-063, LOGIC.md §1c). Shopify has no API for past stock levels, so a newly connected store
 * would only see stock-outs from its first pull on. Shopify does keep a log of every stock change, readable with
 * ShopifyQL (read_reports scope, Admin API 2025-10):
 *
 *   FROM inventory_adjustment_history SHOW inventory_adjustment_change WHERE inventory_state = 'available'
 *   GROUP BY hour, product_variant_id SINCE 2026-09-21 UNTIL 2026-09-27 ORDER BY hour ASC LIMIT 1000
 *
 * Dates are store-time calendar days and BOTH ends are included (checked on Sammsara, 20 Nov 2026). Relative ranges
 * are not used: `UNTIL -Nd` leaves day -N out, which lost one day in every 7-day window (1.1.0 bug, LOGIC §1c).
 *
 * Walking that log backwards from the stock we saw on our first pull gives the stock at every earlier hour:
 *   level(t) = stock at our first snapshot − sum of 'available' changes after t (and before the snapshot)
 * Only 'available' matches Shopify's inventoryQuantity ('committed' is stock held for unfulfilled orders).
 * The hour holding the first read is split with the order lines (exact times): only orders before the read count.
 * A variant whose rebuilt stock goes below min(stock at the first read, 0) is dropped (the log is incomplete for it).
 * Then a check (validate): an order line inside a rebuilt stock-out, after its first hour, with no stock drop logged
 * in its hour, can't have happened; such a variant is dropped, and if those lines are over 1% of the order lines
 * in the rebuilt span the whole rebuild is refused (stock-outs then count from the first read on).
 *
 *   windows(days)                                    pure: [a, b] day offsets, a ≥ b, tiling days..0 with no gap
 *   rebuild(changes, nowLevels, firstSeenAt, opts)  pure: change log → stock rows (pullStock's shape)
 *   validate(rows, orders, changes, firstSeenAt)     pure: order lines inside rebuilt stock-outs
 *   fetchChanges(q, days, opts)                     paged ShopifyQL reads through gql (read-only guard, cost pacing)
 *   run(opts)                                       once per store after the first good pull, again when VERSION
 *                                                   changes, or Data → Rebuild
 * Rows are stored with src 'rebuilt', only for times before the store's first live stock read; never fails a pull.
 */
const TZ = require('./tz');

const DAY = 864e5, HOUR = 36e5;
const QL_VERSION = '2025-10';   // the version ShopifyQL was checked on (Sammsara, 20 Nov 2026)
const CAP = 1000;               // ShopifyQL returns at most this many rows per query
const WINDOW_DAYS = 7;          // first try: a week per query; a capped window is split in half
/** Bumped when the rebuild's rules change: a store rebuilt under an older version is rebuilt again on its next pull. */
const OVERSELL = 2;
const VERSION = 3;              // 1 = 1.1.0 (relative windows, lost 1 day in 7); 2 = 1.1.1 (dates, first-hour split, check); 3 = 1.4.6 (oversell floor)
const BAD_SHARE = 0.01;         // order lines inside rebuilt stock-outs above this share of the span's lines → refused
const HISTORY_Q = 'query History($q: String!) { shopifyqlQuery(query: $q) { tableData { columns { name } rows } parseErrors } }';

class HistoryError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

/** Store-day key n days before `key` (calendar arithmetic on the key, so daylight saving can't shift it). */
const keyMinus = (key, n) => new Date(Date.parse(`${key}T00:00:00Z`) - n * DAY).toISOString().slice(0, 10);
/** The query for store days `from`..`to` (YYYY-MM-DD, both included). */
const qlFor = (from, to, grain = 'hour') => `FROM inventory_adjustment_history SHOW inventory_adjustment_change WHERE inventory_state = 'available' GROUP BY ${grain}, product_variant_id SINCE ${from} UNTIL ${to} ORDER BY ${grain} ASC LIMIT ${CAP}`;
/** Day-offset windows [a, b] (a ≥ b, both included; 0 = today) covering days..0, each day exactly once. */
function windows(days, size = WINDOW_DAYS) {
  const out = [];
  for (let a = days; a >= 0; a -= size) out.push([a, Math.max(0, a - size + 1)]);
  return out;
}
/** Split an inclusive window in two halves that still cover every day once: [a, m] and [m - 1, b]. */
const split = (a, b) => { const m = Math.floor((a + b) / 2) + 1; return [[a, m], [m - 1, b]]; };

/** A ShopifyQL time ("2026-11-10T14:00:00+05:30", "2026-11-10T14:00:00", "2026-11-10") → ms. No zone = store time. */
function parseTime(v, zone) {
  const s = String(v == null ? '' : v).trim();
  if (/[T ]\d\d:\d\d.*(Z|[+-]\d\d:?\d\d)$/.test(s)) return Date.parse(s.replace(' ', 'T'));
  const m = s.match(/^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d)(?::(\d\d))?(?::(\d\d))?)?$/);
  if (!m) return NaN;
  return TZ.fromLocal(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)), zone);
}

/** tableData → [{ t, variantId, delta }] ('available' only; zero and unreadable rows skipped) + how many raw rows came back. */
function parseTable(td, zone) {
  const cols = ((td && td.columns) || []).map((c) => c && c.name);
  let rows = td && td.rows;
  if (typeof rows === 'string') { try { rows = JSON.parse(rows); } catch { rows = []; } }
  if (!Array.isArray(rows)) rows = [];
  const out = [];
  for (const raw of rows) {
    const o = Array.isArray(raw) ? Object.fromEntries(cols.map((c, i) => [c, raw[i]])) : (raw || {});
    if (o.inventory_state != null && o.inventory_state !== 'available') continue;
    const t = parseTime(o.hour != null ? o.hour : o.day, zone);
    const variantId = String(o.product_variant_id == null ? '' : o.product_variant_id).replace(/^gid:\/\/shopify\/ProductVariant\//, '');
    const delta = Number(o.inventory_adjustment_change);
    if (!Number.isFinite(t) || !/^\d+$/.test(variantId) || !Number.isFinite(delta) || !delta) continue;
    out.push({ t, variantId, delta });
  }
  return { changes: out, count: rows.length };
}

/** One ShopifyQL read. Throws HistoryError on parse errors or a missing table. */
async function one(q, ql, zone) {
  const d = await q(HISTORY_Q, { q: ql });
  const r = d && d.shopifyqlQuery;
  const pe = r && r.parseErrors;
  if (Array.isArray(pe) ? pe.length : pe) throw new HistoryError('parse', `Shopify didn’t accept the change-log query (${[].concat(pe).map((x) => (x && x.message) || x).join('; ').slice(0, 160)})`);
  if (!r || !r.tableData) throw new HistoryError('empty', 'Shopify returned no change-log table');
  return parseTable(r.tableData, zone);
}

/**
 * Every 'available' stock change of the last `days` store days, today included. Windows are absolute store-time
 * dates, both ends included (windows()), so every day is read exactly once. A week per query; a window that comes
 * back with 1,000 rows (the cap) is split in half (split()); a single capped day is read by day instead of by hour;
 * still capped → HistoryError('cap').
 */
async function fetchChanges(q, days, { zone = 'Asia/Kolkata', cap = CAP, now = Date.now() } = {}) {
  const out = [];
  const today = TZ.dayKey(now, zone), key = (n) => keyMinus(today, n);
  const todo = windows(days);
  let calls = 0;
  while (todo.length) {
    const [a, b] = todo.shift();
    calls++;
    const r = await one(q, qlFor(key(a), key(b)), zone);
    if (r.count < cap) { out.push(...r.changes); continue; }
    if (a > b) { todo.unshift(...split(a, b)); continue; }
    calls++;
    const byDay = await one(q, qlFor(key(a), key(b), 'day'), zone);
    if (byDay.count >= cap) throw new HistoryError('cap', `more than ${cap} stock changes on one day`);
    out.push(...byDay.changes);
  }
  return { changes: out, calls };
}

/** Start of the store-time clock hour holding t (ShopifyQL's hour buckets are store-time hours). */
const hourStart = (t, zone) => TZ.nextHour(t, zone) - HOUR;

/**
 * Pure. changes = [{ t, variantId, delta }] (t = the hour bucket's start); nowLevels = { variantId: stock at our first
 * snapshot }; firstSeenAt = time of that snapshot; opts.since = earliest time to rebuild; opts.meta = { variantId: a
 * stock row (sku, product, variant, price, type, vendor, cost) }; opts.orders = order lines (exact times) for the
 * first read's own hour; opts.zone = the store's zone. Changes at or after firstSeenAt, or before since, are ignored.
 * The hour holding firstSeenAt: with opts.orders, its logged change is replaced by −(units ordered in that hour before
 * firstSeenAt), since the bucket also holds changes made after the read; without, the whole bucket counts as before.
 * → { rows, kept, changed, flat, dropped: [ids], total }. Per variant kept: one row at `since` (stock then, before
 * blank), then one row per hour its stock changed. Flat = no change in the log (stock the same the whole time).
 * Dropped: the walk goes below min(stock at the first read, 0) (an oversold variant may sit at −1; lower = log gaps).
 */
function rebuild(changes, nowLevels, firstSeenAt, { since = firstSeenAt - 60 * DAY, meta = {}, orders = null, zone = 'Asia/Kolkata' } = {}) {
  const by = new Map();
  const add = (id, t, d) => { if (!by.has(id)) by.set(id, new Map()); const m = by.get(id); m.set(t, (m.get(t) || 0) + Number(d)); };
  const hs = hourStart(firstSeenAt, zone), split = Array.isArray(orders) && hs >= since;
  for (const c of changes || []) {
    const id = String(c.variantId);
    if (!(c.t >= since && c.t < firstSeenAt) || !Object.hasOwn(nowLevels, id)) continue;
    if (split && c.t >= hs) continue;   // the first read's hour: from the order lines below
    add(id, c.t, c.delta);
  }
  if (split) for (const o of orders) {
    const id = String(o.variantId);
    if (o.t >= hs && o.t < firstSeenAt && Object.hasOwn(nowLevels, id)) add(id, hs, -Number(o.qty || 0));
  }
  const rows = [], dropped = []; let changed = 0, flat = 0;
  for (const [id, L0] of Object.entries(nowLevels)) {
    const cs = [...(by.get(id) || new Map())].filter(([, d]) => d).sort((a, b) => a[0] - b[0]);
    let L = Number(L0); const steps = [], floor = Math.min(Number(L0), 0) - OVERSELL;   // 1.4.6: an oversell to −1 or −2 is not a broken log (same as src/agency.js)
    for (let i = cs.length - 1; i >= 0; i--) { const [t, d] = cs[i]; steps.unshift({ t, before: L - d, now: L }); L -= d; }
    if (L < floor || steps.some((s) => s.before < floor)) { dropped.push(id); continue; }
    const r = meta[id] || {};
    const row = (t, before, now) => ({ t, variantId: id, sku: r.sku || '', product: r.product || '', variant: r.variant || '', before, now, price: Number(r.price) || 0,
      ...(r.type ? { type: r.type } : {}), ...(r.vendor ? { vendor: r.vendor } : {}), ...(r.cost ? { cost: r.cost } : {}) });
    rows.push(row(since, null, L));
    for (const s of steps) rows.push(row(s.t, s.before, s.now));
    if (steps.length) changed++; else flat++;
  }
  return { rows, kept: changed + flat, changed, flat, dropped, total: Object.keys(nowLevels).length };
}

/**
 * Pure. The check on a rebuild (LOGIC §1c): with "sell when out of stock" off, nobody can order a product at 0.
 * An order line inside a rebuilt stock-out (stock ≤ 0), after the hour it started, whose own hour logged no stock drop
 * for that variant, means the walk is wrong there (an oversell logs its drop, so it passes). Order lines in the
 * first read's hour are left out (that hour is built from them).
 * → { lines: order lines in the rebuilt span, bad: lines failing, badUnits, variants: [ids with a failing line] }
 */
function validate(rows, orders, changes, firstSeenAt, { since = -Infinity, zone = 'Asia/Kolkata' } = {}) {
  const drops = new Set();
  for (const c of changes || []) if (Number(c.delta) < 0) drops.add(`${c.variantId}|${c.t}`);
  const outs = new Map();   // id → [[start, end)] while the rebuilt stock is ≤ 0
  const byId = new Map();
  for (const r of rows) { const k = String(r.variantId); if (!byId.has(k)) byId.set(k, []); byId.get(k).push(r); }
  for (const [id, rs] of byId) {
    rs.sort((a, b) => a.t - b.t);
    const list = []; let open = null;
    for (const r of rs) {
      if (r.now <= 0 && open == null) open = r.t;
      else if (r.now > 0 && open != null) { list.push([open, r.t]); open = null; }
    }
    if (open != null) list.push([open, firstSeenAt]);
    if (list.length) outs.set(id, list);
  }
  const hs = hourStart(firstSeenAt, zone);
  let lines = 0, bad = 0, badUnits = 0; const variants = new Set();
  for (const o of orders || []) {
    if (!(o.t >= since && o.t < firstSeenAt) || !byId.has(String(o.variantId)) || !(Number(o.qty) > 0)) continue;   // a fully refunded line (qty 0, SW-064) sold nothing
    lines++;
    if (o.t >= hs) continue;
    const id = String(o.variantId), list = outs.get(id);
    if (!list || !list.some(([a, b]) => o.t >= TZ.nextHour(a, zone) && o.t < b)) continue;
    if (drops.has(`${id}|${hourStart(o.t, zone)}`)) continue;
    bad++; badUnits += Number(o.qty) || 0; variants.add(id);
  }
  return { lines, bad, badUnits, variants: [...variants] };
}

/** The store's first live stock read: its time, and each variant's stock then (Shopify rows at that moment). */
function snapshot(stock) {
  let first = Infinity;
  for (const r of stock) if (r.src !== 'rebuilt' && r.t < first) first = r.t;
  const levels = {}, meta = {};
  if (!Number.isFinite(first)) return { firstSeenAt: null, levels, meta };
  for (const r of stock) {
    if (r.t !== first || r.src !== 'shopify' || r.now == null || !Number.isFinite(Number(r.now))) continue;
    levels[String(r.variantId)] = Number(r.now); meta[String(r.variantId)] = r;
  }
  return { firstSeenAt: first, levels, meta };
}

/** A failure in plain words for the Data page. */
function noteFor(e) {
  const m = String((e && e.message) || e || '');
  if (/lacks a read permission|access denied|read_reports|scope/i.test(m)) return 'Past stock-outs not rebuilt: the Shopify token can’t read reports (needs read_reports). Stock-outs count from the first pull on.';
  if (e && e.code === 'cap') return `Past stock-outs not rebuilt: ${m}, more than Shopify’s change log can return. Stock-outs count from the first pull on.`;
  return `Past stock-outs not rebuilt: ${m.slice(0, 160)}. Stock-outs count from the first pull on.`;
}

/**
 * Rebuild the current store's stock history (call inside scope.run). Never throws: the outcome is saved as
 * store.shopify.history { at, v, ok, kept, total, dropped (droppedLog + droppedCheck), changed, flat, from, until, rows,
 * calls, check: { lines, bad, badUnits, variants }, note } and store.shopify.historyRebuiltAt, and returned.
 * Re-running replaces earlier rebuilt rows. Check failed on over 1% of order lines → no rebuilt rows (ok false).
 */
async function run({ q, now = Date.now(), days = 60 } = {}) {
  const store = require('./store');
  const shopify = require('./shopify');
  const ask = q || ((doc, vars) => shopify.gql(doc, vars, { version: QL_VERSION }));
  const d = store.load();
  const zone = TZ.zoneOf(d.settings);
  const done = (info) => { store.setShopify({ historyRebuiltAt: now, history: { at: now, ...info } }); return { at: now, ...info }; };
  const { firstSeenAt, levels, meta } = snapshot(d.stock);
  if (!firstSeenAt || !Object.keys(levels).length) return done({ ok: false, note: 'Past stock-outs not rebuilt: no Shopify stock read yet to start from.' });
  const since = firstSeenAt - days * DAY;
  let got;
  try { got = await fetchChanges(ask, Math.min(118, Math.ceil((now - since) / DAY)), { zone, now }); } catch (e) {
    console.warn('history: rebuild skipped:', e.message);
    const prev = d.shopify.history;   // a failed re-run keeps an earlier rebuild made by these rules (its rows stay) and says why it didn't redo it
    if (prev && prev.ok && prev.v === VERSION) return done({ ...prev, note: noteFor(e) });
    if (prev && prev.ok) store.setRebuilt([]);   // rows from older rules (1.1.0 lost a day a week): safer to have none
    return done({ ok: false, v: VERSION, note: noteFor(e) });
  }
  const out = rebuild(got.changes, levels, firstSeenAt, { since, meta, orders: d.orders, zone });
  const check = validate(out.rows, d.orders, got.changes, firstSeenAt, { since, zone });
  const summary = { lines: check.lines, bad: check.bad, badUnits: check.badUnits, variants: check.variants.length };
  if (check.lines && check.bad / check.lines > BAD_SHARE) {
    store.setRebuilt([]);
    console.warn(`history: rebuild refused, ${check.bad} of ${check.lines} order lines fall inside rebuilt stock-outs`);
    return done({ ok: false, v: VERSION, total: out.total, check: summary, from: since, until: firstSeenAt, calls: got.calls,
      note: `Past stock-outs not rebuilt: ${check.bad} of ${check.lines} orders would fall while the product was out, so Shopify’s change log doesn’t add up. Stock-outs count from the first pull on.` });
  }
  const failed = new Set(check.variants);
  const rows = failed.size ? out.rows.filter((r) => !failed.has(String(r.variantId))) : out.rows;
  const kept = out.kept - failed.size;
  store.setRebuilt(rows);
  console.log(`history: rebuilt ${kept} of ${out.total} variants (${out.dropped.length} dropped, ${failed.size} failed the order check, ${got.calls} ShopifyQL calls)`);
  return done({ ok: true, v: VERSION, kept, total: out.total, changed: out.changed, flat: out.flat, dropped: out.dropped.length + failed.size,
    droppedLog: out.dropped.length, droppedCheck: failed.size, check: summary, from: since, until: firstSeenAt, rows: rows.length, calls: got.calls, note: null });
}

/** True when this store's stock history should be rebuilt on the next pull: never done, or done by older rules. */
const due = (sh) => !!sh && (!sh.historyRebuiltAt || !sh.history || (sh.history.v || 1) !== VERSION);

module.exports = { HISTORY_Q, QL_VERSION, CAP, VERSION, BAD_SHARE, qlFor, windows, split, keyMinus, parseTime, parseTable, fetchChanges, rebuild, validate, snapshot, noteFor, run, due, HistoryError };
