'use strict';
/*
 * SW-057 in the browser: Plan settings what-ifs (Reorder) and Advanced planning rules (Data) keep the text as typed:
 * no reformat, no caret jump, no report call while typing; read on Enter / leaving the box; a bad value shows a hint
 * and changes nothing. SW-049: the Data page time zone picker. Phone widths: no sideways scroll.
 * Needs Playwright (PLAYWRIGHT_PATH; PLAYWRIGHT_CHANNEL=chrome); skipped without it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pw = null;
try { pw = require(process.env.PLAYWRIGHT_PATH || 'playwright'); } catch { /* not installed: skip */ }
const opts = { skip: pw ? false : 'Playwright not found (set PLAYWRIGHT_PATH)' };

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-ui-trial-'));
for (const k of ['ADMIN_PASSWORD', 'VIEW_PASSWORD', 'SHOPIFY_STORE', 'STORES', 'PERFORMITY_POC_API_URL', 'PERFORMITY_POC_API_KEY']) delete process.env[k];
const { server } = require('../server');

let base, browser;
test.before(async () => {
  if (!pw) return;
  await new Promise((ok) => server.listen(0, ok));
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/demo`, { method: 'POST' })).status, 200);
  browser = await pw.chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}); { const nc = browser.newContext.bind(browser); browser.newContext = async (o) => { const c = await nc(o); await c.addInitScript(() => { try { sessionStorage.setItem('sw-owner', '1'); } catch { /* */ } }); return c; }; }   // 1.5.0: these pages are the brand owner's (public/agency.js)
});
test.after(async () => { if (browser) await browser.close(); if (server.listening) await new Promise((ok) => server.close(ok)); });

async function open(width, height, hash) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const pg = await ctx.newPage();
  pg.errors = []; pg.on('pageerror', (e) => pg.errors.push(e.message));
  pg.reports = []; pg.on('request', (r) => { const u = new URL(r.url()); if (u.pathname === '/api/report') pg.reports.push(u); });
  await pg.goto(base + '/' + hash); await pg.waitForSelector('#view .headline h1');
  return pg;
}
const sideways = (pg) => pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test('Reorder what-if: typing keeps the raw text and calls nothing; Enter reads it; a bad value shows a hint', opts, async () => {
  const pg = await open(1440, 900, '#reorder');
  if (!(await pg.$eval('details.plan', (d) => d.open))) await pg.click('details.plan > summary', { position: { x: 12, y: 12 } });
  const box = '#w-leadDays';
  await pg.click(box, { clickCount: 3 });
  pg.reports = [];
  await pg.keyboard.type('1', { delay: 30 }); await pg.keyboard.type('.', { delay: 30 });
  await pg.waitForTimeout(400);
  assert.equal(await pg.$eval(box, (e) => e.value), '1.', 'no reformat while typing');
  assert.equal(pg.reports.length, 0, 'no report call while typing');
  await pg.keyboard.type('5');
  assert.equal(await pg.$eval(box, (e) => e.selectionStart), 3, 'caret stays at the end');
  await pg.keyboard.press('Enter');
  await pg.waitForSelector('#what-reset');
  assert.ok(pg.reports.some((u) => u.searchParams.get('leadDays') === '1.5'), 'Enter runs the what-if');
  assert.equal(await pg.$eval(box, (e) => e.value), '1.5');

  await pg.click(box, { clickCount: 3 }); pg.reports = [];
  await pg.keyboard.type('abc');
  await pg.keyboard.press('Tab');   // leave the box
  await pg.waitForSelector('#w-leadDays-hint');
  assert.match(await pg.textContent('#w-leadDays-hint'), /Enter a number from 0 to 180/);
  assert.equal(await pg.$eval(box, (e) => e.getAttribute('aria-invalid')), 'true');
  assert.equal(await pg.$eval(box, (e) => e.value), 'abc', 'kept so it can be fixed');
  await pg.waitForTimeout(300);
  assert.equal(pg.reports.length, 0, 'a bad value changes nothing');
  assert.deepEqual(pg.errors, []);
});

test('Data: Advanced planning rules keep the raw text; the time zone picker lists IANA zones; phones have no sideways scroll', opts, async () => {
  const pg = await open(1440, 900, '#data');
  assert.equal(await pg.$eval('#f-timeZone', (e) => e.value), 'Asia/Kolkata');
  assert.ok(await pg.$('#f-timeZone option[value="Europe/London"]'));
  await pg.click('details.fold-in > summary');
  await pg.click('#f-minPerDay', { clickCount: 3 });
  await pg.keyboard.type('0,');
  assert.equal(await pg.$eval('#f-minPerDay', (e) => e.value), '0,');
  await pg.keyboard.type('5'); await pg.keyboard.press('Tab');
  assert.equal(await pg.$('#f-minPerDay-hint'), null, '0,5 reads as 0.5');
  await pg.click('#f-leadDays', { clickCount: 3 }); await pg.keyboard.type('999'); await pg.keyboard.press('Tab');
  assert.match(await pg.textContent('#f-leadDays-hint'), /0 to 180/);
  assert.ok((await sideways(pg)) <= 0);
  for (const [w, h] of [[390, 844], [360, 740]]) {
    for (const hash of ['#data', '#reorder']) {
      const p = await open(w, h, hash);
      assert.ok((await sideways(p)) <= 0, `${w}px ${hash}: sideways scroll`);
      await p.context().close();
    }
  }
  assert.deepEqual(pg.errors, []);
});
