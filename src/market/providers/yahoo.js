'use strict';
/* Market data adapter: Yahoo Finance public endpoints.
 *
 * The broadest single source available without an account: equities on most
 * world exchanges, indices, currency pairs, futures, cryptocurrencies and
 * government bond yields, all through one set of endpoints, all keyless.
 *
 * THE ENDPOINTS SPLIT INTO TWO GROUPS, AND THE SPLIT SHAPES THIS WHOLE FILE.
 *
 *   Open: chart, symbol search and the headline RSS feed. No session, no
 *   handshake. These answer immediately and always.
 *
 *   Session-gated: the quote endpoint (which is the only one carrying bid, ask
 *   and the venue's own delay disclosure), option chains, and the summary
 *   modules behind fundamentals. These answer 401 "Invalid Crumb" without a
 *   cookie-and-token pair.
 *
 * The handshake that works: request fc.yahoo.com, which answers 404 and sets a
 * session cookie anyway, then request the crumb endpoint carrying that cookie.
 *
 * THE CRUMB ENDPOINT IS SEVERELY RATE LIMITED — measured here answering 429 for
 * well over ninety seconds after a burst of ordinary requests. Two consequences
 * are designed in rather than discovered later:
 *
 *   The session is fetched once and persisted, so relaunching the application
 *   does not spend a crumb request. It is only renewed when a call actually
 *   fails authentication.
 *
 *   NOTHING ESSENTIAL DEPENDS ON IT. Prices, ranges, volume and the entire
 *   charting surface come from the open group. When no session can be
 *   established the application loses bid/ask, option chains and fundamentals,
 *   and says so — it does not lose the ability to show a price.
 */

const http = require('../../core/http');
const clock = require('../../core/clock');
const candles = require('../candles');
const instrument = require('../instrument');
const { num } = require('../../core/num');

const NAME = 'yahoo';
const LABEL = 'Yahoo Finance';
const BASE = 'https://query1.finance.yahoo.com';

/* The spark endpoint refuses more than twenty symbols outright, answering 400
   with a null result — so a twenty-one symbol watchlist returns nothing at all
   rather than most of itself. Requests are chunked below this ceiling. */
const SPARK_CHUNK = 20;

/* Range to default interval. A caller may override, but these are the pairings
   the upstream actually serves for each window. */
const RANGE_INTERVAL = {
  '1d': '5m',
  '5d': '15m',
  '1mo': '1h',
  '3mo': '1d',
  '6mo': '1d',
  '1y': '1d',
  '2y': '1d',
  '5y': '1wk',
  '10y': '1wk',
  'ytd': '1d',
  'max': '1mo'
};

/* The bar sizes this source serves natively.
 *
 * Everything else the application offers — three-minute, ten-minute, two-hour,
 * four-hour — is built by merging these, which the engine does. What cannot be
 * built at all is anything finer than a minute: no keyless source publishes
 * second bars for a listed equity, and five one-second bars cannot be derived
 * from a one-minute bar without inventing four opens and eight extremes. */
const INTERVALS = ['1m', '2m', '5m', '15m', '30m', '1h', '1d', '1w', '1mo'];

/* Upstream interval names differ from this application's timeframe names in
   three places. Mapping in one direction only, at the boundary. */
const TO_UPSTREAM = { '1h': '60m', '1w': '1wk', '1mo': '1mo' };
const FROM_UPSTREAM = { '60m': '1h', '90m': '90m', '1wk': '1w', '1mo': '1mo', '3mo': '3mo' };

function upstreamInterval(name) {
  return TO_UPSTREAM[name] || name;
}

function ourInterval(name) {
  return FROM_UPSTREAM[name] || name;
}

/* ---------- session ---------- */

/* Held here rather than in the HTTP layer because it belongs to this provider
   and its lifetime is this provider's business. The store is injected so tests
   can hand it a temporary directory. */
let session = { crumb: null, cookie: null, at: 0, failedAt: 0 };
let sessionStore = null;

const SESSION_KEY = 'yahoo-session';
const SESSION_LIFE = 24 * 60 * 60 * 1000;
/* After a refused handshake, do not try again for this long. Retrying into a
   rate limit is what produced the refusal. */
const HANDSHAKE_COOLDOWN = 10 * 60 * 1000;

