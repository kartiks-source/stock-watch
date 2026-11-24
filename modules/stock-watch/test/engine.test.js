'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine');
const R = require('../src/rows');

const H = E.HOUR, D = E.DAY;
const t0 = Date.parse('2026-11-01T00:00:00Z');

test('stock-out episodes: out, small refill, out again, proper restock', () => {
  const ch = [
    { t: t0, before: 100, now: 99 },
    { t: t0 + 10 * D, before: 1, now: 0 },
    { t: t0 + 11 * D, before: 0, now: 10 },
    { t: t0 + 12 * D, before: 1, now: 0 },
    { t: t0 + 14 * D, before: 0, now: 200 },
  ];
  const eps = E.episodes(ch, t0 + 20 * D);
  assert.equal(eps.length, 2);
  assert.deepEqual(eps.map((e) => [(e.end - e.start) / D, e.topUp, e.open]), [[1, 10, false], [2, 200, false]]);
});

test('an open stock-out runs to now', () => {
  const eps = E.episodes([{ t: t0, before: 3, now: 0 }], t0 + 5 * H);
  assert.equal(eps.length, 1); assert.equal(eps[0].open, true); assert.equal(eps[0].end - eps[0].start, 5 * H);
});

test('demand ignores time out of stock', () => {
  const eps = [{ start: t0 + 10 * D, end: t0 + 13 * D }];
  const { perDay } = E.demandPerDay(250, t0, t0 + 28 * D, eps);
  assert.equal(Math.round(perDay * 100) / 100, 10);           // 250 units over 25 in-stock days
});

test('reorder plan', () => {
  assert.equal(E.plan({ stock: 0, perDay: 10, lead: 7, cover: 30, safety: 3 }).status, 'Out now');
  assert.equal(E.plan({ stock: 20, perDay: 10, lead: 7, cover: 30, safety: 3 }).status, 'Critical');
  assert.equal(E.plan({ stock: 80, perDay: 10, lead: 7, cover: 30, safety: 3 }).status, 'Order now');
  assert.equal(E.plan({ stock: 150, perDay: 10, lead: 7, cover: 30, safety: 3 }).status, 'Order this week');
  assert.equal(E.plan({ stock: 500, perDay: 10, lead: 7, cover: 30, safety: 3 }).status, 'OK');
  assert.equal(E.plan({ stock: 80, perDay: 10, lead: 7, cover: 30, safety: 3 }).qty, 320);   // 10 × 40 − 80
});

test('selling hours follow the store’s hourly pattern and split by local day', () => {
  const flat = new Array(24).fill(1);
  const r = E.sellingHours(t0, t0 + 48 * H, flat, 330);
  assert.equal(Math.round(r.total), 48);
  assert.equal(Math.round(Object.values(r.byDay).reduce((a, b) => a + b, 0)), 48);
  const nightOnly = flat.map((_, h) => (h < 6 ? 4 : 0));     // all sales between 00:00 and 06:00 IST
  const day = E.sellingHours(Date.parse('2026-11-01T06:30:00Z'), Date.parse('2026-11-01T12:30:00Z'), nightOnly, 330);   // 12:00–18:00 IST
  assert.equal(day.total, 0);
});

test('report: lost value, small top-up and repeat flags, reorder list', () => {
  const now = t0 + 28 * D;
  const stock = [
    { t: t0, variantId: '1', sku: 'A', product: 'Serum', variant: '30 ml', before: 300, now: 300, price: 500 },
    { t: t0 + 10 * D, variantId: '1', before: 1, now: 0 },
    { t: t0 + 11 * D, variantId: '1', before: 0, now: 10 },
    { t: t0 + 12 * D, variantId: '1', before: 1, now: 0 },
    { t: t0 + 14 * D, variantId: '1', before: 0, now: 40 },
  ];
  const orders = [];
  for (let d = 0; d < 28; d++) if (d < 10 || d === 11 || d >= 14) orders.push({ t: t0 + d * D, order: `#${d}`, variantId: '1', sku: 'A', qty: 10, price: 500 });
  const r = E.report(stock, orders, { tzOffsetMin: 0 }, { now, days: 28 });
  const p = r.products[0];
  assert.equal(p.perDay, 10);
  assert.equal(r.stockouts.length, 2);
  const first = r.stockouts.find((s) => s.topUp === 10);
  assert.equal(first.small, true); assert.equal(first.repeat, true);
  assert.equal(r.totals.lost, Math.round(3 * 10 * 500));        // 3 days out × 10/day × ₹500 (flat hours)
  assert.equal(p.status, 'Order now');                           // 40 in stock at 10/day = 4 days (> 3 = not critical, < lead + safety)
});

test('rows: CSV with header, Flow line without header, JSON webhook', () => {
  const csv = 'Time,Variant ID,SKU,Product,Variant,Stock before,Stock now,Price\n2026-11-17T10:00:00+05:30,gid://shopify/ProductVariant/42,"S,1",Serum,30 ml,5,0,499\n';
  const a = R.fromCsv(csv, 'stock').rows;
  assert.equal(a.length, 1); assert.equal(a[0].variantId, '42'); assert.equal(a[0].sku, 'S,1'); assert.equal(a[0].now, 0);
  const b = R.fromWebhook('2026-11-17T10:05:00+0530,42,S1,Serum,30 ml,0,12,499', 'stock');
  assert.equal(b[0].now, 12); assert.equal(b[0].t, Date.parse('2026-11-17T10:05:00+05:30'));
  const c = R.fromWebhook({ created_at: '2026-11-17T10:06:00+05:30', order: '#1001', variant_id: 42, sku: 'S1', quantity: 2, price: 449 }, 'order');
  assert.equal(c[0].qty, 2); assert.equal(c[0].price, 449);
  const noTime = R.fromWebhook(',42,S1,Serum,,3,2,499', 'stock', 123);
  assert.equal(noTime[0].t, 123);
});

