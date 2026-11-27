'use strict';
/* 4.8.0 (LOGIC §35). Part B: can Shopify's stock log see a variant's stock-outs? (share of pieces sold on days the count moved,
   under 50% with 5+ pieces = unseen; keep selling = always; a walk that doesn't add up = unsure). Labels only: money unchanged.
   Part A: the daily history of "Continue selling when out of stock" (src/policy.js): a flip, a failed or partial refresh, a
   missing variant, and the engine applying it day by day. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const T = require('../src/truth'), A = require('../src/agency'), P = require('../src/policy'), S = require('../src/screen'), SH = require('../src/shopify');
const { keyPlus } = A;
const FROM = '2025-11-01', N = 390, DAY = (i) => keyPlus(FROM, i), IX = (k) => Math.round((Date.parse(k) - Date.parse(FROM)) / 864e5);
const opts = { dayOf: (t) => new Date(t).toISOString().slice(0, 10) };

/** rows { id, price, sell(i), level(i) (stock at the day's end), oversell, log(i, move) → the move Shopify logged (default: all of it) } */
function shop(rows, n = N) {
  const to = keyPlus(FROM, n - 1), y = { sales: { from: FROM, to, by: {}, all: {} }, moves: { from: FROM, to, by: {} }, anchor: { at: 1, day: keyPlus(to, 1), levels: {} }, done: true }, cat = {};
  for (const r of rows) {
    cat[r.id] = { productId: `p${r.id}`, product: r.name || `Row ${r.id}`, variant: '', price: r.price, active: true, tracked: true, ...(r.oversell ? { oversell: true } : {}) };
    const by = {}, mv = {};
    for (let i = 0; i < n; i++) {
      const u = r.sell(i); if (u) { by[DAY(i)] = [u, u * r.price, 0, u * r.price]; const t = y.sales.all[DAY(i)] || (y.sales.all[DAY(i)] = [0, 0]); t[0] += u; t[1] += u * r.price; }
      const d = r.level(i) - (i ? r.level(i - 1) : r.level(0)), logged = r.log ? r.log(i, d) : d; if (logged) mv[DAY(i)] = logged;
    }
    y.sales.by[r.id] = by; y.moves.by[r.id] = mv; y.anchor.levels[r.id] = r.level(n - 1);
  }
  return { y, cat };
}
/* steady sellers: stock falls by each sale and is topped up every 20 days, every change logged */
const steady = (id, price, every = 2) => { const sell = (i) => (i % every === 0 ? 1 : 0); let lv = []; let L = 200; for (let i = 0; i < N; i++) { L -= sell(i); if (i % 20 === 19) L += 10; lv.push(L); } return { id, price, sell, level: (i) => lv[i] }; };
const many = (k, start, price) => Array.from({ length: k }, (_, j) => steady(String(start + j), price, 2 + (j % 3)));

test('seenOf / stockSeenOf: under half the pieces on days the count moved, with 5+ pieces = unseen; keep selling and unsure first', () => {
  /* the count never moves while it sells (Shopify's count not kept) */
  const y = { sales: { by: { a: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [DAY(i), [2, 200]])) } }, moves: { by: { a: { [DAY(3)]: -2, [DAY(10)]: 40 } } } };
  const s = A.seenOf(y, 'a', DAY(0), DAY(29));
  assert.deepEqual(s, { seen: 4, of: 60, net: 60, netSeen: 4 }, 'pieces on the 2 days the count moved, of 60');
  assert.equal(A.stockSeenOf(s), 'unseen');
  assert.equal(A.stockSeenOf({ seen: 0, of: 4 }), 'ok', 'under 5 pieces: too few to tell');
  assert.equal(A.stockSeenOf({ seen: 5, of: 10 }), 'ok', 'half exactly is seen');
  assert.equal(A.stockSeenOf({ seen: 4, of: 10 }), 'unseen');
  assert.equal(A.stockSeenOf({ always: true, seen: 0, of: 60 }), 'always');
  assert.equal(A.stockSeenOf({ unsure: true, seen: 0, of: 60 }), 'unsure');
  assert.deepEqual(A.seenOf(y, 'a', DAY(5), DAY(9)), { seen: 0, of: 10, net: 10, netSeen: 0 }, 'only the window');
  const ret = { sales: { by: { a: { [DAY(0)]: [-3, -300], [DAY(1)]: [6, 600] } } }, moves: { by: { a: { [DAY(1)]: -6 } } } };
  assert.deepEqual(A.seenOf(ret, 'a', DAY(0), DAY(1)), { seen: 6, of: 6, net: 3, netSeen: 6 }, 'a return day is not a day it sold; net takes it off');
});

