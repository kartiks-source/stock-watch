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
  const setScope = (v) => { S().brandScope = v; S().brandAll = false; S().brandMonthAll = false; S().adsAll = false; try { const u = new URL(location.href); if (u.searchParams.has('view')) { u.searchParams.delete('view'); history.replaceState(null, '', u); } } catch { /* */ } try { localStorage.setItem(SCOPE_KEY, v); } catch { /* private window */ } };
  const scopeName = (sc = scope(), one = false) => (sc === 'all' ? (one ? 'product' : 'all products') : (one ? 'best seller' : 'best sellers'));
  const scopeSwitch = () => `<div class="scope" role="group" aria-label="Which products">${[['best', 'Best sellers'], ['all', 'All<span class="wl"> products</span>']].map(([k, l]) => `<button class="${scope() === k ? 'on' : ''}" data-scope="${k}" aria-pressed="${scope() === k}">${l}</button>`).join('')}</div>`;
  /** 1.4.4: the line under the headline of Restock list, All products and Best sellers now: "₹X missed · all products · <dates>"
      with the other scope beside it and the switch. all / best = counted ₹ (LOGIC §4c). */
  const scopeLine = (lost, dates) => `<div class="scopeline" id="scope-line"><span><b class="lostv">${money(lost)}</b> missed · ${scopeName()} · ${esc(dates)}</span></div>`;
  /** 1.4.9: one switch for the whole app, in the same place on every page: the top bar, or its own bar on phones */
  function paintScope(hide) {
    const top = document.getElementById('scope-top'), bar = document.getElementById('scopebar'); if (!top || !bar) return;
    const host = narrow() ? bar : top, other = narrow() ? top : bar;
    other.innerHTML = ''; host.innerHTML = hide ? '' : scopeSwitch();
  }
  /** A month or the headline seen through the scope: lost (counted), parts kept apart, ran out, days out. */
  const inScopeOf = (m, k) => (m && m[k] ? m[k] : { lost: m ? m.lost : 0 });
  const inScope = (m) => (m && m[scope()] ? { ...m, ...m[scope()], bestOut: m[scope()].out ?? m.bestOut } : m);
  /** "Not counted" in one small line (the same parts as every page, LOGIC §4c, §22). */
  const apartLine = (h) => { const parts = [h.est ? `${rs(h.est)} a guess: products that hardly sell` : '', h.apart ? `${rs(h.apart)} while the warehouse topped up a few pieces` : ''].filter(Boolean); return parts.length ? `<p class="muted small" id="brand-apart">Not counted in ${rs(h.lost)}: ${parts.join(' · ')}.</p>` : ''; };
  const B = () => S().brand;
  /* 2.0.0 (RULE.md): ₹ only for best sellers, always a range; b.rule is set when the numbers come from the one rule */
  const rule = () => !!(B() && B().rule);
  const band = (x) => (rule() && x && x.lost > 0 && x.low != null ? `${rs(x.low)}–${rs(x.high)}`.replace(/^₹([\d.]+) lakh–₹/, '₹$1–') : '');
  const bandSmall = (x) => (band(x) ? ` <small class="muted band">${band(x)}</small>` : rule() && x && x.lost > 0 && x.n ? ` <small class="muted band">only ${x.n} time${x.n === 1 ? '' : 's'}</small>` : '');
  const names = (ks) => { const n = ks.map((k) => mShort(k)); return n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}` : n[0] || ''; };
  const whyNone = (p, x) => (!rule() ? '' : x && x.later > 0 ? `Past 60 empty days: ${rs(x.later)} if still wanted` : x && x.no ? x.no.charAt(0).toUpperCase() + x.no.slice(1) : '');
  const lostOf = (p, x) => (counted(x) > 0 || !rule() ? `<b class="lostv">${money(counted(x))}</b>` : `<span class="muted" title="${esc(whyNone(p, x))}">–</span>`);
  const ruleLines = (b, h) => (!b.rule ? '' : `<p class="late" id="brand-later">Never empty: ${scope() === 'all' ? 'the brand' : 'the best sellers'} could have sold about <b>${money(h.could)}</b>.${h.later > 0 ? ` Another <b class="lostv">${money(h.later)}</b> came after 60 empty days: not tested enough, so not added.` : ''}</p>
        <p class="muted small">${h.noMoney > 0 ? `${inr.format(Math.round(h.noMoney))} empty days carry no ₹: no recent sales, or no history before. ` : ''}${b.countsNow ? `Out now: ${inr.format(b.countsNow.out)} of ${inr.format(b.countsNow.onSale)} products, ${b.countsNow.best} of them best sellers.` : ''}</p>`);
  const testText = (t) => (t ? `${t.off >= 0 ? '+' : '−'}${pct(Math.abs(t.off) * 100)} (95% sure between ${t.low >= 0 ? '+' : '−'}${pct(Math.abs(t.low) * 100)} and ${t.high >= 0 ? '+' : '−'}${pct(Math.abs(t.high) * 100)}; ${inr.format(t.n)} tries, ${inr.format(t.products)} products)` : 'too few to test');
  const howNew = (b) => `<p><b>Empty day:</b> the shelf was empty all day. Half a day when it ran out or came back. From Shopify’s own stock log.</p>
        <p><b>Money missed</b> = how fast it sells × how like products did on those days × the price paid × days empty. <b>Could have sold</b> = sold + missed.</p>
        <p><b>How fast:</b> pieces on days in stock, newer days counting more (a day 60 shelf days old counts half). The last 3 days before it ran out are left out.</p>
        <p><b>Like products:</b> the ones that sell at a like speed and were in stock on the same empty days, against their own speed. That carries Diwali, sales and quiet weeks.</p>
        <p><b>Is it true?</b> We tested it two ways. Real comebacks, guess against real: best sellers ${testText(b.proof.best.back)}; other products ${testText(b.proof.other.back)}. Replayed stock-outs (real sales hidden after a pretend run-out): best sellers ${testText(b.proof.best.replay)}; others ${testText(b.proof.other.replay)}. The range beside each number is how far these tests were off, about 9 times in 10 (86–88% when checked blind). Its low end is never above what real comebacks alone say.</p>
        <p><b>Best sellers:</b> the products that made 80% of real sales before each quarter began (now: ${b.bestList.n}, ${span(b.bestList.from, b.bestList.to)}). A size or colour counts as its own product.</p>
        <p><b>Locked:</b> a month is saved 3 days after it ends and never changes. This month can still move. Rule ${esc(b.rule)}.</p><p><b>Not provable:</b> a missed sale can’t be seen. Some buyers may have bought something else; we don’t take that off. So it is demand we couldn’t serve, not profit lost.</p>`;
  /** The products of the open view. Best sellers: each month's money only when it was on that quarter's list, so rows add up to the headline. */
  const viewOf = (b, p) => { if (!rule() || scope() === 'all') return p; const months = Object.fromEntries(Object.entries(p.months || {}).filter(([, x]) => x.best)); return { ...p, months, lost: p.lostBest, counted: p.lostBest, daysOut: Object.values(months).reduce((t, x) => t + x.daysOut, 0) }; };
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
        <text x="${x + w2 / 2}" y="${H - 8}" text-anchor="middle">${narrow() ? ((months.length - 1 - i) % 2 ? '' : mShort(m.key)) : `${shortLabel(m.key, keys)}${m.days && m.days < 28 ? '*' : ''}`}</text></g>`;
    }).join('');
    return `<svg class="bchart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Sold and money missed each month">${ticks.join('')}${bars}</svg>`;
  }
  function niceStep(x) { const p = 10 ** Math.floor(Math.log10(Math.max(1, x))); const m = x / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }
  /** "since 4 Nov": the day the stock-out began from the 12 months (whole days), else the engine's time; "since before …"
      when it began before the 12 months held */
  const sinceText = (p) => {
    const b = B(), from = b && b.span && b.span.from;
    if (p.outFromDay) return p.outFromDay <= from && (!b.rule || p.outFromDay < from) ? ` since before ${dayY(from)}` : ` since ${day(p.outFromDay)}${p.outFromDay.slice(0, 4) !== new Date().toISOString().slice(0, 4) ? ` ${p.outFromDay.slice(0, 4)}` : ''}`;
    return p.outSince ? ` since ${esc(A.dateShort(p.outSince))}` : '';
  };
  /** §6: a website allocation refilled from the warehouse: its gaps are not counted in the totals */
  /** #rank by 12 months' sales among products on sale: a big loss on #24 is read differently from one on #1 */
  const rankOf = (p) => { const bb = B(); if (rule()) return p.rank || null; if (!bb || !bb.products) return null; if (!bb._rank) bb._rank = new Map(bb.products.filter((x) => !x.inactive).sort((x, y) => y.sold - x.sold).map((x, i) => [x.productId, i + 1])); return bb._rank.get(p.productId) || null; };
  const rk = (p) => { const n = rankOf(p); return n ? `<span class="rk" title="Rank on the best-seller list">#${n} by sales</span>` : ''; };
  /** 1.5.1: the sum on the row: days × pieces a day × price */
  const sum = (days, u, lost, md = null) => { if (md != null) days = md; return sumOf(days, u, lost); };
  const sumOf = (days, u, lost) => (days > 0 && u > 0 && lost > 0 ? `<small class="why-sum" title="Days empty × pieces a day × price paid. Open the product for every step.">${(Math.round(days * 2) / 2).toLocaleString('en-IN')} days × ${(Math.round((u / days) * 100) / 100).toLocaleString('en-IN')} a day × ₹${inr.format(Math.round(lost / u))}</small>` : '');
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
    const when = held >= 330 ? 'in the last 12 months' : `since ${dayY(h.from)}`;
    const y = b.year || {};
    const stale = b.basis === 'rows' ? `<p class="note">History from ${esc(dayY(b.span.from))}: the days we hold. Shopify’s 12 months are read after the next pull.</p>`
      : (y.done === false || held < (b.rule ? 300 : 360)) ? `<p class="note">History from ${esc(dayY(b.span.from))}; the full 12 months after the next pull. Months before then are not read yet (not ₹0).${h.bestsellers ? ' Best sellers are ranked on Shopify’s last 26 weeks until then.' : ''}</p>` : '';
    const all_ = b.products.map((p) => viewOf(b, p)), best = sc === 'all' ? b.products.filter((p) => p.lost > 0 || p.daysOut > 0).sort((a, c) => counted(c) - counted(a) || c.lost - a.lost) : all_.filter((p) => (b.rule ? p.daysOut > 0 : p.best && p.daysOut > 0)).sort((a, c) => counted(c) - counted(a) || c.lost - a.lost);   // website top-ups stay listed (tagged); their days aren't in the totals
    const top = narrow() ? 8 : sc === 'all' ? 50 : 12, all = S().brandAll ? best.length : Math.min(top, best.length);
    const ms = months.map((m) => m.key);   // only months held
    const selM = months.find((m) => m.key === sel);
    const who = sc === 'all' ? `${inr.format(h.ranOut)} product${h.ranOut === 1 ? '' : 's'}` : `${inr.format(h.bestRanOut)} of ${inr.format(h.bestsellers)} best sellers`;
    return `
      <section class="headline brand-h">
        <h1>${who} ran out ${when}. We missed ${b.rule ? 'an estimated' : 'about'} <span class="lost">${money(h.lost)}</span>${band(h) ? ` <span class="hsub">between ${band(h)}</span>` : ''}.</h1>
        <p class="lead"><span class="m-hide">Missed on ${scopeName()}: about <b class="lostv">${money(h.lost)}</b>. That is </span>${pct(h.pct)} of what ${sc === 'all' ? 'the brand' : 'the best sellers'} sold (${money(h.sold)}), ${span(h.from, h.through)}.</p>
        <p class="muted small m-hide">${sc === 'all' ? `Empty for about ${nDays(h.daysOut / Math.max(1, h.ranOut))} each.` : `Empty for about ${nDays(h.daysOut / Math.max(1, h.bestRanOut))} each. Best sellers = the products that make ${bestShare()}% of sales.`} Sales up to ${dayY(b.asOf.through)}; ${b.asOf.stockAt ? `stock read ${esc(A.dt(b.asOf.stockAt))}.` : 'stock at that day’s end.'}</p>
        ${h.late > 0 ? `<p class="late" id="brand-late"><b class="lostv">${money(h.late)}</b> of it came after a product had already been empty for a month and was still not restocked.</p>` : ''}${ruleLines(b, h)}
        ${narrow() && apartLine(h) ? `<details class="m-apart"><summary>+${money((h.est || 0) + (h.apart || 0))} not counted: see why</summary>${apartLine(h)}</details>` : apartLine(h)}${h.unsure ? `<p class="muted small">${h.unsure} product${h.unsure === 1 ? '' : 's'} left out: Shopify’s stock log doesn’t add up for ${h.unsure === 1 ? 'it' : 'them'}.</p>` : ''}
        ${stale}
        <details class="how exp"><summary>How we count, and is it true?</summary>${b.rule ? howNew(b) : `<p>A day is “out” when the shelf was empty all day: nobody could buy it. Half a day when it ran out or came back that day. “Would have sold” = how fast it sells on days it is in stock (last ${(b.settings || {}).paceMonths || 6} months), made busier or quieter for the month (Diwali sells more than June). Money missed = would have sold × the price people paid. All from Shopify’s own sales and stock reports, so every number can be checked there.</p>`}</details>
      </section>
      <div class="bgrid">
        <div class="panel"><div class="panel-head"><h2>Sold and missed, each month</h2><span class="muted small"><i class="sw sold"></i> sold${sc === 'all' ? '' : ' (best sellers)'} <i class="sw lost"></i> missed (${scopeName()})${months.some((m) => m.days < 28) ? ' · * part of the month' : ''}</span></div><div id="brand-chart">${chart(months, 600)}</div>
          ${selM ? `<p class="month-line" id="month-line"><b>${esc(monthText(selM))}</b>: sold ${money(selM.sold)}, missed <b class="lostv">${money(selM.lost)}</b>${bandSmall(selM)}, ${inr.format(selM.bestOut || 0)} ${b.rule ? 'empty' : 'ran out'}. <button class="linkbtn" id="see-list">See list</button></p>` : ''}
          ${topFive(best)}</div>
        <div class="panel"><div class="panel-head"><h2>Month by month</h2><button class="btn ghost xs" id="csv-months">Download CSV</button></div>
          <table class="mtable"><thead><tr><th>Month</th><th class="r">Sold</th><th class="r">Missed, ${scopeName()}</th><th class="r m-hide">Could have been</th><th class="r m-hide">% of sales</th><th class="r">${sc === 'all' ? 'Products' : 'Best sellers'} out</th><th class="r m-hide">Days out</th></tr></thead>
          <tbody>${months.map((m) => `<tr data-month="${m.key}" tabindex="0" class="${m.key === sel ? 'on' : ''}"><td>${esc(monthText(m))}${m.days < 28 && !partOf(m) ? ` <small class="muted">${m.from === m.to ? day(m.from) : `${+m.from.slice(8, 10)}–${day(m.to)}`}</small>` : ''}</td><td class="r">${money(m.sold)}</td><td class="r">${`<b class="${m.lost ? 'lostv' : 'muted'}">${m.lost ? money(m.lost) : '–'}</b>${bandSmall(m)}`}</td><td class="r m-hide">${money(m.sold + m.lost)}</td><td class="r m-hide">${m.pct ? pct(m.pct) : '–'}</td><td class="r">${m.bestOut || '–'}</td><td class="r m-hide">${m.daysOut ? inr.format(Math.round(m.daysOut)) : '–'}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td>All of it</td><td class="r">${money(h.sold)}</td><td class="r"><b class="lostv">${money(h.lost)}</b>${bandSmall(h)}</td><td class="r m-hide">${money(h.sold + h.lost)}</td><td class="r m-hide">${pct(h.pct)}</td><td class="r">${sc === 'all' ? h.ranOut : h.bestRanOut}</td><td class="r m-hide">${inr.format(Math.round(h.daysOut))}</td></tr></tfoot></table></div>
      </div>
      <div class="panel"><div class="panel-head"><h2>Which ${sc === 'all' ? 'products' : 'best sellers'} ran out, and when</h2><span class="muted small">Days the shelf was empty each month. Darker = longer. Tap a month to see the list.</span></div>
        ${best.length ? `<div class="heat" style="--mcols:${ms.length}"><div class="hrow hhead"><span></span>${ms.map((m) => `<button class="hm${m === sel ? ' on' : ''}" data-month="${m}" title="${esc(monthText(months[ms.indexOf(m)]))}">${shortLabel(m, ms)}</button>`).join('')}<span class="r" title="${esc(span(h.from, h.through))}">Missed</span></div>
          ${best.slice(0, all).map((p) => `<div class="hrow"><span class="hp" data-product="${esc(p.variantId)}" tabindex="0" role="button">${SW_PROD.cell(p, { size: 32, extra: topUp(p) + offSale(p) })}</span>${ms.map((m) => { const x = p.months && p.months[m]; const d = x ? x.daysOut : 0; return `<span class="hc h${heat(d)}${m === sel ? ' on' : ''}" data-month="${m}" title="${esc(x && d ? `${p.name}: out ${nDays(d)} in ${monthName(m)} (${x.range}). ${rule() && !counted(x) ? whyNone(p, x) : `About ${exact(x.counted ?? x.lost)} missed`}${x.lost > (x.counted ?? x.lost) + 1 ? ` + ${exact(x.lost - x.counted)} not counted` : ''}.` : `${p.name}: in stock all of ${monthName(m)}`)}">${d ? Math.round(d) || '½' : ''}</span>`; }).join('')}<span class="r hv">${rule() && !counted(p) ? '<span class="muted">–</span>' : `<b class="lostv">${money(counted(p))}</b>`}${p.lost > (p.counted ?? p.lost) + 1 ? `<small class="muted" title="Not counted (a guess / warehouse top-up)"> +${rs(p.lost - p.counted)}<span class="ph-only"> not counted</span></small>` : ''}<small class="ph-only"> missed</small></span></div>`).join('')}
          ${best.length > top ? `<div class="more"><button class="btn ghost" id="brand-all">${S().brandAll ? `Show the top ${top}` : `Show all ${best.length}`}</button></div>` : ''}</div>` : `<p class="muted">No ${scopeName(sc, true)} ran out in these months.</p>`}
      </div>
      ${monthDetail(b, sel)}`;
  }
  /** 1.4.6: the first screen names them: the five that cost the most (counted), with days and the latest dates. */
  function topFive(list) {
    const five = list.filter((p) => counted(p) > 0).slice(0, 5);
    if (!five.length) return '';
    const last = (p) => { const k = Object.keys(p.months || {}).sort().reverse().find((m) => p.months[m].daysOut > 0); return k ? p.months[k].range : ''; };
    return `<div class="top5"><h3>Cost the most</h3>${five.map((p) => `<div class="t5" data-product="${esc(p.variantId)}" tabindex="0" role="button">${SW_PROD.cell(p, { size: 32, sub: rk(p), extra: (p.best && scope() === 'all' ? '<span class="best">Best seller</span>' : '') + offSale(p) })}<span class="af"><b class="lostv">${money(counted(p))}</b><small>${p.times > 1 ? `${p.times} times, ` : ''}${esc(nDays(p.daysOut))} out · last ${esc(last(p))}</small></span></div>`).join('')}</div>`;
  }
  /** The newest month with money missed (else the newest). */
  const defaultMonth = (b) => { const ms = b.months.filter((m) => m.days).map(inScope); return (ms.slice().reverse().find((m) => m.lost > 0) || ms[ms.length - 1] || {}).key; };
  function monthRows(b, m, all = scope() === 'all') {
    return b.products.map((p) => (all ? p : viewOf(b, p))).filter((p) => (all || rule() || p.best) && p.months && p.months[m] && (p.months[m].daysOut > 0 || p.months[m].lost > 0))
      .map((p) => ({ ...p, id: p.variantId, x: { ...p.months[m], counted: p.months[m].counted ?? p.months[m].lost } })).sort((a, c) => c.x.counted - a.x.counted || c.x.lost - a.x.lost || c.x.daysOut - a.x.daysOut);
  }
  const notCounted = (x) => (x.lost > x.counted + 1 ? ` <small class="muted" title="${esc([x.est ? `${exact(x.est)} a guess (hardly sells)` : '', x.apart ? `${exact(x.apart)} warehouse top-up` : ''].filter(Boolean).join(' · '))}">+${rs(x.lost - x.counted)} not counted</small>` : '');
  function monthDetail(b, m) {
    if (!m) return '';
    const mm = b.months.find((x) => x.key === m) || {};
    const every = monthRows(b, m), cut = narrow() && !S().brandMonthAll && every.length > 10, rows = cut ? every.slice(0, 10) : every, ms = inScope(mm);   // phones: the 10 biggest, then Show all
    const n = ms.bestOut ?? every.length;
    const lead = rows.length ? `${monthText(mm)}: ${n} ${scope() === 'all' ? (n === 1 ? 'product' : 'products') : scopeName(scope(), n === 1)} ${b.rule ? 'were empty' : 'ran out'}. We missed about ${rs(ms.lost)}${band(ms) ? ` (${band(ms)})` : ''}.` : `${monthText(mm)}: no ${scopeName(scope(), true)} ran out.`;
    const cols = [
      { k: 'name', label: 'Product', f: (p) => SW_PROD.cell(p, { sub: rk(p), extra: topUp(p) + offSale(p) }) },
      { k: 'range', label: 'Ran out on', f: (p) => `<span class="rng" title="${esc(p.x.range)}">${esc(p.x.range)}</span>`, val: (p) => p.x.dates[0] || '' },
      { k: 'daysOut', label: 'Days out', r: 1, f: (p) => inr.format(Math.round(p.x.daysOut * 2) / 2), val: (p) => p.x.daysOut },
      { k: 'units', label: 'Would have sold', r: 1, tip: 'How fast it sells on days it is in stock, for this month', f: (p) => `<span title="${(Math.round(countedUnits(p.x) * 10) / 10).toLocaleString('en-IN')} at ${pace(p.pace.perDay)}">${p.x.counted > 0 ? about(countedUnits(p.x)) : '–'}</span>`, val: (p) => countedUnits(p.x) },
      { k: 'lost', label: 'Money missed', r: 1, f: (p) => `${lostOf(p, p.x)}${rule() && !p.x.counted ? `<small class="why-sum">${esc(whyNone(p, p.x))}</small>` : ''}${notCounted(p.x)}${sum(p.x.daysOut, p.x.units, p.x.lost, p.x.moneyDays)}`, val: (p) => p.x.counted },
    ];
    return `<section class="panel" id="month-detail"><div class="panel-head"><h2>${esc(lead)}</h2>
        <span class="tb"><button class="btn ghost xs" id="csv-month">Download CSV</button></span></div>
      <p class="muted small">${scopeName()} · ${mm.from ? span(mm.from, mm.to) : ''} · sold ${money(ms.sold ?? mm.sold ?? 0)} that month.</p>${apartLine(ms)}
      ${A.table('brandmonth', cols, rows, 'Nothing ran out this month.', (p) => `<header><h3>${A.nameCell(p, false)}</h3><div class="mq">${lostOf(p, p.x)}<small>${rule() && !p.x.counted ? esc(whyNone(p, p.x)) : 'missed'}</small>${notCounted(p.x)}</div></header>
        <div class="mfacts"><span>Ran out <b>${esc(p.x.range)}</b></span><span><b>${esc(nDays(p.x.daysOut))}</b></span>${p.x.counted > 0 ? `<span>would have sold <b>${units(countedUnits(p.x))}</b></span>` : ''}</div>`)}${cut ? `<div class="more"><button class="btn ghost" id="month-all">Show all ${every.length}</button></div>` : ''}</section>`;
  }
  function csvMonths() {
    const b = B();
    const sc = scope(), w = scopeName(sc);
    const head = ['Month', 'From', 'To', `Sold ₹ (${w}, net, ex GST)`, `Missed ₹ (${w}, counted)`, '% of sales', `${sc === 'all' ? 'Products' : 'Best sellers'} out`, `Days out (${w})`, 'Of which after the first 30 days empty ₹', 'Not counted: a guess ₹', 'Not counted: warehouse top-up ₹', 'Missed ₹ (all products, every part)'];
    const rows = b.months.filter((m) => m.days).map((m) => { const x = m[sc]; return [monthText(m), m.from, m.to, x.sold ?? m.sold, x.lost, x.pct, x.out, x.daysOut, x.late || 0, x.est, x.apart, m.lostAll]; });
    A.saveCsv(`brand-report-months-${sc === 'all' ? 'all-products' : 'best-sellers'}-${b.asOf.through}.csv`, [head, ...rows]);
  }
  function csvMonth() {
    const b = B(), m = S().brandMonth;
    const head = ['Month', 'Product', 'SKU', 'Variant ID', 'Best seller', 'Ran out on', 'Out-of-stock dates', 'Days out', 'Would have sold (units, counted)', 'Pace (units a day, in stock)', 'Average price paid ₹', 'Money missed ₹ (counted)', 'Not counted ₹ (a guess / top-up)', ...SW_PROD.CSV_HEAD];
    const rows = monthRows(b, m).map((p) => [monthText(b.months.find((z) => z.key === m) || { key: m }), p.name, p.sku, p.variantId, p.best ? 'yes' : 'no', p.x.range, p.x.dates.join(' '), p.x.daysOut, Math.round(countedUnits(p.x) * 10) / 10, p.pace.perDay, p.price, p.x.counted, Math.max(0, p.x.lost - p.x.counted), ...SW_PROD.csv(p)]);
    A.saveCsv(`brand-report-${scope() === 'all' ? 'all-products' : 'best-sellers'}-${m}.csv`, [head, ...rows]);
  }

  /* ---------- Best sellers now ---------- */
  function bestView() {
    if (need()) return loading;
    const b = B();
    if (!b.ok) return notReady(b);
    const sa = scope() === 'all', rows = [...(b.now || []), ...(sa ? b.nowAll || [] : [])].filter((p) => !p.inactive).sort((x, y) => (y.out - x.out) || (y.lostMonth - x.lostMonth) || (y.sold - x.sold)), noun = sa ? 'products' : 'best sellers', out = rows.filter((p) => p.out), m = b.months[b.months.length - 1];
    const lost = rows.reduce((s, p) => s + (p.lostMonth || 0), 0);   // counted: the same ₹ as the month table (1.4.4)
    const nowCell = (p) => (p.out ? `<span class="st g-today">Out${sinceText(p)}</span>${p.variantsLive > 1 ? ` <small class="muted">${p.outVariants} of ${p.variantsLive} options</small>` : ''}` : `<span class="st ok">In stock · ${inr.format(p.stock)}</span>`);
    const times = (p) => (p.times > 1 ? `ran out ${inr.format(p.times)} times this year` : p.times === 1 ? 'first time this year' : '');
    const cost = (p) => (p.out && p.costPerDay ? `<span><b class="lostv">${rs(p.costPerDay)}</b> a day</span>` : '');
    const bestCell = (p) => SW_PROD.cell(p, { before: p.out ? '<span class="dot" title="Out of stock now"></span>' : '', sub: rk(p), extra: (sa && p.best ? '<span class="best">Best seller</span>' : '') + topUp(p) });
    const cols = [
      { k: 'name', label: sa ? 'Product' : 'Best seller', f: (p) => bestCell(p) },
      { k: 'out', label: 'Now', f: nowCell, val: (p) => (p.out ? 1 : 0) },
      { k: 'daysOutMonth', label: `Days out in ${mShort(m.key)}`, r: 1, f: (p) => (p.daysOutMonth ? `<span title="${esc(p.rangeMonth)}">${inr.format(Math.round(p.daysOutMonth * 2) / 2)}</span>` : '–') },
      { k: 'lostMonth', label: `Missed in ${mShort(m.key)}`, r: 1, f: (p) => (p.lostMonth ? `<b class="lostv">${money(p.lostMonth)}</b>${sum(p.daysOutMonth, p.unitsMonth, p.missedMonthAll, p.moneyDaysMonth)}` : '–') },
      { k: 'pace', label: 'Sells', r: 1, tip: rule() ? 'Pieces a day when it is in stock, last 12 months' : 'How fast it sells on days it is in stock (last 6 months)', f: (p) => esc(pace(p.pace.perDay)), val: (p) => p.pace.perDay },
      { k: 'times', label: 'Times out, 12 months', r: 1, tip: 'Separate times it ran out in the last 12 months, and in how many months', f: (p) => (p.times ? `${inr.format(p.times)}× <span class="muted">in ${p.monthsOut} month${p.monthsOut === 1 ? '' : 's'}</span>` : '–') },
      { k: 'counted', label: 'Missed, 12 months', r: 1, f: (p) => (p.counted ? `<b class="lostv">${money(p.counted)}</b>` : '–') },
      ...(rule() ? [{ k: 'could', label: 'Could have earned, 12 months', r: 1, tip: 'Sold + missed', f: (p) => (p.could != null ? money(p.could) : '–'), val: (p) => p.could || 0 }] : []),
      { k: 'costPerDay', label: 'Costs a day now', r: 1, tip: 'What each more empty day costs', f: (p) => (p.out && p.costPerDay ? `<b class="lostv">${rs(p.costPerDay)}</b>` : '–') },
    ];
    return `<section class="headline"><h1>${out.length ? `<span class="lost">${out.length} of ${rows.length}</span> ${noun} are out right now.` : `All ${rows.length} ${noun} are in stock.`}</h1>
        <p>${lost ? `This month so far (${span(m.from, m.to)}) ${noun} missed about <b class="lostv">${money(lost)}</b>.` : `Nothing missed this month so far (${span(m.from, m.to)}).`} ${out.length && out.some((p) => p.costPerDay > 0) ? `Each more day costs ${rule() ? 'at least' : 'about'} <b class="lostv">${rs(out.reduce((s, p) => s + (p.costPerDay || 0), 0))}</b>.` : ''}</p>
        ${scopeLine(inScopeOf(m, scope()).lost, span(m.from, m.to))}
        <p class="muted small m-hide">${sa ? 'Every product on sale.' : `Best sellers = the products that made ${bestShare()}% of sales${rule() ? `, ${span(b.bestList.from, b.bestList.to)}` : ' in the last 12 months'}.`} Tap one to see its 12 months.</p></section>
      ${A.table('best', cols, rows, `No ${noun} yet.`, (p) => `<header><h3>${bestCell(p)}</h3><div class="mq">${p.lostMonth ? `<b class="lostv">${money(p.lostMonth)}</b><small>missed in ${mShort(m.key)}</small>` : '<b class="muted">–</b>'}</div></header>
        <div class="mfacts">${nowCell(p)}${p.daysOutMonth ? `<span><b>${esc(nDays(p.daysOutMonth))}</b> in ${mShort(m.key)}</span>` : ''}${cost(p)}${p.times > 1 ? `<span title="${times(p)}">${p.times}× this year</span>` : ''}${p.lostMonth ? `<span class="why-m">${sum(p.daysOutMonth, p.unitsMonth, p.missedMonthAll, p.moneyDaysMonth).replace(/<\/?small[^>]*>/g, '')}</span>` : ''}</div>`)}`;
  }

  /* ---------- Ads: push / pause ---------- */
  const adsOf = () => { const a = { push: [], pause: [], keep: [], ...((B() || {}).ads || {}) }; return scope() === 'all' ? a : { ...a, push: a.push.filter((p) => p.best), pause: a.pause.filter((p) => p.best), keep: a.keep.filter((p) => p.best) }; };   // 1.4.9: the switch
  function adsView() {
    if (need()) return loading;
    const b = B();
    if (!b.ok) return notReady(b);   // 1.4.6: a failed load is not "every product is in stock"
    const ads = adsOf();
    const top = S().adsAll ? 1e9 : 25;
    const pushRow = (p) => `<div class="arow" data-product="${esc(p.id)}" tabindex="0" role="button">${SW_PROD.cell(p, { extra: p.best ? '<span class="best">Best seller</span>' : '' })}<span class="af"><b>${esc(pace(p.pace))}</b><small>${inr.format(p.coverWeeks)} weeks of stock · ${rs(p.perDayValue)} a day</small></span></div>`;
    const pauseRow = (p) => `<div class="arow" data-product="${esc(p.id)}" tabindex="0" role="button">${SW_PROD.cell(p, { extra: p.best ? '<span class="best">Best seller</span>' : '' })}<span class="af"><b class="${p.stock <= 0 ? 'lostv' : 'amberv'}">${p.stock <= 0 ? `Out${sinceText(p)}` : `${Math.max(0, Math.round(p.daysLeft || 0))} day${Math.round(p.daysLeft || 0) === 1 ? '' : 's'} left`}</b><small>${p.costPerDay && p.stock <= 0 ? `${rs(p.costPerDay)} missed a day` : `sells ${esc(pace(p.pace))}`}</small></span></div>`;
    const keepRow = (p) => `<div class="arow" data-product="${esc(p.id)}" tabindex="0" role="button">${SW_PROD.cell(p, { extra: p.best ? '<span class="best">Best seller</span>' : '' })}<span class="af"><b>${inr.format(Math.max(0, p.stock))} in stock</b><small>refilled a few at a time</small></span></div>`;
    const list = (kind, rows, row, empty) => `<div class="alist">${rows.slice(0, top).map(row).join('') || `<p class="muted">${empty}</p>`}${rows.length > top ? `<div class="more"><button class="btn ghost" id="ads-all">Show all ${rows.length}</button></div>` : ''}</div>`;
    const outN = ads.pause.filter((p) => p.stock <= 0).length;
    return `<section class="headline"><h1>Push <span class="okv">${ads.push.length}</span> in stock. Pause <span class="lost">${ads.pause.length}</span>: ${outN} out, ${ads.pause.length - outN} about to run out.</h1>
        <p class="muted small m-hide">Push = in stock, selling, with at least ${Math.round((ads.coverDays || 21) / 7)} weeks of stock: ads won’t empty the shelf. Pause = out of stock, or it will run out within days. Best sellers first. Stock as of ${esc(A.dt(b && b.generatedAt))}.</p></section>
      <div class="ads2">
        <div class="panel"><div class="panel-head"><h2>Push in ads</h2><span class="tb"><button class="btn ghost xs" data-ads-copy="push">Copy list</button><button class="btn ghost xs" data-ads-csv="push">CSV</button></span></div>
          <p class="muted small">Most money a day first.</p>${list('push', ads.push, pushRow, 'Nothing has enough stock to push.')}</div>
        <div class="panel"><div class="panel-head"><h2>Pause ads</h2><span class="tb"><button class="btn ghost xs" data-ads-copy="pause">Copy list</button><button class="btn ghost xs" data-ads-csv="pause">CSV</button></span></div>
          <p class="muted small">Shoppers can’t buy these now, or soon won’t. Ads on them waste money.</p>${list('pause', ads.pause, pauseRow, scope() === 'all' ? 'Every selling product is in stock.' : 'Every best seller is in stock.')}</div>
      </div>
      ${ads.keep.length ? `<div class="panel" id="ads-keep"><div class="panel-head"><h2>Keep ads on: refilled a few at a time</h2><span class="tb"><button class="btn ghost xs" data-ads-copy="keep">Copy list</button><button class="btn ghost xs" data-ads-csv="keep">CSV</button></span></div>
          <p class="muted small">Shopify shows only a few pieces and they are topped up often. They sell every day: keep the ads on.</p>${list('keep', ads.keep, keepRow, '')}</div>` : ''}`;
  }
  function adsCsv(kind) {
    const rows = adsOf()[kind] || [];
    const head = kind === 'push' ? ['Product', 'SKU', 'Variant ID', 'Best seller', 'Sells (units a day)', 'In stock', 'Weeks of stock', '₹ a day it can sell'] : ['Product', 'SKU', 'Variant ID', 'Best seller', 'In stock', 'Days left', 'Missed a day now ₹', 'Sells (units a day)'];
    const body = rows.map((p) => [...(kind === 'push' ? [p.name, p.sku, p.id, p.best ? 'yes' : 'no', p.pace, p.stock, p.coverWeeks, p.perDayValue] : [p.name, p.sku, p.id, p.best ? 'yes' : 'no', p.stock, p.daysLeft ?? '', p.stock <= 0 ? p.costPerDay || 0 : 0, p.pace]), ...SW_PROD.csv(p)]);
    A.saveCsv(`${kind === 'push' ? 'push-in-ads' : kind === 'keep' ? 'keep-ads-on' : 'pause-ads'}-${scope() === 'all' ? 'all-products' : 'best-sellers'}-${new Date().toISOString().slice(0, 10)}.csv`, [[...head, ...SW_PROD.CSV_HEAD], ...body]);
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
    const t = e.target.closest('[data-month], [data-scope], #csv-months, #csv-month, #brand-all, #month-all, #ads-all, #brand-retry, #see-list, [data-ads-copy], [data-ads-csv]');
    if (!t) return;
    if (t.dataset.scope) { setScope(t.dataset.scope); S().limit.brandmonth = 0; S().pick.clear(); const v = t.dataset.scope, back = () => refocus(`[data-scope="${v}"]`); A.render(); back(); Promise.resolve(A.reload()).then(() => { if (!document.activeElement || document.activeElement === document.body) back(); }); return; }
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
    if (t.id === 'month-all') { S().brandMonthAll = true; A.render(); return; }
    if (t.id === 'ads-all') { S().adsAll = true; A.render(); return; }
    if (t.dataset.adsCopy) { const rows = adsOf()[t.dataset.adsCopy] || []; A.copy(rows.map((p) => `${p.sku || p.id}\t${p.name}`).join('\n')); return; }
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
    fetch: fetchBrand, reset() { if (A) { A.state.brand = null; } }, after, rs, pace, scopeLine, scope, paintScope,
  };
})();
