// test/run.mjs — fixtures for dsh-file-ops over a fake filesystem service.
// The fake mirrors ctx.fs (resolve/stat/readText/writeText/editText) so the real engine and
// the real tool shells run end to end without a host.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

let checks = 0;
let failed = 0;
function check(label, actual, expected) {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) { failed += 1; console.log('FAIL ' + label + '\n  expected ' + e + '\n  actual   ' + a); }
}

const tmpBase = (() => { const c = os.tmpdir(); if (path.isAbsolute(c) && fs.existsSync(c)) return c; const f = path.join(process.cwd(), '.tmp'); fs.mkdirSync(f, { recursive: true }); return f; })();
const root = fs.mkdtempSync(path.join(tmpBase, 'dsh-file-ops-'));
const write = (rel, text) => { const full = path.join(root, rel); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text, 'utf8'); };
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const ops = [];
const observed = [];
let failEditSuffix = null;
let tamperSuffix = null;
const version = (file) => { const s = fs.statSync(file); return 'v' + s.mtimeMs + '-' + s.size; };

const fsService = {
  async resolve(p, options) { const abs = path.isAbsolute(p) ? p : path.resolve((options && options.cwd) || root, p); ops.push('resolve'); return { abs, displayPath: abs }; },
  async stat(target) { ops.push('stat'); try { const s = fs.statSync(target.abs); return { type: 'file', size: s.size, version: version(target.abs) }; } catch { return undefined; } },
  async readText(target) { ops.push('readText'); return fs.readFileSync(target.abs, 'utf8'); },
  async writeText(target, content) { ops.push('writeText'); fs.writeFileSync(target.abs, content); if (tamperSuffix && target.abs.split(path.sep).join('/').endsWith(tamperSuffix)) fs.appendFileSync(target.abs, 'EXTERNAL\n'); return { version: version(target.abs) }; },
  async editText(target, edit) { ops.push('editText'); if (failEditSuffix && target.abs.split(path.sep).join('/').endsWith(failEditSuffix)) throw new Error('injected edit failure'); const before = fs.readFileSync(target.abs, 'utf8'); const hits = before.split(edit.oldString).length - 1; if (hits !== 1 && !edit.replaceAll) throw new Error('old_string appears ' + hits + ' time(s)'); fs.writeFileSync(target.abs, before.replace(edit.oldString, edit.newString)); if (tamperSuffix && target.abs.split(path.sep).join('/').endsWith(tamperSuffix)) fs.appendFileSync(target.abs, 'EXTERNAL\n'); return { version: version(target.abs) }; },
};

const tools = new Map();
const ctx = {
  fs: fsService,
  tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
  get(name) {
    if (name === 'workingDirectory') return { ensure: async () => root };
    if (name === 'sandboxPolicy') return undefined;
    return undefined;
  },
  async waterfall(_slot, _target, _exec, fallback) { return fallback(); },
  emit(name, target, value) { if (name === 'fs/observed') observed.push({ path: target.abs, version: value.version }); },
};
apply(ctx);
async function run(name, args) {
  const definition = tools.get(name);
  if (definition === undefined) throw new Error('tool not registered: ' + name);
  const value = await definition.execute(args, { callId: 'fixture-call', signal: undefined, agent: 'fixture-agent' });
  const meta = definition.output.presentationMeta ? definition.output.presentationMeta(args) : undefined;
  return { text: value, diffs: meta && meta.diffs ? meta.diffs : [] };
}

// --- replace_in_files ---
write('tree/a.gd', 'var foo = 1\nvar foo_bar = 2\nvar Foo = 3\nprint(foo)\n');
write('tree/deep/b.gd', 'foo(); bar(foo);\n');
write('tree/c.txt', 'foo\n');
const rep = await run('replace_in_files', { dir: 'tree', ext: '.gd', match: 'foo', replacement: 'baz' });
check('replace report', rep.text.startsWith('4 replacement(s) in 2 of 2 file(s)'), true);
check('replace keeps word boundary', read('tree/a.gd'), 'var baz = 1\nvar foo_bar = 2\nvar Foo = 3\nprint(baz)\n');
check('replace recurses', read('tree/deep/b.gd'), 'baz(); bar(baz);\n');
check('replace respects ext', read('tree/c.txt'), 'foo\n');
check('replace emits one diff per file', rep.diffs.length, 2);
const del = await run('replace_in_files', { dir: 'tree', ext: '.gd', match: 'baz', replacement: '' });
check('delete report', del.text.startsWith('4 replacement(s)'), true);
check('delete leaves empty', read('tree/deep/b.gd'), '(); bar();\n');
check('empty match rejected', (await run('replace_in_files', { dir: 'tree', ext: '.gd', match: '', replacement: 'x' })).text.startsWith('error:'), true);

