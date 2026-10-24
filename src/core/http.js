'use strict';
/* The only place in this application that talks to the internet.
 *
 * Everything upstream goes through here so that five rules hold everywhere,
 * rather than in whichever provider adapter happened to remember them.
 *
 *   1. WE IDENTIFY OURSELVES. A real User-Agent naming the application with a
 *      contact route — never a copied browser string. If a source wants to
 *      identify or block this client it must be able to see what it is.
 *      Every source this application uses was tested with the honest agent and
 *      answered normally, so there is no capability argument for spoofing:
 *      market chart data, symbol search, exchange delayed quotes, crypto
 *      exchanges, SEC EDGAR, the IMF flow service, aircraft positions and every
 *      news feed all returned 200. SEC's access policy requires a contact
 *      address in the agent, and supplying one is a condition of use.
 *
 *   2. WE ARE POLITE, PER HOST. One or two requests at a time with a measured
 *      minimum gap. The gaps in HOST_LIMITS are not guesses; see that table.
 *
 *   3. WE BACK OFF WHEN TOLD TO. A 429 puts the host in a cooldown that grows
 *      with repetition. Retrying at full speed through a rate limit is how a
 *      free public source becomes an unavailable one.
 *
 *   4. WE CACHE ON DISK, INCLUDING FAILURES. A cache that can miss must record
 *      the miss, or a failing source is retried at network speed by every
 *      caller that wants it.
 *
 *   5. WE DO NOT WORK AROUND BOT DEFENCES. No CAPTCHA handling, no headless
 *      browser to get past a challenge. A host that puts up a challenge is
 *      recorded as blocked and the application continues without it, visibly.
 *
 * Cookies are held only for hosts that need a session to serve their own public
 * API, and only in memory. See COOKIE_HOSTS.
 */

const fs = require('fs');
const path = require('path');
const { slugHash } = require('./util');
const brand = require('./brand');

const DEFAULT_TIMEOUT = 20000;
const MAX_BODY = 12 * 1024 * 1024;

/* Per-host manners.
 *
 * `gap` is the minimum milliseconds between two request starts to that host;
 * `concurrency` is how many may be in flight at once.
 *
 * The market data host's figure is measured, not chosen: thirteen requests
 * fired back to back all returned 429, and the same thirteen paced at 1.4s all
 * returned 200. 1200ms with a single slot sits inside that, and every caller
 * reaching this host is cached, so a populated workspace makes far fewer
 * requests than it has figures on screen.
 *
 * The filings host publishes a documented ceiling of ten requests per second;
 * two slots at 150ms stays well inside it.
 *
 * The aircraft host grants a small daily allowance to unauthenticated callers,
 * so it is deliberately the slowest entry here and its responses are cached for
 * far longer than the others. */
