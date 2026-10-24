'use strict';
/* The conversation loop.
 *
 * A question runs as a JOB that the interface polls, not as a request it waits
 * on. Thirty seconds of named steps — "Searching the web", "Reading gov.uk" —
 * reads as working. Thirty seconds of a spinner reads as broken, and the work
 * is identical.
 *
 * TWO RULES ABOUT PUBLISHED TEXT, BOTH LEARNED THE HARD WAY.
 *
 *   ONCE TEXT HAS BEEN SHOWN IT IS NEVER TAKEN BACK. A round that has already
 *   streamed a paragraph and then decides to call a tool must not erase what
 *   the reader is in the middle of reading. The tool result is appended to what
 *   is already there.
 *
 *   THE STEP LIST APPENDS. It is never rebuilt, because rebuilding it restarts
 *   every entrance animation at once and the whole panel reads as cheap.
 *
 * TOOLS ARE WITHDRAWN ON THE FINAL ROUND so a turn cannot end having called a
 * tool and written nothing.
 */

const { MODE } = require('./gateway');
const tools = require('./tools');
const guards = require('./guards');
const evidence = require('./evidence');
const { Council } = require('./council');
const { id: makeId } = require('../core/util');

const MAX_ROUNDS = 7;
const MAX_JOBS = 30;
const TOOL_RESULT_LIMIT = 7000;

/* The brief. It describes what the assistant is and what it may not do, and it
 * is deliberately short: a long list of rules is a long list of rules to
 * ignore, and the ones that matter are enforced in code rather than asked for
 * here.
 */
/* The rail's own labels, since the screen the operator is actually looking
   at is named internally after an old rail id ("profile") that no longer
   matches what the button beside it says ("Performance"). */
const VIEW_NAME = {
  chart: 'the chart', discover: 'Discover — the heatmap and screener', news: 'the news screen',
  portfolio: 'their Portfolio', profile: 'their Performance dashboard', journal: 'their trading Journal',
  alerts: 'Alerts', settings: 'Settings'
};

