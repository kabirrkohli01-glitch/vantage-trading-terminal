'use strict';
/* The council.
 *
 * A question like "would you buy this, and where would you get in" is not one
 * question. It is eight, and they want different evidence and different habits
 * of mind: what the price has actually been doing, what the company is worth,
 * what it just reported, who has been buying it from the inside, what the sector
 * around it is doing, what is being written about it, and what would have to be
 * true for the whole idea to be wrong.
 *
 * Asking one model all of that at once produces the answer everybody has read a
 * thousand times: four hedged paragraphs that mention every consideration and
 * commit to none. Asking eight specialists one question each, giving each of
 * them only the evidence their question needs, and then having one of them write
 * the answer from their reports, produces something that reads like a desk.
 *
 * The shape is Karpathy's llm-council — several members answer, then a chairman
 * synthesises — with two changes that this application needs:
 *
 *   THE MEMBERS ARE SPECIALISTS, NOT COPIES. His council asks the same question
 *   of several different models to average out their weaknesses. There is one
 *   model behind this gateway, so averaging it against itself would buy nothing.
 *   Splitting the QUESTION instead buys the thing that actually matters: each
 *   pass reads a small, relevant slice of evidence closely rather than a large
 *   one loosely.
 *
 *   THE REVIEW IS AGAINST THE EVIDENCE, NOT AGAINST THE OTHER MEMBERS. Ranking
 *   answers by peer vote rewards the most confident one. The reviewer here is
 *   given the dossier and asked what in the answer is not supported by it, which
 *   is the failure that matters when the subject is somebody's money.
 *
 * THE REQUEST BUDGET IS REAL AND IS RESPECTED. The gateway allows a fixed number
 * of requests a minute, and a full council is eleven of them. The roster is
 * trimmed to what the allowance can pay for, the trimming is reported in the
 * answer rather than hidden, and specialists run in small waves rather than all
 * at once.
 */

const { MODE } = require('./gateway');
const evidence = require('./evidence');
const guards = require('./guards');

/* Every specialist: who it is, what it reads, and what it is for. The remit is
   written as an instruction to a person, because that is what produces a report
   rather than a summary. */
