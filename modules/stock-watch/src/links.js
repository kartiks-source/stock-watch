'use strict';
/*
 * 1.4.0 (LOGIC.md §19): a product's picture and its two links, from the catalog (read-only stock query, src/shopify.js).
 *
 *   image     Shopify's CDN copy of the product's featured image (https://cdn.shopify.com only), or none
 *   adminUrl  https://admin.shopify.com/store/<shop handle>/products/<product ID>   (shop handle = the *.myshopify.com name)
 *   webUrl    the product's onlineStoreUrl; else <shop's primary domain>/products/<handle> when the product has a publish
 *             date; else null = "Not on website" (a draft, or a product not on the online store)
 *
 * Pure: annotate(rows, catalog, shop) adds { productId, image, adminUrl, webUrl } to every row whose `id` (variant ID) is in
 * the catalog. Rows without a catalog entry (demo, Flow, Sheet, CSV) get nothing and the page shows a plain box.
 */
const handleOf = (shop) => {
  const d = String((shop && (shop.domain || shop.handle)) || '').toLowerCase().replace(/\.myshopify\.com$/, '');
  return /^[a-z0-9][a-z0-9-]*$/.test(d) ? d : null;
};

/** The links for one catalog entry. */
function of(c, shop) {
  if (!c) return {};
  const out = {};
  const pid = String(c.productId || '');
  if (pid) out.productId = pid;
  if (typeof c.image === 'string' && /^https:\/\/cdn\.shopify\.com\//.test(c.image)) out.image = c.image;
  const h = handleOf(shop);
  if (h && /^\d+$/.test(pid)) out.adminUrl = `https://admin.shopify.com/store/${h}/products/${pid}`;
  const web = shop && typeof shop.web === 'string' && /^https:\/\/[^\s/]+$/i.test(shop.web) ? shop.web : null;
  if (typeof c.web === 'string' && /^https:\/\//.test(c.web)) out.webUrl = c.web;
  else if (c.published && c.handle && web && c.status === 'ACTIVE') out.webUrl = `${web}/products/${c.handle}`;
  else if (h || c.handle) out.webUrl = null;   // known product, not on the online store
  return out;
}

/** Adds the links to every row (mutates, returns rows). Rows are variants: `id` = variant ID. */
function annotate(rows, catalog, shop) {
  if (!Array.isArray(rows) || !catalog) return rows;
  for (const r of rows) {
    if (!r || r.id == null || !Object.hasOwn(catalog, String(r.id))) continue;
    Object.assign(r, of(catalog[String(r.id)], shop));
  }
  return rows;
}

/** A whole report: products (reorder rows are the same objects), stock-outs. */
function annotateReport(r, catalog, shop) {
  if (!r) return r;
  annotate(r.products, catalog, shop);
  annotate(r.reorder, catalog, shop);
  annotate(r.stockouts, catalog, shop);
  return r;
}

module.exports = { of, annotate, annotateReport, handleOf };
