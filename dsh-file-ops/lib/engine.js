// lib/engine.js — the five operations, host-agnostic.
// A shell supplies the write path (host tools) and the workspace root; this file owns
// every transform and every read, and never writes to disk itself.
import path from 'node:path';
import {
  copyBlock, deleteLines, findSentences, moveBlockInFile, replaceWord,
  swapAcrossFiles, swapInFile, need,
} from './core.js';
import { listFiles, readText, statStamp } from './fsops.js';

export function relative(root, abs) {
  const rel = path.relative(root, abs);
  return (rel === '' ? abs : rel).split(path.sep).join('/');
}

export function resolvePath(root, given, label) {
  need(typeof given === 'string' && given.length > 0, label + ' must be a non-empty path');
  return path.isAbsolute(given) ? given : path.resolve(root, given);
}

function occurrences(text, chunk) {
  if (!chunk) return 0;
  let count = 0;
  let at = text.indexOf(chunk);
  while (at >= 0) {
    count += 1;
    at = text.indexOf(chunk, at + chunk.length);
  }
  return count;
}

/** Smallest differing line block that reproduces `after` exactly, or null when it is not a safe anchor. */
export function minimalChunk(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const aEnd = a.length - tail;
  const bEnd = b.length - tail;
  let oldChunk = a.slice(head, aEnd).join('\n');
  let newChunk = b.slice(head, bEnd).join('\n');
  if (aEnd < a.length && aEnd > head) oldChunk += '\n';
  if (bEnd < b.length && bEnd > head) newChunk += '\n';
  if (oldChunk === '' && head > 0) {
    const anchor = a[head - 1] + '\n';
    oldChunk = anchor;
    newChunk = anchor + newChunk;
  }
  if (oldChunk === '' || oldChunk === newChunk) return null;
  if (occurrences(before, oldChunk) !== 1) return null;
  if (before.replace(oldChunk, newChunk) !== after) return null;
  return { oldChunk, newChunk };
}

/**
 * host = {
 *   root: async () => string,          workspace root
 *   gate: async (abs) => void,         optional observation-policy read
 *   write: async (abs, content) => void,
 *   edit: async (abs, oldChunk, newChunk) => void,
 * }
 */
