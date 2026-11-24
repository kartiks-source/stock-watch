'use strict';
/* Multi-store (ADR-0015): the 15-minute loop pulls one store at a time (Performity: 30 calls/min per IP, 10 token
 * calls/min per brand; the Shopify app's limit is shared), a manual pull queues behind it, and each store's rows land
 * in its own store.json. Shopify reads are stubbed; three vault stores, no network. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-sched-'));
for (const k of Object.keys(process.env)) if (/^(AZURE_|SHOPIFY_|TOKEN_API|PERFORMITY_|STORES$|ADMIN_PASSWORD|ALERT_)/.test(k)) delete process.env[k];
Object.assign(process.env, { DATA_DIR: dir, AZURE_KEY_VAULT_URL: 'https://test-vault.vault.azure.net', AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's', STORES: 'alpha,beta,gamma' });
const S = require('../src/shopify');
const C = require('../src/catalog');
const scope = require('../src/scope');
const { pullAll, syncShopify } = require('../server');

test('pull loop: stores one after the other, never two at once; a manual pull queues; rows stay in their store', async () => {
  let active = 0, most = 0; const order = [];
  S.pullStock = async () => {
    active++; most = Math.max(most, active); order.push(scope.id());
    await new Promise((r) => setTimeout(r, 25));
    const id = scope.id(), now = Date.now();
    active--;
    return { rows: [{ t: now, variantId: `v-${id}`, sku: id, product: `Only in ${id}`, variant: '', before: null, now: 3, price: 100 }], lastQty: { [`v-${id}`]: 3 }, catalog: {}, excluded: {} };
  };
  S.pullOrders = async (since, { onPage }) => { await onPage([`#${scope.id()}`], [{ t: Date.now(), order: `#${scope.id()}`, line: '1', variantId: `v-${scope.id()}`, sku: 'x', qty: 1, price: 100 }], Date.now()); return { total: 1 }; };
  C.refreshCollections = async () => ({ skipped: true });
  require('../src/token-scopes').check = async () => ({ handles: [], write: [] });   // SW-051 scope check: stubbed like the reads
  const ql = [];   // SW-063: the history rebuild runs once per store, after its first good pull, through gql
  S.gql = async (doc, vars, opts) => { ql.push([scope.id(), opts && opts.version, /^query History/.test(doc)]); return { shopifyqlQuery: { tableData: { columns: [{ name: 'hour' }, { name: 'product_variant_id' }, { name: 'inventory_adjustment_change' }], rows: [] }, parseErrors: [] } }; };

  const loop = pullAll();
  const manual = syncShopify('beta');                       // while the loop starts: queued like any other pull
  assert.equal(syncShopify('beta'), manual, 'asking again for a store already queued gives the same pull');
  await Promise.all([loop, manual]);
  assert.equal(most, 1, 'never two pulls at once');
  assert.deepEqual(order, ['beta', 'alpha', 'beta', 'gamma'], 'the manual pull was queued first, then the loop took every store in order');
  require('../src/store').saveAll();
  for (const id of ['alpha', 'beta', 'gamma']) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'stores', id, 'store.json'), 'utf8'));
    assert.deepEqual([...new Set(j.stock.map((r) => r.variantId))], [`v-${id}`], `${id} holds only its own stock rows`);
    assert.deepEqual([...new Set(j.orders.map((r) => r.order))], [`#${id}`], `${id} holds only its own orders`);
    assert.ok(j.shopify.lastSync, `${id} pulled`);
    assert.ok(j.shopify.historyRebuiltAt && j.shopify.history.ok, `${id} history rebuilt`);
  }
  assert.equal(new Set(ql.map((x) => x[0])).size, 3);
  assert.equal(ql.filter((x) => x[0] === 'beta' && x[2]).length, ql.filter((x) => x[0] === 'alpha' && x[2]).length, 'beta pulled twice, rebuilt once');   // 1.4.0: the 12-month read goes on at the second pull (src/year.js)
  assert.ok(ql.every((x) => x[1] === '2025-10'));
});

/* 1.1.1 (F2): order prices became ex GST. A store whose orders were read before (no priceBasis) re-reads the 60-day
 * backfill once (cursor cleared), then goes back to reading changed orders only. */
