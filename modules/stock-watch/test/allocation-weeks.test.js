'use strict';
/* 1.3.0: website allocations (LOGIC §6), weekly-sales confidence G26 (§4c), the 26-week floor rate (§3), the
   not-restocked cutoff (§4c), still-out ₹/day on the counted part (§15a), src/weeks.js. */
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine');
const H = require('../src/helpers');
const W = require('../src/weeks');
const DG = require('../src/digest');

const HOUR = E.HOUR, DAY = E.DAY, now = Date.UTC(2026, 10, 24, 6);   // Tue 24 Nov 2026, 11:30 IST
const S = { tzOffsetMin: 330, leadDays: 7, coverDays: 15, safetyDays: 3, demandWindowDays: 28, minPerDay: 0.2 };

/* Cascade: sells 3 a day; the website shows at most 7 pcs and the warehouse tops it back up to 7 within hours */
function cascade(id = 'c', refills = 6, gapH = 4, every = 2) {
  const stock = [{ t: now - 50 * DAY, variantId: id, before: null, now: 7, price: 7000, src: 'shopify' }], orders = [];
  let n = 0;
  for (let d = 40; d >= 1; d--) for (let k = 0; k < 3; k++) orders.push({ t: now - d * DAY + (8 + k * 3) * HOUR, order: `#${id}${++n}`, variantId: id, qty: 1, price: 7000 });
  for (let i = 0; i < refills; i++) {
    const t = now - (2 + i * every) * DAY - gapH * HOUR;
    stock.push({ t, variantId: id, before: 1, now: 0, price: 7000, src: 'shopify' }, { t: t + gapH * HOUR, variantId: id, before: 0, now: 7, price: 7000, src: 'shopify' });
  }
  stock.push({ t: now - 3 * HOUR, variantId: id, before: 7, now: 4, price: 7000, src: 'shopify' });
  return { stock: stock.sort((a, b) => a.t - b.t), orders };
}

test('allocationOf: 3+ refills in 14 d to the same level ≤ 10, every gap under 48 h', () => {
  assert.deepEqual(E.allocationOf(cascade().stock, now), { level: 7, refills: 6 });
  assert.equal(E.allocationOf(cascade('c', 2).stock, now), null, 'two refills: not enough');
  const big = cascade().stock.map((r) => ({ ...r, now: r.now === 7 ? 40 : r.now, before: r.before === 7 ? 40 : r.before }));
  assert.equal(E.allocationOf(big, now), null, 'refilled to 40: a real shelf, not an allocation');
  assert.deepEqual(E.allocationOf(cascade('c', 4, 40, 3).stock, now), { level: 7, refills: 4 }, 'out 40 h before each refill');
  assert.equal(E.allocationOf(cascade('c', 4, 50, 3).stock, now), null, 'out 50 h before each refill: the warehouse is not topping it up');
  const stuck = cascade().stock.concat({ t: now - 60 * HOUR, variantId: 'c', before: 4, now: 0, src: 'shopify' }).filter((r) => r.t < now - 59 * HOUR).sort((a, b) => a.t - b.t);
  assert.equal(E.allocationOf(stuck, now), null, 'out 60 h now and not topped up');
});

test('an allocation item: status "Top-up from warehouse", out of Order today, refill-gap ₹ apart from the headline', () => {
  const r = H.enrich(E.report(cascade().stock, cascade().orders, S, { days: 30, now }));
  const p = r.products.find((x) => x.id === 'c');
  assert.equal(p.status, E.ALLOCATION_STATUS);
  assert.deepEqual(p.allocation, { level: 7, refills: 6 });
  assert.equal(p.orderQty, 0); assert.equal(p.orderValue, 0);
  assert.ok(!r.reorder.includes(p), 'not on the reorder list');
  assert.equal(r.totals.orderValueNow, 0); assert.equal(r.totals.orderToday, 0);
  assert.ok(p.lost > 0 && p.lostAllocation === p.lost && p.lostCounted === 0);
  assert.equal(r.totals.lost, 0); assert.equal(r.totals.lostAllocation, p.lost); assert.equal(r.totals.lostAllocationProducts, 1); assert.equal(r.totals.allocation, 1);
  assert.equal(r.totals.lostAll, r.totals.lost + r.totals.lostEstimate + r.totals.lostNotRestocked + r.totals.lostAllocation);
  assert.equal(r.daily.reduce((s, d) => s + d.lostAllocation, 0), p.lost, 'daily refill-gap ₹ adds up (±rounding)');
  assert.equal(p.why, 'Shopify shows a website allocation (~7 pcs, refilled from the warehouse). Warehouse stock isn’t in Shopify, so we can’t size a reorder: check the warehouse.');
  /* the setting turns it off: back to a normal reorder row, ₹ counted */
  const off = E.report(cascade().stock, cascade().orders, { ...S, allocationCheck: 0 }, { days: 30, now });
  const q = off.products.find((x) => x.id === 'c');
  assert.notEqual(q.status, E.ALLOCATION_STATUS); assert.ok(q.orderQty > 0); assert.equal(q.lostAllocation, 0); assert.equal(off.totals.lost, q.lost);
});

