'use strict';
/* 1.4.6: the critics' logic findings. Every expected number is worked out by hand. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-146-'));
const A = require('../src/agency'), H = require('../src/helpers'), E = require('../src/engine'), sell = require('../src/sell');
const kp = A.keyPlus, dayOf = (t) => new Date(t).toISOString().slice(0, 10), at = (k) => Date.parse(`${k}T00:00:00Z`);
/** 1 unit a day at ₹1,000 on every day in stock; outs = [[from, to]] whole days empty (the stock ends the day before). */
function year(from, today, outs = [], { u = 1 } = {}) {
  const y = { v: 1, at: 1, done: true, anchor: { at: 1, day: today, levels: { 1: 50 } }, sales: { from, to: kp(today, -1), by: { 1: {} }, all: {} }, moves: { from, to: kp(today, -1), by: { 1: {} } } };
  const isOut = (k) => outs.some(([a, b]) => k >= a && k <= b);
  for (const [a, b] of outs) { y.moves.by[1][kp(a, -1)] = -50; if (b < kp(today, -1)) y.moves.by[1][kp(b, 1)] = 50; else y.anchor.levels[1] = 0; }
  for (let k = from; k < today; k = kp(k, 1)) { const q = isOut(k) ? 0 : u; if (q) y.sales.by[1][k] = [q, q * 1000]; y.sales.all[k] = [q, q * 1000]; }
  return y;
}
const cat = (x = {}) => ({ 1: { productId: 'p1', product: 'P1', sku: 'S1', price: 1180, active: true, tracked: true, createdAt: at('2024-01-01'), ...x } });
const info = (x = {}) => ({ 1: { confidence: 'high', nrDays: 30, ordered: false, allocation: false, ...x } });
const one = (r) => r.products[0];

test('the window is the last 365 days: a new month changes the total by one day, never a month (2 Dec)', () => {
  const sum = (today) => { const r = A.build(year('2025-10-21', today), cat(), { dayOf }); return [r.window.from, r.headline.sold, one(r).sold, r.months.length]; };
  assert.deepEqual(sum('2026-12-01'), ['2025-12-01', 365000, 365000, 12]);
  assert.deepEqual(sum('2026-12-02'), ['2025-12-02', 365000, 365000, 13]);
  const r = A.build(year('2025-10-21', '2026-12-02'), cat(), { dayOf });
  assert.equal(r.months[0].key, '2025-12'); assert.equal(r.months[0].from, '2025-12-02'); assert.equal(r.months[0].days, 30);
});

test('1.4.5: a product’s sold and price cover the same days as the months, not the whole span', () => {
  const y = year('2025-10-21', '2026-11-25'); y.sales.by[1]['2025-11-01'] = [10, 90000]; y.sales.all['2025-11-01'] = [10, 90000];
  const r = A.build(y, cat(), { dayOf });
  assert.equal(one(r).units, 365); assert.equal(one(r).price, 1000); assert.equal(one(r).sold, r.headline.sold);
});

test('the season index on days 2–7 of a month is last year’s, not 1', () => {
  const y = year('2025-11-01', '2026-12-04'); for (let k = '2025-12-01'; k <= '2025-12-31'; k = kp(k, 1)) { y.sales.by[1][k] = [3, 3000]; y.sales.all[k] = [3, 3000]; }
  const s = A.shopSeason(y, A.dayKeys('2025-11-01', '2026-12-03'));
  assert.ok(s['2025-12'] > 1.5); assert.equal(s['2026-12'], s['2025-12']);
});

test('drafted or archived: the past months keep their money up to that day, and never a best seller', () => {
  const y = year('2025-10-21', '2026-11-25', [['2026-06-01', '2026-06-20']]);
  const live = one(A.build(y, cat(), { dayOf, rowInfo: info() }));
  const off = one(A.build(y, cat({ active: false, inactiveSince: at('2026-11-20') }), { dayOf, firstSeenDay: '2026-09-01' }));
  assert.ok(live.months['2026-06'].counted > 15000); assert.ok(Math.abs(off.months['2026-06'].counted - live.months['2026-06'].counted) < 400);
  assert.equal(off.inactive, true); assert.equal(off.best, false);
});

