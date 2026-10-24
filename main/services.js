'use strict';
/* Construction and wiring.
 *
 * Everything the application owns is built here once and handed to the IPC
 * layer. Keeping construction in one file means the dependency order is
 * readable top to bottom, and it is the only place that knows which store
 * belongs to which concern.
 */

const http = require('../src/core/http');
const path = require('path');
const paths = require('../src/core/paths');
const brand = require('../src/core/brand');
const { Store } = require('../src/core/store');
const { Audit } = require('../src/core/audit');
const { Engine } = require('../src/market/engine');
const { SafeMode } = require('../src/market/integrity');
const yahoo = require('../src/market/providers/yahoo');
const { Ledger, BOOK } = require('../src/portfolio/ledger');
const { Journal } = require('../src/portfolio/journal');
const journal = require('../src/portfolio/journal');
const positions = require('../src/portfolio/positions');
const valuation = require('../src/portfolio/valuation');
const riskEngine = require('../src/portfolio/risk');
const { PaperBroker } = require('../src/paper/broker');
const { AlertBook } = require('../src/market/alerts');
const { Gateway } = require('../src/syrix/gateway');
const { Conversation } = require('../src/syrix/loop');
const { Uploads } = require('../src/syrix/uploads');
const worldnews = require('../src/market/providers/worldnews');
const { EmbedHost } = require('./embeds');

/* Settings every embedded surface gets unless it overrides them. The locale and
   the time zone are the operator's, so a calendar shows their working day and a
   chart's axis reads in their time rather than in the vendor's. */
const EMBED_DEFAULTS = {
  locale: 'en',
  timezone: 'Europe/London',
  autosize: true,
  isTransparent: true,
  support_host: 'https://www.tradingview.com'
};

/* What may be sent to a widget. A configuration is written into a script
 * element, so this is the boundary between the interface and a third-party
 * document: strings, finite numbers, booleans, shallow arrays of those, and
 * one level of plain-object nesting — which `overrides` (the advanced-chart
 * widget's own colour customisation) actually needs and nothing deeper does.
 *
 * A function or anything nested past that one level would be silently
 * accepted by the encoder and is not something any of these widgets take, so
 * refusing it here keeps the surface exactly as wide as it needs to be. */
function sanitiseConfig(input) {
  const source = input && typeof input === 'object' ? input : {};
  const out = {};

  Object.keys(source).slice(0, 40).forEach(key => {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(key)) return;
    const value = source[key];

    if (typeof value === 'string') { out[key] = value.slice(0, 400); return; }
    if (typeof value === 'boolean') { out[key] = value; return; }
    if (typeof value === 'number' && Number.isFinite(value)) { out[key] = value; return; }
    if (Array.isArray(value)) {
      out[key] = value.slice(0, 60).map(entry => {
        if (typeof entry === 'string') return entry.slice(0, 200);
        if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
        if (entry && typeof entry === 'object') {
          /* One level of nesting, which is what a watchlist of named symbols
             and a set of tabbed panes both need. */
          const nested = {};
          Object.keys(entry).slice(0, 12).forEach(inner => {
            const value2 = entry[inner];
            if (typeof value2 === 'string') nested[inner] = value2.slice(0, 200);
            else if (typeof value2 === 'boolean') nested[inner] = value2;
            else if (typeof value2 === 'number' && Number.isFinite(value2)) nested[inner] = value2;
            else if (Array.isArray(value2)) {
              nested[inner] = value2.slice(0, 40)
                .filter(v => typeof v === 'string' || typeof v === 'number')
                .map(v => (typeof v === 'string' ? v.slice(0, 200) : v));
            }
          });
          return nested;
        }
        return null;
      }).filter(entry => entry !== null);
      return;
    }
    if (value && typeof value === 'object') {
      /* One level of nesting at the top too — the advanced-chart widget's
         own `overrides` and `studies_overrides` are documented as a flat
         object of dotted property paths to colour strings
         ("paneProperties.background"), and there is no other way to hand
         those to it. Still no function, no further nesting. */
      const nested = {};
      Object.keys(value).slice(0, 60).forEach(inner => {
        if (!/^[A-Za-z][A-Za-z0-9_.]{0,60}$/.test(inner)) return;
        const value2 = value[inner];
        if (typeof value2 === 'string') nested[inner] = value2.slice(0, 100);
        else if (typeof value2 === 'boolean') nested[inner] = value2;
        else if (typeof value2 === 'number' && Number.isFinite(value2)) nested[inner] = value2;
      });
      out[key] = nested;
    }
  });

  return out;
}