test('stock rows carry an optional category; products report it with units sold and % lost', () => {
  const csv = 'Time,Variant ID,SKU,Product,Variant,Stock before,Stock now,Price,Product type\n2026-11-01T10:00:00+05:30,9,S9,Lamp,,5,4,1000,Lamps';
  const { rows } = R.fromCsv(csv, 'stock');
  assert.equal(rows[0].type, 'Lamps');
  assert.equal(R.fromCsv('Time,Variant ID,SKU,Product,Variant,Stock before,Stock now,Price\n2026-11-01T10:00:00+05:30,9,S9,Lamp,,5,4,1000', 'stock').rows[0].type, undefined);
  const now = Date.parse('2026-11-10T00:00:00Z');
  const r = E.report([{ t: now - 5 * D, variantId: '9', sku: 'S9', product: 'Lamp', before: 5, now: 4, price: 1000, type: 'Lamps' }],
    [{ t: now - 5 * D, order: '#1', variantId: '9', sku: 'S9', qty: 1, price: 1000 }], {}, { days: 30, now });
  const p = r.products[0];
  assert.equal(p.type, 'Lamps'); assert.equal(p.unitsSold, 1); assert.equal(p.lostPct, 0);
});

test('best sellers (A = first 80% of sales), profit lost at unit cost, overstock beyond twice the need', () => {
  const now = Date.parse('2026-11-10T00:00:00Z');
  const S = { leadDays: 7, coverDays: 30, safetyDays: 3, minPerDay: 0 };
  const stock = [
    { t: now - 20 * D, variantId: 'big', sku: 'B', product: 'Big', before: 100, now: 100, price: 1000, cost: 400 },
    { t: now - 20 * D, variantId: 'mid', sku: 'M', product: 'Mid', before: 10, now: 10, price: 1000 },
    { t: now - 20 * D, variantId: 'dead', sku: 'X', product: 'Dead', before: 50, now: 50, price: 200, cost: 80 },
    // "big" goes out for exactly one day, 10 days ago
    { t: now - 10 * D, variantId: 'big', sku: 'B', product: 'Big', before: 1, now: 0, price: 1000, cost: 400 },
    { t: now - 9 * D, variantId: 'big', sku: 'B', product: 'Big', before: 0, now: 100, price: 1000, cost: 400 },
  ];
  const orders = [];
  for (let i = 0; i < 18; i++) orders.push({ t: now - (i + 1) * D + 3600e3, order: `#b${i}`, variantId: 'big', qty: 1, price: 1000 });
  orders.push({ t: now - 2 * D, order: '#m1', variantId: 'mid', qty: 2, price: 1000 });
  const r = E.report(stock, orders, S, { days: 30, now });
  const P = Object.fromEntries(r.products.map((p) => [p.id, p]));
  assert.equal(P.big.abc, 'A');            // 18,000 of 20,000 sold
  assert.equal(P.mid.abc, 'B');            // next 10%
  assert.equal(P.dead.abc, 'C');           // didn't sell
  // a full day out costs exactly one day of sales; profit = units × (price paid − cost)
  assert.ok(P.big.lostProfit > 0 && Math.abs(P.big.lostProfit / P.big.lost - 0.6) < 0.01);
  assert.equal(P.mid.lostProfit, null);    // no cost known
  // "dead" has stock and no sales → overstocked, excess valued at unit cost
  assert.equal(P.dead.overstock, true); assert.equal(P.dead.excessUnits, 50); assert.equal(P.dead.excessValue, 50 * 80);
  // order value uses unit cost when known (cash to commit)
  if (P.big.orderQty) assert.equal(P.big.orderValue, Math.round(P.big.orderQty * 400));
});

test('trend: a stock-out is not read as falling demand; too few sales gives no trend', () => {
  const now = Date.parse('2026-11-28T00:00:00Z');
  // 2 a day for 28 days, but out of stock for 7 of the last 14 days (and no sales then)
  const lines = []; let n = 0;
  for (let d = 1; d <= 28; d++) if (d > 7 || d <= 0) lines.push({ t: now - d * D + 3600e3, order: `#${n++}`, variantId: 'v', qty: 2, price: 100 });
  const eps = [{ start: now - 7 * D, end: now, open: true }];
  const t = E.trend(lines, eps, now);
  assert.equal(t.weeks.length, 8);
  assert.equal(t.weeks[7].units, 0); assert.equal(t.weeks[7].outDays, 7);
  assert.equal(t.trendPct, 0);             // raw week-on-week would say −50%
  const thin = E.trend([{ t: now - D, qty: 2 }, { t: now - 20 * D, qty: 1 }], [], now);
  assert.equal(thin.trendPct, null);       // 3 units in 28 days: too few to call
});

/* ---- cases raised by the logic critic (2026-11-19) ---- */
const S0 = { leadDays: 7, coverDays: 30, safetyDays: 3, minPerDay: 0.2 };

test('a product launched 5 days ago: rate counts only its own days; not flagged overstock', () => {
  const now = Date.parse('2026-11-28T00:00:00Z');
  const stock = [{ t: now - 60 * D, variantId: 'old', sku: 'O', product: 'Old', before: 50, now: 50, price: 100 },
    { t: now - 5 * D, variantId: 'new', sku: 'N', product: 'New', before: 60, now: 60, price: 100 }];
  const orders = [{ t: now - 59 * D, order: '#o', variantId: 'old', qty: 1, price: 100 }];
  for (let d = 1; d <= 5; d++) orders.push({ t: now - d * D + 3600e3, order: `#n${d}`, variantId: 'new', qty: 2, price: 100 });
  const p = E.report(stock, orders, S0, { days: 30, now }).products.find((x) => x.id === 'new');
  assert.ok(Math.abs(p.perDay - 2) < 0.01, `perDay ${p.perDay}`);
  assert.equal(p.overstock, false);
});

