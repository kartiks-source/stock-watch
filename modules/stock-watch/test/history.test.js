'use strict';
/* SW-063: stock history rebuilt from Shopify's change log (src/history.js, LOGIC.md §1c). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('../src/history');
const TZ = require('../src/tz');
const engine = require('../src/engine');
const { assertReadOnly } = require('../src/gql-guard');

const DAY = 864e5, HOUR = 36e5;
const ZONE = 'Asia/Kolkata';

test('history: the ShopifyQL query passes the read-only guard, asks for available stock only, by store-time dates', () => {
  assert.doesNotThrow(() => assertReadOnly(H.HISTORY_Q));
  const ql = H.qlFor('2026-09-21', '2026-09-27');
  assert.match(ql, /inventory_state = 'available'/);
  assert.match(ql, /GROUP BY hour, product_variant_id SINCE 2026-09-21 UNTIL 2026-09-27 ORDER BY hour ASC LIMIT 1000/);
  assert.match(H.qlFor('2026-11-18', '2026-11-20', 'day'), /GROUP BY day, product_variant_id SINCE 2026-11-18 UNTIL 2026-11-20 ORDER BY day ASC LIMIT 1000/);
  assert.equal(H.keyMinus('2026-11-20', 60), '2026-09-21');
  assert.equal(H.keyMinus('2026-03-30', 1), '2026-03-29');   // a daylight-saving week is still whole days
});

/* 1.1.0 bug: 'UNTIL -Nd' left day N out, so 1 day in every 7 was never read (validation 20 Nov 2026). */
test('history: windows and their splits cover every day from days..0 exactly once', () => {
  for (const days of [0, 1, 6, 7, 8, 60, 61, 118]) {
    const seen = new Map();
    const cover = (w) => { for (let k = w[0]; k >= w[1]; k--) seen.set(k, (seen.get(k) || 0) + 1); };
    const ws = H.windows(days);
    ws.forEach(([a, b]) => assert.ok(a >= b && a - b <= 6));
    ws.forEach(cover);
    assert.equal(seen.size, days + 1, `${days}: every day`);
    assert.ok([...seen.values()].every((n) => n === 1), `${days}: no day twice`);
  }
  for (const [a, b] of [[61, 55], [7, 6], [3, 0], [10, 9]]) {
    const parts = H.split(a, b), seen = [];
    for (const [x, y] of parts) { assert.ok(x >= y); for (let k = x; k >= y; k--) seen.push(k); }
    assert.deepEqual(seen, Array.from({ length: a - b + 1 }, (_, i) => a - i), `split ${a},${b}`);
  }
});

test('history: times with an offset, without one (store time) and day-only', () => {
  assert.equal(H.parseTime('2026-11-10T14:00:00+05:30', ZONE), Date.parse('2026-11-10T08:30:00Z'));
  assert.equal(H.parseTime('2026-11-10T14:00:00Z', ZONE), Date.parse('2026-11-10T14:00:00Z'));
  assert.equal(H.parseTime('2026-11-10T14:00:00', ZONE), Date.parse('2026-11-10T08:30:00Z'));
  assert.equal(H.parseTime('2026-11-10', ZONE), Date.parse('2026-11-09T18:30:00Z'));
  assert.ok(Number.isNaN(H.parseTime('soon', ZONE)));
});

test('history: table rows as objects or arrays; committed, zero and junk rows ignored', () => {
  const a = H.parseTable({ columns: [{ name: 'hour' }, { name: 'product_variant_id' }, { name: 'inventory_adjustment_change' }],
    rows: [{ hour: '2026-11-10T14:00:00', product_variant_id: 11, inventory_adjustment_change: '-2' }, { hour: '2026-11-10T15:00:00', product_variant_id: '11', inventory_adjustment_change: '0' }, { hour: 'x', product_variant_id: 11, inventory_adjustment_change: '1' }] }, ZONE);
  assert.deepEqual(a.changes, [{ t: Date.parse('2026-11-10T08:30:00Z'), variantId: '11', delta: -2 }]);
  assert.equal(a.count, 3);
  const b = H.parseTable({ columns: [{ name: 'day' }, { name: 'inventory_state' }, { name: 'product_variant_id' }, { name: 'inventory_adjustment_change' }],
    rows: [['2026-11-10', 'committed', '11', '5'], ['2026-11-10', 'available', 'gid://shopify/ProductVariant/12', '3']] }, ZONE);
  assert.deepEqual(b.changes.map((c) => [c.variantId, c.delta]), [['12', 3]]);
});

