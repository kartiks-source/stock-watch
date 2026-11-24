'use strict';
/* 1.2.0 (LOGIC.md §4c): how sure ₹ lost is. Confidence from the units behind the rate (high 10+, medium 5–9, low ≤ 4);
 * a stock-out open 30+ days with nothing marked ordered: its ₹ after day 30 is "not restocked"; a PO keeps it counting.
 * The headline (totals.lost) = high + medium without that part, the same on every screen and in every export. */
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine');
const H = require('../src/helpers');
const V1 = require('../src/apiv1');
const DG = require('../src/digest');
const W = require('../src/weekly');
const TZ = require('../src/tz');

const DAY = E.DAY;
const NOW = Date.parse('2026-11-24T06:30:00Z');   // 12:00 IST
const S = { timeZone: 'Asia/Kolkata', tzOffsetMin: 330 };

/** One product: in stock with `start` pcs from `from` days ago; out at `outAt` days ago (null = never), back at `backAt`
 *  days ago (null = still out); `sales` = days-ago of each 1-unit sale. */
function product(id, { from = 100, start = 500, outAt = null, backAt = null, sales = [], price = 1000 }) {
  const stock = [{ t: NOW - from * DAY, variantId: id, sku: id, product: `P ${id}`, variant: '', before: 0, now: start, price }];
  if (outAt != null) stock.push({ t: NOW - outAt * DAY, variantId: id, sku: id, product: `P ${id}`, variant: '', before: 1, now: 0, price });
  if (backAt != null) stock.push({ t: NOW - backAt * DAY, variantId: id, sku: id, product: `P ${id}`, variant: '', before: 0, now: 40, price });
  const orders = sales.map((d, i) => ({ t: NOW - d * DAY, order: `${id}-${i}`, variantId: id, sku: id, qty: 1, price }));
  return { stock, orders };
}
const merge = (...ps) => ({ stock: ps.flatMap((p) => p.stock), orders: ps.flatMap((p) => p.orders) });
const range = (a, b, step = 1) => { const out = []; for (let d = a; d >= b; d -= step) out.push(d + 0.3); return out; };
const run = (data, opts = {}) => E.report(data.stock, data.orders, S, { days: 30, now: NOW, ...opts });
const row = (r, id) => r.products.find((p) => p.id === id);

test('confidence thresholds: high ≥ 10, medium 5–9, low ≤ 4 units behind the rate', () => {
  assert.deepEqual([0, 1, 4, 5, 9, 10, 50].map(E.confidenceOf), ['low', 'low', 'low', 'medium', 'medium', 'high', 'high']);
  assert.equal(E.CONF_HIGH, 10); assert.equal(E.CONF_MEDIUM, 5); assert.equal(E.NOT_RESTOCKED_DAYS, 30);
  /* in stock the whole window, out for the last 3 days: k sales in the window → rateUnits k */
  for (const [k, want] of [[4, 'low'], [5, 'medium'], [9, 'medium'], [10, 'high']]) {
    const p = product('k', { outAt: 3, sales: [90, ...Array.from({ length: k }, (_, i) => 5 + i * 2)] });
    const x = row(run(p), 'k');
    assert.equal(x.rateUnits, k, `rateUnits for ${k}`);
    assert.equal(x.confidence, want, `${k} units`);
    assert.ok(x.lost > 0);
    if (want === 'low') { assert.equal(x.lostEstimate, x.lost); assert.equal(x.lostCounted, 0); assert.equal(x.lostConfidence, 'low'); }
    else { assert.equal(x.lostCounted, x.lost); assert.equal(x.lostEstimate, 0); }
    assert.equal(x.lostNotRestocked, 0, 'out 3 days: nothing not restocked');
  }
});

