'use strict';
/*
 * Group by (SW-022): roll the Products rows (one per variant, from engine.report) up by parent
 * product, category, collection or tag. Pure functions, no I/O. Rules: LOGIC.md §9a.
 *
 *   catalog = { variants:    { [variantId]: { productId, product, type, tags: [] } },
 *               collections: { [collectionId]: { title, productIds: [] } } }        (src/catalog.js)
 *
 * Keys are IDs, never titles: Shopify product and collection IDs. Category (productType) and tag have
 * no ID in Shopify, so the value itself is the key (tags case-folded: Shopify treats "Gold" and
 * "gold" as one tag). A variant the catalog doesn't know yet keys on its own variant ID.
 *
 * Parent product and category: each variant is in exactly one group, so the groups add up to the
 * report totals. Collection and tag: a product can be in several, so there is no grand total, only
 * the distinct store total (each variant once).
 */

const { trendCall, storeTrend } = require('./engine');

const LENSES = ['product', 'type', 'collection', 'tag'];
const OVERLAP = new Set(['collection', 'tag']);
const TODAY = ['Out now', 'Critical', 'Order now'];   // "Need order" = the app's one "Order today" count
const CATCH_ALL = 0.8;                                 // a collection holding ≥ 80% of products says nothing
const TREND_MIN_UNITS = 6;                             // same floor as a product's trend (engine.js)

/** The catalog entry for one variant: own keys only, so an ID like "constructor" never reads Object.prototype. */
const variantOf = (catalog, id) => (catalog.variants && Object.hasOwn(catalog.variants, String(id)) ? catalog.variants[String(id)] : undefined);
const round = (x, d = 0) => { const p = 10 ** d; return Math.round(x * p) / p; };

/** Collections that hold at least 80% of the products in the report (e.g. "All products"). */
function catchAll(rows, catalog) {
  const pids = new Set(rows.map((r) => variantOf(catalog, r.id)?.productId).filter(Boolean));
  if (!pids.size) return [];
  return Object.entries(catalog.collections || {}).map(([key, c]) => {
    const share = (c.productIds || []).filter((p) => pids.has(String(p))).length / pids.size;
    return { key, label: c.title, share: round(share * 100, 1) };
  }).filter((c) => c.share >= CATCH_ALL * 100);
}

/** The groups one variant row belongs to under a lens: [{ key, label }]. */
function keysFor(row, catalog, lens, index) {
  const c = variantOf(catalog, row.id);
  if (lens === 'product') {
    return c?.productId ? [{ key: String(c.productId), label: c.product || row.name }] : [{ key: `variant:${row.id}`, label: row.name }];
  }
  if (lens === 'type') {
    const t = String(c?.type || row.type || '').trim();
    return [{ key: t, label: t || 'No category' }];
  }
  if (lens === 'tag') {
    const seen = new Map();
    for (const t of c?.tags || []) { const v = String(t).trim(); if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v); }
    return seen.size ? [...seen].map(([key, label]) => ({ key, label })) : [{ key: '', label: 'No tag' }];
  }
  const ids = (c?.productId && index.byProduct.get(String(c.productId))) || [];
  return ids.length ? ids.map((key) => ({ key, label: catalog.collections[key].title }))
    : [{ key: '', label: index.hidden.size ? 'Not in any other collection' : 'Not in a collection' }];
}

const blank = (key, label) => ({ key, label, n: 0, needOrder: 0, sold: 0, lost: 0, lostProfit: null, orderValue: 0, excessValue: 0, ids: [], _tr: { rec: 0, bef: 0, units: 0 },
  _wk: Array.from({ length: 8 }, () => ({ units: 0, outDays: 0, outProducts: 0, products: 0 })) });

/** Add one variant row to a group's sums. */
function add(g, r) {
  g.ids.push(r.id); g.n++;
  g.sold += r.sold || 0; g.lost += r.lostCounted ?? r.lost ?? 0;   // §4c: the headline's ₹ lost (estimates and 30+ d not restocked apart)
  if (r.lostProfit != null) g.lostProfit = (g.lostProfit || 0) + r.lostProfit;
  if (TODAY.includes(r.status)) { g.needOrder++; g.orderValue += r.orderValue || 0; }
  if (r.overstock) g.excessValue += r.excessValue || 0;
  /* spark (SW-021): the variants' weekly units added up, the same 8 blocks as a product's; a week no variant has
     data for stays "no data" (null) */
  if (Array.isArray(r.weeks) && r.weeks.length === 8) {
    r.weeks.forEach((x, i) => {
      if (!x || x.units == null) return;
      const k = g._wk[i]; k.products++; k.units += x.units; k.outDays += x.outDays || 0; if (x.outDays > 0) k.outProducts++;
    });
  }
  /* trend: add up the variants' sales per in-stock day, last 14 days vs the 14 before (the same
     halves as each product's trend), from the weekly blocks; a variant without both halves is left out */
  const w = r.weeks;
  if (Array.isArray(w) && w.length === 8 && w.slice(4).every((x) => x && x.units != null)) {
    const inBef = 14 - w[4].outDays - w[5].outDays, inRec = 14 - w[6].outDays - w[7].outDays;
    if (inBef >= 3 && inRec >= 3) {
      g._tr.bef += (w[4].units + w[5].units) / inBef; g._tr.rec += (w[6].units + w[7].units) / inRec;
      g._tr.units += w[4].units + w[5].units + w[6].units + w[7].units;
    }
  }
}

