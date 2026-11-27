'use strict';
/*
 * Backups of the store (SW-005). store.json holds stock-out history that Shopify can't resend, so:
 * (every backup, the export and restore also carry onorder.json and decisions.json as `sideFiles`, critic r2 X1:
 *  lost PO marks put ordered lines back in Order today, the duplicate PO SW-012 exists to stop)
 *
 * Per store (ADR-0015), in that store's folder DATA_DIR/stores/<id>/ (src/scope.js):
 *   backups/store-YYYYMMDD.json              one a day (store's local date), checked hourly
 *   backups/store-YYYYMMDD-HHMMSS-<why>.json  before every replaceAll (Clear, demo → live,
 *                                            import replacing demo, demo reload) and before a restore
 *
 * The newest 14 of each kind are kept. Demo data and an empty store are never backed up: there's
 * nothing to lose, and demo reloads would push real snapshots out of the 14.
 * GET /api/export/backup.json (login needed) downloads the store as it is now.
 * Restore: copy a backup to DATA_DIR/stores/<id>/restore.json and restart; see docs/RUNBOOK.md.
 *
 * Wiring: server.js calls start() once, prepare() for each store before anything loads it (applies a pending
 * restore), daily() for each store every hour, and route() inside the logged-in part of the API.
 */
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const onorder = require('./onorder');
const decide = require('./decide');
const suppliers = require('./suppliers');   // SW-040
const { parse, writeAtomic: writeSide } = require('./sidefile');
const scope = require('./scope');
const TZ = require('./tz');   // the store's time zone (SW-049)

/* the side files a backup carries, by file name (<store folder>/<name>) */
const SIDES = { [onorder.FILE_NAME]: onorder, [decide.FILE_NAME]: decide, [suppliers.FILE_NAME]: suppliers };
for (const m of [require('./weekly'), require('./targets'), require('./lists'), require('./closed'), require('./ledger'), require('./status'), require('./policy')]) SIDES[m.FILE_NAME] = m;   // 4.8.0: policy.json (§35)   // sprint 3 B-review: snapshots.json (SW-043), targets.json (SW-042), lists.json (SW-044); closed.json (1.4.6)

/* the current store's folder (src/scope.js) */
const dir = () => path.join(scope.dir(), 'backups');
const storeFile = () => path.join(scope.dir(), 'store.json');
const restoreFile = () => path.join(scope.dir(), 'restore.json');
/** KEEP_DAYS env (SW-055): how many of each kind to keep, 1–365, default 14 (dailies: one per day, so that many days back). */
const keepFrom = (v) => (/^\d+$/.test(String(v ?? '').trim()) ? Math.min(365, Math.max(1, Number(v))) : 14);
const KEEP = keepFrom(process.env.KEEP_DAYS);
const DAILY = /^store-\d{8}\.json$/;
const EVENT = /^store-\d{8}-\d{6}-[a-z0-9-]+\.json$/;

/** The store as JSON, without the in-memory dedupe indexes (top-level keys starting with "_"), plus
 *  sideFiles: { 'onorder.json': {…}, 'decisions.json': {…} }. Throws if a side file can't be read (never backs up a blank). */
function text() {
  const d = store.load();
  const sideFiles = Object.fromEntries(Object.entries(SIDES).map(([n, m]) => [n, m.all()]));
  const plain = Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith('_')));
  return JSON.stringify({ ...plain, sideFiles });
}
/** The side files as they are on disk now (for the before-restore copy, which runs before anything is loaded). */
function sidesOnDisk() {
  const out = {};
  for (const n of Object.keys(SIDES)) { try { const j = parse(path.join(scope.dir(), n)); if (j) out[n] = j; } catch { /* unreadable: left out, the file stays */ } }
  return out;
}
const worthKeeping = (d) => d.source !== 'demo' && (d.stock.length || d.orders.length);

/** Write via a temp file, fsync, rename: a crash leaves the old file or the new one, never half of one. */
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

/** Store-time date/time stamps (zone: src/tz.js; settings → TZ.zoneOf). */
function stamp(t, zone) {
  const iso = TZ.local(t, zone ?? 0).toISOString();
  return { day: iso.slice(0, 10).replace(/-/g, ''), time: iso.slice(11, 19).replace(/:/g, '') };
}

/** Keep the newest KEEP of each kind (names sort by time). */
function rotate() {
  const DIR = dir();
  let names; try { names = fs.readdirSync(DIR); } catch { return; }
  for (const re of [DAILY, EVENT]) {
    const old = names.filter((n) => re.test(n)).sort().reverse().slice(KEEP);
    for (const n of old) { try { fs.unlinkSync(path.join(DIR, n)); } catch { /* already gone */ } }
  }
}

/** Snapshot now, labelled `why` (e.g. "before-clear"). Returns the file written, or null if nothing to keep. */
function snapshot(why, now = Date.now()) {
  const d = store.load();
  if (!worthKeeping(d)) return null;
  const s = stamp(now, TZ.zoneOf(d.settings));
  const file = path.join(dir(), `store-${s.day}-${s.time}-${String(why).toLowerCase().replace(/[^a-z0-9-]+/g, '-')}.json`);
  writeAtomic(file, text());
  rotate();
  console.log(`backup: ${path.basename(file)} (${d.stock.length} stock rows, ${d.orders.length} order lines)`);
  return file;
}

