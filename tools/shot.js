'use strict';
/* Photograph a running window.
 *
 * Reading the document tells you an element exists, has children and reports a
 * width. It does not tell you the panel is empty, that its text is the same
 * colour as what is behind it, or that something is sitting on top of it. Those
 * are the failures that get reported as "it's blank", and no assertion about
 * the tree catches any of them.
 *
 *   node tools/shot.js --port 9222 [--out shot.png] [--full]
 *
 * Attaches to a window that is already open and takes its picture. It clicks
 * nothing and changes nothing.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

function flag(name, fallback) {
  const at = process.argv.indexOf('--' + name);
  return at === -1 ? fallback : (process.argv[at + 1] || fallback);
}

const PORT = Number(flag('port', 9222)) || 9222;
const OUT = path.resolve(flag('out', 'shot.png'));
const FULL = process.argv.indexOf('--full') !== -1;

function targets() {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 4000 }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (err) { reject(err); } });
    });
    request.on('error', reject);
    request.on('timeout', () => { request.destroy(); reject(new Error('timed out')); });
  });
}

async function main() {
  let list;
  try {
    list = await targets();
  } catch (err) {
    console.log('Nothing is listening on port ' + PORT + '. Start the window with ' +
      '--remote-debugging-port=' + PORT + '.');
    process.exit(1);
  }

  const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) { console.log('That window has no page yet.'); process.exit(1); }

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let sequence = 0;

  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', () => reject(new Error('could not attach')));
  });

  const send = (method, params) => new Promise(resolve => {
    const id = ++sequence;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params: params || {} }));
  });

  /* A window parked off the edge of the screen is composited lazily, so ask for
     a frame and give it one before reading the pixels back. */
  await send('Page.enable');
  await new Promise(r => setTimeout(r, 300));

  const shot = await send('Page.captureScreenshot',
    FULL ? { format: 'png', captureBeyondViewport: true } : { format: 'png' });

  if (!shot.result || !shot.result.data) {
    console.log('The window would not give up a frame.');
    process.exit(1);
  }

  fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
  const size = fs.statSync(OUT).size;
  console.log('Wrote ' + OUT + ' (' + Math.round(size / 1024) + 'kB)');
  socket.close();
}

main().catch(err => { console.log('Failed: ' + err.message); process.exit(1); });
