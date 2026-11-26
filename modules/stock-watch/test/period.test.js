'use strict';
/* SW-027: "This month" period and the Yesterday strip (LOGIC.md §5a). */
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine');
const P = require('../src/period');

const H = E.HOUR, D = E.DAY, IST = 330;
// 19 Nov 2026, 10:00 in India (04:30 UTC)
const now = Date.parse('2026-11-19T04:30:00Z');

test('month start is the 1st at 00:00 store time', () => {
  assert.equal(new Date(P.monthStart(now, IST)).toISOString(), '2026-10-31T18:30:00.000Z');   // 1 Nov 00:00 IST
  assert.equal(new Date(P.monthStart(now, 0)).toISOString(), '2026-11-01T00:00:00.000Z');
  // 31 Oct 20:00 UTC is already 1 Nov in India
  assert.equal(new Date(P.monthStart(Date.parse('2026-10-31T20:00:00Z'), IST)).toISOString(), '2026-10-31T18:30:00.000Z');
});

test('range: "month" gives from = month start; numbers and junk give days', () => {
  assert.deepEqual(P.range('month', now, IST), { period: 'month', from: P.monthStart(now, IST) });
  /* 1.1.5: N store-calendar days, today included: from 00:00 store time N − 1 days ago */
  assert.deepEqual(P.range('14', now, IST), { period: 'days', days: 14, from: Date.parse('2026-11-06T00:00:00+05:30') });
  assert.deepEqual(P.range(null, now, IST), { period: 'days', days: 30, from: Date.parse('2026-10-21T00:00:00+05:30') });
  assert.deepEqual(P.range('x', now, IST), { period: 'days', days: 30, from: Date.parse('2026-10-21T00:00:00+05:30') });
  assert.deepEqual(P.range('1', now, IST), { period: 'days', days: 1, from: Date.parse('2026-11-19T00:00:00+05:30') }, '1 day = today so far');
  assert.equal(P.range('500', now, IST).days, 90, 'never more than 90 days');
});