const HOST_LIMITS = {
  'query1.finance.yahoo.com': { gap: 1200, concurrency: 1 },
  'query2.finance.yahoo.com': { gap: 1200, concurrency: 1 },
  'feeds.finance.yahoo.com': { gap: 1500, concurrency: 1 },
  'fc.yahoo.com': { gap: 1200, concurrency: 1 },
  'data.sec.gov': { gap: 150, concurrency: 2 },
  'www.sec.gov': { gap: 150, concurrency: 2 },
  'efts.sec.gov': { gap: 200, concurrency: 1 },
  'cdn.cboe.com': { gap: 300, concurrency: 2 },
  'api.binance.com': { gap: 200, concurrency: 2 },
  'fapi.binance.com': { gap: 200, concurrency: 2 },
  'api.exchange.coinbase.com': { gap: 250, concurrency: 2 },
  'www.okx.com': { gap: 300, concurrency: 1 },
  'api.bybit.com': { gap: 300, concurrency: 1 },
  'api.kraken.com': { gap: 400, concurrency: 1 },
  'services9.arcgis.com': { gap: 500, concurrency: 1 },
  'opensky-network.org': { gap: 10000, concurrency: 1 },
  'meri.digitraffic.fi': { gap: 1000, concurrency: 1 },
  'data-api.ecb.europa.eu': { gap: 500, concurrency: 1 },
  'api.fiscaldata.treasury.gov': { gap: 500, concurrency: 1 },
  'news.google.com': { gap: 1000, concurrency: 1 },
  /* The charting vendor's own hosts. Undocumented endpoints that its public
     website uses, so they are read sparingly, cached hard and never depended on:
     every caller degrades to a stated absence rather than an empty panel. The
     worldwide news service is the busiest of them and gets the widest gap. */
  'scanner.tradingview.com': { gap: 900, concurrency: 1 },
  'news-mediator.tradingview.com': { gap: 1200, concurrency: 1 },
  'news-headlines.tradingview.com': { gap: 800, concurrency: 2 },
  's3-symbol-logo.tradingview.com': { gap: 120, concurrency: 4 },
  /* A worldwide news index that is free and keyless and answers slowly — thirty
     seconds is normal for a broad query, so callers give it room. */
  'api.gdeltproject.org': { gap: 2500, concurrency: 1 },
  /* News feeds. Read a few times an hour at most and cached between reads, so
     a wide gap costs nothing and keeps this application a well behaved guest on
     publishers that serve their feed from the same origin as their site. */
  'finance.yahoo.com': { gap: 1500, concurrency: 1 },
  'feeds.a.dj.com': { gap: 2000, concurrency: 1 },
  'feeds.bbci.co.uk': { gap: 2000, concurrency: 1 }
};

const DEFAULT_LIMIT = { gap: 800, concurrency: 1 };

/* An unlisted host defaults to one request at a time, 800ms apart — right
   for a data API this application has no explicit manners for yet, where
   hammering it risks a ban. A publisher's image CDN carries none of that
   risk: it is serving a static thumbnail, not metering a rate-limited feed,
   and a news page can hold a dozen of them from the same host. Binary
   fetches fall back to this instead, unless the host has its own explicit
   entry in HOST_LIMITS, which always wins. */
const IMAGE_DEFAULT_LIMIT = { gap: 60, concurrency: 6 };

function limitsFor(host, fallback) {
  return HOST_LIMITS[host] || fallback || DEFAULT_LIMIT;
}

/* Hosts whose own public endpoints require a session cookie before they will
   answer.
 *
 * This layer holds the jar in memory. One provider persists its own session —
 * see src/market/providers/yahoo.js — because the token that accompanies the
 * cookie comes from an endpoint that rate limits harshly enough to make a
 * per-launch handshake unaffordable. That cookie is an anonymous session
 * identifier tied to no account and grants no access beyond the public
 * endpoints this application already calls; a provider wanting to persist one
 * restores it here through setCookies. Nothing else on this list is stored. */
const COOKIE_HOSTS = new Set(['fc.yahoo.com', 'query1.finance.yahoo.com', 'query2.finance.yahoo.com']);
const COOKIE_GROUP = 'yahoo';

const cookies = Object.create(null);   // group -> "name=value; name=value"

function cookieGroupFor(host) {
  return COOKIE_HOSTS.has(host) ? COOKIE_GROUP : null;
}

function rememberCookies(host, response) {
  const group = cookieGroupFor(host);
  if (!group) return;
  let list = [];
  try { list = response.headers.getSetCookie ? response.headers.getSetCookie() : []; } catch (e) { list = []; }
  if (!list.length) return;
  const jar = Object.create(null);
  String(cookies[group] || '').split('; ').forEach(pair => {
    const at = pair.indexOf('=');
    if (at > 0) jar[pair.slice(0, at)] = pair.slice(at + 1);
  });
  list.forEach(raw => {
    const first = String(raw).split(';')[0];
    const at = first.indexOf('=');
    if (at > 0) jar[first.slice(0, at).trim()] = first.slice(at + 1).trim();
  });
  cookies[group] = Object.keys(jar).map(k => k + '=' + jar[k]).join('; ');
}

