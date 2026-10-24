'use strict';
/* Start the application.
 *
 * This project installs nothing, so the runtime is located rather than depended
 * upon. A copy inside this project is preferred; an existing Electron install
 * named by ELECTRON_PATH is the fallback, so the application runs before
 * anything has been copied in.
 *
 * `node tools/launch.js --adopt` copies that runtime into this project, which
 * makes it independent of the other install. Worth doing once, so that tidying
 * up elsewhere cannot stop this application starting.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LOCAL_RUNTIME = path.join(ROOT, 'runtime', 'electron');

const CANDIDATES = [
  path.join(LOCAL_RUNTIME, 'electron.exe'),
  process.env.ELECTRON_PATH
].filter(Boolean);

function exists(file) {
  try { return fs.statSync(file).isFile(); } catch (e) { return false; }
}

function findRuntime() {
  return CANDIDATES.find(exists) || null;
}

function adopt() {
  const source = CANDIDATES.slice(1).find(exists);
  if (!source) {
    console.error('No runtime found to copy from.');
    process.exit(1);
  }
  const from = path.dirname(source);
  console.log('Copying the runtime from ' + from);
  console.log('into ' + LOCAL_RUNTIME + ' — around 260MB, once.');
  fs.mkdirSync(path.dirname(LOCAL_RUNTIME), { recursive: true });
  fs.cpSync(from, LOCAL_RUNTIME, { recursive: true });
  console.log('Done. The application no longer depends on the other project.');
}

function main() {
  const args = process.argv.slice(2);

  if (args.indexOf('--adopt') !== -1) {
    adopt();
    return;
  }

  const runtime = findRuntime();
  if (!runtime) {
    console.error('No runtime found. Looked in:\n  ' + CANDIDATES.join('\n  '));
    process.exit(1);
  }

  const wait = args.indexOf('--wait') !== -1;
  const passthrough = args.filter(a => a !== '--wait');

  const child = spawn(runtime, [ROOT].concat(passthrough), {
    cwd: ROOT,
    stdio: wait ? 'inherit' : 'ignore',
    detached: !wait,
    windowsHide: false
  });

  if (wait) {
    child.on('exit', code => process.exit(code || 0));
  } else {
    child.unref();
    console.log('Started from ' + runtime);
  }
}

if (require.main === module) main();

module.exports = { findRuntime, CANDIDATES, LOCAL_RUNTIME };
