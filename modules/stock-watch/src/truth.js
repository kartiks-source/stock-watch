'use strict';
/*
 * 2.0.0: one engine for every number on the screen (LOGIC.md §1–§9 of v2). Pure: year.json + catalog in, numbers out.
 *
 *   FACTS     what Shopify recorded: sold, price paid, stock at each day's end, the days a shelf was empty.
 *   ESTIMATE  lost = speed x month x price x days empty        could have earned = sold + lost
 *               speed  pieces a day when it is in stock: the last 12 months, or its last 60 full-shelf days, whichever is slower
 *               month  how that month ran for the best sellers that stayed in stock, against their own year
 *               price  what people paid on those last 60 days (net of discounts, returns and GST)
 *             Only for best sellers with 5+ pieces on 30+ full-shelf days. Days past the 60th of a gap: shown, not added.
 *             The day it ran out or came back is half a day, and what it sold on a day comes off that day.
 *   PROOF     the same rule on best sellers that stayed in stock, and on ones that came back, against what really sold.
 *
 * One row = one variant (a size or colour is its own row). Every page counts rows the same way.
 */
const A = require('./agency');
const { keyPlus, spanOf, dayKeys, lifeOf, days: daysOf } = A;

const RULE = '2.0';
const REF_DAYS = 60, YEAR_DAYS = 365, GUARD = 3, MIN_SHELF = 30, MIN_UNITS = 5, LONG_GAP = 60, GATE_HIGH = 0.25, FAST = 1;
const PEER_SHARE = 0.8, PAT_REST = 60;
const WINDOW = 365, BEST_SHARE = 0.8, GATE = 0.15, MIN_RANGE = 5, MIN_PRICE = 100;   // under ₹100 = a gift line, not merchandise

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

/** Best sellers: the rows making 80% of net sales in the 365 days before the quarter began. Real sales only, fixed for the quarter. */
function bestOf(F, y) {
  const q = quarterStart(F.keys[F.n - 1]);
  let to = F.at.has(q) ? F.at.get(q) - 1 : F.n - 1; if (to < 89) to = F.n - 1;   // a store with under 90 days before the quarter: all it has
  const from = Math.max(0, to - WINDOW + 1);
  const list = [], lo = F.keys[from], hi = F.keys[to];   // every variant Shopify sold, drafts too: 80% means 80% of all of it
  for (const [id, m] of Object.entries((y.sales && y.sales.by) || {})) {
    let v = 0, u = 0, all = 0, allU = 0;
    for (const [k, x] of Object.entries(m)) { if (k > F.keys[F.n - 1] || k < F.keys[0]) continue; all += Number(x[1]) || 0; allU += Number(x[0]) || 0; if (k >= lo && k <= hi) { v += Number(x[1]) || 0; u += Number(x[0]) || 0; } }
    if (v > 0 && !(allU > 0 && all / allU < MIN_PRICE)) list.push({ id, v });
  }
  list.sort((a, b) => b.v - a.v || (a.id < b.id ? -1 : 1));
  const tot = sum(list.map((x) => x.v)), best = new Map(); let c = 0;
  list.forEach((x, i) => { if (c < BEST_SHARE * tot) best.set(x.id, { rank: i + 1, sold: x.v }); c += x.v; });
  return { best, from: F.keys[from], to: F.keys[to], total: tot };
}

/** Running sums so a window's full-shelf pieces, ₹ and days are one subtraction. */
function sums(F) {
  for (const r of F.rows) {
    r.cu = new Float64Array(F.n + 1); r.cn = new Float64Array(F.n + 1); r.cd = new Float64Array(F.n + 1);
    for (let i = 0; i < F.n; i++) { const full = r.st[i] === 2 && !r.always && !r.unsure; r.cu[i + 1] = r.cu[i] + (full ? r.u[i] : 0); r.cn[i + 1] = r.cn[i] + (full ? r.net[i] : 0); r.cd[i + 1] = r.cd[i] + (full ? 1 : 0); }
  }
}
const win = (r, a, b) => ({ u: r.cu[b + 1] - r.cu[a], n: r.cn[b + 1] - r.cn[a], d: r.cd[b + 1] - r.cd[a] });

