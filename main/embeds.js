'use strict';
/* The embed host: a loopback server for the two things a file:// page under a
 * strict content policy cannot do for itself.
 *
 * WHY THIS EXISTS AT ALL. The interface is a local page whose policy forbids it
 * from reaching the network — every figure it shows arrived over the bridge.
 * Two features need more than that:
 *
 *   A THIRD-PARTY CHART, HEATMAP, SCREENER OR CALENDAR. Those are published as
 *   an embeddable widget: a script that builds a frame. It cannot run inside the
 *   application's own document without opening that document to remote script,
 *   which would undo the policy for everything else on the page.
 *
 *   ARTWORK ON A HEADLINE. A publisher's picture lives on the publisher's own
 *   server, and img-src is 'self'.
 *
 * The answer to both is a separate origin. This server binds to the loopback
 * interface on an ephemeral port and serves two things: host pages that carry a
 * widget, which the interface puts in a frame, and images the application has
 * itself decided to publish. The frame is cross-origin, so the widget cannot
 * touch the application's document; the application's policy stays exactly as
 * tight as it was, with one origin added to img-src and frame-src.
 *
 * THREE THINGS KEEP THIS FROM BEING AN OPEN PROXY ON THE MACHINE.
 *
 *   It listens on 127.0.0.1 only, so nothing off this machine can reach it.
 *
 *   Every request must carry a token generated at start-up and held in memory.
 *   Another process on this machine cannot guess it.
 *
 *   THE IMAGE ROUTE SERVES A REGISTRY, NOT A URL. It will not fetch an address
 *   handed to it. It fetches only addresses the application has already decided
 *   to publish, each registered under a hash of itself. A caller cannot point it
 *   at anything the application did not choose, which is the difference between
 *   a proxy and a cache.
 */

const http = require('http');
const crypto = require('crypto');
const net = require('../src/core/http');
const brand = require('../src/core/brand');

/* The vendor publishes these as free embeddable widgets. Named here rather than
   taken from the renderer, so a request can only ask for a widget that exists
   and cannot smuggle a script address of its own. */
const WIDGETS = {
  chart: 'advanced-chart',
  symbolOverview: 'symbol-overview',
  miniChart: 'mini-symbol-overview',
  technicals: 'technical-analysis',
  symbolInfo: 'symbol-info',
  financials: 'financials',
  profile: 'symbol-profile',
  stockHeatmap: 'stock-heatmap',
  etfHeatmap: 'etf-heatmap',
  cryptoHeatmap: 'crypto-coins-heatmap',
  forexHeatmap: 'forex-heat-map',
  screener: 'screener',
  calendar: 'events',
  tickerTape: 'ticker-tape',
  marketOverview: 'market-overview',
  hotlists: 'hotlists',
  timeline: 'timeline'
};

const SCRIPT_BASE = 'https://s3.tradingview.com/external-embedding/embed-widget-';

/* How long a fetched image is kept in memory, and how many. A news front page
   holds perhaps sixty pictures; several times that covers scrolling back and
   switching desks without the process growing without bound. */
/* Characters that must not appear as themselves inside a script element.
   The angle brackets and the ampersand would let a configuration value close
   the element early; the two separators are legal inside a JSON string and
   illegal inside a JavaScript source line. Each is written as its escape, so
   the HTML parser sees plain text and the JSON parser reading it back sees the
   original character. */
const SCRIPT_ESCAPES = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029'
};

const IMAGE_TTL = 30 * 60 * 1000;
const IMAGE_MAX = 400;
const REGISTRY_MAX = 4000;

class EmbedHost {
  constructor(options) {
    const opts = options || {};
    this.audit = opts.audit || null;
    this.token = crypto.randomBytes(24).toString('hex');
    this.port = 0;
    this.server = null;
    /* hash -> original address. Only what the application published. */
    this.registry = new Map();
    this.order = [];
    /* hash -> { body, contentType, at } */
    this.cache = new Map();
  }

