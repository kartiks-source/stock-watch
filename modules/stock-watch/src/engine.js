'use strict';
/*
 * Stock-out engine. Pure functions, no I/O.
 *
 * Inputs (normalised rows):
 *   stock  { t, variantId, sku, product, variant, before, now, price }   one row per stock change
 *   orders { t, order, variantId, sku, qty, price, ordered?, returned?, refund?, cancelled? }   one row per order line:
 *            qty = units kept (qty 0 = fully refunded or a cancelled order); ordered = Shopify's quantity; returned = units
 *            refunded or cancelled, refund = their ₹ ex GST, cancelled = units cancelled before shipping (SW-064, 1.1.3)
 *   opts.reversals (Shopify, 1.1.5) { id, t, order, variantId, qty, value, kind }: cancellations / refunds dated when
 *            they happened; Cancel/refund % and totals.shopifyNet count them by that date (LOGIC.md §9e)
 *
 * Output: report() → totals, daily sold vs lost, reorder list, every stock-out, per-product summary.
 */

const { roundOrder } = require('./supplier-rules');   // SW-040: MOQ and case pack (LOGIC.md §6c)
const HOUR = 36e5;
const DAY = 864e5;
const TZ = require('./tz');   // the store's time zone (SW-049)

const num = (x) => (Number.isFinite(+x) ? +x : 0);
/** Units of demand on a line (LOGIC.md §What counts as a sale, 1.1.3): units kept + units returned after the sale. A return
 *  was still a sale the shelf had to cover (the unit comes back as a stock increase); a cancellation was not. */
const demandQty = (o) => num(o.qty) + Math.max(0, num(o.returned) - num(o.cancelled));
/** obj[key] only when it is obj's own key: a variant ID like "constructor" never reads Object.prototype (critic r2 S1). */
const own = (obj, key) => (obj && typeof obj === 'object' && Object.hasOwn(obj, key) ? obj[key] : undefined);
const round = (x, d = 0) => { const p = 10 ** d; return Math.round(x * p) / p; };
/** Smallest and largest `key(x)` in one loop. Never spread a big array into Math.min/max: past ~120k
 *  items that throws "Maximum call stack size exceeded". Empty → { min: Infinity, max: -Infinity }. */
function minMax(arr, key = (x) => x) {
  let min = Infinity, max = -Infinity;
  for (const x of arr) { const v = key(x); if (v < min) min = v; if (v > max) max = v; }
  return { min, max };
}

/** Store calendar day (YYYY-MM-DD) for a UTC ms timestamp. zone = the store's time zone (src/tz.js, SW-049: an IANA
 *  name with daylight saving, or minutes east of UTC; India = 330). */
function dayKey(t, zone) { return TZ.dayKey(t, zone); }
function localHour(t, zone) { return TZ.hour(t, zone); }
/** Start of the store's clock hour after t, as a UTC timestamp. */
function nextLocalHour(t, zone) { return TZ.nextHour(t, zone); }

/**
 * How sales spread over the day: 24 weights with mean 1, from the order lines (plus one per hour
 * so quiet hours never count as zero). A stock-out at 2 pm costs more than one at 4 am.
 */
function hourProfile(orders, offMin) {
  const b = new Array(24).fill(1);
  for (const o of orders) b[localHour(o.t, offMin)] += demandQty(o);
  const mean = b.reduce((a, x) => a + x, 0) / 24;
  return b.map((x) => x / mean);
}

/** Selling hours in [a, b): clock hours weighted by the profile. Also returns the split by local day. */
function sellingHours(a, b, profile, offMin) {
  let total = 0; const byDay = {};
  for (let t = a; t < b;) {
    const next = Math.min(b, nextLocalHour(t, offMin));
    const w = ((next - t) / HOUR) * profile[localHour(t, offMin)];
    total += w; const k = dayKey(t, offMin); byDay[k] = (byDay[k] || 0) + w;
    t = next;
  }
  return { total, byDay };
}

/** Stock just before change i: the row's own `before`; when that's blank (a CSV without the column, a Shopify
 *  variant made active again), the previous row's `now`. A blank never reads as 0 (LOGIC.md §2). */
const blank = (x) => x == null || (typeof x === 'string' && x.trim() === '');
const wasBefore = (changes, i) => (!blank(changes[i].before) || i === 0 ? num(changes[i].before) : num(changes[i - 1].now));

/**
 * Stock-out episodes from one product's stock changes (oldest first).
 * Out when stock drops to 0 or below; back when it rises above 0. One still open ends at `now`.
 * topUp = stock right after it came back.
 */
function episodes(changes, now) {
  const out = []; let open = null;
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i], was = wasBefore(changes, i), is = num(c.now);
    if (!open && is <= 0 && (was > 0 || out.length === 0)) open = { start: c.t };
    else if (open && is > 0) { out.push({ start: open.start, end: c.t, topUp: is, open: false, endSrc: c.src || null }); open = null; }
  }
  if (open) out.push({ start: open.start, end: now, topUp: 0, open: true });
  return out;
}

/**
 * Cut stock-outs at the times the variant couldn't be sold (archived, draft, untracked, deleted: LOGIC.md §1).
 * spells = [{from, to}] sorted, to may be Infinity (inactive now). The part before a spell ends there (not open,
 * no top-up); the part after it starts again when the variant came back, so a reactivated variant still at 0 is out.
 */
function cutBySpells(eps, spells) {
  if (!spells.length) return eps;
  const out = [];
  for (const e of eps) {
    let parts = [e];
    for (const s of spells) {
      const next = [];
      for (const p of parts) {
        if (s.to <= p.start || s.from >= p.end) { next.push(p); continue; }
        if (s.from > p.start) next.push({ start: p.start, end: s.from, topUp: 0, open: false, inactive: true });
        if (s.to < p.end) next.push({ ...p, start: s.to });
      }
      parts = next;
    }
    out.push(...parts);
  }
  return out;
}

/** How often the Shopify pull runs (server.js SYNC_MINUTES, default 2 hours): a stock row from a pull is stamped with the
 *  pull's time, so the change it shows happened up to this long before (LOGIC.md §2). */
const SYNC_MINUTES = 120;
/** First index i with changes[i].t >= t (changes sorted oldest first). */
function firstAtOrAfter(changes, t) {
  let lo = 0, hi = changes.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (changes[m].t < t) lo = m + 1; else hi = m; }
  return lo;
}
/** An oversell (1.3.0, LOGIC.md §2): the stock rows log the shelf going below 0 for this line: a row with stock before ≤ 0
 *  and stock after lower, in the line's hour (rebuilt rows are stamped at the hour's start) or up to one pull later
 *  (Shopify rows are stamped at the pull). Such a sale was taken at 0 (a checkout race on a "deny" variant), so it says
 *  nothing about stock being there. */
function oversold(o, changes, syncMs) {
  for (let i = firstAtOrAfter(changes, o.t - HOUR); i < changes.length && changes[i].t <= o.t + syncMs; i++) {
    const was = wasBefore(changes, i);
    if (was <= 0 && num(changes[i].now) < was) return true;
  }
  return false;
}

/**
 * A sale proves there was stock (M1, LOGIC.md §2): an out spell starts no earlier than the last order line inside it.
 * Lines in the spell's first hour don't count (the sale that emptied the shelf, or a stock row stamped late).
 * Rebuilt history can miss a refill (Aspen: 1 → 0 on 2 Oct, then 2 sold on 31 Oct). Nobody was turned away before that sale.
 * Two exceptions (1.3.0):
 *   - an oversell (oversold(): a logged drop below 0 for that line) proves nothing and is skipped (Nivaya: out a month,
 *     one order raced to −1, and the whole month was wiped);
 *   - a spell ended by a Shopify pull row (stamped at the pull, up to one pull interval after the restock): a sale in that
 *     last interval came after the restock, so it ends the spell at that sale instead of moving its start.
 * changes = the product's stock rows (oldest first); syncMs = the pull interval.
 */
