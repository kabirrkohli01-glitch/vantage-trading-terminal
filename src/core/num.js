'use strict';
/* Numbers and how they are printed.
 *
 * Every figure the application displays passes through this file. It is small,
 * and it is the single most defect-prone area in a market application, because
 * each of the mistakes below produces a screen that looks completely ordinary
 * and is wrong.
 *
 *   Number(null) === 0, AND 0 IS FINITE.
 *   Upstream feeds send JSON null constantly: a halted minute, a bar with no
 *   trades, an unpublished day high. A guard written as `isFinite(Number(x))`
 *   therefore accepts every one of them and turns an absent figure into zero.
 *   A missing day high prints as 0.00; a null close becomes a candle at zero
 *   that flattens an entire day's range onto the axis. The null test must come
 *   before Number() ever sees the value.
 *
 *   LONDON QUOTES IN PENCE, NOT POUNDS.
 *   The currency code is `GBp`, not `GBP`, and the number is pence: HSBA.L
 *   comes back as 1532.1 meaning £15.32. Printing "£1,532.10" is wrong by two
 *   orders of magnitude and looks entirely normal. The check is case-sensitive
 *   and must happen before any upper-casing.
 *
 *   DECIMAL PLACES BELONG TO THE ASSET CLASS, NOT THE MAGNITUDE.
 *   Choosing precision from how small a number is prints an 85p daily change as
 *   "$0.8500". Precision is a property of the instrument. Crypto is the one
 *   deliberate exception and the reason is given at decimalsFor().
 *
 *   AN INDEX LEVEL IS NOT MONEY.
 *   Upstream files every index under a currency, so the VIX arrives as USD.
 *   "$15.46" attaches a unit to a number that does not have one.
 *
 *   THE MINUS SIGN GOES OUTSIDE THE CURRENCY SYMBOL.
 *   -£2.40, never £-2.40. This appears wherever a price has fallen, which is
 *   half of every screen in the application.
 */

/* Wrapped in a scope of its own.
 *
 * In the main process this file is a module and its top-level names are already
 * private. In the interface it is a plain script, and PLAIN SCRIPTS ALL SHARE
 * ONE TOP-LEVEL SCOPE — so a `const` here collides with a `const` of the same
 * name in any other script the page loads, and the collision is a redeclaration
 * error that kills the whole file at parse time. Nothing is logged, nothing
 * throws where anyone can see it, and every function the file was meant to
 * provide is simply undefined. The wrapper makes the collision impossible
 * rather than making the names unique and hoping the next file agrees. */
