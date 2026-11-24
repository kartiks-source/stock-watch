'use strict';
/*
 * Storage: one JSON file per store (DATA_DIR/stores/<id>/store.json, ADR-0015). Fine for a demo and for a
 * few stores with a few months of data; when to move is in docs/adr/0003.
 * Which store: src/scope.js (the server runs every request and pull inside scope.run(id)); each store's
 * folder has its own state below (loaded data, save timer, last error), so two stores never share one.
 *
 * Safety (SW-004): only a missing file starts blank; a file that can't be read is quarantined and
 * never overwritten; writes are fsynced before the rename; the previous good file is kept as
 * store.json.bak; a failed write is retried and reported by health().
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { stockKey, orderKey } = require('./rows');
const { DEFAULT_SETTINGS } = require('./engine');
const scope = require('./scope');
const onorder = require('./onorder');   // Mark ordered and decisions made on demo data go with it (SW-007)
const decide = require('./decide');
const suppliers = require('./suppliers');   // SW-040: demo supplier terms go with the demo

const KEEP_DAYS = 120;
/*
 * schemaVersion (SW-047, FORMATS.md): the shape of store.json. Written on every save. On load, an older file is
 * brought up step by step (MIGRATIONS[n] turns schema n into n + 1; a file without the key is schema 0, the
 * Sprint 1 shape, which is schema 1 minus the key). A file from a newer app is refused, never read or rewritten:
 * this code would drop what it doesn't know (e.g. after a rollback, deploy the newer version again).
 */
const SCHEMA_VERSION = 1;
const MIGRATIONS = {
  0: (d) => d,   // 0 → 1: same shape, the key is new
};
/** The store brought up to SCHEMA_VERSION (in place). Throws on a newer schema or a version with no migration. */
function migrate(d, label = 'store.json') {
  let v = d.schemaVersion == null ? 0 : d.schemaVersion;
  if (!Number.isInteger(v) || v < 0) throw new Error(`${label} has a bad schemaVersion (${JSON.stringify(d.schemaVersion)})`);
  if (v > SCHEMA_VERSION) throw new Error(`${label} is schema ${v}, written by a newer version of the app; this one reads up to schema ${SCHEMA_VERSION}. Deploy the newer version (nothing was changed)`);
  while (v < SCHEMA_VERSION) {
    if (!MIGRATIONS[v]) throw new Error(`${label}: no migration from schema ${v}`);
    MIGRATIONS[v](d); v++;
  }
  d.schemaVersion = SCHEMA_VERSION;
  return d;
}
const RETRY_MS = [5e3, 30e3, 120e3];   // a failed save is tried again after 5 s, 30 s, then every 2 min

/* one state per store folder: { dir, file, bak, db, saveTimer, loadError, saveTries, lastSaveError, lastSaveAt, lastPrune } */
const states = new Map();
function S() {
  const dir = scope.dir();
  let st = states.get(dir);
  if (!st) { st = { dir, file: path.join(dir, 'store.json'), bak: path.join(dir, 'store.json.bak'), db: null, saveTimer: null, loadError: null, saveTries: 0, lastSaveError: null, lastSaveAt: null, lastPrune: 0 }; states.set(dir, st); }
  return st;
}
/** The current store's file and its last good copy. */
const file = () => S().file;
const bakFile = () => S().bak;
/** Tests: forget every loaded store (as after a restart). Never touches the files. */
function _forget() { for (const st of states.values()) clearTimeout(st.saveTimer); states.clear(); }

const blankShopify = () => ({ lastQty: {}, ordersCursor: null, lastSync: null, lastError: null, lastTry: null });

function blank() {
  return { schemaVersion: SCHEMA_VERSION, settings: { ...DEFAULT_SETTINGS, ingestKey: crypto.randomBytes(16).toString('hex'), sheetStockCsv: '', sheetOrderCsv: '' },
    stock: [], orders: [], catalog: {}, source: 'empty', lastSync: null, lastSyncError: null, shopify: blankShopify() };
}

