'use strict';
/* The market data engine.
 *
 * Everything above this layer — charts, watchlists, alerts, analysis, the
 * research assistant — asks the engine and never a provider. That indirection
 * is the point: providers get replaced, rate-limited and broken, and none of
 * that should reach a panel.
 *
 * The engine owns four things no adapter can own on its own:
 *
 *   ROUTING. Which source answers for this symbol, and which second source is
 *   worth asking for a cross-check.
 *
 *   COALESCING. Ten panels showing the same instrument make one request.
 *
 *   FRESHNESS. Every figure leaves here with a state derived from the venue's
 *   own timestamp and the provider's own latency disclosure.
 *
 *   INTEGRITY. Every figure is checked before it is published, and a figure
 *   that fails a blocking check trips the safe-data switch.
 *
 * ONE RULE ABOUT NOTIFICATIONS, LEARNED EXPENSIVELY ELSEWHERE: a subscriber is
 * only notified when data actually arrived from the network. Firing on a cache
 * hit lets a render trigger a fetch that resolves instantly and re-renders,
 * which recurses synchronously and hangs the interface with no error.
 */

const yahoo = require('./providers/yahoo');
const cboe = require('./providers/cboe');
const binance = require('./providers/binance');
const news = require('./providers/news');
const sec = require('./providers/sec');
const tradingview = require('./providers/tradingview');
const freshness = require('./freshness');
const integrity = require('./integrity');
const instrument = require('./instrument');
const candles = require('./candles');
const clock = require('../core/clock');
const { CLASS } = require('../core/num');

/* Poll cadence by session state. A closed market does not need a request every
   twenty seconds — the price is not going to change — and spending the request
   budget there is what causes rate limiting when it is needed. */
/* Adapters by name. The engine routes by capability rather than by this table,
   but a published figure carries its provider's name in its provenance and has
   to be able to find its way back to the adapter. */
const REGISTRY = {
  [yahoo.name]: yahoo,
  [cboe.name]: cboe,
  [binance.name]: binance
};

const CADENCE = {
  OPEN: 20000,
  PRE: 60000,
  POST: 60000,
  CLOSED: 15 * 60 * 1000,
  UNKNOWN: 60000
};

/* How often bid/ask and the extended print are asked for again, independent
   of how often the price itself is due — see enhanceLater(). */
const ENHANCE_CADENCE = 45000;

/* ---------- reading the summary endpoint ----------
 *
 * Upstream returns most numbers as { raw, fmt } and some as bare values, and a
 * field that has no value at all can arrive as null, as an empty object, or not
 * at all. These three readers are the only place that shape is understood.
 *
 * `fmt` IS NEVER READ. It is a pre-formatted string in the provider's own
 * locale and rounding — "1.23T", "45.6%" — and letting one through would put a
 * figure on screen that this application's own formatter never saw and whose
 * precision it cannot state. Everything is taken from `raw` and formatted here.
 */

function pickNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'object' && value.raw != null) {
    const raw = Number(value.raw);
    return Number.isFinite(raw) ? raw : null;
  }
  return null;
}

function pickText(value) {
  return typeof value === 'string' ? (value.trim() || null) : null;
}

/* Seconds since the epoch, which is what this endpoint publishes, unless the
   value is already in milliseconds. The threshold is far past any plausible
   seconds value and far below any plausible milliseconds one. */
function pickDate(value) {
  const raw = pickNumber(value);
  if (raw == null || raw <= 0) return null;
  return raw > 1e11 ? raw : raw * 1000;
}

function firstDate(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return pickDate(list[0]);
}

/* ---------- reading filed observations ----------
 *
 * WHICH PERIOD A FILED FIGURE COVERS IS NOT WHAT `fy` AND `fp` SAY. Those name
 * the report the fact appeared in, and a 10-K carries two prior years of
 * comparatives, so one fiscal year label is attached to three different
 * revenues. Pairing two concepts on that label — or worse, by position in two
 * lists of different lengths — puts one year's revenue beside another year's
 * profit. That is not a rounding error: read together they produced a profit
 * margin of four hundred per cent, from two figures that were each individually
 * correct.
 *
 * The period a figure covers is its own start and end. Everything below keys on
 * those, and a figure with no matching period is null rather than the nearest
 * one to hand. */

/* The reference vendor's own vocabulary for what an instrument is, mapped onto
   this application's. Its `typespecs` distinguish a common share from a
   preferred one and a spot pair from a perpetual; only the distinctions that
   change how a figure is formatted are carried across. */
function assetClassOfVendorType(type, specs) {
  const kind = String(type || '').toLowerCase();
  const tags = Array.isArray(specs) ? specs : [];
  if (kind === 'stock' || kind === 'dr') return CLASS.EQUITY;
  if (kind === 'fund' || kind === 'structured') return CLASS.ETF;
  if (kind === 'index') return CLASS.INDEX;
  if (kind === 'futures') return CLASS.FUTURE;
  if (kind === 'forex') return CLASS.CURRENCY;
  if (kind === 'bond') return CLASS.BOND;
  if (kind === 'spot' || tags.indexOf('crypto') !== -1) return CLASS.CRYPTO;
  if (kind === 'economic') return CLASS.UNKNOWN;
  return CLASS.UNKNOWN;
}

const ANNUAL_MIN_DAYS = 300;
const QUARTER_MIN_DAYS = 60;

function periodKind(row) {
  if (!row || !row.periodEnd) return null;
  /* A balance-sheet figure is measured at a moment, not over a span, and
     arrives with no start date at all. */
  if (!row.periodStart) return 'instant';
  const end = Date.parse(row.periodEnd);
  const start = Date.parse(row.periodStart);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  const days = Math.round((end - start) / 86400000);
  if (days >= ANNUAL_MIN_DAYS) return 'annual';
  if (days >= QUARTER_MIN_DAYS) return 'quarterly';
  return 'other';
}

/* Newest first by the date the period actually ended, one row per period.
 *
 * The same year arrives more than once: a financial year appears in its own
 * annual report and again as a comparative in each of the two after it. They
 * are the same period, and listing it three times makes a five-year history
 * read as fifteen. The most recently filed wins, because a figure gets
 * restated. */
function byPeriodEnd(rows, kind) {
  const best = new Map();
  (rows || []).forEach(row => {
    if (periodKind(row) !== kind) return;
    const held = best.get(row.periodEnd);
    if (!held || String(row.filedAt) > String(held.filedAt)) best.set(row.periodEnd, row);
  });
  return Array.from(best.values())
    .sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : (a.periodEnd > b.periodEnd ? -1 : 0)));
}

