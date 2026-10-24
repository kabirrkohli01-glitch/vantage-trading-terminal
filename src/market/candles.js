'use strict';
/* Candles: assembly, merging, resampling and the derived series.
 *
 * A bar is { t, o, h, l, c, v } with t in milliseconds. Two invariants hold
 * everywhere below, and both exist because breaking them produces a chart that
 * looks fine and is wrong:
 *
 *   A NULL CLOSE IS SKIPPED, NEVER ZEROED. Feeds send null constantly for
 *   halted or untraded intervals. One null close coerced to zero becomes a
 *   candle at the axis that flattens the entire visible range of the day.
 *
 *   REDUCING THE NUMBER OF BARS MERGES THEM, IT DOES NOT DROP THEM. Sampling
 *   every Nth bar throws away the highs and lows, and those live precisely in
 *   the gaps sampling discards, so a thinned series silently under-reports
 *   every spike. Merging keeps the extremes of each slot.
 *
 * Volume distinguishes "no trades" from "not reported": a merged bar whose
 * inputs all had null volume keeps null, rather than summing to a confident
 * zero. Indices report no volume at all, and a zero there is a lie about
 * activity rather than a fact about it.
 */

/* Scoped; see the note at the head of src/core/num.js. This file and the
   indicator module both define `atr`, which would collide in the interface's
   single shared script scope. */
