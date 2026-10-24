'use strict';
/* The trade journal, and the statistics derived from it.
 *
 * TRADES ARE NOT TYPED IN. They are produced by replaying the ledger, so the
 * journal cannot drift away from what was actually traded — the failure mode of
 * every journal kept alongside the trading rather than out of it. What the
 * operator adds is the part a ledger cannot know: the setup, the reasoning, the
 * mistake, the state of mind.
 *
 * BECAUSE TRADES ARE DERIVED, THEY NEED AN IDENTITY THAT SURVIVES THE REPLAY.
 * Annotations are keyed by a fingerprint of the trade's own facts. Editing the
 * underlying transaction changes the fingerprint, which would silently orphan
 * the note attached to it — so orphans are reported rather than dropped, and
 * can be reattached. Losing a written reflection because a fee was corrected is
 * not acceptable.
 *
 * EVERY STATISTIC BELOW IS DERIVED AND NONE IS STORED. A stored win rate goes
 * stale against the trades that contradict it the first time one is edited.
 *
 * WHERE A FIGURE NEEDS SOMETHING THAT MAY NOT HAVE BEEN RECORDED, IT SAYS SO
 * RATHER THAN ASSUMING. An R multiple is meaningless without the stop that was
 * actually in the market at the time, so it is computed only for trades that
 * carry one, and the count it was computed over is reported beside it.
 */

const crypto = require('crypto');
const { num } = require('../core/num');

/* A trade's fingerprint: the facts that make it that trade and no other. */
function fingerprint(trade) {
  const parts = [
    trade.symbol,
    trade.direction,
    trade.openedAt,
    trade.closedAt,
    round6(trade.quantity),
    round6(trade.entryPrice),
    round6(trade.exitPrice)
  ].join('|');
  return crypto.createHash('sha256').update(parts).digest('hex').slice(0, 16);
}

function round6(value) {
  const n = num(value);
  return n === null ? 'null' : n.toFixed(6);
}

const TAG_LIMIT = 12;
const NOTE_LIMIT = 4000;

function annotation(input) {
  const raw = input || {};
  return {
    key: String(raw.key || ''),
    setup: raw.setup ? String(raw.setup).slice(0, 120) : null,
    thesis: raw.thesis ? String(raw.thesis).slice(0, NOTE_LIMIT) : null,
    exitReason: raw.exitReason ? String(raw.exitReason).slice(0, NOTE_LIMIT) : null,
    mistakes: raw.mistakes ? String(raw.mistakes).slice(0, NOTE_LIMIT) : null,
    notes: raw.notes ? String(raw.notes).slice(0, NOTE_LIMIT) : null,
    tags: Array.isArray(raw.tags)
      ? raw.tags.map(t => String(t).trim().toLowerCase()).filter(Boolean).slice(0, TAG_LIMIT)
      : [],
    /* How the trade felt, kept as a small ordered scale rather than free text so
       it can be grouped. */
    conviction: clampScale(raw.conviction),
    emotion: raw.emotion ? String(raw.emotion).slice(0, 40) : null,
    /* The stop and target that were actually in the market. Without the stop
       there is no risk figure and therefore no R multiple, which is why this is
       recorded rather than inferred. */
    stop: num(raw.stop),
    target: num(raw.target),
    /* Chart images captured at the moment of journalling, held as filenames in
       the documents directory rather than inline. */
    screenshots: Array.isArray(raw.screenshots) ? raw.screenshots.slice(0, 8).map(String) : [],
    rating: clampScale(raw.rating),
    updatedAt: Date.now()
  };
}

function clampScale(value) {
  const n = num(value);
  if (n === null) return null;
  return Math.max(1, Math.min(5, Math.round(n)));
}

class Journal {
  constructor(store) {
    this.store = store;
    this.key = 'annotations';
  }

  annotations() {
    const map = new Map();
    this.store.all(this.key).forEach(record => map.set(record.id, record));
    return map;
  }

  annotate(tradeKey, patch) {
    const existing = this.store.byId(this.key, tradeKey) || {};
    const record = Object.assign(annotation(Object.assign({}, existing, patch)), { id: tradeKey, key: tradeKey });
    this.store.put(this.key, record);
    return record;
  }

  remove(tradeKey) {
    this.store.remove(this.key, tradeKey);
    return true;
  }

  /* Closed trades with their annotations attached, newest first. */
  entries(trades) {
    const notes = this.annotations();
    return (trades || []).map(trade => {
      const key = fingerprint(trade);
      const note = notes.get(key) || null;
      return Object.assign({}, trade, {
        key,
        annotation: note,
        journalled: !!note,
        risk: riskOf(trade, note),
        rMultiple: rMultipleOf(trade, note)
      });
    }).sort((a, b) => b.closedAt - a.closedAt);
  }

  /* Annotations whose trade no longer exists.
   *
   * Surfaced rather than silently discarded: the usual cause is a corrected
   * transaction changing the trade's fingerprint, and the written reflection
   * attached to it is the least replaceable thing in this application. */
  orphaned(trades) {
    const live = new Set((trades || []).map(fingerprint));
    return this.store.all(this.key).filter(record => !live.has(record.id));
  }

