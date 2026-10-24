'use strict';
/* The charting vendor's public data services.
 *
 * WHAT THIS IS AND WHAT IT IS NOT. These are the endpoints the vendor's own
 * public website calls. They are keyless and they answer an honest client — this
 * file was written only after each one was driven from this machine with the
 * application's real user agent and no forged origin or referrer, because a
 * source that only answers a client pretending to be a browser is a source this
 * application does not use. They are also UNDOCUMENTED, so they may change or
 * stop without notice. Every caller here degrades to a stated absence rather
 * than an empty panel, and nothing that must be correct depends on them alone:
 * prices, charts and reported figures continue to come from the venues and the
 * regulator.
 *
 * What they add is the coverage nothing free had before: every listed instrument
 * in the world with the exchange it trades on and the company's own mark, the
 * analyst consensus, sector membership and peers, and a worldwide news flow
 * tagged by instrument.
 *
 * TWO SYMBOL VOCABULARIES MEET HERE. This application speaks the venue
 * vocabulary its price source uses — NVDA, HSBA.L, ^GSPC, GC=F, EURUSD=X,
 * BTC-USD. The vendor speaks EXCHANGE:TICKER. Neither is convertible to the
 * other by rule, so the translation is a table for the shapes that are regular
 * and a lookup for the rest, and a symbol that cannot be translated is reported
 * as untranslatable rather than guessed at. A guessed exchange prefix draws a
 * chart of a different instrument with the same ticker, which is the worst
 * failure this file could have.
 */

const http = require('../../core/http');

const NAME = 'tradingview';
const LABEL = 'TradingView public data';

const SCANNER = 'https://scanner.tradingview.com/';
const NEWS_FLOW = 'https://news-mediator.tradingview.com/news-flow/v2/news';
const NEWS_STORY = 'https://news-headlines.tradingview.com/v3/story';

/* Scanner regions. `global` searches every market at once and is the default for
   a search box; a named region is faster and is used when the market is known. */
const REGIONS = ['america', 'global', 'crypto', 'forex'];

/* The markets `global` will search. Named explicitly because the service
   defaults to a subset, and "any stock in the world" was the requirement. */
const MARKETS = [
  'america', 'uk', 'india', 'japan', 'germany', 'canada', 'australia', 'france',
  'italy', 'spain', 'netherlands', 'switzerland', 'sweden', 'norway', 'denmark',
  'finland', 'belgium', 'portugal', 'poland', 'austria', 'greece', 'turkey',
  'russia', 'brazil', 'mexico', 'argentina', 'chile', 'colombia', 'peru',
  'china', 'hongkong', 'taiwan', 'korea', 'singapore', 'malaysia', 'indonesia',
  'thailand', 'vietnam', 'philippines', 'newzealand', 'israel', 'uae', 'ksa',
  'qatar', 'kuwait', 'bahrain', 'egypt', 'nigeria', 'kenya', 'morocco', 'rsa',
  'hungary', 'czech', 'romania', 'srilanka', 'bangladesh', 'pakistan'
];

const CACHE_QUOTE = 45 * 1000;
const CACHE_SEARCH = 10 * 60 * 1000;
const CACHE_REFERENCE = 30 * 60 * 1000;
const CACHE_NEWS = 3 * 60 * 1000;

/* ---------- the scanner ---------- */

async function scan(region, body, cacheMs) {
  const where = REGIONS.indexOf(region) === -1 ? 'global' : region;
  const url = SCANNER + where + '/scan';
  const payload = JSON.stringify(body);

  const res = await http.json(url, {
    method: 'POST',
    body: payload,
    headers: { 'Content-Type': 'application/json' },
    /* A POST has no address of its own to key a cache on, so the body is part
       of the key. Without this every search would be a fresh request and a
       repeated keystroke would be a repeated round trip. */
    cacheKey: url + '|' + payload,
    cacheMs: cacheMs == null ? CACHE_QUOTE : cacheMs
  });

  const rows = (res.data && res.data.data) || [];
  return {
    total: (res.data && res.data.totalCount) || rows.length,
    rows,
    at: res.at,
    cached: res.cached
  };
}

/* A scanner row is a ticker and an array of values in the order the columns were
   requested. Zipping them here means no caller has to count positions. */
function zip(row, columns) {
  const out = { ticker: row.s };
  columns.forEach((column, i) => { out[column] = row.d[i]; });
  return out;
}

function provenance(endpoint, at, extra) {
  return Object.assign({
    provider: NAME,
    providerLabel: LABEL,
    endpoint,
    retrievedAt: at,
    at
  }, extra || {});
}

/* ---------- search ---------- */

const SEARCH_COLUMNS = ['name', 'description', 'logoid', 'type', 'typespecs', 'exchange',
  'country', 'currency', 'close', 'change', 'market_cap_basic'];

/* Asset classes the search box offers, mapped onto the scanner's own regions and
   type filters. */
