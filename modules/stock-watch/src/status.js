'use strict';
/*
 * 1.4.7 (LOGIC §27): when each product was active, draft or archived.
 *   read daily: Shopify's product events (status_changed, created). Shopify keeps about 90 days of them; what we read is kept
 *   in status.json, so the record grows from the first read on. No names: only product, time, from, to.
 *   publishedAt: Shopify sets it again when a draft is made active, so an ACTIVE product has been on the website without a
 *   break since its publishedAt (checked on Sammsara: 6 of 6 draft → active events carry the same day).
 *   status.json { v, at, horizon: 'first event ms', log: { productId: [[ms, from, to]] } }
 */
const { sideFile } = require('./sidefile');
const VERSION = 1, QL_VERSION = '2025-10', PAGE = 40, DAY = 864e5, FILE_NAME = 'status.json';
const file = sideFile(FILE_NAME);
const Q = `query ProductEvents($after: String) { products(first: ${PAGE}, after: $after) { pageInfo { hasNextPage endCursor } nodes { id events(first: 50, reverse: true) { nodes { createdAt action message } } } } }`;
const WORDS = ['ACTIVE', 'DRAFT', 'ARCHIVED', 'UNLISTED'];
const load = () => { try { const d = file.read(); return d && d.v === VERSION ? d : null; } catch (e) { console.warn('status.json:', e.message); return null; } };

/** One event → [ms, from, to] for a status change, else null. */
function parse(e) {
  const t = Date.parse(e && e.createdAt); if (!Number.isFinite(t) || e.action !== 'status_changed') return null;
  const m = /status from (\w+) to (\w+)/i.exec(String(e.message || '')); if (!m) return null;
  const a = m[1].toUpperCase(), b = m[2].toUpperCase();
  return WORDS.includes(a) && WORDS.includes(b) && a !== b ? [t, a, b] : null;
}
const due = (now = Date.now()) => { const d = load(); return !d || now - (+d.at || 0) > 20 * 36e5; };
/** Read every product's events once a day. Never throws; a failed read keeps what is held. */
async function run({ q, now = Date.now() } = {}) {
  const shopify = require('./shopify'), ask = q || ((doc, v) => shopify.gql(doc, v, { version: QL_VERSION }));
  const prev = load() || { v: VERSION, horizon: null, log: {} }, log = { ...prev.log };
  let first = Infinity, after = null, pages = 0;
  try {
    do {
      const p = (await ask(Q, { after })).products;
      for (const n of p.nodes) {
        const id = String(n.id).replace(/^gid:\/\/shopify\/Product\//, '');
        for (const e of n.events.nodes) { const t = Date.parse(e.createdAt); if (t < first) first = t; }
        const add = n.events.nodes.map(parse).filter(Boolean);
        if (add.length) { const m = new Map([...(log[id] || []), ...add].map((x) => [`${x[0]}${x[2]}`, x])); log[id] = [...m.values()].sort((a, b) => a[0] - b[0]).slice(-100); }
      }
      after = p.pageInfo.hasNextPage ? p.pageInfo.endCursor : null;
    } while (after && ++pages < 200);
    file.write({ v: VERSION, at: now, horizon: prev.horizon || (Number.isFinite(first) ? first : now), log });
    return { ok: true, products: Object.keys(log).length };
  } catch (e) { console.warn('status: product events not read:', e.message); return { ok: false, note: e.message }; }
}

/**
 * The periods of one product, oldest first: [{ status, from, to, sure }] (ms; from / to null = open). status 'UNKNOWN' =
 * Shopify doesn't say. c = its catalog entry (status, createdAt, publishedAt, inactiveSince, spells). Pure.
 */
function periods(c, log = [], horizon = null) {
  if (!c) return [];
  const now = c.status === 'UNTRACKED' ? 'ACTIVE' : c.status || (c.active === false ? 'DRAFT' : 'ACTIVE');
  let L = log.filter((x) => x && Number.isFinite(x[0])).slice().sort((a, b) => a[0] - b[0]);
  /* changes we saw ourselves between pulls and Shopify's events don't hold (within 2 days = the same one) */
  const seen = (t, to) => L.some((x) => x[2] === to && Math.abs(x[0] - t) < 2 * DAY);
  for (const s of Array.isArray(c.spells) ? c.spells : []) {
    const st = WORDS.includes(s.status) ? s.status : 'DRAFT';
    if (!seen(+s.from, st)) L.push([+s.from, 'ACTIVE', st]);
    if (!seen(+s.to, 'ACTIVE')) L.push([+s.to, st, 'ACTIVE']);
  }
  L.sort((a, b) => a[0] - b[0]);
  const made = +c.createdAt || null, pub = +c.publishedAt || null, out = [];
  const push = (status, from, to, sure = true) => { if (from != null && to != null && to <= from) return; const z = out[out.length - 1]; if (z && z.status === status) z.to = to; else out.push({ status, from, to, sure }); };
  const last = L[L.length - 1];
  if (last && last[2] !== now) L = [...L, [Math.max(last[0] + 1, +c.inactiveSince || last[0] + 1), last[2], now]];
  if (!L.length) {
    if (now === 'ACTIVE') { if (pub && (!made || pub - made > 2 * DAY)) push('UNKNOWN', made, pub, false); push('ACTIVE', pub || made, null); }
    else { const h = horizon && (!made || horizon > made) ? horizon : made; if (made && h > made) push('UNKNOWN', made, h, false); push(now, h, null); }   // not active the whole time Shopify remembers
    return out;
  }
  const t0 = L[0][0], from = L[0][1], h = horizon && horizon < t0 ? Math.max(horizon, made || 0) : made && made < t0 ? made : t0;
  if (made && made < h) push('UNKNOWN', made, h, false);
  push(from, h, t0);
  for (let i = 0; i < L.length; i++) push(L[i][2], L[i][0], L[i + 1] ? L[i + 1][0] : null);
  return out;
}
/** Days it was not active with a known start inside the record: [[from, to]] (ms), for src/agency.js lifeOf. */
const offSpells = (ps) => ps.filter((p, i) => i > 0 && ps[i - 1].status === 'ACTIVE' && p.status !== 'ACTIVE' && p.status !== 'UNKNOWN' && p.to != null).map((p) => [p.from, p.to]);
/** status for a catalog entry. */
function of(c) { const d = load(); return periods(c, (d && d.log[String(c && c.productId)]) || [], d && d.horizon); }
/** row.life = { s: 'ACTIVE', since, n: changes known } on product rows (id or variantId → catalog). */
function annotate(rows, catalog) {
  const d = load();
  for (const r of rows || []) {
    const c = (catalog || {})[String(r.id ?? '')] || (catalog || {})[String(r.variantId ?? '')]; if (!c || !c.productId) continue;
    const ps = periods(c, (d && d.log[String(c.productId)]) || [], d && d.horizon), z = ps[ps.length - 1];
    if (z) r.life = { s: z.status, since: z.from, n: ps.length - 1, ...(c.oversell ? { unlimited: true } : {}) };
  }
  return rows;
}
const clear = () => { try { file.write({}); } catch { /* nothing to clear */ } };
module.exports = { VERSION, Q, FILE_NAME, parse, due, run, periods, offSpells, of, annotate, load, clear, all: () => file.read(), reset: () => file.reset() };
