'use strict';
/* Worldwide news by keyword, and reading an article without leaving.
 *
 * The desk feeds in news.js are a front page: whatever the publishers decided
 * mattered this morning. This file answers the other question — "everything
 * being written about SOFI, or about lithium, or about the Bank of England" —
 * which no single feed can answer because no publisher indexes by the thing you
 * are interested in.
 *
 * THREE SOURCES, ASKED TOGETHER, BECAUSE EACH KNOWS SOMETHING THE OTHERS DO NOT.
 *
 *   A worldwide article index, which covers every country and language and
 *   returns the publisher's own address and its social image. It is the only one
 *   here that will find a story in an Indian or Nigerian outlet about a company
 *   listed in New York. It is also slow — thirty seconds for a broad query is
 *   normal — so it is given room and never blocks the others.
 *
 *   A news aggregator's own search, which is fast and ranks well and covers
 *   small publishers. Its links are redirects that resolve in a browser and not
 *   over a plain request, so its stories open outside rather than in the reader.
 *
 *   The price venue's own search, which is the only one that understands that
 *   "SOFI" is a company rather than a word, and attaches the publisher's
 *   artwork.
 *
 * WHAT IS NOT DONE HERE. No source is scraped past its own published feed, no
 * challenge is worked around, and a source that does not answer is named in the
 * result rather than quietly dropped — a short list of stories about a company
 * in trouble should never be mistaken for a quiet week.
 */

const http = require('../../core/http');
const news = require('./news');

const NAME = 'worldnews';
const LABEL = 'Worldwide news index';

const GDELT = 'https://api.gdeltproject.org/api/v2/doc/doc';
const GOOGLE = 'https://news.google.com/rss/search';
const YAHOO_SEARCH = 'https://query1.finance.yahoo.com/v1/finance/search';

const CACHE_SEARCH = 5 * 60 * 1000;
const CACHE_ARTICLE = 60 * 60 * 1000;

function provenance(endpoint, at, extra) {
  return Object.assign({
    provider: NAME, providerLabel: LABEL, endpoint, retrievedAt: at, at
  }, extra || {});
}

/* ---------- keyword search ---------- */

async function search(query, options) {
  const opts = options || {};
  const text = String(query || '').trim();
  if (!text) return { query: '', items: [], unavailable: [], sources: [] };

  const wanted = opts.sources && opts.sources.length
    ? opts.sources
    : ['worldwide', 'aggregator', 'venue'];

  const settled = await Promise.all([
    wanted.indexOf('worldwide') === -1 ? null : run('worldwide', 'The worldwide index', () => fromGdelt(text, opts)),
    wanted.indexOf('aggregator') === -1 ? null : run('aggregator', 'The news aggregator', () => fromGoogle(text, opts)),
    wanted.indexOf('venue') === -1 ? null : run('venue', 'The price venue', () => fromVenue(text, opts))
  ].filter(Boolean));

  const items = [];
  const unavailable = [];
  const sources = [];

  settled.forEach(entry => {
    if (!entry.ok) { unavailable.push({ id: entry.id, label: entry.label, reason: entry.error }); return; }
    items.push(...entry.result.items);
    sources.push(...(entry.result.sources || []));
  });

  return {
    query: text,
    items: news.dedupe(news.order(items)).slice(0, opts.limit || 60),
    unavailable,
    sources
  };
}

async function run(id, label, work) {
  try {
    return { ok: true, id, label, result: await work() };
  } catch (err) {
    return { ok: false, id, label, error: String((err && err.message) || err) };
  }
}

/* The worldwide index. `sourcelang:english` is applied by default because the
   reader is English; a caller wanting everything can turn it off, and then a
   headline in another language arrives as it was filed rather than translated,
   which is honest and occasionally useful. */