/* The value one concept reported for exactly the period another concept did.
   No nearest match and no fallback: a margin is only a margin when its two
   inputs cover the same weeks. */
function valueForPeriod(rows, kind, periodEnd) {
  if (!periodEnd) return null;
  const match = (rows || []).find(row => row.periodEnd === periodEnd && periodKind(row) === kind);
  return match ? match.value : null;
}

/* How far before a financial year end a balance-sheet date may sit and still be
   that year's balance sheet. A filer's year end and its balance-sheet date are
   the same day; the tolerance only absorbs a filer that dates one a few days
   earlier. */
const BALANCE_SHEET_TOLERANCE_DAYS = 45;

/* A balance-sheet figure as at the end of a given period.
 *
 * RETURNS NOTHING RATHER THAN THE NEAREST ONE TO HAND. Falling back to the most
 * recent instant is what produced a return on equity of five per cent from a
 * profit filed for one year and an equity balance from four years later. If
 * this company's filings do not carry the balance at that date, the ratios
 * resting on it are not available, and the panel shows them as unavailable. */
function instantAsOf(rows, periodEnd) {
  const instants = byPeriodEnd(rows, 'instant');
  if (!instants.length) return null;
  if (!periodEnd) return instants[0];

  const end = Date.parse(periodEnd);
  if (!Number.isFinite(end)) return null;

  const limit = BALANCE_SHEET_TOLERANCE_DAYS * 86400000;
  return instants.find(row => {
    const at = Date.parse(row.periodEnd);
    return Number.isFinite(at) && at <= end && (end - at) <= limit;
  }) || null;
}

class Engine {
  constructor(options) {
    const opts = options || {};
    this.store = opts.store || null;          // candle and quote persistence
    this.audit = opts.audit || null;
    this.safeMode = opts.safeMode || new integrity.SafeMode({ audit: this.audit });

    this.quotes = new Map();       // SYMBOL -> instrument model with freshness
    this.previous = new Map();     // SYMBOL -> last published quote, for move checks
    this.sources = new Map();      // SYMBOL -> [provenance records]
    this.subscribers = new Map();  // SYMBOL -> count
    this.inFlight = new Map();     // key -> promise
    this.lastEnhancedAt = new Map();   // SYMBOL -> when bid/ask/extended was last asked for
    this.listeners = [];
    this.timer = null;
    this.lastCycleAt = 0;
    this.cycleErrors = [];
  }

  /* ---------- routing ---------- */

  /* Every adapter by name, so a published figure can be traced back to the
     source that supplied it and that source asked what it claims about its own
     latency. Without this lookup the freshness layer never sees a provider's
     real-time declaration and renders a genuinely live feed as delayed. */
  providerByName(name) {
    return REGISTRY[name] || null;
  }

  /* Which adapter answers for this symbol.
   *
   * Crypto goes to the exchange because it is the only source here that
   * publishes real-time by its own declaration, plus funding, open interest and
   * a trade tape. Everything else goes to the broad source. */
  primaryFor(symbol) {
    const sym = instrument.normaliseSymbol(symbol);
    if (!sym) return null;
    if (binance.supports(sym)) return binance;
    return yahoo;
  }

  /* An independent source worth asking for the same figure, or null. */
  secondaryFor(symbol, assetClass) {
    const sym = instrument.normaliseSymbol(symbol);
    if (!sym) return null;
    if ((assetClass === CLASS.EQUITY || assetClass === CLASS.ETF) && cboe.supports(sym)) return cboe;
    return null;
  }

  /* ---------- subscriptions ---------- */

  subscribe(symbols) {
    const list = (Array.isArray(symbols) ? symbols : [symbols]).map(instrument.normaliseSymbol).filter(Boolean);
    list.forEach(sym => this.subscribers.set(sym, (this.subscribers.get(sym) || 0) + 1));
    if (list.length) this.start();
    return () => this.unsubscribe(list);
  }

  unsubscribe(symbols) {
    const list = (Array.isArray(symbols) ? symbols : [symbols]).map(instrument.normaliseSymbol).filter(Boolean);
    list.forEach(sym => {
      const count = (this.subscribers.get(sym) || 1) - 1;
      if (count <= 0) this.subscribers.delete(sym);
      else this.subscribers.set(sym, count);
    });
    if (!this.subscribers.size) this.stop();
  }

  subscribed() {
    return Array.from(this.subscribers.keys());
  }

  /* ---------- the poll loop ---------- */