class Services {
  constructor() {
    http.setCacheDir(paths.dir('cache'));

    this.audit = new Audit(paths.auditFile());

    this.stores = {
      config: new Store(paths.dir('config')),
      market: new Store(paths.dir('market')),
      journal: new Store(paths.dir('journal')),
      research: new Store(paths.dir('research')),
      portfolio: new Store(paths.dir('portfolio'))
    };

    /* The market source persists its own session token here rather than
       re-establishing it on every launch; see that adapter for why. */
    yahoo.useStore(this.stores.config);

    this.safeMode = new SafeMode({ audit: this.audit });
    this.engine = new Engine({
      store: this.stores.market,
      audit: this.audit,
      safeMode: this.safeMode
    });

    this.ledger = new Ledger(this.stores.portfolio);
    this.journal = new Journal(this.stores.journal);

    this.accountCurrency = 'GBP';
    this.startedAt = Date.now();
    this.timeZone = 'Europe/London';
    /* Exchange rates are only filled in once a real rate has been fetched with
       a timestamp. Until then the valuation layer reports per-currency
       subtotals rather than inventing a conversion. */
    this.fxRates = {};

    this.paper = new PaperBroker({
      store: this.stores.config,
      ledger: this.ledger,
      safeMode: this.safeMode,
      audit: this.audit
    });

    this.alertBook = new AlertBook({
      store: this.stores.config,
      safeMode: this.safeMode,
      audit: this.audit
    });

    /* Every price that arrives is offered to the resting paper orders, so a
       limit fills when the market reaches it rather than when the screen is
       looked at — and to every armed alert, so one arriving price is the only
       thing either of them is evaluated against. */
    this.engine.onUpdate(models => {
      models.forEach(model => {
        try { this.paper.onQuote(model); } catch (e) { /* a fill must not break the poll */ }
        try { this.alertBook.onQuote(model); } catch (e) { /* a firing must not break the poll */ }
      });
    });

    /* The loopback origin that serves embedded widgets and news artwork. Started
       by the entry point, because the content policy it appears in has to be
       written after the operating system has chosen its port. */
    this.embeds = new EmbedHost({ audit: this.audit });

    this.gateway = new Gateway({ store: this.stores.config, audit: this.audit });
    this.uploads = new Uploads({ store: this.stores.config, audit: this.audit });

    /* The assistant reads the same objects the interface does, so an answer
       about the portfolio cannot be computed from a different copy of it. */
    const services = this;
    this.conversation = new Conversation({
      gateway: this.gateway,
      audit: this.audit,
      store: this.stores.research,
      context: {
        engine: this.engine,
        ledger: this.ledger,
        journal: this.journal,
        uploads: this.uploads,
        accountCurrency: 'GBP',
        timeZone: 'Europe/London',
        /* Read at the moment a question is asked rather than captured at
           construction, so "why is this moving?" resolves against whatever the
           workspace is showing now. */
        get selectedSymbol() { return services.selectedSymbol; },
        get currentView() { return services.currentView; }
      }
    });

    this.audit.write('app.started', { version: require('../package.json').version });
  }

  /* ---------- workspace state ---------- */

  /* The instrument the workspace is currently looking at. Held in the main
     process so a detached panel on another monitor follows the main window's
     selection rather than keeping its own idea of it. */
  get selectedSymbol() {
    return this._selected || null;
  }

