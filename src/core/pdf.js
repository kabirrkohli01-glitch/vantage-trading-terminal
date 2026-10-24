'use strict';
/* Reading the text out of a PDF, with nothing installed.
 *
 * There is no PDF library here and none may be added, so this is a small reader
 * built on the format itself and on zlib, which the platform already has. It
 * does one job — recover the readable text of a document, in reading order, page
 * by page — and it does not attempt layout, tables, forms or images.
 *
 * HOW A PDF ACTUALLY HOLDS ITS TEXT, which is why this is more than a regular
 * expression:
 *
 *   The file is a set of numbered objects. Most content is compressed, usually
 *   with FlateDecode, so nothing readable exists in the bytes until it is
 *   inflated. Anything looking for words in the raw file finds a few stray
 *   fragments and misses the document.
 *
 *   Since version 1.5 most objects are themselves packed inside OBJECT STREAMS —
 *   an object of type ObjStm holding dozens of others end to end with an offset
 *   table at the front. A reader that only walks top-level objects finds the
 *   page tree missing entirely on any modern file.
 *
 *   Text is drawn by operators inside a content stream: Tj draws a string, TJ
 *   draws an array of strings with kerning numbers between them, and ' and "
 *   move to the next line and draw. The strings are in the font's own encoding,
 *   which is frequently NOT ascii: a subsetted font maps its glyphs to whatever
 *   codes it likes, and the mapping back to real characters is in a /ToUnicode
 *   CMap attached to the font. Without applying that, extracted text from a
 *   professionally typeset document is mojibake.
 *
 * WHAT IS NOT SUPPORTED, said plainly because a caller must be able to tell the
 * difference between a document with no text and one this reader could not read:
 * encrypted files, and text drawn as vector outlines or held only in a scanned
 * image. Both come back with `readable: false` and a reason.
 */

const zlib = require('zlib');

const MAX_OBJECTS = 60000;

/* ---------- the object layer ---------- */

/* Every `N G obj … endobj` in the file, indexed by number.
 *
 * Scanned rather than read through the cross-reference table on purpose: a real
 * file is routinely appended to, linearised, or slightly malformed, and the
 * table then disagrees with the offsets. Scanning finds every object that is
 * actually present, and a later revision of an object naturally overwrites an
 * earlier one because it appears later in the file. */
function collectObjects(buffer) {
  const objects = new Map();
  const text = buffer.toString('latin1');
  const pattern = /(\d+)\s+(\d+)\s+obj\b/g;
  let match;
  let count = 0;

  while ((match = pattern.exec(text)) !== null && count < MAX_OBJECTS) {
    const number = Number(match[1]);
    const start = match.index + match[0].length;
    const end = text.indexOf('endobj', start);
    if (end === -1) continue;
    objects.set(number, { number, start, end, raw: text.slice(start, end) });
    count++;
  }

  return { objects, text };
}

/* The bytes of an object's stream, inflated where it is compressed.
 *
 * The length in the dictionary is often an indirect reference to another object,
 * and is sometimes simply wrong on a file that has been edited. The end marker
 * is therefore searched for as well and the shorter of the two is trusted. */
