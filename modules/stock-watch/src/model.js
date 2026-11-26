'use strict';
/*
 * 4.0: the prediction behind "money missed" (RULE.md). 4.3: × the brand's own factor (factors), measured on its normal months. Pure: works on the facts of src/truth.js. F.shop[i] = the shop's net ₹ on day i.
 *   speed   net pieces a Full day over the Full days in the 90 calendar days before the gap. Needs 60+ such days and 3+ pieces; a best seller with fewer (but a sale lately) uses its last 60 in-stock days within the year.
 *   busy    the shop's net ₹ that day (this row's own taken out) ÷ the same on the speed's days. Carries Diwali, sales and quiet days.
 *   price   net ₹ ÷ pieces on the speed's days. So speed × price = ₹ a Full day.
 *   tests   replayed stock-outs (a pretend opening stock, real sales until it is gone, the real next days are the truth) and real
 *           comebacks (days 4–30 after a gap). The range comes from how far these were off, by product, never from a formula alone.
 * Chosen 26 Nov 2026 over 3.0 after three critics (data, demand, tests) and placebo, comeback and replay tests (RULE.md, CHANGELOG).
 */
const LOOK = 90, MIN_DAYS = 60, MIN_UNITS = 3, YEAR = 365, LONG = 60;   // 4.4: 3+ pieces sold in the window; under 60 in-stock days in the 90: the last 60 in-stock days within 365
/* 4.3: the brand's own factor (replaces the fixed 0.74): on its normal in-stock 30-day checks, what really sold ÷ what the rule guessed */
const SPAN = 30, MIN_FULL = 10, MIN_N = 100, MIN_P = 10, PRIOR = 100, CLIP = [0.5, 1.5];
const NOISE = 0.22, MODEL_SD = 0.055, SIMS = 2000, REPLAYS = 40, SEED = 20261125, LAST = 60;
/** A fixed random sequence: the same data always gives the same range. */
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const normal = (rnd) => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());

/** Running sums of every row (Full days only), and the shop less this row. */
function prepare(F) {
  const shop = F.shop || F.keys.map(() => 0);
  for (const r of F.rows) {
    const ok = usableRow(r), days = [], scu = [0];
    r.fu = new Float64Array(F.n + 1); r.fd = new Float64Array(F.n + 1); r.fn = new Float64Array(F.n + 1); r.fs = new Float64Array(F.n + 1);
    for (let i = 0; i < F.n; i++) {
      const full = ok && r.st[i] === 2; if (full) { days.push(i); scu.push(scu[scu.length - 1] + r.u[i]); }
      r.fu[i + 1] = r.fu[i] + (full ? r.u[i] : 0); r.fd[i + 1] = r.fd[i] + (full ? 1 : 0); r.fn[i + 1] = r.fn[i] + (full ? r.net[i] : 0); r.fs[i + 1] = r.fs[i] + (full ? Math.max(0, shop[i] - r.net[i]) : 0);
    }
    r.sd = days; r.scu = scu; r.upto = new Int32Array(F.n + 2); let j = 0; for (let t = 0; t < r.upto.length; t++) { while (j < days.length && days[j] < t) j++; r.upto[t] = j; }
    r.spMemo = new Map();
  }
  F.shopOf = (r, i) => Math.max(0, shop[i] - r.net[i]);
  return F;
}
const usableRow = (r) => !r.always && !r.unsure && !r.gift;
/** The speed known before day t (its Full days in the 90 days before), or null. */
function speed(F, r, t, minUnits = MIN_UNITS, allowFb = true) {   // minUnits 1: the selling pace now (days of stock), not the money
  t = Math.min(t, F.n); const mk = minUnits === MIN_UNITS && allowFb ? t : `${t}|${minUnits}|${allowFb ? 1 : 0}`; if (r.spMemo.has(mk)) return r.spMemo.get(mk);
  let out = null; let a = Math.max(0, t - LOOK), d = r.fd[t] - r.fd[a], u = r.fu[t] - r.fu[a], n = r.fn[t] - r.fn[a], fb = false;
  if (allowFb && usableRow(r) && d < MIN_DAYS && u >= 1 && (!F.bestAt || F.bestAt(r, t))) {   // 4.4: a best seller sold out too often lately (but selling): its last 60 in-stock days within a year
    const hi = r.upto[t], lo = Math.max(r.upto[Math.max(0, t - YEAR)], hi - MIN_DAYS);
    if (hi - lo >= MIN_DAYS) { a = r.sd[lo]; d = r.fd[t] - r.fd[a]; u = r.fu[t] - r.fu[a]; n = r.fn[t] - r.fn[a]; fb = true; }
  }
  if (usableRow(r) && d >= MIN_DAYS && u >= minUnits && n > 0) {
    const y0 = Math.max(0, t - YEAR), lo = r.upto[a], hi = r.upto[t];
    out = { perDay: u / d, units: u, days: d, from: r.sd[lo], to: r.sd[hi - 1], price: n / u, base: (r.fs[t] - r.fs[a]) / d, yearUnits: r.fu[t] - r.fu[y0], yearDays: r.fd[t] - r.fd[y0], yearFrom: r.sd[r.upto[y0]], ...(fb ? { fb: true } : {}) };
  }
  r.spMemo.set(mk, out); return out;
}
/** 4.4: why no speed: under 60 in-stock days within the year, or under 3 pieces sold. */
function noReason(F, r, t) { const hi = r.upto[Math.min(t, F.n)], lo = r.upto[Math.max(0, t - YEAR)]; return hi - lo < MIN_DAYS ? 'few-days' : 'few-sales'; }
/** How busy the shop was on day i against the speed's days (1 = a normal day). */
const busy = (F, r, s, i) => (s.base > 0 ? F.shopOf(r, i) / s.base : 1);
/** Days s..e cut per calendar month. */
function byMonth(F, a, b) { const out = []; for (let i = a; i <= b;) { let e = i; while (e < b && F.keys[e + 1].slice(0, 7) === F.keys[i].slice(0, 7)) e++; out.push([i, e]); i = e + 1; } return out; }
/** Pieces the model expects on the Full days of a..b, speed known before day o. */
function guess(F, r, a, b, o) { const s = speed(F, r, o); let t = 0; for (let i = a; i <= b; i++) if (r.st[i] === 2) t += s.perDay * busy(F, r, s, i); return t; }