/** Thrown when store.json exists but can't be read and there's no good backup. The server exits on it. */
class StoreLoadError extends Error {}

/** Read and parse one store file; null when it doesn't exist. Any other problem throws. */
function readJson(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const j = JSON.parse(raw);
  if (!j || typeof j !== 'object' || !Array.isArray(j.stock) || !Array.isArray(j.orders)) throw new Error('not a Stock-out Watch store');
  return j;
}

/*
 * Only a missing file gives a blank store. A file that can't be read or parsed is copied aside
 * (store.json.corrupt-<time>) and left as it is; the last good save (store.json.bak) is used
 * instead. With no good backup, load() throws StoreLoadError and nothing is ever written.
 */
function load() {
  const st = S();
  if (st.db) return st.db;
  if (st.loadError) throw st.loadError;
  const FILE = st.file, BAK = st.bak, where = scope.current() ? ` (store ${scope.current()})` : '';
  let data;
  try { data = readJson(FILE) || blank(); } catch (e) {
    const aside = `${FILE}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { fs.copyFileSync(FILE, aside); } catch { /* unreadable: it stays where it is, untouched */ }
    let bak = null;
    try { bak = readJson(BAK); } catch { /* the backup is bad too */ }
    if (!bak) {
      st.loadError = new StoreLoadError(`store.json${where} can't be read (${e.message}) and there is no good store.json.bak; copied to ${path.basename(aside)}. Not starting, so nothing is overwritten.`);
      throw st.loadError;
    }
    console.error(`store: store.json${where} can't be read (${e.message}); copied to ${path.basename(aside)} and loaded store.json.bak instead.`);
    data = bak;
  }
  try { migrate(data, `store.json${where}`); } catch (e) {   // a newer app's file: refuse, never overwrite (SW-047)
    st.loadError = new StoreLoadError(`${e.message}. Not starting, so nothing is overwritten.`);
    throw st.loadError;
  }
  const db = st.db = data;
  db.settings = { ...blank().settings, ...db.settings };
  db.shopify = { ...blankShopify(), ...db.shopify };
  if (!db.catalog || typeof db.catalog !== 'object') db.catalog = {};
  if (!db.settings.ingestKey) db.settings.ingestKey = crypto.randomBytes(16).toString('hex');
  if (db.source === 'live') db.everLive = true;   // stores saved before everLive existed
  db._stockKeys = new Set(db.stock.map(stockKey));
  db._orderKeys = new Set(db.orders.map(orderKey));
  return db;
}

/*
 * Demo data never mixes with real data (SW-007): the first real rows to arrive (Flow, Sheet, CSV,
 * Shopify) clear the demo first: its rows, and what was done on it, "Mark ordered" (onorder.json) and the
 * slow-seller decisions (decisions.json), so no demo PO lowers a real order quantity and no demo "drop"
 * hides a real product. Every path goes through here: add() / replaceOrders() call goLive(), and the
 * Shopify pull calls endDemo() before it reads anything. everLive is kept for good, so demo data never
 * comes back at start-up.
 */
function endDemo(d = load()) {
  if (d.source !== 'demo') return false;
  d.stock = []; d.orders = []; d._stockKeys = new Set(); d._orderKeys = new Set(); d.shopify = blankShopify(); d.catalog = {}; delete d.reversals;
  d.source = 'empty';
  if (Object.keys(onorder.all()).length) onorder.clear();
  decide.clear();
  suppliers.clearDemo();
  save();
  console.log('store: real data arrived, demo data cleared (rows, Mark ordered, decisions)');
  return true;
}
function goLive(d, rows) {
  if (!rows.length) return;
  endDemo(d);
  if (d.source !== 'live') d.source = 'live';
  d.everLive = true;
}

