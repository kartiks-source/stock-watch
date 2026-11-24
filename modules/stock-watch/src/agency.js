'use strict';
/*
 * The brand report (1.4.0, LOGIC.md §20–§22): which best sellers ran out, on which days, for how long, and the money that
 * cost, month by month over the last 12 months. Pure: works on year.json (src/year.js: Shopify's daily sales and daily
 * 'available' stock changes per variant) and the catalog. Nothing here reads a file or calls Shopify.
 *
 *   days(y, c)          per variant per day: stock at the day's end, in-stock share of the day, units, oversold units
 *   build(y, catalog, opts)  → { asOf, span, months, headline, products, bestsellers, store }
 *
 * Day rules (§20): stock at the end of day d = stock now − the changes logged after d (walked back from the catalog's
 * stock at the read, like §1c). Start of day = end of the day before. In stock all day: start > 0 and end > 0. Out all day:
 * start ≤ 0 and end ≤ 0, unless it sold more than its oversold units that day (it was refilled and sold out again inside
 * the day: in stock). Otherwise (ran out or came back that day): half a day. Oversold units = how far the day pushed stock
 * further below 0 (an oversell to −1 is not "in stock", §2); they never count in the pace. A walk that goes below
 * min(stock now, 0) means the log is incomplete for that variant: dropped (unsure), as in §1c.
 *
 * Pace (§21): units ÷ in-stock days over the last `paceMonths` months (6 by default, 12 by setting), oversold units out;
 * fewer than 14 in-stock days → the 12 months; still fewer than 7 → divided by 7 at least (marked few). Season (§21):
 * index per calendar month = the variant's in-stock pace that month ÷ its 12-month in-stock pace, blended with the whole
 * shop's index for that month (units a day that month ÷ units a day over the year) by in-stock days (weight d ÷ (d + 14));
 * under 7 in-stock days that month → the shop's index; capped 0.5–2.0. Expected a day in month m = pace × index(m) ÷ the
 * average index of the days the pace was measured on (so a 6-month pace measured over Diwali isn't applied to January).
 *
 * Money missed (§22): out-of-stock share of each day × expected a day in that month × average price paid (12-month net sales
 * ÷ units, ex GST; list price when it never sold for money). Best sellers = products making the top `bestShare` (80%) of the
 * 12 months' net sales, among products on sale now.
 */
const DAY = 864e5;
const MIN_DAYS = 14;          // in-stock days the pace needs before it widens to 12 months
const FLOOR_DAYS = 7;         // never divide by fewer in-stock days (same as §3)
const SEASON_K = 14;          // blend weight: a month with 14 in-stock days counts half its own, half the shop's
const SEASON_MIN = 7;         // under this many in-stock days in a month: the shop's index
const SEASON_CAP = [0.5, 2];
const MONTHS = 12;