const SEARCH_SCOPES = {
  all: { region: 'global', types: null },
  stocks: { region: 'global', types: ['stock', 'dr'] },
  funds: { region: 'global', types: ['fund', 'structured'] },
  futures: { region: 'global', types: ['futures'] },
  indices: { region: 'global', types: ['index'] },
  bonds: { region: 'global', types: ['bond'] },
  crypto: { region: 'crypto', types: null },
  forex: { region: 'forex', types: null }
};

/* THE SCANNER MATCHES A TOKEN, NOT A PHRASE, AND THE DIFFERENCE IS NOT
 * COSMETIC. "rolls royce" matches the American depositary receipts, whose
 * description happens to have a space in it, and misses the London listing
 * entirely, whose description spells the company with a hyphen. Searching the
 * phrase alone therefore returns a secondary listing of a British company and
 * calls it the answer.
 *
 * So a query of several words is searched twice: as the phrase, and as its
 * longest word, which is the one most likely to be the name. Both results are
 * merged. The second request is nearly free — searches are cached — and it is
 * the difference between finding a company and finding a receipt for it. */
/* Words that appear in thousands of company names and identify none of them.
   Searching "general motors" on its longest word finds every general
   partnership and general insurer in the world; searching it on "motors" finds
   the car maker. */
const NOISE_WORDS = new Set(['the', 'and', 'of', 'for', 'group', 'holdings', 'holding',
  'company', 'co', 'corp', 'corporation', 'inc', 'incorporated', 'plc', 'ltd', 'limited',
  'sa', 'ag', 'nv', 'se', 'general', 'international', 'national', 'industries', 'industrial',
  'technologies', 'technology', 'systems', 'services', 'solutions', 'stock', 'shares']);

function queryTerms(text) {
  const clean = String(text || '').trim();
  if (!clean) return [];
  const terms = [clean];

  const words = clean.split(/\s+/).filter(w => w.length > 1);
  if (words.length > 1) {
    const meaningful = words.filter(w => !NOISE_WORDS.has(w.toLowerCase()));
    const candidates = meaningful.length ? meaningful : words;
    /* Longest wins, and a tie goes to the LAST of them. Company names put the
       distinctive part at the end far more often than at the front — the maker
       of the aero engine is "Rolls-Royce" and the word that finds it is the
       second one. */
    const best = candidates.reduce((chosen, word) =>
      (word.length >= chosen.length ? word : chosen), candidates[0]);
    if (terms.indexOf(best) === -1) terms.push(best);
  }
  return terms;
}

async function search(text, options) {
  const opts = options || {};
  const scope = SEARCH_SCOPES[opts.scope] || SEARCH_SCOPES.all;
  const limit = Math.min(Math.max(Number(opts.limit) || 24, 1), 60);
  const terms = queryTerms(text);
  if (!terms.length) return { query: '', matches: [], sources: [] };

  const seen = new Set();
  const matches = [];
  const sources = [];
  let total = 0;

  for (const term of terms) {
    const filter = [{ left: 'name,description', operation: 'match', right: term }];
    if (scope.types) filter.push({ left: 'type', operation: 'in_range', right: scope.types });

    /* FAR MORE ROWS ARE FETCHED THAN ARE SHOWN, AND THE REASON IS NOT
       CAUTION. Every depositary receipt of a company reports the company's own
       market value, so a worldwide search for a large company returns dozens of
       rows that are identical under the sort and the real listing is not among
       the first of them: "nvda" answered with four Buenos Aires receipts and six
       Thai ones before the Nasdaq line. The sort cannot separate them, so the
       ranking below does, and it can only rank what it was sent. */
    const body = {
      filter,
      options: { lang: 'en' },
      columns: SEARCH_COLUMNS,
      sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
      range: [0, Math.min(Math.max(limit * 4, 120), 200)]
    };
    if (scope.region === 'global') body.markets = MARKETS;

    const found = await scan(scope.region, body, CACHE_SEARCH).catch(() => null);
    if (!found) continue;
    total = Math.max(total, found.total);
    sources.push(provenance(SCANNER + scope.region + '/scan', found.at, { cached: found.cached }));

    found.rows.forEach(row => {
      const match = describeMatch(zip(row, SEARCH_COLUMNS));
      if (!match || seen.has(match.tvSymbol)) return;
      seen.add(match.tvSymbol);
      matches.push(match);
    });
  }

  return {
    query: text,
    matchedOn: terms,
    total,
    matches: rankMatches(matches, text).slice(0, limit),
    sources
  };
}

function describeMatch(row) {
  if (!row.ticker) return null;
  const parts = String(row.ticker).split(':');
  const exchange = parts.length > 1 ? parts[0] : (row.exchange || null);
  const ticker = parts.length > 1 ? parts.slice(1).join(':') : parts[0];

  return {
    tvSymbol: row.ticker,
    ticker,
    exchange,
    name: row.description || row.name || ticker,
    type: row.type || null,
    typeSpecs: Array.isArray(row.typespecs) ? row.typespecs : [],
    country: row.country || null,
    currency: row.currency || null,
    last: numberOrNull(row.close),
    changePercent: numberOrNull(row.change),
    marketCap: numberOrNull(row.market_cap_basic),
    logo: row.logoid || null,
    /* Filled in by the engine where a venue symbol exists for this listing.
       Null means the instrument can be looked at but not priced from the
       venues this application uses, and the interface says so. */
    symbol: null
  };
}

