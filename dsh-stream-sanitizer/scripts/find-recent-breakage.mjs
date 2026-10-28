// 只读：找出最近 N 小时内写入、且发生过回合错误的会话，并判定形态（空 id / 400 / 其他）。
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
    const end = frameEnd(buf, off);
    parts.push(zlib.zstdDecompressSync(buf.subarray(off, end)));
    off = end;
  }
  return Buffer.concat(parts).toString('utf8');
}

const root = 'C:/Users/70585/.dsh/sessions';
const since = Date.now() - 3 * 3600 * 1000;
const rows = [];
for (const proj of fs.readdirSync(root)) {
  if (!proj.includes('5DE5')) continue;
  for (const s of fs.readdirSync(path.join(root, proj))) {
    const f = path.join(root, proj, s, 'session.v4.jsonl.zstd');
    if (!fs.existsSync(f)) continue;
    const st = fs.statSync(f);
    if (st.mtimeMs < since) continue;
    rows.push({ proj, s, f, mtime: st.mtime });
  }
}
rows.sort((a, b) => b.mtime - a.mtime);

for (const r of rows) {
  let text; try { text = decode(r.f); } catch { continue; }
  const evs = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const models = new Set();
  for (const e of evs) { const m = e?.data?.message?.source?.model ?? e?.data?.model; if (m) models.add(m); }
  const errors = evs.filter((e) => e.type === 'turn/end' && e.data?.reason?.kind === 'error')
    .map((e) => ({ turn: e.data.turn, msg: String(e.data.reason.error?.message ?? '').slice(0, 150) }));
  const emptyIds = [];
  for (const e of evs) {
    if (e.type === 'tool/call' && (typeof e?.data?.callId !== 'string' || e.data.callId === '')) emptyIds.push({ seq: e.seq, name: e?.data?.name });
    const c = e?.data?.message?.content;
    if (Array.isArray(c)) for (const b of c) if (b?.type === 'tool-call' && (typeof b.id !== 'string' || b.id === '')) emptyIds.push({ seq: e.seq, name: b.name, from: 'assistant/message' });
  }
  if (errors.length === 0 && emptyIds.length === 0) continue;
  console.log(`\n### ${r.s}  mtime=${r.mtime.toISOString()}  models=${[...models].join(',')}  rows=${evs.length}`);
  for (const e of errors) console.log('  ERROR turn', e.turn, ':', e.msg);
  for (const e of emptyIds) console.log('  EMPTY-ID', JSON.stringify(e));
  const tail = evs.slice(-6).map((e) => e.type);
  console.log('  tail:', tail.join(' -> '));
}
