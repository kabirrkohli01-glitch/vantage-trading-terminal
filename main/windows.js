'use strict';
/* Window management: the frameless shell, detached panels and multi-monitor
 * layout persistence.
 *
 * The brief asks for panels that can be pulled onto a second and third monitor
 * and for those arrangements to come back on the next launch. Two things make
 * that harder than it sounds, and both are handled here:
 *
 *   A DISPLAY THAT IS NO LONGER THERE. Restoring a window to the coordinates it
 *   had on a monitor that has since been unplugged puts it somewhere no cursor
 *   can reach. Every restored rectangle is tested against the displays that
 *   exist NOW, and one that lands nowhere visible is brought back to the
 *   primary display rather than trusted.
 *
 *   A DISPLAY THAT ARRIVES OR LEAVES WHILE RUNNING. The same rescue runs on
 *   every display change, so unplugging a monitor moves its windows rather than
 *   stranding them.
 *
 * Every window is created with the renderer fully isolated: no Node, no
 * preload access beyond one narrow bridge, and a content policy that forbids
 * the renderer from reaching the network at all. Nothing in the interface
 * fetches anything — the main process does all of it and passes results across
 * the bridge. That is what lets the policy be as tight as it is.
 */

const path = require('path');
const { BrowserWindow, screen, shell } = require('electron');
const brand = require('../src/core/brand');

const PRELOAD = path.join(__dirname, 'preload.js');
const RENDERER = path.join(__dirname, '..', 'web', 'index.html');
const ICON = path.join(__dirname, '..', 'web', 'assets', brand.iconStem + '.ico');

const MIN_WIDTH = 980;
const MIN_HEIGHT = 640;
const PANEL_MIN_WIDTH = 360;
const PANEL_MIN_HEIGHT = 260;

/* Ink from the artwork, so the frame that appears before the first paint is the
   application's own colour rather than white. A white flash on a black terminal
   reads as a fault. */
const BACKGROUND = '#0a0a0b';

class WindowManager {
  constructor(options) {
    const opts = options || {};
    this.store = opts.store || null;
    this.audit = opts.audit || null;
    this.main = null;
    this.panels = new Map();      // windowId -> { id, panel, window }
    this.saveTimer = null;
  }

  /* ---------- creation ---------- */

  webPreferences() {
    return {
      preload: PRELOAD,
      /* The renderer is a plain web page with no privileges. Every capability
         it has arrives through the bridge in preload.js and is enumerated
         there. */
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      /* The interface never opens a remote page, so this stays off. */
      allowRunningInsecureContent: false,
      spellcheck: false
    };
  }

