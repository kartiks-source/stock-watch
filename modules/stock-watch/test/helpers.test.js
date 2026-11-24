'use strict';
/* Sprint 2 · D-helpers: SW-024 why / order-by / still-out cost, SW-025 PO CSV, SW-026 Pause / Push, SW-032 Decide (LOGIC.md §15). */
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine');
const H = require('../src/helpers');

const D = E.DAY, HR = E.HOUR;
const S = { ...E.DEFAULT_SETTINGS, leadDays: 7, safetyDays: 3, tzOffsetMin: 330 };
const now = Date.parse('2026-11-19T06:30:00Z');   // Thu 19 Nov, 12:00 in India

test('money: short ₹ for sentences', () => {
  assert.equal(H.money(950), '₹950');
  assert.equal(H.money(18700), '₹18.7k');
  assert.equal(H.money(18000), '₹18k');
  assert.equal(H.money(325000), '₹3.25 L');
  assert.equal(H.money(12000000), '₹1.20 Cr');
});

test('dates are in store time', () => {
  const late = Date.parse('2026-11-19T20:00:00Z');   // 01:30 on Fri 20 Nov in India
  assert.equal(H.dayName(late, 330), 'Fri 20 Nov');
  assert.equal(H.dayName(late, 0), 'Thu 19 Nov');
  assert.equal(H.fileDate(late, 330), '2026-11-20');
});

test('SW-024 why: out of stock → how long and ₹ lost; cost per day', () => {
  const p = { stock: 0, perDay: 5, price: 1000, lost: 99999, daysLeft: null, status: 'Out now' };
  const w = H.why(p, S, now, now - 3 * D, 18700);
  assert.equal(w.why, 'Out 3 d · lost ₹18.7k this stock-out', '₹ named so it is not read as the Sales lost column');
  assert.equal(w.costPerDay, 5000);
  assert.equal(w.outSince, now - 3 * D);
  assert.equal(H.why(p, S, now, now - 5 * HR, 0).why, 'Out 5 h');
  assert.equal(H.why(p, S, now, now - 23.6 * HR, 0).why, 'Out 1 d', '23.6 h rounds to a day, never "24 h"');
  assert.equal(H.why(p, S, now, null, null).why, 'Out', 'no open episode: no ₹ (the Sales lost column already has the period’s)');
});

test('SW-024 why: runs out, order by (lead + buffer before), supplier lead', () => {
  /* 15 days left, lead 7 + buffer 3 → order by 5 days from now */
  const w = H.why({ stock: 30, perDay: 2, daysLeft: 15, status: 'Order this week' }, S, now);
  assert.equal(w.runsOut, now + 15 * D);
  assert.equal(w.orderBy, now + 5 * D);
  assert.equal(w.why, 'Runs out Fri 4 Dec · order by Tue 24 Nov · supplier takes 7 d (assumed)');
  /* Order now: fewer days left than lead + buffer → order by today */
  const n = H.why({ stock: 16, perDay: 2, daysLeft: 8, status: 'Order now' }, S, now);
  assert.equal(n.orderBy, now);
  assert.equal(n.why, 'Runs out Fri 27 Nov · order by today · supplier takes 7 d (assumed)');
  assert.match(H.why({ stock: 1, perDay: 4, daysLeft: 0.25, status: 'Critical' }, S, now).why, /^Runs out today · order by today/);
  assert.equal(H.why({ stock: 5, perDay: 0, daysLeft: null, status: 'Slow seller' }, S, now).why, 'No sales lately');
  /* date follows the status: a This week row right at the line (10.0 days, lead + buffer 10) is never "order by today" */
  const edge = H.why({ stock: 20, perDay: 2, daysLeft: 10, status: 'Order this week' }, S, now);
  assert.equal(edge.why, 'Runs out Sun 29 Nov · order by Fri 20 Nov · supplier takes 7 d (assumed)');
  assert.equal(edge.orderBy, Date.parse('2026-11-19T18:30:00Z'), 'midnight starting the next store day');
  const late = Date.parse('2026-11-19T18:00:00Z');   // 23:30 in India: runs-out − 10 d is still "today" in store time
  assert.match(H.why({ stock: 21, perDay: 2, daysLeft: 10.4, status: 'Order this week' }, S, late).why, /order by Fri 20 Nov/);
  /* Critical with a short lead time: still "order by today" (it is on Order today) */
  assert.match(H.why({ stock: 6, perDay: 2, daysLeft: 3, status: 'Critical' }, { ...S, leadDays: 1, safetyDays: 0 }, now).why, /order by today/);
  assert.equal(H.why({ stock: null, status: 'No stock data' }, S, now).why, 'No stock data');
  assert.equal(H.why({ stock: 9, status: 'Ordered', onOrder: { eta: now + 6 * D } }, S, now).why, 'Ordered · lands 25 Nov');
});

