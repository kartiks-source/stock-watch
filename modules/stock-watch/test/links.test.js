'use strict';
/* 1.4.0 (LOGIC §19): product picture and links from the catalog (src/links.js, src/shopify.js productLinks). */
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/links');
const S = require('../src/shopify');

const shop = { domain: 'sammsara.myshopify.com', web: 'https://www.sammsara.com' };

test('stock query reads picture, handle and website address; only Shopify CDN pictures and https links are kept', () => {
  assert.ok(S.IMG_PX >= 96 && S.IMG_PX <= 400, 'a small picture');
  const pr = { handle: 'chess-set', onlineStoreUrl: 'https://www.sammsara.com/products/chess-set', publishedAt: '2020-01-01T00:00:00Z', featuredMedia: { preview: { image: { url: 'https://cdn.shopify.com/s/files/1/x_320x.jpg?v=1' } } } };
  assert.deepEqual(S.productLinks(pr), { image: 'https://cdn.shopify.com/s/files/1/x_320x.jpg?v=1', handle: 'chess-set', web: 'https://www.sammsara.com/products/chess-set', published: true });
  assert.deepEqual(S.productLinks({ handle: 'a b', onlineStoreUrl: 'javascript:alert(1)', featuredMedia: { preview: { image: { url: 'https://evil.example/x.jpg' } } } }), {});
  assert.deepEqual(S.productLinks(null), {});
});

test('the catalog row keeps the picture and links (diffStock)', () => {
  const v = { id: 'gid://shopify/ProductVariant/7', sku: 'S7', title: 'Default Title', price: '10', inventoryQuantity: 2, inventoryItem: { tracked: true },
    product: { id: 'gid://shopify/Product/70', title: 'Vase', status: 'ACTIVE', handle: 'vase', onlineStoreUrl: null, publishedAt: '2024-01-01', featuredMedia: { preview: { image: { url: 'https://cdn.shopify.com/v.jpg' } } } } };
  const c = S.diffStock([v], {}, 1).catalog['7'];
  assert.equal(c.image, 'https://cdn.shopify.com/v.jpg'); assert.equal(c.handle, 'vase'); assert.equal(c.published, true); assert.equal(c.web, undefined);
});

test('admin link = admin.shopify.com/store/<shop handle>/products/<product ID>; website = onlineStoreUrl, else domain/products/<handle>, else Not on website', () => {
  const on = L.of({ productId: '70', image: 'https://cdn.shopify.com/v.jpg', handle: 'vase', web: 'https://www.sammsara.com/products/vase', status: 'ACTIVE' }, shop);
  assert.deepEqual(on, { productId: '70', image: 'https://cdn.shopify.com/v.jpg', adminUrl: 'https://admin.shopify.com/store/sammsara/products/70', webUrl: 'https://www.sammsara.com/products/vase' });
  assert.equal(L.of({ productId: '70', handle: 'vase', published: true, status: 'ACTIVE' }, shop).webUrl, 'https://www.sammsara.com/products/vase');
  const draft = L.of({ productId: '71', handle: 'old', status: 'DRAFT' }, shop);
  assert.strictEqual(draft.webUrl, null, 'a draft is not on the website');
  assert.strictEqual(L.of({ productId: '72', handle: 'x', published: true, status: 'ARCHIVED' }, shop).webUrl, null);
  assert.equal(L.of({ productId: '70' }, { handle: 'brand' }).adminUrl, 'https://admin.shopify.com/store/brand/products/70', 'the shop handle from the key source works too');
  assert.equal(L.of({ productId: 'gid://x' }, shop).adminUrl, undefined, 'only numeric product IDs');
  assert.equal(L.of({ productId: '70', image: 'http://cdn.shopify.com/x.jpg' }, shop).image, undefined, 'https CDN only');
});

test('annotate adds links to report rows by variant ID; rows without a catalog entry stay as they are', () => {
  const rows = [{ id: '7', name: 'Vase' }, { id: '8', name: 'Demo' }];
  L.annotateReport({ products: rows, reorder: [rows[0]], stockouts: [{ id: '7' }] }, { 7: { productId: '70', image: 'https://cdn.shopify.com/v.jpg', status: 'ACTIVE' } }, shop);
  assert.equal(rows[0].adminUrl, 'https://admin.shopify.com/store/sammsara/products/70');
  assert.equal(rows[0].image, 'https://cdn.shopify.com/v.jpg');
  assert.deepEqual(rows[1], { id: '8', name: 'Demo' });
});

test('shop info: domain and primary domain, never fails a pull', async () => {
  assert.deepEqual(await S.shopInfo(async () => ({ shop: { myshopifyDomain: 'Sammsara.myshopify.com', primaryDomain: { url: 'https://www.sammsara.com/' } } })), shop);
  assert.deepEqual(await S.shopInfo(async () => ({ shop: { myshopifyDomain: 'x.com', primaryDomain: { url: 'http://x' } } })), { domain: null, web: null });
  assert.equal(await S.shopInfo(async () => { throw new Error('no'); }), null);
  assert.doesNotThrow(() => S.assertReadOnly(S.SHOP_Q));
});
