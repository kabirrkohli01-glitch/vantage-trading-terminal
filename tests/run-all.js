'use strict';
/* The test suite.
 *
 * No framework, no runner, no dependency: `node tests/run-all.js`. Assertions
 * are counted rather than suites, because "142 suites passed" hides how much
 * was actually checked inside them.
 *
 * Suite names are written as claims in plain English. A failure should read as
 * a statement about the product that has stopped being true, not as the name of
 * a function.
 *
 * Several suites deliberately grep the source of other files. Those are
 * architectural assertions — rules that cannot be expressed as a unit test
 * because they are about what the code may not contain.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');

/* Point every store at a throwaway directory before anything is required, so a
   test run can never touch real data. */
process.env.TERMINAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-test-'));

let passed = 0;
let failed = 0;
const failures = [];

function suite(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log('  ✗ ' + name + '\n      ' + err.message);
  }
}

async function asyncSuite(name, fn) {
  try {
    await fn();
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log('  ✗ ' + name + '\n      ' + err.message);
  }
}

function ok(condition, message) {
  passed++;
  if (!condition) throw new Error(message || 'expected true');
}

function eq(actual, expected, message) {
  passed++;
  if (actual !== expected) {
    throw new Error((message || 'values differ') +
      '\n      expected: ' + JSON.stringify(expected) +
      '\n      actual:   ' + JSON.stringify(actual));
  }
}

function near(actual, expected, tolerance, message) {
  passed++;
  const gap = Math.abs(Number(actual) - Number(expected));
  if (!(gap <= tolerance)) {
    throw new Error((message || 'values differ') +
      '\n      expected: ' + expected + ' ±' + tolerance +
      '\n      actual:   ' + actual);
  }
}

function throws(fn, message) {
  passed++;
  try {
    fn();
  } catch (e) {
    return;
  }
  throw new Error(message || 'expected this to throw');
}

/* Every .js file in the project except tests and generated output. */
function sourceFiles() {
  const out = [];
  const skip = new Set(['node_modules', 'data', 'logs', '.git', 'tests', 'dist']);
  (function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    entries.forEach(entry => {
      if (skip.has(entry.name)) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push(full);
    });
  })(ROOT);
  return out;
}

function report() {
  console.log('');
  if (failed) {
    console.log(failed + ' failing:');
    failures.forEach(f => {
      console.log('\n  ' + f.name);
      console.log('    ' + f.err.message);
      String(f.err.stack || '').split('\n').slice(1, 4).forEach(l => console.log('    ' + l.trim()));
    });
    console.log('\n' + failed + ' failed, ' + passed + ' assertions ran.');
    process.exit(1);
  }
  console.log('All suites passed — ' + passed + ' assertions.');
}

module.exports = { suite, asyncSuite, ok, eq, near, throws, sourceFiles, ROOT, report };

/* ------------------------------------------------------------------ */

const groups = [
  './core-tests',
  './market-tests',
  './news-tests',
  './analysis-tests',
  './portfolio-tests',
  './journal-tests',
  './risk-tests',
  './paper-tests',
  './alerts-tests',
  './syrix-tests',
  './terminal-tests',
  './architecture-tests'
];

(async () => {
  for (const group of groups) {
    let mod;
    try {
      mod = require(group);
    } catch (err) {
      if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(group.slice(2))) continue;
      throw err;
    }
    if (typeof mod.run === 'function') await mod.run(module.exports);
  }
  report();
})();