/* weekly sales as src/weeks.js saves them: 25 full weeks from Mon 1 Jun 2026 (IST) */
const ws = (by) => ({ ok: true, v: 1, weeks: 25, start: Date.UTC(2026, 5, 1) - 330 * 6e4, by });
/* out for the last 20 days; 3 sales in the 28 days before (low on units) */
function fewSales(id, created = Date.UTC(2025, 0, 1)) {
  const stock = [{ t: now - 59 * DAY, variantId: id, before: null, now: 3, price: 9000 }, { t: now - 20 * DAY, variantId: id, before: 1, now: 0, price: 9000 }];
  const orders = [now - 40 * DAY, now - 30 * DAY, now - 20 * DAY + 10 * 60e3].map((t, i) => ({ t, order: `#${id}${i}`, variantId: id, qty: 1, price: 9000 }));
  return { stock, orders, catalog: { [id]: { product: `P${id}`, stock: 0, active: true, createdAt: created, price: 9500 } } };
}

test('G26: confidence = share of the last 25 full weeks with a sale (High ≥ 44%, Medium ≥ 22%), "sold in N of 25 weeks"', () => {
  const cases = [['hi', 11, 'high'], ['md', 10, 'medium'], ['md2', 6, 'medium'], ['lo', 5, 'low']];
  const data = cases.map(([id]) => fewSales(id));
  const stock = data.flatMap((d) => d.stock), orders = data.flatMap((d) => d.orders), catalog = Object.assign({}, ...data.map((d) => d.catalog));
  const by = Object.fromEntries(cases.map(([id, s]) => [id, { s, u: s + 2, n: (s + 2) * 8500, l: '2026-11-16' }]));
  const r = H.enrich(E.report(stock, orders, S, { days: 30, now, catalog, weekSales: ws(by) }));
  for (const [id, s, want] of cases) {
    const p = r.products.find((x) => x.id === id);
    assert.ok(p.rateUnits < 5); assert.equal(p.confBasis, 'weeks'); assert.equal(p.weeksSold, s); assert.equal(p.weeksLive, 25);
    assert.equal(p.confidence, want, id);
    assert.equal(want === 'low' ? p.lostEstimate : p.lostCounted, p.lost, `${id}: the bucket follows the confidence`);
    assert.match(p.why, new RegExp(`sold in ${s} of 25 weeks$`));
  }
  /* without the weekly data: the units rule (3 units → low) */
  const b = E.report(stock, orders, S, { days: 30, now, catalog });
  assert.ok(b.products.every((p) => p.confidence === 'low' && p.confBasis === 'units' && p.weeksLive === null));
});

test('G26: a variant live under 8 full weeks keeps the units rule; weeks live from createdAt', () => {
  assert.equal(E.weeksLive(ws({}), Date.UTC(2020, 0, 1)), 25);
  assert.equal(E.weeksLive(ws({}), Date.UTC(2026, 9, 26)), 4, 'created on Mon 26 Oct: 4 full weeks to 22 Nov');
  assert.equal(E.weeksLive(ws({}), null), null);
  const d = fewSales('new', Date.UTC(2026, 9, 10));   // live 7 full weeks (12 Oct – 22 Nov)
  const r = E.report(d.stock, d.orders, S, { days: 30, now, catalog: d.catalog, weekSales: ws({ new: { s: 7, u: 9, n: 0 } }) });
  const p = r.products[0];
  assert.equal(p.confBasis, 'units'); assert.equal(p.confidence, 'low'); assert.equal(p.weeksLive, null);
});