/* a small store through the real engine: A out for 2 days, B runs low, C overstocked, Z slow and out, Y slow with stock */
function store() {
  const t0 = now - 40 * D, stock = [], orders = [];
  const add = (id, t, before, after, price, cost) => stock.push({ t, variantId: id, sku: `SKU-${id}`, product: `P${id}`, variant: '', before, now: after, price, cost });
  add('A', t0, null, 400, 1000, 400); add('B', t0, null, 400, 500, 200); add('C', t0, null, 2000, 300, 100); add('Z', t0, null, 1, 800, 300); add('Y', t0, null, 40, 600, 250);
  let n = 0;
  for (let d = 30; d >= 1; d--) {
    const t = now - d * D;
    orders.push({ t, order: `#${++n}`, variantId: 'B', sku: 'SKU-B', qty: 10, price: 500 });
    orders.push({ t, order: `#${++n}`, variantId: 'C', sku: 'SKU-C', qty: 1, price: 300 });
    if (d > 2) orders.push({ t, order: `#${++n}`, variantId: 'A', sku: 'SKU-A', qty: 5, price: 1000 });
  }
  orders.push({ t: now - 20 * D, order: `#${++n}`, variantId: 'Z', sku: 'SKU-Z', qty: 1, price: 800 });
  orders.push({ t: now - 25 * D, order: `#${++n}`, variantId: 'Y', sku: 'SKU-Y', qty: 1, price: 600 });
  add('A', now - 2 * D, 5, 0, 1000, 400);
  add('B', now - 1 * D, 100, 60, 500, 200);
  add('Z', now - 20 * D, 1, 0, 800, 300);   // 1 sold in 8 in-stock days = 0.125/day < 0.2: slow
  return { stock, orders };
}
const rep = (decisions) => H.enrich(E.report(store().stock, store().orders, S, { now, days: 30 }), { decisions });
const row = (r, id) => r.products.find((p) => p.id === id);

test('SW-024 enrich: why on every row; still-out cost per day = Σ sales/day × price of what is out', () => {
  const r = rep();
  const a = row(r, 'A'), b = row(r, 'B');
  assert.match(a.why, /^Out 2 d · lost ₹/);
  const open = r.stockouts.find((s) => s.id === 'A' && s.open);
  assert.equal(a.why, `Out 2 d · lost ${H.money(open.lost)} this stock-out`);
  assert.match(b.why, /^Runs out .* · order by today · supplier takes 7 d \(assumed\)$/);   // 1.3.0: no supplier lead set
  /* L3 (1.3.0): the counted part (High / Medium, not 30+ d not restocked); the rest apart, both add up to every out row */
  const out = r.products.filter((p) => p.stock <= 0), sure = out.filter((p) => ['high', 'medium'].includes(p.confidence) && !p.notRestocked);
  assert.equal(r.totals.stillOutPerDay, sure.reduce((s, p) => s + Math.round(p.perDay * p.price), 0));
  assert.equal(r.totals.stillOutPerDay + r.totals.stillOutPerDayApart, out.reduce((s, p) => s + Math.round(p.perDay * p.price), 0));
  assert.ok(out.some((p) => !sure.includes(p) && p.perDay > 0), 'the fixture has an out row left out (Z: 1 sale, low)');
  assert.ok(r.totals.stillOutPerDay >= Math.round(a.perDay * 1000));
  assert.ok(r.reorder.every((p) => typeof p.why === 'string' && p.why));
});