  start() {
    if (this.timer) return;
    /* An immediate first pass, then scheduling. Waiting a full cadence before
       the first request leaves the interface empty for twenty seconds. */
    this.cycle().catch(() => {});
    this.timer = setInterval(() => { this.cycle().catch(() => {}); }, 5000);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /* The cadence a given symbol is due on, from its own session. */
  dueCadence(symbol) {
    const model = this.quotes.get(symbol);
    if (!model) return CADENCE.OPEN;
    if (model.continuous) return CADENCE.OPEN;
    const status = clock.statusAt(model.session);
    return CADENCE[status] || CADENCE.UNKNOWN;
  }

  /* One pass over everything subscribed, refreshing only what is due. */
  async cycle() {
    const now = Date.now();
    const due = this.subscribed().filter(sym => {
      const model = this.quotes.get(sym);
      if (!model || !model.fetchedAt) return true;
      return now - model.fetchedAt >= this.dueCadence(sym);
    });
    if (!due.length) return;

    this.lastCycleAt = now;
    const byProvider = new Map();
    due.forEach(sym => {
      const provider = this.primaryFor(sym);
      if (!provider) return;
      if (!byProvider.has(provider.name)) byProvider.set(provider.name, { provider, symbols: [] });
      byProvider.get(provider.name).symbols.push(sym);
    });

    const findings = [];
    const updated = [];
    this.cycleErrors = [];

    for (const { provider, symbols } of byProvider.values()) {
      try {
        const models = provider.quotes
          ? await provider.quotes(symbols)
          : await Promise.all(symbols.map(s => provider.quote(s))).then(r => r.filter(Boolean));

        models.forEach(model => {
          const published = this.publish(model, findings);
          if (published) updated.push(published);
        });

        /* Bid, ask and the extended print arrive as a second, later update,
           never awaited here. This request and the one above share Yahoo's
           own per-host politeness queue — awaiting it would make the price
           feed everything on screen depends on only as fast as the
           session-gated endpoint, which can be refused for minutes at a
           time, rather than as fast as the open one has always been. */
        if (provider.quoteDetail) this.enhanceLater(provider, symbols);
      } catch (err) {
        this.cycleErrors.push({ provider: provider.name, message: err.message, kind: err.kind || 'error' });
      }
    }

    /* A provider that stopped answering entirely is a fault, not a slow poll.
       One failing chunk inside an adapter is already handled there; reaching
       here means the whole call threw. */
    if (this.cycleErrors.length && !updated.length && due.length) {
      this.safeMode.fault('provider.silent',
        'No source answered for ' + due.length + ' subscribed instrument' + (due.length === 1 ? '' : 's') + '. ' +
        this.cycleErrors.map(e => e.provider + ': ' + e.message).join(' '),
        { providers: this.cycleErrors.map(e => e.provider) });
    } else {
      this.safeMode.observe(findings);
    }

    if (updated.length) this.emit(updated);
  }

  /* Bid, ask and the extended print change far less often than the price
   * does and share Yahoo's own per-host politeness queue with it, so asking
   * for them every cycle would spend that queue's single slot on the
   * session-gated endpoint as often as the open one — the price feed would
   * only ever be as fast as whichever of the two answered slower. Each
   * symbol is due again roughly every ENHANCE_CADENCE regardless of how
   * often its price itself polls.
   *
   * Reads and republishes from this.quotes — what is actually on screen
   * right now — rather than the transient array one cycle built, and is
   * never awaited by cycle(): the fetch, the merge and the republish all
   * happen after the poll loop that triggered it has already returned. */
  enhanceLater(provider, symbols) {
    const now = Date.now();
    const due = symbols.filter(sym => now - (this.lastEnhancedAt.get(sym) || 0) >= ENHANCE_CADENCE);
    if (!due.length) return;
    due.forEach(sym => this.lastEnhancedAt.set(sym, now));

    const models = due.map(sym => this.quotes.get(sym)).filter(Boolean);
    if (!models.length) return;

    this.enhance(provider, due, models).then(() => {
      const findings = [];
      const updated = [];
      models.forEach(model => {
        const published = this.publish(model, findings);
        if (published) updated.push(published);
      });
      this.safeMode.observe(findings);
      if (updated.length) this.emit(updated);
    }).catch(() => {});
  }

  /* Bid, ask, market state and a pre/post-market print, from the same
   * session-gated endpoint that supplies the venue's own delay disclosure.
   *
   * ITS ABSENCE MUST NEVER WITHHOLD THE BASE QUOTE. The session behind it can
   * be refused for hours; a failure here is swallowed so the price, the chart
   * and everything derived from them keep working exactly as they did before
   * this existed. Only bid/ask and the extended print are lost, and they were
   * never available on this path to begin with. */
  async enhance(provider, symbols, models) {
    let details;
    try {
      details = await provider.quoteDetail(symbols);
    } catch (err) {
      return;
    }
    const bySymbol = new Map(details.map(d => [d.symbol, d]));
    models.forEach(model => {
      const detail = bySymbol.get(model.symbol);
      if (!detail || !model.quote) return;
      model.quote.bid = detail.bid;
      model.quote.ask = detail.ask;
      model.quote.bidSize = detail.bidSize;
      model.quote.askSize = detail.askSize;
      model.quote.extended = detail.extended;
      model.marketState = detail.marketState;
      /* Per-symbol, from the venue itself — more specific than the adapter's
         blanket coverage() claim, which publish() falls back to when this
         path could not be reached at all. */
      model.delaySeconds = detail.delaySeconds;
      model.realtime = detail.realtime;
    });
  }

  /* Validate, stamp with freshness, store and return — or reject.
   *
   * A model that fails a blocking check is NOT published. Showing a figure that
   * has just been judged impossible, even with a warning badge beside it, means
   * the number is on screen and can be read off. The previous good figure stays
   * with its own timestamp, which visibly ages, and the reason appears in the
   * safe-data banner. */
  publish(model, findings) {
    if (!model || !model.symbol) return null;

    const checks = integrity.checkQuote(model);
    const previous = this.previous.get(model.symbol);
    if (previous) {
      checks.push(...integrity.checkMove(
        { last: previous.quote.last, at: previous.quote.at, symbol: model.symbol },
        { last: model.quote.last, at: model.quote.at, symbol: model.symbol, assetClass: model.assetClass }
      ));
    }
    if (findings) findings.push(...checks);

    if (checks.some(f => f.severity === integrity.SEVERITY.BLOCK)) {
      const existing = this.quotes.get(model.symbol);
      if (existing) existing.rejected = checks.filter(f => f.severity === integrity.SEVERITY.BLOCK);
      return null;
    }

    /* Latency comes from the adapter that actually supplied the figure, not
       from a default. A per-symbol disclosure on the model — which only the
       session-gated quote endpoint provides — overrides the adapter's blanket
       statement, because it is the more specific fact. */
    const source = model.provenance && this.providerByName(model.provenance.provider);
    const cover = source && source.coverage ? source.coverage(model.exchange) : { realtime: null, delaySeconds: null };
    const delaySeconds = model.delaySeconds == null ? cover.delaySeconds : model.delaySeconds;
    const realtime = model.realtime == null ? cover.realtime : model.realtime;

    const state = freshness.assess({
      at: model.quote.at,
      session: model.session,
      continuous: model.continuous,
      cadence: this.dueCadence(model.symbol),
      delaySeconds,
      realtime,
      tz: model.session && model.session.tz
    });

    /* The extended print gets its own freshness, assessed as what it is — a
       figure from the pre- or post-market session, not the regular one — so
       a chart or a badge reading it can tell a live one from a leftover
       without duplicating the rule that tells them apart. */
    if (model.quote.extended) {
      model.quote.extended.freshness = freshness.assess({
        at: model.quote.extended.at,
        session: model.session,
        continuous: model.continuous,
        cadence: this.dueCadence(model.symbol),
        delaySeconds,
        realtime,
        extendedFigure: true,
        tz: model.session && model.session.tz
      });
    }

    const published = Object.assign({}, model, {
      freshness: state,
      warnings: checks.filter(f => f.severity === integrity.SEVERITY.WARN),
      fetchedAt: Date.now(),
      rejected: null
    });

    this.quotes.set(model.symbol, published);
    this.previous.set(model.symbol, published);
    this.rememberSource(model.symbol, model.provenance);
    return published;
  }

  /* ---------- direct reads ---------- */

  /* The current figure without triggering a fetch.
   *
   * Deliberately returns a stale model rather than nothing, so that rendering
   * never causes a request. A panel that fetches while painting is a panel that
   * repaints while fetching. */
  peek(symbol) {
    return this.quotes.get(instrument.normaliseSymbol(symbol)) || null;
  }

  async quote(symbol, options) {
    const sym = instrument.normaliseSymbol(symbol);
    if (!sym) throw new Error('Not a usable symbol: ' + symbol);

    const opts = options || {};
    const cached = this.quotes.get(sym);
    if (cached && !opts.force && Date.now() - cached.fetchedAt < this.dueCadence(sym)) return cached;

    return this.once('quote:' + sym, async () => {
      const provider = this.primaryFor(sym);
      const model = provider.quotes
        ? (await provider.quotes([sym]))[0]
        : await provider.quote(sym);
      if (!model) throw new Error('No source could resolve ' + sym + '.');

      const findings = [];
      const published = this.publish(model, findings);
      this.safeMode.observe(findings);
      if (!published) {
        throw new Error('The figure received for ' + sym + ' failed an integrity check and was not accepted.');
      }
      this.emit([published]);
      return published;
    });
  }

  /* Which bar sizes a source publishes itself. A provider that declares none is
     assumed to serve whatever it is asked for and to say so if it cannot. */
  nativeIntervals(provider) {
    const declared = provider && provider.INTERVALS;
    if (Array.isArray(declared)) return declared.slice();
    if (declared && typeof declared === 'object') return Object.keys(declared);
    return [];
  }

  /* Which bar sizes are available for an instrument, and where each one comes
     from. The interface asks this rather than holding its own table, because
     the answer depends on which source routes the symbol: a crypto venue
     publishes one-second bars and an equity source does not, and offering a
     control that cannot work is worse than not offering it. */
  intervalsFor(symbol) {
    const sym = instrument.normaliseSymbol(symbol);
    const provider = sym ? this.primaryFor(sym) : null;
    const native = this.nativeIntervals(provider);
    const nativeMs = native
      .map(name => ({ name, ms: candles.timeframeMs(name) }))
      .filter(entry => entry.ms);

    return Object.keys(candles.TIMEFRAMES).map(name => {
      if (native.indexOf(name) !== -1) {
        return { name, available: true, source: 'native', provider: provider && provider.label };
      }
      const target = candles.timeframeMs(name);
      const finer = target ? nativeMs.filter(entry => entry.ms < target).sort((a, b) => b.ms - a.ms)[0] : null;
      if (finer) return { name, available: true, source: 'derived', from: finer.name, provider: provider && provider.label };
      return {
        name, available: false,
        reason: (provider ? provider.label : 'This source') + ' does not publish ' + name +
          ' bars for this instrument, and a finer series cannot be built from a coarser one.'
      };
    });
  }

  /* Bars, with the served timeframe reported rather than the requested one. */
  async chart(symbol, options) {
    const sym = instrument.normaliseSymbol(symbol);
    if (!sym) throw new Error('Not a usable symbol: ' + symbol);
    const opts = options || {};
    const key = 'chart:' + sym + ':' + (opts.range || '') + ':' + (opts.interval || '') + ':' + (opts.from || '') + ':' + (opts.to || '');

    return this.once(key, async () => {
      const provider = this.primaryFor(sym);

      /* An interval the source does not publish is built from the coarsest one
         it does publish that is still finer than the target — coarsest, so the
         fewest bars are merged and the least is thrown away. */
      let request = opts;
      let derive = null;
      if (opts.interval && this.nativeIntervals(provider).indexOf(opts.interval) === -1) {
        const plan = this.intervalsFor(sym).find(entry => entry.name === opts.interval);
        if (!plan) throw new Error(opts.interval + ' is not a bar size this application knows.');
        if (!plan.available) throw new Error(plan.reason);
        request = Object.assign({}, opts, { interval: plan.from });
        derive = { from: plan.from, to: opts.interval };
      }

      const result = await provider.chart(sym, request);

      if (derive) {
        const servedMs = candles.timeframeMs(result.timeframe);
        const targetMs = candles.timeframeMs(derive.to);
        if (servedMs && targetMs && servedMs < targetMs) {
          result.bars = candles.resample(result.bars, derive.to, result.timeframe);
          result.derivedFrom = result.timeframe;
          result.timeframe = derive.to;
          result.requestedTimeframe = derive.to;
          result.coarsened = false;
        } else {
          /* The source answered a request for one-minute bars with daily ones,
             which it is entitled to do for a long range. Merging those up to
             the target would be a lie about their resolution, so what was
             served is shown and the difference is reported. */
          result.requestedTimeframe = derive.to;
          result.coarsened = result.timeframe !== derive.to;
        }
      }

      if (result.instrument) {
        const findings = [];
        this.publish(result.instrument, findings);
        this.safeMode.observe(findings);
      }
      this.rememberSource(sym, result.provenance);

      /* History is persisted so a relaunch draws immediately rather than
         staring at an empty chart while a request goes out. */
      if (this.store && result.bars.length) {
        const storeKey = instrument.key(sym, result.timeframe);
        const existing = this.store.doc(storeKey, null);
        const merged = candles.apply(existing && existing.bars, result.bars);
        this.store.putDoc(storeKey, { symbol: sym, timeframe: result.timeframe, bars: merged, at: Date.now() });
      }

      return result;
    });
  }

  /* Bars held from a previous session, for an instant first paint. Always
     labelled historical, because they are. */
  storedChart(symbol, timeframe) {
    if (!this.store) return null;
    const held = this.store.doc(instrument.key(instrument.normaliseSymbol(symbol), timeframe), null);
    if (!held || !held.bars || !held.bars.length) return null;
    return {
      symbol: held.symbol,
      bars: held.bars,
      timeframe: held.timeframe,
      stored: true,
      storedAt: held.at,
      freshness: freshness.assess({ at: held.at, historical: true })
    };
  }

  /* Ask an independent source for the same figure and report any difference.
     Used by the sources drawer and by anything that is about to act on a
     price. */
  async verify(symbol) {
    const sym = instrument.normaliseSymbol(symbol);
    const model = this.quotes.get(sym);
    if (!model) return { symbol: sym, checked: false, reason: 'No figure is loaded for this instrument.' };

    const secondary = this.secondaryFor(sym, model.assetClass);
    if (!secondary) {
      return {
        symbol: sym, checked: false,
        reason: 'No independent source available for this instrument. ' +
          'The figure comes from ' + model.provenance.providerLabel + ' alone.'
      };
    }

    const other = await secondary.quote(sym);
    if (!other) {
      return { symbol: sym, checked: false, reason: secondary.label + ' did not answer.' };
    }

    const findings = integrity.crossCheck(
      { last: model.quote.last, symbol: sym, provider: model.provenance.provider },
      { last: other.last, symbol: sym, provider: secondary.name }
    );
    this.safeMode.observe(findings);
    this.rememberSource(sym, other.provenance);

    return {
      symbol: sym,
      checked: true,
      primary: { value: model.quote.last, source: model.provenance.providerLabel, at: model.quote.at },
      secondary: { value: other.last, source: secondary.label, at: other.at },
      agree: !findings.length,
      findings
    };
  }

  /* Instrument search across every listed market in the world.
   *
   * TWO SOURCES, AND THEY ANSWER DIFFERENT QUESTIONS. The price venue's own
   * search knows exactly which symbols this application can quote, and it is
   * narrow: a company listed only in Mumbai or Kuala Lumpur is often not in it,
   * and it publishes no company mark. The vendor's scanner covers every listing
   * on every exchange it carries, with the exchange, the country, the currency
   * and the company's own logo — and some of what it returns cannot be priced
   * here at all.
   *
   * So both are asked and the results are merged on the venue symbol. An entry
   * that only the vendor knows about is kept and marked: it can be charted and
   * researched, and the interface says plainly that there is no quote for it
   * rather than showing a row that will never tick.
   *
   * A failure on either side is not a failure of the search. The scanner is an
   * undocumented service and the venue search rate limits; whichever answered
   * is what is shown. */
  async search(query, options) {
    const opts = options || {};
    const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 60);

    const [venue, vendor] = await Promise.all([
      opts.scope && opts.scope !== 'all'
        ? Promise.resolve([])
        : yahoo.search(query, { limit }).catch(() => []),
      tradingview.search(query, { limit, scope: opts.scope }).catch(() => null)
    ]);

    /* THE VENUE'S OWN MATCHES GO IN FIRST, AND THE ORDER IS THE WHOLE POINT.
     *
     * Both lists are relevance-ranked by whoever produced them, and the merged
     * list is cut to the number of rows that fit. Filling it with the vendor's
     * matches first meant a search for an index returned twenty-four funds
     * tracking it — every one a genuine match — and pushed the index itself off
     * the end, where the venue had it at the top. The venue also only knows
     * instruments this application can actually price, which is what somebody
     * searching for something to look at wants first. */
    const merged = new Map();

    (venue || []).forEach(match => {
      merged.set(match.symbol, {
        symbol: match.symbol,
        tvSymbol: null,
        name: match.name,
        exchange: match.exchange,
        exchangeName: match.exchangeName,
        country: null,
        currency: null,
        assetClass: match.assetClass,
        vendorType: null,
        last: null, changePercent: null, marketCap: null,
        logo: null,
        quotable: true
      });
    });

    (vendor ? vendor.matches : []).forEach(match => {
      const symbol = tradingview.toVenue(match.tvSymbol);
      const key = symbol || match.tvSymbol;

      const held = symbol ? merged.get(symbol) : null;
      if (held) {
        /* The venue decided what this instrument IS — every price, format and
           session decision downstream is made from that. The vendor fills in
           what the venue does not publish: the exchange, the country, the
           currency and the company's own mark. */
        held.tvSymbol = match.tvSymbol;
        held.logo = match.logo;
        held.country = match.country;
        held.currency = match.currency;
        held.last = match.last;
        held.changePercent = match.changePercent;
        held.marketCap = match.marketCap;
        held.vendorType = match.type;
        held.exchange = held.exchange || match.exchange;
        held.name = held.name || match.name;
        return;
      }

      merged.set(key, {
        symbol,
        tvSymbol: match.tvSymbol,
        name: match.name,
        exchange: match.exchange,
        exchangeName: match.exchange,
        country: match.country,
        currency: match.currency,
        assetClass: assetClassOfVendorType(match.type, match.typeSpecs),
        vendorType: match.type,
        last: match.last,
        changePercent: match.changePercent,
        marketCap: match.marketCap,
        logo: match.logo,
        /* Stated rather than implied. A row with no venue symbol will never
           carry a price in this application, and hiding that produces a
           watchlist entry that is permanently blank. */
        quotable: !!symbol
      });
    });

    return Array.from(merged.values()).slice(0, limit);
  }

