'use strict';
/*
 * 1.4.0 in the browser (LOGIC §19–§23): the Brand report is home (headline sentence, month chart, month table → month
 * list, best seller × month grid, CSV), Best sellers now, Ads push / pause, the drawer's 12 months, the product cell
 * (picture left, name + code, Shopify / website links). 1440x900 and 390x844: no sideways page scroll.
 * Demo data (the brand report falls back to the rows held). Needs Playwright (PLAYWRIGHT_PATH; PLAYWRIGHT_CHANNEL=chrome).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pw = null;
try { pw = require(process.env.PLAYWRIGHT_PATH || 'playwright'); } catch { /* not installed: skip */ }
const opts = { skip: pw ? false : 'Playwright not found (set PLAYWRIGHT_PATH)' };

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-ui-brand-'));
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
  const ctx = await browser.newContext({ viewport: { width, height }, acceptDownloads: true });
  const pg = await ctx.newPage();
  pg.errors = []; pg.on('pageerror', (e) => pg.errors.push(e.message));
  await pg.goto(base + url); await pg.waitForSelector(ready);
  return pg;
}
const sideways = (pg) => pg.evaluate(() => document.documentElement.scrollWidth - innerWidth);

test('1440: the Brand report is home: headline sentence with dates, chart, month table, grid, month list, CSV', opts, async () => {
  const pg = await open(1440, 900, '/?store=sammsara-demo', '#view .brand-h h1');
  assert.equal(await pg.getAttribute('#tabs a.on', 'data-view'), 'brand');
  assert.deepEqual(await pg.$$eval('#tabs a .rl', (a) => a.map((x) => x.textContent)), ['Brand report', 'Best sellers now', 'Ads: push / pause', 'Restock list', 'All products']);
  assert.match(await pg.textContent('.brand-h h1'), /^Best sellers ran out on [\d,]+ days (in the last 12 months|since \d+ \w{3} \d{4})\.$/);
  assert.match(await pg.textContent('.brand-h .lead'), /^Money we missed: about ₹[\d.,]+( lakh| Cr|k)?\. That is [\d.]+% of what the brand sold \(₹.+\), \d+ \w{3}( \d{4})? – \d+ \w{3} \d{4}\.$/);
  assert.match(await pg.textContent('.brand-h .small'), /Sales up to \d+ \w{3} \d{4}; stock read/);
  assert.ok(await pg.isHidden('.top .range'), 'the period buttons step aside: 12 months');
  assert.ok(await pg.$('#brand-chart svg .mb'), 'month bars');
  const months = await pg.$$eval('.mtable tbody tr', (r) => r.map((x) => x.dataset.month));
  assert.ok(months.length >= 2, months.join());
  /* the month total is the sum of the rows (the page shows the server's numbers) */
  const j = await (await fetch(`${base}/api/brand?store=sammsara-demo`)).json();
  assert.equal(j.headline.lost, j.months.reduce((s, m) => s + m.lost, 0));
  /* click a month → its list */
  await pg.click(`.mtable tbody tr[data-month="${months[1]}"]`);
  await pg.waitForSelector(`.mtable tbody tr.on[data-month="${months[1]}"]`);
  assert.match(await pg.textContent('#month-detail h2'), /^\w+ \d{4}: (\d+ best sellers? ran out\. We missed about ₹.+\.|no best seller ran out\.)$/);
  const row = await pg.$('#month-detail tbody tr');
  if (row) {
    assert.ok(await row.$('.prod .thumb'), 'picture (or its box) on the left');
    assert.ok(await row.$('.prod .psku'), 'product code under the name');
    assert.match(await row.textContent(), /about (under 1|\d+)/);
  }
  assert.ok(await pg.$('.heat .hrow .hc'), 'best seller × month grid');
  const [dl] = await Promise.all([pg.waitForEvent('download'), pg.click('#csv-months')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  assert.match(csv, /^﻿?"Month","From","To","Sold ₹ \(net, ex GST\)","Missed ₹ \(best sellers\)"/);
  const [dl2] = await Promise.all([pg.waitForEvent('download'), pg.click('#csv-month')]);
  assert.match(fs.readFileSync(await dl2.path(), 'utf8'), /"Out-of-stock dates".*"Shopify admin link","Website link"/);
  for (const w of [1280, 1920]) { await pg.setViewportSize({ width: w, height: 900 }); await pg.waitForTimeout(150); assert.equal(await sideways(pg), 0, `${w}: no sideways scroll`); }
  await pg.setViewportSize({ width: 1440, height: 900 });
  assert.equal(await sideways(pg), 0);
  assert.deepEqual(pg.errors, []);
});

test('1440: Best sellers now, Ads push / pause, drawer with 12 months on the shelf', opts, async () => {
  const pg = await open(1440, 900, '/?store=sammsara-demo#best', '#view table[data-table="best"] tbody tr');
  assert.match(await pg.textContent('#view .headline h1'), /^(\d+ of \d+ best sellers are out right now\.|All \d+ best sellers are in stock\.)$/);
  assert.match(await pg.textContent('#view .headline p'), /This month so far \(\d+ \w{3} – \d+ \w{3} \d{4}\)|Nothing missed this month so far/);
  const first = await pg.textContent('#view table[data-table="best"] tbody tr td:nth-child(2)');
  assert.match(first, /^(Out( since \d+ \w{3})?|In stock · [\d,]+)/);
  await pg.click('#view table[data-table="best"] tbody tr');
  await pg.waitForSelector('#drawer .phero');
  await pg.waitForSelector('#drawer .ycal .cal .cd');
  assert.match(await pg.textContent('#drawer .kgrid'), /Sells, on days in stock.+ a day · [\d,.]+ a week · [\d,]+ a month/);   // 1.4.1: the pace sits in the key numbers
  await pg.keyboard.press('Escape');
  await pg.goto(base + '/?store=sammsara-demo#ads'); await pg.waitForSelector('.ads2 .arow');
  assert.match(await pg.textContent('#view .headline h1'), /^Push \d+ in stock\. Pause \d+: \d+ out, \d+ about to run out\.$/);
  assert.ok((await pg.$$('.ads2 .panel:first-child .arow')).length > 0);
  assert.match(await pg.textContent('.ads2 .panel:first-child .arow .af small'), /\d+ weeks of stock/);
  const [dl] = await Promise.all([pg.waitForEvent('download'), pg.click('[data-ads-csv="push"]')]);
  assert.match(fs.readFileSync(await dl.path(), 'utf8'), /"Weeks of stock".*"Shopify admin link","Website link"/);
  assert.equal(await sideways(pg), 0);
  assert.deepEqual(pg.errors, []);
});

test('product cell: picture left (lazy, alt = name), code, Open in Shopify / View on website in a new tab; Not on website; a plain box without a picture', opts, async () => {
  const pg = await open(1440, 900, '/?store=sammsara-demo#brand', '#view .brand-h h1');
  const r = await pg.evaluate(() => {
    const box = document.createElement('div');
    box.innerHTML = SW_PROD.cell({ name: 'Oakwood Table Set of 2', sku: 'SAM-1', image: 'https://cdn.shopify.com/s/x.jpg', adminUrl: 'https://admin.shopify.com/store/sammsara/products/1', webUrl: 'https://www.sammsara.com/products/oak' })
      + SW_PROD.cell({ name: 'Draft', sku: 'D', image: 'https://evil.example/x.jpg', adminUrl: 'https://admin.shopify.com/store/sammsara/products/2', webUrl: null });
    document.body.append(box);
    const [a, b] = box.querySelectorAll('.prod');
    const img = a.querySelector('img.thumb'), links = [...a.querySelectorAll('a.plink')];
    const out = { alt: img.alt, loading: img.loading, first: a.firstElementChild === img, labels: links.map((l) => l.title), targets: links.map((l) => `${l.target} ${l.rel}`), noweb: b.querySelector('.pnoweb')?.textContent, box: !!b.querySelector('.thumb.none'), focus: links[0].tabIndex };
    box.remove();
    return out;
  });
  assert.deepEqual(r, { alt: 'Oakwood Table Set of 2', loading: 'lazy', first: true, labels: ['Open in Shopify', 'View on website'], targets: ['_blank noopener noreferrer', '_blank noopener noreferrer'], noweb: 'Not on website', box: true, focus: 0 });
  assert.deepEqual(pg.errors, []);
});

test('390: Brand report, Best sellers now and Ads usable on a phone, no sideways scroll; short rail names; 44 px links', opts, async () => {
  const pg = await open(390, 844, '/?store=sammsara-demo#brand', '#view .brand-h h1');
  assert.deepEqual(await pg.$$eval('#tabs a .rs', (a) => a.filter((x) => getComputedStyle(x).display !== 'none').map((x) => x.textContent)), ['Report', 'Best sellers', 'Ads', 'Restock', 'Products']);
  assert.equal(await sideways(pg), 0, 'brand');
  const m = await pg.$$eval('.mtable tbody tr', (r) => r.map((x) => x.dataset.month));
  await pg.click(`.mtable tbody tr[data-month="${m[0]}"]`);
  await pg.waitForSelector(`.mtable tbody tr.on[data-month="${m[0]}"]`);
  assert.ok(await pg.$('#month-detail'));
  assert.equal(await sideways(pg), 0, 'brand month');
  for (const [hash, sel] of [['best', '#view .mcard'], ['ads', '.ads2 .arow']]) {
    await pg.goto(`${base}/?store=sammsara-demo#${hash}`); await pg.waitForSelector(sel);
    assert.equal(await sideways(pg), 0, hash);
  }
  const size = await pg.evaluate(() => { const box = document.createElement('div'); box.innerHTML = SW_PROD.cell({ name: 'x', adminUrl: 'https://admin.shopify.com/store/s/products/1' }); document.querySelector('#view').append(box); const r = box.querySelector('a.plink').getBoundingClientRect(); box.remove(); return [r.width, r.height]; });
  assert.deepEqual(size, [44, 44]);
  assert.deepEqual(pg.errors, []);
});

/* 1.4.1 (LOGIC §24): the drawer is the product's 12-month profile; the old 30-day Trend and Stock level cards are gone */
for (const [w, h] of [[1440, 900], [390, 844]]) {
  test(`${w}: product drawer = 12-month profile: header with rank, story, key numbers, charts drawn when scrolled to, calendar, season, details`, opts, async () => {
    const pg = await open(w, h, '/?store=sammsara-demo#best', w < 760 ? '#view .mcard' : '#view table[data-table="best"] tbody tr');
    await pg.click(w < 760 ? '#view .mcard' : '#view table[data-table="best"] tbody tr');
    await pg.waitForSelector('#drawer .pstory');
    assert.match(await pg.textContent('#drawer .prank'), /^#\d+ of \d+ by sales, 12 months$/);
    assert.match(await pg.textContent('#drawer .pstory'), /^Sells about .+ when it is in stock\. (Ran out .+ in all\.|It never ran out .+\.) .*\(\d+ \w{3}.* – \d+ \w{3} \d{4}\)$/);
    const labels = await pg.$$eval('#drawer .kgrid .kv > span', (e) => e.map((x) => x.textContent));
    for (const l of ['Sold, 12 months', 'Sells, on days in stock', 'On the shelf', 'Ran out', 'Money missed', 'Stock now', 'Last restock']) assert.ok(labels.includes(l), `${l} in ${labels}`);
    const heads = await pg.$$eval('#drawer h2', (e) => e.map((x) => x.textContent));
    assert.ok(!heads.includes('Trend'), 'no 30-day Trend card');
    for (const hd of ['12 months: sold and missed', 'Price and discount', 'Every day on the shelf', 'Stock level', 'Busy and quiet months', 'Details']) assert.ok(heads.includes(hd), `${hd} in ${heads}`);
    assert.equal(await pg.$$eval('#drawer .lazy-chart.drawn', (e) => e.length) < 3, true, 'charts wait until they scroll into view');
    await pg.evaluate(async () => { const c = document.querySelector('.drawer-card'); for (let y = 0; y < c.scrollHeight; y += 300) { c.scrollTop = y; await new Promise((r) => setTimeout(r, 50)); } });
    await pg.waitForFunction(() => document.querySelectorAll('#drawer .lazy-chart.drawn svg').length === 3);
    assert.ok(await pg.$('#drawer .pchart .ghost, #drawer .pchart .sold'), 'month bars');
    assert.ok(await pg.$('#drawer .pchart .stl'), 'stock line');
    assert.equal(await sideways(pg), 0, 'no sideways page scroll');
    if (w < 760) assert.ok(await pg.$eval('#drawer .chartbox', (b) => b.scrollWidth >= b.clientWidth), 'a wide chart scrolls inside its card');
    assert.deepEqual(pg.errors, []);
  });
}
