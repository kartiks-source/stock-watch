'use strict';
/* SW-050: /api/v1. Every /api/<x> also answers at /api/v1/<x> (same auth, same handler, old paths stay); GET /api/v1/summary
 * (headline numbers only) and GET /api/v1/rows (stable order, cursor pages, max 500). Unit tests on src/apiv1.js, then the real server. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const V = require('../src/apiv1');

test('rewrite: /api/v1/<x> → /api/<x>, marked v1; other paths untouched', () => {
  const u = new URL('http://x/api/v1/report?days=7');
  assert.equal(V.rewrite(u), true); assert.equal(u.pathname, '/api/report'); assert.equal(u.v1, true); assert.equal(u.search, '?days=7');
  const o = new URL('http://x/api/report'); assert.equal(V.rewrite(o), false); assert.equal(o.pathname, '/api/report'); assert.equal(o.v1, undefined);
  assert.equal(V.rewrite(new URL('http://x/api/v1')), false, 'no trailing route: not rewritten (404 later)');
});

test('page: stable order by ID (stock-outs: then start), cursor = last key, never repeats or skips when rows move', () => {
  const rows = [{ id: 'b', lost: 9 }, { id: 'a', lost: 1 }, { id: 'c', lost: 5 }, { id: '10', lost: 3 }];
  const p1 = V.page('products', rows, '2', null);
  assert.deepEqual(p1.rows.map((r) => r.id), ['10', 'a'], 'text order, not ₹ order'); assert.equal(p1.total, 4); assert.ok(p1.next);
  const moved = [{ id: 'c', lost: 50 }, { id: 'a', lost: 0 }, { id: 'b', lost: 1 }, { id: 'aa', lost: 7 }];   // numbers changed, 'aa' added after 'a', '10' gone
  const p2 = V.page('products', moved, '2', p1.next);
  assert.deepEqual(p2.rows.map((r) => r.id), ['aa', 'b']);
  const p3 = V.page('products', moved, '2', p2.next);
  assert.deepEqual(p3.rows.map((r) => r.id), ['c']); assert.equal(p3.next, null);
  const so = V.page('stockouts', [{ id: 'a', start: 30 }, { id: 'a', start: 10 }, { id: 'a', start: 20 }], '1', null);
  assert.equal(so.rows[0].start, 10);
  assert.equal(V.page('stockouts', [{ id: 'a', start: 30 }, { id: 'a', start: 10 }], '1', so.next).rows[0].start, 30, 'same ID, next start');
  assert.equal(V.page('reorder', rows, null, null).limit, 100, 'default 100');
  assert.equal(V.page('reorder', rows, '9999', null).limit, 500, 'max 500');
  const bad = (fn, re) => assert.throws(fn, (e) => e.status === 400 && re.test(e.message));
  bad(() => V.page('decide', rows, null, null), /view must be one of reorder, stockouts, products/);
  for (const l of ['0', '-1', '2.5', 'ten']) bad(() => V.page('reorder', rows, l, null), /limit must be/);
  for (const c of ['nope', Buffer.from('{"a":1}').toString('base64url'), Buffer.from('[1,2]').toString('base64url')]) bad(() => V.page('reorder', rows, null, c), /Bad cursor/);
});

/* ---------- the real server ---------- */
const MOD = path.join(__dirname, '..');
const PW = 'v1-admin-password', VIEW = 'v1-view-password';
const basic = (p) => ({ authorization: 'Basic ' + Buffer.from('u:' + p).toString('base64') });
let srv, dir;
test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-v1-'));
  srv = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], { cwd: MOD, env: { PATH: process.env.PATH, DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: PW, VIEW_PASSWORD: VIEW } });
    let out = '';
    child.stdout.on('data', (b) => { out += b; const m = out.match(/localhost:(\d+)/); if (m) resolve({ child, base: `http://127.0.0.1:${m[1]}` }); });
    child.stderr.on('data', (b) => { out += b; });
    child.on('exit', (c) => reject(new Error(`server exited ${c}: ${out}`)));
  });
});
test.after(async () => {
  srv.child.removeAllListeners('exit');
  await new Promise((r) => { srv.child.on('exit', r); srv.child.kill(); });
  fs.rmSync(dir, { recursive: true, force: true });
});
const req = (p, opt = {}, pw = PW) => fetch(srv.base + p, { ...opt, headers: { ...(pw ? basic(pw) : {}), ...(opt.headers || {}) } });
const json = async (r) => ({ status: r.status, ...(await r.json()) });
/** Two calls a moment apart: open stock-outs keep costing, so money may differ by a rupee or two. */
function near(x, y, where) {
  assert.deepEqual(Object.keys(x).sort(), Object.keys(y).sort(), where);
  for (const k of Object.keys(y)) {
    if (typeof y[k] === 'number' && typeof x[k] === 'number') assert.ok(Math.abs(x[k] - y[k]) <= Math.max(2, Math.abs(y[k]) * 0.001), `${where} ${k}: ${x[k]} vs ${y[k]}`);
    else assert.deepEqual(x[k], y[k], `${where} ${k}`);
  }
}
/** The same, all the way down (groups carry money per group too). */
function deepNear(x, y, where) {
  if (typeof y === 'number' && typeof x === 'number') return assert.ok(Math.abs(x - y) <= Math.max(2, Math.abs(y) * 0.001), `${where}: ${x} vs ${y}`);
  if (!y || typeof y !== 'object' || !x || typeof x !== 'object') return assert.deepEqual(x, y, where);
  assert.equal(Array.isArray(x), Array.isArray(y), where); assert.deepEqual(Object.keys(x).sort(), Object.keys(y).sort(), where);
  for (const k of Object.keys(y)) deepNear(x[k], y[k], `${where}.${k}`);
}
const strip = (j) => { const { generatedAt, from, ops, catalog, ...rest } = j; return rest; };   // time-stamped on each call; ops = live disk % (SW-055); catalog = snapshot status that can refresh between two calls on a slow runner

