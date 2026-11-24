'use strict';
/*
 * Read-only Shopify pull. Every call goes through gql(), which refuses anything that isn't a
 * plain GraphQL query, so this app cannot change a store even if its token could.
 *
 * Needs only these read scopes: read_products, read_inventory, read_orders.
 *
 *   pullStock   every variant's total stock now; a stock row is stored only when it changed, and the
 *               whole catalog (stock now, price, cost, type, tags, status) is returned on every pull
 *   pullOrders  orders changed since the last pull (first run: created in the last 60 days). Each order's
 *               lines are replaced whole, so later cancellations, refunds and edits are picked up (a refund or
 *               a cancellation moves the order's updated_at).
 *               What counts as a sale: not cancelled, not a test order, units kept = currentQuantity less the
 *               units on the order's refunds, price after line AND order-level discounts, without the tax (GST)
 *               inside it when the store's prices include tax (= Shopify's Net sales by order date, LOGIC.md §5).
 *               Each line also keeps `ordered` (Shopify's `quantity`) and, from the order's refunds (SW-064,
 *               1.1.3, LOGIC.md §9e): `returned` units, `refund` ₹ ex GST, `cancelled` units (cancelled before
 *               shipping: restock type CANCEL, or the whole order cancelled). A cancelled order's lines are kept
 *               with qty 0 (never a sale), all units returned and cancelled, as Shopify's reports count them.
 *               Reversal events (1.1.5, reversalEvents): every cancellation and refund line with its own date; the
 *               first run also reads orders updated in the 60 days, for older orders' reversals (events only).
 *
 * Paced by Shopify's own cost budget: waits whenever less than half of it is left,
 * so the store's other apps are never starved.
 */

const keys = require('./keys');

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const BACKFILL_DAYS = 60;            // read_orders sees 60 days; older needs read_all_orders
const OVERLAP = 30 * 60e3;           // re-read the last 30 minutes so late-indexed orders aren't missed
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The read-only guard: only query documents, never a mutation or subscription (a tokeniser, SW-051: src/gql-guard.js). */
const { assertReadOnly } = require('./gql-guard');

/** One GraphQL query. Retries throttling and a rejected (rotated) token once. `version` = another Admin API version (ShopifyQL, src/history.js). */
async function gql(doc, variables = {}, { fetchImpl = fetch, tries = 0, version = API_VERSION } = {}) {
  assertReadOnly(doc);
  const { shop, token } = await keys.access();
  const r = await fetchImpl(`https://${shop}.myshopify.com/admin/api/${version}/graphql.json`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
    body: JSON.stringify({ query: doc, variables }),
  });
  if (r.status === 401 || r.status === 403) {
    keys.clear();
    if (tries < 1) return gql(doc, variables, { fetchImpl, tries: tries + 1, version });
    throw new Error(r.status === 401 ? 'Shopify rejected the token' : 'The token lacks a read permission (needs read_products, read_inventory, read_orders)');
  }
  if (r.status === 429 || r.status >= 500) {
    if (tries >= 5) throw new Error(`Shopify: HTTP ${r.status}`);
    await sleep(2000 * (tries + 1));
    return gql(doc, variables, { fetchImpl, tries: tries + 1, version });
  }
  if (r.status === 404) throw new Error('Store not found: check SHOPIFY_STORE (the part before .myshopify.com)');
  if (!r.ok) throw new Error(`Shopify: HTTP ${r.status}`);
  const j = await r.json();
  const th = j.errors?.find((e) => e.extensions?.code === 'THROTTLED');
  if (th) {
    if (tries >= 8) throw new Error('Shopify kept throttling');
    /* 1.4.0: ShopifyQL is limited per minute (extensions.cost.windowResetAt, checked on Sammsara 24 Nov 2026): wait for the
       window to reset (≤ 65 s) instead of retrying every 3 s into the same full window */
    const reset = Date.parse(th.extensions?.cost?.windowResetAt || '');
    await sleep(Number.isFinite(reset) ? Math.min(65000, Math.max(3000, reset - Date.now() + 800)) : 3000);
    return gql(doc, variables, { fetchImpl, tries: tries + 1, version });
  }
  if (j.errors?.length) {
    const msg = j.errors.map((e) => e.message).join('; ');
    if (/access denied|scope/i.test(msg)) throw new Error('The token lacks a read permission (needs read_products, read_inventory, read_orders)');
    throw new Error(`Shopify: ${msg.slice(0, 200)}`);
  }
  const t = j.extensions?.cost?.throttleStatus;
  if (t && t.currentlyAvailable < t.maximumAvailable / 2) {
    await sleep(Math.min(20000, ((t.maximumAvailable / 2 - t.currentlyAvailable) / Math.max(1, t.restoreRate)) * 1000));
  }
  return j.data;
}

