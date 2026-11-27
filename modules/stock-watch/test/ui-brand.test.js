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

/* 4.2.0: month first. The home page opens on this month (last month on the 1st–3rd), one month at a time, Past months beside it */
test('1440: the Brand report is home, month first: bar, headline, three tiles, the list adds up, Past months, the 12 months, CSV', opts, async () => {
  const pg = await open(1440, 900, '/?store=sammsara-demo', '#view .brand-h h1');
  assert.equal(await pg.getAttribute('#tabs a.on', 'data-view'), 'brand');
  assert.deepEqual(await pg.$$eval('#tabs a .rl', (a) => a.map((x) => x.textContent)), ['Brand report', 'Out now', 'Ads: push / pause', 'Restock list', 'All products']);
  const j = await (await fetch(`${base}/api/brand?store=sammsara-demo`)).json(), ms = j.months.filter((m) => m.days), cur = ms.find((m) => m.key === j.home.defaultMonth);
  assert.equal(await pg.getAttribute('.scope button.on', 'data-scope'), 'best', 'Best sellers by default');
  assert.match(await pg.textContent('#mname'), cur.closed ? /^\w+ \d{4}$/ : /^\w+ \d{4} · so far, 1–\d+ \w{3}$/);
  assert.match(await pg.textContent('.brand-h h1'), /^[\d,]+ of [\d,]+ best sellers ran out in \w+( \d{4})?\. Sammsara \(demo\) missed about ₹[\d.,]+( lakh| Cr|k)?\.$/);   // 4.2.0: the store's name
  assert.ok((await pg.textContent('.brand-h h1')).startsWith(`${cur.best.out} of ${cur.listN} best sellers`), 'X of Y = the API');
  assert.equal(await pg.textContent('#how-sure > summary'), 'How sure are we?');
  assert.ok(await pg.isHidden('.top .range'), 'the period buttons step aside');
  const tl = await pg.$$eval('.tiles3 .tl', (e) => e.map((x) => x.textContent));
  assert.deepEqual(tl, ['Net sales', 'Missed sales', 'Net sales if in stock', 'Empty right now'], '4.6.2: Shopify’s words');
  const rv = (s) => { const t = s.replace(/[₹,\s]/g, ''); const m = t.match(/^([\d.]+)(lakh|Cr|k)?$/); return m ? +m[1] * ({ lakh: 1e5, Cr: 1e7, k: 1e3 }[m[2]] || 1) : NaN; };
  const [so, mi, co] = await Promise.all(['#tile-sold .tv', '#tile-missed .tv', '#tile-could .tv'].map((q) => pg.textContent(q)));
  assert.ok(Math.abs(rv(so) + rv(mi) - rv(co)) <= Math.max(rv(co) * 0.02, 200), `sold + missed = could have sold: ${so} + ${mi} vs ${co}`);
  assert.ok(!/ · all in stock/.test(await pg.textContent('#tile-now')) || cur.best.out >= 0);
  if (cur.prev) assert.match(await pg.textContent('#tile-missed small'), /^[\d.]+% of net sales · (\d+–\d+ \w{3}|\w+): ₹/);
  assert.equal(await pg.getAttribute('#tile-now', 'href'), '#best');
  assert.equal(await pg.$('#brand-chart'), null, 'no chart in a month');
  assert.equal(await pg.$('.top5'), null, 'no "Cost the most"');
  assert.ok(!/Could have been|–₹/.test(await pg.innerText('#view')), 'no "Could have been", no ₹ range');
  /* the list's ₹ adds up to the headline (rows + Show all) */
  const money = (x) => +x.replace(/[^\d]/g, '');
  if (await pg.$('#brand-all')) await pg.click('#brand-all');
  const rows = await pg.$$eval('#olist .orow .omoney b span', (e) => e.map((x) => x.title));
  const sum = rows.reduce((s2, x) => s2 + money(x), 0);
  assert.ok(Math.abs(sum - cur.best.lost) <= rows.length, `list ${sum} = headline ${cur.best.lost}`);
  const row = await pg.$('#olist .orow');
  if (row) {
    assert.ok(await row.$('.prod .thumb'), 'picture on the left');
    assert.equal((await row.$$('.dstrip .d')).length, +cur.to.slice(8, 10) - +cur.from.slice(8, 10) + 1, 'one cell per day of the month so far (days to come are not drawn)');
    assert.match(await row.innerText(), /empty days?/);
  }
  /* Past months: newest first, the month on screen marked, the 12 months last; a row opens its month and the address keeps it */
  const past = await pg.$$eval('.ptable tbody tr[data-month]', (r) => r.map((x) => x.dataset.month));
  assert.deepEqual(past, [...ms.map((m) => m.key).reverse(), 'year']);
  assert.equal(await pg.getAttribute('.ptable tr.on', 'data-month'), cur.key);
  const prev = ms[ms.indexOf(cur) - 1];
  await pg.click(`.ptable tr[data-month="${prev.key}"]`); await pg.waitForSelector(`.ptable tr.on[data-month="${prev.key}"]`);
  assert.ok(pg.url().endsWith(`#brand/${prev.key}`), pg.url());
  assert.ok((await pg.textContent('.ptable tr.on td:nth-child(3)')).length > 0);
  await pg.click('.mstep[aria-label="Month after"]'); await pg.waitForSelector(`.ptable tr.on[data-month="${cur.key}"]`);
  await pg.click('.mstep[aria-label="Month before"]'); await pg.waitForSelector(`.ptable tr.on[data-month="${prev.key}"]`);
  await pg.reload(); await pg.waitForSelector(`.ptable tr.on[data-month="${prev.key}"]`);   // the address keeps the month
  const [dl2] = await Promise.all([pg.waitForEvent('download'), pg.click('#csv-month')]);
  assert.match(fs.readFileSync(await dl2.path(), 'utf8'), /"Empty dates","Empty days","Missed sales ₹".*"Shopify admin link","Website link"/);
  const [dl] = await Promise.all([pg.waitForEvent('download'), pg.click('#csv-months')]);
  assert.match(fs.readFileSync(await dl.path(), 'utf8'), /^﻿?"Month","From","To","Net sales ₹ \(best sellers, as Shopify\)","Missed sales ₹ \(best sellers\)","Net sales if in stock ₹ \(best sellers\)".*"Days to refill/);
  assert.match(await pg.textContent('.ptable thead'), /Net sales.*Missed.*If in stock/);
  /* the 12 months */
  await pg.click('.y12'); await pg.waitForSelector('#brand-chart svg .mb');
  assert.ok(pg.url().endsWith('#brand/12m'));
  assert.match(await pg.textContent('.brand-h h1'), /^[\d,]+ of [\d,]+ best sellers ran out (in the last 12 months|since \d+ \w{3} \d{4})\. Sammsara \(demo\) missed about ₹[\d.,]+( lakh| Cr|k)? \([\d.]+% of ₹.+ net sales\)\.$/);
  assert.ok(await pg.$('.heat .hrow .hc'), 'best seller × month grid');
  assert.equal(await pg.getAttribute('.ptable tr.on', 'data-month'), 'year');
  await pg.click(`.heat .hm[data-month="${prev.key}"]`); await pg.waitForSelector(`.ptable tr.on[data-month="${prev.key}"]`);
  /* a fresh visit starts on the default */
  await pg.goto(`${base}/?store=sammsara-demo&f=1#brand`); await pg.waitForSelector(`.ptable tr.on[data-month="${cur.key}"]`);
  for (const w of [1280, 1920]) { await pg.setViewportSize({ width: w, height: 900 }); await pg.waitForTimeout(150); assert.equal(await sideways(pg), 0, `${w}: no sideways scroll`); }
  await pg.setViewportSize({ width: 1440, height: 900 });
  assert.equal(await sideways(pg), 0);
  assert.deepEqual(pg.errors, []);
});

test('1440: Best sellers now, Ads push / pause, drawer with 12 months on the shelf', opts, async () => {
  const pg = await open(1440, 900, '/?store=sammsara-demo#best', '#view table[data-table="best"] tbody tr');
  assert.match(await pg.textContent('#view .headline h1'), /^(\d+ of \d+ (products|best sellers) are out right now\.|All \d+ (products|best sellers) are in stock\.)$/);   // 4.2.0: Best sellers by default
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
  assert.deepEqual(await pg.$$eval('#tabs a .rs', (a) => a.filter((x) => getComputedStyle(x).display !== 'none').map((x) => x.textContent)), ['Report', 'Out now', 'Ads', 'Restock', 'Products']);
  assert.equal(await sideways(pg), 0, 'brand');
  /* 4.2.0: the month bar sticks; four small tiles, two by two (4.6.0); rows are two-line cards with the day strip full width; Past months = Month, %, Missed */
  const lay = await pg.evaluate(async () => {
    const t = [...document.querySelectorAll('.tiles3 .tile3')].map((e) => e.getBoundingClientRect()), r = document.querySelector('#olist .orow');
    const strip = r && r.querySelector('.dstrip').getBoundingClientRect(), name = r && r.querySelector('.oname').getBoundingClientRect();
    const cols = [...document.querySelectorAll('.ptable thead th')].filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.textContent);
    window.scrollTo(0, 1200); await new Promise((ok) => setTimeout(ok, 100));
    return { oneRow: t.length === 4 && new Set(t.map((x) => Math.round(x.top))).size === 2, strip: strip ? strip.width : 0, below: strip ? strip.top >= name.bottom - 1 : true, cols, bar: document.getElementById('monthbar').getBoundingClientRect().top };
  });
  assert.ok(lay.oneRow, '4.6.0: four tiles, two by two'); assert.ok(lay.below && (lay.strip === 0 || lay.strip > 200), `strip on line 2, wide: ${lay.strip}`);
  assert.deepEqual(lay.cols, ['Month', 'Missed', '% of sales']); assert.ok(Math.abs(lay.bar) <= 1, `sticky bar at the top: ${lay.bar}`);
  const m = await pg.$$eval('.ptable tbody tr[data-month]', (r) => r.map((x) => x.dataset.month));
  await pg.click(`.ptable tbody tr[data-month="${m[1]}"]`);
  await pg.waitForSelector(`.ptable tbody tr.on[data-month="${m[1]}"]`);
  assert.equal(await sideways(pg), 0, 'brand month');
  await pg.click('.y12'); await pg.waitForSelector('#brand-chart svg'); assert.equal(await sideways(pg), 0, 'brand 12 months');
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
    for (const l of ['Net sales, 12 months', 'Sells, on days in stock', 'On the shelf', 'Ran out', 'Missed sales', 'Stock now', 'Last restock']) assert.ok(labels.includes(l), `${l} in ${labels}`);
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

/* 1.4.3: the drawer opens at once from the row; "to the hour" open by default (closing it is remembered); chart details on
   hover, focus and tap */
test('1440 + 390: drawer opens at once, fold open by default and remembered, details on hover / focus / tap', opts, async () => {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const pg = await open(w, h, '/?store=sammsara-demo#best', w < 760 ? '#view .mcard' : '#view table[data-table="best"] tbody tr');
    await pg.click(w < 760 ? '#view .mcard' : '#view table[data-table="best"] tbody tr');
    await pg.waitForSelector('#drawer .phero', { timeout: 300 });   // the header is there before the profile arrives
    await pg.waitForSelector('#drawer .pstory');
    assert.equal(await pg.$eval('#hour-fold', (d) => d.open), true, 'open by default');
    await pg.click('#hour-fold summary');
    await pg.waitForFunction(() => localStorage.getItem('sw-hourfold') === 'closed');   // the toggle event comes a moment after the click
    await pg.evaluate(async () => { const c = document.querySelector('.drawer-card'); for (let y = 0; y < c.scrollHeight; y += 300) { c.scrollTop = y; await new Promise((r) => setTimeout(r, 40)); } c.scrollTop = 0; });
    await pg.waitForFunction(() => document.querySelectorAll('#drawer .lazy-chart.drawn svg').length === 3);
    /* 12-month chart: hover (mouse) or tap (phone) a month */
    const g = await pg.$('#drawer svg[aria-label="Units sold and missed each month"] g.tipg:last-of-type');
    await g.scrollIntoViewIfNeeded();
    if (w < 760) await g.click({ force: true }); else await g.hover({ force: true });
    await pg.waitForSelector('#ptip:not([hidden])');
    assert.match(await pg.textContent('#ptip'), /\w{3,} \d{4}.*Sold [\d,]+ · ₹.*(Out .* missed|In stock all month)Busy-month index ×[\d.]+/s);
    const inside = await pg.evaluate(() => { const t = document.getElementById('ptip').getBoundingClientRect(), c = document.querySelector('.drawer-card').getBoundingClientRect(); return t.left >= c.left - 1 && t.right <= c.right + 1; });
    assert.ok(inside, 'the box stays inside the drawer');
    /* keyboard focus on a price month, and a calendar day / stock day */
    await pg.focus('#drawer svg[aria-label="Price paid each month"] g.tipg');
    await pg.waitForFunction(() => /Paid ₹|No sales/.test(document.getElementById('ptip').textContent), null, { timeout: 2000 }).catch(() => {});   // the box fills a frame after focus (was flaky)
    assert.match(await pg.textContent('#ptip'), /(Paid ₹[\d,]+ with GST|No sales).*sold/s);
    const day = await pg.$('#drawer .cal .cd[data-tip]'); await day.scrollIntoViewIfNeeded(); await day.click({ force: true });
    await pg.waitForFunction(() => /In stock all day|Ran out or came back|Out of stock all day/.test(document.getElementById('ptip').textContent), null, { timeout: 2000 }).catch(() => {});
    assert.match(await pg.textContent('#ptip'), /\d+ \w{3} \d{4}(In stock all day|Ran out or came back|Out of stock all day).*sold/s);
    const sd = await pg.$('#drawer svg[aria-label="Stock at each day\'s end"] rect.tipg'); await sd.scrollIntoViewIfNeeded(); await sd.click({ force: true });
    assert.match(await pg.textContent('#ptip'), /in stock at the day’s end.*sold that day/s);
    await pg.keyboard.press('Escape');
    /* reopen: the fold stays closed on this browser */
    await pg.click(w < 760 ? '#view .mcard' : '#view table[data-table="best"] tbody tr');
    await pg.waitForSelector('#hour-fold');
    assert.equal(await pg.$eval('#hour-fold', (d) => d.open), false, 'closing it is remembered');
    assert.equal(await sideways(pg), 0);
    assert.deepEqual(pg.errors, []);
    await pg.context().close();
  }
});

/* 1.4.4: Best sellers | All products — All products by default, remembered, ?view=best; the same ₹ on the pages' line */
test('1440: the switch: Best sellers by default, every part follows, remembered; ?view=all; pages show the same ₹ for the scope', opts, async () => {
  const pg = await open(1440, 900, '/?store=sammsara-demo#brand', '.brand-h h1');
  const j = await (await fetch(`${base}/api/brand?store=sammsara-demo`)).json(), cur = j.months.find((m) => m.key === j.home.defaultMonth);
  assert.equal(await pg.getAttribute('.scope button.on', 'data-scope'), 'best', 'Best sellers by default (4.2.0)');
  const money = (x) => { const v = Math.round(x), a = Math.abs(v); const one = (n) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10).toLocaleString('en-IN'); return a >= 1e7 ? `₹${one(a / 1e7)} Cr` : a >= 1e5 ? `₹${one(a / 1e5)} lakh` : a >= 1e3 ? `₹${one(a / 1e3)}k` : `₹${a}`; };
  assert.match(await pg.textContent('.brand-h h1'), /^[\d,]+ of [\d,]+ best sellers ran out/);
  assert.ok((await pg.textContent('.brand-h h1')).includes(money(cur.best.lost)), 'headline = best sellers, this month');
  assert.match(await pg.textContent('#olist h2'), /^Best sellers that ran out in /);
  await pg.click('.scope button[data-scope="all"]');
  await pg.waitForSelector('.scope button.on[data-scope="all"]');
  assert.match(await pg.textContent('.brand-h h1'), /^[\d,]+ of [\d,]+ products ran out/);
  assert.ok((await pg.textContent('.brand-h h1')).includes(money(cur.all.lost)), 'headline = all products');
  assert.match(await pg.textContent('#olist h2'), /^Products that ran out in /);
  assert.equal(await pg.evaluate(() => localStorage.getItem('sw-brand-scope')), 'all');
  await pg.reload(); await pg.waitForSelector('.brand-h h1');
  assert.equal(await pg.getAttribute('.scope button.on', 'data-scope'), 'all', 'remembered');
  await pg.click('.scope button[data-scope="best"]'); await pg.waitForSelector('.scope button.on[data-scope="best"]');
  /* the pages' line: the same scope, the period's dates */
  await pg.goto(`${base}/?store=sammsara-demo#products`); await pg.waitForSelector('#scope-line');
  const r = await (await fetch(`${base}/api/report?days=month&store=sammsara-demo`)).json();
  const bestCounted = r.products.reduce((s, p) => s + (p.abc === 'A' ? p.lostCounted || 0 : 0), 0);
  const line = await pg.textContent('#scope-line');
  const rb = await (await fetch(`${base}/api/report?days=month&best=1&store=sammsara-demo`)).json();   // 4.2.0: All products opens on This month
  assert.ok(Math.abs(rb.totals.lost - bestCounted) <= rb.products.length, `best=1 total ${rb.totals.lost} = its rows ${bestCounted}`);
  assert.ok(line.includes(`${money(rb.totals.lost)} missed · best sellers`), line);
  assert.match(line, /\d+ \w{3} – \d+ \w{3}$/);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }), p2 = await ctx.newPage();
  await p2.goto(`${base}/?store=sammsara-demo&view=all#brand`); await p2.waitForSelector('.brand-h h1');
  assert.match(await p2.textContent('.brand-h h1'), /^[\d,]+ of [\d,]+ products ran out/, '?view=all');
  await ctx.close();
  assert.equal(await sideways(pg), 0);
  assert.deepEqual(pg.errors, []);
});

