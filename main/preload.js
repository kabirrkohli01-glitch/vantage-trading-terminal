'use strict';
/* The bridge between the interface and the application.
 *
 * This is the complete list of things the renderer can do. It runs with context
 * isolation on, so the page cannot reach Node, the filesystem or the network —
 * every capability it has is named below and nothing else exists.
 *
 * CHANNELS ARE ALLOW-LISTED HERE AS WELL AS VALIDATED IN THE MAIN PROCESS.
 * Exposing a general-purpose invoke would let any script that got into the page
 * call anything the main process registers, now or later. Listing them means a
 * new capability is a deliberate edit in two files rather than a side effect of
 * adding a handler.
 */

const { contextBridge, ipcRenderer } = require('electron');

/* Request/response channels. */
const CALLS = [
  'app:info',
  'app:health',

  'market:quote',
  'market:quotes',
  'market:chart',
  'market:search',
  'market:verify',
  'market:sources',
  'market:subscribe',
  'market:unsubscribe',
  'market:intervals',
  'market:fundamentals',
  'market:reference',
  'market:peers',
  'market:sectors',
  'market:screen',
  'market:logos',
  'market:insider',
  'market:filings',
  'market:news',

  'news:market',
  'news:search',
  'news:article',

  'embed:url',

  'watchlist:list',
  'watchlist:save',
  'watchlist:remove',

  'alert:list',
  'alert:save',
  'alert:remove',
  'alert:rearm',

  'portfolio:value',
  'portfolio:transactions',
  'portfolio:add',
  'portfolio:remove',

  'journal:read',
  'journal:annotate',
  'journal:reattach',

  'paper:state',
  'paper:preview',
  'paper:place',
  'paper:cancel',
  'paper:reset',

  'layout:get',
  'layout:save',
  'layout:displays',
  'layout:detach',

  'workspace:select',
  'workspace:view',

  'theme:get',
  'theme:save',

  'syrix:status',
  'syrix:pair',
  'syrix:disconnect',
  'syrix:ask',
  'syrix:job',
  'syrix:reset',
  'syrix:stop',
  'syrix:upload',
  'syrix:documents',
  'syrix:forget',
  'syrix:conversations',
  'syrix:conversation',
  'syrix:conversation:delete',
  'syrix:conversation:pin',

  'audit:recent',

  'window:minimize',
  'window:maximize',
  'window:close',
  'window:state'
];

/* Main-process pushes the renderer may listen for.
 *
 * Kept exactly in step with what is actually broadcast: an event listed here
 * that nothing sends is a listener waiting for a message that will never
 * arrive, which reads as a feature that silently does not work. The
 * architecture suite fails if this list and the broadcasts drift apart. */
const EVENTS = [
  'market:update',
  'market:safemode',
  'displays:changed',
  'workspace:symbol',
  'window:state',
  'app:stale',
  'alert:fired'
];

const params = new URLSearchParams(location.search);

contextBridge.exposeInMainWorld('terminal', {
  /* Which window this is. The main window draws the full workspace; a detached
     one draws a single panel. */
  role: params.get('role') || 'main',
  panel: params.get('panel') || null,
  panelId: params.get('id') || null,
  initialSymbol: params.get('symbol') || null,

  invoke(channel, payload) {
    if (CALLS.indexOf(channel) === -1) {
      return Promise.reject(new Error('Unknown channel: ' + channel));
    }
    return ipcRenderer.invoke(channel, payload);
  },

  /* Returns its own unsubscribe function. A listener left attached to a panel
     that has been closed and reopened is how the same update gets applied
     twice. */
  on(channel, handler) {
    if (EVENTS.indexOf(channel) === -1) throw new Error('Unknown event: ' + channel);
    const wrapped = (event, payload) => handler(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  }
});
