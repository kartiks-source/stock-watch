'use strict';
/* SW-062 in the browser: the owner sees Data → People, makes a viewer for one store and gets the password once;
 * that viewer sees only their store in the picker and no People panel. No sideways scroll at 1440 and 390.
 * Needs Playwright (PLAYWRIGHT_PATH; PLAYWRIGHT_CHANNEL=chrome); skipped without it. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pw = null;
try { pw = require(process.env.PLAYWRIGHT_PATH || 'playwright'); } catch { /* not installed: skip */ }
const opts = { skip: pw ? false : 'Playwright not found (set PLAYWRIGHT_PATH)' };

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-ui-people-'));
for (const k of ['VIEW_PASSWORD', 'SHOPIFY_STORE', 'STORES', 'PERFORMITY_POC_API_URL', 'PERFORMITY_POC_API_KEY']) delete process.env[k];
const OWNER = 'ui-people-owner-password';
process.env.ADMIN_PASSWORD = OWNER;
const { server } = require('../server');

let base, browser;
test.before(async () => {
  if (!pw) return;
  await new Promise((ok) => server.listen(0, ok));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await pw.chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}); { const nc = browser.newContext.bind(browser); browser.newContext = async (o) => { const c = await nc(o); await c.addInitScript(() => { try { sessionStorage.setItem('sw-owner', '1'); } catch { /* */ } }); return c; }; }   // 1.5.0: these pages are the brand owner's (public/agency.js)
});
test.after(async () => { if (browser) await browser.close(); if (server.listening) await new Promise((ok) => server.close(ok)); });

async function signIn(width, height, password) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const pg = await ctx.newPage();
  pg.errors = []; pg.on('pageerror', (e) => pg.errors.push(e.message));
  await pg.goto(base + '/login'); await pg.fill('#pw', password);
  await Promise.all([pg.waitForURL(/\/$|#/), pg.click('button[type=submit]')]);
  return pg;
}
const sideways = (pg) => pg.evaluate(() => document.documentElement.scrollWidth - innerWidth);

test('owner makes a viewer for one store; the password is shown once; the viewer sees only that store, no People', opts, async () => {
  let password;
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const pg = await signIn(w, h, OWNER);
    await pg.goto(base + '/#data'); await pg.waitForSelector('#people-fold:not([hidden])');
    await pg.click('#people-fold summary'); await pg.waitForSelector('#pp-name');
    await pg.fill('#pp-name', `Viewer ${w}`); await pg.check('[data-pp-store="second-demo"]'); await pg.click('#pp-save');
    password = (await (await pg.waitForSelector('#pp-pw')).textContent()).trim();
    assert.ok(password.length >= 16);
    assert.equal(await pg.$$eval('.pp-list li', (l) => l.length), w === 1440 ? 1 : 2);
    assert.equal(await sideways(pg), 0, `${w}: no sideways scroll`);
    await pg.click('#pp-done'); assert.equal(await pg.$('#pp-pw'), null, 'gone after Done');
    assert.deepEqual(pg.errors, []);
    await pg.context().close();
  }
  const pg = await signIn(390, 844, password);
  await pg.waitForSelector('#view .headline h1');
  assert.match(pg.url(), /store=second-demo/);
  assert.equal(await pg.$eval('#store-name', (e) => e.textContent).then((t) => /Second store/.test(t)), true);
  const r = await pg.evaluate(async () => (await fetch('/api/stores')).json());
  assert.deepEqual(r.stores.map((s) => s.id), ['second-demo']);
  assert.equal(await pg.evaluate(async () => (await fetch('/api/people')).status), 403);
  assert.equal(await sideways(pg), 0);
  assert.deepEqual(pg.errors, []);
  await pg.context().close();
});
