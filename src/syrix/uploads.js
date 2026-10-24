'use strict';
/* Documents and images handed to the assistant.
 *
 * The chat surface has always implied this and never had it: an upload area with
 * no channel behind it. What arrives here is a chart the operator has screenshot
 * from somewhere else, a company's annual report, a broker statement, or a
 * spreadsheet of trades — and each of those wants different handling.
 *
 *   AN IMAGE IS NOT READ HERE. It is stored and passed to the model as an image,
 *   because a chart is a picture and describing it in words on the way in would
 *   throw away the thing being asked about.
 *
 *   A DOCUMENT IS READ HERE AND THE TEXT IS WHAT TRAVELS. A ten megabyte report
 *   cannot be sent to a model and does not need to be: its words can.
 *
 * TWO RULES ABOUT THE FILESYSTEM, BOTH LEARNED FROM A REAL LOSS.
 *
 *   A FILENAME IS NEVER DERIVED FROM AN IDENTIFIER WITHOUT BEING CLEANED. On
 *   this platform a colon in a path does not name a file, it names an alternate
 *   data stream hanging off one — the write succeeds, the byte count is right,
 *   nothing throws, and the file cannot afterwards be opened, listed or served.
 *   A person's CV was stored that way once and appeared to vanish.
 *
 *   NOTHING IS WRITTEN OUTSIDE THE UPLOAD DIRECTORY. The stored name is built
 *   here from a generated identifier and a cleaned extension, never from the
 *   name the file arrived with.
 */

const fs = require('fs');
const path = require('path');
const paths = require('../core/paths');
const pdf = require('../core/pdf');
const { id: makeId } = require('../core/util');

/* Large enough for an annual report and a full-resolution screenshot; small
   enough that a mistaken drag of a video is refused rather than stored. */
const MAX_BYTES = 24 * 1024 * 1024;

/* What the model can be shown as a picture. */
const IMAGE_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

const TEXT_TYPES = {
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'text/tab-separated-values': 'tsv',
  'application/json': 'json',
  'application/pdf': 'pdf'
};

/* An extension from a name, without trusting the name for anything else. */
function extensionOf(name, mime) {
  if (IMAGE_TYPES[mime]) return IMAGE_TYPES[mime];
  if (TEXT_TYPES[mime]) return TEXT_TYPES[mime];
  const match = /\.([a-z0-9]{1,6})$/i.exec(String(name || ''));
  return match ? match[1].toLowerCase() : 'bin';
}

/* Everything that could reach the filesystem, removed. Deliberately
   over-restrictive: the readable name is kept in the record and shown in the
   interface, so nothing is lost by the stored name being austere. */
function safeName(id, extension) {
  const stem = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
  /* The LEADING run of letters and digits, not every letter and digit anywhere
     in it. Squeezing the separators out of "p df/../y" produced "pdfy", which is
     safe but nonsense; taking the leading run gives "p", and a real extension is
     unaffected. */
  const suffix = (String(extension).match(/^[a-zA-Z0-9]+/) || [''])[0].slice(0, 6) || 'bin';
  return stem + '.' + suffix;
}

class Uploads {
  constructor(options) {
    const opts = options || {};
    this.store = opts.store;
    this.audit = opts.audit || null;
    this.dir = paths.dir('documents');
  }

  all() {
    return this.store.all('uploads');
  }

  list() {
    /* The extracted text is not sent to the interface: it can be megabytes and
       nothing on screen shows it. What is shown is what it is and how much of it
       was readable. */
    return this.all().map(record => ({
      id: record.id,
      name: record.name,
      kind: record.kind,
      mime: record.mime,
      bytes: record.bytes,
      addedAt: record.addedAt,
      readable: record.readable,
      characters: record.text ? record.text.length : 0,
      pages: record.pages || null,
      note: record.note || null
    }));
  }

  get(id) {
    return this.all().find(record => record.id === id) || null;
  }

