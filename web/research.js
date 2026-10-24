'use strict';
/* The instrument research panel and the news screen.
 *
 * The right-hand column used to hold a quote: open, previous close, volume, bid,
 * ask. That is what the price already says. This is what the reference terminals
 * put beside a chart instead — what the company is, what it is valued at, what
 * it earns, what analysts have published about it, when it next reports, and
 * what is being written about it today.
 *
 * THREE RULES HOLD FOR EVERY FIGURE ON THIS SCREEN.
 *
 *   A MISSING FIGURE IS AN EM DASH, NEVER A ZERO. Whole blocks are absent for
 *   an index, a currency pair or a fund, and a nought in a valuation column
 *   reads as a company worth nothing rather than as a question nobody asked.
 *
 *   REPORTED FIGURES ARE NOT CURRENT FIGURES. Everything under Financials and
 *   Earnings was filed, and the panel says when it was retrieved and which
 *   period it covers. The price at the top of the same column is a different
 *   kind of number with its own state, and the two are never blended.
 *
 *   THE REPORTING CURRENCY IS NOT ALWAYS THE TRADING CURRENCY. A London listing
 *   quotes in pence and reports in dollars. Revenue is labelled with the
 *   currency the accounts were filed in, not the one the shares trade in.
 */

(function () {

  const num = window.T.num;
  const clock = window.T.clock;

  let ctx = null;
  function install(context) { ctx = context; }

  const esc = text => String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const TABS = [
    ['overview', 'Overview'],
    ['technicals', 'Technicals'],
    ['financials', 'Financials'],
    ['earnings', 'Earnings'],
    ['analysts', 'Analysts'],
    ['profile', 'Profile'],
    ['news', 'News'],
    ['sources', 'Sources']
  ];

  const DASH = '<span class="muted">—</span>';

  /* ---------- formatting ---------- */

  /* Ratios arrive from the source as fractions — a margin of 24% is 0.24 — and
     the shared percentage formatter expects the number already in percentage
     units. Converting in one named place stops a figure being shown a hundred
     times too small. */
  function ratioPct(fraction, digits) {
    const value = num.num(fraction);
    if (value === null) return DASH;
    return '<span>' + esc(num.pct(value * 100, digits == null ? 2 : digits)) + '</span>';
  }

  function signedRatioPct(fraction) {
    const value = num.num(fraction);
    if (value === null) return DASH;
    return '<span class="' + num.signOf(value) + '">' + esc(num.pct(value * 100)) + '</span>';
  }

  function big(value, currency) {
    if (num.num(value) === null) return DASH;
    return esc(num.compact(value) + (currency ? ' ' + currency : ''));
  }

  function ratio(value, digits) {
    const n = num.num(value);
    if (n === null) return DASH;
    return esc(num.plain(n, digits == null ? 2 : digits));
  }

  function count(value) {
    if (num.num(value) === null) return DASH;
    return esc(num.compact(value, 0));
  }

  /* Dates arrive two ways: a timestamp from the summary source, and a plain
     ISO day from a filing, which has no time of day and must not be given one
     by a timezone conversion. */
  function plainDate(value) {
    if (!value) return null;
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [y, m, d] = value.split('-').map(Number);
      value = Date.UTC(y, m - 1, d);
    }
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    try {
      return new Intl.DateTimeFormat('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
      }).format(new Date(ms));
    } catch (e) {
      return null;
    }
  }

  function whenDate(value) {
    const text = plainDate(value);
    return text ? esc(text) : DASH;
  }

  function priceOf(model, value) {
    if (!model || num.num(value) === null) return DASH;
    return esc(num.money(value, {
      currency: model.currency,
      assetClass: model.assetClass,
      decimals: model.priceHint == null ? undefined : model.priceHint
    }));
  }

  function rows(list) {
    return '<div class="kv">' + list.filter(Boolean).map(([k, v, hint]) =>
      '<div class="kv-row"' + (hint ? ' title="' + esc(hint) + '"' : '') + '>' +
      '<span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>').join('') + '</div>';
  }

  function label(text) {
    return '<div class="section-label">' + esc(text) + '</div>';
  }

  /* ---------- tabs ---------- */

  function tabsHtml(active) {
    return TABS.map(([id, text]) =>
      '<button class="side-tab' + (id === active ? ' on' : '') + '" data-act="detail-tab" ' +
      'data-tab="' + id + '">' + esc(text) + '</button>').join('');
  }

  /* ---------- the panel ---------- */

  /* Each tab knows whether it needs the reference payload. Overview, sources
     and news are drawn without it, so switching to one of those never waits on
     a request that the operator did not ask for. */
  const NEEDS_FUNDAMENTALS = { financials: true, earnings: true, analysts: true, profile: true, overview: true };

  async function render(tab, model, host) {
    if (!model) { host.innerHTML = '<div class="loading">Loading…</div>'; return; }

    if (tab === 'news') return renderNews(model, host);
    if (tab === 'sources') return ctx.renderSources();
    if (tab === 'technicals') return renderTechnicals(model, host);

    let data = null;
    if (NEEDS_FUNDAMENTALS[tab]) {
      const held = ctx.fundamentalsFor(model.symbol);
      if (held === undefined) {
        /* Overview has plenty to show from the quote alone, so it is painted
           first and filled in when the reference data lands. A spinner over a
           panel that already has content to show is a worse answer than the
           content. */
        if (tab === 'overview') host.innerHTML = overviewHtml(model, null);
        else host.innerHTML = '<div class="loading">Loading…</div>';
        try {
          data = await ctx.loadFundamentals(model.symbol);
        } catch (err) {
          if (tab === 'overview') { host.innerHTML = overviewHtml(model, null) + unavailable(err.message); return; }
          host.innerHTML = unavailable(err.message);
          return;
        }
        /* The operator may have moved on while that was in flight. */
        if (ctx.activeSymbol() !== model.symbol || ctx.activeTab() !== tab) return;
      } else {
        data = held;
      }
    }

    if (tab === 'overview') paintOverview(model, host, data);
    else if (tab === 'financials') host.innerHTML = financialsHtml(data);
    else if (tab === 'earnings') host.innerHTML = earningsHtml(data, model);
    else if (tab === 'analysts') host.innerHTML = analystsHtml(data, model);
    else if (tab === 'profile') host.innerHTML = profileHtml(data);
  }

  /* Painted at once from whatever is already held — the quote is never
     waited on — then topped up as the technical reading and the newest
     headline land, neither of which Overview normally fetches for itself.
     Both are read from the same caches the Technicals and News tabs keep, so
     opening this tab does not spend a request an operator already paid for
     on another tab, and visiting either of those after Overview costs
     nothing further either. */
  function paintOverview(model, host, data) {
    const paint = () => {
      host.innerHTML = overviewHtml(model, data, ctx.referenceFor(model.symbol), ctx.newsFor(model.symbol),
        ctx.filingsFor(model.symbol));
    };
    paint();

    const stillHere = () => ctx.activeSymbol() === model.symbol && ctx.activeTab() === 'overview';

    if (ctx.referenceFor(model.symbol) === undefined) {
      ctx.loadReference(model.symbol).then(() => { if (stillHere()) paint(); }).catch(() => {});
    }
    if (ctx.newsFor(model.symbol) === undefined) {
      ctx.loadNews(model.symbol).then(() => { if (stillHere()) paint(); }).catch(() => {});
    }
    if (ctx.filingsFor(model.symbol) === undefined) {
      ctx.loadFilings(model.symbol).then(() => { if (stillHere()) paint(); }).catch(() => {});
    }
  }

  function unavailable(message) {
    return '<div class="note-line">' + esc(message) + '</div>';
  }

  function gistHtml(sentences) {
    return sentences.length ? '<div class="tab-gist"><p>' + sentences.join(' ') + '</p></div>' : '';
  }

  /* Free, code-composed reads for the tabs that did not have one — the same
     philosophy as keyFactsHtml on Overview, built from figures the panel
     below already shows rather than from a model call, so it is there the
     instant the tab opens. */
  function technicalsGistHtml(model, r, f) {
    const sentences = [];
    if (r.technicalSummary && r.technicalSummary.available) {
      sentences.push('The vendor\'s technical summary reads ' + esc(r.technicalSummary.label.toLowerCase()) + '.');
    }
    const last = model.quote && model.quote.last;
    const sma50 = num.num(f.SMA50);
    const sma200 = num.num(f.SMA200);
    if (num.num(last) !== null && (sma50 !== null || sma200 !== null)) {
      const parts = [];
      if (sma50 !== null) parts.push((last > sma50 ? 'above' : 'below') + ' its 50 day average');
      if (sma200 !== null) parts.push((last > sma200 ? 'above' : 'below') + ' its 200 day average');
      sentences.push('Price is ' + parts.join(' and ') + '.');
    }
    const rsi = num.num(f.RSI);
    if (rsi !== null) {
      const read = rsi >= 70 ? 'overbought' : rsi <= 30 ? 'oversold' : 'neutral';
      sentences.push('RSI is ' + esc(num.plain(rsi, 1)) + ', reading ' + read + '.');
    }
    return gistHtml(sentences);
  }

  function financialsGistHtml(f) {
    const sentences = [];
    const growth = num.num(f.revenueGrowth);
    if (growth !== null) {
      sentences.push('Revenue ' + (growth >= 0 ? 'grew' : 'fell') + ' ' +
        esc(num.pct(Math.abs(growth) * 100, 1)) + ' year on year.');
    }
    const margin = num.num(f.profitMargins);
    if (margin !== null) sentences.push('Profit margin is ' + esc(num.pct(margin * 100, 1)) + '.');
    return gistHtml(sentences);
  }

  function earningsGistHtml(e) {
    const sentences = [];
    const nextDateText = plainDate(e.nextDate);
    if (nextDateText) {
      sentences.push('Next reports ' + esc(nextDateText) + (e.nextDateEstimated ? ', provisionally.' : '.'));
    }
    const withSurprise = (e.quarterly || []).filter(row => num.num(row.surprisePct) !== null);
    const latest = withSurprise[withSurprise.length - 1];
    if (latest) {
      sentences.push('Last quarter ' + (latest.surprisePct >= 0 ? 'beat' : 'missed') + ' estimates by ' +
        esc(num.pct(Math.abs(latest.surprisePct), 1)) + '.');
    }
    return gistHtml(sentences);
  }

  function analystsGistHtml(model, a) {
    const sentences = [];
    const lean = analystLeanSentence(a);
    if (lean) sentences.push(lean);
    const target = analystTargetSentence(model, a);
    if (target) sentences.push(target);
    return gistHtml(sentences);
  }

  /* ---------- technicals ----------
   *
   * The block this application could not build before, because nothing free
   * published it: the analyst consensus and where the price sits against the
   * targets, the vendor's own technical summary, performance over every window,
   * and what insiders have actually filed.
   *
   * TWO SCALES THAT RUN IN OPPOSITE DIRECTIONS SIT ON THIS PANEL, so each one
   * says which it is. The analyst consensus runs one to five with one meaning
   * buy; the technical summary runs minus one to one with positive meaning
   * bullish, and it is arithmetic over indicators rather than anybody's opinion.
   * Showing them side by side without saying so would be actively misleading. */
  async function renderTechnicals(model, host) {
    const held = ctx.referenceFor(model.symbol);
    if (held === undefined) host.innerHTML = '<div class="loading">Reading the consensus…</div>';

    const [reference, insider] = await Promise.all([
      held !== undefined ? Promise.resolve(held)
        : ctx.loadReference(model.symbol).catch(err => ({ available: false, reason: err.message })),
      ctx.call('market:insider', { symbol: model.symbol, limit: 12 }).catch(() => null)
    ]);

    if (ctx.activeSymbol() !== model.symbol || ctx.activeTab() !== 'technicals') return;

    if (!reference || !reference.available) {
      host.innerHTML = unavailable(reference && reference.reason
        ? reference.reason
        : 'No reference data could be read for this instrument.');
      return;
    }

    const f = reference.figures;
    const r = reference.reading;

    host.innerHTML =
      technicalsGistHtml(model, r, f) +
      label('Analysts') +
      (r.analystConsensus.available
        ? rows([
          ['Consensus', '<span class="verdict ' + verdictClass(r.analystConsensus.label) + '">' +
            esc(r.analystConsensus.label) + '</span>'],
          ['Rating', ratio(r.analystConsensus.value, 2) + ' <span class="muted">of 5, where 1 is the most positive</span>'],
          ['Average target', priceOf(model, f.price_target_average)],
          ['Range of targets', num.num(f.price_target_low) === null ? DASH
            : priceOf(model, f.price_target_low) + ' – ' + priceOf(model, f.price_target_high)],
          ['Against the price', targetGap(model, f.price_target_average)]
        ])
        : '<div class="note-line">' + esc(r.analystConsensus.reason) + '</div>') +

      label('Technical summary') +
      '<div class="note-line subtle">Computed from oscillators and moving averages. It is arithmetic, ' +
      'not an opinion, and it runs the opposite way to the analyst scale above.</div>' +
      rows([
        ['Overall', gaugeCell(r.technicalSummary)],
        ['Moving averages', gaugeCell(r.movingAverages)],
        ['Oscillators', gaugeCell(r.oscillators)]
      ]) +

      label('Readings') +
      rows([
        ['RSI (14)', ratio(f.RSI, 1)],
        ['20 day average', priceOf(model, f.SMA20) + against(model, f.SMA20)],
        ['50 day average', priceOf(model, f.SMA50) + against(model, f.SMA50)],
        ['200 day average', priceOf(model, f.SMA200) + against(model, f.SMA200)],
        ['Average true range', priceOf(model, f.ATR) + volatilityNote(model, f.ATR)]
      ]) +

      label('Performance') +
      performanceHtml(f) +

      label('Ownership') +
      rows([
        ['Free float', num.num(f.float_shares_percent_current) === null ? DASH
          : esc(num.pct(f.float_shares_percent_current)) + ' <span class="muted">of shares</span>'],
        ['Shares outstanding', count(f.total_shares_outstanding_fundamental)],
        ['Short interest', num.num(f.short_interest_percent_of_float) === null ? DASH
          : esc(num.pct(f.short_interest_percent_of_float)) + ' <span class="muted">of float</span>']
      ]) +

      insiderHtml(insider, model) +
      '<div class="stamp">Consensus, summary and performance from the reference vendor. ' +
      'Insider transactions from the regulator\'s own filings.</div>';
  }

  function verdictClass(text) {
    const value = String(text || '').toLowerCase();
    if (value.indexOf('buy') !== -1) return 'up';
    if (value.indexOf('sell') !== -1) return 'down';
    return 'flat';
  }

  function gaugeCell(reading) {
    if (!reading || !reading.available) return DASH;
    return '<span class="verdict ' + verdictClass(reading.label) + '">' + esc(reading.label) + '</span>' +
      ' <span class="muted">' + esc(num.plain(reading.value, 2)) + '</span>';
  }

  /* How far the price is from a level, as a percentage, which is the form the
     question is actually asked in. */
  function against(model, level) {
    const last = model.quote && model.quote.last;
    const value = num.num(level);
    if (value === null || num.num(last) === null || !value) return '';
    const gap = ((last - value) / value) * 100;
    return ' <span class="' + num.signOf(gap) + '">' + esc(num.pct(gap, 1)) + '</span>';
  }

  function targetGap(model, target) {
    const last = model.quote && model.quote.last;
    const value = num.num(target);
    if (value === null || num.num(last) === null || !last) return DASH;
    const gap = ((value - last) / last) * 100;
    return '<span class="' + num.signOf(gap) + '">' + esc(num.pct(gap, 1)) + '</span>' +
      ' <span class="muted">' + (gap >= 0 ? 'above' : 'below') + ' the current price</span>';
  }

  function volatilityNote(model, atr) {
    const last = model.quote && model.quote.last;
    const value = num.num(atr);
    if (value === null || num.num(last) === null || !last) return '';
    return ' <span class="muted">' + esc(num.pct((value / last) * 100, 1)) + ' of price</span>';
  }

  const WINDOWS = [
    ['Perf.W', 'A week'], ['Perf.1M', 'A month'], ['Perf.3M', 'Three months'],
    ['Perf.6M', 'Six months'], ['Perf.YTD', 'Year to date'], ['Perf.Y', 'A year'],
    ['Perf.5Y', 'Five years']
  ];

  function performanceHtml(figures) {
    const values = WINDOWS.map(([key, text]) => ({ text, value: num.num(figures[key]) }))
      .filter(entry => entry.value !== null);
    if (!values.length) return '<div class="note-line">No performance history is published for this instrument.</div>';

    const largest = Math.max(...values.map(entry => Math.abs(entry.value)), 1);

    return '<div class="perf-strip">' + values.map(entry =>
      '<div class="perf-cell"><div class="perf-label">' + esc(entry.text) + '</div>' +
      '<div class="perf-value ' + num.signOf(entry.value) + '">' + esc(num.pct(entry.value, 1)) + '</div>' +
      '<div class="perf-bar"><i class="' + num.signOf(entry.value) + '" style="width:' +
      ((Math.abs(entry.value) / largest) * 100).toFixed(1) + '%"></i></div></div>').join('') + '</div>';
  }

  /* ONLY OPEN-MARKET DEALING IS PRESENTED AS A DECISION. A grant vesting, an
     option exercise and shares withheld to pay the tax on a grant are all filed
     as transactions and none of them says anything about what an executive
     thinks. They are counted, and counted separately. */
  function insiderHtml(insider, model) {
    if (!insider || !insider.found) {
      return label('Insider dealing') +
        '<div class="note-line">' + esc((insider && insider.reason) ||
          'Insider filings are only available for companies that file with the United States regulator.') + '</div>';
    }
    if (!insider.summary || !insider.transactions.length) {
      return label('Insider dealing') + '<div class="note-line">' + esc(insider.note || 'Nothing filed recently.') + '</div>';
    }

    const s = insider.summary;
    return label('Insider dealing') +
      rows([
        ['Bought on the market', s.openMarketPurchases
          ? '<span class="up">' + s.openMarketPurchases + '</span> <span class="muted">' +
            (s.openMarketPurchaseValue ? big(s.openMarketPurchaseValue, model.currency) : '') + '</span>'
          : '<span class="muted">none</span>'],
        ['Sold on the market', s.openMarketSales
          ? '<span class="down">' + s.openMarketSales + '</span> <span class="muted">' +
            (s.openMarketSaleValue ? big(s.openMarketSaleValue, model.currency) : '') + '</span>'
          : '<span class="muted">none</span>'],
        ['Grants, exercises and tax', String(s.automatic) + ' <span class="muted">not decisions</span>'],
        ['Period', s.from && s.to ? esc(s.from) + ' to ' + esc(s.to) : DASH]
      ]) +
      '<div class="insider-list">' + insider.transactions.slice(0, 8).map(t =>
        '<div class="insider-row' + (t.discretionary ? ' open-market' : '') + '">' +
        '<span class="i-date">' + esc(t.date) + '</span>' +
        '<span class="i-who">' + esc(t.person) + (t.roles.length
          ? '<span class="muted"> · ' + esc(t.roles.join(', ')) + '</span>' : '') + '</span>' +
        '<span class="i-what ' + (t.direction === 'buy' ? 'up' : 'down') + '">' + esc(t.what) + '</span>' +
        '<span class="i-size">' + count(t.shares) + (t.price ? ' @ ' + priceOf(model, t.price) : '') + '</span>' +
        '</div>').join('') + '</div>' +
      '<div class="note-line subtle">' + esc(insider.note) + '</div>';
  }

  /* Where these figures came from, under every block that shows any.
   *
   * When the vendor summary is unavailable the panel is assembled from the
   * filings themselves, and it says so — along with why, so an operator seeing
   * a thinner panel than yesterday knows it is the source that changed and not
   * the company. */
  function stamp(data) {
    if (!data) return '';

    if (data.via === 'filings') {
      const period = data.period
        ? ' Figures cover the financial year ended ' + whenDate(data.period.end) +
          (data.period.form ? ', as filed on form ' + esc(data.period.form) + '.' : '.')
        : '';
      return '<div class="stamp">Read from the company\'s own filings, retrieved ' +
        esc(clock.asOf(data.retrievedAt)) + '.' + period +
        (data.vendorUnavailable
          ? '<br>The summary source that carries ratios, targets and the earnings calendar ' +
            'is unavailable: ' + esc(data.vendorUnavailable)
          : '') + '</div>';
    }

    return '<div class="stamp">Reported figures, retrieved ' +
      esc(clock.asOf(data.retrievedAt)) + '. Not a live figure.</div>';
  }

  /* A block the current source simply does not publish. Distinct from a company
     that has no such figures — an index has no earnings, whereas a filing has
     no analyst consensus — and worth saying apart, because one is a fact about
     the instrument and the other is a fact about today's connection. */
  function notCarried(data, what) {
    if (data && data.via === 'filings') {
      return unavailable(what + ' is not in a company filing. It comes from the summary source, ' +
        'which is not answering at the moment.') + stamp(data);
    }
    return unavailable('No ' + what.toLowerCase() + ' is published for this instrument.') + stamp(data);
  }

  /* Shared by the Overview gist and the Analysts tab's own gist, so the two
     never drift into describing the same consensus two different ways. */
  function analystLeanSentence(a) {
    const trend = (a.trend || []).find(t => t.strongBuy + t.buy + t.hold + t.sell + t.strongSell > 0);
    if (trend) {
      const total = trend.strongBuy + trend.buy + trend.hold + trend.sell + trend.strongSell;
      const buys = trend.strongBuy + trend.buy;
      const sells = trend.strongSell + trend.sell;
      const lean = buys > sells && buys > trend.hold ? 'lean toward buying it'
        : sells > buys && sells > trend.hold ? 'lean toward selling it'
        : 'are split on it';
      return total + ' analyst' + (total === 1 ? '' : 's') + ' covering it ' + lean + '.';
    }
    /* The strong-buy/buy/hold/sell/strong-sell breakdown is not always
       published even when the single consensus rating behind it is — a
       scalar recommendation with no distribution behind it still says
       something, and is worth more than silence. */
    if (a.key) return 'Analysts covering it rate it a ' + esc(a.key.replace(/_/g, ' ')) + '.';
    return null;
  }

  function analystTargetSentence(model, a) {
    const last = model && model.quote ? model.quote.last : null;
    if (num.num(a.targetMean) === null || num.num(last) === null || !last) return null;
    const implied = ((a.targetMean - last) / last) * 100;
    return 'Their average target of ' + priceOf(model, a.targetMean) + ' is ' +
      esc(num.pct(Math.abs(implied))) + (implied >= 0 ? ' above' : ' below') + ' the current price.';
  }

  /* ---------- the plain-words gist, free and always there ----------
   *
   * Composed from figures already on this panel — the move today, which way
   * analyst opinion leans, their average target against the current price,
   * when it next reports — with no model call and no cost. This is the
   * difference between "SYRIX has an opinion, press the button to hear it"
   * and actually seeing something the moment the instrument opens. A blank
   * instrument (no consensus, no earnings calendar — an index, a currency
   * pair) simply carries fewer sentences rather than a placeholder saying
   * so; the price line alone is one still worth having.
   *
   * `data` here is market:fundamentals's payload (engine.fundamentals(),
   * shaped { analysts, earnings, valuation, perShare, financials, profile,
   * shares }) — the same object financialsHtml/earningsHtml/analystsHtml
   * below read from. It is not engine.reference()'s { figures, reading }
   * shape, which is a different call (market:reference) used only by
   * renderTechnicals. */
  function keyFactsHtml(model, data, reference, news, filings) {
    const quote = model.quote || {};
    const pct = num.changePct(quote.last, quote.previousClose);
    const sentences = [];

    if (pct != null && num.num(quote.last) !== null) {
      const dir = pct > 0.005 ? 'up' : pct < -0.005 ? 'down' : 'flat';
      sentences.push(esc(model.symbol) + ' is ' + dir +
        (dir === 'flat' ? '' : ' ' + esc(num.pct(Math.abs(pct)))) +
        ' today at ' + priceOf(model, quote.last) + '.');
    }

    /* A filing is the most concrete "something happened" a free source can
       carry for a company that files with the regulator, read ahead of a
       headline for exactly that reason: it names WHAT happened rather than
       who wrote about it. A 10-Q or 10-K filed in the last few days means
       the quarter everyone would ask about already reported; an 8-K is the
       form kept specifically for disclosing a material event — a deal, a
       contract, a big change — which is as close as this application gets
       to "something big just happened at the company" without guessing at
       a headline's meaning. */
    const latestFiling = filings && filings.found && filings.filings && filings.filings[0];
    const filingDate = latestFiling ? Date.parse((latestFiling.filedAt || '') + 'T00:00:00Z') : NaN;
    if (latestFiling && Number.isFinite(filingDate) && Date.now() - filingDate < 5 * 24 * 60 * 60 * 1000) {
      const when = plainDate(latestFiling.filedAt);
      sentences.push('Filed ' + esc((latestFiling.label || latestFiling.form || 'a report').toLowerCase()) +
        (when ? ' on ' + esc(when) : '') +
        (latestFiling.description ? ': ' + esc(latestFiling.description) : '') + '.');
    }

    /* Up to two headlines, not one — a single pick reads as arbitrary the
       moment more than one genuinely current story exists, and only the
       recency window is being filtered on here, not which story matters
       more. A thinly covered symbol can leave the newest story days old, and
       a stale headline dressed as today's read is a worse answer than none;
       silence is honest for a quiet instrument. */
    ((news && news.items) || [])
      .filter(item => item.publishedAt && Date.now() - item.publishedAt < 72 * 60 * 60 * 1000)
      .slice(0, 2)
      .forEach(item => {
        sentences.push('“' + esc(item.title) + '”' +
          (item.publisher ? ' — ' + esc(item.publisher) : '') +
          ', ' + esc(clock.since(item.publishedAt)) + ' ago.');
      });

    const summary = reference && reference.available && reference.reading
      ? reference.reading.technicalSummary : null;
    if (summary && summary.available) {
      sentences.push('The chart\'s own technical reading is ' + esc(summary.label.toLowerCase()) + '.');
    }

    const a = (data && data.analysts) || {};
    const lean = analystLeanSentence(a);
    if (lean) sentences.push(lean);
    const target = analystTargetSentence(model, a);
    if (target) sentences.push(target);

    const e = (data && data.earnings) || {};
    if (e.nextDate) sentences.push('Next reports ' + whenDate(e.nextDate) + '.');

    if (!sentences.length) return '';
    return '<p class="read-body">' + sentences.join(' ') + '</p>';
  }

  /* ---------- the assistant's read on this instrument ----------
   *
   * WHY THE FULL READ IS A BUTTON AND NOT SOMETHING FIRED AUTOMATICALLY. It
   * costs a full council run — the chart, the news, the accounts, the
   * consensus, the sector and the case against, each written by a specialist
   * and then checked against the evidence. Firing that off every time an
   * instrument is opened would burn the gateway's allowance on instruments
   * nobody was asking about, and would put an opinion on screen that had not
   * been asked for. keyFactsHtml above is the free, immediate part; this is
   * one press for the expensive, thorough one. */
  function readCard(model, data, reference, news, filings) {
    const facts = keyFactsHtml(model, data, reference, news, filings);
    return '<div class="read-card">' +
      '<div class="read-head"><span class="read-mark"><svg><use href="#i-syrix"></use></svg></span>' +
      '<span class="read-title">SYRIX on ' + esc(model.symbol) + '</span></div>' +
      (facts || '<p class="read-body">A full read: how it is trading across every window, what the news is ' +
        'actually saying, what the accounts and the consensus show, where it sits in its sector, and ' +
        'the case against. It comes back with a level, not a paragraph of hedging.</p>') +
      '<div class="read-actions">' +
      '<button class="btn primary" data-act="read-instrument" data-symbol="' + esc(model.symbol) + '">' +
      'Get the full read</button>' +
      '<button class="btn" data-act="ask-instrument" data-symbol="' + esc(model.symbol) + '" ' +
      'data-q="today">Why is it moving today?</button>' +
      '</div></div>';
  }

  /* ---------- overview ---------- */

  function overviewHtml(model, data, reference, news, filings) {
    const quote = model.quote || {};
    const valuation = (data && data.valuation) || {};
    const perShare = (data && data.perShare) || {};

    let html = readCard(model, data, reference, news, filings) + ctx.rangeMeters(model);

    html += label('Session') + rows([
      ['Open', priceOf(model, quote.open)],
      ['Previous close', priceOf(model, quote.previousClose)],
      ['Volume', count(quote.volume)],
      ['Bid', priceOf(model, quote.bid)],
      ['Ask', priceOf(model, quote.ask)],
      ['Spread', spreadHtml(model)]
    ]);

    if (data) {
      html += label('Valuation') + rows([
        ['Market cap', big(valuation.marketCap, data.currency)],
        ['Enterprise value', big(valuation.enterpriseValue, data.reportingCurrency)],
        ['P/E trailing', ratio(valuation.trailingPE)],
        ['P/E forward', ratio(valuation.forwardPE)],
        ['PEG', ratio(valuation.pegRatio)],
        ['Price / book', ratio(valuation.priceToBook)],
        ['Price / sales', ratio(valuation.priceToSales)],
        ['Beta', ratio(valuation.beta)]
      ]);

      html += label('Per share') + rows([
        ['EPS trailing', ratio(perShare.trailingEps)],
        ['EPS forward', ratio(perShare.forwardEps)],
        ['Book value', ratio(perShare.bookValue)],
        ['Dividend', perShare.dividendRate == null ? DASH : ratio(perShare.dividendRate)],
        ['Dividend yield', ratioPct(perShare.dividendYield)],
        ['Payout ratio', ratioPct(perShare.payoutRatio)],
        ['Ex-dividend', whenDate(perShare.exDividendDate)]
      ]);

      html += stamp(data);
    }

    html += label('This figure') + rows([
      ['Asset class', esc(model.assetClass || '—')],
      ['Currency', esc(model.currency || '—')],
      ['Venue', esc(model.exchangeName || '—')],
      ['Venue time zone', esc((model.session && model.session.tz) || '—')],
      ['Data state', esc(model.freshness ? model.freshness.label : '—'),
        model.freshness ? model.freshness.reason : ''],
      ['Stamped', esc((model.freshness && model.freshness.asOf) || '—')]
    ]);

    if (model.warnings && model.warnings.length) {
      html += label('Findings');
      model.warnings.forEach(w => { html += '<div class="finding">' + esc(w.detail) + '</div>'; });
    }

    return html;
  }

  function spreadHtml(model) {
    const spread = num.spread(model.quote.bid, model.quote.ask);
    if (spread.absolute == null) return '<span class="muted">Needs a market session</span>';
    return priceOf(model, spread.absolute) + '  <span class="muted">(' + esc(num.pct(spread.pct)) + ')</span>';
  }

  /* ---------- financials ---------- */

  function financialsHtml(data) {
    if (!data) return unavailable('No reference data for this instrument.');
    const f = data.financials || {};
    const shares = data.shares || {};
    const ccy = data.reportingCurrency;

    if (!hasAny(f)) {
      return unavailable('No financial statements are published for this instrument. ' +
        'Indices, currency pairs and most funds have none.') + stamp(data);
    }

    /* The heading names the period, because a filed year and a rolling twelve
       months are different measurements and the difference matters. */
    const filedYear = data.via === 'filings' && data.period ? plainDate(data.period.end) : null;
    const heading = filedYear
      ? 'Financial year ended ' + filedYear + (ccy ? ' · ' + ccy : '')
      : 'Trailing twelve months' + (ccy ? ' · ' + ccy : '');

    let html = financialsGistHtml(f) + label(heading) + rows([
      ['Revenue', big(f.revenue, ccy)],
      ['Gross profit', big(f.grossProfits, ccy)],
      f.operatingIncome === undefined ? null : ['Operating income', big(f.operatingIncome, ccy)],
      f.ebitda === undefined ? null : ['EBITDA', big(f.ebitda, ccy)],
      ['Net income', big(f.netIncome, ccy)],
      ['Operating cash flow', big(f.operatingCashflow, ccy)],
      f.freeCashflow === undefined ? null : ['Free cash flow', big(f.freeCashflow, ccy)],
      f.totalAssets === undefined ? null : ['Total assets', big(f.totalAssets, ccy)],
      f.totalLiabilities === undefined ? null
        : ['Total liabilities', big(f.totalLiabilities, ccy), 'As filed. Not the same thing as total debt.'],
      f.equity === undefined ? null : ['Shareholders\' equity', big(f.equity, ccy)]
    ]);

    html += label('Margins and returns') + rows([
      ['Gross margin', ratioPct(f.grossMargins)],
      ['Operating margin', ratioPct(f.operatingMargins)],
      ['Profit margin', ratioPct(f.profitMargins)],
      ['Return on equity', ratioPct(f.returnOnEquity)],
      ['Return on assets', ratioPct(f.returnOnAssets)]
    ]);

    html += label('Growth') + rows([
      ['Revenue, year on year', signedRatioPct(f.revenueGrowth)],
      ['Earnings, year on year', signedRatioPct(f.earningsGrowth)]
    ]);

    html += label('Balance sheet') + rows([
      ['Total cash', big(f.totalCash, ccy)],
      ['Total debt', big(f.totalDebt, ccy)],
      /* Published as a percentage already, unlike every other ratio in this
         block, so it is not multiplied. */
      ['Debt to equity', ratio(f.debtToEquity)],
      ['Shares outstanding', count(shares.outstanding)],
      ['Free float', count(shares.float)],
      ['Held by institutions', ratioPct(shares.heldByInstitutions, 1)],
      ['Held by insiders', ratioPct(shares.heldByInsiders, 1)],
      ['Short interest, of float', ratioPct(shares.shortOfFloat, 1)]
    ]);

    const annual = (data.earnings && data.earnings.annual) || [];
    if (annual.length) {
      html += label('By financial year' + (ccy ? ' · ' + ccy : ''));
      html += '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>Year</th><th class="num">Revenue</th><th class="num">Earnings</th></tr></thead><tbody>' +
        annual.map(row => '<tr><td>' + esc(row.period) + '</td>' +
          '<td class="num">' + big(row.revenue) + '</td>' +
          '<td class="num">' + big(row.earnings) + '</td></tr>').join('') +
        '</tbody></table></div>';
    }

    return html + stamp(data);
  }

  function hasAny(block) {
    return Object.keys(block || {}).some(key => num.num(block[key]) !== null);
  }

  /* ---------- earnings ---------- */

  function earningsHtml(data, model) {
    if (!data) return unavailable('No reference data for this instrument.');
    const e = data.earnings || {};

    let html = earningsGistHtml(e);

    if (e.nextDate) {
      html += label('Next report') +
        '<div class="next-earnings"><div class="d">' + whenDate(e.nextDate) + '</div>' +
        '<div class="s">' + (e.nextDateEstimated
          ? 'Provisional — the company has not confirmed the date.'
          : 'Scheduled.') + '</div></div>';

      if (num.num(e.estimate && e.estimate.average) !== null) {
        html += rows([
          ['Consensus EPS', ratio(e.estimate.average)],
          ['Range', num.num(e.estimate.low) === null ? DASH
            : esc(num.plain(e.estimate.low, 2) + '  to  ' + num.plain(e.estimate.high, 2))]
        ]);
      }
    }

    const quarterly = (e.quarterly || []).filter(row => row.actual != null || row.estimate != null);
    if (quarterly.length) {
      html += label('Reported against estimate');
      html += '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>Quarter</th><th class="num">Estimate</th><th class="num">Actual</th><th class="num">Surprise</th>' +
        '</tr></thead><tbody>' +
        quarterly.map(row => '<tr><td>' + esc(row.period || '—') + '</td>' +
          '<td class="num">' + ratio(row.estimate) + '</td>' +
          '<td class="num">' + ratio(row.actual) + '</td>' +
          '<td class="num">' + (row.surprisePct == null ? DASH
            : '<span class="' + num.signOf(row.surprisePct) + '">' + esc(num.pct(row.surprisePct, 1)) + '</span>') +
          '</td></tr>').join('') +
        '</tbody></table></div>';
    }

    if (!html) return notCarried(data, 'An earnings calendar');

    const perShare = data.perShare || {};
    if (perShare.dividendDate) {
      html += label('Dividend') + rows([
        ['Next payment', whenDate(perShare.dividendDate)],
        ['Ex-dividend', whenDate(perShare.exDividendDate)],
        ['Rate', perShare.dividendRate == null ? DASH : priceOf(model, perShare.dividendRate)]
      ]);
    }

    return html + stamp(data);
  }

  /* ---------- analysts ---------- */

  function analystsHtml(data, model) {
    if (!data) return unavailable('No reference data for this instrument.');
    const a = data.analysts || {};

    if (!a.count && !(a.trend || []).length && a.targetMean == null) {
      return notCarried(data, 'Analyst coverage');
    }

    let html = analystsGistHtml(model, a);

    if (a.targetMean != null) {
      const last = model && model.quote ? model.quote.last : null;
      const implied = (last != null && last !== 0) ? ((a.targetMean - last) / last) * 100 : null;

      html += label('Price target');
      html += '<div class="target">' +
        '<div class="t">' + priceOf(model, a.targetMean) + '</div>' +
        '<div class="s">mean of ' + (a.count == null ? 'the published' : esc(String(a.count))) + ' target' +
        (a.count === 1 ? '' : 's') +
        (implied == null ? '' : '  ·  <span class="' + num.signOf(implied) + '">' +
          esc(num.pct(implied, 1)) + ' from the current price</span>') + '</div>' +
        targetBar(a, last) +
        '</div>';
    }

    /* The distribution, not a single word. "Buy" is the average of a spread
       that may be almost evenly split, and the split is the information. */
    const trend = (a.trend || []).filter(t => t.strongBuy + t.buy + t.hold + t.sell + t.strongSell > 0);
    if (trend.length) {
      html += label('Recommendations');
      html += trend.slice(0, 4).map(row => {
        const total = row.strongBuy + row.buy + row.hold + row.sell + row.strongSell;
        const bar = [
          ['strong-buy', row.strongBuy], ['buy', row.buy], ['hold', row.hold],
          ['sell', row.sell], ['strong-sell', row.strongSell]
        ].map(([cls, n]) => n ? '<span class="seg-' + cls + '" style="width:' +
          ((n / total) * 100).toFixed(2) + '%" title="' + esc(n + ' ' + cls.replace('-', ' ')) + '"></span>' : '').join('');

        return '<div class="rec-row"><div class="p">' + esc(periodLabel(row.period)) +
          '<span class="muted">' + total + ' analyst' + (total === 1 ? '' : 's') + '</span></div>' +
          '<div class="rec-bar">' + bar + '</div></div>';
      }).join('');

      html += '<div class="rec-key">' +
        '<span><i class="seg-strong-buy"></i>Strong buy</span><span><i class="seg-buy"></i>Buy</span>' +
        '<span><i class="seg-hold"></i>Hold</span><span><i class="seg-sell"></i>Sell</span>' +
        '<span><i class="seg-strong-sell"></i>Strong sell</span></div>';
    }

    html += rows([
      ['Consensus', a.key ? esc(a.key.replace(/_/g, ' ')) : DASH],
      /* Stated with its scale: a mean of 2 means nothing without knowing that
         one is the most positive end. */
      ['Mean rating', a.mean == null ? DASH : ratio(a.mean) + ' <span class="muted">of 5, 1 most positive</span>'],
      ['Analysts', a.count == null ? DASH : esc(String(a.count))],
      ['Target low', priceOf(model, a.targetLow)],
      ['Target high', priceOf(model, a.targetHigh)]
    ]);

    html += '<div class="note-line">Published targets and ratings, shown as reported. ' +
      'They are other people\'s opinions, not a view this application holds.</div>';

    return html + stamp(data);
  }

  /* Where the current price sits between the lowest and highest target. */
  function targetBar(a, last) {
    if (a.targetLow == null || a.targetHigh == null || a.targetHigh <= a.targetLow) return '';
    const at = value => Math.max(0, Math.min(100, ((value - a.targetLow) / (a.targetHigh - a.targetLow)) * 100));
    return '<div class="target-bar"><div class="track">' +
      '<div class="mean" style="left:' + at(a.targetMean).toFixed(1) + '%"></div>' +
      (last == null ? '' : '<div class="now" style="left:' + at(last).toFixed(1) + '%"></div>') +
      '</div></div>';
  }

  function periodLabel(period) {
    const map = { '0m': 'This month', '-1m': 'Last month', '-2m': 'Two months ago', '-3m': 'Three months ago' };
    return map[period] || period || '—';
  }

  /* ---------- profile ---------- */

  function profileHtml(data) {
    if (!data) return unavailable('No reference data for this instrument.');
    const p = data.profile || {};

    if (!p.description && !p.sector && !p.industry && !p.company) {
      return notCarried(data, 'A company profile');
    }

    let html = '';
    if (p.description) {
      html += label('Business') + '<div class="prose">' + esc(p.description) + '</div>';
    }

    html += label('Classification') + rows([
      p.company ? ['Registrant', esc(p.company)] : null,
      ['Sector', p.sector ? esc(p.sector) : DASH],
      ['Industry', p.industry ? esc(p.industry) : DASH],
      ['Listed on', p.exchange ? esc(p.exchange) : DASH],
      ['Country', p.country ? esc(p.country) : DASH],
      ['Employees', count(p.employees)],
      /* The address is shown as text, not as a link. Nothing in this panel
         opens an outside page without the operator asking for it. */
      ['Website', p.website ? esc(p.website.replace(/^https?:\/\//, '')) : DASH]
    ]);

    /* What the company has actually filed, most recent first, each row opening
       the document itself. A claim can then be traced to the page it came from
       rather than to anybody's summary of it. */
    const filings = (data.filed && data.filed.recent) || [];
    if (filings.length) {
      html += label('Recent filings');
      html += '<div class="news-list">' + filings.map(row =>
        '<article class="news-item" data-act="open-news" data-link="' + esc(row.url || '') + '">' +
        '<div class="h">' + esc(row.label || row.form) + '</div>' +
        (row.description ? '<div class="s">' + esc(row.description) + '</div>' : '') +
        '<div class="m"><span class="pub">' + esc(row.form) + '</span>' +
        '<span class="sep"></span><span class="ago">filed ' + whenDate(row.filedAt) + '</span>' +
        (row.reportFor ? '<span class="sep"></span><span class="ago">for ' + whenDate(row.reportFor) + '</span>' : '') +
        '</div></article>').join('') + '</div>';
    }

    return html + stamp(data);
  }

  /* ---------- news ---------- */

  async function renderNews(model, host) {
    const held = ctx.newsFor(model.symbol);
    if (held === undefined) {
      host.innerHTML = '<div class="loading">Reading the feed…</div>';
      let data;
      try {
        data = await ctx.loadNews(model.symbol);
      } catch (err) {
        host.innerHTML = unavailable(err.message);
        return;
      }
      if (ctx.activeSymbol() !== model.symbol || ctx.activeTab() !== 'news') return;
      host.innerHTML = newsListHtml(data.items, model.symbol);
      return;
    }
    host.innerHTML = newsListHtml(held.items, model.symbol);
  }

  function newsListHtml(items, symbol) {
    if (!items || !items.length) {
      return unavailable('No headlines published for ' + symbol + ' in this feed.');
    }
    return '<div class="news-list">' + items.map(itemHtml).join('') + '</div>';
  }

  /* A headline carries who filed it and when, always. A story that explains a
     move has to be readable as having been filed after it. */
  function itemHtml(item) {
    return '<article class="news-item" data-act="open-news" data-link="' + esc(item.link || '') + '">' +
      '<div class="h">' + esc(item.title) + '</div>' +
      (item.summary ? '<div class="s">' + esc(item.summary) + '</div>' : '') +
      '<div class="m"><span class="pub">' + esc(item.publisher || item.feedLabel || '') + '</span>' +
      (item.publishedAt
        ? '<span class="sep"></span><span class="ago" title="' + esc(clock.asOf(item.publishedAt)) + '">' +
          esc(clock.since(item.publishedAt)) + ' ago</span>'
        : '<span class="sep"></span><span class="ago muted">undated</span>') +
      '</div></article>';
  }

  /* THE NEWS SCREEN USED TO LIVE HERE AND HAS MOVED TO web/newsroom.js. What
     was here was a filtered list of the same headlines this panel shows in the
     right-hand column, which is not what a news screen is for. The panel below
     the instrument stays: it is the headlines for THIS instrument, beside its
     chart, which is a different question from what is happening in the world. */

  window.T = window.T || {};
  window.T.research = { install, TABS, tabsHtml, render, newsListHtml, readCard, keyFactsHtml, performanceHtml };

}());
