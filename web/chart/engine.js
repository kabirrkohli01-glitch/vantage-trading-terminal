'use strict';
/* The chart engine.
 *
 * FOUR CANVASES, STACKED, EACH REDRAWN ONLY WHEN ITS OWN INPUTS CHANGE. This is
 * the whole performance story of a terminal that ticks. Moving the pointer
 * repaints one transparent layer holding a crosshair and a couple of labels;
 * the candles, the grid and the drawings underneath are not touched. Painting
 * everything into one canvas means every mouse move redraws several thousand
 * primitives, which is what makes a chart feel heavy.
 *
 *   bg    grid, session separators, watermark       — on viewport change
 *   main  series, overlays, volume, lower panes     — on data or viewport change
 *   draw  the operator's own drawings               — on edit or viewport change
 *   fx    crosshair, live tag, measurements         — on pointer move
 *
 * THE VIEWPORT IS EXPRESSED IN FRACTIONAL BAR INDICES, not in timestamps and
 * not in pixels. Bar indices make panning and zooming uniform across
 * instruments whose bars are irregularly spaced — a daily chart skips weekends,
 * a futures chart skips its close, and crypto never stops. Working in time
 * would make a weekend a visible gap the width of two trading days. Working in
 * pixels would make every drawing move when the window resizes.
 *
 * DRAWINGS ARE ANCHORED IN TIME AND PRICE, never in pixels or indices, so they
 * survive a timeframe change, a zoom, a resize and a reload. See project().
 */