test('calendar days (1.1.5): "30 days" on 20 Nov = 22 Oct – 20 Nov, store time; daylight saving zones count calendar days', () => {
  const t = Date.parse('2026-11-20T16:00:00Z');   // 20 Nov 21:30 IST
  assert.equal(P.range('30', t, 'Asia/Kolkata').from, Date.parse('2026-10-22T00:00:00+05:30'));
  assert.equal(P.range('7', t, 'Asia/Kolkata').from, Date.parse('2026-11-14T00:00:00+05:30'));
  assert.equal(P.range('60', t, 'Asia/Kolkata').from, Date.parse('2026-09-22T00:00:00+05:30'));
  /* just after midnight: today is the new day */
  assert.equal(P.range('7', Date.parse('2026-11-20T18:31:00Z'), 'Asia/Kolkata').from, Date.parse('2026-11-15T00:00:00+05:30'));
  /* London: clocks went back on Sun 25 Oct 2026 (BST → GMT). 7 days on 28 Oct = 22 Oct 00:00 BST, a 25-hour day inside */
  const lon = Date.parse('2026-10-28T12:00:00Z');
  assert.equal(P.range('7', lon, 'Europe/London').from, Date.parse('2026-10-22T00:00:00+01:00'));
  assert.equal(P.range('1', lon, 'Europe/London').from, Date.parse('2026-10-28T00:00:00Z'));
  /* New York: clocks go forward on 8 Mar 2026 (EST → EDT, a 23-hour day) */
  assert.equal(P.range('3', Date.parse('2026-03-09T15:00:00Z'), 'America/New_York').from, Date.parse('2026-03-07T00:00:00-05:00'));
  /* the report over that period: N day buckets, the first one starting at midnight */
  const r = E.report([], [], { timeZone: 'Europe/London' }, { now: lon, ...P.range('7', lon, 'Europe/London') });
  assert.equal(r.days, 7);
  assert.deepEqual(r.daily.map((d) => d.day), ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28']);
});

test('calendar days (1.1.5): every number follows the same dates — an order at 23:59 the day before is out, 00:00 is in', () => {
  const t = Date.parse('2026-11-20T16:00:00Z'), span = P.range('7', t, 'Asia/Kolkata');
  const orders = [
    { t: span.from - 60e3, order: 'a', variantId: 1, sku: 'A', qty: 1, price: 1000, ordered: 1 },   // 13 Nov 23:59 IST
    { t: span.from, order: 'b', variantId: 1, sku: 'A', qty: 2, price: 1000, ordered: 2 },            // 14 Nov 00:00 IST
  ];
  const r = E.report([], orders, { timeZone: 'Asia/Kolkata' }, { now: t, ...span });
  assert.equal(r.totals.sold, 2000);
  assert.equal(r.totals.unitsOrdered, 2);
  assert.equal(r.daily[0].day, '2026-11-14');
  assert.equal(r.daily.length, 7);
  /* the product drawer's daily bars: the same 7 days */
  const d = E.productDetail('1', [], orders, { timeZone: 'Asia/Kolkata' }, { now: t, ...span });
  assert.deepEqual(d.dailyUnits.map((x) => x.day), r.daily.map((x) => x.day));
  assert.equal(d.dailyUnits[0].units, 2);
});

test('report with from = month start counts only this month', () => {
  const orders = [
    { t: P.monthStart(now, IST) - H, order: 'a', variantId: 1, sku: 'A', qty: 1, price: 1000 },   // 31 Oct 23:00 IST: last month
    { t: P.monthStart(now, IST) + H, order: 'b', variantId: 1, sku: 'A', qty: 2, price: 1000 },   // 1 Nov 01:00 IST
    { t: now - 2 * H, order: 'c', variantId: 1, sku: 'A', qty: 3, price: 1000 },
  ];
  const stock = [{ t: now - 40 * D, variantId: 1, sku: 'A', product: 'A', before: 0, now: 100, price: 1000 }];
  const r = E.report(stock, orders, { tzOffsetMin: IST }, { now, from: P.monthStart(now, IST) });
  assert.equal(r.totals.sold, 5000);
  assert.equal(r.days, 19);                                  // 1–19 Nov, partial today included
  assert.equal(r.daily[0].day, '2026-11-01');
  assert.equal(r.daily.at(-1).day, '2026-11-19');
  assert.equal(r.daily.reduce((s, d) => s + d.sold, 0), r.totals.sold);
  // a number of days still works the old way
  assert.equal(E.report(stock, orders, { tzOffsetMin: IST }, { now, days: 30 }).totals.sold, 6000);
});

test('from is never more than 90 days back and never after now', () => {
  const r = E.report([], [], {}, { now, from: now - 400 * D });
  assert.equal(r.from, now - 90 * D);
  assert.equal(E.report([], [], {}, { now, from: now + D }).from, now);
});

test('yesterday: sold and lost on yesterday’s store-time day, products that ran out and came back', () => {
  const y0 = P.dayStart(now, IST) - D;                        // 18 Nov 00:00 IST
  const stock = [
    { t: now - 30 * D, variantId: 1, sku: 'A', product: 'A', before: 0, now: 50, price: 500 },
    { t: y0 + 10 * H, variantId: 1, sku: 'A', product: 'A', before: 1, now: 0, price: 500 },      // A ran out yesterday 10:00
    { t: now - 30 * D, variantId: 2, sku: 'B', product: 'B', before: 0, now: 50, price: 500 },
    { t: y0 - 3 * D, variantId: 2, sku: 'B', product: 'B', before: 1, now: 0, price: 500 },       // B out 3 days before…
    { t: y0 + 5 * H, variantId: 2, sku: 'B', product: 'B', before: 0, now: 40, price: 500 },      // …back yesterday 05:00
    { t: y0 + 6 * H, variantId: 2, sku: 'B', product: 'B', before: 40, now: 0, price: 500 },      // out again 06:00 (counts once)
    { t: y0 + 7 * H, variantId: 2, sku: 'B', product: 'B', before: 0, now: 30, price: 500 },      // back 07:00
  ];
  const orders = [];
  for (let i = 0; i < 25; i++) orders.push({ t: now - (i + 2) * D, order: 'o' + i, variantId: 1, sku: 'A', qty: 2, price: 500 });
  orders.push({ t: y0 + 2 * H, order: 'y1', variantId: 1, sku: 'A', qty: 3, price: 500 });          // yesterday
  orders.push({ t: y0 - H, order: 'y0', variantId: 1, sku: 'A', qty: 9, price: 500 });              // the day before
  orders.push({ t: now - H, order: 't', variantId: 2, sku: 'B', qty: 9, price: 500 });              // today
  const r = E.report(stock, orders, { tzOffsetMin: IST }, { now, days: 30 });
  const y = P.yesterday(r, IST);
  assert.equal(y.day, '2026-11-18');
  assert.equal(y.sold, 1500);
  assert.equal(y.ranOut, 2);                                  // A, and B (twice, counted once)
  assert.equal(y.back, 1);                                    // B
  const bar = r.daily.find((d) => d.day === '2026-11-18');
  assert.equal(y.lost, bar.lost);                             // same number as the chart bar
  assert.ok(y.lost > 0);
});

test('yesterday when the period starts today (1st of the month): worked out from a 2-day report', () => {
  const first = Date.parse('2026-11-01T06:30:00Z');           // 1 Nov 12:00 IST
  const orders = [{ t: Date.parse('2026-10-31T10:00:00Z'), order: 'a', variantId: 1, sku: 'A', qty: 2, price: 700 }];   // 31 Oct IST
  const stock = [{ t: first - 20 * D, variantId: 1, sku: 'A', product: 'A', before: 0, now: 100, price: 700 }];
  const r = E.report(stock, orders, { tzOffsetMin: IST }, { now: first, from: P.monthStart(first, IST) });
  assert.equal(P.yesterday(r, IST), null);
  const y = P.yesterdayFor(stock, orders, { tzOffsetMin: IST }, r);
  assert.equal(y.day, '2026-10-31');
  assert.equal(y.sold, 1400);
  /* the server passes the page's own options (incl. from = month start); they must not undo the 2-day window */
  const y2 = P.yesterdayFor(stock, orders, { tzOffsetMin: IST }, r, { from: P.monthStart(first, IST), period: 'month', onOrder: {} });
  assert.deepEqual(y2, y);
});

test('asOf drops rows after the cut', () => {
  const a = P.asOf([{ t: 1 }, { t: 5 }], [{ t: 2 }, { t: 9 }], 5);
  assert.deepEqual(a, { stock: [{ t: 1 }, { t: 5 }], orders: [{ t: 2 }] });
});

test('4.1.0 Custom: "a..b" gives store days a to b, both included; never past today; at most 90 days', () => {
  const now = Date.parse('2026-11-26T10:00:00Z'), z = 330;
  const r = P.range('2026-10-01..2026-10-31', now, z);
  assert.equal(r.period, 'custom'); assert.equal(r.days, 31); assert.equal(r.to, '2026-10-31');
  assert.equal(r.from, Date.parse('2026-09-30T18:30:00Z')); assert.equal(r.now, Date.parse('2026-10-31T18:30:00Z'));
  const back = P.range('2026-10-31..2026-10-01', now, z); assert.equal(back.from, r.from); assert.equal(back.to, '2026-10-31');
  const late = P.range('2026-11-20..2026-12-31', now, z); assert.equal(late.to, '2026-11-26'); assert.equal(late.now, now);
  const long = P.range('2026-01-01..2026-11-20', now, z); assert.equal(long.days, 90); assert.equal(long.fromKey, '2026-08-23');
  assert.equal(P.range('nonsense', now, z).period, 'days');
});
