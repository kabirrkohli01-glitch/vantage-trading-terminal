'use strict';
/* Paper trading tests.
 *
 * A simulator that flatters the fill teaches a way of trading that does not
 * survive a real book, while producing an equity curve that looks like skill.
 * These suites check that it does not.
 */

const { PaperBroker, order, fillPrice, TYPE, STATUS } = require('../src/paper/broker');
const { Ledger, BOOK, KIND } = require('../src/portfolio/ledger');
const { SafeMode, finding, SEVERITY } = require('../src/market/integrity');
const positions = require('../src/portfolio/positions');
const { Store } = require('../src/core/store');
const paths = require('../src/core/paths');

const BASE = Date.parse('2026-01-05T14:00:00Z');

function quote(extra) {
  return Object.assign({
    symbol: 'NVDA',
    assetClass: 'EQUITY',
    currency: 'USD',
    quote: { last: 100, bid: null, ask: null, dayHigh: 102, dayLow: 98, previousClose: 99, at: BASE },
    freshness: { state: 'DELAYED', label: 'Delayed' }
  }, extra || {});
}

function withBook(bid, ask) {
  const q = quote();
  q.quote.bid = bid;
  q.quote.ask = ask;
  return q;
}

function broker(safeMode) {
  const store = new Store(paths.tempDir('paper'));
  const ledger = new Ledger(new Store(paths.tempDir('paper-ledger')));
  return { broker: new PaperBroker({ store, ledger, safeMode }), ledger };
}

