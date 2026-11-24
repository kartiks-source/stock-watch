'use strict';
/*
 * The small JSON files kept next to store.json: onorder.json ("Mark ordered", LOGIC.md §6b) and decisions.json
 * (slow-seller decisions, §15d). Kept as safely as store.json (SW-004, critic r2 X1):
 *   - only a missing file starts empty;
 *   - a file that can't be read is copied aside (<name>.corrupt-<time>) and never overwritten; the last good save
 *     (<name>.bak) is used instead; with no good .bak, read() throws, the server refuses to start, nothing is written;
 *   - writes go through a temp file, fsync, rename; the file it replaces stays as <name>.bak.
 * Backups, the backup export and restore carry both files (src/backup.js, `sideFiles`).
 */
const fs = require('node:fs');
const path = require('node:path');
const scope = require('./scope');

class SideFileError extends Error {}
/** The current store's folder (DATA_DIR/stores/<id>, ADR-0015). */
const dataDir = () => scope.dir();

/** A side file's content: a plain JSON object, or null when the file doesn't exist. Anything else throws. */
function parse(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const j = JSON.parse(raw);
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not a JSON object');
  return j;
}

/** Write via a temp file, fsync, rename. keepBak: the file it replaces becomes <file>.bak (a hard link, else a copy). */
function writeAtomic(file, text, keepBak = true) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (keepBak && fs.existsSync(file)) {
    try { fs.rmSync(file + '.bak', { force: true }); fs.linkSync(file, file + '.bak'); } catch { try { fs.copyFileSync(file, file + '.bak'); } catch { /* best effort */ } }
  }
  fs.renameSync(tmp, file);
}

/** One side file per store, <store folder>/<name>. read() → the object (cached per store); write() saves it;
 *  reset() forgets the current store's cache (tests, restore); resetAll() every store's. */
function sideFile(name) {
  const states = new Map();   // store folder → { data, error, mainBad }
  const file = () => path.join(dataDir(), name);
  const S = () => { const f = file(); let st = states.get(f); if (!st) { st = { data: null, error: null, mainBad: false }; states.set(f, st); } return st; };
  function read() {
    const st = S();
    if (st.data) return st.data;
    if (st.error) throw st.error;
    let data;
    const f = file();
    try { data = parse(f) || {}; } catch (e) {
      const aside = `${f}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try { fs.copyFileSync(f, aside); } catch { /* unreadable: it stays where it is, untouched */ }
      let bak = null;
      try { bak = parse(f + '.bak'); } catch { /* the backup is bad too */ }
      if (!bak) {
        st.error = new SideFileError(`${name} can't be read (${e.message}) and there is no good ${name}.bak; copied to ${path.basename(aside)}. Not starting, so nothing is overwritten.`);
        throw st.error;
      }
      console.error(`${name} can't be read (${e.message}); copied to ${path.basename(aside)} and loaded ${name}.bak instead.`);
      data = bak; st.mainBad = true;
    }
    st.data = data;
    return data;
  }
  function write(next) {
    const st = S();
    require('./cache').bump();   // 1.4.3: Mark ordered, decisions, suppliers… change the cached answers
    if (next !== undefined) st.data = next;
    if (!st.data) st.data = {};
    writeAtomic(file(), JSON.stringify(st.data), !st.mainBad);   // never make the bad file the .bak
    st.mainBad = false;
  }
  const reset = () => { states.delete(file()); };
  const resetAll = () => { states.clear(); };
  return { name, file, read, write, reset, resetAll };
}

module.exports = { sideFile, parse, writeAtomic, SideFileError, dataDir };