/* Venues that carry another market's company second hand. A search for a
   British engine maker should not answer with an American over-the-counter
   receipt for it, and a search for an American bank should not answer with a
   Mexican depositary receipt, however large the underlying company is. */
/* Several of these are a country's own primary exchange and are listed anyway,
   because what they mostly carry under a foreign company's ticker is a receipt
   for it. A genuinely domestic listing on one of them recovers the penalty and
   more through the home-currency test below, so the two rules together prefer a
   local company on its local exchange and demote a foreign one. */
const SECONDARY_VENUES = new Set(['OTC', 'PINX', 'BX', 'BIVA', 'BMV', 'SET', 'LSIN',
  'GETTEX', 'FWB', 'HAM', 'HAN', 'MUN', 'BER', 'DUS', 'STU', 'TRADEGATE', 'NEO',
  'BCBA', 'BVL', 'BCS', 'BVC', 'LSX', 'SWB', 'EUROTLX']);

/* THE CURRENCY A LISTING TRADES IN IS WHAT IDENTIFIES THE PRIMARY ONE.
 *
 * A large company is listed in a dozen places and every one of them reports the
 * same market value, so the sort that fetched them cannot tell them apart: a
 * search for "nvda" came back with the Vienna, Warsaw, Zurich and Bogota lines
 * ahead of the Nasdaq one, all with the same figure beside them and all
 * correctly labelled as being in the United States. What separates them is that
 * the primary listing trades in its own country's money and a cross-listing does
 * not. This is that comparison, and it needs no list of which venue is primary. */
const HOME_CURRENCY = {
  'United States': 'USD', 'United Kingdom': 'GBP', 'Canada': 'CAD', 'Australia': 'AUD',
  'New Zealand': 'NZD', 'Japan': 'JPY', 'China': 'CNY', 'Hong Kong': 'HKD',
  'Taiwan': 'TWD', 'South Korea': 'KRW', 'Korea': 'KRW', 'Singapore': 'SGD',
  'India': 'INR', 'Indonesia': 'IDR', 'Malaysia': 'MYR', 'Thailand': 'THB',
  'Vietnam': 'VND', 'Philippines': 'PHP', 'Pakistan': 'PKR', 'Bangladesh': 'BDT',
  'Sri Lanka': 'LKR', 'Switzerland': 'CHF', 'Sweden': 'SEK', 'Norway': 'NOK',
  'Denmark': 'DKK', 'Poland': 'PLN', 'Hungary': 'HUF', 'Czech Republic': 'CZK',
  'Romania': 'RON', 'Turkey': 'TRY', 'Russia': 'RUB', 'Israel': 'ILS',
  'Brazil': 'BRL', 'Mexico': 'MXN', 'Argentina': 'ARS', 'Chile': 'CLP',
  'Colombia': 'COP', 'Peru': 'PEN', 'South Africa': 'ZAR', 'Nigeria': 'NGN',
  'Kenya': 'KES', 'Egypt': 'EGP', 'Morocco': 'MAD', 'Saudi Arabia': 'SAR',
  'United Arab Emirates': 'AED', 'Qatar': 'QAR', 'Kuwait': 'KWD', 'Bahrain': 'BHD',
  'Germany': 'EUR', 'France': 'EUR', 'Italy': 'EUR', 'Spain': 'EUR',
  'Netherlands': 'EUR', 'Belgium': 'EUR', 'Portugal': 'EUR', 'Austria': 'EUR',
  'Ireland': 'EUR', 'Finland': 'EUR', 'Greece': 'EUR', 'Luxembourg': 'EUR'
};

/* London quotes most of its shares in pence rather than pounds, and both are
   the home currency of the same country. */
function tradesAtHome(country, currency) {
  const home = HOME_CURRENCY[String(country || '')];
  if (!home || !currency) return false;
  const listed = String(currency).toUpperCase();
  if (listed === home) return true;
  return home === 'GBP' && listed === 'GBX';
}

/* Rank an exact ticker match above a name match, a primary listing above a
   depositary receipt of it, and a large company above a small one. Without this
   a search for a household name returns six leveraged funds tracking it before
   the company itself. */
function rankMatches(matches, text) {
  const wanted = String(text || '').trim().toUpperCase();
  return matches.slice().sort((a, b) => score(b) - score(a));

  function score(match) {
    let value = 0;
    if (match.ticker.toUpperCase() === wanted) value += 1000;
    else if (match.ticker.toUpperCase().indexOf(wanted) === 0) value += 400;
    if (String(match.name || '').toUpperCase().indexOf(wanted) === 0) value += 260;
    if (match.type === 'stock') value += 180;
    /* An index is the thing somebody typing "ftse" or "s&p" wants, and it is
       always outnumbered by the funds that track it — twenty of them, each with
       the index's name in its own. Without this the index itself never appears. */
    if (match.type === 'index') value += 200;
    if (match.typeSpecs.indexOf('common') !== -1) value += 120;
    if (match.type === 'dr') value -= 220;
    if (match.type === 'bond') value -= 320;
    if (SECONDARY_VENUES.has(String(match.exchange || '').toUpperCase())) value -= 260;
    if (tradesAtHome(match.country, match.currency)) value += 320;
    /* A listing this application can also price is worth more than one it can
       only draw, because everything else on the screen follows from a quote. */
    if (toVenue(match.tvSymbol)) value += 120;
    if (match.marketCap) value += Math.min(Math.log10(match.marketCap) * 12, 140);
    /* A listing with no price is a listing that cannot be looked at. */
    if (match.last === null) value -= 150;
    return value;
  }
}