function afterLastSale(eps, lines, changes = [], syncMs = SYNC_MINUTES * 60e3) {
  if (!lines.length || !eps.length) return eps;
  return eps.map((e) => {
    const lateFrom = !e.open && e.endSrc === 'shopify' ? e.end - syncMs : Infinity;
    let last = null, late = null;
    for (const o of lines) {
      if (!(o.t > e.start + HOUR && o.t < e.end && demandQty(o) > 0) || oversold(o, changes, syncMs)) continue;
      if (o.t >= lateFrom) { if (late == null || o.t < late) late = o.t; } else if (last == null || o.t > last) last = o.t;
    }
    let x = e;
    if (late != null) x = { ...x, end: late, endAtSale: true };
    if (last != null) x = { ...x, start: last, soldInside: true };
    return x;
  });
}

/** Stock-outs and inactive spells merged into one sorted list of times it couldn't be sold (for the sales rate). */
function unsellable(eps, spells, now) {
  const all = eps.map((e) => ({ start: e.start, end: e.end })).concat(spells.filter((s) => s.from < now).map((s) => ({ start: s.from, end: Math.min(now, s.to) })))
    .filter((x) => x.end > x.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const x of all) { const l = out[out.length - 1]; if (l && x.start <= l.end) l.end = Math.max(l.end, x.end); else out.push({ ...x }); }
  return out;
}

const overlap = (a, b, from, to) => Math.max(0, Math.min(b, to) - Math.max(a, from));

/** Sales per day while the product could be bought: units ÷ in-stock days, counting at least
 *  MIN_RATE_DAYS (and never more than the span measured). A product seen in stock for a few hours
 *  that sold 2 units is not "2 a day": with the old one-day floor that inflated ₹ lost on long
 *  stock-outs (Sammsara, 20 Nov 2026). rawDays = in-stock days before the floor. */
const MIN_RATE_DAYS = 7;
function demandPerDay(units, from, to, eps) {
  const outMs = eps.reduce((s, e) => s + overlap(e.start, e.end, from, to), 0);
  const rawDays = Math.max(0, (to - from - outMs) / DAY);
  const days = Math.max(rawDays, Math.min(MIN_RATE_DAYS, Math.max(1, (to - from) / DAY)));
  return { perDay: units / days, inStockDays: days, rawDays };
}

/** History the engine may look back over for a long stock-out (matches the store's retention, src/store.js). */
const KEEP_DAYS = 120;
/** Fewer in-stock days than this in the demand window and the window can't say what the product sells. */
const MIN_IN_STOCK_DAYS = 7;
/** Low data (LOGIC.md §3): a rate resting on fewer than LOW_UNITS units AND fewer than LOW_DAYS in-stock days is
 *  capped at units ÷ calendar days since the product's first sale, and can't make the product a best seller (A).
 *  Before: 2 units sold in the 17 h before a long stock-out read as 0.29 a day → ₹23,280 lost, ranked A. */
const LOW_UNITS = 5, LOW_DAYS = 14;
/** How sure ₹ lost is (LOGIC.md §4c, 1.2.0): units sold in the stretch the rate was measured on (rateUnits).
 *  high ≥ 10, medium 5–9, low ≤ 4. Low-confidence ₹ lost is an estimate, shown apart from the headline. */
const CONF_HIGH = 10, CONF_MEDIUM = 5;
const confidenceOf = (units) => (units >= CONF_HIGH ? 'high' : units >= CONF_MEDIUM ? 'medium' : 'low');
/** A stock-out still open after this many days with nothing marked ordered: its ₹ lost after day 30 is "not restocked"
 *  (likely dropped), shown apart from the headline (LOGIC.md §4c). With a PO marked it keeps counting. */
const NOT_RESTOCKED_DAYS = 30;
/** 1.3.0 (LOGIC.md §4c): the cutoff is never shorter than a reorder could take to land and sell: lead + buffer + 14 days. */
const notRestockedDays = (lead, safety) => Math.max(NOT_RESTOCKED_DAYS, (+lead || 0) + (+safety || 0) + 14);
/** 1.3.0 (LOGIC.md §4c, G26): confidence from Shopify's weekly sales (ShopifyQL, src/weeks.js): the share of the last full
 *  weeks the variant was live in that had a sale. High ≥ 44% (4 of 9 weeks), medium ≥ 22% (2 of 9), else low. A variant live
 *  under WEEKS_MIN_LIVE full weeks, or a store without the weekly data, keeps the units rule. */
const WEEKS_HIGH = 0.44, WEEKS_MEDIUM = 0.22, WEEKS_MIN_LIVE = 8, WEEK = 7 * DAY;
const confidenceOfWeeks = (sold, live) => (sold / live >= WEEKS_HIGH ? 'high' : sold / live >= WEEKS_MEDIUM ? 'medium' : 'low');
/** Full weeks of the weekly data a variant was live in (created before the week ended); null when either is unknown. */
function weeksLive(ws, createdAt) {
  if (!ws || !(ws.weeks > 0) || !Number.isFinite(+ws.start) || createdAt == null || !Number.isFinite(+createdAt)) return null;
  return Math.max(0, ws.weeks - Math.max(0, Math.floor((+createdAt - +ws.start) / WEEK)));
}
/** 1.3.0 (LOGIC.md §3): a product out the whole time we hold, with sales in Shopify's 26 weeks before: its floor rate is
 *  those units ÷ FLOOR_DAYS (a calendar pace, so a floor), and its ₹ lost goes to "not restocked". */
const FLOOR_DAYS = 182;
/** 1.3.0 (LOGIC.md §1, §6): a website allocation. Shopify's stock is a small allocation the warehouse tops up: 3+ stock
 *  increases in the last 14 days landing on the same level of at most 10 pcs, and every stock-out ended within 48 h. */
const ALLOC_DAYS = 14, ALLOC_REFILLS = 3, ALLOC_MAX_LEVEL = 10, ALLOC_MAX_GAP_H = 48;
const ALLOCATION_STATUS = 'Top-up from warehouse';
function allocationOf(changes, now) {
  const since = now - ALLOC_DAYS * DAY, at = new Map();
  let outAt = null, gap = 0;
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i], was = wasBefore(changes, i), is = num(c.now);
    if (is <= 0 && (was > 0 || i === 0)) outAt = c.t;
    if (is > was && c.t >= since && is > 0 && is <= ALLOC_MAX_LEVEL) at.set(is, (at.get(is) || 0) + 1);
    if (is > 0) { if (outAt != null && c.t >= since) gap = Math.max(gap, c.t - outAt); outAt = null; }
  }
  if (outAt != null) gap = Math.max(gap, now - outAt);   // still out: a warehouse that hasn't topped it up in 48 h isn't one
  let level = null, refills = 0;
  for (const [l, n] of at) if (n > refills || (n === refills && l > level)) { level = l; refills = n; }
  return refills >= ALLOC_REFILLS && gap < ALLOC_MAX_GAP_H * HOUR ? { level, refills } : null;
}
/** A product row's ₹ lost in the three buckets (rows from report()): counted (headline), estimate, notRestocked. */
const lostSplit = (p) => ({ counted: p.lostCounted || 0, estimate: p.lostEstimate || 0, notRestocked: p.lostNotRestocked || 0, allocation: p.lostAllocation || 0 });
/** Returns (SW-064, LOGIC.md §9e): a % only from 5 units ordered; 15%+ is "high". */
const RETURN_MIN_UNITS = 5, HIGH_RETURN_PCT = 15;
/** Cancelled or refunded units in the period, per variant (SW-064, LOGIC.md §9e).
 *  ordered = Σ the lines' `ordered` (Shopify's quantity_ordered) for orders placed in [from, now], cancelled orders
 *  included. With `reversals` (Shopify, 1.1.5): returned / value / cancelled = the reversal events dated in [from, now]
 *  (a refund on its refund date, a cancellation on its cancel date, whenever the order was placed), as Shopify's
 *  reports count them. Without (Flow / Sheet / CSV, a store not read again yet): the lines' own `returned`, by order date. */