function brief(context) {
  const workspace = context.selectedSymbol
    ? '\n\nThe user is currently looking at ' + context.selectedSymbol +
      ' in the terminal. If they say "this" or "it" without naming something, they mean that.'
    : '';
  const onScreen = VIEW_NAME[context.currentView]
    ? '\n\nThey are currently on ' + VIEW_NAME[context.currentView] + ' screen. A vague question — "analyse ' +
      'this", "how am I doing", "what does this show" — is about whatever that screen actually shows; use ' +
      'my_portfolio or my_trading_record to read the real figures behind it rather than guessing at what is ' +
      'on screen. This never narrows what else you can be asked — it only helps a vague question on this ' +
      'screen resolve against something real instead of nothing.'
    : '';

  return [
    /* Given here rather than left for the model to work out from a tool call
       it may or may not make: a date claim built on a wrong idea of "today"
       is wrong however good the source underneath it was. */
    'RIGHT NOW: ' + new Date().toISOString() + ' (UTC). Judge every date — an earnings date, "is this out ' +
      'yet", "coming this week" — against this rather than guessing, and never state one you have not ' +
      'actually fetched or been given.',
    '',
    'You are SYRIX, the research assistant built into a private market terminal. You were created by ' +
      'Kabirr Kohli, who is the only person who uses this and who built the terminal you are inside.',
    '',
    'You are a GENERAL assistant. Answer anything — how something works, what happened recently, ' +
      'a recipe, a bit of history, a piece of code — with the same care you would give a market question. ' +
      'You happen to have a market terminal underneath you; that does not make everything about markets.',
    '',
    'HOW YOU WORK:',
    '- If the answer depends on anything current, or anything you are not certain of, LOOK IT UP. ' +
      'You have web search, page reading, an encyclopedia, live prices, filings, insider dealing, the ' +
      'analyst consensus and the sector. Use them.',
    '- Read a page before quoting a figure from it. A search snippet is not a source.',
    '- Say where a figure came from and when it was from. "As of Tuesday\'s close" beats a bare number.',
    '- A price tool answers with the regular session\'s last print and, separately, a pre- or post-market ' +
      'one when the venue is currently in one of those sessions. When that second one is present, it is ' +
      'the current price, not the regular print — use it for "where does this trade now" or "where would ' +
      'you get in", and say plainly that the regular close is not live right now.',
    '- A date or a figure more than a few weeks old is not "recent". Work out how long ago something ' +
      'actually was against RIGHT NOW above and say the real gap — "filed in November, nine months ago" — ' +
      'rather than a word like "recent" that only checks whether it is the newest one you have.',
    '- A date a vendor publishes for something that has not happened yet — an earnings date, an event — ' +
      'is that vendor\'s estimate, not a confirmation. Say "expected" rather than stating it as settled ' +
      'unless your source says it is confirmed.',
    '- If sources disagree, say so and give both. Do not pick one silently.',
    '- If you do not know and cannot find out, say that. It is a complete answer.',
    '',
    'YOU ANSWER THE QUESTION THAT WAS ASKED, INCLUDING WHEN IT IS ABOUT A TRADE.',
    'Asked whether you would buy something, what you would pay for it, where you would get out, or which ' +
      'of two you prefer — answer it. A direction, a level, and the price that would prove you wrong. ' +
      '"That depends on your risk tolerance" is not an answer. Neither is a list of factors to consider. ' +
      'If the honest answer is that there is nothing worth doing here, say that plainly; that is a view ' +
      'too and often the right one.',
    '',
    'WHAT MAKES A VIEW WORTH READING, AND WHAT YOU ARE HELD TO:',
    '- Every price and every financial figure comes from a tool. Not from memory, not from a guess, not ' +
      'from what a company like this one usually trades at. If you have not fetched it, it does not go ' +
      'in the answer.',
    '- A view without an invalidation is not a view. Name the level at which you would be wrong.',
    '- Give the case against as its own paragraph, argued properly. A disclaimer at the end is not that.',
    '- Say how current the price you are working from is. A level based on a delayed quote is a level, ' +
      'not an order, and you say so once rather than hedging every sentence.',
    '- You do not pad. Short questions get short answers.',
    '',
    'FORMAT: markdown. Headings where the answer has parts, a table where a table is genuinely clearer ' +
      'than sentences, prose everywhere else. Bold the things somebody would want to find without ' +
      'reading — a direction, a level, a date.',
    '',
    'TONE: talk like a sharp, well-read person who respects the reader. Plain English, British spelling, ' +
      'no corporate hedging, no bullet-point soup where a sentence would do. Be warm without being chatty.'
  ].join('\n') + workspace + onScreen;
}

/* Keep the conversation inside the gateway's combined context and output
 * budget.
 *
 * The free lanes cap context and output TOGETHER, so six tool results at seven
 * kilobytes each leave a few hundred tokens to answer with — and the answer
 * arrives truncated mid-sentence. Older tool results are squeezed hard and even
 * the freshest are capped. */
function compact(messages) {
  const toolIndexes = [];
  messages.forEach((message, i) => { if (message.role === 'tool') toolIndexes.push(i); });
  const keepFull = new Set(toolIndexes.slice(-2));

  return messages.map((message, i) => {
    if (message.role !== 'tool') return message;
    const limit = keepFull.has(i) ? 4000 : 1000;
    if (message.content.length <= limit) return message;
    return Object.assign({}, message, {
      content: message.content.slice(0, limit) + ' …[trimmed to leave room for the answer]'
    });
  });
}

/* Kept per conversation, and per record within one — an unbounded log is a
   file that only ever grows, and this application does not write those.
   A pinned conversation is exempt: pinning something is the operator saying
   "never prune this without telling me", so it does not count toward the
   limit that trims the oldest ones away. */
const MAX_TURNS_PER_CONVERSATION = 60;
const MAX_CONVERSATIONS = 300;

class Conversation {
  constructor(options) {
    const opts = options || {};
    this.gateway = opts.gateway;
    this.context = opts.context || {};
    this.audit = opts.audit || null;
    /* Where past conversations are read from and written to. Optional: a
       caller with no store still gets a working conversation, just one that
       does not survive a restart — the same shape the whole assistant had
       before this existed. */
    this.store = opts.store || null;
    this.jobs = new Map();
    this.history = [];
    this.conversationId = makeId('conv');
    this.council = new Council({ gateway: this.gateway, context: this.context, audit: this.audit });
  }