/** 1.4.0: product images are Shopify's CDN copies at this width (small, for 40–48 px rows and a 160 px drawer at 2×). */
const IMG_PX = 320;
const STOCK_Q = `query Stock($after: String) {
  productVariants(first: 250, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id sku title price createdAt inventoryQuantity inventoryItem { tracked unitCost { amount } } product { id title status productType tags vendor handle onlineStoreUrl publishedAt featuredMedia { preview { image { url(transform: { maxWidth: ${IMG_PX} }) } } } } }
  }
}`;
/** 1.4.0: the shop's own address, for "View on website" links when a product has no onlineStoreUrl (LOGIC §19). */
const SHOP_Q = 'query Shop { shop { myshopifyDomain primaryDomain { url } } }';

const LINE_FIELDS = 'id quantity currentQuantity sku variant { id } discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } } taxLines { priceSet { shopMoney { amount } } }';
/** Stored order prices are ex tax since 1.1.1. A store whose orders were read before (tax-inclusive) re-reads them once. */
const PRICE_BASIS = 'exTax';
/** Stored order lines carry `ordered` (SW-064) and refunds: `returned`, `refund`, `cancelled`, and cancelled orders' lines
 *  (1.1.3). A store whose lines were read before re-reads its last 60 days once (same as PRICE_BASIS). */
const ORDER_FIELDS = 'reversals';   // 1.1.5: + reversal events with their own dates, and older orders reversed in the window
/** Refund lines: units, restock type (CANCEL = removed before shipping), the line's ₹ after discounts and its tax. */
const RLI_FIELDS = 'id quantity restockType lineItem { id } subtotalSet { shopMoney { amount } } totalTaxSet { shopMoney { amount } }';
const REFUND_FIELDS = `id createdAt refundLineItems(first: 50) { pageInfo { hasNextPage endCursor } nodes { ${RLI_FIELDS} } }`;
const REFUNDS_PER_ORDER = 10;
const ORDERS_Q = `query Orders($after: String, $q: String) {
  orders(first: 40, after: $after, query: $q, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt updatedAt cancelledAt test taxesIncluded
      lineItems(first: 20) {
        pageInfo { hasNextPage endCursor }
        nodes { ${LINE_FIELDS} }
      }
      refunds(first: ${REFUNDS_PER_ORDER}) { ${REFUND_FIELDS} }
    }
  }
}`;

/** An order with more refunds than ORDERS_Q reads (rare): all of them. */
const MORE_REFUNDS_Q = `query Refunds($id: ID!) {
  order(id: $id) { refunds(first: 250) { ${REFUND_FIELDS} } }
}`;

/** A refund with more than 50 lines (rare): the rest, page by page. */
const REFUND_LINES_Q = `query RefundLines($id: ID!, $after: String) {
  refund(id: $id) {
    refundLineItems(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ${RLI_FIELDS} }
    }
  }
}`;

const MORE_LINES_Q = `query Lines($id: ID!, $after: String) {
  order(id: $id) {
    lineItems(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ${LINE_FIELDS} }
    }
  }
}`;

