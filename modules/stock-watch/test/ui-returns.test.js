'use strict';
/*
 * SW-064 in the browser: Products "Returns %" column (amber at 15%+), the "High returns" chip, the drawer's Returned line.
 * 1440x900 and 390x844: no sideways page scroll. Needs Playwright (PLAYWRIGHT_PATH; PLAYWRIGHT_CHANNEL=chrome); skipped without it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pw = null;
try { pw = require(process.env.PLAYWRIGHT_PATH || 'playwright'); } catch { /* not installed: skip */ }
const opts = { skip: pw ? false : 'Playwright not found (set PLAYWRIGHT_PATH)' };

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-ui-returns-'));
for (const k of ['ADMIN_PASSWORD', 'VIEW_PASSWORD', 'SHOPIFY_STORE', 'STORES', 'PERFORMITY_POC_API_URL', 'PERFORMITY_POC_API_KEY']) delete process.env[k];
const { server } = require('../server');

let base, browser;
test.before(async () => {
  if (!pw) return;
  await new Promise((ok) => server.listen(0, ok));
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/demo?store=sammsara-demo`, { method: 'POST' })).status, 200);
  browser = await pw.chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {});
});
test.after(async () => { if (browser) await browser.close(); if (server.listening) await new Promise((ok) => server.close(ok)); });

async function open(width, height, url, ready) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const pg = await ctx.newPage();
  pg.errors = []; pg.on('pageerror', (e) => pg.errors.push(e.message));
  await pg.goto(base + url); await pg.waitForSelector(ready);
  return pg;
}
const sideways = (pg) => pg.evaluate(() => document.documentElement.scrollWidth - innerWidth);

test('1440: Returns % column (amber at 15%+), High returns chip, drawer line', opts, async () => {
  const pg = await open(1440, 900, '/?store=sammsara-demo#products', '#view th[data-k="returnPct"]');
  assert.ok(await pg.$('#view td .amberv'), 'a high-return row is amber');
  await pg.click('[data-filter-products="returns"]');
  await pg.waitForSelector('[data-filter-products="returns"].on');
  const cells = await pg.$$eval('#view table tbody tr', (rows) => rows.map((r) => r.cells[[...r.closest('table').tHead.rows[0].cells].findIndex((c) => c.dataset.k === 'returnPct')]?.textContent));
  assert.ok(cells.length > 0 && cells.every((c) => parseFloat(c) >= 15), `every row 15%+: ${cells.join(' ')}`);
  await pg.click('#view table tbody tr');
  await pg.waitForSelector('#returns-tile');
  assert.match(await pg.textContent('#returns-tile'), /^Cancelled or refunded[\d.]+%last 30 days: [\d,]+ of [\d,]+ ordered(, [\d,]+ cancelled)? · ₹.+ back$/);   // 1.4.1: a key number in the profile
  assert.equal(await sideways(pg), 0);
  assert.deepEqual(pg.errors, []);
});

/* 1.1.5: the period's calendar dates beside the Period buttons; Data → "Check against Shopify" once reversal events exist */
test('1440: period dates next to the buttons; Data shows the Shopify net sales check', opts, async () => {
  const scope = require('../src/scope'), store = require('../src/store'), TZ = require('../src/tz');
  const now = Date.now(), zone = 'Asia/Kolkata';
  scope.run('sammsara-demo', () => { const d = store.load(); const o = d.orders.find((x) => x.t > now - 3 * 864e5); d.reversals = [{ id: 'r1', t: now - 3600e3, order: o.order, variantId: String(o.variantId), qty: 1, value: 1234, kind: 'refund' }]; });
  const pg = await open(1440, 900, '/?store=sammsara-demo#overview', '#view .headline h1');
  const fmt = (t) => { const k = TZ.dayKey(t, zone).split('-'); return `${+k[2]} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+k[1] - 1]}`; };
  assert.equal(await pg.textContent('#rdates'), `${fmt(TZ.daysStart(now, 30, zone))} – ${fmt(now)}`, '30 days = today and the 29 days before');
  await pg.click('.range button[data-days="7"]');
  await pg.waitForFunction((t) => document.querySelector('#rdates').textContent === t, `${fmt(TZ.daysStart(now, 7, zone))} – ${fmt(now)}`);
  assert.ok(await pg.isVisible('#rdates'));
  await pg.goto(`${base}/?store=sammsara-demo#data`); await pg.waitForSelector('#shopify-check');
  assert.match(await pg.textContent('#shopify-check'), /^Check against Shopify · net sales \d+ \w{3} – \d+ \w{3}: ₹[\d,]+ \(₹[\d,]+ ordered − ₹1,234 cancelled\/refunded on these days\)\. Shopify: Analytics → Net sales, same dates\.$/);
  assert.equal(await sideways(pg), 0);
  assert.deepEqual(pg.errors, []);
  scope.run('sammsara-demo', () => { delete store.load().reversals; });
});

test('390: chip there, high-return cards say so, no sideways scroll', opts, async () => {
  const pg = await open(390, 844, '/?store=sammsara-demo#products', '[data-filter-products="returns"]');
  await pg.click('[data-filter-products="returns"]');
  await pg.waitForSelector('[data-filter-products="returns"].on');
  assert.match(await pg.textContent('.mcard .mfacts'), /% cancelled\/refunded/);
  assert.equal(await sideways(pg), 0);
  assert.deepEqual(pg.errors, []);
});