/**
 * Every gap priced. A day: Empty 1; the Half day it ran out ½ (what sold before it ran out does not come off); the Half day it came back 0;
 * another Half day ½ less what it sold. Another variant of the same product Full that day: 0. Days 61+ shown apart.
 */
function price(F) {
  for (const r of F.rows) for (const g of r.gaps) {
    const sib = F.rows.filter((p) => p !== r && p.productId === r.productId), s = speed(F, r, g.a);
    g.ref = s; g.no = r.unsure || r.always ? 'unsure' : r.gift ? 'gift' : g.before ? 'started-empty' : !s ? noReason(F, r, g.a) : null; g.parts = [];
    for (const [a, e] of byMonth(F, g.a, g.b)) {
      const part = { month: F.keys[a].slice(0, 7), s: a, e, empty: 0, first: 0, later: 0, sib: 0, sold: 0, units: 0, laterUnits: 0, bz: 0, bd: 0 };
      for (let i = a; i <= e; i++) {
        const d = r.st[i] === 0 ? 1 : 0.5; part.empty += d;
        if (sib.some((p) => p.st[i] === 2)) { part.sib += d; continue; }
        const late = i - g.a >= LONG; part[late ? 'later' : 'first'] += d; if (g.no) continue;
        const sold = Math.max(0, r.u[i]), b = busy(F, r, s, i), x = s.perDay * b, half = r.st[i] === 1, back = half && r.level[i] > 0, c = back ? 0 : d;   // c: how much of the day counts
        if (!late) { part.sold += sold; part.bz += b * c; part.bd += c; }
        const v = !half ? Math.max(0, Math.min(d * x, x - sold)) : back ? 0 : 0.5 * x;
        part[late ? 'laterUnits' : 'units'] += v;
      }
      if (!g.no) Object.assign(part, { counted: part.bd, busy: part.bd > 0 ? part.bz / part.bd : 1, perDay: s.perDay * (part.bd > 0 ? part.bz / part.bd : 1), lost: part.units * s.price, laterLost: part.laterUnits * s.price });
      delete part.bz; delete part.bd; g.parts.push(part);
    }
  }
  return F;
}