test('trend with short history: flat sales give a flat trend, not a jump; weeks before data are empty', () => {
  const now = Date.parse('2026-11-28T00:00:00Z');
  const lines = []; for (let d = 1; d <= 20; d++) lines.push({ t: now - d * D + 3600e3, qty: 2 });
  const t = E.trend(lines, [], now, now - 20 * D);
  assert.equal(t.trendPct, 0);
  assert.equal(t.weeks[0].units, null);         // 8 weeks ago: before the data
  assert.equal(t.trendNew, false);
  const tenDays = E.trend(lines.slice(0, 10), [], now, now - 10 * D);
  assert.equal(tenDays.trendNew, false);        // too little history is not "New"
});

test('"New" needs a real earlier window in stock and at least 3 sales since', () => {
  const now = Date.parse('2026-11-28T00:00:00Z');
  assert.equal(E.trend([{ t: now - D, qty: 1 }], [], now, now - 60 * D).trendNew, false);   // one sale isn't a trend
  assert.equal(E.trend([{ t: now - D, qty: 2 }, { t: now - 2 * D, qty: 2 }], [], now, now - 60 * D).trendNew, true);
  const outBefore = [{ start: now - 28 * D, end: now - 14 * D }];                             // out of stock the whole earlier half
  assert.equal(E.trend([{ t: now - D, qty: 2 }, { t: now - 2 * D, qty: 2 }], outBefore, now, now - 60 * D).trendNew, false);
});

test('a best seller that sells few units (high price) is still on the reorder list', () => {
  const now = Date.parse('2026-11-28T00:00:00Z');
  const stock = [{ t: now - 40 * D, variantId: 'sofa', sku: 'S', product: 'Sofa', before: 1, now: 1, price: 90000 },
    { t: now - 10 * D, variantId: 'sofa', sku: 'S', product: 'Sofa', before: 1, now: 0, price: 90000 },
    { t: now - 40 * D, variantId: 'mug', sku: 'M', product: 'Mug', before: 500, now: 500, price: 100 }];
  const orders = [{ t: now - 10 * D, order: '#1', variantId: 'sofa', qty: 1, price: 90000 }];
  for (let d = 1; d <= 28; d++) orders.push({ t: now - d * D, order: `#m${d}`, variantId: 'mug', qty: 1, price: 100 });
  const r = E.report(stock, orders, S0, { days: 30, now });
  const sofa = r.products.find((p) => p.id === 'sofa');
  assert.equal(sofa.abc, 'A'); assert.ok(sofa.perDay < 0.2);
  assert.equal(sofa.status, 'Out now');          // was "Slow seller" and hidden from the reorder list
  assert.ok(r.reorder.some((p) => p.id === 'sofa'));
});

test('overview totals equal the sum of the product rows (partial first day included)', () => {
  const demo = require('../src/demo');
  const now = Date.parse('2026-11-19T07:30:00Z');
  const g = demo.generate({ now });
  for (const days of [7, 30]) {
    const r = E.report(g.stock, g.orders, {}, { days, now });
    const sold = r.products.reduce((s, p) => s + p.sold, 0), lost = r.products.reduce((s, p) => s + p.lostCounted, 0);
    assert.equal(r.totals.sold, sold); assert.equal(r.totals.lost, lost);   // §4c: the headline = the rows' counted part
    assert.equal(r.totals.lostAll, r.products.reduce((s, p) => s + p.lost, 0));
    assert.ok(Math.abs(r.daily.reduce((s, d) => s + d.lost, 0) - lost) <= r.daily.length, 'daily lost = headline (rounding per day only)');
    const ds = r.daily.reduce((s, d) => s + d.sold, 0);
    assert.ok(Math.abs(ds - sold) <= r.daily.length, `daily ${ds} vs rows ${sold}`);   // rounding per day only
  }
});

test('typical-product baseline is the median product trend, not raw store units', () => {
  const now = Date.parse('2026-11-19T07:30:00Z');
  const g = require('../src/demo').generate({ now });
  const r = E.report(g.stock, g.orders, {}, { days: 30, now });
  const v = r.products.map((p) => p.trendPct).filter((x) => x != null).sort((a, b) => a - b);
  const m = Math.floor(v.length / 2), med = v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  assert.ok(Math.abs(r.totals.storeTrendPct - med) < 0.06);
});

test('slow-seller cutoff 0 never makes a product with no demand "Out now"', () => {
  const now = Date.parse('2026-11-28T00:00:00Z');
  const r = E.report([{ t: now - 10 * D, variantId: 'x', sku: 'X', product: 'X', before: 1, now: 0, price: 10 }], [], { ...S0, minPerDay: 0 }, { days: 30, now });
  assert.notEqual(r.products[0].status, 'Out now');
  assert.equal(r.reorder.length, 0);
});

test('store: replacing an order removes its old lines (cancellation / refund picked up later)', () => {
  const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-'));
  delete require.cache[require.resolve('../src/store')];
  require('../src/scope').useDir(process.env.DATA_DIR);   // the module on its own: one store folder
  const store = require('../src/store');
  store.replaceAll([], [], 'empty');
  store.replaceOrders(['#1', '#2'], [{ t: Date.now(), order: '#1', line: 'a', variantId: 'v', qty: 2, price: 10 }, { t: Date.now(), order: '#2', line: 'b', variantId: 'v', qty: 1, price: 10 }]);
  assert.equal(store.load().orders.length, 2);
  store.replaceOrders(['#1'], [{ t: Date.now(), order: '#1', line: 'a', variantId: 'v', qty: 1, price: 10 }]);   // one unit refunded
  store.replaceOrders(['#2'], []);                                                                            // cancelled
  assert.deepEqual(store.load().orders.map((o) => [o.order, o.qty]), [['#1', 1]]);
});