test('a Cascade-like product: every sale logged day by day, restocks (even one that cancels the day’s sales) stay ok', () => {
  /* sells 1–3 a day; the log has each day's net change; restocks every 12 days; on 4 restock days the refill equals the sales: no change logged */
  const sell = (i) => 1 + (i % 3);
  const lv = []; let L = 40; for (let i = 0; i < N; i++) { L -= sell(i); if (i % 12 === 11) L += i % 48 === 47 ? sell(i) : 30; lv.push(L); }
  const row = { id: 'c', name: 'Cascade-like table', price: 5000, sell, level: (i) => lv[i] }, { y, cat } = shop([row, ...many(10, 100, 800)]);
  const s = A.seenOf(y, 'c', DAY(0), DAY(N - 1)); assert.ok(s.seen / s.of > 0.9, `${s.seen} of ${s.of}`);
  const r = T.report(y, cat, opts), x = r.rows.find((z) => z.id === 'c');
  assert.equal(x.stockSeen, 'ok'); assert.ok(x.seen.of > 0);
});

test('unseen on the report, the brand page and the drawer: labels only, the money is the same as without them', () => {
  const sell = (i) => (i % 2 ? 1 : 0), level = () => 50;   // sells, but Shopify's count never moves
  const ks = { id: 'k', price: 900, sell, level: (i) => 30 - Math.floor(i / 2), oversell: true };   // keeps selling at 0
  const rows = [{ id: 'u', name: 'Unseen clutch', price: 2000, sell, level }, ks, ...many(6, 100, 500)];
  const { y, cat } = shop(rows), r = T.report(y, cat, opts), u = r.rows.find((z) => z.id === 'u'), k = r.rows.find((z) => z.id === 'k');
  assert.equal(u.stockSeen, 'unseen'); assert.deepEqual(u.seen, { seen: 0, of: u.pieces, net: u.pieces, netSeen: 0 }); assert.equal(k.stockSeen, 'always');
  assert.ok(u.best && k.best, 'both on the best-seller list');
  const b = S.brand(r, { today: '2026-11-25' });
  assert.equal(b.products.find((p) => p.variantId === 'u').stockSeen, 'unseen');
  assert.deepEqual(b.products.find((p) => p.variantId === 'u').seen, u.seen);
  assert.equal(b.headline.cantSee, 2, 'keep-selling and unseen best sellers');
  for (const m of b.months) assert.equal(m.cantSee, [...r.months.find((z) => z.key === m.key).ids.keys()].filter((id) => id === 'u' || id === 'k').length, m.key);
  const pr = S.profile({ ok: true, months: [] }, r, 'u'); assert.equal(pr.stockSeen, 'unseen'); assert.deepEqual(pr.seen, u.seen);
  /* the 12-month build behind the drawer says the same */
  const bd = A.build(y, cat, { ...opts, detail: true }), own = Object.defineProperty({ ...bd, window: { from: r.span.from, through: r.span.to } }, 'details', { value: bd.details }), prof = A.profile(own, y, cat, 'u');
  assert.equal(prof.stockSeen, 'unseen'); assert.deepEqual(prof.seen, u.seen);
  assert.equal(A.profile(bd, y, cat, 'k').stockSeen, 'always');
  /* nothing else moved */
  const strip = (z) => JSON.stringify(z, (key, v) => (key === 'stockSeen' || key === 'seen' ? undefined : v));
  assert.equal(strip(T.report(y, cat, { ...opts, policy: {} })), strip(r));
});

