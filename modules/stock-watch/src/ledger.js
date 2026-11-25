'use strict';
/*
 * 2.0.0: what is locked (RULE.md "Lock"). Once a month is over it is saved here as it stood and never worked out again under
 * this rule; the best-seller list of a quarter is saved on its first report. Only ever added to.
 *   ledger.json { v, rule, lists: { 'YYYY-MM-DD': { from, to, rows: [[variantId, rank, ₹ sold]] } }, months: { 'YYYY-MM': { at, list, score, low, high, parts } }, old: { rule: {…} } }
 * A new rule number starts a new ledger; the old one is kept under `old`.
 */
const { sideFile } = require('./sidefile');
const FILE_NAME = 'ledger.json', file = sideFile(FILE_NAME);
/** The ledger of `rule`, or null when nothing is locked yet. Throws when the file can't be read: never report unlocked numbers as locked ones. */
function get(rule) { const d = file.read(); return d && d.rule === rule ? d : null; }
/** Add what a build locked. A month or list that is already there is never replaced. → what was added */
function add(rule, lock) {
  if (!lock) return null;
  const d = file.read() || {}, same = d.rule === rule, lists = same ? { ...d.lists } : {}, months = same ? { ...d.months } : {}, added = { lists: [], months: [] };
  for (const [k, x] of Object.entries(lock.lists || {})) if (!lists[k]) { lists[k] = x; added.lists.push(k); }
  for (const [k, x] of Object.entries(lock.months || {})) if (!months[k]) { months[k] = x; added.months.push(k); }
  if (!added.lists.length && !added.months.length) return null;
  file.write({ v: 1, rule, lists, months, old: same || !d.rule ? d.old || {} : { ...(d.old || {}), [d.rule]: { lists: d.lists, months: d.months } } });
  return added;
}
const clear = () => { try { file.write({}); } catch { /* nothing to clear */ } };
module.exports = { FILE_NAME, get, add, clear, all: () => file.read(), reset: () => file.reset() };
