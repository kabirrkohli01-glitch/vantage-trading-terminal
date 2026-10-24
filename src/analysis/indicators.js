'use strict';
/* Technical indicators.
 *
 * TWO INVARIANTS HOLD FOR EVERY FUNCTION IN THIS FILE, AND THEY ARE THE WHOLE
 * REASON IT CAN BE TRUSTED.
 *
 *   EVERY OUTPUT SERIES IS THE SAME LENGTH AS ITS INPUT, PADDED WITH null IN
 *   THE RUN-UP. A two-hundred-period average over sixty bars returns sixty
 *   nulls — it does not return a shorter array, and it does not fall back to a
 *   shorter period. A shorter array silently misaligns every later index
 *   against the bars it is drawn over, which puts an indicator's value on the
 *   wrong candle; a substituted period draws a line that is not the line the
 *   operator asked for. Both are invisible on screen and both are wrong.
 *
 *   NOTHING HERE IS ADVICE. These functions measure; they do not recommend. The
 *   descriptions attached to each indicator say what a number is, and stop.
 *   Turning a reading into an instruction happens nowhere in this application.
 *
 * A null anywhere in the input propagates to null in the output for any window
 * containing it, rather than being treated as zero. A halted bar is not a bar
 * that traded at nothing.
 */

/* Scoped; see the note at the head of src/core/num.js. */
(function () {

const blank = length => new Array(length).fill(null);

const finite = value => (value !== null && value !== undefined && Number.isFinite(value));

/* ---------- moving averages ---------- */

function sma(values, period) {
  const out = blank(values.length);
  if (period < 1) return out;

  let sum = 0;
  let counted = 0;
  const window = [];

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    window.push(value);
    if (finite(value)) { sum += value; counted++; }

    if (window.length > period) {
      const dropped = window.shift();
      if (finite(dropped)) { sum -= dropped; counted--; }
    }
    /* The window must be full AND complete: a gap inside it makes the average
       a mean of fewer bars than the period claims. */
    if (window.length === period && counted === period) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = blank(values.length);
  if (period < 1) return out;

  const k = 2 / (period + 1);
  let previous = null;
  let seedSum = 0;
  let seedCount = 0;

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!finite(value)) continue;

    if (previous === null) {
      /* Seeded from a simple average of the first full period, which is the
         standard construction and makes the series reproducible against any
         other implementation. */
      seedSum += value;
      seedCount++;
      if (seedCount === period) {
        previous = seedSum / period;
        out[i] = previous;
      }
      continue;
    }
    previous = value * k + previous * (1 - k);
    out[i] = previous;
  }
  return out;
}

function wma(values, period) {
  const out = blank(values.length);
  if (period < 1) return out;
  const denominator = (period * (period + 1)) / 2;

  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    let ok = true;
    for (let j = 0; j < period; j++) {
      const value = values[i - period + 1 + j];
      if (!finite(value)) { ok = false; break; }
      sum += value * (j + 1);
    }
    if (ok) out[i] = sum / denominator;
  }
  return out;
}

/* Wilder's smoothing, which is not the same as an exponential average of the
   same period and produces visibly different readings if substituted. */
function wilder(values, period) {
  const out = blank(values.length);
  let previous = null;
  let seedSum = 0;
  let seedCount = 0;

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!finite(value)) continue;
    if (previous === null) {
      seedSum += value;
      seedCount++;
      if (seedCount === period) { previous = seedSum / period; out[i] = previous; }
      continue;
    }
    previous = (previous * (period - 1) + value) / period;
    out[i] = previous;
  }
  return out;
}

/* ---------- price-and-volume ---------- */

/* Volume weighted average price, reset at each session boundary.
 *
 * Resetting matters: a VWAP carried across days is not a VWAP, it is a
 * cumulative average of everything ever traded, and it drifts further from
 * anything useful the longer the chart is. The reset is on calendar day in the
 * venue's own zone, so it lands where the session does. */