test('policy.record: the first refresh starts each variant; a flip is dated to the refresh day; same-day flip back is no change', () => {
  let h = P.record({}, { a: false, b: true }, '2026-11-27');
  assert.deepEqual(h.by, { a: [['2026-11-27', 0]], b: [['2026-11-27', 1]] }); assert.deepEqual(h.changed.sort(), ['a', 'b']);
  const same = P.record(h.by, { a: false, b: true }, '2026-11-28'); assert.deepEqual(same.changed, []); assert.equal(same.by, h.by, 'nothing new: the same object');
  h = P.record(h.by, { a: true, b: true }, '2026-12-03');
  assert.deepEqual(h.by.a, [['2026-11-27', 0], ['2026-12-03', 1]]); assert.deepEqual(h.changed, ['a']);
  const back = P.record(h.by, { a: false }, '2026-12-03'); assert.deepEqual(back.by.a, [['2026-11-27', 0]], 'flipped and back the same day');
  assert.equal(P.at(h.by.a, '2026-12-02'), false); assert.equal(P.at(h.by.a, '2026-12-03'), true); assert.equal(P.at(h.by.a, '2026-11-01'), false, 'before the first row: its earliest value');
  assert.equal(P.at(undefined, '2026-12-03'), null);
  assert.equal(P.alwaysOf(h.by, 'b', false), true, 'never changed: a plain value, even if the catalog says otherwise');
  assert.equal(P.alwaysOf(h.by, 'zz', true), true, 'no history: the catalog');
  assert.equal(typeof P.alwaysOf(h.by, 'a', true), 'function');
});

test('policy: a failed or partial refresh writes nothing; a variant missing from a refresh keeps its history', async () => {
  const by = { a: [['2026-11-27', 1]], gone: [['2026-11-27', 0]] };
  const r = P.record(by, { a: undefined, b: null, c: 'CONTINUE' }, '2026-11-28');
  assert.deepEqual(r.changed, [], 'no policy in the answer: nothing known, nothing written'); assert.equal(r.by, by);
  const r2 = P.record(by, { a: false }, '2026-11-28'); assert.deepEqual(r2.by.gone, [['2026-11-27', 0]], 'missing from the refresh: untouched');
  /* the stock read: only CONTINUE / DENY become a policy; a page that fails throws before anything is returned */
  const v = (id, pol) => ({ id: `gid://shopify/ProductVariant/${id}`, inventoryQuantity: 3, inventoryPolicy: pol, inventoryItem: { tracked: true }, product: { id: 'gid://shopify/Product/1', title: 'P', status: 'ACTIVE' }, title: 'Default Title', price: '10' });
  const d = SH.diffStock([v('1', 'CONTINUE'), v('2', 'DENY'), v('3', undefined)], {}, 1);
  assert.deepEqual(d.policy, { 1: true, 2: false });
  let calls = 0; const q = async () => { if (calls++) throw new Error('page 2 failed'); return { productVariants: { nodes: [v('1', 'DENY')], pageInfo: { hasNextPage: true, endCursor: 'x' } } }; };
  await assert.rejects(SH.pullStock({}, { q }), /page 2 failed/);
  /* the file: written only when something changed, kept as a side file */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-policy-')), scope = require('../src/scope');
  scope.useDir(dir);
  try {
    assert.deepEqual(P.history(), {});
    assert.deepEqual(P.save({ 1: true, 2: false }, '2026-11-27').sort(), ['1', '2']);
    const f = P.file(), t0 = fs.statSync(f).mtimeMs;
    assert.deepEqual(P.save({ 1: true }, '2026-11-28'), []); assert.equal(fs.statSync(f).mtimeMs, t0, 'no change: not written');
    assert.deepEqual(P.save({ 2: true }, '2026-11-29'), ['2']);
    P.reset(); assert.deepEqual(P.history(), { 1: [['2026-11-27', 1]], 2: [['2026-11-27', 0], ['2026-11-29', 1]] });
  } finally { P.reset(); scope.useDir(null); }
});