/**
 * 4.3: the brand's factor for best sellers and for the rest, measured on its own normal months (nothing out). Each usable row gives
 * 30-day checks that never overlap: the first starts on its first Full day, each next one on the first Full day at least 30 days after
 * the last start. A check counts when its 30 calendar days hold no Empty or Half day, it starts more than 30 days after a gap ended,
 * 10+ of its days are Full and a speed is known before it: guess = speed × how busy × price on its Full days, real = what it sold on
 * them. Grouped by bestAt(row, t) (that quarter's list). Per group: raw = Σ real ÷ Σ guess; under 100 checks or 10 products → 1
 * ("few"); else (n × raw + 100) ÷ (n + 100), within 0.5–1.5 ("clip" when cut).  → { best: { f, raw, n, p, real, guess, flag }, other }
 */
function factors(F, bestAt) {
  const g = { best: { real: 0, guess: 0, n: 0, p: new Set() }, other: { real: 0, guess: 0, n: 0, p: new Set() } };
  for (const r of F.rows) {
    if (!usableRow(r) || !r.sd.length) continue;
    const ends = r.gaps.map((x) => x.b);   // last day of each gap (the day it came back, or the record's end)
    for (let j = 0; j < r.sd.length;) {
      const t = r.sd[j], end = Math.min(F.n - 1, t + SPAN - 1);
      let next = j; while (next < r.sd.length && r.sd[next] < t + SPAN) next++;   // the next check: the first Full day 30+ days on
      const use = (() => {
        if (t + SPAN - 1 > F.n - 1) return false;   // a check needs its whole 30 days
        for (let i = t; i <= end; i++) if (r.st[i] === 0 || r.st[i] === 1) return false;   // nothing ran out in it
        if (ends.some((b) => b < t && t - b <= SPAN)) return false;   // not just after a refill
        return true;
      })();
      const s = use ? speed(F, r, t) : null;
      if (s) {
        let full = 0, guess = 0, real = 0;
        for (let i = t; i <= end; i++) if (r.st[i] === 2) { full++; guess += s.perDay * busy(F, r, s, i) * s.price; real += r.net[i]; }
        if (full >= MIN_FULL) { const z = g[bestAt(r, t) ? 'best' : 'other']; z.real += real; z.guess += guess; z.n++; z.p.add(r.productId || r.id); }
      }
      j = next;
    }
  }
  const out = {};
  for (const [k, z] of Object.entries(g)) {
    const raw = z.guess > 0 ? z.real / z.guess : 1, n = z.n, p = z.p.size;
    let f = 1, flag = null;
    if (n < MIN_N || p < MIN_P) flag = 'few';
    else { f = (n * raw + PRIOR) / (n + PRIOR); if (f < CLIP[0] || f > CLIP[1]) { f = Math.min(CLIP[1], Math.max(CLIP[0], f)); flag = 'clip'; } }
    out[k] = { f: Math.round(f * 1e4) / 1e4, raw: Math.round(raw * 1e4) / 1e4, n, p, real: Math.round(z.real), guess: Math.round(z.guess), flag };
  }
  return out;
}