function vwap(bars, timeZone) {
  const out = blank(bars.length);
  let cumulativePV = 0;
  let cumulativeV = 0;
  let currentDay = null;

  const dayOf = ms => {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date(ms));
    } catch (e) {
      return new Date(ms).toISOString().slice(0, 10);
    }
  };

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!bar || !finite(bar.c)) continue;

    const day = dayOf(bar.t);
    if (day !== currentDay) { currentDay = day; cumulativePV = 0; cumulativeV = 0; }

    /* Without volume there is no weighting to apply, so the series stays null
       rather than degenerating into a plain average of typical prices. */
    if (!finite(bar.v) || bar.v <= 0) continue;

    const typical = (bar.h + bar.l + bar.c) / 3;
    cumulativePV += typical * bar.v;
    cumulativeV += bar.v;
    if (cumulativeV > 0) out[i] = cumulativePV / cumulativeV;
  }
  return out;
}

function obv(bars) {
  const out = blank(bars.length);
  let total = 0;
  let started = false;

  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];
    const previous = bars[i - 1];
    if (!bar || !previous || !finite(bar.c) || !finite(previous.c) || !finite(bar.v)) continue;
    if (bar.c > previous.c) total += bar.v;
    else if (bar.c < previous.c) total -= bar.v;
    started = true;
    out[i] = total;
  }
  return started ? out : blank(bars.length);
}

/* Volume relative to its own recent average. A reading of 2 means twice the
   usual activity for that instrument at that resolution. */
function relativeVolume(bars, period) {
  const volumes = bars.map(b => (b && finite(b.v) ? b.v : null));
  const average = sma(volumes, period || 20);
  return volumes.map((v, i) => {
    if (!finite(v) || !finite(average[i]) || average[i] === 0) return null;
    return v / average[i];
  });
}

/* ---------- oscillators ---------- */

