'use strict';
/*
 * Sprint 3 B-review in the browser: the weekly review panel on the Overview (SW-043), targets on group rows (SW-042),
 * paste-a-list + saved lists on Products (SW-044). 1440 and 390, no sideways scroll. Needs Playwright
 * (PLAYWRIGHT_PATH; PLAYWRIGHT_CHANNEL=chrome); skipped without it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pw = null;
try { pw = require(process.env.PLAYWRIGHT_PATH || 'playwright'); } catch { /* not installed: skip */ }
const opts = { skip: pw ? false : 'Playwright not found (set PLAYWRIGHT_PATH)' };

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-ui-review-'));
for (const k of ['ADMIN_PASSWORD', 'VIEW_PASSWORD', 'SHOPIFY_STORE', 'STORES', 'PERFORMITY_POC_API_URL', 'PERFORMITY_POC_API_KEY']) delete process.env[k];
const { server } = require('../server');

let base, browser;
test.before(async () => {
  if (!pw) return;
  await new Promise((ok) => server.listen(0, ok));
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/demo`, { method: 'POST' })).status, 200);
  browser = await pw.chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {});
});
test.after(async () => { if (browser) await browser.close(); if (server.listening) await new Promise((ok) => server.close(ok)); });

async function open(width, height, url) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const pg = await ctx.newPage();
  pg.errors = []; pg.on('pageerror', (e) => pg.errors.push(e.message));
  await pg.goto(base + url); await pg.waitForSelector('#view .headline h1');
  return pg;
}
const sideways = (pg) => pg.evaluate(() => document.documentElement.scrollWidth - innerWidth);

for (const [w, h] of [[1440, 900], [390, 844]]) {
  test(`${w}: weekly panel on Overview; a target on a category row; a pasted list filters Products, saved for the team`, opts, async () => {
    const pg = await open(w, h, '/#overview');
    await pg.waitForSelector('#weekly:not([hidden]) .wk-c');
    /* SIMP-4 (1.1.1): flows only (sales lost, profit lost when costed, stock-outs); end-of-week states left to the headline */
    const labels = await pg.$$eval('#weekly .wk-c > span', (c) => c.map((x) => x.textContent));
    assert.ok(labels.length >= 2 && labels.length <= 3, `flows with deltas: ${labels}`);
    assert.ok(!labels.some((l) => /Still out|Overstock|To reorder|Order today/.test(l)), `no end-of-week states: ${labels}`);
    assert.ok(await pg.$$eval('#weekly .wk-row', (r) => r.length) <= 5, 'top 5 movers at most');
    assert.equal(await sideways(pg), 0);

    const g = (await (await fetch(`${base}/api/groups?lens=type&days=month`)).json()).groups[0];
    assert.equal((await fetch(`${base}/api/targets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lens: 'type', key: g.key, amount: 1e7 }) })).status, 200);
    await pg.goto(`${base}/#products`); await pg.waitForSelector('#f-view');
    await pg.selectOption('#f-view', 'type');
    await pg.waitForSelector(w > 760 ? '.desk .tg-dot.red' : '.mcard .tg-dot.red');
    assert.ok(await pg.$(w > 760 ? '.desk [data-tg-edit]' : '.mcard [data-tg-edit]'), 'admin can set / edit');
    assert.equal(await sideways(pg), 0);

    await pg.selectOption('#f-view', '');
    const skus = (await (await fetch(`${base}/api/report`)).json()).products.slice(0, 3).map((p) => p.sku);
    await pg.fill('#q-products', `${skus.join(', ')}, NOPE-123`);
    await pg.waitForSelector('.lsbar');
    assert.match(await pg.textContent('.lsbar'), /3 of 4 found[\s\S]*1 not found: NOPE-123/);
    await pg.fill('#ls-name', `Test ${w}`);
    await pg.click('#ls-save');
    await pg.waitForFunction((n) => (document.querySelector('#ls-pick')?.textContent || '').includes(n), `Test ${w}`);
    assert.equal(await sideways(pg), 0);
    assert.deepEqual(pg.errors, []);
  });
}

/* 1.2.1: the stale banner follows the server's freshness (staleAfterMin, stale), never a page-side 45 minutes;
 * group-view hovers on This month say "this month" (not "in the last month days"). */
test('1.2.1: stale banner uses staleAfterMin; This month group hovers use the period label', opts, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pg = await ctx.newPage();
  pg.errors = []; pg.on('pageerror', (e) => pg.errors.push(e.message));
  let fresh = null;
  await pg.route(/\/api\/report(\?|$)/, async (route) => {
    const res = await route.fetch(); const j = await res.json();
    if (fresh) j.freshness = { ...fresh(), shopify: true };
    await route.fulfill({ response: res, json: j });
  });
  const banner = () => pg.$eval('#stale', (el) => (el.hidden ? null : el.textContent));
  fresh = () => ({ lastPull: Date.now() - 100 * 60e3, ageMin: 100, stale: false, staleAfterMin: 255 });
  await pg.goto(`${base}/#overview`); await pg.waitForSelector('#view .headline h1');
  assert.equal(await banner(), null, '100 min old at a 255-min threshold: no banner (was shown past 45)');
  fresh = () => ({ lastPull: Date.now() - 300 * 60e3, ageMin: 300, stale: true, staleAfterMin: 255 });
  await pg.reload(); await pg.waitForSelector('#stale:not([hidden])');
  assert.match(await banner(), /Data is 5 h old\.[\s\S]*within 4\.3 h/);
  fresh = () => ({ lastPull: Date.now() - 60 * 60e3, ageMin: 60, stale: false, staleAfterMin: 45 });
  await pg.reload(); await pg.waitForSelector('#stale:not([hidden])');
  assert.match(await banner(), /Data is 60 min old\.[\s\S]*within 45 min/, 'a shorter server threshold is honoured too');

  fresh = null;
  await pg.goto(`${base}/#products`); await pg.waitForSelector('#f-view');
  await pg.click('.range button[data-days="month"]');
  await pg.waitForFunction(() => document.querySelector('.range button[data-days="month"]').classList.contains('on'));
  await pg.selectOption('#f-view', 'type');
  await pg.waitForSelector('.desk th[data-k="sold"]');
  const tips = await pg.$$eval('.desk th[data-k="sold"], .desk th[data-k="lost"]', (t) => t.map((x) => x.title));
  assert.deepEqual(tips, ['₹ sold this month', 'Sales lost to stock-outs this month']);
  assert.deepEqual(pg.errors, []);
  await ctx.close();
});