  /* Move an annotation onto a trade whose fingerprint changed. */
  reattach(fromKey, toKey) {
    const existing = this.store.byId(this.key, fromKey);
    if (!existing) throw new Error('There is no note with that identifier.');
    const moved = Object.assign({}, existing, { id: toKey, key: toKey, reattachedFrom: fromKey, updatedAt: Date.now() });
    this.store.put(this.key, moved);
    this.store.remove(this.key, fromKey);
    return moved;
  }
}

/* Money at risk when the trade was opened: the distance to the stop, times the
   size. Null without a stop — there is no honest substitute for it. */
function riskOf(trade, note) {
  const stop = note && num(note.stop);
  if (stop === null || stop === undefined) return null;
  const entry = num(trade.entryPrice);
  if (entry === null) return null;
  const distance = Math.abs(entry - stop);
  if (distance === 0) return null;
  return distance * Math.abs(trade.quantity);
}

function rMultipleOf(trade, note) {
  const risk = riskOf(trade, note);
  if (risk === null || risk === 0) return null;
  const net = num(trade.netPnl);
  if (net === null) return null;
  return net / risk;
}

/* ---------- statistics ---------- */

/* Everything the journal reports, computed from a list of entries.
 *
 * `entries` must already be filtered to one book. Mixing simulated trades into
 * a real win rate would make the number meaningless, and there is no way to
 * tell from a single trade which book it came from once they are in one list. */