  /* The vendor's exchange-qualified name for an instrument, which every embedded
     widget is addressed by. Null where the translation is not certain. */
  async vendorSymbol(symbol) {
    const sym = instrument.normaliseSymbol(symbol);
    if (!sym) return null;
    return this.once('tv:resolve:' + sym, () => tradingview.resolve(sym).catch(() => null));
  }

  /* Reference figures no free source published before this: the analyst
     consensus and price targets, the technical summary, sector membership,
     performance over every window and the next reporting date. Reported as
     absent rather than substituted when the service does not answer. */
  async reference(symbol) {
    const sym = instrument.normaliseSymbol(symbol);
    if (!sym) throw new Error('Not a usable symbol: ' + symbol);

    return this.once('tv:reference:' + sym, async () => {
      const tvSymbol = await this.vendorSymbol(sym);
      if (!tvSymbol) {
        return {
          symbol: sym, tvSymbol: null, available: false,
          reason: 'This instrument could not be matched to a listing at the reference vendor, ' +
            'so its consensus, sector and performance figures are unavailable.'
        };
      }
      const found = await tradingview.detail(tvSymbol);
      (found.sources || []).forEach(record => this.rememberSource(sym, record));
      return Object.assign({ symbol: sym, available: true }, found);
    });
  }

  async peers(symbol, options) {
    const tvSymbol = await this.vendorSymbol(symbol);
    if (!tvSymbol) return { peers: [], reason: 'No listing was matched for this instrument.' };
    return this.once('tv:peers:' + tvSymbol, () => tradingview.peers(tvSymbol, options));
  }