test('rateUnits = the units the rate was measured on (history basis for a long stock-out), not units sold in the period', () => {
  const p = product('h', { outAt: 45, sales: range(99, 46) });   // 1 a day until out 45 days ago, 0 sold in the period
  const x = row(run(p), 'h');
  assert.equal(x.rateBasis, 'history'); assert.equal(x.unitsSold, 0);
  assert.ok(x.rateUnits >= 27 && x.rateUnits <= 29, `rateUnits ${x.rateUnits}`); assert.equal(x.confidence, 'high');
});

test('open 30+ days with nothing ordered: ₹ after day 30 is "not restocked"; the rest counts; Why says restock or drop', () => {
  const p = product('n', { outAt: 45, sales: range(99, 46) });
  const r = run(p), x = row(r, 'n');
  /* period = last 30 days, all out; day 30 of the stock-out = 15 days ago → about half after it */
  assert.ok(x.lostNotRestocked > 0.4 * x.lost && x.lostNotRestocked < 0.6 * x.lost, `${x.lostNotRestocked} of ${x.lost}`);
  assert.equal(x.lostCounted, x.lost - x.lostNotRestocked);
  assert.equal(x.notRestocked, true);
  assert.equal(r.totals.lostNotRestocked, x.lostNotRestocked); assert.equal(r.totals.lost, x.lostCounted); assert.equal(r.totals.lostAll, x.lost);
  assert.equal(r.totals.lostNotRestockedProducts, 1);
  const so = r.stockouts.find((s) => s.id === 'n');
  assert.equal(so.lostNotRestocked, x.lostNotRestocked); assert.equal(so.lostOver30, x.lostNotRestocked); assert.equal(so.confidence, 'high');
  H.enrich(r);
  assert.equal(x.why, 'Out 30+ days, not restocked: restock or drop?');
  /* daily: the counted part only in `lost`, the rest per day apart */
  const sum = (k) => r.daily.reduce((s, d) => s + d[k], 0);
  assert.ok(Math.abs(sum('lost') - r.totals.lost) <= r.daily.length);
  assert.ok(Math.abs(sum('lostNotRestocked') - r.totals.lostNotRestocked) <= r.daily.length);
  /* a 7-day view of the same stock-out: all of it is past day 30 */
  const r7 = run(p, { days: 7 }), x7 = row(r7, 'n');
  assert.equal(x7.lostNotRestocked, x7.lost); assert.equal(r7.totals.lost, 0);
});

test('a PO marked (Mark ordered) keeps a 30+ day stock-out counting in full', () => {
  const p = product('n', { outAt: 45, sales: range(99, 46) });
  const without = row(run(p), 'n');
  const r = run(p, { onOrder: { n: { qty: 60, eta: NOW + 5 * DAY, at: NOW - 2 * DAY, by: 'test' } } }), x = row(r, 'n');
  assert.ok(x.onOrder);
  assert.equal(x.lost, without.lost, 'same ₹ lost');
  assert.equal(x.lostNotRestocked, 0); assert.equal(x.lostCounted, x.lost); assert.equal(r.totals.lost, x.lost);
  assert.ok(!x.notRestocked);
  /* a late PO still counts as someone restocking */
  const late = row(run(p, { onOrder: { n: { qty: 60, eta: NOW - 3 * DAY, at: NOW - 20 * DAY } } }), 'n');
  assert.equal(late.lostNotRestocked, 0);
});

test('a long stock-out that ended (refilled) counts in full', () => {
  const p = product('c', { outAt: 45, backAt: 2, sales: range(99, 46) });
  const x = row(run(p), 'c');
  assert.ok(x.lost > 0); assert.equal(x.lostNotRestocked, 0); assert.equal(x.lostCounted, x.lost);
});

test('low confidence and not restocked together: the parts add up to lost, nothing counted twice', () => {
  const p = product('s', { outAt: 44, sales: [80, 70, 60] });   // Seville-type: 3 older sales, 0 in the period
  const x = row(run(p), 's');
  assert.equal(x.confidence, 'low');
  assert.ok(x.lostNotRestocked > 0 && x.lostEstimate > 0);
  assert.equal(x.lostCounted, 0);
  assert.equal(x.lostEstimate + x.lostNotRestocked + x.lostCounted, x.lost);
});

