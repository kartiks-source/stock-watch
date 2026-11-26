'use strict';
/*
 * 2.0.0: the new numbers (src/truth.js, RULE.md) in the shapes the screens already read, so no page has its own sums.
 *   brand(t)            GET /api/brand: months, headline, products, best sellers now, ads
 *   period(rep, t, …)   GET /api/report: money missed for the period's full days
 *   profile(prof, t, id) the product panel: missed, stock-outs, "why this number"
 */
const agency = require('./agency');
const DAY = 864e5;
const COVER_WEEKS = 3, PUSH_A_WEEK = 1, SOON_DAYS = 7;
const r2 = (x) => Math.round(x * 100) / 100;
const sum = (a) => a.reduce((s, x) => s + x, 0);
const nameOf = (x) => x.variant ? `${x.name} · ${x.variant}` : x.name;
const pct = (a, b) => (b > 0 ? r2(a / b * 100) : 0);

/** The report's day keys, once per report. */
const KEYS = new WeakMap(), DAILY = new WeakMap();
function keysOf(t) {
  let k = KEYS.get(t); if (!k) { k = { list: [], at: new Map() }; for (let d = t.span.from; d <= t.span.to; d = agency.keyPlus(d, 1)) { k.at.set(d, k.list.length); k.list.push(d); } KEYS.set(t, k); }
  return k;
}
/** Day keys a row was empty (half days too) in from..to. */
function emptyDays(t, x, from, to) {
  const { list, at } = keysOf(t), out = [], s = x.strip || '', a = at.has(from) ? at.get(from) : from < t.span.from ? 0 : list.length, b = Math.min(s.length, at.has(to) ? at.get(to) + 1 : to > t.span.to ? list.length : 0);
  for (let i = a; i < b; i++) if (s[i] === '0' || s[i] === '1') out.push([list[i], s[i] === '0' ? 1 : 0.5]);
  return out;
}
/** [money, pieces] missed per day of a row: each part spread over its empty days up to the 60th. Once per report and row. */
function dailyOf(t, x) {
  let m = DAILY.get(x); if (m) return m; m = new Map();
  for (const mo of t.months) for (const p of (x.months[mo.key] || { parts: [] }).parts) {
    if (!(p.lost > 0)) continue;
    const limit = Date.parse(p.start) + 60 * DAY, ds = emptyDays(t, x, p.from, p.to).filter((z) => Date.parse(z[0]) < limit), all = sum(ds.map((z) => z[1])); if (!(all > 0)) continue;
    for (const [k, w] of ds) { const z = m.get(k) || [0, 0]; m.set(k, [z[0] + p.lost * w / all, z[1] + p.units * w / all]); }
  }
  DAILY.set(x, m); return m;
}
const WHY = { unsure: 'Shopify’s stock record doesn’t add up, or it sells at 0', gift: 'a gift line', 'started-empty': 'already empty when our record begins', 'few-days': 'fewer than 60 days on the shelf in the 90 days before, or nothing sold' };
/** ₹ a day a row that is out now keeps missing (0 when it carries no ₹, or it has been out over 60 days). */
function costNow(t, x) {
  if (!x.out) return 0;
  const m = t.months[t.months.length - 1], c = x.months[m.key], p = c && c.parts[c.parts.length - 1];
  return p && p.lost > 0 && p.to === m.to && Date.parse(m.to) - Date.parse(p.start) < 59 * DAY ? Math.round(p.perDay * p.price) : 0;
}
function cell(t, x, m) {
  const c = x.months[m.key]; if (!c) return null;
  const ds = emptyDays(t, x, m.from, m.to), keys = ds.map((z) => z[0]), no = [...new Set(c.parts.map((p) => p.no).filter(Boolean))], units = sum(c.parts.map((p) => p.units || 0));
  return { daysOut: c.empty, dates: keys, range: agency.ranges(keys), units: r2(units), countedUnits: r2(units), moneyDays: sum(c.parts.map((p) => p.first || 0)), lost: c.lost, counted: c.lost, best: c.best, later: c.later || 0, ...(no.length ? { no: no.map((k) => WHY[k] || k).join(', ') } : {}) };
}

