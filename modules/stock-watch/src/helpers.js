'use strict';
/*
 * Decision helpers on top of engine.report(). Pure functions, no I/O (LOGIC.md §15).
 *   SW-024  why sentence, run-out and order-by dates, still-out cost per day
 *   SW-025  reorder CSV usable as a PO (filter + search respected, vendor, unit cost, variant ID)
 *   SW-026  Pause / Push lists for marketing
 *   SW-032  slow-seller "Decide" bucket
 * enrich(report, …) adds fields to the report rows; the engine's own numbers are never changed.
 */

const DAY = 864e5;
const TZ = require('./tz');   // the store's time zone (SW-049): every date here is a store-time date
const HOUR = 36e5;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ORDER_TODAY = ['Out now', 'Critical', 'Order now'];

/** ₹ in short form for sentences: ₹950, ₹18.7k, ₹3.25 L, ₹1.20 Cr. */
function money(x) {
  const v = Math.round(+x || 0), a = Math.abs(v);
  if (a >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  if (a >= 1e3) return `₹${String(Math.round(v / 100) / 10).replace(/\.0$/, '')}k`;
  return `₹${v}`;
}

/* zone = the store's time zone (TZ.zoneOf(settings)); numbers (minutes east of UTC) still work */
const local = (t, zone) => TZ.local(t, zone);
const localDay = (t, zone) => TZ.dayKey(t, zone);
/** Midnight at the start of the store day after t (ms). */
const nextDayStart = (t, zone) => TZ.nextDayStart(t, zone);
/** "Fri 22 Nov" in store time. */
function dayName(t, zone = TZ.DEFAULT_ZONE) { const d = local(t, zone); return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; }
/** "25 Nov" in store time. */
function dateShort(t, zone = TZ.DEFAULT_ZONE) { const d = local(t, zone); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; }

/** The user-facing status label (the same three the page shows; LOGIC.md §6). */
function statusLabel(s) {
  if (ORDER_TODAY.includes(s)) return 'Order today';
  if (s === 'Order this week') return 'This week';
  return s || '';
}
/** The Reorder tab a status belongs to: today | week | ordered | other. Mirrors group() in public/app.js. */
const tabOf = (s) => (ORDER_TODAY.includes(s) ? 'today' : s === 'Order this week' ? 'week' : s === 'Ordered' ? 'ordered' : 'other');

/**
 * SW-024: why a row is where it is, in one plain sentence, plus the dates behind it.
 *   p: a product row from engine.report(); S: settings; now: ms; outSince: start of the open stock-out (ms) or null.
 * Returns { why, runsOut, orderBy, outSince, costPerDay }.
 *   runsOut  = now + days left; orderBy = runsOut − (lead + safety) days, following the status (LOGIC.md §15a):
 *   Order today rows (Out now / Critical / Order now) → now ("today"); any other row → the next store day at the earliest.
 *   costPerDay (out of stock only) = sales per day × average price paid.
 *   outLost = this open stock-out's ₹ lost; without it the sentence leaves ₹ out (the Sales lost column has the period's).
 */
/** LOGIC.md §4c: an open stock-out past 30 days (1.3.0: or lead + buffer + 14 when longer) with nothing marked ordered. */
const NOT_RESTOCKED_WHY = 'Out 30+ days, not restocked';
const notRestockedWhy = (days = 30) => `Out ${days}+ days, not restocked`;
/** §6 (1.3.0): a website allocation the warehouse tops up. Warehouse stock isn't in Shopify, so no reorder is sized. */
const ALLOCATION_STATUS = 'Top-up from warehouse';
const allocationWhy = (level) => `Shopify shows a website allocation (~${level} pcs, refilled from the warehouse). Warehouse stock isn’t in Shopify, so we can’t size a reorder: check the warehouse.`;
/** §4c G26 (1.3.0): the evidence behind the confidence, "sold in 10 of 25 weeks" (null when it came from units). */
const weeksText = (p) => (p && p.weeksLive ? `sold in ${p.weeksSold || 0} of ${p.weeksLive} weeks` : null);
/** §3 floor (1.3.0): a product out the whole time we hold, priced from Shopify's 26 weeks before. */
const counted = (p) => (p.confidence === 'high' || p.confidence === 'medium') && !p.notRestocked && !p.allocation && (p.floorPerDay == null || p.lossPace != null);
/** ₹ a day a stock-out costs: the money-missed pace (1.4.3: §21's expected pace × its price when the 12 months are read), else
 *  the sales rate (or the 26-week floor) × the average price paid (LOGIC §15a) */
const costADay = (p) => Math.round(p.lossPace != null ? (+p.lossPace || 0) * (+p.lossPrice || +p.price || 0) : (+p.perDay || +p.floorPerDay || 0) * (+p.price || 0));
function why(p, S, now, outSince = null, outLost = null) {
  const off = TZ.zoneOf(S), safety = +S.safetyDays || 0;
  const lead = +(p.leadDays ?? S.leadDays) || 0, assumed = p.leadDays == null ? ' (assumed)' : '';   // the supplier's lead time when set (SW-040); 1.3.0: the store default is a guess, say so
  const res = { why: '', runsOut: null, orderBy: null, outSince: null, costPerDay: 0 };
  if (p.status === 'Inactive') { res.why = 'Archived or not tracked'; return res; }
  if (p.status === ALLOCATION_STATUS && p.allocation) {
    res.why = allocationWhy(p.allocation.level);
    if (p.stock != null && p.stock <= 0) { res.outSince = outSince; res.costPerDay = costADay(p); }
    return res;
  }
  if (p.status === 'Ordered' && p.onOrder && p.onOrder.eta) { res.why = `Ordered · lands ${dateShort(p.onOrder.eta, off)}`; return res; }
  if (p.stock == null) { res.why = 'No stock data'; return res; }
  if (p.stock <= 0) {
    res.outSince = outSince;
    res.costPerDay = costADay(p);
    const h = outSince != null ? Math.max(0, now - outSince) / HOUR : null;
    /* SIMP-6: out at the first stock record we have → it was out before then too; we don't know how long */
    const len = h == null ? '' : p.historyFrom != null && outSince <= p.historyFrom ? ` since before ${dateShort(p.historyFrom, off)}`
      : Math.round(h) < 24 ? ` ${Math.max(1, Math.round(h))} h` : ` ${Math.round(h / 24)} d`;
    const wk = weeksText(p);
    if (p.floorPerDay != null) res.why = `Out${len || ' since before our data'} · sold ${p.units26} in 26 w`;   // §3 floor (1.3.0)
    else res.why = `${p.notRestocked ? notRestockedWhy(p.nrDays) : `Out${len}${outLost > 0 ? ` · lost ${money(outLost)} this stock-out` : ''}`}${wk ? ` · ${wk}` : ''}`;   // §4c
    return res;
  }
  if (!(p.perDay > 0) || p.daysLeft == null) { res.why = 'No sales lately'; return res; }
  if (p.daysLeft > 365) { res.why = 'Over a year of stock'; return res; }
  res.runsOut = now + p.daysLeft * DAY;
  res.orderBy = ORDER_TODAY.includes(p.status) ? now : Math.max(nextDayStart(now, off), res.runsOut - (lead + safety) * DAY);
  const when = (t) => (localDay(t, off) === localDay(now, off) ? 'today' : dayName(t, off));
  res.why = `Runs out ${when(res.runsOut)} · order by ${when(res.orderBy)} · supplier takes ${lead} d${assumed}`;
  return res;
}

/**
 * SW-026: which marketing list a row is on.
 *   pause: out of stock now, or fewer days left than the lead time (it can't be refilled in time)
 *   push:  overstocked (LOGIC.md §7c), ranked by ₹ stuck
 * Inactive (archived / untracked) and no-stock-data rows are on neither.
 */
function mktList(p, S) {
  if (p.status === 'Inactive' || p.stock == null) return null;
  if (p.allocation && p.stock > 0) return null;   // 1.4.6: refilled a few pieces at a time: days left says nothing, don't pause the ads
  if (p.stock <= 0 || (p.daysLeft != null && p.daysLeft < (+(p.leadDays ?? S.leadDays) || 0))) return 'pause';
  if (p.overstock) return 'push';
  return null;
}

/** Text for "back in stock" on the Pause list: the marked order's ETA (SW-012) when there is one. */
function backIn(p, S, now) {
  const off = TZ.zoneOf(S);
  if (p.onOrder && p.onOrder.eta) return p.onOrder.late ? `Late · was due ${dateShort(p.onOrder.eta, off)}` : `Lands ${dateShort(p.onOrder.eta, off)}`;
  if (p.status === 'Slow seller' && !(p.orderQty > 0)) return 'Slow seller · not reordered';   // not on the reorder list, so no date
  return `Not ordered · earliest ${dateShort(now + (+(p.leadDays ?? S.leadDays) || 0) * DAY, off)}`;
}

/**
 * SW-032: a slow seller's decision.
 *   slow + out of stock → kind 'drop' ("Don't reorder?"), value = ₹ lost in the period
 *   slow + in stock     → kind 'clear' ("Clear"), value = stock × unit cost (price when no cost)
 */
function decideKind(p) {
  if (p.status !== 'Slow seller' || p.stock == null) return null;
  if (p.stock <= 0) return { kind: 'drop', value: Math.round(+p.lost || 0) };
  return { kind: 'clear', value: Math.round(p.stock * (+p.cost || +p.price || 0)) };
}
/** Sales changed enough to ask again: the rate moved more than 50% from when it was decided.
 *  A floor of 0.1/day stops one stray sale on a product that sold nothing from bringing it back. */
const DECIDE_CHANGE = 0.5, DECIDE_FLOOR = 0.1;
function salesChanged(base, perDay) { return Math.abs((+perDay || 0) - (+base || 0)) > DECIDE_CHANGE * Math.max(+base || 0, DECIDE_FLOOR); }
const DECISIONS = ['keep', 'drop', 'clear'];

/**
 * Add the helper fields to a report (mutates and returns it).
 *   rows: why, runsOut, orderBy, outSince, costPerDay, mkt ('pause' | 'push' | null), backIn
 *   totals: stillOutPerDay, pause, pauseReorder, pauseSlow, push, pushValue, decide, decided
 *   report.decide: [{ id, kind, value, decision }] slow sellers still to decide (hidden ones left out), biggest ₹ first
 *   report.decided: the hidden ones, so a decision can be undone
 *   rates: Map id → sales per day on the saved settings, for the hide check while trial values are on (LOGIC.md §15d);
 *          null → the report's own rates
 */
function enrich(r, { decisions = {}, rates = null } = {}) {
  const S = r.settings, now = r.generatedAt;
  const open = new Map();
  for (const s of r.stockouts || []) if (s.open) open.set(String(s.id), s);
  for (const p of [...r.products, ...(r.reorder || [])]) {
    if (p.why !== undefined) continue;   // reorder rows are the same objects as product rows
    const o = open.get(String(p.id));
    Object.assign(p, why(p, S, now, o ? o.start : null, o ? o.lost : null));
    p.mkt = mktList(p, S);
    p.backIn = p.mkt === 'pause' ? backIn(p, S, now) : null;
  }
  const out = r.products.filter((p) => p.stock != null && p.stock <= 0 && p.status !== 'Inactive');
  const pause = r.products.filter((p) => p.mkt === 'pause'), push = r.products.filter((p) => p.mkt === 'push');
  const decide = [], decided = [];
  for (const p of r.products) {
    const k = decideKind(p); if (!k) continue;
    const rec = Object.hasOwn(decisions, String(p.id)) ? decisions[String(p.id)] : null;
    const item = { id: p.id, ...k, decision: rec && DECISIONS.includes(rec.d) ? rec.d : null };
    if (item.decision && !salesChanged(rec.base, rates ? rates.get(String(p.id)) : p.perDay)) decided.push(item); else decide.push(item);
  }
  decide.sort((a, b) => b.value - a.value); decided.sort((a, b) => b.value - a.value);
  /* L3 (1.3.0): "still out, costing ₹X/day" counts what the headline counts (High / Medium, not 30+ d not restocked, not a
     website allocation or a floor rate); the rest is apart, as ₹ lost is (LOGIC.md §15a) */
  Object.assign(r.totals, {
    stillOutPerDay: out.filter(counted).reduce((s, p) => s + (p.costPerDay || 0), 0),
    stillOutPerDayApart: out.filter((p) => !counted(p)).reduce((s, p) => s + (p.costPerDay || 0), 0),
    stillOutCounted: out.filter((p) => counted(p) && p.costPerDay > 0).length,
    pause: pause.length,
    pauseReorder: pause.filter((p) => p.orderQty > 0).length,
    pauseSlow: pause.filter((p) => p.status === 'Slow seller').length,
    push: push.length,
    pushValue: push.reduce((s, p) => s + (p.excessValue || 0), 0),
    decide: decide.length, decided: decided.length,
  });
  r.decide = decide; r.decided = decided;
  require('./budget').annotate(r);   // SW-041: profit kept per ₹ on every reorder row (LOGIC.md §6d)
  return r;
}

/** The product drawer (engine.productDetail): the same why sentence and lists for its one row. */
function enrichDetail(d, S, now) {
  const p = d && d.product; if (!p) return d;
  const o = (d.stockouts || []).find((s) => s.open);
  Object.assign(p, why(p, S, now, o ? o.start : null, o ? o.lost : null));
  p.mkt = mktList(p, S); p.backIn = p.mkt === 'pause' ? backIn(p, S, now) : null;
  return d;
}

/** Marketing list order: Pause = out now first, then fewest days left, then most ₹/day; Push = most ₹ stuck. */
function mktSort(rows, kind) {
  const v = (p) => (+p.perDay || 0) * (+p.price || 0);
  return rows.slice().sort(kind === 'push'
    ? (a, b) => (b.excessValue || 0) - (a.excessValue || 0)
    : (a, b) => (a.stock <= 0 ? -1 : a.daysLeft ?? 1e9) - (b.stock <= 0 ? -1 : b.daysLeft ?? 1e9) || v(b) - v(a));
}

/* ---------- SW-025: reorder CSV as a PO ---------- */

/** Vendor per variant: Shopify's product.vendor from the newest stock row that has one, or the catalog when there is one. */
function vendorMap(stock = [], catalog = null) {
  const m = Object.create(null), seen = Object.create(null);   // no prototype: a variant ID "constructor" is just a key (critic r2 S1)
  for (const r of stock) if (r && r.vendor && !(seen[r.variantId] > r.t)) { m[String(r.variantId)] = String(r.vendor); seen[r.variantId] = r.t; }
  if (catalog && typeof catalog === 'object') for (const [id, c] of Object.entries(catalog)) if (c && c.vendor) m[String(id)] = String(c.vendor);
  return m;
}

/**
 * Reorder → Ordered tab (LOGIC.md §6b, §16): every open purchase order, whatever the status: one that covers the need
 * ("Ordered"), a part order (still in Order today), a late one and one landing too late to count. Late first (oldest
 * due date first), then by landing date. `products` = report.products (an OK product can still have stock on order).
 */
const onOrderRows = (products) => products.filter((p) => p.onOrder)
  .sort((a, b) => (b.onOrder.late - a.onOrder.late) || a.onOrder.eta - b.onOrder.eta);
/** What the warehouse needs: open orders, how many are late, how many land in the next 7 days, the next landing date. */
function onOrderSummary(products, now) {
  const rows = onOrderRows(products), due = rows.filter((p) => !p.onOrder.late);
  return {
    lines: rows.length, late: rows.length - due.length,
    week: due.filter((p) => p.onOrder.eta <= now + 7 * DAY).length,
    pcs: rows.reduce((s, p) => s + p.onOrder.remaining, 0),
    next: due.length ? due[0].onOrder.eta : null,
  };
}

/** The Reorder tab's rows: tab filter (today | week | ordered | all) and search over name and SKU, as on the page.
 *  "ordered" = every open order (onOrderRows), so pass the report's products for it. */
function reorderRows(reorder, { filter = 'all', q = '' } = {}) {
  const f = ['today', 'week', 'ordered'].includes(filter) ? filter : 'all', s = String(q || '').toLowerCase().trim();
  const list = f === 'ordered' ? onOrderRows(reorder) : reorder;
  return list.filter((p) => (f === 'all' || f === 'ordered' || tabOf(p.status) === f) && (!s || `${p.name} ${p.sku}`.toLowerCase().includes(s)));
}

const PO_HEAD = ['Vendor', 'Product', 'SKU', 'Variant ID', 'Order qty', 'Unit cost', 'Order value', 'Status', 'Why', 'Order by', 'Stock now', 'Sells per day', 'Days left', 'Sales lost (₹)', 'Confidence', 'Not restocked 30+ d (₹)', 'Shopify admin link', 'Website link'];
/**
 * Lines (header first) for the PO CSV. Same rows and order as the page, grouped by vendor (A–Z, unknown last)
 * so each supplier's lines sit together. Unit cost is blank when unknown; Order value then uses price (LOGIC.md §6).
 */
function poLines(r, { filter, q, vendors = {}, keep = null } = {}) {   // keep(p): an extra row filter (SW-040 supplier, SW-041 budget)
  const off = TZ.zoneOf(r.settings);
  const rows = reorderRows(filter === 'ordered' ? r.products : r.reorder, { filter, q }).filter((p) => !keep || keep(p));
  const vOf = (p) => (Object.hasOwn(vendors, String(p.id)) ? String(vendors[String(p.id)] || '') : '');
  const sorted = rows.map((p, i) => [p, i]).sort(([a, i], [b, j]) => {
    const x = vOf(a), y = vOf(b);
    if (x !== y) return !x ? 1 : !y ? -1 : x.localeCompare(y);
    return i - j;
  }).map(([p]) => p);
  return [PO_HEAD, ...sorted.map((p) => [
    vOf(p), p.name, p.sku, String(p.id), p.orderQty, p.cost != null ? p.cost : '', p.orderValue, statusLabel(p.status), p.why || '',
    p.orderBy ? localDay(p.orderBy, off) : '', p.stock, p.perDay, p.daysLeft ?? '', p.lost,
    p.confidence ? p.confidence[0].toUpperCase() + p.confidence.slice(1) : '', p.lostNotRestocked || 0,   // §4c
    p.adminUrl || '', p.webUrl || (p.webUrl === null ? 'Not on website' : ''),   // 1.4.0 (LOGIC §19)
  ])];
}

/** One CSV cell. Text starting with = + - @ tab or CR gets a leading ' so a spreadsheet never runs it as a formula. */
function csvCell(x) {
  let s = String(x ?? '');
  if (typeof x === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
const csvText = (lines, cell = csvCell) => '﻿' + lines.map((l) => l.map(cell).join(',')).join('\n');

/** File name date in the store's time zone. */
const fileDate = (now, zone = TZ.DEFAULT_ZONE) => localDay(now, zone);

module.exports = {
  NOT_RESTOCKED_WHY, notRestockedWhy, ALLOCATION_STATUS, allocationWhy, weeksText, money, dayName, dateShort, statusLabel, tabOf, why, mktList, backIn, mktSort, decideKind, salesChanged, DECIDE_CHANGE, DECIDE_FLOOR, DECISIONS,
  enrich, enrichDetail, vendorMap, reorderRows, onOrderRows, onOrderSummary, poLines, PO_HEAD, csvCell, csvText, fileDate,
};