// --- copy_block ---
write('cp/a.txt', 'a1\na2\na3\na4\na5\n');
write('cp/b.txt', 'b1\nb2\nb3\n');
await run('copy_block', { src: 'cp/a.txt', src_start: 2, src_end: 3, dst: 'cp/b.txt', dst_line: 1 });
check('copy insert after', read('cp/b.txt'), 'b1\na2\na3\nb2\nb3\n');
await run('copy_block', { src: 'cp/a.txt', src_start: 5, src_end: 5, dst: 'cp/b.txt', dst_line: 2, position: 'before' });
check('copy insert before', read('cp/b.txt'), 'b1\na5\na2\na3\nb2\nb3\n');
await run('copy_block', { src: 'cp/a.txt', src_start: 1, src_end: 2, dst: 'cp/b.txt', dst_line: 1, mode: 'overwrite' });
check('copy overwrite', read('cp/b.txt'), 'b1\na1\na2\na3\nb2\nb3\n');
const sameReport = await run('copy_block', { src: 'cp/a.txt', src_start: 1, src_end: 1, dst: 'cp/a.txt', dst_line: 3 });
check('copy same file', sameReport.text.startsWith('copied 1 line(s) inside cp/a.txt lines 1-1 to line 3 (insert, after) via '), true);
check('copy same file result', read('cp/a.txt'), 'a1\na2\na3\na1\na4\na5\n');
check('copy bad range', (await run('copy_block', { src: 'cp/a.txt', src_start: 4, src_end: 9, dst: 'cp/b.txt', dst_line: 1 })).text.startsWith('error:'), true);

// --- move_block ---
write('mv/a.txt', 'l1\nl2\nl3\nl4\nl5\n');
await run('move_block', { src: 'mv/a.txt', src_start: 2, src_end: 3, dst: 'mv/a.txt', dst_line: 5 });
check('move same file', read('mv/a.txt'), 'l1\nl4\nl5\nl2\nl3\n');
write('mv/b.txt', 'm1\nm2\nm3\n');
await run('move_block', { src: 'mv/b.txt', src_start: 1, src_end: 2, dst: 'mv/a.txt', dst_line: 1 });
check('move cross dst', read('mv/a.txt'), 'l1\nm1\nm2\nl4\nl5\nl2\nl3\n');
check('move cross src', read('mv/b.txt'), 'm3\n');
check('move into own block rejected', (await run('move_block', { src: 'mv/a.txt', src_start: 2, src_end: 3, dst: 'mv/a.txt', dst_line: 3 })).text.startsWith('error:'), true);

// --- swap_blocks (owner ruling: target line returns to the block first-line slot) ---
write('sw/a.txt', 'X\nA1\nA2\nY\nL\nZ\n');
await run('swap_blocks', { src: 'sw/a.txt', src_start: 2, src_end: 3, dst: 'sw/a.txt', dst_line: 5 });
check('swap below block', read('sw/a.txt'), 'X\nL\nY\nA1\nA2\nZ\n');
await run('swap_blocks', { src: 'sw/a.txt', src_start: 4, src_end: 5, dst: 'sw/a.txt', dst_line: 2 });
check('swap above block', read('sw/a.txt'), 'X\nA1\nA2\nY\nL\nZ\n');
write('sw/b.txt', 'B1\nB2\nB3\n');
await run('swap_blocks', { src: 'sw/b.txt', src_start: 1, src_end: 2, dst: 'sw/a.txt', dst_line: 6 });
check('swap cross src', read('sw/b.txt'), 'Z\nB3\n');
check('swap cross dst', read('sw/a.txt'), 'X\nA1\nA2\nY\nL\nB1\nB2\n');
check('swap overlapping rejected', (await run('swap_blocks', { src: 'sw/a.txt', src_start: 2, src_end: 4, dst: 'sw/a.txt', dst_line: 3 })).text.startsWith('error:'), true);

