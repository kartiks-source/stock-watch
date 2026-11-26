# Formats: Stock-out Watch (web app)

Every row format the app reads and every file it writes, version 1.1.0. Parsing: `src/rows.js`. Storage: `src/store.js` and the sidecar modules. Routes: `API.md`. Rules on what the numbers mean: `LOGIC.md` (§1a for parsing and skips).

**schemaVersion (SW-047):** `store.json` carries `"schemaVersion": 1`, written on every save (since 1.0.0-rc.1). Schema 1 is the shape on disk since Sprint 1 (SW-002 catalog, SW-006 `src`); a file without the key is read as schema 0 (the same shape) and saved as 1. `src/store.js`: `SCHEMA_VERSION`, `MIGRATIONS[n]` turns schema n into n + 1, run in order on load. A file with a **higher** schemaVersion (written by a newer app, e.g. after a rollback) is **refused, never rewritten**: the server doesn't start and says to deploy the newer version; a `restore.json` with a higher schemaVersion is rejected. To change a stored shape: bump `SCHEMA_VERSION`, add the migration and its test (`test/store.test.js`), and keep new keys optional where you can. The side files (`onorder.json`, `decisions.json`, `catalog.json`) carry no version; they are plain maps whose entries only gain optional keys.

## Inbound rows

The same two columns sets everywhere: Shopify Flow → Google Sheet tabs, Sheet "Publish to web" CSV links, CSV upload, and Flow → `/ingest/*`. The Google Sheet module (`modules/stock-watch-sheets`) uses the same column order; keep them in step.

### Stock row (one per stock change)

| # | Column | Required | Notes |
|---|---|---|---|
| 1 | Time | yes (CSV / Sheet) | see §Times. Flow: blank or unreadable = the time it arrived |
| 2 | Variant ID | yes | digits; a `gid://shopify/ProductVariant/` prefix is removed; other characters except letters, digits, `_`, `-` dropped |
| 3 | SKU | | |
| 4 | Product | | product title |
| 5 | Variant | | variant title (not an ID) |
| 6 | Stock before | | blank = unknown: the engine uses the previous row's *Stock now* (LOGIC.md) |
| 7 | Stock now | yes | total across all locations; blank row skipped (`badNumber`) |
| 8 | Price | | selling price; blank = 0 |
| 9 | Type | | product type (category) |
| 10 | Cost | | unit cost; kept only when > 0 |

### Order row (one per order line)

| # | Column | Required | Notes |
|---|---|---|---|
| 1 | Time | yes (CSV / Sheet) | order created time |
| 2 | Order | | order name, e.g. `#1042` |
| 3 | Variant ID | yes | as above |
| 4 | SKU | | |
| 5 | Qty | yes | must be > 0 (refunds netted before it gets here; only the Shopify pull stores qty-0 lines, fully refunded or on a cancelled order, with `ordered` and `returned`) |
| 6 | Unit price | | price paid after discounts; blank = 0 |

### Header names (CSV and Sheet)

A CSV or Sheet tab must start with a header row naming at least the required columns (Stock: Time, Variant ID, Stock now; Order: Time, Variant ID, Qty), else **400** `Missing column(s): …` and nothing is stored. Headers are matched case-insensitively with `_` read as a space; an exact name always beats an alias; each column is used once. The delimiter is `,` or `;`, whichever the first line has more of. A UTF-8 BOM is ignored.

| Column | Also accepted |
|---|---|
| Time | timestamp, date, created at, createdat, at |
| Variant ID | variantid (not "variant": that is the title) |
| SKU | variant sku |
| Product | product title, title, name |
| Variant | variant title, option |
| Stock before | before, prior, inventory before, quantity before |
| Stock now | now, after, inventory, quantity, stock, inventory now |
| Price (stock) | unit price, selling price |
| Type | product type, category (not "collection") |
| Cost | unit cost, cost price, cogs, cost per item |
| Vendor (stock, SW-045) | supplier: kept on the stock row for the PO CSV |
| Order | order name, order id, name |
| Qty | quantity, units |
| Unit price (order) | price, net price, discounted price |

### Shopify admin exports and column mapping (SW-045, LOGIC.md §1b)

