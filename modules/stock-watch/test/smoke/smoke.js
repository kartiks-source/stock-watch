'use strict';
/*
 * Playwright smoke (SW-014). NOT part of `npm test`: it needs a browser. Run on demand:
 *
 *   node modules/stock-watch/test/smoke/smoke.js
 *
 * Starts the app on a temp DATA_DIR (demo data, password on) at SMOKE_PORT (4804; refuses a port already in use), or uses BASE_URL +
 * SMOKE_PASSWORD for a running app. At 1440×900, 390×844 and 360×740 (SW-023) it checks: no console errors, no sideways
 * scroll on any page, Plan settings Reset and Save as default, the product drawer, and CSV import.
 * Screenshots go to SMOKE_OUT (default: a temp folder, printed at the end; CI sets it and uploads the folder). Exit code 1 on any failure.
 *
 * Finds Playwright via PLAYWRIGHT_PATH, a normal require, or the npx cache
 * (`npx playwright install chromium` once if the browser is missing).
 */
if (process.env.NODE_TEST_CONTEXT) process.exit(0);   // never run by node --test

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_PATH, 'playwright'].filter(Boolean);
  const npx = path.join(os.homedir(), '.npm', '_npx');
  try { for (const d of fs.readdirSync(npx)) tries.push(path.join(npx, d, 'node_modules', 'playwright')); } catch { /* no npx cache */ }
  for (const t of tries) { try { return require(t); } catch { /* next */ } }
  console.error('Playwright not found. Set PLAYWRIGHT_PATH to a playwright package folder, or run `npx playwright --version` once.');
  process.exit(2);
}

const APP = path.join(__dirname, '..', '..');
const PORT = Number(process.env.SMOKE_PORT) || 4804;
const PASSWORD = process.env.SMOKE_PASSWORD || 'smoke-password-123';
const OUT = process.env.SMOKE_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'sw-smoke-'));
fs.mkdirSync(OUT, { recursive: true });
const VIEWPORTS = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone390', width: 390, height: 844 }, { name: 'phone360', width: 360, height: 740 }];
const PAGES = ['overview', 'reorder', 'stockouts', 'products', 'data'];
const IGNORE = /fonts\.(googleapis|gstatic)\.com/;   // offline runs can't fetch the web font; not an app error

const results = [];
const check = (vp, name, ok, detail = '') => { results.push({ vp, name, ok: !!ok, detail }); };

