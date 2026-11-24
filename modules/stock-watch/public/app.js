/* Stock-out Watch — browser app. No framework: state → HTML strings → #view. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    days: 30, view: 'overview', report: null, settings: null, source: null,
    filter: { reorder: 'all', stockouts: 'all', products: 'all' },   // show everything by default; a role (roles.js) or a tab narrows it
    q: { reorder: '', stockouts: '', products: '' },
    sort: { reorder: null, stockouts: null, products: null },
    what: {},                                   // trial values for the planning assumptions (not saved)
    pick: new Set(),                            // Reorder rows ticked for Mark ordered
    limit: {},                                  // rows shown per table (pages of 50)
    colW: (() => { try { return JSON.parse(localStorage.getItem('sw-colw') || '{}'); } catch { return {}; } })(),
  };
  const PAGE = 50;
  const ASSUME = [
    ['leadDays', 'Lead time (days)', '', 1, 'Days from placing a supplier order until the stock can be sold'],
    ['coverDays', 'Stock should last (days after delivery)', '', 5, 'How long each reorder should last once it arrives'],
    ['safetyDays', 'Extra buffer (days)', '', 1, 'Spare days of stock for busy days or a late supplier'],
    ['demandWindowDays', 'Sales history to use (days)', '', 7, 'Days of sales used to work out each product’s daily rate'],
    ['minPerDay', 'Ignore products selling under (per day)', '', 0.1, 'Slower products stay off the reorder list (best sellers never do)'],
    ['smallTopUpDays', 'Flag refills under (days of sales)', '', 1, 'A refill smaller than this many days of sales is flagged “refilled too little”'],
    ['allocationCheck', 'Spot website allocations (1 on, 0 off)', '', 1, 'Stock topped back up to the same few pieces 3+ times in 14 days is a website allocation refilled from a warehouse: no reorder is sized from it (LOGIC §6)'],
  ];
  const whatQs = () => Object.entries(state.what).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('');

  /* ---------- formatting ---------- */
  const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
  const money = (x) => {
    const v = Math.round(+x || 0), a = Math.abs(v);
    if (a >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
    if (a >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
    return `₹${inr.format(v)}`;
  };
  const moneyFull = (x) => `₹${inr.format(Math.round(+x || 0))}`;
  const n1 = (x) => (x == null ? '–' : (Math.round(x * 10) / 10).toLocaleString('en-IN'));
  /** Sales rate in words people use: "5 a day", "3 a week", "1 every 2 weeks" (the maths keeps the exact rate, LOGIC §3). */
  const rate = (x) => {
    if (x == null || !Number.isFinite(x)) return '–';
    if (x <= 0) return 'none';
    if (x >= 0.95) return `${Math.round(x).toLocaleString('en-IN')} a day`;
    const w = x * 7;
    if (w >= 0.95) return `${Math.round(w)} a week`;
    return Math.round(1 / w) <= 1 ? '1 a week' : `1 every ${Math.round(1 / w)} weeks`;   // UI-10: never "1 every 1 weeks"
  };
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /* store time (SW-049): public/tz.js looks the offset up per moment, so daylight saving zones read right */
  const zone = () => (window.SW_TZ ? SW_TZ.zoneOf(state.settings) : null);
  const off = (t = Date.now()) => (window.SW_TZ ? SW_TZ.offsetAt(zone(), t) : (state.settings?.tzOffsetMin ?? 330)) * 60e3;
  const local = (t) => new Date(t + off(t));
  const dt = (t) => { if (!t) return '–'; const d = local(t); return `${String(d.getUTCDate()).padStart(2, '0')} ${MON[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
  const dayLabel = (k) => { const [, m, d] = k.split('-'); return `${+d} ${MON[+m - 1]}`; };
  const dur = (h) => (h >= 48 ? `${n1(h / 24)} days` : `${n1(h)} h`);
  const inPeriod = (r = { period: state.days === 'month' ? 'month' : 'days', days: state.days }) => (r.period === 'month' ? 'this month' : `in the last ${r.days} days`);   // "This month" = from the 1st (SW-027)

  const STATUS_CLS = { 'Out now': 'out', Critical: 'crit', 'Order now': 'now', 'Order this week': 'week', OK: 'ok', 'Slow seller': 'idle', 'No stock data': 'idle', Inactive: 'idle', 'Top-up from warehouse': 'idle' };
  const narrow = () => window.innerWidth < 760;
  const SHORT = { 'Order this week': 'This week', 'No stock data': 'No stock' };
  const pill = (s) => `<span class="st ${STATUS_CLS[s] || 'ok'}" title="${esc(s)}">${esc(SHORT[s] || s)}</span>`;

  /* ---------- server ---------- */
  /* every call names the store this page shows (public/stores.js, ADR-0015): two tabs on two stores never cross */
  const storeUrl = (path) => (window.SW_STORES ? SW_STORES.url(path) : path);
  async function api(path, opt = {}) {
    const r = await fetch(storeUrl(path), { ...opt, headers: { ...(opt.body && typeof opt.body === 'string' && opt.json !== false ? { 'content-type': 'application/json' } : {}), ...(opt.headers || {}) } });
    if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
    const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  function toast(msg, action) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false; toast._do = action ? action.run : null;
    if (action) { const b = document.createElement('button'); b.className = 'tact'; b.id = 'toast-act'; b.textContent = action.label; t.append(' ', b); }
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; toast._do = null; }, action ? 6000 : 2600);
  }

  async function reloadReport() {
    state.report = await api(`/api/report?days=${state.days}${whatQs()}`);
    header(); render();
  }
  async function load() {
    if (window.SW_STORES) await SW_STORES.ready;
    const [rep, set] = await Promise.all([api(`/api/report?days=${state.days}${whatQs()}`), api('/api/settings')]);
    state.report = rep; state.settings = set.settings; state.source = { kind: rep.source, lastSync: rep.lastSync, err: rep.lastSyncError }; state.shopify = set.shopify || {}; state.ops = set.ops || null;   // SW-055: capacity + read-only notice on Data
    state.runs = set.runs || [];   // SW-030
    state.role = set.role || 'admin'; state.changes = set.changes || []; state.lastPlanChange = set.lastPlanChange || null;   // SW-029
    header();
    render._animate = true; render();
    freshness();
  }

  /* ---------- stale-data banner (SW-019): "Data is X h old" when this store's last Shopify pull is older than the server's
     threshold (freshness.staleAfterMin = max(45, 2 × pull interval + 15): 255 min at the default 2-hour pull).
     From the report's freshness (this store only; /status covers every store, ADR-0015), aged on the page every minute. */
  const STALE_DEFAULT = 255;   // only until a report says otherwise
  const asTime = (v) => (typeof v === 'number' && v > 1e12 ? v : typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
  const ageText = (min) => (min < 90 ? `${Math.round(min)} min` : min < 48 * 60 ? `${n1(min / 60)} h` : `${n1(min / 1440)} days`);
  function freshness() {
    const f = (state.report && state.report.freshness) || {}, sh = state.shopify || {};
    const last = asTime(f.lastPull) ?? asTime(sh.lastSync);
    const connected = !!f.shopify || !!sh.source;
    const age = last ? (Date.now() - last) / 60e3 : null;
    const after = Number.isFinite(f.staleAfterMin) ? f.staleAfterMin : STALE_DEFAULT;
    const stale = connected && (f.stale === true || (age != null && age > after));
    const el = $('#stale');
    if (!stale) { el.hidden = true; return; }
    const err = sh.lastError;
    el.innerHTML = `<b>${age != null ? `Data is ${ageText(age)} old.` : 'Data may be out of date.'}</b> <span>${last ? `Last Shopify pull ${dt(last)}` : 'No Shopify pull yet'}${err ? ` · ${esc(err)}` : ''}${sh.running ? ' · pulling now…' : ''}. Pulls should land within ${ageText(after)}; numbers may not show the latest stock and orders.</span> <a href="#data">Data &amp; settings</a>`;
    el.hidden = false;
  }
  setInterval(() => { if (state.report) freshness(); }, 60e3);

  function header() {
    const r = state.report, s = state.settings, name = (r.store && r.store.name) || s.storeName || 'Store';
    if (window.SW_STORES && SW_STORES.list().length) SW_STORES.rename(name);   // stores.js draws the pill (dot + name)
    else { $('#store-name').textContent = name; document.title = `${name} · Stock-out Watch`; }
    $('#n-reorder').textContent = r.totals.orderToday || '';
    const stillOut = outsByProduct().filter((a) => a.open && !a.dead).length;   // out but not selling don't count (SW-063)
    $('#n-stockouts').textContent = stillOut || '';
    $('#n-stockouts').title = `${stillOut} products still out of stock`;
    const src = state.source, d = r.data, sh = state.shopify || {};
    const err = sh.lastError || src.err;
    const pill = $('#sync-pill');
    pill.className = 'sync-pill ' + (err ? 'err' : src.kind === 'demo' ? 'demo' : src.kind === 'live' ? 'ok' : '');
    pill.querySelector('span').textContent = err ? 'Sync issue' : src.kind === 'demo' ? 'Demo data' : sh.running ? syncingText(sh.progress) : 'Data Sync';
    if ($('#sync-progress')) $('#sync-progress').textContent = syncingText(sh.progress);
    watchSync();
    pill.title = err || (src.kind === 'demo' ? 'Showing demo data' : sh.running ? syncingText(sh.progress) : 'Data is syncing');
    const badge = src.kind === 'demo' ? '<span class="badge demo">Demo data</span>' : src.kind === 'live' ? '<span class="badge live">Live data</span>' : '<span class="badge empty">No data yet</span>';
    $('#source').innerHTML = `${badge}<span>${inr.format(d.stockRows)} stock changes · ${inr.format(d.orderRows)} order lines</span>`
      + (d.lastStock ? `<span>Last stock change: ${dt(d.lastStock)}</span>` : '')
      + (src.err ? `<span class="badge err">Sheet sync: ${esc(src.err)}</span>` : src.lastSync ? `<span>Sheet synced: ${dt(src.lastSync)}</span>` : '')
      + shopifyBadge() + appVersion(r.app);
    $$('.range button').forEach((b) => b.classList.toggle('on', b.dataset.days === String(state.days)));
    if ($('#rdates')) { const sp = periodDates(r); $('#rdates').textContent = sp; $('#rdates').title = `Every number on the page covers ${sp}, store time (${zone()}), today so far included: the same dates in Shopify give the same numbers`; }
    if (viewOnly()) { $('#tabs a[data-view="data"]').hidden = true; pill.removeAttribute('href'); }   // view-only: no Data page (SW-029)
  }

  function shopifyBadge() {
    const sh = state.shopify || {};
    if (!sh.source) return '';
    if (sh.running) return '<span>Shopify: pulling now…</span>';
    if (sh.lastError) return `<span class="badge err">Shopify: ${esc(sh.lastError)}</span>`;
    return sh.lastSync ? `<span>Shopify synced: ${dt(sh.lastSync)}</span>` : '<span>Shopify: first pull pending</span>';
  }
  function shopifyPanel() {
    const sh = state.shopify || {};
    const scopes = (sh.scopes || []).map((x) => `<span class="mono">${esc(x)}</span>`).join(', ');
    if (!sh.source) {
      return `<div class="panel" style="grid-column:1/-1"><h2>Shopify (read-only) · not connected</h2>
        <p class="muted">Connect a store and the app reads stock every 2 hours and new orders since the last read, straight from Shopify. It only ever reads: every call is checked, and anything that could change the store is refused. Read permissions needed: ${scopes}.</p>
        <p class="muted">Set these as Railway variables (the key is never typed into this page):</p>
        <dl class="kv"><dt>Performity POC API (decided)</dt><dd>Performity hands this app the current Shopify token for each allowed brand: <span class="mono">PERFORMITY_POC_API_URL, PERFORMITY_POC_API_KEY</span> (and <span class="mono">PERFORMITY_BRAND_ID</span> when more than one brand is allowed). A fresh token is asked for before each pull and never kept; this app never refreshes it. This server’s static outbound IP must be on Performity’s allow-list.</dd>
          <dt>What Shopify gives</dt><dd>The app’s <b>client ID + client secret</b> (Shopify Dev Dashboard). We swap them for a 24-hour token and renew it automatically. The app must be in the <b>same Shopify organisation</b> as the store, so the brand creates and installs it and shares the ID + secret.</dd>
          <dt>Azure Key Vault</dt><dd><span class="mono">AZURE_KEY_VAULT_URL, AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, SHOPIFY_STORE</span>. Reads secrets <span class="mono">shopify-&lt;store&gt;-client-id</span> and <span class="mono">shopify-&lt;store&gt;-client-secret</span>.</dd>
          <dt>Stop-gap</dt><dd><span class="mono">SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET</span></dd></dl></div>`;
    }
    const where = sh.source === 'vault' ? `Azure Key Vault, <span class="mono">${esc(sh.secretName)}</span>` : `Railway variables (stop-gap) · ${esc(sh.kind || '')}`;
    return `<div class="panel" style="grid-column:1/-1"><h2>Shopify (read-only) · ${esc(sh.store || '')}</h2>
      <dl class="kv"><dt>Key from</dt><dd>${where}</dd>
        <dt>Status</dt><dd>${!sh.ready ? `<span style="color:#E0506E">Missing: ${esc(sh.missing.join(', '))}</span>` : sh.running ? 'Pulling now…' : sh.lastError ? `<span style="color:#E0506E">${esc(sh.lastError)}</span>${sh.lastTry ? ` · tried ${dt(sh.lastTry)}` : ''}` : sh.lastSync ? `OK · last read ${dt(sh.lastSync)}` : 'First pull pending'}</dd>
        <dt>Order history</dt><dd>${sh.backfilled ? 'Last 60 days loaded, new orders added every 2 hours' : 'Loads the last 60 days on the first pull'}</dd>
        <dt>Reads only</dt><dd>${scopes} · API ${esc(sh.apiVersion || '')}</dd></dl>
      <div class="toolbar"><button class="btn" id="shopify-sync">Pull from Shopify now</button></div></div>`;
  }

  /* 1.1.5 (LOGIC §9e): one line to check the app against Shopify Analytics → Net sales for the same dates */
  function shopifyCheck() {
    const r = state.report, n = r && r.totals && r.totals.shopifyNet;
    if (!n) return '';
    return `<p class="muted small" id="shopify-check" title="Shopify’s Net sales = gross sales − discounts − returns: orders placed on these days (cancelled ones too), ex GST, after discounts, less what was cancelled or refunded on these days, whenever the order was placed. No tax, no shipping. Sold on the Overview stays by order date: what customers bought on these days and kept">Check against Shopify · net sales ${esc(periodDates(r))}: <b>${moneyFull(n.net)}</b> (${moneyFull(n.gross)} ordered − ${moneyFull(n.returns)} cancelled/refunded on these days). Shopify: Analytics → Net sales, same dates.</p>`;
  }

  /* ---------- sync progress and run history (SW-030) ---------- */
  const syncingText = (p) => (!p ? 'Syncing…' : p.phase === 'orders' ? `Syncing · ${inr.format(p.orders)} orders` : 'Syncing · stock');
  const took = (ms) => (ms < 90e3 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60e3)} min`);
  /* While a pull runs, refresh the pill every 3 s; when it ends, reload everything once. */
  function watchSync() {
    if (!(state.shopify || {}).running || watchSync.t) return;
    watchSync.t = setTimeout(async () => {
      watchSync.t = null;
      try {
        const set = await api('/api/settings');
        if (set.shopify && set.shopify.running) { state.shopify = set.shopify; header(); } else await load();
      } catch { /* next load() tries again */ }
    }, 3000);
  }
  function runLine(r) {
    const what = `${inr.format(r.stock)} stock changes · ${inr.format(r.lines)} order lines${r.kind === 'shopify' ? ` (${inr.format(r.orders)} orders)` : ''}`;
    return `<div class="ep"><span class="muted">${dt(r.start)}</span><span>${r.kind === 'shopify' ? 'Shopify' : 'Sheet'} · ${took(r.ms)}</span><span>${what}</span>${r.error ? `<span class="st crit" title="${esc(r.error)}">Failed</span><span class="err-t">${esc(r.error)}</span>` : '<span class="st ok">OK</span>'}${(r.notes || []).map((n) => `<span class="muted">${esc(n)}</span>`).join('')}</div>`;
  }
  function runHistory() {
    const list = state.runs || [], last = list[0];
    if (!list.length) return '';
    return `<details class="fold-in"><summary>Last ${list.length} sync${list.length === 1 ? '' : 's'} · latest ${dt(last.start)}, ${took(last.ms)}, ${last.error ? 'failed' : 'OK'}</summary><div class="log">${list.map(runLine).join('')}</div></details>`;
  }

  /* which build is running (SW-056): version + commit, last in the footer; "dev" when the build carries no SHA */
  const appVersion = (a) => (a && a.version ? `<span class="ver" title="App version and the commit it was built from${a.sha ? ` (${esc(a.sha)})` : ': none recorded, a local or unstamped build'}">v${esc(a.version)} · ${esc(a.short || 'dev')}</span>` : '');

  /* ---------- view-only sign-in and the settings change log (SW-029) ---------- */
  const viewOnly = () => state.role === 'view';
  const SETTING_LABEL = { ...Object.fromEntries(ASSUME.map(([k, l]) => [k, l.replace(/ \((days|per day)[^)]*\)$/, '')])), storeName: 'Store name', tzOffsetMin: 'Time zone (min from UTC)', timeZone: 'Time zone', sheetStockCsv: 'Stock log link', sheetOrderCsv: 'Order log link', ingestKey: 'Flow key',
    'digest.hour': 'Digest hour', 'digest.roles': 'Digest goes to', 'digest.paused': 'Digest paused', 'digest.webhook': 'Digest webhook' };   // digest: SW-028 settings in the same log
  const shortVal = (v) => (v == null || v === '' ? '–' : String(v).length > 40 ? String(v).slice(0, 37) + '…' : String(v));
  const changeText = (c) => `${esc(SETTING_LABEL[c.key] || c.key)}: ${esc(shortVal(c.old))} → <b>${esc(shortVal(c.new))}</b>`;
  function changeLog() {
    const list = state.changes || [];
    return `<details class="fold-in" id="change-log"><summary>Advanced: change log</summary>${list.length
      ? `<div class="log">${list.map((c) => `<div class="ep"><span class="muted">${dt(c.at)}</span><span>${changeText(c)}</span><span class="muted">by ${esc(c.by)}</span></div>`).join('')}</div>`
      : '<p class="muted small">No settings changed yet.</p>'}</details>`;
  }

  /* digest settings are saved by digest-ui.js: re-read the log in place, so the change shows without closing anything */
  document.addEventListener('sw:settings-changed', async () => {
    try {
      const set = await api('/api/settings'); state.changes = set.changes || [];
      const el = $('#change-log'); if (!el) return;
      const open = el.open; el.outerHTML = changeLog(); if (open) $('#change-log').open = true;
    } catch { /* the next load shows it */ }
  });

  /* ---------- planning assumptions: change a number, every figure updates; save when happy ---------- */
  function planBar() {
    const S = state.settings, R = state.report.settings, t = state.report.totals;
    const trial = Object.keys(state.what).length > 0;
    const fields = ASSUME.slice(0, 3).map(([k, label, unit, step, tip]) => `<div class="pf" title="${esc(tip)}"><label for="w-${k}">${label}</label>
        <span class="pin"><button class="pm" data-step="${k}|-${step}" aria-label="Less ${label}">−</button><input id="w-${k}" data-what="${k}" data-trial="${k}" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" aria-label="${esc(label)}" value="${esc(window.SW_TRIAL?.typed(`w-${k}`) ?? R[k])}" class="${state.what[k] != null && +state.what[k] !== +S[k] ? 'changed' : ''}"><button class="pm" data-step="${k}|${step}" aria-label="More ${label}">+</button></span></div>`).join('');
    return `<details class="plan" ${(state.planOpen ?? false) || trial ? 'open' : ''}><summary>Plan settings <span class="muted">lead time ${R.leadDays} d · lasts ${R.coverDays} d · buffer ${R.safetyDays} d</span>${trial ? ' <span class="badge demo">trying new values</span>' : ''}</summary>
      <div class="pbody">${fields}${trial ? `<span class="pact">${viewOnly() ? '' : '<button class="btn" id="what-save">Save as default</button>'}<button class="btn ghost" id="what-reset">Reset</button></span>` : ''}</div>${state.lastPlanChange ? `<p class="muted small plast">Last changed ${dt(state.lastPlanChange.at)} by ${esc(state.lastPlanChange.by)} · ${changeText(state.lastPlanChange)}</p>` : ''}</details>`;
  }
  let whatTimer = null;
  function setWhat(k, v) {
    if (v === '' || !Number.isFinite(+v)) return;
    if (+v === +state.settings[k]) delete state.what[k]; else state.what[k] = +v;
    clearTimeout(whatTimer); whatTimer = setTimeout(() => reloadReport().catch((e) => toast(e.message)), 220);
  }

  /* ---------- trend: 8 weekly bars (units), rose base where the product was out of stock that week ---------- */
  /* week i of 8 (oldest first) = the 7 days ending (7 − i) weeks before the report time; labelled by the 7 calendar
     days it ends on ("13–19 Nov" for the last block, which ends now) */
  const weekEnd = (i) => state.report.generatedAt - (7 - i) * 7 * 864e5 - 1;
  const weekStart = (i) => weekEnd(i) - 6 * 864e5;
  const WEEK_LABEL = (i) => {
    const a = local(weekStart(i)), b = local(weekEnd(i));
    return a.getUTCMonth() === b.getUTCMonth() ? `${a.getUTCDate()}–${b.getUTCDate()} ${MON[b.getUTCMonth()]}` : `${a.getUTCDate()} ${MON[a.getUTCMonth()]}–${b.getUTCDate()} ${MON[b.getUTCMonth()]}`;
  };
  const weekTip = (x, i) => (x.units == null ? `${WEEK_LABEL(i)}: no data yet` : `${WEEK_LABEL(i)}: ${inr.format(x.units)} sold${x.outProducts != null   // a group row (SW-021): how many of its products were out
    ? (x.outProducts ? `, ${inr.format(x.outProducts)} of ${inr.format(x.products)} product${x.products === 1 ? '' : 's'} out part of the week` : '')
    : x.outDays ? `, out ${n1(x.outDays)} d` : ''}`);
  function spark(p, w = 64, h = 20) {
    const wk = p.weeks || []; if (!wk.length) return '';
    const max = Math.max(1, ...wk.map((x) => x.units || 0)), bw = w / wk.length, gap = bw > 6 ? 1 : 0.5;
    const bars = wk.map((x, i) => {
      if (x.units == null) return `<g><title>${weekTip(x, i)}</title><rect class="nd" x="${i * bw + gap}" y="${h - 3}" width="${bw - 2 * gap}" height="1"/><rect class="hit" x="${i * bw}" y="0" width="${bw}" height="${h}"/></g>`;
      const bh = x.units ? Math.max(2, (x.units / max) * (h - 4)) : 0;
      const out = x.outDays > 0 ? `<rect class="so" x="${i * bw + gap}" y="${h - 2}" width="${bw - 2 * gap}" height="2"/>` : '';
      return `<g><title>${weekTip(x, i)}</title><rect class="hit" x="${i * bw}" y="0" width="${bw}" height="${h}"/>`
        + `<rect class="sb${i === wk.length - 1 ? ' last' : ''}" style="animation-delay:${i * 35}ms" x="${i * bw + gap}" y="${h - 3 - bh}" width="${bw - 2 * gap}" height="${bh}" rx="${bw > 6 ? 1 : 0.5}"/>${out}</g>`;
    }).join('');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Weekly units, last 8 weeks">${bars}</svg>`;
  }
  function trendChip(p) {
    if (p.trendPct == null) return p.trendNew ? '<span class="tr new" title="In stock but no sales in the 14 days before; 3 or more sold since">New</span>' : (narrow() ? '<span class="muted small tr-none">too few sales for a trend</span>' : '<span class="tr low" title="Not enough sales yet to call a trend">–</span>');
    /* colour = the engine's call (LOGIC.md §7d): green / red only when the product's own % points that way and it is
       10+ points off the typical product; text = this product's own change. The tooltip says how it compares. */
    const v = p.trendPct, cls = p.trendCall || 'flat', base = state.report.totals.storeTrendPct;
    const pct = (x) => `${x > 0 ? '+' : ''}${n1(x)}%`;
    const gap = base == null ? 0 : v - base;
    const verdict = p.trendCall == null ? (v > 0 ? 'Rising' : v < 0 ? 'Falling' : 'Flat')   // no call (critic r2 UI-3): the sign only, never a comparison it didn't make
      : base == null ? (cls === 'up' ? 'Selling faster' : cls === 'down' ? 'Selling slower' : 'About flat')
      : cls === 'up' ? 'Selling faster, and better than the typical product' : cls === 'down' ? 'Selling slower, and worse than the typical product'
        : gap >= 10 ? 'Falling, but less than the typical product' : gap <= -10 ? 'Rising, but less than the typical product' : 'In line with the typical product';
    return `<span class="tr ${cls}" title="${verdict}: ${pct(v)}${base != null ? ` vs typical ${pct(base)}` : ''}. Sales per in-stock day, last 14 days vs the 14 before; out-of-stock days are left out, so a stock-out doesn't look like falling demand.">${pct(v)}</span>`;
  }

  /* Trend column tip: % = the product's own change; colour = against the typical product (median trend, LOGIC.md §7d) */
  const trendTip = () => {
    const b = state.report.totals.storeTrendPct;
    return `Units sold per week, last 8 weeks (rose = out of stock part of that week); % = sales per in-stock day, last 14 days vs the 14 before. Green = rising and 10 points or more better than the typical product; red = falling and 10 points or more worse${b != null ? ` (${b > 0 ? '+' : ''}${n1(b)}% over the same days)` : ''}`;
  };

  /* which priority columns the CSS shows at this width (mirrors the @media rules in styles.css) */
  const colVisible = (c) => !(c.pr === 'w' && innerWidth < 1400) && !(c.pr === 4 && innerWidth <= 1700) && !(c.pr === 3 && innerWidth <= 1400) && !(c.pr === 2 && innerWidth <= 1180);
  const tier = () => (innerWidth > 1700 ? 'xl' : innerWidth > 1400 ? 'l' : innerWidth > 1180 ? 'm' : 's');
  const colKey = (id) => `${id}@${tier()}`;                 // widths are remembered per screen size
  const tableRoom = () => (document.querySelector('.wrap')?.clientWidth || innerWidth) - 46;
  /* ---------- generic sortable table ---------- */
  /* A sortable table on wide screens; on phones the same rows as cards (card(r) → html) with a sort picker. */
  function table(id, cols, rows, empty, card) {
    const s = state.sort[id];
    if (s) {
      const col = cols.find((c) => c.k === s.k);
      const v = col?.val || ((r) => r[s.k]);
      rows = rows.slice().sort((a, b) => { const x = v(a), y = v(b); return (x > y ? 1 : x < y ? -1 : 0) * s.dir; });
    }
    if (!rows.length) return `<div class="tbl"><div class="empty">${esc(empty)}</div></div>`;
    const total = rows.length, limit = state.limit[id] || PAGE;
    rows = rows.slice(0, limit);
    const more = total > rows.length ? `<div class="more"><button class="btn ghost" data-more="${id}">Show ${Math.min(PAGE, total - rows.length)} more</button><span class="muted">${inr.format(rows.length)} of ${inr.format(total)}</span><button class="btn ghost" data-more="${id}" data-all="1">Show all</button></div>` : '';
    cols = cols.filter(colVisible);
    const W = state.colW[colKey(id)], fixed = W && cols.every((c) => W[c.k]);
    if (fixed) { const sum = cols.reduce((a, c) => a + W[c.k], 0), room = tableRoom(); if (sum > room) cols.forEach((c) => { W[c.k] = Math.max(40, Math.floor((W[c.k] * room) / sum)); }); }
    const desk = `<div class="tbl desk"><table data-table="${id}" class="${fixed ? 'fixed' : ''}" ${fixed ? `style="width:${cols.reduce((a, c) => a + W[c.k], 0)}px"` : ''}><thead><tr>${cols.map((c) => `<th class="${c.r ? 'r' : ''}${c.pr ? ' p' + c.pr : ''}" data-k="${c.k}"${c.opt ? ' data-opt="1"' : ''} tabindex="0" aria-sort="${s && s.k === c.k ? (s.dir > 0 ? 'ascending' : 'descending') : 'none'}"${c.tip ? ` title="${esc(c.tip)}"` : ''}${fixed ? ` style="width:${W[c.k]}px"` : ''}>${esc(c.label)}${s && s.k === c.k ? (s.dir > 0 ? ' ↑' : ' ↓') : ''}<span class="rz" title="Drag to resize · double-click to reset all columns"></span></th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr data-id="${esc(r.id)}" tabindex="0">${cols.map((c) => `<td class="${c.r ? 'r' : ''}${c.nw ? ' nw' : ''}${c.pr ? ' p' + c.pr : ''}">${c.f ? c.f(r) : esc(r[c.k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    if (!card) return desk + more;
    const cur = s ? `${s.k}|${s.dir}` : '';
    const opts = cols.filter((c) => (c.r || c.val) && !['status', 'name', 'type', 'start', 'end'].includes(c.k))
      .flatMap((c) => (c.k === 'daysLeft' ? [[`${c.k}|1`, 'Days left: fewest first']] : [[`${c.k}|-1`, `${c.label}: highest first`]]));
    const phone = `<div class="phone">
        <label class="msort"><span>Sort by</span><select data-msort="${id}" aria-label="Sort by"><option value="">${({ reorder: 'Most urgent first', stockouts: 'Biggest loss first', products: ({ pause: 'Out first, then fewest days left', push: 'Most ₹ stuck first', slow: 'Biggest ₹ first' })[pFilter()] || 'Biggest loss first', groups: 'Biggest loss first' })[id] || 'Default'}</option>${opts.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <div class="mcards">${rows.map((r) => `<article class="mcard" data-id="${esc(r.id)}" tabindex="0">${card(r)}</article>`).join('')}</div>
      </div>`;
    return desk + phone + more;
  }
  const kv = (label, value, cls = '') => `<div class="${cls}"><span>${label}</span><b>${value}</b></div>`;

  /* ---------- charts (SVG, to scale) ---------- */
  /* Drawn at the box's real width (fitChart) and a fixed height, so the SVG isn't scaled: labels stay at the CSS size
     and the chart doesn't grow with the screen (final r2 UI-1 / SIMP-A: 407–538 px tall at 1280–1920 pushed Overview
     past one screen; M6: phones scaled the labels down to ~9 px). w = the first guess before the page lays out. */
  const chartGuessW = () => (narrow() ? Math.min(innerWidth, 760) - 44 : Math.max(600, innerWidth - 300));
  function dailyChart(daily, w = chartGuessW()) {
    const W = Math.max(280, Math.round(w)), H = narrow() ? 220 : 200, L = 64, R = narrow() ? 22 : 10, T = 12, B = 30;   // M6: room for the last date at 12.5 px
    const max = Math.max(1, ...daily.map((d) => d.sold + d.lost));
    const step = niceStep(max / 4); const top = Math.ceil(max / step) * step;
    const y = (v) => T + (H - T - B) * (1 - v / top);
    const bw = (W - L - R) / daily.length;
    const every = Math.ceil(daily.length / (narrow() ? 4 : 10));
    let g = '';
    for (let v = 0; v <= top + 1; v += step) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#E7EBF2" stroke-width="1"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${esc(money(v))}</text>`;
    daily.forEach((d, i) => {
      const x = L + i * bw + bw * 0.14, w = bw * 0.72;
      const ys = y(d.sold), yl = y(d.sold + d.lost);
      g += `<g><title>${dayLabel(d.day)}: sold ${moneyFull(d.sold)}, lost ${moneyFull(d.lost)}${d.outSkus ? ` · ${d.outSkus} product(s) out` : ''}</title>`
        + `<rect x="${x}" y="${ys}" width="${w}" height="${Math.max(0, y(0) - ys)}" rx="2" fill="#0978BE"/>`
        + (d.lost > 0 ? `<rect x="${x}" y="${yl}" width="${w}" height="${Math.max(1, ys - yl)}" rx="2" fill="#E0506E"/>` : '') + '</g>';
      if (narrow() ? (daily.length - 1 - i) % every === 0 : i % every === 0 || i === daily.length - 1) g += `<text x="${x + w / 2}" y="${H - 12}" text-anchor="middle">${dayLabel(d.day)}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Daily sales and sales lost to stock-outs">${g}</svg>`;
  }
  function niceStep(x) { const p = 10 ** Math.floor(Math.log10(Math.max(1, x))); const m = x / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }

  /* hFrom = the product's first stock record (engine row.historyFrom): before it, hatched grey and named, never blank (UI-1, M3) */
  const noHistory = (p, from) => (p && p.historyFrom != null && p.historyFrom > from + 864e5 ? p.historyFrom : null);
  function stockChart(tl, from, to, hFrom = null) {
    if (tl.length < 2) return '<p class="muted">No stock changes recorded in this period.</p>';
    const max = Math.max(1, ...tl.map((p) => p.stock));
    const top = Math.ceil(max / niceStep(max / 4)) * niceStep(max / 4);
    const W = narrow() ? 340 : 680, H = narrow() ? 200 : 220, L = 40, R = narrow() ? 24 : 26, T = 10, B = 28;   // M8: room for the last date label
    const x = (t) => L + (W - L - R) * ((t - from) / (to - from));
    const y = (v) => T + (H - T - B) * (1 - Math.max(0, v) / top);
    let path = `M${x(tl[0].t)},${y(tl[0].stock)}`, bands = hFrom ? `<defs><pattern id="nohist" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#F1F3F7"/><line x1="0" y1="0" x2="0" y2="6" stroke="#D9DEE7" stroke-width="2"/></pattern></defs><rect class="nohist" x="${L}" y="${T}" width="${Math.max(0, x(Math.min(hFrom, to)) - L)}" height="${H - T - B}" fill="url(#nohist)"><title>No stock record before ${dateShort(hFrom)}</title></rect>` : '';
    for (let i = 1; i < tl.length; i++) {
      path += ` H${x(tl[i].t)} V${y(tl[i].stock)}`;
      if (tl[i - 1].stock <= 0) bands += `<rect x="${x(tl[i - 1].t)}" y="${T}" width="${Math.max(1, x(tl[i].t) - x(tl[i - 1].t))}" height="${H - T - B}" fill="#FCE9ED"/>`;
    }
    let ticks = '';
    for (let v = 0; v <= top; v += niceStep(max / 4)) ticks += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#E7EBF2"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
    const days = Math.round((to - from) / 864e5); let xl = '';
    /* never a date past now (a calendar period starts at midnight: 29.5 days rounded to 30 put tomorrow's date off the edge) */
    for (let i = 0; from + i * 864e5 <= to; i += Math.max(1, Math.ceil(days / (narrow() ? 3 : 6)))) { const t = from + i * 864e5; const d = local(t); xl += `<text x="${x(t)}" y="${H - 8}" text-anchor="middle">${d.getUTCDate()} ${MON[d.getUTCMonth()]}</text>`; }
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Stock over time; shaded = out of stock">${bands}${ticks}<path d="${path}" fill="none" stroke="#0978BE" stroke-width="2"/>${xl}</svg>`;
  }
  function unitsChart(rows) {
    const W = narrow() ? 340 : 680, H = narrow() ? 120 : 140, L = 32, R = 8, T = 8, B = 10;
    const max = Math.max(1, ...rows.map((r) => r.units));
    const bw = (W - L - R) / rows.length;
    const y = (v) => T + (H - T - B) * (1 - v / max);
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Units sold per day">${rows.map((r, i) => `<rect x="${L + i * bw + bw * 0.15}" y="${y(r.units)}" width="${bw * 0.7}" height="${Math.max(0, y(0) - y(r.units))}" rx="2" fill="#0978BE"><title>${dayLabel(r.day)}: ${r.units} sold</title></rect>`).join('')}
      <text x="${L - 6}" y="${y(max) + 4}" text-anchor="end">${max}</text><text x="${L - 6}" y="${y(0)}" text-anchor="end">0</text></svg>`;
  }

  /* ---------- views ----------
     Default view = the decision; detail on demand (Columns picker, More, the product drawer).
     User-facing statuses are three: Order today (out / critical / order now), This week, OK. */
  const TODAY = ['Out now', 'Critical', 'Order now'];
  const ALLOC = 'Top-up from warehouse';   // §6 (1.3.0): a website allocation, no reorder sized from it
  const group = (s) => (TODAY.includes(s) ? 'today' : s === 'Order this week' ? 'week' : s === 'Ordered' ? 'ordered' : s === 'OK' ? 'ok' : s === 'Slow seller' ? 'slow' : s === ALLOC ? 'warehouse' : 'none');
  const GROUP_LABEL = { today: 'Order today', week: 'This week', ordered: 'Ordered', ok: 'OK', slow: 'Slow seller', warehouse: ALLOC, none: 'No stock data' };
  const dateShort = (t) => { const d = local(t); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
  /* 1.1.5: the period's store-calendar dates, "22 Oct – 20 Nov" (one date when it is today only) */
  const periodDates = (r) => { const a = dateShort(r.from), b = dateShort(r.generatedAt); return a === b ? a : `${a} – ${b}`; };
  /* on order (LOGIC.md §6b): "Ordered · lands 25 Nov"; late or not enough → a small tag next to the status */
  const poTag = (p) => {
    const o = p.onOrder; if (!o || p.status === 'Ordered') return '';
    const tip = `Ordered ${inr.format(o.qty)}${o.remaining < o.qty ? ` (${inr.format(o.remaining)} still to come)` : ''} · ${o.late ? 'was due' : 'lands'} ${dateShort(o.eta)}`;
    if (o.late) return ` <span class="po late" title="${esc(tip)}. Past its date, so it no longer counts: chase the supplier or reorder.">Late · due ${dateShort(o.eta)}</span>`;
    return ` <span class="po" title="${esc(tip)}${o.counts ? '. The order quantity is what’s still needed on top.' : '. Lands after the shelf empties and later than a new order could, so it doesn’t count.'}">${inr.format(o.remaining)} on order</span>`;
  };
  const status = (p) => {
    const g = group(p.status);
    if (g === 'ordered') return `<span class="st g-ordered" title="${esc(`Ordered ${inr.format(p.onOrder.qty)} pcs${p.onOrder.by ? ` by ${p.onOrder.by}` : ''}; stock + order covers the need`)}">Ordered · lands ${dateShort(p.onOrder.eta)}</span>`;
    return `<span class="st g-${g}" title="${esc(p.status === 'Critical' ? 'Order today: 3 days or less left' : g === 'warehouse' ? 'Shopify shows a website allocation refilled from the warehouse: check the warehouse, no reorder is sized here' : p.status)}">${GROUP_LABEL[g]}</span>${poTag(p)}`;
  };
  const outDot = (p) => (p.stock != null && p.stock <= 0 ? '<span class="dot" title="Out of stock now"></span>' : '');
  const bestTag = (p) => (p.abc === 'A' ? '<span class="best" title="Best seller: among the products making the top 80% of sales">Best seller</span>' : '');
  /* 1.4.0: picture left, name + code stacked, Shopify / website links (public/prod.js, LOGIC §19) */
  const nameCell = (p, tag = true, sp = false) => SW_PROD.cell(p, { before: `${sp ? `<span class="ispark">${spark(p, 40, 12)}</span>` : ''}${outDot(p)}`, extra: tag ? bestTag(p) : '' });
  /* SW-021: trend in the decision rows. ≥ 1400 px: its own cell (48×16 spark + chip); narrower: a 40×12 spark at the
     start of the name cell (no extra column; at the start so a long name's … never hides it, and the sparks line up) */
  const trendCell = (p) => `<span class="trc">${spark(p, 48, 16)}${trendOnly(p)}</span>`;
  const mspark = (p) => ((p.weeks || []).some((w) => w.units > 0) ? `<span class="mspark">${spark(p, 48, 16)}</span>` : '');   // M9: no sales in 8 weeks = a row of rose dashes; the Why line says it

  /* columns picker: every column is on by default (show everything); untick to hide one, remembered on this browser.
     Optional columns that don't fit the screen step aside on their own (fitTables), last first, so the page never scrolls sideways. */
  const colsOff = (() => { try { return JSON.parse(localStorage.getItem('sw-cols-off') || '{}'); } catch { return {}; } })();
  const showCol = (id, c) => (!c.opt || !(colsOff[id] || []).includes(c.k)) && !window.SW_ROLES?.hidesCol(id, c.k);   // a role view can remove default columns (SW-020)
  function colPicker(id, cols) {
    const opt = cols.filter((c) => c.opt); if (!opt.length) return '';
    return `<details class="colpick desk"><summary class="btn ghost">Columns</summary><div class="menu">${opt.map((c) => `<label><input type="checkbox" data-col="${id}|${c.k}" ${showCol(id, c) ? 'checked' : ''}> ${esc(c.label)}</label>`).join('')}</div></details>`;
  }
  const dlMenu = (id, href, extra = '') => `<details class="colpick"><summary class="btn ghost" aria-label="More actions" title="More actions">⋯</summary><div class="menu">${extra}${href ? `<a href="${href}">Download CSV</a>` : `<button class="linkbtn" id="csv-${id}">Download CSV</button>`}</div></details>`;
  /* "Mark ordered" (LOGIC.md §6b): tick rows (one or many) → the bulk bar marks them at the suggested qty and today +
     lead time; edit qty/date or remove the mark in the product drawer. One control per row (critic round 1, S2). */
  const isoDay = (t) => local(t).toISOString().slice(0, 10);
  const myName = () => { try { return localStorage.getItem('sw-name') || ''; } catch { return ''; } };
  async function markOrdered(items, label) {
    await api('/api/onorder', { method: 'POST', body: JSON.stringify({ items, by: myName() }) });
    state.pick.clear(); await reloadReport();
    toast(label, { label: 'Undo', run: async () => { await api('/api/onorder', { method: 'POST', body: JSON.stringify({ items: items.map((i) => ({ id: i.id, clear: true })) }) }); await reloadReport(); toast('Order mark removed'); } });
  }

  function daysCell(p) {
    if (p.daysLeft == null) return p.stock != null && p.stock <= 0 ? '<span class="lostv">0</span>' : '–';
    const S = state.report.settings, warn = S.leadDays + S.safetyDays;
    const color = p.daysLeft <= 3 ? '#C8344F' : p.daysLeft <= warn ? '#C27416' : '#0978BE';
    return `<span class="days"><span class="num ${p.daysLeft <= 3 ? 'lostv' : ''}">${n1(p.daysLeft)}</span><span class="meter"><i style="width:${Math.min(100, (p.daysLeft / (warn + 7)) * 100)}%;background:${color}"></i></span></span>`;
  }
  /* SW-024: one plain sentence (LOGIC.md §15a), the same text the drawer and the digest use */
  /* short: the Reorder table leaves out the " · supplier takes N d" tail, the same on most rows and in Plan settings (critic UI-3); the tooltip keeps it */
  const whyCell = (p, short) => (p.why ? `<span class="why${p.stock != null && p.stock <= 0 ? ' out' : p.daysLeft != null && p.daysLeft <= 3 ? ' crit' : ''}" title="${esc(p.why)}">${esc(short ? p.why.replace(/ · supplier takes \d+ d( \(assumed\))?$/, '') : p.why)}</span>` : '–');
  const trendOnly = (p) => (p.trendPct == null && !p.trendNew ? '<span class="muted" title="Not enough sales yet to call a trend">–</span>' : trendChip(p));

  /* L3 (1.1.1): with no unit costs in Shopify every ₹ to order / overstock is at selling price, so never say "at cost" then */
  const atCost = () => (state.report.totals.hasCost ? 'at cost' : 'at selling price');
  /* F2 (1.1.1): Shopify pull prices are ex GST (net sales by order date); other sources: as sent */
  const soldTip = () => ((state.shopify || {}).priceBasis === 'exTax' ? 'Net sales: price paid after discounts, before GST, refunds netted on the order’s day (Shopify’s Net sales by order date)' : 'Price paid × units, as your data sends it');
  function summaryText() {
    const r = state.report, t = r.totals;
    const prods = new Set(r.stockouts.filter((s) => !s.notSelling).map((s) => s.id)).size;   // same count as the Stock-outs page (UI-2)
    return t.stockouts
      ? `${inPeriod(r).replace(/^./, (c) => c.toUpperCase())}, ${prods} products ran out of stock ${t.stockouts} times. That cost about ${moneyFull(t.lost)} in sales (${t.lostPct}% of demand)${t.hasCost ? ` and ${moneyFull(t.lostProfit)} in profit` : ''}${lostApart(t) ? `, plus ${lostApart(t)}` : ''}. ${t.orderToday} products need ordering today (${moneyFull(t.orderValueNow)} ${atCost()})${t.excessValue ? `, and ${moneyFull(t.excessValue)} sits in overstock` : ''}.`
      : `No product ran out of stock ${inPeriod(r)}.`;
  }

  /* LOGIC.md §4c: how sure ₹ lost is. The headline counts High and Medium; Low (few sales) and the part of a stock-out
     after 30 days with nothing marked ordered are shown apart, on one small line under it, each opening its rows */
  const CONF_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };
  /* 1.3.0 (G26): confidence from the share of Shopify's last 25 full weeks with a sale; units when the weekly sales aren't read or the product is new */
  const CONF_TIP = { high: 'Sold in 44%+ of the weeks (or 10+ units)', medium: 'Sold in 22–43% of the weeks (or 5–9 units)', low: 'Sold in under 22% of the weeks (or 4 or fewer units): its sales lost is an estimate, not in the headline' };
  const weeksText = (p) => (p && p.weeksLive ? `sold in ${p.weeksSold || 0} of ${p.weeksLive} weeks` : null);
  const confWhy = (p) => weeksText(p) || `${Math.max(p.rateUnits || 0, p.heldUnits || 0)} units sold`;
  const confCell = (p) => (p.confidence ? `<span class="conf c-${esc(p.confidence)}" title="${esc(`${CONF_TIP[p.confidence] || ''} (${confWhy(p)})`)}">${CONF_LABEL[p.confidence] || '–'}</span>` : '–');
  const nrDays = () => state.report.totals.notRestockedDays || 30;
  /* 1.3.0 (UI-2): a row's ₹ lost = the counted part in red; the parts not in the headline in grey under it, "+₹X est." */
  const apartParts = (p) => [[p.lostEstimate, 'est.', `Estimate: ${confWhy(p)}, so ${money(p.lostEstimate)} is not in the headline`],
    [p.lostNotRestocked, 'not restocked', `Not restocked: ${money(p.lostNotRestocked)} after day ${p.nrDays || nrDays()} of a stock-out with nothing marked ordered${p.floorPerDay != null ? ` (out since before our data; ${p.units26} sold in Shopify’s last 26 weeks)` : ''}, not in the headline`],
    [p.lostAllocation, 'refill gaps', `Refill gaps: ${money(p.lostAllocation)} while the website allocation waited for a top-up from the warehouse, not in the headline`]].filter(([v]) => v > 0);
  const lostMark = (p) => apartParts(p).map(([v, l, tip], i) => `<small class="lmark${l === 'est.' ? '' : ' nr'}" title="${esc(tip)}">${p.lostCounted > 0 || i ? '+' : ''}${money(v)} ${l}</small>`).join('');
  const lostRed = (p) => (p.lostCounted > 0 ? `<span class="lostv">${money(p.lostCounted)}</span>` : '');
  /* in a table cell the grey part sits under the ₹ (the column doesn't widen); Pause / Push are marketing lists, kept one line */
  const lostCell = (p) => (p.lost ? `${lostRed(p)}${['pause', 'push'].includes(state.filter.products) && p.lostCounted > 0 ? '' : lostMark(p)}` : '–');
  const lostSort = (p) => (p.lostCounted || 0) * 1e3 + (p.lost || 0) / 1e9;   // counted first, then the rest
  /* the line under a headline: what is NOT in its ₹ (UI-5), each part opening its rows */
  function lostSub(t, view) {
    const parts = [t.lostEstimate > 0 ? `<a href="#${view}" data-go="${view}" data-filter="estimate" title="Products sold in under 22% of Shopify’s last 25 weeks (or with 4 or fewer units sold): an estimate (LOGIC §4c)">${money(t.lostEstimate)} estimate from few sales</a>` : '',
      t.lostNotRestocked > 0 ? `<a href="#${view}" data-go="${view}" data-filter="notrestocked" title="Stock-outs open more than ${nrDays()} days with nothing marked ordered: only the sales lost after day ${nrDays()} (LOGIC §4c)">${money(t.lostNotRestocked)} after day ${nrDays()} on ${inr.format(t.lostNotRestockedProducts || 0)} items not restocked</a>` : '',
      t.lostAllocation > 0 ? `<a href="#products" data-go="products" data-filter="warehouse" title="Website allocations refilled from the warehouse: the shelf was empty until the top-up (LOGIC §6)">${money(t.lostAllocation)} lost in refill gaps on ${inr.format(t.lostAllocationProducts || 0)} allocation items</a>` : ''].filter(Boolean);
    return parts.length ? `<p class="lost-sub" id="lost-sub">Not in ${money(t.lost)}: ${parts.join(' · ')}</p>` : '';
  }
  const lostApart = (t) => [t.lostEstimate > 0 ? `${moneyFull(t.lostEstimate)} estimated from products with few sales` : '', t.lostNotRestocked > 0 ? `${moneyFull(t.lostNotRestocked)} after day ${t.notRestockedDays || 30} on ${t.lostNotRestockedProducts || 0} products not restocked` : '',
    t.lostAllocation > 0 ? `${moneyFull(t.lostAllocation)} in refill gaps on ${t.lostAllocationProducts || 0} website-allocation products` : ''].filter(Boolean).join(' and ');
  /* a filtered view of one part (UI-3) leads with that part's own ₹ */
  const BUCKET = { estimate: ['lostEstimate', 'estimated from few sales, not in the headline'], notrestocked: ['lostNotRestocked', () => `after day ${nrDays()} of stock-outs nobody restocked, not in the headline`], warehouse: ['lostAllocation', 'lost in refill gaps on website allocations, not in the headline'] };
  const bucketLine = (f, rows) => { const b = BUCKET[f]; if (!b) return ''; const v = rows.reduce((a, p) => a + (p[b[0]] || 0), 0); return `<p class="bucket" id="bucket-line"><b class="nw">${money(v)}</b> ${esc(typeof b[1] === 'function' ? b[1]() : b[1])} · ${inr.format(rows.length)} products</p>`; };

  /* one line under the Overview headline (SW-027, LOGIC.md §5a) */
  function ydayStrip(y) {
    if (!y) return '';
    return `<p class="yday" title="Yesterday (${esc(dayLabel(y.day))}), store time: sold, sales lost to stock-outs, products that ran out, products back in stock">Yesterday: <b>${money(y.sold)}</b> sold · ${y.lost ? `<span class="lostv">${money(y.lost)} lost</span>` : 'nothing lost'} · ${y.ranOut} ran out · ${y.back} back</p>`;
  }

  function overview() {
    const r = state.report, t = r.totals;
    const today = r.reorder.filter((p) => TODAY.includes(p.status));
    const week = r.reorder.filter((p) => p.status === 'Order this week').length, weekValue = Math.max(0, t.orderValueAll - t.orderValueNow);
    /* SIMP-5: a slow seller (not reordered) never sits in Biggest losses; its ₹ is one line that opens the Decide list */
    const lossy = r.products.filter((p) => p.lost > 0), slowLost = lossy.filter((p) => p.status === 'Slow seller');
    /* 1.3.0: by the counted part (what the headline adds up), the parts apart in grey on each row */
    const top = lossy.filter((p) => p.status !== 'Slow seller' && p.lostCounted > 0).sort((a, b) => b.lostCounted - a.lostCounted).slice(0, 5), maxLost = Math.max(1, ...top.map((p) => p.lostCounted));
    const slowCounted = slowLost.reduce((a, p) => a + (p.lostCounted || 0), 0);
    /* SIMP-2: the biggest orders first, ₹ shown (the panel is short; Reorder has the rest) */
    const big = today.slice().sort((a, b) => b.orderValue - a.orderValue).slice(0, 5);
    return `
      <section class="headline">
        <h1><span class="h-order">${t.hasCost ? `Order <span class="amberv">${money(t.orderValueNow)}</span> today` : `Order <span class="amberv">${inr.format(t.orderToday)} products</span> today <small class="hsub" title="No unit costs in Shopify: quantity × average price paid">${money(t.orderValueNow)} at selling price</small>`} · </span><span class="h-lost"><span class="lost">${money(t.lost)}</span> sales lost ${r.period === 'month' ? 'this month' : `in ${r.days} days`}</span></h1>
        ${window.SW_DIGEST ? SW_DIGEST.shareMenu() : '<button class="btn ghost hbtn" id="copy-summary" title="Copy a plain-language summary for the client">Copy summary</button>'}
        ${lostSub(t, 'products')}${ydayStrip(r.yesterday)}
      </section>
      <section class="tiles t4">
        ${t.hasCost
    ? `<button class="tile lost" data-go="stockouts" data-filter="all" title="Profit on the ${money(t.lost)} of sales lost while products were out of stock: units lost × (price paid − unit cost)${t.costed < t.active ? `. Only ${t.costed} of ${t.active} products have a cost, so it is a minimum` : ''}"><b>${money(t.lostProfit)}</b><span>profit lost · ${n1(t.lostPct)}% of demand${t.costed < t.active ? ` (${t.costed}/${t.active} costed)` : ''}</span></button>`
    : `<button class="tile lost" data-go="stockouts" data-filter="all" title="Sales lost ÷ (sold + sales lost)"><b>${n1(t.lostPct)}%</b><span>of demand lost · ${inr.format(t.stockouts)} stock-outs</span></button>`}
        <button class="tile amber" data-go="reorder" data-filter="week" title="${t.hasCost ? 'Cash to commit at cost (selling price where a product has none)' : 'Order value at selling price (no unit costs in Shopify)'} for what needs ordering this week, after today’s order"><b>${money(weekValue)}</b><span>more to order this week · ${week} products</span></button>
        <button class="tile ${t.bestAtRisk ? 'lost' : 'sold'}" data-go="products" data-filter="bestrisk" title="Best sellers (top 80% of sales) that need ordering today"><b>${t.bestAtRisk}<small> of ${t.bestsellers}</small></b><span>best sellers at risk</span></button>
        <button class="tile plum" data-go="products" data-filter="push" title="Stock beyond what lead time + days to last + buffer need, for overstocked products, ${atCost()}: discount, bundle, or stop reordering"><b>${money(t.excessValue)}</b><span>stuck in overstock · ${t.overstocked} products</span></button>
      </section>${t.hasCost ? '' : '<p class="muted small" id="nocost-note">No unit costs in Shopify, so ₹ to order and overstock are at selling price. Fill <b>Cost per item</b> in Shopify for cash at cost.</p>'}
      <section class="grid2 grid3">
        <div class="panel"><div class="panel-head"><h2>Order today</h2><a href="#reorder" data-go="reorder" data-filter="today">All ${t.orderToday}</a></div>
          ${big.length ? `<div class="bars">${big.map((p) => `<div class="bar-row" data-product="${esc(p.id)}" tabindex="0" role="button" style="grid-template-columns:minmax(0,1fr) auto auto auto"><span class="name">${outDot(p)}${esc(p.name)}</span><span class="muted num" title="Days of stock left">${p.stock <= 0 ? 'out' : `${n1(p.daysLeft)} d`}</span><span class="muted num">${inr.format(p.orderQty)} pcs</span><span class="num" style="font-weight:700" title="Order value ${atCost()}">${money(p.orderValue)}</span></div>`).join('')}</div>` : '<p class="muted">Nothing needs ordering today.</p>'}
        </div>
        <div class="panel"><div class="panel-head"><h2>Biggest losses</h2><a href="#products" data-go="products" data-filter="lost">All</a></div>
          ${top.length ? `<div class="bars">${top.map((p) => `<div class="bar-row" data-product="${esc(p.id)}" tabindex="0" role="button"><span class="name">${outDot(p)}${esc(p.name)}${lostMark(p)}</span><span class="val">${money(p.lostCounted)}</span><span class="track"><i style="width:${(p.lostCounted / maxLost) * 100}%"></i></span></div>`).join('')}</div>` : '<p class="muted">Nothing lost in this period.</p>'}
          ${slowLost.length ? `<p class="muted small" id="slow-lost"><a href="#products" data-go="products" data-filter="slow" title="Sell under ${esc(String(r.settings.minPerDay))} a day, so they aren’t on Reorder: keep or stop reordering each. Only the counted part of their sales lost is in the headline">${slowCounted > 0 ? `+${money(slowCounted)} counted on ${inr.format(slowLost.length)} slow sellers: decide` : `${inr.format(slowLost.length)} slow sellers ran out: decide`}</a></p>` : ''}
        </div>
        ${moving()}
      </section>
      <section class="panel chart" id="daily-chart">
        <div class="panel-head"><h2>Sold vs lost, per day</h2><div class="legend"><span title="${esc(soldTip())}"><i style="background:#0978BE"></i>Sold${(state.shopify || {}).priceBasis === 'exTax' ? ' ex GST' : ''} ${money(t.sold)}</span><span><i style="background:#C8344F"></i>Lost ${money(t.lost)}</span></div></div>
        ${dailyChart(r.daily)}
      </section>
      ${window.SW_WEEKLY ? SW_WEEKLY.panel() : ''}`;
  }

  /* Overview "Moving" (SW-021): top 3 up and down by ₹ effect = change in daily rate × avg price × 30 (LOGIC.md §7d) */
  function moving() {
    const ps = state.report.products.filter((p) => p.trendValue);
    const up = ps.filter((p) => p.trendValue > 0).sort((a, b) => b.trendValue - a.trendValue).slice(0, 3);
    const down = ps.filter((p) => p.trendValue < 0).sort((a, b) => a.trendValue - b.trendValue).slice(0, 3);
    const row = (p) => `<div class="mv-row" data-product="${esc(p.id)}" tabindex="0" role="button" title="${esc(p.name)}"><span class="name">${outDot(p)}${esc(p.name)}</span>${spark(p, 40, 12)}${trendOnly(p)}<span class="mv-v ${p.trendValue > 0 ? 'up' : 'down'}">${p.trendValue > 0 ? '+' : '−'}${money(Math.abs(p.trendValue))}</span></div>`;
    const list = (h, l) => (l.length ? `<h3 class="mv-h">${h}</h3>${l.map(row).join('')}` : '');
    return `<div class="panel"><div class="panel-head"><h2>Moving</h2><span class="muted small" title="Change in sales per in-stock day (last 14 days vs the 14 before) × average price × 30">₹ a month at the new pace</span></div>
      ${up.length || down.length ? `<div class="mv">${list('Selling faster', up)}${list('Selling slower', down)}</div>` : '<p class="muted">Not enough sales yet to call a trend.</p>'}</div>`;
  }

  /* Ordered tab = every open purchase order (part, late, landing too late too), late first: same rule as
     src/helpers.js onOrderRows / onOrderSummary (LOGIC.md §6b, §16) */
  const onOrderRows = (products) => products.filter((p) => p.onOrder).sort((a, b) => (b.onOrder.late - a.onOrder.late) || a.onOrder.eta - b.onOrder.eta);
  const landsCell = (p) => {
    const o = p.onOrder; if (!o) return '–';
    const extra = [o.remaining < o.qty ? `${inr.format(o.qty - o.remaining)} of ${inr.format(o.qty)} in` : '', o.late ? '' : !o.counts ? 'after it runs out' : '', p.orderQty > 0 ? `order ${inr.format(p.orderQty)} more` : ''].filter(Boolean).join(' · ');
    const txt = `${o.late ? `Late · was due ${dateShort(o.eta)}` : `Lands ${dateShort(o.eta)}`}${extra ? ` · ${extra}` : ''}`;
    return `<span class="why${o.late ? ' out' : ''}" title="${esc(`${txt}. Ordered ${inr.format(o.qty)} pcs${o.by ? ` by ${o.by}` : ''} on ${dateShort(o.at)}`)}">${esc(txt)}</span>`;
  };
  function reorder() {
    const r = state.report, t = r.totals, f = state.filter.reorder, q = state.q.reorder.toLowerCase();
    const week = r.reorder.filter((p) => p.status === 'Order this week').length;
    const open = onOrderRows(r.products), ordered = f === 'ordered';
    const groups = [['today', 'Order today', t.orderToday], ['week', 'This week', week], ...(open.length || ordered ? [['ordered', 'Ordered', open.length]] : []), ['all', 'All', r.reorder.length]];
    let rows = (ordered ? open : r.reorder.filter((p) => f === 'all' || group(p.status) === f)).filter((p) => !q || `${p.name} ${p.sku}`.toLowerCase().includes(q));
    if (window.SW_MONEY && !ordered) rows = SW_MONEY.rows(rows);   // SW-041: a budget ranks by profit kept per ₹ (money.js)
    const canPick = (p) => !viewOnly() && !p.onOrder && p.orderQty > 0;   // view-only sign-in can't mark ordered (SW-029)
    const pickable = rows.filter(canPick);
    const cols = ordered ? [
      { k: 'name', label: 'Product', f: (p) => nameCell(p, true, true) },
      { k: 'lands', label: 'Lands', tip: 'Expected landing date; late = past it with less than 90% received', f: landsCell, val: (p) => (p.onOrder.late ? -1e15 : 0) + p.onOrder.eta },
      { k: 'onOrder', label: 'On order (pcs)', r: 1, tip: 'Still to come: ordered minus what has arrived since the order was marked', f: (p) => `<b>${inr.format(p.onOrder.remaining)}</b>`, val: (p) => p.onOrder.remaining },
      { k: 'daysLeft', label: 'Days left', f: daysCell, val: (p) => p.daysLeft ?? -1 },
      { k: 'stock', label: 'In stock', r: 1, f: (p) => inr.format(p.stock) },
    ] : [
      { k: 'name', label: 'Product', f: (p) => (canPick(p) ? `<input type="checkbox" class="pick" data-pick="${esc(p.id)}" aria-label="Tick ${esc(p.name)}" ${state.pick.has(p.id) ? 'checked' : ''}>` : (viewOnly() ? '' : '<span class="pick-sp"></span>')) + nameCell(p, true, true) },
      ...(f === 'all' ? [{ k: 'status', label: 'Status', f: status, val: (p) => -['Out now', 'Critical', 'Order now', 'Order this week', 'Ordered'].indexOf(p.status) }] : []),   // SW-024: a tab of one status needs no Status column
      { k: 'why', label: 'Why', tip: 'Out: how long, and the sales lost in this stock-out so far (Sales lost = the whole period). Otherwise: when it runs out, the last day to order so it lands in time (lead time + buffer before), and the supplier lead time', f: (p) => whyCell(p, true), val: (p) => (p.stock <= 0 ? -1e15 + (p.outSince || 0) : p.orderBy ?? 1e15) },
      { k: 'orderQty', label: 'Order (pcs)', r: 1, f: (p) => `<b>${inr.format(p.orderQty)}</b>` },
      { k: 'orderValue', label: t.hasCost ? 'Order cost' : 'Order value', r: 1, tip: t.hasCost ? 'Order quantity × unit cost (× average price paid if cost is unknown)' : 'Order quantity × average price paid: no unit costs in Shopify, so this is at selling price, not cash out', f: (p) => money(p.orderValue) },
      ...(window.SW_MONEY ? SW_MONEY.cols() : []),   // SW-041
      { k: 'daysLeft', label: 'Days left', f: daysCell, val: (p) => p.daysLeft ?? -1 },
      { k: 'lost', label: 'Sales lost', r: 1, tip: `Sales lost to stock-outs ${inPeriod()}: red = in the headline; grey = not (estimate, not restocked)`, f: lostCell, val: lostSort },
      { k: 'stock', label: 'In stock', r: 1, opt: 1, f: (p) => inr.format(p.stock) },
      { k: 'perDay', label: 'Sells', r: 1, opt: 1, tip: 'How fast it sells while in stock (exact rate per in-stock day used in the maths)', f: (p) => `<span title="${n1(p.perDay)} per in-stock day">${rate(p.perDay)}</span>` },
      { k: 'trendPct', label: 'Trend', pr: 'w', tip: trendTip(), f: trendCell, val: (p) => p.trendPct ?? (p.trendNew ? 999 : -999) },
      { k: 'outs', label: 'Times out', r: 1, opt: 1 },
    ];
    const picked = [...state.pick].filter((id) => r.reorder.some((p) => p.id === id && canPick(p)));
    /* the Ordered tab's question is "what lands, what's late" (warehouse home), not "what to order" (critic SIMP-1, M6) */
    const late = open.filter((p) => p.onOrder.late).length, due = open.filter((p) => !p.onOrder.late), now = Date.now();
    const soon = due.filter((p) => p.onOrder.eta <= now + 7 * 864e5).length;
    const head = ordered
      ? `<h1>${open.length ? `${inr.format(open.length)} on order · ${inr.format(soon)} due this week${late ? ` · <span class="lost">${inr.format(late)} late</span>` : ''}` : 'Nothing on order'}</h1>
        ${due.length ? `<p class="exp">Next lands ${dateShort(due[0].onOrder.eta)}. Late = past its date with less than 90% received: chase the supplier.</p>` : ''}`
      : `<h1>${t.hasCost ? `Order <span class="amberv">${money(t.orderValueNow)}</span> today across ${t.orderToday} products` : `Order <span class="amberv">${inr.format(t.orderToday)} products</span> today <small class="hsub">${money(t.orderValueNow)} at selling price</small>`}${f === 'all' && week ? ` <span class="nw">· ${money(Math.max(0, t.orderValueAll - t.orderValueNow))} more this week (${week})</span>` : ''}</h1>
        <p class="exp">Each order covers lead time (${r.settings.leadDays} d, assumed until set per supplier) + days the stock should last + buffer, at the product’s in-stock sales rate. Biggest sales a day first.${t.hasCost ? '' : ' <span id="nocost-reorder">No unit costs in Shopify: ₹ are at selling price.</span>'}</p>
        ${t.allocation ? `<p class="exp" id="alloc-note"><a href="#products" data-go="products" data-filter="warehouse">${inr.format(t.allocation)} ${t.allocation === 1 ? 'product is' : 'products are'} a website allocation refilled from the warehouse</a>: not on this list, because warehouse stock isn’t in Shopify. Check the warehouse.</p>` : ''}`;
    return `
      <section class="headline">${head}</section>
      ${planBar()}
      <div class="toolbar"><div class="chips">${groups.map(([k, l, c]) => `<button class="chip ${f === k ? 'on' : ''}" data-filter-reorder="${k}">${l}<span class="c">${c}</span></button>`).join('')}</div>
        <input class="search" id="q-reorder" placeholder="Search…" title="Search product or SKU" value="${esc(state.q.reorder)}">${colPicker('reorder', cols)}${window.SW_MONEY && !ordered ? SW_MONEY.toggle() : ''}${dlMenu('reorder', storeUrl(`/api/export/reorder.csv?days=${state.days}${whatQs()}&filter=${f}&q=${encodeURIComponent(state.q.reorder)}${window.SW_MONEY && !ordered ? SW_MONEY.qs() : ''}`), pickable.length ? `<button class="linkbtn" id="pick-all">Tick all ${pickable.length} in view</button>` : '')}</div>
      ${window.SW_MONEY && !ordered ? SW_MONEY.bar(rows) : ''}
      ${picked.length ? `<div class="bulk" role="region" aria-label="Ticked rows"><b>${picked.length} ticked</b><span class="muted">${money(picked.reduce((a, id) => a + (r.reorder.find((p) => p.id === id)?.orderValue || 0), 0))} at the suggested quantities · lands ${dateShort(Date.now() + r.settings.leadDays * 864e5)}</span><button class="btn" id="pick-mark">Mark ${picked.length} ordered</button><button class="btn ghost" id="pick-clear">Clear</button></div>` : ''}
      ${window.SW_MONEY && !ordered && SW_MONEY.bySupplier() ? SW_MONEY.poView(rows) : table('reorder', cols.filter((c) => showCol('reorder', c)), rows, ordered ? 'Nothing on order. Marked orders show here until they land.' : 'Nothing to order in this view.', (p) => (ordered ? `
        <header><h3>${nameCell(p, false)}</h3><div class="mq"><b>${inr.format(p.onOrder.remaining)} pcs</b><small>on order</small></div></header>
        <div class="mfacts">${landsCell(p)}${bestTag(p)}</div>` : `
        <header>${canPick(p) ? `<label class="mpick"><input type="checkbox" class="pick" data-pick="${esc(p.id)}" aria-label="Tick ${esc(p.name)}" ${state.pick.has(p.id) ? 'checked' : ''}></label>` : ''}<h3>${nameCell(p, false)}</h3>${mspark(p)}<div class="mq"><b>${inr.format(p.orderQty)} pcs</b><small class="mv">${money(p.orderValue)}</small></div></header>
        <div class="mfacts">${f === 'all' ? status(p) : poTag(p).trim()}${whyCell(p)}${bestTag(p)}</div>`))}`;
  }

  /* stock-outs, one row per product (the individual stock-outs are in the product drawer) */
  /* out but not selling (SW-063): no sales and no sales lost in the period, so nothing was lost; counted apart, not in the headline */
  function outsByProduct() {
    const m = new Map(), prod = new Map(state.report.products.map((p) => [p.id, p]));
    const dead = (id) => { const p = prod.get(id); return !!p && !p.unitsSold && !p.sold && !p.lost; };
    for (const s of state.report.stockouts) {
      const pr = prod.get(s.id) || {};
      const a = m.get(s.id) || { id: s.id, name: s.name, sku: s.sku, image: pr.image, adminUrl: pr.adminUrl, webUrl: pr.webUrl, stock: pr.stock, abc: pr.abc, times: 0, days: 0, lost: 0, open: false, small: 0, repeat: 0, last: 0, dead: dead(s.id), since: null,
        confidence: pr.confidence, rateUnits: pr.rateUnits, heldUnits: pr.heldUnits, weeksSold: pr.weeksSold, weeksLive: pr.weeksLive, nrDays: pr.nrDays, floorPerDay: pr.floorPerDay, units26: pr.units26, historyFrom: pr.historyFrom,
        lostCounted: pr.lostCounted || 0, lostEstimate: pr.lostEstimate || 0, lostNotRestocked: pr.lostNotRestocked || 0, lostAllocation: pr.lostAllocation || 0 };   // §4c
      a.times++; a.days += (s.hoursInPeriod ?? s.hours) / 24; a.lost += s.lost; a.open = a.open || s.open; a.small += s.small ? 1 : 0; a.repeat += s.repeat ? 1 : 0; a.last = Math.max(a.last, s.start);
      if (s.open) a.since = s.start;   // UI-6: an open stock-out shows when it began, not days inside the period
      m.set(s.id, a);
    }
    return [...m.values()].sort((a, b) => b.lostCounted - a.lostCounted || b.lost - a.lost);   // 1.3.0: the headline's part first
  }
  function stockouts() {
    const r = state.report, t = r.totals, f = state.filter.stockouts, q = state.q.stockouts.toLowerCase();
    const every = outsByProduct(), all = every.filter((a) => !a.dead), dead = every.filter((a) => a.dead);
    const stillOut = all.filter((a) => a.open).length, times = all.reduce((n, a) => n + a.times, 0);
    const est = all.filter((a) => a.lostEstimate > 0).length, nr = all.filter((a) => a.lostNotRestocked > 0).length;
    /* UI-6: "out since 11 Oct" for an open stock-out (before our data: "since before 21 Sep"), days in the period otherwise */
    const outSince = (a) => (a.open && a.since ? `since ${a.historyFrom != null && a.since <= a.historyFrom ? 'before ' : ''}${dateShort(a.since)}` : null);
    const groups = [['all', 'All', all.length], ['open', 'Still out', stillOut], ['small', 'Refilled too little', all.filter((a) => a.small).length], ['again', 'Ran out again', all.filter((a) => a.repeat).length],
      ...(est || f === 'estimate' ? [['estimate', 'Estimates (few sales)', est]] : []), ...(nr || f === 'notrestocked' ? [['notrestocked', 'Not restocked 30+ d', nr]] : []), ...(dead.length ? [['dead', 'Out but not selling', dead.length]] : [])];
    const rows = (f === 'dead' ? dead : all).filter((a) => (f === 'all' || f === 'dead' || (f === 'open' ? a.open : f === 'small' ? a.small : f === 'estimate' ? a.lostEstimate > 0 : f === 'notrestocked' ? a.lostNotRestocked > 0 : a.repeat)) && (!q || `${a.name} ${a.sku}`.toLowerCase().includes(q)));
    const h = (state.shopify || {}).history;
    const extra = `${dead.length ? `<p class="muted small" id="dead-note" title="No sales and no sales lost ${inPeriod()}: nothing was lost while they were out">${dead.length} out but not selling, not counted above</p>` : ''}${h && h.ok && h.kept && r.from < h.until ? `<p class="muted small" id="rebuilt-note" title="Shopify keeps no past stock levels; these come from its stock change log, to the hour (LOGIC §1c). The others have no stock record before then, so their sales lost before it are unknown (Data lists them)">Before ${esc(dt(h.until).slice(0, 6))}: rebuilt from Shopify’s change log for ${inr.format(h.kept)} of ${inr.format(h.total)} products</p>` : ''}`;
    const pattern = (a) => [a.small ? `<span class="st small" title="Refilled with less than ${state.report.settings.smallTopUpDays} days of sales, ${a.small}×">Refilled too little</span>` : '', a.repeat ? `<span class="st again" title="Ran out again within a week, ${a.repeat}×">Ran out again</span>` : ''].join(' ') || '–';
    const cols = [
      { k: 'name', label: 'Product', f: (a) => nameCell(a) },
      { k: 'lost', label: 'Sales lost', r: 1, tip: 'Red = in the headline; grey = not (estimate, not restocked, refill gaps)', f: (a) => `${a.lostCounted > 0 ? `<b class="lostv">${money(a.lostCounted)}</b>` : ''}${lostMark(a)}`, val: lostSort },
      { k: 'confidence', label: 'Confidence', opt: 1, tip: 'How sure the sales lost is: share of Shopify’s last 25 weeks with a sale (High 44%+, Medium 22–43%, Low under 22%); units sold when that isn’t read', f: confCell, val: (a) => ({ high: 3, medium: 2, low: 1 })[a.confidence] || 0 },
      { k: 'times', label: 'Times out', r: 1 },
      { k: 'days', label: 'Days out', r: 1, tip: `Days out of stock ${inPeriod()}; still out: the date it ran out`, f: (a) => (outSince(a) ? `<span title="${n1(a.days)} days out ${esc(inPeriod())}">${esc(outSince(a))}</span>` : n1(a.days)) },
      { k: 'open', label: 'Now', f: (a) => (a.open ? '<span class="st g-today">Still out</span>' : '<span class="muted">Back in stock</span>'), val: (a) => (a.open ? 1 : 0) },
      { k: 'pattern', label: 'Pattern', f: pattern, val: (a) => a.small + a.repeat },
    ];
    return `
      <section class="headline">${stillOut && t.stillOutPerDay
        ? `<h1>${stillOut} still out, costing <span class="lost">${money(t.stillOutPerDay)}/day</span></h1><p>${t.stillOutPerDayApart > 0 ? `<span class="muted" id="still-apart" title="Out-of-stock items the headline doesn’t count: estimates from few sales, items not restocked, website allocations (LOGIC §15a)">+${money(t.stillOutPerDayApart)}/day not counted</span> · ` : ''}${all.length} products ran out ${times} times · <span class="lostv">${money(t.lost)}</span> sales lost${t.hasCost ? ` · <span class="nw">${money(t.lostProfit)} profit lost</span>` : ''}</p>`   // M10 + final r2 SIMP-B: the action leads, phone and desktop; L3 (1.3.0): counted part, the rest apart
        : `<h1>${all.length} products ran out ${times} times · <span class="lost">${money(t.lost)}</span> sales lost${t.hasCost ? ` · ${money(t.lostProfit)} profit lost` : ''}</h1>`}${BUCKET[f] ? bucketLine(f, rows) : lostSub(t, 'stockouts')}${extra}
        <details class="how exp"><summary>How we estimate this</summary><p>Hours out of stock, weighted by when this store usually sells, × the product’s normal sales per hour × the average price paid. Open a product for each stock-out. The headline counts products that sold in at least 22% of Shopify’s last 25 weeks (or, without that, 5 or more units); the rest is an estimate. A stock-out open ${nrDays()}+ days with nothing marked ordered counts only its first ${nrDays()} days, and website allocations’ refill gaps are apart. All are on the small line under the headline.</p></details></section>
      <div class="toolbar"><div class="chips">${groups.map(([k, l, c]) => `<button class="chip ${f === k ? 'on' : ''}" data-filter-stockouts="${k}">${l}<span class="c">${c}</span></button>`).join('')}</div>
        <input class="search" id="q-stockouts" placeholder="Search…" title="Search product or SKU" value="${esc(state.q.stockouts)}"></div>
      ${table('stockouts', cols, rows, 'No stock-outs in this view.', (a) => `
        <header><h3>${nameCell(a, false)}</h3><div class="mq">${a.lostCounted > 0 ? `<b class="lostv">${money(a.lostCounted)}</b>` : '<b class="muted">–</b>'}<small>sales lost</small>${lostMark(a)}</div></header>
        <div class="mfacts">${a.open ? '<span class="st g-today">Still out</span>' : ''}<span><b>${a.times}</b>× out</span>${outSince(a) ? `<span>out <b>${esc(outSince(a))}</b></span>` : `<span><b>${n1(a.days)}</b> days out</span>`}${a.small ? '<span class="st small">Refilled too little</span>' : ''}${a.repeat ? '<span class="st again">Ran out again</span>' : ''}</div>`)}`;
  }

  /* Products */
  /* SW-026: Pause / Push for marketing replace the Overstock chip (Push = the overstock list by ₹ stuck).
     Critic r2 S1: no duplicates. Overstock was the same rows as Push these, and Slow sellers the same as Slow sellers to
     decide, so More… holds one of each: Push these is the overstock list, Slow sellers carries the Decide column. */
  const PRODUCT_TABS = [['all', 'All'], ['bestrisk', 'Best sellers at risk'], ['today', 'Order today'], ['pause', 'Pause promotion'], ['push', 'Push these'], ['lost', 'Losing sales']];
  /* SW-064: "High returns" (15%+ of units ordered came back, 5+ ordered) only when some product qualifies */
  const HIGH_RETURN = 15;
  const productTabs = (f) => (state.report.totals.highReturns || f === 'returns' ? [...PRODUCT_TABS, ['returns', 'High cancels/refunds']] : PRODUCT_TABS);
  /* §4c: "Estimates (few sales)" and "Not restocked 30+ d" in More… (the chip row stays one line at 1440 px), only when some
     product has that part or it is the open filter; the line under the headline opens them in one click */
  const productMore = (f) => { const t = state.report.totals; return [...PRODUCT_MORE, ...(t.lostEstimateProducts || f === 'estimate' ? [['estimate', 'Estimates (few sales)']] : []), ...(t.lostNotRestockedProducts || f === 'notrestocked' ? [['notrestocked', 'Not restocked 30+ d']] : []), ...(t.allocation || f === 'warehouse' ? [['warehouse', ALLOC]] : [])]; };   // §6 (1.3.0)
  const RETURNS_TIP = 'Units cancelled or refunded on the days in the period (whenever the order was placed) ÷ units ordered in the period, as Shopify’s reports count them (quantity returned ÷ quantity ordered). Not only physical returns. – under 5 units ordered; ₹ ex GST';
  const returnsCell = (p) => (p.returnPct == null ? '–' : `<span class="${p.returnPct >= HIGH_RETURN ? 'amberv' : ''}" title="${inr.format(p.unitsReturned)} units cancelled or refunded in the period, ${inr.format(p.unitsOrdered)} ordered${p.unitsCancelled ? ` (${inr.format(p.unitsCancelled)} cancelled)` : ''} · ${esc(money(p.refundValue))} cancelled/refunded">${n1(p.returnPct)}%</span>`);
  const PRODUCT_MORE = [['best', 'Best sellers'], ['week', 'Order this week'], ['ok', 'OK'], ['slow', 'Slow sellers to decide'], ['rising', 'Selling faster'], ['falling', 'Selling slower']];
  const PRODUCT_ALIAS = { over: 'push', decide: 'slow' };   // old links and saved filters
  const pFilter = () => (state.filter.products = PRODUCT_ALIAS[state.filter.products] || state.filter.products);
  const MKT_TIP = { pause: 'Out of stock now, or fewer days left than the supplier lead time: pause ads and promotions until it’s back', push: 'Overstocked, most cash stuck first: promote, bundle or discount' };
  const decideOf = () => (decideOf.r === state.report ? decideOf.m : (decideOf.r = state.report, decideOf.m = new Map((state.report.decide || []).map((x) => [x.id, x]))));
  const productMatch = (p, f) => f === 'all' || (f === 'pause' || f === 'push' ? p.mkt === f : f === 'slow' ? decideOf().has(p.id) : f === 'lost' ? p.lost > 0 : f === 'estimate' ? p.lostEstimate > 0 : f === 'notrestocked' ? p.lostNotRestocked > 0 : f === 'returns' ? p.returnPct >= HIGH_RETURN : f === 'best' ? p.abc === 'A' : f === 'bestrisk' ? p.abc === 'A' && TODAY.includes(p.status)
    : f === 'rising' ? p.trendCall === 'up' || p.trendNew : f === 'falling' ? p.trendCall === 'down' : group(p.status) === f);
  function productRows() {
    const r = state.report, q = state.q.products.toLowerCase(), f = pFilter(), gr = state.group;
    const dm = f === 'slow' ? decideOf() : null;
    const lm = window.SW_LISTS ? SW_LISTS.match(state.q.products, r.products) : null;   // SW-044: a pasted list
    const list = r.products.filter((p) => (dm ? dm.has(p.id) : productMatch(p, f)) && (!gr || gr.ids.has(p.id)) && (lm ? lm.ids.has(p.id) : !q || `${p.name} ${p.sku} ${p.type}`.toLowerCase().includes(q)));
    if (f === 'pause' || f === 'push') return mktSort(list, f);
    if (dm) return list.sort((a, b) => dm.get(b.id).value - dm.get(a.id).value);
    return list;
  }
  /* same order as src/helpers.js mktSort (LOGIC.md §15c) */
  const mktSort = (rows, kind) => rows.slice().sort(kind === 'push' ? (a, b) => (b.excessValue || 0) - (a.excessValue || 0)
    : (a, b) => (a.stock <= 0 ? -1 : a.daysLeft ?? 1e9) - (b.stock <= 0 ? -1 : b.daysLeft ?? 1e9) || b.perDay * b.price - a.perDay * a.price);
  /* SW-032: the decision cell and its buttons */
  const DECIDE_LABEL = { drop: 'Don’t reorder?', clear: 'Clear' };
  const decideCell = (p) => { const x = decideOf().get(p.id); if (!x) return '–'; return `<span class="dec ${x.kind}" title="${x.kind === 'drop' ? 'Sells slowly and is out of stock: sales lost in the period' : 'Sells slowly and has stock: stock × unit cost (price when no cost)'}">${DECIDE_LABEL[x.kind]}${x.value ? ` <b>${money(x.value)}</b>${x.kind === 'drop' ? ' lost' : ` ${atCost()}`}` : ''}</span>`; };
  const decideBtns = (p) => { const x = decideOf().get(p.id); if (!x || viewOnly()) return ''; return `<span class="decb">${['keep', x.kind === 'drop' ? 'drop' : 'clear', ...(x.kind === 'clear' ? ['drop'] : [])].map((d) => `<button class="btn ghost xs" data-decide="${esc(p.id)}|${d}" title="${esc(DECIDE_TIP[d])}">${d[0].toUpperCase() + d.slice(1)}</button>`).join('')}</span>`; };
  const DECIDE_TIP = { keep: 'Keep selling and reordering as now', drop: 'Stop reordering it', clear: 'Sell off the stock (discount, bundle)' };
  /* SW-026: the Pause / Push action bar: counts, copy SKUs, CSV */
  function mktBar(rows, f) {
    if (f !== 'pause' && f !== 'push') return '';
    const n = f === 'pause' ? `${inr.format(rows.filter((p) => p.orderQty > 0).length)} to reorder · ${inr.format(rows.filter((p) => p.status === 'Slow seller').length)} slow` : `${money(rows.reduce((a, p) => a + (p.excessValue || 0), 0))} stuck`;
    return `<div class="mktbar"><span title="${esc(MKT_TIP[f])}">${n}</span>${rows.length ? `<button class="btn ghost xs" id="copy-skus">Copy ${inr.format(rows.length)} SKUs</button>` : ''}</div>`;   // the list's CSV is in ⋯ (M5)
  }
  function downloadMktCsv(f) {
    const head = [...(f === 'pause' ? ['Product', 'SKU', 'Variant ID', 'Why', 'Back in stock', 'In stock', 'Days left'] : ['Product', 'SKU', 'Variant ID', 'Overstock ₹', 'In stock', 'Days left']), ...SW_PROD.CSV_HEAD];
    const body = productRows().map((p) => [...(f === 'pause' ? [p.name, p.sku, p.id, p.why, p.backIn, p.stock, p.daysLeft ?? ''] : [p.name, p.sku, p.id, p.excessValue, p.stock, p.daysLeft ?? '']), ...SW_PROD.csv(p)]);
    saveCsv(`${f === 'pause' ? 'pause-promotion' : 'push-these'}-${isoToday()}.csv`, [head, ...body]);
  }
  const isoToday = () => local(Date.now()).toISOString().slice(0, 10);
  function saveCsv(name, lines) {
    const q = (x) => { const v = String(x ?? ''); return `"${(typeof x === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`; };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + lines.map((l) => l.map(q).join(',')).join('\n')], { type: 'text/csv' }));
    a.download = name; a.click(); URL.revokeObjectURL(a.href);
  }
  const PRODUCT_COLS = () => [
    { k: 'name', label: 'Product', f: (p) => nameCell(p, true, true), csv: (p) => p.name },
    { k: 'sku', label: 'SKU', hide: 1 },
    { k: 'abc', label: 'Rank (A = best seller)', hide: 1 },
    { k: 'status', label: 'Status', f: status, val: (p) => -['Out now', 'Critical', 'Order now', 'Order this week', ALLOC, 'OK', 'Slow seller', 'No stock data'].indexOf(p.status), csv: (p) => GROUP_LABEL[group(p.status)] },
    { k: 'stock', label: 'In stock', r: 1, f: (p) => (p.stock == null ? '–' : inr.format(p.stock)) },
    { k: 'daysLeft', label: 'Days left', f: daysCell, val: (p) => p.daysLeft ?? -1, csv: (p) => p.daysLeft ?? '' },
    { k: 'sold', label: 'Sold', r: 1, tip: `₹ sold ${inPeriod()}. ${soldTip()}`, f: (p) => money(p.sold) },
    { k: 'lost', label: 'Sales lost', r: 1, tip: `Sales lost to stock-outs ${inPeriod()}. Red = in the headline. Grey = not: “est.” few sales behind the rate; “not restocked” after day ${nrDays()} with nothing ordered; “refill gaps” website allocations`, f: lostCell, val: lostSort, csv: (p) => p.lost },
    { k: 'lostCounted', label: 'Sales lost in headline', hide: 1 },
    { k: 'orderQty', label: 'Order', r: 1, tip: 'Units to order (only when an order is due)', f: (p) => (p.orderQty ? `<b>${inr.format(p.orderQty)}</b>` : '–') },
    { k: 'type', label: 'Category', opt: 1, f: (p) => `<span class="muted cat" title="${esc(p.type)}">${esc(p.type || '–')}</span>` },
    { k: 'trendPct', label: 'Trend', pr: 'w', tip: trendTip(), f: trendCell, val: (p) => (p.trendPct ?? (p.trendNew ? 999 : -999)), csv: (p) => p.trendPct ?? '' },
    { k: 'perDay', label: 'Sells', r: 1, opt: 1, tip: 'How fast it sells while in stock (exact rate per in-stock day used in the maths)', f: (p) => `<span title="${n1(p.perDay)} per in-stock day">${rate(p.perDay)}</span>` },
    ...(state.report.totals.unitsOrdered ? [{ k: 'returnPct', label: 'Cancel/refund %', r: 1, opt: 1, tip: RETURNS_TIP, f: returnsCell, val: (p) => p.returnPct ?? -1, csv: (p) => p.returnPct ?? '' }] : []),   // SW-064: only when lines carry units ordered
    { k: 'unitsSold', label: 'Units sold', r: 1, opt: 1, f: (p) => inr.format(p.unitsSold || 0) },
    { k: 'lostPct', label: 'Share of demand lost', r: 1, opt: 1, tip: 'Sales lost ÷ (sold + lost)', f: (p) => (p.lostPct ? `${n1(p.lostPct)}%` : '–') },
    { k: 'outs', label: 'Times out', r: 1, opt: 1 },
    { k: 'excessValue', label: 'Overstock ₹', r: 1, opt: 1, tip: `Stock beyond what lead time + days to last + buffer need, ${atCost()}${state.report.totals.hasCost ? ' (selling price where a product has none)' : ''}`, f: (p) => (p.excessValue ? `<span class="${p.overstock ? 'plumv' : 'muted'}">${money(p.excessValue)}</span>` : '–') },
    { k: 'confidence', label: 'Confidence', opt: 1, tip: 'How sure Sales lost is: units sold behind the sales rate (High 10+, Medium 5–9, Low 4 or fewer, an estimate)', f: confCell, val: (p) => ({ high: 3, medium: 2, low: 1 })[p.confidence] || 0, csv: (p) => CONF_LABEL[p.confidence] || '' },
    ...(state.report.totals.hasCost ? [
      { k: 'lostProfit', label: 'Profit lost', r: 1, opt: 1, tip: 'Units lost × (price paid − unit cost)', f: (p) => (p.lostProfit ? `<span class="lostv">${money(p.lostProfit)}</span>` : '–') },
      { k: 'margin', label: 'Margin', r: 1, opt: 1, tip: '(price paid − unit cost) ÷ price paid', f: (p) => (p.margin == null ? '–' : `${n1(p.margin)}%`) },
      { k: 'cost', label: 'Unit cost', hide: 1 },
    ] : []),
    { k: 'price', label: 'Avg price', hide: 1 },
  ];
  const countIn = (list, k) => inr.format(list.filter((p) => productMatch(p, k)).length);
  function products() {
    if (state.lens) return groupView();
    const r = state.report, f = pFilter(), gr = state.group;
    const rows = productRows();
    const inType = r.products.filter((p) => !gr || gr.ids.has(p.id));
    /* §4c: the same definition as the Overview: lost = the headline part; estimates and not restocked on the small line */
    const tot = rows.reduce((a, p) => ({ sold: a.sold + p.sold, lost: a.lost + (p.lostCounted ?? p.lost), lostEstimate: a.lostEstimate + (p.lostEstimate || 0), lostNotRestocked: a.lostNotRestocked + (p.lostNotRestocked || 0), lostAllocation: a.lostAllocation + (p.lostAllocation || 0),
      lostNotRestockedProducts: a.lostNotRestockedProducts + (p.lostNotRestocked > 0 ? 1 : 0), lostAllocationProducts: a.lostAllocationProducts + (p.lostAllocation > 0 ? 1 : 0), stock: a.stock + (p.stock > 0 ? p.stock : 0) }),
    { sold: 0, lost: 0, lostEstimate: 0, lostNotRestocked: 0, lostAllocation: 0, lostNotRestockedProducts: 0, lostAllocationProducts: 0, stock: 0 });
    tot.notRestockedDays = nrDays();
    let cols = PRODUCT_COLS().filter((c) => !c.hide);
    /* Pause: "Back in stock" in place of Order; Push: Overstock ₹ in place of Order; Decide: the decision in place of Status and Order */
    if (f === 'pause') cols = cols.map((c) => (c.k === 'orderQty' ? { k: 'backIn', label: 'Back in stock', nw: 1, tip: 'The marked order’s date, or the earliest an order placed today could land', f: (p) => `<span class="muted">${esc(p.backIn || '–')}</span>` } : c));
    if (f === 'push') cols = cols.map((c) => (c.k === 'orderQty' ? { ...PRODUCT_COLS().find((x) => x.k === 'excessValue'), opt: 0 } : c)).filter((c, i, a) => c.k !== 'excessValue' || a.findIndex((x) => x.k === 'excessValue') === i);
    if (f === 'slow') cols = cols.filter((c) => !['status', 'orderQty', 'daysLeft'].includes(c.k)).concat([{ k: 'decide', label: 'Decide', f: decideCell, val: (p) => decideOf().get(p.id)?.value || 0 }, ...(viewOnly() ? [] : [{ k: 'act', label: '', f: decideBtns }])]);
    const moreOn = productMore(f).some(([k]) => k === f);
    /* final r2 M5: phone cards sorted by ₹ lost (every tab but Pause / Push / Slow) put ₹ lost top-right, status in the facts */
    const so = state.sort.products, lossSort = !['pause', 'push', 'slow'].includes(f) && (!so || so.k === 'lost');
    return `
      <section class="headline"><h1>${f === 'pause' ? `Pause promotion on ${inr.format(rows.length)} products` : f === 'push' ? `Push ${inr.format(rows.length)} overstocked products` : 'Products'}</h1>${BUCKET[f] ? `${bucketLine(f, rows)}<p>${inr.format(rows.length)} shown · <span class="nw">${money(tot.sold)} sold</span> · ${inr.format(tot.stock)} pcs in stock</p>` : `<p>${inr.format(rows.length)} shown · <span class="nw">${money(tot.sold)} sold</span> · <span class="lostv">${money(tot.lost)} lost</span> · ${inr.format(tot.stock)} pcs in stock</p>${lostSub(tot, 'products')}`}
        <span class="hfind">${viewSelect()}<input class="search" id="q-products" placeholder="Search or paste a list…" title="Search name, SKU or category, or paste a list of SKUs / names / variant IDs" value="${esc(state.q.products)}">${window.SW_LISTS ? SW_LISTS.pick(state.q.products, { canEdit: !viewOnly(), rerender: () => { if (state.view === 'products') render(); } }) : ''}</span></section>
      <div class="toolbar"><div class="chips">${groupChip()}${productTabs(f).map(([k, l]) => `<button class="chip ${f === k ? 'on' : ''}" data-filter-products="${k}"${MKT_TIP[k] ? ` title="${esc(MKT_TIP[k])}"` : ''}>${l}<span class="c">${countIn(inType, k)}</span></button>`).join('')}
        <select class="chip sel ${moreOn ? 'on' : ''}" id="f-more" aria-label="More filters"><option value="">More…</option>${productMore(f).map(([k, l]) => `<option value="${k}" ${f === k ? 'selected' : ''}>${l} (${countIn(inType, k)})</option>`).join('')}</select></div>
        ${mktBar(rows, f)}${colPicker('products', cols)}${dlMenu('products', null, (f === 'pause' || f === 'push') && rows.length ? `<button class="linkbtn" id="csv-mkt">Download this list (CSV)</button>` : '')}</div>
      ${window.SW_LISTS ? SW_LISTS.bar(state.q.products, r.products) : ''}
      ${table('products', cols.filter((c) => showCol('products', c)), rows, 'No products match.', (p) => `
        <header><h3>${nameCell(p, false)}</h3>${mspark(p)}${f === 'pause' ? `<span class="st g-week bk">${esc(p.backIn || '–')}</span>` : lossSort ? `<div class="mq"><b class="${p.lostCounted ? 'lostv' : 'muted'}">${p.lostCounted ? money(p.lostCounted) : '–'}</b><small>sales lost</small>${lostMark(p)}</div>` : status(p)}</header>
        <div class="mfacts">${lossSort ? status(p) : ''}<span class="${p.stock != null && p.stock <= 0 ? 'bad' : ''}"><b>${p.stock == null ? '–' : inr.format(p.stock)}</b> in stock</span><span><b>${p.daysLeft == null ? '–' : n1(p.daysLeft)}</b> days left</span><span><b>${money(p.sold)}</b> sold</span>${p.lost && !lossSort ? `${p.lostCounted ? `<span class="lostv">${money(p.lostCounted)} lost</span>` : ''}${lostMark(p)}` : ''}${p.orderQty ? `<span>order <b>${inr.format(p.orderQty)}</b></span>` : ''}${p.returnPct >= HIGH_RETURN ? `<span class="amberv">${n1(p.returnPct)}% cancelled/refunded</span>` : ''}${bestTag(p)}</div>${f === 'slow' ? `<div class="mfacts">${decideCell(p)}${decideBtns(p)}</div>` : ''}`)}
      ${f === 'slow' ? decidedNote() : ''}`;
  }
  /* SW-032: decided items are hidden until their sales change by more than half; listed here so a decision can be undone */
  function decidedNote() {
    const d = state.report.decided || []; if (!d.length) return '';
    const byId = new Map(state.report.products.map((p) => [p.id, p]));
    return `<details class="panel fold decided"><summary><b>${d.length} decided</b> <span class="muted">hidden until their sales change by more than half</span></summary>
      <div class="bars">${d.map((x) => `<div class="bar-row" style="grid-template-columns:minmax(0,1fr) auto auto"><span class="name">${esc(byId.get(x.id)?.name || x.id)}</span><span class="muted">${esc(x.decision[0].toUpperCase() + x.decision.slice(1))}</span>${viewOnly() ? '' : `<button class="btn ghost xs" data-decide="${esc(x.id)}|">Undo</button>`}</div>`).join('')}</div></details>`;
  }
  /* Group by (SW-022): "View: Products ▾" rolls the rows up by parent product, category, collection or tag
     (src/groups.js, LOGIC.md §9a). A group row opens Products filtered to it, with a removable chip. */
  const LENS = [['', 'Products'], ['product', 'Parent products'], ['type', 'Categories'], ['collection', 'Collections'], ['tag', 'Tags']];
  const LENS_ONE = { product: 'Parent product', type: 'Category', collection: 'Collection', tag: 'Tag' };
  const LENS_MANY = { product: 'parent products', type: 'categories', collection: 'collections', tag: 'tags' };
  function viewSelect() {
    if (!state.lenses) {
      state.lenses = ['product', 'type'];
      api('/api/groups').then((j) => { state.lenses = j.lenses; if (state.view === 'products') render(); }).catch(() => { /* keep the two that always work */ });
    }
    const hasType = state.report.products.some((p) => p.type);
    const on = LENS.filter(([k]) => !k || (state.lenses.includes(k) && (k !== 'type' || hasType)));
    return `<select class="search sel" id="f-view" aria-label="View: list products one by one, or grouped">${on.map(([k, l]) => `<option value="${k}" ${k === (state.lens || '') ? 'selected' : ''}>View: ${l}</option>`).join('')}</select>`;
  }
  const groupChip = () => (state.group ? `<button class="chip on gchip" id="g-clear" title="Remove this filter" aria-label="Remove filter ${esc(LENS_ONE[state.group.lens])}: ${esc(state.group.label)}">${esc(LENS_ONE[state.group.lens])}: ${esc(state.group.label)}<span aria-hidden="true">×</span></button>` : '');
  function groupData() {
    const k = `${state.lens}|${state.days}|${whatQs()}|${state.report.generatedAt}|${state.allColl ? 1 : 0}`;
    if (state.groups && state.groups.k === k) return state.groups;
    if (state.groupsWant !== k) {
      state.groupsWant = k;
      api(`/api/groups?lens=${state.lens}&days=${state.days}${state.allColl ? '&all=1' : ''}${whatQs()}`)
        .then((j) => { if (state.groupsWant === k) { state.groups = { ...j, k }; if (state.view === 'products') render(); } })
        .catch((e) => { if (state.groupsWant === k) { state.groupsWant = null; state.lens = ''; toast(e.message); if (state.view === 'products') render(); } });
    }
    return null;
  }
  const GROUP_COLS = (lens, hasCost) => [
    { k: 'label', label: LENS_ONE[lens], f: (g) => `<span class="pname" title="${esc(g.label)}">${esc(g.label)}</span>` },
    { k: 'n', label: 'Products', r: 1, tip: 'Product rows (variants) in this group: what a click shows', f: (g) => inr.format(g.n) },
    { k: 'needOrder', label: 'Need order', r: 1, tip: 'Products to order today, of all in the group', f: (g) => (g.needOrder ? `<b>${inr.format(g.needOrder)}</b><span class="muted"> of ${inr.format(g.n)}</span>` : `<span class="muted">0 of ${inr.format(g.n)}</span>`) },
    { k: 'sold', label: 'Sold', r: 1, tip: `₹ sold ${inPeriod()}`, f: (g) => money(g.sold) },
    { k: 'lost', label: 'Sales lost', r: 1, tip: `Sales lost to stock-outs ${inPeriod()}`, f: (g) => (g.lost ? `<span class="lostv">${money(g.lost)}</span>` : '–') },
    ...(hasCost ? [{ k: 'lostProfit', label: 'Profit lost', r: 1, tip: 'Units lost × (price paid − unit cost)', val: (g) => g.lostProfit ?? -1, f: (g) => (g.lostProfit ? `<span class="lostv">${money(g.lostProfit)}</span>` : '–') }] : []),
    { k: 'orderValue', label: 'Order ₹', r: 1, tip: `To order today for this group, ${atCost()}`, f: (g) => (g.orderValue ? `<b>${money(g.orderValue)}</b>` : '–') },
    { k: 'excessValue', label: 'Overstock ₹', r: 1, tip: `Stock beyond need, overstocked products only, ${atCost()}`, f: (g) => (g.excessValue ? `<span class="plumv">${money(g.excessValue)}</span>` : '–') },
    ...(window.SW_TARGETS ? [SW_TARGETS.col(lens, { canEdit: !viewOnly(), rerender: () => { if (state.view === 'products' && state.lens === lens) render(); } })] : []),   // SW-042
    { k: 'trendPct', label: 'Trend', tip: 'Units sold per week by the group’s products, last 8 weeks (rose = one or more of them out part of that week); % = the group’s sales per in-stock day, last 14 days vs the 14 before. Green = rising and 10 points or more better than the typical product; red = falling and 10 points or more worse', f: trendCell, val: (g) => g.trendPct ?? -999 },
  ];
  function groupView() {
    const lens = state.lens, d = groupData();
    const head = (sub) => `<section class="headline"><h1>Products by ${LENS_ONE[lens].toLowerCase()}</h1><p>${sub}</p><span class="hfind">${viewSelect()}</span></section>`;
    if (!d) return `${head('Loading…')}<div class="tbl"><div class="empty">Grouping…</div></div>`;
    const t = d.overlap ? d.store : d.total, rows = d.groups.map((g) => ({ ...g, id: g.key }));
    const ci = d.catalog || {};
    const fresh = ci.demo ? 'Demo tags and collections, made up from the product types.'
      : lens === 'collection' ? (ci.reading ? 'Reading collections from Shopify…' : ci.collectionsAt ? `Collections read from Shopify ${dt(ci.collectionsAt)}, re-read daily.` : 'Collections not read yet.') : '';
    const note = d.overlap
      ? `A product in two ${LENS_MANY[lens]} counts in both rows, so the rows don’t add up. Store total, each product once: ${inr.format(t.n)} products · ${money(t.sold)} sold · ${money(t.lost)} lost · ${inr.format(t.needOrder)} to order today (${money(t.orderValue)}).`
      : 'Every product is in one row, so the rows add up to the store total.';
    const allBtn = state.allColl ? '<button class="chip on" id="g-all">Showing all-products collections<span aria-hidden="true">×</span></button>'
      : d.hidden.length ? `<button class="chip" id="g-all" title="Collections holding 80% or more of products are hidden">Show ${d.hidden.length === 1 ? `“${esc(d.hidden[0].label)}”` : `${d.hidden.length} all-products collections`}</button>` : '';
    const sub = `${inr.format(rows.length)} ${LENS_MANY[lens]}`;   // overlap lenses: no grand total, only the footnote
    return `${head(d.overlap ? sub : `${sub} · <b>${inr.format(t.needOrder)}</b> to order today · <span class="nw">${money(t.sold)} sold</span> · <span class="lostv">${money(t.lost)} lost</span>`)}
      ${allBtn ? `<div class="toolbar"><div class="chips">${allBtn}</div></div>` : ''}
      <div class="groups">${table('groups', GROUP_COLS(lens, state.report.totals.hasCost), rows, 'Nothing to group yet.', (g) => `
        <header><h3><span class="pname">${esc(g.label)}</span></h3>${mspark(g)}<div class="mq"><b class="lostv">${money(g.lost)}</b><small>sales lost</small></div></header>
        <div class="mfacts"><span><b>${inr.format(g.n)}</b> ${g.n === 1 ? 'product' : 'products'}</span><span><b>${inr.format(g.needOrder)}</b> of ${inr.format(g.n)} to order${g.orderValue ? ` · ${money(g.orderValue)}` : ''}</span><span><b>${money(g.sold)}</b> sold</span>${g.excessValue ? `<span class="plumv">${money(g.excessValue)} overstock</span>` : ''}${g.trendPct != null ? `<span class="trl">Trend ${trendOnly(g)}</span>` : ''}</div>${window.SW_TARGETS ? SW_TARGETS.card(g) : ''}`)}</div>
      <p class="gnote">${note} Click a row to see its products.${fresh ? ` ${fresh}` : ''}</p>`;
  }
  function openGroup(key) {
    const g = state.groups && state.groups.groups.find((x) => x.key === key); if (!g) return;
    state.group = { lens: state.lens, key, label: g.label, ids: new Set(g.ids) };
    state.lens = ''; state.filter.products = 'all'; state.limit.products = 0; render(); window.scrollTo(0, 0);
  }

  function downloadProductsCsv() {
    const cols = PRODUCT_COLS();
    // Same rule as csvCell in src/rows.js: text starting = + - @ tab CR gets a leading ' (no formulas run in Excel/Sheets).
    const q = (x) => { let v = String(x ?? ''); if (typeof x === 'string' && /^[=+\-@\t\r]/.test(v)) v = `'${v}`; return `"${v.replace(/"/g, '""')}"`; };
    const lines = [[...cols.map((c) => c.label), ...SW_PROD.CSV_HEAD], ...productRows().map((p) => [...cols.map((c) => (c.csv ? c.csv(p) : p[c.k])), ...SW_PROD.csv(p)])].map((l) => l.map(q).join(','));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' }));
    a.download = `products-${isoDay(Date.now())}.csv`; a.click(); URL.revokeObjectURL(a.href);
  }

  /* one IANA time zone per store (SW-049): common ones first, then every zone; a fixed offset from an older store stays listed */
  function tzSelect(s) {
    if (!window.SW_TZ) return '';
    const cur = SW_TZ.zoneOf(s), lab = (z, name) => `${name} (${SW_TZ.offsetLabel(z)}${SW_TZ.hasDst(z) ? ', clocks change' : ''})`;
    const opt = (z, l) => `<option value="${esc(z)}" ${z === cur ? 'selected' : ''}>${esc(l)}</option>`;
    const common = SW_TZ.COMMON.map(([z]) => z);
    const extra = common.includes(cur) || SW_TZ.all().includes(cur) ? '' : opt(cur, SW_TZ.fixedMinutes(cur) != null ? `Fixed ${SW_TZ.offsetLabel(cur)} (no daylight saving)` : cur);
    return `<select id="f-timeZone" data-setting="timeZone">${extra}<optgroup label="Common">${SW_TZ.COMMON.map(([z, n]) => opt(z, lab(z, n))).join('')}</optgroup><optgroup label="All time zones">${SW_TZ.all().filter((z) => !common.includes(z)).map((z) => opt(z, z.replace(/_/g, ' '))).join('')}</optgroup></select>`;
  }
  /* SW-063: past stock rebuilt from Shopify's change log (LOGIC §1c); one line, the button is admin only (Data is) */
  function historyLine(sh) {
    if (!sh.source) return '';
    const h = sh.history, btn = viewOnly() ? '' : ' <button class="linkbtn" id="history-rebuild">Rebuild stock history</button>';
    const txt = !h ? 'Stock history: rebuilt after the first pull'
      : h.ok ? `Stock history rebuilt from Shopify’s change log for ${inr.format(h.kept)} of ${inr.format(h.total)} products (${dt(h.from).slice(0, 6)} → ${dt(h.until).slice(0, 6)})${h.dropped ? ` · ${inr.format(h.dropped)} left out: the log doesn’t add up for them` : ''}${h.check ? ` · check: ${inr.format(h.check.bad)} of ${inr.format(h.check.lines)} orders fell while out${h.check.bad ? ' (those products left out)' : ''}` : ''}`
        : h.note;
    const fail = h && h.ok && h.note ? ` · last try: ${h.note}` : '';
    return `<p class="muted small" id="history-line">${esc(txt + fail)}${btn}</p>`;
  }
  /* 1.3.0: Shopify's weekly sales (confidence, LOGIC §4c) and website allocations (§6), one line each */
  function weeksLine(sh) {
    if (!sh.source) return '';
    const w = sh.weekSales;
    const txt = !w ? 'Weekly sales: read from Shopify’s reports after the next pull (confidence uses units until then)'
      : w.ok ? `Weekly sales from Shopify’s reports: ${inr.format(w.variants || 0)} products, ${inr.format(w.weeks || 25)} full weeks (read ${dt(w.at)}); confidence = share of weeks with a sale${w.note ? ` · last try: ${w.note}` : ''}` : w.note;
    return `<p class="muted small" id="weeks-line">${esc(txt)}</p>`;
  }
  function allocLine() {
    const t = state.report.totals; if (!t.allocation) return '';
    const lv = [...new Set(state.report.products.filter((p) => p.allocation).map((p) => p.allocation.level))].sort((a, b) => a - b).join(' / ');
    return `<p class="muted small" id="alloc-line">Shopify’s stock isn’t total stock for ${inr.format(t.allocation)} ${t.allocation === 1 ? 'product' : 'products'}: it is a website allocation (~${esc(lv)} pcs) refilled from the warehouse. Warehouse stock isn’t in Shopify, so no reorder is sized for ${t.allocation === 1 ? 'it' : 'them'} (status “${ALLOC}”). Turn this off under Advanced: planning rules.</p>`;
  }
  /* UI-1: products with no stock record before part of the period (the rebuild left them out, or they're new to the data):
     named, with units sold, so "N left out" isn't a mystery and their ₹0 lost isn't read as a fact */
  function noHistList() {
    const r = state.report, list = r.products.filter((p) => p.status !== 'Inactive' && noHistory(p, r.from)).sort((a, b) => (b.unitsSold || 0) - (a.unitsSold || 0) || b.sold - a.sold);
    if (!list.length) return '';
    return `<details class="fold" id="nohist-list"><summary class="muted small">${inr.format(list.length)} products have no stock record for part of the period: their sales lost before it is unknown</summary>
      <div class="bars">${list.map((p) => `<div class="bar-row" data-product="${esc(p.id)}" tabindex="0" role="button" style="grid-template-columns:minmax(0,1fr) auto auto"><span class="name">${esc(p.name)}</span><span class="muted num">from ${esc(dateShort(p.historyFrom))}</span><span class="num">${inr.format(p.unitsSold || 0)} sold</span></div>`).join('')}</div></details>`;
  }
  function dataView() {
    const s = state.settings, d = state.report.data, src = state.source, sh = state.shopify || {};
    const base = location.origin;
    const status = src.kind === 'demo' ? 'Demo data: Sammsara’s public product list, with invented stock and sales'
      : sh.source ? (sh.lastError ? `Shopify: ${esc(sh.lastError)}` : sh.lastSync ? `Connected to Shopify · last read ${dt(sh.lastSync)}` : 'Connected to Shopify · first read pending')
        : src.kind === 'live' ? 'Live data' : 'No data yet';
    return `
      <section class="headline"><h1>Data &amp; settings${manyStores() ? ` <span class="muted">· ${esc((state.report.store && state.report.store.name) || s.storeName)}</span>` : ''}</h1>${manyStores() ? '<p class="muted">Everything on this page is for this store only. The main passwords open every store.</p>' : ''}</section>
      <section class="panel"><div class="panel-head"><h2>${status}</h2>${sh.source ? '<button class="btn" id="shopify-sync">Pull from Shopify now</button>' : ''}</div>
        <p class="muted">${inr.format(d.stockRows)} stock changes${d.firstStock ? ` (${dt(d.firstStock)} → ${dt(d.lastStock)})` : ''} · ${inr.format(d.orderRows)} order lines${d.firstOrder ? ` (${dt(d.firstOrder)} → ${dt(d.lastOrder)})` : ''}${d.excluded?.variants ? ` · Excluded: ${inr.format(d.excluded.variants)} archived/draft, ${inr.format(d.excluded.pcs)} pcs` : ''}</p>${shopifyCheck()}${historyLine(sh)}${weeksLine(sh)}${allocLine()}${noHistList()}${sh.running ? `<p class="muted small" id="sync-progress">${esc(syncingText(sh.progress))}</p>` : ''}${(sh.writeScopes || []).length ? `<p class="muted small" id="write-note" title="${esc(sh.writeScopes.join(', '))}">Token also allows writes; this app only reads.</p>` : ''}${runHistory()}</section>

      ${window.SW_OPS ? SW_OPS.banner(state.ops) : ''}
      <h2 class="sect">Connect your data</h2>
      <details class="panel fold"><summary><b>Shopify</b> <span class="muted">read-only, recommended</span></summary>${shopifyPanel()}</details>
      <details class="panel fold"><summary><b>Google Sheet</b> <span class="muted">from the Stock Watch sheet</span></summary>
        <p class="muted">If the store’s Shopify Flow writes into a Google Sheet: in that sheet, File → Share → Publish to web → pick the tab → CSV, and paste the two links. Synced every 2 hours.</p>
        <div class="field"><label for="sheet-stock">“Stock log” CSV link</label><input id="sheet-stock" value="${esc(s.sheetStockCsv)}" placeholder="https://docs.google.com/spreadsheets/d/e/…/pub?gid=…&output=csv"></div>
        <div class="field"><label for="sheet-order">“Order log” CSV link</label><input id="sheet-order" value="${esc(s.sheetOrderCsv)}" placeholder="https://docs.google.com/spreadsheets/d/e/…/pub?gid=…&output=csv"></div>
        <div class="toolbar"><button class="btn" id="sheet-save">Save and sync now</button></div></details>
      <details class="panel fold"><summary><b>Shopify Flow</b> <span class="muted">sends each change straight here</span></summary>
        <p class="muted">In Shopify Flow use the action <b>Send HTTP request</b> (POST) with the header <span class="mono">X-Ingest-Key</span> set to the key below; body = the same comma-separated line as the sheet, or JSON. One workflow per URL. Keep the key out of the URL.</p>
        <div class="field"><label>Stock changes (trigger: Product variant inventory quantity changed)</label><div class="code" id="u-stock">${esc(base + storeUrl('/ingest/stock'))}</div></div>
        <div class="field"><label>Order lines (trigger: Order created → For each line item)</label><div class="code" id="u-order">${esc(base + storeUrl('/ingest/order'))}</div></div>
        <div class="field"><label>Header <span class="mono">X-Ingest-Key</span></label><div class="code" id="u-key">${maskKey(s.ingestKey)}</div><small>${s.ingestKeyAt ? `Last changed ${dt(s.ingestKeyAt)}` : 'Not changed since setup'}</small></div>
        <div class="toolbar"><button class="btn ghost" data-copy="u-stock">Copy stock URL</button><button class="btn ghost" data-copy="u-order">Copy order URL</button><button class="btn ghost" id="show-key">Show key</button><button class="btn ghost" id="copy-key">Copy key</button><button class="btn ghost" id="new-key">New key</button></div></details>
      <details class="panel fold"><summary><b>Upload a CSV</b> <span class="muted">one-off history</span></summary>
        <p class="muted">A Shopify products or orders export works as it is. Any other CSV with a header row: pick which of its columns is which after choosing it. Dates day first: <span class="mono">15/11/2026 10:30</span> or <span class="mono">2026-11-15 10:30</span>.</p>
        <div class="form"><div class="field"><label for="imp-kind">File holds</label><select id="imp-kind"><option value="stock">Stock changes</option><option value="order">Order lines</option></select></div>
          <div class="field"><label for="imp-file">CSV file</label><input type="file" id="imp-file" accept=".csv,text/csv"></div></div>
        <div id="imp-preview"></div>
        ${src.kind === 'demo' ? '<p class="muted small">Uploading replaces the demo data, with anything marked ordered or decided on it.</p>' : ''}
        <div><button class="btn" id="imp-go">Upload</button></div></details>

      <h2 class="sect">Settings</h2>
      <section class="panel">
        <div class="form">
          ${field('storeName', 'Store name', s.storeName || (state.report.store && state.report.store.name) || '', 'Shown in the store picker, the tab title and digests', 'text')}
          <div class="field"><label for="f-timeZone">Time zone</label>${tzSelect(s)}<small>Store days, the sales-by-hour pattern, the digest hour and backup dates follow this</small></div>
        </div>
        <details class="fold-in"><summary>Advanced: planning rules</summary>
          <div class="form">${ASSUME.map(([k, label, , , tip]) => field(k, label, s[k], tip)).join('')}</div></details>
        ${changeLog()}
        <div><button class="btn" id="save-settings">Save settings</button></div>
      </section>
      ${window.SW_DIGEST ? SW_DIGEST.panel() : ''}
      ${window.SW_PEOPLE ? SW_PEOPLE.panel() : ''}
      ${window.SW_MONEY ? SW_MONEY.panel() : ''}
      <details class="panel fold danger"><summary><b>Danger zone</b></summary>
        <div class="toolbar">${sh.source || src.kind === 'live' ? '' : '<button class="btn ghost" id="load-demo">Reload demo data</button>'}<button class="btn ghost" id="clear-all">Clear all data</button></div>
        <div id="clear-confirm"></div></details>
      <form class="phone-only" method="post" action="/logout"><button class="btn ghost" type="submit">Sign out</button></form>`;
  }

  const manyStores = () => !!(window.SW_STORES && SW_STORES.list().length > 1);
  const maskKey = (k) => `${'•'.repeat(12)}${esc(String(k || '').slice(-4))}`;
  const SKIP_WHY = { badTime: 'bad or future time', badNumber: 'bad number', noId: 'no variant ID', tooOld: 'older than 120 days', ...(window.SW_IMPORT ? SW_IMPORT.SKIP : {}) };
  const field = (k, label, v, hint, type = 'number') => `<div class="field"><label for="f-${k}">${esc(label)}</label><input id="f-${k}" data-setting="${k}" ${type === 'number' ? `type="text" inputmode="decimal" autocomplete="off" data-trial="${k}"` : `type="${type}"`} value="${esc(type === 'number' ? window.SW_TRIAL?.typed(`f-${k}`) ?? v : v)}"><small>${esc(hint)}</small></div>`;   // SW-057: numbers keep what you type

  /* ---------- product drawer ---------- */
  async function openProduct(id) {
    const dr = $('#drawer'), body = $('#drawer-body');
    if (dr.hidden) { try { history.pushState({ drawer: 1 }, ''); } catch { /* sandboxed */ } }   // Back closes the drawer
    body.innerHTML = '<p class="muted">Loading…</p>'; dr.hidden = false;
    try {
      const d = await api(`/api/product/${encodeURIComponent(id)}?days=${state.days}${whatQs()}`);
      const p = d.product, now = state.report.generatedAt, from = state.report.from, gap = noHistory(p, from);
      body.innerHTML = `
        ${manyStores() ? `<p class="dstore">${esc(SW_STORES.name())}</p>` : ''}${p ? SW_PROD.hero(p, `<div class="toolbar">${status(p) + bestTag(p)}</div>`) : `<h2 id="drawer-title">${esc(id)}</h2>`}
        ${p?.why ? `<p class="dwhy">${whyCell(p)}</p>` : ''}
        <section class="tiles dtiles">
          <div class="tile amber"><b>${p?.orderQty ? `${inr.format(p.orderQty)} pcs` : '–'}</b><span>order now${p?.orderQty ? ` · ${money(p.orderValue)} ${atCost()}` : ''}${p?.paceQty != null ? `<br><small id="pace-qty" title="Sales are falling (${p.trendPct ?? '–'}% this product, ${state.report.totals.storeTrendPct ?? '–'}% the typical product): the same order at the last 14 days’ in-stock pace, ${n1(p.pacePerDay)} a day">${inr.format(p.paceQty)} pcs at last 2 weeks’ pace</small>` : ''}</span></div>
          <div class="tile ${p?.daysLeft != null && p.daysLeft <= 3 ? 'lost' : ''}"><b>${p?.daysLeft == null ? (p?.stock <= 0 ? '0' : '–') : n1(p.daysLeft)}</b><span>days left · ${p?.stock ?? '–'} in stock</span></div>
          <div class="tile"><b title="${n1(p?.perDay)} per in-stock day">${rate(p?.perDay)}</b><span>sells while in stock${p?.lowData ? ' · <abbr title="Under 5 units and 14 in-stock days to go on: capped at units ÷ days since its first sale, and never a best seller (LOGIC §3)">low data</abbr>' : ''}</span></div>
          ${gap ? `<div class="tile" id="lost-unknown" title="No stock record before ${esc(dateShort(gap))}, so stock-outs before then can’t be seen (Shopify’s change log didn’t add up for it)"><b>${p.lost ? money(p.lost) : 'Unknown'}</b><span>sales lost${p.lost ? ` since ${esc(dateShort(gap))}` : ''} · before ${esc(dateShort(gap))}: unknown</span></div>`
    : `<div class="tile lost"><b>${money(p?.lost)}</b><span>sales lost${p?.lostProfit != null ? ` · ${money(p.lostProfit)} profit` : ''}${p && p.lost ? ` · confidence ${esc((CONF_LABEL[p.confidence] || '–').toLowerCase())}${weeksText(p) ? ` (${esc(weeksText(p))})` : ''}` : ''}</span>${p && p.lost ? lostSplitLine(p) : ''}</div>`}
          ${p?.returnPct != null ? `<div class="tile rtile" id="returns-tile" title="${esc(RETURNS_TIP)}"><span>Cancelled or refunded: <b class="${p.returnPct >= HIGH_RETURN ? 'amberv' : ''}">${n1(p.returnPct)}%</b> (${inr.format(p.unitsReturned)} of ${inr.format(p.unitsOrdered)} ordered${p.unitsCancelled ? `, ${inr.format(p.unitsCancelled)} cancelled` : ''}) · ${money(p.refundValue)} back</span></div>` : ''}
        </section>
        ${p && (viewOnly() ? p.onOrder : p.orderQty > 0 || p.onOrder) ? orderForm(p) : ''}
        <div class="panel"><div class="panel-head"><h2>Trend</h2>${p ? trendChip(p) : ''}</div>${p ? `<div class="wk">${spark(p, 320, 44)}<div class="wknums">${(p.weeks || []).map((w, i) => `<span title="${esc(weekTip(w, i))}" class="${w.outDays ? 'wo' : ''}"><b>${w.units == null ? '–' : inr.format(w.units)}</b><small>${dateShort(weekStart(i))}</small></span>`).join('')}</div></div>
          <p class="muted small">Units sold per week, week starting on the date shown; rose = out of stock part of that week.</p>` : ''}</div>
        <div class="panel chart"><h2>Stock level</h2>${stockChart(d.timeline, from, now, gap)}<span class="muted" style="font-size:13px">${gap ? `<span id="nohist-note">Hatched = no stock history before ${esc(dateShort(gap))}: Shopify’s change log didn’t add up for it. </span>` : ''}Shaded = out of stock.</span></div>
        <details class="panel fold"><summary><b>More</b> <span class="muted">units per day, every stock-out</span></summary>
        <div class="chart"><h2>Units sold per day</h2>${unitsChart(d.dailyUnits)}</div>
        <div><h2>Stock-outs</h2>${d.stockouts.length ? `<div>${d.stockouts.map((s) => `<div class="ep"><span>${dt(s.start)} → ${s.open ? '<span class="st open">still out</span>' : dt(s.end)}</span><span class="muted">${dur(s.hours)}</span><b style="color:#E0506E">${money(s.lost)}</b>${s.topUp != null ? `<span>refilled ${s.topUp} pcs</span>` : ''}${s.small ? '<span class="st small">Small top-up</span>' : ''}${s.repeat ? '<span class="st again">Out again</span>' : ''}</div>`).join('')}</div>` : '<p class="muted">None in this period.</p>'}</div></details>`;
      $('#drawer-close').focus();
    } catch (e) { body.innerHTML = `<p>Couldn’t load this product: ${esc(e.message)}</p>`; }
  }
  /* UI-7 (1.3.0): the split in words under the drawer's ₹, so it reads on touch too (no tooltips) */
  const lostSplitLine = (p) => {
    const parts = [`in headline ${money(p.lostCounted || 0)}`, p.lostEstimate > 0 ? `estimate ${money(p.lostEstimate)}` : '', p.lostNotRestocked > 0 ? `after day ${p.nrDays || nrDays()} ${money(p.lostNotRestocked)}` : '', p.lostAllocation > 0 ? `refill gaps ${money(p.lostAllocation)}` : ''].filter(Boolean);
    return parts.length > 1 ? `<small class="lsplit" id="lost-split">${esc(parts.join(' · '))}</small>` : '';
  };
  function orderForm(p) {
    const o = p.onOrder, lead = state.report.settings.leadDays;
    const facts = o ? `${o.late ? '<b class="lostv">Late</b> · was due' : 'Lands'} ${dateShort(o.eta)} · marked ${dateShort(o.at)}${o.by ? ` by ${esc(o.by)}` : ''}${o.remaining < o.qty ? ` · ${inr.format(o.qty - o.remaining)} received` : ''}` : `Suggested: ${inr.format(p.orderQty)} pcs, landing in ${lead} days`;
    const head = `<div class="panel poform${o ? ' has-order' : ''}"><div class="panel-head"><h2>${o ? `On order: ${inr.format(o.qty)} pcs` : 'Placed the order?'}</h2><span class="muted small">${facts}</span></div>`;
    if (viewOnly()) return head + '</div>';   // view-only: the facts, no form (SW-029)
    return `${head}
      <div class="porow"><label>Pieces<input id="oo-qty" inputmode="numeric" autocomplete="off" value="${o ? o.qty : p.orderQty}"></label>
        <label>Lands on<input id="oo-eta" type="date" min="${isoDay(Date.now())}" value="${isoDay(o ? Math.max(o.eta, Date.now()) : Date.now() + lead * 864e5)}"></label>
        <label>Your name<input id="oo-by" autocomplete="name" placeholder="optional" value="${esc(myName())}"></label>
        <button class="btn" id="oo-save" data-oo="${esc(p.id)}">${o ? 'Update' : 'Mark ordered'}</button>${o ? `<button class="btn ghost" id="oo-remove" data-oo="${esc(p.id)}">Remove</button>` : ''}</div></div>`;
  }
  let lastRow = null;
  const closeDrawer = () => {
    const was = !$('#drawer').hidden; $('#drawer').hidden = true;
    if (was && history.state?.drawer) history.back();   // drop the entry openProduct pushed; popstate then finds it closed
    if (was && lastRow && document.contains(lastRow)) lastRow.focus();
  };

  /* ---------- render + events ---------- */
  const VIEWS = { overview, reorder, stockouts, products, data: dataView };
  function render() {
    if (!state.report) return;
    if (state.view === 'data' && viewOnly()) { state.view = 'overview'; history.replaceState(null, '', '#overview'); }
    $$('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.view === state.view));
    $('#view').classList.toggle('calm', !render._animate); render._animate = false;   // bars animate when a page opens, not on every filter or keystroke
    $('#view').innerHTML = (VIEWS[state.view] || overview)() + (viewOnly() ? '<form class="phone-only" method="post" action="/logout"><button class="btn ghost" type="submit">Sign out</button></form>' : '');
    if (narrow()) {   // M3: phones scroll the chips row sideways; keep the active chip in view (pure DOM: the page doesn't move)
      const on = $('.wrap > .toolbar .chips .on');
      /* final r2 M1: the least scroll that shows the active chip, rounded up to a chip's start (10 px in), so the row
         never starts on a cut chip (the least alone left "Order today 0" cut to a bare "0" at the left edge). When the
         active chip is last, a little end padding makes that start reachable. Snap points keep manual scrolls on whole chips. */
      if (on) {
        const c = on.parentElement, b = c.getBoundingClientRect(), x0 = b.left - c.scrollLeft, a = on.getBoundingClientRect();
        const least = Math.max(0, a.right - x0 - c.clientWidth + 10);
        if (least > 0) {
          const starts = [...c.children].map((e) => e.getBoundingClientRect().left - x0 - 10).filter((v) => v >= least - 1);
          const want = Math.min(a.left - x0 - 10, starts.length ? Math.min(...starts) : least);
          const max = c.scrollWidth - c.clientWidth;
          if (want > max) c.style.paddingRight = `${Math.ceil(want - max) + (parseFloat(getComputedStyle(c).paddingRight) || 0)}px`;
          c.scrollLeft = want;
        }
        chipEdges(c);
      }
      /* M8: Sort sits beside Search (one row) on Reorder and Stock-outs */
      const tb = $('#view > .toolbar'), q = tb && tb.querySelector(':scope > .search'), ms = $('#view .phone .msort');
      if (q && ms) { const row = document.createElement('div'); row.className = 'tq'; q.before(row); row.append(q, ms); }
    }
    const focusId = render._focus; render._focus = null;
    if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus(); const c = render._caret ?? el.value.length; try { el.setSelectionRange(c, c); } catch { /* not a text input */ } } }
    render._caret = null;
    fitTables();
    fitChart();
    window.SW_MONEY?.after(state.view);   // SW-041: dim rows over budget, draw the cut line
  }
  /* final r2 M1: fade the chips row's edge only on a side that has more chips to scroll to */
  function chipEdges(c) {
    c.classList.toggle('fl', c.scrollLeft > 1);
    c.classList.toggle('fr', c.scrollLeft + c.clientWidth < c.scrollWidth - 1);
  }
  /* Redraw the Overview daily chart at its box's real width (no scaling). */
  function fitChart() {
    const box = $('#daily-chart'), svg = box && box.querySelector('svg');
    if (!svg || !state.report) return;
    const w = Math.floor(box.clientWidth - parseFloat(getComputedStyle(box).paddingLeft) - parseFloat(getComputedStyle(box).paddingRight));
    if (w > 0 && Math.abs(w - +svg.getAttribute('width')) > 1) svg.outerHTML = dailyChart(state.report.daily, w);
  }
  /* Show everything, never scroll the page sideways: when the columns don't fit, the optional ones step aside, the last
     first, until the table fits; a small note names them (untick in Columns… to choose others). Only if the table still
     doesn't fit (a user-widened column) does it scroll sideways inside its box (critic r2 UI-2). */
  function fitTables() {
    $$('.tbl.desk').forEach((b) => {
      const t = b.querySelector('table'); if (!t || !t.tHead) return;
      t.querySelectorAll('.sq').forEach((el) => el.classList.remove('sq'));
      const over = () => b.clientWidth > 0 && t.getBoundingClientRect().width > b.clientWidth + 1;
      const aside = [];
      if (!t.classList.contains('fixed')) {
        const ths = [...t.tHead.rows[0].cells];
        for (let i = ths.length - 1; i >= 0 && over(); i--) {
          if (!ths[i].dataset.opt || getComputedStyle(ths[i]).display === 'none') continue;
          ths[i].classList.add('sq');
          for (const row of t.tBodies[0]?.rows || []) row.cells[i]?.classList.add('sq');
          aside.unshift(ths[i].textContent.replace(/[↑↓]/g, '').trim());
        }
      }
      const still = over();
      b.classList.toggle('scrollx', still);
      const prev = b.previousElementSibling && b.previousElementSibling.classList.contains('sx-hint') ? b.previousElementSibling : null;
      const text = still ? 'More columns than fit: scroll the table sideways →' : aside.length ? `Not shown at this width: ${aside.join(', ')} (wider screen, or untick others in Columns)` : '';
      if (!text) { if (prev) prev.remove(); return; }
      if (prev) prev.textContent = text; else b.insertAdjacentHTML('beforebegin', `<div class="sx-hint">${esc(text)}</div>`);
    });
  }
  function route() { closeDrawer(); render._animate = true; state.view = (location.hash || '#overview').slice(1) in VIEWS ? (location.hash || '#overview').slice(1) : 'overview'; render(); window.scrollTo(0, 0); }

  document.addEventListener('click', async (e) => {
    if (e.target.closest('.rz')) return;
    if (e.target.closest('a.plink')) return;   // 1.4.0: Shopify / website links open in a new tab, not the drawer
    if (e.target.closest('.mpick') && !e.target.matches('input')) return;   // the label's own click; the checkbox click follows
    if (e.target.matches('input.pick')) { const id = e.target.dataset.pick; if (e.target.checked) state.pick.add(id); else state.pick.delete(id); render(); return; }
    if (e.target.id === 'toast-act' && toast._do) { const run = toast._do; $('#toast').hidden = true; toast._do = null; run().catch((err) => toast(err.message)); return; }
    const sum = e.target.closest('.plan > summary'); if (sum) { state.planOpen = !sum.parentElement.open; return; }
    const t = e.target.closest('button, [data-product], tr[data-id], .mcard[data-id], th[data-k], [data-go]');
    if (!t) return;
    if (t.matches('.range button')) { state.days = t.dataset.days === 'month' ? 'month' : +t.dataset.days; await load(); return; }
    if (t.dataset.go) { const v = t.dataset.go; state.filter[v] = t.dataset.filter; if (location.hash === `#${v}`) { state.limit[v] = 0; render(); } else location.hash = v; return; }   // same page (the §4c line under a headline): no hashchange, so render here
    if (t.dataset.more) { const id = t.dataset.more; state.limit[id] = t.dataset.all ? 1e9 : (state.limit[id] || PAGE) + PAGE; render(); return; }
    if (t.dataset.filterReorder) { state.filter.reorder = t.dataset.filterReorder; state.limit.reorder = 0; render(); return; }
    if (t.dataset.filterStockouts) { state.filter.stockouts = t.dataset.filterStockouts; state.limit.stockouts = 0; render(); return; }
    if (t.dataset.filterProducts) { state.filter.products = t.dataset.filterProducts; state.limit.products = 0; render(); return; }
    if (t.id === 'csv-products') { downloadProductsCsv(); return; }
    if (t.id === 'csv-mkt') { downloadMktCsv(pFilter()); return; }
    if (t.id === 'copy-skus') { copy(productRows().map((p) => p.sku || p.id).join('\n')); return; }
    if (t.dataset.decide != null) {
      const [id, d] = t.dataset.decide.split('|'); t.disabled = true;
      try { await api('/api/decide', { method: 'POST', body: JSON.stringify({ id, decision: d || null }) }); toast(d ? 'Decided: hidden until its sales change by more than half' : 'Back on the list'); await reloadReport(); } catch (err) { toast(err.message); t.disabled = false; }
      return;
    }
    if (t.id === 'g-clear') { state.group = null; state.limit.products = 0; render(); return; }
    if (t.id === 'g-all') { state.allColl = !state.allColl; render(); return; }
    if (t.id === 'copy-summary') { copy(summaryText()); return; }
    if (t.dataset.step) { const [k, d] = t.dataset.step.split('|'); const el = document.getElementById('w-' + k); const v = Math.max(0, Math.round((+el.value + +d) * 10) / 10); el.value = v; window.SW_TRIAL?.forget(el.id); setWhat(k, v); return; }

    if (t.matches('th[data-k]')) {
      const id = t.closest('table').dataset.table, k = t.dataset.k, s = state.sort[id];
      state.sort[id] = s && s.k === k ? { k, dir: -s.dir } : { k, dir: -1 }; render(); return;
    }
    if (t.dataset.product) { lastRow = t; openProduct(t.dataset.product); return; }
    if (t.matches('tr[data-id], .mcard[data-id]') && t.closest('.groups')) { openGroup(t.dataset.id); return; }
    if (t.matches('tr[data-id], .mcard[data-id]')) { lastRow = t; openProduct(t.dataset.id); return; }
    if (t.id === 'drawer-close') { closeDrawer(); return; }
    if (t.dataset.copy) { copy($(`#${t.dataset.copy}`).textContent); return; }
    if (t.id === 'copy-key') { copy(state.settings.ingestKey); return; }
    if (t.id === 'show-key') { const shown = t.textContent === 'Hide key'; $('#u-key').innerHTML = shown ? maskKey(state.settings.ingestKey) : esc(state.settings.ingestKey); t.textContent = shown ? 'Show key' : 'Hide key'; return; }
    try {
      if (t.id === 'pick-all') { const f = state.filter.reorder, q = state.q.reorder.toLowerCase(); state.report.reorder.filter((p) => !p.onOrder && p.orderQty > 0 && (f === 'all' || group(p.status) === f) && (!q || `${p.name} ${p.sku}`.toLowerCase().includes(q))).forEach((p) => state.pick.add(p.id)); render(); return; }
      if (t.id === 'pick-clear') { state.pick.clear(); render(); return; }
      if (t.id === 'pick-mark') {
        const lead = state.report.settings.leadDays, eta = isoDay(Date.now() + lead * 864e5);
        const items = state.report.reorder.filter((p) => state.pick.has(p.id) && !p.onOrder && p.orderQty > 0).map((p) => ({ id: p.id, qty: p.orderQty, eta: p.leadDays != null ? isoDay(Date.now() + p.leadDays * 864e5) : eta }));   // SW-040: the supplier's lead time
        if (!items.length) return; t.disabled = true;
        await markOrdered(items, items.length === 1 ? `Marked ordered: ${inr.format(items[0].qty)} pcs, lands ${dateShort(Date.now() + lead * 864e5)}` : `Marked ${items.length} ordered, landing ${dateShort(Date.now() + lead * 864e5)}`); return;
      }
      if (t.id === 'oo-save' || t.id === 'oo-remove') {
        const id = t.dataset.oo, by = ($('#oo-by')?.value || '').trim();
        try { localStorage.setItem('sw-name', by); } catch { /* private window */ }
        const item = t.id === 'oo-remove' ? { id, clear: true } : { id, qty: +String($('#oo-qty').value).replace(/[,\s]/g, ''), eta: $('#oo-eta').value };
        t.disabled = true;
        await api('/api/onorder', { method: 'POST', body: JSON.stringify({ items: [item], by }) });
        toast(t.id === 'oo-remove' ? 'Order mark removed' : `Marked ordered: ${inr.format(item.qty)} pcs, lands ${dateShort(Date.parse(item.eta + 'T12:00:00Z') - off())}`);
        await reloadReport(); openProduct(id); return;
      }
      if (t.id === 'what-reset') { state.what = {}; await reloadReport(); return; }
      if (t.id === 'what-save') { t.disabled = true; await api('/api/settings', { method: 'PUT', body: JSON.stringify(state.what) }); state.what = {}; toast('Saved as the default'); await load(); return; }
      if (t.id === 'load-demo') { $('#clear-confirm').innerHTML = '<div class="confirm">Replace all data with demo data? <button class="btn danger" id="demo-yes">Load demo</button><button class="btn ghost" id="clear-no">Keep</button></div>'; }
      if (t.id === 'demo-yes') { t.disabled = true; await api('/api/demo', { method: 'POST' }); toast('Demo data loaded'); await load(); }
      if (t.id === 'clear-all') { $('#clear-confirm').innerHTML = '<div class="confirm">Delete every stock change and order line? <button class="btn danger" id="clear-yes">Delete all</button><button class="btn ghost" id="clear-no">Keep</button></div>'; }
      if (t.id === 'clear-no') { $('#clear-confirm').innerHTML = ''; }
      if (t.id === 'clear-yes') { await api('/api/clear', { method: 'POST' }); toast('All data deleted'); await load(); }
      if (t.id === 'imp-go') {
        const f = $('#imp-file').files[0]; if (!f) { toast('Choose a CSV file first'); return; }
        t.disabled = true;
        const j = await api(`/api/import?kind=${$('#imp-kind').value}${window.SW_IMPORT ? SW_IMPORT.query() : ''}`, { method: 'POST', body: await f.text(), json: false, headers: { 'content-type': 'text/csv' } });
        const why = Object.entries(SKIP_WHY).filter(([k]) => j.skips?.[k]).map(([k, l]) => `${j.skips[k]} ${l}`).join(', ');
        if (window.SW_IMPORT) SW_IMPORT.reset();
        toast(`Read ${j.read} rows, ${j.added} new${j.skipped ? `, ${j.skipped} skipped (${why})` : ''}`); await load();
      }
      if (t.id === 'sheet-save') {
        t.disabled = true;
        await api('/api/settings', { method: 'PUT', body: JSON.stringify({ sheetStockCsv: $('#sheet-stock').value, sheetOrderCsv: $('#sheet-order').value }) });
        const j = await api('/api/sync', { method: 'POST' }).catch((err) => ({ error: err.message }));
        toast(j.error ? `Saved. Sync failed: ${j.error}` : `Synced: ${j.stock || 0} stock changes, ${j.orders || 0} order lines new`); await load();
      }
      if (t.id === 'shopify-sync') {
        t.disabled = true; t.textContent = 'Pulling…';
        const j = await api('/api/shopify/sync', { method: 'POST' });
        toast(j.running ? 'Still pulling in the background (the first pull can take a while)' : `Read from Shopify: ${j.stock} stock changes, ${j.orders} order lines new`); await load();
      }
      if (t.id === 'history-rebuild') {
        t.disabled = true; t.textContent = 'Rebuilding…';
        const j = await api('/api/shopify/history', { method: 'POST' });
        const h = j.history || {};
        toast(j.running ? 'Still rebuilding in the background' : h.note || (h.ok ? `Stock history rebuilt for ${h.kept} of ${h.total} products` : 'Not rebuilt')); await load();
      }
      if (t.id === 'new-key') { await api('/api/settings', { method: 'PUT', body: JSON.stringify({ newIngestKey: true }) }); toast('New key made: update X-Ingest-Key in both Flow workflows'); await load(); }
      if (t.id === 'save-settings') {
        const patch = {}; $$('[data-setting]').forEach((i) => { patch[i.dataset.setting] = i.dataset.trial ? i.value.trim().replace(',', '.') : i.value; });
        await api('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }); toast('Settings saved'); await load();
      }
    } catch (err) { toast(err.message); t.disabled = false; }
  });
  document.addEventListener('input', (e) => {
    if (e.target.dataset && e.target.dataset.what) { if (window.SW_TRIAL) return; render._focus = e.target.id; render._caret = e.target.selectionStart; setWhat(e.target.dataset.what, e.target.value.replace(',', '.')); return; }   // SW-057: read on leave / Enter (sw:trial)
    const m = e.target.id && e.target.id.match(/^q-(reorder|stockouts|products)$/);
    if (m) { state.q[m[1]] = e.target.value; state.limit[m[1]] = 0; render._focus = e.target.id; render._caret = e.target.selectionStart; render(); }
  });
  document.addEventListener('sw:trial', (e) => {   // SW-057: a what-if typed and read (public/trial-input.js)
    const el = e.detail.el; if (!el.dataset.what) return;
    if (document.activeElement === el) render._focus = el.id;
    setWhat(el.dataset.what, e.detail.value);
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'f-view') { state.lens = e.target.value; state.limit.products = 0; state.limit.groups = 0; render(); return; }
    if (e.target.id === 'f-more') { state.filter.products = e.target.value || 'all'; state.limit.products = 0; render(); return; }
    if (e.target.dataset && e.target.dataset.col) {
      const [id, k] = e.target.dataset.col.split('|'); const off = new Set(colsOff[id] || []);
      if (e.target.checked) off.delete(k); else off.add(k);
      colsOff[id] = [...off]; try { localStorage.setItem('sw-cols-off', JSON.stringify(colsOff)); } catch { /* private window */ }
      render(); $('#view .colpick.desk')?.setAttribute('open', ''); return;   // the Columns menu, not the store menu
    }
    const id = e.target.dataset && e.target.dataset.msort;
    if (!id) return;
    const [k, dir] = e.target.value.split('|');
    state.sort[id] = k ? { k, dir: +dir } : null; render();
  });
  /* drag a header edge to resize, like a spreadsheet; double-click to reset that table */
  document.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.rz'); if (!h) return;
    e.preventDefault(); h.setPointerCapture && h.setPointerCapture(e.pointerId);
    const th = h.closest('th'), table = th.closest('table'), id = table.dataset.table;
    const ths = [...table.querySelectorAll('th')].filter((x) => x.getBoundingClientRect().width > 0);
    const W = {}; ths.forEach((x) => { W[x.dataset.k] = Math.round(x.getBoundingClientRect().width); });
    table.classList.add('fixed'); ths.forEach((x) => { x.style.width = W[x.dataset.k] + 'px'; });
    table.style.width = Object.values(W).reduce((a, b) => a + b, 0) + 'px';
    const k = th.dataset.k, x0 = e.clientX, w0 = W[k];
    document.body.classList.add('resizing');
    const move = (ev) => { W[k] = Math.max(40, w0 + ev.clientX - x0); th.style.width = W[k] + 'px'; table.style.width = Object.values(W).reduce((a, b) => a + b, 0) + 'px'; };
    const up = () => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.body.classList.remove('resizing');
      state.colW[colKey(id)] = W; try { localStorage.setItem('sw-colw', JSON.stringify(state.colW)); } catch { /* private window */ }
      fitTables();
    };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  });
  document.addEventListener('dblclick', (e) => {
    const h = e.target.closest('.rz'); if (!h) return;
    const id = h.closest('table').dataset.table; Object.keys(state.colW).filter((k) => k === id || k.startsWith(id + '@')).forEach((k) => delete state.colW[k]);
    try { localStorage.setItem('sw-colw', JSON.stringify(state.colW)); } catch { /* private window */ }
    render();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.mcard[data-id], tr[data-id]')) { e.preventDefault(); if (e.target.closest('.groups')) { openGroup(e.target.dataset.id); return; } lastRow = e.target; openProduct(e.target.dataset.id); }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('th[data-k]')) { e.preventDefault(); e.target.click(); }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('div[data-product]')) { e.preventDefault(); lastRow = e.target; openProduct(e.target.dataset.product); }   // Overview rows (critic UI-3)
  });
  $('#drawer').addEventListener('click', (e) => { if (e.target.id === 'drawer') closeDrawer(); });
  /* M7: phones get an opaque strip behind the sticky × once the drawer scrolls (styles.css .scrolled) */
  $('.drawer-card').addEventListener('scroll', (e) => { e.currentTarget.classList.toggle('scrolled', e.currentTarget.scrollTop > 8); }, { passive: true });
  window.addEventListener('hashchange', route);
  window.addEventListener('popstate', (e) => { if (!$('#drawer').hidden && !e.state?.drawer) closeDrawer(); });
  document.addEventListener('scroll', (e) => { if (e.target.classList && e.target.classList.contains('chips')) chipEdges(e.target); }, true);   // final r2 M1
  let wasNarrow = narrow();
  let wasTier = tier();
  window.addEventListener('resize', () => { if (narrow() !== wasNarrow || tier() !== wasTier) { wasNarrow = narrow(); wasTier = tier(); render(); } else { fitTables(); fitChart(); } });

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied'); }
    catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('Copied'); }
  }

  state.view = (location.hash || '#overview').slice(1);
  window.SW_MONEY?.init({ state, api, toast, money, esc, inr, storeUrl, copy, viewOnly, dateShort, render, reload: reloadReport });   // Sprint 3 A-money (money.js)
  window.SW_ROLES?.start(state);   // land on the chosen role's home page (SW-020)
  load().catch((e) => { $('#view').innerHTML = `<p class="pad">Couldn’t load: ${esc(e.message)}</p>`; });
})();
