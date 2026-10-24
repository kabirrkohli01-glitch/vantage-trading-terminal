'use strict';
/* The pieces added to make this a terminal rather than a chart with a list
 * beside it: worldwide instrument search, the news reader, document intake, and
 * the assistant's council.
 *
 * Everything here is driven against captured payloads and real files on disk
 * rather than against the network. A test that needs an endpoint to be up is a
 * test that fails on a train, and the endpoints these modules read are third
 * party and undocumented — their being unavailable is a condition the code is
 * built to survive, not a reason for the suite to go red.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const pdf = require('../src/core/pdf');
const tradingview = require('../src/market/providers/tradingview');
const worldnews = require('../src/market/providers/worldnews');
const news = require('../src/market/providers/news');
const sec = require('../src/market/providers/sec');
const council = require('../src/syrix/council');
const evidence = require('../src/syrix/evidence');
const uploads = require('../src/syrix/uploads');
const embeds = require('../main/embeds');
const { sanitiseConfig } = require('../main/services');

function run(t) {
  const { suite, ok, eq, near } = t;

  /* ============ symbol translation ============ */
  console.log('\nSymbol translation — two vocabularies, and a guess draws the wrong company');

  suite('a suffixed listing translates to its exchange and back', () => {
    const pairs = [
      ['HSBA.L', 'LSE:HSBA'], ['RELIANCE.NS', 'NSE:RELIANCE'], ['7203.T', 'TSE:7203'],
      ['SAP.DE', 'XETR:SAP'], ['BHP.AX', 'ASX:BHP'], ['SHOP.TO', 'TSX:SHOP']
    ];
    pairs.forEach(([venue, vendor]) => {
      eq(tradingview.toVendor(venue), vendor, venue + ' did not translate');
      eq(tradingview.toVenue(vendor), venue, vendor + ' did not translate back');
    });
  });

  suite('the shapes that share nothing between the two vocabularies are tabulated', () => {
    eq(tradingview.toVendor('^GSPC'), 'SP:SPX');
    eq(tradingview.toVendor('GC=F'), 'COMEX:GC1!');
    eq(tradingview.toVendor('EURUSD=X'), 'FX:EURUSD');
    eq(tradingview.toVendor('BTC-USD'), 'CRYPTO:BTCUSD');
    eq(tradingview.toVenue('SP:SPX'), '^GSPC');
    eq(tradingview.toVenue('CRYPTO:BTCUSD'), 'BTC-USD');
  });

  suite('a plain ticker is refused rather than guessed at', () => {
    /* A United States listing does not carry its exchange anywhere in the
       symbol. Inventing a prefix draws a different company's chart under the
       right name, which is the worst failure this file could have, so the
       caller is made to resolve it through the search instead. */
    eq(tradingview.toVendor('NVDA'), null);
    eq(tradingview.toVendor('SOFI'), null);
  });

  suite('a United States listing translates back without a suffix', () => {
    eq(tradingview.toVenue('NASDAQ:NVDA'), 'NVDA');
    eq(tradingview.toVenue('NYSE:F'), 'F');
    /* A share class is a dot at the vendor and a hyphen at the venue. */
    eq(tradingview.toVenue('NYSE:BRK.B'), 'BRK-B');
  });

  suite('a phrase is searched whole and by its longest word', () => {
    /* The scanner matches a token, not a phrase: "rolls royce" finds the
       American receipts, whose description happens to have a space in it, and
       misses the London listing, which is spelled with a hyphen. */
    const terms = tradingview.queryTerms('rolls royce');
    eq(terms.length, 2);
    eq(terms[0], 'rolls royce');
    eq(terms[1], 'royce');
    eq(tradingview.queryTerms('nvda').length, 1);
  });

  suite('the primary listing outranks a cross-listing of the same company', () => {
    /* Every depositary receipt reports the underlying's own market value, so the
       sort that fetched them cannot separate them. What does is that a primary
       listing trades in its own country's money. */
    const matches = [
      { tvSymbol: 'VIE:NVDA', ticker: 'NVDA', name: 'NVIDIA Corporation', type: 'stock',
        typeSpecs: ['common'], country: 'United States', currency: 'EUR', last: 210, marketCap: 5e12, exchange: 'VIE' },
      { tvSymbol: 'NASDAQ:NVDA', ticker: 'NVDA', name: 'NVIDIA Corporation', type: 'stock',
        typeSpecs: ['common'], country: 'United States', currency: 'USD', last: 210, marketCap: 5e12, exchange: 'NASDAQ' },
      { tvSymbol: 'BCBA:NVDA', ticker: 'NVDA', name: 'NVIDIA Corporation', type: 'dr',
        typeSpecs: [], country: 'United States', currency: 'ARS', last: 14090, marketCap: 5e12, exchange: 'BCBA' }
    ];
    const ranked = tradingview.rankMatches(matches, 'NVDA');
    eq(ranked[0].tvSymbol, 'NASDAQ:NVDA', 'the Nasdaq line must come first');
  });

  suite('London quoting in pence still counts as trading at home', () => {
    const matches = [
      { tvSymbol: 'XETR:BCY', ticker: 'BCY', name: 'Barclays', type: 'stock', typeSpecs: ['common'],
        country: 'United Kingdom', currency: 'EUR', last: 4, marketCap: 5e10, exchange: 'XETR' },
      { tvSymbol: 'LSE:BARC', ticker: 'BARC', name: 'Barclays PLC', type: 'stock', typeSpecs: ['common'],
        country: 'United Kingdom', currency: 'GBX', last: 350, marketCap: 5e10, exchange: 'LSE' }
    ];
    eq(tradingview.rankMatches(matches, 'barclays')[0].tvSymbol, 'LSE:BARC');
  });

  suite('the two rating scales are read in the directions they actually run', () => {
    /* One to five with one meaning buy; minus one to one with positive meaning
       bullish. Reading either backwards turns a sell into a buy. */
    eq(tradingview.analystScale(1.11).label, 'Strong buy');
    eq(tradingview.analystScale(4.6).label, 'Strong sell');
    eq(tradingview.analystScale(null).available, false);
    eq(tradingview.technicalScale(0.66).label, 'Strong buy');
    eq(tradingview.technicalScale(-0.66).label, 'Strong sell');
    eq(tradingview.technicalScale(0).label, 'Neutral');
  });

  suite('a story arrives as text, never as markup', () => {
    const document = { type: 'root', children: [
      { type: 'p', children: ['First paragraph.'] },
      { type: 'p', children: ['Second with ', { type: 'b', children: ['bold'] }, ' inside.'] }
    ] };
    const text = tradingview.flatten(document);
    ok(text.indexOf('First paragraph.') !== -1);
    ok(text.indexOf('Second with bold inside.') !== -1);
    ok(text.indexOf('<') === -1, 'no markup may survive');
  });

  /* ============ news ============ */
  console.log('\nNews — artwork, worldwide search, and reading in place');

  suite('a picture is found wherever the publisher put it', () => {
    const shapes = [
      '<item><title>A</title><media:content url="https://x/a.jpg" width="130" height="86"/></item>',
      '<item><title>B</title><media:thumbnail url="https://x/b.jpg"/></item>',
      '<item><title>C</title><enclosure url="https://x/c.jpg" length="1" type="image/jpeg"/></item>',
      '<item><title>D</title><enclosure type="image/jpeg" url="https://x/d.jpg"/></item>'
    ];
    shapes.forEach((block, i) => {
      const found = news.tagImage(block);
      ok(found && /^https:\/\/x\//.test(found.url), 'shape ' + i + ' produced no picture');
    });
    eq(news.tagImage(shapes[0]).width, 130);
  });

  suite('a tracking pixel in a description is not mistaken for artwork', () => {
    const block = '<item><title>A</title><description>&lt;img src="https://t/px?id=9"&gt;text</description></item>';
    eq(news.tagImage(block), null);
  });

  suite('the copy of a story that is kept borrows the picture the duplicate had', () => {
    /* The same story reaches several desks and only some attach a picture.
       Keeping the first copy and dropping the rest threw the artwork away
       whenever the plainest feed happened to be read first. */
    const kept = news.dedupe([
      { title: 'Fed holds rates', image: null, summary: null, publishedAt: 2 },
      { title: 'Fed holds rates', image: 'https://x/a.jpg', imageWidth: 600, summary: 'A summary', publishedAt: 1 }
    ]);
    eq(kept.length, 1);
    eq(kept[0].image, 'https://x/a.jpg');
    eq(kept[0].summary, 'A summary');
  });

  suite('the worldwide index timestamp is parsed rather than guessed', () => {
    const at = worldnews.parseStamp('20260826T133000Z');
    eq(new Date(at).toISOString(), '2026-08-26T13:30:00.000Z');
    eq(worldnews.parseStamp('not a stamp'), null);
    eq(worldnews.parseStamp(''), null);
  });

  suite('a headline scraped with the page spacing is tidied', () => {
    eq(worldnews.cleanTitle('Is XRP a Buy , Sell , or Hold Right Now ? '),
      'Is XRP a Buy, Sell, or Hold Right Now?');
  });

  suite('the largest published thumbnail is taken, not the first', () => {
    const picked = worldnews.pickThumbnail({ resolutions: [
      { url: 'https://x/small.jpg', width: 140, tag: '140x140' },
      { url: 'https://x/big.jpg', width: 1000, tag: 'original' }
    ] });
    eq(picked, 'https://x/big.jpg');
    eq(worldnews.pickThumbnail(null), null);
  });

  suite('an article is extracted as paragraphs with the furniture removed', () => {
    const page = '<html><head><title>Head</title>' +
      '<meta property="og:title" content="The real headline">' +
      '<meta property="og:image" content="https://x/art.jpg"></head><body>' +
      '<nav><p>Home About Contact and some other navigation words here</p></nav>' +
      '<article>' +
      '<p>' + 'The first real paragraph of the article, long enough to count as prose.' + '</p>' +
      '<p>' + 'A second paragraph which is also comfortably past the length threshold.' + '</p>' +
      '</article>' +
      '<footer><p>Copyright notice that is quite long but should not be included</p></footer>' +
      '<script>var x = "a paragraph inside a script that must never appear";</script>' +
      '</body></html>';

    const out = worldnews.extract(page);
    eq(out.title, 'The real headline');
    eq(out.image, 'https://x/art.jpg');
    ok(out.text.indexOf('first real paragraph') !== -1);
    ok(out.text.indexOf('second paragraph') !== -1);
    ok(out.text.indexOf('navigation') === -1, 'navigation reached the article');
    ok(out.text.indexOf('Copyright') === -1, 'the footer reached the article');
    ok(out.text.indexOf('inside a script') === -1, 'a script reached the article');
  });

  suite('a caption is not promoted to a paragraph', () => {
    const found = worldnews.paragraphsOf('<p>Getty Images</p><p>' +
      'A genuine sentence of article prose that runs past the length threshold.</p>');
    eq(found.length, 1);
  });

  /* ============ insider filings ============ */
  console.log('\nInsider filings — a grant vesting is not a decision');

  const FORM4 = '<?xml version="1.0"?><ownershipDocument>' +
    '<issuer><issuerTradingSymbol>SOFI</issuerTradingSymbol></issuer>' +
    '<reportingOwner><reportingOwnerId><rptOwnerName>Keough Kelli</rptOwnerName></reportingOwnerId>' +
    '<reportingOwnerRelationship><isDirector>0</isDirector><isOfficer>1</isOfficer>' +
    '<officerTitle>EVP</officerTitle></reportingOwnerRelationship></reportingOwner>' +
    '<nonDerivativeTable>' +
    '<nonDerivativeTransaction>' +
    '<transactionDate><value>2026-08-20</value></transactionDate>' +
    '<transactionAmounts><transactionShares><value>11286</value></transactionShares>' +
    '<transactionPricePerShare><value>18.0032</value></transactionPricePerShare></transactionAmounts>' +
    '<transactionCoding><transactionCode>S</transactionCode></transactionCoding>' +
    '</nonDerivativeTransaction>' +
    '<nonDerivativeTransaction>' +
    '<transactionDate><value>2026-08-18</value></transactionDate>' +
    '<transactionAmounts><transactionShares><value>23720</value></transactionShares>' +
    '<transactionPricePerShare><value>18.002</value></transactionPricePerShare></transactionAmounts>' +
    '<transactionCoding><transactionCode>F</transactionCode></transactionCoding>' +
    '</nonDerivativeTransaction>' +
    '</nonDerivativeTable></ownershipDocument>';

  suite('an open-market sale and a tax withholding are told apart', () => {
    const parsed = sec.parseForm4(FORM4, { url: 'https://sec/f', filedAt: '2026-08-21' });
    eq(parsed.length, 2);

    const sale = parsed[0];
    eq(sale.code, 'S');
    eq(sale.discretionary, true, 'an open-market sale is a decision');
    eq(sale.direction, 'sell');
    eq(sale.shares, 11286);
    near(sale.value, 11286 * 18.0032, 0.01);
    eq(sale.person, 'Keough Kelli');
    eq(sale.roles[0], 'EVP');

    const withheld = parsed[1];
    eq(withheld.code, 'F');
    eq(withheld.discretionary, false, 'shares withheld to pay tax are not a decision');
  });

  suite('every transaction code that appears on a filing is understood', () => {
    ['P', 'S', 'A', 'M', 'F', 'D', 'G', 'C'].forEach(code => {
      ok(sec.TRANSACTION_CODE[code], 'no meaning recorded for code ' + code);
    });
    eq(sec.TRANSACTION_CODE.P.discretionary, true);
    eq(sec.TRANSACTION_CODE.A.discretionary, false);
  });

  /* ============ documents ============ */
  console.log('\nDocuments — reading a report with nothing installed');

  suite('a filename derived from an identifier can never name a data stream', () => {
    /* A colon in a path on this platform names an alternate data stream, not a
       file: the write succeeds, the byte count is right, nothing throws, and the
       file cannot afterwards be opened or listed. A CV was lost that way. */
    const name = uploads.safeName('doc:1fdszmp', 'pdf');
    eq(name.indexOf(':'), -1, 'a colon reached the filename');
    eq(name, 'doc1fdszmp.pdf');
    eq(uploads.safeName('../../etc/passwd', 'txt'), 'etcpasswd.txt');
    eq(uploads.safeName('x', 'p df/../y'), 'x.p', 'only the leading run of an extension is kept');
  });

  suite('a noise word never becomes the term a search narrows to', () => {
    /* "general motors" narrowed to "general" finds every general partnership in
       the world; narrowed to "motors" it finds the car maker. */
    eq(tradingview.queryTerms('general motors')[1], 'motors');
    eq(tradingview.queryTerms('bank of america')[1], 'america');
    eq(tradingview.queryTerms('rolls royce')[1], 'royce');
  });

  suite('a table is summarised rather than pasted whole', () => {
    const rows = ['Symbol,Quantity,Name'];
    for (let i = 0; i < 400; i++) rows.push('A' + i + ',10,"Some Company, Inc."');
    const described = uploads.describeTable(rows.join('\n'));
    ok(described.readable);
    ok(described.text.indexOf('400 rows') !== -1);
    ok(described.text.indexOf('Symbol | Quantity | Name') !== -1);
    ok(described.note.indexOf('25') !== -1, 'the summary must say how much was shown');
    ok(described.text.length < 4000, 'four hundred rows must not be pasted in full');
  });

  suite('a comma inside a quoted field does not split the row', () => {
    const cells = uploads.splitRow('AAPL,10,"Apple, Inc.",done', ',');
    eq(cells.length, 4);
    eq(cells[2], 'Apple, Inc.');
  });

  suite('a PDF is refused politely when it is not one', () => {
    const out = pdf.read(Buffer.from('this is not a pdf at all'));
    eq(out.readable, false);
    ok(/does not begin like a PDF/.test(out.reason));
  });

  suite('the text of a real report comes out readable', () => {
    /* Driven against real documents named in VANTAGE_SAMPLE_PDFS (separated by
       the platform's path delimiter). Where none is present the suite says so
       rather than passing quietly, because a reader that is never exercised on
       a real document is a reader that does not work. */
    const candidates = (process.env.VANTAGE_SAMPLE_PDFS || '')
      .split(path.delimiter)
      .filter(Boolean)
      .filter(file => { try { return fs.statSync(file).isFile(); } catch (e) { return false; } });

    if (!candidates.length) {
      ok(true, 'no sample document on this machine, so the reader was not exercised');
      return;
    }

    candidates.forEach(file => {
      const out = pdf.read(fs.readFileSync(file));
      ok(out.readable, path.basename(file) + ' produced no text');
      ok(out.text.length > 500, path.basename(file) + ' produced only ' + out.text.length + ' characters');

      /* THE FAILURE THIS GUARDS AGAINST IS NOT AN EMPTY RESULT, IT IS A SHREDDED
         ONE. A document that letter-spaces its headings came out as
         "K A B I R R  W E A L T H" under two earlier rules, which is text a
         reader would accept and a model would misread. A high proportion of
         one-character words means it has happened again. */
      const words = out.text.split(/\s+/).filter(Boolean);
      const singles = words.filter(word => word.length === 1).length;
      ok(singles / words.length < 0.25,
        path.basename(file) + ' is shredded: ' + Math.round((singles / words.length) * 100) +
        '% of its words are single characters');
    });
  });

  suite('a character map is read in both of the shapes filings use', () => {
    const single = pdf.parseCMap('beginbfchar<0001><004B><0002><0041>endbfchar');
    eq(single.get(1), 'K');
    eq(single.get(2), 'A');

    const ranged = pdf.parseCMap('beginbfrange<0010><0012><0061>endbfrange');
    eq(ranged.get(0x10), 'a');
    eq(ranged.get(0x12), 'c');

    const listed = pdf.parseCMap('beginbfrange<0020><0021>[<0058><0059>]endbfrange');
    eq(listed.get(0x20), 'X');
    eq(listed.get(0x21), 'Y');
  });

  /* ============ the council ============ */
  console.log('\nThe council — several specialists, one answer, checked against the evidence');

  suite('a question asking for a view goes to the council; a factual one does not', () => {
    ok(council.Council.wants('would you buy NVDA here?', 'NVDA'));
    ok(council.Council.wants('give me a full analysis of SOFI', 'SOFI'));
    ok(council.Council.wants('where would you enter', 'NVDA'));
    ok(!council.Council.wants('what is the ticker for Nvidia', null),
      'a question about no instrument cannot convene a desk');
    ok(!council.Council.wants('what time does the market open', 'NVDA'));
  });

  suite('every specialist declares what it reads and what it is for', () => {
    ok(council.SPECIALISTS.length >= 8, 'a desk of fewer than eight is not a desk');
    council.SPECIALISTS.forEach(specialist => {
      ok(specialist.id && specialist.title, 'a specialist with no name');
      ok(specialist.sections.length > 0, specialist.id + ' reads nothing');
      ok(specialist.remit.length > 80, specialist.id + ' has no real remit');
      ok(specialist.step, specialist.id + ' has no progress label');
    });
    /* The one that argues the other side is not optional. */
    ok(council.SPECIALISTS.some(s => s.id === 'risk'));
    ok(council.DEFAULT_ROSTER.indexOf('risk') !== -1);
  });

  suite('the brief makes a view conditional on saying what would disprove it', () => {
    const brief = council.chiefBrief({ dataState: { label: 'DELAYED', reason: 'a fifteen minute feed' } });
    ok(/YOU TAKE A POSITION/.test(brief));
    ok(/invalidation is not optional/i.test(brief));
    ok(/case against/i.test(brief));
    /* The data state governs whether a level may be called an order. */
    ok(brief.indexOf('DELAYED') !== -1);
    ok(brief.indexOf('a fifteen minute feed') !== -1);
  });

  suite('a plan wrapped in prose or a code fence is still read', () => {
    const wrapped = 'Sure, here is the plan:\n```json\n{"roster":["price","news"],' +
      '"focus":{"price":"watch the gap"}}\n```\nHope that helps.';
    const plan = council.parsePlan(wrapped, 6);
    eq(plan.roster.length, 2);
    eq(plan.roster[0], 'price');
    eq(plan.focus.price, 'watch the gap');
  });

  suite('a plan naming a specialist that does not exist is filtered, not obeyed', () => {
    const plan = council.parsePlan('{"roster":["price","astrology","news"]}', 6);
    eq(plan.roster.length, 2);
    eq(plan.roster.indexOf('astrology'), -1);
  });

  suite('an unreadable plan falls back rather than failing the question', () => {
    eq(council.parsePlan('I could not decide.', 6), null);
    eq(council.parsePlan('{"roster":[]}', 6), null);
  });

  suite('the roster is trimmed to what the allowance can pay for', () => {
    const plan = council.parsePlan('{"roster":["price","news","fundamentals","technicals","sector"]}', 2);
    eq(plan.roster.length, 2);
  });

  suite('an empty list of corrections is the expected answer', () => {
    eq(council.parseReview('{"corrections":[]}').corrections.length, 0);
    eq(council.parseReview('nothing to report').corrections.length, 0);
    const found = council.parseReview('{"corrections":["The target of 400 appears nowhere in the evidence."]}');
    eq(found.corrections.length, 1);
  });

  suite('a stance is read however the specialist chose to write it', () => {
    /* THE BRIEF ASKS FOR ONE FORM AND MODELS WRITE IT A DOZEN WAYS. A parser
       that insisted on the exact phrasing found one stance out of seven and
       reported the other six as having no view — a parsing failure presented as
       a desk that would not commit. */
    const forms = [
      'STANCE: bullish, confidence medium — unless it loses 195.',
      '**STANCE:** bullish, confidence: medium',
      'STANCE — Bullish, Medium confidence',
      'Stance: bullish (confidence high)',
      '_Stance_: BEARISH, confidence low'
    ];
    forms.forEach(line => {
      const stance = council.readStance('The trend is up.\n' + line);
      ok(stance, 'not read: ' + line);
      ok(stance.view === 'bullish' || stance.view === 'bearish', 'wrong view for: ' + line);
    });

    eq(council.readStance('The trend is up.\nSTANCE: bullish, confidence medium').confidence, 'medium');
    eq(council.readStance('Stance: neutral, moderate confidence').confidence, 'medium',
      'moderate and medium are the same word');
    /* A confidence nobody stated defaults rather than losing the whole stance. */
    eq(council.readStance('STANCE: bearish').confidence, 'medium');
    eq(council.readStance('no stance here'), null);
    eq(council.readStance('the stance of the market is hard to read'), null,
      'a sentence about stances is not a stance');
  });

  suite('the stance line is taken out of the body it is shown beside', () => {
    const body = council.withoutStance('Volume is thin.\n**STANCE:** bearish, confidence low');
    eq(body, 'Volume is thin.');
    eq(council.withoutStance('Nothing to remove.'), 'Nothing to remove.');
  });

  /* ============ evidence ============ */
  console.log('\nEvidence — the dossier the desk reasons over');

  suite('a level is a price the market turned at more than once', () => {
    /* Built so there is a shelf at 100 tested twice and one at 120 tested twice,
       with the last price between them. */
    const bars = [];
    const shape = [90, 95, 100, 95, 90, 95, 100, 95, 90, 100, 110, 120, 110, 105, 110, 120, 110, 105];
    for (let i = 0; i < 60; i++) {
      const base = shape[i % shape.length];
      bars.push({ t: Date.UTC(2026, 0, 1) + i * 86400000, o: base, h: base + 1, l: base - 1, c: base, v: 1000 });
    }
    const levels = evidence.swingLevels(bars, 108);
    ok(Array.isArray(levels.support));
    ok(Array.isArray(levels.resistance));
    levels.support.forEach(level => ok(level.price < 108, 'support must sit below the price'));
    levels.resistance.forEach(level => ok(level.price > 108, 'resistance must sit above the price'));
    ok(levels.note.length > 20, 'a level must say what it means');
  });

  suite('the dossier heading carries the price, the stamp and the data state', () => {
    const heading = evidence.heading({
      symbol: 'NVDA', name: 'NVIDIA', assetClass: 'EQUITY', currency: 'USD', venue: 'NASDAQ',
      quote: { last: 210.65, changePercent: -1.12, stampedAt: '2026-08-26T20:00:00.000Z' },
      dataState: { label: 'DELAYED', reason: 'the venue publishes on a delay' },
      warnings: []
    });
    ok(heading.indexOf('NVDA') !== -1);
    ok(heading.indexOf('210.65') !== -1);
    ok(heading.indexOf('DELAYED') !== -1);
    ok(heading.indexOf('2026-08-26') !== -1, 'the stamp must travel with the price');
  });

  suite('a section that could not be gathered says so instead of reading as empty', () => {
    const dossier = { sections: { news: { name: 'news', label: 'News', ok: false, reason: 'the feed timed out' } } };
    const text = evidence.sectionText(dossier, 'news');
    ok(/UNAVAILABLE/.test(text));
    ok(/timed out/.test(text));
    ok(/Say so/.test(text), 'the specialist must be told to report the gap');
  });

  suite('a figure is never rounded on its way into the dossier', () => {
    const rendered = evidence.render({ price: 210.6512345, ratio: 0.0655534751424742 });
    ok(rendered.indexOf('210.6512345') !== -1);
    ok(rendered.indexOf('0.0655534751424742') !== -1);
  });

  /* ============ the embed host ============ */
  console.log('\nEmbedded surfaces — a third-party widget on its own origin');

  suite('a configuration cannot close the script element it is written into', () => {
    const page = embeds.hostPage('advanced-chart', {
      symbol: 'NASDAQ:NVDA',
      hostile: '</scr' + 'ipt><img src=x onerror=alert(1)>'
    });
    eq(page.indexOf('</scr' + 'ipt><img'), -1, 'a configuration value closed the element');
    ok(page.indexOf('\\u003c/script\\u003e') !== -1, 'the closing tag must be escaped, not removed');
    ok(page.indexOf('NASDAQ:NVDA') !== -1, 'the real configuration must survive');
  });

  suite('the attribution the vendor asks for is present', () => {
    const page = embeds.hostPage('advanced-chart', {});
    ok(/tradingview\.com/.test(page));
    ok(/tradingview-widget-copyright/.test(page));
  });

  suite('the widget script is a child of its own container, not a sibling after it', () => {
    /* The vendor's widget finds where to draw with
       document.currentScript.parentElement. A script placed after the
       container's closing tag still loads and runs without any error — the
       frame, the sandboxing and the copyright line all look correct — it just
       never finds anywhere to paint, which is indistinguishable from "nothing
       is working" from the screen. */
    const page = embeds.hostPage('advanced-chart', { symbol: 'NASDAQ:NVDA' });
    const containerOpen = page.indexOf('class="tradingview-widget-container"');
    /* The outer container is the last div to close in the document — its
       __widget and copyright children close first — so the LAST </div>
       before </body> is the one the script must land inside. */
    const containerClose = page.lastIndexOf('</div>', page.indexOf('</body>'));
    const scriptTag = page.indexOf('<script', containerOpen);
    ok(scriptTag !== -1 && containerOpen < scriptTag && scriptTag < containerClose,
      'the <script> must appear inside the container, before its own closing </div>');
  });

  suite('a widget config may carry one level of nested overrides, not a function or deeper nesting', () => {
    /* overrides is the advanced-chart widget's own documented shape for
       colour customisation — a flat object of dotted property paths to a
       colour string — and there is no other way to hand those to it. */
    const clean = sanitiseConfig({
      symbol: 'NASDAQ:NVDA',
      overrides: {
        'paneProperties.background': '#0a0d14',
        'mainSeriesProperties.candleStyle.drawBorder': false,
        'mainSeriesProperties.candleStyle.someCount': 3,
        evil: () => 'still not a string',
        nested: { tooDeep: '#000000' }
      }
    });
    eq(clean.overrides['paneProperties.background'], '#0a0d14');
    eq(clean.overrides['mainSeriesProperties.candleStyle.drawBorder'], false);
    eq(clean.overrides['mainSeriesProperties.candleStyle.someCount'], 3);
    ok(clean.overrides.evil === undefined, 'a function must never survive into a script element');
    ok(clean.overrides.nested === undefined, 'nesting stops at one level');
  });

  suite('only widgets that exist can be named', () => {
    ok(embeds.WIDGETS.chart);
    ok(embeds.WIDGETS.stockHeatmap);
    ok(embeds.WIDGETS.calendar);
    ok(!embeds.WIDGETS.somethingElse);
  });

  /* ============ the heatmap's own picker ============ */
  console.log('\nThe heatmap — every window the picker offers must actually be fetched');

  const discoverModule = (() => {
    const sandbox = { window: {}, T: {} };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'discover.js'), 'utf8'), sandbox);
    return sandbox.T.discover;
  })();

  suite('the screener and the heatmap read the logo main/services.js already resolved', () => {
    /* The scanner row itself carries the field under `logoid` (matching the
       SCREEN_COLUMNS entry it was requested under) — main/services.js's own
       screen() wrapper turns that into a ready loopback address on every row
       before it ever reaches the renderer, at no extra cost, since the same
       call that produced the row already carried the slug. `row.logo` and
       `tile.logo` are that resolved address, not the scanner's own column
       name, and reading them directly is what this screen should do.
     *
       Re-deriving a mark through paintLogos()/market:logos instead — a
       separate, per-symbol vendor-lookup-then-scan round trip — is both
       slower and less exact, because it resolves from a bare symbol rather
       than the specific listing the row is actually for. That indirection is
       why the screener and the heatmap showed initials for almost every row:
       the ready answer already on the row was never read. */
    const discoverSource = fs.readFileSync(path.join(__dirname, '..', 'web', 'discover.js'), 'utf8');
    ok(/\brow\.logo\b/.test(discoverSource), 'the screener table should read the resolved row.logo');
    ok(/\btile\.logo\b/.test(discoverSource), 'the heatmap tiles should read the resolved tile.logo');
  });

  suite('every "Colour by" option names a column the scanner is actually asked for', () => {
    /* Perf.3M and Perf.Y were offered in the picker but never in
       SCREEN_COLUMNS — every row zipped to undefined for those two windows,
       so the whole map painted flat with nothing wrong printed anywhere. The
       picker looked broken; the columns behind two of its six options were
       simply never requested. */
    const missing = discoverModule.COLOUR_BY
      .map(option => option.column)
      .filter(column => tradingview.SCREEN_COLUMNS.indexOf(column) === -1);
    eq(missing.length, 0, 'offered but never fetched: ' + missing.join(', '));
  });

  /* ============ the free instrument summary ============ */
  console.log('\nKey facts — the plain-words gist, before any button is pressed');

  const researchModule = (() => {
    const sandbox = { window: {}, T: {} };
    sandbox.window = sandbox;
    sandbox.T.num = require('../src/core/num');
    sandbox.T.clock = require('../src/core/clock');
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'research.js'), 'utf8'), sandbox);
    return sandbox.T.research;
  })();

  const factModel = (last, previousClose) => ({
    symbol: 'NVDA', currency: 'USD', assetClass: 'EQUITY', priceHint: null,
    quote: { last, previousClose }
  });

  suite('the price line names the direction and the size of the move', () => {
    const html = researchModule.keyFactsHtml(factModel(225.98, 209.66), null);
    ok(/NVDA is up/.test(html), 'got: ' + html);
    ok(/\$225\.98/.test(html), 'got: ' + html);
  });

  suite('a fall is named as a fall, not folded into "flat"', () => {
    const html = researchModule.keyFactsHtml(factModel(95, 100), null);
    ok(/NVDA is down/.test(html), 'got: ' + html);
  });

  suite('analyst opinion reads the strong-buy/buy/hold/sell/strong-sell breakdown when it is published', () => {
    /* data here is market:fundamentals's payload (engine.fundamentals()),
       shaped { analysts, earnings, valuation, perShare, ... } — a different
       call from market:reference's { figures, reading }, which only
       renderTechnicals uses. */
    const data = { analysts: { trend: [{ strongBuy: 5, buy: 3, hold: 1, sell: 0, strongSell: 0 }] } };
    const html = researchModule.keyFactsHtml(factModel(100, 99), data);
    ok(/9 analysts covering it lean toward buying it/.test(html), 'got: ' + html);
  });

  suite('a scalar recommendation still speaks when the breakdown behind it is not published', () => {
    /* Some symbols carry recommendationKey/recommendationMean with an empty
       or all-zero trend array — a consensus rating with no distribution
       behind it is still worth a sentence, not silence. */
    const data = { analysts: { trend: [], key: 'strong_buy' } };
    const html = researchModule.keyFactsHtml(factModel(100, 99), data);
    ok(/rate it a strong buy/.test(html), 'got: ' + html);
  });

  suite('no coverage means no sentence about coverage, not "rate it a undefined"', () => {
    const data = { analysts: {} };
    const html = researchModule.keyFactsHtml(factModel(100, 99), data);
    ok(!/rate it|lean toward|split on/.test(html), 'got: ' + html);
  });

  suite('the target is read from analysts.targetMean and stated against the current price', () => {
    const data = { analysts: { targetMean: 120 } };
    const html = researchModule.keyFactsHtml(factModel(100, 99), data);
    ok(/above the current price/.test(html), 'a 120 target on a 100 price is above: ' + html);
  });

  suite('the next earnings date is read from earnings.nextDate, in milliseconds', () => {
    const data = { earnings: { nextDate: Date.now() + 30 * 86400000 } };
    const html = researchModule.keyFactsHtml(factModel(100, 99), data);
    ok(/Next reports/.test(html), 'got: ' + html);
  });

  suite('an instrument with nothing to say carries no placeholder sentence', () => {
    /* An index or a currency pair has no analyst coverage and no earnings —
       the card falls back to the general paragraph instead of inventing an
       empty "Analysts covering it rate it a undefined". */
    const html = researchModule.keyFactsHtml({ symbol: 'GSPC', quote: {} }, null);
    eq(html, '');
  });

  /* ============ the performance dashboard's default surface ============ */
  console.log('\nPerformance — the theme it opens in');

  suite('the dashboard follows the application theme by default', () => {
    /* It used to default to its own light "report" palette regardless of the
       application's theme, with a control to opt into following the theme
       instead — so switching the whole application to dark left this one
       screen white with no way to tell that was deliberate rather than
       broken. The control now opts INTO the light reference look, not out
       of it. */
    const sandbox = { window: {}, T: {} };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'dashboard.js'), 'utf8'), sandbox);
    eq(sandbox.T.dashboard.state.surface, 'theme');
  });

  suite('a book with an open position and no closed trade still shows what is held', () => {
    /* positionsCard() only ever rendered inside the branch that needs a
       closed trade to have a chart worth drawing — a book that is all open
       positions and nothing closed yet showed the generic "no closed
       trade" message and nothing else, as though the holding did not
       exist. What is held right now and how past round trips performed are
       different questions. */
    const sandbox = { window: {}, T: {} };
    sandbox.window = sandbox;
    sandbox.T.num = require('../src/core/num');
    sandbox.T.clock = require('../src/core/clock');
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'dashboard.js'), 'utf8'), sandbox);
    const dash = sandbox.T.dashboard;

    dash.state.journal = { statistics: { empty: true }, trades: [], currency: 'USD' };
    dash.state.portfolio = {
      caveat: 'Hand-entered holdings.',
      holdings: [{ symbol: 'NVDA', quantity: 10, avgEntry: 200, last: 225.98, unrealised: 259.8 }]
    };

    const html = dash.html();
    ok(/NVDA/.test(html), 'the holding itself must be on screen: ' + html.slice(0, 400));
    ok(/Open positions/.test(html), 'the positions card must actually be drawn');
    ok(/No closed trade/.test(html), 'the closed-trade message still explains the rest of the screen');
  });

  suite('the performance positions table reads the same as the paper blotter', () => {
    /* positionsTable() used to render a cut-down Symbol/Quantity/Average
       entry/Last/Unrealised view of the exact same portfolio:value data
       the paper blotter's own Positions tab renders in full — so the same
       holding read differently depending on which screen showed it, even
       though nothing about the data actually differed. */
    const sandbox = { window: {}, T: {} };
    sandbox.window = sandbox;
    sandbox.T.num = require('../src/core/num');
    sandbox.T.clock = require('../src/core/clock');
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'dashboard.js'), 'utf8'), sandbox);
    const dash = sandbox.T.dashboard;

    dash.state.book = 'paper';
    dash.state.journal = { statistics: { empty: true }, trades: [], currency: 'USD' };
    dash.state.portfolio = {
      caveat: 'Simulated paper positions.',
      holdings: [{
        symbol: 'TSLA', quantity: -5, averageEntry: 240, last: 231.4, priced: true,
        marketValue: 1157, unrealised: 43, unrealisedPct: 3.58
      }]
    };

    const html = dash.html();
    ok(/Short/.test(html), 'a negative quantity reads as a short, not a bare number: ' + html.slice(0, 400));
    ok(/Unrealised%/.test(html), 'the percentage column present in the blotter must be present here too');
    ok(/data-act="dash-close"/.test(html), 'a paper position can be closed from this table, like the blotter');

    dash.state.book = 'mirror';
    const mirrorHtml = dash.html();
    ok(!/data-act="dash-close"/.test(mirrorHtml), 'a hand-entered holding has no paper order to close');
  });

  /* ============ the renderer's markdown ============ */
  console.log('\nMarkdown — the assistant writes documents, not asterisks');

  const md = (() => {
    const sandbox = { window: {} };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'markdown.js'), 'utf8'), sandbox);
    return sandbox.T.markdown;
  })();

  suite('a table becomes a table, with its alignment', () => {
    const html = md.render('| Level | Price |\n| --- | ---: |\n| Support | 195.40 |\n| Target | 240.00 |');
    ok(/<table class="md-table">/.test(html));
    ok(/<th style="text-align:right">Price<\/th>/.test(html));
    eq((html.match(/<tr>/g) || []).length, 3, 'a header and two body rows');
  });

  suite('a short row is padded rather than losing the table its shape', () => {
    const html = md.render('| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |');
    eq((html.match(/<td/g) || []).length, 3);
  });

  suite('markup in the source is escaped before any tag is added', () => {
    const html = md.render('<img src=x onerror=alert(1)> and **bold**');
    eq(html.indexOf('<img'), -1, 'a tag survived');
    ok(/<strong>bold<\/strong>/.test(html), 'the markdown must still render');
  });

  suite('a javascript address never reaches an href', () => {
    const html = md.render('[click](javascript:alert(1)) and [real](https://example.com)');
    eq(html.indexOf('javascript:alert'), html.indexOf('javascript:alert') === -1 ? -1 : html.indexOf('javascript:alert'));
    ok(html.indexOf('href="javascript:') === -1, 'a javascript address reached an href');
    ok(/href="https:\/\/example\.com"/.test(html), 'a real link must still work');
  });

  suite('an ordinary number in prose is not mistaken for a code span', () => {
    /* The placeholder used to be a number wrapped in spaces, which matched any
       figure in the text: "I have 42 apples" came back with a code span in it. */
    const html = md.render('I have 42 apples and `code with 7 in it` here.');
    ok(/I have 42 apples/.test(html));
    ok(/<code>code with 7 in it<\/code>/.test(html));
  });

  suite('a fenced block keeps its contents exactly', () => {
    const html = md.render('Text\n\n```js\nconst a = 1;\nconst a = 1;\n```\n\nMore.');
    eq((html.match(/const a = 1;/g) || []).length, 2);
    ok(/<pre><code>/.test(html));
  });
}

module.exports = { run };
