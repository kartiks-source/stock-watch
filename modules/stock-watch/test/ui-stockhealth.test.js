'use strict';
/*
 * 4.8.0 in the browser (LOGIC §35): the drawer's one line and its two tiles when Shopify's stock log can't show a product's
 * stock-outs (unseen, keep selling), nothing new when it can (ok); the brand page's "· N can't be seen in Shopify". 1440x900 and
 * 390x844, no sideways scroll. Demo data, with the API's stockSeen / cantSee set in the answer (route), so each case is shown.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pw = null;
try { pw = require(process.env.PLAYWRIGHT_PATH || 'playwright'); } catch { /* not installed: skip */ }
const opts = { skip: pw ? false : 'Playwright not found (set PLAYWRIGHT_PATH)' };

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-ui-health-'));
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

const SIZES = [[1440, 900], [390, 844]];
const sideways = (pg) => pg.evaluate(() => document.documentElement.scrollWidth - innerWidth);
/** A page whose /api/product answers carry `edit(profile)` */
async function page(w, h, url, ready, route = null) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const pg = await ctx.newPage(); pg.errors = []; pg.on('pageerror', (e) => pg.errors.push(e.message));
  if (route) await pg.route(route.match, async (r) => { const res = await r.fetch(), j = await res.json(); route.edit(j); await r.fulfill({ response: res, json: j }); });
  await pg.goto(base + url); await pg.waitForSelector(ready);
  return pg;
}
async function drawer(w, h, edit) {
  const pg = await page(w, h, '/?store=sammsara-demo#best', w < 760 ? '#view .mcard' : '#view table[data-table="best"] tbody tr', { match: /\/api\/product\//, edit: (j) => { if (j.profile && j.profile.ok) edit(j.profile); } });
  await pg.click(w < 760 ? '#view .mcard' : '#view table[data-table="best"] tbody tr');
  await pg.waitForSelector('#drawer .pstory');
  return pg;
}

test('1440 + 390: unseen: one line above the stock graph, On the shelf "not known", Ran out keeps its days with "may be wrong"', opts, async () => {
  for (const [w, h] of SIZES) {
    const pg = await drawer(w, h, (p) => { p.stockSeen = 'unseen'; p.seen = { seen: 26, of: 329 }; p.outs = { ...p.outs, times: 2, days: 12.5, longest: { from: p.span.from, to: p.span.from, days: 9 } }; });
    assert.equal(await pg.textContent('#unseen'), 'Shopify’s stock count didn’t change on most days this sold (303 of 329 pieces), so its stock line and days out may be wrong.');
    assert.equal(await pg.evaluate(() => document.getElementById('unseen').closest('section').querySelector('h2').textContent), 'Stock level', 'in the Stock level panel, above its graph');
    assert.ok(await pg.evaluate(() => { const u = document.getElementById('unseen'), c = u.closest('section').querySelector('.chartbox'); return !!(u.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING); }));
    assert.equal(await pg.textContent('#shelf-tile b'), 'not known');
    assert.match(await pg.textContent('#out-tile b'), /^2× · 12\.5 days$/); assert.match(await pg.textContent('#out-tile small'), /^may be wrong · longest/);
    assert.equal(await sideways(pg), 0, `${w}: no sideways scroll`);
    assert.deepEqual(pg.errors, []);
    await pg.context().close();
  }
});

test('1440 + 390: unseen that never shows a stock-out, and keep selling: "can’t be seen in Shopify", no "never ran out"', opts, async () => {
  for (const [w, h] of SIZES) {
    for (const kind of ['unseen', 'always']) {
      const pg = await drawer(w, h, (p) => { p.stockSeen = kind; p.seen = { seen: 2, of: 40 }; p.outs = { times: 0, days: 0, longest: null, open: false, since: null }; if (p.work) p.work.gaps = []; });
      assert.equal(await pg.textContent('#shelf-tile b'), 'not known', kind);
      assert.equal(await pg.textContent('#out-tile b'), 'can’t be seen in Shopify', kind);
      const story = await pg.textContent('#drawer .pstory');
      assert.match(story, /Whether it ran out can’t be seen in Shopify\./); assert.ok(!/never ran out/.test(story));
      if (kind === 'always') assert.equal(await pg.$('#unseen'), null, 'keep selling: its own note, no unseen line');
      assert.equal(await sideways(pg), 0, `${w} ${kind}`);
      assert.deepEqual(pg.errors, []);
      await pg.context().close();
    }
  }
});

test('1440 + 390: ok: nothing new in the drawer', opts, async () => {
  for (const [w, h] of SIZES) {
    const pg = await drawer(w, h, (p) => { p.stockSeen = 'ok'; p.seen = { seen: 300, of: 310 }; });
    assert.equal(await pg.$('#unseen'), null);
    assert.match(await pg.textContent('#shelf-tile b'), /^\d+% of the (year|days)$/);
    assert.ok(!/can’t be seen/.test(await pg.innerText('#drawer')));
    await pg.context().close();
  }
});

test('1440 + 390: the brand page says "· N can’t be seen in Shopify" beside the best sellers that ran out, only when N > 0', opts, async () => {
  for (const [w, h] of SIZES) {
    for (const n of [3, 0]) {
      const pg = await page(w, h, '/?store=sammsara-demo', '#view .brand-h h1', { match: /\/api\/brand/, edit: (j) => { for (const m of j.months || []) m.cantSee = n; if (j.headline) j.headline.cantSee = n; } });
      const t = await pg.textContent('.brand-h h1');
      if (n) assert.match(t, /^[\d,]+ of [\d,]+ best sellers ran out in \w+( \d{4})? · 3 can’t be seen in Shopify\. /); else assert.ok(!/can’t be seen/.test(t), t);
      if (n) {
        await pg.click('.scope button[data-scope="all"]'); await pg.waitForFunction(() => /products ran out/.test(document.querySelector('.brand-h h1').textContent));
        assert.ok(!/can’t be seen/.test(await pg.textContent('.brand-h h1')), 'All products: not shown');
      }
      assert.equal(await sideways(pg), 0, `${w} ${n}`);
      assert.deepEqual(pg.errors, []);
      await pg.context().close();
    }
  }
});
