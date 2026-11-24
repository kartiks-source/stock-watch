# Runbook: Stock-out Watch (web app)

What to do when something breaks, and how to get data back. For secrets and who can do what, see [`SECURITY.md`](../SECURITY.md). For why it runs this way, see ADR-0003 (JSON store) and ADR-0012 (one instance on Railway).

## Where things are

| What | Where |
|---|---|
| App | Railway project `stock-watch`, service `web`, one replica: https://web-production-d8d7a911.up.railway.app |
| Data | Railway volume at `/data`, **one folder per store** (ADR-0015): `/data/stores/<id>/` holds `store.json` (rows, settings, ingest key, Shopify cursor, catalog, change log, digest settings) plus sidecar files `onorder.json` (Mark ordered), `decisions.json` (Decide), `catalog.json` (collections cache). For every store: `/data/secret` (session key), `/data/stores.json` (last good store list), `/data/access.json` (per-store people, scrypt hashes; previous copy `access.json.bak`; SW-062: not in app backups, covered by volume backups; to undo a People change copy `.bak` over it and restart). `<id>` = the Performity brand_id, the Key Vault store handle, or `sammsara-demo` / `second-demo`; `GET /api/stores` lists them. Shapes: `modules/stock-watch/FORMATS.md` |
| App backups | `/data/stores/<id>/backups/` (below) |
| Health | `GET /health` → `{"ok":true}`, 503 when the store can't be read or saved; `GET /status` → freshness and row counts, 503 when Shopify data is stale (older than max(45 min, 2 × pull interval + 15 min): 255 min at the default 2-hour pull) or saving fails (both no login) |
| Logs | Railway dashboard → service → Deployments → View logs (lines start `backup:`, `restore:`, `shopify:`) |

## Uptime monitor (SW-019)

Railway's health check only restarts a dead deploy; nobody is told. Set up one external monitor (owner, once; free tiers are enough):

1. UptimeRobot (or Better Stack) → new **HTTP(s)** monitor `https://web-production-d8d7a911.up.railway.app/health`, every 5 minutes, alert when the status is not 200 (UptimeRobot: keyword monitor for `"ok":true` also catches a wrong page). This one means "the app is down or can't save".
2. A second monitor on `/status`, every 5 minutes, alert when not 200 for 2 checks in a row (a pull every 2 hours by default, `SYNC_MINUTES`, can run late). This one means "the numbers are stale": the Shopify pull is failing or stuck. Without Shopify connected `/status` stays 200 unless saving fails.
3. Alert contacts: the owner's phone/email and the team channel. `ALERT_WEBHOOK_URL` already posts pull failures from inside the app; the monitor covers the case where the app itself is down.
4. Record the monitor's name and who gets alerts in `docs/DEVLOG.md`. Status: not yet set up.

Both routes are open by design and return no names, keys or error details (`SECURITY.md`), so a third-party monitor sees nothing sensitive.

## Connect the first store (option A: Performity POC API)

1. Give Performity our app's domain (today `web-production-d8d7a911.up.railway.app`): they allow our key only from that **Origin**. The app sends `Origin: https://$RAILWAY_PUBLIC_DOMAIN` (override with `PERFORMITY_ORIGIN`, e.g. after adding a custom domain; tell Performity first). A wrong one gives `403 Origin not allowed`. If Performity also turns on its IP allow-list (`EXTERNAL_POC_ALLOWED_IPS`): Railway → service `web` → **Settings → Networking → Enable Static IPs** (Pro plan), redeploy, send them the IPv4.
2. Performity sends the base URL and our key (one-time link). Railway → service `web` → **Variables**: set `PERFORMITY_POC_API_URL`, `PERFORMITY_POC_API_KEY`, `ALERT_WEBHOOK_URL`; keep `ADMIN_PASSWORD` (12+ chars). If they allow more than one brand, also `PERFORMITY_BRAND_ID`. The base URL is the API host (`https://…azurewebsites.net`), not the Azure portal page where the key is stored. Saving redeploys. Do it after 22:00 IST: the first pull loads 60 days of orders on Performity's shared Shopify limit.
3. Data page shows "Connected to Shopify" with the store; demo data is cleared automatically. Railway → service → **Deployments → View logs**: `shopify: … stock changes, … order lines`. Errors are in plain words (IP not allowed, brand not allowed, store must reconnect…).
4. Next morning: compare 10 days of Sold and order counts with Shopify admin (Analytics → Net sales) and stock for 10 SKUs. Only then show numbers.
5. To stop at once: delete `PERFORMITY_POC_API_URL` in Variables. A wrong key is never retried in a loop (5 wrong keys block our IP for 15 minutes).

