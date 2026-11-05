// index.js — five model-facing file tools over one file or a whole tree.
//
// Writes go through ctx.fs (the mounted backend: atomic, sandbox-guarded, version-checked) and the
// tool presents a diff card itself, the same contract @deepseek-ai/dsh-tool-fs uses:
//   presentResult -> { card: 'diff', title, diffs: [{ path, oldText, newText }], locations }.
// Observation is kept honest: each file is observed through ctx.fs before it is mutated, and the
// resulting version is recorded on fs/observed so later edits by any tool see a fresh version.
import path from 'node:path';
import { createEngine, minimalChunk, relative } from './lib/engine.js';

export const name = 'dsh-file-ops';
export const inject = ['tools', 'fs', 'workingDirectory'];

const LIST_LIMIT = 20;

const OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
  presentationMeta: (args) => {
    const key = keyOf(args);
    const diffs = DIFFS.get(key);
    DIFFS.delete(key);
    return diffs && diffs.length > 0 ? { diffs } : undefined;
  },
};

// Diff hunks are for the card only: they never travel in the model-facing result.
const DIFFS = new Map();
const DIFF_LIMIT = 64;

function keyOf(args) {
  try { return JSON.stringify(args); } catch { return ''; }
}

function diffCard(title) {
  return (_args, result) => {
    if (!result || result.isError) return undefined;
    const diffs = result.meta && Array.isArray(result.meta.diffs) ? result.meta.diffs : undefined;
    if (diffs === undefined || diffs.length === 0) return undefined;
    return { card: 'diff', title, diffs, locations: diffs.map((entry) => ({ path: entry.path })) };
  };
}

async function workspaceRoot(ctx, exec) {
  try {
    const dirs = ctx.get && ctx.get('workingDirectory');
    if (dirs && typeof dirs.ensure === 'function' && exec.agent !== undefined) {
      const found = await dirs.ensure(exec.agent, exec.signal);
      const p = typeof found === 'string' ? found : (found && (found.path || found.directory || found.root || found.cwd));
      if (typeof p === 'string' && p.length > 0) return p;
    }
  } catch { /* fall through */ }
  try {
    const dirs = ctx.get && ctx.get('workingDirectory');
    if (dirs && typeof dirs.ensure === 'function') {
      const found = await dirs.ensure(undefined, exec.signal);
      const p = typeof found === 'string' ? found : (found && (found.path || found.directory || found.root || found.cwd));
      if (typeof p === 'string' && p.length > 0) return p;
    }
  } catch { /* fall through */ }
  return process.cwd();
}

/** Build the engine host over ctx.fs for one tool call; collects diff hunks as a side effect. */
function fsHost(ctx, exec, root) {
  const diffs = [];
  let policy;
  try {
    const provider = ctx.get && ctx.get('sandboxPolicy');
    if (provider && exec.agent !== undefined) policy = provider.resolve({ session: exec.agent.session });
  } catch { policy = undefined; }

  const resolveOptions = async () => ({ cwd: root, signal: exec.signal });
  const observe = async (abs) => {
    const target = await ctx.fs.resolve(abs, await resolveOptions());
    const info = await ctx.fs.stat(target, exec.signal);
    if (info === undefined) return { target, version: undefined, text: undefined };
    const text = await ctx.fs.readText(target, exec.signal);
    return { target, version: info.version, text };
  };
  const markObserved = (target, version) => {
    if (version !== undefined) ctx.emit('fs/observed', target, { kind: 'present', version }, exec);
  };

  return {
    root: () => root,
    read: async (abs) => {
      const seen = await observe(abs);
      if (seen.text === undefined) throw new Error('not found: ' + abs);
      markObserved(seen.target, seen.version);
      return { text: seen.text, version: seen.version };
    },
    write: async (abs, content) => {
      const seen = await observe(abs).catch(() => undefined);
      const target = seen ? seen.target : await ctx.fs.resolve(abs, await resolveOptions());
      if (seen) markObserved(target, seen.version);
      const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined);
      const outcome = await ctx.fs.writeText(target, content, intent, exec.signal, policy);
      if (outcome && outcome.version !== undefined) markObserved(target, outcome.version);
    },
    edit: async (abs, oldString, newString) => {
      const seen = await observe(abs);
      if (seen.text === undefined) throw new Error('not found: ' + abs);
      markObserved(seen.target, seen.version);
      const intent = await ctx.waterfall('fs/edit-intent', seen.target, exec, () => undefined);
      const outcome = await ctx.fs.editText(seen.target, { oldString, newString, replaceAll: false }, intent, exec.signal, policy);
      if (outcome && outcome.version !== undefined) markObserved(seen.target, outcome.version);
    },
    onCommit: (abs, before, after) => {
      const chunk = minimalChunk(before, after);
      const entry = chunk
        ? { path: relative(root, abs), oldText: chunk.oldChunk, newText: chunk.newChunk }
        : { path: relative(root, abs), oldText: null, newText: after };
      const at = diffs.findIndex((existing) => existing.path === entry.path);
      if (at >= 0) diffs[at] = entry;
      else diffs.push(entry);
    },
    changes: () => diffs,
  };
}