function rsi(values, period) {
  const length = period || 14;
  const out = blank(values.length);
  const gains = blank(values.length);
  const losses = blank(values.length);

  for (let i = 1; i < values.length; i++) {
    if (!finite(values[i]) || !finite(values[i - 1])) continue;
    const change = values[i] - values[i - 1];
    gains[i] = change > 0 ? change : 0;
    losses[i] = change < 0 ? -change : 0;
  }

  const averageGain = wilder(gains, length);
  const averageLoss = wilder(losses, length);

  for (let i = 0; i < values.length; i++) {
    if (!finite(averageGain[i]) || !finite(averageLoss[i])) continue;
    /* No losses across the window is a real state, not a division to guard
       against: the instrument only rose, and the reading is the maximum. */
    if (averageLoss[i] === 0) { out[i] = 100; continue; }
    const rs = averageGain[i] / averageLoss[i];
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}

function macd(values, fast, slow, signalPeriod) {
  const fastLine = ema(values, fast || 12);
  const slowLine = ema(values, slow || 26);
  const line = values.map((_, i) =>
    (finite(fastLine[i]) && finite(slowLine[i]) ? fastLine[i] - slowLine[i] : null));
  const signal = ema(line, signalPeriod || 9);
  const histogram = line.map((v, i) => (finite(v) && finite(signal[i]) ? v - signal[i] : null));
  return { line, signal, histogram };
}

function stochastic(bars, kPeriod, dPeriod, smoothing) {
  const length = kPeriod || 14;
  const raw = blank(bars.length);

  for (let i = length - 1; i < bars.length; i++) {
    let high = -Infinity;
    let low = Infinity;
    let ok = true;
    for (let j = i - length + 1; j <= i; j++) {
      const bar = bars[j];
      if (!bar || !finite(bar.h) || !finite(bar.l)) { ok = false; break; }
      if (bar.h > high) high = bar.h;
      if (bar.l < low) low = bar.l;
    }
    if (!ok || !finite(bars[i].c)) continue;
    const span = high - low;
    /* A window with no range at all leaves the reading undefined rather than
       dividing by zero; this happens on halted or untraded instruments. */
    if (span === 0) continue;
    raw[i] = ((bars[i].c - low) / span) * 100;
  }

  const k = smoothing && smoothing > 1 ? sma(raw, smoothing) : raw;
  return { k, d: sma(k, dPeriod || 3) };
}

function cci(bars, period) {
  const length = period || 20;
  const typical = bars.map(b => (b && finite(b.h) && finite(b.l) && finite(b.c) ? (b.h + b.l + b.c) / 3 : null));
  const average = sma(typical, length);
  const out = blank(bars.length);

  for (let i = length - 1; i < bars.length; i++) {
    if (!finite(average[i])) continue;
    let deviation = 0;
    let ok = true;
    for (let j = i - length + 1; j <= i; j++) {
      if (!finite(typical[j])) { ok = false; break; }
      deviation += Math.abs(typical[j] - average[i]);
    }
    if (!ok) continue;
    const mean = deviation / length;
    if (mean === 0) continue;
    /* The constant is Lambert's, chosen so roughly seventy per cent of readings
       fall within plus or minus one hundred. It is part of the definition. */
    out[i] = (typical[i] - average[i]) / (0.015 * mean);
  }
  return out;
}

function roc(values, period) {
  const length = period || 12;
  const out = blank(values.length);
  for (let i = length; i < values.length; i++) {
    const before = values[i - length];
    if (!finite(values[i]) || !finite(before) || before === 0) continue;
    out[i] = ((values[i] - before) / before) * 100;
  }
  return out;
}

function mfi(bars, period) {
  const length = period || 14;
  const out = blank(bars.length);
  const positive = blank(bars.length);
  const negative = blank(bars.length);

  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];
    const previous = bars[i - 1];
    if (!bar || !previous || !finite(bar.v)) continue;
    const typical = (bar.h + bar.l + bar.c) / 3;
    const previousTypical = (previous.h + previous.l + previous.c) / 3;
    if (!finite(typical) || !finite(previousTypical)) continue;
    const flow = typical * bar.v;
    positive[i] = typical > previousTypical ? flow : 0;
    negative[i] = typical < previousTypical ? flow : 0;
  }

  for (let i = length; i < bars.length; i++) {
    let up = 0;
    let down = 0;
    let ok = true;
    for (let j = i - length + 1; j <= i; j++) {
      if (!finite(positive[j]) || !finite(negative[j])) { ok = false; break; }
      up += positive[j];
      down += negative[j];
    }
    if (!ok) continue;
    if (down === 0) { out[i] = 100; continue; }
    out[i] = 100 - 100 / (1 + up / down);
  }
  return out;
}

/* ---------- volatility and trend ---------- */

function trueRange(bars) {
  const out = blank(bars.length);
  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];
    const previousClose = bars[i - 1] && bars[i - 1].c;
    if (!bar || !finite(bar.h) || !finite(bar.l) || !finite(previousClose)) continue;
    out[i] = Math.max(
      bar.h - bar.l,
      Math.abs(bar.h - previousClose),
      Math.abs(bar.l - previousClose)
    );
  }
  return out;
}

function atr(bars, period) {
  return wilder(trueRange(bars), period || 14);
}

function bollinger(values, period, multiplier) {
  const length = period || 20;
  const width = multiplier == null ? 2 : multiplier;
  const middle = sma(values, length);
  const upper = blank(values.length);
  const lower = blank(values.length);

  for (let i = length - 1; i < values.length; i++) {
    if (!finite(middle[i])) continue;
    let sum = 0;
    let ok = true;
    for (let j = i - length + 1; j <= i; j++) {
      if (!finite(values[j])) { ok = false; break; }
      sum += Math.pow(values[j] - middle[i], 2);
    }
    if (!ok) continue;
    /* Population deviation, not sample: the window is the whole population
       being described, and using the sample form shifts every band. */
    const deviation = Math.sqrt(sum / length);
    upper[i] = middle[i] + width * deviation;
    lower[i] = middle[i] - width * deviation;
  }
  return { upper, middle, lower };
}

