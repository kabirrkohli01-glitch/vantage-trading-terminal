'use strict';
/* Small shared helpers with no dependencies of their own. */

const crypto = require('crypto');
const path = require('path');

/* A short stable key for a string, used for cache filenames.
 *
 * The readable prefix is kept so a cache directory can be inspected by eye
 * during debugging; the hash is what guarantees uniqueness. */
function slugHash(text) {
  const value = String(text == null ? '' : text);
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const hash = crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
  return (slug ? slug + '-' : '') + hash;
}

/* Turn any identifier into something that is safe as a Windows filename.
 *
 * On Windows a colon in a path does not name a file — it names an NTFS
 * alternate data stream hanging off the part before it. Writing to such a path
 * succeeds, reports the correct byte count and throws nothing, but the result
 * cannot be listed, opened or served, and the containing folder looks empty.
 * Any filename derived from a generated id must pass through here first. */
function safeName(id) {
  return String(id == null ? '' : id).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'unnamed';
}

/* Resolve a relative path inside a root and refuse anything that escapes it.
 *
 * path.join happily walks out of the root with enough leading '..' segments;
 * resolving first and then testing the prefix is the check that actually
 * holds. */
function within(root, relative) {
  const base = path.resolve(root);
  const target = path.resolve(base, String(relative || ''));
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

/* Random id with a readable prefix, for records the operator may need to
   discuss or search for. */
function id(prefix) {
  return (prefix ? prefix + '_' : '') + crypto.randomBytes(8).toString('hex');
}

/* Clamp without the NaN surprise: Math.min/Math.max propagate NaN silently,
   which turns a bad viewport into an invisible chart rather than an error. */
function clamp(value, low, high) {
  const n = Number(value);
  if (!isFinite(n)) return low;
  return n < low ? low : (n > high ? high : n);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { slugHash, safeName, within, id, clamp, sleep };
