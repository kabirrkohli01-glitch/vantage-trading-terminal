'use strict';
/* The dossier.
 *
 * WHY THE EVIDENCE IS GATHERED BY CODE AND NOT BY THE MODEL.
 *
 * The obvious design is to hand the assistant a set of tools and let it decide
 * what to fetch. That is what the ordinary conversation does and it works well
 * for a question with one answer. It is the wrong shape for "look at this
 * company properly", for three reasons that all cost real quality:
 *
 *   A MODEL DECIDING WHAT TO FETCH FETCHES WHAT IT THINKS OF. It reads the news
 *   and forgets the insider filings, or checks the moving averages and never
 *   looks at who else is in the sector. A checklist gathered by code is complete
 *   every time, and what was not available is named rather than absent.
 *
 *   EVERY ROUND OF TOOL CALLS COSTS A REQUEST AND A LARGE SLICE OF THE CONTEXT
 *   BUDGET. The lanes cap context and output together, so six raw tool results
 *   leave almost nothing to answer with. Gathering first and summarising into a
 *   compact dossier spends the budget on reasoning instead of on transport.
 *
 *   A FIGURE THE MODEL NEVER SAW CANNOT BE CHECKED AGAINST IT. Because this
 *   dossier is a plain object built before anything is written, the reviewer at
 *   the end can compare the answer to it mechanically.
 *
 * Nothing here throws. Every section resolves to what it found or to the reason
 * it found nothing, because a dossier that fails because one endpoint is rate
 * limited is a dossier that fails most afternoons.
 */

const indicators = require('../analysis/indicators');
const positions = require('../portfolio/positions');
const sec = require('../market/providers/sec');
const tradingview = require('../market/providers/tradingview');
const worldnews = require('../market/providers/worldnews');
const { changePct } = require('../core/num');
const { BOOK } = require('../portfolio/ledger');

/* Each section is attempted independently and reports its own outcome. */
async function section(name, label, work) {
  try {
    const data = await work();
    return { name, label, ok: true, data };
  } catch (err) {
    return { name, label, ok: false, reason: String((err && err.message) || err) };
  }
}

/* ---------- price action ---------- */

/* Several windows rather than one, because "how is it doing" means something
   different over a day and over a year, and an answer that only looked at one
   of them will confidently describe a pullback as a downtrend. */
const WINDOWS = [
  { range: '5d', label: 'the last week' },
  { range: '1mo', label: 'the last month' },
  { range: '6mo', label: 'the last six months' },
  { range: '1y', label: 'the last year' }
];

async function priceAction(engine, symbol) {
  const chart = await engine.chart(symbol, { range: '2y', interval: '1d' });
  const bars = chart.bars || [];
  if (bars.length < 30) throw new Error('Not enough daily history to read the trend.');

  const closes = bars.map(b => b.c);
  const last = bars[bars.length - 1];

  const windows = await Promise.all(WINDOWS.map(async window => {
    try {
      const part = await engine.chart(symbol, { range: window.range });
      const inner = part.bars || [];
      if (inner.length < 2) return null;
      const high = Math.max(...inner.map(b => b.h));
      const low = Math.min(...inner.map(b => b.l));
      return {
        window: window.label,
        range: window.range,
        changePercent: changePct(inner[inner.length - 1].c, inner[0].o),
        high, low,
        positionInRange: high > low ? ((inner[inner.length - 1].c - low) / (high - low)) * 100 : null,
        bars: inner.length,
        timeframe: part.timeframe
      };
    } catch (err) { return null; }
  }));

  const sma20 = indicators.latest(indicators.sma(closes, 20));
  const sma50 = indicators.latest(indicators.sma(closes, 50));
  const sma200 = indicators.latest(indicators.sma(closes, 200));
  const atr = indicators.latest(indicators.atr(bars, 14));

  return {
    timeframe: chart.timeframe,
    barsRead: bars.length,
    from: new Date(bars[0].t).toISOString().slice(0, 10),
    to: new Date(last.t).toISOString().slice(0, 10),
    latestClose: last.c,
    windows: windows.filter(Boolean),
    movingAverages: {
      sma20, sma50, sma200,
      aboveSma20: sma20 == null ? null : last.c > sma20,
      aboveSma50: sma50 == null ? null : last.c > sma50,
      aboveSma200: sma200 == null ? null : last.c > sma200,
      /* The relationship between the two long averages, which is what people
         mean by "the trend" without saying so. */
      stacked: sma50 == null || sma200 == null ? null : (sma50 > sma200 ? 'rising' : 'falling')
    },
    volatility: {
      averageTrueRange14: atr,
      /* Expressed against the price as well, because an ATR of 6 means one thing
         on a £20 share and another on a £900 one, and a stop is sized off this. */
      atrPercentOfPrice: atr == null || !last.c ? null : (atr / last.c) * 100
    },
    momentum: {
      rsi14: indicators.latest(indicators.rsi(closes, 14)),
      macd: readMacd(closes)
    },
    volume: {
      latest: last.v,
      versusAverage: indicators.latest(indicators.relativeVolume(bars, 20))
    },
    /* Where the market has repeatedly turned. Levels a trader would draw by
       hand, found by counting rather than by eye. */
    levels: swingLevels(bars, last.c)
  };
}