  async sectors(region) {
    return this.once('tv:sectors:' + (region || 'america'), () => tradingview.sectorPerformance(region));
  }

  async screen(request) {
    return tradingview.screen(request);
  }

  /* The vendor's slug for a company's mark. Held for the life of the process
     because a logo does not change and the lookup behind it is a real request. */
  async logoSlug(symbol) {
    const found = await this.logosFor([symbol]);
    const entry = found[instrument.normaliseSymbol(symbol)];
    return entry ? entry.logo : null;
  }

  /* Marks for a whole screen's worth of instruments in one request.
   *
   * A LOGO IS ONLY EVER CACHED FROM AN ANSWER THE VENDOR ACTUALLY GAVE. The
   * batch request below can fail outright — one dropped connection, one
   * timeout on the scanner's own severely-throttled queue — and that used to
   * be indistinguishable from "the vendor was asked and has no mark for
   * this": every symbol in the batch was cached with logo: null, for the
   * life of the process, with no way back short of restarting. A single bad
   * request at boot, when this is usually first called, blanked every
   * company mark on screen to initials for the rest of the session. Now a
   * failed batch caches nothing at all, so the next call — the next time
   * the watchlist repaints, the next instrument opened — tries again. */
  async logosFor(symbols) {
    const wanted = (symbols || []).map(s => instrument.normaliseSymbol(s)).filter(Boolean);
    if (!wanted.length) return {};

    const pairs = await Promise.all(wanted.map(async symbol => {
      if (this.logoCache && this.logoCache.has(symbol)) return [symbol, this.logoCache.get(symbol)];
      const tvSymbol = await this.vendorSymbol(symbol).catch(() => null);
      return [symbol, tvSymbol ? { tvSymbol } : null];
    }));

    if (!this.logoCache) this.logoCache = new Map();

    const toFetch = pairs.filter(([, value]) => value && value.tvSymbol && value.logo === undefined);
    let found = {};
    let fetchFailed = false;
    if (toFetch.length) {
      try {
        found = await tradingview.logos(toFetch.map(([, value]) => value.tvSymbol));
      } catch (err) {
        fetchFailed = true;
      }
    }

    const out = {};
    pairs.forEach(([symbol, value]) => {
      if (!value) { out[symbol] = null; return; }
      if (value.logo !== undefined) { out[symbol] = value; return; }
      if (fetchFailed) {
        /* Answered for this call so the caller has something to paint, but
           deliberately not cached — the question was never actually put to
           the vendor. */
        out[symbol] = { tvSymbol: value.tvSymbol, logo: null, base: null, quote: null };
        return;
      }
      const marks = found[value.tvSymbol];
      const record = {
        tvSymbol: value.tvSymbol,
        logo: marks ? marks.logo : null,
        base: marks ? marks.base : null,
        quote: marks ? marks.quote : null
      };
      this.logoCache.set(symbol, record);
      out[symbol] = record;
    });

    return out;
  }

