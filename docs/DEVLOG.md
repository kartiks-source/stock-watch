# Dev log

Newest first. Date · module · what changed and why · anything open.
Shared copy for the team: https://claude.ai/artifact/27Q6x8r3rpZHYaNzhjW2Zq

## 2026-11-26 · stock-watch 4.2.0

Home page month first (branch `home-month-first`, not merged or deployed): opens on this month (last month on the 1st–3rd, GRACE), sticky ◀ ▶ / 12 months bar, month in the hash, Best sellers by default, three tiles with the same dates of the month before, the month's list with a day strip and a ₹0 fold line, Past months with days to refill, the 12 months behind one button, optional "We started on" per store. All products opens on This month with Last month and 90 days. API shaping only (src/screen.js, src/truth.js non-money fields); the money rule and every ₹ unchanged. Best sellers on a period now use each month's own quarter list, so All products and the home page agree for past quarters.

Open:
- five critics not yet run on this cycle;
- the demo (rows-held) build has no per-day ₹, so the "month before" ₹ there is the month spread evenly over its empty days;
- "Y" in "X of Y products" (All view) = products with sales or a stock-out in the 12 months, not those on sale that month.

## 2026-11-26 · stock-watch 4.0.0

A simpler money-missed rule (RULE.md, src/model.js): what a product makes a day in stock over its last 90 days × how busy the shop was that day × days empty, with products off the best-seller list × 0.74. 3.0's weighted speed, like-for-like products and speed tiers are gone.

Before choosing it, three separate critics (data, demand logic, tests) checked every assumption. Their fixes are in: 60 in-stock days needed, the run-out day counts ½ with nothing taken off, the comeback day counts 0, and the 0.74 for products off the list (from placebo tests).

Shipped straight away on the agency's call, instead of a quarter beside 3.0.

Open:
- substitution and late buying can't be seen in daily sales;
- the range isn't checked blind yet;
- some stock-outs are products the brand may have stopped, or stock removed by hand, and need the brand to confirm.

## 2026-11-25 · stock-watch 3.0.0

One tested model for every product (src/model.js, RULE.md): weighted average of the speed in stock × like products on the same days × price × days empty. Picked among 19 models by replayed stock-outs and real comebacks; rebuilt line by line by a separate engine. Open: December is the first month it hasn't seen; the apiv1 groups test compares two calls moments apart on ticking demo data.

## 2026-11-25 · stock-watch 2.0.0

One simple rule for every number (RULE.md, src/truth.js, src/screen.js, src/ledger.js): speed in stock × days empty × price; sold + missed = could have earned. Screens keep their layout. Checked against Shopify and rebuilt by a second, separate engine. Open: December is the first month the rule hasn't seen; deck rebuild.

<!-- devlog archive links (scripts/rotate-devlog.js) -->
Older entries: [2026-11](devlog/2026-11.md)

<!-- devlog archive links (scripts/rotate-devlog.js) -->
Older entries: [2026-11](devlog/2026-11.md)



## 2026-11-24 · 1.4.4 · Best sellers | All products; one best-seller list; same parts on the brand report
stock-watch 1.4.4 (branch `feature/agency-proof`, main 8ca4cbe merged; not pushed, not deployed).
- Switch on the brand report (All products by default per the user; remembered; `?view=best|all`): headline, chart, table, grid (all: top 50 by ₹ + Show all), month list, CSVs; one scope line under Restock list / All products / Best sellers now headlines.
- One best-seller definition: engine `opts.bestIds` from the 12-month build (server `bestIdsOf`) → `abc` A; the 28-day rank kept as `salesRank`. Luxe Hammered Planter: salesRank A, not a best seller; Noori, Chess Set: salesRank C, best sellers.
- Brand report parts = §4c via `rowInfo` from today's report (confidence, nrDays, ordered, allocation): counted / restock or drop? / a guess / top-up per day; months and headline in both scopes.
- Fix found on the way: `fromRows` is bounded to 400 days with null-prototype maps (a stray epoch row and an ID like `constructor` made a test hang once every report needed the build).
- Live (read-only), Nov 1–23 brand vs report 1–24 Nov: all products counted ₹4,00,590 vs ₹4,07,887; best sellers ₹1,28,987 vs ₹1,25,539; Oakwood ₹56,167 vs ₹58,084; Nivaya ₹37,330 + ₹3,555 vs ₹37,474 + ₹4,947; Luxe Hammered ₹33,661 vs ₹36,291; Noori ₹0 + ₹41,783 vs ₹0 + ₹43,348; Chess Set ₹0 + ₹39,353 vs ₹0 + ₹40,829 (the report includes 24 Nov so far).

## 2026-11-24 · 1.4.3 · one pace for money missed; drawer instant, tooltips; cached answers
stock-watch 1.4.3 (branch `feature/agency-proof`, main 1.4.2 merged; not pushed, not deployed).
- Live inconsistency: brand report Oakwood Nov ≈ ₹56k vs report 30 d ₹76,788 (28-day rate from 8 pre-Diwali shelf days, basis window; lossPace only on history/before-out). Engine now values every hour out at §21's pace of its month × the 12-month price (`opts.lossPace` per month, `opts.lossPrice`) on every page/period, digest, snapshots (retaken), v1, CSVs. Reorder/Sells/days left stay 28-day. Test: brand month = report lost for the same dates (±₹2).
- Live before → after (same data): Oakwood 7 d ₹25,527 → ₹19,064, 30 d ₹76,847 → ₹57,391 (brand Nov ₹56,167); Nivaya 30 d ₹56,392 → ₹51,891, Nov 1–24 ₹44,969 → ₹41,988 (brand ₹40,885); Seville 30 d ₹36,941 → ₹31,886; Surrey 30 d ₹6,527 → ₹6,054; store headline 7 d ₹1,21,453 → ₹1,13,428, 30 d ₹5,08,354 → ₹4,87,491; all parts 30 d ₹8.06 L → ₹14.17 L (not restocked: long-out items at in-stock pace instead of the 26-week floor).
- Drawer: opens at once from the row with placeholders; prefetch on hover/focus; client cache keyed by `rev`; "to the hour" fold open by default, closing remembered; tooltips on every chart (hover, tap, focus) inside the drawer.
- Speed (local copy of live data): /api/product 0.19–0.40 s → 2–3 ms warm (0.24 s cold after a change); report 545 KB → 58.5 KB gzipped; brand 354 KB → 58 KB, 0.2 s → 5 ms warm. `src/cache.js`; build warmed after each pull.
- Open: Railway CPU is ~4× slower than this machine: measure there after deploy; the report payload could shrink further (links derivable on the page).

