// lib/core.js — pure text transforms behind the five dsh-file-ops tools.
// No fs and no tool calls here: every function takes strings and returns strings,
// so the test suite runs without a host.

const WORD_BEFORE = '(?<![A-Za-z0-9_])';
const WORD_AFTER = '(?![A-Za-z0-9_])';
const SENTENCE_BREAK = /[，。！？；：、,.;:!?…—–()\[\]{}（）【】《》“”‘’"'\t\r]/;

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function countWordMatches(text, needle) {
  if (!needle) return 0;
  const re = new RegExp(WORD_BEFORE + escapeRe(needle) + WORD_AFTER, 'g');
  return (text.match(re) || []).length;
}

export function replaceWord(text, needle, replacement) {
  const re = new RegExp(WORD_BEFORE + escapeRe(needle) + WORD_AFTER, 'g');
  let hits = 0;
  const out = text.replace(re, () => { hits += 1; return replacement; });
  return { text: out, hits };
}

export function eolInfo(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  return { crlf, lf, mixed: crlf > 0 && lf > 0 };
}

export function parseText(text) {
  const info = eolInfo(text);
  if (info.mixed) throw new Error('mixed line endings are not supported in one file; normalise it first');
  const eol = info.crlf > 0 ? '\r\n' : '\n';
  const trailing = text.endsWith(eol);
  const lines = text.split(eol);
  if (trailing) lines.pop();
  return { lines, trailing, eol };
}

export function renderText(lines, trailing, eol) {
  if (lines.length === 0) return '';
  const sep = eol || '\n';
  return lines.join(sep) + (trailing ? sep : '');
}

export function need(cond, message) {
  if (!cond) throw new Error(message);
}

export function sliceLines(lines, start, end) {
  need(Number.isInteger(start) && Number.isInteger(end), 'line numbers must be integers');
  need(start >= 1, 'start line must be >= 1');
  need(start <= end, 'start line must not exceed end line');
  need(end <= lines.length, 'end line ' + end + ' exceeds file length ' + lines.length);
  return lines.slice(start - 1, end);
}

export function insertIndex(length, line, position) {
  need(Number.isInteger(line), 'target line must be an integer');
  need(line >= 1 && line <= length, 'target line ' + line + ' outside 1..' + length);
  return position === 'before' ? line - 1 : line;
}

export function copyBlock(srcText, start, end, dstText, options) {
  const position = options && options.position === 'before' ? 'before' : 'after';
  const mode = options && options.mode === 'overwrite' ? 'overwrite' : 'insert';
  const src = parseText(srcText);
  const dst = parseText(dstText);
  const block = sliceLines(src.lines, start, end);
  const at = insertIndex(dst.lines.length, options && options.dstLine, position);
  const out = dst.lines.slice();
  if (mode === 'overwrite') out.splice(at, block.length, ...block);
  else out.splice(at, 0, ...block);
  return { text: renderText(out, dst.trailing, dst.eol), block };
}

export function moveBlockInFile(text, start, end, dstLine, options) {
  const position = options && options.position === 'before' ? 'before' : 'after';
  const parsed = parseText(text);
  const block = sliceLines(parsed.lines, start, end);
  need(Number.isInteger(dstLine), 'target line must be an integer');
  need(!(dstLine >= start && dstLine <= end), 'target line lies inside the moved block');
  need(dstLine >= 1 && dstLine <= parsed.lines.length, 'target line ' + dstLine + ' outside 1..' + parsed.lines.length);
  const rest = parsed.lines.slice(0, start - 1).concat(parsed.lines.slice(end));
  const shifted = dstLine > end ? dstLine - block.length : dstLine;
  const at = insertIndex(rest.length, shifted, position);
  rest.splice(at, 0, ...block);
  return { text: renderText(rest, parsed.trailing, parsed.eol), block };
}

export function deleteLines(text, start, end) {
  const parsed = parseText(text);
  sliceLines(parsed.lines, start, end);
  parsed.lines.splice(start - 1, end - start + 1);
  return { text: renderText(parsed.lines, parsed.trailing, parsed.eol) };
}

export function swapInFile(text, start, end, targetLine) {
  const parsed = parseText(text);
  const L = parsed.lines;
  const block = sliceLines(L, start, end);
  need(Number.isInteger(targetLine), 'target line must be an integer');
  need(!(targetLine >= start && targetLine <= end), 'target line lies inside the block');
  need(targetLine >= 1 && targetLine <= L.length, 'target line ' + targetLine + ' outside 1..' + L.length);
  const line = L[targetLine - 1];
  const out = targetLine > end
    ? L.slice(0, start - 1).concat([line], L.slice(end, targetLine - 1), block, L.slice(targetLine))
    : L.slice(0, targetLine - 1).concat(block, L.slice(targetLine, start - 1), [line], L.slice(end));
  return { text: renderText(out, parsed.trailing, parsed.eol), block, line };
}

export function swapAcrossFiles(srcText, start, end, dstText, targetLine) {
  const src = parseText(srcText);
  const dst = parseText(dstText);
  const block = sliceLines(src.lines, start, end);
  need(Number.isInteger(targetLine), 'target line must be an integer');
  need(targetLine >= 1 && targetLine <= dst.lines.length, 'target line ' + targetLine + ' outside 1..' + dst.lines.length);
  const line = dst.lines[targetLine - 1];
  const nextSrc = src.lines.slice();
  nextSrc.splice(start - 1, block.length, line);
  const nextDst = dst.lines.slice();
  nextDst.splice(targetLine - 1, 1, ...block);
  return {
    srcText: renderText(nextSrc, src.trailing, src.eol),
    dstText: renderText(nextDst, dst.trailing, dst.eol),
    block,
    line,
  };
}

export function sentenceAround(line, at, length) {
  let s = at;
  let e = at + length;
  while (s > 0 && !SENTENCE_BREAK.test(line[s - 1])) s -= 1;
  while (e < line.length && !SENTENCE_BREAK.test(line[e])) e += 1;
  return line.slice(s, e).trim();
}

export function findSentences(text, needle) {
  const out = [];
  const seen = new Set();
  const rows = text.split('\n');
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    let at = row.indexOf(needle);
    while (at >= 0) {
      const sentence = sentenceAround(row, at, needle.length);
      const key = (i + 1) + '|' + sentence;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ line: i + 1, sentence });
      }
      at = row.indexOf(needle, at + needle.length);
    }
  }
  return out;
}