/* the store: one of each kind, so the headline differs from lostAll */
const STORE = merge(
  product('n', { outAt: 45, sales: range(99, 46) }),            // high, not restocked after day 30
  product('k', { outAt: 3, sales: [90, 5, 7, 9] }),             // low: estimate
  product('m', { outAt: 4, sales: [90, ...range(25, 6, 3)] }),  // medium: counted
  product('b', { outAt: 6, backAt: 2, sales: range(99, 7) }),   // high, refilled: counted
);

test('totals: headline = Σ counted; lostAll = Σ lost = headline + estimate + not restocked; % of demand on the headline', () => {
  const r = run(STORE), t = r.totals;
  const sum = (k) => r.products.reduce((s, p) => s + p[k], 0);
  assert.equal(t.lost, sum('lostCounted')); assert.equal(t.lostEstimate, sum('lostEstimate')); assert.equal(t.lostNotRestocked, sum('lostNotRestocked'));
  assert.equal(t.lostAll, sum('lost')); assert.equal(t.lostAll, t.lost + t.lostEstimate + t.lostNotRestocked);
  assert.ok(t.lostEstimate > 0 && t.lostNotRestocked > 0 && t.lost > 0);
  assert.equal(t.lostPct, Math.round((t.lost / (t.sold + t.lost)) * 1000) / 10);
});

test('the same headline in /api/v1/summary, the digest, the weekly snapshot, groups and the PO CSV', () => {
  const r = H.enrich(run(STORE)), t = r.totals;
  const v1 = V1.summary(r);
  assert.equal(v1.money.lost, t.lost); assert.equal(v1.money.lostEstimate, t.lostEstimate); assert.equal(v1.money.lostNotRestocked, t.lostNotRestocked); assert.equal(v1.money.lostAll, t.lostAll);
  assert.equal(v1.lostPct, t.lostPct);
  const d = DG.build({ report: r, role: 'ceo', storeName: 'S', now: NOW });
  assert.ok(d.text.includes(`last 30 days: ${DG.money(t.lost)} (`), d.text);
  assert.ok(d.text.includes(`+${DG.money(t.lostEstimate)} estimate`) && d.text.includes(`+${DG.money(t.lostNotRestocked)} not restocked`), d.text);
  assert.ok(d.lines.every((l) => l.length <= 160));
  /* weekly snapshot of yesterday (store day): lost = that day's report headline, not lostAll */
  const key = TZ.dayKey(NOW - DAY, 'Asia/Kolkata');
  const snap = W.compute({ settings: S, stock: STORE.stock, orders: STORE.orders, catalog: {} }, key, {});
  const t0 = TZ.fromLocal(Date.parse(`${key}T00:00:00Z`), 'Asia/Kolkata');
  const day = E.report(STORE.stock, STORE.orders, S, { now: t0 + DAY, from: t0 }).totals;
  assert.equal(snap.lost, day.lost); assert.notEqual(day.lost, day.lostAll, 'the fixture has a part apart that day');
  /* groups: a group's lost is the headline's part */
  const G = require('../src/groups');
  const g = G.build(r.products, { variants: {} }, 'type');
  assert.equal(g.total.lost, t.lost);
  /* PO CSV: the row's own ₹, its confidence and the not-restocked part */
  const lines = H.poLines(r, { filter: 'all' });
  const col = (k) => H.PO_HEAD.indexOf(k);
  assert.ok(col('Confidence') > 0 && col('Not restocked 30+ d (₹)') > 0);
  const n = lines.find((l) => l[3] === 'n');
  assert.ok(n, 'the out-of-stock best seller is on the reorder list');
  assert.equal(n[col('Confidence')], 'High'); assert.equal(n[col('Not restocked 30+ d (₹)')], row(r, 'n').lostNotRestocked);
});

test('CALC_VERSION moved, so saved weekly snapshots are worked out again under the new headline', () => {
  assert.equal(E.CALC_VERSION, '1.2.0');
});
