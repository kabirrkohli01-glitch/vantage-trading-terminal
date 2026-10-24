'use strict';
/* Market data adapter: Binance public endpoints.
 *
 * Crypto is the one asset class where this application can offer things the
 * equity feeds cannot, because the exchanges publish their own order flow
 * without an account:
 *
 *   ONE-SECOND BARS ARE REAL HERE. The exchange serves them natively. Every
 *   other asset class in this application tops out at one minute, and the
 *   difference is stated in the interface rather than papered over.
 *
 *   TRADE-LEVEL DATA IS REAL HERE. Aggregated trades carry a flag identifying
 *   which side was the aggressor, which is what a footprint chart is actually
 *   built from. Equity footprint needs bid/ask-tagged tick data that is not
 *   available without a paid feed, so this application draws footprint for
 *   crypto and says plainly that it cannot for anything else.
 *
 *   FUNDING AND OPEN INTEREST are published outright.
 *
 * A SUBSTITUTION IS MADE AND IT IS DISCLOSED. This venue quotes against the
 * dollar-pegged stablecoin, not the dollar, so a request for BTC against USD is
 * served as BTC against USDT. Those are different instruments that usually
 * trade within a few basis points of each other and occasionally do not. Every
 * figure returned here carries the venue symbol actually used, and the sources
 * drawer shows it, so the substitution is visible rather than assumed.
 */

const http = require('../../core/http');
const candles = require('../candles');
const instrument = require('../instrument');
const { num, CLASS } = require('../../core/num');

const NAME = 'binance';
const LABEL = 'Binance';
const SPOT = 'https://api.binance.com';
const FUTURES = 'https://fapi.binance.com';

/* This venue streams its own book and publishes without delay. Unlike the
   equity sources, real-time is a claim it can actually support. */
function coverage() {
  return { realtime: true, delaySeconds: 0 };
}

/* Timeframe names to the venue's own. One-second bars have no equivalent
   anywhere else in this application, which is the point of listing them. */
const INTERVALS = {
  '1s': '1s', '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '8h': '8h', '12h': '12h',
  '1d': '1d', '3d': '3d', '1w': '1w', '1mo': '1M'
};

const QUOTE_ALIASES = { USD: 'USDT', USDC: 'USDC', USDT: 'USDT', EUR: 'EUR', GBP: 'GBP', BTC: 'BTC', ETH: 'ETH' };

/* Translate an application symbol into this venue's symbol, reporting any
   substitution made along the way. Returns null when the symbol is not a crypto
   pair this venue could serve. */
function venueSymbol(symbol) {
  const sym = instrument.normaliseSymbol(symbol);
  if (!sym) return null;

  const parts = sym.split('-');
  if (parts.length !== 2) return null;

  const base = parts[0];
  const asked = parts[1];
  const quote = QUOTE_ALIASES[asked];
  if (!quote) return null;

  return {
    venue: base + quote,
    base,
    askedQuote: asked,
    servedQuote: quote,
    substituted: quote !== asked,
    note: quote !== asked
      ? 'Quoted against ' + quote + ' on this venue, not ' + asked + '. These are different instruments.'
      : null
  };
}

function supports(symbol) {
  return venueSymbol(symbol) !== null;
}

function provenance(endpoint, at, mapping, extra) {
  return Object.assign({
    provider: NAME,
    providerLabel: LABEL,
    endpoint,
    symbol: mapping ? mapping.venue : null,
    retrievedAt: at || Date.now(),
    substitution: mapping && mapping.substituted ? mapping.note : null
  }, extra || {});
}

/* ---------- bars ---------- */