const SPECIALISTS = [
  {
    id: 'price',
    title: 'Price action',
    step: 'Reading the chart',
    sections: ['price'],
    remit: 'You read charts and nothing else. Say what the trend is on each window you were given and ' +
      'whether they agree. Say where the price sits between its levels, which level is nearest, and how ' +
      'far away it is in per cent. Say whether volume confirms the move or contradicts it. If the ' +
      'windows disagree — falling over a month inside a year that is rising — that disagreement IS the ' +
      'finding, so lead with it.'
  },
  {
    id: 'technicals',
    title: 'Momentum and indicators',
    step: 'Checking momentum',
    sections: ['price', 'reference'],
    remit: 'You read indicators. Report the RSI, the MACD relationship, where price is against each ' +
      'moving average, and the vendor\'s own technical summary. An extreme reading is a reading and not ' +
      'an instruction: an RSI of 78 in a strong uptrend means something different from an RSI of 78 at a ' +
      'ceiling it has failed at twice, and you are expected to say which of those this is. Give the ' +
      'volatility as a percentage of price, because the stop will be sized off it.'
  },
  {
    id: 'news',
    title: 'The story',
    step: 'Reading the news',
    sections: ['news'],
    remit: 'You read what is being reported. Separate what HAPPENED — a contract, a result, a ruling, a ' +
      'resignation — from what is merely being SAID about it. Give the two or three stories that would ' +
      'move the price and ignore the rest. Note whether the coverage is arriving before the move or after ' +
      'it. Quote a headline where it earns its space and name the publisher and the day.'
  },
  {
    id: 'fundamentals',
    title: 'The business',
    step: 'Reading the accounts',
    sections: ['fundamentals', 'reference'],
    remit: 'You read accounts. Say what the business earns, whether that is growing, what the margins ' +
      'are doing and how the balance sheet looks. Then say what it costs against that: the multiples, and ' +
      'whether they are high or low for what this business is. Where a figure is missing say so — a ' +
      'valuation built on three of the five numbers is worth saying out loud.'
  },
  {
    id: 'earnings',
    title: 'Earnings and events',
    step: 'Checking the earnings record',
    sections: ['fundamentals', 'reference', 'filings'],
    remit: 'You watch the reporting calendar. Say when this next reports and how many days away that is. ' +
      'Say how the last few reports landed against expectations. Flag anything in the recent filings that ' +
      'a holder would want to know about. If a result is imminent, say plainly that a position taken now ' +
      'is a position through an event, because that changes the size and not just the direction.'
  },
  {
    id: 'ownership',
    title: 'Insiders and ownership',
    step: 'Reading insider filings',
    sections: ['insider', 'reference'],
    remit: 'You read ownership. The only insider transactions that mean anything are open-market ' +
      'purchases and sales; grants, option exercises and shares withheld to pay tax on a grant are not ' +
      'decisions and you must not present them as selling. Say what the discretionary activity was, by ' +
      'whom, and in what size against their holding. EVERY TRANSACTION CARRIES A DATE — WORK OUT HOW LONG ' +
      'AGO THAT ACTUALLY WAS against the RIGHT NOW line in the evidence and say the real gap. A sale from ' +
      'nine months ago is not "recent" merely because it is the newest one on file, and a stop or a view ' +
      'anchored to it needs to say how stale that anchor is. Then give the float and the short interest, ' +
      'and say what that does to how the price moves on news.'
  },
  {
    id: 'positioning',
    title: 'Consensus and positioning',
    step: 'Weighing the consensus',
    sections: ['reference', 'news'],
    remit: 'You read what everyone else already thinks. Give the analyst consensus, the average target ' +
      'and the spread between the high and the low, and the distance from the current price in per cent. ' +
      'A wide spread means the outcome is genuinely disputed and that is worth more than the average. ' +
      'Say what is already in the price. Where consensus is crowded on one side, say what would happen if ' +
      'it were wrong.'
  },
  {
    id: 'sector',
    title: 'The sector and the tape',
    step: 'Reading the sector',
    sections: ['peers', 'sectors'],
    remit: 'You read relative strength. Say how the sector is trading and where this instrument sits ' +
      'inside it — leading, lagging, or moving with it. Compare it to the two or three peers that matter. ' +
      'Say whether money is moving into this part of the market or out of it, and whether the instrument\'s ' +
      'own move is its own or the whole shelf moving together.'
  },
  {
    id: 'risk',
    title: 'The case against',
    step: 'Building the case against',
    sections: ['price', 'reference', 'news', 'holding'],
    remit: 'YOUR JOB IS TO BE WRONG-FOOTED ON PURPOSE. Assume the obvious read is mistaken and argue ' +
      'that side properly, not as a disclaimer. Name the specific thing that would break it, the price at ' +
      'which the idea is finished, and how much room there is between here and there. If the operator ' +
      'already holds this, say what that changes. Do not hedge — a hedge is not the case against, it is ' +
      'the absence of one.'
  }
];

const BY_ID = Object.create(null);
SPECIALISTS.forEach(s => { BY_ID[s.id] = s; });

/* The roster used when the conductor cannot be reached, in the order that
   matters most for an instrument question. */
const DEFAULT_ROSTER = ['price', 'news', 'fundamentals', 'positioning', 'technicals', 'sector', 'risk'];

/* How many specialists run at once. Small enough that the gateway sees a queue
   rather than a burst, large enough that a full council is not a minute of
   waiting. */
const WAVE = 3;

/* Reserved out of the allowance for the chief and the reviewer, which must run
   or the council produces nothing at all. */
const RESERVED = 3;

class Council {
  constructor(options) {
    const opts = options || {};
    this.gateway = opts.gateway;
    this.context = opts.context || {};
    this.audit = opts.audit || null;
  }

  /* Does this question want the council?
   *
   * Deliberately decided in code rather than by asking the model, because a
   * model call to decide whether to make model calls costs a whole round and
   * tells us nothing the question does not already say. */
  static wants(question, symbol) {
    if (!symbol) return false;
    const text = String(question || '').toLowerCase();
    const asksForAView = /\b(buy|sell|short|long|enter|entry|exit|hold|add|trim|position|trade|target|stop)\b/.test(text);
    const asksForDepth = /\b(analys|analyz|deep|full|proper|thorough|breakdown|research|due diligence|worth it|what do you (think|reckon)|should i|would you)\b/.test(text);
    return asksForAView || asksForDepth;
  }