test('§3 floor: out since before our data, sold in Shopify\'s 26 weeks → units ÷ 182 a day, all of it a guess (1.5.0)', () => {
  const stock = [{ t: now - 59 * DAY, variantId: 'f', before: null, now: 0, price: 7149 }];
  const catalog = { f: { product: 'Solis Gold Accent Table', stock: 0, active: true, createdAt: Date.UTC(2024, 0, 1), price: 7149 } };
  const other = [{ t: now - 59 * DAY, order: '#o', variantId: 'other', qty: 1, price: 100 }];   // the store's orders start 59 days ago
  const opts = { days: 30, now, catalog, weekSales: ws({ f: { s: 10, u: 19, n: 19 * 6500, l: '2026-08-10' } }) };
  const r = H.enrich(E.report(stock, other, S, opts));
  const p = r.products.find((x) => x.id === 'f');
  assert.equal(p.floorPerDay, Math.round((19 / 182) * 1000) / 1000); assert.equal(p.units26, 19);
  assert.equal(p.perDay, 0, 'the order quantity keeps its own rate');
  const hours = r.stockouts.find((s) => s.id === 'f').hoursInPeriod;
  assert.ok(Math.abs(p.lost - (19 / 182) * 6500 * hours / 24) < 0.05 * p.lost, `≈ floor × ₹6,500 (Shopify's net ÷ units) × days out: ${p.lost}`);
  assert.equal(p.lostEstimate, p.lost); assert.equal(p.lostCounted, 0); assert.equal(p.lostNotRestocked, 0);   // 1.5.0
  assert.ok(!r.stockouts.find((s) => s.id === 'f').notSelling, 'no longer "out but not selling"');
  assert.match(p.why, /^Out since before \d+ \w+ · sold 19 in 26 w$/);
  /* in stock part of the time we hold (sold 0 while in stock): no floor, it really isn't selling */
  const inStock = [{ t: now - 59 * DAY, variantId: 'f', before: null, now: 2, price: 7149 }, { t: now - 10 * DAY, variantId: 'f', before: 2, now: 0, price: 7149 }];
  const q = E.report(inStock, other, S, opts).products.find((x) => x.id === 'f');
  assert.equal(q.floorPerDay, undefined); assert.equal(q.lost, 0);
  /* no weekly data: as before, ₹0 and "out but not selling" */
  const z = E.report(stock, other, S, { days: 30, now, catalog });
  assert.equal(z.products.find((x) => x.id === 'f').lost, 0); assert.equal(z.stockouts.find((x) => x.id === 'f').notSelling, true);
});

test('L3: still out ₹/day counts the headline\'s part; estimates, not restocked and allocations apart (digest too)', () => {
  const d = fewSales('lo'), c = cascade();
  const r = H.enrich(E.report(d.stock.concat(c.stock), d.orders.concat(c.orders), S, { days: 30, now, catalog: d.catalog }));
  const lo = r.products.find((p) => p.id === 'lo');
  assert.equal(lo.confidence, 'low'); assert.ok(lo.costPerDay > 0);
  assert.equal(r.totals.stillOutPerDay, 0, 'nothing counted is out');
  assert.equal(r.totals.stillOutPerDayApart, lo.costPerDay);
  const text = DG.build({ report: r, role: 'founder', storeName: 'S', now }).text;
  assert.match(text, /a day on estimates and items not restocked, not counted/);
});

test('weeks.plan: 25 full Monday weeks before this week, windows of 9 weeks ending today, both ends included', () => {
  const p = W.plan(now, 'Asia/Kolkata');
  assert.equal(p.today, '2026-11-24'); assert.equal(p.monday, '2026-11-23'); assert.equal(p.first, '2026-06-01');
  assert.deepEqual(p.windows, [['2026-06-01', '2026-08-02'], ['2026-08-03', '2026-10-04'], ['2026-10-05', '2026-11-24']]);
  assert.equal(p.start, Date.UTC(2026, 5, 1) - 330 * 6e4);
  assert.deepEqual(W.split(['2026-06-01', '2026-08-02']), [['2026-06-01', '2026-06-28'], ['2026-06-29', '2026-08-02']]);
  assert.equal(W.split(['2026-06-01', '2026-06-07']), null);
  assert.match(W.qlFor('2026-06-01', '2026-08-02'), /^FROM sales SHOW net_items_sold, net_sales GROUP BY week, product_variant_id SINCE 2026-06-01 UNTIL 2026-08-02 ORDER BY week ASC LIMIT 1000$/);
});

