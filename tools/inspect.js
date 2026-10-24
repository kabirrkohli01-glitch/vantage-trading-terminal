'use strict';
/* Read the state of a running window.
 *
 * The interface probe drives a copy of the application it launched itself,
 * against a throwaway data directory. That is the right way to test, and it is
 * the wrong way to answer "why does the one on my screen not look like that".
 * This attaches to a window that is already open — the operator's own, with the
 * operator's own records behind it — and reports what is actually in it.
 *
 * It only reads. Nothing here clicks, types, writes or navigates.
 *
 *   node tools/inspect.js [--port 9222] ["<expression>"]
 *
 * The window has to have been started with a debugging port for anything to
 * attach to, which the ordinary launch deliberately does not do.
 */

const http = require('http');

const PORT = (() => {
  const at = process.argv.indexOf('--port');
  return at === -1 ? 9222 : Number(process.argv[at + 1]) || 9222;
})();

function fetchJson(path) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: PORT, path, timeout: 4000 }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    });
    request.on('error', reject);
    request.on('timeout', () => { request.destroy(); reject(new Error('timed out')); });
  });
}

/* What is worth knowing when the screen and the source disagree. Each line is a
   fact about the running page, not about the files on disk. */
const REPORT = `(() => {
  const state = window.__state || {};
  const chart = state.chart;
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const text = id => ((document.getElementById(id) || {}).textContent || '').trim().slice(0, 70);
  const main = document.querySelector('.ws-main');

  return {
    document: document.readyState,
    errors: (window.__probe && window.__probe.errors) || 'not instrumented',

    theme: document.documentElement.getAttribute('data-theme'),
    accent: css('--accent'),
    candleUp: css('--candle-up'),

    barSizeStrip: document.querySelectorAll('#tf-strip .tf-btn').length,
    leftoverScreenTabs: document.querySelectorAll('.topnav-btn').length,
    rail: [...document.querySelectorAll('#rail .rail-btn')].map(b => b.dataset.view || b.dataset.act),

    watchlistRows: document.querySelectorAll('.wl-row').length,
    watchlistPriced: [...document.querySelectorAll('.wl-px')].filter(n => n.textContent.trim() !== '—').length,
    researchTabs: [...document.querySelectorAll('#detail-tabs .side-tab')].map(b => b.dataset.tab),
    researchBody: text('detail-body'),

    interval: state.chartInterval,
    served: state.servedTimeframe,
    range: state.chartRange,
    bars: chart ? chart.bars.length : -1,
    visibleBars: chart ? Math.round(chart.view.to - chart.view.from) : -1,

    gridRows: main ? getComputedStyle(main).gridTemplateRows : null,
    gridChildren: main ? main.children.length : -1,

    panels: state.panels,
    chartStyle: state.chartStyle
  };
})()`;

async function main() {
  let targets;
  try {
    targets = await fetchJson('/json/list');
  } catch (err) {
    console.log('Nothing is listening on port ' + PORT + '.');
    console.log('Start the application with --remote-debugging-port=' + PORT + ' to attach.');
    process.exit(1);
  }

  const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) {
    console.log('That window has no page to read yet.');
    process.exit(1);
  }

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

  const expression = process.argv.find(a => !a.startsWith('--') && a !== String(PORT) &&
    a !== process.argv[0] && a !== process.argv[1]);

  const reply = await send('Runtime.evaluate', {
    expression: expression || REPORT,
    returnByValue: true,
    awaitPromise: true
  });

  if (reply.result && reply.result.exceptionDetails) {
    console.log('The page threw: ' + reply.result.exceptionDetails.text);
  } else {
    console.log(JSON.stringify(reply.result.result.value, null, 1));
  }

  socket.close();
}

main().catch(err => { console.log('Failed: ' + err.message); process.exit(1); });
