'use strict';
/* The transaction ledger.
 *
 * THE LEDGER IS THE SOURCE OF TRUTH AND POSITIONS ARE DERIVED FROM IT. Nothing
 * in this application stores a holding as "300 shares at 142.50". It stores the
 * purchases and sales that produced that holding, and computes the rest. The
 * difference matters the first time a position is added to, sold down, split or
 * paid a dividend: a stored average goes stale against the transactions that
 * contradict it, and nothing recalculates it. A derived average cannot.
 *
 * THERE ARE THREE BOOKS AND THEY ARE NEVER ADDED TOGETHER.
 *
 *   mirror    Real holdings entered by hand, so the real portfolio can be
 *             tracked in full without connecting a broker. Real money — but
 *             the quantities are the operator's own claim, not a broker's
 *             confirmation, and every total says so.
 *   paper     Simulated cash and simulated fills against real prices. Never
 *             counted as real money anywhere.
 *   imported  Read-only from a broker. The only book whose quantities are
 *             confirmed by someone other than the operator.
 *
 * A single figure covering more than one book would be meaningless, so the
 * valuation layer refuses to produce one without naming the books that went
 * into it.
 */

const { num } = require('../core/num');
const { id: makeId } = require('../core/util');

const BOOK = { MIRROR: 'mirror', PAPER: 'paper', IMPORTED: 'imported' };

const BOOK_LABEL = {
  mirror: 'Entered by hand',
  paper: 'Paper',
  imported: 'From broker'
};

/* Wherever a mirrored total is shown. It is real money and it is also unverified
   — both halves of that are true and the interface says both. */
const BOOK_CAVEAT = {
  mirror: 'Entered by hand and not verified against a broker.',
  paper: 'Simulated. Not real money.',
  imported: 'Confirmed by the broker.'
};

const KIND = {
  BUY: 'buy',
  SELL: 'sell',
  DIVIDEND: 'dividend',
  DEPOSIT: 'deposit',
  WITHDRAWAL: 'withdrawal',
  FEE: 'fee',
  /* A split changes the share count without a cash movement. Recorded rather
     than applied silently, because a position whose quantity changed with no
     transaction behind it is unexplainable later. */
  SPLIT: 'split'
};

const INSTRUMENT_KINDS = new Set([KIND.BUY, KIND.SELL, KIND.DIVIDEND, KIND.SPLIT]);
const CASH_KINDS = new Set([KIND.DEPOSIT, KIND.WITHDRAWAL, KIND.FEE]);

/* Build and validate a transaction.
 *
 * Validation refuses rather than corrects. A quantity that arrived as a string
 * with a stray character, or a sale with no price, is a data-entry error, and
 * quietly coercing it to a number produces a position that is wrong in a way
 * nobody will find. */
function transaction(input) {
  const raw = input || {};
  const kind = String(raw.kind || '').toLowerCase();

  if (!KIND[kind.toUpperCase()]) {
    throw new Error('Unknown transaction type: ' + (raw.kind || '(none)'));
  }

  const book = String(raw.book || '').toLowerCase();
  if (!BOOK_LABEL[book]) throw new Error('A transaction must belong to a book.');

  const at = num(raw.at);
  if (at === null || at <= 0) throw new Error('A transaction needs the date it happened.');
  /* A trade dated in the future is a typo, and it would sit at the end of the
     ledger changing every figure computed from it. */
  if (at > Date.now() + 24 * 60 * 60 * 1000) {
    throw new Error('That transaction is dated in the future.');
  }

  const record = {
    id: raw.id || makeId('tx'),
    book,
    kind,
    at,
    enteredAt: num(raw.enteredAt) || Date.now(),
    source: raw.source || (book === BOOK.PAPER ? 'paper' : 'manual'),
    note: raw.note ? String(raw.note).slice(0, 500) : null,
    symbol: null,
    quantity: null,
    price: null,
    currency: raw.currency ? String(raw.currency) : null,
    fees: num(raw.fees) || 0,
    /* The rate used to express this transaction in the account currency, and
       when it was observed. A gain that is really a currency move should be
       traceable to the rate that produced it. */
    fxRate: num(raw.fxRate),
    fxAt: num(raw.fxAt),
    ratio: null
  };

  if (INSTRUMENT_KINDS.has(kind)) {
    const symbol = String(raw.symbol || '').trim().toUpperCase();
    if (!symbol) throw new Error('That transaction needs an instrument.');
    record.symbol = symbol;
  }

  if (kind === KIND.BUY || kind === KIND.SELL) {
    const quantity = num(raw.quantity);
    if (quantity === null || quantity <= 0) {
      throw new Error('A trade needs a quantity greater than zero. The type decides the direction.');
    }
    const price = num(raw.price);
    if (price === null || price < 0) throw new Error('A trade needs the price it was done at.');
    record.quantity = quantity;
    record.price = price;
    if (!record.currency) throw new Error('A trade needs the currency it was done in.');
  }

  /* Amounts arrive as `amount` from a form and come back as `price` from a
     stored record, because that is the field they are kept in.
   *
   * BUILDING A TRANSACTION MUST BE IDEMPOTENT. Editing one re-validates the
   * stored record with a patch applied on top, so a build that only understood
   * the form's field name would drop the amount of every deposit, dividend and
   * fee the moment anything about it was edited — and the validation would then
   * refuse the very record it had just emptied. */
  const amountOf = () => (raw.amount === undefined ? num(raw.price) : num(raw.amount));

  if (kind === KIND.DIVIDEND) {
    /* Recorded as the total received rather than per share: a dividend is often
       paid net of withholding, and per-share times quantity does not reproduce
       what actually arrived. */
    const amount = amountOf();
    if (amount === null) throw new Error('A dividend needs the amount received.');
    record.price = amount;
    record.quantity = num(raw.quantity);
  }

  if (CASH_KINDS.has(kind)) {
    const amount = amountOf();
    if (amount === null || amount <= 0) throw new Error('That needs an amount greater than zero.');
    record.price = amount;
    if (!record.currency) throw new Error('A cash movement needs a currency.');
  }

  if (kind === KIND.SPLIT) {
    const ratio = num(raw.ratio);
    if (ratio === null || ratio <= 0) {
      throw new Error('A split needs a ratio — 2 for a two-for-one, 0.1 for a one-for-ten reverse.');
    }
    record.ratio = ratio;
  }

  return record;
}

