'use strict';
/* 1.4.0: GET /api/brand on demo data (rows held), the drawer's year, POST /api/shopify/year without Shopify, the product
   year in /api/product, a planted year.json is preferred over the rows (LOGIC §20–§23). Real server, temp DATA_DIR. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-brand-api-'));
for (const k of ['ADMIN_PASSWORD', 'VIEW_PASSWORD', 'SHOPIFY_STORE', 'STORES', 'PERFORMITY_POC_API_URL', 'PERFORMITY_POC_API_KEY', 'AZURE_KEY_VAULT_URL']) delete process.env[k];
const { server } = require('../server');
let base;
test.before(async () => {
  await new Promise((ok) => server.listen(0, ok));
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/demo?store=sammsara-demo`, { method: 'POST' })).status, 200);
});
test.after(() => new Promise((ok) => server.close(ok)));
const get = async (p) => (await fetch(`${base}${p}${p.includes('?') ? '&' : '?'}store=sammsara-demo`)).json();

test('GET /api/brand on demo: rows held, 12 months, headline = sum of months, best sellers now and ads', async () => {
  const j = await get('/api/brand');
  assert.equal(j.ok, true); assert.equal(j.basis, 'rows');
  assert.equal(j.months.length, 12);
  assert.equal(j.headline.lost, j.months.reduce((s, m) => s + m.lost, 0));
  assert.equal(j.headline.sold, j.months.reduce((s, m) => s + m.sold, 0));
  assert.ok(j.products.some((p) => p.best));
  assert.ok(j.products.filter((p) => !p.best).every((p) => p.months === undefined), 'months only for best sellers unless full=1');
  assert.ok(Array.isArray(j.now) && j.now.every((p) => p.best));
  assert.ok(Array.isArray(j.ads.push) && Array.isArray(j.ads.pause));
  for (const p of j.ads.push) assert.ok(p.stock > 0 && p.coverDays >= j.ads.coverDays, p.name);
  const full = await get('/api/brand?full=1');
  assert.ok(full.products.every((p) => p.months && p.variantPace), 'full=1 keeps every product’s months');
});

test('GET /api/product/:id carries the variant’s year; POST /api/shopify/year needs Shopify', async () => {
  const b = await get('/api/brand');
  const id = b.now[0].id;
  const d = await get(`/api/product/${id}`);
  assert.equal(d.year.ok, true);
  assert.ok(d.year.calendar.length > 30 && d.year.calendar.every(([k, f]) => /^\d{4}-\d\d-\d\d$/.test(k) && [0, 0.5, 1].includes(f)));
  const r = await fetch(`${base}/api/shopify/year?store=sammsara-demo`, { method: 'POST' });
  assert.equal(r.status, 400);
});

test('a year.json from Shopify is preferred over the rows held', async () => {
  const scope = require('../src/scope'), store = require('../src/store');
  const d = scope.run('sammsara-demo', () => store.load());
  const id = String(d.stock[0].variantId), today = new Date(Date.now() + 330 * 60e3).toISOString().slice(0, 10);
  const y = { v: 1, zone: 'Asia/Kolkata', days: 365, at: Date.now(), ok: true, done: true, anchor: { at: Date.now(), day: today, levels: { [id]: 0 } },
    sales: { from: '2026-01-01', to: '2026-12-31', by: { [id]: { '2026-02-02': [3, 300] } }, all: { '2026-02-02': [3, 300] } }, moves: { from: '2026-01-01', to: '2026-12-31', by: { [id]: { '2026-03-01': -5 } } } };
  scope.run('sammsara-demo', () => require('../src/year').save(y));   // through the side file, so its cache holds it
  const j = await get('/api/brand');
  assert.equal(j.basis, 'shopify');
  assert.equal(j.span.from, '2026-01-01');
});