test('already drafted at our first read (date unknown): nothing is counted after its last sale', () => {
  const y = year('2025-10-21', '2026-11-25', [['2026-03-01', '2026-11-24']]);
  const p = one(A.build(y, cat({ active: false, inactiveSince: at('2026-09-01') }), { dayOf, firstSeenDay: '2026-09-01' }));
  assert.equal(p.lost, p.months['2026-02'] ? p.months['2026-02'].lost : 0);
  assert.ok(!p.months['2026-05']);
});

test('days it was drafted (a spell) are no stock-out', () => {
  const y = year('2025-10-21', '2026-11-25', [['2026-07-01', '2026-07-14']]);
  const p = one(A.build(y, cat({ spells: [{ from: at('2026-06-30'), to: at('2026-07-15') }] }), { dayOf, rowInfo: info() }));
  assert.ok(!p.months['2026-07']);
});

test('re-published: what was before its last sale stays; the gap to the new date is not a stock-out; never sold before → starts there', () => {
  const y = year('2025-10-21', '2026-11-25', [['2026-02-01', '2026-02-10'], ['2026-06-01', '2026-07-30']]);
  const p = one(A.build(y, cat({ publishedAt: at('2026-07-31') }), { dayOf, rowInfo: info() }));
  assert.ok(p.months['2026-02'].counted > 6000); assert.ok(!p.months['2026-06']); assert.ok(!p.months['2026-07'] || p.months['2026-07'].lost <= 600);
  const z = year('2025-10-21', '2026-11-25'); for (const k of Object.keys(z.sales.by[1])) if (k < '2026-07-10') { delete z.sales.by[1][k]; }
  assert.equal(A.lifeOf(z, '1', cat({ publishedAt: at('2026-07-10') })[1], A.dayKeys('2025-10-21', '2026-11-24'), { dayOf, winFrom: '2025-11-25' }).from, '2026-07-10');
});

test('"still out" needs the last day to end empty, and a day that ended with stock breaks the run', () => {
  const L = (...d) => d.map(([k, inF, end]) => ({ k, inF, end }));
  assert.equal(A.outRun(L(['2026-11-20', 0, 0], ['2026-11-21', 0.5, 5])), null, 'restocked yesterday');
  assert.equal(A.outRun(L(['2026-11-18', 0.5, 0], ['2026-11-19', 0.5, 4], ['2026-11-20', 0.5, 0])), '2026-11-20', 'every other day');
  assert.equal(A.outRun(L(['2026-11-18', 1, 4], ['2026-11-19', 0.5, 0], ['2026-11-20', 0, 0])), '2026-11-19');
});

test('running out does not drop a best seller: the first 30 days out of each stock-out count for the rank', () => {
  const y = year('2025-10-21', '2026-11-25', [['2026-10-01', '2026-11-24']], { u: 2 });
  y.anchor.levels[2] = 900; y.sales.by[2] = {}; y.moves.by[2] = {};
  for (let k = '2025-10-21'; k < '2026-11-25'; k = kp(k, 1)) y.sales.by[2][k] = [8, 8000];
  const c = { ...cat(), 2: { ...cat()[1], productId: 'p2' } };
  const r = A.build(y, c, { dayOf, bestShare: 0.815 });   // p2 2920k of 2920k + 620k (+ 60k): 82.5% on sales alone, 81.1% with the 30 days
  assert.deepEqual(r.products.filter((p) => p.best).map((p) => p.productId).sort(), ['p1', 'p2']);
});

test('new or unsure variants are named, so ₹ lost keeps its own rate instead of 0', () => {
  const y = year('2025-10-21', '2026-11-25'); const p = one(A.build(y, cat({ createdAt: at('2026-11-23') }), { dayOf }));
  assert.deepEqual(p.noPace, ['1']);
  assert.deepEqual(one(A.build(y, cat(), { dayOf })).noPace, []);
});

