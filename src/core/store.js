'use strict';
/* Persistence. JSON files on this machine, and nothing else.
 *
 * The brief calls for separate databases per concern — market, fundamentals,
 * news, portfolio, research, journal, configuration, audit. That separation is
 * real here and is expressed as separate stores rooted at separate directories,
 * so a corrupt news cache cannot take the trade journal with it and any one of
 * them can be deleted without touching the rest.
 *
 * No SQLite: this application installs nothing. node:sqlite exists in Node 24
 * but is still flagged experimental. Candle history is the only dataset large
 * enough to argue about, and it is held as one file per instrument-timeframe,
 * which reads and writes in a few milliseconds.
 *
 * Two guarantees this file exists to provide:
 *
 *   WRITES ARE ATOMIC. Every save goes to a temp file, is flushed to disk, and
 *   is then renamed over the target. A crash mid-write leaves the previous file
 *   intact rather than a truncated one. A half-written trade journal is not
 *   recoverable by the person who owns it.
 *
 *   WRITES ARE SERIALISED PER KEY. A background price poll and a click can land
 *   in the same tick. Each key has a one-at-a-time queue, so the later write
 *   cannot begin before the earlier one has landed.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { safeName } = require('./util');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.cache = Object.create(null);
    this.queues = Object.create(null);
    this.lastCorruption = null;
    fs.mkdirSync(dir, { recursive: true });
  }

  /* Keys reach this from instrument symbols, which contain characters Windows
     treats specially — `^GSPC`, `GC=F`, `BRK-B`. safeName is what keeps a colon
     out of a path; see its comment for what happens otherwise. */
  file(name) {
    return path.join(this.dir, safeName(name) + '.json');
  }

  /* Read once, then serve from memory. Every mutation goes back through save()
     so the cache cannot drift from the file on disk. */
  read(name, fallback) {
    if (this.cache[name] !== undefined) return this.cache[name];
    let value = fallback;
    try {
      value = JSON.parse(fs.readFileSync(this.file(name), 'utf8'));
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        /* A corrupt file is moved aside, never overwritten. Renaming keeps the
           bytes recoverable by hand; starting fresh would let one parse error
           silently discard a year of records. */
        const dead = this.file(name) + '.corrupt-' + Date.now();
        try { fs.renameSync(this.file(name), dead); } catch (e) { /* nothing to move */ }
        this.lastCorruption = { name, movedTo: dead, error: String(err.message || err) };
      }
      value = fallback;
    }
    this.cache[name] = value;
    return value;
  }

  save(name, value) {
    this.cache[name] = value;
    const previous = this.queues[name] || Promise.resolve();
    const next = previous.then(() => this._write(name, value), () => this._write(name, value));
    /* The queue itself must never hold a rejection, or one failed write stalls
       every later write to that key for the life of the process. */
    this.queues[name] = next.then(() => undefined, () => undefined);
    return next;
  }

  async _write(name, value) {
    const target = this.file(name);
    const tmp = target + '.tmp-' + process.pid;
    const body = JSON.stringify(value);
    let handle;
    try {
      handle = await fsp.open(tmp, 'w');
      await handle.writeFile(body, 'utf8');
      await handle.sync();
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
    await fsp.rename(tmp, target);
  }

  /* Every pending write, landed. Called before the process exits so a session
     that quits cannot lose its last save. */
  async flush() {
    await Promise.all(Object.values(this.queues));
  }

  exists(name) {
    try { return fs.statSync(this.file(name)).isFile(); } catch (e) { return false; }
  }

  drop(name) {
    delete this.cache[name];
    try { fs.unlinkSync(this.file(name)); } catch (e) { /* already gone */ }
  }

  keys() {
    try {
      return fs.readdirSync(this.dir)
        .filter(f => f.endsWith('.json'))
        .map(f => f.slice(0, -5));
    } catch (e) {
      return [];
    }
  }

  /* ---------- collections: lists of records keyed on `id` ---------- */

  all(name) { return this.read(name, []); }

  byId(name, id) {
    return this.all(name).find(r => r && r.id === id) || null;
  }

  put(name, record) {
    const list = this.all(name).slice();
    const at = list.findIndex(r => r && r.id === record.id);
    if (at === -1) list.push(record); else list[at] = record;
    this.save(name, list);
    return record;
  }

  /* Index first, then merge. Repeatedly scanning the list per record makes a
     bulk write quadratic, which is invisible at ten rows and blocking at ten
     thousand. */
  putMany(name, records) {
    const list = this.all(name).slice();
    const index = Object.create(null);
    list.forEach((r, i) => { if (r && r.id) index[r.id] = i; });
    records.forEach(record => {
      if (!record || !record.id) return;
      const at = index[record.id];
      if (at === undefined) { index[record.id] = list.length; list.push(record); }
      else list[at] = record;
    });
    this.save(name, list);
    return records.length;
  }

  remove(name, id) {
    this.save(name, this.all(name).filter(r => !r || r.id !== id));
  }

  /* ---------- documents: a single object per key ---------- */

  doc(name, fallback) { return this.read(name, fallback); }

  putDoc(name, value) { this.save(name, value); return value; }

  patchDoc(name, patch, fallback) {
    const next = Object.assign({}, this.read(name, fallback || {}), patch);
    this.save(name, next);
    return next;
  }
}

module.exports = { Store };