function cookieHeader(host) {
  const group = cookieGroupFor(host);
  return group && cookies[group] ? cookies[group] : null;
}

function clearCookies(group) {
  delete cookies[group || COOKIE_GROUP];
}

/* Restore a jar captured in an earlier run. Rejected unless it looks like a
   cookie header, so a corrupt config file cannot inject arbitrary text into
   every outgoing request to that host group. */
function setCookies(host, value) {
  const group = cookieGroupFor(host) || (host === COOKIE_GROUP ? COOKIE_GROUP : null);
  if (!group) return false;
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > 4000 || /[\r\n]/.test(text) || !/^[^=;]+=/.test(text)) return false;
  cookies[group] = text;
  return true;
}

/* ---------- pacing ---------- */

let cacheDir = null;
const lastStart = Object.create(null);   // host -> timestamp
const active = Object.create(null);      // host -> in-flight count
const waiting = Object.create(null);     // host -> [resolve]
const cooldown = Object.create(null);    // host -> { until, strikes }

const stats = { requests: 0, cacheHits: 0, errors: 0, rateLimited: 0, bytes: 0, byHost: Object.create(null) };

function setCacheDir(dir) {
  cacheDir = dir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* reported at first write */ }
}

function hostOf(url) {
  try { return new URL(url).host; } catch (e) { return 'unknown'; }
}

/* A slot per host, taken before the request and always released after it in a
   finally. A leaked slot deadlocks that host for the life of the process, and
   the symptom is an application that simply stops updating one asset class. */
async function acquire(host, fallback) {
  const { concurrency, gap } = limitsFor(host, fallback);

  if ((active[host] || 0) >= concurrency) {
    await new Promise(resolve => {
      (waiting[host] || (waiting[host] = [])).push(resolve);
    });
  }
  active[host] = (active[host] || 0) + 1;

  const cool = cooldown[host];
  if (cool && cool.until > Date.now()) {
    await new Promise(r => setTimeout(r, cool.until - Date.now()));
  }

  const since = Date.now() - (lastStart[host] || 0);
  if (since < gap) await new Promise(r => setTimeout(r, gap - since));
  lastStart[host] = Date.now();
}

function release(host) {
  active[host] = Math.max(0, (active[host] || 1) - 1);
  const queue = waiting[host];
  if (queue && queue.length) queue.shift()();
}

async function politely(host, run, fallback) {
  await acquire(host, fallback);
  try {
    return await run();
  } finally {
    release(host);
  }
}

/* Growing pause after a refusal, reset by the next success. The steps are
   deliberately long: a source that has just said "too many" is not helped by
   being asked again in two seconds. */
const BACKOFF = [5000, 15000, 45000, 120000, 300000];

function penalise(host) {
  const current = cooldown[host] || { strikes: 0 };
  const strikes = Math.min(current.strikes + 1, BACKOFF.length);
  cooldown[host] = { strikes, until: Date.now() + BACKOFF[strikes - 1] };
  stats.rateLimited++;
  return BACKOFF[strikes - 1];
}

function forgive(host) {
  if (cooldown[host]) delete cooldown[host];
}

/* ---------- cache ---------- */

function cachePath(key) {
  return cacheDir ? path.join(cacheDir, slugHash(key) + '.json') : null;
}

function readCache(key, maxAgeMs) {
  const file = cachePath(key);
  if (!file) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw.at !== 'number') return null;
    /* A remembered failure gets a much shorter life than a remembered success:
       long enough to stop a retry storm, short enough that a source coming back
       up is noticed within a minute or two. */
    const life = raw.error ? Math.min(maxAgeMs, 90000) : maxAgeMs;
    if (Date.now() - raw.at > life) return null;
    return raw;
  } catch (e) {
    return null;
  }
}

