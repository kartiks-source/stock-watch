'use strict';
/* Route tests: each block starts the real server (node server.js) on a free port with a temp DATA_DIR. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server.js');
const PASSWORD = 'correct horse battery';
const DAY = 864e5;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }).on('error', reject);
});

/** Start the server with a clean environment (no Shopify keys from the shell). Resolves once it listens, or with its exit code. */
async function start(env = {}, { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-test-')) } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, DATA_DIR: dir, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const ready = await new Promise((resolve) => {
    const on = (c) => { out += c; if (out.includes('Stock-out Watch on')) resolve(true); };
    child.stdout.on('data', on); child.stderr.on('data', on);
    exited.then(() => resolve(false));
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    ready, base, dir, exited, log: () => out,
    req: (p, opt = {}) => fetch(base + p, { redirect: 'manual', ...opt }),
    stop: async ({ keep = false } = {}) => { child.kill(); await exited; if (!keep) fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
const basic = (pass, user = 'x') => ({ authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') });

test('CSV exports: formula-looking SKU is quoted (SW-017)', async (t) => {
  const s = await start(); t.after(s.stop);
  const now = Date.now();
  const ts = (d) => new Date(now - d * DAY).toISOString();
  const stock = ['Time,Variant ID,SKU,Product,Variant,Stock before,Stock now,Price', `${ts(25)},777,=1+1,Evil lamp,,0,40,1000`, `${ts(1)},777,=1+1,Evil lamp,,2,0,1000`].join('\n');
  const orders = ['Time,Order,Variant ID,SKU,Qty,Unit price', ...Array.from({ length: 20 }, (_, i) => `${ts(i + 2)},#9${i},777,=1+1,2,1000`)].join('\n');
  assert.equal((await s.req('/api/import?kind=stock&replaceDemo=1', { method: 'POST', body: stock })).status, 200);
  assert.equal((await s.req('/api/import?kind=order', { method: 'POST', body: orders })).status, 200);
  const csv = await (await s.req('/api/export/reorder.csv')).text();
  assert.match(csv, /"'=1\+1"/);
  assert.doesNotMatch(csv, /,"=1\+1"/);
});

test('login: one limiter for Basic + form, keyed on the last X-Forwarded-For hop (SW-008)', async (t) => {
  const s = await start({ ADMIN_PASSWORD: PASSWORD }); t.after(s.stop);
  assert.equal((await s.req('/api/settings')).status, 401);
  for (let i = 1; i <= 10; i++) {
    // the client-set first hop changes every time; the proxy-added last hop is the real client
    const r = await s.req('/api/settings', { headers: { ...basic('wrong' + i), 'x-forwarded-for': `10.9.9.${i}, 203.0.113.7` } });
    assert.equal(r.status, 401, `try ${i}`);
  }
  const r11 = await s.req('/api/settings', { headers: { ...basic('wrong'), 'x-forwarded-for': '1.1.1.1, 203.0.113.7' } });
  assert.equal(r11.status, 429);
  assert.equal(r11.headers.get('retry-after'), '900');
  // the right password from that IP is refused too while it's locked, and the sign-in form shares the limit
  assert.equal((await s.req('/api/settings', { headers: { ...basic(PASSWORD), 'x-forwarded-for': '203.0.113.7' } })).status, 429);
  const form = await s.req('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '203.0.113.7' }, body: 'password=' + encodeURIComponent(PASSWORD) });
  assert.equal(form.status, 429);
  // another IP is unaffected
  assert.equal((await s.req('/api/settings', { headers: { ...basic(PASSWORD), 'x-forwarded-for': '203.0.113.8' } })).status, 200);
});

test('login: global cap of 100 wrong passwords per 15 minutes across all IPs (SW-008)', async (t) => {
  const s = await start({ ADMIN_PASSWORD: PASSWORD }); t.after(s.stop);
  for (let i = 0; i < 100; i++) {
    const r = await s.req('/api/settings', { headers: { ...basic('guess' + i), 'x-forwarded-for': `198.51.${i >> 8}.${i & 255}` } });
    assert.equal(r.status, 401, `try ${i}`);
  }
  assert.equal((await s.req('/api/settings', { headers: { ...basic('guess'), 'x-forwarded-for': '192.0.2.200' } })).status, 429);
  // SEC-1: the cap never locks out the right password (Basic or the form) from a fresh IP
  assert.equal((await s.req('/api/settings', { headers: { ...basic(PASSWORD), 'x-forwarded-for': '203.0.113.99' } })).status, 200);
  const form = await s.req('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '203.0.113.98' }, body: 'password=' + encodeURIComponent(PASSWORD) });
  assert.equal(form.status, 303);
  const wrong = await s.req('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '203.0.113.97' }, body: 'password=nope' });
  assert.equal(wrong.status, 429, 'a wrong password while the cap is hit is 429');
});

test('demo: refused (409) while the store holds real data (QA-1)', async (t) => {
  const s = await start(); t.after(s.stop);
  const now = Date.now(), ts = (d) => new Date(now - d * DAY).toISOString();
  const stock = ['Time,Variant ID,Stock now', `${ts(2)},5,10`, `${ts(1)},5,8`].join('\n');
  assert.equal((await s.req('/api/import?kind=stock', { method: 'POST', body: stock })).status, 200);
  const r = await s.req('/api/demo', { method: 'POST' });
  assert.equal(r.status, 409);
  assert.equal((await (await s.req('/api/report')).json()).source, 'live');
  assert.equal((await s.req('/api/clear', { method: 'POST' })).status, 200);
  assert.equal((await s.req('/api/demo', { method: 'POST' })).status, 200, 'after Clear the demo can come back');
});

test('login: passwords with ":" work in Basic auth; form sign-in sets a cookie; logout is POST only (SW-008)', async (t) => {
  const pw = 'colon:in:the:password';
  const s = await start({ ADMIN_PASSWORD: pw }); t.after(s.stop);
  assert.equal((await s.req('/api/settings', { headers: basic(pw) })).status, 200);
  assert.equal((await s.req('/api/settings', { headers: basic('colon') })).status, 401);
  const login = await s.req('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=' + encodeURIComponent(pw) });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await s.req('/api/settings', { headers: { cookie } })).status, 200);
  const get = await s.req('/logout', { headers: { cookie } });
  assert.equal(get.status, 303); assert.equal(get.headers.get('set-cookie'), null, 'GET /logout does nothing');
  const post = await s.req('/logout', { method: 'POST', headers: { cookie } });
  assert.equal(post.status, 303); assert.match(post.headers.get('set-cookie'), /Max-Age=0/);
});

test('session: signed with DATA_DIR/secret (mode 600) + password; survives restart, password change signs out (SW-008)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const signIn = async (s, pw) => (await s.req('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=' + encodeURIComponent(pw) })).headers.get('set-cookie').split(';')[0];
  let s = await start({ ADMIN_PASSWORD: PASSWORD }, { dir });
  const cookie = await signIn(s, PASSWORD);
  const secret = path.join(dir, 'secret');
  assert.ok(fs.readFileSync(secret, 'utf8').trim().length >= 32);
  if (process.platform !== 'win32') assert.equal(fs.statSync(secret).mode & 0o777, 0o600);
  await s.stop({ keep: true });
  s = await start({ ADMIN_PASSWORD: PASSWORD }, { dir });
  assert.equal((await s.req('/api/settings', { headers: { cookie } })).status, 200, 'same password: still signed in after restart');
  await s.stop({ keep: true });
  s = await start({ ADMIN_PASSWORD: PASSWORD + '!' }, { dir });
  assert.equal((await s.req('/api/settings', { headers: { cookie } })).status, 401, 'password changed: signed out');
  await s.stop({ keep: true });
  // a cookie forged with the old scheme (HMAC keyed by the password) is refused
  const crypto = require('node:crypto');
  const exp = Date.now() + DAY;
  const forged = `sw_session=${exp}.${crypto.createHmac('sha256', 'stock-watch-session|' + PASSWORD).update(String(exp)).digest('base64url')}`;
  s = await start({ ADMIN_PASSWORD: PASSWORD }, { dir });
  assert.equal((await s.req('/api/settings', { headers: { cookie: forged } })).status, 401);
  await s.stop({ keep: true });
});

test('production never runs open: no or short ADMIN_PASSWORD → exit 1 (SW-008)', async () => {
  for (const pw of [undefined, 'short-pw-11']) {
    const s = await start({ NODE_ENV: 'production', ...(pw ? { ADMIN_PASSWORD: pw } : {}) });
    assert.equal(s.ready, false); assert.equal(await s.exited, 1); assert.match(s.log(), /at least 12 characters/);
    await s.stop();
  }
  const ok = await start({ NODE_ENV: 'production', ADMIN_PASSWORD: 'twelve-chars' });
  assert.equal(ok.ready, true);
  assert.equal((await ok.req('/api/settings')).status, 401);
  await ok.stop();
});

test('ingest: X-Ingest-Key header; ?key= still works but logged as deprecated; > 500 rows → 413 (SW-009)', async (t) => {
  const s = await start({ ADMIN_PASSWORD: PASSWORD }); t.after(s.stop);
  const auth = basic(PASSWORD);
  const key = (await (await s.req('/api/settings', { headers: auth })).json()).settings.ingestKey;
  const row = (i) => ({ variant_id: 5000 + i, sku: 'S' + i, now: 3, before: 4, price: 100, time: new Date(Date.now() - i * 1000).toISOString() });
  const post = (body, headers = {}, q = '') => s.req('/ingest/stock' + q, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post(row(1))).status, 401);
  assert.equal((await post(row(1), { 'x-ingest-key': 'nope' })).status, 401);
  const ok = await post(row(1), { 'x-ingest-key': key });
  assert.equal(ok.status, 200); assert.equal((await ok.json()).added, 1);
  assert.equal((await post(row(2), {}, '?key=' + key)).status, 200);
  assert.match(s.log(), /\?key=\) is deprecated/);
  assert.doesNotMatch(s.log(), new RegExp(key), 'the key is never logged');
  assert.equal((await post(Array.from({ length: 500 }, (_, i) => row(i + 10)), { 'x-ingest-key': key })).status, 200);
  const big = await post(Array.from({ length: 501 }, (_, i) => row(i + 1000)), { 'x-ingest-key': key });
  assert.equal(big.status, 413);
  const csv501 = Array.from({ length: 501 }, (_, i) => `,${9000 + i},S,P,,4,3,100`).join('\n');
  assert.equal((await s.req('/ingest/stock', { method: 'POST', headers: { 'x-ingest-key': key }, body: csv501 })).status, 413);
  // rotating the key records when
  const before = Date.now();
  const st = (await (await s.req('/api/settings', { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ newIngestKey: true }) })).json()).settings;
  assert.notEqual(st.ingestKey, key); assert.ok(st.ingestKeyAt >= before);
  assert.equal((await post(row(3), { 'x-ingest-key': key })).status, 401, 'old key stops working');
});

