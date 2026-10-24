'use strict';
/* Architectural assertions.
 *
 * These are rules about what the code may and may not CONTAIN, so they cannot
 * be expressed as ordinary unit tests. They are checked by reading the source.
 *
 * Several of them replace things that would otherwise need the application to
 * be launched and driven. A control with no handler, a bridge channel with no
 * handler behind it, and a script the page references but which does not exist
 * are all caught here by parsing the markup and the dispatch table — no window
 * is opened, which matters because this machine is in use while it is being
 * worked on. The interface probe that drives the real application still exists
 * (tests/ui-probe.js) and checks what only a running window can show: that the
 * chart drew pixels, and that the content policy refused nothing. It is run on
 * request rather than as part of this suite.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function run(t) {
  const { suite, ok, eq, sourceFiles } = t;

  const html = read('web/index.html');
  const app = read('web/app.js');
  const preload = read('main/preload.js');
  const ipc = read('main/ipc.js');

  /* ============ controls ============ */
  console.log('\nControls — a button with no handler is decoration, and it is silent');

  /* EVERY SCRIPT THAT DRAWS MARKUP HAS TO BE SCANNED, NOT JUST THE DOCUMENT.
   *
   * Most of this interface is generated: the document holds the shell and the
   * screens build themselves. Checking only index.html would leave the majority
   * of the controls unchecked, which is exactly how a dead button survives — the
   * content policy forbids inline handlers, so a control whose action is missing
   * from the table does nothing at all, with no error anywhere. */
  const RENDERERS = [
    'web/screens.js', 'web/research.js', 'web/newsroom.js',
    'web/discover.js', 'web/dashboard.js', 'web/syrix.js'
  ];
  const renderers = RENDERERS.map(read);

  const fromMarkup = source => (source.match(/data-act="([^"]+)"/g) || [])
    .map(m => m.slice(10, -1))
    /* A template string interpolates the name in some places; those are
       resolved by the surrounding code and cannot be checked statically. */
    .filter(name => !/[^a-zA-Z-]/.test(name));

  const declaredActions = Array.from(new Set(
    [html, app].concat(renderers).reduce((all, source) => all.concat(fromMarkup(source)), [])
  ));

  /* Actions attached by script rather than written into markup at all. */
  const scriptActions = Array.from(new Set(
    (app.match(/\.dataset\.act\s*=\s*'([^']+)'/g) || []).map(m => m.replace(/.*'([^']+)'.*/, '$1'))
  ));

  const handlerBlock = app.slice(app.indexOf('const ACTIONS = {'));
  const handlers = new Set(
    (handlerBlock.match(/^\s{4}'?([a-zA-Z-]+)'?:/gm) || [])
      .map(m => m.trim().replace(/:$/, '').replace(/'/g, ''))
  );

  /* A SCREEN THAT DRAWS ITS OWN MARKUP OWNS ITS OWN ACTIONS, and folds them into
     the one dispatch table at start-up. Those keys are just as real as the ones
     written in app.js and are collected the same way. */
  renderers.forEach(source => {
    const block = source.slice(source.indexOf('function actions()'));
    if (block.indexOf('function actions()') !== 0) return;
    const body = block.slice(0, block.indexOf('\n  }'));
    (body.match(/^\s{6}'?([a-zA-Z-]+)'?:/gm) || [])
      .map(m => m.trim().replace(/:$/, '').replace(/'/g, ''))
      .forEach(name => handlers.add(name));
  });

  suite('the dispatch table was actually found in the source', () => {
    ok(handlers.size >= 8, 'expected a populated action table, found ' + handlers.size);
  });

  suite('every control written into the markup has a handler', () => {
    const dead = declaredActions.filter(action => !handlers.has(action));
    eq(dead.length, 0, 'no handler for: ' + dead.join(', '));
  });

  suite('every control attached by script has a handler', () => {
    const dead = scriptActions.filter(action => !handlers.has(action));
    eq(dead.length, 0, 'no handler for: ' + dead.join(', '));
  });

  suite('every screen that owns its markup folds its actions into the table', () => {
    /* The table is single on purpose — one delegated listener for the whole
       document — so a module that draws controls and never registers them is a
       screen of dead buttons. */
    const wired = app.slice(app.indexOf('Object.assign(ACTIONS'), app.indexOf('Object.assign(ACTIONS') + 400);
    ['newsroom', 'discover', 'dashboard', 'syrix'].forEach(name => {
      ok(wired.indexOf('window.T.' + name + '.actions()') !== -1,
        name + ' draws controls but its actions are never registered');
    });
  });

  suite('no inline event handler survives, because the policy forbids them', () => {
    /* An inline handler is refused silently by the content policy, which turns
       a control into decoration with no error anywhere. */
    ok(!/\son[a-z]+\s*=\s*["']/i.test(html.replace(/<!--[\s\S]*?-->/g, '')),
      'the markup must carry no on* attributes');
  });

  /* ============ the bridge ============ */
  console.log('\nThe bridge — every capability is named on both sides');

  const exposedCalls = (() => {
    const block = preload.slice(preload.indexOf('const CALLS = ['), preload.indexOf('];', preload.indexOf('const CALLS = [')));
    return (block.match(/'([^']+)'/g) || []).map(s => s.slice(1, -1));
  })();

  const exposedEvents = (() => {
    const block = preload.slice(preload.indexOf('const EVENTS = ['), preload.indexOf('];', preload.indexOf('const EVENTS = [')));
    return (block.match(/'([^']+)'/g) || []).map(s => s.slice(1, -1));
  })();

  const registered = new Set((ipc.match(/handle\('([^']+)'/g) || []).map(m => m.slice(8, -1)));

  suite('the bridge exposes a closed list rather than a general-purpose call', () => {
    ok(exposedCalls.length > 5, 'the call list must be populated');
    ok(/CALLS\.indexOf\(channel\) === -1/.test(preload),
      'an unlisted channel must be refused before it reaches the main process');
  });

  suite('every channel the interface may call has a handler behind it', () => {
    const missing = exposedCalls.filter(channel => !registered.has(channel));
    eq(missing.length, 0, 'exposed with nothing behind it: ' + missing.join(', '));
  });

  suite('every channel the interface calls is one the bridge exposes', () => {
    /* A mistyped channel fails at run time with a message about an unknown
       channel and nothing else on screen. Far cheaper to catch here. */
    const used = new Set();
    [app].concat(renderers).forEach(source => {
      (source.match(/call\('([a-z]+:[a-zA-Z]+)'/g) || []).forEach(m => used.add(m.slice(6, -1)));
    });
    const unknown = Array.from(used).filter(channel => exposedCalls.indexOf(channel) === -1);
    eq(unknown.length, 0, 'called but not exposed: ' + unknown.join(', '));
  });

  suite('every handler registered is reachable from the interface', () => {
    /* A handler nobody can call is dead weight that still widens the surface. */
    const orphans = Array.from(registered).filter(channel => exposedCalls.indexOf(channel) === -1);
    eq(orphans.length, 0, 'registered but not exposed: ' + orphans.join(', '));
  });

  suite('every event the interface listens for is broadcast somewhere', () => {
    const sources = ipc + read('main/windows.js');
    const unsent = exposedEvents.filter(event =>
      sources.indexOf("'" + event + "'") === -1 && sources.indexOf('"' + event + '"') === -1);
    eq(unsent.length, 0, 'listened for but never sent: ' + unsent.join(', '));
  });

  suite('the sender of every request is verified', () => {
    ok(/windows\.owns\(event\.sender\)/.test(ipc),
      'a handler must only run for a window this application created');
  });

  suite('a failure comes back as data, not as a rejected call', () => {
    /* Rejecting an invoke wraps the message in framework text, so the interface
       would show "Error invoking remote method" instead of what went wrong. */
    ok(/return \{ ok: false, error:/.test(ipc), 'errors are returned in an envelope');
    ok(/if \(!result \|\| !result\.ok\)/.test(app), 'and the interface unwraps that envelope');
  });

  /* ============ the renderer's isolation ============ */
  console.log('\nIsolation — the interface cannot reach the network or the machine');

  suite('the renderer runs with no Node access and no shared context', () => {
    const windows = read('main/windows.js');
    ok(/nodeIntegration: false/.test(windows));
    ok(/contextIsolation: true/.test(windows));
    ok(/sandbox: true/.test(windows));
  });

  suite('the content policy closes off outbound connections entirely', () => {
    /* Every figure arrives over the bridge from the main process, so the page
       itself has no reason to reach anything. */
    ok(/connect-src 'none'/.test(html), 'stated in the document');
    ok(/connect-src 'none'/.test(read('main/main.js')), 'and enforced at the session level');
  });

  suite('the policy is present in the document as well as the session', () => {
    ok(/Content-Security-Policy/.test(html));
    ok(/script-src 'self'/.test(html));
    ok(/object-src 'none'/.test(html));
  });

  suite('a window cannot be navigated away or spawn another', () => {
    const windows = read('main/windows.js');
    ok(/setWindowOpenHandler/.test(windows));
    ok(/will-navigate/.test(windows));
    ok(/action: 'deny'/.test(windows));
  });

  /* ============ shared modules ============ */
  console.log('\nShared code — one implementation, two hosts');

  /* THE KEYS OF AN OBJECT LITERAL, READ PROPERLY.
   *
   * A regular expression cannot do this. Matching `[{,] name [,:}]` consumes the
   * comma that the next name needs as its own opening delimiter, so it finds
   * every OTHER key and reports the rest as missing — which is exactly what the
   * first version of the two checks below did, and it produced a page of
   * confident false accusations. This walks the text instead, tracking nesting
   * and quotes so a comma inside an arrow function's arguments is not mistaken
   * for a separator. */
  function objectKeys(body) {
    const keys = [];
    let depth = 0;
    let quote = null;
    let token = '';
    let expectingKey = true;

    for (let i = 0; i < body.length; i++) {
      const ch = body[i];

      if (quote) {
        if (ch === quote && body[i - 1] !== '\\') quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }

      if ('([{'.indexOf(ch) !== -1) { depth++; continue; }
      if (')]}'.indexOf(ch) !== -1) { depth--; continue; }

      if (depth > 0) continue;

      if (ch === ',') {
        if (expectingKey && /^[a-zA-Z][a-zA-Z0-9]*$/.test(token.trim())) keys.push(token.trim());
        token = '';
        expectingKey = true;
        continue;
      }
      if (ch === ':') {
        if (/^[a-zA-Z][a-zA-Z0-9]*$/.test(token.trim())) keys.push(token.trim());
        token = '';
        expectingKey = false;
        continue;
      }
      token += ch;
    }

    if (expectingKey && /^[a-zA-Z][a-zA-Z0-9]*$/.test(token.trim())) keys.push(token.trim());
    return keys;
  }

  suite('every shared module call names something that module exports', () => {
    /* A SCREEN CALLING A FUNCTION ITS MODULE DOES NOT EXPORT FAILS AT THE PRESS
       OF A BUTTON AND NOWHERE EARLIER. It is a run-time error inside a delegated
       handler, so it reaches the console and not the screen — the control simply
       does nothing, which is indistinguishable from a control that was never
       wired. Cheap to catch by reading the export lists. */
    const exports = {};
    RENDERERS.concat(['web/markdown.js', 'web/embeds.js']).forEach(file => {
      const source = read(file);
      const name = (source.match(/window\.T\.([a-zA-Z]+)\s*=\s*\{/) || [])[1];
      if (!name) return;
      const block = source.slice(source.indexOf('window.T.' + name + ' = {'));
      const body = block.slice(block.indexOf('{') + 1, block.indexOf('};'));
      exports[name] = new Set(objectKeys(body));
    });

    const missing = [];
    [app].concat(renderers).forEach(source => {
      (source.match(/window\.T\.([a-zA-Z]+)\.([a-zA-Z][a-zA-Z0-9]*)/g) || []).forEach(reference => {
        const [, module, member] = /window\.T\.([a-zA-Z]+)\.([a-zA-Z][a-zA-Z0-9]*)/.exec(reference);
        if (!exports[module]) return;
        if (!exports[module].has(member)) missing.push(module + '.' + member);
      });
    });

    eq(missing.length, 0, 'called but not exported: ' + Array.from(new Set(missing)).join(', '));
  });

  suite('every screen is handed the context it reaches for', () => {
    /* Each screen that draws its own markup is given a small object at start-up
       and uses nothing else from the shell. A name it reaches for that was never
       passed is undefined at the moment a control is pressed. */
    const shared = (() => {
      const start = app.indexOf('const shared = {');
      const block = app.slice(start + 'const shared = {'.length, app.indexOf('\n    };', start));
      return new Set(objectKeys(block));
    })();

    const missing = [];
    ['web/newsroom.js', 'web/discover.js', 'web/dashboard.js', 'web/syrix.js'].forEach(file => {
      const source = read(file);
      (source.match(/\bctx\.([a-zA-Z]+)/g) || []).forEach(reference => {
        const name = reference.slice(4);
        if (!shared.has(name)) missing.push(path.basename(file) + ' → ctx.' + name);
      });
    });

    eq(missing.length, 0, 'reached for but never passed: ' + Array.from(new Set(missing)).join(', '));
  });

  suite('a screen selects its own section, not the rail button that opens it', () => {
    /* THE RAIL BUTTON CARRIES data-view TOO, AND IT COMES FIRST IN THE DOCUMENT.
       An unqualified attribute selector therefore returns the BUTTON, and a
       screen that drew itself into it put its entire contents inside the
       left-hand rail — the newsroom and the heatmap bled through the rail while
       their own screens stayed blank. Every such selector must be qualified with
       the class only the section has. */
    const offenders = [];
    renderers.forEach((source, i) => {
      (source.match(/querySelector(?:All)?\(\s*'\[data-view=/g) || [])
        .forEach(() => offenders.push(path.basename(RENDERERS[i])));
    });
    eq(offenders.length, 0,
      'an unqualified [data-view] selector in: ' + Array.from(new Set(offenders)).join(', '));
  });

  suite('a grid declares as many tracks as it has children', () => {
    /* A CSS GRID WITH THE WRONG NUMBER OF TRACKS DOES NOT ERROR. It silently
       places the extra children in implicit tracks, which shifts everything and
       reads as several unrelated layout faults at once. This has already cost
       this project a debugging session: moving a panel out of the workspace left
       a track behind, and the chart, the range strip and the bottom panel all
       looked broken in different ways.
     *
       #body holds the rail, the stage, the assistant's splitter and the
       assistant. The default rule collapses the last two to zero rather than
       omitting them, so the count holds whether the dock is open or not. */
    const css = read('web/styles.css');
    const children = (html.match(/<div id="body">([\s\S]*?)\n  <\/div>/) || [, ''])[1];
    const direct = (children.match(/^    <(nav|main|aside|div)\b/gm) || []).length;

    const rule = (css.match(/#body\s*\{[^}]*grid-template-columns:([^;]+);/) || [, ''])[1];
    const tracks = rule.trim().split(/\s+(?![^(]*\))/).filter(Boolean).length;

    eq(tracks, direct, '#body has ' + direct + ' children and ' + tracks + ' tracks');
  });

  suite('every script the page references exists on disk', () => {
    const sources = (html.match(/<script src="([^"]+)"/g) || []).map(m => m.slice('<script src="'.length, -1));
    ok(sources.length >= 4, 'the page must load its modules');
    sources.forEach(src => {
      const file = path.resolve(path.join(ROOT, 'web'), src);
      ok(fs.existsSync(file), 'missing script: ' + src);
    });
  });

  suite('the modules the interface shares are loadable in both hosts', () => {
    ['src/core/num.js', 'src/core/clock.js', 'src/market/candles.js', 'src/analysis/indicators.js'].forEach(file => {
      const source = read(file);
      ok(/typeof module !== 'undefined' && module\.exports/.test(source), file + ' must export as a module');
      ok(/typeof window !== 'undefined'/.test(source), file + ' must attach for the interface');
    });
  });

  suite('no two scripts the page loads declare the same top-level name', () => {
    /* PLAIN SCRIPTS SHARE ONE TOP-LEVEL SCOPE. A `const` of the same name in
       two of them is a redeclaration error that kills the second file entirely
       at parse time — nothing is logged, nothing throws anywhere visible, and
       every function that file was meant to provide is simply undefined. This
       happened for real: four modules each declared `const API`, so three of
       them silently did not exist in the interface. Each is now wrapped in its
       own scope; this suite proves they still are. */
    const loaded = (html.match(/<script src="([^"]+)"/g) || []).map(m => m.slice('<script src="'.length, -1));
    const declared = new Map();
    const offenders = [];

    loaded.forEach(src => {
      const file = path.resolve(path.join(ROOT, 'web'), src);
      const source = fs.readFileSync(file, 'utf8');

      /* A file wrapped in its own scope contributes nothing to the shared one,
         however its body happens to be indented. The suite below proves the
         wrapping is there; this one only has to police what is left outside. */
      if (/^\(function \(\) \{$/m.test(source) && /^\}\(\)\);$/m.test(source)) return;

      const names = (source.match(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm) || [])
        .map(m => m.replace(/^(?:const|let|var|function|class)\s+/, ''));

      names.forEach(name => {
        if (declared.has(name)) offenders.push(name + ' in both ' + declared.get(name) + ' and ' + src);
        else declared.set(name, src);
      });
    });

    eq(offenders.length, 0, 'top-level names collide: ' + offenders.join('; '));
  });

  suite('every shared module keeps its internals out of the shared scope', () => {
    ['src/core/num.js', 'src/core/clock.js', 'src/market/candles.js', 'src/analysis/indicators.js'].forEach(file => {
      const source = read(file);
      ok(/^\(function \(\) \{$/m.test(source), file + ' must be wrapped in a scope of its own');
      ok(/^\}\(\)\);$/m.test(source), file + ' must close that scope');
    });
  });

  suite('the interface does not carry its own copy of the formatting rules', () => {
    /* Two implementations drift, and the first symptom is two renderings of the
       same price on one screen. */
    ok(!/function money\s*\(/.test(app), 'the interface must call the shared formatter');
    ok(/num\.money\(/.test(app), 'and it does');
  });

  /* ============ branding ============ */
  console.log('\nBranding — the product name has exactly one home');

  suite('the product name appears in one source file and nowhere else', () => {
    const brand = require('../src/core/brand');
    const name = brand.name;
    const offenders = [];

    sourceFiles().forEach(file => {
      const relative = path.relative(ROOT, file).replace(/\\/g, '/');
      if (relative === 'src/core/brand.js') return;
      /* The icon tooling reads the artwork by its filename and the launcher
         names the runtime folder; neither is the product name compiled into
         behaviour. */
      if (relative === 'tools/make-icons.js') return;
      const source = fs.readFileSync(file, 'utf8');
      if (source.indexOf(name) !== -1) offenders.push(relative);
    });

    eq(offenders.length, 0, 'the product name is engraved into: ' + offenders.join(', '));
  });

  suite('the interface reads the name rather than hard-coding it', () => {
    ok(/brand-name/.test(html), 'the title bar has a slot for it');
    ok(/\$\('#brand-name'\)\.textContent = info\.name/.test(app), 'and fills it from the one source');
  });

  /* ============ house style ============ */
  console.log('\nHouse style — this repository is a product, not a transcript');

  suite('no source file reads like a conversation', () => {
    /* A stranger — an employer, a client — may open this repository. Nothing in
       it should record how it came to be written. */
    const banned = [
      /\bhe (asked|said|wanted|complained|reported)\b/i,
      /\bhis (complaint|request|words)\b/i,
      /\bas (you|u) (asked|said|wanted)\b/i,
      /\byou were right\b/i,
      /\bi (fixed|added) this because\b/i,
      /\bper (your|his) request\b/i
    ];
    const offenders = [];

    sourceFiles().forEach(file => {
      const relative = path.relative(ROOT, file).replace(/\\/g, '/');
      const source = fs.readFileSync(file, 'utf8');
      banned.forEach(pattern => {
        const found = source.match(pattern);
        if (found) offenders.push(relative + ': "' + found[0] + '"');
      });
    });

    eq(offenders.length, 0, offenders.join('; '));
  });

  suite('no placeholder or unfinished marker is left in the source', () => {
    const offenders = [];
    sourceFiles().forEach(file => {
      const relative = path.relative(ROOT, file).replace(/\\/g, '/');
      if (relative.indexOf('tests/') === 0) return;
      const source = fs.readFileSync(file, 'utf8');
      /* TODO and FIXME are fine in a scratch project and are not fine in one a
         stranger will read as finished work. */
      if (/\b(TODO|FIXME|XXX|HACK|lorem ipsum|placeholder text)\b/i.test(source)) offenders.push(relative);
    });
    eq(offenders.length, 0, 'left behind in: ' + offenders.join(', '));
  });

  /* ============ the tooling itself ============ */
  console.log('\nTooling — nothing that runs a test may reach real records');

  suite('the interface probe only removes a directory it created itself', () => {
    /* An earlier version removed its data directory unconditionally, which
       under --real-data pointed at the installation's own records — so running
       the probe against real data destroyed it, device token included. A
       cleanup step that can reach real records is not a cleanup step. */
    const probe = read('tests/ui-probe.js');
    const removals = probe.split('\n').filter(line => /fs\.rmSync\(/.test(line));
    ok(removals.length > 0, 'the probe must clean up after itself');
    removals.forEach(line => {
      ok(!/rmSync\(dataDir/.test(line) || /useReal/.test(probe.slice(Math.max(0, probe.indexOf(line) - 400), probe.indexOf(line))),
        'an unguarded removal of the data directory: ' + line.trim());
    });
    ok(/if \(!useReal\)/.test(probe), 'the removal must be guarded on the directory being temporary');
  });

  suite('the test suite writes only to a throwaway directory', () => {
    const runner = read('tests/run-all.js');
    ok(/process\.env\.TERMINAL_DATA_DIR = fs\.mkdtempSync/.test(runner),
      'every store must be pointed at a temporary directory before anything is required');
  });

  /* ============ the governing rule ============ */
  console.log('\nThe governing rule — nothing may claim to be live on its own authority');

  suite('no adapter declares itself real-time without the venue saying so', () => {
    const yahoo = require('../src/market/providers/yahoo');
    const cboe = require('../src/market/providers/cboe');
    eq(yahoo.coverage().realtime, null, 'a source that has not stated its latency claims nothing');
    eq(cboe.coverage().realtime, false);
  });

  suite('the live state is produced in exactly one place, behind the venue\'s own claim', () => {
    const source = read('src/market/freshness.js');
    const lines = source.split('\n');

    /* Only a `return finish(STATE.LIVE` actually produces the state; the other
       mentions are a severity ordering and a membership test. A second one
       appearing anywhere is the thing this guards against. */
    const producers = [];
    lines.forEach((line, i) => {
      if (/return finish\(STATE\.LIVE/.test(line)) producers.push(i);
    });
    eq(producers.length, 1, 'expected one producer of the live state, found ' + producers.length);

    /* The guard sits on the enclosing condition, in the lines just above. */
    const context = lines.slice(Math.max(0, producers[0] - 4), producers[0]).join(' ');
    ok(/realtime === true/.test(context),
      'the live state must require the provider to have claimed real-time: ' + context.trim());
    ok(/delaySeconds === null \|\| declaredDelay === 0|declaredDelay === null \|\| declaredDelay === 0/.test(context),
      'and it must require no declared delay: ' + context.trim());
  });

  suite('the interface never invents a freshness label of its own', () => {
    /* Every badge renders the label the freshness layer computed. A label
       assembled in the interface could say something the state does not
       support. */
    ok(/esc\(freshness\.label\)/.test(app), 'the badge prints the computed label');
    ok(!/['"]Live['"]\s*:/.test(app.slice(0, app.indexOf('function updateGlobalState'))),
      'no live label is constructed before the state is known');
  });

  suite('a figure that failed a blocking check is never published', () => {
    const engine = read('src/market/engine.js');
    ok(/checks\.some\(f => f\.severity === integrity\.SEVERITY\.BLOCK\)/.test(engine));
    ok(/return null;/.test(engine.slice(engine.indexOf('SEVERITY.BLOCK'))),
      'the publish path must return without storing the figure');
  });

  suite('the credit line is not written as a provenance claim', () => {
    const brand = require('../src/core/brand');
    ok(!/data (from|by|supplied|provided|sourced)/i.test(brand.credit),
      'provenance belongs to the sources drawer, which reads the real record');
  });
}

module.exports = { run };