/** Per month: full-shelf pieces and days of every row, for the month pattern. */
function monthly(F) {
  F.mkeys = [...new Set(F.keys.map((k) => k.slice(0, 7)))]; F.mi = F.keys.map((k) => F.mkeys.indexOf(k.slice(0, 7))); F.mlen = F.mkeys.map((_, j) => F.mi.filter((x) => x === j).length); F.pat = new Map();
  for (const r of F.rows) { r.mu = F.mkeys.map(() => 0); r.md = F.mkeys.map(() => 0); r.tu = r.td = 0; for (let i = 0; i < F.n; i++) if (r.st[i] === 2) { r.mu[F.mi[i]] += r.u[i]; r.md[F.mi[i]]++; r.tu += r.u[i]; r.td++; } }
}
/** How month j ran: the best sellers in stock 80%+ of it, their speed that month against their own other months (the product itself left out). */
function pattern(F, best, j, productId) {
  const k = `${j}|${productId}`; if (F.pat.has(k)) return F.pat.get(k);
  let x = 0, y = 0, n = 0;
  for (const p of F.rows) { if (!best.has(p.id) || p.always || p.unsure || p.gift || p.productId === productId || p.md[j] < PEER_SHARE * F.mlen[j] || p.td - p.md[j] < PAT_REST) continue; x += p.mu[j] / p.md[j]; y += (p.tu - p.mu[j]) / (p.td - p.md[j]); n++; }
  const v = { x: n >= 5 && y > 0 ? Math.max(0, x / y) : 1, n }; F.pat.set(k, v); return v;
}
/** The speed known before day a: pieces ÷ full-shelf days, over up to 365 days and over the last 60, each with the months' patterns taken out. */
function reference(F, r, a, best) {
  const mk = () => ({ units: 0, net: 0, days: 0, norm: 0, from: null, to: null }), y = mk(), w = mk();
  for (let i = a - GUARD - 1; i >= Math.max(0, a - YEAR_DAYS); i--) {
    if (r.st[i] !== 2) continue; const q = pattern(F, best, F.mi[i], r.productId).x;
    for (const z of w.days < REF_DAYS ? [y, w] : [y]) { z.units += r.u[i]; z.net += r.net[i]; z.days++; z.norm += q; z.from = i; if (z.to == null) z.to = i; }
  }
  if (!y.days) return null;
  const sp = (z) => (z.norm > 0 ? Math.max(0, z.units) / z.norm : 0), sy = sp(y), sw = sp(w);
  return { y, w, sy, sw, normal: Math.min(sy, sw), used: sw < sy ? 'w' : 'y', units: w.units, days: w.days, price: w.units > 0 ? w.net / w.units : y.units > 0 ? y.net / y.units : 0 };
}
/** Days s..e of a month cut per calendar month. */
function byMonth(F, a, b) { const out = []; for (let i = a; i <= b;) { let e = i; while (e < b && F.keys[e + 1].slice(0, 7) === F.keys[i].slice(0, 7)) e++; out.push([i, e]); i = e + 1; } return out; }

/** Why a gap carries no ₹ (null = it does). */
function why(F, r, g, ref, isBest) {
  if (!isBest) return 'not-best';
  if (r.unsure || r.always) return 'unsure';
  if (g.before) return 'started-empty';
  if (!ref || ref.days < MIN_SHELF) return 'few-days';
  if (ref.units < MIN_UNITS) return 'few-sold';
  return null;
}

