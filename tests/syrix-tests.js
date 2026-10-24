'use strict';
/* Research assistant tests.
 *
 * The advice guard is the one that matters most here. This application
 * describes what is measurable and does not tell anyone what to trade, and that
 * has to hold even when the model behind it decides otherwise — which is why it
 * is enforced in code rather than asked for in a prompt.
 */

const guards = require('../src/syrix/guards');
const tools = require('../src/syrix/tools');
const websearch = require('../src/syrix/websearch');
const { compact, brief, MAX_ROUNDS } = require('../src/syrix/loop');

function run(t) {
  const { suite, ok, eq } = t;

  /* ============ taking a position ============ */
  console.log('\nAnswers — a view reaches the reader, and the writing is still checked');

  suite('the guard that deleted trading views is gone and stays gone', () => {
    ok(typeof guards.stripAdvice !== 'function',
      'the deletion has been reinstated; the discipline is evidence, not censorship');
    const source = 'RSI is 28, which is unusually low. I would buy NVDA here. Volume is below average.';
    const out = guards.clean(source, {});
    eq(out.text, source, 'the answer came back changed');
  });

  suite('a trading view reaches the reader intact', () => {
    /* THE OPPOSITE OF WHAT THIS SUITE USED TO ASSERT, AND DELIBERATELY SO. A
       guard here removed any sentence that named an action and a direction,
       which meant the assistant could read every filing a company had made and
       then delete the only sentence that took a judgement. The discipline that
       replaced it is evidence-based and lives in the council; nothing in this
       file may quietly reinstate the deletion. */
    const phrases = [
      'I would buy this at 208 and be out below 195.',
      'This is a sell while it stays under the fifty day average.',
      'I would not take this trade at all.',
      "I'd take profits into the result and re-enter afterwards."
    ];
    phrases.forEach(phrase => {
      const source = 'The trend has been upward for six weeks. ' + phrase +
        ' Volume has been below its own average throughout.';
      const out = guards.clean(source, {});
      ok(out.text.indexOf(phrase) !== -1, 'a view was removed: ' + phrase);
    });
  });

  suite('nothing in the guards deletes a whole sentence any more', () => {
    const source = 'RSI has reached 82, the highest reading in a year. This is a strong buy. ' +
      'The price is above both its fifty and two hundred day averages.';
    const out = guards.clean(source, {});
    eq(out.text, source, 'the answer came back changed');
  });

  suite('markdown structure survives the guards', () => {
    /* Answers are markdown now and markdown repeats itself on purpose. A
       deduplicator that does not know that eats the second row of a two-row
       table, and the answer arrives malformed. */
    const table = [
      '## Levels',
      '',
      '| Level | Price | Touches |',
      '| --- | --- | --- |',
      '| Support | 195.40 | 3 |',
      '| Support | 188.10 | 2 |',
      '| Resistance | 218.00 | 4 |'
    ].join('\n');

    const out = guards.clean(table, {});
    eq(out.text.split('\n').filter(line => line.startsWith('| Support')).length, 2,
      'a repeated table row was removed');
    ok(out.text.indexOf('| --- | --- | --- |') !== -1, 'the table rule was removed');
    ok(out.text.indexOf('## Levels') !== -1, 'the heading was removed');
  });

  suite('a code block passes through untouched', () => {
    const source = 'Here it is:\n\n```js\nconst a = 1;\nconst a = 1;\n```\n\nThat is the whole thing.';
    const out = guards.clean(source, {});
    eq(out.text.split('const a = 1;').length - 1, 2, 'a repeated line inside a fence was removed');
  });

  suite('an answer that ends on a table row is not truncated', () => {
    const source = '| Metric | Value |\n| --- | --- |\n| Entry | 208.40 |';
    eq(guards.dropTrailingFragment(source), source);
  });

  /* ============ narration ============ */
  console.log('\nNarration — models talk to themselves out loud');

  suite('a preamble before the answer is dropped', () => {
    const source = 'We need to answer the user about inflation.\nLet me check the figures.\n\n' +
      'Inflation in the United Kingdom was 3.2% in the year to July, according to the ' +
      'Office for National Statistics.';
    const out = guards.stripNarration(source);
    ok(out.indexOf('We need to answer') === -1);
    ok(out.indexOf('Inflation in the United Kingdom') === 0, 'got: ' + out.slice(0, 40));
  });

  suite('an answer with no preamble is untouched', () => {
    const source = 'Inflation was 3.2% in the year to July, on the official measure.';
    eq(guards.stripNarration(source), source);
  });

  suite('nothing is cut when no answer can be identified', () => {
    /* Cutting blindly would produce a blank reply, which is worse. */
    const source = 'Let me think.\nHmm.\nOkay so.';
    eq(guards.stripNarration(source), source);
  });

  /* ============ tool-call wreckage ============ */
  console.log('\nTool machinery — the operator is never shown the plumbing');

  suite('a reply that ends in tool syntax is recognised as unfinished', () => {
    ok(guards.hasToolSyntax('August 25 2026 US stock market close\n</parameter>\n</function>\n</tool_call>'));
    ok(guards.hasToolSyntax('<function_calls><invoke name="search">'));
    ok(guards.hasToolSyntax('<|tool_call_begin|>'));
    /* The dialect that separates the tag name with an equals sign rather than a
       space, which slipped past an earlier pattern and reached the screen. */
    ok(guards.hasToolSyntax('<function=a web search>\n<parameter=query>'));
    eq(guards.dropToolSyntax('<function=a web search>\n<parameter=query>'), '');
  });

  suite('ordinary prose is not mistaken for it', () => {
    ok(!guards.hasToolSyntax('Revenue rose because the function of the business changed.'));
    ok(!guards.hasToolSyntax('The parameter they cited was margin, not revenue.'));
    ok(!guards.hasToolSyntax('Shares fell 3% after the call.'));
  });

  suite('the machinery is stripped and the finished sentence is kept', () => {
    const out = guards.dropToolSyntax(
      'The index closed lower on the day.\nAugust 25 2026 close\n</parameter>\n</function>\n</tool_call>');
    ok(out.indexOf('<') === -1, 'no markup survives: ' + JSON.stringify(out));
    ok(out.indexOf('tool_call') === -1);
    ok(/The index closed lower on the day\./.test(out), 'got: ' + JSON.stringify(out));
  });

  suite('a misdelivered tool call is read back out of the prose and run', () => {
    const names = tools.DEFINITIONS.map(d => d.function.name);

    /* The dialect that actually reached the screen: an equals sign for the
       separator, and the tool's description where its name belongs. */
    const loose = guards.parseToolCalls(
      '<function=a web search>\n<parameter=query>SoFi CEO revenue</parameter>\n</function>', names);
    eq(loose.length, 1);
    eq(loose[0].name, 'search_the_web', 'the description resolves to the real tool');
    eq(loose[0].args.query, 'SoFi CEO revenue');

    const attributes = guards.parseToolCalls(
      '<function name="get_a_price"><parameter name="symbol">NVDA</parameter></function>', names);
    eq(attributes.length, 1);
    eq(attributes[0].name, 'get_a_price');
    eq(attributes[0].args.symbol, 'NVDA');

    const json = guards.parseToolCalls(
      '<tool_call>{"name":"read_a_page","arguments":{"url":"https://example.com"}}</tool_call>', names);
    eq(json.length, 1);
    eq(json[0].name, 'read_a_page');
  });

  suite('a call that cannot be resolved is not guessed at', () => {
    const names = tools.DEFINITIONS.map(d => d.function.name);
    /* Half a call, with the arguments never written, would search for nothing. */
    eq(guards.parseToolCalls('<function=a web search>\n<parameter=query>', names).length, 0);
    /* A tool this application does not have is never invented into one. */
    eq(guards.parseToolCalls(
      '<function=delete_everything><parameter=path>/</parameter></function>', names).length, 0);
    eq(guards.parseToolCalls('Just ordinary prose about a function.', names).length, 0);
  });

  suite('a bare address or search phrase is not an answer', () => {
    ok(guards.looksUnanswered('https://annualreport.stocklight.com/nasdaq/sofi/23694770.pdf'));
    ok(guards.looksUnanswered('SoFi Technologies 2023 revenue SEC filing'));
    ok(guards.looksUnanswered('August 25 2026 US stock market close'));
    ok(guards.looksUnanswered(''));
    ok(guards.looksUnanswered('   '));
  });

  suite('a short but complete answer survives', () => {
    /* The narrowness matters as much as the catch. "About 24 per cent." is the
       right answer to a question about a margin and must not be thrown away. */
    ok(!guards.looksUnanswered('About 24 per cent.'));
    ok(!guards.looksUnanswered('No, it does not.'));
    ok(!guards.looksUnanswered('$213.05'));
    ok(!guards.looksUnanswered('NVIDIA closed at $213.05, up 2.2% on the day.'));
    ok(!guards.looksUnanswered('Revenue was $26.9bn.\nProfit was $9.8bn.'));
  });

  suite('a cleaned answer never carries tool markup', () => {
    const out = guards.clean('Gold steadied today.\n<tool_call>\n<function name="search">\n</function>', {});
    ok(out.text.indexOf('<') === -1, 'got: ' + JSON.stringify(out.text));
    ok(out.text.indexOf('tool_call') === -1);
    ok(/Gold steadied today\./.test(out.text), 'got: ' + JSON.stringify(out.text));
  });

  /* ============ citation artefacts ============ */
  console.log('\nCitation artefacts — a provider\'s annotations are not sources');

  suite('a citation marker is removed without leaving a gap', () => {
    const source = 'The Prime Minister is Andy Burnham.【{"id":0,"cursor":0}】 He took office in July.';
    const out = guards.dropCitationMarkers(source);
    ok(out.indexOf('【') === -1);
    ok(out.indexOf('cursor') === -1);
    eq(out, 'The Prime Minister is Andy Burnham. He took office in July.');
  });

  suite('numeric reference markers and citation tags go too', () => {
    eq(guards.dropCitationMarkers('It rose [[3]] sharply [citation: 4] .'), 'It rose sharply.');
  });

  suite('an ordinary bracket is not mistaken for a citation', () => {
    const source = 'Revenue (excluding one-off items) rose 12%.';
    eq(guards.dropCitationMarkers(source), source);
  });

  /* ============ evidence ============ */
  console.log('\nEvidence — which figures came from somewhere and which did not');

  suite('a figure present in a tool result is not flagged', () => {
    const results = [{ symbol: 'NVDA', price: 208.48, changePercent: 0.18 }];
    eq(guards.unsourcedFigures('NVDA is trading at $208.48.', results).length, 0);
  });

  suite('a figure that appears nowhere is flagged', () => {
    const results = [{ symbol: 'NVDA', price: 208.48 }];
    const flagged = guards.unsourcedFigures('NVDA is at $208.48 and its book value is $41.20.', results);
    eq(flagged.length, 1);
    eq(flagged[0], '$41.20');
  });

  suite('a rounded restatement of a supplied figure is accepted', () => {
    /* A model given 130.497 and writing 130.5 has not invented anything.
       The comparison has to run from the source towards the answer: rounding
       130.5 never produces 130.497, so checking the other way would flag every
       honest restatement. */
    eq(guards.unsourcedFigures('Revenue was 130.5 billion.', [{ revenue: 130.497 }]).length, 0);
    eq(guards.unsourcedFigures('It rose 12.3%.', [{ change: 12.34567 }]).length, 0);
  });

  suite('a figure reported in units and stated in billions is the same figure', () => {
    eq(guards.unsourcedFigures('Revenue was $130.5 billion.', [{ revenue: 130497000000 }]).length, 0);
  });

  suite('rounding tolerance does not swallow a genuinely different figure', () => {
    eq(guards.unsourcedFigures('Revenue was 140.5 billion.', [{ revenue: 130.497 }]).length, 1);
  });

  suite('a year is prose, not a claim needing a source', () => {
    eq(guards.unsourcedFigures('The company was founded in 1993.', [{}]).length, 0);
  });

  suite('the flag reports rather than edits', () => {
    /* A model legitimately does arithmetic on figures it was given, and
       deleting the result would be wrong. */
    const cleaned = guards.clean('The gap is $12.34.', { toolResults: [{ a: 1 }] });
    ok(cleaned.text.indexOf('$12.34') !== -1, 'the figure stays in the answer');
    eq(cleaned.unsourced.length, 1, 'and is reported separately');
  });

  /* ============ the checked line ============ */
  console.log('\nThe checked line — built from what was called, not from what was claimed');

  suite('every source consulted is named once', () => {
    const used = [
      { name: 'search_the_web', args: { query: 'x' } },
      { name: 'read_a_page', args: { url: 'https://www.gov.uk/a' } },
      { name: 'read_a_page', args: { url: 'https://www.gov.uk/b' } }
    ];
    const line = guards.checkedLine(used, tools.sourceLabel);
    ok(/^Checked: /.test(line));
    eq((line.match(/gov\.uk/g) || []).length, 1, 'the same domain is not listed twice');
  });

  suite('a turn that consulted nothing has no checked line', () => {
    eq(guards.checkedLine([], tools.sourceLabel), null);
  });

  /* ============ repetition and truncation ============ */
  console.log('\nRepetition and truncation');

  suite('a line repeated back to back is dropped once', () => {
    const out = guards.dropRepeats('The course code is 175C.\nThe course code is 175C.\nSomething else.');
    eq((out.match(/175C/g) || []).length, 1);
  });

  suite('a label and value pair may legitimately repeat', () => {
    const out = guards.dropRepeats('Revenue: 100\nRevenue: 200');
    eq((out.match(/Revenue/g) || []).length, 2);
  });

  suite('a sentence cut off by a token ceiling is removed', () => {
    const source = 'Revenue grew twelve per cent. Margins improved. The company also said that it woul';
    const out = guards.dropTrailingFragment(source);
    ok(out.indexOf('woul') === -1);
    ok(out.indexOf('Margins improved') !== -1);
  });

  suite('a complete answer is not truncated further', () => {
    const source = 'Revenue grew twelve per cent.';
    eq(guards.dropTrailingFragment(source), source);
  });

  suite('a list ending without punctuation is left alone', () => {
    const source = 'Three things:\n- The first one\n- The second one here';
    eq(guards.dropTrailingFragment(source), source);
  });

  /* ============ permissions ============ */
  console.log('\nPermissions — the assistant reads, and that is all it can do');

  suite('no tool writes, trades or touches a credential', () => {
    /* A property of the list rather than a rule the model is asked to follow. */
    const banned = /(place|submit|send|execute|cancel|buy|sell|write|delete|update|set|save|pair|token|key|password)/i;
    tools.DEFINITIONS.forEach(definition => {
      const name = definition.function.name;
      ok(!banned.test(name), 'a tool named ' + name + ' suggests it can act');
    });
  });

  suite('the tool list covers general questions, not only markets', () => {
    const names = tools.DEFINITIONS.map(d => d.function.name);
    ok(names.indexOf('search_the_web') !== -1, 'it must be able to search');
    ok(names.indexOf('read_a_page') !== -1, 'and to read what it finds');
    ok(names.indexOf('look_up_a_topic') !== -1, 'and to look something up');
    ok(names.indexOf('check_the_time') !== -1, 'and to know what day it is');
  });

  suite('every tool has a description a model can act on', () => {
    tools.DEFINITIONS.forEach(definition => {
      const description = definition.function.description;
      ok(description && description.length > 40, definition.function.name + ' needs a real description');
    });
  });

  suite('every tool has a step label and a source label', () => {
    tools.DEFINITIONS.forEach(definition => {
      const name = definition.function.name;
      const step = tools.describe(name, { symbol: 'NVDA', query: 'x', url: 'https://a.com/b', topic: 't', name: 'n', figure: 'revenue' });
      const source = tools.sourceLabel(name, { symbol: 'NVDA', url: 'https://a.com/b' });
      ok(step && step !== 'Working', name + ' has no step label');
      ok(source && source !== name, name + ' has no source label');
    });
  });

  suite('the brief tells the assistant it is general, and that it must commit', () => {
    const text = brief({});
    ok(/GENERAL assistant/.test(text), 'it must not be framed as market-only');
    ok(/created by Kabirr Kohli/.test(text));
    ok(/LOOK IT UP/i.test(text), 'it must be told to check rather than recall');
    ok(/ANSWER THE QUESTION THAT WAS ASKED/i.test(text), 'it must be told to answer, not to deflect');
    ok(/invalidation/i.test(text), 'a view has to come with the level that disproves it');
    ok(/comes from a tool/i.test(text), 'figures may not come from memory');
    /* The refusal that used to be here is gone and must not come back. */
    ok(!/do not tell anyone to buy/i.test(text));
  });

  suite('the brief names the instrument on screen when there is one', () => {
    ok(/currently looking at NVDA/.test(brief({ selectedSymbol: 'NVDA' })));
    ok(!/currently looking at/.test(brief({})));
  });

  /* ============ context budget ============ */
  console.log('\nContext — leaving room for the answer');

  suite('older tool results are squeezed harder than the newest', () => {
    /* The free lanes cap context and output together, so six large results
       leave a few hundred tokens to answer with and the reply truncates. */
    const messages = [
      { role: 'user', content: 'q' },
      { role: 'tool', content: 'a'.repeat(9000) },
      { role: 'tool', content: 'b'.repeat(9000) },
      { role: 'tool', content: 'c'.repeat(9000) }
    ];
    const out = compact(messages);
    ok(out[1].content.length < 1200, 'the oldest is cut hardest');
    ok(out[3].content.length > 3000 && out[3].content.length < 4200, 'the newest keeps more, but is still capped');
  });

  suite('a short tool result is left exactly as it was', () => {
    const messages = [{ role: 'tool', content: 'small' }];
    eq(compact(messages)[0].content, 'small');
  });

  suite('the loop cannot run for ever', () => {
    ok(MAX_ROUNDS >= 3 && MAX_ROUNDS <= 8, 'rounds are bounded: ' + MAX_ROUNDS);
  });

  /* ============ search plumbing ============ */
  console.log('\nSearch plumbing — a result must name the page, not the engine');

  suite('a redirect wrapper is unwrapped to the real address', () => {
    const wrapped = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.gov.uk%2Fgovernment&rut=abc';
    eq(websearch.unwrap(wrapped), 'https://www.gov.uk/government');
  });

  suite('an engine\'s own pages are not results', () => {
    eq(websearch.usable('https://duckduckgo.com/settings'), false);
    eq(websearch.usable('https://www.gov.uk/a'), true);
    eq(websearch.usable('javascript:alert(1)'), false);
    eq(websearch.usable('file:///c:/secret'), false);
  });

  suite('results are varied rather than ten pages of one site', () => {
    const many = [];
    for (let i = 0; i < 8; i++) many.push({ url: 'https://one.com/' + i, title: 't' + i });
    many.push({ url: 'https://two.com/a', title: 'other' });
    const out = websearch.diversify(many);
    eq(out.filter(r => websearch.domainOf(r.url) === 'one.com').length, 2);
    ok(out.some(r => websearch.domainOf(r.url) === 'two.com'));
  });

  suite('the same page returned twice appears once', () => {
    const out = websearch.diversify([
      { url: 'https://a.com/x', title: 'x' },
      { url: 'https://a.com/x', title: 'x again' }
    ]);
    eq(out.length, 1);
  });
}

module.exports = { run };
