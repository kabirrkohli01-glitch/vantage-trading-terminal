'use strict';
/* Journal tests.
 *
 * The statistics here are the ones a trader makes decisions about their own
 * behaviour from, so every expected value below was computed by hand and the
 * working is written beside it.
 */

const journal = require('../src/portfolio/journal');
const { Journal } = journal;
const { Store } = require('../src/core/store');
const paths = require('../src/core/paths');

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.parse('2026-01-05T14:00:00Z');

function trade(pnl, extra) {
  const base = Object.assign({
    symbol: 'NVDA',
    direction: 'long',
    quantity: 10,
    entryPrice: 100,
    exitPrice: 100 + pnl / 10,
    openedAt: BASE,
    closedAt: BASE + DAY,
    holdMs: DAY,
    grossPnl: pnl,
    fees: 0,
    netPnl: pnl,
    currency: 'USD'
  }, extra || {});
  return base;
}

/* The five-trade record used across the statistics suites: +100, −50, +200,
   −30, +10, closed on consecutive days. */
function record() {
  const pnls = [100, -50, 200, -30, 10];
  return pnls.map((pnl, i) => trade(pnl, {
    openedAt: BASE + i * DAY,
    closedAt: BASE + (i + 1) * DAY,
    symbol: i % 2 === 0 ? 'NVDA' : 'AAPL'
  }));
}