export function createEngine(host) {
  async function root() {
    return await host.root();
  }

  async function readTracked(file) {
    if (host.read) {
      const read = await host.read(file);
      return { text: read.text, version: read.version };
    }
    const stamp = statStamp(file);
    return { text: readText(file), stamp };
  }

  /** Revert `abs` to `target` only while it still holds exactly `expected`; never clobber an outside save. */
  async function restore(abs, expected, target) {
    try {
      if (readText(abs) !== expected) return 'skipped: it changed after this tool wrote it';
      if (host.gate) await host.gate(abs);
      const chunk = minimalChunk(expected, target);
      if (chunk) await host.edit(abs, chunk.oldChunk, chunk.newChunk);
      else await host.write(abs, target);
      return true;
    } catch {
      return 'failed';
    }
  }

  async function commit(abs, before, after, stamp) {
    if (stamp) {
      const now = statStamp(abs);
      if (now.mtimeMs !== stamp.mtimeMs || now.size !== stamp.size) {
        throw new Error('file changed on disk since it was read: ' + abs);
      }
    }
    if (host.beforeWrite) await host.beforeWrite(abs);
    const chunk = minimalChunk(before, after);
    if (host.gate) await host.gate(abs);
    if (chunk) {
      await host.edit(abs, chunk.oldChunk, chunk.newChunk);
      if (host.onCommit) host.onCommit(abs, before, after);
      return 'edit';
    }
    await host.write(abs, after);
    if (host.onCommit) host.onCommit(abs, before, after);
    return 'write';
  }

  async function replaceInFiles(args) {
    const base = await root();
    const dir = resolvePath(base, args.dir, 'dir');
    need(typeof args.ext === 'string' && args.ext.length > 0, 'ext must be a non-empty suffix such as .gd');
    need(typeof args.match === 'string' && args.match.length > 0, 'match must be a non-empty string');
    const replacement = typeof args.replacement === 'string' ? args.replacement : '';
    const files = listFiles(dir, args.ext);
    const changed = [];
    let total = 0;
    for (const file of files) {
      const read = await readTracked(file);
      const outcome = replaceWord(read.text, args.match, replacement);
      if (outcome.hits === 0) continue;
      const via = await commit(file, read.text, outcome.text, read.stamp);
      total += outcome.hits;
      changed.push({ file: relative(base, file), hits: outcome.hits, via });
    }
    return { op: 'replaceInFiles', dir: relative(base, dir), scanned: files.length, total, files: changed };
  }

  async function copy(args) {
    const base = await root();
    const srcAbs = resolvePath(base, args.src, 'src');
    const dstAbs = resolvePath(base, args.dst, 'dst');
    const same = srcAbs === dstAbs;
    const srcRead = await readTracked(srcAbs);
    const dstRead = same ? srcRead : await readTracked(dstAbs);
    const position = args.position === 'before' ? 'before' : 'after';
    const mode = args.mode === 'overwrite' ? 'overwrite' : 'insert';
    const outcome = copyBlock(srcRead.text, Number(args.src_start), Number(args.src_end), dstRead.text, {
      dstLine: Number(args.dst_line), position, mode,
    });
    const via = await commit(dstAbs, dstRead.text, outcome.text, dstRead.stamp);
    return {
      op: 'copyBlock', lines: outcome.block.length,
      from: relative(base, srcAbs), to: relative(base, dstAbs),
      start: Number(args.src_start), end: Number(args.src_end), at: Number(args.dst_line),
      position, mode, via, inPlace: same,
    };
  }

  async function move(args) {
    const base = await root();
    const srcAbs = resolvePath(base, args.src, 'src');
    const dstAbs = resolvePath(base, args.dst, 'dst');
    const start = Number(args.src_start);
    const end = Number(args.src_end);
    const dstLine = Number(args.dst_line);
    const position = args.position === 'before' ? 'before' : 'after';
    const srcRead = await readTracked(srcAbs);
    if (srcAbs === dstAbs) {
      const outcome = moveBlockInFile(srcRead.text, start, end, dstLine, { position });
      const via = await commit(srcAbs, srcRead.text, outcome.text, srcRead.stamp);
      return {
        op: 'moveBlock', lines: outcome.block.length, from: relative(base, srcAbs), to: relative(base, srcAbs),
        start, end, at: dstLine, position, mode: 'insert', via, inPlace: true,
      };
    }
    const dstRead = await readTracked(dstAbs);
    const landed = copyBlock(srcRead.text, start, end, dstRead.text, { dstLine, position });
    const viaDst = await commit(dstAbs, dstRead.text, landed.text, dstRead.stamp);
    let viaSrc;
    try {
      const trimmed = deleteLines(srcRead.text, start, end);
      viaSrc = await commit(srcAbs, srcRead.text, trimmed.text, srcRead.stamp);
    } catch (error) {
      const restored = await restore(dstAbs, landed.text, dstRead.text);
      throw new Error('removing the source lines failed (' + (error && error.message ? error.message : String(error)) + '); destination '
        + (restored === true ? 'restored to its previous content' : 'NOT restored (' + restored + ')'));
    }
    return {
      op: 'moveBlock', lines: landed.block.length, from: relative(base, srcAbs), to: relative(base, dstAbs),
      start, end, at: dstLine, position, mode: 'insert', via: viaDst + '+' + viaSrc, inPlace: false,
    };
  }

  async function swap(args) {
    const base = await root();
    const srcAbs = resolvePath(base, args.src, 'src');
    const dstAbs = resolvePath(base, args.dst, 'dst');
    const start = Number(args.src_start);
    const end = Number(args.src_end);
    const targetLine = Number(args.dst_line);
    const srcRead = await readTracked(srcAbs);
    if (srcAbs === dstAbs) {
      const outcome = swapInFile(srcRead.text, start, end, targetLine);
      const via = await commit(srcAbs, srcRead.text, outcome.text, srcRead.stamp);
      return {
        op: 'swapBlocks', lines: outcome.block.length, from: relative(base, srcAbs), to: relative(base, srcAbs),
        start, end, at: targetLine, via, inPlace: true,
      };
    }
    const dstRead = await readTracked(dstAbs);
    const outcome = swapAcrossFiles(srcRead.text, start, end, dstRead.text, targetLine);
    const viaSrc = await commit(srcAbs, srcRead.text, outcome.srcText, srcRead.stamp);
    let viaDst;
    try {
      viaDst = await commit(dstAbs, dstRead.text, outcome.dstText, dstRead.stamp);
    } catch (error) {
      const restored = await restore(srcAbs, outcome.srcText, srcRead.text);
      throw new Error('swapping the destination failed (' + (error && error.message ? error.message : String(error)) + '); source '
        + (restored === true ? 'restored to its previous content' : 'NOT restored (' + restored + ')'));
    }
    return {
      op: 'swapBlocks', lines: outcome.block.length, from: relative(base, srcAbs), to: relative(base, dstAbs),
      start, end, at: targetLine, via: viaSrc + '+' + viaDst, inPlace: false,
    };
  }

  async function sentences(args) {
    const base = await root();
    const dir = resolvePath(base, args.dir, 'dir');
    need(typeof args.ext === 'string' && args.ext.length > 0, 'ext must be a non-empty suffix such as .gd');
    need(typeof args.needle === 'string' && args.needle.length > 0, 'needle must be a non-empty string');
    const pageSize = 10;
    const files = listFiles(dir, args.ext);
    const hits = [];
    for (const file of files) {
      const text = readText(file);
      for (const hit of findSentences(text, args.needle)) {
        hits.push({ file: relative(base, file), line: hit.line, sentence: hit.sentence });
      }
    }
    hits.sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : x.line - y.line));
    const pages = Math.max(1, Math.ceil(hits.length / pageSize));
    const asked = args.page === undefined ? 1 : Number(args.page);
    need(Number.isInteger(asked) && asked >= 1, 'page must be an integer >= 1');
    const page = Math.min(asked, pages);
    return {
      op: 'findSentences', dir: relative(base, dir), scanned: files.length,
      total: hits.length, pages, page, asked, pageSize,
      hits: hits.slice((page - 1) * pageSize, page * pageSize),
    };
  }

  return { replaceInFiles, copy, move, swap, sentences };
}