/* The signed cash effect of a transaction in its own currency.
   Positive means cash came in. */
function cashFlow(tx) {
  switch (tx.kind) {
    case KIND.BUY: return -(tx.quantity * tx.price + tx.fees);
    case KIND.SELL: return (tx.quantity * tx.price) - tx.fees;
    case KIND.DIVIDEND: return tx.price - tx.fees;
    case KIND.DEPOSIT: return tx.price;
    case KIND.WITHDRAWAL: return -tx.price;
    case KIND.FEE: return -tx.price;
    default: return 0;
  }
}

class Ledger {
  constructor(store) {
    this.store = store;
    this.key = 'transactions';
  }

  all(book) {
    const list = this.store.all(this.key);
    return book ? list.filter(tx => tx.book === book) : list;
  }

  /* Chronological, then by entry order for anything stamped identically. Lot
     matching depends on this ordering, so it is applied here rather than left
     to whoever happens to read the ledger. */
  ordered(book) {
    return this.all(book).slice().sort((a, b) => (a.at - b.at) || (a.enteredAt - b.enteredAt));
  }

  forSymbol(symbol, book) {
    const wanted = String(symbol || '').toUpperCase();
    return this.ordered(book).filter(tx => tx.symbol === wanted);
  }

  add(input) {
    const record = transaction(input);
    this.store.put(this.key, record);
    return record;
  }

  addMany(inputs) {
    const records = (inputs || []).map(transaction);
    this.store.putMany(this.key, records);
    return records;
  }

  /* An edited transaction keeps its identifier, so the history of a position
     stays continuous rather than acquiring a duplicate. */
  update(id, patch) {
    const existing = this.store.byId(this.key, id);
    if (!existing) throw new Error('There is no transaction with that identifier.');
    const record = transaction(Object.assign({}, existing, patch, { id: existing.id }));
    this.store.put(this.key, record);
    return record;
  }

  remove(id) {
    this.store.remove(this.key, id);
    return true;
  }

  symbols(book) {
    const seen = new Set();
    this.ordered(book).forEach(tx => { if (tx.symbol) seen.add(tx.symbol); });
    return Array.from(seen);
  }

  /* Cash by currency, per book. Held per currency rather than converted,
     because converting to a single figure needs a rate, and a rate needs a
     timestamp — which belongs to the valuation layer, not to the ledger. */
  cash(book) {
    const balances = Object.create(null);
    this.ordered(book).forEach(tx => {
      const currency = tx.currency || 'UNKNOWN';
      const flow = cashFlow(tx);
      if (!flow) return;
      balances[currency] = (balances[currency] || 0) + flow;
    });
    return balances;
  }
}

module.exports = { Ledger, transaction, cashFlow, BOOK, BOOK_LABEL, BOOK_CAVEAT, KIND, INSTRUMENT_KINDS, CASH_KINDS };