function adx(bars, period) {
  const length = period || 14;
  const plusDM = blank(bars.length);
  const minusDM = blank(bars.length);

  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];
    const previous = bars[i - 1];
    if (!bar || !previous || !finite(bar.h) || !finite(bar.l)) continue;
    const up = bar.h - previous.h;
    const down = previous.l - bar.l;
    /* Only the larger of the two directional moves counts, and only when it is
       positive. Both being positive does not mean both directions moved. */
    plusDM[i] = (up > down && up > 0) ? up : 0;
    minusDM[i] = (down > up && down > 0) ? down : 0;
  }

  const smoothedTR = wilder(trueRange(bars), length);
  const smoothedPlus = wilder(plusDM, length);
  const smoothedMinus = wilder(minusDM, length);

  const plusDI = blank(bars.length);
  const minusDI = blank(bars.length);
  const dx = blank(bars.length);

  for (let i = 0; i < bars.length; i++) {
    if (!finite(smoothedTR[i]) || smoothedTR[i] === 0) continue;
    plusDI[i] = (smoothedPlus[i] / smoothedTR[i]) * 100;
    minusDI[i] = (smoothedMinus[i] / smoothedTR[i]) * 100;
    const total = plusDI[i] + minusDI[i];
    if (total === 0) continue;
    dx[i] = (Math.abs(plusDI[i] - minusDI[i]) / total) * 100;
  }

  return { adx: wilder(dx, length), plusDI, minusDI };
}

/* Supertrend: an average-true-range band that flips side when price closes
   through it. The flip is stateful, so it cannot be computed pointwise. */
function supertrend(bars, period, multiplier) {
  const length = period || 10;
  const width = multiplier == null ? 3 : multiplier;
  const range = atr(bars, length);

  const value = blank(bars.length);
  const direction = blank(bars.length);
  let upperBand = null;
  let lowerBand = null;
  let trend = 1;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!bar || !finite(range[i]) || !finite(bar.c)) continue;

    const mid = (bar.h + bar.l) / 2;
    let upper = mid + width * range[i];
    let lower = mid - width * range[i];

    /* The bands only ever tighten while the trend holds; letting them widen
       again would flip the indicator on noise. */
    if (upperBand !== null && bars[i - 1] && finite(bars[i - 1].c)) {
      if (!(upper < upperBand || bars[i - 1].c > upperBand)) upper = upperBand;
      if (!(lower > lowerBand || bars[i - 1].c < lowerBand)) lower = lowerBand;
    }

    if (upperBand !== null) {
      if (trend === 1 && bar.c < lowerBand) trend = -1;
      else if (trend === -1 && bar.c > upperBand) trend = 1;
    }

    upperBand = upper;
    lowerBand = lower;
    value[i] = trend === 1 ? lower : upper;
    direction[i] = trend;
  }

  return { value, direction };
}

/* Ichimoku. Two of its five lines are plotted ahead of the last bar and one
 * behind it, which no other indicator here does.
 *
 * The projected values are returned SEPARATELY rather than appended to the
 * series, because appending would make the output longer than the input and
 * break the alignment invariant every other function in this file holds to. The
 * chart draws them into the space past the last bar. */
