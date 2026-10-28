// 只读：解剖一个会话的尾部结构（assistant/message 的 tool-call 与 tool/call / tool/result 配对）。
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
const rows = decode(file).split('\n').filter(Boolean).map((l) => JSON.parse(l));
console.log('rows', rows.length);

const declared = new Map(); // callId -> {seq, name}
const results = new Map();  // callId -> seq
const events = [];

for (const r of rows) {
  const type = r.type;
  if (type === 'assistant/message') {
    const content = r?.data?.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'tool-call') {
          declared.set(b.id, { seq: r.seq, name: b.name, atTurn: r.data.turn, atStep: r.data.step });
          events.push(`seq ${r.seq} assistant/message tool-call id=${JSON.stringify(b.id)} name=${JSON.stringify(b.name)}`);
        }
      }
    }
    // 记录 assistant message 里是否有 stop/abort 信息
    const stop = r?.data?.message?.source?.stopReason ?? r?.data?.stopReason;
    if (stop) events.push(`seq ${r.seq} assistant/message stopReason=${JSON.stringify(stop)}`);
  }
  if (type === 'tool/result') {
    const msg = r?.data?.message;
    const cid = msg?.toolCallId;
    if (cid) results.set(cid, r.seq);
    events.push(`seq ${r.seq} tool/result toolCallId=${JSON.stringify(cid)}`);
  }
  if (type === 'tool/call') {
    events.push(`seq ${r.seq} tool/call callId=${JSON.stringify(r?.data?.callId)} name=${JSON.stringify(r?.data?.name)}`);
  }
  if (type === 'turn/end' || type === 'abort' || type === 'turn/start' || type === 'step/end') {
    events.push(`seq ${r.seq} ${type} ${JSON.stringify(r?.data ?? {}).slice(0, 160)}`);
  }
}

const orphans = [...declared.entries()].filter(([id]) => !results.has(id));
console.log('\n--- declared tool calls:', declared.size, '| results:', results.size, '| orphans:', orphans.length);
for (const [id, info] of orphans) console.log('ORPHAN', JSON.stringify(id), 'declared at seq', info.seq, 'name', info.name, 'turn', info.atTurn, 'step', info.atStep);

console.log('\n--- tail events ---');
for (const e of events.slice(-30)) console.log(e);
