# Stock-out Watch: backlog

Built from the 19 Nov 2026 review by eight roles (architect, security, QA, SRE, product/RACI, DAWBU idea miner, process/docs, token optimiser). Duplicate findings are merged into one item; "Source" names every role that raised it.

Owner priorities, in order: cut costs, make decisions smoother, more profit. Simple UI anyone can use, no wasted space, Performity look, production-grade.

Format per item: **ID · title** (priority · size · owner role) · why · acceptance criteria · source.
Sizes: S ≤ 1 day, M 2–4 days, L 1–2 weeks of agent work. Owner roles: builder, QA, security, ops, product.
Every item follows `docs/DEFINITION-OF-DONE.md`. Every item that touches `public/` also gets the mobile critic + fixer pass.

**Status** (checked against `main` and `docs/DEVLOG.md`, 20 Nov 2026, finish-sprints W1-docs): each item has a `Status:` line. **Done** = acceptance criteria met on `main` (not deployed: nothing since Sprint 1 is live). **Partial** = what's left is named. **Accepted departure** = built differently from the original criteria on purpose; the criteria are amended and the reason given.

---

## Sprint 1 — production-ready (must)

Goal: the numbers can be trusted at real store size, data can't be lost silently, and the login holds. Nothing here adds UI. Sprint 1 is done when every P0 and P1 below is closed and `docs/MODULE-STANDARD.md` §Production-ready is ticked.

### P0: wrong numbers or the whole app down

**SW-001 · Report survives any data size** (P0 · S · builder)
- Why: past ~124k order lines or stock rows, `Math.min(...arr)` throws, and Report, product drawer and CSV all return 500. A store selling ~1k lines/day reaches this inside the 120-day window. The app goes down exactly when the brand grows.
- Accept: no spread into `Math.min/max` anywhere in `src/` (engine.js:171, :174, :316-319 replaced by one `minMax()` loop helper). Test: `report()` on 300k synthetic order lines + 200k stock rows returns in < 1.5 s with no throw and no NaN/Infinity in the output.
- Source: architect A1, QA F1, SRE-1.
- Status: Done (d93edff). 300k + 200k rows ~0.4 s.

**SW-002 · Current stock never disappears (dead stock, archived items)** (P0 · M · builder)
- Why: the 120-day prune deletes the only stock row of an item that hasn't moved, so dead stock (the cash the owner wants freed) shows "No stock data" and drops out of Overstock. Archived or untracked items keep their old row and inflate overstock cash. Cost, price and type changes are ignored until stock moves, so profit maths uses stale cost.
- Accept: `db.catalog` {variantId → productId, product, variant, sku, type, tags, price, cost, status, stock, seenAt} replaced on every stock pull. Engine reads current stock and attributes from the catalog; stock rows are history only. Prune keeps the newest row per variant and the opening row of any open stock-out. Variants that turn archived/draft/untracked are marked inactive and left out of reorder and overstock; the Data page shows "Excluded: N archived/draft, X pcs". Tests: variant unchanged 130 days still shows stock and counts in overstock ₹; stock-out open 130 days still in Out now; archived variant is not in `excessValue`; a cost change shows on the next pull without a stock move.
- Source: architect A3, DAWBU F1 + F2.
- Status: Done (54933ca; integration moved Group-by variants onto this snapshot).

**SW-003 · Long stock-outs keep their demand (biggest losses stay visible)** (P0 · M · builder)
- Why: a best seller out for the whole 28-day window gets rate 0, so it shows as "Slow seller", ₹0 lost, and drops off Reorder. The costliest stock-outs vanish from both lists, which is the product's core job.
- Accept: when in-stock days in the window are < 7, the rate uses the most recent 28 in-stock days within KEEP_DAYS; if none, the rate before the stock-out began. Test: 5/day at ₹1,000, out for the last 30 days → status Out now, orderQty > 0, lost ≈ 30 × 5 × ₹1,000 (±5%). LOGIC.md §3 and ADR-0005 updated.
- Source: QA F3.
- Status: Done (1504ce5; Sheet ported in critic round 1).

### P1: data loss, security, broken controls, silent bad data

**SW-004 · Store never silently replaced or lost on a bad write** (P1 · M · builder + ops)
- Why: any read/parse error on `store.json` becomes a blank store; demo then overwrites it and a new ingest key breaks Flow. A full or read-only disk crashes the process after the API already said ok. Stock-out history can't be rebuilt from Shopify.
- Accept: only ENOENT gives a blank store. Any other error: copy to `store.json.corrupt-<ts>`, try `store.json.bak` (kept on each good save), else log one clear line and exit 1 without writing. Writes fsync the temp file before rename. Debounced write is wrapped in try/catch with retry (5 s, 30 s, 2 min) and `lastSaveError`. SIGTERM/SIGINT: stop timers, wait for the running pull, `save(true)`, close. Image runs under tini (or `--init`). `/health` returns 503 while the store failed to load or saves fail. `railway.json` sets `healthcheckPath: /health`. Tests: corrupt file → quarantined, not overwritten; read-only DATA_DIR → no crash, /health 503.
- Source: architect A2 + A10, QA F6, SRE-2, SRE-3, SRE-5, SRE-6.
- Status: Done (a8d9147; tini in the Dockerfile, `railway.json` health check).