function ichimoku(bars, conversionPeriod, basePeriod, spanPeriod) {
  const conversionLength = conversionPeriod || 9;
  const baseLength = basePeriod || 26;
  const spanLength = spanPeriod || 52;

  const midpoint = (from, to) => {
    let high = -Infinity;
    let low = Infinity;
    for (let i = from; i <= to; i++) {
      const bar = bars[i];
      if (!bar || !finite(bar.h) || !finite(bar.l)) return null;
      if (bar.h > high) high = bar.h;
      if (bar.l < low) low = bar.l;
    }
    return (high + low) / 2;
  };

  const conversion = blank(bars.length);
  const base = blank(bars.length);
  const spanA = blank(bars.length);
  const spanB = blank(bars.length);
  const lagging = blank(bars.length);

  for (let i = 0; i < bars.length; i++) {
    if (i >= conversionLength - 1) conversion[i] = midpoint(i - conversionLength + 1, i);
    if (i >= baseLength - 1) base[i] = midpoint(i - baseLength + 1, i);
    if (i >= spanLength - 1) spanB[i] = midpoint(i - spanLength + 1, i);
  }

  /* The cloud is shifted forward by the base period: the value computed at bar
     i is drawn at bar i + baseLength. */
  for (let i = 0; i < bars.length; i++) {
    const source = i - baseLength;
    if (source >= 0 && finite(conversion[source]) && finite(base[source])) {
      spanA[i] = (conversion[source] + base[source]) / 2;
    }
    const shiftedB = i - baseLength;
    if (shiftedB >= 0 && finite(spanB[shiftedB])) spanB[i] = spanB[shiftedB];
    else if (i >= spanLength - 1 + baseLength) spanB[i] = null;
  }

  /* The lagging line is the close drawn backwards by the same period. */
  for (let i = 0; i < bars.length; i++) {
    const source = i + baseLength;
    if (source < bars.length && finite(bars[source].c)) lagging[i] = bars[source].c;
  }

  /* What continues past the final bar, for the chart to draw in the space
     ahead of the series. */
  const projected = [];
  for (let step = 1; step <= baseLength; step++) {
    const source = bars.length - baseLength + step - 1;
    if (source < 0 || source >= bars.length) continue;
    projected.push({
      step,
      spanA: (finite(conversion[source]) && finite(base[source])) ? (conversion[source] + base[source]) / 2 : null,
      spanB: finite(spanB[source]) ? spanB[source] : null
    });
  }

  return { conversion, base, spanA, spanB, lagging, projected, shift: baseLength };
}

/* ---------- distribution ---------- */

/* Volume profile: how much traded at each price across a range of bars.
 *
 * Volume is spread evenly across each bar's high-to-low span, because candle
 * data does not record where within the bar it traded. That is a stated
 * approximation and it is the only one in this file — a real profile needs the
 * trade tape, which this application has for crypto and says it does not have
 * elsewhere. */
function volumeProfile(bars, buckets) {
  const usable = (bars || []).filter(b => b && finite(b.h) && finite(b.l) && finite(b.v) && b.v > 0);
  if (!usable.length) return null;

  let high = -Infinity;
  let low = Infinity;
  usable.forEach(bar => {
    if (bar.h > high) high = bar.h;
    if (bar.l < low) low = bar.l;
  });
  if (!(high > low)) return null;

  const count = Math.max(8, Math.min(Number(buckets) || 48, 240));
  const step = (high - low) / count;
  const levels = new Array(count).fill(0);

  usable.forEach(bar => {
    const from = Math.max(0, Math.floor((bar.l - low) / step));
    const to = Math.min(count - 1, Math.floor((bar.h - low) / step));
    const spread = (to - from) + 1;
    const share = bar.v / spread;
    for (let i = from; i <= to; i++) levels[i] += share;
  });

  let peak = 0;
  let peakIndex = 0;
  let total = 0;
  levels.forEach((v, i) => { total += v; if (v > peak) { peak = v; peakIndex = i; } });

  /* The value area is the contiguous band around the most-traded price holding
     seventy per cent of the volume, grown outward from the peak. */
  let lowIndex = peakIndex;
  let highIndex = peakIndex;
  let held = levels[peakIndex];
  const target = total * 0.7;
  while (held < target && (lowIndex > 0 || highIndex < count - 1)) {
    const below = lowIndex > 0 ? levels[lowIndex - 1] : -1;
    const above = highIndex < count - 1 ? levels[highIndex + 1] : -1;
    if (above >= below) { highIndex++; held += levels[highIndex]; }
    else { lowIndex--; held += levels[lowIndex]; }
  }

  return {
    low, high, step, buckets: count,
    levels: levels.map((volume, i) => ({ price: low + step * (i + 0.5), volume })),
    pointOfControl: low + step * (peakIndex + 0.5),
    valueAreaLow: low + step * lowIndex,
    valueAreaHigh: low + step * (highIndex + 1),
    approximated: true,
    note: 'Volume is distributed evenly across each bar\'s range. Candle data does not record where within a bar it traded.'
  };
}

