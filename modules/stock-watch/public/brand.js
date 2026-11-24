/* 1.4.0 (LOGIC §20–§23): the agency's pages. Loaded before app.js; app.js calls SW_BRAND.init(ctx) and adds the views.
 *   brand  Brand report (home): 12 months, best sellers that ran out, money missed per month, month → products, CSV
 *   best   Best sellers now: in stock or out (since when), this month's empty days and money missed, refill state
 *   ads    Ads: push what's in stock and selling, pause what can't be bought
 *   drawer the product's 12 months: day calendar, normal pace, busy / quiet months, money missed per month
 * Data: GET /api/brand (once per store load; it carries `now` and `ads` built on today's report). Copy follows
 * .claude/skills/plain-copy: short sentences, every number with its dates. */
(() => {
  'use strict';
  let A = null;   // from app.js: { state, api, esc, inr, table, nameCell, saveCsv, copy, toast, render, status, dateShort, dt, viewOnly, rate }
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const esc = (x) => A.esc(x);
  const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
  /** Money people can hold: ₹740, ₹7.4k, ₹74k, ₹4.8 lakh, ₹1.3 Cr (exact in the title). */
  const rs = (x) => {
    const v = Math.round(+x || 0), a = Math.abs(v), s = v < 0 ? '−' : '';
    const one = (n) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10).toLocaleString('en-IN');
    if (a >= 1e7) return `${s}₹${one(a / 1e7)} Cr`;
    if (a >= 1e5) return `${s}₹${one(a / 1e5)} lakh`;
    if (a >= 1e3) return `${s}₹${one(a / 1e3)}k`;
    return `${s}₹${inr.format(a)}`;
  };
  const exact = (x) => `₹${inr.format(Math.round(+x || 0))}`;
  const money = (x) => `<span title="${exact(x)}">${rs(x)}</span>`;
  const day = (k) => (k ? `${+k.slice(8, 10)} ${MON[+k.slice(5, 7) - 1]}` : '–');
  const dayY = (k) => (k ? `${day(k)} ${k.slice(0, 4)}` : '–');
  const span = (a, b) => (a && b ? (a.slice(0, 4) === b.slice(0, 4) ? `${day(a)} – ${dayY(b)}` : `${dayY(a)} – ${dayY(b)}`) : '');
  const monthName = (m) => `${MONTH[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
  const mShort = (m) => MON[+m.slice(5, 7) - 1];
  const nDays = (x) => { const v = Math.round((+x || 0) * 2) / 2; return `${v.toLocaleString('en-IN')} day${v === 1 ? '' : 's'}`; };
  const units = (x) => { const v = +x || 0; return v >= 10 ? inr.format(Math.round(v)) : v >= 1 ? String(Math.round(v)) : v > 0 ? 'under 1' : '0'; };
  /** "5 a week", "1 a day", "2 a month" */
  const pace = (perDay) => {
    if (!(perDay > 0)) return 'no sales';
    if (perDay >= 0.95) return `${Math.round(perDay).toLocaleString('en-IN')} a day`;
    if (perDay * 7 >= 0.95) return `${Math.round(perDay * 7)} a week`;
    return `${Math.max(1, Math.round(perDay * 30.4))} a month`;
  };
  const S = () => A.state;
  const B = () => S().brand;
  const loading = '<p class="muted pad">Reading the 12 months…</p>';

  async function fetchBrand(force = false) {
    const st = S();
    if (st.brand && !force) return st.brand;
    if (st.brandLoading) return st.brandLoading;
    st.brandLoading = A.api('/api/brand').then((j) => { st.brand = j; badge(j); return j; }).catch((e) => { st.brand = { ok: false, error: e.message }; return st.brand; }).finally(() => { st.brandLoading = null; });
    return st.brandLoading;
  }
  /** The rail's badge: best sellers out right now. */
  const badge = (j) => { const el = document.getElementById('n-best'); if (!el) return; const n = ((j && j.now) || []).filter((p) => p.out).length; el.textContent = n || ''; el.title = `${n} best sellers out of stock now`; };
  const need = () => { if (!B()) { fetchBrand().then(() => A.render()); return true; } return false; };
  const notReady = (b) => `<section class="headline"><h1>No 12-month history yet</h1><p>${b && b.error ? esc(b.error) : 'It is read from Shopify’s reports after the first pull (the Shopify token needs read_reports). Until then the other pages work as before.'}</p></section>`;
  const bestShare = () => Math.round(((B().settings || {}).bestShare || 0.8) * 100);

  /* ---------- Brand report ---------- */
  function chart(months, w) {
    const W = Math.max(300, Math.round(w)), H = 210, L = 54, R = 8, T = 22, Bm = 26;
    const max = Math.max(1, ...months.map((m) => m.sold + m.lost));
    const step = niceStep(max / 4), top = Math.ceil(max / step) * step;
    const y = (v) => T + (H - T - Bm) * (1 - v / top);
    const bw = (W - L - R) / months.length, gap = Math.min(10, bw * 0.25);
    const ticks = []; for (let v = 0; v <= top; v += step) ticks.push(`<g><line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="gl"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${rs(v)}</text></g>`);
    const sel = S().brandMonth;
    const bars = months.map((m, i) => {
      const x = L + i * bw + gap / 2, w2 = bw - gap;
      const tip = `${monthName(m.key)}: sold ${exact(m.sold)}; best sellers ran out for ${nDays(m.daysOut)}, about ${exact(m.lost)} missed (${m.pct}% of sales)${m.days && m.days < 28 ? ` · ${m.days} days held` : ''}`;
      return `<g class="mb${sel === m.key ? ' on' : ''}" data-month="${m.key}" tabindex="0" role="button" aria-label="${esc(tip)}"><title>${esc(tip)}</title>
        <rect class="hit" x="${L + i * bw}" y="${T - 18}" width="${bw}" height="${H - T + 18}"/>
        <rect class="sold" x="${x}" y="${y(m.sold)}" width="${w2}" height="${Math.max(0, y(0) - y(m.sold))}" rx="2"/>
        ${m.lost > 0 ? `<rect class="lost" x="${x}" y="${y(m.sold + m.lost)}" width="${w2}" height="${Math.max(1.5, y(m.sold) - y(m.sold + m.lost))}" rx="2"/>` : ''}
        ${m.lost > 0 && bw > 30 ? `<text class="lv" x="${x + w2 / 2}" y="${y(m.sold + m.lost) - 5}" text-anchor="middle">${rs(m.lost)}</text>` : ''}
        <text x="${x + w2 / 2}" y="${H - 8}" text-anchor="middle">${mShort(m.key)}</text></g>`;
    }).join('');
    return `<svg class="bchart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Sold and money missed each month">${ticks.join('')}${bars}</svg>`;
  }
  function niceStep(x) { const p = 10 ** Math.floor(Math.log10(Math.max(1, x))); const m = x / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }
  const heat = (d) => (d <= 0 ? 0 : d < 3 ? 1 : d < 8 ? 2 : d < 15 ? 3 : 4);

  function brandView() {
    if (need()) return loading;
    const b = B();
    if (!b.ok) return notReady(b);
    const h = b.headline, months = b.months.filter((m) => m.days), sel = S().brandMonth || defaultMonth(b);
    S().brandMonth = sel;
    const held = b.span.days;
    const when = held >= 360 ? 'in the last 12 months' : `since ${dayY(h.from)}`;
    const y = b.year || {};
    const stale = b.basis === 'rows' ? '<p class="note">From the days we hold. Shopify’s 12 months aren’t read yet.</p>' : y.done === false ? `<p class="note">${esc(y.note || 'Still reading 12 months from Shopify.')}</p>` : '';
    const best = b.products.filter((p) => p.best && p.daysOut > 0);
    const all = S().brandAll ? b.products.filter((p) => p.best).length : Math.min(12, best.length);
    const ms = b.months.map((m) => m.key);
    return `
      <section class="headline brand-h">
        <h1>Best sellers ran out on <span class="lost">${inr.format(Math.round(h.daysOut))} days</span> ${when}.</h1>
        <p class="lead">Money we missed: about <b class="lostv">${money(h.lost)}</b>. That is ${h.pct}% of what the brand sold (${money(h.sold)}), ${span(h.from, h.through)}.</p>
        <p class="muted small">${h.bestRanOut} of ${h.bestsellers} best sellers ran out. Best sellers = the products that make ${bestShare()}% of sales. Sales up to ${dayY(b.asOf.through)}; stock read ${b.asOf.stockAt ? esc(A.dt(b.asOf.stockAt)) : '–'}.${h.unsure ? ` ${h.unsure} product${h.unsure === 1 ? '' : 's'} left out: Shopify’s stock log doesn’t add up for ${h.unsure === 1 ? 'it' : 'them'}.` : ''}</p>
        ${stale}
        <details class="how exp"><summary>How we count</summary><p>A day is “out” when the shelf was empty all day: nobody could buy it. Half a day when it ran out or came back that day. “Would have sold” = how fast it sells on days it is in stock (last ${(b.settings || {}).paceMonths || 6} months), made busier or quieter for the month (Diwali sells more than June). Money missed = would have sold × the price people paid. All from Shopify’s own sales and stock reports, so every number can be checked there.</p></details>
      </section>
      <div class="bgrid">
        <div class="panel"><div class="panel-head"><h2>Sold and missed, each month</h2><span class="muted small"><i class="sw sold"></i> sold <i class="sw lost"></i> missed (best sellers)</span></div><div id="brand-chart">${chart(months, 600)}</div></div>
        <div class="panel"><div class="panel-head"><h2>Month by month</h2><button class="btn ghost xs" id="csv-months">Download CSV</button></div>
          <table class="mtable"><thead><tr><th>Month</th><th class="r">Sold</th><th class="r">Missed</th><th class="r m-hide">% of sales</th><th class="r">Best sellers out</th><th class="r m-hide">Days out</th></tr></thead>
          <tbody>${months.map((m) => `<tr data-month="${m.key}" tabindex="0" class="${m.key === sel ? 'on' : ''}"><td>${esc(monthName(m.key))}${m.days < 28 ? ` <small class="muted">${m.from === m.to ? day(m.from) : `${+m.from.slice(8, 10)}–${day(m.to)}`}</small>` : ''}</td><td class="r">${money(m.sold)}</td><td class="r"><b class="${m.lost ? 'lostv' : 'muted'}">${m.lost ? money(m.lost) : '–'}</b></td><td class="r m-hide">${m.pct ? `${m.pct}%` : '–'}</td><td class="r">${m.bestOut || '–'}</td><td class="r m-hide">${m.daysOut ? inr.format(Math.round(m.daysOut)) : '–'}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td>${months.length} months</td><td class="r">${money(h.sold)}</td><td class="r"><b class="lostv">${money(h.lost)}</b></td><td class="r m-hide">${h.pct}%</td><td class="r">${h.bestRanOut}</td><td class="r m-hide">${inr.format(Math.round(h.daysOut))}</td></tr></tfoot></table></div>
      </div>
      <div class="panel"><div class="panel-head"><h2>Which best sellers ran out, and when</h2><span class="muted small">Days the shelf was empty each month. Darker = longer. Tap a month to see the list.</span></div>
        ${best.length ? `<div class="heat" style="--mcols:${ms.length}"><div class="hrow hhead"><span></span>${ms.map((m) => `<button class="hm${m === sel ? ' on' : ''}" data-month="${m}" title="${esc(monthName(m))}">${mShort(m)}</button>`).join('')}<span class="r">Missed</span></div>
          ${best.slice(0, all).map((p) => `<div class="hrow"><span class="hp" data-product="${esc(p.variantId)}" tabindex="0" role="button">${SW_PROD.cell(p, { size: 32 })}</span>${ms.map((m) => { const x = p.months && p.months[m]; const d = x ? x.daysOut : 0; return `<span class="hc h${heat(d)}${m === sel ? ' on' : ''}" data-month="${m}" title="${esc(x && d ? `${p.name}: out ${nDays(d)} in ${monthName(m)} (${x.range}). About ${exact(x.lost)} missed.` : `${p.name}: in stock all of ${monthName(m)}`)}">${d ? Math.round(d) || '½' : ''}</span>`; }).join('')}<span class="r hv"><b class="lostv">${money(p.lost)}</b></span></div>`).join('')}
          ${best.length > 12 ? `<div class="more"><button class="btn ghost" id="brand-all">${S().brandAll ? 'Show the top 12' : `Show all ${best.length}`}</button></div>` : ''}</div>` : '<p class="muted">No best seller ran out in these months.</p>'}
      </div>
      ${monthDetail(b, sel)}`;
  }
  /** The newest month with money missed (else the newest). */
  const defaultMonth = (b) => { const ms = b.months.filter((m) => m.days); return (ms.slice().reverse().find((m) => m.lost > 0) || ms[ms.length - 1] || {}).key; };
  function monthRows(b, m, all = S().brandMonthAll) {
    return b.products.filter((p) => (all || p.best) && p.months && p.months[m] && (p.months[m].daysOut > 0 || p.months[m].lost > 0))
      .map((p) => ({ ...p, id: p.variantId, x: p.months[m] })).sort((a, c) => c.x.lost - a.x.lost || c.x.daysOut - a.x.daysOut);
  }
  function monthDetail(b, m) {
    if (!m) return '';
    const mm = b.months.find((x) => x.key === m) || {};
    const rows = monthRows(b, m);
    const lost = rows.reduce((s, p) => s + p.x.lost, 0);
    const lead = rows.length ? `${monthName(m)}: ${rows.length} ${S().brandMonthAll ? 'product' : 'best seller'}${rows.length === 1 ? '' : 's'} ran out. We missed about ${rs(lost)}.` : `${monthName(m)}: no ${S().brandMonthAll ? 'product' : 'best seller'} ran out.`;
    const cols = [
      { k: 'name', label: 'Product', f: (p) => A.nameCell(p, false) },
      { k: 'range', label: 'Ran out on', f: (p) => `<span class="rng" title="${esc(p.x.range)}">${esc(p.x.range)}</span>`, val: (p) => p.x.dates[0] || '' },
      { k: 'daysOut', label: 'Days out', r: 1, f: (p) => inr.format(Math.round(p.x.daysOut * 2) / 2), val: (p) => p.x.daysOut },
      { k: 'units', label: 'Would have sold', r: 1, tip: 'How fast it sells on days it is in stock, for this month', f: (p) => `<span title="${(Math.round(p.x.units * 10) / 10).toLocaleString('en-IN')} at ${pace(p.pace.perDay)}">about ${units(p.x.units)}</span>`, val: (p) => p.x.units },
      { k: 'lost', label: 'Money missed', r: 1, f: (p) => `<b class="lostv">${money(p.x.lost)}</b>`, val: (p) => p.x.lost },
    ];
    return `<section class="panel" id="month-detail"><div class="panel-head"><h2>${esc(lead)}</h2>
        <span class="tb"><label class="chk"><input type="checkbox" id="month-all" ${S().brandMonthAll ? 'checked' : ''}> all products</label><button class="btn ghost xs" id="csv-month">Download CSV</button></span></div>
      <p class="muted small">${mm.from ? span(mm.from, mm.to) : ''} · sold ${money(mm.sold || 0)} that month.</p>
      ${A.table('brandmonth', cols, rows, 'Nothing ran out this month.', (p) => `<header><h3>${A.nameCell(p, false)}</h3><div class="mq"><b class="lostv">${money(p.x.lost)}</b><small>missed</small></div></header>
        <div class="mfacts"><span>Ran out <b>${esc(p.x.range)}</b></span><span><b>${inr.format(Math.round(p.x.daysOut * 2) / 2)}</b> days</span><span>would have sold <b>${units(p.x.units)}</b></span></div>`)}</section>`;
  }
  function csvMonths() {
    const b = B();
    const head = ['Month', 'From', 'To', 'Sold ₹ (net, ex GST)', 'Missed ₹ (best sellers)', '% of sales', 'Best sellers out', 'Days out (best sellers)', 'Missed ₹ (all products)'];
    const rows = b.months.filter((m) => m.days).map((m) => [monthName(m.key), m.from, m.to, m.sold, m.lost, m.pct, m.bestOut, m.daysOut, m.lostAll]);
    A.saveCsv(`brand-report-months-${b.asOf.through}.csv`, [head, ...rows]);
  }
  function csvMonth() {
    const b = B(), m = S().brandMonth;
    const head = ['Month', 'Product', 'SKU', 'Variant ID', 'Best seller', 'Ran out on', 'Out-of-stock dates', 'Days out', 'Would have sold (units)', 'Pace (units a day, in stock)', 'Average price paid ₹', 'Money missed ₹', ...SW_PROD.CSV_HEAD];
    const rows = monthRows(b, m).map((p) => [monthName(m), p.name, p.sku, p.variantId, p.best ? 'yes' : 'no', p.x.range, p.x.dates.join(' '), p.x.daysOut, Math.round(p.x.units * 10) / 10, p.pace.perDay, p.price, p.x.lost, ...SW_PROD.csv(p)]);
    A.saveCsv(`brand-report-${m}.csv`, [head, ...rows]);
  }

  /* ---------- Best sellers now ---------- */
  function bestView() {
    if (need()) return loading;
    const b = B();
    if (!b.ok) return notReady(b);
    const rows = b.now || [], out = rows.filter((p) => p.out), m = b.months[b.months.length - 1];
    const lost = rows.reduce((s, p) => s + (p.lostMonth || 0), 0);
    const nowCell = (p) => (p.out ? `<span class="st g-today">Out${p.outSince ? ` since ${esc(A.dateShort(p.outSince))}` : ''}</span>${p.variantsLive > 1 ? ` <small class="muted">${p.outVariants} of ${p.variantsLive} options</small>` : ''}` : `<span class="st ok">In stock · ${inr.format(p.stock)}</span>`);
    const refill = (p) => (p.onOrder ? `<span class="st g-ordered">Ordered · lands ${esc(A.dateShort(p.onOrder.eta))}</span>` : p.orderQty > 0 ? `<span class="st g-week">Order ${inr.format(p.orderQty)} now</span>` : p.out ? '<span class="st g-today">Not ordered</span>' : '<span class="muted">Enough stock</span>');
    const cols = [
      { k: 'name', label: 'Best seller', f: (p) => A.nameCell(p, false) },
      { k: 'out', label: 'Now', f: nowCell, val: (p) => (p.out ? 1 : 0) },
      { k: 'daysOutMonth', label: `Days out in ${mShort(m.key)}`, r: 1, f: (p) => (p.daysOutMonth ? `<span title="${esc(p.rangeMonth)}">${inr.format(Math.round(p.daysOutMonth * 2) / 2)}</span>` : '–') },
      { k: 'lostMonth', label: `Missed in ${mShort(m.key)}`, r: 1, f: (p) => (p.lostMonth ? `<b class="lostv">${money(p.lostMonth)}</b>` : '–') },
      { k: 'pace', label: 'Sells', r: 1, tip: 'How fast it sells on days it is in stock (last 6 months)', f: (p) => esc(pace(p.pace.perDay)), val: (p) => p.pace.perDay },
      { k: 'refill', label: 'Refill', f: refill, val: (p) => (p.onOrder ? 1 : p.orderQty > 0 ? 2 : p.out ? 3 : 0) },
    ];
    return `<section class="headline"><h1>${out.length ? `<span class="lost">${out.length} of ${rows.length}</span> best sellers are out right now.` : `All ${rows.length} best sellers are in stock.`}</h1>
        <p>${lost ? `This month so far (${span(m.from, m.to)}) best sellers missed about <b class="lostv">${money(lost)}</b>.` : `Nothing missed this month so far (${span(m.from, m.to)}).`} ${out.filter((p) => !p.onOrder).length ? `${out.filter((p) => !p.onOrder).length} out and not ordered.` : ''}</p>
        <p class="muted small">Best sellers = the products that make ${bestShare()}% of the last 12 months’ sales. Tap one to mark it ordered.</p></section>
      ${A.table('best', cols, rows, 'No best sellers yet.', (p) => `<header><h3>${A.nameCell(p, false)}</h3><div class="mq">${p.lostMonth ? `<b class="lostv">${money(p.lostMonth)}</b><small>missed in ${mShort(m.key)}</small>` : '<b class="muted">–</b>'}</div></header>
        <div class="mfacts">${nowCell(p)}${p.daysOutMonth ? `<span><b>${inr.format(Math.round(p.daysOutMonth * 2) / 2)}</b> days out in ${mShort(m.key)}</span>` : ''}${refill(p)}</div>`)}`;
  }

  /* ---------- Ads: push / pause ---------- */
  function adsView() {
    if (need()) return loading;
    const b = B();
    const ads = (b && b.ads) || { push: [], pause: [] };
    const top = S().adsAll ? 1e9 : 25;
    const pushRow = (p) => `<div class="arow" data-product="${esc(p.id)}" tabindex="0" role="button">${SW_PROD.cell(p, { extra: p.best ? '<span class="best">Best seller</span>' : '' })}<span class="af"><b>${esc(pace(p.pace))}</b><small>${inr.format(p.coverWeeks)} weeks of stock</small></span></div>`;
    const pauseRow = (p) => `<div class="arow" data-product="${esc(p.id)}" tabindex="0" role="button">${SW_PROD.cell(p, { extra: p.best ? '<span class="best">Best seller</span>' : '' })}<span class="af"><b class="${p.stock <= 0 ? 'lostv' : 'amberv'}">${p.stock <= 0 ? `Out${p.outSince ? ` since ${esc(A.dateShort(p.outSince))}` : ''}` : `${Math.max(0, Math.round(p.daysLeft || 0))} day${Math.round(p.daysLeft || 0) === 1 ? '' : 's'} left`}</b><small>${esc(p.backIn || '')}</small></span></div>`;
    const list = (kind, rows, row, empty) => `<div class="alist">${rows.slice(0, top).map(row).join('') || `<p class="muted">${empty}</p>`}${rows.length > top ? `<div class="more"><button class="btn ghost" id="ads-all">Show all ${rows.length}</button></div>` : ''}</div>`;
    return `<section class="headline"><h1>Push <span class="okv">${ads.push.length}</span> in stock. Pause <span class="lost">${ads.pause.length}</span> that can’t be bought.</h1>
        <p class="muted small">Push = in stock, selling, with at least ${Math.round((ads.coverDays || 21) / 7)} weeks of stock: ads won’t empty the shelf. Pause = out of stock, or it runs out before a refill can land. Best sellers first.</p></section>
      <div class="ads2">
        <div class="panel"><div class="panel-head"><h2>Push in ads</h2><span class="tb"><button class="btn ghost xs" data-ads-copy="push">Copy list</button><button class="btn ghost xs" data-ads-csv="push">CSV</button></span></div>
          <p class="muted small">Most money a day first.</p>${list('push', ads.push, pushRow, 'Nothing has enough stock to push.')}</div>
        <div class="panel"><div class="panel-head"><h2>Pause ads</h2><span class="tb"><button class="btn ghost xs" data-ads-copy="pause">Copy list</button><button class="btn ghost xs" data-ads-csv="pause">CSV</button></span></div>
          <p class="muted small">Shoppers can’t buy these. Ads on them waste money.</p>${list('pause', ads.pause, pauseRow, 'Every selling product is in stock.')}</div>
      </div>`;
  }
  function adsCsv(kind) {
    const rows = (B().ads || {})[kind] || [];
    const head = kind === 'push' ? ['Product', 'SKU', 'Variant ID', 'Best seller', 'Sells (units a day)', 'In stock', 'Weeks of stock', '₹ a day it can sell'] : ['Product', 'SKU', 'Variant ID', 'Best seller', 'In stock', 'Days left', 'Back in stock', 'Sells (units a day)'];
    const body = rows.map((p) => [...(kind === 'push' ? [p.name, p.sku, p.id, p.best ? 'yes' : 'no', p.pace, p.stock, p.coverWeeks, p.perDayValue] : [p.name, p.sku, p.id, p.best ? 'yes' : 'no', p.stock, p.daysLeft ?? '', p.backIn || '', p.pace]), ...SW_PROD.csv(p)]);
    A.saveCsv(`${kind === 'push' ? 'push-in-ads' : 'pause-ads'}-${new Date().toISOString().slice(0, 10)}.csv`, [[...head, ...SW_PROD.CSV_HEAD], ...body]);
  }

  /* ---------- drawer: the product's 12 months ---------- */
  function drawerYear(y) {
    if (!y || !y.ok) return y && y.reason === 'unsure' ? '<div class="panel"><h2>12 months</h2><p class="muted small">Shopify’s stock log doesn’t add up for this product, so its past days aren’t shown.</p></div>' : '';
    const cal = y.calendar || [];
    if (!cal.length) return '';
    const first = cal[0][0], dow = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;   // Monday first
    const cells = [...Array(dow).fill('<i class="cd e"></i>'), ...cal.map(([k, f]) => `<i class="cd ${f >= 1 ? 'in' : f > 0 ? 'half' : 'out'}" title="${esc(`${dayY(k)}: ${f >= 1 ? 'in stock' : f > 0 ? 'ran out or came back' : 'out of stock'}`)}"></i>`)].join('');
    const outDays = cal.reduce((s, [, f]) => s + (1 - f), 0);
    const p = y.pace || {}, sea = Object.entries(y.season || {}).sort((a, b) => b[1] - a[1]);
    const busy = sea.filter(([, v]) => v >= 1.15).slice(0, 3), quiet = sea.filter(([, v]) => v <= 0.85).slice(-3).reverse();
    const lostMonths = Object.entries(y.months || {}).filter(([, x]) => x.lost > 0 || x.daysOut > 0).sort((a, b) => (a[0] < b[0] ? 1 : -1));
    return `<div class="panel ycal"><div class="panel-head"><h2>12 months on the shelf</h2><span class="muted small">${span(y.span.from, y.span.through)}</span></div>
      <p class="small">${outDays ? `Out of stock on <b class="lostv">${nDays(outDays)}</b>.` : 'In stock every day.'} ${p.perDay > 0 ? `Normal pace: <b>${(Math.round(p.perDay * 100) / 100).toLocaleString('en-IN')} a day</b> (about ${Math.round(p.perDay * 7)} a week, ${Math.round(p.perDay * 30.4)} a month), from ${p.basis === 'year' ? '12 months' : `${p.months || 6} months`} of days in stock.` : 'No sales on days in stock.'}</p>
      <div class="cal" aria-label="Each square is a day; red = out of stock">${cells}</div>
      <p class="muted small"><i class="sw in"></i> in stock <i class="sw half"></i> ran out or came back <i class="sw out"></i> out${busy.length ? ` · busy: ${busy.map(([m, v]) => `${mShort(m)} ×${v}`).join(', ')}` : ''}${quiet.length ? ` · quiet: ${quiet.map(([m, v]) => `${mShort(m)} ×${v}`).join(', ')}` : ''}</p>
      ${lostMonths.length ? `<div class="ylost">${lostMonths.map(([m, x]) => `<p><b>${esc(monthName(m))}:</b> ran out ${esc(x.range)} (${nDays(x.daysOut)}). It would have sold about ${units(x.units)}. <b class="lostv">${money(x.lost)}</b> missed.</p>`).join('')}</div>` : ''}</div>`;
  }

  /* ---------- events ---------- */
  document.addEventListener('click', (e) => {
    if (!A) return;
    const t = e.target.closest('[data-month], #csv-months, #csv-month, #brand-all, #ads-all, [data-ads-copy], [data-ads-csv], #month-all');
    if (!t) return;
    if (t.dataset.month) { S().brandMonth = t.dataset.month; S().limit.brandmonth = 0; A.render(); document.getElementById('month-detail')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return; }
    if (t.id === 'csv-months') return csvMonths();
    if (t.id === 'csv-month') return csvMonth();
    if (t.id === 'brand-all') { S().brandAll = !S().brandAll; A.render(); return; }
    if (t.id === 'ads-all') { S().adsAll = true; A.render(); return; }
    if (t.id === 'month-all') { S().brandMonthAll = t.checked; A.render(); return; }
    if (t.dataset.adsCopy) { const rows = (B().ads || {})[t.dataset.adsCopy] || []; A.copy(rows.map((p) => `${p.sku || p.id}\t${p.name}`).join('\n')); return; }
    if (t.dataset.adsCsv) adsCsv(t.dataset.adsCsv);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-month]:not(button)')) { e.preventDefault(); e.target.click(); }
  });
  /* the chart at its box's real width (no scaling), like the daily chart */
  function after(view) {
    if (view !== 'brand' || !B() || !B().ok) return;
    const box = document.getElementById('brand-chart'), svg = box && box.querySelector('svg');
    if (!svg) return;
    const w = Math.floor(box.clientWidth);
    if (w > 0 && Math.abs(w - +svg.getAttribute('width')) > 1) svg.outerHTML = chart(B().months.filter((m) => m.days), w);
  }

  window.SW_BRAND = {
    init(ctx) { A = ctx; },
    views: { brand: brandView, best: bestView, ads: adsView },
    fetch: fetchBrand, reset() { if (A) { A.state.brand = null; } }, after, drawerYear, rs, pace,
  };
})();