/** Every gap of every row, priced. */
function price(F, best) {
  for (const r of F.rows) for (const g of r.gaps) {
    const sib = F.rows.filter((p) => p !== r && p.productId === r.productId);
    g.ref = best.has(r.id) ? reference(F, r, g.a, best) : null; g.no = why(F, r, g, g.ref, best.has(r.id)); g.parts = [];
    for (const [s, e] of byMonth(F, g.a, g.b)) {
      const part = { month: F.keys[s].slice(0, 7), s, e, empty: 0, first: 0, later: 0, sib: 0, sold: 0, units: 0, laterUnits: 0 };
      const pt = g.no ? null : pattern(F, best, F.mi[s], r.productId), x = g.no ? 0 : g.ref.normal * pt.x;
      for (let i = s; i <= e; i++) {
        const d = r.st[i] === 0 ? 1 : 0.5; part.empty += d;
        if (sib.some((p) => p.st[i] === 2)) { part.sib += d; continue; }
        const late = i - g.a >= LONG_GAP; part[late ? 'later' : 'first'] += d;
        if (g.no) continue;
        const sold = Math.max(0, r.u[i]); if (!late) part.sold += sold;
        part[late ? 'laterUnits' : 'units'] += Math.max(0, Math.min(d * x, x - sold));   // what it sold that day comes off
      }
      if (!g.no) Object.assign(part, { pattern: pt.x, patternN: pt.n, perDay: x, lost: part.units * g.ref.price, laterLost: part.laterUnits * g.ref.price });
      g.parts.push(part);
    }
  }
  return F;
}

/**
 * PROOF: pretend a best seller that stayed in stock ran out on day s (the 1st and 16th of every month) for H days; guess with the rule;
 * compare with Shopify's net sales of those days. → [{ id, month, guess, real, days }] (cut per calendar month)
 */
function tests(F, best, { H = 30 } = {}) {
  const out = [];
  for (let s = 0; s + 13 < F.n; s++) {
    if (!/-(01|16)$/.test(F.keys[s])) continue;
    const e = Math.min(F.n - 1, s + H - 1);
    for (const r of F.rows) {
      if (!best.has(r.id) || r.unsure || r.always) continue;
      const w = win(r, s, e); if (w.d < PEER_SHARE * (e - s + 1)) continue;
      const ref = reference(F, r, s, best); if (!ref || ref.days < MIN_SHELF || ref.units < MIN_UNITS) continue;
      for (const [a, b] of byMonth(F, s, e)) { const z = win(r, a, b); out.push({ id: r.id, month: F.keys[a].slice(0, 7), slow: ref.normal < FAST, guess: ref.normal * pattern(F, best, F.mi[a], r.productId).x * z.d * ref.price, real: z.n, days: z.d }); }
    }
  }
  return out;
}
/** After a real gap of 3+ empty days ended: days 4–30 back on the shelf, the rule's guess (from before the gap) vs what sold. */
function comebacks(F, best) {
  const out = [];
  for (const r of F.rows) for (const g of r.gaps) {
    if (g.open || g.ended !== 'back' || g.no || g.empty < 3) continue;
    const a = g.b + 4, b = Math.min(F.n - 1, g.b + 30); if (b - a < 6) continue;
    const z = win(r, a, b); if (z.d < 7) continue;
    let guess = 0; for (const [x, e] of byMonth(F, a, b)) guess += g.ref.normal * pattern(F, best, F.mi[x], r.productId).x * win(r, x, e).d * g.ref.price;
    out.push({ id: r.id, gap: g.empty, guess, real: z.n, days: z.d });
  }
  return out;
}

/* ---------- the report ---------- */
const MONTHS = 12, GRACE = 3, TEST_MIN = 20, SIMS = 400;
const monthBack = (m, n) => { const t = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1 - n, 1)); return t.toISOString().slice(0, 7); };
const lastDay = (m) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);
const r2 = (x) => Math.round(x * 100) / 100, r4 = (x) => Math.round(x * 1e4) / 1e4;
/** A fixed random sequence: the same data always gives the same range. */
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** How far the guess was off, per month: { 'YYYY-MM': { n, rows, guess, real, off, pass } } */
function score(list) {
  const by = {};
  for (const t of list) { const q = by[t.month] || (by[t.month] = { n: 0, guess: 0, real: 0, ids: new Set() }); q.n++; q.guess += t.guess; q.real += t.real; q.ids.add(t.id); }
  return Object.fromEntries(Object.entries(by).sort().map(([m, q]) => { const off = q.real > 0 ? q.guess / q.real - 1 : null; return [m, { n: q.n, rows: q.ids.size, guess: Math.round(q.guess), real: Math.round(q.real), off: off == null ? null : r4(off), pass: off != null && q.n >= TEST_MIN && off <= GATE_HIGH }]; }));
}
/**
 * Low and high for a list of { month, lost }: 400 replays. Each replay draws, per month, how far the whole month's guess was off
 * (its tested products drawn again at random: the error every estimate of that month shares) and, per estimate, how far one test was off
 * around that. 5th and 95th of the 400; the low end also takes the comeback score when that is under 1; never tighter than ±15% (the gate).
 */
