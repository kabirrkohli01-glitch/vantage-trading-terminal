'use strict';
/* Portfolio tests.
 *
 * These check arithmetic that decides what the operator believes about their
 * own money. Every figure below was worked out by hand first and the expected
 * values are written as the workings, so a failure says which step disagrees.
 */

const { Ledger, transaction, BOOK, KIND } = require('../src/portfolio/ledger');
const positions = require('../src/portfolio/positions');
const valuation = require('../src/portfolio/valuation');
const { Store } = require('../src/core/store');
const paths = require('../src/core/paths');

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.parse('2026-01-05T10:00:00Z');

function tx(kind, extra) {
  return transaction(Object.assign({
    book: BOOK.MIRROR, kind, at: BASE, symbol: 'NVDA', currency: 'USD', fees: 0
  }, extra));
}

function run(t) {
  const { suite, ok, eq, near, throws } = t;

  /* ============ the ledger ============ */
  console.log('\nThe ledger — a transaction that is wrong must be refused, not corrected');

  suite('a trade needs a quantity, a price, a currency and a date', () => {
    throws(() => tx(KIND.BUY, { quantity: null, price: 100 }), 'no quantity');
    throws(() => tx(KIND.BUY, { quantity: 10, price: null }), 'no price');
    throws(() => tx(KIND.BUY, { quantity: 10, price: 100, currency: null }), 'no currency');
    throws(() => transaction({ book: BOOK.MIRROR, kind: KIND.BUY, quantity: 10, price: 100, currency: 'USD' }), 'no date');
  });

  suite('a quantity is always positive and the type carries the direction', () => {
    throws(() => tx(KIND.BUY, { quantity: -10, price: 100 }),
      'a negative quantity would make the type and the sign disagree');
    throws(() => tx(KIND.SELL, { quantity: 0, price: 100 }));
  });

  suite('a trade dated in the future is refused', () => {
    throws(() => tx(KIND.BUY, { quantity: 1, price: 1, at: Date.now() + 40 * DAY }),
      'it would sit at the end of the ledger changing everything computed from it');
  });

  suite('a transaction must belong to a book', () => {
    throws(() => transaction({ kind: KIND.BUY, at: BASE, symbol: 'NVDA', quantity: 1, price: 1, currency: 'USD' }));
    throws(() => transaction({ book: 'imaginary', kind: KIND.BUY, at: BASE, symbol: 'NVDA', quantity: 1, price: 1, currency: 'USD' }));
  });

  suite('an unknown transaction type is refused rather than ignored', () => {
    throws(() => transaction({ book: BOOK.MIRROR, kind: 'transfer', at: BASE }));
  });

  suite('building a transaction is idempotent, so editing one cannot empty it', () => {
    /* An edit re-validates the stored record with a patch on top. If building
       only understood the field name a form sends, every deposit, dividend and
       fee would lose its amount the moment anything about it was edited — and
       validation would then refuse the record it had just emptied. */
    const deposit = transaction({ book: BOOK.MIRROR, kind: KIND.DEPOSIT, at: BASE, currency: 'USD', amount: 10000 });
    const rebuilt = transaction(deposit);
    eq(rebuilt.price, 10000);

    const dividend = transaction({ book: BOOK.MIRROR, kind: KIND.DIVIDEND, at: BASE, symbol: 'NVDA', currency: 'USD', amount: 42.5 });
    eq(transaction(dividend).price, 42.5);

    const ledger = new Ledger(new Store(paths.tempDir('ledger')));
    const stored = ledger.add({ book: BOOK.MIRROR, kind: KIND.DEPOSIT, at: BASE, currency: 'USD', amount: 500 });
    const edited = ledger.update(stored.id, { note: 'opening balance' });
    eq(edited.price, 500, 'editing a note must not destroy the amount');
    eq(edited.id, stored.id, 'and the record keeps its identity rather than duplicating');
  });

  suite('the three books are kept apart in storage', () => {
    const ledger = new Ledger(new Store(paths.tempDir('ledger')));
    ledger.add(tx(KIND.BUY, { quantity: 10, price: 100 }));
    ledger.add(tx(KIND.BUY, { quantity: 5, price: 100, book: BOOK.PAPER }));
    eq(ledger.all(BOOK.MIRROR).length, 1);
    eq(ledger.all(BOOK.PAPER).length, 1);
    eq(ledger.all().length, 2, 'and both are still in the ledger');
  });

  /* ============ positions ============ */
  console.log('\nPositions — derived from the trades, so an average cannot go stale');

  suite('a single purchase produces the position it describes', () => {
    const [p] = positions.build([tx(KIND.BUY, { quantity: 10, price: 100 })]);
    eq(p.quantity, 10);
    eq(p.averageEntry, 100);
    eq(p.costBasis, 1000);
    eq(p.direction, 'long');
    eq(p.realised, 0);
  });

  suite('a second purchase produces a weighted average, not a mean of prices', () => {
    /* 10 at 100 and 30 at 200 is 7000 over 40 shares = 175, not 150. */
    const [p] = positions.build([
      tx(KIND.BUY, { quantity: 10, price: 100 }),
      tx(KIND.BUY, { quantity: 30, price: 200, at: BASE + DAY })
    ]);
    eq(p.quantity, 40);
    eq(p.averageEntry, 175);
    eq(p.costBasis, 7000);
  });

  suite('first in first out realises against the earliest purchase', () => {
    /* Bought 10 at 100 then 10 at 200; sold 10 at 250.
       FIFO consumes the 100 lot: (250 − 100) × 10 = 1500. */
    const [p] = positions.build([
      tx(KIND.BUY, { quantity: 10, price: 100 }),
      tx(KIND.BUY, { quantity: 10, price: 200, at: BASE + DAY }),
      tx(KIND.SELL, { quantity: 10, price: 250, at: BASE + 2 * DAY })
    ], { method: 'fifo' });
    eq(p.realised, 1500);
    eq(p.quantity, 10);
    eq(p.averageEntry, 200, 'what is left is the later lot');
  });

  suite('last in first out realises a different figure from the same trades', () => {
    /* The same trades, consuming the 200 lot: (250 − 200) × 10 = 500. The
       method changes the answer, which is why it is recorded on the result. */
    const [p] = positions.build([
      tx(KIND.BUY, { quantity: 10, price: 100 }),
      tx(KIND.BUY, { quantity: 10, price: 200, at: BASE + DAY }),
      tx(KIND.SELL, { quantity: 10, price: 250, at: BASE + 2 * DAY })
    ], { method: 'lifo' });
    eq(p.realised, 500);
    eq(p.averageEntry, 100);
    eq(p.methodLabel, 'Last in, first out', 'and the result names the method used');
  });

  suite('average cost pools the lots before matching', () => {
    /* Pooled entry is 150, so (250 − 150) × 10 = 1000. */
    const [p] = positions.build([
      tx(KIND.BUY, { quantity: 10, price: 100 }),
      tx(KIND.BUY, { quantity: 10, price: 200, at: BASE + DAY }),
      tx(KIND.SELL, { quantity: 10, price: 250, at: BASE + 2 * DAY })
    ], { method: 'average' });
    eq(p.realised, 1000);
    eq(p.averageEntry, 150);
  });

  suite('selling everything closes the position exactly', () => {
    const [p] = positions.build([
      tx(KIND.BUY, { quantity: 10, price: 100 }),
      tx(KIND.SELL, { quantity: 10, price: 120, at: BASE + DAY })
    ]);
    eq(p.quantity, 0, 'no floating-point residue may leave a position looking open');
    eq(p.open, false);
    eq(p.realised, 200);
    eq(p.averageEntry, null);
  });

  suite('a sale with nothing held opens a short', () => {
    const [p] = positions.build([tx(KIND.SELL, { quantity: 10, price: 100 })]);
    eq(p.quantity, -10);
    eq(p.direction, 'short');
    eq(p.averageEntry, 100);
  });

  suite('covering a short profits when the price fell', () => {
    /* Sold at 100, bought back at 90: a hundred pounds made, not lost. */
    const [p] = positions.build([
      tx(KIND.SELL, { quantity: 10, price: 100 }),
      tx(KIND.BUY, { quantity: 10, price: 90, at: BASE + DAY })
    ]);
    eq(p.realised, 100);
    eq(p.quantity, 0);
  });

  suite('selling more than is held closes the long and opens a short', () => {
    const [p] = positions.build([
      tx(KIND.BUY, { quantity: 10, price: 100 }),
      tx(KIND.SELL, { quantity: 15, price: 120, at: BASE + DAY })
    ]);
    eq(p.realised, 200, 'the ten held are realised at 120');
    eq(p.quantity, -5, 'and the excess opens a short');
    eq(p.averageEntry, 120);
  });

  suite('a split changes the share count and leaves the cost alone', () => {
    /* A two-for-one on 10 shares bought at 100: 20 shares at 50. The holding is
       worth exactly what it was worth the moment before. */
    const [p] = positions.build([
      tx(KIND.BUY, { quantity: 10, price: 100 }),
      tx(KIND.SPLIT, { ratio: 2, at: BASE + DAY })
    ]);
    eq(p.quantity, 20);
    eq(p.averageEntry, 50);
    eq(p.costBasis, 1000, 'a split that altered cost would show as a phantom gain');
  });

  suite('a reverse split works the same way', () => {
    const [p] = positions.build([
      tx(KIND.BUY, { quantity: 100, price: 5 }),
      tx(KIND.SPLIT, { ratio: 0.1, at: BASE + DAY })
    ]);
    eq(p.quantity, 10);
    eq(p.averageEntry, 50);
    eq(p.costBasis, 500);
  });

  suite('a dividend is income and does not touch the cost basis', () => {
    const [p] = positions.build([
      tx(KIND.BUY, { quantity: 100, price: 10 }),
      transaction({ book: BOOK.MIRROR, kind: KIND.DIVIDEND, at: BASE + DAY, symbol: 'NVDA', currency: 'USD', amount: 42.5 })
    ]);
    eq(p.dividends, 42.5);
    eq(p.costBasis, 1000, 'a dividend is not a discount on the purchase');
    eq(p.realised, 0, 'nor is it a realised gain on the position');
  });

  suite('fees follow the quantity they belong to', () => {
    /* Ten bought with a fee of 10; five sold. Half the entry fee attaches to
       the half being closed. */
    const [p] = positions.build([
      tx(KIND.BUY, { quantity: 10, price: 100, fees: 10 }),
      tx(KIND.SELL, { quantity: 5, price: 120, at: BASE + DAY, fees: 6 })
    ]);
    eq(p.fees, 16, 'every fee paid is counted once');
    const trade = p.closedTrades[0];
    near(trade.fees, 5 + 6, 1e-9, 'five of the entry fee and all six of the exit fee');
    near(trade.grossPnl, 100, 1e-9);
    near(trade.netPnl, 89, 1e-9);
  });

  /* ============ closed trades ============ */
  console.log('\nClosed trades — the journal reads these, so they come from the ledger');

  suite('a closed trade records both ends and how long it was held', () => {
    const [p] = positions.build([
      tx(KIND.BUY, { quantity: 10, price: 100 }),
      tx(KIND.SELL, { quantity: 10, price: 130, at: BASE + 5 * DAY })
    ]);
    const trade = p.closedTrades[0];
    eq(trade.direction, 'long');
    eq(trade.quantity, 10);
    eq(trade.entryPrice, 100);
    eq(trade.exitPrice, 130);
    eq(trade.holdMs, 5 * DAY);
    eq(trade.grossPnl, 300);
  });

  suite('a partial sale produces one trade, not a whole one', () => {
    const [p] = positions.build([
      tx(KIND.BUY, { quantity: 10, price: 100 }),
      tx(KIND.SELL, { quantity: 4, price: 130, at: BASE + DAY })
    ]);
    eq(p.closedTrades.length, 1);
    eq(p.closedTrades[0].quantity, 4);
    eq(p.quantity, 6, 'and the rest stays open');
  });

  suite('one sale spanning two lots produces two trades', () => {
    /* Each has its own entry price, which is what the journal needs to compute
       an R multiple or group by entry. */
    const [p] = positions.build([
      tx(KIND.BUY, { quantity: 5, price: 100 }),
      tx(KIND.BUY, { quantity: 5, price: 200, at: BASE + DAY }),
      tx(KIND.SELL, { quantity: 10, price: 250, at: BASE + 2 * DAY })
    ]);
    eq(p.closedTrades.length, 2);
    eq(p.closedTrades[0].entryPrice, 100);
    eq(p.closedTrades[1].entryPrice, 200);
    eq(p.realised, 750 + 250);
  });

  /* ============ valuation ============ */
  console.log('\nValuation — a total carries the state of the worst price inside it');

  const quoteOf = (symbol, last, extra) => Object.assign({
    symbol, name: symbol, assetClass: 'EQUITY', currency: 'USD', priceHint: 2,
    quote: { last, previousClose: last },
    freshness: { state: 'DELAYED', label: 'Delayed' }
  }, extra || {});

  suite('a priced holding values at quantity times price', () => {
    const built = positions.build([tx(KIND.BUY, { quantity: 10, price: 100 })]);
    const out = valuation.value({
      book: BOOK.MIRROR, positions: built, accountCurrency: 'USD',
      quotes: new Map([['NVDA', quoteOf('NVDA', 130)]])
    });
    eq(out.holdings[0].marketValue, 1300);
    eq(out.holdings[0].unrealised, 300);
    near(out.holdings[0].unrealisedPct, 30, 1e-9);
    eq(out.totals.marketValue, 1300);
  });

  suite('the worst freshness among the holdings becomes the total\'s', () => {
    const built = positions.build([
      tx(KIND.BUY, { quantity: 1, price: 1 }),
      tx(KIND.BUY, { quantity: 1, price: 1, symbol: 'AAPL' })
    ]);
    const out = valuation.value({
      book: BOOK.MIRROR, positions: built, accountCurrency: 'USD',
      quotes: new Map([
        ['NVDA', quoteOf('NVDA', 10, { freshness: { state: 'LIVE', label: 'Live' } })],
        ['AAPL', quoteOf('AAPL', 10, { freshness: { state: 'STALE', label: 'Not updating' } })]
      ])
    });
    eq(out.freshness.state, 'STALE',
      'one live quote does not make a portfolio priced from a stale one current');
  });

  suite('a holding that cannot be priced is named and the total says it is short', () => {
    const built = positions.build([
      tx(KIND.BUY, { quantity: 10, price: 100 }),
      tx(KIND.BUY, { quantity: 10, price: 50, symbol: 'AAPL' })
    ]);
    const out = valuation.value({
      book: BOOK.MIRROR, positions: built, accountCurrency: 'USD',
      quotes: new Map([['NVDA', quoteOf('NVDA', 130)]])
    });
    eq(out.complete, false);
    eq(out.unpriced.length, 1);
    eq(out.unpriced[0].symbol, 'AAPL');
    ok(/excludes 1 holding/.test(out.incompleteNote), 'got: ' + out.incompleteNote);
    eq(out.totals.marketValue, 1300, 'the total is only what could actually be priced');
  });

  suite('a holding entered in pounds but quoted in pence is flagged', () => {
    /* The hundred-fold error, and it looks entirely ordinary on both sides. */
    const built = positions.build([tx(KIND.BUY, { quantity: 100, price: 15.32, symbol: 'HSBA.L', currency: 'GBP' })]);
    const out = valuation.value({
      book: BOOK.MIRROR, positions: built, accountCurrency: 'GBP',
      quotes: new Map([['HSBA.L', quoteOf('HSBA.L', 1532, { currency: 'GBp' })]])
    });
    eq(out.currencyMismatches.length, 1);
    ok(/same money at different scales/.test(out.currencyMismatches[0].reason),
      'got: ' + out.currencyMismatches[0].reason);
  });

  suite('a holding entered in one currency and quoted in another is not valued at all', () => {
    const built = positions.build([tx(KIND.BUY, { quantity: 10, price: 100, currency: 'EUR' })]);
    const out = valuation.value({
      book: BOOK.MIRROR, positions: built, accountCurrency: 'EUR',
      quotes: new Map([['NVDA', quoteOf('NVDA', 130, { currency: 'USD' })]])
    });
    eq(out.holdings[0].priced, false);
    eq(out.complete, false);
  });

  suite('no single total is produced when a rate is missing', () => {
    const built = positions.build([
      tx(KIND.BUY, { quantity: 10, price: 100 }),
      tx(KIND.BUY, { quantity: 10, price: 100, symbol: 'SAP.DE', currency: 'EUR' })
    ]);
    const out = valuation.value({
      book: BOOK.MIRROR, positions: built, accountCurrency: 'GBP',
      quotes: new Map([
        ['NVDA', quoteOf('NVDA', 130)],
        ['SAP.DE', quoteOf('SAP.DE', 110, { currency: 'EUR' })]
      ]),
      fxRates: {}
    });
    eq(out.totals, null, 'inventing a rate is how a portfolio reports a currency move as a gain');
    ok(/no exchange rate/i.test(out.rateNote), 'got: ' + out.rateNote);
    eq(out.byCurrency.length, 2, 'and the exact per-currency figures are still there');
  });

  suite('a supplied rate is used and recorded with the figure', () => {
    const built = positions.build([tx(KIND.BUY, { quantity: 10, price: 100 })]);
    const out = valuation.value({
      book: BOOK.MIRROR, positions: built, accountCurrency: 'GBP',
      quotes: new Map([['NVDA', quoteOf('NVDA', 130)]]),
      fxRates: { USDGBP: { rate: 0.8, at: BASE } }
    });
    near(out.totals.marketValue, 1040, 1e-9);
    eq(out.totals.ratesUsed.length, 1);
    eq(out.totals.ratesUsed[0].rate, 0.8);
    eq(out.totals.ratesUsed[0].at, BASE, 'the rate carries when it was observed');
  });

  suite('an inverted rate is derived rather than demanded', () => {
    const built = positions.build([tx(KIND.BUY, { quantity: 10, price: 100 })]);
    const out = valuation.value({
      book: BOOK.MIRROR, positions: built, accountCurrency: 'GBP',
      quotes: new Map([['NVDA', quoteOf('NVDA', 100)]]),
      fxRates: { GBPUSD: { rate: 1.25, at: BASE } }
    });
    near(out.totals.marketValue, 800, 1e-6);
  });

  suite('pence and pounds convert by scale, needing no market rate', () => {
    const built = positions.build([tx(KIND.BUY, { quantity: 100, price: 1500, symbol: 'HSBA.L', currency: 'GBp' })]);
    const out = valuation.value({
      book: BOOK.MIRROR, positions: built, accountCurrency: 'GBP',
      quotes: new Map([['HSBA.L', quoteOf('HSBA.L', 1600, { currency: 'GBp' })]]),
      fxRates: {}
    });
    ok(out.totals, 'a scale is not an exchange rate, so no rate is required');
    near(out.totals.marketValue, 1600, 1e-9, '100 shares at 1600p is £1,600');
  });

  suite('every valuation carries the caveat belonging to its book', () => {
    const built = positions.build([tx(KIND.BUY, { quantity: 1, price: 1 })]);
    const quotes = new Map([['NVDA', quoteOf('NVDA', 1)]]);

    const mirror = valuation.value({ book: BOOK.MIRROR, positions: built, accountCurrency: 'USD', quotes });
    ok(/not verified against a broker/i.test(mirror.caveat), 'got: ' + mirror.caveat);

    const paper = valuation.value({ book: BOOK.PAPER, positions: built, accountCurrency: 'USD', quotes });
    ok(/not real money/i.test(paper.caveat), 'got: ' + paper.caveat);

    const imported = valuation.value({ book: BOOK.IMPORTED, positions: built, accountCurrency: 'USD', quotes });
    ok(/confirmed by the broker/i.test(imported.caveat), 'got: ' + imported.caveat);
  });

  /* ============ cash ============ */
  console.log('\nCash — held per currency, because one figure would need a rate');

  suite('cash follows the trades that moved it', () => {
    const ledger = new Ledger(new Store(paths.tempDir('ledger')));
    ledger.add({ book: BOOK.MIRROR, kind: KIND.DEPOSIT, at: BASE, currency: 'USD', amount: 10000 });
    ledger.add(tx(KIND.BUY, { quantity: 10, price: 100, fees: 5, at: BASE + DAY }));
    ledger.add(tx(KIND.SELL, { quantity: 10, price: 120, fees: 5, at: BASE + 2 * DAY }));
    const cash = ledger.cash(BOOK.MIRROR);
    /* 10000 − 1005 + 1195 */
    near(cash.USD, 10190, 1e-9);
  });

  suite('two currencies stay two balances', () => {
    const ledger = new Ledger(new Store(paths.tempDir('ledger')));
    ledger.add({ book: BOOK.MIRROR, kind: KIND.DEPOSIT, at: BASE, currency: 'GBP', amount: 5000 });
    ledger.add({ book: BOOK.MIRROR, kind: KIND.DEPOSIT, at: BASE, currency: 'USD', amount: 2000 });
    const cash = ledger.cash(BOOK.MIRROR);
    eq(cash.GBP, 5000);
    eq(cash.USD, 2000);
    eq(Object.keys(cash).length, 2, 'adding them would need a rate, which the ledger does not have');
  });
}

module.exports = { run };