function returnsOf(orders, from, reversals = null, now = Infinity) {
  const by = new Map();
  const get = (id) => { id = String(id); let x = by.get(id); if (!x) by.set(id, x = { ordered: 0, returned: 0, value: 0, cancelled: 0 }); return x; };
  for (const o of orders) {
    if (o.t < from || o.t > now || !(num(o.ordered) > 0)) continue;
    const x = get(o.variantId);
    x.ordered += num(o.ordered);
    if (Array.isArray(reversals)) continue;
    const back = Math.min(num(o.ordered), num(o.returned));
    x.returned += back; x.cancelled += Math.min(back, num(o.cancelled));
    x.value += o.refund != null ? num(o.refund) : back * num(o.price);
  }
  if (Array.isArray(reversals)) {
    for (const e of reversals) {
      if (!e || e.t < from || e.t > now || !(num(e.qty) > 0)) continue;
      const x = get(e.variantId);
      x.returned += num(e.qty); x.value += num(e.value);
      if (e.kind === 'cancel') x.cancelled += num(e.qty);
    }
  }
  return by;
}
const returnPct = (ordered, returned) => (ordered >= RETURN_MIN_UNITS ? round((returned / ordered) * 100, 1) : null);
/** A falling trend (product or store, ≤ PACE_DROP %) shows the order quantity at the last 14 days' pace too (§6). */
const PACE_DROP = -20;

/** Earliest t ≥ histFrom such that [t, to) holds `wantMs` of in-stock time (eps sorted, oldest first).
 *  histFrom when there isn't that much. */
function inStockStart(eps, histFrom, to, wantMs) {
  let need = wantMs, t = to;
  for (let i = eps.length - 1; i >= -1 && t > histFrom; i--) {
    const e = eps[i];
    const gapFrom = Math.max(histFrom, e ? e.end : -Infinity);          // in stock over [gapFrom, t)
    if (gapFrom < t) { if (t - gapFrom >= need) return t - need; need -= t - gapFrom; }
    t = e ? Math.min(t, e.start) : histFrom;
  }
  return histFrom;
}

/**
 * The sales rate a product's numbers rest on (LOGIC.md §3).
 *   window:   units ÷ in-stock days over [winFrom, now], the normal case.
 *   history:  under MIN_IN_STOCK_DAYS in stock in the window (a long stock-out): the most recent
 *             `wantDays` in-stock days since histFrom, so a best seller out for a month keeps its demand.
 *   before-out: no in-stock time since histFrom at all: the `wantDays` before the stock-out began.
 * Returns the lines the rate was measured on too, so the average price comes from the same sales.
 */
function demandRate(lines, eps, { winFrom, histFrom, now, wantDays, first = -Infinity }) {
  const measure = (a, b, hi = Infinity) => {        // orders in [a, hi); in-stock days over [a, b]
    const use = lines.filter((o) => o.t >= a && o.t < hi);
    const units = use.reduce((s, o) => s + demandQty(o), 0);
    return { ...demandPerDay(units, a, b, eps), units, lines: use, from: a };
  };
  const win = measure(winFrom, now);
  if (win.rawDays >= MIN_IN_STOCK_DAYS || histFrom >= winFrom) return { ...win, basis: 'window' };
  const start = inStockStart(eps, histFrom, now, wantDays * DAY);
  const hist = measure(start, now);
  if (hist.rawDays > 0) return { ...hist, basis: 'history' };
  const cur = eps[eps.length - 1];                    // out since before histFrom
  if (cur) {
    const a = Math.max(cur.start - wantDays * DAY, first);
    if (a < cur.start) { const pre = measure(a, cur.start, cur.start); if (pre.rawDays > 0) return { ...pre, basis: 'before-out' }; }
  }
  return { ...win, basis: 'window' };
}

/**
 * Trend, measured on demand rather than raw sales so a stock-out doesn't look like a slump.
 *   weeks: the last 8 rolling 7-day blocks ending now (oldest first): units sold and days out of stock.
 *   trendPct: sales per in-stock day in the last 14 days vs the 14 days before. null when there's
 *   too little to say (fewer than 6 units over those 28 days, or under 3 in-stock days in either half).
 *   since: when this product's data starts. Time before it is "no data", never "in stock, sold 0".
 *   trendNew: it was in stock for at least 7 of the earlier days and sold nothing, and has sold 3+ since.
 *   rateDelta: recent rate − earlier rate (units per in-stock day), when trendPct or trendNew is set.
 */
const TREND_MIN_UNITS = 6;
function trend(lines, eps, now, since = -Infinity) {
  const weeks = [], out0 = {};
  for (let w = 7; w >= 0; w--) {
    const a = now - (w + 1) * 7 * DAY, b = now - w * 7 * DAY;
    if (b <= since) { weeks.push({ units: null, outDays: 0 }); continue; }
    const units = lines.reduce((s, o) => s + (o.t >= a && o.t < b ? demandQty(o) : 0), 0);
    const out = eps.reduce((s, e) => s + overlap(e.start, e.end, Math.max(a, since), b), 0);
    weeks.push({ units, outDays: round(out / DAY, 1) });
  }
  const half = (a0, b) => {
    const a = Math.max(a0, since);
    if (b <= a) return { units: 0, inDays: 0, rate: 0 };
    const units = lines.reduce((s, o) => s + (o.t >= a && o.t < b ? demandQty(o) : 0), 0);
    const inDays = (b - a - eps.reduce((s, e) => s + overlap(e.start, e.end, a, b), 0)) / DAY;
    return { units, inDays, rate: inDays > 0 ? units / inDays : 0 };
  };
  const recent = half(now - 14 * DAY, now), before = half(now - 28 * DAY, now - 14 * DAY);
  let trendPct = null;
  if (recent.units + before.units >= TREND_MIN_UNITS && recent.inDays >= 3 && before.inDays >= 3 && before.rate > 0) {
    trendPct = round(((recent.rate - before.rate) / before.rate) * 100, 1);
  }
  const trendNew = before.inDays >= 7 && before.units === 0 && recent.units >= 3;
  /* rateDelta: change in sales per in-stock day behind the % (null when there's no trend to call) */
  const rateDelta = trendPct != null || trendNew ? round(recent.rate - before.rate, 3) : null;
  /* recentRate: sales per in-stock day over the last 14 days (null under 3 in-stock days), for the pace check (§6) */
  const recentRate = recent.inDays >= 3 ? recent.rate : null;
  Object.defineProperty(out0, 'recentRate', { value: recentRate, enumerable: false });
  return Object.assign(out0, { weeks, trendPct, trendNew, rateDelta });
}

/** The baseline to read a product's trend against: the median trend of all products that have one.
 *  Same measure (sales per in-stock day), so store-wide stock-outs don't drag it down. */