/* 1.4.6 (UI critic, 25 Nov); 4.2.0: the chart and the grid live in the 12 months */
test('1440: the 12 months: the chart follows the switch (hover too); the grid sorts by money, ₹0 folds into one line; focus stays', opts, async () => {
  const pg = await open(1440, 900, '/?store=sammsara-demo#brand/12m', '#brand-chart .mb');
  const j = await (await fetch(`${base}/api/brand?store=sammsara-demo`)).json();
  const exact = (x) => `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(x))}`;
  for (const sc of ['all', 'best']) {
    await pg.click(`.scope button[data-scope="${sc}"]`); await pg.waitForSelector(`.scope button.on[data-scope="${sc}"]`);
    for (const m of j.months.filter((x) => x.days)) {
      const tip = await pg.textContent(`#brand-chart .mb[data-month="${m.key}"] title`);
      assert.ok(tip.includes(`about ${exact(m[sc].lost)} missed`), `${sc} ${m.key}: ${tip}`);
      assert.ok(sc === 'best' ? /best sellers? ran out/.test(tip) : /\d products? ran out/.test(tip), tip);
    }
    const cnt = await pg.$$eval('.heat .hrow:not(.hhead) .hv b span', (e) => e.map((x) => +x.title.replace(/[^\d]/g, '')));
    assert.deepEqual(cnt, cnt.slice().sort((a, b) => b - a), `${sc}: grid by counted money`);
    assert.ok(cnt.every((x) => x > 0), `${sc}: no ₹0 rows in the grid`);
    const zero = await pg.$('#zero-year'); if (zero) assert.match(await zero.textContent(), /^\d+( more)? (was|were) empty but we can’t put a price on (it|them): .+\(.+\)\.( Ask the brand if they still sell (it|them)\.)?$/);
  }
  assert.equal(await pg.evaluate(() => document.activeElement?.dataset.scope), 'best', 'focus stays on the switch');
  const key = j.months.filter((x) => x.days)[0].key;
  await pg.focus(`.ptable tr[data-month="${key}"]`); await pg.keyboard.press('Enter'); await pg.waitForSelector(`.ptable tr.on[data-month="${key}"]`);
  assert.equal(await pg.evaluate(() => document.activeElement?.dataset.month), key, 'focus stays on the month');
  assert.deepEqual(pg.errors, []);
});

