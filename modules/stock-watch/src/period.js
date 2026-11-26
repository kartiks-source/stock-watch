'use strict';
/*
 * Periods (SW-027): "This month" in the period picker, and the Yesterday strip on the Overview.
 * Pure functions, no I/O. Rules: LOGIC.md §5a.
 */
const { report, dayKey } = require('./engine');
const TZ = require('./tz');

/** Start of the store's calendar month that `now` falls in, as a UTC timestamp. zone = the store's time zone
 *  (src/tz.js: IANA name, or minutes east of UTC; India = 330). */
function monthStart(now, zone) { return TZ.monthStart(now, zone); }
/** Start of the store's calendar day that `t` falls in, as a UTC timestamp. */
function dayStart(t, zone) { return TZ.dayStart(t, zone); }

/**
 * What the `days` query value asks for (1.1.5, LOGIC.md §5a): N store-calendar days, today included, from 00:00 store
 * time N − 1 days ago until now (7, 14, 30, 60; 30 when missing; 1–90), so every number can be checked in Shopify with
 * the same dates. "month" = from the 1st of this month (store time) until now. Returns engine options.
 */
function range(daysParam, now, zone) {
  if (String(daysParam) === 'month') return { period: 'month', from: monthStart(now, zone) };
  const c = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(String(daysParam || ''));   // 4.1.0: Custom, "2026-10-01..2026-10-31", store days, both ends included
  if (c) {
    const today = dayKey(now, zone), at = (k) => TZ.dayStart(Date.parse(`${k}T12:00:00Z`), zone);
    let [a, b] = c[1] <= c[2] ? [c[1], c[2]] : [c[2], c[1]]; if (b > today) b = today; if (a > b) a = b;
    const end = Math.min(now, at(b) + 864e5); let from = at(a); if (end - from > 90 * 864e5) { from = at(b) - 89 * 864e5; a = dayKey(from, zone); }
    return { period: 'custom', from, now: end, days: Math.max(1, Math.round((at(b) + 864e5 - from) / 864e5)), fromKey: a, to: b };
  }
  const days = Math.max(1, Math.min(90, Math.round(Number(daysParam)) || 30));
  return { period: 'days', days, from: TZ.daysStart(now, days, zone) };
}

/** Rows as they stood at time t (for "the 7 days before" comparisons): nothing recorded after t. */
function asOf(stock, orders, t) {
  return { stock: stock.filter((r) => r.t <= t), orders: orders.filter((o) => o.t <= t) };
}

/**
 * The catalog as it stood at a past time t, for "the 7 days before" (CEO digest, LOGIC.md §17): only the inactive
 * flags of variants that were already inactive by then (archived, draft, untracked, deleted), never today's stock
 * or price. Without them a variant archived while out of stock never ends its stock-out (Shopify sends no more rows
 * for it), so the past report would count lost sales the page never showed.
 */
function catalogAsOf(catalog, t) {
  const out = {};
  for (const [id, c] of Object.entries(catalog || {})) {
    if (!c) continue;
    const e = {}, spells = [];
    /* past spells (inactive, then active again): ended by t → kept as spells; still running at t → inactive then */
    for (const s of Array.isArray(c.spells) ? c.spells : []) {
      if (!(+s.from <= t)) continue;
      if (+s.to <= t) spells.push({ from: +s.from, to: +s.to });
      else Object.assign(e, { active: false, status: s.status || 'INACTIVE', inactiveSince: +s.from });
    }
    if (c.active === false && Number.isFinite(+c.inactiveSince) && +c.inactiveSince <= t) Object.assign(e, { active: false, status: c.status, inactiveSince: +c.inactiveSince });
    if (spells.length) e.spells = spells;
    if (Object.keys(e).length) out[id] = e;
  }
  return out;
}

/**
 * Yesterday, from a report that covers it: ₹ sold and lost on yesterday's local calendar day (the same
 * numbers as that day's bar on the Overview chart), how many products ran out (a stock-out started) and
 * how many came back (a stock-out ended). A product counts once even if it ran out twice.
 * Returns null when the report doesn't reach back to the start of yesterday.
 */
function yesterday(r, zone) {
  const now = r.generatedAt;
  const end = dayStart(now, zone), start = dayStart(end - 1, zone);   // yesterday may be 23 or 25 hours long (SW-049)
  if (r.from > start) return null;
  const key = dayKey(start, zone);
  const d = r.daily.find((x) => x.day === key) || { sold: 0, lost: 0 };
  const ranOut = new Set(), back = new Set();
  for (const s of r.stockouts) {
    if (s.start >= start && s.start < end) ranOut.add(s.id);
    if (!s.open && s.end >= start && s.end < end) back.add(s.id);
  }
  return { day: key, sold: d.sold, lost: d.lost, ranOut: ranOut.size, back: back.size };
}

/** Yesterday for any report: uses it when it covers yesterday, else works out a 2-day report.
 *  The page's own period (from / days) is dropped from `extra`: `from` would override days: 2 (engine) and
 *  bring back the same window that didn't reach yesterday (This month on the 1st). */
function yesterdayFor(stock, orders, settings, r, extra = {}) {
  const off = TZ.zoneOf(r.settings);
  const { from, days, period, ...rest } = extra;
  return yesterday(r, off) || yesterday(report(stock, orders, settings, { ...rest, now: r.generatedAt, days: 2 }), off);
}

module.exports = { monthStart, dayStart, range, asOf, catalogAsOf, yesterday, yesterdayFor };