test('history: rebuild walks back from the first snapshot; negative dropped; no changes stays flat; later changes ignored', () => {
  const first = Date.parse('2026-11-20T06:00:00Z'), since = first - 10 * DAY;
  const changes = [
    { t: first - 5 * DAY, variantId: '1', delta: 4 },      // restock of 4 five days ago
    { t: first - 2 * DAY, variantId: '1', delta: -3 },     // sold 3
    { t: first - 2 * DAY, variantId: '1', delta: -1 },     // same hour: summed
    { t: first + HOUR, variantId: '1', delta: -9 },         // after the snapshot: ignored
    { t: first - 20 * DAY, variantId: '1', delta: 50 },     // before since: ignored
    { t: first - 3 * DAY, variantId: '2', delta: 5 },       // would need -3 before: dropped
    { t: first - 3 * DAY, variantId: '9', delta: -5 },      // not in the snapshot: ignored
  ];
  const meta = { 1: { sku: 'A', product: 'Lamp', variant: '', price: 999, type: 'Decor', cost: 400 } };
  const out = H.rebuild(changes, { 1: 2, 2: 2, 3: 0 }, first, { since, meta });
  assert.deepEqual(out.dropped, ['2']);
  assert.equal(out.total, 3); assert.equal(out.kept, 2); assert.equal(out.changed, 1); assert.equal(out.flat, 1);
  const v1 = out.rows.filter((r) => r.variantId === '1');
  assert.deepEqual(v1.map((r) => [r.t, r.before, r.now]), [[since, null, 2], [first - 5 * DAY, 2, 6], [first - 2 * DAY, 6, 2]]);
  assert.deepEqual(Object.keys(v1[0]), ['t', 'variantId', 'sku', 'product', 'variant', 'before', 'now', 'price', 'type', 'cost']);   // pullStock's shape
  assert.deepEqual(out.rows.filter((r) => r.variantId === '3').map((r) => [r.t, r.now]), [[since, 0]]);   // flat at 0: out the whole time
  assert.ok(out.rows.every((r) => r.t < first));
});

/* A fake gql that answers ShopifyQL like Shopify (probed on Sammsara, 20 Nov 2026): absolute dates are store days with
 * both ends included; relative 'UNTIL -Nd' leaves day N out ('UNTIL today' includes today); hour buckets start on
 * store-time hours; at most `cap` rows. */
function fakeShop(changes, { now, cap = 1000, failWith = null } = {}) {
  const calls = [];
  const today = TZ.dayStart(now, ZONE);
  const off = (t) => Math.round((today - TZ.dayStart(t, ZONE)) / DAY);
  const q = async (doc, vars) => {
    assert.doesNotThrow(() => assertReadOnly(doc));
    calls.push(vars.q);
    if (failWith) { if (failWith instanceof Error) throw failWith; return failWith; }
    const grain = vars.q.match(/GROUP BY (hour|day),/)[1];
    let inRange;
    const abs = vars.q.match(/SINCE (\d{4}-\d\d-\d\d) UNTIL (\d{4}-\d\d-\d\d)/);
    if (abs) inRange = (t) => { const k = TZ.dayKey(t, ZONE); return k >= abs[1] && k <= abs[2]; };
    else {
      const m = vars.q.match(/SINCE (today|-(\d+)d) UNTIL (today|-(\d+)d)/);
      const a = m[2] ? +m[2] : 0, b = m[4] ? +m[4] : 0, untilToday = m[3] === 'today';
      inRange = (t) => off(t) <= a && (untilToday ? off(t) >= 0 : off(t) > b);
    }
    const hit = changes.filter((c) => inRange(c.t) && c.state !== 'committed');
    const bucket = new Map();
    for (const c of hit) {
      const t = grain === 'hour' ? TZ.nextHour(c.t, ZONE) - HOUR : TZ.dayStart(c.t, ZONE);
      const k = `${t}|${c.variantId}`; bucket.set(k, (bucket.get(k) || 0) + c.delta);
    }
    const rows = [...bucket].map(([k, d]) => { const [t, id] = k.split('|'); const iso = new Date(+t).toISOString().replace('.000Z', 'Z');
      return { [grain]: grain === 'hour' ? iso : TZ.dayKey(+t, ZONE), product_variant_id: id, inventory_adjustment_change: String(d) }; }).slice(0, cap);
    return { shopifyqlQuery: { tableData: { columns: [{ name: grain }, { name: 'product_variant_id' }, { name: 'inventory_adjustment_change' }], rows }, parseErrors: [] } };
  };
  return { q, calls };
}