/* 4.2.0: the agency's start date (Data → "We started on"): a dashed line on the 12-month chart and a line in Past months; none when unset */
test('1440: "We started on": set on Data, drawn on the chart and in Past months; cleared, nothing shows', opts, async () => {
  const j = await (await fetch(`${base}/api/brand?store=sammsara-demo`)).json(), ms = j.months.filter((m) => m.days), mid = ms[Math.floor(ms.length / 2)];
  const pg = await open(1440, 900, '/?store=sammsara-demo#data', '#f-agencyStart');
  assert.equal(await pg.inputValue('#f-agencyStart'), '');
  await pg.fill('#f-agencyStart', `${mid.key}-10`); await pg.click('#save-settings'); await pg.waitForSelector('#toast:not([hidden])');
  await pg.goto(`${base}/?store=sammsara-demo&s=1#brand/12m`); await pg.waitForSelector('#brand-chart .started line', { state: 'attached' });
  assert.match(await pg.textContent('#brand-chart .started'), /We started/);
  assert.match(await pg.textContent('.ptable tr.started'), new RegExp(`We started · 10 \\w{3} ${mid.key.slice(0, 4)}`));
  const order = await pg.$$eval('.ptable tbody tr', (r) => r.map((x) => x.dataset.month || 'started'));
  assert.equal(order[order.indexOf('started') - 1], mid.key, 'the line sits under its month (newest first)');
  await pg.goto(`${base}/?store=sammsara-demo&s=2#data`); await pg.waitForSelector('#f-agencyStart');
  await pg.fill('#f-agencyStart', ''); await pg.click('#save-settings'); await pg.waitForSelector('#toast:not([hidden])');
  await pg.goto(`${base}/?store=sammsara-demo&s=3#brand/12m`); await pg.waitForSelector('#brand-chart .mb');
  assert.equal(await pg.$('#brand-chart .started'), null); assert.equal(await pg.$('.ptable tr.started'), null);
  assert.deepEqual(pg.errors, []);
});