/* ---------- saving: temp file, fsync, rename; the file it replaces stays as store.json.bak ---------- */
function writeNow(st) {
  const { dir: DATA_DIR, file: FILE, bak: BAK } = st;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const { _stockKeys, _orderKeys, ...plain } = st.db;
  const tmp = FILE + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, JSON.stringify(plain)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (fs.existsSync(FILE)) {   // keep the last good save: a hard link costs nothing; a copy where links aren't allowed
    try { fs.rmSync(BAK, { force: true }); fs.linkSync(FILE, BAK); } catch { try { fs.copyFileSync(FILE, BAK); } catch { /* best effort */ } }
  }
  fs.renameSync(tmp, FILE);
  try { const dir = fs.openSync(DATA_DIR, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } } catch { /* not every OS can fsync a folder */ }
}

/** Write the store (now, or batched after 500 ms). Never throws: a failed write is kept in health().lastSaveError and retried. */
function save(now = false) {
  require('./cache').bump();   // 1.4.3: cached answers of this store are stale
  return saveState(S(), now);
}
/* the state is captured here, so a retry 2 minutes later still writes the same store's file */
function saveState(st, now) {
  clearTimeout(st.saveTimer); st.saveTimer = null;
  if (!st.db) return true;
  const attempt = () => {
    st.saveTimer = null;
    try {
      writeNow(st);
      if (st.lastSaveError) console.log('store: saved again after an earlier failure');
      st.lastSaveError = null; st.saveTries = 0; st.lastSaveAt = Date.now();
      return true;
    } catch (e) {
      if (!st.lastSaveError || st.lastSaveError.message !== e.message) console.error('store: save failed:', e.message);
      st.lastSaveError = { message: e.message, at: Date.now() };
      st.saveTimer = setTimeout(attempt, RETRY_MS[Math.min(st.saveTries++, RETRY_MS.length - 1)]);
      st.saveTimer.unref?.();
      return false;
    }
  };
  if (now) return attempt();
  st.saveTimer = setTimeout(attempt, 500);
  st.saveTimer.unref?.();
  return true;
}
/** Shutdown: write every loaded store now. true when all of them saved. */
function saveAll() { let ok = true; for (const st of states.values()) if (!saveState(st, true)) ok = false; return ok; }

/** For /health and /status: ok = the store loaded and the last write worked. */
function health() {
  const st = S();
  return { ok: !st.loadError && !!st.db && !st.lastSaveError, loaded: !!st.db, loadError: st.loadError ? st.loadError.message : null,
    lastSaveError: st.lastSaveError, lastSaveAt: st.lastSaveAt, pendingSave: !!st.saveTimer };
}
/** Every store loaded so far (by folder): { ok, problems: [message] } for /health. */
function healthAll() {
  const problems = [];
  for (const st of states.values()) {
    if (st.loadError) problems.push(st.loadError.message);
    else if (st.lastSaveError) problems.push(`Saving data fails (${path.basename(st.dir)}): ${st.lastSaveError.message}`);
  }
  return { ok: !problems.length, problems };
}

/** Where a row came from (SW-006): shopify, flow, sheet, csv, demo or rebuilt (SW-063). Stored on every row as `src`. */
const SOURCES = ['shopify', 'flow', 'sheet', 'csv', 'demo', 'rebuilt'];   // rebuilt = Shopify's change log, SW-063
const stamp = (rows, src) => { if (src) for (const r of rows) if (!r.src) r.src = src; return rows; };

/** Add rows from `src`, skipping ones already stored. Returns how many were new. */
function add(kind, rows, src) {
  const d = load();
  stamp(rows, src);
  goLive(d, rows);
  const list = kind === 'stock' ? d.stock : d.orders;
  const keys = kind === 'stock' ? d._stockKeys : d._orderKeys;
  const keyOf = kind === 'stock' ? stockKey : orderKey;
  let n = 0;
  for (const r of rows) { const k = keyOf(r); if (keys.has(k)) continue; keys.add(k); list.push(r); n++; }
  if (n) prune();
  if (rows.length) save();
  return n;
}