function products(t) {
  const tot = sum(t.rows.map((x) => Math.max(0, x.sold)));
  return t.rows.map((x) => {
    const months = {}; for (const m of t.months) { const c = cell(t, x, m); if (c) months[m.key] = c; }
    const v = x.speed ? x.speed.perDay : 0, vn = x.speed ? x.speed.now : 0;
    return { productId: x.productId, variantId: x.id, ids: [x.id], name: nameOf(x), sku: x.sku, variants: 1, best: x.best, rank: x.rank, ...(x.active ? {} : { inactive: true }),
      sold: x.sold, units: x.pieces, share: pct(x.sold, tot), price: x.price || 0, pace: { perDay: r2(v), now: r2(vn), units: x.speed ? x.speed.units : 0, inDays: x.speed ? x.speed.days : 0 }, variantPace: { [x.id]: vn }, could: x.sold + (x.lost || 0), outFrom: { [x.id]: x.out ? x.since || t.span.held : null },
      months, times: x.times, monthsOut: Object.keys(months).length, lost: x.lost || 0, counted: x.lost || 0, lostBest: x.lostBest || 0, low: x.low, high: x.high, later: x.later || 0, daysOut: x.empty, stockNow: Math.max(0, x.stock), ...(x.unsure ? { unsure: 1 } : {}),
      image: x.image, adminUrl: x.adminUrl, webUrl: x.webUrl, life: x.life };
  });
}

function brand(t, { stockOf = null } = {}) {
  if (!t.ok || t.ready === false) return { ok: false, reason: t.reason || 'short' };
  const label = agency.monthLabel;
  const months = t.months.map((m) => {
    const of = (k, sold) => ({ lost: m[k].lost, low: m[k].low, high: m[k].high, n: m[k].n, later: m[k].later, out: m[k].rows, ran: m[k].ran, daysOut: m[k].empty, noMoney: m[k].noMoney, sold, pct: pct(m[k].lost, sold), late: 0, est: 0, nr: 0, apart: 0, total: m[k].lost, units: 0 });
    const best = of('best', m.bestSold), all = of('all', m.sold);
    return { key: m.key, label: label(m.key), from: m.from, to: m.to, days: m.days, sold: m.sold, units: m.pieces, closed: m.closed, best, all, lost: best.lost, pct: best.pct, bestOut: best.out, daysOut: best.daysOut };
  });
  const y = t.year, ps = products(t);
  const head = (k, o) => ({ lost: y[k].lost, low: y[k].low, high: y[k].high, later: y[k].later, could: y[k].could, open: y[k].open, noMoney: y[k].noMoney, daysOut: y[k].empty, late: 0, est: 0, nr: 0, apart: 0, total: y[k].lost, ...o, pct: pct(y[k].lost, o.sold) });
  const headline = { from: t.span.from, through: t.span.to, sold: y.sold, lost: y.best.lost, daysOut: y.best.empty, bestsellers: y.bestN, bestRanOut: y.bestRan, unsure: 0, best: head('best', { products: y.bestN, ranOut: y.bestRan, sold: y.bestSold }), all: head('all', { products: ps.length, ranOut: y.allRan, sold: y.sold }) };
  const last = months[months.length - 1];
  const now = t.rows.map((x, i) => ({ x, p: ps[i] })).filter(({ x }) => x.active).map(({ x, p }) => {
    const c = p.months[last.key];
    const live = stockOf ? stockOf(x.id) : null;
    return { ...p, months: undefined, id: x.id, out: x.out, outVariants: x.out ? 1 : 0, variantsLive: 1, outSince: null, outFromDay: x.out ? x.since || t.span.held : null, stock: live != null ? live : Math.max(0, x.stock), daysOutMonth: c ? c.daysOut : 0, rangeMonth: c ? c.range : '', lostMonth: c ? c.lost : 0, unitsMonth: c ? c.units : 0, missedMonthAll: c ? c.lost : 0, moneyDaysMonth: c ? c.moneyDays : 0, no: c ? c.no : null, costPerDay: costNow(t, x) };
  }).sort((a, b) => (b.out - a.out) || (b.lostMonth - a.lostMonth) || (b.sold - a.sold));
  return { ok: true, rule: t.rule, span: { from: t.span.from, through: t.span.to, days: sum(t.months.map((m) => m.days)) }, window: { from: t.span.from, through: t.span.to }, asOf: { through: t.span.to }, settings: { bestShare: 0.8, paceMonths: 0 }, months, headline, products: ps, proof: t.proof, bestList: t.best, countsNow: t.now,
    now: now.filter((p) => p.best), nowAll: now.filter((p) => !p.best), ads: ads(now) };
}

