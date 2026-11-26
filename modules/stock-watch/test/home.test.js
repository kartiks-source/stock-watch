'use strict';
/* 4.2.0: the home page, month first. On small made-up stores (the same shapes as test/truth.test.js): the month it opens on, days to
   refill, the list ₹ adding up to the month's headline, the ₹0 line, the dates of the month before, All products' period = the home
   page's month for the same dates and scope, and the agency's start date setting (real server, temp DATA_DIR). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-home-'));
for (const k of ['ADMIN_PASSWORD', 'VIEW_PASSWORD', 'SHOPIFY_STORE', 'STORES', 'PERFORMITY_POC_API_URL', 'PERFORMITY_POC_API_KEY', 'AZURE_KEY_VAULT_URL']) delete process.env[k];
const T = require('../src/truth'), S = require('../src/screen');
const { keyPlus } = require('../src/agency');
const FROM = '2025-11-01', N = 390, TO = keyPlus(FROM, N - 1), DAY = (i) => keyPlus(FROM, i), IX = (k) => Math.round((Date.parse(k) - Date.parse(FROM)) / 864e5);
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);

/** rows { id, sell(i), price, gaps: [[a, b]] (empty from the day's end of a to the refill on b) } → year.json + catalog */
function shop(rows) {
  const y = { sales: { from: FROM, to: TO, by: {}, all: {} }, moves: { from: FROM, to: TO, by: {} }, anchor: { at: 1, day: keyPlus(TO, 1), levels: {} }, done: true }, cat = {};
  for (const r of rows) {
    cat[r.id] = { productId: r.product || `p${r.id}`, product: r.name || `Row ${r.id}`, variant: '', price: r.price, active: true, tracked: true, ...(r.createdAt ? { createdAt: r.createdAt } : {}) };
    const st = (i) => (r.gaps || []).some(([a, b]) => i >= a && i < b) ? 0 : 50, by = {}, mv = {};
    for (let i = 0; i < N; i++) {
      const full = st(i) > 0 && (i === 0 ? st(0) > 0 : st(i - 1) > 0), u = full ? r.sell(i) : 0;
      if (u) { by[DAY(i)] = [u, u * r.price, 0, u * r.price]; const t = y.sales.all[DAY(i)] || (y.sales.all[DAY(i)] = [0, 0]); t[0] += u; t[1] += u * r.price; }
      const d = st(i) - (i ? st(i - 1) : st(0)); if (d) mv[DAY(i)] = d;
    }
    y.sales.by[r.id] = by; y.moves.by[r.id] = mv; y.anchor.levels[r.id] = st(N - 1);
  }
  return T.report(y, cat, { dayOf: (t) => new Date(t).toISOString().slice(0, 10) });
}
const steady = (n = 12, start = 100) => Array.from({ length: n }, (_, k) => ({ id: String(start + k), price: 1000, sell: (i) => ((i + k) % 2 === 0 ? 1 : 0) }));
const gap = (a, b) => [IX(a), IX(b)];
/** a store with best sellers and others out in Aug, Oct and Nov; one too new for ₹, one out past 60 days */
const store = () => shop([...steady(),
  ...Array.from({ length: 6 }, (_, k) => ({ id: `${k + 1}`, price: 2000, sell: (i) => ((i + k) % 2 ? 1 : 0), gaps: [gap('2026-08-05', '2026-08-15'), gap('2026-10-25', '2026-11-04')] })),
  { id: '7', price: 300, sell: (i) => (i % 9 === 0 ? 1 : 0), gaps: [gap('2026-10-20', '2026-11-30')] },
  { id: '8', price: 2000, sell: () => 1, createdAt: Date.parse('2026-07-20T05:00:00Z'), gaps: [gap('2026-08-05', '2026-08-09')] },
  { id: '9', price: 2000, sell: (i) => (i % 2 ? 1 : 0), gaps: [gap('2026-06-01', '2026-11-30')] }]);

test('the month it opens on: this month; on the 1st–3rd last month (a month closes 3 days after it ends)', () => {
  const keys = ['2026-09', '2026-10', '2026-11'];
  assert.equal(S.defaultMonth('2026-11-10', keys), '2026-11', 'day 10: this month');
  assert.equal(S.defaultMonth('2026-11-02', keys), '2026-10', 'day 2: last month');
  assert.equal(S.defaultMonth('2026-11-03', keys), '2026-10', 'day 3: last month');
  assert.equal(S.defaultMonth('2026-11-04', keys), '2026-11', 'day 4: this month');
  assert.equal(S.defaultMonth('2026-12-01', keys), '2026-11', 'the 1st: last month (this one is not held yet)');
  assert.equal(S.defaultMonth('2027-01-02', ['2026-12']), '2026-12', 'across a year');
  assert.equal(S.defaultMonth('2026-11-10', []), null);
  const b = S.brand(store(), { today: '2026-11-26' }); assert.equal(b.home.defaultMonth, '2026-11'); assert.equal(b.home.stripFrom, b.months[0].from);
  assert.equal(S.brand(store(), { today: '2026-12-02' }).home.defaultMonth, '2026-11');
});

