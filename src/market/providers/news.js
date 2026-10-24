'use strict';
/* News: keyless RSS.
 *
 * Every feed here is public, needs no key and no account, and is read with the
 * same politeness and the same honest user agent as every other source.
 *
 * THE FEED IS PARSED, NOT RENDERED. A headline arrives as markup — entities,
 * CDATA sections, and in the description a paragraph of the publisher's own
 * HTML including tracking images and links. None of that reaches the interface.
 * Tags are stripped and entities are decoded here, so what crosses the bridge
 * is text, and the interface escapes it again on the way in. Two independent
 * defences, because a headline is the one thing on this screen written by
 * somebody else.
 *
 * WHAT A HEADLINE IS NOT. It is not a figure. Nothing in this file is checked
 * for integrity, cross-checked or badged as live, because there is no number in
 * it to check. What every item does carry is its publisher and the moment it
 * was published, so an operator can see that the story explaining a move was
 * filed after it.
 */

const http = require('../../core/http');
const instrument = require('../instrument');

const NAME = 'news';
const LABEL = 'Public RSS feeds';

/* Per-instrument. Yahoo's headline feed takes the symbol it already knows and
   answers with that company's stories only. */
const SYMBOL_FEED = 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=';

/* Market-wide, organised as desks rather than as one undifferentiated river, so
   a story can be shown with the desk it came off and a reader can follow one.
 *
 * Which feeds carry artwork was established by reading them rather than by
 * assuming: several publish a picture with every item, one publishes none at
 * all, and a front page built only from the ones with pictures would be a
 * narrower front page than the one built from all of them. So every feed here is
 * read and the ones without artwork are laid out as text stories. */