/* ---- SW-001: report survives any data size ---- */
test('minMax: one loop, no spread; empty gives ±Infinity', () => {
  assert.deepEqual(E.minMax([3, 1, 2]), { min: 1, max: 3 });
  assert.deepEqual(E.minMax([{ t: 5 }, { t: 2 }], (x) => x.t), { min: 2, max: 5 });
  assert.deepEqual(E.minMax([]), { min: Infinity, max: -Infinity });
});

test('no spread into Math.min/max anywhere in src/', () => {
  const fs = require('node:fs'), path = require('node:path');
  const dir = path.join(__dirname, '../src');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), /Math\.(min|max)\([^)]*\.\.\./, f);
  }
});

test('report on 300k order lines + 200k stock rows: < 1.5 s, no throw, no NaN/Infinity', () => {
  const now = Date.parse('2026-11-28T00:00:00Z');
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const V = 1000, stock = [], orders = [];
  for (let v = 0; v < V; v++) {
    let s = 50;
    for (let i = 0; i < 200; i++) {
      const b = s; s = rnd() < 0.1 ? 0 : Math.floor(rnd() * 100);
      stock.push({ t: now - 120 * D + i * (120 * D / 200) + Math.floor(rnd() * H), variantId: 'v' + v, sku: 'S' + v, product: 'P' + v, before: b, now: s, price: 500, cost: 200 });
    }
  }
  for (let i = 0; i < 300000; i++) orders.push({ t: now - Math.floor(rnd() * 120 * D), order: '#' + i, variantId: 'v' + Math.floor(rnd() * V), qty: 1 + Math.floor(rnd() * 3), price: 500 });
  const start = process.hrtime.bigint();
  const r = E.report(stock, orders, {}, { days: 90, now });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  const limit = process.env.CI ? 3000 : 1500;   // shared CI runners are ~2x slower than a laptop
  assert.ok(ms < limit, `report took ${Math.round(ms)} ms (limit ${limit})`);
  assert.equal(r.data.stockRows, 200000); assert.equal(r.data.orderRows, 300000);
  assert.ok(r.data.firstOrder <= r.data.lastOrder && r.data.firstStock <= r.data.lastStock);
  const bad = [];
  const walk = (x, at) => {
    if (typeof x === 'number') { if (!Number.isFinite(x)) bad.push(at); return; }
    if (x && typeof x === 'object' && !(x instanceof Set)) for (const [k, v] of Object.entries(x)) walk(v, `${at}.${k}`);
  };
  walk({ totals: r.totals, daily: r.daily, data: r.data, stockouts: r.stockouts }, 'r');
  walk(r.products, 'r.products');                                  // daysLeft is null (not Infinity) when nothing sells
  assert.deepEqual(bad.slice(0, 5), []);
});

/* ---- SW-003: long stock-outs keep their demand ---- */
test('a best seller out for the last 30 days stays Out now, on Reorder, with ₹ lost at its earlier rate', () => {
  const now = Date.parse('2026-11-28T00:00:00Z');
  const stock = [{ t: now - 90 * D, variantId: 'best', sku: 'B', product: 'Best', before: 400, now: 400, price: 1000 },
    { t: now - 30 * D, variantId: 'best', sku: 'B', product: 'Best', before: 1, now: 0, price: 1000 }];
  const orders = [];
  for (let d = 31; d <= 90; d++) for (let k = 0; k < 5; k++) orders.push({ t: now - d * D + (2 + 4 * k) * H, order: `#${d}-${k}`, variantId: 'best', qty: 1, price: 1000 });
  const r = E.report(stock, orders, S0, { days: 30, now });
  const p = r.products[0];
  assert.equal(p.rateBasis, 'history');
  assert.ok(Math.abs(p.perDay - 5) < 0.01, `perDay ${p.perDay}`);
  assert.equal(p.status, 'Out now');
  assert.ok(p.orderQty > 0); assert.equal(p.orderQty, 5 * (7 + 30 + 3));
  assert.ok(Math.abs(p.lost - 30 * 5 * 1000) <= 0.05 * 30 * 5 * 1000, `lost ${p.lost}`);
  assert.ok(r.reorder.some((x) => x.id === 'best'));
});

test('7+ in-stock days in the window: rate unchanged (window basis)', () => {
  const now = Date.parse('2026-11-28T00:00:00Z');
  const stock = [{ t: now - 90 * D, variantId: 'v', sku: 'V', product: 'V', before: 400, now: 400, price: 100 },
    { t: now - 20 * D, variantId: 'v', sku: 'V', product: 'V', before: 1, now: 0, price: 100 }];   // 8 in-stock days in the 28
  const orders = [];
  for (let d = 21; d <= 90; d++) orders.push({ t: now - d * D + H, order: `#${d}`, variantId: 'v', qty: d <= 28 ? 1 : 5, price: 100 });
  const p = E.report(stock, orders, S0, { days: 30, now }).products[0];
  assert.equal(p.rateBasis, 'window');
  assert.ok(Math.abs(p.perDay - 1) < 0.01, `perDay ${p.perDay}`);    // 8 units ÷ 8 in-stock days
});

test('in-stock lookback: most recent 28 in-stock days, skipping stock-outs; capped at history start', () => {
  const now = 100 * D;
  const eps = [{ start: 40 * D, end: 50 * D }, { start: 80 * D, end: now }];
  assert.equal(E.inStockStart(eps, 0, now, 28 * D), 52 * D);    // the open stock-out is skipped; 28 of the 30 in-stock days 50→80
  assert.equal(E.inStockStart(eps, 0, now, 40 * D), 30 * D);    // 30 (50→80) + 10 (30→40)
  assert.equal(E.inStockStart(eps, 45 * D, now, 40 * D), 45 * D);
});