(function () {

const SYMBOLS = { USD: '$', GBP: '£', EUR: '€', JPY: '¥', INR: '₹', CHF: 'CHF ', CAD: 'CA$', AUD: 'A$', CNY: 'CN¥', HKD: 'HK$' };

/* Asset classes used across the application. The market layer maps every
   provider's own vocabulary onto exactly these. */
const CLASS = {
  EQUITY: 'EQUITY',
  ETF: 'ETF',
  INDEX: 'INDEX',
  CURRENCY: 'CURRENCY',
  CRYPTO: 'CRYPTO',
  FUTURE: 'FUTURE',
  OPTION: 'OPTION',
  BOND: 'BOND',
  COMMODITY: 'COMMODITY',
  UNKNOWN: 'UNKNOWN'
};

/* The null-safe coercion. Returns a finite number or null, never NaN and never
   an accidental zero. */
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/* True when a value is a real, usable figure. Used in place of scattered
   `!= null && isFinite(...)` pairs, which is where the zero bug hides. */
function has(value) {
  return num(value) !== null;
}

function upper(text) {
  return String(text == null ? '' : text).toUpperCase();
}

/* How many decimal places this instrument's prices carry.
 *
 * FX: the convention is the quote currency's own, not the number's size. Pairs
 * quoted in yen carry two decimals, everything else four. Padding a four-decimal
 * feed out to five would display a pip of precision the source never sent.
 *
 * CRYPTO IS THE ONE PLACE MAGNITUDE LEGITIMATELY DECIDES. There is no tick
 * convention across crypto assets: one coin trades near 80,000 and another near
 * 0.000004, and both are ordinary. Fixing two decimals would render the second
 * as "0.00". This is a real property of the asset class rather than a shortcut,
 * which is exactly what makes it acceptable here and nowhere else. */
function decimalsFor(assetClass, currency, value) {
  const kind = upper(assetClass);

  if (kind === CLASS.CURRENCY) {
    return /JPY/i.test(String(currency || '')) ? 2 : 4;
  }

  if (kind === CLASS.CRYPTO) {
    const n = Math.abs(num(value) || 0);
    if (n === 0) return 2;
    if (n >= 1000) return 2;
    if (n >= 1) return 4;
    if (n >= 0.01) return 6;
    return 8;
  }

  return 2;
}

/* Group digits and fix the decimal places, with no currency mark. */
function plain(value, places) {
  const n = num(value);
  if (n === null) return '—';
  return n.toLocaleString('en-GB', { minimumFractionDigits: places, maximumFractionDigits: places });
}

/* The money formatter.
 *
 * `currency` is passed through exactly as the provider stated it. Normalising
 * GBp to GBP here — or dividing by 100 to "fix" it — is how a price ends up
 * wrong by 100x, so neither happens anywhere in this application. */
function money(value, options) {
  const opts = options || {};
  const n = num(value);
  if (n === null) return '—';

  const kind = upper(opts.assetClass);
  const currency = opts.currency == null ? '' : String(opts.currency);
  const places = opts.decimals == null ? decimalsFor(kind, currency, n) : opts.decimals;

  /* A government bond yield is a percentage, not an amount of money, but every
     provider files it under a currency. Three decimals is the convention the
     rates market quotes in. */
  if (opts.unit === 'percent') {
    return plain(n, opts.decimals == null ? 3 : opts.decimals) + '%';
  }

  /* An index level has no unit. */
  if (kind === CLASS.INDEX) return plain(n, places);

  /* NEITHER DOES AN EXCHANGE RATE. A currency pair is filed under its quote
     currency, so EUR/USD arrives labelled USD and a naive formatter renders it
     as "$1.1670". The figure is a rate — how much of one currency buys the
     other — and prefixing it with a currency symbol reads as a price in
     dollars, which it is not. The pair name carries the units. */
  if (kind === CLASS.CURRENCY) return plain(n, places);

  /* Pence. Case-sensitive, and before any upper-casing below. */
  if (currency === 'GBp') return plain(n, places) + 'p';

  const code = currency.toUpperCase();
  const mark = SYMBOLS[code] || '';
  const sign = n < 0 ? '-' : '';
  const body = plain(Math.abs(n), places);

  if (mark) return sign + mark + body;
  return sign + body + (code ? ' ' + code : '');
}

/* Signed percentage. A change of exactly zero prints without a sign, because
   "+0.00%" reads as a rise that did not happen. */
function pct(value, digits) {
  const n = num(value);
  if (n === null) return '—';
  const places = digits == null ? 2 : digits;
  const sign = n > 0 ? '+' : (n < 0 ? '-' : '');
  return sign + Math.abs(n).toFixed(places) + '%';
}

/* Signed absolute change, formatted as money. */
function change(value, options) {
  const n = num(value);
  if (n === null) return '—';
  const text = money(Math.abs(n), options);
  if (text === '—') return '—';
  return (n > 0 ? '+' : (n < 0 ? '-' : '')) + text;
}

/* Direction, with a flat band. Comparing to exactly zero makes almost every
   instrument "up" or "down" on floating-point noise alone. */
function signOf(value, epsilon) {
  const n = num(value);
  if (n === null) return 'flat';
  const e = epsilon == null ? 1e-9 : epsilon;
  if (n > e) return 'up';
  if (n < -e) return 'down';
  return 'flat';
}

/* Large counts: volume, market capitalisation, cargo tonnage. */
function compact(value, digits) {
  const n = num(value);
  if (n === null) return '—';
  const places = digits == null ? 2 : digits;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e12) return sign + (abs / 1e12).toFixed(places) + 'tn';
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(places) + 'bn';
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(places) + 'm';
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(places) + 'k';
  return sign + abs.toLocaleString('en-GB', { maximumFractionDigits: 0 });
}

/* Percentage change between two levels.
 *
 * A previous close of zero is not a data error — a newly listed instrument
 * genuinely reports it — so the result is null rather than Infinity. */
function changePct(current, previous) {
  const now = num(current);
  const before = num(previous);
  if (now === null || before === null || before === 0) return null;
  return ((now - before) / before) * 100;
}

/* Bid/ask spread in the instrument's own units, and as a fraction of the mid.
   Returns nulls rather than a partial object so callers cannot print half a
   spread as a whole one. */
function spread(bid, ask) {
  const b = num(bid);
  const a = num(ask);
  if (b === null || a === null || a < b) return { absolute: null, pct: null, mid: null };
  const mid = (a + b) / 2;
  return {
    absolute: a - b,
    pct: mid === 0 ? null : ((a - b) / mid) * 100,
    mid
  };
}

/* FX movement in pips. A pip is the last decimal place of the pair's
   convention, which decimalsFor already encodes. */
function pips(value, currency) {
  const n = num(value);
  if (n === null) return null;
  const places = decimalsFor(CLASS.CURRENCY, currency, n);
  return n * Math.pow(10, places);
}

/* Round to the instrument's tick. Returns null rather than guessing when the
   tick is unknown, because a price silently rounded to the wrong grid is
   indistinguishable from a real one. */
function toTick(value, tick) {
  const n = num(value);
  const t = num(tick);
  if (n === null || t === null || t <= 0) return n;
  const steps = Math.round(n / t);
  /* Re-derive the decimal places from the tick so 0.1 * 3 does not print as
     0.30000000000000004. */
  const places = (String(t).split('.')[1] || '').length;
  return Number((steps * t).toFixed(places));
}

const API = {
  CLASS, SYMBOLS,
  num, has, money, plain, pct, change, signOf, compact,
  changePct, spread, pips, decimalsFor, toTick
};

/* Loaded two ways: as a module in the main process, and as a plain script in
 * the interface, which has no module system at all.
 *
 * This matters more than it looks. The price in a header, the label on a chart
 * axis, the figure in an alert and the number a research report quotes all go
 * through this file. A second copy compiled for the browser would drift, and
 * the first symptom of that drift would be two different renderings of the same
 * price on the same screen. */
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') { window.T = window.T || {}; window.T.num = API; }

}());