function range(parts, list, cap = 1) {
  const pools = new Map();
  for (const t of list) { if (!(t.guess > 0)) continue; for (const k of [t.month, '*']) { if (!pools.has(k)) pools.set(k, { by: new Map(), e: [], c: [], w: 0, G: 0, R: 0 }); const q = pools.get(k), z = q.by.get(t.id) || [0, 0]; z[0] += t.guess; z[1] += t.real; q.by.set(t.id, z); q.w += t.guess; q.e.push(t.real / t.guess); q.c.push(q.w); q.G += t.guess; q.R += t.real; } }
  const use = parts.filter((p) => p.lost > 0); if (!use.length || !pools.has('*')) return null;
  const rnd = rng(20261125), out = [], pool = (m) => { const q = pools.get(m); return q && q.e.length >= TEST_MIN ? q : pools.get('*'); }, months = [...new Set(use.map((p) => p.month))];
  for (const q of pools.values()) q.rows = [...q.by.values()];
  const one = (q) => { const x = rnd() * q.w; let a = 0, b = q.c.length - 1; while (a < b) { const m = (a + b) >> 1; if (q.c[m] < x) a = m + 1; else b = m; } return Math.max(0, q.e[a]); };
  for (let k = 0; k < SIMS; k++) {
    const shared = {};
    for (const m of months) { const q = pool(m); let g = 0, r = 0; for (let i = 0; i < q.rows.length; i++) { const z = q.rows[Math.floor(rnd() * q.rows.length)]; g += z[0]; r += z[1]; } shared[m] = g > 0 ? Math.max(0, r / g) : 1; }
    let t = 0; for (const p of use) { const q = pool(p.month), mean = q.R / q.G || 1; t += p.lost * shared[p.month] * (one(q) / mean); }
    out.push(t);
  }
  out.sort((a, b) => a - b);
  const point = sum(use.map((p) => p.lost));
  if (use.length < MIN_RANGE) return null;   // under 5 estimates: days and ₹, no range
  return { low: Math.min(point * (1 - GATE), out[Math.floor(SIMS * 0.05)] * Math.min(1, cap)), high: Math.max(point * (1 + GATE), out[Math.floor(SIMS * 0.95)]) };
}

/** Speed when in stock: the last 12 months, and the last 60 full-shelf days (what it sells now). Plain pieces ÷ days. */
function speedNow(F, r) {
  const a = Math.max(0, F.n - YEAR_DAYS), y = win(r, a, F.n - 1); let d = 0, u = 0, from = null, to = null;
  for (let i = F.n - 1; i >= a && d < REF_DAYS; i--) if (r.st[i] === 2) { d++; u += r.u[i]; from = i; if (to == null) to = i; }
  return y.d ? { perDay: r4(Math.max(0, y.u) / y.d), units: y.u, days: y.d, from: F.keys[a], to: F.keys[F.n - 1], now: r4(Math.max(0, u) / d), nowUnits: u, nowDays: d, nowFrom: F.keys[from], nowTo: F.keys[to] } : null;
}

/**
 * The whole report. ledger = what is locked already (src/ledger.js): { rule, lists: { quarter: [[id, rank, sold]] }, months: { m: {...} } }.
 * → { ok, rule, span, months, year, now, rows, proof, best, lock } ; lock = what this build would add to the ledger.
 */