  select(symbol) {
    this._selected = symbol || null;
    return this._selected;
  }

  /* Which screen is on the main window right now — read by the assistant so
     a vague question ("analyse my performance", "what does this show") can
     resolve against what is actually on screen, the same way selectedSymbol
     lets "this" mean the instrument charted right now. Held for context
     only: nothing about answering an ordinary question anywhere else
     changes because of it. */
  get currentView() {
    return this._view || null;
  }

  setView(view) {
    this._view = view || null;
    return this._view;
  }

  /* ---------- watchlists ---------- */

  watchlists() {
    const held = this.stores.config.all('watchlists');
    if (held.length) return held;
    /* A first launch with an empty screen gives no way in. These are starting
       points across every asset class the application handles, chosen so the
       formatting differences are visible immediately: a London listing quoted
       in pence, an index with no currency, a yield quoted as a percentage. */
    const seeded = [{
      id: 'default',
      name: 'Markets',
      symbols: ['NVDA', 'AAPL', 'MSFT', 'HSBA.L', '^GSPC', '^TNX', 'GC=F', 'CL=F', 'EURUSD=X', 'BTC-USD'],
      createdAt: Date.now()
    }];
    this.stores.config.putMany('watchlists', seeded);
    return seeded;
  }

  saveWatchlist(list) {
    if (!list || !list.id) throw new Error('A watchlist needs an identifier.');
    const record = {
      id: String(list.id),
      name: String(list.name || 'Untitled'),
      symbols: (list.symbols || []).map(String).slice(0, 500),
      columns: list.columns || null,
      createdAt: list.createdAt || Date.now(),
      updatedAt: Date.now()
    };
    this.stores.config.put('watchlists', record);
    this.audit.write('watchlist.saved', { id: record.id, count: record.symbols.length });
    return record;
  }

  removeWatchlist(id) {
    this.stores.config.remove('watchlists', id);
    this.audit.write('watchlist.removed', { id });
    return true;
  }

  /* ---------- alerts ---------- */

  alerts() {
    return this.alertBook.list();
  }

  saveAlert(alert) {
    return this.alertBook.save(alert);
  }

  removeAlert(id) {
    return this.alertBook.remove(id);
  }

  rearmAlert(id) {
    return this.alertBook.rearm(id);
  }

  /* ---------- theme ---------- */

  theme() {
    return this.stores.config.doc('theme', { name: 'default', mode: 'dark', overrides: {} });
  }

  saveTheme(theme) {
    const record = {
      name: String((theme && theme.name) || 'custom'),
      mode: (theme && theme.mode) === 'light' ? 'light' : 'dark',
      overrides: (theme && theme.overrides) || {},
      updatedAt: Date.now()
    };
    this.stores.config.putDoc('theme', record);
    return record;
  }

  /* ---------- books ---------- */

  /* Price whatever is open, tolerating the ones that cannot be priced — the
     valuation layer names those rather than dropping them from the total. */
  async priceAll(symbols) {
    const quotes = new Map();
    await Promise.all(symbols.map(async symbol => {
      try { quotes.set(symbol, await this.engine.quote(symbol)); } catch (e) { /* named as unpriced */ }
    }));
    return quotes;
  }

