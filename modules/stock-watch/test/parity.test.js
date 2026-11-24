'use strict';
/*
 * Parity: the Google Sheet (modules/stock-watch-sheets/StockWatch.gs) and the web app (src/engine.js)
 * must give the same answer on the same data. Each fixture runs through SW.compute() (the .gs loaded in
 * a vm, no Apps Script) and engine.report(). Same status and order qty on every reorder row; ₹ lost
 * within 2%. Intended differences are listed in ALLOW with the reason; anything else fails.
 *
 * Fixtures put every stock change on a whole day before "now", so a stock-out lasts whole days and the
 * web app's hour-of-day weighting (LOGIC.md §4a, not in the Sheet) adds up to the same as flat hours.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const E = require('../src/engine');

const GS = path.join(__dirname, '..', '..', 'stock-watch-sheets', 'StockWatch.gs');
function loadSheet() {
  const ctx = { module: { exports: {} } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(GS, 'utf8'), ctx, { filename: 'StockWatch.gs' });
  return ctx.module.exports.SW;
}
const SW = loadSheet();

const D = E.DAY, H = E.HOUR;
const NOW = Date.parse('2026-11-19T12:00:00Z');
const OFF = 330;
const CFG = { lead: 7, cover: 30, safety: 3, window: 28, smallTopUp: 7, minRate: 0.2 };
const SETTINGS = { leadDays: 7, coverDays: 30, safetyDays: 3, demandWindowDays: 28, smallTopUpDays: 7, minPerDay: 0.2, tzOffsetMin: OFF };

/**
 * One product. stock: [[daysAgo, before, now], ...]. Sales: `perDay` units on every whole day from
 * `sellFrom` days ago up to now that the product was in stock (every `every` days for slow sellers).
 */
function product({ id, price, perDay = 0, every = 1, sellFrom = 0, stock }) {
  const ch = stock.map(([d, before, now]) => ({ t: NOW - d * D, before, now }));
  const out = E.episodes(ch, NOW);
  const isOut = (a, b) => out.some((e) => e.start < b && e.end > a);
  const orders = [];
  for (let d = sellFrom; d >= 1; d--) {
    if (d % every) continue;
    const a = NOW - d * D, b = a + D;
    if (isOut(a, b)) continue;
    for (let i = 0; i < perDay; i++) orders.push({ t: a + ((i + 0.5) * 24 / perDay) * H, order: `#${id}-${d}-${i}`, variantId: String(id), sku: `SKU${id}`, qty: 1, price });
  }
  const rows = ch.map((c) => ({ t: c.t, variantId: String(id), sku: `SKU${id}`, product: `Product ${id}`, variant: 'Default Title', before: c.before, now: c.now, price }));
  return { stock: rows, orders };
}

const FIXTURES = [
  { name: 'steady seller, Order now', products: [
    product({ id: 1, price: 500, perDay: 2, sellFrom: 45, stock: [[45, 0, 300], [1, 30, 18]] }),
  ] },
  { name: 'closed stock-out inside the window', products: [
    product({ id: 2, price: 1200, perDay: 3, sellFrom: 45, stock: [[45, 0, 200], [20, 5, 0], [15, 0, 60], [2, 20, 12]] }),
  ] },
  { name: 'stock-out began before the 30 days (the old 2× Sheet bug)', products: [
    product({ id: 3, price: 1000, perDay: 5, sellFrom: 60, stock: [[60, 0, 100], [50, 1, 0], [10, 0, 60], [1, 20, 15]] }),
  ], check: (web) => assert.ok(Math.abs(web.reorder.find((x) => x.id === '3').lost - 100000) < 1000, 'web: 20 days × 5 × ₹1,000') },
  { name: 'still out now', products: [
    product({ id: 4, price: 800, perDay: 4, sellFrom: 40, stock: [[40, 0, 150], [5, 2, 0]] }),
  ] },
  { name: 'slow seller, a big OK seller, and a pricey best seller below the slow cutoff', products: [
    product({ id: 5, price: 300, perDay: 1, every: 10, sellFrom: 40, stock: [[40, 0, 3], [3, 1, 0]] }),
    product({ id: 6, price: 2000, perDay: 10, sellFrom: 40, stock: [[40, 0, 5000]] }),
    product({ id: 9, price: 90000, perDay: 1, every: 8, sellFrom: 40, stock: [[40, 0, 1]] }),
  ] },
  { name: 'new launch with a small top-up and a repeat stock-out', products: [
    product({ id: 7, price: 650, perDay: 3, sellFrom: 10, stock: [[10, 0, 20], [4, 1, 0], [3, 0, 5], [1, 1, 0]] }),
    product({ id: 8, price: 200, perDay: 1, sellFrom: 40, stock: [[40, 0, 900]] }),
  ] },
  /* SW-003 / X1: a long stock-out keeps its demand in both (the Sheet used to show ₹0 lost and drop it from Reorder) */
  { name: 'best seller out for the last 30 days (SW-003 example)', products: [
    product({ id: 10, price: 1000, perDay: 5, sellFrom: 90, stock: [[90, 0, 1000], [30, 1, 0]] }),
  ], check: (web, sheet) => {
    const w = web.reorder.find((x) => x.id === '10'), sh = sheet.reorder.find((x) => x.id === '10');
    assert.equal(w.status, 'Out now'); assert.equal(w.orderQty, 200); assert.equal(w.rateBasis, 'history');
    assert.ok(Math.abs(w.lost - 150000) < 1500, `web lost ${w.lost}`); assert.ok(near(sh.lost, 150000), `Sheet lost ${Math.round(sh.lost)}`);
  } },
  { name: 'only 3 in-stock days in the window', products: [
    product({ id: 11, price: 700, perDay: 4, sellFrom: 70, stock: [[70, 0, 600], [26, 5, 0], [1, 0, 40]] }),
  ], check: (web) => assert.equal(web.reorder.find((x) => x.id === '11').rateBasis, 'history') },
];