function writeCache(key, value) {
  const file = cachePath(key);
  if (!file) return;
  try { fs.writeFileSync(file, JSON.stringify(value)); } catch (e) { /* a slower app, not a broken one */ }
}

/* ---------- errors ---------- */

class HttpError extends Error {
  constructor(message, status, kind) {
    super(message);
    this.name = 'HttpError';
    this.status = status || 0;
    /* A small fixed vocabulary rather than whatever the host said, because the
       data-health panel and the integrity checks both switch on this value. */
    this.kind = kind || 'error';
  }
}

const CHALLENGE = /cf-browser-verification|challenge-platform|_Incapsula_|Just a moment\.\.\.|Enable JavaScript and cookies to continue|px-captcha|requires JavaScript to verify your browser/i;

function classify(status, body) {
  if (status === 401 || status === 403) {
    return CHALLENGE.test(body || '') ? 'blocked' : 'auth';
  }
  if (status === 429) return 'rate-limited';
  if (status === 404 || status === 410) return 'gone';
  if (status >= 500) return 'unavailable';
  return 'error';
}

/* A challenge page can arrive with a 200. Detecting it matters because the
   alternative is parsing the challenge as if it were data and reporting an
   empty result, which reads as "there is nothing here" rather than "we were
   turned away". */
function looksLikeChallenge(body) {
  return CHALLENGE.test(String(body || '').slice(0, 4000));
}

/* ---------- the request ---------- */

/* HOSTS THAT TAKE LONGER THAN TEN SECONDS TO ANSWER THE TELEPHONE.
 *
 * The platform's own fetch gives a connection ten seconds to be established and
 * that ceiling is not adjustable through it. One source here — a worldwide
 * article index, free, keyless and genuinely irreplaceable for news outside the
 * English-speaking press — regularly takes longer than that to complete its
 * handshake from this machine. Every attempt failed identically at 10.7 seconds
 * with a connect timeout, while the same request through the platform's older
 * client succeeded in the same conditions. That is a limit of the client, not of
 * the source, and it was worth one alternative transport rather than losing the
 * source.
 *
 * Everything else about the request is unchanged: same manners, same cooldown,
 * same cache, same honest agent. Only the socket differs. */
const SLOW_TO_CONNECT = new Set(['api.gdeltproject.org']);