function readMacd(closes) {
  try {
    const result = indicators.macd(closes, 12, 26, 9);
    if (!result) return null;
    const line = indicators.latest(result.macd || result.line);
    const signal = indicators.latest(result.signal);
    return line == null || signal == null ? null : {
      line, signal, histogram: line - signal,
      above: line > signal
    };
  } catch (err) { return null; }
}

/* Pivot highs and lows: a bar whose extreme is the highest or lowest of the
 * bars either side of it. Clustered into levels, because the same shelf gets
 * tested repeatedly and reporting eleven pivots that are all within one per cent
 * of each other says less than reporting one level tested eleven times. */
function swingLevels(bars, price) {
  const reach = 5;
  const pivots = [];

  for (let i = reach; i < bars.length - reach; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - reach; j <= i + reach; j++) {
      if (j === i) continue;
      if (bars[j].h >= bars[i].h) isHigh = false;
      if (bars[j].l <= bars[i].l) isLow = false;
    }
    if (isHigh) pivots.push({ price: bars[i].h, kind: 'high', at: bars[i].t });
    if (isLow) pivots.push({ price: bars[i].l, kind: 'low', at: bars[i].t });
  }

  const tolerance = price * 0.015;
  const clusters = [];
  pivots.sort((a, b) => a.price - b.price).forEach(pivot => {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(pivot.price - last.price) <= tolerance) {
      last.price = (last.price * last.touches + pivot.price) / (last.touches + 1);
      last.touches++;
      last.lastTouched = Math.max(last.lastTouched, pivot.at);
      return;
    }
    clusters.push({ price: pivot.price, touches: 1, lastTouched: pivot.at });
  });

  const strong = clusters.filter(c => c.touches >= 2);
  return {
    support: strong.filter(c => c.price < price).slice(-3).reverse()
      .map(c => ({ price: round(c.price), touches: c.touches, lastTouched: stamp(c.lastTouched) })),
    resistance: strong.filter(c => c.price > price).slice(0, 3)
      .map(c => ({ price: round(c.price), touches: c.touches, lastTouched: stamp(c.lastTouched) })),
    note: 'A level is a price the market turned at more than once, within one and a half per cent.'
  };
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toPrecision(6)) : null;
}

function stamp(at) {
  return at ? new Date(at).toISOString().slice(0, 10) : null;
}

/* ---------- the dossier ---------- */

