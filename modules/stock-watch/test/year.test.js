'use strict';
/* 1.4.0 (LOGIC §20): 12 months of daily sales and stock changes from ShopifyQL, read in pages under the 1,000-row cap
   with explicit dates (both ends included), a few reads per pull, refreshed with only new days. Fake ShopifyQL. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scope = require('../src/scope');
const Y = require('../src/year');

const NOW = Date.parse('2026-11-24T06:30:00Z');   // 12:00 IST, 24 Nov
const keyPlus = Y.keyPlus;

/** A fake shop: per day, `perDay` variants sell 1 at ₹100 and lose 1 'available'. Returns q(doc, vars) like shopify.gql. */
function fakeShop({ perDay = 3, cap = 1000, from = '2025-01-01', to = '2026-11-24', failOn = null, nullRow = true } = {}) {
  const calls = [];
  const q = async (doc, { q: ql }) => {
    assert.match(doc, /^query Year/);
    calls.push(ql);
    if (failOn && failOn.test(ql)) throw new Error('The token lacks a read permission (needs read_reports)');
    const m = ql.match(/SINCE (\d{4}-\d\d-\d\d) UNTIL (\d{4}-\d\d-\d\d)/);
    assert.ok(m, `explicit dates: ${ql}`);
    const [, a, b] = m; const rows = [];
    for (let k = a; k <= b; k = keyPlus(k, 1)) {   // both ends included, as Shopify does
      if (k < from || k > to) continue;
      for (let v = 1; v <= perDay; v++) {
        if (/FROM sales/.test(ql)) rows.push({ day: k, product_variant_id: String(100 + v), net_items_sold: '1', net_sales: '100.5' });
        else rows.push({ day: k, product_variant_id: String(100 + v), inventory_adjustment_change: '-1' });
      }
      if (nullRow && /FROM sales/.test(ql)) rows.push({ day: k, product_variant_id: null, net_items_sold: '0', net_sales: '-10' });
    }
    return { shopifyqlQuery: { tableData: { columns: [], rows: rows.slice(0, cap) }, parseErrors: [] } };
  };
  return { q, calls };
}

function useStore(catalog = { 101: { stock: 50, tracked: true, seenAt: NOW - 60e3 }, 102: { stock: 5, tracked: true, seenAt: NOW - 60e3 }, 103: { stock: 0, tracked: true, seenAt: NOW - 60e3 } }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-year-'));
  scope.useDir(dir);
  const store = require('../src/store');
  store._forget();
  const d = store.load(); d.catalog = catalog; store.save(true);
  require('../src/year').clear?.();
  return dir;
}

test('queries: explicit store-time dates, both ends included; sales and available stock changes by day and variant', () => {
  assert.equal(Y.QL.sales('2026-10-01', '2026-10-31'), 'FROM sales SHOW net_items_sold, net_sales GROUP BY day, product_variant_id SINCE 2026-10-01 UNTIL 2026-10-31 ORDER BY day ASC LIMIT 1000');
  assert.match(Y.QL.moves('2026-10-01', '2026-10-01'), /FROM inventory_adjustment_history SHOW inventory_adjustment_change WHERE inventory_state = 'available' GROUP BY day, product_variant_id SINCE 2026-10-01 UNTIL 2026-10-01/);
  assert.doesNotThrow(() => require('../src/shopify').assertReadOnly(Y.Q));
  assert.equal(Y.span('2026-10-01', '2026-10-31'), 31);
  assert.equal(Y.nextLen(30), 26); assert.equal(Y.nextLen(0.1), 62); assert.equal(Y.nextLen(5000), 1);
});

test('parse: string rows, null variant rows kept for the store total only, zero changes skipped', () => {
  const s = Y.parse({ columns: [{ name: 'day' }, { name: 'product_variant_id' }, { name: 'net_items_sold' }, { name: 'net_sales' }], rows: JSON.stringify([['2026-11-01', '7', '2', '300'], ['2026-11-01', null, '0', '0'], ['bad', '7', '1', '1']]) }, 'sales');
  assert.deepEqual(s.rows, [{ day: '2026-11-01', variantId: '7', units: 2, net: 300 }, { day: '2026-11-01', variantId: null, units: 0, net: 0 }]);
  assert.equal(s.count, 3);
  const m = Y.parse({ rows: [{ day: '2026-11-01', product_variant_id: 'gid://shopify/ProductVariant/7', inventory_adjustment_change: '-1' }, { day: '2026-11-01', product_variant_id: '8', inventory_adjustment_change: '0' }] }, 'moves');
  assert.deepEqual(m.rows, [{ day: '2026-11-01', variantId: '7', delta: -1 }]);
});

