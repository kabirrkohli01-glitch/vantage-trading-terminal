'use strict';
/* The performance dashboard.
 *
 * Built to a reference design whose
 * palette was sampled from the file rather than eyeballed: the page ground, the
 * card surface, the rail, the purple, the green and the red, the two pale fills
 * behind the charts, and the band behind a table header are the colours in that
 * image. They are declared as their own tokens in the stylesheet so this screen
 * looks like the reference in both themes.
 *
 * WHAT IS DIFFERENT FROM THE REFERENCE, AND WHY:
 *
 *   THE COMPOSITE SCORE IS NOT A BLACK BOX. The reference shows a single number
 *   out of a hundred with no way to see what produced it. This one is built from
 *   five named components, each of which is a figure already on the screen, and
 *   the panel says what they are and how they are weighted. A score somebody
 *   cannot take apart is a score they cannot act on.
 *
 *   NOTHING IS AVERAGED ACROSS BOOKS. Hand-entered holdings, the paper account
 *   and an imported one are three different things and are never added together;
 *   the book being shown is named on the screen and its caveat travels with it.
 *
 *   A FIGURE WITH TOO FEW TRADES BEHIND IT SAYS SO. A win rate over four trades
 *   is four trades. The reference presents every figure with the same confidence
 *   whatever it rests on.
 *
 * Everything here is derived by the journal and portfolio engines in the main
 * process. This file lays it out and draws it; it computes nothing that is
 * stated anywhere else, so a figure cannot mean one thing here and another on
 * the journal screen.
 */

