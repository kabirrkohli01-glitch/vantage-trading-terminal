'use strict';
/* Embedded surfaces in the interface.
 *
 * A chart, a heatmap, a screener and an economic calendar are published by the
 * charting vendor as widgets, and a widget is a script that builds a frame. None
 * of that may run inside this document: it is a local page whose policy forbids
 * remote script, and relaxing that for a widget would relax it for everything
 * else on the page.
 *
 * So each one runs in a frame of its own, on the loopback origin served by
 * main/embeds.js. The frame is cross-origin, which is the point — it cannot
 * reach into this document any more than any other website could.
 *
 * THE ADDRESS IS NEVER COMPOSED HERE. The main process is asked for one by
 * naming a widget and passing settings; it validates both and mints an address
 * carrying a token this page never sees as a value it can build with.
 *
 * A CONFIGURATION IS BAKED INTO THE FRAME'S DOCUMENT, so changing it means a new
 * frame. Rebuilding on every keystroke of a symbol change would flicker, so the
 * mount is debounced and the old frame is kept visible until the new one has
 * loaded underneath it.
 */

(function () {

  let call = null;
  function install(context) { call = context.call; }

  /* container element -> what is currently mounted in it */
  const mounted = new WeakMap();

  function keyOf(kind, config) {
    return kind + '|' + JSON.stringify(config || {});
  }

  /* Put a widget in a container, or leave it alone if the same one is already
     there. Returns a promise that settles when the frame has been created —
     not when the widget inside it has drawn, which this page cannot observe
     across an origin. */
  async function mount(container, kind, config, options) {
    if (!container || !call) return null;
    const opts = options || {};
    const key = keyOf(kind, config);
    const held = mounted.get(container);

    if (held && held.key === key) return held.frame;
    if (held && held.pending === key) return null;

    mounted.set(container, Object.assign({}, held, { pending: key }));

    let answer;
    try {
      answer = await call('embed:url', { kind, config });
    } catch (err) {
      container.innerHTML = '<div class="embed-fault">' + escape(err.message) + '</div>';
      mounted.delete(container);
      return null;
    }

    /* The operator may have moved on while the address was being minted. */
    const current = mounted.get(container);
    if (!current || current.pending !== key) return null;

    const frame = document.createElement('iframe');
    frame.className = 'embed-frame';
    frame.setAttribute('title', opts.title || kind);
    /* Scripts and its own origin: the widget needs both to run. It is a
       different origin from this document either way, so neither gives it any
       reach into the application. Everything else a frame can ask for —
       downloads, top-level navigation, popups, forms — is withheld. */
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('loading', 'eager');

    const previous = current.frame || null;
    frame.addEventListener('load', () => {
      frame.classList.add('ready');
      if (previous && previous.parentNode) previous.remove();
    });

    frame.src = answer.url;
    container.appendChild(frame);
    mounted.set(container, { key, frame, pending: null });
    return frame;
  }

  /* Remount everything in a subtree. The widgets take their palette from their
     configuration rather than from this document, so a theme change means new
     frames — there is no way to restyle one from outside. */
  function retheme(root, theme) {
    const scope = root || document;
    Array.from(scope.querySelectorAll('[data-embed]')).forEach(container => {
      const held = mounted.get(container);
      if (!held) return;
      try {
        const parsed = JSON.parse(held.key.slice(held.key.indexOf('|') + 1));
        const kind = held.key.slice(0, held.key.indexOf('|'));
        if (parsed.colorTheme === theme && parsed.theme === theme) return;
        if (parsed.colorTheme) parsed.colorTheme = theme;
        if (parsed.theme) parsed.theme = theme;
        mount(container, kind, parsed);
      } catch (e) { /* nothing mounted worth rethemeing */ }
    });
  }

  function clear(container) {
    if (!container) return;
    mounted.delete(container);
    container.innerHTML = '';
  }

  function escape(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  window.T = window.T || {};
  window.T.embeds = { install, mount, retheme, clear, keyOf };

}());
