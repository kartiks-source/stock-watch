/* 1.4.1 (LOGIC §24): the product drawer as a 12-month profile. Loaded before app.js; app.js builds the drawer from
 *   SW_PROFILE.top(p, prof, statusHtml)   big picture, name, code, best-seller rank, status now, links
 *   SW_PROFILE.body(prof, p)              story, key numbers, 12-month chart, price and discount, day calendar,
 *                                         stock level, season, month by month, details
 *   SW_PROFILE.charts(root, prof)         draws the charts when they scroll into view (lazy, inline SVG, no library)
 * prof = GET /api/product/:id → profile (src/agency.js profile). Copy: .claude/skills/plain-copy (every number with its dates). */
(() => {
  'use strict';
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const rs = (x) => {
    const v = Math.round(+x || 0), a = Math.abs(v), s = v < 0 ? '−' : '';
    const one = (n) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10).toLocaleString('en-IN');
    if (a >= 1e7) return `${s}₹${one(a / 1e7)} Cr`;
    if (a >= 1e5) return `${s}₹${one(a / 1e5)} lakh`;
    if (a >= 1e3) return `${s}₹${one(a / 1e3)}k`;
    return `${s}₹${inr.format(a)}`;
  };
  const money = (x) => `<span title="₹${inr.format(Math.round(+x || 0))}">${rs(x)}</span>`;
  const day = (k) => (k ? `${+k.slice(8, 10)} ${MON[+k.slice(5, 7) - 1]}` : '–');
  const dayY = (k) => (k ? `${day(k)} ${k.slice(0, 4)}` : '–');
  const span = (a, b) => (a && b ? (a === b ? dayY(a) : a.slice(0, 7) === b.slice(0, 7) ? `${+a.slice(8, 10)}–${dayY(b)}` : a.slice(0, 4) === b.slice(0, 4) ? `${day(a)} – ${dayY(b)}` : `${dayY(a)} – ${dayY(b)}`) : '');
  const mShort = (m) => MON[+m.slice(5, 7) - 1];
  const mName = (m) => `${MONTH[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
  const nDays = (x) => { const v = Math.round((+x || 0) * 2) / 2; return `${v.toLocaleString('en-IN')} day${v === 1 ? '' : 's'}`; };
  const n1 = (x) => (Math.round((+x || 0) * 10) / 10).toLocaleString('en-IN');
  const units = (x) => { const v = +x || 0; return v >= 10 ? inr.format(Math.round(v)) : v >= 1 ? String(Math.round(v)) : v > 0 ? 'less than 1' : '0'; };
  const pace = (perDay) => {
    if (!(perDay > 0)) return 'no sales';
    if (perDay >= 0.95) return `${Math.round(perDay).toLocaleString('en-IN')} a day`;
    if (perDay * 7 >= 0.95) return `${Math.round(perDay * 7)} a week`;
    return `${Math.max(1, Math.round(perDay * 30.4))} a month`;
  };
  const dateOf = (t) => { if (!t) return null; const d = new Date(+t + 330 * 60e3); return d.toISOString().slice(0, 10); };

  /* ---------- 1. header ---------- */
  function top(p, prof, statusHtml) {
    const ok = prof && prof.ok;
    const rank = ok && prof.rank ? `<span class="prank" title="By net sales over ${esc(span(prof.span.from, prof.span.through))}">#${inr.format(prof.rank.n)} of ${inr.format(prof.rank.of)} by sales, 12 months</span>` : '';
    const best = ok && prof.best ? '<span class="best">Best seller</span>' : '';
    const top = ok && prof.allocation ? '<span class="best tu" title="Shopify shows a few pieces the warehouse tops up (LOGIC §6)">website top-up</span>' : '';
    return SW_PROD.hero(p, `<div class="toolbar">${best}${rank}${top}</div><div class="toolbar">${statusHtml || ''}</div>`);
  }

  /* ---------- 2–10. body ---------- */
  function story(prof) {
    const o = prof.outs, sp = span(prof.span.from, prof.span.through);
    const a = prof.pace.perDay > 0 ? `Sells about ${pace(prof.pace.perDay)} when it is in stock.` : 'It hardly sold in these months.';
    const b = o.times ? `Ran out ${o.times === 1 ? 'once' : o.times === 2 ? 'twice' : `${o.times} times`} in ${prof.span.days >= 330 ? 'the last 12 months' : 'these days'}, ${nDays(o.days)} in all.` : 'It never ran out in the last 12 months.';
    const c = prof.missed.value > 0 ? `That cost about ${rs(prof.missed.value)} in sales.` : '';
    return `<p class="pstory">${esc(a)} ${esc(b)} ${esc(c)} <span class="muted small">(${esc(sp)})</span></p>`;
  }
  const kv = (label, value, sub = '', cls = '', id = '') => `<div class="kv ${cls}"${id ? ` id="${id}"` : ''}><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  function grid(prof, p) {
    const o = prof.outs, sp = span(prof.span.from, prof.span.through);
    const stockNow = p && p.stock != null ? (p.stock <= 0 ? kv('Stock now', '0', 'out of stock', 'bad') : kv('Stock now', inr.format(p.stock), p.daysLeft != null ? `about ${inr.format(Math.round(p.daysLeft))} days left at the recent pace` : '')) : '';
    const rr = prof.lastRestock;
    return `<div class="kgrid" title="${esc(sp)}">
      ${kv('Sold, 12 months', `${inr.format(prof.sold.units)} · ${money(prof.sold.value)}`, `${n1(prof.share)}% of the store’s sales`)}
      ${kv('Sells, on days in stock', esc(pace(prof.pace.perDay)), `${n1(prof.pace.perDay)} a day · ${inr.format(Math.round(prof.pace.perWeek * 10) / 10)} a week · ${inr.format(Math.round(prof.pace.perMonth))} a month`)}
      ${kv('On the shelf', `${prof.inStock.pct ?? '–'}% of ${prof.inStock.of >= 330 ? 'the year' : 'the days'}`, `${inr.format(Math.round(prof.inStock.days))} of ${inr.format(prof.inStock.of)} days in stock`)}
      ${kv('Ran out', o.times ? `${o.times}× · ${esc(nDays(o.days))}` : 'never', o.longest ? `longest ${esc(nDays(o.longest.days))}: ${esc(span(o.longest.from, o.longest.to))}${o.open && o.longest.to === prof.span.through ? ' (still out)' : ''}` : '', o.times ? 'bad' : '')}
      ${kv('Money missed', prof.missed.value ? money(prof.missed.value) : '₹0', prof.missed.units ? `about ${units(prof.missed.units)} it would have sold` : '', prof.missed.value ? 'bad' : '')}
      ${stockNow}
      ${kv('Last restock', rr ? `+${inr.format(rr.qty)}` : '–', rr ? `on ${esc(dayY(rr.day))}` : 'none in 12 months')}
      ${p && p.returnPct != null ? kv('Cancelled or refunded', `${n1(p.returnPct)}%`, `last 30 days: ${inr.format(p.unitsReturned)} of ${inr.format(p.unitsOrdered)} ordered${p.unitsCancelled ? `, ${inr.format(p.unitsCancelled)} cancelled` : ''} · ${rs(p.refundValue)} back`, '', 'returns-tile') : ''}
    </div>`;
  }
  function priceBlock(prof) {
    const pr = prof.price;
    if (!pr || pr.paidEx == null) return '';
    const parts = [
      kv('MRP', pr.mrp ? `₹${inr.format(pr.mrp)}` : '–', pr.mrp ? 'the “compare at” price in Shopify' : 'no compare-at price set'),
      kv('List price', `₹${inr.format(pr.list)}`, 'with GST'),
      kv('Paid on average', `₹${inr.format(pr.paidIn)}`, (pr.gstPct != null ? `₹${inr.format(pr.paidEx)} without GST · GST ${n1(pr.gstPct)}%` : 'GST not in this data')),
      kv('Discount', pr.offMrpPct != null ? `${n1(pr.offMrpPct)}% off MRP` : pr.offListPct != null ? `${n1(pr.offListPct)}% off list` : '–', pr.offMrpPct != null && pr.offListPct != null ? `${n1(pr.offListPct)}% off the list price` : ''),
    ];
    return `<section class="panel"><div class="panel-head"><h2>Price and discount</h2><span class="muted small">${esc(span(prof.span.from, prof.span.through))}</span></div>
      <div class="kgrid k4">${parts.join('')}</div>
      <div class="lazy-chart" data-chart="price" style="height:130px"></div>
      <p class="muted small">Line = price paid each month (with GST); bars = units sold. Did discounts drive sales? Compare the two.</p></section>`;
  }
  function calendar(prof) {
    const cal = prof.calendar || []; if (!cal.length) return '';
    const dow = (new Date(`${cal[0][0]}T00:00:00Z`).getUTCDay() + 6) % 7;
    const cells = [...Array(dow).fill('<i class="cd e"></i>'), ...cal.map(([k, f], i) => { const u = prof.stock && prof.stock[i] ? prof.stock[i][2] : null; const tip = [dayY(k), f >= 1 ? 'In stock all day' : f > 0 ? 'Ran out or came back that day (about half the day out)' : 'Out of stock all day', u != null ? `${inr.format(u)} sold` : ''].filter(Boolean).join('\n'); return `<i class="cd ${f >= 1 ? 'in' : f > 0 ? 'half' : 'out'}" data-tip="${esc(tip)}"></i>`; })].join('');
    return `<section class="panel ycal"><div class="panel-head"><h2>Every day on the shelf</h2><span class="muted small">${esc(span(prof.span.from, prof.span.through))}</span></div>
      <div class="calwrap"><div class="cal" aria-label="One square per day, Monday at the top">${cells}</div></div>
      <p class="muted small"><i class="sw in"></i> could be bought all day <i class="sw half"></i> ran out or came back that day <i class="sw out"></i> nobody could buy it. One square per day, a column per week.</p></section>`;
  }
  function seasonBlock(prof) {
    const s = prof.season; if (!s) return '';
    const fmt = (x) => `${mShort(x.m)} ×${n1(x.v)}`;
    const cmp = s.thisMonth && s.lastYear ? (() => {
      const a = s.thisMonth, b = s.lastYear;
      return `<p class="small"><b>${esc(mName(a.key))}</b> so far: sold ${inr.format(a.units)} in ${esc(nDays(a.inDays))} in stock${a.perDay != null ? ` (${n1(a.perDay)} a day)` : ''}. <b>${esc(mName(b.key))}</b>: sold ${inr.format(b.units)} in ${esc(nDays(b.inDays))} in stock${b.perDay != null ? ` (${n1(b.perDay)} a day)` : ''}.</p>`;
    })() : '';
    return `<section class="panel"><div class="panel-head"><h2>Busy and quiet months</h2><span class="muted small">${s.own ? 'from its own sales' : 'from the whole store’s sales (too few of its own)'}</span></div>
      <p class="small">${s.busiest.length ? `Sells more in ${esc(s.busiest.map(fmt).join(', '))}.` : 'No clearly busy month.'} ${s.quietest.length ? `Sells less in ${esc(s.quietest.map(fmt).join(', '))}.` : ''} <span class="muted">×1 = a normal month; ×1.5 = half as much again.</span></p>${cmp}</section>`;
  }
  function monthList(prof) {
    const ms = prof.months.filter((m) => m.daysOut > 0 || m.missed > 0).slice().reverse();
    if (!ms.length) return '';
    return `<section class="panel"><h2>Month by month</h2><div class="ylost">${ms.map((m) => `<p><b>${esc(mName(m.key))}:</b> out for ${esc(nDays(m.daysOut))}. It sold ${inr.format(m.units)} and would have sold about ${units(m.missedUnits)} more. <b class="lostv">${money(m.missed)}</b> missed.</p>`).join('')}</div></section>`;
  }
  function details(prof) {
    const d = prof.details; if (!d) return '';
    const row = (k, v) => (v ? `<div><span>${k}</span><b>${v}</b></div>` : '');
    return `<section class="panel"><h2>Details</h2><div class="pdet">
      ${row('Category', esc(d.type))}${row('Brand / vendor', esc(d.vendor))}
      ${row('Launched', d.createdAt ? esc(dayY(dateOf(d.createdAt))) : '')}${row('On the website', d.publishedAt ? `since ${esc(dayY(dateOf(d.publishedAt)))}` : d.published === false ? 'not on the website' : '')}
      ${row('Collections', d.collections && d.collections.length ? esc(d.collections.join(', ')) : '')}
      ${row('Tags', d.tags && d.tags.length ? `<span class="ptags">${d.tags.slice(0, 24).map((t) => `<i>${esc(t)}</i>`).join('')}</span>` : '')}
    </div></section>`;
  }
  function body(prof, p, order = '') {
    if (!prof || !prof.ok) return order + (prof && prof.reason === 'unsure' ? '<p class="note">Shopify’s stock log doesn’t add up for this product, so its 12 months aren’t shown.</p>' : '<p class="muted small">The 12-month profile appears once Shopify’s reports are read (after the next pull).</p>');
    return `${story(prof)}${grid(prof, p)}${order}
      <section class="panel"><div class="panel-head"><h2>12 months: sold and missed</h2><span class="muted small">${esc(span(prof.span.from, prof.span.through))}</span></div>
        <div class="chartbox"><div class="lazy-chart" data-chart="months" style="height:210px"></div></div>
        <p class="muted small"><i class="sw sold"></i> sold <i class="sw ghost"></i> would have sold while out <i class="sw out"></i> days out (under the month) <i class="sw line"></i> busy-month line (×1 = normal)</p></section>
      ${priceBlock(prof)}
      ${calendar(prof)}
      <section class="panel"><div class="panel-head"><h2>Stock level</h2><span class="muted small">pieces at each day’s end · ${esc(span(prof.span.from, prof.span.through))}</span></div>
        <div class="chartbox"><div class="lazy-chart" data-chart="stock" style="height:160px"></div></div>
        <p class="muted small">Shaded = out of stock. ▲ = restocked (+pieces).</p></section>
      ${seasonBlock(prof)}${monthList(prof)}${details(prof)}`;
  }

  const priceOf = (prof, key) => (prof.price && prof.price.byMonth ? prof.price.byMonth.find((m) => m.key === key) : null);

  /* ---------- 1.4.3: details on hover, tap and keyboard focus: one small box inside the drawer, no library ---------- */
  let tipEl = null, tipFor = null;
  function showTip(el) {
    const card = el.closest('.drawer-card'); if (!card) return;
    if (!tipEl || !card.contains(tipEl)) { tipEl = document.createElement('div'); tipEl.className = 'ptip'; tipEl.setAttribute('role', 'tooltip'); tipEl.id = 'ptip'; card.append(tipEl); }
    tipEl.innerHTML = String(el.getAttribute('data-tip') || '').split('\n').map((l, i) => (i ? `<div>${esc(l)}</div>` : `<b>${esc(l)}</b>`)).join('');
    tipEl.hidden = false; tipFor = el;
    const c = card.getBoundingClientRect(), r = el.getBoundingClientRect(), tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    let left = r.left + r.width / 2 - c.left - tw / 2 + card.scrollLeft, top = r.top - c.top + card.scrollTop - th - 8;
    left = Math.max(8, Math.min(card.clientWidth - tw - 8, left));
    if (r.top - c.top - th - 8 < 0) top = r.bottom - c.top + card.scrollTop + 8;   // no room above: below
    tipEl.style.left = `${left}px`; tipEl.style.top = `${top}px`;
  }
  const hideTip = () => { if (tipEl) tipEl.hidden = true; tipFor = null; };
  document.addEventListener('pointerover', (e) => { const t = e.target.closest && e.target.closest('#drawer-body [data-tip]'); if (t) showTip(t); else if (tipFor && e.pointerType === 'mouse' && !(e.target.closest && e.target.closest('.ptip'))) hideTip(); });
  document.addEventListener('focusin', (e) => { const t = e.target.closest && e.target.closest('#drawer-body [data-tip]'); if (t) showTip(t); else hideTip(); });
  document.addEventListener('click', (e) => { const t = e.target.closest && e.target.closest('#drawer-body [data-tip]'); if (t) { if (tipFor === t && e.pointerType === 'touch') hideTip(); else showTip(t); } else if (!(e.target.closest && e.target.closest('.ptip'))) hideTip(); });
  document.addEventListener('scroll', (e) => { if (e.target && e.target.classList && e.target.classList.contains('chartbox')) hideTip(); }, true);

  /** Placeholders while the profile loads: the same blocks and heights, so nothing jumps when it arrives. */
  const skeleton = () => `<div class="sk" style="height:64px"></div><div class="kgrid">${'<div class="kv sk" style="height:84px"></div>'.repeat(8)}</div><div class="panel"><div class="sk" style="height:250px"></div></div><div class="panel"><div class="sk" style="height:220px"></div></div>`;

  /* ---------- charts (inline SVG, drawn at the box's width when they scroll into view) ---------- */
  function niceStep(x) { const q = 10 ** Math.floor(Math.log10(Math.max(1e-9, x))); const m = x / q; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * q; }
  function monthsChart(prof, W) {
    const ms = prof.months.filter((m) => m.days), H = 210, L = 34, R = 34, T = 16, B = 38, n = ms.length;   // months held only
    const max = Math.max(1, ...ms.map((m) => m.units + m.missedUnits));
    const step = niceStep(max / 4), topV = Math.ceil(max / step) * step;
    const y = (v) => T + (H - T - B) * (1 - v / topV), bw = (W - L - R) / n, gap = Math.min(10, bw * 0.28);
    const sy = (v) => T + (H - T - B) * (1 - (Math.min(2, Math.max(0.5, v)) - 0.5) / 1.5);
    const grid = []; for (let v = 0; v <= topV + 1e-9; v += step) grid.push(`<line class="gl" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 5}" y="${y(v) + 4}" text-anchor="end">${inr.format(v)}</text>`);
    const bars = ms.map((m, i) => {
      const x = L + i * bw + gap / 2, w = bw - gap, pm = priceOf(prof, m.key);
      const tip = [mName(m.key) + (m.days < 28 ? ` (${m.days} days held)` : ''), `Sold ${inr.format(m.units)} · ${rs(m.value)}`, m.daysOut ? `Out ${nDays(m.daysOut)}: would have sold about ${units(m.missedUnits)} more, ${rs(m.missed)} missed` : 'In stock all month',
        `Busy-month index ×${n1(m.season)}${m.own ? '' : ' (the store’s)'}`, pm && pm.paidIn != null ? `Paid ₹${inr.format(pm.paidIn)} on average with GST${prof.price.mrp ? ` (${n1((1 - pm.paidIn / prof.price.mrp) * 100)}% off MRP)` : ''}` : ''].filter(Boolean).join('\n');
      const outW = m.days ? Math.min(w, (w * m.daysOut) / m.days) : 0;
      return `<g class="tipg" tabindex="0" role="img" aria-label="${esc(tip.replace(/\n/g, '. '))}" data-tip="${esc(tip)}"><rect class="hit" x="${L + i * bw}" y="${T}" width="${bw}" height="${H - T - 2}"/>
        <rect class="sold" x="${x}" y="${y(m.units)}" width="${w}" height="${Math.max(0, y(0) - y(m.units))}" rx="2"/>
        ${m.missedUnits > 0 ? `<rect class="ghost" x="${x}" y="${y(m.units + m.missedUnits)}" width="${w}" height="${Math.max(1, y(m.units) - y(m.units + m.missedUnits))}" rx="2"/>` : ''}
        <rect class="otrack" x="${x}" y="${H - B + 4}" width="${w}" height="5" rx="2"/>${outW > 0 ? `<rect class="out" x="${x}" y="${H - B + 4}" width="${Math.max(2, outW)}" height="5" rx="2"/>` : ''}
        <text x="${x + w / 2}" y="${H - 12}" text-anchor="middle">${mShort(m.key)}</text>
        ${m.units > 0 && bw > 26 ? `<text class="bv" x="${x + w / 2}" y="${y(m.units + m.missedUnits) - 4}" text-anchor="middle">${inr.format(m.units)}</text>` : ''}</g>`;
    }).join('');
    const pts = ms.map((m, i) => `${L + i * bw + bw / 2},${sy(m.season)}`).join(' ');
    const line = `<polyline class="sline" points="${pts}"/>${ms.map((m, i) => `<circle class="sdot" cx="${L + i * bw + bw / 2}" cy="${sy(m.season)}" r="2.5"><title>${esc(`${mName(m.key)}: ×${n1(m.season)} ${m.own ? '(its own sales)' : '(the store’s)'}`)}</title></circle>`).join('')}`;
    const ax = `<text x="${W - R + 5}" y="${sy(2) + 4}">×2</text><text x="${W - R + 5}" y="${sy(1) + 4}">×1</text><text x="${W - R + 5}" y="${sy(0.5) + 4}">×½</text>`;
    return `<svg class="pchart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Units sold and missed each month">${grid.join('')}${bars}${line}${ax}</svg>`;
  }
  function priceChart(prof, W) {
    const pr = prof.price, held = new Set(prof.months.filter((m) => m.days).map((m) => m.key)), ms = pr.byMonth.filter((m) => held.has(m.key)), H = 130, L = 52, R = 10, T = 10, B = 22, n = ms.length;
    const vals = ms.map((m) => m.paidIn).filter((v) => v != null).concat(pr.mrp ? [pr.mrp] : [], pr.list ? [pr.list] : []);
    if (!vals.length) return '';
    const hi = Math.max(...vals) * 1.05, lo = Math.min(...vals) * 0.9, maxU = Math.max(1, ...ms.map((m) => m.units));
    const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo || 1)), bw = (W - L - R) / n;
    const bars = ms.map((m, i) => { const tip = [mName(m.key), m.paidIn != null ? `Paid ₹${inr.format(m.paidIn)} with GST, ₹${inr.format(m.paidEx)} without` : 'No sales', m.paidIn != null && pr.mrp ? `${n1((1 - m.paidIn / pr.mrp) * 100)}% off MRP (₹${inr.format(pr.mrp)})` : '', `${inr.format(m.units)} sold`].filter(Boolean).join('\n');
      return `<g class="tipg" tabindex="0" role="img" aria-label="${esc(tip.replace(/\n/g, '. '))}" data-tip="${esc(tip)}"><rect class="hit" x="${L + i * bw}" y="${T}" width="${bw}" height="${H - T}"/><rect class="ub" x="${L + i * bw + bw * 0.2}" y="${H - B - ((H - T - B) * 0.5 * m.units) / maxU}" width="${bw * 0.6}" height="${((H - T - B) * 0.5 * m.units) / maxU}"/><text x="${L + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${mShort(m.key)}</text></g>`; }).join('');
    const pts = ms.map((m, i) => (m.paidIn == null ? null : `${L + i * bw + bw / 2},${y(m.paidIn)}`)).filter(Boolean).join(' ');
    const ref = (v, cls, lab) => (v ? `<line class="${cls}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 4}" y="${y(v) + 4}" text-anchor="end">${lab}</text>` : '');
    return `<svg class="pchart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Price paid each month">${bars}${ref(pr.mrp, 'mrp', 'MRP')}${ref(pr.list, 'lst', 'List')}<polyline class="pline" points="${pts}"/>${ms.map((m, i) => (m.paidIn == null ? '' : `<circle class="pdot" cx="${L + i * bw + bw / 2}" cy="${y(m.paidIn)}" r="2.5"><title>₹${inr.format(m.paidIn)}</title></circle>`)).join('')}</svg>`;
  }
  function stockChart(prof, W) {
    const st = prof.stock, H = 160, L = 34, R = 8, T = 18, B = 22, n = st.length;
    if (!n) return '';
    const max = Math.max(1, ...st.map(([, v]) => v)), step = niceStep(max / 3), topV = Math.ceil(max / step) * step;
    const x = (i) => L + ((W - L - R) * i) / Math.max(1, n - 1), y = (v) => T + (H - T - B) * (1 - Math.max(0, v) / topV);
    const idx = new Map(st.map(([k], i) => [k, i]));
    const shade = (prof.calendar || []).map(([k, f], i) => (f < 1 ? `<rect class="oshade${f > 0 ? ' half' : ''}" x="${x(i) - (W - L - R) / n / 2}" y="${T}" width="${(W - L - R) / n + 0.5}" height="${H - T - B}"/>` : '')).join('');
    const grid = []; for (let v = 0; v <= topV + 1e-9; v += step) grid.push(`<line class="gl" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 5}" y="${y(v) + 4}" text-anchor="end">${inr.format(v)}</text>`);
    const pts = st.map(([, v], i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const big = new Set(prof.restocks.slice().sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k));
    const cw = (W - L - R) / n, cal = prof.calendar || [];
    const hits = st.map(([k, v, u, mvv], i) => { const f = cal[i] ? cal[i][1] : 1; const tip = [dayY(k), `${inr.format(Math.max(0, v))} in stock at the day’s end${v < 0 ? ` (${v}: oversold)` : ''}`, `${inr.format(u || 0)} sold that day`, mvv > 0 ? `Restocked: stock up ${inr.format(mvv)} that day` : '', f >= 1 ? 'Could be bought all day' : f > 0 ? 'Ran out or came back that day' : 'Out of stock all day'].filter(Boolean).join('\n');
      return `<rect class="hit tipg" x="${x(i) - cw / 2}" y="${T}" width="${cw + 0.3}" height="${H - T - B}" data-tip="${esc(tip)}"/>`; }).join('');
    const rs2 = prof.restocks.map(([k, q]) => (idx.has(k) ? `<g><path class="rmark" d="M${x(idx.get(k))},${T - 2} l-4,-7 h8 z"/>${big.has(k) && W > 420 ? `<text class="rlab" x="${Math.min(W - R - 14, Math.max(L + 10, x(idx.get(k))))}" y="${T - 10}" text-anchor="middle">+${inr.format(q)}</text>` : ''}</g>` : '')).join('');
    const ticks = st.map(([k], i) => (k.slice(8) === '01' ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${mShort(k.slice(0, 7))}</text>` : '')).join('');
    return `<svg class="pchart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Stock at each day's end">${shade}${grid.join('')}<polyline class="stl" points="${pts}"/>${rs2}${ticks}${hits}</svg>`;
  }
  const DRAW = { months: monthsChart, price: priceChart, stock: stockChart };
  function draw(el, prof) {
    const kind = el.dataset.chart, box = el.parentElement;
    const W = Math.max(kind === 'price' ? 300 : 560, Math.floor((box.clientWidth || el.clientWidth || 600)));   // phones: the chart scrolls inside its card
    try { el.innerHTML = DRAW[kind](prof, W); el.classList.add('drawn'); } catch (e) { el.innerHTML = `<p class="muted small">Chart not drawn: ${esc(e.message)}</p>`; }
  }
  function charts(root, prof) {
    if (!prof || !prof.ok) return;
    const els = [...root.querySelectorAll('.lazy-chart:not(.drawn)')];
    if (!('IntersectionObserver' in window)) { els.forEach((el) => draw(el, prof)); return; }
    const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { io.unobserve(e.target); draw(e.target, prof); } }, { root: root.closest('.drawer-card') || null, rootMargin: '200px' });
    els.forEach((el) => io.observe(el));
  }

  window.SW_PROFILE = { top, body, charts, skeleton, showTip, hideTip, monthsChart, priceChart, stockChart, story };
})();
