// 全库只读扫描：找出所有含「空 tool-call id」的会话（历史毒化的候选）。
// 不写任何文件；输出会话路径、空 id 的 seq 与类型。
import fs from 'node:fs';
import path from 'node:path';
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
    if (buf.readUInt32LE(off) !== MAGIC) throw new Error(`bad magic at ${off}`);
    const end = frameEnd(buf, off);
    parts.push(zlib.zstdDecompressSync(buf.subarray(off, end)));
    off = end;
  }
  return Buffer.concat(parts).toString('utf8');
}

const root = process.argv[2];
if (!root) { console.error('usage: node scan-all-sessions.mjs <sessions dir>'); process.exit(2); }

const hits = [];
let scanned = 0;
let failed = 0;

for (const project of fs.readdirSync(root)) {
  const projectDir = path.join(root, project);
  if (!fs.statSync(projectDir).isDirectory()) continue;
  for (const session of fs.readdirSync(projectDir)) {
    const file = path.join(projectDir, session, 'session.v4.jsonl.zstd');
    if (!fs.existsSync(file)) continue;
    scanned += 1;
    try {
      const rows = decode(file).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const bad = [];
      for (const r of rows) {
        if (r?.type === 'tool/call' && (typeof r?.data?.callId !== 'string' || r.data.callId.length === 0)) {
          bad.push({ seq: r.seq, kind: 'tool/call' });
        }
        const content = r?.data?.message?.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b?.type === 'tool-call' && (typeof b.id !== 'string' || b.id.length === 0)) {
              bad.push({ seq: r.seq, kind: 'assistant/message', name: b.name });
            }
          }
        }
      }
      if (bad.length > 0) hits.push({ project, session, file, bad });
    } catch (error) {
      failed += 1;
      hits.push({ project, session, file, error: String(error.message ?? error) });
    }
  }
}

console.log(`scanned sessions: ${scanned}, decode failures: ${failed}, poisoned: ${hits.filter((h) => h.bad).length}`);
for (const h of hits) {
  console.log(h.error ? `ERR  ${h.project}/${h.session}: ${h.error}` : `BAD  ${h.project}/${h.session}: ${JSON.stringify(h.bad)}`);
}