function streamOf(buffer, entry, resolveLength) {
  const marker = entry.raw.indexOf('stream');
  if (marker === -1) return null;

  let from = entry.start + marker + 'stream'.length;
  /* The specification allows CR LF or LF after the keyword and nothing else. */
  if (buffer[from] === 0x0d) from++;
  if (buffer[from] === 0x0a) from++;

  const declared = resolveLength(entry.raw);
  const marked = buffer.indexOf('endstream', from, 'latin1');
  let to = marked === -1 ? buffer.length : marked;
  if (Number.isFinite(declared) && declared > 0 && from + declared <= to) to = from + declared;

  const bytes = buffer.subarray(from, to);
  const filters = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(entry.raw);
  const filter = filters ? filters[1] : '';

  try {
    if (/FlateDecode/.test(filter)) return zlib.inflateSync(bytes);
    if (/LZWDecode|DCTDecode|JPXDecode|CCITTFaxDecode/.test(filter)) return null;
    return bytes;
  } catch (err) {
    /* A stream with trailing rubbish after the compressed data throws on a
       strict inflate and succeeds on a lenient one. Worth one retry: it is
       common in files produced by older tools. */
    try {
      return zlib.inflateSync(bytes, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    } catch (e) {
      return null;
    }
  }
}

/* ---------- object streams ---------- */

/* An ObjStm holds N objects packed together, preceded by pairs of
   "object number, offset". Expanding them is what makes a modern file
   readable at all. */
function expandObjectStreams(buffer, index, resolveLength) {
  const added = new Map();

  index.objects.forEach(entry => {
    if (!/\/Type\s*\/ObjStm/.test(entry.raw)) return;
    const body = streamOf(buffer, entry, resolveLength);
    if (!body) return;

    const count = Number((/\/N\s+(\d+)/.exec(entry.raw) || [])[1]);
    const first = Number((/\/First\s+(\d+)/.exec(entry.raw) || [])[1]);
    if (!Number.isFinite(count) || !Number.isFinite(first)) return;

    const source = body.toString('latin1');
    const header = source.slice(0, first).trim().split(/\s+/).map(Number);

    for (let i = 0; i < count; i++) {
      const number = header[i * 2];
      const offset = header[i * 2 + 1];
      if (!Number.isFinite(number) || !Number.isFinite(offset)) continue;
      const next = i + 1 < count ? header[(i + 1) * 2 + 1] : source.length - first;
      const raw = source.slice(first + offset, first + (Number.isFinite(next) ? next : source.length));
      if (!index.objects.has(number)) added.set(number, { number, raw, start: -1, end: -1 });
    }
  });

  added.forEach((entry, number) => index.objects.set(number, entry));
}

/* ---------- the page tree ---------- */

function refIn(text, key) {
  const match = new RegExp('\\/' + key + '\\s+(\\d+)\\s+\\d+\\s+R').exec(text);
  return match ? Number(match[1]) : null;
}

function refsIn(text) {
  return (text.match(/(\d+)\s+\d+\s+R/g) || []).map(part => Number(part.split(/\s+/)[0]));
}

/* Pages in document order. The tree is walked rather than the objects filtered,
   because filtering gives them in file order, which is not reading order on any
   file produced by a tool that writes pages as it lays them out. */
function pagesOf(index) {
  const catalog = Array.from(index.objects.values()).find(entry => /\/Type\s*\/Catalog/.test(entry.raw));
  const rootNumber = catalog ? refIn(catalog.raw, 'Pages') : null;
  const pages = [];
  const seen = new Set();

  const walk = number => {
    if (number == null || seen.has(number) || pages.length > 2000) return;
    seen.add(number);
    const entry = index.objects.get(number);
    if (!entry) return;

    if (/\/Type\s*\/Page\b/.test(entry.raw)) { pages.push(entry); return; }

    const kids = /\/Kids\s*\[([\s\S]*?)\]/.exec(entry.raw);
    if (kids) refsIn(kids[1]).forEach(walk);
  };

  if (rootNumber != null) walk(rootNumber);

  /* A file whose catalogue could not be found still has its pages; falling back
     to file order is worse than nothing only if it is presented as certain. */
  if (!pages.length) {
    Array.from(index.objects.values())
      .filter(entry => /\/Type\s*\/Page\b/.test(entry.raw))
      .forEach(entry => pages.push(entry));
  }

  return pages;
}

/* The content streams a page names, whether it names one or several. */
function contentsOf(page, index) {
  const single = refIn(page.raw, 'Contents');
  if (single != null && index.objects.has(single)) return [index.objects.get(single)];

  const array = /\/Contents\s*\[([\s\S]*?)\]/.exec(page.raw);
  if (!array) return [];
  return refsIn(array[1]).map(number => index.objects.get(number)).filter(Boolean);
}

/* Form XObjects reachable from a page, depth first. */
function formsOf(node, index, depth) {
  if (depth > 2) return [];

  let resources = node.raw;
  const resourceRef = refIn(node.raw, 'Resources');
  if (resourceRef != null && index.objects.has(resourceRef)) resources = index.objects.get(resourceRef).raw;

  const block = /\/XObject\s*<<([\s\S]*?)>>/.exec(resources);
  const dictionary = block ? block[1]
    : (refIn(resources, 'XObject') != null && index.objects.has(refIn(resources, 'XObject'))
      ? index.objects.get(refIn(resources, 'XObject')).raw : '');

  const out = [];
  (dictionary.match(/\/[^\s/<>]+\s+(\d+)\s+\d+\s+R/g) || []).forEach(entry => {
    const number = Number(/(\d+)\s+\d+\s+R/.exec(entry)[1]);
    const target = index.objects.get(number);
    if (!target || !/\/Subtype\s*\/Form\b/.test(target.raw)) return;
    out.push(target);
    formsOf(target, index, depth + 1).forEach(nested => out.push(nested));
  });

  return out;
}

/* ---------- character mapping ---------- */

/* A /ToUnicode CMap maps the codes a subsetted font uses onto real characters.
   Two forms appear: single mappings in bfchar, and contiguous ranges in
   bfrange. Both are read; a range whose destination is an array is read
   element by element. */
function parseCMap(source) {
  const map = new Map();

  const chars = source.match(/beginbfchar([\s\S]*?)endbfchar/g) || [];
  chars.forEach(block => {
    const pairs = block.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g) || [];
    pairs.forEach(pair => {
      const parts = pair.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/);
      map.set(parseInt(parts[1], 16), fromHex(parts[2]));
    });
  });

  const ranges = source.match(/beginbfrange([\s\S]*?)endbfrange/g) || [];
  ranges.forEach(block => {
    const simple = block.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g) || [];
    simple.forEach(entry => {
      const parts = entry.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/);
      const from = parseInt(parts[1], 16);
      const to = parseInt(parts[2], 16);
      const base = parseInt(parts[3], 16);
      if (to - from > 65535) return;
      for (let code = from; code <= to; code++) {
        map.set(code, String.fromCodePoint(base + (code - from)));
      }
    });

    const listed = block.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g) || [];
    listed.forEach(entry => {
      const parts = entry.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/);
      const from = parseInt(parts[1], 16);
      const items = parts[3].match(/<([0-9a-fA-F]+)>/g) || [];
      items.forEach((item, i) => {
        map.set(from + i, fromHex(item.replace(/[<>]/g, '')));
      });
    });
  });

  return map;
}

