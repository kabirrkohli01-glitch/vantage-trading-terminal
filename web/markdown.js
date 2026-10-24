'use strict';
/* Markdown, rendered.
 *
 * The assistant writes markdown and the reader has to see a document rather than
 * asterisks. It was already rendered here in a reduced form — headings, lists,
 * bold, links, fenced code — which was enough while every answer was a few
 * paragraphs of prose. It is not enough now: an answer that lays out a level, a
 * stop and a target belongs in a table, and a table rendered as raw pipes is
 * worse than no table at all.
 *
 * ESCAPE FIRST, THEN INSERT TAGS. That order is the whole security model, and it
 * is not negotiable. Once the source has been escaped, nothing it contains can
 * become markup; only the tags added afterwards are real. A headline, an
 * article, a filing and a model's own output all pass through here, and every
 * one of them is text somebody else wrote.
 *
 * Links are http and https only, so a javascript: address cannot reach an href.
 */

(function () {

  const esc = text => String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /* Inline marks, applied to already-escaped text. Code spans are taken out
     first and put back last, so a backtick containing an asterisk is not
     emphasised inside its own code span.
   *
     The placeholder is a control character rather than punctuation, because it
     has to be something that cannot occur in the escaped text: an earlier form
     that wrapped the index in spaces matched any ordinary figure in the prose,
     so "I have 42 apples" came back with a code span where the 42 was. */
  function inline(source) {
    const spans = [];
    let text = esc(source).replace(/`([^`]+)`/g, (match, code) => {
      spans.push(code);
      return '\u0000' + (spans.length - 1) + '\u0000';
    });

    text = text
      .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<s>$1</s>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

    return text.replace(/\u0000(\d+)\u0000/g, (match, index) => '<code>' + spans[Number(index)] + '</code>');
  }

  const isTableRow = line => /^\s*\|.*\|\s*$/.test(line);
  /* The rule under a table's header, which also declares each column's
     alignment. Its presence is what distinguishes a table from a line of prose
     that happens to contain pipes. */
  const isTableRule = line => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

  function cellsOf(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
  }

  function alignmentsOf(rule) {
    return cellsOf(rule).map(cell => {
      if (/^:-+:$/.test(cell)) return 'center';
      if (/^-+:$/.test(cell)) return 'right';
      return null;
    });
  }

  function render(source) {
    const lines = String(source || '').split('\n');
    const out = [];
    let list = null;
    let fence = null;
    let quote = null;

    const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
    const closeQuote = () => { if (quote) { out.push('<blockquote>' + quote.join(' ') + '</blockquote>'); quote = null; } };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (/^\s*```/.test(line)) {
        if (fence === null) { closeList(); closeQuote(); fence = []; continue; }
        out.push('<pre><code>' + esc(fence.join('\n')) + '</code></pre>');
        fence = null;
        continue;
      }
      if (fence !== null) { fence.push(line); continue; }

      /* A table is a header row, a rule, then body rows. Anything else that
         happens to start with a pipe is left as prose. */
      if (isTableRow(line) && i + 1 < lines.length && isTableRule(lines[i + 1])) {
        closeList(); closeQuote();
        const header = cellsOf(line);
        const alignments = alignmentsOf(lines[i + 1]);
        const body = [];
        let j = i + 2;
        while (j < lines.length && isTableRow(lines[j])) { body.push(cellsOf(lines[j])); j++; }
        out.push(tableHtml(header, alignments, body));
        i = j - 1;
        continue;
      }

      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        closeList(); closeQuote();
        out.push('<hr>');
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        closeList(); closeQuote();
        /* Shifted down two levels: these sit inside a panel that already has its
           own heading, and an h1 in the middle of a page is wrong twice over. */
        const level = Math.min(6, heading[1].length + 2);
        out.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>');
        continue;
      }

      const quoted = line.match(/^\s*>\s?(.*)$/);
      if (quoted) {
        closeList();
        if (!quote) quote = [];
        quote.push(inline(quoted[1]));
        continue;
      }
      closeQuote();

      const bullet = line.match(/^\s*[-*+•]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (bullet || numbered) {
        const wanted = bullet ? 'ul' : 'ol';
        if (list && list !== wanted) closeList();
        if (!list) { out.push('<' + wanted + '>'); list = wanted; }
        out.push('<li>' + inline((bullet || numbered)[1]) + '</li>');
        continue;
      }

      closeList();
      if (line.trim()) out.push('<p>' + inline(line) + '</p>');
    }

    if (fence !== null) out.push('<pre><code>' + esc(fence.join('\n')) + '</code></pre>');
    closeList();
    closeQuote();
    return out.join('');
  }

  function tableHtml(header, alignments, body) {
    const cell = (tag, text, index) => {
      const align = alignments[index];
      return '<' + tag + (align ? ' style="text-align:' + align + '"' : '') + '>' +
        inline(text) + '</' + tag + '>';
    };

    return '<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
      header.map((text, i) => cell('th', text, i)).join('') +
      '</tr></thead><tbody>' +
      body.map(row => '<tr>' +
        /* A short row is padded rather than dropped: a model occasionally omits
           a trailing empty cell and the table would otherwise lose its shape. */
        header.map((_, i) => cell('td', row[i] === undefined ? '' : row[i], i)).join('') +
        '</tr>').join('') +
      '</tbody></table></div>';
  }

  window.T = window.T || {};
  window.T.markdown = { render, inline, esc, isTableRow, isTableRule, cellsOf };

}());
