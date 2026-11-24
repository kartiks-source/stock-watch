'use strict';
/*
 * Sprint 2 · D-helpers UI rules in a real browser (LOGIC.md §15): Status column only on Reorder → All,
 * Why dates agree with the tab, Pause/Push count line + Copy SKUs, Decide buttons hide and Undo, 44 px phone buttons.
 * Needs Playwright (no npm dependency): set PLAYWRIGHT_PATH to a playwright package, or have one resolvable;
 * PLAYWRIGHT_CHANNEL=chrome uses the installed Chrome instead of Playwright's own browser.
 * Skipped when it isn't there, so `npm test` stays dependency-free.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pw = null;
try { pw = require(process.env.PLAYWRIGHT_PATH || 'playwright'); } catch { /* not installed: skip */ }
const opts = { skip: pw ? false : 'Playwright not found (set PLAYWRIGHT_PATH)' };

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-ui-'));
delete process.env.ADMIN_PASSWORD;
const { server } = require('../server');

let base, browser;
test.before(async () => {
  if (!pw) return;
  await new Promise((ok) => server.listen(0, ok));
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/demo', { method: 'POST' })).status, 200);
  browser = await pw.chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {});
});
test.after(async () => { if (browser) await browser.close(); if (server.listening) await new Promise((ok) => server.close(ok)); });

async function page(width = 1440, height = 900) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addInitScript(() => { window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied.push(t); } } }); });
  const pg = await ctx.newPage();
  const errors = []; pg.on('pageerror', (e) => errors.push(e.message));
  pg.errors = errors;
  return pg;
}
const heads = (pg) => pg.$$eval('.tbl.desk table thead th', (th) => th.map((x) => x.textContent.replace(/[↑↓]/g, '').trim()));

test('Reorder: Status column only on All; Why dates agree with the tab', opts, async () => {
  const pg = await page();
  await pg.goto(base + '/#reorder'); await pg.waitForSelector('.tbl.desk table');
  assert.ok(await pg.$('[data-filter-reorder="all"].on'), 'Reorder opens on All (show everything)');
  await pg.click('[data-filter-reorder="today"]'); await pg.waitForSelector('[data-filter-reorder="today"].on');
  assert.equal((await heads(pg)).includes('Status'), false, 'Order today: no Status column');
  assert.ok((await heads(pg)).includes('Why'));
  const today = await pg.$$eval('.tbl.desk tbody .why', (w) => w.map((x) => x.textContent));
  assert.ok(today.length && today.every((t) => /^Out\b|order by today/.test(t)), 'Order today rows: out, or order by today');
  await pg.click('[data-filter-reorder="week"]');
  assert.equal((await heads(pg)).includes('Status'), false, 'This week: no Status column');
  const week = await pg.$$eval('.tbl.desk tbody .why', (w) => w.map((x) => x.textContent));
  assert.ok(week.length && week.every((t) => !/order by today/.test(t)), 'This week rows never say "order by today"');
  await pg.click('[data-filter-reorder="all"]');
  assert.ok((await heads(pg)).includes('Status'), 'All keeps Status');
  assert.deepEqual(pg.errors, []);
  await pg.context().close();
});

test('Products: Pause / Push count line and Copy SKUs', opts, async () => {
  const pg = await page();
  await pg.goto(base + '/#products'); await pg.waitForSelector('[data-filter-products="pause"]');
  await pg.click('[data-filter-products="pause"]');
  const r = await (await fetch(base + '/api/report?days=30')).json();
  const pause = r.products.filter((p) => p.mkt === 'pause');
  const line = await pg.textContent('.mktbar > span');
  assert.equal(line, `${pause.filter((p) => p.orderQty > 0).length} to reorder · ${pause.filter((p) => p.status === 'Slow seller').length} slow`);
  assert.equal(await pg.textContent('#copy-skus'), `Copy ${pause.length} SKUs`);
  await pg.click('#copy-skus');
  const copied = (await pg.evaluate(() => window.__copied))[0].split('\n');
  assert.equal(copied.length, pause.length);
  assert.deepEqual(new Set(copied), new Set(pause.map((p) => p.sku || String(p.id))));
  await pg.click('[data-filter-products="push"]');
  assert.match(await pg.textContent('.mktbar > span'), /^₹[\d.,]+ ?(k|L|Cr)? stuck$/);
  assert.deepEqual(pg.errors, []);
  await pg.context().close();
});