/** Playwright's own Chromium; if that build isn't downloaded, SMOKE_CHROMIUM, an older cached Chromium, or Chrome. */
async function launch(chromium) {
  try { return await chromium.launch(); } catch (first) {
    const cache = path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
    const found = [];
    try {
      for (const d of fs.readdirSync(cache).filter((n) => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()) {
        const dir = path.join(cache, d); const sub = fs.readdirSync(dir).find((n) => n.startsWith('chrome-headless-shell'));
        if (sub) found.push(path.join(dir, sub, process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell'));
      }
    } catch { /* no cache */ }
    for (const executablePath of [process.env.SMOKE_CHROMIUM, ...found].filter(Boolean)) {
      try { const b = await chromium.launch({ executablePath }); console.log(`browser: ${executablePath}`); return b; } catch { /* next */ }
    }
    try { return await chromium.launch({ channel: 'chrome' }); } catch { throw first; }
  }
}

/** Is something already listening on the port? Then the smoke would drive (and change) someone else's app. */
const portTaken = (port) => new Promise((res) => {
  const sock = require('node:net').connect(port, '127.0.0.1');
  sock.once('connect', () => { sock.destroy(); res(true); });
  sock.once('error', () => res(false));
});

async function startApp() {
  if (process.env.BASE_URL) return { base: process.env.BASE_URL.replace(/\/$/, ''), own: false, stop: () => {} };
  if (await portTaken(PORT)) throw new Error(`port ${PORT} is already in use: set SMOKE_PORT to a free port (the smoke never runs against an app it didn't start, unless BASE_URL says so)`);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-smoke-data-'));
  const child = spawn(process.execPath, ['server.js'], { cwd: APP, env: { ...process.env, DATA_DIR: data, PORT: String(PORT), ADMIN_PASSWORD: PASSWORD, NODE_ENV: 'development' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (b) => { log += b; }); child.stderr.on('data', (b) => { log += b; });
  let died = null; child.once('exit', (code) => { died = code ?? 'signal'; });
  const stop = async () => {
    if (child.exitCode == null && child.signalCode == null) await new Promise((r) => { child.once('exit', r); child.kill(); });
    fs.rmSync(data, { recursive: true, force: true });
  };
  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 50; i++) {
    if (died != null) { await stop(); throw new Error(`app exited (${died}) before it was up:\n${log}`); }
    try { if ((await fetch(base + '/health')).ok) return { base, own: true, stop }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  await stop(); throw new Error('app did not start:\n' + log);
}

async function signIn(page, base) {
  await page.goto(base + '/login');
  if (!page.url().endsWith('/login')) return;   // no password set
  await page.fill('#pw', PASSWORD);
  await Promise.all([page.waitForURL((u) => !String(u).endsWith('/login')), page.click('button[type=submit]')]);
  await ready(page);   // let the first page's calls finish: the next goto would abort them (a false "request failed")
}
const ready = (page) => page.waitForFunction(() => !!document.querySelector('#view .headline'), null, { timeout: 15000 });   // rendered (folded panels may still say "Loading…")
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const leadValue = (page) => page.$eval('#w-leadDays', (el) => el.value);

async function openPlan(page) {
  const open = await page.$eval('details.plan', (d) => d.open).catch(() => null);
  if (open === false) await page.click('details.plan > summary', { position: { x: 12, y: 12 } });
}
async function tryLead(page, v) {
  await openPlan(page);
  await page.fill('#w-leadDays', String(v));
  await page.press('#w-leadDays', 'Enter');   // SW-057: read on Enter / leaving the box
  await page.waitForSelector('#what-reset', { timeout: 5000 });
}

async function run(browser, base, vp, own) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !IGNORE.test(m.text() + (m.location()?.url || ''))) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('requestfailed', (r) => { const why = (r.failure() || {}).errorText || ''; if (!IGNORE.test(r.url()) && !/ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(why)) errors.push(`request failed: ${r.url()} (${why})`); });   // a call cancelled by moving to the next page is not an error (slow CI)
  await signIn(page, base);

  for (const p of PAGES) {
    await page.goto(`${base}/#${p}`); await ready(page);
    await page.waitForTimeout(300);
    const over = await sideways(page);
    check(vp.name, `no sideways scroll: ${p}`, over <= 0, over > 0 ? `${over}px wider than the window` : '');
    await page.screenshot({ path: path.join(OUT, `${vp.name}-${p}.png`), fullPage: false });
  }

  /* Plan settings: Reset puts the headline back; Save as default survives a reload */
  await page.goto(`${base}/#reorder`); await ready(page);
  const baseLead = await leadValue(page), baseHead = await page.textContent('.headline h1');
  try {
    await tryLead(page, 10);
    await page.waitForFunction((h) => document.querySelector('.headline h1')?.textContent !== h, baseHead, { timeout: 5000 }).catch(() => {});
    await page.click('#what-reset');
    await page.waitForFunction((h) => document.querySelector('.headline h1')?.textContent === h, baseHead, { timeout: 5000 });
    check(vp.name, 'Reset: headline back to baseline', (await leadValue(page)) === baseLead);
  } catch (e) { check(vp.name, 'Reset: headline back to baseline', false, e.message.split('\n')[0]); }
  try {
    await tryLead(page, 10);
    await page.click('#what-save');
    await page.waitForSelector('#what-save', { state: 'detached', timeout: 5000 });
    await page.reload(); await ready(page); await openPlan(page);
    const v = await leadValue(page);
    check(vp.name, 'Save as default: reload keeps 10', v === '10', `lead after reload: ${v}`);
  } catch (e) { check(vp.name, 'Save as default: reload keeps 10', false, e.message.split('\n')[0]); }
  await page.request.put(`${base}/api/settings`, { data: { leadDays: +baseLead || 7 } });   // leave the store as found

  /* Product drawer opens from a row (table on desktop, card on phone) and closes */
  try {
    await page.goto(`${base}/#reorder`); await ready(page);
    const row = vp.width < 700 ? '.mcard[data-id]' : 'tr[data-id]';
    await page.locator(row).first().click();
    await page.waitForSelector('#drawer:not([hidden]) #drawer-title', { timeout: 5000 });
    const title = (await page.textContent('#drawer-title')).trim();
    await page.screenshot({ path: path.join(OUT, `${vp.name}-drawer.png`) });
    await page.click('#drawer-close');
    await page.waitForSelector('#drawer', { state: 'hidden', timeout: 3000 });
    check(vp.name, 'drawer opens and closes', !!title, title);
  } catch (e) { check(vp.name, 'drawer opens and closes', false, e.message.split('\n')[0]); }

  /* CSV import. The first real row clears the demo and makes the store live (SW-007); a live store refuses the demo
     (409, QA-1), so on our own app: clear, then load the demo again for the next viewport. Through page.request, so
     a refusal is never a console error. */
  try {
    await page.goto(`${base}/#data`); await ready(page);
    await page.click('details.fold:has(#imp-file) > summary');
    const csv = `Time,Variant ID,SKU,Product,Variant,Stock before,Stock now,Price\n${new Date().toISOString()},smoke-1,SMOKE-1,Smoke test item,,5,4,499\n`;
    await page.setInputFiles('#imp-file', { name: 'smoke.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.selectOption('#imp-kind', 'stock');
    if (await page.$('#imp-replace')) throw new Error('the dead "Remove the demo data first" checkbox is back (SW-007: the store always clears the demo)');
    await page.click('#imp-go');
    await page.waitForFunction(() => /Read \d+ rows/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 5000 });
    check(vp.name, 'CSV import', true, await page.textContent('#toast'));
  } catch (e) { check(vp.name, 'CSV import', false, e.message.split('\n')[0]); }
  if (own) {
    await page.request.post(`${base}/api/clear`);
    const demo = await page.request.post(`${base}/api/demo`);
    if (!demo.ok()) check(vp.name, 'demo reloaded for the next viewport', false, `POST /api/demo → ${demo.status()}`);
  }

  check(vp.name, 'no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

(async () => {
  const { chromium } = loadPlaywright();
  const app = await startApp();
  const browser = await launch(chromium); { const nc = browser.newContext.bind(browser); browser.newContext = async (o) => { const c = await nc(o); await c.addInitScript(() => { try { sessionStorage.setItem('sw-owner', '1'); } catch { /* */ } }); return c; }; }   // 1.5.0: these pages are the brand owner's (public/agency.js)
  try { for (const vp of VIEWPORTS) await run(browser, app.base, vp, app.own); }
  finally { await browser.close(); await app.stop(); }
  if (!results.length) { console.error('No checks ran.'); process.exit(1); }
  const w = Math.max(...results.map((r) => r.name.length));
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.vp.padEnd(8)} ${r.name.padEnd(w)}  ${r.detail}`);
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad}/${results.length} passed · screenshots: ${OUT}`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