function useStore(store) {
  sessionStore = store || null;
  if (!sessionStore) return;
  const saved = sessionStore.doc(SESSION_KEY, null);
  if (saved && saved.crumb && saved.cookie) {
    session = saved;
    /* The HTTP layer keeps its jar in memory, so a restored session has to be
       handed back to it or the cookie is never actually sent and every gated
       call fails authentication while appearing to hold a valid session. */
    http.setCookies('query1.finance.yahoo.com', saved.cookie);
  }
}

function persist() {
  if (sessionStore) sessionStore.putDoc(SESSION_KEY, session);
}

function haveSession() {
  return !!(session.crumb && session.cookie && Date.now() - session.at < SESSION_LIFE);
}

async function establish(force) {
  if (!force && haveSession()) return true;
  if (!force && Date.now() - session.failedAt < HANDSHAKE_COOLDOWN) return false;

  try {
    /* This request is expected to fail. It answers 404 and sets the session
       cookie in the same response, which is the only reason it is made. The
       HTTP layer captures the cookie; the 404 is caught and discarded. */
    await http.request('https://fc.yahoo.com/', { cacheMs: 0, timeout: 10000 }).catch(() => null);

    const cookie = http.cookieHeader('query1.finance.yahoo.com');
    if (!cookie) {
      session.failedAt = Date.now();
      persist();
      return false;
    }

    const res = await http.text(BASE + '/v1/test/getcrumb', { cacheMs: 0, timeout: 10000, accept: 'text/plain' });
    const crumb = String(res.data || '').trim();

    /* A crumb is a short opaque token. Anything longer is an error page that
       arrived with a 200, and storing it would send an HTML document as a
       query parameter on every later request. */
    if (!crumb || crumb.length > 32 || /[<>{}\s]/.test(crumb)) {
      session.failedAt = Date.now();
      persist();
      return false;
    }

    session = { crumb, cookie, at: Date.now(), failedAt: 0 };
    persist();
    return true;
  } catch (err) {
    session.failedAt = Date.now();
    persist();
    return false;
  }
}

/* Every session-gated call goes through here so the retry-once-on-401 rule
   exists in one place. */
async function gated(build) {
  const ready = await establish(false);
  if (!ready) {
    const err = new http.HttpError(
      'This source needs a session for that request and one could not be established. ' +
      'Prices and charts are unaffected.', 0, 'auth');
    err.degraded = true;
    throw err;
  }

  try {
    return await build(session.crumb);
  } catch (err) {
    if (err && (err.status === 401 || err.status === 403)) {
      const renewed = await establish(true);
      if (renewed) return build(session.crumb);
    }
    throw err;
  }
}

/* ---------- provenance ---------- */

function provenance(endpoint, at, extra) {
  return Object.assign({
    provider: NAME,
    providerLabel: LABEL,
    endpoint,
    retrievedAt: at || Date.now()
  }, extra || {});
}

/* What this adapter is willing to claim about its own latency.
 *
 * Deliberately null unless the upstream itself told us. The quote endpoint
 * publishes exchangeDataDelayedBy per symbol, and where that is present the
 * market engine uses it. Where it is absent — which is every request made
 * without a session — the answer is "not stated", and the freshness layer
 * renders that as delayed rather than promoting it to live. */
function coverage() {
  return { realtime: null, delaySeconds: null };
}

/* ---------- charts ---------- */

/* The full bar series plus the venue metadata that comes with it.
 *
 * GRANULARITY IS VERIFIED, NOT ASSUMED. Asking for the maximum range at daily
 * resolution returns MONTHLY bars — 332 of them for a stock with thirteen
 * thousand trading days — with no error and no warning. The response states
 * what it actually served in meta.dataGranularity, so that is read back and
 * returned as the authoritative timeframe. A caller that asked for days and
 * received months is told, and the chart labels what it is really showing. */
