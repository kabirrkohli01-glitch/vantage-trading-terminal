'use strict';
/* Marking a book to market.
 *
 * A portfolio total is the figure most likely to be read at a glance and acted
 * on, so it is also the one that most needs to carry its own caveats. Three
 * rules hold here and each of them exists because the alternative produces a
 * confident wrong number.
 *
 *   A TOTAL INHERITS THE WORST FRESHNESS INSIDE IT. A portfolio priced from one
 *   live quote and nine stale ones is a stale portfolio value. Reporting it
 *   without that state, next to a clock, invites it to be read as current.
 *
 *   A HOLDING THAT CANNOT BE PRICED IS NAMED, NOT DROPPED. Silently excluding
 *   it makes the total smaller and still looks complete. The unpriced holdings
 *   are listed and the total is marked incomplete.
 *
 *   CONVERTING CURRENCIES REQUIRES A RATE, AND A RATE REQUIRES A TIMESTAMP. If
 *   a rate for some currency in the book is missing, no single-currency total
 *   is produced at all — subtotals per currency are returned instead, with the
 *   reason. Inventing a rate, or quietly treating one currency as another, is
 *   how a portfolio reports a gain that is really an exchange rate.
 *
 * A fourth check belongs here because it is only visible at this join: the
 * currency a position was ENTERED in must match the currency it is QUOTED in.
 * A London listing entered in pounds and quoted in pence differs by a factor of
 * a hundred, and both figures look entirely ordinary on their own.
 */

const { num, changePct } = require('../core/num');
const { BOOK_CAVEAT, BOOK_LABEL } = require('./ledger');
const { round } = require('./positions');
const freshness = require('../market/freshness');

/* Two currency codes that mean the same money at different scales. Comparing
   the codes as strings would flag these as a mismatch; comparing them as money
   would miss the real hundred-fold error. */
const SCALE = { GBP: { GBp: 100 }, GBp: { GBP: 0.01 }, USD: { USc: 100 }, USc: { USD: 0.01 } };

function sameMoney(a, b) {
  if (a === b) return true;
  return !!(SCALE[a] && SCALE[a][b] !== undefined);
}

/* Mark one book to market.
 *
 * `quotes` is a map of symbol to the market model the engine published, so each
 * holding is priced from a figure that already carries its own provenance and
 * freshness rather than from a bare number. */