async function fromGdelt(text, opts) {
  const query = (opts.anyLanguage ? text : text + ' sourcelang:english');
  const url = GDELT + '?query=' + encodeURIComponent(query) +
    '&mode=artlist&format=json&maxrecords=' + Math.min(Number(opts.limit) || 40, 75) + '&sort=datedesc';

  const res = await http.json(url, { cacheMs: CACHE_SEARCH, timeout: 45000 });
  const articles = (res.data && res.data.articles) || [];

  return {
    items: articles.map(article => ({
      title: cleanTitle(article.title),
      link: article.url,
      summary: null,
      publishedAt: parseStamp(article.seendate),
      publisher: article.domain || 'Unknown',
      country: article.sourcecountry || null,
      language: article.language || null,
      image: article.socialimage || null,
      imageWidth: null,
      feed: 'worldwide',
      feedLabel: 'Worldwide'
    })).filter(item => item.title && item.link),
    sources: [provenance(url, res.at, { cached: res.cached })]
  };
}

/* The index stamps a time as 20260826T133000Z, which Date.parse does not
   understand. Split rather than patched with a regular expression, because the
   shape is fixed and a half-parsed date is worse than none. */
function parseStamp(value) {
  const s = String(value || '');
  if (!/^\d{8}T\d{6}Z$/.test(s)) return null;
  const iso = s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) + 'T' +
    s.slice(9, 11) + ':' + s.slice(11, 13) + ':' + s.slice(13, 15) + 'Z';
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

/* The index returns headlines with the spacing of the page they were scraped
   from, so a title arrives as "Is XRP a Buy , Sell , or Hold Right Now ? ". */
