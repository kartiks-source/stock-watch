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

test('season: per calendar month, smoothed over the month either side (1-2-1), blended with the shop by in-stock days, capped 0.5–2.0', () => {
  const list = [];
  for (let i = 0; i < 61; i++) { const k = kp('2026-09-01', i); list.push({ k, u: k < '2026-10-01' ? 1 : 9, over: 0, inF: 1 }); }   // Sep 1 a day, Oct 9 a day
  const shop = { '2026-09': 1, '2026-10': 1 };
  const s = A.paceOf(list, '2026-09-01', shop);
  // 12-month pace = 309 / 61 = 5.07. Oct: (Sep 30 + 2 × Oct 279 + Nov 0) / (30 + 62) = 6.39 a day → raw 1.26, weight 92/120 → 1.20
  assert.equal(s.season['2026-10'], 1.2);
  // Sep: (Aug 0 + 2 × 30 + Oct 279) / (60 + 31) = 3.73 → raw 0.73, weight 91/119 → 0.80
  assert.equal(s.season['2026-09'], 0.8);
  const big = A.paceOf(list.map((x) => ({ ...x, u: x.k < '2026-10-01' ? 0.01 : 50 })), '2026-09-01', shop);
  assert.ok(big.season['2026-10'] <= 2 && big.season['2026-09'] >= 0.5, 'capped 0.5–2.0');
  const thin = A.paceOf(list.slice(0, 5), '2026-09-01', { '2026-09': 0.8, '2026-10': 1.4 });
  assert.deepEqual(thin.season, { '2026-09': 0.8, '2026-10': 1.4 }, 'under 12 units in the year: the shop’s index');
  // the same calendar month in two years is one month (Nov 2025 + Nov 2026)
  const two = A.paceOf([...A.dayKeys('2025-11-01', '2025-11-30').map((k) => ({ k, u: 2, over: 0, inF: 1 })), ...A.dayKeys('2026-11-01', '2026-11-30').map((k) => ({ k, u: 2, over: 0, inF: 1 }))], '2026-06-01', { '2025-11': 1, '2026-11': 1 });
  assert.equal(two.season['2025-11'], two.season['2026-11']);
  // shop index: units a day that month ÷ units a day over the span, capped
  const y = yearOf({ from: '2026-09-01', today: '2026-11-01', levels: {}, all: Object.fromEntries(A.dayKeys('2026-09-01', '2026-10-31').map((k) => [k, [k < '2026-10-01' ? 1 : 100, 0]])) });
  const sh = A.shopSeason(y, A.dayKeys('2026-09-01', '2026-10-31'));
  assert.equal(sh['2026-09'], 0.5); assert.equal(sh['2026-10'], 1.95);   // 100 ÷ (3,130 ÷ 61)
});

