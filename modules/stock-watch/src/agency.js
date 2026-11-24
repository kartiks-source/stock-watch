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
 * further below 0 (an oversell to −1 is not "in stock", §2); they never count in the pace. A walk that goes more than
 * OVERSELL (2) below min(stock now, 0) means the log is incomplete for that variant: dropped (unsure), like §1c.
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
 * 12 months' net sales, among products on sale now. opts.apart = variant IDs of website allocations (§6): their refill gaps
 * stay on the product (allocation: true) but out of the month totals and the headline (lostApart).
 */
const DAY = 864e5;
const MIN_DAYS = 14;          // in-stock days the pace needs before it widens to 12 months
const FLOOR_DAYS = 7;         // never divide by fewer in-stock days (same as §3)
const SEASON_K = 14;          // blend weight: a month with 14 in-stock days counts half its own, half the shop's
const SEASON_MIN = 7;         // under this many in-stock days in a month: the shop's index
const SEASON_CAP = [0.5, 2];
const MONTHS = 12;
const OVERSELL = 2;            // stock may sit this far below min(now, 0) after checkout races before a walk counts as broken
const SEASON_UNITS = 12;
const SHOP_MIN_DAYS = 60;     // in-stock product-days a month needs before the shop's index uses them (else its sales a day)      // a variant that sold fewer than this in the year follows the shop's season (its own months are noise)

const keyPlus = (key, n) => new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const monthOf = (k) => k.slice(0, 7);
const clamp = (x, [a, b]) => Math.min(b, Math.max(a, x));
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
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
  const floor = Math.min(L0, 0) - OVERSELL;   // an oversell race can leave −1 or −2 for a while (§2); deeper = the log is missing changes
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

/** The shop's index per month from every variant's in-stock days (units on in-stock days ÷ in-stock days that month, ÷ the
 *  same over the span), so months with many stock-outs don't look quiet; capped. Without any (e.g. no variants): sales.all. */
function shopSeasonOf(lists, keys, y) {
  const per = new Map(); let tu = 0, td = 0;
  for (const list of lists) for (const x of list) {
    if (!(x.inF > 0)) continue;
    const m = monthOf(x.k), p = per.get(m) || { u: 0, d: 0 };
    p.u += x.u - x.over; p.d += x.inF; per.set(m, p); tu += x.u - x.over; td += x.inF;
  }
  if (!(td > 0) || !(tu > 0)) return shopSeason(y, keys);
  const avg = tu / td, out = {}, raw = shopSeason(y, keys);
  const daysIn = new Map(); for (const k of keys) daysIn.set(monthOf(k), (daysIn.get(monthOf(k)) || 0) + 1);
  for (const [m, n] of daysIn) {
    const p = per.get(m);
    out[m] = n < SEASON_MIN ? 1 : p && p.d >= SHOP_MIN_DAYS ? r2(clamp(p.u / p.d / avg, SEASON_CAP)) : raw[m];   // too few in-stock product-days: the shop's sales a day
  }
  return out;
}
/** A month's index; a month not held yet (the 1st of a month) uses the same month a year before. */
const seasonFor = (season, m) => season[m] ?? season[`${+m.slice(0, 4) - 1}${m.slice(4)}`] ?? 1;

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
  /* 1.4.0 fix (live check, 24 Nov): the index is per calendar month (Nov 2025 and Nov 2026 pooled) and smoothed over the
     month either side (weights 1-2-1), so a month the product was mostly out still gets its own season from its neighbours
     (Oakwood: out most of Nov, Oct 0.45 and Dec 0.77 a day in stock → its winter rise, not the shop's post-Diwali dip) */
  const cal = new Map();   // 'MM' → { u, d }
  for (const [m, p] of per) { const c = cal.get(m.slice(5)) || { u: 0, d: 0 }; c.u += p.u; c.d += p.d; cal.set(m.slice(5), c); }
  const mm = (k, n) => String(((+k - 1 + n + 12) % 12) + 1).padStart(2, '0');
  const season = {}, own = {};
  for (const m of Object.keys(shop)) {
    const k = m.slice(5), a = cal.get(mm(k, -1)) || { u: 0, d: 0 }, c = cal.get(k) || { u: 0, d: 0 }, b = cal.get(mm(k, 1)) || { u: 0, d: 0 };
    const U = a.u + 2 * c.u + b.u, Dd = a.d + 2 * c.d + b.d;
    if (Dd < 2 * SEASON_MIN || !(year > 0) || all.u < SEASON_UNITS) { season[m] = shop[m]; continue; }
    const raw = U / Dd / year, w = Dd / (Dd + 2 * SEASON_K);
    season[m] = r2(clamp(w * raw + (1 - w) * shop[m], SEASON_CAP)); own[m] = true;
  }
  /* the average index of the days the pace was measured on */
  let wi = 0, wd = 0;
  for (const x of list) if ((basis === 'year' || x.k >= paceFrom) && x.inF > 0) { wi += x.inF * (season[monthOf(x.k)] ?? 1); wd += x.inF; }
  const level = wd > 0 ? wi / wd : 1;
  return { perDay, units: use.u, inDays: r2(use.d), basis, few, season, own, level: r2(level), yearUnits: all.u, yearInDays: r2(all.d) };
}