function viaNode(url, headers, opts) {
  const https = require('https');
  const zlib = require('zlib');
  const { URL } = require('url');

  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch (e) { return reject(new Error('Not a usable address.')); }

    const req = https.request({
      method: opts.method || 'GET',
      hostname: target.hostname,
      path: target.pathname + target.search,
      headers,
      timeout: opts.timeout || DEFAULT_TIMEOUT
    }, res => {
      /* One hop, and only to the same scheme. This transport serves a single
         known host; anything trying to send it somewhere else is refused rather
         than followed. */
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && !opts.noRedirect) {
        res.resume();
        const next = new URL(res.headers.location, url);
        if (next.protocol !== 'https:') return reject(new Error('Refused a redirect away from https.'));
        return viaNode(next.href, headers, Object.assign({}, opts, { noRedirect: true })).then(resolve, reject);
      }

      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size <= MAX_BODY) chunks.push(chunk);
      });
      res.on('end', () => {
        let body = Buffer.concat(chunks);
        const encoding = String(res.headers['content-encoding'] || '');
        try {
          if (/gzip/.test(encoding)) body = zlib.gunzipSync(body);
          else if (/deflate/.test(encoding)) body = zlib.inflateSync(body);
          else if (/br/.test(encoding)) body = zlib.brotliDecompressSync(body);
        } catch (e) { /* served compressed and undecodable; the text below will fail the parse */ }
        resolve({ status: res.statusCode, body: body.toString('utf8') });
      });
    });

    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', err => reject(err.message === 'timeout'
      ? Object.assign(new Error('timeout'), { name: 'AbortError' })
      : err));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function request(url, options) {
  const opts = options || {};
  const host = hostOf(url);
  const key = (opts.cacheKey || url) + '|' + (opts.headerKey || '');
  const maxAge = opts.cacheMs == null ? 15 * 60 * 1000 : opts.cacheMs;

  if (maxAge > 0) {
    const hit = readCache(key, maxAge);
    if (hit) {
      stats.cacheHits++;
      if (hit.error) throw new HttpError(hit.error, hit.status, hit.kind);
      return { body: hit.body, status: hit.status, cached: true, at: hit.at };
    }
  }

  return politely(host, async () => {
    const controller = new AbortController();
    const timeout = opts.timeout || DEFAULT_TIMEOUT;
    const timer = setTimeout(() => controller.abort(), timeout);

    stats.requests++;
    stats.byHost[host] = (stats.byHost[host] || 0) + 1;

    const headers = Object.assign({
      'User-Agent': opts.userAgent || brand.userAgent,
      'Accept': opts.accept || 'application/json, text/html;q=0.9, */*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.9',
      /* Required outright by at least one upstream, which answers 406 with a
         plain-English refusal when it is missing rather than sending data. */
      'Accept-Encoding': 'gzip, deflate'
    }, opts.headers || {});

    const jar = cookieHeader(host);
    if (jar && !headers.Cookie) headers.Cookie = jar;

    const slow = SLOW_TO_CONNECT.has(host);

    let response;
    let body = '';
    try {
      if (slow) {
        const answered = await viaNode(url, headers, { method: opts.method, body: opts.body, timeout });
        response = { status: answered.status, ok: answered.status >= 200 && answered.status < 300, headers: null };
        body = answered.body;
      } else {
        response = await fetch(url, {
          method: opts.method || 'GET',
          headers,
          body: opts.body || undefined,
          redirect: 'follow',
          signal: controller.signal
        });
      }
    } catch (err) {
      clearTimeout(timer);
      stats.errors++;
      const kind = err && err.name === 'AbortError' ? 'timeout' : 'network';
      const message = kind === 'timeout'
        ? host + ' did not answer within ' + Math.round(timeout / 1000) + 's.'
        : 'Could not reach ' + host + '.';
      if (maxAge > 0) writeCache(key, { at: Date.now(), error: message, status: 0, kind });
      throw new HttpError(message, 0, kind);
    }
    clearTimeout(timer);

    if (!slow) {
      rememberCookies(host, response);
      try { body = await response.text(); } catch (e) { body = ''; }
    }
    if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY);
    stats.bytes += body.length;

    if (response.status === 429) {
      const paused = penalise(host);
      stats.errors++;
      const message = host + ' is rate limiting this client. Paused for ' + Math.round(paused / 1000) + 's.';
      /* Deliberately not cached: the next caller should wait behind the
         cooldown and then get real data, not inherit this refusal. */
      throw new HttpError(message, 429, 'rate-limited');
    }

    if (!response.ok) {
      stats.errors++;
      const kind = classify(response.status, body);
      const message = host + ' answered ' + response.status + '.';
      if (maxAge > 0) writeCache(key, { at: Date.now(), error: message, status: response.status, kind });
      throw new HttpError(message, response.status, kind);
    }

    if (looksLikeChallenge(body)) {
      stats.errors++;
      const message = host + ' served a bot challenge instead of data. This application does not ' +
        'work around challenges, so this source is unavailable.';
      if (maxAge > 0) writeCache(key, { at: Date.now(), error: message, status: response.status, kind: 'blocked' });
      throw new HttpError(message, response.status, 'blocked');
    }

    forgive(host);
    if (maxAge > 0) writeCache(key, { at: Date.now(), body, status: response.status });
    return { body, status: response.status, cached: false, at: Date.now() };
  });
}

