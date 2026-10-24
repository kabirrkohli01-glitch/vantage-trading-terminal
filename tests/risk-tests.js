'use strict';
/* Risk tests.
 *
 * Every figure here is one a position could be sized from, so the suites below
 * check two things in equal measure: that the arithmetic is right, and that a
 * figure which cannot honestly be produced is refused rather than approximated.
 */

const risk = require('../src/portfolio/risk');

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.parse('2026-01-05T00:00:00Z');

/* A valuation shaped the way the valuation layer produces one. */
function valued(holdings, extra) {
  const marketValue = holdings.reduce((sum, h) => sum + h.marketValue, 0);
  return Object.assign({
    book: 'mirror',
    accountCurrency: 'GBP',
    caveat: 'Entered by hand and not verified against a broker.',
    freshness: { state: 'DELAYED', label: 'Delayed' },
    holdings: holdings.map(h => Object.assign({
      priced: true, currency: 'GBP', quoteCurrency: 'GBP',
      assetClass: 'EQUITY', direction: 'long',
      freshness: { state: 'DELAYED' }
    }, h)),
    totals: { currency: 'GBP', marketValue, equity: marketValue, cash: 0 },
    incompleteNote: null,
    rateNote: null
  }, extra || {});
}

function series(count, shape) {
  const out = [];
  for (let i = 0; i < count; i++) out.push({ t: BASE + i * DAY, c: shape(i) });
  return out;
}