function numberOrNull(value) {
  return Number.isFinite(Number(value)) && value !== null ? Number(value) : null;
}

/* ---------- reference data for one instrument ---------- */

/* Everything the scanner publishes about a listing that this application has no
   other free source for. Grouped by what it answers rather than by how the
   service names it. */
const DETAIL_COLUMNS = [
  'name', 'description', 'logoid', 'close', 'change', 'change_abs', 'volume',
  'relative_volume_10d_calc', 'average_volume_10d_calc', 'market_cap_basic',
  'price_earnings_ttm', 'price_earnings_growth_ttm', 'price_sales_current',
  'price_book_fq', 'enterprise_value_current', 'enterprise_value_to_ebitda_ttm',
  'earnings_per_share_diluted_ttm', 'earnings_per_share_diluted_yoy_growth_ttm',
  'dividends_yield_current', 'dividend_payout_ratio_ttm', 'beta_1_year',
  'sector', 'industry', 'country', 'currency', 'employees', 'web_site_url',
  'recommendation_mark', 'price_target_average', 'price_target_high',
  'price_target_low', 'price_target_median',
  'Recommend.All', 'Recommend.MA', 'Recommend.Other', 'RSI', 'Stoch.K', 'MACD.macd',
  'SMA20', 'SMA50', 'SMA200', 'EMA20', 'EMA50', 'EMA200', 'ATR', 'Volatility.D',
  'earnings_release_next_date', 'earnings_release_date',
  'earnings_per_share_forecast_next_fq', 'revenue_forecast_next_fq',
  'total_revenue_ttm', 'total_revenue_yoy_growth_ttm', 'net_income_ttm',
  'gross_margin_ttm', 'operating_margin_ttm', 'net_margin_ttm',
  'free_cash_flow_ttm', 'total_debt_fq', 'cash_n_short_term_invest_fq',
  'debt_to_equity_fq', 'current_ratio_fq', 'return_on_equity_fq', 'return_on_assets_fq',
  'Perf.W', 'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.YTD', 'Perf.Y', 'Perf.5Y', 'Perf.All',
  'High.1M', 'Low.1M', 'price_52_week_high', 'price_52_week_low',
  'float_shares_percent_current', 'total_shares_outstanding_fundamental',
  'short_interest_percent_of_float'
];

async function detail(tvSymbol) {
  const symbol = String(tvSymbol || '').trim();
  if (!symbol) throw new Error('An exchange-qualified symbol is needed.');

  const region = regionFor(symbol);
  const found = await scan(region, {
    symbols: { tickers: [symbol], query: { types: [] } },
    columns: DETAIL_COLUMNS
  }, CACHE_QUOTE);

  if (!found.rows.length) {
    const error = new Error('The vendor publishes nothing under ' + symbol + '.');
    error.kind = 'not-found';
    throw error;
  }

  const row = zip(found.rows[0], DETAIL_COLUMNS);
  return {
    tvSymbol: symbol,
    figures: row,
    reading: interpret(row),
    sources: [provenance(SCANNER + region + '/scan', found.at, { cached: found.cached })]
  };
}

/* Two of these columns are scales rather than numbers, and reading them wrongly
 * would turn a neutral instrument into a recommendation.
 *
 *   `recommendation_mark` is the ANALYST consensus, from 1 to 5, and it runs the
 *   way a broker's rating card runs: 1 is the most positive. It is only a
 *   consensus where analysts cover the instrument at all, so a null is reported
 *   as "not covered" and never as neutral.
 *
 *   `Recommend.All` is the vendor's own TECHNICAL summary, from -1 to 1, and it
 *   runs the opposite way: positive is the bullish end. It is arithmetic over
 *   oscillators and moving averages, not an opinion, and it is labelled as such.
 */
function interpret(row) {
  return {
    analystConsensus: analystScale(row.recommendation_mark),
    technicalSummary: technicalScale(row['Recommend.All']),
    movingAverages: technicalScale(row['Recommend.MA']),
    oscillators: technicalScale(row['Recommend.Other'])
  };
}

function analystScale(value) {
  const mark = numberOrNull(value);
  if (mark === null) return { available: false, reason: 'No analyst covers this instrument here.' };
  let label = 'Hold';
  if (mark < 1.5) label = 'Strong buy';
  else if (mark < 2.5) label = 'Buy';
  else if (mark < 3.5) label = 'Hold';
  else if (mark < 4.5) label = 'Sell';
  else label = 'Strong sell';
  return { available: true, value: mark, label, scale: '1 strong buy to 5 strong sell' };
}

