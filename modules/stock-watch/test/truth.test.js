'use strict';
/* 2.0.0: the one rule (RULE.md), on small made-up stores where every number can be worked out by hand. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-truth-'));
const T = require('../src/truth'), S = require('../src/screen'), scope = require('../src/scope'), ledger = require('../src/ledger');
const { keyPlus } = require('../src/agency');
const FROM = '2025-11-01', N = 390, TO = keyPlus(FROM, N - 1), DAY = (i) => keyPlus(FROM, i), IX = (k) => Math.round((Date.parse(k) - Date.parse(FROM)) / 864e5);
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);

/** A store of rows { id, sell(i), price, gaps: [[a, b]] (empty from the day's end of a to the refill on b), product }. */
function shop(rows, extra = {}) {
  const y = { sales: { from: FROM, to: TO, by: {}, all: {} }, moves: { from: FROM, to: TO, by: {} }, anchor: { at: 1, day: keyPlus(TO, 1), levels: {} }, done: true }, cat = {};
  for (const r of rows) {
    cat[r.id] = { productId: r.product || `p${r.id}`, product: r.name || `Row ${r.id}`, variant: '', price: r.price, active: r.active !== false, tracked: true, ...(r.oversell ? { oversell: true } : {}), ...(r.createdAt ? { createdAt: r.createdAt } : {}) };
    const st = (i) => (r.gaps || []).some(([a, b]) => i >= a && i < b) ? 0 : 50, by = {}, mv = {};
    for (let i = 0; i < N; i++) {
      const full = st(i) > 0 && (i === 0 ? st(0) > 0 : st(i - 1) > 0), u = full ? r.sell(i) : 0;
      if (u) { by[DAY(i)] = [u, u * r.price, 0, u * r.price]; const t = y.sales.all[DAY(i)] || (y.sales.all[DAY(i)] = [0, 0]); t[0] += u; t[1] += u * r.price; }
      const d = st(i) - (i ? st(i - 1) : st(0)); if (d) mv[DAY(i)] = d;
    }
    y.sales.by[r.id] = by; y.moves.by[r.id] = mv; y.anchor.levels[r.id] = st(N - 1);
  }
  return { y, cat, opts: { dayOf: (t) => new Date(t).toISOString().slice(0, 10), ...extra } };
}
/** 12 steady best sellers at 1 piece every 2 days for ₹1,000; peers[i](day) can change their speed. */
const steady = (n = 12, f = () => 1, start = 100) => Array.from({ length: n }, (_, k) => ({ id: String(start + k), price: 1000, sell: (i) => ((i + k) % 2 === 0 ? f(i) : 0) }));
const run = (rows, o) => { const s = shop(rows, o); return T.report(s.y, s.cat, s.opts); };
const gap = (a, b) => [IX(a), IX(b)];