(function () {

/* Resolved for both hosts: a module in the main process, a global in the
   interface. The chart applies the same transforms this file defines, so it
   must be the same file. */
const { num } = (typeof require === 'function') ? require('../core/num') : window.T.num;

/* Build a bar list from parallel arrays, the shape most providers return.
 *
 * Open, high and low each fall back to the close rather than to null, so a
 * close-only interval still draws a mark on the chart instead of a hole. The
 * close itself has no fallback: without it there is no bar. */
function fromArrays(times, opens, highs, lows, closes, volumes, options) {
  const opts = options || {};
  const scale = opts.timesInSeconds === false ? 1 : 1000;
  const out = [];
  const length = Math.min(
    times ? times.length : 0,
    closes ? closes.length : 0
  );

  for (let i = 0; i < length; i++) {
    const c = num(closes[i]);
    if (c === null) continue;

    const t = num(times[i]);
    if (t === null) continue;

    const o = num(opens && opens[i]);
    const h = num(highs && highs[i]);
    const l = num(lows && lows[i]);
    const v = num(volumes && volumes[i]);

    out.push({
      t: t * scale,
      o: o === null ? c : o,
      h: h === null ? Math.max(o === null ? c : o, c) : h,
      l: l === null ? Math.min(o === null ? c : o, c) : l,
      c,
      v
    });
  }

  /* Providers do not always return strictly increasing times, and a chart that
     assumes ordering draws a line back through itself when they do not. */
  out.sort((a, b) => a.t - b.t);
  return dedupe(out);
}

/* Two bars with the same timestamp is a provider artefact. The later one wins,
   because it is the correction. */
function dedupe(bars) {
  const out = [];
  for (let i = 0; i < bars.length; i++) {
    if (out.length && out[out.length - 1].t === bars[i].t) out[out.length - 1] = bars[i];
    else out.push(bars[i]);
  }
  return out;
}

/* Merge one slot of bars into a single bar. */
function mergeSlot(slot) {
  if (!slot.length) return null;
  let high = -Infinity;
  let low = Infinity;
  let volume = 0;
  let sawVolume = false;

  for (let i = 0; i < slot.length; i++) {
    const bar = slot[i];
    if (bar.h > high) high = bar.h;
    if (bar.l < low) low = bar.l;
    if (bar.v !== null) { volume += bar.v; sawVolume = true; }
  }

  return {
    t: slot[0].t,
    o: slot[0].o,
    h: high,
    l: low,
    c: slot[slot.length - 1].c,
    v: sawVolume ? volume : null
  };
}

/* Reduce a series to at most `most` bars by merging adjacent slots.
 *
 * Used for overview strips where the pixel width cannot show every bar. The
 * chart proper does not call this — it draws what it is given and lets the
 * viewport decide what is visible. */
function bucket(bars, most) {
  if (!bars || bars.length <= most || most < 1) return bars || [];
  const size = Math.ceil(bars.length / most);
  const out = [];
  for (let i = 0; i < bars.length; i += size) {
    const merged = mergeSlot(bars.slice(i, i + size));
    if (merged) out.push(merged);
  }
  return out;
}

/* Timeframes, in milliseconds. `null` marks the ones that are not a fixed
   duration and therefore cannot be resampled by clock arithmetic. */
const TIMEFRAMES = {
  '1s': 1000,
  '5s': 5 * 1000,
  '15s': 15 * 1000,
  '30s': 30 * 1000,
  '1m': 60 * 1000,
  '2m': 2 * 60 * 1000,
  '3m': 3 * 60 * 1000,
  '5m': 5 * 60 * 1000,
  '10m': 10 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '2h': 2 * 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
  '1mo': null,
  '3mo': null
};

function timeframeMs(name) {
  return Object.prototype.hasOwnProperty.call(TIMEFRAMES, name) ? TIMEFRAMES[name] : null;
}

/* Resample to a coarser timeframe by clock boundary rather than by bar count.
 *
 * Boundary alignment matters: bucketing by count starting from whichever bar
 * happens to be first produces hourly bars that begin at 09:37. Flooring each
 * bar's timestamp to a multiple of the target interval puts every bar on the
 * boundary a trader expects, and makes the result identical no matter how much
 * history was loaded.
 *
 * Refuses to go finer. Manufacturing five one-minute bars out of one five-minute
 * bar means inventing four opens, four closes and eight extremes. */
function resample(bars, targetName, sourceName) {
  const target = timeframeMs(targetName);
  if (!bars || !bars.length) return [];
  if (!target) return bars.slice();

  const source = timeframeMs(sourceName);
  if (source && target < source) {
    throw new Error('Cannot resample ' + sourceName + ' bars to ' + targetName +
      ': a finer series cannot be derived from a coarser one.');
  }
  if (source && target === source) return bars.slice();

  const out = [];
  let slot = [];
  let boundary = null;

  for (let i = 0; i < bars.length; i++) {
    const edge = Math.floor(bars[i].t / target) * target;
    if (boundary === null) boundary = edge;
    if (edge !== boundary) {
      const merged = mergeSlot(slot);
      if (merged) { merged.t = boundary; out.push(merged); }
      slot = [];
      boundary = edge;
    }
    slot.push(bars[i]);
  }
  const last = mergeSlot(slot);
  if (last) { last.t = boundary; out.push(last); }
  return out;
}

/* Bars strictly at or before a cursor.
 *
 * This is the look-ahead guard the replay engine and the backtester are built
 * on. It is deliberately a plain function over a plain array so the property
 * being enforced is visible in one place and testable directly: nothing after
 * the cursor can leave this function, whatever the caller asks for. */
function upTo(bars, cursorMs) {
  if (!bars || !bars.length) return [];
  /* num() rather than Number(): Number(null) is 0, and a cursor of zero is a
     valid finite cutoff that admits any bar stamped at the epoch. An absent
     cursor must reveal nothing at all, and in the one function the replay
     engine and the backtester both depend on, that distinction is the
     difference between a guard and a decoration. */
  const cutoff = num(cursorMs);
  if (cutoff === null) return [];
  const out = [];
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].t > cutoff) break;
    out.push(bars[i]);
  }
  return out;
}

function trim(bars, fromMs, toMs) {
  if (!bars) return [];
  const from = Number.isFinite(Number(fromMs)) ? Number(fromMs) : -Infinity;
  const to = Number.isFinite(Number(toMs)) ? Number(toMs) : Infinity;
  return bars.filter(b => b.t >= from && b.t <= to);
}

/* Merge freshly fetched bars over a stored series.
 *
 * The newest stored bar is normally incomplete — it is the one still forming —
 * so incoming bars replace stored ones with the same timestamp rather than
 * being appended beside them. */