test('money missed: out-of-stock days × seasonal pace × average price paid, split by calendar month; a month it was out takes its season from the months around it, not the busiest month alone', () => {
  // in stock Dec 2025 – Oct 2026: 2 a day in Dec, 3 a day Jan–Sep, 6 a day in Oct (busy); out from 1 Nov
  const sales = {}, moves = {};
  for (const k of A.dayKeys('2025-12-01', '2026-10-31')) { const u = k < '2026-01-01' ? 2 : k < '2026-10-01' ? 3 : 6; sales[k] = u; moves[k] = -u; }
  moves['2025-11-30'] = Object.values(sales).reduce((a, b) => a + b, 0);   // stock on 30 Nov 2025 = everything sold after it
  const all = {};
  for (const k of A.dayKeys('2025-11-30', '2026-11-30')) all[k] = [k < '2026-10-01' ? 3 : k < '2026-11-01' ? 6 : 3, 0];
  const y = yearOf({ from: '2025-12-01', today: '2026-12-01', levels: { 1: 0 }, sales: { 1: sales }, moves: { 1: moves }, price: 900, all });
  const r = A.build(y, cat(['1']), { paceMonths: 6 });
  const p = r.products[0];
  assert.equal(p.best, true);
  assert.equal(p.price, 900, 'average price paid = net sales ÷ units');
  assert.equal(p.months['2026-10'].daysOut, 0.5, 'ran out on 31 Oct: half a day');
  assert.equal(p.months['2026-11'].daysOut, 30);
  assert.equal(p.months['2026-11'].range, '1–30 Nov');
  const perDay = p.months['2026-11'].units / 30;
  assert.ok(perDay > 3 && perDay < 6 * 0.8, `November between the quiet months and October’s rush: ${perDay.toFixed(2)} a day`);
  const nov = r.months.find((m) => m.key === '2026-11');
  assert.equal(nov.lost, p.months['2026-11'].lost); assert.equal(nov.bestOut, 1); assert.equal(nov.daysOut, 30);
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
  const off = A.build(y, cat(['1', '2'], { 1: { active: false } }), {}).products;   // 1.4.6: kept for its past, never a best seller
  assert.deepEqual(off.map((p) => [p.productId, !!p.inactive, p.best]).sort(), [['p1', true, false], ['p2', false, true]]);
  assert.equal(A.build(y, cat(['9'], { 9: { active: false } }), {}).products.length, 0, 'not on sale and never sold: left out');
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

test('a website allocation (§6) keeps its gaps on the product but out of the month totals and the headline', () => {
  const y = yearOf({ from: '2026-11-01', today: '2026-11-10', levels: { 1: 0, 2: 0 }, sales: { 1: { '2026-11-02': 5 }, 2: { '2026-11-02': 5 } }, moves: { 1: { '2026-11-02': -5 }, 2: { '2026-11-02': -5 } } });
  const r = A.build(y, cat(['1', '2']), { apart: new Set(['2']) });
  const p1 = r.products.find((p) => p.productId === 'p1'), p2 = r.products.find((p) => p.productId === 'p2');
  assert.equal(p2.allocation, true); assert.ok(p2.lost > 0);
  const nov = r.months.find((m) => m.key === '2026-11');
  assert.equal(nov.lost, p1.months['2026-11'].lost); assert.equal(nov.lostApart, p2.months['2026-11'].lost); assert.equal(nov.bestOut, 1);
  assert.equal(r.headline.apart, 1); assert.equal(r.headline.lostApart, p2.lost);
});

test('a short span (first load still reading) ranks best sellers on Shopify’s 26 weeks when given', () => {
  const day = '2026-11-02';
  const y = yearOf({ from: '2026-11-01', today: '2026-11-05', levels: { 1: 5, 2: 5 }, sales: { 1: { [day]: 50 }, 2: { [day]: 1 } }, moves: {} });
  assert.deepEqual(A.build(y, cat(['1', '2']), { bestShare: 0.5 }).products.filter((p) => p.best).map((p) => p.productId), ['p1']);
  assert.deepEqual(A.build(y, cat(['1', '2']), { bestShare: 0.5, rankBy: { 1: 10, 2: 900 } }).products.filter((p) => p.best).map((p) => p.productId), ['p2']);
});

/* Live check, 24 Nov 2026 (coordinator: Oakwood ≈ ₹74k, Nivaya ≈ ₹40k counted, Seville ≈ ₹10k + ₹14k in 1–24 Nov). The 1.3.0
   engine on the same store, 1–23 Nov: Oakwood ₹68,514 (0.69 a day: its last 28 in-stock days, Oct), Nivaya ₹51,591 (0.45 a day,
   October's festive pace), Seville ₹18,898 (0.13 a day). Shopify's own months (in-stock days from the walk): Oakwood Oct 2026
   0.45 a day, Dec 2025 0.77, Jan 0.58, Sep 0.20; Nivaya Oct 0.45, Dec 0.23, Sep 0.10, Nov 2025 16 units; Seville Sep 0.14,
   Oct 0.19. The brand report uses the 6-month pace × the calendar month's season (Nov pooled over 2025 and 2026, smoothed with
   Oct and Dec), so it sits between the quiet months and the October rush: within 25% of the engine for Oakwood and Nivaya;
   Seville above it because last November (9 units) and October lift its season. Fixture: test/fixtures/sammsara-3-year.json. */
test('Sammsara fixture: Oakwood, Nivaya, Seville November figures (1–23 Nov) against the 1.3.0 engine', () => {
  const fx = require('./fixtures/sammsara-3-year.json');
  const r = A.build(fx.y, fx.catalog, { dayOf: (t) => new Date(t + 330 * 60e3).toISOString().slice(0, 10) });
  const nov = (n) => r.products.find((p) => p.name === n).months['2026-11'];
  const near = (x, ref, tol, what) => assert.ok(Math.abs(x - ref) <= tol * ref, `${what}: ₹${x} vs ₹${ref} (±${tol * 100}%)`);
  const oak = nov('Oakwood Table Set of 2'), niv = nov('Nivaya Table Set of 2'), sev = nov('Seville Nesting Table Set of 3');
  assert.equal(oak.range, '4–23 Nov'); assert.equal(oak.daysOut, 19.5);   // out from 4 Nov 18:00 IST: 4 Nov is half a day
  assert.equal(niv.range, '1–23 Nov'); assert.equal(sev.range, '1–23 Nov');
  near(oak.lost, 68514, 0.25, 'Oakwood vs 1.3.0'); near(niv.lost, 51591, 0.25, 'Nivaya vs 1.3.0'); near(sev.lost, 18898, 0.4, 'Seville vs 1.3.0');
  near(oak.lost, 57430, 0.02, 'Oakwood pinned'); near(niv.lost, 41828, 0.02, 'Nivaya pinned'); near(sev.lost, 25386, 0.02, 'Seville pinned');
});

/* 1.4.3: one pace for money missed everywhere. The brand report's November for a product = the report's ₹ lost (engine) for
   the same dates, within rounding, when the report is given the brand report's monthly pace and price (server.js lossOpts). */
test('brand report month = report ₹ lost for the same dates (same §21 pace and price on every page)', () => {
  const E = require('../src/engine');
  const IST = 330 * 60e3, at = (k, hh = 12) => Date.parse(`${k}T${String(hh).padStart(2, '0')}:00:00Z`) - IST;
  const dayOf = (t) => new Date(t + IST).toISOString().slice(0, 10);
  const sales = {}, moves = {}, orders = [];
  const days = A.dayKeys('2026-09-01', '2026-10-31');
  for (const k of days) { sales[k] = 2; moves[k] = -2; orders.push({ t: at(k), order: `#${k}`, line: k, variantId: '9', sku: 'S9', qty: 2, price: 1500 }); }
  moves['2026-08-31'] = 2 * days.length;
  const y = yearOf({ from: '2026-09-01', today: '2026-11-24', levels: { 9: 0 }, sales: { 9: sales }, moves: { 9: moves }, price: 1500 });
  const catalog = { 9: { productId: 'p9', product: 'Oak', sku: 'S9', price: 1800, active: true, tracked: true, stock: 0 } };
  const r = A.build(y, catalog, { dayOf });
  const p = r.products[0];
  const stock = [{ t: at('2026-09-01', 0), variantId: '9', sku: 'S9', product: 'Oak', variant: '', before: null, now: 2 * days.length, price: 1800 },
    { t: at('2026-10-31', 23), variantId: '9', sku: 'S9', product: 'Oak', variant: '', before: 2, now: 0, price: 1800 }];
  const rep = E.report(stock, orders, {}, { from: at('2026-11-01', 0), now: at('2026-11-24', 0) - 1, lossPace: { 9: p.monthPace['9'] }, lossPrice: { 9: p.variantPrice['9'] } });
  const row = rep.products.find((x) => x.id === '9');
  assert.equal(p.months['2026-11'].daysOut, 23);
  assert.ok(Math.abs(row.lost - p.months['2026-11'].lost) <= 2, `report ₹${row.lost} vs brand report ₹${p.months['2026-11'].lost}`);
  assert.equal(row.lossPrice, 1500, 'the 12-month average price paid');
  assert.equal(row.perDay > 0, true, 'Sells / reorder keep the 28-day rate');
  /* without the 12 months the engine keeps its own rate */
  const plain = E.report(stock, orders, {}, { from: at('2026-11-01', 0), now: at('2026-11-24', 0) - 1 }).products.find((x) => x.id === '9');
  assert.equal(plain.lossPace, undefined);
});

/* 1.4.4: the brand report keeps apart the same parts as the pages (§4c): counted = the report's lostCounted for the same
   dates; "restock or drop?" (after day 30, nothing ordered) apart on both, to within one day's value */
test('brand report parts = report parts for the same product and dates (counted, restock or drop?)', () => {
  const E = require('../src/engine');
  const IST = 330 * 60e3, at = (k, hh = 12) => Date.parse(`${k}T${String(hh).padStart(2, '0')}:00:00Z`) - IST;
  const dayOf = (t) => new Date(t + IST).toISOString().slice(0, 10);
  const sales = {}, moves = {}, orders = [];
  const days = A.dayKeys('2026-09-01', '2026-10-31');
  for (const k of days) { sales[k] = 2; moves[k] = -2; orders.push({ t: at(k), order: `#${k}`, line: k, variantId: '9', sku: 'S9', qty: 2, price: 1500 }); }
  moves['2026-08-31'] = 2 * days.length;
  const stock = [{ t: at('2026-09-01', 0), variantId: '9', sku: 'S9', product: 'Oak', variant: '', before: null, now: 2 * days.length, price: 1800 },
    { t: at('2026-10-31', 23), variantId: '9', sku: 'S9', product: 'Oak', variant: '', before: 2, now: 0, price: 1800 }];
  const catalog = { 9: { productId: 'p9', product: 'Oak', sku: 'S9', price: 1800, active: true, tracked: true, stock: 0 } };
  for (const [today, label] of [['2026-11-24', 'out 23 days'], ['2026-12-11', 'out 40 days: after day 30 apart']]) {
    const y = yearOf({ from: '2026-09-01', today, levels: { 9: 0 }, sales: { 9: sales }, moves: { 9: moves }, price: 1500 });
    const r0 = A.build(y, catalog, { dayOf }), p0 = r0.products[0];
    const opts = { from: at('2026-11-01', 0), now: at(today, 0) - 1, lossPace: { 9: p0.monthPace['9'] }, lossPrice: { 9: p0.variantPrice['9'] } };
    const row = E.report(stock, orders, {}, opts).products.find((x) => x.id === '9');
    const info = { 9: { confidence: row.confidence, nrDays: row.nrDays, ordered: !!row.onOrder, allocation: !!row.allocation } };
    const p = A.build(y, catalog, { dayOf, rowInfo: info }).products[0];
    const sum = (k) => Object.entries(p.months).filter(([m]) => m >= '2026-11').reduce((s, [, x]) => s + (x[k] || 0), 0);
    const day = p0.monthPace['9']['2026-11'] * 1500;
    assert.ok(Math.abs(sum('counted') - row.lostCounted) <= day + 2, `${label}: counted ₹${sum('counted')} vs report ₹${row.lostCounted}`);
    assert.ok(Math.abs(sum('nr') - row.lostNotRestocked) <= day + 2, `${label}: restock or drop? ₹${sum('nr')} vs report ₹${row.lostNotRestocked}`);
    if (today === '2026-12-11') assert.ok(sum('nr') > 0 && row.lostNotRestocked > 0, 'both keep the part after day 30 apart');
  }
});

test('one best-seller definition: with the brand report’s set the report’s A = that set; the period rank stays as salesRank', () => {
  const E = require('../src/engine');
  const now = Date.parse('2026-11-24T06:00:00Z'), DAY = 864e5, stock = [], orders = [];
  for (const [id, q] of [['1', 9], ['2', 5], ['3', 1]]) {
    stock.push({ t: now - 50 * DAY, variantId: id, sku: `S${id}`, product: `P${id}`, variant: '', before: null, now: 500, price: 100 });
    for (let i = 1; i < 28; i++) orders.push({ t: now - i * DAY, order: `#${id}-${i}`, line: `${id}-${i}`, variantId: id, sku: `S${id}`, qty: q, price: 100 });
  }
  const own = E.report(stock, orders, {}, { now, days: 30 });
  assert.equal(own.products.find((p) => p.id === '1').abc, 'A', 'without the set: the period’s rank');
  const one = E.report(stock, orders, {}, { now, days: 30, bestIds: new Set(['3']) });
  assert.deepEqual(one.products.filter((p) => p.abc === 'A').map((p) => p.id), ['3']);
  assert.equal(one.products.find((p) => p.id === '1').salesRank, 'A');
  assert.equal(one.totals.bestsellers, 1);
});