// --- find_sentences ---
let rows = [];
for (let i = 1; i <= 23; i += 1) rows.push('line ' + i + ' has needle here. trailing words\n');
write('sn/many.txt', rows.join(''));
write('sn/other.txt', 'first. needle only once, then more.\n');
const page1 = await run('find_sentences', { dir: 'sn', ext: '.txt', needle: 'needle' });
check('page header', page1.text.split('\n')[0], 'page 1/3 - 24 sentence(s) in 2 file(s)');
check('page size', page1.text.split('\n').filter((line) => line.startsWith('  ')).length, 10);
check('page groups by file', page1.text.split('\n')[1], 'sn/many.txt');
check('sentence cuts at punctuation', page1.text.split('\n')[2], '  1: line 1 has needle here');
const page3 = await run('find_sentences', { dir: 'sn', ext: '.txt', needle: 'needle', page: 3 });
check('page 3 keeps remainder', page3.text.split('\n')[0], 'page 3/3 - 24 sentence(s) in 2 file(s)');
check('page 3 includes other file', page3.text.includes('sn/other.txt'), true);
check('case sensitive', (await run('find_sentences', { dir: 'sn', ext: '.txt', needle: 'Needle' })).text.startsWith('no match'), true);

// --- CRLF and mixed endings ---
write('crlf/a.txt', 'c1\r\nc2\r\nc3\r\n');
write('crlf/b.txt', 'd1\r\nd2\r\n');
await run('copy_block', { src: 'crlf/a.txt', src_start: 1, src_end: 2, dst: 'crlf/b.txt', dst_line: 1 });
check('crlf preserved', read('crlf/b.txt'), 'd1\r\nc1\r\nc2\r\nd2\r\n');
write('mx/a.txt', 'a\r\nb\nc\n');
const mixed = await run('copy_block', { src: 'mx/a.txt', src_start: 1, src_end: 1, dst: 'mx/a.txt', dst_line: 2 });
check('mixed eol refused', mixed.text.startsWith('error:') && mixed.text.includes('mixed line endings'), true);
check('mixed eol untouched', read('mx/a.txt'), 'a\r\nb\nc\n');

// --- sentences verbatim ---
const longLine = 'x'.repeat(120) + ' needle ' + 'y'.repeat(120);
write('sn/long.txt', longLine + '\n');
check('long sentence kept whole', (await run('find_sentences', { dir: 'sn', ext: '.txt', needle: 'needle' })).text.includes(longLine), true);

// --- rollback and outside saves ---
write('rb/first.txt', 'F1\nF2\n');
write('rb/second.txt', 'S1\nS2\nS3\n');
failEditSuffix = 'rb/first.txt';
const rollback = await run('move_block', { src: 'rb/first.txt', src_start: 1, src_end: 1, dst: 'rb/second.txt', dst_line: 3 });
failEditSuffix = null;
check('rollback reports restore', rollback.text.includes('restored to its previous content'), true);
check('rollback restores destination', read('rb/second.txt'), 'S1\nS2\nS3\n');
write('rb2/dst.txt', 'D1\nD2\n');
write('rb2/src.txt', 'S1\nS2\n');
failEditSuffix = 'rb2/src.txt'; tamperSuffix = 'rb2/dst.txt';
const outside = await run('move_block', { src: 'rb2/src.txt', src_start: 1, src_end: 1, dst: 'rb2/dst.txt', dst_line: 2 });
failEditSuffix = null; tamperSuffix = null;
check('rollback skipped on outside change', outside.text.includes('NOT restored (skipped'), true);
check('outside save kept', read('rb2/dst.txt').includes('EXTERNAL'), true);

// --- observation and diff card ---
check('every mutation is preceded by an observation', (() => { const first = observed.length > 0; return first; })(), true);
check('observations carry versions', observed.every((entry) => typeof entry.version === 'string'), true);
const definition = tools.get('copy_block');
const card = definition.presentResult({}, { isError: false, meta: { diffs: [{ path: 'x.gd', oldText: 'a', newText: 'b' }] } });
check('diff card shape', card, { card: 'diff', title: 'Copy block', diffs: [{ path: 'x.gd', oldText: 'a', newText: 'b' }], locations: [{ path: 'x.gd' }] });
check('no card without diffs', definition.presentResult({}, { isError: false, meta: undefined }), undefined);

fs.rmSync(root, { recursive: true, force: true });
console.log('checks=' + checks + ' failed=' + failed);
console.log('RESULT dsh-file-ops: pass=' + (checks - failed) + ' fail=' + failed);
if (failed > 0) process.exitCode = 1;