  /* Take a file. `data` is base64, which is how it crossed the bridge. */
  add(input) {
    const file = input || {};
    const name = String(file.name || 'untitled').slice(0, 200);
    const mime = String(file.mime || '').toLowerCase().split(';')[0].trim();

    let bytes;
    try {
      bytes = Buffer.from(String(file.data || ''), 'base64');
    } catch (err) {
      throw new Error('That file could not be decoded.');
    }
    if (!bytes.length) throw new Error('That file is empty.');
    if (bytes.length > MAX_BYTES) {
      throw new Error('That file is ' + Math.round(bytes.length / 1048576) + 'MB, and the limit is ' +
        Math.round(MAX_BYTES / 1048576) + 'MB.');
    }

    const isImage = !!IMAGE_TYPES[mime];
    const isText = !!TEXT_TYPES[mime] || /\.(txt|md|csv|tsv|json|log)$/i.test(name);
    if (!isImage && !isText && !/\.pdf$/i.test(name)) {
      throw new Error('That kind of file cannot be read here. Images, PDFs, CSVs and text are understood.');
    }

    const id = makeId('doc');
    const extension = extensionOf(name, mime);
    const stored = safeName(id, extension);
    fs.writeFileSync(path.join(this.dir, stored), bytes);

    const read = isImage ? { readable: true, kind: 'image' } : this.extract(bytes, mime, name);

    const record = {
      id,
      name,
      mime: mime || 'application/octet-stream',
      kind: isImage ? 'image' : read.kind,
      file: stored,
      bytes: bytes.length,
      addedAt: Date.now(),
      readable: read.readable,
      pages: read.pages || null,
      note: read.note || null,
      text: read.text || null
    };

    this.store.put('uploads', record);
    if (this.audit) {
      this.audit.write('syrix.upload', { id, kind: record.kind, bytes: record.bytes, readable: record.readable });
    }

    return this.list().find(entry => entry.id === id);
  }

  /* Text out of whatever was handed over. */
  extract(bytes, mime, name) {
    if (mime === 'application/pdf' || /\.pdf$/i.test(name)) {
      const result = pdf.read(bytes, { maxPages: 80 });
      if (!result.readable) return { kind: 'document', readable: false, note: result.reason, pages: result.pages };
      return {
        kind: 'document',
        readable: true,
        pages: result.pages,
        text: result.text,
        note: result.truncated ? 'Read the first ' + result.pagesRead + ' of ' + result.pages + ' pages.' : null
      };
    }

    const text = bytes.toString('utf8');
    if (/csv|tab-separated/.test(mime) || /\.(csv|tsv)$/i.test(name)) {
      return Object.assign({ kind: 'table' }, describeTable(text));
    }
    return { kind: 'document', readable: true, text };
  }

  remove(id) {
    const record = this.get(id);
    if (record && record.file) {
      try { fs.unlinkSync(path.join(this.dir, record.file)); } catch (e) { /* already gone */ }
    }
    this.store.remove('uploads', id);
    return true;
  }

  /* What the assistant is given for a set of attachments: images as pictures,
     documents as text. Anything unreadable is described rather than dropped, so
     the answer can say the file could not be read instead of ignoring it. */
  materialise(ids) {
    const wanted = (ids || []).map(String);
    const media = [];
    const documents = [];
    const problems = [];

    wanted.forEach(id => {
      const record = this.get(id);
      if (!record) { problems.push('An attachment could not be found.'); return; }

      if (record.kind === 'image') {
        try {
          const bytes = fs.readFileSync(path.join(this.dir, record.file));
          media.push({ type: 'image', mime: record.mime, data: bytes.toString('base64'), name: record.name });
        } catch (err) {
          problems.push(record.name + ' could not be read back from disk.');
        }
        return;
      }

      if (!record.readable || !record.text) {
        problems.push(record.name + ': ' + (record.note || 'no text could be read from it.'));
        return;
      }
      documents.push({ name: record.name, kind: record.kind, text: record.text });
    });

    return { media, documents, problems };
  }
}

/* A table is summarised rather than pasted whole. A thousand rows of a broker
   export is more than a model can read and less than it needs: the columns, the
   size, and enough rows to see the shape are what let it answer. */
function describeTable(source) {
  const lines = String(source || '').split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) return { readable: false, note: 'That file has no rows in it.' };

  const separator = (lines[0].match(/\t/g) || []).length > (lines[0].match(/,/g) || []).length ? '\t' : ',';
  const columns = splitRow(lines[0], separator);
  const sample = lines.slice(1, 26).map(line => splitRow(line, separator));

  const text = [
    'A table with ' + (lines.length - 1) + ' rows and ' + columns.length + ' columns.',
    'Columns: ' + columns.join(' | '),
    '',
    'The first ' + sample.length + ' rows:',
    sample.map(row => row.join(' | ')).join('\n')
  ].join('\n');

  return {
    readable: true,
    text,
    note: lines.length > 27 ? 'Summarised: ' + (lines.length - 1) + ' rows, of which 25 are shown.' : null
  };
}

/* Splits on the separator while respecting quoted fields, because a broker
   export routinely has a comma inside a security's name. */
function splitRow(line, separator) {
  const out = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i++; continue; }
      quoted = !quoted;
      continue;
    }
    if (ch === separator && !quoted) { out.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  out.push(current.trim());
  return out;
}

module.exports = { Uploads, safeName, describeTable, splitRow, MAX_BYTES, IMAGE_TYPES, TEXT_TYPES };