test('history: fetchChanges reads one change on every day of 61, none lost at window edges (1.1.0 lost 8)', async () => {
  const now = Date.parse('2026-11-20T12:40:00Z');
  const changes = []; for (let k = 0; k <= 60; k++) changes.push({ t: TZ.dayStart(now, ZONE) - k * DAY + 13 * HOUR, variantId: String(1000 + k), delta: -1 });
  const fx = fakeShop(changes, { now });
  const got = await H.fetchChanges(fx.q, 60, { zone: ZONE, now });
  assert.equal(got.changes.length, 61);
  assert.equal(got.calls, 9);
  assert.deepEqual(new Set(got.changes.map((c) => TZ.dayKey(c.t, ZONE))).size, 61);
  assert.ok(fx.calls.every((c) => /SINCE \d{4}-\d\d-\d\d UNTIL \d{4}-\d\d-\d\d/.test(c)), 'absolute dates only');
  assert.match(fx.calls[0], /SINCE 2026-09-21 UNTIL 2026-09-27/);
  assert.match(fx.calls[8], /SINCE 2026-11-16 UNTIL 2026-11-20/);
  /* the fake is faithful to Shopify's relative form: the old query text really loses day -54 */
  const old = await fx.q(H.HISTORY_Q, { q: "FROM x SHOW y GROUP BY hour, product_variant_id SINCE -60d UNTIL -54d" });
  assert.equal(old.shopifyqlQuery.tableData.rows.length, 6);
});

test('history: fetchChanges pages by week, splits a capped window in half, reads a capped day by day', async () => {
  const now = Date.parse('2026-11-20T06:00:00Z');
  const changes = [];
  for (let i = 0; i < 40; i++) changes.push({ t: now - 30 * DAY + i * HOUR, variantId: String(100 + i), delta: -1 });   // 40 in ~2 days
  changes.push({ t: now - 3 * DAY, variantId: '5', delta: 2, state: 'committed' });
  const big = fakeShop(changes, { now, cap: 25 });
  const got = await H.fetchChanges(big.q, 60, { zone: ZONE, cap: 25, now });
  assert.equal(got.changes.length, 40);
  assert.ok(big.calls.some((c) => /SINCE 2026-09-21 UNTIL 2026-09-27/.test(c)));
  assert.ok(big.calls.some((c) => /UNTIL 2026-11-20 /.test(c)));
  assert.ok(big.calls.length > 9, 'a capped window was split');
  /* one day with more than the cap even by hour: read by day (40 variants, 1 row each) */
  const oneDay = []; for (let h = 0; h < 24; h++) for (let v = 0; v < 2; v++) oneDay.push({ t: TZ.dayStart(now - 10 * DAY, ZONE) + h * HOUR, variantId: String(v + 1), delta: -1 });   // 48 hour rows, 2 day rows
  const d = fakeShop(oneDay, { now, cap: 25 });
  const got2 = await H.fetchChanges(d.q, 20, { zone: ZONE, cap: 25, now });
  assert.ok(d.calls.some((c) => /GROUP BY day/.test(c)));
  assert.equal(got2.changes.reduce((s, c) => s + c.delta, 0), -48);
  /* still capped by day → HistoryError('cap') */
  const many = []; for (let v = 0; v < 30; v++) many.push({ t: now - 10 * DAY, variantId: String(v + 1), delta: -1 });
  await assert.rejects(H.fetchChanges(fakeShop(many, { now, cap: 25 }).q, 20, { zone: ZONE, cap: 25, now }), (e) => e.code === 'cap');
});

