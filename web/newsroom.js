'use strict';
/* The newsroom.
 *
 * WHAT THIS REPLACED. A list of headlines with a publisher and an age beside
 * each one. Everything in it was true and none of it was a front page: no
 * pictures, no lead story, no way to search for a subject rather than an
 * instrument, and opening a headline threw the operator out into a browser.
 *
 * What a front page does, and what this does:
 *
 *   IT LEADS. The most recent story with artwork is given the width and the
 *   picture, and everything else arranges around it, so the screen has a shape
 *   before a word of it is read.
 *
 *   IT IS SEARCHABLE BY SUBJECT. A keyword goes to a worldwide index rather than
 *   to a ticker lookup, so "lithium", "the Bank of England" and "SOFI" are all
 *   answerable, and stories come back from publishers in any country.
 *
 *   IT READS IN PLACE. A story opens into a reader with its text. Where a
 *   publisher will not serve the article to anything but a browser, the reader
 *   says so with the publisher named and offers the link out. It never shows
 *   three sentences of cookie policy as though it were the story.
 *
 * NOTHING A PUBLISHER WROTE IS RENDERED AS MARKUP. Headlines and article text
 * arrive as text, having been stripped in the main process, and are escaped
 * again here. Pictures are loaded from the loopback origin rather than from the
 * publisher, so nothing on this page makes a request to anybody's server.
 */

