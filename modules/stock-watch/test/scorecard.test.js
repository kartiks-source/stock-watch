'use strict';
/* 4.7.0: the scorecard (src/model.js scorecard, truth.js scoreOf): on a store whose sales are steady, the rule's guesses on known days
   land on the truth; chance sets a floor above 0; every section and the coverage / health lines are there and in range. */
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/truth'), M = require('../src/model'), S = require('../src/screen');
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
/** the facts, ready for the model */
function facts(rows) {
  const { y, cat } = shop(rows), F = T.facts(y, cat, opts);
  T.sums(F); F.shop = F.keys.map((k) => Number((y.sales.all[k] || [])[1]) || 0); M.prepare(F); return F;
}
const many = (n, start, price, sell) => Array.from({ length: n }, (_, k) => ({ id: String(start + k), price, sell: (i) => sell(i, k) }));
const IX = (k) => Math.round((Date.parse(k) - Date.parse(FROM)) / 864e5);
const near = (a, b, e) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);

test('scorecard: steady sellers are guessed right on known days; chance floor above 0; real ÷ ours near 1 around real stock-outs', () => {
  const rows = [...many(14, 100, 1000, (i, k) => ((i + k) % 2 ? 1 : 0)), ...many(20, 200, 300, (i, k) => ((i + k) % 5 === 0 ? 1 : 0)),
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => ({ id: String(300 + k), price: 1000, sell: (i) => ((i + k) % 2 ? 1 : 0), gaps: [[IX('2026-06-01') + k * 9, IX('2026-06-06') + k * 9]] }))];
  const { y, cat } = shop(rows), r = T.report(y, cat, opts), s = r.score;
  for (const k of ['pretend', 'before', 'after']) for (const g of ['best', 'other']) assert.ok(s[k][g], `${k}.${g}`);
  const pb = s.pretend.best; assert.ok(pb.n > 50 && pb.products >= 10);
  near(pb.total, 0, 0.05); assert.ok(pb.miss < 0.2, `steady: small miss ${pb.miss}`); assert.ok(pb.floor > 0 && pb.floor < 0.5);
  assert.ok(s.before.best.n >= 5); near(s.before.best.ratio, 1, 0.15); near(s.after.best.ratio, 1, 0.15);
  assert.ok(s.coverage > 0.9 && s.coverage <= 1); near(s.health.rowsVsShop, 0, 1e-6); assert.equal(s.health.unsureShare, 0);
  const b = S.brand(r, {}); assert.deepEqual(b.score, s, 'the brand API carries it');
});

test('poisson floor: E|X−m| matches the known values', () => {
  near(M.poissonMad(1), 2 * Math.exp(-1), 1e-9);            // E|X−1| = 2/e
  near(M.poissonMad(100) / 100, Math.sqrt(2 / (Math.PI * 100)), 0.002);
  assert.equal(M.poissonMad(0), 0);
});