test('Products → Slow sellers to decide: Keep hides the row, Undo brings it back; no "₹0 lost"', opts, async () => {
  const pg = await page();
  await pg.goto(base + '/#products'); await pg.waitForSelector('#f-more');
  await pg.selectOption('#f-more', 'slow'); await pg.waitForSelector('.tbl.desk [data-decide]');
  if (await pg.$('[data-more="products"][data-all]')) await pg.click('[data-more="products"][data-all]');
  const zeroDrop = (await (await fetch(base + '/api/report')).json()).decide.some((x) => x.kind === 'drop' && !x.value);   // depends on the demo draw
  if (zeroDrop) assert.ok(await pg.$$eval('.tbl.desk .dec.drop', (d) => d.some((x) => x.textContent.trim() === 'Don’t reorder?')), 'a drop row with nothing lost reads "Don’t reorder?"');
  assert.equal(await pg.$$eval('.tbl.desk .dec', (d) => d.some((x) => /₹0\b/.test(x.textContent))), false);
  const id = await pg.$eval('.tbl.desk tbody tr', (tr) => tr.dataset.id);
  await pg.click(`.tbl.desk tr[data-id="${id}"] [data-decide$="|keep"]`);
  await pg.waitForSelector('details.decided');
  assert.equal(await pg.$(`.tbl.desk tr[data-id="${id}"]`), null, 'decided row hidden');
  await pg.click('details.decided summary');
  await pg.click(`details.decided [data-decide="${id}|"]`);
  await pg.waitForSelector(`.tbl.desk tr[data-id="${id}"]`);
  assert.deepEqual(pg.errors, []);
  await pg.context().close();
});

const PHONES = [[390, 844], [360, 740]];   // SW-023: every phone check at both sizes

