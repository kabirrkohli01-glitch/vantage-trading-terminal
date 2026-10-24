'use strict';
/* Risk, exposure and position sizing.
 *
 * Two jobs. Describing the risk already carried, and answering what a proposed
 * trade would do to it BEFORE it is placed — the brief's own example being that
 * a trade would take one holding from eighteen per cent of the book to
 * twenty-seven.
 *
 * THE HONESTY CONSTRAINTS HERE ARE PARTICULARLY SHARP, because every figure in
 * this file is a number someone might size a position from.
 *
 *   A RISK FIGURE COMPUTED FROM PRICES THAT ARE NOT TRUSTWORTHY IS REFUSED, not
 *   caveated. Exposure derived from a stale quote is a wrong answer to the
 *   question "how much am I holding", and unlike a display figure it is one
 *   that gets acted on.
 *
 *   BETA, VOLATILITY AND CORRELATION NEED HISTORY, AND SAY HOW MUCH THEY HAD.
 *   A correlation over eleven observations is not a correlation. Every one of
 *   these returns the sample size beside the figure, and returns null rather
 *   than a number when the sample is too small to mean anything.
 *
 *   NOTHING HERE PRODUCES A RECOMMENDATION. The position calculator answers
 *   "what size makes this trade risk one per cent" — an arithmetic question
 *   with the operator's own inputs. It does not answer whether to take it.
 */

const { num } = require('../core/num');
const freshness = require('../market/freshness');
const { convertRate } = require('./valuation');

/* Below this many observations a statistic is noise wearing a number's
   clothes. Stated as a constant so every figure in this file uses the same
   threshold and reports it. */
const MIN_OBSERVATIONS = 30;

/* ---------- exposure ---------- */

/* What the book is exposed to, and how concentrated it is.
 *
 * Built from a valuation rather than from positions directly, so it inherits
 * the freshness, the caveat and the list of holdings that could not be priced. */
function exposure(valued, options) {
  const opts = options || {};
  if (!valued || !valued.holdings) return null;

  const priced = valued.holdings.filter(h => h.priced);
  const totals = valued.totals;

  if (!totals || !totals.marketValue) {
    return {
      usable: false,
      reason: valued.rateNote ||
        'Exposure needs a single total to measure against, and this book does not have one yet.',
      freshness: valued.freshness
    };
  }

  /* Exposure computed from figures that are not trustworthy would be acted on
     as though it were current. */
  const untrusted = priced.filter(h => h.freshness && !freshness.trustworthy(h.freshness.state));
  if (untrusted.length) {
    return {
      usable: false,
      reason: 'Exposure is not computed while ' + untrusted.length + ' holding' +
        (untrusted.length === 1 ? ' has' : 's have') + ' a price that cannot be relied on: ' +
        untrusted.map(h => h.symbol).join(', ') + '.',
      freshness: valued.freshness
    };
  }

  const gross = priced.reduce((sum, h) => sum + Math.abs(h.marketValue * rate(valued, h)), 0);
  const net = priced.reduce((sum, h) => sum + (h.marketValue * rate(valued, h)), 0);
  const equity = totals.equity == null ? totals.marketValue : totals.equity;

  const byInstrument = priced.map(h => ({
    symbol: h.symbol,
    name: h.name,
    value: h.marketValue * rate(valued, h),
    weight: (h.marketValue * rate(valued, h) / totals.marketValue) * 100,
    direction: h.direction
  })).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  const byClass = bucket(priced, h => h.assetClass || 'UNKNOWN', valued, totals.marketValue);
  const byCurrency = bucket(priced, h => h.quoteCurrency || h.currency || 'UNKNOWN', valued, totals.marketValue);

  /* Concentration, on the measure used for exactly this: the sum of squared
     shares. One holding gives 10,000; ten equal holdings give 1,000. */
  const herfindahl = byInstrument.reduce((sum, item) => sum + Math.pow(item.weight, 2), 0);

  return {
    usable: true,
    currency: totals.currency,
    grossExposure: gross,
    netExposure: net,
    equity,
    /* Above one, the book controls more than it holds. With no borrowing this
       is at most one; it is computed rather than assumed so an imported margin
       account reports honestly. */
    leverage: equity ? gross / equity : null,
    longValue: byInstrument.filter(i => i.value > 0).reduce((s, i) => s + i.value, 0),
    shortValue: Math.abs(byInstrument.filter(i => i.value < 0).reduce((s, i) => s + i.value, 0)),
    byInstrument,
    byClass,
    byCurrency,
    largest: byInstrument[0] || null,
    concentration: {
      herfindahl,
      /* The equivalent number of equally sized holdings this book behaves like.
         More legible than the index itself. */
      effectiveHoldings: herfindahl > 0 ? 10000 / herfindahl : null,
      topWeight: byInstrument.length ? Math.abs(byInstrument[0].weight) : 0,
      topThreeWeight: byInstrument.slice(0, 3).reduce((sum, i) => sum + Math.abs(i.weight), 0)
    },
    /* Non-account currencies are a second exposure the operator did not
       necessarily intend to take. */
    foreignCurrencyWeight: byCurrency
      .filter(entry => entry.name !== totals.currency)
      .reduce((sum, entry) => sum + entry.weight, 0),
    freshness: valued.freshness,
    caveat: valued.caveat,
    incompleteNote: valued.incompleteNote,
    thresholds: opts.thresholds || DEFAULT_THRESHOLDS
  };
}