function storeTrend(products) {
  const v = products.map((p) => p.trendPct).filter((x) => x != null).sort((a, b) => a - b);
  if (v.length < 5) return null;
  const m = Math.floor(v.length / 2);
  return round(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2, 1);
}

/** 'up' | 'down' | 'flat' for a product's trend (null: no trend to call). Up / down only when the product's own %
 *  points that way AND it is 10+ points better / worse than the typical product (LOGIC.md §7d): a fall is never
 *  green, a rise never red (critic UI-1), and a store-wide fall doesn't turn every row red (critic S1). */
const TREND_BAND = 10;
function trendCall(pct, base) {
  if (pct == null) return null;
  const d = pct - (base == null ? 0 : base);
  return d >= TREND_BAND && pct > 0 ? 'up' : d <= -TREND_BAND && pct < 0 ? 'down' : 'flat';
}

/** Bumped whenever a rule that changes a number changes (LOGIC.md): saved daily snapshots made under another value
 *  are worked out again (src/weekly.js), so the weekly panel never mixes old and new maths. */
const CALC_VERSION = '1.3.0';   // 1.3.0: oversells and pull-timed restocks in afterLastSale (§2); 1.2.0: headline ₹ lost leaves out low-confidence estimates and 30+ d not restocked (§4c); 1.1.3: demand counts units returned after the sale (demandQty); 1.1.1: sale inside a stock-out moves its start (afterLastSale)

/** Order today rows (Out now, Critical, Order now) are one group, biggest ₹ of sales a day first (SIMP-2) */
const TODAY_STATUS = ['Out now', 'Critical', 'Order now'];

const STATUS = ['Out now', 'Critical', 'Order now', 'Order this week', 'Ordered', 'OK'];   // + ALLOCATION_STATUS (§6), never on the reorder list
/** Reorder status and quantity for one product. */
function plan({ stock, perDay, lead, cover, safety }) {
  const have = Math.max(0, stock);
  const daysLeft = perDay > 0 ? have / perDay : Infinity;
  const status = stock <= 0 ? 'Out now'
    : daysLeft <= 3 ? 'Critical'
      : daysLeft <= lead + safety ? 'Order now'
        : daysLeft <= lead + safety + 7 ? 'Order this week' : 'OK';
  const qty = Math.max(0, Math.ceil(perDay * (lead + cover + safety) - have));
  return { daysLeft, status, qty };
}

/**
 * A purchase order already placed ("Mark ordered", LOGIC.md §6b). rec = { qty, eta, at, by }.
 * Units received = stock increases recorded after `at` (from `before`, or the previous row's stock when blank: wasBefore); still to come = qty − received (done at 90% received).
 * It counts toward the plan while it's due (eta not past) and lands before the shelf empties,
 * or no later than an order placed today could (now + lead time), a day's grace either way since dates are whole
 * days. Past eta with units still to come = late.
 */
function onOrderNow(rec, changes, now, stock, perDay, lead) {
  if (!rec || !(num(rec.qty) > 0)) return null;
  const received = changes.reduce((s, c, i) => s + (c.t > num(rec.at) ? Math.max(0, num(c.now) - wasBefore(changes, i)) : 0), 0);
  const remaining = Math.max(0, Math.round(num(rec.qty) - received));
  if (received >= 0.9 * num(rec.qty)) return null;   // received (a short shipment of up to 10% counts as complete)
  const eta = num(rec.eta), late = eta < now;
  const outAt = perDay > 0 ? now + (Math.max(0, stock) / perDay) * DAY : Infinity;
  const counts = !late && eta <= Math.max(outAt, now + lead * DAY) + DAY;   // + 1 day: dates are whole days
  return { qty: num(rec.qty), remaining, eta, at: num(rec.at) || null, by: rec.by || null, late, counts };
}
/** plan() with an on-order record: units that count are added to stock; if that covers the need, status is "Ordered".
 *  Otherwise the row keeps its own status (Out now / Critical / Order now stay in Order today): units on the way
 *  don't change when the shelf empties, and a part order mustn't move a row off Order today (LOGIC.md §6b,
 *  critic L2 for an empty shelf, final r2 L1 for stock > 0). The order qty is only the extra still needed. */
function planWithOrder(args, oo) {
  const base = plan(args);
  if (!oo || !oo.counts) return base;
  const withPo = plan({ ...args, stock: Math.max(0, args.stock) + oo.remaining });
  const status = withPo.status === 'OK' ? 'Ordered' : base.status;
  return { daysLeft: base.daysLeft, status, qty: withPo.qty };
}

const DEFAULT_SETTINGS = {
  storeName: 'Demo Store',
  tzOffsetMin: 330,          // India
  leadDays: 7,               // supplier order → sellable
  coverDays: 30,             // a reorder should last this long
  safetyDays: 3,
  demandWindowDays: 28,
  smallTopUpDays: 7,         // a top-up under this many days of sales is "small"
  minPerDay: 0.2,            // slower sellers are left out of alerts
  allocationCheck: 1,        // 1.3.0: spot website allocations topped up from a warehouse (§6); 0 = off
};

/**
 * The whole report.
 * opts.days = range shown (7–90), opts.now = "now" (ms), opts.onOrder = { variantId: { qty, eta, at, by } } (§6b).
 */