test('Phone 390 and 360: new small buttons are at least 44 px tall; sort label names the list order', opts, async () => {
  for (const [w, h] of PHONES) {
    const pg = await page(w, h);
    await pg.goto(base + '/#products'); await pg.waitForSelector('[data-filter-products="pause"]');
    await pg.click('[data-filter-products="pause"]');
    const hs = await pg.$$eval('.mktbar .btn.xs', (b) => b.map((x) => x.getBoundingClientRect().height));
    assert.ok(hs.length && hs.every((x) => x >= 44), `${w}: button heights ${hs}`);
    assert.equal(await pg.$eval('.phone select[data-msort] option[value=""]', (o) => o.textContent), 'Out first, then fewest days left');
    assert.ok(await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${w}: no sideways scroll`);
    assert.deepEqual(pg.errors, []);
    await pg.context().close();
  }
});

test('Products filters: no duplicate lists; overstock tile opens Push these (critic r2 S1)', opts, async () => {
  const pg = await page();
  await pg.goto(base + '/#products'); await pg.waitForSelector('#f-more');
  const chips = await pg.$$eval('[data-filter-products]', (b) => b.map((x) => x.dataset.filterProducts));
  const more = await pg.$$eval('#f-more option', (o) => o.map((x) => x.value).filter(Boolean));
  assert.equal(chips.length, 7);   // + High returns (SW-064); 1.2.0 Estimates / Not restocked are in More… (LOGIC §4c)
  assert.ok(more.includes('estimate') && more.includes('notrestocked'), `More… has the §4c filters: ${more}`); assert.equal(more.length, more.includes('warehouse') ? 9 : 8, `More… options ${more}`);   // 1.3.0: + Top-up from warehouse when a product is an allocation
  assert.ok(!more.includes('over') && !more.includes('decide'), 'Overstock = Push these; Slow sellers = Slow sellers to decide');
  await pg.selectOption('#f-more', 'slow'); await pg.waitForSelector('.tbl.desk');
  assert.ok((await heads(pg)).includes('Decide'), 'Slow sellers carries the Decide column');
  await pg.goto(base + '/#overview'); await pg.waitForSelector('.tile.plum');
  await pg.click('.tile.plum'); await pg.waitForSelector('[data-filter-products="push"].on');
  assert.match(await pg.textContent('.headline h1'), /^Push [\d,]+ overstocked products$/);
  assert.deepEqual(pg.errors, []);
  await pg.context().close();
});

test('Group rows carry a spark like product rows (SW-021): desktop Trend cell, phone card header; fits 1280–1920, 390, 360', opts, async () => {
  for (const [w, h] of [[1280, 800], [1440, 900], [1920, 1080], ...PHONES]) {
    const pg = await page(w, h);
    await pg.goto(base + '/#products'); await pg.waitForSelector('#f-view');
    await pg.selectOption('#f-view', 'type');
    await pg.waitForFunction(() => document.querySelectorAll('.groups table tbody tr, .groups .mcard').length > 0);
    if (w >= 1000) {
      const m = await pg.evaluate(() => { const b = document.querySelector('.groups .tbl.desk'), t = b.querySelector('table');
        return { sparks: t.querySelectorAll('tbody .trc svg.spark').length, rows: t.tBodies[0].rows.length, tw: t.getBoundingClientRect().width, bw: b.clientWidth, page: document.documentElement.scrollWidth - innerWidth,
          tip: t.querySelector('tbody .trc svg.spark title')?.textContent || '' }; });
      assert.equal(m.sparks, m.rows, `${w}: a spark on every group row`);
      assert.ok(m.tw <= m.bw + 1, `${w}: groups table ${m.tw} fits ${m.bw}`);
      assert.equal(m.page, 0, `${w}: no sideways scroll`);
      assert.match(m.tip, /\d+ sold|no data yet/, `${w}: week tooltip`);
    } else {
      const m = await pg.evaluate(() => ({ sparks: [...document.querySelectorAll('.groups .phone .mcard header .mspark')].filter((x) => getComputedStyle(x).display !== 'none').length,
        cards: document.querySelectorAll('.groups .phone .mcard').length, page: document.documentElement.scrollWidth - innerWidth }));
      if (w > 380) assert.ok(m.sparks > 0, `${w}: group cards show the spark`);   // ≤ 380 px: sparks step aside on every card, as on product cards
      assert.equal(m.page, 0, `${w}: no sideways scroll`);
    }
    assert.deepEqual(pg.errors, []);
    await pg.context().close();
  }
});

test('Footer names the build (SW-056); Data → Upload a CSV has no demo checkbox, it says the demo goes (SW-007)', opts, async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const pg = await page();
  await pg.goto(base + '/#data'); await pg.waitForSelector('#imp-go', { state: 'attached' });
  assert.match(await pg.textContent('#source .ver'), new RegExp(`^v${pkg.version.replace(/\./g, '\\.')} · ([0-9a-f]{7}|dev)$`));
  assert.equal(await pg.$('#imp-replace'), null, 'no checkbox');
  assert.match(await pg.textContent('#imp-go >> xpath=ancestor::details'), /Uploading replaces the demo data/);
  assert.deepEqual(pg.errors, []);
  await pg.context().close();
});

test('Reorder: every tab fits its box at 1280 and 1400 (All keeps Sales lost on screen); no sideways page scroll (critic r2 UI-1)', opts, async () => {
  for (const w of [1280, 1400]) {
    const pg = await page(w, 900);
    await pg.goto(base + '/?role=all#reorder'); await pg.waitForSelector('.tbl.desk table');
    for (const f of ['today', 'week', 'all']) {
      await pg.click(`[data-filter-reorder="${f}"]`); await pg.waitForSelector(`[data-filter-reorder="${f}"].on`);
      const m = await pg.evaluate(() => { const b = document.querySelector('.tbl.desk'), t = b.querySelector('table'), lost = t.querySelector('th[data-k="lost"]');
        return { tw: t.getBoundingClientRect().width, bw: b.clientWidth, lostRight: lost.getBoundingClientRect().right, page: document.documentElement.scrollWidth - innerWidth }; });
      assert.ok(m.tw <= m.bw + 1, `${w} ${f}: table ${m.tw} in ${m.bw}`);
      assert.ok(m.lostRight <= w, `${w} ${f}: Sales lost header at ${m.lostRight}`);
      assert.equal(m.page, 0, `${w} ${f}: page scrolls sideways`);
    }
    assert.deepEqual(pg.errors, []);
    await pg.context().close();
  }
});

test('Columns: every optional column is on by default; ones that do not fit step aside (named in a note), never a sideways scroll; unticking is remembered', opts, async () => {
  const OPT = { reorder: ['In stock', 'Sells', 'Times out'], products: ['Category', 'Sells', 'Units sold', 'Share of demand lost', 'Times out', 'Overstock ₹', 'Profit lost', 'Margin'] };
  for (const w of [1280, 1440, 1920]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
    const pg = await ctx.newPage(); const errors = []; pg.on('pageerror', (e) => errors.push(e.message));
    for (const view of ['products', 'reorder']) {
      await pg.goto(`${base}/?role=all#${view}`); await pg.waitForSelector('.tbl.desk table');
      const m = await pg.evaluate(() => { const b = document.querySelector('.tbl.desk'), t = b.querySelector('table');
        const shown = [...t.tHead.rows[0].cells].filter((c) => getComputedStyle(c).display !== 'none').map((c) => c.textContent.replace(/[↑↓]/g, '').trim());
        const aside = [...t.tHead.rows[0].cells].filter((c) => c.classList.contains('sq')).map((c) => c.textContent.replace(/[↑↓]/g, '').trim());
        return { shown, aside, tw: t.getBoundingClientRect().width, bw: b.clientWidth, scrollx: b.classList.contains('scrollx'), hint: document.querySelector('.sx-hint')?.textContent || '', page: document.documentElement.scrollWidth - innerWidth }; });
      assert.equal(m.page, 0, `${w} ${view}: the page never scrolls sideways`);
      assert.equal(m.scrollx, false, `${w} ${view}: no sideways scroll inside the table either`);
      assert.ok(m.tw <= m.bw + 1, `${w} ${view}: table ${m.tw} fits ${m.bw}`);
      for (const c of OPT[view]) assert.ok(m.shown.includes(c) || m.aside.includes(c), `${w} ${view}: ${c} is on (shown, or stepped aside for width)`);
      if (m.aside.length) assert.ok(m.aside.every((c) => m.hint.includes(c)), `${w} ${view}: the note names ${m.aside}`);
      else assert.equal(m.hint, '', `${w} ${view}: nothing aside, no note`);
      if (w === 1920 && view === 'reorder') assert.deepEqual(m.aside, [], '1920: every Reorder column fits');
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // untick → hidden, and still hidden after a reload (this browser remembers)
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 900 } }); const pg = await ctx.newPage();
  await pg.goto(`${base}/#reorder`); await pg.waitForSelector('.tbl.desk table');
  await pg.click('#view .colpick.desk > summary'); await pg.uncheck('[data-col="reorder|outs"]');
  assert.equal((await heads(pg)).includes('Times out'), false);
  await pg.reload(); await pg.waitForSelector('.tbl.desk table');
  assert.equal((await heads(pg)).includes('Times out'), false, 'remembered');
  assert.ok((await heads(pg)).includes('In stock'), 'the others stay on');
  await ctx.close();
});

