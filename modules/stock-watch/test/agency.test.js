'use strict';
/* 1.4.0 (LOGIC §20–§22): days in / out from the walked-back stock, oversells, pace over in-stock days, the seasonal index
   and its caps, money missed split by month, the best-seller set. src/agency.js is pure: years are built by hand here. */
const test = require('node:test');
const assert = require('node:assert');
const A = require('../src/agency');

const kp = A.keyPlus;
/** A year from per-day stories: sales[id][day] = units, moves[id][day] = change; anchor day = `today`, levels now. */
function yearOf({ from, today, levels, sales = {}, moves = {}, price = 1000, all = null }) {
  const y = { v: 1, at: 1, anchor: { at: 1, day: today, levels }, sales: { from, to: kp(today, -1), by: {}, all: {} }, moves: { from, to: kp(today, -1), by: {} } };
  for (let k = from; k <= today; k = kp(k, 1)) y.sales.all[k] = [0, 0];
  for (const [id, m] of Object.entries(sales)) {
    y.sales.by[id] = {};
    for (const [k, u] of Object.entries(m)) { y.sales.by[id][k] = [u, u * price]; y.sales.all[k][0] += u; y.sales.all[k][1] += u * price; }
  }
  if (all) for (const [k, v] of Object.entries(all)) y.sales.all[k] = v;
  for (const [id, m] of Object.entries(moves)) y.moves.by[id] = { ...m };
  return y;
}
const cat = (ids, extra = {}) => Object.fromEntries(ids.map((id) => [id, { productId: `p${id}`, product: `Product ${id}`, sku: `S${id}`, price: 1180, active: true, tracked: true, ...(extra[id] || {}) }]));

test('day rules: in all day, out all day, half a day when it runs out or comes back; an oversell to −1 is not in stock', () => {
  // stock: 2 … sells 1 on 3 Nov (→1), 1 on 4 Nov (→0, ran out), nothing 5 Nov (out), restock +5 on 6 Nov (back), oversell on 8 Nov? no: today 9 Nov
  const y = yearOf({ from: '2026-11-01', today: '2026-11-09', levels: { 1: 5 }, sales: { 1: { '2026-11-03': 1, '2026-11-04': 1 } }, moves: { 1: { '2026-11-03': -1, '2026-11-04': -1, '2026-11-06': 5 } } });
  const d = A.days(y, '1', A.dayKeys('2026-11-01', '2026-11-08'));
  const m = Object.fromEntries(d.list.map((x) => [x.k, x.inF]));
  assert.deepEqual(m, { '2026-11-01': 1, '2026-11-02': 1, '2026-11-03': 1, '2026-11-04': 0.5, '2026-11-05': 0, '2026-11-06': 0.5, '2026-11-07': 1, '2026-11-08': 1 });
  // at 0, an order takes it to −1 (oversold): still out, and its unit never counts in the pace
  const o = yearOf({ from: '2026-11-01', today: '2026-11-04', levels: { 2: -1 }, sales: { 2: { '2026-11-03': 1 } }, moves: { 2: { '2026-11-03': -1 } } });
  const od = A.days(o, '2', A.dayKeys('2026-11-01', '2026-11-03'));
  assert.deepEqual(od.list.map((x) => [x.k, x.inF, x.over]), [['2026-11-01', 0, 0], ['2026-11-02', 0, 0], ['2026-11-03', 0, 1]]);
  // at 0 all day but sold 2: refilled and sold out inside the day → in stock that day
  const r = yearOf({ from: '2026-11-01', today: '2026-11-03', levels: { 3: 0 }, sales: { 3: { '2026-11-02': 2 } }, moves: {} });
  assert.equal(A.days(r, '3', A.dayKeys('2026-11-01', '2026-11-02')).list.find((x) => x.k === '2026-11-02').inF, 1);
});

test('a walk below min(stock now, 0) drops the variant (the log is incomplete), as in §1c', () => {
  const y = yearOf({ from: '2026-11-01', today: '2026-11-05', levels: { 1: 1 }, moves: { 1: { '2026-11-03': 4 } } });   // before 3 Nov: 1 − 4 = −3
  assert.deepEqual(A.days(y, '1', A.dayKeys('2026-11-01', '2026-11-04')), { dropped: true, low: -3 });
  const r = A.build(y, cat(['1']), {});
  assert.deepEqual(r.dropped, ['1']); assert.equal(r.headline.unsure, 1);
});

test('a product created inside the span counts from its first day in stock (not out before launch)', () => {
  const y = yearOf({ from: '2026-11-01', today: '2026-11-10', levels: { 1: 3 }, moves: { 1: { '2026-11-06': 3 } } });
  const d = A.days(y, '1', A.dayKeys('2026-11-01', '2026-11-09'), '2026-11-03');
  assert.equal(d.list[0].k, '2026-11-06');
});

