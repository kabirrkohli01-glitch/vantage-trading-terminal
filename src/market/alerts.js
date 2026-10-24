'use strict';
/* Price alerts.
 *
 * An alert is armed the moment it is created and tested against every quote
 * that arrives for its instrument, the same way a resting paper order is
 * (src/paper/broker.js) — if the condition already holds the moment a price
 * arrives, it fires on that price rather than waiting for a crossing that has
 * already happened. That mirrors how a real stop order behaves and keeps one
 * rule for "does the market satisfy this" rather than two.
 *
 * FIRING IS WITHHELD IN SAFE DATA MODE, deliberately: a fired alert against a
 * price that has just failed an integrity check is a false signal dressed as
 * a real one. safeMode.allows('alert') is the one gate this asks, mirroring
 * the fill gate in the paper broker.
 *
 * A fired alert is not deleted. It is disarmed and stamped with when and at
 * what price it fired, so the list distinguishes what is still watching from
 * what has already told the operator something.
 */

const { num } = require('../core/num');
const { id: makeId } = require('../core/util');

const KIND = { ABOVE: 'above', BELOW: 'below' };

function record(input) {
  const raw = input || {};
  const symbol = String(raw.symbol || '').trim().toUpperCase();
  const kind = String(raw.kind || '').toLowerCase();
  const price = num(raw.price);
  if (!symbol) throw new Error('An alert needs an instrument.');
  if (kind !== KIND.ABOVE && kind !== KIND.BELOW) {
    throw new Error('An alert needs a condition: rises above or falls below.');
  }
  if (price === null) throw new Error('An alert needs a price.');
  return {
    id: raw.id || makeId('alert'),
    symbol,
    kind,
    price,
    createdAt: raw.createdAt || Date.now(),
    armed: raw.armed !== undefined ? !!raw.armed : true,
    firedAt: raw.firedAt || null,
    firedPrice: raw.firedPrice != null ? num(raw.firedPrice) : null
  };
}

class AlertBook {
  constructor(options) {
    const opts = options || {};
    this.store = opts.store;
    this.safeMode = opts.safeMode || null;
    this.audit = opts.audit || null;
    this.key = 'alerts';
    this.listeners = [];
  }

  list() {
    return this.store.all(this.key);
  }

  save(input) {
    const existing = input && input.id ? this.store.byId(this.key, input.id) : null;
    const next = record(Object.assign({}, existing, input));
    this.store.put(this.key, next);
    if (this.audit) {
      this.audit.write('alert.saved', { id: next.id, symbol: next.symbol, kind: next.kind, price: next.price });
    }
    return next;
  }

  remove(id) {
    this.store.remove(this.key, id);
    if (this.audit) this.audit.write('alert.removed', { id });
    return true;
  }

  /* Called whenever a price arrives. Every armed alert on that instrument is
     tested against what the market actually did. Returns the ones that fired
     on this quote, so a caller can push them to whatever is listening without
     re-reading the whole book. */
  onQuote(model) {
    if (!model || !model.symbol) return [];
    const last = num(model.quote && model.quote.last);
    if (last === null) return [];
    if (this.safeMode && !this.safeMode.allows('alert')) return [];

    const fired = [];
    this.list()
      .filter(a => a.armed && a.symbol === model.symbol)
      .forEach(alert => {
        const hit = alert.kind === KIND.ABOVE ? last >= alert.price : last <= alert.price;
        if (!hit) return;
        const done = Object.assign({}, alert, { armed: false, firedAt: Date.now(), firedPrice: last });
        this.store.put(this.key, done);
        if (this.audit) {
          this.audit.write('alert.fired', { id: done.id, symbol: done.symbol, kind: done.kind, price: done.price, at: last });
        }
        fired.push(done);
      });

    if (fired.length) {
      this.listeners.forEach(fn => {
        try { fn(fired); } catch (e) { /* a listener must not break the poll */ }
      });
    }
    return fired;
  }

  /* Re-arm a fired alert without recreating it, so its history stays under
     the same identifier. */
  rearm(id) {
    const existing = this.store.byId(this.key, id);
    if (!existing) throw new Error('There is no alert with that identifier.');
    const next = Object.assign({}, existing, { armed: true, firedAt: null, firedPrice: null });
    this.store.put(this.key, next);
    return next;
  }

  onFired(fn) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(f => f !== fn); };
  }
}

module.exports = { AlertBook, KIND };