test('days to refill = the middle stock-out that came back that month, for the scope; never one still out or off the website', () => {
  const b = S.brand(store(), { today: '2026-11-26' }), m = (k) => b.months.find((x) => x.key === k);
  /* Aug: six best sellers back on 15 Aug after 10 empty days (5 Aug ½ … 15 Aug ½) and one new product back on 9 Aug after 4 */
  assert.equal(m('2026-08').best.refill, 10); assert.ok(m('2026-08').best.refills >= 6);
  assert.equal(m('2026-08').all.refills, 7); assert.equal(m('2026-08').all.refill, 10);
  /* Nov: the six back on 4 Nov after 10 days; row 7 and row 9 are still out: not counted */
  assert.equal(m('2026-11').all.refills, 6); assert.equal(m('2026-11').all.refill, 10);
  assert.equal(m('2026-09').all.refill, null, 'none came back');
  assert.equal(S.median([1, 3, 10]), 3); assert.equal(S.median([1, 2, 3, 10]), 2.5); assert.equal(S.median([]), null);
  assert.equal(b.headline.all.refills, 13); assert.equal(b.headline.all.refill, 10);
});

test('the month list: its ₹ adds up to the headline Missed for the month and scope; the Past months row is the same number', () => {
  const b = S.brand(store(), { today: '2026-11-26' });
  for (const m of b.months) for (const sc of ['best', 'all']) {
    const rows = b.products.filter((p) => p.months[m.key] && (sc === 'all' || p.months[m.key].best)), paid = rows.filter((p) => p.months[m.key].counted > 0);
    near(paid.reduce((s, p) => s + p.months[m.key].counted, 0), m[sc].lost, rows.length / 2 + 0.01);
    assert.equal(rows.length, m[sc].out, `${m.key} ${sc}: X in "X of Y" = the rows`);
  }
  const aug = b.months.find((x) => x.key === '2026-08');
  assert.ok(aug.best.lost > 0 && aug.all.lost >= aug.best.lost); assert.ok(b.months.find((x) => x.key === '2026-11').all.lost > b.months.find((x) => x.key === '2026-11').best.lost, 'row 7 is off the list'); assert.equal(aug.listN, b.bestList.n);
  near(b.months.reduce((s, m) => s + m.best.lost, 0), b.headline.best.lost, 1);
  const p = b.products.find((x) => x.variantId === '1'), c = p.months['2026-08'];
  assert.equal(c.rank > 0, true, 'rank on that month’s list'); assert.ok(c.countedDays > 0 && Math.abs(c.countedDays * (c.counted / c.countedDays) - c.counted) < 1, 'N days × ₹A a day = the ₹');
  assert.equal(p.strip.length, b.products.find((x) => x.variantId === '9').strip.length); assert.match(p.strip, /^[-012]+$/);
});

test('the ₹0 line: empty but no ₹ (too little history, out 60+ days) is kept apart with its reason; its ₹ is 0', () => {
  const b = S.brand(store(), { today: '2026-11-26' });
  const young = b.products.find((x) => x.variantId === '8').months['2026-08'], long = b.products.find((x) => x.variantId === '9').months['2026-10'];
  assert.equal(young.counted, 0); assert.deepEqual(young.why, ['few-days']); assert.ok(young.daysOut > 0);
  assert.equal(long.counted, 0); assert.deepEqual(long.why, ['later']); assert.equal(S.WHY_SHORT.later, 'out 60+ days'); assert.equal(S.WHY_SHORT['few-days'], 'too little history');
  const p9 = b.products.find((x) => x.variantId === '9'); assert.equal(p9.outNow, true); assert.equal(p9.since, '2026-06-01');
});