test('pull: orders read before 1.1.1 are read again once from the backfill, then incrementally', async () => {
  const store = require('../src/store');
  const sinces = [];
  const prev = S.pullOrders;
  S.pullOrders = async (since, opts) => { sinces.push(since); return prev(since, opts); };
  scope.run('alpha', () => store.setShopify({ priceBasis: undefined, ordersCursor: 12345 }));
  await syncShopify('alpha');
  await syncShopify('alpha');
  S.pullOrders = prev;
  assert.equal(sinces[0], null, 'first pull after the upgrade: full backfill');
  assert.ok(sinces[1] > 12345, 'next pull: from the new cursor');
  assert.equal(scope.run('alpha', () => store.load().shopify.priceBasis), 'exTax');
});

/* SW-064: lines read before `ordered` existed: the 60-day backfill is read once more so history gets it. */
test('pull: orders read before SW-064 (no orderFields) are read again once from the backfill', async () => {
  const store = require('../src/store');
  const sinces = [];
  const prev = S.pullOrders;
  S.pullOrders = async (since, opts) => { sinces.push(since); return prev(since, opts); };
  scope.run('alpha', () => store.setShopify({ priceBasis: 'exTax', orderFields: undefined, ordersCursor: 12345 }));
  await syncShopify('alpha');
  await syncShopify('alpha');
  S.pullOrders = prev;
  assert.equal(sinces[0], null, 'first pull after the upgrade: full backfill');
  assert.ok(sinces[1] > 12345, 'then incremental');
  assert.equal(scope.run('alpha', () => store.load().shopify.orderFields), 'reversals');
});

/* 1.1.3: lines read by SW-064 (orderFields 'ordered') lack refunds: the 60-day backfill is read once more. */
test('pull: orders read by SW-064 (orderFields "ordered") are read again once for refunds', async () => {
  const store = require('../src/store');
  const sinces = [];
  const prev = S.pullOrders;
  S.pullOrders = async (since, opts) => { sinces.push(since); return prev(since, opts); };
  scope.run('alpha', () => store.setShopify({ priceBasis: 'exTax', orderFields: 'ordered', ordersCursor: 12345 }));
  await syncShopify('alpha');
  await syncShopify('alpha');
  S.pullOrders = prev;
  assert.equal(sinces[0], null, 'first pull after the upgrade: full backfill');
  assert.ok(sinces[1] > 12345, 'then incremental');
  assert.equal(scope.run('alpha', () => store.load().shopify.orderFields), 'reversals');
});

/* 1.1.5: reversal events with their own dates. A store read by 1.1.3 / 1.1.4 (orderFields 'refunds') reads the backfill
 * once more (older orders reversed in the 60 days too), its events start afresh, and each page's events are stored. */
test('pull: orders read by 1.1.3 (orderFields "refunds") are read again once for reversal events; events stored per order, no doubles', async () => {
  const store = require('../src/store');
  const sinces = [];
  const prev = S.pullOrders;
  const ev = (id, order, t) => ({ id, t, order, variantId: 'v-alpha', qty: 1, value: 100, kind: 'cancel' });
  S.pullOrders = async (since, { onPage }) => {
    sinces.push(since);
    const t = Date.now() - 3600e3;
    await onPage(['#a1'], [{ t, order: '#a1', line: '1', variantId: 'v-alpha', sku: 'x', qty: 0, price: 100, ordered: 1, returned: 1, cancelled: 1 }], Date.now() + sinces.length, { orders: ['#a1', '#old'], events: [ev('r1', '#a1', t), ev('c9', '#old', t)] });
    return { total: 1 };
  };
  scope.run('alpha', () => { store.setShopify({ priceBasis: 'exTax', orderFields: 'refunds', ordersCursor: 12345 }); store.load().reversals = [ev('stale', '#zzz', Date.now())]; });
  await syncShopify('alpha');
  await syncShopify('alpha');   // the same events read again: replaced, never doubled
  S.pullOrders = prev;
  assert.equal(sinces[0], null, 'first pull after the upgrade: full backfill');
  assert.ok(sinces[1] > 12345, 'then incremental');
  const d = scope.run('alpha', () => store.load());
  assert.equal(d.shopify.orderFields, 'reversals');
  assert.deepEqual(d.reversals.map((e) => e.id).sort(), ['c9', 'r1'], 'stale events dropped by the re-read; two events, once each');
  assert.deepEqual(d.orders.filter((o) => o.order === '#old'), [], 'the older order gives events only, no lines');
});