test('history: parse errors and a missing scope are clean errors with a plain note', async () => {
  const now = Date.now();
  await assert.rejects(H.fetchChanges(fakeShop([], { now, failWith: { shopifyqlQuery: { tableData: null, parseErrors: ['bad token at 1:5'] } } }).q, 7), (e) => e.code === 'parse');
  assert.match(H.noteFor(new Error('The token lacks a read permission (needs read_products, read_inventory, read_orders)')), /read_reports/);
  assert.match(H.noteFor(new H.HistoryError('parse', 'Shopify didn’t accept')), /^Past stock-outs not rebuilt: Shopify didn’t accept/);
});

/* run(): on a real store file in a temp folder */
function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-hist-'));
  process.env.DATA_DIR = dir;
  delete require.cache[require.resolve('../src/store')];
  require('../src/scope').useDir(dir);
  return { store: require('../src/store'), dir };
}

test('history: run() stores rebuilt rows before the first read, feeds ₹ lost, re-runs replace; a failure only leaves a note', async (t) => {
  const { store, dir } = freshStore(); t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); require('../src/scope').useDir(null); });
  const now = Date.now(), first = now - HOUR;
  const live = [
    { t: first, variantId: '1', sku: 'A', product: 'Lamp', variant: '', before: null, now: 5, price: 1000 },
    { t: first, variantId: '2', sku: 'B', product: 'Rug', variant: '', before: null, now: 3, price: 500 },
  ];
  store.add('stock', live, 'shopify');
  /* Lamp: sold out 20 days ago (−4), restocked +5 ten days ago → out for 10 days. Rug: no changes → flat at 3. */
  const changes = [{ t: now - 20 * DAY, variantId: '1', delta: -4 }, { t: now - 10 * DAY, variantId: '1', delta: 5 }];
  const orders = []; for (let i = 21; i < 50; i++) orders.push({ t: now - i * DAY, order: `#${i}`, line: String(i), variantId: '1', sku: 'A', qty: 1, price: 1000 });
  store.replaceOrders(orders.map((o) => o.order), orders, 'shopify');

  const fx = fakeShop(changes, { now });
  const info = await H.run({ q: fx.q, now });
  assert.equal(info.ok, true); assert.equal(info.kept, 2); assert.equal(info.total, 2); assert.equal(info.dropped, 0);
  const d = store.load();
  const rb = d.stock.filter((r) => r.src === 'rebuilt');
  assert.ok(rb.length === 4 && rb.every((r) => r.t < first));
  assert.equal(d.shopify.historyRebuiltAt, now);
  const r = engine.report(d.stock, d.orders, d.settings, { days: 30, now });
  const lamp = r.stockouts.find((s) => s.id === '1');
  assert.ok(lamp && !lamp.open && Math.abs(lamp.hours - 240) < 2, 'a 10-day stock-out rebuilt');
  assert.ok(r.totals.lost > 3000, `₹ lost from the rebuilt stock-out: ${r.totals.lost}`);   // ~10 days × the in-stock rate (7 sold ÷ 18 in-stock days) × ₹1,000

  await H.run({ q: fx.q, now });   // again: same rows, not doubled
  assert.equal(store.load().stock.filter((x) => x.src === 'rebuilt').length, 4);

  const bad = await H.run({ q: fakeShop([], { now, failWith: new Error('The token lacks a read permission (needs read_products, read_inventory, read_orders)') }).q, now });
  assert.equal(bad.ok, true, 'the earlier rebuild still stands'); assert.match(bad.note, /read_reports/);
  assert.equal(store.load().shopify.history.note, bad.note);
  assert.equal(store.load().stock.filter((x) => x.src === 'rebuilt').length, 4, 'a failed re-run keeps the earlier rebuild');
});