test('the same dates of the month before: so far for an open month, the whole month for a closed one; any dates add up', () => {
  const t = store(), b = S.brand(t, { today: '2026-11-26' }), nov = b.months.find((x) => x.key === '2026-11'), sep = b.months.find((x) => x.key === '2026-09');
  assert.equal(nov.closed, false); assert.deepEqual([nov.prev.from, nov.prev.to, nov.prev.whole], ['2026-10-01', `2026-10-${nov.to.slice(8)}`, false]);
  assert.equal(sep.prev.whole, true); assert.equal(sep.prev.all.lost, b.months.find((x) => x.key === '2026-08').all.lost);
  let lost = 0; for (const x of t.rows) if (x.months['2026-10']) lost += S.between(t, x, nov.prev.from, nov.prev.to).lost;
  near(nov.prev.all.lost, lost, 1);
  /* a whole month cut in two adds back up to the month */
  let a = 0, c = 0; for (const x of t.rows) { a += S.between(t, x, '2026-10-01', '2026-10-24').lost; c += S.between(t, x, '2026-10-25', '2026-10-31').lost; }
  near(a + c, b.months.find((x) => x.key === '2026-10').all.lost, 1);
  assert.deepEqual(S.prevRange({ closed: false, to: '2026-03-30' }, { key: '2026-02', from: '2026-02-01', to: '2026-02-28' }), { from: '2026-02-01', to: '2026-02-28', whole: true }, 'Feb has 28 days');
});

test('All products for the same dates and scope = the home page: a month as a period, both scopes, each month its own list', () => {
  const t = store(), b = S.brand(t, { today: '2026-11-26' });
  for (const key of ['2026-08', '2026-10', '2026-11']) {
    const m = t.months.find((x) => x.key === key), B = b.months.find((x) => x.key === key);
    const all = { products: t.rows.map((x) => ({ id: x.id, sold: 0 })), totals: { sold: 0 }, daily: [] };
    S.period(all, t, { from: m.from, to: m.to }); near(all.totals.lost, B.all.lost, t.rows.length / 2);
    const set = new Set(m.ids.keys()), best = { products: t.rows.filter((x) => set.has(x.id)).map((x) => ({ id: x.id, sold: 0 })), totals: { sold: 0 }, daily: [] };
    S.period(best, t, { from: m.from, to: m.to, only: true, bestSet: set }); near(best.totals.lost, B.best.lost, t.rows.length / 2);
    assert.ok(best.products.every((p) => p.abc === 'A'));
  }
});

test('the rows held (demo): the same home fields — strip, days to refill, the month before, the month it opens on', async () => {
  const { server } = require('../server');
  await new Promise((ok) => server.listen(0, ok));
  const base = `http://127.0.0.1:${server.address().port}`, q = '?store=sammsara-demo';
  try {
    assert.equal((await fetch(`${base}/api/demo${q}`, { method: 'POST' })).status, 200);
    const j = await (await fetch(`${base}/api/brand${q}`)).json(), ms = j.months.filter((m) => m.days);
    assert.ok(ms.some((m) => m.key === j.home.defaultMonth));
    assert.ok(ms.slice(1).every((m) => m.prev && m.prev.best && m.prev.all));
    assert.ok(ms.every((m) => 'refill' in m.best && m.listN === j.headline.bestsellers));
    const p = j.products.find((x) => x.daysOut > 0); assert.match(p.strip, /^[-012]+$/); assert.ok(Array.isArray(p.ends));
    for (const m of ms) for (const sc of ['best', 'all']) {
      const rows = j.products.filter((x) => x.months && x.months[m.key] && !x.allApart && (sc === 'all' || x.best));
      near(rows.reduce((s, x) => s + (x.months[m.key].counted || 0), 0), m[sc].lost, 1);
    }

    /* 4.2.0: "We started on": a real day or nothing; saved per store, in the change log; nonsense refused */
    const put = (v) => fetch(`${base}/api/settings${q}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agencyStart: v }) });
    const read = async () => (await (await fetch(`${base}/api/settings${q}`)).json());
    assert.equal((await put('2026-08-01')).status, 200); assert.equal((await read()).settings.agencyStart, '2026-08-01');
    assert.ok((await read()).changes.some((c) => c.key === 'agencyStart' && c.new === '2026-08-01'), 'in the change log');
    for (const bad of ['2026-02-30', '1 Aug 2026', '2026-8-1', 'x', '1999-12-31', '2099-01-01']) assert.equal((await put(bad)).status, 400, bad);
    assert.equal((await read()).settings.agencyStart, '2026-08-01', 'a refused value changes nothing');
    const n = (await read()).changes.length; assert.equal((await put('2026-08-01')).status, 200); assert.equal((await read()).changes.length, n, 'the same day again: no change logged');
    assert.equal((await put('')).status, 200); assert.equal((await read()).settings.agencyStart, null, 'empty clears it');
    assert.equal((await fetch(`${base}/api/settings?store=second-demo`).then((r) => r.json())).settings.agencyStart, undefined, 'per store');
  } finally { await new Promise((ok) => server.close(ok)); }
});