/* Build everything known about one instrument. */
async function forInstrument(context, symbol, options) {
  const opts = options || {};
  const engine = context.engine;

  const quoteModel = await engine.quote(symbol).catch(() => null);
  if (!quoteModel) {
    const error = new Error('No price could be loaded for ' + symbol + ', so there is nothing to analyse.');
    error.kind = 'unpriced';
    throw error;
  }

  const tvSymbol = await engine.vendorSymbol(symbol).catch(() => null);

  const wanted = [
    section('price', 'Price and structure', () => priceAction(engine, symbol)),
    section('reference', 'Consensus and performance', () => engine.reference(symbol)),
    section('fundamentals', 'Accounts and valuation', () => engine.fundamentals(symbol)),
    section('news', 'What is being reported', () => newsFor(engine, symbol, tvSymbol)),
    section('insider', 'Insider dealing', () => sec.insider(symbol, { limit: 12 })),
    section('filings', 'Regulatory filings', () => sec.filings(symbol, { limit: 8 })),
    section('peers', 'The sector and its members', () => engine.peers(symbol, { limit: 10 })),
    section('sectors', 'How every sector is trading', () => engine.sectors(regionOf(tvSymbol)))
  ];

  if (context.ledger) wanted.push(section('holding', 'Whether this is held', () => holdingOf(context, symbol)));

  const sections = await Promise.all(wanted);
  const byName = Object.create(null);
  sections.forEach(entry => { byName[entry.name] = entry; });

  return {
    symbol: quoteModel.symbol,
    tvSymbol,
    name: quoteModel.name,
    assetClass: quoteModel.assetClass,
    currency: quoteModel.currency,
    venue: quoteModel.exchangeName,
    quote: {
      last: quoteModel.quote.last,
      previousClose: quoteModel.quote.previousClose,
      changePercent: changePct(quoteModel.quote.last, quoteModel.quote.previousClose),
      open: quoteModel.quote.open,
      dayHigh: quoteModel.quote.dayHigh,
      dayLow: quoteModel.quote.dayLow,
      yearHigh: quoteModel.quote.yearHigh,
      yearLow: quoteModel.quote.yearLow,
      volume: quoteModel.quote.volume,
      stampedAt: quoteModel.quote.at ? new Date(quoteModel.quote.at).toISOString() : null,
      /* The regular session's last print and a pre- or post-market one are
         different facts, not competing versions of the same one — dropped
         here, an answer written while the venue is in one of those sessions
         reasons entirely from a close that can be hours stale, which is
         exactly backwards for "where would you get in" the moment it
         matters most: the instant the tape has already moved on it. */
      extended: quoteModel.quote.extended ? {
        session: quoteModel.quote.extended.state,
        price: quoteModel.quote.extended.price,
        changePercent: quoteModel.quote.extended.changePercent,
        at: quoteModel.quote.extended.at ? new Date(quoteModel.quote.extended.at).toISOString() : null,
        current: !!(quoteModel.quote.extended.freshness &&
          (quoteModel.quote.extended.freshness.state === 'LIVE' || quoteModel.quote.extended.freshness.state === 'DELAYED'))
      } : null
    },
    /* Carried at the top because everything below is only as current as this
       is, and an answer written on a stale quote must say so. */
    dataState: {
      label: quoteModel.freshness.label,
      reason: quoteModel.freshness.reason,
      source: quoteModel.provenance ? quoteModel.provenance.providerLabel : null
    },
    warnings: quoteModel.warnings || [],
    sections: byName,
    /* The list of what could not be read, so the answer can say what it did not
       see instead of writing around the hole. */
    missing: sections.filter(s => !s.ok).map(s => ({ name: s.name, label: s.label, reason: s.reason })),
    builtAt: Date.now(),
    question: opts.question || null
  };
}

function regionOf(tvSymbol) {
  return tvSymbol ? tradingview.regionFor(tvSymbol) : 'america';
}

/* Headlines from the venue's own feed and from the vendor's instrument-tagged
   flow, with the body of anything readable pulled in. A headline alone supports
   almost no claim; the first few sentences support most of them. */
async function newsFor(engine, symbol, tvSymbol) {
  const [feed, flow] = await Promise.all([
    engine.newsFor(symbol, { limit: 14 }).catch(() => null),
    tvSymbol ? tradingview.news({ tvSymbol }).catch(() => null) : Promise.resolve(null)
  ]);

  const items = []
    .concat((feed && feed.items) || [])
    .concat((flow && flow.items) || []);

  /* Bodies are expensive, so only the newest few readable ones are opened. */
  const readable = ((flow && flow.items) || []).filter(item => item.readable).slice(0, 3);
  const stories = await Promise.all(readable.map(async item => {
    try {
      const full = await tradingview.story(item.id);
      return full.text ? { title: item.title, publisher: item.publisher, text: full.text.slice(0, 2200) } : null;
    } catch (err) { return null; }
  }));

  return {
    headlines: items.slice(0, 22).map(item => ({
      title: item.title,
      publisher: item.publisher,
      at: item.publishedAt ? new Date(item.publishedAt).toISOString() : null,
      summary: item.summary || null
    })),
    stories: stories.filter(Boolean),
    count: items.length
  };
}