test('history: run() with no live read, or a missing scope on a first run, never throws and stores no rows', async (t) => {
  const { store, dir } = freshStore(); t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); require('../src/scope').useDir(null); });
  const none = await H.run({ q: async () => { throw new Error('not called'); } });
  assert.equal(none.ok, false); assert.match(none.note, /no Shopify stock read/);
  store.add('stock', [{ t: Date.now(), variantId: '1', sku: 'A', product: 'Lamp', variant: '', before: null, now: 5, price: 1 }], 'shopify');
  const r = await H.run({ q: fakeShop([], { now: Date.now(), failWith: { shopifyqlQuery: { tableData: null, parseErrors: ['no such table'] } } }).q });
  assert.equal(r.ok, false); assert.match(r.note, /didn’t accept/);
  assert.equal(store.load().stock.filter((x) => x.src === 'rebuilt').length, 0);
});

/* F5 (validation 20 Nov 2026): the first read was 18:10; an order at 18:14 sat in the 18:00 bucket and was counted
 * before the read, so Cascade's whole 60 days read 1 too high and its real stock-outs vanished. */
test('history: the first read’s own hour counts only orders before the read', () => {
  const first = Date.parse('2026-11-20T12:40:06Z');            // 18:10:06 IST
  const hs = Date.parse('2026-11-20T12:30:00Z');               // 18:00 IST bucket
  const since = first - 2 * DAY;
  const changes = [{ t: hs, variantId: '1', delta: -2 }, { t: hs - 5 * HOUR, variantId: '1', delta: -1 }];   // bucket: 18:09 order + 18:14 order
  const orders = [{ t: hs + 9 * 60e3, variantId: '1', qty: 1 }, { t: hs + 14 * 60e3, variantId: '1', qty: 1 }];
  const old = H.rebuild(changes, { 1: 7 }, first, { since });
  assert.deepEqual(old.rows.map((r) => r.now), [10, 9, 7], 'without order lines: the 18:14 order counted before the read');
  const out = H.rebuild(changes, { 1: 7 }, first, { since, orders, zone: ZONE });
  assert.deepEqual(out.rows.map((r) => [r.t, r.before, r.now]), [[since, null, 9], [hs - 5 * HOUR, 9, 8], [hs, 8, 7]]);
  /* no orders in that hour: its logged change (made after the read) is ignored */
  const none = H.rebuild([{ t: hs, variantId: '1', delta: 5 }], { 1: 7 }, first, { since, orders: [], zone: ZONE });
  assert.deepEqual(none.rows.map((r) => r.now), [7]);
});

test('history: an oversold variant (stock −1 now) is kept down to 2 below; lower is dropped (1.4.6)', () => {
  const first = Date.parse('2026-11-20T12:40:00Z'), since = first - 10 * DAY;
  const out = H.rebuild([{ t: first - 2 * DAY, variantId: '1', delta: -2 }, { t: first - 3 * DAY, variantId: '2', delta: 3 }], { 1: -1, 2: -1 }, first, { since, orders: [], zone: ZONE });
  assert.deepEqual(out.dropped, ['2']);   // 2 would have been at −4 before
  assert.deepEqual(out.rows.map((r) => [r.variantId, r.now]), [['1', 1], ['1', -1]]);
});

test('history: validate flags orders inside a rebuilt stock-out with no logged drop; an oversell and the start hour pass', () => {
  const first = Date.parse('2026-11-20T12:40:00Z'), since = first - 10 * DAY;
  const outAt = Date.parse('2026-11-12T08:30:00Z');            // 14:00 IST
  const rows = [
    { t: since, variantId: '1', before: null, now: 1 }, { t: outAt, variantId: '1', before: 1, now: 0 },     // out from 12 Nov, never back
    { t: since, variantId: '2', before: null, now: 0 }, { t: outAt + 3 * HOUR, variantId: '2', before: 0, now: -1 },   // oversold
  ];
  const changes = [{ t: outAt, variantId: '1', delta: -1 }, { t: outAt + 3 * HOUR, variantId: '2', delta: -1 }];
  const orders = [
    { t: outAt + 10 * 60e3, variantId: '1', qty: 1 },           // the order that emptied it: start hour, passes
    { t: outAt + 2 * DAY, variantId: '1', qty: 2 },             // two days later at 0, nothing logged: impossible
    { t: outAt + 3 * HOUR + 60e3, variantId: '2', qty: 1 },     // oversell: its drop is in the log
    { t: first + HOUR, variantId: '1', qty: 1 },                // after the first read: not checked
  ];
  const r = H.validate(rows, orders, changes, first, { since, zone: ZONE });
  assert.deepEqual(r, { lines: 3, bad: 1, badUnits: 2, variants: ['1'] });
});