/** Ads: push what sells at least once a week and has 3+ weeks of stock; pause what can't be bought, or won't last a week. */
function ads(now) {
  const push = [], pause = [];
  for (const p of now) {
    const v = p.pace.now, wk = v * 7, row = { outFromDay: p.outFromDay, id: p.id, variantId: p.variantId, name: p.name, sku: p.sku, image: p.image, adminUrl: p.adminUrl, webUrl: p.webUrl, best: p.best, stock: p.stock, pace: v, price: p.price, perDayValue: Math.round(v * p.price), coverWeeks: wk > 0 ? r2(p.stock / wk) : null, daysLeft: v > 0 ? r2(p.stock / v) : null, costPerDay: p.costPerDay };
    if (p.out ? p.best || wk >= PUSH_A_WEEK : wk >= PUSH_A_WEEK && p.stock / v < SOON_DAYS) pause.push(row);
    else if (!p.out && wk >= PUSH_A_WEEK && row.coverWeeks >= COVER_WEEKS) push.push(row);
  }
  push.sort((a, b) => b.perDayValue - a.perDayValue); pause.sort((a, b) => (b.best - a.best) || b.perDayValue - a.perDayValue);
  return { push, pause, keep: [], coverDays: COVER_WEEKS * 7 };
}

/** ₹ and days missed by one row on the full days from..to (both in), day by day, so a period and a month can't disagree. */
function between(t, x, from, to) {
  let lost = 0, units = 0; for (const [k, [a, b]] of dailyOf(t, x)) if (k >= from && k <= to) { lost += a; units += b; }
  return { lost, units, empty: sum(emptyDays(t, x, from, to).map((z) => z[1])) };
}
/** The period report with its money from the one rule. Mutates and returns rep. */
function period(rep, t, { from, to, y = null, only = false }) {
  if (!rep || !t.ok || t.ready === false) return rep;
  const pause = new Set(brand(t).ads.pause.map((p) => p.id)), sl = (y && y.sales) || null;
  const soldOf = (m) => { let u = 0, v = 0; for (const [k, x] of Object.entries(m || {})) if (k >= from && k <= to) { u += Number(x[0]) || 0; v += Number(x[1]) || 0; } return [u, v]; };
  const by = new Map(t.rows.map((x) => [x.id, x])); let L = 0, N = 0;
  for (const list of [rep.products || [], rep.reorder || []]) for (const p of list) {
    const x = by.get(String(p.id)), b = x ? between(t, x, from, to) : { lost: 0, units: 0, empty: 0 }, lost = Math.round(b.lost);
    Object.assign(p, { lost, lostCounted: lost, lostEstimate: 0, lostNotRestocked: 0, lostAllocation: 0, lostOver30: 0, lostProfit: p.lostProfit == null ? p.lostProfit : 0, unitsLost: r2(b.units), lostPct: lost > 0 ? r2(lost / (lost + p.sold) * 100) : 0, daysEmpty: b.empty, costPerDay: x ? costNow(t, x) : 0, ...(x && x.out ? { outSinceDay: x.since } : {}) });
    if (sl) { const [u, v] = soldOf(sl.by[p.id]); p.sold = Math.round(v); p.unitsSold = u; p.lostPct = lost > 0 && lost + v > 0 ? r2(lost / (lost + v) * 100) : 0; }   // Shopify's sales report, full days
    if (x && p.status !== 'Inactive') {   // one speed and one "out now" everywhere
      const v = x.speed ? x.speed.now : 0, out = p.stock != null && p.stock <= 0 && !x.always;
      Object.assign(p, { perDay: r2(x.speed ? x.speed.perDay : 0), daysLeft: p.stock == null ? null : out ? 0 : v > 0 ? Math.round(p.stock / v * 10) / 10 : null, status: out ? 'Out now' : v > 0 && p.stock / v < SOON_DAYS ? 'Critical' : v > 0 ? 'OK' : 'Slow seller', mkt: pause.has(x.id) ? 'pause' : null, abc: x.best ? 'A' : p.abc === 'A' ? 'B' : p.abc,
        why: out ? (x.since ? `Out since ${agency.ranges([x.since])}` : x.out ? 'Out since before our record' : 'Out since today') : v > 0 ? `About ${Math.round(p.stock / v)} days of stock` : 'No sales lately' });
    }
    Object.assign(p, { trendPct: null, trendCall: null, trendNew: false, confidence: null, lossPace: null });
    if (list === rep.products) { L += lost; if (lost > 0) N++; }
  }
  const T = rep.totals || {}; Object.assign(T, { lost: L, lostAll: L, lostEstimate: 0, lostNotRestocked: 0, lostAllocation: 0, lostEstimateProducts: 0, lostNotRestockedProducts: 0, lostAllocationProducts: 0, lostProducts: N, lostPct: T.sold + L > 0 ? r2(L / (T.sold + L) * 100) : 0, stillOutPerDay: sum((rep.products || []).map((p) => p.costPerDay || 0)), stillOutPerDayApart: 0, ...(T.lostProfit != null ? { lostProfit: 0 } : {}) });
  if (sl) { const [u, v] = only ? [sum(rep.products.map((p) => p.unitsSold || 0)), sum(rep.products.map((p) => p.sold || 0))] : soldOf(sl.all); Object.assign(T, { sold: Math.round(v), unitsSold: u }); }
  if (T.sold + L > 0) T.lostPct = r2(L / (T.sold + L) * 100);
  const perDay = new Map(); for (const x of t.rows) if (!only || x.best) for (const [k, z] of dailyOf(t, x)) perDay.set(k, (perDay.get(k) || 0) + z[0]);
  for (const d of rep.daily || []) { const v = perDay.get(d.day) || 0; d.lost = Math.round(v); if (sl) { const [u, w] = [Number((sl.all[d.day] || [])[0]) || 0, Number((sl.all[d.day] || [])[1]) || 0]; if (d.day <= to) { d.sold = Math.round(w); d.units = u; } } }
  for (const s of rep.stockouts || []) { s.lost = 0; s.lostCounted = 0; }
  if (rep.yesterday) rep.yesterday.lost = Math.round(perDay.get(rep.yesterday.day) || 0);
  if (rep.yesterday && sl && sl.all[rep.yesterday.day]) rep.yesterday.sold = Math.round(sl.all[rep.yesterday.day][1]);
  rep.rule = t.rule; rep.moneyThrough = to;
  return rep;
}