Read as they come from Shopify admin (Products → Export, Orders → Export, CSV for Excel or plain CSV); detected from the header row:

| Export | Our column ← Shopify column |
|---|---|
| Products (`Handle`, `Variant SKU`, `Variant Inventory Qty`) → stock rows | Time ← the import moment; Variant ID ← `Variant ID` if present, else the SKU; SKU ← `Variant SKU`; Product ← `Title`; Variant ← `Option1/2/3 Value`; Stock now ← `Variant Inventory Qty`; Price ← `Variant Price`; Cost ← `Cost per item`; Type ← `Type`; Vendor ← `Vendor`. `Tags` and the rest are not read |
| Orders (`Name`, `Lineitem quantity`) → order rows | Time ← `Created at`; Order ← `Name`; Variant ID ← `Lineitem variant id` if present, else the SKU; SKU ← `Lineitem sku`; Qty ← `Lineitem quantity`; Unit price ← `Lineitem price` − `Lineitem discount` ÷ qty. `Cancelled at` / `Financial Status` leave rows out |

Any other file: the page shows the suggested mapping and lets each of our columns take any header (or "Not used"). The mapping is sent as `?map=` (API.md) and remembered in `mappings.json`.

### Numbers and times

- **Numbers:** `₹`, `Rs`, `INR`, commas and spaces are stripped (`₹1,299.50` → 1299.5). Anything else unreadable skips the row (`badNumber`).
- **Times:** ISO with zone (`2026-11-17T10:22:31+05:30`, `Z`); ISO without zone or date only (`2026-11-17` = 00:00) is store time (`settings.timeZone`, default `Asia/Kolkata`, daylight saving followed; LOGIC.md §0a); `dd/mm/yyyy [hh:mm[:ss]]` (US `11/15/2026` is rejected, not guessed); a Sheets serial number (store time); `Tue, 17 Nov 2026 04:52:31 GMT`. Impossible dates (31/02) are rejected.
- **Skips** (reported as `skips` on import): `badTime` (unreadable, or more than 1 day in the future), `badNumber`, `noId`, `tooOld` (older than the 120 days kept).
- **Duplicates** are stored once. Stock key: `t|variantId|before|now`. Order key: `order|L<line>` when the row has a Shopify line ID, else `order (or t)|variantId|qty`.

### Shopify Flow templates

Flow → Google Sheet (**Add row to spreadsheet**) and Flow → this app (**Send HTTP request**, POST, header `X-Ingest-Key: <key>`) use the same line. Setup steps: `modules/stock-watch-sheets/SETUP.md` (Sheet) and `README.md` §B (direct).

Stock (trigger: *Product variant inventory quantity changed*):

```
{{ "now" | date: "%Y-%m-%dT%H:%M:%S%z" }},{{ productVariant.id | remove: "gid://shopify/ProductVariant/" }},{{ productVariant.sku | replace: ",", " " }},{{ product.title | replace: ",", " " }},{{ productVariant.title | replace: ",", " " }},{{ inventoryQuantityPrior }},{{ productVariant.inventoryQuantity }},{{ productVariant.price }}
```

Order line (trigger: *Order created* → For each `order / lineItems`):

```
{{ order.createdAt }},{{ order.name }},{{ lineItemsForeachitem.variant.id | remove: "gid://shopify/ProductVariant/" }},{{ lineItemsForeachitem.sku | replace: ",", " " }},{{ lineItemsForeachitem.quantity }},{{ lineItemsForeachitem.discountedUnitPriceSet.shopMoney.amount }}
```

A Flow body needs no header row (a first line is treated as a header only if it names 2+ columns and has no readable time). JSON bodies are also accepted: one object, or an array of at most 500. Field names read, first match wins:

| Stock column | JSON keys | Order column | JSON keys |
|---|---|---|---|
| Time | `time`, `at` | Time | `time`, `created_at`, `createdAt` |
| Variant ID | `variant_id`, `variantId`, `variant id` | Order | `order`, `order_name`, `name` |
| SKU | `sku` | Variant ID | `variant_id`, `variantId`, `variant id` |
| Product | `product`, `title` | SKU | `sku` |
| Variant | `variant`, `variant_title` | Qty | `qty`, `quantity` |
| Stock before | `before`, `stock_before`, `prior` | Unit price | `price`, `unit_price` |
| Stock now | `now`, `stock_now`, `quantity` | | |
| Price | `price` | | |
| Type | `type`, `product_type`, `category` | | |
| Cost | `cost`, `unit_cost`, `cost_price` | | |