**SW-005 · Backups and a tested restore** (P1 · M · ops)
- Why: one file holds history Shopify can't resend. Clear, demo→live and import-replace wipe it with no snapshot.
- Accept: Railway volume backups on (daily, keep ≥ 7). App writes `DATA_DIR/backups/store-YYYYMMDD.json` daily and before every replaceAll/clear; keeps 14. Authed `GET /api/export/backup.json`. `modules/stock-watch/RUNBOOK.md` has restore steps, and one restore drill is done and logged in DEVLOG.
- Source: SRE-4, process F6, SRE runbook ideas.
- Status: Partial. Done: daily + before-wipe backups (14 each), restore on start, `GET /api/export/backup.json`, drill 19 Nov (313cae3). Departure: restore steps live in `docs/RUNBOOK.md` (one runbook for the repo), not `modules/stock-watch/RUNBOOK.md`. Done since: `onorder.json` and `decisions.json` ride in every backup, the export and restore as `sideFiles` (df5dc27). Open (owner: you, Railway dashboard): turn on / confirm Railway volume backups for `web-volume` on the new project (RUNBOOK §Backups has the monthly check). App-level backups cover it meanwhile.

**SW-006 · One source of truth per store (no double-counted sales)** (P1 · M · builder)
- Why: Shopify pull, Flow, Sheet sync and CSV import write the same arrays with different dedupe keys, so the same sale counts twice; Sheet sync keeps running after Shopify is connected. Inflated sales mean inflated reorder quantities, which is real cash.
- Accept: every row carries `src`. When Shopify is the source, `/ingest/*`, Sheet sync and import return 409 with a plain message (and Sheet sync stops). `/api/clear` and import return 409 while a pull is running. ADR-0009 accepted. Tests: Shopify connected + ingest → 409; same order via two paths never doubles `totals.sold`.
- Source: architect A5 + A4, security SEC-3.
- Status: Done (e1da9e0, ADR-0009).

**SW-007 · Demo data never mixes with real data** (P1 · S · builder)
- Why: real rows added on top of demo stay labelled "demo" and are deleted on the next demo version bump.
- Accept: the first real row (ingest, sheet, import) clears demo first and sets source to live. Demo loads at boot only if the store was never live (`everLive` persisted). Test: demo → ingest → restart with bumped demo version → real row still there.
- Source: QA F6.
- Status: Done (67e2345). Finish sprints (1.0.0-rc.1): demo → live by Flow, Sheet, CSV or Shopify also clears the demo's Mark ordered and decisions (one `store.endDemo()`; tested per path), and the dead "Remove the demo data first" import checkbox is gone.

**SW-008 · Login can't be brute-forced; app never runs open in production** (P1 · S · security)
- Why: Basic auth on `/api/*` has no attempt limit, the lockout trusts a client-set X-Forwarded-For, and a deploy without `ADMIN_PASSWORD` serves everything, including Clear and the ingest key.
- Accept: one limiter covers form login and Basic auth; IP = last XFF hop (or socket address); global cap 100 fails / 15 min; failure map swept and capped at 10k. Passwords containing `:` work. With `NODE_ENV=production`, start fails if `ADMIN_PASSWORD` is missing or < 12 chars. Session HMAC keyed by a random secret in `/data/secret` (mode 600) plus a password fingerprint, so a password change still signs everyone out. Logout is POST. Tests: 11 Basic failures → 429; spoofed XFF still 429; prod without password exits 1.
- Source: architect A9, security SEC-1 + SEC-5 + SEC-4, QA F7.
- Status: Done (Sprint 1 C-security; global cap softened in critic round 1, SEC-1).

**SW-009 · Ingest key out of URLs and logs** (P1 · S · security)
- Why: UI and README hand out `?key=` URLs, which land in proxy and Flow logs (breaks repo rule 7). A leaked key can post fake stock-outs that change reorder money.
- Accept: UI and README show the `X-Ingest-Key` header form only; `?key=` still accepted but logged as deprecated. Max 500 rows per request (413 above). Key shown masked with reveal; last rotation time shown. Test: 501 rows → 413.
- Source: security SEC-3, process F5, SRE-11.
- Status: Done (Sprint 1 C-security).