function apply(existing, incoming) {
  if (!incoming || !incoming.length) return existing || [];
  if (!existing || !existing.length) return incoming.slice();

  const byTime = new Map();
  existing.forEach(bar => byTime.set(bar.t, bar));
  incoming.forEach(bar => byTime.set(bar.t, bar));

  return Array.from(byTime.values()).sort((a, b) => a.t - b.t);
}

/* ---------- derived series ---------- */

/* Heikin Ashi. The first bar has no previous average to open from, so it opens
   at the true midpoint of its own range rather than at an invented value. */
function heikinAshi(bars) {
  if (!bars || !bars.length) return [];
  const out = [];
  let previous = null;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const close = (bar.o + bar.h + bar.l + bar.c) / 4;
    const open = previous ? (previous.o + previous.c) / 2 : (bar.o + bar.c) / 2;
    const candle = {
      t: bar.t,
      o: open,
      h: Math.max(bar.h, open, close),
      l: Math.min(bar.l, open, close),
      c: close,
      v: bar.v
    };
    out.push(candle);
    previous = candle;
  }
  return out;
}

/* Renko. Bricks form on price movement, not on the clock, so the resulting
 * series has no fixed spacing in time — each brick carries the timestamp of the
 * bar that completed it, which is what a crosshair should report.
 *
 * Closes are used rather than highs and lows: building bricks from intrabar
 * extremes implies knowledge of the order in which they occurred within the
 * bar, which candle data does not contain. */
function renko(bars, brickSize) {
  const size = Number(brickSize);
  if (!bars || !bars.length || !Number.isFinite(size) || size <= 0) return [];

  const out = [];
  let base = bars[0].c;

  for (let i = 1; i < bars.length; i++) {
    const price = bars[i].c;
    let moves = Math.floor(Math.abs(price - base) / size);
    if (moves < 1) continue;
    const direction = price > base ? 1 : -1;

    while (moves-- > 0) {
      const open = base;
      const close = base + direction * size;
      out.push({
        t: bars[i].t,
        o: open,
        h: Math.max(open, close),
        l: Math.min(open, close),
        c: close,
        v: null,          // a brick spans an unknown share of one or more bars
        direction
      });
      base = close;
    }
  }
  return out;
}

/* A brick size derived from average true range, so the series adapts to the
   instrument instead of requiring a hand-picked number per symbol. */
function atr(bars, period) {
  if (!bars || bars.length < 2) return null;
  const length = period || 14;
  const trueRanges = [];
  for (let i = 1; i < bars.length; i++) {
    const previousClose = bars[i - 1].c;
    trueRanges.push(Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - previousClose),
      Math.abs(bars[i].l - previousClose)
    ));
  }
  if (trueRanges.length < length) return null;
  const window = trueRanges.slice(-length);
  return window.reduce((sum, v) => sum + v, 0) / window.length;
}

/* Range bars: a new bar begins once price has covered a fixed distance. Like
   Renko, these are price-driven and carry the completing bar's timestamp. */
function rangeBars(bars, span) {
  const width = Number(span);
  if (!bars || !bars.length || !Number.isFinite(width) || width <= 0) return [];

  const out = [];
  let current = null;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!current) {
      current = { t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v };
      continue;
    }
    current.h = Math.max(current.h, bar.h);
    current.l = Math.min(current.l, bar.l);
    current.c = bar.c;
    current.t = bar.t;
    if (current.v !== null && bar.v !== null) current.v += bar.v;
    else if (bar.v !== null) current.v = bar.v;

    if (current.h - current.l >= width) {
      out.push(current);
      current = null;
    }
  }
  if (current) out.push(current);
  return out;
}

/* Close prices, with nulls preserved so indicator output stays aligned to the
   input length. */
function closes(bars) {
  return (bars || []).map(b => (b && Number.isFinite(b.c) ? b.c : null));
}

function volumes(bars) {
  return (bars || []).map(b => (b && b.v !== null && Number.isFinite(b.v) ? b.v : null));
}

const API = {
  TIMEFRAMES, timeframeMs,
  fromArrays, dedupe, mergeSlot, bucket, resample,
  upTo, trim, apply,
  heikinAshi, renko, rangeBars, atr,
  closes, volumes
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') { window.T = window.T || {}; window.T.candles = API; }

}());