test('final critic round 1, desktop: focus ring inside the period buttons (UI-1); Pause rows one line (UI-2); Reorder keeps In stock at 1280 (UI-3)', opts, async () => {
  const pg = await page(1440, 900);
  await pg.goto(base + '/?role=all#overview'); await pg.waitForSelector('.range button');
  await pg.focus('.range button:nth-child(2)'); await pg.keyboard.press('Shift+Tab');
  const ring = await pg.evaluate(() => { const b = document.activeElement; return { range: !!b.closest('.range'), off: getComputedStyle(b).outlineOffset, w: getComputedStyle(b).outlineWidth }; });
  assert.deepEqual(ring, { range: true, off: '-2px', w: '2px' }, 'keyboard focus: the ring sits inside, so .range (overflow hidden) does not clip it');
  await pg.context().close();
  for (const w of [1280, 1440, 1920]) {
    const p2 = await page(w, 900);
    await p2.goto(base + '/#products'); await p2.click('[data-filter-products="pause"]'); await p2.waitForSelector('[data-filter-products="pause"].on .c');
    const hs = await p2.$$eval('.tbl.desk tbody tr', (r) => r.map((x) => x.getBoundingClientRect().height));
    assert.ok(hs.length && Math.max(...hs) < 58, `${w}: Pause rows ${Math.max(...hs)} px (Back in stock wrapped)`);   // 1.4.0: 40 px picture + name/code lines ≈ 53 px
    assert.equal(await p2.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, `${w}: no sideways scroll`);
    if (w === 1280) {
      await p2.goto(base + '/?role=all#reorder'); await p2.waitForSelector('.tbl.desk table');
      assert.ok((await heads(p2)).includes('In stock'), `1280: In stock on screen (${await heads(p2)})`);
      const why = await p2.$$eval('.tbl.desk tbody .why', (x) => x.map((e) => [e.textContent, e.title]));
      assert.ok(why.every(([t]) => !/supplier takes/.test(t)), 'table Why leaves out the lead time tail');
      assert.ok(why.some(([, t]) => /supplier takes \d+ d$/.test(t)), 'its tooltip keeps it');
    }
    assert.deepEqual(p2.errors, []);
    await p2.context().close();
  }
});

test('final critic round 1: Overview tiles do not repeat the headline (SIMP-1); Reorder All headline adds up to its list (SIMP-2)', opts, async () => {
  const r = await (await fetch(base + '/api/report?days=30')).json(), t = r.totals;
  const pg = await page(1440, 900);
  await pg.goto(base + '/?role=all#overview'); await pg.waitForSelector('.tiles');
  const h1 = await pg.textContent('.headline h1');
  assert.match(h1, /^Order ₹.+ today · ₹.+ sales lost in 30 days$/, h1);
  const money = (sel) => pg.$eval(sel, (x) => x.textContent);
  const tiles = await pg.$$eval('#view > .tiles .tile b', (b) => b.map((x) => x.textContent));
  for (const v of tiles) assert.ok(!h1.includes(v), `tile ${v} repeats the headline`);
  assert.match(await money('.tile.lost span'), t.hasCost ? /^profit lost · / : /^of demand lost · /);
  await pg.click('.tile.amber'); await pg.waitForSelector('[data-filter-reorder="week"].on');
  await pg.click('[data-filter-reorder="all"]'); await pg.waitForSelector('[data-filter-reorder="all"].on');
  const week = r.reorder.filter((p) => p.status === 'Order this week'), today = r.reorder.filter((p) => ['Out now', 'Critical', 'Order now'].includes(p.status));
  const sum = (l) => l.reduce((a, p) => a + p.orderValue, 0);
  assert.equal(sum(today), t.orderValueNow); assert.equal(sum(today) + sum(week), t.orderValueAll, 'the All tab adds up to today + this week');
  assert.equal(today.length + week.length, r.reorder.length, 'All = Order today + This week');
  const rh = await pg.textContent('.headline h1');
  assert.match(rh, new RegExp(`today across ${t.orderToday} products · ₹.+ more this week \\(${week.length}\\)$`), rh);
  await pg.click('[data-filter-reorder="today"]'); await pg.waitForSelector('[data-filter-reorder="today"].on');
  assert.doesNotMatch(await pg.textContent('.headline h1'), /this week/, 'Order today tab: today only');
  assert.deepEqual(pg.errors, []);
  await pg.context().close();
});

