'use strict';
/*
 * SW-045 in the browser: Data → Upload a CSV. Choosing a Shopify orders export shows its kind, the mapping as selects and
 * the first 5 rows as read; changing a select previews again; Upload sends ?map= and imports. A file with a needed column
 * unmapped is stopped on the page. 1440 and 390: no sideways scroll, 44 px selects. Skipped without Playwright.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pw = null;
try { pw = require(process.env.PLAYWRIGHT_PATH || 'playwright'); } catch { /* not installed: skip */ }
const opts = { skip: pw ? false : 'Playwright not found (set PLAYWRIGHT_PATH)' };

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-ui-import-'));
for (const k of ['ADMIN_PASSWORD', 'VIEW_PASSWORD', 'SHOPIFY_STORE', 'STORES', 'PERFORMITY_POC_API_URL', 'PERFORMITY_POC_API_KEY']) delete process.env[k];
const { server } = require('../server');

const ordersCsv = () => {   // Shopify dates moved so the newest is yesterday (rows older than 120 days are skipped)
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'shopify-orders.csv'), 'utf8');
  const shift = Date.now() - 864e5 - Date.parse('2026-11-19T23:59:00+05:30');
  return text.replace(/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \+0530/g, (_, d, t) => new Date(Date.parse(`${d}T${t}+05:30`) + shift).toISOString());
};
let base, browser;
test.before(async () => {
  if (!pw) return;
  await new Promise((ok) => server.listen(0, ok));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await pw.chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}); { const nc = browser.newContext.bind(browser); browser.newContext = async (o) => { const c = await nc(o); await c.addInitScript(() => { try { sessionStorage.setItem('sw-owner', '1'); } catch { /* */ } }); return c; }; }   // 1.5.0: these pages are the brand owner's (public/agency.js)
});
test.after(async () => { if (browser) await browser.close(); if (server.listening) await new Promise((ok) => server.close(ok)); });

async function openData(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const pg = await ctx.newPage();
  pg.errors = []; pg.on('pageerror', (e) => pg.errors.push(e.message));
  pg.calls = []; pg.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/import')) pg.calls.push(u); });
  await pg.goto(base + '/#data'); await pg.waitForSelector('#imp-go', { state: 'attached' });
  await pg.$$eval('details.panel.fold', (ds) => ds.forEach((d) => { if (d.querySelector('#imp-go')) d.open = true; }));
  return pg;
}
const sideways = (pg) => pg.evaluate(() => document.documentElement.scrollWidth - innerWidth);

test('1440: Shopify orders export → preview + mapping; change a select; Upload imports with ?map=', opts, async () => {
  const pg = await openData(1440, 900);
  await pg.setInputFiles('#imp-file', { name: 'orders_export.csv', mimeType: 'text/csv', buffer: Buffer.from(ordersCsv()) });
  await pg.waitForSelector('.imp-pv');
  assert.match(await pg.textContent('.imp-what'), /Shopify orders export · order lines · 79 columns/);
  assert.equal(await pg.$eval('#imp-kind', (s) => s.value), 'order');
  assert.equal(await pg.$eval('[data-imp-col="sku"]', (s) => s.value), 'Lineitem sku');
  assert.equal(await pg.$$eval('.imp-sample tbody tr', (r) => r.length), 5);
  assert.match(await pg.textContent('.imp-sample tbody tr:first-child'), /₹13,999/, 'price after the line discount');
  assert.equal(await pg.$$eval('.imp-sample tr.imp-skip', (r) => r.length), 1, 'the voided order shown as left out');
  assert.equal(await sideways(pg), 0);

  await pg.selectOption('[data-imp-col="line discount"]', '');
  await pg.waitForFunction(() => /₹14,999/.test(document.querySelector('.imp-sample tbody tr:first-child').textContent));
  await pg.click('#imp-go');
  await pg.waitForFunction(() => /Read 5 rows/.test(document.querySelector('#toast').textContent));
  const imp = pg.calls.find((u) => u.pathname === '/api/import');
  assert.equal(imp.searchParams.get('kind'), 'order');
  assert.equal(JSON.parse(imp.searchParams.get('map'))['line discount'], '');
  assert.deepEqual(pg.errors, []);
  await pg.context().close();
});

test('390: unknown file → needed columns flagged, Upload stopped on the page; selects 44 px; no sideways scroll', opts, async () => {
  const pg = await openData(390, 844);
  const day = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
  await pg.setInputFiles('#imp-file', { name: 'stock.csv', mimeType: 'text/csv', buffer: Buffer.from(`Date;Item code;On hand\n${day};AB-1;7\n`) });
  await pg.waitForSelector('#imp-missing');
  assert.match(await pg.textContent('#imp-missing'), /Variant ID, Stock now/);
  const n = pg.calls.length;
  await pg.click('#imp-go');
  assert.equal(pg.calls.length, n, 'nothing sent while a needed column is unmapped');
  const h = await pg.$eval('[data-imp-col="time"]', (s) => s.getBoundingClientRect().height);
  assert.ok(h >= 44, `select ${h}px`);
  await pg.selectOption('[data-imp-col="variant id"]', '@sku');
  await pg.waitForSelector('#imp-missing');   // still Stock now
  await pg.selectOption('[data-imp-col="sku"]', 'Item code');
  await pg.waitForFunction(() => /Stock now/.test(document.querySelector('#imp-missing')?.textContent || '') && !/Variant ID/.test(document.querySelector('#imp-missing').textContent));
  await pg.selectOption('[data-imp-col="stock now"]', 'On hand');
  await pg.waitForFunction(() => !document.querySelector('#imp-missing') && document.querySelector('.imp-sample .st.ok'));
  assert.equal(await sideways(pg), 0);
  await pg.click('#imp-go');
  await pg.waitForFunction(() => /Read 1 rows/.test(document.querySelector('#toast').textContent));
  assert.deepEqual(pg.errors, []);
  await pg.context().close();
});