  /* One full run. `job` is the polled object the interface is watching, so every
     stage appends a step to it as it starts. */
  async run(job, question, dossier, options) {
    const opts = options || {};
    const step = opts.step || (() => {});
    const signal = job && job.controller ? job.controller.signal : null;

    const affordable = this.affordable();
    step('Planning the council', 'think');

    const plan = await this.conduct(question, dossier, affordable, signal).catch(() => null);
    const roster = (plan && plan.roster.length ? plan.roster : DEFAULT_ROSTER)
      .filter(id => BY_ID[id])
      .slice(0, affordable);

    const trimmed = roster.length < DEFAULT_ROSTER.length && affordable < DEFAULT_ROSTER.length;

    const reports = await this.gatherReports(roster, question, dossier, plan, step, signal);

    step('Writing the answer', 'think');
    let answer = await this.compose(question, dossier, reports, opts, signal);

    step('Checking it against the evidence', 'think');
    const review = await this.review(question, dossier, reports, answer, signal).catch(() => null);

    if (review && review.corrections.length) {
      step('Correcting what the check found', 'think');
      const revised = await this.revise(question, dossier, reports, answer, review, signal).catch(() => null);
      if (revised) answer = revised;
    }

    if (this.audit) {
      this.audit.write('syrix.council', {
        symbol: dossier.symbol,
        roster,
        reportsWritten: reports.filter(r => r.ok).length,
        corrections: review ? review.corrections.length : 0
      });
    }

    return {
      answer,
      roster: roster.map(id => ({ id, title: BY_ID[id].title })),
      /* The stance is read here, once, and travels with the report. The
         interface shows it as a chip beside the heading and never parses the
         text itself — two parsers for one format is two parsers that drift. */
      reports: reports.map(r => ({
        id: r.id, title: r.title, ok: r.ok,
        text: r.ok ? withoutStance(r.text) : null,
        stance: r.stance || null,
        reason: r.reason || null
      })),
      review: review || null,
      trimmed: trimmed ? 'The gateway allowance would not cover the whole council, so it ran with ' +
        roster.length + ' of ' + SPECIALISTS.length + ' specialists.' : null,
      missing: dossier.missing
    };
  }

  /* How many specialists this minute's allowance can pay for, leaving room for
     the stages that must run. */
  affordable() {
    const status = this.gateway.status();
    const left = Math.max(0, status.usage.perMinute - status.usage.lastMinute - RESERVED);
    return Math.max(2, Math.min(left, SPECIALISTS.length));
  }

  /* ---------- the conductor ---------- */

  /* Chooses the roster and gives each member something to look for. Runs on the
     fast lane: it is a routing decision, not an analysis, and spending the
     careful model on it would double the time to first output. */
  async conduct(question, dossier, affordable, signal) {
    const catalogue = SPECIALISTS.map(s => '- ' + s.id + ': ' + s.title).join('\n');
    const available = Object.keys(dossier.sections)
      .filter(name => dossier.sections[name].ok).join(', ');

    const reply = await this.gateway.chat({
      mode: MODE.BRIEF,
      maxTokens: 320,
      temperature: 0.2,
      signal,
      messages: [
        {
          role: 'system',
          content: 'You allocate work on a research desk. You do not analyse anything yourself.\n\n' +
            'Reply with JSON and nothing else, in this shape:\n' +
            '{"roster":["id","id"],"focus":{"id":"one sentence telling that specialist what to look for"}}\n\n' +
            'Pick at most ' + affordable + ' specialists, the ones this particular question actually needs, ' +
            'most important first. Always include "risk" unless the question is purely factual.'
        },
        {
          role: 'user',
          content: 'Question: ' + question + '\n\n' +
            evidence.heading(dossier) + '\n\n' +
            'Evidence available: ' + (available || 'very little') + '\n' +
            (dossier.missing.length ? 'Unavailable: ' + dossier.missing.map(m => m.label).join(', ') + '\n' : '') +
            '\nSpecialists:\n' + catalogue
      }]
    });

    return parsePlan(reply.text, affordable);
  }

  /* ---------- the specialists ---------- */