function technicalScale(value) {
  const mark = numberOrNull(value);
  if (mark === null) return { available: false, reason: 'Not published for this instrument.' };
  let label = 'Neutral';
  if (mark >= 0.5) label = 'Strong buy';
  else if (mark >= 0.1) label = 'Buy';
  else if (mark > -0.1) label = 'Neutral';
  else if (mark > -0.5) label = 'Sell';
  else label = 'Strong sell';
  return {
    available: true, value: mark, label,
    scale: '-1 to 1, computed from oscillators and moving averages rather than from an opinion'
  };
}

/* ---------- company marks ---------- */

/* THE LOGO FOR MANY INSTRUMENTS IN ONE REQUEST.
 *
 * A watchlist has a dozen rows and an instrument header has one; asking for each
 * separately would be a dozen requests to draw a column of pictures. The scanner
 * takes a list of symbols, so the whole screen's worth is one call.
 *
 * A pair — a currency or a crypto — has no single mark. Its two sides each have
 * one, which is what the vendor's own interface draws, so both are returned and
 * the interface overlaps them. */
const LOGO_COLUMNS = ['logoid', 'base-currency-logoid', 'currency-logoid', 'source_logoid'];

async function logos(tvSymbols) {
  const wanted = Array.from(new Set((tvSymbols || []).filter(Boolean))).slice(0, 120);
  if (!wanted.length) return {};

  /* Grouped by region because a regional endpoint does not answer for a symbol
     from another market. */
  const groups = new Map();
  wanted.forEach(symbol => {
    const region = regionFor(symbol);
    if (!groups.has(region)) groups.set(region, []);
    groups.get(region).push(symbol);
  });

  const out = Object.create(null);
  await Promise.all(Array.from(groups.entries()).map(async ([region, symbols]) => {
    try {
      const found = await scan(region, {
        symbols: { tickers: symbols, query: { types: [] } },
        columns: LOGO_COLUMNS
      }, CACHE_REFERENCE);

      found.rows.forEach(row => {
        const values = zip(row, LOGO_COLUMNS);
        out[row.s] = {
          logo: values.logoid || null,
          base: values['base-currency-logoid'] || null,
          quote: values['currency-logoid'] || null,
          venue: values.source_logoid || null
        };
      });
    } catch (err) {
      /* A region that did not answer leaves those instruments without a mark,
         and the interface draws their initials. Nothing else is affected. */
    }
  }));

  return out;
}

/* ---------- peers and sector ---------- */

const PEER_COLUMNS = ['name', 'description', 'logoid', 'close', 'change', 'Perf.1M',
  'Perf.YTD', 'market_cap_basic', 'price_earnings_ttm', 'sector', 'industry'];

async function peers(tvSymbol, options) {
  const opts = options || {};
  const own = await detail(tvSymbol).catch(() => null);
  const industry = own && own.figures.industry;
  const sector = own && own.figures.sector;
  if (!industry && !sector) return { peers: [], reason: 'No sector is published for this instrument.' };

  const region = regionFor(tvSymbol);
  const found = await scan(region, {
    filter: [{ left: industry ? 'industry' : 'sector', operation: 'equal', right: industry || sector }],
    options: { lang: 'en' },
    columns: PEER_COLUMNS,
    sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
    range: [0, Math.min(Number(opts.limit) || 12, 40)]
  }, CACHE_REFERENCE);

  return {
    basis: industry ? 'industry' : 'sector',
    group: industry || sector,
    sector: sector || null,
    peers: found.rows.map(row => zip(row, PEER_COLUMNS)),
    sources: [provenance(SCANNER + region + '/scan', found.at, { cached: found.cached })]
  };
}

/* How every sector in a market has traded. The macro picture behind one
   instrument: whether the move is the company or the whole shelf it sits on. */
async function sectorPerformance(region) {
  const where = region || 'america';
  const columns = ['sector', 'change', 'Perf.W', 'Perf.1M', 'Perf.YTD', 'market_cap_basic', 'volume'];
  const found = await scan(where, {
    filter: [{ left: 'sector', operation: 'nempty' }, { left: 'type', operation: 'equal', right: 'stock' }],
    options: { lang: 'en' },
    columns,
    sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
    range: [0, 500]
  }, CACHE_REFERENCE);

  /* Weighted by market value, because an equal-weight average of five hundred
     rows says what the small ones did and calls it the sector. */
  const buckets = new Map();
  found.rows.forEach(row => {
    const r = zip(row, columns);
    if (!r.sector) return;
    const weight = numberOrNull(r.market_cap_basic) || 0;
    if (!weight) return;
    const bucket = buckets.get(r.sector) || { sector: r.sector, weight: 0, day: 0, week: 0, month: 0, ytd: 0, members: 0 };
    bucket.weight += weight;
    bucket.day += (numberOrNull(r.change) || 0) * weight;
    bucket.week += (numberOrNull(r['Perf.W']) || 0) * weight;
    bucket.month += (numberOrNull(r['Perf.1M']) || 0) * weight;
    bucket.ytd += (numberOrNull(r['Perf.YTD']) || 0) * weight;
    bucket.members++;
    buckets.set(r.sector, bucket);
  });

  const sectors = Array.from(buckets.values()).map(b => ({
    sector: b.sector,
    members: b.members,
    changePercent: b.day / b.weight,
    weekPercent: b.week / b.weight,
    monthPercent: b.month / b.weight,
    ytdPercent: b.ytd / b.weight
  })).sort((a, b) => b.changePercent - a.changePercent);

  return {
    region: where,
    basis: 'The largest 500 listings by market value, weighted by market value.',
    sectors,
    sources: [provenance(SCANNER + where + '/scan', found.at, { cached: found.cached })]
  };
}