function finish(g) {
  const { rec, bef, units } = g._tr;
  /* weeks: [{ units, outDays, outProducts, products }]: units summed; outDays = days out per product with data that week
     (average, at least 0.1 when any was out, so the rose base means "some product was out", as on a product row);
     outProducts = how many were out */
  const weeks = g._wk.map((k) => (k.products ? { units: k.units, outDays: k.outProducts ? Math.max(0.1, round(k.outDays / k.products, 1)) : 0, outProducts: k.outProducts, products: k.products }
    : { units: null, outDays: 0, outProducts: 0, products: 0 }));
  const out = { ...g, weeks, trendPct: units >= TREND_MIN_UNITS && bef > 0 ? round(((rec - bef) / bef) * 100, 1) : null };
  delete out._tr; delete out._wk;
  return out;
}

/** Sums over a set of variant rows (each once). */
function sums(rows) {
  const g = blank('', ''); rows.forEach((r) => add(g, r));
  const { key, label, ids, weeks, ...rest } = finish(g);
  return rest;
}

/**
 * Group the report's product rows under one lens.
 * opts.showAll: include catch-all collections (hidden by default).
 * Returns { lens, overlap, groups (biggest sales lost first, the "none" group last), total (sum of the
 * groups; only when each variant is in one group), store (distinct store total), hidden (catch-alls left out) }.
 */
function build(rows, catalog = {}, lens = 'product', { showAll = false } = {}) {
  if (!LENSES.includes(lens)) throw new Error(`Unknown group: ${lens}`);
  catalog = { variants: catalog.variants || {}, collections: catalog.collections || {} };
  const hiddenList = lens === 'collection' && !showAll ? catchAll(rows, catalog) : [];
  const index = { hidden: new Set(hiddenList.map((h) => h.key)), byProduct: new Map() };
  if (lens === 'collection') {
    for (const [key, c] of Object.entries(catalog.collections)) {
      if (index.hidden.has(key)) continue;
      for (const p of c.productIds || []) {
        const k = String(p); if (!index.byProduct.has(k)) index.byProduct.set(k, []);
        if (!index.byProduct.get(k).includes(key)) index.byProduct.get(k).push(key);
      }
    }
  }
  const G = new Map();
  for (const r of rows) {
    for (const { key, label } of keysFor(r, catalog, lens, index)) {
      if (!G.has(key)) G.set(key, blank(key, label));
      add(G.get(key), r);
    }
  }
  /* trend colour: the products' own rule (LOGIC.md §7d) against the same baseline, the typical product (median
     product trend), so a group's chip reads like a product's: a fall is never green, a rise never red (critic r2 UI-3) */
  const base = storeTrend(rows);
  const groups = [...G.values()].map(finish).map((g) => ({ ...g, trendCall: trendCall(g.trendPct, base) }))
    .sort((a, b) => (a.key === '') - (b.key === '') || b.lost - a.lost || b.sold - a.sold || String(a.label).localeCompare(String(b.label)));
  const overlap = OVERLAP.has(lens);
  let total = null;
  if (!overlap) {
    total = { n: 0, needOrder: 0, sold: 0, lost: 0, lostProfit: null, orderValue: 0, excessValue: 0 };
    for (const g of groups) {
      for (const k of Object.keys(total)) if (k !== 'lostProfit') total[k] += g[k];
      if (g.lostProfit != null) total.lostProfit = (total.lostProfit || 0) + g.lostProfit;
    }
  }
  return { lens, overlap, groups, total, store: sums(rows), hidden: hiddenList, storeTrendPct: base };
}

/** Which lenses have something to show for this catalog (type is decided by the rows, client side). */
function lensesFor(catalog = {}) {
  const v = Object.values(catalog.variants || {});
  return LENSES.filter((l) => (l === 'tag' ? v.some((x) => (x.tags || []).length) : l === 'collection' ? Object.keys(catalog.collections || {}).length > 0 : true));
}

module.exports = { build, catchAll, keysFor, lensesFor, LENSES, CATCH_ALL };