test('a closed month keeps its money when the evidence changes later; the open month still moves', () => {
  const scope = require('../src/scope'), closed = require('../src/closed');
  scope.run('demo', () => {
    const y = year('2025-10-21', '2026-11-25', [['2026-09-01', '2026-11-24']]), o = { dayOf, paceMonths: 6, detail: true }, k = closed.keyOf(o);
    const a = A.build(y, cat(), { ...o, rowInfo: info() });
    const saved = closed.close(k, a, y);
    assert.ok(saved.includes('2026-10') && !saved.includes('2026-11') && !saved.includes('2025-11'), 'full, finished months only');
    const free = A.build(y, cat(), { ...o, rowInfo: info({ confidence: 'low' }) }), kept = A.build(y, cat(), { ...o, rowInfo: info({ confidence: 'low' }), frozen: closed.get(k) });
    assert.equal(one(free).months['2026-10'].counted, 0, 'without: a later change of evidence empties October');
    assert.equal(one(kept).months['2026-10'].counted, one(a).months['2026-10'].counted);
    assert.equal(one(kept).months['2026-11'].counted, one(free).months['2026-11'].counted);
    assert.deepEqual(closed.close(k, kept, y), [], 'closed once');
  });
});

test('the drawer says the counted money, with guesses apart; both add up to the month', () => {
  const y = year('2025-10-21', '2026-11-25', [['2026-10-01', '2026-11-24']]);
  for (const [c, apart] of [['high', false], ['low', true]]) {
    const r = A.build(y, cat(), { dayOf, rowInfo: info({ confidence: c }), detail: true }), p = A.profile(r, y, cat(), '1');
    assert.equal(p.missed.value, one(r).counted); assert.equal(p.missed.value + p.missed.apart, one(r).lost); assert.equal(p.missed.apart > 0, apart);
    const nov = p.months.find((m) => m.key === '2026-11'); assert.equal(nov.missed, one(r).months['2026-11'].counted);
  }
});

test('sure or guess: only weeks it could be bought, never under 8', () => {
  const ws = { weeks: 25, start: at('2026-06-01') }, y = year('2025-10-21', '2026-11-25', [['2026-06-01', '2026-08-23']]);   // 12 of the 25 weeks empty
  const r = A.build(y, cat(), { dayOf, detail: true });
  assert.equal(A.weeksOpen(r, ws, dayOf)['1'], 13);
  assert.equal(E.confidenceOfWeeks(4, 25), 'low'); assert.equal(E.confidenceOfWeeks(4, 13), 'medium');
});

test('1.5.0: every empty day counts; the part after the first 30 days is named, inside the total; how often it ran out', () => {
  const y = year('2025-10-21', '2026-11-25', [['2026-03-01', '2026-05-29'], ['2026-08-01', '2026-08-10']]);   // 90 days, then 10
  const p = one(A.build(y, cat(), { dayOf, rowInfo: info() })), late = Object.values(p.months).reduce((s, m) => s + (m.late || 0), 0);
  assert.equal(p.counted, p.lost); assert.ok(late > p.lost * 0.4 && late < p.lost * 0.7, `${late} of ${p.lost}`); assert.equal(p.months['2026-08'].late, undefined);
  assert.equal(p.times, 2); const h = A.build(y, cat(), { dayOf, rowInfo: info() }).headline; assert.ok(Math.abs(h.all.late - late) <= 6);
});

test('1.4.7: money missed uses the price of the time', () => {
  const y = year('2025-10-21', '2026-11-25', [['2026-11-10', '2026-11-19']]);
  for (const [k, x] of Object.entries(y.sales.by[1])) if (k >= '2026-09-01') { x[1] = 1500; }
  const v = one(A.build(y, cat(), { dayOf })); const m = v.months['2026-11'];
  assert.equal(Math.round(m.lost / m.units / 10) * 10, 1500); assert.ok(v.price < 1200, 'the 12-month average is lower');
  assert.equal(v.variantPrice['1']['2026-11'], 1500); assert.equal(v.variantPrice['1']['2026-03'], 1000);
});

test('1.4.7: "continue selling at 0" is never an empty shelf, on the brand report and in the report', () => {
  const y = year('2025-10-21', '2026-11-25', [['2026-06-01', '2026-06-20']]); y.moves.by[1]['2025-10-24'] = 400;   // the log goes far below zero
  assert.equal(one(A.build(y, cat(), { dayOf })).unsure, 1);
  const r = A.build(y, cat({ oversell: true }), { dayOf }); assert.equal(one(r).lost, 0); assert.equal(one(r).daysOut, 0); assert.deepEqual(r.dropped, []);
  const now = at('2026-11-25'), rep = (c) => E.report([{ t: now - 20 * 864e5, variantId: '1', sku: 'S', product: 'P', variant: '', before: 5, now: 0, price: 100 }], [{ t: now - 25 * 864e5, order: 'A', line: '1', variantId: '1', sku: 'S', qty: 3, price: 100 }], {}, { days: 30, now, catalog: c }).products[0];
  assert.ok(rep(cat()).lost > 0); assert.equal(rep(cat({ oversell: true })).lost, 0);
});

