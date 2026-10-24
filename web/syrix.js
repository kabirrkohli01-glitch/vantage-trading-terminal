'use strict';
/* The assistant's surface: a dock beside the work, and a full screen of its own.
 *
 * ONE COMPONENT, TWO PLACES. The dock on the right edge and the full screen are
 * the same conversation rendered into two containers, not two implementations of
 * a chat. A question asked in the dock is in the tab when it is opened, and an
 * answer that arrives while the dock is shut is there when it is reopened. Two
 * copies of this would drift apart within a week.
 *
 * WHAT THE PROGRESS PANEL IS FOR, AND THE RULE THAT MAKES IT READ WELL.
 * A council question takes half a minute or more. Half a minute of a spinner
 * reads as broken; half a minute of named steps — reading the chart, checking
 * the consensus, building the case against — reads as work being done, and it is
 * the same work either way. THE STEP LIST IS APPENDED TO AND NEVER REBUILT.
 * Rebuilding it from markup on every poll restarts every entrance animation at
 * once, which is exactly what makes an interface feel cheap. A finished row is
 * completely still; only the live row moves, and it moves on transform and
 * opacity so the compositor does it.
 *
 * THE PRODUCT MARK IS NOT IN HERE. An assistant panel inside the application
 * does not need to tell the operator which application they are in, and a logo
 * above every conversation is a logo in the way of the conversation.
 */

