'use strict';
/* 4.3: the brand's own factor (src/model.js factors) in place of the fixed 0.74, on made-up stores: steady sellers ≈ 1, fading
   slow sellers clearly under 1, too little history → 1 (flagged), a wild store is capped (flagged), and a locked month keeps the
   factor it was locked with. */
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/truth'), M = require('../src/model');
const { keyPlus } = require('../src/agency');
const FROM = '2025-11-01', N = 390, TO = keyPlus(FROM, N - 1), DAY = (i) => keyPlus(FROM, i);
const opts = { dayOf: (t) => new Date(t).toISOString().slice(0, 10) };

/** rows { id, sell(i) (pieces, may be a fraction), price, gaps: [[a, b]] } → year.json + catalog; always in stock unless a gap */
function shop(rows, n = N) {
  const to = keyPlus(FROM, n - 1), y = { sales: { from: FROM, to, by: {}, all: {} }, moves: { from: FROM, to, by: {} }, anchor: { at: 1, day: keyPlus(to, 1), levels: {} }, done: true }, cat = {};
  for (const r of rows) {
    cat[r.id] = { productId: `p${r.id}`, product: `Row ${r.id}`, variant: '', price: r.price, active: true, tracked: true };
    const st = (i) => ((r.gaps || []).some(([a, b]) => i >= a && i < b) ? 0 : 1e6), by = {}, mv = {};
    for (let i = 0; i < n; i++) {
      const full = st(i) > 0 && (i === 0 ? st(0) > 0 : st(i - 1) > 0), u = full ? r.sell(i) : 0;
      if (u) { by[DAY(i)] = [u, u * r.price, 0, u * r.price]; const t = y.sales.all[DAY(i)] || (y.sales.all[DAY(i)] = [0, 0]); t[0] += u; t[1] += u * r.price; }
      const d = st(i) - (i ? st(i - 1) : st(0)); if (d) mv[DAY(i)] = d;
    }
    y.sales.by[r.id] = by; y.moves.by[r.id] = mv; y.anchor.levels[r.id] = st(n - 1);
  }
  return { y, cat };
}
/** the facts, ready for M.factors */
function facts(rows) {
  const { y, cat } = shop(rows), F = T.facts(y, cat, opts);
  T.sums(F); F.shop = F.keys.map((k) => Number((y.sales.all[k] || [])[1]) || 0); M.prepare(F); return F;
}
const many = (n, start, price, sell) => Array.from({ length: n }, (_, k) => ({ id: String(start + k), price, sell: (i) => sell(i, k) }));
const bestIds = (F) => (r) => +r.id < 200;   // rows 100–199 = the best sellers, 200+ = the rest

test('steady sellers: both factors come out about 1 (nothing to correct)', () => {
  const F = facts([...many(14, 100, 1000, (i, k) => ((i + k) % 2 ? 1 : 0)), ...many(14, 200, 300, (i, k) => ((i + k) % 3 === 0 ? 1 : 0))]);
  const f = M.factors(F, bestIds(F));
  for (const k of ['best', 'other']) {
    assert.equal(f[k].flag, null, k); assert.ok(f[k].n >= 100 && f[k].p >= 10, `${k}: ${f[k].n} stretches, ${f[k].p} products`);
    assert.ok(Math.abs(f[k].f - 1) < 0.03, `${k} ${f[k].f}`); assert.equal(f[k].f, Math.round(((f[k].n * f[k].raw + 100) / (f[k].n + 100)) * 1e4) / 1e4);
  }
  assert.deepEqual(M.factors(F, bestIds(F)), f, 'the same data, the same factors (every 20th Full day)');
});

test('fading slow sellers: the rest come out clearly under 1; best sellers stay about 1', () => {
  const F = facts([...many(14, 100, 100000, (i, k) => ((i + k) % 2 ? 1 : 0)), ...many(14, 200, 300, (i, k) => 5 * 2 ** (-(i + k) / 200))]);
  const f = M.factors(F, bestIds(F));
  assert.equal(f.other.flag, null); assert.ok(f.other.raw < 0.9 && f.other.f < 0.93, `other ${f.other.raw} → ${f.other.f}`);
  assert.ok(f.other.f > f.other.raw, 'leans toward 1 (100 stretches’ weight)');
  assert.ok(Math.abs(f.best.f - 1) < 0.03, `best ${f.best.f}`);
});

