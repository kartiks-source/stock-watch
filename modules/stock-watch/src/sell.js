'use strict';
/*
 * 1.4.0 (LOGIC.md §23): "sell what's in stock". Pure, on the report's product rows (variants, with image and links) and the
 * brand report's products (12-month pace, best sellers).
 *
 *   bestNow(brand, rows, month)   each best seller now: in stock or out (since when), days out and money missed this month,
 *                                 the restock state (status, order quantity, marked order)
 *   ads(brand, rows, S)           push = in stock, selling, enough stock for the ads to run: cover ≥ max(21 days, lead time +
 *                                 buffer), ranked by ₹ a day it can sell (pace this month × price); pause = can't be bought now or
 *                                 runs out before a refill can land (§15c), best sellers first, then ₹ a day
 * Pace = the brand report's pace for the variant (6 months of in-stock days, this month's season) when held, else the
 * report's 28-day in-stock rate.
 */
const COVER_MIN = 21;   // days of stock an ad push needs at least (3 weeks)

const byId = (rows) => new Map((rows || []).map((r) => [String(r.id), r]));
/** variantId → { pace a day, best, product } from the brand report. */
function paceMap(brand) {
  const m = new Map();
  for (const p of (brand && brand.products) || []) for (const [id, v] of Object.entries(p.variantPace || {})) m.set(String(id), { pace: v, best: !!p.best, product: p });
  return m;
}
const live = (r) => r && r.status !== 'Inactive' && r.stock != null;

function bestNow(brand, rows, month) {
  const rs = byId(rows), out = [];
  for (const p of (brand && brand.products) || []) {
    if (!p.best) continue;
    const vs = (p.ids || [p.variantId]).map((id) => rs.get(String(id))).filter(live);
    if (!vs.length) continue;
    const selling = vs.filter((r) => (p.variantPace?.[r.id] || r.perDay || 0) > 0);
    const outRows = (selling.length ? selling : vs).filter((r) => r.stock <= 0);
    const main = outRows[0] || rs.get(String(p.variantId)) || vs[0];
    const m = (p.months || {})[month] || null;
    out.push({
      ...p, months: undefined, season: undefined, variantPace: undefined, ids: undefined,
      id: main.id, image: p.image || main.image, adminUrl: p.adminUrl || main.adminUrl, webUrl: p.webUrl !== undefined ? p.webUrl : main.webUrl,
      out: outRows.length > 0, outVariants: outRows.length, variantsLive: vs.length, outSince: outRows.length ? (main.outSince || null) : null,
      outFromDay: outRows.length ? (p.outFrom || {})[String(main.id)] || null : null,   // 12 months: the day this stock-out began (store day), else null
      stock: vs.reduce((s, r) => s + Math.max(0, r.stock), 0), status: main.status, orderQty: main.orderQty || 0, orderValue: main.orderValue || 0, onOrder: main.onOrder || null,
      daysLeft: main.daysLeft ?? null, why: main.why || '', daysOutMonth: m ? m.daysOut : 0, lostMonth: m ? (m.counted != null ? m.counted : m.lost) : 0, apartMonth: m ? (m.lost - (m.counted != null ? m.counted : m.lost)) || 0 : 0, rangeMonth: m ? m.range : '',
    });
  }
  return out.sort((a, b) => (b.out - a.out) || (b.lostMonth - a.lostMonth) || (b.sold - a.sold));
}

function ads(brand, rows, S = {}) {
  const pm = paceMap(brand);
  const need = Math.max(COVER_MIN, (+S.leadDays || 0) + (+S.safetyDays || 0));
  const push = [], pause = [], keep = [];
  for (const r of rows || []) {
    if (!live(r)) continue;
    const b = pm.get(String(r.id)), pace = b && b.pace > 0 ? b.pace : +r.perDay || 0;   // the 12-month pace; the 28-day rate when it has none
    const price = +r.price || (b ? b.product.price : 0) || 0;
    const outFromDay = b && r.stock <= 0 ? (b.product.outFrom || {})[String(r.id)] || null : null;
    const row = { outFromDay, id: r.id, name: r.name, sku: r.sku, image: r.image, adminUrl: r.adminUrl, webUrl: r.webUrl, stock: r.stock, pace: Math.round(pace * 100) / 100, price: Math.round(price), perDayValue: Math.round(pace * price), best: !!(b && b.best), status: r.status, why: r.why || '', backIn: r.backIn || null, outSince: r.outSince || null, daysLeft: r.daysLeft ?? null, ...(r.life ? { life: r.life } : {}) };
    if (r.mkt === 'pause' && pace > 0) { pause.push(row); continue; }
    if (r.allocation && r.stock > 0) { if (pace > 0) keep.push({ ...row, allocation: true }); continue; }   // 1.4.6: topped up from the warehouse: keep the ads on, check the warehouse
    if (r.stock > 0 && pace > 0) {
      const cover = r.stock / pace, needR = Math.max(COVER_MIN, (+(r.leadDays ?? S.leadDays) || 0) + (+S.safetyDays || 0));   // the supplier's lead time when set (§6c)
      if (cover >= needR) push.push({ ...row, coverDays: Math.round(cover), coverWeeks: Math.round(cover / 7) });
    }
  }
  push.sort((a, b) => b.perDayValue - a.perDayValue);
  pause.sort((a, b) => (b.best - a.best) || ((a.stock <= 0 ? 0 : 1) - (b.stock <= 0 ? 0 : 1)) || b.perDayValue - a.perDayValue);
  keep.sort((a, b) => b.perDayValue - a.perDayValue);
  return { push, pause, keep, coverDays: need };
}

module.exports = { bestNow, ads, paceMap, COVER_MIN };
