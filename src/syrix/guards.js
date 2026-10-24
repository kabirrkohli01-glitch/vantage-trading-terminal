'use strict';
/* What is done to an answer before it is shown.
 *
 * A language model behind a general assistant produces two kinds of problem
 * that a prompt alone does not reliably fix, because the prompt is advice and
 * these are structural.
 *
 *   IT LEAKS ITS OWN PROCESS. "We need to answer the user… Let's craft the
 *   answer:" arrives at the top of otherwise good replies. Anchoring on what an
 *   ANSWER looks like — the first heading, list item or ordinary sentence —
 *   and dropping what precedes it, works. Enumerating the phrases models use to
 *   narrate does not, because there is always another one.
 *
 *   IT TURNS A MEASUREMENT INTO AN INSTRUCTION. This is the one that matters in
 *   a financial application. "RSI is 28" is a reading. "RSI is 28, so this is a
 *   buy" is advice, and this application does not give advice. The rule is
 *   narrow on purpose: it removes recommendations to trade, and leaves every
 *   other kind of suggestion alone, because the assistant answers ordinary
 *   questions too and telling someone which headphones to consider is not the
 *   same act.
 *
 * Nothing here ever empties an answer. If a guard would remove everything, the
 * original is kept — a blank reply is worse than an imperfect one.
 */

const { num } = require('../core/num');

/* ---------- narration ---------- */

const NARRATION = /^(we need to|we should|the user (is|wants|asks|has)|let me|let's|i need to|i should|first,? i|okay,? (so|let)|alright,? (so|let)|thinking|reasoning|plan:|approach:)/i;

/* Something that looks like the start of an actual answer. */
function looksLikeAnswer(line) {
  const text = line.trim();
  if (!text) return false;
  if (/^#{1,6}\s/.test(text)) return true;          // a heading
  if (/^[-*•]\s/.test(text)) return true;           // a bullet
  if (/^\d+[.)]\s/.test(text)) return true;         // a numbered point
  if (/^\*\*[^*]+\*\*/.test(text)) return true;     // a bold label
  if (NARRATION.test(text)) return false;
  /* An ordinary sentence of reasonable length. */
  return text.length > 25;
}

function stripNarration(text) {
  const lines = String(text || '').split('\n');
  let start = -1;
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    if (looksLikeAnswer(lines[i])) { start = i; break; }
  }
  /* No anchor found means we cannot tell narration from answer, and cutting
     blindly would produce a blank reply. */
  if (start <= 0) return text;
  const kept = lines.slice(start).join('\n').trim();
  return kept.length > 40 ? kept : text;
}

/* ---------- taking a position ----------
 *
 * THERE WAS A GUARD HERE THAT DELETED TRADING VIEWS AND IT HAS BEEN REMOVED
 * DELIBERATELY. It found sentences that named an action and a direction — "I'd
 * buy this here", "that is a sell" — and cut them out of the answer.
 *
 * The reasoning behind it was that a conclusion about money is a recommendation
 * and a recommendation is a liability. That reasoning does not survive contact
 * with what this application is: a private terminal with a single user, who
 * built it, and who asked it what it thinks. An assistant that reads every
 * filing a company has made and then declines to say whether it likes the look
 * of it is not being careful. It is withholding the only part of the answer that
 * took any judgement, and it was doing so while still publishing the readings
 * that implied the conclusion, which is the worst of both.
 *
 * WHAT REPLACED IT IS STRICTER, NOT LOOSER, and it lives in council.js and in
 * the brief rather than here: a view is only accepted with the price that would
 * prove it wrong, every figure has to appear in evidence that was actually
 * fetched, and a separate pass checks the finished answer against that evidence.
 * A guard that deletes the conclusion cannot tell a good one from a bad one; a
 * check against the evidence can.
 *
 * The other guards in this file are unchanged and still apply. Narration,
 * citation artefacts, repetition, leaked tool syntax and truncation are faults
 * in the writing whatever the answer concludes.
 */

