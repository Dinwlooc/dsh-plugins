// 修复 GLM 空 tool-call id 会话（session-9b7f69c8…）。
// 只做一件事：把 assistant/message 里 id 为空的 tool-call 块删掉，并删掉配对的空 tool/call。
// 默认 dry-run：只打印将要发生的变化；--apply 才写盘（先备份）。
import fs from 'node:fs';
import zlib from 'node:zlib';

const MAGIC = 0xFD2FB528;
function frameEnd(buf, start) {
  let p = start + 4;
  const fhd = buf[p++];
  const fcsFlag = fhd >> 6; const single = (fhd >> 5) & 1; const checksum = (fhd >> 2) & 1; const didFlag = fhd & 3;
  if (!single) p += 1;
  p += [0, 1, 2, 4][didFlag];
  p += fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  for (;;) {
    const bh = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    const last = bh & 1; const type = (bh >> 1) & 3; const size = bh >>> 3;
    p += 3 + (type === 1 ? 1 : size);
    if (last) break;
  }
  if (checksum) p += 4;
  return p;
}

function decode(file) {
  const buf = fs.readFileSync(file);
  let off = 0; const parts = [];
  while (off < buf.length) {
    const end = frameEnd(buf, off);
    parts.push(zlib.zstdDecompressSync(buf.subarray(off, end)));
    off = end;
  }
  return Buffer.concat(parts).toString('utf8');
}

const file = process.argv[2];
const apply = process.argv.includes('--apply');
if (!file) { console.error('usage: node repair-empty-toolcall.mjs <session.v4.jsonl.zstd> [--apply]'); process.exit(2); }

const text = decode(file);
const lines = text.split('\n').filter((l) => l.length > 0);
const rows = lines.map((l) => JSON.parse(l));

const removedBlocks = [];
const removedRows = [];
const kept = [];

for (const row of rows) {
  if (row?.type === 'assistant/message') {
    const content = row?.data?.message?.content;
    if (Array.isArray(content)) {
      const bad = content.filter((b) => b?.type === 'tool-call' && (typeof b.id !== 'string' || b.id.length === 0));
      if (bad.length > 0) {
        removedBlocks.push({ seq: row.seq, count: bad.length, names: bad.map((b) => b.name) });
        row.data.message.content = content.filter((b) => !(b?.type === 'tool-call' && (typeof b.id !== 'string' || b.id.length === 0)));
      }
    }
  }
  if (row?.type === 'tool/call' && (typeof row?.data?.callId !== 'string' || row.data.callId.length === 0)) {
    removedRows.push({ seq: row.seq, name: row?.data?.name });
    continue;
  }
  kept.push(row);
}

console.log('rows in:', rows.length, 'rows out:', kept.length);
console.log('removed empty tool-call blocks:', JSON.stringify(removedBlocks));
console.log('removed empty tool/call rows:', JSON.stringify(removedRows));

if (!apply) { console.log('dry-run only (pass --apply to write)'); process.exit(0); }

const next = kept.map((r) => JSON.stringify(r)).join('\n') + '\n';
const compressed = zlib.zstdCompressSync(Buffer.from(next, 'utf8'));
const backup = `${file}.bak-${Date.now()}`;
fs.copyFileSync(file, backup);
const tmp = `${file}.tmp-${process.pid}`;
fs.writeFileSync(tmp, compressed);
fs.renameSync(tmp, file);
console.log('backup:', backup);
console.log('written bytes:', compressed.length);

// 自检：重新解码并校验
const check = decode(file).split('\n').filter(Boolean).map((l) => JSON.parse(l));
let bad = 0;
for (const r of check) {
  if (r?.type === 'tool/call' && (typeof r?.data?.callId !== 'string' || r.data.callId.length === 0)) bad += 1;
  const content = r?.data?.message?.content;
  if (Array.isArray(content)) for (const b of content) if (b?.type === 'tool-call' && (typeof b.id !== 'string' || b.id.length === 0)) bad += 1;
}
console.log('post-check rows:', check.length, 'remaining empty tool-call ids:', bad);