test('every GET route answers the same at /api and /api/v1 (old paths stay)', async () => {
  const id = (await json(await req('/api/report'))).products[0].id;
  for (const p of ['/api/stores', '/api/report?days=7', `/api/product/${encodeURIComponent(id)}`, '/api/groups', '/api/groups?lens=type', '/api/settings', '/api/onorder', '/api/decide', '/api/digest?role=ops', '/api/digest/settings']) {
    const a = await json(await req(p)), b = await json(await req(p.replace('/api/', '/api/v1/')));
    assert.equal(a.status, 200, p); assert.equal(b.status, 200, `v1 ${p}`);
    if (p.startsWith('/api/report')) { near(b.totals, a.totals, p); continue; }   // the report holds "now" (days left move)
    if (p.startsWith('/api/product/')) { assert.deepEqual(b.product.id, a.product.id, p); assert.equal(b.timeline.length, a.timeline.length); continue; }   // timeline ends at "now"
    deepNear(strip(b), strip(a), p);   // groups hold ₹ lost: an open stock-out moves it by a rupee between two calls
  }
  for (const p of ['/api/export/reorder.csv', '/api/digest.txt', '/api/export/backup.json']) {
    const b = await req(p.replace('/api/', '/api/v1/'));
    assert.equal(b.status, 200, `v1 ${p}`); assert.equal(b.headers.get('content-type'), (await req(p)).headers.get('content-type'));
  }
  assert.equal((await req('/api/v1/nope')).status, 404);
  assert.equal((await req('/api/summary')).status, 404, 'v1-only routes are v1 only');
});

