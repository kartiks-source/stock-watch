# Module: stock-watch (Stock-out Watch web app)

Read the root `AGENTS.md` first. This file is this module's working memory: keep it current.

## What it does

Shows a D2C brand which products to reorder before they run out, and how many ₹ every stock-out cost in sales. The user is the brand or its agency. The question it answers: "was a bad sales day the ads, or an empty shelf?"

**1.4.0: built for the agency first** (`.claude/skills/agency-perspective`, `.claude/skills/plain-copy`): prove to the brand, month by month over 12 months, which best sellers ran out, on which days, and the money that cost; what to push in ads and what to pause. Rail (restructured 24 Nov 2026, owner: "we can rehaul the thing"): **Brand report** (home, `#brand`) · **Best sellers now** (`#best`) · **Ads: push / pause** (`#ads`) · **Restock list** (`#reorder`) · **All products** (`#products`) · **Data**. Overview (`#overview`) and Stock-outs (`#stockouts`) still work by link, not in the rail.

Live: https://web-production-d8d7a911.up.railway.app. Opens a sign-in page; the password is the Railway variable `ADMIN_PASSWORD`. A signed cookie keeps you in for 30 days; Sign out is a POST to `/logout`. Scripts can still use Basic auth (any user name; the password may contain `:`). Optional `VIEW_PASSWORD`: a view-only sign-in that sees everything and changes nothing (server refuses every `/api` write with 403; LOGIC.md §13).

Login hardening (ADR-0011, SW-008): one limiter for the form and Basic auth, 10 wrong passwords per IP (last `X-Forwarded-For` hop, else the socket) and 100 across all IPs per 15 minutes → 429. When only the 100 cap is hit the password is still checked (right one passes, wrong one 429), so a stranger can't lock the owner out; the per-IP block is hard. With `NODE_ENV=production` (set in the Dockerfile) the app refuses to start unless `ADMIN_PASSWORD` is at least 12 characters. Cookies are signed with a random secret in `DATA_DIR/secret` (mode 600) plus a password fingerprint: changing the password signs everyone out; deleting the file does too.

## How data flows

```
Shopify (read-only GraphQL) ─┐
Shopify Flow → /ingest/*  ───┼─→ rows (stock changes, order lines) → store.json → engine → page
Google Sheet CSV / upload ───┘
```