/* ---------- the screener ---------- */

/* Every window the heatmap's "Colour by" picker offers (discover.js
   COLOUR_BY) must have its column requested here — Perf.3M and Perf.Y were
   missing, so choosing "Three months" or "A year" zipped every row to
   `undefined`, which reads as NaN, which paints and labels the entire map
   flat with nothing wrong printed anywhere. The picker looked broken; the
   two windows it offered were simply never fetched. */
const SCREEN_COLUMNS = ['name', 'description', 'logoid', 'close', 'change', 'volume',
  'relative_volume_10d_calc', 'market_cap_basic', 'price_earnings_ttm',
  'dividends_yield_current', 'sector', 'industry', 'country', 'currency', 'exchange',
  'Perf.W', 'Perf.1M', 'Perf.3M', 'Perf.YTD', 'Perf.Y', 'RSI', 'Recommend.All', 'recommendation_mark',
  'price_target_average', 'total_revenue_yoy_growth_ttm', 'net_margin_ttm',
  'debt_to_equity_fq', 'return_on_equity_fq', 'short_interest_percent_of_float'];

/* Filters arrive from the interface as a small, checked shape rather than as a
   query the caller composes. A field the scanner does not publish, or an
   operation that is not on this list, is refused here rather than passed
   upstream where it would come back as an opaque failure. */
const OPERATIONS = ['greater', 'egreater', 'less', 'eless', 'equal', 'nequal',
  'in_range', 'not_in_range', 'match', 'nempty', 'empty', 'crosses'];

async function screen(request) {
  const req = request || {};
  const region = REGIONS.indexOf(req.region) === -1 ? 'america' : req.region;
  const limit = Math.min(Math.max(Number(req.limit) || 50, 1), 300);

  const filter = (req.filters || [])
    .filter(f => f && f.field && OPERATIONS.indexOf(f.operation) !== -1)
    .slice(0, 12)
    .map(f => {
      const clause = { left: String(f.field), operation: f.operation };
      if (f.value !== undefined && f.value !== null) clause.right = f.value;
      return clause;
    });

  const sortBy = req.sortBy && SCREEN_COLUMNS.indexOf(req.sortBy) !== -1 ? req.sortBy : 'market_cap_basic';
  const body = {
    filter,
    options: { lang: 'en' },
    columns: SCREEN_COLUMNS,
    sort: { sortBy, sortOrder: req.sortOrder === 'asc' ? 'asc' : 'desc' },
    range: [0, limit]
  };
  if (region === 'global') body.markets = req.markets && req.markets.length ? req.markets.slice(0, 30) : MARKETS;
  if (req.types && req.types.length) {
    body.filter.push({ left: 'type', operation: 'in_range', right: req.types.slice(0, 6) });
  }

  const found = await scan(region, body, 60 * 1000);
  return {
    region,
    total: found.total,
    columns: SCREEN_COLUMNS,
    rows: found.rows.map(row => zip(row, SCREEN_COLUMNS)),
    sources: [provenance(SCANNER + region + '/scan', found.at, { cached: found.cached })]
  };
}

/* ---------- news ---------- */

/* The vendor's news flow, which is tagged by instrument and carries the
 * publisher and the instruments a story is about.
 *
 * A story marked `paywall` with permission `headline` means exactly that: the
 * headline may be shown and the body may not be read. Those are marked so the
 * interface offers a link out rather than a reader that would come back empty.
 */
async function news(options) {
  const opts = options || {};
  const filters = ['lang:en'];
  if (opts.tvSymbol) filters.push('symbol:' + opts.tvSymbol);
  if (opts.provider) filters.push('provider:' + opts.provider);

  const url = NEWS_FLOW + '?' + filters.map(f => 'filter=' + encodeURIComponent(f)).join('&') +
    '&client=' + (opts.tvSymbol ? 'overview' : 'landing') + '&streaming=false';

  const res = await http.json(url, { cacheMs: CACHE_NEWS });
  const items = ((res.data && res.data.items) || []).map(item => ({
    id: item.id,
    title: item.title,
    publishedAt: Number(item.published) * 1000,
    publisher: (item.provider && item.provider.name) || 'Unknown',
    publisherLogo: (item.provider && item.provider.logo_id) || null,
    urgency: item.urgency,
    readable: !(item.paywall && item.permission === 'headline'),
    link: item.storyPath ? 'https://www.tradingview.com' + item.storyPath : null,
    symbols: (item.relatedSymbols || []).map(s => ({ tvSymbol: s.symbol, logo: s.logoid || null }))
  }));

  return {
    items,
    sources: [provenance(url, res.at, { cached: res.cached })]
  };
}