test('out since before the history starts: rate from the days before the stock-out began', () => {
  const now = Date.parse('2026-11-28T00:00:00Z');
  const lines = []; for (let d = 1; d <= 28; d++) lines.push({ t: now - 150 * D - d * D, qty: 3 });
  const eps = [{ start: now - 150 * D, end: now, open: true }];
  const r = E.demandRate(lines, eps, { winFrom: now - 28 * D, histFrom: now - 120 * D, now, wantDays: 28, first: now - 200 * D });
  assert.equal(r.basis, 'before-out');
  assert.ok(Math.abs(r.perDay - 3) < 0.01, `perDay ${r.perDay}`);
});

/* ---- SW-031: best-seller rank doesn't move with the period buttons ---- */
test('ABC rank and order value are the same at 7 / 30 / 60 days', () => {
  const now = Date.parse('2026-11-19T07:30:00Z');
  const g = require('../src/demo').generate({ now });
  const runs = [7, 30, 60].map((days) => E.report(g.stock, g.orders, {}, { days, now }));
  const key = (r) => Object.fromEntries(r.products.map((p) => [p.id, [p.abc, p.status, p.orderQty, p.orderValue]]));
  const base = key(runs[0]);
  for (const r of runs.slice(1)) {
    assert.deepEqual(key(r), base);
    assert.equal(r.totals.orderValueAll, runs[0].totals.orderValueAll);
    assert.equal(r.totals.orderValueNow, runs[0].totals.orderValueNow);
    assert.equal(r.totals.bestsellers, runs[0].totals.bestsellers);
    assert.equal(r.totals.bestAtRisk, runs[0].totals.bestAtRisk);
  }
});

test('archived variants are not ranked: order value and best sellers are the same at 7 / 30 / 60 days and This month (critic r2 L2)', () => {
  const now = Date.parse('2026-11-19T07:30:00Z');
  const g = require('../src/demo').generate({ now });
  /* 15 sellers archived 6 days ago, no sales since: all listed at 30 days (they sold), at 7 only if they lost sales */
  const sellers = [...new Set(g.orders.filter((o) => o.t > now - 28 * D && o.t < now - 8 * D).map((o) => String(o.variantId)))].slice(0, 15);
  const gone = new Set(sellers);
  const orders = g.orders.filter((o) => !(gone.has(String(o.variantId)) && o.t > now - 7 * D));
  const catalog = Object.fromEntries(sellers.map((id) => [id, { active: false, status: 'ARCHIVED', inactiveSince: now - 6 * D }]));
  const runs = [{ days: 7 }, { days: 30 }, { days: 60 }, { from: Date.parse('2026-10-31T18:30:00Z') }].map((o) => E.report(g.stock, orders, {}, { ...o, now, catalog }));
  const nIn = (r) => r.products.filter((p) => p.status === 'Inactive').length;
  assert.ok(nIn(runs[1]) > nIn(runs[0]), `fixture: more inactive rows listed at 30 days (${nIn(runs[1])}) than at 7 (${nIn(runs[0])})`);
  const key = (r) => Object.fromEntries(r.products.filter((p) => p.status !== 'Inactive').map((p) => [p.id, [p.abc, p.status, p.orderQty, p.orderValue]]));
  for (const r of runs.slice(1)) {
    assert.deepEqual(key(r), key(runs[0]));
    for (const k of ['orderValueNow', 'orderValueAll', 'bestsellers', 'bestAtRisk']) assert.equal(r.totals[k], runs[0].totals[k], k);
  }
  assert.ok(runs[1].products.filter((p) => p.status === 'Inactive').every((p) => p.abc === 'C'), 'inactive rows are C');
});

test('ABC ranks on demand: a best seller out of stock most of the window stays A', () => {
  const now = Date.parse('2026-11-28T00:00:00Z');
  const stock = [{ t: now - 90 * D, variantId: 'best', sku: 'B', product: 'Best', before: 400, now: 400, price: 1000 },
    { t: now - 25 * D, variantId: 'best', sku: 'B', product: 'Best', before: 1, now: 0, price: 1000 },
    { t: now - 90 * D, variantId: 'small', sku: 'S', product: 'Small', before: 400, now: 400, price: 100 }];
  const orders = [];
  for (let d = 1; d <= 90; d++) {
    if (d > 25) orders.push({ t: now - d * D + H, order: `#b${d}`, variantId: 'best', qty: 5, price: 1000 });
    orders.push({ t: now - d * D + H, order: `#s${d}`, variantId: 'small', qty: 2, price: 100 });
  }
  const r = E.report(stock, orders, S0, { days: 7, now });   // 'best' sold nothing in the last 7 or 25 days
  const P = Object.fromEntries(r.products.map((p) => [p.id, p]));
  assert.equal(P.best.sold, 0); assert.equal(P.best.abc, 'A');
  assert.equal(P.small.abc, 'C');                             // 200 of 5,200 ₹/day: under the last 5%
});

/* F1 (critic round 1): a blank "Stock before" never reads as 0. The stock before a change is the previous row's
   "Stock now"; the row's own before is used only for the first row (LOGIC.md §2, §6b). */
test('CSV without a Stock before column: every stock-out counts, the last one is still out', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  const iso = (d) => new Date(now - d * D).toISOString();
  const csv = ['Time,Variant ID,Stock now', ...[10, 0, 10, 0, 10, 0].map((q, i) => `${iso(25 - i * 4)},77,${q}`)].join('\n');
  const stock = R.fromCsv(csv, 'stock').rows;
  assert.ok(stock.every((r) => r.before == null));
  const orders = []; for (let d = 25; d >= 1; d--) orders.push({ t: now - d * D, order: '#' + d, variantId: '77', qty: 1, price: 1000 });
  const r = E.report(stock, orders, {}, { now, days: 30 });
  assert.equal(r.products[0].outs, 3, 'three stock-outs, not one');
  assert.equal(r.totals.stillOut, 1, 'the stock-out running now is still out');
  assert.equal(r.products[0].status, 'Out now');
});