  async gatherReports(roster, question, dossier, plan, step, signal) {
    const out = [];

    for (let i = 0; i < roster.length; i += WAVE) {
      const wave = roster.slice(i, i + WAVE);
      wave.forEach(id => step(BY_ID[id].step, 'agent', id));

      const written = await Promise.all(wave.map(id => this.oneReport(id, question, dossier, plan, signal)));
      out.push(...written);
    }

    return out;
  }

  async oneReport(id, question, dossier, plan, signal) {
    const specialist = BY_ID[id];
    const focus = plan && plan.focus && plan.focus[id];

    const slices = specialist.sections
      .map(name => '## ' + name.toUpperCase() + '\n' + evidence.sectionText(dossier, name))
      .join('\n\n');

    try {
      const reply = await this.gateway.chat({
        mode: MODE.CHAT,
        maxTokens: 520,
        temperature: 0.3,
        signal,
        messages: [
          {
            role: 'system',
            content: 'You are the ' + specialist.title.toLowerCase() + ' specialist on a market research desk.\n\n' +
              specialist.remit + '\n\n' +
              'HOW YOU REPORT.\n' +
              '- Under 180 words. You are one voice of several and the desk lead reads all of them.\n' +
              '- Every number you use must appear in the evidence below. You have no other source and no ' +
              'memory of this instrument. If a figure you need is not there, say it is not there.\n' +
              '- End with exactly one line: "STANCE: bullish|bearish|neutral, confidence low|medium|high" ' +
              'and one clause saying what would change it.\n' +
              '- No preamble, no restating the question, no disclaimer.'
          },
          {
            role: 'user',
            content: evidence.heading(dossier) + '\n\n' +
              'THE QUESTION BEING ANSWERED BY THE DESK: ' + question + '\n' +
              (focus ? 'YOUR BRIEF: ' + focus + '\n' : '') +
              '\nYOUR EVIDENCE:\n\n' + slices
          }
        ]
      });

      const text = guards.dropToolSyntax(guards.dropCitationMarkers(reply.text || '')).trim();
      if (!text) return { id, title: specialist.title, ok: false, reason: 'wrote nothing' };
      return { id, title: specialist.title, ok: true, text, stance: readStance(text) };
    } catch (err) {
      return { id, title: specialist.title, ok: false, reason: String((err && err.message) || err) };
    }
  }

  /* ---------- the chief ---------- */

  async compose(question, dossier, reports, opts, signal) {
    const written = reports.filter(r => r.ok);
    const body = written.map(r => '### ' + r.title + '\n' + r.text).join('\n\n');
    const failed = reports.filter(r => !r.ok);

    const reply = await this.gateway.chat({
      mode: MODE.CHAT,
      maxTokens: 2000,
      temperature: 0.45,
      signal,
      messages: [
        { role: 'system', content: chiefBrief(dossier) },
        {
          role: 'user',
          content: 'THE QUESTION: ' + question + '\n\n' +
            evidence.heading(dossier) + '\n\n' +
            'YOUR DESK REPORTED:\n\n' + body +
            (failed.length ? '\n\nThese specialists could not report: ' +
              failed.map(f => f.title + ' (' + f.reason + ')').join(', ') : '') +
            (dossier.missing.length ? '\n\nEvidence that could not be gathered at all: ' +
              dossier.missing.map(m => m.label + ' — ' + m.reason).join('; ') : '')
        }
      ],
      onToken: opts.onToken
    });

    return guards.dropToolSyntax(guards.dropCitationMarkers(reply.text || '')).trim();
  }

  /* ---------- the reviewer ---------- */

