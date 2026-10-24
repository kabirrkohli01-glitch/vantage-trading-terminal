'use strict';
/* Market data adapter: Cboe delayed quotes.
 *
 * This adapter exists for one purpose: to be a SECOND OPINION. The brief
 * requires that when sources disagree the disagreement is shown rather than
 * resolved silently, and a single provider cannot disagree with itself.
 *
 * It is an exchange operator publishing its own delayed feed, keyless, so it is
 * genuinely independent of the primary source rather than another reseller of
 * the same ticks. Coverage is US-listed equities, ETFs and index products —
 * it has nothing to say about London, futures, currency pairs or crypto, and
 * returns null for them rather than a guess.
 *
 * WHAT IT IS NOT USED FOR: deciding which price is correct. The endpoint is
 * explicitly a delayed one, so it will legitimately differ from a fresher
 * source by whatever the delay is, and treating small differences as errors
 * would fire constantly on healthy data. It is used to catch differences no
 * delay can explain — a decimal point in the wrong place, a stale figure from
 * a different day, a zero, an inverted sign. See src/market/integrity.js.
 */

const http = require('../../core/http');
const instrument = require('../instrument');
const { num } = require('../../core/num');

const NAME = 'cboe';
const LABEL = 'Cboe (delayed)';
const BASE = 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/';

/* This source describes its own endpoint as delayed but does not publish the
   interval anywhere in the response. `realtime: false` is therefore a fact it
   stated; `delaySeconds: null` is the honest answer to "by how much", and the
   freshness layer renders that as "Delayed" without inventing a number. */
function coverage() {
  return { realtime: false, delaySeconds: null };
}

/* Only US-listed symbols resolve here. Anything carrying an exchange suffix, a
   futures or currency marker belongs to another venue, and asking for it wastes
   a request to receive a 404. */
function supports(symbol) {
  const sym = instrument.normaliseSymbol(symbol);
  if (!sym) return false;
  if (sym.indexOf('.') !== -1) return false;   // exchange suffix: not US-listed
  if (sym.indexOf('=') !== -1) return false;   // currency pair or future
  if (/-(USD|USDT|EUR|GBP|BTC|ETH)$/.test(sym)) return false;
  return true;
}

/* The timestamp arrives as a wall-clock string with no zone marker.
 *
 * Guessing a zone would shift every figure by hours and produce a confidently
 * wrong age. Instead the field is parsed as US Eastern, the zone this venue
 * publishes in, and the result is sanity-checked against the moment of
 * retrieval: a parse that lands more than a day away from now is discarded and
 * the retrieval time is used instead, flagged so the caller knows the venue
 * stamp was unusable. */
function parseStamp(text, receivedAt) {
  const raw = String(text || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return { at: receivedAt, venueStamped: false };

  const [, y, mo, d, h, mi, s] = match.map(Number);
  /* Eastern time is UTC-5 or UTC-4. Both are tried and the one landing nearer
     the retrieval moment wins, which resolves the offset without a timezone
     database and without assuming which side of a transition today falls. */
  const candidates = [4, 5].map(offset => Date.UTC(y, mo - 1, d, h + offset, mi, s));
  let best = null;
  candidates.forEach(candidate => {
    const gap = Math.abs(candidate - receivedAt);
    if (best === null || gap < Math.abs(best - receivedAt)) best = candidate;
  });

  if (best === null || Math.abs(best - receivedAt) > 24 * 60 * 60 * 1000) {
    return { at: receivedAt, venueStamped: false };
  }
  return { at: best, venueStamped: true };
}

async function quote(symbol, options) {
  const opts = options || {};
  const sym = instrument.normaliseSymbol(symbol);
  if (!sym || !supports(sym)) return null;

  let res;
  try {
    res = await http.json(BASE + encodeURIComponent(sym) + '.json', {
      cacheMs: opts.cacheMs == null ? 60000 : opts.cacheMs
    });
  } catch (err) {
    /* A second opinion that cannot be reached is an absent second opinion, not
       a failure of the figure it was going to check. */
    return null;
  }

  const data = res.data && res.data.data;
  if (!data) return null;

  const stamp = parseStamp(res.data.timestamp, res.at);

  return {
    symbol: sym,
    last: num(data.current_price),
    bid: num(data.bid),
    ask: num(data.ask),
    bidSize: num(data.bid_size),
    askSize: num(data.ask_size),
    open: num(data.open),
    dayHigh: num(data.high),
    dayLow: num(data.low),
    previousClose: num(data.prev_day_close),
    volume: num(data.volume),
    /* This venue publishes a thirty-day implied volatility alongside the quote,
       which nothing else here supplies without an option chain. */
    iv30: num(data.iv30),
    at: stamp.at,
    venueStamped: stamp.venueStamped,
    provenance: {
      provider: NAME,
      providerLabel: LABEL,
      endpoint: 'global/delayed_quotes',
      symbol: sym,
      retrievedAt: res.at,
      cached: res.cached,
      note: stamp.venueStamped ? null : 'The venue timestamp could not be read; the retrieval time is shown instead.'
    }
  };
}

module.exports = { name: NAME, label: LABEL, coverage, supports, quote, parseStamp };
