'use strict';
/* 4.3: the brand's own factor (src/model.js factors) in place of the fixed 0.74, on made-up stores: steady sellers ≈ 1, fading
   slow sellers clearly under 1, too little history → 1 (flagged), a wild store is capped (flagged), 30-day checks that never overlap
   and hold nothing out, a locked month keeps (and is explained with) the factor it was locked with, and the page's sum is the factor. */
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/truth'), M = require('../src/model'), S = require('../src/screen');
const { keyPlus } = require('../src/agency');
const FROM = '2025-11-01', N = 390, TO = keyPlus(FROM, N - 1), DAY = (i) => keyPlus(FROM, i);
const opts = { dayOf: (t) => new Date(t).toISOString().slice(0, 10) };

/** rows { id, sell(i) (pieces, may be a fraction), price, gaps: [[a, b]] } → year.json + catalog; always in stock unless a gap */
function shop(rows, n = N) {
  const to = keyPlus(FROM, n - 1), y = { sales: { from: FROM, to, by: {}, all: {} }, moves: { from: FROM, to, by: {} }, anchor: { at: 1, day: keyPlus(to, 1), levels: {} }, done: true }, cat = {};
  for (const r of rows) {
    cat[r.id] = { productId: `p${r.id}`, product: `Row ${r.id}`, variant: '', price: r.price, active: true, tracked: true };
    const st = (i) => ((r.gaps || []).some(([a, b]) => i >= a && i < b) ? 0 : 1e6), by = {}, mv = {};
    for (let i = 0; i < n; i++) {
      const full = st(i) > 0 && (i === 0 ? st(0) > 0 : st(i - 1) > 0), u = full ? r.sell(i) : 0;
      if (u) { by[DAY(i)] = [u, u * r.price, 0, u * r.price]; const t = y.sales.all[DAY(i)] || (y.sales.all[DAY(i)] = [0, 0]); t[0] += u; t[1] += u * r.price; }
      const d = st(i) - (i ? st(i - 1) : st(0)); if (d) mv[DAY(i)] = d;
    }
    y.sales.by[r.id] = by; y.moves.by[r.id] = mv; y.anchor.levels[r.id] = st(n - 1);
  }
  return { y, cat };
}
/** the facts, ready for M.factors */
function facts(rows) {
  const { y, cat } = shop(rows), F = T.facts(y, cat, opts);
  T.sums(F); F.shop = F.keys.map((k) => Number((y.sales.all[k] || [])[1]) || 0); M.prepare(F); return F;
}
const many = (n, start, price, sell) => Array.from({ length: n }, (_, k) => ({ id: String(start + k), price, sell: (i) => sell(i, k) }));
const bestIds = (F) => (r) => +r.id < 200;   // rows 100–199 = the best sellers, 200+ = the rest

test('steady sellers: both factors come out about 1 (nothing to correct)', () => {
  const F = facts([...many(14, 100, 1000, (i, k) => ((i + k) % 2 ? 1 : 0)), ...many(14, 200, 300, (i, k) => ((i + k) % 3 === 0 ? 1 : 0))]);
  const f = M.factors(F, bestIds(F));
  for (const k of ['best', 'other']) {
    assert.equal(f[k].flag, null, k); assert.ok(f[k].n >= 100 && f[k].p >= 10, `${k}: ${f[k].n} stretches, ${f[k].p} products`);
    assert.ok(Math.abs(f[k].f - 1) < 0.03, `${k} ${f[k].f}`); assert.equal(f[k].f, Math.round(((f[k].n * f[k].raw + 100) / (f[k].n + 100)) * 1e4) / 1e4);
  }
  assert.deepEqual(M.factors(F, bestIds(F)), f, 'the same data, the same factors');
});