test('a first load reads 365 full days back in windows under the cap, every day exactly once, over several runs; then only new days', async () => {
  useStore();
  const f = fakeShop({ perDay: 30 });   // 31 rows a day with the null row: ~25 days a read
  let r = await Y.run({ q: f.q, now: NOW, maxCalls: 6 });
  assert.equal(r.calls.last, 6, 'the per-run budget holds');
  assert.equal(r.done, false);
  assert.ok(r.anchorAt, 'the anchor is set as soon as the newest days are read');
  for (let i = 0; i < 20 && !r.done; i++) r = await Y.run({ q: f.q, now: NOW, maxCalls: 6 });
  assert.equal(r.done, true);
  const y = Y.load();
  const start = keyPlus('2026-11-24', -(Y.DAYS - 1));   // 12 whole months + last year's same month, today included
  assert.equal(y.sales.from, start); assert.equal(y.moves.from, start);
  assert.equal(y.sales.to, '2026-11-23'); assert.equal(y.moves.to, '2026-11-23');
  /* every day once: 30 variants × 1 unit, ₹100.5 each, + a −₹10 row without a variant */
  for (let k = start; k <= '2026-11-24'; k = keyPlus(k, 1)) {
    assert.deepEqual(y.sales.all[k], [30, 3005], k);
    assert.deepEqual(y.sales.by['101'][k], [1, 100.5], k);
    assert.equal(y.moves.by['101'][k], -1, k);
  }
  assert.equal(y.sales.all[keyPlus(start, -1)], undefined, 'nothing before the span');
  /* no read ever asked for more than the cap */
  for (const ql of f.calls) { const [, a, b] = ql.match(/SINCE (\S+) UNTIL (\S+)/); assert.ok(Y.span(a, b) * 31 < 1000, ql); }
  assert.deepEqual(y.anchor.levels, { 101: 50, 102: 5, 103: 0 });
  assert.equal(y.anchor.day, '2026-11-24');
  /* next day: only the last day held and the new ones are read (one read per stream) */
  const before = f.calls.length;
  assert.equal(Y.due(Y.load(), NOW + 3600e3, 'Asia/Kolkata'), false, 'read today already');
  assert.equal(Y.due(Y.load(), NOW + 864e5, 'Asia/Kolkata'), true);
  r = await Y.run({ q: f.q, now: NOW + 864e5 });
  assert.equal(f.calls.length - before, 2);
  assert.match(f.calls[before], /SINCE 2026-11-23 UNTIL 2026-11-25/);
  assert.equal(Y.load().sales.from, keyPlus(start, 1), 'the oldest day drops off');
  assert.equal(Y.load().sales.to, '2026-11-24');
});

test('a window that comes back at the cap is read again in halves; a single capped day stops with a note', async () => {
  useStore();
  const f = fakeShop({ perDay: 120, nullRow: false });   // 120 rows a day: the first 6-day guess is capped
  const r = await Y.run({ q: f.q, now: NOW, maxCalls: 4, days: 20 });
  const caps = f.calls.filter((ql) => { const [, a, b] = ql.match(/SINCE (\S+) UNTIL (\S+)/); return Y.span(a, b) * 120 >= 1000; });
  assert.ok(caps.length >= 1, 'at least one capped read');
  const y = Y.load();
  for (const k of Object.keys(y.sales.all)) assert.equal(y.sales.all[k][0], 120, `${k}: a capped read is never stored`);
  assert.ok(r.calls.last <= 4);
  useStore();
  const g = fakeShop({ perDay: 1200, nullRow: false });
  const r2 = await Y.run({ q: g.q, now: NOW, maxCalls: 20, days: 3 });
  assert.match(r2.note, /more than 1000 sales rows on/);
});

test('without read_reports: skipped with a note, tried once a day, never throws', async () => {
  useStore();
  const f = fakeShop({ failOn: /./ });
  const r = await Y.run({ q: f.q, now: NOW });
  assert.equal(r.ok, false); assert.match(r.note, /needs read_reports/);
  assert.equal(Y.due(Y.load(), NOW + 3600e3, 'Asia/Kolkata'), false);
  assert.equal(f.calls.length, 1);
});

test('the anchor is only taken from a fresh stock read; a stale catalog keeps the last anchor', async () => {
  useStore({ 101: { stock: 7, tracked: true, seenAt: NOW - 60 * 60e3 } });   // stock read an hour before
  const f = fakeShop({ perDay: 1 });
  const r = await Y.run({ q: f.q, now: NOW, maxCalls: 40, days: 30 });
  assert.equal(r.anchorAt, null, 'no anchor from stock an hour old');
  assert.equal(r.ok, false);
});

test('a failed refresh is tried again at the next pull (30 min on), a missing permission once a day', async () => {
  useStore();
  const ok = fakeShop({ perDay: 1 });
  await Y.run({ q: ok.q, now: NOW });
  assert.equal(Y.load().done, true);
  const bad = async () => { throw new Error('Shopify: HTTP 502'); };
  await Y.run({ q: bad, now: NOW + 864e5 });
  assert.equal(Y.due(Y.load(), NOW + 864e5 + 10 * 60e3, 'Asia/Kolkata'), false);
  assert.equal(Y.due(Y.load(), NOW + 864e5 + 31 * 60e3, 'Asia/Kolkata'), true);
});

test('the first load reads everything in one run (no budget of 8); later runs top up new days only', async () => {
  useStore();
  const f = fakeShop({ perDay: 30 });
  const r = await Y.run({ q: f.q, now: NOW });
  assert.equal(r.done, true, `one run: ${r.calls.last} reads`);
  assert.ok(r.calls.last <= 80);
  const n = f.calls.length;
  await Y.run({ q: f.q, now: NOW + 864e5 });
  assert.equal(f.calls.length - n, 2, 'next day: one read per stream');
});
