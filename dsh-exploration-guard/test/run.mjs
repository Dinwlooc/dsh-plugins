// 回归：按任务进展熔断的 8 条夹具。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

// 隔离持久化：设置界面写的 config.json 会覆盖 patch 值，夹具必须在空目录里跑。
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-test-'));
process.env.DSH_HOME = TEST_HOME;

function mount(config = {}) {
    const guards = [];
    const listeners = new Map();
    const routes = [];
    const ctx = {
        tools: { guard: (fn) => guards.push(fn) },
        on: (event, fn) => {
            if (!listeners.has(event)) listeners.set(event, []);
            listeners.get(event).push(fn);
        },
        effect: (fn) => fn(),
        webServer: { register: (route) => { routes.push(route); return () => {}; } },
    };
    apply(ctx, config);
    assert.equal(guards.length, 1, 'exactly one guard');
    assert.equal(routes.length, 1, 'settings route registered');
    assert.equal(routes[0].path, '/exploration-guard');
    const step = async (agent) => {
        for (const fn of listeners.get('agent/pre-step') ?? []) {
            await fn({ agent }, async () => ({ kind: 'enter', messages: [] }));
        }
    };
    const idle = (agent) => {
        for (const fn of listeners.get('agent/status') ?? []) fn({ agent, status: 'idle' });
    };
    const call = (name, args, agent) => guards[0]({ name, arguments: args, agent });
    return { step, idle, call };
}

const A = { session: { id: 's1' } };
const B = { session: { id: 's2' } };
const tick = async (h, n, agent = A) => {
    for (let i = 0; i < n; i++) await h.step(agent);
};

// 1) 阈值以下全部放行
{
    const h = mount({ softSteps: 3 });
    await tick(h, 2);
    assert.equal(h.call('read', { p: 1 }, A), undefined);
    assert.equal(h.call('grep', { q: 'x' }, A), undefined);
}

// 2) 到达 soft：非进度工具被否决，allowAlways 仍放行；理由含步数
{
    const h = mount({ softSteps: 3, hardSteps: 6 });
    await tick(h, 3);
    const reason = h.call('read', { p: 1 }, A);
    assert.equal(typeof reason, 'string');
    assert.match(reason, /3 step\(s\)/);
    // 受限期间必须说清：什么有用（补一个 completed / update_goal / 问 Owner）、什么无用（重写清单、读写 shell）
    assert.match(reason, /completed=/, 'shows the completed baseline');
    assert.match(reason, /Rewriting the list does not count/);
    assert.match(reason, /update_goal/);
    assert.match(reason, /genuinely finished/, "no invitation to fake completion");
    assert.match(reason, /Other tools are refused/);
    assert.ok(reason.length < 400, `message stays short (${reason.length})`);
    assert.equal(h.call('todo_write', { todos: [] }, A), undefined);
    assert.equal(h.call('ask_user_question', { question: 'q' }, A), undefined);
}

// 3) todo_write 首次建表算进展，计数清零
{
    const h = mount({ softSteps: 3, hardSteps: 6 });
    await tick(h, 3);
    assert.equal(typeof h.call('read', { p: 1 }, A), 'string');
    h.call('todo_write', { todos: [{ content: 'x', status: 'pending' }] }, A);
    assert.equal(h.call('read', { p: 1 }, A), undefined);
}

// 4) 完成数增加才算进展；原样重写不算
{
    const h = mount({ softSteps: 2, hardSteps: 9 });
    h.call('todo_write', { todos: [{ content: 'x', status: 'pending' }] }, A); // 首次 = 进展
    await tick(h, 2);
    assert.equal(typeof h.call('read', { p: 1 }, A), 'string'); // 无进展 → 否决
    h.call('todo_write', { todos: [{ content: 'x', status: 'pending' }] }, A); // 原样重写 → 不算
    assert.equal(typeof h.call('read', { p: 1 }, A), 'string');
    h.call('todo_write', { todos: [{ content: 'x', status: 'completed' }] }, A); // 完成 1 项 → 进展
    assert.equal(h.call('read', { p: 1 }, A), undefined);
}

