'use strict';
/* 1.4.0 (LOGIC §23): best sellers now; push / pause ads (src/sell.js), and the day a running stock-out began (agency.outRun). */
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/sell');
const A = require('../src/agency');

const brand = { products: [
  { productId: 'p1', name: 'Oak', best: true, ids: ['1'], variantId: '1', variantPace: { 1: 0.5 }, outFrom: { 1: '2026-11-04' }, months: { '2026-11': { daysOut: 19.5, lost: 31235, range: '4–23 Nov' } }, sold: 9, pace: { perDay: 0.5 } },
  { productId: 'p2', name: 'Vase', best: true, ids: ['2'], variantId: '2', variantPace: { 2: 2 }, outFrom: {}, months: {}, sold: 8, pace: { perDay: 2 } },
  { productId: 'p3', name: 'Slow', best: false, ids: ['3'], variantId: '3', variantPace: { 3: 0.1 }, outFrom: {}, months: {}, sold: 1, pace: { perDay: 0.1 } },
] };
const rows = [
  { id: '1', name: 'Oak', stock: 0, status: 'Out now', perDay: 0.9, price: 5000, mkt: 'pause', orderQty: 30, outSince: 1, backIn: 'Not ordered · earliest 1 Dec' },
  { id: '2', name: 'Vase', stock: 100, status: 'OK', perDay: 1, price: 1000, mkt: null, daysLeft: 50 },
  { id: '3', name: 'Slow', stock: 2, status: 'Slow seller', perDay: 0.1, price: 900, mkt: null, daysLeft: 20 },
  { id: '4', name: 'Gone', stock: 0, status: 'Inactive', perDay: 0, price: 1, mkt: null },
];

test('best sellers now: out first with the 12-month out-since day, this month’s days out and ₹, the refill state', () => {
  const n = S.bestNow(brand, rows, '2026-11');
  assert.deepEqual(n.map((p) => [p.name, p.out, p.outFromDay, p.daysOutMonth, p.lostMonth, p.orderQty]), [['Oak', true, '2026-11-04', 19.5, 31235, 30], ['Vase', false, null, 0, 0, 0]]);
  assert.equal(n[1].stock, 100);
});

test('push = in stock, selling, ≥ max(21 d, lead + buffer) of stock at the 12-month pace, by ₹ a day; pause = can’t be bought, best sellers first', () => {
  const a = S.ads(brand, rows, { leadDays: 7, safetyDays: 3 });
  assert.equal(a.coverDays, 21);
  assert.deepEqual(a.push.map((p) => [p.name, p.coverWeeks, p.perDayValue]), [['Vase', 7, 2000]], 'Slow: 2 pcs ÷ 0.1 a day = 20 days, under 21');
  assert.deepEqual(a.pause.map((p) => [p.name, p.best, p.outFromDay]), [['Oak', true, '2026-11-04']]);
  assert.equal(S.ads(brand, rows, { leadDays: 60, safetyDays: 10 }).coverDays, 70);
  assert.equal(S.ads(null, rows, {}).push[0].pace, 1, 'without the 12 months: the 28-day rate');
});

test('outRun: the first day of the stock-out running at the end; null when in stock at the end', () => {
  const L = (fs) => fs.map((f, i) => ({ k: `2026-11-0${i + 1}`, inF: f }));
  assert.equal(A.outRun(L([1, 1, 0.5, 0, 0])), '2026-11-03');
  assert.equal(A.outRun(L([0, 0, 0])), '2026-11-01');
  assert.equal(A.outRun(L([0, 1])), null);
  assert.equal(A.outRun([]), null);
});
