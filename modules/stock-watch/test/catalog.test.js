'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../src/catalog');
const S = require('../src/shopify');
const demo = require('../src/demo');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-cat-')), 'catalog.json');
const gid = (kind, id) => `gid://shopify/${kind}/${id}`;

/* a fake store: 3 collections, the second with 3 pages of products; every call checked by the read-only guard */
function fakeShop({ failAt = -1 } = {}) {
  const calls = [];
  const cols = [{ id: 1, title: 'All products', products: [10, 11, 12] }, { id: 2, title: 'Gold', products: [10, 11, 12, 13, 14] }, { id: 3, title: 'Empty', products: [] }];
  const q = async (doc, vars) => {
    S.assertReadOnly(doc);
    calls.push(vars);
    if (calls.length - 1 === failAt) throw new Error('Shopify: HTTP 502');
    if (/collections\(/.test(doc)) {
      const start = vars.after ? +vars.after : 0; const page = cols.slice(start, start + 2);
      return { collections: { nodes: page.map((c) => ({ id: gid('Collection', c.id), title: c.title })), pageInfo: { hasNextPage: start + 2 < cols.length, endCursor: String(start + 2) } } };
    }
    const c = cols.find((x) => gid('Collection', x.id) === vars.id);
    const start = vars.after ? +vars.after : 0; const page = c.products.slice(start, start + 2);
    return { collection: { products: { nodes: page.map((p) => ({ id: gid('Product', p) })), pageInfo: { hasNextPage: start + 2 < c.products.length, endCursor: String(start + 2) } } } };
  };
  return { q, calls };
}

test('collections: every page read, members keyed by ID, cached for 24 h', async () => {
  C.use(tmp());
  const f = fakeShop();
  const r = await C.refreshCollections({ q: f.q, now: 1000 });
  assert.equal(r.collections, 3);
  assert.deepEqual(C.load().collections, { 1: { title: 'All products', productIds: ['10', '11', '12'] }, 2: { title: 'Gold', productIds: ['10', '11', '12', '13', '14'] }, 3: { title: 'Empty', productIds: [] } });
  const n = f.calls.length;
  assert.deepEqual(await C.refreshCollections({ q: f.q, now: 1000 + C.TTL - 1 }), { skipped: true });
  assert.equal(f.calls.length, n, 'nothing sent while fresh');
  await C.refreshCollections({ q: f.q, now: 1000 + C.TTL });
  assert.equal(f.calls.length, 2 * n, 're-read after 24 h');
});

test('collections: a failed read resumes from the saved page, not from the start', async () => {
  const file = tmp(); C.use(file);
  const f = fakeShop({ failAt: 4 });                 // list (2 pages), col 1 (2 pages), then col 2 page 1 fails
  await assert.rejects(C.refreshCollections({ q: f.q, now: 5 }), /502/);
  assert.equal(C.load().lastError, 'Shopify: HTTP 502');
  C.use(file);                                       // as after a restart: only what's on disk
  const g = fakeShop();
  await C.refreshCollections({ q: g.q, now: 6 });
  assert.equal(g.calls[0].id, gid('Collection', 2), 'carries on with the collection that failed');
  assert.equal(g.calls.length, 3 + 1, 'collection 2 (3 pages) + collection 3');
  assert.deepEqual(C.load().collections[2].productIds, ['10', '11', '12', '13', '14']);
  assert.equal(C.load().pending, null); assert.equal(C.load().lastError, null);
});

test('collections: a page budget stops early and the next run finishes', async () => {
  C.use(tmp());
  const f = fakeShop();
  assert.deepEqual(await C.refreshCollections({ q: f.q, now: 7, maxPages: 3 }), { partial: true });
  assert.ok(C.load().pending);
  const r = await C.refreshCollections({ q: f.q, now: 8, maxPages: 3 });
  assert.ok(r.partial || r.collections);
  while (C.load().pending) await C.refreshCollections({ q: f.q, now: 9, maxPages: 3 });
  assert.equal(Object.keys(C.load().collections).length, 3);
});

test('catalog queries are read-only', () => {
  for (const d of [C.COLLECTIONS_Q, C.MEMBERS_Q]) assert.doesNotThrow(() => S.assertReadOnly(d));
  const src = fs.readFileSync(require.resolve('../src/catalog'), 'utf8');
  assert.ok(!/mutation/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'no mutation anywhere in catalog.js');
});

test('variants come from the store catalog snapshot (SW-002): product ID and tags read by the stock pull', async () => {
  const node = { id: gid('ProductVariant', 7), sku: 'A', title: 'Default Title', price: '10', inventoryQuantity: 3, inventoryItem: { tracked: true }, product: { id: gid('Product', 70), title: 'Vase', status: 'ACTIVE', productType: 'Vases', tags: ['Gold', 'Diwali'] } };
  const s = await S.pullStock({}, { now: 123, q: async (doc) => { if (/query Shop/.test(doc)) return { shop: { myshopifyDomain: 'vase.myshopify.com', primaryDomain: { url: 'https://vase.example' } } }; assert.match(doc, /product \{ id title status productType tags vendor handle/); return { productVariants: { nodes: [node], pageInfo: { hasNextPage: false } } }; } });
  assert.deepEqual(s.shop, { domain: 'vase.myshopify.com', web: 'https://vase.example' });
  assert.deepEqual(C.fromSnapshot(s.catalog), { variants: { 7: { productId: '70', product: 'Vase', type: 'Vases', tags: ['Gold', 'Diwali'] } }, variantsAt: 123 });
  C.use(tmp());
  const c = C.current('live', s.catalog);
  assert.equal(c.variants[7].productId, '70'); assert.equal(c.variantsAt, 123);
  assert.deepEqual(C.load().variants, {}, 'no second copy of the variants in catalog.json');
});

test('demo catalog: every demo variant has a product ID, tags and collections; one catch-all', () => {
  const g = demo.generate({ now: Date.parse('2026-11-19T06:00:00Z') });
  const c = C.current('demo');
  const ids = new Set(g.stock.map((r) => r.variantId));
  for (const id of ids) { assert.ok(c.variants[id]?.productId, id); assert.ok(c.variants[id].tags.length, id); }
  const products = new Set(Object.values(c.variants).map((v) => v.productId));
  assert.ok(products.size < ids.size, 'some products have several variants');
  const big = Object.values(c.collections).filter((x) => x.productIds.length >= 0.8 * products.size);
  assert.deepEqual(big.map((x) => x.title), ['All products']);
  assert.ok(Object.keys(c.collections).length >= 8);
  assert.equal(C.info(c).demo, true);
});