const vid = (gid) => String(gid || '').replace(/^gid:\/\/shopify\/ProductVariant\//, '');

/**
 * Compare the store's stock now with what we saw last time.
 * Returns stock rows for what changed (active, tracked variants only), the new last-seen map, and
 * the catalog: every variant returned, with stock now, attributes and whether it's active (SW-002).
 * Inactive = product archived or draft, or stock not tracked; it's kept in the catalog, marked.
 */
function diffStock(variants, lastQty, t) {
  const rows = []; const next = {}; const catalog = {}; const excluded = { notActive: 0, untracked: 0 };   // counted for the run history (SW-030)
  for (const v of variants) {
    const id = vid(v.id); const now = Number(v.inventoryQuantity);
    if (!id) continue;
    const tracked = !(v.inventoryItem && v.inventoryItem.tracked === false);
    const status = v.product?.status || 'ACTIVE';
    const cost = Number(v.inventoryItem?.unitCost?.amount) > 0 ? Number(v.inventoryItem.unitCost.amount) : null;
    const variant = v.title === 'Default Title' ? '' : (v.title || '');
    catalog[id] = {
      productId: String(v.product?.id || '').replace(/^gid:\/\/shopify\/Product\//, ''), product: v.product?.title || '', variant, sku: v.sku || '',
      type: v.product?.productType || '', vendor: v.product?.vendor || '', tags: Array.isArray(v.product?.tags) ? v.product.tags : [], price: Number(v.price) || 0, cost,
      status: tracked ? status : (status === 'ACTIVE' ? 'UNTRACKED' : status), tracked, active: tracked && status === 'ACTIVE',
      stock: Number.isFinite(now) ? now : null, seenAt: t,
      ...(Number.isFinite(Date.parse(v.createdAt)) ? { createdAt: Date.parse(v.createdAt) } : {}),   // 1.3.0: weeks live for G26 confidence (LOGIC §4c)
      ...productLinks(v.product),   // 1.4.0: image, handle, website address (LOGIC §19)
    };
    if (!tracked) excluded.untracked++; else if (status !== 'ACTIVE') excluded.notActive++;
    if (!catalog[id].active || !Number.isFinite(now)) continue;
    next[id] = now;
    const before = Object.prototype.hasOwnProperty.call(lastQty, id) ? lastQty[id] : null;
    if (before === now) continue;
    rows.push({ t, variantId: id, sku: v.sku || '', product: v.product?.title || '', variant, before, now, price: Number(v.price) || 0, ...(v.product?.productType ? { type: v.product.productType } : {}), ...(v.product?.vendor ? { vendor: v.product.vendor } : {}), ...(cost ? { cost } : {}) });
  }
  return { rows, lastQty: next, catalog, excluded };
}

/** 1.4.0 (LOGIC §19): what the catalog keeps to show and link a product. image = Shopify CDN URL (https://cdn.shopify.com
 *  only, else none); handle; web = onlineStoreUrl (set only when the product is on the online store); published = has a
 *  publishedAt date. Read-only fields of the stock query, nothing else. */
function productLinks(pr) {
  const out = {};
  const img = pr?.featuredMedia?.preview?.image?.url;
  if (typeof img === 'string' && /^https:\/\/cdn\.shopify\.com\//.test(img)) out.image = img;
  if (typeof pr?.handle === 'string' && /^[a-z0-9][a-z0-9-]*$/i.test(pr.handle)) out.handle = pr.handle;
  if (typeof pr?.onlineStoreUrl === 'string' && /^https:\/\//.test(pr.onlineStoreUrl)) out.web = pr.onlineStoreUrl;
  if (pr && pr.publishedAt) out.published = true;
  return out;
}

/** Unit price paid after every discount, without tax: when the order's prices include tax (taxesIncluded, e.g. GST
 *  in India), the line's tax ÷ its ordered quantity comes off. Prices without tax inside them are left as they are. */
function netUnitPrice(order, l) {
  const paid = Number(l.discountedUnitPriceAfterAllDiscountsSet?.shopMoney?.amount) || 0;
  if (!order.taxesIncluded) return paid;
  const tax = (l.taxLines || []).reduce((s, x) => s + (Number(x?.priceSet?.shopMoney?.amount) || 0), 0);
  const q = Number(l.quantity) || Number(l.currentQuantity) || 1;
  return Math.max(0, Math.round((paid - tax / q) * 100) / 100);
}

/** The order's refunds per line item ID: units, ₹ ex GST (the refund line's subtotal after discounts, less its tax when
 *  the order's prices include tax, as Shopify's "Returns") and units cancelled before shipping (restock type CANCEL). */
function refundsByLine(order, refunds) {
  const by = new Map();
  for (const f of refunds || []) {
    for (const x of f?.refundLineItems?.nodes || []) {
      const id = String(x?.lineItem?.id || ''); if (!id) continue;
      const q = Math.max(0, Number(x.quantity) || 0);
      const sub = Number(x.subtotalSet?.shopMoney?.amount) || 0, tax = Number(x.totalTaxSet?.shopMoney?.amount) || 0;
      const r = by.get(id) || { units: 0, value: 0, cancel: 0 };
      r.units += q; r.value += order.taxesIncluded ? sub - tax : sub;
      if (x.restockType === 'CANCEL') r.cancel += q;
      by.set(id, r);
    }
  }
  return by;
}

/** An order → its lines (LOGIC.md §What counts as a sale, §9e). Test orders have none.
 *  qty = units kept: currentQuantity, less refunded units (a return need not lower currentQuantity); ordered = Shopify's
 *  quantity; returned / refund ₹ / cancelled from the order's refunds (only when > 0). A cancelled order: qty 0, every
 *  unit returned and cancelled. A line with qty 0 is kept so its return counts; the engine leaves it out of ₹ sold. */
function orderRows(order, lines, refunds = order.refunds) {
  if (order.test) return [];
  const t = Date.parse(order.createdAt), gone = !!order.cancelledAt, back = refundsByLine(order, refunds);
  const keep = (l) => l.variant?.id && (gone ? Number(l.quantity) > 0 : (l.currentQuantity > 0 || l.quantity > 0));
  return lines.filter(keep).map((l) => {
    const id = String(l.id || ''), ordered = Math.max(0, Number(l.quantity) || 0), price = netUnitPrice(order, l);
    const rf = back.get(id) || { units: 0, value: 0, cancel: 0 };
    const returned = gone ? ordered : (ordered ? Math.min(ordered, rf.units) : rf.units);
    const qty = gone ? 0 : Math.max(0, Math.min(Number(l.currentQuantity) || 0, ordered ? ordered - returned : Infinity));
    const r = { t, order: order.name, line: id.replace(/^gid:\/\/shopify\/LineItem\//, ''), variantId: vid(l.variant.id), sku: l.sku || '', qty, price };
    if (ordered > 0) r.ordered = Math.max(qty, ordered);
    if (returned > 0) {
      r.returned = returned;
      r.refund = Math.round((rf.value + Math.max(0, returned - rf.units) * price) * 100) / 100;   // units with no refund line: at the price paid
      const cancelled = gone ? ordered : Math.min(returned, rf.cancel);
      if (cancelled > 0) r.cancelled = cancelled;
    }
    return r;
  });
}

const num2 = (x) => Math.round(x * 100) / 100;
const gidNum = (gid) => String(gid || '').replace(/^gid:\/\/shopify\/\w+\//, '');
/**
 * Reversals with their own dates (1.1.5, LOGIC.md §9e), as Shopify's reports book them: one event per refund line
 * (t = the refund's createdAt; qty = its units; value = its subtotal after discounts, less its tax when the order's
 * prices include tax, ex GST like the stored prices), and for a cancelled order one per line for the units no refund
 * line covers (t = cancelledAt; value = units × the line's price paid ex GST). A cancellation reverses every unit then,
 * so a refund made after it moves money only and adds no event (Sammsara #92029: cancelled 29 Aug, refunded 17 Nov;
 * Shopify books its return on 29 Aug only). kind: 'cancel' (the order is cancelled, or restock type CANCEL = removed
 * before shipping), else 'refund'. id = refund line ID, or 'c' + line ID: the store replaces an order's events whole on
 * every read and keeps one event per id. Lines without a variant are left out, like their sales. Test orders have none.
 */
function reversalEvents(order, lines, refunds = order.refunds) {
  if (order.test) return [];
  const byLine = new Map(lines.map((l) => [String(l.id || ''), l])), covered = new Map(), out = new Map();
  const gone = !!order.cancelledAt, tc = Date.parse(order.cancelledAt);
  for (const f of refunds || []) {
    const t = Date.parse(f?.createdAt);
    if (!Number.isFinite(t) || (gone && t > tc)) continue;   // after the cancel: money only
    for (const x of f?.refundLineItems?.nodes || []) {
      const lid = String(x?.lineItem?.id || ''), q = Math.max(0, Number(x?.quantity) || 0);
      if (!lid || !q) continue;
      covered.set(lid, (covered.get(lid) || 0) + q);
      const l = byLine.get(lid); if (!l?.variant?.id) continue;
      const sub = Number(x.subtotalSet?.shopMoney?.amount) || 0, tax = Number(x.totalTaxSet?.shopMoney?.amount) || 0;
      const id = x.id ? gidNum(x.id) : `${gidNum(f.id)}:${gidNum(lid)}`;
      const e = out.get(id) || { id, t, order: order.name, variantId: vid(l.variant.id), qty: 0, value: 0, kind: gone || x.restockType === 'CANCEL' ? 'cancel' : 'refund' };
      e.qty += q; e.value = num2(e.value + (order.taxesIncluded ? sub - tax : sub));
      out.set(id, e);
    }
  }
  if (gone && Number.isFinite(tc)) {
    for (const l of lines) {
      const lid = String(l.id || ''), rest = Math.max(0, (Number(l.quantity) || 0) - (covered.get(lid) || 0));
      if (!rest || !l.variant?.id) continue;
      const id = `c${gidNum(lid)}`;
      out.set(id, { id, t: tc, order: order.name, variantId: vid(l.variant.id), qty: rest, value: num2(rest * netUnitPrice(order, l)), kind: 'cancel' });
    }
  }
  return [...out.values()];
}

async function pullStock(lastQty, { q = gql, now = Date.now() } = {}) {
  const all = []; let after = null;
  do {
    const d = await q(STOCK_Q, { after });
    all.push(...d.productVariants.nodes);
    after = d.productVariants.pageInfo.hasNextPage ? d.productVariants.pageInfo.endCursor : null;
  } while (after);
  const out = diffStock(all, lastQty || {}, now);
  out.shop = await shopInfo(q);
  return out;
}

/** 1.4.0: { domain: 'brand.myshopify.com', web: 'https://www.brand.com' } or null (never fails a pull). */
async function shopInfo(q = gql) {
  try {
    const s = (await q(SHOP_Q, {}))?.shop;
    const domain = String(s?.myshopifyDomain || '').toLowerCase();
    const web = String(s?.primaryDomain?.url || '').replace(/\/+$/, '');
    return { domain: /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain) ? domain : null, web: /^https:\/\/[^\s/]+$/i.test(web) ? web : null };
  } catch (e) { console.warn('shop info:', e.message); return null; }
}

/**
 * Orders changed since `since` (ms; the newest updatedAt seen last time), oldest change first.
 * First run (no `since`): every order created in the last 60 days, and every order updated in them (1.1.5): an older
 * order cancelled or refunded in the 60 days gives its reversal events only (LOGIC.md §9e), never its lines as sales.
 * onPage(orderNames, rows, cursor, reversals) after each page: the caller replaces those orders' lines whole, and
 * reversals = { orders, events } replaces the events of `orders` (every order read) whole; it saves the cursor so a
 * long first load resumes where it stopped.
 */
async function pullOrders(since, { q = gql, now = Date.now(), onPage = () => {} } = {}) {
  const cut = now - BACKFILL_DAYS * 864e5, iso = new Date(cut).toISOString();
  const filter = since
    ? `updated_at:>='${new Date(since - OVERLAP).toISOString()}'`
    : `created_at:>='${iso}' OR updated_at:>='${iso}'`;
  let after = null; let cursor = since || 0; let total = 0;
  do {
    const d = await q(ORDERS_Q, { after, q: filter });
    const rows = [], names = [], events = [], all = [];
    for (const o of d.orders.nodes) {
      const older = !since && Date.parse(o.createdAt) < cut;   // backfill: placed before the 60 days, reversed (or touched) in them
      all.push(o.name);
      if (!older) names.push(o.name);
      const lines = [...o.lineItems.nodes];
      let li = o.lineItems.pageInfo;
      while (li.hasNextPage) {
        const m = await q(MORE_LINES_Q, { id: o.id, after: li.endCursor });
        lines.push(...m.order.lineItems.nodes); li = m.order.lineItems.pageInfo;
      }
      let refunds = o.refunds || [];
      if (refunds.length >= REFUNDS_PER_ORDER) refunds = (await q(MORE_REFUNDS_Q, { id: o.id })).order.refunds || [];
      for (let i = 0; i < refunds.length; i++) {   // one call at a time, so the cost pacing holds
        const rl = refunds[i].refundLineItems; if (!rl?.pageInfo?.hasNextPage) continue;
        const nodes = [...rl.nodes]; let pi = rl.pageInfo;
        while (pi.hasNextPage) {
          const m = await q(REFUND_LINES_Q, { id: refunds[i].id, after: pi.endCursor });
          nodes.push(...m.refund.refundLineItems.nodes); pi = m.refund.refundLineItems.pageInfo;
        }
        refunds = refunds.map((f, j) => (j === i ? { ...f, refundLineItems: { nodes } } : f));
      }
      if (!older) rows.push(...orderRows(o, lines, refunds));
      events.push(...reversalEvents(o, lines, refunds));
      cursor = Math.max(cursor, Date.parse(o.updatedAt) || Date.parse(o.createdAt) || 0);
    }
    total += rows.length;
    await onPage(names, rows, cursor, { orders: all, events });
    after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
  } while (after);
  return { total, cursor };
}

module.exports = { gql, assertReadOnly, diffStock, productLinks, shopInfo, SHOP_Q, IMG_PX, orderRows, reversalEvents, refundsByLine, netUnitPrice, pullStock, pullOrders, API_VERSION, PRICE_BASIS, ORDER_FIELDS, SCOPES: ['read_products', 'read_inventory', 'read_orders'] };
