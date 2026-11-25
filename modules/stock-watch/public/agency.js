/* 1.5.0 (meeting, 24 Nov): the screens are the agency's: what ran out, since when, what it cost, and what to do with the ads.
   The brand owner's tools (restock list and quantities, purchase orders, suppliers, budget, overstock, slow sellers, planning
   rules) are off the screens. The code behind them stays; a tab opened with ?owner=1 still shows them (tests, and if a brand asks). */
(() => {
  'use strict';
  let owner = false;
  try { if (new URLSearchParams(location.search).get('owner') === '1') sessionStorage.setItem('sw-owner', '1'); owner = sessionStorage.getItem('sw-owner') === '1'; } catch { /* private window */ }
  window.SW_AGENCY = !owner;
  document.documentElement.classList.toggle('agency', !owner);
})();