test('1.4.7: status periods: active since the website date; Shopify’s changes; unknown before its record; drafts', () => {
  const S = require('../src/status'), D = (k) => at(k), H = D('2026-08-28');
  const f = (c, log = []) => S.periods({ createdAt: D('2024-01-01'), ...c }, log, H).map((p) => [p.status, p.from && dayOf(p.from), p.to && dayOf(p.to)]);
  assert.deepEqual(S.parse({ createdAt: '2026-09-17T06:14:00Z', action: 'status_changed', message: 'A B changed product status from draft to active: X.' }), [Date.parse('2026-09-17T06:14:00Z'), 'DRAFT', 'ACTIVE']);
  assert.equal(S.parse({ createdAt: '2026-09-17', action: 'published', message: 'included a product' }), null);
  assert.deepEqual(f({ status: 'ACTIVE', publishedAt: D('2024-01-01') }), [['ACTIVE', '2024-01-01', null]]);
  assert.deepEqual(f({ status: 'ACTIVE', publishedAt: D('2026-07-10') }), [['UNKNOWN', '2024-01-01', '2026-07-10'], ['ACTIVE', '2026-07-10', null]]);
  assert.deepEqual(f({ status: 'DRAFT' }), [['UNKNOWN', '2024-01-01', '2026-08-28'], ['DRAFT', '2026-08-28', null]]);
  const log = [[D('2026-09-10'), 'ACTIVE', 'DRAFT'], [D('2026-09-17'), 'DRAFT', 'ACTIVE'], [D('2026-10-05'), 'ACTIVE', 'ARCHIVED']];
  assert.deepEqual(f({ status: 'ARCHIVED' }, log), [['UNKNOWN', '2024-01-01', '2026-08-28'], ['ACTIVE', '2026-08-28', '2026-09-10'], ['DRAFT', '2026-09-10', '2026-09-17'], ['ACTIVE', '2026-09-17', '2026-10-05'], ['ARCHIVED', '2026-10-05', null]]);
  assert.deepEqual(S.offSpells(S.periods({ status: 'ARCHIVED', createdAt: D('2024-01-01') }, log, H)), [[D('2026-09-10'), D('2026-09-17')]]);
  assert.deepEqual(f({ status: 'ACTIVE', spells: [{ from: D('2026-11-21'), to: D('2026-11-23'), status: 'DRAFT' }], publishedAt: D('2026-11-23') }).slice(-3), [['ACTIVE', '2026-11-21', '2026-11-21']].slice(1).concat([['ACTIVE', '2026-08-28', '2026-11-21'], ['DRAFT', '2026-11-21', '2026-11-23'], ['ACTIVE', '2026-11-23', null]]));
});

test('sure or guess in the report: 4 of 13 buyable weeks is fairly sure, 3 sales stay a guess, 4 in 2 weeks are out of 12', () => {
  const now = at('2026-11-25'), mk = (s, open) => E.report([{ t: now - 50 * 864e5, variantId: '1', sku: 'S', product: 'P', variant: '', before: null, now: 5, price: 100 }], [], {}, { days: 30, now, catalog: cat(),
    weekSales: { weeks: 25, start: at('2026-06-01'), by: { 1: { s, u: s, n: s * 100, l: null } } }, weeksOpen: { 1: open } }).products[0];
  assert.deepEqual([mk(4, 13).confidence, mk(4, 13).weeksLive], ['medium', 13]);
  assert.deepEqual([mk(3, 5).confidence, mk(3, 5).weeksLive], ['low', 25]);
  assert.deepEqual([mk(4, 2).confidence, mk(4, 2).weeksLive], ['medium', 12]);
});