async function chart(symbol, options) {
  const opts = options || {};
  const mapping = venueSymbol(symbol);
  if (!mapping) throw new Error('This venue does not quote ' + symbol + '.');

  const interval = INTERVALS[opts.interval || '1h'];
  if (!interval) throw new Error('This venue does not serve ' + opts.interval + ' bars.');

  const params = new URLSearchParams({ symbol: mapping.venue, interval });
  /* The endpoint caps a single response; asking beyond the cap silently
     truncates rather than erroring, so the ceiling is enforced here. */
  params.set('limit', String(Math.min(Math.max(Number(opts.limit) || 500, 1), 1000)));
  if (opts.from) params.set('startTime', String(Math.floor(opts.from)));
  if (opts.to) params.set('endTime', String(Math.floor(opts.to)));

  const res = await http.json(SPOT + '/api/v3/klines?' + params.toString(), {
    cacheMs: opts.cacheMs == null ? (interval === '1s' ? 1000 : 15000) : opts.cacheMs
  });

  const rows = Array.isArray(res.data) ? res.data : [];
  const bars = candles.fromArrays(
    rows.map(r => r[0]),
    rows.map(r => r[1]), rows.map(r => r[2]), rows.map(r => r[3]), rows.map(r => r[4]),
    rows.map(r => r[5]),
    { timesInSeconds: false }
  );

  return {
    symbol: instrument.normaliseSymbol(symbol),
    bars,
    timeframe: opts.interval || '1h',
    requestedTimeframe: opts.interval || '1h',
    coarsened: false,
    mapping,
    provenance: provenance('api/v3/klines', res.at, mapping, { interval, cached: res.cached })
  };
}

/* ---------- quote ---------- */

async function quote(symbol, options) {
  const opts = options || {};
  const mapping = venueSymbol(symbol);
  if (!mapping) return null;

  let ticker;
  let book;
  try {
    [ticker, book] = await Promise.all([
      http.json(SPOT + '/api/v3/ticker/24hr?symbol=' + mapping.venue, { cacheMs: opts.cacheMs == null ? 10000 : opts.cacheMs }),
      http.json(SPOT + '/api/v3/ticker/bookTicker?symbol=' + mapping.venue, { cacheMs: opts.cacheMs == null ? 5000 : opts.cacheMs })
        .catch(() => null)
    ]);
  } catch (err) {
    return null;
  }

  const t = ticker && ticker.data;
  if (!t) return null;
  const b = book && book.data;

  const session = { tz: 'UTC', continuous: true, hasExtended: false };

  return instrument.build({
    symbol: instrument.normaliseSymbol(symbol),
    name: mapping.base + ' / ' + mapping.servedQuote,
    instrumentType: 'CRYPTOCURRENCY',
    currency: mapping.servedQuote === 'USDT' ? 'USD' : mapping.servedQuote,
    exchange: NAME,
    exchangeName: LABEL,
    session,
    quote: instrument.quote({
      last: t.lastPrice,
      bid: b ? b.bidPrice : null,
      ask: b ? b.askPrice : null,
      bidSize: b ? b.bidQty : null,
      askSize: b ? b.askQty : null,
      open: t.openPrice,
      previousClose: t.prevClosePrice,
      dayHigh: t.highPrice,
      dayLow: t.lowPrice,
      volume: t.volume,
      at: num(t.closeTime)
    }),
    provenance: provenance('api/v3/ticker', ticker.at, mapping, { cached: ticker.cached })
  });
}

/* ---------- derivatives ---------- */

/* Perpetual funding and mark price. Only defined for pairs with a perpetual
   contract, so an absent contract returns null rather than zeroes. */
async function funding(symbol) {
  const mapping = venueSymbol(symbol);
  if (!mapping) return null;

  let res;
  try {
    res = await http.json(FUTURES + '/fapi/v1/premiumIndex?symbol=' + mapping.venue, { cacheMs: 30000 });
  } catch (err) {
    return null;
  }
  const d = res.data;
  if (!d || !d.symbol) return null;

  return {
    symbol: instrument.normaliseSymbol(symbol),
    markPrice: num(d.markPrice),
    indexPrice: num(d.indexPrice),
    /* Published as a fraction of notional per funding interval. Rendering it
       as a percentage is the caller's job; storing it pre-multiplied would make
       the stored figure disagree with the venue's own. */
    fundingRate: num(d.lastFundingRate),
    nextFundingAt: num(d.nextFundingTime),
    at: num(d.time),
    provenance: provenance('fapi/v1/premiumIndex', res.at, mapping, { cached: res.cached })
  };
}

