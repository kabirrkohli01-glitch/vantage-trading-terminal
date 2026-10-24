'use strict';
/* The news reader and the reference-data readers.
 *
 * Both of these parse somebody else's document. A feed is written by a
 * publisher and a summary payload is written by a data vendor, and neither is
 * under any obligation to be consistent. Every fixture below is a shape that
 * really is served: entities encoded twice, CDATA around a headline, an Atom
 * entry whose address lives in an attribute, a numeric field arriving as a
 * wrapped object, a date arriving in seconds.
 *
 * Nothing here touches the network. The readers are driven against captured
 * markup so a failing feed cannot fail the suite and a passing suite cannot
 * depend on a publisher's mood.
 */

const news = require('../src/market/providers/news');
const { pickNumber, pickText, pickDate, firstDate } = require('../src/market/engine');

const SOURCE = { id: 'test', label: 'Test feed' };

function rss(items) {
  return '<?xml version="1.0"?><rss version="2.0"><channel>' +
    '<title>A Publisher</title><link>https://example.com</link>' +
    items.join('') + '</channel></rss>';
}

function run(t) {
  const { suite, ok, eq } = t;

  /* ============ reading a feed ============ */
  console.log('\nNews — somebody else\'s document, parsed rather than trusted');

  suite('an ordinary RSS item yields its headline, address, publisher and time', () => {
    const items = news.parseFeed(rss([
      '<item><title>Chip maker raises guidance</title>' +
      '<link>https://example.com/one</link>' +
      '<description>The company lifted its outlook for the year.</description>' +
      '<pubDate>Tue, 25 Aug 2026 09:30:00 GMT</pubDate></item>'
    ]), SOURCE);

    eq(items.length, 1);
    eq(items[0].title, 'Chip maker raises guidance');
    eq(items[0].link, 'https://example.com/one');
    eq(items[0].summary, 'The company lifted its outlook for the year.');
    eq(items[0].publishedAt, Date.parse('Tue, 25 Aug 2026 09:30:00 GMT'));
    eq(items[0].feed, 'test');
  });

  suite('a headline wrapped in CDATA is read as text, not as markup', () => {
    const items = news.parseFeed(rss([
      '<item><title><![CDATA[Profits <b>double</b> at the bank]]></title>' +
      '<link>https://example.com/two</link></item>'
    ]), SOURCE);
    eq(items[0].title, 'Profits double at the bank');
  });

  suite('an attribute on the opening tag does not hide the element', () => {
    /* A bare `<title>` matcher misses `<title type="html">`, which is what
       several publishers send, and the whole item is then dropped. */
    const items = news.parseFeed(
      '<feed><entry><title type="html">Rates held again</title>' +
      '<link rel="alternate" href="https://example.com/three"/>' +
      '<updated>2026-08-25T08:00:00Z</updated></entry></feed>', SOURCE);
    eq(items.length, 1);
    eq(items[0].title, 'Rates held again');
    eq(items[0].link, 'https://example.com/three', 'Atom puts the address in an attribute');
    eq(items[0].publishedAt, Date.parse('2026-08-25T08:00:00Z'));
  });

  suite('the publisher\'s own markup never reaches the interface', () => {
    const items = news.parseFeed(rss([
      '<item><title>Markets close higher</title>' +
      '<description>&lt;p&gt;Shares rose.&lt;/p&gt;&lt;img src="https://tracker.example/px.gif"&gt;' +
      '&lt;script&gt;alert(1)&lt;/script&gt;</description>' +
      '<link>https://example.com/four</link></item>'
    ]), SOURCE);

    eq(items[0].summary, 'Shares rose.');
    ok(items[0].summary.indexOf('<') === -1, 'no tag survives');
    ok(items[0].summary.indexOf('alert') === -1, 'the script contents go with the tag');
    ok(items[0].summary.indexOf('tracker.example') === -1, 'the tracking image goes too');
  });

  suite('entities are decoded, including the doubly encoded ones publishers send', () => {
    eq(news.decodeEntities('AT&amp;T'), 'AT&T');
    eq(news.decodeEntities('AT&amp;amp;T'), 'AT&T', 'encoded twice, decoded twice');
    eq(news.decodeEntities('&quot;quoted&quot;'), '"quoted"');
    eq(news.decodeEntities('&#8212;'), '—');
    eq(news.decodeEntities('&#x2014;'), '—');
  });

  suite('decoding stops before it can rebuild a tag', () => {
    /* Two passes, deliberately, and no more. A loop that ran to a fixed point
       would unwrap this all the way back to a live script tag, and the whole
       point of stripping markup would be undone by the decoder that follows
       it. */
    const out = news.decodeEntities('&amp;amp;lt;script&amp;amp;gt;');
    ok(out.indexOf('<script') === -1, 'a tag is not reconstructed from layers of encoding');
  });

  suite('a headline with no title is dropped rather than shown blank', () => {
    const items = news.parseFeed(rss([
      '<item><link>https://example.com/five</link></item>',
      '<item><title>Real headline</title><link>https://example.com/six</link></item>'
    ]), SOURCE);
    eq(items.length, 1);
    eq(items[0].title, 'Real headline');
  });

  suite('a description carrying the whole article is trimmed to a summary', () => {
    const long = 'word '.repeat(200);
    const items = news.parseFeed(rss([
      '<item><title>Long one</title><description>' + long + '</description></item>'
    ]), SOURCE);
    ok(items[0].summary.length <= 320, 'a list of headlines is not a reader');
    ok(/…$/.test(items[0].summary), 'and it says it was cut');
  });

  suite('a missing date is not treated as a missing story', () => {
    const items = news.parseFeed(rss([
      '<item><title>Undated</title><link>https://example.com/seven</link></item>'
    ]), SOURCE);
    eq(items.length, 1);
    eq(items[0].publishedAt, null);
  });

  /* ============ ordering and deduplication ============ */

  suite('headlines are newest first and anything undated sinks', () => {
    const ordered = news.order([
      { title: 'a', publishedAt: 1000 },
      { title: 'b', publishedAt: null },
      { title: 'c', publishedAt: 3000 },
      { title: 'd', publishedAt: 2000 }
    ]);
    eq(ordered.map(i => i.title).join(''), 'cdab',
      'an undated item must not float to the top of a list sorted by date');
  });

  suite('the same story syndicated to three feeds appears once', () => {
    const out = news.dedupe([
      { title: 'Bank of England holds rates', link: 'https://a.example/x?utm_source=1' },
      { title: 'Bank of England holds rates!', link: 'https://b.example/y?utm_source=2' },
      { title: 'BANK OF ENGLAND HOLDS RATES', link: 'https://c.example/z' },
      { title: 'Something else entirely', link: 'https://d.example/w' }
    ]);
    eq(out.length, 2, 'punctuation and case are not different stories');
    eq(out[0].title, 'Bank of England holds rates', 'the first arrival is the one kept');
  });

  suite('an empty feed is empty rather than an error', () => {
    eq(news.parseFeed(rss([]), SOURCE).length, 0);
    eq(news.parseFeed('', SOURCE).length, 0);
    eq(news.parseFeed(null, SOURCE).length, 0);
  });

  suite('one hanging feed cannot hold the whole front page to the transport default', () => {
    /* market() asks every feed in parallel and waits on all of them
       settling. A publisher that hangs rather than refuses — several of
       these are known to, for a client that is not a browser — used to
       hold the entire front page to the transport's 20s default while
       nine other feeds had already answered. Failing fast here is the
       degrade the design already intends: a slow source becomes one line
       in `unavailable`, not a 20-second wait for everyone else's news too. */
    ok(news.FEED_TIMEOUT_MS > 0 && news.FEED_TIMEOUT_MS <= 10000,
      'got ' + news.FEED_TIMEOUT_MS + 'ms — well under a 20s transport default');
  });

  /* ============ reference data ============ */
  console.log('\nReference data — the vendor\'s shape does not leave the engine');

  suite('a number is read from raw whether or not it was wrapped', () => {
    eq(pickNumber({ raw: 1234.5, fmt: '1.23k' }), 1234.5);
    eq(pickNumber(42), 42);
    eq(pickNumber(0), 0, 'zero is a figure, not a missing one');
  });

  suite('the vendor\'s pre-formatted string is never what is shown', () => {
    /* `fmt` is rounded and localised by somebody else. Letting one through
       would put a figure on screen that this application's formatter never saw
       and whose precision it cannot state. */
    eq(pickNumber({ fmt: '1.23T' }), null, 'a value with no raw is a missing value');
    eq(pickText({ raw: 29600, fmt: '29.6k', longFmt: '29,600' }), null);
  });

  suite('an absent figure reads as absent rather than as nought', () => {
    eq(pickNumber(null), null);
    eq(pickNumber(undefined), null);
    eq(pickNumber({}), null, 'the vendor sends an empty object for "no value"');
    eq(pickNumber({ raw: 'Infinity' }), null);
    eq(pickNumber('12'), null, 'a number arriving as text is not silently coerced');
  });

  suite('text is trimmed and an empty string is nothing', () => {
    eq(pickText('  Semiconductors  '), 'Semiconductors');
    eq(pickText(''), null);
    eq(pickText('   '), null);
    eq(pickText(7), null);
  });

  suite('dates arrive in seconds and leave in milliseconds', () => {
    eq(pickDate({ raw: 1787000000 }), 1787000000000);
    eq(pickDate({ raw: 1787000000000 }), 1787000000000, 'already in milliseconds is left alone');
    eq(pickDate({ raw: 0 }), null, 'the epoch is how this vendor says "never"');
    eq(pickDate(null), null);
  });

  suite('an earnings window yields its first date, and an empty one yields none', () => {
    eq(firstDate([{ raw: 1787000000 }, { raw: 1787600000 }]), 1787000000000);
    eq(firstDate([]), null);
    eq(firstDate(undefined), null);
  });
}

module.exports = { run };