  /* Every book is valued the same way, from the same ledger, so a figure cannot
     mean one thing on one screen and something else on another. */
  /* Exchange rates for every currency the book holds, from the market rather
     than from a constant.
   *
   * WITHOUT THIS THERE IS NO SINGLE TOTAL AT ALL, and that is the rule working
   * rather than failing: a portfolio of dollars reported in pounds needs a real
   * rate, and inventing one is how a total becomes fiction. What was missing
   * was not the rule but the rate — nothing ever fetched one, so a book holding
   * one foreign currency could only ever show per-currency subtotals.
   *
   * The pair is fetched the way the venue quotes it and inverted by the
   * valuation if needed, so the figure stored is the one the source published.
   * A pair that cannot be priced is left out, and the total goes back to being
   * refused for that currency, with the reason. */
  async ensureRates(currencies) {
    const account = this.accountCurrency;
    const wanted = Array.from(new Set(currencies))
      .filter(Boolean)
      .filter(currency => currency !== account && !valuation.sameMoney(currency, account));

    await Promise.all(wanted.map(async currency => {
      const held = this.fxRates[account + currency];
      /* Rates are re-read on the same cadence as any other quote; the engine
         decides when that is from the session state of the FX market. */
      if (held && Date.now() - (held.at || 0) < 60 * 1000) return;
      try {
        const model = await this.engine.quote(account + currency + '=X');
        const rate = model.quote && model.quote.last;
        if (!Number.isFinite(Number(rate)) || Number(rate) === 0) return;
        this.fxRates[account + currency] = {
          rate: Number(rate),
          at: model.quote.at,
          freshness: model.freshness,
          source: model.provenance ? model.provenance.providerLabel : null
        };
      } catch (err) {
        /* No rate is a better answer than a guessed one. */
      }
    }));
  }

  async valueBook(book) {
    const built = positions.build(this.ledger.ordered(book));
    const quotes = await this.priceAll(built.filter(p => p.open).map(p => p.symbol));

    await this.ensureRates(
      built.map(p => (quotes[p.symbol] && quotes[p.symbol].currency) || p.currency)
        .concat(Object.keys(this.ledger.cash(book) || {}))
    );

    const valued = valuation.value({
      book,
      positions: built,
      quotes,
      accountCurrency: this.accountCurrency,
      cash: this.ledger.cash(book),
      fxRates: this.fxRates
    });
    valued.exposure = riskEngine.exposure(valued);
    valued.observations = riskEngine.observations(valued.exposure);
    return valued;
  }

  transactions(book) {
    return this.ledger.ordered(book);
  }

  addTransaction(input) {
    const record = this.ledger.add(input);
    this.audit.write('transaction.added', {
      book: record.book, kind: record.kind, symbol: record.symbol, at: record.at
    });
    return record;
  }

  removeTransaction(id) {
    this.ledger.remove(id);
    this.audit.write('transaction.removed', { id });
    return true;
  }

  journalFor(book) {
    const built = positions.build(this.ledger.ordered(book));
    const trades = positions.closedTrades(built);
    const entries = this.journal.entries(trades);
    return {
      book,
      currency: this.accountCurrency,
      statistics: journal.statistics(entries),
      groups: journal.groupings(entries, this.timeZone),
      calendar: journal.calendar(entries, this.timeZone),
      trades: entries,
      /* Surfaced rather than dropped: a corrected transaction changes a trade's
         fingerprint, and the note attached to it is the least replaceable thing
         in this application. */
      orphaned: this.journal.orphaned(trades)
    };
  }

  /* ---------- paper trading ---------- */

  async paperState(symbol) {
    const book = BOOK.PAPER;
    const valued = await this.valueBook(book);
    const cash = this.ledger.cash(book);

    let quote = null;
    if (symbol) {
      try {
        const model = await this.engine.quote(symbol);
        quote = {
          symbol: model.symbol, last: model.quote.last, currency: model.currency,
          assetClass: model.assetClass, freshness: model.freshness,
          bid: model.quote.bid, ask: model.quote.ask
        };
      } catch (e) { quote = null; }
    }

    const cashTotal = Object.keys(cash).reduce((sum, key) => sum + (cash[key] || 0), 0);
    const marketValue = valued.totals ? valued.totals.marketValue : 0;

    return {
      symbol: symbol || null,
      currency: this.accountCurrency,
      quote,
      cash: cashTotal,
      equity: cashTotal + marketValue,
      unrealised: valued.totals ? valued.totals.unrealised : null,
      realised: valued.totals ? valued.totals.realised : null,
      positions: valued.holdings.map(h => ({
        symbol: h.symbol, quantity: h.quantity, averageEntry: h.averageEntry,
        last: h.last, unrealised: h.unrealised, unrealisedPct: h.unrealisedPct,
        marketValue: h.marketValue, currency: h.quoteCurrency || h.currency,
        priced: h.priced
      })),
      orders: this.paper.orders(),
      safeMode: this.safeMode.state()
    };
  }