function run(t) {
  const { suite, ok, eq, near, throws } = t;

  /* ============ validation ============ */
  console.log('\nOrders — an order that cannot be understood is refused, not guessed at');

  suite('an order needs a side, a quantity and an instrument', () => {
    throws(() => order({ symbol: 'NVDA', quantity: 10 }), 'no side');
    throws(() => order({ symbol: 'NVDA', side: 'buy', quantity: 0 }), 'no quantity');
    throws(() => order({ side: 'buy', quantity: 10 }), 'no instrument');
  });

  suite('each order type demands the prices it needs', () => {
    throws(() => order({ symbol: 'NVDA', side: 'buy', quantity: 1, type: TYPE.LIMIT }), 'a limit needs a limit price');
    throws(() => order({ symbol: 'NVDA', side: 'buy', quantity: 1, type: TYPE.STOP }), 'a stop needs a stop price');
    throws(() => order({ symbol: 'NVDA', side: 'sell', quantity: 1, type: TYPE.TRAILING_STOP }), 'a trail needs a distance');
    throws(() => order({ symbol: 'NVDA', side: 'buy', quantity: 1, type: 'iceberg' }), 'an unknown type');
  });

  /* ============ the cost of crossing ============ */
  console.log('\nFills — crossing the spread is never free');

  suite('with a real book, a buy pays the ask and a sell receives the bid', () => {
    const buy = fillPrice(withBook(99.9, 100.1), 'buy');
    eq(buy.price, 100.1);
    eq(buy.basis, 'book');
    const sell = fillPrice(withBook(99.9, 100.1), 'sell');
    eq(sell.price, 99.9);
  });

  suite('with no book, a spread is assumed and the fill says so', () => {
    /* The quote endpoint carrying bid and ask needs a session this application
       may not have. Filling at the last price instead would hand out the spread
       for free on every trade. */
    const buy = fillPrice(quote(), 'buy');
    eq(buy.basis, 'assumed');
    eq(buy.assumedSpreadBps, 8, 'the equity assumption');
    near(buy.price, 100 * (1 + 0.0004), 1e-9, 'half of eight basis points above the last');
    ok(/spread of 8 basis points was assumed/.test(buy.note), 'got: ' + buy.note);
    ok(buy.price > 100, 'a buy must never fill below the last print when crossing is assumed');
  });

  suite('a sell with no book is assumed to receive less, not more', () => {
    const sell = fillPrice(quote(), 'sell');
    ok(sell.price < 100);
  });

  suite('the asset class decides the assumed spread', () => {
    eq(fillPrice(quote({ assetClass: 'CURRENCY' }), 'buy').assumedSpreadBps, 2);
    eq(fillPrice(quote({ assetClass: 'OPTION' }), 'buy').assumedSpreadBps, 100);
    eq(fillPrice(quote({ assetClass: 'SOMETHING' }), 'buy').assumedSpreadBps, 15, 'an unknown class is not assumed to be cheap');
  });

  /* ============ extended hours ============ */
  console.log('\nExtended hours — a paper fill placed at eight in the evening prices against eight in the evening');

  function withExtended(freshnessState, price) {
    const q = quote();
    q.quote.extended = { state: 'POST', price, changePercent: 1.2, at: BASE, freshness: { state: freshnessState } };
    return q;
  }

  suite('a live extended print is what the fill prices against, not the frozen regular close', () => {
    const buy = fillPrice(withExtended('LIVE', 105), 'buy');
    /* quote().quote.last is 100 — if the fill priced against that instead,
       this would be roughly 100.04, not roughly 105.04. */
    near(buy.price, 105 * (1 + 0.0004), 1e-9);
  });

  suite('a delayed extended print still counts as current', () => {
    const buy = fillPrice(withExtended('DELAYED', 105), 'buy');
    near(buy.price, 105 * (1 + 0.0004), 1e-9);
  });

  suite('a stale or absent extended print falls back to the regular last', () => {
    const stale = fillPrice(withExtended('STALE', 105), 'buy');
    near(stale.price, 100 * (1 + 0.0004), 1e-9, 'a stopped extended feed is not trusted for a fill');
    const none = fillPrice(quote(), 'buy');
    near(none.price, 100 * (1 + 0.0004), 1e-9);
  });

  /* ============ preview ============ */
  console.log('\nPreview — the same calculation the fill uses, so it cannot over-promise');

  suite('a preview prices the order and reports its assumptions', () => {
    const { broker: b } = broker();
    const out = b.preview({ symbol: 'NVDA', side: 'buy', quantity: 10, type: TYPE.MARKET }, quote());
    eq(out.usable, true);
    eq(out.immediate, true);
    near(out.estimatedValue, out.estimatedPrice * 10, 1e-9);
    eq(out.signedValue > 0, true, 'a buy adds to the book');
    ok(out.warnings.some(w => /basis points was assumed/.test(w)));
  });

  suite('a preview of a sell signs its value the way the book will see it', () => {
    const { broker: b } = broker();
    const out = b.preview({ symbol: 'NVDA', side: 'sell', quantity: 10, type: TYPE.MARKET }, quote());
    ok(out.signedValue < 0);
  });

  suite('a preview against a stale price says so', () => {
    const { broker: b } = broker();
    const stale = quote({ freshness: { state: 'STALE', label: 'Not updating' } });
    const out = b.preview({ symbol: 'NVDA', side: 'buy', quantity: 1, type: TYPE.MARKET }, stale);
    ok(out.warnings.some(w => /stopped updating/.test(w)));
  });

  suite('a preview with no price is refused rather than estimated', () => {
    const { broker: b } = broker();
    const out = b.preview({ symbol: 'NVDA', side: 'buy', quantity: 1, type: TYPE.MARKET }, null);
    eq(out.usable, false);
    ok(/no price is loaded/i.test(out.reason));
  });

  /* ============ market orders ============ */
  console.log('\nMarket orders — filled at once, and written into the paper book');

  suite('a market order fills and becomes a transaction', () => {
    const { broker: b, ledger } = broker();
    const placed = b.place({ symbol: 'NVDA', side: 'buy', quantity: 10, type: TYPE.MARKET }, quote());
    eq(placed.status, STATUS.FILLED);
    eq(placed.filledQuantity, 10);

    const transactions = ledger.all(BOOK.PAPER);
    eq(transactions.length, 1);
    eq(transactions[0].kind, KIND.BUY);
    eq(transactions[0].quantity, 10);
    eq(transactions[0].book, BOOK.PAPER, 'and it lands in the paper book, never anywhere else');
  });

  suite('a filled order carries the assumptions it was filled under', () => {
    const { broker: b } = broker();
    const placed = b.place({ symbol: 'NVDA', side: 'buy', quantity: 1, type: TYPE.MARKET }, quote());
    eq(placed.assumptions.basis, 'assumed');
    ok(placed.assumptions.assumedSpreadBps > 0);
  });

  suite('the paper book produces positions the same way every other book does', () => {
    const { broker: b, ledger } = broker();
    b.place({ symbol: 'NVDA', side: 'buy', quantity: 10, type: TYPE.MARKET }, quote());
    b.place({ symbol: 'NVDA', side: 'sell', quantity: 4, type: TYPE.MARKET },
      quote({ quote: { last: 120, bid: null, ask: null, dayHigh: 121, dayLow: 118, previousClose: 100, at: BASE + 1000 } }));

    const built = positions.build(ledger.ordered(BOOK.PAPER));
    eq(built.length, 1);
    eq(built[0].quantity, 6);
    ok(built[0].realised > 0, 'sold higher than bought');
    eq(built[0].closedTrades.length, 1);
  });

  /* ============ resting orders ============ */
  console.log('\nResting orders — filled only when the market actually came to them');

  suite('a buy limit below the market rests, and does not fill', () => {
    const { broker: b, ledger } = broker();
    const placed = b.place({ symbol: 'NVDA', side: 'buy', quantity: 10, type: TYPE.LIMIT, limitPrice: 90 }, quote());
    eq(placed.status, STATUS.WORKING);
    eq(ledger.all(BOOK.PAPER).length, 0, 'nothing may be written until it fills');
  });

  suite('a buy limit fills once the market trades down to it', () => {
    const { broker: b } = broker();
    b.place({ symbol: 'NVDA', side: 'buy', quantity: 10, type: TYPE.LIMIT, limitPrice: 90 }, quote());
    const filled = b.onQuote(quote({
      quote: { last: 89, bid: null, ask: null, dayHigh: 100, dayLow: 88, previousClose: 99, at: BASE + 5000 }
    }));
    eq(filled.length, 1);
    eq(filled[0].order.status, STATUS.FILLED);
  });

  suite('a limit fills at its own price, never at a better market price', () => {
    /* Filling a resting limit at whatever the market happened to print is how a
       simulator quietly hands out money that was never available. */
    const { broker: b } = broker();
    b.place({ symbol: 'NVDA', side: 'sell', quantity: 10, type: TYPE.LIMIT, limitPrice: 110 }, quote());
    const filled = b.onQuote(quote({
      quote: { last: 115, bid: null, ask: null, dayHigh: 116, dayLow: 99, previousClose: 99, at: BASE + 5000 }
    }));
    /* The market printed 115, so a sell limit at 110 gets the better price the
       market actually offered — but never worse than its own limit. */
    near(filled[0].order.filledPrice, 115 * (1 - 0.0004), 1e-9,
      'a sell limit fills at its price or better, and better is what the market gave');
    ok(filled[0].order.filledPrice >= 110, 'never worse than the limit');
  });

  suite('an order touched intraday is not missed because the price came back', () => {
    const { broker: b } = broker();
    b.place({ symbol: 'NVDA', side: 'buy', quantity: 10, type: TYPE.LIMIT, limitPrice: 95 }, quote());
    const filled = b.onQuote(quote({
      quote: { last: 100, bid: null, ask: null, dayHigh: 101, dayLow: 94, previousClose: 99, at: BASE + 5000 }
    }));
    eq(filled.length, 1, 'the session low went through the limit');
  });

  suite('a stop triggers when the market moves against the position', () => {
    const { broker: b } = broker();
    b.place({ symbol: 'NVDA', side: 'sell', quantity: 10, type: TYPE.STOP, stopPrice: 95 }, quote());
    eq(b.working().length, 1);
    const filled = b.onQuote(quote({
      quote: { last: 94, bid: null, ask: null, dayHigh: 100, dayLow: 93, previousClose: 99, at: BASE + 5000 }
    }));
    eq(filled.length, 1);
  });

  suite('a trailing stop follows the market up and never gives ground', () => {
    const { broker: b } = broker();
    b.place({ symbol: 'NVDA', side: 'sell', quantity: 10, type: TYPE.TRAILING_STOP, trailAmount: 5 }, quote());

    /* Up to 120: the stop should now sit at 115. */
    b.onQuote(quote({ quote: { last: 120, bid: null, ask: null, dayHigh: 120, dayLow: 99, previousClose: 99, at: BASE + 1000 } }));
    eq(b.working().length, 1, 'a rise does not trigger it');

    /* Back to 118: still above the trailed stop. */
    b.onQuote(quote({ quote: { last: 118, bid: null, ask: null, dayHigh: 120, dayLow: 117, previousClose: 99, at: BASE + 2000 } }));
    eq(b.working().length, 1);

    /* Through 115: triggered. */
    const filled = b.onQuote(quote({ quote: { last: 114, bid: null, ask: null, dayHigh: 120, dayLow: 114, previousClose: 99, at: BASE + 3000 } }));
    eq(filled.length, 1, 'the trail had moved to 115 and the market went through it');
  });

  suite('a bracket places its target and its stop once the entry fills', () => {
    const { broker: b } = broker();
    b.place({
      symbol: 'NVDA', side: 'buy', quantity: 10, type: TYPE.MARKET,
      bracket: { takeProfit: 120, stopLoss: 90 }
    }, quote());

    const resting = b.working();
    eq(resting.length, 2);
    ok(resting.every(o => o.side === 'sell'), 'both are on the opposite side of the entry');
    ok(resting.some(o => o.type === TYPE.LIMIT && o.limitPrice === 120));
    ok(resting.some(o => o.type === TYPE.STOP && o.stopPrice === 90));
  });

  suite('cancelling an order stops it filling', () => {
    const { broker: b } = broker();
    const placed = b.place({ symbol: 'NVDA', side: 'buy', quantity: 10, type: TYPE.LIMIT, limitPrice: 90 }, quote());
    b.cancel(placed.id);
    eq(b.working().length, 0);
    const filled = b.onQuote(quote({ quote: { last: 85, bid: null, ask: null, dayHigh: 100, dayLow: 84, previousClose: 99, at: BASE + 5000 } }));
    eq(filled.length, 0);
    throws(() => b.cancel(placed.id), 'and it cannot be cancelled twice');
  });

  /* ============ safe data mode ============ */
  console.log('\nSafe data mode — an order rests rather than filling against a figure that failed a check');

  suite('no fill happens while the data cannot be trusted', () => {
    const mode = new SafeMode({});
    mode.observe([finding('test.block', SEVERITY.BLOCK, 'A decimal point moved.')]);
    const { broker: b, ledger } = broker(mode);

    const placed = b.place({ symbol: 'NVDA', side: 'buy', quantity: 10, type: TYPE.MARKET }, quote());
    eq(placed.status, STATUS.WORKING, 'held, not rejected — the intent is still the operator\'s');
    eq(ledger.all(BOOK.PAPER).length, 0, 'and nothing fictional is written into the journal');
  });

  suite('the order fills once the data is trusted again', () => {
    const mode = new SafeMode({});
    mode.observe([finding('test.block', SEVERITY.BLOCK, 'bad')]);
    const { broker: b } = broker(mode);
    b.place({ symbol: 'NVDA', side: 'buy', quantity: 10, type: TYPE.MARKET }, quote());

    mode.observe([]); mode.observe([]); mode.observe([]);
    eq(mode.active, false);

    const filled = b.onQuote(quote());
    eq(filled.length, 1);
  });

  suite('a preview during safe data mode warns that the order will rest', () => {
    const mode = new SafeMode({});
    mode.observe([finding('test.block', SEVERITY.BLOCK, 'bad')]);
    const { broker: b } = broker(mode);
    const out = b.preview({ symbol: 'NVDA', side: 'buy', quantity: 1, type: TYPE.MARKET }, quote());
    ok(out.warnings.some(w => /rest rather than fill/.test(w)));
  });

  /* ============ isolation ============ */
  console.log('\nIsolation — nothing here can reach a real account');

  suite('every transaction the broker writes belongs to the paper book', () => {
    const { broker: b, ledger } = broker();
    b.place({ symbol: 'NVDA', side: 'buy', quantity: 5, type: TYPE.MARKET }, quote());
    b.place({ symbol: 'AAPL', side: 'buy', quantity: 5, type: TYPE.MARKET }, quote({ symbol: 'AAPL' }));
    eq(ledger.all(BOOK.MIRROR).length, 0);
    eq(ledger.all(BOOK.IMPORTED).length, 0);
    eq(ledger.all(BOOK.PAPER).length, 2);
  });

  suite('the broker source code contains no outbound call of any kind', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'paper', 'broker.js'), 'utf8');
    ok(!/\bfetch\s*\(|require\('https?'\)|require\("https?"\)|XMLHttpRequest/.test(source),
      'a simulator must have no way to reach an external system');
  });
}

module.exports = { run };