/** The panel: the old profile's sales, price and stock parts, with money, stock-outs and the working from the one rule. */
function profile(prof, t, id) {
  const x = t.ok && t.ready !== false ? t.rows.find((r) => r.id === String(id)) : null;
  if (!prof || !prof.ok || !x) return prof;
  const gaps = new Map();
  for (const m of t.months) for (const p of (x.months[m.key] || { parts: [] }).parts) { const g = gaps.get(p.start) || { start: p.start, from: p.from, to: p.to, days: 0, lost: 0, later: 0, parts: [], best: !!p.best }; g.to = p.to; g.days += p.empty; g.parts.push({ ...p, month: m.key, closed: m.closed }); g.lost += p.lost || 0; g.later += p.laterLost || 0; gaps.set(p.start, g); }
  const list = [...gaps.values()].sort((a, b) => a.start < b.start ? -1 : 1);
  const longest = list.slice().sort((a, b) => b.days - a.days)[0];
  for (const m of prof.months) {
    const M = t.months.find((z) => z.key === m.key), c = M ? cell(t, x, M) : null;
    Object.assign(m, { missed: c ? c.lost : 0, missedUnits: c ? c.units : 0, apart: 0, later: c ? c.later : 0, daysOut: c ? c.daysOut : 0, no: c ? c.no || null : null });
  }
  const cal = []; let k0 = t.span.from; for (const c of x.strip) { if (c !== '-') cal.push([k0, c === '2' ? 1 : c === '1' ? 0.5 : 0]); k0 = agency.keyPlus(k0, 1); }
  const inD = sum(cal.map((z) => z[1]));
  Object.assign(prof, { calendar: cal, inStock: { days: r2(inD), of: cal.length, pct: cal.length ? Math.round(inD / cal.length * 100) : null }, best: x.best, rank: x.rank ? { n: x.rank, of: t.best.n, list: true } : null, season: null,
    pace: { ...prof.pace, perDay: x.speed ? r2(x.speed.perDay) : 0, perWeek: x.speed ? r2(x.speed.perDay * 7) : 0, perMonth: x.speed ? r2(x.speed.perDay * 30.4) : 0, sixMonths: x.speed ? r2(x.speed.perDay) : 0, basis: 'rule', speed: x.speed },
    outs: { times: x.times, days: r2(x.empty), longest: longest ? { from: longest.from, to: longest.to, days: r2(longest.days) } : null, open: x.out, since: x.since },
    could: x.sold + (x.lost || 0), missed: { value: x.lost || 0, units: r2(sum(prof.months.map((m) => m.missedUnits))), apart: 0, low: x.low ?? null, high: x.high ?? null, later: x.later || 0 },
    work: { rule: t.rule, best: x.best, gaps: list, proof: x.best ? t.proof.best : t.proof.other, why: WHY } });
  return prof;
}

module.exports = { brand, ads, products, period, between, profile, emptyDays, costNow, WHY };
