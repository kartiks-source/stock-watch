# Stock-out Watch: how every number is worked out, and why

This is the reference for anyone who questions a number on the page. Each section gives:
- the rule, in plain words and as a formula
- why we chose it
- what else we considered
- when it can be wrong

The code is in `src/engine.js`, which has no inputs or outputs of its own, so every rule here can be tested. The tests are in `test/engine.test.js`. All settings mentioned can be changed under **Data & settings**; the defaults are shown in brackets.

If you change a rule, change this file in the same commit and add a line to `docs/DEVLOG.md`.

**Index** (find the section, read only that): §0a store time zone · §1 what goes in (rows, catalog, §1a CSV/Sheet/Flow, §1c stock history rebuilt from Shopify, what counts as a sale) · §2 stock-out episodes · §3 sales per day · §4 ₹ lost (§4a hour profile, §4b example, §4c how sure ₹ lost is) · §5 Overview totals (§5a periods: N calendar days, This month, Yesterday) · §6 reorder status and qty (§6a assumptions + typing, §6b Mark ordered) · §7 slow sellers (§7a A/B/C, §7b profit, §7c overstock, §7d trend) · §8 restocking · §9 Products columns (§9a/§9b Group by, §9e cancel/refund %, check against Shopify) · §10 demo · §11 known limits · §12 Google Sheet differences · §13 view-only + change log · §14 sync runs (§14a capacity + data folder lock) · §15 decision helpers (§15a–d) · §16 role views · §17 morning digest · §18 several stores · **1.4.0 agency pages:** §19 product picture and links · §20 12 months from Shopify (days in / out) · §21 pace and season · §22 money missed by month, best sellers · §23 best sellers now, push / pause ads · §24 the product drawer (12-month profile).

---

## 0a. Store time (SW-049, `public/tz.js` via `src/tz.js`)

**Rule:** every store has one time zone, `settings.timeZone`, an IANA name such as `Asia/Kolkata` (default) or `Europe/London`. Every store-time day, hour, month and date stamp goes through the one helper `public/tz.js` (the page loads it, the server requires it through `src/tz.js`): rows without a zone (§1a), the daily chart and hour profile (§4a, §5), This month and Yesterday (§5a), Mark ordered dates (§6b), Why / PO / Pause dates (§15), the digest hour and title (§17), backup file names and the page's own dates. Nothing adds a fixed +5:30 any more.

- **Daylight saving:** the offset is looked up per moment (cached per 15 minutes), so a London or New York store's days run midnight to midnight on its own clock. The day the clocks go forward is 23 hours long, the day they go back 25; each is still one day on the chart and one Yesterday.
- **Clock times that don't exist or happen twice:** a row stamped 02:30 on the spring change day reads as the moment the clock jumps (03:00); 01:30 on the autumn day reads as the first 01:30.
- **Digest hour** is the store's wall clock: "09:00" stays 09:00 after the change.
- **Older stores** saved only `tzOffsetMin` (minutes east of UTC). 330 reads as `Asia/Kolkata`; any other number as a fixed offset (`+05:45`) with no daylight saving. Picking a zone in Settings replaces it. Reports still echo `tzOffsetMin` = today's offset, for older readers.

**Why:** one helper means one answer; a fixed offset breaks every store outside India twice a year.
**Considered:** keeping fixed offsets (wrong in Europe, US, Australia); the server's local time (Railway runs in UTC).
**Can be wrong:** a zone whose rules change after the runtime's time zone data was built (Node and browsers update with their releases).

## 1. What goes in

Two streams, nothing else:

| Stream | One row per | Fields |
|---|---|---|
| Stock changes | each time a variant's stock number changes | time, variant ID, SKU, product, variant, stock before, stock after, list price, category (optional) |
| Order lines | each line of each order | time, order number, variant ID, SKU, quantity, unit price actually paid |

- **Stock is the variant's total across all locations.** A stock-out means the shopper couldn't buy it anywhere on the site, which is what loses the sale.
  - **Except a website allocation (1.3.0, §6):** some brands keep only a few pieces "available" in Shopify and top them up from a warehouse Shopify doesn't see. Then Shopify's stock is the allocation, not the stock the brand owns, and no reorder can be sized from it. The app spots the pattern (§6) and doesn't size those reorders. *Sammsara* has no other stock source (24 Nov 2026): one location, Shopify `on_hand` ≈ `committed`, incoming 0 on every variant checked. A warehouse stock feed (a Sheet or the ERP, per SKU) would let us size these reorders later.
