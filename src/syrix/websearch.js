'use strict';
/* Web search and page reading, without an account or a key.
 *
 * The research assistant is not limited to markets — it answers ordinary
 * questions too, and an assistant that cannot look anything up is a language
 * model guessing out loud. This is how it looks things up.
 *
 * THREE ENGINES, FIRST ONE THAT ANSWERS WINS. They are tried in order rather
 * than merged: three engines' idea of the same ten pages says less than one
 * engine's, not more, and merging them mostly produces duplicates wearing
 * different titles. Wikipedia is queried alongside rather than instead, because
 * it answers a different kind of question and answers it with a citable article.
 *
 * NO BOT-DEFENCE HANDLING. If an engine puts up a challenge it is recorded as
 * blocked and the next one is tried. Nothing here works around a control.
 *
 * Every result carries the URL it came from, because an answer built on a page
 * has to be able to name the page.
 */

const http = require('../core/http');

const MAX_PER_DOMAIN = 2;
const MAX_RESULTS = 8;

function decodeEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (m, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (m, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/* One engine wraps every result in its own redirect. Unwrapping it matters:
   left alone, every source in an answer reports as that engine's domain rather
   than as the site the words actually came from. */
function unwrap(href) {
  const raw = String(href || '');
  const match = raw.match(/[?&]uddg=([^&]+)/);
  if (match) {
    try { return decodeURIComponent(match[1]); } catch (e) { return raw; }
  }
  if (raw.startsWith('//')) return 'https:' + raw;
  return raw;
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return null; }
}

function usable(url) {
  if (!/^https?:\/\//i.test(url)) return false;
  const domain = domainOf(url);
  if (!domain) return false;
  /* An engine's own help and settings pages are not results. */
  return !/^(duckduckgo\.com|bing\.com|go\.microsoft\.com|r\.search\.yahoo\.com)$/i.test(domain);
}

/* Keep the list varied. Ten pages from one site is one source, and an answer
   built on it is a single-source answer wearing a bibliography. */
function diversify(results) {
  const counts = Object.create(null);
  const out = [];
  results.forEach(result => {
    const domain = domainOf(result.url);
    if (!domain) return;
    counts[domain] = (counts[domain] || 0) + 1;
    if (counts[domain] > MAX_PER_DOMAIN) return;
    if (out.some(existing => existing.url === result.url)) return;
    out.push(result);
  });
  return out.slice(0, MAX_RESULTS);
}

/* ---------- engines ---------- */

/* The class attribute on a result block is a LIST — "links_main links_deep
   result__body" — so the marker is matched anywhere inside it rather than as
   the whole value. Anchoring on `class="result__body"` matched nothing at all,
   silently, and every search fell through to the next engine. */
async function duckduckgo(query) {
  const res = await http.text('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
    cacheMs: 10 * 60 * 1000,
    accept: 'text/html'
  });

  const out = [];
  res.data.split(/class="[^"]*result__body[^"]*"/).slice(1).forEach(block => {
    const link = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) return;
    const url = unwrap(decodeEntities(link[1]));
    if (!usable(url)) return;
    const snippet = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    out.push({
      url,
      title: stripTags(link[2]),
      snippet: snippet ? stripTags(snippet[1]) : '',
      engine: 'duckduckgo'
    });
  });
  return out;
}

/* An independent crawler with its own index, so it is a genuinely different
 * answer rather than the same one relabelled.
 *
 * The obvious alternative — a large engine's RSS endpoint — was tried and
 * rejected: asked who the prime minister is, it returned four pages about
 * Amazon Prime Video. An engine that answers a different question to the one
 * asked is worse than no fallback, because the assistant would cite it. */
async function mojeek(query) {
  const res = await http.text('https://www.mojeek.com/search?q=' + encodeURIComponent(query), {
    cacheMs: 10 * 60 * 1000,
    accept: 'text/html'
  });

  const out = [];
  res.data.split(/<li class="r\d+">/).slice(1).forEach(block => {
    const link = block.match(/<a class="title"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) return;
    const url = decodeEntities(link[1]);
    if (!usable(url)) return;
    const snippet = block.match(/<p class="s">([\s\S]*?)<\/p>/);
    out.push({
      url,
      title: stripTags(link[2]),
      snippet: snippet ? stripTags(snippet[1]) : '',
      engine: 'mojeek'
    });
  });
  return out;
}

