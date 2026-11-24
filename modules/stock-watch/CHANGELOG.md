# Changelog: Stock-out Watch (web app)

User-facing changes, newest first. Semver: minor when a number's rule changes or a feature lands, patch for fixes. The version in `package.json` matches the top heading. Versions before 0.9.0 were reconstructed from `docs/DEVLOG.md` on 20 Nov 2026 (no tags existed); dates are the DEVLOG dates. Per DEVLOG, nothing from 0.6.0 on has been deployed yet. Since 1.0.0-rc.1, `/health`, `/status` and the page footer show the version and the build's commit (SW-056); `test/docs.test.js` checks the top heading matches `package.json`.

## 1.2.0 · 2026-11-24 · ₹ lost says how sure it is

- The headline *sales lost* now counts only products whose sales rate rests on **5 or more units** (High 10+, Medium 5–9). Products with 4 or fewer sales behind the rate are an **estimate**, shown apart, and so is the part of a stock-out **still open after 30 days with nothing marked ordered** ("not restocked"). Under the headline, one small line: "+ ₹Y estimate from few sales · ₹Z on items out 30+ days, not restocked", each opening those rows. Sammsara, 30 days to 24 Nov: **₹3.72 L lost (5.9% of demand)**, + ₹1.65 L estimate on 40 products, + ₹52k not restocked on 18; before, all of it (₹5.89 L, 9%) was one number and 61% of it sat on products that sold 3 units or fewer. 7 days: ₹77k (7.4%), was ₹1.40 L (12.5%).
- The same headline everywhere: Overview, Stock-outs, the Products totals line, the daily chart, Yesterday, Copy summary, the morning digest, the weekly review (snapshots are worked out again), groups and targets, `/api/v1/summary` (`money.lost`; new `lostEstimate`, `lostNotRestocked`, `lostAll` = the old total).
- Each product keeps its own whole ₹ lost and the sort by ₹; a small **estimate** or **not restocked** marker says which part isn't in the headline. New optional *Confidence* column (High / Medium / Low) on Products and Stock-outs; filters *Estimates (few sales)* and *Not restocked 30+ d* (Stock-outs chips, Products More…). Why cell: "Out 30+ days, not restocked: restock or drop?". Marking a PO puts a long stock-out back in the headline.
- PO CSV: new columns *Confidence* and *Not restocked 30+ d (₹)*.
- LOGIC §4 compares five ways of counting on Sammsara's live data (§4c has the rule).

## 1.1.5 · 2026-11-20 · numbers that match Shopify for the same dates

- Periods are calendar days in the store's time zone, today included: on 20 Nov "30 days" = 22 Oct – 20 Nov (was the last 30 × 24 hours). Every number on the page follows, and the dates show next to the Period buttons, so the same dates in Shopify give the same numbers.
- Cancel/refund % is now Shopify's own rate: units cancelled or refunded **on the days in the period** (whenever the order was placed) ÷ units ordered in the period. Sammsara, checked against Shopify for 7, 30 and 60 days: every product with a cancel or refund identical (30 d: Cascade 5.4%, Casablanca 11.4%, Evelyn Flamingo 10.8%), store totals identical (30 d: 102 of 2,186, ₹4,03,072).
- Cancellations and refunds of orders placed before the last 60 days are now read too (52 orders bulk-cancelled on 30 Sep, for example). A refund made after an order was already cancelled no longer counts twice.
- Data → "Check against Shopify": net sales for the period as Shopify counts it (₹67,07,306 for 30 days, Shopify ₹67,07,306.22), to compare with Analytics → Net sales. Sold on the Overview stays by order date (what customers bought on those days and kept).
- Orders of the last 60 days are read again once after the update.

## 1.1.4 · 2026-11-20 · plain labels for reversals