function value(input) {
  const it = input || {};
  const book = it.book;
  const positions = (it.positions || []).filter(p => p.open);
  const quotes = it.quotes || new Map();
  const cash = it.cash || {};
  const accountCurrency = it.accountCurrency || 'GBP';
  const rates = it.fxRates || {};
  const now = it.now == null ? Date.now() : it.now;

  const holdings = [];
  const unpriced = [];
  const mismatched = [];
  const states = [];

  positions.forEach(position => {
    const model = quotes.get ? quotes.get(position.symbol) : quotes[position.symbol];
    const last = model && model.quote ? num(model.quote.last) : null;

    const holding = Object.assign({}, position, {
      last,
      name: model ? model.name : null,
      assetClass: model ? model.assetClass : null,
      quoteCurrency: model ? model.currency : null,
      priceHint: model ? model.priceHint : null,
      freshness: model ? model.freshness : null,
      marketValue: null,
      unrealised: null,
      unrealisedPct: null,
      dayChange: null,
      weight: null,
      priced: false,
      problem: null
    });

    if (last === null) {
      holding.problem = model
        ? 'No price has arrived for this holding yet.'
        : 'This instrument is not loaded, so it cannot be priced.';
      unpriced.push(holding);
      holdings.push(holding);
      return;
    }

    /* The join where a hundred-fold error hides. */
    if (position.currency && holding.quoteCurrency && position.currency !== holding.quoteCurrency) {
      if (!sameMoney(position.currency, holding.quoteCurrency)) {
        holding.problem = 'Entered in ' + position.currency + ' but quoted in ' +
          holding.quoteCurrency + '. These are different currencies, so this holding is not valued.';
        mismatched.push(holding);
        unpriced.push(holding);
        holdings.push(holding);
        return;
      }
      holding.problem = 'Entered in ' + position.currency + ' and quoted in ' + holding.quoteCurrency +
        '. Those are the same money at different scales — check the entry price is in ' +
        holding.quoteCurrency + '.';
      mismatched.push(holding);
    }

    holding.priced = true;
    holding.marketValue = round(position.quantity * last);
    holding.unrealised = round(holding.marketValue - position.costBasis);
    holding.unrealisedPct = position.costBasis === 0
      ? null
      : (holding.unrealised / Math.abs(position.costBasis)) * 100;

    const previous = model.quote ? num(model.quote.previousClose) : null;
    if (previous !== null) {
      holding.dayChange = round(position.quantity * (last - previous));
      holding.dayChangePct = changePct(last, previous);
    }

    if (model.freshness) states.push(model.freshness.state);
    holdings.push(holding);
  });

  /* Subtotals per currency first, because that needs no rate and is always
     correct. A single figure is derived from these only if every rate exists. */
  const byCurrency = Object.create(null);
  const add = (currency, field, amount) => {
    const key = currency || 'UNKNOWN';
    if (!byCurrency[key]) {
      byCurrency[key] = { currency: key, marketValue: 0, cost: 0, unrealised: 0, realised: 0, dividends: 0, fees: 0, cash: 0, dayChange: 0 };
    }
    byCurrency[key][field] += amount || 0;
  };

  holdings.forEach(holding => {
    const currency = holding.quoteCurrency || holding.currency;
    if (holding.priced) {
      add(currency, 'marketValue', holding.marketValue);
      add(currency, 'cost', holding.costBasis);
      add(currency, 'unrealised', holding.unrealised);
      add(currency, 'dayChange', holding.dayChange);
    }
  });

  (it.positions || []).forEach(position => {
    add(position.currency, 'realised', position.realised);
    add(position.currency, 'dividends', position.dividends);
    add(position.currency, 'fees', position.fees);
  });

  Object.keys(cash).forEach(currency => add(currency, 'cash', cash[currency]));

  Object.values(byCurrency).forEach(entry => {
    Object.keys(entry).forEach(key => {
      if (key !== 'currency') entry[key] = round(entry[key]);
    });
  });

  /* Can every currency in this book be expressed in the account currency? */
  const currencies = Object.keys(byCurrency).filter(c => c !== 'UNKNOWN');
  const missingRates = currencies.filter(currency =>
    currency !== accountCurrency && !sameMoney(currency, accountCurrency) && !rateFor(rates, currency, accountCurrency));

  let totals = null;
  let rateNote = null;

  if (!missingRates.length) {
    totals = { currency: accountCurrency, marketValue: 0, cost: 0, unrealised: 0, realised: 0, dividends: 0, fees: 0, cash: 0, dayChange: 0 };
    const used = [];
    currencies.forEach(currency => {
      const rate = convertRate(rates, currency, accountCurrency);
      if (rate.rate !== 1) {
        used.push({
          from: currency, to: accountCurrency, rate: rate.rate, at: rate.at,
          scale: !!rate.scale, inverted: !!rate.inverted,
          freshness: rate.freshness || null
        });
        /* A TOTAL IS ONLY AS FRESH AS THE RATE THAT BUILT IT. A live price
           converted with yesterday's rate is yesterday's figure, and it would
           otherwise be badged live because every holding inside it was. The
           pence-to-pounds case is excluded: that is a scale, not a market
           rate, and it does not go stale. */
        if (!rate.scale && rate.freshness) states.push(rate.freshness.state || rate.freshness);
      }
      Object.keys(totals).forEach(key => {
        if (key === 'currency') return;
        totals[key] += (byCurrency[currency][key] || 0) * rate.rate;
      });
    });
    Object.keys(totals).forEach(key => { if (key !== 'currency') totals[key] = round(totals[key]); });
    totals.ratesUsed = used;
    totals.equity = round(totals.marketValue + totals.cash);
    totals.unrealisedPct = totals.cost === 0 ? null : (totals.unrealised / Math.abs(totals.cost)) * 100;
  } else {
    rateNote = 'No single total is shown because there is no exchange rate for ' +
      missingRates.join(', ') + '. The figures per currency below are exact.';
  }

  /* Weights are a share of a whole, so they can only be computed once a whole
     exists — and only over the holdings that could be priced. */
  if (totals && totals.marketValue) {
    holdings.forEach(holding => {
      if (!holding.priced) return;
      const rate = convertRate(rates, holding.quoteCurrency || holding.currency, accountCurrency);
      holding.weight = (holding.marketValue * rate.rate / totals.marketValue) * 100;
    });
  }

  const worst = states.length ? freshness.worst(states) : freshness.STATE.UNKNOWN;

  return {
    book,
    bookLabel: BOOK_LABEL[book] || book,
    /* Carried on the result rather than added by the interface, so no screen
       can show a mirrored total without the sentence that qualifies it. */
    caveat: BOOK_CAVEAT[book] || null,
    accountCurrency,
    holdings,
    byCurrency: Object.values(byCurrency),
    totals,
    rateNote,
    /* The total is only as fresh as the worst price inside it. */
    freshness: {
      state: worst,
      label: LABELS[worst] || 'Unverified',
      basis: states.length + ' priced holding' + (states.length === 1 ? '' : 's')
    },
    complete: unpriced.length === 0,
    unpriced: unpriced.map(h => ({ symbol: h.symbol, reason: h.problem })),
    currencyMismatches: mismatched.map(h => ({ symbol: h.symbol, reason: h.problem })),
    incompleteNote: unpriced.length
      ? 'This total excludes ' + unpriced.length + ' holding' + (unpriced.length === 1 ? '' : 's') +
        ' that could not be priced: ' + unpriced.map(h => h.symbol).join(', ') + '.'
      : null,
    computedAt: now
  };
}

const LABELS = {
  LIVE: 'Live', DELAYED: 'Delayed', CLOSED: 'Closed',
  HISTORICAL: 'Historical', STALE: 'Not updating', UNKNOWN: 'Unverified'
};

function rateFor(rates, from, to) {
  if (from === to) return { rate: 1, at: null };
  const direct = rates[from + to] || rates[from + '/' + to];
  if (direct && num(direct.rate) !== null) return direct;
  const inverse = rates[to + from] || rates[to + '/' + from];
  if (inverse && num(inverse.rate) && inverse.rate !== 0) {
    /* The freshness of an inverted rate is the freshness of the rate it was
       inverted from. Dividing one into another does not make it newer. */
    return { rate: 1 / inverse.rate, at: inverse.at, inverted: true, freshness: inverse.freshness };
  }
  return null;
}

/* The rate to express `from` in `to`, including the pence-and-pounds case,
   which is a scale rather than an exchange rate and needs no market data. */
function convertRate(rates, from, to) {
  if (!from || from === to) return { rate: 1, at: null };
  if (SCALE[from] && SCALE[from][to] !== undefined) {
    return { rate: SCALE[from][to], at: null, scale: true };
  }
  const found = rateFor(rates, from, to);
  return found || { rate: 1, at: null, assumed: true };
}

module.exports = { value, convertRate, sameMoney, SCALE };
