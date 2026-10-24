'use strict';
/* Company filings and reported financials, from the regulator itself.
 *
 * This is the most citable source in the application. Everything here is a
 * figure a company reported to its regulator in a document with a date and an
 * accession number, which means a claim built on it can be checked by anyone
 * who follows the link — the difference between "revenue was 130.5 billion" and
 * "revenue was 130.5 billion, reported in the 10-K filed on 26 February 2025".
 *
 * Coverage is US filers only. A company that does not file here is absent, and
 * the answer says so rather than substituting a figure from somewhere with no
 * accession number behind it.
 *
 * The regulator's access policy requires a contact address in the user agent
 * and sets a request ceiling. Both are honoured in src/core/http.js.
 */

const http = require('../../core/http');
const { num } = require('../../core/num');

const NAME = 'sec';
const LABEL = 'SEC EDGAR';
const DATA = 'https://data.sec.gov';
const WWW = 'https://www.sec.gov';

let tickerIndex = null;

/* Ticker to filer number. The map is a single file of every filer, cached for a
   day: filers are added, but not in the middle of an afternoon. */
async function cik(symbol) {
  const wanted = String(symbol || '').trim().toUpperCase();
  if (!wanted) return null;

  if (!tickerIndex) {
    const res = await http.json(WWW + '/files/company_tickers.json', { cacheMs: 24 * 60 * 60 * 1000 });
    tickerIndex = new Map();
    Object.values(res.data || {}).forEach(row => {
      if (row && row.ticker) {
        tickerIndex.set(String(row.ticker).toUpperCase(), {
          cik: String(row.cik_str).padStart(10, '0'),
          name: row.title
        });
      }
    });
  }

  /* A share-class suffix is this application's notation, not the regulator's. */
  return tickerIndex.get(wanted) || tickerIndex.get(wanted.split('.')[0]) || null;
}

const FORM_LABEL = {
  '10-K': 'Annual report',
  '10-Q': 'Quarterly report',
  '8-K': 'Current report',
  'DEF 14A': 'Proxy statement',
  '4': 'Insider transaction',
  'S-1': 'Registration statement',
  '20-F': 'Annual report (foreign issuer)',
  '6-K': 'Report of foreign issuer'
};

/* Recent filings, newest first. */
async function filings(symbol, options) {
  const opts = options || {};
  const filer = await cik(symbol);
  if (!filer) {
    return { symbol, found: false, reason: String(symbol).toUpperCase() + ' does not file with this regulator, so there is nothing here to read.' };
  }

  const res = await http.json(DATA + '/submissions/CIK' + filer.cik + '.json', { cacheMs: 60 * 60 * 1000 });
  const data = res.data || {};
  const recent = (data.filings && data.filings.recent) || {};

  const wanted = opts.forms ? new Set(opts.forms.map(f => f.toUpperCase())) : null;
  const out = [];
  const count = (recent.accessionNumber || []).length;

  for (let i = 0; i < count && out.length < (opts.limit || 15); i++) {
    const form = recent.form[i];
    if (wanted && !wanted.has(String(form).toUpperCase())) continue;
    const accession = recent.accessionNumber[i];
    const plain = accession.replace(/-/g, '');
    out.push({
      form,
      label: FORM_LABEL[form] || form,
      filedAt: recent.filingDate[i],
      reportFor: recent.reportDate[i] || null,
      accession,
      /* The document itself, so a claim can be traced to the page it came
         from rather than to a summary of it. */
      url: WWW + '/Archives/edgar/data/' + Number(filer.cik) + '/' + plain + '/' + recent.primaryDocument[i],
      description: recent.primaryDocDescription[i] || null
    });
  }

  return {
    symbol: String(symbol).toUpperCase(),
    found: true,
    company: data.name || filer.name,
    cik: filer.cik,
    exchange: (data.exchanges || [])[0] || null,
    sic: data.sicDescription || null,
    filings: out,
    provenance: {
      provider: NAME, providerLabel: LABEL,
      endpoint: 'submissions', retrievedAt: res.at, cached: res.cached
    }
  };
}