(function () {

  const md = window.T.markdown;
  const clock = window.T.clock;

  let ctx = null;
  function install(context) { ctx = context; loadConversations(); }

  const esc = md.esc;

  const state = {
    /* The whole conversation, in order. Each turn is a question and its job. */
    turns: [],
    busy: false,
    docked: false,
    depth: 'auto',        // auto | council | quick
    attachments: [],      // documents staged for the next question
    documents: [],
    status: null,
    /* The job the composer's own button can stop — only one at a time, since
       only one question is ever in flight. */
    activeJobId: null,
    /* Which step rows have already been drawn, per turn, so a poll appends
       rather than redraws. */
    painted: new Map(),
    /* Metadata for the sidebar's list — the full transcript of a past
       conversation is only ever pulled for the one actually opened. */
    conversations: [],
    activeConversationId: null
  };

  /* ---------- asking ---------- */

  async function ask(question, options) {
    const text = String(question || '').trim();
    if (!text || state.busy) return;
    const opts = options || {};

    const turn = {
      id: 'turn' + Date.now().toString(36),
      question: text,
      attachments: state.attachments.slice(),
      job: null,
      state: 'working',
      startedAt: Date.now()
    };
    state.turns.push(turn);
    state.attachments = [];
    state.busy = true;
    render();
    scrollDown();

    let started;
    try {
      started = await ctx.call('syrix:ask', {
        question: text,
        council: state.depth === 'auto' ? undefined : state.depth === 'council',
        attachments: turn.attachments.map(a => ({ id: a.id }))
      });
    } catch (err) {
      turn.state = 'failed';
      turn.error = err.message;
      turn.needsPairing = err.kind === 'unpaired';
      state.busy = false;
      render();
      return;
    }

    state.activeJobId = started.id;
    poll(turn, started.id);
  }

  /* Aborts the request the composer's own button is currently offering to
     stop. Whatever had already streamed is kept — the job finishes rather
     than fails, exactly as an ordinary answer does. */
  async function stop() {
    if (!state.activeJobId) return;
    try { await ctx.call('syrix:stop', { id: state.activeJobId }); } catch (err) { /* already over */ }
  }

  function poll(turn, jobId) {
    let misses = 0;

    const tick = async () => {
      let job;
      try {
        job = await ctx.call('syrix:job', { id: jobId });
      } catch (err) {
        /* A job the main process has forgotten is over; one that failed to
           answer once is not. */
        if (++misses > 3) {
          turn.state = 'failed';
          turn.error = err.message;
          state.busy = false;
          state.activeJobId = null;
          render();
          return;
        }
        setTimeout(tick, 900);
        return;
      }

      misses = 0;
      turn.job = job;

      if (job.state === 'working') {
        update(turn);
        setTimeout(tick, 300);
        return;
      }

      turn.state = job.state === 'failed' ? 'failed' : 'done';
      turn.error = job.error || null;
      state.busy = false;
      state.activeJobId = null;
      if (job.answer && job.conversationId) {
        state.activeConversationId = job.conversationId;
        loadConversations();
      }
      render();
      scrollDown();
    };

    tick();
  }

  /* ---------- conversation history ---------- */

  async function loadConversations() {
    try { state.conversations = await ctx.call('syrix:conversations'); } catch (err) { return; }
    renderSidebar();
  }

  function renderSidebar() {
    const host = document.querySelector('[data-syrix-conversations]');
    if (!host) return; // the dock carries no sidebar; nothing to draw
    if (!state.conversations.length) {
      host.innerHTML = '<div class="chat-sidebar-empty">Past conversations will show up here.</div>';
      return;
    }
    const pinned = state.conversations.filter(c => c.pinned);
    const rest = state.conversations.filter(c => !c.pinned);
    host.innerHTML =
      (pinned.length ? '<div class="chat-sidebar-group">Pinned</div>' + pinned.map(conversationRowHtml).join('') : '') +
      (rest.length ? '<div class="chat-sidebar-group">Recent</div>' + rest.map(conversationRowHtml).join('') : '');
  }

  function conversationRowHtml(c) {
    return '<div class="chat-sidebar-item' + (c.id === state.activeConversationId ? ' on' : '') + '">' +
      '<button class="chat-sidebar-row" data-act="syx-open-conversation" data-id="' + esc(c.id) + '" ' +
      'title="' + esc(c.title) + '">' + esc(c.title) + '</button>' +
      '<div class="chat-sidebar-item-actions">' +
      '<button class="icon-btn sm" data-act="syx-pin-conversation" data-id="' + esc(c.id) + '" ' +
      'data-pinned="' + (c.pinned ? '' : '1') + '" title="' + (c.pinned ? 'Unpin' : 'Pin') + '">' +
      '<svg><use href="#i-star"></use></svg></button>' +
      '<button class="icon-btn sm" data-act="syx-delete-conversation" data-id="' + esc(c.id) + '" ' +
      'title="Delete">' +
      '<svg><use href="#i-close"></use></svg></button>' +
      '</div></div>';
  }

  /* Swaps in a past conversation's transcript as static, already-finished
     turns — there is no live job behind any of them, so nothing here polls. */
  async function openConversation(id) {
    if (state.busy) return;
    let found;
    try { found = await ctx.call('syrix:conversation', { id }); } catch (err) { return; }
    if (!found) return;
    state.activeConversationId = id;
    state.turns = (found.turns || []).map((t, i) => ({
      id: 'past' + id + i,
      question: t.question,
      attachments: [],
      state: 'done',
      startedAt: t.at,
      job: {
        state: 'done', steps: [], text: t.answer, answer: t.answer,
        checked: t.checked || null, council: t.council || null,
        councilDeclined: null, unsourced: [], finishedAt: t.at
      }
    }));
    render();
    scrollDown();
  }

  async function deleteConversation(id) {
    const going = state.conversations.find(c => c.id === id);
    ctx.openModal('Delete this conversation?',
      '<p style="font-size:12.5px;color:var(--ink-2);line-height:1.55">"' + esc((going && going.title) || 'This conversation') +
      '" will be deleted for good — this cannot be undone.</p>',
      '<button class="btn" data-act="close-modal">Cancel</button>' +
      '<button class="btn danger" data-act="syx-confirm-delete-conversation" data-id="' + esc(id) + '">Delete</button>');
  }

  /* ---------- rendering ---------- */

  function containers() {
    return Array.from(document.querySelectorAll('[data-syrix-log]'));
  }

  function render() {
    /* The composer is drawn once per surface and then only synchronised, so
       typing into it survives an answer arriving. */
    Array.from(document.querySelectorAll('.syx-composer-host')).forEach(host => {
      if (!host.querySelector('.syx-compose')) host.innerHTML = composerHtml(host.dataset.composer || 'screen');
    });

    const empty = !state.turns.length;
    containers().forEach(container => {
      container.innerHTML = empty ? introHtml() : state.turns.map(turnHtml).join('');
      const wrap = container.closest('.chat-wrap');
      if (wrap) wrap.classList.toggle('empty', empty);
    });
    /* Only where the surface actually has room for it — the dock has no
       matching element, and querying finds none there rather than erroring. */
    document.querySelectorAll('[data-syrix-suggest]').forEach(host => {
      host.innerHTML = empty ? suggestHtml() : '';
    });

    /* Every step row is now on screen; record that so the next poll appends. */
    state.painted = new Map();
    state.turns.forEach(turn => {
      state.painted.set(turn.id, ((turn.job && turn.job.steps) || []).length);
    });
    syncComposers();
    renderSidebar();
  }

  /* A poll while a turn is running. Only two things change: the steps, which are
     appended, and the streamed text, which is replaced in place. Nothing else in
     the document is touched, so nothing restarts. */
  function update(turn) {
    const job = turn.job;
    if (!job) return;

    containers().forEach(container => {
      const node = container.querySelector('[data-turn="' + turn.id + '"]');
      if (!node) { render(); return; }

      const steps = job.steps || [];
      const drawn = state.painted.get(turn.id) || 0;
      const list = node.querySelector('[data-steps]');

      if (list) {
        for (let i = drawn; i < steps.length; i++) {
          list.insertAdjacentHTML('beforeend', stepHtml(steps[i]));
        }
        /* Only the class changes on a row that was already there. */
        Array.from(list.children).forEach((row, i) => {
          const step = steps[i];
          if (!step) return;
          row.classList.toggle('done', !!step.done);
          row.classList.toggle('live', !step.done);
        });
      }

      /* Skipped when the text has not grown since the last poll — most polls
         during a tool round change only the step list, and touching a large
         answer's markup on every tick for no reason is exactly what makes a
         stream feel like it is stuttering rather than writing. The cursor
         after it is the only part that is genuinely alive while it waits. */
      const stream = node.querySelector('[data-stream]');
      if (stream && job.text && stream.dataset.rendered !== job.text) {
        stream.innerHTML = md.render(job.text) + '<span class="syx-cursor"></span>';
        stream.dataset.rendered = job.text;
        stream.classList.add('streaming');
      }
    });

    state.painted.set(turn.id, ((turn.job && turn.job.steps) || []).length);
    scrollDown();
  }

  /* Just the greeting — lives in the scrollable log, which is what shrinks to
     content size and lets the whole empty state, composer included, sit in
     the middle of the screen rather than pinned to the bottom edge. */
  function introHtml() {
    return '<div class="syx-intro">' +
      '<div class="syx-mark"><svg><use href="#i-syrix"></use></svg></div>' +
      '<div class="syx-lead">What are we looking at?</div>' +
      '<div class="syx-sub">Ask for a view and you will get one — a direction, a level to act at, and the ' +
      'price that would prove it wrong. Every figure comes from something it actually fetched.</div>' +
      '</div>';
  }

  const SUGGESTIONS = [
    ['Would you buy NVDA here, and where would you get in?', 'Ask for a position',
      'A direction, a level, and the price that proves it wrong.'],
    ['What is moving the market today and why?', 'Read the tape',
      'The real reasons, not a list of tickers that moved.'],
    ['Compare SOFI and its sector on growth and valuation.', 'Compare',
      'Two names or a name against its own sector, side by side.'],
    ['What did NVIDIA report as revenue last year, and where is that filed?', 'Check a filed figure',
      'Traced to the document it actually came from.']
  ];

  /* Its own element, a sibling of the composer rather than a child of the
     log — the log is what scrolls once a conversation has turns in it, and
     these only ever show while it does not, sitting below the composer the
     way the reference asked for rather than above it. */
  function suggestHtml() {
    return '<div class="syx-cards">' + SUGGESTIONS.map(([q, label, sub]) =>
      '<button class="syx-card" data-act="syx-suggest" data-q="' + esc(q) + '">' +
      '<span class="c-label">' + esc(label) + '</span>' +
      '<span class="c-sub">' + esc(sub) + '</span>' +
      '</button>').join('') + '</div>';
  }

  function turnHtml(turn) {
    const job = turn.job;

    return '<div class="syx-turn" data-turn="' + esc(turn.id) + '">' +
      '<div class="syx-ask">' +
      (turn.attachments.length ? '<div class="syx-chips">' + turn.attachments.map(file =>
        '<span class="syx-chip"><i class="' + esc(file.kind) + '"></i>' + esc(file.name) + '</span>').join('') +
        '</div>' : '') +
      '<div class="syx-ask-text">' + esc(turn.question) + '</div>' +
      '</div>' +
      '<div class="syx-answer">' +
      progressHtml(turn) +
      '<div class="syx-body" data-stream>' +
      (job && job.text ? md.render(job.text) : '') +
      '</div>' +
      (turn.state === 'failed' ? faultHtml(turn) : '') +
      (job && job.state === 'done' ? footerHtml(job) : '') +
      '</div></div>';
  }

  function progressHtml(turn) {
    const job = turn.job;
    const steps = (job && job.steps) || [];
    const working = turn.state === 'working';
    if (!working && !steps.length) return '';

    return '<details class="syx-progress"' + (working ? ' open' : '') + '>' +
      '<summary><span class="syx-pulse"><svg><use href="#i-syrix"></use></svg></span>' +
      '<span class="syx-progress-label">' + (working ? 'Working' : 'How it got there') + '</span>' +
      '<span class="syx-elapsed">' + elapsed(turn) + '</span></summary>' +
      '<ol class="syx-steps" data-steps>' + steps.map(stepHtml).join('') + '</ol>' +
      '</details>';
  }

  /* One icon per action, so a glance tells you whether it is reading the news
     or checking a price rather than just that "something" is happening. Keyed
     on the tool or specialist name loop.js hands back; a plain dot for a
     thinking round, which has none. */
  const STEP_ICON = {
    search_the_web: 'i-search', read_a_page: 'i-sources', look_up_a_topic: 'i-profile',
    check_the_time: 'i-calendar', get_a_price: 'i-chart', find_an_instrument: 'i-search',
    price_history: 'i-chart', company_filings: 'i-journal', reported_figure: 'i-journal',
    analyst_view: 'i-indicator', insider_dealing: 'i-profile', sector_and_peers: 'i-heat',
    search_news: 'i-news', read_article: 'i-news', screen_the_market: 'i-heat',
    my_portfolio: 'i-portfolio', my_trading_record: 'i-journal',
    price: 'i-chart', technicals: 'i-indicator', news: 'i-news', fundamentals: 'i-journal',
    earnings: 'i-calendar', ownership: 'i-profile', positioning: 'i-indicator',
    sector: 'i-heat', risk: 'i-alerts'
  };
  const KIND_ICON = { think: 'i-syrix', agent: 'i-profile', tool: 'i-search' };

  function stepIcon(step) {
    return (step.tool && STEP_ICON[step.tool]) || KIND_ICON[step.kind || 'tool'] || 'i-search';
  }

  function stepHtml(step) {
    return '<li class="syx-step ' + (step.done ? 'done' : 'live') + ' k-' + esc(step.kind || 'tool') + '">' +
      '<span class="s-icon"><svg><use href="#' + esc(stepIcon(step)) + '"></use></svg></span>' +
      '<span class="s-label">' + esc(step.label) + '</span></li>';
  }

  function elapsed(turn) {
    const job = turn.job;
    const end = job && job.finishedAt ? job.finishedAt : Date.now();
    const seconds = Math.max(0, Math.round((end - turn.startedAt) / 1000));
    return seconds + 's';
  }

  function faultHtml(turn) {
    return '<div class="syx-fault">' + esc(turn.error || 'That did not work.') +
      (turn.needsPairing
        ? ' <button class="btn" data-act="view" data-view="settings">Pair it in settings</button>' : '') +
      '</div>';
  }

  function footerHtml(job) {
    return (job.council ? councilHtml(job.council) : '') +
      /* Said out loud rather than left as a silence. A question that asked for a
         view and got one from a single pass is a different answer from one the
         desk wrote, and the reader is entitled to know which they are holding. */
      (job.councilDeclined
        ? '<div class="syx-note declined">The desk did not sit for this one — ' +
          esc(job.councilDeclined) + '. Answered from a single pass instead.</div>'
        : '') +
      (job.checked ? '<div class="syx-checked">' + esc(job.checked) + '</div>' : '');
  }

  /* WHO SAID WHAT. An answer written by one voice from eight reports is more
     trustworthy when the eight are readable, and a disagreement between the
     chart and the accounts is the most useful thing on the screen. */
  function councilHtml(council) {
    const reports = council.reports || [];
    const wrote = reports.filter(report => report.ok);

    return '<details class="syx-council">' +
      '<summary>The desk — ' + wrote.length + ' specialist' + (wrote.length === 1 ? '' : 's') +
      ' on ' + esc(council.symbol) +
      (council.corrections && council.corrections.length
        ? ', ' + council.corrections.length + ' correction' +
          (council.corrections.length === 1 ? '' : 's') + ' applied' : '') +
      '</summary>' +
      (council.trimmed ? '<div class="syx-note">' + esc(council.trimmed) + '</div>' : '') +
      (council.missing && council.missing.length
        ? '<div class="syx-note">Evidence that could not be gathered: ' +
          council.missing.map(entry => esc(entry.label)).join(', ') + '.</div>' : '') +
      '<div class="syx-reports">' + reports.map(reportHtml).join('') + '</div>' +
      (council.corrections && council.corrections.length
        ? '<div class="syx-corrections"><div class="section-label">Corrected after checking</div><ul>' +
          council.corrections.map(entry => '<li>' + esc(entry) + '</li>').join('') + '</ul></div>' : '') +
      '</details>';
  }

  /* THE STANCE IS READ IN THE MAIN PROCESS AND ARRIVES WITH THE REPORT. It was
     parsed here as well for a while, from the same text with a second regular
     expression, and the two disagreed the moment a model decorated the label —
     one parser said the specialist had no view and the other said it did. One
     format, one parser. */
  function reportHtml(report) {
    if (!report.ok) {
      return '<div class="syx-report failed"><div class="r-head">' + esc(report.title) +
        '<span class="stance none">no report</span></div>' +
        '<div class="r-body muted">' + esc(report.reason || 'did not answer') + '</div></div>';
    }

    const stance = report.stance;
    return '<div class="syx-report"><div class="r-head">' + esc(report.title) +
      (stance ? '<span class="stance ' + esc(stance.view) + '">' + esc(stance.view) +
        ' · ' + esc(stance.confidence) + '</span>' : '') + '</div>' +
      '<div class="r-body">' + md.render(report.text || '') + '</div></div>';
  }

  /* ---------- the composer ---------- */

  function composerHtml(where) {
    return '<div class="syx-compose" data-where="' + where + '">' +
      '<div class="syx-staged" data-staged></div>' +
      '<div class="syx-input-row">' +
      '<button class="icon-btn" data-act="syx-attach" title="Attach a chart, a report or a spreadsheet">' +
      '<svg><use href="#i-plus"></use></svg></button>' +
      '<textarea class="syx-input" rows="1" data-syrix-input ' +
      'placeholder="Ask anything — a position, a company, a filing, or something else entirely…"></textarea>' +
      '<button class="syx-depth" data-act="syx-depth-menu" title="How deeply to work">' +
      esc(depthLabel()) + ' <span class="caret">▾</span></button>' +
      sendButtonHtml() +
      '</div></div>';
  }

  /* One button, two identities. While a turn is in flight it stops that turn
     rather than sending a new one — a second question cannot be asked until
     the first has an answer anyway, so the same key that started it is the
     one that can cut it short. */
  function sendButtonHtml() {
    return state.busy
      ? '<button class="syx-send-btn stop" data-act="syx-stop" title="Stop">' +
        '<svg><use href="#i-stop"></use></svg></button>'
      : '<button class="syx-send-btn" data-act="syx-send" title="Send">' +
        '<svg><use href="#i-send"></use></svg></button>';
  }

  /* The three modes a press used to cycle through blindly. Named here once,
     so the button's label and the menu that explains each one cannot drift
     apart from what ask() actually sends. */
  const DEPTHS = [
    { id: 'auto', label: 'Automatic',
      detail: 'SYRIX decides per question — a quick answer for something factual, ' +
        'the full desk when a question actually asks for a view. The right choice most of the time.' },
    { id: 'council', label: 'Full desk',
      detail: 'Every question gets the full council: nine specialists each reading their own slice of ' +
        'the evidence, a chief that writes the answer, and a reviewer that checks it before it is shown. ' +
        'Slower, and worth it when the question genuinely is open.' },
    { id: 'quick', label: 'Quick',
      detail: 'One fast pass, even for a question that would normally go to the council. ' +
        'For something you want answered now and will follow up on.' }
  ];

  function depthLabel() {
    const found = DEPTHS.find(d => d.id === state.depth);
    return found ? found.label : 'Automatic';
  }

  function depthMenuHtml() {
    return DEPTHS.map(d => '<button class="btn menu-row' + (state.depth === d.id ? ' on' : '') + '" ' +
      'data-act="syx-depth" data-depth="' + d.id + '">' +
      '<span class="tick">' + (state.depth === d.id ? '✓' : '') + '</span>' +
      '<span class="menu-text"><b>' + esc(d.label) + '</b><span class="muted">' + esc(d.detail) + '</span></span>' +
      '</button>').join('');
  }

  function syncComposers() {
    Array.from(document.querySelectorAll('.syx-compose')).forEach(composer => {
      const row = composer.querySelector('.syx-input-row');
      const button = composer.querySelector('.syx-send-btn');
      /* Swapped for a fresh element rather than toggled in place — send and
         stop are different actions on a different icon, not one button with
         two looks, and data-act has to change with it. */
      if (row && button && button.classList.contains('stop') !== state.busy) {
        button.outerHTML = sendButtonHtml();
      }
      const depth = composer.querySelector('.syx-depth');
      if (depth) depth.textContent = depthLabel();

      const staged = composer.querySelector('[data-staged]');
      if (staged) {
        staged.innerHTML = state.attachments.map(file =>
          '<span class="syx-chip"><i class="' + esc(file.kind) + '"></i>' + esc(file.name) +
          '<button data-act="syx-unstage" data-id="' + esc(file.id) + '" title="Remove">×</button></span>').join('');
      }
    });
  }

  function scrollDown() {
    containers().forEach(container => {
      /* Only follows if the reader is already at the bottom. Yanking the view
         down while somebody is reading an earlier answer is the rudest thing a
         chat surface can do. */
      const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 220;
      if (nearBottom) container.scrollTop = container.scrollHeight;
    });
  }

  /* ---------- attachments ---------- */

  async function attach() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/*,.pdf,.csv,.tsv,.txt,.md,.json';

    input.addEventListener('change', async () => {
      const files = Array.from(input.files || []).slice(0, 6);
      for (const file of files) await stage(file);
      syncComposers();
    });

    input.click();
  }

  async function stage(file) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      /* Converted in blocks: spreading a twenty megabyte array into
         String.fromCharCode in one call overflows the argument list. */
      let binary = '';
      const block = 0x8000;
      for (let i = 0; i < bytes.length; i += block) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + block));
      }

      const record = await ctx.call('syrix:upload', {
        name: file.name,
        mime: file.type,
        data: btoa(binary)
      });
      state.attachments.push(record);
      if (!record.readable && record.kind !== 'image') {
        ctx.toast(record.name + ': ' + (record.note || 'no text could be read from it'), true);
      }
    } catch (err) {
      ctx.toast(err.message, true);
    }
  }

  /* ---------- the dock ---------- */

  function setDocked(on) {
    state.docked = !!on;
    document.getElementById('shell').classList.toggle('syrix-docked', state.docked);
    const dock = document.getElementById('syrix-dock');
    if (dock) dock.hidden = !state.docked;
    if (state.docked) render();
    ctx.saveWorkspace();
  }

  /* ---------- events ---------- */

  function actions() {
    return {
      'syx-stop': stop,
      'syx-send': () => {
        const box = activeInput();
        if (!box) return;
        const value = box.value;
        box.value = '';
        box.style.height = '';
        ask(value);
      },
      'syx-suggest': data => ask(data.q),
      'syx-depth-menu': () => {
        ctx.openModal('How deeply to work', '<div data-depth-host>' + depthMenuHtml() + '</div>',
          '<button class="btn primary" data-act="close-modal">Done</button>');
      },
      /* Reachable from the composer's own menu (a modal, closed once a
         choice is made) and from Settings (its own page, left open so more
         than one thing can be changed in a visit) alike. */
      'syx-depth': data => {
        if (DEPTHS.some(d => d.id === data.depth)) state.depth = data.depth;
        syncComposers();
        document.querySelectorAll('[data-depth-host]').forEach(host => { host.innerHTML = depthMenuHtml(); });
        if (document.getElementById('modal-back').classList.contains('on')) ctx.closeModal();
      },
      'syx-attach': attach,
      'syx-unstage': data => {
        const id = data.id;
        state.attachments = state.attachments.filter(file => file.id !== id);
        ctx.call('syrix:forget', { id }).catch(() => {});
        syncComposers();
      },
      'syx-dock': () => setDocked(!state.docked),
      'syx-new': async () => {
        await ctx.call('syrix:reset').catch(() => {});
        state.turns = [];
        state.attachments = [];
        state.activeConversationId = null;
        render();
      },
      'syx-open-conversation': data => openConversation(data.id),
      'syx-pin-conversation': async data => {
        try { await ctx.call('syrix:conversation:pin', { id: data.id, pinned: !!data.pinned }); }
        catch (err) { return; }
        loadConversations();
      },
      'syx-delete-conversation': data => deleteConversation(data.id),
      'syx-confirm-delete-conversation': async data => {
        try { await ctx.call('syrix:conversation:delete', { id: data.id }); } catch (err) { /* gone either way */ }
        if (state.activeConversationId === data.id) {
          state.activeConversationId = null;
          state.turns = [];
          render();
        }
        ctx.closeModal();
        loadConversations();
      }
    };
  }

  /* The box in whichever surface the operator is using. The dock wins when it is
     open and focused; otherwise the full screen's. */
  function activeInput() {
    const boxes = Array.from(document.querySelectorAll('[data-syrix-input]'));
    const focused = boxes.find(box => box === document.activeElement);
    if (focused) return focused;
    const dock = document.querySelector('#syrix-dock [data-syrix-input]');
    if (state.docked && dock) return dock;
    return boxes[0] || null;
  }

  /* Asked from elsewhere in the interface — a news story, an instrument's
     overview, a right-click. Opens the dock so the answer has somewhere to
     appear. */
  function askFrom(question) {
    if (!state.docked) setDocked(true);
    ask(question);
  }

  window.T = window.T || {};
  window.T.syrix = {
    install, actions, render, ask, askFrom, setDocked, composerHtml, state,
    depthLabel, depthMenuHtml
  };

}());
