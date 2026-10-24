'use strict';
/* Application entry point.
 *
 * Responsibilities kept deliberately small: start once, build the services,
 * open the shell, and shut down without losing a write. Everything else lives
 * in the modules this file assembles.
 */

const { app, BrowserWindow, screen, session } = require('electron');
const path = require('path');

const brand = require('../src/core/brand');
const { WindowManager } = require('./windows');
const { Services } = require('./services');
const ipc = require('./ipc');

/* THE LOCK IS PER DATA DIRECTORY, NOT PER APPLICATION.
 *
 * A second launch against the same records should focus the running window
 * rather than starting a rival copy that would fight it for the same files —
 * that is the whole point of the lock. But a copy pointed at a different data
 * directory is not a rival: it shares nothing. The interface probe is exactly
 * that, and without this it could not run at all while the operator had the
 * application open, which is precisely when it is most wanted.
 *
 * Electron keys the lock on the userData path, so pointing that at the data
 * directory makes the lock mean what it is meant to mean. */
if (process.env.TERMINAL_DATA_DIR) {
  app.setPath('userData', path.join(process.env.TERMINAL_DATA_DIR, 'chromium'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start() {
  /* The product name is set at runtime from the one file that holds it, rather
     than being written into package.json where it would be a second home for
     the same string. */
  app.setName(brand.name);
  if (process.platform === 'win32') app.setAppUserModelId('com.kabirrkohli.' + brand.iconStem);

  let services = null;
  let windows = null;

  app.on('second-instance', () => {
    if (windows && windows.main) {
      if (windows.main.isMinimized()) windows.main.restore();
      windows.main.focus();
    }
  });

  app.whenReady().then(async () => {
    services = new Services();
    windows = new WindowManager({ store: services.stores.config, audit: services.audit });

    /* The loopback origin has to exist before the policy is written, because the
       policy names it. A failure to bind is not fatal: the application runs
       without embedded widgets and news artwork and says so. */
    let embedOrigin = null;
    try {
      await services.embeds.start();
      embedOrigin = services.embeds.origin();
    } catch (err) {
      services.audit.write('embeds.failed', { reason: String((err && err.message) || err) });
    }

    hardenSession(embedOrigin);
    ipc.install({ windows, services });

    windows.createMain();
    windows.restorePanels();

    /* Monitors are unplugged, docked and rearranged while an application is
       running. Both events run the same rescue so a window is never left at
       coordinates that no longer exist on any screen. */
    screen.on('display-removed', () => windows.rescueWindows());
    screen.on('display-added', () => windows.rescueWindows());
    screen.on('display-metrics-changed', () => windows.rescueWindows());

    app.on('activate', () => {
      if (!BrowserWindow.getAllWindows().length) windows.createMain();
    });
  });

  /* Closing every window ends the session on Windows, which is what the
     platform's users expect. */
  app.on('window-all-closed', () => app.quit());

  let shuttingDown = false;
  app.on('before-quit', event => {
    if (shuttingDown || !services) return;
    /* Writes are queued and atomic, so quitting mid-write would leave the last
       save unlanded. The quit is deferred until every queue has drained. */
    event.preventDefault();
    shuttingDown = true;
    if (windows) windows.saveLayout();
    services.shutdown()
      .catch(() => {})
      .then(() => app.exit(0));
  });
}

/* Content policy, applied to the renderer at the session level as well as in
 * the page itself.
 *
 * connect-src is 'none' on purpose. The interface makes no network requests of
 * any kind — every figure it shows arrived over the bridge from the main
 * process, which is where all fetching happens. Stating that here means a
 * script that somehow reached the page still cannot send anything anywhere.
 *
 * Two directives name the loopback origin from main/embeds.js and nothing else:
 * frames for the embedded widgets and images for news artwork. Script stays
 * 'self'. A widget runs in its own document on its own origin and can no more
 * reach into this one than any other website could.
 *
 * THE POLICY IS STAMPED ON THE APPLICATION'S OWN DOCUMENTS AND ON NOTHING ELSE.
 * Stamping it on every response put it on the third-party widget's document too,
 * which blocked that document's own inline scripts — the widget then loaded its
 * whole bundle and drew nothing at all, with no error anywhere in this
 * application. A frame from another origin is isolated by the browser; it is not
 * this application's document to police.
 */
function hardenSession(embedOrigin) {
  const frameSrc = embedOrigin ? embedOrigin : "'none'";
  const imgSrc = "'self' data: blob:" + (embedOrigin ? ' ' + embedOrigin : '');

  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    'img-src ' + imgSrc,
    "font-src 'self'",
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    'frame-src ' + frameSrc,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!/^file:\/\//i.test(details.url || '')) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: Object.assign({}, details.responseHeaders, {
        'Content-Security-Policy': [policy],
        'X-Content-Type-Options': ['nosniff']
      })
    });
  });

  /* The interface asks for no device permissions. Refusing them all outright is
     simpler to reason about than deciding case by case. */
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}