/* The body of one story. Returned as a document tree rather than as markup, so
   the text is extracted here and nothing a publisher wrote reaches the interface
   as HTML. */
async function story(id) {
  const url = NEWS_STORY + '?id=' + encodeURIComponent(String(id || '')) + '&lang=en';
  const res = await http.json(url, { cacheMs: CACHE_REFERENCE });
  const doc = res.data || {};
  const text = flatten(doc.astDescription).trim();

  return {
    id,
    title: doc.title || null,
    summary: doc.shortDescription || null,
    text: text || null,
    publishedAt: doc.published ? Number(doc.published) * 1000 : null,
    publisher: (doc.provider && doc.provider.name) || null,
    link: doc.storyPath ? 'https://www.tradingview.com' + doc.storyPath : null,
    sources: [provenance(url, res.at, { cached: res.cached })]
  };
}

/* The document tree is nodes with children, where a leaf is a plain string.
   Block-level nodes become paragraphs; everything else joins inline. */
const BLOCK = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'li', 'blockquote', 'tr', 'div']);

function flatten(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(flatten).join('');

  const inner = Array.isArray(node.children) ? node.children.map(flatten).join('') : '';
  if (node.type === 'br') return '\n';
  return BLOCK.has(node.type) ? inner + '\n\n' : inner;
}

/* ---------- symbol translation ---------- */

/* Exchange suffixes, in both directions.
 *
 * The venue vocabulary marks a listing with a suffix; the vendor marks it with a
 * prefix. Both tables are written out rather than derived, because there is no
 * rule connecting them and an inferred prefix would silently draw a different
 * company's chart. */
const SUFFIX_TO_EXCHANGE = {
  L: 'LSE', DE: 'XETR', F: 'FWB', PA: 'EURONEXT', AS: 'EURONEXT', BR: 'EURONEXT',
  LS: 'EURONEXT', MI: 'MIL', MC: 'BME', SW: 'SIX', VI: 'VIE', ST: 'OMXSTO',
  HE: 'OMXHEX', CO: 'OMXCOP', OL: 'EURONEXT', IR: 'EURONEXT', WA: 'GPW',
  AT: 'ATHEX', IS: 'BIST', TO: 'TSX', V: 'TSXV', NE: 'NEO', AX: 'ASX',
  NZ: 'NZX', T: 'TSE', HK: 'HKEX', SS: 'SSE', SZ: 'SZSE', TW: 'TWSE',
  KS: 'KRX', KQ: 'KRX', SI: 'SGX', KL: 'MYX', JK: 'IDX', BK: 'SET',
  NS: 'NSE', BO: 'BSE', SA: 'BMFBOVESPA', MX: 'BMV', BA: 'BCBA',
  SN: 'BCS', TA: 'TASE', JO: 'JSE', CA: 'EGX', SR: 'TADAWUL'
};

const EXCHANGE_TO_SUFFIX = (() => {
  const out = {};
  /* The first suffix listed for an exchange wins the reverse mapping, so a
     venue reachable by two suffixes resolves to the primary one. */
  Object.keys(SUFFIX_TO_EXCHANGE).forEach(suffix => {
    const exchange = SUFFIX_TO_EXCHANGE[suffix];
    if (!out[exchange]) out[exchange] = suffix;
  });
  return out;
})();

/* United States venues carry no suffix at all. */
const US_EXCHANGES = new Set(['NASDAQ', 'NYSE', 'AMEX', 'BATS', 'CBOE', 'OTC', 'ARCA']);

/* Instruments whose two vocabularies share nothing at all. Written out because
   there are few of them and every one is a symbol a trader types by hand. */
const FIXED = {
  '^GSPC': 'SP:SPX', '^DJI': 'DJ:DJI', '^IXIC': 'NASDAQ:IXIC', '^NDX': 'NASDAQ:NDX',
  '^RUT': 'TVC:RUT', '^VIX': 'CBOE:VIX', '^FTSE': 'FTSE:UKX', '^GDAXI': 'XETR:DAX',
  '^FCHI': 'EURONEXT:PX1', '^STOXX50E': 'TVC:SX5E', '^N225': 'TVC:NI225',
  '^HSI': 'TVC:HSI', '^AXJO': 'ASX:XJO', '^BSESN': 'BSE:SENSEX', '^NSEI': 'NSE:NIFTY',
  '^TNX': 'TVC:US10Y', '^TYX': 'TVC:US30Y', '^FVX': 'TVC:US05Y', '^IRX': 'TVC:US03MY',
  'GC=F': 'COMEX:GC1!', 'SI=F': 'COMEX:SI1!', 'HG=F': 'COMEX:HG1!',
  'CL=F': 'NYMEX:CL1!', 'BZ=F': 'NYMEX:BZ1!', 'NG=F': 'NYMEX:NG1!',
  'ZC=F': 'CBOT:ZC1!', 'ZW=F': 'CBOT:ZW1!', 'ZS=F': 'CBOT:ZS1!',
  'ES=F': 'CME_MINI:ES1!', 'NQ=F': 'CME_MINI:NQ1!', 'YM=F': 'CBOT_MINI:YM1!',
  'RTY=F': 'CME_MINI:RTY1!', 'DX-Y.NYB': 'TVC:DXY'
};