/** Today's daily backup, if it isn't there yet. Returns the file written, or null. */
function daily(now = Date.now()) {
  const d = store.load();
  if (!worthKeeping(d)) return null;
  const file = path.join(dir(), `store-${stamp(now, TZ.zoneOf(d.settings)).day}.json`);
  if (fs.existsSync(file)) return null;
  writeAtomic(file, text());
  rotate();
  console.log(`backup: daily ${path.basename(file)}`);
  return file;
}

/**
 * Restore on boot: if the store folder holds restore.json and looks like a store, the current store.json is
 * kept as a "before-restore" backup and restore.json takes its place. A file that isn't a store is
 * renamed restore.json.rejected-<time> and the current store stays. Must run before store.load().
 */
function restorePending(now = Date.now()) {
  const RESTORE = restoreFile(), FILE = storeFile(), DIR = dir(), DATA_DIR = scope.dir();
  if (!fs.existsSync(RESTORE)) return null;
  let ok = false, off = TZ.DEFAULT_ZONE;
  try {
    const d = JSON.parse(fs.readFileSync(RESTORE, 'utf8'));
    ok = !!d && Array.isArray(d.stock) && Array.isArray(d.orders) && !!d.settings && typeof d.settings === 'object'
      && !(d.schemaVersion > store.SCHEMA_VERSION);   // a newer app's backup: this one would drop what it doesn't know (SW-047)
    if (ok) off = TZ.zoneOf(d.settings);
  } catch { ok = false; }
  if (!ok) {
    const bad = `${RESTORE}.rejected-${now}`;
    fs.renameSync(RESTORE, bad);
    console.error(`restore: ${path.basename(bad)} is not a Stock-out Watch store this version can read (needs stock, orders, settings; schema ≤ ${store.SCHEMA_VERSION}); kept the current store`);
    return { restored: false, rejected: bad };
  }
  let kept = null;
  if (fs.existsSync(FILE)) {
    const s = stamp(now, off);
    kept = path.join(DIR, `store-${s.day}-${s.time}-before-restore.json`);
    fs.mkdirSync(DIR, { recursive: true });
    try { const cur = JSON.parse(fs.readFileSync(FILE, 'utf8')); writeAtomic(kept, JSON.stringify({ ...cur, sideFiles: sidesOnDisk() })); }
    catch { fs.copyFileSync(FILE, kept); }   // an unreadable store is kept byte for byte
  }
  /* side files: written from the backup when it has them (each current file kept as <name>.bak); an older backup
     without sideFiles leaves the current Mark-ordered and decision files as they are */
  const r = JSON.parse(fs.readFileSync(RESTORE, 'utf8'));
  const sides = r.sideFiles && typeof r.sideFiles === 'object' ? r.sideFiles : null;
  const restoredSides = [];
  if (sides) {
    for (const [n, m] of Object.entries(SIDES)) {
      const v = sides[n];
      if (v && typeof v === 'object' && !Array.isArray(v)) { writeSide(path.join(DATA_DIR, n), JSON.stringify(v)); m.reset(); restoredSides.push(n); }
    }
    delete r.sideFiles;
    writeAtomic(FILE, JSON.stringify(r)); fs.rmSync(RESTORE);
  } else fs.renameSync(RESTORE, FILE);
  rotate();
  console.log(`restore: store.json replaced from restore.json${restoredSides.length ? ` (with ${restoredSides.join(', ')})` : ''}${kept ? `; previous store kept as backups/${path.basename(kept)}` : ''}`);
  return { restored: true, kept, sideFiles: restoredSides };
}

let started = false;
/** Once at startup: snapshot before every replaceAll (of whichever store it runs for), and the hourly daily-backup
 *  check, run for every store by each(fn) (server.js: one store at a time, inside scope.run). */
function start({ everyMs = 60 * 60e3, each = null } = {}) {
  if (started) return; started = true;
  const replaceAll = store.replaceAll;
  store.replaceAll = function (stock, orders, source) {
    try { snapshot(`before-${source === 'demo' ? 'demo' : 'clear'}`); } catch (e) { console.error('backup before replace failed:', e.message); }
    return replaceAll.apply(this, arguments);
  };
  if (!each) return;
  const tick = () => each(() => { try { daily(); } catch (e) { console.error(`daily backup failed (store ${scope.current()}):`, e.message); } });
  tick();
  setInterval(tick, everyMs).unref();
}
/** Before a store is first loaded: apply its pending restore.json. Never throws (a failed restore keeps the store as it is). */
function prepare() { try { return restorePending(); } catch (e) { console.error(`restore failed (store ${scope.current()}):`, e.message); return null; } }

/** GET /api/export/backup.json (call only after the login check). Returns true when it answered. */
function route(req, res, url) {
  if (url.pathname !== '/api/export/backup.json' || req.method !== 'GET') return false;
  const s = stamp(Date.now(), TZ.zoneOf(store.load().settings));
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'content-disposition': `attachment; filename="stock-watch-store-${s.day}-${s.time}.json"` });
  res.end(text());
  return true;
}

module.exports = { start, prepare, route, snapshot, daily, rotate, restorePending, text, dir, KEEP, keepFrom, SIDES };