- **Stock row:** `{ t, variantId, sku, product, variant, before, now, price, src }`, one per stock change.
- **Order row:** `{ t, order, variantId, sku, qty, price, src }`, one per order line.
- **Several stores (ADR-0015):** `src/stores.js` lists them (Performity brands; Key Vault `STORES`; `SHOPIFY_STORE`; no key → two demo stores). Each store's data is in `DATA_DIR/stores/<id>/`, the old single-store layout unchanged. Every request, pull, digest tick and daily backup runs inside `scope.run(id)` (`src/scope.js`, AsyncLocalStorage); per-store modules get their folder from `scope.dir()`, which **throws outside a store** (never a default). `?store=<id>` on every `/api` route and `/ingest/*` (else the `sw_store` cookie, else the first store); unknown id → 404. Pulls: one queue, one store at a time. First start moves an old single-store `DATA_DIR` into its home store, once per `DATA_DIR` (`src/migrate.js`, `stores.home()`).
- **One source per store (ADR-0009):** `src` = shopify / flow / sheet / csv / demo. With Shopify connected, `/ingest/*`, `/api/sync` and `/api/import` return 409; `/api/clear` and import return 409 while a pull runs. `/api/demo` returns 409 while the store holds real data (source `live`).
- **Catalog** (`store.json` → `catalog`, Shopify only): `{variantId → productId, product, variant, sku, type, tags, price, cost, status, tracked, active, stock, seenAt, inactiveSince, spells?}` (spells = past inactive spells of a variant made active again; the engine cuts stock-outs there), replaced on every pull (ADR-0010). Engine takes stock now and attributes from it; inactive variants are left out of reorder and overstock.
- **Engine** (`src/engine.js`, pure functions): stock-out episodes, in-stock sales rate, ₹ lost (weighted by the store's hour-of-day sales pattern), reorder status and quantity.

## Files

| File | Role |
|---|---|
| `LOGIC.md` | how every number is worked out and why; read it before changing `src/engine.js` |
| `CHANGELOG.md` | user-facing changes per version; the top heading = `package.json` version (`test/docs.test.js`) |
| `API.md` | every route: auth, query, answer, errors |
| `FORMATS.md` | every row format and stored file; `store.json` `schemaVersion` and how to migrate (SW-047) |
| `.env.example` | every variable the code reads, blank |
| `src/csvmap.js` | CSV import preview + column mapping (SW-045, LOGIC §1b): detects Shopify products / orders exports and our own logs, suggests our column ← their header, first 5 rows as read, Shopify rules (copy-down, cancelled/untracked/archived left out, line discount), mapping remembered per store + header set in `mappings.json`; parses through `rows.fromGrid` |
| `src/apiv1.js` | `/api/v1` (SW-050, ADR-0017): `rewrite()` maps `/api/v1/<x>` → `/api/<x>` (server.js, before routing, after the cross-site check); `handle()` = v1-only `GET /api/v1/summary` (report `totals`) and `GET /api/v1/rows` (cursor pages in variant-ID order, ≤ 500). API.md §v1 is the contract: add fields only |
| `src/version.js` | app version (`package.json`) + build commit (`RAILWAY_GIT_COMMIT_SHA`, `BUILD_SHA` env, or the `BUILD_SHA` file from `npm run stamp`) for `/health`, `/status`, `/api/report` `app` and the footer (SW-056) |
| `src/tz.js` → `public/tz.js` | the store's time zone (SW-049, LOGIC §0a): the ONE place for store-time days, hours, months and stamps; IANA zone with daylight saving; `zoneOf(settings)` |
| `src/log.js` | one-line JSON logs `{time, level, msg, store, …}` (SW-054); `captureConsole()` makes every `console.*` line JSON; every line scrubbed of `shpat_`/Bearer/X-Api-Key/`key=`; request line per API call (path only); boot line names set variables, never values |
| `src/lock.js` | one app per `DATA_DIR` (SW-055): `instance.lock` with a 30 s heartbeat, taken over after 2 min; without it the server refuses writes (503) and starts no work |
| `src/capacity.js` | capacity warnings (25 MB, 150k rows, disk 80%) for `/status` and Data (`public/ops.js`), LOGIC §14a |
| `server.js` | HTTP server, API, Flow ingest, sheet sync, Shopify pull every 2 hours by default, `SYNC_MINUTES` (one store at a time, `pullAll`), demo loader; `openStore` / `inStore` / `eachStore` run work for one store |
| `src/scope.js` | which store the current work is for: `run(id, fn)`, `id()`, `dir()` → `DATA_DIR/stores/<id>`; store id rule (uuid or `^[a-z0-9][a-z0-9-]{0,60}$`); `useDir()` for tests only |
| `src/stores.js` | the store registry (ADR-0015): `list()`, `refresh()` (Performity brand list, last good one kept in `DATA_DIR/stores.json`), `pick(?store, cookie)` → id or 404/503 |
| `src/migrate.js` | one-time, crash-safe move of an old single-store `DATA_DIR` into `stores/<home id>/` once per `DATA_DIR` (copy, SHA-256 check, marker, atomic rename, delete originals that still match) |
| `src/groups.js` | Group by (SW-022): rolls Products rows up by parent product, category, collection or tag, keyed by IDs (LOGIC.md §9a) |
| `src/catalog.js` | variant → product ID, type, tags (from the SW-002 store catalog snapshot, no second copy) and collections + members (read-only, 24 h cache, resumable) in `DATA_DIR/catalog.json` (LOGIC.md §9b); demo IDs, tags and collections from `demo.catalog()` |
| `src/engine.js` | all the maths (tested); `returnsOf` = units ordered / returned / cancelled / ₹ refunded per variant (SW-064, 1.1.3, LOGIC §9e); `demandQty` = units kept + returned after the sale (the rate's units) |
| `src/rows.js` | CSV / sheet / webhook → rows; refuses files without the required header columns, skips bad rows with a reason (LOGIC.md §1a); `csvCell` guards exports against formulas |
| `src/store.js` | JSON-file storage on the `/data` volume, de-duplication, 120-day retention. `schemaVersion` written on every save; `MIGRATIONS` bring older files up on load; a newer file is refused (SW-047). `endDemo()`: demo → live drops demo rows, Mark ordered and decisions, for every source (SW-007). Only a missing file starts blank; a bad file is copied to `store.json.corrupt-<time>`, `store.json.bak` (previous good save) is used, else the server refuses to start. Writes fsync before rename; a failed write retries (5 s, 30 s, 2 min) and turns `/health` 503 |
| `src/backup.js` | backups of `store.json` + `sideFiles` (`onorder.json`, `decisions.json`) in `/data/backups` (daily + before every replace/clear, 14 each), restore from `/data/restore.json` on start (side files too), `GET /api/export/backup.json`. Restore steps: `docs/RUNBOOK.md` |
| `src/sidefile.js` | `onorder.json` / `decisions.json` kept like `store.json`: a bad file is copied to `.corrupt-<time>` and never overwritten; `.bak` used instead; none → refuse to start (critic r2 X1) |
| `src/onorder.js` | "Mark ordered" records (`DATA_DIR/onorder.json`, one per variant: qty, eta, at, by) + `GET/POST /api/onorder`; the engine counts them (LOGIC.md §6b) |
| `src/access.js` | roles: admin / view password, role in the signed cookie, the 403 gate for view sessions (SW-029) |
| `src/people.js` | per-store access (SW-062, ADR-0016): people the owner makes (name, admin/view, stores) in `DATA_DIR/access.json` (scrypt hashes), password `<id>-<random>` shown once, person session cookie `exp.p.<id>.<gen>.sig`, `pick()` keeps a person to their stores (403), `/api/people` routes (owner only). Tests: `test/people.test.js`, browser `test/ui-people.test.js` |
| `src/audit.js` | settings change log `{at, by, key, old, new}` (SW-029) |
| `src/runs.js` | sync progress ("Syncing · 2,340 orders") and the last 20 runs: start, time taken, rows, error, notes (SW-030) |
| `src/keys.js` | where the Shopify key comes from: Performity POC API, Azure Key Vault or Railway variables; `access(storeId)`, caches per store; Performity calls paced (≥ 2.1 s, token calls per brand ≥ 6.1 s) |
| `src/shopify.js` | stock and order pulls (stock pull also returns the catalog), paced by Shopify's cost budget; every call through the read-only guard. Order lines keep `ordered` (line `quantity`), `returned` / `refund` / `cancelled` from `order.refunds` (1.1.3), `qty` = units kept; cancelled orders' lines kept with qty 0 (SW-064, 1.1.3); `reversalEvents` = cancellations / refunds with their own dates (1.1.5, LOGIC §9e; stored in `store.json` `reversals` via `store.replaceReversals`); backfill = `created_at OR updated_at` in the 60 days, older orders give events only; `ORDER_FIELDS` / `PRICE_BASIS` change → one 60-day re-read (server.js `pullOne`) |
| `src/cache.js` | 1.4.3, LOGIC §25: per-store data version (`bump` on every `store.save` and side-file write) and `memo(name, key, ttl, fn)`; server.js keeps the report per period, the brand report and the 12-month build (`yearBuild`, `lossPaceOf`) there; JSON and static answers gzipped (`send`, `serveStatic`). Perf test in `test/brand-api.test.js` |
| `src/year.js` | 1.4.0, LOGIC §20: 12 months of ShopifyQL `sales` (net_items_sold, net_sales) and `inventory_adjustment_history` ('available') by day × variant, 400 days, explicit dates (both ends in), reads sized under the 1,000-row cap (a capped read halved), the first load all at once (≤ 80 reads, `YEAR_FIRST_CALLS`), then ≤ 8 reads a run (`YEAR_CALLS_PER_RUN`), new days once a day; `year.json` per store (not backed up); `run()` after a good pull (server.js `pullOne`) and from `POST /api/shopify/year`; never throws. Tests `test/year.test.js` (fake ShopifyQL) |
| `src/agency.js` | 1.4.0, LOGIC §20–§22, pure: day in / out / half from the walked-back stock (oversells out, walks > 2 below min(now, 0) dropped), pace over in-stock days (6 / 12 months), seasonal index (blended with the shop's, 0.5–2.0), money missed per product per month, best sellers (top 80%), website allocations apart; `fromRows` = the same from the rows held (demo, Flow, Sheet, CSV); `variantYear` for the drawer. Tests `test/agency.test.js` |
| `src/sell.js` | 1.4.0, LOGIC §23, pure: `bestNow` (each best seller in / out since, this month's days out and ₹, refill state), `ads` (push = in stock, selling, ≥ 3 weeks of stock by ₹ a day; pause = §15c list) |
| `src/links.js` + `public/prod.js` | 1.4.0, LOGIC §19: product picture (Shopify CDN) and links (Open in Shopify = admin.shopify.com/store/<handle>/products/<id>, View on website = onlineStoreUrl / primary domain + handle, else Not on website) on report rows; `SW_PROD.cell/hero/links/csv` draw them in every row, the drawer and CSVs. Tests `test/links.test.js` |
| `public/profile.js` | 1.4.1, LOGIC §24: the product drawer as a 12-month profile (header with rank, story, key numbers, 12-month chart, price and discount, day calendar, stock level, season, month list, details); charts are inline SVG drawn when they scroll into view; data = `/api/product/:id` → `profile` (`agency.profile`). Tests `test/profile.test.js`, browser `test/ui-brand.test.js` |
| `public/brand.js` | 4.2.0: the home page is month first (LOGIC §31): sticky ◀ ▶ / 12 months bar, `#brand/YYYY-MM` · `#brand/12m`, Best sellers by default, three tiles, the month's list with a day strip and a ₹0 line, Past months with days to refill, "We started on" (`settings.agencyStart`, Data); server fields from `src/screen.js` (`brand`, `home`), tests `test/home.test.js`. 1.4.0: the Brand report, Best sellers now and Ads pages and the drawer's 12 months (`GET /api/brand`, once per load; reset after Mark ordered). Browser test `test/ui-brand.test.js` (1280/1440/1920, 390) |
| `src/history.js` | SW-063, LOGIC §1c: stock before the first Shopify read rebuilt from Shopify's change log (ShopifyQL `inventory_adjustment_history`, 'available', by hour, Admin API 2025-10, `read_reports`). `rebuild()` pure (walk back from the first read; first hour from order lines; below min(L0,0) → dropped), `validate()` order check (fail → variant dropped, > 1% → refused), `fetchChanges()` 7 store-time dates per query (both ends included; 1.1.0's `UNTIL -Nd` lost a day a week), split at the 1,000-row cap; `VERSION` 2 → older rebuilds redone on next pull; `run()` once per store after the first good pull (`shopify.historyRebuiltAt`) and from `POST /api/shopify/history`; rows `src: 'rebuilt'` via `store.setRebuilt`; never throws, outcome in `shopify.history`. Tests: `test/history.test.js` (fake ShopifyQL) |
| `src/gql-guard.js` | the read-only guard (SW-051): a GraphQL tokeniser (comments, strings, block strings as whole tokens); every top-level definition must be `query`, the `{` shorthand, or a fragment beside one. Tests: `test/gql-guard.test.js` |
| `src/token-scopes.js` | token permissions once per pull (SW-051): `currentAppInstallation.accessScopes`; own app (vault / variables) with any `write_*` → pull refused; Performity token → `shopify.writeScopes`, Data note, logged once per store |
| `src/sheet-fetch.js` | Sheet sync fetch (SW-052): link must be https docs.google.com; ≤ 3 redirects by hand, only to https docs.google.com / *.googleusercontent.com; ≤ 20 MB; 20 s. Tests: `test/sheet-fetch.test.js` |
| `src/helpers.js` | decision helpers on top of the report (LOGIC.md §15): why sentence + order-by date, still-out cost/day, PO CSV lines, Pause/Push lists, slow-seller Decide bucket. Pure, tested (`test/helpers.test.js`; HTTP in `test/helpers-server.test.js`; browser in `test/ui-helpers.test.js`, skipped unless `PLAYWRIGHT_PATH` points at a playwright package, `PLAYWRIGHT_CHANNEL=chrome` to use installed Chrome) |
| `src/supplier-rules.js` | SW-040, pure: which supplier a variant has (SKU map, else Shopify vendor), `roundOrder` (up to MOQ, then case pack), supplier CSV in/out (LOGIC.md §6c) |
| `src/policy.js` | 4.8.0 (LOGIC §35): `policy.json` per store (side file, in backups): the daily history of "Continue selling when out of stock", written after each successful stock pull; `alwaysOf` gives the engine true / false or day → true / false |
| `src/suppliers.js` | SW-040: `suppliers.json` per store (side file, in backups), demo terms seeded / cleared, routes `/api/suppliers*`, `/api/export/suppliers.csv` |
| `src/budget.js` | SW-041, pure: profit kept per ₹ on reorder rows (`annotate`, called by `helpers.enrich`), `rank` + one cut line `cut`; reorder CSV `?budget=` (LOGIC.md §6d) |
| `public/money.js` | Sprint 3 A-money UI, own script tag: Data → Suppliers, Reorder List / By supplier (PO draft per supplier, Copy + CSV), Budget ₹ (cut line, rows over budget dimmed). Hooks in app.js: `SW_MONEY.init/rows/cols/bar/qs/poView/after/panel`. Browser test `test/ui-money.test.js` |
| `src/decide.js` | slow-seller decisions (keep/drop/clear) in `DATA_DIR/decisions.json`; `GET/POST /api/decide` |
| `src/period.js` | periods (1.1.5: N store-calendar days, today included, `tz.daysStart`; "This month") and the Yesterday strip (SW-027) |
| `src/digest.js` | morning digest text per role, pure (SW-028) |
| `src/digest-service.js` | digest routes, outbound webhook, daily schedule at a store-time hour, send log in `store.digest` |
| `public/stores.js` | the store picker (ADR-0015, LOGIC §18): `SW_STORES.url(path)` adds `?store=` to every page call; pill menu + phone store bar with status dots (the phone bar also shows the role and holds the role list, `#role-menu-m`, filled by `SW_ROLES.paint()`) (classes `s-ok` / `s-stale` / `s-error`: `.stale` is the banner), list re-read every minute, menu scrolls inside the window; choosing sets `?store=`, `localStorage` and the `sw_store` cookie, then reloads. Browser test `test/ui-stores.test.js` |
| `public/roles.js` | role home views (SW-020): switched off in the UI since 20 Nov 2026 (brand switch only; clears `sw-role`, drops `?role=`); pure functions kept, also read by the digest |
| `public/tz.js`, `public/ops.js`, `public/trial-input.js` | store time helper (SW-049); Data notice for capacity / read-only (SW-055); number boxes that keep raw text, read on Enter / leave, hint when invalid (SW-057; browser test `test/ui-trial.test.js`) |
| `public/people.js` | Data → People (owner only, SW-062): add / edit / new password / remove; the new password is shown once with Copy |
| `public/import-ui.js` | Data → Upload a CSV preview (SW-045): file / kind / select change → `POST /api/import/preview`; mapping selects + 5-row sample in `#imp-preview`; `SW_IMPORT.query()` adds `&map=` to the upload in app.js; Upload stopped on the page while a needed column is unmapped. Browser test `test/ui-import.test.js` |
| `public/digest-ui.js` | Overview Share menu (copy / WhatsApp) and Data → Morning digest settings |
| `src/weekly.js` + `public/weekly.js` | weekly review (SW-043, LOGIC §5b): a daily snapshot of the headline numbers per store in `snapshots.json` (first report / pull after store-midnight, last 14 days filled in, 400 kept); `GET /api/review`; Overview panel "This week vs last week" + top 5 movers; one digest line (Founder / Everyone) |
| `src/targets.js` + `public/targets.js` | monthly ₹ targets per group (SW-042, LOGIC §9c) in `targets.json`; `GET/POST /api/targets`; "Target this month" column on group views: month to date, run-rate forecast with / without stock-outs, light |
| `src/lists.js` + `public/lists.js` | paste-a-list on Products + saved lists (SW-044, LOGIC §9d) in `lists.json`; `GET/POST /api/lists`; `match()` is pure (node test). Browser test for all three: `test/ui-review.test.js` |
| `src/demo.js` + `src/demo-catalog.json` | 60-day demo on Sammsara's public catalog (255 variants); stock and sales invented |
| `public/` | the page (plain JS, no build step), styled like the Performity app: tokens at the top of `styles.css` |
| `test/` | `node --test` (`npm test`): `engine`, `shopify`, `rows` (parsing, table-driven), `server` (spawns the real server on a free port + temp DATA_DIR: auth, limiter, headers, ingest, 400s), `store` (incl. schemaVersion, demo → live on every path), `backup`, `docs` (fences, SECURITY.md, CHANGELOG = version), `version`, `apiv1` (SW-050: v1 = old paths, auth, summary = totals, rows paging), `csvmap` + `import-api` (SW-045, real-shaped Shopify exports in `test/fixtures/`); multi-store: `stores` (ids, registry incl. the stand-in API with 2 brands, migration), `multistore` (real server, two demo stores never mix, 404s, cookie, view-only), `scheduler` (one pull at a time); browser (`npm run test:ui` at the root, Playwright): `ui-helpers` (phone checks at 390x844 and 360x740, group sparks, footer version), `ui-stores` (picker desktop + 390/360, one store, defaults), `ui-import` (SW-045 preview at 1440 + 390), `ui-returns` (SW-064 Returns % column, High returns chip, drawer line, 1440 + 390); module tests point a module at one folder with `scope.useDir()`; `parity.test.js` checks the Google Sheet's maths against `engine.js`. `test/smoke/` is a Playwright smoke run on demand, not part of `npm test` |

## Shopify access (decided 19 Nov 2026)

- Pull straight from Shopify into our own storage. **No connection to the dev team's database.**
- Shopify credentials are the app's **client ID + client secret** (Dev Dashboard app, same Shopify organisation as the store); `src/keys.js` swaps them for a 24-hour token (client credentials grant) and renews it. A legacy `shpat_` token still works.
- Key source 1: **Azure Key Vault**, secrets `shopify-<store>-client-id` and `shopify-<store>-client-secret` (or one `shopify-<store>` JSON secret). Variables: `AZURE_KEY_VAULT_URL`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `SHOPIFY_STORE`.
- Key source 2 (stop-gap): `SHOPIFY_STORE` + `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`.
- Fallback if tokens can't be shared: our own read-only Shopify app (not built).
- Scopes needed: `read_products`, `read_inventory`, `read_orders`; `read_reports` for the stock history rebuild (SW-063; without it the rebuild is skipped with a note).
- Once a key source is set, the app refuses to start without `ADMIN_PASSWORD`, and demo data is turned off.

## Role views and digest (Sprint 2 · B-roles)

- Roles are switched off in the UI (20 Nov 2026, user: "remove roles, just keep it brand switch"): the store pill only switches brands, no role menu, no *Show me*, everyone sees everything; old `?role=` links and a remembered `sw-role` are dropped. Code kept in `public/roles.js` (pure functions, `test/roles.test.js`) in case they come back; rules as they were in LOGIC.md §16. The roles smoke was deleted.
- Digest: LOGIC.md §17. Optional variables `DIGEST_WEBHOOK_URL`, `DIGEST_WEBHOOK_URL_<ROLE>` (per-role recipient), `PUBLIC_URL`. Env only, never saved from the page. Without a webhook nothing is sent; Share → Copy / WhatsApp still works.
- Warehouse home = Reorder → Ordered: every open PO (part, late, too late), late first, *Lands* + *On order (pcs)*, headline "N on order · M due this week · K late"; warehouse digest lists the same (`helpers.onOrderRows` / `onOrderSummary`, LOGIC §6b). Marketing home = Products → Pause promotion.
- Smoke (`test/smoke/smoke.js`): refuses a `SMOKE_PORT` already in use and fails when the app dies or no check runs.

## Railway variables now

`ADMIN_PASSWORD`, `RAILWAY_RUN_UID=0` (the container starts as root; `scripts/entrypoint.sh` chowns `/data` to `node` once and drops to `node` with su-exec, SW-053), with a volume at `/data`. No Shopify variables yet, so it shows the demo.

## Running in production

- Runs under tini (Dockerfile). SIGTERM/SIGINT: timers stop, a running Shopify pull gets up to 25 s (`STOP_WAIT_MS`), the store is written, then the process exits.
- `/health`: 200, or 503 while saving fails; carries `version` + `sha`. Railway health check set in `.railway/railway.ts`.
- `/status` (no login, for an uptime monitor): `{ok, version, sha, stale, ageMin, lastPull, shopify, running, pullFailing, saveOk, source, storeBytes, stockRows, orderRows, variants, uptimeMin}`; 503 when the last Shopify pull is > 45 min old or saving fails. No names, keys or error text. `/api/report` carries the same `freshness` for the stale-data banner (UI: stream E).

## Commands

```bash
npm start          # http://localhost:4400 (demo data on first run)
npm test           # unit + server tests, no dependencies (browser tests skip)
# at the repo root (Playwright 1.65.1: npm ci, or PLAYWRIGHT_PATH=…; PLAYWRIGHT_CHANNEL=chrome for installed Chrome):
npm run test:ui    # test/ui-helpers + test/ui-stores in a real browser (1280–1920, 390x844, 360x740)
npm run test:smoke # test/smoke/smoke.js (SMOKE_OUT=folder keeps the screenshots)
npm run stamp      # before `railway up`: writes BUILD_SHA so /status and the footer name the commit (docs/RUNBOOK.md)
ADMIN_PASSWORD=x SHOPIFY_STORE=brand SHOPIFY_CLIENT_ID=… SHOPIFY_CLIENT_SECRET=… npm start
```

## Status

- Done: engine, page, Flow/Sheet/CSV ingest, read-only Shopify pull with Key Vault, Railway deploy, Sammsara demo.
- Sprint 1 security (SW-008/009/010/016/017/018): login limiter + prod password check, session secret in `DATA_DIR/secret`, POST logout, ingest key in the `X-Ingest-Key` header only (≤ 500 rows/request), strict CSV import, security headers + same-origin writes, CSV formula guard, 400s for bad input.
- Before the next deploy: Railway `ADMIN_PASSWORD` must be ≥ 12 characters (the Dockerfile sets `NODE_ENV=production`, so a shorter one stops the app starting). Flow workflows using `?key=` keep working but should move to the header.
- Sprint 1 (E-ui): plan bar Save/Reset fixed (SW-011); "Mark ordered" for ticked Reorder rows (bulk bar; phone cards have the tick too) and in the drawer, with an Ordered tab (SW-012; the per-row button went in critic round 1, S2: one control per row); trend bars in the Products/Reorder rows, phone cards and drawer, Overview "Moving" card by ₹ effect (SW-021; group rows wait for SW-022).
- Sprint 2 D-helpers (branch `sprint2/D-helpers`): SW-024 Why cell + order-by + still-out ₹/day, SW-025 reorder CSV as a PO (`?filter=&q=`, vendor, unit cost, variant ID), SW-026 Pause / Push chips on Products, SW-032 slow-seller Decide bucket.
- Sprint 2 merged on `main` (C-access, D-helpers, A-groups, B-roles + integration fixes, see docs/DEVLOG.md): one `reportOpts()` for report, groups, drawer, CSV and digest; roles cover Sprint 1/2 controls per RACI.
- Multi-store (ADR-0015, branch `feature/multistore`, 0.10.0, merged to main in 3ba75af): registry, per-store folders, migration, `?store=` everywhere, sequential pulls, per-store alerts / digest / backups; store picker in the top bar (`public/stores.js`, phone store bar). Show everything by default (ADR-0006 amendment): no role, Reorder → All, optional columns on (step aside when they don't fit), every Overview panel. Critic round fixed (ISO-1 migration once per DATA_DIR, SEC-1 no Performity call unless ready, UI-1..UI-6 picker; DEVLOG 2026-11-20).
- 1.0.0-rc.1 (finish sprints, last gaps, DEVLOG 2026-11-20): version + SHA on `/health`, `/status`, footer (SW-056); `schemaVersion: 1` (SW-047); group-row sparks (SW-021); demo → live clears Mark ordered + decisions on every path, dead import checkbox gone (SW-007); digest settings in the change log (SW-029); ui-helpers at 360x740 too. CI: job `test` (npm test, Node 20/22) + job `ui` (npm run test:ui, smoke, roles smoke, screenshots artifact).
- Sprint 3 C-access (branch `sprint3/C-access`): SW-051 tokeniser read-only guard + write-scope check, SW-052 fenced Sheet fetch, SW-062 per-store people (Data → People, `access.json`, ADR-0016).
- Waiting on: Key Vault access from the dev team (vault URL, tenant, app ID, secret, token format), and Performity's repo to align conventions.
- Group by (SW-022, branch `sprint2/A-groups`): "View: Products ▾" on Products; `GET /api/groups?lens=product|type|collection|tag[&all=1]` (no lens: lenses on offer). Variants come from `store.catalog` (SW-002); `/api/groups` uses the same report options as `/api/report` (integration).

- Sprint 3 A-money (branch `sprint3/A-money`): SW-040 suppliers (terms, SKU map, MOQ / case-pack rounding, supplier lead time, By supplier PO drafts) and SW-041 Budget ₹ cut line. ADR-0018. `test/ui-money.test.js` is not yet in the root `test:ui` script (module `npm test` runs it, skipped without Playwright).

- Stock history (SW-063, branch `feature/stock-history`): past stock rebuilt from Shopify's change log after the first pull (Data line + Rebuild button, Stock-outs note); Stock-outs counts "Out but not selling" apart.
- 1.1.1 number validation fixes (DEVLOG 2026-11-20): history windows/first hour/order check, order prices ex GST (one 60-day re-read), weekly snapshots retaken on `calc` change, still out vs not selling, low data, pace qty, at-selling-price labels. Not deployed.
- 1.1.1 UI + mobile fixes (DEVLOG 2026-11-20): `totals.stockouts` without not-selling (+ `stockoutsNotSelling`, episode `notSelling`), sale inside a stock-out moves its start (`engine.afterLastSale`), row `historyFrom` (drawer hatch / Data list / "Out since before"), `gift` (out of budget rank), Order today sorted by ₹/day, no-cost headline by count, weekly panel flows only, slow sellers out of Biggest losses, phone CSS (M5–M10), Suppliers count = listed products. Not deployed.
- Returns % per product (SW-064, branch `feature/returns`, LOGIC §9e): order lines keep `ordered`; Products column Returns % + High returns chip (15%+, 5+ units), drawer Returned line, totals; one 60-day re-read (`shopify.orderFields`). Demo VERSION sammsara-8. `test/ui-helpers.test.js` still expects 6 Products chips (now 7 with High returns): left for the integrator (another branch edits that file). Not deployed.

- 4.8.0 (branch `stock-health`): stock-log health label `stockSeen` (unseen / always / unsure / ok) on the drawer and brand page, labels only; keep-selling history in `policy.json`, applied day by day (no money change until a flip is recorded). - 4.7.0 (branch `scorecard`): per-brand scorecard in "How sure are we?" (`score` on /api/brand); the 4.7 blend was rejected (branch `rule-4.7-blend`, not merged). 4.6.2: Shopify's words (Net sales, Missed sales, Net sales if in stock); All products sorted by missed sales. - 4.6.0 (branch `agency-views-4.6`): brand report tiles Sold · Missed · Could have sold · Out now; 60+ day ₹ shown apart; All products Could have sold column. 4.5.1 (branch `busy-working`): parts carry `base` + `bdays`; the product panel shows the busy number day by day. 4.5.0 (branch `rule-4.5-no-trim`): no trim; missed = speed × busy × days × price. 4.4.0 (branch `rule-4.4`): money needs 3+ pieces; out-too-often products use their last 60 in-stock days within the year (`fb`). 4.3.x brand factor and 4.2.0 home: merged and live.
- 1.4.0 agency proof (branch `feature/agency-proof`, DEVLOG 2026-11-24): Brand report, Best sellers now, Ads, pictures + links, 12 months from ShopifyQL, seasonal pace (also for long stock-outs' ₹ lost on every page). Checked live on Sammsara (read-only). Not pushed, not deployed; critic round still to run.

## Next

1. Connect the first real store via Key Vault; compare 10 days of orders and stock for 10 SKUs against Shopify admin.
2. Alert when a pull fails or data is older than expected.
3. Move storage to Postgres when the stores together pass ADR-0003's triggers (sum of `/status` `storeBytes`), or a store needs more than a few months of data.
4. Push stock changes through Shopify Flow too, so stock-outs are timed to the minute rather than to the pull (every 2 hours by default).
