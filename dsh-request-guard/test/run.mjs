/**
 * Regression for dsh-request-guard pure logic (no harness needed).
 * Run: node dsh-plugins/dsh-request-guard/test/run.mjs
 */
import assert from 'node:assert/strict';
import { repairMessages, resultIds, sanitizeStream, toolCallIds } from '../index.js';

let pass = 0;
let failCount = 0;
function check(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => { pass++; console.log(`PASS ${name}`); })
        .catch((e) => { failCount++; console.log(`FAIL ${name}: ${e.message}`); });
}

const assistant = (blocks) => ({ role: 'assistant', content: blocks });
const call = (id, name, args = {}) => ({ type: 'tool-call', id, name, arguments: args });
const result = (callId) => ({ role: 'toolResult', content: [{ type: 'tool-result', toolCallId: callId, content: [] }] });

await check('clean history is returned untouched (same identity)', () => {
    const messages = [assistant([call('c1', 'read')]), result('c1'), { role: 'user', content: 'hi' }];
    const out = repairMessages(messages);
    assert.equal(out.changed, false);
    assert.equal(out.messages, messages, 'no copy for a clean history');
    assert.deepEqual(out.report, {
        droppedNamelessCalls: 0, droppedOrphanResults: 0, droppedStrandedResults: 0,
        synthesizedResults: 0, normalizedArguments: 0, droppedAssistants: 0,
    });
});

await check('R1: nameless tool-call block is dropped, its result becomes an orphan (R2)', () => {
    const messages = [
        assistant([call('c1', 'read'), call('c2', '')]),
        result('c1'),
        result('c2'),
    ];
    const out = repairMessages(messages);
    assert.equal(out.changed, true);
    assert.equal(out.report.droppedNamelessCalls, 1);
    assert.deepEqual(toolCallIds(out.messages[0]), ['c1']);
    assert.equal(out.report.synthesizedResults, 0, 'c1 keeps its real result');
    const allResults = out.messages.flatMap((m) => resultIds(m));
    assert.deepEqual(allResults, ['c1'], 'result of the dropped nameless call is gone');
    assert.equal(out.report.droppedOrphanResults, 1);
});

await check('R3: a call whose result disappeared gets a synthetic error result right after', () => {
    const messages = [assistant([call('c1', 'read')]), { role: 'user', content: 'next' }];
    const out = repairMessages(messages);
    assert.equal(out.report.synthesizedResults, 1);
    assert.equal(out.messages[1].role, 'toolResult');
    assert.equal(out.messages[1].content[0].toolCallId, 'c1');
    assert.equal(out.messages[1].content[0].isError, true);
    assert.equal(out.messages[2].role, 'user', 'inserted before the next message');
});

await check('R3: two calls in one message -> two synthetics when both results are gone', () => {
    const out = repairMessages([assistant([call('a', 'read'), call('b', 'grep')])]);
    assert.equal(out.report.synthesizedResults, 2);
    assert.deepEqual(out.messages.slice(1).map((m) => m.content[0].toolCallId), ['a', 'b']);
});

await check('R4: result stranded after a later assistant message is dropped', () => {
    const messages = [
        assistant([call('a', 'read')]),
        result('a'),
        assistant([call('b', 'read')]),
        result('b'),
        result('a'), // stranded re-play of an older result
    ];
    const out = repairMessages(messages);
    assert.equal(out.report.droppedStrandedResults, 1, 'stranded duplicate is dropped');
    assert.equal(out.report.droppedOrphanResults, 0);
    assert.deepEqual(out.messages.flatMap((m) => resultIds(m)), ['a', 'b']);
});

await check('R5: non-object arguments normalized to {}', () => {
    const messages = [assistant([{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"x"}' }]), result('c1')];
    const out = repairMessages(messages);
    assert.equal(out.report.normalizedArguments, 1);
    assert.deepEqual(out.messages[0].content[0].arguments, {});
    assert.equal(out.messages[0].content[0].name, 'read', 'name preserved');
});

await check('assistant whose only block was a nameless call is removed entirely', () => {
    const out = repairMessages([{ role: 'user', content: 'hi' }, assistant([call('', '')]), { role: 'user', content: 'again' }]);
    assert.equal(out.report.droppedAssistants, 1);
    assert.deepEqual(out.messages.map((m) => m.role), ['user', 'user']);
});

await check('mixed result message keeps only blocks whose call survives', () => {
    const mixed = { role: 'toolResult', content: [
        { type: 'tool-result', toolCallId: 'known', content: [] },
        { type: 'tool-result', toolCallId: 'ghost', content: [] },
    ] };
    const out = repairMessages([assistant([call('known', 'read')]), mixed]);
    assert.deepEqual(resultIds(out.messages[1]), ['known']);
    assert.equal(out.report.droppedOrphanResults, 1);
});

await check('stage A: empty tool-call ids are filled, stable per block index', async () => {
    let n = 0;
    const makeId = (index) => `synth-${index}-${++n}`;
    const stats = { filledIds: 0, streams: 0 };
    const chunks = [
        { type: 'tool-call-delta', index: 0, id: '', name: 'read' },
        { type: 'tool-call-delta', index: 0, id: '', name: 'read' },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: '', name: 'read' } },
        { type: 'text-delta', text: 'x' },
    ];
    const out = [];
    for await (const c of sanitizeStream(chunks, makeId, stats)) out.push(c);
    assert.equal(out[0].id, 'synth-0-1');
    assert.equal(out[1].id, 'synth-0-1', 'same index -> same synthetic id');
    assert.equal(out[2].block.id, 'synth-0-1', 'block-end reuses it');
    assert.equal(out[3].type, 'text-delta', 'other chunks pass through');
    assert.equal(stats.filledIds, 3);
    assert.equal(stats.streams, 1);
});

await check('stage A: a named, intact id is never rewritten', async () => {
    const out = [];
    for await (const c of sanitizeStream([{ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_real', name: 'read' } }], () => 'x', {})) out.push(c);
    assert.equal(out[0].block.id, 'call_real');
});

const summary = `RESULT run.mjs: pass=${pass} fail=${failCount}`;
console.log(summary);
if (failCount > 0) process.exit(1);