test('final critic round 1, phones 390 and 360 (M2–M8, M10): Pause names readable, chips, cards, folds, range, text sizes', opts, async () => {
  for (const [w, h] of PHONES) {
    const pg = await page(w, h);
    await pg.goto(base + '/#products'); await pg.click('[data-filter-products="pause"]'); await pg.waitForSelector('[data-filter-products="pause"].on'); await pg.waitForSelector('.phone .mcard');
    const h3 = await pg.$$eval('.phone .mcard header h3', (x) => x.slice(0, 20).map((e) => e.getBoundingClientRect().width));
    assert.ok(Math.min(...h3) >= 150, `${w}: M2 Pause card names ${Math.min(...h3)} px wide`);
    const sortBy = await pg.$eval('.msort > span', (e) => e.getBoundingClientRect().height);
    assert.ok(sortBy < 25, `${w}: M10 "Sort by" on one line (${sortBy})`);
    await pg.goto(base + '/?role=all#reorder'); await pg.waitForSelector('.phone .mcard');
    const left = await pg.$$eval('.phone .mcard header h3', (x) => x.slice(0, 30).map((e) => Math.round(e.getBoundingClientRect().left)));
    assert.equal(new Set(left).size, 1, `${w}: M4 names start at one left edge (${[...new Set(left)]})`);
    const range = await pg.$$eval('.top .range button', (b) => b.map((x) => [x.innerText, x.getBoundingClientRect().width, x.getAttribute('aria-label')]));
    assert.ok(range.every(([, bw]) => bw >= 44), `${w}: M6 range widths ${range.map((x) => x[1])}`);
    assert.deepEqual(range.slice(0, 4).map((x) => [x[0], x[2]]), [['7d', '7 days'], ['14d', '14 days'], ['30d', '30 days'], ['60d', '60 days']], 'M6 short labels, full names for screen readers');
    /* M3: with an Ordered chip the row overflows; the active chip is scrolled in by the least (its right edge at the box's), not to the left edge */
    const r = await (await fetch(base + '/api/report?days=30')).json(), one = r.reorder.find((p) => p.status === 'Order this week');
    const eta = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
    assert.equal((await fetch(base + '/api/onorder', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ id: one.id, qty: 5, eta }] }) })).status, 200);
    try {
      await pg.goto(base + '/?role=all#reorder'); await pg.waitForSelector('[data-filter-reorder="ordered"]');
      await pg.click('[data-filter-reorder="ordered"]'); await pg.waitForSelector('[data-filter-reorder="ordered"].on');
      const m = await pg.$eval('.wrap > .toolbar .chips', (c) => { const b = c.getBoundingClientRect(), a = c.querySelector('.on').getBoundingClientRect(); return { over: c.scrollWidth > c.clientWidth + 1, scrolled: c.scrollLeft, l: a.left - b.left, r: b.right - a.right, cut: [...c.children].filter((x) => { const r = x.getBoundingClientRect(); return r.left < b.left - 0.5 && r.right > b.left + 6; }).map((x) => x.textContent), mask: getComputedStyle(c).maskImage || getComputedStyle(c).webkitMaskImage }; });   // the first 6 px are masked clear
      assert.ok(m.over, `${w}: fixture: the chips row overflows`);
      assert.ok(m.l >= 0 && m.r >= 0, `${w}: M3 Ordered chip in full ${JSON.stringify(m)}`);
      assert.deepEqual(m.cut, [], `${w}: final r2 M1: the row starts on a whole chip, never a bare count at the left edge ${JSON.stringify(m)}`);
      assert.match(m.mask, /gradient/, `${w}: final r2 M1: the scrolled edge fades`);
    } finally {
      await fetch(base + '/api/onorder', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ id: one.id, qty: 0 }] }) });
    }
    await pg.goto(base + '/?role=all#reorder'); await pg.waitForSelector('.phone .mcard');
    await pg.click('.phone .mcard h3'); await pg.waitForSelector('#drawer .pstory');   // 1.4.1: the 12-month stock chart, drawn when scrolled to
    await pg.evaluate(async () => { const c = document.querySelector('.drawer-card'); for (let y = 0; y < c.scrollHeight; y += 300) { c.scrollTop = y; await new Promise((r) => setTimeout(r, 40)); } });
    await pg.waitForSelector('svg[aria-label^="Stock at each day"] text');
    const over = await pg.$eval('svg[aria-label^="Stock at each day"]', (svg) => { const W = svg.viewBox.baseVal.width; return [...svg.querySelectorAll('text')].map((t) => t.getBBox()).filter((b) => b.x + b.width > W + 0.5 || b.x < -0.5).length; });
    assert.equal(over, 0, `${w}: M8 stock chart labels inside the chart`);
    await pg.goto(base + '/?role=all#overview'); await pg.waitForSelector('.tiles');
    assert.equal(await pg.$eval('.tile span', (e) => getComputedStyle(e).fontSize), '12px', `${w}: M7 tile context 12 px`);
    await pg.goto(base + '/?role=all#data'); await pg.waitForSelector('.panel.fold');
    const folds = await pg.$$eval('.panel.fold:not([open])', (f) => f.map((x) => x.getBoundingClientRect().height - x.querySelector('summary').getBoundingClientRect().height));
    assert.ok(folds.length && folds.every((d) => d <= 3), `${w}: M5 closed fold = its label (${folds})`);
    assert.equal(await pg.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    assert.deepEqual(pg.errors, []);
    await pg.context().close();
  }
});