function wrap(handler) {
  return async (args, exec) => {
    try {
      return await handler(args || {}, exec);
    } catch (error) {
      const detail = error && error.message ? error.message : String(error);
      return 'error: ' + detail;
    }
  };
}

function run(handler) {
  return wrap(async (args, exec) => {
    const root = await workspaceRoot(ctx_ref, exec);
    const host = fsHost(ctx_ref, exec, root);
    const engine = createEngine(host);
    const text = await handler(engine, args, root);
    const diffs = host.changes();
    if (diffs.length > 0) {
      const key = keyOf(args);
      DIFFS.set(key, diffs);
      while (DIFFS.size > DIFF_LIMIT) DIFFS.delete(DIFFS.keys().next().value);
    }
    return text;
  });
}

let ctx_ref = null;

export function apply(ctx) {
  ctx_ref = ctx;
  const disposers = createTools(ctx).map((definition) => ctx.tools.register(definition));
  return () => { for (const dispose of disposers) dispose(); };
}

function createTools(ctx) {
  return [createReplace(ctx), createCopy(ctx), createMove(ctx), createSwap(ctx), createSentences(ctx)];
}

function blockReport(verb, outcome) {
  const where = outcome.inPlace ? 'inside ' + outcome.from : 'from ' + outcome.from + ' to ' + outcome.to;
  return verb + ' ' + outcome.lines + ' line(s) ' + where + ' lines ' + outcome.start + '-' + outcome.end
    + ' to line ' + outcome.at + ' (' + (outcome.mode || 'insert') + ', ' + (outcome.position || 'after') + ') via ' + outcome.via;
}

const BLOCK_PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    src: { type: 'string', description: 'File holding the lines, relative to the workspace root.' },
    src_start: { type: 'integer', description: 'First line of the block, 1-based and inclusive.' },
    src_end: { type: 'integer', description: 'Last line of the block, 1-based and inclusive.' },
    dst: { type: 'string', description: 'File receiving the block; may be the same file.' },
    dst_line: { type: 'integer', description: 'Target line number, 1-based.' },
  },
  required: ['src', 'src_start', 'src_end', 'dst', 'dst_line'],
};

function withPosition(base, extra) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...base.properties,
      position: { type: 'string', enum: ['after', 'before'], description: 'Where the block lands relative to dst_line. Defaults to after.' },
      ...extra,
    },
    required: base.required,
  };
}