/* ---------- repetition ---------- */

/* STRUCTURE IS NOT REPETITION AND MUST NOT BE TREATED AS IT.
 *
 * Answers are markdown now, and markdown repeats itself on purpose: a table has
 * a rule under its header, a list of levels has a row per level, a set of
 * sections has the same sub-heading in each. A deduplicator that does not know
 * this eats the second row of every two-row table and the answer arrives
 * malformed. Anything that is structure rather than prose is passed through
 * untouched. */
function isStructural(line) {
  const text = line.trim();
  if (!text) return false;
  return /^\|/.test(text) ||                    // a table row or its rule
    /^#{1,6}\s/.test(text) ||                    // a heading
    /^[-*+]\s/.test(text) ||                     // a bullet
    /^\d+[.)]\s/.test(text) ||                   // a numbered point
    /^>/.test(text) ||                           // a quotation
    /^(-{3,}|\*{3,}|_{3,})$/.test(text) ||       // a rule
    /^[^:]{1,40}:\s*\S/.test(text);              // a label and its value
}

function dropRepeats(text) {
  const seen = new Set();
  const out = [];
  let previous = null;
  let inFence = false;

  String(text || '').split('\n').forEach(line => {
    /* A fenced block is somebody's code or data and is never touched. */
    if (/^\s*```/.test(line)) { inFence = !inFence; out.push(line); previous = null; return; }
    if (inFence) { out.push(line); return; }

    const key = line.trim().toLowerCase();
    if (!key) { out.push(line); previous = null; return; }

    if (isStructural(line)) { out.push(line); previous = null; return; }

    /* Consecutive duplicates go at any length; a repeat further away only
       counts once the line is long enough to be a real sentence rather than a
       shared label. */
    if (key === previous) return;
    if (key.length > 30 && seen.has(key)) return;

    seen.add(key);
    out.push(line);
    previous = key;
  });

  return out.join('\n');
}

/* ---------- leaked tool names ---------- */

/* Tool names are English phrases, so they can appear as ordinary words. Only
   the underscored forms are rewritten, which is how a leak actually looks. */
function dropToolNames(text, labels) {
  let out = String(text || '');
  Object.keys(labels || {}).forEach(name => {
    if (name.indexOf('_') === -1) return;
    out = out.split(name).join(labels[name]);
  });
  return out;
}

/* ---------- citation artefacts ---------- */

/* Models emit their own citation markers, and the shapes differ by lane.
 *
 * One arrived here as a JSON object inside full-width brackets —
 * 【{"id":0,"cursor":0,"loc":0}】 — appended to an otherwise clean sentence.
 * These are an artefact of how a provider annotates retrieved text, they mean
 * nothing outside its own interface, and they read as corruption. The sources
 * this application shows come from what was actually called, not from these. */
const CITATION = [
  /\u3010[^\u3011]*\u3011/g,                     // full-width brackets, any contents
  /\u3010[^\u3011]*$/g,                           // and one cut off by a token ceiling
  /[\uE000-\uF8FF]+/g,                            // private-use wrappers some lanes emit
  /\[\s*(?:citation|source|ref)\s*:\s*[^\]]*\]/gi,
  /\[\[\s*\d+\s*\]\]/g                       // numeric reference markers
];

function dropCitationMarkers(text) {
  let out = String(text || '');
  CITATION.forEach(pattern => { out = out.replace(pattern, ''); });
  /* Removing a marker mid-sentence leaves a space before the full stop. */
  return out.replace(/[ \t]+([.,;:!?])/g, '$1').replace(/[ \t]{2,}/g, ' ');
}

/* ---------- truncation ---------- */

/* A generation cut off by a token ceiling ends mid-sentence. Removing the
   fragment is better than showing it, but only when there is a complete
   sentence before it to fall back to. */
function dropTrailingFragment(text) {
  const source = String(text || '').trimEnd();
  if (!source) return source;
  if (/[.!?:)`"”\]|]$/.test(source)) return source;
  /* A list item, heading or table row is complete without punctuation. */
  const lines = source.split('\n');
  const last = lines[lines.length - 1].trim();
  if (isStructural(last) && last.length > 12) return source;
  /* An unclosed fence means the whole tail is inside a code block, where a
     sentence ending is not expected and cutting one out would break it. */
  if ((source.match(/```/g) || []).length % 2 === 1) return source;

  const cut = Math.max(source.lastIndexOf('. '), source.lastIndexOf('.\n'), source.lastIndexOf('!\n'), source.lastIndexOf('?\n'));
  if (cut < source.length * 0.5) return source;
  return source.slice(0, cut + 1);
}

/* ---------- evidence ---------- */

/* Which figures in an answer cannot be traced to anything a tool returned.
 *
 * This does not edit the answer. A model legitimately produces numbers by
 * arithmetic — a percentage change from two prices it was given — and deleting
 * those would be wrong. What it does is report which figures have no source, so
 * the interface can mark them and the operator knows which parts to check.
 */
function unsourcedFigures(text, toolResults) {
  const haystack = JSON.stringify(toolResults || []).replace(/[",]/g, ' ');
  /* The source figures themselves, so a stated figure can be compared against
     them numerically rather than only as text. */
  const sourceNumbers = (haystack.match(/-?\d+(?:\.\d+)?/g) || [])
    .map(Number).filter(Number.isFinite);
  const found = [];

  /* Figures worth checking: something with a decimal point, a thousands
     separator, or a currency or percent marker. A bare small integer is
     usually prose ("three reasons") and flagging it is noise. */
  const candidates = String(text || '').match(/[£$€¥]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*\.\d+\b|\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?%/g) || [];

  Array.from(new Set(candidates)).forEach(candidate => {
    const bare = candidate.replace(/[£$€¥%,\s]/g, '');
    const value = num(bare);
    if (value === null) return;
    /* A year is prose, not a claim needing a source. */
    if (/^(19|20)\d{2}$/.test(bare)) return;

    if (haystack.indexOf(bare) !== -1) return;

    /* ROUNDING IS CHECKED FROM THE SOURCE TOWARDS THE ANSWER, not the other way
       round. A source figure of 130.497 written as 130.5 has been rounded, not
       invented — but rounding 130.5 does not produce 130.497, so comparing in
       that direction flags every honest restatement. Each source figure is
       rounded to the precision the answer used and compared with it. */
    const decimals = (bare.split('.')[1] || '').length;
    if (sourceNumbers.some(n => Number(n.toFixed(decimals)) === value)) return;

    /* Companies report in units and answers speak in billions. A stated figure
       that matches a source figure at a thousand, a million or a billion times
       its size is the same figure in different clothes. */
    const scales = [1e3, 1e6, 1e9, 1e12];
    if (sourceNumbers.some(n => scales.some(scale =>
      Math.abs(n / scale - value) < Math.pow(10, -decimals) / 2))) return;

    found.push(candidate);
  });

  return found;
}

/* ---------- the checked line ---------- */

/* Built from what was ACTUALLY called, not from what the answer claims. A
   figure stated without a matching source is visible as a gap between the two. */
function checkedLine(used, sourceLabel) {
  if (!used || !used.length) return null;
  const labels = [];
  used.forEach(call => {
    const label = sourceLabel(call.name, call.args);
    if (label && labels.indexOf(label) === -1) labels.push(label);
  });
  if (!labels.length) return null;
  return 'Checked: ' + labels.join(' · ');
}

/* ---------- composition ---------- */

/* The machinery of a tool call, which the operator must never be shown.
 *
 * A model asks for a tool by emitting markup that the transport is supposed to
 * intercept and turn into a structured call. When that call is cut short — a
 * token ceiling, a dropped stream, a shape the transport does not recognise —
 * the markup is not intercepted and simply stays in the prose. The answer then
 * ends mid-thought in a spray of closing tags, which is not a bad answer but no
 * answer at all, and it reads as the assistant talking in code.
 *
 * `hasToolSyntax` lets the loop notice that the round failed and go round
 * again; this strips it as the last line of defence, so a fragment can never
 * reach the screen even if something upstream misses it. */
/* THE SEPARATOR AFTER THE TAG NAME IS NOT ALWAYS A SPACE. Models emit these in
   several dialects — `<function name="search">`, `<function=search>`,
   `</function>` — and a pattern that only allowed whitespace matched the
   closing tags while letting every opening one through, which left the reply
   reading as `<function=a web search>`. Any of space, equals or the end of the
   tag is accepted. */
const TOOL_SYNTAX = [
  /<\/?(?:tool_call|tool_response|function_calls|invoke|antml:[a-z_]+)(?:[=\s][^>]*)?>/gi,
  /<\/?(?:function|parameter)(?:[=\s][^>]*)?>/gi,
  /<\|(?:tool_call|tool_response|im_start|im_end)[^|]*\|>/gi
];

function hasToolSyntax(text) {
  return TOOL_SYNTAX.some(pattern => { pattern.lastIndex = 0; return pattern.test(String(text || '')); });
}

/* Recover a tool call the model wrote into its prose.
 *
 * THE CALL IS NOT LOST, ONLY MISDELIVERED. When the transport does not
 * recognise the shape a model used, the request is still there in full — the
 * tool it wanted and the arguments it wanted to pass — sitting in the text.
 * Discarding it and asking again spends another round to get the same answer,
 * and often the same mistake. Reading it out and running it turns a dead turn
 * into a working one.
 *
 * Three dialects are understood, which is every one this gateway has produced:
 *
 *   <function=name><parameter=key>value</parameter></function>
 *   <function name="name"><parameter name="key">value</parameter></function>
 *   <tool_call>{ "name": "…", "arguments": { … } }</tool_call>
 *
 * The name is matched against the tools that actually exist, because a model
 * that has mangled the syntax has often also written the tool's description
 * where its name belongs. Anything that cannot be matched to a real tool is not
 * guessed at — it is left for the caller to handle as a failed round. */
function parseToolCalls(text, names) {
  const source = String(text || '');
  const known = Array.isArray(names) ? names : [];
  const out = [];

  const resolve = wanted => {
    const raw = String(wanted || '').trim().replace(/^["']|["']$/g, '');
    if (!raw) return null;
    const exact = known.find(name => name.toLowerCase() === raw.toLowerCase());
    if (exact) return exact;
    /* "a web search" against "search_the_web": compare the words each is made
       of, ignoring order and the joining words a description carries. */
    const words = t => String(t).toLowerCase().split(/[^a-z0-9]+/).filter(w => w && w.length > 2 && w !== 'the');
    const wantedWords = words(raw);
    if (!wantedWords.length) return null;
    let best = null;
    known.forEach(name => {
      const shared = words(name).filter(w => wantedWords.indexOf(w) !== -1).length;
      if (shared && (!best || shared > best.shared)) best = { name, shared };
    });
    return best ? best.name : null;
  };

  const blocks = source.match(/<function[=\s][\s\S]*?<\/function>/gi) || [];
  blocks.forEach((block, i) => {
    const named = /<function(?:=|\s+name\s*=\s*)["']?([^">\n]+)["']?\s*>/i.exec(block);
    const name = resolve(named && named[1]);
    if (!name) return;

    const args = {};
    const params = block.match(/<parameter[=\s][\s\S]*?<\/parameter>/gi) || [];
    params.forEach(param => {
      const key = /<parameter(?:=|\s+name\s*=\s*)["']?([^">\n]+)["']?\s*>/i.exec(param);
      const value = /<parameter[^>]*>([\s\S]*?)<\/parameter>/i.exec(param);
      if (key && value) args[String(key[1]).trim()] = value[1].trim();
    });
    out.push({ id: 'recovered_' + i, name, args });
  });

  if (!out.length) {
    const json = source.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
    if (json) {
      try {
        const parsed = JSON.parse(json[1]);
        const name = resolve(parsed.name);
        if (name) out.push({ id: 'recovered_0', name, args: parsed.arguments || parsed.args || {} });
      } catch (e) { /* not the JSON dialect after all */ }
    }
  }

  /* A call with no arguments at all is a shell the model never filled in, and
     running it would search for nothing. */
  return out.filter(call => Object.keys(call.args).length > 0);
}

/* A reply that is not an answer to anything.
 *
 * The wreckage of a lost tool call does not always arrive wrapped in markup.
 * Just as often what is left is the argument on its own — a bare address the
 * model was about to read, or the search phrase it was about to run — sitting
 * there as the entire reply. It has no verb, no sentence and no relation to the
 * question, and handing it over is worse than saying nothing, because it looks
 * like an answer until it is read.
 *
 * Deliberately narrow. A short reply is often the right one: "About 24 per
 * cent." and "No, it does not." are complete answers and must survive. What is
 * caught is a fragment with no sentence in it at all. */
function looksUnanswered(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return true;

  const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) return false;

  const only = lines[0];
  /* A whole reply that is one address is a fetch that never happened. */
  if (/^<?https?:\/\/\S+>?$/i.test(only)) return true;

  /* Prose ends in punctuation. Anything that does is a statement. */
  if (/[.!?:)"'\]]$/.test(only)) return false;

  /* A figure on its own is a complete answer to a question about a figure —
     "$213.05" and "24%" both are — so a fragment carrying one is left alone. */
  if (/[£$€¥]\s?\d|\d\s?%|^\s*-?[\d,.]+\s*$/.test(only)) return false;

  /* What is left: a run of words with no sentence in it. Two words or fewer is
     as likely to be a name as a query, so the catch starts at three. */
  const words = only.split(/\s+/).filter(Boolean);
  return words.length >= 3 && words.length <= 12;
}

function dropToolSyntax(text) {
  let out = String(text || '');
  TOOL_SYNTAX.forEach(pattern => { out = out.replace(pattern, ' '); });
  /* A call is commonly preceded by the name of what it was about to fetch, on
     its own line, with nothing after it. That orphan line goes with the tags. */
  return out.split('\n')
    .filter((line, i, all) => !(line.trim() && i === all.length - 1 && !/[.!?]$/.test(line.trim()) && line.trim().length < 60 && all.length > 1))
    .join('\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clean(text, options) {
  const opts = options || {};
  /* Tool-call machinery comes off before anything else looks at the text: every
     guard below reasons about sentences, and a stray closing tag is not one. */
  let out = dropToolSyntax(text);
  /* Citation artefacts come off next. They sit mid-sentence, so leaving them
     in would break sentence splitting for every guard that follows. */
  out = dropCitationMarkers(out);
  out = stripNarration(out);
  out = dropRepeats(out);
  if (opts.toolLabels) out = dropToolNames(out, opts.toolLabels);
  out = dropTrailingFragment(out);
  /* A final tidy. Removing a citation marker or a sentence leaves a space
     stranded before the punctuation that followed it, and models sometimes
     emit that spacing unprompted. Either way it reads as a typo.
   *
     A table row is exempt: its cells are padded with spaces on purpose and
     squeezing them turns an aligned table into a ragged one. */
  out = out.split('\n').map(line => (/^\s*\|/.test(line) ? line
    : line.replace(/[ \t]+([.,;:!?%)])/g, '$1').replace(/([(£$€¥])[ \t]+/g, '$1'))).join('\n');

  return {
    text: out.trim(),
    unsourced: opts.toolResults ? unsourcedFigures(out, opts.toolResults) : []
  };
}

module.exports = {
  clean, stripNarration, dropRepeats, dropToolNames,
  dropCitationMarkers, dropTrailingFragment, unsourcedFigures,
  checkedLine, looksLikeAnswer, isStructural,
  hasToolSyntax, dropToolSyntax, looksUnanswered, parseToolCalls
};
