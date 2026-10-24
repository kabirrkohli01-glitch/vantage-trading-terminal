'use strict';
/* The universal instrument model.
 *
 * One shape for a share, an index, a currency pair, a futures contract, a
 * cryptocurrency and a bond yield, so that no panel above this layer needs to
 * know which it is looking at. A chart, a watchlist row and an alert all read
 * the same fields whatever was loaded into them.
 *
 * The asset class is the field that carries the most weight, because precision,
 * whether a currency mark is drawn, whether a session exists and whether a
 * spread means anything are all decided by it. It is taken from the provider's
 * own classification wherever one is supplied, and inferred from the symbol's
 * shape only as a fallback — inference is a guess, and a guess about the asset
 * class produces a plausible, wrong screen.
 */

const { CLASS } = require('../core/num');

/* What may be used as a symbol.
 *
 * Symbols are interpolated into upstream URLs, so this is the whole input
 * surface between a text box and a request. Permitted: letters, digits, and the
 * four punctuation marks that carry meaning in real symbols — a dot for the
 * exchange suffix (HSBA.L), a hyphen for share classes and crypto pairs (BRK-B,
 * BTC-USD), an equals sign for currency pairs and futures (EURUSD=X, GC=F), and
 * a leading caret for indices (^GSPC).
 *
 * A consequence worth stating plainly: symbols containing an ampersand cannot
 * be represented. That excludes a small number of real listings. Widening the
 * guard to admit them would widen it for everything else, so those instruments
 * are unsupported and say so, rather than being silently mangled. */
const SYMBOL = /^\^?[A-Za-z0-9][A-Za-z0-9.=^-]{0,29}$/;

function normaliseSymbol(raw) {
  const symbol = String(raw == null ? '' : raw).trim().toUpperCase();
  return SYMBOL.test(symbol) ? symbol : null;
}

/* Provider vocabularies mapped onto ours. Anything unrecognised becomes
   UNKNOWN, which formats conservatively, rather than defaulting to EQUITY and
   drawing a currency symbol on something that has no currency. */
const FROM_PROVIDER = {
  EQUITY: CLASS.EQUITY,
  ETF: CLASS.ETF,
  MUTUALFUND: CLASS.ETF,
  INDEX: CLASS.INDEX,
  CURRENCY: CLASS.CURRENCY,
  CRYPTOCURRENCY: CLASS.CRYPTO,
  FUTURE: CLASS.FUTURE,
  OPTION: CLASS.OPTION,
  BOND: CLASS.BOND,
  COMMODITY: CLASS.COMMODITY
};

function classFromProvider(instrumentType) {
  const key = String(instrumentType || '').toUpperCase();
  return FROM_PROVIDER[key] || null;
}

/* Fallback classification from the symbol's own shape. Used only when the
   provider did not say. */
function classFromSymbol(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (!s) return CLASS.UNKNOWN;
  if (s.startsWith('^')) return CLASS.INDEX;
  if (s.endsWith('=X')) return CLASS.CURRENCY;
  if (s.endsWith('=F')) return CLASS.FUTURE;
  if (/-(USD|USDT|GBP|EUR|BTC|ETH)$/.test(s)) return CLASS.CRYPTO;
  return CLASS.UNKNOWN;
}

/* Instruments that trade without a session. The distinction matters because a
   freshness check compares against the session: a quote from four hours ago is
   ordinary for a closed equity market and a fault for a cryptocurrency. */
function isContinuous(assetClass) {
  return assetClass === CLASS.CRYPTO;
}

/* Yields are quoted as percentages and carry no currency, but arrive filed
   under one. The index treatment already suppresses the currency mark; this
   marks the ones whose unit is a percentage so a label can say so. */
const YIELD_SYMBOLS = new Set(['^TNX', '^TYX', '^FVX', '^IRX']);

function isYield(symbol) {
  return YIELD_SYMBOLS.has(String(symbol || '').toUpperCase());
}

/* Build the model from a provider's normalised block.
 *
 * Every field is either a real value or null. There is no default price, no
 * zero volume standing in for an unreported one, and no invented tick size. A
 * consumer that needs a figure the provider did not supply must handle its
 * absence, which is the only way the absence stays visible. */
function build(input) {
  const raw = input || {};
  const symbol = normaliseSymbol(raw.symbol);
  if (!symbol) return null;

  const assetClass = classFromProvider(raw.instrumentType) || classFromSymbol(symbol);

  return {
    symbol,
    name: raw.name || null,
    assetClass,
    currency: raw.currency == null ? null : String(raw.currency),
    exchange: raw.exchange || null,
    exchangeName: raw.exchangeName || null,
    country: raw.country || null,

    /* Session windows and venue timezone; see src/core/clock.js. */
    session: raw.session || null,

    /* Contract mechanics. Null where the provider does not publish them, which
       is most of the time for anything that is not a future or an option. */
    tick: raw.tick == null ? null : Number(raw.tick),
    contractSize: raw.contractSize == null ? null : Number(raw.contractSize),
    expiry: raw.expiry == null ? null : Number(raw.expiry),
    strike: raw.strike == null ? null : Number(raw.strike),
    right: raw.right || null,

    /* The venue's own decimal-place hint, when it supplies one. Preferred over
       any rule this application could infer. */
    priceHint: raw.priceHint == null ? null : Number(raw.priceHint),

    quote: raw.quote || null,

    /* Where this came from and when. Never optional — a figure with no
       provenance cannot be shown, because the sources drawer would have
       nothing to say about it. */
    provenance: raw.provenance || null,

    isYield: isYield(symbol),
    continuous: isContinuous(assetClass)
  };
}

/* The quote block, built so that a missing field is null rather than absent.
   Callers destructure this shape constantly, and an undefined property reads as
   a typo where an explicit null reads as "not published". */
function quote(raw) {
  const q = raw || {};
  const n = v => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  return {
    last: n(q.last),
    bid: n(q.bid),
    ask: n(q.ask),
    bidSize: n(q.bidSize),
    askSize: n(q.askSize),
    open: n(q.open),
    previousClose: n(q.previousClose),
    dayHigh: n(q.dayHigh),
    dayLow: n(q.dayLow),
    yearHigh: n(q.yearHigh),
    yearLow: n(q.yearLow),
    volume: n(q.volume),
    averageVolume: n(q.averageVolume),
    openInterest: n(q.openInterest),
    marketCap: n(q.marketCap),
    /* The venue's stamp on the figure, in milliseconds. This is the single most
       important field in the application: it is what the freshness badge and
       every "as of" line are computed from. */
    at: n(q.at),

    /* A pre- or post-market print, when the session-gated quote endpoint
       could be reached and the venue itself currently declares one of those
       states. { state, price, changePercent, at } or null — never a stale
       leftover from a different session, because the adapter that builds
       this already checked the venue's own marketState before setting it. */
    extended: q.extended || null
  };
}

/* A stable key for caching and for store filenames. */
function key(symbol, timeframe) {
  return String(symbol || '').toUpperCase() + (timeframe ? '|' + timeframe : '');
}

module.exports = {
  SYMBOL, CLASS,
  normaliseSymbol, classFromProvider, classFromSymbol,
  isContinuous, isYield, build, quote, key
};