(function () {

  const clock = window.T.clock;

  let ctx = null;
  function install(context) { ctx = context; }

  const esc = text => String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const state = {
    mode: 'front',          // front | search | instrument
    query: '',
    desk: 'all',
    front: null,
    results: null,
    article: null,
    loading: false,
    /* Which request is the current one. An answer that arrives after the
       operator has searched for something else is discarded rather than painted
       over the top of what they are looking at now. */
    token: 0
  };

  /* ---------- loading ---------- */

  async function loadFront(force) {
    if (state.front && !force) return state.front;
    const token = ++state.token;
    state.loading = true;
    paint();
    try {
      const result = await ctx.call('news:market', { limit: 140 });
      if (token !== state.token) return null;
      state.front = result;
      state.mode = 'front';
    } catch (err) {
      if (token !== state.token) return null;
      state.front = { items: [], feeds: [], unavailable: [], error: err.message };
    }
    state.loading = false;
    paint();
    return state.front;
  }

  async function search(query) {
    const text = String(query || '').trim();
    if (!text) { state.mode = 'front'; state.query = ''; paint(); return; }

    const token = ++state.token;
    state.query = text;
    state.mode = 'search';
    state.loading = true;
    state.results = null;
    paint();

    try {
      const result = await ctx.call('news:search', { query: text, limit: 60 });
      if (token !== state.token) return;
      state.results = result;
    } catch (err) {
      if (token !== state.token) return;
      state.results = { items: [], unavailable: [], error: err.message };
    }
    state.loading = false;
    paint();
  }

  async function forInstrument(symbol) {
    const token = ++state.token;
    state.mode = 'instrument';
    state.query = symbol;
    state.loading = true;
    state.results = null;
    paint();

    try {
      const result = await ctx.call('market:news', { symbol, limit: 40 });
      if (token !== state.token) return;
      state.results = result;
    } catch (err) {
      if (token !== state.token) return;
      state.results = { items: [], error: err.message };
    }
    state.loading = false;
    paint();
  }

  async function openArticle(url, fallback) {
    const token = ++state.token;
    state.article = { loading: true, url, fallback: fallback || null };
    paint();

    try {
      const article = await ctx.call('news:article', { url });
      if (token !== state.token) return;
      state.article = Object.assign({ loading: false, fallback: fallback || null }, article);
    } catch (err) {
      if (token !== state.token) return;
      state.article = {
        loading: false, url, available: false, fallback: fallback || null,
        reason: err.message
      };
    }
    paint();
  }

  function closeArticle() {
    state.article = null;
    paint();
  }

  /* ---------- drawing ---------- */

  function items() {
    const source = state.mode === 'front'
      ? (state.front && state.front.items) || []
      : (state.results && state.results.items) || [];
    if (state.mode !== 'front' || state.desk === 'all') return source;
    return source.filter(item => item.feed === state.desk);
  }

  function age(at) {
    if (!at) return '';
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return Math.round(seconds / 60) + 'm ago';
    if (seconds < 86400) return Math.round(seconds / 3600) + 'h ago';
    return clock.asOf(at);
  }

  /* THE SECTION, NOT THE RAIL BUTTON.
   *
   * The rail button that opens this screen also carries data-view="news", and it
   * comes first in the document — so a bare attribute selector returns the
   * button and the whole newsroom was being written into it. On screen that read
   * as the front page bleeding through the left-hand rail, with the screen
   * itself blank. Every screen that draws itself must qualify the selector with
   * the class that only the section has. */
  function paint() {
    const root = document.querySelector('.view[data-view="news"]');
    if (!root) return;
    root.innerHTML = html();
  }

  function html() {
    const list = items();
    const lead = list.find(item => item.image) || list[0] || null;
    const rest = list.filter(item => item !== lead);

    return bar() +
      '<div class="screen-body newsroom">' +
      (state.loading && !list.length ? '<div class="loading">Reading the wires…</div>' : '') +
      unavailableHtml() +
      (list.length ? leadHtml(lead) + gridHtml(rest.slice(0, 24)) + latestHtml(rest.slice(24, 70)) : emptyHtml()) +
      '</div>' +
      (state.article ? readerHtml() : '');
  }

  function bar() {
    const desks = (state.front && state.front.feeds) || [];
    return '<div class="screen-bar newsroom-bar">' +
      '<span class="screen-title">Newsroom</span>' +
      '<div class="news-search">' +
      '<svg class="glass"><use href="#i-search"></use></svg>' +
      '<input id="news-query" type="text" spellcheck="false" autocomplete="off" ' +
      'placeholder="Search the world — a company, a ticker, a commodity, a person…" ' +
      'value="' + esc(state.mode === 'search' ? state.query : '') + '">' +
      '<button class="btn" data-act="news-search">Search</button>' +
      '</div>' +
      '<span class="tb-spacer"></span>' +
      (state.mode !== 'front'
        ? '<button class="btn" data-act="news-front">Back to the front page</button>'
        : '<button class="icon-btn" data-act="news-refresh" title="Reload the wires"><svg><use href="#i-refresh"></use></svg></button>') +
      '</div>' +
      (state.mode === 'front' && desks.length ? deskStrip(desks) : subtitle());
  }

  function deskStrip(desks) {
    return '<div class="desk-strip">' +
      '<button class="desk' + (state.desk === 'all' ? ' on' : '') + '" data-act="news-desk" data-desk="all">All</button>' +
      desks.map(desk => '<button class="desk' + (state.desk === desk.id ? ' on' : '') +
        '" data-act="news-desk" data-desk="' + esc(desk.id) + '">' + esc(desk.label) + '</button>').join('') +
      '</div>';
  }

  function subtitle() {
    if (state.mode === 'search') {
      const found = state.results ? state.results.items.length : 0;
      return '<div class="desk-strip"><span class="news-note">' +
        (state.loading ? 'Searching worldwide for “' + esc(state.query) + '”…'
          : found + ' stor' + (found === 1 ? 'y' : 'ies') + ' matching “' + esc(state.query) + '”') +
        '</span></div>';
    }
    if (state.mode === 'instrument') {
      return '<div class="desk-strip"><span class="news-note">Headlines for ' + esc(state.query) + '</span></div>';
    }
    return '';
  }

  function unavailableHtml() {
    const source = state.mode === 'front' ? state.front : state.results;
    const missing = (source && source.unavailable) || [];
    const error = source && source.error;
    if (!missing.length && !error) return '';

    return '<div class="news-missing">' +
      (error ? esc(error) + ' ' : '') +
      (missing.length ? 'Not answering right now: ' +
        missing.map(entry => esc(entry.label || entry.id)).join(', ') +
        '. What is below is everything that did answer.' : '') +
      '</div>';
  }

  function emptyHtml() {
    if (state.loading) return '';
    return '<div class="empty">' +
      (state.mode === 'search'
        ? 'Nothing came back for “' + esc(state.query) + '”. Try a company name, a ticker or a subject.'
        : 'No headline arrived. Every feed either failed or is empty, which is unusual — check the network.') +
      '</div>';
  }

  function pictureHtml(item, className) {
    if (!item.image) return '';
    /* A picture that fails to load removes itself. A broken image icon in the
       middle of a front page reads as a fault in the application rather than as
       a publisher's server being slow. */
    return '<div class="' + className + '"><img src="' + esc(item.image) + '" alt="" loading="lazy" ' +
      'data-act="news-open" data-url="' + esc(item.link || '') + '"></div>';
  }

  function leadHtml(item) {
    if (!item) return '';
    return '<article class="news-lead" data-act="news-open" data-url="' + esc(item.link || '') + '">' +
      pictureHtml(item, 'lead-art') +
      '<div class="lead-text">' +
      '<div class="news-meta"><span class="publisher">' + esc(item.publisher || item.feedLabel || '') + '</span>' +
      '<span class="dot-sep"></span><span class="age">' + esc(age(item.publishedAt)) + '</span>' +
      (item.country ? '<span class="dot-sep"></span><span class="country">' + esc(item.country) + '</span>' : '') +
      '</div>' +
      '<h2 class="lead-headline">' + esc(item.title) + '</h2>' +
      (item.summary ? '<p class="lead-summary">' + esc(item.summary) + '</p>' : '') +
      '</div></article>';
  }

  function gridHtml(list) {
    if (!list.length) return '';
    return '<div class="news-grid">' + list.map(item =>
      '<article class="news-card' + (item.image ? '' : ' textual') + '" data-act="news-open" data-url="' +
        esc(item.link || '') + '">' +
      pictureHtml(item, 'card-art') +
      '<div class="card-text">' +
      '<div class="news-meta"><span class="publisher">' + esc(item.publisher || item.feedLabel || '') + '</span>' +
      '<span class="dot-sep"></span><span class="age">' + esc(age(item.publishedAt)) + '</span></div>' +
      '<h3 class="card-headline">' + esc(item.title) + '</h3>' +
      (item.summary ? '<p class="card-summary">' + esc(item.summary) + '</p>' : '') +
      '</div></article>').join('') + '</div>';
  }

  function latestHtml(list) {
    if (!list.length) return '';
    return '<section class="news-latest">' +
      '<div class="section-label">Also on the wire</div>' +
      '<div class="wire">' + list.map(item =>
        '<button class="wire-row" data-act="news-open" data-url="' + esc(item.link || '') + '">' +
        '<span class="wire-age">' + esc(age(item.publishedAt)) + '</span>' +
        '<span class="wire-title">' + esc(item.title) + '</span>' +
        '<span class="wire-publisher">' + esc(item.publisher || item.feedLabel || '') + '</span>' +
        '</button>').join('') + '</div></section>';
  }

  /* ---------- the reader ---------- */

  function readerHtml() {
    const article = state.article;

    const head = '<div class="reader-head">' +
      '<button class="icon-btn" data-act="news-close" title="Close"><svg><use href="#i-close"></use></svg></button>' +
      '<span class="tb-spacer"></span>' +
      (article.url ? '<button class="btn" data-act="news-ask">Ask SYRIX about this</button>' +
        '<a class="btn" href="' + esc(article.url) + '" target="_blank" rel="noopener noreferrer">Open at the publisher</a>' : '') +
      '</div>';

    if (article.loading) {
      return '<div class="reader-back" data-act="news-close-outside"><div class="reader" data-act="news-stay">' + head +
        '<div class="loading">Fetching the article…</div></div></div>';
    }

    const fallback = article.fallback || {};
    const body = article.available
      ? '<article class="reader-body">' +
        (article.image ? '<img class="reader-art" src="' + esc(article.image) + '" alt="">' : '') +
        '<h1>' + esc(article.title || fallback.title || 'Untitled') + '</h1>' +
        '<div class="news-meta">' +
        '<span class="publisher">' + esc(article.domain || '') + '</span>' +
        (article.byline ? '<span class="dot-sep"></span><span>' + esc(article.byline) + '</span>' : '') +
        (article.publishedAt ? '<span class="dot-sep"></span><span>' + esc(clock.asOf(article.publishedAt)) + '</span>' : '') +
        '</div>' +
        article.paragraphs.map(paragraph => '<p>' + esc(paragraph) + '</p>').join('') +
        '</article>'
      : '<div class="reader-body">' +
        '<h1>' + esc(fallback.title || article.title || 'That article could not be read here') + '</h1>' +
        (fallback.summary ? '<p class="lead-summary">' + esc(fallback.summary) + '</p>' : '') +
        '<div class="reader-refused">' + esc(article.reason || 'The publisher did not serve the article.') +
        '</div></div>';

    return '<div class="reader-back" data-act="news-close-outside"><div class="reader" data-act="news-stay">' + head + body + '</div></div>';
  }

  /* ---------- events, owned here ---------- */

  /* The actions the screen's own controls dispatch. Returned as a table so the
     interface can fold them into its single dispatcher rather than this file
     attaching listeners of its own. */
  function actions() {
    return {
      'news-search': () => {
        const box = document.getElementById('news-query');
        search(box ? box.value : '');
      },
      'news-front': () => { state.mode = 'front'; state.query = ''; paint(); },
      'news-refresh': () => loadFront(true),
      'news-desk': data => { state.desk = data.desk; paint(); },
      'news-open': data => {
        const url = data.url;
        if (!url) return;
        const item = items().find(entry => entry.link === url);
        /* A source whose links are redirects this application cannot follow
           opens outside, and says so rather than showing an empty reader. */
        if (item && item.external) {
          ctx.openExternally(url);
          return;
        }
        openArticle(url, item || null);
      },
      'news-close': closeArticle,
      /* A PRESS ON THE BACKDROP CLOSES THE READER; A PRESS ON THE READER DOES
         NOT. The dispatcher walks up from whatever was pressed to the nearest
         control, so without something to stop it, every press inside the reader
         would find the backdrop behind it and close the article being read. The
         reader carries a control of its own that does nothing, which is what
         stops the walk. */
      'news-close-outside': closeArticle,
      'news-stay': () => {},
      'news-ask': () => {
        const article = state.article;
        if (!article) return;
        const title = article.title || (article.fallback && article.fallback.title) || 'this article';
        const body = article.available && article.text
          ? article.text.slice(0, 6000)
          : (article.fallback && article.fallback.summary) || '';
        closeArticle();
        ctx.askAssistant(
          'Read this and tell me what it means for the market and for anything I hold.\n\n' +
          'HEADLINE: ' + title + '\n' +
          (article.domain ? 'PUBLISHER: ' + article.domain + '\n' : '') +
          (body ? '\n' + body : '\n(The body could not be fetched — work from the headline and say so.)'));
      }
    };
  }

  window.T = window.T || {};
  window.T.newsroom = {
    install, actions, paint, state,
    loadFront, search, forInstrument, openArticle, closeArticle, age
  };

}());