/** Intended differences (see modules/stock-watch-sheets/LOGIC.md). Each must still differ, or it's stale. */
const ALLOW = [
  { fixture: 'slow seller, a big OK seller, and a pricey best seller below the slow cutoff', id: '9',
    reason: 'The Sheet has no best sellers (ABC), so a ₹90,000 item selling 0.125/day is a slow seller there; the web app keeps best sellers on the reorder list (LOGIC.md §7).' },
];

const toSheet = (fx) => ({
  stock: fx.stock.map((r) => [r.t, r.variantId, r.sku, r.product, r.variant, r.before, r.now, r.price]),
  orders: fx.orders.map((o) => [o.t, o.order, o.variantId, o.sku, o.qty, o.price]),
});
const near = (a, b, pct = 2) => Math.abs(a - b) <= Math.max(1, (Math.abs(b) * pct) / 100);

for (const f of FIXTURES) {
  test(`parity: ${f.name}`, () => {
    const stock = f.products.flatMap((p) => p.stock), orders = f.products.flatMap((p) => p.orders);
    const web = E.report(stock, orders, SETTINGS, { now: NOW, days: 30 });
    const s = toSheet({ stock, orders });
    const sheet = SW.compute(s.stock, s.orders, CFG, NOW, (t) => E.dayKey(t, OFF));
    const W = new Map(web.reorder.map((x) => [String(x.id), x]));
    const S = new Map(sheet.reorder.map((x) => [String(x.id), x]));
    for (const id of new Set([...W.keys(), ...S.keys(), ...ALLOW.filter((a) => a.fixture === f.name).map((a) => a.id)])) {
      const w = W.get(id), sh = S.get(id);
      const allow = ALLOW.find((a) => a.fixture === f.name && a.id === id);
      const same = !!w && !!sh && w.status === sh.status && w.orderQty === sh.qty && near(sh.lost, w.lost);
      if (allow) { assert.ok(!same, `allowlist entry for ${id} is stale (both now agree): remove it`); continue; }
      assert.ok(w && sh, `${id}: on the web app's reorder list: ${!!w}, on the Sheet's: ${!!sh}`);
      assert.equal(sh.status, w.status, `${id}: status`);
      assert.equal(sh.qty, w.orderQty, `${id}: order qty`);
      assert.ok(near(sh.lost, w.lost), `${id}: ₹ lost Sheet ${Math.round(sh.lost)} vs web ${w.lost}`);
    }
    assert.ok(W.size + S.size > 0 || f.name.startsWith('slow'), 'fixture should put something on a reorder list');
    /* Daily tab totals = Overview totals */
    assert.equal(Math.round(sheet.totals.sold), web.totals.sold, 'sold in the last 30 days');
    /* the Sheet has no confidence split (LOGIC.md §12, §4c): it matches the web app's lostAll */
    assert.ok(near(sheet.totals.lost, web.totals.lostAll), `₹ lost in the last 30 days: Sheet ${Math.round(sheet.totals.lost)} vs web ${web.totals.lostAll}`);
    if (f.check) f.check(web, sheet);
  });
}

test('parity: the Sheet clips a stock-out to the last 30 days (was counted in full)', () => {
  const p = product({ id: 3, price: 1000, perDay: 5, sellFrom: 60, stock: [[60, 0, 100], [50, 1, 0], [10, 0, 60], [1, 20, 15]] });
  const s = toSheet(p);
  const r = SW.compute(s.stock, s.orders, CFG, NOW, (t) => E.dayKey(t, OFF));
  const ep = r.lost.find((e) => e.id === '3');
  assert.equal(Math.round(ep.hours), 40 * 24, 'Hours out shows the whole stock-out');
  assert.ok(near(ep.lost, 100000), `₹ lost counts 20 of its 40 days: ${Math.round(ep.lost)}`);
});
