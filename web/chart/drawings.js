'use strict';
/* The drawing toolkit.
 *
 * EVERY ANCHOR IS A TIME AND A PRICE. Never a pixel, never a bar index. This is
 * the decision the whole file rests on:
 *
 *   Pixels move when the window resizes, so a trend line drawn at one size
 *   points somewhere else at another.
 *   Bar indices move when the timeframe changes, because bar 40 on an hourly
 *   chart and bar 40 on a daily chart are months apart.
 *   A time and a price are properties of the market, so a line drawn on the
 *   hourly chart is the same line on the daily one, and it is still the same
 *   line after a zoom, a resize and a relaunch.
 *
 * The chart engine converts between the two through project() and unproject(),
 * so nothing here does its own arithmetic on the viewport.
 *
 * Drawings are stored per instrument and reloaded with it.
 */

(function () {

  const num = window.T.num;

  /* Hit-testing tolerance in pixels. Generous enough to grab a one-pixel line
     with a mouse, tight enough not to steal a click meant for the chart. */
  const GRAB = 7;
  const HANDLE = 4;

  /* The retracement levels, and the extension beyond them. These are the
     conventional set; they are listed rather than computed so they can be
     changed in one place. */
  const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618];

  /* One colour per level, in the order the levels are listed. Chosen to stay
     distinguishable on both a white and a near-black chart, and to keep the two
     anchors (0 and 1) visually quieter than the levels between them, which are
     the ones being read. */
  const FIB_COLOURS = [
    '#787b86', '#f23645', '#ff9800', '#4caf50', '#089981',
    '#00bcd4', '#787b86', '#2962ff', '#9c27b0'
  ];

  /* How many anchors each tool needs before it is finished. */
  const ANCHORS = {
    trend: 2, ray: 2, rectangle: 2, ellipse: 2, fib: 2, measure: 2,
    arrow: 2, position: 2, channel: 3, pitchfork: 3,
    horizontal: 1, vertical: 1, text: 1
  };

  function distanceToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  class DrawingLayer {
    constructor(chart, options) {
      const opts = options || {};
      this.chart = chart;
      this.drawings = [];
      this.tool = 'cursor';
      this.pending = null;      // the drawing being placed
      this.selected = null;
      this.dragging = null;
      this.onChange = opts.onChange || null;
      this.onFinish = opts.onFinish || null;
      this.style = {
        colour: opts.colour || chart.style.accent,
        width: 1.4,
        fill: chart.style.shapeFill
      };
      chart.drawTool = this;
    }

    /* What each tool draws in by default.
     *
     * One colour for every tool means a chart with six drawings on it is six
     * lines of the same colour and nothing tells them apart. These follow the
     * convention the reference uses: levels and measurements in a neutral grey
     * so they sit behind the price, structure in blue, a position in the
     * green and red of the outcome it describes. */
    defaultColour(tool) {
      const style = this.chart.style;
      return {
        horizontal: '#787b86',
        vertical: '#787b86',
        measure: '#787b86',
        text: style.text,
        rectangle: style.accent,
        ellipse: style.accent,
        channel: '#9c27b0',
        pitchfork: '#00bcd4',
        arrow: style.accent,
        position: style.up
      }[tool] || style.accent;
    }

    setTool(tool) {
      this.tool = tool || 'cursor';
      this.style.colour = this.defaultColour(this.tool);
      /* Switching tools abandons a half-placed drawing rather than leaving it
         to be completed by a click meant for something else. */
      this.pending = null;
      this.chart.invalidate('draw');
    }

    load(drawings) {
      this.drawings = (drawings || []).map(d => Object.assign({}, d));
      this.selected = null;
      this.pending = null;
      this.chart.invalidate('draw');
    }

    all() {
      return this.drawings.map(d => Object.assign({}, d));
    }

    clear() {
      this.drawings = [];
      this.selected = null;
      this.pending = null;
      this.chart.invalidate('draw');
      this.changed();
    }

    /* Restyle one drawing. Its own style is merged rather than replaced, so
       setting a colour does not silently reset the width beside it. */
    restyle(id, patch) {
      const drawing = this.drawings.find(d => d.id === id);
      if (!drawing) return;
      drawing.style = Object.assign({}, drawing.style, patch || {});
      this.chart.invalidate('draw');
      this.changed();
    }

    remove(id) {
      const before = this.drawings.length;
      this.drawings = this.drawings.filter(d => d.id !== id);
      if (this.drawings.length === before) return;
      if (this.selected === id) this.selected = null;
      this.chart.invalidate('draw');
      this.changed();
    }

    removeSelected() {
      if (!this.selected) return;
      this.drawings = this.drawings.filter(d => d.id !== this.selected);
      this.selected = null;
      this.chart.invalidate('draw');
      this.changed();
    }

    changed() {
      if (this.onChange) this.onChange(this.all());
    }

    /* What the pointer should look like here, or null to leave it to the chart.
       A tool that is armed shows the crosshair it is about to place with; over
       an existing drawing the shape says whether a press will move the whole
       object or just the handle under the pointer. */
    cursorAt(point) {
      if (this.tool !== 'cursor') return 'crosshair';
      const hit = this.hitTest(point);
      if (!hit) return null;
      return hit.handle === 'whole' ? 'move' : 'pointer';
    }

    /* ---------- placing ---------- */

    onPointerDown(point, chart, event) {
      if (this.tool === 'cursor') {
        const hit = this.hitTest(point);
        /* Selecting is not the same as starting a pan, so a click that lands on
           a drawing is consumed and one that does not is passed through. */
        if (hit) {
          this.selected = hit.drawing.id;
          this.dragging = {
            id: hit.drawing.id,
            handle: hit.handle,
            from: chart.unproject(point.x, point.y),
            original: JSON.parse(JSON.stringify(hit.drawing.anchors))
          };
          chart.invalidate('draw');
          return true;
        }
        if (this.selected) { this.selected = null; chart.invalidate('draw'); }
        return false;
      }

      const at = chart.unproject(point.x, point.y);
      if (at.t === null) return true;

      if (!this.pending) {
        const wanted = ANCHORS[this.tool] || 2;
        this.pending = {
          id: 'd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          type: this.tool,
          anchors: new Array(Math.max(2, wanted)).fill(at),
          style: Object.assign({}, this.style),
          text: this.tool === 'text' ? 'Note' : null
        };
        /* A one-anchor tool is finished the moment it is placed. */
        if (wanted === 1) { this.pending.anchors = [at]; return this.commit(); }
        this.placed = 1;
        this.pressAt = { x: point.x, y: point.y };
        return true;
      }

      const wanted = ANCHORS[this.pending.type] || 2;
      this.placed = (this.placed || 1) + 1;
      this.pending.anchors[this.placed - 1] = at;
      /* A three-anchor tool takes another click before it is finished. */
      if (this.placed < wanted) return true;
      return this.commit();
    }

    onPointerMove(point, chart) {
      if (this.dragging) {
        const to = chart.unproject(point.x, point.y);
        if (to.t === null) return;
        const drawing = this.drawings.find(d => d.id === this.dragging.id);
        if (!drawing) return;

        if (this.dragging.handle === 'whole') {
          /* Moving the whole shape shifts every anchor by the same amount in
             time and in price, so its shape is preserved rather than skewed. */
          const shiftT = to.t - this.dragging.from.t;
          const shiftPrice = to.price - this.dragging.from.price;
          drawing.anchors = this.dragging.original.map(anchor => ({
            t: anchor.t + shiftT,
            price: anchor.price + shiftPrice
          }));
        } else {
          drawing.anchors[this.dragging.handle] = to;
        }
        chart.invalidate('draw');
        return;
      }

      if (this.pending) {
        const at = chart.unproject(point.x, point.y);
        if (at.t !== null) {
          /* The anchor being placed follows the pointer; the ones already
             committed stay where they were put. */
          const index = Math.max(1, this.placed || 1);
          this.pending.anchors[index] = at;
          chart.invalidate('draw');
        }
      }
    }

    onPointerUp(point) {
      if (this.dragging) {
        this.dragging = null;
        this.changed();
        return;
      }

      /* PRESS, DRAG, RELEASE PLACES A DRAWING.
       *
       * Two-click placement alone is why half these tools appeared not to work:
       * the natural gesture — press at the start, drag to the end, let go —
       * produced nothing at all, because nothing committed on release. The
       * drawing was left half placed, and the next click anywhere finished it
       * somewhere the operator had not chosen. Both gestures now work: a drag
       * of any real distance finishes on release, and a click that did not move
       * still waits for the second click, which is the only way to place a
       * three-anchor tool. */
      if (!this.pending || !this.pressAt || !point) return;
      const wanted = ANCHORS[this.pending.type] || 2;
      if (wanted !== 2 || this.placed !== 1) return;
      if (Math.hypot(point.x - this.pressAt.x, point.y - this.pressAt.y) < GRAB) return;

      const at = this.chart.unproject(point.x, point.y);
      if (at.t === null) return;
      this.pending.anchors[1] = at;
      this.commit();
    }

    commit() {
      const drawing = this.pending;
      this.pending = null;
      this.placed = 0;
      this.pressAt = null;
      if (!drawing) return true;

      /* A shape with no extent is an accidental click, not a drawing. */
      if (ANCHORS[drawing.type] === 2) {
        const a = this.chart.project(drawing.anchors[0]);
        const b = this.chart.project(drawing.anchors[1]);
        if (Math.hypot(b.x - a.x, b.y - a.y) < 4) { this.chart.invalidate('draw'); return true; }
      }

      this.drawings.push(drawing);
      this.selected = drawing.id;
      this.chart.invalidate('draw');
      this.changed();

      /* THE TOOL PUTS ITSELF AWAY. Staying armed means the next click anywhere
         on the chart draws a second one, so panning after placing a line
         produces a line instead — and the operator has to remember to disarm a
         tool they have finished with. Every reference behaves this way. */
      if (this.onFinish) this.onFinish(drawing);
      return true;
    }

    /* ---------- hit testing ---------- */

    hitTest(point) {
      /* Newest first: a drawing placed on top of another is the one grabbed. */
      for (let i = this.drawings.length - 1; i >= 0; i--) {
        const drawing = this.drawings[i];
        const points = drawing.anchors.map(anchor => this.chart.project(anchor));

        for (let h = 0; h < points.length; h++) {
          if (Math.hypot(point.x - points[h].x, point.y - points[h].y) <= GRAB) {
            return { drawing, handle: h };
          }
        }

        if (this.onShape(drawing, points, point)) return { drawing, handle: 'whole' };
      }
      return null;
    }

    onShape(drawing, points, point) {
      const width = this.chart.layout().plotWidth;
      switch (drawing.type) {
        case 'trend':
        case 'measure':
        case 'arrow':
          return distanceToSegment(point.x, point.y, points[0].x, points[0].y, points[1].x, points[1].y) <= GRAB;

        case 'channel':
        case 'pitchfork':
          return points.some((p, i) => i > 0 &&
            distanceToSegment(point.x, point.y, points[i - 1].x, points[i - 1].y, p.x, p.y) <= GRAB) ||
            distanceToSegment(point.x, point.y, points[0].x, points[0].y, points[1].x, points[1].y) <= GRAB;

        case 'ellipse': {
          const cx = (points[0].x + points[1].x) / 2;
          const cy = (points[0].y + points[1].y) / 2;
          const rx = Math.abs(points[1].x - points[0].x) / 2;
          const ry = Math.abs(points[1].y - points[0].y) / 2;
          if (rx < 1 || ry < 1) return false;
          const d = Math.pow((point.x - cx) / rx, 2) + Math.pow((point.y - cy) / ry, 2);
          /* The outline is grabbable, the interior is not. */
          return d > 0.6 && d < 1.5;
        }

        case 'position': {
          const left = Math.min(points[0].x, points[1].x);
          const right = Math.max(points[0].x, points[1].x);
          return point.x >= left - GRAB && point.x <= right + GRAB &&
            Math.abs(point.y - points[0].y) <= GRAB * 2;
        }
        case 'ray': {
          const dx = points[1].x - points[0].x;
          const dy = points[1].y - points[0].y;
          const scale = dx === 0 ? 1 : (width - points[0].x) / dx;
          const endX = points[0].x + dx * Math.max(scale, 1);
          const endY = points[0].y + dy * Math.max(scale, 1);
          return distanceToSegment(point.x, point.y, points[0].x, points[0].y, endX, endY) <= GRAB;
        }
        case 'horizontal':
          return Math.abs(point.y - points[0].y) <= GRAB;
        case 'vertical':
          return Math.abs(point.x - points[0].x) <= GRAB;
        case 'rectangle': {
          const left = Math.min(points[0].x, points[1].x);
          const right = Math.max(points[0].x, points[1].x);
          const top = Math.min(points[0].y, points[1].y);
          const bottom = Math.max(points[0].y, points[1].y);
          const near = v => v <= GRAB;
          const insideX = point.x >= left - GRAB && point.x <= right + GRAB;
          const insideY = point.y >= top - GRAB && point.y <= bottom + GRAB;
          /* The edges are grabbable; the interior is not, so a rectangle drawn
             around price action does not swallow every click inside it. */
          return (insideY && (near(Math.abs(point.x - left)) || near(Math.abs(point.x - right)))) ||
            (insideX && (near(Math.abs(point.y - top)) || near(Math.abs(point.y - bottom))));
        }
        case 'fib': {
          const from = points[0].y;
          const to = points[1].y;
          return FIB_LEVELS.some(level => Math.abs(point.y - (from + (to - from) * level)) <= GRAB) &&
            point.x >= Math.min(points[0].x, points[1].x) - GRAB;
        }
        case 'text':
          return Math.abs(point.x - points[0].x) < 70 && Math.abs(point.y - points[0].y) < 12;
        default:
          return false;
      }
    }

    /* ---------- painting ---------- */

    paint(ctx, chart) {
      const list = this.pending ? this.drawings.concat([this.pending]) : this.drawings;
      list.forEach(drawing => this.paintOne(ctx, chart, drawing, drawing.id === this.selected));
    }

    paintOne(ctx, chart, drawing, selected) {
      const points = drawing.anchors.map(anchor => chart.project(anchor));
      const style = drawing.style || this.style;
      const width = chart.layout().plotWidth;
      const height = chart.layout().panes[0].height;

      ctx.save();
      ctx.strokeStyle = style.colour;
      ctx.fillStyle = style.colour;
      ctx.lineWidth = style.width || 1.4;
      ctx.lineJoin = 'round';

      switch (drawing.type) {
        case 'trend':
          line(ctx, points[0], points[1]);
          break;

        case 'ray': {
          const dx = points[1].x - points[0].x;
          const dy = points[1].y - points[0].y;
          const scale = dx === 0 ? 1000 : Math.max((width - points[0].x) / dx, 1);
          line(ctx, points[0], { x: points[0].x + dx * scale, y: points[0].y + dy * scale });
          break;
        }

        case 'horizontal': {
          const y = Math.round(points[0].y) + 0.5;
          line(ctx, { x: 0, y }, { x: width, y });
          chart.paintTag(ctx, width, y, chart.formatPrice(drawing.anchors[0].price), style.colour, chart.style.tagInk);
          break;
        }

        case 'vertical': {
          const x = Math.round(points[0].x) + 0.5;
          line(ctx, { x, y: 0 }, { x, y: chart.height - 22 });
          break;
        }

        case 'rectangle': {
          const x = Math.min(points[0].x, points[1].x);
          const y = Math.min(points[0].y, points[1].y);
          const w = Math.abs(points[1].x - points[0].x);
          const h = Math.abs(points[1].y - points[0].y);
          ctx.fillStyle = style.fill || chart.style.shapeFill;
          ctx.fillRect(x, y, w, h);
          ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
          break;
        }

        case 'fib': {
          const left = Math.min(points[0].x, points[1].x);
          const right = Math.max(points[0].x, points[1].x);
          const fromPrice = drawing.anchors[0].price;
          const toPrice = drawing.anchors[1].price;

          ctx.font = chart.style.labelFont;
          ctx.textBaseline = 'bottom';

          /* EACH LEVEL CARRIES ITS OWN COLOUR. Drawn in one colour, a
             retracement is nine parallel lines and the eye has to count them to
             find the one it wants. Coloured, the half and the 0.618 are found
             without reading a single label — which is the entire reason the
             tool is used at a glance. The set is overridable per drawing. */
          const palette = (drawing.style && drawing.style.levelColours) || FIB_COLOURS;

          FIB_LEVELS.forEach((level, i) => {
            const colour = palette[i % palette.length];
            const price = fromPrice + (toPrice - fromPrice) * level;
            const y = Math.round(chart.yOf(price, chart.layout().panes[0])) + 0.5;
            const outer = level === 0 || level === 1;

            ctx.strokeStyle = colour;
            ctx.globalAlpha = outer ? 0.95 : 0.7;
            ctx.setLineDash(outer ? [] : [3, 3]);
            line(ctx, { x: left, y }, { x: right, y });

            /* Between the two outer levels, a light band makes the retracement
               region readable at a glance. */
            if (i > 0 && level <= 1) {
              const previousPrice = fromPrice + (toPrice - fromPrice) * FIB_LEVELS[i - 1];
              const previousY = chart.yOf(previousPrice, chart.layout().panes[0]);
              ctx.globalAlpha = 0.07;
              ctx.fillStyle = colour;
              ctx.fillRect(left, Math.min(y, previousY), right - left, Math.abs(y - previousY));
            }

            ctx.globalAlpha = 0.95;
            ctx.fillStyle = colour;
            ctx.setLineDash([]);
            ctx.fillText(level.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + '  ' + chart.formatPrice(price),
              left + 4, y - 2);
          });
          ctx.globalAlpha = 1;
          ctx.strokeStyle = style.colour;
          break;
        }

        case 'measure': {
          const fromPrice = drawing.anchors[0].price;
          const toPrice = drawing.anchors[1].price;
          const move = toPrice - fromPrice;
          const percent = fromPrice === 0 ? null : (move / Math.abs(fromPrice)) * 100;
          const bars = Math.abs(chart.indexOfTime(drawing.anchors[1].t) - chart.indexOfTime(drawing.anchors[0].t));

          const x = Math.min(points[0].x, points[1].x);
          const y = Math.min(points[0].y, points[1].y);
          const w = Math.abs(points[1].x - points[0].x);
          const h = Math.abs(points[1].y - points[0].y);

          /* A measurement reads in the colours of rising and falling, which are
             not the colours the candles happen to be set to. */
          const way = move >= 0 ? chart.style.measureUp : chart.style.measureDown;
          ctx.fillStyle = chart.style.measureFill(move >= 0);
          ctx.strokeStyle = way;
          ctx.fillRect(x, y, w, h);
          ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));

          const label = (move >= 0 ? '+' : '') + chart.formatPrice(move) +
            (percent === null ? '' : '  (' + (percent >= 0 ? '+' : '') + percent.toFixed(2) + '%)') +
            '   ' + Math.round(bars) + ' bars';
          ctx.font = chart.style.labelFont;
          const textWidth = ctx.measureText(label).width + 14;
          ctx.fillStyle = way;
          ctx.beginPath();
          ctx.roundRect(x + w / 2 - textWidth / 2, y - 20, textWidth, 17, 3);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, x + w / 2, y - 11);
          break;
        }

        case 'arrow': {
          line(ctx, points[0], points[1]);
          /* The head is drawn along the line's own direction so it points where
             the line points at any angle. */
          const angle = Math.atan2(points[1].y - points[0].y, points[1].x - points[0].x);
          const size = 9;
          ctx.beginPath();
          ctx.moveTo(points[1].x, points[1].y);
          ctx.lineTo(points[1].x - size * Math.cos(angle - 0.4), points[1].y - size * Math.sin(angle - 0.4));
          ctx.lineTo(points[1].x - size * Math.cos(angle + 0.4), points[1].y - size * Math.sin(angle + 0.4));
          ctx.closePath();
          ctx.fill();
          break;
        }

        case 'ellipse': {
          const cx = (points[0].x + points[1].x) / 2;
          const cy = (points[0].y + points[1].y) / 2;
          const rx = Math.abs(points[1].x - points[0].x) / 2;
          const ry = Math.abs(points[1].y - points[0].y) / 2;
          ctx.beginPath();
          ctx.ellipse(cx, cy, Math.max(rx, 1), Math.max(ry, 1), 0, 0, Math.PI * 2);
          ctx.fillStyle = style.fill || chart.style.shapeFill;
          ctx.fill();
          ctx.stroke();
          break;
        }

        case 'channel': {
          /* Two parallel lines: the first two anchors define the slope, the
             third sets the width by offsetting the same slope through it. */
          const dx = points[1].x - points[0].x;
          const dy = points[1].y - points[0].y;
          const offsetY = points[2] ? points[2].y - (points[0].y + dy * ((points[2].x - points[0].x) / (dx || 1))) : 0;

          ctx.beginPath();
          ctx.moveTo(points[0].x, points[0].y);
          ctx.lineTo(points[1].x, points[1].y);
          ctx.lineTo(points[1].x, points[1].y + offsetY);
          ctx.lineTo(points[0].x, points[0].y + offsetY);
          ctx.closePath();
          ctx.fillStyle = style.fill || chart.style.shapeFill;
          ctx.fill();

          line(ctx, points[0], points[1]);
          line(ctx, { x: points[0].x, y: points[0].y + offsetY }, { x: points[1].x, y: points[1].y + offsetY });
          ctx.globalAlpha = 0.55;
          ctx.setLineDash([4, 4]);
          line(ctx,
            { x: points[0].x, y: points[0].y + offsetY / 2 },
            { x: points[1].x, y: points[1].y + offsetY / 2 });
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
          break;
        }

        case 'pitchfork': {
          /* A median line from the first anchor through the midpoint of the
             other two, with the two tines parallel to it. */
          if (!points[2]) break;
          const midX = (points[1].x + points[2].x) / 2;
          const midY = (points[1].y + points[2].y) / 2;
          const dx = midX - points[0].x;
          const dy = midY - points[0].y;
          const reach = dx === 0 ? 3 : Math.max((width - points[0].x) / dx, 1.4);

          const draw = (fromX, fromY) => line(ctx,
            { x: fromX, y: fromY },
            { x: fromX + dx * reach, y: fromY + dy * reach });

          ctx.globalAlpha = 0.95;
          draw(points[0].x, points[0].y);
          ctx.globalAlpha = 0.7;
          draw(points[1].x, points[1].y);
          draw(points[2].x, points[2].y);
          ctx.globalAlpha = 0.45;
          line(ctx, points[1], points[2]);
          ctx.globalAlpha = 1;
          break;
        }

        case 'position': {
          /* Entry, stop and target as a proportioned block, with the reward to
             risk computed from the prices actually placed rather than typed. */
          const entry = drawing.anchors[0].price;
          const target = drawing.anchors[1].price;
          const risk = drawing.stopPrice == null
            ? entry - (target - entry) / 2
            : drawing.stopPrice;

          const left = Math.min(points[0].x, points[1].x);
          const right = Math.max(points[0].x, points[1].x);
          const entryY = chart.yOf(entry, chart.layout().panes[0]);
          const targetY = chart.yOf(target, chart.layout().panes[0]);
          const stopY = chart.yOf(risk, chart.layout().panes[0]);

          ctx.fillStyle = 'rgba(38,166,154,.16)';
          ctx.fillRect(left, Math.min(entryY, targetY), right - left, Math.abs(targetY - entryY));
          ctx.fillStyle = 'rgba(239,83,80,.16)';
          ctx.fillRect(left, Math.min(entryY, stopY), right - left, Math.abs(stopY - entryY));

          ctx.strokeStyle = chart.style.up;
          line(ctx, { x: left, y: targetY }, { x: right, y: targetY });
          ctx.strokeStyle = chart.style.down;
          line(ctx, { x: left, y: stopY }, { x: right, y: stopY });
          ctx.strokeStyle = style.colour;
          ctx.setLineDash([3, 3]);
          line(ctx, { x: left, y: entryY }, { x: right, y: entryY });
          ctx.setLineDash([]);

          const reward = Math.abs(target - entry);
          const loss = Math.abs(entry - risk);
          const ratio = loss > 0 ? (reward / loss) : null;
          ctx.font = chart.style.labelFont;
          ctx.fillStyle = chart.style.text;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(
            'Target ' + chart.formatPrice(target) + '   Stop ' + chart.formatPrice(risk) +
            (ratio === null ? '' : '   ' + ratio.toFixed(2) + 'R'),
            left + 5, Math.min(entryY, targetY, stopY) - 4);
          break;
        }

        case 'text': {
          ctx.font = '12px ' + (chart.style.font.split(' ').slice(1).join(' ') || 'sans-serif');
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(drawing.text || 'Note', points[0].x + 6, points[0].y);
          ctx.beginPath();
          ctx.arc(points[0].x, points[0].y, 2.5, 0, Math.PI * 2);
          ctx.fill();
          break;
        }

        default:
          break;
      }

      if (selected) {
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.fillStyle = style.colour;
        ctx.strokeStyle = chart.style.plane;
        ctx.lineWidth = 1;
        points.forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, HANDLE, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        });
      }

      ctx.restore();
    }
  }

  function line(ctx, from, to) {
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }

  window.T = window.T || {};
  window.T.DrawingLayer = DrawingLayer;
  window.T.FIB_LEVELS = FIB_LEVELS;
  window.T.FIB_COLOURS = FIB_COLOURS;
  window.T.DRAW_ANCHORS = ANCHORS;

}());