## 2026-11-24 · 1.4.1 · product drawer = 12-month profile
stock-watch 1.4.1 (branch `feature/agency-proof`, after merging main ec2fa1a; not pushed, not deployed). User (screenshot): the drawer still showed 30-day Trend 0,0,0 and a flat pink Stock level block.
- Drawer rebuilt (`public/profile.js`): header with rank and status now; story line; key numbers; 12-month sold + "would have sold" ghost bars + days-out strip + season line; price and discount (MRP = compare-at, GST from ShopifyQL `taxes`); day calendar; 12-month stock level with restocks; busy/quiet months + same month last year; month sentences; details. 30-day hour detail under one fold. Charts lazy (IntersectionObserver), inline SVG, scroll inside their card on phones.
- Data: `agency.profile` (pure) from a build with `detail`; year sales v2 = [units, net, GST, gross] (re-read once); catalog `compareAt`. ~150 ms per drawer on the live catalog.
- Live check (read-only): Oakwood, Nivaya, Scarlett Gold Table, Kimaya: 12/12 months units and ₹ = ShopifyQL; MRP, list, paid with GST, GST %, discount off MRP = Shopify.
- Open: restock markers crowd on products restocked often (labels only on the 8 biggest); collections list can include internal ones ("Test").

## 2026-11-24 · 1.4.0 fixes after the first live deploy (e526426) and the critic round
- Live (coordinator): the first pull read 8 ShopifyQL windows (26 Sep → today), best sellers were ranked on those 2 months, so Oakwood and Nivaya were not best sellers and Nov showed ₹18,539 counted. Fixes: the first load reads everything (≤ 80 reads, 39 on Sammsara in 47 s); while loading, best sellers rank on Shopify's 26 weeks and the page says "History from …; the full 12 months after the next pull".
- Season per calendar month, smoothed 1-2-1 with the months either side, 400 days held (last year's same month): Oakwood Nov ₹31k → ₹56k (1.3.0 engine ₹68.5k), Nivaya ₹40.9k (engine ₹51.6k), Seville ₹24.7k (engine ₹18.9k); pinned by a fixture test with the Shopify evidence (LOGIC §21).
- Critic round (logic + UI, read-only agents; reports summarised here): fixed launch days (publishedAt), shop season from in-stock product-days, unsure variants kept in the rank, top-ups apart per variant, fresh anchor (pull first, 15 min), new days always read in full, retry after 30 min, capped day not retried, drawer tile period, headline/list counts consistent, heat grid months held, Ads wording + ₹ a day, phone 44 px, Enter on product buttons. Not done (noted): links nested inside clickable rows (a11y), one money format on the older pages, a day's checkout race corrected the same day counts as in stock (day granularity), net units on return days.
- Sammsara 12 months: ₹16.6 L missed on best sellers (2.33% of ₹7.11 Cr), 896 days, 36 of 43; + ₹2.8 L top-ups apart.

## 2026-11-24 · 1.4.0 · agency proof (branch `feature/agency-proof`)
stock-watch 1.4.0 (not pushed, not deployed). Owner: prove to brands which best sellers were out, when, how long, what it cost, month by month; protect the agency from fee deductions; push restocks; sell what's in stock; pace from 6–12 months.
- **Restructure (owner: "we can rehaul the thing"):** rail = Brand report (home) · Best sellers now · Ads: push / pause · Restock list (= Reorder) · All products · Data. Overview and Stock-outs kept, reachable by `#overview` / `#stockouts`, not in the rail. Engine and APIs unchanged underneath.
- `src/year.js`: ShopifyQL `sales` + `inventory_adjustment_history` ('available') by day × variant, 365 days, explicit dates (both ends in), reads sized from rows/day under the 1,000 cap, capped read halved, 8 reads per pull, then new days daily; `year.json` per store. ShopifyQL throttles per minute: `gql` now waits for `windowResetAt`. Sammsara first load: 37 reads in 17 s.
- `src/agency.js`: days in / out / half from the walked-back stock; oversold units out; walks > 2 below min(now, 0) dropped (0 of 253 on Sammsara; with 0 tolerance 14 dropped incl. Kyoto, all at −1/−2 from oversell races); pace 6 months of in-stock days; season blended with the shop's, capped 0.5–2; money missed per month; best sellers top 80%; website allocations apart. `src/sell.js`: best sellers now, push / pause.
- Engine: long stock-outs (rate basis history / before-out) value ₹ lost at the seasonal pace (`opts.lossPace`), reorder keeps the 28-day rate. 30 d headline ₹4,94,679 → ₹3,93,865.
- Pictures + links: catalog reads handle, onlineStoreUrl, publishedAt, featured image (320 px CDN), shop primary domain; `src/links.js`, `public/prod.js`; CSP img-src https://cdn.shopify.com.
- Live check (Sammsara, local server on the worktree, read-only): 12-month sales = ShopifyQL exactly (27,069 units, ₹7,26,86,792.99; every month; Oakwood/Nivaya/Seville/Surrey per product); stock-out dates match the stock log (Oakwood 4 Nov, Nivaya 4–11 Oct + 23 Oct, Seville 11 Oct, Surrey 3 Nov). 12 months: ₹20.1 L missed on best sellers (2.83% of ₹7.11 Cr), 929 days, 35 of 41 ran out; ₹2.9 L on 4 website top-up items apart; August worst (₹5.9 L, 26 best sellers, 270 days).
- Open: critic round for 1.4.0 not run; the shared dev log page not updated (needs the owner's session); Overview/Stock-outs to fold in or remove; a variant archived during the year drops out of earlier months.

## 2026-11-24 · 1.2.1 · stale banner, digest cost wording, This month hovers
stock-watch 1.2.1, on `main` (not pushed, not deployed). Banner uses server `freshness.stale` / `staleAfterMin` (255 min at 2-hour pull), not a hard 45; Ops/Buyer digest "at selling price" without costs; group hovers use the period label. Docs: 15-min pull / 45-min stale → 2 h (`SYNC_MINUTES`) / 255 min; LOGIC §6a describes Plan settings + Advanced planning rules (no Assumptions bar). Tests: digest unit, ui-review banner + hovers.

## 2026-11-24 · 1.2.0 · ₹ lost says how sure it is (SW-066)
stock-watch 1.2.0, on `main` (not pushed, not deployed). Client's category person: products they know don't sell show sales lost. Sammsara 30 d: ₹5.89 L lost, 43 products with ≤ 3 units sold carried ₹3.61 L (61%).
- Engine: `rateUnits` = units behind the rate (same lines as `demandRate`), `confidence` high 10+ / medium 5–9 / low ≤ 4. Open stock-out past day 30 with no PO (`onOrderNow` null) → ₹ after day 30 = `lostNotRestocked`. Row `lost` unchanged; `lostCounted` + `lostEstimate` + `lostNotRestocked` = `lost`. `totals.lost` = Σ counted (headline, `lostPct` on it), `lostAll` = old total. Daily `lost` = counted. CALC_VERSION 1.2.0 (snapshots recomputed).
- Same headline: Overview, Stock-outs, Products totals line, chart, Yesterday, Copy summary, digest (+ parts), weekly snapshots, groups/targets, `/api/v1/summary` (+ `lostEstimate`, `lostNotRestocked`, `lostAll`), PO CSV (+ Confidence, Not restocked). UI: one small line under the headline, links to the rows; markers *estimate* / *not restocked*; optional Confidence column; Stock-outs chips, Products More… (chip row stays one line at 1440); Why "Out 30+ days, not restocked: restock or drop?".
- Alternatives on live data (engine on `/api/export/backup.json`, read-only; LOGIC §4 table): 30 d A all ₹5,88,692 (63 products) · B chosen ₹3,71,843 (22) + ₹1,64,833 estimate (40) + ₹52,016 not restocked (18) · C drop ≤ 3 units sold ₹2,28,092 (20) · D Poisson 80% lower bound ₹4,68,555 (63) · E cap 30 d ₹5,36,676 (62). 7 d: A ₹1,39,788 · B ₹77,334 · C ₹2,667 · D ₹1,06,275 · E ₹1,15,376.
- Sheet version has no split: parity compares its total to `lostAll` (LOGIC §12).
- Owner asked for two more (high-ticket concern): F price bands 30 d ₹4,31,522 (27 products; moves 5: Seville, Dahlia, Kyoto, Celeste, Aspen) · G weeks with a sale ₹5,10,356 (52; moves 30 of 40 estimates). 7 d: F ₹91,972 · G ₹1,11,787. No ₹10k+ product has ₹ lost. App stays on B (LOGIC §4).
- Open: Products filters are in More… (not chips) to keep one chip row; BACKLOG id SW-065 was taken (Shopify match), this is SW-066.

## 2026-11-20 · one name everywhere
repo. GitHub repo renamed KM-TestApp → `stock-watch` (old URL redirects); local folder → `~/Downloads/stock-watch`; old repo `stockout-watch` deleted (user's yes). Merged worktrees removed. Railway service `web` → `stock-watch` pending (dashboard only; then `.railway/railway.ts` + deploy commands). App URL unchanged: Performity allows our key only from that Origin.
## 2026-11-20 · 1.1.5 · cancel/refund % and periods match Shopify exactly
stock-watch 1.1.5, on `main` (not pushed, not deployed). User: cancel/refund % must equal Shopify's.
- Periods: N store-calendar days, today included (`period.range` → `tz.daysStart`, DST-safe), for every number (report, product, groups, CSV, v1, digest). Dates beside the Period buttons ("22 Oct – 20 Nov"; hidden 761–1010 px, two lines on small phones).
- Reversal events `{id, t, order, variantId, qty, value, kind}` from refund lines (refund date) and cancelled lines not covered by a refund (cancel date); a refund after the cancel adds nothing (#92029: cancelled 29 Aug, refunded 17 Nov; Shopify counts 29 Aug only). Stored `store.json` `reversals`, replaced per order, one per id. Backfill query `created_at OR updated_at` ≥ 60 d (375 older orders: events only, no lines; token has `read_all_orders`). `ORDER_FIELDS` 'reversals' → one re-read.
- Cancel/refund % = reversed units dated in the period ÷ units ordered in the period (cancelled included). Data → "Check against Shopify" = gross − discounts by order date − reversals by reversal date. Sold stays by order date (LOGIC §What counts as a sale: chart / rate reasons).
- Live check (real `pullOrders` + `engine.report`, read-only, explicit dates; ShopifyQL `UNTIL <date>` includes the date): 7/30/60 d ordered 409/2,186/4,461 vs 409/2,186/4,459, reversed 33/102/259 = Shopify, ₹ reversed = Shopify to the rupee, net sales ₹12,20,945 / ₹67,07,306 / ₹1,32,27,574 = Shopify to ₹1. Per variant: 7 d 73/73, 30 d 137/137 identical (Cascade 5.4%, Casablanca 11.4%, Evelyn 10.8%), 60 d 175/176: Meridian Globe ordered 8 vs 6 = order #92916 edited 22 → 23 Sep to add 2 units (Shopify: ₹ on the edit day, `quantity_ordered` 0).
- Open: order-edit-added units (BACKLOG SW-065); 800 px header already overflowed by 105 px before this change.

## 2026-11-20 · 1.1.4 · reversal labels
stock-watch. External check of 30-day rates: 9/12 match Shopify's reversed-quantity rate; 3 differ by dating (order date vs reversal date). Renamed Returns % → Cancel/refund % (not physical returns only), "Losses for" → "Period". LOGIC §9e notes the check.
## 2026-11-20 · returns from refunds, sales checked vs Shopify (1.1.3)
stock-watch 1.1.3, on `main` (not pushed, not deployed). Fixes the SW-064 live check (app 5 units returned vs Shopify 259, 60 d).
- Cause (found live, read-only): Shopify's *Returns* = cancelled orders (refund lines, restock CANCEL / RETURN), which we left out; Sammsara had no post-delivery refunds in 60 d. Also a refund need not lower `currentQuantity`.
- Pull: orders query reads `refunds(first: 10) { refundLineItems(first: 50) { quantity restockType lineItem subtotalSet totalTaxSet } }` (cost 247 asked / 44 used; >10 refunds and >50 lines paged one call at a time; read-only guard). Lines get `returned`, `refund` (₹ ex GST), `cancelled`; qty = min(currentQuantity, ordered − refunded); cancelled orders' lines stored with qty 0. `ORDER_FIELDS` 'refunds' → one 60-day re-read.
- Engine: Returns % = returned ÷ ordered incl. cancelled orders, by order date; `unitsCancelled`; product rows for variants only on cancelled orders. Demand (`demandQty`) = kept + returned after the sale, never cancelled; ₹ sold unchanged. CALC_VERSION 1.1.3. Demo sammsara-9.
- Live check (real `pullOrders` vs ShopifyQL, IST days): returned 7/30/60 d app 30/94/185 vs Shopify 33/102/259; ₹ 1.20 L/3.78 L/7.61 L vs 1.40 L/4.03 L/10.13 L. Same orders restricted: ₹7,61,206 vs ₹7,61,208, top products exact; the gap = returns on orders placed before the window (52 orders bulk-cancelled 30 Sep). Sold vs Net sales: ₹12.40 L/67.33 L/1.348 Cr vs 12.21 L/67.07 L/1.323 Cr (+1.60/+0.38/+1.91%), gap = the same returns ₹ to ₹10. Kept by order date (LOGIC §What counts as a sale).
- Open: Shopify return target (within 5% for 60 d by Shopify's own date) can't be met by order date on this window; documented.

## 2026-11-20 · roles off, brand switch only (1.1.2)
stock-watch 1.1.2, on `main` (not pushed, not deployed). User: "remove roles, just keep it brand switch".
- Store pill only switches brands (one brand: plain name, doesn't open); phone store bar the same. No role menu, no *Show me* on Data. Everyone sees everything.
- `public/roles.js`: role always ''; a remembered `sw-role` is cleared, `?role=` links ignored and stripped. Pure functions kept (`test/roles.test.js`) in case roles come back. LOGIC §16 marked off.
- Tests: role-only browser tests deleted (Marketing phone home, phone store bar with a role); mixed ones keep their non-role checks; new: `?role=ceo` + stale `sw-role` → everything shown, both dropped. `test/smoke/roles-smoke.js` deleted (root `test:smoke`, CI step).
- Open: digest links still carry `?role=` (now just open the default view); digest content per role unchanged.
- Tests: npm test 391 pass (36 browser skips); test:ui 36/36; smoke 30/30 (roles smoke gone).

## 2026-11-20 · return % per product
stock-watch, branch `feature/returns` (not pushed, not deployed). SW-064, LOGIC §9e.
- Pull: order lines keep `ordered` (Shopify line `quantity`) beside `qty` (`currentQuantity`); fully refunded lines kept with qty 0 (engine leaves them out of sales; history check skips them). `shopify.orderFields` → one 60-day re-read, like the GST one.
- Engine: per product `unitsOrdered`, `unitsReturned`, `returnPct` (null under 5 ordered), `refundValue` (₹ ex GST), by order date; `totals` same + `highReturns`. Demand, ₹ sold, ₹ lost unchanged.
- Page: Products column Returns % (optional, amber 15%+, before Units sold so it shows at 1440), chip High returns (only when one qualifies), drawer line "Returned: x% (a of b) · ₹ refunded", phone cards "x% returned" at 15%+. Overview unchanged.
- Demo: returns on its own random stream (sales unchanged), three busy products 25–80% of lines; VERSION sammsara-8.
- Open: `test/ui-helpers.test.js` expects 6 Products chips, now 7 (not touched: another branch edits it); check against ShopifyQL `FROM sales SHOW quantity_ordered, quantity_returned` on the live store. Shared dev log page not updated from here.

## 2026-11-20 · UI + mobile fixes (1.1.1)
stock-watch 1.1.1, on `main` (not pushed, not deployed). Fixes from the UI, simplicity and mobile critics, checked on a copy of the live Sammsara data at 1440 and 360.
- Counts (P1, UI-2/M2/SIMP-3): `totals.stockouts` leaves out not-selling episodes (`stockoutsNotSelling`, episode `notSelling`); tile/summary 94 → 54 = Stock-outs page "53 products ran out 54 times" (local copy); weekly `ranOut` too. Badge = stillOut 47 = page.
- M1 (P0): sale inside a stock-out moves its start (`engine.afterLastSale`, LOGIC §2). Aspen ₹51,828 "Out 49 d" → ₹8,089 "Out 21 d". Total lost ₹5.19 L → ₹4.66 L. "Out since before <date>" when out at the first record (SIMP-6).
- UI-1/M3 (P1): row `historyFrom`; drawer hatches days before it + "Unknown" sales lost; Data lists the 31 (₹53.18 L sold); Stock-outs "for 222 of 253 products".
- SIMP-2: Order today by ₹/day (Cascade, Sable, Casablanca rows 1-3, were 13-15); Overview panel top 5 by order ₹. SIMP-5: slow sellers out of Biggest losses, "+₹2.26 L on 41 slow sellers: decide". SIMP-4/UI-3: weekly panel flows only.
- UI-4/SIMP-1 (rest after L3): no-cost headline by count, Reorder "Order value" + banner, budget "Sales kept / ₹" / "keeps ₹X sales", no "est.", PO "Unit price", digest "Overstock at selling price", tips without "cash". M4: `row.gift` (avg paid < 10% list price, no cost) never ranked.
- Mobile P2: M5 budget 44 px, M6 file picker 44 px, M7 opaque strip behind × once scrolled, M8 ≥ 11-12 px, M9 trend in words / "Trend" label, M10 2-line names, M11 Suppliers 253 not 644.
- Skipped: SIMP-1 "lead with pcs" kept ₹ beside the count (small grey); SIMP-6 "mark selling on backorder" (the start-move covers it). Overview at 1440×900 still scrolls to the weekly panel (now 2 tiles + movers).
- Tests: npm test 391 pass; test:ui 37/37; smoke 30/30 + roles. Shared dev log page not updated from here.

## 2026-11-20 · number validation fixes
stock-watch 1.1.1, on `main` (not pushed, not deployed). Fixes from the number-validation critics (sales-pull, stock-history, logic, secqa).
- History (P0, F1/L1/SEC-QA-1): ShopifyQL `UNTIL -Nd` is exclusive, so 1.1.0's 7-day windows never read 8 of 61 days. Now absolute store-time dates, both ends included (probed: `SINCE 2026-11-14 UNTIL 2026-11-14` returns the day); `windows()` / `split()` tile days..0 once (F3). Test fake now answers like Shopify (exclusive relative UNTIL, store-time hour buckets) (F4). First read's hour from order lines (F5). Floor min(L0, 0). Order check (stock-history F2): lines inside rebuilt outs with no logged drop → variant dropped; > 1% → rebuild refused. `history.VERSION` 2: 1.1.0 rebuilds redo on next pull (no click needed). Replay on the live file + full log: kept 222 → 250 of 253, check 0 of 4,088 lines (1.1.0 rows: 6 lines, 5 variants); Cascade kept, out 4×, ₹10,747 (30 d).
- Sales (P1, F2): order price ex GST when `taxesIncluded` (paid − Σ taxLines ÷ quantity). Checked live read-only: 19 Nov app ₹1,60,252 = Shopify net ₹1,60,252.03 (old ₹1,70,740 = total sales). `shopify.priceBasis` → one 60-day re-read.
- Weekly (P0, L2): `snapshots.json` `calc` (engine `CALC_VERSION` | history.at | priceBasis); change → last 14 days retaken.
- Engine/page (P1): L6 `totals.stillOut` excludes out-but-not-selling (+ `outNotSelling`); L5 low data (< 5 units and < 14 in-stock days → calendar pace, never A); L4 `paceQty` at last-14-day pace when trend ≤ −20% (drawer line; order qty unchanged); L3 "at selling price" when no unit costs + nudge line.
- Skipped: L4's alternative (size qty on min(28d, 14d)): a rule change on a noisy 14 days, left as the person's call; shown beside instead. L5's "leave low-data rows out of headline lost": kept in at the (lower) calendar pace, so real stock-outs of slow, pricey items still count.
- Open: deploy, then the first pull re-reads 60 days of orders and rebuilds history by itself; check Data line (expect ~250/253, check 0) and Cascade's chart. Shared dev log page not updated from here. No critic round on these fixes yet; browser tests not run (no Playwright here).

## 2026-11-20 · stock history rebuild
stock-watch, branch `feature/stock-history` (not merged, not deployed).
- SW-063: past stock rebuilt from Shopify's change log (`src/history.js`, LOGIC §1c): ShopifyQL `inventory_adjustment_history`, 'available' only (committed double-counts), by hour, a week per query, split in half at the 1,000-row cap, a capped day read by day. Walked back from the first live read, 60 days; rows `src: 'rebuilt'` before the first read only; a variant going below 0 is dropped and counted. Runs once per store after the first good pull (`shopify.historyRebuiltAt`) and from Data → Rebuild stock history (`POST /api/shopify/history`, admin, queued behind pulls). No `read_reports` or a ShopifyQL error → note on Data, the pull never fails. `gql()` takes an API version (ShopifyQL on 2025-10).
- Data: one line "Stock history rebuilt … for N of M products (dates)". Stock-outs: "Before <date>: rebuilt" note; products out with no sales and no sales lost go to an "Out but not selling" chip and are not in the headline or the menu badge.
- Why: a store connected today showed ~₹16 lost; checked by hand on Sammsara: 245/257 variants rebuild, 94 products out ≥ 1 day in 30, ~₹2.05 L lost.
- Open: not run live through the app yet (first pull with the Performity token will do it); CHANGELOG / version not bumped (another branch is merging into main). Speed mode: no critic round, browser tests not run (no Playwright here).

## 2026-11-20 · Sprint 3 · D-ops
stock-watch, branch `sprint3/D-ops` (not merged, not deployed).
- SW-049: one IANA time zone per store (`public/tz.js`, `src/tz.js`): rows, engine, period, Mark ordered, helpers, digest, backups, demo and the page; daylight saving followed (23/25-hour days count once); Settings has a zone picker; old `tzOffsetMin` stores still read. LOGIC §0a. Open: the Google Sheet version still uses the sheet's zone.
- SW-053: `FROM node:22.23.5-alpine@sha256:1314fb30…` (Docker Hub, 12 Nov 2026); app runs as `node`: `scripts/entrypoint.sh` chowns `/data` once when started as root, then `su-exec node`. Shell test with stubs. Not built here (no docker): verify on first deploy (RUNBOOK, Container user).
- SW-054: one-line JSON logs (`src/log.js`), request line per API call (path only), boot line (which variables are set), tokens scrubbed in every line.
- SW-055: `DATA_DIR/instance.lock` (heartbeat 30 s, taken over after 2 min; a second copy reads, writes get 503 with the reason); `KEEP_DAYS` for backups (default 14); capacity warnings on `/status` and Data (25 MB, 150k rows, disk 80%). ADR-0012 updated.
- SW-057: Plan settings and Advanced planning rules keep the typed text; read on Enter / leaving the box; hint when invalid.
- SW-058: AGENTS.md routing table, LOGIC index, DEVLOG rotation (`npm run devlog:rotate`, archive in `docs/devlog/`), `npm run test:agent`, `.ignore`, `docs/reviews/`.
- Speed mode: no critic round this cycle.

## 2026-11-20 · Sprint 3 · C-access
stock-watch, branch `sprint3/C-access` (not merged, not deployed).
- SW-051: `src/gql-guard.js` GraphQL tokeniser replaces the regex guard (comments, strings, block strings skipped; every operation `query` or shorthand). `src/token-scopes.js` reads `accessScopes` once per pull: own apps (vault / variables) with `write_*` refused; Performity token noted on Data ("Token also allows writes; this app only reads"), logged once.
- SW-052: `src/sheet-fetch.js` Sheet sync: manual redirects (≤ 3) only to https docs.google.com / *.googleusercontent.com, 20 MB cap, 20 s timeout; the link never in errors.
- SW-062: per-store people (ADR-0016). Owner makes people in Data → People (`public/people.js`): name, Admin / Viewer, stores; generated 29-char password shown once; scrypt hashes in `DATA_DIR/access.json`. Person cookie `exp.p.<id>.<gen>.sig`; `people.pick` → 403 outside their stores, `/api/stores` filtered; reset / remove end sessions; change log names the person. Owner and VIEW_PASSWORD unchanged.
- Docs: LOGIC §18a, API (People), FORMATS (`access.json`), SECURITY, RUNBOOK, module AGENTS, BACKLOG, ADR-0016. Tests: `people.test.js` (unit + server), `ui-people.test.js` (browser, in `test:ui`), `sheet-fetch.test.js`, `gql-guard.test.js`, `token-scopes.test.js`.
- Speed mode: one look at 1440 and 390 (0 px sideways); critics not run. Open: `access.json` not in per-store backups (volume backups); no self-service reset; shared dev log page row not added.

## 2026-11-20 · Sprint 3 · E-data
stock-watch, branch `sprint3/E-data` (not merged, not deployed). SW-045, SW-050.
- SW-045 import preview: `POST /api/import/preview` (writes nothing) + `?map=` on `/api/import`; `src/csvmap.js` reads Shopify Products / Orders exports as they come (SKU as Variant ID or the store's ID for that SKU; copy-down per Handle / order; image rows ignored; untracked, draft/archived, cancelled/voided/refunded left out; line discount netted). Mapping remembered per store + header set (`mappings.json`, last 50). Page (`public/import-ui.js`): kind, mapping selects, first 5 rows as read, Upload stopped while a needed column is unmapped. Stock rows keep `vendor` (PO CSV). LOGIC §1b, API, FORMATS, SECURITY.
- SW-050 `/api/v1`: path rewrite before routing, so every route answers at both paths with the same checks; `GET /api/v1/summary` (totals only, <1.5 KB), `GET /api/v1/rows` (cursor pages, variant-ID order, ≤ 500). ADR-0017, API §v1 with examples, LOGIC §5c.
- Tests: `csvmap`, `import-api`, `apiv1` (node:test), `ui-import` (Playwright, 1440 + 390, 0 px sideways; added to `test:ui`).
- Open: order-level discount codes not spread over lines; per-tool API keys (SW-060). ADR renumbered to 0017 at merge.

## 2026-11-20 · Sprint 3 · A-money
stock-watch, branch `sprint3/A-money` (not merged, not deployed). SW-040 + SW-041, ADR-0018 (numbered 0016 on the branch).
- SW-040 suppliers: `suppliers.json` per store (side file, in backups/restore), `src/supplier-rules.js` (pure) + `src/suppliers.js` (store + routes `/api/suppliers`, `/map`, `/import`, `/api/export/suppliers.csv`; writes admin + same-site, logged). Engine: supplier lead time replaces the store's; qty up to MOQ then case pack, `packExtra` / `packExtraValue` (LOGIC §6c). Demo: invented vendors by product type + terms (demo VERSION sammsara-7). Reorder CSV `?supplier=` = one PO draft.
- SW-041 budget: `src/budget.js` profit kept per ₹ on reorder rows, one cut line (LOGIC §6d, worked example); CSV `?budget=`.
- UI (`public/money.js`, own script tag; small hooks in app.js): Reorder bar = Budget ₹ (per store, this browser) + List / By supplier + round-up ₹; cut line row, rows over budget dimmed, *Profit kept / ₹* column while a budget is on; By supplier = PO per supplier (terms, lines, pcs, ₹, Copy text, CSV); Data → Suppliers (terms, add supplier, set a SKU's supplier, CSV in/out). Mark ordered lands at today + the supplier's lead time.
- Tests: `suppliers.test.js` (rules, store, routes incl. view 403 + cross-site 403), `budget.test.js` (rule, worked example, cut, `?budget=` route), `ui-money.test.js` (1440 + 390: cut line, dimmed rows, CSV link, Clear = same rows, PO drafts, 44 px targets, Data → Suppliers, no sideways scroll).
- Checked: `npm test` green; ui-money 4/4 with Chrome. Open: `test/ui-money.test.js` to add to root `test:ui` (left out to avoid a package.json merge clash); budget not shared across the team.

## 2026-11-20 · Sprint 3 · B-review
stock-watch, branch `sprint3/B-review` (not merged, not deployed). SW-043, SW-042, SW-044.
- SW-043 weekly review: daily per-store snapshot of the headline numbers (`snapshots.json`, `src/weekly.js`), taken on the first report / pull after store-midnight, last 14 days filled in, 400 kept, demo and real never mixed; `GET /api/review`; Overview panel "This week vs last week" (7 numbers with change, top 5 movers by change in ₹ lost); one Founder / Everyone digest line. LOGIC §5b.
- SW-042 targets on groups: monthly ₹ target per group (`targets.json`, admin-only `POST /api/targets`); "Target this month" column / card line: sold so far of target, run-rate forecast (→), "₹X is stock-outs", green / amber (within 10%) / red. LOGIC §9c.
- SW-044 paste-a-list: Products search takes a pasted list of SKUs / names / variant IDs; "N of M found", not-found entries named; saved lists per store (`lists.json`, admin-only `POST /api/lists`), "Saved lists" menu beside the search. LOGIC §9d.
- Tests: weekly, targets, lists, review-api (routes: viewer 403, cross-site 403), ui-review (1440 + 390, 0 px sideways). `ui-review.test.js` is not yet in the root `test:ui` list (runs with `npm test` when PLAYWRIGHT_PATH is set).
- Not done: critics not run (speed mode).

## 2026-11-20 · final critic round 2 fixes
stock-watch 1.0.0-rc.1, on `main` (0e1b893 L1, 15e2897 X1, UI + mobile commit, this entry; not pushed, not deployed).
- L1 (P1): `planWithOrder` keeps the row's own status unless the PO covers the need (Ordered): 5/day, 10 in stock, 50 on order stayed Critical (was This week, off Order today). LOGIC §6b; onorder.test (fails on the old code).
- X1 (P1): `.railway/railway.ts` `preserve()` for every variable in `.env.example` / SECURITY.md (omit=delete would have wiped the Performity key/URL, webhooks on apply); RUNBOOK: read the plan for variable deletions. docs.test checks the list. Not run: `railway config plan` (no SDK here).
- UI-1 / SIMP-A (P1): daily chart drawn at the box's real width (`fitChart`, on render + resize), 200 px tall, unscaled 12.5 px labels: Overview ends at 864 px at 1280/1440/1920 × 900. 1280×800 (all roles): chart panel ends at 841, its title and most of the bars above the fold (SIMP-A's no-scroll at 800 would need a ~110 px chart; not done).
- UI-2 (P1): `.tr.up`/`.mv-v.up` #15803D (5.0:1), `--ok` #0B7A71 (4.65:1 on ok-soft), `#n-stockouts` #6B7385 (4.76:1).
- SIMP-B (P1): Stock-outs h1 "N still out, costing ₹X/day" on desktop too; sub-line "… sales lost · ₹ profit lost". LOGIC §still-out.
- Phones (≤760 only, desktop untouched): M1 chips snap to whole chips; the active chip's least scroll is rounded up to a chip start (end padding when it's the last), fade only on a side with more chips (`chipEdges`, first 6 px of the left fade clear); supersedes round-1 M3 "least scroll" (test updated). M2 toast above the bulk bar. M3 sticky ×. M4 `.mq small` 12.5 px, order cost 600. M5 Products cards (sorted by ₹ lost: not Pause/Push/Slow, no other sort) put ₹ lost top-right, status in the facts. M6 `.chart text` 12.5 px, daily chart unscaled, R 22 and phone ticks counted back from today (last date was cut). M7 role ellipsis, "N stores" hidden with a role. M8 Plan settings one line; `.msort` moved beside Search (`.tq`, Reorder + Stock-outs; select gets `aria-label`): first card y 343 at 360 (was ~403). M9 panel link and ⋯ 44 px wide.
- Tests: ui-helpers +2 (desktop UI-1/UI-2/SIMP-B at 1280/1440/1920; phones M1–M6, M8, M9 at 390 + 360), ui-stores +1 (M7); 4 fail on the old public/ code.
- Checked: `npm test` 257 pass / 23 skip (283/283 with Playwright); `test:ui` 26/26; `test:smoke` 30/30 + roles all pass (`PLAYWRIGHT_CHANNEL=chrome`).
- Not done: Drawer charts (Stock level, Units sold) still scale with their viewBox (~11.2 px labels at 360); Products keeps Sort on its own row (its Search shares the View row). Open: shared dev log page row not added; critics not re-run.

## 2026-11-20 · release 1.0.0
stock-watch 1.0.0 (tag `v1.0.0`), deployed to the new Railway project (Limitless Pixel, Singapore).
- Final review: 6 critics × 2 rounds (wf finish-all-sprints), fixes 0e1b893, 15e2897, 2be1cf0, 4a5e9d6. Checked: `npm test` 257 pass, `test:ui` 26/26, smoke + roles smoke all pass (1280/1440/1920/390/360, 0px sideways).
- Old Railway service on the shivam account deleted by the user (URL 404). BACKLOG: SW-016 closed (CI runs the smoke); SW-005 left open only for Railway volume backups (dashboard).
- Next: Sprint 3 (SW-040..062 doable items); real brands when Performity moves us to production.

## 2026-11-20 · Performity connected (Origin header)
stock-watch, `main`. KD sent the real base URL (Azure App Service, dev API); Railway var updated by the user.
- Live calls gave `403 Origin not allowed`: Performity allows our key only from the domain we gave them, checked on `Origin` (not in the calling guide). `keys.pocCall` now sends `Origin: https://$RAILWAY_PUBLIC_DOMAIN` (or `PERFORMITY_ORIGIN`); clear error for that 403. Tests: 2 new (default/override/none; error text).
- Checked by hand (key and token never printed): brands → 1 (TATA Motors); fresh-token → 200, `new-test-store-glcl79bh.myshopify.com`, expiry ~1 h; read-only Shopify query → New Test Store, INR, Asia/Kolkata, 22 products, 11 orders. No IP allow-list hit, so no static IP needed yet.
- Open: compare a pull against Shopify admin; Performity's prod base URL when they move off dev; static IP only if they enable `EXTERNAL_POC_ALLOWED_IPS`.

## 2026-11-20 · final critic round 1 fixes
stock-watch 1.0.0-rc.1, on `main` (ae2c6cd L1; the UI code landed inside 56f79b3, a concurrent Performity-Origin commit that staged the whole tree; this entry in its own commit; not pushed, not deployed).
- L1 (P1): catalog keeps `spells: [{from,to,status}]` when a variant turns active again (max 20, pruned 120 d after `to`); engine `cutBySpells` ends a stock-out at a spell's start and reopens it at its end if still 0; spell days are not in-stock days for the rate (`unsellable`); `period.catalogAsOf` passes spells. Repro (draft while out, reactivate on restock): ₹ lost and the 10 Nov bar stay put. LOGIC §1/§2/§3/§17, FORMATS, AGENTS. Tests: store.test.js (2).
- UI-1 `.range button:focus-visible{outline-offset:-2px}`. UI-2 Back in stock `nw` (Pause rows 34 px at 1280–1920). UI-3 table Why drops "· supplier takes N d" (tooltip keeps it), `.why` 260 px ≤1440: In stock back at 1280, Sells/day at 1440.
- SIMP-1: headline "Order ₹X today · ₹Y sales lost …"; tile 1 = profit lost · % of demand (no cost: % of demand lost · stock-outs), tile 2 = more to order this week (opens This week). Role hide keys unchanged. SIMP-2: Reorder All headline "· ₹Z more this week (M)" (today + week = orderValueAll = list); CSV / Tick all unchanged (they match the stated scope).
- Phones: M1 store bar always a menu (one store too): role name + role list `#role-menu-m` (`SW_ROLES.paint`), view-only can switch; M2 Pause card header wraps (`.bk` pill under the name); M3 chips scroll the least; M4 `.mcard h3{flex:1 1 auto}`; M5 closed fold = summary; M6 7d/14d/30d/60d (aria-label full), min-width 44; M7 12 / 11.5 px; M8 phone stock chart R 24; M9 login 16 px + 44 px ≤760; M10 Sort by nowrap (+ select `min-width:0`: smoke caught 3 px sideways at 360). Desktop untouched by M fixes.
- Tests: ui-helpers +3 (desktop UI-1..3; SIMP-1/2 sums; phones M1–M8, M10 at 390 + 360, M3 and M8 checked to fail on the old code), ui-stores one-store test now expects the role menu, server.test login CSS (M9).
- Not done: M3 when the active chip is the last one (All) the row still ends cut on the left: that is already the least scroll; no fade mask added (would also fade the first chip's edge). Critic SIMP-1 alt (drop tiles) rejected: role views and RACI hang on 4 tile slots.
- Checked: `npm test` 255 pass / 23 skip (browser); `test:ui` 23/23; `test:smoke` 30/30 + roles all pass (`PLAYWRIGHT_CHANNEL=chrome`).
- Open: shared dev log page row not added; critics not re-run on these fixes.

## 2026-11-20 · finish sprints · last gaps
stock-watch 1.0.0-rc.1, on `main` (cdcf303 + this entry; not pushed, not deployed).
- SW-056: `src/version.js`; `/health`, `/status`, `/api/report` `app`, footer `v1.0.0-rc.1 · <sha>` (`dev` unstamped). SHA from `RAILWAY_GIT_COMMIT_SHA`, `BUILD_SHA` env, or `BUILD_SHA` file (`npm run stamp` before `railway up`, then delete; not gitignored because `railway up` skips ignored files). Dockerfile copies it (glob next to package.json). Hex only.
- SW-047: `store.json` `schemaVersion: 1` on every save; `MIGRATIONS` (0 → 1 = add key); newer file → refuse to start, untouched; newer `restore.json` rejected.
- SW-021: `groups.js` `weeks` (summed units, avg out-days ≥ 0.1 when any variant out, `outProducts`); group Trend cell = spark + chip; phone group card spark.
- SW-007: `store.endDemo()` clears demo rows, catalog, Mark ordered, decisions; used by `goLive` (Flow, Sheet, CSV, Shopify orders) and `pullOne`. Import checkbox + CSS + smoke step removed.
- SW-029: digest PUT → change log `digest.hour/roles/paused` (who = role); env webhook host change → `digest.webhook` by `server (env)`, once, hosts only. Change log refreshes in place after digest save.
- Tests: version (4), store schema (4) + demo→live per path (3), backup newer-schema, digest log (2 + route), groups spark (2), ui-helpers 390+360 loops, group sparks 1280/1440/1920/390/360, footer + no checkbox; docs: CHANGELOG top = package version.
- Checked: `npm test` 250 pass / 20 skip (browser); `test:ui` 20/20 (`PLAYWRIGHT_CHANNEL=chrome`); `test:smoke` 30/30 + roles all pass.
- Open: five critics not run on this cycle; shared dev log page row not added; git tag `v1.0.0-rc.1` at deploy (SW-056); Dockerfile `BUILD_SHA*` glob not built locally (no docker here). Group rose mark shows under most weeks for big groups (LOGIC §9a limit).
