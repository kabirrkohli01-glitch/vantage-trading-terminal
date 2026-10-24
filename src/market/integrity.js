'use strict';
/* Data integrity checks and the safe-data kill switch.
 *
 * The application's governing rule is that it must never manufacture financial
 * information. This file is where that rule is given teeth: figures are tested
 * before they are trusted, and when a test fails the application says so and
 * withdraws the features that would act on a bad number.
 *
 * TWO SEVERITIES, AND THE DIFFERENCE MATTERS.
 *
 *   warn   Something is worth showing the operator. Sources differ, a venue
 *          stamp could not be read, a figure sits outside its own stated range.
 *          The figure is still displayed, with the finding attached.
 *
 *   block  The figure cannot be believed at all — a decimal point in the wrong
 *          place, a sign inversion, a price of zero on a traded instrument, a
 *          timestamp from another day. This enters SAFE DATA MODE.
 *
 * WHAT SAFE DATA MODE DOES: research, charts and reading continue, because
 * withdrawing them would leave the operator with no way to investigate. What
 * stops is anything that ACTS on a figure — simulated fills and alert firing.
 * There is no live order path in this application at all, so there is nothing
 * further to withhold.
 *
 * WHY THE THRESHOLDS BELOW ARE SHAPED THE WAY THEY ARE: a second source here is
 * a delayed one, so it will legitimately differ from a fresher source by
 * whatever the delay is, and during a fast move that difference can be several
 * percent on perfectly healthy data. Tuning a tight percentage would fire
 * constantly and train the operator to ignore the badge that matters. So
 * disagreement is only reported, never blocking, while the blocking checks look
 * for differences no delay can produce.
 */

const { num } = require('../core/num');
const { CLASS } = require('../core/num');

const SEVERITY = { WARN: 'warn', BLOCK: 'block' };

/* A ratio this close to a power of ten is a decimal-point error, not a price
   move. Nothing in a market travels by exactly ten times between two reads of
   the same instrument. */
const DECIMAL_FACTORS = [0.001, 0.01, 0.1, 10, 100, 1000];
const DECIMAL_TOLERANCE = 0.02;

/* Beyond this, two sources are telling materially different stories and the
   operator should see both. Reported, never blocking. */
const DISAGREEMENT_PCT = 5;

/* Instruments whose price genuinely cannot be negative. Futures are absent from
   this list on purpose: a crude oil contract settled below zero in April 2020,
   and a rule that refuses negative futures prices would have called the single
   most important print in that market's history a data error. */
const NEVER_NEGATIVE = new Set([CLASS.EQUITY, CLASS.ETF, CLASS.CRYPTO, CLASS.CURRENCY]);

function finding(code, severity, detail, extra) {
  return Object.assign({ code, severity, detail, at: Date.now() }, extra || {});
}

/* ---------- checks on a single figure ---------- */

function checkQuote(model) {
  const out = [];
  if (!model || !model.quote) return out;

  const q = model.quote;
  const symbol = model.symbol;
  const kind = model.assetClass;

  if (q.last === null) return out;   // an absent price is handled by freshness, not here

  if (q.last === 0) {
    out.push(finding('price.zero', SEVERITY.BLOCK,
      'The source reported a price of exactly zero for ' + symbol + '. A traded instrument does not print at zero.',
      { symbol }));
  }

  if (q.last < 0 && NEVER_NEGATIVE.has(kind)) {
    out.push(finding('price.negative', SEVERITY.BLOCK,
      'The source reported a negative price for ' + symbol + ', which this asset class cannot have.',
      { symbol }));
  }

  if (q.dayHigh !== null && q.dayLow !== null && q.dayLow > q.dayHigh) {
    out.push(finding('range.inverted', SEVERITY.BLOCK,
      'The session low is above the session high for ' + symbol + '.',
      { symbol, dayHigh: q.dayHigh, dayLow: q.dayLow }));
  }

  /* A last price outside its own session range is a real inconsistency, but a
     small overshoot is ordinary: the range and the last trade are frequently
     stamped a beat apart. Only a clear break is worth reporting. */
  if (q.dayHigh !== null && q.last > q.dayHigh * 1.001) {
    out.push(finding('price.aboveRange', SEVERITY.WARN,
      'The last price for ' + symbol + ' is above the session high the same source reported.',
      { symbol, last: q.last, dayHigh: q.dayHigh }));
  }
  if (q.dayLow !== null && q.last < q.dayLow * 0.999) {
    out.push(finding('price.belowRange', SEVERITY.WARN,
      'The last price for ' + symbol + ' is below the session low the same source reported.',
      { symbol, last: q.last, dayLow: q.dayLow }));
  }

  if (q.bid !== null && q.ask !== null && q.bid > q.ask) {
    out.push(finding('book.crossed', SEVERITY.WARN,
      'The bid is above the ask for ' + symbol + '. The book as received is crossed.',
      { symbol, bid: q.bid, ask: q.ask }));
  }

  /* A previous close ten times away from the last price is a corporate action
     that has been applied to one field and not the other — most often a split.
     Every percentage change computed from that pair would be wrong. */
  if (q.previousClose !== null && q.previousClose > 0 && q.last > 0) {
    const factor = decimalFactor(q.last / q.previousClose);
    if (factor) {
      out.push(finding('close.decimalShift', SEVERITY.BLOCK,
        'The previous close for ' + symbol + ' is ' + factor + ' times away from the last price. ' +
        'This is a corporate action applied to one figure and not the other, not a price move.',
        { symbol, last: q.last, previousClose: q.previousClose, factor }));
    }
  }

  return out;
}