function report(stock, orders, settings = {}, opts = {}) {
  const S = { ...DEFAULT_SETTINGS, ...settings };
  const now = opts.now || Date.now();
  const syncMs = (+opts.syncMinutes > 0 ? +opts.syncMinutes : SYNC_MINUTES) * 60e3;   // the pull interval (afterLastSale, §2)
  /* opts.from (e.g. the 1st of this month, see src/period.js) overrides opts.days; never more than 90 days back */
  const from = opts.from != null ? Math.min(now, Math.max(now - 90 * DAY, opts.from)) : now - Math.max(1, Math.min(90, Math.round(opts.days || 30))) * DAY;
  /* "N days" from the page = store-calendar days (src/period.js, 1.1.5): from = start of the day N − 1 days ago, days = N */
  const days = opts.from != null && opts.days ? Math.round(opts.days) : Math.max(1, Math.ceil((now - from) / DAY));
  const off = S.timeZone = TZ.zoneOf(S);   // SW-049: the store's IANA zone (old stores: their saved offset)
  S.tzOffsetMin = TZ.offsetAt(off, now);    // today's offset, for anything that still reads the minutes
  /* SW-064: returns come from every line; below, lines with no demand (a cancelled order, a line cancelled before shipping)
     drop out. ₹ sold and units sold count units kept (qty); the sales rate counts demand, returns included (demandQty) */
  const reversals = Array.isArray(opts.reversals) ? opts.reversals : null;
  const returns = returnsOf(orders, from, reversals, now);
  /* "Check against Shopify" (1.1.5, LOGIC.md §9e): Shopify's Net sales = gross − discounts of the orders placed in the
     period (cancelled ones included: a cancellation is a reversal on its own day) − reversals dated in the period */
  let gross = 0;
  for (const o of orders) if (o.t >= from && o.t <= now) gross += (num(o.ordered) > 0 ? num(o.ordered) : num(o.qty)) * num(o.price);
  orders = orders.filter((o) => demandQty(o) > 0);
  const profile = hourProfile(orders.filter((o) => o.t >= now - 60 * DAY), off);

  /* group by product (variant) */
  const P = new Map();
  const get = (id) => {
    if (!P.has(id)) P.set(id, { id, sku: '', product: '', variant: '', price: 0, changes: [], lines: [], stock: null });
    return P.get(id);
  };
  const stockSorted = stock.slice().sort((a, b) => a.t - b.t);
  for (const r of stockSorted) {
    const p = get(String(r.variantId));
    p.sku = r.sku || p.sku; p.product = r.product || p.product; p.variant = r.variant || p.variant; p.type = r.type || p.type || '';
    if (num(r.cost)) p.cost = num(r.cost);
    if (num(r.price)) p.price = num(r.price);
    p.changes.push(r); p.stock = num(r.now);
  }
  for (const o of orders) {
    const p = get(String(o.variantId));
    p.sku = p.sku || o.sku || '';
    p.lines.push(o);
  }
  for (const id of returns.keys()) get(id);   // a variant ordered in the period only on cancelled orders keeps its returns row
  /* current stock and attributes come from the Shopify catalog when there is one (SW-002, ADR-0010);
     stock rows are then history only. Inactive = archived, draft, untracked or deleted. */
  const cat = opts.catalog && typeof opts.catalog === 'object' ? opts.catalog : {};
  for (const [id, c] of Object.entries(cat)) {
    const p = get(String(id));
    if (c.sku) p.sku = c.sku; if (c.product) p.product = c.product; if (c.variant != null && c.product) p.variant = c.variant; if (c.type) p.type = c.type;
    if (num(c.price)) p.price = num(c.price); if (num(c.cost)) p.cost = num(c.cost);
    if (c.stock != null && Number.isFinite(+c.stock)) p.stock = num(c.stock);
    if (c.active === false) { p.inactive = c.status || 'INACTIVE'; p.inactiveSince = c.inactiveSince || now; }
    /* earlier inactive spells of a variant that is active again (draft while sold out, reactivated on restock) */
    if (c.createdAt != null && Number.isFinite(+c.createdAt)) p.createdAt = +c.createdAt;   // 1.3.0: weeks live for G26 confidence (§4c)
    if (Array.isArray(c.spells)) p.spells = c.spells.map((x) => ({ from: +x.from, to: +x.to })).filter((x) => Number.isFinite(x.from) && x.to > x.from);
  }

  const orderSpan = minMax(orders, (o) => o.t), stockSpan = minMax(stock, (r) => r.t);
  const firstOrder = orders.length ? orderSpan.min : now;
  const demandFrom = Math.max(now - S.demandWindowDays * DAY, firstOrder);
  /* a product's data starts at its first stock record or first order; before that it didn't exist for us */
  for (const p of P.values()) p.first = Math.min(p.changes.length ? p.changes[0].t : Infinity, minMax(p.lines, (o) => o.t).min);

  /* one bucket per local day touched by the period, the partial first day included, so the daily
     chart adds up to the same totals as the product rows */
  const daily = {};
  const lastKey = dayKey(now, off);
  for (const k of TZ.dayKeys(from, now, off)) { daily[k] = daily[k] || { sold: 0, lost: 0, lostEstimate: 0, lostNotRestocked: 0, lostAllocation: 0, units: 0, unitsLost: 0, outSkus: new Set() }; if (k === lastKey) break; }   // a 23- or 25-hour day is one day (SW-049)
  for (const o of orders) {
    if (o.t < from) continue;
    const d = daily[dayKey(o.t, off)]; if (!d) continue;
    d.sold += num(o.qty) * num(o.price); d.units += num(o.qty);
  }

  /* 1.3.0: Shopify's weekly sales per variant (src/weeks.js, ShopifyQL): G26 confidence (§4c) and the floor rate (§3) */
  const ws = opts.weekSales && typeof opts.weekSales === 'object' && opts.weekSales.by ? opts.weekSales : null;
  const products = [], reorder = [], stockouts = [];
  const excluded = { variants: 0, pcs: 0, byStatus: {} };
  for (const p of P.values()) {
    const name = [p.product, p.variant && p.variant !== 'Default Title' ? p.variant : ''].filter(Boolean).join(' · ') || p.sku || p.id;
    /* an inactive product can't be bought, so a stock-out it was in ends when it went inactive */
    /* and one that was inactive for a while and came back: the spell is cut out, so ₹ lost for those days never comes back later */
    const spells = (p.spells || []).slice();
    if (p.inactive) spells.push({ from: Math.min(now, Math.max(p.inactiveSince, p.changes.length ? p.changes[p.changes.length - 1].t : 0)), to: Infinity });
    spells.sort((a, b) => a.from - b.from);
    const eps = afterLastSale(cutBySpells(episodes(p.changes, now), spells), p.lines, p.changes, syncMs);
    if (p.inactive) for (const e of eps) if (e.open) { e.open = false; e.inactive = true; }
    const pFirst = Number.isFinite(p.first) ? p.first : demandFrom;
    const pFrom = Math.max(demandFrom, pFirst);   // a new launch isn't diluted by days before it existed
    /* a long stock-out (under 7 in-stock days in the window) looks further back, so it keeps its demand */
    const histFrom = Math.max(now - KEEP_DAYS * DAY, firstOrder, pFirst), cantSell = unsellable(eps, spells, now);
    const rate = demandRate(p.lines, cantSell, { winFrom: pFrom, histFrom, now, wantDays: S.demandWindowDays, first: pFirst });
    const units = rate.units;
    const revenue = rate.lines.reduce((s, o) => s + demandQty(o) * num(o.price), 0);
    const price = units ? revenue / units : p.price;
    let { perDay } = rate, lowData = false;
    if (units > 0 && units < LOW_UNITS && rate.rawDays < LOW_DAYS) {
      lowData = true;
      const firstSale = minMax(p.lines, (o) => o.t).min;
      const all = p.lines.reduce((s, o) => s + demandQty(o), 0);
      perDay = Math.min(perDay, all / Math.max(1, (now - firstSale) / DAY));
    }
    const perSellingHour = perDay / 24;
    /* how sure ₹ lost is (LOGIC.md §4c). 1.3.0: the share of Shopify's last full weeks with a sale (G26) when the variant was
       live 8+ of them; else the units: those the rate rests on, or every unit held, whichever is more */
    const wsRow = ws ? own(ws.by, p.id) : undefined, live = weeksLive(ws, p.createdAt);
    const heldUnits = p.lines.reduce((s, o) => s + (o.t >= histFrom ? demandQty(o) : 0), 0);
    let confidence, weeksSold = null;
    if (live != null && live >= WEEKS_MIN_LIVE) { weeksSold = Math.min(live, wsRow ? Math.max(0, num(wsRow.s)) : 0); confidence = confidenceOfWeeks(weeksSold, live); }
    else confidence = confidenceOf(Math.max(units, heldUnits));
    /* SW-040 (LOGIC.md §6c): the product's supplier; its lead time, when set, replaces the store's */
    const sup = own(opts.suppliers, p.id) || null, lead = sup && sup.leadDays != null ? sup.leadDays : S.leadDays;
    const oo = p.stock == null ? null : onOrderNow(own(opts.onOrder, p.id), p.changes, now, p.stock, perDay, lead);
    const nrDays = notRestockedDays(lead, S.safetyDays);   // §4c
    /* §3 floor (1.3.0): out the whole time we hold and nothing sold, but Shopify's 26 weeks show sales → a floor rate for ₹ lost
       only (the order quantity keeps the product's own rate); all of it is "not restocked" (estimate when a PO is marked) */
    const units26 = wsRow ? Math.max(0, num(wsRow.u)) : 0, lastEp = eps[eps.length - 1];
    const seeded = !p.inactive && units === 0 && units26 > 0 && !!lastEp && lastEp.open && demandPerDay(0, histFrom, now, cantSell).rawDays < 1;
    const lossPrice = seeded && num(wsRow.n) > 0 ? num(wsRow.n) / units26 : price;
    const lossPerHour = seeded ? units26 / FLOOR_DAYS / 24 : perSellingHour;
    /* §6 (1.3.0): Shopify's stock is a website allocation the warehouse tops up → no reorder from here; ₹ lost apart */
    const alloc = +S.allocationCheck !== 0 && !p.inactive && p.stock != null ? allocationOf(p.changes, now) : null;

    let lost = 0, unitsLost = 0, outs = 0, smallTopUps = 0, repeats = 0, lostNR = 0;
    eps.forEach((e, i) => {
      if (e.end <= from) return;
      const a = Math.max(e.start, from);
      /* §4c: the part of a stock-out after its nrDays-th day (30, or lead + buffer + 14 when longer); still open and nothing
         marked ordered → "not restocked". A floor-rate product (seeded) is "not restocked" from the start */
      const cut = Math.max(a, Math.min(e.end, e.start + nrDays * DAY));
      const h1 = sellingHours(a, cut, profile, off), h2 = sellingHours(cut, e.end, profile, off);
      const nr = e.open && !oo, nrAll = seeded && nr;
      const uLost = (h1.total + h2.total) * lossPerHour;
      const vLost = uLost * lossPrice, vOver = nrAll ? vLost : h2.total * lossPerHour * lossPrice;
      lost += vLost; unitsLost += uLost; outs++;
      if (nr) lostNR += vOver;
      for (const [h, late] of [[h1, false], [h2, true]]) {
        for (const [k, w] of Object.entries(h.byDay)) {
          const d = daily[k]; if (!d) continue;
          const v = w * lossPerHour * lossPrice;
          if ((late || nrAll) && nr) d.lostNotRestocked += v; else if (alloc) d.lostAllocation += v; else if (confidence === 'low' || seeded) d.lostEstimate += v; else d.lost += v;
          d.unitsLost += w * lossPerHour; d.outSkus.add(p.id);
        }
      }
      const small = !e.open && !e.inactive && perDay > 0 && e.topUp < perDay * S.smallTopUpDays;
      const next = eps[i + 1];
      const repeat = !!next && next.start - e.end < 7 * DAY;
      if (small) smallTopUps++;
      if (repeat) repeats++;
      stockouts.push({
        id: p.id, name, sku: p.sku, start: e.start, end: e.open ? null : e.end, open: e.open,
        hours: round((e.end - e.start) / HOUR, 1), hoursInPeriod: round((e.end - a) / HOUR, 1), unitsLost: round(uLost, 1), lost: Math.round(vLost),
        topUp: e.open || e.inactive ? null : e.topUp, topUpDays: !e.open && !e.inactive && perDay > 0 ? round(e.topUp / perDay, 1) : null,
        small, repeat, perDay: round(perDay, 2),
        confidence, lostOver30: Math.round(vOver), lostNotRestocked: nr ? Math.round(vOver) : 0,   // §4c
        ...(alloc ? { allocation: true } : {}), ...(seeded ? { floor: true } : {}),   // §6, §3 (1.3.0)
      });
    });

    let pl = p.stock == null ? null : planWithOrder({ stock: p.stock, perDay, lead, cover: S.coverDays, safety: S.safetyDays }, oo);
    if (pl && sup) pl = { ...pl, qty: roundOrder(pl.qty, sup).qty, rawQty: pl.qty };   // up to the MOQ, then whole case packs
    const selling = perDay > 0 && perDay >= S.minPerDay;
    const row = {
      id: p.id, name, sku: p.sku, stock: p.stock, perDay: round(perDay, 2), price: Math.round(price),
      daysLeft: pl && Number.isFinite(pl.daysLeft) ? round(pl.daysLeft, 1) : null,
      status: pl ? (selling ? pl.status : 'Slow seller') : 'No stock data',
      orderQty: pl && selling ? pl.qty : 0, orderValue: pl && selling ? Math.round(pl.qty * (p.cost || price)) : 0,   // cash to commit: unit cost when known
      rateBasis: rate.basis, rateFrom: rate.from,   // which sales the rate was measured on (LOGIC.md §3)
      rateUnits: units, confidence, heldUnits, weeksSold, weeksLive: live != null && live >= WEEKS_MIN_LIVE ? live : null, confBasis: live != null && live >= WEEKS_MIN_LIVE ? 'weeks' : 'units', nrDays,   // §4c: how sure ₹ lost is, on what
      lost: Math.round(lost), unitsLost: round(unitsLost, 1), outs, smallTopUps, repeats,
      sold: Math.round(p.lines.filter((o) => o.t >= from).reduce((s, o) => s + num(o.qty) * num(o.price), 0)),
      unitsSold: p.lines.filter((o) => o.t >= from).reduce((s, o) => s + num(o.qty), 0),
      type: p.type || '', onOrder: oo,
    };
    /* returns in the period (SW-064, 1.1.3, LOGIC.md §9e), cancelled orders included; ₹ sold stays on units kept */
    const rt = returns.get(String(p.id)) || { ordered: 0, returned: 0, value: 0, cancelled: 0 };
    Object.assign(row, { unitsOrdered: rt.ordered, unitsReturned: rt.returned, unitsCancelled: rt.cancelled, returnPct: returnPct(rt.ordered, rt.returned), refundValue: Math.round(rt.value) });
    if (lowData) row.lowData = true;
    if (seeded) { row.floorPerDay = round(units26 / FLOOR_DAYS, 3); row.units26 = units26; }   // §3 floor (1.3.0)
    /* §4c: the row's ₹ lost in four buckets that add up to lost (headline = lostCounted): not restocked, allocation refill
       gaps (§6), estimate, counted */
    row.lostNotRestocked = Math.min(row.lost, Math.round(lostNR));
    row.lostAllocation = alloc ? Math.max(0, row.lost - row.lostNotRestocked) : 0;
    row.lostEstimate = !alloc && (confidence === 'low' || seeded) ? Math.max(0, row.lost - row.lostNotRestocked) : 0;
    row.lostCounted = row.lost - row.lostNotRestocked - row.lostAllocation - row.lostEstimate;
    if (alloc && pl) Object.assign(row, { status: ALLOCATION_STATUS, allocation: alloc, orderQty: 0, orderValue: 0 });   // §6: no reorder sized on an allocation
    row.lostConfidence = row.lost > 0 ? confidence : null;
    if (row.lostNotRestocked > 0) row.notRestocked = true;
    /* the product's first stock record (UI-1): before it there's no stock history, so ₹ lost there is unknown, not 0 */
    row.historyFrom = p.changes.length ? p.changes[0].t : null;
    /* mostly given away (M4): average paid under 10% of the list price and no unit cost → a free gift? kept out of the budget rank */
    if (!p.cost && units > 0 && num(p.price) > 0 && price < 0.1 * num(p.price)) row.gift = true;
    Object.defineProperty(row, '_plan', { value: { pl, perDay, unitValue: p.cost || price, demand: perDay * (price || 0), lead, oo, sup, stock: p.stock }, enumerable: false });
    if (sup) { row.supplier = sup.name; if (sup.leadDays != null) row.leadDays = lead; }
    row.lostPct = row.sold + row.lost ? round((row.lost / (row.sold + row.lost)) * 100, 1) : 0;
    /* profit: needs a unit cost (Shopify's inventory item cost, or a cost column) */
    row.cost = p.cost ? Math.round(p.cost) : null;
    row.margin = p.cost && price ? round(((price - p.cost) / price) * 100, 1) : null;
    row.lostProfit = p.cost ? Math.round(unitsLost * Math.max(0, price - p.cost)) : null;
    /* excess stock: pieces beyond what the next lead + cover + safety days need; "overstocked" when
       stock covers more than twice that, or the product hasn't sold at all */
    const need = perDay * (lead + S.coverDays + S.safetyDays);
    const have = p.stock > 0 ? p.stock : 0;
    row.excessUnits = Math.max(0, Math.floor(have - need));
    row.excessValue = Math.round(row.excessUnits * (p.cost || price || 0));
    row.overstock = have > 0 && (perDay === 0 || have > 2 * need);
    const tr = trend(p.lines, eps, now, p.first);
    Object.assign(row, tr); row._plan.recentRate = tr.recentRate;
    /* ₹ effect of the trend (Overview "Moving"): the change in daily rate × average price × 30 = ₹ a month at the new pace */
    row.trendValue = row.rateDelta == null ? null : Math.round(row.rateDelta * price * 30);
    if (p.inactive) {   // left out of reorder and overstock; listed only if it sold or lost sales in the period
      excluded.variants++; excluded.pcs += Math.max(0, num(p.stock)); excluded.byStatus[p.inactive] = (excluded.byStatus[p.inactive] || 0) + 1;
      Object.assign(row, { status: 'Inactive', inactive: p.inactive, orderQty: 0, orderValue: 0, excessUnits: 0, excessValue: 0, overstock: false });
      if (row.sold || row.lost || row.unitsSold || row.outs) products.push(row);
      continue;
    }
    products.push(row);
    if (pl && selling && row.status !== 'OK' && !row.allocation) reorder.push(row);
  }

  /* best sellers (ABC by ₹ demand a day: the sales rate × average price paid, both from the demand
     window, so the rank and every order quantity stay put when the period buttons change):
     A = the products making the first 80% of demand, B = the next 15%, C = the rest and anything with none.
     Inactive (archived, draft, untracked, deleted) rows are left out of the rank and are C: they are listed only when they
     sold or lost sales in the period, so ranking them made A slots and order value move with the period (critic r2 L2). */
  const demandOf = (p) => p._plan.demand;
  for (const p of products) if (p.status === 'Inactive') p.abc = 'C';
  const byDemand = products.filter((p) => p.status !== 'Inactive').sort((a, b) => demandOf(b) - demandOf(a) || String(a.id).localeCompare(String(b.id)));
  const allDemand = byDemand.reduce((s, p) => s + demandOf(p), 0);
  let run = 0;
  for (const p of byDemand) {
    const before = allDemand ? run / allDemand : 1; run += demandOf(p);
    p.abc = !(demandOf(p) > 0) ? 'C' : before < 0.8 ? (p.lowData ? 'B' : 'A') : before < 0.95 ? 'B' : 'C';   // low data is never A (§7a)
  }
  /* a best seller is never "slow": it earns its place by ₹ even when it sells few units (e.g. furniture) */
  for (const p of products) {
    const { pl, perDay, unitValue } = p._plan;
    if (p.abc === 'A' && p.status === 'Slow seller' && pl && perDay > 0) {
      p.status = pl.status; p.orderQty = pl.qty; p.orderValue = Math.round(pl.qty * unitValue);
      if (p.status !== 'OK') reorder.push(p);
    }
  }

  /* trend call against the typical product (LOGIC.md §7d): 'up' / 'down' only 10+ points away from the store's
     median trend, so a season-wide fall doesn't paint every row red. No baseline (under 5 trends) → against 0. */
  const baseTrend = storeTrend(products);
  for (const p of products) p.trendCall = trendCall(p.trendPct, baseTrend);
  /* the order at the last 14 days' pace (LOGIC.md §6): when the product or the store is falling 20%+ and that pace is
     slower, so a post-peak order isn't sized on the peak alone. Shown beside the order quantity; it doesn't replace it. */
  for (const p of products) {
    const x = p._plan, rr = x.recentRate;
    if (!x.pl || rr == null || !(rr < x.perDay) || !((p.trendPct != null && p.trendPct <= PACE_DROP) || (baseTrend != null && baseTrend <= PACE_DROP))) continue;
    let q = planWithOrder({ stock: x.stock, perDay: rr, lead: x.lead, cover: S.coverDays, safety: S.safetyDays }, x.oo).qty;
    if (x.sup) q = roundOrder(q, x.sup).qty;
    p.paceQty = q; p.pacePerDay = round(rr, 2);
  }

  /* an order quantity only where an order is due (Order today / This week); "OK" never asks you to order */
  for (const p of products) if (!['Out now', 'Critical', 'Order now', 'Order this week'].includes(p.status)) { p.orderQty = 0; p.orderValue = 0; delete p.paceQty; delete p.pacePerDay; }
  for (const p of products) if (p.paceQty != null) { if (p.paceQty >= p.orderQty) { delete p.paceQty; delete p.pacePerDay; } else p.paceValue = Math.round(p.paceQty * p._plan.unitValue); }
  /* SW-040: units the MOQ / case pack added, and their cash (LOGIC.md §6c) */
  for (const p of products) {
    const raw = p._plan.pl && p._plan.pl.rawQty;
    if (raw != null && p.orderQty > raw) { p.packExtra = p.orderQty - raw; p.packExtraValue = Math.round(p.packExtra * p._plan.unitValue); }
  }

  const rank = (s) => (TODAY_STATUS.includes(s) ? 0 : STATUS.indexOf(s));
  const perDayValue = (p) => (rank(p.status) === 0 ? p._plan.demand : 0);   // ₹ of sales a day at stake, Order today rows only
  reorder.sort((a, b) => rank(a.status) - rank(b.status) || perDayValue(b) - perDayValue(a) || (a.abc || 'C').localeCompare(b.abc || 'C') || b.lost - a.lost || b.perDay - a.perDay);
  stockouts.sort((a, b) => b.lost - a.lost);
  products.sort((a, b) => b.lostCounted - a.lostCounted || b.lost - a.lost || b.sold - a.sold);   // 1.3.0 (UI-2): the headline's part first, so a list adds up to it

  const dailyRows = Object.entries(daily).map(([day, d]) => ({
    day, sold: Math.round(d.sold), lost: Math.round(d.lost), lostEstimate: Math.round(d.lostEstimate), lostNotRestocked: Math.round(d.lostNotRestocked), lostAllocation: Math.round(d.lostAllocation), units: d.units, unitsLost: round(d.unitsLost, 1), outSkus: d.outSkus.size,
  }));
  /* totals come from the product rows, so they always equal what the Products page adds up to */
  const sold = products.reduce((s, p) => s + p.sold, 0);
  /* §4c: the headline counts high and medium confidence; estimates and 30+ d not restocked are apart; lostAll = all three */
  const lost = products.reduce((s, p) => s + p.lostCounted, 0);
  const lostEstimate = products.reduce((s, p) => s + p.lostEstimate, 0), lostNotRestocked = products.reduce((s, p) => s + p.lostNotRestocked, 0);
  const lostAllocation = products.reduce((s, p) => s + (p.lostAllocation || 0), 0);   // §6 (1.3.0): refill gaps on allocation items
  /* out but not selling (LOGIC.md §1c): no units, no sales and no sales lost in the period; counted apart from "still out" */
  const rowOf = new Map(products.map((p) => [String(p.id), p]));
  const notSelling = (id) => { const p = rowOf.get(String(id)); return !!p && !p.unitsSold && !p.sold && !p.lost; };
  for (const s of stockouts) if (notSelling(s.id)) s.notSelling = true;
  const selling = stockouts.filter((s) => !s.notSelling), openOuts = selling.filter((s) => s.open);

  return {
    generatedAt: now, days, from, settings: S,
    totals: {
      sold, lost, lostPct: sold + lost ? round((lost / (sold + lost)) * 100, 1) : 0,
      lostEstimate, lostNotRestocked, lostAllocation, lostAll: lost + lostEstimate + lostNotRestocked + lostAllocation,
      lostAllocationProducts: products.filter((p) => p.lostAllocation > 0).length, allocation: products.filter((p) => p.status === ALLOCATION_STATUS).length,
      notRestockedDays: notRestockedDays(S.leadDays, S.safetyDays), weekSales: ws ? { weeks: ws.weeks, at: ws.at || null } : null,
      lostEstimateProducts: products.filter((p) => p.lostEstimate > 0).length, lostNotRestockedProducts: products.filter((p) => p.lostNotRestocked > 0).length,
      unitsLost: round(dailyRows.reduce((s, d) => s + d.unitsLost, 0), 0),
      outNow: products.filter((p) => p.status === 'Out now' || (p.status === 'Ordered' && p.stock <= 0)).length,
      ordered: products.filter((p) => p.status === 'Ordered').length,
      orderNow: products.filter((p) => ['Critical', 'Order now'].includes(p.status)).length,
      orderToday: products.filter((p) => ['Out now', 'Critical', 'Order now'].includes(p.status)).length,
      stillOut: openOuts.length,
      outNotSelling: stockouts.filter((s) => s.open && s.notSelling).length,
      orderWeek: products.filter((p) => p.status === 'Order this week').length,
      stockouts: selling.length,   // M2/UI-2: the Stock-outs page's count; out-but-not-selling episodes apart
      stockoutsNotSelling: stockouts.length - selling.length,
      smallTopUps: selling.filter((s) => s.small).length,
      repeats: selling.filter((s) => s.repeat).length,
      products: products.length,
      lostProfit: products.some((p) => p.lostProfit != null) ? products.reduce((s, p) => s + (p.lostProfit || 0), 0) : null,
      hasCost: products.some((p) => p.cost != null),
      bestsellers: products.filter((p) => p.abc === 'A').length,
      bestAtRisk: products.filter((p) => p.abc === 'A' && ['Out now', 'Critical', 'Order now'].includes(p.status)).length,
      orderValueNow: reorder.filter((p) => ['Out now', 'Critical', 'Order now'].includes(p.status)).reduce((s, p) => s + p.orderValue, 0),
      orderValueAll: reorder.reduce((s, p) => s + p.orderValue, 0),
      packExtraValue: reorder.reduce((s, p) => s + (p.packExtraValue || 0), 0),
      overstocked: products.filter((p) => p.overstock).length,
      excessValue: products.filter((p) => p.overstock).reduce((s, p) => s + p.excessValue, 0),
      storeTrendPct: baseTrend,
      costed: products.filter((p) => p.cost != null && (p.sold || p.lost)).length,
      ...(() => { const o = products.reduce((s, p) => s + p.unitsOrdered, 0), b = products.reduce((s, p) => s + p.unitsReturned, 0);
        return { unitsOrdered: o, unitsReturned: b, unitsCancelled: products.reduce((s, p) => s + p.unitsCancelled, 0), returnPct: returnPct(o, b), refundValue: Math.round([...returns.values()].reduce((s, x) => s + x.value, 0)), highReturns: products.filter((p) => p.returnPct >= HIGH_RETURN_PCT).length }; })(),
      /* Shopify-style net sales (1.1.5): only when reversals carry their own dates (Shopify pull) */
      shopifyNet: reversals ? (() => { const back = [...returns.values()].reduce((s, x) => s + x.value, 0); return { gross: Math.round(gross), returns: Math.round(back), net: Math.round(gross - back) }; })() : null,
      active: products.filter((p) => p.sold || p.lost).length,
    },
    daily: dailyRows, reorder, stockouts, products,
    data: {
      stockRows: stock.length, orderRows: orders.length,
      firstStock: stock.length ? stockSpan.min : null,
      lastStock: stock.length ? stockSpan.max : null,
      firstOrder: orders.length ? firstOrder : null,
      lastOrder: orders.length ? orderSpan.max : null,
      catalog: Object.keys(cat).length, excluded,
    },
  };
}