  createMain() {
    if (this.main && !this.main.isDestroyed()) {
      this.main.focus();
      return this.main;
    }

    const saved = this.readLayout();
    const bounds = this.safeBounds(saved.main && saved.main.bounds, { width: 1600, height: 980 });

    const win = new BrowserWindow({
      ...bounds,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      frame: false,
      /* Keeps the native minimise and restore animation, the taskbar preview
         and correct alt-tab behaviour, which a fully frameless window loses. */
      thickFrame: true,
      backgroundColor: BACKGROUND,
      /* Shown on ready-to-show so the first frame the operator sees is the
         painted interface rather than an empty rectangle. */
      show: false,
      title: brand.windowTitle(),
      icon: ICON,
      autoHideMenuBar: true,
      webPreferences: this.webPreferences()
    });

    this.harden(win);
    win.loadFile(RENDERER, { query: { role: 'main' } });

    win.once('ready-to-show', () => {
      if (saved.main && saved.main.maximized) win.maximize();
      win.show();
    });

    /* A window that never fires ready-to-show — a renderer that threw during
       start-up, most often — would otherwise leave no window at all and no
       indication why. Showing it anyway surfaces the broken page. */
    const rescue = setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) {
        win.show();
        this.record('window.forcedVisible', { reason: 'the renderer did not signal readiness' });
      }
    }, 4000);
    win.once('show', () => clearTimeout(rescue));

    ['resize', 'move', 'maximize', 'unmaximize'].forEach(event => win.on(event, () => this.scheduleSave()));
    win.on('closed', () => { this.main = null; });

    this.main = win;
    return win;
  }

  /* Pull a panel out of the main window into its own frameless window.
   *
   * `displayId` places it on a specific monitor. When none is given it opens on
   * the display holding the cursor, which is where the operator just dragged
   * from and therefore where they are looking. */
  detach(panelType, options) {
    const opts = options || {};
    const id = opts.id || (panelType + '-' + Date.now().toString(36));

    const target = this.displayFor(opts.displayId);
    const bounds = this.safeBounds(opts.bounds, {
      width: Math.min(920, Math.round(target.workArea.width * 0.5)),
      height: Math.min(700, Math.round(target.workArea.height * 0.7))
    }, target);

    const win = new BrowserWindow({
      ...bounds,
      minWidth: PANEL_MIN_WIDTH,
      minHeight: PANEL_MIN_HEIGHT,
      frame: false,
      thickFrame: true,
      backgroundColor: BACKGROUND,
      show: false,
      title: brand.windowTitle(opts.title || panelType),
      icon: ICON,
      autoHideMenuBar: true,
      webPreferences: this.webPreferences()
    });

    this.harden(win);
    win.loadFile(RENDERER, { query: { role: 'panel', panel: panelType, id, symbol: opts.symbol || '' } });
    win.once('ready-to-show', () => win.show());

    ['resize', 'move'].forEach(event => win.on(event, () => this.scheduleSave()));
    win.on('closed', () => {
      this.panels.delete(win.id);
      this.scheduleSave();
    });

    this.panels.set(win.id, { id, panel: panelType, symbol: opts.symbol || null, window: win });
    this.scheduleSave();
    this.record('panel.detached', { panel: panelType, id, display: target.id });
    return { id, windowId: win.id };
  }

  /* Navigation lockdown.
   *
   * The interface is a local page that never needs to become a different page.
   * Anything trying to navigate it or open a window is refused; a genuine
   * external link — a filing, a news article — is handed to the operating
   * system's browser instead, where it belongs. */
  harden(win) {
    const contents = win.webContents;

    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });

    contents.on('will-navigate', (event, url) => {
      const here = contents.getURL();
      if (url !== here && !url.startsWith('file://')) {
        event.preventDefault();
        if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
      }
    });

    contents.on('will-attach-webview', event => event.preventDefault());

    /* A renderer that crashes must say so rather than leaving a black
       rectangle that looks like a slow load. */
    contents.on('render-process-gone', (event, details) => {
      this.record('renderer.gone', { reason: details.reason, exitCode: details.exitCode });
    });
  }

  /* ---------- displays ---------- */

  displays() {
    return screen.getAllDisplays().map(d => ({
      id: d.id,
      label: d.label || ('Display ' + d.id),
      bounds: d.bounds,
      workArea: d.workArea,
      scaleFactor: d.scaleFactor,
      primary: d.id === screen.getPrimaryDisplay().id
    }));
  }

  displayFor(displayId) {
    const all = screen.getAllDisplays();
    if (displayId != null) {
      const found = all.find(d => d.id === displayId);
      if (found) return found;
    }
    /* No display named, or the named one is gone: use the one under the
       cursor. */
    try {
      return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    } catch (e) {
      return screen.getPrimaryDisplay();
    }
  }

  /* A rectangle that is genuinely visible on a display that exists now.
   *
   * Restoring saved coordinates without this check is how a window ends up on
   * a monitor that was unplugged three days ago, with no way to reach it and
   * no indication that it opened at all. */
  safeBounds(saved, fallback, preferred) {
    const displays = screen.getAllDisplays();
    const base = preferred || screen.getPrimaryDisplay();

    const centred = () => ({
      width: Math.min(fallback.width, base.workArea.width),
      height: Math.min(fallback.height, base.workArea.height),
      x: Math.round(base.workArea.x + (base.workArea.width - Math.min(fallback.width, base.workArea.width)) / 2),
      y: Math.round(base.workArea.y + (base.workArea.height - Math.min(fallback.height, base.workArea.height)) / 2)
    });

    if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y) ||
        !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) {
      return centred();
    }

    /* Enough of the title bar must land inside a work area for the window to be
       grabbable. A window overlapping by one pixel is technically on screen and
       practically lost. */
    const MARGIN = 80;
    const visible = displays.some(display => {
      const area = display.workArea;
      return saved.x + saved.width - MARGIN > area.x &&
        saved.x + MARGIN < area.x + area.width &&
        saved.y + 40 >= area.y &&
        saved.y + MARGIN < area.y + area.height;
    });

    if (!visible) return centred();

    return {
      x: Math.round(saved.x),
      y: Math.round(saved.y),
      width: Math.max(MIN_WIDTH / 2, Math.round(saved.width)),
      height: Math.max(PANEL_MIN_HEIGHT, Math.round(saved.height))
    };
  }

  /* Called when the display arrangement changes. Any window now stranded is
     brought somewhere reachable. */
  rescueWindows() {
    const all = [this.main, ...Array.from(this.panels.values()).map(p => p.window)].filter(Boolean);
    all.forEach(win => {
      if (win.isDestroyed() || win.isMinimized()) return;
      const current = win.getBounds();
      const safe = this.safeBounds(current, { width: current.width, height: current.height });
      if (safe.x !== current.x || safe.y !== current.y) {
        win.setBounds(safe);
        this.record('window.rescued', { from: current, to: safe });
      }
    });
    this.broadcast('displays:changed', this.displays());
  }

  /* ---------- layout persistence ---------- */

  readLayout() {
    if (!this.store) return {};
    return this.store.doc('layout', {}) || {};
  }

  /* Debounced: a drag fires move events continuously, and writing the layout on
     every one of them turns a window drag into hundreds of disk writes. */
  scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveLayout(), 500);
  }

  saveLayout() {
    if (!this.store) return;
    const layout = { savedAt: Date.now(), main: null, panels: [] };

    if (this.main && !this.main.isDestroyed()) {
      layout.main = {
        bounds: this.main.isMaximized() ? (this.main.getNormalBounds ? this.main.getNormalBounds() : this.main.getBounds()) : this.main.getBounds(),
        maximized: this.main.isMaximized(),
        displayId: this.displayIdOf(this.main)
      };
    }

    this.panels.forEach(entry => {
      if (entry.window.isDestroyed()) return;
      layout.panels.push({
        id: entry.id,
        panel: entry.panel,
        symbol: entry.symbol,
        bounds: entry.window.getBounds(),
        displayId: this.displayIdOf(entry.window)
      });
    });

    this.store.putDoc('layout', layout);
  }

  displayIdOf(win) {
    try {
      return screen.getDisplayMatching(win.getBounds()).id;
    } catch (e) {
      return null;
    }
  }

  /* Reopen the detached panels a previous session left behind. */
  restorePanels() {
    const layout = this.readLayout();
    (layout.panels || []).forEach(entry => {
      if (!entry || !entry.panel) return;
      this.detach(entry.panel, {
        id: entry.id,
        bounds: entry.bounds,
        displayId: entry.displayId,
        symbol: entry.symbol
      });
    });
  }

  /* ---------- messaging ---------- */

  all() {
    return [this.main, ...Array.from(this.panels.values()).map(p => p.window)]
      .filter(w => w && !w.isDestroyed());
  }

  /* State lives in the main process and every window is a view of it, so a
     symbol selected in one window can update the others.
   *
   * The exclusion is a webContents id rather than a window id, because that is
   * what a request carries on `event.sender`. Comparing the two kinds of id is
   * a mistake that costs nothing on the first window and silently stops
   * excluding the sender on every one after it. */
  broadcast(channel, payload, exceptWebContentsId) {
    this.all().forEach(win => {
      if (exceptWebContentsId != null && win.webContents.id === exceptWebContentsId) return;
      try { win.webContents.send(channel, payload); } catch (e) { /* a closing window */ }
    });
  }

  owns(webContents) {
    return this.all().some(win => win.webContents.id === webContents.id);
  }

  record(kind, detail) {
    if (this.audit) this.audit.write(kind, detail);
  }
}

module.exports = { WindowManager, BACKGROUND };
