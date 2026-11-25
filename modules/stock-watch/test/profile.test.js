'use strict';
/* 1.4.1 (LOGIC §24): the product drawer's 12-month profile, section by section (src/agency.js profile). Years built by hand. */
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/agency');
const kp = A.keyPlus;

/* Variant 1: in stock Dec 2025 – Jan 2026 at 2 a day (₹1,000 ex GST + 5% GST each), out 1–10 Feb, restocked +40 on 11 Feb,
   sells 2 a day to 28 Feb, out again from 1 Mar to the end (30 Nov). Variant 2: another product, 1 a day all year at ₹500. */
function fixture() {
  const from = '2025-12-01', today = '2026-12-01';
  const y = { v: 2, at: 1, anchor: { at: 1, day: today, levels: { 1: 0, 2: 10 } }, sales: { from, to: kp(today, -1), by: { 1: {}, 2: {} }, all: {} }, moves: { from, to: kp(today, -1), by: { 1: {}, 2: {} } } };
  let stock1 = 0; const s1 = [];
  for (const k of A.dayKeys(from, '2026-11-30')) {
    let u = 0;
    if (k < '2026-02-01' || (k >= '2026-02-11' && k < '2026-03-01')) u = 2;
    if (u) { y.sales.by[1][k] = [u, u * 1000, u * 50, u * 1100]; y.moves.by[1][k] = -u; }
    y.sales.by[2][k] = [1, 500, 25, 500]; y.moves.by[2][k] = -1;
    y.sales.all[k] = [u + 1, u * 1000 + 500];
    s1.push(k);
  }
  y.moves.by[1]['2026-02-11'] = (y.moves.by[1]['2026-02-11'] || 0) + 40;   // restock, then 2 sold that day: net +38
  /* stock before the span for variant 1: everything sold before 1 Feb (124 days × 2 = 124) runs it to 0 on 31 Jan */
  y.moves.by[1]['2025-11-30'] = 0; void stock1; void s1;
  const levelStart1 = A.dayKeys(from, '2026-01-31').length * 2;   // 124 → 0 at the end of 31 Jan
  y.moves.by[1][from] = (y.moves.by[1][from] || 0);   // nothing else
  /* walking back from 0 now: after 28 Feb it is 0; 11–28 Feb sold 36 of the 40; so at the end of 28 Feb stock = 4 − … keep it simple:
     put the spare 4 units out on 28 Feb as a correction so stock ends at 0 */
  y.moves.by[1]['2026-02-28'] -= 4;
  y.moves.by[1][kp(from, -1)] = levelStart1;   // the opening stock arrives the day before the span
  y.moves.by[2][kp(from, -1)] = 10 + A.dayKeys(from, '2026-11-30').length;
  const catalog = {
    1: { productId: 'p1', product: 'Oak', sku: 'O1', price: 1260, compareAt: 2520, active: true, tracked: true, type: 'Tables', vendor: 'Sammsara', tags: ['best seller'] },
    2: { productId: 'p2', product: 'Vase', sku: 'V2', price: 600, active: true, tracked: true },
  };
  return { y, catalog };
}

test('profile: sold, share, pace on in-stock days, on the shelf, stock-outs (times, longest, still out), missed, last restock', () => {
  const { y, catalog } = fixture();
  const r = A.build(y, catalog, { detail: '1' });
  const p = A.profile(r, y, catalog, '1');
  assert.equal(p.ok, true);
  assert.equal(p.span.from, '2025-12-01'); assert.equal(p.span.through, '2026-11-30');
  assert.equal(p.sold.units, 2 * (62 + 18)); assert.equal(p.sold.value, 160 * 1000);
  const store = r.months.reduce((s, m) => s + m.sold, 0);
  assert.ok(Math.abs(p.share - (160000 / store) * 100) < 0.01, `${p.share}%`);
  assert.equal(p.outs.times, 2, 'ran out 31 Jan – 11 Feb, and from 28 Feb');
  assert.equal(p.outs.open, true); assert.equal(p.outs.since, '2026-02-28', 'ran out on 28 Feb (half a day)');
  assert.deepEqual([p.outs.longest.from, p.outs.longest.to], ['2026-02-28', '2026-11-30']);
  assert.ok(p.inStock.pct > 20 && p.inStock.pct < 30, `${p.inStock.pct}% of 365 days`);
  assert.ok(Math.abs(p.pace.perDay - 2) < 0.1, `2 a day on days in stock: ${p.pace.perDay}`);
  assert.ok(Math.abs(p.pace.perWeek - p.pace.perDay * 7) < 0.05);
  assert.ok(p.missed.value > 0 && p.missed.units > 0);
  assert.deepEqual(p.lastRestock, { day: '2026-02-11', qty: 38 });
  assert.equal(p.rank.of, 2); assert.equal(p.best, true);
});

test('profile: price and discount — MRP = compare-at, paid with and without GST, GST %, off MRP and off list, by month', () => {
  const { y, catalog } = fixture();
  const p = A.profile(A.build(y, catalog, { detail: '1' }), y, catalog, '1');
  assert.deepEqual({ ...p.price, byMonth: undefined }, { list: 1260, mrp: 2520, paidEx: 1000, paidIn: 1050, gstPct: 5, offMrpPct: 58.33, offListPct: 16.67, byMonth: undefined });
  assert.equal(p.price.byMonth.length, 12);
  assert.deepEqual(p.price.byMonth.find((m) => m.key === '2026-01'), { key: '2026-01', units: 62, paidEx: 1000, paidIn: 1050 });
  assert.equal(p.price.byMonth.find((m) => m.key === '2026-05').paidIn, null, 'no sales that month');
  const v = A.profile(A.build(y, catalog, { detail: '2' }), y, catalog, '2');
  assert.equal(v.price.mrp, null, 'no compare-at price: no MRP');
});

test('profile: 12 months (units, missed, days out, season), day calendar, stock series with restocks', () => {
  const { y, catalog } = fixture();
  const p = A.profile(A.build(y, catalog, { detail: '1' }), y, catalog, '1');
  assert.equal(p.months.length, 12);
  const feb = p.months.find((m) => m.key === '2026-02'), jun = p.months.find((m) => m.key === '2026-06');
  assert.equal(feb.units, 36); assert.equal(feb.daysOut, 11, '1–10 Feb out, 11 Feb back (½), 28 Feb ran out (½)');
  assert.equal(jun.units, 0); assert.equal(jun.daysOut, 30); assert.ok(jun.missed + jun.apart > 0); assert.equal(jun.apart, 0, 'every empty day counts (1.5.0)');
  assert.ok(p.months.every((m) => m.season >= 0.5 && m.season <= 2));
  assert.equal(p.calendar.length, 365); assert.deepEqual(p.calendar[0], ['2025-12-01', 1]);
  assert.equal(p.stock.length, 365); assert.equal(p.stock[p.stock.length - 1][1], 0);
  assert.deepEqual(p.restocks, [['2026-02-11', 38]]);
  assert.ok(p.season.thisMonth && p.season.lastYear, 'this month and the same month a year before');
});

test('profile: unsure walks and no data say why', () => {
  assert.deepEqual(A.profile({ ok: false, reason: 'none' }), { ok: false, reason: 'none' });
  const { y, catalog } = fixture();
  assert.equal(A.profile(A.build(y, catalog, {}), y, catalog, '1').reason, 'none', 'build without detail');
});