const MARKET_FEEDS = [
  { id: 'markets', label: 'Markets', url: 'https://finance.yahoo.com/news/rssindex', artwork: true },
  { id: 'wsj', label: 'Wall Street', url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', artwork: false },
  { id: 'mw', label: 'Top stories', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', artwork: true },
  { id: 'cnbc', label: 'Business', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', artwork: false },
  { id: 'investing', label: 'Movers', url: 'https://www.investing.com/rss/news.rss', artwork: true },
  { id: 'ft', label: 'World', url: 'https://www.ft.com/news-feed?format=rss', artwork: false },
  { id: 'bbc', label: 'UK business', url: 'https://feeds.bbci.co.uk/news/business/rss.xml', artwork: true },
  { id: 'fox', label: 'Wire', url: 'https://moxie.foxbusiness.com/google-publisher/markets.xml', artwork: true },
  { id: 'alpha', label: 'Analysis', url: 'https://seekingalpha.com/market_currents.xml', artwork: false },
  { id: 'crypto', label: 'Crypto', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', artwork: true }
];

const CACHE_MS = 4 * 60 * 1000;

/* ---------- reading the markup ---------- */

/* The five XML entities plus the numeric forms. Publishers double-encode
   routinely — "&amp;quot;" for a quotation mark — so the pass is run twice.
   Twice and no more: a loop that ran to a fixed point would happily decode
   "&amp;amp;lt;script&amp;amp;gt;" all the way back to a tag. */
function decodeEntities(text) {
  const once = s => String(s)
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (m, dec) => codePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
  return once(once(text));
}

function codePoint(value) {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return '';
  try {
    return String.fromCodePoint(value);
  } catch (e) {
    return '';
  }
}

function stripTags(text) {
  return String(text)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* The text of one element, whether it was written plainly or wrapped in CDATA.
   Attributes on the opening tag are tolerated because publishers put them
   there — a bare `<title>` matcher misses `<title type="html">`.
 *
 * DECODE FIRST, THEN STRIP, AND NEVER DECODE AGAIN AFTERWARDS. The order is the
 * whole defence. Publishers routinely send their article markup entity-encoded
 * inside the description, so a stripper running first sees no angle brackets,
 * removes nothing, and the decoder behind it then turns "&lt;script&gt;" into a
 * real tag — the markup arrives intact having passed straight through the guard
 * meant to catch it. Decoding first makes those tags visible to the stripper.
 * Decoding again afterwards would reopen the same hole from the other end. */
function tagText(block, name) {
  const match = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + name + '>', 'i').exec(block);
  if (!match) return null;
  let inner = match[1];
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/i.exec(inner);
  if (cdata) inner = cdata[1];
  const text = stripTags(decodeEntities(inner));
  return text || null;
}

/* Atom puts the address in an attribute rather than in the element body. */
function tagLink(block) {
  const plain = tagText(block, 'link');
  if (plain && /^https?:\/\//i.test(plain)) return plain;
  const attr = /<link[^>]*\shref=["']([^"']+)["']/i.exec(block);
  if (attr) return decodeEntities(attr[1]);
  return null;
}

function parseDate(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/* THE PICTURE ON A STORY, AND THE THREE PLACES PUBLISHERS PUT IT.
 *
 * There is no single convention. One publisher uses the media extension's
 * `content` element, one uses its `thumbnail`, one uses RSS's own `enclosure`,
 * and several put an image tag inside the description where the article's own
 * markup was pasted. All four are read here, in the order of how reliable they
 * turned out to be, and the address is returned as an address — never as markup.
 * Nothing a publisher wrote is rendered; the interface is handed a URL and a
 * caption and builds the element itself.
 *
 * A thumbnail's declared width is kept because several feeds publish a 130 pixel
 * version, and a lead story wants to know that before it stretches one across a
 * column. */
const IMAGE_PATTERNS = [
  /<media:content[^>]*\surl=["']([^"']+)["'][^>]*>/i,
  /<media:thumbnail[^>]*\surl=["']([^"']+)["'][^>]*>/i,
  /<enclosure[^>]*\surl=["']([^"']+)["'][^>]*type=["']image\/[^"']*["']/i,
  /<enclosure[^>]*type=["']image\/[^"']*["'][^>]*\surl=["']([^"']+)["']/i,
  /<image[^>]*>\s*<url>([^<]+)<\/url>/i
];

const IMAGE_EXTENSION = /\.(jpe?g|png|webp|gif|avif)(\?|$)/i;

function tagImage(block) {
  for (const pattern of IMAGE_PATTERNS) {
    const match = pattern.exec(block);
    if (match && /^https?:\/\//i.test(match[1])) {
      return { url: decodeEntities(match[1]), width: widthOf(block, match[1]) };
    }
  }

  /* Last resort: the article's own markup pasted into the description. Only an
     address that looks like an image file is taken, because a tracking pixel and
     a picture are the same element to a parser. */
  const description = /<description(?:\s[^>]*)?>([\s\S]*?)<\/description>/i.exec(block);
  if (description) {
    const inner = decodeEntities(description[1]);
    const img = /<img[^>]*\ssrc=["']([^"']+)["']/i.exec(inner);
    if (img && /^https?:\/\//i.test(img[1]) && IMAGE_EXTENSION.test(img[1])) {
      return { url: decodeEntities(img[1]), width: null };
    }
  }
  return null;
}

function widthOf(block, url) {
  const near = new RegExp('url=["\']' + url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    '["\'][^>]*width=["\'](\\d+)["\']', 'i').exec(block);
  if (near) return Number(near[1]);
  const before = new RegExp('width=["\'](\\d+)["\'][^>]*url=["\']' +
    url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').exec(block);
  return before ? Number(before[1]) : null;
}

/* RSS 2.0 and Atom in one reader. They differ in three names and nothing else
   that matters here. */
function parseFeed(xml, source) {
  const body = String(xml || '');
  const feedTitle = tagText(body.slice(0, 4000), 'title');
  const blocks = body.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) || [];

  return blocks.map(block => {
    const title = tagText(block, 'title');
    if (!title) return null;

    const published = parseDate(tagText(block, 'pubDate')) ||
      parseDate(tagText(block, 'published')) ||
      parseDate(tagText(block, 'updated')) ||
      parseDate(tagText(block, 'dc:date'));

    const summary = tagText(block, 'description') || tagText(block, 'summary') || tagText(block, 'content');
    const image = tagImage(block);

    return {
      title,
      link: tagLink(block),
      /* Trimmed rather than shown whole: several publishers put the entire
         article in the description, and a list of headlines is not a reader. */
      summary: summary && summary.length > 320 ? summary.slice(0, 317).trimEnd() + '…' : summary,
      publishedAt: published,
      publisher: tagText(block, 'source') || feedTitle || source.label,
      feed: source.id,
      feedLabel: source.label,
      image: image ? image.url : null,
      imageWidth: image ? image.width : null,
      author: tagText(block, 'dc:creator') || tagText(block, 'author') || null
    };
  }).filter(Boolean);
}

/* ---------- fetching ---------- */

function provenance(url, at, extra) {
  return Object.assign({
    provider: NAME,
    providerLabel: LABEL,
    endpoint: url,
    retrievedAt: at,
    at
  }, extra || {});
}

/* Well under the transport's own 20s default. market() asks for every feed
   in parallel and waits on all of them settling — one publisher that hangs
   rather than refuses (FT and a couple of others are known to, for a
   client that is not a browser) held the whole front page to its timeout
   while nine other feeds had answered in under a second. These are
   redundant sources by design; failing one fast and reporting it in
   `unavailable` is the intended degrade, not a worse outcome than waiting
   for it. */
const FEED_TIMEOUT_MS = 7000;

async function readFeed(source) {
  const res = await http.text(source.url, {
    cacheMs: CACHE_MS, timeout: FEED_TIMEOUT_MS,
    accept: 'application/rss+xml, application/xml, text/xml'
  });
  return {
    items: parseFeed(res.data, source),
    provenance: provenance(source.url, res.at, { cached: res.cached, feed: source.id })
  };
}

/* Newest first, with anything undated last rather than treated as new. A feed
   that omits its dates must not float to the top of a list sorted by date. */
function order(items) {
  return items.slice().sort((a, b) => {
    if (a.publishedAt == null && b.publishedAt == null) return 0;
    if (a.publishedAt == null) return 1;
    if (b.publishedAt == null) return -1;
    return b.publishedAt - a.publishedAt;
  });
}

/* The same story is syndicated to several of these feeds. Matching on the
   address alone misses it, because each feed appends its own tracking
   parameters, so the title carries the comparison and the address only settles
   ties. */
function dedupe(items) {
  const seen = new Map();
  const out = [];
  items.forEach(item => {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key) return;
    const held = seen.get(key);
    if (held) {
      /* The same story reaches several desks and only some of them attach a
         picture. Keeping the first copy and discarding the rest threw the
         artwork away whenever the plainest feed happened to be read first. The
         copy that is kept borrows what the duplicate had and it did not. */
      if (!held.image && item.image) { held.image = item.image; held.imageWidth = item.imageWidth; }
      if (!held.summary && item.summary) held.summary = item.summary;
      return;
    }
    seen.set(key, item);
    out.push(item);
  });
  return out;
}

async function forSymbol(symbol, options) {
  const sym = instrument.normaliseSymbol(symbol);
  if (!sym) throw new Error('Not a usable symbol: ' + symbol);
  const opts = options || {};

  const source = { id: 'symbol', label: sym, url: SYMBOL_FEED + encodeURIComponent(sym) + '&region=US&lang=en-US' };
  const result = await readFeed(source);

  return {
    symbol: sym,
    items: dedupe(order(result.items)).slice(0, opts.limit || 30),
    sources: [result.provenance]
  };
}

/* Every market feed is read at once and one failure does not empty the panel:
   a feed that did not answer is reported by name beside the stories that did
   arrive, so a short list is never mistaken for a quiet day. */
async function market(options) {
  const opts = options || {};
  const wanted = opts.feeds && opts.feeds.length
    ? MARKET_FEEDS.filter(f => opts.feeds.indexOf(f.id) !== -1)
    : MARKET_FEEDS;

  const settled = await Promise.all(wanted.map(async source => {
    try {
      return { ok: true, source, result: await readFeed(source) };
    } catch (err) {
      return { ok: false, source, error: String((err && err.message) || err) };
    }
  }));

  const items = [];
  const sources = [];
  const unavailable = [];

  settled.forEach(entry => {
    if (!entry.ok) { unavailable.push({ feed: entry.source.id, label: entry.source.label, reason: entry.error }); return; }
    items.push(...entry.result.items);
    sources.push(entry.result.provenance);
  });

  if (!items.length && unavailable.length) {
    throw new Error('No news feed answered. ' + unavailable.map(u => u.label + ': ' + u.reason).join('  '));
  }

  return {
    items: dedupe(order(items)).slice(0, opts.limit || 120),
    feeds: MARKET_FEEDS.map(f => ({ id: f.id, label: f.label })),
    unavailable,
    sources
  };
}

module.exports = {
  name: NAME,
  label: LABEL,
  forSymbol, market,
  MARKET_FEEDS, FEED_TIMEOUT_MS,
  /* Exported for the test suite, which drives the reader against captured feed
     markup rather than against the network. */
  parseFeed, decodeEntities, stripTags, dedupe, order, tagImage, readFeed
};