(function () {

  const num = window.T.num;
  const clock = window.T.clock;
  const candles = window.T.candles;
  const indicators = window.T.indicators;

  /* Geometry. The right gutter holds price labels; the strip along the bottom
     holds time labels. Both are drag targets for scaling. */
  const AXIS_W = 64;
  const TIME_H = 22;
  const PANE_GAP = 8;
  const TOP_PAD = 14;
  const BOTTOM_PAD = 10;

  const MIN_BARS_VISIBLE = 8;
  const MAX_BAR_WIDTH = 40;

  /* Feel. These are the numbers that decide whether the chart reads as a
     surface being moved or as a picture being redrawn, and they are expressed
     as time constants in milliseconds so the result is the same on any refresh
     rate. A zoom that settles in about a tenth of a second is felt as direct; a
     flick that coasts for about a fifth of a second before it is gone matches
     the reference and does not overshoot into empty space. */
  const ZOOM_TIME_CONSTANT = 42;
  /* A firm coast, not a long one. At 190 a hard flick was still drifting most
     of a second later, which reads as the chart having its own opinion about
     where it should sit. */
  const MOMENTUM_TIME_CONSTANT = 140;

  const SEPARATOR_GRAB = 4;      // half-height of a pane separator's hit area
  const PANE_MIN_HEIGHT = 42;
  const MAGNET_REACH = 14;       // pixels within which the crosshair snaps
  const CROSSHAIR_DASH = { solid: [], dashed: [3, 3], dotted: [1, 3] };

  /* Style, all overridable per chart so every element in the brief's
     customisation list can be changed independently. Values are resolved from
     CSS custom properties at construction so the chart follows the theme
     without duplicating the palette. */
  /* A colour with transparency, derived from whatever the theme holds rather
     than written out beside it. A hard-coded translucent copy of the accent is
     a second home for the same colour, and it is the one that gets forgotten
     when the accent changes — which is how a blue chart ends up with amber
     fills under its shapes. */
  function withAlpha(colour, alpha) {
    const text = String(colour || '').trim();
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text);
    const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(text);
    let rgb = null;
    if (long) rgb = [long[1], long[2], long[3]].map(h => parseInt(h, 16));
    else if (short) rgb = [short[1], short[2], short[3]].map(h => parseInt(h + h, 16));
    else {
      const parsed = /rgba?\(([^)]+)\)/i.exec(text);
      if (parsed) rgb = parsed[1].split(',').slice(0, 3).map(n => Math.round(parseFloat(n)));
    }
    if (!rgb || rgb.some(n => !Number.isFinite(n))) return text;
    return 'rgba(' + rgb.join(',') + ',' + alpha + ')';
  }

  /* Conventional indicator colours, not brand colours. A MACD signal line is
     orange and a %D is orange everywhere these are drawn, so they are named
     here and left alone by the theme. */
  const SIGNAL_COLOUR = '#ff6d00';
  const SECOND_LINE = '#2962ff';

  function defaultStyle(root) {
    const css = getComputedStyle(root);
    const pick = (name, fallback) => (css.getPropertyValue(name) || '').trim() || fallback;
    const accent = pick('--accent', '#3b82f6');
    return {
      background: 'transparent',
      grid: pick('--line-soft', 'rgba(255,255,255,.05)'),
      gridStrong: pick('--line', 'rgba(255,255,255,.09)'),
      axisText: pick('--ink-3', '#61616d'),
      text: pick('--ink', '#ededf1'),
      up: pick('--candle-up', '#2ebd85'),
      down: pick('--candle-down', '#f6465d'),
      upFill: pick('--candle-up', '#2ebd85'),
      downFill: pick('--candle-down', '#f6465d'),
      wick: null,               // null follows the body colour
      hollow: false,            // draw rising bodies as outlines only
      crosshair: pick('--ink-3', '#61616d'),
      crosshairStyle: 'dashed', // 'solid' | 'dashed' | 'dotted' — see CROSSHAIR_DASH

      /* The ink on an axis tag. A tag's background is always a saturated colour
         — the up green, the down red, the crosshair grey — so its text is white
         in both themes. It used to be near-black, which is invisible on a dark
         tag and was written before the light theme existed. */
      tagInk: '#ffffff',
      plane: pick('--plane', '#0a0d14'),

      accent,
      /* Every translucent shade the chart uses is derived from the accent, so
         changing one colour changes all of them together. */
      areaFill: withAlpha(accent, 0.22),
      profileFill: withAlpha(accent, 0.2),
      shapeFill: withAlpha(accent, 0.1),

      /* A measurement reads in the colours of rising and falling, which are not
         the colours the candles happen to be set to — measuring a drop on a
         chart drawn in blue and black should still be red. */
      measureUp: pick('--up', '#26a69a'),
      measureDown: pick('--down', '#ef5350'),
      measureFill: rising => withAlpha(rising ? pick('--up', '#26a69a') : pick('--down', '#ef5350'), 0.14),

      watermark: pick('--line-soft', 'rgba(255,255,255,.05)'),
      /* Volume follows the candles rather than carrying its own pair of
         colours, so recolouring the chart cannot leave the histogram green
         under blue candles. The transparency is applied when it is drawn. */
      volumeUp: pick('--candle-up', '#2ebd85'),
      volumeDown: pick('--candle-down', '#f6465d'),
      volumeAlpha: 0.34,
      sessionLine: pick('--line', 'rgba(255,255,255,.09)'),
      showGrid: true,
      showSessions: true,
      /* Off. The instrument is already named in the header, in the legend and
         on the axis tag; a fourth copy of it sitting behind the candles is
         decoration that competes with the data for the same pixels. It stays
         switchable because a detached chart on a second monitor has no header
         above it. */
      showWatermark: false,
      showVolume: true,
      showPreviousClose: true,
      font: '11px ' + (pick('--mono', 'monospace')),
      labelFont: '10px ' + (pick('--mono', 'monospace'))
    };
  }

  /* Nice round steps for an axis. Choosing from a fixed ladder rather than
     dividing the range gives labels a human reads as round numbers. */
  function niceStep(span, targetCount) {
    if (!(span > 0)) return 1;
    const rough = span / Math.max(1, targetCount);
    const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
    const normalised = rough / magnitude;
    const step = normalised >= 5 ? 5 : normalised >= 2.5 ? 2.5 : normalised >= 2 ? 2 : 1;
    return step * magnitude;
  }

  class Chart {
    constructor(container, options) {
      const opts = options || {};
      this.root = container;
      this.style = Object.assign(defaultStyle(document.documentElement), opts.style || {});

      this.bars = [];
      this.baseBars = [];
      this.symbol = opts.symbol || '';
      this.timeframe = opts.timeframe || '';
      this.currency = null;
      this.assetClass = null;
      this.priceHint = null;
      this.timeZone = null;
      this.previousClose = null;
      this.seriesType = opts.seriesType || 'candle';
      this.renkoSize = null;
      this.rangeSize = null;

      /* Fractional bar indices. `to` may exceed the last bar so there is empty
         space on the right to draw into, which is where a projected cloud and a
         forward-extended trend line live. */
      this.view = { from: 0, to: 1 };
      this.price = {
        min: 0, max: 1, auto: true, log: false,
        /* Percentage and inverted are presentation of the same numbers, not a
           different set of them: the axis and the crosshair relabel, the bars
           are untouched. */
        percent: false, inverted: false,
        lockedMin: null, lockedMax: null
      };

      this.geometry = null;          // cached pane rectangles, see layout()
      this.magnet = false;           // crosshair snaps to the nearest OHLC
      this.momentum = null;          // decaying pan after a flick
      this.zoomTween = null;         // eased wheel zoom

      this.overlays = [];     // indicators drawn on the price pane
      this.lowerPanes = [];   // indicators with their own pane
      this.drawings = [];
      this.cursor = null;     // { index, price, x, y } while the pointer is over the plot

      this.onCrosshair = opts.onCrosshair || null;
      this.onViewChange = opts.onViewChange || null;
      /* The scale can be changed from the keyboard and from the axis as well as
         from the toolbar, so the toolbar has to be told rather than assume it
         is the only way in. A button showing "log" as off over a logarithmic
         chart is a control that has stopped describing the thing it controls. */
      this.onScaleChange = opts.onScaleChange || null;
      this.onContextMenu = opts.onContextMenu || null;

      this.layers = {};
      ['bg', 'main', 'draw', 'fx'].forEach(name => {
        const canvas = document.createElement('canvas');
        canvas.className = 'layer-' + name;
        container.appendChild(canvas);
        this.layers[name] = { canvas, ctx: canvas.getContext('2d'), dirty: true };
      });

      this.dpr = 1;
      this.width = 0;
      this.height = 0;
      this.frame = null;
      this.motionFrame = null;
      this.viewTarget = null;
      this.lastPriceY = null;

      /* Panning away from the newest bar is easy and getting back to it by hand
         is not, so the way back is offered where the operator is already
         looking rather than in a toolbar. */
      this.jumpButton = document.createElement('button');
      this.jumpButton.className = 'chart-jump';
      this.jumpButton.type = 'button';
      this.jumpButton.title = 'Back to the latest bar';
      this.jumpButton.setAttribute('aria-label', 'Back to the latest bar');
      this.jumpButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
      this.jumpButton.addEventListener('click', () => this.scrollToRealtime());
      container.appendChild(this.jumpButton);

      /* The bar countdown is the only thing on the chart that changes without
         either the data or the pointer moving, so it gets its own slow tick —
         and it repaints the effects layer alone, never the candles. */
      this.clockTimer = setInterval(() => {
        if (this.barCountdown()) this.invalidate('fx');
      }, 1000);

      this.observer = new ResizeObserver(() => this.measure());
      this.observer.observe(container);
      this.measure();
      this.bindPointer();
    }

    /* ---------- sizing ---------- */

    measure() {
      const rect = this.root.getBoundingClientRect();
      /* Capped: a very high pixel ratio multiplies fill cost for no visible
         gain on a chart made of hairlines. */
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      if (rect.width === this.width && rect.height === this.height && dpr === this.dpr) return;

      this.width = rect.width;
      this.height = rect.height;
      this.dpr = dpr;
      this.relayout();

      Object.values(this.layers).forEach(layer => {
        layer.canvas.width = Math.max(1, Math.round(rect.width * dpr));
        layer.canvas.height = Math.max(1, Math.round(rect.height * dpr));
        layer.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        layer.dirty = true;
      });
      this.invalidate('all');
    }

    /* Where each pane sits. The price pane takes whatever the lower panes leave
       behind, with a floor so adding a fourth oscillator cannot squeeze the
       candles to nothing.
     *
     * THE RESULT IS CACHED, AND THAT IS NOT AN OPTIMISATION — IT IS THE
     * DIFFERENCE BETWEEN A CHART THAT GLIDES AND ONE THAT LURCHES. Every call
     * to xOf, yOf, priceAt, indexAt and barWidth needs the geometry, and
     * painting a candle calls four of them. On two thousand bars that is ten
     * thousand recomputations of the same rectangle per frame, each one
     * allocating an array and running a reduce over the lower panes. The cache
     * is dropped whenever anything that could move a pane changes. */
    layout() {
      if (this.geometry) return this.geometry;

      const plotWidth = Math.max(10, this.width - AXIS_W);
      const usableHeight = Math.max(10, this.height - TIME_H);
      const lowerHeight = this.lowerPanes.reduce((sum, pane) => sum + pane.height + PANE_GAP, 0);
      const priceHeight = Math.max(80, usableHeight - lowerHeight);

      const panes = [{ id: 'price', top: 0, height: priceHeight }];
      let y = priceHeight + PANE_GAP;
      this.lowerPanes.forEach(pane => {
        panes.push({ id: pane.id, top: y, height: pane.height, pane });
        y += pane.height + PANE_GAP;
      });

      this.geometry = { plotWidth, usableHeight, panes, priceHeight };
      return this.geometry;
    }

    relayout() { this.geometry = null; }

    /* ---------- scales ---------- */

    barWidth() {
      const { plotWidth } = this.layout();
      return plotWidth / Math.max(1e-6, this.view.to - this.view.from);
    }

    xOf(index) {
      const { plotWidth } = this.layout();
      return ((index - this.view.from) / Math.max(1e-6, this.view.to - this.view.from)) * plotWidth;
    }

    indexAt(x) {
      const { plotWidth } = this.layout();
      return this.view.from + (x / Math.max(1, plotWidth)) * (this.view.to - this.view.from);
    }

    /* Log scaling and inversion are only meaningful on price. An oscillator
       bounded at nought would be undefined under a logarithm, and inverting one
       would put its guides in the wrong place. */
    isPricePane(box) { return !box.id || box.id === 'price'; }

    yOf(price, pane) {
      const box = pane || { top: 0, height: this.layout().priceHeight };
      const top = box.top + TOP_PAD;
      const height = Math.max(1, box.height - TOP_PAD - BOTTOM_PAD);
      const { min, max } = this.priceRangeFor(box);
      const onPrice = this.isPricePane(box);

      let ratio;
      if (this.price.log && onPrice && min > 0) {
        const lo = Math.log(min);
        const hi = Math.log(max);
        ratio = (Math.log(Math.max(price, Number.MIN_VALUE)) - lo) / Math.max(1e-9, hi - lo);
      } else {
        ratio = (price - min) / Math.max(1e-9, max - min);
      }

      if (onPrice && this.price.inverted) ratio = 1 - ratio;
      return top + (1 - ratio) * height;
    }

    priceAt(y, pane) {
      const box = pane || { top: 0, height: this.layout().priceHeight };
      const top = box.top + TOP_PAD;
      const height = Math.max(1, box.height - TOP_PAD - BOTTOM_PAD);
      const { min, max } = this.priceRangeFor(box);
      const onPrice = this.isPricePane(box);

      let ratio = 1 - (y - top) / height;
      if (onPrice && this.price.inverted) ratio = 1 - ratio;

      if (this.price.log && onPrice && min > 0) {
        return Math.exp(Math.log(min) + ratio * (Math.log(max) - Math.log(min)));
      }
      return min + ratio * (max - min);
    }

    /* The base a percentage scale is measured from: the close of the first bar
       in view. Reading it from the first bar rather than the first visible one
       would make the axis stop changing as the chart is panned, which is not
       what the reference does. */
    percentBase() {
      const { from, to } = this.visibleRange();
      for (let i = from; i <= to; i++) {
        const bar = this.bars[i];
        if (bar && Number.isFinite(bar.c)) return bar.c;
      }
      return null;
    }

    priceRangeFor(box) {
      if (!box.id || box.id === 'price') return { min: this.price.min, max: this.price.max };
      const pane = box.pane;
      return pane && pane.range ? pane.range : { min: 0, max: 1 };
    }

    /* The visible bar span, clamped to the data. */
    visibleRange() {
      const from = Math.max(0, Math.floor(this.view.from));
      const to = Math.min(this.bars.length - 1, Math.ceil(this.view.to));
      return { from, to };
    }

    /* Autoscale over what is actually on screen, including any overlay that
       extends beyond the candles — a band or an average sitting outside the
       price range must not be clipped off the top of the chart. */
    autoscale() {
      if (!this.price.auto || !this.bars.length) return;
      const { from, to } = this.visibleRange();
      let min = Infinity;
      let max = -Infinity;

      for (let i = from; i <= to; i++) {
        const bar = this.bars[i];
        if (!bar) continue;
        if (Number.isFinite(bar.h) && bar.h > max) max = bar.h;
        if (Number.isFinite(bar.l) && bar.l < min) min = bar.l;
      }

      this.overlays.forEach(overlay => {
        (overlay.lines || []).forEach(line => {
          for (let i = from; i <= to; i++) {
            const value = line.series[i];
            if (!Number.isFinite(value)) continue;
            if (value > max) max = value;
            if (value < min) min = value;
          }
        });
      });

      if (this.style.showPreviousClose && Number.isFinite(this.previousClose)) {
        if (this.previousClose > max) max = this.previousClose;
        if (this.previousClose < min) min = this.previousClose;
      }

      if (!Number.isFinite(min) || !Number.isFinite(max)) return;
      if (min === max) { min -= 1; max += 1; }

      const padding = (max - min) * 0.06;
      this.price.min = min - padding;
      this.price.max = max + padding;
      if (this.price.log && this.price.min <= 0) this.price.min = min > 0 ? min * 0.98 : 1e-6;
    }

    /* ---------- data ---------- */

    setData(payload) {
      const data = payload || {};
      this.baseBars = data.bars || [];
      this.symbol = data.symbol || this.symbol;
      this.timeframe = data.timeframe || this.timeframe;
      this.currency = data.currency == null ? this.currency : data.currency;
      this.assetClass = data.assetClass == null ? this.assetClass : data.assetClass;
      this.priceHint = data.priceHint == null ? this.priceHint : data.priceHint;
      if (data.timeZone != null && data.timeZone !== this.timeZone) this.formatters = {};
      this.timeZone = data.timeZone == null ? this.timeZone : data.timeZone;
      this.previousClose = data.previousClose == null ? this.previousClose : data.previousClose;

      this.applySeriesType();

      const resetView = data.resetView !== false;
      if (resetView || this.view.to <= this.view.from) this.resetView();
      else this.clampView();

      this.rebuildIndicators();
      this.invalidate('all');
    }

    /* Renko and range series are transforms of the base bars, so switching type
       rebuilds from the same source rather than refetching. */
    applySeriesType() {
      const base = this.baseBars;
      if (this.seriesType === 'heikin') this.bars = candles.heikinAshi(base);
      else if (this.seriesType === 'renko') {
        const size = this.renkoSize || candles.atr(base, 14);
        this.bars = size ? candles.renko(base, size) : [];
      } else if (this.seriesType === 'range') {
        const size = this.rangeSize || candles.atr(base, 14);
        this.bars = size ? candles.rangeBars(base, size) : [];
      } else this.bars = base;
    }

    /* Fold an arriving quote into the bar still forming.
     *
     * WITHOUT THIS THE CHART AND THE HEADER DISAGREE, and they disagree in the
     * worst possible way: both are correct, one is simply older. The header
     * updates on every tick and the bars are whatever the history request
     * returned when the instrument was opened, so within a minute of a running
     * session the last candle closes at one price and the figure above it reads
     * another.
     *
     * ONLY WHILE THE VENUE IS TRADING. Outside a session the final bar is
     * closed and its close is the closing print. Moving it to match a quote
     * that is itself that same print risks redrawing a bar that is finished,
     * and a stale or unverified figure must never be written into history at
     * all — so anything that is not LIVE or DELAYED is ignored here.
     *
     * VOLUME IS NOT TOUCHED. The quote carries the day's cumulative volume, not
     * this bar's, and writing it into a five-minute bar would show the whole
     * session's turnover as five minutes of it. The bar keeps the volume the
     * source gave it and gains none. */
    applyQuote(quote, freshnessState) {
      if (!quote || !this.baseBars.length) return false;
      if (freshnessState !== 'LIVE' && freshnessState !== 'DELAYED') return false;

      const price = Number(quote.last);
      const at = Number(quote.at);
      if (!Number.isFinite(price) || !Number.isFinite(at)) return false;

      const bars = this.baseBars;
      const last = bars[bars.length - 1];
      const step = bars.length > 1 ? last.t - bars[bars.length - 2].t : 0;
      if (!(step > 0) || at < last.t) return false;

      const wasAtRealtime = this.atRealtime();
      let appended = false;

      if (at >= last.t + step) {
        /* A new bar has opened. Exactly one is added, opening at this price.
           The bars in between — if the application was asleep over a lunch
           break — belong to the source and are fetched, never filled in. */
        const opened = last.t + Math.floor((at - last.t) / step) * step;
        bars.push({ t: opened, o: price, h: price, l: price, c: price, v: null });
        appended = true;
      } else {
        last.c = price;
        if (!(last.h >= price)) last.h = price;
        if (!(last.l <= price)) last.l = price;
      }

      if (Number.isFinite(Number(quote.previousClose))) this.previousClose = Number(quote.previousClose);

      /* Heikin Ashi, Renko and range bars are transforms of the base series, so
         they are rebuilt rather than patched: a Renko brick depends on every
         bar before it and cannot be corrected in place. */
      if (this.seriesType === 'heikin' || this.seriesType === 'renko' || this.seriesType === 'range') {
        this.applySeriesType();
      } else {
        this.bars = bars;
      }
      this.rebuildIndicators();

      /* A chart resting on the newest bar keeps resting on it. One that has
         been scrolled back into history stays where it was put. */
      if (appended && wasAtRealtime) { this.view.from += 1; this.view.to += 1; }
      this.clampView();
      this.invalidate('all');
      return true;
    }

    setSeriesType(type) {
      this.seriesType = type;
      this.applySeriesType();
      this.clampView();
      this.rebuildIndicators();
      this.invalidate('all');
    }

    /* Look at the last `ms` of history. Null looks at all of it.
     *
     * THIS MOVES THE VIEW, IT DOES NOT FETCH ANYTHING. Every bar the source
     * will publish at this size is already loaded, so a period button chooses
     * how much of it is on screen — and scrolling left carries straight on past
     * the edge of what was asked for, back to the start of the record. */
    showPeriod(ms) {
      const count = this.bars.length;
      if (!count) return;

      let from = 0;
      if (Number.isFinite(ms) && ms > 0) {
        const until = this.bars[count - 1].t - ms;
        /* Below the first bar this returns nought, which is the whole history —
           the honest answer when a year is asked for and six months exist. */
        from = Math.max(0, Math.floor(this.indexOfTime(until)));
      }

      const span = Math.max(MIN_BARS_VISIBLE, count - from);
      this.stopMotion();
      this.view.to = count + Math.min(12, Math.round(span * 0.04));
      this.view.from = this.view.to - span;
      this.price.auto = true;
      this.clampView();
      this.invalidate('all');
      if (this.onViewChange) this.onViewChange(this.view);
    }

    resetView() {
      const count = this.bars.length;
      if (!count) { this.view = { from: 0, to: 1 }; return; }
      const wanted = Math.min(count, Math.max(MIN_BARS_VISIBLE, Math.floor(this.layout().plotWidth / 8)));
      this.view.to = count + Math.min(12, Math.round(wanted * 0.08));
      this.view.from = this.view.to - wanted;
      this.price.auto = true;
    }

    clampView() {
      const count = Math.max(1, this.bars.length);
      let span = this.view.to - this.view.from;
      span = Math.max(MIN_BARS_VISIBLE, Math.min(span, count * 3));

      /* Half a screen of empty space either side is allowed so the newest bar
         can be dragged to the middle, but the series cannot be pushed entirely
         out of view. */
      const limit = span * 0.6;
      if (this.view.from < -limit) this.view.from = -limit;
      if (this.view.from > count - MIN_BARS_VISIBLE) this.view.from = count - MIN_BARS_VISIBLE;
      this.view.to = this.view.from + span;
    }

    /* ---------- indicators ---------- */

    setIndicators(list) {
      this.indicatorSpecs = list || [];
      this.rebuildIndicators();
      this.invalidate('all');
    }

    rebuildIndicators() {
      const specs = this.indicatorSpecs || [];
      this.overlays = [];
      this.lowerPanes = [];
      this.relayout();

      specs.forEach(spec => {
        const entry = indicators.CATALOGUE[spec.id];
        if (!entry) return;
        const params = Object.assign({ timeZone: this.timeZone }, spec.params || {});
        const built = indicators.build(spec.id, this.bars, params);
        /* An indicator that cannot be built on this much history draws nothing
           and says why in the legend, rather than drawing a shortened version
           of itself. */
        if (!built) {
          const why = indicators.usable(spec.id, this.bars, params);
          this.overlays.push({ id: spec.id, label: entry.label, unavailable: why.reason, lines: [] });
          return;
        }

        if (entry.pane === 'price') this.overlays.push(this.priceOverlay(spec, entry, built));
        else this.lowerPanes.push(this.lowerPane(spec, entry, built));
      });

      this.relayout();
    }

    priceOverlay(spec, entry, built) {
      const colour = spec.colour || this.style.accent;
      const lines = [];

      if (built.series) lines.push({ series: built.series, colour, width: 1.4 });
      if (built.upper) {
        lines.push({ series: built.upper, colour, width: 1, dash: [3, 3] });
        lines.push({ series: built.middle, colour, width: 1.2 });
        lines.push({ series: built.lower, colour, width: 1, dash: [3, 3] });
      }
      if (built.conversion) {
        lines.push({ series: built.conversion, colour: SECOND_LINE, width: 1.2 });
        lines.push({ series: built.base, colour: '#c58af9', width: 1.2 });
        lines.push({ series: built.spanA, colour: 'rgba(46,189,133,.7)', width: 1 });
        lines.push({ series: built.spanB, colour: 'rgba(246,70,93,.7)', width: 1 });
        lines.push({ series: built.lagging, colour: this.style.axisText, width: 1, dash: [2, 3] });
      }
      if (built.value && built.direction) {
        lines.push({ series: built.value, colour, width: 1.6, direction: built.direction });
      }

      return {
        id: spec.id,
        label: entry.label,
        colour,
        lines,
        profile: built.levels ? built : null,
        params: spec.params || entry.defaults
      };
    }

    lowerPane(spec, entry, built) {
      const colour = spec.colour || this.style.accent;
      const series = [];

      if (built.series) series.push({ series: built.series, colour, kind: spec.id === 'volume' ? 'histogram' : 'line' });
      if (built.line) {
        series.push({ series: built.histogram, colour, kind: 'histogram', signed: true });
        series.push({ series: built.line, colour: SECOND_LINE, kind: 'line' });
        series.push({ series: built.signal, colour: SIGNAL_COLOUR, kind: 'line' });
      }
      if (built.k) {
        series.push({ series: built.k, colour: SECOND_LINE, kind: 'line' });
        series.push({ series: built.d, colour: SIGNAL_COLOUR, kind: 'line' });
      }
      if (built.adx) {
        series.push({ series: built.adx, colour, kind: 'line' });
        series.push({ series: built.plusDI, colour: this.style.up, kind: 'line' });
        series.push({ series: built.minusDI, colour: this.style.down, kind: 'line' });
      }

      const bounded = { rsi: [0, 100], stochastic: [0, 100], mfi: [0, 100], adx: [0, 100] }[spec.id] || null;

      return {
        id: spec.id,
        label: entry.label,
        height: spec.height || (spec.id === 'volume' ? 62 : 78),
        colour,
        series,
        bounded,
        guides: { rsi: [30, 70], stochastic: [20, 80], mfi: [20, 80] }[spec.id] || null,
        range: { min: 0, max: 1 }
      };
    }

    /* ---------- painting ---------- */

    invalidate(which) {
      if (which === 'all') Object.values(this.layers).forEach(l => { l.dirty = true; });
      else if (this.layers[which]) this.layers[which].dirty = true;
      this.schedule();
    }

    /* Coalesced into one animation frame. A wheel event can arrive several
       times per frame, and painting on each of them does the same work three
       times for one visible result. */
    schedule() {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        this.paint();
      });
    }

    paint() {
      if (!this.width || !this.height) return;
      this.autoscale();
      this.measurePanes();

      if (this.layers.bg.dirty) { this.paintBackground(); this.layers.bg.dirty = false; }
      if (this.layers.main.dirty) { this.paintMain(); this.layers.main.dirty = false; }
      if (this.layers.draw.dirty) { this.paintDrawings(); this.layers.draw.dirty = false; }
      if (this.layers.fx.dirty) { this.paintCursor(); this.layers.fx.dirty = false; }

      this.jumpButton.classList.toggle('on', !this.atRealtime());
    }

    /* Each lower pane scales to its own visible values, unless it is one of the
       bounded oscillators, which keep their fixed scale so thirty always sits
       in the same place. */
    measurePanes() {
      const { from, to } = this.visibleRange();
      this.lowerPanes.forEach(pane => {
        if (pane.bounded) { pane.range = { min: pane.bounded[0], max: pane.bounded[1] }; return; }
        let min = Infinity;
        let max = -Infinity;
        pane.series.forEach(entry => {
          for (let i = from; i <= to; i++) {
            const value = entry.series[i];
            if (!Number.isFinite(value)) continue;
            if (value > max) max = value;
            if (value < min) min = value;
          }
        });
        if (!Number.isFinite(min) || !Number.isFinite(max)) { pane.range = { min: 0, max: 1 }; return; }
        if (min === max) { min -= 1; max += 1; }
        const pad = (max - min) * 0.08;

        /* Volume rests on zero and cannot go below it. Padding the bottom of
           the range the way every other pane is padded put a negative figure on
           the axis of a quantity that has no negative values. */
        if (pane.id === 'volume') {
          pane.range = { min: 0, max: max + pad };
          return;
        }
        pane.range = { min: min - pad, max: max + pad };
      });
    }

    clear(ctx) {
      ctx.clearRect(0, 0, this.width, this.height);
    }

    paintBackground() {
      const ctx = this.layers.bg.ctx;
      const { plotWidth, panes } = this.layout();
      this.clear(ctx);

      /* Transparent by default, letting .chart-wrap's own theme-driven
         background show through — a real colour here is a deliberate
         override the operator chose, not the plane colour restated. */
      if (this.style.background && this.style.background !== 'transparent') {
        ctx.fillStyle = this.style.background;
        ctx.fillRect(0, 0, this.width, this.height);
      }

      if (this.style.showWatermark && this.symbol) {
        ctx.save();
        ctx.fillStyle = this.style.watermark;
        ctx.font = '600 46px ' + (this.style.font.split(' ').slice(1).join(' ') || 'sans-serif');
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(this.symbol, 16, panes[0].height - 68);
        ctx.font = '400 15px sans-serif';
        ctx.fillText(this.timeframe, 16, panes[0].height - 20);
        ctx.restore();
      }

      if (!this.style.showGrid) return;

      ctx.save();
      ctx.strokeStyle = this.style.grid;
      ctx.lineWidth = 1;

      /* Horizontal grid on the price pane, at the same steps the axis labels
         use so lines and labels cannot disagree. */
      const priceBox = panes[0];
      this.priceTicks().forEach(price => {
        const y = Math.round(this.yOf(price, priceBox)) + 0.5;
        if (y < priceBox.top || y > priceBox.top + priceBox.height) return;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(plotWidth, y);
        ctx.stroke();
      });

      /* Vertical grid, and the heavier line where a session changes. Computed
         once and handed to the axis painter: walking the visible bars twice a
         frame to arrive at the same list is the whole cost paid twice. */
      const ticks = this.timeTicks();
      ticks.forEach(tick => {
        const x = Math.round(this.xOf(tick.index)) + 0.5;
        if (x < 0 || x > plotWidth) return;
        const major = tick.session && this.style.showSessions;
        ctx.strokeStyle = major ? this.style.sessionLine : this.style.grid;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, this.height - TIME_H);
        ctx.stroke();
      });

      /* Pane separators. */
      ctx.strokeStyle = this.style.gridStrong;
      panes.slice(1).forEach(pane => {
        const y = Math.round(pane.top - PANE_GAP / 2) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(plotWidth, y);
        ctx.stroke();
      });

      ctx.restore();
      this.paintAxes(ctx, ticks);
    }

    /* Gridline prices. Whatever the axis is showing, the ladder is chosen in
       the space the operator is reading — round percentages under a percentage
       scale, round multiples under a logarithmic one — and converted back to
       prices afterwards. Choosing them in price space and relabelling produces
       an axis of arbitrary numbers, which is the tell of a scale that was
       bolted on rather than built in. */
    priceTicks() {
      const { priceHeight } = this.layout();
      const wanted = Math.max(2, Math.floor(priceHeight / 52));
      const out = [];

      const base = this.price.percent ? this.percentBase() : null;
      if (this.price.percent && Number.isFinite(base) && base !== 0) {
        const lo = ((this.price.min - base) / base) * 100;
        const hi = ((this.price.max - base) / base) * 100;
        const step = niceStep(hi - lo, wanted);
        for (let pct = Math.ceil(lo / step) * step; pct <= hi; pct += step) {
          out.push(base * (1 + pct / 100));
        }
        return out;
      }

      if (this.price.log && this.price.min > 0) {
        const lo = Math.log10(this.price.min);
        const hi = Math.log10(this.price.max);
        const step = niceStep(hi - lo, wanted);
        for (let power = Math.ceil(lo / step) * step; power <= hi; power += step) {
          out.push(Math.pow(10, power));
        }
        return out;
      }

      const step = niceStep(this.price.max - this.price.min, wanted);
      for (let price = Math.ceil(this.price.min / step) * step; price <= this.price.max; price += step) {
        out.push(Number(price.toFixed(10)));
      }
      return out;
    }

    /* Time ticks are placed on bar indices, and a tick is marked as a session
       boundary when the calendar day changes across it. */
    timeTicks() {
      if (!this.bars.length) return [];
      const spacing = this.barWidth();
      const every = Math.max(1, Math.round(74 / Math.max(0.5, spacing)));
      const { from, to } = this.visibleRange();
      /* A session boundary is only a boundary on an intraday chart. On a daily
         series every bar begins a new day, so treating each one as a session
         change put a heavy gridline and a date label under every candle — the
         axis became an unreadable smear of overlapping text. */
      const intraday = this.isIntraday();
      const out = [];
      let lastDay = null;

      /* Session boundaries need every bar examined, and that is only affordable
         while a session boundary is a thing that can be seen. Zoomed out past a
         bar per pixel there is no room to draw one, so the walk strides instead
         — and `dayKey` formats a date through Intl, which at seven thousand
         calls a frame is the single most expensive thing on the chart. */
      const stride = intraday ? 1 : this.strideFor(from, to);

      for (let i = from; i <= to; i += stride) {
        const bar = this.bars[i];
        if (!bar) continue;
        const day = intraday ? this.dayKey(bar.t) : null;
        const isSession = intraday && lastDay !== null && day !== lastDay;
        lastDay = day;
        if (isSession || i % every === 0) out.push({ index: i, t: bar.t, session: isSession });
      }
      return out;
    }

    /* A DATE FORMATTER IS BUILT ONCE, NOT ONCE PER BAR.
     *
     * Constructing an Intl.DateTimeFormat is among the most expensive things a
     * browser does, and this is called for every visible bar on an intraday
     * chart to find where the day changes. At fifteen hundred bars that was
     * fifteen hundred formatters a frame, and the single largest cost in the
     * whole paint: panning a busy chart ran at about fifteen frames a second
     * because of this one line. Cached per time zone, which is the only thing
     * about it that varies. */
    formatterFor(kind, options) {
      const zone = this.timeZone || 'UTC';
      this.formatters = this.formatters || {};
      const key = kind + '|' + zone;
      if (!(key in this.formatters)) {
        try {
          this.formatters[key] = new Intl.DateTimeFormat('en-GB', Object.assign({ timeZone: zone }, options));
        } catch (e) {
          this.formatters[key] = null;
        }
      }
      return this.formatters[key];
    }

    dayKey(ms) {
      const formatter = this.formatterFor('day', { year: 'numeric', month: '2-digit', day: '2-digit' });
      if (!formatter) return new Date(ms).toISOString().slice(0, 10);
      return formatter.format(new Date(ms));
    }

    formatPrice(value) {
      return num.money(value, {
        currency: this.currency,
        assetClass: this.assetClass,
        decimals: this.priceHint == null ? undefined : this.priceHint
      });
    }

    /* What the price gutter, the last-price tag and the crosshair read. In
       percentage mode they all move together — an axis in percent beside a tag
       in currency is how a reading is misread. */
    axisLabel(value) {
      if (!this.price.percent) return this.formatPrice(value);
      const base = this.percentBase();
      if (!Number.isFinite(base) || base === 0) return this.formatPrice(value);
      const change = ((value - base) / base) * 100;
      return (change >= 0 ? '+' : '') + change.toFixed(2) + '%';
    }

    paintAxes(ctx, ticks) {
      const { plotWidth, panes } = this.layout();

      ctx.save();
      ctx.fillStyle = this.style.axisText;
      ctx.font = this.style.labelFont;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      const priceBox = panes[0];
      this.priceTicks().forEach(price => {
        const y = this.yOf(price, priceBox);
        if (y < priceBox.top + 6 || y > priceBox.top + priceBox.height - 4) return;
        ctx.fillText(this.axisLabel(price), plotWidth + 7, y);
      });

      /* Each lower pane labels only its extremes; more than that is clutter in
         a strip seventy pixels tall. */
      panes.slice(1).forEach(box => {
        const pane = box.pane;
        if (!pane) return;
        [pane.range.max, pane.range.min].forEach((value, i) => {
          const y = box.top + (i === 0 ? 10 : box.height - 6);
          ctx.fillText(shortNumber(value), plotWidth + 7, y);
        });
      });

      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const intraday = this.isIntraday();
      (ticks || this.timeTicks()).forEach(tick => {
        const x = this.xOf(tick.index);
        if (x < 20 || x > plotWidth - 20) return;
        ctx.fillText(this.formatTime(tick.t, intraday, tick.session), x, this.height - TIME_H + 5);
      });

      ctx.restore();
    }

    isIntraday() {
      if (this.bars.length < 2) return false;
      return (this.bars[this.bars.length - 1].t - this.bars[this.bars.length - 2].t) < 20 * 60 * 60 * 1000;
    }

    formatTime(ms, intraday, isSession) {
      const formatter = (intraday && !isSession)
        ? this.formatterFor('time', { hour: '2-digit', minute: '2-digit', hour12: false })
        : this.formatterFor('date', { day: 'numeric', month: 'short' });
      if (!formatter) return '';
      try {
        return formatter.format(new Date(ms));
      } catch (e) {
        return '';
      }
    }

    /* ---------- the series ---------- */

    paintMain() {
      const ctx = this.layers.main.ctx;
      const { plotWidth, panes } = this.layout();
      this.clear(ctx);
      if (!this.bars.length) return;

      const priceBox = panes[0];

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, plotWidth, priceBox.height);
      ctx.clip();

      const profile = this.overlays.find(o => o.profile);
      if (profile) this.paintVolumeProfile(ctx, profile.profile, priceBox, plotWidth);

      if (this.style.showPreviousClose && Number.isFinite(this.previousClose)) {
        const y = Math.round(this.yOf(this.previousClose, priceBox)) + 0.5;
        ctx.save();
        ctx.strokeStyle = this.style.axisText;
        ctx.setLineDash([2, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(plotWidth, y);
        ctx.stroke();
        ctx.restore();
      }

      if (this.seriesType === 'line' || this.seriesType === 'area') this.paintLine(ctx, priceBox);
      else this.paintCandles(ctx, priceBox);

      this.overlays.forEach(overlay => {
        (overlay.lines || []).forEach(line => this.paintSeriesLine(ctx, line, priceBox));
      });

      ctx.restore();

      panes.slice(1).forEach(box => this.paintLowerPane(ctx, box, plotWidth));
      this.paintLevels(ctx, priceBox, plotWidth);
      this.paintLastPrice(ctx, priceBox, plotWidth);
    }

    /* Levels the operator has money on: an open position's entry, a resting
     * order's price, and the target and stop attached to either.
     *
     * These are supplied rather than derived. The chart knows about bars and
     * pixels; what counts as an open position is the broker's business, and
     * having the chart work it out would make two answers to one question. */
    setLevels(levels) {
      this.levels = Array.isArray(levels) ? levels : [];
      this.invalidate('main');
    }

    paintLevels(ctx, box, plotWidth) {
      const levels = this.levels || [];
      if (!levels.length) return;

      levels.forEach(level => {
        const price = Number(level.price);
        if (!Number.isFinite(price)) return;
        const y = Math.round(this.yOf(price, box)) + 0.5;
        if (y < box.top + 6 || y > box.top + box.height - 4) return;

        ctx.save();
        ctx.strokeStyle = level.colour;
        ctx.lineWidth = 1;
        ctx.setLineDash(level.dash || [6, 4]);
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(plotWidth, y);
        ctx.stroke();
        ctx.restore();

        /* The label rides on the line at the left, in the empty space, rather
           than on the axis where it would fight the price tags for room. */
        if (level.label) {
          ctx.save();
          ctx.font = this.style.labelFont;
          const width = ctx.measureText(level.label).width + 14;
          ctx.fillStyle = level.colour;
          ctx.beginPath();
          ctx.roundRect(6, y - 8, width, 16, 3);
          ctx.fill();
          ctx.fillStyle = level.ink || '#ffffff';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(level.label, 13, y);
          ctx.restore();
        }

        this.paintTag(ctx, plotWidth, y, this.axisLabel(price), level.colour, level.ink || '#ffffff');
      });
    }

    /* How many bars share one pixel column at the current zoom.
     *
     * NEVER DRAW MORE CANDLES THAN THERE ARE PIXELS TO DRAW THEM ON. A quarter
     * of a century of daily bars is nearly seven thousand candles, and asking
     * the canvas for seven thousand strokes and fills across eleven hundred
     * pixels costs about a third of a second a frame — so panning at full
     * zoom-out moved in lurches, and every one of those candles landed on a
     * column another twenty had already been drawn on. Merging them into one
     * candle per column is not an approximation of the picture: it is the same
     * picture, drawn once instead of twenty times. The extremes are preserved,
     * so nothing is lost from the high and low the chart reports. */
    strideFor(from, to) {
      const columns = Math.max(1, this.layout().plotWidth);
      return Math.max(1, Math.ceil((to - from + 1) / columns));
    }

    /* One drawable bar from a run of them: the first open, the last close, and
       the true extremes between. */
    mergeRun(from, to) {
      let open = null;
      let close = null;
      let high = -Infinity;
      let low = Infinity;
      for (let i = from; i <= to; i++) {
        const bar = this.bars[i];
        if (!bar || !Number.isFinite(bar.c)) continue;
        if (open === null && Number.isFinite(bar.o)) open = bar.o;
        close = bar.c;
        if (Number.isFinite(bar.h) && bar.h > high) high = bar.h;
        if (Number.isFinite(bar.l) && bar.l < low) low = bar.l;
      }
      if (close === null) return null;
      if (open === null) open = close;
      if (!Number.isFinite(high)) high = Math.max(open, close);
      if (!Number.isFinite(low)) low = Math.min(open, close);
      return { o: open, h: high, l: low, c: close };
    }

    paintCandles(ctx, box) {
      const spacing = this.barWidth();
      const { from, to } = this.visibleRange();
      const stride = this.strideFor(from, to);
      const bodyWidth = Math.max(1, Math.min(spacing * stride * 0.68, MAX_BAR_WIDTH));
      /* Below three pixels a body reads as neither rising nor falling, so the
         candle collapses to a single stroke that still carries its colour and
         its range. */
      const thin = bodyWidth < 3;
      const ohlcBars = this.seriesType === 'bar';

      for (let i = from; i <= to; i += stride) {
        const bar = stride === 1 ? this.bars[i] : this.mergeRun(i, Math.min(to, i + stride - 1));
        if (!bar || !Number.isFinite(bar.o) || !Number.isFinite(bar.c)) continue;

        const rising = bar.c >= bar.o;
        const colour = rising ? this.style.up : this.style.down;
        /* Centred on the run it stands for, not on its first bar. */
        const x = this.xOf(i + (stride === 1 ? 0.5 : Math.min(to - i + 1, stride) / 2));
        const openY = this.yOf(bar.o, box);
        const closeY = this.yOf(bar.c, box);
        const highY = this.yOf(bar.h, box);
        const lowY = this.yOf(bar.l, box);

        ctx.strokeStyle = this.style.wick || colour;
        ctx.fillStyle = rising ? this.style.upFill : this.style.downFill;
        ctx.lineWidth = 1;

        if (ohlcBars) {
          const arm = bodyWidth / 2;
          const cx = Math.round(x) + 0.5;
          ctx.strokeStyle = colour;
          ctx.beginPath();
          ctx.moveTo(cx, highY);
          ctx.lineTo(cx, lowY);
          ctx.moveTo(cx - arm, Math.round(openY) + 0.5);
          ctx.lineTo(cx, Math.round(openY) + 0.5);
          ctx.moveTo(cx, Math.round(closeY) + 0.5);
          ctx.lineTo(cx + arm, Math.round(closeY) + 0.5);
          ctx.stroke();
          continue;
        }

        if (thin) {
          ctx.strokeStyle = colour;
          ctx.beginPath();
          ctx.moveTo(Math.round(x) + 0.5, highY);
          ctx.lineTo(Math.round(x) + 0.5, lowY);
          ctx.stroke();
          continue;
        }

        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, highY);
        ctx.lineTo(Math.round(x) + 0.5, lowY);
        ctx.stroke();

        const top = Math.min(openY, closeY);
        const height = Math.max(1, Math.abs(closeY - openY));
        const left = Math.round(x - bodyWidth / 2);
        if (this.style.hollow && rising) {
          ctx.strokeStyle = colour;
          ctx.strokeRect(left + 0.5, Math.round(top) + 0.5, Math.round(bodyWidth) - 1, Math.round(height));
        } else {
          ctx.fillRect(left, Math.round(top), Math.round(bodyWidth), Math.round(height));
        }
      }
    }

    paintLine(ctx, box) {
      const { from, to } = this.visibleRange();
      /* One point per pixel column. A path of seven thousand vertices across
         eleven hundred pixels is six thousand instructions the rasteriser
         throws away. */
      const stride = this.strideFor(from, to);
      const points = [];
      for (let i = from; i <= to; i += stride) {
        const bar = stride === 1 ? this.bars[i] : this.mergeRun(i, Math.min(to, i + stride - 1));
        if (!bar || !Number.isFinite(bar.c)) { points.push(null); continue; }
        points.push({ x: this.xOf(i + (stride === 1 ? 0.5 : stride / 2)), y: this.yOf(bar.c, box) });
      }

      ctx.save();
      ctx.strokeStyle = this.style.accent;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let open = false;
      points.forEach(point => {
        /* A gap breaks the path rather than being bridged: drawing straight
           through a halt invents prices that never traded. */
        if (!point) { open = false; return; }
        if (!open) { ctx.moveTo(point.x, point.y); open = true; }
        else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();

      if (this.seriesType === 'area') {
        const bottom = box.top + box.height - BOTTOM_PAD;
        const gradient = ctx.createLinearGradient(0, box.top, 0, bottom);
        gradient.addColorStop(0, this.style.areaFill);
        gradient.addColorStop(1, withAlpha(this.style.accent, 0));
        ctx.fillStyle = gradient;
        ctx.lineTo(points.length ? this.xOf(to + 0.5) : 0, bottom);
        ctx.lineTo(this.xOf(from + 0.5), bottom);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    /* Indicator lines are strided the same way the price series is: an average
       over seven thousand bars is still one line across eleven hundred pixels,
       and drawing every vertex costs the same as drawing every candle did. */
    paintSeriesLine(ctx, line, box) {
      const { from, to } = this.visibleRange();
      const stride = this.strideFor(from, to);
      ctx.save();
      ctx.strokeStyle = line.colour;
      ctx.lineWidth = line.width || 1.2;
      ctx.lineJoin = 'round';
      if (line.dash) ctx.setLineDash(line.dash);

      /* A series that changes colour with a direction flag has to be stroked in
         runs, because one path cannot carry two colours. */
      if (line.direction) {
        let run = [];
        let currentDirection = null;
        const flush = () => {
          if (run.length < 2) { run = []; return; }
          ctx.strokeStyle = currentDirection === 1 ? this.style.up : this.style.down;
          ctx.beginPath();
          run.forEach((point, i) => (i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
          ctx.stroke();
          run = [];
        };
        for (let i = from; i <= to; i++) {
          const value = line.series[i];
          const direction = line.direction[i];
          if (!Number.isFinite(value)) { flush(); continue; }
          if (direction !== currentDirection) { flush(); currentDirection = direction; }
          run.push({ x: this.xOf(i + 0.5), y: this.yOf(value, box) });
        }
        flush();
        ctx.restore();
        return;
      }

      ctx.beginPath();
      let open = false;
      for (let i = from; i <= to; i += stride) {
        const value = line.series[i];
        if (!Number.isFinite(value)) { open = false; continue; }
        const x = this.xOf(i + (stride === 1 ? 0.5 : stride / 2));
        const y = this.yOf(value, box);
        if (!open) { ctx.moveTo(x, y); open = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    }

    paintVolumeProfile(ctx, profile, box, plotWidth) {
      const maxVolume = profile.levels.reduce((m, level) => Math.max(m, level.volume), 0);
      if (!maxVolume) return;
      const widthLimit = plotWidth * 0.22;

      ctx.save();
      profile.levels.forEach(level => {
        const y = this.yOf(level.price, box);
        const height = Math.max(1, Math.abs(this.yOf(level.price - profile.step, box) - y));
        const width = (level.volume / maxVolume) * widthLimit;
        const inValue = level.price >= profile.valueAreaLow && level.price <= profile.valueAreaHigh;
        ctx.fillStyle = inValue ? this.style.profileFill : 'rgba(155,155,168,.13)';
        ctx.fillRect(0, y - height / 2, width, height);
      });

      const poc = Math.round(this.yOf(profile.pointOfControl, box)) + 0.5;
      ctx.strokeStyle = this.style.accent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, poc);
      ctx.lineTo(widthLimit, poc);
      ctx.stroke();
      ctx.restore();
    }

    paintLowerPane(ctx, box, plotWidth) {
      const pane = box.pane;
      if (!pane) return;
      const { from, to } = this.visibleRange();

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, box.top, plotWidth, box.height);
      ctx.clip();

      if (pane.guides) {
        ctx.strokeStyle = this.style.grid;
        ctx.setLineDash([2, 3]);
        pane.guides.forEach(level => {
          const y = Math.round(this.yOf(level, box)) + 0.5;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(plotWidth, y);
          ctx.stroke();
        });
        ctx.setLineDash([]);
      }

      const spacing = this.barWidth();
      const stride = this.strideFor(from, to);
      const barW = Math.max(1, Math.min(spacing * stride * 0.68, MAX_BAR_WIDTH));

      pane.series.forEach(entry => {
        if (entry.kind === 'histogram') {
          const zero = entry.signed ? this.yOf(0, box) : box.top + box.height - BOTTOM_PAD;
          ctx.save();
          if (pane.id === 'volume') ctx.globalAlpha = this.style.volumeAlpha;
          for (let i = from; i <= to; i += stride) {
            /* Volume over a run is what traded across it, so the bars are
               summed rather than sampled — taking one of twenty would report a
               twentieth of the turnover. */
            let value = entry.series[i];
            if (stride > 1) {
              value = 0;
              let seen = false;
              for (let j = i; j <= Math.min(to, i + stride - 1); j++) {
                const v = entry.series[j];
                if (Number.isFinite(v)) { value += v; seen = true; }
              }
              if (!seen) value = NaN;
            }
            if (!Number.isFinite(value)) continue;
            const bar = stride === 1 ? this.bars[i] : this.mergeRun(i, Math.min(to, i + stride - 1));
            const rising = entry.signed ? value >= 0 : (bar && bar.c >= bar.o);
            ctx.fillStyle = pane.id === 'volume'
              ? (rising ? this.style.volumeUp : this.style.volumeDown)
              : (rising ? this.style.up : this.style.down);
            const y = this.yOf(value, box);
            ctx.fillRect(Math.round(this.xOf(i + 0.5) - barW / 2), Math.min(y, zero), Math.round(barW), Math.max(1, Math.abs(zero - y)));
          }
          ctx.restore();
          return;
        }
        this.paintSeriesLine(ctx, { series: entry.series, colour: entry.colour, width: 1.3 }, box);
      });

      ctx.restore();
    }

    /* The newest price, tagged on the axis. Drawn dashed so it reads as a
       marker rather than as a level anyone set. */
    paintLastPrice(ctx, box, plotWidth) {
      /* Cleared first: leaving the previous position behind would anchor the
         countdown to where the price used to be after a scroll moved it off. */
      this.lastPriceY = null;
      const last = this.bars[this.bars.length - 1];
      if (!last || !Number.isFinite(last.c)) return;

      const y = Math.round(this.yOf(last.c, box)) + 0.5;
      if (y < box.top || y > box.top + box.height) return;
      const rising = this.previousClose == null ? last.c >= last.o : last.c >= this.previousClose;
      const colour = rising ? this.style.up : this.style.down;

      ctx.save();
      ctx.strokeStyle = colour;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(plotWidth, y);
      ctx.stroke();
      ctx.restore();

      this.paintTag(ctx, plotWidth, y, this.axisLabel(last.c), colour, this.style.tagInk);
      this.lastPriceY = y;
    }

    /* How long the bar still forming has left, worked out from the spacing of
       the two bars behind it. Only ever shown on an intraday series: on a daily
       one the bar ends when the venue closes, which is a session question this
       does not have the answer to, and counting down to midnight instead would
       be a confident wrong answer. */
    barCountdown() {
      const count = this.bars.length;
      if (count < 3 || !this.isIntraday()) return null;
      const step = this.bars[count - 1].t - this.bars[count - 2].t;
      if (!(step > 0)) return null;
      const remaining = (this.bars[count - 1].t + step) - Date.now();
      if (!(remaining > 0) || remaining > step) return null;

      const seconds = Math.floor(remaining / 1000);
      const pad = n => String(n).padStart(2, '0');
      if (seconds >= 3600) return Math.floor(seconds / 3600) + ':' + pad(Math.floor(seconds / 60) % 60) + ':' + pad(seconds % 60);
      return pad(Math.floor(seconds / 60)) + ':' + pad(seconds % 60);
    }

    paintTag(ctx, x, y, text, background, ink) {
      ctx.save();
      ctx.font = this.style.labelFont;
      const width = Math.max(AXIS_W - 6, ctx.measureText(text).width + 12);
      ctx.fillStyle = background;
      ctx.beginPath();
      ctx.roundRect(x + 3, y - 8, width, 16, 3);
      ctx.fill();
      ctx.fillStyle = ink;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x + 9, y);
      ctx.restore();
    }

    /* ---------- drawings (populated by the toolkit) ---------- */

    /* A drawing's anchors are time and price, so this is where they become
       pixels. Anything stored in pixels would move on every resize; anything
       stored in bar indices would move when the timeframe changed. */
    project(anchor) {
      const index = this.indexOfTime(anchor.t);
      return { x: this.xOf(index + 0.5), y: this.yOf(anchor.price, this.layout().panes[0]) };
    }

    unproject(x, y) {
      const index = Math.round(this.indexAt(x) - 0.5);
      const bar = this.bars[Math.max(0, Math.min(this.bars.length - 1, index))];
      return {
        t: bar ? bar.t : null,
        index,
        price: this.priceAt(y, this.layout().panes[0])
      };
    }

    /* Nearest bar index for a timestamp, allowing a fractional position beyond
       the last bar so a drawing extended into empty space stays put. */
    indexOfTime(t) {
      const bars = this.bars;
      if (!bars.length) return 0;
      if (t <= bars[0].t) return 0;
      const last = bars.length - 1;
      if (t >= bars[last].t) {
        const step = bars.length > 1 ? bars[last].t - bars[last - 1].t : 1;
        return last + (t - bars[last].t) / Math.max(1, step);
      }
      let low = 0;
      let high = last;
      while (low < high - 1) {
        const mid = (low + high) >> 1;
        if (bars[mid].t <= t) low = mid; else high = mid;
      }
      const span = bars[high].t - bars[low].t;
      return low + (span > 0 ? (t - bars[low].t) / span : 0);
    }

    paintDrawings() {
      const ctx = this.layers.draw.ctx;
      this.clear(ctx);
      if (this.drawTool && typeof this.drawTool.paint === 'function') this.drawTool.paint(ctx, this);
    }

    /* ---------- cursor ---------- */

    /* Time left on the bar still forming, under the last-price tag. On the
       effects layer rather than with the candles, so ticking it once a second
       costs a transparent overlay and not a repaint of the whole series. */
    paintCountdown(ctx, plotWidth) {
      const text = this.barCountdown();
      if (!text || this.lastPriceY == null) return;

      const y = this.lastPriceY + 17;
      const { panes } = this.layout();
      if (y > panes[0].top + panes[0].height) return;

      ctx.save();
      ctx.font = this.style.labelFont;
      ctx.fillStyle = this.style.axisText;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = 0.85;
      ctx.fillText(text, plotWidth + 9, y);
      ctx.restore();
    }

    paintCursor() {
      const ctx = this.layers.fx.ctx;
      this.clear(ctx);

      const { plotWidth, panes } = this.layout();
      this.paintCountdown(ctx, plotWidth);

      if (!this.cursor) return;
      const { x, y } = this.cursor;

      ctx.save();
      ctx.strokeStyle = this.style.crosshair;
      ctx.setLineDash(CROSSHAIR_DASH[this.style.crosshairStyle] || CROSSHAIR_DASH.dashed);
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.85;

      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, this.height - TIME_H);
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(plotWidth, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.restore();

      const box = this.paneAt(y) || panes[0];
      const value = this.priceAt(y, box);
      const label = (box.id === 'price') ? this.axisLabel(value) : shortNumber(value);
      this.paintTag(ctx, plotWidth, y, label, this.style.crosshair, this.style.tagInk);

      const bar = this.bars[this.cursor.index];
      if (bar) {
        const text = this.formatTime(bar.t, this.isIntraday(), false);
        ctx.save();
        ctx.font = this.style.labelFont;
        const width = ctx.measureText(text).width + 14;
        ctx.fillStyle = this.style.crosshair;
        ctx.beginPath();
        ctx.roundRect(x - width / 2, this.height - TIME_H + 2, width, 16, 3);
        ctx.fill();
        ctx.fillStyle = this.style.tagInk;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, x, this.height - TIME_H + 10);
        ctx.restore();
      }
    }

    paneAt(y) {
      const { panes } = this.layout();
      for (let i = panes.length - 1; i >= 0; i--) {
        if (y >= panes[i].top && y <= panes[i].top + panes[i].height) return panes[i];
      }
      return null;
    }

    /* ---------- motion ---------- */

    /* One animation loop drives both the eased zoom and the momentum left over
       from a flick. Two separate loops would each schedule their own frame and
       paint the same canvas twice for one visible result.
     *
     * Both are integrated against elapsed time rather than per frame. A decay
     * applied once per frame runs at half speed on a 120Hz display and at
     * double on a 30Hz one, so the chart would settle at a different place
     * depending on the monitor it happened to be on. */
    startMotion() {
      if (this.motionFrame) return;
      let previous = performance.now();

      const step = now => {
        const dt = Math.min(64, Math.max(1, now - previous));
        previous = now;
        this.motionFrame = null;
        let running = false;

        if (this.viewTarget) {
          const k = 1 - Math.exp(-dt / ZOOM_TIME_CONSTANT);
          this.view.from += (this.viewTarget.from - this.view.from) * k;
          this.view.to += (this.viewTarget.to - this.view.to) * k;
          if (Math.abs(this.viewTarget.to - this.view.to) < 0.01 &&
              Math.abs(this.viewTarget.from - this.view.from) < 0.01) {
            this.view.from = this.viewTarget.from;
            this.view.to = this.viewTarget.to;
            this.viewTarget = null;
          } else running = true;
          this.clampView();
          this.invalidate('all');
        }

        if (this.momentum) {
          const before = this.view.from;
          const span = this.view.to - this.view.from;
          this.view.from -= this.momentum.bars * dt;
          this.view.to = this.view.from + span;
          this.clampView();
          this.invalidate('all');

          this.momentum.bars *= Math.exp(-dt / MOMENTUM_TIME_CONSTANT);
          /* Clamped against the end of the data means the glide is over: left
             running it would keep decaying against a wall and hold a repaint
             open for another half second doing nothing. */
          /* Below this the glide is moving less than two pixels a second,
             which is not motion anyone sees — it is a repaint held open. */
          const stalled = Math.abs(this.view.from - before) < 1e-4;
          if (stalled || Math.abs(this.momentum.bars) * this.barWidth() < 0.02) this.momentum = null;
          else running = true;
        }

        if (running) this.motionFrame = requestAnimationFrame(step);
        else if (this.onViewChange) this.onViewChange(this.view);
      };

      this.motionFrame = requestAnimationFrame(step);
    }

    stopMotion() {
      this.viewTarget = null;
      this.momentum = null;
      if (this.motionFrame) { cancelAnimationFrame(this.motionFrame); this.motionFrame = null; }
    }

    /* Zoom towards a span, keeping the bar under `anchorIndex` where it is. The
       view is not written directly: a target is set and the loop eases into it,
       which is what turns a wheel notch from a jump into a movement. */
    zoomTo(span, anchorIndex, immediate) {
      const current = this.viewTarget || this.view;
      const currentSpan = Math.max(1e-6, current.to - current.from);
      const wanted = Math.max(MIN_BARS_VISIBLE, Math.min(span, Math.max(1, this.bars.length) * 3));
      const ratio = (anchorIndex - current.from) / currentSpan;
      const from = anchorIndex - ratio * wanted;

      if (immediate) {
        this.stopMotion();
        this.view.from = from;
        this.view.to = from + wanted;
        this.clampView();
        this.invalidate('all');
        if (this.onViewChange) this.onViewChange(this.view);
        return;
      }

      this.momentum = null;
      this.viewTarget = { from, to: from + wanted };
      this.startMotion();
    }

    zoomBy(factor) {
      const centre = (this.view.from + this.view.to) / 2;
      this.zoomTo((this.view.to - this.view.from) * factor, centre);
    }

    panBars(count) {
      this.stopMotion();
      const span = this.view.to - this.view.from;
      this.view.from += count;
      this.view.to = this.view.from + span;
      this.clampView();
      this.invalidate('all');
      if (this.onViewChange) this.onViewChange(this.view);
    }

    /* Is the newest bar still in view? What the return-to-now button watches. */
    atRealtime() {
      return !this.bars.length || this.view.to >= this.bars.length - 0.5;
    }

    scrollToRealtime() {
      const span = this.view.to - this.view.from;
      const to = this.bars.length + Math.min(12, Math.round(span * 0.08));
      this.momentum = null;
      this.viewTarget = { from: to - span, to };
      this.startMotion();
    }

    /* ---------- interaction ---------- */

    /* Which part of the chart a point belongs to. Every cursor shape and every
       drag behaviour is decided from this one answer, so the shape shown can
       never disagree with what the drag then does. */
    regionAt(point) {
      const { plotWidth, panes } = this.layout();
      if (point.x > plotWidth) return { kind: 'priceScale' };
      if (point.y > this.height - TIME_H) return { kind: 'timeScale' };

      for (let i = 1; i < panes.length; i++) {
        const separator = panes[i].top - PANE_GAP / 2;
        if (Math.abs(point.y - separator) <= SEPARATOR_GRAB) return { kind: 'paneResize', pane: panes[i].pane };
      }
      return { kind: 'plot' };
    }

    /* Magnet: pull the crosshair onto the nearest of the four prices the bar
       under it actually traded at. Off by default and toggled with a held
       modifier, the same way the reference does it, because a snapping
       crosshair is unwanted while reading a value off the axis. */
    snap(point) {
      if (!this.magnet) return point;
      const { plotWidth, panes } = this.layout();
      if (point.x > plotWidth || point.y > this.height - TIME_H) return point;

      const index = Math.round(this.indexAt(point.x) - 0.5);
      const bar = this.bars[index];
      if (!bar) return point;

      const box = panes[0];
      let best = null;
      [bar.o, bar.h, bar.l, bar.c].forEach(value => {
        if (!Number.isFinite(value)) return;
        const y = this.yOf(value, box);
        const distance = Math.abs(y - point.y);
        if (distance <= MAGNET_REACH && (!best || distance < best.distance)) best = { y, distance };
      });

      return best ? { x: this.xOf(index + 0.5), y: best.y } : point;
    }

    bindPointer() {
      const surface = this.layers.fx.canvas;
      surface.style.cursor = 'crosshair';
      /* Without this the browser claims a touch drag for its own scrolling and
         the chart receives a pointercancel halfway through every pan. */
      surface.style.touchAction = 'none';

      let drag = null;
      let samples = [];
      const active = new Map();   // live pointers, for pinch
      let pinch = null;

      const local = event => {
        const rect = surface.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
      };

      const setCursor = shape => { if (surface.style.cursor !== shape) surface.style.cursor = shape; };

      const CURSORS = {
        plot: 'crosshair',
        priceScale: 'ns-resize',
        timeScale: 'ew-resize',
        paneResize: 'row-resize'
      };

      surface.addEventListener('pointerdown', event => {
        const point = local(event);
        /* Capture keeps a drag alive when the pointer runs off the canvas, which
           it does on almost every pan. It is not load bearing, though — a
           pointer the browser will not let us capture must still be able to
           move the chart. */
        try { surface.setPointerCapture(event.pointerId); } catch (e) { /* not capturable */ }
        active.set(event.pointerId, point);

        if (active.size === 2) {
          const [a, b] = Array.from(active.values());
          pinch = {
            distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
            span: this.view.to - this.view.from,
            anchor: this.indexAt((a.x + b.x) / 2)
          };
          drag = null;
          this.cursor = null;
          this.invalidate('fx');
          return;
        }

        this.stopMotion();
        samples = [{ x: point.x, at: performance.now() }];

        if (this.drawTool && this.drawTool.onPointerDown && this.drawTool.onPointerDown(this.snap(point), this, event)) return;

        const region = this.regionAt(point);
        if (region.kind === 'priceScale') {
          drag = { kind: 'priceScale', y: point.y, min: this.price.min, max: this.price.max };
        } else if (region.kind === 'timeScale') {
          drag = { kind: 'timeScale', x: point.x, from: this.view.from, to: this.view.to };
        } else if (region.kind === 'paneResize') {
          drag = { kind: 'paneResize', y: point.y, pane: region.pane, height: region.pane.height };
        } else {
          drag = { kind: 'pan', x: point.x, from: this.view.from, to: this.view.to };
          /* The closed hand. It is the whole reason a drag reads as picking the
             chart up rather than as a click that happened to move. */
          setCursor('grabbing');
        }

        /* The crosshair reads a value at a fixed point. Once a drag starts that
           point is no longer meaningful — the bars underneath it are about to
           move — so it is dropped here rather than left painted at its last
           position while everything else on the canvas moves, which is what
           reads as the crosshair glitching. It is rebuilt fresh from the
           pointer's position on the first plain hover after release. */
        if (drag) { this.cursor = null; this.invalidate('fx'); this.report(null); }
      });

      surface.addEventListener('pointermove', event => {
        const point = local(event);
        if (active.has(event.pointerId)) active.set(event.pointerId, point);

        if (pinch && active.size === 2) {
          const [a, b] = Array.from(active.values());
          const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
          this.zoomTo(pinch.span * (pinch.distance / distance), pinch.anchor, true);
          return;
        }

        if (drag) {
          if (drag.kind === 'pan') {
            const barsMoved = (point.x - drag.x) / this.barWidth();
            const span = drag.to - drag.from;
            this.view.from = drag.from - barsMoved;
            this.view.to = this.view.from + span;
            this.clampView();
            this.invalidate('all');
            if (this.onViewChange) this.onViewChange(this.view);

            samples.push({ x: point.x, at: performance.now() });
            if (samples.length > 6) samples.shift();
          } else if (drag.kind === 'priceScale') {
            /* Dragging the price axis stretches the range about its centre and
               takes it off autoscale, which is what the operator asked for by
               touching it. */
            const factor = Math.exp((point.y - drag.y) / 180);
            const middle = (drag.min + drag.max) / 2;
            const half = ((drag.max - drag.min) / 2) * factor;
            this.price.auto = false;
            this.price.min = middle - half;
            this.price.max = middle + half;
            this.invalidate('all');
          } else if (drag.kind === 'timeScale') {
            const factor = Math.exp((drag.x - point.x) / 220);
            const anchor = drag.to;
            const span = (drag.to - drag.from) * factor;
            this.view.to = anchor;
            this.view.from = anchor - span;
            this.clampView();
            this.invalidate('all');
          } else if (drag.kind === 'paneResize') {
            drag.pane.height = Math.max(PANE_MIN_HEIGHT,
              Math.min(this.height * 0.6, drag.height - (point.y - drag.y)));
            this.relayout();
            this.invalidate('all');
          }
          return;
        }

        const region = this.regionAt(point);
        if (region.kind !== 'plot') {
          if (this.cursor) { this.cursor = null; this.invalidate('fx'); this.report(null); }
          setCursor(CURSORS[region.kind]);
          return;
        }

        /* A drawing under the pointer takes the cursor over, so it is obvious
           that a press will move that object rather than pan the chart. */
        const overDrawing = this.drawTool && this.drawTool.cursorAt && this.drawTool.cursorAt(point, this);
        setCursor(overDrawing || CURSORS.plot);

        const snapped = this.snap(point);
        const index = Math.max(0, Math.min(this.bars.length - 1, Math.round(this.indexAt(snapped.x) - 0.5)));
        this.cursor = { index, x: snapped.x, y: snapped.y };
        this.invalidate('fx');
        this.report(index);

        if (this.drawTool && this.drawTool.onPointerMove) this.drawTool.onPointerMove(snapped, this, event);
      });

      const release = event => {
        active.delete(event.pointerId);
        if (active.size < 2) pinch = null;

        if (drag) {
          /* Carry the flick on. The velocity is taken across the last few
             samples rather than the final pair: one stray event a millisecond
             before release otherwise decides the whole throw. */
          if (drag.kind === 'pan' && samples.length >= 2) {
            const first = samples[0];
            const last = samples[samples.length - 1];
            const elapsed = last.at - first.at;
            /* Kept for diagnosis. Whether a throw carried is decided from four
               numbers, and without them a chart that will not glide is guesswork
               to explain. */
            this.lastFlick = {
              samples: samples.length, elapsed,
              perMs: elapsed ? (last.x - first.x) / elapsed : 0,
              barWidth: this.barWidth()
            };
            /* An upper bound as well as a lower one. If the last six samples
               span most of a second the hand was moving slowly or had stopped,
               and a chart that drifts on after a careful adjustment is a chart
               that will not sit where it is put. */
            if (elapsed > 8 && elapsed < 350) {
              const perMs = (last.x - first.x) / elapsed;
              const bars = perMs / this.barWidth();
              if (Math.abs(perMs) > 0.12) { this.momentum = { bars }; this.startMotion(); }
            }
          }
          /* Touching the price gutter takes it off autoscale. The toolbar is
             told once, on release, rather than on every pointer sample. */
          if (drag.kind === 'priceScale') this.scaleChanged();
          drag = null;
          try { surface.releasePointerCapture(event.pointerId); } catch (e) { /* already released */ }
        }

        const point = local(event);
        setCursor(CURSORS[this.regionAt(point).kind] || 'crosshair');
        if (this.drawTool && this.drawTool.onPointerUp) this.drawTool.onPointerUp(this.snap(point), this, event);
      };
      surface.addEventListener('pointerup', release);
      surface.addEventListener('pointercancel', release);

      surface.addEventListener('pointerleave', () => {
        if (drag) return;   // a capture drag legitimately travels outside
        this.cursor = null;
        this.invalidate('fx');
        this.report(null);
      });

      surface.addEventListener('wheel', event => {
        event.preventDefault();
        const point = local(event);

        /* Shift and the wheel walk through history, matching the reference. */
        if (event.shiftKey && !event.ctrlKey) {
          const delta = event.deltaX || event.deltaY;
          this.panBars((delta / Math.max(1, this.barWidth())) * 1.2);
          return;
        }

        /* A trackpad pinch arrives as a wheel event with ctrl held and a small
           delta. Treated the same as a wheel zoom but without the easing, since
           the gesture is already continuous and easing it lags the fingers. */
        const pinchGesture = event.ctrlKey && Math.abs(event.deltaY) < 40;
        const anchorIndex = this.indexAt(point.x);
        const factor = Math.exp(event.deltaY * (pinchGesture ? 0.01 : 0.0022));
        const span = (this.viewTarget || this.view);

        this.price.auto = true;
        this.zoomTo((span.to - span.from) * factor, anchorIndex, pinchGesture);
      }, { passive: false });

      /* The right button opens a menu about whatever is under it — a drawing,
         an axis, or the chart itself. The engine reports what was hit and lets
         the interface draw the menu, because the chart owns geometry and knows
         nothing about markup. */
      surface.addEventListener('contextmenu', event => {
        event.preventDefault();
        if (!this.onContextMenu) return;
        const point = local(event);
        const hit = (this.drawTool && this.drawTool.hitTest) ? this.drawTool.hitTest(point) : null;
        const box = this.paneAt(point.y) || this.layout().panes[0];
        this.onContextMenu({
          clientX: event.clientX,
          clientY: event.clientY,
          region: this.regionAt(point).kind,
          price: this.priceAt(point.y, box),
          bar: this.bars[Math.max(0, Math.min(this.bars.length - 1, Math.round(this.indexAt(point.x) - 0.5)))] || null,
          drawing: hit ? hit.drawing : null
        });
      });

      surface.addEventListener('dblclick', event => {
        const region = this.regionAt(local(event));
        /* Double-clicking an axis restores what that axis controls, and only
           that. Resetting the whole view from the price gutter would throw away
           a time range the operator had just set up. */
        if (region.kind === 'priceScale') {
          this.price.auto = true;
          this.scaleChanged();
          return;
        }
        this.price.auto = true;
        this.resetView();
        this.scaleChanged();
        if (this.onViewChange) this.onViewChange(this.view);
      });

      /* The chart takes keyboard focus so the navigation keys reach it without
         a global listener that would fire while a price is being typed into the
         order ticket. */
      this.root.tabIndex = 0;
      this.root.addEventListener('keydown', event => this.onKey(event));
    }

    scaleChanged() {
      this.invalidate('all');
      if (this.onScaleChange) this.onScaleChange(this.price);
    }

    /* Navigation keys, following the reference's table. */
    onKey(event) {
      const step = event.ctrlKey ? 10 : 1;
      const handled = () => { event.preventDefault(); event.stopPropagation(); };

      if (event.altKey) {
        const key = event.key.toLowerCase();
        if (key === 'r') { this.price.auto = true; this.resetView(); this.scaleChanged(); return handled(); }
        if (key === 'l') { this.price.log = !this.price.log; this.price.percent = false; this.scaleChanged(); return handled(); }
        if (key === 'i') { this.price.inverted = !this.price.inverted; this.scaleChanged(); return handled(); }
        if (key === 'p') { this.price.percent = !this.price.percent; this.price.log = false; this.scaleChanged(); return handled(); }
        return;
      }

      if (event.key === 'ArrowLeft') { this.panBars(-step); return handled(); }
      if (event.key === 'ArrowRight') { this.panBars(step); return handled(); }
      if (event.ctrlKey && event.key === 'ArrowUp') { this.zoomBy(0.8); return handled(); }
      if (event.ctrlKey && event.key === 'ArrowDown') { this.zoomBy(1.25); return handled(); }
      if (event.key === 'Home') { this.view.to = this.view.to - this.view.from; this.view.from = 0; this.clampView(); this.invalidate('all'); return handled(); }
      if (event.key === 'End') { this.scrollToRealtime(); return handled(); }
    }

    report(index) {
      if (!this.onCrosshair) return;
      if (index == null) { this.onCrosshair(null); return; }
      const bar = this.bars[index];
      if (!bar) { this.onCrosshair(null); return; }
      this.onCrosshair({
        index,
        bar,
        values: this.overlays.concat(this.lowerPanes).map(item => ({
          id: item.id,
          label: item.label,
          colour: item.colour,
          unavailable: item.unavailable || null,
          value: item.lines && item.lines[0] ? item.lines[0].series[index]
            : (item.series && item.series[0] ? item.series[0].series[index] : null)
        }))
      });
    }

    /* ---------- lifecycle ---------- */

    setStyle(patch) {
      Object.assign(this.style, patch || {});
      this.invalidate('all');
    }

    destroy() {
      if (this.frame) cancelAnimationFrame(this.frame);
      this.stopMotion();
      clearInterval(this.clockTimer);
      this.observer.disconnect();
      Object.values(this.layers).forEach(layer => layer.canvas.remove());
      if (this.jumpButton) this.jumpButton.remove();
      this.onCrosshair = null;
      this.onViewChange = null;
    }
  }

  function shortNumber(value) {
    if (!Number.isFinite(value)) return '';
    const abs = Math.abs(value);
    if (abs >= 1e9) return (value / 1e9).toFixed(1) + 'bn';
    if (abs >= 1e6) return (value / 1e6).toFixed(1) + 'm';
    if (abs >= 1e3) return (value / 1e3).toFixed(1) + 'k';
    if (abs >= 10) return value.toFixed(1);
    return value.toFixed(2);
  }

  window.T = window.T || {};
  window.T.Chart = Chart;
  window.T.chartHelpers = { niceStep, shortNumber, AXIS_W, TIME_H };

}());