test('Shopify: a variant reactivated at 0 (before = blank) opens a new stock-out', () => {
  const S = require('../src/shopify');
  const v = (qty, status = 'ACTIVE') => ({ id: 'gid://shopify/ProductVariant/5', sku: 'S5', title: 'Default Title', price: '499.00', inventoryQuantity: qty, inventoryItem: { tracked: true }, product: { title: 'P5', status } });
  const a = S.diffStock([v(3)], {}, t0);
  const b = S.diffStock([v(0)], a.lastQty, t0 + D);              // out
  const c = S.diffStock([v(8)], b.lastQty, t0 + 2 * D);          // back
  const d = S.diffStock([v(8, 'DRAFT')], c.lastQty, t0 + 3 * D); // drafted: no row, forgotten
  const e = S.diffStock([v(0)], d.lastQty, t0 + 4 * D);          // active again at 0
  assert.deepEqual(e.rows.map((x) => [x.before, x.now]), [[null, 0]]);
  const eps = E.episodes([...a.rows, ...b.rows, ...c.rows, ...e.rows], t0 + 6 * D);
  assert.equal(eps.length, 2);
  assert.equal(eps[1].open, true); assert.equal(eps[1].start, t0 + 4 * D);
});

test('on order: stock going down after the mark (rows with a blank before) is not counted as received', () => {
  const now = t0 + 10 * D, at = t0 + D;
  const ch = [
    { t: t0, before: 300, now: 300 },
    { t: t0 + 2 * D, before: null, now: 297 },
    { t: t0 + 3 * D, before: null, now: 290 },
    { t: t0 + 4 * D, before: null, now: 280 },
  ];
  const oo = E.onOrderNow({ qty: 300, eta: now + 5 * D, at }, ch, now, 280, 5, 7);
  assert.ok(oo, 'the order is still open');
  assert.equal(oo.remaining, 300);
  const got = E.onOrderNow({ qty: 300, eta: now + 5 * D, at }, [...ch, { t: t0 + 5 * D, before: null, now: 560 }], now, 560, 5, 7);
  assert.equal(got, null, 'a real arrival of 280 (≥ 90%) still completes it');
});

test('demand rate: a few hours in stock never makes "units per day" (7-day floor)', () => {
  const E = require('../src/engine');
  const DAY = 864e5, now = Date.UTC(2026, 10, 20), from = now - 60 * DAY;
  const eps = [{ start: from + 3 * 3600e3, end: now }];        // in stock 3 hours, then out 60 days
  const r = E.demandPerDay(2, from, now, eps);
  assert.ok(r.perDay <= 2 / 7 + 1e-9, `perDay ${r.perDay}`);
  assert.ok(r.rawDays < 1);
  const ok = E.demandPerDay(30, from, now, []);                 // normal case unchanged: 30 units / 60 days
  assert.equal(ok.perDay, 0.5);
  const short = E.demandPerDay(6, now - 3 * DAY, now, []);      // a 3-day span stays 3 days (never more than the span)
  assert.equal(short.perDay, 2);
});

/* L5 (validation 20 Nov 2026): Tara 5 Arm sold 2 units in the 17 h before a 40-day stock-out → 0.29 a day, ₹23,280
 * lost, and Aspen (3 units) ranked a best seller. Under 5 units and 14 in-stock days the rate is capped at units ÷
 * calendar days since the first sale, the row says lowData, and it is never A. */
test('low data: a few units before a long stock-out are capped at the calendar pace and never A', () => {
  const DAY = 864e5, now = Date.UTC(2026, 10, 20, 12);
  const outAt = now - 40 * DAY;
  const stock = [
    { t: outAt - DAY, variantId: 'tara', product: 'Tara', before: null, now: 2, price: 4000 },   // first seen a day before it sold out
    { t: outAt, variantId: 'tara', product: 'Tara', before: 2, now: 0, price: 4000 },
    { t: now - 60 * DAY, variantId: 'big', product: 'Big', before: null, now: 500, price: 100 },
  ];
  const orders = [{ t: outAt - 17 * 3600e3, order: '#1', variantId: 'tara', qty: 1, price: 4000 }, { t: outAt - 3600e3, order: '#2', variantId: 'tara', qty: 1, price: 4000 }];
  for (let i = 0; i < 56; i++) orders.push({ t: now - 56 * DAY + i * DAY, order: `#b${i}`, variantId: 'big', qty: 1, price: 100 });
  const r = E.report(stock, orders, {}, { days: 30, now });
  const tara = r.products.find((p) => p.id === 'tara');
  assert.equal(tara.lowData, true);
  assert.ok(Math.abs(tara.perDay - 2 / ((now - orders[0].t) / DAY)) < 0.01, `perDay ${tara.perDay}`);   // 2 units ÷ ~40.7 days
  assert.notEqual(tara.abc, 'A');
  assert.ok(tara.lost < 30 * 0.06 * 4000, `lost ${tara.lost}`);   // was 30 × 2/7 × ₹4,000 ≈ ₹34,000
  assert.equal(r.products.find((p) => p.id === 'big').lowData, undefined, 'plenty of sales: unchanged');
  /* a new launch selling well over 3 days isn't held back: same rate as before */
  const launch = E.report([{ t: now - 3 * DAY, variantId: 'n', before: null, now: 50, price: 10 }], [1, 2, 3, 4].map((i) => ({ t: now - i * 0.7 * DAY, order: `#n${i}`, variantId: 'n', qty: 1, price: 10 })), {}, { days: 7, now });
  assert.equal(launch.products[0].perDay, 1.43);   // 4 units ÷ the 2.8 days the store's data covers, as before
});

