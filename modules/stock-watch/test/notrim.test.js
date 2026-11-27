'use strict';
/* 4.5: no trim. 4.3's brand factor is gone: the money is speed × how busy × days × price and nothing else, on a store where
   4.3 would have trimmed hard (fading slow sellers); no factor anywhere in the report, the brand page or a product's working;
   months locked under 4.4 (trimmed) are worked out again under 4.5. */
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
/* best sellers sell steadily; the rest fade (4.3 trimmed these to about 0.6) */
const store = () => [...many(14, 100, 1000, (i, k) => ((i + k) % 2 ? 1 : 0)), ...many(14, 200, 300, (i, k) => (((i + k) % 3 === 0) ? 1 : 0) * (1 - i / (N * 1.2))),
  { id: '1', price: 300, sell: (i) => (i % 3 === 0 ? 1 : 0), gaps: [[IX('2026-08-05'), IX('2026-08-15')]] }];
const IX = (k) => Math.round((Date.parse(k) - Date.parse(FROM)) / 864e5);
const near = (a, b, e) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);

test('money = speed × how busy × days × price, nothing else; no factor in the report', () => {
  const { y, cat } = shop(store()), r = T.report(y, cat, opts);
  assert.ok(T.RULE.startsWith('4.5')); assert.equal(r.rule, T.RULE); assert.equal(r.factor, undefined); assert.equal(M.factors, undefined);
  for (const m of r.months) assert.equal(m.factor, undefined, m.key);
  const p = r.rows.find((x) => x.id === '1').months['2026-08'].parts[0];
  assert.equal(p.adj, undefined); assert.equal(p.grp, undefined);
  near(p.units, p.perDay * p.counted, 0.01); near(p.lost, p.units * p.price, 1);   // perDay already holds how busy: speed × busy
  near(p.perDay, p.speed * p.busy, 0.001);
});

test('the brand page and a product’s working carry no factor', () => {
  const { y, cat } = shop(store()), t = T.report(y, cat, opts), b = S.brand(t, {});
  assert.equal(b.factor, undefined); for (const m of b.months) assert.equal(m.factor, undefined);
  const pr = S.profile({ ok: true, months: [] }, t, '1');
  assert.ok(pr.work && pr.work.gaps.length); assert.equal(pr.work.factor, undefined);
  for (const g of pr.work.gaps) for (const q of g.parts) { assert.equal(q.factor, undefined); assert.equal(q.adj, undefined); }
});

test('a month locked under 4.4 (with its trim) is worked out again under 4.5', () => {
  const { y, cat } = shop(store()), fresh = T.report(y, cat, opts);
  const old = { rule: '4.4', lists: {}, months: { '2026-08': { at: 1, factor: { best: { f: 0.9 }, other: { f: 0.5 } }, best: {}, all: {}, parts: [{ id: '1', start: '2026-08-05', from: '2026-08-05', to: '2026-08-15', empty: 10, adj: 0.5, grp: 'other', lost: 1 }] } } };
  const r = T.report(y, cat, { ...opts, ledger: old });
  const a = r.months.find((m) => m.key === '2026-08'), f = fresh.months.find((m) => m.key === '2026-08');
  assert.equal(a.all.lost, f.all.lost, 'the old trimmed month is not used'); assert.ok(a.all.lost > 1);
  assert.ok(r.lock && r.lock.months['2026-08'], 'and it is locked again under 4.5');
});

test('4.5.1: each part carries its busy working; the days reproduce the busy number and the base is the speed’s', () => {
  const { y, cat } = shop(store()), r = T.report(y, cat, opts), p = r.rows.find((x) => x.id === '1').months['2026-08'].parts[0];
  assert.ok(p.base > 0 && p.bdays.length > 0);
  let sw = 0, sb = 0; for (const [k, v, c] of p.bdays) { assert.match(k, /^2026-08-\d\d$/); assert.ok([0, 0.5, 1].includes(c)); sw += c; sb += (v / p.base) * c; }
  near(sb / sw, p.busy, 0.002); near(sw, p.counted, 0.001);
  assert.equal(p.bdays[0][2], 0.5, 'the day it ran out counts ½');
  const all = (y.sales.all['2026-08-07'] || [0, 0])[1], own = ((y.sales.by['1'] || {})['2026-08-07'] || [0, 0])[1];
  const d = p.bdays.find(([k]) => k === '2026-08-07'); assert.equal(d[1], Math.round(Math.max(0, all - own)), 'the rest of the shop that day');
});