/*
 * Retention (SW-002, ADR-0010): order lines and stock changes older than KEEP_DAYS are dropped,
 * except, per variant, the newest stock row (its stock now, even if it hasn't moved in months) and
 * the row that opened a stock-out still running. A variant deleted from Shopify more than KEEP_DAYS
 * ago loses all its old rows and its catalog entry.
 */
function pruneStock(rows, cut, catalog = {}) {
  if (!rows.some((r) => r.t < cut)) return rows;
  const gone = (id) => { const c = Object.hasOwn(catalog, id) ? catalog[id] : null; return !!c && c.status === 'DELETED' && c.inactiveSince < cut; };
  const by = new Map();
  for (const r of rows) { const id = String(r.variantId); if (!by.has(id)) by.set(id, []); by.get(id).push(r); }
  const keep = new Set();
  for (const [id, list] of by) {
    if (gone(id)) continue;
    list.sort((a, b) => a.t - b.t);
    let i = list.length - 1; keep.add(list[i]);
    if (Number(list[i].now) <= 0) { while (i > 0 && Number(list[i - 1].now) <= 0) i--; keep.add(list[i]); }   // the stock-out's first row
  }
  return rows.filter((r) => r.t >= cut || keep.has(r));
}

/** Runs at most once an hour per store (it walks every row), or now with force. */
function prune(force = false, now = Date.now()) {
  const st = S();
  if (!force && now - st.lastPrune < 3600e3) return;
  st.lastPrune = now;
  const cut = now - KEEP_DAYS * 864e5;
  const d = load();
  const stock = pruneStock(d.stock, cut, d.catalog);
  if (stock.length !== d.stock.length) { d.stock = stock; d._stockKeys = new Set(d.stock.map(stockKey)); }
  if (d.orders.some((r) => r.t < cut)) { d.orders = d.orders.filter((r) => r.t >= cut); d._orderKeys = new Set(d.orders.map(orderKey)); }
  if (Array.isArray(d.reversals) && d.reversals.some((e) => e.t < cut)) d.reversals = d.reversals.filter((e) => e.t >= cut);
  if (d.catalog) for (const [id, c] of Object.entries(d.catalog)) {
    if (c.status === 'DELETED' && c.inactiveSince < cut) delete d.catalog[id];
    else if (Array.isArray(c.spells) && c.spells.some((x) => x.to < cut)) { c.spells = c.spells.filter((x) => x.to >= cut); if (!c.spells.length) delete c.spells; }
  }
}

/*
 * The current-stock snapshot (SW-002, ADR-0010): every variant Shopify returned on this pull, with
 * its stock now, price, cost, type, tags and status, replaced whole on each pull. Engine reads stock
 * and attributes from here; stock rows are history only. A variant that turns inactive (archived,
 * draft, untracked) keeps the time it was first seen inactive; one that disappears (deleted) is kept
 * as a DELETED entry, and so is any variant with stock rows that Shopify no longer returns.
 */
const MAX_SPELLS = 20;   // past inactive spells kept per variant (older than 120 days are pruned anyway)
function setCatalog(next, now = Date.now()) {
  const d = load(); const prev = d.catalog || {}; const out = {};
  const has = (o, id) => Object.hasOwn(o, id);   // variant IDs are data: never Object.prototype keys
  for (const [id, c] of Object.entries(next)) {
    const p = has(prev, id) ? prev[id] : null;
    /* inactive spells that ended (made active again) are kept, so the engine still cuts stock-outs there (LOGIC.md §1) */
    const spells = p && Array.isArray(p.spells) ? p.spells.slice(-MAX_SPELLS) : [];
    if (c.active !== false && p && p.active === false && p.inactiveSince && p.inactiveSince < now) spells.push({ from: p.inactiveSince, to: now, status: p.status || 'INACTIVE' });
    out[id] = c.active !== false ? c : { ...c, inactiveSince: p && p.active === false && p.status !== 'DELETED' && p.inactiveSince ? p.inactiveSince : now };
    if (spells.length) out[id] = { ...out[id], spells: spells.slice(-MAX_SPELLS) };
  }
  const tomb = (id, base) => { out[id] = { ...base, active: false, status: 'DELETED', inactiveSince: base.status === 'DELETED' && base.inactiveSince ? base.inactiveSince : now, stock: base.stock ?? null }; };
  for (const [id, p] of Object.entries(prev)) if (!has(out, id)) tomb(id, p);
  for (const r of d.stock) { const id = String(r.variantId); if (!has(out, id)) tomb(id, { product: r.product, variant: r.variant, sku: r.sku, stock: null, seenAt: r.t }); }
  d.catalog = out;
  save();
  return out;
}