function createReplace() {
  return {
    name: 'replace_in_files',
    description: 'Replace every whole-word, case-sensitive occurrence of a literal string in all files with one suffix under a directory, subdirectories included. Returns the hit count per changed file. An empty replacement deletes the match.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dir: { type: 'string', description: 'Directory to scan, relative to the workspace root.' },
        ext: { type: 'string', description: 'File suffix to include, for example .gd. Only this exact suffix is visited.' },
        match: { type: 'string', description: 'Literal text to find. Case-sensitive; the match must not touch a letter, digit or underscore on either side.' },
        replacement: { type: 'string', description: 'Literal replacement text. Pass an empty string to delete the matches.' },
      },
      required: ['dir', 'ext', 'match', 'replacement'],
    },
    output: OUTPUT,
    presentResult: diffCard('Replace in files'),
    execute: run(async (engine, args) => {
      const outcome = await engine.replaceInFiles(args);
      if (outcome.total === 0) return 'no match: 0 hit(s) in ' + outcome.scanned + ' file(s) under ' + outcome.dir;
      const shown = outcome.files.slice(0, LIST_LIMIT).map((row) => '  ' + row.file + '  x' + row.hits);
      if (outcome.files.length > LIST_LIMIT) shown.push('  ... and ' + (outcome.files.length - LIST_LIMIT) + ' more file(s)');
      return outcome.total + ' replacement(s) in ' + outcome.files.length + ' of ' + outcome.scanned + ' file(s)\n' + shown.join('\n');
    }),
  };
}

function createCopy() {
  return {
    name: 'copy_block',
    description: 'Copy a contiguous line range from one file and place it at a target line of another file, or of the same file. Insert mode keeps the target lines; overwrite mode replaces as many target lines as the copied block has.',
    parameters: withPosition(BLOCK_PARAMS, {
      mode: { type: 'string', enum: ['insert', 'overwrite'], description: 'insert keeps the target lines and pushes them down; overwrite replaces as many lines from the landing point as the block is long. Defaults to insert.' },
    }),
    output: OUTPUT,
    presentResult: diffCard('Copy block'),
    execute: run(async (engine, args) => blockReport('copied', await engine.copy(args))),
  };
}

function createMove() {
  return {
    name: 'move_block',
    description: 'Move a contiguous line range to a target line of another file, or of the same file, inserting it there and removing the source lines completely.',
    parameters: withPosition(BLOCK_PARAMS, {}),
    output: OUTPUT,
    presentResult: diffCard('Move block'),
    execute: run(async (engine, args) => blockReport('moved', await engine.move(args))),
  };
}

function createSwap() {
  return {
    name: 'swap_blocks',
    description: 'Exchange a contiguous line range with a single target line: the block moves above the target line, then the target line moves back into the slot the block first line used to occupy. Works inside one file or across two.',
    parameters: BLOCK_PARAMS,
    output: OUTPUT,
    presentResult: diffCard('Swap block'),
    execute: run(async (engine, args) => blockReport('swapped', await engine.swap(args))),
  };
}

function createSentences() {
  return {
    name: 'find_sentences',
    description: 'List sentences containing a literal string across files of one suffix under a directory, grouped by file path with line numbers, at most 10 per page. A sentence is cut at the nearest punctuation or newline. Request page 2, 3, ... to continue.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dir: { type: 'string', description: 'Directory to scan, relative to the workspace root.' },
        ext: { type: 'string', description: 'File suffix to include, for example .gd.' },
        needle: { type: 'string', description: 'Literal text to look for inside a line. Case-sensitive.' },
        page: { type: 'integer', description: '1-based page number, 10 sentences per page. Defaults to 1.' },
      },
      required: ['dir', 'ext', 'needle'],
    },
    output: OUTPUT,
    execute: run(async (engine, args) => {
      const outcome = await engine.sentences(args);
      if (outcome.total === 0) return 'no match: 0 sentence(s) in ' + outcome.scanned + ' file(s) under ' + outcome.dir;
      const lines = ['page ' + outcome.page + '/' + outcome.pages + ' - ' + outcome.total + ' sentence(s) in ' + outcome.scanned + ' file(s)'];
      let current = null;
      for (const hit of outcome.hits) {
        if (hit.file !== current) {
          current = hit.file;
          lines.push(hit.file);
        }
        lines.push('  ' + hit.line + ': ' + hit.sentence);
      }
      if (outcome.asked > outcome.pages) lines.push('(requested page ' + outcome.asked + ' is past the last page; showing ' + outcome.pages + ')');
      return lines.join('\n');
    }),
  };
}
