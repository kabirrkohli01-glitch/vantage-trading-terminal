'use strict';
/* Positions, built by walking the ledger.
 *
 * A holding is a consequence of its transactions, so it is replayed from them
 * every time rather than stored. Adding to a position, selling part of it, a
 * split and a dividend all land in the same walk, and the average entry that
 * comes out the other side cannot disagree with the trades that produced it.
 *
 * MATCHING METHOD CHANGES REALISED PROFIT, SO IT IS STATED RATHER THAN ASSUMED.
 * Selling half a holding built in two purchases realises a different figure
 * depending on which purchase is treated as sold. The method is recorded on
 * every result so the interface can name it, and it is configurable because
 * different tax regimes and different brokers answer this differently. Nothing
 * here is tax advice and the application does not present it as such — it
 * reports what a stated method produces.
 *
 * The closed trades this produces are the input to the journal. They are
 * derived from the ledger rather than typed in, so the journal cannot drift
 * away from what was actually traded.
 */

const { num } = require('../core/num');
const { KIND, cashFlow } = require('./ledger');

const METHOD = { FIFO: 'fifo', LIFO: 'lifo', AVERAGE: 'average' };

const METHOD_LABEL = {
  fifo: 'First in, first out',
  lifo: 'Last in, first out',
  average: 'Average cost'
};

/* Build every position in a book from its transactions. */
function build(transactions, options) {
  const opts = options || {};
  const method = METHOD[String(opts.method || 'fifo').toUpperCase()] || METHOD.FIFO;

  const bySymbol = new Map();
  (transactions || []).forEach(tx => {
    if (!tx.symbol) return;
    if (!bySymbol.has(tx.symbol)) bySymbol.set(tx.symbol, []);
    bySymbol.get(tx.symbol).push(tx);
  });

  const positions = [];
  bySymbol.forEach((list, symbol) => positions.push(walk(symbol, list, method)));
  return positions;
}

function walk(symbol, transactions, method) {
  /* Open lots, each carrying what it cost and when it was opened. A lot's sign
     is the position's direction: negative quantity is a short. */
  let lots = [];
  let realised = 0;
  let fees = 0;
  let dividends = 0;
  let currency = null;
  const closed = [];
  const splits = [];

  transactions.forEach(tx => {
    if (tx.currency) currency = tx.currency;
    fees += num(tx.fees) || 0;

    if (tx.kind === KIND.DIVIDEND) {
      dividends += (num(tx.price) || 0) - (num(tx.fees) || 0);
      return;
    }

    if (tx.kind === KIND.SPLIT) {
      /* Quantities scale up and prices scale down, so the cost of every lot is
         unchanged. A split that altered cost basis would show as a phantom
         gain or loss on the day it was applied. */
      lots = lots.map(lot => ({
        quantity: lot.quantity * tx.ratio,
        price: lot.price / tx.ratio,
        at: lot.at,
        fees: lot.fees
      }));
      splits.push({ at: tx.at, ratio: tx.ratio });
      return;
    }

    if (tx.kind !== KIND.BUY && tx.kind !== KIND.SELL) return;

    const direction = tx.kind === KIND.BUY ? 1 : -1;
    let remaining = tx.quantity;
    const netQuantity = lots.reduce((sum, lot) => sum + lot.quantity, 0);

    /* A trade in the opposite direction to the open position closes it before
       it opens anything new. Selling more than is held closes the long and
       opens a short with the remainder, which is what a broker does. */
    const closing = netQuantity !== 0 && Math.sign(netQuantity) !== direction;

    if (closing) {
      const order = pick(lots, method);
      while (remaining > 0 && order.length) {
        const lot = order[0];
        const available = Math.abs(lot.quantity);
        const matched = Math.min(available, remaining);

        /* Profit on a long is exit minus entry; on a short it is the other way
           round. The sign of the lot decides which, so one expression covers
           both rather than two branches that can drift apart. */
        const gain = (tx.price - lot.price) * matched * Math.sign(lot.quantity);
        realised += gain;

        closed.push({
          symbol,
          direction: lot.quantity > 0 ? 'long' : 'short',
          quantity: matched,
          entryPrice: lot.price,
          exitPrice: tx.price,
          openedAt: lot.at,
          closedAt: tx.at,
          holdMs: tx.at - lot.at,
          grossPnl: gain,
          /* Entry fees are apportioned across the part of the lot being closed;
             exit fees across the part of this trade that is closing. */
          fees: (lot.fees * (matched / available)) + ((num(tx.fees) || 0) * (matched / tx.quantity)),
          currency: tx.currency || currency,
          entryTxAt: lot.at,
          exitTxAt: tx.at
        });

        lot.quantity -= matched * Math.sign(lot.quantity);
        lot.fees -= lot.fees * (matched / available);
        remaining -= matched;
        if (Math.abs(lot.quantity) < 1e-9) order.shift();
      }
      lots = lots.filter(lot => Math.abs(lot.quantity) > 1e-9);
    }

    if (remaining > 1e-9) {
      lots.push({
        quantity: remaining * direction,
        price: tx.price,
        at: tx.at,
        /* Only the part of the fee belonging to the newly opened quantity. */
        fees: (num(tx.fees) || 0) * (remaining / tx.quantity)
      });
    }
  });

  const quantity = lots.reduce((sum, lot) => sum + lot.quantity, 0);
  const costBasis = lots.reduce((sum, lot) => sum + lot.quantity * lot.price, 0);

  closed.forEach(trade => { trade.netPnl = trade.grossPnl - trade.fees; });

  return {
    symbol,
    currency,
    method,
    methodLabel: METHOD_LABEL[method],
    quantity: round(quantity),
    /* Computed, never stored. An average that can disagree with its own lots is
       the defect this whole file exists to avoid. */
    averageEntry: Math.abs(quantity) > 1e-9 ? costBasis / quantity : null,
    costBasis: round(costBasis),
    lots: lots.map(lot => ({ quantity: round(lot.quantity), price: lot.price, at: lot.at, fees: lot.fees })),
    open: Math.abs(quantity) > 1e-9,
    direction: quantity > 0 ? 'long' : (quantity < 0 ? 'short' : 'flat'),
    realised: round(realised),
    fees: round(fees),
    dividends: round(dividends),
    splits,
    closedTrades: closed,
    firstAt: transactions.length ? transactions[0].at : null,
    lastAt: transactions.length ? transactions[transactions.length - 1].at : null
  };
}