/** The tests: [{ kind: 'replay' | 'back', id, pid, o, a, b, guess, real }] in ₹. */
function tests(F) {
  const out = [], rnd = rng(SEED), gaps = []; for (const r of F.rows) for (const g of r.gaps) if (!g.before && g.ended === 'back' && g.empty >= 3 && g.empty <= LONG) gaps.push(g.empty);
  const add = (kind, r, a, b, o, gap) => { const s = speed(F, r, o); if (s) out.push({ kind, id: r.id, pid: r.productId, o, a, b, gap, units: s.units, guess: guess(F, r, a, b, o) * s.price, real: r.fn[b + 1] - r.fn[a] }); };
  for (const r of F.rows) {
    if (!usableRow(r)) continue;
    if (gaps.length && r.sd.length >= 45) for (let k = 0; k < REPLAYS; k++) {
      const top = Math.max(34, r.sd.length - 10), k0 = 33 + Math.floor(rnd() * (top - 33)), u = (r.scu[k0] - r.scu[Math.max(0, k0 - LAST)]) / Math.min(LAST, k0), f = 10 + 40 * rnd(), pick = gaps[Math.floor(rnd() * gaps.length)];
      if (!(u > 0)) continue;
      const Q = Math.max(2, Math.round(u * f)); let q = 0, w = -1; for (let j = k0; j < r.sd.length; j++) { q += r.u[r.sd[j]]; if (q >= Q) { w = j; break; } }
      if (w < 0) continue;
      const o = r.sd[w], a = o + 1, b = Math.min(F.n - 1, a + Math.round(pick) - 1); if (b - a < 2 || r.fd[b + 1] - r.fd[a] < 0.5 * (b - a + 1)) continue;
      add('replay', r, a, b, o, pick);
    }
    for (const g of r.gaps) { if (g.before || g.ended !== 'back' || g.empty < 2) continue; const a = Math.min(F.n - 1, g.b + 4), b = Math.min(F.n - 1, g.b + 30); if (b > a && r.fd[b + 1] - r.fd[a] >= 7) add('back', r, a, b, g.a, g.empty); }
  }
  return out;
}
/** Real ÷ guess of a list of tests, resampled by product: SIMS numbers. */
function ratios(list, rnd) {
  const by = new Map(); for (const t of list) { const z = by.get(t.pid) || [0, 0]; z[0] += t.guess; z[1] += t.real; by.set(t.pid, z); }
  const A = [...by.values()], out = new Float64Array(SIMS); if (A.length < 5) return null;
  for (let k = 0; k < SIMS; k++) { let g = 0, r = 0; for (let i = 0; i < A.length; i++) { const z = A[Math.floor(rnd() * A.length)]; g += z[0]; r += z[1]; } out[k] = g > 0 ? Math.max(0, r / g) : 1; }
  return out;
}
const pct = (a, p) => a[Math.min(a.length - 1, Math.max(0, Math.floor(p * a.length)))];
/** How far off: { off, low, high, n, products } (guess against real; 95%). */
function bias(list) {
  const g = list.reduce((s, t) => s + t.guess, 0), r = list.reduce((s, t) => s + t.real, 0), R = ratios(list, rng(SEED + 1)); if (!R || !(r > 0)) return null;
  const z = [...R].map((x) => 1 / Math.max(1e-6, x) - 1).sort((x, y) => x - y); return { off: g / r - 1, low: pct(z, 0.025), high: pct(z, 0.975), n: list.length, products: new Set(list.map((t) => t.pid)).size };
}
/** The machinery for ranges: groups = { best: tests, other: tests }. range(parts) with parts [{ lost, units, price, best }] → { low, high } (90%) or null. */
function ranger(groups) {
  const M = {}; for (const [k, l] of Object.entries(groups)) M[k] = { back: ratios(l.filter((t) => t.kind === 'back'), rng(SEED + 2)), replay: ratios(l.filter((t) => t.kind === 'replay'), rng(SEED + 3)) };
  return (parts) => {
    const use = parts.filter((p) => p.lost > 0); if (!use.length) return null;
    const rnd = rng(SEED + 4), tot = new Float64Array(SIMS), cb = new Float64Array(SIMS), mix = Float64Array.from({ length: SIMS }, () => rnd());
    for (const k of ['best', 'other']) {
      const l = use.filter((p) => !!p.best === (k === 'best')); if (!l.length) continue;
      const base = l.reduce((s, p) => s + p.lost, 0), by = new Map(), m = M[k]; if (!m || (!m.back && !m.replay)) return null;
      for (const p of l) { const z = by.get(p.id) || [0, 0]; z[0] += p.units; z[1] += p.units * p.price; by.set(p.id, z); }   // a product's gaps share its luck
      const sd = Math.sqrt([...by.values()].reduce((s, [u, v]) => (u > 0 ? s + (u + NOISE * u * u) * (v / u) ** 2 : s), 0));
      for (let i = 0; i < SIMS; i++) { const b = m.back ? m.back[i] : m.replay[i], q = m.replay ? m.replay[i] : m.back[i]; const e = sd * normal(rnd); tot[i] += base * (mix[i] * b + (1 - mix[i]) * q) + e; cb[i] += base * b + e; }
    }
    const of = (v) => [...v].map((x) => Math.max(0, x * Math.exp(MODEL_SD * normal(rnd)))).sort((x, y) => x - y), z = of(tot), c = of(cb), point = use.reduce((s, p) => s + p.lost, 0);
    return { low: Math.min(point, pct(z, 0.05), pct(c, 0.05)), high: Math.max(point, pct(z, 0.95)) };   // real comebacks are the real event: the low end is never above what they alone say
  };
}
module.exports = { prepare, speed, busy, guess, price, tests, bias, ranger, byMonth, factors, K: { LOOK, MIN_DAYS, MIN_UNITS, LONG, SPAN, MIN_FULL, MIN_N, MIN_P, PRIOR, CLIP } };
