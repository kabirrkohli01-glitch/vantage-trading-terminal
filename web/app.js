'use strict';
/* The interface.
 *
 * TWO RULES SHAPE THIS FILE.
 *
 *   A LIVE REGION IS UPDATED IN PLACE, NEVER REBUILT. Rebuilding a watchlist
 *   from markup on every tick restarts every entrance animation at once, throws
 *   away scroll position and any open control, and destroys anything slower
 *   than the poll before it can finish. Rows are created once; a tick writes
 *   textContent and toggles a class.
 *
 *   EVERY CONTROL IS DISPATCHED FROM ONE TABLE. The content policy forbids
 *   inline handlers, so a control carries a data-act attribute and one
 *   delegated listener runs it. A control whose action is missing from ACTIONS
 *   does nothing at all, silently — which is why the architecture suite fails
 *   when the markup and this table disagree.
 */

(function () {

  const bridge = window.terminal;
  const num = window.T.num;
  const clock = window.T.clock;
  const screens = window.T.screens;
  const research = window.T.research;

  const state = {
    view: 'chart',
    info: {},
    watchlists: [],
    activeList: null,
    symbol: null,
    quotes: new Map(),
    rows: new Map(),
    chart: null,
    draw: null,
    tool: 'cursor',
    drawings: {},
    /* Daily bars over a year, which is what a chart opens on everywhere else. */
    chartRange: '1Y',
    chartInterval: '1d',
    servedTimeframe: null,
    intervals: {},
    intervalsFor: null,
    seriesType: 'candle',
    indicators: [{ id: 'volume' }],
    detailTab: 'overview',
    summary: new Map(),
    news: new Map(),
    reference: new Map(),
    filings: new Map(),
    /* Company marks, once resolved. Held because the instrument header is
       rebuilt on every quote and would otherwise lose its logo a second after
       gaining it. A null means the vendor publishes none — a pair has no single
       mark — and is remembered too, so it is not asked for again. */
    logos: new Map(),
    marketNews: null,
    panels: {},
    bottomTab: 'positions',
    ticketSide: 'buy',
    ticketType: 'market',
    paper: null,
    safeMode: { active: false },
    legendBase: '',
    legendChange: ''
  };

  /* ---------- helpers ---------- */

  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function patch(id, html) {
    const node = document.getElementById(id);
    if (!node || node.innerHTML === html) return;
    node.innerHTML = html;
  }

  async function call(channel, payload) {
    const result = await bridge.invoke(channel, payload || {});
    if (!result || !result.ok) {
      const error = new Error((result && result.error) || 'That did not work.');
      error.kind = result && result.kind;
      throw error;
    }
    return result.data;
  }

  /* A passing note, in the corner.
   *
   * These used to borrow the safe-data banner, which spans the top of the
   * workspace in alarm red and covers the instrument header while it is up. A
   * note that a watchlist gained a symbol was then indistinguishable from a
   * data-integrity failure, and it sat over the chart to say so. Notes belong
   * out of the way, in the corner the eye is not using, and they leave on their
   * own. The banner is kept for what it is actually for. */
  function toast(message, bad) {
    let stack = document.getElementById('toasts');
    if (!stack) {
      stack = el('div', 'toast-stack');
      stack.id = 'toasts';
      document.body.appendChild(stack);
    }

    const note = el('div', 'toast' + (bad ? ' bad' : ''));
    note.appendChild(el('span', 'txt', message));
    const close = el('button', 'toast-x');
    close.innerHTML = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" ' +
      'stroke-width="1.4" stroke-linecap="round"><path d="M2 2l8 8M10 2l-8 8"/></svg>';
    close.addEventListener('click', () => dismiss());
    note.appendChild(close);
    stack.appendChild(note);

    /* Oldest first out, so a burst cannot fill the corner. */
    while (stack.children.length > 4) stack.firstChild.remove();

    let gone = false;
    const dismiss = () => {
      if (gone) return;
      gone = true;
      note.classList.add('leaving');
      setTimeout(() => note.remove(), 220);
    };
    setTimeout(dismiss, 5000);
  }

  /* ---------- panel geometry ----------
   *
   * Every panel edge is a drag handle. Sizes live in CSS custom properties on
   * the root element rather than in inline styles on each panel, so one write
   * moves the edge and the grid rearranges itself; nothing has to be told what
   * its new size is, and no two panels can end up disagreeing about where the
   * border between them runs.
   *
   * `sign` is which way the number goes when the pointer goes right or down. A
   * panel anchored to the right or the bottom grows as the handle moves the
   * other way, and getting that backwards is what makes a splitter feel as if
   * it is fighting the hand holding it. */

  const SPLITTERS = {
    side: { prop: '--side-w', axis: 'x', sign: -1, min: 232, max: () => window.innerWidth * 0.55 },
    ticket: { prop: '--ticket-w', axis: 'x', sign: -1, min: 224, max: () => window.innerWidth * 0.5 },
    bottom: { prop: '--bottom-h', axis: 'y', sign: -1, min: 74, max: () => window.innerHeight * 0.78 },
    /* The watchlist shares the right-hand column with the research panel, so
       its ceiling leaves room for that panel to exist at all. */
    watchlist: { prop: '--wl-h', axis: 'y', sign: 1, min: 54, max: () => Math.max(80, window.innerHeight - 320) },
    /* The assistant docks against the right edge of the whole shell rather than
       inside the workspace, so it stays where it is while screens change. */
    syrix: { prop: '--syrix-w', axis: 'x', sign: -1, min: 300, max: () => window.innerWidth * 0.6 }
  };

  function panelSize(spec) {
    const held = state.panels[spec.prop];
    if (Number.isFinite(held)) return held;
    const raw = getComputedStyle(document.documentElement).getPropertyValue(spec.prop);
    return parseFloat(raw) || spec.min;
  }

  function setPanelSize(spec, value) {
    const clamped = Math.max(spec.min, Math.min(spec.max(), value));
    state.panels[spec.prop] = clamped;
    document.documentElement.style.setProperty(spec.prop, clamped + 'px');
  }

  function applyPanels() {
    /* A REMEMBERED SIZE IS CLAMPED TO THE WINDOW IT IS BEING RESTORED INTO.
     *
     * Sizes are saved in pixels, and the window they were saved on is not
     * necessarily the window they come back to — a second monitor, a resize, or
     * a layout that was briefly broken when the size was chosen. Writing the
     * stored number back unchecked is how a watchlist ends up five hundred
     * pixels tall in a column four hundred pixels high: the panel is there, it
     * is simply taller than the space and everything below it is crushed out of
     * sight. The same bounds the drag uses apply here. */
    Object.keys(SPLITTERS).forEach(key => {
      const spec = SPLITTERS[key];
      const held = state.panels[spec.prop];
      if (!Number.isFinite(held)) return;
      const clamped = Math.max(spec.min, Math.min(spec.max(), held));
      state.panels[spec.prop] = clamped;
      document.documentElement.style.setProperty(spec.prop, clamped + 'px');
    });

    /* Which panels were closed or collapsed is part of the arrangement too. An
       operator who shut the ticket to give the blotter the width does not want
       it back on the next start. */
    const flags = state.panelFlags || {};
    const main = document.querySelector('.ws-main');
    const workspace = document.querySelector('.view.workspace');
    ['no-bottom', 'bottom-collapsed', 'bottom-max'].forEach(name =>
      main.classList.toggle(name, (flags.wsMain || []).indexOf(name) !== -1));
    workspace.classList.toggle('side-hidden', !!flags.sideHidden);
    (flags.collapsed || []).forEach(id => {
      const block = document.getElementById(id);
      if (block) block.classList.add('collapsed');
    });
  }

  function readPanelFlags() {
    const main = document.querySelector('.ws-main');
    state.panelFlags = {
      wsMain: ['no-bottom', 'bottom-collapsed', 'bottom-max'].filter(n => main.classList.contains(n)),
      sideHidden: document.querySelector('.view.workspace').classList.contains('side-hidden'),
      collapsed: $$('.side-block.collapsed').map(b => b.id).filter(Boolean)
    };
    saveWorkspace();
  }

  function beginResize(handle, event) {
    const spec = SPLITTERS[handle.dataset.resize];
    if (!spec) return;
    event.preventDefault();

    const startX = event.clientX;
    const startY = event.clientY;
    const startSize = panelSize(spec);

    handle.classList.add('dragging');
    document.body.classList.add(spec.axis === 'x' ? 'resizing-col' : 'resizing-row');
    try { handle.setPointerCapture(event.pointerId); } catch (e) { /* synthetic event */ }

    const move = moved => {
      const delta = spec.axis === 'x' ? moved.clientX - startX : moved.clientY - startY;
      setPanelSize(spec, startSize + spec.sign * delta);
    };

    const finish = ended => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing-col', 'resizing-row');
      try { handle.releasePointerCapture(ended.pointerId); } catch (e) { /* already released */ }
      saveWorkspace();
    };

    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  /* ---------- formatting, shared with the main process ---------- */

  function priceOf(model, value) {
    return num.money(value === undefined ? model.quote.last : value, {
      currency: model.currency,
      assetClass: model.assetClass,
      decimals: model.priceHint == null ? undefined : model.priceHint,
      unit: model.isYield ? 'percent' : undefined
    });
  }

  function changeOf(model) {
    const pct = num.changePct(model.quote.last, model.quote.previousClose);
    const absolute = (model.quote.last != null && model.quote.previousClose != null)
      ? model.quote.last - model.quote.previousClose : null;
    return {
      pct, absolute,
      direction: num.signOf(pct),
      pctText: num.pct(pct),
      absText: absolute == null ? '—' : num.change(absolute, {
        currency: model.currency, assetClass: model.assetClass,
        decimals: model.priceHint == null ? undefined : model.priceHint,
        unit: model.isYield ? 'percent' : undefined
      })
    };
  }

  const ARROW = { up: '▲', down: '▼', flat: '·' };

  function badgeHtml(freshness, bare) {
    if (!freshness) return '';
    return '<span class="badge' + (bare ? ' bare' : '') + '" data-state="' + esc(freshness.state) +
      '" title="' + esc(freshness.reason || '') + '"><span class="dot"></span>' +
      esc(freshness.label) + '</span>';
  }

  /* A stable colour per symbol for the watchlist marks, so a row is
     recognisable before its text is read. */
  const MARK_COLOURS = ['#f0a92e', '#26a69a', '#3b82f6', '#c084fc', '#ef5350', '#14b8a6', '#f97316', '#8b5cf6'];
  function markFor(symbol) {
    let hash = 0;
    for (let i = 0; i < symbol.length; i++) hash = (hash * 31 + symbol.charCodeAt(i)) >>> 0;
    return MARK_COLOURS[hash % MARK_COLOURS.length];
  }

  /* The mark that stands in for an instrument, so a row is recognisable before
     its text is read. The company's own logo where the vendor publishes one,
     and its initials on a colour derived from the symbol until it arrives or
     when there is none. */
  /* The larger mark, for the instrument header and the detail column. Same
     hook as every other mark on screen, so one request fills all of them. */
  function instLogo(model) {
    const symbol = model.symbol || '';
    const initials = symbol.replace(/[^A-Z0-9]/gi, '').slice(0, 2).toUpperCase() || symbol.slice(0, 2);
    const known = knownMark(symbol);
    return '<div class="inst-logo mark-holder' + (known ? ' has-logo' : '') +
      '" data-logo-for="' + esc(symbol) + '">' +
      (known || '<i class="mark-fallback" style="background:' + markFor(symbol) + '">' +
        esc(initials) + '</i>') + '</div>';
  }

  function instrumentMark(model) {
    const symbol = model.symbol || '';
    const initials = symbol.replace(/[^A-Z0-9]/gi, '').slice(0, 2).toUpperCase() || symbol.slice(0, 2);
    const known = knownMark(symbol);
    return '<span class="inst-mark" data-logo-for="' + esc(symbol) + '">' +
      '<span class="mark-holder' + (known ? ' has-logo' : '') + '">' +
      (known || '<i class="mark-fallback" style="background:' + markFor(symbol) + '">' + esc(initials) + '</i>') +
      '</span><b class="mono">' + esc(symbol) + '</b></span>';
  }

  /* ---------- boot ---------- */

  async function boot() {
    screens.install({ call, esc, selectedSymbol: () => state.symbol, toast });

    /* The screens that own their own markup are handed the few things they need
       from the shell and nothing else: a way to call the main process, a way to
       open an instrument, a way to hand something to the assistant, the same
       modal every menu in the shell already opens through rather than a second
       popover mechanism, and the same company-mark fetch and swap-in the
       watchlist and the header use, so a screen that draws its own tiles or
       rows does not grow a second copy of the caching and load-failure rules. */
    const shared = {
      call, toast,
      theme: () => document.documentElement.getAttribute('data-theme') || 'dark',
      openSymbol: symbol => selectSymbol(symbol).then(() => ACTIONS.view({ view: 'chart' })),
      openExternally: url => window.open(url, '_blank', 'noopener'),
      askAssistant: question => window.T.syrix.askFrom(question),
      saveWorkspace,
      paintLogos, openModal, closeModal
    };

    window.T.embeds.install(shared);
    window.T.newsroom.install(shared);
    window.T.discover.install(shared);
    window.T.dashboard.install(shared);
    window.T.syrix.install(shared);
    research.install({
      call, toast,
      renderSources: refreshSources,
      rangeMeters: rangeMetersHtml,
      fundamentalsFor, loadFundamentals,
      newsFor, loadNews,
      referenceFor, loadReference,
      filingsFor, loadFilings,
      /* The panel checks both before it paints an answer that arrived late: the
         operator may have changed instrument or tab while a feed was in
         flight, and writing a stale answer into the panel they are looking at
         now is worse than not answering at all. */
      activeSymbol: () => state.symbol,
      activeTab: () => state.detailTab
    });

    const info = await call('app:info');
    state.info = info;
    $('#brand-name').textContent = info.name;
    document.title = info.name;
    $('#credit').innerHTML = esc(info.credit).replace(/(SYRIX|Kabirr Wealth Partners)/g, '<strong>$1</strong>');
    $('#made-by').textContent = info.attribution;

    const theme = await call('theme:get').catch(() => ({ mode: 'dark' }));
    applyTheme(theme.mode === 'light' ? 'light' : 'dark');

    const layout = await call('layout:get').catch(() => ({}));
    state.drawings = (layout && layout.workspace && layout.workspace.drawings) || {};
    state.panels = (layout && layout.workspace && layout.workspace.panels) || {};
    state.panelFlags = (layout && layout.workspace && layout.workspace.panelFlags) || {};
    state.chartStyle = (layout && layout.workspace && layout.workspace.chartStyle) || {};
    state.chartSource = (layout && layout.workspace && layout.workspace.chartSource) || 'native';
    state.searchScope = (layout && layout.workspace && layout.workspace.searchScope) || 'all';
    if (window.T.discover) {
      window.T.discover.state.heatmapSource =
        (layout && layout.workspace && layout.workspace.heatmapSource) || 'vendor';
    }
    applyPanels();

    state.watchlists = await call('watchlist:list');
    state.activeList = state.watchlists[0] || null;
    await loadWatchlist();

    /* Which build this window is running, in the status bar, so "nothing
       changed" can be checked rather than argued about. */
    const stamp = document.getElementById('build-stamp');
    if (stamp && info.builtAt) {
      stamp.textContent = 'Build ' + clock.asOf(info.builtAt);
      stamp.title = 'The code in this window was last changed at ' +
        new Date(info.builtAt).toLocaleString() + '.';
    }

    bridge.on('market:update', onMarketUpdate);
    bridge.on('market:safemode', onSafeMode);
    bridge.on('app:stale', onStaleBuild);
    bridge.on('alert:fired', onAlertFired);
    bridge.on('workspace:symbol', payload => {
      if (payload && payload.symbol && payload.symbol !== state.symbol) selectSymbol(payload.symbol, true);
    });

    const first = (state.activeList && state.activeList.symbols[0]) || 'NVDA';
    await selectSymbol(first);

    renderTicket();
    renderBottom();
    if (layout && layout.workspace && layout.workspace.syrixDocked) window.T.syrix.setDocked(true);
    refreshSyrixStatus();
    setInterval(tickStatus, 3000);
    tickStatus();
  }

  function applyTheme(mode) {
    document.documentElement.setAttribute('data-theme', mode);
    $$('[data-act="theme"]').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  }

  /* ---------- watchlist ---------- */

  async function loadWatchlist() {
    const container = $('#wl-rows');
    const symbols = (state.activeList && state.activeList.symbols) || [];
    container.innerHTML = '';
    state.rows.clear();

    if (!symbols.length) {
      container.appendChild(el('div', 'empty', 'This watchlist is empty.'));
      return;
    }

    symbols.forEach(symbol => {
      const row = el('div', 'wl-row');
      row.dataset.act = 'select';
      row.dataset.symbol = symbol;
      if (symbol === state.symbol) row.classList.add('on');

      const id = el('div', 'wl-id');
      const dot = el('div', 'wl-dot mark-holder');
      dot.dataset.logoFor = symbol;
      const initials = el('i', 'mark-fallback', symbol.replace(/[^A-Z0-9]/gi, '').slice(0, 2).toUpperCase() ||
        symbol.slice(0, 2));
      initials.style.background = markFor(symbol);
      dot.appendChild(initials);
      const txt = el('div', 'wl-txt');
      const sym = el('div', 'wl-sym');
      sym.appendChild(el('span', null, symbol));
      const badge = el('span', 'badge bare');
      badge.dataset.state = 'UNKNOWN';
      badge.style.display = 'none';
      badge.appendChild(el('span', 'dot'));
      sym.appendChild(badge);
      const name = el('div', 'wl-name', '—');
      txt.appendChild(sym);
      txt.appendChild(name);
      id.appendChild(dot);
      id.appendChild(txt);

      const price = el('div', 'wl-px', '—');
      const abs = el('div', 'wl-abs', '—');
      const chg = el('div', 'wl-chg', '—');

      row.appendChild(id);
      row.appendChild(price);
      row.appendChild(abs);
      row.appendChild(chg);
      container.appendChild(row);

      state.rows.set(symbol, { element: row, price, abs, chg, name, badge, last: null });
    });

    await call('market:subscribe', { symbols }).catch(() => {});
    const models = await call('market:quotes', { symbols }).catch(() => []);
    models.forEach(applyQuote);
    updateGlobalState();
    /* One request for the whole column's marks, after the rows are drawn. */
    paintLogos(symbols, container.parentElement || container);
  }

  function onMarketUpdate(models) {
    models.forEach(applyQuote);
    if (state.symbol) {
      const model = state.quotes.get(state.symbol);
      if (model) {
        renderInstrumentBar(model);

        /* The chart is brought forward with the header, not left at whatever
           the history request returned when the instrument was opened.
           Outside the regular session this is the pre- or post-market print
           when one is actually current — the engine.js chart's own gate
           (LIVE or DELAYED only) still decides whether the tick is honoured;
           this only decides WHICH figure is offered to it. */
        const forChart = chartFigure(model);
        if (state.chart && state.chart.applyQuote(forChart.quote, forChart.freshnessState)) {
          state.legendChange = legendChangeHtml(model);
          renderLegend(null);
          /* The open profit on the entry line moves with the price. */
          paintOrderLevels();
        }

        /* Only the tabs whose content actually moves with the price are
           repainted on a tick. Rebuilding a filed balance sheet because a
           quote arrived would throw away the reader's scroll position for no
           change in what it says. */
        if (state.detailTab === 'overview') renderSidePanel();
        else {
          const head = document.getElementById('detail-head');
          if (head) head.innerHTML = detailHeadHtml(model);
        }
      }
    }
    updateGlobalState();
    if (state.view === 'chart' && state.bottomTab === 'positions') renderBottom();
  }

  /* Which figure — the regular print or the extended one — actually
     represents "now". The extended print carries its own freshness (from
     the engine, computed against its own pre/post window); it is only
     offered in place of the regular print while that freshness says it is
     genuinely current, never merely because one is present. Outside that
     window, or when the session-gated endpoint could not be reached at all,
     this falls back to the regular quote exactly as it always did. */
  function chartFigure(model) {
    const extended = model.quote && model.quote.extended;
    const extFresh = extended && extended.freshness && extended.freshness.state;
    if (extended && (extFresh === 'LIVE' || extFresh === 'DELAYED')) {
      return {
        quote: Object.assign({}, model.quote, { last: extended.price, at: extended.at }),
        freshnessState: extFresh
      };
    }
    return { quote: model.quote, freshnessState: model.freshness && model.freshness.state };
  }

  function applyQuote(model) {
    state.quotes.set(model.symbol, model);
    const row = state.rows.get(model.symbol);
    if (!row) return;

    const change = changeOf(model);

    /* The direction of the tick itself, which is not the direction against
       yesterday's close: a falling instrument can still tick up. */
    if (row.last != null && model.quote.last != null && model.quote.last !== row.last) {
      const moved = model.quote.last > row.last ? 'tick-up' : 'tick-down';
      row.price.classList.remove('tick-up', 'tick-down');
      void row.price.offsetWidth;
      row.price.classList.add(moved);
    }
    row.last = model.quote.last;

    row.price.textContent = priceOf(model);
    row.abs.textContent = change.absText;
    row.abs.className = 'wl-abs ' + change.direction;
    row.chg.textContent = change.pctText;
    row.chg.className = 'wl-chg ' + change.direction;
    row.name.textContent = model.name || '—';

    if (model.freshness) {
      const noisy = model.freshness.state !== 'DELAYED' && model.freshness.state !== 'LIVE';
      row.badge.style.display = noisy ? '' : 'none';
      row.badge.dataset.state = model.freshness.state;
      row.badge.title = model.freshness.reason || '';
    }
  }

  /* ---------- instrument ---------- */

  async function selectSymbol(symbol, echoed) {
    state.symbol = symbol;
    state.rows.forEach((row, key) => row.element.classList.toggle('on', key === symbol));
    if (!echoed) call('workspace:select', { symbol }).catch(() => {});

    let model = state.quotes.get(symbol);
    if (!model) {
      $('#inst-bar').innerHTML = '<div class="loading">Loading ' + esc(symbol) + '…</div>';
      try {
        model = await call('market:quote', { symbol });
        state.quotes.set(symbol, model);
      } catch (err) {
        $('#inst-bar').innerHTML = '<div class="note-line bad">' + esc(err.message) + '</div>';
        return;
      }
    }

    renderInstrumentBar(model);
    renderChartBar();
    renderRangeBar();
    renderSidePanel();
    renderTicket();
    loadIntervals(symbol);
    /* One request fills every mark on screen for this instrument — the header,
       the detail column, and its watchlist row if it is on one. */
    paintLogos([symbol], document);
    await renderChartSurface();
  }

  function rangeMeter(label, low, high, value, model) {
    if (low == null || high == null || value == null || high <= low) return '';
    const share = Math.max(0, Math.min(1, (value - low) / (high - low)));
    return '<div class="range-meter"><div class="lbl"><span>' + esc(label) + '</span></div>' +
      '<div class="track"><div class="fill" style="width:' + (share * 100).toFixed(1) + '%"></div>' +
      '<div class="pin" style="left:calc(' + (share * 100).toFixed(1) + '% - 1px)"></div></div>' +
      '<div class="ends"><span>' + esc(priceOf(model, low)) + '</span><span>' + esc(priceOf(model, high)) + '</span></div></div>';
  }

  function renderInstrumentBar(model) {
    const change = changeOf(model);
    const f = model.freshness || {};

    let html =
      '<div class="inst-id">' +
        instLogo(model) +
        '<div><div class="inst-name">' + esc(model.symbol) + '</div>' +
        '<div class="inst-sub">' + esc(model.name || '') +
        (model.exchangeName ? ' · ' + esc(model.exchangeName) : '') + '</div></div>' +
      '</div>' +

      '<div class="inst-price"><div class="row1">' +
        '<span class="inst-last ' + change.direction + '">' + esc(priceOf(model)) + '</span>' +
        (model.currency && model.assetClass !== 'INDEX' && model.assetClass !== 'CURRENCY'
          ? '<span class="inst-ccy">' + esc(model.currency) + '</span>' : '') +
        '<span class="inst-chg ' + change.direction + '">' + esc(change.absText) + '  ' + esc(change.pctText) + '</span>' +
      '</div>' +
      '<div class="inst-after">' + badgeHtml(f, true) +
        (f.asOf ? ' <b>' + esc(f.asOf) + '</b>' : '') + '</div>' +
      extendedPriceHtml(model) +
      '</div>' +

      '<div class="inst-stats">' +
        rangeMeter('Day range', model.quote.dayLow, model.quote.dayHigh, model.quote.last, model) +
        rangeMeter('52-week range', model.quote.yearLow, model.quote.yearHigh, model.quote.last, model) +
        stat('Volume', num.compact(model.quote.volume)) +
        stat('Prev close', model.quote.previousClose == null ? '—' : priceOf(model, model.quote.previousClose)) +
        '<button class="icon-btn" data-act="add-to-watchlist" title="Add to the watchlist"><svg><use href="#i-star"></use></svg></button>' +
        '<button class="icon-btn" data-act="side-sources" title="Where these figures came from"><svg><use href="#i-more"></use></svg></button>' +
      '</div>';

    patch('inst-bar', html);
  }

  function stat(k, v) {
    return '<div class="inst-stat"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>';
  }

  /* The pre/post-market print, shown as its own line under the regular
     price rather than in place of it — the regular close is still the
     figure the day's range and every other statistic on this header is
     measured against, and replacing it would make the header disagree with
     itself. Shown whenever the venue currently declares one of these
     sessions and a usable price came back for it; its own freshness badge
     says whether it is still current or has stopped updating, exactly as
     the regular price's does. */
  function extendedPriceHtml(model) {
    const extended = model.quote && model.quote.extended;
    if (extended) {
      const dir = num.signOf(extended.changePercent);
      const label = extended.state === 'PRE' ? 'Pre-market' : 'Post-market';
      const fresh = extended.freshness || {};
      return '<div class="inst-extended">' +
        '<span class="inst-last sm ' + dir + '">' + esc(priceOf(model, extended.price)) + '</span>' +
        '<span class="inst-chg sm ' + dir + '">' + esc(extended.changePercent == null ? '—' : num.pct(extended.changePercent)) + '</span>' +
        badgeHtml(fresh, true) +
        '<span class="inst-ext-label">' + esc(label) + (fresh.asOf ? ' · ' + esc(fresh.asOf) : '') + '</span>' +
        '</div>';
    }

    /* The venue can genuinely be in one of these sessions while the print
       itself is unavailable — it comes from the same session-gated endpoint
       that can be refused for hours at a stretch. Said plainly rather than
       left blank, which reads as the feature not existing rather than as
       what it actually is: a figure the source is not giving up right now.
       Derived independently of that endpoint, from the venue's own trading
       windows, so it is right even while the endpoint behind the price is not
       answering at all. */
    const status = model.session && clock.statusAt(model.session);
    if (status === clock.STATUS.PRE || status === clock.STATUS.POST) {
      return '<div class="inst-extended muted-note">' +
        (status === clock.STATUS.PRE ? 'Pre-market' : 'After hours') +
        ' — no price from the venue right now.</div>';
    }
    return '';
  }

  /* ---------- detail column ---------- */

  /* The head of the panel is the identity and the price, and it is drawn for
     every tab. Only the body below it changes when a tab is chosen, so the
     instrument being read about never scrolls away. */
  function detailHeadHtml(model) {
    const change = changeOf(model);
    return '<div class="detail-head">' +
        instLogo(model) +
        '<div><div style="font-size:12.5px;font-weight:600">' + esc(model.name || model.symbol) + '</div>' +
        '<div class="muted" style="font-size:10.5px">' + esc(model.exchangeName || '') + '</div></div>' +
      '</div>' +
      '<div class="detail-price"><span class="p ' + change.direction + '">' + esc(priceOf(model)) + '</span>' +
      '<span class="c ' + change.direction + '">' + esc(change.absText) + ' ' + esc(change.pctText) + '</span></div>' +
      extendedPriceHtml(model);
  }

  function rangeMetersHtml(model) {
    return '<div style="padding:0 12px 4px">' +
      rangeMeter('Day range', model.quote.dayLow, model.quote.dayHigh, model.quote.last, model) +
      '</div><div style="padding:8px 12px 4px">' +
      rangeMeter('52-week range', model.quote.yearLow, model.quote.yearHigh, model.quote.last, model) +
      '</div>';
  }

  function renderSidePanel() {
    const model = state.quotes.get(state.symbol);
    patch('detail-tabs', research.tabsHtml(state.detailTab));
    const head = document.getElementById('detail-head');
    if (model && head) head.innerHTML = detailHeadHtml(model);
    research.render(state.detailTab, model, $('#detail-body'));
  }

  /* ---------- reference data, held per instrument ----------
   *
   * Held for a couple of minutes, not for the life of the session — flicking
   * between tabs on the same instrument should not spend the request budget on
   * an answer already in hand, but a company's accounts can genuinely change
   * under an operator who leaves a tab open: an earnings release lands, a
   * filing posts. An indefinite cache reported a quarter that had already come
   * out as still "next report", because nothing about looking at the same tab
   * again told it to ask again. `undefined` means never asked, or asked too
   * long ago to trust; `null` means asked and the source had nothing. */
  const REFERENCE_TTL = 2 * 60 * 1000;

  function freshEntry(map, symbol) {
    const entry = map.get(symbol);
    if (!entry || Date.now() - entry.at > REFERENCE_TTL) return undefined;
    return entry.data;
  }

  function fundamentalsFor(symbol) { return freshEntry(state.summary, symbol); }

  async function loadFundamentals(symbol) {
    const data = await call('market:fundamentals', { symbol });
    state.summary.set(symbol, { data, at: Date.now() });
    return data;
  }

  function newsFor(symbol) { return freshEntry(state.news, symbol); }

  async function loadNews(symbol) {
    const data = await call('market:news', { symbol, limit: 30 });
    state.news.set(symbol, { data, at: Date.now() });
    return data;
  }

  function referenceFor(symbol) { return freshEntry(state.reference, symbol); }

  async function loadReference(symbol) {
    const data = await call('market:reference', { symbol });
    state.reference.set(symbol, { data, at: Date.now() });
    return data;
  }

  /* Recent regulatory filings, independent of which fundamentals path
     answered. market:fundamentals only carries these when the vendor's own
     session was refused and the filings became the whole answer — a company
     whose accounts came from the vendor normally has no filed.recent at all,
     which is exactly backwards for something that exists to say "this just
     happened": a 10-Q filed an hour ago or an 8-K disclosing a material
     event is the most current fact this application can read for a company,
     available or not regardless of which other call succeeded. */
  function filingsFor(symbol) { return freshEntry(state.filings, symbol); }

  async function loadFilings(symbol) {
    const data = await call('market:filings', { symbol, limit: 6 }).catch(() => ({ found: false }));
    state.filings.set(symbol, { data, at: Date.now() });
    return data;
  }

  /* The market-wide feed moved to web/newsroom.js, which owns the news screen
     and caches its own copy. Loading it here as well would read every publisher
     twice for two views of the same headlines. */

  async function refreshSources() {
    if (!state.symbol) return;
    const body = $('#detail-body');
    const asked = state.symbol;

    /* The independent check is a second network round trip, and the operator is
       free to move on while it runs. Writing the answer in regardless stamps
       the sources drawer over whichever tab they landed on — which is how a
       financial statement ends up reading "Current figure, delayed". */
    const stillWanted = () => state.detailTab === 'sources' && state.symbol === asked;

    try {
      const data = await call('market:sources', { symbol: asked });
      const verify = await call('market:verify', { symbol: asked }).catch(() => null);
      if (!stillWanted()) return;
      let html = '';

      if (data.figure) {
        html += '<div class="src"><div class="who"><span>Current figure</span>' +
          badgeHtml(data.figure.freshness) + '</div><div class="when">' +
          esc(num.money(data.figure.last, { currency: data.figure.currency, assetClass: data.figure.assetClass })) +
          '  ·  stamped ' + esc(data.figure.freshness.asOf || '—') + '</div>' +
          '<div class="note" style="border:0;padding:0;margin-top:6px;color:var(--ink-3)">' +
          esc(data.figure.freshness.reason || '') + '</div></div>';
      }

      if (verify) {
        if (verify.checked) {
          html += '<div class="src"><div class="who"><span>Independent check</span>' +
            '<span class="' + (verify.agree ? 'up' : 'down') + '">' + (verify.agree ? 'Agrees' : 'Differs') + '</span></div>' +
            '<div class="when">' + esc(verify.primary.source) + ' ' + esc(String(verify.primary.value)) +
            '   ·   ' + esc(verify.secondary.source) + ' ' + esc(String(verify.secondary.value)) + '</div>' +
            verify.findings.map(f => '<div class="note">' + esc(f.detail) + '</div>').join('') + '</div>';
        } else {
          html += '<div class="src"><div class="who"><span>Independent check</span></div>' +
            '<div class="note" style="border:0;padding:0;margin-top:5px">' + esc(verify.reason) + '</div></div>';
        }
      }

      html += '<div class="section-label">Sources consulted</div>';
      if (!data.sources.length) html += '<div class="note-line">Nothing recorded yet.</div>';
      data.sources.forEach(s => {
        html += '<div class="src"><div class="who"><span>' + esc(s.providerLabel) + '</span>' +
          '<span class="muted" style="font-size:10px">' + (s.cached ? 'from cache' : 'fetched') + '</span></div>' +
          '<div class="ep">' + esc(s.endpoint) + (s.symbol ? '  ·  ' + esc(s.symbol) : '') + '</div>' +
          '<div class="when">retrieved ' + esc(clock.asOf(s.retrievedAt)) + '</div>' +
          (s.substitution ? '<div class="note">' + esc(s.substitution) + '</div>' : '') +
          (s.note ? '<div class="note">' + esc(s.note) + '</div>' : '') + '</div>';
      });

      body.innerHTML = html;
    } catch (err) {
      if (stillWanted()) body.innerHTML = '<div class="note-line bad">' + esc(err.message) + '</div>';
    }
  }

  /* ---------- chart ---------- */

  const RANGES = [
    ['1D', '1d'], ['5D', '5d'], ['1M', '1mo'], ['3M', '3mo'],
    ['6M', '6mo'], ['YTD', 'ytd'], ['1Y', '1y'], ['5Y', '5y'], ['All', 'max']
  ];
  const SERIES = [
    ['candle', 'Candles'], ['bar', 'OHLC'], ['line', 'Line'], ['area', 'Area'],
    ['heikin', 'Heikin Ashi'], ['renko', 'Renko'], ['range', 'Range']
  ];
  /* The bar-size ladder, in the order a trader reads it. Which of these are
     actually available is not decided here — the engine answers that per
     instrument, because it depends on which source routes the symbol. A crypto
     venue publishes one-second bars and an equity source does not. */
  const INTERVALS = [
    { name: '1s', label: '1 second', group: 'Seconds' },
    { name: '5s', label: '5 seconds', group: 'Seconds' },
    { name: '15s', label: '15 seconds', group: 'Seconds' },
    { name: '30s', label: '30 seconds', group: 'Seconds' },
    { name: '1m', label: '1 minute', group: 'Minutes' },
    { name: '2m', label: '2 minutes', group: 'Minutes' },
    { name: '3m', label: '3 minutes', group: 'Minutes' },
    { name: '5m', label: '5 minutes', group: 'Minutes' },
    { name: '10m', label: '10 minutes', group: 'Minutes' },
    { name: '15m', label: '15 minutes', group: 'Minutes' },
    { name: '30m', label: '30 minutes', group: 'Minutes' },
    { name: '1h', label: '1 hour', group: 'Hours' },
    { name: '2h', label: '2 hours', group: 'Hours' },
    { name: '4h', label: '4 hours', group: 'Hours' },
    { name: '1d', label: '1 day', group: 'Days' },
    { name: '1w', label: '1 week', group: 'Days' },
    { name: '1mo', label: '1 month', group: 'Days' }
  ];

  /* Short forms for the toolbar, where the full name will not fit. */
  const INTERVAL_SHORT = {
    '1s': '1s', '5s': '5s', '15s': '15s', '30s': '30s',
    '1m': '1m', '2m': '2m', '3m': '3m', '5m': '5m', '10m': '10m', '15m': '15m', '30m': '30m',
    '1h': '1H', '2h': '2H', '4h': '4H', '1d': '1D', '1w': '1W', '1mo': '1M'
  };

  /* How far back each history window reaches, used only to warn that a very
     fine bar over a very long window is a request the source will answer with
     something coarser. The engine reports what it actually served. */

  /* THE BAR SIZE SAYS WHAT ONE CANDLE IS. IT DOES NOT SAY HOW FAR BACK TO LOOK.
   *
   * This was built backwards, and everything that felt broken about it followed
   * from that. Fifteen minutes is not a request for the last fifteen minutes,
   * or for the last day: it is a request for the whole history of the
   * instrument drawn in quarter-hour candles, to be scrolled back through as
   * far as it goes. Choosing it and being shown one afternoon is not a small
   * inaccuracy — it is the wrong idea of what the control is.
   *
   * So: every bar size loads as much history as the source will publish at that
   * size, and the strip along the bottom stops being a fetch and becomes a
   * zoom. Pressing 1M does not go and get a month, it looks at the last month
   * of what is already there, and scrolling left keeps going past it.
   *
   * The ceilings below are measured against the source, not guessed. Anything
   * finer than an hour is only kept for a matter of weeks by anyone giving it
   * away, so those load their maximum by range; daily and coarser load from the
   * beginning of the record by explicit dates, because the named maximum range
   * silently answers a daily request with monthly bars. */
  const INTERVAL_HISTORY = {
    '1s': { range: '1d' }, '5s': { range: '1d' }, '15s': { range: '1d' }, '30s': { range: '1d' },
    '1m': { range: '7d' }, '2m': { range: '60d' }, '3m': { range: '60d' },
    '5m': { range: '60d' }, '10m': { range: '60d' }, '15m': { range: '60d' }, '30m': { range: '60d' },
    '1h': { range: '730d' }, '2h': { range: '730d' }, '4h': { range: '730d' },
    '1d': { whole: true }, '1w': { whole: true }, '1mo': { whole: true }
  };

  const DAY = 24 * 60 * 60 * 1000;

  /* How far back each button on the bottom strip looks. Null means everything
     that is loaded. */
  function periodOf(label) {
    if (label === 'All') return null;
    if (label === 'YTD') {
      const now = new Date();
      return now - Date.UTC(now.getUTCFullYear(), 0, 1);
    }
    return {
      '1D': DAY, '5D': 5 * DAY, '1M': 31 * DAY, '3M': 92 * DAY,
      '6M': 183 * DAY, '1Y': 365 * DAY, '5Y': 1826 * DAY
    }[label] || null;
  }

  const QUICK = ['volume', 'sma', 'ema', 'bollinger', 'vwap', 'rsi', 'macd', 'atr', 'supertrend', 'ichimoku', 'volumeProfile', 'stochastic'];

  /* The bar sizes that sit in the title bar itself.
   *
   * A strip of the sizes actually reached for, with the full ladder one press
   * away — which is how the reference does it, and why nobody hunting for
   * fifteen-minute bars has to open anything. A size chosen from the ladder
   * that is not on the strip joins it, so the strip becomes the operator's own
   * set rather than somebody's guess at one. */
  const STRIP_DEFAULT = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1mo'];

  function stripIntervals() {
    const held = (state.panels && Array.isArray(state.panels.strip)) ? state.panels.strip : null;
    const list = held && held.length ? held.slice() : STRIP_DEFAULT.slice();
    const current = state.chartInterval;
    if (current && list.indexOf(current) === -1) list.push(current);
    /* Kept in ladder order however they were added. */
    return INTERVALS.map(i => i.name).filter(name => list.indexOf(name) !== -1);
  }

  function renderTimeframeStrip() {
    const available = state.intervals || {};
    const active = state.chartInterval;
    const html = stripIntervals().map(name => {
      const plan = available[name];
      const usable = !plan || plan.available;
      return '<button class="tf-btn' + (name === active ? ' on' : '') + '"' +
        (usable ? ' data-act="interval" data-interval="' + esc(name) + '"' : ' disabled') +
        ' title="' + esc((INTERVALS.find(i => i.name === name) || {}).label || name) + '">' +
        esc(INTERVAL_SHORT[name] || name) + '</button>';
    }).join('');

    patch('tf-strip', html +
      '<button class="tf-btn more" data-act="menu" data-menu="interval" title="All bar sizes">▾</button>');
  }

  function renderChartBar() {
    const label = (SERIES.find(s => s[0] === state.seriesType) || [])[1] || 'Candles';
    const vendor = state.chartSource === 'vendor';

    /* On the vendor's chart the toolbar below belongs to the widget — its
       own indicators, drawing tools and symbol search — so this one adds
       only what it does not carry: this application's own colour palette,
       which the widget picks up the next time it is (re)mounted, since its
       configuration is baked into the frame and cannot be changed from
       outside it once drawn. */
    if (vendor) {
      patch('chart-bar', sourceToggle(true) +
        '<span class="tb-sep"></span>' +
        '<button class="tb-btn" data-act="menu" data-menu="appearance" title="Colours and appearance"><svg><use href="#i-palette"></use></svg></button>' +
        '<button class="tb-btn" data-act="toggle-side" title="Show or hide the right column"><svg><use href="#i-layout"></use></svg></button>' +
        '<button class="tb-btn" data-act="toggle-bottom" title="Show or hide the bottom panel"><svg><use href="#i-orders"></use></svg></button>' +
        '<button class="tb-btn" data-act="detach" data-panel="chart" title="Open on another monitor"><svg><use href="#i-detach"></use></svg></button>');
      renderTimeframeStrip();
      return;
    }

    /* Alert used to sit fifth in this row, which put it right at the edge
       this bar clips to on an ordinary window width — reported as the alert
       control being "half hidden". Nothing about which button that turns
       out to be should depend on how wide the operator's window happens to
       be, so the controls reached for constantly (chart type, indicators,
       alert) lead, and the ones reached for rarely (undo, a snapshot,
       detaching the panel) are what falls off the edge instead. */
    const html =
      sourceToggle(false) +
      '<span class="tb-sep"></span>' +
      '<button class="tb-btn" data-act="menu" data-menu="series" title="Chart type"><svg><use href="#i-candle"></use></svg>' + esc(label) + '</button>' +
      '<button class="tb-btn" data-act="menu" data-menu="indicators" title="Indicators"><svg><use href="#i-indicator"></use></svg>Indicators' +
        (state.indicators.length ? ' <span class="muted">' + state.indicators.length + '</span>' : '') + '</button>' +
      '<button class="tb-btn" data-act="add-alert" title="Create an alert"><svg><use href="#i-alerts"></use></svg>Alert</button>' +
      '<span class="tb-sep"></span>' +
      '<button class="tb-btn" data-act="menu" data-menu="appearance" title="Colours and appearance"><svg><use href="#i-palette"></use></svg></button>' +
      '<button class="tb-btn" data-act="replay" title="Replay"><svg><use href="#i-replay"></use></svg>Replay</button>' +
      '<span class="tb-sep"></span>' +
      '<button class="tb-btn" data-act="undo-drawing" title="Remove the last drawing"><svg><use href="#i-undo"></use></svg></button>' +
      '<button class="tb-btn" data-act="snapshot" title="Save a picture of this chart"><svg><use href="#i-camera"></use></svg></button>' +
      '<button class="tb-btn" data-act="toggle-side" title="Show or hide the right column"><svg><use href="#i-layout"></use></svg></button>' +
      '<button class="tb-btn" data-act="toggle-bottom" title="Show or hide the bottom panel"><svg><use href="#i-orders"></use></svg></button>' +
      '<button class="tb-btn" data-act="detach" data-panel="chart" title="Open on another monitor"><svg><use href="#i-detach"></use></svg></button>';
    patch('chart-bar', html);
    renderTimeframeStrip();
  }

  function sourceToggle(vendor) {
    return '<div class="seg source-seg" title="Which chart to draw">' +
      '<button data-act="chart-source" data-source="native"' + (vendor ? '' : ' class="on"') + '>Engine</button>' +
      '<button data-act="chart-source" data-source="vendor"' + (vendor ? ' class="on"' : '') + '>TradingView</button>' +
      '</div>';
  }

  /* WHICH CHART IS ON SCREEN.
   *
   * The engine here draws from the same bars every other figure on the screen
   * came from, replays, and carries the drawing layer this application owns. The
   * vendor's chart brings a drawing toolkit and an indicator library that a
   * single person cannot match, and the operator asked for it by name. Both are
   * real charts and neither replaces the other, so this switches between them
   * and keeps the instrument, the bar size and the theme in step across the
   * change.
   *
   * The engine is destroyed rather than hidden when the vendor's chart is shown:
   * a canvas nobody is looking at still repaints on every quote. */
  /* The topbar's own timeframe strip and tool group only mean anything against
     the engine's own chart, and the vendor's chart carries a complete set of
     the same kind of controls inside its own frame — its own timeframe strip,
     drawing rail and range strip. Showing the engine's alongside a chart they
     do nothing to reads as broken chrome left behind by mistake. */
  /* The title bar's own toolbar already reduces itself for the vendor's
     chart — renderChartBar()'s own `if (vendor)` branch — down to the
     source switch, appearance and layout, which is genuinely still this
     application's to offer; the vendor's chart carries the rest (its own
     timeframe strip, indicators, alerts) inside its own frame. Hiding the
     bar outright hid that switch along with everything else, and closed
     off the only way back to the engine chart. Only the drawing rail and
     the range strip have no such reduced form — nothing in the vendor's
     frame needs either — and are what this actually hides. */
  function syncChartTools() {
    const tools = document.getElementById('chart-tools');
    if (tools) tools.classList.toggle('hidden', state.view !== 'chart');
    const vendor = state.chartSource === 'vendor';
    const drawRail = document.getElementById('draw-rail');
    if (drawRail) drawRail.classList.toggle('hidden', vendor);
    /* The rail's own column is a fixed width, not an auto one — hiding the
       rail alone leaves its gutter reserved and empty. The grid's column
       count changes with it rather than being left with a phantom track. */
    const chartArea = document.querySelector('.chart-area');
    if (chartArea) chartArea.classList.toggle('no-rail', vendor);
    const rangeBar = document.getElementById('range-bar');
    if (rangeBar) rangeBar.classList.toggle('hidden', vendor);
  }

  async function renderChartSurface() {
    const wrap = $('#chart-wrap');
    const holder = $('#vendor-chart');
    if (!wrap || !holder) return;
    syncChartTools();

    if (state.chartSource !== 'vendor') {
      holder.hidden = true;
      window.T.embeds.clear(holder);
      await loadChart();
      return;
    }

    /* The engine chart is torn down rather than hidden. Its box stays — it is
       what gives the frame its size — but a canvas nobody is looking at still
       repaints on every quote that arrives. destroy() removes the canvas
       layers themselves; the legend is a sibling div, not a canvas, and sat
       at z-index 5 — above the vendor frame's 3 — showing its last reading
       until the next crosshair move, which reads as the engine chart still
       being there underneath the one just switched to. */
    if (state.chart) { state.chart.destroy(); state.chart = null; state.draw = null; }
    patch('legend', '');
    holder.hidden = false;

    const vendorSymbol = await call('market:reference', { symbol: state.symbol })
      .then(reference => reference.tvSymbol)
      .catch(() => null);

    if (!vendorSymbol) {
      holder.innerHTML = '<div class="embed-fault">' + esc(state.symbol) +
        ' could not be matched to a listing at the charting vendor, so their chart cannot be drawn for it. ' +
        'The engine chart still can.</div>';
      return;
    }

    const overrides = vendorOverrides();
    window.T.embeds.mount(holder, 'chart', {
      symbol: vendorSymbol,
      interval: VENDOR_INTERVAL[state.chartInterval] || 'D',
      theme: document.documentElement.getAttribute('data-theme') || 'dark',
      style: '1',
      timezone: 'Europe/London',
      locale: 'en',
      allow_symbol_change: false,
      withdateranges: true,
      hide_side_toolbar: false,
      details: false,
      calendar: false,
      autosize: true,
      overrides: overrides,
      /* `theme` covers the chart pane; the toolbar and the date-range strip
         along the bottom are a separate surface the widget does not always
         carry the same theme into on its own, and are left with a pale
         default seam along their edge without this. */
      toolbar_bg: overrides['paneProperties.background']
    }, { title: 'Chart of ' + state.symbol });
  }

  /* The vendor names its bar sizes in minutes, so the ladder maps rather than
     passes through. Anything without an equivalent falls back to daily and the
     strip shows what is actually being drawn. */
  const VENDOR_INTERVAL = {
    '1m': '1', '2m': '2', '3m': '3', '5m': '5', '10m': '10', '15m': '15', '30m': '30',
    '1h': '60', '2h': '120', '4h': '240', '1d': 'D', '1w': 'W', '1mo': 'M'
  };

  /* The bar-size menu.
   *
   * A size the source cannot serve is shown and disabled with the reason on it,
   * rather than hidden. Hiding it leaves the operator wondering whether they
   * misremembered; showing it greyed answers the question. A size that has to
   * be merged from a finer one says so too, because a four-hour bar built from
   * hourly bars is a real four-hour bar and a four-hour bar built from daily
   * ones would not be. */
  /* How far back this bar size can be read, in words. The operator is choosing
     between "the whole record" and "the last few weeks", and that is the thing
     worth knowing before the press. */
  const HISTORY_NOTE = {
    '1s': 'today only', '5s': 'today only', '15s': 'today only', '30s': 'today only',
    '1m': 'about a week back', '2m': 'about two months back', '3m': 'about two months back',
    '5m': 'about two months back', '10m': 'about two months back',
    '15m': 'about two months back', '30m': 'about two months back',
    '1h': 'about two years back', '2h': 'about two years back', '4h': 'about two years back',
    '1d': 'the whole record', '1w': 'the whole record', '1mo': 'the whole record'
  };

  function intervalMenuHtml() {
    const available = state.intervals || {};
    let html = '';
    let group = null;

    INTERVALS.forEach(entry => {
      if (entry.group !== group) {
        group = entry.group;
        html += '<div class="section-label" style="padding:10px 0 4px">' + esc(group) + '</div>';
      }

      const plan = available[entry.name];
      const usable = !plan || plan.available;
      const chosen = entry.name === state.chartInterval;

      let note = HISTORY_NOTE[entry.name] || '';
      if (plan && plan.available && plan.source === 'derived') {
        note = note + ', merged from ' + plan.from + ' bars';
      } else if (plan && !plan.available) {
        note = plan.reason;
      }

      html += '<button class="btn menu-row' + (chosen ? ' on' : '') + '"' +
        (usable ? ' data-act="interval" data-interval="' + esc(entry.name) + '"' : ' disabled') + '>' +
        '<span class="mono tf-key">' + esc(INTERVAL_SHORT[entry.name] || entry.name) + '</span>' +
        '<span class="menu-text"><b>' + esc(entry.label) + '</b>' +
        (note ? '<span class="muted">' + esc(note) + '</span>' : '') + '</span></button>';
    });

    return html;
  }

  /* The indicator library.
   *
   * The whole catalogue, not a shortlist. A curated dozen was hiding seven
   * indicators that were built, tested and reachable from nowhere in the
   * interface. They are grouped by where they draw, because that is the
   * distinction that decides what adding one does to the chart: an overlay
   * shares the price pane, an oscillator takes a strip of its own. */
  function indicatorMenuHtml(query) {
    const catalogue = window.T.indicators.CATALOGUE;
    const text = String(query || '').trim().toLowerCase();
    const active = state.indicators.map(i => i.id);

    const matches = Object.keys(catalogue).filter(id => {
      if (!text) return true;
      const entry = catalogue[id];
      return (id + ' ' + entry.label + ' ' + (entry.explain || '')).toLowerCase().indexOf(text) !== -1;
    });

    if (!matches.length) {
      return '<div class="empty" style="height:auto;padding:26px"><div class="big">Nothing matched</div>' +
        '<div>No indicator in the catalogue has that in its name or description.</div></div>';
    }

    const groups = [
      ['On the price', matches.filter(id => catalogue[id].pane === 'price')],
      ['In their own pane', matches.filter(id => catalogue[id].pane !== 'price')]
    ];

    return groups.map(([title, ids]) => {
      if (!ids.length) return '';
      return '<div class="section-label" style="padding:12px 0 4px">' + esc(title) +
        ' <span class="muted">' + ids.length + '</span></div>' +
        ids.map(id => {
          const entry = catalogue[id];
          const on = active.indexOf(id) !== -1;
          return '<button class="btn menu-row' + (on ? ' on' : '') + '" data-act="indicator" data-id="' + esc(id) + '">' +
            '<span class="tick">' + (on ? '✓' : '') + '</span>' +
            '<span class="menu-text"><b>' + esc(entry.label) + '</b>' +
            '<span class="muted">' + esc(entry.explain || '') + '</span></span></button>';
        }).join('');
    }).join('');
  }

  function renderRangeBar() {
    let html = RANGES.map(([label]) =>
      '<button class="range-btn' + (label === state.chartRange ? ' on' : '') +
      '" data-act="range" data-range="' + label + '">' + label + '</button>').join('');
    /* The shortcut is named in the tooltip on every one of these. A mode that
       can only be found by pressing the right key is a mode nobody finds. */
    html += '<span class="tb-spacer"></span>' +
      '<span class="muted mono" id="chart-clock"></span>' +
      '<button class="range-btn" data-act="scale" data-scale="percent" title="Percentage scale — Alt+P">%</button>' +
      '<button class="range-btn" data-act="scale" data-scale="log" title="Logarithmic scale — Alt+L">log</button>' +
      '<button class="range-btn" data-act="scale" data-scale="invert" title="Invert the scale — Alt+I">invert</button>' +
      '<button class="range-btn on" data-act="scale" data-scale="auto" title="Fit the price scale to what is on screen">auto</button>';
    patch('range-bar', html);
    syncScaleButtons();
  }

  function syncScaleButtons() {
    const chart = state.chart;
    if (!chart) return;
    const on = {
      log: chart.price.log,
      percent: chart.price.percent,
      invert: chart.price.inverted,
      auto: chart.price.auto
    };
    $$('[data-act="scale"]').forEach(b => b.classList.toggle('on', !!on[b.dataset.scale]));
  }

  function legendChangeHtml(model) {
    const change = changeOf(model && model.quote ? model : { quote: {}, currency: null, assetClass: null });
    return '<span class="' + change.direction + '">' + esc(change.absText) + ' ' + esc(change.pctText) + '</span>';
  }

  function renderLegend(point) {
    const model = state.quotes.get(state.symbol);
    if (!model) return;
    const money = v => priceOf(model, v);
    const bar = point ? point.bar : (state.chart && state.chart.bars[state.chart.bars.length - 1]);

    let html = '<div class="l1"><span class="sym">' + esc(model.symbol) + '</span>' +
      '<span class="meta">' + esc(state.chartRange) + '</span>' +
      '<span class="meta">' + esc(model.exchangeName || '') + '</span>' +
      badgeHtml(model.freshness, true) + '</div>';

    if (bar) {
      const rising = bar.c >= bar.o;
      html += '<div class="ohlc ' + (rising ? 'up' : 'down') + '">' +
        '<span class="lab">O</span>' + esc(money(bar.o)) +
        '<span class="lab">H</span>' + esc(money(bar.h)) +
        '<span class="lab">L</span>' + esc(money(bar.l)) +
        '<span class="lab">C</span>' + esc(money(bar.c)) +
        '<span>' + (state.legendChange || '') + '</span></div>';
    }

    (point ? point.values : []).forEach(item => {
      if (item.unavailable) {
        html += '<div class="ind muted" title="' + esc(item.unavailable) + '">' + esc(item.label) + ' — not enough history</div>';
        return;
      }
      if (item.value == null || !Number.isFinite(item.value)) return;
      html += '<div class="ind"><span class="swatch" style="background:' + esc(item.colour || 'var(--ink-3)') + '"></span>' +
        esc(item.label) + ' ' + esc(window.T.chartHelpers.shortNumber(item.value)) + '</div>';
    });

    patch('legend', html);
  }

  async function loadChart() {
    const wrap = $('#chart-wrap');
    if (!state.symbol) return;

    if (!state.chart) {
      state.chart = new window.T.Chart(wrap, {
        onCrosshair: renderLegend,
        onScaleChange: syncScaleButtons,
        onContextMenu: chartMenu,
        style: state.chartStyle || {}
      });
      state.draw = new window.T.DrawingLayer(state.chart, {
        onChange: drawings => saveDrawings(state.symbol, drawings),
        /* The tool disarms itself once the drawing is finished, so the next
           press pans the chart rather than starting another one. */
        onFinish: () => ACTIONS.tool({ tool: 'cursor' })
      });
      state.draw.setTool(state.tool);
    }

    /* As much history as this bar size can be had at, every time. */
    const plan = INTERVAL_HISTORY[state.chartInterval] || { whole: true };
    const request = { symbol: state.symbol, interval: state.chartInterval || undefined };
    if (plan.whole) { request.from = 0; request.to = Date.now(); } else { request.range = plan.range; }

    try {
      const result = await call('market:chart', request);
      const model = state.quotes.get(state.symbol) || {};
      state.legendChange = legendChangeHtml(model);

      state.chart.seriesType = state.seriesType;
      state.chart.setIndicators(state.indicators);
      state.chart.setData({
        bars: result.bars,
        symbol: result.symbol,
        timeframe: result.timeframe,
        currency: model.currency,
        assetClass: model.assetClass,
        priceHint: model.priceHint,
        timeZone: model.session && model.session.tz,
        previousClose: model.quote && model.quote.previousClose
      });

      /* Drawings belong to the instrument, not the chart, so they reload with
         it and survive a timeframe change untouched. */
      if (state.draw) state.draw.load(state.drawings[state.symbol] || []);

      /* Everything is loaded; the strip decides how much of it is on screen. */
      state.chart.showPeriod(periodOf(state.chartRange));

      /* The toolbar reads what was served, not what was asked for. */
      state.servedTimeframe = result.timeframe;
      renderChartBar();
      renderLegend(null);

      const existing = document.getElementById('coarse-note');
      if (existing) existing.remove();
      /* The source can serve a coarser series than the one asked for without
         saying so in an error. When it does, the interface reports what it is
         actually showing rather than the label that was requested. A series
         merged up from a finer one says so too — those bars are real, but the
         operator is entitled to know they were assembled here. */
      const message = result.coarsened
        ? 'This source served ' + result.timeframe + ' bars for that range, not ' +
          result.requestedTimeframe + '. The chart shows what was served.'
        : (result.derivedFrom
          ? result.timeframe + ' bars, merged here from the ' + result.derivedFrom +
            ' bars this source publishes.'
          : null);

      if (message) {
        const note = el('div', 'chart-note');
        note.id = 'coarse-note';
        note.textContent = message;
        wrap.appendChild(note);
      }
    } catch (err) {
      const note = el('div', 'note-line bad');
      note.textContent = err.message;
      wrap.appendChild(note);
    }
  }

  /* Which bar sizes this instrument's source can serve. Asked once per
     instrument and held, because the answer only changes when the routing does
     and the menu must open instantly. */
  async function loadIntervals(symbol) {
    if (state.intervalsFor === symbol) return;
    try {
      const list = await call('market:intervals', { symbol });
      /* THE ANSWER IS DISCARDED IF THE OPERATOR HAS MOVED ON.
         Two instruments opened quickly start two of these, and they do not come
         back in the order they were sent. The slower answer, written in last,
         then describes the instrument that is no longer on screen — which is
         how a chart of a share came to offer one-second bars, because the coin
         before it could serve them. */
      if (state.symbol !== symbol) return;
      const map = {};
      list.forEach(entry => { map[entry.name] = entry; });
      state.intervals = map;
      state.intervalsFor = symbol;
      renderTimeframeStrip();
    } catch (err) {
      if (state.symbol !== symbol) return;
      state.intervals = {};
      state.intervalsFor = symbol;
    }
  }

  /* One write for the whole workspace. Saving drawings and panel sizes through
     separate calls would have each of them overwrite the other's half of the
     same stored document. */
  function saveWorkspace() {
    call('layout:save', {
      workspace: {
        drawings: state.drawings,
        panels: state.panels,
        panelFlags: state.panelFlags,
        chartStyle: state.chartStyle,
        chartSource: state.chartSource,
        heatmapSource: window.T.discover ? window.T.discover.state.heatmapSource : undefined,
        searchScope: state.searchScope,
        syrixDocked: window.T.syrix ? window.T.syrix.state.docked : false
      }
    }).catch(() => {});
  }

  function saveDrawings(symbol, drawings) {
    if (!symbol) return;
    state.drawings[symbol] = drawings;
    saveWorkspace();
  }

  /* ---------- bottom panel ---------- */

  async function renderBottom() {
    const body = $('#bp-body');
    try {
      const data = await call('paper:state', { symbol: state.symbol });
      state.paper = data;
      body.innerHTML = screens.bottomPanel(state.bottomTab, data);
      $('#bp-status').innerHTML = screens.marketStatus(state.quotes);
      paintOrderLevels();
    } catch (err) {
      body.innerHTML = '<div class="note-line bad">' + esc(err.message) + '</div>';
    }
  }

  /* Everything with money on it, drawn across the chart.
   *
   * A position and its brackets are the only marks on the chart the operator
   * did not draw and cannot afford to miss, and a blotter row underneath is not
   * where the eye is while the price is moving. The entry line carries the open
   * profit or loss, because that is the number being watched. */
  function paintOrderLevels() {
    if (!state.chart) return;
    const paper = state.paper;
    if (!paper || !state.symbol) { state.chart.setLevels([]); return; }

    const model = state.quotes.get(state.symbol);
    const levels = [];
    const css = getComputedStyle(document.documentElement);
    const colour = name => (css.getPropertyValue(name) || '').trim();
    const up = colour('--up') || '#26a69a';
    const down = colour('--down') || '#ef5350';

    (paper.positions || []).filter(p => p.symbol === state.symbol && p.quantity).forEach(position => {
      const long = position.quantity > 0;
      const entry = position.averagePrice != null ? position.averagePrice : position.entryPrice;
      if (entry == null) return;

      const last = model && model.quote ? model.quote.last : null;
      const open = (last == null) ? null : (last - entry) * position.quantity;
      const label = (long ? 'Long ' : 'Short ') + Math.abs(position.quantity) +
        (open == null ? '' : '   ' + num.change(open, {
          currency: model.currency, assetClass: model.assetClass
        }));

      levels.push({
        price: entry,
        colour: open == null ? colour('--ink-3') : (open >= 0 ? up : down),
        label,
        dash: []
      });
    });

    (paper.orders || []).filter(o => o.symbol === state.symbol && o.state === 'working').forEach(order => {
      const price = order.limitPrice != null ? order.limitPrice : order.stopPrice;
      if (price == null) return;
      levels.push({
        price,
        colour: order.side === 'buy' ? up : down,
        label: (order.side === 'buy' ? 'Buy ' : 'Sell ') + order.quantity + '  ' + order.type,
        dash: [3, 3]
      });
      if (order.bracket && order.bracket.takeProfit != null) {
        levels.push({ price: order.bracket.takeProfit, colour: up, label: 'Target', dash: [2, 4] });
      }
      if (order.bracket && order.bracket.stopLoss != null) {
        levels.push({ price: order.bracket.stopLoss, colour: down, label: 'Stop', dash: [2, 4] });
      }
    });

    state.chart.setLevels(levels);
  }

  /* A short two-tone chime when an order fills, synthesised rather than loaded
     so it needs no file and no request. Silent if the browser has not been
     given permission to make sound yet, which it grants on the first press. */
  function fillSound(filled) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      state.audio = state.audio || new Ctx();
      const audio = state.audio;
      if (audio.state === 'suspended') audio.resume();

      const at = audio.currentTime;
      [filled ? 660 : 380, filled ? 880 : 300].forEach((hz, i) => {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = 'sine';
        osc.frequency.value = hz;
        gain.gain.setValueAtTime(0.0001, at + i * 0.09);
        gain.gain.exponentialRampToValueAtTime(0.09, at + i * 0.09 + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + i * 0.09 + 0.11);
        osc.connect(gain).connect(audio.destination);
        osc.start(at + i * 0.09);
        osc.stop(at + i * 0.09 + 0.13);
      });
    } catch (e) {
      /* Sound is not load bearing. */
    }
  }

  /* The ticket is drawn once and shown in whichever host is open — the bottom
     panel or the docked order panel. Two copies would each carry their own
     quantity, and the one that placed the order would not be the one being
     looked at. */
  function renderTicket() {
    const model = state.quotes.get(state.symbol);
    const workspace = document.querySelector('.view.workspace');
    const docked = workspace && workspace.classList.contains('trade-open');
    const host = document.getElementById(docked ? 'trade-panel-body' : 'ticket');
    const other = document.getElementById(docked ? 'ticket' : 'trade-panel-body');

    if (other) other.innerHTML = '';
    if (host) host.innerHTML = screens.ticket(state, model);

    const title = document.getElementById('trade-panel-symbol');
    if (title) title.textContent = state.symbol ? state.symbol + ' order' : 'Order';
    updatePreview();
  }

  async function updatePreview() {
    const node = document.getElementById('ticket-preview');
    if (!node || !state.symbol) return;
    const order = readTicket();
    if (!order) return;
    try {
      const preview = await call('paper:preview', { order });
      node.innerHTML = screens.previewHtml(preview, state);
    } catch (err) {
      node.innerHTML = '<span class="down">' + esc(err.message) + '</span>';
    }
  }

  function readTicket() {
    const qty = Number(($('#tk-qty') || {}).value);
    if (!state.symbol || !(qty > 0)) return null;
    const value = id => {
      const node = document.getElementById(id);
      const raw = node ? Number(node.value) : NaN;
      return Number.isFinite(raw) ? raw : null;
    };
    return {
      symbol: state.symbol,
      side: state.ticketSide,
      quantity: qty,
      type: state.ticketType,
      limitPrice: value('tk-limit'),
      stopPrice: value('tk-stop'),
      trailAmount: value('tk-trail'),
      plannedStop: value('tk-sl'),
      plannedTarget: value('tk-tp'),
      bracket: (value('tk-tp') != null || value('tk-sl') != null)
        ? { takeProfit: value('tk-tp'), stopLoss: value('tk-sl') } : null
    };
  }

  /* ---------- status ---------- */

  /* An alert fired somewhere in the main process — evaluated against every
     price as it arrives, not polled for. Shown here as a toast naming the
     level it crossed, plus a badge on the bell in the title bar until the
     alerts screen is actually opened. */
  function onAlertFired(fired) {
    (fired || []).forEach(alert => {
      const verb = alert.kind === 'below' ? 'fell below' : 'rose above';
      const model = state.quotes.get(alert.symbol);
      const price = num.money(alert.price, { currency: model && model.currency, assetClass: model && model.assetClass });
      toast(alert.symbol + ' ' + verb + ' ' + price + '.');
    });
    setAlertBadge(true);
    if (state.view === 'alerts') renderAlerts();
  }

  function setAlertBadge(on) {
    const dot = document.getElementById('alert-badge');
    if (dot) dot.hidden = !on;
  }

  function onSafeMode(mode) {
    state.safeMode = mode;
    const banner = $('#safemode');
    banner.classList.toggle('on', !!mode.active);
    if (mode.active) {
      banner.querySelector('.label').textContent = 'Safe data mode';
      banner.querySelector('.why').textContent = mode.reasons.length ? mode.reasons[0].detail : 'A data integrity check failed.';
      banner.querySelector('.withheld').textContent = 'Withheld: ' + mode.suspended.join(', ') + '. Research and charts continue.';
    }
  }

  /* The files behind this window have moved on since it opened. Offered rather
     than forced: a reload throws away a half-written order ticket, and that is
     the operator's call. */
  function onStaleBuild(payload) {
    const bar = document.getElementById('stale-bar');
    if (!bar || !bar.hidden) return;
    bar.hidden = false;
    bar.title = 'This window was built at ' + new Date(payload.builtAt).toLocaleTimeString() +
      ' and the files were last changed at ' + new Date(payload.onDisk).toLocaleTimeString() + '.';
  }

  function updateGlobalState() {
    const states = Array.from(state.quotes.values()).map(m => m.freshness && m.freshness.state).filter(Boolean);
    const order = ['UNKNOWN', 'STALE', 'DELAYED', 'CLOSED', 'HISTORICAL', 'LIVE'];
    const worst = order.find(level => states.indexOf(level) !== -1) || 'UNKNOWN';
    const badge = $('#global-state');
    badge.dataset.state = worst;
    const labels = { LIVE: 'Live', DELAYED: 'Delayed', CLOSED: 'Closed', STALE: 'Not updating', UNKNOWN: 'Unverified', HISTORICAL: 'Historical' };
    badge.querySelector('.txt').textContent = labels[worst] || worst;
    badge.title = 'The worst data state among the ' + states.length + ' instruments loaded';
  }

  async function tickStatus() {
    $('#clocks').textContent = ['America/New_York', 'Europe/London', 'Asia/Tokyo']
      .map(tz => tz.split('/')[1].replace('_', ' ') + ' ' + clock.asOf(Date.now(), tz)).join('   ');
    const chartClock = document.getElementById('chart-clock');
    if (chartClock) chartClock.textContent = clock.asOf(Date.now(), 'Europe/London') + ' (London)';

    const model = state.quotes.get(state.symbol);
    if (model) {
      const open = model.freshness && (model.freshness.state === 'LIVE' ||
        (model.freshness.sessionStatus === 'OPEN'));
      $('#mkt-state').innerHTML = 'Market <span class="pill' + (open ? ' open' : '') + '">' +
        esc(open ? 'Open' : (model.freshness ? model.freshness.label : 'Unknown')) + '</span>';
    }

    try {
      const health = await call('app:health');
      $('#status-market').textContent = health.market.loaded + ' loaded · ' + health.market.subscribed + ' subscribed';
      $('#status-net').textContent = health.http.requests + ' requests · ' + health.http.cacheHits + ' cached' +
        (health.http.rateLimited ? ' · ' + health.http.rateLimited + ' rate limited' : '') +
        (health.sessionGated.available ? '' : ' · no market session');
    } catch (e) { /* the health panel is not load bearing */ }
  }

  /* ---------- search ----------
   *
   * WORLDWIDE, WITH THE COMPANY'S OWN MARK. It used to search one venue's own
   * symbol list and draw two initials on a coloured square, so a search for the
   * lender showed "SO" and a company listed only in Mumbai or Kuala Lumpur could
   * not be found at all. It now searches every listed market and shows the
   * company's own logo, the exchange it trades on and the country.
   *
   * A row for an instrument this application cannot price is kept and marked
   * rather than hidden: it can be charted and researched, and pretending it does
   * not exist is worse than saying what is missing. */
  let searchTimer = null;
  const SCOPES = [
    ['all', 'All'], ['stocks', 'Stocks'], ['funds', 'Funds'], ['crypto', 'Crypto'],
    ['forex', 'Forex'], ['futures', 'Futures'], ['indices', 'Indices'], ['bonds', 'Bonds']
  ];

  async function runSearch(query) {
    const box = $('#search-results');
    const scope = state.searchScope || 'all';

    box.innerHTML = scopeStrip(scope) + '<div class="loading sm">Searching…</div>';
    box.hidden = false;

    try {
      const results = await call('market:search', { query, limit: 24, scope });
      if ($('#search-input').value.trim() !== query) return;

      box.innerHTML = scopeStrip(scope) + (results.length
        ? '<div class="results-list">' + results.map(resultRow).join('') + '</div>'
        : '<div class="empty sm">Nothing matched that.</div>');

      /* Only for the matches that did not already carry their own mark — a
         venue-only match with no vendor listing behind it. The marks are
         fetched after the rows are on screen, in one request for the whole
         list, so a search never waits on pictures. */
      paintLogos(results.filter(r => !r.logo).map(r => r.symbol).filter(Boolean), box);
    } catch (err) {
      box.innerHTML = scopeStrip(scope) + '<div class="note-line bad" style="margin:8px">' +
        esc(err.message) + '</div>';
    }
  }

  function scopeStrip(scope) {
    return '<div class="scope-strip">' + SCOPES.map(([id, label]) =>
      '<button class="scope' + (scope === id ? ' on' : '') + '" data-act="search-scope" data-scope="' +
      id + '">' + label + '</button>').join('') + '</div>';
  }

  /* pick, when true, renders a row that adds the symbol to a watchlist
     instead of opening its chart — the same result markup either way, since
     it is the same instrument either way. */
  function resultRow(result, pick) {
    const venue = [result.exchange, result.country].filter(Boolean).join(' · ');
    const symbol = result.symbol || result.ticker || '';
    /* The match already carries a resolved mark when the vendor's own search
       found it — reading it directly here, rather than only through the
       separate market:logos round trip below, is what makes it show up
       immediately rather than a beat later, or not at all for a query
       that was gone from the box before that round trip returned. A match
       that came from the venue's search alone has none, and falls back to
       the same round trip every other unresolved mark uses. */
    const mark = result.logo
      ? '<img class="mark-logo" src="' + esc(result.logo) + '" alt="">'
      : fallbackMark(symbol);
    return '<button class="result' + (result.quotable ? '' : ' unquotable') + '"' +
      (result.quotable ? ' data-act="' + (pick ? 'wl-add-pick' : 'select') + '" data-symbol="' +
        esc(result.symbol) + '"' : ' disabled') +
      ' data-logo-for="' + esc(result.symbol || result.tvSymbol) + '">' +
      '<span class="r-mark' + (result.logo ? ' has-logo' : '') + '">' + mark + '</span>' +
      '<span class="r-text"><span class="sym">' + esc(result.symbol || result.tvSymbol) + '</span>' +
      '<span class="nm">' + esc(result.name || '') + '</span></span>' +
      '<span class="r-meta"><span class="kind">' + esc(result.assetClass || '') + '</span>' +
      (venue ? '<span class="venue">' + esc(venue) + '</span>' : '') + '</span>' +
      (result.quotable ? '' : '<span class="r-note">no quote here</span>') +
      '</button>';
  }

  /* Two initials on a colour derived from the symbol. Not a claim to be a logo —
     it is what stands in until one arrives, and what stays when the vendor
     publishes none. */
  function fallbackMark(symbol) {
    const initials = String(symbol).replace(/[^A-Z0-9]/gi, '').slice(0, 2).toUpperCase();
    return '<i class="mark-fallback" style="background:' + markFor(symbol) + '">' + esc(initials) + '</i>';
  }

  /* Fetch marks for a set of symbols and drop them into whatever is on screen
     carrying that symbol. Late arrivals are harmless: an element that has since
     been replaced is simply not found.
   *
     WHAT IS FOUND IS REMEMBERED, AND THAT IS NOT AN OPTIMISATION. The instrument
     header is rebuilt from markup on every quote that arrives, so a mark dropped
     into it by hand was destroyed a second later and the initials came back.
     Held here, the next rebuild draws the logo itself.
   *
     A REAL MARK IS REMEMBERED FOREVER; NO MARK IS NOT. The main process
     already refuses to cache a logo lookup that failed outright rather than
     came back genuinely empty (src/market/engine.js logosFor), but a mark
     this map once recorded as null was never asked for again either — the
     same permanent-failure shape one layer up. Only a truthy source is
     worth skipping a repeat request for; a symbol still without one is
     retried the next time it is painted; asking again costs nothing once
     the main process has a confirmed answer of its own to hand back. */
  async function paintLogos(symbols, scope) {
    const wanted = symbols.filter(symbol => symbol && !state.logos.get(symbol));
    if (wanted.length) {
      let found;
      try { found = await call('market:logos', { symbols: wanted }); } catch (err) { return; }
      Object.keys(found).forEach(symbol => {
        const marks = found[symbol];
        state.logos.set(symbol, (marks && (marks.logo || marks.base)) || null);
      });
    }

    symbols.forEach(symbol => {
      const src = state.logos.get(symbol);
      if (!src) return;
      const targets = (scope || document).querySelectorAll('[data-logo-for="' + cssEscape(symbol) + '"]');
      Array.from(targets).forEach(target => applyMark(target, src));
    });
  }

  /* Only swapped in once it has actually loaded. A mark that fails to load
     leaves the initials in place rather than an empty box. */
  function applyMark(target, src) {
    const holder = target.querySelector('.r-mark, .mark-holder') || target;
    if (holder.querySelector('.mark-logo')) return;
    const image = new Image();
    image.addEventListener('load', () => {
      holder.innerHTML = '';
      holder.appendChild(image);
      holder.classList.add('has-logo');
    });
    image.className = 'mark-logo';
    image.alt = '';
    image.src = src;
  }

  /* The mark for a symbol whose logo is already known, written straight into the
     markup so a rebuild keeps it. */
  function knownMark(symbol) {
    const src = state.logos.get(symbol);
    return src ? '<img class="mark-logo" src="' + esc(src) + '" alt="">' : null;
  }

  /* Symbols contain dots, carets and equals signs, none of which may reach a
     selector unescaped. */
  function cssEscape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function hideResults() {
    const box = $('#search-results');
    box.hidden = true;
    box.innerHTML = '';
  }

  /* ---------- adding a symbol to a watchlist by search, not just the chart in view ---------- */

  let wlAddTimer = null;

  function addSymbolModalHtml() {
    return '<input type="text" id="wl-add-input" placeholder="Search a symbol or company…" autocomplete="off">' +
      '<div id="wl-add-results" class="results-list"></div>';
  }

  async function runWatchlistAddSearch(query) {
    const box = $('#wl-add-results');
    if (!box) return;
    if (!query) { box.innerHTML = ''; return; }

    box.innerHTML = '<div class="loading sm">Searching…</div>';
    try {
      const results = await call('market:search', { query, limit: 24, scope: 'all' });
      const input = $('#wl-add-input');
      if (!input || input.value.trim() !== query) return;

      box.innerHTML = results.length
        ? results.map(r => resultRow(r, true)).join('')
        : '<div class="empty sm">Nothing matched that.</div>';
      paintLogos(results.filter(r => !r.logo).map(r => r.symbol).filter(Boolean), box);
    } catch (err) {
      box.innerHTML = '<div class="note-line bad" style="margin:8px">' + esc(err.message) + '</div>';
    }
  }

  /* ---------- the chart's context menu ----------
   *
   * What the right button offers depends on what it was pressed on: a drawing
   * offers that drawing's colour, width and removal; an axis offers what that
   * axis controls; the plot offers the chart. A menu that offers the same
   * fifteen items wherever it is opened is a menu that has to be read every
   * time. */

  function chartMenu(hit) {
    closeChartMenu();
    const menu = el('div', 'ctx-menu');
    menu.id = 'ctx-menu';

    const rows = [];
    const item = (label, act, data, extra) =>
      '<button class="ctx-row" data-act="' + esc(act) + '"' +
      Object.keys(data || {}).map(k => ' data-' + k + '="' + esc(data[k]) + '"').join('') + '>' +
      esc(label) + (extra ? '<span class="ctx-note">' + esc(extra) + '</span>' : '') + '</button>';

    if (hit.drawing) {
      const drawing = hit.drawing;
      rows.push('<div class="ctx-head">' + esc(drawing.type) + '</div>');
      rows.push('<div class="ctx-swatches">' + DRAW_COLOURS.map(colour =>
        '<button class="ctx-swatch' + ((drawing.style && drawing.style.colour) === colour ? ' on' : '') +
        '" style="background:' + colour + '" data-act="drawing-colour" data-id="' + esc(drawing.id) +
        '" data-colour="' + colour + '" title="' + colour + '"></button>').join('') + '</div>');
      rows.push('<div class="ctx-widths">' + [1, 1.4, 2, 3].map(width =>
        '<button class="ctx-width" data-act="drawing-width" data-id="' + esc(drawing.id) +
        '" data-width="' + width + '" title="' + width + 'px"><i style="height:' + width + 'px"></i></button>').join('') + '</div>');
      rows.push('<div class="ctx-sep"></div>');
      rows.push(item('Remove this drawing', 'drawing-remove', { id: drawing.id }));
      rows.push('<div class="ctx-sep"></div>');
    }

    if (hit.price != null && Number.isFinite(hit.price)) {
      const model = state.quotes.get(state.symbol);
      rows.push(item('Alert here', 'alert-at', { price: hit.price },
        model ? priceOf(model, hit.price) : ''));
    }

    rows.push('<div class="ctx-sep"></div>');
    rows.push(item('Appearance and colours…', 'menu', { menu: 'appearance' }));
    rows.push(item('Indicators…', 'menu', { menu: 'indicators' }));
    rows.push(item('Chart type…', 'menu', { menu: 'series' }));
    rows.push('<div class="ctx-sep"></div>');
    rows.push(item('Reset the view', 'scale', { scale: 'auto' }, 'Alt+R'));
    rows.push(item('Logarithmic scale', 'scale', { scale: 'log' }, 'Alt+L'));
    rows.push(item('Percentage scale', 'scale', { scale: 'percent' }, 'Alt+P'));
    rows.push(item('Invert the scale', 'scale', { scale: 'invert' }, 'Alt+I'));
    rows.push('<div class="ctx-sep"></div>');
    rows.push(item('Save a picture', 'snapshot', {}));

    menu.innerHTML = rows.join('');
    document.body.appendChild(menu);

    /* Placed so it cannot open off the edge of the window. */
    const box = menu.getBoundingClientRect();
    const x = Math.min(hit.clientX, window.innerWidth - box.width - 8);
    const y = Math.min(hit.clientY, window.innerHeight - box.height - 8);
    menu.style.left = Math.max(6, x) + 'px';
    menu.style.top = Math.max(6, y) + 'px';
  }

  function closeChartMenu() {
    const held = document.getElementById('ctx-menu');
    if (held) held.remove();
  }

  const DRAW_COLOURS = ['#f0a92e', '#2962ff', '#089981', '#f23645', '#9c27b0', '#00bcd4', '#ffffff', '#131722'];

  /* ---------- chart appearance ---------- */

  /* Every colour the chart draws with, settable and remembered. The defaults
     come from the theme, so a chart that has never been touched follows it and
     one that has been touched keeps what it was told. */
  const APPEARANCE = [
    ['background', 'Chart background'],
    ['up', 'Rising candles'],
    ['down', 'Falling candles'],
    ['wick', 'Wicks'],
    ['grid', 'Grid'],
    ['crosshair', 'Crosshair'],
    ['accent', 'Line and area series']
  ];

  /* Defaults to fall back to when no chart is currently instantiated — the
     engine chart is destroyed while the vendor's is on screen (see
     renderChartSurface), and this is reached from Settings too, where
     neither may ever have been on screen this session. The theme's own
     plane colour stands in for "background", which reads as transparent —
     the chart's actual default — rather than as a colour someone chose. */
  function appearanceDefaults() {
    const css = getComputedStyle(document.documentElement);
    const pick = (name, fallback) => (css.getPropertyValue(name) || '').trim() || fallback;
    return {
      background: pick('--plane', '#0a0d14'),
      up: pick('--candle-up', '#2ebd85'),
      down: pick('--candle-down', '#f6465d'),
      wick: pick('--ink-3', '#61616d'),
      grid: pick('--line-soft', 'rgba(255,255,255,.05)'),
      crosshair: pick('--ink-3', '#61616d'),
      crosshairStyle: 'dashed',
      accent: pick('--accent', '#3b82f6'),
      showGrid: true, showSessions: true, showVolume: true,
      showPreviousClose: true, showWatermark: false, hollow: false
    };
  }

  /* Editable from the chart's own toolbar and from Settings alike — a
     colour chosen from Settings is exactly the same state.chartStyle a
     colour chosen from the chart writes, applied the moment a chart (either
     kind) is next drawn. */
  function appearanceHtml() {
    const chart = state.chart;
    const base = Object.assign(appearanceDefaults(), chart ? chart.style : {});
    const held = state.chartStyle || {};

    let html = '<div class="section-label" style="padding-top:0">Colours</div>';
    html += APPEARANCE.map(([key, label]) => {
      const value = held[key] || base[key] || '#888888';
      return '<div class="setting"><div><div class="label">' + esc(label) + '</div></div>' +
        '<div class="value"><input type="color" class="colour-input" data-style="' + key +
        '" value="' + esc(toHex(value)) + '"></div></div>';
    }).join('');

    const crosshairStyle = held.crosshairStyle || base.crosshairStyle || 'dashed';
    html += '<div class="setting"><div><div class="label">Crosshair line</div></div>' +
      '<div class="value"><select data-act="chart-crosshair-style">' +
      ['dashed', 'dotted', 'solid'].map(id => '<option value="' + id + '"' +
        (id === crosshairStyle ? ' selected' : '') + '>' + id[0].toUpperCase() + id.slice(1) + '</option>').join('') +
      '</select></div></div>';

    html += '<div class="section-label">Show</div>';
    html += [
      ['showGrid', 'Grid lines'],
      ['showSessions', 'Session separators'],
      ['showVolume', 'Volume'],
      ['showPreviousClose', 'Previous close'],
      ['showWatermark', 'Instrument watermark'],
      ['hollow', 'Hollow rising candles']
    ].map(([key, label]) => {
      const on = held[key] === undefined ? base[key] : held[key];
      return '<div class="setting"><div><div class="label">' + esc(label) + '</div></div>' +
        '<div class="value"><button class="btn small' + (on ? ' on' : '') +
        '" data-act="chart-toggle" data-key="' + key + '">' + (on ? 'On' : 'Off') + '</button></div></div>';
    }).join('');
    /* Applies to the vendor chart the next time it is (re)mounted — its
       configuration is baked into the frame it loads, so there is no way to
       restyle one already on screen from outside its own document. */
    html += '<div class="note-line">The TradingView chart picks these up the next time it is opened or the instrument changes.</div>';

    return html;
  }

  /* A colour input only accepts `#rrggbb`. Theme values arrive as whatever the
     stylesheet holds, which may be a name or an rgb() triple. */
  function toHex(value) {
    const text = String(value || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(text)) return text;
    if (/^#[0-9a-f]{3}$/i.test(text)) return '#' + text.slice(1).split('').map(c => c + c).join('');
    const rgb = text.match(/rgba?\(([^)]+)\)/i);
    if (rgb) {
      const parts = rgb[1].split(',').map(n => Math.max(0, Math.min(255, Math.round(parseFloat(n)))));
      if (parts.length >= 3) return '#' + parts.slice(0, 3).map(n => n.toString(16).padStart(2, '0')).join('');
    }
    return '#888888';
  }

  function applyChartStyle() {
    if (state.chart) state.chart.setStyle(state.chartStyle || {});
  }

  /* The same colours state.chartStyle already holds, in the advanced-chart
     widget's own documented override shape — a flat object of dotted
     property paths to a colour string. This is the only way to recolour
     that widget at all: its configuration is baked into the frame it
     loads, so this is read fresh every time the vendor chart (re)mounts,
     never patched into a frame already on screen. */
  function vendorOverrides() {
    const base = appearanceDefaults();
    const held = state.chartStyle || {};
    const pick = key => toHex(held[key] || base[key]);
    const showGrid = held.showGrid === undefined ? base.showGrid : held.showGrid;
    const hollow = held.hollow === undefined ? base.hollow : held.hollow;
    const background = pick('background');
    const grid = showGrid ? pick('grid') : background;

    return {
      'paneProperties.background': background,
      'paneProperties.backgroundType': 'solid',
      'paneProperties.vertGridProperties.color': grid,
      'paneProperties.horzGridProperties.color': grid,
      'paneProperties.crossHairProperties.color': pick('crosshair'),
      'mainSeriesProperties.candleStyle.upColor': pick('up'),
      'mainSeriesProperties.candleStyle.downColor': pick('down'),
      'mainSeriesProperties.candleStyle.borderUpColor': pick('up'),
      'mainSeriesProperties.candleStyle.borderDownColor': pick('down'),
      'mainSeriesProperties.candleStyle.wickUpColor': pick('wick'),
      'mainSeriesProperties.candleStyle.wickDownColor': pick('wick'),
      'mainSeriesProperties.candleStyle.drawBorder': !hollow
    };
  }

  /* ---------- modal ---------- */

  function openModal(title, bodyHtml, footHtml) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = bodyHtml;
    $('#modal-foot').innerHTML = footHtml || '<button class="btn" data-act="close-modal">Close</button>';
    $('#modal-back').classList.add('on');
  }

  function closeModal() { $('#modal-back').classList.remove('on'); }

  /* Markdown lives in its own module now, because four screens render it and a
     copy per screen is four places for an escaping mistake to hide. */
  const markdown = source => window.T.markdown.render(source);

  /* ---------- research assistant ---------- */

  async function refreshSyrixStatus() {
    const badge = $('#syrix-state');
    const dockBadge = $('#syrix-dock-state');

    try {
      const status = await call('syrix:status');
      /* The raw allowance count is an operational detail for settings, not
         something to read on every glance at the badge — it only tells the
         operator to worry once it is actually the reason a question failed,
         and that failure already says so on its own. */
      const label = status.connected ? 'Connected' : 'Not connected';

      [badge, dockBadge].forEach(node => {
        if (!node) return;
        node.dataset.state = status.connected ? 'LIVE' : 'UNKNOWN';
        node.title = label;
        const text = node.querySelector('.txt');
        if (text) text.textContent = label;
      });

      renderPairBox(!status.connected);
      renderSyrixSetting(status);
    } catch (err) {
      [badge, dockBadge].forEach(node => {
        if (!node) return;
        const text = node.querySelector('.txt');
        if (text) text.textContent = 'Unavailable';
      });
    }
  }

  function renderSyrixSetting(status) {
    const host = document.getElementById('settings-syrix');
    if (!host) return;
    host.innerHTML = '<div class="setting"><div><div class="label">Connection</div>' +
      '<div class="hint">' + (status.connected
        ? 'Paired as ' + esc(status.deviceId) + '. Only a device token is stored.'
        : 'Not paired. Pair it from the SYRIX tab.') + '</div></div>' +
      '<div class="value">' + (status.connected
        ? '<button class="btn danger" data-act="syrix-disconnect">Disconnect</button>'
        : '') + '</div></div>';
  }

  /* The pairing box is drawn into whichever assistant surface is on screen, and
     into both when both are. */
  function renderPairBox(needed) {
    Array.from(document.querySelectorAll('[data-syrix-pair]')).forEach(host => {
      if (!needed) { host.innerHTML = ''; return; }
      if (host.querySelector('.pair-box')) return;
      host.innerHTML = '<div class="pair-box"><div class="t">Not connected yet</div>' +
        '<div class="d">Paste the pairing code once. Only a device token is stored, ' +
        'and it can be revoked on its own.</div>' +
        '<div class="row"><input class="pair-code" type="password" placeholder="Pairing code" autocomplete="off">' +
        '<button class="btn primary" data-act="syrix-pair">Connect</button></div></div>';
    });
  }

  /* ---------- settings ---------- */

  async function renderSettings() {
    const info = state.info || {};
    $('#about-name').textContent = info.name || '';
    $('#about-author').textContent = info.author || '';
    $('#about-meta').textContent = 'Version ' + (info.version || '') + '  ·  ' + (info.dataDir || '');
    applyTheme(document.documentElement.getAttribute('data-theme'));
    refreshSyrixStatus();
    patch('settings-appearance', appearanceHtml());
    patch('settings-depth', window.T.syrix.depthMenuHtml());

    try {
      const health = await call('app:health');
      const gated = health.sessionGated;
      const rows = [
        ['Instruments loaded', health.market.loaded + ' of ' + health.market.subscribed + ' subscribed'],
        ['Worst data state', health.market.worst],
        ['Requests made', health.http.requests + ' (' + health.http.cacheHits + ' served from cache)'],
        ['Rate limited', health.http.rateLimited ? health.http.rateLimited + ' times' : 'No'],
        ['Safe data mode', health.market.safeMode.active ? 'Active' : 'Off'],
        ['Market session', gated.available ? 'Established' : 'Not established — no ' + gated.affects.join(', ')]
      ];
      patch('settings-health', rows.map(([k, v]) =>
        '<div class="setting"><div><div class="label">' + esc(k) + '</div></div>' +
        '<div class="value">' + esc(v) + '</div></div>').join(''));
    } catch (err) {
      patch('settings-health', '<div class="note-line bad">' + esc(err.message) + '</div>');
    }
  }

  /* ---------- actions ---------- */

  const ACTIONS = {
    'win-min': () => call('window:minimize'),
    'win-max': () => call('window:maximize'),
    'win-close': () => call('window:close'),

    view: async data => {
      state.view = data.view;
      call('workspace:view', { view: data.view }).catch(() => {});
      $$('.rail-btn').forEach(b => b.classList.toggle('on', b.dataset.view === data.view));

      const target = data.view === 'chart' ? 'chart' : data.view;
      $$('.view').forEach(s => s.classList.toggle('on', s.dataset.view === target));

      /* The chart's controls live in the title bar, so they leave with it. */
      syncChartTools();
      if (data.view === 'portfolio') await screens.renderPortfolio();
      if (data.view === 'journal') await screens.renderJournal();
      if (data.view === 'settings') await renderSettings();
      if (data.view === 'alerts') { setAlertBadge(false); await renderAlerts(); }
      if (data.view === 'syrix') {
        refreshSyrixStatus();
        window.T.syrix.render();
        const box = document.querySelector('[data-view="syrix"] [data-syrix-input]');
        if (box) box.focus();
      }
      if (data.view === 'news') window.T.newsroom.loadFront();
      if (data.view === 'discover') window.T.discover.activate();
      if (data.view === 'profile') window.T.dashboard.activate();
    },

    'collapse-rail': () => $('#body').classList.toggle('rail-collapsed'),

    'toggle-side': () => {
      document.querySelector('.view.workspace').classList.toggle('side-hidden');
      readPanelFlags();
    },

    'toggle-bottom': () => {
      const main = document.querySelector('.ws-main');
      main.classList.toggle('no-bottom');
      /* Reopening a panel that was left collapsed or maximised should give back
         a panel, not the state it was hidden in. */
      if (!main.classList.contains('no-bottom')) main.classList.remove('bottom-collapsed', 'bottom-max');
      readPanelFlags();
    },

    'bp-collapse': () => {
      const main = document.querySelector('.ws-main');
      main.classList.remove('bottom-max');
      main.classList.toggle('bottom-collapsed');
      readPanelFlags();
    },

    'bp-maximise': () => {
      const main = document.querySelector('.ws-main');
      main.classList.remove('bottom-collapsed');
      main.classList.toggle('bottom-max');
      readPanelFlags();
    },

    'block-collapse': data => {
      const block = document.getElementById(data.block);
      if (!block) return;
      block.classList.toggle('collapsed');
      readPanelFlags();
    },

    select: async data => {
      hideResults();
      $('#search-input').value = '';
      await selectSymbol(data.symbol);
    },

    'focus-search': () => $('#search-input').focus(),

    /* A zoom, not a fetch. Nothing is requested; the view moves over history
       that is already loaded, and scrolling left goes on past it. */
    range: data => {
      state.chartRange = data.range;
      renderRangeBar();
      if (state.chart) state.chart.showPeriod(periodOf(data.range));
    },

    interval: async data => {
      state.chartInterval = data.interval;
      closeModal();
      renderChartBar();
      await renderChartSurface();
    },

    scale: data => {
      const chart = state.chart;
      if (!chart) return;
      const price = chart.price;

      /* Logarithmic and percentage are two answers to the same question and
         cannot both be on: one rescales the axis, the other relabels it, and
         together they produce percentages of a logarithm. */
      if (data.scale === 'log') { price.log = !price.log; if (price.log) price.percent = false; }
      else if (data.scale === 'percent') { price.percent = !price.percent; if (price.percent) price.log = false; }
      else if (data.scale === 'invert') { price.inverted = !price.inverted; }
      else { price.auto = true; }

      chart.invalidate('all');
      syncScaleButtons();
    },

    'toggle-trade-panel': () => {
      const workspace = document.querySelector('.view.workspace');
      workspace.classList.toggle('trade-open');
      $$('[data-act="toggle-trade-panel"]').forEach(b =>
        b.classList.toggle('on', workspace.classList.contains('trade-open')));
      /* Redrawn either way. The ticket lives in one host at a time, so closing
         the docked panel has to put it back in the bottom one — otherwise the
         order form simply disappears. */
      renderTicket();
      readPanelFlags();
    },

    'chart-toggle': data => {
      state.chartStyle = state.chartStyle || {};
      const chart = state.chart;
      const current = state.chartStyle[data.key] === undefined
        ? (chart ? chart.style[data.key] : appearanceDefaults()[data.key])
        : state.chartStyle[data.key];
      state.chartStyle[data.key] = !current;
      applyChartStyle();
      saveWorkspace();
      /* Reachable from the chart's own toolbar (a modal) and from Settings
         (its own page) alike — refreshed wherever it actually is rather
         than a container that only exists when it is the modal. */
      $$('[data-appearance-host]').forEach(host => { host.innerHTML = appearanceHtml(); });
    },

    'chart-crosshair-style': (data, node) => {
      state.chartStyle = state.chartStyle || {};
      state.chartStyle.crosshairStyle = node.value;
      applyChartStyle();
      saveWorkspace();
      $$('[data-appearance-host]').forEach(host => { host.innerHTML = appearanceHtml(); });
    },

    'drawing-colour': data => {
      if (!state.draw) return;
      state.draw.restyle(data.id, { colour: data.colour });
      closeChartMenu();
    },

    'drawing-width': data => {
      if (!state.draw) return;
      state.draw.restyle(data.id, { width: Number(data.width) });
      closeChartMenu();
    },

    'drawing-remove': data => {
      if (!state.draw) return;
      state.draw.remove(data.id);
      closeChartMenu();
    },

    'alert-at': data => {
      closeChartMenu();
      ACTIONS['add-alert']();
      const box = document.getElementById('al-price');
      if (box) box.value = Number(data.price).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    },

    magnet: () => {
      if (!state.chart) return;
      state.chart.magnet = !state.chart.magnet;
      $$('[data-act="magnet"]').forEach(b => b.classList.toggle('on', state.chart.magnet));
    },

    menu: data => {
      if (data.menu === 'series') {
        openModal('Chart type', SERIES.map(([id, label]) =>
          '<button class="btn' + (id === state.seriesType ? ' on' : '') +
          '" style="justify-content:flex-start;height:34px" data-act="series" data-series="' + id + '">' +
          esc(label) + '</button>').join(''));
      } else if (data.menu === 'indicators') {
        openModal('Indicators',
          '<input class="news-search" id="indicator-search" type="text" spellcheck="false" ' +
          'style="width:100%" placeholder="Search indicators…" autocomplete="off">' +
          '<div id="indicator-list">' + indicatorMenuHtml('') + '</div>');
        const box = document.getElementById('indicator-search');
        if (box) box.focus();
      } else if (data.menu === 'interval') {
        openModal('Bar size', intervalMenuHtml());
      } else if (data.menu === 'appearance') {
        closeChartMenu();
        openModal('Chart appearance', '<div data-appearance-host>' + appearanceHtml() + '</div>',
          '<button class="btn" data-act="chart-style-reset">Back to the theme</button>' +
          '<button class="btn primary" data-act="close-modal">Done</button>');
      } else if (data.menu === 'watchlist') {
        openModal('Watchlists', watchlistMenuHtml(),
          '<button class="btn" data-act="new-watchlist">New watchlist</button>' +
          '<button class="btn primary" data-act="close-modal">Done</button>');
      } else {
        openModal('Layouts', '<div class="note-line">Saved chart layouts arrive with the layout phase. ' +
          'Drawings already save themselves against the instrument.</div>');
      }
    },

    series: data => {
      state.seriesType = data.series;
      renderChartBar();
      if (state.chart) state.chart.setSeriesType(data.series);
      closeModal();
    },

    indicator: data => {
      const at = state.indicators.findIndex(i => i.id === data.id);
      if (at === -1) state.indicators.push({ id: data.id });
      else state.indicators.splice(at, 1);
      renderChartBar();
      if (state.chart) state.chart.setIndicators(state.indicators);
      /* The list is repainted in place rather than the dialog reopened, so the
         search text and the scroll position survive adding one. */
      const list = document.getElementById('indicator-list');
      const box = document.getElementById('indicator-search');
      if (list) list.innerHTML = indicatorMenuHtml(box ? box.value : '');
    },

    tool: data => {
      state.tool = data.tool;
      $$('.draw-btn[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === data.tool));
      if (state.draw) state.draw.setTool(data.tool);
    },

    'clear-drawings': () => { if (state.draw) state.draw.clear(); },

    'undo-drawing': () => {
      if (!state.draw) return;
      const held = state.draw.all();
      if (!held.length) return;
      state.draw.load(held.slice(0, -1));
      state.draw.changed();
    },

    snapshot: () => {
      /* The chart is four stacked canvases, so a picture of it has to compose
         them in order rather than copy any single one. */
      if (!state.chart) return;
      const layers = ['bg', 'main', 'draw', 'fx'].map(n => state.chart.layers[n].canvas);
      const out = document.createElement('canvas');
      out.width = layers[0].width;
      out.height = layers[0].height;
      const g = out.getContext('2d');
      const css = getComputedStyle(document.documentElement);
      g.fillStyle = (css.getPropertyValue('--plane') || '#0a0d14').trim();
      g.fillRect(0, 0, out.width, out.height);
      layers.forEach(layer => g.drawImage(layer, 0, 0));
      out.toBlob(blob => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = state.symbol + '-' + state.chartRange + '.png';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        toast('Chart image saved.');
      });
    },

    replay: () => openModal('Replay',
      '<div class="note-line">Historical replay arrives with the simulation phase. The look-ahead guard ' +
      'it depends on is already built and tested: the engine is structurally unable to return a bar past ' +
      'the replay cursor.</div>'),

    /* A full council read on the instrument on screen. The question names the
       instrument explicitly rather than relying on "this", so the answer is
       still about the right thing if the operator moves on while it runs. */
    'read-instrument': data => {
      window.T.syrix.askFrom(
        'Give me your full read on ' + data.symbol + '. Where would you get in, where would you be ' +
        'wrong, and where do you think it goes? Include the case against.');
    },

    'ask-instrument': data => {
      window.T.syrix.askFrom('Why is ' + data.symbol + ' moving today? What is actually driving it?');
    },

    'detail-tab': data => {
      state.detailTab = data.tab;
      renderSidePanel();
      /* Each tab is its own content starting from its own top — carrying a
         scroll position from the tab just left made the next one look like
         it had jumped, when what had actually happened was the opposite:
         it opened exactly where it always does, still scrolled from
         before. */
      const scroller = $('#detail-body');
      if (scroller) scroller.scrollTop = 0;
    },

    'side-detail': () => { state.detailTab = 'overview'; renderSidePanel(); },
    'side-sources': () => { state.detailTab = 'sources'; renderSidePanel(); },

    /* ---- news ---- */

    /* A headline opens into the reader rather than throwing the operator out
       into a browser. The article is fetched by the main process and arrives as
       text; this page still makes no network request of any kind. Where a
       publisher will not serve it to anything but a browser, the reader says so
       and offers the link out. */
    'open-news': data => {
      if (!data.link || !/^https?:\/\//i.test(data.link)) {
        toast('That headline carried no address.', true);
        return;
      }
      ACTIONS.view({ view: 'news' });
      window.T.newsroom.openArticle(data.link, null);
    },

    'use-watchlist': async data => {
      const list = state.watchlists.find(l => l.id === data.id);
      if (!list) return;
      state.activeList = list;
      await loadWatchlist();
      closeModal();
      toast(list.name + ' is now beside the chart.');
    },

    'add-to-watchlist': async () => {
      if (!state.symbol || !state.activeList) return;
      if (state.activeList.symbols.indexOf(state.symbol) !== -1) { toast(state.symbol + ' is already on this watchlist.'); return; }
      state.activeList.symbols = state.activeList.symbols.concat([state.symbol]);
      await call('watchlist:save', { list: state.activeList });
      await loadWatchlist();
      toast(state.symbol + ' added to ' + state.activeList.name + '.');
    },

    'wl-move': async data => {
      closeChartMenu();
      const list = state.activeList;
      if (!list) return;
      const at = list.symbols.indexOf(data.symbol);
      const to = at + Number(data.dir);
      if (at === -1 || to < 0 || to >= list.symbols.length) return;
      const next = list.symbols.slice();
      next.splice(at, 1);
      next.splice(to, 0, data.symbol);
      list.symbols = next;
      await call('watchlist:save', { list });
      await loadWatchlist();
    },

    'wl-remove': async data => {
      closeChartMenu();
      const list = state.activeList;
      if (!list) return;
      list.symbols = list.symbols.filter(s => s !== data.symbol);
      await call('watchlist:save', { list });
      await loadWatchlist();
      toast(data.symbol + ' removed from ' + list.name + '.');
    },

    'wl-add-open': () => {
      closeChartMenu();
      if (!state.activeList) return;
      openModal('Add a symbol to ' + state.activeList.name, addSymbolModalHtml());
      const input = $('#wl-add-input');
      input.focus();
      input.addEventListener('input', () => {
        clearTimeout(wlAddTimer);
        const query = input.value.trim();
        wlAddTimer = setTimeout(() => runWatchlistAddSearch(query), 220);
      });
    },

    'wl-add-pick': async data => {
      const list = state.activeList;
      if (!list) return;
      if (list.symbols.indexOf(data.symbol) !== -1) { toast(data.symbol + ' is already on this watchlist.'); return; }
      list.symbols = list.symbols.concat([data.symbol]);
      await call('watchlist:save', { list });
      await loadWatchlist();
      closeModal();
      toast(data.symbol + ' added to ' + list.name + '.');
    },

    'new-watchlist': async () => {
      const list = { id: 'wl_' + Date.now().toString(36), name: 'New watchlist', symbols: [] };
      await call('watchlist:save', { list });
      state.watchlists = await call('watchlist:list');
      state.activeList = state.watchlists.find(l => l.id === list.id);
      await loadWatchlist();
      closeModal();
      toast('New watchlist created and shown beside the chart.');
    },

    detach: data => call('layout:detach', { panel: data.panel, symbol: state.symbol }),

    /* ---- bottom panel ---- */

    bp: data => {
      state.bottomTab = data.tab;
      $$('.bp-tab[data-tab]').forEach(b => {
        if (b.dataset.act === 'bp') b.classList.toggle('on', b.dataset.tab === data.tab);
      });
      renderBottom();
    },

    'ticket-tab': data => {
      $$('[data-act="ticket-tab"]').forEach(b => b.classList.toggle('on', b.dataset.tab === data.tab));
      renderTicket();
    },

    'tk-side': data => {
      state.ticketSide = data.side;
      renderTicket();
    },

    'tk-type': data => {
      state.ticketType = data.type;
      renderTicket();
    },

    'tk-step': data => {
      const input = $('#tk-qty');
      if (!input) return;
      const step = Number(data.step) || 1;
      input.value = Math.max(0, (Number(input.value) || 0) + step);
      updatePreview();
    },

    /* Set a price field to a percentage away from the current print rather
       than typing a number from scratch. */
    'tk-offset': data => {
      const input = document.getElementById(data.target);
      const model = state.quotes.get(state.symbol);
      const last = model && num.num(model.quote.last);
      if (!input || last == null) return;
      const pct = Number(data.pct) || 0;
      const decimals = model.priceHint == null ? 2 : model.priceHint;
      input.value = (last * (1 + pct / 100)).toFixed(decimals);
      updatePreview();
    },

    'tk-place': async () => {
      const order = readTicket();
      if (!order) { toast('Enter a quantity first.', true); return; }
      try {
        const placed = await call('paper:place', { order });
        /* Whether it filled or is resting is the thing worth hearing, so the
           two are different sounds and the note says which. */
        const filled = !!(placed && (placed.state === 'filled' || placed.fill));
        fillSound(filled);
        toast(filled
          ? (order.side === 'buy' ? 'Bought' : 'Sold') + ' ' + order.quantity + ' ' + order.symbol +
            ' on the paper account.'
          : order.type + ' order resting at your price on the paper account.');
        await renderBottom();
        renderTicket();
      } catch (err) {
        toast(err.message, true);
      }
    },

    'pt-cancel': async data => {
      await call('paper:cancel', { id: data.id });
      await renderBottom();
    },

    'pt-close': async data => {
      await call('paper:place', {
        order: { symbol: data.symbol, side: data.side, quantity: Number(data.qty), type: 'market' }
      });
      await renderBottom();
      toast('Closing order placed.');
    },

    'reset-paper': async () => {
      openModal('Reset the paper account',
        '<div class="note-line warn">This removes every simulated order and every simulated transaction. ' +
        'Your real holdings and your journal are not touched.</div>',
        '<button class="btn" data-act="close-modal">Cancel</button>' +
        '<button class="btn danger" data-act="reset-paper-confirm">Reset</button>');
    },

    'reset-paper-confirm': async () => {
      await call('paper:reset');
      closeModal();
      await renderBottom();
      renderTicket();
      toast('Paper account reset.');
    },

    'open-symbol': async data => {
      await ACTIONS.view({ view: 'chart' });
      await selectSymbol(data.symbol);
    },

    /* ---- portfolio ---- */

    'pf-book': async data => { screens.state.book = data.book; await screens.renderPortfolio(); },
    'jn-book': async data => { screens.state.journalBook = data.book; await screens.renderJournal(); },
    'refresh-portfolio': () => screens.renderPortfolio(),

    'add-transaction': () => {
      const today = new Date().toISOString().slice(0, 10);
      openModal('Add a transaction',
        '<div class="grid2">' +
          fieldHtml('Book', '<select id="tx-book"><option value="mirror">My holdings</option>' +
            '<option value="paper">Paper</option></select>') +
          fieldHtml('Type', '<select id="tx-kind"><option value="buy">Buy</option><option value="sell">Sell</option>' +
            '<option value="dividend">Dividend</option><option value="deposit">Deposit</option>' +
            '<option value="withdrawal">Withdrawal</option><option value="fee">Fee</option>' +
            '<option value="split">Split</option></select>') +
        '</div>' +
        '<div class="grid2">' +
          fieldHtml('Instrument', '<input id="tx-symbol" value="' + esc(state.symbol || '') + '">') +
          fieldHtml('Date', '<input id="tx-date" type="date" value="' + today + '">') +
        '</div>' +
        '<div class="grid2">' +
          fieldHtml('Quantity', '<input id="tx-qty" type="number" step="any">') +
          fieldHtml('Price per unit', '<input id="tx-price" type="number" step="any">') +
        '</div>' +
        '<div class="grid2">' +
          fieldHtml('Currency', '<input id="tx-ccy" value="' + esc(currencyGuess()) + '">') +
          fieldHtml('Fees', '<input id="tx-fees" type="number" step="any" value="0">') +
        '</div>' +
        fieldHtml('Amount — for a dividend, deposit, withdrawal or fee', '<input id="tx-amount" type="number" step="any">') +
        fieldHtml('Ratio — for a split, 2 means two-for-one', '<input id="tx-ratio" type="number" step="any">') +
        '<div class="note-line">Everything else is worked out from this. Average entry, profit and the ' +
        'journal all come from the transactions, so they can never disagree with them.</div>',
        '<button class="btn" data-act="close-modal">Cancel</button>' +
        '<button class="btn primary" data-act="save-transaction">Add</button>');
    },

    'save-transaction': async () => {
      const value = id => {
        const node = document.getElementById(id);
        if (!node) return null;
        const raw = node.value;
        if (raw === '' || raw == null) return null;
        return node.type === 'number' ? Number(raw) : raw;
      };
      const transaction = {
        book: value('tx-book'),
        kind: value('tx-kind'),
        at: value('tx-date') ? Date.parse(value('tx-date') + 'T12:00:00Z') : Date.now(),
        symbol: value('tx-symbol'),
        quantity: value('tx-qty'),
        price: value('tx-price'),
        currency: value('tx-ccy'),
        fees: value('tx-fees') || 0,
        amount: value('tx-amount'),
        ratio: value('tx-ratio')
      };
      try {
        await call('portfolio:add', { transaction });
        closeModal();
        await screens.renderPortfolio();
        toast('Transaction added.');
      } catch (err) {
        toast(err.message, true);
      }
    },

    'remove-transaction': async data => {
      await call('portfolio:remove', { id: data.id });
      await screens.renderPortfolio();
    },

    /* ---- journal ---- */

    'journal-note': data => {
      const trade = (screens.state.journal && screens.state.journal.trades.find(t => t.key === data.key)) || null;
      const note = (trade && trade.annotation) || {};
      openModal('Journal entry',
        (trade ? '<div class="note-line">' + esc(trade.symbol) + ' · ' + esc(trade.direction) + ' · ' +
          esc(String(trade.quantity)) + ' at ' + esc(String(trade.entryPrice)) + ' → ' + esc(String(trade.exitPrice)) + '</div>' : '') +
        '<div class="grid2">' +
          fieldHtml('Setup', '<input id="jn-setup" value="' + esc(note.setup || '') + '">') +
          fieldHtml('Tags — comma separated', '<input id="jn-tags" value="' + esc((note.tags || []).join(', ')) + '">') +
        '</div>' +
        '<div class="grid2">' +
          fieldHtml('Stop actually taken', '<input id="jn-stop" type="number" step="any" value="' + esc(note.stop == null ? '' : note.stop) + '">') +
          fieldHtml('Target', '<input id="jn-target" type="number" step="any" value="' + esc(note.target == null ? '' : note.target) + '">') +
        '</div>' +
        fieldHtml('Thesis — why you took it', '<textarea id="jn-thesis" rows="3">' + esc(note.thesis || '') + '</textarea>') +
        fieldHtml('Mistakes', '<textarea id="jn-mistakes" rows="2">' + esc(note.mistakes || '') + '</textarea>') +
        '<div class="note-line">An R multiple needs the stop that was really in the market. Without it the ' +
        'figure is left out rather than estimated.</div>',
        '<button class="btn" data-act="close-modal">Cancel</button>' +
        '<button class="btn primary" data-act="save-journal" data-key="' + esc(data.key) + '">Save</button>');
    },

    'save-journal': async data => {
      const text = id => (document.getElementById(id) || {}).value || '';
      const numberOf = id => {
        const raw = text(id);
        return raw === '' ? null : Number(raw);
      };
      await call('journal:annotate', {
        key: data.key,
        note: {
          setup: text('jn-setup'),
          tags: text('jn-tags').split(',').map(t => t.trim()).filter(Boolean),
          stop: numberOf('jn-stop'),
          target: numberOf('jn-target'),
          thesis: text('jn-thesis'),
          mistakes: text('jn-mistakes')
        }
      });
      closeModal();
      await screens.renderJournal();
      toast('Journal entry saved.');
    },

    /* ---- alerts ---- */

    'add-alert': () => {
      openModal('New alert',
        '<div class="grid2">' +
          fieldHtml('Instrument', '<input id="al-symbol" value="' + esc(state.symbol || '') + '">') +
          fieldHtml('Condition', '<select id="al-kind"><option value="above">Price rises above</option>' +
            '<option value="below">Price falls below</option></select>') +
        '</div>' +
        fieldHtml('Price', '<input id="al-price" type="number" step="any">') +
        '<div class="note-line">Alerts are evaluated whenever a price arrives, so they only fire while the ' +
        'application is open. They are suspended in safe data mode.</div>',
        '<button class="btn" data-act="close-modal">Cancel</button>' +
        '<button class="btn primary" data-act="save-alert">Create</button>');
    },

    'save-alert': async () => {
      const symbol = ($('#al-symbol') || {}).value;
      const price = Number(($('#al-price') || {}).value);
      const kind = ($('#al-kind') || {}).value;
      if (!symbol || !Number.isFinite(price)) { toast('An alert needs an instrument and a price.', true); return; }
      await call('alert:save', { alert: { symbol: symbol.toUpperCase(), kind, price } });
      closeModal();
      await renderAlerts();
      toast('Alert created.');
    },

    'remove-alert': async data => {
      await call('alert:remove', { id: data.id });
      await renderAlerts();
    },

    'rearm-alert': async data => {
      await call('alert:rearm', { id: data.id });
      await renderAlerts();
      toast('Alert re-armed.');
    },

    /* ---- research ---- */

    'syrix-pair': async () => {
      const input = document.querySelector('.pair-code');
      const code = input ? input.value.trim() : '';
      if (!code) { toast('Paste the pairing code first.', true); return; }
      await call('syrix:pair', { code, label: 'Terminal on this machine' });
      if (input) input.value = '';
      await refreshSyrixStatus();
      toast('Connected.');
    },

    'syrix-disconnect': async () => {
      await call('syrix:disconnect');
      await refreshSyrixStatus();
    },

    /* ---- shell ---- */

    theme: async data => {
      applyTheme(data.mode);
      await call('theme:save', { theme: { name: 'default', mode: data.mode } });
      /* The chart resolves its colours at construction, so it is rebuilt rather
         than left painting the previous palette. */
      if (state.chart) { state.chart.destroy(); state.chart = null; }
      /* An embedded widget takes its palette from the configuration it was built
         with, and there is no way to restyle one from outside its own document.
         Each is remounted with the new theme. */
      window.T.embeds.retheme(document, data.mode);
      await renderChartSurface();
    },

    'chart-style-reset': async () => {
      state.chartStyle = {};
      saveWorkspace();
      /* The chart resolves the theme's colours at construction, so it is
         rebuilt rather than left holding the overrides it was given. */
      if (state.chart) { state.chart.destroy(); state.chart = null; await loadChart(); }
      $$('[data-appearance-host]').forEach(host => { host.innerHTML = appearanceHtml(); });
      toast('Chart colours are back to the theme.');
    },

    'reload-window': () => window.location.reload(),

    'search-scope': data => {
      state.searchScope = data.scope;
      const query = $('#search-input').value.trim();
      if (query) runSearch(query);
    },

    /* The chart surface. The engine in this application and the vendor's own
       chart are both real charts and each is better at something: this one is
       instrumented, replayable and draws from the same bars every figure on the
       screen came from, and that one has the drawing toolkit and the indicator
       library of a product with a hundred people on it. Switching is a toggle
       rather than a decision made once in a settings page. */
    'chart-source': async data => {
      state.chartSource = data.source === 'vendor' ? 'vendor' : 'native';
      saveWorkspace();
      await renderChartSurface();
      renderChartBar();
    },

    'close-modal': closeModal
  };

  /* THE SCREENS THAT OWN THEIR OWN MARKUP OWN THEIR OWN ACTIONS.
   *
   * Each of them returns a table of what its controls do, and those are folded
   * in here. The dispatcher stays single — one delegated listener for the whole
   * document — while a screen's behaviour stays in the file that draws it. The
   * architecture suite checks that every data-act in the markup has an entry
   * here, so a control that does nothing is a failing test rather than a button
   * that silently is not one. */
  Object.assign(ACTIONS,
    window.T.newsroom.actions(),
    window.T.discover.actions(),
    window.T.dashboard.actions(),
    window.T.syrix.actions());

  function fieldHtml(label, control) {
    return '<div class="field"><label>' + esc(label) + '</label>' + control + '</div>';
  }

  function currencyGuess() {
    const model = state.quotes.get(state.symbol);
    return (model && model.currency) || 'GBP';
  }

  function titleOf(view) {
    return {
      reports: 'Reports', news: 'Newsroom', discover: 'Discover',
      profile: 'Performance', syrix: 'SYRIX'
    }[view] || view;
  }

  async function renderAlerts() {
    const body = $('#alerts-body');
    try {
      const alerts = await call('alert:list');
      if (!alerts.length) {
        body.innerHTML = '<div class="empty"><div class="big">No alerts yet</div>' +
          '<div>Create one from any chart, or with the button above.</div></div>';
        return;
      }
      body.innerHTML = '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>Instrument</th><th>Condition</th><th class="num">Price</th><th>Status</th><th></th>' +
        '</tr></thead><tbody>' + alerts.map(a => '<tr' + (a.firedAt ? ' class="alert-fired"' : '') + '>' +
          '<td class="mono">' + esc(a.symbol) + '</td>' +
          '<td>' + esc(a.kind === 'below' ? 'Falls below' : 'Rises above') + '</td>' +
          '<td class="num">' + esc(String(a.price)) + '</td>' +
          '<td>' + (a.firedAt
            ? 'Fired at ' + esc(String(a.firedPrice)) + ' · ' + esc(clock.asOf(a.firedAt))
            : 'Watching since ' + esc(clock.asOf(a.createdAt))) + '</td>' +
          '<td class="num">' +
            (a.firedAt ? '<button class="btn small" data-act="rearm-alert" data-id="' + esc(a.id) + '">Re-arm</button> ' : '') +
            '<button class="btn small danger" data-act="remove-alert" data-id="' + esc(a.id) + '">Remove</button>' +
          '</td>' +
          '</tr>').join('') + '</tbody></table></div>';
    } catch (err) {
      body.innerHTML = '<div class="note-line bad">' + esc(err.message) + '</div>';
    }
  }

  /* The watchlist switcher.
   *
   * There used to be a whole rail tab and screen for this — a redundant page
   * showing what the right-hand column beside the chart already shows,
   * always, while charting. What that column's own header lacked was a real
   * way to move between lists rather than a button that only cycled to the
   * next one. This is that: every list, which one is on screen now, and a
   * click to switch straight to a named one. Pricing stays in the side
   * column, which is the one place it needs to live. */
  function watchlistMenuHtml() {
    if (!state.watchlists.length) {
      return '<div class="note-line">No watchlists yet.</div>';
    }
    return state.watchlists.map(list => {
      const active = !!(state.activeList && list.id === state.activeList.id);
      return '<button class="btn menu-row' + (active ? ' on' : '') + '"' +
        (active ? '' : ' data-act="use-watchlist" data-id="' + esc(list.id) + '"') + '>' +
        '<span class="tick">' + (active ? '✓' : '') + '</span>' +
        '<span class="menu-text"><b>' + esc(list.name) + '</b>' +
        '<span class="muted">' + list.symbols.length + ' instrument' + (list.symbols.length === 1 ? '' : 's') +
        (active ? ' · shown beside the chart' : '') + '</span></span>' +
        '</button>';
    }).join('');
  }

  /* ---------- events ---------- */

  document.addEventListener('click', async event => {
    const node = event.target.closest('[data-act]');
    if (!node) return;
    const action = ACTIONS[node.dataset.act];
    if (!action) return;
    event.preventDefault();
    try {
      await action(node.dataset, node);
    } catch (err) {
      console.error(node.dataset.act, err);
      toast(err.message, true);
    }
  });

  document.addEventListener('input', event => {
    if (event.target.closest('#ticket') || event.target.closest('#trade-panel-body')) updatePreview();
    if (event.target.id === 'indicator-search') {
      const list = document.getElementById('indicator-list');
      if (list) list.innerHTML = indicatorMenuHtml(event.target.value);
    }
    /* The assistant's box grows with what is typed into it, up to a point,
       wherever it is on screen. */
    const composer = event.target.closest('[data-syrix-input]');
    if (composer) {
      composer.style.height = 'auto';
      composer.style.height = Math.min(composer.scrollHeight, 200) + 'px';
    }
  });

  /* A select is not a click. Both screens that use one dispatch through the same
     table as everything else — including the same error handling: a handler
     that throws here used to fail with nothing on screen at all, which reads
     exactly like a dropdown that "does not work". */
  document.addEventListener('change', async event => {
    const node = event.target.closest('[data-act]');
    if (!node || node.tagName !== 'SELECT') return;
    const action = ACTIONS[node.dataset.act];
    if (!action) return;
    try {
      await action(node.dataset, node);
    } catch (err) {
      console.error(node.dataset.act, err);
      toast(err.message, true);
    }
  });

  document.addEventListener('pointerdown', event => {
    const handle = event.target.closest('.splitter');
    if (handle) beginResize(handle, event);
    /* Any press outside the context menu closes it, which is what every menu
       on this platform does and what the hand expects. */
    if (!event.target.closest('#ctx-menu')) closeChartMenu();
  });

  /* The watchlist had no way to reorder, remove or add a symbol at all — a
     row opened an instrument and did nothing else. Reuses the same
     #ctx-menu the chart's own right-click opens, so there is one
     context-menu mechanism rather than two. Bound to the scroller as well
     as the row so a right-click on the empty space below the last symbol —
     or on an empty list — still offers a way to add one. */
  document.addEventListener('contextmenu', event => {
    const row = event.target.closest('.wl-row');
    if (row) { event.preventDefault(); watchlistRowMenu(row, event); return; }
    if (event.target.closest('#wl-rows')) { event.preventDefault(); watchlistRowMenu(null, event); }
  });

  function watchlistRowMenu(row, event) {
    closeChartMenu();
    const list = state.activeList;
    if (!list) return;
    const symbol = row && row.dataset.symbol;
    const at = symbol ? list.symbols.indexOf(symbol) : -1;
    if (symbol && at === -1) return;

    const menu = el('div', 'ctx-menu');
    menu.id = 'ctx-menu';
    const item = (label, act, data, disabled) =>
      '<button class="ctx-row" data-act="' + esc(act) + '"' + (disabled ? ' disabled' : '') +
      Object.keys(data || {}).map(k => ' data-' + k + '="' + esc(data[k]) + '"').join('') + '>' +
      esc(label) + '</button>';

    menu.innerHTML = (symbol ? '<div class="ctx-head">' + esc(symbol) + '</div>' : '') +
      (symbol
        ? item('Move up', 'wl-move', { symbol, dir: '-1' }, at === 0) +
          item('Move down', 'wl-move', { symbol, dir: '1' }, at === list.symbols.length - 1) +
          '<div class="ctx-sep"></div>' +
          item('Open', 'select', { symbol }) +
          item('Remove from this list', 'wl-remove', { symbol }) +
          '<div class="ctx-sep"></div>'
        : '') +
      item('Add a symbol…', 'wl-add-open', {});

    document.body.appendChild(menu);
    const box = menu.getBoundingClientRect();
    const x = Math.min(event.clientX, window.innerWidth - box.width - 8);
    const y = Math.min(event.clientY, window.innerHeight - box.height - 8);
    menu.style.left = Math.max(6, x) + 'px';
    menu.style.top = Math.max(6, y) + 'px';
  }

  document.addEventListener('input', event => {
    const swatch = event.target.closest('.colour-input');
    if (!swatch) return;
    state.chartStyle = state.chartStyle || {};
    state.chartStyle[swatch.dataset.style] = swatch.value;
    /* The two fill colours follow their outline colour unless they have been
       set apart deliberately, so choosing "rising candles" does the obvious
       thing rather than leaving hollow bodies in the old colour. */
    if (swatch.dataset.style === 'up') state.chartStyle.upFill = swatch.value;
    if (swatch.dataset.style === 'down') state.chartStyle.downFill = swatch.value;
    if (swatch.dataset.style === 'up' || swatch.dataset.style === 'down') {
      state.chartStyle.volumeUp = state.chartStyle.up || (state.chart && state.chart.style.up);
      state.chartStyle.volumeDown = state.chartStyle.down || (state.chart && state.chart.style.down);
    }
    applyChartStyle();
    saveWorkspace();
  });

  /* A window that shrinks past a remembered size re-clamps rather than letting
     a panel push everything else off the bottom. */
  window.addEventListener('resize', () => {
    clearTimeout(applyPanels.timer);
    applyPanels.timer = setTimeout(applyPanels, 120);
  });

  $('#search-input').addEventListener('input', event => {
    const query = event.target.value.trim();
    if (searchTimer) clearTimeout(searchTimer);
    if (!query) { hideResults(); return; }
    searchTimer = setTimeout(() => runSearch(query), 220);
  });

  /* Enter sends, in whichever assistant surface is being typed into, and in the
     newsroom's search box. Delegated rather than bound, because both of those
     are drawn and redrawn by their own modules. */
  document.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey) return;

    if (event.target.matches('[data-syrix-input]')) {
      event.preventDefault();
      const value = event.target.value;
      event.target.value = '';
      event.target.style.height = '';
      window.T.syrix.ask(value);
      return;
    }

    if (event.target.id === 'news-query') {
      event.preventDefault();
      window.T.newsroom.search(event.target.value);
    }
  });

  document.addEventListener('keydown', event => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);

    /* A focused splitter moves with the arrow keys, so the layout can be set
       without a pointer at all. */
    const handle = document.activeElement && document.activeElement.classList &&
      document.activeElement.classList.contains('splitter') ? document.activeElement : null;
    if (handle && /^Arrow/.test(event.key)) {
      const spec = SPLITTERS[handle.dataset.resize];
      const along = spec && (spec.axis === 'x'
        ? (event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0)
        : (event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0));
      if (along) {
        event.preventDefault();
        setPanelSize(spec, panelSize(spec) + spec.sign * along * (event.shiftKey ? 24 : 8));
        saveWorkspace();
        return;
      }
    }

    if (event.key === 'Escape') {
      hideResults();
      closeChartMenu();
      closeModal();
      if (state.tool !== 'cursor') ACTIONS.tool({ tool: 'cursor' });
    }
    if (event.key === '/' && !typing) { event.preventDefault(); $('#search-input').focus(); }
    if ((event.key === 'Delete' || event.key === 'Backspace') && !typing && state.draw) state.draw.removeSelected();
  });

  /* Exposed for the interface probe, which asserts every data-act on every
     screen has a handler here. */
  window.ACTIONS = ACTIONS;
  window.__state = state;
  /* Exposed so the probe can redraw the instrument header the way an arriving
     quote does, and check that what was painted into it survives. */
  window.__redraw = renderInstrumentBar;
  window.__applyPanels = applyPanels;

  boot().catch(err => {
    document.body.innerHTML = '<div class="note-line bad" style="margin:40px">' +
      'The interface could not start: ' + esc(err.message) + '</div>';
  });

}());