async function holdingOf(context, symbol) {
  const built = positions.build(context.ledger.ordered(BOOK.MIRROR));
  const held = built.find(p => p.symbol === String(symbol).toUpperCase() && p.open);
  if (!held) return { held: false };
  return {
    held: true,
    quantity: held.quantity,
    averageEntry: held.averageEntry,
    book: 'mirror',
    caveat: 'Entered by hand and not confirmed by a broker.'
  };
}

/* ---------- rendering the dossier for a reader ---------- */

/* Each specialist gets its own slice, written as text rather than as JSON.
 *
 * A model reads a labelled paragraph far better than it reads a nested object,
 * and an object costs three times the tokens in punctuation alone. Numbers are
 * left exactly as they were fetched — never rounded on the way in, because the
 * rounding would then be indistinguishable from the model's own arithmetic. */
function render(value, depth) {
  const level = depth || 0;
  const pad = '  '.repeat(level);

  if (value === null || value === undefined) return 'not available';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) {
    if (!value.length) return 'none';
    return '\n' + value.map(entry => pad + '- ' + render(entry, level + 1).replace(/^\n/, '')).join('\n');
  }

  const keys = Object.keys(value).filter(key => value[key] !== null && value[key] !== undefined);
  if (!keys.length) return 'not available';
  return '\n' + keys.map(key => pad + '  ' + humanise(key) + ': ' + render(value[key], level + 1)).join('\n');
}

function humanise(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.]/g, ' ')
    .toLowerCase();
}

/* The heading every specialist sees, so each of them is reasoning about the same
   instrument at the same price with the same caveat on it. */
function heading(dossier) {
  const lines = [
    /* Given once, in code, rather than left for a specialist to work out or
       fetch: every reader of this heading — each specialist, the chief, the
       reviewer — then knows without guessing whether a date is past, today
       or still ahead. A model that has to infer "today" from context has
       been seen placing an earnings date on the wrong day; a stamp it does
       not have to compute cannot be miscalculated. */
    'RIGHT NOW: ' + new Date().toISOString() + ' (UTC). Judge every date against this rather than guessing.',
    'INSTRUMENT: ' + dossier.symbol + (dossier.name ? ' — ' + dossier.name : ''),
    'Asset class: ' + dossier.assetClass + (dossier.venue ? ', ' + dossier.venue : '') +
      (dossier.currency ? ', quoted in ' + dossier.currency : ''),
    'Last: ' + dossier.quote.last + (dossier.quote.changePercent == null ? '' :
      ' (' + dossier.quote.changePercent.toFixed(2) + '% on the day)'),
    'Stamped: ' + (dossier.quote.stampedAt || 'unknown') + ' — data state ' + dossier.dataState.label +
      ' (' + dossier.dataState.reason + ')'
  ];
  if (dossier.quote.extended && dossier.quote.extended.current) {
    const ext = dossier.quote.extended;
    lines.push('THE VENUE IS CURRENTLY IN ITS ' + ext.session + ' SESSION, AND THE TAPE HAS ALREADY MOVED PAST ' +
      'THE REGULAR CLOSE ABOVE: ' + ext.price + (ext.changePercent == null ? '' :
        ' (' + ext.changePercent.toFixed(2) + '% from the regular close)') + ', stamped ' + ext.at + '. ' +
      'THIS IS THE CURRENT PRICE. Use it for anything about where this trades right now or where you would ' +
      'act — an entry, a level, "where is it now" — and say plainly that the regular close is not the live figure.');
  }
  if (dossier.warnings.length) lines.push('Warnings on this figure: ' + dossier.warnings.join('; '));
  return lines.join('\n');
}

function sectionText(dossier, name) {
  const entry = dossier.sections[name];
  if (!entry) return 'Not gathered.';
  if (!entry.ok) return 'UNAVAILABLE — ' + entry.reason + '. Say so rather than working around it.';
  return render(entry.data).trim();
}

module.exports = {
  forInstrument, priceAction, swingLevels, render, heading, sectionText, section, WINDOWS
};