/* Which lot is consumed first. Average cost collapses the lots into one before
   matching, which is why it produces a different realised figure. */
function pick(lots, method) {
  if (method === METHOD.LIFO) return lots.slice().reverse();
  if (method === METHOD.AVERAGE) {
    const quantity = lots.reduce((sum, lot) => sum + lot.quantity, 0);
    if (Math.abs(quantity) < 1e-9) return lots.slice();
    const cost = lots.reduce((sum, lot) => sum + lot.quantity * lot.price, 0);
    const totalFees = lots.reduce((sum, lot) => sum + lot.fees, 0);
    const pooled = { quantity, price: cost / quantity, at: lots[0].at, fees: totalFees };
    /* The pooled lot replaces the originals in place so consuming it consumes
       the real holding rather than a copy. */
    lots.length = 0;
    lots.push(pooled);
    return lots;
  }
  return lots.slice();
}

/* Floating point accumulates visible error across a few hundred transactions —
   a quantity that should be zero arrives as 1e-14 and the position reads as
   open. Rounding at the boundary keeps the figures the operator sees exact
   without rounding inside the arithmetic. */
function round(value) {
  const n = num(value);
  if (n === null) return null;
  const snapped = Number(n.toFixed(10));
  return Math.abs(snapped) < 1e-9 ? 0 : snapped;
}

/* Every closed trade across a book, newest first. The journal's input. */
function closedTrades(positions) {
  const all = [];
  (positions || []).forEach(position => {
    (position.closedTrades || []).forEach(trade => all.push(trade));
  });
  return all.sort((a, b) => b.closedAt - a.closedAt);
}

/* Cash held, derived from the same walk rather than from a separate running
   balance that could disagree with it. */
function cashFrom(transactions) {
  const balances = Object.create(null);
  (transactions || []).forEach(tx => {
    const flow = cashFlow(tx);
    if (!flow) return;
    const currency = tx.currency || 'UNKNOWN';
    balances[currency] = round((balances[currency] || 0) + flow);
  });
  return balances;
}

module.exports = { build, walk, closedTrades, cashFrom, METHOD, METHOD_LABEL, round };