function fromHex(hex) {
  let out = '';
  for (let i = 0; i + 3 < hex.length + 1; i += 4) {
    const code = parseInt(hex.slice(i, i + 4), 16);
    if (Number.isFinite(code) && code) out += String.fromCodePoint(code);
  }
  return out;
}

/* The mappings for every font a page uses, keyed by the name the content stream
   refers to them by. */
function fontsFor(page, index, buffer, resolveLength) {
  const fonts = new Map();

  let resources = page.raw;
  const resourceRef = refIn(page.raw, 'Resources');
  if (resourceRef != null && index.objects.has(resourceRef)) resources = index.objects.get(resourceRef).raw;

  const block = /\/Font\s*<<([\s\S]*?)>>/.exec(resources);
  const fontDict = block ? block[1] : (refIn(resources, 'Font') != null && index.objects.has(refIn(resources, 'Font'))
    ? index.objects.get(refIn(resources, 'Font')).raw : '');

  const named = fontDict.match(/\/([^\s/<>]+)\s+(\d+)\s+\d+\s+R/g) || [];
  named.forEach(entry => {
    const parts = /\/([^\s/<>]+)\s+(\d+)\s+\d+\s+R/.exec(entry);
    const fontEntry = index.objects.get(Number(parts[2]));
    if (!fontEntry) return;

    const toUnicode = refIn(fontEntry.raw, 'ToUnicode');
    if (toUnicode == null || !index.objects.has(toUnicode)) {
      fonts.set(parts[1], { map: null, twoByte: /\/Type0/.test(fontEntry.raw) });
      return;
    }
    const cmapBytes = streamOf(buffer, index.objects.get(toUnicode), resolveLength);
    fonts.set(parts[1], {
      map: cmapBytes ? parseCMap(cmapBytes.toString('latin1')) : null,
      twoByte: /\/Type0/.test(fontEntry.raw)
    });
  });

  return fonts;
}

/* ---------- the content stream ---------- */

/* Read the drawing operators and keep only what draws text.
 *
 * Strings are either literal, in round brackets with backslash escapes, or
 * hexadecimal, in angle brackets. A TJ array interleaves strings with kerning
 * numbers, and a large negative kern is a word space that the file never wrote
 * as a character — dropping those runs whole sentences together. */
