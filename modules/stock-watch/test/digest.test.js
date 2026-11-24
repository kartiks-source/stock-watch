'use strict';
/* SW-028: morning digest text (src/digest.js), delivery and schedule (src/digest-service.js), routes. LOGIC.md §17. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-digest-test-'));
for (const k of Object.keys(process.env)) if (k.startsWith('DIGEST_WEBHOOK_URL')) delete process.env[k];
delete process.env.PUBLIC_URL; delete process.env.RAILWAY_PUBLIC_DOMAIN;
delete process.env.ADMIN_PASSWORD; delete process.env.SHOPIFY_STORE; delete process.env.AZURE_KEY_VAULT_URL;

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const E = require('../src/engine');
const P = require('../src/period');
const demo = require('../src/demo');
const store = require('../src/store');
const D = require('../src/digest');
const S = require('../src/digest-service');
const ROLES = require('../public/roles');
require('../src/scope').useDir(path.join(process.env.DATA_DIR, 'stores', 'sammsara-demo'));   // the server's first store

const DAY = E.DAY;
const now = Date.parse('2026-11-19T04:30:00Z');                  // Thu 19 Nov, 10:00 IST
const g = demo.generate({ now });
store.replaceAll(g.stock, g.orders, 'demo');
store.setSettings({ storeName: 'Test Store', tzOffsetMin: 330 });
const ctx = {
  report({ days, now: at }) {
    const d = store.load(), x = P.asOf(d.stock, d.orders, at);
    const r = E.report(x.stock, x.orders, d.settings, { days, now: at });
    r.yesterday = P.yesterdayFor(x.stock, x.orders, d.settings, r);
    return r;
  },
  pulls: 0,
  async pull() { this.pulls++; },
};

/* a webhook that records what it receives */
const got = [];
let hookStatus = 200;
const hook = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { got.push({ headers: req.headers, body: JSON.parse(b) }); res.writeHead(hookStatus); res.end('ok'); }); });
let HOOK = '';
test.before(() => new Promise((r) => hook.listen(0, '127.0.0.1', () => { HOOK = `http://127.0.0.1:${hook.address().port}/hook?token=SECRET123`; r(); })));
test.after(() => hook.close());

