'use strict';
/* Ask the research assistant a question from the command line.
 *
 * The same loop the interface uses, driven without opening a window. It is how
 * an answer is checked while the machine is in use, and it prints the parts the
 * interface shows around an answer — the steps it took, what it checked, and
 * any figure it stated that no tool actually supplied.
 *
 * Usage: node tools/ask-syrix.js "your question"
 */

const path = require('path');

process.env.TERMINAL_DATA_DIR = process.env.TERMINAL_DATA_DIR || path.join(__dirname, '..', 'data');

const http = require('../src/core/http');
const paths = require('../src/core/paths');
const { Store } = require('../src/core/store');
const { Audit } = require('../src/core/audit');
const { Engine } = require('../src/market/engine');
const { Ledger } = require('../src/portfolio/ledger');
const { Journal } = require('../src/portfolio/journal');
const { Gateway } = require('../src/syrix/gateway');
const { Conversation } = require('../src/syrix/loop');
const yahoo = require('../src/market/providers/yahoo');

const wait = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const question = process.argv.slice(2).filter(a => !a.startsWith('--')).join(' ');
  if (!question) {
    console.error('Usage: node tools/ask-syrix.js "your question"');
    process.exit(1);
  }

  http.setCacheDir(paths.dir('cache'));
  const config = new Store(paths.dir('config'));
  yahoo.useStore(config);

  const audit = new Audit(paths.auditFile());
  const engine = new Engine({ store: new Store(paths.dir('market')), audit });
  const gateway = new Gateway({ store: config, audit });

  if (!gateway.connected()) {
    console.error('Not connected. Run: node tools/pair-syrix.js <pairing-code>');
    process.exit(1);
  }

  const chat = new Conversation({
    gateway,
    audit,
    context: {
      engine,
      ledger: new Ledger(new Store(paths.dir('portfolio'))),
      journal: new Journal(new Store(paths.dir('journal'))),
      accountCurrency: 'GBP',
      timeZone: 'Europe/London',
      selectedSymbol: (process.argv.find(a => a.startsWith('--symbol=')) || '').split('=')[1] || null
    }
  });

  const { id } = chat.ask(question);
  let lastStep = '';

  for (let i = 0; i < 400; i++) {
    const job = chat.job(id);
    const live = job.steps.filter(s => !s.done)[0];
    if (live && live.label !== lastStep) {
      process.stdout.write('  … ' + live.label + '\n');
      lastStep = live.label;
    }

    if (job.state !== 'working') {
      console.log('');
      if (job.error) {
        console.error(job.error);
        process.exit(1);
      }
      console.log(job.answer);
      if (job.checked) console.log('\n\x1b[2m' + job.checked + '\x1b[0m');
      if (job.unsourced.length) {
        console.log('\x1b[33mFigures with no source in what was fetched: ' + job.unsourced.join(', ') + '\x1b[0m');
      }
      if (job.removedAdvice.length) {
        console.log('\x1b[2mRemoved ' + job.removedAdvice.length + ' line(s) that read as a recommendation to trade.\x1b[0m');
      }
      console.log('\x1b[2mTook ' + Math.round((job.finishedAt - job.startedAt) / 1000) + 's\x1b[0m');
      /* The poll loop keeps a timer alive; nothing is pending once the answer
         has landed. */
      process.exit(0);
    }
    await wait(300);
  }

  console.error('Timed out.');
  process.exit(1);
}

if (require.main === module) main();