/* The same manners, for something that is not text.
 *
 * Artwork on a headline and a company's mark are images, and an image cannot be
 * read back as a string without corrupting it. This path shares the politeness,
 * the cooldown and the honest agent with every other request and differs in
 * three ways: no disk cache, because the caller holds these in memory and
 * briefly; no challenge sniffing, because a challenge page fails the content
 * type check below instead; and an unlisted host paces to IMAGE_DEFAULT_LIMIT
 * rather than DEFAULT_LIMIT, since a publisher's image CDN is not the kind of
 * rate-limited API the conservative default exists to protect against. */
async function binary(url, options) {
  const opts = options || {};
  const host = hostOf(url);

  return politely(host, async () => {
    const controller = new AbortController();
    const timeout = opts.timeout || DEFAULT_TIMEOUT;
    const timer = setTimeout(() => controller.abort(), timeout);

    stats.requests++;
    stats.byHost[host] = (stats.byHost[host] || 0) + 1;

    let response;
    try {
      response = await fetch(url, {
        headers: Object.assign({
          'User-Agent': opts.userAgent || brand.userAgent,
          'Accept': opts.accept || '*/*'
        }, opts.headers || {}),
        redirect: 'follow',
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timer);
      stats.errors++;
      throw new HttpError('Could not reach ' + host + '.', 0,
        err && err.name === 'AbortError' ? 'timeout' : 'network');
    }
    clearTimeout(timer);

    if (response.status === 429) {
      const paused = penalise(host);
      stats.errors++;
      throw new HttpError(host + ' is rate limiting this client. Paused for ' +
        Math.round(paused / 1000) + 's.', 429, 'rate-limited');
    }
    if (!response.ok) {
      stats.errors++;
      throw new HttpError(host + ' answered ' + response.status + '.', response.status,
        classify(response.status, ''));
    }

    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim();
    if (opts.expect && contentType.indexOf(opts.expect) !== 0) {
      stats.errors++;
      throw new HttpError(host + ' answered with ' + (contentType || 'no content type') +
        ' where ' + opts.expect + ' was expected.', response.status, 'parse');
    }

    const body = Buffer.from(await response.arrayBuffer());
    const cap = opts.maxBytes || 3 * 1024 * 1024;
    if (body.length > cap) {
      throw new HttpError(host + ' sent ' + body.length + ' bytes, past the ' + cap + ' byte ceiling.',
        response.status, 'too-large');
    }
    stats.bytes += body.length;
    forgive(host);

    return { body, contentType, status: response.status, at: Date.now() };
  }, IMAGE_DEFAULT_LIMIT);
}

async function json(url, options) {
  const res = await request(url, Object.assign({ accept: 'application/json' }, options || {}));
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch (e) {
    throw new HttpError('Expected JSON from ' + hostOf(url) + ' and received something else.', res.status, 'parse');
  }
  /* The retrieval time travels with the payload. Every figure in this
     application carries the moment it was fetched, and losing it here would
     mean reconstructing it later from a guess. */
  return { data: parsed, at: res.at, cached: res.cached, status: res.status };
}

async function text(url, options) {
  const res = await request(url, options);
  return { data: res.body, at: res.at, cached: res.cached, status: res.status };
}

function snapshot() {
  return {
    requests: stats.requests,
    cacheHits: stats.cacheHits,
    errors: stats.errors,
    rateLimited: stats.rateLimited,
    bytes: stats.bytes,
    byHost: Object.assign({}, stats.byHost),
    cooling: Object.keys(cooldown)
      .filter(h => cooldown[h].until > Date.now())
      .map(h => ({ host: h, until: cooldown[h].until, strikes: cooldown[h].strikes }))
  };
}

function resetStats() {
  stats.requests = 0; stats.cacheHits = 0; stats.errors = 0; stats.rateLimited = 0; stats.bytes = 0;
  stats.byHost = Object.create(null);
}

module.exports = {
  request, json, text, binary,
  setCacheDir, snapshot, resetStats,
  clearCookies, cookieHeader, setCookies,
  HttpError, hostOf, limitsFor
};