## Railway configuration (infrastructure as code)

`.railway/railway.ts` defines the project: service `web` in **Singapore** (`asia-southeast1-eqsg3a`, closest to India and Performity; static outbound IPs are per region, so don't move it after Performity allow-lists our IP), exactly 1 replica, health check `/health`, volume `web-volume` at `/data`. Secrets stay in the Railway dashboard (`preserve()`), never in the file. The file is **omit=delete**: a variable set in the dashboard but not listed in `env` is deleted on apply (the Performity key and URL, the webhooks: pulls and digests stop). Every variable in SECURITY.md and `.env.example` is listed as `preserve()`; add a new one to the file before you set it in the dashboard.

```bash
npm install --no-save railway   # the IaC SDK, only needed to plan/apply
railway config plan             # safe preview: read it for any variable it would delete
railway config apply            # asks before changing anything; stop if the plan deletes a variable
```
If the plan deletes a variable, add it to `.railway/railway.ts` as `preserve()` (or compare with `railway config pull --omit-preserved-variables`) and plan again.
Run `railway` directly (not through `timeout` or another wrapper: the SDK checks the version of the command that launched it).

**Static outbound IP (Pro plan):** Railway → service `web` → Settings → Networking → Enable Static IPs (or `railway outbound-network static-ip enable --service web`), redeploy, send the IPv4 address(es) to Performity for `EXTERNAL_POC_ALLOWED_IPS`.

## Several stores (ADR-0015)

- **Which stores:** Performity → every brand our key may use (`PERFORMITY_BRAND_ID` limits it to one); Key Vault → `STORES=a,b,c` (else `SHOPIFY_STORE`); no key → the two demo stores. A brand Performity adds shows in the picker within 10 minutes, no deploy. A brand it removes disappears from the picker; its folder stays on the volume until deleted by hand.
- **First start after this release (one time):** the old single-store files at the top of `/data` (`store.json`, `onorder.json`, `decisions.json`, `.bak` / `.corrupt-*` copies, `catalog.json`, `restore.json`, `backups/`) move into the folder of the store they were for: `SHOPIFY_STORE` (Key Vault / variables) or `PERFORMITY_BRAND_ID` (Performity) when that store is listed, else the first store. Log: `migrate: moved N file(s) from DATA_DIR into stores/<id>`. Each copy is checked (SHA-256) before the original is deleted; a crash part-way is finished or redone on the next start. This happens **once per volume**: after it, a store-list change (new brand, new order, `STORES` edited) never moves anything again, and a file put at the top of `/data` later stays there with a warning. Before deploying, download a backup (below) anyway.
  - On today's Railway (demo, no key) the first store is `sammsara-demo`. **Connect Performity before this release only if the current data should land in a brand (set `PERFORMITY_BRAND_ID` to pick which).**
  - `Refusing to start: DATA_DIR holds single-store files … and stores/<id> already holds data`: someone ran both layouts. Nothing was moved. Decide which is right: move the old top-level files into `/data/old-<date>/` (or the folder's files aside), then restart.
  - `migrate: left in DATA_DIR (changed or new since the move …)`: a file at the top changed after the copy (an old version ran?). The store folder holds the copy from the move; compare and delete the top-level file by hand.
- **Pulls:** one store at a time, every 2 hours by default (`SYNC_MINUTES`); logs say `shopify (<store name>): …`. Alerts name the store.
- **Store ids in URLs:** `/?store=<id>`. An id not in the list is a 404 for `/api` (never a folder lookup); the page itself then opens the default store.
- **Picker:** the store pill (phones: the store bar under the top bar) lists every store with a dot: green ok, amber data stale (over 255 minutes old at the default 2-hour pull), red last pull failed (hover / second line says why). With one store it shows only the name. Links to send someone: `/?store=<id>#reorder` (the address bar always carries it).
- **Checking a release with two stores locally:** no key → two demo stores (`Sammsara (demo)`, `Second store (demo)`, different numbers). Performity stand-in: `STAND_IN_BRANDS=2 PORT=4499 node modules/stock-watch/scripts/stand-in-token-api.js`, then the app with `PERFORMITY_POC_API_URL=http://localhost:4499 PERFORMITY_POC_API_KEY=stand-in-key ADMIN_PASSWORD=…`: two stores, red dots until `SHOPIFY_DEV_TOKEN` (+ `_2`) point at development stores.

## Deploy and roll back

Deploys are a local `railway up` (no auto-deploy from GitHub yet; ADR-0012):

1. `git checkout main && git pull && git status` → clean, and CI green on that commit (GitHub Actions "test").
2. `npm test` locally.
3. `npm run stamp && railway up && rm modules/stock-watch/BUILD_SHA` from the repo root. `stamp` writes the commit to `modules/stock-watch/BUILD_SHA` (it refuses while there are uncommitted changes); the root `Dockerfile` copies it, so `/health`, `/status` and the page footer show `v<version> · <sha>` (SW-056). The file is deliberately not in `.gitignore` (`railway up` leaves out ignored files), so delete it afterwards. Railway sets `RAILWAY_GIT_COMMIT_SHA` itself on deploys from GitHub; with neither, the footer says `dev`. Alternative: `railway variables --set BUILD_SHA=$(git rev-parse HEAD) --skip-deploys` before `railway up`.
4. Check `/health` is 200 and its `version` / `sha` are the ones you meant to deploy (`curl -s <url>/health`), and sign in once. Record the deployed SHA in `docs/DEVLOG.md`.

Roll back: Railway dashboard → Deployments → the previous deployment → Redeploy. The volume is not touched by a deploy or a rollback. **Data written by a newer version:** `store.json` carries `schemaVersion` (SW-047, `FORMATS.md`); an older build refuses to start on a file with a higher schemaVersion (log: `… is schema N, written by a newer version of the app …`) rather than overwrite what it doesn't know. Today every release reads and writes schema 1, so rolling back within 1.x is safe; when a release bumps it, its CHANGELOG says so, and rolling back past it means restoring a backup taken before that deploy.

### Container user (SW-053)

The image starts as root only long enough for `/app/entrypoint.sh` to hand `/data` to the `node` user (once: only while `/data` isn't owned by `node`), then runs the app as `node` via `su-exec`. `RAILWAY_RUN_UID=0` stays set (it makes Railway start the container as root so the hand-over can happen).

**Verify after the first deploy with this image:**
1. Railway → Deployments → Logs: one `entrypoint: giving /data to user node (once)` line on the first boot only, then the JSON `"msg":"boot"` line.
2. `railway ssh` (or the service shell): `ps -o user,args | grep server.js` shows `node`, not `root`; `ls -ln /data` shows uid 1000.
3. `/health` 200 with the version you meant; on Data, Save settings works (proves `node` can write the volume).

**Roll back:** Railway → Deployments → the previous deployment → Redeploy. The older image runs as root (`RAILWAY_RUN_UID=0`), which reads the node-owned files fine; nothing to undo on the volume. If the new one can't write (`/health` 503 `Saving data fails`): roll back, then check the volume's mount path is `/data`.

**Update the base image:** the `FROM` line pins `node:<version>-alpine@sha256:<digest>`. Find the newest 22.x tag and its digest: `curl -s "https://hub.docker.com/v2/repositories/library/node/tags?name=22.&page_size=50" | jq -r '.results[] | select(.name|test("^22\\.[0-9]+\\.[0-9]+-alpine$")) | "\(.name) \(.digest)"' | head -1` (or `docker buildx imagetools inspect node:22-alpine`). Change tag and digest together, run `npm test` (it checks the pin's shape), deploy, verify as above.

## Backups

**1. App backups (on the volume, automatic).** `src/backup.js` writes, for each store, in `/data/stores/<id>/`:

| File | When | Kept |
|---|---|---|
| `backups/store-YYYYMMDD.json` | once a day (store's local date), checked at start and every hour | newest 14 |
| `backups/store-YYYYMMDD-HHMMSS-before-clear.json` | just before Clear, demo → live, or an import that replaces demo data | newest 14 |
| `backups/store-YYYYMMDD-HHMMSS-before-demo.json` | just before demo data replaces real data | newest 14 |
| `backups/store-YYYYMMDD-HHMMSS-before-restore.json` | just before a restore (below) | newest 14 |

**How many:** `KEEP_DAYS` (Railway variable, 1–365, default 14) of each kind; for the dailies that is the number of days back. Raise it only with disk to spare (each file is a full copy; the Data page warns at 80% full).

An empty store and demo data are never backed up (nothing to lose; demo reloads would push real snapshots out). Each file is a full copy of `store.json` **plus `sideFiles`: the Mark-ordered records (`onorder.json`) and slow-seller decisions (`decisions.json`)**, which live next to it on the volume (critic r2 X1: lost PO marks put ordered lines back in Order today, the duplicate PO SW-012 exists to stop). The export below carries them too. So 28 files × the store's size must fit on the volume: at 50 MB (ADR-0003's move trigger) that is 1.4 GB.

**2. Railway volume backups (whole volume, owner sets up once).** Railway dashboard → project `stock-watch` → service `web` → the `/data` volume → Backups → schedule **Daily**, keep **at least 7**. These survive a deleted or corrupted volume, which app backups (on the same volume) don't. Status: not yet confirmed on (see DEVLOG).

**Check volume backups (monthly, and before any risky change).** Dashboard → service `web` → the `/data` volume → Backups: the newest one is under 26 hours old, the schedule is Daily, and at least 7 are kept. Write the date checked and the newest backup's time in `docs/DEVLOG.md`. If none is recent, take a manual backup there before going on.

**What the app backups cover.** `store.json` plus `onorder.json` (Mark ordered records) and `decisions.json` (Decide choices) as `sideFiles` (SW-005). `catalog.json` refills from Shopify within a day and `secret` only signs people out when lost, so neither needs a backup.

**3. Download now (any time, login needed).** `GET /api/export/backup.json?store=<id>` returns that store as a file (no `?store=`: the first store):

```bash
curl -fsS -u "x:$ADMIN_PASSWORD" -o stock-watch-store.json "https://web-production-d8d7a911.up.railway.app/api/export/backup.json?store=<id>"
```

Every store, before a risky change: `GET /api/stores` lists the ids; download each.

Do this before anything risky (a big import, connecting Shopify for the first time, a storage change). The file holds the ingest key and sales data: keep it out of git, chat and shared drives.

## Restore

The app restores on start, per store: if `/data/stores/<id>/restore.json` exists and looks like a store (has `stock`, `orders`, `settings`), it keeps the current `store.json` (with the current side files) as `backups/…-before-restore.json`, puts `restore.json` in its place, writes `onorder.json` and `decisions.json` from its `sideFiles` (each current file kept as `<name>.bak`), and logs `restore: store.json replaced from restore.json (with onorder.json, decisions.json) …`. A backup from before 20 Nov 2026 has no `sideFiles`: the current Mark-ordered and decision files are left as they are. A file that isn't a store is renamed `restore.json.rejected-<time>` and the current store stays (log line `restore: … is not a Stock-out Watch store`).

**From an app backup (Railway):**

1. Find the store's id (`GET /api/stores`, or the `?store=` in the page address). List backups: `railway ssh` (into service `web`), then `ls -l /data/stores/<id>/backups`. Pick the newest file from before the problem (a `before-clear` file if someone pressed Clear).
2. `cp /data/stores/<id>/backups/<file> /data/stores/<id>/restore.json` (a backup goes back into **its own** store's folder only)
3. Restart the service right away (dashboard → service → ⋯ → Restart). Copying into `store.json` directly would be overwritten by the running app's next save; `restore.json` is only read at start.
4. Check the logs for `restore: store.json replaced`, sign in, and check the Data page row counts and the last stock/order times.
5. If the store had Shopify connected, the next pull (within 2 hours by default, `SYNC_MINUTES`) fills in orders since the backup. Stock-out history between the backup and now can't be recovered.

**From a downloaded export or a Railway volume backup:** restore the Railway volume backup from the dashboard (it replaces the whole volume; then restart), or copy the exported file to `/data/stores/<id>/restore.json` (the store it was exported from) and restart as above.

**Locally:** stop the app, `cp <backup> $DATA_DIR/stores/<id>/restore.json`, start it. A `restore.json` at the top of `DATA_DIR` is not read (the log says so), except on the very first start after the multi-store release, when it moves with everything else (above); after that first move it stays at the top with a warning.

**Which files a full restore needs.** `restore.json` replaces `store.json` and, from its `sideFiles`, `onorder.json` and `decisions.json` (a backup from before 20 Nov 2026 has no `sideFiles`: put those two back by hand, with the app stopped or straight before the restart):

| File | Needed? | If missing |
|---|---|---|
| `store.json` (via `restore.json`) | yes | everything is lost |
| `onorder.json` | yes, if anyone used Mark ordered | ordered rows go back to Order today; people must mark them again (risk of a duplicate PO) |
| `decisions.json` | yes, if anyone used Decide | slow sellers come back into Decide |
| `catalog.json` | no | collections are re-read from Shopify within a day (Group by → Collections empty until then) |
| `secret` | no | everyone signs in again |

From a Railway volume backup all of these come back together. From an app backup or a download, `store.json`, `onorder.json` and `decisions.json` do (`sideFiles`). After a Clear, the `before-clear` backup brings back the rows, Mark ordered and decisions.

**Drill:** do one restore on a local copy each sprint and log it in `docs/DEVLOG.md` (last: 19 Nov 2026, SW-005).

## When something is wrong

**Logs** (SW-054) are one JSON line each: `{time, level, msg, store, …}`. In Railway → Deployments → Logs, filter on `"level":"error"`, `"msg":"boot"` (version, key source, which variables are set) or a store id. Every API call has one `"msg":"request"` line (method, path, status, ms). Tokens are scrubbed to `***`.

| Symptom | Check | Fix |
|---|---|---|
| Uptime monitor: `/status` 503 | Data page: last pull, last error; `ALERT_WEBHOOK_URL` channel | Same as "Shopify data stale" below; `saveOk: false` → same as "Disk full" |
| Page down / 502 | `/health`; Railway logs for a crash on start | `Refusing to start: … ADMIN_PASSWORD` → set the variable. Otherwise roll back to the last good deployment |
| "Login needed" everywhere | `ADMIN_PASSWORD` changed? | Sign in again (changing it signs everyone out) |
| Numbers look empty after a deploy | Data page row counts; `ls -l /data` | Volume not attached at `/data`, or Clear was pressed: restore (above) |
| Shopify data stale | Data page: last pull, last error; logs `shopify pull failed:` | Key expired or scopes missing: see SECURITY.md (rotate Shopify key). Press Sync now on the Data page |
| Flow rows not arriving | Flow run history in Shopify; Data page last row time | Ingest key rotated → update the `X-Ingest-Key` header in both Flows |
| Data page "Read-only" / writes get 503 "Another copy of the app" | `/status` `writing`; Railway: two deployments running? `cat /data/instance.lock` | Wait: the new copy takes over when the old one stops (at once) or goes quiet (2 min). Stuck: stop the old deployment. Never delete the lock while two copies run |
| Data page "Running out of room" | `/status` `warnings` | Over 25 MB or 1,50,000 rows: plan SW-046 (ADR-0003). Disk over 80%: lower `KEEP_DAYS`, delete `*.rejected-*` / `*.corrupt-*` files, or grow the volume |
| Disk full | Railway volume usage; `du -sh /data/*` | Delete old `restore.json.rejected-*` files; grow the volume; review ADR-0003 triggers |
| `Refusing to start: onorder.json can't be read` (or `decisions.json`) | `ls -l /data/stores/*/` for `onorder.json.corrupt-*` | The file is damaged and there is no good `.bak`. Nothing was overwritten. Restore the newest backup of that store (above: its `sideFiles` bring the marks back), or move the bad file aside (`mv /data/stores/<id>/onorder.json /data/stores/<id>/onorder.json.bad`) to start with no marks, then re-mark open POs |
| Restore did nothing | Logs for `restore:` lines; `ls /data/stores/<id>` | File in the wrong place (must be `/data/stores/<id>/restore.json`; the top-level `/data/restore.json` is ignored) or rejected (`restore.json.rejected-*`): check it's a store export |
| A store is missing from the picker | `GET /api/stores` → `registry.lastError`; Railway logs `No store yet` | Performity's brand list failed and no list was ever saved (`/data/stores.json`): check `PERFORMITY_POC_API_URL` / key / IP allow-list. A brand Performity no longer allows is left out on purpose; its data stays in `/data/stores/<id>/` |
| One store's dot is red | Data page of that store: last error | Same as "Shopify data stale", for that store only (the other stores keep pulling) |