**SW-010 · CSV import refuses bad files instead of storing garbage** (P1 · M · builder)
- Why: wrong headers, blank stock, "₹1,299" prices, US dates and semicolon files import "successfully" as phantom stock-outs, ₹0 prices or future dates. These feed reorder decisions.
- Accept: header detection always runs; exact names beat aliases; `variant` is no longer a variant-ID alias; `collection` is no longer a type alias. Missing required columns → 400 naming them. Numbers parse `₹`, commas and spaces; blank stock skips the row. Month 1–12 and day 1–31 enforced; US `11/15/2026` rejected; date-only = 00:00 store time; unreadable time or t > now + 1 day skipped in CSV/Sheet (stamp-now only for Flow). `;` delimiter detected. Response and toast give skip reasons {badTime, badNumber, noId, tooOld}; counts are after prune. Table-driven `test/rows.test.js` covers every case above.
- Source: QA F4 + F5 + F8.
- Status: Done (Sprint 1 C-security, `test/rows.test.js`).

**SW-011 · "Save as default" and "Reset" on the plan bar work** (P1 · S · builder)
- Why: both buttons are dead (inside `<summary>`, app.js:123/518), so trial assumptions can't be saved or undone from Reorder.
- Accept: buttons sit outside `<summary>` or the handler skips buttons. Playwright: lead 10 → Reset → headline back to baseline; lead 10 → Save → reload keeps 10.
- Source: QA F2.
- Status: Done (2805329).

**SW-012 · "Mark ordered": the list clears once a PO is placed** (P1 · M · builder + product)
- Why: plan uses on-hand stock only, so the Order today list (78 rows, ₹32.67 L in demo) shows the same lines tomorrow. Duplicate POs waste cash.
- Accept (amended 20 Nov 2026): per-variant `onOrder {qty, eta, by, at}` stored; "Mark ordered" from a row tick + bulk bar (desktop and phone cards) and the drawer, not a per-row button. Plan uses stock + on-order arriving before stock-out. Row shows "Ordered · lands 25 Nov" and leaves Order today; past ETA → back to Order today in red. Test + LOGIC.md §6 section. No new page: one button and one status.
- Source: product F1 + idea "Mark as ordered".
- Status: Done, with an accepted departure (critic round 1, S2): no per-row button. Rows are ticked and marked from one bulk bar (*Mark N ordered*; phone cards have a 44 px tick); edit and remove are in the drawer. One control per row kept the 1280 px table readable (Best seller tags clipped 16/41 → 6/41). Warehouse sees every open PO on Reorder → Ordered.

**SW-013 · Sheet and web app give the same ₹ lost** (P1 · M · builder + QA)
- Why: the Sheet counts a whole stock-out instead of the 30-day window (2× in one repro), so two Catalys tools disagree on the headline number.
- Accept: Sheet clips to max(start, now − 30 d). Sheet maths moves into a pure `SW.compute()`. `test/parity.test.js` loads the .gs in `vm` and runs 6 fixtures through both; same status and order qty, ₹ lost within 2%; intended differences listed in an allowlist. Root `npm test` runs it.
- Source: QA F11 + parity idea, architect A8 (parity part), process F11.
- Status: Done (1f15a3a; eight parity fixtures).

**SW-014 · Test suites and a CI gate** (P1 · M · QA)
- Why: 28 tests cover engine and Shopify only. Every bug in this sprint slipped through untested routes, store and parsing.
- Accept: `test/server.test.js` (in-process server on temp DATA_DIR: auth, lockout, settings 400s, import 413, ingest, export, clear, demo→live), `test/store.test.js` (dedupe, prune, corrupt file), `test/rows.test.js`, `test/engine-edge.test.js`, Playwright smoke at 1440×900 and 390×844 (no console error, no sideways scroll, Reset/Save, drawer, import). `.github/workflows/test.yml` runs `npm test` on push and PR. Deploys only from a clean, green `main`.
- Source: QA F12 + test ideas, architect "integration tests" idea, SRE-9, process F4 + F11.
- Status: Done (1.0.0). Done: server, store, rows tests (edge cases live in `test/engine.test.js`, no separate `engine-edge` file); `.github/workflows/test.yml` runs `npm test` on Node 20 + 22 for every push and PR. Done since: CI job `ui` runs `test:ui`, the smoke and the roles smoke (`.github/workflows/test.yml`). Closed at 1.0.0.

**SW-015 · Docs that agents and users rely on are correct** (P1 · S · builder)
- Why: LOGIC.md:306 says returns aren't netted (the pull nets them); ORCA.md says three critics, has a broken fence and feeds critics `git log -p -3` (wrong range, ~48k tokens); deploy docs say "main deploys" but deploys are a local `railway up`; there's no SECURITY.md.
- Accept: LOGIC §11 split by source, §12 links to the Sheet LOGIC.md as the single list of differences. ORCA.md: "Five critics", one fence per critic, diff = `git diff $BASE..HEAD -- <role paths>`. AGENTS.md:47 and ORCA.md:67 name the real deploy command. `SECURITY.md` lists every secret, where it lives, how to rotate it, the auth model and destructive endpoints. Doc-fence check added to `npm test`.
- Source: process F1, F2, F3, F5; tokens T1, T3, T8; SRE-9.
- Status: Done. `SECURITY.md` refreshed 20 Nov 2026 for the Performity key, alert and digest webhooks, `VIEW_PASSWORD`, the session secret and the Sprint 2 write routes; `API.md`, `FORMATS.md`, `CHANGELOG.md` added.