- "Returns %" is now "Cancel/refund %" (chip "High cancels/refunds", drawer "Cancelled or refunded"): it counts units cancelled, refunded or removed, not only physical returns (Sammsara had none after delivery in the last 60 days). By order date; Shopify's Returns report counts the same units on the day they're reversed, so a product can differ a little (e.g. 30 d Cascade 4.7% vs 5.4%).
- The period buttons are labelled "Period" (was "Losses for"): they set every number on the page, sales, losses and cancellations.

## 1.1.3 · 2026-11-20

- Returns % now matches Shopify's Returns: read from each order's refunds, and cancelled orders count (Shopify counts a cancellation as a return). Sammsara, 60 days: 185 of 4,461 units returned or cancelled (was 5), ₹7.61 L; Shopify says 259 / ₹10.13 L because it books a return on its own day, and 52 orders from early September were cancelled on 30 Sep. The drawer says how many were cancelled before shipping. Orders of the last 60 days are read again once after the update.
- Units kept no longer trust Shopify's current quantity alone: refunded units come off too.
- Sales rate: a unit returned after the sale still counts as demand (it left the shelf); cancellations never do. Sammsara's numbers don't move (no post-delivery returns in 60 days).
- ₹ sold stays Shopify's Net sales by order date; checked against Shopify for 7, 30 and 60 days (within 0.4–1.9%, the gap being returns booked in the period on earlier orders, LOGIC §What counts as a sale).

## 1.1.2 · 2026-11-20

- Products: Returns % per product (units refunded/returned ÷ ordered, by order date), High returns chip, drawer 'Returned' line; one-time 60-day order re-read to pick up units ordered.

- Roles removed from the menu: the store pill only switches brands; everyone sees everything.

## 1.1.1 · 2026-11-20 · number validation fixes

- Sales rate shown in words: "5 a day", "3 a week", "1 every 2 weeks" (the maths keeps the exact rate).
- Shopify is read every 2 hours (was 15 minutes), so fewer Performity token calls; `SYNC_MINUTES` changes it. Stock-out hours still come from Shopify's change log.