  async previewOrder(input) {
    let model = null;
    try { model = await this.engine.quote(input.symbol); } catch (e) { model = null; }
    return this.paper.preview(input, model);
  }

  async placeOrder(input) {
    let model = null;
    try { model = await this.engine.quote(input.symbol); } catch (e) { model = null; }
    if (!model) throw new Error('No price is loaded for ' + input.symbol + ', so this order cannot be priced.');
    const placed = this.paper.place(input, model);
    /* A resting order needs the instrument watched, or nothing will ever arrive
       to fill it against. */
    this.engine.subscribe([input.symbol]);
    return placed;
  }

  cancelOrder(id) {
    return this.paper.cancel(id);
  }

  /* Clears the simulated account entirely: its orders and its transactions.
     Deliberately scoped to the paper book — no other book can be reached. */
  resetPaper() {
    this.stores.config.save('orders', []);
    const kept = this.ledger.all().filter(tx => tx.book !== BOOK.PAPER);
    this.stores.portfolio.save('transactions', kept);
    this.audit.write('paper.reset', {});
    return true;
  }

  /* ---------- embedded surfaces ---------- */

  /* THE INTERFACE NEVER BUILDS ONE OF THESE ADDRESSES ITSELF. It names a widget
     and passes settings; the shape of both is checked here and the address is
     minted with the token that the loopback server will demand. That keeps the
     token out of the renderer's reach as a value it can compose with, and means
     a compromised page cannot point a frame at anything of its own choosing. */
  embedUrl(kind, settings) {
    const config = Object.assign({}, EMBED_DEFAULTS, sanitiseConfig(settings));
    const url = this.embeds.widgetUrl(kind, config);
    if (!url) throw new Error('There is no embedded surface called ' + kind + '.');
    return { url, kind };
  }

  /* Company marks for a whole screen at once — a watchlist, a set of search
     results, an instrument header. Null where the vendor publishes none, and the
     interface falls back to the initials rather than showing a broken frame.
   *
     A currency pair and a crypto pair have two marks rather than one, which the
     interface overlaps the way the vendor's own does. */
  async logos(symbols) {
    const found = await this.engine.logosFor((symbols || []).slice(0, 120)).catch(() => ({}));
    const out = {};
    Object.keys(found).forEach(symbol => {
      const record = found[symbol];
      out[symbol] = record ? {
        logo: record.logo ? this.embeds.logoUrl(record.logo, true) : null,
        base: record.base ? this.embeds.logoUrl(record.base, true) : null,
        quote: record.quote ? this.embeds.logoUrl(record.quote, true) : null
      } : null;
    });
    return out;
  }

  /* The mark for a logo slug that a caller already holds — a search result and a
     news story both arrive carrying one. */
  logoUrl(slug) {
    return this.embeds.logoUrl(slug, true);
  }

  /* ---------- news ---------- */

  /* Every picture is registered with the loopback server on its way out. The
     interface receives an address it is allowed to load; the publisher's own
     address never reaches the page, so nothing on screen can make a request to a
     publisher's server. */
  publishArtwork(items) {
    return (items || []).map(item => {
      const artwork = item.image ? this.embeds.publishImage(item.image) : null;
      return Object.assign({}, item, { image: artwork, imageSource: item.image ? http.hostOf(item.image) : null });
    });
  }

  async newsFront(options) {
    const opts = options || {};
    const result = await this.engine.marketNews({ feeds: opts.feeds, limit: opts.limit || 120 });
    return Object.assign({}, result, { items: this.publishArtwork(result.items) });
  }

  async newsForSymbol(symbol, options) {
    const result = await this.engine.newsFor(symbol, options);
    return Object.assign({}, result, { items: this.publishArtwork(result.items) });
  }