test('security headers on every response; cross-site writes → 403 (SW-016)', async (t) => {
  const s = await start({ ADMIN_PASSWORD: PASSWORD }); t.after(s.stop);
  for (const p of ['/login', '/api/settings', '/health', '/app.js']) {
    const r = await s.req(p);
    assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors 'none'/, p);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/, p);
    assert.match(r.headers.get('content-security-policy'), /img-src 'self' data: blob: https:\/\/cdn\.shopify\.com;/, p);   // 1.4.0: product pictures from Shopify's CDN only
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer', p);
    assert.equal(r.headers.get('strict-transport-security'), null, `${p}: no HSTS over plain http`);
  }
  assert.match((await s.req('/health', { headers: { 'x-forwarded-proto': 'https' } })).headers.get('strict-transport-security'), /max-age=\d+/);

  const auth = basic(PASSWORD);
  const put = (headers) => s.req('/api/settings', { method: 'PUT', headers: { ...auth, 'content-type': 'application/json', ...headers }, body: '{"storeName":"X"}' });
  const host = new URL(s.base).host;
  assert.equal((await put({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await put({ origin: 'null' })).status, 403);
  assert.equal((await put({ 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await put({ 'sec-fetch-site': 'same-site', origin: 'https://other.up.railway.app' })).status, 403);
  assert.equal((await put({ 'sec-fetch-site': 'same-origin', origin: 'https://web.example' })).status, 200, 'browser says same-origin (proxy rewrote Host)');
  assert.equal((await put({ origin: `http://${host}` })).status, 200, 'same origin');
  assert.equal((await put({ origin: 'https://web.example', 'x-forwarded-host': 'web.example' })).status, 200, 'same origin behind a proxy');
  assert.equal((await put({})).status, 200, 'scripts send no Origin');
  assert.equal((await s.req('/api/settings', { headers: { ...auth, origin: 'https://evil.example' } })).status, 200, 'reads are not blocked');
  assert.equal((await s.req('/api/clear', { method: 'POST', headers: { ...auth, origin: 'https://evil.example' } })).status, 403);
  assert.equal((await s.req('/login', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=x' })).status, 403);
  assert.equal((await s.req('/logout', { method: 'POST', headers: { origin: 'https://evil.example' } })).status, 403);
});

test('bad input → 400, not 500; settings body capped at 64 KB (SW-018)', async (t) => {
  const s = await start({ ADMIN_PASSWORD: PASSWORD }); t.after(s.stop);
  const auth = { ...basic(PASSWORD), 'content-type': 'application/json' };
  const put = (body) => s.req('/api/settings', { method: 'PUT', headers: auth, body });
  for (const body of ['{bad json', 'null', '[]', '42', '"text"']) {
    const r = await put(body);
    assert.equal(r.status, 400, body); assert.match((await r.json()).error, /JSON/, body);
  }
  assert.equal((await put('')).status, 200, 'empty body = no change');
  assert.equal((await put(JSON.stringify({ storeName: 'x'.repeat(70 * 1024) }))).status, 413);
  assert.equal((await put(JSON.stringify({ storeName: 'Fine' }))).status, 200, 'server still fine after a refused body');
  assert.equal((await s.req('/api/product/%E0%A4%A', { headers: auth })).status, 400);
  assert.equal((await s.req('/api/product/%ZZ', { headers: auth })).status, 400);
  // static files stay inside public/ (encoded dots don't walk out)
  for (const p of ['/..%2fserver.js', '/%2e%2e/server.js', '/..%5cserver.js']) {
    const r = await s.req(p, { headers: auth });
    assert.ok([200, 403].includes(r.status), p);
    assert.doesNotMatch(await r.text(), /require\('node:http'\)/, p);
  }
  assert.doesNotMatch(s.log(), /SyntaxError|URIError|TypeError/, 'nothing reached the 500 handler');
});

test('login page on a phone: 16 px fields (no iOS zoom on the autofocused password) and 44 px targets (final critic M9)', async (t) => {
  const s = await start({ ADMIN_PASSWORD: PASSWORD }); t.after(s.stop);
  const html = await (await s.req('/login')).text();
  assert.match(html, /@media\(max-width:760px\)\{input,button\{font-size:16px;min-height:44px\}\}/);
  assert.match(html, /autofocus/);
});

test('POST /api/shopify/history (SW-063): admin only, 400 without Shopify; demo report still works', async (t) => {
  const s = await start({ ADMIN_PASSWORD: PASSWORD, VIEW_PASSWORD: PASSWORD + '-view' }); t.after(s.stop);
  assert.equal((await s.req('/api/shopify/history', { method: 'POST', headers: basic(PASSWORD + '-view') })).status, 403);
  const r = await s.req('/api/shopify/history', { method: 'POST', headers: basic(PASSWORD) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /isn’t connected/);
  const set = await (await s.req('/api/settings', { headers: basic(PASSWORD) })).json();
  assert.equal(set.shopify.history, null);
  assert.equal((await s.req('/api/report', { headers: basic(PASSWORD) })).status, 200);
});

/* SW-064: /api/report and /api/product carry the return fields (the demo has returns) */
test('report: products and totals carry returns (unitsOrdered, unitsReturned, returnPct, refundValue)', async (t) => {
  const s = await start(); t.after(s.stop);
  const r = await (await s.req('/api/report?days=30')).json();
  assert.equal(r.source, 'demo');
  for (const k of ['unitsOrdered', 'unitsReturned', 'refundValue']) assert.equal(typeof r.products[0][k], 'number', k);
  assert.ok('returnPct' in r.products[0]);
  assert.ok(r.totals.unitsOrdered > 0 && r.totals.unitsReturned > 0 && r.totals.returnPct > 0 && r.totals.refundValue > 0);
  assert.ok(r.totals.highReturns >= 1, 'a few demo products come back a lot');
  const hi = r.products.find((p) => p.returnPct >= 15);
  const d = await (await s.req(`/api/product/${encodeURIComponent(hi.id)}?days=30`)).json();
  assert.equal(d.product.returnPct, hi.returnPct);
});