/** One product: stock over time, daily units, its stock-outs. */
function productDetail(id, stock, orders, settings = {}, opts = {}) {
  const S = { ...DEFAULT_SETTINGS, ...settings };
  const now = opts.now || Date.now();
  const from = opts.from != null ? Math.min(now, Math.max(now - 90 * DAY, opts.from)) : now - Math.max(1, Math.min(90, Math.round(opts.days || 30))) * DAY;
  const changes = stock.filter((r) => String(r.variantId) === String(id)).sort((a, b) => a.t - b.t);
  const lines = orders.filter((o) => String(o.variantId) === String(id));
  const before = changes.filter((c) => c.t < from).pop();
  const timeline = [];
  if (before) timeline.push({ t: from, stock: num(before.now) });
  for (const c of changes) if (c.t >= from) timeline.push({ t: c.t, stock: num(c.now) });
  if (timeline.length) timeline.push({ t: now, stock: timeline[timeline.length - 1].stock });
  const units = {};
  const zone = TZ.zoneOf(S);
  /* one bar per store day in the period: a calendar period (1.1.5) starts at a midnight; a rolling one leaves out the partial first day */
  const first = opts.from != null ? from : from + DAY;
  for (const k of TZ.dayKeys(first, now, zone)) units[k] = 0;
  for (const o of lines) if (o.t >= from) { const k = dayKey(o.t, zone); if (k in units) units[k] += num(o.qty); }
  /* same numbers as the main report (the store-wide hourly pattern), this product only */
  const r = report(stock, orders, S, { ...opts, now, from, days: opts.from != null ? opts.days : undefined });   // every report option (catalog, Mark ordered, suppliers, reversals, pull interval, weekly sales)
  const c = own(opts.catalog, String(id));
  if (!timeline.length && c && c.stock != null) timeline.push({ t: from, stock: num(c.stock) }, { t: now, stock: num(c.stock) });   // never moved: flat at its stock now
  return { id, product: r.products.find((p) => String(p.id) === String(id)) || null, timeline,
    dailyUnits: Object.entries(units).map(([day, u]) => ({ day, units: u })),
    stockouts: r.stockouts.filter((s) => String(s.id) === String(id)).sort((a, b) => a.start - b.start) };
}

module.exports = {
  CALC_VERSION, TODAY_STATUS, CONF_HIGH, CONF_MEDIUM, NOT_RESTOCKED_DAYS, notRestockedDays, confidenceOf, confidenceOfWeeks, weeksLive, WEEKS_HIGH, WEEKS_MEDIUM, WEEKS_MIN_LIVE, FLOOR_DAYS, allocationOf, ALLOCATION_STATUS, ALLOC_DAYS, ALLOC_REFILLS, ALLOC_MAX_LEVEL, ALLOC_MAX_GAP_H, lostSplit, RETURN_MIN_UNITS, HIGH_RETURN_PCT, returnsOf, demandQty, afterLastSale, oversold, SYNC_MINUTES, trend, trendCall, storeTrend, TREND_MIN_UNITS, LOW_UNITS, LOW_DAYS, PACE_DROP, minMax, report, productDetail, episodes, demandPerDay, demandRate, inStockStart, KEEP_DAYS, MIN_IN_STOCK_DAYS, plan, onOrderNow, hourProfile, sellingHours, dayKey, DEFAULT_SETTINGS, HOUR, DAY };
