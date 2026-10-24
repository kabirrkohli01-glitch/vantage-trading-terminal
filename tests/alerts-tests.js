'use strict';
/* Price alert tests.
 *
 * The application used to let an alert be created and listed while nothing
 * anywhere evaluated it against an arriving price — the interface implied a
 * working feature that could never fire. These suites pin the fix: an alert
 * fires the instant its condition is true of a real quote, stays fired rather
 * than vanishing, and is withheld exactly where a paper fill is.
 */

const { AlertBook, KIND } = require('../src/market/alerts');
const { SafeMode, finding, SEVERITY } = require('../src/market/integrity');
const { Store } = require('../src/core/store');
const paths = require('../src/core/paths');

const BASE = Date.parse('2026-01-05T14:00:00Z');

function quote(last, extra) {
  return Object.assign({
    symbol: 'NVDA',
    assetClass: 'EQUITY',
    currency: 'USD',
    quote: { last, bid: null, ask: null, dayHigh: last, dayLow: last, previousClose: last, at: BASE },
    freshness: { state: 'DELAYED', label: 'Delayed' }
  }, extra || {});
}

function book(safeMode) {
  return new AlertBook({ store: new Store(paths.tempDir('alerts')), safeMode });
}

function run(t) {
  const { suite, ok, eq, throws } = t;

  console.log('\nAlerts — creating one');

  suite('an alert needs an instrument, a condition and a price', () => {
    const b = book();
    throws(() => b.save({ kind: KIND.ABOVE, price: 100 }), 'no instrument');
    throws(() => b.save({ symbol: 'NVDA', price: 100 }), 'no condition');
    throws(() => b.save({ symbol: 'NVDA', kind: KIND.ABOVE }), 'no price');
  });

  suite('a saved alert is armed and unfired', () => {
    const b = book();
    const a = b.save({ symbol: 'nvda', kind: KIND.ABOVE, price: 150 });
    eq(a.symbol, 'NVDA', 'the instrument is normalised to upper case');
    eq(a.armed, true);
    eq(a.firedAt, null);
  });

  console.log('\nAlerts — firing');

  suite('a rises-above alert fires the instant a price at or past it arrives', () => {
    const b = book();
    const a = b.save({ symbol: 'NVDA', kind: KIND.ABOVE, price: 150 });
    eq(b.onQuote(quote(149)).length, 0, 'not there yet');
    const fired = b.onQuote(quote(150));
    eq(fired.length, 1);
    eq(fired[0].id, a.id);
    eq(fired[0].armed, false, 'disarmed once fired');
    eq(fired[0].firedPrice, 150);
  });

  suite('a falls-below alert fires the instant a price at or past it arrives', () => {
    const b = book();
    b.save({ symbol: 'NVDA', kind: KIND.BELOW, price: 90 });
    eq(b.onQuote(quote(95)).length, 0, 'not there yet');
    eq(b.onQuote(quote(90)).length, 1);
  });

  suite('an alert already past its own trigger fires on the very first quote', () => {
    /* The same rule a resting stop order follows: it is not waiting for a
       crossing that already happened before the alert existed. */
    const b = book();
    b.save({ symbol: 'NVDA', kind: KIND.ABOVE, price: 100 });
    eq(b.onQuote(quote(140)).length, 1);
  });

  suite('a fired alert does not fire again', () => {
    const b = book();
    b.save({ symbol: 'NVDA', kind: KIND.ABOVE, price: 150 });
    eq(b.onQuote(quote(151)).length, 1);
    eq(b.onQuote(quote(160)).length, 0, 'already disarmed');
  });

  suite('an alert on another instrument is untouched by this quote', () => {
    const b = book();
    b.save({ symbol: 'AAPL', kind: KIND.ABOVE, price: 150 });
    eq(b.onQuote(quote(200)).length, 0);
  });

  suite('re-arming clears the fired state without a new identifier', () => {
    const b = book();
    const a = b.save({ symbol: 'NVDA', kind: KIND.ABOVE, price: 150 });
    b.onQuote(quote(160));
    const rearmed = b.rearm(a.id);
    eq(rearmed.id, a.id);
    eq(rearmed.armed, true);
    eq(rearmed.firedAt, null);
    eq(b.onQuote(quote(160)).length, 1, 'fires again now that it is watching');
  });

  suite('what fired is reported to whoever is listening', () => {
    const b = book();
    b.save({ symbol: 'NVDA', kind: KIND.ABOVE, price: 150 });
    let seen = null;
    b.onFired(fired => { seen = fired; });
    b.onQuote(quote(160));
    ok(seen && seen.length === 1, 'the listener was told what fired');
  });

  console.log('\nAlerts — safe data mode');

  suite('firing is withheld while safe data mode is active, not silently dropped', () => {
    const mode = new SafeMode({});
    mode.observe([finding('test.block', SEVERITY.BLOCK, 'A decimal point moved.')]);
    const b = book(mode);
    b.save({ symbol: 'NVDA', kind: KIND.ABOVE, price: 150 });
    eq(b.onQuote(quote(160)).length, 0, 'withheld while the price cannot be trusted');
    eq(b.list()[0].armed, true, 'still armed — nothing was silently consumed');
  });

  suite('the same alert fires once the mode clears', () => {
    const mode = new SafeMode({});
    mode.observe([finding('test.block', SEVERITY.BLOCK, 'bad')]);
    const b = book(mode);
    b.save({ symbol: 'NVDA', kind: KIND.ABOVE, price: 150 });
    b.onQuote(quote(160));
    mode.observe([]); mode.observe([]); mode.observe([]);
    eq(mode.active, false);
    eq(b.onQuote(quote(160)).length, 1);
  });

  console.log('\nAlerts — removing');

  suite('removing an alert takes it off the list', () => {
    const b = book();
    const a = b.save({ symbol: 'NVDA', kind: KIND.ABOVE, price: 150 });
    b.remove(a.id);
    eq(b.list().length, 0);
  });
}

module.exports = { run };
