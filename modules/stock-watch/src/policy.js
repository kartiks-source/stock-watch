'use strict';
/*
 * 4.8.0 (LOGIC.md §35, part A): the daily history of Shopify's "Continue selling when out of stock" (inventoryPolicy) per variant.
 *   policy.json { v: 1, by: { variantId: [[day, 0 | 1], ...] } }   run-length: a new row only when the value changes
 * Written after each successful stock pull, from the variants that pull returned with a known policy. A flip is dated to the
 * store day of the refresh that saw it. A failed pull writes nothing; a variant missing from the pull, or returned without a
 * policy, keeps its history untouched. Past flips can't be recovered: before a variant's first row, its earliest value holds.
 * No extra Shopify calls: the stock pull already reads inventoryPolicy (src/shopify.js STOCK_Q).
 */
const FILE_NAME = 'policy.json';
let side = null;
const file = () => side || (side = require('./sidefile').sideFile(FILE_NAME));   // the pure parts (record, at, alwaysOf) never touch a file

/** Pure. by = the history, seen = { variantId: true | false } from one complete refresh, day = its store day.
 *  → { by: the new history (by itself when nothing changed), changed: [variantId] } */
function record(by, seen, day) {
  const next = { ...(by || {}) }, changed = [];
  for (const [id, v] of Object.entries(seen || {})) {
    if (typeof v !== 'boolean') continue;   // no policy in the answer: nothing is known, nothing is written
    const val = v ? 1 : 0, list = next[id];
    if (!list || !list.length) { next[id] = [[day, val]]; changed.push(id); continue; }
    const last = list[list.length - 1];
    if (last[1] === val) continue;
    const l = list.slice();
    if (last[0] === day) { l.pop(); if (!l.length || l[l.length - 1][1] !== val) l.push([day, val]); }   // flipped twice the same day: the day's last value
    else l.push([day, val]);
    next[id] = l; changed.push(id);
  }
  return { by: changed.length ? next : by || {}, changed };
}

/** The value on `day`: the latest row on or before it; before the first row, the earliest recorded value. null with no rows. */
function at(list, day) {
  if (!list || !list.length) return null;
  let v = list[0][1];
  for (const [d, x] of list) { if (d > day) break; v = x; }
  return !!v;
}

/** What the engine uses for one variant: a plain true / false when its history never changed (or there is none: `now`, the
 *  catalog's setting, as before 4.8.0), else a function day → true / false. */
function alwaysOf(by, id, now) {
  const list = by && Object.hasOwn(by, String(id)) ? by[String(id)] : null;
  if (!list || !list.length) return !!now;
  if (list.every((x) => x[1] === list[0][1])) return !!list[0][1];
  return (day) => at(list, day);
}

/** After a successful stock pull: add the flips it saw. → the variant IDs that changed. */
function save(seen, day) {
  const d = file().read() || {}, r = record(d.by || {}, seen, day);
  if (r.changed.length) file().write({ v: 1, by: r.by });
  return r.changed;
}
/** The history by variant ({} when none). all() = the whole file (backups, src/backup.js). */
const history = () => { const d = file().read() || {}; return d.by || {}; };
const all = () => file().read();
const clear = () => { try { file().write({}); } catch { /* nothing to clear */ } };

module.exports = { FILE_NAME, record, at, alwaysOf, save, history, all, clear, reset: () => file().reset(), file: () => file().file() };
