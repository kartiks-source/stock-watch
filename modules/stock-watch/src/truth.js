'use strict';
/*
 * 2.0.0: one engine for every number on the screen (LOGIC.md §1–§9 of v2). Pure: year.json + catalog in, numbers out.
 *
 *   FACTS     what Shopify recorded: sold, price paid, stock at each day's end, the days a shelf was empty.
 *   ESTIMATE  lost = ₹ a Full day (last 90 days) x how busy the shop was x days empty x the brand's factor (src/model.js factors, 4.3)
 *             Days past the 60th of a gap: shown, never added. The day it ran out counts ½, the day it came back 0.
 *   PROOF     replayed stock-outs and real comebacks against what really sold (src/model.js tests); the range comes from them.
 *
 * One row = one variant (a size or colour is its own row). Every page counts rows the same way.
 */
const A = require('./agency');
const { keyPlus, spanOf, dayKeys, lifeOf, days: daysOf } = A;

const M = require('./model');
const RULE = '4.4';   // 4.4: 3+ pieces in the window; sold out too often lately: its last 60 in-stock days within the year. 4.3: × the brand's own factor
const YEAR_DAYS = 365, WINDOW = 365, BEST_SHARE = 0.8, MIN_RANGE = 5, MIN_PRICE = 100, LIST_DAYS = 60;   // under ₹100 = a gift line, not merchandise

const sum = (a) => a.reduce((s, x) => s + x, 0);