test('weeks.summarise: weeks with net > 0 among full weeks, net units over the span (≥ 0), last week with a sale', () => {
  const p = W.plan(now, 'Asia/Kolkata');
  const { rows } = W.parse({ columns: [{ name: 'week' }, { name: 'product_variant_id' }, { name: 'net_items_sold' }, { name: 'net_sales' }],
    rows: [['2026-06-01', 'gid://shopify/ProductVariant/1', '2', '1000'], ['2026-06-08', '1', '-1', '-500'], ['2026-11-16', '1', '1', '600'], ['2026-11-23', '1', '3', '1800'], ['2026-06-01', '2', '-1', '-400'], ['bad', '3', '1', '1']] });
  const by = W.summarise(rows, p);
  assert.deepEqual(by['1'], { s: 2, u: 5, n: 2900, l: '2026-11-16' }, 'this week counts in units, not in weeks');
  assert.deepEqual(by['2'], { s: 0, u: 0, n: 0, l: null });
  assert.equal(by['3'], undefined);
});

test('weeks.fetch splits a capped window at a week boundary; run() saves, skips cleanly without read_reports, once a day', async () => {
  const p = W.plan(now, 'Asia/Kolkata'), seen = [];
  const q = async (doc, { q: ql }) => {
    seen.push(ql); assert.equal(doc, W.WEEKS_Q);
    const [, a] = ql.match(/SINCE (\S+) UNTIL (\S+)/);
    const n = a === '2026-06-01' && /UNTIL 2026-08-02/.test(ql) ? 3 : 1;   // the first 9-week window "hits the cap" (3 with cap 3)
    return { shopifyqlQuery: { tableData: { columns: [{ name: 'week' }, { name: 'product_variant_id' }, { name: 'net_items_sold' }, { name: 'net_sales' }], rows: Array.from({ length: n }, (_, i) => [a, String(10 + i), '1', '100']) }, parseErrors: [] } };
  };
  const got = await W.fetch(q, p, { cap: 3 });
  assert.equal(got.calls, 5, '3 windows + the split of the first into 2');
  assert.ok(seen.includes(W.qlFor('2026-06-01', '2026-06-28')) && seen.includes(W.qlFor('2026-06-29', '2026-08-02')));
  /* run(): in a temp store */
  const os = require('os'), fs = require('fs'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-weeks-'));
  const scope = require('../src/scope'); scope.useDir(dir);
  const store = require('../src/store'); store._forget();
  const ok = await W.run({ q, now });
  assert.equal(ok.ok, true); assert.equal(store.load().shopify.weekSales.ok, true); assert.ok(ok.by['10']);
  assert.equal(W.due(store.load().shopify, now + HOUR, 'Asia/Kolkata'), false, 'read today: not again');
  assert.equal(W.due(store.load().shopify, now + DAY, 'Asia/Kolkata'), true, 'tomorrow: again');
  const denied = async () => { throw new Error('The token lacks a read permission (needs read_products, read_inventory, read_orders)'); };
  const kept = await W.run({ q: denied, now: now + DAY });
  assert.equal(kept.ok, true, 'a failed read keeps the last good one'); assert.match(kept.note, /needs read_reports/);
  assert.equal(W.due(store.load().shopify, now + DAY + HOUR, 'Asia/Kolkata'), false, 'tried today: not again');
  assert.ok(W.forReport(store.load().shopify));
  store.load().shopify.weekSales = null;
  const none = await W.run({ q: denied, now: now + 2 * DAY });
  assert.equal(none.ok, false); assert.equal(W.forReport(store.load().shopify), null);
  store._forget(); fs.rmSync(dir, { recursive: true, force: true });
});