/** The first day of the stock-out still running at the end of the span (the last day out or half out), else null. */
function outRun(list) {
  if (!list.length || list[list.length - 1].inF >= 1) return null;
  let i = list.length - 1;
  while (i > 0 && list[i - 1].inF < 1) i--;
  return list[i].k;
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
function build(y, catalog = {}, { paceMonths = 6, bestShare = 0.8, links = () => ({}), dayOf = null, apart = null, rankBy = null, detail = null, rowInfo = null } = {}) {
  const sp = spanOf(y);
  if (!sp) return { ok: false, reason: !y || !y.anchor ? 'none' : 'short' };
  const keys = dayKeys(sp.from, sp.through);
  const paceFrom = keyPlus(sp.through, -Math.round(paceMonths * 30.44) + 1);
  /* months: the 12 calendar months ending with the month of `through` (the first may be part-held) */
  const lastM = monthOf(sp.through), nowM = monthOf(keyPlus(sp.through, 1)), monthKeys = [];   // nowM: the month of the day after the last full day (today's)
  for (let i = MONTHS - 1; i >= 0; i--) { const d = new Date(Date.UTC(+lastM.slice(0, 4), +lastM.slice(5, 7) - 1 - i, 1)); monthKeys.push(d.toISOString().slice(0, 7)); }
  const inMonths = new Set(monthKeys);
  /* store sales per month (every sales row: the total Shopify shows) */
  const months = new Map(monthKeys.map((m) => [m, { key: m, label: monthLabel(m), from: null, to: null, days: 0, sold: 0, units: 0, lost: 0, lostUnits: 0, lostAll: 0, bestOut: 0, daysOut: 0, lostApart: 0 }]));
  for (const k of keys) {
    const m = months.get(monthOf(k)); if (!m) continue;
    const t = (y.sales.all || {})[k] || [0, 0];
    m.sold += Number(t[1]) || 0; m.units += Number(t[0]) || 0; m.days++;
    if (!m.from) m.from = k; m.to = k;
  }
  /* variants: their days first (live from max(created, published) inside the span), then the shop's season from them */
  const vlist = [], dropped = [];
  for (const [id, c] of Object.entries(catalog || {})) {
    if (!c || c.active === false || c.tracked === false) continue;
    const liveMs = Math.max(+c.createdAt || 0, +c.publishedAt || 0);
    const ds = days(y, id, keys, liveMs && dayOf ? dayOf(liveMs) : null);
    if (!ds) continue;
    if (ds.dropped) dropped.push(id);   // unsure: its sales still count (best-seller rank, sold), no days, no ₹
    vlist.push({ id, c, ds: ds.dropped ? { list: [], live: null, unsure: true } : ds });
  }
  const shop = shopSeasonOf(vlist.map((v) => v.ds.list), keys, y);
  const variants = [];
  for (const { id, c, ds } of vlist) {
    const sl = (y.sales.by && y.sales.by[id]) || {};
    /* 1.4.5: sold and price over the same 12 months as the month table (Shopify's totals for those months), not the whole
       span (which reaches back into the 13th month); the span only when it never sold inside the 12 months */
    let su = 0, sn = 0, au = 0, an = 0;
    for (const k of keys) { const x = sl[k]; if (!x) continue; const u = Number(x[0]) || 0, n = Number(x[1]) || 0; au += u; an += n; if (inMonths.has(monthOf(k))) { su += u; sn += n; } }
    const price = su > 0 && sn > 0 ? sn / su : au > 0 && an > 0 ? an / au : Number(c.price) || 0;
    const pace = paceOf(ds.list, paceFrom, shop);
    /* 1.4.4 (LOGIC §22): the same parts as every other page (§4c). opts.rowInfo[variantId] = { confidence, nrDays, ordered,
       allocation } from today's report. Per day out, in this order: after day nrDays of the stock-out still running with
       nothing marked ordered → "restock or drop?" (nr); a website top-up (alloc, §6); low confidence → a guess (est); else
       counted. */
    const info = (rowInfo && rowInfo[String(id)]) || null;
    const isApart = !!((apart && apart.has(String(id))) || (info && info.allocation));
    const openFrom = outRun(ds.list), nrFrom = openFrom && info && !info.ordered ? keyPlus(openFrom, Math.max(1, Math.round(+info.nrDays || 30))) : null;
    const low = !!(info && info.confidence === 'low');
    const perMonth = {};
    for (const x of ds.list) {
      const m = monthOf(x.k); if (!inMonths.has(m)) continue;
      const pm = perMonth[m] || (perMonth[m] = { out: 0, outDays: [], units: 0, lost: 0, apart: 0, nr: 0, est: 0, inDays: 0 });
      const outF = 1 - x.inF; pm.inDays += x.inF;
      if (outF <= 0) continue;
      const exp = pace.level > 0 ? pace.perDay * (pace.season[m] ?? 1) / pace.level : pace.perDay;
      const v = outF * exp * price;
      pm.out += outF; pm.outDays.push(x.k); pm.units += outF * exp; pm.lost += v;
      if (nrFrom && x.k >= nrFrom) pm.nr += v; else if (isApart) pm.apart += v; else if (low) pm.est += v;
    }
    variants.push({ id, c, ds, price, pace, perMonth, sold: sn, units: su, dayMap: ds.list, isApart });
  }
  const byP = new Map();
  for (const v of variants) {
    const pid = String(v.c.productId || v.id);
    const p = byP.get(pid) || { productId: pid, name: v.c.product || v.c.sku || v.id, variants: [], sold: 0, units: 0 };
    p.variants.push(v); p.sold += v.sold; p.units += v.units; byP.set(pid, p);
  }
  /* best sellers rank on the 12 months; while under 300 days are held (a first load still reading), on opts.rankBy
     (Shopify's 26 weeks of net sales per variant, src/weeks.js) when given, so a short span after Diwali can't reshuffle them */
  const short = keys.length < 300 && rankBy && Object.keys(rankBy).length;
  for (const p of byP.values()) p.rank = short ? p.variants.reduce((s, v) => s + (Number(rankBy[v.id]) || 0), 0) : p.sold;
  const products = [...byP.values()].sort((a, b) => b.rank - a.rank);
  const total = products.reduce((s, p) => s + Math.max(0, p.rank), 0);
  let before = 0;
  for (const p of products) { p.share = total > 0 ? p.rank / total : 0; p.best = total > 0 && p.rank > 0 && before / total < bestShare; before += Math.max(0, p.rank); }
  /* per product per month: ₹ missed (sum of variants), days out (per day: the most-out selling variant), dates */
  const out = [];
  for (const p of products) {
    const top = p.variants.slice().sort((a, b) => b.sold - a.sold)[0];
    const selling = p.variants.filter((v) => v.pace.perDay > 0);
    const pm = {};
    for (const m of monthKeys) {
      let lost = 0, units = 0, ap = 0, nr = 0, est = 0; const dayOut = new Map();
      for (const v of p.variants) { const x = v.perMonth[m]; if (!x) continue; lost += x.lost; units += x.units; ap += x.apart; nr += x.nr; est += x.est; }
      for (const v of selling) for (const x of v.dayMap) { if (monthOf(x.k) !== m || x.inF >= 1) continue; dayOut.set(x.k, Math.max(dayOut.get(x.k) || 0, 1 - x.inF)); }
      const ks = [...dayOut.keys()].sort();
      const daysOut = [...dayOut.values()].reduce((s, f) => s + f, 0);
      if (lost > 0 || daysOut > 0) pm[m] = { daysOut: r2(daysOut), dates: ks, range: ranges(ks), units: r2(units), lost: Math.round(lost), counted: Math.round(lost - ap - nr - est),
        ...(ap > 0 ? { apart: Math.round(ap) } : {}), ...(nr > 0 ? { nr: Math.round(nr) } : {}), ...(est > 0 ? { est: Math.round(est) } : {}) };
    }
    const tp = top.pace;
    out.push({
      productId: p.productId, name: p.name, sku: top.c.sku || '', variantId: top.id, variants: p.variants.length, best: p.best,
      monthPace: Object.fromEntries(p.variants.map((v) => [v.id, { ...Object.fromEntries(Object.keys(shop).map((m) => [m, r4(v.pace.perDay * seasonFor(v.pace.season, m) / (v.pace.level || 1))])), _: r4(v.pace.perDay * seasonFor(v.pace.season, nowM) / (v.pace.level || 1)) }])),   // 1.4.3: §21 expected pace per month, for the engine's ₹ lost
      variantPrice: Object.fromEntries(p.variants.map((v) => [v.id, r4(v.price)])),
      ids: p.variants.map((v) => v.id), outFrom: Object.fromEntries(p.variants.map((v) => [v.id, outRun(v.dayMap)])), variantPace: Object.fromEntries(p.variants.map((v) => [v.id, r2(v.pace.perDay * seasonFor(v.pace.season, nowM) / (v.pace.level || 1))])),
      sold: Math.round(p.sold), units: p.units, share: r2(p.share * 100),
      price: Math.round(top.price), pace: { perDay: r2(selling.reduce((s, v) => s + v.pace.perDay, 0)), basis: tp.basis, few: selling.every((v) => v.pace.few), inDays: tp.inDays, months: paceMonths },
      season: tp.season, months: pm,
      lost: Object.values(pm).reduce((s, x) => s + x.lost, 0), counted: Object.values(pm).reduce((s, x) => s + x.counted, 0), daysOut: r2(Object.values(pm).reduce((s, x) => s + x.daysOut, 0)),
      stockNow: p.variants.reduce((s, v) => s + Math.max(0, Number(y.anchor.levels[v.id]) || 0), 0),
      ...links(top.c),
      ...(p.variants.some((v) => v.isApart) ? { allocation: true, ...(p.variants.every((v) => v.isApart) ? { allApart: true } : {}) } : {}),
      ...(p.variants.some((v) => v.ds.unsure) ? { unsure: p.variants.filter((v) => v.ds.unsure).length } : {}),
    });
  }
  /* 1.4.4: every month in two scopes, best sellers and all products: counted (the headline), and the parts kept apart */
  const scopeRow = () => ({ lost: 0, est: 0, nr: 0, apart: 0, total: 0, units: 0, out: 0, daysOut: 0 });
  for (const m of months.values()) { m.best = scopeRow(); m.all = scopeRow(); }
  for (const p of out) {
    for (const [m, x] of Object.entries(p.months)) {
      const row = months.get(m); if (!row) continue;
      const ap = x.apart || 0, allApart = ap > 0 && ap >= x.lost - 1;   // a product that is all top-up: its days apart too
      for (const sc of p.best ? [row.best, row.all] : [row.all]) {
        sc.lost += x.counted; sc.est += x.est || 0; sc.nr += x.nr || 0; sc.apart += ap; sc.total += x.lost; sc.units += x.units * (x.lost > 0 ? x.counted / x.lost : 1);
        if (x.daysOut > 0 && !allApart) { sc.out++; sc.daysOut += x.daysOut; }
      }
      row.lostAll += x.lost;
    }
  }
  for (const m of months.values()) {
    for (const k of ['best', 'all']) { const sc = m[k]; for (const f of ['lost', 'est', 'nr', 'apart', 'total']) sc[f] = Math.round(sc[f]); sc.units = Math.round(sc.units); sc.daysOut = r2(sc.daysOut); sc.pct = m.sold > 0 ? r2((sc.lost / m.sold) * 100) : 0; }
    m.lost = m.best.lost; m.lostApart = m.best.apart; m.lostUnits = m.best.units; m.bestOut = m.best.out; m.daysOut = m.best.daysOut;   // 1.4.0 names = best sellers
  }
  const mlist = [...months.values()].map((m) => ({ ...m, sold: Math.round(m.sold), lost: Math.round(m.lost), lostAll: Math.round(m.lostAll), lostUnits: Math.round(m.lostUnits), lostApart: Math.round(m.lostApart), daysOut: r2(m.daysOut), pct: m.sold > 0 ? r2((m.lost / m.sold) * 100) : 0 }));
  const scopeHead = (k, list) => { const t = scopeRow(); for (const m of mlist) for (const f of ['lost', 'est', 'nr', 'apart', 'total', 'units', 'daysOut']) t[f] += m[k][f]; t.daysOut = r2(t.daysOut);
    t.products = list.length; t.ranOut = list.filter((p) => p.daysOut > 0 && !p.allApart).length; t.missed = list.filter((p) => p.lost > 0).length; delete t.out; return t; };
  const best = out.filter((p) => p.best);
  const sum = (k) => mlist.reduce((s, m) => s + m[k], 0);
  const headline = { from: mlist.find((m) => m.days)?.from || sp.from, through: sp.through, sold: sum('sold'), lost: sum('lost'), lostAll: sum('lostAll'), daysOut: r2(sum('daysOut')),
    bestsellers: best.length, bestRanOut: best.filter((p) => p.daysOut > 0 && !p.allApart).length, pct: 0, unsure: dropped.length,
    lostApart: sum('lostApart'), apart: best.filter((p) => p.allocation).length };
  headline.pct = headline.sold > 0 ? r2((headline.lost / headline.sold) * 100) : 0;
  headline.best = scopeHead('best', best); headline.all = scopeHead('all', out);
  for (const k of ['best', 'all']) headline[k].pct = headline.sold > 0 ? r2((headline[k].lost / headline.sold) * 100) : 0;
  const dv = detail && detail !== true ? variants.find((v) => v.id === String(detail)) : null;
  const det = (v) => ({ id: v.id, list: v.dayMap, pace: v.pace, perMonth: v.perMonth, price: v.price, sold: v.sold, units: v.units, isApart: v.isApart, unsure: !!v.ds.unsure, monthKeys, nowM });
  const res = {
    ...(dv ? { detail: det(dv) } : {}),
    ok: true, span: { from: sp.from, through: sp.through, days: keys.length }, asOf: { readAt: y.at || null, stockAt: y.anchor.at || null, through: sp.through },
    settings: { paceMonths, bestShare }, months: mlist, headline, shopSeason: shop,
    products: out.sort((a, b) => b.lost - a.lost || b.sold - a.sold), dropped,
  };
  /* 1.4.3: detail: true keeps every variant's days for the drawer (not sent: non-enumerable) */
  if (detail === true) Object.defineProperty(res, 'details', { value: Object.fromEntries(variants.map((v) => [v.id, det(v)])), enumerable: false });
  return res;
}

/**
 * 1.4.1 (LOGIC §24): the product drawer's profile for one variant, from a build() run with { detail: id } on the whole
 * catalog (so rank, share and the shop's season are the store's). Pure. → { ok, span, asOf, rank, best, sold, share, pace,
 * inStock, outs, missed, lastRestock, price, months[12], calendar, stock, restocks, season, story } or { ok: false, reason }.
 * opts: { collections: [{ title, productIds }], gstFrom: optional } — catalog details are added by the server.
 */
function profile(r, y, catalog, id) {
  if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || 'none' };
  const d = r.detail && r.detail.id === String(id) ? r.detail : r.details && r.details[String(id)];
  if (!d) return { ok: false, reason: 'none' };
  if (d.unsure) return { ok: false, reason: 'unsure' };
  const c = catalog[id] || {};
  const first = `${r.months[0].key}-01`, through = r.span.through;
  const list = d.list.filter((x) => x.k >= first);
  const sl = (y.sales.by && y.sales.by[id]) || {}, mv = (y.moves.by && y.moves.by[id]) || {};
  /* sold, ₹, GST, gross over the 12 months, and per month */
  const tot = { u: 0, n: 0, t: 0, g: 0 }, mon = new Map(r.months.map((m) => [m.key, { u: 0, n: 0, t: 0, g: 0 }]));
  for (const [k, x] of Object.entries(sl)) {
    if (k < first || k > through) continue;
    const m = mon.get(monthOf(k)); if (!m) continue;
    const u = +x[0] || 0, n = +x[1] || 0, t = +x[2] || 0, g = +x[3] || 0;
    m.u += u; m.n += n; m.t += t; m.g += g; tot.u += u; tot.n += n; tot.t += t; tot.g += g;
  }
  const storeSold = r.months.reduce((s, m) => s + m.sold, 0);
  /* in stock, stock-outs (runs of days not fully in stock), longest, missed */
  let inDays = 0, live = 0, times = 0, outDays = 0, run = null, longest = null;
  const close = () => { if (run && (!longest || run.days > longest.days)) longest = { ...run }; run = null; };
  for (const x of list) {
    live++; inDays += x.inF;
    if (x.inF < 1) { outDays += 1 - x.inF; if (!run) { times++; run = { from: x.k, to: x.k, days: 0 }; } run.to = x.k; run.days += 1 - x.inF; } else close();
  }
  const open = !!run, since = run ? run.from : null; close();
  let missed = 0, missedUnits = 0;
  for (const [m, x] of Object.entries(d.perMonth)) if (r.months.some((mm) => mm.key === m)) { missed += x.lost; missedUnits += x.units; }
  /* the last restock: the newest day the stock went up */
  let lastRestock = null;
  for (const k of Object.keys(mv).sort()) if (+mv[k] > 0 && k <= keyPlus(through, 1)) lastRestock = { day: k, qty: +mv[k] };
  /* pace on in-stock days over the 12 months */
  const pu = list.reduce((s, x) => s + (x.inF > 0 ? x.u - x.over : 0), 0);
  const perDay = inDays > 0 ? pu / Math.max(inDays, FLOOR_DAYS) : 0;
  /* price: list (incl. GST), MRP (compare at), paid ex and incl GST, GST %, off MRP and off the list price */
  const list$ = +c.price || 0, mrp = +c.compareAt > list$ ? +c.compareAt : null;
  const paidEx = tot.u > 0 ? tot.n / tot.u : null, gst = tot.n > 0 && tot.t > 0 ? tot.t / tot.n : null;
  const paidIn = paidEx != null ? paidEx * (1 + (gst || 0)) : null;
  const price = { list: list$, mrp, paidEx: paidEx != null ? Math.round(paidEx) : null, paidIn: paidIn != null ? Math.round(paidIn) : null, gstPct: gst != null ? r2(gst * 100) : null,
    offMrpPct: mrp && paidIn ? r2((1 - paidIn / mrp) * 100) : null, offListPct: list$ && paidIn ? r2((1 - paidIn / list$) * 100) : null,
    byMonth: r.months.map((m) => { const x = mon.get(m.key); return { key: m.key, units: x.u, paidEx: x.u > 0 ? Math.round(x.n / x.u) : null, paidIn: x.u > 0 ? Math.round((x.n + x.t) / x.u) : null }; }) };
  /* 12 months: units, ₹, missed units / ₹, days out, in-stock days, season */
  const months = r.months.map((m) => {
    const x = mon.get(m.key), pm = d.perMonth[m.key] || { out: 0, units: 0, lost: 0, inDays: 0 };
    return { key: m.key, label: m.label, from: m.from, to: m.to, days: m.days, units: Math.max(0, x.u), value: Math.round(x.n), missedUnits: r2(pm.units), missed: Math.round(pm.lost), daysOut: r2(pm.out || 0), inDays: r2(pm.inDays || 0), season: d.pace.season[m.key] ?? 1, own: !!d.pace.own[m.key] };
  });
  /* season: busiest / quietest calendar months (own index where it has the days, else the store's), same month last year */
  const cal = new Map();
  for (const [m, v] of Object.entries(d.pace.season)) if (!cal.has(m.slice(5)) || m > cal.get(m.slice(5)).m) cal.set(m.slice(5), { m, v, own: !!d.pace.own[m] });
  const ranked = [...cal.values()].sort((a, b) => b.v - a.v);
  const nowM = d.nowM, prevM = `${+nowM.slice(0, 4) - 1}${nowM.slice(4)}`;
  const monthStat = (m) => {
    let u = 0, din = 0, n = 0;
    for (const x of d.list) if (monthOf(x.k) === m) { u += x.u; din += x.inF; n++; }
    return n ? { key: m, units: u, inDays: r2(din), days: n, perDay: din > 0 ? r2(u / din) : null } : null;
  };
  const season = { busiest: ranked.filter((x) => x.v >= 1.1).slice(0, 3), quietest: ranked.filter((x) => x.v <= 0.9).slice(-3).reverse(), own: ranked.some((x) => x.own),
    thisMonth: monthStat(nowM) || monthStat(monthOf(through)), lastYear: monthStat(prevM) || monthStat(`${+monthOf(through).slice(0, 4) - 1}${monthOf(through).slice(4)}`) };
  /* rank by 12 months' sales among products on sale now */
  const byS = r.products.slice().sort((a, b) => b.sold - a.sold);
  const pi = byS.findIndex((p) => (p.ids || [p.variantId]).includes(String(id)));
  const prod = pi >= 0 ? byS[pi] : null;
  const out = {
    ok: true, span: { from: list.length ? list[0].k : first, through, days: list.length }, asOf: r.asOf,
    rank: pi >= 0 ? { n: pi + 1, of: byS.length } : null, best: !!(prod && prod.best), allocation: !!d.isApart,
    sold: { units: tot.u, value: Math.round(tot.n) }, share: storeSold > 0 ? r2((tot.n / storeSold) * 100) : 0,
    pace: { perDay: r2(perDay), perWeek: r2(perDay * 7), perMonth: r2(perDay * 30.4), sixMonths: r2(d.pace.perDay), basis: d.pace.basis },
    inStock: { days: r2(inDays), of: live, pct: live ? Math.round((inDays / live) * 100) : null },
    outs: { times, days: r2(outDays), longest: longest ? { ...longest, days: r2(longest.days) } : null, open, since },
    missed: { value: Math.round(missed), units: r2(missedUnits) },
    lastRestock, price, months,
    calendar: list.map((x) => [x.k, x.inF]),
    stock: list.map((x) => [x.k, x.end, x.u, +(mv[x.k] || 0)]), restocks: Object.entries(mv).filter(([k, q]) => k >= first && k <= through && +q > 0).map(([k, q]) => [k, +q]).sort(),
    season,
  };
  return out;
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
  const today = dayOf(now), oldest = keyPlus(today, -399);   // 1.4.4: at most the 400 days the Shopify read holds (a stray old row can't make a 50-year walk)
  const sales = { by: Object.create(null), all: Object.create(null) }, moves = { by: Object.create(null) }, levels = Object.create(null);
  let first = null;
  for (const o of orders || []) {
    if (!(o.t <= now)) continue;
    const k = dayOf(o.t), id = String(o.variantId), q = Number(o.qty) || 0, v = q * (Number(o.price) || 0);
    if (k < oldest) continue;
    if (!first || k < first) first = k;
    const a = sales.all[k] || (sales.all[k] = [0, 0]); a[0] += q; a[1] = r2(a[1] + v);
    if (!q) continue;
    const m = sales.by[id] || (sales.by[id] = {}); const x = m[k] || (m[k] = [0, 0]); x[0] += q; x[1] = r2(x[1] + v);
  }
  const rows = (stock || []).filter((r) => r.t <= now && r.now != null && Number.isFinite(Number(r.now))).sort((a, b) => a.t - b.t);
  const last = new Map();
  for (const r of rows) {
    const id = String(r.variantId), k0 = dayOf(r.t), k = k0 < oldest ? oldest : k0;   // older changes land on the first day held
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

module.exports = { profile, shopSeasonOf, seasonFor, outRun, OVERSELL, SEASON_UNITS, fromRows, build, variantYear, days, spanOf, shopSeason, paceOf, ranges, dayKeys, keyPlus, monthLabel, MIN_DAYS, FLOOR_DAYS, SEASON_K, SEASON_MIN, SEASON_CAP };
