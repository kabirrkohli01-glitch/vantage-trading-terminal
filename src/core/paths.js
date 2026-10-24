'use strict';
/* Where everything on disk lives.
 *
 * The brief calls for separate databases per concern rather than one shared
 * file, so each store below is rooted at its own directory. That is not
 * tidiness: a corrupt news cache must not be able to take the trade journal
 * with it, and any one of these directories can be deleted to reset that one
 * concern without disturbing the others.
 *
 * Resolution order lets a test run point the whole application at a temporary
 * directory by setting one environment variable, which is what keeps the test
 * suite from writing into real data.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

function root() {
  if (process.env.TERMINAL_DATA_DIR) return path.resolve(process.env.TERMINAL_DATA_DIR);
  return path.join(__dirname, '..', '..', 'data');
}

const DIRS = {
  /* Candles and quote snapshots. Large, regenerable, safe to delete. */
  market: 'market',
  /* Company financials and filing metadata, keyed by filer identifier. */
  fundamentals: 'fundamentals',
  /* Article metadata. Never article bodies. */
  news: 'news',
  /* Positions, transactions and broker imports. */
  portfolio: 'portfolio',
  /* Generated research reports, kept with the timestamp they were produced. */
  research: 'research',
  /* Trades, notes and screenshots. The one directory whose loss is not
     recoverable from any upstream, and therefore the one that matters most. */
  journal: 'journal',
  /* Layouts, themes, watchlists, alerts, indicator presets. */
  config: 'config',
  /* HTTP response cache. Purely derived; deleting it costs only time. */
  cache: 'cache',
  /* Uploaded documents, stored under filenames that have passed safeName. */
  documents: 'documents',
  /* Replay and backtest results. */
  simulation: 'simulation'
};

function dir(name) {
  const leaf = DIRS[name];
  if (!leaf) throw new Error('Unknown data directory: ' + name);
  const full = path.join(root(), leaf);
  try { fs.mkdirSync(full, { recursive: true }); } catch (e) { /* surfaced on first use */ }
  return full;
}

function logsDir() {
  const full = path.join(root(), '..', 'logs');
  const resolved = path.resolve(full);
  try { fs.mkdirSync(resolved, { recursive: true }); } catch (e) { /* surfaced on first use */ }
  return resolved;
}

function auditFile() {
  return path.join(logsDir(), 'audit.jsonl');
}

/* A scratch directory that is safe to delete at any time. */
function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), (prefix || 'terminal') + '-'));
}

module.exports = { root, dir, DIRS, logsDir, auditFile, tempDir };