async function openInterest(symbol) {
  const mapping = venueSymbol(symbol);
  if (!mapping) return null;

  let res;
  try {
    res = await http.json(FUTURES + '/fapi/v1/openInterest?symbol=' + mapping.venue, { cacheMs: 60000 });
  } catch (err) {
    return null;
  }
  const d = res.data;
  if (!d || d.openInterest == null) return null;

  return {
    symbol: instrument.normaliseSymbol(symbol),
    openInterest: num(d.openInterest),
    at: num(d.time),
    provenance: provenance('fapi/v1/openInterest', res.at, mapping, { cached: res.cached })
  };
}

/* ---------- trade tape ---------- */

/* Aggregated trades, which is what makes a real footprint possible.
 *
 * The venue's flag marks whether the BUYER was the maker. When true, the resting
 * order was a bid and the aggressor sold into it; when false, the aggressor
 * bought. That inversion is the whole meaning of the field and getting it
 * backwards silently swaps every buy and sell column in the footprint, so it is
 * translated once, here, into an explicit side. */
async function trades(symbol, options) {
  const opts = options || {};
  const mapping = venueSymbol(symbol);
  if (!mapping) return null;

  const params = new URLSearchParams({ symbol: mapping.venue });
  params.set('limit', String(Math.min(Math.max(Number(opts.limit) || 500, 1), 1000)));
  if (opts.from) params.set('startTime', String(Math.floor(opts.from)));
  if (opts.to) params.set('endTime', String(Math.floor(opts.to)));

  let res;
  try {
    res = await http.json(SPOT + '/api/v3/aggTrades?' + params.toString(), { cacheMs: opts.cacheMs == null ? 2000 : opts.cacheMs });
  } catch (err) {
    return null;
  }

  const rows = Array.isArray(res.data) ? res.data : [];
  return {
    symbol: instrument.normaliseSymbol(symbol),
    trades: rows.map(r => ({
      at: num(r.T),
      price: num(r.p),
      quantity: num(r.q),
      aggressor: r.m === true ? 'sell' : 'buy'
    })).filter(t => t.price !== null && t.quantity !== null),
    provenance: provenance('api/v3/aggTrades', res.at, mapping, { cached: res.cached })
  };
}

/* Build a footprint from a real trade tape: traded volume at each price within
   each bar, split by which side was the aggressor. Nothing here is modelled or
   estimated — every unit of volume came from a printed trade. */
function footprint(tape, barMs, tickSize) {
  const rows = (tape && tape.trades) || [];
  const bucket = Number(barMs) || 60000;
  const tick = Number(tickSize) > 0 ? Number(tickSize) : null;
  const bars = new Map();

  rows.forEach(trade => {
    const slot = Math.floor(trade.at / bucket) * bucket;
    const price = tick ? Math.round(trade.price / tick) * tick : trade.price;
    if (!bars.has(slot)) bars.set(slot, new Map());
    const levels = bars.get(slot);
    const key = String(price);
    if (!levels.has(key)) levels.set(key, { price, buy: 0, sell: 0 });
    const level = levels.get(key);
    level[trade.aggressor] += trade.quantity;
  });

  return Array.from(bars.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([t, levels]) => {
      const rowsOut = Array.from(levels.values()).sort((a, b) => b.price - a.price);
      let buy = 0;
      let sell = 0;
      rowsOut.forEach(r => { buy += r.buy; sell += r.sell; });
      return { t, levels: rowsOut, buyVolume: buy, sellVolume: sell, delta: buy - sell };
    });
}

module.exports = {
  name: NAME, label: LABEL, assetClass: CLASS.CRYPTO,
  coverage, supports, venueSymbol,
  chart, quote, funding, openInterest, trades, footprint,
  INTERVALS
};