test('too little history: under 100 stretches or 10 products → factor 1, flagged; the money is not corrected', () => {
  const rows = [...many(12, 100, 1000, (i, k) => ((i + k) % 2 ? 1 : 0)), { id: '1', price: 300, sell: (i) => (i % 5 === 0 ? 1 : 0), gaps: [[IXd('2026-08-05'), IXd('2026-08-15')]] }];
  const { y, cat } = shop(rows), r = T.report(y, cat, opts);
  assert.equal(r.factor.other.flag, 'few'); assert.equal(r.factor.other.f, 1); assert.ok(r.factor.other.p < 10);
  const p = r.rows.find((x) => x.id === '1').months['2026-08'].parts[0]; assert.equal(p.adj, 1); assert.equal(p.grp, 'other'); assert.ok(p.lost > 0);
  const F = facts(many(9, 200, 300, () => 1)), f = M.factors(F, () => false); assert.equal(f.other.p, 9); assert.equal(f.other.flag, 'few', 'under 10 products');
});
function IXd(k) { return Math.round((Date.parse(k) - Date.parse(FROM)) / 864e5); }

test('a store far off the guess is capped at 0.5–1.5 and flagged', () => {
  const F = facts([...many(14, 100, 1e7, (i, k) => ((i + k) % 2 ? 1 : 0)), ...many(14, 200, 300, (i, k) => 1000 * 2 ** (-(i + k) / 20))]);
  const f = M.factors(F, bestIds(F));
  assert.equal(f.other.flag, 'clip'); assert.equal(f.other.f, 0.5); assert.ok(f.other.raw < 0.3, `${f.other.raw}`);
  const G = facts([...many(14, 100, 1e7, (i, k) => ((i + k) % 2 ? 1 : 0)), ...many(14, 200, 300, (i, k) => 2 ** ((i + k) / 25))]);
  const g = M.factors(G, bestIds(G)); assert.equal(g.other.flag, 'clip'); assert.equal(g.other.f, 1.5);
});

test('lock: a closed month keeps the factor it was locked with when later data changes; the open month uses today’s', () => {
  const rows = [...many(14, 100, 1000, (i, k) => ((i + k) % 2 ? 1 : 0)), ...many(14, 200, 300, (i, k) => 5 * 2 ** (-(i + k) / 200)),
    ...Array.from({ length: 4 }, (_, k) => ({ id: String(300 + k), price: 300, sell: () => 1, gaps: [[IXd('2026-08-05'), IXd('2026-08-15')], [IXd('2026-11-10'), IXd('2026-11-20')]] }))];
  const a0 = shop(rows), a = T.report(a0.y, a0.cat, opts), led = JSON.parse(JSON.stringify({ rule: T.RULE, ...a.lock }));
  assert.equal(T.RULE, '4.3'); assert.ok(led.months['2026-08'].factor, 'the factor is saved with the month');
  const aug = (r) => r.months.find((m) => m.key === '2026-08'), part = (r, m) => r.rows.find((x) => x.id === '300').months[m].parts[0];
  /* later data: the slow sellers fade much faster, so today's factor drops */
  const rows2 = rows.map((r) => (+r.id >= 200 && +r.id < 300 ? { ...r, sell: (i) => 5 * 2 ** (-(i) / 60) } : r)), b0 = shop(rows2), b = T.report(b0.y, b0.cat, { ...opts, ledger: led });
  assert.notEqual(b.factor.other.f, a.factor.other.f, 'today’s factor moved');
  assert.deepEqual(aug(b).factor, aug(a).factor, 'August keeps its factor'); assert.equal(part(b, '2026-08').adj, part(a, '2026-08').adj); assert.equal(aug(b).all.lost, aug(a).all.lost);
  assert.equal(part(b, '2026-11').adj, b.factor[part(b, '2026-11').grp].f, 'November (open) uses today’s');
  for (const t of [a, b]) assert.ok(t.months.every((m) => m.factor && m.factor.best && m.factor.other));
});
