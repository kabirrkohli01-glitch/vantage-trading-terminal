'use strict';
/* The bottom panel, the order ticket, and the portfolio and journal screens.
 *
 * Everything drawn here comes from the engines in the main process. Nothing is
 * computed twice: a win rate, a market value and a reward-to-risk figure are
 * each produced in one place and rendered here, so a screen cannot disagree
 * with the record behind it.
 *
 * THE CAVEAT BELONGING TO A BOOK IS DRAWN WITH ITS TOTALS, ALWAYS. A hand-
 * entered portfolio is real money that no broker has confirmed, and a paper
 * account is not money at all. Both facts sit beside the figures rather than in
 * a help page somewhere.
 */

(function () {

  const num = window.T.num;
  const clock = window.T.clock;

  let ctx = null;
  function install(context) { ctx = context; }

  const esc = text => String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const state = { book: 'mirror', journalBook: 'mirror', portfolio: null, journal: null };

  const BOOKS = [['mirror', 'My holdings'], ['paper', 'Paper'], ['imported', 'From broker']];

  function money(value, currency, decimals) {
    return num.money(value, { currency: currency || 'GBP', assetClass: 'EQUITY', decimals });
  }

  function signed(value, currency) {
    if (value == null) return '<span class="muted">—</span>';
    return '<span class="' + num.signOf(value) + '">' +
      esc(num.change(value, { currency: currency || 'GBP', assetClass: 'EQUITY' })) + '</span>';
  }

  function pct(value) {
    if (value == null) return '<span class="muted">—</span>';
    return '<span class="' + num.signOf(value) + '">' + esc(num.pct(value)) + '</span>';
  }

  function card(key, value, sub) {
    return '<div class="card"><div class="k">' + esc(key) + '</div><div class="v">' + value + '</div>' +
      (sub ? '<div class="s">' + esc(sub) + '</div>' : '') + '</div>';
  }

  function bookTabs(active, action) {
    return BOOKS.map(([key, label]) =>
      '<button class="book-tab' + (key === active ? ' on' : '') + '" data-act="' + action +
      '" data-book="' + key + '">' + esc(label) + '</button>').join('');
  }

  function fieldHtml(label, control) {
    return '<div class="field"><label>' + esc(label) + '</label>' + control + '</div>';
  }

  const emptyBlock = (big, detail) =>
    '<div class="empty"><div class="big">' + esc(big) + '</div><div>' + esc(detail) + '</div></div>';

  /* ============================== bottom panel ============================== */

  function bottomPanel(tab, data) {
    const currency = data.currency || 'GBP';

    if (tab === 'positions') {
      if (!data.positions.length) {
        return emptyBlock('No open positions',
          'Place a paper order from the ticket on the right and it will appear here.');
      }
      return '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>Symbol</th><th>Side</th><th class="num">Qty</th><th class="num">Avg price</th>' +
        '<th class="num">Last</th><th class="num">P&amp;L</th><th class="num">P&amp;L%</th>' +
        '<th class="num">Value</th><th class="num">Actions</th></tr></thead><tbody>' +
        data.positions.map(p => '<tr>' +
          '<td class="mono">' + esc(p.symbol) + '</td>' +
          '<td class="' + (p.quantity >= 0 ? 'up' : 'down') + '">' + (p.quantity >= 0 ? 'Long' : 'Short') + '</td>' +
          '<td class="num">' + esc(String(Math.abs(p.quantity))) + '</td>' +
          '<td class="num">' + esc(money(p.averageEntry, p.currency)) + '</td>' +
          '<td class="num">' + (p.priced ? esc(money(p.last, p.currency)) : '<span class="muted">—</span>') + '</td>' +
          '<td class="num">' + signed(p.unrealised, p.currency) + '</td>' +
          '<td class="num">' + pct(p.unrealisedPct) + '</td>' +
          '<td class="num">' + (p.priced ? esc(money(p.marketValue, p.currency)) : '—') + '</td>' +
          '<td class="num"><button class="btn small" data-act="open-symbol" data-symbol="' + esc(p.symbol) + '">Chart</button> ' +
          '<button class="btn small danger" data-act="pt-close" data-symbol="' + esc(p.symbol) +
            '" data-qty="' + esc(String(Math.abs(p.quantity))) + '" data-side="' +
            (p.quantity > 0 ? 'sell' : 'buy') + '">Close</button></td>' +
          '</tr>').join('') + '</tbody></table></div>';
    }

    if (tab === 'orders') {
      const working = data.orders.filter(o => o.status === 'working');
      if (!working.length) return emptyBlock('Nothing resting', 'Limit and stop orders you place will wait here until the market reaches them.');
      return '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>Symbol</th><th>Side</th><th>Type</th><th class="num">Qty</th><th class="num">Price</th>' +
        '<th>Placed</th><th class="num">Actions</th></tr></thead><tbody>' +
        working.map(o => '<tr>' +
          '<td class="mono">' + esc(o.symbol) + '</td>' +
          '<td class="' + (o.side === 'buy' ? 'up' : 'down') + '">' + esc(o.side) + '</td>' +
          '<td>' + esc(o.type) + '</td>' +
          '<td class="num">' + esc(String(o.quantity)) + '</td>' +
          '<td class="num">' + esc(String(o.limitPrice != null ? o.limitPrice : (o.stopPrice != null ? o.stopPrice : '—'))) + '</td>' +
          '<td>' + esc(clock.asOf(o.placedAt)) + '</td>' +
          '<td class="num"><button class="btn small danger" data-act="pt-cancel" data-id="' + esc(o.id) + '">Cancel</button></td>' +
          '</tr>').join('') + '</tbody></table></div>';
    }

    if (tab === 'history' || tab === 'trades') {
      const done = data.orders.filter(o => o.status !== 'working').slice().reverse();
      if (!done.length) return emptyBlock('No filled orders yet', 'Once an order fills it is recorded here with the assumptions it rested on.');
      return '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>Symbol</th><th>Side</th><th>Type</th><th class="num">Qty</th><th class="num">Filled at</th>' +
        '<th>When</th><th>Basis</th></tr></thead><tbody>' +
        done.map(o => '<tr>' +
          '<td class="mono">' + esc(o.symbol) + '</td>' +
          '<td class="' + (o.side === 'buy' ? 'up' : 'down') + '">' + esc(o.side) + '</td>' +
          '<td>' + esc(o.type) + '</td>' +
          '<td class="num">' + esc(String(o.quantity)) + '</td>' +
          '<td class="num">' + (o.filledPrice == null ? esc(o.status) : esc(o.filledPrice.toFixed(4))) + '</td>' +
          '<td>' + (o.filledAt ? esc(clock.asOf(o.filledAt)) : '—') + '</td>' +
          /* The assumption a fill rested on travels with it, so a simulated
             result can never be read as a real one. */
          '<td class="muted" title="' + esc((o.assumptions && o.assumptions.note) || '') + '">' +
            esc((o.assumptions && o.assumptions.basis) || '—') + '</td>' +
          '</tr>').join('') + '</tbody></table></div>';
    }

    /* account summary */
    return '<div class="cards">' +
      card('Equity', money(data.equity, currency), 'Cash plus positions') +
      card('Cash', money(data.cash, currency), 'Available') +
      card('Open P&L', signed(data.unrealised, currency), data.positions.length + ' position' + (data.positions.length === 1 ? '' : 's')) +
      card('Realised', signed(data.realised, currency), 'Closed trades') +
      card('Working orders', String(data.orders.filter(o => o.status === 'working').length), 'Resting') +
      card('Fills', String(data.orders.filter(o => o.status === 'filled').length), 'All time') +
      '</div><div class="note-line">Simulated money. Every fill records whether it crossed a real book or ' +
      'an assumed spread, and neither is ever counted as a real result.</div>';
  }

  /* The venue clocks along the bottom of the panel. */
  function marketStatus(quotes) {
    const venues = [['New York', 'America/New_York'], ['London', 'Europe/London'], ['Tokyo', 'Asia/Tokyo']];
    return venues.map(([name, tz]) =>
      '<span>' + esc(name) + ' <b class="mono">' + esc(clock.asOf(Date.now(), tz)) + '</b></span>').join('') +
      '<span class="tb-spacer"></span>' +
      '<span class="muted">' + quotes.size + ' instruments loaded</span>';
  }

  /* ============================== order ticket ============================== */

  const TYPES = [['market', 'Market'], ['limit', 'Limit'], ['stop', 'Stop'], ['stop-limit', 'Stop limit'], ['trailing-stop', 'Trailing']];

  function ticket(app, model) {
    const symbol = app.symbol || '—';
    const side = app.ticketSide;
    const type = app.ticketType;

    let html =
      '<div class="sides">' +
        '<button class="side-btn buy' + (side === 'buy' ? ' on' : '') + '" data-act="tk-side" data-side="buy">Buy</button>' +
        '<button class="side-btn sell' + (side === 'sell' ? ' on' : '') + '" data-act="tk-side" data-side="sell">Sell</button>' +
      '</div>' +

      '<div class="type-row">' + TYPES.map(([id, label]) =>
        '<button class="type-btn' + (id === type ? ' on' : '') + '" data-act="tk-type" data-type="' + id + '">' +
        esc(label) + '</button>').join('') + '</div>' +

      fieldHtml('Quantity',
        '<div class="stepper">' +
          '<button class="icon-btn" data-act="tk-step" data-step="-1"><svg><use href="#i-minus"></use></svg></button>' +
          '<input id="tk-qty" type="number" min="0" step="any" value="10">' +
          '<button class="icon-btn" data-act="tk-step" data-step="1"><svg><use href="#i-plus"></use></svg></button>' +
        '</div>');

    /* A price field that only shows the current price as a placeholder looks
       identical to an empty one, and Number('') is 0 — an order that reads
       as though nothing was typed can submit a limit of zero. Pre-filled
       with the real current price as an actual value, editable from there,
       plus the offsets a price is actually adjusted by rather than typed
       from scratch. */
    const last = model && num.num(model.quote.last);
    const offsetRow = id => last == null ? '' : '<div class="price-offsets">' +
      [-15, -10, -5, 5, 10, 15].map(pct => '<button type="button" class="btn small" data-act="tk-offset" ' +
        'data-target="' + id + '" data-pct="' + pct + '">' + (pct > 0 ? '+' : '') + pct + '%</button>').join('') +
      '</div>';

    if (type === 'limit' || type === 'stop-limit') {
      html += fieldHtml('Limit price', '<input id="tk-limit" type="number" step="any"' +
        (last != null ? ' value="' + esc(String(last)) + '"' : ' placeholder="—"') + '>' + offsetRow('tk-limit'));
    }
    if (type === 'stop' || type === 'stop-limit') {
      html += fieldHtml('Stop price', '<input id="tk-stop" type="number" step="any"' +
        (last != null ? ' value="' + esc(String(last)) + '"' : ' placeholder="—"') + '>' + offsetRow('tk-stop'));
    }
    if (type === 'trailing-stop') {
      html += fieldHtml('Trail by', '<input id="tk-trail" type="number" step="any">');
    }

    html += '<div class="grid2">' +
      fieldHtml('Take profit', '<input id="tk-tp" type="number" step="any" placeholder="optional">') +
      fieldHtml('Stop loss', '<input id="tk-sl" type="number" step="any" placeholder="optional">') +
      '</div>';

    html += '<div class="preview" id="ticket-preview"></div>';

    html += '<button class="btn-big ' + side + '" data-act="tk-place"' + (app.symbol ? '' : ' disabled') + '>' +
      esc((side === 'buy' ? 'Buy ' : 'Sell ') + symbol) + '</button>';

    html += '<div class="ticket-row"><span class="k">Account</span><span class="v">Paper · simulated</span></div>';

    return html;
  }

  function previewHtml(preview, app) {
    if (!preview.usable) return '<span class="muted">' + esc(preview.reason) + '</span>';
    const currency = (preview.assumptions && preview.assumptions.currency) || null;
    let html =
      '<div class="ticket-row"><span class="k">Estimated price</span><span class="v">' +
      esc(preview.estimatedPrice.toFixed(4)) + '</span></div>' +
      '<div class="ticket-row"><span class="k">Estimated cost</span><span class="v">' +
      esc(num.money(preview.estimatedValue, { currency: currency || 'USD', assetClass: 'EQUITY' })) + '</span></div>';

    /* The assumption behind the estimate is shown, not buried: a fill against an
       assumed spread is a different thing from one that crossed a real book. */
    preview.warnings.forEach(w => {
      html += '<div class="ticket-row"><span class="muted" style="font-size:11px">' + esc(w) + '</span></div>';
    });
    return html;
  }

  /* ============================== portfolio ============================== */

  async function renderPortfolio() {
    document.getElementById('pf-books').innerHTML = bookTabs(state.book, 'pf-book');
    const body = document.getElementById('pf-body');

    let data;
    try {
      data = await ctx.call('portfolio:value', { book: state.book });
    } catch (err) {
      body.innerHTML = '<div class="note-line bad">' + esc(err.message) + '</div>';
      return;
    }
    state.portfolio = data;

    const caveat = document.getElementById('pf-caveat');
    caveat.querySelector('.mark').textContent = data.bookLabel || state.book;
    caveat.querySelector('.t').textContent = data.caveat || '';
    caveat.classList.remove('hidden');

    const open = data.holdings.length;
    if (!open) {
      body.innerHTML = '<div class="empty"><div class="big">Nothing in this book yet</div>' +
        '<div>' + (state.book === 'mirror'
          ? 'Add what you actually hold — symbol, quantity, the price you paid and the date. Everything else is worked out from it.'
          : 'Place a paper order from any chart and it will appear here.') + '</div>' +
        (state.book === 'mirror' ? '<button class="btn primary" data-act="add-transaction">Add a transaction</button>' : '') +
        '</div>';
      return;
    }

    const currency = data.totals ? data.totals.currency : data.accountCurrency;
    let html = '';

    if (data.totals) {
      html += '<div class="cards">' +
        card('Market value', money(data.totals.marketValue, currency), data.freshness.label + ' · ' + data.freshness.basis) +
        card('Unrealised', signed(data.totals.unrealised, currency),
          data.totals.unrealisedPct == null ? '' : num.pct(data.totals.unrealisedPct)) +
        card('Realised', signed(data.totals.realised, currency), 'Closed trades') +
        card('Dividends', money(data.totals.dividends, currency), 'Received') +
        card('Fees', money(data.totals.fees, currency), 'Paid') +
        card('Cash', money(data.totals.cash, currency), 'Uninvested') +
        '</div>';
    } else {
      html += '<div class="note-line warn">' + esc(data.rateNote) + '</div><div class="cards">' +
        data.byCurrency.map(e => card(e.currency + ' value', money(e.marketValue, e.currency), 'Exact, unconverted')).join('') +
        '</div>';
    }

    if (data.incompleteNote) html += '<div class="note-line warn">' + esc(data.incompleteNote) + '</div>';
    (data.currencyMismatches || []).forEach(m => { html += '<div class="note-line warn">' + esc(m.reason) + '</div>'; });
    (data.observations || []).forEach(o => { html += '<div class="note-line">' + esc(o.text) + '</div>'; });

    if (data.totals && data.totals.marketValue) {
      const priced = data.holdings.filter(h => h.priced && h.weight != null)
        .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
      html += '<div class="section-label">Allocation</div><div class="alloc">' +
        priced.map((h, i) => '<span style="width:' + Math.max(0, h.weight).toFixed(2) + '%;background:' +
          allocColour(i) + '" title="' + esc(h.symbol) + '"></span>').join('') +
        '</div><div class="alloc-key">' +
        priced.slice(0, 8).map((h, i) => '<span><i style="background:' + allocColour(i) + '"></i>' +
          esc(h.symbol) + ' ' + h.weight.toFixed(1) + '%</span>').join('') + '</div>';
    }

    html += '<div class="section-label">Holdings</div><div class="table-wrap"><table class="data"><thead><tr>' +
      '<th>Symbol</th><th class="num">Quantity</th><th class="num">Average</th><th class="num">Last</th>' +
      '<th class="num">Value</th><th class="num">Unrealised</th><th class="num">%</th><th class="num">Weight</th><th></th>' +
      '</tr></thead><tbody>';

    data.holdings.forEach(h => {
      html += '<tr>' +
        '<td><span class="mono">' + esc(h.symbol) + '</span><span class="sub">' + esc(h.name || '') + '</span></td>' +
        '<td class="num">' + esc(String(h.quantity)) + '</td>' +
        '<td class="num">' + esc(money(h.averageEntry, h.currency)) + '</td>' +
        '<td class="num">' + (h.priced ? esc(money(h.last, h.currency)) : '<span class="muted">—</span>') + '</td>' +
        '<td class="num">' + (h.priced ? esc(money(h.marketValue, h.currency)) : '<span class="muted">—</span>') + '</td>' +
        '<td class="num">' + (h.priced ? signed(h.unrealised, h.currency) : '<span class="muted">—</span>') + '</td>' +
        '<td class="num">' + (h.priced ? pct(h.unrealisedPct) : '') + '</td>' +
        '<td class="num">' + (h.weight == null ? '' : h.weight.toFixed(1) + '%') + '</td>' +
        '<td class="num"><button class="btn small" data-act="open-symbol" data-symbol="' + esc(h.symbol) + '">Chart</button></td>' +
        '</tr>';
      /* A holding that could not be priced says why, in its own row rather than
         as a footnote somewhere else. */
      if (h.problem) {
        html += '<tr><td colspan="9" style="padding-top:0"><span class="finding" style="margin:0;display:block">' +
          esc(h.problem) + '</span></td></tr>';
      }
    });
    html += '</tbody></table></div>';

    const transactions = await ctx.call('portfolio:transactions', { book: state.book }).catch(() => []);
    html += '<div class="section-label">Transactions</div>';
    if (!transactions.length) {
      html += '<div class="note-line">No transactions recorded.</div>';
    } else {
      html += '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>Date</th><th>Type</th><th>Symbol</th><th class="num">Quantity</th><th class="num">Price</th>' +
        '<th class="num">Fees</th><th></th></tr></thead><tbody>' +
        transactions.slice().reverse().slice(0, 200).map(t => '<tr>' +
          '<td class="num">' + esc(new Date(t.at).toISOString().slice(0, 10)) + '</td>' +
          '<td>' + esc(t.kind) + '</td>' +
          '<td class="mono">' + esc(t.symbol || '—') + '</td>' +
          '<td class="num">' + (t.quantity == null ? '—' : esc(String(t.quantity))) + '</td>' +
          '<td class="num">' + (t.price == null ? '—' : esc(money(t.price, t.currency))) + '</td>' +
          '<td class="num">' + esc(money(t.fees || 0, t.currency)) + '</td>' +
          '<td class="num"><button class="btn small danger" data-act="remove-transaction" data-id="' + esc(t.id) + '">Remove</button></td>' +
          '</tr>').join('') + '</tbody></table></div>';
    }

    body.innerHTML = html;
  }

  const ALLOC = ['#f0a92e', '#26a69a', '#3b82f6', '#c084fc', '#ef5350', '#14b8a6', '#f97316', '#8b5cf6'];
  function allocColour(i) { return ALLOC[i % ALLOC.length]; }

  /* ============================== journal ============================== */

  async function renderJournal() {
    document.getElementById('jn-books').innerHTML = bookTabs(state.journalBook, 'jn-book');
    const body = document.getElementById('jn-body');

    let data;
    try {
      data = await ctx.call('journal:read', { book: state.journalBook });
    } catch (err) {
      body.innerHTML = '<div class="note-line bad">' + esc(err.message) + '</div>';
      return;
    }
    state.journal = data;

    const stats = data.statistics;
    document.getElementById('jn-count').textContent = stats.empty ? '' : stats.count + ' closed trades';

    if (stats.empty) {
      body.innerHTML = emptyBlock('No closed trades yet',
        'Every trade that closes is journalled automatically from the ledger. Add what you hold, or place paper trades, and the record builds itself.');
      return;
    }

    const currency = data.currency || 'GBP';
    let html = '<div class="cards">' +
      card('Net', signed(stats.net, currency), stats.count + ' trades') +
      card('Win rate', stats.winRate.toFixed(1) + '%', stats.wins + ' of ' + stats.count) +
      card('Expectancy', stats.expectancy == null ? '<span class="muted">—</span>' : signed(stats.expectancy, currency),
        stats.expectancyNote || 'Per trade') +
      card('Profit factor', stats.profitFactor == null ? '<span class="muted">—</span>' : stats.profitFactor.toFixed(2),
        stats.profitFactorNote || 'Gross win ÷ gross loss') +
      card('Average win', money(stats.averageWin, currency), 'Average loss ' + money(stats.averageLoss, currency)) +
      card('Max drawdown', money(stats.maxDrawdown, currency),
        stats.maxDrawdownPct ? stats.maxDrawdownPct.toFixed(1) + '% from peak' : '') +
      card('Average R', stats.rMultiple.average == null ? '<span class="muted">—</span>' : stats.rMultiple.average.toFixed(2) + 'R',
        stats.rMultiple.note || 'Over all trades') +
      card('Hold time', holdTime(stats.averageHoldMs), 'Average') +
      '</div>';

    /* The R figure is only meaningful over trades that recorded a stop, and it
       says so rather than being read as covering everything. */
    if (stats.rMultiple.note) html += '<div class="note-line">' + esc(stats.rMultiple.note) + '</div>';
    if (data.orphaned && data.orphaned.length) {
      html += '<div class="note-line warn">' + data.orphaned.length + ' journal note' +
        (data.orphaned.length === 1 ? '' : 's') + ' no longer match a trade, usually because a transaction was ' +
        'corrected. They are kept and can be reattached.</div>';
    }

    html += '<div class="section-label">Equity curve</div><div class="curve-wrap"><canvas id="jn-curve"></canvas></div>';
    if (data.calendar.length) html += '<div class="section-label">Daily profit</div><div class="calendar" id="jn-calendar"></div>';

    const groupBlock = (label, rows) => {
      if (!rows.length) return '';
      return '<div class="section-label">' + esc(label) + '</div><div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>Name</th><th class="num">Trades</th><th class="num">Win rate</th><th class="num">Net</th><th class="num">Average</th>' +
        '</tr></thead><tbody>' + rows.map(g => '<tr>' +
          '<td>' + esc(g.name) + (g.thin ? ' <span class="muted">thin</span>' : '') + '</td>' +
          '<td class="num">' + g.count + '</td>' +
          '<td class="num">' + g.winRate.toFixed(0) + '%</td>' +
          '<td class="num">' + signed(g.net, currency) + '</td>' +
          '<td class="num">' + signed(g.average, currency) + '</td></tr>').join('') +
        '</tbody></table></div>';
    };

    html += groupBlock('By instrument', data.groups.bySymbol.slice(0, 10));
    html += groupBlock('By setup', data.groups.bySetup.slice(0, 10));
    html += groupBlock('By tag', data.groups.byTag.slice(0, 10));
    html += groupBlock('By day of week', data.groups.byWeekday);

    html += '<div class="section-label">Trades</div><div class="table-wrap"><table class="data"><thead><tr>' +
      '<th>Closed</th><th>Symbol</th><th>Side</th><th class="num">Qty</th><th class="num">Entry</th>' +
      '<th class="num">Exit</th><th class="num">Net</th><th class="num">R</th><th>Setup</th><th></th>' +
      '</tr></thead><tbody>' +
      data.trades.slice(0, 300).map(t => '<tr>' +
        '<td class="num">' + esc(new Date(t.closedAt).toISOString().slice(0, 10)) + '</td>' +
        '<td class="mono">' + esc(t.symbol) + '</td>' +
        '<td class="' + (t.direction === 'long' ? 'up' : 'down') + '">' + esc(t.direction) + '</td>' +
        '<td class="num">' + esc(String(t.quantity)) + '</td>' +
        '<td class="num">' + esc(money(t.entryPrice, t.currency)) + '</td>' +
        '<td class="num">' + esc(money(t.exitPrice, t.currency)) + '</td>' +
        '<td class="num">' + signed(t.netPnl, t.currency) + '</td>' +
        '<td class="num">' + (t.rMultiple == null ? '<span class="muted">—</span>'
          : '<span class="' + num.signOf(t.rMultiple) + '">' + t.rMultiple.toFixed(2) + '</span>') + '</td>' +
        '<td>' + esc((t.annotation && t.annotation.setup) || '') + '</td>' +
        '<td class="num"><button class="btn small" data-act="journal-note" data-key="' + esc(t.key) + '">' +
        (t.journalled ? 'Edit' : 'Journal') + '</button></td></tr>').join('') +
      '</tbody></table></div>';

    body.innerHTML = html;
    paintCurve(stats.equityCurve, currency);
    if (data.calendar.length) paintCalendar(data.calendar, currency);
  }

  function holdTime(ms) {
    if (!ms) return '—';
    const hours = ms / 3600000;
    return hours < 24 ? hours.toFixed(1) + 'h' : (hours / 24).toFixed(1) + 'd';
  }

  /* The equity curve is drawn rather than plotted with a library, for the same
     reason the price chart is: no dependency, and full control of the theme. */
  function paintCurve(points, currency) {
    const canvas = document.getElementById('jn-curve');
    if (!canvas || !points.length) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, rect.width, rect.height);

    const css = getComputedStyle(document.documentElement);
    const pick = name => (css.getPropertyValue(name) || '').trim();

    const values = points.map(p => p.equity).concat([0]);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = (max - min) || 1;
    const pad = 24;
    const x = i => pad + (i / Math.max(1, points.length - 1)) * (rect.width - pad * 2);
    const y = v => rect.height - pad - ((v - min) / span) * (rect.height - pad * 2);

    /* Zero is the line that matters on an equity curve, so it is drawn even
       when the curve never crosses it. */
    g.strokeStyle = pick('--line');
    g.setLineDash([3, 3]);
    g.beginPath();
    g.moveTo(pad, y(0));
    g.lineTo(rect.width - pad, y(0));
    g.stroke();
    g.setLineDash([]);

    const positive = points[points.length - 1].equity >= 0;
    const gradient = g.createLinearGradient(0, y(max), 0, y(min));
    gradient.addColorStop(0, positive ? 'rgba(38,166,154,.3)' : 'rgba(239,83,80,.3)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');

    g.beginPath();
    points.forEach((p, i) => (i ? g.lineTo(x(i), y(p.equity)) : g.moveTo(x(i), y(p.equity))));
    g.lineTo(x(points.length - 1), y(0));
    g.lineTo(x(0), y(0));
    g.closePath();
    g.fillStyle = gradient;
    g.fill();

    g.beginPath();
    points.forEach((p, i) => (i ? g.lineTo(x(i), y(p.equity)) : g.moveTo(x(i), y(p.equity))));
    g.strokeStyle = positive ? pick('--up') : pick('--down');
    g.lineWidth = 1.9;
    g.lineJoin = 'round';
    g.stroke();

    g.fillStyle = pick('--ink-3');
    g.font = '10px ' + (pick('--mono') || 'monospace');
    g.textAlign = 'left';
    g.fillText(num.money(max, { currency, assetClass: 'EQUITY' }), 4, y(max) + 4);
    g.fillText(num.money(min, { currency, assetClass: 'EQUITY' }), 4, y(min) - 2);
  }

  function paintCalendar(days, currency) {
    const host = document.getElementById('jn-calendar');
    if (!host) return;
    const most = Math.max(...days.map(d => Math.abs(d.net)), 1);
    host.innerHTML = days.map(day => {
      const share = Math.min(1, Math.abs(day.net) / most);
      const colour = day.net === 0 ? 'var(--surface-3)'
        : (day.net > 0
          ? 'rgba(38,166,154,' + (0.2 + share * 0.7).toFixed(2) + ')'
          : 'rgba(239,83,80,' + (0.2 + share * 0.7).toFixed(2) + ')');
      const label = day.date + '  ' + num.change(day.net, { currency, assetClass: 'EQUITY' }) +
        '  ·  ' + day.trades + ' trade' + (day.trades === 1 ? '' : 's');
      return '<div class="cal-day" style="background:' + colour + '" title="' + esc(label) + '"></div>';
    }).join('');
  }

  window.T = window.T || {};
  window.T.screens = {
    install, state,
    bottomPanel, marketStatus, ticket, previewHtml,
    renderPortfolio, renderJournal,
    card, esc, money, signed, pct
  };

}());
