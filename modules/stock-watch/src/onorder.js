'use strict';
/*
 * "Mark ordered": purchase orders already placed, one record per variant (LOGIC.md §6b).
 * Kept in its own file, DATA_DIR/onorder.json, so it never touches store.json; as safely as store.json (src/sidefile.js:
 * a bad file is quarantined, never overwritten or read as empty) and carried in every backup (critic r2 X1).
 *   { [variantId]: { qty, eta, at, by } }   qty = units ordered, eta = expected landing (ms), at = when marked (ms)
 * The engine works out what's still to come (stock increases after `at` count as received).
 */
const { sideFile } = require('./sidefile');
const TZ = require('./tz');

const DAY = 864e5;
const MAX_ITEMS = 500;
const box = sideFile('onorder.json');
const has = (o, k) => Object.hasOwn(o, k);   // product IDs are data: never Object.prototype keys

/** Every record. Throws when onorder.json is unreadable and there's no good .bak (never "starting empty"). */
const all = () => box.read();
const save = () => box.write();
/** The records marked by time t (a past report, e.g. the digest's "7 days before": L7, 1.3.0), as src/weekly.js does. */
const asOf = (t) => Object.fromEntries(Object.entries(all()).filter(([, v]) => v && +v.at <= t));

/** ETA from "YYYY-MM-DD" (end of that day, store time; zone = src/tz.js) or ms. Must be within −1 … +365 days of now. */
function parseEta(v, now, zone = TZ.DEFAULT_ZONE) {
  let t = NaN;
  if (typeof v === 'number') t = v;
  else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) { const w = Date.parse(v + 'T23:59:00Z'); t = Number.isFinite(w) ? TZ.fromLocal(w, zone) : NaN; }
  if (!Number.isFinite(t) || t < now - DAY || t > now + 365 * DAY) return null;
  return t;
}

/**
 * Validate and store a batch. items: [{ id, qty, eta }]; qty 0 (or clear: true) removes the record.
 * Returns { ok, saved, removed } or { ok: false, error }.
 */
function mark(items, { by = null, now = Date.now(), offMin = TZ.DEFAULT_ZONE } = {}) {   // offMin: the store's zone (name kept for callers)
  if (!Array.isArray(items) || !items.length) return { ok: false, error: 'Nothing to mark' };
  if (items.length > MAX_ITEMS) return { ok: false, error: `At most ${MAX_ITEMS} products at a time` };
  const d = all(), next = {};
  for (const it of items) {
    const id = ['string', 'number'].includes(typeof it?.id) ? String(it.id).trim().slice(0, 100) : '';
    if (!id || id === '__proto__') return { ok: false, error: 'Each item needs a product id' };
    if (it.clear === true || +it.qty === 0) { next[id] = null; continue; }
    const qty = Math.round(+it.qty);
    if (!Number.isFinite(qty) || qty < 1 || qty > 1e6) return { ok: false, error: 'Quantity must be a whole number from 1 to 1,000,000' };
    const eta = parseEta(it.eta, now, offMin);
    if (eta == null) return { ok: false, error: 'Expected date must be a date (YYYY-MM-DD) within the next year' };
    next[id] = { qty, eta, at: now, by: typeof by === 'string' && by.trim() ? by.trim().slice(0, 40) : null };
  }
  let saved = 0, removed = 0;
  for (const [id, rec] of Object.entries(next)) {
    if (rec) { d[id] = rec; saved++; } else if (has(d, id)) { delete d[id]; removed++; }
  }
  /* old records go: anything due more than 60 days ago */
  for (const [id, rec] of Object.entries(d)) if (rec.eta < now - 60 * DAY) delete d[id];
  save();
  return { ok: true, saved, removed };
}

function clear() { box.write({}); }

/** HTTP: GET /api/onorder, POST /api/onorder { items, by }. Returns { code, body } or null when the path isn't ours. */
async function handle(req, p, readBody, offMin) {
  if (p !== '/api/onorder') return null;
  if (req.method === 'GET') return { code: 200, body: { ok: true, onOrder: all() } };
  if (req.method !== 'POST') return { code: 405, body: { ok: false, error: 'Use GET or POST' } };
  let b;
  try { b = JSON.parse(await readBody(req, 256e3) || '{}'); } catch { return { code: 400, body: { ok: false, error: 'Body must be JSON' } }; }
  const r = mark(b && b.items, { by: b && b.by, offMin });
  return r.ok ? { code: 200, body: r } : { code: 400, body: r };
}

module.exports = { all, asOf, mark, clear, handle, parseEta, reset: box.reset, FILE_NAME: box.name };