/* 4.2.0 (critics): on the 1st–3rd the agency's pages open on Last month, as the home page does; else This month */
test('1440: All products opens on Last month on the 2nd of a month, on This month on the 10th', opts, async () => {
  for (const [when, want] of [['2026-12-02T10:00:00+05:30', 'last'], ['2026-12-10T10:00:00+05:30', 'month']]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }), pg = await ctx.newPage(), errs = [];
    pg.on('pageerror', (e) => errs.push(e.message));
    await pg.clock.setFixedTime(new Date(when));
    await pg.goto(`${base}/?store=sammsara-demo#products`); await pg.waitForSelector('.top .range button.on');
    assert.equal(await pg.getAttribute('.top .range button.on', 'data-days'), want, when);
    assert.deepEqual(errs, []); await ctx.close();
  }
});

/* 4.2.0 (critics): a store with no best-seller list yet shows all products and says why; never "0 of 0 … ₹0" */
test('1440 + 390: no best-seller list yet: all products, a plain note, never "0 of 0"', opts, async () => {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } }), pg = await ctx.newPage(), errs = [];
    pg.on('pageerror', (e) => errs.push(e.message));
    await ctx.addInitScript(() => { try { localStorage.setItem('sw-brand-scope', 'best'); } catch { /* */ } });
    await pg.route('**/api/brand*', async (x) => { const res = await x.fetch(), j = await res.json(); j.headline.bestsellers = 0; for (const p of j.products) p.best = false; for (const m of j.months) m.listN = 0; await x.fulfill({ response: res, json: j }); });
    await pg.goto(`${base}/?store=sammsara-demo#brand`); await pg.waitForSelector('.brand-h h1');
    const t = await pg.innerText('#view');
    assert.match(t, /No best-seller list yet\. It needs 60 days of sales\. Showing all products\./);
    assert.match(await pg.textContent('.brand-h h1'), /^[\d,]+ of [1-9][\d,]* products ran out/);
    assert.ok(!/\b0 of 0\b/.test(t), 'never 0 of 0');
    assert.equal(await pg.getAttribute('.scope button.on', 'data-scope'), 'all');
    assert.equal(await sideways(pg), 0); assert.deepEqual(errs, []); await ctx.close();
  }
});

