'use strict';
/* What the research assistant can do.
 *
 * This is the complete list. It is a general assistant, not a market-only one:
 * it answers ordinary questions, looks things up on the web, reads pages, and
 * checks claims — and it happens to have a market terminal underneath it. A
 * question about headphones and a question about a semiconductor company go
 * through the same loop.
 *
 * PERMISSIONS ARE ENUMERATED, NOT IMPLIED. Everything here reads. Nothing here
 * writes, places an order, or touches a credential. That is a property of the
 * list rather than a rule the model is asked to follow, and a test asserts it.
 *
 * TOOL NAMES ARE ENGLISH PHRASES rather than API verbs, because they are shown
 * to the operator while the assistant is working: "Searching the web" reads as
 * progress; "invoke_search_v2" reads as a leak.
 */

const websearch = require('./websearch');
const sec = require('../market/providers/sec');
const worldnews = require('../market/providers/worldnews');
const indicators = require('../analysis/indicators');
const { num, changePct } = require('../core/num');
const clock = require('../core/clock');
const positions = require('../portfolio/positions');
const valuation = require('../portfolio/valuation');
const journal = require('../portfolio/journal');
const riskEngine = require('../portfolio/risk');
const { BOOK } = require('../portfolio/ledger');

/* The declarations sent to the model. */
const DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'search_the_web',
      description: 'Search the web for anything at all — news, general knowledge, how something works, ' +
        'what happened recently. Use this whenever the answer depends on something you cannot be sure of ' +
        'from memory, or on anything after your training. Returns page titles, snippets and links.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What to search for, in plain words.' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_a_page',
      description: 'Open a web page and read its text. Use this after searching when a snippet is not enough, ' +
        'or when the user gives you a link. Always read a page before quoting a figure from it.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The full web address.' } },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'look_up_a_topic',
      description: 'Get an encyclopedia summary of a person, place, company, concept or event. ' +
        'Faster and more reliable than a web search for definitional questions.',
      parameters: {
        type: 'object',
        properties: { topic: { type: 'string' } },
        required: ['topic']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_the_time',
      description: 'The current date and time, and which major markets are open right now. ' +
        'Use this before saying anything about what is happening today or recently.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_a_price',
      description: 'The current price of any instrument — a share, an index, a currency pair, a commodity, ' +
        'a cryptocurrency. Returns the price, the change, the range, when the venue stamped it and how ' +
        'fresh it is.',
      parameters: {
        type: 'object',
        properties: { symbol: { type: 'string', description: 'A ticker such as NVDA, HSBA.L, ^GSPC, GC=F, EURUSD=X or BTC-USD.' } },
        required: ['symbol']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_an_instrument',
      description: 'Find the ticker for a company or asset by name, when you do not already know it.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'price_history',
      description: 'How an instrument has moved over a period, with its trend, momentum, volatility and ' +
        'volume compared to normal. Use this instead of guessing whether something is up or down.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          range: { type: 'string', description: '1d, 5d, 1mo, 3mo, 6mo, 1y or 5y. Defaults to 3mo.' }
        },
        required: ['symbol']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'company_filings',
      description: 'What a US-listed company has filed with its regulator — annual and quarterly reports, ' +
        'current reports, insider transactions — with dates and links to the documents.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          forms: { type: 'string', description: 'Optional, comma separated, such as "10-K,10-Q".' }
        },
        required: ['symbol']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'reported_figure',
      description: 'A figure a US-listed company actually reported to its regulator, over time, each one ' +
        'linked to the filing it came from. Use this for any claim about revenue, profit, cash or similar — ' +
        'it is the only source here that can be checked at the document.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          figure: {
            type: 'string',
            description: 'revenue, netIncome, grossProfit, operatingIncome, assets, liabilities, equity, ' +
              'cash, operatingCashFlow, researchAndDevelopment, eps or sharesOutstanding.'
          }
        },
        required: ['symbol', 'figure']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'analyst_view',
      description: 'What analysts and the technical readings say about an instrument: the consensus ' +
        'rating, the average price target and the spread between the high and low targets, the vendor\'s ' +
        'technical summary, the moving averages, performance over every window, the next reporting date, ' +
        'the free float and the short interest. Covers instruments worldwide, not only United States ones.',
      parameters: {
        type: 'object',
        properties: { symbol: { type: 'string' } },
        required: ['symbol']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'insider_dealing',
      description: 'What company insiders have actually filed. Open-market purchases and sales are ' +
        'reported separately from grants, option exercises and shares withheld to pay tax, because only ' +
        'the first two are decisions. United States filers only.',
      parameters: {
        type: 'object',
        properties: { symbol: { type: 'string' } },
        required: ['symbol']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'sector_and_peers',
      description: 'The sector an instrument belongs to, how every sector in that market is trading, ' +
        'and the comparable companies with their own moves and multiples. Use this to tell whether a move ' +
        'belongs to the company or to the whole sector.',
      parameters: {
        type: 'object',
        properties: { symbol: { type: 'string' } },
        required: ['symbol']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_news',
      description: 'Search news worldwide for any keyword — a company, a ticker, a commodity, a person, ' +
        'a policy. Covers publishers in every country, not only the financial press. Returns headlines ' +
        'with the publisher and when it was filed.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_article',
      description: 'Read a news article in full from its address. Use this after searching the news when ' +
        'a headline matters enough to need the detail behind it.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'screen_the_market',
      description: 'Find instruments matching numeric conditions — market value, multiples, growth, ' +
        'performance, relative volume, short interest. Give the conditions as a list. Use this for ' +
        '"which companies are…" questions rather than answering from memory.',
      parameters: {
        type: 'object',
        properties: {
          region: { type: 'string', description: 'america, global, crypto or forex. Defaults to america.' },
          conditions: {
            type: 'string',
            description: 'Conditions, one per line, as "field operation value". Fields include ' +
              'market_cap_basic, price_earnings_ttm, dividends_yield_current, total_revenue_yoy_growth_ttm, ' +
              'net_margin_ttm, return_on_equity_fq, RSI, relative_volume_10d_calc, ' +
              'short_interest_percent_of_float, Perf.1M, Perf.YTD, close, volume. ' +
              'Operations: greater, less, equal, in_range, nempty. Example: "market_cap_basic greater 1000000000".'
          },
          sortBy: { type: 'string' },
          limit: { type: 'number' }
        },
        required: ['conditions']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'my_portfolio',
      description: 'The user\'s own holdings and what they are worth now. Say which book: "mirror" for ' +
        'their real holdings entered by hand, or "paper" for the simulated account.',
      parameters: {
        type: 'object',
        properties: { book: { type: 'string', description: 'mirror or paper. Defaults to mirror.' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'my_trading_record',
      description: 'The user\'s closed trades and what the record shows — win rate, expectancy, average ' +
        'win and loss, drawdown, and which setups and instruments have gone well or badly.',
      parameters: {
        type: 'object',
        properties: { book: { type: 'string', description: 'mirror or paper. Defaults to mirror.' } }
      }
    }
  }
];

/* A phrase for the step list while a tool is running. Shown to the operator, so
   thirty seconds of named steps reads as working rather than as broken. */
function describe(name, args) {
  const a = args || {};
  switch (name) {
    case 'search_the_web': return 'Searching the web for “' + String(a.query || '').slice(0, 60) + '”';
    case 'read_a_page': return 'Reading ' + (websearch.domainOf(a.url) || 'a page');
    case 'look_up_a_topic': return 'Looking up ' + String(a.topic || '').slice(0, 50);
    case 'check_the_time': return 'Checking the time and which markets are open';
    case 'get_a_price': return 'Getting the price of ' + String(a.symbol || '').toUpperCase();
    case 'find_an_instrument': return 'Finding the ticker for ' + String(a.name || '').slice(0, 40);
    case 'price_history': return 'Reading ' + String(a.symbol || '').toUpperCase() + ' price history';
    case 'company_filings': return 'Checking what ' + String(a.symbol || '').toUpperCase() + ' has filed';
    case 'reported_figure': return 'Reading ' + String(a.symbol || '').toUpperCase() + '’s reported ' + (a.figure || 'figures');
    case 'analyst_view': return 'Checking the consensus on ' + String(a.symbol || '').toUpperCase();
    case 'insider_dealing': return 'Reading ' + String(a.symbol || '').toUpperCase() + ' insider filings';
    case 'sector_and_peers': return 'Reading the sector around ' + String(a.symbol || '').toUpperCase();
    case 'search_news': return 'Searching the news for “' + String(a.query || '').slice(0, 50) + '”';
    case 'read_article': return 'Reading ' + (websearch.domainOf(a.url) || 'an article');
    case 'screen_the_market': return 'Screening the market';
    case 'my_portfolio': return 'Reading your portfolio';
    case 'my_trading_record': return 'Reading your trading record';
    default: return 'Working';
  }
}

/* The noun phrase for the "Checked:" line printed under every answer. */
function sourceLabel(name, args) {
  const a = args || {};
  switch (name) {
    case 'search_the_web': return 'a web search';
    case 'read_a_page': return websearch.domainOf(a.url) || 'a web page';
    case 'look_up_a_topic': return 'Wikipedia';
    case 'check_the_time': return 'the clock';
    case 'get_a_price': return 'the price of ' + String(a.symbol || '').toUpperCase();
    case 'find_an_instrument': return 'a symbol lookup';
    case 'price_history': return String(a.symbol || '').toUpperCase() + ' price history';
    case 'company_filings': return String(a.symbol || '').toUpperCase() + '’s filings';
    case 'reported_figure': return String(a.symbol || '').toUpperCase() + '’s reported figures';
    case 'analyst_view': return 'the consensus on ' + String(a.symbol || '').toUpperCase();
    case 'insider_dealing': return String(a.symbol || '').toUpperCase() + '’s insider filings';
    case 'sector_and_peers': return 'the sector around ' + String(a.symbol || '').toUpperCase();
    case 'search_news': return 'a news search';
    case 'read_article': return websearch.domainOf(a.url) || 'a news article';
    case 'screen_the_market': return 'a market screen';
    case 'my_portfolio': return 'your portfolio';
    case 'my_trading_record': return 'your trading record';
    default: return name;
  }
}

/* ---------- dispatch ---------- */

async function run(context, name, args) {
  const a = args || {};
  switch (name) {
    case 'search_the_web': return searchWeb(a);
    case 'read_a_page': return readPage(a);
    case 'look_up_a_topic': return lookUp(a);
    case 'check_the_time': return theTime();
    case 'get_a_price': return getPrice(context, a);
    case 'find_an_instrument': return findInstrument(context, a);
    case 'price_history': return priceHistory(context, a);
    case 'company_filings': return companyFilings(a);
    case 'reported_figure': return reportedFigure(a);
    case 'analyst_view': return analystView(context, a);
    case 'insider_dealing': return insiderDealing(a);
    case 'sector_and_peers': return sectorAndPeers(context, a);
    case 'search_news': return searchNews(a);
    case 'read_article': return readArticle(a);
    case 'screen_the_market': return screenTheMarket(context, a);
    case 'my_portfolio': return myPortfolio(context, a);
    case 'my_trading_record': return myRecord(context, a);
    default: return { error: 'There is no tool called ' + name + '.' };
  }
}

async function analystView(context, a) {
  try {
    const found = await context.engine.reference(a.symbol);
    if (!found.available) return { symbol: a.symbol, available: false, reason: found.reason };

    const f = found.figures;
    return {
      symbol: found.symbol,
      listing: found.tvSymbol,
      analystConsensus: found.reading.analystConsensus,
      priceTarget: {
        average: f.price_target_average,
        high: f.price_target_high,
        low: f.price_target_low,
        median: f.price_target_median,
        note: 'A wide spread between the high and the low means the outcome is disputed, which says ' +
          'more than the average does.'
      },
      technicalSummary: found.reading.technicalSummary,
      movingAverageSummary: found.reading.movingAverages,
      oscillatorSummary: found.reading.oscillators,
      readings: { rsi: f.RSI, sma20: f.SMA20, sma50: f.SMA50, sma200: f.SMA200, atr: f.ATR },
      valuation: {
        marketCap: f.market_cap_basic, priceEarnings: f.price_earnings_ttm,
        priceSales: f.price_sales_current, priceBook: f.price_book_fq,
        enterpriseValue: f.enterprise_value_current, beta: f.beta_1_year
      },
      performancePercent: {
        week: f['Perf.W'], month: f['Perf.1M'], threeMonths: f['Perf.3M'],
        sixMonths: f['Perf.6M'], yearToDate: f['Perf.YTD'], year: f['Perf.Y'], fiveYears: f['Perf.5Y']
      },
      ownership: {
        freeFloatPercent: f.float_shares_percent_current,
        sharesOutstanding: f.total_shares_outstanding_fundamental,
        shortInterestPercentOfFloat: f.short_interest_percent_of_float
      },
      nextEarnings: f.earnings_release_next_date
        ? new Date(Number(f.earnings_release_next_date) * 1000).toISOString().slice(0, 10) : null,
      nextEarningsNote: f.earnings_release_next_date
        ? 'This is the vendor\'s own estimate of the next reporting date, not a confirmation from the ' +
          'company. It can move without notice — say "expected" rather than stating it as settled.'
        : null,
      sector: f.sector,
      industry: f.industry,
      note: 'These are the vendor\'s published figures. The consensus scale runs 1 strong buy to 5 ' +
        'strong sell; the technical summary runs -1 to 1 and is arithmetic over indicators, not an opinion.'
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function insiderDealing(a) {
  try {
    return await sec.insider(a.symbol, { limit: 14 });
  } catch (err) {
    return { error: err.message };
  }
}

async function sectorAndPeers(context, a) {
  try {
    const [peers, sectors] = await Promise.all([
      context.engine.peers(a.symbol, { limit: 10 }).catch(err => ({ peers: [], reason: err.message })),
      context.engine.sectors().catch(err => ({ sectors: [], reason: err.message }))
    ]);
    return {
      symbol: String(a.symbol).toUpperCase(),
      group: peers.group || null,
      sector: peers.sector || null,
      peers: (peers.peers || []).map(p => ({
        symbol: p.ticker, name: p.description, changePercent: p.change,
        monthPercent: p['Perf.1M'], yearToDatePercent: p['Perf.YTD'],
        marketCap: p.market_cap_basic, priceEarnings: p.price_earnings_ttm
      })),
      everySector: sectors.sectors || [],
      sectorBasis: sectors.basis || null,
      note: 'Compare the instrument\'s own move with its sector before calling it company specific.'
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function searchNews(a) {
  try {
    const found = await worldnews.search(a.query, { limit: 24 });
    return {
      query: found.query,
      stories: found.items.map(item => ({
        title: item.title,
        publisher: item.publisher,
        at: item.publishedAt ? new Date(item.publishedAt).toISOString() : null,
        country: item.country || null,
        url: item.link,
        /* Named so the model does not try to open one that cannot be opened. */
        readable: !item.external
      })),
      unavailable: found.unavailable,
      note: 'These are headlines. Open one with read_article before quoting anything from inside it.'
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function readArticle(a) {
  try {
    const article = await worldnews.read(a.url);
    if (!article.available) {
      return { url: article.url, domain: article.domain, title: article.title, available: false, reason: article.reason };
    }
    return {
      url: article.url, domain: article.domain, title: article.title,
      byline: article.byline,
      publishedAt: article.publishedAt ? new Date(article.publishedAt).toISOString() : null,
      text: article.text.slice(0, 6000),
      truncated: article.text.length > 6000,
      retrievedAt: new Date(article.retrievedAt).toISOString()
    };
  } catch (err) {
    return { error: err.message };
  }
}

/* Conditions arrive as lines of text because that is what a model writes
   reliably. They are parsed here into the checked shape the provider takes, and
   a line that does not parse is reported rather than dropped — a screen missing
   one of its conditions answers a different question from the one asked. */
function screenTheMarket(context, a) {
  const lines = String(a.conditions || '').split('\n').map(line => line.trim()).filter(Boolean);
  const filters = [];
  const rejected = [];

  lines.forEach(line => {
    const parts = line.replace(/^[-*]\s*/, '').split(/\s+/);
    if (parts.length < 2) { rejected.push(line); return; }
    const field = parts[0];
    const operation = parts[1];
    const rest = parts.slice(2).join(' ');
    const value = rest === '' ? undefined
      : (rest.indexOf(',') !== -1 ? rest.split(',').map(v => Number(v.trim())) : Number(rest));
    if (rest !== '' && (Array.isArray(value) ? value.some(v => !Number.isFinite(v)) : !Number.isFinite(value))) {
      rejected.push(line);
      return;
    }
    filters.push({ field, operation, value });
  });

  if (!filters.length) {
    return { error: 'No condition could be read from: ' + lines.join('; ') };
  }

  return context.engine.screen({
    region: a.region,
    filters,
    sortBy: a.sortBy,
    limit: Math.min(Number(a.limit) || 25, 60)
  }).then(result => ({
    region: result.region,
    matched: result.total,
    shown: result.rows.length,
    conditionsIgnored: rejected,
    results: result.rows.map(row => ({
      symbol: row.ticker, name: row.description, last: row.close,
      changePercent: row.change, marketCap: row.market_cap_basic,
      priceEarnings: row.price_earnings_ttm, monthPercent: row['Perf.1M'],
      yearToDatePercent: row['Perf.YTD'], sector: row.sector, country: row.country
    }))
  })).catch(err => ({ error: err.message }));
}

async function searchWeb(a) {
  const found = await websearch.search(a.query, { limit: 6 });
  if (!found.results.length) return { query: found.query, results: [], note: found.note };
  return {
    query: found.query,
    engine: found.engine,
    results: found.results.map(r => ({ title: r.title, url: r.url, snippet: r.snippet.slice(0, 300) })),
    /* Stated so the model does not treat a snippet as a read page. */
    note: 'These are search snippets, not the pages themselves. Open a page before quoting a figure from it.'
  };
}

async function readPage(a) {
  try {
    const page = await websearch.readPage(a.url, { limit: 5000 });
    return {
      url: page.url, title: page.title, domain: page.domain,
      text: page.text, truncated: page.truncated,
      retrievedAt: new Date(page.retrievedAt).toISOString()
    };
  } catch (err) {
    return { error: 'That page could not be read: ' + err.message };
  }
}

async function lookUp(a) {
  const found = await websearch.wikipedia(a.topic);
  if (!found) return { topic: a.topic, found: false, note: 'No encyclopedia article matched that.' };
  return {
    title: found.title, summary: found.extract, url: found.url,
    retrievedAt: new Date(found.retrievedAt).toISOString(),
    note: 'This is a tertiary source that anyone can edit. For anything contested, check it against a primary source.'
  };
}

function theTime() {
  const now = Date.now();
  const venues = [
    ['London', 'Europe/London'], ['New York', 'America/New_York'],
    ['Tokyo', 'Asia/Tokyo'], ['Frankfurt', 'Europe/Berlin'], ['Hong Kong', 'Asia/Hong_Kong']
  ];
  return {
    utc: new Date(now).toISOString(),
    local: clock.asOf(now, 'Europe/London') + ' in London',
    markets: venues.map(([name, tz]) => ({
      venue: name,
      localTime: clock.asOf(now, tz),
      status: clock.describe(clock.statusAt({ tz }, now))
    })),
    note: 'Session status here is from opening hours and the weekday only. There is no holiday calendar, ' +
      'so a market closed for a public holiday will still read as open.'
  };
}

async function getPrice(context, a) {
  try {
    const model = await context.engine.quote(a.symbol);
    return {
      symbol: model.symbol,
      name: model.name,
      assetClass: model.assetClass,
      currency: model.currency,
      venue: model.exchangeName,
      price: model.quote.last,
      previousClose: model.quote.previousClose,
      changePercent: changePct(model.quote.last, model.quote.previousClose),
      dayHigh: model.quote.dayHigh,
      dayLow: model.quote.dayLow,
      yearHigh: model.quote.yearHigh,
      yearLow: model.quote.yearLow,
      volume: model.quote.volume,
      /* The two fields that decide whether this figure may be described as
         current. Both travel with it so the answer can say so. */
      stampedAt: model.quote.at ? new Date(model.quote.at).toISOString() : null,
      dataState: model.freshness.label,
      dataStateReason: model.freshness.reason,
      source: model.provenance.providerLabel,
      /* `price` above is the regular session's last print, which is a
         different fact from this when the venue is currently in one of
         these sessions — not a competing version of the same figure. When
         it is current, it is the more current one and should be preferred
         for "where does this trade now" or "where would you get in". */
      preOrPostMarket: (model.quote.extended && model.quote.extended.freshness &&
        (model.quote.extended.freshness.state === 'LIVE' || model.quote.extended.freshness.state === 'DELAYED'))
        ? {
          session: model.quote.extended.state,
          price: model.quote.extended.price,
          changePercent: model.quote.extended.changePercent,
          stampedAt: model.quote.extended.at ? new Date(model.quote.extended.at).toISOString() : null,
          note: 'This is more current than `price` above — the venue is in this session right now.'
        } : null
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function findInstrument(context, a) {
  try {
    const results = await context.engine.search(a.name, { limit: 6 });
    return { query: a.name, matches: results.map(r => ({ symbol: r.symbol, name: r.name, assetClass: r.assetClass, venue: r.exchange })) };
  } catch (err) {
    return { error: err.message };
  }
}

/* Price history summarised rather than dumped.
 *
 * Several hundred bars of raw numbers would fill the model's context and be
 * read badly. What comes back is what the bars mean: the move, the range,
 * where the price sits within it, the trend measures and how volume compares to
 * its own average. */
async function priceHistory(context, a) {
  try {
    const range = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '5y'].includes(a.range) ? a.range : '3mo';
    const chart = await context.engine.chart(a.symbol, { range });
    const bars = chart.bars;
    if (bars.length < 2) return { error: 'Not enough history for ' + a.symbol + ' over ' + range + '.' };

    const first = bars[0];
    const last = bars[bars.length - 1];
    const closes = bars.map(b => b.c);
    const high = Math.max(...bars.map(b => b.h));
    const low = Math.min(...bars.map(b => b.l));

    const ma50 = indicators.latest(indicators.sma(closes, 50));
    const ma200 = indicators.latest(indicators.sma(closes, 200));
    const rsi = indicators.latest(indicators.rsi(closes, 14));
    const atr = indicators.latest(indicators.atr(bars, 14));
    const relVolume = indicators.latest(indicators.relativeVolume(bars, 20));

    return {
      symbol: chart.symbol,
      range,
      timeframe: chart.timeframe,
      bars: bars.length,
      from: new Date(first.t).toISOString().slice(0, 10),
      to: new Date(last.t).toISOString().slice(0, 10),
      openedAt: first.o,
      latest: last.c,
      changePercent: changePct(last.c, first.o),
      periodHigh: high,
      periodLow: low,
      positionInRange: high > low ? ((last.c - low) / (high - low)) * 100 : null,
      movingAverage50: ma50,
      movingAverage200: ma200,
      /* Described rather than judged: where price sits relative to its averages
         is a fact; what to do about it is not. */
      aboveMovingAverage50: ma50 === null ? null : last.c > ma50,
      aboveMovingAverage200: ma200 === null ? null : last.c > ma200,
      rsi14: rsi,
      averageTrueRange14: atr,
      volumeVersusAverage: relVolume,
      note: 'These are measurements. They describe what price has done, not what it will do.'
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function companyFilings(a) {
  try {
    const forms = a.forms ? String(a.forms).split(',').map(f => f.trim()).filter(Boolean) : null;
    return await sec.filings(a.symbol, { forms, limit: 12 });
  } catch (err) {
    return { error: err.message };
  }
}

async function reportedFigure(a) {
  try {
    const out = await sec.concept(a.symbol, a.figure, { limit: 10 });
    if (out.found) {
      out.note = 'Every figure here is what the company reported to its regulator, with the filing it ' +
        'came from. Quote the period and link the filing.';
    }
    return out;
  } catch (err) {
    return { error: err.message };
  }
}

function bookOf(name) {
  const wanted = String(name || '').toLowerCase();
  if (wanted === 'paper') return BOOK.PAPER;
  if (wanted === 'imported') return BOOK.IMPORTED;
  return BOOK.MIRROR;
}

async function myPortfolio(context, a) {
  if (!context.ledger) return { error: 'No portfolio is available.' };
  const book = bookOf(a.book);
  const built = positions.build(context.ledger.ordered(book));
  const open = built.filter(p => p.open);

  if (!open.length) {
    return { book, holdings: [], note: 'There are no open holdings in the ' + book + ' book.' };
  }

  /* Priced from whatever the engine already holds, so asking about the
     portfolio does not fire a burst of requests. */
  const quotes = new Map();
  await Promise.all(open.map(async p => {
    try { quotes.set(p.symbol, await context.engine.quote(p.symbol)); } catch (e) { /* left unpriced */ }
  }));

  const valuedBook = valuation.value({
    book, positions: built, quotes,
    accountCurrency: context.accountCurrency || 'GBP',
    cash: context.ledger.cash(book),
    fxRates: context.fxRates || {}
  });

  const exposure = riskEngine.exposure(valuedBook);

  return {
    book,
    /* Carried into the answer so a hand-entered total is never described as
       broker-confirmed. */
    caveat: valuedBook.caveat,
    accountCurrency: valuedBook.accountCurrency,
    holdings: valuedBook.holdings.map(h => ({
      symbol: h.symbol, name: h.name, quantity: h.quantity,
      averageEntry: h.averageEntry, last: h.last,
      marketValue: h.marketValue, unrealised: h.unrealised, unrealisedPercent: h.unrealisedPct,
      weightPercent: h.weight, currency: h.quoteCurrency || h.currency,
      dataState: h.freshness ? h.freshness.label : null,
      problem: h.problem
    })),
    totals: valuedBook.totals,
    perCurrency: valuedBook.byCurrency,
    dataState: valuedBook.freshness.label,
    complete: valuedBook.complete,
    incompleteNote: valuedBook.incompleteNote,
    rateNote: valuedBook.rateNote,
    concentration: exposure.usable ? {
      largest: exposure.largest,
      topThreePercent: exposure.concentration.topThreeWeight,
      effectiveHoldings: exposure.concentration.effectiveHoldings,
      foreignCurrencyPercent: exposure.foreignCurrencyWeight
    } : { unavailable: exposure.reason }
  };
}

async function myRecord(context, a) {
  if (!context.ledger || !context.journal) return { error: 'No trading record is available.' };
  const book = bookOf(a.book);
  const built = positions.build(context.ledger.ordered(book));
  const entries = context.journal.entries(positions.closedTrades(built));
  const stats = journal.statistics(entries);

  if (stats.empty) return { book, note: 'There are no closed trades in the ' + book + ' book yet.' };

  const groups = journal.groupings(entries, context.timeZone || 'Europe/London');
  return {
    book,
    trades: stats.count,
    wins: stats.wins,
    losses: stats.losses,
    winRatePercent: stats.winRate,
    netProfit: stats.net,
    averageWin: stats.averageWin,
    averageLoss: stats.averageLoss,
    expectancy: stats.expectancy,
    expectancyNote: stats.expectancyNote,
    profitFactor: stats.profitFactor,
    profitFactorNote: stats.profitFactorNote,
    maxDrawdown: stats.maxDrawdown,
    rMultiple: stats.rMultiple,
    longestWinningStreak: stats.streaks.longestWinning,
    longestLosingStreak: stats.streaks.longestLosing,
    bySymbol: groups.bySymbol.slice(0, 8),
    bySetup: groups.bySetup.slice(0, 8),
    byTag: groups.byTag.slice(0, 8),
    note: 'Groups marked thin have fewer than five trades in them. A striking percentage over three trades ' +
      'is three trades, not a finding.'
  };
}

module.exports = { DEFINITIONS, run, describe, sourceLabel };