  /* Checks the written answer against the dossier rather than against taste.
     Three failures matter and nothing else does: a figure that was invented, a
     claim the evidence contradicts, and a question that was not answered. */
  async review(question, dossier, reports, answer, signal) {
    const reply = await this.gateway.chat({
      mode: MODE.CHAT,
      maxTokens: 420,
      temperature: 0.1,
      signal,
      messages: [
        {
          role: 'system',
          content: 'You check a written market note against the evidence it was written from. ' +
            'You are not an editor: style, length and tone are none of your business.\n\n' +
            'Look for exactly three things.\n' +
            '1. A NUMBER IN THE NOTE THAT IS NOT IN THE EVIDENCE. Arithmetic on two numbers that are ' +
            'both there is fine; a figure that appeared from nowhere is not.\n' +
            '2. A CLAIM THE EVIDENCE CONTRADICTS.\n' +
            '3. THE QUESTION NOT ACTUALLY ANSWERED. If it asked where to get in and there is no price, ' +
            'that is a failure.\n\n' +
            'Reply with JSON and nothing else: {"corrections":["one sentence each"]}. ' +
            'An empty list is the expected answer and you should not invent work.'
        },
        {
          role: 'user',
          content: 'THE QUESTION: ' + question + '\n\n' +
            'THE EVIDENCE:\n' + evidence.heading(dossier) + '\n\n' +
            reports.filter(r => r.ok).map(r => r.title + ': ' + r.text).join('\n\n') +
            '\n\nTHE NOTE:\n' + answer
        }
      ]
    });

    return parseReview(reply.text);
  }

  async revise(question, dossier, reports, answer, review, signal) {
    const reply = await this.gateway.chat({
      mode: MODE.CHAT,
      maxTokens: 2000,
      temperature: 0.35,
      signal,
      messages: [
        { role: 'system', content: chiefBrief(dossier) },
        { role: 'user', content: 'THE QUESTION: ' + question + '\n\n' + evidence.heading(dossier) },
        { role: 'assistant', content: answer },
        {
          role: 'user',
          content: 'A check against the evidence found these problems:\n' +
            review.corrections.map(c => '- ' + c).join('\n') +
            '\n\nRewrite the note with each of them fixed. Keep everything that was not a problem, ' +
            'including the position and the numbers that were supported. Do not add a note about ' +
            'having revised it.'
        }
      ]
    });

    const revised = guards.dropToolSyntax(guards.dropCitationMarkers(reply.text || '')).trim();
    return revised.length > 200 ? revised : null;
  }
}

/* THE BRIEF THAT DECIDES WHETHER THIS IS USEFUL OR NOT.
 *
 * The assistant used to describe and refuse to conclude, on the reasoning that a
 * conclusion about money is a recommendation and a recommendation is a
 * liability. That produced an assistant that could read every filing a company
 * had ever made and would not say whether it liked the look of it — which is
 * both useless and, on a private terminal with one user who built it, dishonest
 * about what it actually thinks.
 *
 * So it takes a position. The discipline that replaces the refusal is stricter
 * and more useful than the refusal was: a position is only worth anything if it
 * comes with the price that proves it wrong. */
function chiefBrief(dossier) {
  return [
    'You are SYRIX, the lead analyst on a private market desk. One person reads what you write: the ' +
      'operator of this terminal, who built it. They are not a client and you are not a compliance ' +
      'department.',
    '',
    'YOU TAKE A POSITION. When you are asked what you would do, answer it. A direction, a price to act ' +
      'at, a price that proves the idea wrong, and somewhere you think it goes. "It depends on your risk ' +
      'tolerance" is not an answer and neither is a list of considerations. If the honest answer is that ' +
      'there is no trade here worth taking, say that — that is a position too, and it is often the right ' +
      'one.',
    '',
    'THE DISCIPLINE THAT MAKES A POSITION WORTH READING:',
    '- Every number comes from the desk reports below. You have no memory of this instrument and no ' +
      'other source. A figure you cannot point at is a figure you do not use.',
    '- The invalidation is not optional. If you cannot name the price at which you would be wrong, you do ' +
      'not have a view, you have a feeling.',
    '- Say what the position is risking against what it stands to make, in the instrument\'s own currency.',
    '- Give the case against properly, in its own right, not as a closing disclaimer.',
    '- Where the specialists disagreed, say so and say which side you came down on and why. Disagreement ' +
      'between the chart and the accounts is information, not noise to be averaged away.',
    '- Where evidence was missing, name it. An answer built without the accounts is a different answer ' +
      'from one built with them and the reader must be able to tell.',
    '- When the evidence carries more than one period for the same thing — revenue, cash, a margin, a net ' +
      'result — the most recent one is the one you lead with and the one an entry or a stop is built on. ' +
      'An older figure only belongs in the answer as a comparison, named as what period it is from, never ' +
      'silently in place of the current one because it happens to read better.',
    '- Every dated fact — a filing, an insider sale, an estimate — carries the gap between then and RIGHT ' +
      'NOW in the evidence, worked out and stated, not eyeballed. Something from nine months ago is not ' +
      '"recent" because it is the newest one on file, and a level anchored to a stale fact says so.',
    '',
    'THE DATA STATE ON THE PRICE GOVERNS EVERYTHING. It is ' + dossier.dataState.label + ' — ' +
      dossier.dataState.reason + '. If that is not live, an entry level is a level and not an order, and ' +
      'you say so once, plainly, rather than hedging every sentence. Where the evidence carries a current ' +
      'pre- or post-market price as well as the regular close, that pre- or post-market figure is the ' +
      'current one — build the entry from it and say the regular close is not the live figure right now.',
    '',
    'HOW IT READS: markdown. A short heading, then the answer. Use a table where a table is genuinely ' +
      'clearer than sentences — a level, a target, a set of multiples — and prose everywhere else. Bold ' +
      'the direction and the levels so they can be found without reading. British spelling. No preamble, ' +
      'no "great question", no summary of what you are about to say. Write like somebody who has read all ' +
      'of it and is telling a colleague what they think.'
  ].join('\n');
}