  async newsSearch(query, options) {
    const result = await worldnews.search(query, options);
    return Object.assign({}, result, { items: this.publishArtwork(result.items) });
  }

  async newsArticle(url) {
    const article = await worldnews.read(url);
    return Object.assign({}, article, {
      image: article.image ? this.embeds.publishImage(article.image) : null
    });
  }

  /* ---------- screening ---------- */

  /* The scanner returns a logo slug with every row. It is turned into a
     loopback address here rather than in the interface, because the interface
     has no business composing addresses for the proxy — the token is not
     something it should be able to build with. */
  async screen(request) {
    const result = await this.engine.screen(request);
    return Object.assign({}, result, {
      rows: result.rows.map(row => Object.assign({}, row, {
        logo: row.logoid ? this.embeds.logoUrl(row.logoid, true) : null
      }))
    });
  }

  /* ---------- search ---------- */

  /* A search match already carries the vendor's own logo slug, from the same
     call that found it — the slug is not an address the renderer's content
     policy allows it to fetch directly, so it is turned into a loopback one
     here, the same way a screener row's is. A match that came only from the
     venue's own search, with nothing from the vendor, has none; the
     interface's own market:logos round trip is what finds one for those. */
  async search(query, options) {
    const result = await this.engine.search(query, options);
    return (result || []).map(match => Object.assign({}, match, {
      logo: match.logo ? this.embeds.logoUrl(match.logo, true) : null
    }));
  }

  /* ---------- attachments ---------- */

  addUpload(file) { return this.uploads.add(file); }
  listUploads() { return this.uploads.list(); }
  removeUpload(id) { return this.uploads.remove(id); }

  /* ---------- health ---------- */

  /* WHEN THE SOURCE AND THE SCREEN DISAGREE, THE FIRST QUESTION IS WHICH BUILD
     IS ON THE SCREEN — and until this existed there was no way to answer it.
     The stamp is the newest modification time across the code the window
     actually loads, so a window opened before an edit reports an older stamp
     than the files on disk. Cheap to compute once at start-up, and it turns
     "nothing changed" from an argument into a comparison. */
  /* The newest edit on disk right now, ignoring what was current at start-up.
     Compared against the stamp the window was built from, this is how a stale
     window finds out it is stale. */
  buildOnDisk() {
    const held = this._build;
    this._build = null;
    const now = this.buildStamp();
    this._build = held || now;
    return now;
  }

  buildStamp() {
    if (this._build) return this._build;
    const fs = require('fs');
    const root = path.join(__dirname, '..');
    let newest = 0;
    const walk = dir => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      entries.forEach(entry => {
        if (entry.name === 'node_modules' || entry.name === 'data' || entry.name === 'logs') return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); return; }
        if (!/\.(js|css|html)$/.test(entry.name)) return;
        try {
          const at = fs.statSync(full).mtimeMs;
          if (at > newest) newest = at;
        } catch (e) { /* vanished mid-walk */ }
      });
    };
    ['web', 'src', 'main'].forEach(part => walk(path.join(root, part)));
    this._build = newest || Date.now();
    return this._build;
  }

  info() {
    return {
      name: brand.name,
      credit: brand.credit,
      author: brand.author,
      attribution: brand.attribution,
      version: require('../package.json').version,
      dataDir: paths.root(),
      builtAt: this.buildStamp(),
      startedAt: this.startedAt || Date.now()
    };
  }

  health() {
    return {
      market: this.engine.health(),
      http: http.snapshot(),
      /* Named rather than implied: the interface shows which enhanced features
         are unavailable when no market session could be established, instead of
         silently rendering empty panels. */
      sessionGated: {
        available: yahoo.haveSession(),
        affects: ['bid and ask', 'option chains', 'fundamentals']
      }
    };
  }

  async shutdown() {
    this.engine.stop();
    this.embeds.stop();
    this.audit.write('app.stopping', {});
    await Promise.all(Object.values(this.stores).map(s => s.flush()));
  }
}

module.exports = { Services, sanitiseConfig };
