'use strict';
/*
 * Weekly sales per variant from Shopify (1.3.0, LOGIC.md §4c "G26" and §3 floor). We hold only 60 days of orders, so a
 * steady seller that had a slow month looked like a guess. Shopify's own sales reports go back further, readable with
 * ShopifyQL (read_reports scope, Admin API 2025-10), no order download:
 *
 *   FROM sales SHOW net_items_sold, net_sales GROUP BY week, product_variant_id
 *   SINCE 2026-05-25 UNTIL 2026-11-24 ORDER BY week ASC LIMIT 1000
 *
 * The span is the last WEEKS full weeks (Monday to Sunday, store time) plus this week so far. Read once a day per store,
 * after a good pull, in windows of CHUNK_WEEKS weeks; a window that returns 1,000 rows (the cap) is split in half.
 * Saved in store.json → shopify.weekSales; never throws, never fails a pull; without read_reports it is skipped with a note
 * and confidence keeps the units rule.
 *
 *   by[variantId] = { s, u, n, l }
 *     s = full weeks with net units sold > 0 (net_items_sold books a return on the return's date, so a week can be negative)
 *     u = net units over the whole span (≥ 0), n = net sales ₹ over the span (ex tax), l = last full week with a sale
 *   start = the first full week's Monday 00:00 store time (ms); weeks = WEEKS
 *
 *   plan(now, zone)   pure: the date windows to read
 *   parse(td)         pure: tableData → rows
 *   summarise(rows, plan) pure: rows → by
 *   fetch(q, plan)    paged ShopifyQL reads through q (shopify.gql: read-only guard, cost pacing)
 *   run(opts)         once a day per store (due()); keeps the last good read when a read fails
 */
const TZ = require('./tz');

const DAY = 864e5;
const VERSION = 1;          // bumped when the rules change: a store read under an older version is read again
const WEEKS = 25;           // full weeks behind the confidence (G26)
const CHUNK_WEEKS = 9;      // ~80 variants a week sell on Sammsara: 9 weeks ≈ 720 rows, under the cap
const CAP = 1000;           // ShopifyQL returns at most this many rows per query
const QL_VERSION = '2025-10';
const WEEKS_Q = 'query Weeks($q: String!) { shopifyqlQuery(query: $q) { tableData { columns { name } rows } parseErrors } }';

class WeeksError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

const keyPlus = (key, n) => new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const qlFor = (from, to) => `FROM sales SHOW net_items_sold, net_sales GROUP BY week, product_variant_id SINCE ${from} UNTIL ${to} ORDER BY week ASC LIMIT ${CAP}`;

/** The span and its windows: this week's Monday (store time), the first full week's Monday WEEKS weeks before it,
 *  windows [from, to] (store-time dates, both ends included) of CHUNK_WEEKS weeks each, the last one ending today. */
function plan(now, zone, { weeks = WEEKS, chunk = CHUNK_WEEKS } = {}) {
  const today = TZ.dayKey(now, zone);
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();   // 0 = Sunday
  const monday = keyPlus(today, -((dow + 6) % 7));
  const first = keyPlus(monday, -7 * weeks);
  const windows = [];
  for (let k = first; k <= today; k = keyPlus(k, 7 * chunk)) { const end = keyPlus(k, 7 * chunk - 1); windows.push([k, end < today ? end : today]); }
  const [y, m, d] = first.split('-').map(Number);
  return { today, monday, first, weeks, windows, start: TZ.fromLocal(Date.UTC(y, m - 1, d), zone) };
}
/** Split a window at a week boundary: [a, mid − 1] and [mid, b]; null when it is a single week. */
function split([a, b]) {
  const n = Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY) + 1;
  if (n <= 7) return null;
  const mid = keyPlus(a, 7 * Math.floor(Math.ceil(n / 7) / 2));
  return [[a, keyPlus(mid, -1)], [mid, b]];
}

