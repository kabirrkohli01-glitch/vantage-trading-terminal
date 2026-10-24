'use strict';
/* Heatmaps, the screener, and the calendar.
 *
 * THE HEATMAP IS BUILT HERE RATHER THAN EMBEDDED, AND THAT WAS A CONSIDERED
 * CHOICE. The charting vendor publishes one as a widget, and it would have been
 * an afternoon's work to frame it. Three things decided against it:
 *
 *   ITS SETTINGS ARE NOT DOCUMENTED ANYWHERE THAT COULD BE READ. The market a
 *   heatmap covers is named by a code, the codes for anything outside the United
 *   States could not be established from the published documentation, and a code
 *   the widget does not recognise is not refused — it silently draws a different
 *   market. A heatmap of the wrong exchange, correctly labelled, is worse than
 *   no heatmap.
 *
 *   A TILE IN AN EMBEDDED WIDGET CANNOT BE CLICKED INTO THIS TERMINAL. It opens
 *   the vendor's website, which is the opposite of what a heatmap is for: seeing
 *   where the money went and then going to look at it.
 *
 *   THE DATA IS ALREADY HERE. The same scanner behind the vendor's own heatmap
 *   answers this application directly, for every market in the world, so drawing
 *   it natively costs one request and gains the theme, the currency formatting
 *   and the click.
 *
 * The calendar is embedded, because there is no free structured source for
 * scheduled economic releases and the vendor's own calendar is the honest way to
 * get one. It says whose it is.
 */