test('v1 auth is the same: 401 signed out, view-only can read but never write, cross-site writes refused, admin writes work', async () => {
  assert.equal((await req('/api/v1/summary', {}, null)).status, 401);
  assert.equal((await req('/api/v1/report', {}, null)).status, 401);
  assert.equal((await req('/api/v1/summary', {}, VIEW)).status, 200);
  assert.equal((await req('/api/v1/rows?view=reorder', {}, VIEW)).status, 200);
  for (const [m, p, body] of [['PUT', '/api/v1/settings', '{"leadDays":9}'], ['POST', '/api/v1/clear', ''], ['POST', '/api/v1/demo', ''], ['POST', '/api/v1/import?kind=stock', 'a,b\n'], ['POST', '/api/v1/decide', '{}'], ['POST', '/api/v1/onorder', '{}']]) {
    assert.equal((await req(p, { method: m, body }, VIEW)).status, 403, `view ${m} ${p}`);
  }
  assert.equal((await req('/api/v1/export/backup.json', {}, VIEW)).status, 403, 'backup is admin-only on v1 too');
  assert.equal((await req('/api/v1/settings', { method: 'PUT', body: '{"leadDays":9}', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await req('/api/v1/clear', { method: 'POST', headers: { origin: 'https://evil.example' } })).status, 403);
  const put = await json(await req('/api/v1/settings', { method: 'PUT', body: '{"leadDays":9}', headers: { 'content-type': 'application/json' } }));
  assert.equal(put.status, 200); assert.equal(put.settings.leadDays, 9);
  assert.equal((await json(await req('/api/settings'))).settings.leadDays, 9, 'same store, same handler');
  await req('/api/settings', { method: 'PUT', body: '{"leadDays":7}', headers: { 'content-type': 'application/json' } });
});

test('GET /api/v1/summary: headline ₹ and counts equal the report totals; small; ?store= and report values honoured', async () => {
  const r = await json(await req('/api/report?days=7')), s = await json(await req('/api/v1/summary?days=7'));
  assert.equal(s.status, 200); assert.equal(s.currency, 'INR'); assert.equal(s.days, 7);
  for (const k of Object.keys(s.money)) assert.ok(Math.abs(s.money[k] - r.totals[k]) <= Math.max(2, Math.abs(r.totals[k]) * 0.001), `${k}: ${s.money[k]} vs ${r.totals[k]}`);   // two calls a moment apart: an open stock-out keeps costing
  for (const k of Object.keys(s.counts)) assert.equal(s.counts[k], r.totals[k], k);
  assert.deepEqual(s.store, { id: 'sammsara-demo', name: 'Sammsara (demo)' });
  assert.deepEqual(Object.keys(s.fresh), ['lastPull', 'ageMin', 'stale']);
  assert.ok(!('products' in s) && !('reorder' in s), 'no rows');
  assert.ok(JSON.stringify(s).length < 1500, `small: ${JSON.stringify(s).length} bytes`);
  const two = await json(await req('/api/v1/summary?store=second-demo'));
  assert.equal(two.store.id, 'second-demo'); assert.notEqual(two.money.sold, s.money.sold);
  assert.equal((await req('/api/v1/summary?store=nope')).status, 404);
});

test('GET /api/v1/rows: every row once across pages, stable order, limit ≤ 500, bad values → 400', async () => {
  const r = await json(await req('/api/report'));
  for (const view of ['reorder', 'stockouts', 'products']) {
    let cursor = null, seen = [], pages = 0;
    do {
      const pg = await json(await req(`/api/v1/rows?view=${view}&limit=50${cursor ? `&cursor=${cursor}` : ''}`));
      assert.equal(pg.status, 200); assert.equal(pg.view, view); assert.equal(pg.total, r[view].length); assert.ok(pg.rows.length <= 50);
      seen.push(...pg.rows); cursor = pg.next; pages++;
    } while (cursor && pages < 100);
    assert.equal(seen.length, r[view].length, view);
    const key = (x) => `${x.id}|${view === 'stockouts' ? x.start : ''}`;
    assert.equal(new Set(seen.map(key)).size, seen.length, `${view}: no repeats`);
    const ids = seen.map((x) => String(x.id)); assert.deepEqual(ids, [...ids].sort(), `${view}: ID order`);
    const ref = r[view].find((x) => key(x) === key(seen[0]));   // the same row: some fields are only on some rows (SW-040 packExtra)
    assert.deepEqual(Object.keys(seen[0]).sort(), Object.keys(ref).sort(), `${view}: the same row shape as /api/report`);
  }
  const big = await json(await req('/api/v1/rows?view=stockouts&limit=100000'));
  assert.equal(big.limit, 500); assert.equal(big.rows.length, Math.min(500, r.stockouts.length));
  assert.equal((await json(await req('/api/v1/rows?view=products'))).limit, 100);
  for (const q of ['', '?view=decide', '?view=products&limit=0', '?view=products&limit=x', '?view=products&cursor=%%%']) {
    assert.equal((await req(`/api/v1/rows${q}`)).status, 400, q);
  }
});