test('missed = speed × month × price × days empty; a half day is half; could have earned = sold + missed', () => {
  const r = run([...steady(), { id: '1', price: 2000, sell: (i) => (i % 2 ? 1 : 0), gaps: [gap('2026-08-05', '2026-08-15')] }]);
  const x = r.rows.find((z) => z.id === '1'), p = x.months['2026-08'].parts[0];
  assert.equal(p.empty, 10); assert.equal(p.first, 10);   // 5 Aug ran out (½), 6–14 empty, 15 Aug back (½)
  near(p.perDay, 0.5, 0.02); near(p.pattern, 1, 0.05); assert.equal(p.price, 2000);
  near(p.lost, 10 * p.perDay * 2000, 1); assert.equal(p.w[1], '2026-08-01', 'three days left out before the gap'); assert.equal(p.w[2], 60);
  assert.equal(r.months.find((m) => m.key === '2026-08').why, 'thin', 'one stock-out: no ₹ for the month');
  assert.equal(x.low, undefined, 'one estimate: no range');
});
test('month: a month that ran twice as fast for the others doubles the guess; a gift line never counts', () => {
  const busy = (i) => (DAY(i).slice(0, 7) === '2026-08' ? 2 : 1);
  const r = run([...steady(12, busy), { id: '1', price: 2000, sell: (i) => (i % 2 ? 1 : 0), gaps: [gap('2026-08-05', '2026-09-01')] }, { id: '9', price: 10, sell: () => 40 }]);
  const p = r.rows.find((z) => z.id === '1').months['2026-08'].parts[0];
  near(p.pattern, 2, 0.05); near(p.perDay, 1, 0.08); assert.ok(p.patternN >= 8);
  assert.equal(r.rows.find((z) => z.id === '9').best, false);
});
test('the slower of the year and the last 60 shelf days', () => {
  const cut = IX('2026-05-25');
  const p = run([...steady(), { id: '1', price: 2000, sell: (i) => (i < cut ? 1 : i % 4 === 0 ? 1 : 0), gaps: [gap('2026-08-05', '2026-08-15')] }]).rows.find((z) => z.id === '1').months['2026-08'].parts[0];
  near(p.perDay, 0.25, 0.02); assert.equal(p.used, 'w');
  const q = run([...steady(), { id: '1', price: 2000, sell: (i) => (i < cut ? (i % 4 === 0 ? 1 : 0) : 1), gaps: [gap('2026-08-05', '2026-08-15')] }]).rows.find((z) => z.id === '1').months['2026-08'].parts[0];
  assert.ok(q.perDay < 0.5); assert.equal(q.used, 'y');
});
test('the first day on the website is not a day it ran out', () => {
  const day = IX('2026-06-10');
  const r = run([...steady(), { id: '1', price: 2000, sell: (i) => (i > day && i % 2 ? 1 : 0), createdAt: Date.parse('2026-06-10T05:00:00Z'), gaps: [[0, day]] }]);
  const x = r.rows.find((z) => z.id === '1'); assert.equal(x.times, 0); assert.equal(x.empty, 0);
});
test('only best sellers with 5+ pieces on 30+ full days carry ₹; the rest show speed and days', () => {
  const g = [gap('2026-08-05', '2026-08-15')];
  const r = run([...steady(), { id: '1', price: 60000, sell: (i) => (i % 20 === 0 ? 1 : 0), gaps: g }, { id: '2', price: 300, sell: (i) => (i % 9 === 0 ? 1 : 0), gaps: g }]);
  const a = r.rows.find((z) => z.id === '1'), b = r.rows.find((z) => z.id === '2');
  assert.equal(a.best, true); assert.equal(a.months['2026-08'].parts[0].no, 'few-sold'); assert.equal(a.empty, 10);
  assert.equal(b.best, false); assert.equal(b.lost, null); assert.equal(b.empty, 10); near(b.speed.perDay, 1 / 9, 0.01);
});
test('after 60 empty days: shown, never in the total', () => {
  const r = run([...steady(), { id: '1', price: 2000, sell: (i) => (i % 2 ? 1 : 0), gaps: [gap('2026-06-01', '2026-11-30')] }]);
  const x = r.rows.find((z) => z.id === '1'), parts = Object.values(x.months).flatMap((m) => m.parts);
  assert.equal(parts.reduce((q, p) => q + p.first, 0), 59.5); assert.equal(x.out, true); assert.equal(x.since, '2026-06-01');
  assert.equal(x.months['2026-10'].parts[0].lost, 0); assert.ok(x.months['2026-10'].parts[0].laterLost > 0);
});
test('"sells at 0" and another size in stock carry no ₹', () => {
  const r = run([...steady(), { id: '2', price: 2000, sell: () => 1, oversell: true, gaps: [gap('2026-08-05', '2026-08-15')] },
    { id: '3', product: 'two', price: 2000, sell: () => 1, gaps: [gap('2026-08-05', '2026-08-15')] }, { id: '4', product: 'two', price: 2000, sell: () => 1 }]);
  const of = (id) => r.rows.find((z) => z.id === id);
  assert.equal(of('2').empty, 0);
  assert.equal(of('3').months['2026-08'].parts[0].lost, 0); assert.equal(of('3').months['2026-08'].parts[0].sib, 10);
});
test('proof: a month whose test is over 25% too high, or with under 20 tests, shows no ₹', () => {
  const of = (g, n = 20) => T.score(Array.from({ length: n }, (_, i) => ({ id: `x${i}`, month: '2026-08', guess: g, real: 100 })))['2026-08'].pass;
  assert.equal(of(124), true); assert.equal(of(126), false); assert.equal(of(60), true); assert.equal(of(90, 19), false);
});
test('lock: a finished month never changes, whatever the data does later; the list holds for the quarter', () => {
  const rows = [...steady(), ...Array.from({ length: 6 }, (_, k) => ({ id: `${k + 1}`, price: 2000, sell: (i) => ((i + k) % 2 ? 1 : 0), gaps: [gap('2026-08-05', '2026-08-15')] }))];
  const a = run(rows), led = JSON.parse(JSON.stringify({ rule: T.RULE, ...a.lock }));
  assert.ok(led.months['2026-08'] && !led.months['2026-11'], 'the running month is not locked');
  rows[12].price = 5000; rows.push({ id: '50', price: 90000, sell: () => 3 });
  const b = run(rows, { ledger: led }), m = (r) => r.months.find((z) => z.key === '2026-08');
  assert.equal(m(b).best.lost, m(a).best.lost); assert.equal(m(b).best.low, m(a).best.low); assert.equal(m(b).lockedAt, m(a).lockedAt);
  assert.equal(b.rows.find((z) => z.id === '50').best, false, 'not on this quarter’s list');
  assert.deepEqual(run(rows, { ledger: led }).year, b.year, 'same data, same numbers');
});
test('ledger: only ever added to; another rule starts a new one and keeps the old', () => scope.run('truth-store', () => {
  fs.mkdirSync(scope.dir(), { recursive: true });
  assert.equal(ledger.get('2.0'), null);
  ledger.add('2.0', { lists: { '2026-10-01': { rows: [['1', 1, 5]] } }, months: { '2026-08': { low: 1 } } });
  ledger.add('2.0', { lists: {}, months: { '2026-08': { low: 99 }, '2026-09': { low: 2 } } });
  assert.equal(ledger.get('2.0').months['2026-08'].low, 1); assert.equal(ledger.get('2.0').months['2026-09'].low, 2);
  ledger.add('2.1', { lists: {}, months: { '2026-08': { low: 7 } } });
  assert.equal(ledger.get('2.0'), null); assert.equal(ledger.all().old['2.0'].months['2026-08'].low, 1);
}));
test('screens: every page adds up to the same ₹ (months, products, the period, the panel)', () => {
  const s = shop([...steady(), ...Array.from({ length: 6 }, (_, k) => ({ id: `${[1, 3, 4, 5, 6, 7][k]}`, price: 2000, sell: (i) => ((i + k) % 2 ? 1 : 0), gaps: [gap('2026-08-05', '2026-08-15'), gap('2026-10-25', '2026-11-04')] })), { id: '2', price: 300, sell: (i) => (i % 9 === 0 ? 1 : 0), gaps: [gap('2026-10-25', '2026-11-30')] }]);
  const t = T.report(s.y, s.cat, s.opts), b = S.brand(t), tot = b.months.reduce((q, m) => q + m.best.lost, 0);
  near(b.headline.lost, tot, 1); assert.ok(tot > 0); near(b.headline.could ?? b.headline.best.could, t.months.reduce((q, m) => q + m.bestSold, 0) + tot, 2); near(b.products.reduce((q, p) => q + p.lost, 0), tot, 3);
  const rep = { products: t.rows.map((x) => ({ id: x.id, sold: 0 })), totals: { sold: 0 }, daily: [] };
  S.period(rep, t, { from: t.span.from, to: t.span.to }); near(rep.totals.lost, tot, 3);
  const prof = S.profile({ ok: true, months: t.months.map((m) => ({ key: m.key })), pace: {} }, t, '1');
  near(prof.missed.value, t.rows.find((x) => x.id === '1').lost, 1); near(prof.work.gaps.reduce((q, g) => q + g.lost, 0), prof.missed.value, 2);
  assert.equal(b.countsNow.out, 1); assert.equal(b.nowAll.filter((p) => p.out).length + b.now.filter((p) => p.out).length, 1);
  assert.ok(!b.ads.push.some((p) => p.pace * 7 < 1), 'ads never push what sells under one a week');
});

