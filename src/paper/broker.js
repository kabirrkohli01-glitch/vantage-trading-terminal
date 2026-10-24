'use strict';
/* The paper broker.
 *
 * A simulator is only worth practising against if it is honest about being
 * pessimistic. A simulator that fills every order instantly at the last printed
 * price teaches a way of trading that does not survive contact with a real
 * book, and it does it while producing an equity curve that looks like skill.
 *
 * SO EVERY FILL RECORDS THE ASSUMPTIONS IT WAS MADE UNDER, and those
 * assumptions travel with the trade into the journal.
 *
 *   Where a real bid and ask are available, a buy fills at the ask and a sell
 *   at the bid. That is the actual cost of crossing, and it is the single
 *   biggest thing a naive simulator hides.
 *
 *   Where they are not — the quote endpoint that carries them needs a session
 *   this application may not have — the spread is ESTIMATED from the asset
 *   class, and the fill is marked as resting on an estimate. It is never
 *   filled at the last price as though crossing were free.
 *
 *   A resting order fills only when the market actually trades through its
 *   price, judged from bars rather than from the fact that time passed.
 *
 * FILLS ARE SUSPENDED IN SAFE DATA MODE. A simulated fill against a price that
 * has just failed an integrity check would write a fictional trade into a
 * journal used to draw conclusions from.
 *
 * There is no live order path anywhere in this application. This broker writes
 * only into the paper book, and nothing here can reach an external system.
 */

const { num, CLASS } = require('../core/num');
const { id: makeId } = require('../core/util');
const { BOOK, KIND } = require('../portfolio/ledger');

const TYPE = {
  MARKET: 'market',
  LIMIT: 'limit',
  STOP: 'stop',
  STOP_LIMIT: 'stop-limit',
  TRAILING_STOP: 'trailing-stop'
};

const STATUS = {
  WORKING: 'working',
  FILLED: 'filled',
  PARTIAL: 'partially-filled',
  CANCELLED: 'cancelled',
  REJECTED: 'rejected',
  EXPIRED: 'expired'
};

/* Spread estimates in basis points, used only when the real book is not
 * available. Deliberately not generous: an estimate that flatters the fill is
 * the thing this file exists to avoid. They are stated in the interface and
 * are the operator's to change. */
const ASSUMED_SPREAD_BPS = {
  EQUITY: 8,
  ETF: 5,
  INDEX: 5,
  CURRENCY: 2,
  CRYPTO: 6,
  FUTURE: 4,
  COMMODITY: 6,
  OPTION: 100,
  BOND: 20,
  UNKNOWN: 15
};

/* Additional adverse movement assumed on a market order, on top of crossing the
   spread. Zero by default: it is a real effect but its size depends on order
   size against book depth, which this application cannot observe, and inventing
   a figure would be worse than declaring none. */
const DEFAULT_SLIPPAGE_BPS = 0;

function order(input) {
  const raw = input || {};
  const type = String(raw.type || TYPE.MARKET).toLowerCase();
  if (!Object.values(TYPE).includes(type)) throw new Error('Unknown order type: ' + raw.type);

  const side = String(raw.side || '').toLowerCase();
  if (side !== 'buy' && side !== 'sell') throw new Error('An order must be a buy or a sell.');

  const quantity = num(raw.quantity);
  if (quantity === null || quantity <= 0) throw new Error('An order needs a quantity greater than zero.');

  const symbol = String(raw.symbol || '').trim().toUpperCase();
  if (!symbol) throw new Error('An order needs an instrument.');

  const record = {
    id: raw.id || makeId('ord'),
    book: BOOK.PAPER,
    symbol,
    side,
    type,
    quantity,
    filledQuantity: 0,
    limitPrice: num(raw.limitPrice),
    stopPrice: num(raw.stopPrice),
    trailAmount: num(raw.trailAmount),
    trailPercent: num(raw.trailPercent),
    /* Once a trailing stop has moved with the market it never moves back. */
    trailPeak: null,
    timeInForce: raw.timeInForce === 'day' ? 'day' : 'gtc',
    bracket: raw.bracket ? {
      takeProfit: num(raw.bracket.takeProfit),
      stopLoss: num(raw.bracket.stopLoss)
    } : null,
    status: STATUS.WORKING,
    placedAt: num(raw.placedAt) || Date.now(),
    filledAt: null,
    filledPrice: null,
    assumptions: null,
    reason: null,
    note: raw.note ? String(raw.note).slice(0, 300) : null,
    /* Carried through to the journal, so a trade taken with a stop in mind can
       report an R multiple later. */
    plannedStop: num(raw.plannedStop),
    plannedTarget: num(raw.plannedTarget)
  };

  if (type === TYPE.LIMIT || type === TYPE.STOP_LIMIT) {
    if (record.limitPrice === null) throw new Error('A limit order needs a limit price.');
  }
  if (type === TYPE.STOP || type === TYPE.STOP_LIMIT) {
    if (record.stopPrice === null) throw new Error('A stop order needs a stop price.');
  }
  if (type === TYPE.TRAILING_STOP && record.trailAmount === null && record.trailPercent === null) {
    throw new Error('A trailing stop needs a distance, either an amount or a percentage.');
  }

  return record;
}

