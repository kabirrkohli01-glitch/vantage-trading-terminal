'use strict';
/* Core module tests.
 *
 * The formatting suites carry the most weight in this file. Every one of them
 * corresponds to a way a market screen can be confidently, invisibly wrong.
 */

const fs = require('fs');
const path = require('path');

const num = require('../src/core/num');
const clock = require('../src/core/clock');
const util = require('../src/core/util');
const brand = require('../src/core/brand');
const { Store } = require('../src/core/store');
const { Audit, redact } = require('../src/core/audit');
const paths = require('../src/core/paths');
const http = require('../src/core/http');

function run(t) {
  const { suite, ok, eq, near } = t;

  /* ============ null is not zero ============ */
  console.log('\nNumbers — an absent figure must never become a real one');

  suite('null coerces to null, not to zero', () => {
    eq(num.num(null), null);
    eq(num.num(undefined), null);
    eq(num.num(''), null);
    eq(num.num(NaN), null);
    eq(num.num('not a number'), null);
  });

  suite('a genuine zero survives, because a zero volume is a fact', () => {
    eq(num.num(0), 0);
    eq(num.num('0'), 0);
    eq(num.has(0), true);
    eq(num.has(null), false);
  });

  suite('booleans are not numbers, though Number() says otherwise', () => {
    /* Number(true) === 1. A feed sending true where a price belongs is broken,
       and rendering it as £1.00 hides that. */
    eq(num.num(true), null);
    eq(num.num(false), null);
  });

  suite('an absent price renders as a dash, never as 0.00', () => {
    eq(num.money(null, { currency: 'USD', assetClass: 'EQUITY' }), '—');
    eq(num.money(undefined, { currency: 'USD' }), '—');
    eq(num.plain(null, 2), '—');
    eq(num.compact(null), '—');
    eq(num.pct(null), '—');
  });

  /* ============ pence ============ */
  console.log('\nCurrency — the ways a price is wrong by 100x or by a unit');

  suite('London quotes in GBp are pence and are printed as pence', () => {
    eq(num.money(1532.1, { currency: 'GBp', assetClass: 'EQUITY' }), '1,532.10p');
  });

  suite('GBp is matched case-sensitively, before any upper-casing', () => {
    eq(num.money(1532.1, { currency: 'GBP', assetClass: 'EQUITY' }), '£1,532.10');
    ok(num.money(1532.1, { currency: 'GBp' }) !== num.money(1532.1, { currency: 'GBP' }),
      'GBp and GBP must not format identically');
  });

  suite('pence are never quietly divided by one hundred', () => {
    ok(num.money(1532.1, { currency: 'GBp' }).indexOf('15.32') === -1,
      'a GBp figure converted to pounds is the two-orders-of-magnitude bug');
  });

  suite('an index level carries no currency mark', () => {
    eq(num.money(15.46, { currency: 'USD', assetClass: 'INDEX' }), '15.46');
    eq(num.money(5432.1, { currency: 'USD', assetClass: 'INDEX' }), '5,432.10');
  });

  suite('the minus sign sits outside the currency symbol', () => {
    eq(num.money(-2.4, { currency: 'GBP', assetClass: 'EQUITY' }), '-£2.40');
    eq(num.money(-2.4, { currency: 'INR', assetClass: 'EQUITY' }), '-₹2.40');
    ok(num.money(-2.4, { currency: 'USD' }).indexOf('$-') === -1, 'never $-2.40');
  });

  suite('an unknown currency prints its code rather than a wrong symbol', () => {
    eq(num.money(12.5, { currency: 'SEK', assetClass: 'EQUITY' }), '12.50 SEK');
  });

  /* ============ decimals ============ */
  console.log('\nPrecision — decided by the instrument, not by how small the number is');

  suite('decimal places come from the asset class, not the magnitude', () => {
    /* A small equity change formatted as currency-precision is the defect this
       encodes: an 85p move must not print with four decimal places. */
    eq(num.money(0.85, { currency: 'GBP', assetClass: 'EQUITY' }), '£0.85');
    eq(num.money(0.85, { currency: 'USD', assetClass: 'CURRENCY' }), '0.8500');
  });

  suite('an exchange rate carries no currency symbol', () => {
    /* A pair is filed under its quote currency, so a naive formatter renders
       EUR/USD as "$1.1670" — which reads as a price in dollars rather than as
       the rate between two currencies. */
    eq(num.money(1.167, { currency: 'USD', assetClass: 'CURRENCY' }), '1.1670');
    eq(num.money(159.1, { currency: 'JPY', assetClass: 'CURRENCY' }), '159.10');
  });

  suite('a bond yield is a percentage, not an amount of money', () => {
    eq(num.money(4.696, { currency: 'USD', assetClass: 'INDEX', unit: 'percent' }), '4.696%');
  });

  suite('foreign exchange precision follows the quote currency', () => {
    eq(num.decimalsFor('CURRENCY', 'USD'), 4);
    eq(num.decimalsFor('CURRENCY', 'JPY'), 2);
  });

  suite('crypto is the one asset class where magnitude decides, and it must', () => {
    eq(num.decimalsFor('CRYPTO', 'USD', 79000), 2);
    eq(num.decimalsFor('CRYPTO', 'USD', 0.0000042), 8);
    ok(num.money(0.0000042, { currency: 'USD', assetClass: 'CRYPTO' }) !== '$0.00',
      'a small-denomination token must not render as zero');
  });

  suite('a price hint from the venue is honoured when supplied', () => {
    eq(num.money(1.23456, { currency: 'USD', assetClass: 'EQUITY', decimals: 3 }), '$1.235');
  });

  /* ============ derived figures ============ */
  console.log('\nDerived figures — division, direction and spread');

  suite('percentage change against a zero previous close is null, not infinity', () => {
    eq(num.changePct(10, 0), null);
    eq(num.changePct(10, null), null);
    near(num.changePct(110, 100), 10, 1e-9);
    near(num.changePct(90, 100), -10, 1e-9);
  });

  suite('a change of exactly zero is not signed as a rise', () => {
    eq(num.pct(0), '0.00%');
    eq(num.pct(1.234), '+1.23%');
    eq(num.pct(-1.234), '-1.23%');
  });

  suite('direction has a flat band, so floating-point noise is not a move', () => {
    eq(num.signOf(1e-12), 'flat');
    eq(num.signOf(0.01), 'up');
    eq(num.signOf(-0.01), 'down');
    eq(num.signOf(null), 'flat');
  });

  suite('a spread with a missing side is null on every field', () => {
    const half = num.spread(10, null);
    eq(half.absolute, null);
    eq(half.pct, null);
    eq(half.mid, null);
  });

  suite('an inverted book is refused rather than reported as a negative spread', () => {
    eq(num.spread(11, 10).absolute, null, 'ask below bid is bad data, not a negative spread');
  });

  suite('a real spread reports absolute, percentage and mid together', () => {
    const s = num.spread(9.99, 10.01);
    near(s.absolute, 0.02, 1e-9);
    near(s.mid, 10, 1e-9);
    near(s.pct, 0.2, 1e-6);
  });

  suite('large numbers compact without losing their sign', () => {
    eq(num.compact(1234567890), '1.23bn');
    eq(num.compact(-1234567890), '-1.23bn');
    eq(num.compact(54522609), '54.52m');
    eq(num.compact(999), '999');
  });

  suite('rounding to a tick does not leak floating-point noise', () => {
    eq(num.toTick(1.0000000000000002, 0.01), 1);
    eq(num.toTick(210.567, 0.01), 210.57);
    eq(num.toTick(210.567, null), 210.567, 'an unknown tick leaves the price alone');
  });

  /* ============ sessions ============ */
  console.log('\nSessions — status may be unknown, but must never be a guess');

  suite('a venue-published trading period decides the session', () => {
    const session = clock.sessionFrom({
      exchangeTimezoneName: 'America/New_York',
      currentTradingPeriod: {
        pre: { start: 1000, end: 2000 },
        regular: { start: 2000, end: 3000 },
        post: { start: 3000, end: 4000 }
      }
    });
    eq(clock.statusAt(session, 2500 * 1000), clock.STATUS.OPEN);
    eq(clock.statusAt(session, 1500 * 1000), clock.STATUS.PRE);
    eq(clock.statusAt(session, 3500 * 1000), clock.STATUS.POST);
    eq(clock.statusAt(session, 5000 * 1000), clock.STATUS.CLOSED);
  });

  suite('with no windows and no known venue the answer is unknown, not closed', () => {
    eq(clock.statusAt({ tz: 'Mars/Olympus' }), clock.STATUS.UNKNOWN);
    eq(clock.statusAt({}), clock.STATUS.UNKNOWN);
    eq(clock.statusAt(null), clock.STATUS.UNKNOWN);
  });

  suite('an instrument that never closes reports open at any hour', () => {
    const session = clock.sessionFrom({});
    session.continuous = true;
    eq(clock.statusAt(session, Date.parse('2026-01-04T03:00:00Z')), clock.STATUS.OPEN);
  });

  suite('the fallback table closes the market at the weekend', () => {
    const session = { tz: 'America/New_York' };
    /* 2026-01-03 is a Saturday. */
    eq(clock.statusAt(session, Date.parse('2026-01-03T15:00:00Z')), clock.STATUS.CLOSED);
    /* 2026-01-05 is a Monday, 15:00 UTC is 10:00 in New York. */
    eq(clock.statusAt(session, Date.parse('2026-01-05T15:00:00Z')), clock.STATUS.OPEN);
  });

  suite('an unrecognised timezone does not throw into a render', () => {
    eq(clock.partsIn('Nowhere/Nothing'), null);
    eq(clock.asOf(0), '');
    eq(clock.asOf(null), '');
  });

  suite('a timestamp from another day shows the day, not just a clock', () => {
    const old = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const text = clock.asOf(old, 'UTC');
    ok(/[A-Z][a-z]{2}/.test(text), 'an older timestamp must name its day: ' + text);
  });

  suite('elapsed time reads in the largest sensible unit', () => {
    const now = Date.now();
    eq(clock.since(now - 30 * 1000, now), '30s ago');
    eq(clock.since(now - 5 * 60 * 1000, now), '5m ago');
    eq(clock.since(now - 3 * 60 * 60 * 1000, now), '3h ago');
    eq(clock.since(null), null);
  });

  suite('the currency market is closed on Saturday and open midweek', () => {
    eq(clock.fxOpen(Date.parse('2026-01-03T12:00:00Z')), false, 'Saturday');
    eq(clock.fxOpen(Date.parse('2026-01-07T12:00:00Z')), true, 'Wednesday');
  });

  /* ============ filesystem safety ============ */
  console.log('\nStorage — the Windows filename trap, and writes that survive a crash');

  suite('a colon never reaches the filesystem', () => {
    /* On Windows a colon in a path names an NTFS alternate data stream rather
       than a file. The write succeeds, the byte count is right, nothing throws,
       and the file cannot be opened or listed afterwards. */
    eq(util.safeName('doc:1fdszmp'), 'doc_1fdszmp');
    eq(util.safeName('GC=F'), 'GC_F');
    eq(util.safeName('^GSPC'), '_GSPC');
    ok(util.safeName('a/b\\c:d*e?f"g<h>i|j').indexOf(':') === -1, 'no colon may survive');
    ok(!/[\\/:*?"<>|]/.test(util.safeName('a/b\\c:d*e?f"g<h>i|j')), 'no reserved character may survive');
  });

  suite('an empty identifier still produces a usable filename', () => {
    eq(util.safeName(''), 'unnamed');
    eq(util.safeName(null), 'unnamed');
  });

  suite('a path cannot escape its root', () => {
    eq(util.within('C:\\root', '..\\..\\windows\\system32'), null);
    ok(util.within('C:\\root', 'sub\\file.json') !== null, 'a legitimate path resolves');
  });

  suite('a store round-trips records and survives a reload', () => {
    const dir = paths.tempDir('store');
    const store = new Store(dir);
    store.put('positions', { id: 'p1', symbol: 'NVDA', quantity: 10 });
    store.put('positions', { id: 'p2', symbol: 'AAPL', quantity: 5 });
    store.put('positions', { id: 'p1', symbol: 'NVDA', quantity: 12 });
    eq(store.all('positions').length, 2, 'a repeated id updates rather than appends');
    eq(store.byId('positions', 'p1').quantity, 12);
    store.remove('positions', 'p2');
    eq(store.all('positions').length, 1);
  });

  suite('a symbol with reserved characters is a usable store key', () => {
    const store = new Store(paths.tempDir('store'));
    store.putDoc('GC=F|1d', { bars: 3 });
    eq(store.doc('GC=F|1d').bars, 3);
    ok(store.keys().every(k => !/[:*?"<>|]/.test(k)), 'no key may land as a reserved filename');
  });

  suite('a corrupt file is moved aside rather than overwritten', () => {
    const dir = paths.tempDir('store');
    const store = new Store(dir);
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ this is not json');
    const value = store.read('broken', { recovered: true });
    eq(value.recovered, true, 'the caller receives the fallback');
    ok(store.lastCorruption && store.lastCorruption.name === 'broken', 'the corruption is recorded');
    ok(fs.readdirSync(dir).some(f => f.indexOf('.corrupt-') !== -1), 'the original bytes are kept');
  });

  /* ============ audit ============ */
  console.log('\nAudit — a record that never contains a credential');

  suite('a credential-shaped field is redacted by name', () => {
    const clean = redact({ symbol: 'NVDA', token: 'abc123', apiKey: 'xyz', nested: { secret: 'no' } });
    eq(clean.symbol, 'NVDA');
    eq(clean.token, '[redacted]');
    eq(clean.apiKey, '[redacted]');
    eq(clean.nested.secret, '[redacted]');
  });

  suite('a credential-shaped value is redacted under an innocent field name', () => {
    const clean = redact({ note: 'sk-abcdefghijklmnopqrstuvwx' });
    eq(clean.note, '[redacted]');
    const hex = redact({ note: 'a'.repeat(64) });
    eq(hex.note, '[redacted]', 'a long hex string is a token, whatever it is called');
  });

  suite('audit events append and read back newest first', () => {
    const file = path.join(paths.tempDir('audit'), 'audit.jsonl');
    const audit = new Audit(file);
    audit.write('instrument.opened', { symbol: 'NVDA' });
    audit.write('order.previewed', { symbol: 'NVDA', quantity: 10 });
    const recent = audit.recent(10);
    eq(recent.length, 2);
    eq(recent[0].kind, 'order.previewed', 'newest first');
    ok(recent[0].at.indexOf('T') !== -1, 'every event carries an instant');
  });

  suite('a malformed line does not stop the log being read', () => {
    const file = path.join(paths.tempDir('audit'), 'audit.jsonl');
    const audit = new Audit(file);
    audit.write('one', {});
    fs.appendFileSync(file, 'not json at all\n');
    audit.write('two', {});
    eq(audit.recent(10).length, 2, 'the readable lines still come back');
  });

  /* ============ branding ============ */
  console.log('\nBranding — the product name has exactly one home');

  suite('the user agent names the application and a contact route', () => {
    ok(/\(.*contact .+\)/.test(brand.userAgent), 'a contact route is required by at least one upstream');
    ok(brand.userAgent.indexOf('@') === -1 || !!process.env.VANTAGE_CONTACT,
      'no address is committed to the source; it comes from VANTAGE_CONTACT');
    ok(!/Mozilla|Chrome|Safari|AppleWebKit/i.test(brand.userAgent),
      'the agent must not impersonate a browser');
  });

  suite('the status-bar credit does not claim to be the data source', () => {
    ok(!/data (from|by|provided)/i.test(brand.credit),
      'the credit is a product line; provenance belongs to the sources drawer');
  });

  /* ============ pacing ============ */
  console.log('\nPacing — a publisher\'s image CDN is not a rate-limited API');

  suite('an unlisted host keeps the conservative default when no fallback is offered', () => {
    /* The JSON/text path never passes a fallback, so a data host this
       application has no explicit manners for yet still gets the cautious
       one-at-a-time treatment — this must not change for binary()'s sake. */
    const limit = http.limitsFor('some-unlisted-data-host.example.com');
    eq(limit.concurrency, 1);
    eq(limit.gap, 800);
  });

  suite('an unlisted host paces to the offered fallback instead', () => {
    const limit = http.limitsFor('some-unlisted-image-host.example.com', { gap: 60, concurrency: 6 });
    eq(limit.concurrency, 6);
    eq(limit.gap, 60);
  });

  suite('a host with its own explicit manners keeps them regardless of any fallback', () => {
    /* binary() offers a fallback for every unlisted host, images included —
       a host this application already has tuned, named limits for (its own
       symbol-logo CDN among them) must not be loosened by that fallback. */
    const limit = http.limitsFor('s3-symbol-logo.tradingview.com', { gap: 60, concurrency: 6 });
    eq(limit.concurrency, 4);
    eq(limit.gap, 120);
  });
}

module.exports = { run };