function statistics(entries) {
  const trades = (entries || []).filter(t => num(t.netPnl) !== null);

  if (!trades.length) {
    return { count: 0, empty: true, note: 'No closed trades yet.' };
  }

  const wins = trades.filter(t => t.netPnl > 0);
  const losses = trades.filter(t => t.netPnl < 0);
  const scratches = trades.filter(t => t.netPnl === 0);

  const grossProfit = sum(wins.map(t => t.netPnl));
  const grossLoss = Math.abs(sum(losses.map(t => t.netPnl)));

  const averageWin = wins.length ? grossProfit / wins.length : null;
  const averageLoss = losses.length ? grossLoss / losses.length : null;

  /* The win rate excludes scratches from the numerator but not the
     denominator, because a trade that made nothing is still a trade taken. */
  const winRate = (wins.length / trades.length) * 100;

  /* Expectancy: what one trade is worth on average, given this record. It is
     the figure that says whether the approach makes money, and it is only
     meaningful with both a win and a loss to average. */
  const expectancy = (averageWin !== null && averageLoss !== null)
    ? ((wins.length / trades.length) * averageWin) - ((losses.length / trades.length) * averageLoss)
    : null;

  const withR = trades.filter(t => t.rMultiple !== null);
  const equity = equityCurve(trades);

  return {
    count: trades.length,
    empty: false,
    wins: wins.length,
    losses: losses.length,
    scratches: scratches.length,

    winRate,
    grossProfit,
    grossLoss,
    net: grossProfit - grossLoss,
    averageWin,
    averageLoss,
    /* How much bigger the average win is than the average loss. Undefined
       without a loss to compare against, rather than infinite. */
    winLossRatio: (averageWin !== null && averageLoss) ? averageWin / averageLoss : null,
    expectancy,
    expectancyNote: expectancy === null
      ? 'Expectancy needs at least one winning and one losing trade.' : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    profitFactorNote: grossLoss === 0
      ? 'No losing trades yet, so there is nothing to divide by.' : null,

    largestWin: wins.length ? Math.max(...wins.map(t => t.netPnl)) : null,
    largestLoss: losses.length ? Math.min(...losses.map(t => t.netPnl)) : null,

    /* Only over the trades that actually recorded a stop, and the count is
       reported so the figure is never read as covering everything. */
    rMultiple: withR.length ? {
      average: sum(withR.map(t => t.rMultiple)) / withR.length,
      best: Math.max(...withR.map(t => t.rMultiple)),
      worst: Math.min(...withR.map(t => t.rMultiple)),
      over: withR.length,
      of: trades.length,
      note: withR.length < trades.length
        ? 'Computed over the ' + withR.length + ' of ' + trades.length + ' trades that recorded a stop.'
        : null
    } : {
      average: null, over: 0, of: trades.length,
      note: 'No trade has recorded the stop it was taken with, so there is no risk to measure against.'
    },

    averageHoldMs: sum(trades.map(t => t.holdMs)) / trades.length,
    averageWinHoldMs: wins.length ? sum(wins.map(t => t.holdMs)) / wins.length : null,
    averageLossHoldMs: losses.length ? sum(losses.map(t => t.holdMs)) / losses.length : null,

    streaks: streaksOf(trades),
    maxDrawdown: equity.maxDrawdown,
    maxDrawdownPct: equity.maxDrawdownPct,
    equityCurve: equity.points,

    journalled: trades.filter(t => t.journalled).length,
    firstAt: Math.min(...trades.map(t => t.closedAt)),
    lastAt: Math.max(...trades.map(t => t.closedAt))
  };
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

/* Cumulative profit trade by trade, and the deepest fall from a peak along the
   way. Measured on closed trades in the order they closed, which is the record
   of decisions taken rather than of prices moving. */
function equityCurve(trades) {
  const ordered = trades.slice().sort((a, b) => a.closedAt - b.closedAt);
  const points = [];
  let running = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;

  ordered.forEach(trade => {
    running += trade.netPnl;
    if (running > peak) peak = running;
    const fall = peak - running;
    if (fall > maxDrawdown) {
      maxDrawdown = fall;
      maxDrawdownPct = peak > 0 ? (fall / peak) * 100 : 0;
    }
    points.push({ at: trade.closedAt, equity: running, peak, symbol: trade.symbol, pnl: trade.netPnl });
  });

  return { points, maxDrawdown, maxDrawdownPct };
}

function streaksOf(trades) {
  const ordered = trades.slice().sort((a, b) => a.closedAt - b.closedAt);
  let winRun = 0;
  let lossRun = 0;
  let bestWin = 0;
  let worstLoss = 0;

  ordered.forEach(trade => {
    if (trade.netPnl > 0) { winRun++; lossRun = 0; if (winRun > bestWin) bestWin = winRun; }
    else if (trade.netPnl < 0) { lossRun++; winRun = 0; if (lossRun > worstLoss) worstLoss = lossRun; }
    else { winRun = 0; lossRun = 0; }
  });

  const current = ordered.length
    ? (ordered[ordered.length - 1].netPnl > 0 ? winRun : (ordered[ordered.length - 1].netPnl < 0 ? -lossRun : 0))
    : 0;

  return { longestWinning: bestWin, longestLosing: worstLoss, current };
}

/* ---------- groupings ---------- */

/* Performance split by some property of the trade.
 *
 * Groups with very few trades are still returned, with their count, rather than
 * filtered out — but the count travels with the figure so a hundred per cent
 * win rate over one trade cannot be read as a hundred per cent win rate. */
function groupBy(entries, keyOf) {
  const groups = new Map();

  (entries || []).forEach(trade => {
    if (num(trade.netPnl) === null) return;
    const keys = keyOf(trade);
    (Array.isArray(keys) ? keys : [keys]).forEach(key => {
      if (key === null || key === undefined || key === '') return;
      const name = String(key);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(trade);
    });
  });

  return Array.from(groups.entries()).map(([name, list]) => {
    const wins = list.filter(t => t.netPnl > 0);
    const net = sum(list.map(t => t.netPnl));
    return {
      name,
      count: list.length,
      wins: wins.length,
      winRate: (wins.length / list.length) * 100,
      net,
      average: net / list.length,
      /* Stated so a striking percentage over three trades reads as three
         trades rather than as a finding. */
      thin: list.length < 5
    };
  }).sort((a, b) => b.net - a.net);
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function groupings(entries, timeZone) {
  const zone = timeZone || 'Europe/London';
  const partsOf = ms => {
    try {
      const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: zone, weekday: 'short', hour: '2-digit', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit'
      });
      const found = Object.create(null);
      formatter.formatToParts(new Date(ms)).forEach(part => { found[part.type] = part.value; });
      return found;
    } catch (e) {
      const date = new Date(ms);
      return { weekday: WEEKDAYS[date.getUTCDay()].slice(0, 3), hour: String(date.getUTCHours()).padStart(2, '0') };
    }
  };

  return {
    bySymbol: groupBy(entries, t => t.symbol),
    bySetup: groupBy(entries, t => t.annotation && t.annotation.setup),
    byTag: groupBy(entries, t => (t.annotation && t.annotation.tags) || []),
    byDirection: groupBy(entries, t => t.direction),
    byWeekday: groupBy(entries, t => partsOf(t.openedAt).weekday),
    byHour: groupBy(entries, t => partsOf(t.openedAt).hour + ':00'),
    byConviction: groupBy(entries, t => (t.annotation && t.annotation.conviction) ? 'Conviction ' + t.annotation.conviction : null),
    byEmotion: groupBy(entries, t => t.annotation && t.annotation.emotion)
  };
}

/* Daily profit, for a calendar. Keyed by the operator's own day rather than by
   UTC, so a trade closed at half past eleven at night lands on the day it felt
   like it happened. */
function calendar(entries, timeZone) {
  const zone = timeZone || 'Europe/London';
  const days = new Map();

  (entries || []).forEach(trade => {
    if (num(trade.netPnl) === null) return;
    let key;
    try {
      key = new Intl.DateTimeFormat('en-CA', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date(trade.closedAt));
    } catch (e) {
      key = new Date(trade.closedAt).toISOString().slice(0, 10);
    }
    if (!days.has(key)) days.set(key, { date: key, net: 0, trades: 0, wins: 0 });
    const day = days.get(key);
    day.net += trade.netPnl;
    day.trades++;
    if (trade.netPnl > 0) day.wins++;
  });

  return Array.from(days.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
}

module.exports = {
  Journal, annotation, fingerprint,
  statistics, groupBy, groupings, calendar, equityCurve, streaksOf,
  riskOf, rMultipleOf
};