/* The figure a fill is actually priced against. Prefers the pre- or
 * post-market print over the regular session's last when the venue is
 * currently in one of those windows and the print is judged current — the
 * same rule the chart uses to decide whether to keep moving outside the
 * regular session. Without this a paper order placed at eight in the
 * evening filled at four o'clock's closing print, which is not what "the
 * price right now" means once the after-hours session is the one actually
 * trading. */
function currentPrice(model) {
  const extended = model && model.quote && model.quote.extended;
  const state = extended && extended.freshness && extended.freshness.state;
  if (extended && (state === 'LIVE' || state === 'DELAYED')) return extended.price;
  return num(model && model.quote && model.quote.last);
}

/* What it would cost to cross the spread right now, and on what basis. */
function fillPrice(model, side, options) {
  const opts = options || {};
  const quote = (model && model.quote) || {};
  const last = currentPrice(model);
  if (last === null) return null;

  const bid = num(quote.bid);
  const ask = num(quote.ask);
  const slippageBps = opts.slippageBps == null ? DEFAULT_SLIPPAGE_BPS : opts.slippageBps;

  if (bid !== null && ask !== null && ask >= bid) {
    const raw = side === 'buy' ? ask : bid;
    const slipped = raw * (1 + (side === 'buy' ? 1 : -1) * slippageBps / 10000);
    return {
      price: slipped,
      basis: 'book',
      bid,
      ask,
      spread: ask - bid,
      slippageBps,
      note: 'Filled at the ' + (side === 'buy' ? 'ask' : 'bid') + ' from the real book.'
    };
  }

  /* No book available. The spread is estimated rather than ignored. */
  const bps = opts.spreadBps == null
    ? (ASSUMED_SPREAD_BPS[model.assetClass] || ASSUMED_SPREAD_BPS.UNKNOWN)
    : opts.spreadBps;
  const half = last * (bps / 2) / 10000;
  const raw = side === 'buy' ? last + half : last - half;
  const slipped = raw * (1 + (side === 'buy' ? 1 : -1) * slippageBps / 10000);

  return {
    price: slipped,
    basis: 'assumed',
    assumedSpreadBps: bps,
    slippageBps,
    referencePrice: last,
    note: 'No bid or ask was available, so a spread of ' + bps +
      ' basis points was assumed for this asset class. The real cost of crossing may differ.'
  };
}

class PaperBroker {
  constructor(options) {
    const opts = options || {};
    this.store = opts.store;
    this.ledger = opts.ledger;
    this.safeMode = opts.safeMode || null;
    this.audit = opts.audit || null;
    this.settings = Object.assign({ slippageBps: DEFAULT_SLIPPAGE_BPS, spreadBps: null }, opts.settings || {});
    this.key = 'orders';
    this.listeners = [];
  }

  orders(status) {
    const list = this.store.all(this.key);
    return status ? list.filter(o => o.status === status) : list;
  }

  working() {
    return this.orders().filter(o => o.status === STATUS.WORKING);
  }

