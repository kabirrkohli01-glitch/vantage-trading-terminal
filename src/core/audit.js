'use strict';
/* The audit log: an append-only record of everything consequential.
 *
 * Written as JSON Lines rather than one JSON array, for one reason: an array
 * has to be parsed and rewritten whole on every append, so a crash mid-write
 * destroys the entire history. One self-contained line per event means a
 * truncated write costs the last line and nothing else, and the file can be
 * read with any text tool while the application is running.
 *
 * WHAT NEVER GOES IN HERE: credentials, tokens, API keys, message bodies, or
 * anything from an uploaded document. Events record what happened and to which
 * record, not the contents. Anything that looks credential-shaped is redacted
 * on the way in rather than trusted not to arrive.
 *
 * Recorded figures are a deliberate exception to the rule that computed numbers
 * do not belong in stored text. In a user-facing history a stored number goes
 * stale and is re-read as current; here every line carries the instant it was
 * written and the log is only ever read as history, which is the entire point
 * of keeping one.
 */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 8 * 1024 * 1024;
const KEEP_ROTATIONS = 3;

/* Field names whose values are never written, whatever they contain. */
const SECRET_KEYS = /^(token|secret|key|apikey|api_key|password|passcode|cookie|crumb|authorization|bearer|credential)s?$/i;
/* Values shaped like credentials, caught even under an innocent field name. */
const SECRET_VALUE = /\b(sk-[A-Za-z0-9]{16,}|gsk_[A-Za-z0-9]{16,}|nvapi-[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}|[A-Fa-f0-9]{40,})\b/;

function redact(value, depth) {
  const level = depth || 0;
  if (level > 4) return '[deep]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    if (SECRET_VALUE.test(value)) return '[redacted]';
    return value.length > 500 ? value.slice(0, 500) + '…' : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) return value.slice(0, 40).map(v => redact(v, level + 1));

  if (typeof value === 'object') {
    const out = {};
    Object.keys(value).slice(0, 40).forEach(key => {
      out[key] = SECRET_KEYS.test(key) ? '[redacted]' : redact(value[key], level + 1);
    });
    return out;
  }
  return String(value);
}

class Audit {
  constructor(file) {
    this.file = file;
    this.listeners = [];
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e) { /* reported at first write */ }
  }

  /* `kind` is a stable machine-readable slug; `detail` is structured data.
     Human phrasing is built at read time so the vocabulary can change without
     rewriting history. */
  write(kind, detail) {
    const event = {
      at: new Date().toISOString(),
      kind: String(kind || 'event'),
      detail: redact(detail || {})
    };
    const line = JSON.stringify(event) + '\n';

    try {
      this.rotateIfLarge();
      fs.appendFileSync(this.file, line, 'utf8');
    } catch (e) {
      /* A log that cannot be written must not take the application down with
         it. The failure surfaces through the data-health panel instead. */
      this.lastError = String(e && e.message || e);
    }

    this.listeners.forEach(fn => { try { fn(event); } catch (e) { /* a listener must not break the log */ } });
    return event;
  }

  rotateIfLarge() {
    let size = 0;
    try { size = fs.statSync(this.file).size; } catch (e) { return; }
    if (size < MAX_BYTES) return;

    for (let i = KEEP_ROTATIONS - 1; i >= 1; i--) {
      try { fs.renameSync(this.file + '.' + i, this.file + '.' + (i + 1)); } catch (e) { /* absent */ }
    }
    try { fs.renameSync(this.file, this.file + '.1'); } catch (e) { /* absent */ }
  }

  /* Most recent first, because that is the order anyone investigating reads in.
     A malformed line is skipped rather than aborting the read — a log is most
     valuable precisely when something went wrong while writing it. */
  recent(limit, filter) {
    let raw = '';
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (e) { return []; }

    const out = [];
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0 && out.length < (limit || 200); i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch (e) { continue; }
      if (filter && !filter(event)) continue;
      out.push(event);
    }
    return out;
  }

  onEvent(fn) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(f => f !== fn); };
  }
}

module.exports = { Audit, redact };