function textOf(content, fonts) {
  const source = content.toString('latin1');
  const out = [];
  let font = null;
  let baseSize = 10;
  let size = 10;
  let i = 0;

  /* IS THIS DOCUMENT DRAWN A GLYPH AT A TIME?
   *
   * Some producers emit one Tj per character, each preceded by a Td carrying
   * that glyph's own advance width. A document written that way encodes its
   * spaces as glyphs like any other character — they are already in the text —
   * and inserting another space at every horizontal move turns a title into
   * "K A B I R R  W E A L T H". A real report came out of this reader that way
   * twice, under two different rules, before this check was added.
   *
   * The tell is the length of the strings: a document drawing words has strings
   * of many characters, and one drawing glyphs has strings of one. Where it is
   * drawing glyphs, horizontal movement is ignored entirely and the document's
   * own spaces are trusted. */
  const drawn = source.match(/\((?:[^()\\]|\\.)*\)\s*(?:Tj|TJ|'|")|<[0-9a-fA-F\s]*>\s*(?:Tj|TJ)/g) || [];
  const shortRuns = drawn.filter(run => {
    const literal = /^\(((?:[^()\\]|\\.)*)\)/.exec(run);
    if (literal) return literal[1].length <= 2;
    const hex = /^<([0-9a-fA-F\s]*)>/.exec(run);
    return hex ? hex[1].replace(/\s/g, '').length <= 4 : false;
  }).length;
  const glyphByGlyph = drawn.length > 12 && shortRuns / drawn.length > 0.7;

  /* Where the pen sits, in text space. Only relative movement matters, so the
     origin is arbitrary. */
  const pen = { x: 0, y: 0 };

  const moveTo = (x, y) => {
    const downwards = Math.abs(y - pen.y) > Math.max(size * 0.3, 0.5);
    if (downwards) out.push('\n');
    else if (!glyphByGlyph && x - pen.x > size * 0.28) out.push(spacer(out));
    pen.x = x;
    pen.y = y;
  };

  /* The pen after a string has been drawn. Half an em a character is a rough
     average across proportional fonts and is only used to decide whether the
     next move is a gap or a nudge. */
  const advance = length => { pen.x += size * 0.5 * length; };

  const readLiteral = () => {
    let depth = 1;
    let value = '';
    i++;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '\\') {
        const next = source[i + 1];
        const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
        if (escapes[next] !== undefined) { value += escapes[next]; i += 2; continue; }
        const octal = /^[0-7]{1,3}/.exec(source.slice(i + 1, i + 4));
        if (octal) { value += String.fromCharCode(parseInt(octal[0], 8)); i += 1 + octal[0].length; continue; }
        i += 2;
        continue;
      }
      if (ch === '(') depth++;
      if (ch === ')') { depth--; if (!depth) { i++; break; } }
      value += ch;
      i++;
    }
    return value;
  };

  const readHex = () => {
    const end = source.indexOf('>', i);
    if (end === -1) { i = source.length; return ''; }
    const hex = source.slice(i + 1, end).replace(/[^0-9a-fA-F]/g, '');
    i = end + 1;
    return hex;
  };

  const decode = (raw, isHex) => {
    const mapping = font && fonts.get(font);
    const map = mapping && mapping.map;
    const wide = mapping && (mapping.twoByte || (map && Array.from(map.keys()).some(k => k > 255)));

    if (isHex) {
      const step = wide ? 4 : 2;
      let text = '';
      for (let p = 0; p + step <= raw.length; p += step) {
        const code = parseInt(raw.slice(p, p + step), 16);
        text += map && map.has(code) ? map.get(code) : String.fromCharCode(code);
      }
      return text;
    }

    if (!map) return raw;
    let text = '';
    for (let p = 0; p < raw.length; p++) {
      const code = raw.charCodeAt(p);
      text += map.has(code) ? map.get(code) : raw[p];
    }
    return text;
  };

  while (i < source.length) {
    const ch = source[i];

    if (ch === '/') {
      const name = /^\/([^\s/<>[\]()]+)/.exec(source.slice(i));
      if (name) {
        /* A font is selected by "/Name size Tf"; any other name is a different
           operator's operand and is ignored. */
        const after = source.slice(i + name[0].length, i + name[0].length + 24);
        const selection = /^\s*([\d.]+)\s*Tf/.exec(after);
        if (selection) {
          font = name[1];
          baseSize = Number(selection[1]) || 10;
          size = baseSize;
        }
        i += name[0].length;
        continue;
      }
    }

    if (ch === '(') {
      const value = readLiteral();
      const trailing = source.slice(i, i + 6);
      if (/^\s*(Tj|TJ|'|")/.test(trailing)) {
        const drawn = decode(value, false);
        out.push(drawn);
        advance(drawn.length);
      }
      continue;
    }

    if (ch === '<' && source[i + 1] !== '<') {
      const value = readHex();
      const trailing = source.slice(i, i + 6);
      if (/^\s*(Tj|TJ|'|")/.test(trailing)) {
        const drawn = decode(value, true);
        out.push(drawn);
        advance(drawn.length);
      }
      continue;
    }

    if (ch === '[') {
      const close = source.indexOf(']', i);
      if (close !== -1 && /^\s*TJ/.test(source.slice(close + 1, close + 6))) {
        const drawn = readArray(source.slice(i + 1, close), decode);
        out.push(drawn);
        advance(drawn.length);
        i = close + 1;
        continue;
      }
    }

    /* WHERE THE BREAKS GO, AND WHY THIS HAS TO BE MEASURED RATHER THAN DETECTED.
     *
     * Something has to be inserted at a positioning operator or the whole page
     * arrives as one line. Two naive rules were tried and both destroy real
     * documents:
     *
     *   Break on every positioning operator, and a letter-spaced heading — where
     *   the typesetter moves the pen before EVERY GLYPH — comes out as
     *   "K / A / B / I / R / R" one character per line. A real report did.
     *
     *   Break only on a vertical move and put a space on a horizontal one, and
     *   the same heading comes out as "K A B I R R". Also a real report.
     *
     * The distinction is not which operator was used, it is HOW FAR THE PEN
     * MOVED. So the pen is tracked, and where the last string would have ended
     * is estimated from the font size — half an em per character is close enough
     * for this decision and needs no glyph metrics. A move down is a new line. A
     * move right that is larger than a fraction of the font size is a space. A
     * move right smaller than that is letter spacing and produces nothing. */
    if (source.startsWith('T*', i)) { out.push('\n'); pen.y -= size * 1.2; pen.x = 0; i += 2; continue; }
    if (source.startsWith('ET', i)) { out.push('\n'); i += 2; continue; }

    if (source.startsWith('Td', i) || source.startsWith('TD', i)) {
      const numbers = trailingNumbers(source, i, 2);
      if (numbers.length === 2) moveTo(pen.x + numbers[0], pen.y + numbers[1]);
      i += 2;
      continue;
    }

    if (source.startsWith('Tm', i)) {
      const numbers = trailingNumbers(source, i, 6);
      if (numbers.length === 6) {
        /* The matrix also carries the scale, and a document that sets its font
           at size 1 and scales it in the matrix is common. */
        const scale = Math.abs(numbers[3]) || 1;
        size = (baseSize || 1) * scale;
        moveTo(numbers[4], numbers[5]);
      }
      i += 2;
      continue;
    }

    i++;
  }

  return out.join('')
    /* Several producers map their space glyph to a tab. It is a word break
       whatever code it arrives under, and a tab in prose reads as a fault. */
    .replace(/\t/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map(line => line.trim()).join('\n')
    .trim();
}

/* The operands an operator was given, read backwards from it. */
function trailingNumbers(source, at, count) {
  const before = source.slice(Math.max(0, at - 140), at);
  const found = before.match(/-?\d*\.?\d+/g) || [];
  return found.slice(-count).map(Number).filter(Number.isFinite);
}

/* A separator that does not double one that is already there. */
function spacer(out) {
  const last = out.length ? out[out.length - 1] : '';
  return /\s$/.test(last) ? '' : ' ';
}

/* Inside a TJ array: strings interleaved with kerning numbers in thousandths of
 * an em, negative meaning "move right".
 *
 * A WORD SPACE IS OFTEN NOT A SPACE CHARACTER — it is a large negative kern and
 * nothing else, so a reader that ignores the numbers runs every word together.
 * But a FIXED THRESHOLD DOES NOT WORK, and this is the single thing that most
 * damaged the output of this reader: a document that letter-spaces its headings
 * kerns between every glyph, at values well past any sensible constant, and a
 * title came out as "S T R A T E G Y  &  P L A N N I N G".
 *
 * So the threshold is taken from the array itself. Letter spacing is applied
 * uniformly, which makes the typical kern large; a word space is an outlier
 * against its own neighbours. Comparing each kern to the middle of the
 * distribution separates the two without knowing anything about the font. */
function readArray(inner, decode) {
  const parts = [];
  let i = 0;

  while (i < inner.length) {
    const ch = inner[i];
    if (ch === '(') {
      let depth = 1;
      let value = '';
      i++;
      while (i < inner.length && depth > 0) {
        if (inner[i] === '\\') { value += inner[i + 1] === '\\' ? '\\' : inner[i + 1]; i += 2; continue; }
        if (inner[i] === '(') depth++;
        if (inner[i] === ')') { depth--; if (!depth) { i++; break; } }
        value += inner[i];
        i++;
      }
      parts.push({ text: decode(value, false) });
      continue;
    }
    if (ch === '<') {
      const end = inner.indexOf('>', i);
      if (end === -1) break;
      parts.push({ text: decode(inner.slice(i + 1, end).replace(/[^0-9a-fA-F]/g, ''), true) });
      i = end + 1;
      continue;
    }
    const number = /^-?[\d.]+/.exec(inner.slice(i));
    if (number) {
      parts.push({ kern: Number(number[0]) });
      i += number[0].length;
      continue;
    }
    i++;
  }

  const gaps = parts.filter(p => p.kern != null && p.kern < 0).map(p => -p.kern).sort((a, b) => a - b);
  const middle = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  /* Below a quarter of an em nothing is a word space whatever the distribution
     says, and a document with genuinely no letter spacing keeps the plain
     threshold rather than inventing one from noise. */
  const threshold = Math.max(240, middle * 1.8);

  let out = '';
  parts.forEach(part => {
    if (part.text != null) { out += part.text; return; }
    if (part.kern < -threshold && !/\s$/.test(out) && out) out += ' ';
  });
  return out;
}

/* ---------- the reader ---------- */

function read(buffer, options) {
  const opts = options || {};
  if (!Buffer.isBuffer(buffer) || buffer.length < 5 || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return { readable: false, reason: 'That file does not begin like a PDF.' };
  }

  const index = collectObjects(buffer);

  const resolveLength = raw => {
    const direct = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(raw);
    if (direct) return Number(direct[1]);
    const indirect = /\/Length\s+(\d+)\s+\d+\s+R/.exec(raw);
    if (!indirect) return NaN;
    const entry = index.objects.get(Number(indirect[1]));
    if (!entry) return NaN;
    const value = /(\d+)/.exec(entry.raw);
    return value ? Number(value[1]) : NaN;
  };

  expandObjectStreams(buffer, index, resolveLength);

  if (Array.from(index.objects.values()).some(entry => /\/Encrypt\b/.test(entry.raw)) ||
      /\/Encrypt\s+\d+\s+\d+\s+R/.test(index.text.slice(-3000))) {
    return { readable: false, reason: 'That PDF is encrypted, so its text cannot be read here.' };
  }

  const pages = pagesOf(index);
  const limit = Math.min(pages.length, opts.maxPages || 120);
  const out = [];

  for (let i = 0; i < limit; i++) {
    const page = pages[i];
    const fonts = fontsFor(page, index, buffer, resolveLength);

    const streams = contentsOf(page, index);

    /* TEXT IS OFTEN NOT IN THE PAGE'S OWN CONTENT STREAM.
     *
     * A page may draw a Form XObject, which is a self-contained content stream
     * with its own resources, and put all of its text in there. Several editors
     * write every page that way. A reader that only looks at the page stream
     * finds the drawing operator, no text at all, and reports a two-page
     * document as a scan — which is what this one did to a real CV. Forms are
     * followed to a small depth, which is enough for every file seen and stops a
     * self-referential one from looping. */
    const forms = formsOf(page, index, 0);
    forms.forEach(form => {
      streams.push(form);
      fontsFor(form, index, buffer, resolveLength).forEach((value, key) => {
        if (!fonts.has(key)) fonts.set(key, value);
      });
    });

    const text = streams
      .map(entry => streamOf(buffer, entry, resolveLength))
      .filter(Boolean)
      .map(content => textOf(content, fonts))
      .filter(Boolean)
      .join('\n')
      .trim();

    if (text) out.push({ page: i + 1, text });
  }

  const joined = out.map(entry => entry.text).join('\n\n');

  if (!joined.trim()) {
    return {
      readable: false,
      pages: pages.length,
      reason: pages.length
        ? 'That PDF has ' + pages.length + ' page' + (pages.length === 1 ? '' : 's') +
          ' and no extractable text, which usually means it is a scan. There is nothing here to read ' +
          'without character recognition, which this application does not do.'
        : 'No pages could be found in that PDF.'
    };
  }

  return {
    readable: true,
    pages: pages.length,
    pagesRead: out.length,
    truncated: pages.length > limit,
    text: joined,
    byPage: out
  };
}

module.exports = { read, parseCMap, textOf, pagesOf, collectObjects };