### Sprint 1 stretch (P2, small, do if capacity)

| ID | Title | Size | Owner | Accept | Source | Status |
|---|---|---|---|---|---|---|
| SW-016 | Security headers + same-origin check on writes | S | security | CSP, nosniff, Referrer-Policy, HSTS on https, frame-ancestors none; non-GET /api with cross-site Origin → 403 (test) | SEC-6, SEC-8 | Done |
| SW-017 | CSV formula injection guard in both exports | S | security | text cells starting `= + - @ \t \r` get a leading `'`; test with `=1+1` SKU | SEC-2, QA F9 | Done (both CSVs + Pause/Push) |
| SW-018 | Bad input → 400, not 500 | S | builder | bad JSON, `null` body, bad URI → 400; settings body limit 64 KB; constant-time compare via HMAC; static path check uses `PUBLIC + path.sep` | A11, SEC-10, QA F8 | Done |
| SW-019 | Stale-data banner + unauthed `/status` | S | ops | "Data is X h old" when Shopify pull > 45 min old; `/status` 503 when stale; uptime monitor pointed at it | SRE-7 | Partial: banner + `/status` done (963233f, 1567912); external monitor documented in `docs/RUNBOOK.md` §Uptime monitor, not yet set up (owner) |

---

## Sprint 2 — value for every role (CEO → doer, RACI)

Goal: each role sees its one decision first, with less on screen than today. See `docs/RACI.md`. Rule for every item: **role views remove UI per person; they never add pages for everyone.** The simplicity and mobile critics reject any item that grows the default view.

**SW-020 · Role home views (less UI per person)** (S · product + builder)
- Why: everyone sees 4 tiles, 5 tabs and the Data page; most of it is noise for any one person.
- Accept: role picker on first open or `?role=` link (localStorage). Each role sets home page, tiles and default columns per `docs/RACI.md`. Every role view shows fewer elements than today's default (count checked in the Playwright smoke). Default with no role = today's view.
- Source: product idea "Role home views", simplicity rule.
- Status: Done, with an accepted departure: the role comes from the store menu, Data → Show me, or a `?role=` link; there is no first-open picker (it would add a step for everyone, against the rule above).

