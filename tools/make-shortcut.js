'use strict';
/* Put the application on the desktop.
 *
 * A Windows shortcut is a COM object, so it is created through PowerShell's
 * WScript.Shell rather than by writing the binary format by hand. The target is
 * the runtime with this project's folder as its argument, which is exactly what
 * `tools/launch.js` does — the shortcut is a second door onto the same start,
 * not a different way of starting.
 *
 * The icon is the generated .ico rather than the runtime's own, or every
 * terminal window on the machine would wear the same mark.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const brand = require('../src/core/brand');
const { findRuntime } = require('./launch');

const ROOT = path.join(__dirname, '..');
const ICON = path.join(ROOT, 'web', 'assets', brand.iconStem + '.ico');

/* The desktop is not always where the profile says it is: a machine signed into
   OneDrive has it redirected, and writing to the unredirected path produces a
   shortcut nobody ever sees. Both are checked, most-likely first. */
function desktopPaths() {
  const home = os.homedir();
  const candidates = [];
  if (process.env.OneDrive) candidates.push(path.join(process.env.OneDrive, 'Desktop'));
  candidates.push(path.join(home, 'OneDrive', 'Desktop'));
  candidates.push(path.join(home, 'Desktop'));

  /* The environment variable and the profile path frequently resolve to the
     same folder, which would otherwise write the same shortcut twice and report
     it as two. */
  const seen = new Set();
  return candidates.filter(dir => {
    let real;
    try {
      if (!fs.statSync(dir).isDirectory()) return false;
      real = fs.realpathSync.native(dir).toLowerCase();
    } catch (e) {
      return false;
    }
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

function create(target, args, icon, linkPath, description) {
  /* Single-quoted PowerShell so nothing in a path is expanded, with any
     embedded quote doubled the way PowerShell escapes it. */
  const q = value => "'" + String(value).replace(/'/g, "''") + "'";

  const script = [
    '$shell = New-Object -ComObject WScript.Shell',
    '$link = $shell.CreateShortcut(' + q(linkPath) + ')',
    '$link.TargetPath = ' + q(target),
    '$link.Arguments = ' + q(args),
    '$link.WorkingDirectory = ' + q(ROOT),
    '$link.IconLocation = ' + q(icon + ',0'),
    '$link.Description = ' + q(description),
    '$link.WindowStyle = 1',
    '$link.Save()'
  ].join('; ');

  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8'
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error('The shortcut could not be created: ' + (result.stderr || '').trim());
  }
}

function main() {
  const runtime = findRuntime();
  if (!runtime) {
    console.error('No runtime found, so a shortcut would point at nothing.');
    process.exit(1);
  }
  if (!fs.existsSync(ICON)) {
    console.error('No icon found. Run `node tools/make-icons.js` first.');
    process.exit(1);
  }

  const desktops = desktopPaths();
  if (!desktops.length) {
    console.error('No desktop folder could be found for this profile.');
    process.exit(1);
  }

  const description = brand.name + ' — ' + brand.attribution;
  let written = 0;

  desktops.forEach(desktop => {
    const linkPath = path.join(desktop, brand.name + '.lnk');
    try {
      create(runtime, '"' + ROOT + '"', ICON, linkPath, description);
      console.log('Created ' + linkPath);
      written++;
    } catch (err) {
      console.error('Could not write to ' + desktop + ': ' + err.message);
    }
  });

  if (!written) process.exit(1);
  console.log('Target: ' + runtime);
  console.log('Icon:   ' + ICON);
}

if (require.main === module) main();

module.exports = { desktopPaths, create };