## Outbound CSV

### PO CSV (`GET /api/export/reorder.csv`)

UTF-8 with BOM, every cell quoted, text starting with `= + - @ tab CR` gets a leading `'` (formula guard). File `reorder-YYYY-MM-DD.csv` (store date). Rows: the tab (`filter`) and search (`q`) shown on the page, grouped by vendor A–Z (unknown last), page order within a vendor.

`Vendor, Product, SKU, Variant ID, Order qty, Unit cost, Order value, Status, Why, Order by, Stock now, Sells per day, Days left, Sales lost (₹), Confidence, Not restocked 30+ d (₹), Shopify admin link, Website link`

*Shopify admin link* / *Website link* (1.4.0, LOGIC §19): the product in Shopify admin and on the brand's website; `Not on website` when it isn't on the online store; blank without Shopify.

*Sales lost (₹)* = the product's whole number; *Confidence* = `High` / `Medium` / `Low` (units behind the rate, LOGIC §4c; Low = an estimate, not in the headline); *Not restocked 30+ d (₹)* = the part of it after day 30 of an open stock-out with no PO (not in the headline either) (1.2.0). *Order by* is a store date `YYYY-MM-DD`; *Unit cost* is blank when unknown; *Status* uses the page's labels. *Vendor* = the product's supplier (SKU map, else Shopify vendor, SW-040). `?supplier=<name>` → file `po-<supplier>-<store>-YYYY-MM-DD.csv` with that supplier's lines to order only; `?budget=<₹>` keeps only the rows above the budget cut line (SW-041, LOGIC §6d).

### Supplier CSVs (`GET /api/export/suppliers.csv`, `POST /api/suppliers/import`, SW-040)

Same BOM and formula guard. Header names match whatever their case and spacing; `(…)` in a header is ignored.

- Suppliers (`?kind=suppliers`): `Supplier, Lead time (days), MOQ (units), Case pack (units)`. Import also takes `Vendor`/`Name`, `Lead`/`Lead days`, `Minimum order`, `Pack`/`Case`/`Pack size`. Blank = not set. Rows merge into the table; a row with every term blank removes that supplier's terms. A bad term skips the row with a reason (line number).
- Product → supplier (`?kind=map`): `SKU, Variant ID, Product, Supplier, From` (`From` = `set here` or `Shopify vendor`). Import needs `SKU` (or `Variant ID`) and `Supplier`; blank Supplier = back to the Shopify vendor.

### Browser-built CSVs (`public/app.js`, same BOM and formula guard)

- Products (`products-YYYY-MM-DD.csv`): the columns and rows shown (with *Confidence*, 1.2.0, when that column is on).
- Pause promotion (`pause-promotion-YYYY-MM-DD.csv`): `Product, SKU, Variant ID, Why, Back in stock, In stock, Days left`.
- Push these (`push-these-YYYY-MM-DD.csv`): `Product, SKU, Variant ID, Overstock ₹, In stock, Days left`.
- 1.4.0: Products, Pause promotion and Push these end with `Shopify admin link, Website link` (LOGIC §19).
- Brand report, months (`brand-report-months-<through>.csv`): `Month, From, To, Sold ₹ (net, ex GST), Missed ₹ (best sellers), % of sales, Best sellers out, Days out (best sellers), Missed ₹ (all products)` (LOGIC §22).
- Brand report, one month (`brand-report-YYYY-MM.csv`): `Month, Product, SKU, Variant ID, Best seller, Ran out on, Out-of-stock dates, Days out, Would have sold (units), Pace (units a day, in stock), Average price paid ₹, Money missed ₹, Shopify admin link, Website link`; *Out-of-stock dates* = the store days out (`YYYY-MM-DD`, space separated; half days included).
- Ads (`push-in-ads-YYYY-MM-DD.csv`): `Product, SKU, Variant ID, Best seller, Sells (units a day), In stock, Weeks of stock, ₹ a day it can sell, Shopify admin link, Website link`; (`pause-ads-YYYY-MM-DD.csv`): `Product, SKU, Variant ID, Best seller, In stock, Days left, Back in stock, Sells (units a day), Shopify admin link, Website link` (LOGIC §23).