/** First day of the quarter `day` is in. */
const quarterStart = (day) => `${day.slice(0, 4)}-${String(Math.floor((+day.slice(5, 7) - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;

/** Everything Shopify recorded, per row, on one array of days. */
function facts(y, catalog, { dayOf, firstSeenDay = null, offOf = null, knownEnd = null } = {}) {
  const sp = spanOf(y); if (!sp) return null;
  const keys = dayKeys(sp.from, sp.through), n = keys.length, at = new Map(keys.map((k, i) => [k, i]));
  const winFrom = Math.max(0, n - WINDOW), rows = [];
  for (const [id, c] of Object.entries(catalog || {})) {
    if (!c || c.tracked === false) continue;
    const life = lifeOf(y, id, c, keys, { dayOf, firstSeenDay, winFrom: keys[winFrom], offOf });
    if (c.active === false && !life.sold) continue;
    const ds = daysOf(y, id, keys, life.from, { skip: life.skip, end: life.end, always: !!c.oversell, known: knownEnd ? knownEnd(id, sp.through) : null });
    if (!ds) continue;
    const u = new Float64Array(n), net = new Float64Array(n), st = new Int8Array(n).fill(-1), level = new Int32Array(n);   // st: -1 not on the website, 2 full shelf, 1 half day, 0 empty all day
    const sl = (y.sales.by && y.sales.by[id]) || {};
    for (const [k, x] of Object.entries(sl)) { const i = at.get(k); if (i != null) { u[i] = Number(x[0]) || 0; net[i] = Number(x[1]) || 0; } }
    if (!ds.dropped) for (const x of ds.list) { const i = at.get(x.k); level[i] = x.end; st[i] = x.inF === 1 ? 2 : x.inF === 0 ? 0 : x.end > 0 && x.start > 0 ? 2 : 1; }
    /* the day it went on the website (or came back on it) is not a day it ran out */
    for (let i = 0; i < n; i++) if (st[i] === 1 && level[i] > 0 && (i === 0 || st[i - 1] === -1)) st[i] = 2;
    const gaps = [];
    for (let i = 0; i < n; i++) {
      if (st[i] !== 0 && st[i] !== 1) continue;
      let b = i; while (b + 1 < n && (st[b + 1] === 0 || st[b + 1] === 1) && !(st[b] === 1 && level[b] > 0)) b++;
      let empty = 0; for (let k = i; k <= b; k++) empty += st[k] === 0 ? 1 : 0.5;
      const open = b === n - 1 && !(level[b] > 0), ended = !open && b + 1 < n && st[b + 1] === -1 ? 'off' : open ? null : 'back';
      gaps.push({ a: i, b, empty, open, ended, before: i === 0 || st[i - 1] === -1 });
      i = b;
    }
    let gu = 0, gn = 0; for (let i = 0; i < n; i++) { gu += u[i]; gn += net[i]; }
    rows.push({ id, c, gift: gu > 0 && gn / gu < MIN_PRICE, productId: String(c.productId || ''), u, net, st, level, gaps, unsure: !!ds.dropped, always: !!c.oversell, active: c.active !== false });
  }
  return { span: sp, keys, at, n, winFrom, rows };
}

/** Best sellers of a quarter: the variants making 80% of net sales in the 365 days before it began. Real sales only. */
function bestOf(F, y, q) {
  let to = F.at.has(q) ? F.at.get(q) - 1 : q > F.keys[F.n - 1] ? F.n - 1 : -1; if (to < LIST_DAYS - 1) to = Math.min(F.n - 1, LIST_DAYS * 1.5 | 0);   // a store with under 60 days before it: its first 90
  const from = Math.max(0, to - WINDOW + 1), list = [], lo = F.keys[from], hi = F.keys[to];   // every variant Shopify sold, drafts too: 80% means 80% of all of it
  for (const [id, m] of Object.entries((y.sales && y.sales.by) || {})) {
    let v = 0, all = 0, allU = 0;
    for (const [k, x] of Object.entries(m)) { if (k > F.keys[F.n - 1] || k < F.keys[0]) continue; all += Number(x[1]) || 0; allU += Number(x[0]) || 0; if (k >= lo && k <= hi) v += Number(x[1]) || 0; }
    if (v > 0 && !(allU > 0 && all / allU < MIN_PRICE)) list.push({ id, v });
  }
  list.sort((a, b) => b.v - a.v || (a.id < b.id ? -1 : 1));
  const tot = sum(list.map((x) => x.v)), rows = []; let c = 0;
  list.forEach((x, i) => { if (c < BEST_SHARE * tot) rows.push([x.id, i + 1, Math.round(x.v)]); c += x.v; });
  return { from: lo, to: hi, rows };
}

/** Running sums so a window's full-shelf pieces, ₹ and days are one subtraction. */
function sums(F) {
  for (const r of F.rows) {
    r.cu = new Float64Array(F.n + 1); r.cn = new Float64Array(F.n + 1); r.cd = new Float64Array(F.n + 1);
    for (let i = 0; i < F.n; i++) { const full = r.st[i] === 2 && !r.always && !r.unsure; r.cu[i + 1] = r.cu[i] + (full ? r.u[i] : 0); r.cn[i + 1] = r.cn[i] + (full ? r.net[i] : 0); r.cd[i + 1] = r.cd[i] + (full ? 1 : 0); }
  }
}
const win = (r, a, b) => ({ u: r.cu[b + 1] - r.cu[a], n: r.cn[b + 1] - r.cn[a], d: r.cd[b + 1] - r.cd[a] });

/* ---------- the report ---------- */
const MONTHS = 12, GRACE = 3;
const monthBack = (m, n) => { const t = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1 - n, 1)); return t.toISOString().slice(0, 7); };
const lastDay = (m) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);
const r2 = (x) => Math.round(x * 100) / 100, r4 = (x) => Math.round(x * 1e4) / 1e4;

/** Speed when in stock: the last 12 months plain, and what it sells now (the model's weighted average). */
function speedNow(F, r) {
  const a = Math.max(0, F.n - YEAR_DAYS), y = win(r, a, F.n - 1), s = M.speed(F, r, F.n, 1, false);   // 4.4: the pace now keeps the 1-piece minimum (days of stock); money needs 3
  return y.d ? { perDay: r4(Math.max(0, y.u) / y.d), units: y.u, days: y.d, from: F.keys[a], to: F.keys[F.n - 1], now: r4(s ? s.perDay : 0), nowUnits: s ? s.units : 0, nowDays: s ? s.days : 0 } : null;
}
const biasOut = (b) => (b ? { off: r4(b.off), low: r4(b.low), high: r4(b.high), n: b.n, products: b.products } : null);

/**
 * The whole report. ledger = what is locked already (src/ledger.js): { rule, lists: { quarter: { from, to, rows } }, months: { m: {...} } }.
 * → { ok, rule, span, months, year, now, rows, proof, best, lock } ; lock = what this build would add to the ledger.
 */
function report(y, catalog, opts = {}) {
  const F = facts(y, catalog, opts); if (!F) return { ok: false, reason: !y || !y.anchor ? 'none' : 'short' };
  const led = opts.ledger && opts.ledger.rule === RULE ? opts.ledger : { rule: RULE, lists: {}, months: {} };
  sums(F); F.shop = F.keys.map((k) => Number(((y.sales && y.sales.all) || {})[k]?.[1]) || 0); M.prepare(F);
  const lastM = F.keys[F.n - 1].slice(0, 7), monthKeys = []; for (let k = MONTHS - 1; k >= 0; k--) { const m = monthBack(lastM, k); if (F.keys[0] <= `${m}-01`) monthKeys.push(m); }
  if (!monthKeys.length) return { ok: false, reason: 'short', from: F.keys[0] };
  const lock = { lists: {}, months: {} }, lists = {}, q = quarterStart(F.keys[F.n - 1]);
  const listOf = (day) => {   // the list known at the start of that day's quarter (a quarter with under 60 days before it: the next one's)
    let k = quarterStart(day); while (k < q && (!F.at.has(k) || F.at.get(k) < LIST_DAYS)) k = quarterStart(keyPlus(k, 100));
    if (!lists[k]) { let L = led.lists[k]; if (!L) { L = bestOf(F, y, k); lock.lists[k] = L; } lists[k] = { ...L, map: new Map(L.rows.map(([id, rank, sold]) => [id, { rank, sold }])) }; }
    return lists[k];
  };
  F.bestAt = (r, t) => listOf(F.keys[Math.min(t, F.n - 1)]).map.has(r.id);   // 4.4: the older-days fallback is for best sellers only
  M.price(F);
  const cur = listOf(F.keys[F.n - 1]), best = cur.map;
  const FX = M.factors(F, (r, t) => listOf(F.keys[t]).map.has(r.id));   // 4.3: the brand's factors, from today's data (open months use them)
  const T = M.tests(F); for (const t of T) { t.best = listOf(F.keys[t.o]).map.has(t.id); t.guess *= FX[t.best ? 'best' : 'other'].f; }   // the same factor the money gets
  const gb = T.filter((t) => t.best), go = T.filter((t) => !t.best), range = M.ranger({ best: gb, other: go });
  const inM = new Set(monthKeys), first = F.at.get(`${monthKeys[0]}-01`), months = [], rowsM = new Map();   // rowsM: id → month → cell
  const cellOf = (id, m) => { if (!rowsM.has(id)) rowsM.set(id, {}); const x = rowsM.get(id); return x[m] || (x[m] = { empty: 0, lost: 0, later: 0, units: 0, best: false, parts: [] }); };
  const pr = (p) => ({ id: p.id, lost: p.lost || 0, units: p.units || 0, price: p.price || 0, best: p.best });
  const rgOf = (parts) => { const u = parts.filter((p) => p.lost > 0); const z = u.length >= MIN_RANGE ? range(u.map(pr)) : null; return { n: u.length, low: z ? Math.round(z.low) : null, high: z ? Math.round(z.high) : null }; };
  for (const m of monthKeys) {
    const a = F.at.get(`${m}-01`), b = Math.min(F.n - 1, F.at.get(lastDay(m)) ?? F.n - 1), over = F.keys[F.n - 1] >= keyPlus(lastDay(m), GRACE), list = listOf(`${m}-01`);
    const Mo = { key: m, from: F.keys[a], to: F.keys[b], days: b - a + 1, sold: 0, pieces: 0, bestSold: 0 };
    for (let i = a; i <= b; i++) { const t = (y.sales.all || {})[F.keys[i]] || [0, 0]; Mo.pieces += Number(t[0]) || 0; Mo.sold += Number(t[1]) || 0; }
    let L = led.months[m];
    if (!L) {
      const parts = [];
      for (const r of F.rows) for (const g of r.gaps) for (const p of g.parts) {
        if (p.month !== m) continue; const s = g.ref;
        const bs = list.map.has(r.id), grp = bs ? 'best' : 'other', k = FX[grp].f;
        parts.push({ id: r.id, start: F.keys[g.a], from: F.keys[p.s], to: F.keys[p.e], empty: p.empty, ...(bs ? { best: 1 } : {}), ...(g.no ? { no: g.no } : { first: p.first, later: p.later, sold: p.sold || undefined, sib: p.sib || undefined, speed: r4(s.perDay), ref: [F.keys[s.from], F.keys[s.to], s.days, s.units, s.yearDays, s.yearUnits], ...(s.fb ? { fb: 1 } : {}), busy: r4(p.busy), counted: r2(p.counted), adj: k, grp, perDay: r4(p.perDay), price: r2(s.price), units: r4(p.units * k), lost: r2(p.lost * k), laterLost: r2(p.laterLost * k) }) });
      }
      L = { at: opts.now || null, factor: FX, best: rgOf(parts.filter((p) => p.best)), all: rgOf(parts), parts };   // 4.3: a locked month keeps the factor it was locked with
      if (over) lock.months[m] = L;
    }
    Mo.closed = !!led.months[m] || over; Mo.lockedAt = L.at; Mo.factor = L.factor || FX;
    for (const p of L.parts) { const x = cellOf(p.id, m); x.empty += p.empty; x.best = x.best || !!p.best; x.parts.push(p); if (p.lost != null) { x.lost += p.lost; x.later += p.laterLost; x.units += p.units; } }
    for (const [id, c] of rowsM) if (c[m]) { const o = list.map.get(id); c[m].rank = o ? o.rank : null; }   // 4.2.0: rank on that month's list (screen only)
    Object.defineProperty(Mo, 'ids', { value: list.map, enumerable: false }); Mo.listN = list.map.size;   // 4.2.0: that month's best-seller list (Y in "X of Y")
    const began = (p) => p.start >= Mo.from && p.start <= Mo.to;
    for (const [k, l] of [['best', L.parts.filter((p) => p.best)], ['all', L.parts]]) Mo[k] = { empty: sum(l.map((p) => p.empty)), rows: new Set(l.map((p) => p.id)).size, ran: new Set(l.filter(began).map((p) => p.id)).size, lost: sum(l.map((p) => p.lost || 0)), later: sum(l.map((p) => p.laterLost || 0)), noMoney: sum(l.filter((p) => p.no).map((p) => p.empty)), ...L[k] };
    for (const r of F.rows) if (list.map.has(r.id)) for (let i = a; i <= b; i++) Mo.bestSold += r.net[i];
    Mo.parts = L.parts; months.push(Mo);
  }
  const rows = [];
  for (const r of F.rows) {
    let pieces = 0, sold = 0, last = null;
    for (let i = first; i < F.n; i++) { pieces += r.u[i]; sold += r.net[i]; if (r.u[i] > 0) last = F.keys[i]; }
    const g = r.gaps[r.gaps.length - 1], out = r.active && !r.always && !r.unsure && g && g.open ? g : null, ms = rowsM.get(r.id) || {}, b = best.get(r.id);
    if (!pieces && !out && !Object.keys(ms).length) continue;
    const gaps = r.gaps.filter((x) => x.b >= first), Tm = Object.entries(ms).filter(([m]) => inM.has(m)), all = Tm.flatMap(([, c]) => c.parts), rg = rgOf(all);
    rows.push({ id: r.id, productId: r.productId, name: r.c.product, variant: r.c.variant || '', sku: r.c.sku || '', active: r.active, always: r.always || undefined, unsure: r.unsure || undefined, best: !!b, rank: b ? b.rank : null, pieces, sold: Math.round(sold), price: pieces > 0 ? Math.round(sold / pieces) : null, lastSold: last,
      stock: r.level[F.n - 1], out: !!out, since: out ? (out.before && out.a === 0 ? null : F.keys[out.a]) : null, emptyNow: out ? out.empty : 0,
      empty: sum(Tm.map(([, c]) => c.empty)), times: gaps.length, months: Object.fromEntries(Tm.map(([m, c]) => [m, { empty: c.empty, best: c.best, rank: c.rank ?? null, lost: Math.round(c.lost), later: Math.round(c.later), parts: c.parts }])),
      ends: gaps.filter((x) => x.ended === 'back' && !x.before).map((x) => [F.keys[r.st[x.b] === 0 && x.b + 1 < F.n ? x.b + 1 : x.b], x.empty]),   // filed under the day it came back   // 4.2.0: stock-outs that came back: last day, empty days (days to refill)
      speed: speedNow(F, r), lost: Math.round(sum(Tm.map(([, c]) => c.lost))), lostBest: Math.round(sum(Tm.filter(([, c]) => c.best).map(([, c]) => c.lost))), later: Math.round(sum(Tm.map(([, c]) => c.later))), low: rg.low ?? undefined, high: rg.high ?? undefined,
      strip: [...r.st.subarray(first)].map((v) => (v === -1 ? '-' : v === 2 ? '2' : String(v))).join('') });
  }
  rows.sort((a, b) => (b.best - a.best) || (a.rank || 1e9) - (b.rank || 1e9) || b.sold - a.sold);
  const openGap = new Set(); for (const r of F.rows) for (const g of r.gaps) if (g.ended !== 'back') openGap.add(`${r.id}|${F.keys[g.a]}`);   // not back yet, or off the website: no comeback to check against
  const onLists = new Set(months.flatMap((m) => [...listOf(m.from).map.keys()]));
  const yr = (k) => { const l = months.flatMap((m) => (k === 'best' ? m.parts.filter((p) => p.best) : m.parts)); return { lost: Math.round(sum(l.map((p) => p.lost || 0))), later: Math.round(sum(l.map((p) => p.laterLost || 0))), empty: sum(l.map((p) => p.empty)), noMoney: sum(l.filter((p) => p.no).map((p) => p.empty)), ran: new Set(l.map((p) => p.id)).size, open: Math.round(sum(l.filter((p) => openGap.has(`${p.id}|${p.start}`)).map((p) => p.lost || 0))), ...rgOf(l) }; };
  const yb = yr('best'), ya = yr('all'), outRows = rows.filter((r) => r.out), sold = Math.round(sum(months.map((m) => m.sold))), bestSold = Math.round(sum(months.map((m) => m.bestSold)));
  for (const m of months) { m.sold = Math.round(m.sold); m.bestSold = Math.round(m.bestSold); for (const k of ['best', 'all']) for (const f of ['lost', 'later']) m[k][f] = Math.round(m[k][f]); delete m.parts; }
  const set = (k, l) => ({ back: biasOut(M.bias(l.filter((t) => t.kind === 'back'))), replay: biasOut(M.bias(l.filter((t) => t.kind === 'replay'))) });
  return {
    ok: true, rule: RULE, factor: FX, span: { from: months[0].from, to: F.keys[F.n - 1], held: F.keys[0] }, months,
    year: { sold, pieces: sum(months.map((m) => m.pieces)), bestSold, best: { ...yb, could: bestSold + yb.lost }, all: { ...ya, could: sold + ya.lost }, bestN: onLists.size, bestRan: yb.ran, bestNow: best.size, allRan: rows.filter((r) => r.empty > 0).length },
    now: { out: outRows.length, best: outRows.filter((r) => r.best).length, bestN: rows.filter((r) => r.best && r.active).length, onSale: F.rows.filter((r) => r.active).length },
    best: { quarter: q, from: cur.from, to: cur.to, n: best.size }, rows,
    proof: { all: set('all', T), best: set('best', gb), other: set('other', go), tests: T.length },
    lock: Object.keys(lock.lists).length || Object.keys(lock.months).length ? lock : null,
  };
}

module.exports = { RULE, GRACE, facts, bestOf, sums, report, win, quarterStart, K: { YEAR_DAYS, WINDOW, BEST_SHARE, MIN_PRICE, MIN_RANGE, ...M.K } };