/* ---------- reading what came back ---------- */

/* Models wrap JSON in prose and in code fences however firmly they are asked not
   to. The object is found rather than assumed to be the whole reply. */
function extractJson(text) {
  const source = String(text || '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source);
  const candidate = fenced ? fenced[1] : source;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch (e) { return null; }
}

function parsePlan(text, affordable) {
  const parsed = extractJson(text);
  if (!parsed) return null;
  const roster = (Array.isArray(parsed.roster) ? parsed.roster : [])
    .map(id => String(id).trim().toLowerCase())
    .filter(id => BY_ID[id]);
  if (!roster.length) return null;

  const focus = Object.create(null);
  if (parsed.focus && typeof parsed.focus === 'object') {
    Object.keys(parsed.focus).forEach(id => {
      if (BY_ID[id] && typeof parsed.focus[id] === 'string') focus[id] = parsed.focus[id].slice(0, 300);
    });
  }
  return { roster: roster.slice(0, affordable), focus };
}

function parseReview(text) {
  const parsed = extractJson(text);
  const list = parsed && Array.isArray(parsed.corrections) ? parsed.corrections : [];
  return {
    corrections: list
      .filter(entry => typeof entry === 'string' && entry.trim().length > 8)
      .map(entry => entry.trim().slice(0, 300))
      .slice(0, 6)
  };
}

/* The single stance line each specialist ends on, so the interface can show
 * where the desk stood without the reader opening every report.
 *
 * READ LOOSELY, ON PURPOSE. The brief asks for one exact form and models write
 * it a dozen ways: bold around the label, a colon after "confidence", the
 * confidence before the view, a dash instead of a comma. A parser that insists
 * on the exact phrasing found one stance out of seven and reported the rest as
 * having no view at all — which is a parsing failure presented as a desk that
 * would not commit. The line is found by its label, and the two words that
 * matter are picked out of whatever surrounds them. */
function readStance(text) {
  const line = String(text || '').split('\n').reverse()
    .find(candidate => /stance/i.test(candidate));
  if (!line) return null;

  const view = /\b(bullish|bearish|neutral)\b/i.exec(line);
  const confidence = /\b(low|medium|moderate|high)\b/i.exec(line);
  if (!view) return null;

  const level = confidence ? confidence[1].toLowerCase() : 'medium';
  return {
    view: view[1].toLowerCase(),
    confidence: level === 'moderate' ? 'medium' : level
  };
}

/* The stance line is removed from the report body before it is shown, because
   it is rendered as a chip beside the heading instead. Removed by the line it
   sits on rather than by a prefix, so a bold or otherwise decorated label goes
   with it. */
function withoutStance(text) {
  return String(text || '').split('\n')
    .filter(line => !/stance/i.test(line) || !/\b(bullish|bearish|neutral)\b/i.test(line))
    .join('\n')
    .trim();
}

module.exports = {
  Council, SPECIALISTS, DEFAULT_ROSTER, chiefBrief,
  extractJson, parsePlan, parseReview, readStance, withoutStance
};