test('the engine applies keep-selling day by day: a stock-out while set to keep selling is no gap; after the flip it counts', () => {
  /* row 9 keeps selling at 0 until 25 Jun (its stock runs to −20 in June), then not: empty 1–10 Oct with no sales */
  const lv = [], sell = (i) => (DAY(i) >= '2026-10-01' && DAY(i) <= '2026-10-10' ? 0 : 1);
  for (let i = 0; i < N; i++) { const k = DAY(i); lv.push(k >= '2026-06-01' && k <= '2026-06-20' ? -(+k.slice(8, 10)) : k >= '2026-10-01' && k <= '2026-10-10' ? 0 : 500 - (i % 30)); }
  const row = { id: '9', price: 1000, sell, level: (i) => lv[i] }, base = shop([row, ...many(8, 100, 500)]);
  const run = (oversell, policy) => { const cat = JSON.parse(JSON.stringify(base.cat)); if (oversell) cat['9'].oversell = true; else delete cat['9'].oversell; return T.report(base.y, cat, { ...opts, ...(policy ? { policy } : {}) }); };
  const x = (r) => r.rows.find((z) => z.id === '9');
  assert.equal(x(run(false)).unsure, true, 'without the history: −20 is a broken walk');
  const kept = x(run(true)); assert.equal(kept.always, true); assert.equal(kept.lost, 0, 'always keep selling: never out');
  const flip = { 9: [[FROM, 1], ['2026-06-25', 0]] }, r = run(false, flip), f = x(r);
  assert.equal(f.unsure, undefined, 'the days set to keep selling are left out of the walk check');
  assert.equal(f.always, undefined); assert.equal(f.months['2026-06'], undefined, 'June: set to keep selling, no empty day');
  assert.ok(f.months['2026-10'] && f.months['2026-10'].empty >= 9 && f.months['2026-10'].lost > 0, 'October: after the flip, empty and priced');
  assert.equal(f.stockSeen, 'ok', 'not keeping selling now');
  assert.equal(x(run(false, { 9: [['2026-06-25', 1], ['2026-07-01', 0]] })).months['2026-06'], undefined, 'before the first row: its earliest value (keeps selling)');
  /* no flip recorded: byte-identical to the catalog alone */
  for (const o of [false, true]) assert.equal(JSON.stringify(run(o, { 9: [['2026-11-20', o ? 1 : 0]] })), JSON.stringify(run(o)), `${o}`);
});

test('keep selling now: the last days say "Keeps selling at 0 in Shopify · sells about N a day (12-month average)", never "No sales lately"', () => {
  const sell = (i) => (i % 2 ? 1 : 0), ks = { id: 'k', price: 900, sell, level: (i) => 30 - Math.floor(i / 2), oversell: true };
  const { y, cat } = shop([ks, ...many(6, 100, 500)]), r = T.report(y, cat, opts), x = r.rows.find((z) => z.id === 'k');
  const rep = { products: [{ id: 'k', stock: 5, status: 'OK', sold: 0 }, { id: '100', stock: 50, status: 'OK', sold: 0 }], totals: {} };
  S.period(rep, r, { from: r.span.from, to: r.span.to });
  const days = r.months.reduce((a, m) => a + m.days, 0), n = x.pieces / days, txt = `Keeps selling at 0 in Shopify · sells about ${n >= 1 ? Math.round(n) : Math.round(n * 10) / 10} a day (12-month average)`;
  assert.equal(rep.products[0].why, txt); assert.equal(rep.products[0].keepsWhy, txt);
  assert.equal(rep.products[0].status, 'OK', 'keep selling: the status uses its 12-month average, not Slow seller');
  const low = { products: [{ id: 'k', stock: 1, status: 'OK', sold: 0 }], totals: {} }; S.period(low, r, { from: r.span.from, to: r.span.to }); assert.equal(low.products[0].status, 'Critical', 'a few days of stock at that average');
  assert.match(rep.products[1].why, /days of stock/, 'others as before'); assert.equal(rep.products[1].keepsWhy, undefined);
  const H = require('../src/helpers'), E = require('../src/engine'), d = H.enrichDetail({ product: { ...rep.products[0], perDay: 0, daysLeft: null }, stockouts: [] }, E.DEFAULT_SETTINGS, Date.now());
  assert.equal(d.product.why, txt, 'the drawer keeps it');
});