## Kept in the browser (per browser, never on the server)

Nothing here is a secret or a number; clearing site data only resets choices.

| Key | Where | Shape | Set by |
|---|---|---|---|
| `sw_store` | cookie, `Path=/`, a year, `SameSite=Lax` (`Secure` on https), readable by the page | a store id (uuid or `^[a-z0-9][a-z0-9-]{0,60}$`) | the store picker (`public/stores.js`); the server uses it only when the request has no `?store=` and the id is listed (ADR-0015) |
| `sw-store` | `localStorage` | the same store id | the store picker; the page's default when the address has no `?store=` |
| `sw-role` | `localStorage` | a role key (`ceo`, `ops`, …) or absent = All (the default) | roles off in the UI since 20 Nov 2026: cleared on load, `/?role=` ignored (SW-020) |
| `sw-cols-off` | `localStorage` | `{ reorder: ['outs', …], products: [...] }`: optional columns **unticked** (every optional column is on by default; replaces the old opt-in `sw-cols`, which is ignored) | Columns… on Reorder / Products |
| `sw-budget:<store id>` | `localStorage` | a whole ₹ amount, or absent = no budget | Reorder → Budget ₹ (SW-041); per store, this browser only |
| `sw-polens` | `localStorage` | `supplier`, or absent = List | Reorder → List / By supplier (SW-040) |
| `sw-colw` | `localStorage` | `{ <table>: { <column>: px } }`: dragged column widths | dragging a header edge; double-click resets |

## Files in `DATA_DIR` (`/data` on Railway)

Several stores (ADR-0015): each store's files are in its own folder, `DATA_DIR/stores/<id>/`, laid out exactly as one store's were before (`<id>` = Performity brand_id in lower case, a Key Vault store handle, or `sammsara-demo` / `second-demo`). Only `secret`, `stores.json` and `access.json` (SW-062) sit at the top, for every store. The table below is one store's folder, then the two shared files.