// 5) hard 档：理由换成"需要 Owner"，allowAlways 仍放行
{
    const h = mount({ softSteps: 2, hardSteps: 4 });
    await tick(h, 4);
    const reason = h.call('read', { p: 1 }, A);
    assert.match(reason, /Owner/);
    assert.match(reason, /never mark work complete just to unblock/, "hard stage forbids gaming");
    assert.equal(h.call('update_goal', { action: 'complete' }, A), undefined);
}

// 6) idle 清零：等待 Owner 不算无进展
{
    const h = mount({ softSteps: 2, hardSteps: 5 });
    await tick(h, 3);
    assert.equal(typeof h.call('read', { p: 1 }, A), 'string');
    h.idle(A);
    assert.equal(h.call('read', { p: 1 }, A), undefined);
}

// 7) noTaskMode=skip：没建过任务表就不计时
{
    const h = mount({ softSteps: 1, hardSteps: 2, noTaskMode: 'skip' });
    await tick(h, 5);
    assert.equal(h.call('read', { p: 1 }, A), undefined);
}

// 8) 开关关闭 / 无 agent / 跨 agent 隔离
{
    const off = mount({ enabled: false, softSteps: 1 });
    await tick(off, 5);
    assert.equal(off.call('read', { p: 1 }, A), undefined);

    const h = mount({ softSteps: 2, hardSteps: 4 });
    await tick(h, 3, A);
    assert.equal(h.call('read', { p: 1 }, undefined), undefined, 'no agent → allow');
    assert.equal(h.call('read', { p: 1 }, B), undefined, 'other agent unaffected');
    assert.equal(typeof h.call('read', { p: 1 }, A), 'string');
}

// 9) 设置 API：GET 读值、POST 落盘并即时生效、非法值被拒
{
    const routes = [];
    const ctx = {
        tools: { guard: () => {} },
        on: () => {},
        effect: (fn) => fn(),
        webServer: { register: (route) => { routes.push(route); return () => {}; } },
    };
    apply(ctx, { softSteps: 7, hardSteps: 9 });

    const mkRes = () => ({ status: 0, body: '', writeHead(s) { this.status = s; }, end(t) { this.body = t; } });
    const mkReq = (method, url, payload) => {
        const chunks = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload), 'utf8')];
        return {
            method,
            url,
            async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; },
        };
    };

    const res1 = mkRes();
    await routes[0].handler(mkReq('GET', '/exploration-guard/api/config'), res1);
    const got1 = JSON.parse(res1.body);
    assert.equal(res1.status, 200);
    assert.equal(got1.config.softSteps, 7);
    // 隐私回归：响应里不得出现绝对路径/用户名，只给 \ 相对位置。
    assert.equal(got1.file, '$DSH_HOME/exploration-guard/config.json');
    assert.ok(!res1.body.includes(TEST_HOME), 'no absolute home path in response');
    assert.ok(!res1.body.includes('Users'), 'no user directory in response');

    const res2 = mkRes();
    await routes[0].handler(mkReq('POST', '/exploration-guard/api/config', { softSteps: 12, hardSteps: 3, noTaskMode: 'skip' }), res2);
    const got2 = JSON.parse(res2.body);
    assert.equal(res2.status, 200);
    assert.equal(got2.config.softSteps, 12);
    assert.equal(got2.config.hardSteps, 12, 'hardSteps 被抬到 softSteps');
    assert.equal(got2.config.noTaskMode, 'skip');

    const persisted = JSON.parse(fs.readFileSync(path.join(TEST_HOME, 'exploration-guard', 'config.json'), 'utf8'));
    assert.equal(persisted.softSteps, 12);
    assert.equal(persisted.noTaskMode, 'skip');

    const res3 = mkRes();
    await routes[0].handler(mkReq('POST', '/exploration-guard/api/config', { softSteps: 'abc', enabled: true }), res3);
    const got3 = JSON.parse(res3.body);
    assert.equal(got3.config.softSteps, 12, '非法值被忽略');
    assert.equal(got3.config.enabled, true);
}

console.log('PASS dsh-exploration-guard: 9/9 fixtures');
