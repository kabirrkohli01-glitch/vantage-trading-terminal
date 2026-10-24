'use strict';
/* Drives the real application and asserts the interface actually works.
 *
 * THIS EXISTS BECAUSE OF ONE CLASS OF BUG THAT NOTHING ELSE CATCHES. The
 * content policy forbids inline handlers, and a control whose action is missing
 * from the dispatch table does nothing at all: no error, no blank screen, just
 * a button that is decoration. The same policy silently refuses a script it
 * disagrees with, which turns a whole module into a no-op with no visible
 * symptom. Both are invisible to a unit test and to a quick look at the screen.
 *
 * It also samples the chart canvas. A chart that renders nothing looks exactly
 * like a chart that is still loading, so the only way to know it drew is to
 * read the pixels back.
 *
 * Run: node tests/ui-probe.js [--keep] [--shot <file>]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const { findRuntime } = require('../tools/launch');

const ROOT = path.join(__dirname, '..');
const PORT = 9411;

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.log('  ✗ ' + name + (detail ? '\n      ' + detail : ''));
  }
}

/* ---------- a small CDP client ---------- */

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.next = 1;
    this.pending = new Map();
    this.events = [];
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve);
      this.socket.addEventListener('error', reject);
    });
    this.socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch (e) { return; }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        this.events.push(message);
      }
    });
  }

  send(method, params) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(method + ' timed out'));
        }
      }, 30000);
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text + ' ' +
        ((result.exceptionDetails.exception && result.exceptionDetails.exception.description) || ''));
    }
    return result.result.value;
  }

  close() { try { this.socket.close(); } catch (e) { /* already closed */ } }
}

const wait = ms => new Promise(r => setTimeout(r, ms));

/* Poll for the page target rather than sleeping a guess: start-up time varies
   with what else the machine is doing. */
async function waitForPage(attempts) {
  for (let i = 0; i < attempts; i++) {
    try {
      const targets = await fetchJson('http://127.0.0.1:' + PORT + '/json/list');
      const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) { /* not listening yet */ }
    await wait(300);
  }
  return null;
}