test('refilled a few at a time and in stock: never paused, listed as keep; out of stock: paused', () => {
  const row = { id: '1', status: 'Top-up from warehouse', allocation: { level: 7 }, stock: 7, daysLeft: 2, perDay: 3, price: 100 };
  assert.equal(H.mktList(row, { leadDays: 7 }), null); assert.equal(H.mktList({ ...row, stock: 0 }, { leadDays: 7 }), 'pause');
  assert.equal(H.mktList({ ...row, allocation: undefined }, { leadDays: 7 }), 'pause');
  const a = sell.ads(null, [row, { ...row, id: '2', stock: 0, mkt: 'pause' }], {});
  assert.deepEqual([a.keep.map((x) => x.id), a.pause.map((x) => x.id), a.push.length], [['1'], ['2'], 0]);
});

test('1.5.0: the walk is anchored on our own reading at the end of the last day: a piece sold between two reads shifts nothing', () => {
  const y = year('2025-10-21', '2026-11-25', [['2026-06-01', '2026-06-10']]), keys = A.dayKeys('2025-10-21', '2026-11-24');
  const right = A.days(y, '1', keys), off = structuredClone(y); off.anchor.levels[1] -= 1; off.moves.by[1]['2026-11-25'] = 0;   // sold after the log was read
  const wrong = A.days(off, '1', keys), fixed = A.days(off, '1', keys, null, { known: { day: '2026-11-24', level: 50 } }), older = A.days(off, '1', keys, null, { known: { day: '2026-11-20', level: 50 } });
  assert.deepEqual(older.list.map((x) => x.end), right.list.map((x) => x.end), 'a certain reading some days back does the same');
  assert.notDeepEqual(wrong.list.map((x) => x.end), right.list.map((x) => x.end));
  assert.deepEqual(fixed.list.map((x) => [x.k, x.end, x.inF]), right.list.map((x) => [x.k, x.end, x.inF]));
  assert.deepEqual(A.days(y, '1', keys, null, { known: { day: '2026-11-24', level: 50 } }), right, 'agreeing changes nothing');
  assert.deepEqual(A.days(y, '1', keys, null, { known: { day: '2026-11-24', level: 500 } }).list.map((x) => x.end), right.list.map((x) => x.end), 'a huge gap is not "a piece sold between two reads"');
});

test('1.5.1: the working adds up: days × a day × price = missed, every month; the months are the product’s total; speed and price can be redone', () => {
  const y = year('2025-10-21', '2026-11-25', [['2026-03-01', '2026-03-12'], ['2026-10-20', '2026-11-24']]);
  for (const x of Object.values(y.sales.by[1])) { x[2] = x[1] * 0.18; x[3] = x[1] * 1.1; }
  const r = A.build(y, cat(), { dayOf, rowInfo: info(), detail: true }), p = A.profile(r, y, cat(), '1'), w = p.work;
  assert.deepEqual(w.months.map((m) => m.key), ['2026-02', '2026-03', '2026-10', '2026-11']);
  for (const m of w.months) { assert.ok(Math.abs(m.days * m.perDay - m.units) < 0.02); assert.ok(Math.abs(m.units * m.price - m.missed) <= m.price * 0.006 + m.units + 1, `${m.key}`); assert.equal(m.kind, 'counted'); }
  assert.ok(Math.abs(w.total - one(r).lost) <= 2); assert.equal(w.counted, p.missed.value);
  assert.ok(Math.abs(w.speed.units / w.speed.days - w.speed.perDay) < 0.001); assert.equal(w.speed.months.reduce((s, m) => s + m.units, 0), w.speed.units);
  const nov = w.months[3]; assert.ok(Math.abs((w.speed.perDay * w.season.index) / w.speed.level - nov.perDay) < 0.01, 'speed × season ÷ level');
  assert.equal(w.price.net + w.price.off, w.price.gross); assert.equal(w.price.avg, Math.round(w.price.net / w.price.pieces));
  assert.deepEqual(w.outs.map((o) => o.from), ['2026-02-28', '2026-10-19']); assert.equal(w.outs[1].after, 0); assert.ok(w.outs[1].before > 0);
  const g = A.profile(A.build(y, cat(), { dayOf, rowInfo: info({ confidence: 'low' }), detail: true }), y, cat(), '1').work; assert.ok(g.months.every((m) => m.kind === 'guess')); assert.equal(g.counted, 0);
});