/* L6: totals.stillOut was 87 (every open stock-out) while the Stock-outs page said 45 (out but not selling left out). */
test('still out leaves out products that are out but not selling; they are counted apart', () => {
  const DAY = 864e5, now = Date.UTC(2026, 10, 20, 12);
  const stock = [
    { t: now - 20 * DAY, variantId: 'sells', before: null, now: 5, price: 100 }, { t: now - 2 * DAY, variantId: 'sells', before: 5, now: 0, price: 100 },
    { t: now - 20 * DAY, variantId: 'dead', before: null, now: 0, price: 100 },
  ];
  const orders = [5, 6, 7, 8, 9].map((i) => ({ t: now - i * DAY, order: `#${i}`, variantId: 'sells', qty: 1, price: 100 }));
  const t = E.report(stock, orders, {}, { days: 7, now }).totals;
  assert.equal(t.stillOut, 1);
  assert.equal(t.outNotSelling, 1);
});

/* L4: after a peak the 28-day rate over-orders; with the product or store down 20%+ the row also carries the order
 * at the last 14 days' in-stock pace (paceQty), never more than the order itself. */
test('order at the last 2 weeks’ pace when sales are falling', () => {
  const DAY = 864e5, now = Date.UTC(2026, 10, 20, 12);
  const stock = [{ t: now - 40 * DAY, variantId: 'c', before: null, now: 7, price: 1000 }];
  const orders = [];
  for (let i = 0; i < 14; i++) for (let k = 0; k < 6; k++) orders.push({ t: now - 28 * DAY + i * DAY + k * 3600e3, order: `#a${i}${k}`, variantId: 'c', qty: 1, price: 1000 });   // 6 a day, weeks 3–4 back
  for (let i = 0; i < 14; i++) for (let k = 0; k < 3; k++) orders.push({ t: now - 14 * DAY + i * DAY + k * 3600e3, order: `#b${i}${k}`, variantId: 'c', qty: 1, price: 1000 });   // 3 a day since
  const p = E.report(stock, orders, {}, { days: 30, now, catalog: { c: { product: 'C', price: 1000, stock: 7, active: true } } }).products[0];
  assert.ok(p.trendPct <= -40, `trend ${p.trendPct}`);
  assert.equal(p.orderQty, Math.ceil(4.5 * 40 - 7));          // 126 at 28-day rate 4.5 a day
  assert.equal(p.paceQty, Math.ceil(3 * 40 - 7));             // 113 at 3 a day
  assert.equal(p.pacePerDay, 3); assert.equal(p.paceValue, 113 * 1000);
  /* steady sales: no pace line */
  const flat = []; for (let i = 0; i < 28; i++) flat.push({ t: now - 28 * DAY + i * DAY, order: `#f${i}`, variantId: 'c', qty: 4, price: 1000 });
  assert.equal(E.report(stock, flat, {}, { days: 30, now }).products[0].paceQty, undefined);
});

/* 1.1.1 UI fixes (M1, UI-2/M2, UI-1, SIMP-2, M4) */
test('a sale inside a stock-out moves its start to that sale (M1: Aspen out 49 d but sold 2 on 31 Oct)', () => {
  const DAY = 864e5, now = Date.UTC(2026, 10, 20, 12);
  const stock = [{ t: now - 60 * DAY, variantId: 'a', before: null, now: 1, price: 6000 }, { t: now - 49 * DAY, variantId: 'a', before: 1, now: 0, price: 6000 }];
  const orders = [{ t: now - 49 * DAY + 10 * 60e3, order: '#1', variantId: 'a', qty: 1, price: 6000 },   // the sale that emptied it: first hour, ignored
    { t: now - 20 * DAY, order: '#2', variantId: 'a', qty: 2, price: 6000 }];
  const r = E.report(stock, orders, {}, { days: 30, now });
  const s = r.stockouts.find((x) => x.id === 'a');
  assert.equal(s.start, now - 20 * DAY, 'out from the last sale inside it, not 49 days ago');
  assert.equal(s.open, true);
  assert.equal(Math.round(s.hours / 24), 20);
  /* pure helper: a line in the first hour or outside the spell changes nothing */
  const eps = [{ start: 0, end: 10 * H, open: false, topUp: 5 }];
  assert.deepEqual(E.afterLastSale(eps, [{ t: 30 * 60e3, qty: 1 }, { t: 11 * H, qty: 1 }]), eps);
  assert.equal(E.afterLastSale(eps, [{ t: 3 * H, qty: 1 }, { t: 5 * H, qty: 1 }])[0].start, 5 * H);
});

test('stock-outs total leaves out not-selling episodes (UI-2/M2: tile 94 vs page 52); flagged on the episode', () => {
  const DAY = 864e5, now = Date.UTC(2026, 10, 20, 12);
  const stock = [
    { t: now - 20 * DAY, variantId: 'sells', before: null, now: 5, price: 100 }, { t: now - 2 * DAY, variantId: 'sells', before: 5, now: 0, price: 100 },
    { t: now - 20 * DAY, variantId: 'dead', before: null, now: 0, price: 100 },
  ];
  const orders = [5, 6, 7, 8, 9].map((i) => ({ t: now - i * DAY, order: `#${i}`, variantId: 'sells', qty: 1, price: 100 }));
  const r = E.report(stock, orders, {}, { days: 7, now });
  assert.equal(r.totals.stockouts, 1);
  assert.equal(r.totals.stockoutsNotSelling, 1);
  assert.equal(r.stockouts.find((s) => s.id === 'dead').notSelling, true);
  assert.equal(r.stockouts.find((s) => s.id === 'sells').notSelling, undefined);
});