/* The tags a plain-English request maps onto. A company may report under any of
   the alternatives, so each is tried in turn rather than assuming one. */
const CONCEPTS = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'],
  netIncome: ['NetIncomeLoss'],
  grossProfit: ['GrossProfit'],
  operatingIncome: ['OperatingIncomeLoss'],
  assets: ['Assets'],
  liabilities: ['Liabilities'],
  equity: ['StockholdersEquity'],
  cash: ['CashAndCashEquivalentsAtCarryingValue'],
  operatingCashFlow: ['NetCashProvidedByUsedInOperatingActivities'],
  researchAndDevelopment: ['ResearchAndDevelopmentExpense'],
  eps: ['EarningsPerShareDiluted', 'EarningsPerShareBasic'],
  sharesOutstanding: ['CommonStockSharesOutstanding', 'EntityCommonStockSharesOutstanding']
};

/* A reported figure over time, each observation carrying the filing it came
 * from.
 *
 * Only annual and quarterly periods are kept, and duplicates for the same
 * period are collapsed to the most recently filed — a figure is commonly
 * restated, and reporting both without saying which is current is how two
 * different revenues for one year end up in the same answer. */
async function concept(symbol, name, options) {
  const opts = options || {};
  const filer = await cik(symbol);
  if (!filer) {
    return { symbol, found: false, reason: String(symbol).toUpperCase() + ' does not file with this regulator.' };
  }

  const tags = CONCEPTS[name] || [name];
  let payload = null;
  let usedTag = null;
  let freshest = '';

  /* EVERY ALTERNATIVE IS TRIED AND THE ONE STILL IN USE WINS.
   *
   * Stopping at the first tag that answers picks whichever alternative happens
   * to be listed first, and a filer that moved from one tag to another years
   * ago still answers under the old one — with the figures it was reporting
   * when it stopped. That produced a revenue history for a company that ended
   * four years before the present, presented as current. The tag carrying the
   * most recent observation is the tag the filer actually uses now. */
  for (const tag of tags) {
    try {
      const res = await http.json(
        DATA + '/api/xbrl/companyconcept/CIK' + filer.cik + '/us-gaap/' + encodeURIComponent(tag) + '.json',
        { cacheMs: 12 * 60 * 60 * 1000 });
      if (!res.data || !res.data.units) continue;

      const units = res.data.units;
      const rows = units[Object.keys(units)[0]] || [];
      const newest = rows.reduce((most, row) =>
        (row && row.end && String(row.end) > most ? String(row.end) : most), '');

      if (!payload || newest > freshest) { payload = res; usedTag = tag; freshest = newest; }
    } catch (err) {
      /* This company does not report under that tag; try the next. */
    }
  }

  if (!payload) {
    return {
      symbol: String(symbol).toUpperCase(), found: false,
      reason: 'This filer does not report ' + name + ' under any of the tags checked (' + tags.join(', ') + ').'
    };
  }

  const units = payload.data.units;
  const unit = Object.keys(units)[0];
  const rows = units[unit] || [];

  const byPeriod = new Map();
  rows.forEach(row => {
    if (!row.form || !/^10-[KQ]/.test(row.form)) return;
    const key = (row.fy || '') + '|' + (row.fp || '') + '|' + row.end;
    const existing = byPeriod.get(key);
    /* The later filing supersedes the earlier one for the same period. */
    if (!existing || String(row.filed) > String(existing.filed)) byPeriod.set(key, row);
  });

  const observations = Array.from(byPeriod.values())
    .sort((a, b) => (a.end < b.end ? 1 : -1))
    .slice(0, opts.limit || 12)
    .map(row => ({
      value: num(row.val),
      unit,
      fiscalYear: row.fy,
      fiscalPeriod: row.fp,
      periodStart: row.start || null,
      periodEnd: row.end,
      form: row.form,
      filedAt: row.filed,
      accession: row.accn,
      /* Everything needed to check the figure at source. */
      url: WWW + '/Archives/edgar/data/' + Number(filer.cik) + '/' +
        String(row.accn).replace(/-/g, '') + '/' + String(row.accn) + '-index.htm'
    }));

  return {
    symbol: String(symbol).toUpperCase(),
    found: true,
    company: filer.name,
    concept: name,
    tag: usedTag,
    unit,
    observations,
    provenance: {
      provider: NAME, providerLabel: LABEL,
      endpoint: 'xbrl/companyconcept', tag: usedTag,
      retrievedAt: payload.at, cached: payload.cached
    }
  };
}