test('30-day checks never overlap, hold nothing out, never start within 30 days of a refill; their ₹ never exceed what was sold', () => {
  const one = (gaps) => { const F = facts([{ id: '200', price: 300, sell: () => 1, gaps }]); return M.factors(F, () => false).other; };
  const clean = one([]);
  assert.ok(clean.n <= Math.ceil(N / 30) && clean.n >= Math.floor((N - 90) / 30) - 1, `one row, ${clean.n} checks`);
  assert.ok(clean.real <= N * 300, 'each day counted at most once');
  const out = one([[IXd('2026-05-10'), IXd('2026-05-14')]]);
  assert.ok(out.n <= clean.n - 2, `a gap takes out the check it falls in and the one just after the refill: ${clean.n} → ${out.n}`);
  const F = facts([...many(14, 100, 1000, (i, k) => ((i + k) % 2 ? 1 : 0)), ...many(14, 200, 300, (i, k) => ((i + k) % 3 === 0 ? 1 : 0))]), f = M.factors(F, bestIds(F));
  const sold = F.rows.reduce((q, r) => q + r.net.reduce((a, b) => a + b, 0), 0);
  assert.ok(f.best.real + f.other.real <= sold, 'never more than the brand sold');
});

test('fading slow sellers: the rest come out clearly under 1; best sellers stay about 1', () => {
  const F = facts([...many(14, 100, 100000, (i, k) => ((i + k) % 2 ? 1 : 0)), ...many(14, 200, 300, (i, k) => 5 * 2 ** (-(i + k) / 200))]);
  const f = M.factors(F, bestIds(F));
  assert.equal(f.other.flag, null); assert.ok(f.other.raw < 0.9 && f.other.f < 0.93, `other ${f.other.raw} → ${f.other.f}`);
  assert.ok(f.other.f > f.other.raw, 'leans toward 1 (100 stretches’ weight)');
  assert.ok(Math.abs(f.best.f - 1) < 0.03, `best ${f.best.f}`);
});

test('too little history: under 100 stretches or 10 products → factor 1, flagged; the money is not corrected', () => {
  const rows = [...many(12, 100, 1000, (i, k) => ((i + k) % 2 ? 1 : 0)), { id: '1', price: 300, sell: (i) => (i % 5 === 0 ? 1 : 0), gaps: [[IXd('2026-08-05'), IXd('2026-08-15')]] }];
  const { y, cat } = shop(rows), r = T.report(y, cat, opts);
  assert.equal(r.factor.other.flag, 'few'); assert.equal(r.factor.other.f, 1); assert.ok(r.factor.other.p < 10);
  const p = r.rows.find((x) => x.id === '1').months['2026-08'].parts[0]; assert.equal(p.adj, 1); assert.equal(p.grp, 'other'); assert.ok(p.lost > 0);
  const F = facts(many(9, 200, 300, () => 1)), f = M.factors(F, () => false); assert.equal(f.other.p, 9); assert.equal(f.other.flag, 'few', 'under 10 products');
});
function IXd(k) { return Math.round((Date.parse(k) - Date.parse(FROM)) / 864e5); }

test('a store far off the guess is capped at 0.5–1.5 and flagged', () => {
  const F = facts([...many(14, 100, 1e7, (i, k) => ((i + k) % 2 ? 1 : 0)), ...many(14, 200, 300, (i, k) => 1000 * 2 ** (-(i + k) / 20))]);
  const f = M.factors(F, bestIds(F));
  assert.equal(f.other.flag, 'clip'); assert.equal(f.other.f, 0.5); assert.ok(f.other.raw < 0.3, `${f.other.raw}`);
  const G = facts([...many(14, 100, 1e7, (i, k) => ((i + k) % 2 ? 1 : 0)), ...many(14, 200, 300, (i, k) => 2 ** ((i + k) / 25))]);
  const g = M.factors(G, bestIds(G)); assert.equal(g.other.flag, 'clip'); assert.equal(g.other.f, 1.5);
});