const ENGINES = [duckduckgo, mojeek];

async function search(query, options) {
  const text = String(query || '').trim();
  if (text.length < 2) return { query: text, results: [], engine: null, note: 'That is too short to search for.' };

  const opts = options || {};
  const attempts = [];

  for (const engine of ENGINES) {
    try {
      const found = await engine(text);
      if (found.length) {
        return {
          query: text,
          engine: found[0].engine,
          results: diversify(found).slice(0, opts.limit || MAX_RESULTS),
          attempts
        };
      }
      attempts.push({ engine: engine.name, outcome: 'no results' });
    } catch (err) {
      attempts.push({ engine: engine.name, outcome: err.kind || 'error', message: err.message });
    }
  }

  return {
    query: text,
    engine: null,
    results: [],
    attempts,
    /* Said plainly, because "no results" and "every engine refused us" are
       different facts and only one of them is about the question. */
    note: 'No search engine answered. ' + attempts.map(a => a.engine + ': ' + a.outcome).join('; ')
  };
}

/* ---------- Wikipedia ---------- */

/* Queried directly rather than through an engine: it answers definitional and
   biographical questions with one citable article instead of ten pages that
   each quote it. */
async function wikipedia(topic) {
  const text = String(topic || '').trim();
  if (!text) return null;

  try {
    const found = await http.json(
      'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=1&srsearch=' +
      encodeURIComponent(text), { cacheMs: 24 * 60 * 60 * 1000 });

    const first = found.data && found.data.query && found.data.query.search && found.data.query.search[0];
    if (!first) return null;

    const summary = await http.json(
      'https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(first.title.replace(/ /g, '_')),
      { cacheMs: 24 * 60 * 60 * 1000 });

    const page = summary.data;
    if (!page || !page.extract) return null;

    return {
      title: page.title,
      extract: page.extract,
      url: (page.content_urls && page.content_urls.desktop && page.content_urls.desktop.page) ||
        'https://en.wikipedia.org/wiki/' + encodeURIComponent(first.title.replace(/ /g, '_')),
      /* Wikipedia is a tertiary source that changes. When the answer was
         written matters as much as what it said. */
      retrievedAt: summary.at,
      source: 'Wikipedia'
    };
  } catch (err) {
    return null;
  }
}

/* ---------- reading a page ---------- */

/* Pull the readable prose out of a page.
 *
 * A narrowed region is kept ONLY if it holds most of the page's prose. An
 * earlier version of this idea in another project matched a content div whose
 * non-greedy close landed a few sentences in, returned 585 characters of a
 * 6,000-character page, and the model — given almost nothing to read — invented
 * the rest. Falling back to the whole body is far better than confidently
 * returning a fragment. */
async function readPage(url, options) {
  const opts = options || {};
  if (!usable(url)) throw new Error('That is not a readable web address.');

  const res = await http.text(url, {
    cacheMs: opts.cacheMs == null ? 30 * 60 * 1000 : opts.cacheMs,
    accept: 'text/html,application/xhtml+xml',
    timeout: 20000
  });

  let html = res.data;

  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];

  /* Everything that is not prose. */
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ');

  const whole = stripTags(html);

  let best = whole;
  const article = html.match(/<article[\s\S]*?<\/article>/i) || html.match(/<main[\s\S]*?<\/main>/i);
  if (article) {
    const narrowed = stripTags(article[0]);
    if (narrowed.length > whole.length * 0.4) best = narrowed;
  }

  const limit = opts.limit || 6000;
  return {
    url,
    title: title ? stripTags(title) : domainOf(url),
    domain: domainOf(url),
    text: best.slice(0, limit),
    truncated: best.length > limit,
    length: best.length,
    retrievedAt: res.at,
    cached: res.cached
  };
}

module.exports = { search, wikipedia, readPage, domainOf, stripTags, unwrap, usable, diversify };