/* ---------- catalogue ---------- */

/* What each indicator is, where it draws, and what its reading measures.
   The explanations are descriptive on purpose: they say what a number is, and
   never what to do about it. */
const CATALOGUE = {
  sma: { label: 'Simple moving average', pane: 'price', defaults: { period: 50 }, needs: p => p.period,
    explain: 'The mean closing price of the last N bars.' },
  ema: { label: 'Exponential moving average', pane: 'price', defaults: { period: 20 }, needs: p => p.period,
    explain: 'A moving average weighted towards recent bars.' },
  wma: { label: 'Weighted moving average', pane: 'price', defaults: { period: 20 }, needs: p => p.period,
    explain: 'A moving average weighted linearly towards recent bars.' },
  vwap: { label: 'VWAP', pane: 'price', defaults: {}, needs: () => 1, intradayOnly: true,
    explain: 'Average price weighted by volume, restarting each session. Meaningless on a daily chart, where each bar is already a whole session.' },
  bollinger: { label: 'Bollinger Bands', pane: 'price', defaults: { period: 20, multiplier: 2 }, needs: p => p.period,
    explain: 'A moving average with bands at a multiple of standard deviation. The bands widen as volatility rises.' },
  supertrend: { label: 'Supertrend', pane: 'price', defaults: { period: 10, multiplier: 3 }, needs: p => p.period + 1,
    explain: 'A band set a multiple of average true range from the midpoint, which switches side when price closes through it.' },
  ichimoku: { label: 'Ichimoku', pane: 'price', defaults: { conversion: 9, base: 26, span: 52 }, needs: p => p.span,
    explain: 'Five lines measuring midpoints over three windows. Two are plotted ahead of the last bar and one behind it.' },
  volumeProfile: { label: 'Volume profile', pane: 'price', defaults: { buckets: 48 }, needs: () => 2,
    explain: 'How much volume traded at each price across the visible range.' },

  volume: { label: 'Volume', pane: 'lower', defaults: {}, needs: () => 1,
    explain: 'Units traded per bar.' },
  relativeVolume: { label: 'Relative volume', pane: 'lower', defaults: { period: 20 }, needs: p => p.period,
    explain: 'Volume as a multiple of its own recent average. Two means twice the usual activity.' },
  rsi: { label: 'RSI', pane: 'lower', defaults: { period: 14 }, needs: p => p.period + 1,
    explain: 'The size of recent gains relative to recent losses, on a scale of nought to one hundred.' },
  macd: { label: 'MACD', pane: 'lower', defaults: { fast: 12, slow: 26, signal: 9 }, needs: p => p.slow + p.signal,
    explain: 'The gap between two exponential averages, and that gap\'s own average.' },
  stochastic: { label: 'Stochastic', pane: 'lower', defaults: { k: 14, d: 3, smoothing: 1 }, needs: p => p.k + p.d,
    explain: 'Where the close sits within the high-to-low range of the last N bars.' },
  atr: { label: 'Average true range', pane: 'lower', defaults: { period: 14 }, needs: p => p.period + 1,
    explain: 'Average bar range including gaps, in the instrument\'s own units.' },
  adx: { label: 'ADX', pane: 'lower', defaults: { period: 14 }, needs: p => p.period * 2,
    explain: 'How strongly price is trending, without regard to direction.' },
  cci: { label: 'CCI', pane: 'lower', defaults: { period: 20 }, needs: p => p.period,
    explain: 'How far the typical price sits from its own average, scaled by mean deviation.' },
  roc: { label: 'Rate of change', pane: 'lower', defaults: { period: 12 }, needs: p => p.period + 1,
    explain: 'Percentage change over the last N bars.' },
  obv: { label: 'On-balance volume', pane: 'lower', defaults: {}, needs: () => 2,
    explain: 'A running total of volume, added on up bars and subtracted on down bars.' },
  mfi: { label: 'Money flow index', pane: 'lower', defaults: { period: 14 }, needs: p => p.period + 1,
    explain: 'Like RSI, but weighting each bar by the value traded rather than by price alone.' }
};