/* Whether a ratio is close enough to a power of ten to be a misplaced decimal
   point rather than a price move. */
function decimalFactor(ratio) {
  const r = Number(ratio);
  if (!Number.isFinite(r) || r <= 0) return null;
  for (const factor of DECIMAL_FACTORS) {
    if (Math.abs(r - factor) / factor < DECIMAL_TOLERANCE) return factor;
  }
  return null;
}

/* ---------- checks across two sources ---------- */

function crossCheck(primary, secondary) {
  const out = [];
  const a = num(primary && primary.last);
  const b = num(secondary && secondary.last);
  const symbol = (primary && primary.symbol) || (secondary && secondary.symbol) || null;
  if (a === null || b === null || a <= 0 || b <= 0) return out;

  const ratio = a / b;

  const factor = decimalFactor(ratio);
  if (factor) {
    out.push(finding('cross.decimalShift', SEVERITY.BLOCK,
      'Two sources differ by a factor of ' + factor + ' on ' + symbol +
      '. One of them has the decimal point in the wrong place.',
      { symbol, primary: a, secondary: b, factor,
        sources: [primary.provider, secondary.provider] }));
    return out;
  }

  if ((a > 0) !== (b > 0)) {
    out.push(finding('cross.signFlip', SEVERITY.BLOCK,
      'Two sources disagree on the sign of ' + symbol + '.',
      { symbol, primary: a, secondary: b }));
    return out;
  }

  const gapPct = Math.abs(a - b) / ((a + b) / 2) * 100;
  if (gapPct > DISAGREEMENT_PCT) {
    /* Reported, not blocking. One of these sources is explicitly delayed, and a
       fast move opens a gap of this size on data that is working correctly. */
    out.push(finding('cross.disagreement', SEVERITY.WARN,
      'Sources disagree on ' + symbol + ' by ' + gapPct.toFixed(1) + '%. ' +
      'One of them publishes delayed prices, which accounts for part of any gap.',
      { symbol, primary: a, secondary: b, gapPct,
        sources: [primary.provider, secondary.provider] }));
  }

  return out;
}

/* ---------- checks across time ---------- */

/* A move between two consecutive reads of the same instrument.
 *
 * The thresholds are per asset class because the asset classes genuinely
 * differ: a currency pair moving five percent between two polls seconds apart
 * is a broken feed, while a cryptocurrency doing the same is a Tuesday. These
 * are set well above real volatility so that what they catch is corruption
 * rather than news. */
const MOVE_LIMIT = {
  CURRENCY: 5,
  BOND: 10,
  INDEX: 15,
  EQUITY: 35,
  ETF: 35,
  FUTURE: 35,
  COMMODITY: 35,
  CRYPTO: 50,
  OPTION: 200,
  UNKNOWN: 50
};