/* 4.2.0: All products opens on This month; This month · Last month · 30 days · 90 days · Custom; Last month = the calendar month before */
test('1440: All products: This month by default; Last month is the month before as a custom range; the same ₹ as the line', opts, async () => {
  const pg = await open(1440, 900, '/?store=sammsara-demo#products', '#scope-line');
  assert.deepEqual(await pg.$$eval('.top .range button', (b) => b.map((x) => x.innerText.trim())), ['This month', 'Last month', '30 days', '90 days', 'Custom']);
  assert.equal(await pg.getAttribute('.top .range button.on', 'data-days'), +new Date(Date.now() + 330 * 6e4).toISOString().slice(8, 10) <= 3 ? 'last' : 'month');
  const day1 = await pg.evaluate(() => SW_TZ.dayKey(Date.now(), SW_TZ.zoneOf({})).slice(0, 7));
  assert.match(await pg.textContent('#rdates'), /^1 \w{3}( – \d+ \w{3})?$/);
  await pg.click('.top .range button[data-days="last"]'); await pg.waitForSelector('.top .range button.on[data-days="last"]');
  const d = new Date(Date.UTC(+day1.slice(0, 4), +day1.slice(5, 7) - 2, 1)), m = d.toISOString().slice(0, 7), last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  assert.equal(await pg.textContent('#rdates'), `1 ${MON[+m.slice(5) - 1]} – ${+last.slice(8)} ${MON[+m.slice(5) - 1]}`);
  assert.equal(await pg.$('.top .range button.on[data-days="custom"]'), null, 'Last month, not Custom');
  const r = await (await fetch(`${base}/api/report?days=${m}-01..${last}&best=1&store=sammsara-demo`)).json();
  assert.equal(r.moneyThrough ?? last, last);
  const rs = (x) => { const v = Math.round(x), a = Math.abs(v); const one = (n) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10).toLocaleString('en-IN'); return a >= 1e7 ? `₹${one(a / 1e7)} Cr` : a >= 1e5 ? `₹${one(a / 1e5)} lakh` : a >= 1e3 ? `₹${one(a / 1e3)}k` : `₹${a}`; };
  assert.ok((await pg.textContent('#scope-line')).includes(`${rs(r.totals.lost)} missed`));
  await pg.click('.top .range button[data-days="90"]'); await pg.waitForSelector('.top .range button.on[data-days="90"]');
  assert.equal(await sideways(pg), 0);
  const ph = await open(390, 844, '/?store=sammsara-demo#products', '#scope-line');
  assert.ok(await ph.$$eval('.top .range button', (b) => b.every((x) => x.scrollWidth <= x.clientWidth + 1 && x.getBoundingClientRect().right <= innerWidth)), 'phone: five buttons fit');
  assert.equal(await sideways(ph), 0);
  assert.deepEqual([...pg.errors, ...ph.errors], []);
});

