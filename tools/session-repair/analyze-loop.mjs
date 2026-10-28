// 只读：解压一个会话，统计重复片段与 loop-guard 是否响过。
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
const text = decode(file);
const rows = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
console.log('rows', rows.length);

let reasoningChars = 0;
let repeatHits = 0;
const phrase = '让我尝试使用 pwsh 命令来运行 node 命令';
const counter = new Map();
for (const r of rows) {
  const content = r?.data?.message?.content;
  if (!Array.isArray(content)) continue;
  for (const b of content) {
    if (b?.type === 'reasoning' || b?.type === 'text') {
      const t = String(b.text ?? '');
      reasoningChars += t.length;
      const n = t.split(phrase).length - 1;
      if (n > 0) repeatHits += n;
      // 粗粒度：统计重复 12 字片段
      for (let i = 0; i + 12 <= t.length; i += 12) {
        const key = t.slice(i, i + 12);
        counter.set(key, (counter.get(key) ?? 0) + 1);
      }
    }
  }
}
const top = [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log('assistant text+reasoning chars:', reasoningChars);
console.log('phrase repeats:', repeatHits, JSON.stringify(phrase));
console.log('top repeated 12-char chunks:', JSON.stringify(top.map(([k, v]) => ({ k, v }))));

const all = text;
for (const pat of ['loop-guard', '已连续重复', 'breaking a repetitive stream', '重复']) {
  const n = all.split(pat).length - 1;
  console.log(`occurrences of ${JSON.stringify(pat)}:`, n);
}