test('final critic round 2, desktop: daily chart drawn at its width, 200 px tall, 12.5 px labels; Overview fits 900 px (UI-1, SIMP-A); AA colours (UI-2); Stock-outs leads with the action (SIMP-B)', opts, async () => {
  for (const w of [1280, 1440, 1920]) {
    const pg = await page(w, 900);
    await pg.goto(base + '/?role=all#overview'); await pg.waitForSelector('#daily-chart svg');
    const c = await pg.evaluate(() => { const s = document.querySelector('#daily-chart svg'), r = s.getBoundingClientRect(), t = s.querySelector('text');
      return { h: Math.round(r.height), scale: r.width / s.viewBox.baseVal.width, font: getComputedStyle(t).fontSize, bottom: document.querySelector('#daily-chart').getBoundingClientRect().bottom, sx: document.documentElement.scrollWidth - innerWidth }; });
    assert.equal(c.h, 200, `${w}: chart height`);
    assert.ok(Math.abs(c.scale - 1) < 0.01, `${w}: not scaled (${c.scale})`);
    assert.equal(c.font, '12.5px');
    assert.ok(c.bottom <= 900, `${w}: Overview ends at ${c.bottom} (fits 900)`);
    assert.equal(c.sx, 0);
    await pg.goto(base + '/?role=all#stockouts'); await pg.waitForSelector('.headline h1');
    assert.match(await pg.textContent('.headline h1'), /^\d+ still out, costing ₹[\d,.]+( L)?\/day$/, `${w}: SIMP-B h1 = the action`);
    assert.match(await pg.textContent('.headline p'), /products ran out \d+ times · ₹.* sales lost · ₹.* profit lost/);
    assert.deepEqual(pg.errors, []);
    await pg.context().close();
  }
  const pg = await page(1440, 900);
  await pg.goto(base + '/?role=all#overview'); await pg.waitForSelector('#daily-chart svg');
  const col = await pg.evaluate(() => {
    const probe = (cls, txt = 'x') => { const e = document.createElement('span'); e.className = cls; e.textContent = txt; document.body.append(e); const c = getComputedStyle(e); const r = [c.color, c.backgroundColor]; e.remove(); return r; };
    return { up: probe('tr up')[0], ok: probe('st ok'), badge: getComputedStyle(document.querySelector('#n-best')).backgroundColor };
  });
  const lum = (rgb) => { const [r, g, b] = rgb.match(/\d+/g).slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const cr = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  assert.ok(cr(col.up, 'rgb(255,255,255)') >= 4.5, `UI-2 trend up ${col.up}`);
  assert.ok(cr(col.ok[0], col.ok[1]) >= 4.5, `UI-2 OK pill ${col.ok}`);
  assert.ok(cr('rgb(255,255,255)', col.badge) >= 4.5, `UI-2 best sellers out badge (1.4.0: replaces the Stock-outs badge) ${col.badge}`);
  await pg.context().close();
});

test('final critic round 2, phones 390 and 360 (M1–M6, M8, M9): whole chips, toast clear of the bulk bar, sticky ×, money sizes, ₹ lost top-right, chart labels, Sort beside Search, 44 px', opts, async () => {
  for (const [w, h] of PHONES) {
    const pg = await page(w, h);
    await pg.goto(base + '/?role=all#reorder'); await pg.waitForSelector('.phone .mcard');
    /* M8: Plan settings one line; Search and Sort share a row; the first card starts higher */
    const m8 = await pg.evaluate(() => { const q = document.querySelector('.tq .search').getBoundingClientRect(), s = document.querySelector('.tq .msort select').getBoundingClientRect();
      return { plan: document.querySelector('.plan summary').getBoundingClientRect().height, row: Math.abs(q.top - s.top) < 1, label: document.querySelector('.tq .msort select').getAttribute('aria-label'), card: document.querySelector('.phone .mcard').getBoundingClientRect().top }; });
    assert.ok(m8.plan <= 45, `${w}: M8 Plan settings one line (${m8.plan})`);
    assert.ok(m8.row && m8.label === 'Sort by', `${w}: M8 Sort beside Search, named for screen readers`);
    assert.ok(m8.card < 360, `${w}: M8 first card at ${m8.card}`);
    /* M4: the order cost is 12.5 px and bold */
    assert.deepEqual(await pg.$eval('.mcard .mq small.mv', (e) => [getComputedStyle(e).fontSize, getComputedStyle(e).fontWeight]), ['12.5px', '600'], `${w}: M4`);
    /* M9: the ⋯ menu is 44 px wide */
    assert.ok(await pg.$eval('.wrap > .toolbar .colpick:not(.desk) > summary', (e) => e.getBoundingClientRect().width) >= 44, `${w}: M9 ⋯`);
    /* M2: tick a card, then a toast: it sits above "Mark N ordered" */
    await pg.click('.phone .mcard .mpick'); await pg.waitForSelector('.wrap > .bulk');
    const m2 = await pg.evaluate(() => { const t = document.getElementById('toast'); t.textContent = 'Saved'; t.hidden = false; const a = t.getBoundingClientRect(), b = document.getElementById('pick-mark').getBoundingClientRect(); t.hidden = true; return a.bottom <= b.top || a.top >= b.bottom; });
    assert.ok(m2, `${w}: M2 toast clear of the Mark button`);
    await pg.click('#pick-clear');
    /* M3: the × stays in view when the drawer is scrolled */
    await pg.click('.phone .mcard h3'); await pg.waitForSelector('#drawer:not([hidden]) .pstory');
    const x = await pg.evaluate(() => { const c = document.querySelector('.drawer-card'); c.scrollTop = c.scrollHeight; const r = document.getElementById('drawer-close').getBoundingClientRect(); return { top: r.top, w: r.width, h: r.height, scrolled: c.scrollTop > 100 }; });
    assert.ok(x.scrolled && x.top >= 0 && x.top < 30 && x.w >= 44 && x.h >= 44, `${w}: M3 × pinned ${JSON.stringify(x)}`);
    await pg.click('#drawer-close');
    /* M5: Products (sorted by ₹ lost): ₹ lost top-right, the status in the facts */
    await pg.goto(base + '/?role=all#products'); await pg.waitForSelector('.phone .mcard');
    const m5 = await pg.$eval('.phone .mcard', (c) => ({ mq: c.querySelector('header .mq')?.innerText.replace(/\n/g, ' '), st: !!c.querySelector('.mfacts .st'), hst: !!c.querySelector('header .st') }));
    assert.match(m5.mq || '', /^₹[\d,.]+( L)? sales lost$/, `${w}: M5 ${JSON.stringify(m5)}`);
    assert.ok(m5.st && !m5.hst, `${w}: M5 status moved to the facts`);
    /* M6: Overview chart labels are 12.5 px on screen (not scaled down); none outside the chart */
    await pg.goto(base + '/?role=all#overview'); await pg.waitForSelector('#daily-chart svg');
    const m6 = await pg.$eval('#daily-chart svg', (s) => ({ scale: s.getBoundingClientRect().width / s.viewBox.baseVal.width, font: getComputedStyle(s.querySelector('text')).fontSize, out: [...s.querySelectorAll('text')].map((t) => t.getBBox()).filter((b) => b.x < -0.5 || b.x + b.width > s.viewBox.baseVal.width + 0.5).length }));
    assert.ok(Math.abs(m6.scale - 1) < 0.01 && m6.font === '12.5px' && m6.out === 0, `${w}: M6 ${JSON.stringify(m6)}`);
    /* M9: Biggest losses "All" is 44 px wide */
    assert.ok(Math.min(...await pg.$$eval('.panel-head a', (a) => a.map((x) => x.getBoundingClientRect().width))) >= 44, `${w}: M9 panel link`);
    assert.equal(await pg.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    assert.deepEqual(pg.errors, []);
    await pg.context().close();
  }
});

/* 1.2.0 (LOGIC.md §4c): the line under the headline opens the rows apart; markers and the Confidence column */
test('§4c: "+ ₹ estimate · ₹ not restocked" under the headline opens those rows; markers; Confidence column; 1440 and 390', opts, async () => {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const pg = await page(w, h);
    await pg.goto(base + '/#overview'); await pg.waitForSelector('#view .headline h1');
    const r = await pg.evaluate(() => fetch('/api/report?days=30').then((x) => x.json()));
    const t = r.totals;
    assert.ok(t.lost + t.lostEstimate + t.lostNotRestocked + t.lostAllocation === t.lostAll, 'parts add up');
    if (!t.lostEstimate && !t.lostNotRestocked) { assert.equal(await pg.$('#lost-sub'), null, 'nothing apart: no line'); await pg.context().close(); continue; }
    const kind = t.lostEstimate ? 'estimate' : 'notrestocked';
    assert.match(await pg.textContent('#lost-sub'), /^Not in ₹/, '1.3.0 (UI-5): the line says these are not in the headline');
    await pg.click(`#lost-sub a[data-filter="${kind}"]`);
    await pg.waitForSelector('#f-more.on');
    assert.equal(await pg.inputValue('#f-more'), kind);
    assert.ok((await pg.$$(`#view .lmark`)).length > 0, 'rows carry a marker');
    /* UI-3: the filtered view leads with that part's own ₹, never "₹0 lost" */
    assert.match(await pg.textContent('#bucket-line'), /^₹[\d,.]+( L)? (estimated from few sales|after day \d+)/);
    assert.equal(await pg.$('#view .headline .lostv'), null, 'no "₹0 lost" in the filtered view');
    await pg.goto(base + '/#stockouts'); await pg.waitForSelector('#lost-sub');
    await pg.click(`#lost-sub a[data-filter="${kind}"]`);
    await pg.waitForSelector(`[data-filter-stockouts="${kind}"].on`);
    if (w > 760) assert.ok((await heads(pg)).includes('Confidence'), 'Stock-outs has the Confidence column');
    assert.equal(await pg.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    assert.deepEqual(pg.errors, []);
    await pg.context().close();
  }
});

/* 1.3.0: counted ₹ red / the rest grey, allocation rows, "out since", still-out apart, drawer split; 1440 and 390 */
test('1.3.0: grey parts apart, Top-up from warehouse, "since <date>" for open stock-outs, still-out apart, drawer split', opts, async () => {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const pg = await page(w, h); pg.setDefaultTimeout(10000);
    await pg.goto(base + '/#products'); await pg.waitForSelector('#view .headline h1');
    const r = await pg.evaluate(() => fetch('/api/report?days=30').then((x) => x.json()));
    const t = r.totals;
    /* a row whose ₹ is all estimate shows grey "₹X est.", never in red */
    const est = r.products.find((p) => p.lostEstimate > 0 && !p.lostCounted);
    if (est) {
      const sel = w > 760 ? `.tbl.desk tr[data-id="${est.id}"]` : `.mcard[data-id="${est.id}"]`;
      await pg.selectOption('#f-more', 'estimate'); await pg.waitForSelector(sel);
      assert.equal(await pg.$eval(`${sel} .lmark`, (e) => !!e.parentElement.querySelector('.lostv')), false, `${w}: an estimate-only row's Sales lost has no red ₹`);
      assert.match(await pg.textContent(`${sel} .lmark`), /^₹[\d,.]+( L)? est\.$/);
      const grey = await pg.$eval(`${sel} .lmark`, (e) => getComputedStyle(e).color);
      const soft = await pg.evaluate(() => { const d = document.createElement('span'); d.style.color = 'var(--soft)'; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; });
      assert.equal(grey, soft, `${w}: the estimate is grey (UI-8: phones too)`);
    }
    /* website allocations: their own status, not on Reorder, a note there */
    if (t.allocation && w > 760) {   // phones hide the .exp lines on Reorder (M8: the first card starts high); Products and Data say it there
      await pg.goto(base + '/#reorder'); await pg.waitForSelector('#alloc-note');
      assert.match(await pg.textContent('#alloc-note'), /website allocation refilled from the warehouse.*Check the warehouse\./);
      await pg.click('#alloc-note a'); await pg.waitForSelector('#f-more.on');
      assert.equal(await pg.inputValue('#f-more'), 'warehouse');
      assert.match(await pg.textContent('#view'), /Top-up from warehouse/);
    }
    if (t.allocation && w <= 760) { await pg.goto(base + '/#products'); await pg.waitForSelector('#f-more'); await pg.selectOption('#f-more', 'warehouse'); await pg.waitForSelector('.mcard'); assert.match(await pg.textContent('#view'), /Top-up from warehouse/); }
    /* Stock-outs: open stock-outs say since when; the still-out ₹/day is the counted part, the rest apart */
    await pg.goto(base + '/#stockouts'); await pg.waitForSelector('#view .headline h1');
    const txt = await pg.textContent('#view');
    if (r.stockouts.some((s) => s.open && !s.notSelling)) assert.match(txt, /since (before )?\d+ \w{3}/, `${w}: "since <date>" for an open stock-out`);
    if (t.stillOutPerDayApart > 0) assert.match(await pg.textContent('#still-apart'), /^\+₹[\d,.]+( L)?\/day not counted$/);
    /* drawer: the split in words under the ₹ (touch has no tooltips) */
    const split = r.products.find((p) => p.lost > 0 && p.lost !== p.lostCounted && p.stock != null);
    if (split) {
      await pg.goto(base + '/#products'); await pg.waitForSelector('#q-products');
      const sel = w > 760 ? `.tbl.desk tr[data-id="${split.id}"]` : `.mcard[data-id="${split.id}"]`;
      await pg.fill('#q-products', split.sku || split.name); await pg.waitForSelector(sel);
      await pg.click(sel); await pg.waitForSelector('#drawer details.fold summary');
      await pg.click('#drawer details.fold summary'); await pg.waitForSelector('#lost-split');   // 1.4.1: the 30-day detail sits under one fold
      assert.match(await pg.textContent('#lost-split'), /^in headline ₹[\d,.]+( L)? · /);
      await pg.keyboard.press('Escape');
    }
    assert.equal(await pg.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    assert.deepEqual(pg.errors, []);
    await pg.context().close();
  }
});