function cleanTitle(value) {
  return String(value || '')
    .replace(/\s+([,.;:!?%])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function fromGoogle(text, opts) {
  const url = GOOGLE + '?q=' + encodeURIComponent(text) + '&hl=en-US&gl=US&ceid=US:en';
  const res = await http.text(url, { cacheMs: CACHE_SEARCH, accept: 'application/rss+xml, application/xml' });
  const items = news.parseFeed(res.data, { id: 'aggregator', label: 'Aggregator' });

  return {
    items: items.slice(0, Number(opts.limit) || 40).map(item => Object.assign({}, item, {
      /* The publisher is appended to the headline by this source and repeated
         in its own element; carrying both puts the name on screen twice. */
      title: item.title.replace(/\s+-\s+[^-]{2,40}$/, ''),
      /* Its links are a redirect this application cannot follow without a
         browser, so a story from here opens outside rather than in the reader,
         and the interface is told that rather than left to discover it. */
      external: true
    })),
    sources: [provenance(url, res.at, { cached: res.cached })]
  };
}

async function fromVenue(text, opts) {
  const url = YAHOO_SEARCH + '?q=' + encodeURIComponent(text) +
    '&newsCount=' + Math.min(Number(opts.limit) || 20, 30) + '&quotesCount=0&enableFuzzyQuery=false';
  const res = await http.json(url, { cacheMs: CACHE_SEARCH });
  const stories = (res.data && res.data.news) || [];

  return {
    items: stories.map(story => ({
      title: story.title,
      link: story.link,
      summary: null,
      publishedAt: story.providerPublishTime ? Number(story.providerPublishTime) * 1000 : null,
      publisher: story.publisher || 'Unknown',
      image: pickThumbnail(story.thumbnail),
      imageWidth: null,
      feed: 'venue',
      feedLabel: 'Markets',
      symbols: (story.relatedTickers || []).slice(0, 8)
    })).filter(item => item.title && item.link),
    sources: [provenance(url, res.at, { cached: res.cached })]
  };
}

/* The venue publishes several sizes. The original is taken where there is one,
   because a lead story is shown large and a 140 pixel square stretched across a
   column looks like a fault. */
function pickThumbnail(thumbnail) {
  const sizes = (thumbnail && thumbnail.resolutions) || [];
  if (!sizes.length) return null;
  const original = sizes.find(s => s.tag === 'original');
  if (original) return original.url;
  return sizes.slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0].url;
}

/* ---------- reading an article ---------- */

/* THE READER TELLS THE TRUTH ABOUT WHAT IT COULD GET.
 *
 * Some publishers serve their article to anyone who asks. Some serve a
 * subscription wall. Some serve a challenge page, which this application does
 * not work around. All three come back as a 200 with a body, and the difference
 * between "here is the article" and "here is a page asking you to subscribe" is
 * not something a parser can be trusted to judge from length alone.
 *
 * So the reader returns what it extracted and says how much of the page that
 * was. A page whose prose is a few hundred characters is reported as
 * unavailable with the publisher named, and the interface offers the headline,
 * the summary and a link out — which is the honest outcome and reads far better
 * than three sentences of cookie policy presented as a news story. */
const MIN_ARTICLE = 600;

async function read(url) {
  const address = String(url || '');
  if (!/^https?:\/\//i.test(address)) throw new Error('That is not a web address.');

  const res = await http.text(address, {
    cacheMs: CACHE_ARTICLE,
    accept: 'text/html,application/xhtml+xml',
    timeout: 25000
  });

  const html = res.data || '';
  const extracted = extract(html);
  const host = http.hostOf(address);

  if (!extracted.text || extracted.text.length < MIN_ARTICLE) {
    return {
      url: address,
      domain: host,
      title: extracted.title,
      image: extracted.image,
      text: null,
      available: false,
      reason: extracted.text
        ? host + ' returned a page with very little text in it, which usually means the article ' +
          'is behind a subscription. The headline and the link are below.'
        : host + ' did not return a readable article.',
      retrievedAt: res.at,
      sources: [provenance(address, res.at, { cached: res.cached })]
    };
  }

  return {
    url: address,
    domain: host,
    title: extracted.title,
    image: extracted.image,
    byline: extracted.byline,
    publishedAt: extracted.publishedAt,
    text: extracted.text,
    paragraphs: extracted.paragraphs,
    available: true,
    retrievedAt: res.at,
    sources: [provenance(address, res.at, { cached: res.cached })]
  };
}

/* Pull the article out of the page.
 *
 * The narrowed region is only kept if it holds most of the page's prose. A
 * container matched by a non-greedy closing tag stops at the first nested one,
 * which on a page of nested containers is a few sentences in — and a few
 * sentences of a real article is exactly the input that produces a confident,
 * wrong summary. Falling back to the whole body is worse writing and better
 * reading. */
function extract(html) {
  const source = String(html || '');

  const title = meta(source, 'og:title') || tagOf(source, 'title') || null;
  const image = meta(source, 'og:image') || null;
  const byline = meta(source, 'author') || meta(source, 'article:author') || null;
  const publishedRaw = meta(source, 'article:published_time') || meta(source, 'datePublished');
  const published = publishedRaw ? Date.parse(publishedRaw) : NaN;

  const whole = paragraphsOf(source);
  const region = /<article[\s\S]*?<\/article>/i.exec(source);
  const narrow = region ? paragraphsOf(region[0]) : [];

  const chosen = narrow.join(' ').length > whole.join(' ').length * 0.4 && narrow.length ? narrow : whole;

  return {
    title: title ? decode(title).trim() : null,
    image,
    byline: byline ? decode(byline).trim() : null,
    publishedAt: Number.isFinite(published) ? published : null,
    paragraphs: chosen,
    text: chosen.join('\n\n')
  };
}

/* Paragraphs, in order, with everything that is not prose removed first.
   Navigation, scripts, styles and forms all contain text and none of it belongs
   in an article. */
function paragraphsOf(html) {
  const stripped = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ')
    .replace(/<figure[\s\S]*?<\/figure>/gi, ' ');

  const blocks = stripped.match(/<p(?:\s[^>]*)?>[\s\S]*?<\/p>/gi) || [];
  return blocks
    .map(block => decode(block.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim())
    /* Below this length a paragraph is a caption, a credit line or a cookie
       notice rather than a sentence of the article. */
    .filter(text => text.length > 45)
    .filter((text, i, all) => all.indexOf(text) === i);
}

function meta(html, property) {
  const patterns = [
    new RegExp('<meta[^>]*(?:property|name)=["\']' + property + '["\'][^>]*content=["\']([^"\']*)["\']', 'i'),
    new RegExp('<meta[^>]*content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + property + '["\']', 'i')
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match && match[1]) return match[1];
  }
  return null;
}

function tagOf(html, name) {
  const match = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + name + '>', 'i').exec(html);
  return match ? match[1] : null;
}

function decode(text) {
  return news.decodeEntities(String(text || ''));
}

module.exports = {
  name: NAME, label: LABEL,
  search, read,
  extract, paragraphsOf, parseStamp, cleanTitle, pickThumbnail, MIN_ARTICLE
};
