'use strict';
/* Market layer tests.
 *
 * The candle suites and the freshness suites are the ones that protect the
 * application's central promise. A chart that quietly under-reports its own
 * highs, or a badge that says live over a figure from Friday, are both failures
 * of the same kind: the screen looks right and is not.
 */

const instrument = require('../src/market/instrument');
const candles = require('../src/market/candles');
const freshness = require('../src/market/freshness');
const integrity = require('../src/market/integrity');
const cboe = require('../src/market/providers/cboe');
const binance = require('../src/market/providers/binance');
const yahoo = require('../src/market/providers/yahoo');
const { Engine } = require('../src/market/engine');
const { CLASS } = require('../src/core/num');

/* A deterministic series: a rise, a spike, a fall. The spike sits inside a slot
   so that any thinning implementation loses it and any merging one keeps it. */
function series() {
  return [
    { t: 60000 * 0, o: 10, h: 11, l: 9.5, c: 10.5, v: 100 },
    { t: 60000 * 1, o: 10.5, h: 18, l: 10.4, c: 11, v: 250 },   // the spike
    { t: 60000 * 2, o: 11, h: 11.5, l: 10.8, c: 11.2, v: 120 },
    { t: 60000 * 3, o: 11.2, h: 11.4, l: 8, c: 8.5, v: 400 },   // the low
    { t: 60000 * 4, o: 8.5, h: 9, l: 8.4, c: 8.9, v: 90 },
    { t: 60000 * 5, o: 8.9, h: 9.2, l: 8.7, c: 9.1, v: 110 }
  ];
}