/** tableData → [{ week, variantId, net, sales }] + how many raw rows came back. */
function parse(td) {
  const cols = ((td && td.columns) || []).map((c) => c && c.name);
  let rows = td && td.rows;
  if (typeof rows === 'string') { try { rows = JSON.parse(rows); } catch { rows = []; } }
  if (!Array.isArray(rows)) rows = [];
  const out = [];
  for (const raw of rows) {
    const o = Array.isArray(raw) ? Object.fromEntries(cols.map((c, i) => [c, raw[i]])) : (raw || {});
    const week = String(o.week == null ? '' : o.week).slice(0, 10);
    const variantId = String(o.product_variant_id == null ? '' : o.product_variant_id).replace(/^gid:\/\/shopify\/ProductVariant\//, '');
    const net = Number(o.net_items_sold), sales = Number(o.net_sales);
    if (!/^\d{4}-\d\d-\d\d$/.test(week) || !/^\d+$/.test(variantId) || !Number.isFinite(net)) continue;
    out.push({ week, variantId, net, sales: Number.isFinite(sales) ? sales : 0 });
  }
  return { rows: out, count: rows.length };
}

/** rows → by (see the top). Full weeks = Mondays from p.first to the week before p.monday. */
function summarise(rows, p) {
  const by = {};
  for (const r of rows) {
    if (r.week < p.first) continue;
    const x = Object.hasOwn(by, r.variantId) ? by[r.variantId] : (by[r.variantId] = { s: 0, u: 0, n: 0, l: null });
    x.u += r.net; x.n += r.sales;
    if (r.week < p.monday && r.net > 0) { x.s++; if (!x.l || r.week > x.l) x.l = r.week; }
  }
  for (const x of Object.values(by)) { x.u = Math.max(0, x.u); x.n = Math.max(0, Math.round(x.n)); }
  return by;
}

/** One ShopifyQL read. Throws WeeksError on parse errors or a missing table. */
async function one(q, ql) {
  const d = await q(WEEKS_Q, { q: ql });
  const r = d && d.shopifyqlQuery;
  const pe = r && r.parseErrors;
  if (Array.isArray(pe) ? pe.length : pe) throw new WeeksError('parse', `Shopify didn’t accept the weekly sales query (${[].concat(pe).map((x) => (x && x.message) || x).join('; ').slice(0, 160)})`);
  if (!r || !r.tableData) throw new WeeksError('empty', 'Shopify returned no weekly sales table');
  return parse(r.tableData);
}
/** Every window of the plan; a capped window is split at a week boundary; a capped single week → WeeksError('cap'). */
async function fetch(q, p, { cap = CAP } = {}) {
  const todo = p.windows.slice(), rows = [];
  let calls = 0;
  while (todo.length) {
    const w = todo.shift(); calls++;
    const r = await one(q, qlFor(w[0], w[1]));
    if (r.count < cap) { rows.push(...r.rows); continue; }
    const halves = split(w);
    if (!halves) throw new WeeksError('cap', `more than ${cap} variants sold in one week`);
    todo.unshift(...halves);
  }
  return { rows, calls };
}

/** A failure in plain words for the Data page. */
function noteFor(e) {
  const m = String((e && e.message) || e || '');
  if (/lacks a read permission|access denied|read_reports|scope/i.test(m)) return 'Weekly sales not read: the Shopify token can’t read reports (needs read_reports). Confidence uses units sold.';
  return `Weekly sales not read: ${m.slice(0, 160)}. Confidence uses units sold.`;
}

/** True when the store should read its weekly sales: never read, read (or tried) before today in store time, or older rules. */
function due(sh, now = Date.now(), zone = TZ.DEFAULT_ZONE) {
  const w = sh && sh.weekSales;
  if (!w || w.v !== VERSION) return true;
  const last = Math.max(+w.at || 0, +w.triedAt || 0);
  return TZ.dayKey(last, zone) !== TZ.dayKey(now, zone);
}

/** Read the current store's weekly sales (call inside scope.run). Never throws; saved as shopify.weekSales and returned. */
async function run({ q, now = Date.now() } = {}) {
  const store = require('./store');
  const shopify = require('./shopify');
  const ask = q || ((doc, vars) => shopify.gql(doc, vars, { version: QL_VERSION }));
  const d = store.load();
  const zone = TZ.zoneOf(d.settings), p = plan(now, zone);
  try {
    const got = await fetch(ask, p);
    const by = summarise(got.rows, p);
    const out = { v: VERSION, ok: true, at: now, triedAt: now, weeks: p.weeks, start: p.start, from: p.first, until: p.today, lastWeek: keyPlus(p.monday, -7), rows: got.rows.length, calls: got.calls, variants: Object.keys(by).length, note: null, by };
    store.setShopify({ weekSales: out });
    console.log(`weeks: ${out.variants} variants, ${out.rows} rows, ${got.calls} ShopifyQL calls`);
    return out;
  } catch (e) {
    console.warn('weeks: weekly sales skipped:', e.message);
    const prev = d.shopify.weekSales;
    const out = prev && prev.ok && prev.v === VERSION ? { ...prev, triedAt: now, note: noteFor(e) } : { v: VERSION, ok: false, triedAt: now, note: noteFor(e) };
    store.setShopify({ weekSales: out });
    return out;
  }
}

/** The weekly data the engine reads (report opts.weekSales), or null. */
const forReport = (sh) => (sh && sh.weekSales && sh.weekSales.ok && sh.weekSales.by ? sh.weekSales : null);

module.exports = { VERSION, WEEKS, CHUNK_WEEKS, CAP, QL_VERSION, WEEKS_Q, qlFor, plan, split, parse, summarise, fetch, noteFor, due, run, forReport, WeeksError };