test('history: run() drops a variant that fails the order check, refuses over 1%, and is due again after a rules change', async (t) => {
  const { store, dir } = freshStore(); t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); require('../src/scope').useDir(null); });
  const now = Date.now(), first = now - HOUR;
  store.add('stock', [
    { t: first, variantId: '1', sku: 'A', product: 'Lamp', variant: '', before: null, now: 0, price: 1000 },
    { t: first, variantId: '2', sku: 'B', product: 'Rug', variant: '', before: null, now: 3, price: 500 },
  ], 'shopify');
  /* Lamp: the log says it has been at 0 for 40 days, yet it sold twice since → the log misses its stock. Rug: fine. */
  const orders = []; for (let i = 10; i < 25; i += 10) orders.push({ t: now - i * DAY, order: `#L${i}`, line: `L${i}`, variantId: '1', sku: 'A', qty: 1, price: 1000 });
  for (let i = 0; i < 300; i++) orders.push({ t: now - 50 * DAY + i * 3 * HOUR, order: `#R${i}`, line: `R${i}`, variantId: '2', sku: 'B', qty: 1, price: 500 });
  store.replaceOrders(orders.map((o) => o.order), orders, 'shopify');
  const rugLog = orders.filter((o) => o.variantId === '2').map((o) => ({ t: o.t, variantId: '2', delta: -1 })).concat([{ t: now - 55 * DAY, variantId: '2', delta: 303 }]);
  assert.equal(H.due(store.load().shopify), true, 'never rebuilt');
  const info = await H.run({ q: fakeShop([{ t: now - 40 * DAY, variantId: '1', delta: -1 }, ...rugLog], { now }).q, now });
  assert.equal(info.ok, true); assert.equal(info.v, H.VERSION);
  assert.equal(info.droppedCheck, 1); assert.equal(info.kept, 1); assert.equal(info.dropped, 1);
  assert.equal(info.check.bad, 2); assert.ok(info.check.lines > 300 && info.check.bad / info.check.lines < H.BAD_SHARE);
  assert.ok(store.load().stock.filter((r) => r.src === 'rebuilt').every((r) => r.variantId === '2'));
  assert.equal(H.due(store.load().shopify), false);
  assert.equal(H.due({ historyRebuiltAt: 1, history: { ok: true } }), true, 'a 1.1.0 rebuild (no v) is redone');

  /* a log that only has the Rug's restock 10 days ago: it reads as out before that while it sold 300 times → refused */
  const bad = await H.run({ q: fakeShop([{ t: now - 10 * DAY, variantId: '2', delta: 3 }], { now }).q, now });
  assert.equal(bad.ok, false); assert.match(bad.note, /doesn’t add up/);
  assert.equal(store.load().stock.filter((r) => r.src === 'rebuilt').length, 0, 'refused: no rebuilt rows at all');
});

test('history: a failed re-run after a 1.1.0 rebuild removes the old rows instead of keeping them', async (t) => {
  const { store, dir } = freshStore(); t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); require('../src/scope').useDir(null); });
  const now = Date.now();
  store.add('stock', [{ t: now - HOUR, variantId: '1', sku: 'A', product: 'Lamp', variant: '', before: null, now: 2, price: 1 }], 'shopify');
  store.setRebuilt([{ t: now - 9 * DAY, variantId: '1', sku: 'A', product: 'Lamp', variant: '', before: null, now: 0, price: 1 }]);
  store.setShopify({ historyRebuiltAt: now - DAY, history: { at: now - DAY, ok: true, kept: 1, total: 1 } });
  const r = await H.run({ q: fakeShop([], { now, failWith: new Error('Shopify: HTTP 500') }).q, now });
  assert.equal(r.ok, false);
  assert.equal(store.load().stock.filter((x) => x.src === 'rebuilt').length, 0);
});
