'use strict';
/*
 * Sprint 3 A-money in the browser: Reorder "Budget ₹" (SW-041: cut line, rows over budget dimmed, CSV link carries
 * the budget, remembered per store, Clear = the page as before) and "By supplier" PO drafts + Data → Suppliers (SW-040).
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

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-ui-money-'));
for (const k of ['ADMIN_PASSWORD', 'VIEW_PASSWORD', 'SHOPIFY_STORE', 'STORES', 'PERFORMITY_POC_API_URL', 'PERFORMITY_POC_API_KEY']) delete process.env[k];
const { server } = require('../server');

let base, browser;
test.before(async () => {
  if (!pw) return;
  await new Promise((ok) => server.listen(0, ok));
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/demo?store=sammsara-demo`, { method: 'POST' })).status, 200);
  browser = await pw.chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}); { const nc = browser.newContext.bind(browser); browser.newContext = async (o) => { const c = await nc(o); await c.addInitScript(() => { try { sessionStorage.setItem('sw-owner', '1'); } catch { /* */ } }); return c; }; }   // 1.5.0: these pages are the brand owner's (public/agency.js)
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

for (const [w, h] of [[1440, 900], [390, 844]]) {
  test(`${w}: budget draws one cut line, dims the rest, CSV link carries it; Clear = as before; By supplier = PO drafts`, opts, async () => {
    const pg = await open(w, h, '/?store=sammsara-demo#reorder', w > 760 ? '.mbar #budget-in' : '#mbar-tg');
    if (w <= 760) {   // phones: the bar is folded behind "₹ Budget" so the first card stays near the top (ui-helpers M8)
      assert.equal(await pg.isVisible('.mbar'), false, 'folded by default on a phone');
      await pg.click('#mbar-tg'); await pg.waitForSelector('.mbar #budget-in');
      assert.ok((await pg.$eval('#budget-in', (e) => e.getBoundingClientRect().height)) >= 44, 'M5: budget box is a 44 px target');
    }
    const before = await pg.$$eval('#view tr[data-id]', (r) => r.map((x) => x.dataset.id));
    assert.equal(await pg.$('.cutline'), null, 'no budget: no line');
    await pg.fill('#budget-in', '3,00,000'); await pg.press('#budget-in', 'Enter');
    await pg.waitForSelector('.cutline', { state: 'attached' });
    assert.match(await pg.textContent('.mbar'), /fit · .* keeps .* profit · .* over budget/);
    assert.ok((await pg.$$('.overb')).length > 0, 'rows below the line are dimmed');
    assert.match(await pg.$eval('#view .colpick .menu a[href*="reorder.csv"]', (a) => a.href), /budget=300000/);
    assert.equal(await sideways(pg), 0);
    await pg.reload(); await pg.waitForSelector('.cutline', { state: 'attached' });
    assert.equal(await pg.inputValue('#budget-in'), '3,00,000', 'remembered for this store');
    await pg.click('#budget-clear'); await pg.waitForFunction(() => !document.querySelector('.cutline'));
    assert.deepEqual(await pg.$$eval('#view tr[data-id]', (r) => r.map((x) => x.dataset.id)), before, 'empty budget = the same rows in the same order');

    await pg.click('[data-polens=supplier]'); await pg.waitForSelector('.podraft');
    const n = (await pg.$$('.podraft')).length;
    assert.ok(n >= 5, 'one PO draft per demo supplier');
    assert.match(await pg.$eval('.podraft a[href*="supplier="]', (a) => a.href), /reorder\.csv\?.*supplier=/);
    if (w < 760) assert.ok((await pg.$eval('.podraft .po-a .btn', (b) => b.getBoundingClientRect().height)) >= 43, '44 px tap target');
    assert.equal(await sideways(pg), 0);
    await pg.click('[data-polens=list]');
    assert.deepEqual(pg.errors, []);
  });

  test(`${w}: Data → Suppliers lists the demo suppliers with terms; no sideways scroll`, opts, async () => {
    const pg = await open(w, h, '/?store=sammsara-demo#data', '#sup-panel');
    await pg.click('#sup-panel summary'); await pg.waitForSelector('#sup-body .sup-row');
    assert.ok((await pg.$$('#sup-body .sup-row')).length >= 5);
    assert.equal(await sideways(pg), 0);
    assert.deepEqual(pg.errors, []);
  });
}