**SW-021 · Trend built into the decision rows** (M · builder) — owner ask
- Why: trend lives only in the drawer and an off-by-default column, so it doesn't inform reorder or overstock calls.
- Accept: one combined cell (48×16 spark + chip) on Products, Reorder and group rows at ≥ 1400 px; below that a 40×12 inline spark in the name cell (no extra column); on phone cards at the header's right. Rose base kept for stock-out weeks. Hover labels show dates ("12–18 Nov: 54 sold, out 2.3 d"). Store baseline (the typical product's trend) shown in the Trend column header and in each chip's tooltip, not as a toolbar chip (amended 20 Nov 2026). Drawer shows the 8 weekly numbers under the spark. Overview "Moving" card: top 3 up / down by ₹ effect. No new page.
- Source: DAWBU F8 + idea "Trend everywhere it decides".
- Status: Done, with an accepted departure (critic round 1, S1): the store baseline (the typical product's trend) is in the Trend header and every chip's tooltip, not a toolbar chip. The chip colour already says "better or worse than typical", so a separate chip was noise. Group rows have the chip since critic round 2 (UI-3) and the 8-week spark since 1.0.0-rc.1 (summed weekly units per group, rose when a variant was out; `groups.js` `weeks`, LOGIC §9a).

**SW-022 · Group by product / category / collection / tag** (L · builder) — owner ask
- Why: the client's team plans and sets targets on tags and collections (DAWBU). Today only productType exists.
- Accept: STOCK_Q adds `product{id tags}`; collections and memberships fetched read-only, cached 24 h, resumable; catch-all collections (≥ 80% of products) hidden by default. "View: Products ▾" replaces the Category select (one control, no new tab). Group rows: Products (n) · Need order (x of n) · Sold · Sales lost · Profit lost · Order ₹ · Overstock ₹ · Trend. Click → Products filtered with a removable chip. Tag/collection lens has no grand total, only a footnote with the distinct store total. All keys are IDs, never titles. Test: parent-product lens sums to report totals.
- Source: DAWBU F3, F4, ideas "Catalog groups fetch", "Group by switch".
- Status: Done (29f8e8e; group totals = report totals, tested).

**SW-023 · Mobile pass on every Sprint 2 screen** (M · builder (mobile fixer) + QA)
- Why: owners and ops check on phones.
- Accept: mobile critic + fixer run at 390×844 and 360×740 on every Sprint 2 change: decision first, touch targets ≥ 44 px, no sideways scroll, 1280/1440 unchanged. Screenshots attached to the PR.
- Source: owner ask, AGENTS rule 10.
- Status: Done. Mobile fixes M1–M10 at 390 and 360 (critic round 1, final integration); smoke and roles smoke run 390×844 and 360×740 with screenshots in `SMOKE_OUT` (CI uploads them); `test/ui-helpers.test.js` runs its phone checks at both sizes too (1.0.0-rc.1).

**SW-024 · Plain "why" and dates on every reorder row** (S · builder)
- Accept: Status column hidden when the tab already filters to one status; a Why cell instead ("Out 3 d · lost ₹18.7k" / "Runs out Fri 22 Nov · order by today · supplier takes 7 d"). Still-out headline shows "costing ₹X/day". Same sentence used in drawer, phone card and digest. LOGIC.md updated.
- Source: product F8, F10.
- Status: Done (96bbc9d).

**SW-025 · Reorder CSV usable as a PO** (S · builder)
- Accept: export respects tab filter and search; status uses UI labels; adds Variant ID, Vendor (`product.vendor`), Unit cost; file date in store time zone.
- Source: product F2 (vendor), F11; QA F9; SRE-12.
- Status: Done (96bbc9d; Object.prototype IDs fixed in critic round 2).

**SW-026 · Pause / Push lists for marketing** (S · builder + product)
- Accept: two chips on Products: "Pause promotion" (out now or days left < lead, with ETA from SW-012) and "Push these" (overstock by ₹ stuck), each with copy-SKUs and CSV. Badge reads "6 to reorder · 10 slow".
- Source: product F7.
- Status: Done (96bbc9d; marketing phone home leads with Pause, critic round 2 M1).

**SW-027 · Yesterday strip + month-to-date period** (S · builder)
- Accept: one line under the Overview headline ("Yesterday: ₹X sold · ₹Y lost · 3 ran out · 2 back"); "This month" in the period picker.
- Source: DAWBU F10.
- Status: Done (6908094; 1st-of-month fix in final integration).

**SW-028 · Morning digest** (M · builder + ops)
- Accept: daily at a set hour (store time), runs after a fresh pull; ≤ 6 lines + deep links; per-role recipients with pause; sent via a provider HTTP API (key in env, no deps); without a key, "Copy summary" and `GET /api/digest.txt`. Every send logged.
- Source: product F6, DAWBU F6.
- Status: Done. The provider is any JSON webhook (`DIGEST_WEBHOOK_URL`, per role `DIGEST_WEBHOOK_URL_<ROLE>`), env only, no email provider. Copy / WhatsApp via Share; `GET /api/digest.txt`.

**SW-029 · View-only password + settings change log** (S · security)
- Accept: `VIEW_PASSWORD` session hides Data, Danger zone and Save; server rejects writes (403, tested). Settings changes logged {at, key, old, new}; last change shown under Plan settings.
- Source: product F4, security idea "Sign out everywhere".
- Status: Done (6b22541; 403 gate covers every `/api` write). Morning digest settings (hour, roles, pause) and a server webhook change are logged too (1.0.0-rc.1).

**SW-030 · Sync progress and run history** (S · ops)
- Accept: pill shows "Syncing · 2,340 orders"; Data page lists last 20 runs (time, duration, stock changes, lines, error, notes such as excluded archived items).
- Source: DAWBU F7.
- Status: Done (6b22541).

**SW-031 · Best-seller rank doesn't move with the period buttons** (S · builder)
- Accept: ABC ranked on the demand window, not the selected period; order value equal at 7/30/60 d (test).
- Source: QA F9.
- Status: Done (61637d1; inactive variants left out of the rank, critic round 2 L2).

**SW-032 · Slow-seller "Decide" bucket** (S · product + builder)
- Accept: slow + out → "Don't reorder?" with ₹ lost; slow + stock → "Clear" with ₹ at cost; one click stores keep/drop/clear and hides it until sales change > 50%.
- Source: product F9.
- Status: Done (96bbc9d).

---

## Sprint 3 · D-ops (ops, time zone, agent docs)

**SW-049 · One IANA time zone per store** (S · builder)
- Accept: one `timeZone` setting per store used by rows, engine, digest and backups; no fixed +5:30 left; LOGIC note; tests in a daylight-saving zone.
- Status: Partial. Done: `public/tz.js` (+ `src/tz.js`) is the one helper; rows, engine, period, Mark ordered, helpers, digest, backups, demo and the page use it; Settings has a zone picker; old `tzOffsetMin` stores keep working (LOGIC §0a, `test/tz.test.js` at New York and London). Open: the Google Sheet version (`modules/stock-watch-sheets`) still uses the spreadsheet's own zone.

**SW-054 · JSON logs** (S · ops)
- Accept: one-line JSON logs (time, level, msg, store, fields); a request line per API call without query string or cookies; one boot line naming set variables, never values; tokens scrubbed in every line.
- Status: Done. `src/log.js`; `server.js` captures `console.*`, so every module's lines are JSON and scrubbed; `test/log.test.js`. RUNBOOK and SECURITY.md updated.

**SW-055 · One copy writes; KEEP_DAYS; capacity warnings** (S · ops)
- Accept: lock file in `DATA_DIR` (stale after 2 min without heartbeat is taken over; a second copy refuses to write and says why); `KEEP_DAYS` env for backups (default 14); warnings on `/status` and Data at 25 MB, 150k rows, disk 80%.
- Status: Done. `src/lock.js`, `src/capacity.js`, `public/ops.js`; ADR-0012 updated; LOGIC §14a; `test/ops.test.js`. Limit: the read-only copy still runs the one-time store migration and a pending restore at start (both already done by the first copy in practice).

**SW-053 · Non-root container, pinned base image** (S · ops)
- Accept: `node:22-alpine` pinned by digest; runs as `node` via an entrypoint that chowns `DATA_DIR` once and drops privileges with su-exec when started as root, else just runs; shell test with stubs; RUNBOOK verify + roll back.
- Status: Done, not yet deployed. `FROM node:22.23.5-alpine@sha256:1314fb30…` (Docker Hub, 12 Nov 2026); `modules/stock-watch/scripts/entrypoint.sh`; `test/entrypoint.test.sh` (run by `test/entrypoint.test.js`). No docker daemon here: the image was not built locally; first deploy follows RUNBOOK "Container user" to verify.

**SW-057 · Trial inputs keep the raw text** (S · builder)
- Accept: Advanced planning rules and Reorder what-ifs keep the typed text (no reformat, no caret jump); read on blur / Enter; invalid shows a hint.
- Status: Done. `public/trial-input.js`; LOGIC §6a; browser test `test/ui-trial.test.js` (in `npm run test:ui`); smoke presses Enter after typing.

**SW-058 · Agent token savings** (S · builder)
- Accept: doc routing table at the top of AGENTS.md; DEVLOG rotation (older than the newest 15 → `docs/devlog/2026-11.md`, linked); `npm run test:agent` (dot reporter); `.ignore`; LOGIC index; `docs/reviews/` README.
- Status: Done. `scripts/rotate-devlog.js` (`npm run devlog:rotate`, tested in `test/devlog.test.js`). After the Sprint 3 merge DEVLOG will hold more than 15 entries again: the integrator runs `npm run devlog:rotate` once.

## Sprint 3 · C-access (security)

**SW-051 · Read-only guard tokeniser + refuse tokens with write scopes** (S · security)
- Accept: the regex guard becomes a tokeniser (comments, strings, block strings skipped; every operation keyword `query` or none); tests with tricky inputs. Each pull reads `currentAppInstallation { accessScopes { handle } }`; our own apps (vault / variables) with any `write_*` are refused in plain words; Performity's token is not refused (ADR-0014) but Data says "Token also allows writes; this app only reads" and the log says it once.
- Source: SEC-7, security idea.
- Status: Done (`src/gql-guard.js`, `src/token-scopes.js`; `test/gql-guard.test.js`, `test/token-scopes.test.js`).

**SW-052 · Sheet sync: manual redirects, host allow-list, size cap** (S · security)
- Accept: redirects followed by hand (max 3), only to https `docs.google.com` / `*.googleusercontent.com`; body capped at 20 MB; 20 s timeout; tests.
- Source: SEC-9.
- Status: Done (`src/sheet-fetch.js`; `test/sheet-fetch.test.js`).

**SW-062 · Per-store access** (M · security)
- Accept: owner (`ADMIN_PASSWORD`) makes people in Data → People: name, admin or viewer, one or more stores, generated password (16+ chars) shown once or reset; scrypt hashes in `DATA_DIR/access.json`; a person's session carries their id; every route enforces their stores (`?store=` outside → 403, `/api/stores` filtered, picker shows only theirs, digest / exports scoped); remove ends their sessions; change log names them. ADR-0016. Owner and `VIEW_PASSWORD` as before.
- Source: multi-store spec 20 Nov.
- Status: Done (`src/people.js`, `public/people.js`; `test/people.test.js`, `test/ui-people.test.js`). Open: no self-service reset or email; `access.json` is not in the per-store backups (volume backups cover it; `.bak` keeps the previous copy).

## Sprint 3 · E-data

**SW-045 · Import preview with column mapping; Shopify exports** (P2 · M · builder)
- Why: a merchant has Shopify's own Products / Orders exports; reformatting them by hand loses rows or money (cancelled orders, discounts).
- Accept: Data → Upload a CSV shows kind, our column ← their header selects, first 5 rows as read; any mapping changeable; Shopify products + orders exports import with no changes (cancelled / voided / refunded, untracked, draft / archived left out; line discount netted); mapping remembered per store per header set. Tests on real-shaped exports (`test/fixtures/`).
- Source: QA idea.
- Status: Done (sprint3/E-data). LOGIC §1b, API `POST /api/import/preview` + `?map=`, FORMATS `mappings.json`. Open: order-level discount codes are not spread over lines; Shopify `Tags` not read (groups come from the catalog).

**SW-050 · `/api/v1` + summary + paginated rows** (P2 · M · builder)
- Why: other Catalys tools need the ₹ numbers without scraping the page's API, which may change.
- Accept: every `/api/<x>` also at `/api/v1/<x>` (same auth, handler; old paths stay); `GET /api/v1/summary` headline only; `GET /api/v1/rows?view=reorder|stockouts|products&limit=&cursor=`, stable order, max 500; API.md documents v1 as the stable contract with examples; tests.
- Source: architect A11, process F10.
- Status: Done (sprint3/E-data). `src/apiv1.js`, ADR-0017, API §v1, LOGIC §5c, `test/apiv1.test.js`. Open: per-tool API keys (tools use the view password; SW-060).

## Sprint 3 · A-money

**SW-040 · Supplier table + PO drafts by supplier** (M · builder)
- Accept: per store suppliers (name, lead time, MOQ, case pack) + SKU → supplier (default Shopify vendor; demo has invented vendors); Data → Suppliers (admin) + CSV in/out; qty rounds up to MOQ then case pack (LOGIC §6c, extra cash shown); supplier lead time overrides the store's; Reorder → By supplier = one PO draft per supplier with Copy and CSV.
- Status: Done (sprint3/A-money). Open: change a SKU's supplier from the product drawer (today: Data → Suppliers or CSV); one supplier per variant.
- Source: product F2, idea "Supplier PO drafts".

**SW-041 · Cash budget cut line** (M · product)
- Accept: optional Budget ₹ on Reorder (per store); rows ranked by profit kept per ₹ (LOGIC §6d, worked example); one cut line, rows below dimmed and out of the PO CSV; empty budget = today's page.
- Status: Done (sprint3/A-money). Open: the budget lives in this browser only (not shared with the team); no filling the leftover below the line (by design, ADR-0018).
- Source: product F3.

## Sprint 3 · B-review

**SW-043 · Weekly review: daily snapshots, this week vs last week** (M · product)
- Accept: one snapshot per store day (₹ lost, profit lost, stock-outs, still out, overstock ₹, to reorder, order today ₹, ₹ lost per product) in `snapshots.json`, 400 days, in backups; "This week vs last week" panel on the Overview (no new page) with change + arrow per number and the top 5 movers; one digest line. LOGIC §5b.
- Status: Done. Open: the CEO / Finance Monday digests keep their own 7-day comparison (re-worked from rows), not the snapshots.

**SW-042 · Stock-aware targets on groups + traffic lights** (M · builder)
- Accept: admin sets a monthly ₹ target per group (category, collection, tag, parent product); group rows show month-to-date vs target, run-rate forecast with and without stock-outs, "₹X is stock-outs", green / amber (within 10%) / red. LOGIC §9c.
- Status: Done. Open: one target for every month (no per-month targets or seasonality); no store-level target.

**SW-044 · Paste-a-list lookup + saved lists** (S · builder)
- Accept: the Products search takes a pasted list (new lines, commas, tabs); table filters to it, "N not found" listed; lists saved by name per store on the server (admin saves / deletes, view reads), picked from a menu. LOGIC §9d.
- Status: Done. Open: lists only on Products (not Reorder / Stock-outs).

---

## Feature · stock history

**SW-063 · Rebuild past stock from Shopify's change log** (P1 · M · builder)
- Why: ₹ lost needs past stock-outs, but Shopify has no API for past stock levels; a store connected today showed ~₹16 lost (Sammsara).
- Accept: ShopifyQL `inventory_adjustment_history` ('available' only, by hour, paged by time window, window split on the 1,000-row cap) walked back from the first live read; rows in pullStock's shape with `src: 'rebuilt'`, only before the first read; variants going below 0 dropped and counted; runs once per store after the first good pull and from Data → Rebuild stock history (admin); no `read_reports` / ShopifyQL error → plain note, pull never fails; Data line "rebuilt … for N of M products"; Stock-outs note on rebuilt periods; "Out but not selling" counted apart from the Stock-outs headline. Tests with a fake ShopifyQL.
- Source: owner, 20 Nov 2026 (verified by hand on Sammsara: 245/257 variants, ~₹2.05 L lost in 30 days).
- Status: Done (branch `feature/stock-history`). `src/history.js`, LOGIC §1c, API `POST /api/shopify/history`, `test/history.test.js`. Open: not checked live through the app yet; hour precision only.

## Feature · returns

**SW-064 · Return % per product** (P1 · S · builder)
- Why: buyers reorder products that come back a lot. Sammsara, 60 days: 264 of 4,525 units returned (5.8%), ₹10.35 L refunded; one coffee table ~48% of its ₹ refunded.
- Accept: pull keeps each line's original `quantity` as `ordered` (no extra API call); returned = ordered − currentQuantity, by order date; per product `unitsOrdered`, `unitsReturned`, `returnPct` (null under 5 ordered), `refundValue` (ex GST) + store totals; demand / ₹ lost unchanged; one 60-day re-read for old lines; Products column Returns % (amber 15%+, – under 5), High returns chip, drawer line; LOGIC §9e; demo returns.
- Source: owner, 20 Nov 2026.
- Status: Done (branch `feature/returns`). Tests: `shopify`, `engine`, `scheduler`, `server`, browser `ui-returns`. Open: `ui-helpers` chip count 6 → 7 for the integrator; not checked live against ShopifyQL `quantity_returned` yet.
- Fix 1.1.3: live check failed (5 vs 259 units, 60 d). Returns now from `order.refunds`, cancelled orders included (Shopify counts them as returns); demand = kept + returned after the sale, never cancelled. Checked live: same orders agree to ₹2; by Shopify's return date 185 vs 259 (52 orders placed before the window, cancelled 30 Sep). LOGIC §9e, DEVLOG 2026-11-20.

**SW-065 · Cancel/refund % and periods match Shopify exactly** (P1 · M · builder)
- Why: 30 d external check: 3 of 12 products differed (Cascade 4.7% vs 5.4%), because reversals were dated by order and periods were rolling 24 h blocks.
- Accept: periods = store-calendar days for every number, dates shown; reversal events with their own dates (refunds, cancels, older orders reversed in the window, deduped); Cancel/refund % = reversed in period ÷ ordered in period; Data "Check against Shopify" net sales; live check 7/30/60 d per product and store.
- Source: owner, 20 Nov 2026.
- Status: Done 1.1.5 (LOGIC §5a, §9e). Live: identical except 2 units ordered on one 60-day product added by an order edit. Open (Later): read sales agreements for edited orders to date edit-added units like Shopify (cost: one extra query per edited order).

**SW-066 · ₹ lost says how sure it is** (P0 · M · builder)
- Why: Sammsara 30 d: ₹5.89 L lost, of which ₹3.61 L (61%) on 43 products that sold ≤ 3 units; the category team saw losses on products they know don't sell (Seville Nesting Table: 0 sold, ₹29,215 from 3 older sales). A rate from a few sales was shown as fact, and stock-outs nobody restocks kept adding up.
- Accept: per product `rateUnits` and `confidence` (high 10+, medium 5–9, low ≤ 4); open stock-out > 30 d with no PO → ₹ after day 30 apart (`lostNotRestocked`), a PO keeps it counting; headline = high + medium without that part, the same on every screen, digest, snapshots, `/api/v1/summary`, CSV; `lostAll` = old total; line under the headline with the parts, clickable; markers, Confidence column, filters; alternatives A–E quantified on live data in LOGIC §4.
- Source: owner, 24 Nov 2026 (business walkthrough).
- Status: Done 1.2.0 (LOGIC §3, §4, §4c, §5, §11, §15a). Tests `confidence.test.js`, `ui-helpers` §4c. Sammsara 30 d headline ₹3.72 L (5.9%), 7 d ₹77k (7.4%).

## Later

Ordered by money impact. Each becomes a full item when pulled into a sprint.

| ID | Title | Size | Owner | Source |
|---|---|---|---|---|
| SW-046 | Storage move per ADR-0003 (node:sqlite) + cached report + gzip | L | builder | architect A6, SRE-10 |
| SW-047 | `schemaVersion` + migrations (FORMATS.md exists since 0.9.0: schema 1). **Done 1.0.0-rc.1:** `store.json` schemaVersion 1 written and read, `MIGRATIONS`, newer file refused | M | builder | architect A7, process F10 |
| SW-048 | Shared `packages/stock-rules` per ADR-0008 | L | builder | architect A8 |
| SW-056 | Git tags, version + SHA in /health, /status and footer (semver + CHANGELOG.md since 0.9.0). **Done 1.0.0-rc.1:** version + SHA (`npm run stamp`, RUNBOOK). Open: tag `v<version>` on the deployed commit at the next deploy | S | ops | process F8, F2 |
| SW-059 | Split app.js into per-page ES modules, wrap long lines | M | builder | tokens T5 |
| SW-060 | Auth model upgrade (named users / Performity SSO) | M | security | architect idea, ADR-0011 |
| SW-061 | Ads link: live spend on out-of-stock SKUs (needs Performity data) | M | product | product idea |
