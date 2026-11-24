'use strict';
/*
 * Morning digest text (SW-028). Pure: report in, a few plain-language lines out. One digest per role
 * (docs/RACI.md "Pushed to them"); the same lines the role's home screen leads with. Rules: LOGIC.md §17.
 * Sending (webhook, schedule, log) is src/digest-service.js.
 */
const R = require('../public/roles');
const H = require('./helpers');   // the page's own rules (LOGIC.md §15), so the digest and the page agree
const TZ = require('./tz');        // the store's time zone (SW-049)

const MAX_LINES = 6;          // title included; the link goes on its own line after these
const TODAY = ['Out now', 'Critical', 'Order now'];

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
/** Same short ₹ format as the page: ₹45,200 · ₹2.46 L · ₹1.22 Cr. */
function money(x) {
  const v = Math.round(+x || 0), a = Math.abs(v);
  if (a >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  return `₹${inr.format(v)}`;
}
const n1 = (x) => (Math.round(x * 10) / 10).toLocaleString('en-IN');
const cut = (s, n = 44) => (s.length > n ? s.slice(0, n - 1).replace(/[\s·,-]+$/, '') + '…' : s);
const plural = (n, one, many = one + 's') => `${inr.format(n)} ${n === 1 ? one : many}`;
const names = (list, n = 3) => list.slice(0, n).map((p) => cut(p.name, 30)).join(', ');
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateLabel = (t, zone) => { const d = TZ.local(t, zone); return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };

/** ₹ of sales a day the products that are out of stock right now are missing: in-stock rate × price paid.
 *  Same sum as the Stock-outs headline (helpers.enrich → totals.stillOutPerDay, LOGIC.md §15a). */
function stillOutPerDay(r) {
  if (r.totals && r.totals.stillOutPerDay != null) return r.totals.stillOutPerDay;
  return r.products.filter((p) => p.stock != null && p.stock <= 0 && p.status !== 'Inactive').reduce((s, p) => s + Math.round((+p.perDay || 0) * (+p.price || 0)), 0);
}
/** Don't promote: the Products → Pause promotion list, same rule and order (helpers.mktList / mktSort, LOGIC.md §15c). */
function pauseList(r) {
  return H.mktSort(r.products.filter((p) => H.mktList(p, r.settings) === 'pause'), 'pause');
}
/** Push: overstocked products, most cash stuck first. */
const pushList = (r) => r.products.filter((p) => p.overstock && p.excessValue > 0).sort((a, b) => b.excessValue - a.excessValue);
const orderToday = (r) => r.reorder.filter((p) => TODAY.includes(p.status));

/* ---------- the lines each role gets ---------- */
const L = {
  order(r) {
    const t = r.totals;
    return t.orderToday ? `Order today: ${money(t.orderValueNow)}${t.hasCost ? '' : ' at selling price'} across ${plural(t.orderToday, 'product')}${t.bestAtRisk ? ` (${inr.format(t.bestAtRisk)} of them best sellers)` : ''}.` : 'Nothing needs ordering today.';
  },
  stillOut(r) {
    const n = r.totals.stillOut;
    return n ? `Still out of stock: ${plural(n, 'product')}, costing about ${money(stillOutPerDay(r))} a day in sales.` : 'Nothing is out of stock right now.';
  },
  yesterday(y) {
    if (!y) return null;
    return `Yesterday: ${money(y.sold)} sold · ${y.lost ? `${money(y.lost)} lost to stock-outs` : 'nothing lost'} · ${y.ranOut} ran out · ${y.back} back in stock.`;
  },
  overstock(r) {
    const t = r.totals;
    return t.excessValue ? `${t.hasCost ? 'Cash stuck in overstock' : 'Overstock at selling price'}: ${money(t.excessValue)} in ${plural(t.overstocked, 'product')}.` : 'No overstock.';   // SIMP-1: no unit costs → not "cash"
  },
  lostPeriod(r, prev) {
    const t = r.totals;
    let s = `Sales lost to stock-outs, last ${r.days} days: ${money(t.lost)} (${n1(t.lostPct)}% of demand)`;
    /* LOGIC.md §4c: estimates from few sales and 30+ d not restocked are apart from the headline, named when there are any */
    const apart = [t.lostEstimate > 0 ? `+${money(t.lostEstimate)} estimate` : '', t.lostNotRestocked > 0 ? `+${money(t.lostNotRestocked)} not restocked` : ''].filter(Boolean);
    if (prev) {
      const p = prev.totals.lost;
      s += t.lost > p ? `, up from ${money(p)} the ${r.days} days before` : t.lost < p ? `, down from ${money(p)} the ${r.days} days before` : `, same as the ${r.days} days before`;
    }
    return s + (apart.length ? ` (${apart.join(', ')})` : '') + '.';
  },
  topOrders(r, n, fmt) { return orderToday(r).slice(0, n).map(fmt); },
};
const left = (p) => (p.stock <= 0 ? 'out of stock' : `${n1(p.daysLeft)} days left`);

const BUILD = {
  ceo: (r, ctx) => [
    L.lostPeriod(ctx.week || r, ctx.prev),
    (ctx.week || r).totals.hasCost && (ctx.week || r).totals.lostProfit != null ? `Profit lost with it: ${money((ctx.week || r).totals.lostProfit)}.` : null,
    L.overstock(r),
    `Best sellers at risk: ${inr.format(r.totals.bestAtRisk)} of ${inr.format(r.totals.bestsellers)}.`,
  ],
  founder: (r, ctx) => [L.order(r), L.stillOut(r), L.yesterday(ctx.yesterday), L.overstock(r)],
  ops: (r, ctx) => [
    r.totals.orderToday ? `Order today: ${plural(r.totals.orderToday, 'line')}, ${money(r.totals.orderValueNow)} at cost.` : 'Nothing needs ordering today.',
    ...L.topOrders(r, 3, (p, i) => `${i + 1}. ${cut(p.name)}: order ${inr.format(p.orderQty)} pcs (${left(p)}).`),
    ctx.yesterday ? `Yesterday: ${ctx.yesterday.ranOut} ran out, ${ctx.yesterday.back} back in stock.` : null,
  ],
  buyer: (r) => [
    r.totals.orderToday ? `Order today: ${plural(r.totals.orderToday, 'line')}, ${money(r.totals.orderValueNow)} at cost.` : 'Nothing needs ordering today.',
    ...orderToday(r).slice().sort((a, b) => b.orderValue - a.orderValue).slice(0, 3).map((p) => `${cut(p.name)}: ${inr.format(p.orderQty)} pcs · ${money(p.orderValue)}.`),
  ],
  marketing: (r) => {
    const pause = pauseList(r), push = pushList(r);
    return [
      pause.length ? `Pause promotion on ${plural(pause.length, 'product')} (out of stock or running out before a reorder lands).` : 'Nothing to pause: every selling product is in stock.',
      pause.length ? `Top: ${names(pause)}.` : null,
      push.length ? `Push these: ${money(push.reduce((s, p) => s + p.excessValue, 0))} stuck in overstock across ${plural(push.length, 'product')}.` : 'No overstock to push.',
      push.length ? `Top: ${names(push)}.` : null,
    ];
  },
  finance: (r, ctx) => {
    const t = r.totals, week = Math.max(0, t.orderValueAll - t.orderValueNow);
    return [
      `Cash to order today: ${money(t.orderValueNow)} for ${plural(t.orderToday, 'product')}${week ? `; ${money(week)} more due this week` : ''}.`,
      L.overstock(r),
      L.lostPeriod(ctx.week || r, null),
    ];
  },
  /* warehouse receives: what is due to land (Reorder → Ordered, LOGIC.md §6b / §16), late first; never "order today" */
  warehouse: (r) => {
    const s = H.onOrderSummary(r.products, r.generatedAt), off = TZ.zoneOf(r.settings);
    if (!s.lines) return ['Nothing on order.'];
    return [
      `On order: ${plural(s.lines, 'line')}, ${inr.format(s.pcs)} pcs to come · ${inr.format(s.week)} due this week${s.late ? ` · ${inr.format(s.late)} late` : ''}.`,
      ...H.onOrderRows(r.products).slice(0, 3).map((p) => `${cut(p.name)}: ${inr.format(p.onOrder.remaining)} pcs · ${p.onOrder.late ? `late, was due ${dateLabel(p.onOrder.eta, off)}` : `lands ${dateLabel(p.onOrder.eta, off)}`}.`),
    ];
  },
};

/**
 * build({ report, yesterday, week, prev, role, storeName, storeId, base, now })
 *   report    engine.report() for the default 30 days (order today, overstock, best sellers: same as the page)
 *   yesterday src/period.js yesterday() (optional)
 *   week      a 7-day report: weekly roles' "sales lost, last 7 days" (optional; else `report`)
 *   prev      that 7-day report as it stood 7 days earlier (CEO "up/down from"; optional)
 *   role      a key of public/roles.js, or '' for everyone
 *   base      the app's address for the deep link (optional)
 *   storeId   the store the link opens (multi-store, ADR-0015; optional)
 *   review    this week vs last week, one line (SW-043, src/weekly.js digestLine; optional): Founder / Everyone only
 * → { role, roleName, title, lines, link, text }   lines include the title; at most MAX_LINES
 */
function build({ report: r, yesterday = null, week = null, prev = null, role = '', storeName = '', storeId = '', base = '', now, review = null } = {}) {
  const key = R.valid(role) ? role : '';
  const roleName = key ? R.ROLES[key].name : 'Everyone';
  const at = now || r.generatedAt;
  const title = `Stock-out Watch · ${storeName || 'your store'} · ${dateLabel(at, TZ.zoneOf(r.settings))}${key ? ` · ${roleName}` : ''}`;
  const body = (BUILD[key] || BUILD.founder)(r, { yesterday, week, prev }).filter(Boolean);
  if (review && (key === '' || key === 'founder')) body.push(review);   // SW-043: the CEO's lines already compare weeks
  const lines = [title, ...body].slice(0, MAX_LINES);
  const qs = [storeId ? `store=${encodeURIComponent(storeId)}` : '', key ? `role=${key}` : ''].filter(Boolean).join('&');
  const link = base ? `${base.replace(/\/+$/, '')}/${qs ? `?${qs}` : ''}#${key ? R.ROLES[key].home : 'overview'}` : '';
  return { role: key, roleName, title, lines, link, text: lines.join('\n') + (link ? `\nOpen: ${link}` : '') };
}

module.exports = { build, stillOutPerDay, pauseList, pushList, money, MAX_LINES };