function run(t) {
  const { suite, ok, eq, near } = t;

  /* ============ position sizing ============ */
  console.log('\nPosition sizing — arithmetic over the operator\'s own inputs, and nothing more');

  suite('size is the amount risked divided by the distance to the stop', () => {
    /* £10,000 risking 1% is £100. A stop 5 below a 100 entry risks 5 a share.
       £100 ÷ 5 = 20 shares, costing £2,000. */
    const out = risk.sizePosition({ equity: 10000, entry: 100, stop: 95, riskPercent: 1 });
    eq(out.usable, true);
    eq(out.quantity, 20);
    eq(out.riskPerUnit, 5);
    eq(out.riskAmount, 100);
    eq(out.capitalRequired, 2000);
    eq(out.maxLoss, 100);
    near(out.riskPercentOfEquity, 1, 1e-9);
    eq(out.direction, 'long');
  });

  suite('a stop above the entry is a short, and sizes the same way', () => {
    const out = risk.sizePosition({ equity: 10000, entry: 100, stop: 105, riskPercent: 1 });
    eq(out.direction, 'short');
    eq(out.quantity, 20);
  });

  suite('a target produces a reward-to-risk figure', () => {
    /* 10 a share over 20 shares is £200 against £100 risked. */
    const out = risk.sizePosition({ equity: 10000, entry: 100, stop: 95, target: 110, riskPercent: 1 });
    eq(out.potentialProfit, 200);
    near(out.rewardToRisk, 2, 1e-9);
  });

  suite('fees are part of the maximum loss', () => {
    const out = risk.sizePosition({ equity: 10000, entry: 100, stop: 95, riskPercent: 1, fees: 12 });
    eq(out.maxLoss, 112);
    near(out.riskPercentOfEquity, 1.12, 1e-9);
  });

  suite('without a stop it refuses, because there is no defined loss', () => {
    const out = risk.sizePosition({ equity: 10000, entry: 100, riskPercent: 1 });
    eq(out.usable, false);
    ok(/no defined loss/i.test(out.reason), 'got: ' + out.reason);
  });

  suite('a stop at the entry price risks nothing measurable', () => {
    const out = risk.sizePosition({ equity: 10000, entry: 100, stop: 100, riskPercent: 1 });
    eq(out.usable, false);
    ok(/risk per unit is zero/i.test(out.reason));
  });

  suite('a missing input is named rather than assumed', () => {
    const out = risk.sizePosition({ entry: 100, stop: 95 });
    eq(out.usable, false);
    ok(/an account value/.test(out.reason) && /how much to risk/.test(out.reason), 'got: ' + out.reason);
  });

  suite('rounding down to whole units is stated, not hidden', () => {
    /* £100 risked over a stop 7 away is 14.2857 shares; 14 risks £98. */
    const out = risk.sizePosition({ equity: 10000, entry: 100, stop: 93, riskPercent: 1 });
    eq(out.quantity, 14);
    ok(out.rounding && /98\.0%/.test(out.rounding), 'got: ' + out.rounding);
  });

  suite('fractional units are allowed where the instrument supports them', () => {
    const out = risk.sizePosition({ equity: 10000, entry: 100, stop: 93, riskPercent: 1, wholeUnits: false });
    near(out.quantity, 100 / 7, 1e-9);
    eq(out.rounding, null);
  });

  suite('a size of zero is explained rather than returned bare', () => {
    const out = risk.sizePosition({ equity: 1000, entry: 100, stop: 50, riskAmount: 10 });
    eq(out.quantity, 0);
    ok(/smaller than the distance to your stop/i.test(out.zeroSize), 'got: ' + out.zeroSize);
  });

  /* ============ exposure ============ */
  console.log('\nExposure — refused outright when the prices behind it cannot be relied on');

  const book = valued([
    { symbol: 'NVDA', marketValue: 6000 },
    { symbol: 'AAPL', marketValue: 4000 }
  ]);

  suite('weights are each holding\'s share of the total', () => {
    const out = risk.exposure(book);
    eq(out.usable, true);
    near(out.byInstrument[0].weight, 60, 1e-9);
    near(out.byInstrument[1].weight, 40, 1e-9);
    eq(out.largest.symbol, 'NVDA');
    eq(out.grossExposure, 10000);
  });

  suite('concentration reports the equivalent number of equal holdings', () => {
    /* Sixty and forty per cent give 3,600 + 1,600 = 5,200, so the book behaves
       like 10,000 ÷ 5,200 ≈ 1.92 equally sized holdings. */
    const out = risk.exposure(book);
    near(out.concentration.herfindahl, 5200, 1e-9);
    near(out.concentration.effectiveHoldings, 10000 / 5200, 1e-9);
    near(out.concentration.topWeight, 60, 1e-9);
  });

  suite('a short holding counts towards gross exposure but nets off', () => {
    const out = risk.exposure(valued([
      { symbol: 'NVDA', marketValue: 6000 },
      { symbol: 'AAPL', marketValue: -2000, direction: 'short' }
    ]));
    eq(out.grossExposure, 8000);
    eq(out.netExposure, 4000);
    eq(out.longValue, 6000);
    eq(out.shortValue, 2000);
  });

  suite('exposure is refused while any holding has an unreliable price', () => {
    /* Unlike a display figure, this one gets sized from. */
    const stale = valued([
      { symbol: 'NVDA', marketValue: 6000, freshness: { state: 'STALE' } },
      { symbol: 'AAPL', marketValue: 4000 }
    ]);
    const out = risk.exposure(stale);
    eq(out.usable, false);
    ok(/cannot be relied on/i.test(out.reason) && /NVDA/.test(out.reason), 'got: ' + out.reason);
  });

  suite('exposure is refused when the book has no single total to measure against', () => {
    const noTotal = Object.assign(valued([{ symbol: 'NVDA', marketValue: 6000 }]), {
      totals: null, rateNote: 'No exchange rate for EUR.'
    });
    const out = risk.exposure(noTotal);
    eq(out.usable, false);
    ok(/no exchange rate/i.test(out.reason));
  });

  suite('the caveat of the book travels with its exposure', () => {
    ok(/not verified against a broker/i.test(risk.exposure(book).caveat));
  });

  suite('currency exposure counts everything not in the account currency', () => {
    const mixed = valued([
      { symbol: 'NVDA', marketValue: 6000, quoteCurrency: 'USD' },
      { symbol: 'BP.L', marketValue: 4000, quoteCurrency: 'GBP' }
    ]);
    const out = risk.exposure(mixed);
    near(out.foreignCurrencyWeight, 60, 1e-9);
  });

  /* ============ observations ============ */
  console.log('\nObservations — statements of fact against the operator\'s own thresholds');

  suite('a large single holding is pointed out against the stated threshold', () => {
    const out = risk.observations(risk.exposure(book));
    const single = out.find(o => o.kind === 'concentration.single');
    ok(single, 'sixty per cent is above the default twenty-five');
    ok(/60\.0% of this book/.test(single.text), 'got: ' + single.text);
    ok(/you asked to be told about/.test(single.text), 'the threshold is the operator\'s own');
  });

  suite('an observation never tells the operator what to do', () => {
    const out = risk.observations(risk.exposure(book));
    const banned = /\b(should|reduce|trim|sell|buy|recommend|too much|dangerous)\b/i;
    out.forEach(item => ok(!banned.test(item.text), 'reads as advice: ' + item.text));
  });

  suite('a balanced book raises nothing', () => {
    const spread = valued([
      { symbol: 'A', marketValue: 1000 }, { symbol: 'B', marketValue: 1000 },
      { symbol: 'C', marketValue: 1000 }, { symbol: 'D', marketValue: 1000 },
      { symbol: 'E', marketValue: 1000 }, { symbol: 'F', marketValue: 1000 }
    ]);
    const out = risk.observations(risk.exposure(spread));
    eq(out.filter(o => o.kind === 'concentration.single').length, 0);
  });

  /* ============ impact ============ */
  console.log('\nImpact — a before and an after, with no verdict attached');

  suite('a proposed trade reports the weight it would move a holding to', () => {
    /* NVDA is 6,000 of 10,000. Adding 2,000 makes it 8,000 of 12,000. */
    const out = risk.impactOf(risk.exposure(book), { symbol: 'NVDA', value: 2000 });
    eq(out.usable, true);
    near(out.beforeWeight, 60, 1e-9);
    near(out.afterWeight, 8000 / 12000 * 100, 1e-9);
    ok(/from 60\.0% to 66\.7%/.test(out.summary), 'got: ' + out.summary);
  });

  suite('a new instrument starts from nothing', () => {
    const out = risk.impactOf(risk.exposure(book), { symbol: 'MSFT', value: 2500 });
    eq(out.beforeWeight, 0);
    near(out.afterWeight, 2500 / 12500 * 100, 1e-9);
  });

  suite('crossing the stated threshold is mentioned once, on the crossing', () => {
    const spread = valued([
      { symbol: 'A', marketValue: 1000 }, { symbol: 'B', marketValue: 1000 },
      { symbol: 'C', marketValue: 1000 }, { symbol: 'D', marketValue: 1000 }
    ]);
    const crossing = risk.impactOf(risk.exposure(spread), { symbol: 'A', value: 3000 });
    eq(crossing.notes.length, 1, 'A goes from 25% to 4000/7000 = 57%');
    const already = risk.impactOf(risk.exposure(book), { symbol: 'NVDA', value: 100 });
    eq(already.notes.length, 0, 'it was already past the threshold, so nothing was crossed');
  });

  /* ============ statistics over returns ============ */
  console.log('\nReturn statistics — a figure over too few observations is not produced');

  suite('volatility needs a real sample and says how many it had', () => {
    const short = risk.volatility(series(10, i => 100 + i));
    eq(short.value, null);
    eq(short.observations, 9);
    ok(/at least 30 are needed/.test(short.note), 'got: ' + short.note);
  });

  suite('volatility is computed once there are enough observations', () => {
    const wobbly = risk.volatility(series(200, i => 100 + Math.sin(i / 3) * 5));
    ok(wobbly.value > 0);
    eq(wobbly.observations, 199);
    eq(wobbly.annualisedOver, 252);
  });

  suite('two identical series correlate at one', () => {
    const a = series(200, i => 100 + Math.sin(i / 5) * 8);
    near(risk.correlation(a, a).value, 1, 1e-9);
  });

  suite('two opposed series correlate close to minus one, but not exactly', () => {
    /* Mirrored PRICES do not give exactly −1 on PERCENTAGE returns, because
       each return divides by its own previous price and those differ. The
       correct answer here is a shade above −1, and a test demanding −1 exactly
       would be demanding the wrong arithmetic. */
    const a = series(200, i => 100 + Math.sin(i / 5) * 8);
    const b = series(200, i => 100 - Math.sin(i / 5) * 8);
    const out = risk.correlation(a, b);
    ok(out.value < -0.99 && out.value > -1.0000001, 'got: ' + out.value);
  });

  suite('a series and its exact negative return correlate at minus one', () => {
    /* Constructed so the returns really are opposite: the same path applied
       multiplicatively in reverse. */
    const steps = [];
    for (let i = 0; i < 200; i++) steps.push(1 + Math.sin(i / 5) * 0.01);
    const a = [];
    const b = [];
    let pa = 100;
    let pb = 100;
    steps.forEach((step, i) => {
      pa *= step;
      pb /= step;
      a.push({ t: BASE + i * DAY, c: pa });
      b.push({ t: BASE + i * DAY, c: pb });
    });
    near(risk.correlation(a, b).value, -1, 1e-3);
  });

  suite('correlation aligns by timestamp rather than by position', () => {
    /* Two venues keep different holidays. Zipping by index pairs Tuesday with
       Wednesday from partway through and produces a plausible wrong number. */
    const a = series(200, i => 100 + Math.sin(i / 5) * 8);
    const b = a.filter((bar, i) => i !== 40).map(bar => ({ t: bar.t, c: bar.c }));
    const out = risk.correlation(a, b);
    ok(out.observations < 199, 'the unmatched day is dropped rather than misaligning the rest');
    near(out.value, 1, 1e-6, 'and what remains still correlates perfectly');
  });

  suite('a series that never moved has no correlation to report', () => {
    const flat = series(200, () => 100);
    const moving = series(200, i => 100 + i);
    const out = risk.correlation(flat, moving);
    eq(out.value, null);
    ok(/did not move/i.test(out.note));
  });

  suite('beta against itself is one', () => {
    const a = series(200, i => 100 + Math.sin(i / 4) * 6);
    near(risk.beta(a, a).value, 1, 1e-9);
  });

  suite('an instrument moving twice as hard has a beta of two', () => {
    const benchmark = series(200, i => 100 * Math.pow(1.001, i % 7 === 0 ? -i : i));
    const doubled = benchmark.map((bar, i) => ({ t: bar.t, c: 100 * Math.pow(bar.c / 100, 2) }));
    const out = risk.beta(doubled, benchmark);
    ok(out.value > 1.8 && out.value < 2.2, 'got: ' + out.value);
  });

  suite('drawdown finds the deepest fall and how long it took', () => {
    /* Rises to 150, falls to 75 — a fifty per cent fall. */
    const shape = i => (i < 50 ? 100 + i : (i < 100 ? 150 - (i - 50) * 1.5 : 75 + (i - 100)));
    const out = risk.drawdown(series(150, shape));
    near(out.value, 50, 1);
    ok(out.days > 0);
  });
}

module.exports = { run };