/* Full-text search across filings, for finding where a company said something
   rather than what it reported numerically. */
async function fullText(query, options) {
  const opts = options || {};
  const params = new URLSearchParams({ q: String(query || '').slice(0, 200) });
  if (opts.forms) params.set('forms', opts.forms.join(','));

  const res = await http.json('https://efts.sec.gov/LATEST/search-index?' + params.toString(), {
    cacheMs: 30 * 60 * 1000
  });

  const hits = (res.data && res.data.hits && res.data.hits.hits) || [];
  return {
    query,
    total: (res.data && res.data.hits && res.data.hits.total && res.data.hits.total.value) || 0,
    results: hits.slice(0, opts.limit || 8).map(hit => {
      const source = hit._source || {};
      const id = String(hit._id || '');
      const [accession, document] = id.split(':');
      const filerCik = (source.ciks || [])[0];
      return {
        company: (source.display_names || [])[0] || null,
        form: source.file_type || source.root_form || null,
        filedAt: source.file_date || null,
        url: filerCik
          ? WWW + '/Archives/edgar/data/' + Number(filerCik) + '/' +
            String(accession).replace(/-/g, '') + '/' + (document || '')
          : null
      };
    }),
    provenance: { provider: NAME, providerLabel: LABEL, endpoint: 'full-text search', retrievedAt: res.at }
  };
}

/* ---------- insider dealing ---------- */

/* WHAT AN INSIDER TRANSACTION CODE MEANS, AND WHY THE DISTINCTION IS THE WHOLE
 * POINT OF READING THESE AT ALL.
 *
 * "Insiders sold $40m of stock last month" is the single most misleading
 * sentence in market commentary, because the overwhelming majority of insider
 * disposals are neither a decision nor a signal. A grant vests; shares are
 * withheld automatically to pay the tax on it; an option is exercised and sold
 * the same day under a plan filed months earlier. All of those are filed as
 * disposals and none of them says anything about what the executive thinks.
 *
 * What does say something is an OPEN-MARKET PURCHASE — code P — where somebody
 * with better information than anyone else chose to spend their own money, and
 * an open-market SALE — code S — that is not part of an automatic plan.
 *
 * So the two are counted separately and reported separately, and a summary that
 * merges them is not produced at all. */
const TRANSACTION_CODE = {
  P: { label: 'Open-market purchase', discretionary: true, direction: 'buy' },
  S: { label: 'Open-market sale', discretionary: true, direction: 'sell' },
  A: { label: 'Grant or award', discretionary: false, direction: 'buy' },
  M: { label: 'Option exercise', discretionary: false, direction: 'buy' },
  F: { label: 'Shares withheld for tax', discretionary: false, direction: 'sell' },
  D: { label: 'Disposition to the issuer', discretionary: false, direction: 'sell' },
  G: { label: 'Gift', discretionary: false, direction: 'sell' },
  C: { label: 'Conversion', discretionary: false, direction: 'buy' },
  X: { label: 'Option exercised in the money', discretionary: false, direction: 'buy' }
};

function firstTag(block, name) {
  const match = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + name + '>', 'i').exec(block);
  return match ? match[1].trim() : null;
}

/* The filing wraps most fields in a <value> element inside a named one, and
   omits the wrapper on others. Both shapes are read. */
function fieldValue(block, name) {
  const outer = firstTag(block, name);
  if (outer == null) return null;
  const inner = firstTag(outer, 'value');
  return (inner == null ? outer : inner).trim() || null;
}