test('SW-026 Pause / Push lists', () => {
  const r = rep();
  assert.equal(row(r, 'A').mkt, 'pause', 'out now');
  assert.equal(row(r, 'B').mkt, 'pause', '6 days left < 7-day lead time');
  assert.equal(row(r, 'C').mkt, 'push', 'overstocked');
  assert.equal(row(r, 'Z').mkt, 'pause', 'slow but out: still pause promotion');
  assert.equal(H.mktList({ stock: 0, status: 'Inactive' }, S), null);
  assert.equal(H.mktList({ stock: 50, daysLeft: 7, status: 'Order now' }, S), null, 'exactly the lead time is not "less than"');
  assert.equal(r.totals.pause, 3);
  assert.equal(r.totals.pauseSlow, 1);
  assert.equal(r.totals.pauseReorder, r.products.filter((p) => p.mkt === 'pause' && p.orderQty > 0).length);
  assert.equal(row(r, 'Y').mkt, 'push', 'slow seller sitting on stock');
  assert.equal(r.totals.push, 2);
  assert.equal(r.totals.pushValue, row(r, 'C').excessValue + row(r, 'Y').excessValue);
  assert.match(row(r, 'A').backIn, /^Not ordered · earliest 26 Nov$/);
  assert.equal(H.backIn({ onOrder: { eta: now + 4 * D } }, S, now), 'Lands 23 Nov');
  assert.equal(H.backIn({ onOrder: { eta: now - D, late: true } }, S, now), 'Late · was due 18 Nov');
  assert.equal(row(r, 'Z').backIn, 'Slow seller · not reordered', 'slow sellers are off the reorder list: no "earliest" date');
  assert.match(H.backIn({ status: 'Slow seller', orderQty: 4 }, S, now), /^Not ordered · earliest/, 'a slow best seller that gets an order quantity keeps the date');
  /* order: out now first, then fewest days left; push by ₹ stuck */
  const sorted = H.mktSort([{ id: 1, stock: 5, daysLeft: 4, perDay: 1, price: 1 }, { id: 2, stock: 0, daysLeft: null, perDay: 1, price: 1 }, { id: 3, stock: 5, daysLeft: 2, perDay: 1, price: 1 }], 'pause');
  assert.deepEqual(sorted.map((p) => p.id), [2, 3, 1]);
  assert.deepEqual(H.mktSort([{ id: 1, excessValue: 5 }, { id: 2, excessValue: 9 }], 'push').map((p) => p.id), [2, 1]);
});

test('SW-032 Decide: slow + out → don’t reorder (₹ lost); slow + stock → clear (₹ at cost)', () => {
  const r = rep();
  const z = r.decide.find((x) => x.id === 'Z'), y = r.decide.find((x) => x.id === 'Y');
  assert.equal(row(r, 'Z').status, 'Slow seller');
  assert.deepEqual(z, { id: 'Z', kind: 'drop', value: row(r, 'Z').lost, decision: null });
  assert.deepEqual(y, { id: 'Y', kind: 'clear', value: 40 * 250, decision: null });
  assert.equal(r.decide.some((x) => ['A', 'B', 'C'].includes(x.id)), false, 'only slow sellers');
  assert.equal(H.decideKind({ status: 'Slow seller', stock: 3, cost: null, price: 100 }).value, 300, 'no cost → price');
});

test('SW-032 Decide: a decision hides the item until sales change by more than half', () => {
  const y = row(rep(), 'Y');
  const hidden = rep({ Y: { d: 'clear', base: y.perDay, at: now } });
  assert.equal(hidden.decide.some((x) => x.id === 'Y'), false);
  assert.deepEqual(hidden.decided.map((x) => [x.id, x.decision]), [['Y', 'clear']]);
  assert.equal(hidden.totals.decided, 1);
  const back = rep({ Y: { d: 'clear', base: y.perDay * 3, at: now } });
  assert.equal(back.decide.find((x) => x.id === 'Y').decision, 'clear', 'sales moved > 50%: back on the list, decision shown');
  assert.equal(rep({ Y: { d: 'nonsense', base: y.perDay } }).decide.some((x) => x.id === 'Y'), true, 'unknown decision ignored');
  /* trial values on: the hide check uses the saved settings' rates passed in, not the trial report's */
  const r3 = H.enrich(E.report(store().stock, store().orders, S, { now, days: 30 }), { decisions: { Y: { d: 'clear', base: y.perDay, at: now } }, rates: new Map([['Y', y.perDay * 3]]) });
  assert.equal(r3.decide.some((x) => x.id === 'Y'), true, 'rates map wins over the report row');
  const r4 = H.enrich(E.report(store().stock, store().orders, S, { now, days: 30 }), { decisions: { Y: { d: 'clear', base: y.perDay * 3, at: now } }, rates: new Map([['Y', y.perDay * 3]]) });
  assert.equal(r4.decide.some((x) => x.id === 'Y'), false);
  /* the rule itself: > 50% of the base, with a 0.1/day floor */
  assert.equal(H.salesChanged(1, 1.5), false);
  assert.equal(H.salesChanged(1, 1.51), true);
  assert.equal(H.salesChanged(1, 0.49), true);
  assert.equal(H.salesChanged(0, 0.05), false, 'one stray sale on a zero-sales item does not bring it back');
  assert.equal(H.salesChanged(0, 0.06), true);
});

