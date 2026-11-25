'use strict';
/*
 * 1.4.6: closed months. Once a month is over (GRACE full days after its last day, and the 12 months hold every day of it),
 * the ₹ missed per variant is saved as it stood, and every later brand report shows that, whatever is marked ordered,
 * restocked, drafted or repriced since. Sold and days out stay Shopify's (they don't move).
 *   closed.json { v, sets: { '<rules>|<pace months>': { 'YYYY-MM': { at, by: { variantId: [units, lost, apart, nr, est, countedUnits] } } } } }
 * RULES: bumped when the rules change on purpose: the months are then closed again under the new ones.
 */
const { sideFile } = require('./sidefile');
const agency = require('./agency');
const RULES = '1.4.7', GRACE = 3;
const file = sideFile('closed.json');
const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
const read = () => { try { return file.read(); } catch (e) { console.warn('closed.json:', e.message); return null; } };
const keyOf = (o) => `${RULES}|${o.paceMonths}`;
/** { 'YYYY-MM': { variantId: [...] } } for agency.build's opts.frozen, or null. */
function get(key) {
  const s = ((read() || {}).sets || {})[key];
  return s ? Object.fromEntries(Object.entries(s).map(([m, x]) => [m, x.by])) : null;
}
/** Save the months of build r that are over and not saved yet. Returns the month keys saved. */
function close(key, r, y, now = Date.now()) {
  if (!r || !r.ok || !r.details) return [];
  const d = read(); if (!d) return [];
  const have = ((d.sets || {})[key]) || {}, add = {};
  for (const m of r.months) {
    const last = new Date(Date.UTC(+m.key.slice(0, 4), +m.key.slice(5, 7), 0)).toISOString().slice(0, 10);
    if (have[m.key] || m.days !== +last.slice(8) || r.span.through < agency.keyPlus(last, GRACE)) continue;
    const by = {};
    for (const [id, v] of Object.entries(r.details)) { const x = v.perMonth[m.key]; if (x && !v.unsure) by[id] = [x.units, x.lost, x.apart, x.nr, x.est, x.cu].map(r2); }
    add[m.key] = { at: now, by };
  }
  if (!Object.keys(add).length) return [];
  try { file.write({ v: 1, sets: { [key]: { ...have, ...add }, ...Object.fromEntries(Object.entries(d.sets || {}).filter(([k]) => k !== key && k.startsWith(`${RULES}|`))) } }); }
  catch (e) { console.warn('closed.json not saved:', e.message); return []; }
  return Object.keys(add);
}
const clear = () => { try { file.write({}); } catch { /* nothing to clear */ } };
const all = () => file.read();
const reset = () => file.reset();
module.exports = { all, reset, RULES, GRACE, keyOf, get, close, clear, FILE_NAME: 'closed.json' };