function rate(valued, holding) {
  return convertRate({}, holding.quoteCurrency || holding.currency, valued.accountCurrency).rate;
}

function bucket(holdings, keyOf, valued, total) {
  const groups = new Map();
  holdings.forEach(holding => {
    const key = keyOf(holding);
    const value = holding.marketValue * rate(valued, holding);
    if (!groups.has(key)) groups.set(key, { name: key, value: 0, count: 0 });
    const group = groups.get(key);
    group.value += value;
    group.count++;
  });
  return Array.from(groups.values())
    .map(group => Object.assign(group, { weight: (group.value / total) * 100 }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
}

/* Where the interface draws attention. These are the operator's own settings,
   with defaults that are deliberately unremarkable — they are prompts to look,
   not judgements. */
const DEFAULT_THRESHOLDS = {
  singlePositionWeight: 25,
  topThreeWeight: 60,
  foreignCurrencyWeight: 50,
  classWeight: 60,
  leverage: 1
};

/* Observations rather than instructions: each says what is true and what it is
   measured against, and stops there. */
function observations(exposureReport) {
  if (!exposureReport || !exposureReport.usable) return [];
  const limits = exposureReport.thresholds;
  const out = [];

  const largest = exposureReport.largest;
  if (largest && Math.abs(largest.weight) > limits.singlePositionWeight) {
    out.push({
      kind: 'concentration.single',
      text: largest.symbol + ' is ' + largest.weight.toFixed(1) + '% of this book, above the ' +
        limits.singlePositionWeight + '% you asked to be told about.'
    });
  }

  if (exposureReport.concentration.topThreeWeight > limits.topThreeWeight) {
    out.push({
      kind: 'concentration.top',
      text: 'The largest three holdings are ' + exposureReport.concentration.topThreeWeight.toFixed(1) +
        '% of this book.'
    });
  }

  exposureReport.byClass.forEach(entry => {
    if (Math.abs(entry.weight) > limits.classWeight) {
      out.push({
        kind: 'concentration.class',
        text: entry.name.toLowerCase() + ' is ' + entry.weight.toFixed(1) + '% of this book.'
      });
    }
  });

  if (exposureReport.foreignCurrencyWeight > limits.foreignCurrencyWeight) {
    out.push({
      kind: 'exposure.currency',
      text: exposureReport.foreignCurrencyWeight.toFixed(1) + '% of this book is priced in a currency ' +
        'other than ' + exposureReport.currency + ', so its value moves with exchange rates as well as prices.'
    });
  }

  if (exposureReport.leverage !== null && exposureReport.leverage > limits.leverage + 1e-9) {
    out.push({
      kind: 'exposure.leverage',
      text: 'Gross exposure is ' + exposureReport.leverage.toFixed(2) + ' times equity.'
    });
  }

  return out;
}

/* ---------- statistics over returns ---------- */

function returnsFrom(bars) {
  const out = [];
  for (let i = 1; i < (bars || []).length; i++) {
    const previous = num(bars[i - 1].c);
    const current = num(bars[i].c);
    if (previous === null || current === null || previous === 0) continue;
    out.push((current - previous) / previous);
  }
  return out;
}

function mean(values) {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

/* Sample standard deviation, annualised by the number of periods in a year.
 * Sample rather than population: these returns are a sample of the process that
 * produced them, not the whole of it. */
function volatility(bars, periodsPerYear) {
  const returns = returnsFrom(bars);
  if (returns.length < MIN_OBSERVATIONS) {
    return { value: null, observations: returns.length, note: shortNote(returns.length) };
  }
  const average = mean(returns);
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - average, 2), 0) / (returns.length - 1);
  const periods = periodsPerYear || 252;
  return {
    value: Math.sqrt(variance) * Math.sqrt(periods) * 100,
    daily: Math.sqrt(variance) * 100,
    observations: returns.length,
    annualisedOver: periods,
    note: null
  };
}

function shortNote(count) {
  return 'Not computed: ' + count + ' observation' + (count === 1 ? '' : 's') +
    ', and at least ' + MIN_OBSERVATIONS + ' are needed for this to mean anything.';
}

/* Correlation of two return series, aligned by timestamp.
 *
 * Aligning matters: two instruments on different exchanges have different
 * holidays and different halts, and zipping the arrays by index silently pairs
 * Tuesday with Wednesday from partway through. */
function correlation(barsA, barsB) {
  const mapB = new Map();
  (barsB || []).forEach(bar => mapB.set(bar.t, bar.c));

  const pairs = [];
  for (let i = 1; i < (barsA || []).length; i++) {
    const previousA = num(barsA[i - 1].c);
    const currentA = num(barsA[i].c);
    const previousB = num(mapB.get(barsA[i - 1].t));
    const currentB = num(mapB.get(barsA[i].t));
    if (previousA === null || currentA === null || previousB === null || currentB === null) continue;
    if (previousA === 0 || previousB === 0) continue;
    pairs.push([(currentA - previousA) / previousA, (currentB - previousB) / previousB]);
  }

  if (pairs.length < MIN_OBSERVATIONS) {
    return { value: null, observations: pairs.length, note: shortNote(pairs.length) };
  }

  const xs = pairs.map(p => p[0]);
  const ys = pairs.map(p => p[1]);
  const mx = mean(xs);
  const my = mean(ys);

  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  pairs.forEach(([x, y]) => {
    covariance += (x - mx) * (y - my);
    varianceX += Math.pow(x - mx, 2);
    varianceY += Math.pow(y - my, 2);
  });

  const denominator = Math.sqrt(varianceX * varianceY);
  if (denominator === 0) {
    return { value: null, observations: pairs.length, note: 'One of these did not move at all over the period.' };
  }
  return { value: covariance / denominator, observations: pairs.length, note: null };
}

/* Beta against a benchmark: how much this instrument moved for each unit the
   benchmark moved, over the same aligned observations. */
function beta(barsInstrument, barsBenchmark) {
  const mapB = new Map();
  (barsBenchmark || []).forEach(bar => mapB.set(bar.t, bar.c));

  const pairs = [];
  for (let i = 1; i < (barsInstrument || []).length; i++) {
    const pa = num(barsInstrument[i - 1].c);
    const ca = num(barsInstrument[i].c);
    const pb = num(mapB.get(barsInstrument[i - 1].t));
    const cb = num(mapB.get(barsInstrument[i].t));
    if (pa === null || ca === null || pb === null || cb === null || pa === 0 || pb === 0) continue;
    pairs.push([(ca - pa) / pa, (cb - pb) / pb]);
  }

  if (pairs.length < MIN_OBSERVATIONS) {
    return { value: null, observations: pairs.length, note: shortNote(pairs.length) };
  }

  const xs = pairs.map(p => p[1]);   // the benchmark
  const ys = pairs.map(p => p[0]);   // the instrument
  const mx = mean(xs);
  const my = mean(ys);

  let covariance = 0;
  let variance = 0;
  pairs.forEach(([y, x]) => {
    covariance += (x - mx) * (y - my);
    variance += Math.pow(x - mx, 2);
  });

  if (variance === 0) {
    return { value: null, observations: pairs.length, note: 'The benchmark did not move over the period.' };
  }
  return { value: covariance / variance, observations: pairs.length, note: null };
}

/* Largest peak-to-trough fall in a price series, and how long it lasted. */
function drawdown(bars) {
  let peak = null;
  let peakAt = null;
  let worst = 0;
  let worstFrom = null;
  let worstTo = null;

  (bars || []).forEach(bar => {
    const close = num(bar.c);
    if (close === null) return;
    if (peak === null || close > peak) { peak = close; peakAt = bar.t; }
    const fall = peak === 0 ? 0 : (peak - close) / peak;
    if (fall > worst) { worst = fall; worstFrom = peakAt; worstTo = bar.t; }
  });

  return {
    value: worst * 100,
    from: worstFrom,
    to: worstTo,
    days: (worstFrom && worstTo) ? Math.round((worstTo - worstFrom) / (24 * 60 * 60 * 1000)) : null
  };
}

/* ---------- position sizing ---------- */

/* What size makes this trade risk a stated amount.
 *
 * Pure arithmetic over the operator's own inputs, and it refuses rather than
 * guesses when an input is missing. In particular a stop is required: without
 * one there is no defined loss, and therefore no size that risks a known
 * amount. Substituting an assumed stop would produce a confident number
 * answering a question nobody asked. */
function sizePosition(input) {
  const it = input || {};
  const equity = num(it.equity);
  const entry = num(it.entry);
  const stop = num(it.stop);
  const target = num(it.target);
  const riskPct = num(it.riskPercent);
  const riskAmountGiven = num(it.riskAmount);
  const fees = num(it.fees) || 0;

  const problems = [];
  if (equity === null || equity <= 0) problems.push('an account value');
  if (entry === null || entry <= 0) problems.push('an entry price');
  if (stop === null) problems.push('a stop — without one there is no defined loss to size against');
  if (riskPct === null && riskAmountGiven === null) problems.push('how much to risk');

  if (problems.length) {
    return { usable: false, reason: 'This needs ' + problems.join(', ') + '.' };
  }

  const perUnit = Math.abs(entry - stop);
  if (perUnit === 0) {
    return { usable: false, reason: 'The stop is at the entry price, so the risk per unit is zero.' };
  }

  const riskAmount = riskAmountGiven !== null ? riskAmountGiven : equity * (riskPct / 100);
  const rawQuantity = riskAmount / perUnit;
  const quantity = it.wholeUnits === false ? rawQuantity : Math.floor(rawQuantity);

  const direction = stop < entry ? 'long' : 'short';
  const capital = quantity * entry;
  const maxLoss = quantity * perUnit + fees;
  const reward = target === null ? null : Math.abs(target - entry) * quantity;

  return {
    usable: true,
    direction,
    quantity,
    fractionalQuantity: rawQuantity,
    riskPerUnit: perUnit,
    riskAmount,
    riskPercentOfEquity: (maxLoss / equity) * 100,
    capitalRequired: capital,
    capitalPercentOfEquity: (capital / equity) * 100,
    maxLoss,
    potentialProfit: reward,
    rewardToRisk: (reward !== null && maxLoss > 0) ? reward / maxLoss : null,
    /* Rounding down to whole units means the realised risk is slightly under
       the target. Stating the difference stops it being read as exact. */
    rounding: quantity === rawQuantity ? null
      : 'Rounded down from ' + rawQuantity.toFixed(4) + ' units, so the risk taken is ' +
        ((quantity * perUnit / riskAmount) * 100).toFixed(1) + '% of the amount you set.',
    zeroSize: quantity <= 0
      ? 'The amount you are willing to risk is smaller than the distance to your stop on one unit.' : null
  };
}

/* What a proposed trade would do to the book it lands in.
 *
 * The brief's example is the shape of the answer: a before and an after for the
 * weight of the instrument being added to. */
function impactOf(exposureReport, proposed) {
  if (!exposureReport || !exposureReport.usable) {
    return { usable: false, reason: exposureReport ? exposureReport.reason : 'No exposure is available.' };
  }

  const symbol = String(proposed.symbol || '').toUpperCase();
  const value = num(proposed.value);
  if (!symbol || value === null) {
    return { usable: false, reason: 'A proposed trade needs an instrument and a value.' };
  }

  const existing = exposureReport.byInstrument.find(item => item.symbol === symbol);
  const beforeValue = existing ? existing.value : 0;
  const afterValue = beforeValue + value;

  const beforeTotal = exposureReport.byInstrument.reduce((sum, item) => sum + Math.abs(item.value), 0);
  const afterTotal = beforeTotal - Math.abs(beforeValue) + Math.abs(afterValue);

  const beforeWeight = beforeTotal ? (beforeValue / beforeTotal) * 100 : 0;
  const afterWeight = afterTotal ? (afterValue / afterTotal) * 100 : 0;

  const notes = [];
  const limit = exposureReport.thresholds.singlePositionWeight;
  if (Math.abs(afterWeight) > limit && Math.abs(beforeWeight) <= limit) {
    notes.push('This would take ' + symbol + ' past the ' + limit + '% share you asked to be told about.');
  }

  return {
    usable: true,
    symbol,
    currency: exposureReport.currency,
    beforeValue,
    afterValue,
    beforeWeight,
    afterWeight,
    /* Phrased as the brief asks: a before and an after, with no verdict. */
    summary: symbol + ' would go from ' + beforeWeight.toFixed(1) + '% to ' +
      afterWeight.toFixed(1) + '% of this book.',
    notes
  };
}

module.exports = {
  exposure, observations, sizePosition, impactOf,
  volatility, correlation, beta, drawdown, returnsFrom,
  MIN_OBSERVATIONS, DEFAULT_THRESHOLDS
};
