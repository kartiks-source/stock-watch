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
  assert.ok(j.products.filter((p) => !p.best && !(p.lost > 0)).every((p) => p.months === undefined), 'months for best sellers and products with money missed unless full=1');
  for (const k of ['best', 'all']) {   // 1.4.4: both scopes, headline = sum of the months
    assert.equal(j.headline[k].lost, j.months.reduce((s, m) => s + m[k].lost, 0), k);
    assert.ok(Math.abs(j.headline[k].total - (j.headline[k].lost + j.headline[k].est + j.headline[k].nr + j.headline[k].apart)) <= 24, `${k}: counted + apart parts = all (rounding)`);
  }
  assert.ok(j.headline.all.lost >= j.headline.best.lost);
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
  assert.equal(d.profile.ok, true, JSON.stringify(d.profile).slice(0, 200));
  assert.ok(d.profile.calendar.length > 30 && d.profile.calendar.every(([k, f]) => /^\d{4}-\d\d-\d\d$/.test(k) && [0, 0.5, 1].includes(f)));
  assert.equal(d.profile.months.length, 12);
  assert.ok(d.profile.rank && d.profile.rank.n >= 1 && d.profile.rank.of >= d.profile.rank.n);
  assert.ok(d.profile.details && Array.isArray(d.profile.details.tags));
  assert.ok(d.profile.ms < 1500, `fast: ${d.profile.ms} ms`);
  const r = await fetch(`${base}/api/shopify/year?store=sammsara-demo`, { method: 'POST' });
  assert.equal(r.status, 400);
});

test('a year.json from Shopify is preferred over the rows held', async () => {
  const scope = require('../src/scope'), store = require('../src/store');
  const d = scope.run('sammsara-demo', () => store.load());
  const id = String(d.stock[0].variantId), today = new Date(Date.now() + 330 * 60e3).toISOString().slice(0, 10);
  const y = { v: require('../src/year').VERSION, zone: 'Asia/Kolkata', days: 400, at: Date.now(), ok: true, done: true, anchor: { at: Date.now(), day: today, levels: { [id]: 0 } },
    sales: { from: '2026-01-01', to: '2026-12-31', by: { [id]: { '2026-02-02': [3, 300] } }, all: { '2026-02-02': [3, 300] } }, moves: { from: '2026-01-01', to: '2026-12-31', by: { [id]: { '2026-03-01': -5 } } } };
  scope.run('sammsara-demo', () => require('../src/year').save(y));   // through the side file, so its cache holds it
  const j = await get('/api/brand');
  assert.equal(j.basis, 'shopify');
  assert.equal(j.span.from, '2026-01-01');
});

/* 1.4.3: speed. The report, the 12-month build and the brand report are kept per store version (src/cache.js): a second
   product open doesn't work out the store again; answers are gzipped. */
test('perf: a warm /api/product answers fast; Mark ordered (a write) refreshes it; JSON is gzipped', async () => {
  const b = await get('/api/brand');
  const id = b.now[0].id;
  const t = async () => { const t0 = performance.now(); const j = await get(`/api/product/${id}?days=30`); return [performance.now() - t0, j]; };
  const [cold, j1] = await t();
  const [warm, j2] = await t();
  const [warm2] = await t();
  console.log(`perf demo: /api/product cold ${cold.toFixed(0)} ms, warm ${warm.toFixed(0)} / ${warm2.toFixed(0)} ms`);
  assert.ok(Math.min(warm, warm2) < 100, `warm ${warm.toFixed(0)} ms`);
  assert.equal(j1.rev, j2.rev, 'same data version');
  await fetch(`${base}/api/onorder?store=sammsara-demo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ id, qty: 3, eta: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10) }] }) });
  const [, j3] = await t();
  assert.ok(j3.rev > j2.rev, 'a write bumps the version');
  assert.ok(j3.product.onOrder, 'and the answer is worked out again');
  const raw = await new Promise((ok, no) => require('node:http').get(`${base}/api/report?days=30&store=sammsara-demo`, { headers: { 'accept-encoding': 'gzip' } }, (r) => { r.resume(); ok(r.headers); }).on('error', no));
  assert.equal(raw['content-encoding'], 'gzip');
});