function report(y, catalog, opts = {}) {
  const F = facts(y, catalog, opts); if (!F) return { ok: false, reason: !y || !y.anchor ? 'none' : 'short' };
  const led = opts.ledger && opts.ledger.rule === RULE ? opts.ledger : { rule: RULE, lists: {}, months: {} };
  sums(F); monthly(F);
  const q = quarterStart(F.keys[F.n - 1]), fresh = bestOf(F, y), lock = { lists: {}, months: {} };
  let cur = led.lists[q]; if (!cur) { cur = { from: fresh.from, to: fresh.to, rows: [...fresh.best].map(([id, x]) => [id, x.rank, Math.round(x.sold)]) }; lock.lists[q] = cur; }
  const best = new Map(cur.rows.map(([id, rank, sold]) => [id, { rank, sold }]));
  price(F, best);
  const T30all = tests(F, best, { H: 30 }), T60 = tests(F, best, { H: 60 }).filter((t) => t.slow), T30 = T30all.filter((t) => t.slow), sc = score(T30), cb = comebacks(F, best), cbG = sum(cb.map((x) => x.guess)), back = cbG > 0 && cb.length >= TEST_MIN ? sum(cb.map((x) => x.real)) / cbG : null;
  const cap = back == null ? 1 : back;
  const lastM = F.keys[F.n - 1].slice(0, 7), monthKeys = []; for (let k = MONTHS - 1; k >= 0; k--) { const m = monthBack(lastM, k); if (F.keys[0] <= `${m}-01`) monthKeys.push(m); }
  if (!monthKeys.length) return { ok: false, reason: 'short', from: F.keys[0] };
  const inM = new Set(monthKeys), first = F.at.get(`${monthKeys[0]}-01`);
  const months = [], rowsM = new Map();   // rowsM: id → month → cell
  const cellOf = (id, m) => { if (!rowsM.has(id)) rowsM.set(id, {}); const x = rowsM.get(id); return x[m] || (x[m] = { empty: 0, lost: 0, later: 0, units: 0, parts: [] }); };
  for (const m of monthKeys) {
    const a = F.at.get(`${m}-01`), b = Math.min(F.n - 1, F.at.get(lastDay(m)) ?? F.n - 1), over = F.keys[F.n - 1] >= keyPlus(lastDay(m), GRACE);
    const M = { key: m, from: F.keys[a], to: F.keys[b], days: b - a + 1, closed: false, sold: 0, pieces: 0, bestSold: 0 };
    for (let i = a; i <= b; i++) { const t = (y.sales.all || {})[F.keys[i]] || [0, 0]; M.pieces += Number(t[0]) || 0; M.sold += Number(t[1]) || 0; }
    let L = led.months[m];
    if (!L) {
      const parts = [];
      for (const r of F.rows) for (const g of r.gaps) for (const p of g.parts) {
        if (p.month !== m) continue;
        parts.push({ id: r.id, start: F.keys[g.a], from: F.keys[p.s], to: F.keys[p.e], empty: p.empty, ...(best.has(r.id) ? { best: 1, ...(g.no ? { no: g.no } : { first: p.first, later: p.later, sold: p.sold || undefined, sib: p.sib || undefined, normal: r4(g.ref.normal), used: g.ref.used, pattern: r4(p.pattern), patternN: p.patternN, perDay: r4(p.perDay), price: r2(g.ref.price), units: r4(p.units), lost: r2(p.lost), laterLost: r2(p.laterLost) }), ...(g.ref ? { y: [F.keys[g.ref.y.from], F.keys[g.ref.y.to], g.ref.y.days, g.ref.y.units, r4(g.ref.sy)], w: g.ref.w.days ? [F.keys[g.ref.w.from], F.keys[g.ref.w.to], g.ref.w.days, g.ref.w.units, r4(g.ref.sw)] : null } : {}) } : {}) });
      }
      const s = sc[m] || { n: 0, rows: 0, off: null, pass: false }, cut = s.off > 0 ? 1 / (1 + s.off) : 1;   // the month's own test came out too high: cut by as much, never raised
      if (cut < 1) for (const p of parts) if (p.lost != null) { p.cut = r4(cut); p.units = r4(p.units * cut); p.lost = r2(p.lost * cut); p.laterLost = r2(p.laterLost * cut); }
      const rg = range(parts.map((p) => ({ month: m, lost: p.lost || 0 })), T30, cap);
      L = { at: opts.now || null, list: q, score: s, low: rg ? Math.round(rg.low) : null, high: rg ? Math.round(rg.high) : null, n: parts.filter((p) => p.lost > 0).length, parts };
      L.thin = L.n > 0 && L.n < MIN_RANGE;
      if (over) lock.months[m] = L;
    }
    M.closed = !!led.months[m] || over; M.lockedAt = L.at; M.score = L.score; M.pass = !!L.score.pass && !L.thin; M.why = !L.score.pass ? (L.score.n < TEST_MIN ? 'few-tests' : 'high') : L.thin ? 'thin' : null;
    for (const p of L.parts) { const x = cellOf(p.id, m); x.empty += p.empty; x.best = x.best || !!p.best; x.parts.push(p); if (p.lost != null) { x.lost += p.lost; x.later += p.laterLost; x.units += p.units; } }
    const bIds = new Set(L.parts.filter((p) => p.best).map((p) => p.id)), began = (p) => p.start >= M.from && p.start <= M.to;
    M.best = { empty: sum(L.parts.filter((p) => p.best).map((p) => p.empty)), rows: bIds.size, ran: new Set(L.parts.filter((p) => p.best && began(p)).map((p) => p.id)).size, lost: M.pass ? sum(L.parts.map((p) => p.lost || 0)) : null, low: M.pass ? L.low : null, high: M.pass ? L.high : null, n: L.n ?? null, later: M.pass ? sum(L.parts.map((p) => p.laterLost || 0)) : null, noMoney: sum(L.parts.filter((p) => p.best && p.no && p.no !== 'refill').map((p) => p.empty)) };
    M.all = { empty: sum(L.parts.map((p) => p.empty)), rows: new Set(L.parts.map((p) => p.id)).size, ran: new Set(L.parts.filter(began).map((p) => p.id)).size };
    M.raw = { list: L.list, parts: L.parts };
    months.push(M);
  }
  const ok = new Set(months.filter((m) => m.pass).map((m) => m.key));
  /* rows */
  const rows = [];
  for (const r of F.rows) {
    let pieces = 0, sold = 0, last = null;
    for (let i = first; i < F.n; i++) { pieces += r.u[i]; sold += r.net[i]; if (r.u[i] > 0) last = F.keys[i]; }
    const g = r.gaps[r.gaps.length - 1], out = r.active && !r.always && !r.unsure && g && g.open ? g : null, ms = rowsM.get(r.id) || {}, b = best.get(r.id);
    if (!pieces && !out && !Object.keys(ms).length) continue;
    const gaps = r.gaps.filter((x) => x.b >= first), T = Object.entries(ms).filter(([m]) => inM.has(m)), sh = T.filter(([m]) => ok.has(m));
    const x = { id: r.id, productId: r.productId, name: r.c.product, variant: r.c.variant || '', sku: r.c.sku || '', active: r.active, always: r.always || undefined, unsure: r.unsure || undefined, best: !!b, rank: b ? b.rank : null, pieces, sold: Math.round(sold), price: pieces > 0 ? Math.round(sold / pieces) : null, lastSold: last,
      stock: r.level[F.n - 1], out: !!out, since: out ? (out.before && out.a === 0 ? null : F.keys[out.a]) : null, emptyNow: out ? out.empty : 0,
      empty: sum(T.map(([, c]) => c.empty)), times: gaps.length, months: Object.fromEntries(T.map(([m, c]) => [m, { empty: c.empty, lost: ok.has(m) && c.best ? Math.round(c.lost) : null, later: ok.has(m) ? Math.round(c.later) : null, parts: c.parts }])),
      speed: speedNow(F, r), lost: b ? Math.round(sum(sh.map(([, c]) => c.lost))) : null, later: b ? Math.round(sum(sh.map(([, c]) => c.later))) : null, strip: null };
    if (b && x.lost > 0) { const rg = range(sh.flatMap(([m, c]) => c.parts.map((p) => ({ month: m, lost: p.lost || 0 }))), T30, cap); if (rg) { x.low = Math.round(rg.low); x.high = Math.round(rg.high); } }
    x.strip = [...r.st.subarray(first)].map((v) => (v === -1 ? '-' : v === 2 ? '2' : String(v))).join('');
    rows.push(x);
  }
  rows.sort((a, b) => (b.best - a.best) || (a.rank || 1e9) - (b.rank || 1e9) || b.sold - a.sold);
  for (const M of months) M.bestSold = Math.round(sum(F.rows.filter((r) => best.has(r.id)).map((r) => { let v = 0; for (let i = F.at.get(M.from); i <= F.at.get(M.to); i++) v += r.net[i]; return v; })));
  const all = months.filter((m) => m.pass), rg = range(all.flatMap((M) => M.raw.parts.map((p) => ({ month: M.key, lost: p.lost || 0 }))), T30, cap);
  const bRows = rows.filter((r) => r.best), outRows = rows.filter((r) => r.out);
  for (const M of months) { M.sold = Math.round(M.sold); for (const k of ['lost', 'later']) if (M.best[k] != null) M.best[k] = Math.round(M.best[k]); delete M.raw; }
  const G = sum(T30.map((t) => t.guess)), R = sum(T30.map((t) => t.real)), Ga = sum(T30all.map((t) => t.guess)), Ra = sum(T30all.map((t) => t.real));
  return {
    ok: true, rule: RULE, span: { from: months[0].from, to: F.keys[F.n - 1], held: F.keys[0] }, months,
    year: { sold: sum(months.map((m) => m.sold)), pieces: sum(months.map((m) => m.pieces)), bestSold: sum(months.map((m) => m.bestSold)), lost: sum(months.map((m) => m.best.lost || 0)), could: sum(months.map((m) => m.bestSold + (m.best.lost || 0))), low: rg ? Math.round(rg.low) : 0, high: rg ? Math.round(rg.high) : 0, later: sum(months.map((m) => m.best.later || 0)), bestN: best.size, bestRan: bRows.filter((r) => r.empty > 0).length, bestEmpty: sum(months.map((m) => m.best.empty)), noMoney: sum(months.map((m) => m.best.noMoney)), allRan: rows.filter((r) => r.empty > 0).length, hidden: months.filter((m) => !m.pass).map((m) => m.key) },
    now: { out: outRows.length, best: outRows.filter((r) => r.best).length, bestN: bRows.filter((r) => r.active).length, onSale: F.rows.filter((r) => r.active).length },
    best: { quarter: q, from: cur.from, to: cur.to, n: best.size }, rows,
    proof: { offAll: Ra > 0 ? r4(Ga / Ra - 1) : null, tests: T30.length, guess: Math.round(G), real: Math.round(R), off: R > 0 ? r4(G / R - 1) : null, off60: ((g, r) => (r > 0 ? r4(g / r - 1) : null))(sum(T60.map((t) => t.guess)), sum(T60.map((t) => t.real))), gate: GATE_HIGH, months: sc, back: back == null ? null : r4(back), backN: cb.length },
    lock: Object.keys(lock.lists).length || Object.keys(lock.months).length ? lock : null,
  };
}

module.exports = { RULE, GATE, GATE_HIGH, GRACE, facts, bestOf, sums, monthly, pattern, reference, price, tests, comebacks, score, range, report, byMonth, win, quarterStart,
  K: { REF_DAYS, YEAR_DAYS, GUARD, MIN_SHELF, MIN_UNITS, LONG_GAP, PEER_SHARE, PAT_REST, WINDOW, BEST_SHARE, MIN_PRICE, MIN_RANGE } };