  /* ---------- conversation history ----------
   *
   * A conversation is a row in one collection, keyed on its own id, holding
   * the finished turns asked into it — separate from `this.jobs`, which are
   * the live, polled objects a turn in progress is. A conversation is what a
   * finished one becomes once there is somewhere for it to go. */

  /* Metadata only, newest first within pinned and unpinned separately, for a
     list an interface can render without pulling every conversation's full
     transcript over the bridge to draw a sidebar row. */
  conversations() {
    if (!this.store) return [];
    return this.store.all('conversations')
      .filter(Boolean)
      .map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, pinned: !!c.pinned, turns: (c.turns || []).length }))
      .sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
  }

  /* The full record, transcript included. */
  conversation(id) {
    if (!this.store) return null;
    return this.store.byId('conversations', id);
  }

  /* Makes an existing, saved conversation the one new questions are asked
     into, and restores the same handful of recent turns as follow-up
     context a live conversation would have had — not the whole transcript,
     for the reason a live one is capped to six turns as well. */
  open(id) {
    const found = this.conversation(id);
    if (!found) return null;
    this.conversationId = id;
    this.history = (found.turns || []).slice(-6).map(t => ({ question: t.question, answer: t.answer }));
    return found;
  }

  /* True deletion, not a trash a record can be pulled back out of — an
     operator who asks for a conversation gone has asked for it gone. Asking
     it to forget the one currently open starts a fresh one in its place,
     rather than leaving the next question with nowhere to be recorded. */
  forget(id) {
    if (!this.store) return false;
    this.store.remove('conversations', id);
    if (this.conversationId === id) { this.conversationId = makeId('conv'); this.history = []; }
    return true;
  }

  pin(id, pinned) {
    if (!this.store) return null;
    const found = this.conversation(id);
    if (!found) return null;
    found.pinned = !!pinned;
    this.store.put('conversations', found);
    return found;
  }

  /* Appends a finished, answered turn to its conversation, creating the row
     the first time one produces an answer — a turn that failed or was
     stopped before writing anything leaves no row, so an empty "New chat"
     nobody actually used never appears in the list. The title is the first
     question asked into it, because that is what the operator will
     remember asking, not a summary nobody wrote. */
  record(job) {
    if (!this.store || !job || !job.answer || !job.conversationId) return;
    const at = job.finishedAt || Date.now();
    const existing = this.conversation(job.conversationId);
    const turn = {
      question: job.question, answer: job.answer,
      checked: job.checked || null,
      council: job.council ? { symbol: job.council.symbol, roster: job.council.roster } : null,
      at
    };
    const record = existing || {
      id: job.conversationId, title: job.question.slice(0, 80), createdAt: at, pinned: false, turns: []
    };
    record.turns = record.turns.concat([turn]).slice(-MAX_TURNS_PER_CONVERSATION);
    record.updatedAt = at;
    this.store.put('conversations', record);

    /* Pruning counts only the unpinned ones, and only removes unpinned
       ones — a pin is a promise nothing here breaks on its own. */
    const unpinned = this.store.all('conversations').filter(c => c && !c.pinned);
    if (unpinned.length > MAX_CONVERSATIONS) {
      unpinned.slice().sort((a, b) => a.updatedAt - b.updatedAt)
        .slice(0, unpinned.length - MAX_CONVERSATIONS)
        .forEach(old => this.store.remove('conversations', old.id));
    }
  }

  /* Start a question. Returns immediately with a job the interface polls. */
  ask(question, options) {
    const opts = options || {};
    const job = {
      id: makeId('job'),
      question: String(question || '').slice(0, 8000),
      state: 'working',
      startedAt: Date.now(),
      steps: [],
      /* What has been shown so far. It only ever grows. */
      text: '',
      answer: null,
      checked: null,
      unsourced: [],
      error: null,
      toolsUsed: [],
      /* Set when the council ran, so the interface can show who reported and
         what each of them said rather than only the finished answer. */
      council: null,
      attachments: (opts.attachments || []).map(a => ({ id: a.id, name: a.name, kind: a.kind })),
      /* What a stop press aborts. One per job, not one for the whole
         conversation — stopping the turn in progress must never touch a
         question that already finished or one that has not started yet. */
      controller: new AbortController(),
      /* Captured now rather than read fresh at the end — the operator can
         open a different past conversation while this one is still working,
         and the turn belongs to the conversation it was actually asked
         into, not whichever one happens to be open when it finishes. */
      conversationId: this.conversationId
    };

    this.jobs.set(job.id, job);
    /* A finished answer nobody is waiting for is not worth keeping. */
    if (this.jobs.size > MAX_JOBS) {
      const oldest = Array.from(this.jobs.keys())[0];
      this.jobs.delete(oldest);
    }

    this.run(job, opts).catch(err => {
      /* A stop the operator asked for is not a failure. Whatever had already
         streamed — job.text only ever grows, and grew right up until the
         abort landed — is kept and shown as the finished answer, rather than
         the turn ending on an error screen for something that worked exactly
         as asked. */
      if (err && err.stopped) {
        job.state = 'done';
        job.answer = job.text;
      } else {
        job.state = 'failed';
        job.error = err.message;
      }
      job.finishedAt = Date.now();
      job.steps.forEach(s => { s.done = true; });
      this.record(job);
    });

    return { id: job.id };
  }

  /* Abort the request a job is waiting on. Only a job still working can be
     stopped — one already finished has nothing left to abort, and asking
     twice must not throw. */
  stop(id) {
    const job = this.jobs.get(id);
    if (!job || job.state !== 'working') return false;
    job.controller.abort();
    return true;
  }

  job(id) {
    const found = this.jobs.get(id);
    if (!found) return null;
    /* The token is never in here; the whole job object crosses the bridge. */
    return {
      id: found.id, state: found.state, steps: found.steps,
      text: found.text, answer: found.answer, checked: found.checked,
      unsourced: found.unsourced, council: found.council,
      councilDeclined: found.councilDeclined || null, attachments: found.attachments,
      error: found.error, startedAt: found.startedAt, finishedAt: found.finishedAt || null,
      conversationId: found.conversationId || null
    };
  }

  /* `tool` is which tool or specialist this step was, when it was one of
     those — a request-a-web-search step and a check-the-time step are both
     `kind: 'tool'` but want different icons in the interface, and passing
     the name through here is cheaper than the interface guessing one from
     the label's English prose. */
  step(job, label, kind, tool) {
    /* Appended, never rebuilt. The previous step is marked done as the next
       one starts, so the interface only has to toggle a class. */
    job.steps.forEach(s => { s.done = true; });
    job.steps.push({ label, kind: kind || 'tool', tool: tool || null, at: Date.now(), done: false });
    if (job.steps.length > 24) job.steps.shift();
  }

  /* WHICH INSTRUMENT A QUESTION IS ABOUT, WHEN IT IS ABOUT ONE AT ALL.
   *
   * A named ticker wins over the workspace, because somebody who types "what
   * about AMD" while looking at NVDA means AMD. Only well-formed, upper-case
   * tokens count: lower-case prose is full of three-letter words and matching
   * them turns "should I buy the dip" into a question about DIP. */
  symbolInQuestion(question) {
    const text = String(question || '');
    const words = new Set(['THE', 'AND', 'FOR', 'BUT', 'NOT', 'YOU', 'ARE', 'CAN', 'WHY', 'HOW',
      'ALL', 'ANY', 'NOW', 'ITS', 'WAS', 'HAS', 'GET', 'OUT', 'BUY', 'SELL', 'USD', 'GBP', 'EUR',
      'ATH', 'CEO', 'CFO', 'EPS', 'IPO', 'ETF', 'RSI', 'ATR', 'YTD', 'AI', 'UK', 'US', 'EU']);

    const candidates = text.match(/\^?[A-Z][A-Z0-9]{1,9}(?:[.=-][A-Z0-9]{1,4})?/g) || [];
    const named = candidates.find(candidate => !words.has(candidate) && candidate.length >= 2);
    return named || this.context.selectedSymbol || null;
  }

  async run(job, options) {
    /* A question that wants a considered view on an instrument goes to the
       council rather than through the ordinary loop, which is built for one
       answer from one pass and would give four hedged paragraphs here. */
    const symbol = this.symbolInQuestion(job.question);
    const wantsCouncil = options.council === true ||
      (options.council !== false && !options.brief && Council.wants(job.question, symbol));

    if (wantsCouncil && symbol) {
      const ran = await this.runCouncil(job, symbol, options);
      /* A council that could not be assembled — no price for the instrument, or
         the gateway refusing — falls through to the ordinary loop rather than
         failing the question. */
      if (ran) return ran;
    }

    const messages = [
      { role: 'system', content: brief(this.context) }
    ];

    /* Recent turns, so a follow-up question makes sense. */
    this.history.slice(-6).forEach(turn => {
      messages.push({ role: 'user', content: turn.question });
      messages.push({ role: 'assistant', content: turn.answer });
    });

    /* Anything the operator attached. A picture travels as a picture; a document
       travels as its text, because the words are what can be reasoned about and
       the file itself is far too large to send. */
    const attached = options.attachments && options.attachments.length && this.context.uploads
      ? this.context.uploads.materialise(options.attachments.map(a => a.id || a))
      : { media: [], documents: [], problems: [] };

    if (attached.documents.length || attached.problems.length) {
      this.step(job, 'Reading what you attached', 'tool');
    }

    const preamble = [];
    attached.documents.forEach(document => {
      preamble.push('ATTACHED — ' + document.name + ':\n' +
        document.text.slice(0, 24000) +
        (document.text.length > 24000 ? '\n…[the rest was too long to include]' : ''));
    });
    if (attached.problems.length) {
      preamble.push('These attachments could not be read: ' + attached.problems.join(' '));
    }

    messages.push({
      role: 'user',
      content: preamble.length ? preamble.join('\n\n') + '\n\n' + job.question : job.question
    });

    const media = attached.media;
    const used = [];
    let committed = '';
    /* How many rounds ended in a tool request that never arrived. */
    let malformed = 0;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const finalRound = round === MAX_ROUNDS - 1;
      this.step(job, round === 0 ? 'Thinking' : 'Working through what came back', 'think');

      const reply = await this.gateway.chat({
        messages: compact(messages),
        /* Withdrawn on the last round so the turn cannot end with a tool call
           and no prose. */
        tools: finalRound ? null : tools.DEFINITIONS,
        /* Only on the first round: the picture is already in the conversation
           after that, and sending it again on every round would spend the whole
           context budget on the same image. */
        media: round === 0 ? media : null,
        mode: options.brief ? MODE.BRIEF : MODE.CHAT,
        maxTokens: options.brief ? 400 : 1800,
        signal: job.controller.signal,
        onToken: whole => {
          /* Published text only ever grows. What has already been shown is
             never replaced by a later round. */
          job.text = committed + whole;
        }
      });

      /* A ROUND THAT WROTE THE MACHINERY OF A TOOL CALL WITHOUT DELIVERING ONE
         DID NOT PRODUCE AN ANSWER.
       *
         The model meant to fetch something and the request did not survive the
         trip — cut off by a token ceiling, or emitted in a shape the transport
         did not recognise. What is left is prose that stops mid-thought and a
         spray of closing tags. Committing that hands the operator a fragment of
         code where an answer should be.
       *
         Three things are tried, in order of how much is salvaged: read the
         request back out of the prose and run it; ask again saying what went
         wrong; and finally ask for prose alone from everything already
         gathered. Only if all three fail does the turn end without an answer,
         and then it says so plainly. */
      if (!reply.toolCalls.length && !finalRound && guards.hasToolSyntax(reply.text)) {
        const recovered = guards.parseToolCalls(reply.text, tools.DEFINITIONS.map(d => d.function.name));
        if (recovered.length) {
          this.step(job, 'Recovering an interrupted request', 'tool');
          reply.toolCalls = recovered;
          reply.text = guards.dropToolSyntax(reply.text);
        }
      }

      if (!reply.toolCalls.length &&
          (guards.hasToolSyntax(reply.text) || (!committed && guards.looksUnanswered(reply.text)))) {
        const salvaged = guards.dropToolSyntax(reply.text);
        malformed++;

        /* Three is a pattern, not a hiccup. Rather than loop until the step
           ceiling, the best of what was written is kept and the turn ends
           honestly — with the fragment removed either way. */
        if (malformed >= 3 || finalRound) {
          const usable = committed || (guards.looksUnanswered(salvaged) ? '' : salvaged);
          if (usable) return this.finish(job, usable, used);

          /* Everything needed is already in `messages` — the searches ran and
             the pages were read. What failed was the writing up. So ask for
             exactly that, with the tools withdrawn so there is nothing left to
             call and nothing left to mangle. */
          if (used.length) {
            this.step(job, 'Writing up what came back', 'tool');
            const written = await this.gateway.chat({
              messages: compact(messages.concat([{
                role: 'user',
                content: 'Answer the question now, in prose, using only what the tools above returned. ' +
                  'Do not request anything else and do not write any tool syntax.'
              }])),
              tools: null,
              mode: options.brief ? MODE.BRIEF : MODE.CHAT,
              maxTokens: options.brief ? 400 : 1500,
              signal: job.controller.signal,
              onToken: whole => { job.text = whole; }
            }).catch(() => null);

            const text = written ? guards.dropToolSyntax(written.text) : '';
            if (text && !guards.looksUnanswered(text)) return this.finish(job, text, used);
          }

          return this.finish(job,
            'I could not finish that one — a request I made did not come back. Ask me again.', used);
        }

        this.step(job, 'Retrying an interrupted request', 'tool');
        messages.push({ role: 'assistant', content: salvaged });
        messages.push({
          role: 'user',
          content: 'That reply ended part way through a tool request and the request did not arrive. ' +
            'Make the call again on its own, or answer from what you already have. ' +
            'Do not write tool syntax into your reply.'
        });
        job.text = committed;
        continue;
      }

      if (!reply.toolCalls.length) {
        committed = committed ? committed + '\n\n' + reply.text : reply.text;
        return this.finish(job, committed, used);
      }

      /* Whatever the model wrote before deciding to use a tool stays. */
      if (reply.text && reply.text.trim().length > 40) {
        committed = committed ? committed + '\n\n' + reply.text.trim() : reply.text.trim();
        job.text = committed;
      }

      messages.push({
        role: 'assistant',
        content: reply.text || '',
        tool_calls: reply.toolCalls.map(call => ({ id: call.id, name: call.name, args: call.args }))
      });

      for (const call of reply.toolCalls) {
        const args = normaliseArgs(call.args);
        this.step(job, tools.describe(call.name, args), 'tool', call.name);

        let result;
        try {
          result = await tools.run(this.context, call.name, args);
        } catch (err) {
          result = { error: err.message };
        }

        used.push({ name: call.name, args, label: tools.sourceLabel(call.name, args), result });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: JSON.stringify(result).slice(0, TOOL_RESULT_LIMIT)
        });
      }
    }

    return this.finish(job, committed || 'I ran out of steps before I could finish that.', used);
  }

  /* One council run, start to finish. Returns the job when it produced an
     answer and null when it could not even begin, so the caller can fall back. */
  async runCouncil(job, symbol, options) {
    const step = (label, kind, tool) => this.step(job, label, kind, tool);

    step('Gathering the evidence on ' + symbol, 'tool');

    /* A FALLBACK THAT LEAVES NO TRACE IS A FEATURE THAT SILENTLY DOES NOT WORK.
     *
     * Every path out of here that gives up returns null so the ordinary loop can
     * still answer — which is right, an answer beats a failure. But the first
     * version recorded nothing on the way out, so a council that never convened
     * was indistinguishable from a question that never wanted one. The reason is
     * written onto the job and into the audit log either way. */
    const giveUp = (reason, error) => {
      job.councilDeclined = reason + (error ? ': ' + ((error && error.message) || error) : '');
      if (this.audit) this.audit.write('syrix.council.declined', { symbol, reason: job.councilDeclined });
      return null;
    };

    let dossier;
    try {
      dossier = await evidence.forInstrument(this.context, symbol, { question: job.question });
    } catch (err) {
      return giveUp('the evidence could not be gathered', err);
    }

    let result;
    try {
      result = await this.council.run(job, job.question, dossier, {
        step,
        onToken: whole => { job.text = whole; }
      });
    } catch (err) {
      if (err && err.kind === 'unpaired') throw err;
      /* A stop is not a failed desk — it is thrown to unwind every specialist
         and the chief in one go, but nothing to fall back to the ordinary
         loop over. Whatever the chief had written before the abort is kept,
         exactly as the ordinary loop keeps it. */
      if (err && err.stopped) throw err;
      return giveUp('the desk could not be assembled', err);
    }

    if (!result.answer || result.answer.length < 120) {
      return giveUp('the desk wrote nothing usable', null);
    }

    const cleaned = guards.clean(result.answer, {});
    job.state = 'done';
    job.text = cleaned.text;
    job.answer = cleaned.text;
    job.unsourced = [];
    job.council = {
      symbol: dossier.symbol,
      name: dossier.name,
      dataState: dossier.dataState,
      roster: result.roster,
      /* Passed through as the council produced it, stance and all. */
      reports: result.reports,
      corrections: result.review ? result.review.corrections : [],
      trimmed: result.trimmed,
      missing: result.missing
    };
    job.checked = councilChecked(dossier, result);
    job.finishedAt = Date.now();
    job.steps.forEach(s => { s.done = true; });

    this.history.push({ question: job.question, answer: cleaned.text });
    if (this.history.length > 12) this.history.shift();

    this.record(job);
    return job;
  }

  finish(job, text, used) {
    const labels = Object.create(null);
    tools.DEFINITIONS.forEach(definition => {
      labels[definition.function.name] = tools.sourceLabel(definition.function.name, {});
    });

    const cleaned = guards.clean(text, {
      toolLabels: labels,
      toolResults: used.map(u => u.result)
    });

    job.state = 'done';
    job.text = cleaned.text;
    job.answer = cleaned.text;
    job.unsourced = cleaned.unsourced;
    job.checked = guards.checkedLine(used, tools.sourceLabel);
    job.toolsUsed = used.map(u => ({ name: u.name, label: u.label }));
    job.finishedAt = Date.now();
    job.steps.forEach(s => { s.done = true; });

    this.history.push({ question: job.question, answer: cleaned.text });
    if (this.history.length > 12) this.history.shift();

    if (this.audit) {
      this.audit.write('syrix.answered', {
        tools: used.map(u => u.name),
        rounds: job.steps.filter(s => s.kind === 'think').length,
        unsourced: cleaned.unsourced.length,
        ms: job.finishedAt - job.startedAt
      });
    }

    this.record(job);
    return job;
  }

  reset() {
    this.history = [];
    this.conversationId = makeId('conv');
    return true;
  }
}

/* The "Checked:" line for a council answer, built from what was actually read
   rather than from what the answer claims to have read. */
function councilChecked(dossier, result) {
  const gathered = Object.keys(dossier.sections)
    .filter(name => dossier.sections[name].ok)
    .map(name => dossier.sections[name].label);
  if (!gathered.length) return null;

  const desk = result.roster.length + ' specialist' + (result.roster.length === 1 ? '' : 's');
  return 'Checked: ' + gathered.join(', ').toLowerCase() + ' — read by ' + desk +
    (result.review && result.review.corrections.length
      ? ', and ' + result.review.corrections.length + ' correction' +
        (result.review.corrections.length === 1 ? '' : 's') + ' applied after a check against the evidence.'
      : ', then checked against the evidence.');
}

/* Arguments arrive as an object or as a JSON string depending on the lane. */
function normaliseArgs(args) {
  if (!args) return {};
  if (typeof args === 'object') return args;
  try { return JSON.parse(args); } catch (e) { return {}; }
}

module.exports = { Conversation, brief, compact, MAX_ROUNDS };