  /* ---------- news ---------- */

  /* Routed through the engine like everything else, so headlines are coalesced
     across panels and their feeds are recorded in the same provenance list the
     sources drawer reads. */
  async newsFor(symbol, options) {
    const sym = instrument.normaliseSymbol(symbol);
    if (!sym) throw new Error('Not a usable symbol: ' + symbol);
    return this.once('news:' + sym, async () => {
      const result = await news.forSymbol(sym, options);
      (result.sources || []).forEach(record => this.rememberSource(sym, record));
      return result;
    });
  }

  async marketNews(options) {
    const opts = options || {};
    return this.once('news:market:' + ((opts.feeds || []).join(',')), () => news.market(opts));
  }

  /* ---------- company reference data ---------- */

  /* What a research panel needs: the business, its valuation, what it earns,
     what analysts have published about it, and when it next reports.
   *
   * THE PROVIDER'S SHAPE DOES NOT LEAVE THIS METHOD. Upstream wraps almost
   * every number as { raw, fmt } and dates as seconds, and it omits whole
   * blocks without warning for anything that is not an ordinary listed company
   * — an index, a currency pair and a fund each arrive missing a different
   * half. Normalising here means the interface reads one predictable shape and
   * a missing figure is null rather than undefined-shaped, so it can be shown
   * as an em dash instead of as NaN.
   *
   * NOTHING HERE IS A CURRENT FIGURE. These are filed and published numbers, so
   * they are stamped with when they were retrieved and assessed as historical.
   * The live price on the same screen comes from the quote path and keeps its
   * own state. */
  /* Reference data, from whichever source can actually answer.
   *
   * THE VENDOR SUMMARY IS NOT ALWAYS AVAILABLE AND THE PANEL MUST NOT BE EMPTY
   * WHEN IT IS NOT. That endpoint sits behind a session handshake which the
   * upstream refuses outright when it is rate limiting this client, and the
   * refusal can last for hours. Every figure in it is a restatement of a filing
   * anyway, so when it will not answer the filings themselves are read instead.
   * What is lost is the vendor's derived ratios and the analyst consensus,
   * which nobody else publishes for free; what is gained is that the business
   * description, the sector and the accounts are still there, and they are
   * traceable to the document they came from rather than to a vendor's summary
   * of it.
   *
   * The two are never blended into one unlabelled figure. Each block records
   * which source produced it. */
  async fundamentals(symbol) {
    const sym = instrument.normaliseSymbol(symbol);
    if (!sym) throw new Error('Not a usable symbol: ' + symbol);

    return this.once('fundamentals:' + sym, async () => {
      try {
        return await this.vendorFundamentals(sym);
      } catch (err) {
        const filed = await this.filedFundamentals(sym, err);
        if (filed) return filed;
        throw err;
      }
    });
  }