async function chart(symbol, options) {
  const opts = options || {};
  const sym = instrument.normaliseSymbol(symbol);
  if (!sym) throw new Error('Not a usable symbol: ' + symbol);

  const range = opts.range || '1mo';
  const interval = upstreamInterval(opts.interval || RANGE_INTERVAL[range] || '1d');

  const params = new URLSearchParams();
  /* TESTED FOR BEING A NUMBER, NOT FOR BEING TRUTHY. A `from` of zero means
     "from the beginning of the record", which is exactly what a request for a
     company's whole history looks like — and it is falsy, so a truthiness test
     silently dropped both epochs and fell back to the default one-month range.
     The same shape of mistake once leaked a bar past the replay cursor. */
  const from = Number(opts.from);
  const to = Number(opts.to);
  if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
    /* Explicit epochs are the only way to get true long daily history; the
       named maximum range silently coarsens instead. */
    params.set('period1', String(Math.floor(from / 1000)));
    params.set('period2', String(Math.floor(to / 1000)));
  } else {
    params.set('range', range);
  }
  params.set('interval', interval);
  params.set('includePrePost', opts.extended ? 'true' : 'false');
  params.set('events', 'div,split');

  const url = BASE + '/v8/finance/chart/' + encodeURIComponent(sym) + '?' + params.toString();
  const res = await http.json(url, { cacheMs: opts.cacheMs == null ? 20000 : opts.cacheMs });

  const payload = res.data && res.data.chart;
  if (!payload) throw new Error('That source returned no chart data for ' + sym + '.');
  if (payload.error) throw new Error(payload.error.description || 'No chart for ' + sym + '.');

  const result = payload.result && payload.result[0];
  if (!result || !result.meta) throw new Error('There is no chart for ' + sym + '.');

  const meta = result.meta;
  const quoteBlock = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};

  const bars = candles.fromArrays(
    result.timestamp,
    quoteBlock.open, quoteBlock.high, quoteBlock.low, quoteBlock.close, quoteBlock.volume
  );

  const served = ourInterval(meta.dataGranularity || interval);
  const asked = ourInterval(interval);

  return {
    symbol: sym,
    bars,
    /* What was actually served, which is not always what was requested. */
    timeframe: served,
    requestedTimeframe: asked,
    coarsened: served !== asked,
    validRanges: Array.isArray(meta.validRanges) ? meta.validRanges.slice() : [],
    meta,
    instrument: fromMeta(sym, meta, res.at),
    provenance: provenance('v8/finance/chart', res.at, { symbol: sym, interval: served, cached: res.cached })
  };
}

/* Build the instrument model out of chart metadata. This is the path that works
   without a session, and therefore the path most of the application uses. */
function fromMeta(symbol, meta, at) {
  const m = meta || {};
  const session_ = clock.sessionFrom(m);
  const assetClass = instrument.classFromProvider(m.instrumentType) || instrument.classFromSymbol(symbol);
  session_.continuous = instrument.isContinuous(assetClass);

  return instrument.build({
    symbol,
    name: m.longName || m.shortName || null,
    instrumentType: m.instrumentType,
    currency: m.currency,
    exchange: m.exchangeName,
    exchangeName: m.fullExchangeName,
    priceHint: m.priceHint,
    session: session_,
    quote: instrument.quote({
      last: m.regularMarketPrice,
      /* previousClose is absent on whole-day intervals and chartPreviousClose
         is absent on some others; without the pair, every change reads null. */
      previousClose: m.previousClose == null ? m.chartPreviousClose : m.previousClose,
      dayHigh: m.regularMarketDayHigh,
      dayLow: m.regularMarketDayLow,
      yearHigh: m.fiftyTwoWeekHigh,
      yearLow: m.fiftyTwoWeekLow,
      volume: m.regularMarketVolume,
      at: num(m.regularMarketTime) === null ? null : m.regularMarketTime * 1000
    }),
    provenance: provenance('v8/finance/chart', at, { symbol })
  });
}

/* ---------- quotes without a session ---------- */

/* Batch quotes for a watchlist. Uses the spark endpoint, whose metadata block
 * carries everything a watchlist row needs and which requires no session.
 *
 * Results come back in the upstream's own order rather than the order asked
 * for, and a symbol it could not resolve is simply absent. Both are handled by
 * indexing the response rather than zipping it against the request, which is
 * how a single unresolved symbol silently shifts an entire watchlist by one
 * row. */
async function quotes(symbols, options) {
  const opts = options || {};
  const clean = [];
  const seen = new Set();
  (symbols || []).forEach(raw => {
    const sym = instrument.normaliseSymbol(raw);
    if (sym && !seen.has(sym)) { seen.add(sym); clean.push(sym); }
  });
  if (!clean.length) return [];

  const chunks = [];
  for (let i = 0; i < clean.length; i += SPARK_CHUNK) chunks.push(clean.slice(i, i + SPARK_CHUNK));

  const results = await Promise.all(chunks.map(async chunk => {
    /* Sorted before the URL is built so two callers asking for the same set in
       different orders share one cache entry. */
    const query = chunk.slice().sort().join(',');
    const url = BASE + '/v7/finance/spark?symbols=' + encodeURIComponent(query) +
      '&range=1d&interval=' + (opts.series ? '5m' : '1d');
    try {
      return await http.json(url, { cacheMs: opts.cacheMs == null ? 20000 : opts.cacheMs });
    } catch (err) {
      /* One failed chunk must not empty the whole watchlist. */
      return null;
    }
  }));

  const bySymbol = new Map();
  results.forEach(res => {
    if (!res || !res.data) return;
    const rows = res.data.spark && res.data.spark.result ? res.data.spark.result : [];
    rows.forEach(row => {
      const block = row && row.response && row.response[0];
      if (!block || !block.meta) return;
      const sym = instrument.normaliseSymbol(block.meta.symbol || row.symbol);
      if (!sym) return;
      const model = fromMeta(sym, block.meta, res.at);
      if (model) {
        model.provenance = provenance('v7/finance/spark', res.at, { symbol: sym, cached: res.cached });
        bySymbol.set(sym, model);
      }
    });
  });

  return clean.map(sym => bySymbol.get(sym) || null).filter(Boolean);
}