| File | Written by | Shape | In app backups? |
|---|---|---|---|
| `store.json` | `src/store.js` (temp + fsync + rename) | below | yes: it is what backups copy |
| `store.json.bak` | `src/store.js` | the previous good save | no (rebuilt every save) |
| `store.json.corrupt-<time>` | `src/store.js` | a copy of an unreadable store, left for a human | no |
| `onorder.json` | `src/onorder.js` via `src/sidefile.js` (temp + fsync + rename, previous kept as `.bak`) | `{ [variantId]: { qty, eta, at, by } }`: units on order, landing time (ms), when marked (ms), who (≤ 40 chars or null). Records due more than 60 days ago are dropped | yes, as `sideFiles['onorder.json']` (SW-005) |
| `decisions.json` | `src/decide.js` via `src/sidefile.js` (temp + fsync + rename, previous kept as `.bak`) | `{ [variantId]: { d: 'keep'\|'drop'\|'clear', base, at } }`: base = sales per day when decided | yes, as `sideFiles['decisions.json']` (SW-005) |
| `suppliers.json` | `src/suppliers.js` via `src/sidefile.js` (temp + fsync + rename, previous kept as `.bak`) | `{ suppliers: { <name, lower case>: { name, leadDays, moq, pack, demo? } }, map: { <SKU or variant ID>: <supplier name> } }` (SW-040). Only suppliers with a term are stored; `demo: true` = seeded with the demo, dropped when real data arrives unless edited | yes, as `sideFiles['suppliers.json']` |
| `snapshots.json` | `src/weekly.js` via `src/sidefile.js` (SW-043) | `{ basis: 'demo'\|'live', calc: '<engine CALC_VERSION>\|<history.at>\|<priceBasis>', days: { 'YYYY-MM-DD': { at, src: 'day'\|'backfill', sold, lost, lostProfit, ranOut, stillOut, excessValue, toReorder, orderToday, orderTodayValue, lostBy: { variantId: ₹ } } } }`: one per store day (LOGIC.md §5b), newest 400 days; `lostBy` = top 100 products by ₹ lost that day; a new basis starts it empty; a new `calc` (1.1.1: engine rules, stock history rebuild or order price basis changed) drops and retakes the last 14 days. Files without `calc` read as changed | yes, as `sideFiles['snapshots.json']` |
| `targets.json` | `src/targets.js` via `src/sidefile.js` (SW-042) | `{ [lens]: { [groupKey]: { amount, at, by } } }`: monthly sales target in ₹ per group (lens = `product`, `type`, `collection`, `tag`), when set and by whom; at most 2,000 | yes, as `sideFiles['targets.json']` |
| `lists.json` | `src/lists.js` via `src/sidefile.js` (SW-044) | `{ [id]: { name, items: [string], at, by } }`: saved product lists (SKUs / names / variant IDs as pasted); `id` = the name in lower case, spaces as `-` | yes, as `sideFiles['lists.json']` |
| `onorder.json.bak`, `decisions.json.bak`, `suppliers.json.bak`, `….corrupt-<time>` | `src/sidefile.js` | the previous good save (used when the file can't be read), and a copy of an unreadable file left for a human; with neither good, the app refuses to start (critic r2 X1) | no |
| `mappings.json` | `src/csvmap.js` (temp + rename) | `{ sets: { [key]: { kind: 'stock'\|'order', map: { <our column>: <their header>\|'@now'\|'@sku'\|'@options'\|'' }, at } } }`: the column mapping last used for a set of CSV headers (key = first 20 hex of sha256 of the sorted, lower-cased header names); newest 50 kept. An unreadable file is set aside as `mappings.json.corrupt-<time>` and starts empty (SW-045) | no (one re-pick if lost) |
| `year.json` | `src/year.js` via `src/sidefile.js` (1.4.0, LOGIC §20) | below | no: it is Shopify's own reports, read again in a few pulls (an unreadable file is treated as empty and read again) |
| `catalog.json` | `src/catalog.js` (temp + rename) | `{ collections: { [collectionId]: { title, productIds[] } }, collectionsAt, pending, lastError, variants, variantsAt }`: Shopify collections cache for Group by, re-read daily; `pending` = a resumable read in progress | no (rebuilt from Shopify within a day) |
| `backups/store-YYYYMMDD.json`, `backups/store-YYYYMMDD-HHMMSS-<why>.json` | `src/backup.js` | copies of `store.json` plus `sideFiles: { 'onorder.json', 'decisions.json', 'suppliers.json' }` (`why` = `before-clear`, `before-demo`, `before-restore`); newest 14 of each kind | — |
| `restore.json` | a human | a `store.json` to put in place at the next start (`docs/RUNBOOK.md`) | — |
| `.migrated-from-data-dir.json` | `src/migrate.js`, the home store only; its presence in any store folder means the move is done for good | `{ from: 'DATA_DIR', id, at, files: [{ path, sha256 }] }`: the old single-store files moved here, with their hashes (originals are deleted only while they still match) | no |
| **top of `DATA_DIR`:** `secret` | `server.js` (mode 600) | 64 hex characters: the session cookie key, for every store | no (a new one signs everyone out) |
| **top of `DATA_DIR`:** `instance.lock` | `src/lock.js` (SW-055) | `{ id, pid, host, startedAt, beatAt }`: the copy that writes; refreshed every 30 s, removed on a clean stop, taken over after 2 minutes without a refresh | no |
| **top of `DATA_DIR`:** `access.json` (schema 1) | `src/people.js` (mode 600, SW-062) | `{ schemaVersion: 1, people: [{ id (8 chars a–z 2–9), name, role: 'admin'\|'view', stores: [store id], hash: 'scrypt$16384$8$1$<salt>$<key>' (base64url), gen (+1 per new password), createdAt, updatedAt, lastSignInAt }] }`. Written atomically (tmp + rename); the copy before each save is `access.json.bak`. A newer schemaVersion or a broken file: nobody from it signs in, it is never written over (fix or remove it). Changed only by the owner (Data → People) | no: it is for every store, so not in a store's backup; `access.json.bak` keeps the copy before the last change, and the Railway volume holds both |
| **top of `DATA_DIR`:** `stores.json` | `src/stores.js` (Performity only) | `{ list: [{ id, name, shop }], at }`: the last good brand list, used while the API is down | no (re-read every 10 minutes) |
| **top of `DATA_DIR`:** `stores/.migrating-<id>/` | `src/migrate.js` | a half-done copy left by a crash during the move; thrown away and redone on the next start | no |

Outside `DATA_DIR`, in the app folder: `BUILD_SHA` (optional, SW-056): one line, the git commit the build came from, written by `npm run stamp` at the repo root before `railway up` (docs/RUNBOOK.md). Read by `src/version.js` when neither `RAILWAY_GIT_COMMIT_SHA` nor `BUILD_SHA` is set in env; only 7–40 hex characters count.

### `store.json` (schema 1)

`settings.agencyStart` (4.2.0, optional): `"YYYY-MM-DD"`, the day the agency took the store on, or `null`. Only drawn on the brand report; no schema bump.

`settings.timeZone` (SW-049): an IANA zone name or a fixed `+05:30`; when missing, the older `tzOffsetMin` (minutes east of UTC) is read instead (330 = `Asia/Kolkata`). No schema bump: the old field still reads.

```
{
  "schemaVersion": 1,
  "settings": {
    "storeName": "Demo Store", "timeZone": "Asia/Kolkata", "tzOffsetMin": 330,
    "leadDays": 7, "coverDays": 30, "safetyDays": 3, "demandWindowDays": 28, "smallTopUpDays": 7, "minPerDay": 0.2,
    "ingestKey": "<32 hex>", "ingestKeyAt": 0, "sheetStockCsv": "", "sheetOrderCsv": "", "demoVersion": 0
  },
  "stock":  [ { "t": 0, "variantId": "", "sku": "", "product": "", "variant": "", "before": 0, "now": 0, "price": 0,
                "type": "?", "cost": "?", "vendor": "?", "src": "shopify|flow|sheet|csv|demo|rebuilt" } ],
  "orders": [ { "t": 0, "order": "#1001", "line": "?", "variantId": "", "sku": "", "qty": 1, "ordered": 1, "returned": "?0", "refund": "?0", "cancelled": "?0", "price": 0, "src": "…" } ],   // price: Shopify pull = ex tax (1.1.1); ordered, returned, refund, cancelled: Shopify pull only (SW-064, 1.1.3)
  "reversals": "?[ { id: '<refund line ID>|c<line ID>', t: 0, order: '#1001', variantId: '', qty: 1, value: 0, kind: 'refund|cancel' } ]",   // Shopify pull only, 1.1.5
  "catalog": { "<variantId>": { "productId": "", "product": "", "variant": "", "sku": "", "type": "", "vendor": "", "tags": [],
                "price": 0, "cost": null, "status": "ACTIVE|ARCHIVED|DRAFT|UNTRACKED|DELETED", "tracked": true, "active": true,
                "stock": 0, "seenAt": 0, "inactiveSince": "?", "createdAt": "?0",
                "image": "?https://cdn.shopify.com/…", "handle": "?", "web": "?https://…", "published": "?true", "publishedAt": "?0", "compareAt": "?0",
                "spells": "?[ { from: 0, to: 0, status: 'DRAFT' } ]" } },
  "source": "empty|demo|live", "everLive": true,
  "lastSync": null, "lastSyncError": null,
  "shopify": { "lastQty": { "<variantId>": 0 }, "ordersCursor": null, "lastSync": null, "lastError": null, "lastTry": null, "writeScopes": "?['write_products']",
               "priceBasis": "?'exTax'",
               "orderFields": "?'reversals'",
               "shopInfo": "?{ domain: 'brand.myshopify.com', web: 'https://www.brand.com' }",
               "historyRebuiltAt": "?0", "history": "?{ at, v, ok, kept, total, changed, flat, dropped, droppedLog, droppedCheck, check: { lines, bad, badUnits, variants }, from, until, rows, calls, note }" },
  "settingsLog": [ { "at": 0, "by": "admin|view|admin (script)|server (env)", "key": "leadDays|…|digest.hour|digest.roles|digest.paused|digest.webhook", "old": 7, "new": 10 } ],
  "syncRuns":    [ { "kind": "shopify|sheet", "start": 0, "ms": 0, "stock": 0, "orders": 0, "lines": 0, "error": null, "notes": [] } ],
  "digest": { "hour": 9, "roles": ["ceo", "founder", "ops", "marketing", "finance"], "paused": false, "webhookSeen": "?everyone → host; ceo → host",
              "lastSent": { "<role>": "YYYY-MM-DD" }, "log": [ { "at": 0, "role": "", "trigger": "schedule|manual", "ok": true, "status": 200, "error": null, "note": "?" } ] }
}
```

- Times are ms since 1970 (UTC). `"?"` marks an optional key. `before` may be `null` (unknown).
- Rows older than 120 days are pruned, except per variant the newest stock row and the row that opened a stock-out still running (ADR-0010).
- `catalog` is Shopify only, replaced whole on every stock pull; a variant that disappears stays as `DELETED` until it is 120 days gone. `spells` (optional) are the variant's past inactive spells, added when it turns active again (from = `inactiveSince`, to = the pull that saw it active); at most 20, each dropped 120 days after it ends (LOGIC §1). Older files without it load as before.
- Catalog `image`, `handle`, `web`, `published` and `shopify.shopInfo` (1.4.0, LOGIC §19): the product's featured image (Shopify CDN URL, 320 px wide, `https://cdn.shopify.com` only), its handle, its `onlineStoreUrl` (only when on the online store), whether it has a publish date; the shop's `*.myshopify.com` domain and primary domain. Read by the stock pull; optional, older files load as before. Settings gain `paceMonths` (6) and `bestShare` (80) (LOGIC §21, §22). Catalog `compareAt` (1.4.1): the variant's compare-at price (MRP, with GST), only when set. Catalog `publishedAt` (ms): when the product went on the online store (the brand report counts a product from max(createdAt, publishedAt)).
- `settingsLog` keeps 200 entries, newest first; the ingest key shows as `(old key)` → `(new key)`. `syncRuns` keeps 20. `digest.log` keeps 50.
- `shopify.writeScopes` (optional, SW-051): the `write_*` scopes the last pull's token had; only ever non-empty for Performity's token (our own apps with one are refused), shown on Data as "Token also allows writes; this app only reads". Older files without it load as `[]`.
- `src: 'rebuilt'` stock rows (SW-063, LOGIC §1c): stock before the store's first Shopify read, rebuilt from Shopify's change log; same fields as a pulled row, only times before the first live row; replaced whole on each rebuild (`store.setRebuilt`). `shopify.historyRebuiltAt` (optional) = when the rebuild last ran (set even when it was skipped, so it runs once per store; reset with the rest of `shopify` by Clear / demo); `shopify.history` = its outcome (`v` = rules version, `history.VERSION`, 2 since 1.1.1; a file without `v` or with an older one is rebuilt on the next pull; `kept` of `total` variants; `dropped` = `droppedLog` (rebuilt stock below min(stock at the first read, 0)) + `droppedCheck` (failed the order check); `check` = order lines in the rebuilt span, how many fell inside a rebuilt stock-out with no logged drop, their units, and the variants they hit; `from`/`until` = rebuilt span; `note` = why it was skipped, refused (check over 1%) or the last re-run failed). Older files without them load as before; no schema bump.
- Order `price` from the Shopify pull is the unit price paid after all discounts **without tax** when the order's prices include it (1.1.1, LOGIC §What counts as a sale). `shopify.priceBasis: 'exTax'` marks a store whose orders were read that way; a store without it clears `ordersCursor` once on its next pull, so the last 60 days of orders are read again (older stored orders keep the tax-inclusive price until they age out). Flow / Sheet / CSV prices are stored as sent.
- Order `ordered`, `returned`, `refund`, `cancelled` (SW-064, 1.1.3, LOGIC §9e), Shopify pull only. `ordered` = the line's `quantity`. From the order's refunds (`order.refunds.refundLineItems`): `returned` = units refunded (any restock type), `refund` = their ₹ (line subtotal after discounts, less its tax when the order's prices include tax; the whole line's, not per unit), `cancelled` = units cancelled before shipping (restock type `CANCEL`); each written only when > 0. `qty` = units kept = `min(currentQuantity, ordered − returned)` (a refund need not lower `currentQuantity`). A **cancelled order**'s lines are stored too: `qty: 0`, `returned` = `cancelled` = `ordered`, `refund` from its refund lines (units without one at the price paid). `qty: 0` lines are never sales. Rows without `returned` count no returns. `shopify.orderFields: 'refunds'` marks a store whose lines carry them; any other value (`'ordered'` from SW-064, or none) clears `ordersCursor` once on its next pull (the 60-day backfill is read again, like `priceBasis`). No schema bump.
- `reversals` (1.1.5, LOGIC §9e), Shopify pull only: one event per refund line (`t` = the refund's `createdAt`, `qty` its units, `value` its subtotal after discounts less its tax when the order's prices include tax, ₹ ex GST, 2 decimals) and, for a cancelled order, one per line for the units no refund line covers (`id` = `c<line ID>`, `t` = `cancelledAt`, `value` = units × price paid ex GST); a refund made after the cancellation adds none. `kind`: `cancel` (order cancelled, or restock type `CANCEL`) or `refund`. Every read of an order replaces its events whole (`store.replaceReversals`), one per `id`, older than 120 days dropped. Absent until the first pull that reads them (the engine then counts reversals by order date from the lines). `shopify.orderFields: 'reversals'` (1.1.5) marks a store whose events are read; `'refunds'` (1.1.3–1.1.4) or older empties `reversals` and clears `ordersCursor` once (the 60-day backfill, now including older orders updated in the 60 days, is read again). Clear all data / demo remove the key. No schema bump (optional key).
- Keys starting with `_` are in-memory indexes and never written.
- A file is accepted as a store when it is a JSON object with `stock` and `orders` arrays (restore also needs `settings`).

### `year.json` (1.4.0, `src/year.js`, LOGIC §20)

```
{
  "v": 2, "zone": "Asia/Kolkata", "days": 400, "at": 0, "triedAt": 0, "ok": true, "done": true, "note": null, "error": "?",
  "sales":  { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "perDay": 31.2,
              "by":  { "<variantId>": { "YYYY-MM-DD": [units, net ₹, GST ₹, gross ₹] } },
              "all": { "YYYY-MM-DD": [units, net ₹] } },
  "moves":  { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "perDay": 33.1,
              "by":  { "<variantId>": { "YYYY-MM-DD": change } } },
  "anchor": { "at": 0, "day": "YYYY-MM-DD", "levels": { "<variantId>": stock } },
  "calls":  { "last": 39, "total": 39, "runs": [ { "at": 0, "n": 39, "ms": 47000 } ] }
}
```

- `sales.by` = ShopifyQL `net_items_sold`, `net_sales`, `taxes` and `gross_sales` (v 2, 1.4.1; v 1 held two numbers and is read again once) per variant per store day (ex GST, returns on the day they happened, so a day can be negative); `sales.all` = every row of the day, the rows without a variant too: the store total Shopify shows. `moves.by` = the day's net 'available' stock change. `from` / `to` = the oldest / newest store day read in full; today is held too and read again next time. A window read replaces its days whole.
- `anchor.levels` = the catalog's stock at the read (`at` = the pull's time), `anchor.day` = that store day; stock at the end of an earlier day = level − the changes after it.
- `perDay` = rows per day of the last read (sizes the next read). `calls.runs` keeps 30.
- A different `v`, time zone or span is read again from scratch. Clear all data empties it.

## ledger.json (2.0.0)

What is locked under a rule (RULE.md "Lock"), only ever added to, in backups: `{ v, rule, lists: { 'YYYY-MM-DD': { from, to, rows: [[variantId, rank, sold]] } }, months: { 'YYYY-MM': { at, list, score, low, high, n, parts } }, old: { rule: { lists, months } } }`.