test('pace: units ÷ in-stock days over the last 6 months, oversells out; under 14 in-stock days → 12 months; 7-day floor', () => {
  const list = [];
  for (let i = 0; i < 300; i++) { const k = kp('2026-01-01', i); list.push({ k, u: 2, over: 0, inF: i < 100 ? 1 : 0 }); }   // in stock Jan – 10 Apr, then out
  const shop = Object.fromEntries([...new Set(list.map((x) => x.k.slice(0, 7)))].map((m) => [m, 1]));
  const six = A.paceOf(list, kp('2026-10-27', -182), shop);
  assert.equal(six.basis, 'year', 'out for the last months: the window has < 14 in-stock days');
  assert.equal(six.perDay, 2);
  const inWin = A.paceOf(list.map((x, i) => ({ ...x, inF: 1, over: i % 2 })), kp('2026-10-27', -182), shop);
  assert.equal(inWin.basis, 'window'); assert.ok(Math.abs(inWin.perDay - 1.5) < 0.01, 'oversold units never count');
  const few = A.paceOf([{ k: '2026-11-01', u: 3, over: 0, inF: 1 }], '2026-05-01', { '2026-11': 1 });
  assert.equal(few.few, true); assert.equal(few.perDay, 3 / 7);
});

test('season: per month = in-stock pace that month ÷ 12-month pace, blended with the shop by in-stock days, capped 0.5–2.0', () => {
  const list = [];
  for (let i = 0; i < 61; i++) { const k = kp('2026-09-01', i); list.push({ k, u: k < '2026-10-01' ? 1 : 9, over: 0, inF: 1 }); }   // Sep 1 a day, Oct 9 a day
  const shop = { '2026-09': 1, '2026-10': 1 };
  const s = A.paceOf(list, '2026-09-01', shop);
  // 12-month pace = (30 + 279) / 61 = 5.07; Oct raw = 9 / 5.07 = 1.78, weight 31/45 → 0.69 × 1.78 + 0.31 × 1 = 1.54
  assert.equal(s.season['2026-10'], 1.54);
  assert.equal(s.season['2026-09'], 0.5, 'capped at 0.5 (raw 0.2, blended 0.45)');
  const big = A.paceOf(list.map((x) => ({ ...x, u: x.k < '2026-10-01' ? 0.01 : 50 })), '2026-09-01', shop);
  assert.ok(big.season['2026-10'] <= 2, 'capped at 2.0');
  const thin = A.paceOf(list.map((x) => ({ ...x, inF: x.k < '2026-10-01' ? 1 : (x.k < '2026-10-05' ? 1 : 0) })), '2026-09-01', { '2026-09': 0.8, '2026-10': 1.4 });
  assert.equal(thin.season['2026-10'], 1.4, 'under 7 in-stock days that month: the shop’s index');
  // shop index: units a day that month ÷ units a day over the span, capped
  const y = yearOf({ from: '2026-09-01', today: '2026-11-01', levels: {}, all: Object.fromEntries(A.dayKeys('2026-09-01', '2026-10-31').map((k) => [k, [k < '2026-10-01' ? 1 : 100, 0]])) });
  const sh = A.shopSeason(y, A.dayKeys('2026-09-01', '2026-10-31'));
  assert.equal(sh['2026-09'], 0.5); assert.equal(sh['2026-10'], 1.95);   // 100 ÷ (3,130 ÷ 61)
});

test('money missed: out-of-stock days × seasonal pace × average price paid, split by calendar month; a pace over Diwali is not applied to a quiet month', () => {
  // in stock 1 Sep – 31 Oct at 2 a day in Sep, 6 a day in Oct (busy); out from 1 Nov
  const sales = {}, moves = {};
  for (const k of A.dayKeys('2026-09-01', '2026-10-31')) { const u = k < '2026-10-01' ? 2 : 6; sales[k] = u; moves[k] = -u; }
  const lvlBefore = 2 * 30 + 6 * 31;   // stock on 31 Aug
  moves['2026-08-31'] = lvlBefore;
  const all = {};
  for (const k of A.dayKeys('2026-08-31', '2026-11-30')) all[k] = [k < '2026-10-01' ? 2 : k < '2026-11-01' ? 6 : 2, 0];
  const y = yearOf({ from: '2026-09-01', today: '2026-12-01', levels: { 1: 0 }, sales: { 1: sales }, moves: { 1: moves }, price: 900, all });
  const r = A.build(y, cat(['1']), { paceMonths: 6 });
  const p = r.products[0];
  assert.equal(p.best, true);
  assert.equal(p.price, 900, 'average price paid = net sales ÷ units');
  assert.deepEqual(Object.keys(p.months), ['2026-10', '2026-11']);
  assert.equal(p.months['2026-10'].daysOut, 0.5, 'ran out on 31 Oct: half a day');
  assert.equal(p.months['2026-11'].daysOut, 30);
  assert.equal(p.months['2026-11'].range, '1–30 Nov');
  // flat pace 4.03 a day would give 30 × 4.03 × 900 ≈ ₹1.09 L; the season puts November near September's pace
  assert.ok(p.months['2026-11'].lost < 30 * 4.03 * 900 * 0.75, `seasonal: ${p.months['2026-11'].lost}`);
  const nov = r.months.find((m) => m.key === '2026-11');
  assert.equal(nov.lost, p.months['2026-11'].lost); assert.equal(nov.bestOut, 1); assert.equal(nov.daysOut, 30);
  assert.ok(r.months.find((m) => m.key === '2026-10').lost > 0);
  assert.equal(r.months.length, 12); assert.equal(r.months[11].key, '2026-11');
  assert.equal(r.headline.lost, r.months.reduce((s, m) => s + m.lost, 0), 'the headline is the sum of the months');
  assert.equal(r.asOf.through, '2026-11-30');
});