test('1440: a failed /api/brand shows an error and Try again on Ads, never "every product is in stock"', opts, async () => {
  const pg = await open(1440, 900, '/?store=sammsara-demo#products', '#scope-line');
  await pg.route('**/api/brand*', (x) => x.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false,"error":"boom"}' }));
  await pg.goto(`${base}/?store=sammsara-demo&x=1#ads`); await pg.waitForSelector('#brand-retry');
  assert.match(await pg.textContent('#view h1'), /^Couldn’t load/);
  assert.ok(!/Every selling product|Push 0/.test(await pg.textContent('#view')));
  await pg.unroute('**/api/brand*'); await pg.click('#brand-retry'); await pg.waitForSelector('.ads2 .arow');
  assert.deepEqual(pg.errors, []);
});

/* 1.4.9 (switch critic): one switch, the same place on every page, and everything follows it */
test('1440 and 390: the switch is on every page and every list, number, chart, tick, group and CSV follows it', opts, async () => {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const pg = await open(w, h, '/?store=sammsara-demo#brand', '.brand-h h1');
    const get = async (u) => (await fetch(base + u + (u.includes('?') ? '&' : '?') + 'store=sammsara-demo')).json();
    const R = { all: await get('/api/report?days=30'), best: await get('/api/report?days=30&best=1') }, j = await get('/api/brand');
    assert.ok(R.best.products.length > 0 && R.best.products.length < R.all.products.length, 'fixture: some best sellers');
    assert.ok(R.best.products.every((x) => x.abc === 'A') && R.best.reorder.every((x) => x.abc === 'A') && R.best.stockouts.every((s) => R.best.products.some((x) => x.id === s.id)));
    const near = (a, b, t) => assert.ok(Math.abs(a - b) <= 2, `${t}: ${a} vs ${b}`);
    near(R.best.daily.reduce((s, d) => s + d.sold, 0), R.best.products.reduce((s, x) => s + x.sold, 0), 'daily chart = its rows');
    near(j.headline.best.sold, j.products.filter((x) => x.best).reduce((s, x) => s + x.sold, 0), 'best sellers sold = their rows');
    const sw = async (sc) => { await pg.click(`.scope [data-scope="${sc}"]`); await pg.waitForSelector(`.scope button.on[data-scope="${sc}"]`); await pg.waitForFunction((n) => true); await pg.waitForTimeout(700); };
    const seen = {};
    for (const [hash, sel] of [['brand', '.brand-h h1'], ['best', '#view h1'], ['ads', '#view h1'], ['products', '#view h1']]) {
      await pg.goto(`${base}/?store=sammsara-demo&w=${w}${hash}#${hash}`); await pg.waitForSelector(sel); await pg.waitForTimeout(400);
      assert.equal((await pg.$$('.scope')).length, 1, `${w} ${hash}: one switch`);
      seen[hash] = {};
      for (const sc of ['all', 'best']) { await sw(sc); seen[hash][sc] = await pg.innerText('#view'); assert.equal(await sideways(pg), 0, `${w} ${hash} ${sc}`); }
      assert.notEqual(seen[hash].all, seen[hash].best, `${w} ${hash}: nothing changed`);
      await sw('all');
    }
    assert.match(seen.products.best, /^Best sellers/);
    /* the bars themselves move */
    await pg.goto(`${base}/?store=sammsara-demo&c=${w}#brand/12m`); await pg.waitForSelector('#brand-chart .sold');
    const bars = () => pg.$$eval('#brand-chart .sold', (e) => e.map((x) => x.getAttribute('height')).join());
    await sw('all'); const a = await bars(); await sw('best'); assert.notEqual(await bars(), a, 'the sold bars follow'); await sw('all');
    const lines = async (q) => (await (await fetch(`${base}/api/export/reorder.csv?days=30&filter=all${q}&store=sammsara-demo`)).text()).trim().split('\n').length;
    assert.equal(await lines('&best=1') - 1, R.best.reorder.length + 0 * 1, 'reorder CSV'); assert.ok(await lines('') > await lines('&best=1'));
    const G = { all: await get('/api/groups?lens=type&days=30'), best: await get('/api/groups?lens=type&days=30&best=1') };
    assert.equal(G.best.groups.reduce((s, g) => s + g.n, 0), R.best.products.length, 'groups'); assert.ok(G.all.groups.length >= G.best.groups.length);
    assert.deepEqual(pg.errors, []);
  }
});

