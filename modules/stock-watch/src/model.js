'use strict';
/*
 * 3.0: the prediction behind "money missed" (RULE.md). Pure: works on the facts of src/truth.js.
 *   speed   weighted average of net pieces a full-shelf day, newer days count more (half-life 60 full-shelf days), up to the 4th day
 *           before the gap. Needs 30+ full days in the year before and 1+ piece on the last 60.
 *   like    how products that sell at a like speed and were in stock on the same days did against their own speed (frozen on the same
 *           day); small groups lean on everyone's.
 *   tests   replayed stock-outs (a pretend opening stock, real sales until it is gone, the real next days are the truth) and real
 *           comebacks (days 4–30 after a gap). The range comes from how far these were off, by product, never from a formula alone.
 * Chosen among 19 models on windows that began by Sep 2026 (some run into October); Oct and Nov 2026 were looked at after the choice.
 */
const HALF = 60, GUARD = 3, YEAR = 365, LAST = 60, MIN_DAYS = 30, SHARE = 0.8, WINDOW = 14, K_ALL = 2, K_TIER = 8, PHI = 0.5, CLIP = [0.25, 4], LONG = 60;
const TIERS = [3, 8, 20, 60];          // pieces per 60 full-shelf days
const NOISE = 0.22, MODEL_SD = 0.055, SIMS = 2000, REPLAYS = 40, SEED = 20261125;
const DECAY = 0.5 ** (1 / HALF);

/** A fixed random sequence: the same data always gives the same range. */
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const normal = (rnd) => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
const tier = (v) => { const x = v * 60; let k = 0; while (k < TIERS.length && x >= TIERS[k]) k++; return k; };
const usable = (r) => !r.always && !r.unsure && !r.gift;

/** Speed of every row on every day: r.sp[t] = { speed, …} worked out on demand. Prepares the running sums. */
function prepare(F) {
  for (const r of F.rows) {
    const days = [], cu = [0], cn = [0], ew = [0], ewd = [0];
    if (usable(r)) for (let i = 0; i < F.n; i++) if (r.st[i] === 2) { days.push(i); cu.push(cu[cu.length - 1] + r.u[i]); cn.push(cn[cn.length - 1] + r.net[i]); ew.push(ew[ew.length - 1] * DECAY + r.u[i]); ewd.push(ewd[ewd.length - 1] * DECAY + 1); }
    r.sd = days; r.scu = cu; r.scn = cn; r.ew = ew; r.ewd = ewd; r.upto = new Int32Array(F.n + 1 + GUARD); let j = 0; for (let t = 0; t < r.upto.length; t++) { while (j < days.length && days[j] < t) j++; r.upto[t] = j; }
    r.fu = new Float64Array(F.n + 1); r.fd = new Float64Array(F.n + 1); r.fn = new Float64Array(F.n + 1);
    for (let i = 0; i < F.n; i++) { const full = r.st[i] === 2 && usable(r); r.fu[i + 1] = r.fu[i] + (full ? r.u[i] : 0); r.fd[i + 1] = r.fd[i] + (full ? 1 : 0); r.fn[i + 1] = r.fn[i] + (full ? r.net[i] : 0); }
    r.spMemo = new Map();
  }
  F.likeMemo = new Map();
  return F;
}
/** The speed known before day t, or null. */
function speed(F, r, t) {
  if (r.spMemo.has(t)) return r.spMemo.get(t);
  let out = null; const j = r.upto[Math.max(0, t - GUARD)], lo = r.upto[Math.max(0, t - YEAR)], a = Math.max(0, j - LAST);
  if (j - lo >= MIN_DAYS) { const u = r.scu[j] - r.scu[a]; if (u >= 1) out = { perDay: Math.max(0, r.ew[j]) / r.ewd[j], units: u, days: j - a, from: r.sd[a], to: r.sd[j - 1], price: (r.scn[j] - r.scn[a]) / u, yearUnits: r.scu[j] - r.scu[lo], yearDays: j - lo, yearFrom: r.sd[lo] }; }
  r.spMemo.set(t, out); return out;
}
/** Like-for-like on days a..b against speeds known before day o. → { x, n, real, forecast } */
function like(F, r, a, b, o) {
  if (b - a < WINDOW - 1) { b = Math.min(F.n - 1, a + WINDOW - 1); a = Math.max(0, b - WINDOW + 1); }
  const key = `${a}|${b}|${o}`; let L = F.likeMemo.get(key);
  if (!L) {
    L = { rows: [], R: 0, G: 0, tr: [0, 0, 0, 0, 0], tg: [0, 0, 0, 0, 0], tn: [0, 0, 0, 0, 0] };
    for (const p of F.rows) {
      const d = p.fd[b + 1] - p.fd[a]; if (d < SHARE * (b - a + 1)) continue;
      const s = speed(F, p, o); if (!s) continue;
      const g = s.perDay * d, w = 1 / (1 + PHI * g), x = { pid: p.productId, r: w * (p.fu[b + 1] - p.fu[a]), g: w * g, k: tier(s.perDay) };
      L.rows.push(x); L.R += x.r; L.G += x.g; L.tr[x.k] += x.r; L.tg[x.k] += x.g; L.tn[x.k]++;
    }
    F.likeMemo.set(key, L);
  }
  const s = speed(F, r, o), k = tier(s ? s.perDay : 0); let R = L.R, G = L.G, tr = L.tr[k], tg = L.tg[k], n = L.tn[k];
  for (const x of L.rows) if (x.pid === r.productId) { R -= x.r; G -= x.g; if (x.k === k) { tr -= x.r; tg -= x.g; n--; } }
  const all = (R + K_ALL) / (G + K_ALL), x = Math.min(CLIP[1], Math.max(CLIP[0], (tr + K_TIER * all) / (tg + K_TIER)));
  return { x, n, all };
}
/** Days s..e cut per calendar month. */
function byMonth(F, a, b) { const out = []; for (let i = a; i <= b;) { let e = i; while (e < b && F.keys[e + 1].slice(0, 7) === F.keys[i].slice(0, 7)) e++; out.push([i, e]); i = e + 1; } return out; }
/** Pieces the model expects on the full days of a..b, speed known before day o. */
function guess(F, r, a, b, o) { const s = speed(F, r, o); let t = 0; for (const [x, e] of byMonth(F, a, b)) t += s.perDay * like(F, r, x, e, o).x * (r.fd[e + 1] - r.fd[x]); return t; }