test('historyFrom = the first stock record; a free gift is flagged (UI-1, M4)', () => {
  const DAY = 864e5, now = Date.UTC(2026, 10, 20, 12);
  const stock = [{ t: now - 2 * DAY, variantId: 'g', before: null, now: 500, price: 899 }, { t: now - 40 * DAY, variantId: 'p', before: null, now: 50, price: 1000 }];
  const orders = [];
  for (let i = 1; i <= 20; i++) orders.push({ t: now - i * DAY, order: `#g${i}`, variantId: 'g', qty: 1, price: i === 1 ? 20 : 0 });   // ₹1 average
  for (let i = 1; i <= 20; i++) orders.push({ t: now - i * DAY, order: `#p${i}`, variantId: 'p', qty: 1, price: 1000 });
  const cat = { g: { product: 'Gift', price: 899, stock: 500, active: true }, p: { product: 'P', price: 1000, stock: 50, active: true } };
  const r = E.report(stock, orders, {}, { days: 30, now, catalog: cat });
  const g = r.products.find((p) => p.id === 'g'), p = r.products.find((x) => x.id === 'p');
  assert.equal(g.historyFrom, now - 2 * DAY); assert.equal(p.historyFrom, now - 40 * DAY);
  assert.equal(g.gift, true); assert.equal(p.gift, undefined);
});

test('Order today rows: biggest ₹ of sales a day first, not every Out now before Critical (SIMP-2)', () => {
  const DAY = 864e5, now = Date.UTC(2026, 10, 20, 12);
  const stock = [{ t: now - 40 * DAY, variantId: 'slowout', before: null, now: 30, price: 1000 }, { t: now - 10 * DAY, variantId: 'slowout', before: 1, now: 0, price: 1000 },
    { t: now - 40 * DAY, variantId: 'star', before: null, now: 8, price: 5000 }];
  const orders = [];
  for (let i = 11; i <= 38; i++) orders.push({ t: now - i * DAY, order: `#s${i}`, variantId: 'slowout', qty: 1, price: 1000 });   // 1 a day, ₹1,000 a day
  for (let i = 1; i <= 28; i++) orders.push({ t: now - i * DAY, order: `#t${i}`, variantId: 'star', qty: 4, price: 5000 });
  const r = E.report(stock, orders, {}, { days: 30, now });
  assert.deepEqual(r.reorder.map((p) => [p.id, p.status]), [['star', 'Critical'], ['slowout', 'Out now']]);
});

/* SW-064, 1.1.3 (LOGIC.md §9e): return % per product by order date from the lines' refunds, cancelled orders included;
 * ₹ sold stays on units kept; demand counts units returned after the sale, never cancelled ones. */
test('returns: % of units ordered, under 5 ordered → null, refund ₹ from the refunds; qty-0 lines are not sales', () => {
  const now = t0 + 20 * D;
  const stock = [{ t: t0, variantId: 'a', before: null, now: 100, price: 1200 }, { t: t0, variantId: 'b', before: null, now: 100, price: 500 }];
  const orders = [
    { t: now - 2 * D, order: '#1', variantId: 'a', qty: 3, ordered: 4, returned: 1, refund: 950, price: 1000 },          // 1 of 4 back, refunded ₹950
    { t: now - 3 * D, order: '#2', variantId: 'a', qty: 0, ordered: 2, returned: 2, refund: 2000, cancelled: 2, price: 1000 },   // cancelled order
    { t: now - 4 * D, order: '#3', variantId: 'a', qty: 2, ordered: 2, price: 1000 },
    { t: now - 5 * D, order: '#4', variantId: 'a', qty: 1, price: 1000 },                  // no `ordered` (old line): 0 back, not in the %
    { t: now - 40 * D, order: '#5', variantId: 'a', qty: 0, ordered: 5, returned: 5, price: 1000 },    // before the period
    { t: now - 2 * D, order: '#6', variantId: 'b', qty: 2, ordered: 4, returned: 2, price: 500 },      // 4 ordered: too few for a %; no refund ₹: at the price
    { t: now - 2 * D, order: '#7', variantId: 'b', qty: 1, ordered: 2, price: 500 },       // an edit removed 1, no refund: not a return
  ];
  const r = E.report(stock, orders, {}, { now, days: 30 });
  const a = r.products.find((p) => p.id === 'a'), b = r.products.find((p) => p.id === 'b');
  assert.deepEqual([a.unitsOrdered, a.unitsReturned, a.unitsCancelled, a.returnPct, a.refundValue], [8, 3, 2, 37.5, 2950]);
  assert.equal(a.unitsSold, 6, 'sales: units kept only');
  assert.equal(a.sold, 6000);
  assert.deepEqual([b.unitsOrdered, b.unitsReturned, b.returnPct, b.refundValue], [6, 2, 33.3, 1000]);
  assert.deepEqual([r.totals.unitsOrdered, r.totals.unitsReturned, r.totals.unitsCancelled, r.totals.returnPct, r.totals.refundValue, r.totals.highReturns], [14, 5, 2, 35.7, 3950, 2]);
  /* demand: kept + returned after the sale (the cancelled order is no demand) */
  assert.deepEqual(orders.map(E.demandQty), [4, 0, 2, 1, 5, 4, 1]);
  const kept = E.report(stock, orders.filter((o) => !o.cancelled).map(({ ordered, returned, refund, ...o }) => ({ ...o, qty: E.demandQty({ qty: o.qty, returned }) })), {}, { now, days: 30 });
  const ka = kept.products.find((p) => p.id === 'a');
  assert.equal(ka.perDay, a.perDay, 'the rate counts returned units as demand, and leaves the cancelled order out');
  assert.equal(ka.lost, a.lost);
  /* the same report without refunds on any line: no returns */
  const plain = E.report(stock, orders.filter((o) => o.qty > 0).map(({ ordered, returned, refund, cancelled, ...o }) => o), {}, { now, days: 30 });
  assert.deepEqual([plain.products.find((p) => p.id === 'a').unitsOrdered, plain.totals.returnPct, plain.totals.refundValue], [0, null, 0]);
});
