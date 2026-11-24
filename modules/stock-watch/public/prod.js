/* 1.4.0 (LOGIC §19): every product row shows its picture on the left, the name and code stacked to its right, and two
   small links: "Open in Shopify" (admin) and "View on website" ("Not on website" when it isn't on the online store).
   Rows come from the server with image / adminUrl / webUrl (src/links.js); demo, Flow, Sheet and CSV rows have none and
   get a plain box. Shared by app.js and brand.js. */
(() => {
  'use strict';
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const okImg = (u) => typeof u === 'string' && /^https:\/\/cdn\.shopify\.com\//.test(u);
  const okUrl = (u) => typeof u === 'string' && /^https:\/\//.test(u);
  const ICON = {
    shop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h16l-1.2 11.2a1.5 1.5 0 0 1-1.5 1.3H6.7a1.5 1.5 0 0 1-1.5-1.3z"/><path d="M8.5 8V6.5a3.5 3.5 0 0 1 7 0V8"/></svg>',
    web: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.3 3.8 5.2 3.8 8.5s-1.2 6.2-3.8 8.5c-2.6-2.3-3.8-5.2-3.8-8.5s1.2-6.2 3.8-8.5z"/></svg>',
  };
  /** The picture: lazy, alt = the product name; none → a neutral box with the first letter. size in px. */
  const thumb = (p, size = 40) => (okImg(p && p.image)
    ? `<img class="thumb" src="${esc(p.image)}" alt="${esc(p.name || '')}" width="${size}" height="${size}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
    : `<span class="thumb none" style="width:${size}px;height:${size}px" aria-hidden="true">${esc(String((p && p.name) || '?').trim().charAt(0).toUpperCase())}</span>`);
  /** The two links (icon buttons with labels for screen readers and a title on hover); big = text buttons (drawer). */
  function links(p, big = false) {
    if (!p) return '';
    const a = okUrl(p.adminUrl) ? `<a class="plink${big ? ' big' : ''}" href="${esc(p.adminUrl)}" target="_blank" rel="noopener noreferrer" title="Open in Shopify" aria-label="Open ${esc(p.name || 'product')} in Shopify">${ICON.shop}${big ? '<span>Open in Shopify</span>' : ''}</a>` : '';
    const w = okUrl(p.webUrl) ? `<a class="plink${big ? ' big' : ''}" href="${esc(p.webUrl)}" target="_blank" rel="noopener noreferrer" title="View on website" aria-label="View ${esc(p.name || 'product')} on the website">${ICON.web}${big ? '<span>View on website</span>' : ''}</a>`
      : p.webUrl === null ? `<span class="pnoweb" title="This product isn’t on the online store">Not on website</span>` : '';
    return a || w ? `<span class="plinks">${a}${w}</span>` : '';
  }
  /** One product cell: picture | name (+ extra html after it) / code + links. */
  const cell = (p, { extra = '', before = '', size = 40 } = {}) => `<span class="prod">${thumb(p, size)}<span class="pt"><span class="pl1">${before}<span class="pname" title="${esc(p.name)}">${esc(p.name)}</span>${extra}</span><span class="pl2">${p.sku ? `<span class="psku" title="Product code (SKU)">${esc(p.sku)}</span>` : ''}${links(p)}</span></span></span>`;
  /** The drawer's top: big picture, name, code, both links as labelled buttons. */
  const hero = (p, extra = '') => `<div class="phero">${thumb(p, 120)}<div class="pht"><h2 id="drawer-title">${esc(p.name)}</h2>${p.sku ? `<div class="psku">Code ${esc(p.sku)}</div>` : ''}${extra}${links(p, true)}</div></div>`;
  /** CSV columns for a row. */
  const csv = (p) => [(p && p.adminUrl) || '', (p && p.webUrl) || (p && p.webUrl === null ? 'Not on website' : '')];
  window.SW_PROD = { thumb, links, cell, hero, csv, CSV_HEAD: ['Shopify admin link', 'Website link'] };
})();
