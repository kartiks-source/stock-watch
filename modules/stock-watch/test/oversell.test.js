'use strict';
/* 1.3.0 (LOGIC.md §2): an oversell to −1 is not "stock existed"; a restock seen by a pull, then a sale before that pull,
   ends the spell instead of wiping it. */
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine');

const H = E.HOUR, DAY = E.DAY, now = Date.UTC(2026, 10, 24, 6);

test('an order that oversold to −1 does not erase a month-long stock-out (Nivaya: ₹98 slow seller → real loss)', () => {
  /* sold 1 a day until 30 days ago, out since; one order raced to −1 yesterday, logged by the next pull 35 min later */
  const stock = [{ t: now - 59 * DAY, variantId: 'n', before: null, now: 30, price: 9000, src: 'rebuilt' },
    { t: now - 30 * DAY, variantId: 'n', before: 1, now: 0, price: 9000, src: 'rebuilt' },
    { t: now - 1 * DAY + 35 * 60e3, variantId: 'n', before: 0, now: -1, price: 9000, src: 'shopify' }];
  const orders = [];
  for (let i = 31; i <= 58; i++) orders.push({ t: now - i * DAY, order: `#${i}`, variantId: 'n', qty: 1, price: 9000 });
  orders.push({ t: now - 1 * DAY, order: '#race', variantId: 'n', qty: 1, price: 9000 });
  const r = E.report(stock, orders, {}, { days: 30, now });
  const s = r.stockouts.find((x) => x.id === 'n');
  assert.equal(s.start, now - 30 * DAY, 'the stock-out starts when the shelf emptied, not at the oversold order');
  assert.ok(!s.soldInside);
  const p = r.products.find((x) => x.id === 'n');
  assert.equal(p.status, 'Out now');
  assert.ok(p.lost > 200000, `about 30 days × 1/day × ₹9,000, got ${p.lost}`);
});

test('oversold(): a drop below 0 in the line\'s hour or at the next pull; a sale with no logged drop is not one', () => {
  const t = now - 10 * DAY;
  const rebuilt = [{ t: t - 20 * DAY, before: 1, now: 0 }, { t: t - 30 * 60e3, before: 0, now: -1 }];   // hour-start stamp, order 30 min later
  assert.equal(E.oversold({ t }, rebuilt, 2 * H), true);
  const pulled = [{ t: t - 20 * DAY, before: 1, now: 0 }, { t: t + 90 * 60e3, before: 0, now: -1 }];   // pull 1.5 h after the order
  assert.equal(E.oversold({ t }, pulled, 2 * H), true);
  assert.equal(E.oversold({ t }, pulled, 1 * H), false, 'outside the pull interval');
  const restock = [{ t: t - 20 * DAY, before: 1, now: 0 }, { t: t - 10 * 60e3, before: 0, now: 3 }];   // stock went up: not an oversell
  assert.equal(E.oversold({ t }, restock, 2 * H), false);
  assert.equal(E.oversold({ t }, [{ t: t - 20 * DAY, before: 1, now: 0 }], 2 * H), false, 'no drop logged (missed refill): the sale still moves the start');
});

test('a missed refill still moves the start (no drop below 0 logged)', () => {
  const stock = [{ t: now - 59 * DAY, variantId: 'a', before: null, now: 5, price: 6000 }, { t: now - 40 * DAY, variantId: 'a', before: 1, now: 0, price: 6000 }];
  const orders = [{ t: now - 10 * DAY, order: '#1', variantId: 'a', qty: 2, price: 6000 }];
  const s = E.report(stock, orders, {}, { days: 30, now }).stockouts.find((x) => x.id === 'a');
  assert.equal(s.start, now - 10 * DAY);
});

test('pull race: restock, then a sale before the pull that sees it, ends the spell at the sale (₹11,823 stays, not ₹11)', () => {
  /* 3 a day at ₹1,000, out 5 days, restock seen by the pull at +5 d 2 h; a sale 20 min before that pull */
  const out = now - 10 * DAY, pull = out + 5 * DAY + 2 * H;
  const stock = [{ t: now - 40 * DAY, variantId: 'f', before: null, now: 200, price: 1000, src: 'shopify' },
    { t: out, variantId: 'f', before: 1, now: 0, price: 1000, src: 'shopify' },
    { t: pull, variantId: 'f', before: 0, now: 30, price: 1000, src: 'shopify' }];
  const orders = [];
  for (let i = 11; i < 39; i++) for (let k = 0; k < 3; k++) orders.push({ t: now - i * DAY + k * H, order: `#${i}-${k}`, variantId: 'f', qty: 1, price: 1000 });
  const base = E.report(stock, orders, {}, { days: 30, now }).stockouts.find((x) => x.id === 'f');
  orders.push({ t: pull - 20 * 60e3, order: '#late', variantId: 'f', qty: 1, price: 1000 });
  const r = E.report(stock, orders, {}, { days: 30, now, syncMinutes: 120 });
  const s = r.stockouts.find((x) => x.id === 'f');
  assert.equal(s.start, out, 'start stays');
  assert.equal(s.end, pull - 20 * 60e3, 'ends at the sale (the restock landed before it)');
  assert.ok(s.lost > 0.9 * base.lost, `${s.lost} vs ${base.lost}`);
  /* a sale more than one pull interval before the end still moves the start (it proves an earlier refill) */
  const early = orders.slice(0, -1).concat({ t: pull - 3 * H, order: '#early', variantId: 'f', qty: 1, price: 1000 });
  assert.equal(E.report(stock, early, {}, { days: 30, now, syncMinutes: 120 }).stockouts.find((x) => x.id === 'f').start, pull - 3 * H);
  /* a Flow / rebuilt end (not stamped at a pull) keeps the old rule */
  const flow = stock.map((x) => ({ ...x, src: 'flow' }));
  assert.equal(E.report(flow, orders, {}, { days: 30, now }).stockouts.find((x) => x.id === 'f').start, pull - 20 * 60e3);
});