test('13 months (the first in part), refilled-a-few-at-a-time and no-longer-on-sale rows, counted + not counted in the drawer (server 1.4.6 shape)', opts, async () => {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } }), pg = await ctx.newPage(), errors = [];
    pg.on('pageerror', (e) => errors.push(e.message));
    await pg.route('**/api/brand*', async (x) => {
      const res = await x.fetch(), j = await res.json(), m0 = j.months[j.months.length - 1], ms = [];
      for (let i = 12; i >= 0; i--) { const d = new Date(Date.UTC(2026, 10 - i, 1)), k = d.toISOString().slice(0, 7), n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); ms.push({ ...m0, key: k, from: i === 12 ? `${k}-25` : `${k}-01`, to: `${k}-${n}`, days: i === 12 ? n - 24 : n, closed: i !== 0 }); }
      j.months = ms; const p = j.products[0]; p.inactive = true; delete p.allApart; p.daysOut = 5; p.lost = p.counted = 9e6; p.best = false;
      const b = j.now.find((z) => !z.out); Object.assign(b, { allocation: true, orderQty: 0, onOrder: null, daysLeft: 2.1, name: 'Topped Up Table' });
      j.ads.keep = [{ ...j.ads.push[0], stock: 7, name: 'Kept Table' }];
      await x.fulfill({ response: res, json: j });
    });
    await pg.goto(`${base}/?store=sammsara-demo#brand/12m`); await pg.waitForSelector('#brand-chart .mb');
    assert.equal((await pg.$$('#brand-chart .mb')).length, 13);
    const rows = await pg.$$eval('.ptable tbody tr[data-month]:not(.yr) td:first-child', (e) => e.map((x) => x.textContent.trim()));
    assert.equal(rows.length, 13); assert.match(rows[12], /^25–30 Nov 2025$/); assert.match(rows[0], /^Nov 2026/);
    await pg.click('.scope button[data-scope="all"]'); await pg.waitForSelector('.scope button.on[data-scope="all"]');
    assert.match(await pg.textContent('.heat .hrow:nth-child(2)'), /No longer on sale/);
    assert.equal(await sideways(pg), 0);
    await pg.click('#brand-chart .mb[data-month="2026-08"]', { force: true }); await pg.waitForSelector('.ptable tr.on[data-month="2026-08"]');
    assert.equal(await pg.textContent('#mname'), 'August 2026');
    await pg.click('.scope button[data-scope="best"]'); await pg.waitForSelector('.scope button.on[data-scope="best"]');
    await pg.goto(`${base}/?store=sammsara-demo&a=1#best`); await pg.waitForSelector('#scope-line');
    assert.match(await pg.textContent('#view'), /Topped Up Table[\s\S]*?website top-up/); assert.ok(!/Check the warehouse|Enough stock/.test(await pg.textContent('#view')));
    await pg.goto(`${base}/?store=sammsara-demo&a=2#ads`); await pg.waitForSelector('#ads-keep .arow');
    assert.match(await pg.textContent('#ads-keep'), /Keep ads on: refilled a few at a time[\s\S]*Kept Table[\s\S]*refilled a few at a time/);
    assert.equal(await sideways(pg), 0);
    const t = await pg.evaluate(() => { const months = [{ key: '2026-11', label: '', from: '2026-11-01', to: '2026-11-23', days: 23, units: 1, missedUnits: 2, missed: 500, apart: 700, daysOut: 4, season: 1 }]; return SW_PROFILE.body({ ok: true, span: { from: '2025-11-25', through: '2026-11-23', days: 364 }, outs: { times: 1, days: 4 }, pace: { perDay: 1, sixMonths: 0.2857 }, missed: { value: 500, units: 0.4, apart: 700 }, months, sold: { units: 1, value: 1 }, share: 1, inStock: { pct: 1, days: 1, of: 1 }, stock: [], calendar: [], restocks: [] }, null); });
    assert.match(t, /about 2 a week when it is in stock/); assert.match(t, /That cost about ₹500 in sales, \+₹700 not counted/); assert.ok(!/about less than/.test(t));
    assert.deepEqual(errors, []); await ctx.close();
  }
});

