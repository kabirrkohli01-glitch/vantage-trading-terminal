'use strict';
/* The request handlers behind the bridge.
 *
 * Two rules hold for every handler here.
 *
 *   THE SENDER IS VERIFIED. A handler only runs for a window this application
 *   created. Without the check, any frame that reached the process could call
 *   these.
 *
 *   FAILURES COME BACK AS DATA, NOT AS THROWN OBJECTS. Rejecting an invoke
 *   wraps the message in framework text, so the interface would show
 *   "Error invoking remote method" where it should show what actually went
 *   wrong. Every call resolves with an envelope and the interface renders the
 *   message it is given.
 */

const { ipcMain } = require('electron');

function install(context) {
  const { windows, services } = context;

  const handle = (channel, handler) => {
    ipcMain.handle(channel, async (event, payload) => {
      if (!windows.owns(event.sender)) {
        return { ok: false, error: 'That window is not part of this application.' };
      }
      try {
        return { ok: true, data: await handler(payload || {}, event) };
      } catch (err) {
        /* The provider layer already writes messages meant to be read by a
           person; passing them through unchanged is the point. */
        return {
          ok: false,
          error: String((err && err.message) || err),
          kind: (err && err.kind) || 'error',
          degraded: !!(err && err.degraded)
        };
      }
    });
  };

  /* ---------- application ---------- */

  handle('app:info', () => services.info());
  handle('app:health', () => services.health());
  handle('audit:recent', payload => services.audit.recent(Math.min(Number(payload.limit) || 100, 500)));

  /* ---------- market ---------- */

  handle('market:quote', payload => services.engine.quote(payload.symbol, { force: !!payload.force }));

  handle('market:quotes', async payload => {
    const symbols = (payload.symbols || []).slice(0, 200);
    /* Subscribing rather than fetching one by one lets the engine batch and
       coalesce; peek then returns whatever has landed without triggering more
       requests. */
    services.engine.subscribe(symbols);
    await services.engine.cycle();
    return symbols.map(s => services.engine.peek(s)).filter(Boolean);
  });

  handle('market:chart', payload => services.engine.chart(payload.symbol, {
    range: payload.range,
    interval: payload.interval,
    limit: payload.limit,
    from: payload.from,
    to: payload.to,
    extended: payload.extended
  }));

  handle('market:search', payload => services.search(payload.query, { limit: payload.limit }));
  handle('market:intervals', payload => services.engine.intervalsFor(payload.symbol));
  handle('market:fundamentals', payload => services.engine.fundamentals(payload.symbol));
  handle('market:reference', payload => services.engine.reference(payload.symbol));
  handle('market:peers', payload => services.engine.peers(payload.symbol, { limit: payload.limit }));
  handle('market:sectors', payload => services.engine.sectors(payload.region));
  handle('market:screen', payload => services.screen(payload));
  handle('market:logos', payload => services.logos(payload.symbols));
  handle('market:insider', payload => require('../src/market/providers/sec').insider(payload.symbol, { limit: payload.limit }));
  handle('market:filings', payload => require('../src/market/providers/sec').filings(payload.symbol, { limit: payload.limit || 6 }));

  handle('market:news', payload => services.newsForSymbol(payload.symbol, { limit: payload.limit }));
  handle('news:market', payload => services.newsFront({ feeds: payload.feeds, limit: payload.limit }));
  handle('news:search', payload => services.newsSearch(payload.query, { limit: payload.limit, anyLanguage: !!payload.anyLanguage }));
  handle('news:article', payload => services.newsArticle(payload.url));

  /* The address of an embedded surface. The renderer names one and passes
     settings; it never composes the address itself. */
  handle('embed:url', payload => services.embedUrl(payload.kind, payload.config));
  handle('market:verify', payload => services.engine.verify(payload.symbol));
  handle('market:sources', payload => services.engine.provenanceFor(payload.symbol));

  handle('market:subscribe', payload => {
    services.engine.subscribe(payload.symbols || []);
    return { subscribed: services.engine.subscribed().length };
  });

  handle('market:unsubscribe', payload => {
    services.engine.unsubscribe(payload.symbols || []);
    return { subscribed: services.engine.subscribed().length };
  });

  /* ---------- workspace ---------- */

  handle('watchlist:list', () => services.watchlists());
  handle('watchlist:save', payload => services.saveWatchlist(payload.list));
  handle('watchlist:remove', payload => services.removeWatchlist(payload.id));

  handle('alert:list', () => services.alerts());
  handle('alert:save', payload => services.saveAlert(payload.alert));
  handle('alert:remove', payload => services.removeAlert(payload.id));
  handle('alert:rearm', payload => services.rearmAlert(payload.id));

  handle('theme:get', () => services.theme());
  handle('theme:save', payload => services.saveTheme(payload.theme));

  /* Two different things are restored on start-up and both come back here: the
     window arrangement, which the main process owns, and the workspace — saved
     drawings, the active watchlist — which the interface owns. */
  handle('layout:get', () => ({
    windows: windows.readLayout(),
    workspace: services.stores.config.doc('workspace', {})
  }));
  handle('layout:save', payload => {
    if (payload.workspace) services.stores.config.putDoc('workspace', payload.workspace);
    return true;
  });
  handle('layout:displays', () => windows.displays());

  /* The selected instrument is workspace state, not window state. Holding it in
     the main process and echoing it to the other windows is what lets a chart
     on the second monitor follow a selection made on the first. The window that
     made the choice is skipped: it has already moved. */
  handle('workspace:select', (payload, event) => {
    const symbol = services.select(payload.symbol);
    windows.broadcast('workspace:symbol', { symbol }, event.sender.id);
    services.audit.write('instrument.opened', { symbol });
    return { symbol };
  });

  /* Which screen — for the assistant's context only, never broadcast: a
     detached panel on another monitor is not necessarily looking at the
     same one, and nothing about it needs to be. */
  handle('workspace:view', payload => ({ view: services.setView(payload.view) }));
  handle('layout:detach', payload => windows.detach(payload.panel, {
    symbol: payload.symbol,
    displayId: payload.displayId,
    bounds: payload.bounds,
    title: payload.title
  }));

  /* ---------- portfolio ---------- */

  handle('portfolio:value', payload => services.valueBook(payload.book || 'mirror'));
  handle('portfolio:transactions', payload => services.transactions(payload.book || 'mirror'));
  handle('portfolio:add', payload => services.addTransaction(payload.transaction));
  handle('portfolio:remove', payload => services.removeTransaction(payload.id));

  /* ---------- journal ---------- */

  handle('journal:read', payload => services.journalFor(payload.book || 'mirror'));
  handle('journal:annotate', payload => services.journal.annotate(payload.key, payload.note));
  handle('journal:reattach', payload => services.journal.reattach(payload.from, payload.to));

  /* ---------- paper trading ---------- */

  handle('paper:state', payload => services.paperState(payload.symbol));
  handle('paper:preview', payload => services.previewOrder(payload.order));
  handle('paper:place', payload => services.placeOrder(payload.order));
  handle('paper:cancel', payload => services.cancelOrder(payload.id));
  handle('paper:reset', () => services.resetPaper());

  /* ---------- research assistant ---------- */

  handle('syrix:status', () => services.gateway.status());
  handle('syrix:pair', payload => services.gateway.pair(payload.code, payload.label));
  handle('syrix:disconnect', () => services.gateway.disconnect());

  handle('syrix:ask', payload => {
    const question = String(payload.question || '').trim();
    if (!question) throw new Error('Ask something first.');
    return services.conversation.ask(question, {
      brief: !!payload.brief,
      /* Three states, not two. Undefined lets the loop decide from the question
         whether the council is warranted; true and false are the operator
         overriding that either way. */
      council: payload.council === undefined ? undefined : !!payload.council,
      attachments: (payload.attachments || []).slice(0, 8)
    });
  });

  /* Files handed to the assistant. The bytes arrive base64 encoded because that
     is what survives the bridge; nothing is written outside the upload
     directory and the stored name is generated rather than taken from the file. */
  handle('syrix:upload', payload => services.addUpload({
    name: payload.name, mime: payload.mime, data: payload.data
  }));
  handle('syrix:documents', () => services.listUploads());
  handle('syrix:forget', payload => services.removeUpload(payload.id));

  /* Polled by the interface while an answer is being written. The whole job
     crosses the bridge; the device token is never part of it. */
  handle('syrix:job', payload => {
    const job = services.conversation.job(payload.id);
    if (!job) throw new Error('That question is no longer in progress.');
    return job;
  });

  handle('syrix:reset', () => services.conversation.reset());
  handle('syrix:stop', payload => services.conversation.stop(payload.id));

  /* Past conversations. Metadata for the list, the full transcript only for
     the one actually opened, so switching to a conversation the operator has
     not asked for costs nothing. */
  handle('syrix:conversations', () => services.conversation.conversations());
  handle('syrix:conversation', payload => services.conversation.open(payload.id));
  /* True deletion — nothing here is recoverable once asked for, which is
     what "delete" means when the operator asks for it plainly. */
  handle('syrix:conversation:delete', payload => services.conversation.forget(payload.id));
  handle('syrix:conversation:pin', payload => services.conversation.pin(payload.id, !!payload.pinned));

  /* ---------- window controls ---------- */

  /* The window is frameless, so minimise, maximise and close are the
     application's own buttons rather than the system's. */
  const windowOf = event => {
    const { BrowserWindow } = require('electron');
    return BrowserWindow.fromWebContents(event.sender);
  };

  handle('window:minimize', (payload, event) => {
    const win = windowOf(event);
    if (win) win.minimize();
    return true;
  });

  handle('window:maximize', (payload, event) => {
    const win = windowOf(event);
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
    return win.isMaximized();
  });

  handle('window:close', (payload, event) => {
    const win = windowOf(event);
    if (win) win.close();
    return true;
  });

  handle('window:state', (payload, event) => {
    const win = windowOf(event);
    return { maximized: win ? win.isMaximized() : false, focused: win ? win.isFocused() : false };
  });

  /* ---------- pushes ---------- */

  /* Price updates are fanned out to every window rather than polled by each
     one, so ten panels showing the same instrument cost one request and one
     message. */
  services.engine.onUpdate(models => {
    windows.broadcast('market:update', models.map(m => ({
      symbol: m.symbol,
      name: m.name,
      assetClass: m.assetClass,
      currency: m.currency,
      priceHint: m.priceHint,
      isYield: m.isYield,
      quote: m.quote,
      freshness: m.freshness,
      warnings: m.warnings,
      provenance: m.provenance
    })));
  });

  services.safeMode.onChange(state => windows.broadcast('market:safemode', state));

  /* An alert fires inside the evaluation that happens on every arriving
     quote (main/services.js), not here — this only carries the result to
     every window so the bell in the title bar and the alerts screen learn
     about it without polling for it. */
  services.alertBook.onFired(fired => windows.broadcast('alert:fired', fired));

  /* A WINDOW THAT IS OLDER THAN THE CODE ON DISK SAYS SO.
   *
   * Nothing else in this application caused as much wasted effort as not
   * knowing this: a change would be made, the window would be looked at, and
   * the change would not be there — because the window had been open since
   * before it. From the outside that is indistinguishable from a change that
   * was never made, and there was no way to tell the two apart. The window now
   * carries the stamp it was built from and is told when the files move past
   * it. */
  const builtAt = services.buildStamp();
  const watch = setInterval(() => {
    let onDisk;
    try { onDisk = services.buildOnDisk(); } catch (err) { return; }
    if (onDisk > builtAt) {
      windows.broadcast('app:stale', { builtAt, onDisk });
    }
  }, 20000);
  if (watch.unref) watch.unref();
}

module.exports = { install };