  /* What would happen if this order were sent now.
   *
   * Produced before anything is placed, and it is the same calculation the fill
   * uses — so the preview cannot promise a price the fill would not give. */
  preview(input, model) {
    let candidate;
    try {
      candidate = order(input);
    } catch (err) {
      return { usable: false, reason: err.message };
    }

    if (!model || num(model.quote && model.quote.last) === null) {
      return { usable: false, reason: 'No price is loaded for ' + candidate.symbol + ', so this cannot be priced.' };
    }

    const blocked = this.safeMode && !this.safeMode.allows('fill');
    const estimate = fillPrice(model, candidate.side, this.settings);

    const immediate = candidate.type === TYPE.MARKET;
    const value = estimate.price * candidate.quantity;

    return {
      usable: true,
      order: candidate,
      immediate,
      estimatedPrice: estimate.price,
      estimatedValue: value,
      /* Signed the way the book will see it, so a risk preview can use it
         without re-deriving the direction. */
      signedValue: candidate.side === 'buy' ? value : -value,
      assumptions: estimate,
      freshness: model.freshness || null,
      /* Named rather than implied: a preview against a stale price is worth
         seeing, and worth labelling. */
      warnings: [
        model.freshness && model.freshness.state === 'STALE'
          ? 'The price behind this estimate has stopped updating.' : null,
        model.freshness && model.freshness.state === 'UNKNOWN'
          ? 'The price behind this estimate could not be verified.' : null,
        estimate.basis === 'assumed' ? estimate.note : null,
        blocked ? 'Safe data mode is active, so this order will rest rather than fill.' : null
      ].filter(Boolean)
    };
  }

  place(input, model) {
    const candidate = order(input);
    this.store.put(this.key, candidate);
    this.record('paper.order.placed', {
      id: candidate.id, symbol: candidate.symbol, side: candidate.side,
      type: candidate.type, quantity: candidate.quantity
    });

    /* A market order is evaluated immediately; anything resting waits for the
       market to come to it. */
    if (model) this.evaluate(candidate, model);
    return this.store.byId(this.key, candidate.id);
  }

  cancel(id) {
    const existing = this.store.byId(this.key, id);
    if (!existing) throw new Error('There is no order with that identifier.');
    if (existing.status !== STATUS.WORKING) {
      throw new Error('That order is already ' + existing.status + '.');
    }
    existing.status = STATUS.CANCELLED;
    existing.reason = 'Cancelled.';
    this.store.put(this.key, existing);
    this.record('paper.order.cancelled', { id, symbol: existing.symbol });
    return existing;
  }

  /* Called whenever a price arrives. Every resting order on that instrument is
     tested against what the market actually did. */
  onQuote(model) {
    if (!model || !model.symbol) return [];
    const filled = [];
    this.working()
      .filter(o => o.symbol === model.symbol)
      .forEach(o => {
        const result = this.evaluate(o, model);
        if (result) filled.push(result);
      });
    return filled;
  }

  evaluate(working, model) {
    const last = num(model.quote && model.quote.last);
    if (last === null) return null;

    if (this.safeMode && !this.safeMode.allows('fill')) {
      /* Not rejected — held. The order is still the operator's intent; only the
         fill is withheld while the data cannot be trusted. */
      return null;
    }

    const high = num(model.quote.dayHigh);
    const low = num(model.quote.dayLow);

    let triggered = false;

    switch (working.type) {
      case TYPE.MARKET:
        triggered = true;
        break;

      case TYPE.LIMIT:
        /* A buy limit fills when the market trades at or below it. Using the
           session extremes rather than only the last print means an order that
           was touched intraday is not missed because the price came back. */
        triggered = working.side === 'buy'
          ? (last <= working.limitPrice || (low !== null && low <= working.limitPrice))
          : (last >= working.limitPrice || (high !== null && high >= working.limitPrice));
        break;

      case TYPE.STOP:
        triggered = working.side === 'buy'
          ? (last >= working.stopPrice || (high !== null && high >= working.stopPrice))
          : (last <= working.stopPrice || (low !== null && low <= working.stopPrice));
        break;

      case TYPE.STOP_LIMIT: {
        const stopHit = working.side === 'buy'
          ? (last >= working.stopPrice || (high !== null && high >= working.stopPrice))
          : (last <= working.stopPrice || (low !== null && low <= working.stopPrice));
        triggered = stopHit && (working.side === 'buy' ? last <= working.limitPrice : last >= working.limitPrice);
        break;
      }

      case TYPE.TRAILING_STOP: {
        /* The trail follows the favourable direction and never gives ground. */
        const favourable = working.side === 'sell' ? last : -last;
        if (working.trailPeak === null || favourable > working.trailPeak) {
          working.trailPeak = favourable;
          this.store.put(this.key, working);
        }
        const peak = working.side === 'sell' ? working.trailPeak : -working.trailPeak;
        const distance = working.trailAmount !== null
          ? working.trailAmount
          : Math.abs(peak) * (working.trailPercent / 100);
        const level = working.side === 'sell' ? peak - distance : peak + distance;
        triggered = working.side === 'sell' ? last <= level : last >= level;
        break;
      }

      default:
        triggered = false;
    }

    if (!triggered) return null;
    return this.fill(working, model);
  }