const keyPlus = (key, n) => new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const monthOf = (k) => k.slice(0, 7);
const clamp = (x, [a, b]) => Math.min(b, Math.max(a, x));
const r2 = (x) => Math.round(x * 100) / 100;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (m) => `${MON[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
const dayLabel = (k) => `${+k.slice(8, 10)} ${MON[+k.slice(5, 7) - 1]}`;

/** The days the report covers: from = the first day both streams hold, through = the last full day (yesterday). */
function spanOf(y) {
  if (!y || !y.anchor || !y.sales || !y.moves || !y.sales.from || !y.moves.from) return null;
  const from = y.sales.from > y.moves.from ? y.sales.from : y.moves.from;
  let through = keyPlus(y.anchor.day, -1);
  if (y.sales.to && y.sales.to < through) through = y.sales.to;
  if (y.moves.to && y.moves.to < through) through = y.moves.to;
  return through >= from ? { from, through } : null;
}

/** Every day key from a to b, both included. */
function dayKeys(a, b) { const out = []; for (let k = a; k <= b; k = keyPlus(k, 1)) out.push(k); return out; }

/**
 * One variant's days. → null (no stock now: not tracked) | { dropped: true, low } | { list: [{ k, end, start, u, over, inF }], live }
 * live = first day it counts (its creation day, then its first day in stock, when created inside the span).
 */
function days(y, id, keys, createdDay = null) {
  const L0 = y.anchor && Object.hasOwn(y.anchor.levels, id) ? Number(y.anchor.levels[id]) : null;
  if (L0 == null || !Number.isFinite(L0)) return null;
  const mv = (y.moves.by && y.moves.by[id]) || {}, sl = (y.sales.by && y.sales.by[id]) || {};
  const floor = Math.min(L0, 0);
  /* walk back from the anchor day's end to the day before the span */
  const ends = new Map(); let L = L0, low = L0;
  const first = keyPlus(keys[0], -1);
  for (let k = y.anchor.day; k >= first; k = keyPlus(k, -1)) {
    ends.set(k, L); if (L < low) low = L;
    L -= Number(mv[k] || 0);
  }
  if (low < floor) return { dropped: true, low };
  const list = [];
  let live = keys[0];
  if (createdDay && createdDay > keys[0]) live = createdDay;
  let started = !(createdDay && createdDay > keys[0]);
  for (const k of keys) {
    if (k < live) continue;
    const end = ends.get(k), start = ends.get(keyPlus(k, -1));
    const u = Math.max(0, Number((sl[k] || [0])[0]) || 0);
    const over = Math.min(u, Math.max(0, Math.max(0, -end) - Math.max(0, -start)));
    let inF = start > 0 && end > 0 ? 1 : start <= 0 && end <= 0 ? (u - over > 0 ? 1 : 0) : 0.5;
    if (!started) { if (inF === 0) continue; started = true; }   // created inside the span: counts from its first day in stock
    list.push({ k, end, start, u, over, inF });
  }
  return { list, live: list.length ? list[0].k : null };
}

/** The shop's index per month: units a day that month ÷ units a day over the span (sales.all), capped. */
function shopSeason(y, keys) {
  const per = new Map(); let tu = 0;
  for (const k of keys) {
    const u = Math.max(0, Number(((y.sales.all || {})[k] || [0])[0]) || 0);
    const m = monthOf(k), x = per.get(m) || { u: 0, d: 0 };
    x.u += u; x.d += 1; per.set(m, x); tu += u;
  }
  const avg = tu / Math.max(1, keys.length), out = {};
  for (const [m, x] of per) out[m] = avg > 0 && x.d >= SEASON_MIN ? r2(clamp(x.u / x.d / avg, SEASON_CAP)) : 1;
  return out;
}

/** Pace and season for one variant's days. paceFrom = first day of the pace window. */
function paceOf(list, paceFrom, shop) {
  const all = { u: 0, d: 0 }, win = { u: 0, d: 0 }, per = new Map();
  for (const x of list) {
    const pu = x.inF > 0 ? x.u - x.over : 0;
    all.u += pu; all.d += x.inF;
    if (x.k >= paceFrom) { win.u += pu; win.d += x.inF; }
    const m = monthOf(x.k), p = per.get(m) || { u: 0, d: 0 }; p.u += pu; p.d += x.inF; per.set(m, p);
  }
  let basis = 'window', use = win;
  if (win.d < MIN_DAYS) { basis = 'year'; use = all; }
  const few = use.d < FLOOR_DAYS;
  const perDay = use.u / Math.max(use.d, FLOOR_DAYS);
  const year = all.d > 0 ? all.u / Math.max(all.d, FLOOR_DAYS) : 0;
  const season = {};
  for (const m of Object.keys(shop)) {
    const p = per.get(m);
    if (!p || p.d < SEASON_MIN || !(year > 0)) { season[m] = shop[m]; continue; }
    const raw = p.u / p.d / year, w = p.d / (p.d + SEASON_K);
    season[m] = r2(clamp(w * raw + (1 - w) * shop[m], SEASON_CAP));
  }
  /* the average index of the days the pace was measured on */
  let wi = 0, wd = 0;
  for (const x of list) if ((basis === 'year' || x.k >= paceFrom) && x.inF > 0) { wi += x.inF * (season[monthOf(x.k)] ?? 1); wd += x.inF; }
  const level = wd > 0 ? wi / wd : 1;
  return { perDay, units: use.u, inDays: r2(use.d), basis, few, season, level: r2(level), yearUnits: all.u, yearInDays: r2(all.d) };
}

/** Day keys → "4–11 Oct, 23 Oct" (runs of days). */
function ranges(keys) {
  const out = []; let a = null, b = null;
  const flush = () => { if (!a) return; out.push(a === b ? dayLabel(a) : a.slice(0, 7) === b.slice(0, 7) ? `${+a.slice(8, 10)}–${dayLabel(b)}` : `${dayLabel(a)} – ${dayLabel(b)}`); };
  for (const k of keys) { if (b && keyPlus(b, 1) === k) { b = k; continue; } flush(); a = b = k; }
  flush();
  return out.join(', ');
}

/**
 * The report. catalog = store.catalog ({ variantId → productId, product, variant, sku, price, active, createdAt, … }).
 * opts: { paceMonths = 6, bestShare = 0.8, zone, links: (catalogEntry) → { image, adminUrl, webUrl }, month: 'YYYY-MM' }.
 */
function build(y, catalog = {}, { paceMonths = 6, bestShare = 0.8, links = () => ({}), dayOf = null } = {}) {
  const sp = spanOf(y);
  if (!sp) return { ok: false, reason: !y || !y.anchor ? 'none' : 'short' };
  const keys = dayKeys(sp.from, sp.through);
  const shop = shopSeason(y, keys);
  const paceFrom = keyPlus(sp.through, -Math.round(paceMonths * 30.44) + 1);
  /* months: the 12 calendar months ending with the month of `through` (the first may be part-held) */
  const lastM = monthOf(sp.through), monthKeys = [];
  for (let i = MONTHS - 1; i >= 0; i--) { const d = new Date(Date.UTC(+lastM.slice(0, 4), +lastM.slice(5, 7) - 1 - i, 1)); monthKeys.push(d.toISOString().slice(0, 7)); }
  const inMonths = new Set(monthKeys);
  /* store sales per month (every sales row: the total Shopify shows) */
  const months = new Map(monthKeys.map((m) => [m, { key: m, label: monthLabel(m), from: null, to: null, days: 0, sold: 0, units: 0, lost: 0, lostUnits: 0, lostAll: 0, bestOut: 0, daysOut: 0 }]));
  for (const k of keys) {
    const m = months.get(monthOf(k)); if (!m) continue;
    const t = (y.sales.all || {})[k] || [0, 0];
    m.sold += Number(t[1]) || 0; m.units += Number(t[0]) || 0; m.days++;
    if (!m.from) m.from = k; m.to = k;
  }
  /* variants → products */
  const variants = [], dropped = [];
  for (const [id, c] of Object.entries(catalog || {})) {
    if (!c || c.active === false || c.tracked === false) continue;
    const createdDay = c.createdAt && dayOf ? dayOf(c.createdAt) : null;
    const ds = days(y, id, keys, createdDay);
    if (!ds) continue;
    if (ds.dropped) { dropped.push(id); continue; }
    const sl = (y.sales.by && y.sales.by[id]) || {};
    let su = 0, sn = 0;
    for (const k of keys) { const x = sl[k]; if (x) { su += Number(x[0]) || 0; sn += Number(x[1]) || 0; } }
    const price = su > 0 && sn > 0 ? sn / su : Number(c.price) || 0;
    const pace = paceOf(ds.list, paceFrom, shop);
    const perMonth = {};
    for (const x of ds.list) {
      const m = monthOf(x.k); if (!inMonths.has(m)) continue;
      const pm = perMonth[m] || (perMonth[m] = { out: 0, outDays: [], units: 0, lost: 0, inDays: 0 });
      const outF = 1 - x.inF; pm.inDays += x.inF;
      if (outF <= 0) continue;
      const exp = pace.level > 0 ? pace.perDay * (pace.season[m] ?? 1) / pace.level : pace.perDay;
      pm.out += outF; pm.outDays.push(x.k); pm.units += outF * exp; pm.lost += outF * exp * price;
    }
    variants.push({ id, c, ds, price, pace, perMonth, sold: sn, units: su, dayMap: ds.list });
  }
  const byP = new Map();
  for (const v of variants) {
    const pid = String(v.c.productId || v.id);
    const p = byP.get(pid) || { productId: pid, name: v.c.product || v.c.sku || v.id, variants: [], sold: 0, units: 0 };
    p.variants.push(v); p.sold += v.sold; p.units += v.units; byP.set(pid, p);
  }
  const products = [...byP.values()].sort((a, b) => b.sold - a.sold);
  const total = products.reduce((s, p) => s + Math.max(0, p.sold), 0);
  let before = 0;
  for (const p of products) { p.share = total > 0 ? p.sold / total : 0; p.best = total > 0 && p.sold > 0 && before / total < bestShare; before += Math.max(0, p.sold); }
  /* per product per month: ₹ missed (sum of variants), days out (per day: the most-out selling variant), dates */
  const out = [];
  for (const p of products) {
    const top = p.variants.slice().sort((a, b) => b.sold - a.sold)[0];
    const selling = p.variants.filter((v) => v.pace.perDay > 0);
    const pm = {};
    for (const m of monthKeys) {
      let lost = 0, units = 0; const dayOut = new Map();
      for (const v of p.variants) { const x = v.perMonth[m]; if (!x) continue; lost += x.lost; units += x.units; }
      for (const v of selling) for (const x of v.dayMap) { if (monthOf(x.k) !== m || x.inF >= 1) continue; dayOut.set(x.k, Math.max(dayOut.get(x.k) || 0, 1 - x.inF)); }
      const ks = [...dayOut.keys()].sort();
      const daysOut = [...dayOut.values()].reduce((s, f) => s + f, 0);
      if (lost > 0 || daysOut > 0) pm[m] = { daysOut: r2(daysOut), dates: ks, range: ranges(ks), units: r2(units), lost: Math.round(lost) };
    }
    const tp = top.pace;
    out.push({
      productId: p.productId, name: p.name, sku: top.c.sku || '', variantId: top.id, variants: p.variants.length, best: p.best,
      sold: Math.round(p.sold), units: p.units, share: r2(p.share * 100),
      price: Math.round(top.price), pace: { perDay: r2(selling.reduce((s, v) => s + v.pace.perDay, 0)), basis: tp.basis, few: selling.every((v) => v.pace.few), inDays: tp.inDays, months: paceMonths },
      season: tp.season, months: pm,
      lost: Object.values(pm).reduce((s, x) => s + x.lost, 0), daysOut: r2(Object.values(pm).reduce((s, x) => s + x.daysOut, 0)),
      stockNow: p.variants.reduce((s, v) => s + Math.max(0, Number(y.anchor.levels[v.id]) || 0), 0),
      ...links(top.c),
    });
  }
  for (const p of out) {
    for (const [m, x] of Object.entries(p.months)) {
      const row = months.get(m); if (!row) continue;
      row.lostAll += x.lost;
      if (!p.best) continue;
      row.lost += x.lost; row.lostUnits += x.units;
      if (x.daysOut > 0) { row.bestOut++; row.daysOut += x.daysOut; }
    }
  }
  const mlist = [...months.values()].map((m) => ({ ...m, sold: Math.round(m.sold), lost: Math.round(m.lost), lostAll: Math.round(m.lostAll), lostUnits: Math.round(m.lostUnits), daysOut: r2(m.daysOut), pct: m.sold > 0 ? r2((m.lost / m.sold) * 100) : 0 }));
  const best = out.filter((p) => p.best);
  const sum = (k) => mlist.reduce((s, m) => s + m[k], 0);
  const headline = { from: mlist.find((m) => m.days)?.from || sp.from, through: sp.through, sold: sum('sold'), lost: sum('lost'), lostAll: sum('lostAll'), daysOut: r2(sum('daysOut')),
    bestsellers: best.length, bestRanOut: best.filter((p) => p.daysOut > 0).length, pct: 0, unsure: dropped.length };
  headline.pct = headline.sold > 0 ? r2((headline.lost / headline.sold) * 100) : 0;
  return {
    ok: true, span: { from: sp.from, through: sp.through, days: keys.length }, asOf: { readAt: y.at || null, stockAt: y.anchor.at || null, through: sp.through },
    settings: { paceMonths, bestShare }, months: mlist, headline, shopSeason: shop,
    products: out.sort((a, b) => b.lost - a.lost || b.sold - a.sold), dropped,
  };
}

/** One variant's 12 months for the drawer: day calendar (1 = in stock, 0 = out, ½), pace, season, ₹ missed per month. */
function variantYear(y, catalog, id, opts = {}) {
  const r = build(y, Object.hasOwn(catalog || {}, id) ? { [id]: catalog[id] } : {}, opts);
  if (!r.ok) return r;
  const c = catalog[id], sp = r.span;
  const ds = days(y, id, dayKeys(sp.from, sp.through), c && c.createdAt && opts.dayOf ? opts.dayOf(c.createdAt) : null);
  if (!ds || ds.dropped) return { ok: false, reason: ds && ds.dropped ? 'unsure' : 'none' };
  const p = r.products[0];
  const pace = p ? p.pace : null;
  return { ok: true, span: sp, asOf: r.asOf, calendar: ds.list.map((x) => [x.k, x.inF]), pace, season: p ? p.season : {}, months: p ? p.months : {}, price: p ? p.price : null, sold: p ? p.sold : 0, units: p ? p.units : 0 };
}

/**
 * Without Shopify's reports (demo, Flow, Sheet, CSV, or before the first 12-month read): the same shape from the rows we
 * hold. Sales by order date (units kept × price paid), stock changes per day from the stock rows, anchor = each variant's
 * newest stock row. dayOf(t) = the store-day key. Covers only the days we hold (120 at most).
 */
function fromRows(stock, orders, { dayOf, now = Date.now() } = {}) {
  if (!dayOf) throw new Error('fromRows needs dayOf');
  const today = dayOf(now);
  const sales = { by: {}, all: {} }, moves = { by: {} }, levels = {};
  let first = null;
  for (const o of orders || []) {
    if (!(o.t <= now)) continue;
    const k = dayOf(o.t), id = String(o.variantId), q = Number(o.qty) || 0, v = q * (Number(o.price) || 0);
    if (!first || k < first) first = k;
    const a = sales.all[k] || (sales.all[k] = [0, 0]); a[0] += q; a[1] = r2(a[1] + v);
    if (!q) continue;
    const m = sales.by[id] || (sales.by[id] = {}); const x = m[k] || (m[k] = [0, 0]); x[0] += q; x[1] = r2(x[1] + v);
  }
  const rows = (stock || []).filter((r) => r.t <= now && r.now != null && Number.isFinite(Number(r.now))).sort((a, b) => a.t - b.t);
  const last = new Map();
  for (const r of rows) {
    const id = String(r.variantId), k = dayOf(r.t);
    if (!first || k < first) first = k;
    const prev = last.has(id) ? last.get(id) : (r.before == null ? Number(r.now) : Number(r.before));
    const d = Number(r.now) - prev;
    if (d) { const m = moves.by[id] || (moves.by[id] = {}); m[k] = (m[k] || 0) + d; }
    last.set(id, Number(r.now));
  }
  for (const [id, L] of last) levels[id] = L;
  if (!first) return null;
  return { v: 1, rows: true, at: now, sales: { ...sales, from: first, to: keyPlus(today, -1) }, moves: { ...moves, from: first, to: keyPlus(today, -1) }, anchor: { at: now, day: today, levels } };
}

module.exports = { fromRows, build, variantYear, days, spanOf, shopSeason, paceOf, ranges, dayKeys, keyPlus, monthLabel, MIN_DAYS, FLOOR_DAYS, SEASON_K, SEASON_MIN, SEASON_CAP };
