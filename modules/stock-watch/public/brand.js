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
  /* 1.4.4: "Best sellers | All products" for every part of the brand report; 4.2.0: Best sellers by default, remembered on this
     browser once changed, ?view=best / ?view=all win */
  const SCOPE_KEY = 'sw-brand-scope';
  const scope = () => {
    const st = S();
    if (!st.brandScope) { let v = null; try { v = new URLSearchParams(location.search).get('view'); } catch { /* */ } if (v !== 'all' && v !== 'best') { try { v = localStorage.getItem(SCOPE_KEY); } catch { /* */ } } st.brandScope = v === 'all' || v === 'best' ? v : window.SW_AGENCY === false ? 'all' : 'best'; }   // 4.2.0: the agency's pages: Best sellers unless chosen otherwise (the owner's pages keep All products)
    const b = st.brand; if (b && b.ok && b.months && noList(b)) return 'all';   // 4.2.0: no best-seller list yet: all products
    return st.brandScope;
  };
  function noList(b) { return !((b.bestList ? b.bestList.n : b.headline && b.headline.bestsellers) > 0); }
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
  /** A month or the headline seen through the scope: lost (counted), parts kept apart, ran out, empty days. */
  const inScopeOf = (m, k) => (m && m[k] ? m[k] : { lost: m ? m.lost : 0 });
  const inScope = (m) => (m && m[scope()] ? { ...m, ...m[scope()], bestOut: m[scope()].out ?? m.bestOut } : m);
  const B = () => S().brand;
  /* 2.0.0 (RULE.md): b.rule is set when the numbers come from the one rule. 4.2.0: the screens say "about ₹X", never a range */
  const rule = () => !!(B() && B().rule);
  /** 4.3: the brand's own correction, with its working (b.factor = { best, other } from src/model.js factors) */
  const lakhs = (z) => (z.guess >= 1e7 ? [1e7, 'crore'] : z.guess >= 1e5 ? [1e5, 'lakh'] : [1, '']);
  function factorLine(z, who) {
    if (!z) return '';
    const [u, w] = lakhs(z), v = (x) => (w ? (x / u).toFixed(2) : inr.format(Math.round(x))), m = (x) => `₹${v(x)}${w ? ` ${w}` : ''}`, d3 = (x) => (Math.round(x * 1000) / 1000).toFixed(3);
    if (z.flag === 'few') return `<p class="fx"><b>${who}:</b> not enough history to check yet: no correction${z.n || z.p ? ` (${inr.format(z.n)} 30-day check${z.n === 1 ? '' : 's'} of ${inr.format(z.p)} product${z.p === 1 ? '' : 's'} so far; it needs 100 checks and 10 products)` : ''}.</p>`;
    const head = `<b>${who}:</b> in ${inr.format(z.n)} 30-day checks with nothing out, we guessed ${m(z.guess)}; they really sold ${m(z.real)}.`;
    if (Math.abs(z.f - 1) <= 0.005) return `<p class="fx">${head} Already right, no correction.</p>`;
    const lean = (z.n * z.raw + 100) / (z.n + 100);
    return `<p class="fx">${head} ${v(z.real)} ÷ ${v(z.guess)} = ${d3(z.raw)} · leaning toward 1 for how many checks: (${inr.format(z.n)} × ${d3(z.raw)} + 100) ÷ ${inr.format(z.n + 100)} = ${z.flag === 'clip' ? `${d3(lean)}, capped at 0.5 / 1.5: check the data: × ${d3(z.f)}` : `× ${d3(z.f)}`}.</p>`;
  }
  const factorText = (fx, only = null) => (fx ? (only ? factorLine(fx[only], only === 'best' ? 'Best sellers' : 'Products off the best-seller list') : factorLine(fx.best, 'Best sellers') + factorLine(fx.other, 'Products off the best-seller list')) : '');
  const testText = (t) => (t ? `${t.off >= 0 ? '+' : '−'}${pct(Math.abs(t.off) * 100)} (95% interval ${t.low >= 0 ? '+' : '−'}${pct(Math.abs(t.low) * 100)} to ${t.high >= 0 ? '+' : '−'}${pct(Math.abs(t.high) * 100)}; ${inr.format(t.n)} tries, ${inr.format(t.products)} products)` : 'too few to test');
  const howNew = (b) => `<p><b>Empty day:</b> the shelf was empty all day. The day it ran out counts ½, the day it came back 0. From Shopify’s own stock log.</p>
        <p><b>Money missed</b> = what it makes a day in stock × how busy the shop was that day × empty days × this brand’s own correction (below).</p>
        <p><b>A day in stock:</b> its real sales (after discounts and returns) on its in-stock days in the 90 days before it ran out, ÷ those days. It needs 60 of them; if a best seller that still sold was out too much for that, its last 60 days in stock in the 12 months before. It also needs at least 3 sold.</p>
        <p><b>How busy:</b> the shop’s sales that day ÷ its sales on those same days, this product left out. That carries Diwali, sales and quiet days.</p>
        <p><b>The correction, checked on this brand:</b> every product’s normal months, when nothing ran out, guessed the same way and set against what really sold.</p>${factorText(b.factor)}
        <p><b>Is it true?</b> We tested it two ways. Real comebacks, guess against real: best sellers ${testText(b.proof.best.back)}; other products ${testText(b.proof.other.back)}. Replayed stock-outs (real sales hidden after a pretend run-out): best sellers ${testText(b.proof.best.replay)}; others ${testText(b.proof.other.replay)}.</p>
        <p><b>Best sellers:</b> the products that made 80% of real sales before each quarter began (now: ${b.bestList.n}, ${span(b.bestList.from, b.bestList.to)}). A size or colour counts as its own product.</p>
        <p><b>Locked:</b> a month is saved 3 days after it ends and never changes. This month can still move. Rule ${esc(b.rule)}.</p><p><b>Not provable:</b> a missed sale can’t be seen. Some buyers may have bought something else; we don’t take that off. It is demand we couldn’t serve, not profit lost. If people had no ads or saw the empty page less, we don’t know that either.</p>`;
  /** The products of the open view. Best sellers: each month's money only when it was on that quarter's list, so rows add up to the headline. */
  const viewOf = (b, p) => { if (!rule() || scope() === 'all') return p; const months = Object.fromEntries(Object.entries(p.months || {}).filter(([, x]) => x.best)); return { ...p, months, lost: p.lostBest, counted: p.lostBest, daysOut: Object.values(months).reduce((t, x) => t + x.daysOut, 0) }; };
  const loading = '<p class="muted pad">Getting 12 months of sales from Shopify. This page fills in when it’s done.</p>';

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
  /* 4.2.0: a store still loading, or too young for a month, says so with the report's own reason ('none' | 'short') */
  const notReady = (b) => b && b.error ? `<section class="headline"><h1>Couldn’t load the 12 months.</h1><p>${esc(b.error)}</p><p><button class="btn" id="brand-retry">Try again</button></p></section>`
    : b && b.reason === 'short' ? `<section class="headline" id="not-ready"><h1>Not a full month of sales yet</h1><p>The report starts on the 1st of the first month Shopify holds${b.from ? ` (we hold sales from ${esc(dayY(b.from))})` : ''}. Out now and All products work already.</p></section>`
    : `<section class="headline" id="not-ready"><h1>Getting 12 months of sales from Shopify.</h1><p>This page fills in when it’s done (after the first pull; the Shopify token needs read_reports). Out now and All products work already.</p></section>`;
  const bestShare = () => Math.round(((B().settings || {}).bestShare || 0.8) * 100);

  /* ---------- Brand report ---------- */
  function chart(months, w) {
    const W = Math.max(300, Math.round(w)), H = 210, L = 54, R = 8, T = 22, Bm = 26;
    const max = Math.max(1, ...months.map((m) => m.sold + m.lost));
    const step = niceStep(max / 4), top = Math.ceil(max / step) * step;
    const y = (v) => T + (H - T - Bm) * (1 - v / top);
    const bw = (W - L - R) / months.length, gap = Math.min(10, bw * 0.25);
    const ticks = []; for (let v = 0; v <= top; v += step) ticks.push(`<g><line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="gl"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${rs(v)}</text></g>`);
    const sel = null, keys = months.map((m) => m.key), who = scope() === 'all' ? ['product', 'products'] : ['best seller', 'best sellers'];
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
    const st = agencyStart(), si = st ? months.findIndex((m) => m.from <= st && st <= m.to) : -1, sx = si >= 0 ? L + si * bw + bw * ((Date.parse(st) - Date.parse(months[si].from)) / 864e5) / Math.max(1, months[si].days) : st && months.length && st < months[0].from ? L : null;   // 4.2.0: "We started"
    const mark = sx != null ? `<g class="started" aria-hidden="true"><line x1="${sx.toFixed(1)}" x2="${sx.toFixed(1)}" y1="${T - 16}" y2="${H - Bm}"/><text x="${(sx + 4).toFixed(1)}" y="${T - 8}">We started</text></g>` : '';
    return `<svg class="bchart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Sold and money missed each month">${ticks.join('')}${bars}${mark}</svg>`;
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
  const sumOf = (days, u, lost) => (days > 0 && u > 0 && lost > 0 ? `<small class="why-sum" title="Empty days × pieces a day × price paid. Open the product for every step.">${(Math.round(days * 2) / 2).toLocaleString('en-IN')} days × ${(Math.round((u / days) * 100) / 100).toLocaleString('en-IN')} a day × ₹${inr.format(Math.round(lost / u))}</small>` : '');
  const topUp = (p) => (p.allocation ? '<span class="best tu" title="Shopify shows a few pieces topped up from the warehouse: these gaps are refill waits, not counted in the totals (LOGIC §6)">website top-up</span>' : '');
  const offSale = (p) => (p.inactive ? '<span class="best tu off" title="Now draft or archived in Shopify. What it missed while on sale stays in the report.">No longer on sale</span>' : '');
  const heat = (d) => (d <= 0 ? 0 : d < 3 ? 1 : d < 8 ? 2 : d < 15 ? 3 : 4);

  /* ---------- 4.2.0 Brand report: month first (one month at a time, or the 12 months) ---------- */
  const DIM = (m) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate();
  const monthsOf = (b) => b.months.filter((m) => m.days);
  /** The month on screen: the one in the address (#brand/2026-10, #brand/12m), else the server's default (this month; last month on the 1st–3rd). */
  function selOf(b) {
    const ms = monthsOf(b), want = S().brandMonth;
    if (want === 'year') return 'year';
    if (want && ms.some((m) => m.key === want)) return want;
    const d = b.home && b.home.defaultMonth;
    return ms.some((m) => m.key === d) ? d : (ms[ms.length - 1] || {}).key;
  }
  const defaultMonth = (b) => { const d = b.home && b.home.defaultMonth, ms = monthsOf(b); return ms.some((m) => m.key === d) ? d : (ms[ms.length - 1] || {}).key; };
  /** "November" (this year's), "December 2025"; a first month held in part: "27–30 Sep" */
  const mWord = (b, m) => { const last = monthsOf(b).slice(-1)[0]; return partOf(m) ? `${+m.from.slice(8, 10)}–${day(m.to)}` : last && last.key.slice(0, 4) === m.key.slice(0, 4) ? MONTH[+m.key.slice(5, 7) - 1] : monthName(m.key); };
  /** the bar: "November 2026 · so far, 1–24 Nov" */
  const barText = (m) => (partOf(m) ? `${monthText(m)}${m.closed ? '' : ' · so far'}` : m.closed ? monthName(m.key) : narrow() ? `${mShort(m.key)} ${m.key.slice(0, 4)} · ${+m.from.slice(8, 10)}–${+m.to.slice(8, 10)} so far` : `${monthName(m.key)} · so far, ${+m.from.slice(8, 10)}–${day(m.to)}`);   // phones: "Nov 2026 · 1–24 so far"
  const dates = (a, b) => (a === b ? day(a) : a.slice(0, 7) === b.slice(0, 7) ? `${+a.slice(8, 10)}–${day(b)}` : `${day(a)} – ${day(b)}`);
  const prevText = (p) => (p.whole && p.from.slice(8) === '01' ? MONTH[+p.key.slice(5, 7) - 1] : dates(p.from, p.to));
  const daysNum = (x) => (Math.round((+x || 0) * 2) / 2).toLocaleString('en-IN');
  const agencyStart = () => { const s = (S().settings || {}).agencyStart; return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
  const WHY_SHORT = { later: 'out over 60 days', 'few-days': 'too few days in stock to know their sales', 'few-sales': 'too few sales to estimate', 'started-empty': 'already empty when our record began', gift: 'a gift line', unsure: 'Shopify’s stock record doesn’t add up', sib: 'another size was in stock' };
  const whyShort = (x) => (x.why && x.why.length ? x.why.map((k) => WHY_SHORT[k] || k) : x.later > 0 ? [WHY_SHORT.later] : x.est ? ['they hardly sell'] : x.apart ? ['topped up from the warehouse'] : ['too new to know their sales']);
  /** 4.2.0: a month that was only website top-ups (src/agency.js: its ₹ all apart) is not "ran out", as in the server's count */
  const topUpOnly = (c) => (c.apart || 0) > 0 && c.apart >= (c.lost || 0) - 1;
  const inMonth = (p, m) => { const c = p.months && p.months[m.key]; return !!c && (c.daysOut > 0 || (c.counted ?? c.lost) > 0) && !topUpOnly(c) && (scope() === 'all' || (rule() ? c.best : p.best)); };

  /** The products of one month for the scope: paid = carry ₹ (the list), none = empty but no ₹ (the grey line). Their ₹ adds up to the month's. */
  function monthList(b, m) {
    const paid = [], none = [];
    for (const p0 of b.products) {
      if (!inMonth(p0, m)) continue;
      const p = viewOf(b, p0), c = p.months[m.key], row = { ...p, id: p.variantId, x: { ...c, counted: c.counted ?? c.lost ?? 0 }, mrank: rule() ? c.rank ?? null : rankOf(p) };
      (row.x.counted > 0 ? paid : none).push(row);
    }
    const byRank = (a, c) => (a.mrank || 1e9) - (c.mrank || 1e9) || c.x.counted - a.x.counted;
    paid.sort(S().brandSort === 'rank' ? byRank : (a, c) => c.x.counted - a.x.counted || c.x.daysOut - a.x.daysOut || byRank(a, c));
    none.sort((a, c) => byRank(a, c) || c.x.daysOut - a.x.daysOut);
    return { paid, none };
  }
  /** One small cell per day of the month so far: in stock / empty / out part of the day / not on the website (hatched). */
  function strip(b, p, m) {
    const s = p.strip || '', from = (b.home && b.home.stripFrom) || m.from, n = DIM(m.key), base = (Date.parse(`${m.key}-01`) - Date.parse(from)) / 864e5;
    const set = new Set((p.x && p.x.dates) || []), out = [];
    for (let d = 1; d <= n; d++) {
      const k = `${m.key}-${String(d).padStart(2, '0')}`, i = Math.round(base + d - 1);
      if (k > m.to) break;   // days still to come are not drawn
      const ch = k < m.from ? 'n' : s ? (i >= 0 && i < s.length ? s[i] : '-') : set.has(k) ? '0' : '2';
      const [cls, what] = ch === '2' ? ['i', 'in stock'] : ch === '0' ? ['e', 'empty all day'] : ch === '1' ? ['h', 'out part of the day'] : ch === '-' ? ['o', 'not on the website'] : ch === 'n' ? ['o', 'before our record'] : ['f', 'still to come'];
      out.push(`<i class="d ${cls}" title="${d} ${MON[+m.key.slice(5, 7) - 1]}: ${what}"></i>`);
    }
    return `<span class="dstrip" style="--days:${n}" aria-label="${esc(`${nDays(p.x ? p.x.daysOut : 0)} empty in ${monthName(m.key)}`)}">${out.join('')}</span>`;
  }
  const legend = '<span class="dlegend muted small"><i class="d i"></i>in stock <i class="d e"></i>empty <i class="d h"></i>out part of the day <i class="d o"></i>off the website</span>';
  const outChip = (p) => (p.outNow ? `<span class="ochip out">${p.since ? `Out since ${day(p.since)}` : 'Out now'}</span>` : '');
  const rankChip = (n) => (n ? `<span class="ochip rk2" title="Rank by sales on the best-seller list">#${n} seller</span>` : '');
  const noSku = (p) => ({ ...p, sku: '' });   // 4.2.0: the code is in the CSV, not on the brand report's rows
  /** "6.5 days × ₹1,240 a day" from the parts: the days that count × ₹ a day on them */
  const half = (x) => { const v = Math.round((+x || 0) * 2) / 2, w = Math.floor(v); return v - w ? `${w || ''}½` : inr.format(w); };   // 6½, ½
  const sumLine = (x) => {
    const d = x.countedDays ?? x.moneyDays ?? x.daysOut, e = x.daysOut; if (!(d > 0 && x.counted > 0)) return '';
    const a = exact(x.counted / d);
    return Math.abs(d - e) < 0.25 ? `<small class="osum">${half(d)} day${d === 1 ? '' : 's'} × ${a} a day</small>`
      : `<small class="osum" title="Only days we can price count. The day it ran out counts as half.">${a} a day × ${half(d)} of ${half(e)} day${e === 1 ? '' : 's'} counted</small>`;
  };
  const listRow = (b, p, m) => `<div class="orow" data-product="${esc(p.variantId)}" tabindex="0" role="button">
      <span class="oname">${SW_PROD.cell(noSku(p), { size: 36, extra: offSale(p), sub: rankChip(p.mrank) + outChip(p) })}</span>
      <span class="ostrip">${strip(b, p, m)}</span>
      <span class="odays"><b>${daysNum(p.x.daysOut)}</b><small>empty day${p.x.daysOut === 1 ? '' : 's'}</small></span>
      <span class="omoney"><b class="lostv">${money(p.x.counted)}</b>${sumLine(p.x)}</span></div>`;
  /** "3 more were empty but we can't put a price on them: A, B, C (out over 60 days, or too new to know their sales). Ask the brand…" */
  function zeroLine(rows, id, more = true) {
    if (!rows.length) return '';
    const why = [...new Set(rows.flatMap((p) => (p.x ? whyShort(p.x) : Object.values(p.months || {}).filter((x) => x.daysOut > 0).flatMap(whyShort))))], show = rows.slice(0, 6);
    return `<p class="zero muted small" id="${id}">${inr.format(rows.length)}${more ? ' more' : ''} ${rows.length === 1 ? 'was' : 'were'} empty but we can’t put a price on ${rows.length === 1 ? 'it' : 'them'}: ${show.map((p) => `<button class="linkbtn nm" data-product="${esc(p.variantId)}">${esc(p.name)}</button>`).join(', ')}${rows.length > show.length ? '…' : ''} (${esc(why.join(', or '))}).${why.includes(WHY_SHORT.later) ? ` Ask the brand if they still sell ${rows.length === 1 ? 'it' : 'them'}.` : ''}</p>`;
  }
  const tile = (label, value, sub, { cls = '', href = '', id = '' } = {}) => `<${href ? `a href="${href}"` : 'div'} class="tile3 ${cls}"${id ? ` id="${id}"` : ''}><span class="tl">${label}</span><b class="tv">${value}</b>${sub ? `<small>${sub}</small>` : ''}</${href ? 'a' : 'div'}>`;
  /** best sellers (or products) out right now and what one more day costs (the Out now page's ₹ a day) */
  function nowTile(b) {
    const sa = scope() === 'all', rows = [...(b.now || []), ...(sa ? b.nowAll || [] : [])].filter((p) => p.out && !p.inactive && !p.allApart), n = rows.length;
    const perDay = rows.reduce((s, p) => s + (p.costPerDay || 0), 0);   // the same ₹ a day as Out now
    return tile('Empty right now', inr.format(n), `${sa ? (n === 1 ? 'product' : 'products') : n === 1 ? 'best seller' : 'best sellers'}${n ? `${perDay > 0 ? ` · about ${rs(perDay)} a day` : ''}` : ' · all in stock'}`, { cls: n ? 'bad' : '', href: '#best', id: 'tile-now' });
  }
  function monthBar(b, sel) {
    const ms = monthsOf(b), yr = sel === 'year', i = ms.findIndex((m) => m.key === sel), h = b.headline;
    const pv = yr ? null : ms[i - 1], nx = yr ? null : ms[i + 1];
    const label = yr ? (short(b) ? `Since ${dayY(h.from)}` : narrow() ? 'Last 12 months' : `Last 12 months · ${span(h.from, h.through)}`) : barText(ms[i]);
    return `<div class="monthbar" id="monthbar"><div class="mstep-g"><button class="mstep" data-month="${pv ? pv.key : ''}" ${pv ? '' : 'disabled'} aria-label="Month before">◀</button><span class="mname" id="mname" aria-live="polite">${esc(label)}</span><button class="mstep" data-month="${nx ? nx.key : ''}" ${nx ? '' : 'disabled'} aria-label="Month after">▶</button></div>
      <button class="y12${yr ? ' on' : ''}" data-month="${yr ? defaultMonth(b) : 'year'}" aria-pressed="${yr}">${short(b) ? 'All months' : '12 months'}</button></div>`;
  }
  /** young or loading stores say so in plain words (the reasons the report gives) */
  const short = (b) => b.span.days < 330;
  const storeName = (b) => (b.store && b.store.name) || 'The store';   // under 12 months held: "All months", "Since …"
  function notes(b) {
    const y = b.year || {}, held = b.span.days, out = [];
    if (short(b)) out.push(`We only have sales since ${dayY(b.span.from)}. Older months appear after the next Shopify sync.`);
    else if (y.done === false) out.push('Getting 12 months of sales from Shopify. This page fills in when it’s done.');
    if (noList(b)) out.push('No best-seller list yet. It needs 60 days of sales. Showing all products.');
    else if (held < 60) out.push(`A young store: ${inr.format(held)} days of sales so far. ₹ needs 60 days on the shelf, so most empty days carry no ₹ yet.`);
    return out.map((t) => `<p class="note">${esc(t)}</p>`).join('');
  }
  const howSure = (b) => `<details class="how exp" id="how-sure"><summary>How sure are we?</summary>${b.rule ? howNew(b) : `<p>A day is “empty” when the shelf was empty all day: nobody could buy it. Half a day when it ran out or came back that day. Money missed = how fast it sells on days it is in stock × the price people paid × empty days, made busier or quieter for the month. All from Shopify’s own sales and stock reports, so every number can be checked there.</p>`}</details>`;

  /** Past months, newest first: % of sales, missed, ran out, back in (days to refill); a divider where the agency started; the 12 months last. */
  function pastMonths(b, sel) {
    const sc = scope(), ms = monthsOf(b).slice().reverse(), h = { ...b.headline, ...b.headline[sc] }, max = Math.max(0.01, ...ms.map((m) => m[sc].pct || 0), h.pct || 0), st = agencyStart();
    const bar = (x) => `<span class="pbar" aria-hidden="true"><i style="width:${Math.min(100, ((+x || 0) / max) * 100).toFixed(1)}%"></i></span>${x ? pct(x) : '–'}`;
    const refill = (x) => (x > 0 ? nDays(x) : '–');
    const startM = st && ms.length ? (st.slice(0, 7) < ms[ms.length - 1].key ? ms[ms.length - 1].key : st.slice(0, 7)) : null;
    const divider = st ? `<tr class="started"><td colspan="5"><span>We started · ${esc(dayY(st))}</span></td></tr>` : '';
    const rows = ms.map((m) => `<tr data-month="${m.key}" tabindex="0" class="${m.key === sel ? 'on' : ''}"><td>${esc(partOf(m) ? monthText(m) : `${mShort(m.key)} ${m.key.slice(0, 4)}`)}${m.closed ? '' : ' <small class="muted">so far</small>'}</td><td class="pc">${bar(m[sc].pct)}</td><td class="r"><b class="${m[sc].lost ? 'lostv' : 'muted'}">${m[sc].lost ? money(m[sc].lost) : '–'}</b></td><td class="r m-hide">${m[sc].out || '–'}</td><td class="r m-hide">${refill(m[sc].refill)}</td></tr>${m.key === startM ? divider : ''}`).join('');
    return `<div class="panel" id="past"><div class="panel-head"><h2>Past months</h2><button class="btn ghost xs" id="csv-months">CSV</button></div>
      <table class="mtable ptable"><thead><tr><th>Month</th><th>% of sales</th><th class="r">Missed</th><th class="r m-hide">Ran out</th><th class="r m-hide">Back in</th></tr></thead>
      <tbody>${rows}<tr data-month="year" tabindex="0" class="yr${sel === 'year' ? ' on' : ''}"><td>${short(b) ? 'All months' : '12 months'}</td><td class="pc">${bar(h.pct)}</td><td class="r"><b class="lostv">${money(h.lost)}</b></td><td class="r m-hide">${inr.format(h.ranOut ?? h.bestRanOut ?? 0)}</td><td class="r m-hide">${refill(h.refill)}</td></tr></tbody></table>
      <p class="muted small">% of sales = missed ÷ what ${sc === 'all' ? 'all products' : 'best sellers'} sold.<span class="m-hide"> Back in = how long a sold-out item usually took to come back.</span></p></div>`;
  }

  function brandView() {
    if (need()) return loading;
    const b = B();
    if (!b.ok || b.ready === false || !monthsOf(b).length) return notReady(b);
    const sel = selOf(b);
    return sel === 'year' ? yearView(b) : monthView(b, monthsOf(b).find((m) => m.key === sel));
  }
  function monthView(b, m) {
    const sc = scope(), x = m[sc] || {}, { paid, none } = monthList(b, m), name = mWord(b, m);
    const Y = sc === 'all' ? b.headline.all.products : m.listN ?? b.headline.bestsellers, X = x.out ?? paid.length + none.length;
    const noun = sc === 'all' ? 'products' : 'best sellers';
    const top = [...paid, ...none].filter((p) => p.mrank && p.mrank <= 10).sort((a, c) => a.mrank - c.mrank);
    const pv = m.prev;
    const lim = S().brandAll ? paid.length : Math.min(12, paid.length);
    const sortBtn = (k, l) => `<button class="${(S().brandSort || 'money') === k ? 'on' : ''}" data-osort="${k}" aria-pressed="${(S().brandSort || 'money') === k}">${l}</button>`;
    return `${monthBar(b, m.key)}
      <section class="headline brand-h">
        <h1>${Y ? `${inr.format(X)} of ${inr.format(Y)} ${noun} ran out in ${esc(name)}. ${esc(storeName(b))} missed about <span class="lost">${money(x.lost)}</span>.` : `No sales recorded in ${esc(name)} yet.`}</h1>
        <p class="lead">${pct(x.pct)} of what ${sc === 'all' ? 'all products' : noun} sold (${money(x.sold ?? m.sold)}).</p>
        ${top.length ? `<p class="top10" id="top10">${top.length} of the top 10 ran out: ${top.map((p) => `<button class="linkbtn nm" data-product="${esc(p.variantId)}">#${p.mrank} ${esc(p.name)}</button>`).join(', ')}.</p>` : ''}
        ${howSure(b)}${notes(b)}
      </section>
      <div class="tiles3" id="tiles3">
        ${tile('Missed', money(x.lost), pv ? `${esc(prevText(pv))}: ${rs(pv[sc].lost)}` : '', { cls: x.lost > 0 ? 'bad' : '', id: 'tile-missed' })}
        ${tile(X > 1 ? `Empty days, all ${inr.format(X)} added up` : 'Empty days', inr.format(Math.round(x.daysOut || 0)), pv ? `${esc(prevText(pv))}: ${inr.format(Math.round(pv[sc].empty))}` : '', { id: 'tile-empty' })}
        ${nowTile(b)}
      </div>
      <div class="hgrid">
        <div class="panel" id="olist"><div class="panel-head"><h2>${sc === 'all' ? 'Products' : 'Best sellers'} that ran out in ${esc(name)}</h2><span class="tb"><span class="osort" role="group" aria-label="Sort the list">${sortBtn('money', '₹')}${sortBtn('rank', 'Rank')}</span><button class="btn ghost xs" id="csv-month">CSV</button></span></div>
          ${paid.length ? `${legend}<div class="olist">${paid.slice(0, lim).map((p) => listRow(b, p, m)).join('')}</div>${paid.length > 12 ? `<div class="more"><button class="btn ghost" id="brand-all">${S().brandAll ? 'Show the first 12' : `Show all ${paid.length}`}</button></div>` : ''}`
            : `<p class="muted">${none.length ? `No ${scopeName(sc, true)} carries ₹ in ${esc(name)}.` : `No ${scopeName(sc, true)} ran out in ${esc(name)}.`}</p>`}
          ${zeroLine(none, 'zero-month', paid.length > 0)}</div>
        ${pastMonths(b, m.key)}
      </div>`;
  }
  function yearView(b) {
    const sc = scope(), h = { ...b.headline, ...b.headline[sc] }, months = monthsOf(b).map(inScope), ms = months.map((m) => m.key);
    const A = sc === 'all' ? h.ranOut : h.bestRanOut ?? h.ranOut, Bn = sc === 'all' ? h.products : h.bestsellers, noun = sc === 'all' ? 'products' : 'best sellers';
    const when = b.span.days >= 330 ? 'in the last 12 months' : `since ${dayY(h.from)}`;
    const list = b.products.map((p) => viewOf(b, p)).filter((p) => (sc === 'all' || rule() || p.best) && p.daysOut > 0 && !p.allApart);   // rule: viewOf keeps only the months it was on the list
    const paid = list.filter((p) => counted(p) > 0).sort((a, c) => counted(c) - counted(a) || c.daysOut - a.daysOut), none = list.filter((p) => !(counted(p) > 0)).sort((a, c) => c.daysOut - a.daysOut);
    const top = S().brandAll ? paid.length : Math.min(narrow() ? 8 : 12, paid.length);
    return `${monthBar(b, 'year')}
      <section class="headline brand-h">
        <h1>${inr.format(A)} of ${inr.format(Bn)} ${noun} ran out ${when}. ${esc(storeName(b))} missed about <span class="lost">${money(h.lost)}</span> (${pct(h.pct)} of ${money(h.sold)} sold).</h1>
        ${howSure(b)}${notes(b)}
      </section>
      <div class="hgrid">
        <div class="ycol">
          <div class="panel"><div class="panel-head"><h2>Sold and missed, each month</h2><span class="muted small"><i class="sw sold"></i> sold${sc === 'all' ? '' : ' (best sellers)'} <i class="sw lost"></i> missed${months.some((m) => m.days < 28) ? ' · * part of the month' : ''}${agencyStart() ? ' · <i class="sw st"></i> we started' : ''}</span></div><div id="brand-chart">${chart(months, 600)}</div></div>
          <div class="panel"><div class="panel-head"><h2>Which ${noun} ran out, and when</h2><span class="muted small">Empty days each month. Darker = longer. Tap a month to open it.</span></div>
            ${paid.length ? `<div class="heat" style="--mcols:${ms.length}"><div class="hrow hhead"><span></span>${ms.map((k) => `<button class="hm" data-month="${k}" title="${esc(monthText(months[ms.indexOf(k)]))}">${shortLabel(k, ms)}</button>`).join('')}<span class="r" title="${esc(span(h.from, h.through))}">Missed</span></div>
              ${paid.slice(0, top).map((p) => `<div class="hrow"><span class="hp" data-product="${esc(p.variantId)}" tabindex="0" role="button">${SW_PROD.cell(noSku(p), { size: 32, sub: rankChip(rankOf(p)), extra: topUp(p) + offSale(p) })}</span>${ms.map((k) => { const x = p.months && p.months[k]; const d = x ? x.daysOut : 0; return `<span class="hc h${heat(d)}" data-month="${k}" title="${esc(x && d ? `${p.name}: ${nDays(d)} empty in ${monthName(k)} (${x.range}). ${counted(x) ? `About ${exact(counted(x))} missed` : 'No ₹'}.` : `${p.name}: in stock all of ${monthName(k)}`)}">${d ? Math.round(d) || '½' : ''}</span>`; }).join('')}<span class="r hv"><b class="lostv">${money(counted(p))}</b><small class="ph-only"> missed</small></span></div>`).join('')}
              ${paid.length > 12 ? `<div class="more"><button class="btn ghost" id="brand-all">${S().brandAll ? 'Show the first 12' : `Show all ${paid.length}`}</button></div>` : ''}</div>` : `<p class="muted">No ${scopeName(sc, true)} carries ₹ in these months.</p>`}
            ${zeroLine(none, 'zero-year', paid.length > 0)}</div>
        </div>
        ${pastMonths(b, 'year')}
      </div>`;
  }
  function csvMonths() {
    const b = B(), sc = scope(), w = scopeName(sc);
    const head = ['Month', 'From', 'To', `Sold ₹ (${w}, net, ex GST)`, `Missed ₹ (${w}, counted)`, '% of sales', `${sc === 'all' ? 'Products' : 'Best sellers'} that ran out`, `Empty days (${w})`, 'Days to refill (middle stock-out that came back)'];
    const rows = monthsOf(b).map((m) => { const x = m[sc]; return [monthText(m), m.from, m.to, x.sold ?? m.sold, x.lost, x.pct, x.out, x.daysOut, x.refill ?? '']; });
    A.saveCsv(`brand-report-months-${sc === 'all' ? 'all-products' : 'best-sellers'}-${b.asOf.through}.csv`, [head, ...rows]);
  }
  function csvMonth() {
    const b = B(), key = selOf(b), m = monthsOf(b).find((z) => z.key === key); if (!m) return;
    const { paid, none } = monthList(b, m);
    const head = ['Month', 'Product', 'SKU', 'Variant ID', 'Best seller', 'Rank', 'Empty dates', 'Empty days', 'Money missed ₹', 'No ₹ because', ...SW_PROD.CSV_HEAD];
    const rows = [...paid, ...none].map((p) => [monthText(m), p.name, p.sku, p.variantId, p.best ? 'yes' : 'no', p.mrank || '', (p.x.dates || []).join(' '), p.x.daysOut, p.x.counted, p.x.counted > 0 ? '' : whyShort(p.x).join(' / '), ...SW_PROD.csv(p)]);
    A.saveCsv(`brand-report-${scope() === 'all' ? 'all-products' : 'best-sellers'}-${m.key}.csv`, [head, ...rows]);
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
      { k: 'daysOutMonth', label: `Empty days in ${mShort(m.key)}`, r: 1, f: (p) => (p.daysOutMonth ? `<span title="${esc(p.rangeMonth)}">${inr.format(Math.round(p.daysOutMonth * 2) / 2)}</span>` : '–') },
      { k: 'lostMonth', label: `Missed in ${mShort(m.key)}`, r: 1, f: (p) => (p.lostMonth ? `<b class="lostv">${money(p.lostMonth)}</b>${sum(p.daysOutMonth, p.unitsMonth, p.missedMonthAll, p.moneyDaysMonth)}` : '–') },
      { k: 'pace', label: 'Sells', r: 1, tip: rule() ? 'Pieces a day when it is in stock, last 12 months' : 'How fast it sells on days it is in stock (last 6 months)', f: (p) => esc(pace(p.pace.perDay)), val: (p) => p.pace.perDay },
      { k: 'times', label: 'Times out, 12 months', r: 1, tip: 'Separate times it ran out in the last 12 months, and in how many months', f: (p) => (p.times ? `${inr.format(p.times)}× <span class="muted">in ${p.monthsOut} month${p.monthsOut === 1 ? '' : 's'}</span>` : '–') },
      { k: 'counted', label: 'Missed, 12 months', r: 1, f: (p) => (p.counted ? `<b class="lostv">${money(p.counted)}</b>` : '–') },
      ...(rule() ? [{ k: 'could', label: 'Sold + missed, 12 months', r: 1, tip: 'Net sales plus money missed', f: (p) => (p.could != null ? money(p.could) : '–'), val: (p) => p.could || 0 }] : []),
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
  /** 4.2.0: show a month (or 'year' = the 12 months); the address keeps it (#brand/2026-10, #brand/12m) without a new history step */
  function selectMonth(k, focusSel = null) {
    if (!k) return;
    S().brandMonth = k; S().brandAll = false;
    try { const u = new URL(location.href); u.hash = `brand/${k === 'year' ? '12m' : k}`; history.replaceState(history.state, '', u); } catch { /* */ }
    A.render();
    if (focusSel) refocus(focusSel);
    const bar = document.getElementById('monthbar'); if (bar && bar.getBoundingClientRect().top < 0) bar.scrollIntoView({ block: 'start' });
  }
  document.addEventListener('click', (e) => {
    if (!A) return;
    const t = e.target.closest('[data-month], [data-scope], [data-osort], #csv-months, #csv-month, #brand-all, #ads-all, #brand-retry, [data-ads-copy], [data-ads-csv]');
    if (!t) return;
    if (t.dataset.scope) { setScope(t.dataset.scope); S().limit.brandmonth = 0; S().pick.clear(); const v = t.dataset.scope, back = () => refocus(`[data-scope="${v}"]`); A.render(); back(); Promise.resolve(A.reload()).then(() => { if (!document.activeElement || document.activeElement === document.body) back(); }); return; }
    if (t.id === 'brand-retry') { t.disabled = true; fetchBrand(true).then(() => A.render()); return; }
    if (t.dataset.month !== undefined) {
      const k = t.dataset.month, step = t.classList.contains('mstep'), y12 = t.classList.contains('y12');
      selectMonth(k, step ? `.mstep[aria-label="${t.getAttribute('aria-label')}"]:not([disabled])` : y12 ? '.y12' : `.ptable tr[data-month="${k}"]`);
      return;
    }
    if (t.dataset.osort) { S().brandSort = t.dataset.osort; A.render(); refocus(`[data-osort="${t.dataset.osort}"]`); return; }
    if (t.id === 'csv-months') return csvMonths();
    if (t.id === 'csv-month') return csvMonth();
    if (t.id === 'brand-all') { S().brandAll = !S().brandAll; A.render(); return; }
    if (t.id === 'ads-all') { S().adsAll = true; A.render(); return; }
    if (t.dataset.adsCopy) { const rows = adsOf()[t.dataset.adsCopy] || []; A.copy(rows.map((p) => `${p.sku || p.id}\t${p.name}`).join('\n')); return; }
    if (t.dataset.adsCsv) adsCsv(t.dataset.adsCsv);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-month]:not(button)')) { e.preventDefault(); e.target.click(); }
  });
  /* the chart at its box's real width (no scaling), like the daily chart; 4.2.0: the month bar sticks under the top bar */
  function after(view) {
    if (view !== 'brand' || !B() || !B().ok) return;
    const mb = document.getElementById('monthbar'), top = document.querySelector('.top');
    if (mb && top) { const cs = getComputedStyle(top); mb.style.top = `${(cs.position === 'sticky' || cs.position === 'fixed') && top.offsetHeight > 0 ? top.offsetHeight : 0}px`; }
    const box = document.getElementById('brand-chart'), svg = box && box.querySelector('svg');
    if (!svg) return;
    const w = Math.floor(box.clientWidth);
    if (w > 0 && Math.abs(w - +svg.getAttribute('width')) > 1) svg.outerHTML = chart(B().months.filter((m) => m.days).map(inScope), w);
  }

  window.SW_BRAND = {
    init(ctx) { A = ctx; },
    views: { brand: brandView, best: bestView, ads: adsView },
    fetch: fetchBrand, reset() { if (A) { A.state.brand = null; } }, after, rs, pace, scopeLine, scope, paintScope, selectMonth, factorText,
  };
})();
