'use strict';
/*
 * /api/v1: the stable contract for other Catalys tools (SW-050, API.md §v1).
 *
 *   rewrite(url)   /api/v1/<x> → /api/<x> with url.v1 = true: every current route answers at both paths, same auth
 *                  (cookie or Basic), same store pick, same view-only and cross-site checks, same handler.
 *   handle(...)    the two routes that exist only under /api/v1:
 *     GET /api/v1/summary   headline numbers only (₹ and counts), a few hundred bytes
 *     GET /api/v1/rows      report rows, one view at a time, paginated: ?view=reorder|stockouts|products&limit=&cursor=
 *
 * Rows come in a stable order that doesn't move when sales or stock change: by variant ID (stockouts: then by start
 * time), compared as text. The cursor is the key of the last row sent, so a page never repeats or skips a row that
 * was there on both calls, even when the numbers moved in between. Sort by ₹ on your side.
 */
const PREFIX = '/api/v1/';
const VIEWS = ['reorder', 'stockouts', 'products'];
const LIMIT_DEFAULT = 100, LIMIT_MAX = 500;
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

/** /api/v1/<x> → /api/<x>; returns true (and marks url.v1) when it was a v1 address. */
function rewrite(url) {
  if (!url.pathname.startsWith(PREFIX)) return false;
  url.pathname = '/api/' + url.pathname.slice(PREFIX.length);
  url.v1 = true;
  return true;
}

/** A row's place in the stable order: [variant ID, start] (start only for stock-outs, else 0). */
const keyOf = (view, r) => [String(r.id), view === 'stockouts' ? Number(r.start) || 0 : 0];
const cmp = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]);
const encode = (k) => Buffer.from(JSON.stringify(k)).toString('base64url');
function decode(c) {
  let k; try { k = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')); } catch { k = null; }
  if (!Array.isArray(k) || k.length !== 2 || typeof k[0] !== 'string' || !Number.isFinite(k[1])) throw badRequest('Bad cursor: pass back the `next` value from the last page');
  return k;
}

/** One page of rows. Exported for tests. */
function page(view, list, limitRaw, cursor) {
  if (!VIEWS.includes(view)) throw badRequest(`view must be one of ${VIEWS.join(', ')}`);
  let limit = LIMIT_DEFAULT;
  if (limitRaw != null && limitRaw !== '') {
    if (!/^\d+$/.test(limitRaw) || +limitRaw < 1) throw badRequest(`limit must be a whole number 1–${LIMIT_MAX}`);
    limit = Math.min(LIMIT_MAX, +limitRaw);
  }
  const after = cursor ? decode(cursor) : null;
  const sorted = list.map((r) => [keyOf(view, r), r]).sort((a, b) => cmp(a[0], b[0]));
  const from = after ? sorted.findIndex(([k]) => cmp(k, after) > 0) : 0;
  const rest = from < 0 ? [] : sorted.slice(from);
  const out = rest.slice(0, limit);
  return { total: list.length, limit, rows: out.map(([, r]) => r), next: rest.length > limit ? encode(out[out.length - 1][0]) : null };
}

/** The headline numbers: what the Overview leads with, and nothing per product. */
function summary(r) {
  const t = r.totals || {};
  return {
    generatedAt: r.generatedAt, days: r.days, from: r.from, period: r.period, currency: 'INR',
    money: { sold: t.sold, lost: t.lost, lostEstimate: t.lostEstimate ?? 0, lostNotRestocked: t.lostNotRestocked ?? 0, lostAll: t.lostAll ?? t.lost, lostProfit: t.lostProfit, stillOutPerDay: t.stillOutPerDay, orderValueNow: t.orderValueNow, orderValueAll: t.orderValueAll, excessValue: t.excessValue },
    counts: { products: t.products, outNow: t.outNow, stillOut: t.stillOut, outNotSelling: t.outNotSelling, orderToday: t.orderToday, orderNow: t.orderNow, orderWeek: t.orderWeek, bestAtRisk: t.bestAtRisk, overstocked: t.overstocked, stockouts: t.stockouts },
    lostPct: t.lostPct, storeTrendPct: t.storeTrendPct, yesterday: r.yesterday || null,
  };
}

/**
 * The v1-only routes. report() = the same report /api/report answers (query values honoured). ctx: { store, freshness (object or function), source }.
 * Returns { code, body } or null (not one of these routes).
 */
function handle(req, url, report, ctx = {}) {
  if (!url.v1 || req.method !== 'GET') return null;
  const p = url.pathname;
  if (p === '/api/summary') {
    const r = report();
    const f = (typeof ctx.freshness === 'function' ? ctx.freshness() : ctx.freshness) || {};
    return { code: 200, body: { ok: true, store: ctx.store, ...summary(r), source: ctx.source, fresh: { lastPull: f.lastPull ?? null, ageMin: f.ageMin ?? null, stale: !!f.stale } } };
  }
  if (p === '/api/rows') {
    const view = url.searchParams.get('view') || '';
    if (!VIEWS.includes(view)) throw badRequest(`view must be one of ${VIEWS.join(', ')}`);
    const r = report();
    const pg = page(view, r[view] || [], url.searchParams.get('limit'), url.searchParams.get('cursor'));
    return { code: 200, body: { ok: true, store: ctx.store, view, generatedAt: r.generatedAt, days: r.days, ...pg } };
  }
  return null;
}

module.exports = { rewrite, handle, page, summary, VIEWS, LIMIT_DEFAULT, LIMIT_MAX };