test('390: the drawer opens at the top; charts start at the newest days; Tab stays inside', opts, async () => {
  const pg = await open(390, 844, '/?store=sammsara-demo#best', '#view .mcard');
  await pg.click('#view .mcard:nth-of-type(1)'); await pg.waitForSelector('#drawer .pstory');
  await pg.evaluate(async () => { const c = document.querySelector('.drawer-card'); for (let y = 0; y < c.scrollHeight; y += 300) { c.scrollTop = y; await new Promise((r) => setTimeout(r, 40)); } });
  await pg.waitForFunction(() => document.querySelectorAll('#drawer .lazy-chart.drawn svg').length === 3);
  assert.ok(await pg.$$eval('#drawer .chartbox', (b) => b.every((x) => x.scrollLeft >= x.scrollWidth - x.clientWidth - 2)), 'newest first');
  await pg.focus('#drawer-close'); await pg.keyboard.press('Shift+Tab');
  assert.ok(await pg.evaluate(() => document.querySelector('.drawer-card').contains(document.activeElement)));
  await pg.keyboard.press('Escape'); await pg.waitForTimeout(150);
  await pg.evaluate(() => document.querySelectorAll('#view .mcard')[1].click()); await pg.waitForSelector('#drawer .pstory');
  assert.equal(await pg.$eval('.drawer-card', (c) => c.scrollTop), 0);
  assert.deepEqual(pg.errors, []);
});

/* 1.5.0: the screens are the agency's: nothing about ordering, suppliers, overstock or dropping a product */
test('1440 and 390: no brand-owner words or pages on any screen, the drawer included; old links open the report; ?owner=1 still has them', opts, async () => {
  const BAD = /reorder|restock or|refill or|order today|order by|supplier|purchase order|overstock|slow seller|lead time|mark ordered|not ordered|margin|profit|unit cost|drop\?/i;
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const pg = await open(w, h, '/?store=sammsara-demo#brand', '.brand-h h1');
    assert.equal(await pg.$eval('#tabs a[data-view="reorder"]', (a) => getComputedStyle(a).display), 'none');
    for (const t of ['brand', 'best', 'ads', 'products', 'data']) {
      await pg.goto(`${base}/?store=sammsara-demo&p=${t}${w}#${t}`); await pg.waitForSelector('#view h1'); await pg.waitForTimeout(500);
      const hit = (await pg.innerText('#view')).match(BAD); assert.equal(hit && hit[0], null, `${w} ${t}`);
      assert.equal(await sideways(pg), 0);
    }
    for (const t of ['reorder', 'overview', 'stockouts']) { await pg.goto(`${base}/?store=sammsara-demo&o=${t}${w}#${t}`); await pg.waitForSelector('.brand-h h1'); }
    for (const f of ['lost', 'out', 'pause']) { await pg.goto(`${base}/?store=sammsara-demo&f=${f}${w}#products`); await pg.waitForSelector(`[data-filter-products="${f}"]`); await pg.click(`[data-filter-products="${f}"]`); await pg.waitForTimeout(300); const hit = (await pg.innerText('#view')).match(BAD); assert.equal(hit && hit[0], null, `${w} products ${f}`); }
    await pg.goto(`${base}/?store=sammsara-demo&d=${w}#best`); await pg.waitForSelector(w > 760 ? 'table[data-table="best"] tbody tr' : '.mcard h3'); await pg.click(w > 760 ? 'table[data-table="best"] tbody tr' : '.mcard h3'); await pg.waitForSelector('#drawer .pstory');
    const hit = (await pg.innerText('#drawer')).match(BAD); assert.equal(hit && hit[0], null, `${w} drawer`);
    assert.match(await pg.innerText('#view'), /#\d+ by sales/, 'the rank is on the row');
    assert.deepEqual(pg.errors, []);
    const ctx = await browser.newContext({ viewport: { width: w, height: h } }), p2 = await ctx.newPage();
    await p2.goto(`${base}/?store=sammsara-demo&owner=1#reorder`); await p2.waitForSelector('[data-filter-reorder="all"]'); await ctx.close();
  }
});

/* 1.5.1: the working behind every number */
test('1440 and 390: "Why this number": five steps, every month, where to check; the sum is on the Out now rows; adds up', opts, async () => {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const pg = await open(w, h, '/?store=sammsara-demo#best', w > 760 ? 'table[data-table="best"] tbody tr' : '.mcard h3');
    assert.match(await pg.innerText('#view'), /[\d.,]+ days × [\d.]+ a day × ₹[\d,]+/);
    await pg.click(w > 760 ? 'table[data-table="best"] tbody tr' : '.mcard h3'); await pg.waitForSelector('#why', { state: 'attached' });
    assert.equal(await pg.$eval('#why', (d) => d.open), false, 'closed until asked'); assert.ok(await pg.evaluate(() => document.querySelector('#drawer-body').lastElementChild.id === 'why'), 'at the bottom of the panel');
    await pg.click('#why > summary'); await pg.waitForSelector('#why .why-steps');
    const t = await pg.innerText('#why'); assert.match(t, /^Why this number\s+\w{3} \d{4}, ₹[\d,]+/); assert.equal((await pg.$$('#why .why-steps li')).length, 5);
    for (const k of ['How long was it empty?', 'How fast does it sell?', 'What did people pay?', 'Multiply', 'Do we count it?', 'Every month', 'Check it yourself in Shopify']) assert.ok(t.includes(k), k);
    const m = t.match(/([\d.,]+) × ₹([\d,]+) = ₹([\d,]+)\./), n = (x) => +x.replace(/,/g, ''); assert.ok(Math.abs(n(m[1]) * n(m[2]) - n(m[3])) <= n(m[2]) * 0.01 + 2, m[0]);
    assert.equal(await sideways(pg), 0); assert.deepEqual(pg.errors, []);
  }
});
