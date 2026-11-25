'use strict';
/*
 * Weekly review (SW-043, LOGIC.md §5b). Once a day per store, a small snapshot of the headline numbers is saved in
 * <store folder>/snapshots.json (src/sidefile.js: atomic, .bak, never read as empty), so "this week vs last week"
 * compares what the page said then, not today's maths re-run on old rows.
 *
 *   snapshots.json = { basis: 'demo' | 'live', calc: '<engine rules>|<stock history at>|<order price basis>', days: { 'YYYY-MM-DD': snapshot } }
 *   snapshot = { at, src: 'day' | 'backfill', sold, lost, lostProfit, ranOut,          ← that store day (00:00–24:00)
 *                stillOut, excessValue, toReorder, orderToday, orderTodayValue,     ← at the end of that day
 *                lostBy: { variantId: ₹ } }                                         ← top 100 products by ₹ lost that day
 *
 * One rule for every snapshot: the report as of the store-midnight that ends the day (rows recorded by then, the
 * catalog's inactive flags as of then plus today's unit costs, Mark-ordered records made by then), period = that day.
 * A day is taken once the data reaches past its end (Shopify: the last good pull is after midnight; other sources:
 * now), on the first report or pull after that; the last 14 days are filled in when missing (first run, downtime).
 * Snapshots never mix demo and real data: a basis change (demo → live) starts them again; Clear and a demo load
 * forget them (server.js). Kept 400 days.
 * When the maths or the data under them change (calc: engine.CALC_VERSION, a new stock history rebuild, order prices
 * read again ex GST), the last 14 days are worked out again, so the panel and the daily chart agree (1.1.1, L2).
 */
const store = require('./store');
const engine = require('./engine');
const period = require('./period');
const onorder = require('./onorder');
const scope = require('./scope');
const { sideFile } = require('./sidefile');
const TZ = require('./tz');   // the store's time zone (SW-049): store days follow daylight saving
const weeks = require('./weeks');   // 1.3.0: weekly sales for confidence (LOGIC §4c)

const DAY = engine.DAY;
const KEEP_DAYS = 400;
const BACKFILL_DAYS = 14;
const TOP_LOST = 100;
const box = sideFile('snapshots.json');
const TODAY = ['Out now', 'Critical', 'Order now'];
/** The numbers compared, in page order. better: which way is good ('down', or null = neither). sum: added up over the
 *  week (flows); else the newest day's value (a state at the end of the week). */
const METRICS = [
  { k: 'lost', better: 'down', sum: true },
  { k: 'lostProfit', better: 'down', sum: true },
  { k: 'ranOut', better: 'down', sum: true },
  { k: 'stillOut', better: 'down', sum: false },
  { k: 'excessValue', better: 'down', sum: false },
  { k: 'toReorder', better: null, sum: false },
  { k: 'orderTodayValue', better: null, sum: false },
];

const basisOf = (d) => (d.source === 'demo' ? 'demo' : d.source === 'live' ? 'live' : null);
/** The file's content for the current data, or a fresh one when the data changed basis (demo → live) or is empty. */
function file() {
  const f = box.read(), b = basisOf(store.load());
  if (!b) return { basis: null, days: {} };
  if (f.basis !== b || !f.days || typeof f.days !== 'object') { f.basis = b; f.days = {}; }
  return f;
}
const dayKey = (t, zone) => engine.dayKey(t, zone);
/** What the snapshots were worked out on: engine rules, the stock history rebuild, the order price basis. */
const calcOf = (d) => [engine.CALC_VERSION, 'loss-1.4.7', (d.shopify && d.shopify.history && d.shopify.history.at) || '', (d.shopify && d.shopify.priceBasis) || '', lossPaceKey(d)].join('|');
/* 1.4.0 (LOGIC §21): the 12-month pace for long stock-outs' ₹ lost, from server.js (null without Shopify's 12 months) */
let lossPaceFn = () => null, lossPaceKey = () => '';
function useLossPace(fn, key) { lossPaceFn = fn; lossPaceKey = key || (() => ''); }
/** Calc changed → forget the last BACKFILL_DAYS days (whatever took them) so missing() takes them again. True if changed. */
function rebase(f, d, now = Date.now()) {
  const c = calcOf(d);
  if (f.calc === c) return false;
  const from = addDays(dayKey(now, TZ.zoneOf(d.settings)), -BACKFILL_DAYS);
  for (const k of Object.keys(f.days)) if (k >= from) delete f.days[k];
  f.calc = c;
  return true;
}
/** Store-day key → its start (UTC ms) in the store's zone (a 23- or 25-hour day at a daylight saving change). */
const startOf = (key, zone) => TZ.fromLocal(Date.parse(`${key}T00:00:00Z`), zone);
const endOf = (key, zone) => startOf(addDays(key, 1), zone);
const addDays = (key, n) => new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** The catalog at time t: inactive flags as they stood then (period.catalogAsOf), plus today's unit cost (profit lost). */
function catalogAt(catalog, t) {
  const out = period.catalogAsOf(catalog, t);
  for (const [id, c] of Object.entries(catalog || {})) {
    if (!c || !(+c.cost > 0)) continue;
    out[id] = { ...(out[id] || {}), cost: +c.cost };
  }
  return out;
}

