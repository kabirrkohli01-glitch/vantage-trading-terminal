'use strict';
/* Indicator tests.
 *
 * The length invariant is checked for every indicator in the catalogue, because
 * a series shorter than its input misaligns every value against the bar it is
 * drawn over — which puts a reading on the wrong candle and is invisible on
 * screen.
 *
 * The arithmetic is checked against hand-computed values and against the
 * reference series Wilder published with the definition of RSI.
 */

const ind = require('../src/analysis/indicators');

/* Wilder's own worked example, and the value it is known to produce. */
const WILDER_CLOSES = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42,
  45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28
];

function bars(count, shape) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const base = shape ? shape(i) : 100 + Math.sin(i / 3) * 10;
    out.push({
      t: Date.parse('2026-01-05T00:00:00Z') + i * 60000,
      o: base - 0.5, h: base + 1, l: base - 1, c: base, v: 1000 + (i % 7) * 100
    });
  }
  return out;
}

function run(t) {
  const { suite, ok, eq, near } = t;

  /* ============ the invariant ============ */
  console.log('\nIndicators — every series aligns to the bar it is drawn over');

  suite('every indicator returns series exactly as long as its input', () => {
    const sample = bars(300);
    const ids = Object.keys(ind.CATALOGUE);
    ok(ids.length >= 18, 'the catalogue must actually be populated');

    ids.forEach(id => {
      if (id === 'volumeProfile') return;   // a distribution, not a per-bar series
      const built = ind.build(id, sample);
      ok(built, id + ' must build on three hundred bars');
      Object.keys(built).forEach(key => {
        const value = built[key];
        if (!Array.isArray(value)) return;
        if (key === 'projected') return;    // drawn ahead of the last bar, see below
        eq(value.length, sample.length, id + '.' + key + ' must match the input length');
      });
    });
  });

  suite('the run-up is null, never a shortened period standing in for it', () => {
    const sample = bars(60);
    const built = ind.build('sma', sample, { period: 50 });
    ok(built, 'fifty over sixty bars is buildable');
    for (let i = 0; i < 49; i++) eq(built.series[i], null, 'slot ' + i + ' has no full window yet');
    ok(built.series[49] !== null, 'the first full window produces a value');
  });

  suite('an indicator with too little history refuses rather than drawing a fudge', () => {
    const sample = bars(60);
    const check = ind.usable('sma', sample, { period: 200 });
    eq(check.ok, false);
    ok(/needs 200 bars and this range has 60/i.test(check.reason), 'the reason names both numbers: ' + check.reason);
    eq(ind.build('sma', sample, { period: 200 }), null, 'and it builds nothing at all');
  });

  suite('a session-only indicator is refused on daily bars, with a reason', () => {
    const daily = [];
    for (let i = 0; i < 100; i++) {
      daily.push({ t: Date.parse('2026-01-05T00:00:00Z') + i * 86400000, o: 10, h: 11, l: 9, c: 10, v: 100 });
    }
    const check = ind.usable('vwap', daily);
    eq(check.ok, false);
    ok(/already a whole session/i.test(check.reason));
  });

  /* ============ arithmetic ============ */
  console.log('\nIndicator arithmetic — checked against hand-computed and published values');

  suite('a simple moving average is the mean of its window', () => {
    const out = ind.sma([1, 2, 3, 4, 5], 3);
    eq(out[0], null);
    eq(out[1], null);
    eq(out[2], 2);
    eq(out[3], 3);
    eq(out[4], 4);
  });

  suite('an exponential average is seeded from a simple one', () => {
    const out = ind.ema([1, 2, 3, 4, 5], 3);
    eq(out[2], 2, 'the seed is the mean of the first full period');
    eq(out[3], 3, 'then smoothed with k = 2/(n+1)');
    eq(out[4], 4);
  });

  suite('a weighted average leans on the newest bar', () => {
    /* (1*1 + 2*2 + 3*3) / 6 */
    const out = ind.wma([1, 2, 3], 3);
    near(out[2], 14 / 6, 1e-9);
  });

  suite('RSI reproduces the value published with its definition', () => {
    /* Worked by hand from the reference series: across the fourteen changes the
       gains total 3.34 and the losses 1.40, so the averages are 0.238571 and
       0.100000, the relative strength is 2.385714, and the reading is
       100 − 100/3.385714 = 70.4641.
       Note this is the FIRST computed value. Texts quoting 70.53 for this
       series are quoting the second, which folds in one more close. */
    const out = ind.rsi(WILDER_CLOSES, 14);
    near(out[14], 70.4641, 0.001, 'the first reading of the reference series');
    eq(out[13], null, 'and nothing is published before the window is full');
  });

  suite('RSI reads one hundred when nothing fell across the window', () => {
    const rising = [];
    for (let i = 0; i < 30; i++) rising.push(10 + i);
    eq(ind.rsi(rising, 14)[20], 100, 'no losses is a real state, not a division to guard');
  });

  suite('Bollinger bands use population deviation, not sample', () => {
    const values = [];
    for (let i = 1; i <= 20; i++) values.push(i);
    const band = ind.bollinger(values, 20, 2);
    near(band.middle[19], 10.5, 1e-9);
    /* Population deviation of 1..20 is sqrt(33.25) = 5.76628…; the sample form
       would give 5.9161 and shift both bands. */
    near(band.upper[19], 10.5 + 2 * 5.766281, 1e-4);
    near(band.lower[19], 10.5 - 2 * 5.766281, 1e-4);
  });

  suite('MACD is the gap between two averages, and the histogram is its residual', () => {
    const sample = bars(120).map(b => b.c);
    const out = ind.macd(sample, 12, 26, 9);
    const at = out.line.length - 1;
    near(out.histogram[at], out.line[at] - out.signal[at], 1e-9);
  });

  suite('true range accounts for the gap, not just the bar', () => {
    const gapped = [
      { t: 1, o: 10, h: 11, l: 9, c: 10, v: 1 },
      { t: 2, o: 20, h: 21, l: 19, c: 20, v: 1 }
    ];
    /* The bar spans 2, but the move from the previous close is 11. */
    eq(ind.trueRange(gapped)[1], 11);
  });

  suite('a stochastic reading of a flat window is undefined, not zero', () => {
    const flat = [];
    for (let i = 0; i < 30; i++) flat.push({ t: i, o: 10, h: 10, l: 10, c: 10, v: 1 });
    eq(ind.stochastic(flat, 14, 3)[('k')][20], null, 'a window with no range divides by nothing');
  });

  suite('directional movement counts only the larger side', () => {
    const out = ind.adx(bars(120), 14);
    out.plusDI.forEach((v, i) => {
      if (v === null) return;
      ok(v >= 0 && v <= 100, 'a directional index sits between nought and one hundred');
      ok(out.minusDI[i] >= 0 && out.minusDI[i] <= 100);
    });
  });

  suite('on-balance volume adds on up bars and subtracts on down bars', () => {
    const sample = [
      { t: 1, o: 10, h: 10, l: 10, c: 10, v: 100 },
      { t: 2, o: 11, h: 11, l: 11, c: 11, v: 50 },
      { t: 3, o: 9, h: 9, l: 9, c: 9, v: 30 }
    ];
    const out = ind.obv(sample);
    eq(out[1], 50);
    eq(out[2], 20);
  });

  suite('relative volume reads as a multiple of the usual', () => {
    const steady = [];
    for (let i = 0; i < 40; i++) steady.push({ t: i, o: 1, h: 1, l: 1, c: 1, v: 100 });
    steady.push({ t: 40, o: 1, h: 1, l: 1, c: 1, v: 200 });
    const out = ind.relativeVolume(steady, 20);
    near(out[40], 200 / 105, 0.01, 'twice the usual, once the spike is inside the average');
  });

  /* ============ nulls ============ */
  console.log('\nIndicators and gaps — a halted bar is not a bar that traded at nothing');

  suite('a null inside the window produces null, never a mean of fewer bars', () => {
    const out = ind.sma([1, 2, null, 4, 5], 3);
    eq(out[2], null, 'the window contains a gap');
    eq(out[3], null);
    eq(out[4], null, 'still not clear of the gap at period 3');
  });

  suite('a series recovers once the gap leaves the window', () => {
    const out = ind.sma([1, null, 3, 4, 5, 6], 3);
    eq(out[4], 4, '(3+4+5)/3');
    eq(out[5], 5);
  });

  suite('VWAP stays null without volume rather than becoming a price average', () => {
    const noVolume = bars(50).map(b => Object.assign({}, b, { v: null }));
    const out = ind.vwap(noVolume);
    ok(out.every(v => v === null), 'no weighting is available, so there is no weighted average');
  });

  suite('VWAP restarts each session rather than accumulating for ever', () => {
    /* The typical price is the mean of high, low and close, so the whole bar
       has to move for the second session to price differently — moving the
       close alone would leave the typical price between the two. */
    const twoDays = [];
    for (let day = 0; day < 2; day++) {
      const price = 100 + day * 50;
      for (let i = 0; i < 10; i++) {
        twoDays.push({
          t: Date.parse('2026-01-0' + (5 + day) + 'T10:00:00Z') + i * 60000,
          o: price, h: price, l: price, c: price, v: 100
        });
      }
    }
    const out = ind.vwap(twoDays, 'UTC');
    near(out[9], 100, 1e-9, 'the first session averages its own prices');
    near(out[10], 150, 1e-9, 'the second session starts again from its first bar');
    near(out[19], 150, 1e-9, 'and never blends the previous session back in');
  });

  /* ============ shifted series ============ */
  console.log('\nIchimoku — the one indicator that draws outside its own series');

  suite('the projected cloud is returned separately, not appended to the series', () => {
    const sample = bars(200);
    const out = ind.ichimoku(sample);
    eq(out.conversion.length, sample.length);
    eq(out.spanA.length, sample.length, 'appending the projection would break every other alignment');
    ok(Array.isArray(out.projected), 'what continues past the last bar is its own list');
    ok(out.projected.length > 0, 'and it is populated');
    eq(out.shift, 26);
  });

  /* ============ distribution ============ */
  console.log('\nVolume profile — an approximation, and it says so');

  suite('a profile finds a point of control inside its own range', () => {
    const profile = ind.volumeProfile(bars(200), 40);
    ok(profile, 'it builds');
    ok(profile.pointOfControl >= profile.low && profile.pointOfControl <= profile.high);
    ok(profile.valueAreaLow <= profile.pointOfControl && profile.valueAreaHigh >= profile.pointOfControl,
      'the value area contains the most-traded price');
  });

  suite('the profile declares that it spread volume across each bar', () => {
    const profile = ind.volumeProfile(bars(100), 24);
    eq(profile.approximated, true);
    ok(/does not record where within a bar/i.test(profile.note),
      'candle data cannot say where inside a bar it traded, and the profile must say so');
  });

  suite('a profile of bars with no volume is null, not an empty histogram', () => {
    const noVolume = bars(50).map(b => Object.assign({}, b, { v: 0 }));
    eq(ind.volumeProfile(noVolume, 24), null);
  });

  /* ============ descriptions ============ */
  console.log('\nIndicator descriptions — measurements, never instructions');

  suite('no indicator description tells the operator what to do', () => {
    const banned = /\b(buy|sell|should|recommend|signal to|entry point|take profit|go long|go short)\b/i;
    Object.keys(ind.CATALOGUE).forEach(id => {
      const entry = ind.CATALOGUE[id];
      ok(entry.explain && entry.explain.length > 10, id + ' must be described');
      ok(!banned.test(entry.explain), id + ' describes what it measures, not what to do: "' + entry.explain + '"');
    });
  });

  suite('the newest usable value skips a still-forming final bar', () => {
    const series = [1, 2, 3, null];
    eq(ind.latest(series), 3);
    eq(ind.latest([null, null]), null);
    eq(ind.latest(null), null);
  });
}

module.exports = { run };