- **A variant is the unit of analysis** (e.g. "Nesting Table · Black Marble"), because that's what a shopper picks and what goes out of stock.
- **The same row arriving twice is stored once.** Stock rows are matched on time + variant + before + after; order lines on order number + variant + quantity (`src/rows.js`).
- **Data older than 120 days is dropped** (`src/store.js`), since nothing on the page looks further back than 90 days, **with two exceptions per variant:** its newest stock row (its stock now, even if it hasn't moved in months) and the row that opened a stock-out that's still running. Without them, dead stock lost its only row after 120 days and vanished from Overstock, and a long stock-out lost its start.

### Current stock and attributes (the catalog)

With Shopify connected, every pull also stores the **catalog**: each variant's stock now, list price, unit cost, category, tags, product ID and status, replaced whole on every pull (ADR-0010). The numbers use it as follows:

- **Stock now, price, cost and category come from the catalog**, not from the last stock row. A cost change in Shopify shows on the next pull even if stock didn't move, so profit and cash maths use today's cost. Stock rows are the change history, used for stock-outs.
- **Inactive variants** (product archived or draft, inventory not tracked, or no longer in Shopify) are left out of reorder and overstock: they can't be sold, so their stock isn't cash you can free by selling and they don't need ordering. They still count in Sold and Lost for days they sold, and appear in Products (status *Inactive*) only if they sold or had a stock-out in the period. The Data page shows **Excluded: N archived/draft, X pcs**.
- **A stock-out on a variant that went inactive ends when it went inactive** (first pull that saw it inactive), so an archived product doesn't keep adding ₹ lost or sit in *Still out*.
- **A variant that is made active again keeps its inactive spells** (catalog `spells: [{from, to}]`, up to 20, dropped 120 days after they end). Stock-outs are cut at each spell: the part before it ends when the variant went inactive, and if the variant comes back still at 0 it is out again from that moment. The spell's days are also not in-stock days for the sales rate (§3), so days it couldn't be sold don't dilute it. *Why:* a common practice is to set a sold-out product to draft and reactivate it on restock. Without the spells, the reactivation forgot the draft time and the stock-out ran straight through it: one repro (5 a day at ₹1,000, out 25 days ago, draft 24 days ago, back 1 day ago) jumped from ₹926 lost to ₹1,15,714, and past daily bars and Yesterday changed after the fact (final critic L1). *Considered:* keeping only the last spell (a variant drafted twice would lose the first). *When it can be wrong:* spells start at the first pull that saw the variant inactive, so they are as precise as the pull (every 2 hours by default, `SYNC_MINUTES`).
- A variant deleted from Shopify is kept as *deleted* for 120 days, then dropped with its rows.

Without Shopify (Flow, Sheet, CSV), there's no catalog: stock now is the newest stock row, and nothing is inactive unless the row source leaves it out.

**Where it comes from and how precise it is:**

| Source | Stock-out timing |
|---|---|
| Shopify pull (read-only, every 2 hours by default, `SYNC_MINUTES`) | before the first read: rebuilt from Shopify's change log, to the hour (§1c). After it: timed to the pull, so a stock-out's start and end are each 0–2 h late, and one that starts and ends between two reads is missed (1.3.0: this used to say the change log timed them all; checked on Sammsara, Palma Luxe started 1 h 41 m late) |
| Shopify Flow → this app (no Shopify connection) or the Google Sheet | to the minute, because Flow fires on each change |
| CSV upload | as precise as the file |

**One source per store (ADR-0009).** Once Shopify is connected, the pull is the only source: Flow (`/ingest/*`), Sheet sync and CSV import are refused (409) with a plain message, because their order lines are keyed differently (order + variant + quantity vs Shopify's line ID) and the same sale would count twice. Clear and import also wait while a pull runs. Without Shopify, Flow, Sheet and CSV can be used together: they share one key, so the same order line sent by two of them is stored once. Every row records where it came from (`src`: shopify, flow, sheet, csv, demo). Rows stored before Shopify was connected stay; the pull replaces all lines of each order it reads (by order name), so a Flow or CSV copy of an order from the last 60 days is replaced, not doubled. Exact repeats of a row are dropped.

**Is the data fresh?** With Shopify connected, the data counts as **stale when the last good pull is older than max(45 min, 2 × pull interval + 15 min)**: 255 minutes at the default pull every 2 hours (`SYNC_MINUTES`), i.e. two missed pulls plus 15 minutes' slack; or when there has been no good pull that long after the app started. Each store is judged on its own (§18); stale data in any store turns the unauthenticated `/status` to 503 for the uptime monitor, and `/api/report` carries `freshness {lastPull, ageMin, stale, staleAfterMin}`; the "Data is X h old" banner uses the server's `stale` flag and `staleAfterMin`, never its own number. Without Shopify nothing is ever stale, because Flow, Sheet and CSV data arrive whenever the brand sends them.

**Stale banner:** when Shopify is connected and the data is stale, a red banner above every page says "Data is X h old" with the time of the last pull and any error, and links to Data & settings. It reads the server's `/status` when available, else the pull time sent with the report; re-checked every 60 s; never shown on demo data.

**Times without a time zone** (in a CSV, Sheet or Flow row) are read in the store's time zone (setting *Time zone*, India by default).

### 1a. CSV, Sheet and Flow rows: what's accepted and what's refused

Bad rows feed reorder money, so a file is refused or a row skipped rather than guessed (`src/rows.js`, tests in `test/rows.test.js`).

| Rule | Why | Considered instead |
|---|---|---|
| A CSV upload or Sheet tab must start with a header row. Required: stock `Time, Variant ID, Stock now`; orders `Time, Variant ID, Qty`. Missing ones → upload refused (400) naming them; Sheet sync shows the same message | a file with other headers used to import by position, as phantom stock-outs | guessing columns by position (silently wrong) |
| Exact column names beat aliases (e.g. `Stock now` over `Inventory`); each column is used once. `Variant` is the variant title, never the ID; `Collection` is not a category | `Variant` was read as the ID, so whole files keyed on titles | first match wins (order-dependent) |
| Numbers may carry `₹`, `Rs`, thousands commas and spaces (`₹1,299` = 1299). Text that isn't a number skips the row (*bad number*); a blank stock or qty skips the row; a blank price is ₹0 | `₹1,299` used to become ₹0, blank stock became 0 = a stock-out | treating blank as 0 |
| Dates are day first: `15/11/2026 10:30`, or ISO `2026-11-15 10:30`. Month must be 1–12 and day 1–31 (and a real date), so US `11/15/2026` is refused, not guessed. A date with no time is 00:00 store time | a US date silently became a different day or a future date | guessing US vs Indian order per file |
| CSV / Sheet: a row with no readable time, or a time more than 1 day in the future, is skipped (*bad time*). Only Shopify Flow rows with no readable time are stamped "now" (Flow fires at the moment of the change) | stamping a file's rows "now" made old history look like today's stock-outs | stamping all rows now |
| Rows older than 120 days are skipped (*older than 120 days*), so the counts shown match what is kept | they'd be pruned on save anyway | importing and pruning silently |
| `;`-separated files are detected from the first line | spreadsheet exports in some locales use `;` | asking the user |

The upload message lists how many rows were read, new, and skipped for each reason.

**When it can be wrong:** a day-first file where every date has day ≤ 12 (e.g. `05/11/2026`) can't be told apart from a US file and is read day first. Decimal commas (`1.299,50`) aren't supported.

### 1b. Import preview, column mapping and Shopify exports (SW-045, `src/csvmap.js`)

Data → Upload a CSV shows, before anything is stored, what kind of file it is, which of its columns feeds each of ours, and the first 5 rows as they will be read (or why each would be left out). Any mapping can be changed with a select; the import then goes through the same row checks as §1a.

| Rule | Why | Considered instead |
|---|---|---|
| The kind is read from the header row: a **Shopify products export** (`Handle` + `Variant SKU` + `Variant Inventory Qty` or `Variant Price`) = stock counts; a **Shopify orders export** (`Name` + `Lineitem quantity`) = order lines; our own Stock / Order log headers; else "CSV file" with a suggestion from the §1a aliases | a merchant has these exports already; no reformatting in a spreadsheet | asking the user to pick a template |
| Shopify exports carry no variant ID: **Variant ID = the SKU**, or the ID this store already uses for that SKU (newest stock row, then the Shopify catalog), so an export joins Flow, Sheet or earlier rows. A row with no SKU is skipped (*no variant ID*) | the same product must be one row, whatever brought it in | product title as key (not unique) |
| Products export: **Time = the moment you import** (it is a count, not a history); Variant = Option1/2/3 values joined with " / " ("Default Title" = none); Title, Vendor, Type are copied down the rows of one Handle; image-only rows ignored (not counted); variants with a blank *Variant Inventory Tracker* (*stock not tracked*) or a *draft* / *archived* status (*draft or archived*) are left out | Shopify writes product values on the first row only; an untracked count is not real stock | reading every row as a variant |
| Orders export: Time = *Created at*; Created at, Financial Status, Cancelled at are copied down the rows of one order (*Name*); orders with *Cancelled at* set or status *voided* / *refunded* are left out (*cancelled / refunded*), *partially_refunded* kept; **price paid = Lineitem price − Lineitem discount ÷ Lineitem quantity** (₹14,999 − ₹2,000 ÷ 2 = ₹13,999) | ₹ sold and ₹ lost must not count money that never came in | spreading order-level discount codes over lines (not done: the export doesn't say which lines they hit) |
| A needed column (stock: Time, Variant ID, Stock now; orders: Time, Variant ID, Qty; SKU when Variant ID is "Use the SKU") with no mapping stops the import on the page and, from scripts, with 400 `Choose a column for …` | same as §1a: never guess | importing by position |
| The mapping used for an import with `?map=` is **remembered per store, per set of headers** (same names in any order and case), last 50 sets kept; the next file with those headers opens with it. The page always sends the mapping it showed, so it is remembered; a script posting a Shopify export or our own headers without `map` saves none | the same supplier file comes every week | one mapping per store (breaks with two file shapes) |
| A preview of a file over 256 KB reads its first 256 KB only (5 rows are enough); the import reads all of it | fast on phones | uploading the whole file twice |

**Worked example** (test/fixtures/shopify-orders.csv): #1042 line 1 = 2 × ₹14,999 with ₹2,000 line discount → 2 sold at ₹13,999 = ₹27,998; #1044 voided and #1045 refunded are left out; #1046 gift wrap has no SKU → skipped. 8 rows → 5 read, 3 skipped.

**When it can be wrong:** a products export imported once is one count per variant: stock-outs and restocks show only between two imports (import a fresh export daily, or use Shopify / Flow). Two products sharing one SKU become one row.

### 1c. Stock history rebuilt from Shopify's change log (SW-063, `src/history.js`)

**Problem:** ₹ lost needs past stock-outs, but Shopify has no API for past stock levels, so we only see stock from our first pull on. A store connected today showed about ₹16 lost.

**Rule:** once per store, after its first good pull (and again from Data → *Rebuild stock history*, admin only), the app reads Shopify's stock change log with ShopifyQL (Admin API 2025-10, scope `read_reports`):

> `FROM inventory_adjustment_history SHOW inventory_adjustment_change WHERE inventory_state = 'available' GROUP BY hour, product_variant_id SINCE 2026-09-21 UNTIL 2026-09-27`

(dates are store-time days, **both ends included**; checked on Sammsara: `SINCE 2026-11-14 UNTIL 2026-11-14` returns that day) and walks it backwards from the stock we saw on the first pull:

> stock at hour t = stock at our first read − the sum of 'available' changes after t (up to that read)

- **60 days back** from the first read (the same as the order backfill), for every variant in that first read (active, tracked).
- The result is ordinary stock rows (one at the start with the stock then, then one per hour the stock changed), marked `src: 'rebuilt'` and only for times **before** the first read. Stock-outs and ₹ lost (§2–§4) treat them like any other rows; nothing in the engine changed.
- **The first read's own hour** (1.1.1): ShopifyQL gives one total per store-time hour, and that hour also holds changes made *after* our read. Its logged change is replaced by −(units ordered in that hour before the read), from the order lines, which have exact times. *Why:* Sammsara's first read was 18:10; the 18:00 bucket held a Cascade order at 18:14, so Cascade's whole 60 days read 1 too high and its four real stock-outs (₹10,747 lost in 30 days) vanished.
- **Dropped:** a variant whose rebuilt stock goes below min(its stock at the first read, 0) at any hour. With "sell when out of stock" off that can't happen, so the log is incomplete for it; it keeps only live rows, and Data says how many were left out. A variant oversold to −1 now may sit at −1 in the past too (1.1.1; before, any value below 0 dropped it).
- **The order check** (1.1.1): with "sell when out of stock" off nobody can order a product at 0. So for every order line inside a rebuilt stock-out, after the hour it started, the log must show a stock drop for that variant in the order's hour (an oversell logs its drop and passes). A variant with a line that fails is dropped (live rows only). If failing lines are over **1%** of the order lines in the rebuilt span, the whole rebuild is refused: no rebuilt rows, a note on Data, stock-outs from the first read on. Data shows "check: N of M orders fell while out". *Why:* it is the one test of the rebuild that doesn't depend on the log itself; it caught all 5 variants hurt by the 1.1.0 window bug and passed the 4 real oversells.
- **Paging:** ShopifyQL returns at most 1,000 rows a query. We ask 7 store days at a time (days 60–54, 53–47, … 4–0), each day exactly once; a window that returns 1,000 is split in two halves that still cover every day once, down to one day; a day still at 1,000 is read by day instead of by hour; still 1,000 → no rebuild (note on Data).
- **Rules version:** a store rebuilt by older rules (`history.v`, 2 since 1.1.1) is rebuilt again on its next pull. A failed re-run keeps an earlier rebuild only when it was made by the same rules; 1.1.0 rows are removed instead.
- **Never fails a pull.** No `read_reports` permission, a query Shopify won't accept, or any other error → no rebuild, a plain note on Data, and stock-outs count from the first read on. A failed re-run keeps the earlier rebuild.
- **Stock-outs page:** "Before <first read>: rebuilt from Shopify's change log" when the period reaches back past it.

**Why 'available' only:** Shopify's `inventoryQuantity` (what the pull reads) is the *available* stock. The log also has `committed` (held for unfulfilled orders); adding it double-counts every order (checked by hand on Sammsara: summing both was wrong, available alone matched).

**1.1.0 bug, fixed in 1.1.1:** windows were asked as `SINCE -60d UNTIL -54d`. ShopifyQL's relative `UNTIL -Nd` leaves day N **out** (`SINCE -3d UNTIL -3d` returns nothing), so days 54, 47, 40, 33, 26, 19, 12 and 5 back (26 Sep, 3, 10, 17, 24, 31 Oct, 7, 14 Nov) were never read: 8 of 61 days. Missing sales pushed earlier levels below 0 (31 of 253 variants dropped, Cascade among them) and missing restocks made phantom stock-outs (Leela 7 Arm out for 60 days, ₹27,270, while it sold until 14 Nov; Aspen out from 2 Oct, ₹51,828, while it held 2 pcs until 31 Oct). The old note here ("245 of 257 kept, ≈₹2.05 L") could not be reproduced.

**Validation (Sammsara, 20 Nov 2026, read-only, live store file + the full change log, 61 days):** 1.1.1 keeps **250 of 253** variants (3 dropped, 1.1.0: 222/253); the order check finds **0 of 4,088** order lines inside a rebuilt stock-out (1.1.0 rows, same log: 6 lines on 5 variants). Cascade 49352313930031 is kept and hits 0 four times (30 Oct, 11, 14, 19 Nov). Same engine as 1.1.0, rebuilt rows only: ₹ lost 30 days ₹6,05,634 → ₹7,40,721, 7 days ₹1,81,194 → ₹2,41,603, stock-outs (30 d) 94 → 128 (with the 1.1.1 low-data rule, §3: ₹6,48,248 and ₹2,12,077). All ₹ in this paragraph are on the stored tax-inclusive prices, before the 1.1.1 order re-read (about 5–7% lower after it). 'available' is the right state: Cascade's 60 days are purchase −299, correction +270 (Sammsara books restocks as corrections), restock +22, against 282 units sold.

**Considered:** order-based guessing (no sales for N days = out: misses slow sellers and stock-outs on busy days); asking the brand for a stock export (one point in time, not history); waiting 30 days for our own history (the brand wants the number on day one).

**When it can be wrong:**
- **Hour granularity:** a change counts at the start of its hour; a stock-out that started and ended inside one hour is missed. A capped day is read by day (start of day).
- **The first read's own hour:** built from order lines (above), so a restock or correction in that hour before the read is missed, and an order cancelled later still counts as a sale there.
- **Several locations:** the change is the variant's total across locations, like the pull (§1); a transfer between locations nets to 0.
- **Drafts and archived products are left out:** only variants active at the first read are rebuilt; a variant created in the last 60 days that started at 0 reads as out from the start (it sold nothing then, so it shows under *Out but not selling*, below, not in ₹ lost).
- **Times without a zone** in the log are read in the store's time zone (§0a); set it to the shop's.

**Out but not selling (Stock-outs page):** a product that was out but had no sales and no sales lost in the period lost nothing, so it isn't counted in the headline ("N products ran out", "N still out") or the menu badge; it has its own chip, *Out but not selling*, and one line under the headline. Since 1.1.1 the engine applies the same rule: `totals.stillOut` leaves these out and `totals.outNotSelling` counts them, so the digest, `/api/v1/summary` and the weekly snapshots say the same as the page (before: 87 in the digest vs 45 on the page, Sammsara). *Why:* rebuilt history brings in old dead items sitting at 0, which made the count look worse than the money says. A product out for the whole period that sold before it, inside the orders we hold, is **not** in this group: its rate looks further back (§3), so it has sales lost. **One that sold only before our orders start** (1.3.0) used to land here at ₹0 (Sammsara: 36 of the 40 had sales in Shopify's last 26 weeks, Solis Gold Accent Table 19 units, Oversized Owl Set 25); with Shopify's weekly sales read (§4c) it gets the 26-week floor rate (§3) and leaves this group, its ₹ in *not restocked*.

### What counts as a sale

| | Shopify pull | Flow / Sheet / CSV |
|---|---|---|
| Cancelled orders | never a sale, also when cancelled after we first read the order. Since 1.1.3 their lines are stored with qty 0 (all units `returned` and `cancelled`) so Returns % counts them as Shopify does (§9e) | whatever the template sends; send only live orders |
| Test orders | left out | left out only if the Flow condition excludes them |
| Refunds and removed items | netted: units kept = `currentQuantity` less the units on the order's refunds (1.1.3: read from `order.refunds`, because a refund need not lower `currentQuantity`); `quantity` is kept as `ordered`, refunded units as `returned` (§9e); a fully refunded line is stored with qty 0 (never a sale) | as sent |
| Discounts | price after line **and** order-level discounts (`discountedUnitPriceAfterAllDiscountsSet`) | as sent |
| Tax (GST) | taken out (1.1.1): when the order's prices include tax (`taxesIncluded`), price = price paid − the line's tax lines ÷ its ordered quantity | as sent |
| Later edits | each run re-reads orders updated since the last run (30-minute overlap) and replaces their lines | not picked up |

**₹ sold = Shopify's Net sales by order date** (1.1.1). Before, it was Shopify's *Total sales* (GST inside): Sammsara includes tax in every price, so ₹ sold ran 5.7–7.3% over Net sales (30 days: ₹71,75,868 vs ₹67,88,993). Checked: 19 Nov, app ₹1,60,252 = Shopify net sales ₹1,60,252.03 (Total ₹1,70,740 = the old number). ₹ lost uses the average price paid from the same lines, so it is ex GST too, and profit lost (§7b) sets an ex-GST price against an ex-GST cost. **Upgrade:** a store read before 1.1.1 reads its last 60 days of orders again once (`shopify.priceBasis`); orders older than that keep the tax-inclusive price until they age out. Flow / Sheet / CSV prices are as sent: send ex-tax prices to match.

**Order date vs return date (1.1.5, checked live, Sammsara, 20 Nov 2026, store-calendar days):** Shopify's Net sales = gross − discounts − *returns*, and books returns (which include **cancelled orders**: a cancellation is a gross sale on the order's day and a return on the cancel day) on the day of the return. **₹ sold here stays by order date:** the orders placed in the period, less their own cancellations and refunds, whenever they happened ("what customers bought on these days and kept"). Data → **Check against Shopify** shows Shopify's own number for the same dates: **Shopify-style net sales = gross − discounts of the orders placed in the period (ex GST, cancelled orders included) − reversals dated in the period** (§9e), `totals.shopifyNet = { gross, returns, net }`:

| Period (IST) | App Shopify-style net sales | Shopify `net_sales` | App ₹ sold (order date) |
|---|---|---|---|
| 7 d, 14 – 20 Nov | ₹12,20,945 | ₹12,20,944.57 | ₹12,40,489 (1.1.3 figure) |
| 30 d, 22 Oct – 20 Nov | ₹67,07,306 | ₹67,07,306.22 | ₹67,32,704 |
| 60 d, 22 Sep – 20 Nov | ₹1,32,27,574 | ₹1,32,27,573.85 | ₹1,34,79,814 |

Gross − discounts by order date matches Shopify's `gross_sales + discounts` to ₹0.30 in each period (per-line rounding of the ex-GST price), so the check is within ₹1.

**Why ₹ sold stays by order date (decision 1.1.5, kept from 1.1.3):** ₹ sold feeds the daily chart, % of demand and the sales rate. Booking a return on its own day puts a negative day on the chart when old orders are cancelled in bulk (30 Sep: −₹2.4 L for orders placed 1–20 Sep), lowers that week's rate for sales that happened weeks earlier, and sets sales a stock-out lost against cancellations of orders from before it. By order date the gap to Shopify's Net sales is only *when* a return counts (+0.4% to +1.9% here), and the check line gives Shopify's number exactly when someone compares. *Considered:* switching Sold to Shopify's net sales (exact match, but the chart and rates above get worse); showing both on the Overview (two "sold" numbers confuse; the Data line is enough).

**Demand counts units ordered, less cancellations (1.1.3, `engine.demandQty`):** the sales rate (and so ₹ lost, reorder quantities, trend, the hour profile) counts **units kept + units returned after the sale**. A return is still a sale the shelf had to cover: the unit left stock, and if it is restocked it comes back as a stock increase the stock data already sees. Counting only units kept would under-order a product that sells and comes back. A **cancellation** (the whole order, or a line cancelled before shipping, restock type `CANCEL`) is not demand: Sammsara's are mostly COD orders cancelled within minutes, or refused at the door and cancelled later; counting them would order stock for sales that never happen. ₹ sold, units sold and the daily chart stay on units kept. For Sammsara today the rate doesn't move (no post-delivery refunds in 60 days).

This matches the DAWBU dashboard's definition (cancelled out, refunds and discounts netted), so the two show the same sales for the same days. One known difference remains: DAWBU sums variants into products **by title**, and we keep **variants by ID**. Totals agree, but per-product rows can differ where two products share a title.

---

## 2. Stock-out episodes

**Rule:** a product goes **out** when its stock drops to 0 or below, and comes **back** when it rises above 0. A stock-out that hasn't ended runs until "now" and is shown as **Still out**.

**Why:** zero stock is the only state in which a shopper definitely can't buy. Negative stock (overselling) counts as out too, because it means orders were taken that can't ship.

**Edge cases:**
- **Stock-outs that started before the selected period:** ₹ lost and the "product-days with an empty shelf" count only the hours inside the period. The **Out for** column shows the stock-out's full length, so you can see how long it really lasted.
- **A cancellation or return that puts stock back** can end a stock-out early, and if it's only a piece or two it shows up as a small top-up. Read small top-ups of 1–2 pieces with that in mind.
- **A product whose first-ever record shows 0:** counted as out from that moment, because we have no evidence it was in stock. The Why cell says "Out since before <date of that record>", not "Out 60 d": the stock-out may have begun long before our data (1.1.1, SIMP-6).
- **A sale inside a stock-out moves its start to that sale (1.1.1, M1, `afterLastSale`):** a sale proves there was stock, so an out spell starts no earlier than the last order line inside it, ignoring lines in its first hour (the sale that emptied the shelf, or a stock row stamped after the sale). ₹ lost, *Days out*, the in-stock rate and the Why cell all follow. *Why:* Aspen Textured Drink Table showed "Out 49 d", ₹51,828 lost and 30 shaded days, yet sold 2 pcs on 31 Oct: the rebuilt history (§1c) missed a refill. *Considered:* ending the spell at the first sale inside it (then a product that sells once and is empty again for weeks loses its real stock-out). *When it can be wrong:* a pre-order sold at 0 really was out for shoppers who don't pre-order; the drawer's stock line still shows the recorded 0.
  - **An oversell is not a sale with stock (1.3.0, `oversold`).** A line whose drop below 0 is logged (a stock row with stock before ≤ 0 and stock after lower, in the line's hour, where rebuilt rows are stamped, or up to one pull interval after it, where Shopify rows are stamped) was taken at 0 by a checkout race and is skipped. *Why:* every Sammsara variant is set to *deny* when out of stock (checked on all 68 read on 24 Nov 2026), so −1 can only be a race, never "continue selling". Nivaya Table Set of 2 was out for 31 days, then one order on 23 Nov went 0 → −1, and the old rule moved the start to that order: it showed "Out 17 h, ₹98, slow seller" instead of about ₹49k lost on a best seller. The same pattern hit 6 products (Nivaya, Aspen, Elephant Urli, Aster, Noah, Om Thali); on the 24 Nov data the 30-day headline went from ₹3.73 L to ₹4.24 L. A sale with no logged drop (a refill the history missed, as with Aspen above) still moves the start.
  - **A restock timed by a pull (1.3.0).** Stock rows from the Shopify pull are stamped at the pull, up to one pull interval (`SYNC_MINUTES`, 2 h) after the change. A sale in the last pull interval before a pull-stamped restock came after the restock, so it ends the spell at that sale instead of moving the start (it used to wipe the whole spell: 5 days out at 3 a day showed 0.3 h and ₹11 instead of ₹11,823). A sale earlier than that still moves the start. *Considered:* only moving the start for sales at least one interval before the end (same result for the start, but the spell would then run past the sale).
- **A blank *Stock before* = the previous row's *Stock now*,** never 0. *Stock before* can be blank: a CSV without that column, or a Shopify variant made active again (its last-seen stock was forgotten while it was draft). A blank used to read as 0, so every stock-out after the first was missed (one repro: 3 stock-outs showed as 1 and ₹ lost fell to a sixth, *Out now* with nothing *Still out*), and a variant reactivated at 0 was never counted as out. A blank on a product's first row is still 0 (no earlier evidence). *Considered:* always using the previous row's *Stock now* (wrong where a file skips rows: its *Stock before* is the better evidence) and refusing rows without *Stock before* (Shopify's own reactivation rows have none).

**When it can be wrong:**
- **Bundles or pre-orders** sold at 0 stock would look like stock-outs.
- **Products that are paused rather than out** would also look out. Untracked products and products not set to Active get no stock rows from the Shopify pull for this reason, and a stock-out ends when the product turns inactive (section 1, catalog). If it is made active again, the inactive time stays cut out: the stock-out is not stretched back over it (section 1, spells).

---

## 3. Sales per day (the in-stock rate)

**Rule:**

> sales per day = units sold in the last 28 days ÷ days the product was **in stock** during those 28 days (at least 7 days, or the whole span if shorter)

"Units sold" here = units kept + units returned after the sale, never cancelled ones (1.1.3, §What counts as a sale, "Demand counts units ordered").

**How it's shown (1.1.1):** in words, rounded: 1 or more a day → "5 a day"; under 1 a day but at least 1 a week → "3 a week"; slower → "1 every 2 weeks". The exact rate (e.g. 0.43 per in-stock day) is in the tooltip and is what every calculation uses: rounding it would turn a 0.3-a-day seller into 0 (never reordered) or 1 (3× too much stock).

**Floor of 7 days (since 1.1.0, 20 Nov 2026):** a product seen in stock for only a few hours (common after the stock history rebuild, §1c, when it was out almost the whole window) could otherwise turn 2 units into "2 a day" and inflate ₹ lost. Counting at least 7 in-stock days caps such a rate at units ÷ 7. It never stretches past the span measured, so a 3-day-old store or product is still divided by 3. Before: the floor was 1 day; on Sammsara two candleholders out 60 days showed ₹3.5 L lost on 0–2 units sold.

Setting: *Sales history used* [28 days]. If the store's data starts later than 28 days ago, the window starts with the data. **A product's own window starts at its first stock record or first order**, so a product launched 5 days ago is measured over those 5 days, not diluted by 23 days before it existed. (Without this, a new launch looked like a slow, overstocked product.)

**Long stock-outs (fewer than 7 in-stock days in the window):** the window can't say what the product sells, so the rate looks further back:
1. **The most recent 28 in-stock days** within the history we keep (120 days), skipping the time it was out: units sold over that stretch ÷ the in-stock days in it.
2. **If it hasn't been in stock at all in that history**, the 28 days before the stock-out began.

The average price paid (section 4) comes from the same sales. A product launched recently, or a store whose data starts recently, has no older history, so for it nothing changes. The product's `rateBasis` says which rule gave the rate (`window`, `history` or `before-out`) and `rateFrom` when that stretch starts.

*Why:* without this, a best seller out for the whole 28 days sold 0 in the window, so it got a rate of 0: it showed as a Slow seller with ₹0 lost and dropped off the reorder list. The costliest stock-outs vanished from exactly the lists meant to catch them. Example: 5 a day at ₹1,000, out for the last 30 days → still 5 a day, **Out now**, order 5 × 40 = 200, ₹ lost ≈ 30 × 5 × ₹1,000 = ₹1,50,000 over a 30-day view. *Why 7 days:* under a week, one good or bad day swings the rate too much, and weekdays aren't all covered. *Considered:* a fixed 90-day window for everyone (too slow to follow a season) and carrying the last rate forward from before the stock-out (ignores any in-stock days since). *When it can be wrong:* if demand really fell while the product was out (season over, trend passed), the older rate over-orders; check the product's sales chart before a big order.

**Low data (1.1.1):** a rate resting on **fewer than 5 units and fewer than 14 in-stock days** is capped at *units ÷ calendar days since the product's first sale*, the row is marked **low data** (drawer), and it can't be a best seller (A, §7a, so not in *Best sellers at risk*). *Why:* after the stock history rebuild many products were seen in stock only briefly; Tara 5 Arm sold 2 units in the 17 hours before a 40-day stock-out, which read as 0.29 a day, ₹23,280 lost and Out now; at its calendar pace inside the 60 days we hold it is 0.03 a day. (1.3.0 correction: over a year Shopify's reports show it sold 56, about 0.15 a day; the cap is a floor on what we hold, not its real pace. The 26-week confidence, §4c, is what now tells a steady seller from a lucky one.) 28 products with ≤ 3 units carried 44% of Sammsara's 30-day ₹ lost. *Considered:* leaving them out of ₹ lost altogether (hides real stock-outs of slow, pricey items); a higher floor for everyone (holds back real launches: a launch selling 4 in 3 days keeps its rate, since its calendar pace is no lower). *When it can be wrong:* a product that really sells fast but was out almost all the time reads slow until it has 5 sales or 14 in-stock days.

**Evidence behind the rate (1.2.0, §4c):** every product row carries `rateUnits` = the units sold in the stretch the rate was measured on (the same order lines: window, history or before-out), `heldUnits` = every unit sold in the orders we hold (1.3.0) and `confidence` (§4c: from Shopify's weekly sales when read, else units). The rate itself doesn't change; what changes is whether its ₹ lost counts in the headline (§4c). The low-data cap above still applies to the rate.

**Floor from Shopify's 26 weeks (1.3.0, `FLOOR_DAYS`):** a product **out the whole time we hold** (under one in-stock day since our orders start), with **no sale** in those orders but sales in Shopify's weekly report (§4c, `units26` = net units over the last 25 full weeks and this week), gets a floor rate for ₹ lost only:

> floor = units26 ÷ 182 a day, valued at Shopify's net sales ÷ units for those weeks (ex GST)

All of its ₹ lost goes to **not restocked** (§4c; an estimate when a PO is marked): it has been out since before our data, so every day in a 7- or 30-day view is past its 30th day. Its order quantity keeps its own rate (0, so it stays a slow seller). The Why cell says "Out since before 21 Sep · sold 19 in 26 w: restock or drop?" (date = its first stock record). *Why:* these sold before 21 Sep (the start of the orders Sammsara's token can read) and read ₹0 "out but not selling" (§1c); at 26-week pace they are ≈ ₹1.3 L in 30 days, all of it on items nobody restocked. *Considered:* the anchors' "units ÷ weeks live" (very close; 182 days keeps it one rule); putting it in the estimate (it is a restock-or-drop decision, the same as not restocked). *When it can be wrong:* a calendar pace is a floor on the in-stock pace (it also counts weeks it was out); a product being dropped on purpose still shows here until its stock-out is ended (archive it in Shopify).

**Days it couldn't be sold** (archived, draft, untracked, deleted: §1) count like out-of-stock days: they're left out of the in-stock days, so a product drafted for three weeks and then reactivated keeps its rate.

**Why in-stock days, not calendar days:** a product that sold 28 units but was out of stock for 7 of the 28 days really sells 28 ÷ 21 = 1.33 a day, not 1.0. Dividing by 28 would make every stock-out shrink the next order, and the product would run out sooner the next time, a loop that keeps getting worse. Removing the out-of-stock time breaks that loop.

**Why 28 days:** four full weeks, so every weekday counts equally, and it's recent enough to follow a trend. We considered 7 days (too jumpy for slow sellers) and 90 days (too slow to react to a season or a campaign).

**When it can be wrong:**
- **Seasonal peaks:** right after a festive peak such as Diwali the rate is still high, so it may over-order for a week or two. Shorten the window during a known peak if needed. Long stock-outs were worse: their rate comes from the last in-stock stretch (*history*), which on Sammsara (24 Nov) is late Sep–Oct, the pre-Diwali rush, for about half of the counted ₹ lost. **Since 1.4.0 (§21), with Shopify's 12 months read, ₹ lost on those rows uses the 6-month in-stock pace × this month's season instead** (`lossPace` on the row); the order quantity keeps this section's rate.
- **New products** with only a few days of data: the rate is noisy. Use the product's stock chart before trusting the order quantity.

---

## 4. ₹ lost to a stock-out

**Rule:**

> units lost = selling hours out of stock × (sales per day ÷ 24)
> ₹ lost = units lost × average price paid

- **Average price paid** = the product's revenue ÷ units over the same 28 days, after discounts. If it hasn't sold in that time, the list price is used.
- **Selling hours** = clock hours out of stock, each multiplied by **how busy that hour of the day is** for this store (next section).

**Why this way:**
- **It values the stock-out at the demand the product had when it was in stock** (section 3). Without a stock-out those shoppers would have bought at the usual rate.
- **The price is what shoppers actually paid,** not the list price, so discounts aren't counted as lost money.
- **Hours are weighted** because demand isn't flat: a 2 am to 6 am stock-out costs far less than 6 pm to 10 pm.

**What else we considered:**
- **Counting abandoned carts or product-page views during the stock-out:** more direct, but it needs analytics access we don't have and misses shoppers who never reached the page.
- **Comparing with the same days last year:** this needs a year of history and breaks for new products.

**When it can be wrong:**
- **Overstated** if shoppers bought a similar product instead (substitution). The demand wasn't lost, it moved. On a deep range of similar products, read ₹ lost as an upper bound.
- **Understated** if the brand paused ads while the product was out, or if the stock-out started before our data did.
- **Approximate either way:** it's an estimate of demand that didn't happen, and it can't be checked against an order. Treat it as a size of the problem, not an accounting figure.

**What the headline counts (1.2.0, §4c):** each product's ₹ lost above is kept whole on its row (`lost`), but the headline *₹ sales lost* counts only **high- and medium-confidence** products, and leaves out the part of a stock-out **after its 30th day** when it is still open and nothing is marked ordered, and (1.3.0) the refill gaps of website-allocation items (§6). Those parts are shown apart, on one small line under the headline ("Not in ₹X: …").

**Ways we compared (live Sammsara, read 24 Nov 2026 10:11 IST, engine 1.2.0 on the store's backup, the same options as `/api/report`; 30 d = 26 Oct – 24 Nov, 7 d = 18 – 24 Nov; sold ₹59.72 L / ₹9.75 L).** Products = products with any ₹ in that number.

| | Rule | 30 d ₹ | 30 d products | 30 d % of demand | 7 d ₹ | 7 d products | 7 d % |
|---|---|---|---|---|---|---|---|
| A | current (≤ 1.1.5): everything | ₹5,88,692 | 63 | 9.0% | ₹1,39,788 | 51 | 12.5% |
| **B** | **chosen: high + medium, not restocked apart** | **₹3,71,843** (+ ₹1,64,833 estimate on 40 · + ₹52,016 not restocked on 18) | **22** | **5.9%** | **₹77,334** (+ ₹38,042 on 22 · + ₹24,412 on 18) | **15** | **7.4%** |
| C | leave out products with ≤ 3 units sold in the period | ₹2,28,092 | 20 | 3.7% | ₹2,667 | 2 | 0.3% |
| D | low confidence at the Poisson 80% lower bound of its rate, one number | ₹4,68,555 | 63 | 7.3% | ₹1,06,275 | 51 | 9.8% |
| E | count at most 30 days of any stock-out, PO or not | ₹5,36,676 | 62 | 8.2% | ₹1,15,376 | 37 | 10.6% |
| F | as B, confidence by price band (average paid ex GST): ≥ ₹10k High 3+ units / Medium 2; ₹4k–10k High 6+ / Medium 3–5; under ₹4k High 10+ / Medium 5–9 | ₹4,31,522 (+ ₹1,05,154 on 35 · + ₹52,016 on 18) | 27 | 6.7% | ₹91,972 (+ ₹23,404 on 18 · + ₹24,412 on 18) | 19 | 8.6% |
| G | as B, confidence by regularity: distinct weeks (7-day blocks) with a sale over all order history held, High 4+ / Medium 2–3 / Low 0–1 | ₹5,10,356 (+ ₹26,320 on 10 · + ₹52,016 on 18) | 52 | 7.9% | ₹1,11,787 (+ ₹3,589 on 3 · + ₹24,412 on 18) | 34 | 10.3% |
| **G26** | **chosen in 1.3.0:** as B, confidence by the share of Shopify's last 25 full weeks with a sale (ShopifyQL, no order download): High ≥ 44%, Medium 22–43%, Low < 22%; live under 8 weeks → B | ₹4,78,719 (+ ₹57,957 on 18 · + ₹52,016 on 18) | 45 | 7.4% | ₹1,05,614 (+ ₹9,762 on 18 · + ₹24,412 on 18) | 33 | 9.8% |

B's three parts add up to A exactly (₹3,71,843 + ₹1,64,833 + ₹52,016 = ₹5,88,692). D's factors (lower bound ÷ units): 1 unit 0.22, 2 units 0.41, 3 units 0.51, 4 units 0.57. Data and the script: `approaches.json` (top 20 products and worked rows) in the session's scratch folder, built by running the engine on `/api/export/backup.json`.

*F and G (added 24 Nov, owner: unit counts alone undersell high-ticket items; ₹5k–10k items are 52.5% of Sammsara's 30-day sales on 499 units).* On this data no product with ₹ lost averages ₹10k+ paid (8 products are priced that high; together they sold 1 unit in 30 days), so F's top band changes nothing; its ₹4k–10k band moves **5** products from estimate into the headline (30 d): Seville Nesting Table ₹29,220 (0 sold in the period, 3 older sales), Dahlia Table ₹18,694, Kyoto Round Nesting Table ₹18,215, Celeste Marble Table ₹5,457, Aspen Drink Table ₹1,777. G moves **30** of B's 40 estimate products into the headline (2 weeks with a sale is enough for Medium), which takes the headline back near A; with orders only from 21 Sep (about 9 weeks) "weeks with a sale" can't tell a steady seller from two lucky weeks. F turned out to rest on a wrong premise: on Sammsara the pricey items are the *most* regular sellers (median share of weeks with a sale over 26 weeks: 36% for the top price quartile, 8% for the cheapest), so a longer record helps more than price bands. **G26 (1.3.0)** takes G's idea over 25 weeks from Shopify's own sales reports (one ShopifyQL read a day, weekly units per variant, no order download; `read_all_orders` and a year of orders are not needed): it separates steady sellers (Kyoto 13 of 25 weeks, Seville 10, Dahlia 9) from lucky ones (Surrey Drink Table 4 of 25 stays Low).

*Why B:* it says what it knows. C throws away real stock-outs of products that were out the whole period (they sold 0 *because* they were out: Avani Two Tier Platter, 8 units behind its rate, out 29 days) and in a 7-day view keeps almost nothing. D hides the doubt inside one number that is still mostly guesswork on 1–4 sales and can't be explained to a buyer. E caps best sellers too: an out-for-6-weeks best seller with a PO on the way is still losing sales. B keeps every rupee visible and clickable, with the uncertain ones named.

### 4a. How busy each hour is (hour-of-day profile)

**Rule:** from the store's own order lines of the last 60 days, units sold are counted per local hour of the day (0–23). One unit is added to every hour, so a quiet hour never counts as zero. The 24 numbers are then scaled so their average is exactly 1.

- A stock-out across a busy evening hour counts for, say, 1.6 hours.
- Across 3 am it might count for 0.3.
- **Over a full day the weights add up to 24,** so a day-long stock-out still costs exactly one day of sales.

**Why:** most D2C stores sell mostly in the evening. Without weighting, overnight stock-outs would be overvalued and evening ones undervalued.

**Why the store-wide pattern and not each product's own:** most products sell too few units for a reliable 24-hour pattern of their own. The store-wide pattern is stable.

### 4b. Worked example

Say a product sold 28 units in 28 days but was out of stock for 7 of them, at an average paid price of ₹1,200.
1. **Sales per day** = 28 ÷ 21 = 1.33.
2. **It goes out on Friday 18:00 and is back on Sunday 10:00.** That's 40 clock hours, including two evenings. Weighted by the store's pattern, say it comes to 46 selling hours.
3. **Units lost** = 46 × 1.33 ÷ 24 = 2.56.
4. **₹ lost** = 2.56 × ₹1,200 = **₹3,067.**

---

### 4c. How sure is ₹ lost (confidence) (1.2.0, 1.3.0, `src/engine.js` `confidenceOf`, `confidenceOfWeeks`, `notRestockedDays`; `src/weeks.js`)

**Rules:**

| Part | Rule | Where it shows |
|---|---|---|
| Confidence (1.3.0, G26) | the share of **Shopify's last 25 full weeks** (Monday–Sunday, store time) the variant was live in that had a sale (net units > 0): **High** ≥ 44%, **Medium** 22–43%, **Low** under 22%. *Live* = full weeks ending after the variant's `createdAt` (catalog). A variant live **under 8 full weeks**, or a store whose weekly sales aren't read (no `read_reports`, Flow / Sheet / CSV, demo), uses **units**: max(units in the rate's stretch `rateUnits`, every unit held `heldUnits`): High 10+, Medium 5–9, Low 4 or fewer | `confidence`, `confBasis` ('weeks' / 'units'), `weeksSold`, `weeksLive` on every row; *Confidence* column (optional) on Products and Stock-outs; "sold in 10 of 25 weeks" in the Why cell and the drawer |
| Counted (`lostCounted`) | ₹ lost of High and Medium products, less any *not restocked* part | the headline everywhere: Overview, Stock-outs, Products totals line, daily chart, Yesterday strip, Copy summary, digest, weekly snapshots, `/api/v1/summary` `money.lost`, groups and targets |
| Estimate (`lostEstimate`) | ₹ lost of Low products, less any *not restocked* part | "+ ₹Y estimate from few sales" under the headline; row marker **estimate**; filter *Estimates (few sales)* (Stock-outs chip, Products More…) |
| Not restocked (`lostNotRestocked`) | the part of a stock-out **still open after N days with nothing marked ordered** (no *Mark ordered*, §6b) that falls after its N-th day, whatever the confidence. N = max(30, lead time + buffer + 14) (`nrDays`, 1.3.0; 30 on Sammsara: 7 + 3 + 14 = 24). A floor-rate product (§3) is all *not restocked* | "₹Z after day 30 on M items not restocked" under the headline (1.3.0 wording: it is the part after day 30, not those items' whole loss); row marker **not restocked**; filter *Not restocked 30+ d* (Stock-outs chip, Products More…); Why cell "Out 30+ days, not restocked: restock or drop?" |
| Refill gaps (`lostAllocation`, 1.3.0) | ₹ lost of website-allocation items (§6), less any *not restocked* part | "₹X lost in refill gaps on N allocation items" on the same line; not in any headline |

- `lost` on a row stays the product's whole number (= counted + estimate + not restocked + refill gaps); rows show the counted ₹ in red and the rest in grey ("+₹X est.", 1.3.0) and sort by the counted part first.
- `totals.lost` = Σ `lostCounted`; `totals.lostEstimate`, `totals.lostNotRestocked`, `totals.lostAllocation` (and `…Products`, how many rows have each); `totals.lostAll` = all four = the old total; `totals.notRestockedDays` = the store's N. **% of demand** = `lost` ÷ (sold + `lost`), the headline only.
- A **PO marked** on the product (*Mark ordered*, still due or late, not yet received) keeps the whole stock-out counting: someone is restocking, so the shelf is really missing sales. A stock-out that **ended** (refilled) counts in full whatever its length.
- Daily chart bars and the Yesterday strip = counted; `daily[]` also carries `lostEstimate` and `lostNotRestocked` per day.
- Stock-out rows carry `confidence`, `lostOver30` (₹ after day 30, any stock-out) and `lostNotRestocked`.

**Why:** Sammsara, 30 days to 24 Nov: of ₹5.89 L lost, 43 products that sold 3 units or fewer carried ₹3.61 L (61%), and the category team said products they know don't sell showed losses. Two causes: a rate from 1–4 sales can be chance; and a product left at 0 for weeks with no reorder is probably being dropped, so "sales lost" every day after the first month is not money anyone will act on. *Why 10 / 5:* with Poisson counts the spread is about √n: at 10 units the rate is within ±30% or so; at 4 or fewer it can be off by half or more. *Why 30 days:* the longest normal supplier wait plus a buffer is under a month (lead 7 + buffer 3 on Sammsara); a stock-out older than that without an order is a decision, not a delay. 1.3.0: never shorter than lead + buffer + 14, so a slow supplier's normal wait isn't called "dropped". *Considered:* see the table in §4.

**Why weeks, not units (G26, 1.3.0):** the units rule only sees the 60 days of orders we hold, so a steady seller that had a slow month looked like a guess. Seville Nesting Table Set of 3 was the 1.2.0 example of "mostly chance" (0 sold in the period, 3 older sales); Shopify's reports show it sold 2–4 a month since July, in 10 of the last 25 weeks (34 in a year), so its ₹15.5k is plausible and the real question is restock or drop. 34 of the 40 Low products sold 10+ units in the last year. *Why 44% / 22%:* the same ratios as G's 4 and 2 of 9 weeks. *Why a share of weeks:* a lucky week counts once, a steady seller shows up week after week, and the buyer can check it ("sold in 10 of 25 weeks"). *Why 8 weeks:* under that, a share is too few weeks to mean much. *Cost:* one ShopifyQL read a day per store (a few pages under the 1,000-row cap), after a good pull, never failing it (`src/weeks.js`). *Considered:* G on our 9 weeks (counts 1-sale items), borrowing from similar products (on Sammsara peers vary too much to move any product: own-evidence weight ≥ 0.90 on the top 20), a year of orders (`read_all_orders`, rejected as too heavy).

**Sammsara, 1.3.0 on the live backup (24 Nov 2026 11:17 IST; before = 1.2.1 at the same moment):**

| | 1.2.1 | 1.3.0 |
|---|---|---|
| 30 d headline | ₹3,72,598 (23 products) | ₹4,81,472 (40) |
| 30 d estimate | ₹1,65,977 on 40 | ₹69,348 on 18 |
| 30 d not restocked | ₹52,397 on 18 | ₹1,89,660 on 57 (₹58,670 after day 30 on 20 + ₹1,30,990 at the 26-week floor on 37) |
| 30 d refill gaps | – | ₹61,755 on 4 allocation items |
| 7 d headline / estimate / not restocked | ₹78,292 / ₹38,435 on 22 / ₹24,795 on 18 | ₹1,11,794 / ₹12,094 on 9 / ₹58,621 on 57 |
| Order today | ₹25.24 L | ₹9.40 L (4 allocation rows out) |

Against the anchors (10:11 IST backup, G26 alone: ₹4,78,719 / ₹57,957 on 18 / ₹52,016): the oversell fix (§2) adds about ₹51k to the headline, the allocation rows take ₹62k out, and Aspen's restored stock-out (an oversell) adds about ₹11k to the estimate.

**When it can be wrong:** a product being restocked without anyone pressing *Mark ordered* shows as *not restocked* after day 30; mark the PO to put it back. Weeks with a sale say how *regular* a product is, not how *fast*: a steady 1-a-week seller and a 5-a-week seller can both be High; the rate (§3) still sets the ₹. ShopifyQL books a return on the return's date, so a week with a sale and a return can net to 0 and not count. A variant created long ago but only recently published counts weeks it wasn't on sale as weeks without a sale (it reads lower).

## 5. Totals on the Overview

**`/api/v1/summary` (SW-050, §5c below)** gives other tools these same totals, unchanged.

| Number | Rule |
|---|---|
| Sold | sum of quantity × price paid for every order line in the period: **net sales, ex GST** with Shopify (§What counts as a sale; chart legend "Sold ex GST", tooltips say so). Totals are the sum of the product rows, so the Overview and the Products page always agree |
| Lost to stock-outs | sum of ₹ lost (section 4) for stock-out hours inside the period, **counted part only** (§4c, 1.2.0): high and medium confidence, without the 30+ d not restocked part and (1.3.0) the refill gaps of allocation items (§6); those show on one small line under the headline, "Not in ₹X: ₹Y estimate from few sales · ₹Z after day 30 on N items not restocked · ₹W lost in refill gaps on M allocation items", each opening Products (Overview) or Stock-outs filtered to its rows. A filtered view (Estimates, Not restocked) leads with that part's own ₹. A stock-out spanning midnight is split across the days it covers |
| % of demand | lost ÷ (sold + lost), the headline lost only (§4c). "Demand" = what was sold plus what would have been sold |
| Daily chart | the same two numbers per store day (setting *Time zone* [Asia/Kolkata], §0a); one bar per calendar day of the period (§5a), today so far included |
| Selling items out now | products at 0 stock that sell at least the minimum rate (section 7) |
| Out of stock right now (list) | every open stock-out, slow sellers included, so it can be higher than the count above |
| Product-days with an empty shelf | total stock-out hours across all products ÷ 24 |
| Headline | "Order ₹X today · ₹Y sales lost in N days": ₹X = order cost of the *Order today* rows (§6), ₹Y = Lost to stock-outs above. **Without unit costs** it leads with the count: "Order N products today ₹X at selling price · ₹Y sales lost" (1.1.1, SIMP-1: ₹33.54 L "to order" was quantity × price paid, not cash). The Overview *Order today* panel lists the 5 biggest orders by ₹, with pcs; *Biggest losses* leaves out slow sellers (§7, not reordered) and adds one line "N slow sellers ran out: decide" that opens Products → Slow sellers to decide (SIMP-5: a top-5 loss was also "Slow seller, don't reorder"); with a counted part it says "₹X counted on N slow sellers: decide" (1.3.0: it used to add their whole ₹, ₹2.26 L of which only ₹10.8k was in the headline). The lost number is called **sales lost** on every screen. **No unit costs in Shopify** (1.1.1): ₹X, *more to order this week*, *stuck in overstock* and Decide *Clear* values are at **selling price**; the summary, tooltips and drawer say "at selling price" (never "at cost"), and a line under the tiles asks to fill *Cost per item* in Shopify (Sammsara: 0 of 645 variants costed) |
| Stock-outs (count) | `totals.stockouts`: stock-outs of products that sold or lost sales in the period, the same count as the Stock-outs page ("51 products ran out 52 times"). Products **out but not selling** (no units, no sales, no sales lost in the period, §1c) are counted apart in `stockoutsNotSelling` and `outNotSelling` (still out), and each such episode carries `notSelling: true`. Same count on the Overview tile, the Copy / WhatsApp summary, the digest, `/api/v1/summary` and the weekly *stock-outs* flow (1.1.1, UI-2/M2: the tile said 94 = 52 + 42 not selling while the page said 52) |
| No stock record before part of the period | `row.historyFrom` = the product's first stock record. When it is more than a day after the period starts (the rebuild left the product out, §1c, or it is new to the data), its ₹ lost before then is **unknown**, not 0: the drawer's Sales lost tile says "Unknown / before <date>: unknown", its Stock level chart hatches the days before with a note, Data lists those products with units sold, and the Stock-outs note says "rebuilt … for N of M products" (1.1.1, UI-1: Cascade's chart was blank before today and its tile said ₹0 while it sold 147 pcs) |
| Tiles | each says what the headline doesn't (final critic SIMP-1: the same ₹ used to show three times, under two names): **profit lost** (§7b) · % of demand, or, with no unit costs, **% of demand lost** · number of stock-outs; **more to order this week** = order cost of the *This week* rows (whole reorder list − Order today) · products, opens Reorder → This week; **best sellers at risk**; **stuck in overstock** |

### 5a. Periods: N calendar days, "This month" and the Yesterday strip (SW-027, 1.1.5, `src/period.js`)

- **N days (1.1.5):** the store's last N **calendar** days, today included: from 00:00 store time N − 1 days ago until now (`period.range` → `tz.daysStart`). On 20 Nov, "30 days" = 22 Oct – 20 Nov, "7 days" = 14 – 20 Nov, "60 days" = 22 Sep – 20 Nov. Every number on the page follows it (sold, sales lost, % of demand, daily chart, cancel/refund %, Products, Stock-outs, Group by, CSV, `/api/v1`, the digest), and the dates show beside the Period buttons in small text ("22 Oct – 20 Nov"; hidden from 761 to 1010 px where the one-row header has no room; two lines on small phones). Daylight saving zones count calendar days too (a 23- or 25-hour day is one day, §0a).
  - *Why:* Shopify's reports pick whole days. With the old rolling window (now − N × 24 h) a 30-day number started mid-morning 30 days ago, so no Shopify date range gave the same number. With calendar days, Shopify Analytics with the same dates (`SINCE 2026-10-22 UNTIL 2026-11-20`; ShopifyQL's `UNTIL` includes its date) reproduces them (checked: §9e).
  - *Considered:* N full days ending yesterday (Shopify's "Last 30 days" excludes today in some views; but the owner wants today's sales and stock-outs in the numbers); keeping rolling (not reproducible).
  - *When it can be wrong:* just after midnight "7 days" holds 6 days and a few minutes; the sales rate, reorder plan and trend do not depend on the period (they use their own windows, §3, §7d).
- **This month** (period picker): from the 1st of the current month at 00:00 store time until now. On the 1st it covers only today so far. Every number that follows the period (sold, lost, % of demand, daily chart, Products and Stock-outs pages, CSV) uses this window. The reorder plan does not depend on the period: best-seller rank (§7a) rests on the 28-day demand of active products only, so order value, best sellers and order quantities are the same for 7, 30, 60 days and This month. Shown as "this month" instead of "in N days".
- **Yesterday strip** (one line under the Overview headline): `Yesterday: ₹X sold · ₹Y lost · N ran out · M back`.
  - *Sold* and *lost* are yesterday's store-time calendar day, exactly the numbers on that day's bar in the daily chart (same rules as section 5, including the hour-of-day weighting for lost).
  - *Ran out* = products where a stock-out started yesterday; *back* = products where a stock-out ended yesterday (stock came back above 0). A product that ran out twice counts once.
  - When the period doesn't reach back to yesterday (This month on the 1st), the strip is worked out from a separate 2-day report with the same settings. That report drops the page's own period (`from`), which would otherwise override the 2 days and leave the strip blank on the 1st (critic L1; `test/period.test.js`).
- Why: the owner checks "how did yesterday go" every morning; a fixed rolling 30 days hides it, and month-to-date matches how targets and budgets are set (DAWBU sheet).
- Considered: a "Yesterday" button in the picker (a one-day period). Rejected: one line answers the question without changing every other number on the screen.
- When it can be wrong: *lost* yesterday uses today's in-stock rate, like every ₹ lost figure (section 4); stock-outs after the first Shopify read are timed by the pull (every 2 hours by default, `SYNC_MINUTES`), 0–2 h late (the change log's hours only cover the history before the first read, §1c), so one that started just before midnight can land on the next day.

### 5b. This week vs last week (SW-043, `src/weekly.js`, `public/weekly.js`)

- **Daily snapshot**: once a day per store, the headline numbers are saved in `snapshots.json` (FORMATS.md), so the comparison shows what the page said then, not today's maths re-run on old rows. One rule for every snapshot: the report as of the store-midnight that ends the day (rows recorded by then, Mark-ordered records made by then, inactive flags as they stood then, today's unit costs), period = that one store day.
  - Flows of that day: *sales lost* (§4), *profit lost* (§7b), *stock-outs* = stock-outs that started that day.
  - State at its end: *still out* (§5), *overstock* = cash stuck in overstock (§7c), *to reorder* = Order today + This week rows (§6), *order today* = order cost of the Out now / Critical / Order now rows.
  - `lostBy`: ₹ lost per product that day, top 100 (for the movers).
- **When it is taken**: on the first report or pull after store-midnight, once the data reaches past the day's end (Shopify: the last good pull is after midnight; Sheet / CSV / Flow / demo: now). Missing days of the last 14 are filled in (first run, downtime), from the first day with any row. Kept 400 days. Demo and real data never mix: a switch demo → live starts the snapshots again; Clear and a demo load forget them.
- **The panel** (Overview, below the daily chart, so the chart still ends inside 900 px): *this week* = the newest saved day up to yesterday and the 6 days before; *last week* = the 7 days before those. Flows are added up over the week; states are the newest day's. **The panel shows the flows only** (sales lost, profit lost, stock-outs) since 1.1.1 (SIMP-4/UI-3): the end-of-week states repeated the headline's labels with an older day's numbers ("Order today ₹13.10 L" under "Order ₹55.31 L today"). The states are still saved and in `/api/review`. *Stock-outs* leaves out not-selling episodes (§5). Each number shows its change (▲▼ and ₹ or count; % on wide screens and in the tooltip): green = better (less lost, fewer out, less overstock), rose = worse; *to reorder* and *order today* are grey (neither good nor bad). A week with fewer than 7 saved days says so ("5 of 7 days").
- **Movers**: the 5 products whose ₹ lost changed most between the two weeks (absolute change, ties by ₹ lost this week); a click opens the product.
- **Digest**: Founder and Everyone get one line, `This week: ₹X lost to stock-outs, up/down from ₹Y last week · N stock-outs (M the week before).` The CEO digest already compares weeks (§17), so it doesn't.
- **Worked out again (1.1.1):** the file keeps `calc` = engine rules version (`CALC_VERSION`) | stock history rebuild time | order price basis. When it changes, the last 14 days are dropped and taken again, whatever took them, so the panel uses the same maths as the daily chart. *Why:* on Sammsara all 8 snapshots were taken at the history rebuild, minutes before the 7-day rate floor; the panel said ₹2,58,406 lost this week vs ₹1,81,970 summed from the chart, and its top mover was a phantom stock-out. Days older than 14 keep what they said then.
- When it can be wrong: a backfilled day uses today's in-stock rate and today's unit costs, like every ₹ lost figure (§4); a day taken late (no report or pull that day) still has its correct day window, but *still out* and *order today* reflect the rows known by its midnight.

---

### 5c. Numbers for other tools: `/api/v1/summary` and `/api/v1/rows` (SW-050, `src/apiv1.js`)

No new maths: the summary copies `totals` from the same report the page shows (same period and trial settings), and rows are the report's own `reorder[]`, `stockouts[]`, `products[]`.

| Field | Is |
|---|---|
| `money.sold`, `money.lost`, `lostPct` | Sold, Lost to stock-outs (the headline, §4c), % of demand (above) |
| `money.lostEstimate`, `money.lostNotRestocked`, `money.lostAll` | the parts shown apart (§4c) and all three together (the pre-1.2.0 total) |
| `money.lostProfit` | profit lost (§7b) |
| `money.stillOutPerDay` | ₹ a day the products out right now cost (§15a) |
| `money.orderValueNow` / `orderValueAll` | order cost of the *Order today* rows / of every row to order (§6) |
| `money.excessValue` | cash in excess stock (§7c) |
| `counts.*` | `products` with data, `outNow` selling items out, `stillOut` open stock-outs, `orderToday` / `orderNow` / `orderWeek` rows by status (§6), `bestAtRisk` A items at risk (§7a), `overstocked` (§7c), `stockouts` episodes in the period |
| `yesterday` | the Yesterday strip (§5a) |

| Rule | Why | Considered instead |
|---|---|---|
| Rows are paged in variant-ID order (stock-outs: then start), the cursor = the last row's key, at most 500 a page | a ₹ order moves while someone pages, so rows would repeat or vanish between pages | offset pages in ₹ order |

## 6. Reorder status and quantity

**Days left** = stock now ÷ sales per day.

| Status | When | Why this threshold |
|---|---|---|
| **Out now** | stock ≤ 0 | already losing sales |
| **Critical** | 3 days or fewer left | out before most suppliers could deliver even if ordered today |
| **Order now** | ≤ lead time + safety days [7 + 3] | an order placed today only just lands in time |
| **Order this week** | ≤ lead time + safety + 7 days | an order placed in the next week still lands in time |
| **OK** | more than that | — |

**Order quantity:**

> order qty = sales per day × (lead time + cover + safety days) − stock now, rounded up, never below 0

Settings: *Lead time* [7 days], *Cover after a reorder* [30 days], *Safety stock* [3 days].

**Why:** the order has to cover the days until it lands (lead time) and then last the cover period, with a few days' buffer for busy days or a late supplier. Stock already on hand is subtracted.

**What else we considered:**
- **Safety stock from demand variability** (the textbook formula using standard deviation and service level) is more precise. But it needs months of clean history per product, and brands find "3 days of extra stock" easier to reason about. It's a good next step once there's more data.
- **Order value** = order qty × **unit cost** (the cash you commit to the supplier). If a product has no unit cost, the average price paid is used instead, which overstates the cash; the page then says "at selling price" (§5).

**Row order (1.1.1, SIMP-2):** Out now, Critical and Order now are one group (*Order today*), ranked by ₹ of sales a day at stake (sales per day × average price paid), then *Order this week*, then the rest. *Why:* ranking every Out now first put 12 slow items (0.2–0.6 a day) above Cascade, Sable and Casablanca (Critical, 1.3–1.8 days left, 54% of the ₹ to order), which fell off the Overview panel. *Considered:* days left (puts every out-of-stock slow item first again).

**At the last 2 weeks' pace (1.1.1):** when the product's trend (§7d) or the store's typical trend is down 20% or more and the last 14 days' in-stock rate is lower than the 28-day rate, the row also carries `paceQty` = the same formula at that recent rate (with Mark ordered and supplier rounding), shown in the drawer under the order: "131 pcs at last 2 weeks' pace". The order quantity itself still uses the 28-day rate. *Why:* after a festive peak the 28-day rate over-orders: Sammsara 20 Nov, store trend −36%, Cascade 188 pcs at 4.87 a day vs 133 at 3.49; across Order today ₹54.9 L vs ₹41.5 L (tax-inclusive prices, before the 1.1.1 re-read). *Considered:* sizing the order on min(28-day, 14-day) when falling (changes every order on a noisy 14 days; left as the person's call). *When it can be wrong:* a stock-out in the last 14 days leaves few in-stock days (under 3 → no pace shown).

**Website allocation: top up from the warehouse (1.3.0, `allocationOf`, setting *Spot website allocations* [on]):** a variant whose stock went up **3+ times in the last 14 days, each time to the same level of at most 10 pcs**, and whose every stock-out in those 14 days ended **within 48 hours** (one open longer than that disqualifies it) gets the status **Top-up from warehouse**. It is left out of the reorder list, *Order today*, its ₹ and the supplier quantities; its ₹ lost goes to *refill gaps* (§4c), apart from the headline. Why cell: "Shopify shows a website allocation (~7 pcs, refilled from the warehouse). Warehouse stock isn't in Shopify, so we can't size a reorder: check the warehouse." Data & settings says how many products this is. *Why:* on Sammsara Cascade went back to exactly 7 pcs 10 times in 14 days, most often around 14:00, and 131 of 400 stock increases landed on exactly 7; ended stock-outs were refilled in a median 0.3 days, faster than any supplier. Four always-capped rows (Cascade, Sable Leaf, Casablanca, Sphere) read Critical every day and held ₹16.3 L (65%) of the ₹25.2 L *Order today*. The shelf really was empty in the gaps, so the ₹ is real, but the fix is topping up sooner or raising the allocation, not a purchase order. *Considered:* Shopify's `on_hand` (≈ `committed` on Sammsara, no real stock), `incoming` (0 everywhere). Sammsara has no other stock source; a warehouse stock feed (Sheet or ERP, per SKU) would let us size these reorders later. *When it can be wrong:* a real shelf that a supplier happens to refill to the same small number 3 times in two weeks (unusual) is called an allocation; turn the setting off (0) if the brand has no warehouse.

**When it can be wrong:**
- **Lead time is one number for the whole store** unless the product's supplier has its own (§6c, SW-040). Until a supplier lead time is set it is a guess, so the Why cell says "supplier takes 7 d (assumed)" (1.3.0; on Sammsara *Order today* is ₹9.4 L at 7 days and grows a lot at 14 or 21).
- **Minimum order quantities and case packs** apply only when set for the supplier (§6c, SW-040).

---

## 6a. Changing the assumptions (live)

**Typing (SW-057, `public/trial-input.js`):** the number boxes (Plan settings on Reorder, Advanced planning rules on Data) keep exactly what you type; the value is read when you press Enter or leave the box, so the numbers don't jump mid-typing. `1,5` reads as 1.5. Text that isn't a number in the setting's range (the same ranges the server clamps to) shows "Enter a number from X to Y" under the box and changes nothing.

**Plan settings** on Reorder holds three boxes (lead time, stock should last, buffer) for trying values; all six rules (lead time, cover, safety, sales history window, slow-seller cutoff, small top-up) are under **Data & settings → Advanced: planning rules**.

**Why:** the right lead time or cover differs by supplier, season and cash position, so a brand can try values on Reorder before changing the store's rules.

## 6b. Already ordered ("Mark ordered")

**Rule:** when someone places a purchase order they tick the row on Reorder (one or many) and press **Mark N ordered** in the bar that appears, or use **Mark ordered** in the product drawer and give the quantity and the expected date it lands (defaults: the suggested order quantity, today + lead time). The app stores one record per variant: `{ qty, eta, at, by }` (`DATA_DIR/onorder.json`, kept as safely as `store.json` and carried in every backup, export and restore: a damaged file is never read as "nothing on order", which would put ordered lines back in Order today; critic r2 X1, RUNBOOK → Backups).

> received = sum of stock increases recorded after the order was marked, each measured from *Stock before*, or from the previous row's stock when that's blank (section 2), so a row with a blank *Stock before* isn't read as an increase from 0
> still to come = ordered qty − received; once 90% has arrived the order is treated as complete and dropped
> it **counts** when it's not past its date **and** lands before the shelf empties, or no later than an order placed today could (today + lead time), with a day's grace because dates are whole days
> when it counts: the plan is worked out on stock now + still to come

| Result | Shown as |
|---|---|
| stock + on order is enough (status would be OK) | **Ordered · lands 25 Nov**, off Order today, listed under the **Ordered** tab, order qty 0 |
| stock + on order still isn't enough | stays in Order today, order qty = only the extra still needed, with "50 on order" next to the status. The row keeps the status it has without the order (**Out now**, **Critical**, **Order now** or *This week*) however close the order gets, since units on the way don't change when the shelf empties; the Why cell still says "order by today" (critic L2: a part-filled order used to move an empty shelf to *Order now* or even *This week*, off Order today and out of "out now"; final r2 L1: the same for stock > 0, e.g. 5/day, 10 in stock, 50 on order moved Critical to *This week*) |
| past the expected date and less than 90% received | back in **Order today**, in red: "Ordered 200 · was due 25 Nov" |
| lands after the shelf empties and later than a fresh order could | doesn't count: the row stays in Order today with the order shown, so you can decide whether to chase the supplier or order elsewhere |

**Ordered tab** (Reorder): every open order, whatever its status: one that covers the need, a part order (still in Order today too), a late one, one landing too late to count. Late first, then by landing date. Columns: *Lands* ("Lands 25 Nov · 40 of 200 in · order 150 more" / "Late · was due 22 Nov", red), *On order (pcs)* = still to come, days left, in stock. Headline: "N on order · M due this week · K late" (due this week = lands within 7 days, not late); empty: "Nothing on order. Marked orders show here until they land." The tab's CSV has the same rows. Rule in `helpers.onOrderRows` / `onOrderSummary` (app.js mirrors it). Critic SIMP-1: the tab used to list status *Ordered* only, so a part or late order (the ones a warehouse must chase) never showed there, and the tab's qty column read 0.

**Days left** still uses stock on hand only, because that's when the shelf empties. A product that's out of stock but ordered still counts in "out now" and keeps losing sales until the order lands.

**Why:** the plan used to look at stock on hand only, so a line ordered yesterday showed up again today with the same quantity, which invites a duplicate purchase order. Counting units only when they land in time keeps the list honest: an order that arrives after the shelf is empty doesn't stop the stock-out. Detecting arrival from stock increases means nobody has to "receive" the order in a second step.

**What else we considered:**
- **Reading purchase orders from Shopify:** Shopify has no purchase-order API for most stores, and the app is read-only (ADR-0001).
- **Clearing the mark on any stock increase:** a return of one piece would clear a 200-piece order. Counting units received is more exact.

**When it can be wrong:**
- **Returns or manual stock corrections after the mark** count as received, so a large return can make an order look partly arrived.
- **A short shipment of up to 10%** is treated as complete.
- **One record per variant:** marking again replaces the previous order (add the quantities yourself if there are two open orders).
- Overstock (§7c) doesn't count units on order.

## 6c. Suppliers: lead time, minimum order, case pack (SW-040)

Kept per store in `suppliers.json` (Data → Suppliers, admin only; CSV in and out). `src/supplier-rules.js`.

**Which supplier a product has:** the SKU → supplier map when set (by SKU, else variant ID), else Shopify's product **vendor**. Names match whatever their case. No supplier = the store's lead time and no rounding.

**Rule:**

> lead time = the supplier's lead time when set, else the store's. It drives status, order qty, order-by date, "earliest" date, Pause list and excess stock for that product.
> order qty = (the §6 qty, worked out with that lead time), then **up** to at least the MOQ, then **up** to whole case packs
> extra pcs = rounded qty − the §6 qty; **extra cash** = extra pcs × unit cost (price when no cost)

Example: the §6 qty is 7, MOQ 12, case pack 6 → 12 (at least 12, and 12 is 2 whole cases). Qty 13 → 18 (3 cases). At ₹450 a unit, 13 → 18 costs ₹2,250 more.

Only an order that is due is rounded: a product with nothing to order is never pushed up to a minimum. "Mark ordered" lands on today + the supplier's lead time.

**Why:** a supplier won't ship 7 when the case holds 6 or the minimum is 12; a PO that ignores this has to be fixed by hand every time. Rounding up (never down) keeps the stock-out protection; the bar under Reorder shows the cash the rounding adds ("₹X of the orders is minimum-order / case-pack round-up", `totals.packExtraValue`), and each PO draft shows its own.

**What it costs:** extra cash tied up, at most one case (or up to the MOQ) per line. With slow sellers and a big MOQ that can be many days of stock: check the Order (pcs) number and the "+N" next to it.

**By supplier (Reorder):** one PO draft per supplier from the rows in view with something to order (and inside the budget, §6d): lines, pcs, ₹ total at unit cost (Order cost), Copy (plain text, ready to paste in WhatsApp or email) and CSV (`/api/export/reorder.csv?supplier=<name>`, same columns as §15b). Rows with no supplier are grouped as "No supplier".

**Demo:** invented vendors by product type, named after Indian craft towns, with invented terms (`src/demo.js`); they go when real data arrives unless an admin edited them.

## 6d. Cash budget cut line (SW-041)

On Reorder, optional **Budget ₹** (remembered per store, in this browser). Empty = the page exactly as before.

**Rule** (`src/budget.js`, mirrored in `public/money.js`):

> units short = min(order qty, max(0, sales/day × (lead time + days to last) − stock now − units on order that count))
> profit kept = units short × (average price paid − unit cost)
> profit kept per ₹ = profit kept ÷ order cost
> rank the rows in view by profit kept per ₹ (high first; ties: more profit kept); add order costs top-down; the first row that doesn't fit and **every row after it** are over budget

Unknown unit cost: margin = price × the store's average margin % (products with a cost), marked "est."; no product has a cost: price (₹ sales kept per ₹). Then the column is *Sales kept / ₹*, the bar says "keeps ₹X sales" and there is no "est." (1.1.1, UI-4).

**Free gifts (1.1.1, M4):** a product with no unit cost whose average price paid is under 10% of its list price (engine `row.gift`) is mostly given away; it is never ranked (perRupee empty, last) and shows "free gift?". *Why:* Mystery Gift (list ₹899.40, 1,196 lines mostly ₹0, average ₹0.78) ranked first: 460 pcs for ₹361 at 1.12 per ₹.

**Worked example:** sells 2/day, lead 10 + lasts 20 days = 60 needed, 12 in stock → 48 short. Order 60 at ₹450 = ₹27,000. Price ₹1,000 → margin ₹550. Profit kept = 48 × 550 = ₹26,400 → **0.98 per ₹**. A product keeping ₹6,000 on a ₹3,000 order (2.00 per ₹) ranks above it.

**On the page:** a *Profit kept / ₹* column, an amber line "Budget ₹X ends here · N below are over budget (₹Y)", rows below dimmed, and the bar: "N fit · ₹spent keeps ₹profit · M over budget (₹)". The CSV link carries `&budget=`, so the file (and each supplier's PO) has only the rows above the line. A column sort keeps rows dimmed but drops the line (the order is no longer the ranking).

**Why:** cash is the limit for most D2C brands; when it can't cover the whole list, the order should buy the most profit per rupee first. One clear line (never "skip the big one, take a smaller one below") keeps it readable top-down; a buyer can still tick a row below the line.

**Why safety days are left out of "units short":** the buffer is insurance, not expected sales; counting it would rank products with big buffers too high.

**When it can be wrong:** the profit is for one cycle only (lead + days to last); it ignores that a stock-out of a best seller can also cost ad spend and ranking. Rows with nothing to order are not part of the cut.

## 7. Slow sellers

**Rule:** a product selling below *Ignore below* [0.2 units a day, about 6 a month] is a **Slow seller**. Slow sellers are left out of the reorder list and alerts, but their stock-outs and ₹ lost are still counted.

**Exception: a best seller (A, section 7a) is never a slow seller.** A ₹90,000 sofa selling one a month can be in the top 80% of ₹ demand; it stays on the reorder list.

**Why:** for a product selling one unit a month, "days left" and "order quantity" swing wildly with a single order, and filling the reorder list with them hides the products that matter. It's not marked "not selling" because these products do sell, just slowly. A product with no sales at all is never "Out now" or on the reorder list, whatever the cutoff.

---

## 7a. Best sellers (A / B / C)

**Rule:** products are ranked by **₹ demand a day** = sales per day (section 3) × average price paid (section 4), both from the 28-day sales history, **not** the selected period. Going down that list, the products that together make the **first 80% of demand are A (best sellers)**, the next 15% are B, and the rest, plus anything with no demand, are C. A products show a **Best seller** tag everywhere. **Inactive products** (archived, draft, untracked or deleted, §2) are not ranked and are always C: they can't be ordered, and they appear in the rows only when they sold or lost sales in the selected period, so ranking them let the period buttons move A slots, best sellers at risk and order value (critic r2 L2: demo with 15 variants archived 6 days ago gave 90 A at 7 days, 97 at 30).

- **Low data** rows (§3, fewer than 5 units and 14 in-stock days) are never A: they rank B at most.
- **Best sellers at risk** = A products that are Out now, Critical or Order now.
- The reorder list puts A products first within each status.

**Why:** a stock-out on an A product costs the most and is usually the one ads are pushing. 80 / 15 / 5 is the standard ABC split in inventory management.

**Why demand, and why not the selected period:** the rank decides who stays on the reorder list (section 7) and comes first in it, so it has to rest on the same 28 days as the order quantity. Ranked by the selected period, switching 7 → 60 days changed who was a best seller and so the cash to order (demo: order value ₹46.3 lakh at 7 days vs ₹46.8 lakh at 60). Demand rather than ₹ sold, because ₹ sold drops for a product while it's out of stock: a best seller out for three weeks fell to C and out of **Best sellers at risk**, exactly when it was most at risk. For a product in stock the whole time, demand a day is just its ₹ sold ÷ days, so the order is the same as ranking by sales.

*Considered:* ₹ sold over the 28-day window (simpler, but has the stock-out problem above).

**When it can be wrong:** a launch or a heavily discounted product can jump into A while its 28 days are dominated by the launch or the sale. Its rate has the same lag (section 3).

## 7b. Profit lost and margin

**Rule:**

> profit lost = units lost × (average price paid − unit cost)
> margin = (average price paid − unit cost) ÷ average price paid

**Unit cost** comes from Shopify's inventory item cost ("Cost per item", readable with `read_inventory`), or from a `cost` column in a CSV/Flow row. Products without a cost show "–" and aren't counted in profit lost. The Overview's first tile shows profit lost only when at least one product has a cost (otherwise it shows % of demand lost), and says "N/M costed" when only some do: then it's a minimum.

**Why:** ₹ lost in sales overstates what the business lost. What it actually lost is the margin on those sales, and that's the number to weigh against the cost of holding more stock.

## 7c. Excess stock and overstock (cash tied up)

**Rule:**

> needed = sales per day × (lead time + cover + safety days)
> excess pieces = stock now − needed (never below 0)
> excess ₹ = excess pieces × unit cost (× average price paid if cost is unknown)

A product is **Overstocked** when its stock is more than **twice** what's needed, or it has stock but hasn't sold at all. **Cash in overstock** on the Overview adds up, for overstocked products only, the excess ₹ beyond **one times** the need (the cash you could free by selling down to a normal level). The "twice" is only the flag threshold.

**Why:** this is the cost-cutting side of the same maths. Money sitting in stock that won't sell for months could pay for stock that's running out. The usual moves are to stop reordering it, bundle it with a best seller, or discount it. The "twice" margin keeps a product that's only slightly over from being flagged.

**Left out:** inactive variants (archived, draft, untracked, deleted; section 1). A variant that hasn't moved in months still counts: its stock comes from the catalog or its newest stock row, which is never pruned.

**When it can be wrong:** stock bought ahead of a known season or campaign will look overstocked until the demand arrives. A product set to draft while it's being restocked or re-shot drops out of overstock until it's active again.

## 7d. Trend (sparkline and % change)

**Rule:**
- **Bars:** units sold in each of the last 8 rolling 7-day blocks ending now, oldest on the left, scaled to that product's best week. A **rose mark** under a bar means the product was out of stock for part of that week. Hovering a bar gives the dates, units and days out ("13–19 Nov: 54 sold, out 2.3 d"); a block is labelled by the 7 calendar days it ends on, so the last one ends today.
- **Where it shows:** in the decision rows, not only the drawer. On Products and Reorder, screens 1400 px and wider get a Trend cell (bars + % chip); narrower screens get small bars inside the product name cell (no extra column); phone cards show the bars at the right of the card header. The drawer shows the 8 weekly numbers under the bars, with the date each week starts.
- **% change** = sales per **in-stock** day in the last 14 days vs the 14 days before:

  > rate = units sold ÷ days in stock (in that 14-day half)
  > change = (recent rate − earlier rate) ÷ earlier rate

  The chip shows the product's own % change. Its **colour is read against the typical product** (below) **and the product's own sign**: green when it's rising (% > 0) and 10 points or more above the typical product's %, rose when it's falling (% < 0) and 10 or more below, grey otherwise (`trendCall` = up / down / flat). So a fall is never green and a rise never red: −20% when the typical product is −35% is grey, with "Falling, but less than the typical product" in the tooltip (critic UI-1: green −20% next to a red −₹1.87 L in Moving read as growing). With fewer than 5 products to take a median from, it's read against 0. The *Selling faster / slower* filters on Products use the same call. **New** = in stock for at least 7 days of the earlier half with no sales, and 3 or more sold since. **·** = too little to call: under 6 units over the 28 days, or under 3 in-stock days in either half.
- **Only time we have data for counts.** Days before a product's first record are "no data" (an empty bar), never "in stock, sold 0". Without this, a store with 20 days of history showed every product at +133%.
- **Typical-product baseline:** the **median** of all product trends (needs 5 or more). It sets the chip colour, and its value is in each chip's tooltip and the Trend column header's. It's the same measure as the product trend. An earlier version compared raw store units, which store-wide stock-outs dragged down; that made flat products look like they were outperforming.

- **₹ effect (Overview "Moving" card):** what the trend is worth, so the card ranks by money rather than by %:

  > ₹ effect = (recent rate − earlier rate) × average price paid × 30

  i.e. ₹ a month of sales at the new pace, with the rates as above (sales per in-stock day, last 14 days vs the 14 before). It's set only where there's a trend to call (a % or **New**; for New the earlier rate is 0). The card lists the top 3 up and the top 3 down by this number. A +200% on a ₹300 candle matters less than +20% on a ₹40,000 sofa; ranking by ₹ shows that.

**Why it's built this way (and what's wrong with plain week-on-week, as in the DAWBU sheet):**
- **Stock-outs aren't demand.** A product out for half of last week shows −50% week-on-week, though shoppers wanted it as much as ever. Dividing by in-stock days removes that. It's the same principle as section 3.
- **Two weeks against two weeks.** For a product selling a few a week, one week against one week swings wildly (2 → 1 = −50%). Doubling the window halves most of that noise, and the 6-unit minimum hides changes that are just noise.
- **Rolling weeks ending now,** not calendar weeks, so there's never a half-finished current week dragging the last bar down.
- **A ±10-point band,** wider than ±5, so normal week-to-week wobble stays grey.
- **Colour against the typical product, not against 0** (critic round 1). With a ±10% cut-off against 0, after a store-wide fall (typical −38% in the demo) about 70% of Reorder rows were red, which reads as "cut the orders" when most products were only following the season. Now red means "worse than the rest of the store", which is what a manager can act on. *Considered:* showing the gap in points as the chip text (another unit to learn) and a separate "Typical product −38%" chip in the toolbar (the earlier version; nobody read it).
- **The baseline separates season from product.** After a peak like Diwali almost everything falls. A product down 20% while the typical product is down 25% is holding up; one down 50% isn't.

**When it can be wrong:**
- **Promotions in either half** distort it, and so do price changes.
- **Gifting and decor seasons,** where the store baseline helps but doesn't remove the effect entirely.
- **₹ effect** assumes the new pace holds for a month and uses today's average price; read it as a size, not a forecast.

## 8. Restocking patterns

| Flag | Rule | Why it matters |
|---|---|---|
| **Small top-up** | a stock-out ended with a refill smaller than *Small top-up* [7] days of sales | someone added "a few pieces" by hand; the product will be out again within days |
| **Out again within a week** | the next stock-out started less than 7 days after this one ended | the refill was too small, or the reorder came too late |
| **Refilled with** | stock right after the product came back, in pieces and in days of sales | shows how big each restock really was |

These two flags are the habits that turn one stock-out into many. They're counted separately so a brand can see whether it has a supply problem or a restocking-habit problem.

**Website allocations (1.3.0, §6):** an allocation item is topped up to its cap by design, so its refills read as *small top-ups* and *out again* (Sammsara: those 4 rows held 12 of the 19 small top-up flags). The flags are still shown, but its status says *Top-up from warehouse* and the fix is the top-up timing or the cap, not a bigger supplier order.

---

## 9. Products page columns

| Column | Rule |
|---|---|
| Units / Sold / Lost | inside the selected period (7 / 14 / 30 / 60 days) |
| Sells / day, Avg price | over the last 28 days (further back for a long stock-out, section 3), whatever period is selected, so the reorder maths doesn't change when you switch the view |
| % lost | the product's lost ÷ (its sold + its lost) |
| Sales lost markers, Confidence | **estimate** under the ₹ = Low confidence (4 or fewer units behind the rate), **not restocked** = out 30+ days with nothing marked ordered; neither part is in the headline (§4c). *Confidence* (optional): High / Medium / Low; also in the Products CSV and the PO CSV (with *Not restocked 30+ d (₹)*) |
| Outs | stock-outs touching the selected period |
| Returns % | units returned or cancelled (Shopify's refunds; cancelled orders included, as in Shopify's Returns) ÷ units ordered, orders placed in the period; – under 5 units ordered; amber at 15%+ (§9e) |
| Category | the product type from Shopify (or the CSV/Flow `type` column) |
| Trend | weekly bars + % change (section 7d); its own column at 1400 px and wider, small bars in the name cell below that |

Tables are built to fit the screen without sideways scrolling: on laptops narrower than 1400px the lower-priority columns (Units, Outs, Units lost) step aside, and under 1180px Category and the SKU do too. Every column is still in the CSV, and hovering a column header explains it. Column edges can be dragged to resize, like a spreadsheet; widths are remembered in that browser, and double-clicking an edge resets them. **Optional columns are on by default** (show everything, ADR-0006 amendment 20 Nov); Columns… unticks one, remembered on that browser. When they don't all fit, optional columns **step aside**, the right-most first, until the table fits, and a note above it names them ("Not shown at this width: Sells / day, Times out"); a wider screen, or unticking others, brings them back. Only a column someone dragged wider can still make that one table scroll sideways inside its box, with a note ("More columns than fit: scroll the table sideways"); before, columns were cut off out of reach (critic r2 UI-2). The default columns fit every Reorder and Products tab from 1181 px up (tested at 1280 and 1400; Reorder → All keeps Sales lost on screen: its name column gives up ~60 px to Status, critic r2 UI-1), so the page itself never scrolls sideways.

## 9a. Group by: product, category, collection, tag (SW-022)

"View: Products ▾" on the Products page rolls the product rows (one per variant) up into groups. Code: `src/groups.js`, tests: `test/groups.test.js`.

| View | One row per | Key | Each variant is in |
|---|---|---|---|
| Parent products | Shopify product (its variants together) | product ID | exactly one group |
| Categories | Shopify product type (`productType`, or the CSV/Flow `type` column) | the type itself | exactly one group ("No category" if blank) |
| Collections | Shopify collection | collection ID | every collection its product is in ("Not in a collection" if none) |
| Tags | product tag | the tag, case-folded | every tag its product has ("No tag" if none) |

**Keys are IDs, never titles**, so two products or collections with the same name never merge, and a rename doesn't split a group. Category and tag have no ID in Shopify, so the value is the key; tags are case-folded because Shopify treats "Gold" and "gold" as one tag. A variant the catalog doesn't know yet (CSV/Flow data, or a product added since the last pull) is its own parent product, keyed by variant ID.

Each group row adds up its variants' rows, with the same rules as the Products page (section 9):

| Column | Rule |
|---|---|
| Products | variants in the group (the rows a click shows) |
| Need order | variants whose status is Order today (out now, 3 days or less left, or order now), "x of n" |
| Sold, Sales lost, Profit lost | sums over the selected period; Profit lost blank when no variant has a unit cost |
| Order ₹ | order value of the Need-order variants (the same "Order today ₹" as the Overview) |
| Overstock ₹ | cash beyond need, overstocked variants only (section 7c) |
| Trend: bars | the same 8 weekly blocks as a product (section 7d), each the **sum of the variants' units** that week; a week no variant has data for is "no data" (empty bar). **Rose mark** when one or more of the group's variants was out part of that week, as on a product row; the hover says how many ("12–18 Nov: 54 sold, 3 of 12 products out part of the week"). Shown like a product row: in the Trend cell with the % chip (always, the group table has room at 1280), and at the right of the phone card header (hidden at 380 px and below, as on product cards). SW-021, `groups.js` `weeks` |
| Trend: % | the variants' sales per in-stock day added up, last 14 days vs the 14 before (the halves of section 7d), from each variant's weekly blocks. A variant without data in both halves, or with under 3 in-stock days in either, is left out; under 6 units in all: no trend. **Colour** (critic r2 UI-3): the product rule of section 7d, against the same baseline (the typical product's trend, the median of product trends): green only when the group's own % rises and is 10+ points above it, red only when it falls and is 10+ points below; otherwise grey. The tooltip compares with the same typical product |

**Totals.** Parent products and categories add up to the report totals (sales, lost, order ₹, overstock ₹, profit lost; tested). Collections and tags overlap: a product with two tags counts in both rows, so there is **no grand total**: the headline shows only the number of groups ("13 tags"), and a footnote gives the distinct store total (each variant once). "Products" counts variants everywhere (the Products page rows); the parent-product lens says "parent products" for its groups.

**Catch-all collections are hidden by default.** A collection holding 80% or more of the products in the report ("All products", "Home page") tells you nothing and would top every list; a button shows them. Products only in hidden collections fall into "Not in any other collection".

**Why:** the client plans and sets targets by tag and collection (the DAWBU sheet), not by single variant. Summing variants keeps every number identical to the Products page, so a group can be checked by clicking it. **Considered:** recomputing each group as one big product (its own rate, its own stock-out hours); rejected because the group's lost would no longer equal the sum of its products' lost. **Can be wrong:** collection membership is up to 24 hours old (section 9b); tags and categories follow the last stock pull (every 2 hours by default, `SYNC_MINUTES`). The group trend counts a variant's first partial week as fully in stock. The bars' rose mark says "some product was out", so a big group (a category of 50) shows it under most weeks; the hover gives the count. *Considered:* rose only when the average product lost a day or more (hides a best seller's stock-out inside a big group); a share-of-days shade (another thing to learn).

## 9b. Where groups come from (catalog, read-only)

`src/catalog.js`:
- **Variant → product, category, tags:** from the store's catalog snapshot (SW-002, `store.json` → `catalog`, replaced by every stock pull; `STOCK_Q` reads `product { id tags productType }`). One source: the same snapshot gives the engine its stock now, so a group can't disagree with the rows it holds. A deleted variant keeps its last product and tags.
- **Same numbers as the report:** `/api/groups` runs the report with exactly the options `/api/report` uses (period, trial values, catalog snapshot, Mark ordered), so a parent-product or category total equals the report total; a product marked ordered leaves *Need order* as it leaves *Order today*.
- **Collections and their products** (kept in `DATA_DIR/catalog.json`): read once a day (24 h cache) with two read-only queries, `collections` and `collection.products`, through the same read-only guard as every Shopify call. Progress is saved after every page, so a restart carries on where it stopped instead of starting again; at most 400 pages per pull, the rest with the next pull. Smart and manual collections are read the same way (Shopify returns the current members of both).
- Needs only `read_products`, which the app already has.
- Demo data gets product IDs, tags and collections derived from the Sammsara catalog's product types and names (section 10).

## 9c. Targets on groups, stock-aware (SW-042, `src/targets.js`, `public/targets.js`)

Products → View: Categories / Collections / Tags / Parent products shows a **Target this month** column (a line on phone cards). Admin sets a monthly sales target (₹) per group in the cell (**Set target** / **Edit**); the same target counts every month until changed or removed. View-only sees it, can't change it.

| Number | Rule |
|---|---|
| Sold so far | the group's *Sold* (§5) from the 1st of this month, store time, until now: the This month period on the saved settings (trial values don't move it), whatever period the page shows |
| Lost so far | the group's *Sales lost* (§4) over the same window |
| Days gone | (now − the 1st 00:00) ÷ 24 h, at least 1 (the first hours of a month would otherwise multiply a few sales by 30) |
| Forecast (→) | sold so far + sold so far ÷ days gone × days left in the month: where the month ends at this pace, stock-outs and all |
| Forecast with nothing out | (sold + lost) so far + (sold + lost) ÷ days gone × days left: the same pace if no product had been out of stock |
| Gap | max(0, target − forecast) |
| "₹X is stock-outs" | min(gap, forecast with nothing out − forecast): the part of the shortfall that stock-outs explain; the rest is demand |
| Light | **green** forecast ≥ target · **amber** forecast ≥ 90% of target (within 10%) · **red** below 90% |

- Example: target ₹1,00,000, day 10 of 30, sold ₹30,000, lost ₹10,000 → forecast ₹90,000 (amber), with nothing out ₹1,20,000, gap ₹10,000, all of it stock-outs.
- Collections and tags overlap (a product in two counts in both), so each group's target stands alone; targets don't add up to a store target.
- A target stays when its group has no sales this month (₹0 so far, red). Clear and a demo load keep targets (they are settings, not data).
- When it can be wrong: a straight-line pace ignores weekends, festivals and payday peaks; early in the month one big day swings the forecast.

## 9d. Paste a list, saved lists (SW-044, `public/lists.js`, `src/lists.js`)

- **Paste a list** into the Products search box: SKUs, product names or variant IDs, one per line, or separated by commas, tabs or semicolons (a spreadsheet column pastes as is; line breaks become ", " in the box). Any of those separators turns the box from a search into a list.
- **Matching**, per entry, any case: SKU, variant ID or full product name (`Product · Variant`) exactly; when nothing matches exactly and the entry has 3 characters or more, every product whose name or SKU contains it. Repeats and blanks are dropped.
- The table shows the products found (the tabs, group filter and columns still apply; totals, CSV and the headline follow the list). A bar says `List: N of M found` and names each entry not found (first 6, all in the tooltip).
- **Saved lists**: admin names and saves the list for the whole team (same name, any case, replaces it); everyone picks it from **Saved lists** beside the search box; admin can delete. Per store, at most 100 lists of 2,000 entries.
- Why: buyers and marketing work from lists (a supplier's SKUs, a campaign's products, the Diwali range) kept in sheets; pasting them answers "how are these doing" in one step.

## 9e. Cancel/refund % per product (SW-064, 1.1.3, 1.1.5, `src/engine.js` `returnsOf`, `src/shopify.js` `reversalEvents`)

**Name on the page (1.1.4): "Cancel/refund %".** It measures reversals (cancellations, refunds, order edits that remove items with a refund), not physical returns alone, so it isn't called "Returns".

**Rule (1.1.5, Shopify's own definition):** per product and for the store, over the period's calendar days (§5a):
- **units ordered** = Σ `ordered` (Shopify's line `quantity`) of orders **placed** in the period, cancelled orders included = Shopify's `quantity_ordered`
- **units reversed** = Σ the units of **reversal events dated in the period**, whenever the order was placed = Shopify's `quantity_returned`; of those, **cancelled** = events of kind `cancel`
- **Cancel/refund % = reversed ÷ ordered**, one decimal; **–** under 5 units ordered. It can pass 100% when old orders are cancelled in a quiet period (Shopify's report does the same)
- **₹ reversed** (`refundValue`) = Σ the events' ₹, ex GST = Shopify's *Returns*
- **High cancels/refunds** (chip, amber): 15%+. `totals` carry `unitsOrdered`, `unitsReturned`, `unitsCancelled`, `returnPct`, `refundValue`, `highReturns`, and `shopifyNet` (the check line, §What counts as a sale).

**Reversal events** (`src/shopify.js` `reversalEvents`, stored per store in `store.json` `reversals`, FORMATS.md):
- one per **refund line**: date = the refund's `createdAt`, units = its `quantity` (any restock type), ₹ = its subtotal after discounts, less its tax when the order's prices include tax (ex GST, like stored prices);
- for a **cancelled order**, one per line for the units no refund line covers: date = `cancelledAt`, ₹ = units × the line's price paid ex GST (an unpaid COD order has no refund lines);
- a refund made **after** the order was cancelled moves money only and adds nothing: the cancellation already reversed every unit. Sammsara #92029: cancelled 29 Aug without a refund, refunded on 17 Nov in a bulk run; Shopify books its return on 29 Aug only (before this rule the app counted one Chess unit too many in 7 and 30 days);
- kind `cancel` when the order is cancelled or the restock type is `CANCEL` (removed before shipping), else `refund`.
- **Orders placed before the 60 days:** the first read (and the one-time re-read) also asks for orders **updated** in the 60 days (`created_at >= X OR updated_at >= X`; the token has `read_all_orders`): their events are kept, never their lines (they'd be sales outside the window and move the rate's start). Sammsara: 375 such orders, e.g. 52 orders of 1–20 Sep bulk-cancelled on 30 Sep. Later pulls read every changed order, old ones included, as before.
- **No double counting:** every read of an order replaces its events whole (a refund edited or removed in Shopify goes too), one event per id (refund line ID, or `c` + line ID), older than 120 days dropped with the order lines.

Shown: Products column **Cancel/refund %** (optional, on by default; only when some line carries `ordered`), chip **High cancels/refunds**, drawer "Cancelled or refunded: 10.8% (17 of 158 ordered, 15 cancelled) · ₹58.4 K back", phone cards at 15%+.

**Checked against Shopify (1.1.5, Sammsara, 20 Nov 2026, explicit dates, ShopifyQL `FROM sales SHOW quantity_ordered, quantity_returned, returns, net_sales GROUP BY product_variant_id SINCE <date> UNTIL 2026-11-20`; our numbers from the real `pullOrders` run read-only against the store, then `engine.report` with the period from `period.range`):**

| Period (IST) | Units ordered app / Shopify | Reversed app / Shopify | % app / Shopify | ₹ reversed app / Shopify |
|---|---|---|---|---|
| 7 d, 14 – 20 Nov | 409 / 409 | 33 / 33 | 8.1% / 8.1% | ₹1,39,556 / ₹1,39,556 |
| 30 d, 22 Oct – 20 Nov | 2,186 / 2,186 | 102 / 102 | 4.7% / 4.7% | ₹4,03,072 / ₹4,03,072 |
| 60 d, 22 Sep – 20 Nov | 4,461 / 4,459 | 259 / 259 | 5.8% / 5.8% | ₹10,13,449 / ₹10,13,449 |

Per product: 30 days, all 137 variants identical (ordered, reversed, ₹ to the rupee), 28 of them with reversals: Cascade 8 of 149 = 5.4%, Casablanca 15 of 132 = 11.4%, Evelyn Flamingo 17 of 158 = 10.8% (1.1.4 by order date: 4.7%, 11.3%, 10.1%). 7 days: all 73 identical. 60 days: 175 of 176 identical; the one left is below. The store's ₹ reversed is rounded once from the events' paise (per-product rupees summed were ₹1–2 off).

**The one residual difference (60 days, Meridian Gold Decorative Globe, ordered 8 vs Shopify 6):** order #92916 was placed on 22 Sep for 1 unit and **edited on 23 Sep to 3**. Shopify books the 2 added units as gross sales on the edit day (₹5,569) with `quantity_ordered` 0; the line we read only says quantity 3. Net sales agree (both days are in the period); only the units ordered differ, by the units added through order edits. No product with reversals is affected, and in Sammsara's 60 days no order edit removed units without a refund. Reading Shopify's sales agreements per edited order would close it (extra query cost); not worth it for 2 units in 4,459 (BACKLOG).

**Why by reversal date (1.1.5, was order date in 1.1.3–1.1.4):** the owner compares this number with Shopify, and Shopify counts a cancellation or refund on the day it happens. By order date 3 of 12 products differed (Cascade 4.7% vs 5.4%) and a period starting after a bulk cancellation read low. *Trade-off:* a quiet period after a bulk cancellation of older orders shows a high % (it did happen in those days). *Considered:* keeping order date (answers "of what we sold, how much came back", but never matches Shopify); both numbers (one is enough; the % column stays simple).

**Without events** (Flow / Sheet / CSV, or a Shopify store until the 1.1.5 re-read ends): reversals come from the lines' own `returned`, by order date (1.1.3 rule); Flow / Sheet / CSV lines carry no `ordered`, so no % is shown.

**Demand and ₹ sold:** ₹ sold and units sold count units kept; the sales rate counts kept + returned after the sale, never cancelled (§What counts as a sale, "Demand counts units ordered").

**Upgrade:** a store read by 1.1.3 / 1.1.4 (`shopify.orderFields: 'refunds'`) reads its 60 days once more on the next pull (`'reversals'`), events starting afresh; the same mechanism as the 1.1.1 GST re-read. Later cancellations and refunds change the order's `updated_at`, so the next incremental pull re-reads the order and replaces its lines and events.

**Can be wrong:**
- An order edit that removes an item without a refund is not a reversal here (units kept go down; it is in neither column); none in Sammsara's 60 days. Units **added** by an edit count as ordered on the order's day (Shopify: ₹ on the edit day, not in `quantity_ordered`; above).
- An exchange shows as a return of one variant and, if Shopify makes a new order or line for the replacement, a sale of the other.
- A free gift line (Mystery Gift, ₹0) counts in units (Shopify does the same: 46 of its 259) but adds ₹0.
- Flow / Sheet / CSV rows carry no `ordered`: no return % for those stores.

---

## 10. Demo data (not real)

`src/demo.js` builds 60 days for a home-décor store on **Sammsara's public product list** (names, variants, prices from `sammsara.com/products.json`, saved in `src/demo-catalog.json`). **Every stock level, order and stock-out is invented.** The page shows "Demo data" whenever it's on. **Demo and real data never mix:** the first real row (Shopify, Flow, Sheet or CSV) deletes the demo before it's stored, together with everything done on it: "Mark ordered" records (section 6b) and slow-seller decisions (section 15d), so a demo purchase order never lowers a real order quantity and a demo "drop" never hides a real product (SW-007; one function, `store.endDemo()`, for every path). The CSV upload has no "remove the demo first" choice: it always does, and once a store has held real data the demo is never loaded again at start-up, not even after **Clear all data** or a new demo version (`everLive` in `store.json`). Loading it by hand from the Data page still works while Shopify isn't connected.

How it's generated, so the patterns look like a real store:
- **Popularity:** each product gets a demand rank. A few sell 5–10 a day; most sell under 1. Cheaper items sell more.
- **Time of day and week:** orders follow an evening-heavy day, and weekends are 15% busier.
- **Season:** gifting categories rise in the 18 days before Diwali (8 Nov 2026), peak around it, then dip for a week.
- **Baskets:** about 25% of orders include a second item.
- **Restocking habits** are assigned per product: proper restocks, late restocks, "a few pieces by hand" top-ups, overstocked slow movers, and a few never restocked.
- **Small extras:** damage write-offs and returns at a low rate.
- **Order returns (SW-064):** every line carries `ordered`; about 2.5% of décor lines and 7% of furniture lines had a unit sent back, and three well-selling products a lot (25–80% of lines), so Returns % and High returns show. Sales are unchanged (ordered = qty + 1 on a returned line); its own random stream (demo VERSION sammsara-8).
- **Tags and collections (for Group by):** variants of one product share a product ID; tags say furniture or décor, finish (Gold, Brass, Marble, Glass…), motif (Animal motif, Floral), Diwali gifting and price band (Under 3000, Premium); ten collections are built on those, including an "All products" catch-all. Derived from the catalog's product types and names, not Sammsara's real tags.
- **Fixed seed:** the same seed gives the same demo every time.
- **Two demo stores** (no Shopify key, ADR-0015): **Sammsara (demo)** (seed 11, the full catalog) and **Second store (demo)** (seed 29, every third product left out, prices × 0.6, order numbers from #39001). Same rules; different numbers, so a mix-up between stores would show at once.

The demo exists to show the screens with realistic shape. Its numbers say nothing about Sammsara's real business.

---

## 11. Known limits, in one place

**Whatever the source:**
- ₹ lost is an estimate of demand, and an upper bound where substitutes exist (section 4). Products whose rate rests on 4 or fewer units, and stock-outs open 30+ days with nothing ordered, are kept out of the headline and shown apart (§4c); a slow, pricey product's real losses can sit in that estimate.
- One lead time for all products; no supplier minimums or case packs (section 6).
- "Mark ordered" spots arrivals from stock increases, so returns after the mark count as received; one open order per variant (section 6b).
- Profit lost and excess at cost need a unit cost per product; without one they fall back to selling price or are left out (sections 7b, 7c).
- The rate follows the last 28 days, so it lags a sudden season or campaign (section 3). After a long stock-out it uses older sales, which over-orders if demand fell meanwhile.
- One time zone per store (§0a); a store selling across zones still sees its own clock only.
- Group by: collection membership can be up to 24 hours old; tag and collection rows overlap, so they have no grand total (section 9a).
- Stock before the first Shopify read is rebuilt from Shopify's change log, to the hour, 60 days back; variants whose log doesn't add up are left out (§1c).
- The brand report (§20–§22) works on whole store days: a day is in stock, out, or half (it ran out or came back that day); only products on sale now are counted, so a best seller archived during the year drops out of earlier months.

**By source** (what counts as a sale is in section 1):

| | Shopify pull | Flow / Google Sheet / CSV |
|---|---|---|
| Stock-out timing | Shopify pull every 2 hours by default (`SYNC_MINUTES`), hours from the change log; a stock-out that starts and ends between two reads is missed | to the minute (Flow), or as precise as the file |
| Cancellations, refunds, removed items | netted: cancelled orders never a sale, units kept = `currentQuantity` less refunded units (1.1.3), later edits re-read | **not netted**: counted as sent; a later cancellation or refund isn't picked up |
| Discounts | price after line and order-level discounts | as sent |
| Test orders | left out | counted unless the Flow condition excludes them |

## 12. Differences in the Google Sheet version

`modules/stock-watch-sheets/StockWatch.gs` uses the same rules, settings and thresholds. Every difference is listed in one place, [`../stock-watch-sheets/LOGIC.md`](../stock-watch-sheets/LOGIC.md), so this section doesn't repeat them. One more (1.2.0): the Sheet has no confidence split (§4c), so its ₹ lost total matches the web app's `lostAll`, not the headline. `test/parity.test.js` runs the same fixtures through both and fails `npm test` on any difference that isn't on that list (same status and order quantity, ₹ lost within 2%).

## 13. Who can change what (view-only sign-in, settings change log)

Code: `src/access.js`, `src/audit.js` (SW-029, ADR-0011). Tests: `test/access.test.js`.

**Rule.**
- Two shared passwords. `ADMIN_PASSWORD` signs in as **admin** (sees and changes everything). `VIEW_PASSWORD` (optional) signs in as **view**: every number, page and CSV export is the same, but nothing can be changed.
- The server decides, not the page: any `POST`, `PUT`, `PATCH` or `DELETE` to `/api/…` from a view session (cookie or Basic auth) is refused with **403** before any route runs. That covers settings, Plan settings "Save as default", imports, sheet sync, Shopify "Pull now", demo, clear, "Mark ordered" (`/api/onorder`), and any write route added later. `GET /api/export/backup.json` (the whole store, ingest key and change log included) is admin-only too.
- A view session never receives the Flow ingest key (it would let them write through `/ingest`): not in `/api/settings`, and the `settings` echoed in `/api/report` and `/api/product/…` never carry it for any role. View sessions get an empty change log (it holds old and new sheet links; the log is on the Data page, which they don't have).
- The page hides what a viewer can't use (ADR-0006: role views only remove): no Data page, no "Save as default", no Mark-ordered ticks, bulk bar or drawer order form (the drawer still shows what is on order). Trying values in Plan settings still works (it changes nothing stored); Reset is kept.
- The role is inside the signed session cookie, with a fingerprint of `VIEW_PASSWORD`: a view cookie can't be edited into admin, and changing or removing `VIEW_PASSWORD` signs all view sessions out. Admin cookies keep their old form, so existing sign-ins stay valid.
- The server refuses to start when `VIEW_PASSWORD` is set without `ADMIN_PASSWORD` (nobody would need to sign in) or equals it.
- **Change log:** every settings save writes one entry per setting whose value actually changed: `{ at, by, key, old, new }`. Morning digest settings (section 17) go to the same log: `digest.hour`, `digest.roles` (the ticked roles, "founder, ops"), `digest.paused`; and `digest.webhook` when the webhook set on the server changes (hosts only, never the URL, by "server (env)", noticed on the next digest call or scheduler minute; the first look only records it). `by` is the role (`admin`), with "(script)" when the change came with Basic auth instead of a sign-in. Numbers are compared as numbers (14 and "14" are the same). The ingest key is never logged: it shows as "(old key) → (new key)". Newest first, last 200 kept in `store.json` (`settingsLog`).
- **Shown:** the latest change to lead time, stock should last or buffer under Plan settings ("Last changed … by … · old → new"), for every role; the last 50 changes under Data → Settings → "Advanced: change log" (admin only; view sessions get `changes: []`).

**Why.** RACI: CEO and finance view, they don't change assumptions or data. A page that only hides buttons can be bypassed with one `curl`, so the check sits on the server. The log answers "who changed cover days and when" when a reorder number moves.

**Considered.** Named users (needs a user store or Performity SSO, later ADR). Per-route checks (easy to forget on a new route; one gate before every write is safer).

**Limits.** Two shared passwords, so "who" is a role, not a person. The log covers settings only, not data actions (import, clear). Wrong-password limits are shared by both passwords. A viewer sees the "Sync issue" pill without its link (no Data page), so the error text is only its hover tooltip, which phones don't show.

## 14. Sync progress and run history

Code: `src/runs.js`, counts from `syncShopify` / `syncSheet` in `server.js` (SW-030). Tests: `test/runs.test.js`.

**Rule.**
- A **run** is one Shopify pull (every 2 hours by default, `SYNC_MINUTES`, or "Pull from Shopify now") or one Google Sheet sync. Skipped syncs (nothing set up) are not runs.
- **While a Shopify pull runs**, the top-right pill reads "Syncing · stock" while stock is read, then "Syncing · 2,340 orders": the number of orders read so far in this pull (each page of 40 adds to it). The page asks again every 3 seconds until the pull ends, then reloads every number once. On a phone the pill is a dot; the same text is its tooltip and shows in the Data status card.
- **When a run ends** (finished or failed), one line is kept: start time, how long it took, stock changes stored, order lines read, orders read (Shopify), the error if it failed, and notes. A failed run keeps what it had counted before the error.
- **Notes** name what the stock pull leaves out on purpose: variants of archived or draft products, and variants whose stock isn't tracked (the stock pull reads only active products with tracked stock: `diffStock` in `src/shopify.js`). The numbers come from the same filter, so they can't drift from it.
- The last **20** runs are kept in `store.json` (`syncRuns`), newest first, and are not wiped by "Clear all data". Shown on Data, inside the status card, folded: "Last 20 syncs · latest 19 Nov 16:00, 8 s, OK".

**Why.** "Is it stuck or still loading?" on a first 60-day pull, and "when did it last fail, and why?" without reading server logs.

**Considered.** A percentage bar: Shopify doesn't say how many orders are left, so any % would be a guess. Logging every page: too much; one line per run is enough to spot a pattern.

**Limits.** Order lines "read" count lines re-read when an order changed (refunds, edits) as well as new ones. Progress lives in memory: after a restart mid-pull the pill shows nothing until the next pull starts.

## 14a. Capacity warnings and the data folder lock (SW-055, `src/capacity.js`, `src/lock.js`)

**Rule.** A warning shows on Data (this store) and in `/status` `warnings` (every store) when:
- `store.json` is over **25 MB**, or
- a store keeps over **1,50,000 rows** (stock changes + order lines), or
- the data volume is over **80% full**.

The first two are half of ADR-0003's move trigger (50 MB, 300k rows), so there is time to plan the storage move before pages slow down. Warnings never turn `/status` red: they are notice, not an outage.

**One copy writes.** The copy of the app that holds `DATA_DIR/instance.lock` writes; it refreshes the lock every 30 s. Another copy on the same folder only reads: every write gets **503** with the reason, Data shows it, `/status` `writing: false`, and it starts no pulls, backups or digests. It takes over when the lock is removed (a clean stop) or has had no heartbeat for **2 minutes**.

**Why.** Two copies writing one JSON file lose each other's changes (ADR-0012). **Considered:** refusing to start (a redeploy where the old copy hangs would crash-loop); OS file locks (not on every volume type). **Can be wrong:** a copy frozen for over 2 minutes that wakes up writes once more before it sees the takeover.

## 15. Decision helpers (Sprint 2: SW-024, SW-025, SW-026, SW-032)

All in `src/helpers.js` (pure functions, tested in `test/helpers.test.js`). They add fields to the report; none of them changes a number from sections 1–7. Dates are in the store's time zone (setting *Time zone*).

### 15a. Why cell, order-by date, still-out cost per day (SW-024)

One plain sentence per row, the same text in the Reorder table, the phone card and the product drawer (and for the morning digest, SW-028, via `helpers.why()`):

| Row | Sentence | Rule |
|---|---|---|
| Out of stock | "Out 3 d · lost ₹18.7k this stock-out" | time since the open stock-out began (hours under a day, else days, rounded); out at the product's first stock record → "Out since before 21 Sep" (§2); ₹ lost = this stock-out's ₹ lost inside the selected period (section 4), not the row's whole-period Sales lost (hence "this stock-out"). No open stock-out found → just "Out" (the Sales lost column already has the period's ₹) |
| Has stock and sells | "Runs out Fri 22 Nov · order by today · supplier takes 7 d" | **runs out** = now + days left; **order by** = runs out − (lead time + buffer) days, then set by the status: *Order today* rows → today; any other row → tomorrow (store time) at the earliest; "supplier takes" = lead time. The Reorder **table** leaves the "· supplier takes N d" tail to the cell's tooltip (it's the same on most rows and in Plan settings), and caps the cell at 260 px up to 1440 px wide, so *In stock* stays on screen on a laptop (final critic UI-3) |
| Out 30+ days, nothing ordered (1.2.0) | "Out 30+ days, not restocked: restock or drop?" | the open stock-out has run past day 30 (or the store's longer cutoff, §4c) and no PO is marked; its ₹ after day 30 is not in the headline. Mark ordered puts it back |
| Weekly evidence (1.3.0) | "… · sold in 10 of 25 weeks" | added to an out-of-stock row's sentence when confidence comes from Shopify's weekly sales (§4c) |
| Out since before our data, sold in 26 w (1.3.0) | "Out since before 21 Sep · sold 19 in 26 w: restock or drop?" | the floor-rate rows (§3) |
| Website allocation (1.3.0) | "Shopify shows a website allocation (~7 pcs, refilled from the warehouse). Warehouse stock isn't in Shopify, so we can't size a reorder: check the warehouse." | §6 |
| Lead time not set per supplier (1.3.0) | "… · supplier takes 7 d (assumed)" | the store's default lead time; a supplier's own lead time (§6c) drops "(assumed)" |
| Marked ordered (SW-012) | "Ordered · lands 25 Nov" | the order's ETA |
| No sales in the window | "No sales lately" | no rate, so no date |
| More than a year of stock | "Over a year of stock" | a date that far out means nothing |

**Why order by = runs out − (lead + buffer):** that is the day the status turns *Order now* (section 6). The status decides the edge cases so the date and the status always agree: *Out now*/*Critical*/*Order now* rows say "order by today" (a Critical row with a short lead time too); every other row says tomorrow or later. Example: 10.04 days left, lead + buffer 10 → still *Order this week*, and the raw date (in an hour) is today; it shows tomorrow, and the row moves to *Order today* when the status turns *Order now* later today. Ordering then uses up to a day of the buffer.

**Status column:** on the Reorder tabs *Order today* and *This week* every row has the same status, so the column is replaced by the Why cell. *All* keeps both.

**Still-out cost per day** (Stock-outs headline, every screen size: "17 still out, costing ₹16,599/day", with "N products ran out M times · ₹ sales lost · ₹ profit lost" under it; final r2 SIMP-B: desktop used to put all five numbers in one line) = Σ over products at 0 stock of sales per day × average price paid, **counted the way the headline is** (1.3.0, L3): High and Medium rows only, without rows past day 30 not restocked, allocation items and floor-rate rows; those are summed apart (`stillOutPerDayApart`) and shown as "+₹Y/day not counted (estimates, not restocked, allocations)". It is the sales rate each counted empty shelf is missing right now; tomorrow's headline ₹ lost grows by about this much if nothing is refilled. *Why:* on Sammsara ₹10,141 (49%) of the old ₹20,584/day came from rows the headline leaves out.

**When it can be wrong:** dates assume the rate holds (section 3); one lead time for the store (section 6); a product out for the whole demand window has rate 0 (section 3) and adds nothing to the per-day cost.

### 15b. Reorder CSV as a purchase order (SW-025)

`GET /api/export/reorder.csv?filter=today|week|ordered|all&q=…` gives the same rows the Reorder tab shows (tab + search on name and SKU), grouped by vendor A–Z (unknown vendor last), otherwise in page order. Columns: Vendor, Product, SKU, Variant ID, Order qty, Unit cost, Order value, Status (the page's labels: Order today / This week / Ordered), Why, Order by (date), Stock now, Sells per day, Days left, Sales lost (₹). The file name date is the store's date.

- **Vendor** = the product's supplier (§6c: SKU map, else Shopify `product.vendor`). `?supplier=<name>` = one supplier's lines to order; `?budget=<₹>` = only the rows above the cut line (§6d). Shopify vendor is read with the stock pull (newest stock row that has one; the catalog's when there is one). Blank for CSV, Sheet and Flow (demo data has invented vendors). Like type and cost, it updates when the variant's stock next changes (until the catalog snapshot, SW-002, is in).
- **Unit cost** is blank when unknown; Order value then uses the average price paid (section 6), so check those lines.
- Text cells starting with `= + - @`, tab or CR get a leading `'` so a spreadsheet never runs them.

### 15c. Pause / Push lists for marketing (SW-026)

Two chips on Products, each with a count line, **Copy SKUs** (one per line; variant ID when there's no SKU) and **CSV**:

| List | Rule | Order | Count line |
|---|---|---|---|
| **Pause promotion** | stock ≤ 0, or days left < lead time (it can't be refilled before it runs out) | out now first, then fewest days left, then most ₹ a day | "42 to reorder · 14 slow": on the list with an order quantity / slow sellers |
| **Push these** | overstocked (section 7c) | most ₹ stuck first | "₹2.60 L stuck" |

Archived/untracked and no-stock-data rows are on neither. **Back in stock** on the Pause list = the marked order's ETA (SW-012), "Late · was due …" past it, a slow seller with no order quantity "Slow seller · not reordered" (it is off the reorder list, section 7, so an earliest date means nothing), else "Not ordered · earliest <today + lead time>". Push replaces the old *Overstock* chip (same products) and is the only overstock list: the Overview's overstock tile opens it, and More… no longer has an *Overstock* duplicate (critic r2 S1; an old `over` filter opens Push these).

**Headline leads with the decision** (critic r2 M1, ADR-0006): on Pause promotion the page title is "Pause promotion on N products", on Push these "Push N overstocked products" (N = the rows shown); other filters keep "Products". Pause promotion cards on the phone show **Back in stock** in the badge place, not the reorder status (the buyer's decision, not marketing's).

**Why days left < lead time (not ≤ lead + buffer):** promotion spend should stop only when the shelf will empty before any new stock can land; the buffer is for ordering, not for ads.

### 15d. Slow-seller "Decide" bucket (SW-032)

Products → More… → *Slow sellers to decide*: every **Slow seller** (section 7) with stock data, biggest ₹ first. It is the only slow-seller filter (critic r2 S1: a separate *Slow sellers* option listed the same rows without the Decide column); its count leaves out decided items, which are listed under the table.

| Case | Shows | ₹ |
|---|---|---|
| slow + out of stock | "Don't reorder? ₹X lost" (just "Don't reorder?" when ₹X is 0) | ₹ lost in the period |
| slow + has stock | "Clear ₹X at cost" | stock × unit cost (price when no cost) |

One click stores **Keep**, **Drop** or **Clear** (out-of-stock rows: Keep / Drop) in `DATA_DIR/decisions.json` with the product's sales per day at that moment (`base`, taken from the server's report, not the page). The item is hidden until **|rate now − base| > 50% × max(base, 0.1/day)**; then it comes back showing the earlier decision. The 0.1/day floor stops one stray sale on a product that sold nothing from bringing it back (it needs about 2 sales in 4 weeks). Decided items are listed under the table with **Undo**. `decisions.json` is kept and backed up like `onorder.json` (§6b). Decisions don't change any number or status; Clear all data, loading demo data and replacing demo data with an import wipe them (they belong to the data they were made on).

**Saved settings only:** the base and the hide check both use the sales rate on the **saved** settings. Trial values (the what-if fields, e.g. a different *Sales history to use* window) change the report but never hide or bring back a decided item.

**When it can be wrong:** saving a different *Sales history to use* window moves rates and can bring items back.

## 16. Role home views (SW-020, `public/roles.js`)

**Roles are switched off in the UI** (20 Nov 2026, at the user's request: "remove roles, just keep it brand switch"). The store pill only switches brands (with one brand it is the plain name and doesn't open); there is no role menu and no *Show me* field, and everyone sees everything. A role remembered in this browser (`sw-role`) is cleared and an old `/?role=` link is ignored and dropped from the address bar. The code is kept (`public/roles.js` pure functions, `test/roles.test.js`) in case roles come back; the rest of this section describes them as they were.

No number changes with a role: a role view only **removes** parts of today's default screen (ADR-0006) and picks the page you land on. No role chosen = **All** (the default): every page, every panel, every column. Reorder opens on its **All** tab unless a role lands elsewhere; there its headline states the scope, "Order ₹X today across N products · ₹Z more this week (M)", so the list, the CSV and *Tick all* add up to the headline (₹X + ₹Z = the whole list's order cost; final critic SIMP-2). The *Order today* tab's headline is today only.

| Role | Lands on | Removed (everything else stays) |
|---|---|---|
| CEO | Overview (2 tiles + daily chart) | Reorder in the menu; "Order ₹X today" in the headline (it leads with sales lost); tiles "more to order this week" and "best sellers at risk"; both lists; Mark ordered (ticks, bulk bar, drawer form) and the Ordered tab |
| Founder / COO | Overview | daily chart |
| Ops / inventory | Reorder → Order today | Stock-outs in the menu; the "each order covers…" line; daily chart |
| Buyer | Reorder → Order today | Overview and Stock-outs in the menu; plan settings; explainer; Sales lost column; Pause / Push chips |
| Marketing | Products → Pause promotion (§15c: out, or runs out before a reorder could land: don't promote) | Reorder and Stock-outs in the menu; "Order ₹X today" in the Overview headline; "more to order this week" tile, Order today list; Order column; Mark ordered and the Ordered tab |
| Finance | Overview | Stock-outs in the menu; tiles "profit lost" and "best sellers at risk"; Biggest losses list; daily chart; Mark ordered; Pause chip |
| Warehouse | Reorder → Ordered (SW-012: every open order, late first; headline "N on order · M due this week · K late", §6b) | Overview, Stock-outs, Products in the menu; period picker; plan settings; explainer; Order cost and Sales lost columns; Mark ordered |

- Chosen from the store menu (top left; on phones the store bar under the top bar, which also shows the role: final critic M1, a view-only sign-in has no Data page), **Show me** on Data & settings, or a link `/?role=ceo` (`?role=all` = All, the default). Remembered per browser.
- **Landing:** a role opens on its home page and tab when the address has no `#page` or has `#<its home>` (digest links: `/?role=marketing#products` → Products → Pause promotion). Any other `#page` opens as asked. `landing()` in `public/roles.js`, tested.
- **Mark ordered** (SW-012) follows RACI "Place the PO": founder (A), buyer (R) and ops (C, "also sees Mark ordered") keep the ticks, bulk bar and drawer form; the others lose them (the drawer still shows what is on order). The Ordered tab shows whenever it is the open tab, even with nothing ordered, so the warehouse never lands on a missing tab. Pause / Push chips go for roles that are "–" on ads (buyer, finance: Pause; warehouse has no Products page).
- RACI "the A's number first": a role that drops the "more to order this week" tile also drops "Order ₹X today" from the Overview headline, so it starts with "₹Y sales lost".
- Data & settings is never removed: it holds the switch back. Removing a page from the menu doesn't lock it (view-only access is SW-029).
- Why: each role has one decision (docs/RACI.md); the rest is noise for that person. Considered: per-role pages. Rejected: they'd add screens for everyone and drift from the default.
- Checked: `test/roles.test.js` (every role removes something on its home page, never Data); `test/smoke/roles-smoke.js` counted visible pieces per role (deleted with roles off, 20 Nov 2026; `test/ui-stores.test.js` checks an old `?role=` link shows everything).

## 17. Morning digest (SW-028, `src/digest.js`, `src/digest-service.js`)

A few plain-language lines per role and per store, with a link that opens that store and role's view (`/?store=<id>&role=ops#reorder`). The title names the store (`Stock-out Watch · <store> · 20 Nov`); each store has its own hour, roles, pause and send log, and stores are checked one after the other. At most 6 lines including the title; the link comes after. Same rules and numbers as the page: order today, overstock and best sellers come from the default 30-day report; "yesterday" is §5a.

| Role | When | Lines |
|---|---|---|
| CEO | Mondays | sales lost last 7 days (₹, % of demand) **vs the 7 days before**; profit lost; cash in overstock; best sellers at risk |
| Founder / COO (and "Everyone") | daily | order today ₹ and products; still out + cost per day; yesterday; overstock; this week vs last week (§5b, when 2 weeks of snapshots exist) |
| Ops / inventory | daily | order today lines + ₹; top 3 lines (qty, days left); yesterday ran out / back |
| Marketing | daily | pause promotion count + top 3; push (overstock ₹) + top 3 |
| Finance | Mondays | cash to order today + more due this week; overstock; sales lost last 7 days |
| Buyer, Warehouse | not pushed (RACI "–") | buyer: order today; top 3 by order cost. Warehouse: what lands, not what to order (critic SIMP-1): "On order: N lines, X pcs to come · M due this week · K late", then the first 3 of the Ordered tab (late first) with pieces and date. Available from Share and `GET /api/digest?role=` |

- **Still out, cost per day** = the Stock-outs headline number (§15a): Σ over products at 0 stock: in-stock rate (§3) × average price paid. What a day of the current stock-outs costs in sales, at today's rates.
- **Pause promotion** (marketing) = the Products → Pause promotion list (§15c, same code: `helpers.mktList` / `mktSort`): out of stock, or fewer days left than the lead time (a reorder placed today can't land in time); out now first, then fewest days left. Integration change: the branch had its own rule (sellers only, biggest ₹ sold first), so the digest count could differ from the chip. **Push these** = overstocked products (§7c), most ₹ stuck first.
- **Vs the 7 days before** (CEO): the same 7-day report worked out from the rows as they stood 7 days ago (nothing recorded after then), so it shows what the page showed that day. Of today's catalog it gets only the inactive flags of variants already inactive by then (`period.catalogAsOf`: status and since when, no stock or price; an inactive spell that ended by then is passed as a spell, one still running then as inactive since its start): a variant archived while out of stock gets no more rows from Shopify, so without the flag its stock-out would run on and the week before would count sales the page never showed (critic r2 L1).
- **More due this week** (finance) = order value of everything on the reorder list − order value for today.
- **When it's sent:** every minute the server checks: not paused, the role has a webhook URL, it is less than 3 hours after the set hour [9] in store time (a restart doesn't lose the morning's send; wraps past midnight, so 23:00 is caught up until 02:00 and counts for the day it was set for), and the role hasn't had one for that day (weekly roles: Mondays only). Then it pulls fresh data for that store (sheet, Shopify) and POSTs each due role's digest as JSON `{app, kind, at, store, storeId, role, roleName, title, lines, link, text, note?}`. One try per role per day; a failure is logged, not retried all morning ("Send now" retries by hand). A failed pull still sends, with `note` saying the numbers are from the last good pull.
- **Every send is logged** (last 50 kept, last 5 shown under Data & settings → Morning digest): time, role, scheduled or by hand, HTTP status or error.
- **Webhook URLs are env only** (they often carry a token; secrets stay out of `store.json` on the data volume): `DIGEST_WEBHOOK_URL` for every role, `DIGEST_WEBHOOK_URL_<ROLE>` (e.g. `DIGEST_WEBHOOK_URL_CEO`) for a role's own recipient. The page can't set one (PUT with `webhookUrl` → 400); it shows only the host, never the URL; never logged. https only (http only to this machine, for testing).
- **No webhook:** Overview → Share → Copy morning digest, or Send digest on WhatsApp (`wa.me/?text=`, opens WhatsApp with the text ready; no account or key on our side).
- Why a webhook and not email: no email provider, keys or dependencies; Zapier / Make / Slack / a WhatsApp Business tool turn one POST into email, chat or WhatsApp per recipient. Considered: an email API (needs a provider account and key in env); left for when a client asks.
- **Links:** `PUBLIC_URL`, else `RAILWAY_PUBLIC_DOMAIN`, else the address of the last signed-in request (Host / X-Forwarded-Host). Set `PUBLIC_URL` when a proxy in front can pass a wrong host.
- When it can be wrong: the CEO comparison counts a stock-out still open 7 days ago up to that day only; one role, one recipient (a webhook): more people per role means the receiving tool fans out; without `PUBLIC_URL` / Railway domain, scheduled links use the last signed-in address.

## 18. Several stores (ADR-0015, `src/stores.js`, `src/scope.js`)

No number changes with the store count: every rule above runs on **one store's rows only**. Stores never add up into one figure, and no total on any page spans two stores.

- **Which stores:** Performity → every brand our key may use (`GET …/brands`), id = `brand_id`, name = `brand_name` (`PERFORMITY_BRAND_ID`, when set, keeps only that brand). Key Vault → `STORES` (else `SHOPIFY_STORE`); Railway variables → `SHOPIFY_STORE`; no key → the two demo stores (§10). The list is read again every 10 minutes; when Performity can't be reached, the last good list stays (its pulls fail and say why).
- **Which store a page shows:** `?store=<id>` in the address; else the store last chosen on this browser (`sw_store` cookie); else the first in the list. An id not in the list is "Unknown store" (404).
- **Store name** = the name set under Data & settings, else the brand name (Performity), the store handle (Key Vault / variables) or the demo label. Shown in the store pill, the browser tab title, the digest title, alert messages and the PO CSV file name.
- **The picker** (`public/stores.js`): the store pill in the top bar opens a menu of every store, each with its status dot and a line ("Synced 5 min ago", "Sync problem: …", "Demo data"), above the role list. On phones (≤ 760 px, where the pill is hidden) a store bar under the top bar does the same, 44 px tall. Choosing a store puts `?store=<id>` in the address, remembers it on this browser (`localStorage` `sw-store` + the `sw_store` cookie, a year) and reloads on the same page. Keyboard: Enter / Space opens, focus starts on the current store, ↑ ↓ move, Enter picks, Esc closes. The menu never runs past the bottom of the window (it scrolls inside itself), and a long store name ends in "…" on the pill (full name on hover); on a narrow laptop the store name gives way before the period buttons or the view name. The list and its dots are read again every minute, so a dot and its line ("Synced 5 min ago") follow the stale banner without a reload. With several stores the product drawer names the store too. **One store:** the pill is the plain name (no dot, no store list); on phones the store bar shows the name and opens the role list only. The phone store bar always carries the role (· Marketing) and the role list (final critic M1). Every call the page makes carries `?store=` itself, so two tabs on two stores never cross; an address with an unknown id opens the default store instead.
- **Status dot** in the picker, per store: **red (error)** when its last Shopify pull or Sheet sync failed; else **amber (stale)** when Shopify is connected and its last good pull is older than the stale threshold (255 minutes at the default 2-hour pull; §1 "Is the data fresh?", the same rule as the stale banner); else **green (ok)**. Demo stores are green.
- **What is per store:** rows, catalog, settings (plan settings, time zone, Sheet links, Flow key), Mark ordered (§6b), Decide (§15d), the settings change log (§13), run history (§14), digest settings and log (§17), backups. **For every store:** the admin and view passwords and roles (view-only is read-only on every store).
- **Pulls:** one store at a time, in list order, every 2 hours by default (`SYNC_MINUTES`); "Pull now" waits its turn. Why: Performity allows 30 calls a minute per IP and 10 token calls a minute per brand, and the Shopify app's limit is shared with Performity's own pulls. Calls to Performity are spaced at least 2.1 s apart, token calls for one brand at least 6.1 s.
- **`/status`** (uptime monitor): stale or failing when **any** store is; `ageMin` is the oldest store's; row counts and sizes are summed. No store names or ids.
- Why one folder per store and not a store id on every row: a missed filter would mix two brands' numbers; a folder can't be mixed by a missed filter. Considered: one deployment per store (no picker, N passwords). Kept as the fallback for a store that outgrows ADR-0003.
- When it can be wrong: with many brands a full round of pulls can take longer than the pull interval, so the last store's data is older than the first's (its dot turns amber past the stale threshold, 255 minutes by default). Renaming a brand in Performity changes the name here only if no name was set under Data & settings.

### 18a. Per-store access (SW-062, ADR-0016, `src/people.js`)

No number changes. Who can open which store:
- **Owner** = `ADMIN_PASSWORD`: every store, everything, and the only one who sees Data → **People**. `VIEW_PASSWORD`: every store, read-only (§13). Both as before.
- **A person** (made by the owner under People): name, **Admin** (sees and changes their stores: settings, Mark ordered, decisions, digest, imports, backup export) or **Viewer** (sees only, as `VIEW_PASSWORD`), and one or more stores. Their password is made by the app (29 characters), shown **once**, and kept only as a hash; **New password** replaces it, **Remove** deletes the person. Both sign them out at once; role and store changes apply on their next click.
- A person's page: the picker lists only their stores; the store in the address must be one of theirs (else "This store isn’t open to your sign-in", 403); a store remembered on the browser that isn't theirs opens their first store instead. The digest, CSV and backup are per store, so the same rule covers them.
- The change log (§13) names the person ("Meera"), not the role.
- Why: one brand's people must not see another brand's sales (multi-store spec, 20 Nov). Considered: one password per store (no names, can't revoke one person), Performity SSO (SW-060, not available yet). Limits: no email or self-service reset (the owner hands out a new password); the morning digest webhooks are still per store and set on the server, not per person.


---

# 1.4.0: the agency's pages

Who they are for (`.claude/skills/agency-perspective`): the agency that runs a brand's ads. They answer: which best sellers ran out, on which days, for how long, and what that cost, month by month; what to push in ads now and what to pause.

## 19. Product picture and links (`src/links.js`, `public/prod.js`)

**Rule:** every product row (Brand report lists, Best sellers now, Ads, Restock list, All products, Stock-outs, the drawer) shows the product's picture on the left (40 px, 44 px on phone cards, 120 px in the drawer), the name and product code (SKU) stacked to its right, and two links that open in a new tab:
- **Open in Shopify** = `https://admin.shopify.com/store/<shop handle>/products/<product ID>`; shop handle = the `*.myshopify.com` name.
- **View on website** = the product's `onlineStoreUrl` (Shopify sets it only when the product is on the online store); else, for an active product with a publish date, `<shop primary domain>/products/<handle>`; else **Not on website** (draft, archived, or not on the online store) instead of a broken link.
- Picture = the product's featured image from Shopify's CDN at 320 px wide (`https://cdn.shopify.com` only; the page's CSP allows images from there and nowhere else), lazy-loaded, alt = the product name. No picture (demo, Flow, Sheet, CSV) → a neutral box with the first letter.
- All read by the same read-only stock query (`handle onlineStoreUrl publishedAt featuredMedia`) plus `shop { myshopifyDomain primaryDomain }` once per pull; stored in the catalog. CSVs carry two columns: *Shopify admin link*, *Website link*.

**Why:** the brand recognises products by picture, not by name; the agency jumps to the product to check stock or the page. **Considered:** variant images (most products have one variant; the product picture is what shoppers see first). **Can be wrong:** a product published to the online store after the last pull shows "Not on website" until the next pull.

## 20. 12 months from Shopify: which days each product was in stock (`src/year.js`, `src/agency.js`)

**What is read** (Admin API 2025-10, scope `read_reports`, no order download):

> `FROM sales SHOW net_items_sold, net_sales GROUP BY day, product_variant_id SINCE 2025-11-25 UNTIL 2025-12-20 …`
> `FROM inventory_adjustment_history SHOW inventory_adjustment_change WHERE inventory_state = 'available' GROUP BY day, product_variant_id SINCE … UNTIL …`

- The last 400 store days, today included: 12 whole months on any day, plus last year's same month in full for the season (§21). Dates are explicit and **both ends are included** (checked again on Sammsara, 24 Nov 2026: `SINCE 2026-11-14 UNTIL 2026-11-14` returns that one day; relative `UNTIL -Nd` leaves day N out, §1c).
- **Paging:** at most 1,000 rows a query. Each read is sized from the rows per day of the read before (about 800 rows, at most 62 days); one that comes back with 1,000 rows is read again in halves; a single day over 1,000 stops with a note.
- **Pacing:** ShopifyQL is limited per minute (a throttled read waits for `windowResetAt`). The **first load reads everything after the first pull** (up to 80 reads, `YEAR_FIRST_CALLS`; Sammsara: 39 reads in 47 s); after that a run makes at most 8 reads (`YEAR_CALLS_PER_RUN`) and, once a day, reads only the days since the last read (the last day held and today again: 2 reads). Both streams step back together, newest first. Data → *Read 12 months now* (admin) pulls first, then allows 60 reads. 1.4.0 deploy note: the first live run (e526426) used the 8-read budget, so only 26 Sep onward was held after the first pull; the page then ranked best sellers on those 2 months (Oakwood and Nivaya fell out of the top 80% and their ₹ was not counted).
- **While the 12 months are still loading** the page says "History from <date>; the full 12 months after the next pull. Months before then are not read yet (not ₹0)", shows only the months held, and ranks best sellers on Shopify's last 26 weeks of net sales (`src/weeks.js`) instead of the short span.
- **The walk's starting stock** is the catalog's stock at the pull; it is used only when read in the last 15 minutes (else the last anchor stays), and *Read 12 months now* pulls first. The new days are always read in full, outside the 8-read budget. Every read is counted (Data line, `year.json` `calls`, the log line names each window).
- **Never fails a pull:** without `read_reports`, or on any error, a plain note on Data; the brand report then uses the rows we hold (up to 120 days) and says so.

**Days in / out (per variant):**
> stock at the end of day d = stock at the read − the 'available' changes logged after d

- Start of a day = end of the day before. **In stock** (1): start > 0 and end > 0. **Out** (0): start ≤ 0 and end ≤ 0, unless it sold more units that day than it oversold (then it was refilled and sold out again inside the day: in stock). **Half a day** (½): it ran out or came back that day.
- **Oversold units** = how far the day pushed stock further below 0. An order that takes 0 to −1 is a checkout race (Sammsara denies selling at 0, §2): the shelf was still empty; those units never count in the pace.
- **Broken walks:** a variant whose walk goes more than 2 below min(stock now, 0) is left out ("unsure", counted on the page). *Why 2 and not 0 as in §1c:* over a year a best seller may sit at −1 or −2 after a race until someone corrects it; with 0, 14 of 253 Sammsara variants were dropped, Kyoto Round Nesting Table among them (−1 in March). With 2: 0 dropped.
- A variant created inside the 12 months counts from its first day in stock (not "out" before it launched). Only variants on sale now (active, tracked) are counted.

**Why days, not hours:** a year by hour is about 10× the reads; the month-by-month proof needs dates, not hours. The hourly rebuild (§1c) still times the stock-outs of the last 60 days on the other pages.

**Checked on Sammsara (24 Nov 2026, read-only, 37 reads in 17 s):** the stored sales add up to Shopify's own totals for 25 Nov 2025 – 23 Nov 2026 exactly: 27,069 units, ₹7,26,86,792.99 net sales; every month Dec 2025 – Nov 2026 equals `GROUP BY month` to the paisa; per product: Oakwood Table Set of 2 156 units / ₹7,98,030, Nivaya Table Set of 2 110 / ₹5,21,346, Seville Nesting Table Set of 3 33 / ₹1,84,918, Surrey Drink Table 6 / ₹31,019 = Shopify's `GROUP BY product_title`. Stock-out dates against the store's stock log: Oakwood out 4–23 Nov (log: from 4 Nov 18:00 IST, so 4 Nov is a half day); Nivaya 4–11 Oct and 23 Oct – 23 Nov (log: 4–11 Oct, from 23 Oct 07:00); Seville 11 Oct – 23 Nov (log: from 11 Oct 15:00); Surrey Drink Table 3–23 Nov (log: from 3 Nov 16:00).

## 21. Pace (how fast it sells) and the season

**Pace** = units sold ÷ days in stock, over the **last 6 months** (setting *Brand report: months of pace*, 6 or 12), oversold units out. Fewer than 14 in-stock days in those months → the 12 months; fewer than 7 → divided by 7 at least. Shown as a day, a week and a month ("0.29 a day, about 2 a week, 9 a month").

**Season** (per variant, per **calendar** month: November 2025 and November 2026 are one month):
> index(m) = its in-stock pace over the month before, m twice and the month after (1-2-1) ÷ its in-stock pace over the whole span

- Blended with the **shop's** index for that month by those in-stock days D: weight D ÷ (D + 28). Under 14 such days, or under 12 units sold in the span → the shop's index. Capped 0.5–2.0.
- **The shop's index** = units sold on in-stock days ÷ in-stock product-days that month, over the same for the span (so a month with many stock-outs doesn't look quiet); a month with under 60 in-stock product-days, or a store without them, uses the shop's units a day (sales total). A month not held yet (the 1st of a month) takes the same month a year before.
- *Why smoothed over the neighbours (fix after the first live check, 24 Nov):* with each month on its own, a product out for most of a month had no own evidence for it and took the shop's post-Diwali dip: Oakwood (out from 4 Nov) got the shop's 0.76 and ₹31k for November, while Shopify shows its own winter rise (in stock: Oct 2026 0.45 a day, Dec 2025 0.77, Jan 0.58). With the 1-2-1 calendar month and last year's November held (400 days), Oakwood's November index is 1.32 → 0.56 a day → ₹56k (1–23 Nov); the 1.3.0 engine said ₹68.5k (0.69 a day, its October). Nivaya ₹40.9k (engine ₹51.6k at October's festive 0.45 a day; its own Sep 0.10, Dec 0.23, last November 16 units); Seville ₹24.7k (engine ₹18.9k at 0.13; last November 9 units, Oct 0.19 a day). Pinned in `test/agency.test.js` with a fixture of those three (`test/fixtures/sammsara-3-year.json`).
- **Expected a day in month m** = pace × index(m) ÷ the average index of the days the pace was measured on. So a 6-month pace measured over the Diwali rush isn't applied to a quiet January.

**Where it is used:** the brand report (§22), the drawer, the Ads lists (§23), and since 1.4.0 the **₹ lost of long stock-outs** on every other page: a row whose 28-day rate comes from an older in-stock stretch (§3 *history* / *before-out*) values its stock-out at this month's expected pace (`lossPace`). Sammsara, 30 days to 24 Nov: headline ₹4,94,679 → ₹3,93,865 (31 rows); Nivaya ₹67,293 → ₹37,577 (0.45 a day, its October pace, → 0.25 a day for November).

**Reorder keeps the 28-day rate (§3).** *Why:* the order quantity must follow what sells now (a campaign, a new photo); a 6-month pace lags both ways. The 28-day rate already removes out-of-stock days. Only when it has to look back past the window (long stock-outs) did it borrow an old season; that is the case fixed above. *Considered:* the 6-month pace for reorder too (smooth, but slow after a change); the season on the 28-day rate (one month of a season says little).

**Can be wrong:** a product's own months are noisy when it sells a few a month (hence the blend); the season is last year's: a festival on different dates this year shifts its month.

## 22. Money missed by month, best sellers (Brand report)

> money missed in month m = Σ over its days (out share of the day × expected a day in m) × average price paid
> average price paid = 12-month net sales ÷ net units (ex GST, after discounts); the list price when it never sold for money

- **Best sellers** = products (variants summed) making the top **80%** of the 12 months' net sales among products on sale now (setting *Best sellers: products making this % of sales*; a product counts while the share before it is under 80%, as §7a).
- **Month table:** sold (Shopify's net sales that month, every sales row, so it matches Shopify exactly), money missed on best sellers, % of sales, best sellers that ran out, days out (best sellers, added up), and money missed on all products (CSV).
- **Headline:** "Best sellers ran out on N days in the last 12 months. Money we missed: about ₹X. That is Y% of what the brand sold (₹Z), <dates>." N = days out added up over best sellers (half days count ½). The 12 months = the 12 calendar months ending with this month, to yesterday.
- **Grid:** each best seller × month: days out (darker = longer) and the ₹ in the hover; tap a month → the list: picture, name, code, links, the dates it was out ("4–11 Oct, 23–31 Oct"), days out, "would have sold about N", money missed. CSV of the month table and of the list.
- **Numbers as of:** sales up to yesterday; stock read at the time shown.
- **Website top-ups (§6) apart:** a best seller Shopify shows as a few pieces refilled from the warehouse keeps its gaps on its row (tag *website top-up*) but not in the month totals or the headline; one line under the headline says how much ("Not counted: ₹X while N website top-up items waited for a warehouse refill").
- **Sammsara, 12 months to 23 Nov 2026 (read 24 Nov, 400 days, after the critic and live-check fixes):** best sellers (43 products) ran out on 896 days (36 of the 43 ran out); **₹16.6 lakh missed = 2.33% of ₹7.11 Cr sold**; + ₹2.8 lakh on 4 website top-up items, apart; 1 variant left out (its log doesn't add up). Worst month August 2026: 26 best sellers out for 270 days, ₹4.9 lakh (8.2%). November 1–23: ₹2.14 lakh (5.2%), 9 best sellers. All products: ₹61.2 lakh (CSV).

**Why best sellers only in the headline:** the brand can't argue with them (they sell every month), and they are what the agency's ads push. All products' missed money is in the CSV. **Why at the price paid:** the brand's own sales report is net sales, so the two compare. **Can be wrong:** substitutes (a shopper buys a similar table instead) make it an upper bound, as §4.

## 23. Best sellers now; push / pause ads (`src/sell.js`)

- **Best sellers now:** each best seller (§22): in stock (pieces) or out since when (any selling option out = out; the day comes from the 12 months, so a product out longer than the rows we hold says "since 9 Aug" or "since before 25 Nov 2025", not the first stock record), days out and money missed this month (§22), how fast it sells (§21), refill: ordered (lands …), order N now, not ordered, enough stock. Out first, then money missed this month. Opening a row gives *Mark ordered* (§6b).
- **Push in ads:** in stock, selling (pace > 0), and at least max(21 days, lead time + buffer) of stock at its pace, so ads won't empty the shelf; most money a day first (pace × price). **Pause ads:** the Pause list of §15c (out now, or runs out before a refill can land), only items that sell; best sellers first, then money a day. Copy list (code + name) and CSV, with links.
- Pace = the brand report's pace for this month (§21) when Shopify's 12 months are read, else the 28-day rate (§3).

## 24. The product drawer: a 12-month profile (1.4.1, `src/agency.js` `profile`, `public/profile.js`)

Everything comes from the 12 months of §20 (ShopifyQL day aggregates) and the catalog; one variant. Months = the 12 calendar months of the brand report; "12 months" = the first of the oldest month to yesterday.

| Section | Rule |
|---|---|
| Rank | products on sale now by 12 months' net sales: "#23 of 234 by sales, 12 months"; *Best seller* as §22 |
| Story | "Sells about <pace> when it is in stock. Ran out N times in the last 12 months, D days in all. That cost about ₹X in sales." (pace in words as §3; "in these days" when under 330 days are held) |
| Sold, share | Σ net units and net sales (ex GST) over the 12 months; ÷ the store's net sales over the same months |
| Pace on days in stock | units on days in stock (oversold units out) ÷ in-stock days over the 12 months, at least 7 days; a week = × 7, a month = × 30.4. (The ₹ uses the 6-month seasonal pace of §21; this line is the plain 12-month average) |
| On the shelf | in-stock share of the days held (§20 day rules: ½ for a day it ran out or came back) |
| Ran out | runs of days not fully in stock; times = runs, days = Σ (1 − in-stock share); longest = the run with most out-days, with dates; "still out" when the last run reaches yesterday |
| Money missed | Σ over the months of §22 for this variant |
| Last restock | the newest day the 'available' stock went up (net of the day), with +pieces |
| Price | **MRP** = Shopify's compare-at price (when above the price); **list** = the price (with GST); **paid** = net sales ÷ units (ex GST), × (1 + GST %); **GST %** = ShopifyQL `taxes` ÷ `net_sales`; discount off MRP = 1 − paid with GST ÷ MRP, off list likewise; per month the same |
| 12-month chart | bars = net units sold that month; dashed bar on top = units it would have sold on its days out (§22); red strip = days out ÷ days in the month; line = the month's season index (§21, ×½ to ×2) |
| Stock level | stock at each day's end (§20 walk); ▲ = a day the stock went up (+pieces); shaded = days not fully in stock |
| Busy / quiet | months with index ≥ 1.1 / ≤ 0.9 (its own when it has the days, else the store's, §21); this month so far vs the same month last year: units, in-stock days, a day |
| Details | category (product type), vendor, launched (variant createdAt), on the website since (publishedAt), collections (Group by cache, §9b; "All products" left out), tags |

The last 30 days to the hour (Why, sales lost with its confidence, every stock-out with times) stay under one fold, from the report of §4.

**Checked on Sammsara (24 Nov 2026, read-only, against ShopifyQL `GROUP BY product_title, month` and the Admin API):** Oakwood Table Set of 2, Nivaya Table Set of 2, Scarlett Gold Table, Kimaya Chandelier Candle Holder: 12 of 12 months equal in units and ₹ (to ₹1 rounding) for each; MRP = compare-at (₹12,709 / ₹12,420 / ₹19,999 / ₹7,220), list price, paid with GST (₹5,397 / ₹5,008 / ₹6,159 / ₹2,962), GST % (5.52 / 5.54 / 5.32 / 5.28) and discount off MRP (57.5% / 59.7% / 69.2% / 59.0%) equal Shopify's. The profile takes about 150 ms to build on the live catalog.

**Why:** the drawer answers the brand's questions about one product in one place, with a year of evidence; the 30-day widgets showed zeros for a product out most of the month. **Can be wrong:** a day's net stock change hides a restock and sale on the same day (the "last restock" is net); compare-at prices set only on some variants show no MRP for the others.