/** Every gap priced. */
function price(F) {
  for (const r of F.rows) for (const g of r.gaps) {
    const sib = F.rows.filter((p) => p !== r && p.productId === r.productId), s = speed(F, r, g.a);
    g.ref = s; g.no = r.unsure || r.always ? 'unsure' : r.gift ? 'gift' : g.before ? 'started-empty' : !s ? 'few-days' : null; g.parts = [];
    for (const [a, e] of byMonth(F, g.a, g.b)) {
      const part = { month: F.keys[a].slice(0, 7), s: a, e, empty: 0, first: 0, later: 0, sib: 0, sold: 0, units: 0, laterUnits: 0 }, L = g.no ? null : like(F, r, a, e, g.a), x = g.no ? 0 : s.perDay * L.x;
      for (let i = a; i <= e; i++) {
        const d = r.st[i] === 0 ? 1 : 0.5; part.empty += d;
        if (sib.some((p) => p.st[i] === 2)) { part.sib += d; continue; }
        const late = i - g.a >= LONG; part[late ? 'later' : 'first'] += d; if (g.no) continue;
        const sold = Math.max(0, r.u[i]); if (!late) part.sold += sold;
        part[late ? 'laterUnits' : 'units'] += Math.max(0, Math.min(d * x, x - sold));
      }
      if (!g.no) Object.assign(part, { like: L.x, likeN: L.n, perDay: x, lost: part.units * s.price, laterLost: part.laterUnits * s.price });
      g.parts.push(part);
    }
  }
  return F;
}

/** The tests: [{ kind: 'replay' | 'back', id, pid, o, a, b, guess, real }] in ₹. */
function tests(F) {
  const out = [], rnd = rng(SEED), gaps = []; for (const r of F.rows) for (const g of r.gaps) if (!g.before && g.ended === 'back' && g.empty >= 3 && g.empty <= LONG) gaps.push(g.empty);
  const add = (kind, r, a, b, o, gap) => { const s = speed(F, r, o); if (s) out.push({ kind, id: r.id, pid: r.productId, o, a, b, gap, units: s.units, guess: guess(F, r, a, b, o) * s.price, real: r.fn[b + 1] - r.fn[a] }); };
  for (const r of F.rows) {
    if (!usable(r)) continue;
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
module.exports = { prepare, speed, like, guess, price, tests, bias, ranger, byMonth, tier, K: { HALF, GUARD, MIN_DAYS, LAST, LONG, SHARE, WINDOW } };