Every number checked against Shopify for Sammsara (LOGIC §1c, §3, §5, §6, What counts as a sale).
- Past stock-outs: the rebuild from Shopify's change log skipped one day in every seven (8 of 61 days), which made phantom stock-outs and left 31 of 253 products out. It now reads every day, splits the first read's own hour with the order lines, and checks itself against your orders: a product with orders while it was supposedly out is left out, and a rebuild that fails the check for over 1% of orders is not used. Stores rebuilt by 1.1.0 are rebuilt again on the next pull. Data shows the check.
- ₹ sold is now Shopify's **net sales, ex GST** (it included GST, 5.7–7.3% high). ₹ lost and profit lost follow. Orders of the last 60 days are read again once after the update.
- No unit costs in Shopify: ₹ to order, overstock and Clear say "at selling price", never "at cost", with a line asking to fill *Cost per item*.
- Products with under 5 units and 14 in-stock days to go on are marked *low data*, sell at their calendar pace, and are never best sellers (2 units before a long stock-out no longer reads as ₹23,280 lost).
- Sales falling 20%+: the drawer also shows the order at the last 2 weeks' pace (e.g. 133 pcs instead of 188).
- "Still out" in the digest, `/api/v1/summary` (new `outNotSelling`) and the weekly snapshots now leaves out products that are out but not selling, like the Stock-outs page (87 → 45).
- This week vs last week: the last 14 days' snapshots are worked out again when the maths, the stock history or the order prices change (they still showed the old rate floor).
- One stock-out count everywhere: the Overview tile, Copy / WhatsApp summary and `/api/v1/summary` `stockouts` leave out products that are out but not selling (94 → 52, the Stock-outs page's count); new `stockoutsNotSelling`.
- A sale inside a stock-out moves its start to that sale (a sale proves there was stock): Aspen was "Out 49 d, ₹51,828 lost" though it sold 2 on 31 Oct. Out at the first stock record reads "Out since before <date>".
- Products with no stock record for part of the period (the rebuild left them out): the drawer hatches the days without history and says sales lost before then is unknown (was a blank chart and ₹0); Data lists them; Stock-outs says "rebuilt for 222 of 253 products".
- Order today ranks by ₹ of sales a day at stake (Cascade, Sable, Casablanca first, not 12 slow out-of-stock items); the Overview panel shows the 5 biggest orders with ₹.
- No unit costs: the headline leads with products to order ("Order 24 products today ₹32.07 L at selling price"); Reorder column *Order value*; budget ranks *Sales kept / ₹* and says "keeps ₹X sales"; digest "Overstock at selling price". Free gifts (mostly sold at ₹0) are never ranked first by a budget.
- Biggest losses leaves out slow sellers, with one "+₹X on N slow sellers: decide" line; This week vs last week shows the weekly flows only (sales lost, stock-outs, movers), not end-of-week states that clashed with the headline.
- Phones: 44 px budget box and CSV file picker, × on an opaque strip once the drawer scrolls, no text under 11 px, weekly names on two lines, "too few sales for a trend" in words, "Trend" label on group cards; Suppliers counts only listed products (253, not 644).

## 1.1.0 · 2026-11-20 · Sprint 3

- ₹ lost on long stock-outs: the in-stock sales rate counts at least 7 days (was 1), so a product seen in stock for a few hours can't claim units-per-day it never showed (LOGIC §3).
- Past stock-outs rebuilt from Shopify's stock change log (60 days, validated) right after a store connects, so ₹ lost is real from day one (SW-063).

Five streams merged: money (suppliers, budget), weekly review, access and security, data import and API, ops.

**Money: suppliers and budget (SW-040, SW-041)**
- Suppliers: set each supplier's lead time, minimum order (MOQ) and case pack on Data → Suppliers, or upload them as a CSV. A product's supplier is its Shopify vendor unless you set another.
- Order quantities now round up to the supplier's minimum order and then to whole case packs. The supplier's lead time replaces the store's for its products, and the extra ₹ from rounding up is shown.
- Reorder → By supplier: one ready-to-send PO draft per supplier (lines, pcs, ₹ total at unit cost), each with Copy and CSV.
- Reorder → Budget ₹: rows are ranked by profit kept per ₹ spent and a cut line marks what fits. Rows over budget are dimmed and left out of the CSV. Leave it empty and the page works as before.

**Weekly review, targets, lists (SW-043, SW-042, SW-044)**
- Overview: new 'This week vs last week' panel below the daily chart. It shows sales lost, profit lost, stock-outs, still out, overstock, to reorder and order today, each with its change and an arrow, plus the 5 products whose sales lost changed most. Built from a daily snapshot per store (snapshots.json, kept 400 days, included in backups).
- Morning digest: Founder and Everyone get one line on sales lost and stock-outs this week vs last week.
- Products by category / collection / tag / parent product: new 'Target this month' column. Admin sets a monthly ₹ target per group. Each row shows sales so far against the target, the month-end forecast at the current pace, how much of the shortfall is stock-outs, and a green / amber (within 10%) / red light.
- Products: paste a list of SKUs, names or variant IDs into the search box to filter to them. Shows 'N of M found' and names the entries not found. Admin can save the list by name for the team; everyone can pick it from 'Saved lists'.

**Access and security (SW-051, SW-052, SW-062)**
- Read-only guard: Shopify queries are now checked by a small GraphQL reader, not a pattern match. Our own Shopify apps that also allow writes are refused with a plain message. For Performity's token, Data says 'Token also allows writes; this app only reads'.
- Google Sheet sync follows at most 3 redirects, and only to Google. Files over 20 MB are refused, and it gives up after 20 seconds.
- Data → People (owner only): give someone their own password for one or more stores, as Admin or Viewer. The password is shown once. New password or Remove signs them out at once. They see only their stores, and the change log shows their name. The main passwords still open every store.

**Data import and API (SW-045, SW-050)**
- Upload a CSV now shows a preview before importing: the file kind, which of your columns feeds each of ours (change any of them with a select), and the first 5 rows as they will be read. Upload is blocked until every needed column is chosen.
- Shopify admin Products and Orders exports import as they are. Variant ID comes from the SKU, or the ID already used for that SKU. Left out: image-only rows, untracked, draft and archived variants, and cancelled, voided and refunded orders. Price paid is the line price minus the line discount.
- The column mapping is remembered per store and per set of headers, in mappings.json. New POST /api/import/preview (admin, writes nothing) and ?map= on /api/import.
- Stock rows keep Vendor from CSV and Shopify exports, for the purchase order CSV.
- /api/v1 is the stable API for other tools: every /api/<x> also answers at /api/v1/<x> with the same login and checks, and the old paths stay (ADR-0017).
- New GET /api/v1/summary (headline ₹ and counts only) and GET /api/v1/rows?view=reorder|stockouts|products (pages in a fixed order, cursor, max 500).
- API: GET /api/review; GET/POST /api/targets; GET/POST /api/lists; GET/PUT /api/suppliers, POST /api/suppliers/map and /api/suppliers/import. Writes are admin only; view-only and cross-site requests get 403.

**Ops (SW-049, SW-053, SW-054, SW-055, SW-057, SW-058)**
- Time zone: each store picks one time zone (for example Europe/London), and daylight saving is followed. Days, the sales-by-hour pattern, This month and Yesterday, order dates, the digest hour and backup names all use it, and so do the weekly snapshots, monthly targets, import preview and supplier ETAs. Older stores keep their saved offset until a zone is picked.
- Plan settings and Advanced planning rules keep exactly what you type. The value is read when you press Enter or leave the box, and an invalid number shows a hint instead of changing anything.
- Data page and /status warn early when a store's data file passes 25 MB, a store passes 1,50,000 rows, or the disk is over 80% full.
- Only one running copy of the app writes to the data folder. A second copy shows the data, refuses writes and says why, then takes over when the first one stops. It also takes no weekly snapshot and stamps no sign-in time.
- KEEP_DAYS sets how many backups are kept (default 14).
- Logs: one JSON line each, with tokens hidden, one line per API call and a startup line naming which settings are set.
- Container: base image pinned by digest; the app runs as a normal user, not root.

## 1.0.0 · 2026-11-20 · first production release

1.0.0-rc.1 plus two rounds of six final critics (logic, UI, cross-module, simplicity, security + QA, mobile), and the live Performity connection:

- Performity calls send our domain as `Origin`; tested live against Performity's dev API and test store.
- A part-filled PO keeps an urgent row in Order today (it no longer drops to This week).
- Stock-outs headline: "N still out, costing ₹X/day"; daily chart drawn at its real width; contrast of up-trends and ok badges ≥ 4.5:1.
- Phones: chips snap with edge fades, sticky drawer close, toast above the bulk bar, store bar fits with a role.
- Railway as code keeps every app variable (no accidental deletes on apply).

## 1.0.0-rc.1 · 2026-11-20 · release candidate: Sprint 1 + Sprint 2 + several stores

The first version meant for production, once the open items in `docs/BACKLOG.md` (Performity IP allow-list, first real store compared against Shopify admin) are closed. What it is, in one place:

- **Decisions:** what to reorder today and how many (in-stock sales rate, lead time, cover, buffer; Mark ordered counts open POs), the ₹ and profit lost to every stock-out, cash stuck in overstock, slow sellers to keep / drop / clear, Pause / Push lists for marketing, a plain "why" and order-by date on every row, a reorder CSV usable as a PO (Sprints 1–2: SW-003, SW-012, SW-024–026, SW-032).
- **Seeing it:** trend bars and % in every decision row, now group rows too; Group by parent product, category, collection or tag; Yesterday strip and This month; role home views that only remove UI; everything shown by default; a morning digest per role by webhook, or Copy / WhatsApp (SW-020–022, SW-027, SW-028).
- **Data:** Shopify read-only (Performity token API, Key Vault or variables), Flow, Google Sheet or CSV, one source per store; a catalog snapshot for current stock; demo data that never mixes with real data (SW-002, SW-006, SW-007, ADR-0014).
- **Several stores** (0.10.0, ADR-0015): one app, a store picker with status dots, each store's data in its own folder, pulls one store at a time.
- **Safe to run:** safe saves and quarantine of bad files, daily and before-wipe backups, restore on start, login limiter, view-only password, settings change log, security headers, `/health` and `/status` for monitors, stale-data banner (SW-004, SW-005, SW-008–010, SW-016–019, SW-029).

New in this release:

- Fixed: a product in stock but Critical or Order now with a part-filled purchase order stays in Order today (it moved to This week); only an order that covers the need marks it Ordered (LOGIC §6b; final critic r2 L1).
- Changed: Stock-outs headline leads with "N still out, costing ₹X/day" on every screen, with "products ran out · sales lost · profit lost" under it (SIMP-B).
- Fixed: Overview's daily chart keeps a fixed 200 px height and 12.5 px labels at any width, so Overview fits one 900 px screen from 1280 to 1920 px (UI-1). Trend-up green, the OK pill and the Stock-outs badge meet WCAG AA contrast (UI-2).
- Phones: the filter chips stop on whole chips with a fade at a scrolled edge (no bare "0" at the left), toasts sit above "Mark N ordered", the drawer's × stays in view, order cost 12.5 px, Products cards show ₹ lost top-right, chart labels 12.5 px, the store name wins over the role in the store bar, Sort beside Search on Reorder and Stock-outs, 44 px targets (final critic r2 M1–M9).
- Ops: `.railway/railway.ts` preserves every app variable, so `railway config apply` can't delete the Performity key or webhooks (X1, `docs/RUNBOOK.md`).

- Performity calls send our app's domain as `Origin` (Performity allows our key only from it); `PERFORMITY_ORIGIN` overrides it. A `403 Origin not allowed` now says which origin was sent.

- Added: `/health`, `/status` and the page footer show the app version and the commit it was built from (`v1.0.0-rc.1 · abc1234`; `dev` for an unstamped build). Deploy step: `npm run stamp` before `railway up` (SW-056, `docs/RUNBOOK.md`).
- Added: `store.json` carries `schemaVersion: 1`. Older files load and are saved with it; a file or `restore.json` from a newer version is refused and never overwritten (SW-047, `FORMATS.md`).
- Added: group rows (Group by) show the 8-week trend bars like product rows: desktop Trend cell, phone card header (SW-021).
- Fixed: real data arriving on a demo store (Flow, Sheet, CSV or Shopify) now also clears the demo's Mark ordered and slow-seller decisions, so a demo PO never lowers a real order. Removed the CSV upload's "Remove the demo data first" checkbox, which did nothing (SW-007).
- Fixed: a variant set to draft or archived while sold out and made active again on restock no longer has its stock-out run through the inactive days: ₹ lost, past daily bars and Yesterday stay as they were. The inactive days don't count as in-stock days for the sales rate either (LOGIC §1, §3; final critic L1).
- Changed: Overview headline reads "Order ₹X today · ₹Y sales lost in N days" ("sales lost" on every screen), and its tiles no longer repeat it: the first shows profit lost (or % of demand lost without costs), the second what more to order this week (final critic SIMP-1).
- Changed: Reorder's All tab headline adds "· ₹Z more this week (M)", so it adds up to the list, CSV and Tick all under it (SIMP-2). The table's Why cell leaves "supplier takes N d" to its tooltip and is narrower up to 1440 px, so In stock stays on a laptop screen (UI-3).
- Fixed: keyboard focus ring on the period buttons was clipped (UI-1); Pause promotion rows no longer wrap "Back in stock" onto two lines at 1440–1920 (UI-2).
- Fixed (phones): the store bar shows the role and opens the role list, so a view-only sign-in can change role (M1); Pause cards put a long "Back in stock" under the name (M2); the active chip scrolls in by the least (M3); card names line up on the left (M4); closed folds on Data are just their label (M5); period buttons 7d / 14d / 30d / 60d, at least 44 px wide (M6); tile context 12 px, best-seller tag 11.5 px (M7); the stock chart's last date fits (M8); 16 px sign-in fields (no iOS zoom) and 44 px targets (M9); "Sort by" on one line (M10).
- Changed: morning digest settings (hour, who gets it, pause) and a change of the server's digest webhook show in the settings change log (SW-029).

## 0.10.0 · 2026-11-20 · several stores, everything shown by default

- Added: several stores in one app (ADR-0015). Every brand the Performity key may use is a store (`PERFORMITY_BRAND_ID` limits it to one); Key Vault `STORES=a,b`; one store from Railway variables; no key → two labelled demo stores with different numbers. Each store's data is in its own folder; nothing is ever added up across stores.
- Added: the store pill is a picker with a green / amber / red dot per store (phones: a store bar under the top bar). The address carries `?store=<id>`; the choice is remembered on this browser. One store shows just its name (phones too). The dots refresh every minute; the menu scrolls instead of running off a short laptop screen; long brand names end in "…"; the product drawer names the store.
- Changed: settings, Mark ordered, Decide, the change log, run history, digest settings and backups are per store; passwords are for every store and view-only stays read-only on all of them. Alerts, digests, the PO CSV file name and the tab title name the store; `/status` totals every store.
- Changed: the old single-store data moves into its store (`SHOPIFY_STORE` / `PERFORMITY_BRAND_ID`, else the first) on the first start, once per data folder (checked copy, safe to interrupt). A later change to the store list never moves anything again.
- Changed: everything shows by default: no role chosen ("All"), Reorder opens on All, every optional column is on (untick in Columns…; on a narrow laptop the right-most ones step aside with a note, never a sideways scroll), Overview shows every panel.

## 0.9.0 · 2026-11-20 · pre-production

Not production-ready yet: see `docs/MODULE-STANDARD.md` §Declaring and the open items in `docs/BACKLOG.md`.

- Fixed: the CEO / finance digest's "vs the 7 days before" no longer counts lost sales on a variant archived while out of stock.
- Changed: best-seller rank (A/B/C) leaves out archived, draft and untracked variants, so the best-seller count, best sellers at risk and order value no longer move with the period buttons.
- Fixed: the reorder / PO CSV, report and Group by no longer fail on unusual variant IDs (such as `constructor`).
- Fixed: Group by trend chips follow the products' colour rule (a fall is never green) against the same baseline.
- Changed: Products filters lose the duplicate Overstock and Slow sellers options (Push these and Slow sellers to decide cover them); marketing's phone home leads with "Pause promotion on N products".
- Docs: `CHANGELOG.md`, `API.md`, `FORMATS.md`, a complete `.env.example`, and a refreshed root `SECURITY.md` and `docs/RUNBOOK.md` (uptime monitor, sidecar files in a restore).

## 0.8.0 · 2026-11-20 · Shopify through the Performity POC API

- Added: Shopify key source "option A" (ADR-0014): the app asks Performity's POC API for a fresh read-only token before each pull (`PERFORMITY_POC_API_URL`, `PERFORMITY_POC_API_KEY`, optional `PERFORMITY_BRAND_ID`). Errors are in plain words (IP not allowed, brand not allowed, store must reconnect); a wrong key pauses pulls 15 minutes.
- Added: `ALERT_WEBHOOK_URL`: one message when Shopify pulls start failing, a reminder every 6 hours, one when they work again.

## 0.7.0 · 2026-11-19 · Sprint 2: value for every role

- Added: role home views (CEO, founder, ops, buyer, marketing, finance, warehouse) that only remove UI; pick from the store menu or `/?role=` (SW-020).
- Added: Group by parent product, category, collection or tag on Products (SW-022).
- Added: a plain "why" sentence and an order-by date on every reorder row; still-out headline shows ₹ per day (SW-024).
- Changed: the reorder CSV works as a purchase order: follows the tab and search, adds vendor, unit cost and variant ID (SW-025).
- Added: Pause promotion / Push these lists for marketing (SW-026); "Yesterday" strip and "This month" period (SW-027).
- Added: morning digest per role, sent to a webhook at a set hour after a fresh pull, plus Share → Copy / WhatsApp (SW-028).
- Added: view-only password (`VIEW_PASSWORD`) and a settings change log (SW-029); sync progress pill and the last 20 runs (SW-030); slow-seller Decide bucket (SW-032).
- Changed: Mark ordered is a tick + bulk bar (one control per row), with an Ordered tab listing every open PO; trend chip colour follows the product's own sign.

## 0.6.0 · 2026-11-19 · Sprint 1: production-ready foundations

- Fixed: the report no longer fails past ~120k rows (SW-001).
- Changed: current stock comes from a catalog snapshot on every pull, so dead stock and archived items are counted right (SW-002).
- Changed: a best seller out of stock for weeks keeps its sales rate and its ₹ lost (SW-003); ABC ranks on demand, not the selected period (SW-031).
- Added: safe saves, a quarantined bad file instead of a blank store, graceful shutdown, `/health` 503 on save failures (SW-004); daily backups, before-wipe backups, restore on start and a backup download (SW-005).
- Changed: one data source per store, so no sale counts twice (SW-006); demo data never mixes with real data (SW-007).
- Security: login limiter on form and Basic auth, production refuses a short password, POST sign-out (SW-008); ingest key in the `X-Ingest-Key` header, 500 rows per request (SW-009); strict CSV import with skip reasons (SW-010); security headers and same-origin writes (SW-016); CSV formula guard (SW-017); bad input → 400 (SW-018).
- Fixed: plan bar Save as default / Reset (SW-011). Added: Mark ordered (SW-012); trend in the decision rows (SW-021); stale-data banner and `/status` (SW-019).
- Changed: the Google Sheet gives the same ₹ lost as the web app (SW-013).

## 0.5.0 · 2026-11-19 · critic fixes and simplicity pass

- Changed: what counts as a sale matches the client's sheet (cancelled and test orders out, refunds netted, price after discounts).
- Changed: three statuses people see (Order today, This week, OK); Overview headline "Order ₹X today · stock-outs cost ₹Y"; fewer default columns; plain labels.
- Fixed: new launches no longer look overstocked; trend ignores time before a product's data; a best seller is never a slow seller.

## 0.4.0 · 2026-11-19 · money view

- Added: best sellers (ABC), profit lost from unit cost, cash in overstock, cash to order now; live assumptions bar with Save as default / Reset.
- Added: trend column with weekly bars; Shopify client ID + secret as the main credential.

## 0.3.0 · 2026-11-19 · Products page and logic docs

- Added: Products page with status tabs, category filter and CSV; `LOGIC.md` for every number.
- Changed: tables fit the screen at 1280–1920 px; denser layout.

## 0.2.0 · 2026-11-19 · sign-in and look

- Added: sign-in page with a 30-day cookie (works in embedded browsers).
- Changed: Performity look; phone cards instead of wide tables.

## 0.1.0 · 2026-11-19 · first release

- Added: reorder list and ₹ lost to stock-outs from Shopify Flow, a Google Sheet or CSV; read-only Shopify pull (Key Vault or variables); Sammsara demo data. Deployed to Railway with a `/data` volume and a password.