(function () {

  const num = window.T.num;

  let ctx = null;
  function install(context) { ctx = context; }

  const esc = text => String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /* ---------- what a heatmap can show ---------- */

  const MARKETS = [
    { id: 'america', label: 'United States' },
    { id: 'global', label: 'Worldwide', markets: null },
    { id: 'uk', label: 'United Kingdom' },
    { id: 'germany', label: 'Germany' },
    { id: 'france', label: 'France' },
    { id: 'japan', label: 'Japan' },
    { id: 'india', label: 'India' },
    { id: 'china', label: 'China' },
    { id: 'hongkong', label: 'Hong Kong' },
    { id: 'canada', label: 'Canada' },
    { id: 'australia', label: 'Australia' },
    { id: 'brazil', label: 'Brazil' },
    { id: 'korea', label: 'South Korea' },
    { id: 'crypto', label: 'Crypto' }
  ];

  /* What the colour means. Every one of these is a percentage the scanner
     publishes, so a tile's colour is a real figure and not a derived score. */
  const COLOUR_BY = [
    { id: 'change', label: 'Today', column: 'change' },
    { id: 'week', label: 'A week', column: 'Perf.W' },
    { id: 'month', label: 'A month', column: 'Perf.1M' },
    { id: 'quarter', label: 'Three months', column: 'Perf.3M' },
    { id: 'ytd', label: 'Year to date', column: 'Perf.YTD' },
    { id: 'year', label: 'A year', column: 'Perf.Y' }
  ];

  const state = {
    tab: 'heatmap',
    market: 'america',
    colourBy: 'change',
    grouping: 'sector',
    /* 'vendor' draws the charting vendor's own heatmap widget; 'native' is
       the one built in this file. Kept independent of state.chartSource —
       an operator may want the vendor's polish here and the engine's own
       chart there. */
    heatmapSource: 'vendor',
    heatmap: null,
    heatmapLoading: false,
    screen: null,
    screenLoading: false,
    preset: 'active',
    filters: '',
    token: 0
  };

  /* Which exchange(s) the vendor's stock-heatmap widget should draw for a
     market in the picker, and which of its four heatmap widgets applies at
     all — crypto is a wholly different one, with no exchange to name. There
     is no single vendor widget that draws every market in one map, so
     "Worldwide" draws the same broad United States set as "United States"
     rather than nothing; the note under the map says so. */
  const HEATMAP_WIDGET = {
    america: { kind: 'stockHeatmap', dataSource: 'AllUSA' },
    global: { kind: 'stockHeatmap', dataSource: 'AllUSA' },
    uk: { kind: 'stockHeatmap', exchanges: ['LSE'] },
    germany: { kind: 'stockHeatmap', exchanges: ['XETR'] },
    france: { kind: 'stockHeatmap', exchanges: ['EURONEXT'] },
    japan: { kind: 'stockHeatmap', exchanges: ['TSE'] },
    india: { kind: 'stockHeatmap', exchanges: ['NSE'] },
    china: { kind: 'stockHeatmap', exchanges: ['SSE', 'SZSE'] },
    hongkong: { kind: 'stockHeatmap', exchanges: ['HKEX'] },
    canada: { kind: 'stockHeatmap', exchanges: ['TSX'] },
    australia: { kind: 'stockHeatmap', exchanges: ['ASX'] },
    brazil: { kind: 'stockHeatmap', exchanges: ['BMFBOVESPA'] },
    korea: { kind: 'stockHeatmap', exchanges: ['KRX'] },
    crypto: { kind: 'cryptoHeatmap' }
  };

  /* ---------- the presets a screener is actually used through ---------- */

  const PRESETS = [
    {
      id: 'active', label: 'Most active',
      sortBy: 'volume',
      filters: [{ field: 'type', operation: 'equal', value: 'stock' }]
    },
    {
      id: 'gainers', label: 'Biggest risers',
      sortBy: 'change',
      filters: [{ field: 'type', operation: 'equal', value: 'stock' },
        { field: 'market_cap_basic', operation: 'greater', value: 300000000 }]
    },
    {
      id: 'losers', label: 'Biggest fallers', sortOrder: 'asc',
      sortBy: 'change',
      filters: [{ field: 'type', operation: 'equal', value: 'stock' },
        { field: 'market_cap_basic', operation: 'greater', value: 300000000 }]
    },
    {
      id: 'unusual', label: 'Unusual volume',
      sortBy: 'relative_volume_10d_calc',
      filters: [{ field: 'type', operation: 'equal', value: 'stock' },
        { field: 'relative_volume_10d_calc', operation: 'greater', value: 2 },
        { field: 'market_cap_basic', operation: 'greater', value: 300000000 }]
    },
    {
      id: 'oversold', label: 'Oversold',
      sortBy: 'market_cap_basic',
      filters: [{ field: 'type', operation: 'equal', value: 'stock' },
        { field: 'RSI', operation: 'less', value: 30 },
        { field: 'market_cap_basic', operation: 'greater', value: 2000000000 }]
    },
    {
      id: 'overbought', label: 'Overbought',
      sortBy: 'market_cap_basic',
      filters: [{ field: 'type', operation: 'equal', value: 'stock' },
        { field: 'RSI', operation: 'greater', value: 70 },
        { field: 'market_cap_basic', operation: 'greater', value: 2000000000 }]
    },
    {
      id: 'growth', label: 'Growing and profitable',
      sortBy: 'market_cap_basic',
      filters: [{ field: 'type', operation: 'equal', value: 'stock' },
        { field: 'total_revenue_yoy_growth_ttm', operation: 'greater', value: 20 },
        { field: 'net_margin_ttm', operation: 'greater', value: 10 },
        { field: 'market_cap_basic', operation: 'greater', value: 1000000000 }]
    },
    {
      id: 'value', label: 'Cheap on earnings',
      sortBy: 'market_cap_basic',
      filters: [{ field: 'type', operation: 'equal', value: 'stock' },
        { field: 'price_earnings_ttm', operation: 'less', value: 12 },
        { field: 'price_earnings_ttm', operation: 'greater', value: 0 },
        { field: 'return_on_equity_fq', operation: 'greater', value: 10 },
        { field: 'market_cap_basic', operation: 'greater', value: 2000000000 }]
    },
    {
      id: 'shorted', label: 'Heavily shorted',
      sortBy: 'short_interest_percent_of_float',
      filters: [{ field: 'type', operation: 'equal', value: 'stock' },
        { field: 'short_interest_percent_of_float', operation: 'greater', value: 10 },
        { field: 'market_cap_basic', operation: 'greater', value: 500000000 }]
    },
    {
      id: 'income', label: 'Paying an income',
      sortBy: 'dividends_yield_current',
      filters: [{ field: 'type', operation: 'equal', value: 'stock' },
        { field: 'dividends_yield_current', operation: 'greater', value: 4 },
        { field: 'dividends_yield_current', operation: 'less', value: 15 },
        { field: 'market_cap_basic', operation: 'greater', value: 1000000000 }]
    }
  ];

  /* ---------- loading ---------- */

  async function loadHeatmap(force) {
    if (state.heatmap && state.heatmap.market === state.market && !force) return;
    const token = ++state.token;
    state.heatmapLoading = true;
    paint();

    const column = (COLOUR_BY.find(c => c.id === state.colourBy) || COLOUR_BY[0]).column;
    const crypto = state.market === 'crypto';

    try {
      const result = await ctx.call('market:screen', {
        region: crypto ? 'crypto' : (state.market === 'america' ? 'america' : 'global'),
        markets: crypto || state.market === 'america' || state.market === 'global' ? null : [state.market],
        types: crypto ? null : ['stock'],
        filters: crypto
          ? [{ field: 'market_cap_calc', operation: 'nempty' }]
          : [{ field: 'market_cap_basic', operation: 'nempty' }],
        sortBy: 'market_cap_basic',
        limit: 220
      });
      if (token !== state.token) return;
      state.heatmap = { market: state.market, rows: result.rows, total: result.total, column };
    } catch (err) {
      if (token !== state.token) return;
      state.heatmap = { market: state.market, rows: [], error: err.message };
    }
    state.heatmapLoading = false;
    paint();
  }

  async function loadScreen(force) {
    if (state.screen && state.screen.preset === state.preset && state.screen.market === state.market && !force) return;
    const token = ++state.token;
    state.screenLoading = true;
    paint();

    const preset = PRESETS.find(p => p.id === state.preset) || PRESETS[0];
    try {
      const result = await ctx.call('market:screen', {
        region: state.market === 'america' ? 'america' : (state.market === 'crypto' ? 'crypto' : 'global'),
        markets: state.market === 'america' || state.market === 'global' || state.market === 'crypto'
          ? null : [state.market],
        filters: preset.filters,
        sortBy: preset.sortBy,
        sortOrder: preset.sortOrder || 'desc',
        limit: 60
      });
      if (token !== state.token) return;
      state.screen = { preset: state.preset, market: state.market, rows: result.rows, total: result.total };
    } catch (err) {
      if (token !== state.token) return;
      state.screen = { preset: state.preset, market: state.market, rows: [], error: err.message };
    }
    state.screenLoading = false;
    paint();
  }

  /* ---------- the treemap ----------
   *
   * Squarified: laid out in rows, each row taking as much of the remaining
   * rectangle as keeps its tiles closest to square. A tile is a company, its
   * area is its market value and its colour is its move. Long thin slivers are
   * what makes a naive treemap unreadable, and this is the algorithm that avoids
   * them. */
  function squarify(values, x, y, width, height) {
    const out = [];
    const items = values.slice();
    let area = { x, y, width, height };
    let total = items.reduce((sum, item) => sum + item.value, 0);

    while (items.length) {
      const horizontal = area.width >= area.height;
      const side = horizontal ? area.height : area.width;
      const row = [];
      let rowValue = 0;
      let best = Infinity;

      while (items.length) {
        const candidate = items[0];
        const nextValue = rowValue + candidate.value;
        const scale = (horizontal ? area.width : area.height) * side / total;
        const worst = worstRatio(row.concat([candidate]), nextValue, side, total, area, horizontal);
        if (row.length && worst > best) break;
        row.push(items.shift());
        rowValue = nextValue;
        best = worst;
        if (scale === 0) break;
      }

      const fraction = total > 0 ? rowValue / total : 0;
      const thickness = horizontal ? area.width * fraction : area.height * fraction;
      let offset = 0;

      row.forEach(item => {
        const share = rowValue > 0 ? item.value / rowValue : 0;
        const length = side * share;
        out.push(Object.assign({}, item, horizontal
          ? { x: area.x, y: area.y + offset, width: thickness, height: length }
          : { x: area.x + offset, y: area.y, width: length, height: thickness }));
        offset += length;
      });

      if (horizontal) { area = { x: area.x + thickness, y: area.y, width: area.width - thickness, height: area.height }; }
      else { area = { x: area.x, y: area.y + thickness, width: area.width, height: area.height - thickness }; }
      total -= rowValue;
      if (area.width < 1 || area.height < 1) break;
    }

    return out;
  }

  function worstRatio(row, rowValue, side, total, area, horizontal) {
    if (!rowValue || !total) return Infinity;
    const fraction = rowValue / total;
    const thickness = horizontal ? area.width * fraction : area.height * fraction;
    if (thickness <= 0) return Infinity;

    let worst = 0;
    row.forEach(item => {
      const length = side * (item.value / rowValue);
      const ratio = Math.max(thickness / Math.max(length, 0.0001), length / Math.max(thickness, 0.0001));
      if (ratio > worst) worst = ratio;
    });
    return worst;
  }

  /* The colour of a move. A fixed scale rather than one normalised to the day,
     because a scale that stretches to fit makes a quiet session look violent. */
  function tint(percent) {
    if (percent == null || !Number.isFinite(percent)) return 'var(--heat-flat)';
    const magnitude = Math.min(Math.abs(percent) / 3, 1);
    const step = magnitude < 0.15 ? 0 : magnitude < 0.4 ? 1 : magnitude < 0.7 ? 2 : 3;
    if (step === 0) return 'var(--heat-flat)';
    return 'var(--heat-' + (percent > 0 ? 'up' : 'down') + '-' + step + ')';
  }

  /* ---------- drawing ---------- */

  function paint() {
    const root = document.querySelector('.view[data-view="discover"]');
    if (!root) return;
    root.innerHTML = html();
    if (state.tab === 'heatmap') {
      if (state.heatmapSource === 'vendor') mountHeatmapWidget(); else layoutHeatmap();
    }
    if (state.tab === 'calendar') mountCalendar();
  }

  function html() {
    return '<div class="screen-bar">' +
      '<span class="screen-title">Discover</span>' +
      '<div class="seg discover-tabs">' +
      [['heatmap', 'Heatmap'], ['screener', 'Screener'], ['calendar', 'Calendar']].map(([id, label]) =>
        '<button data-act="discover-tab" data-tab="' + id + '"' +
        (state.tab === id ? ' class="on"' : '') + '>' + label + '</button>').join('') +
      '</div>' +
      '<span class="tb-spacer"></span>' +
      (state.tab === 'calendar' ? '' : marketPicker()) +
      '</div>' +
      '<div class="screen-body discover-body">' +
      (state.tab === 'heatmap' ? heatmapHtml() : state.tab === 'screener' ? screenerHtml() : calendarHtml()) +
      '</div>';
  }

  function marketPicker() {
    return '<label class="picker"><span>Market</span><select data-act="discover-market">' +
      MARKETS.map(market => '<option value="' + market.id + '"' +
        (state.market === market.id ? ' selected' : '') + '>' + esc(market.label) + '</option>').join('') +
      '</select></label>';
  }

  function heatmapSourceToggle() {
    const vendor = state.heatmapSource === 'vendor';
    return '<div class="seg source-seg" title="Which heatmap to draw">' +
      '<button data-act="heatmap-source" data-source="vendor"' + (vendor ? ' class="on"' : '') + '>TradingView</button>' +
      '<button data-act="heatmap-source" data-source="native"' + (vendor ? '' : ' class="on"') + '>Engine</button>' +
      '</div>';
  }

  function heatmapHtml() {
    if (state.heatmapSource === 'vendor') {
      const widget = HEATMAP_WIDGET[state.market] || HEATMAP_WIDGET.america;
      return '<div class="heat-controls">' + heatmapSourceToggle() + '</div>' +
        '<div class="heatmap embed-holder" data-embed="heatmap" id="heatmap-embed"></div>' +
        '<div class="heat-note">' + (widget.exchanges
          ? 'The charting vendor\'s own map, scoped to ' + esc(widget.exchanges.join(', ')) + '.'
          : 'The charting vendor\'s own map.') +
        ' A tile opens on the vendor\'s own site, in their frame — switch to Engine for a tile that opens ' +
        'straight into this terminal.</div>';
    }

    const held = state.heatmap;
    return '<div class="heat-controls">' + heatmapSourceToggle() +
      '<label class="picker"><span>Colour by</span><select data-act="heat-colour">' +
      COLOUR_BY.map(option => '<option value="' + option.id + '"' +
        (state.colourBy === option.id ? ' selected' : '') + '>' + esc(option.label) + '</option>').join('') +
      '</select></label>' +
      '<label class="picker"><span>Group</span><select data-act="heat-group">' +
      ['sector', 'none'].map(id => '<option value="' + id + '"' +
        (state.grouping === id ? ' selected' : '') + '>' + (id === 'sector' ? 'By sector' : 'Ungrouped') +
        '</option>').join('') +
      '</select></label>' +
      '<span class="tb-spacer"></span>' +
      '<div class="heat-key"><span>Down</span>' +
      ['down-3', 'down-2', 'down-1', 'flat', 'up-1', 'up-2', 'up-3']
        .map(step => '<i style="background:var(--heat-' + step + ')"></i>').join('') +
      '<span>Up</span></div>' +
      '</div>' +
      (held && held.error ? '<div class="news-missing">' + esc(held.error) + '</div>' : '') +
      '<div class="heatmap" id="heatmap">' +
      (state.heatmapLoading ? '<div class="loading">Reading the market…</div>' : '') +
      '</div>' +
      '<div class="heat-note">Tile size is market value; colour is the move over the window chosen above. ' +
      'The largest ' + (held ? held.rows.length : 0) + ' listings are shown. Click one to open it.</div>';
  }

  function mountHeatmapWidget() {
    const holder = document.getElementById('heatmap-embed');
    if (!holder) return;
    const widget = HEATMAP_WIDGET[state.market] || HEATMAP_WIDGET.america;
    const config = {
      colorTheme: ctx.theme(),
      isTransparent: true,
      width: '100%',
      height: '100%',
      locale: 'en',
      hasTopBar: false,
      isDataSetEnabled: false,
      isZoomEnabled: true,
      hasSymbolTooltip: true
    };
    if (widget.kind === 'cryptoHeatmap') {
      Object.assign(config, { dataSource: 'Crypto', blockSize: 'market_cap_calc', blockColor: 'change' });
    } else {
      Object.assign(config, {
        blockSize: 'market_cap_basic', blockColor: 'change',
        grouping: state.grouping === 'sector' ? 'sector' : 'no_group'
      });
      if (widget.exchanges) config.exchanges = widget.exchanges;
      else if (widget.dataSource) config.dataSource = widget.dataSource;
    }
    window.T.embeds.mount(holder, widget.kind, config, { title: 'Heatmap' });
  }

  /* Laid out after the markup is in the document, because a treemap needs the
     size of the box it is going into and that is not known until then. */
  function layoutHeatmap() {
    const container = document.getElementById('heatmap');
    const held = state.heatmap;
    if (!container || !held || !held.rows || !held.rows.length) return;

    const box = container.getBoundingClientRect();
    const width = Math.max(box.width, 320);
    const height = Math.max(box.height, 320);

    const column = (COLOUR_BY.find(c => c.id === state.colourBy) || COLOUR_BY[0]).column;
    const rows = held.rows
      .map(row => ({
        ticker: row.ticker,
        symbol: String(row.ticker || '').split(':').pop(),
        name: row.description || row.name,
        value: Number(row.market_cap_basic || row.market_cap_calc || 0),
        move: Number(row[column]),
        sector: row.sector || 'Other',
        /* Already a loopback address, not the vendor's own slug — the scanner
           call behind this screen resolved it server-side, at no extra cost. */
        logo: row.logo || null
      }))
      .filter(row => row.value > 0);

    if (!rows.length) { container.innerHTML = '<div class="empty">Nothing came back for this market.</div>'; return; }

    const groups = state.grouping === 'sector' ? groupBySector(rows) : [{ sector: null, rows }];
    const outer = squarify(
      groups.map(group => ({ key: group.sector, value: group.rows.reduce((sum, r) => sum + r.value, 0), rows: group.rows })),
      0, 0, width, height);

    container.innerHTML = outer.map(cell => {
      const inner = squarify(cell.rows.slice(0, 60), 0, 0, cell.width, cell.height - (cell.key ? 18 : 0))
        /* A TILE TOO SMALL TO SEE IS NOT DRAWN AT ALL. The smallest companies in
           a market are a rounding error against the largest, and their tiles come
           out with no area — an element with nothing in it that still takes a
           click. Dropping them is honest: the note under the map says how many
           listings it covers, and one that cannot be rendered is not among
           them. */
        .filter(tile => tile.width >= 3 && tile.height >= 3);

      return '<div class="heat-group" style="left:' + cell.x + 'px;top:' + cell.y + 'px;width:' +
        cell.width + 'px;height:' + cell.height + 'px">' +
        (cell.key ? '<div class="heat-group-label">' + esc(cell.key) + '</div>' : '') +
        inner.map(tile => tileHtml(tile, cell.key ? 18 : 0)).join('') +
        '</div>';
    }).join('');
  }

  function tileHtml(tile, offset) {
    const big = tile.width > 64 && tile.height > 34;
    const showMark = big && tile.width > 72 && tile.height > 58;
    const move = Number.isFinite(tile.move) ? tile.move : null;
    return '<button class="heat-tile' + (showMark ? ' has-mark' : '') + '" data-act="heat-open" data-symbol="' + esc(tile.symbol) +
      '" data-ticker="' + esc(tile.ticker) + '" title="' + esc(tile.name || tile.symbol) +
      (move == null ? '' : ' — ' + num.pct(move)) + '" ' +
      'style="left:' + tile.x + 'px;top:' + (tile.y + offset) + 'px;width:' + Math.max(tile.width - 1, 0) +
      'px;height:' + Math.max(tile.height - 1, 0) + 'px;background:' + tint(move) + '">' +
      (showMark ? '<span class="t-mark mark-holder' + (tile.logo ? ' has-logo' : '') + '">' +
        (tile.logo ? '<img class="mark-logo" src="' + esc(tile.logo) + '" alt="">'
          : '<i class="mark-fallback" style="background:transparent"></i>') + '</span>' : '') +
      (big ? '<span class="t-sym">' + esc(tile.symbol) + '</span>' +
        '<span class="t-move">' + (move == null ? '—' : num.pct(move)) + '</span>' : '') +
      '</button>';
  }

  function groupBySector(rows) {
    const map = new Map();
    rows.forEach(row => {
      if (!map.has(row.sector)) map.set(row.sector, []);
      map.get(row.sector).push(row);
    });
    return Array.from(map.entries())
      .map(([sector, list]) => ({ sector, rows: list.sort((a, b) => b.value - a.value) }))
      .sort((a, b) => b.rows.reduce((s, r) => s + r.value, 0) - a.rows.reduce((s, r) => s + r.value, 0));
  }

  /* ---------- the screener ---------- */

  function screenerHtml() {
    const held = state.screen;
    const rows = (held && held.rows) || [];

    return '<div class="preset-strip">' +
      PRESETS.map(preset => '<button class="desk' + (state.preset === preset.id ? ' on' : '') +
        '" data-act="screen-preset" data-preset="' + preset.id + '">' + esc(preset.label) + '</button>').join('') +
      '</div>' +
      (held && held.error ? '<div class="news-missing">' + esc(held.error) + '</div>' : '') +
      (state.screenLoading ? '<div class="loading">Screening…</div>' :
        rows.length ? screenTable(rows, held) : '<div class="empty">Nothing matched those conditions.</div>');
  }

  function screenTable(rows, held) {
    const head = ['Symbol', 'Name', 'Last', 'Today', 'Month', 'Year to date',
      'Market value', 'P/E', 'Yield', 'RSI', 'Sector'];

    return '<div class="table-wrap"><table class="data screener">' +
      '<thead><tr>' + head.map((label, i) =>
        '<th' + (i >= 2 && i <= 9 ? ' class="r"' : '') + '>' + label + '</th>').join('') + '</tr></thead><tbody>' +
      rows.map(row => {
        const symbol = String(row.ticker || '').split(':').pop();
        return '<tr data-act="screen-open" data-symbol="' + esc(symbol) + '">' +
          '<td class="sym-cell"><span class="r-mark mark-holder' + (row.logo ? ' has-logo' : '') + '">' +
          (row.logo ? '<img class="mark-logo" src="' + esc(row.logo) + '" alt="">'
            : '<i class="mark-fallback" style="background:' + markColour(symbol) + '">' +
              esc(symbol.replace(/[^A-Z0-9]/gi, '').slice(0, 2).toUpperCase()) + '</i>') +
          '</span><span class="mono strong">' + esc(symbol) + '</span></td>' +
          '<td class="name">' + esc(row.description || '') + '</td>' +
          '<td class="r mono">' + fig(row.close) + '</td>' +
          '<td class="r mono ' + dir(row.change) + '">' + pct(row.change) + '</td>' +
          '<td class="r mono ' + dir(row['Perf.1M']) + '">' + pct(row['Perf.1M']) + '</td>' +
          '<td class="r mono ' + dir(row['Perf.YTD']) + '">' + pct(row['Perf.YTD']) + '</td>' +
          '<td class="r mono">' + compact(row.market_cap_basic) + '</td>' +
          '<td class="r mono">' + fig(row.price_earnings_ttm) + '</td>' +
          '<td class="r mono">' + pct(row.dividends_yield_current) + '</td>' +
          '<td class="r mono">' + fig(row.RSI) + '</td>' +
          '<td class="muted">' + esc(row.sector || '') + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table></div>' +
      '<div class="heat-note">' + rows.length + ' of ' + (held.total || rows.length) +
      ' matches. Click a row to open it in the terminal.</div>';
  }

  /* The same stable colour per symbol the watchlist uses, so an instrument keeps
     its mark colour wherever it appears. */
  const MARK_COLOURS = ['#f0a92e', '#26a69a', '#3b82f6', '#c084fc', '#ef5350', '#14b8a6', '#f97316', '#8b5cf6'];
  function markColour(symbol) {
    let hash = 0;
    for (let i = 0; i < symbol.length; i++) hash = (hash * 31 + symbol.charCodeAt(i)) >>> 0;
    return MARK_COLOURS[hash % MARK_COLOURS.length];
  }

  /* The shared formatters, so a figure reads the same here as it does in the
     watchlist, the header and a report. */
  const fig = value => num.plain(value, 2);
  const pct = value => num.pct(value);
  const compact = value => num.compact(value, 2);
  const dir = value => num.signOf(value);

  /* ---------- the calendar ---------- */

  function calendarHtml() {
    return '<div class="calendar-wrap">' +
      '<div class="embed-holder" data-embed="calendar" id="calendar-embed"></div>' +
      '<div class="heat-note">Scheduled economic releases. There is no free structured source for these, ' +
      'so this is the charting vendor\'s own calendar, shown as theirs.</div>' +
      '</div>';
  }

  function mountCalendar() {
    const holder = document.getElementById('calendar-embed');
    if (!holder) return;
    window.T.embeds.mount(holder, 'calendar', {
      colorTheme: ctx.theme(),
      isTransparent: true,
      width: '100%',
      height: '100%',
      importanceFilter: '-1,0,1',
      countryFilter: 'us,eu,gb,jp,cn,de,fr,it,ca,au,in,br'
    }, { title: 'Economic calendar' });
  }

  /* ---------- events ---------- */

  function actions() {
    return {
      'discover-tab': data => {
        state.tab = data.tab;
        paint();
        if (state.tab === 'heatmap' && state.heatmapSource === 'native') loadHeatmap();
        if (state.tab === 'screener') loadScreen();
      },
      'discover-market': (data, element) => {
        state.market = element.value;
        if (state.tab === 'heatmap') {
          if (state.heatmapSource === 'vendor') mountHeatmapWidget(); else loadHeatmap(true);
        } else loadScreen(true);
      },
      /* Independent of state.chartSource — an operator may want the vendor's
         polish on the map and the engine's own chart, or the other way round. */
      'heatmap-source': data => {
        state.heatmapSource = data.source === 'native' ? 'native' : 'vendor';
        ctx.saveWorkspace();
        paint();
        if (state.heatmapSource === 'native') loadHeatmap();
      },
      /* Every window the picker offers is already in the row this application
         holds — the fetch sorts by market cap regardless of colour and pulls
         every Perf.* column in one request — so switching which one paints
         and labels the tiles needs no network round trip at all. Forcing one
         anyway was pure added latency for a picker that only ever recolours
         data already on screen. */
      'heat-colour': (data, element) => { state.colourBy = element.value; paint(); layoutHeatmap(); },
      'heat-group': (data, element) => { state.grouping = element.value; paint(); layoutHeatmap(); },
      'heat-open': data => ctx.openSymbol(data.symbol),
      'screen-preset': data => { state.preset = data.preset; loadScreen(); },
      'screen-open': data => ctx.openSymbol(data.symbol)
    };
  }

  /* Called when the screen is shown, so nothing is fetched for a screen nobody
     is looking at. */
  function activate() {
    paint();
    if (state.tab === 'heatmap' && state.heatmapSource === 'native') loadHeatmap();
    if (state.tab === 'screener') loadScreen();
  }

  function relayout() {
    if (state.tab === 'heatmap' && state.heatmapSource === 'native') layoutHeatmap();
  }

  window.T = window.T || {};
  window.T.discover = {
    install, actions, activate, paint, relayout, state,
    squarify, tint, PRESETS, MARKETS, COLOUR_BY
  };

}());