function parseForm4(xml, filing) {
  const owner = firstTag(xml, 'reportingOwner') || '';
  const relationship = firstTag(owner, 'reportingOwnerRelationship') || '';
  const roles = [];
  if (firstTag(relationship, 'isDirector') === '1') roles.push('Director');
  if (firstTag(relationship, 'isOfficer') === '1') roles.push(firstTag(relationship, 'officerTitle') || 'Officer');
  if (firstTag(relationship, 'isTenPercentOwner') === '1') roles.push('10% owner');

  const person = firstTag(owner, 'rptOwnerName');
  const table = firstTag(xml, 'nonDerivativeTable') || '';
  const blocks = table.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/gi) || [];

  return blocks.map(block => {
    const code = fieldValue(block, 'transactionCode');
    const shares = Number(fieldValue(block, 'transactionShares'));
    const price = Number(fieldValue(block, 'transactionPricePerShare'));
    const meaning = TRANSACTION_CODE[String(code || '').toUpperCase()] || null;

    return {
      person: person || 'Unnamed',
      roles,
      date: fieldValue(block, 'transactionDate') || filing.reportFor || filing.filedAt,
      code: code || null,
      what: meaning ? meaning.label : 'Unrecognised code ' + code,
      discretionary: meaning ? meaning.discretionary : false,
      direction: meaning ? meaning.direction : null,
      shares: Number.isFinite(shares) ? shares : null,
      price: Number.isFinite(price) && price > 0 ? price : null,
      value: Number.isFinite(shares) && Number.isFinite(price) && price > 0 ? shares * price : null,
      heldAfter: Number(fieldValue(block, 'sharesOwnedFollowingTransaction')) || null,
      filing: filing.url
    };
  });
}

async function insider(symbol, options) {
  const opts = options || {};
  const found = await filings(symbol, { forms: ['4'], limit: Math.min(Number(opts.limit) || 14, 30) });
  if (!found.found) return found;
  if (!found.filings.length) {
    return { symbol: found.symbol, found: true, transactions: [], summary: null,
      note: 'No insider transaction has been filed for this company recently.' };
  }

  const documents = await Promise.all(found.filings.map(async filing => {
    /* The address in the index points at the regulator's rendered version of the
       document. The machine-readable original sits beside it, one directory up
       from the stylesheet folder. */
    const raw = filing.url.replace(/\/xslF345X\d+\//, '/');
    try {
      const res = await http.text(raw, { cacheMs: 24 * 60 * 60 * 1000, accept: 'application/xml, text/xml' });
      return parseForm4(res.data, filing);
    } catch (err) {
      return [];
    }
  }));

  const transactions = [].concat(...documents)
    .filter(t => t.shares)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const open = transactions.filter(t => t.discretionary);
  const bought = open.filter(t => t.direction === 'buy');
  const sold = open.filter(t => t.direction === 'sell');
  const total = list => list.reduce((sum, t) => sum + (t.value || 0), 0);

  return {
    symbol: found.symbol,
    found: true,
    company: found.company,
    transactions: transactions.slice(0, 40),
    summary: {
      filings: found.filings.length,
      from: transactions.length ? transactions[transactions.length - 1].date : null,
      to: transactions.length ? transactions[0].date : null,
      openMarketPurchases: bought.length,
      openMarketPurchaseValue: total(bought) || null,
      openMarketSales: sold.length,
      openMarketSaleValue: total(sold) || null,
      /* Everything that was not a decision, counted so it can be excluded from
         the reading rather than silently dropped from the record. */
      automatic: transactions.length - open.length
    },
    note: 'Only open-market purchases and sales reflect a decision. Grants, option exercises and ' +
      'shares withheld to pay tax on a grant are filed as transactions and are counted separately.',
    provenance: found.provenance
  };
}

module.exports = {
  name: NAME, label: LABEL, cik, filings, concept, fullText, insider,
  CONCEPTS, TRANSACTION_CODE, parseForm4
};