(function () {

  const num = window.T.num;
  const clock = window.T.clock;

  let ctx = null;
  function install(context) { ctx = context; }

  const esc = text => String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const BOOKS = [['mirror', 'My holdings'], ['paper', 'Paper'], ['imported', 'From broker']];

  const state = {
    book: 'mirror',
    journal: null,
    portfolio: null,
    loading: false,
    tab: 'positions',
    month: null,          // the month the calendar is showing, as a Date
    /* Follows the application's theme by default, like every other screen —
       switching the app to dark and finding this one still white read as a
       broken theme, not as a deliberate second look. The reference's light
       palette is still one click away, named for what it is. */
    surface: 'theme',
    token: 0
  };

  /* ---------- loading ---------- */

  async function load(force) {
    if (state.journal && !force) return;
    const token = ++state.token;
    state.loading = true;
    paint();

    const [journal, portfolio] = await Promise.all([
      ctx.call('journal:read', { book: state.book }).catch(err => ({ error: err.message })),
      ctx.call('portfolio:value', { book: state.book }).catch(err => ({ error: err.message }))
    ]);

    if (token !== state.token) return;
    state.journal = journal;
    state.portfolio = portfolio;
    state.loading = false;
    if (!state.month) {
      const last = journal && journal.statistics && journal.statistics.lastAt;
      state.month = last ? startOfMonth(new Date(last)) : startOfMonth(new Date());
    }
    paint();
  }

  function startOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
  }

  /* ---------- drawing ---------- */

  function paint() {
    const root = document.querySelector('.view[data-view="profile"]');
    if (!root) return;
    root.innerHTML = html();
    root.setAttribute('data-surface', state.surface);
  }

  function html() {
    const journal = state.journal;
    const stats = journal && journal.statistics;
    const holdings = (state.portfolio && state.portfolio.holdings) || [];

    /* What is held right now and how past round trips performed are two
       different questions, and the first can have an answer while the
       second does not — a book that is all open positions and no closed
       trades used to show nothing about them at all, because the card that
       lists current holdings only ever rendered inside the branch that
       needs a closed trade to have anything else worth showing. */
    const noClosedTrades = !stats || stats.empty;

    return bar() +
      '<div class="screen-body dash">' +
      (state.loading ? '<div class="loading">Reading your record…</div>' : '') +
      (journal && journal.error ? '<div class="news-missing">' + esc(journal.error) + '</div>' : '') +
      (noClosedTrades && holdings.length ? '<div class="dash-row two">' + positionsCard() + '</div>' : '') +
      (noClosedTrades ? emptyHtml() : body(stats)) +
      '</div>';
  }

  function bar() {
    return '<div class="screen-bar">' +
      '<span class="screen-title">Performance</span>' +
      '<div class="book-tabs">' + BOOKS.map(([id, label]) =>
        '<button class="book-tab' + (state.book === id ? ' on' : '') +
        '" data-act="dash-book" data-book="' + id + '">' + label + '</button>').join('') + '</div>' +
      '<span class="tb-spacer"></span>' +
      '<button class="btn" data-act="dash-surface">' +
      (state.surface === 'report' ? 'Follow the app theme' : 'Report colours') + '</button>' +
      '<button class="icon-btn" data-act="dash-refresh" title="Recompute"><svg><use href="#i-refresh"></use></svg></button>' +
      '</div>';
  }

  function emptyHtml() {
    if (state.loading) return '';
    const holdings = (state.portfolio && state.portfolio.holdings) || [];
    return '<div class="empty dash-empty">' +
      '<strong>No closed trade in the ' + esc(bookLabel()) + ' book yet.</strong>' +
      '<p>' + (holdings.length
        ? 'The win rate, profit factor and equity curve below are all derived from closed trades — a ' +
          'position that is still open has not become one yet. What you currently hold is above.'
        : 'Every figure on this screen is derived from closed trades in the ledger. Add transactions ' +
          'on the Portfolio screen, or place one in the paper account, and it fills in from there.') +
      '</p></div>';
  }

  function bookLabel() {
    const found = BOOKS.find(([id]) => id === state.book);
    return found ? found[1].toLowerCase() : state.book;
  }

  function body(stats) {
    return metricRow(stats) +
      '<div class="dash-row three">' +
      scoreCard(stats) +
      chartCard('Cumulative profit', cumulativeChart(stats), 'Closed trades in the order they closed. ' +
        'This is the record of decisions, not of prices moving.') +
      chartCard('Profit by day', dailyChart(), 'Each bar is one day\'s net result across every trade closed that day.') +
      '</div>' +
      '<div class="dash-row two">' +
      positionsCard() +
      calendarCard() +
      '</div>';
  }

  /* ---------- the metric row ---------- */

  function metricRow(stats) {
    const currency = (state.journal && state.journal.currency) || 'GBP';
    const money = value => num.money(value, { currency });

    return '<div class="metric-row">' +
      metric('Net profit', money(stats.net), num.signOf(stats.net), stats.count + ' trades',
        gauge(null), 'Gross profit less gross loss across every closed trade in this book.') +
      metric('Expectancy', stats.expectancy == null ? '—' : money(stats.expectancy),
        num.signOf(stats.expectancy), 'per trade', null,
        stats.expectancyNote || 'What one trade has been worth on average, given this record.') +
      metric('Profit factor', stats.profitFactor == null ? '—' : stats.profitFactor.toFixed(2),
        stats.profitFactor == null ? '' : (stats.profitFactor >= 1 ? 'up' : 'down'), '',
        gauge(stats.profitFactor), stats.profitFactorNote ||
        'Gross profit divided by gross loss. Above one is a profitable record.') +
      metric('Win rate', stats.winRate.toFixed(1) + '%', '',
        stats.wins + ' won · ' + stats.losses + ' lost', donut(stats.wins, stats.losses, stats.scratches),
        thin(stats.count)) +
      metric('Average win against loss',
        stats.winLossRatio == null ? '—' : stats.winLossRatio.toFixed(2),
        stats.winLossRatio == null ? '' : (stats.winLossRatio >= 1 ? 'up' : 'down'), '',
        winLossBar(stats, currency),
        'The average winner divided by the average loser. Above one means the winners are bigger.') +
      '</div>';
  }

  function metric(label, value, direction, sub, art, help) {
    return '<div class="metric-card">' +
      '<div class="m-head"><span class="m-label">' + esc(label) + '</span>' +
      (help ? '<span class="m-help" title="' + esc(help) + '">?</span>' : '') +
      (sub ? '<span class="m-sub">' + esc(sub) + '</span>' : '') + '</div>' +
      '<div class="m-body"><div class="m-value ' + esc(direction || '') + '">' + esc(value) + '</div>' +
      (art ? '<div class="m-art">' + art + '</div>' : '') + '</div></div>';
  }

  /* A half-circle gauge, the way the reference draws a profit factor. The
     needle is not drawn: the arc's own extent is the reading, which is easier to
     compare between two cards than an angle is. */
  function gauge(value) {
    if (value == null || !Number.isFinite(value)) return '';
    /* Two is the point at which a record is unusually good; beyond it the arc is
       full rather than continuing to grow, so the scale stays readable. */
    const fraction = Math.max(0, Math.min(value / 2, 1));
    const radius = 26;
    const length = Math.PI * radius;

    return '<svg viewBox="0 0 64 38" class="art-gauge">' +
      '<path d="M6 32 A26 26 0 0 1 58 32" fill="none" stroke="var(--dash-track)" stroke-width="7" stroke-linecap="round"/>' +
      '<path d="M6 32 A26 26 0 0 1 58 32" fill="none" stroke="' +
      (value >= 1 ? 'var(--dash-green)' : 'var(--dash-red)') + '" stroke-width="7" stroke-linecap="round" ' +
      'stroke-dasharray="' + (length * fraction).toFixed(2) + ' ' + length.toFixed(2) + '"/>' +
      '</svg>';
  }

  function donut(wins, losses, scratches) {
    const total = wins + losses + scratches;
    if (!total) return '';
    const circumference = 2 * Math.PI * 15;
    const winLength = (wins / total) * circumference;
    const lossLength = (losses / total) * circumference;

    return '<svg viewBox="0 0 40 40" class="art-donut">' +
      '<circle cx="20" cy="20" r="15" fill="none" stroke="var(--dash-track)" stroke-width="6"/>' +
      '<circle cx="20" cy="20" r="15" fill="none" stroke="var(--dash-green)" stroke-width="6" ' +
      'stroke-dasharray="' + winLength.toFixed(2) + ' ' + circumference.toFixed(2) + '" transform="rotate(-90 20 20)"/>' +
      '<circle cx="20" cy="20" r="15" fill="none" stroke="var(--dash-red)" stroke-width="6" ' +
      'stroke-dasharray="' + lossLength.toFixed(2) + ' ' + circumference.toFixed(2) + '" ' +
      'stroke-dashoffset="' + (-winLength).toFixed(2) + '" transform="rotate(-90 20 20)"/>' +
      '</svg>';
  }

  function winLossBar(stats, currency) {
    if (stats.averageWin == null && stats.averageLoss == null) return '';
    const win = stats.averageWin || 0;
    const loss = stats.averageLoss || 0;
    const total = win + loss;
    const share = total > 0 ? (win / total) * 100 : 50;

    return '<div class="art-winloss">' +
      '<div class="bar"><i class="w" style="width:' + share.toFixed(1) + '%"></i>' +
      '<i class="l" style="width:' + (100 - share).toFixed(1) + '%"></i></div>' +
      '<div class="ends"><span class="up">' + num.money(stats.averageWin, { currency }) + '</span>' +
      '<span class="down">' + num.money(stats.averageLoss, { currency }) + '</span></div></div>';
  }

  function thin(count) {
    return count < 20
      ? 'Over ' + count + ' trade' + (count === 1 ? '' : 's') +
        '. A percentage over fewer than twenty is a description of those trades, not a finding.'
      : 'Winning trades as a share of every trade taken. A trade that made nothing counts in the ' +
        'denominator but not the numerator.';
  }

  /* ---------- the composite score ---------- */

  /* FIVE COMPONENTS, EACH ONE A FIGURE THAT IS ALREADY ON THIS SCREEN.
   *
   * The reference shows a single number with no way to see inside it. This is
   * the same idea with the lid off: each component is scored out of a hundred
   * against a stated target, the weights are equal because there is no evidence
   * for weighting them otherwise, and the panel names every one. */
  function components(stats) {
    const clamp = value => Math.max(0, Math.min(100, value));

    return [
      {
        key: 'Win rate',
        value: clamp((stats.winRate / 55) * 100),
        detail: stats.winRate.toFixed(1) + '% against a target of 55%'
      },
      {
        key: 'Profit factor',
        value: stats.profitFactor == null ? null : clamp(((stats.profitFactor - 1) / 1) * 100),
        detail: stats.profitFactor == null ? 'No losing trade to divide by'
          : stats.profitFactor.toFixed(2) + ' against a target of 2.0'
      },
      {
        key: 'Win against loss',
        value: stats.winLossRatio == null ? null : clamp(((stats.winLossRatio - 0.5) / 1.5) * 100),
        detail: stats.winLossRatio == null ? 'Not enough of both to compare'
          : stats.winLossRatio.toFixed(2) + ' against a target of 2.0'
      },
      {
        key: 'Drawdown control',
        value: stats.maxDrawdownPct == null ? null : clamp(100 - stats.maxDrawdownPct * 2),
        detail: stats.maxDrawdownPct == null ? 'No drawdown recorded'
          : 'Deepest fall from a peak was ' + stats.maxDrawdownPct.toFixed(1) + '%'
      },
      {
        key: 'Risk discipline',
        value: stats.rMultiple && stats.rMultiple.of
          ? clamp((stats.rMultiple.over / stats.rMultiple.of) * 100) : 0,
        detail: stats.rMultiple
          ? stats.rMultiple.over + ' of ' + stats.rMultiple.of + ' trades recorded the stop they were taken with'
          : 'No stop recorded'
      }
    ];
  }

  function scoreCard(stats) {
    const parts = components(stats);
    const scored = parts.filter(part => part.value !== null);
    const score = scored.length ? scored.reduce((sum, part) => sum + part.value, 0) / scored.length : null;

    return '<section class="dash-card score-card">' +
      '<div class="c-head"><span class="c-title">Desk score</span>' +
      '<span class="m-help" title="The mean of the five components below, each scored out of a hundred ' +
      'against the target named beside it. Components that cannot be computed are left out of the mean ' +
      'rather than counted as zero.">?</span></div>' +
      '<div class="score-body">' +
      radar(parts) +
      '<div class="score-figure"><div class="score-value">' +
      (score == null ? '—' : Math.round(score)) + '</div>' +
      '<div class="score-of">out of 100, from ' + scored.length + ' of ' + parts.length + ' components</div></div>' +
      '</div>' +
      '<ul class="score-parts">' + parts.map(part =>
        '<li><span class="p-key">' + esc(part.key) + '</span>' +
        '<span class="p-bar"><i style="width:' + (part.value === null ? 0 : part.value.toFixed(1)) + '%"></i></span>' +
        '<span class="p-value">' + (part.value === null ? '—' : Math.round(part.value)) + '</span>' +
        '<span class="p-detail">' + esc(part.detail) + '</span></li>').join('') +
      '</ul></section>';
  }

  /* A regular polygon with one vertex per component. */
  function radar(parts) {
    const size = 168;
    const centre = size / 2;
    const radius = centre - 22;
    const count = parts.length;

    const point = (index, fraction) => {
      const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
      return [
        (centre + Math.cos(angle) * radius * fraction).toFixed(1),
        (centre + Math.sin(angle) * radius * fraction).toFixed(1)
      ].join(',');
    };

    const rings = [0.25, 0.5, 0.75, 1].map(fraction =>
      '<polygon points="' + parts.map((_, i) => point(i, fraction)).join(' ') +
      '" fill="none" stroke="var(--dash-track)" stroke-width="1"/>').join('');

    const shape = parts.map((part, i) => point(i, part.value === null ? 0 : part.value / 100)).join(' ');

    return '<svg viewBox="0 0 ' + size + ' ' + size + '" class="art-radar">' + rings +
      '<polygon points="' + shape + '" fill="var(--dash-radar-fill)" stroke="var(--dash-accent)" stroke-width="2"/>' +
      parts.map((part, i) => {
        const [x, y] = point(i, part.value === null ? 0 : part.value / 100).split(',');
        return '<circle cx="' + x + '" cy="' + y + '" r="3" fill="var(--dash-accent)"/>';
      }).join('') +
      parts.map((part, i) => {
        const [x, y] = point(i, 1.16).split(',');
        return '<text x="' + x + '" y="' + y + '" class="radar-label" text-anchor="middle">' +
          esc(part.key.split(' ')[0]) + '</text>';
      }).join('') +
      '</svg>';
  }

  /* ---------- the charts ---------- */

  function chartCard(title, art, note) {
    return '<section class="dash-card chart-card">' +
      '<div class="c-head"><span class="c-title">' + esc(title) + '</span>' +
      '<span class="m-help" title="' + esc(note) + '">?</span></div>' +
      '<div class="c-art">' + art + '</div></section>';
  }

  /* An area filled green above the line and red below it, which is how the
     reference reads at a glance: the shape says the shape, the colour says
     whether the account is up. */
  function cumulativeChart(stats) {
    const points = (stats.equityCurve || []).map(p => ({ at: p.at, value: p.equity }));
    if (points.length < 2) return '<div class="c-empty">Two closed trades are needed to draw a curve.</div>';

    const width = 460;
    const height = 190;
    const pad = { left: 44, right: 8, top: 12, bottom: 22 };
    const values = points.map(p => p.value).concat([0]);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;

    const x = i => pad.left + (i / (points.length - 1)) * (width - pad.left - pad.right);
    const y = v => pad.top + (1 - (v - min) / span) * (height - pad.top - pad.bottom);
    const zero = y(0);

    const line = points.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.value).toFixed(1)).join(' ');
    const area = line + ' L' + x(points.length - 1).toFixed(1) + ' ' + zero.toFixed(1) +
      ' L' + x(0).toFixed(1) + ' ' + zero.toFixed(1) + ' Z';
    const currency = (state.journal && state.journal.currency) || 'GBP';

    return '<svg viewBox="0 0 ' + width + ' ' + height + '" class="art-chart" preserveAspectRatio="none">' +
      '<defs>' +
      '<clipPath id="above"><rect x="0" y="0" width="' + width + '" height="' + zero.toFixed(1) + '"/></clipPath>' +
      '<clipPath id="below"><rect x="0" y="' + zero.toFixed(1) + '" width="' + width + '" height="' +
        (height - zero).toFixed(1) + '"/></clipPath>' +
      '</defs>' +
      gridLines(pad, width, height, min, max, currency) +
      '<line x1="' + pad.left + '" x2="' + (width - pad.right) + '" y1="' + zero.toFixed(1) +
      '" y2="' + zero.toFixed(1) + '" class="axis-zero"/>' +
      '<path d="' + area + '" fill="var(--dash-green-soft)" clip-path="url(#above)"/>' +
      '<path d="' + area + '" fill="var(--dash-red-soft)" clip-path="url(#below)"/>' +
      '<path d="' + line + '" fill="none" stroke="var(--dash-green)" stroke-width="2" clip-path="url(#above)"/>' +
      '<path d="' + line + '" fill="none" stroke="var(--dash-red)" stroke-width="2" clip-path="url(#below)"/>' +
      '</svg>';
  }

  function gridLines(pad, width, height, min, max, currency) {
    const steps = 4;
    let out = '';
    for (let i = 0; i <= steps; i++) {
      const value = min + ((max - min) * i) / steps;
      const y = pad.top + (1 - i / steps) * (height - pad.top - pad.bottom);
      out += '<line x1="' + pad.left + '" x2="' + (width - pad.right) + '" y1="' + y.toFixed(1) +
        '" y2="' + y.toFixed(1) + '" class="axis-grid"/>' +
        '<text x="' + (pad.left - 6) + '" y="' + (y + 3).toFixed(1) + '" class="axis-label" text-anchor="end">' +
        esc(num.compact(value, 0)) + '</text>';
    }
    return out;
  }

  function dailyChart() {
    const days = (state.journal && state.journal.calendar) || [];
    if (!days.length) return '<div class="c-empty">No day has a closed trade in it yet.</div>';

    const recent = days.slice(-40);
    const width = 460;
    const height = 190;
    const pad = { left: 44, right: 8, top: 12, bottom: 22 };
    const values = recent.map(d => d.net);
    const max = Math.max(...values, 0);
    const min = Math.min(...values, 0);
    const span = (max - min) || 1;

    const step = (width - pad.left - pad.right) / recent.length;
    const y = v => pad.top + (1 - (v - min) / span) * (height - pad.top - pad.bottom);
    const zero = y(0);
    const currency = (state.journal && state.journal.currency) || 'GBP';

    return '<svg viewBox="0 0 ' + width + ' ' + height + '" class="art-chart" preserveAspectRatio="none">' +
      gridLines(pad, width, height, min, max, currency) +
      recent.map((day, i) => {
        const top = y(Math.max(day.net, 0));
        const bottom = y(Math.min(day.net, 0));
        const barWidth = Math.max(step * 0.62, 1.5);
        return '<rect x="' + (pad.left + i * step + (step - barWidth) / 2).toFixed(1) + '" y="' + top.toFixed(1) +
          '" width="' + barWidth.toFixed(1) + '" height="' + Math.max(bottom - top, 1).toFixed(1) +
          '" rx="1.5" fill="var(--dash-' + (day.net >= 0 ? 'green' : 'red') + ')">' +
          '<title>' + esc(day.date + ' — ' + num.money(day.net, { currency }) + ' over ' +
            day.trades + ' trade' + (day.trades === 1 ? '' : 's')) + '</title></rect>';
      }).join('') +
      '<line x1="' + pad.left + '" x2="' + (width - pad.right) + '" y1="' + zero.toFixed(1) +
      '" y2="' + zero.toFixed(1) + '" class="axis-zero"/>' +
      '</svg>';
  }

  /* ---------- positions and recent trades ---------- */

  function positionsCard() {
    const holdings = (state.portfolio && state.portfolio.holdings) || [];
    const trades = ((state.journal && state.journal.trades) || []).slice(-14).reverse();
    const currency = (state.journal && state.journal.currency) || 'GBP';

    return '<section class="dash-card">' +
      '<div class="c-tabs">' +
      '<button class="c-tab' + (state.tab === 'positions' ? ' on' : '') +
      '" data-act="dash-tab" data-tab="positions">Open positions</button>' +
      '<button class="c-tab' + (state.tab === 'trades' ? ' on' : '') +
      '" data-act="dash-tab" data-tab="trades">Recent trades</button>' +
      '</div>' +
      (state.portfolio && state.portfolio.caveat
        ? '<div class="c-caveat">' + esc(state.portfolio.caveat) + '</div>' : '') +
      (state.tab === 'positions' ? positionsTable(holdings, currency) : tradesTable(trades, currency)) +
      '</section>';
  }

  /* Columns and actions match the paper blotter's own Positions tab
     (screens.js bottomPanel) so a holding reads the same wherever it is
     shown, instead of a cut-down view of the same portfolio:value data. */
  function positionsTable(holdings, currency) {
    if (!holdings.length) return '<div class="c-empty">Nothing is open in this book.</div>';
    const closable = state.book === 'paper';
    return '<div class="table-wrap"><table class="grid dash-grid"><thead><tr>' +
      '<th>Symbol</th><th>Side</th><th class="r">Qty</th><th class="r">Avg price</th>' +
      '<th class="r">Last</th><th class="r">Unrealised</th><th class="r">Unrealised%</th>' +
      '<th class="r">Value</th><th class="r">Actions</th></tr></thead><tbody>' +
      holdings.map(holding => {
        const long = holding.quantity >= 0;
        const cur = holding.quoteCurrency || currency;
        return '<tr data-act="dash-open" data-symbol="' + esc(holding.symbol) + '">' +
          '<td class="mono strong">' + esc(holding.symbol) + '</td>' +
          '<td class="' + (long ? 'up' : 'down') + '">' + (long ? 'Long' : 'Short') + '</td>' +
          '<td class="r mono">' + num.plain(Math.abs(holding.quantity), 2) + '</td>' +
          '<td class="r mono">' + num.money(holding.averageEntry, { currency: cur }) + '</td>' +
          '<td class="r mono">' + (holding.priced
            ? num.money(holding.last, { currency: cur })
            : '<span class="muted">' + esc(holding.problem || 'unpriced') + '</span>') + '</td>' +
          '<td class="r mono ' + num.signOf(holding.unrealised) + '">' +
          (holding.unrealised == null ? '—' : num.change(holding.unrealised, { currency: cur })) + '</td>' +
          '<td class="r mono ' + num.signOf(holding.unrealisedPct) + '">' +
          (holding.unrealisedPct == null ? '—' : num.pct(holding.unrealisedPct)) + '</td>' +
          '<td class="r mono">' + (holding.priced ? num.money(holding.marketValue, { currency: cur }) : '—') + '</td>' +
          '<td class="r"><button class="btn small" data-act="dash-open" data-symbol="' +
          esc(holding.symbol) + '">Chart</button>' +
          (closable ? ' <button class="btn small danger" data-act="dash-close" data-symbol="' + esc(holding.symbol) +
            '" data-qty="' + esc(String(Math.abs(holding.quantity))) + '" data-side="' +
            (long ? 'sell' : 'buy') + '">Close</button>' : '') +
          '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function tradesTable(trades, currency) {
    if (!trades.length) return '<div class="c-empty">No trade has closed yet.</div>';
    return '<div class="table-wrap"><table class="grid dash-grid"><thead><tr>' +
      '<th>Closed</th><th>Symbol</th><th>Side</th><th class="r">Net</th><th class="r">R</th>' +
      '</tr></thead><tbody>' +
      trades.map(trade => '<tr data-act="dash-open" data-symbol="' + esc(trade.symbol) + '">' +
        '<td class="mono">' + esc(clock.asOf(trade.closedAt)) + '</td>' +
        '<td class="mono strong">' + esc(trade.symbol) + '</td>' +
        '<td>' + esc(trade.side || '') + '</td>' +
        '<td class="r mono ' + num.signOf(trade.netPnl) + '">' + num.change(trade.netPnl, { currency }) + '</td>' +
        '<td class="r mono">' + (trade.rMultiple == null ? '—' : trade.rMultiple.toFixed(2)) + '</td>' +
        '</tr>').join('') + '</tbody></table></div>';
  }

  /* ---------- the month calendar ---------- */

  function calendarCard() {
    const month = state.month || startOfMonth(new Date());
    const label = month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    const days = new Map(((state.journal && state.journal.calendar) || []).map(day => [day.date, day]));
    const currency = (state.journal && state.journal.currency) || 'GBP';

    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const start = new Date(first);
    /* Weeks run Sunday to Saturday, as they do in the reference. */
    start.setDate(first.getDate() - first.getDay());

    const cells = [];
    let monthNet = 0;
    let monthTrades = 0;

    for (let i = 0; i < 42; i++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const key = [date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')].join('-');
      const inMonth = date.getMonth() === month.getMonth();
      const day = days.get(key);
      if (inMonth && day) { monthNet += day.net; monthTrades += day.trades; }

      cells.push('<div class="cal-cell' + (inMonth ? '' : ' outside') +
        (day ? (day.net >= 0 ? ' won' : ' lost') : '') + '">' +
        '<span class="cal-date">' + date.getDate() + '</span>' +
        (day ? '<span class="cal-net">' + esc(num.compact(day.net, day.net > -1000 && day.net < 1000 ? 0 : 1)) +
          '</span><span class="cal-trades">' + day.trades + ' trade' + (day.trades === 1 ? '' : 's') +
          '</span><span class="cal-rate">' + Math.round((day.wins / day.trades) * 100) + '%</span>' : '') +
        '</div>');
    }

    return '<section class="dash-card calendar-card">' +
      '<div class="c-head">' +
      '<button class="icon-btn sm" data-act="dash-month" data-step="-1" title="Previous month">‹</button>' +
      '<span class="c-title">' + esc(label) + '</span>' +
      '<button class="icon-btn sm" data-act="dash-month" data-step="1" title="Next month">›</button>' +
      '<span class="tb-spacer"></span>' +
      '<span class="c-month-total ' + num.signOf(monthNet) + '">' +
      (monthTrades ? num.change(monthNet, { currency }) + ' · ' + monthTrades + ' trades' : 'No trades') +
      '</span></div>' +
      '<div class="cal-grid">' +
      ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day =>
        '<div class="cal-head">' + day + '</div>').join('') +
      cells.join('') + '</div></section>';
  }

  /* ---------- events ---------- */

  function actions() {
    return {
      'dash-book': data => { state.book = data.book; state.month = null; load(true); },
      'dash-refresh': () => load(true),
      'dash-tab': data => { state.tab = data.tab; paint(); },
      'dash-open': data => ctx.openSymbol(data.symbol),
      'dash-close': async data => {
        await ctx.call('paper:place', {
          order: { symbol: data.symbol, side: data.side, quantity: Number(data.qty), type: 'market' }
        });
        ctx.toast('Closing order placed.');
        await load(true);
      },
      'dash-surface': () => { state.surface = state.surface === 'report' ? 'theme' : 'report'; paint(); },
      'dash-month': data => {
        const step = Number(data.step) || 0;
        const month = state.month || startOfMonth(new Date());
        state.month = new Date(month.getFullYear(), month.getMonth() + step, 1);
        paint();
      }
    };
  }

  function activate() {
    paint();
    load();
  }

  window.T = window.T || {};
  window.T.dashboard = { install, actions, activate, paint, state, components, radar, html };

}());