function checkMove(previous, current) {
  const out = [];
  const before = num(previous && previous.last);
  const now = num(current && current.last);
  if (before === null || now === null || before <= 0) return out;

  const symbol = current.symbol || null;
  const ratio = now / before;

  const factor = decimalFactor(ratio);
  if (factor) {
    out.push(finding('move.decimalShift', SEVERITY.BLOCK,
      'The price of ' + symbol + ' changed by a factor of ' + factor + ' between two reads. ' +
      'That is a decimal point moving, not a market.',
      { symbol, before, now, factor }));
    return out;
  }

  /* Elapsed time matters: a large gap between reads legitimately spans a
     larger move, including a whole weekend. The limit is only meaningful for
     reads close together. */
  const elapsed = Math.abs(num(current.at) - num(previous.at));
  if (!Number.isFinite(elapsed) || elapsed > 10 * 60 * 1000) return out;

  const limit = MOVE_LIMIT[current.assetClass] || MOVE_LIMIT.UNKNOWN;
  const movePct = Math.abs(now - before) / before * 100;
  if (movePct > limit) {
    out.push(finding('move.impossible', SEVERITY.BLOCK,
      symbol + ' moved ' + movePct.toFixed(1) + '% within ' + Math.round(elapsed / 1000) +
      ' seconds, beyond anything this asset class does. The feed is more likely wrong than the market.',
      { symbol, before, now, movePct, elapsed }));
  }

  return out;
}

/* ---------- the mode ---------- */

/* Hysteresis. Entering on the first bad figure is correct; leaving on the first
   good one is not, because a feed that alternates between correct and corrupt
   would flap the badge and the operator would learn to ignore it. */
const CLEAR_RUNS_REQUIRED = 3;

class SafeMode {
  constructor(options) {
    const opts = options || {};
    this.audit = opts.audit || null;
    this.active = false;
    this.since = null;
    this.reasons = [];
    this.warnings = [];
    this.clearRuns = 0;
    this.listeners = [];
  }

  /* Feed a batch of findings from one evaluation cycle. */
  observe(findings) {
    const list = (findings || []).filter(Boolean);
    const blocking = list.filter(f => f.severity === SEVERITY.BLOCK);

    this.warnings = list.filter(f => f.severity === SEVERITY.WARN).slice(0, 50);

    if (blocking.length) {
      this.clearRuns = 0;
      const wasActive = this.active;
      this.reasons = blocking.slice(0, 20);
      if (!wasActive) {
        this.active = true;
        this.since = Date.now();
        this.record('safemode.entered', { reasons: this.reasons.map(r => r.code), detail: this.reasons[0].detail });
        this.emit();
      }
      return this.state();
    }

    if (this.active) {
      this.clearRuns++;
      if (this.clearRuns >= CLEAR_RUNS_REQUIRED) {
        this.active = false;
        this.reasons = [];
        this.clearRuns = 0;
        this.record('safemode.left', { after: Date.now() - (this.since || Date.now()) });
        this.since = null;
        this.emit();
      }
    }
    return this.state();
  }

  /* Raised by anything outside the figure checks: a provider that stopped
     answering, a broken connection, a clock that cannot be trusted. */
  fault(code, detail, extra) {
    return this.observe([finding(code, SEVERITY.BLOCK, detail, extra)]);
  }

  state() {
    return {
      active: this.active,
      since: this.since,
      reasons: this.reasons.slice(),
      warnings: this.warnings.slice(),
      /* Named so that a caller reads what is withheld rather than inferring it.
         Research is deliberately absent from this list: it stays available. */
      suspended: this.active ? ['simulated fills', 'alerts'] : []
    };
  }

  /* The one question the rest of the application asks. */
  allows(action) {
    if (!this.active) return true;
    return action !== 'fill' && action !== 'alert';
  }

  record(kind, detail) {
    if (this.audit) this.audit.write(kind, detail);
  }

  onChange(fn) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(f => f !== fn); };
  }

  emit() {
    const state = this.state();
    this.listeners.forEach(fn => { try { fn(state); } catch (e) { /* a listener must not break the switch */ } });
  }
}

module.exports = {
  SEVERITY, MOVE_LIMIT, DISAGREEMENT_PCT, CLEAR_RUNS_REQUIRED,
  checkQuote, crossCheck, checkMove, decimalFactor, finding, SafeMode
};