const FIXED_BACK = (() => {
  const out = {};
  Object.keys(FIXED).forEach(symbol => { out[FIXED[symbol]] = symbol; });
  return out;
})();

/* Venue symbol to vendor symbol.
 *
 * Returns null for a plain ticker with no suffix, because that is a United
 * States listing whose exchange is not written down anywhere in the symbol —
 * the caller resolves those through the search, which knows. */
function toVendor(symbol) {
  const s = String(symbol || '').trim().toUpperCase();
  if (!s) return null;
  if (FIXED[s]) return FIXED[s];

  if (s.endsWith('=X')) {
    const pair = s.slice(0, -2);
    return 'FX:' + (pair.length === 3 ? 'USD' + pair : pair);
  }
  if (/-(USD|USDT|GBP|EUR|BTC|ETH)$/.test(s)) return 'CRYPTO:' + s.replace('-', '');

  const dot = s.lastIndexOf('.');
  if (dot > 0) {
    const suffix = s.slice(dot + 1);
    const exchange = SUFFIX_TO_EXCHANGE[suffix];
    if (exchange) return exchange + ':' + s.slice(0, dot).replace(/-/g, '.');
  }

  return null;
}

/* Vendor symbol to venue symbol. Returns null where this application's price
   source has no listing for it, which the interface reports rather than hides:
   an instrument can be charted from the vendor and still have no venue quote. */
function toVenue(tvSymbol) {
  const s = String(tvSymbol || '').trim().toUpperCase();
  if (!s) return null;
  if (FIXED_BACK[s]) return FIXED_BACK[s];

  const colon = s.indexOf(':');
  if (colon === -1) return null;
  const exchange = s.slice(0, colon);
  const ticker = s.slice(colon + 1);

  if (US_EXCHANGES.has(exchange)) return ticker.replace(/\./g, '-');
  if (exchange === 'FX' || exchange === 'FX_IDC' || exchange === 'OANDA') return ticker + '=X';
  if (exchange === 'CRYPTO' || exchange === 'BITSTAMP' || exchange === 'COINBASE' || exchange === 'BINANCE') {
    const quote = ['USDT', 'USD', 'GBP', 'EUR', 'BTC', 'ETH'].find(q => ticker.endsWith(q));
    return quote ? ticker.slice(0, -quote.length) + '-' + (quote === 'USDT' ? 'USD' : quote) : null;
  }

  const suffix = EXCHANGE_TO_SUFFIX[exchange];
  if (suffix) return ticker.replace(/\./g, '-') + '.' + suffix;
  return null;
}

/* Which scanner region holds a vendor symbol. The regional endpoints answer
   faster than the global one and the global one does not carry every column. */
function regionFor(tvSymbol) {
  const exchange = String(tvSymbol || '').split(':')[0].toUpperCase();
  if (US_EXCHANGES.has(exchange) || exchange === 'SP' || exchange === 'DJ') return 'america';
  if (exchange === 'FX' || exchange === 'FX_IDC' || exchange === 'OANDA') return 'forex';
  if (['CRYPTO', 'BINANCE', 'COINBASE', 'BITSTAMP', 'KRAKEN', 'BYBIT', 'OKX'].indexOf(exchange) !== -1) return 'crypto';
  return 'global';
}

/* The venue symbol resolved to a vendor symbol, using the search where the
   symbol does not carry its exchange. Cached in memory: a resolution never
   changes within a session and the search behind it is a real request. */
const resolved = new Map();

async function resolve(symbol) {
  const s = String(symbol || '').trim().toUpperCase();
  if (!s) return null;

  const direct = toVendor(s);
  if (direct) return direct;
  if (resolved.has(s)) return resolved.get(s);

  const found = await search(s, { limit: 20 }).catch(() => null);
  const candidates = (found && found.matches) || [];

  /* THE ONLY CERTAIN ANSWER IS ONE THAT TRANSLATES BACK. A candidate whose
     vendor symbol converts to exactly the venue symbol asked about is the same
     listing by construction. Anything else is a ticker that happens to match,
     and this application has already learned what a guessed exchange prefix
     does: it draws a different company's chart under the right name. */
  const roundTrip = candidates.find(m => toVenue(m.tvSymbol) === s);
  const answer = roundTrip ? roundTrip.tvSymbol : null;
  resolved.set(s, answer);
  return answer;
}

module.exports = {
  name: NAME, label: LABEL,
  search, detail, peers, sectorPerformance, screen, news, story, logos,
  toVendor, toVenue, resolve, regionFor,
  analystScale, technicalScale, queryTerms, rankMatches, flatten, zip,
  MARKETS, SEARCH_SCOPES, SCREEN_COLUMNS, DETAIL_COLUMNS, SUFFIX_TO_EXCHANGE, FIXED
};