/** One store day's snapshot, worked out from the rows (pure apart from its inputs). */
function compute(d, key, oo = {}, at = Date.now()) {
  const off = TZ.zoneOf(d.settings), t0 = startOf(key, off), t1 = endOf(key, off);
  const rows = period.asOf(d.stock, d.orders, t1);
  const onOrder = Object.fromEntries(Object.entries(oo || {}).filter(([, v]) => v && +v.at <= t1));
  const r = engine.report(rows.stock, rows.orders, d.settings, { now: t1, from: t0, catalog: catalogAt(d.catalog, t1), onOrder, weekSales: weeks.forReport(d.shopify), ...(lossPaceFn(d) || {}) });
  const t = r.totals;
  /* L6 (1.3.0): movers on the headline's part (lostCounted), the same ₹ as the weekly total; estimates never show as movers */
  const lostBy = Object.fromEntries(r.products.filter((p) => p.lostCounted > 0).sort((a, b) => b.lostCounted - a.lostCounted).slice(0, TOP_LOST).map((p) => [String(p.id), p.lostCounted]));
  return {
    at, src: 'day', sold: t.sold, lost: t.lost, lostProfit: t.lostProfit, ranOut: r.stockouts.filter((s) => !s.notSelling && s.start >= t0 && s.start < t1).length,
    stillOut: t.stillOut, excessValue: t.excessValue, toReorder: t.orderToday + t.orderWeek, orderToday: t.orderToday,
    orderTodayValue: r.reorder.filter((p) => TODAY.includes(p.status)).reduce((s, p) => s + p.orderValue, 0), lostBy,
  };
}

/** Store days still to take, oldest first: the last 14 complete days whose end the data has reached, from the first
 *  day with any row, and not yet taken. */
function missing(d, f, now = Date.now()) {
  const off = TZ.zoneOf(d.settings);
  const until = d.shopify && d.shopify.lastSync ? Math.min(now, d.shopify.lastSync) : now;   // Shopify: what the last good pull covers
  let first = Infinity;
  for (const x of d.stock) if (x.t < first) first = x.t;
  for (const x of d.orders) if (x.t < first) first = x.t;
  if (!Number.isFinite(first)) return [];
  const today = dayKey(now, off), out = [];
  for (let i = BACKFILL_DAYS; i >= 1; i--) {
    const key = addDays(today, -i), t1 = endOf(key, off);
    if (t1 <= first || t1 > until || f.days[key]) continue;
    out.push(key);
  }
  return out;
}

function prune(f, today) {
  const oldest = addDays(today, -KEEP_DAYS);
  for (const k of Object.keys(f.days)) if (k < oldest) delete f.days[k];
}

/** Take every missing snapshot for the current store. One day per turn of the event loop (a big store's report takes a
 *  while); one run per store at a time. Resolves to the keys taken. Never throws (logged). */
const running = new Map();
function catchUp(now = Date.now()) {
  const id = scope.current() || '';
  if (running.has(id)) return running.get(id);
  const p = (async () => {
    const taken = [];
    try {
      const d = store.load(), f = file();
      if (!f.basis) return taken;
      if (rebase(f, d, now)) box.write(f);
      const want = missing(d, f, now);
      if (!want.length) return taken;
      const yesterday = addDays(dayKey(now, TZ.zoneOf(d.settings)), -1);
      for (const key of want) {
        if (taken.length) await new Promise((ok) => setImmediate(ok));
        const cur = store.load(), ff = file();
        if (ff.basis !== f.basis || ff.calc !== f.calc || ff.days[key]) continue;   // data changed meanwhile, or taken
        ff.days[key] = { ...compute(cur, key, onorder.all(), Date.now()), src: key === yesterday ? 'day' : 'backfill' };
        prune(ff, dayKey(now, TZ.zoneOf(cur.settings)));
        box.write(ff);
        taken.push(key);
      }
    } catch (e) { console.warn(`weekly snapshot${id ? ` (store ${id})` : ''}: ${e.message}`); }
    return taken;
  })().finally(() => running.delete(id));
  running.set(id, p);
  return p;
}

/** Forget every snapshot of the current store (Clear, a new demo). */
function clear() { const f = box.read(); if (f.days && Object.keys(f.days).length) box.write({ basis: null, days: {} }); }

