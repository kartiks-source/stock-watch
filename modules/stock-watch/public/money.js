/* Sprint 3 A-money (LOGIC.md §6c, §6d). Loaded before app.js; app.js calls SW_MONEY.init(...) and a few hooks:
 *   SW-040 suppliers   Data → Suppliers panel (admin: edit terms, set a SKU's supplier, CSV in/out);
 *                      Reorder "By supplier" = one PO draft per supplier (lines, pcs, ₹ at unit cost), Copy + CSV each
 *   SW-041 budget      Reorder "Budget ₹" (remembered per store, this browser): rows ranked by profit kept per ₹,
 *                      one cut line, rows below dimmed and left out of the CSV. Empty budget = the page as before.
 * The ranking and cut mirror src/budget.js (rank / cut) so the page and the CSV cut at the same row.
 */
(() => {
  'use strict';
  let A = null;               // from app.js: { state, api, toast, money, esc, inr, storeUrl, copy, viewOnly, render, reload, dateShort }
  let last = null;            // the last cut: { fit: Set, over, overValue, spent, protect, firstOver }
  let terms = null;           // GET /api/suppliers (for the PO header: MOQ, case pack), per store
  const store = () => (window.SW_STORES && SW_STORES.current()) || 'default';
  const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const put = (k, v) => { try { if (v == null || v === '') localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private window */ } };

  /* ---------- SW-041 budget ---------- */
  const parse = (x) => { const n = Number(String(x ?? '').replace(/[₹,\s]/g, '')); return Number.isFinite(n) && n > 0 && n <= 1e12 ? Math.round(n) : null; };
  const budget = () => parse(get(`sw-budget:${store()}`));
  const due = (p) => p.orderQty > 0 && p.orderValue > 0;
  function rank(rows) {   // = src/budget.js rank()
    return rows.map((p, i) => [p, i]).sort(([a, i], [b, j]) => {
      const x = a.perRupee == null ? -1 : a.perRupee, y = b.perRupee == null ? -1 : b.perRupee;
      return y - x || (b.protect || 0) - (a.protect || 0) || i - j;
    }).map(([p]) => p);
  }
  function cut(rows, B) {   // = src/budget.js cut()
    const ranked = rank(rows), fit = new Set();
    let spent = 0, protect = 0, over = 0, overValue = 0, open = true, firstOver = null;
    for (const p of ranked) {
      if (!due(p)) continue;
      if (open && spent + p.orderValue <= B) { fit.add(String(p.id)); spent += p.orderValue; protect += p.protect || 0; continue; }
      if (open) firstOver = String(p.id);
      open = false; over++; overValue += p.orderValue;
    }
    return { rows: ranked, fit, spent, protect, over, overValue, firstOver };
  }
  /** Reorder rows: ranked and cut when a budget is set; untouched (today's order) when not. */
  function rows(list) {
    const B = budget();
    last = null;
    if (B == null) return list;
    last = cut(list, B);
    return last.rows;
  }
  /** Extra Reorder column while a budget is on. */
  function cols() {
    if (budget() == null) return [];
    /* UI-4: no product has a cost → it ranks sales kept per ₹ at selling price; say so, no "profit", no "est." */
    const hasCost = !!A.state.report.totals.hasCost;
    return [{ k: 'perRupee', label: hasCost ? 'Profit kept / ₹' : 'Sales kept / ₹', r: 1, tip: hasCost ? 'Profit you’d lose over lead time + days to last without this order, ÷ its cost (LOGIC §6d). “est.” = no unit cost, store’s average margin used' : 'Sales you’d lose over lead time + days to last without this order, ÷ its value; no unit costs in Shopify, so both are at selling price (LOGIC §6d)', f: (p) => (p.gift ? '<small class="muted" title="Mostly sold at ₹0 (average paid under 10% of the list price): left out of the budget rank">free gift?</small>' : p.perRupee == null ? '–' : `${A.esc(p.perRupee.toFixed(2))}${hasCost && p.protectEst ? ' <small class="muted">est.</small>' : ''}`), val: (p) => p.perRupee ?? -1 }];
  }
  /** ?budget= for the CSV link, so the file holds the rows above the line. */
  const qs = () => (budget() != null ? `&budget=${budget()}` : '');
  const inBudget = (p) => !last || last.fit.has(String(p.id));

  /* ---------- the bar under the Reorder toolbar ---------- */
  const lens = () => (get('sw-polens') === 'supplier' ? 'supplier' : 'list');
  /* Phones: the bar folds behind a "Budget" button in the chips row, so the first order card stays near the top
     (ui-helpers M8). It is open while a budget or By supplier is on, or after a tap. */
  let phoneOpen = false;
  const barOpen = () => phoneOpen || budget() != null || lens() === 'supplier';
  const toggle = () => `<button class="btn ghost mbar-tg" id="mbar-tg" aria-expanded="${barOpen()}" aria-controls="mbar">₹ Budget</button>`;
  function bar(list) {
    const B = budget(), r = A.state.report, extra = r.totals.packExtraValue || 0, { money, esc, inr } = A;
    const sum = B == null
      ? (extra ? `<span class="muted" title="Order quantities rounded up to suppliers’ minimum order and whole case packs (LOGIC §6c)">${money(extra)} of the orders is minimum-order / case-pack round-up</span>` : '')
      : `<span><b>${inr.format(last ? last.fit.size : 0)}</b> fit · ${money(last ? last.spent : 0)} keeps <b class="okv">${money(last ? last.protect : 0)}</b> ${r.totals.hasCost ? 'profit' : 'sales'}${last && last.over ? ` · <span class="lost">${inr.format(last.over)} over budget (${money(last.overValue)})</span>` : ''}</span>`;
    return `<div class="mbar${barOpen() ? ' open' : ''}" id="mbar">
      <label class="bud" title="${r.totals.hasCost ? 'Cash you can spend on this order. Rows are ranked by profit kept per ₹' : 'What you can spend on this order, at selling price (no unit costs in Shopify). Rows are ranked by sales kept per ₹'}; the ones that fit stay, the rest are dimmed and left out of the CSV. Remembered for this store in this browser.">
        <span>Budget ₹</span><input id="budget-in" inputmode="numeric" autocomplete="off" placeholder="No limit" value="${B == null ? '' : esc(inr.format(B))}" aria-label="Budget in rupees"></label>
      ${B != null ? '<button class="btn ghost xs" id="budget-clear" aria-label="Clear budget">Clear</button>' : ''}
      <div class="seg" role="group" aria-label="Show"><button class="${lens() === 'list' ? 'on' : ''}" data-polens="list">List</button><button class="${lens() === 'supplier' ? 'on' : ''}" data-polens="supplier">By supplier</button></div>
      ${sum}</div>`;
  }

  /* ---------- SW-040 PO drafts, one per supplier ---------- */
  const NONE = 'No supplier';
  function poGroups(list) {
    const by = new Map();
    for (const p of list) {
      if (!due(p) || !inBudget(p)) continue;
      const k = p.supplier || '';
      if (!by.has(k)) by.set(k, { name: k, lines: [], pcs: 0, value: 0, extra: 0 });
      const g = by.get(k); g.lines.push(p); g.pcs += p.orderQty; g.value += p.orderValue; g.extra += p.packExtraValue || 0;
    }
    return [...by.values()].sort((a, b) => (a.name ? 0 : 1) - (b.name ? 0 : 1) || b.value - a.value);
  }
  const termsOf = (name) => (terms && terms.suppliers || []).find((s) => s.name.toLowerCase() === String(name).toLowerCase()) || null;
  const termsText = (s) => (s ? [s.leadDays != null ? `${s.leadDays} d lead` : '', s.moq != null ? `MOQ ${A.inr.format(s.moq)}` : '', s.pack != null ? `case ${A.inr.format(s.pack)}` : ''].filter(Boolean).join(' · ') : '');
  function csvHref(g) {
    const S = A.state;
    return A.storeUrl(`/api/export/reorder.csv?days=${S.days}${Object.entries(S.what).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('')}&filter=${S.filter.reorder}&q=${encodeURIComponent(S.q.reorder)}&supplier=${encodeURIComponent(g.name)}${window.SW_BRAND && SW_BRAND.scope() === 'best' ? '&best=1' : ''}${qs()}`);
  }
  function poView(list) {
    loadTerms();
    const { money, esc, inr } = A, gs = poGroups(list);
    if (!gs.length) return `<div class="tbl"><div class="empty">${budget() != null ? 'Nothing fits this budget.' : 'Nothing to order in this view.'}</div></div>`;
    return `<div class="pos">${gs.map((g, i) => `
      <details class="panel podraft"${i === 0 && gs.length <= 2 ? ' open' : ''}>
        <summary><span class="po-n"><b>${esc(g.name || NONE)}</b><small class="muted">${esc(termsText(termsOf(g.name)) || (g.name ? 'store lead time, no rounding' : 'set one in Data → Suppliers'))}</small></span>
          <span class="po-t"><b>${money(g.value)}</b><small class="muted">${inr.format(g.lines.length)} lines · ${inr.format(g.pcs)} pcs</small></span>
          <span class="po-a"><button class="btn ghost xs" data-pocopy="${i}" title="Copy this PO as text">Copy</button><a class="btn ghost xs" href="${esc(csvHref(g))}" title="Download this supplier’s PO as CSV">CSV</a></span></summary>
        <table class="po-lines"><thead><tr><th>Product</th><th class="r">Pcs</th><th class="r">${A.state.report.totals.hasCost ? 'Unit cost' : 'Unit price'}</th><th class="r">Line</th></tr></thead><tbody>
        ${g.lines.map((p) => `<tr data-id="${esc(p.id)}" tabindex="0"><td><b>${esc(p.name)}</b> <small class="muted">${esc(p.sku || '')}</small></td><td class="r"><b>${inr.format(p.orderQty)}</b>${p.packExtra ? `<small class="muted" title="${inr.format(p.packExtra)} pcs (${money(p.packExtraValue)}) added to reach the minimum order / whole cases"> +${inr.format(p.packExtra)}</small>` : ''}</td><td class="r">${p.cost != null ? money(p.cost) : A.state.report.totals.hasCost ? '<small class="muted" title="No unit cost: line uses the average price paid">price</small>' : money(p.price)}${p.gift ? ' <small class="muted" title="Mostly sold at ₹0: average paid under 10% of the list price">free gift?</small>' : ''}</td><td class="r">${money(p.orderValue)}</td></tr>`).join('')}
        </tbody></table>${g.extra ? `<p class="muted small">${money(g.extra)} of this is round-up to the minimum order / whole cases.</p>` : ''}
      </details>`).join('')}</div>`;
  }
  function poText(g) {
    const { inr } = A, name = (A.state.report.store && A.state.report.store.name) || '';
    const rupee = (x) => `₹${inr.format(Math.round(+x || 0))}`;
    return [`Purchase order (draft) · ${g.name || NONE} · ${A.dateShort(Date.now())}${name ? ` · from ${name}` : ''}`, '',
      ...g.lines.map((p) => `${p.sku || p.id} · ${p.name} · ${inr.format(p.orderQty)} pcs${p.cost != null ? ` × ${rupee(p.cost)} = ${rupee(p.orderValue)}` : ''}`),
      '', `Total: ${inr.format(g.lines.length)} lines · ${inr.format(g.pcs)} pcs · ${rupee(g.value)}`].join('\n');
  }
  async function loadTerms(force) {
    const id = store();
    if (!force && terms && terms.store === id) return;
    if (!force && loadTerms._busy === id) return;
    loadTerms._busy = id;
    try { terms = { ...(await A.api('/api/suppliers')), store: id }; if (A.state.view === 'reorder' && lens() === 'supplier') A.render(); else if (A.state.view === 'data') fillPanel(); }
    catch { /* the PO still shows; only the terms line is missing */ } finally { loadTerms._busy = null; }
  }

  /* ---------- after each render: dim the rows over budget, draw the cut line ---------- */
  function after(view) {
    if (view !== 'reorder' || !last) return;
    for (const el of document.querySelectorAll('#view tr[data-id], #view .mcard[data-id]')) {
      const p = A.state.report.reorder.find((x) => String(x.id) === el.dataset.id);
      if (p && due(p) && !last.fit.has(String(p.id))) { el.classList.add('overb'); el.title = 'Over budget: left out of the CSV'; }
    }
    if (!last.firstOver || A.state.sort.reorder) return;   // a column sort breaks the ranking: rows stay dimmed, no line
    const label = `Budget ${A.money(budget())} ends here · ${A.inr.format(last.over)} below are over budget (${A.money(last.overValue)})`;
    const tr = document.querySelector(`#view .tbl.desk tr[data-id="${CSS.escape(last.firstOver)}"]`);
    if (tr) tr.insertAdjacentHTML('beforebegin', `<tr class="cutline"><td colspan="${tr.cells.length}">${A.esc(label)}</td></tr>`);
    const card = document.querySelector(`#view .mcard[data-id="${CSS.escape(last.firstOver)}"]`);
    if (card) card.insertAdjacentHTML('beforebegin', `<div class="cutline">${A.esc(label)}</div>`);
  }

  /* ---------- SW-040 Data → Suppliers ---------- */
  function panel() {
    if (A.viewOnly()) return '';
    return `<details class="panel fold" id="sup-panel"><summary><b>Suppliers</b> <span class="muted">lead time, minimum order, case pack · used on Reorder</span></summary><div id="sup-body"><p class="muted">Loading…</p></div></details>`;
  }
  const num = (v) => (v == null ? '' : String(v));
  function fillPanel() {
    const el = document.getElementById('sup-body'); if (!el || !terms) return;
    const { esc, inr } = A, list = terms.suppliers || [], lead = A.state.settings.leadDays;
    const rowHtml = (s, i) => `<div class="sup-row" data-i="${i}">
        <div class="sup-name">${s.isNew ? `<input class="sup-in" data-f="name" placeholder="Supplier name" aria-label="Supplier name" value="${esc(s.name)}">` : `<b>${esc(s.name)}</b>`}<small class="muted">${s.products ? `${inr.format(s.products)} products` : 'no products yet'}</small></div>
        <label><span>Lead (days)</span><input class="sup-in" data-f="leadDays" inputmode="numeric" placeholder="${esc(lead)}" value="${esc(num(s.leadDays))}"></label>
        <label><span>MOQ (pcs)</span><input class="sup-in" data-f="moq" inputmode="numeric" placeholder="–" value="${esc(num(s.moq))}"></label>
        <label><span>Case pack</span><input class="sup-in" data-f="pack" inputmode="numeric" placeholder="–" value="${esc(num(s.pack))}"></label></div>`;
    el.innerHTML = `<p class="muted">Order quantities round <b>up</b> to the minimum order (MOQ), then to whole case packs. A supplier’s lead time replaces the store’s (${esc(lead)} days). Blank = not set. A product’s supplier is its Shopify vendor unless you set one below.${terms.unassigned ? ` ${inr.format(terms.unassigned)} products have no supplier.` : ''}</p>
      <div class="sup-list">${list.map(rowHtml).join('')}</div>
      <div class="toolbar"><button class="btn" id="sup-save">Save suppliers</button><button class="btn ghost" id="sup-add">Add supplier</button></div>
      <div class="sup-map"><b>Change a product’s supplier</b>
        <div class="toolbar"><input id="map-sku" placeholder="SKU or variant ID" aria-label="SKU or variant ID"><input id="map-sup" list="sup-names" placeholder="Supplier (blank = Shopify vendor)" aria-label="Supplier"><datalist id="sup-names">${list.map((s) => `<option value="${esc(s.name)}">`).join('')}</datalist><button class="btn ghost" id="map-set">Set</button></div></div>
      <div class="sup-csv"><b>Spreadsheet</b> <span class="muted">download, edit, upload back</span>
        <div class="toolbar"><a class="btn ghost xs" href="${esc(A.storeUrl('/api/export/suppliers.csv?kind=suppliers'))}">Suppliers CSV</a><a class="btn ghost xs" href="${esc(A.storeUrl('/api/export/suppliers.csv?kind=map'))}">Product → supplier CSV</a>
          <select id="sup-kind" aria-label="File holds"><option value="suppliers">Suppliers</option><option value="map">Product → supplier</option></select><input type="file" id="sup-file" accept=".csv,text/csv" aria-label="CSV file"><button class="btn ghost" id="sup-up">Upload</button></div></div>`;
  }
  function readRows() {
    return [...document.querySelectorAll('#sup-body .sup-row')].map((r) => {
      const i = +r.dataset.i, base = terms.suppliers[i] || {}, v = {};
      for (const inp of r.querySelectorAll('.sup-in')) v[inp.dataset.f] = inp.value.trim();
      return { name: v.name ?? base.name, leadDays: v.leadDays, moq: v.moq, pack: v.pack };
    }).filter((s) => s.name);
  }
  async function saved(msg) { A.toast(msg); await loadTerms(true); fillPanel(); await A.reload(); document.getElementById('sup-panel')?.setAttribute('open', ''); fillPanel(); }

  document.addEventListener('toggle', (e) => { if (e.target.id === 'sup-panel' && e.target.open) { if (terms && terms.store === store()) fillPanel(); loadTerms(true); } }, true);
  document.addEventListener('change', (e) => {
    if (e.target.id !== 'budget-in') return;
    const B = parse(e.target.value);
    put(`sw-budget:${store()}`, B == null ? '' : String(B));
    if (B == null && e.target.value.trim() && e.target.value.trim() !== '0') A.toast('Budget must be a ₹ amount above 0');
    A.render();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'budget-in') e.target.blur(); });
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t || !A) return;
    if (t.dataset.polens) { put('sw-polens', t.dataset.polens === 'supplier' ? 'supplier' : ''); A.render(); return; }
    if (t.id === 'mbar-tg') { phoneOpen = !barOpen(); A.render(); if (phoneOpen) document.getElementById('budget-in')?.focus(); return; }
    if (t.id === 'budget-clear') { phoneOpen = true; put(`sw-budget:${store()}`, ''); A.render(); return; }
    if (t.dataset.pocopy != null) { e.preventDefault(); const g = poGroups(rows(currentRows()))[+t.dataset.pocopy]; if (g) A.copy(poText(g)); return; }
    try {
      if (t.id === 'sup-add') { terms.suppliers = [...readRows().map((s, i) => ({ ...terms.suppliers[i], ...s })), { name: '', isNew: true, products: 0 }]; fillPanel(); document.querySelector('#sup-body .sup-row:last-child input')?.focus(); return; }
      if (t.id === 'sup-save') { t.disabled = true; const j = await A.api('/api/suppliers', { method: 'PUT', body: JSON.stringify({ suppliers: readRows() }) }); await saved(j.changed ? `Saved: ${j.changed} supplier${j.changed === 1 ? '' : 's'} changed` : 'No changes'); return; }
      if (t.id === 'map-set') {
        const sku = document.getElementById('map-sku').value.trim(), supplier = document.getElementById('map-sup').value.trim();
        if (!sku) { A.toast('Type a SKU or variant ID'); return; }
        t.disabled = true; await A.api('/api/suppliers/map', { method: 'POST', body: JSON.stringify({ items: [{ sku, supplier }] }) });
        await saved(supplier ? `${sku} now buys from ${supplier}` : `${sku} back to its Shopify vendor`); return;
      }
      if (t.id === 'sup-up') {
        const f = document.getElementById('sup-file').files[0]; if (!f) { A.toast('Choose a CSV file first'); return; }
        t.disabled = true;
        const j = await A.api(`/api/suppliers/import?kind=${document.getElementById('sup-kind').value}`, { method: 'POST', body: await f.text(), json: false, headers: { 'content-type': 'text/csv' } });
        await saved(`Read ${j.read} rows${j.skipped ? `, ${j.skipped} skipped (${j.skips[0].error}, line ${j.skips[0].line})` : ''}`); return;
      }
    } catch (err) { A.toast(err.message); t.disabled = false; }
  });
  /* the rows the Reorder page shows now (same filter + search as app.js), for Copy */
  function currentRows() {
    const S = A.state, f = S.filter.reorder, q = S.q.reorder.toLowerCase();
    const g = (s) => (['Out now', 'Critical', 'Order now'].includes(s) ? 'today' : s === 'Order this week' ? 'week' : 'other');
    return S.report.reorder.filter((p) => (f === 'all' || g(p.status) === f) && (!q || `${p.name} ${p.sku}`.toLowerCase().includes(q)));
  }

  window.SW_MONEY = {
    init(ctx) { A = ctx; },
    rows, cols, bar, toggle, qs, after, panel,
    bySupplier: () => lens() === 'supplier',
    poView,
  };
})();