test('every role’s digest: title + at most 5 lines, plain words, no undefined/NaN', () => {
  for (const role of ['', ...ROLES.ORDER]) {
    const d = S.make(role, ctx, now);
    assert.ok(d.lines.length >= 2 && d.lines.length <= D.MAX_LINES, `${role}: ${d.lines.length} lines`);
    assert.match(d.lines[0], /^Stock-out Watch · Test Store · Thu 19 Nov/);
    assert.doesNotMatch(d.text, /undefined|NaN|null|Infinity|\[object/, role);
    assert.ok(d.lines.every((l) => l.length <= 160), `${role}: a line is too long: ${d.lines.find((l) => l.length > 160)}`);
  }
});

test('founder digest leads with order today and still-out cost; numbers match the report', () => {
  const r = ctx.report({ days: 30, now });
  const d = D.build({ report: r, yesterday: r.yesterday, role: 'founder', storeName: 'S', now });
  assert.equal(d.lines[1], `Order today: ${D.money(r.totals.orderValueNow)} across ${r.totals.orderToday} products (${r.totals.bestAtRisk} of them best sellers).`);
  assert.match(d.lines[2], new RegExp(`^Still out of stock: ${r.totals.stillOut} products, costing about ₹`));
  assert.match(d.lines[3], /^Yesterday: ₹/);
});

test('still-out cost per day = in-stock rate × price paid, for products at 0 that sell', () => {
  const r = { products: [{ stock: 0, perDay: 2, price: 500 }, { stock: -1, perDay: 0.5, price: 1000 }, { stock: 0, perDay: 0, price: 900 }, { stock: 5, perDay: 9, price: 100 }, { stock: null, perDay: 3, price: 10 }] };
  assert.equal(D.stillOutPerDay(r), 1500);
});

test('marketing pause list = the page’s Pause promotion list (out of stock or fewer days left than the lead time); push list: overstock by ₹', () => {
  const r = { settings: { leadDays: 7 }, products: [
    { name: 'a', stock: 0, perDay: 1, daysLeft: null, sold: 10 }, { name: 'b', stock: 10, perDay: 2, daysLeft: 5, sold: 50 },
    { name: 'c', stock: 50, perDay: 2, daysLeft: 25, sold: 90 }, { name: 'd', stock: 0, perDay: 0, daysLeft: null, sold: 0 },
    { name: 'e', stock: 900, perDay: 1, daysLeft: 900, sold: 5, overstock: true, excessValue: 800 }, { name: 'f', stock: 90, overstock: true, excessValue: 9000, perDay: 0 },
  ] };
  assert.deepEqual(D.pauseList(r).map((p) => p.name), ['a', 'd', 'b'], 'the Products → Pause promotion rule and order (LOGIC.md §15c): out first, then fewest days left');
  assert.deepEqual(D.pushList(r).map((p) => p.name), ['f', 'e']);
});

test('CEO compares with the 7 days before (rows as they stood then)', () => {
  const d = S.make('ceo', ctx, now);
  assert.match(d.lines[1], /^Sales lost to stock-outs, last 7 days: ₹[\d.,]+( L| Cr)? \([\d.]+% of demand\), (up|down) from ₹|same as the 7 days before/);
});

test('deep link opens the role’s home view', () => {
  const r = ctx.report({ days: 30, now });
  assert.equal(D.build({ report: r, role: 'ops', base: 'https://x.app/' }).link, 'https://x.app/?role=ops#reorder');
  assert.equal(D.build({ report: r, role: '', base: 'https://x.app' }).link, 'https://x.app/#overview');
  assert.equal(D.build({ report: r, role: 'ops' }).link, '');
  assert.match(D.build({ report: r, role: 'ops', base: 'https://x.app' }).text, /\nOpen: https:\/\/x\.app\/\?role=ops#reorder$/);
});

test('webhook URL: https only (http just for this machine); bad hour refused; never saved from the page (env only)', () => {
  assert.equal(S.checkUrl('https://hooks.example.com/a'), '');
  assert.equal(S.checkUrl('http://127.0.0.1:9/x'), '');
  assert.match(S.checkUrl('http://hooks.example.com/a'), /https/);
  assert.match(S.checkUrl('ftp://x'), /https/);
  assert.match(S.checkUrl('not a url'), /valid/);
  assert.match(S.applyPatch({ hour: 24 }), /0–23/);
  assert.match(S.applyPatch({ webhookUrl: 'https://hooks.example.com/a' }), /DIGEST_WEBHOOK_URL/);
  assert.match(S.applyPatch({ webhookUrl: '' }), /DIGEST_WEBHOOK_URL/);
  assert.equal(S.publicConf().webhook.set, false);
  assert.equal(store.load().digest.webhookUrl, undefined);
});

test('settings never show the webhook URL, only its host; never stored', () => {
  process.env.DIGEST_WEBHOOK_URL = HOOK;
  assert.equal(S.applyPatch({ hour: 9, paused: false }), '');
  const c = S.publicConf();
  assert.equal(c.webhook.set, true);
  assert.equal(c.webhook.host, new URL(HOOK).host);
  assert.doesNotMatch(JSON.stringify(c), /SECRET123/);
  assert.doesNotMatch(JSON.stringify(store.load()), /SECRET123/);   // not in the store (data volume), so not in GET /api/settings either
});

test('digest settings changes go to the store’s change log (SW-029): hour, roles, pause; nothing for a no-op save', () => {
  const audit = require('../src/audit');
  const n0 = audit.recent(store.load(), 200).length;
  assert.equal(S.applyPatch({ hour: 9, paused: false }), '');   // same as now
  assert.equal(audit.recent(store.load(), 200).length, n0, 'no change, no entry');
  assert.equal(S.applyPatch({ hour: 7, paused: true, roles: ['ops', 'founder'] }, 'admin (script)'), '');
  const top = audit.recent(store.load(), 3);
  assert.deepEqual(top.map((e) => e.key).sort(), ['digest.hour', 'digest.paused', 'digest.roles']);
  assert.ok(top.every((e) => e.by === 'admin (script)'));
  assert.deepEqual(top.find((e) => e.key === 'digest.hour'), { ...top.find((e) => e.key === 'digest.hour'), old: 9, new: 7 });
  assert.equal(top.find((e) => e.key === 'digest.roles').new, 'founder, ops');   // in the app's role order
  assert.equal(top.find((e) => e.key === 'digest.paused').old, false);
  assert.equal(S.applyPatch({ hour: 9, paused: false, roles: S.publicConf().scheduled.map((x) => x.role) }), '');   // back to the defaults
});

test('a webhook changed on the server (env) is logged once by "server (env)", host only, never the URL', () => {
  const audit = require('../src/audit');
  S.noteWebhook();   // current env seen
  const n0 = audit.recent(store.load(), 200).length;
  S.noteWebhook();
  assert.equal(audit.recent(store.load(), 200).length, n0, 'unchanged: nothing logged');
  process.env.DIGEST_WEBHOOK_URL_CEO = 'https://own.example.com/x?token=CEOSECRET';
  try {
    S.noteWebhook(); S.noteWebhook();
    const log = audit.recent(store.load(), 200);
    assert.equal(log.length, n0 + 1, 'logged once');
    assert.equal(log[0].key, 'digest.webhook'); assert.equal(log[0].by, 'server (env)');
    assert.match(log[0].new, /ceo → own\.example\.com/);
    assert.doesNotMatch(JSON.stringify(store.load()), /CEOSECRET/);
  } finally { delete process.env.DIGEST_WEBHOOK_URL_CEO; S.noteWebhook(); }
});

test('per-role recipients: DIGEST_WEBHOOK_URL_<ROLE> wins for that role, the others use DIGEST_WEBHOOK_URL', () => {
  const other = 'https://hooks.example.com/ceo?token=CEOSECRET';
  process.env.DIGEST_WEBHOOK_URL_CEO = other;
  try {
    const c = S.publicConf();
    const ceo = c.scheduled.find((x) => x.role === 'ceo'), ops = c.scheduled.find((x) => x.role === 'ops');
    assert.equal(ceo.own, true); assert.equal(ceo.host, 'hooks.example.com');
    assert.equal(ops.own, false); assert.equal(ops.host, new URL(HOOK).host);
    assert.doesNotMatch(JSON.stringify(c), /CEOSECRET/);
    delete process.env.DIGEST_WEBHOOK_URL;                                   // only the CEO has one: only the CEO is due (Monday)
    const at = Date.parse('2026-11-30T00:00:00Z') - 330 * 60e3 + 9.2 * 36e5;
    assert.deepEqual(S.due(at).map((x) => x.role), ['ceo']);
  } finally { delete process.env.DIGEST_WEBHOOK_URL_CEO; process.env.DIGEST_WEBHOOK_URL = HOOK; }
});

test('catch-up window wraps past midnight: a 23:00 send still goes at 01:00, counted for the day before', () => {
  const at = (h, d) => Date.parse(`${d}T00:00:00Z`) - 330 * 60e3 + h * 36e5;
  const keep = { ...store.load().digest, lastSent: { ...store.load().digest.lastSent } };
  try {
    S.applyPatch({ hour: 23, roles: ['ops'], paused: false });
    store.load().digest.lastSent = {};
    assert.deepEqual(S.due(at(22.9, '2026-12-01')), []);
    assert.deepEqual(S.due(at(23.5, '2026-12-01')), [{ role: 'ops', day: '2026-12-01' }]);
    assert.deepEqual(S.due(at(1.5, '2026-12-02')), [{ role: 'ops', day: '2026-12-01' }]);   // 2.5 h after 23:00
    assert.deepEqual(S.due(at(2, '2026-12-02')), []);                                       // 3 h: window closed
    store.load().digest.lastSent = { ops: '2026-12-01' };
    assert.deepEqual(S.due(at(1.5, '2026-12-02')), []);                                     // sent at 23:00: not again after midnight
    S.applyPatch({ hour: 22, roles: ['ceo'] });
    store.load().digest.lastSent = {};
    assert.deepEqual(S.due(at(0.5, '2026-11-23')), []);                                     // Mon 00:30 belongs to Sun 22:00: not a Monday send
    assert.deepEqual(S.due(at(0.5, '2026-11-24')), [{ role: 'ceo', day: '2026-11-23' }]);   // Tue 00:30 belongs to Mon 22:00: the CEO's Monday digest
  } finally { Object.assign(store.load().digest, keep); store.save(true); }
});

test('schedule: nothing before the hour; at 9:00 store time pulls first, then sends each daily role once; Monday-only roles skip Thursday', async () => {
  got.length = 0; ctx.pulls = 0;
  S.applyPatch({ hour: 9, roles: ROLES.ORDER, paused: false });
  const at = (h, d = '2026-11-19') => Date.parse(`${d}T00:00:00Z`) - 330 * 60e3 + h * 36e5;   // h:00 IST on that day
  assert.deepEqual(await S.tick(ctx, at(8.5)), []);
  const sent = await S.tick(ctx, at(9.1));
  assert.equal(ctx.pulls, 1);
  assert.deepEqual(sent.map((s) => s.role).sort(), ['founder', 'marketing', 'ops']);   // buyer/warehouse aren't scheduled; ceo/finance on Mondays
  assert.ok(sent.every((s) => s.ok && s.status === 200));
  assert.equal(got.length, 3);
  assert.equal(got[0].headers['content-type'], 'application/json');
  assert.deepEqual(Object.keys(got[0].body).sort(), ['app', 'at', 'kind', 'lines', 'link', 'role', 'roleName', 'store', 'storeId', 'text', 'title']);
  assert.deepEqual(await S.tick(ctx, at(10)), []);                       // once a day
  assert.deepEqual(await S.tick(ctx, at(12.5, '2026-11-20')), []);       // next day, past the 3 h catch-up window
  const mon = await S.tick(ctx, at(9.5, '2026-11-23'));                  // Monday: weekly roles too
  assert.deepEqual(mon.map((s) => s.role).sort(), ['ceo', 'finance', 'founder', 'marketing', 'ops']);
});

test('pause stops the schedule; a failed send is logged, not retried all morning', async () => {
  const at = (h, d) => Date.parse(`${d}T00:00:00Z`) - 330 * 60e3 + h * 36e5;
  S.applyPatch({ paused: true });
  assert.deepEqual(await S.tick(ctx, at(9.2, '2026-11-24')), []);
  S.applyPatch({ paused: false });
  hookStatus = 500;
  const bad = await S.tick(ctx, at(9.2, '2026-11-24'));
  assert.ok(bad.length && bad.every((s) => !s.ok && s.error === 'HTTP 500'));
  assert.deepEqual(await S.tick(ctx, at(9.4, '2026-11-24')), []);
  hookStatus = 200;
  const log = S.publicConf().log;
  assert.equal(log[0].ok, false);
  assert.equal(log[0].trigger, 'schedule');
  assert.ok(log.length <= 20);
});

test('routes: digest JSON + text, bad role 400, settings PUT validates, send-now logs', async () => {
  const { server } = require('../server');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const j = await (await fetch(`${base}/api/digest?role=ops`)).json();
    assert.equal(j.ok, true); assert.equal(j.role, 'ops'); assert.ok(j.lines.length <= 6);
    assert.equal(j.link, `${base}/?store=sammsara-demo&role=ops#reorder`);   // link from the address the app was opened at; opens this store
    const t = await fetch(`${base}/api/digest.txt?role=marketing`);
    assert.match(t.headers.get('content-type'), /text\/plain/);
    assert.match(await t.text(), /^Stock-out Watch · Test Store/);
    assert.equal((await fetch(`${base}/api/digest?role=intern`)).status, 400);
    assert.equal((await fetch(`${base}/api/digest?role=all`)).status, 200);
    assert.equal((await fetch(`${base}/api/digest/settings`, { method: 'PUT', body: '{bad' })).status, 400);
    assert.equal((await fetch(`${base}/api/digest/settings`, { method: 'PUT', body: JSON.stringify({ webhookUrl: 'http://x.example' }) })).status, 400);
    const s = await (await fetch(`${base}/api/digest/settings`)).json();
    assert.doesNotMatch(JSON.stringify(s), /SECRET123/);
    assert.equal((await fetch(`${base}/api/digest/settings`, { method: 'PUT', body: JSON.stringify({ hour: 6 }) })).status, 200);
    const log = (await (await fetch(`${base}/api/settings`)).json()).changes;   // the change log under Settings (SW-029)
    assert.deepEqual({ key: log[0].key, old: log[0].old, new: log[0].new, by: log[0].by }, { key: 'digest.hour', old: 9, new: 6, by: 'admin' });
    await fetch(`${base}/api/digest/settings`, { method: 'PUT', body: JSON.stringify({ hour: 9 }) });
    const before = got.length;
    const sent = await (await fetch(`${base}/api/digest/send?role=buyer`, { method: 'POST' })).json();
    assert.equal(sent.ok, true); assert.equal(got.length, before + 1); assert.equal(got.at(-1).body.role, 'buyer');
    assert.equal(S.publicConf().log[0].trigger, 'manual');
  } finally { server.close(); }
});

test('CEO "7 days before" ends a stock-out at archive time: a variant archived while out counts ₹0 then (critic r2 L1)', () => {
  const { digestCtx } = require('../server');
  const d = store.load(), T = Date.now();
  const id = 'arch-while-out';
  const rowsS = [{ t: T - 60 * DAY, variantId: id, sku: 'ARCH', product: 'Archived lamp', variant: '', before: 10, now: 10, price: 1000 },
    { t: T - 40 * DAY, variantId: id, sku: 'ARCH', product: 'Archived lamp', variant: '', before: 1, now: 0, price: 1000 }];
  const rowsO = Array.from({ length: 19 }, (_, i) => ({ t: T - 60 * DAY + i * DAY, order: `#arch${i}`, variantId: id, sku: 'ARCH', qty: 1, price: 1000 }));
  d.stock.push(...rowsS); d.orders.push(...rowsO);
  d.catalog[id] = { active: false, status: 'ARCHIVED', inactiveSince: T - 30 * DAY, stock: 0, price: 1000, product: 'Archived lamp' };
  try {
    const lostOf = (r) => (r.products.find((p) => p.id === id) || { lost: 0 }).lost;
    assert.equal(lostOf(digestCtx.report({ days: 7, now: T - 7 * DAY })), 0, 'archived 30 d ago: nothing lost in the 7 days before');
    assert.ok(lostOf(digestCtx.report({ days: 7, now: T - 35 * DAY })) > 0, 'before it was archived it was still out and losing sales');
    assert.deepEqual(P.catalogAsOf(d.catalog, T - 35 * DAY)[id], undefined, 'not yet archived then: no flag');
    assert.deepEqual(P.catalogAsOf(d.catalog, T - 7 * DAY)[id], { active: false, status: 'ARCHIVED', inactiveSince: T - 30 * DAY }, 'flags only, no stock or price');
  } finally {
    d.stock.splice(d.stock.length - rowsS.length); d.orders.splice(d.orders.length - rowsO.length); delete d.catalog[id];
  }
});

test('no unit costs: the digest says "at selling price", never "cash" (SIMP-1)', () => {
  const r = ctx.report({ days: 30, now });
  r.totals = { ...r.totals, hasCost: false, orderToday: 3, orderValueNow: 12345, excessValue: 5000, overstocked: 2 };
  const d = D.build({ report: r, yesterday: r.yesterday, role: 'founder', storeName: 'S', now });
  assert.match(d.text, /Order today: ₹12,345 at selling price across 3 products/);
  assert.match(d.text, /Overstock at selling price: ₹5,000 in 2 products/);
  assert.doesNotMatch(d.text, /Cash/);
});