  async vendorFundamentals(sym) {
      const result = await yahoo.summary(sym, [
        'assetProfile', 'price', 'summaryDetail', 'defaultKeyStatistics',
        'financialData', 'calendarEvents', 'recommendationTrend',
        'earnings', 'majorHoldersBreakdown'
      ]);
      this.rememberSource(sym, result.provenance);

      const m = result.modules || {};
      const profile = m.assetProfile || {};
      const price = m.price || {};
      const detail = m.summaryDetail || {};
      const stats = m.defaultKeyStatistics || {};
      const money = m.financialData || {};
      const events = m.calendarEvents || {};
      const holders = m.majorHoldersBreakdown || {};
      const earningsBlock = m.earnings || {};

      const retrievedAt = (result.provenance && result.provenance.at) || Date.now();
      const model = this.quotes.get(sym);

      /* Two different currencies can be in play at once: a London listing
         quotes in pence while its accounts are reported in dollars. Carrying
         both means neither figure is labelled with the other's unit. */
      const currency = pickText(price.currency) || (model && model.currency) || null;
      const reportingCurrency = pickText(money.financialCurrency) || currency;

      const nextEarnings = firstDate(events.earnings && events.earnings.earningsDate);

      return {
        symbol: sym,
        currency,
        reportingCurrency,
        retrievedAt,
        freshness: freshness.assess({ at: retrievedAt, historical: true }),

        profile: {
          description: pickText(profile.longBusinessSummary),
          sector: pickText(profile.sector),
          industry: pickText(profile.industry),
          country: pickText(profile.country),
          city: pickText(profile.city),
          website: pickText(profile.website),
          employees: pickNumber(profile.fullTimeEmployees),
          exchange: pickText(price.exchangeName) || (model && model.exchangeName) || null,
          quoteType: pickText(price.quoteType) || null
        },

        valuation: {
          marketCap: pickNumber(price.marketCap) || pickNumber(detail.marketCap),
          enterpriseValue: pickNumber(stats.enterpriseValue),
          trailingPE: pickNumber(detail.trailingPE),
          forwardPE: pickNumber(detail.forwardPE) || pickNumber(stats.forwardPE),
          pegRatio: pickNumber(stats.pegRatio),
          priceToBook: pickNumber(stats.priceToBook),
          priceToSales: pickNumber(detail.priceToSalesTrailing12Months),
          evToRevenue: pickNumber(stats.enterpriseToRevenue),
          evToEbitda: pickNumber(stats.enterpriseToEbitda),
          beta: pickNumber(detail.beta) || pickNumber(stats.beta)
        },

        perShare: {
          trailingEps: pickNumber(stats.trailingEps),
          forwardEps: pickNumber(stats.forwardEps),
          bookValue: pickNumber(stats.bookValue),
          revenuePerShare: pickNumber(money.revenuePerShare),
          dividendRate: pickNumber(detail.dividendRate),
          dividendYield: pickNumber(detail.dividendYield),
          payoutRatio: pickNumber(detail.payoutRatio),
          exDividendDate: pickDate(detail.exDividendDate) || pickDate(events.exDividendDate),
          dividendDate: pickDate(events.dividendDate)
        },

        shares: {
          outstanding: pickNumber(stats.sharesOutstanding),
          float: pickNumber(stats.floatShares),
          shortOfFloat: pickNumber(stats.shortPercentOfFloat),
          heldByInsiders: pickNumber(holders.insidersPercentHeld),
          heldByInstitutions: pickNumber(holders.institutionsPercentHeld)
        },

        financials: {
          revenue: pickNumber(money.totalRevenue),
          grossProfits: pickNumber(money.grossProfits),
          ebitda: pickNumber(money.ebitda),
          netIncome: pickNumber(stats.netIncomeToCommon),
          freeCashflow: pickNumber(money.freeCashflow),
          operatingCashflow: pickNumber(money.operatingCashflow),
          totalCash: pickNumber(money.totalCash),
          totalDebt: pickNumber(money.totalDebt),
          debtToEquity: pickNumber(money.debtToEquity),
          returnOnEquity: pickNumber(money.returnOnEquity),
          returnOnAssets: pickNumber(money.returnOnAssets),
          grossMargins: pickNumber(money.grossMargins),
          operatingMargins: pickNumber(money.operatingMargins),
          profitMargins: pickNumber(money.profitMargins),
          revenueGrowth: pickNumber(money.revenueGrowth),
          earningsGrowth: pickNumber(money.earningsGrowth)
        },

        analysts: {
          count: pickNumber(money.numberOfAnalystOpinions),
          mean: pickNumber(money.recommendationMean),
          key: pickText(money.recommendationKey),
          targetLow: pickNumber(money.targetLowPrice),
          targetMean: pickNumber(money.targetMeanPrice),
          targetHigh: pickNumber(money.targetHighPrice),
          trend: ((m.recommendationTrend && m.recommendationTrend.trend) || []).map(row => ({
            period: pickText(row.period),
            strongBuy: pickNumber(row.strongBuy) || 0,
            buy: pickNumber(row.buy) || 0,
            hold: pickNumber(row.hold) || 0,
            sell: pickNumber(row.sell) || 0,
            strongSell: pickNumber(row.strongSell) || 0
          }))
        },

        earnings: {
          nextDate: nextEarnings,
          /* Upstream publishes a window of two dates when the date is not
             confirmed. Saying which it is stops a provisional date being read
             as a diary entry. */
          nextDateEstimated: Array.isArray(events.earnings && events.earnings.earningsDate) &&
            events.earnings.earningsDate.length > 1,
          estimate: {
            average: pickNumber(events.earnings && events.earnings.earningsAverage),
            low: pickNumber(events.earnings && events.earnings.earningsLow),
            high: pickNumber(events.earnings && events.earnings.earningsHigh)
          },
          quarterly: ((earningsBlock.earningsChart && earningsBlock.earningsChart.quarterly) || []).map(row => {
            const actual = pickNumber(row.actual);
            const estimate = pickNumber(row.estimate);
            return {
              period: pickText(row.date),
              actual,
              estimate,
              /* Only computable against an estimate that is not zero; a
                 surprise divided by nothing is not a large surprise. */
              surprisePct: (actual != null && estimate != null && estimate !== 0)
                ? ((actual - estimate) / Math.abs(estimate)) * 100 : null
            };
          }),
          annual: ((earningsBlock.financialsChart && earningsBlock.financialsChart.yearly) || []).map(row => ({
            period: String(pickNumber(row.date) || pickText(row.date) || ''),
            revenue: pickNumber(row.revenue),
            earnings: pickNumber(row.earnings)
          }))
        },

        via: 'vendor',
        provenance: result.provenance
      };
  }

