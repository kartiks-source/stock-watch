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
  /** 1.4.6: the report is the last 365 days, so it can hold 13 months, the first only its last days ("25–30 Nov 2025"); its
      short label carries the year when the same month is there twice. */
  const partOf = (m) => !!(m && m.from && m.from.slice(8) !== '01');
  const monthText = (m) => (partOf(m) ? (m.from === m.to ? dayY(m.from) : `${+m.from.slice(8, 10)}–${dayY(m.to)}`) : monthName(m.key));
  const shortLabel = (k, keys) => (keys.filter((x) => x.slice(5) === k.slice(5)).length > 1 && k === keys.find((x) => x.slice(5) === k.slice(5)) ? `${mShort(k)} ’${k.slice(2, 4)}` : mShort(k));
  const pct = (x) => `${(Math.round((+x || 0) * 10) / 10).toLocaleString('en-IN')}%`;
  const nDays = (x) => { const v = Math.round((+x || 0) * 2) / 2; return `${v.toLocaleString('en-IN')} day${v === 1 ? '' : 's'}`; };
  const units = (x) => { const v = +x || 0; return v >= 10 ? inr.format(Math.round(v)) : v >= 1 ? String(Math.round(v)) : v > 0 ? 'less than 1' : '0'; };
  const about = (x) => ((+x || 0) >= 1 ? `about ${units(x)}` : units(x));   // never "about less than 1"
  /** Units behind the counted money (1.4.6: countedUnits from the server). */
  const countedUnits = (x) => (x.countedUnits != null ? x.countedUnits : x.lost > 0 ? x.units * ((x.counted ?? x.lost) / x.lost) : x.units);
  const counted = (p) => p.counted ?? p.lost ?? 0;
  const narrow = () => matchMedia('(max-width: 759.98px)').matches;
  /** "5 a week", "1 a day", "2 a month" */
  const pace = (perDay) => {
    if (!(perDay > 0)) return 'no sales';
    if (perDay >= 0.95) return `${Math.round(perDay).toLocaleString('en-IN')} a day`;
    if (perDay * 7 >= 0.95) return `${Math.round(perDay * 7)} a week`;
    return `${Math.max(1, Math.round(perDay * 30.4))} a month`;
  };
  const S = () => A.state;
  /* 1.4.4: "Best sellers | All products" for every part of the brand report; All products by default, remembered on this
     browser once changed, ?view=best / ?view=all win */
  const SCOPE_KEY = 'sw-brand-scope';
  const scope = () => {
    const st = S();
    if (!st.brandScope) { let v = null; try { v = new URLSearchParams(location.search).get('view'); } catch { /* */ } if (v !== 'all' && v !== 'best') { try { v = localStorage.getItem(SCOPE_KEY); } catch { /* */ } } st.brandScope = v === 'best' ? 'best' : 'all'; }   // 1.4.4: All products unless chosen otherwise
    return st.brandScope;
  };
  const setScope = (v) => { S().brandScope = v; S().brandAll = false; try { localStorage.setItem(SCOPE_KEY, v); } catch { /* private window */ } };
  const scopeName = (sc = scope(), one = false) => (sc === 'all' ? (one ? 'product' : 'all products') : (one ? 'best seller' : 'best sellers'));
  const scopeSwitch = () => `<div class="scope" role="group" aria-label="Which products">${[['best', 'Best sellers'], ['all', 'All products']].map(([k, l]) => `<button class="${scope() === k ? 'on' : ''}" data-scope="${k}" aria-pressed="${scope() === k}">${l}</button>`).join('')}</div>`;
  /** 1.4.4: the line under the headline of Restock list, All products and Best sellers now: "₹X missed · all products · <dates>"
      with the other scope beside it and the switch. all / best = counted ₹ (LOGIC §4c). */
  const scopeLine = (all, best, dates, { sw = true } = {}) => {
    const sc = scope(), a = `<b class="lostv">${money(all)}</b> missed · all products`, b = `<b class="lostv">${money(best)}</b> · best sellers`;
    return `<div class="scopeline" id="scope-line">${sw ? scopeSwitch() : ''} <span>${sc === 'all' ? `${a} <span class="muted">(${b.replace(/<[^>]+>/g, '')})</span>` : `${b} <span class="muted">(${a.replace(/<[^>]+>/g, '')})</span>`} · ${esc(dates)}</span></div>`;
  };
  /** A month or the headline seen through the scope: lost (counted), parts kept apart, ran out, days out. */
  const inScopeOf = (m, k) => (m && m[k] ? m[k] : { lost: m ? m.lost : 0 });
  const inScope = (m) => (m && m[scope()] ? { ...m, ...m[scope()], bestOut: m[scope()].out ?? m.bestOut } : m);
  /** "Not counted" in one small line (the same parts as every page, LOGIC §4c, §22). */
  const apartLine = (h) => { const parts = [h.nr ? `${rs(h.nr)} where nothing was ordered for 30+ days (restock or drop?)` : '', h.est ? `${rs(h.est)} a guess: products that hardly sell` : '', h.apart ? `${rs(h.apart)} while the warehouse topped up a few pieces` : ''].filter(Boolean); return parts.length ? `<p class="muted small" id="brand-apart">Not counted in ${rs(h.lost)}: ${parts.join(' · ')}.</p>` : ''; };
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
  const notReady = (b) => b && b.error ? `<section class="headline"><h1>Couldn’t load the 12 months.</h1><p>${esc(b.error)}</p><p><button class="btn" id="brand-retry">Try again</button></p></section>` : `<section class="headline"><h1>No 12-month history yet</h1><p>It is read from Shopify’s reports after the first pull (the Shopify token needs read_reports). Until then the other pages work as before.</p></section>`;
  const bestShare = () => Math.round(((B().settings || {}).bestShare || 0.8) * 100);

  /* ---------- Brand report ---------- */
  function chart(months, w) {
    const W = Math.max(300, Math.round(w)), H = 210, L = 54, R = 8, T = 22, Bm = 26;
    const max = Math.max(1, ...months.map((m) => m.sold + m.lost));
    const step = niceStep(max / 4), top = Math.ceil(max / step) * step;
    const y = (v) => T + (H - T - Bm) * (1 - v / top);
    const bw = (W - L - R) / months.length, gap = Math.min(10, bw * 0.25);
    const ticks = []; for (let v = 0; v <= top; v += step) ticks.push(`<g><line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="gl"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${rs(v)}</text></g>`);
    const sel = S().brandMonth, keys = months.map((m) => m.key), who = scope() === 'all' ? ['product', 'products'] : ['best seller', 'best sellers'];
    const bars = months.map((m, i) => {
      const x = L + i * bw + gap / 2, w2 = bw - gap;
      const tip = `${monthText(m)}: sold ${exact(m.sold)}; ${inr.format(m.bestOut || 0)} ${who[m.bestOut === 1 ? 0 : 1]} ran out, about ${exact(m.lost)} missed (${m.pct}% of sales)${m.days && m.days < 28 ? ` · ${m.days} days` : ''}`;
      return `<g class="mb${sel === m.key ? ' on' : ''}${m.days && m.days < 28 ? ' part' : ''}" data-month="${m.key}" tabindex="0" role="button" aria-label="${esc(tip)}"><title>${esc(tip)}</title>
        <rect class="hit" x="${L + i * bw}" y="${T - 18}" width="${bw}" height="${H - T + 18}"/>
        <rect class="sold" x="${x}" y="${y(m.sold)}" width="${w2}" height="${Math.max(0, y(0) - y(m.sold))}" rx="2"/>
        ${m.lost > 0 ? `<rect class="lost" x="${x}" y="${y(m.sold + m.lost)}" width="${w2}" height="${Math.max(1.5, y(m.sold) - y(m.sold + m.lost))}" rx="2"/>` : ''}
        ${m.lost > 0 && bw > 30 ? `<text class="lv" x="${x + w2 / 2}" y="${y(m.sold + m.lost) - 5}" text-anchor="middle">${rs(m.lost)}</text>` : ''}
        <text x="${x + w2 / 2}" y="${H - 8}" text-anchor="middle">${narrow() ? mShort(m.key) : shortLabel(m.key, keys)}${m.days && m.days < 28 ? '*' : ''}</text></g>`;
    }).join('');
    return `<svg class="bchart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Sold and money missed each month">${ticks.join('')}${bars}</svg>`;
  }
  function niceStep(x) { const p = 10 ** Math.floor(Math.log10(Math.max(1, x))); const m = x / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }
  /** "since 4 Nov": the day the stock-out began from the 12 months (whole days), else the engine's time; "since before …"
      when it began before the 12 months held */
  const sinceText = (p) => {
    const b = B(), from = b && b.span && b.span.from;
    if (p.outFromDay) return p.outFromDay === from ? ` since before ${dayY(from)}` : ` since ${day(p.outFromDay)}${p.outFromDay.slice(0, 4) !== new Date().toISOString().slice(0, 4) ? ` ${p.outFromDay.slice(0, 4)}` : ''}`;
    return p.outSince ? ` since ${esc(A.dateShort(p.outSince))}` : '';
  };
  /** §6: a website allocation refilled from the warehouse: its gaps are not counted in the totals */
  const topUp = (p) => (p.allocation ? '<span class="best tu" title="Shopify shows a few pieces topped up from the warehouse: these gaps are refill waits, not counted in the totals (LOGIC §6)">website top-up</span>' : '');
  const offSale = (p) => (p.inactive ? '<span class="best tu off" title="Now draft or archived in Shopify. What it missed while on sale stays in the report.">No longer on sale</span>' : '');
  const heat = (d) => (d <= 0 ? 0 : d < 3 ? 1 : d < 8 ? 2 : d < 15 ? 3 : 4);

  function brandView() {
    if (need()) return loading;
    const b = B();
    if (!b.ok) return notReady(b);
    const sc = scope(), h = { ...b.headline, ...b.headline[sc], bestRanOut: (b.headline[sc] || {}).ranOut ?? b.headline.bestRanOut }, months = b.months.filter((m) => m.days).map(inScope), sel = S().brandMonth || defaultMonth(b);
    S().brandMonth = sel;
    const held = b.span.days;
    const when = held >= 360 ? 'in the last 12 months' : `since ${dayY(h.from)}`;
    const y = b.year || {};
    const stale = b.basis === 'rows' ? `<p class="note">History from ${esc(dayY(b.span.from))}: the days we hold. Shopify’s 12 months are read after the next pull.</p>`
      : (y.done === false || held < 360) ? `<p class="note">History from ${esc(dayY(b.span.from))}; the full 12 months after the next pull. Months before then are not read yet (not ₹0).${h.bestsellers ? ' Best sellers are ranked on Shopify’s last 26 weeks until then.' : ''}</p>` : '';
    const best = sc === 'all' ? b.products.filter((p) => p.lost > 0 || p.daysOut > 0).sort((a, c) => counted(c) - counted(a) || c.lost - a.lost) : b.products.filter((p) => p.best && p.daysOut > 0).sort((a, c) => counted(c) - counted(a) || c.lost - a.lost);   // website top-ups stay listed (tagged); their days aren't in the totals
    const top = sc === 'all' ? 50 : 12, all = S().brandAll ? best.length : Math.min(top, best.length);
    const ms = months.map((m) => m.key);   // only months held
    const selM = months.find((m) => m.key === sel);
    const who = sc === 'all' ? `${inr.format(h.ranOut)} product${h.ranOut === 1 ? '' : 's'}` : `${inr.format(h.bestRanOut)} of ${inr.format(h.bestsellers)} best sellers`;
    return `
      <section class="headline brand-h">
        ${scopeSwitch()}
        <h1>${who} ran out ${when}. We missed about <span class="lost">${money(h.lost)}</span>.</h1>
        <p class="lead">Missed on ${scopeName()}: about <b class="lostv">${money(h.lost)}</b>. That is ${pct(h.pct)} of what the brand sold (${money(h.sold)}), ${span(h.from, h.through)}.</p>
        <p class="muted small">${sc === 'all' ? `Empty for about ${nDays(h.daysOut / Math.max(1, h.ranOut))} each.` : `Empty for about ${nDays(h.daysOut / Math.max(1, h.bestRanOut))} each. Best sellers = the products that make ${bestShare()}% of sales.`} Sales up to ${dayY(b.asOf.through)}; stock read ${b.asOf.stockAt ? esc(A.dt(b.asOf.stockAt)) : '–'}.</p>
        ${apartLine(h)}${h.unsure ? `<p class="muted small">${h.unsure} product${h.unsure === 1 ? '' : 's'} left out: Shopify’s stock log doesn’t add up for ${h.unsure === 1 ? 'it' : 'them'}.</p>` : ''}
        ${stale}
        <details class="how exp"><summary>How we count</summary><p>A day is “out” when the shelf was empty all day: nobody could buy it. Half a day when it ran out or came back that day. “Would have sold” = how fast it sells on days it is in stock (last ${(b.settings || {}).paceMonths || 6} months), made busier or quieter for the month (Diwali sells more than June). Money missed = would have sold × the price people paid. All from Shopify’s own sales and stock reports, so every number can be checked there.</p></details>
      </section>
      <div class="bgrid">
        <div class="panel"><div class="panel-head"><h2>Sold and missed, each month</h2><span class="muted small"><i class="sw sold"></i> sold <i class="sw lost"></i> missed (${scopeName()})${months.some((m) => m.days < 28) ? ' · * part of the month' : ''}</span></div><div id="brand-chart">${chart(months, 600)}</div>
          ${selM ? `<p class="month-line" id="month-line"><b>${esc(monthText(selM))}</b>: sold ${money(selM.sold)}, missed <b class="lostv">${money(selM.lost)}</b>, ${inr.format(selM.bestOut || 0)} ran out. <button class="linkbtn" id="see-list">See list</button></p>` : ''}
          ${topFive(best)}</div>
        <div class="panel"><div class="panel-head"><h2>Month by month</h2><button class="btn ghost xs" id="csv-months">Download CSV</button></div>
          <table class="mtable"><thead><tr><th>Month</th><th class="r">Sold</th><th class="r">Missed, ${scopeName()}</th><th class="r m-hide">% of sales</th><th class="r">${sc === 'all' ? 'Products' : 'Best sellers'} out</th><th class="r m-hide">Days out</th></tr></thead>
          <tbody>${months.map((m) => `<tr data-month="${m.key}" tabindex="0" class="${m.key === sel ? 'on' : ''}"><td>${esc(monthText(m))}${m.days < 28 && !partOf(m) ? ` <small class="muted">${m.from === m.to ? day(m.from) : `${+m.from.slice(8, 10)}–${day(m.to)}`}</small>` : ''}</td><td class="r">${money(m.sold)}</td><td class="r"><b class="${m.lost ? 'lostv' : 'muted'}">${m.lost ? money(m.lost) : '–'}</b></td><td class="r m-hide">${m.pct ? pct(m.pct) : '–'}</td><td class="r">${m.bestOut || '–'}</td><td class="r m-hide">${m.daysOut ? inr.format(Math.round(m.daysOut)) : '–'}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td>All of it</td><td class="r">${money(h.sold)}</td><td class="r"><b class="lostv">${money(h.lost)}</b></td><td class="r m-hide">${pct(h.pct)}</td><td class="r">${h.bestRanOut}</td><td class="r m-hide">${inr.format(Math.round(h.daysOut))}</td></tr></tfoot></table></div>
      </div>
      <div class="panel"><div class="panel-head"><h2>Which ${sc === 'all' ? 'products' : 'best sellers'} ran out, and when</h2><span class="muted small">Days the shelf was empty each month. Darker = longer. Tap a month to see the list.</span></div>
        ${best.length ? `<div class="heat" style="--mcols:${ms.length}"><div class="hrow hhead"><span></span>${ms.map((m) => `<button class="hm${m === sel ? ' on' : ''}" data-month="${m}" title="${esc(monthText(months[ms.indexOf(m)]))}">${shortLabel(m, ms)}</button>`).join('')}<span class="r" title="${esc(span(h.from, h.through))}">Missed</span></div>
          ${best.slice(0, all).map((p) => `<div class="hrow"><span class="hp" data-product="${esc(p.variantId)}" tabindex="0" role="button">${SW_PROD.cell(p, { size: 32, extra: topUp(p) + offSale(p) })}</span>${ms.map((m) => { const x = p.months && p.months[m]; const d = x ? x.daysOut : 0; return `<span class="hc h${heat(d)}${m === sel ? ' on' : ''}" data-month="${m}" title="${esc(x && d ? `${p.name}: out ${nDays(d)} in ${monthName(m)} (${x.range}). About ${exact(x.counted ?? x.lost)} missed${x.lost > (x.counted ?? x.lost) + 1 ? ` + ${exact(x.lost - x.counted)} not counted` : ''}.` : `${p.name}: in stock all of ${monthName(m)}`)}">${d ? Math.round(d) || '½' : ''}</span>`; }).join('')}<span class="r hv"><b class="lostv">${money(counted(p))}</b>${p.lost > (p.counted ?? p.lost) + 1 ? `<small class="muted" title="Not counted (restock or drop? / a guess / warehouse top-up)"> +${rs(p.lost - p.counted)}<span class="ph-only"> not counted</span></small>` : ''}<small class="ph-only"> missed</small></span></div>`).join('')}
          ${best.length > top ? `<div class="more"><button class="btn ghost" id="brand-all">${S().brandAll ? `Show the top ${top}` : `Show all ${best.length}`}</button></div>` : ''}</div>` : `<p class="muted">No ${scopeName(sc, true)} ran out in these months.</p>`}
      </div>
      ${monthDetail(b, sel)}`;
  }
  /** 1.4.6: the first screen names them: the five that cost the most (counted), with days and the latest dates. */
  function topFive(list) {
    const five = list.filter((p) => counted(p) > 0).slice(0, 5);
    if (!five.length) return '';
    const last = (p) => { const k = Object.keys(p.months || {}).sort().reverse().find((m) => p.months[m].daysOut > 0); return k ? p.months[k].range : ''; };
    return `<div class="top5"><h3>Cost the most</h3>${five.map((p) => `<div class="t5" data-product="${esc(p.variantId)}" tabindex="0" role="button">${SW_PROD.cell(p, { size: 32, extra: (p.best && scope() === 'all' ? '<span class="best">Best seller</span>' : '') + offSale(p) })}<span class="af"><b class="lostv">${money(counted(p))}</b><small>${esc(nDays(p.daysOut))} out · last ${esc(last(p))}</small></span></div>`).join('')}</div>`;
  }
  /** The newest month with money missed (else the newest). */
  const defaultMonth = (b) => { const ms = b.months.filter((m) => m.days).map(inScope); return (ms.slice().reverse().find((m) => m.lost > 0) || ms[ms.length - 1] || {}).key; };
  function monthRows(b, m, all = scope() === 'all') {
    return b.products.filter((p) => (all || p.best) && p.months && p.months[m] && (p.months[m].daysOut > 0 || p.months[m].lost > 0))
      .map((p) => ({ ...p, id: p.variantId, x: { ...p.months[m], counted: p.months[m].counted ?? p.months[m].lost } })).sort((a, c) => c.x.counted - a.x.counted || c.x.lost - a.x.lost || c.x.daysOut - a.x.daysOut);
  }
  const notCounted = (x) => (x.lost > x.counted + 1 ? ` <small class="muted" title="${esc([x.nr ? `${exact(x.nr)} after day 30 with nothing ordered (restock or drop?)` : '', x.est ? `${exact(x.est)} a guess (hardly sells)` : '', x.apart ? `${exact(x.apart)} warehouse top-up` : ''].filter(Boolean).join(' · '))}">+${rs(x.lost - x.counted)} not counted</small>` : '');
  function monthDetail(b, m) {
    if (!m) return '';
    const mm = b.months.find((x) => x.key === m) || {};
    const rows = monthRows(b, m), ms = inScope(mm);
    const n = ms.bestOut ?? rows.length;
    const lead = rows.length ? `${monthText(mm)}: ${n} ${scope() === 'all' ? (n === 1 ? 'product' : 'products') : scopeName(scope(), n === 1)} ran out. We missed about ${rs(ms.lost)}.` : `${monthText(mm)}: no ${scopeName(scope(), true)} ran out.`;
    const cols = [
      { k: 'name', label: 'Product', f: (p) => SW_PROD.cell(p, { extra: topUp(p) + offSale(p) }) },
      { k: 'range', label: 'Ran out on', f: (p) => `<span class="rng" title="${esc(p.x.range)}">${esc(p.x.range)}</span>`, val: (p) => p.x.dates[0] || '' },
      { k: 'daysOut', label: 'Days out', r: 1, f: (p) => inr.format(Math.round(p.x.daysOut * 2) / 2), val: (p) => p.x.daysOut },
      { k: 'units', label: 'Would have sold', r: 1, tip: 'How fast it sells on days it is in stock, for this month', f: (p) => `<span title="${(Math.round(countedUnits(p.x) * 10) / 10).toLocaleString('en-IN')} at ${pace(p.pace.perDay)}">${p.x.counted > 0 ? about(countedUnits(p.x)) : '–'}</span>`, val: (p) => countedUnits(p.x) },
      { k: 'lost', label: 'Money missed', r: 1, f: (p) => `<b class="lostv">${money(p.x.counted)}</b>${notCounted(p.x)}`, val: (p) => p.x.counted },
    ];
    return `<section class="panel" id="month-detail"><div class="panel-head"><h2>${esc(lead)}</h2>
        <span class="tb"><button class="btn ghost xs" id="csv-month">Download CSV</button></span></div>
      <p class="muted small">${scopeName()} · ${mm.from ? span(mm.from, mm.to) : ''} · sold ${money(mm.sold || 0)} that month.</p>${apartLine(ms)}
      ${A.table('brandmonth', cols, rows, 'Nothing ran out this month.', (p) => `<header><h3>${A.nameCell(p, false)}</h3><div class="mq"><b class="lostv">${money(p.x.counted)}</b><small>missed</small>${notCounted(p.x)}</div></header>
        <div class="mfacts"><span>Ran out <b>${esc(p.x.range)}</b></span><span><b>${esc(nDays(p.x.daysOut))}</b></span>${p.x.counted > 0 ? `<span>would have sold <b>${units(countedUnits(p.x))}</b></span>` : ''}</div>`)}</section>`;
  }
  function csvMonths() {
    const b = B();
    const sc = scope(), w = scopeName(sc);
    const head = ['Month', 'From', 'To', 'Sold ₹ (net, ex GST)', `Missed ₹ (${w}, counted)`, '% of sales', `${sc === 'all' ? 'Products' : 'Best sellers'} out`, `Days out (${w})`, 'Not counted: restock or drop? ₹', 'Not counted: a guess ₹', 'Not counted: warehouse top-up ₹', 'Missed ₹ (all products, every part)'];
    const rows = b.months.filter((m) => m.days).map((m) => { const x = m[sc]; return [monthText(m), m.from, m.to, m.sold, x.lost, x.pct, x.out, x.daysOut, x.nr, x.est, x.apart, m.lostAll]; });
    A.saveCsv(`brand-report-months-${sc === 'all' ? 'all-products' : 'best-sellers'}-${b.asOf.through}.csv`, [head, ...rows]);
  }
  function csvMonth() {
    const b = B(), m = S().brandMonth;
    const head = ['Month', 'Product', 'SKU', 'Variant ID', 'Best seller', 'Ran out on', 'Out-of-stock dates', 'Days out', 'Would have sold (units, counted)', 'Pace (units a day, in stock)', 'Average price paid ₹', 'Money missed ₹ (counted)', 'Not counted ₹ (restock or drop? / a guess / top-up)', ...SW_PROD.CSV_HEAD];
    const rows = monthRows(b, m).map((p) => [monthText(b.months.find((z) => z.key === m) || { key: m }), p.name, p.sku, p.variantId, p.best ? 'yes' : 'no', p.x.range, p.x.dates.join(' '), p.x.daysOut, Math.round(countedUnits(p.x) * 10) / 10, p.pace.perDay, p.price, p.x.counted, Math.max(0, p.x.lost - p.x.counted), ...SW_PROD.csv(p)]);
    A.saveCsv(`brand-report-${scope() === 'all' ? 'all-products' : 'best-sellers'}-${m}.csv`, [head, ...rows]);
  }

  /* ---------- Best sellers now ---------- */
  function bestView() {
    if (need()) return loading;
    const b = B();
    if (!b.ok) return notReady(b);
    const rows = (b.now || []).filter((p) => !p.inactive), out = rows.filter((p) => p.out), m = b.months[b.months.length - 1];
    const lost = rows.reduce((s, p) => s + (p.lostMonth || 0), 0);   // counted: the same ₹ as the month table (1.4.4)
    const nowCell = (p) => (p.out ? `<span class="st g-today">Out${sinceText(p)}</span>${p.variantsLive > 1 ? ` <small class="muted">${p.outVariants} of ${p.variantsLive} options</small>` : ''}` : `<span class="st ok">In stock · ${inr.format(p.stock)}</span>`);
    const refill = (p) => (p.onOrder ? `<span class="st g-ordered">Ordered · lands ${esc(A.dateShort(p.onOrder.eta))}</span>` : p.orderQty > 0 ? `<span class="st g-week">Order ${inr.format(p.orderQty)} now</span>` : p.allocation && !p.out ? `<span class="st g-warehouse" title="Shopify shows only a few pieces topped up from the warehouse">Check the warehouse${p.daysLeft != null ? ` · ${inr.format(Math.max(0, Math.round(p.daysLeft)))} day${Math.round(p.daysLeft) === 1 ? '' : 's'} left` : ''}</span>` : p.out ? '<span class="st g-today">Not ordered</span>' : '<span class="muted">Enough stock</span>');
    const bestCell = (p) => SW_PROD.cell(p, { before: p.out ? '<span class="dot" title="Out of stock now"></span>' : '', extra: topUp(p) });
    const cols = [
      { k: 'name', label: 'Best seller', f: (p) => bestCell(p) },
      { k: 'out', label: 'Now', f: nowCell, val: (p) => (p.out ? 1 : 0) },
      { k: 'daysOutMonth', label: `Days out in ${mShort(m.key)}`, r: 1, f: (p) => (p.daysOutMonth ? `<span title="${esc(p.rangeMonth)}">${inr.format(Math.round(p.daysOutMonth * 2) / 2)}</span>` : '–') },
      { k: 'lostMonth', label: `Missed in ${mShort(m.key)}`, r: 1, f: (p) => (p.lostMonth ? `<b class="lostv">${money(p.lostMonth)}</b>` : '–') },
      { k: 'pace', label: 'Sells', r: 1, tip: 'How fast it sells on days it is in stock (last 6 months)', f: (p) => esc(pace(p.pace.perDay)), val: (p) => p.pace.perDay },
      { k: 'refill', label: 'Refill', f: refill, val: (p) => (p.onOrder ? 1 : p.orderQty > 0 ? 2 : p.out ? 3 : 0) },
    ];
    return `<section class="headline"><h1>${out.length ? `<span class="lost">${out.length} of ${rows.length}</span> best sellers are out right now.` : `All ${rows.length} best sellers are in stock.`}</h1>
        <p>${lost ? `This month so far (${span(m.from, m.to)}) best sellers missed about <b class="lostv">${money(lost)}</b>.` : `Nothing missed this month so far (${span(m.from, m.to)}).`} ${out.filter((p) => !p.onOrder).length ? `${out.filter((p) => !p.onOrder).length} out and not ordered.` : ''}</p>
        ${scopeLine(inScopeOf(m, 'all').lost, inScopeOf(m, 'best').lost, span(m.from, m.to), { sw: false })}
        <p class="muted small">Best sellers = the products that make ${bestShare()}% of the last 12 months’ sales. Tap one to mark it ordered.</p></section>
      ${A.table('best', cols, rows, 'No best sellers yet.', (p) => `<header><h3>${bestCell(p)}</h3><div class="mq">${p.lostMonth ? `<b class="lostv">${money(p.lostMonth)}</b><small>missed in ${mShort(m.key)}</small>` : '<b class="muted">–</b>'}</div></header>
        <div class="mfacts">${nowCell(p)}${p.daysOutMonth ? `<span><b>${esc(nDays(p.daysOutMonth))}</b> out in ${mShort(m.key)}</span>` : ''}${refill(p)}</div>`)}`;
  }

  /* ---------- Ads: push / pause ---------- */
  function adsView() {
    if (need()) return loading;
    const b = B();
    if (!b.ok) return notReady(b);   // 1.4.6: a failed load is not "every product is in stock"
    const ads = { push: [], pause: [], keep: [], ...(b.ads || {}) };
    const top = S().adsAll ? 1e9 : 25;
    const pushRow = (p) => `<div class="arow" data-product="${esc(p.id)}" tabindex="0" role="button">${SW_PROD.cell(p, { extra: p.best ? '<span class="best">Best seller</span>' : '' })}<span class="af"><b>${esc(pace(p.pace))}</b><small>${inr.format(p.coverWeeks)} weeks of stock · ${rs(p.perDayValue)} a day</small></span></div>`;
    const pauseRow = (p) => `<div class="arow" data-product="${esc(p.id)}" tabindex="0" role="button">${SW_PROD.cell(p, { extra: p.best ? '<span class="best">Best seller</span>' : '' })}<span class="af"><b class="${p.stock <= 0 ? 'lostv' : 'amberv'}">${p.stock <= 0 ? `Out${sinceText(p)}` : `${Math.max(0, Math.round(p.daysLeft || 0))} day${Math.round(p.daysLeft || 0) === 1 ? '' : 's'} left`}</b><small>${esc(p.best ? String(p.backIn || '').replace('Slow seller · not reordered', 'Not reordered') : p.backIn || '')}</small></span></div>`;
    const keepRow = (p) => `<div class="arow" data-product="${esc(p.id)}" tabindex="0" role="button">${SW_PROD.cell(p, { extra: p.best ? '<span class="best">Best seller</span>' : '' })}<span class="af"><b>${inr.format(Math.max(0, p.stock))} in stock</b><small>check the warehouse</small></span></div>`;
    const list = (kind, rows, row, empty) => `<div class="alist">${rows.slice(0, top).map(row).join('') || `<p class="muted">${empty}</p>`}${rows.length > top ? `<div class="more"><button class="btn ghost" id="ads-all">Show all ${rows.length}</button></div>` : ''}</div>`;
    const outN = ads.pause.filter((p) => p.stock <= 0).length;
    return `<section class="headline"><h1>Push <span class="okv">${ads.push.length}</span> in stock. Pause <span class="lost">${ads.pause.length}</span>: ${outN} out, ${ads.pause.length - outN} about to run out.</h1>
        <p class="muted small">Push = in stock, selling, with at least ${Math.round((ads.coverDays || 21) / 7)} weeks of stock: ads won’t empty the shelf. Pause = out of stock, or it runs out before a refill can land. Best sellers first. Stock as of ${esc(A.dt(b && b.generatedAt))}.</p></section>
      <div class="ads2">
        <div class="panel"><div class="panel-head"><h2>Push in ads</h2><span class="tb"><button class="btn ghost xs" data-ads-copy="push">Copy list</button><button class="btn ghost xs" data-ads-csv="push">CSV</button></span></div>
          <p class="muted small">Most money a day first.</p>${list('push', ads.push, pushRow, 'Nothing has enough stock to push.')}</div>
        <div class="panel"><div class="panel-head"><h2>Pause ads</h2><span class="tb"><button class="btn ghost xs" data-ads-copy="pause">Copy list</button><button class="btn ghost xs" data-ads-csv="pause">CSV</button></span></div>
          <p class="muted small">Shoppers can’t buy these now, or soon won’t. Ads on them waste money.</p>${list('pause', ads.pause, pauseRow, 'Every selling product is in stock.')}</div>
      </div>
      ${ads.keep.length ? `<div class="panel" id="ads-keep"><div class="panel-head"><h2>Keep ads on: refilled a few at a time</h2><span class="tb"><button class="btn ghost xs" data-ads-copy="keep">Copy list</button><button class="btn ghost xs" data-ads-csv="keep">CSV</button></span></div>
          <p class="muted small">Shopify shows only a few pieces, and the warehouse tops them up. Check the warehouse before you pause.</p>${list('keep', ads.keep, keepRow, '')}</div>` : ''}`;
  }
  function adsCsv(kind) {
    const rows = (B().ads || {})[kind] || [];
    const head = kind === 'push' ? ['Product', 'SKU', 'Variant ID', 'Best seller', 'Sells (units a day)', 'In stock', 'Weeks of stock', '₹ a day it can sell'] : ['Product', 'SKU', 'Variant ID', 'Best seller', 'In stock', 'Days left', 'Back in stock', 'Sells (units a day)'];
    const body = rows.map((p) => [...(kind === 'push' ? [p.name, p.sku, p.id, p.best ? 'yes' : 'no', p.pace, p.stock, p.coverWeeks, p.perDayValue] : [p.name, p.sku, p.id, p.best ? 'yes' : 'no', p.stock, p.daysLeft ?? '', p.backIn || '', p.pace]), ...SW_PROD.csv(p)]);
    A.saveCsv(`${kind === 'push' ? 'push-in-ads' : kind === 'keep' ? 'keep-ads-on' : 'pause-ads'}-${new Date().toISOString().slice(0, 10)}.csv`, [[...head, ...SW_PROD.CSV_HEAD], ...body]);
  }

  /* ---------- events ---------- */
  const refocus = (sel) => document.querySelector(sel)?.focus({ preventScroll: true });   // a redraw must not lose the keyboard's place
  /** The month's list, its heading clear of the sticky top bar. */
  function toList() {
    const el = document.getElementById('month-detail'); if (!el) return;
    const bar = document.querySelector('.top'), pos = bar ? getComputedStyle(bar).position : '';
    el.style.scrollMarginTop = `${(pos === 'sticky' || pos === 'fixed' ? bar.offsetHeight : 0) + 12}px`;
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  document.addEventListener('click', (e) => {
    if (!A) return;
    const t = e.target.closest('[data-month], [data-scope], #csv-months, #csv-month, #brand-all, #ads-all, #brand-retry, #see-list, [data-ads-copy], [data-ads-csv]');
    if (!t) return;
    if (t.dataset.scope) { setScope(t.dataset.scope); S().brandMonth = null; S().limit.brandmonth = 0; A.render(); refocus(`[data-scope="${t.dataset.scope}"]`); return; }
    if (t.id === 'brand-retry') { t.disabled = true; fetchBrand(true).then(() => A.render()); return; }
    if (t.id === 'see-list') { toList(); return; }
    if (t.dataset.month) {
      const onChart = !!t.closest('#brand-chart'), box = onChart ? '#brand-chart .mb' : t.closest('.heat') ? '.heat .hm' : '.mtable tr';
      S().brandMonth = t.dataset.month; S().limit.brandmonth = 0; A.render();
      refocus(`${box}[data-month="${t.dataset.month}"]`);
      if (!(onChart && narrow())) toList();   // phones: a tapped bar shows its numbers under the chart, "See list" goes down
      return;
    }
    if (t.id === 'csv-months') return csvMonths();
    if (t.id === 'csv-month') return csvMonth();
    if (t.id === 'brand-all') { S().brandAll = !S().brandAll; A.render(); return; }
    if (t.id === 'ads-all') { S().adsAll = true; A.render(); return; }
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
    if (w > 0 && Math.abs(w - +svg.getAttribute('width')) > 1) svg.outerHTML = chart(B().months.filter((m) => m.days).map(inScope), w);
  }

  window.SW_BRAND = {
    init(ctx) { A = ctx; },
    views: { brand: brandView, best: bestView, ads: adsView },
    fetch: fetchBrand, reset() { if (A) { A.state.brand = null; } }, after, rs, pace, scopeLine, scope,
  };
})();
