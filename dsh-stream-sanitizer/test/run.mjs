// 回归：流清洗器的 7 条夹具。
import assert from 'node:assert/strict';
import { apply, sanitize } from '../index.js';

let seq = 0;
const makeId = (index) => `call-synth-test-${index}-${++seq}`;

async function* from(items) {
    for (const item of items) yield item;
}

async function collect(items, stats) {
    const out = [];
    for await (const chunk of sanitize(from(items), makeId, stats)) out.push(chunk);
    return out;
}

// 1) block-end 的空 id 被补上，name/arguments 原样
{
    const out = await collect([
        { type: 'block-start', index: 0, block: { type: 'tool-call' } },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: '', name: 'read', arguments: '{"file_path":"a"}' } },
    ]);
    const end = out.find((c) => c.type === 'block-end');
    assert.ok(typeof end.block.id === 'string' && end.block.id.length > 0, 'id filled');
    assert.equal(end.block.name, 'read');
    assert.equal(end.block.arguments, '{"file_path":"a"}');
}

// 2) delta 与 block-end 拿到同一个合成 id（跨 chunk 一致）
{
    const out = await collect([
        { type: 'tool-call-delta', index: 0, id: '', name: 'read', argumentsDelta: '{"file' },
        { type: 'tool-call-delta', index: 0, id: '', argumentsDelta: '_path":"a"}' },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: '', name: 'read', arguments: '{"file_path":"a"}' } },
    ]);
    const ids = out.filter((c) => c.type === 'tool-call-delta' || c.type === 'block-end').map((c) => (c.block ? c.block.id : c.id));
    assert.equal(new Set(ids).size, 1, 'one stable id per index');
    assert.ok(ids[0].length > 0);
}

// 3) 正常 id 一字不改
{
    const out = await collect([
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_abc', name: 'read', arguments: '{}' } },
    ]);
    assert.equal(out[0].block.id, 'call_abc');
}

// 4) 空 name 但有 id：不动（让上游照常报 unknown tool，会话可存活）
{
    const out = await collect([
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_x', name: '', arguments: '{}' } },
    ]);
    assert.equal(out[0].block.id, 'call_x');
    assert.equal(out[0].block.name, '');
}

// 5) 非工具 chunk 与 usage/finish 原样透传
{
    const items = [
        { type: 'text-delta', index: 1, text: 'hello' },
        { type: 'usage', usage: { inputTokens: 1 } },
        { type: 'finish', reason: 'stop' },
    ];
    const out = await collect(items);
    assert.deepEqual(out, items);
}

// 6) 计数正确
{
    const stats = { fixed: 0, streams: 0, lastFixAt: null, lastIndex: null };
    await collect([
        { type: 'tool-call-delta', index: 2, id: '', name: 'x', argumentsDelta: '{}' },
        { type: 'block-end', index: 2, block: { type: 'tool-call', id: '', name: 'x', arguments: '{}' } },
    ], stats);
    assert.equal(stats.fixed, 2);
    assert.equal(stats.streams, 1);
    assert.equal(stats.lastIndex, 2);
}

// 7) apply 接线：llm/stream 包装生效；stats 端点可读；关闭时不包装
{
    const routes = [];
    let listener;
    const ctx = {
        on: (event, fn) => { if (event === 'llm/stream') listener = fn; },
        effect: (fn) => fn(),
        webServer: { register: (route) => { routes.push(route); return () => {}; } },
    };
    apply(ctx, {});
    assert.equal(typeof listener, 'function', 'llm/stream listener registered');
    assert.equal(routes.length, 1, 'stats route registered');

    const wrapped = listener({}, () => from([
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: '', name: 'read', arguments: '{}' } },
    ]));
    const out = [];
    for await (const chunk of wrapped) out.push(chunk);
    assert.ok(out[0].block.id.length > 0, 'wrapped stream fills the id');

    const res = { writeHead() {}, end(t) { this.body = t; } };
    await routes[0].handler({ method: 'GET', url: '/stream-sanitizer/api/stats' }, res);
    const stats = JSON.parse(res.body);
    assert.equal(stats.ok, true);
    assert.ok(stats.stats.fixed >= 1, 'stats counted the fix');

    // 关闭：不包装，原样透传
    let offListener;
    const ctx2 = {
        on: (event, fn) => { if (event === 'llm/stream') offListener = fn; },
        effect: (fn) => fn(),
        webServer: { register: () => () => {} },
    };
    apply(ctx2, { enabled: false });
    const raw = from([{ type: 'block-end', index: 0, block: { type: 'tool-call', id: '', name: 'x', arguments: '{}' } }]);
    const same = offListener({}, () => raw);
    assert.equal(same, raw, 'disabled passes the upstream stream through untouched');
}

console.log('PASS dsh-stream-sanitizer: 7/7 fixtures');