async function main() {
  const runtime = findRuntime();
  if (!runtime) {
    console.log('No runtime on this machine — skipping the interface probe.');
    return true;
  }

  /* A throwaway data directory by default, so a probe never writes into real
     records. `--real-data` points it at the installation's own directory, which
     is how a paired assistant can be exercised. */
  const useReal = process.argv.indexOf('--real-data') !== -1;
  const dataDir = useReal
    ? path.join(ROOT, 'data')
    : fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-probe-'));
  const child = spawn(runtime, [
    ROOT,
    '--remote-debugging-port=' + PORT,
    /* Kept off the operator's screen while it runs, so a probe does not steal
       focus from whatever they are doing. */
    '--window-position=-32000,-32000',
    /* AND THEN TOLD TO KEEP DRAWING ANYWAY. A window the compositor believes
       nobody can see has its animation frames throttled and eventually
       suspended, and the chart paints inside one. Without these the probe reads
       a blank canvas at random and reports a chart that never drew — a failure
       created entirely by where the probe put the window. */
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling'
  ], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { TERMINAL_DATA_DIR: dataDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const stderr = [];
  child.stderr.on('data', d => stderr.push(String(d)));

  let cdp = null;
  try {
    const page = await waitForPage(70);
    if (!page) {
      console.log('  ✗ the application never opened a window');
      console.log(stderr.join('').split('\n').slice(0, 25).join('\n'));
      failed++;
      return false;
    }

    cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    /* Installed inside the page: a policy violation neither throws nor logs
       anywhere this probe could otherwise see it. */
    await cdp.eval(`
      window.__probe = { errors: [], csp: [] };
      window.addEventListener('error', e => window.__probe.errors.push(String(e.message)));
      window.addEventListener('unhandledrejection', e => window.__probe.errors.push('unhandled: ' + e.reason));
      document.addEventListener('securitypolicyviolation', e =>
        window.__probe.csp.push(e.violatedDirective + ' blocked ' + e.blockedURI));
      true;
    `);

    console.log('\nStart-up');

    /* The document may still be parsing when the probe attaches, and the
       shared modules load in order — so checking them before the page is ready
       reports the later ones missing when they are merely not there yet. */
    await waitFor(cdp, 'document.readyState === "complete"', 60);

    /* The shared modules are loaded as plain scripts by the page and as modules
       by the main process. If the policy refuses them, everything downstream is
       undefined rather than broken in an obvious way. */
    const shared = await cdp.eval('({ num: !!(window.T && window.T.num), clock: !!(window.T && window.T.clock),' +
      ' candles: !!(window.T && window.T.candles), indicators: !!(window.T && window.T.indicators),' +
      ' chart: !!(window.T && window.T.Chart) })');
    check('the shared number module reached the interface', shared.num,
      'the price in a header and the label on an axis come from this file');
    check('the shared clock module reached the interface', shared.clock);
    check('the shared candle module reached the interface', shared.candles);
    check('the shared indicator module reached the interface', shared.indicators);
    check('the chart engine loaded', shared.chart);

    await waitFor(cdp, 'document.querySelectorAll(".wl-row").length > 0', 60);

    const brand = await cdp.eval('document.getElementById("brand-name").textContent');
    check('the product name reached the title bar', !!brand && brand.length > 1, 'got: ' + JSON.stringify(brand));

    const credit = await cdp.eval('document.getElementById("credit").textContent');
    check('the status bar carries the credit line', /SYRIX/.test(credit) && /Kabirr Wealth Partners/.test(credit),
      'got: ' + JSON.stringify(credit));

    console.log('\nThe watchlist');

    const rows = await cdp.eval('document.querySelectorAll(".wl-row").length');
    check('the watchlist rendered rows', rows > 0, 'rows: ' + rows);

    await waitFor(cdp, '[...document.querySelectorAll(".wl-px")].filter(n => n.textContent !== "—").length >= 3', 100);
    const priced = await cdp.eval('[...document.querySelectorAll(".wl-px")].map(n => n.textContent).filter(t => t !== "—")');
    check('real prices arrived for the watchlist', priced.length >= 3, 'priced rows: ' + priced.length);

    /* The formatting traps, checked on the real screen rather than in isolation:
       a London listing must be in pence, an index must carry no currency mark. */
    const formatted = await cdp.eval(`
      (() => {
        const out = {};
        document.querySelectorAll('.wl-row').forEach(row => {
          out[row.dataset.symbol] = row.querySelector('.wl-px').textContent;
        });
        return out;
      })()
    `);
    if (formatted['HSBA.L'] && formatted['HSBA.L'] !== '—') {
      check('a London listing renders in pence, not pounds', /p$/.test(formatted['HSBA.L']),
        'got: ' + formatted['HSBA.L']);
    }
    if (formatted['^GSPC'] && formatted['^GSPC'] !== '—') {
      check('an index level carries no currency mark', !/[$£€]/.test(formatted['^GSPC']),
        'got: ' + formatted['^GSPC']);
    }
    if (formatted['^TNX'] && formatted['^TNX'] !== '—') {
      check('a bond yield renders as a percentage', /%$/.test(formatted['^TNX']), 'got: ' + formatted['^TNX']);
    }

    console.log('\nThe instrument workspace');

    await waitFor(cdp, 'document.querySelector(".inst-last") !== null', 80);
    const last = await cdp.eval('document.querySelector(".inst-last") && document.querySelector(".inst-last").textContent');
    check('an instrument loaded with a price', !!last && last !== '—', 'got: ' + JSON.stringify(last));

    const badge = await cdp.eval('(document.querySelector(".inst-bar .badge") || {}).textContent || ""');
    check('the price carries a data-state badge', badge.trim().length > 0, 'got: ' + JSON.stringify(badge));

    const stamp = await cdp.eval('(document.querySelector(".inst-after") || {}).textContent || ""');
    check('the price carries a timestamp', stamp.trim().length > 4, 'got: ' + JSON.stringify(stamp));

    const meters = await cdp.eval('document.querySelectorAll(".inst-bar .range-meter").length');
    check('the day and 52-week ranges are shown as meters', meters >= 1, 'meters: ' + meters);

    console.log('\nThe chart');

    await waitFor(cdp, 'document.querySelectorAll("#chart-wrap canvas").length === 4', 60);
    const layers = await cdp.eval('document.querySelectorAll("#chart-wrap canvas").length');
    check('the chart built its four layers', layers === 4, 'layers: ' + layers);

    /* A chart that silently drew nothing is indistinguishable from a slow one,
       so the pixels are read back.
     *
     * The wait is on the bars arriving, not on a fixed delay. The canvases are
     * built by the constructor and the history is a network round trip behind
     * them, so a fixed delay tests how fast the source answered today. */
    await waitFor(cdp, 'window.__state.chart && window.__state.chart.bars.length > 20', 150);
    await wait(400);
    const painted = await cdp.eval(`
      (() => {
        const canvas = document.querySelector('#chart-wrap canvas.layer-main');
        if (!canvas) return { ok: false, reason: 'no main layer' };
        const box = canvas.getBoundingClientRect();
        const ctx = canvas.getContext('2d');
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let lit = 0;
        for (let i = 3; i < data.length; i += 4 * 37) { if (data[i] > 12) lit++; }
        return { ok: lit > 40, lit, width: Math.round(box.width), height: Math.round(box.height),
                 backing: canvas.width + 'x' + canvas.height };
      })()
    `);
    check('the chart canvas has a size to draw into', painted.width > 200 && painted.height > 150,
      'laid out at ' + painted.width + 'x' + painted.height + ', backing store ' + painted.backing);
    check('the chart actually drew pixels', painted.ok, 'lit samples: ' + painted.lit +
      ' at ' + painted.width + 'x' + painted.height);

    /* When the chart is empty, say why. A bar count of nought reads the same
       whether the interface threw or the source refused, and those need
       different fixes. */
    const barCount = await cdp.eval('window.__state.chart ? window.__state.chart.bars.length : 0');
    const chartTrouble = barCount > 0 ? '' : await cdp.eval(
      '((document.querySelector("#chart-wrap .note-line") || {}).textContent || "") + " | page errors: " + ' +
      'JSON.stringify((window.__probe && window.__probe.errors) || [])');
    check('the chart holds real bars', barCount > 20, 'bars: ' + barCount + '  ' + chartTrouble);

    /* ---- how the chart feels ----
     *
     * These separate a chart from a picture of one, and every one of them is
     * driven with real pointer, wheel and keyboard events on the surface the
     * operator actually touches. Calling the method directly would prove the
     * method works, not that the hand can reach it. */
    /* ---- what the title bar and the rail offer ---- */
    console.log('\nNavigation');

    const chrome = await cdp.eval(`
      ({
        pills: document.querySelectorAll('.topnav-btn').length,
        rail: [...document.querySelectorAll('#rail .rail-btn')].map(b => b.dataset.view || b.dataset.act),
        strip: [...document.querySelectorAll('#tf-strip .tf-btn[data-interval]')].map(b => b.dataset.interval),
        active: (document.querySelector('#tf-strip .tf-btn.on') || {}).textContent || '',
        secondBar: document.querySelectorAll('.ws-main > .chart-bar').length,
        tradeButton: !!document.querySelector('[data-act="toggle-trade-panel"]')
      })
    `);
    check('the title bar carries no duplicate screen tabs', chrome.pills === 0, 'found ' + chrome.pills);
    ['trade', 'orders', 'positions'].forEach(view => {
      check('the rail no longer offers ' + view, chrome.rail.indexOf(view) === -1,
        'rail: ' + chrome.rail.join(', '));
    });
    check('the rail still offers the screens that are screens',
      ['chart', 'portfolio', 'journal', 'news'].every(v => chrome.rail.indexOf(v) !== -1),
      'rail: ' + chrome.rail.join(', '));
    check('the rail no longer offers watchlist as its own screen',
      chrome.rail.indexOf('watchlist') === -1,
      'the watchlist lives beside the chart, not as a redundant full-page tab: ' + chrome.rail.join(', '));
    check('the bar sizes sit in the title bar', chrome.strip.length >= 8, 'strip: ' + chrome.strip.join(' '));
    check('and the one being drawn is marked', chrome.active.trim().length > 0, 'got: ' + chrome.active);
    check('the chart no longer carries a second toolbar strip', chrome.secondBar === 0);
    check('there is a way to open the order panel', chrome.tradeButton);

    /* THE BAR SIZE SAYS WHAT ONE CANDLE IS, NOT HOW FAR BACK TO LOOK.
       Fifteen minutes must load every quarter-hour candle the source will
       publish — weeks of them — not the last fifteen minutes and not one day. */
    await cdp.eval('document.querySelector("#tf-strip [data-interval=\'15m\']").click()');
    await waitFor(cdp, 'window.__state.servedTimeframe === "15m"', 200);
    const fine = await cdp.eval(`
      (() => {
        const chart = window.__state.chart;
        const bars = chart.bars;
        const span = bars[bars.length - 1].t - bars[0].t;
        return {
          bars: bars.length,
          days: Math.round(span / 86400000),
          step: bars.length > 1 ? bars[1].t - bars[0].t : 0
        };
      })()
    `);
    check('a quarter-hour chart loads weeks of quarter-hour candles, not one day',
      fine.days >= 20 && fine.bars > 400,
      fine.bars + ' bars spanning ' + fine.days + ' days');
    check('and each candle really is a quarter of an hour',
      fine.step === 15 * 60 * 1000, 'step was ' + (fine.step / 60000) + ' minutes');

    /* The strip along the bottom is a zoom over that history, not a fetch. */
    const zoomOnly = await cdp.eval(`
      (() => {
        const chart = window.__state.chart;
        const before = { bars: chart.bars.length, span: chart.view.to - chart.view.from };
        window.ACTIONS.range({ range: '1D' });
        const after = { bars: chart.bars.length, span: chart.view.to - chart.view.from };
        window.ACTIONS.range({ range: 'All' });
        const all = { bars: chart.bars.length, span: chart.view.to - chart.view.from };
        /* Put it back where it was found. The checks that follow measure how
           the chart feels, and leaving it holding a quarter of a century of
           candles measures a different chart from the one that opens. */
        window.ACTIONS.range({ range: '1Y' });
        return { before, after, all };
      })()
    `);
    check('a period button zooms rather than reloading',
      zoomOnly.after.bars === zoomOnly.before.bars && zoomOnly.all.bars === zoomOnly.before.bars,
      JSON.stringify(zoomOnly));
    check('one day shows less of it than all of it',
      zoomOnly.after.span < zoomOnly.all.span,
      '1D showed ' + Math.round(zoomOnly.after.span) + ' bars, All showed ' + Math.round(zoomOnly.all.span));
    check('and the history behind the zoom is still there to scroll back into',
      zoomOnly.all.span > 400, 'All spanned ' + Math.round(zoomOnly.all.span) + ' bars');

    /* A QUARTER OF A CENTURY OF CANDLES MUST STILL PAN AT A FRAME RATE.
       One candle per bar meant seven thousand strokes across eleven hundred
       pixels and about a third of a second a frame, so a pan at full zoom-out
       moved in lurches. What is timed here is the whole paint. */
    const speed = await cdp.eval(`
      (() => {
        const chart = window.__state.chart;
        window.ACTIONS.range({ range: 'All' });
        const bars = chart.bars.length;
        const frames = [];
        for (let i = 0; i < 8; i++) {
          const at = performance.now();
          chart.panBars(-40);
          chart.paint();
          frames.push(performance.now() - at);
        }
        window.ACTIONS.range({ range: '1Y' });
        frames.sort((a, b) => a - b);
        return { bars, median: frames[Math.floor(frames.length / 2)], worst: frames[frames.length - 1] };
      })()
    `);
    check('panning the whole record keeps up with the hand', speed.median < 34,
      speed.bars + ' bars, median frame ' + speed.median.toFixed(1) + 'ms, worst ' +
      speed.worst.toFixed(1) + 'ms');

    /* Daily bars reach back to the listing, which the named maximum range does
       not give — it answers a daily request with monthly bars. */
    await cdp.eval('document.querySelector("#tf-strip [data-interval=\'1d\']").click()');
    await waitFor(cdp, 'window.__state.servedTimeframe === "1d"', 200);
    const whole = await cdp.eval(`
      (() => {
        const bars = window.__state.chart.bars;
        return {
          bars: bars.length,
          years: Math.round((bars[bars.length - 1].t - bars[0].t) / 31557600000),
          step: bars.length > 1 ? bars[1].t - bars[0].t : 0
        };
      })()
    `);
    check('a daily chart holds the whole record, not a year of it',
      whole.bars > 2000 && whole.years > 8,
      whole.bars + ' bars spanning ' + whole.years + ' years');
    check('and each candle really is a day', whole.step === 86400000 || whole.step === 3 * 86400000,
      'step was ' + (whole.step / 86400000) + ' days');

    const tradePanel = await cdp.eval(`
      (() => {
        const workspace = document.querySelector('.view.workspace');
        document.querySelector('[data-act="toggle-trade-panel"]').click();
        const opened = workspace.classList.contains('trade-open') &&
          document.querySelectorAll('#trade-panel-body .side-btn').length === 2;
        document.querySelector('#trade-panel [data-act="toggle-trade-panel"]').click();
        return { opened, closed: !workspace.classList.contains('trade-open') };
      })()
    `);
    check('the order panel docks beside the chart', tradePanel.opened);
    check('and closes from its own header', tradePanel.closed);

    /* ---- search ----
     *
     * There was no check here at all, which is how a rule added to the title
     * bar could clip the results panel out of existence without anything
     * noticing: the box accepted typing and appeared to do nothing.
     *
     * Every asset class is checked, because "search for any stock, coin, fund
     * or index" is one requirement and not four. */
    console.log('\nSearch');

    const lookUp = async query => {
      /* CLEARED AND WAITED FOR FIRST. The box is debounced and the panel keeps
         the previous answer on screen while the next one is in flight, so
         typing and reading straight away measures the last query — which is how
         a search for a coin appeared to return nothing but ordinary shares. */
      await cdp.eval(`
        (() => {
          const box = document.getElementById('search-input');
          box.value = '';
          box.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()
      `);
      await waitFor(cdp, 'document.querySelectorAll("#search-results .result").length === 0', 60);

      await cdp.eval(`
        (() => {
          const box = document.getElementById('search-input');
          box.value = ${JSON.stringify(query)};
          box.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()
      `);
      const found = await waitFor(cdp, 'document.querySelectorAll("#search-results .result").length > 0', 180);
      if (!found) return { count: 0, visible: false, kinds: [] };
      return cdp.eval(`
        (() => {
          const panel = document.getElementById('search-results');
          const box = panel.getBoundingClientRect();
          const bar = document.getElementById('topbar').getBoundingClientRect();
          const results = [...panel.querySelectorAll('.result')];
          return {
            count: results.length,
            kinds: [...panel.querySelectorAll('.kind')].map(n => n.textContent.trim()),
            venues: [...panel.querySelectorAll('.venue')].map(n => n.textContent.trim()),
            first: results.length ? results[0].getAttribute('data-symbol') : null,
            firstName: results.length ? (results[0].querySelector('.nm') || {}).textContent || '' : '',
            scopes: panel.querySelectorAll('.scope').length,
            /* On screen, not merely in the tree: the panel hangs below the bar
               it drops from and must not be clipped away by it. */
            visible: box.height > 0 && box.width > 0 && box.bottom > bar.bottom
          };
        })()
      `);
    };

    for (const [query, wanted] of [['tesla', 'EQUITY'], ['dogecoin', 'CRYPTO'],
                                   ['vanguard s&p 500', 'ETF'], ['ftse', 'INDEX']]) {
      const results = await lookUp(query);
      check('searching "' + query + '" returns something', results.count > 0, 'got ' + results.count);
      check('and the results for "' + query + '" are on screen', results.visible, JSON.stringify(results));
      check('and a ' + wanted.toLowerCase() + ' is among them',
        results.kinds.indexOf(wanted) !== -1, 'kinds: ' + results.kinds.join(', '));
    }

    check('the search offers asset classes to narrow by',
      (await lookUp('tesla')).scopes > 4);

    /* SEARCHING FINDS A COMPANY LISTED NOWHERE NEAR THE UNITED STATES. The
       previous search read one venue's own symbol list, which does not carry
       most of the world. */
    for (const [query, wantedVenue] of [['reliance industries', 'NSE'], ['toyota', 'TSE'], ['barclays', 'London']]) {
      const results = await lookUp(query);
      check('"' + query + '" finds its home listing',
        results.venues.some(v => v.indexOf(wantedVenue) !== -1),
        'venues: ' + results.venues.slice(0, 4).join(' | '));
    }

    /* THE MARK BESIDE A RESULT IS THE COMPANY'S OWN LOGO, NOT TWO LETTERS.
       This was reported directly: searching the lender showed "SO" in a box. The
       logo arrives after the row is drawn, so this waits for it. */
    await lookUp('sofi');
    const gotLogo = await waitFor(cdp,
      'document.querySelectorAll("#search-results .result .mark-logo").length > 0', 200);
    check('a search result carries the company mark rather than its initials', gotLogo);

    if (gotLogo) {
      const marks = await cdp.eval(`
        (() => {
          const logos = [...document.querySelectorAll('#search-results .result .mark-logo')];
          const boxes = logos.map(l => l.getBoundingClientRect());
          return {
            count: logos.length,
            /* Served from this application, never from the vendor: the page
               makes no network request of its own. */
            local: logos.every(l => (l.getAttribute('src') || '').indexOf('http://127.0.0.1:') === 0),
            /* A mark that renders at its natural size blows the row apart. It
               was doing exactly that before the stylesheet landed. */
            sized: boxes.every(b => b.width > 10 && b.width < 40 && b.height > 10 && b.height < 40),
            widest: Math.round(Math.max(...boxes.map(b => b.width)))
          };
        })()
      `);
      check('the mark is served by the application, not fetched by the page', marks.local);
      check('the mark is a small square beside the ticker, not a full-size image',
        marks.sized, 'widest: ' + marks.widest + 'px');
    }

    const chosen = await lookUp('dogecoin');
    await cdp.eval('document.querySelector("#search-results .result").click()');
    await waitFor(cdp, 'window.__state.symbol === ' + JSON.stringify(chosen.first), 150);
    check('choosing a result opens that instrument',
      await cdp.eval('window.__state.symbol === ' + JSON.stringify(chosen.first)),
      'wanted ' + chosen.first + ', got ' + await cdp.eval('window.__state.symbol'));
    check('and the box clears itself afterwards',
      await cdp.eval('document.getElementById("search-input").value === ""'));

    /* The watchlist column carries the same marks. */
    const wlMarks = await waitFor(cdp, 'document.querySelectorAll("#wl-rows .mark-logo").length > 0', 200);
    check('watchlist rows carry the company mark', wlMarks);
    if (wlMarks) {
      const sized = await cdp.eval(`
        [...document.querySelectorAll('#wl-rows .mark-logo')]
          .map(l => l.getBoundingClientRect())
          .every(b => b.width > 8 && b.width < 30)
      `);
      check('and it does not blow the row apart', sized);
    }

    await cdp.eval('window.ACTIONS["open-symbol"]({ symbol: "NVDA" })');
    await waitFor(cdp, 'window.__state.symbol === "NVDA" && window.__state.chart.bars.length > 20', 200);

    /* THE HEADER MARK MUST SURVIVE A TICK. The instrument header is rebuilt from
       markup whenever a quote arrives, so a logo dropped into it by hand was
       destroyed a second later and the initials came back. It is remembered and
       written into the markup instead. */
    const headerMark = await waitFor(cdp, 'document.querySelector("#inst-bar .inst-logo .mark-logo")', 200);
    check('the instrument header carries the company mark', headerMark);
    if (headerMark) {
      const survived = await cdp.eval(`
        (() => {
          /* Redrawn exactly the way an arriving quote redraws it. */
          const model = window.__state.quotes.get(window.__state.symbol);
          if (!model) return 'no quote to redraw from';
          window.__redraw(model);
          return !!document.querySelector('#inst-bar .inst-logo .mark-logo');
        })()
      `);
      check('and keeps it when the header is redrawn', survived === true, String(survived));
    }
    const after = await waitFor(cdp, 'window.__state.intervalsFor === "NVDA"', 100);
    check('the bar sizes on offer follow the instrument', after,
      'still answering for ' + await cdp.eval('JSON.stringify(window.__state.intervalsFor)'));


    console.log('\nChart interaction');

    const noWatermark = await cdp.eval('!window.__state.chart.style.showWatermark');
    check('the instrument is not stamped across the candles', noWatermark);

    /* THE CHART AND THE HEADER MUST NOT DISAGREE. They did: the header ticked
       and the bars were whatever the history request returned when the
       instrument was opened, so within a minute of a running session the last
       candle closed at one price and the figure above it read another. */
    const ticked = await cdp.eval(`
      (() => {
        const chart = window.__state.chart;
        const bars = chart.baseBars;
        const last = bars[bars.length - 1];
        const before = last.c;
        const moved = before * 1.01;

        const original = { o: last.o, h: last.h, l: last.l, c: last.c };

        const took = chart.applyQuote({ last: moved, at: last.t + 1000 }, 'DELAYED');
        /* Read out, not held. The bar is a live object and every later call
           mutates the same one, so a reference kept here would report whatever
           the last line of this function left behind. */
        const after = Object.assign({}, chart.baseBars[chart.baseBars.length - 1]);

        /* And a figure that is not from a running session must not be written
           into a bar that is already closed. */
        const stale = chart.applyQuote({ last: moved * 2, at: last.t + 2000 }, 'STALE');
        const closed = chart.applyQuote({ last: moved * 2, at: last.t + 2000 }, 'CLOSED');
        const unchanged = chart.baseBars[chart.baseBars.length - 1].c;

        Object.assign(chart.baseBars[chart.baseBars.length - 1], original);
        chart.rebuildIndicators();
        chart.invalidate('all');

        return {
          took, before, moved,
          close: after.c,
          high: after.h,
          refusedStale: stale === false && closed === false,
          unchanged
        };
      })()
    `);
    check('a quote arriving moves the bar still forming', ticked.took && ticked.close === ticked.moved,
      'the bar closed at ' + ticked.close + ' after a quote of ' + ticked.moved);
    check('and stretches the bar\'s high rather than clipping it', ticked.high >= ticked.moved);
    check('a figure that is not from a running session is not written into the bars',
      ticked.refusedStale && ticked.unchanged === ticked.moved,
      'a closed bar is final, and a stale figure is not history');

    const cursors = await cdp.eval(`
      (() => {
        const chart = window.__state.chart;
        const surface = chart.layers.fx.canvas;
        const box = surface.getBoundingClientRect();
        const send = (type, x, y) => surface.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
          clientX: box.left + x, clientY: box.top + y
        }));
        const shape = () => surface.style.cursor;
        const out = {};

        send('pointermove', box.width * 0.4, box.height * 0.4);
        out.plot = shape();
        send('pointermove', box.width - 20, box.height * 0.4);
        out.priceGutter = shape();
        send('pointermove', box.width * 0.4, box.height - 8);
        out.timeStrip = shape();

        send('pointermove', box.width * 0.4, box.height * 0.4);
        send('pointerdown', box.width * 0.4, box.height * 0.4);
        out.dragging = shape();
        send('pointermove', box.width * 0.3, box.height * 0.4);
        send('pointerup', box.width * 0.3, box.height * 0.4);
        out.released = shape();
        return out;
      })()
    `);
    check('the pointer is a crosshair over the plot', cursors.plot === 'crosshair', 'got: ' + cursors.plot);
    check('a two-headed arrow appears over the price gutter', cursors.priceGutter === 'ns-resize',
      'got: ' + cursors.priceGutter);
    check('and over the time strip', cursors.timeStrip === 'ew-resize', 'got: ' + cursors.timeStrip);
    check('the cursor becomes a closed hand while the chart is dragged', cursors.dragging === 'grabbing',
      'got: ' + cursors.dragging);
    check('and lets go on release', cursors.released === 'crosshair', 'got: ' + cursors.released);

    /* THE GESTURE RUNS INSIDE THE PAGE, WITH REAL DELAYS BETWEEN ITS STEPS.
     *
     * A flick has a velocity and a velocity needs a clock. Dispatching the
     * moves from here puts a round trip between each one — several hundred
     * milliseconds — so what the engine sees is a slow drag, and it correctly
     * declines to throw it. Done in the page, the steps are milliseconds apart
     * as a hand's would be. Thrown to the right, back into history: thrown the
     * other way it runs into the newest bar, where the view clamps and the
     * glide is over before it starts. */
    const flick = await cdp.eval(`
      (async () => {
        const chart = window.__state.chart;
        const surface = chart.layers.fx.canvas;
        const box = surface.getBoundingClientRect();
        chart.stopMotion();
        const start = chart.view.from;
        const send = (type, at) => surface.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
          clientX: box.left + box.width * at, clientY: box.top + box.height * 0.4
        }));
        const pause = () => new Promise(r => setTimeout(r, 16));

        send('pointerdown', 0.30);
        for (const at of [0.42, 0.54, 0.66]) { await pause(); send('pointermove', at); }
        await pause();
        send('pointerup', 0.66);

        return {
          from: chart.view.from, moved: Math.abs(chart.view.from - start),
          coasting: !!chart.momentum, saw: chart.lastFlick || null
        };
      })()
    `);
    check('dragging the plot moves the chart through history', flick.moved > 1,
      'the view moved ' + Math.round(flick.moved) + ' bars');
    check('a flick keeps going after the hand lets go', flick.coasting,
      'the engine saw ' + JSON.stringify(flick.saw));

    /* Long enough for the slowest plausible coast to have finished. The decay
       is a time constant, so a hard flick takes measurably longer to settle
       than a gentle one and a tight wait here fails on the hard ones only. */
    await wait(1600);
    check('and the glide comes to rest rather than running for ever',
      await cdp.eval('!window.__state.chart.momentum'));

    const zoom = await cdp.eval(`
      (() => {
        const chart = window.__state.chart;
        const surface = chart.layers.fx.canvas;
        const box = surface.getBoundingClientRect();
        chart.stopMotion();
        const before = chart.view.to - chart.view.from;
        surface.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true, deltaY: 240,
          clientX: box.left + box.width * 0.5, clientY: box.top + box.height * 0.5
        }));
        return {
          eased: !!chart.viewTarget, before,
          target: chart.viewTarget ? chart.viewTarget.to - chart.viewTarget.from : null
        };
      })()
    `);
    check('the wheel eases into a zoom rather than jumping', zoom.eased && zoom.target > zoom.before,
      'span ' + Math.round(zoom.before) + ' bars heading for ' + Math.round(zoom.target));

    const shifted = await cdp.eval(`
      (() => {
        const chart = window.__state.chart;
        const surface = chart.layers.fx.canvas;
        const box = surface.getBoundingClientRect();
        chart.stopMotion();
        const before = chart.view.from;
        const span = chart.view.to - chart.view.from;
        surface.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true, deltaY: 200, shiftKey: true,
          clientX: box.left + box.width * 0.5, clientY: box.top + box.height * 0.5
        }));
        return {
          moved: chart.view.from !== before,
          sameSpan: Math.abs((chart.view.to - chart.view.from) - span) < 0.01
        };
      })()
    `);
    check('shift and the wheel walk through history without zooming', shifted.moved && shifted.sameSpan);

    const jump = await cdp.eval(`
      (() => {
        const chart = window.__state.chart;
        /* From a known view. The checks above leave it part way through an
           eased zoom, and a chart zoomed out far enough to hold its whole
           history has no newest bar to be away from. */
        chart.stopMotion();
        chart.resetView();
        chart.panBars(-chart.bars.length);
        chart.paint();
        const button = document.querySelector('#chart-wrap .chart-jump');
        const appeared = !!button && button.classList.contains('on');
        if (button) button.click();
        return { appeared, heading: !!chart.viewTarget };
      })()
    `);
    check('a way back appears once the newest bar is off screen', jump.appeared);
    check('and it takes the chart back there', jump.heading);
    await wait(800);
    check('the chart arrives at the latest bar', await cdp.eval('window.__state.chart.atRealtime()'));

    const scales = await cdp.eval(`
      (() => {
        const chart = window.__state.chart;
        const wrap = document.getElementById('chart-wrap');
        const press = (key) => wrap.dispatchEvent(new KeyboardEvent('keydown', {
          bubbles: true, cancelable: true, key, altKey: true
        }));
        const now = () => ({
          log: chart.price.log, percent: chart.price.percent, inverted: chart.price.inverted
        });
        press('l');
        const afterLog = now();
        press('p');
        const afterPercent = now();
        const button = document.querySelector('[data-act="scale"][data-scale="percent"]');
        const buttonFollows = !!button && button.classList.contains('on');
        press('i');
        const afterInvert = now();
        press('p'); press('i');
        return { afterLog, afterPercent, afterInvert, buttonFollows, rest: now() };
      })()
    `);
    check('Alt+L turns the price scale logarithmic', scales.afterLog.log);
    check('Alt+P turns it to percentages and drops the logarithm',
      scales.afterPercent.percent && !scales.afterPercent.log,
      'percentages of a logarithm are not a scale anyone reads');
    check('the toolbar follows a scale changed from the keyboard', scales.buttonFollows);
    check('Alt+I inverts the scale', scales.afterInvert.inverted);
    check('and every one of them turns back off', !scales.rest.percent && !scales.rest.inverted);

    /* The bar sizes on offer are the ones the source can actually serve, and
       that depends on the instrument: a crypto venue publishes second bars and
       an equity source does not. The answer for the instrument on screen has to
       have arrived first, or the previous instrument's answer is still held and
       the wrong one is tested. */
    await waitFor(cdp, 'window.__state.intervalsFor === window.__state.symbol', 200);
    await cdp.eval('document.querySelector(\'[data-act="menu"][data-menu="interval"]\').click()');
    await waitFor(cdp, 'document.querySelectorAll(\'#modal-body [data-interval]\').length > 0', 60);
    const ladder = await cdp.eval(`
      (() => {
        const rows = [...document.querySelectorAll('#modal-body .menu-row')];
        return {
          offered: rows.filter(r => !r.disabled).map(r => r.dataset.interval),
          refused: rows.filter(r => r.disabled).length,
          total: rows.length,
          symbol: window.__state.symbol,
          answeredFor: window.__state.intervalsFor,
          seconds: (window.__state.intervals['1s'] || {}).available
        };
      })()
    `);
    check('the bar-size menu offers a full ladder, not just a history window',
      ladder.offered.length >= 12, 'offered: ' + ladder.offered.join(' '));
    ['1m', '5m', '15m', '1h', '4h', '1d', '1w'].forEach(name => {
      check('the bar-size menu offers ' + name, ladder.offered.indexOf(name) !== -1);
    });
    check('a bar size this source cannot serve is shown refused rather than hidden',
      ladder.refused > 0 && ladder.total > ladder.offered.length,
      'refused: ' + ladder.refused + ' of ' + ladder.total + ' for ' + ladder.symbol +
      ' (answered for ' + ladder.answeredFor + ', 1s available: ' + ladder.seconds + ')');

    /* Actually switch to one that has to be built by merging finer bars. */
    await cdp.eval('document.querySelector(\'#modal-body [data-interval="4h"]\').click()');
    await waitFor(cdp, 'window.__state.servedTimeframe === "4h"', 150);
    const derived = await cdp.eval(`
      (() => {
        const chart = window.__state.chart;
        const gaps = [];
        for (let i = 1; i < Math.min(6, chart.bars.length); i++) gaps.push(chart.bars[i].t - chart.bars[i - 1].t);
        return {
          served: window.__state.servedTimeframe,
          bars: chart.bars.length,
          toolbar: (document.querySelector('#tf-strip .tf-btn.on') || {}).textContent || '',
          note: (document.querySelector('#coarse-note') || {}).textContent || '',
          fourHourly: gaps.some(g => g === 4 * 60 * 60 * 1000)
        };
      })()
    `);
    check('a derived bar size actually loads', derived.served === '4h' && derived.bars > 5,
      'served ' + derived.served + ' with ' + derived.bars + ' bars');
    check('and its bars really are that size', derived.fourHourly);
    check('the toolbar shows the bar size being drawn', /4H/i.test(derived.toolbar), 'got: ' + derived.toolbar);
    check('and the chart says the bars were merged here rather than published',
      /merged/i.test(derived.note), 'got: ' + JSON.stringify(derived.note));

    /* The right button opens a menu about what is under it. */
    const menu = await cdp.eval(`
      (() => {
        const chart = window.__state.chart;
        const surface = chart.layers.fx.canvas;
        const box = surface.getBoundingClientRect();
        surface.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true,
          clientX: box.left + box.width * 0.5, clientY: box.top + box.height * 0.5
        }));
        const node = document.getElementById('ctx-menu');
        if (!node) return { opened: false };
        const rect = node.getBoundingClientRect();
        return {
          opened: true,
          rows: [...node.querySelectorAll('.ctx-row')].map(r => r.textContent.trim()),
          onScreen: rect.right <= window.innerWidth && rect.bottom <= window.innerHeight &&
            rect.left >= 0 && rect.top >= 0
        };
      })()
    `);
    check('the right button opens a menu on the chart', menu.opened);
    check('the menu offers appearance and colours',
      (menu.rows || []).some(r => /appearance/i.test(r)), 'rows: ' + (menu.rows || []).join(' | '));
    check('and it never opens past the edge of the window', menu.onScreen);

    /* Over a drawing it offers that drawing's own colour and width. */
    const overDrawing = await cdp.eval(`
      (() => {
        const state = window.__state;
        const chart = state.chart;
        const bars = chart.bars;
        state.draw.load([{
          id: 'ctx-probe', type: 'horizontal',
          anchors: [{ t: bars[Math.floor(bars.length / 2)].t, price: bars[Math.floor(bars.length / 2)].c }],
          style: { colour: '#f0a92e', width: 1.4 }
        }]);
        chart.paint();
        const box = chart.layers.fx.canvas.getBoundingClientRect();
        const y = chart.yOf(bars[Math.floor(bars.length / 2)].c, chart.layout().panes[0]);
        chart.layers.fx.canvas.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true,
          clientX: box.left + box.width * 0.5, clientY: box.top + y
        }));
        const node = document.getElementById('ctx-menu');
        const swatches = node ? node.querySelectorAll('.ctx-swatch').length : 0;
        const blue = node ? node.querySelector('[data-act="drawing-colour"][data-colour="#2962ff"]') : null;
        if (blue) blue.click();
        const drawing = state.draw.all().find(d => d.id === 'ctx-probe');
        state.draw.remove('ctx-probe');
        return { swatches, colour: drawing ? drawing.style.colour : null };
      })()
    `);
    check('the menu over a drawing offers its colours', overDrawing.swatches >= 6,
      'swatches: ' + overDrawing.swatches);
    check('and choosing one recolours that drawing', overDrawing.colour === '#2962ff',
      'got: ' + overDrawing.colour);

    /* Candle colours are settable and are kept apart from rise and fall. */
    const colours = await cdp.eval(`
      (() => {
        const chart = window.__state.chart;
        const before = chart.style.up;
        window.ACTIONS.menu({ menu: 'appearance' });
        const input = document.querySelector('.colour-input[data-style="up"]');
        if (!input) return { ok: false, reason: 'no colour control' };
        input.value = '#ff00ff';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const after = chart.style.up;
        const fill = chart.style.upFill;
        window.ACTIONS['close-modal']();
        return { ok: true, before, after, fill };
      })()
    `);
    check('the appearance panel recolours the candles', colours.ok && colours.after === '#ff00ff',
      'went from ' + colours.before + ' to ' + colours.after);
    check('and the body follows its outline', colours.fill === '#ff00ff');

    await cdp.eval('window.ACTIONS["chart-style-reset"]()');
    await waitFor(cdp, 'window.__state.chart && window.__state.chart.bars.length > 20', 150);

    /* The whole indicator catalogue is reachable, not a shortlist. */
    await cdp.eval('document.querySelector(\'[data-act="menu"][data-menu="indicators"]\').click()');
    await waitFor(cdp, 'document.querySelectorAll(\'#indicator-list [data-act="indicator"]\').length > 0', 60);
    const library = await cdp.eval(`
      (() => {
        const offered = [...document.querySelectorAll('#indicator-list [data-act="indicator"]')].map(b => b.dataset.id);
        const catalogue = Object.keys(window.T.indicators.CATALOGUE);
        const box = document.getElementById('indicator-search');
        box.value = 'bollinger';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        const searched = [...document.querySelectorAll('#indicator-list [data-act="indicator"]')].map(b => b.dataset.id);
        box.value = '';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        return { offered, catalogue, searched };
      })()
    `);
    check('every indicator in the catalogue is reachable from the interface',
      library.catalogue.every(id => library.offered.indexOf(id) !== -1),
      'missing: ' + library.catalogue.filter(id => library.offered.indexOf(id) === -1).join(', '));
    check('the catalogue can be searched', library.searched.length > 0 && library.searched.length < library.offered.length,
      'searching narrowed ' + library.offered.length + ' to ' + library.searched.length);

    await cdp.eval('window.ACTIONS["close-modal"]()');
    await cdp.eval('window.ACTIONS.range({ range: "3M" })');
    await waitFor(cdp, 'window.__state.chart.bars.length > 20', 150);
    await wait(300);

    console.log('\nControls');

    /* Every control on every screen must have a handler, and every screen the
       rail offers must actually open. */
    /* Trade, Orders and Positions are deliberately not here. They are the
       ticket and the blotter, which live under the chart; a rail entry that
       only switches to a panel already on screen was removed. */
    const views = ['chart', 'discover', 'news', 'syrix',
      'portfolio', 'profile', 'journal', 'alerts', 'settings'];
    for (const view of views) {
      const opened = await cdp.eval(`
        (() => {
          const button = document.querySelector('[data-act="view"][data-view="${view}"]');
          if (!button) return false;
          button.click();
          return true;
        })()
      `);
      check('the ' + view + ' screen opens from the rail', opened);
      if (!opened) continue;

      /* THESE SCREENS FETCH BEFORE THEY HAVE ANYTHING TO DRAW. The newsroom
         reads ten publishers, the heatmap reads two hundred listings and the
         performance screen recomputes the whole ledger. Measuring a fifth of a
         second after the click reported every one of them as blank, which said
         nothing about the screen and everything about the wait. */
      const slow = { news: true, discover: true, profile: true, portfolio: true, journal: true };
      if (slow[view]) {
        await waitFor(cdp, `
          (() => {
            const section = document.querySelector('.view[data-view="${view}"]');
            if (!section) return false;
            if (section.querySelector('.loading')) return false;
            return section.textContent.trim().length > 120;
          })()
        `, 200);
      } else {
        await wait(220);
      }

      /* A screen still showing its loading placeholder after it has been
         opened has silently failed to render, which is the single most common
         way a tab looks broken. */
      const stuck = await cdp.eval(`
        (() => {
          const section = document.querySelector('.view.on');
          if (!section) return 'no visible screen';
          const text = section.textContent.trim();
          if (/^Loading…?$/.test(text)) return 'stuck on the loading placeholder';
          if (!text) return 'rendered nothing at all';
          return null;
        })()
      `);
      check('the ' + view + ' screen rendered something', stuck === null, stuck);
      const dead = await cdp.eval(`
        (() => {
          const acts = [...document.querySelectorAll('[data-act]')].map(n => n.dataset.act);
          return [...new Set(acts)].filter(a => typeof window.ACTIONS[a] !== 'function');
        })()
      `);
      check('no dead control on the ' + view + ' screen', dead.length === 0, 'no handler for: ' + dead.join(', '));
    }

    await cdp.eval('document.querySelector(\'[data-act="view"][data-view="chart"]\').click()');
    await wait(200);

    console.log('\nThe right-hand panel');

    /* Back to the workspace: the loop above finished on the settings screen,
       and the right column only exists inside the chart workspace. */
    await cdp.eval('document.querySelector(\'[data-act="view"][data-view="chart"]\').click()');
    await wait(320);

    const watchlistRight = await cdp.eval(`
      (() => {
        const rows = document.querySelector('.wl-scroll');
        const chart = document.querySelector('#chart-wrap');
        if (!rows || !chart) return false;
        return rows.getBoundingClientRect().left > chart.getBoundingClientRect().left;
      })()
    `);
    check('the watchlist is to the right of the chart', watchlistRight);

    const detailRight = await cdp.eval(`
      (() => {
        const detail = document.querySelector('#detail-body');
        const chart = document.querySelector('#chart-wrap');
        if (!detail || !chart) return false;
        return detail.getBoundingClientRect().left > chart.getBoundingClientRect().left;
      })()
    `);
    check('the instrument detail sits on the right too', detailRight);

    const drawTools = await cdp.eval('document.querySelectorAll("#draw-rail .draw-btn[data-tool]").length');
    check('the drawing tools sit beside the chart', drawTools >= 12, 'tools: ' + drawTools);

    const bottomTabs = await cdp.eval('document.querySelectorAll(".bp-tab").length');
    check('the bottom panel carries its tabs', bottomTabs >= 5, 'tabs: ' + bottomTabs);

    const ticketSides = await cdp.eval('document.querySelectorAll("#ticket .side-btn").length');
    check('the order ticket offers both sides', ticketSides === 2, 'sides: ' + ticketSides);

    const meterCount = await cdp.eval('document.querySelectorAll(".range-meter").length');
    check('range meters are drawn for the instrument', meterCount >= 1, 'meters: ' + meterCount);

    /* ASSERTED IN PIXELS, NOT IN THE TREE.
     *
     * Every check here used to ask whether an element existed and had children,
     * and all of them passed while the entire right-hand column was one pixel
     * wide and invisible — a hidden grid child had shifted every column after
     * it one track to the left. A panel that cannot be seen is not a panel, so
     * this measures what is on the glass. */
    const columnGeometry = await cdp.eval(`
      (() => {
        const rect = node => {
          const r = node.getBoundingClientRect();
          return { left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) };
        };
        const side = document.getElementById('ws-side');
        const rows = [...document.querySelectorAll('.wl-row')];
        const detail = document.getElementById('detail-body');
        return {
          side: rect(side),
          firstRow: rows.length ? rect(rows[0]) : null,
          detail: rect(detail),
          window: window.innerWidth,
          columns: getComputedStyle(document.querySelector('.view.workspace')).gridTemplateColumns
        };
      })()
    `);
    check('the right-hand column is as wide as its track says',
      columnGeometry.side.width > 200,
      'the column was ' + columnGeometry.side.width + 'px in tracks [' + columnGeometry.columns + ']');
    check('a watchlist row is wide enough to read',
      columnGeometry.firstRow && columnGeometry.firstRow.width > 200,
      'a row was ' + JSON.stringify(columnGeometry.firstRow));
    check('the research panel has real width and height',
      columnGeometry.detail.width > 200 && columnGeometry.detail.height > 100,
      JSON.stringify(columnGeometry.detail));
    check('and the column sits inside the window',
      columnGeometry.side.left + columnGeometry.side.width <= columnGeometry.window + 2,
      'ends at ' + (columnGeometry.side.left + columnGeometry.side.width) + ' of ' + columnGeometry.window);

    const researchTabs = await cdp.eval(
      '[...document.querySelectorAll(\'#detail-tabs [data-act="detail-tab"]\')].map(b => b.dataset.tab)');
    check('the research panel offers more than a quote', researchTabs.length >= 6,
      'tabs: ' + researchTabs.join(', '));
    ['overview', 'financials', 'earnings', 'analysts', 'profile', 'news', 'sources'].forEach(tab => {
      check('the research panel has a ' + tab + ' tab', researchTabs.indexOf(tab) !== -1);
    });

    /* Every tab is opened. A tab that throws leaves its panel on the loading
       placeholder, which is the failure this catches. */
    for (const tab of researchTabs) {
      await cdp.eval(`document.querySelector('[data-act="detail-tab"][data-tab="${tab}"]').click()`);
      await wait(tab === 'overview' || tab === 'sources' ? 300 : 900);
      const body = await cdp.eval('(document.getElementById("detail-body") || {}).textContent || ""');
      check('the ' + tab + ' tab rendered something', body.trim().length > 0 && !/^Loading…?$/.test(body.trim()),
        'got: ' + JSON.stringify(body.trim().slice(0, 70)));
    }

    /* Rendering something is not the same as saying anything. The research
       tabs are checked for figures, and where a source cannot answer they are
       checked for a reason instead — never for an empty panel. */
    const substance = {};
    for (const tab of ['overview', 'financials', 'profile']) {
      await cdp.eval(`document.querySelector('[data-act="detail-tab"][data-tab="${tab}"]').click()`);
      /* A tab paints what it already knows, then repaints when the reference
         data lands, so it is waited on until it has either figures or a
         reason — not merely until it has stopped saying "Loading". Sampling
         once catches it mid-swap. */
      await waitFor(cdp, `
        (() => {
          const body = document.getElementById('detail-body');
          if (!body) return false;
          const figures = [...body.querySelectorAll('.kv-row .v')].filter(n => n.textContent.trim() !== '—').length;
          return figures >= 4 || body.querySelectorAll('.note-line').length > 0 ||
            body.querySelectorAll('.section-label').length > 0;
        })()
      `, 200);
      substance[tab] = await cdp.eval(`
        (() => {
          const body = document.getElementById('detail-body');
          return {
            figures: [...body.querySelectorAll('.kv-row .v')].filter(n => n.textContent.trim() !== '—').length,
            headings: body.querySelectorAll('.section-label').length,
            stamped: /retrieved/i.test(body.textContent),
            explained: body.querySelectorAll('.note-line').length > 0,
            text: body.textContent.trim().slice(0, 90)
          };
        })()
      `);
    }
    check('the overview carries real figures', substance.overview.figures >= 4,
      'figures: ' + substance.overview.figures);
    check('the financials tab either shows accounts or says why not',
      substance.financials.figures >= 4 || substance.financials.explained,
      'got: ' + JSON.stringify(substance.financials.text));
    check('a financial figure is never shown without a stamp',
      substance.financials.figures === 0 || substance.financials.stamped,
      'figures without provenance are the one thing this panel may not do');
    check('the profile tab either describes the company or says why not',
      substance.profile.headings > 0 || substance.profile.explained,
      'got: ' + JSON.stringify(substance.profile.text));

    await cdp.eval('document.querySelector(\'[data-act="detail-tab"][data-tab="sources"]\').click()');
    await waitFor(cdp, 'document.querySelectorAll("#detail-body .src").length > 0', 60);
    const sources = await cdp.eval('document.querySelectorAll("#detail-body .src").length');
    check('the sources panel names the sources behind the figure', sources > 0, 'entries: ' + sources);

    const drawerText = await cdp.eval('(document.getElementById("detail-body") || {}).textContent || ""');
    check('every source states when it was retrieved', /retrieved/i.test(drawerText));
    check('the sources panel reports the independent check', /independent check/i.test(drawerText));

    await cdp.eval('document.querySelector(\'[data-act="detail-tab"][data-tab="overview"]\').click()');
    await wait(300);

    /* ---- panel mechanics ---- */
    console.log('\nPanel mechanics');

    /* THE HANDLE OF A PANEL THAT IS CLOSED IS NOT A BROKEN HANDLE. Closing the
       bottom panel or the assistant's dock hides that panel and its splitter
       together, on purpose. Only the handles actually on screen are measured. */
    const handles = await cdp.eval(`
      [...document.querySelectorAll('.splitter')]
        /* offsetParent is null for anything hidden by an ANCESTOR too, which is
           how the order ticket's handle disappears when the panel holding it is
           collapsed. Checking the handle's own display misses that. */
        .filter(node => node.offsetParent !== null)
        .map(node => ({
          resize: node.dataset.resize,
          cursor: getComputedStyle(node).cursor,
          width: Math.round(node.getBoundingClientRect().width),
          height: Math.round(node.getBoundingClientRect().height)
        }))
    `);
    check('every panel edge on screen is a drag handle', handles.length >= 2, 'handles: ' + handles.length);
    check('each handle shows a resize cursor',
      handles.every(h => h.cursor === 'col-resize' || h.cursor === 'row-resize'),
      'cursors: ' + handles.map(h => h.resize + '=' + h.cursor).join(', '));
    check('each handle has a real hit area',
      handles.every(h => h.width > 0 && h.height > 0),
      'sizes: ' + handles.map(h => h.resize + '=' + h.width + 'x' + h.height).join(', '));

    /* Dragged with real pointer events rather than by writing the property, so
       what is checked is the path the operator's hand actually takes. */
    const dragged = await cdp.eval(`
      (() => {
        const handle = document.querySelector('.splitter[data-resize="side"]');
        if (!handle) return { ok: false, reason: 'no handle' };
        const before = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--side-w'));
        const box = handle.getBoundingClientRect();
        const at = (type, x) => handle.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, pointerId: 1, clientX: x, clientY: box.top + box.height / 2
        }));
        at('pointerdown', box.left + 1);
        at('pointermove', box.left - 60);
        at('pointerup', box.left - 60);
        const after = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--side-w'));
        return { ok: after > before + 40, before, after };
      })()
    `);
    check('dragging an edge actually resizes the panel', dragged.ok,
      'the column went from ' + dragged.before + ' to ' + dragged.after);

    const collapsed = await cdp.eval(`
      (() => {
        const main = document.querySelector('.ws-main');
        /* THE SEQUENCE STARTS FROM A KNOWN STATE. Against real records the
           operator's own saved arrangement is restored, and if they left the
           bottom panel closed then the first press of the close button OPENS it
           — so the check that it closes was measuring the opposite of what it
           described. */
        if (main.classList.contains('no-bottom')) {
          document.querySelector('[data-act="toggle-bottom"]').click();
        }
        document.querySelector('[data-act="bp-collapse"]').click();
        const shrunk = main.classList.contains('bottom-collapsed');
        document.querySelector('[data-act="bp-maximise"]').click();
        const grown = main.classList.contains('bottom-max') && !main.classList.contains('bottom-collapsed');
        document.querySelector('[data-act="toggle-bottom"]').click();
        const closed = main.classList.contains('no-bottom');
        document.querySelector('[data-act="toggle-bottom"]').click();
        const restored = !main.classList.contains('no-bottom') && !main.classList.contains('bottom-max');
        return { shrunk, grown, closed, restored };
      })()
    `);
    check('the bottom panel collapses to its tabs', collapsed.shrunk);
    check('the bottom panel maximises', collapsed.grown);
    check('the bottom panel closes', collapsed.closed);
    check('reopening it gives back a panel rather than the state it was hidden in', collapsed.restored);

    /* ---- news ---- */
    console.log('\nNews');

    await cdp.eval('document.querySelector(\'[data-act="view"][data-view="news"]\').click()');
    const headlines = await waitFor(cdp,
      'document.querySelectorAll(\'.view[data-view="news"] .news-card\').length > 3', 200);

    if (headlines) {
      const front = await cdp.eval(`
        (() => {
          const root = document.querySelector('.view[data-view="news"]');
          const lead = root.querySelector('.news-lead');
          const cards = [...root.querySelectorAll('.news-card')];
          const wire = [...root.querySelectorAll('.wire-row')];
          return {
            hasLead: !!lead,
            leadHeadline: lead ? (lead.querySelector('.lead-headline') || {}).textContent || '' : '',
            cards: cards.length,
            wire: wire.length,
            /* Artwork is served from the loopback origin, never from the
               publisher: this page makes no network request of its own. */
            pictures: [...root.querySelectorAll('img')].map(img => img.getAttribute('src') || ''),
            titles: cards.slice(0, 12).map(c => (c.querySelector('.card-headline') || {}).textContent || ''),
            publishers: cards.slice(0, 12).map(c => (c.querySelector('.publisher') || {}).textContent || ''),
            ages: cards.slice(0, 12).map(c => (c.querySelector('.age') || {}).textContent || ''),
            desks: root.querySelectorAll('.desk').length
          };
        })()
      `);

      check('the newsroom leads with a story', front.hasLead && front.leadHeadline.trim().length > 10,
        JSON.stringify(front.leadHeadline.slice(0, 60)));
      check('the front page is a grid of stories, not a list',
        front.cards > 3, 'cards: ' + front.cards);
      check('the wire carries the rest', front.wire > 0, 'wire rows: ' + front.wire);
      check('the desks are offered as filters', front.desks > 2, 'desks: ' + front.desks);
      check('every headline names who filed it',
        front.publishers.every(p => p.trim().length > 0));
      check('every headline says how old it is', front.ages.every(a => a.trim().length > 0));
      check('no publisher markup reached the screen',
        front.titles.every(title => !/[<>]/.test(title)),
        'first: ' + JSON.stringify((front.titles[0] || '').slice(0, 60)));

      /* THE PAGE ITSELF NEVER REACHES A PUBLISHER'S SERVER. Every picture is
         registered with the loopback server by the main process and served from
         there, so a headline cannot phone home from this document. */
      check('artwork is served from the application, never from the publisher',
        front.pictures.length === 0 || front.pictures.every(src => src.indexOf('http://127.0.0.1:') === 0),
        'offending: ' + JSON.stringify(front.pictures.filter(s => s.indexOf('http://127.0.0.1:') !== 0).slice(0, 2)));

      /* A keyword search is the whole point of the screen: any subject, not just
         an instrument this application happens to price. */
      await cdp.eval(`
        (() => {
          const box = document.getElementById('news-query');
          box.value = 'inflation';
          document.querySelector('[data-act="news-search"]').click();
        })()
      `);
      const searched = await waitFor(cdp,
        'document.querySelector(\'.view[data-view="news"] .news-note\') && ' +
        '/matching|Searching/.test(document.querySelector(\'.view[data-view="news"] .news-note\').textContent)', 140);
      check('a keyword search runs against the world', searched);

      const results = await cdp.eval(`
        (() => {
          const root = document.querySelector('.view[data-view="news"]');
          return {
            note: (root.querySelector('.news-note') || {}).textContent || '',
            stories: root.querySelectorAll('.news-card, .wire-row, .news-lead').length,
            back: !!root.querySelector('[data-act="news-front"]')
          };
        })()
      `);
      check('the search says what it found', results.note.trim().length > 0, results.note.slice(0, 80));
      check('there is a way back to the front page', results.back);
      await cdp.eval('document.querySelector(\'[data-act="news-front"]\').click()');
    } else {
      const message = await cdp.eval(
        '(document.querySelector(\'[data-view="news"]\') || {}).textContent || ""');
      check('the newsroom explains itself when no feed answered', message.trim().length > 20,
        'got: ' + JSON.stringify(message.trim().slice(0, 90)));
    }

    /* ---- discover ---- */
    console.log('\nDiscover — heatmap, screener, calendar');

    await cdp.eval('document.querySelector(\'[data-act="view"][data-view="discover"]\').click()');
    const tiles = await waitFor(cdp, 'document.querySelectorAll(".heat-tile").length > 10', 140);
    check('the heatmap draws tiles from real market data', tiles);

    if (tiles) {
      const heat = await cdp.eval(`
        (() => {
          const tiles = [...document.querySelectorAll('.heat-tile')];
          const boxes = tiles.map(t => t.getBoundingClientRect());
          return {
            count: tiles.length,
            /* A treemap whose tiles all have the same area is not a treemap —
               it means the sizes never reached the layout. */
            distinctWidths: new Set(boxes.map(b => Math.round(b.width))).size,
            largest: Math.round(Math.max(...boxes.map(b => b.width * b.height))),
            smallest: Math.round(Math.min(...boxes.map(b => b.width * b.height))),
            overflowing: boxes.filter(b => b.width <= 0 || b.height <= 0).length,
            symbols: tiles.slice(0, 5).map(t => t.dataset.symbol),
            groups: document.querySelectorAll('.heat-group-label').length
          };
        })()
      `);
      check('tiles are sized by market value rather than evenly',
        heat.distinctWidths > 3 && heat.largest > heat.smallest * 4,
        JSON.stringify({ distinct: heat.distinctWidths, largest: heat.largest, smallest: heat.smallest }));
      check('no tile is laid out with no area', heat.overflowing === 0, 'zero-area tiles: ' + heat.overflowing);
      check('the heatmap is grouped by sector', heat.groups > 2, 'groups: ' + heat.groups);
      check('every tile carries the instrument it stands for',
        heat.symbols.every(s => s && s.length > 0), JSON.stringify(heat.symbols));
    }

    await cdp.eval('document.querySelector(\'[data-act="discover-tab"][data-tab="screener"]\').click()');
    const screened = await waitFor(cdp, 'document.querySelectorAll(".screener tbody tr").length > 3', 140);
    check('the screener returns matches', screened);
    if (screened) {
      /* The mark fetch is deliberately fire-and-forget so the table itself
         never waits on pictures — give it a moment to land before judging
         whether any arrived. */
      await waitFor(cdp,
        '[...document.querySelectorAll(".screener tbody tr")].slice(0, 8).some(r => r.querySelector(".mark-logo"))',
        100);
      const rows = await cdp.eval(`
        (() => {
          const rows = [...document.querySelectorAll('.screener tbody tr')];
          return {
            count: rows.length,
            symbols: rows.slice(0, 5).map(r => r.dataset.symbol),
            marks: rows.slice(0, 8).filter(r => r.querySelector('.mark-logo')).length,
            presets: document.querySelectorAll('[data-act="screen-preset"]').length
          };
        })()
      `);
      check('every screener row opens an instrument', rows.symbols.every(s => s && s.length > 0));
      check('the screener offers more than one question to ask', rows.presets > 4, 'presets: ' + rows.presets);
      check('screener rows carry the company mark', rows.marks > 0, 'with a mark: ' + rows.marks);
    }

    await cdp.eval('document.querySelector(\'[data-act="discover-tab"][data-tab="calendar"]\').click()');
    await wait(600);
    const calendar = await cdp.eval(`
      (() => {
        const frame = document.querySelector('#calendar-embed iframe');
        return { framed: !!frame, src: frame ? frame.getAttribute('src') : '' };
      })()
    `);
    check('the economic calendar is framed on the loopback origin',
      calendar.framed && calendar.src.indexOf('http://127.0.0.1:') === 0, JSON.stringify(calendar.src.slice(0, 60)));

    /* ---- performance ---- */
    console.log('\nPerformance dashboard');

    await cdp.eval('document.querySelector(\'[data-act="view"][data-view="profile"]\').click()');
    await wait(900);
    const dash = await cdp.eval(`
      (() => {
        const root = document.querySelector('.view[data-view="profile"]');
        return {
          surface: root.getAttribute('data-surface'),
          metrics: root.querySelectorAll('.metric-card').length,
          calendarCells: root.querySelectorAll('.cal-cell').length,
          books: root.querySelectorAll('[data-act="dash-book"]').length,
          /* With no closed trade the screen must say so rather than drawing
             empty charts with no explanation. */
          empty: !!root.querySelector('.dash-empty'),
          text: root.textContent.trim().slice(0, 120)
        };
      })()
    `);
    check('the performance screen renders', dash.text.length > 20, dash.text);
    check('it offers the three books separately', dash.books === 3, 'books: ' + dash.books);
    check('it either shows the metrics or explains why there are none',
      dash.metrics === 5 || dash.empty,
      JSON.stringify({ metrics: dash.metrics, empty: dash.empty }));
    if (dash.metrics === 5) {
      check('the month calendar is drawn', dash.calendarCells === 42, 'cells: ' + dash.calendarCells);
    }

    await cdp.eval('document.querySelector(\'[data-act="view"][data-view="chart"]\').click()');
    await wait(300);

    /* ---- paper trading ----
     *
     * Driven end to end through the ticket rather than through the broker,
     * because the question is whether the operator can place a trade, not
     * whether the engine can fill one. Nothing here can reach a real account:
     * every order the ticket writes belongs to the paper book, and this probe
     * runs against a throwaway data directory by default. */
    console.log('\nPaper trading');

    const ticket = await cdp.eval(`
      (() => {
        const types = [...document.querySelectorAll('#ticket [data-act="tk-type"]')].map(b => b.dataset.type);
        return {
          sides: [...document.querySelectorAll('#ticket .side-btn')].map(b => b.textContent.trim()),
          types,
          quantity: !!document.getElementById('tk-qty'),
          place: !!document.querySelector('#ticket [data-act="tk-place"]')
        };
      })()
    `);
    check('the ticket offers a buy and a sell', ticket.sides.length === 2, 'got: ' + ticket.sides.join(', '));
    check('the ticket offers more than a market order', ticket.types.length >= 3, 'types: ' + ticket.types.join(', '));
    check('the ticket takes a quantity', ticket.quantity);
    check('the ticket has something to press', ticket.place);

    const preview = await cdp.eval(`
      (() => {
        const box = document.getElementById('tk-qty');
        box.value = '3';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
    await waitFor(cdp, '(document.getElementById("ticket-preview") || {}).textContent.trim().length > 0', 80);
    const previewText = await cdp.eval('(document.getElementById("ticket-preview") || {}).textContent || ""');
    /* A fill assumption that is not stated is a fill assumption nobody can
       argue with. */
    check('the ticket previews the order before it is placed', previewText.trim().length > 0,
      'got: ' + JSON.stringify(previewText.trim().slice(0, 80)));

    await cdp.eval('document.querySelector(\'#ticket [data-act="tk-place"]\').click()');
    await waitFor(cdp, 'window.__state.paper && window.__state.paper.positions.length > 0', 120);
    const booked = await cdp.eval(`
      (() => {
        const paper = window.__state.paper || {};
        return {
          positions: (paper.positions || []).length,
          rows: document.querySelectorAll('#bp-body tbody tr').length,
          text: (document.getElementById('bp-body') || {}).textContent || ''
        };
      })()
    `);
    check('a paper order becomes a position', booked.positions > 0, 'positions: ' + booked.positions);
    check('and the blotter shows it', booked.rows > 0 && /NVDA|[0-9]/.test(booked.text), 'rows: ' + booked.rows);

    const otherTabs = ['orders', 'history', 'trades', 'account'];
    for (const tab of otherTabs) {
      await cdp.eval(`window.ACTIONS.bp({ tab: '${tab}' })`);
      await wait(400);
      const body = await cdp.eval('(document.getElementById("bp-body") || {}).textContent || ""');
      check('the ' + tab + ' tab of the blotter renders', body.trim().length > 0 && !/^Loading/.test(body.trim()),
        'got: ' + JSON.stringify(body.trim().slice(0, 60)));
    }
    await cdp.eval('window.ACTIONS.bp({ tab: "positions" })');
    await wait(300);

    /* ---- the workspace has no dead space in it ---- */
    console.log('\nWorkspace layout');

    const layout = await cdp.eval(`
      (() => {
        const main = document.querySelector('.ws-main');
        const tracks = getComputedStyle(main).gridTemplateRows.split(' ').map(parseFloat);
        /* A PANEL THE OPERATOR HAS CLOSED IS NOT A PANEL WITH NOTHING IN IT.
           Closing the bottom panel sets display:none on it and on its splitter
           and drops the grid to three rows on purpose. Counting those two as
           children made a deliberate arrangement read as a broken one. */
        const kids = [...main.children]
          .filter(node => getComputedStyle(node).display !== 'none')
          .map(node => ({
            cls: node.className.split(' ')[0],
            h: Math.round(node.getBoundingClientRect().height)
          }));
        const chart = document.getElementById('chart-wrap').getBoundingClientRect();
        return { tracks, kids, chartHeight: Math.round(chart.height), mainHeight: Math.round(main.getBoundingClientRect().height) };
      })()
    `);
    check('the workspace declares exactly as many rows as it has panels on screen',
      layout.tracks.length === layout.kids.length,
      layout.tracks.length + ' tracks for ' + layout.kids.length + ' panels: ' +
      layout.kids.map(k => k.cls + '=' + k.h).join(', '));
    check('the chart is the panel that takes the room',
      layout.chartHeight > layout.mainHeight * 0.35,
      'chart ' + layout.chartHeight + ' of ' + layout.mainHeight);
    check('no panel on screen is left with nothing in it',
      layout.kids.every(k => k.h > 0),
      layout.kids.map(k => k.cls + '=' + k.h).join(', '));

    /* EVERY SCREEN IS A COLUMN AND ITS BODY TAKES THE REMAINDER.
       A screen that lays out as a grid with more rows than it has parts leaves
       the body at its content height, so it stops scrolling and runs off the
       bottom — which is invisible until there is enough content to notice. */
    /* Opened one at a time and given time to draw, because three of these fetch
       before they have anything to lay out. */
    const screens = [];
    for (const view of ['news', 'discover', 'profile', 'portfolio', 'journal', 'alerts']) {
      await cdp.eval('(document.querySelector(\'[data-act="view"][data-view="' + view + '"]\')||{click(){}}).click()');
      await waitFor(cdp, `
        (() => {
          const s = document.querySelector('.view[data-view="${view}"]');
          return !!(s && s.querySelector('.screen-body') && !s.querySelector('.loading'));
        })()
      `, 200);
      screens.push(await cdp.eval(`
        (() => {
          const view = ${JSON.stringify(view)};
          const section = document.querySelector('.view[data-view="' + view + '"]');
          const body = section && section.querySelector('.screen-body');
          if (!body) return { view, body: 'none' };
          const sectionBox = section.getBoundingClientRect();
          const bodyBox = body.getBoundingClientRect();
          return {
            view,
            /* The body must reach the bottom of the screen, not stop short of it
               nor run past it. */
            slack: Math.round(sectionBox.bottom - bodyBox.bottom),
            overflows: Math.round(bodyBox.bottom - sectionBox.bottom) > 2,
            height: Math.round(bodyBox.height)
          };
        })()
      `));
    }

    screens.forEach(entry => {
      check('the ' + entry.view + ' screen gives its body the room that is left',
        entry.body !== 'none' && entry.height > 100 && Math.abs(entry.slack) < 4,
        JSON.stringify(entry));
    });

    /* Nothing from a screen that is not on may be visible anywhere. */
    const bleed = await cdp.eval(`
      (() => {
        document.querySelector('[data-act="view"][data-view="chart"]').click();
        const rail = document.getElementById('rail').getBoundingClientRect();
        return [...document.querySelectorAll('.view')]
          .filter(v => !v.classList.contains('on'))
          .map(v => ({ view: v.dataset.view, display: getComputedStyle(v).display,
            box: (() => { const b = v.getBoundingClientRect(); return Math.round(b.width) + 'x' + Math.round(b.height); })() }))
          .filter(v => v.display !== 'none')
          .concat([{ view: 'rail', display: 'x', box: Math.round(rail.width) + 'x' + Math.round(rail.height) }]);
      })()
    `);
    check('a screen that is not open is not on the screen at all',
      bleed.filter(v => v.view !== 'rail').length === 0, JSON.stringify(bleed));

    await cdp.eval('document.querySelector(\'[data-act="view"][data-view="chart"]\').click()');
    await wait(250);

    /* A size remembered from a taller window must not come back and swallow the
       panel beneath it. This is not hypothetical: a stored watchlist height of
       526 pixels in a shorter column left the research panel with nothing and
       the watchlist itself pushed out of sight. */
    const restored = await cdp.eval(`
      (() => {
        const state = window.__state;
        const before = state.panels['--wl-h'];
        state.panels['--wl-h'] = 5000;
        window.__applyPanels();
        const applied = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--wl-h'));
        const detail = document.getElementById('detail-body').getBoundingClientRect();
        const rows = document.getElementById('wl-rows').getBoundingClientRect();
        state.panels['--wl-h'] = before === undefined ? 220 : before;
        window.__applyPanels();
        return {
          applied, height: window.innerHeight,
          detailHeight: Math.round(detail.height),
          rowsHeight: Math.round(rows.height)
        };
      })()
    `);
    check('an oversized remembered panel is clamped to the window it returns to',
      restored.applied < restored.height, 'applied ' + restored.applied + ' into ' + restored.height);
    check('and the panel below it still has room to exist',
      restored.detailHeight > 40, 'the research panel was ' + restored.detailHeight + 'px');
    check('while the watchlist itself is still on screen',
      restored.rowsHeight > 40, 'the watchlist was ' + restored.rowsHeight + 'px');

    /* The window controls are the only way out of a frameless window, so they
       are the one thing in the title bar that may never be pushed off it. */
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: 880, height: 680, deviceScaleFactor: 1, mobile: false });
    await wait(400);
    const narrow = await cdp.eval(`
      (() => {
        const bar = document.getElementById('topbar').getBoundingClientRect();
        const controls = document.querySelector('.win-controls').getBoundingClientRect();
        const close = document.querySelector('.win-btn.close').getBoundingClientRect();
        return {
          insideBar: controls.right <= bar.right + 1 && controls.top >= bar.top - 1 &&
            controls.bottom <= bar.bottom + 1,
          closeVisible: close.width > 0 && close.right <= window.innerWidth + 1 && close.left >= 0,
          onOneRow: controls.height <= bar.height + 1,
          sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth
        };
      })()
    `);
    check('the window controls stay in the title bar on a narrow window', narrow.insideBar,
      JSON.stringify(narrow));
    check('the close button is still reachable', narrow.closeVisible);
    check('nothing has wrapped onto a second row', narrow.onOneRow);
    check('and the shell does not scroll sideways to fit', !narrow.sideways);
    await cdp.send('Emulation.clearDeviceMetricsOverride', {});
    await wait(400);


    /* A note belongs in the corner, not across the instrument header. */
    const note = await cdp.eval(`
      (() => {
        const banner = document.getElementById('safemode');
        window.__state.toastProbe = true;
        const before = banner.classList.contains('on');
        return { before };
      })()
    `);
    await cdp.eval('window.__toastTest = true; window.ACTIONS["add-to-watchlist"]()');
    await wait(400);
    const toasted = await cdp.eval(`
      (() => {
        const stack = document.getElementById('toasts');
        if (!stack || !stack.children.length) return { shown: false };
        const box = stack.getBoundingClientRect();
        return {
          shown: true,
          bottomLeft: box.left < window.innerWidth * 0.4 && box.bottom > window.innerHeight * 0.5,
          coversBanner: document.getElementById('safemode').classList.contains('on')
        };
      })()
    `);
    check('a note appears without taking over the top of the workspace',
      toasted.shown && !toasted.coversBanner && !note.before,
      JSON.stringify(toasted));
    check('and it appears in the bottom corner', !toasted.shown || toasted.bottomLeft);

    /* There is no separate watchlist screen any more — the switcher is a menu
       off the same header the side column always shows. */
    await cdp.eval('document.querySelector(\'[data-act="menu"][data-menu="watchlist"]\').click()');
    await waitFor(cdp, 'document.querySelectorAll("#modal-body .menu-row").length > 0', 150);
    const lists = await cdp.eval(`
      ({
        rows: document.querySelectorAll('#modal-body .menu-row').length,
        activeMarked: document.querySelectorAll('#modal-body .menu-row.on').length,
        hasCreate: !!document.querySelector('[data-act="new-watchlist"]')
      })
    `);
    check('the watchlist switcher lists every watchlist', lists.rows > 0, 'rows: ' + lists.rows);
    check('the one shown beside the chart is marked', lists.activeMarked === 1, 'marked: ' + lists.activeMarked);
    check('a new watchlist can be started from here', lists.hasCreate);
    await cdp.eval('document.querySelector("[data-act=\'close-modal\']").click()');

    await cdp.eval('document.querySelector(\'[data-act="view"][data-view="chart"]\').click()');
    await wait(300);

    console.log('\nDrawing');

    /* A drawing is anchored in time and price, so it has to survive a change of
       timeframe. Placing one and switching the range is the only way to know. */
    const drew = await cdp.eval(`
      (() => {
        const state = window.__state;
        if (!state.draw || !state.chart) return { ok: false, reason: 'no drawing layer' };
        const bars = state.chart.bars;
        if (bars.length < 10) return { ok: false, reason: 'not enough bars' };
        const a = { t: bars[5].t, price: bars[5].c };
        const b = { t: bars[bars.length - 3].t, price: bars[bars.length - 3].c };
        state.draw.load([{ id: 'probe', type: 'trend', anchors: [a, b], style: { colour: '#f2a93b', width: 1.4 } }]);
        /* Placing a drawing by hand fires this, which is what persists it.
           Loading without it would test a path a user never takes. */
        state.draw.changed();
        state.chart.paint();
        return { ok: true, anchors: [a, b] };
      })()
    `);
    check('a drawing can be placed on the chart', drew.ok, drew.reason);

    if (drew.ok) {
      const painted = await cdp.eval(`
        (() => {
          const canvas = document.querySelector('#chart-wrap canvas.layer-draw');
          const ctx = canvas.getContext('2d');
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let lit = 0;
          for (let i = 3; i < data.length; i += 4 * 23) { if (data[i] > 12) lit++; }
          return lit;
        })()
      `);
      check('the drawing was actually painted', painted > 10, 'lit samples: ' + painted);

      await cdp.eval('window.ACTIONS.range({ range: "1y" })');
      await wait(2500);
      const survived = await cdp.eval(`
        (() => {
          const state = window.__state;
          const held = state.draw.all();
          if (!held.length) return { ok: false, reason: 'the drawing was lost' };
          return { ok: true, t: held[0].anchors[0].t, price: held[0].anchors[0].price };
        })()
      `);
      check('the drawing survives a change of timeframe', survived.ok, survived.reason);
      if (survived.ok) {
        check('and stays anchored to the same time and price',
          survived.t === drew.anchors[0].t && survived.price === drew.anchors[0].price,
          'moved to ' + JSON.stringify(survived));
      }
      await cdp.eval('window.ACTIONS["clear-drawings"]()');
    }

    /* ---- placing a drawing the way a hand actually does it ---- */
    const gesture = await cdp.eval(`
      (() => {
        const state = window.__state;
        state.draw.clear();
        window.ACTIONS.tool({ tool: 'measure' });
        return { armed: state.draw.tool };
      })()
    `);
    check('a tool can be picked up', gesture.armed === 'measure', 'got: ' + gesture.armed);

    /* Press, drag, release — over real time, on the real surface. */
    const drag = (type, fx, fy) => cdp.eval(`
      (() => {
        const surface = window.__state.chart.layers.fx.canvas;
        const box = surface.getBoundingClientRect();
        surface.dispatchEvent(new PointerEvent('${type}', {
          bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
          clientX: box.left + box.width * ${fx}, clientY: box.top + box.height * ${fy}
        }));
        return true;
      })()
    `);
    await drag('pointerdown', 0.35, 0.35);
    await wait(20);
    await drag('pointermove', 0.55, 0.6);
    await wait(20);
    await drag('pointerup', 0.55, 0.6);

    const placed = await cdp.eval(`
      (() => {
        const state = window.__state;
        const all = state.draw.all();
        return {
          count: all.length,
          type: all.length ? all[0].type : null,
          colour: all.length ? all[0].style.colour : null,
          tool: state.draw.tool,
          /* Read as an attribute: a DOMStringMap does not survive the trip
             back over the debugging protocol and arrives as an empty object. */
          armedButton: (document.querySelector('.draw-btn.on') || { getAttribute: () => null }).getAttribute('data-tool')
        };
      })()
    `);
    check('press, drag and release places a drawing', placed.count === 1 && placed.type === 'measure',
      'placed ' + placed.count + ' of type ' + placed.type);
    check('the tool puts itself away afterwards', placed.tool === 'cursor',
      'still armed with: ' + placed.tool);
    check('and the rail shows the cursor again',
      placed.armedButton === 'cursor',
      'rail shows: ' + JSON.stringify(placed.armedButton));
    check('a measurement is not drawn in the brand colour',
      placed.colour && placed.colour.toLowerCase() !== '#f0a92e',
      'got: ' + placed.colour);

    const measureLit = await cdp.eval(`
      (() => {
        const canvas = document.querySelector('#chart-wrap canvas.layer-draw');
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let lit = 0;
        for (let i = 3; i < data.length; i += 4 * 29) { if (data[i] > 12) lit++; }
        return lit;
      })()
    `);
    check('and it actually draws something', measureLit > 10, 'lit: ' + measureLit);
    await cdp.eval('window.__state.draw.clear()');

    /* ---- the vendor's chart ---- */
    console.log('\nThe chart surface');

    await cdp.eval('document.querySelector(\'[data-act="chart-source"][data-source="vendor"]\').click()');
    const vendorFramed = await waitFor(cdp, 'document.querySelector("#vendor-chart iframe")', 200);
    check('the vendor chart can be put on the chart surface', vendorFramed);

    if (vendorFramed) {
      const surface = await cdp.eval(`
        (() => {
          const frame = document.querySelector('#vendor-chart iframe');
          const holder = document.getElementById('vendor-chart');
          const engine = document.getElementById('chart-wrap');
          const box = holder.getBoundingClientRect();
          return {
            src: frame.getAttribute('src') || '',
            sandbox: frame.getAttribute('sandbox') || '',
            /* The engine chart is DESTROYED rather than hidden — a canvas nobody
               is looking at still repaints on every quote. Its box stays, because
               that box is what gives the frame its size. */
            canvases: engine.querySelectorAll('canvas').length,
            engineTornDown: !window.__state.chart,
            filled: box.width > 300 && box.height > 200
          };
        })()
      `);
      check('it is framed on the loopback origin', surface.src.indexOf('http://127.0.0.1:') === 0,
        surface.src.slice(0, 60));
      check('the frame is sandboxed', /allow-scripts/.test(surface.sandbox), surface.sandbox);
      check('it fills the chart area', surface.filled, JSON.stringify(surface));
      check('the engine chart is torn down rather than left repainting',
        surface.engineTornDown && surface.canvases === 0, JSON.stringify(surface));
    }

    await cdp.eval('document.querySelector(\'[data-act="chart-source"][data-source="native"]\').click()');
    const backToEngine = await waitFor(cdp,
      'window.__state.chart && window.__state.chart.bars.length > 10 && ' +
      '!document.getElementById("chart-wrap").hidden', 200);
    check('and the engine chart comes back', backToEngine);

    console.log('\nThe research assistant');

    await cdp.eval('document.querySelector(\'[data-act="view"][data-view="syrix"]\').click()');
    await wait(400);

    const chatReady = await cdp.eval(
      '!!document.querySelector(\'.view[data-view="syrix"] [data-syrix-input]\')');
    check('the chat has a composer', chatReady);

    /* THE SAME CONVERSATION IN TWO PLACES, NOT TWO CONVERSATIONS. The dock beside
       the work and the full screen render the same turns; two implementations
       would drift apart within a week. */
    /* Under --real-data this reads the operator's own saved workspace, and
       their own preference may already have the dock open — real prior usage,
       not a fresh install. The button toggles either way, so it is driven from
       whatever state it is actually in rather than assumed to start closed. */
    const dock = await cdp.eval(`
      (() => {
        const shell = document.getElementById('shell');
        if (shell.classList.contains('syrix-docked')) document.querySelector('[data-act="syx-dock"]').click();
        document.querySelector('[data-act="syx-dock"]').click();
        const panel = document.getElementById('syrix-dock');
        const rect = panel.getBoundingClientRect();
        return {
          marked: shell.classList.contains('syrix-docked'),
          visible: rect.width > 200 && rect.height > 200,
          composer: !!panel.querySelector('[data-syrix-input]'),
          logs: document.querySelectorAll('[data-syrix-log]').length,
          /* The product mark was deliberately removed from this surface. */
          noLogo: !panel.querySelector('img[src*="vantage"]')
        };
      })()
    `);
    check('the assistant docks beside the work', dock.marked && dock.visible, JSON.stringify(dock));
    check('the dock has its own composer', dock.composer);
    check('both surfaces render the same conversation', dock.logs === 2, 'logs: ' + dock.logs);
    check('the assistant panel carries no product mark', dock.noLogo);

    const undocked = await cdp.eval(`
      (() => {
        document.querySelector('#syrix-dock [data-act="syx-dock"]').click();
        return !document.getElementById('shell').classList.contains('syrix-docked');
      })()
    `);
    check('and it closes again', undocked);

    /* The depth control opens a menu naming what each mode actually does,
       rather than cycling blindly on every press. */
    const beforeMenu = await cdp.eval(
      `document.querySelector('.view[data-view="syrix"] [data-act="syx-depth-menu"]').textContent.trim()`);
    await cdp.eval(`document.querySelector('.view[data-view="syrix"] [data-act="syx-depth-menu"]').click()`);
    await waitFor(cdp, 'document.querySelectorAll("#modal-body [data-act=\'syx-depth\']").length === 3', 60);
    const depthMenu = await cdp.eval(`
      [...document.querySelectorAll("#modal-body [data-act='syx-depth']")].map(b => ({
        depth: b.dataset.depth, hasDetail: b.querySelector('.muted').textContent.length > 20
      }))
    `);
    check('the depth menu names all three modes with an explanation of each',
      depthMenu.length === 3 && depthMenu.every(m => m.hasDetail), JSON.stringify(depthMenu));

    const other = depthMenu.find(m => m.depth !== 'auto') || depthMenu[0];
    await cdp.eval(`document.querySelector('#modal-body [data-act="syx-depth"][data-depth="${other.depth}"]').click()`);
    await wait(150);
    const afterMenu = await cdp.eval(
      `document.querySelector('.view[data-view="syrix"] [data-act="syx-depth-menu"]').textContent.trim()`);
    const modalClosed = await cdp.eval(`!document.getElementById('modal-back').classList.contains('on')`);
    check('how deeply to work is a control, not a setting buried somewhere',
      afterMenu !== beforeMenu && modalClosed, JSON.stringify({ beforeMenu, afterMenu, modalClosed }));

    const syrixState = await cdp.eval('(document.querySelector("#syrix-state .txt")||{}).textContent || ""');
    check('the assistant reports whether it is connected', syrixState.length > 0, 'got: ' + JSON.stringify(syrixState));

    /* "Not connected" contains "connected", so a substring test passes when it
       should fail. That mistake made four checks below pass against an error
       message rather than an answer — the exact class of false pass this probe
       exists to catch. The state is matched from the start of the label. */
    const connected = /^Connected/.test(syrixState.trim());

    if (connected && process.argv.indexOf('--ask') !== -1) {
      await cdp.eval('window.T.syrix.ask("In one sentence, what is a stock split?")');
      const answered = await waitFor(cdp, 'document.querySelectorAll(".syx-body").length > 0 && ' +
        'document.querySelector(".syx-body").textContent.length > 40', 300);
      check('the assistant answered inside the application', answered);

      const answerText = await cdp.eval('(document.querySelector(".syx-body")||{}).textContent || ""');
      /* An error rendered into the answer slot is long enough to satisfy a
         length check, so the content is tested as well as its size. */
      check('the answer is an answer, not a failure notice',
        !/not connected|could not|failed|error/i.test(answerText), answerText.slice(0, 120));

      const steps = await cdp.eval('document.querySelectorAll(".syx-step").length');
      check('the step list was painted', steps > 0, 'steps: ' + steps);

      const answerHtml = await cdp.eval('(document.querySelector(".syx-body")||{}).innerHTML || ""');
      check('the answer was rendered as markup, not raw text', /<p>|<li>|<h[3-6]>/.test(answerHtml));
      check('no citation artefact reached the screen', !/【|cursor":/.test(answerHtml), answerHtml.slice(0, 120));

      /* THE ONE THAT MATTERS MOST. The assistant used to delete any sentence
         that named an action and a direction, which left it describing readings
         and refusing to conclude. Asked for a view it must now give one, with
         the level that would prove it wrong. */
      await cdp.eval('window.T.syrix.ask("Would you buy NVDA here? Give me a level and where you would be wrong.")');
      /* WAITED FOR THE TURN TO FINISH, NOT FOR TEXT TO APPEAR. The chief's
         answer streams into the bubble while the desk is still being written up,
         so the text arrives well before the reports, the stances and the checked
         line — and measuring on the text reported a council that had not yet
         finished as a council that never sat. */
      const viewed = await waitFor(cdp,
        '!window.T.syrix.state.busy && ' +
        'document.querySelectorAll(".syx-turn").length > 1 && ' +
        'document.querySelectorAll(".syx-turn")[1].querySelector(".syx-body") && ' +
        'document.querySelectorAll(".syx-turn")[1].querySelector(".syx-body").textContent.length > 200', 1800);
      check('a question asking for a view gets one', viewed);

      if (viewed) {
        const view = await cdp.eval(`
          (() => {
            const turn = document.querySelectorAll('.syx-turn')[1];
            return {
              text: turn.querySelector('.syx-body').textContent,
              council: !!turn.querySelector('.syx-council'),
              reports: turn.querySelectorAll('.syx-report').length,
              stances: turn.querySelectorAll('.stance').length,
              checked: (turn.querySelector('.syx-checked') || {}).textContent || '',
              /* Why it did not sit, when it did not. A fallback that leaves no
                 trace is a feature that silently does not work. */
              declined: (turn.querySelector('.syx-note.declined') || {}).textContent || ''
            };
          })()
        `);
        check('it convened the desk rather than answering from one pass',
          view.council && view.reports > 3,
          view.declined || JSON.stringify({ council: view.council, reports: view.reports }));
        check('each specialist declared where it stood', view.stances > 2, 'stances: ' + view.stances);
        check('the answer says what was actually read', view.checked.length > 20, view.checked.slice(0, 90));
        check('it did not refuse to take a position',
          !/cannot (provide|give|offer|recommend)|not able to (provide|give)|consult a (financial|licensed)/i
            .test(view.text), view.text.slice(0, 160));
      }
    } else if (process.argv.indexOf('--ask') !== -1) {
      console.log('  – skipped: the assistant is not paired in this data directory (' + syrixState.trim() + ')');
    }

    if (process.argv.indexOf('--shot') !== -1) {
      const target = process.argv[process.argv.indexOf('--shot') + 1] || path.join(ROOT, 'shot.png');
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(target.replace(/\.png$/, '-research.png'), Buffer.from(shot.data, 'base64'));
    }

    console.log('\nSettings');

    await cdp.eval('document.querySelector(\'[data-act="view"][data-view="settings"]\').click()');
    await waitFor(cdp, 'document.getElementById("about-author").textContent.length > 0', 40);
    const author = await cdp.eval('document.getElementById("about-author").textContent');
    check('the application says who made it', /Kabirr Kohli/.test(author), 'got: ' + JSON.stringify(author));

    const madeBy = await cdp.eval('document.getElementById("made-by").textContent');
    check('and says so in the status bar too', /Kabirr Kohli/.test(madeBy), 'got: ' + JSON.stringify(madeBy));

    await cdp.eval('document.querySelector(\'[data-act="view"][data-view="chart"]\').click()');
    await wait(200);

    console.log('\nThemes');

    /* Both themes are checked, not just the default one. An ink token used as a
       background renders white-on-white the moment the theme flips, and nothing
       about that is visible until somebody flips it. */
    for (const mode of ['light', 'dark']) {
      /* Changing the theme rebuilds the chart, because it resolves its palette
         once at construction — so this waits for the replacement to have data
         rather than for a fixed moment. */
      await cdp.eval('window.ACTIONS.theme({ mode: "' + mode + '" })');
      await waitFor(cdp, 'window.__state.chart && window.__state.chart.bars.length > 20', 150);
      await wait(400);

      const applied = await cdp.eval('document.documentElement.getAttribute("data-theme")');
      check('the ' + mode + ' theme applies', applied === mode, 'got: ' + applied);

      /* Text the same tone as what is behind it is unreadable, and passes every
         other check in this file. */
      const unreadable = await cdp.eval(`
        (() => {
          /* Colours arrive as "rgb(r, g, b)" or "rgba(r, g, b, a)". Split
             rather than match: this string is nested two template literals
             deep, and every backslash an expression needed was being eaten
             before it reached the page. */
          const channels = value => {
            const open = String(value).indexOf("(");
            const close = String(value).lastIndexOf(")");
            if (open < 0 || close < 0) return null;
            return String(value).slice(open + 1, close).split(",").map(part => Number(part.trim()));
          };
          const bad = [];
          const controls = ".btn, .tb-btn, .rail-btn, .side-btn, .btn-big, .topnav-btn, .bp-tab";
          document.querySelectorAll(controls).forEach(node => {
            const style = getComputedStyle(node);
            const back = channels(style.backgroundColor);
            const ink = channels(style.color);
            if (!back || !ink || back.length < 3 || ink.length < 3) return;
            /* A translucent background is composited over whatever is behind
               it, so its own colour says nothing about legibility. */
            if (back.length > 3 && back[3] < 0.9) return;
            const luma = c => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
            if (Math.abs(luma(ink) - luma(back)) < 0.085) {
              bad.push((node.textContent || node.dataset.act || "?").trim().slice(0, 22));
            }
          });
          return bad;
        })()
      `);
      check('no control is the same tone as its own background in ' + mode,
        unreadable.length === 0, 'unreadable: ' + unreadable.join(', '));

      const chartDrew = await cdp.eval(`
        (() => {
          const canvas = document.querySelector('#chart-wrap canvas.layer-main');
          if (!canvas) return { lit: 0, why: 'no main layer' };
          const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          let lit = 0;
          for (let i = 3; i < data.length; i += 4 * 41) { if (data[i] > 12) lit++; }
          const chart = window.__state.chart;
          return {
            lit,
            bars: chart ? chart.bars.length : -1,
            canvases: document.querySelectorAll('#chart-wrap canvas').length,
            why: (document.querySelector('#chart-wrap .note-line') || {}).textContent || ''
          };
        })()
      `);
      check('the chart repaints for the ' + mode + ' theme', chartDrew.lit > 30,
        'lit: ' + chartDrew.lit + ', bars: ' + chartDrew.bars + ', canvases: ' + chartDrew.canvases +
        (chartDrew.why ? ', note: ' + chartDrew.why : ''));

      if (process.argv.indexOf('--shot') !== -1) {
        const target = process.argv[process.argv.indexOf('--shot') + 1] || path.join(ROOT, 'shot.png');
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(target.replace(/\.png$/, '-' + mode + '.png'), Buffer.from(shot.data, 'base64'));
      }
    }

    console.log('\nPolicy and errors');

    const probe = await cdp.eval('window.__probe');
    check('no content policy violations', probe.csp.length === 0, probe.csp.join('; '));
    check('no page errors', probe.errors.length === 0, probe.errors.join('; '));

    const overflow = await cdp.eval('document.documentElement.scrollWidth <= window.innerWidth + 1');
    check('the page does not scroll sideways', overflow);

    if (process.argv.indexOf('--shot') !== -1) {
      const target = process.argv[process.argv.indexOf('--shot') + 1] || path.join(ROOT, 'shot.png');
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
      console.log('\nWrote ' + target);
    }

  } catch (err) {
    failed++;
    console.log('  ✗ the probe could not finish: ' + err.message);
    if (stderr.length) console.log(stderr.join('').split('\n').slice(0, 20).join('\n'));
  } finally {
    if (cdp) cdp.close();
    if (process.argv.indexOf('--keep') === -1) {
      try { child.kill(); } catch (e) { /* already gone */ }
      await wait(400);
      /* ONLY A DIRECTORY THIS PROBE CREATED IS EVER REMOVED.
       *
       * An earlier version deleted `dataDir` unconditionally, which under
       * --real-data pointed at the installation's own data — so running the
       * probe against real data destroyed it, device token and all. A cleanup
       * step that can reach real records is not a cleanup step. */
      if (!useReal) {
        try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* temporary */ }
      }
    }
  }

  console.log('');
  if (failed) {
    console.log(failed + ' failed, ' + passed + ' checks passed.');
    return false;
  }
  console.log('All ' + passed + ' interface checks passed.');
  return true;
}

async function waitFor(cdp, expression, attempts) {
  for (let i = 0; i < attempts; i++) {
    try {
      if (await cdp.eval('!!(' + expression + ')')) return true;
    } catch (e) { /* the page may still be assembling */ }
    await wait(200);
  }
  return false;
}

if (require.main === module) {
  main().then(ok => process.exit(ok ? 0 : 1)).catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main };