/* Whether an indicator can be drawn at all on this many bars.
 *
 * Used to grey a control out BEFORE it is switched on, with a reason, rather
 * than switching it on and drawing nothing. A stored setting is never modified
 * by this — the indicator stays selected and simply is not drawn where it
 * cannot be. */
function usable(id, bars, params) {
  const entry = CATALOGUE[id];
  if (!entry) return { ok: false, reason: 'Unknown indicator.' };
  const settings = Object.assign({}, entry.defaults, params || {});
  const required = entry.needs(settings);
  const count = (bars || []).length;
  if (count < required) {
    return { ok: false, reason: 'Needs ' + required + ' bars and this range has ' + count + '.' };
  }
  if (entry.intradayOnly && !isIntraday(bars)) {
    return { ok: false, reason: 'Only meaningful within a session; each bar here is already a whole session.' };
  }
  return { ok: true };
}

function isIntraday(bars) {
  if (!bars || bars.length < 2) return false;
  return (bars[bars.length - 1].t - bars[bars.length - 2].t) < 24 * 60 * 60 * 1000;
}

/* Build one indicator by name. Returns null rather than a shape full of nulls
   when it cannot be built, so a caller cannot draw an empty line and believe
   it drew something. */
function build(id, bars, params) {
  const entry = CATALOGUE[id];
  if (!entry) return null;
  const check = usable(id, bars, params);
  if (!check.ok) return null;

  const settings = Object.assign({}, entry.defaults, params || {});
  const closes = bars.map(b => (b && finite(b.c) ? b.c : null));

  switch (id) {
    case 'sma': return { series: sma(closes, settings.period) };
    case 'ema': return { series: ema(closes, settings.period) };
    case 'wma': return { series: wma(closes, settings.period) };
    case 'vwap': return { series: vwap(bars, settings.timeZone) };
    case 'bollinger': return bollinger(closes, settings.period, settings.multiplier);
    case 'supertrend': return supertrend(bars, settings.period, settings.multiplier);
    case 'ichimoku': return ichimoku(bars, settings.conversion, settings.base, settings.span);
    case 'volumeProfile': return volumeProfile(bars, settings.buckets);
    case 'volume': return { series: bars.map(b => (b && finite(b.v) ? b.v : null)) };
    case 'relativeVolume': return { series: relativeVolume(bars, settings.period) };
    case 'rsi': return { series: rsi(closes, settings.period) };
    case 'macd': return macd(closes, settings.fast, settings.slow, settings.signal);
    case 'stochastic': return stochastic(bars, settings.k, settings.d, settings.smoothing);
    case 'atr': return { series: atr(bars, settings.period) };
    case 'adx': return adx(bars, settings.period);
    case 'cci': return { series: cci(bars, settings.period) };
    case 'roc': return { series: roc(closes, settings.period) };
    case 'obv': return { series: obv(bars) };
    case 'mfi': return { series: mfi(bars, settings.period) };
    default: return null;
  }
}

/* The newest value that is actually a number. The final bar is often still
   forming and its indicator slot can legitimately be null. */
function latest(series) {
  if (!series) return null;
  for (let i = series.length - 1; i >= 0; i--) {
    if (finite(series[i])) return series[i];
  }
  return null;
}

const API = {
  CATALOGUE, usable, build, latest, isIntraday,
  sma, ema, wma, wilder, vwap, obv, relativeVolume,
  rsi, macd, stochastic, cci, roc, mfi,
  trueRange, atr, bollinger, adx, supertrend, ichimoku, volumeProfile
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') { window.T = window.T || {}; window.T.indicators = API; }

}());