/*
 * Stock history rebuilt from Shopify's change log (SW-063, src/history.js): replaces any earlier rebuilt rows. They
 * carry src 'rebuilt' and only cover times before the first live read, so they never overlap pulled rows.
 */
function setRebuilt(rows) {
  const d = load();
  stamp(rows, 'rebuilt');
  d.stock = d.stock.filter((r) => r.src !== 'rebuilt').concat(rows);
  d._stockKeys = new Set(d.stock.map(stockKey));
  save();
  return rows.length;
}

/** Replace every line of these orders with `rows` (a test order ends up with none; a cancelled one keeps qty-0 lines for its returns, 1.1.3). */
function replaceOrders(names, rows, src = 'shopify') {
  const d = load(); const set = new Set(names);
  stamp(rows, src);
  goLive(d, rows);
  const before = d.orders.length;
  d.orders = d.orders.filter((r) => !set.has(r.order)).concat(rows);
  d._orderKeys = new Set(d.orders.map(orderKey));
  prune(); save();
  return { added: rows.length, removed: before - (d.orders.length - rows.length) };
}

/**
 * Reversal events (1.1.5, LOGIC.md §9e, src/shopify.js reversalEvents): `{ id, t, order, variantId, qty, value, kind }`,
 * one per refund line or cancelled line. Every order read replaces its events whole (a refund edited or removed in
 * Shopify goes too), one event per id across orders, older than KEEP_DAYS dropped. `d.reversals` is absent until the
 * first pull that reads them (the engine then counts returns by order date, the older way).
 */
function replaceReversals(orderNames, events) {
  const d = load(), set = new Set(orderNames), cut = Date.now() - KEEP_DAYS * 864e5;
  const fresh = new Map();
  for (const e of events || []) if (e && e.id != null && Number.isFinite(+e.t) && +e.t >= cut) fresh.set(String(e.id), e);
  d.reversals = (Array.isArray(d.reversals) ? d.reversals : []).filter((e) => !set.has(e.order) && !fresh.has(String(e.id))).concat([...fresh.values()]);
  save();
  return fresh.size;
}

function replaceAll(stock, orders, source) {
  const d = load();
  if (source === 'demo') { stamp(stock, 'demo'); stamp(orders, 'demo'); }
  d.stock = stock; d.orders = orders; d.source = source; delete d.reversals;
  d._stockKeys = new Set(stock.map(stockKey)); d._orderKeys = new Set(orders.map(orderKey));
  d.shopify = blankShopify();   // re-read everything from Shopify on the next pull
  d.catalog = {};
  save(true);
}

function setSettings(patch) {
  const d = load();
  d.settings = { ...d.settings, ...patch };
  save(true);
  return d.settings;
}

function setSync(info) { Object.assign(load(), info); save(); }

function setShopify(patch) { const d = load(); d.shopify = { ...d.shopify, ...patch }; save(); return d.shopify; }

module.exports = { SCHEMA_VERSION, migrate, SOURCES, load, add, endDemo, setCatalog, setRebuilt, prune, pruneStock, replaceAll, replaceOrders, replaceReversals, setSettings, setSync, setShopify, save, saveAll, health, healthAll, StoreLoadError, file, bakFile, KEEP_DAYS, _forget };