/* ---------- session-gated detail ---------- */

/* A trade outside the regular session, read strictly from the venue's own
 * `marketState` rather than from which price fields happen to be non-null.
 * Yahoo does not clear preMarketPrice overnight or postMarketPrice the next
 * morning, so a stale field from twelve hours ago is present exactly as
 * often as a current one — the state the venue itself declares is the only
 * honest way to tell which figure, if either, is current right now.
 *
 * Returned as its own block rather than folded into `quote`: the regular
 * session's last print is a different, still-true fact — the closing print
 * — and overwriting it would make a screen disagree with its own history the
 * moment the extended figure arrived.
 */
function extendedFrom(q) {
  const state = q.marketState || null;
  if (state === 'PRE') {
    const price = num(q.preMarketPrice);
    const at = num(q.preMarketTime);
    if (price == null || at == null) return null;
    return { state: 'PRE', price, changePercent: num(q.preMarketChangePercent), at: at * 1000 };
  }
  if (state === 'POST' || state === 'POSTPOST') {
    const price = num(q.postMarketPrice);
    const at = num(q.postMarketTime);
    if (price == null || at == null) return null;
    return { state: 'POST', price, changePercent: num(q.postMarketChangePercent), at: at * 1000 };
  }
  return null;
}

function detailFrom(q, res) {
  const sym = instrument.normaliseSymbol(q.symbol);
  if (!sym) return null;
  const delay = num(q.exchangeDataDelayedBy);
  return {
    symbol: sym,
    bid: num(q.bid),
    ask: num(q.ask),
    bidSize: num(q.bidSize),
    askSize: num(q.askSize),
    open: num(q.regularMarketOpen),
    marketState: q.marketState || null,
    averageVolume: num(q.averageDailyVolume3Month),
    marketCap: num(q.marketCap),
    priceHint: num(q.priceHint),
    /* The upstream states this per symbol. A declared zero is the only
       thing in this application that can promote a figure to real-time. */
    delaySeconds: delay,
    realtime: delay === 0 ? true : (delay === null ? null : false),
    quoteSource: q.quoteSourceName || null,
    extended: extendedFrom(q),
    provenance: provenance('v7/finance/quote', res.at, { symbol: sym, cached: res.cached })
  };
}

/* Bid, ask, sizes, market state, the pre/post-market print when the venue is
   in one of those sessions, and — the reason this call exists at all — the
   venue's own delay disclosure. Everything here is an enhancement over what
   quotes() already returned; nothing depends on it. */
async function quoteDetail(symbols) {
  const clean = (symbols || []).map(instrument.normaliseSymbol).filter(Boolean);
  if (!clean.length) return [];

  return gated(async crumb => {
    const url = BASE + '/v7/finance/quote?symbols=' + encodeURIComponent(clean.slice(0, 50).join(',')) +
      '&crumb=' + encodeURIComponent(crumb);
    const res = await http.json(url, { cacheMs: 15000, headerKey: 'session' });
    const rows = (res.data && res.data.quoteResponse && res.data.quoteResponse.result) || [];
    return rows.map(q => detailFrom(q, res)).filter(Boolean);
  });
}