  /* The same panel, assembled from the filings themselves.
   *
   * Only the blocks a regulator's XBRL data can actually support are filled.
   * Valuation ratios, analyst coverage and the earnings calendar are not in a
   * filing and are left null rather than derived from something adjacent — a
   * price-to-earnings ratio computed here from a filed EPS and a live price
   * would be this application's arithmetic presented in a column of other
   * people's figures. */
  async filedFundamentals(sym, vendorError) {
    let profile;
    try {
      profile = await sec.filings(sym, { limit: 6 });
    } catch (err) {
      return null;
    }
    if (!profile || !profile.found) return null;
    this.rememberSource(sym, profile.provenance);

    const WANTED = ['revenue', 'grossProfit', 'operatingIncome', 'netIncome', 'eps',
      'assets', 'liabilities', 'equity', 'cash', 'operatingCashFlow', 'sharesOutstanding'];

    const read = await Promise.all(WANTED.map(async name => {
      try {
        /* Deep enough to reach several complete financial years. A 10-K files
           three years of comparatives and four quarters at once, so a dozen
           observations can be a single year seen from three angles. */
        const answer = await sec.concept(sym, name, { limit: 60 });
        return answer && answer.found ? { name, answer } : null;
      } catch (err) {
        return null;
      }
    }));

    const series = {};
    read.filter(Boolean).forEach(({ name, answer }) => {
      this.rememberSource(sym, answer.provenance);
      series[name] = answer.observations;
    });

    /* THE WHOLE BLOCK IS ANCHORED TO ONE FINANCIAL YEAR. That year is the most
       recent one for which revenue was filed, and every other figure in the
       block is the one covering the same period or nothing at all. A panel of
       figures from assorted years is worse than a shorter panel, because
       nothing on it can be read against anything else. */
    const annualRevenue = byPeriodEnd(series.revenue, 'annual');
    const anchor = annualRevenue[0] || null;
    const anchorEnd = anchor ? anchor.periodEnd : null;

    const forYear = name => valueForPeriod(series[name], 'annual', anchorEnd);
    const asAt = name => {
      const row = instantAsOf(series[name], anchorEnd);
      return row ? row.value : null;
    };

    const model = this.quotes.get(sym);
    const retrievedAt = (profile.provenance && profile.provenance.retrievedAt) || Date.now();
    const revenue = anchor ? anchor.value : null;
    const netIncome = forYear('netIncome');
    const equity = asAt('equity');
    const assets = asAt('assets');

    /* Ratios only where both sides came from the same filing period, and only
       where the denominator is a figure that can be divided by. */
    const over = (top, bottom) =>
      (top != null && bottom != null && bottom !== 0) ? top / bottom : null;

    const empty = () => ({});

    return {
      symbol: sym,
      currency: (model && model.currency) || null,
      /* Filings to this regulator are in dollars. Saying so beside the figures
         matters for a foreign filer whose shares trade in another currency. */
      reportingCurrency: 'USD',
      retrievedAt,
      freshness: freshness.assess({ at: retrievedAt, historical: true }),
      via: 'filings',
      /* Why the richer source is missing, so the panel can say so rather than
         implying these are all the figures that exist. */
      vendorUnavailable: String((vendorError && vendorError.message) || '') || null,

      profile: {
        description: null,
        sector: null,
        industry: profile.sic || null,
        country: null,
        city: null,
        website: null,
        employees: null,
        exchange: profile.exchange || (model && model.exchangeName) || null,
        quoteType: model ? model.assetClass : null,
        company: profile.company || null
      },

      valuation: empty(),
      perShare: { trailingEps: forYear('eps') },
      shares: { outstanding: asAt('sharesOutstanding') },

      /* Which financial year every figure below covers. The panel prints this,
         because "revenue" without a year is not a figure. */
      period: anchor ? { end: anchor.periodEnd, start: anchor.periodStart, form: anchor.form, url: anchor.url } : null,

      financials: {
        revenue,
        grossProfits: forYear('grossProfit'),
        operatingIncome: forYear('operatingIncome'),
        netIncome,
        operatingCashflow: forYear('operatingCashFlow'),
        totalCash: asAt('cash'),
        /* Total liabilities as filed. That is not the same thing as total debt
           and it is not labelled as such. */
        totalLiabilities: asAt('liabilities'),
        totalAssets: assets,
        equity,
        grossMargins: over(forYear('grossProfit'), revenue),
        operatingMargins: over(forYear('operatingIncome'), revenue),
        profitMargins: over(netIncome, revenue),
        returnOnEquity: over(netIncome, equity),
        returnOnAssets: over(netIncome, assets)
      },

      analysts: { trend: [] },

      earnings: {
        nextDate: null,
        quarterly: byPeriodEnd(series.eps, 'quarterly').slice(0, 8).map(row => ({
          period: row.periodEnd,
          actual: row.value,
          estimate: null,
          /* Nobody files an estimate. A surprise against nothing is nothing. */
          surprisePct: null
        })),
        annual: annualRevenue.slice(0, 8).map(row => ({
          period: String(row.periodEnd || '').slice(0, 4),
          revenue: row.value,
          earnings: valueForPeriod(series.netIncome, 'annual', row.periodEnd)
        }))
      },

      /* Every observation, with the filing behind it, for the statement view. */
      filed: {
        company: profile.company,
        exchange: profile.exchange,
        recent: profile.filings,
        series
      },

      provenance: profile.provenance
    };
  }

  /* ---------- provenance ---------- */

  /* Every source consulted for an instrument, newest first, for the sources
     drawer. Capped so a long session does not grow this without bound. */
  rememberSource(symbol, record) {
    if (!record) return;
    const sym = instrument.normaliseSymbol(symbol);
    if (!sym) return;
    const list = this.sources.get(sym) || [];
    const key = record.provider + '|' + record.endpoint;
    const at = list.findIndex(r => r.provider + '|' + r.endpoint === key);
    if (at !== -1) list.splice(at, 1);
    list.unshift(record);
    this.sources.set(sym, list.slice(0, 12));
  }

  /* What the sources drawer renders. Deliberately assembled here rather than in
     the interface, so a panel cannot show a figure whose provenance it invented. */
  provenanceFor(symbol) {
    const sym = instrument.normaliseSymbol(symbol);
    const model = this.quotes.get(sym);
    return {
      symbol: sym,
      figure: model ? {
        last: model.quote.last,
        at: model.quote.at,
        freshness: model.freshness,
        currency: model.currency,
        assetClass: model.assetClass
      } : null,
      sources: (this.sources.get(sym) || []).slice(),
      warnings: model ? (model.warnings || []) : [],
      rejected: model ? (model.rejected || null) : null
    };
  }

  /* ---------- plumbing ---------- */

  /* Concurrent callers asking for the same thing share one request. */
  once(key, run) {
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    const promise = run().finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, promise);
    return promise;
  }

  onUpdate(fn) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(f => f !== fn); };
  }

  emit(models) {
    if (!models || !models.length) return;
    this.listeners.forEach(fn => {
      try { fn(models); } catch (e) { /* a subscriber must not break the loop */ }
    });
  }

  /* A snapshot for the data-health panel. */
  health() {
    return {
      subscribed: this.subscribed().length,
      loaded: this.quotes.size,
      lastCycleAt: this.lastCycleAt,
      errors: this.cycleErrors.slice(),
      safeMode: this.safeMode.state(),
      worst: freshness.worst(Array.from(this.quotes.values()).map(m => m.freshness))
    };
  }
}

/* The summary readers are exported so the suite can drive them against the
   provider's real response shapes without a network call. */
module.exports = { Engine, CADENCE, REGISTRY, pickNumber, pickText, pickDate, firstDate };
