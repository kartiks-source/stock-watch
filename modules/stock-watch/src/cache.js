'use strict';
/*
 * 1.4.3: per-store answers kept in memory, so opening a product doesn't work out the whole store again.
 *   bump(dir)   the store's data changed: store.json saved (a pull, an import, settings), a side file written (Mark ordered,
 *               decisions, suppliers, targets, lists, snapshots, the 12 months). Every cached answer of that store is stale.
 *   rev(dir)    the store's data version (sent to the page, which keys its own small cache on it)
 *   memo(name, key, ttlMs, fn)  the answer for (store, name, key) while the version is the same and it is younger than ttlMs;
 *               else fn() is run and kept. key = what else the answer depends on (period, trial settings…).
 * One copy of the app per data folder (SW-055), so memory is the right place; nothing here is written to disk.
 */
const scope = require('./scope');

const revs = new Map();   // store folder → version
const memos = new Map();  // store folder → Map(name → { key, rev, at, val })
const MAX_PER_STORE = 40;

const dirOf = () => { try { return scope.dir(); } catch { return '-'; } };
function bump(dir = dirOf()) { revs.set(dir, (revs.get(dir) || 0) + 1); const m = memos.get(dir); if (m) m.clear(); }
const rev = (dir = dirOf()) => revs.get(dir) || 0;
function memo(name, key, ttlMs, fn, dir = dirOf()) {
  let m = memos.get(dir); if (!m) { m = new Map(); memos.set(dir, m); }
  const id = `${name}|${key}`, hit = m.get(id), r = rev(dir), now = Date.now();
  if (hit && hit.rev === r && now - hit.at < ttlMs) return hit.val;
  const val = fn();
  if (m.size >= MAX_PER_STORE) m.delete(m.keys().next().value);   // oldest first
  m.set(id, { rev: r, at: now, val });
  return val;
}
const clearAll = () => { memos.clear(); };

module.exports = { bump, rev, memo, clearAll };