function run(t) {
  const { suite, ok, eq, near } = t;

  /* ============ identity ============ */
  console.log('\nThe journal — trades are derived, so a note must survive the replay');

  suite('the same trade fingerprints the same way every time', () => {
    const one = journal.fingerprint(trade(100));
    const two = journal.fingerprint(trade(100));
    eq(one, two);
    ok(one.length === 16, 'a short stable key');
  });

  suite('a different trade fingerprints differently', () => {
    ok(journal.fingerprint(trade(100)) !== journal.fingerprint(trade(200)));
    ok(journal.fingerprint(trade(100)) !== journal.fingerprint(trade(100, { symbol: 'AAPL' })));
    ok(journal.fingerprint(trade(100)) !== journal.fingerprint(trade(100, { closedAt: BASE + 2 * DAY })));
  });

  suite('an annotation round-trips onto its trade', () => {
    const store = new Store(paths.tempDir('journal'));
    const book = new Journal(store);
    const one = trade(100);
    const key = journal.fingerprint(one);

    book.annotate(key, { setup: 'Breakout', tags: ['Momentum', ' Gap '], stop: 95, conviction: 4 });
    const entries = book.entries([one]);

    eq(entries[0].journalled, true);
    eq(entries[0].annotation.setup, 'Breakout');
    eq(entries[0].annotation.tags.join(','), 'momentum,gap', 'tags are normalised so grouping works');
    eq(entries[0].annotation.conviction, 4);
  });

  suite('an annotation is merged rather than replaced', () => {
    const book = new Journal(new Store(paths.tempDir('journal')));
    const key = journal.fingerprint(trade(100));
    book.annotate(key, { setup: 'Breakout', stop: 95 });
    book.annotate(key, { mistakes: 'Sized too large' });
    const entries = book.entries([trade(100)]);
    eq(entries[0].annotation.setup, 'Breakout', 'the earlier field survives the later edit');
    eq(entries[0].annotation.stop, 95);
    eq(entries[0].annotation.mistakes, 'Sized too large');
  });

  suite('correcting a fee does not detach the note', () => {
    /* The fingerprint covers what makes a trade that trade — instrument,
       direction, size, prices and dates — and deliberately not the fee. Fees
       are the field most often corrected after the fact, and a written
       reflection must not be lost to a bookkeeping tidy-up. */
    const book = new Journal(new Store(paths.tempDir('journal')));
    book.annotate(journal.fingerprint(trade(100)), { thesis: 'Earnings beat' });

    const corrected = trade(100, { fees: 2, netPnl: 98 });
    eq(book.orphaned([corrected]).length, 0);
    eq(book.entries([corrected])[0].annotation.thesis, 'Earnings beat');
  });

  suite('a note whose trade genuinely changed is reported, not discarded', () => {
    /* Correcting the price a trade was done at makes it a different trade, so
       the note no longer matches. It is surfaced rather than dropped: a written
       reflection is the least replaceable thing in this application. */
    const book = new Journal(new Store(paths.tempDir('journal')));
    book.annotate(journal.fingerprint(trade(100)), { thesis: 'Earnings beat' });

    const corrected = trade(100, { exitPrice: 112 });
    const orphans = book.orphaned([corrected]);
    eq(orphans.length, 1);
    eq(orphans[0].thesis, 'Earnings beat');
    eq(book.entries([corrected])[0].journalled, false, 'and the trade shows as unjournalled meanwhile');

    book.reattach(orphans[0].id, journal.fingerprint(corrected));
    eq(book.orphaned([corrected]).length, 0);
    eq(book.entries([corrected])[0].annotation.thesis, 'Earnings beat');
    eq(book.entries([corrected])[0].annotation.reattachedFrom.length, 16, 'and it records where it came from');
  });

  suite('a conviction rating is held to its scale', () => {
    const built = journal.annotation({ conviction: 9, rating: 0 });
    eq(built.conviction, 5);
    eq(built.rating, 1);
    eq(journal.annotation({}).conviction, null, 'and absent stays absent');
  });

  /* ============ risk ============ */
  console.log('\nR multiples — only where the stop that was actually taken is recorded');

  suite('risk is the distance to the stop, times the size', () => {
    const one = trade(100);
    eq(journal.riskOf(one, { stop: 95 }), 50, '100 to 95 is 5, over 10 shares');
    eq(journal.rMultipleOf(one, { stop: 95 }), 2, '100 made on 50 risked is 2R');
  });

  suite('without a stop there is no R, and no substitute is invented', () => {
    eq(journal.riskOf(trade(100), null), null);
    eq(journal.rMultipleOf(trade(100), {}), null);
    eq(journal.rMultipleOf(trade(100), { stop: 100 }), null, 'a stop at the entry risks nothing measurable');
  });

  suite('a short trade measures risk upwards from its entry', () => {
    const short = trade(100, { direction: 'short', entryPrice: 100, exitPrice: 90 });
    eq(journal.riskOf(short, { stop: 105 }), 50);
    eq(journal.rMultipleOf(short, { stop: 105 }), 2);
  });

  suite('the statistics say how many trades the R figure covers', () => {
    const book = new Journal(new Store(paths.tempDir('journal')));
    const trades = record();
    book.annotate(journal.fingerprint(trades[0]), { stop: 95 });
    const stats = journal.statistics(book.entries(trades));
    eq(stats.rMultiple.over, 1);
    eq(stats.rMultiple.of, 5);
    ok(/1 of 5 trades that recorded a stop/.test(stats.rMultiple.note), 'got: ' + stats.rMultiple.note);
  });

  suite('with no stops recorded at all, the figure says so rather than reading zero', () => {
    const stats = journal.statistics(new Journal(new Store(paths.tempDir('journal'))).entries(record()));
    eq(stats.rMultiple.average, null);
    ok(/no risk to measure against/i.test(stats.rMultiple.note));
  });

  /* ============ statistics ============ */
  console.log('\nStatistics — hand-computed from a five-trade record: +100, −50, +200, −30, +10');

  const stats = journal.statistics(new Journal(new Store(paths.tempDir('journal'))).entries(record()));

  suite('wins, losses and the win rate', () => {
    eq(stats.count, 5);
    eq(stats.wins, 3);
    eq(stats.losses, 2);
    near(stats.winRate, 60, 1e-9, 'three of five');
  });

  suite('gross profit, gross loss and the net', () => {
    eq(stats.grossProfit, 310, '100 + 200 + 10');
    eq(stats.grossLoss, 80, '50 + 30');
    eq(stats.net, 230);
  });

  suite('the averages', () => {
    near(stats.averageWin, 310 / 3, 1e-9);
    near(stats.averageLoss, 40, 1e-9);
    near(stats.winLossRatio, (310 / 3) / 40, 1e-9);
  });

  suite('expectancy is what one trade is worth on this record', () => {
    /* 0.6 × 103.333 − 0.4 × 40 = 62 − 16 = 46, which is also 230 ÷ 5. */
    near(stats.expectancy, 46, 1e-9);
    near(stats.expectancy, stats.net / stats.count, 1e-9, 'and it must agree with the net per trade');
  });

  suite('profit factor is gross profit over gross loss', () => {
    near(stats.profitFactor, 310 / 80, 1e-9);
  });

  suite('the largest win and loss are reported', () => {
    eq(stats.largestWin, 200);
    eq(stats.largestLoss, -50);
  });

  suite('maximum drawdown is the deepest fall from a peak in the equity curve', () => {
    /* Running: 100, 50, 250, 220, 230. Peaks: 100, 100, 250, 250, 250.
       The deepest fall is 50, from a peak of 100. */
    eq(stats.maxDrawdown, 50);
    near(stats.maxDrawdownPct, 50, 1e-9);
    eq(stats.equityCurve.length, 5);
    eq(stats.equityCurve[4].equity, 230);
  });

  suite('streaks count consecutive results', () => {
    eq(stats.streaks.longestWinning, 1, 'the record alternates');
    eq(stats.streaks.longestLosing, 1);
    eq(stats.streaks.current, 1, 'and it ends on a win');
  });

  suite('a longer run is counted correctly', () => {
    const wins = [10, 20, 30, -5, -6, -7, -8, 40].map((pnl, i) =>
      trade(pnl, { openedAt: BASE + i * DAY, closedAt: BASE + (i + 1) * DAY }));
    const out = journal.statistics(new Journal(new Store(paths.tempDir('journal'))).entries(wins));
    eq(out.streaks.longestWinning, 3);
    eq(out.streaks.longestLosing, 4);
    eq(out.streaks.current, 1);
  });

  /* ============ edge cases ============ */
  console.log('\nStatistics that cannot be computed say so instead of reading zero');

  suite('an empty record is empty, not a set of zeroes', () => {
    const out = journal.statistics([]);
    eq(out.empty, true);
    eq(out.count, 0);
    ok(/no closed trades/i.test(out.note));
  });

  suite('with no losses there is no profit factor to divide', () => {
    const out = journal.statistics([trade(100), trade(50)]);
    eq(out.profitFactor, null, 'dividing by zero would report infinity as a skill');
    ok(/nothing to divide by/i.test(out.profitFactorNote));
  });

  suite('expectancy needs both a win and a loss', () => {
    const out = journal.statistics([trade(100), trade(50)]);
    eq(out.expectancy, null);
    ok(/at least one winning and one losing/i.test(out.expectancyNote));
  });

  suite('a scratch trade counts as taken but not as won', () => {
    const out = journal.statistics([trade(100), trade(-100), trade(0)]);
    eq(out.count, 3);
    eq(out.scratches, 1);
    near(out.winRate, 100 / 3, 1e-9, 'one win out of three trades taken');
  });

  /* ============ groupings ============ */
  console.log('\nGroupings — a striking percentage over three trades must read as three trades');

  suite('performance splits by instrument', () => {
    const groups = journal.groupBy(new Journal(new Store(paths.tempDir('journal'))).entries(record()), t => t.symbol);
    const nvda = groups.find(g => g.name === 'NVDA');
    const aapl = groups.find(g => g.name === 'AAPL');
    eq(nvda.count, 3, 'trades 0, 2 and 4');
    eq(nvda.net, 310);
    eq(aapl.count, 2);
    eq(aapl.net, -80);
  });

  suite('a thin group is flagged as thin', () => {
    const groups = journal.groupBy([trade(100), trade(200)], t => t.symbol);
    eq(groups[0].count, 2);
    eq(groups[0].winRate, 100);
    eq(groups[0].thin, true, 'a hundred per cent over two trades is two trades, not a finding');
  });

  suite('a group with enough trades is not flagged', () => {
    const many = [10, 20, 30, 40, -5, -6].map((pnl, i) => trade(pnl, { closedAt: BASE + i * DAY }));
    eq(journal.groupBy(many, t => t.symbol)[0].thin, false);
  });

  suite('one trade can belong to several tag groups', () => {
    const book = new Journal(new Store(paths.tempDir('journal')));
    const one = trade(100);
    book.annotate(journal.fingerprint(one), { tags: ['breakout', 'earnings'] });
    const groups = journal.groupBy(book.entries([one]), t => (t.annotation && t.annotation.tags) || []);
    eq(groups.length, 2);
    eq(groups[0].count, 1);
  });

  suite('a trade with no annotation is absent from setup groups rather than grouped as blank', () => {
    const groups = journal.groupBy(new Journal(new Store(paths.tempDir('journal'))).entries(record()),
      t => t.annotation && t.annotation.setup);
    eq(groups.length, 0);
  });

  suite('the full set of groupings is produced', () => {
    const groups = journal.groupings(new Journal(new Store(paths.tempDir('journal'))).entries(record()), 'Europe/London');
    ok(groups.bySymbol.length === 2);
    ok(groups.byWeekday.length >= 1, 'weekdays are derived in the operator\'s own zone');
    ok(groups.byHour.length >= 1);
    ok(groups.byDirection.length === 1);
  });

  /* ============ calendar ============ */
  console.log('\nCalendar — a trade closed late at night belongs to the day it felt like');

  suite('daily profit is keyed by the operator\'s own day', () => {
    const days = journal.calendar(record(), 'Europe/London');
    eq(days.length, 5, 'five trades closed on five different days');
    eq(days[0].trades, 1);
    ok(days[0].date < days[4].date, 'and they come back in order');
  });

  suite('several trades on one day are one calendar entry', () => {
    const sameDay = [trade(100), trade(-40), trade(20)];
    const days = journal.calendar(sameDay, 'Europe/London');
    eq(days.length, 1);
    eq(days[0].trades, 3);
    eq(days[0].net, 80);
    eq(days[0].wins, 2);
  });
}

module.exports = { run };