async function summary(symbol, modules) {
  const sym = instrument.normaliseSymbol(symbol);
  if (!sym) throw new Error('Not a usable symbol: ' + symbol);
  const wanted = (modules && modules.length ? modules : [
    'price', 'summaryDetail', 'defaultKeyStatistics', 'financialData', 'calendarEvents'
  ]).join(',');

  return gated(async crumb => {
    const url = BASE + '/v10/finance/quoteSummary/' + encodeURIComponent(sym) +
      '?modules=' + encodeURIComponent(wanted) + '&crumb=' + encodeURIComponent(crumb);
    const res = await http.json(url, { cacheMs: 10 * 60 * 1000, headerKey: 'session' });
    const block = res.data && res.data.quoteSummary && res.data.quoteSummary.result && res.data.quoteSummary.result[0];
    if (!block) throw new Error('No summary published for ' + sym + '.');
    return {
      symbol: sym,
      modules: block,
      provenance: provenance('v10/finance/quoteSummary', res.at, { symbol: sym, modules: wanted, cached: res.cached })
    };
  });
}

async function optionChain(symbol, expiry) {
  const sym = instrument.normaliseSymbol(symbol);
  if (!sym) throw new Error('Not a usable symbol: ' + symbol);

  return gated(async crumb => {
    const url = BASE + '/v7/finance/options/' + encodeURIComponent(sym) +
      (expiry ? '?date=' + encodeURIComponent(Math.floor(expiry / 1000)) + '&crumb=' : '?crumb=') +
      encodeURIComponent(crumb);
    const res = await http.json(url, { cacheMs: 60 * 1000, headerKey: 'session' });
    const block = res.data && res.data.optionChain && res.data.optionChain.result && res.data.optionChain.result[0];
    if (!block) throw new Error('No option chain published for ' + sym + '.');

    const contracts = (block.options && block.options[0]) || { calls: [], puts: [] };
    const map = row => ({
      symbol: row.contractSymbol,
      strike: num(row.strike),
      last: num(row.lastPrice),
      bid: num(row.bid),
      ask: num(row.ask),
      volume: num(row.volume),
      openInterest: num(row.openInterest),
      impliedVolatility: num(row.impliedVolatility),
      inTheMoney: row.inTheMoney === true,
      expiry: num(row.expiration) === null ? null : row.expiration * 1000,
      lastTradeAt: num(row.lastTradeDate) === null ? null : row.lastTradeDate * 1000
    });

    return {
      symbol: sym,
      expiries: (block.expirationDates || []).map(s => s * 1000),
      strikes: (block.strikes || []).map(num).filter(v => v !== null),
      calls: (contracts.calls || []).map(map),
      puts: (contracts.puts || []).map(map),
      underlying: block.quote ? fromMeta(sym, {
        instrumentType: block.quote.quoteType,
        currency: block.quote.currency,
        exchangeName: block.quote.exchange,
        fullExchangeName: block.quote.fullExchangeName,
        longName: block.quote.longName,
        regularMarketPrice: block.quote.regularMarketPrice,
        regularMarketTime: block.quote.regularMarketTime,
        previousClose: block.quote.regularMarketPreviousClose,
        exchangeTimezoneName: block.quote.exchangeTimezoneName
      }, res.at) : null,
      provenance: provenance('v7/finance/options', res.at, { symbol: sym, cached: res.cached })
    };
  });
}

/* ---------- search ---------- */

/* Symbol lookup. Fund share classes are filtered out: they dominate the results
   for any ordinary company name and are not instruments this application can
   chart usefully. */
async function search(query, options) {
  const text = String(query || '').trim();
  if (text.length < 1) return [];
  const opts = options || {};

  const url = BASE + '/v1/finance/search?q=' + encodeURIComponent(text) +
    '&quotesCount=' + (opts.limit || 10) + '&newsCount=0&enableFuzzyQuery=false';
  const res = await http.json(url, { cacheMs: 60 * 60 * 1000 });

  const allowed = new Set(['EQUITY', 'ETF', 'INDEX', 'CURRENCY', 'CRYPTOCURRENCY', 'FUTURE', 'OPTION']);
  return ((res.data && res.data.quotes) || [])
    .filter(row => row && allowed.has(String(row.quoteType || '').toUpperCase()))
    .map(row => ({
      symbol: instrument.normaliseSymbol(row.symbol),
      name: row.longname || row.shortname || null,
      exchange: row.exchDisp || row.exchange || null,
      assetClass: instrument.classFromProvider(row.quoteType) || instrument.classFromSymbol(row.symbol),
      provenance: provenance('v1/finance/search', res.at, { query: text })
    }))
    .filter(row => row.symbol);
}

module.exports = {
  name: NAME,
  label: LABEL,
  useStore, establish, haveSession, coverage,
  chart, quotes, quoteDetail, summary, optionChain, search,
  fromMeta, extendedFrom, detailFrom, RANGE_INTERVAL, SPARK_CHUNK, INTERVALS
};