test('what it sold on an empty or half day comes off that day', () => {
  const s = shop([...steady(), { id: '1', price: 2000, sell: () => 1, gaps: [gap('2026-08-05', '2026-08-15')] }]);
  s.y.sales.by['1']['2026-08-05'] = [3, 6000, 0, 6000]; s.y.sales.by['1']['2026-08-10'] = [2, 4000, 0, 4000]; s.y.moves.by['1']['2026-08-10'] = -2; s.y.moves.by['1']['2026-08-15'] += 2;
  const p = T.report(s.y, s.cat, s.opts).rows.find((z) => z.id === '1').months['2026-08'].parts[0];
  near(p.units, 8 * p.perDay + 0.5 * p.perDay, 0.02);   // 10 Aug and the run-out day sold more than it normally does: nothing missed
});
test('the 80% is of everything Shopify sold, drafts too; the range needs 5 estimates', () => {
  const s = shop([...steady(), { id: '1', price: 2000, sell: (i) => (i % 2 ? 1 : 0) }]), big = {};
  for (let i = 0; i < 200; i++) big[DAY(i)] = [1, 50000, 0, 50000];
  const before = T.report(s.y, s.cat, s.opts).best.n; s.y.sales.by['gone'] = big;
  assert.ok(T.report(s.y, s.cat, s.opts).best.n < before);
  assert.equal(T.range([{ month: 'a', lost: 5 }], [{ id: 'x', month: 'a', guess: 1, real: 1 }]), null);
  const r = T.range(Array.from({ length: 6 }, () => ({ month: 'a', lost: 100 })), Array.from({ length: 30 }, (_, i) => ({ id: `${i}`, month: 'a', guess: 1, real: 1 })));
  near(r.low, 510, 1); near(r.high, 690, 1);   // perfect tests: still ±15%
});