test('lock: a closed month keeps the factor it was locked with when later data changes; the open month uses today’s', () => {
  const rows = [...many(14, 100, 1000, (i, k) => ((i + k) % 2 ? 1 : 0)), ...many(14, 200, 300, (i, k) => 5 * 2 ** (-(i + k) / 200)),
    ...Array.from({ length: 4 }, (_, k) => ({ id: String(300 + k), price: 300, sell: () => 1, gaps: [[IXd('2026-08-05'), IXd('2026-08-15')], [IXd('2026-11-10'), IXd('2026-11-20')]] }))];
  const a0 = shop(rows), a = T.report(a0.y, a0.cat, opts), led = JSON.parse(JSON.stringify({ rule: T.RULE, ...a.lock }));
  assert.equal(T.RULE, '4.4'); assert.ok(led.months['2026-08'].factor, 'the factor is saved with the month');
  const aug = (r) => r.months.find((m) => m.key === '2026-08'), part = (r, m) => r.rows.find((x) => x.id === '300').months[m].parts[0];
  /* later data: the slow sellers fade much faster, so today's factor drops */
  const rows2 = rows.map((r) => (+r.id >= 200 && +r.id < 300 ? { ...r, sell: (i) => 5 * 2 ** (-(i) / 60) } : r)), b0 = shop(rows2), b = T.report(b0.y, b0.cat, { ...opts, ledger: led });
  assert.notEqual(b.factor.other.f, a.factor.other.f, 'today’s factor moved');
  assert.deepEqual(aug(b).factor, aug(a).factor, 'August keeps its factor'); assert.equal(part(b, '2026-08').adj, part(a, '2026-08').adj); assert.equal(aug(b).all.lost, aug(a).all.lost);
  assert.equal(part(b, '2026-11').adj, b.factor[part(b, '2026-11').grp].f, 'November (open) uses today’s');
  for (const t of [a, b]) assert.ok(t.months.every((m) => m.factor && m.factor.best && m.factor.other));
  /* the panel explains each month with its own factor */
  const prof = S.profile({ ok: true, months: b.months.map((m) => ({ key: m.key })), pace: {} }, b, '300'), parts = prof.work.gaps.flatMap((g) => g.parts);
  const pa = parts.find((p) => p.month === '2026-08'), pn = parts.find((p) => p.month === '2026-11');
  assert.deepEqual(pa.factor, aug(a).factor, 'August: the factor it was locked with'); assert.equal(pa.adj, pa.factor[pa.grp].f);
  assert.deepEqual(pn.factor, b.factor, 'November: today’s'); assert.equal(pn.adj, b.factor[pn.grp].f);
});

/* the page's working ("(n × raw + 100) ÷ (n + 100) = × f") is the stored factor, worked out again by hand */
test('the shrink on the page reproduces the stored factor; too little history says so', () => {
  const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
  const noop = () => {}, el = { addEventListener: noop, getElementById: () => null, querySelector: () => null };
  const ctx = { window: {}, document: el, matchMedia: () => ({ matches: false }), localStorage: { getItem: () => null, setItem: noop }, location: { search: '', href: 'http://x/' }, history: { replaceState: noop }, URLSearchParams, URL, Intl, console };
  ctx.window = ctx; vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'brand.js'), 'utf8'), ctx);
  ctx.SW_BRAND.init({ esc: (x) => String(x), state: {} });
  const F = facts([...many(14, 100, 100000, (i, k) => ((i + k) % 2 ? 1 : 0)), ...many(14, 200, 300, (i, k) => 5 * 2 ** (-(i + k) / 200))]), f = M.factors(F, bestIds(F));
  const html = ctx.SW_BRAND.factorText(f, 'other'), m = html.replace(/<[^>]+>/g, '').match(/\(([\d,]+) × (\d+\.\d+) \+ 100\) ÷ ([\d,]+) = × (\d+\.\d+)/), n = (x) => +x.replace(/,/g, '');
  assert.ok(m, html); assert.equal(n(m[1]), f.other.n); assert.equal(n(m[3]), f.other.n + 100);
  assert.ok(Math.abs((n(m[1]) * +m[2] + 100) / n(m[3]) - +m[4]) <= 0.0011, `the sum on the page checks by hand: ${m[0]}`); assert.equal(+m[4], Math.round(f.other.f * 1000) / 1000, 'and is the factor used');
  assert.match(html.replace(/<[^>]+>/g, ''), / 30-day checks with nothing out, we guessed ₹[\d.,]+( lakh| crore)?; they really sold ₹/);
  assert.match(ctx.SW_BRAND.factorText({ other: { f: 1, raw: 0.8, n: 40, p: 4, real: 1, guess: 1, flag: 'few' } }, 'other'), /not enough history to check yet: no correction/);
  assert.match(ctx.SW_BRAND.factorText({ best: { f: 1.002, raw: 1.003, n: 400, p: 40, real: 1e6, guess: 1e6, flag: null } }, 'best'), /Already right, no correction\./);
  assert.match(ctx.SW_BRAND.factorText({ other: { f: 0.5, raw: 0.13, n: 230, p: 14, real: 1e5, guess: 8e5, flag: 'clip' } }, 'other'), /capped at 0\.5 \/ 1\.5: check the data: × 0\.500/);
});