  origin() {
    return this.port ? 'http://127.0.0.1:' + this.port : null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.route(req, res));
      this.server.on('error', reject);
      /* Port 0 asks the operating system for a free one. A fixed port would
         collide with whatever else the machine is running and would make the
         address predictable to other processes on it. */
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        if (this.audit) this.audit.write('embeds.started', { port: this.port });
        resolve(this.port);
      });
    });
  }

  stop() {
    if (this.server) { try { this.server.close(); } catch (e) { /* already down */ } }
    this.server = null;
  }

  /* Register an address as publishable and return the loopback path that will
     serve it. Anything not registered cannot be fetched at all. */
  publishImage(url) {
    const address = String(url || '');
    if (!/^https:\/\//i.test(address)) return null;

    const hash = crypto.createHash('sha1').update(address).digest('hex').slice(0, 20);
    if (!this.registry.has(hash)) {
      this.registry.set(hash, address);
      this.order.push(hash);
      while (this.order.length > REGISTRY_MAX) {
        const dropped = this.order.shift();
        this.registry.delete(dropped);
        this.cache.delete(dropped);
      }
    }
    return this.origin() + '/image/' + hash + '?k=' + this.token;
  }

  /* A vendor logo, which is addressed by a slug rather than by a full URL. The
     slug is constrained here so a request cannot walk out of that path. */
  logoUrl(slug, big) {
    const clean = String(slug || '').trim();
    if (!clean || !/^[a-z0-9][a-z0-9._/-]{0,80}$/i.test(clean) || clean.indexOf('..') !== -1) return null;
    return this.publishImage('https://s3-symbol-logo.tradingview.com/' + clean + (big ? '--big' : '') + '.svg');
  }

  /* The address of a widget host page, for the interface to put in a frame. */
  widgetUrl(kind, config) {
    if (!WIDGETS[kind]) return null;
    const payload = Buffer.from(JSON.stringify(config || {}), 'utf8').toString('base64');
    return this.origin() + '/widget/' + kind + '?k=' + this.token + '&c=' + encodeURIComponent(payload);
  }

  /* ---------- serving ---------- */

  route(req, res) {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch (e) { return this.refuse(res, 400, 'Bad request.'); }

    if (url.searchParams.get('k') !== this.token) return this.refuse(res, 403, 'Not this application.');

    if (url.pathname.indexOf('/widget/') === 0) return this.serveWidget(url, res);
    if (url.pathname.indexOf('/image/') === 0) return this.serveImage(url, res);
    return this.refuse(res, 404, 'No such thing here.');
  }

  refuse(res, status, message) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(message);
  }

  serveWidget(url, res) {
    const kind = url.pathname.slice('/widget/'.length);
    const widget = WIDGETS[kind];
    if (!widget) return this.refuse(res, 404, 'No such widget.');

    let config = {};
    try {
      config = JSON.parse(Buffer.from(String(url.searchParams.get('c') || ''), 'base64').toString('utf8'));
    } catch (e) { config = {}; }
    if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      /* This page is only ever framed by the application's own document. */
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(hostPage(widget, config));
  }

  async serveImage(url, res) {
    const hash = url.pathname.slice('/image/'.length);
    const address = this.registry.get(hash);
    if (!address) return this.refuse(res, 404, 'That picture was not published by this application.');

    const held = this.cache.get(hash);
    if (held && Date.now() - held.at < IMAGE_TTL) return sendImage(res, held);

    try {
      const fetched = await net.binary(address, { expect: 'image/', maxBytes: 4 * 1024 * 1024, timeout: 12000 });
      const entry = { body: fetched.body, contentType: fetched.contentType, at: Date.now() };
      this.cache.set(hash, entry);
      /* Oldest out first. The registry is the record of what may be fetched;
         this is only what has been fetched lately. */
      if (this.cache.size > IMAGE_MAX) {
        const oldest = this.cache.keys().next().value;
        this.cache.delete(oldest);
      }
      sendImage(res, entry);
    } catch (err) {
      /* A picture that will not load is not worth an error page: the interface
         hides the frame and shows the headline, which is the part that matters.
         The status says what happened for anyone reading the network log. */
      this.refuse(res, 502, 'That picture could not be fetched: ' + ((err && err.message) || 'unknown'));
    }
  }
}

function sendImage(res, entry) {
  res.writeHead(200, {
    'Content-Type': entry.contentType || 'image/jpeg',
    'Content-Length': entry.body.length,
    'Cache-Control': 'private, max-age=1800'
  });
  res.end(entry.body);
}

/* The page that carries a widget.
 *
 * The configuration is written into the script element's body, which is how the
 * vendor's embed is documented to work. JSON.stringify is not enough on its own:
 * a string containing a closing script tag would end the element early, so every
 * angle bracket and ampersand is escaped to its unicode form. The parser sees
 * plain text; the JSON parser reading it sees the original characters.
 *
 * The attribution link is the vendor's condition for using these free widgets
 * and is left where they put it. */
function hostPage(widget, config) {
  const json = JSON.stringify(config).replace(/[<>&\u2028\u2029]/g, ch => SCRIPT_ESCAPES[ch]);
  /* The pale line under a widget was screenshotted on the operator's own
     machine and turned out to be this element's BACKGROUND, not only its
     text \u2014 left as `transparent`, something loaded after this stylesheet
     turns it back to white regardless of the surrounding page's theme.
     Common to every widget this host page ever serves, chart and heatmap
     alike, because they all share this one template. An explicit colour,
     marked !important, is what actually holds against it. */
  const dark = (config.theme || config.colorTheme) !== 'light';
  const plate = () => (dark ? '#131722' : '#ffffff');
  const ink = () => (dark ? '#b2b5be' : '#5d606b');

  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">\n' +
    '<title>' + widget + '</title>\n' +
    '<style>\n' +
    '  html,body{margin:0;padding:0;height:100%;background:' + plate() + ' !important;overflow:hidden}\n' +
    '  .tradingview-widget-container{height:100%;width:100%;background:' + plate() + ' !important}\n' +
    '  .tradingview-widget-container__widget{height:calc(100% - 20px);width:100%}\n' +
    '  .tradingview-widget-copyright{font:11px -apple-system,Segoe UI,sans-serif;line-height:20px;' +
    'text-align:center;background:' + plate() + ' !important;color:' + ink() + ' !important}\n' +
    '  .tradingview-widget-copyright a{color:inherit;text-decoration:none}\n' +
    '</style></head><body>\n' +
    '<div class="tradingview-widget-container">\n' +
    '  <div class="tradingview-widget-container__widget"></div>\n' +
    '  <div class="tradingview-widget-copyright">' +
    '<a href="https://www.tradingview.com/" rel="noopener nofollow" target="_blank">Charts by TradingView</a></div>\n' +
    /* The script MUST be a child of .tradingview-widget-container, last in
       source order, exactly as the vendor's own snippet has it — the widget
       finds its home with document.currentScript.parentElement. A script
       placed as a sibling after the container's closing tag still fetches and
       runs without error; it just never finds anywhere to draw, so the frame
       loads, the CSP is clean, the copyright line renders, and the chart pane
       stays blank with nothing in any log to explain why. */
    '  <script type="text/javascript" src="' + SCRIPT_BASE + widget + '.js" async>\n' +
    json + '\n' +
    '  </' + 'script>\n' +
    '</div>\n' +
    '</body></html>\n';
}

module.exports = { EmbedHost, WIDGETS, hostPage, brandUserAgent: brand.userAgent };