test('best sellers = products making the top 80% of 12 months’ net sales (setting), variants summed per product', () => {
  const day = '2026-11-02';
  const y = yearOf({ from: '2026-11-01', today: '2026-11-05', levels: { 1: 5, 2: 5, 3: 5, 4: 5, 5: 5 }, sales: { 1: { [day]: 50 }, 2: { [day]: 30 }, 3: { [day]: 10 }, 4: { [day]: 6 }, 5: { [day]: 4 } }, moves: {} });
  const c = cat(['1', '2', '3', '4', '5'], { 5: { productId: 'p4' } });   // 4 and 5 are one product: 10
  const r = A.build(y, c, { bestShare: 0.8 });
  assert.deepEqual(r.products.filter((p) => p.best).map((p) => p.productId).sort(), ['p1', 'p2']);
  const r9 = A.build(y, c, { bestShare: 0.95 });
  assert.deepEqual(r9.products.filter((p) => p.best).map((p) => p.productId).sort(), ['p1', 'p2', 'p3', 'p4']);
  assert.equal(r.products.find((p) => p.productId === 'p4').variants, 2);
  assert.equal(A.build(y, cat(['1'], { 1: { active: false } }), {}).products.length, 0, 'products not on sale now are left out');
});

test('ranges: day keys → "4–11 Oct, 23 Oct"', () => {
  assert.equal(A.ranges(['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-23', '2026-10-31', '2026-11-01']), '4–6 Oct, 23 Oct, 31 Oct – 1 Nov');
  assert.equal(A.ranges([]), '');
});

test('fromRows: the same shape from the rows we hold (demo, Flow, Sheet, CSV)', () => {
  const dayOf = (t) => new Date(t + 330 * 60e3).toISOString().slice(0, 10);
  const t = (k, h = 6) => Date.parse(`${k}T0${h}:00:00Z`);
  const y = A.fromRows([{ t: t('2026-11-01'), variantId: '1', before: null, now: 2 }, { t: t('2026-11-02'), variantId: '1', before: 2, now: 0 }],
    [{ t: t('2026-11-02'), variantId: '1', qty: 2, price: 500 }], { dayOf, now: t('2026-11-05') });
  assert.deepEqual(y.anchor.levels, { 1: 0 });
  assert.deepEqual(y.moves.by['1'], { '2026-11-02': -2 });
  assert.deepEqual(y.sales.by['1'], { '2026-11-02': [2, 1000] });
  const r = A.build(y, cat(['1']), {});
  assert.equal(r.products[0].months['2026-11'].daysOut, 2.5, '2 Nov half, 3–4 Nov out');
});

test('engine: a long stock-out (rate from an older stretch) values ₹ lost at the 12-month seasonal pace when given; reorder keeps its rate', () => {
  const E = require('../src/engine');
  const DAY = 864e5, now = Date.parse('2026-11-24T06:00:00Z');
  const stock = [{ t: now - 70 * DAY, variantId: '9', sku: 'S9', product: 'Oak', variant: '', before: null, now: 40, price: 1000 }];
  const orders = [];
  for (let i = 0; i < 20; i++) orders.push({ t: now - (60 - i) * DAY, order: `#${i}`, line: String(i), variantId: '9', sku: 'S9', qty: 2, price: 1000 });
  stock.push({ t: now - 40 * DAY, variantId: '9', sku: 'S9', product: 'Oak', variant: '', before: 40, now: 0, price: 1000 });
  const base = E.report(stock, orders, {}, { now, days: 30 });
  const p0 = base.products.find((p) => p.id === '9');
  assert.notEqual(p0.rateBasis, 'window', 'out for the whole window: the rate looks back');
  const seasonal = E.report(stock, orders, {}, { now, days: 30, lossPace: { 9: 0.5 } });
  const p1 = seasonal.products.find((p) => p.id === '9');
  assert.equal(p1.lossPace, 0.5);
  assert.ok(Math.abs(p1.lost - p0.lost * 0.5 / p0.perDay) < p0.lost * 0.02, `₹ lost scales with the pace: ${p0.lost} → ${p1.lost}`);
  assert.equal(p1.perDay, p0.perDay, 'the reorder rate stays');
  assert.equal(p1.orderQty, p0.orderQty);
});