test('SW-025 PO CSV: tab filter + search, UI status labels, vendor, unit cost, variant ID, grouped by vendor', () => {
  const r = rep();
  const vendors = { A: 'Zeta Brass', B: 'Acme Crafts' };
  const all = H.poLines(r, { filter: 'all', vendors });
  assert.deepEqual(all[0], H.PO_HEAD);
  const col = (k) => H.PO_HEAD.indexOf(k);
  assert.deepEqual(all.slice(1).map((l) => l[col('Variant ID')]), ['B', 'A'], 'Acme before Zeta');
  const a = all.find((l) => l[col('Variant ID')] === 'A');
  assert.equal(a[col('Vendor')], 'Zeta Brass');
  assert.equal(a[col('Unit cost')], 400);
  assert.equal(a[col('Status')], 'Order today');
  assert.equal(a[col('SKU')], 'SKU-A');
  assert.equal(a[col('Order qty')], row(r, 'A').orderQty);
  assert.equal(a[col('Order value')], row(r, 'A').orderQty * 400);
  assert.match(a[col('Why')], /^Out 2 d/);
  const b = all.find((l) => l[col('Variant ID')] === 'B');
  assert.equal(b[col('Order by')], '2026-11-19');
  assert.deepEqual(H.poLines(r, { filter: 'all', q: 'sku-a', vendors }).slice(1).map((l) => l[col('Variant ID')]), ['A'], 'search on SKU');
  assert.equal(H.poLines(r, { filter: 'week', vendors }).length, 1 + r.reorder.filter((p) => p.status === 'Order this week').length);
  assert.equal(H.poLines(r, { filter: 'today' }).length, 1 + r.reorder.filter((p) => ['Out now', 'Critical', 'Order now'].includes(p.status)).length);
  assert.equal(H.poLines(r, { filter: 'bogus' }).length, 1 + r.reorder.length, 'unknown filter = all');
  const noCost = H.poLines({ ...r, reorder: [{ ...row(r, 'A'), cost: null }] }, {})[1];
  assert.equal(noCost[col('Unit cost')], '', 'unit cost blank when unknown');
  assert.equal(H.statusLabel('Order this week'), 'This week');
  assert.equal(H.statusLabel('Critical'), 'Order today');
});

test('SW-025 vendor map: newest stock row wins, catalog overrides', () => {
  const m = H.vendorMap([{ t: 2, variantId: 'A', vendor: 'New' }, { t: 1, variantId: 'A', vendor: 'Old' }, { t: 1, variantId: 'B' }]);
  assert.deepEqual({ ...m }, { A: 'New' });   // a null-prototype map (critic r2 S1)
  assert.deepEqual({ ...H.vendorMap([], { A: { vendor: 'Cat' }, B: {} }) }, { A: 'Cat' });
});

test('SW-025 CSV cells: formula guard on text, numbers untouched, BOM', () => {
  assert.equal(H.csvCell('=1+1'), `"'=1+1"`);
  assert.equal(H.csvCell('-cmd'), `"'-cmd"`);
  assert.equal(H.csvCell(-5), '"-5"');
  assert.equal(H.csvCell('He said "hi"'), '"He said ""hi"""');
  assert.equal(H.csvText([['a', 1]]), '﻿"a","1"');
});

test('why: out at the first stock record → "Out since before <date>" (SIMP-6), not "Out 60 d"', () => {
  const now = Date.UTC(2026, 10, 20, 12), first = Date.UTC(2026, 8, 21, 12);
  const p = { stock: 0, perDay: 0.3, price: 3000, status: 'Out now', historyFrom: first };
  assert.equal(H.why(p, { leadDays: 7, safetyDays: 3 }, now, first).why, 'Out since before 21 Sep');
  assert.match(H.why(p, { leadDays: 7, safetyDays: 3 }, now, first + 86400e3).why, /^Out 59 d/);
});