/**
 * This week vs last week, from the snapshots. upTo = the newest store day on or before yesterday that has a snapshot;
 * this week = upTo and the 6 days before; last week = the 7 days before those. Flows (sold, lost, profit lost, ran out)
 * are summed over the days the week has; states (still out, overstock, to reorder, order today) are the newest day's.
 * A week counts as complete only with all 7 days. Movers: products whose ₹ lost changed most between the two weeks.
 */
function summary(days, today, names = () => null) {
  const keys = Object.keys(days || {}).filter((k) => k < today).sort();
  if (!keys.length) return { ready: false };
  const upTo = keys[keys.length - 1];
  const weekOf = (end) => Array.from({ length: 7 }, (_, i) => addDays(end, -i)).filter((k) => days[k]);
  const thisDays = weekOf(upTo), prevEnd = addDays(upTo, -7), prevDays = weekOf(prevEnd);
  const total = (list) => {
    if (!list.length) return null;
    const o = {};
    for (const m of METRICS) {
      if (m.sum) {
        const vals = list.map((k) => days[k][m.k]);
        o[m.k] = vals.every((v) => v == null) ? null : vals.reduce((s, v) => s + (+v || 0), 0);
      } else {
        o[m.k] = days[list[0]][m.k] ?? null;   // the newest day the week has
      }
    }
    o.sold = list.reduce((s, k) => s + (+days[k].sold || 0), 0);
    return o;
  };
  const tw = total(thisDays), lw = total(prevDays);
  const lostOf = (list) => { const m = new Map(); for (const k of list) for (const [id, v] of Object.entries(days[k].lostBy || {})) m.set(id, (m.get(id) || 0) + v); return m; };
  const a = lostOf(thisDays), b = lostOf(prevDays);
  const movers = prevDays.length ? [...new Set([...a.keys(), ...b.keys()])]
    .map((id) => ({ id, name: names(id) || id, now: a.get(id) || 0, before: b.get(id) || 0 }))
    .map((x) => ({ ...x, change: x.now - x.before })).filter((x) => x.change)
    .sort((x, y) => Math.abs(y.change) - Math.abs(x.change) || y.now - x.now || String(x.id).localeCompare(String(y.id))).slice(0, 5) : [];
  return {
    ready: true, upTo, from: addDays(upTo, -6), prevFrom: addDays(prevEnd, -6), prevTo: prevEnd,
    days: thisDays.length, prevDays: prevDays.length, complete: thisDays.length === 7 && prevDays.length === 7,
    thisWeek: tw, lastWeek: lw, movers, metrics: METRICS.map(({ k, better, sum }) => ({ k, better, sum })),
  };
}

/** Product names for the movers: the catalog first (Shopify), else the newest stock row; same form as the report. */
function nameMap(d) {
  const m = new Map();
  const nm = (product, variant, sku) => [product, variant && variant !== 'Default Title' ? variant : ''].filter(Boolean).join(' · ') || sku || '';
  for (const x of d.stock) { const v = nm(x.product, x.variant, x.sku); if (v) m.set(String(x.variantId), v); }
  for (const [id, c] of Object.entries(d.catalog || {})) { const v = nm(c.product, c.variant, c.sku); if (v) m.set(String(id), v); }
  return (id) => m.get(String(id)) || null;
}

/** The current store's review, as of now. */
function current(now = Date.now()) {
  const d = store.load(), f = file();
  return summary(f.days, dayKey(now, TZ.zoneOf(d.settings)), nameMap(d));
}

const money = (x) => {
  const v = Math.round(+x || 0), a = Math.abs(v), inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
  if (a >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  return `₹${inr.format(v)}`;
};
/** One line for the morning digest (LOGIC.md §17): sales lost and stock-outs this week vs last week, or null. */
function digestLine(s) {
  if (!s || !s.ready || !s.thisWeek || !s.lastWeek) return null;
  const a = s.thisWeek, b = s.lastWeek;
  const lost = a.lost === b.lost ? `${money(a.lost)} lost to stock-outs, same as last week`
    : `${money(a.lost)} lost to stock-outs, ${a.lost > b.lost ? 'up' : 'down'} from ${money(b.lost)} last week`;
  return `This week: ${lost} · ${a.ranOut} stock-out${a.ranOut === 1 ? '' : 's'} (${b.ranOut} the week before).`;
}

/** GET /api/review → the review (taking any missing snapshot first). Returns { code, body } or null when not ours. */
async function handle(req, url) {
  if (url.pathname !== '/api/review') return null;
  if (req.method !== 'GET') return { code: 405, body: { ok: false, error: 'Use GET' } };
  await catchUp();
  return { code: 200, body: { ok: true, ...current() } };
}

module.exports = { useLossPace, compute, missing, catchUp, calcOf, rebase, clear, summary, current, digestLine, handle, catalogAt, nameMap, METRICS, KEEP_DAYS, BACKFILL_DAYS,
  FILE_NAME: box.name, all: () => box.read(), reset: box.reset };