  fill(working, model) {
    const estimate = fillPrice(model, working.side, this.settings);
    if (!estimate) return null;

    /* A resting order fills at its own price when the market came to it, not at
       whatever the last print happened to be — filling a limit at the market
       price is how a simulator quietly hands out free money. */
    let price = estimate.price;
    let basisNote = estimate.note;

    if (working.type === TYPE.LIMIT) {
      price = working.side === 'buy'
        ? Math.min(estimate.price, working.limitPrice)
        : Math.max(estimate.price, working.limitPrice);
      basisNote = 'Filled at the limit price, or better where the market crossed it.';
    } else if (working.type === TYPE.STOP_LIMIT) {
      price = working.limitPrice;
      basisNote = 'Filled at the limit price once the stop was triggered.';
    }

    working.status = STATUS.FILLED;
    working.filledQuantity = working.quantity;
    working.filledPrice = price;
    working.filledAt = num(model.quote.at) || Date.now();
    working.assumptions = Object.assign({}, estimate, { note: basisNote });
    this.store.put(this.key, working);

    /* The fill becomes a transaction in the paper book, so positions, P&L and
       the journal all come from the same ledger every other book uses. */
    const tx = this.ledger.add({
      book: BOOK.PAPER,
      kind: working.side === 'buy' ? KIND.BUY : KIND.SELL,
      at: working.filledAt,
      symbol: working.symbol,
      quantity: working.quantity,
      price,
      currency: model.currency,
      fees: 0,
      source: 'paper',
      note: working.note
    });

    this.record('paper.order.filled', {
      id: working.id, symbol: working.symbol, side: working.side,
      quantity: working.quantity, price, basis: estimate.basis
    });

    /* A bracket becomes two resting orders on the opposite side once the entry
       is filled. Both are placed; whichever fills first should have the other
       cancelled by the caller. */
    const brackets = [];
    if (working.bracket) {
      const opposite = working.side === 'buy' ? 'sell' : 'buy';
      if (working.bracket.takeProfit !== null) {
        brackets.push(this.place({
          symbol: working.symbol, side: opposite, quantity: working.quantity,
          type: TYPE.LIMIT, limitPrice: working.bracket.takeProfit,
          note: 'Target from ' + working.id
        }));
      }
      if (working.bracket.stopLoss !== null) {
        brackets.push(this.place({
          symbol: working.symbol, side: opposite, quantity: working.quantity,
          type: TYPE.STOP, stopPrice: working.bracket.stopLoss,
          note: 'Stop from ' + working.id
        }));
      }
    }

    const result = { order: working, transaction: tx, brackets };
    this.listeners.forEach(fn => { try { fn(result); } catch (e) { /* a listener must not break a fill */ } });
    return result;
  }

  /* Cancel every order still resting on an instrument. Used when one side of a
     bracket fills and the other is no longer wanted. */
  cancelSiblings(parentId) {
    const cancelled = [];
    this.working().forEach(o => {
      if (o.note && o.note.indexOf(parentId) !== -1) {
        o.status = STATUS.CANCELLED;
        o.reason = 'The other side of the bracket filled.';
        this.store.put(this.key, o);
        cancelled.push(o);
      }
    });
    return cancelled;
  }

  onFill(fn) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(f => f !== fn); };
  }

  record(kind, detail) {
    if (this.audit) this.audit.write(kind, detail);
  }
}

module.exports = { PaperBroker, order, fillPrice, TYPE, STATUS, ASSUMED_SPREAD_BPS, DEFAULT_SLIPPAGE_BPS };