async function run(t) {
  const { suite, asyncSuite, ok, eq, near, throws } = t;

  /* ============ symbols ============ */
  console.log('\nSymbols — the whole input surface between a text box and a URL');

  suite('real symbol shapes are accepted across every asset class', () => {
    eq(instrument.normaliseSymbol('nvda'), 'NVDA');
    eq(instrument.normaliseSymbol('HSBA.L'), 'HSBA.L');
    eq(instrument.normaliseSymbol('BRK-B'), 'BRK-B');
    eq(instrument.normaliseSymbol('^GSPC'), '^GSPC');
    eq(instrument.normaliseSymbol('EURUSD=X'), 'EURUSD=X');
    eq(instrument.normaliseSymbol('GC=F'), 'GC=F');
    eq(instrument.normaliseSymbol('BTC-USD'), 'BTC-USD');
  });

  suite('anything that could alter a URL is refused', () => {
    eq(instrument.normaliseSymbol('NVDA?foo=bar'), null);
    eq(instrument.normaliseSymbol('../../etc/passwd'), null);
    eq(instrument.normaliseSymbol('NVDA&x=1'), null);
    eq(instrument.normaliseSymbol('NVDA NVDA'), null);
    eq(instrument.normaliseSymbol(''), null);
    eq(instrument.normaliseSymbol(null), null);
    eq(instrument.normaliseSymbol('A'.repeat(40)), null);
  });

  suite('the provider classification wins over the symbol shape', () => {
    /* A symbol ending -USD looks like crypto, but when the source says it is an
       equity the source is right. */
    eq(instrument.classFromProvider('CRYPTOCURRENCY'), CLASS.CRYPTO);
    eq(instrument.classFromProvider('EQUITY'), CLASS.EQUITY);
    eq(instrument.classFromProvider('nonsense'), null);
  });

  suite('symbol shape classifies only as a fallback, and admits when it cannot', () => {
    eq(instrument.classFromSymbol('^GSPC'), CLASS.INDEX);
    eq(instrument.classFromSymbol('EURUSD=X'), CLASS.CURRENCY);
    eq(instrument.classFromSymbol('GC=F'), CLASS.FUTURE);
    eq(instrument.classFromSymbol('BTC-USD'), CLASS.CRYPTO);
    eq(instrument.classFromSymbol('NVDA'), CLASS.UNKNOWN, 'a bare ticker is not classifiable by shape');
  });

  suite('a quote block has every field present, as null where unpublished', () => {
    const q = instrument.quote({ last: 10 });
    eq(q.last, 10);
    eq(q.bid, null);
    ok('openInterest' in q, 'an unpublished field must be null, not absent');
    eq(q.volume, null);
  });

  suite('an instrument that never closes is marked continuous', () => {
    eq(instrument.isContinuous(CLASS.CRYPTO), true);
    eq(instrument.isContinuous(CLASS.EQUITY), false);
  });

  /* ============ candles ============ */
  console.log('\nCandles — a null close and a lost high are the two silent chart bugs');

  suite('a null close is skipped, never turned into a bar at zero', () => {
    const bars = candles.fromArrays(
      [1, 2, 3], [10, null, 12], [11, null, 13], [9, null, 11], [10.5, null, 12.5], [100, null, 120]
    );
    eq(bars.length, 2, 'the null interval produces no bar at all');
    ok(bars.every(b => b.c > 0), 'no bar may sit at zero');
    ok(bars.every(b => b.l > 0), 'no low may collapse to zero');
  });

  suite('a close-only interval still draws, using the close for the missing sides', () => {
    const bars = candles.fromArrays([1], [null], [null], [null], [10], [null]);
    eq(bars.length, 1);
    eq(bars[0].o, 10);
    eq(bars[0].h, 10);
    eq(bars[0].l, 10);
    eq(bars[0].v, null, 'unreported volume stays null rather than becoming zero');
  });

  suite('bars arrive sorted and de-duplicated whatever order the source used', () => {
    const bars = candles.fromArrays([3, 1, 2], [1, 1, 1], [1, 1, 1], [1, 1, 1], [3, 1, 2], [1, 1, 1]);
    eq(bars.map(b => b.c).join(','), '1,2,3');
  });

  suite('reducing bar count MERGES, so the highs and lows survive', () => {
    const merged = candles.bucket(series(), 3);
    eq(merged.length, 3);
    const highs = merged.map(b => b.h);
    ok(highs.indexOf(18) !== -1, 'the spike high must survive the reduction');
    const lows = merged.map(b => b.l);
    ok(lows.indexOf(8) !== -1, 'the low must survive the reduction');
  });

  suite('merged volume sums, but stays null when nothing reported any', () => {
    const merged = candles.bucket(series(), 3);
    eq(merged[0].v, 350, '100 + 250');
    const silent = candles.bucket([
      { t: 0, o: 1, h: 1, l: 1, c: 1, v: null },
      { t: 1, o: 1, h: 1, l: 1, c: 1, v: null }
    ], 1);
    eq(silent[0].v, null, 'an index reports no volume; zero would be a claim about activity');
  });

  suite('resampling aligns to the clock, not to whichever bar came first', () => {
    /* Bars starting at 09:37 must still produce hourly bars stamped on the
       hour, or the same instrument charts differently depending on how much
       history happened to be loaded. */
    const start = Date.parse('2026-01-05T09:37:00Z');
    const minutes = [];
    for (let i = 0; i < 180; i++) {
      minutes.push({ t: start + i * 60000, o: 10, h: 10.5, l: 9.5, c: 10 + (i % 5) * 0.1, v: 10 });
    }
    const hourly = candles.resample(minutes, '1h', '1m');
    hourly.forEach(bar => eq(bar.t % (60 * 60 * 1000), 0, 'every hourly bar sits on the hour'));
  });

  suite('resampling never invents a finer series than it was given', () => {
    throws(() => candles.resample(series(), '1m', '1h'),
      'deriving minutes from hours means inventing opens, closes and extremes');
  });

  suite('resampling keeps the first open and the last close of each slot', () => {
    const start = Date.parse('2026-01-05T10:00:00Z');
    const bars = [];
    for (let i = 0; i < 60; i++) bars.push({ t: start + i * 60000, o: 100 + i, h: 200 + i, l: i, c: 100 + i, v: 1 });
    const hourly = candles.resample(bars, '1h', '1m');
    eq(hourly.length, 1);
    eq(hourly[0].o, 100, 'the open of the first bar');
    eq(hourly[0].c, 159, 'the close of the last bar');
    eq(hourly[0].h, 259, 'the highest high');
    eq(hourly[0].l, 0, 'the lowest low');
    eq(hourly[0].v, 60);
  });

  suite('nothing after the replay cursor can leave the look-ahead guard', () => {
    /* This is the property the whole replay and backtest surface rests on. */
    const bars = series();
    const visible = candles.upTo(bars, 60000 * 2);
    eq(visible.length, 3);
    ok(visible.every(b => b.t <= 60000 * 2), 'no future bar may be returned');
    eq(candles.upTo(bars, -1).length, 0);
    eq(candles.upTo(bars, null).length, 0, 'a missing cursor reveals nothing, rather than everything');
    eq(candles.upTo(bars, Infinity).length, 0, 'an infinite cursor is not a valid cursor');
  });

  suite('fresh bars replace the forming bar rather than doubling it', () => {
    const held = series();
    const incoming = [{ t: 60000 * 5, o: 8.9, h: 9.9, l: 8.7, c: 9.8, v: 300 }];
    const merged = candles.apply(held, incoming);
    eq(merged.length, 6, 'the same timestamp updates in place');
    eq(merged[5].c, 9.8, 'the newer figure wins');
  });

  suite('Heikin Ashi opens the first bar from its own range, not from nothing', () => {
    const ha = candles.heikinAshi(series());
    eq(ha.length, 6);
    ok(ha.every(b => Number.isFinite(b.o) && Number.isFinite(b.c)), 'no NaN may reach the chart');
    ok(ha.every(b => b.h >= b.o && b.h >= b.c), 'the high bounds the body');
    ok(ha.every(b => b.l <= b.o && b.l <= b.c), 'the low bounds the body');
  });

  suite('Renko bricks are uniform and carry no invented volume', () => {
    const bricks = candles.renko(series(), 1);
    ok(bricks.length > 0, 'a series spanning several units must produce bricks');
    bricks.forEach(b => near(Math.abs(b.c - b.o), 1, 1e-9, 'every brick is exactly one unit'));
    ok(bricks.every(b => b.v === null), 'a brick spans an unknown share of its bars, so volume is null');
  });

  suite('a brick size that is not a positive number produces nothing', () => {
    eq(candles.renko(series(), 0).length, 0);
    eq(candles.renko(series(), null).length, 0);
    eq(candles.renko(series(), -5).length, 0);
  });

  suite('average true range needs enough bars and says so by returning null', () => {
    eq(candles.atr(series(), 14), null, 'six bars cannot produce a fourteen-period average');
    ok(candles.atr(series(), 3) > 0);
  });

  /* ============ freshness ============ */
  console.log('\nFreshness — silence about latency is not a claim of real-time');

  const openSession = () => {
    const now = Date.now();
    return { tz: 'America/New_York', regular: { start: now - 3600000, end: now + 3600000 }, hasExtended: false };
  };

  suite('no timestamp means unverified, never live', () => {
    const state = freshness.assess({ at: null, session: openSession() });
    eq(state.state, freshness.STATE.UNKNOWN);
    ok(/no timestamp/i.test(state.reason));
  });

  suite('a source that says nothing about latency is treated as delayed', () => {
    const state = freshness.assess({ at: Date.now() - 5000, session: openSession(), realtime: null, delaySeconds: null });
    eq(state.state, freshness.STATE.DELAYED);
    eq(state.label, 'Delayed', 'with no interval to name');
  });

  suite('real-time requires the provider to claim it AND declare no delay', () => {
    eq(freshness.assess({ at: Date.now() - 2000, session: openSession(), realtime: true, delaySeconds: 0 }).state,
      freshness.STATE.LIVE);
    eq(freshness.assess({ at: Date.now() - 2000, session: openSession(), realtime: true, delaySeconds: 900 }).state,
      freshness.STATE.DELAYED, 'a claimed real-time feed with a declared delay is delayed');
  });

  suite('a declared delay is named in the badge', () => {
    const state = freshness.assess({ at: Date.now() - 5000, session: openSession(), delaySeconds: 900 });
    eq(state.label, 'Delayed 15 minutes');
  });

  suite('a closed market shows the last price of the session, not a fault', () => {
    const now = Date.now();
    const closed = { tz: 'America/New_York', regular: { start: now - 7200000, end: now - 3600000 } };
    const state = freshness.assess({ at: now - 3600000, session: closed });
    eq(state.state, freshness.STATE.CLOSED);
  });

  suite('a declared feed that stops during a live session goes stale quickly', () => {
    const state = freshness.assess({
      at: Date.now() - 10 * 60 * 1000, session: openSession(), cadence: 20000, delaySeconds: 0, realtime: true
    });
    eq(state.state, freshness.STATE.STALE);
  });

  suite('an undeclared feed is given rope, because a gap is not proof of death', () => {
    /* Thinly traded futures and yield indices routinely go ten minutes between
       prints on a feed that is working. Calling those stale trains the operator
       to ignore the badge. */
    const ten = freshness.assess({ at: Date.now() - 10 * 60 * 1000, session: openSession(), cadence: 20000 });
    eq(ten.state, freshness.STATE.DELAYED, 'ten minutes with an unknown delay is not yet a fault');
    const hour = freshness.assess({ at: Date.now() - 60 * 60 * 1000, session: openSession(), cadence: 20000 });
    eq(hour.state, freshness.STATE.STALE, 'an hour is');
  });

  suite('a timestamp from the future is refused rather than aged', () => {
    const state = freshness.assess({ at: Date.now() + 10 * 60 * 1000, session: openSession() });
    eq(state.state, freshness.STATE.UNKNOWN);
    eq(state.suspect, true);
  });

  suite('explicitly requested history is never judged stale', () => {
    const state = freshness.assess({ at: Date.parse('2020-03-01'), historical: true });
    eq(state.state, freshness.STATE.HISTORICAL);
  });

  suite('the worst state among many is the one reported', () => {
    eq(freshness.worst(['LIVE', 'DELAYED', 'STALE']), freshness.STATE.STALE);
    eq(freshness.worst(['LIVE', 'CLOSED']), freshness.STATE.CLOSED);
    eq(freshness.worst(['LIVE', 'LIVE']), freshness.STATE.LIVE);
    eq(freshness.worst([]), freshness.STATE.UNKNOWN);
  });

  suite('an unverified or stopped figure is not safe to compute against', () => {
    eq(freshness.trustworthy('LIVE'), true);
    eq(freshness.trustworthy('CLOSED'), true);
    eq(freshness.trustworthy('STALE'), false);
    eq(freshness.trustworthy('UNKNOWN'), false);
  });

  /* ============ extended hours ============ */
  console.log('\nExtended hours — a pre/post print is a different figure with its own timestamp');

  const extendedSession = () => {
    const now = Date.now();
    /* Regular closed an hour ago; post-market runs for another two. */
    return {
      tz: 'America/New_York', hasExtended: true,
      regular: { start: now - 6 * 3600000, end: now - 3600000 },
      post: { start: now - 3600000, end: now + 2 * 3600000 }
    };
  };

  suite('a regular-session figure is CLOSED once trading moves to the post-market window', () => {
    /* The trap this whole file exists to avoid: the regular print is frozen at
       the close, and treating the post-market window as still "running" for
       that figure ages it into a false STALE alarm on three perfectly healthy
       stocks the moment after-hours trading began. */
    const state = freshness.assess({ at: Date.now() - 3600000, session: extendedSession(), cadence: 20000 });
    eq(state.state, freshness.STATE.CLOSED);
  });

  suite('a figure explicitly marked as the extended print is judged live in that window', () => {
    const state = freshness.assess({
      at: Date.now() - 5000, session: extendedSession(), cadence: 60000,
      extendedFigure: true, realtime: true, delaySeconds: 0
    });
    eq(state.state, freshness.STATE.LIVE);
  });

  suite('the extended flag does nothing outside a pre/post window', () => {
    const now = Date.now();
    const openNow = { tz: 'America/New_York', regular: { start: now - 3600000, end: now + 3600000 } };
    const state = freshness.assess({ at: now - 5000, session: openNow, extendedFigure: true, realtime: true, delaySeconds: 0 });
    eq(state.state, freshness.STATE.LIVE, 'the regular session already covers it — the flag is not a blanket override');
  });

  /* ============ integrity ============ */
  console.log('\nIntegrity — catching what no market move can explain');

  suite('a misplaced decimal point is recognised as one', () => {
    eq(integrity.decimalFactor(10), 10);
    eq(integrity.decimalFactor(0.01), 0.01);
    eq(integrity.decimalFactor(100.5), 100, 'within tolerance');
    eq(integrity.decimalFactor(1.05), null, 'an ordinary move is not a decimal shift');
    eq(integrity.decimalFactor(3), null);
    eq(integrity.decimalFactor(0), null);
  });

  const model = extra => Object.assign({
    symbol: 'NVDA', assetClass: CLASS.EQUITY,
    quote: { last: 100, dayHigh: 105, dayLow: 95, previousClose: 99, bid: 99.9, ask: 100.1 }
  }, extra || {});

  suite('a healthy quote raises nothing', () => {
    eq(integrity.checkQuote(model()).length, 0);
  });

  suite('a price of exactly zero on a traded instrument blocks', () => {
    const found = integrity.checkQuote(model({ quote: { last: 0, dayHigh: null, dayLow: null, previousClose: 99, bid: null, ask: null } }));
    ok(found.some(f => f.code === 'price.zero' && f.severity === integrity.SEVERITY.BLOCK));
  });

  suite('a negative price blocks for equities but is allowed for futures', () => {
    /* A crude oil contract settled below zero in April 2020. A rule refusing
       negative futures prices would have called that a data error. */
    const equity = integrity.checkQuote(model({ quote: { last: -5, dayHigh: null, dayLow: null, previousClose: 99, bid: null, ask: null } }));
    ok(equity.some(f => f.code === 'price.negative'));
    const future = integrity.checkQuote(model({
      assetClass: CLASS.FUTURE,
      quote: { last: -37.63, dayHigh: null, dayLow: null, previousClose: 18, bid: null, ask: null }
    }));
    ok(!future.some(f => f.code === 'price.negative'), 'a negative futures settlement is a real event');
  });

  suite('an inverted session range blocks', () => {
    const found = integrity.checkQuote(model({ quote: { last: 100, dayHigh: 95, dayLow: 105, previousClose: 99, bid: null, ask: null } }));
    ok(found.some(f => f.code === 'range.inverted' && f.severity === integrity.SEVERITY.BLOCK));
  });

  suite('a crossed book is reported but does not block', () => {
    const found = integrity.checkQuote(model({ quote: { last: 100, dayHigh: 105, dayLow: 95, previousClose: 99, bid: 101, ask: 100 } }));
    const crossed = found.find(f => f.code === 'book.crossed');
    ok(crossed, 'it must be reported');
    eq(crossed.severity, integrity.SEVERITY.WARN, 'a crossed book is a market state, not corruption');
  });

  suite('a split applied to one figure and not the other blocks', () => {
    const found = integrity.checkQuote(model({ quote: { last: 100, dayHigh: null, dayLow: null, previousClose: 1000, bid: null, ask: null } }));
    ok(found.some(f => f.code === 'close.decimalShift' && f.severity === integrity.SEVERITY.BLOCK));
  });

  suite('two sources differing by a factor of ten blocks', () => {
    const found = integrity.crossCheck({ last: 1532.1, symbol: 'HSBA.L', provider: 'a' }, { last: 15.321, symbol: 'HSBA.L', provider: 'b' });
    ok(found.some(f => f.code === 'cross.decimalShift' && f.severity === integrity.SEVERITY.BLOCK));
  });

  suite('two sources differing by a few percent is reported, not blocking', () => {
    /* One of these sources is explicitly delayed; a fast move opens this gap on
       data that is working correctly. */
    const found = integrity.crossCheck({ last: 100, symbol: 'NVDA', provider: 'a' }, { last: 92, symbol: 'NVDA', provider: 'b' });
    const gap = found.find(f => f.code === 'cross.disagreement');
    ok(gap, 'the disagreement is surfaced');
    eq(gap.severity, integrity.SEVERITY.WARN);
  });

  suite('sources agreeing closely raise nothing at all', () => {
    eq(integrity.crossCheck({ last: 100, provider: 'a' }, { last: 100.2, provider: 'b' }).length, 0);
  });

  suite('an impossible move within seconds blocks, by asset class', () => {
    const now = Date.now();
    const fx = integrity.checkMove(
      { last: 1.16, at: now - 5000 },
      { last: 1.30, at: now, symbol: 'EURUSD=X', assetClass: CLASS.CURRENCY }
    );
    ok(fx.some(f => f.code === 'move.impossible'), 'a currency pair does not move 12% in five seconds');

    const crypto = integrity.checkMove(
      { last: 79000, at: now - 5000 },
      { last: 86000, at: now, symbol: 'BTC-USD', assetClass: CLASS.CRYPTO }
    );
    eq(crypto.length, 0, 'the same percentage is ordinary for a cryptocurrency');
  });

  suite('a large move across a long gap is not judged, because a weekend is a gap', () => {
    const now = Date.now();
    const found = integrity.checkMove(
      { last: 100, at: now - 3 * 24 * 60 * 60 * 1000 },
      { last: 160, at: now, symbol: 'NVDA', assetClass: CLASS.EQUITY }
    );
    eq(found.length, 0);
  });

  /* ============ the kill switch ============ */
  console.log('\nSafe data mode — entered on the first fault, left only after it stays clear');

  suite('a blocking finding enters safe mode and names why', () => {
    const mode = new integrity.SafeMode({});
    eq(mode.active, false);
    mode.observe([integrity.finding('test.block', integrity.SEVERITY.BLOCK, 'A decimal point moved.')]);
    eq(mode.active, true);
    eq(mode.state().reasons.length, 1);
    ok(mode.state().reasons[0].detail.length > 0, 'the reason must be readable');
  });

  suite('safe mode withdraws acting on figures, never reading them', () => {
    const mode = new integrity.SafeMode({});
    mode.observe([integrity.finding('test.block', integrity.SEVERITY.BLOCK, 'bad')]);
    eq(mode.allows('fill'), false);
    eq(mode.allows('alert'), false);
    eq(mode.allows('research'), true, 'research must survive, or there is no way to investigate');
    eq(mode.allows('chart'), true);
  });

  suite('safe mode does not flap: it takes several clean cycles to leave', () => {
    const mode = new integrity.SafeMode({});
    mode.observe([integrity.finding('test.block', integrity.SEVERITY.BLOCK, 'bad')]);
    mode.observe([]);
    eq(mode.active, true, 'one clean cycle is not enough');
    mode.observe([]);
    mode.observe([]);
    eq(mode.active, false, 'three clean cycles clears it');
  });

  suite('a warning alone never enters safe mode', () => {
    const mode = new integrity.SafeMode({});
    mode.observe([integrity.finding('test.warn', integrity.SEVERITY.WARN, 'sources differ')]);
    eq(mode.active, false);
    eq(mode.state().warnings.length, 1, 'but it is still surfaced');
  });

  suite('a silent provider is a fault in its own right', () => {
    const mode = new integrity.SafeMode({});
    mode.fault('provider.silent', 'Nothing answered.');
    eq(mode.active, true);
  });

  /* ============ provider mechanics ============ */
  console.log('\nProviders — substitutions are disclosed and coverage is not overstated');

  suite('the broad source does not claim real-time it cannot support', () => {
    const cover = yahoo.coverage();
    eq(cover.realtime, null, 'unknown, which the freshness layer renders as delayed');
    eq(cover.delaySeconds, null);
  });

  suite('the delayed exchange source states it is delayed but not by how much', () => {
    const cover = cboe.coverage();
    eq(cover.realtime, false, 'the endpoint declares itself delayed');
    eq(cover.delaySeconds, null, 'the interval is not published, so it is not invented');
  });

  suite('the crypto venue can support a real-time claim, and does', () => {
    eq(binance.coverage().realtime, true);
    eq(binance.coverage().delaySeconds, 0);
  });

  suite('the second opinion declines instruments it does not carry', () => {
    eq(cboe.supports('NVDA'), true);
    eq(cboe.supports('HSBA.L'), false, 'not US-listed');
    eq(cboe.supports('GC=F'), false, 'a future');
    eq(cboe.supports('BTC-USD'), false, 'a cryptocurrency');
  });

  suite('a stablecoin standing in for the dollar is disclosed, not hidden', () => {
    const mapped = binance.venueSymbol('BTC-USD');
    eq(mapped.venue, 'BTCUSDT');
    eq(mapped.substituted, true);
    ok(/different instruments/i.test(mapped.note), 'the substitution must be stated in words');
  });

  suite('a pair the venue quotes directly reports no substitution', () => {
    eq(binance.venueSymbol('ETH-BTC').substituted, false);
    eq(binance.venueSymbol('NVDA'), null, 'an equity is not a crypto pair');
  });

  suite('a venue timestamp with no zone is resolved against the retrieval moment', () => {
    /* Guessing a zone shifts every figure by hours and produces a confidently
       wrong age. */
    const received = Date.parse('2026-08-24T19:31:54Z');
    const parsed = cboe.parseStamp('2026-08-24 15:31:54', received);
    eq(parsed.venueStamped, true);
    ok(Math.abs(parsed.at - received) <= 60 * 60 * 1000, 'it must land near the retrieval moment');
  });

  suite('an unreadable venue timestamp falls back and says it fell back', () => {
    const received = Date.now();
    const parsed = cboe.parseStamp('not a timestamp', received);
    eq(parsed.venueStamped, false);
    eq(parsed.at, received);
  });

  suite('the batch quote chunk stays under the limit that returns nothing', () => {
    /* Above this the endpoint answers 400 with a null result, so a watchlist
       one symbol too long shows nothing rather than most of itself. */
    ok(yahoo.SPARK_CHUNK <= 20, 'the ceiling is twenty');
  });

  /* ============ the pre/post-market print ============ */
  console.log('\nThe extended print — read from the venue\'s own marketState, never guessed at');

  suite('a post-market print is read while the venue declares POST', () => {
    const row = { marketState: 'POST', postMarketPrice: 232.5, postMarketChangePercent: 1.9, postMarketTime: 1000 };
    const extended = yahoo.extendedFrom(row);
    eq(extended.state, 'POST');
    eq(extended.price, 232.5);
    eq(extended.changePercent, 1.9);
    eq(extended.at, 1000000, 'seconds from the venue become milliseconds');
  });

  suite('POSTPOST is still the post-market print', () => {
    eq(yahoo.extendedFrom({ marketState: 'POSTPOST', postMarketPrice: 10, postMarketTime: 1 }).state, 'POST');
  });

  suite('a pre-market print is read while the venue declares PRE', () => {
    const row = { marketState: 'PRE', preMarketPrice: 228.1, preMarketChangePercent: -0.4, preMarketTime: 2000 };
    const extended = yahoo.extendedFrom(row);
    eq(extended.state, 'PRE');
    eq(extended.price, 228.1);
  });

  suite('a stale field left over from a different session is not read as current', () => {
    /* Yahoo does not clear preMarketPrice overnight or postMarketPrice the
       next morning — the row can carry a real-looking price from twelve
       hours ago at any time of day. The venue's own declared state, not
       which field happens to be non-null, is what decides whether either is
       current right now. */
    ok(yahoo.extendedFrom({ marketState: 'REGULAR', postMarketPrice: 232.5, postMarketTime: 1000 }) === null);
    ok(yahoo.extendedFrom({ marketState: 'CLOSED', preMarketPrice: 228.1, preMarketTime: 2000 }) === null);
  });

  suite('a declared extended state with no usable price is not fabricated', () => {
    ok(yahoo.extendedFrom({ marketState: 'POST' }) === null);
    ok(yahoo.extendedFrom({ marketState: 'POST', postMarketPrice: 232.5 }) === null, 'a price with no timestamp is not enough');
  });

  suite('the session-gated row still carries bid, ask and the extended print together', () => {
    const detail = yahoo.detailFrom({
      symbol: 'AAPL', bid: 232.4, ask: 232.6, marketState: 'POST',
      postMarketPrice: 232.5, postMarketTime: 1000, exchangeDataDelayedBy: 0
    }, { at: Date.now(), cached: false });
    eq(detail.symbol, 'AAPL');
    eq(detail.bid, 232.4);
    eq(detail.realtime, true, 'a declared zero delay is the one thing that promotes a figure to real-time');
    eq(detail.extended.state, 'POST');
  });

  /* ============ the engine's enhancement pass ============ */
  console.log('\nThe enhancement pass — bid, ask and the extended print, without ever withholding the base quote');

  function baseModel(symbol, extra) {
    return Object.assign({
      symbol,
      assetClass: 'EQUITY',
      currency: 'USD',
      session: { tz: 'America/New_York', regular: { start: 0, end: Date.now() + 3600000 } },
      quote: { last: 232, bid: null, ask: null, at: Date.now() },
      provenance: { provider: 'yahoo', endpoint: 'v8/finance/chart', at: Date.now() }
    }, extra || {});
  }

  await asyncSuite('a provider with no quoteDetail leaves the base quote untouched', async () => {
    const engine = new Engine({});
    const models = [baseModel('NVDA')];
    await engine.enhance({ quoteDetail: undefined }, ['NVDA'], models);
    eq(models[0].quote.bid, null);
  });

  await asyncSuite('bid, ask and the extended print merge onto the matching symbol only', async () => {
    const engine = new Engine({});
    const models = [baseModel('NVDA'), baseModel('AAPL')];
    const provider = {
      quoteDetail: async () => [
        { symbol: 'NVDA', bid: 231.9, ask: 232.1, bidSize: 3, askSize: 4, marketState: 'POST',
          delaySeconds: 0, realtime: true, quoteSource: 'Nasdaq',
          extended: { state: 'POST', price: 233.4, changePercent: 0.6, at: Date.now() } }
      ]
    };
    await engine.enhance(provider, ['NVDA', 'AAPL'], models);
    eq(models[0].quote.bid, 231.9);
    eq(models[0].quote.extended.price, 233.4);
    eq(models[1].quote.bid, null, 'a symbol the detail call did not answer for is left alone');
  });

  await asyncSuite('a session that could not be established withholds only the enhancement, never the base quote', async () => {
    const engine = new Engine({});
    const models = [baseModel('NVDA')];
    const provider = { quoteDetail: async () => { throw new Error('This source needs a session for that request.'); } };
    await engine.enhance(provider, ['NVDA'], models);
    eq(models[0].quote.last, 232, 'the price from the open path is exactly as it arrived');
    eq(models[0].quote.bid, null);
  });

  suite('publish() gives the extended print its own freshness rather than borrowing the base one', () => {
    const engine = new Engine({});
    const now = Date.now();
    const model = baseModel('NVDA', {
      session: {
        tz: 'America/New_York', hasExtended: true,
        regular: { start: now - 6 * 3600000, end: now - 3600000 },
        post: { start: now - 3600000, end: now + 2 * 3600000 }
      },
      quote: {
        last: 232, bid: null, ask: null, at: now - 3600000,
        extended: { state: 'POST', price: 233.4, changePercent: 0.6, at: now - 5000 }
      }
    });
    const published = engine.publish(model, []);
    eq(published.freshness.state, freshness.STATE.CLOSED, 'the regular print is correctly the closing price, not live');
    eq(published.quote.extended.freshness.state, freshness.STATE.DELAYED,
      'the extended print is judged live in its own window instead — DELAYED here because no adapter claimed real-time');
  });

  suite('enhanceLater does not return a promise for the caller to await', () => {
    /* The regression this guards against: enhance() used to be awaited
       inside cycle(), sharing Yahoo's own per-host politeness queue with
       the base price fetch — a price feed that only moves as fast as a
       session that can be refused for minutes is the exact "everything
       takes too long to load" this exists to prevent. cycle() cannot
       accidentally start awaiting this again if it has nothing to await. */
    const engine = new Engine({});
    engine.quotes.set('NVDA', baseModel('NVDA'));
    const provider = { quoteDetail: async () => [] };
    const result = engine.enhanceLater(provider, ['NVDA']);
    eq(result, undefined);
  });

  suite('a symbol is not re-enhanced until its own cadence has passed', () => {
    const engine = new Engine({});
    engine.quotes.set('NVDA', baseModel('NVDA'));
    let calls = 0;
    const provider = { quoteDetail: async () => { calls++; return []; } };
    engine.enhanceLater(provider, ['NVDA']);
    engine.enhanceLater(provider, ['NVDA']);
    eq(calls, 1, 'the second call landed inside the same cadence window and was skipped');
  });

  await asyncSuite('enhanceLater republishes and emits only once the fetch actually completes', async () => {
    const engine = new Engine({});
    engine.quotes.set('NVDA', baseModel('NVDA'));
    const seen = [];
    engine.onUpdate(models => seen.push(...models));
    const provider = {
      quoteDetail: async () => [{ symbol: 'NVDA', bid: 231.9, ask: 232.1, marketState: 'REGULAR', extended: null }]
    };
    engine.enhanceLater(provider, ['NVDA']);
    eq(seen.length, 0, 'nothing has been emitted synchronously — cycle() moved on already');
    await new Promise(resolve => setTimeout(resolve, 0));
    eq(seen.length, 1);
    eq(seen[0].quote.bid, 231.9);
  });

  /* ============ footprint ============ */
  console.log('\nFootprint — built only from printed trades, never modelled');

  suite('aggressor side splits volume into buy and sell columns', () => {
    const tape = {
      trades: [
        { at: 1000, price: 100, quantity: 2, aggressor: 'buy' },
        { at: 1500, price: 100, quantity: 3, aggressor: 'sell' },
        { at: 2000, price: 101, quantity: 1, aggressor: 'buy' }
      ]
    };
    const bars = binance.footprint(tape, 60000, 1);
    eq(bars.length, 1);
    eq(bars[0].buyVolume, 3);
    eq(bars[0].sellVolume, 3);
    eq(bars[0].delta, 0);
    eq(bars[0].levels.length, 2, 'two price levels');
    eq(bars[0].levels[0].price, 101, 'levels are ordered high to low');
  });
}

module.exports = { run };
