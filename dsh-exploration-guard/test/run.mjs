// 回归：按任务进展熔断的 8 条夹具。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// 隔离持久化：设置界面写的 config.json 会覆盖 patch 值，夹具必须在空目录里跑。
// 顺序是判据：settings.js 在模块顶层读 DSH_HOME，导入插件前必须先把隔离目录设好；
// 否则夹具读的是真实 ~/.dsh，真配置（如 softSteps=12）会把夹具的 softSteps=3 覆盖掉。
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-test-'));
process.env.DSH_HOME = TEST_HOME;
const { apply } = await import('../index.js');

function mount(config = {}, services = {}) {
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
        get: (name) => services[name],
        webServer: { register: (route) => { routes.push(route); return () => {}; } },
    };
    apply(ctx, config);
    assert.equal(guards.length, 1, 'exactly one guard');
    // 锚定：设置端点的存在与行为（settings.js 契约）；路由条数是实现形状，新增端点不算需求变化。
    const settingsRoute = routes.find((r) => r.path === '/exploration-guard');
    assert.ok(settingsRoute, 'settings route registered at /exploration-guard');
    const step = async (agent) => {
        for (const fn of listeners.get('agent/pre-step') ?? []) {
            await fn({ agent }, async () => ({ kind: 'enter', messages: [] }));
        }
    };
    const idle = (agent) => {
        for (const fn of listeners.get('agent/status') ?? []) fn({ agent, status: 'idle' });
    };
    const call = (name, args, agent, extra) => guards[0]({ name, arguments: args, agent, ...(extra || {}) });
    // tools/post-execute：调用方（harness）用 defaultDecision 模拟"原样结果"。
    const post = async (exec, defaultDecision, result = {}) => {
        const fns = listeners.get('tools/post-execute') ?? [];
        let out;
        for (const fn of fns) {
            const current = out;
            const next = async () => (current === undefined ? defaultDecision : current);
            out = await fn(exec, result, next);
        }
        return out === undefined ? defaultDecision : out;
    };
    return { step, idle, call, post };
}

/** 带 session.append 探针的 agent：developer/message 走这条通道。 */
const mkAgent = (id = 's1') => {
    const notices = [];
    return { session: { id, append: (type, data, opts) => { notices.push({ type, data, opts }); return { seq: notices.length }; } }, notices };
};

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
    const settingsRoute = routes.find((r) => r.path === '/exploration-guard');

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
    await settingsRoute.handler(mkReq('GET', '/exploration-guard/api/config'), res1);
    const got1 = JSON.parse(res1.body);
    assert.equal(res1.status, 200);
    assert.equal(got1.config.softSteps, 7);
    // 隐私回归：响应里不得出现绝对路径/用户名，只给 \ 相对位置。
    assert.equal(got1.file, '$DSH_HOME/exploration-guard/config.json');
    assert.ok(!res1.body.includes(TEST_HOME), 'no absolute home path in response');
    assert.ok(!res1.body.includes('Users'), 'no user directory in response');

    const res2 = mkRes();
    await settingsRoute.handler(mkReq('POST', '/exploration-guard/api/config', { softSteps: 12, hardSteps: 3, noTaskMode: 'skip' }), res2);
    const got2 = JSON.parse(res2.body);
    assert.equal(res2.status, 200);
    assert.equal(got2.config.softSteps, 12);
    assert.equal(got2.config.hardSteps, 12, 'hardSteps 被抬到 softSteps');
    assert.equal(got2.config.noTaskMode, 'skip');

    const persisted = JSON.parse(fs.readFileSync(path.join(TEST_HOME, 'exploration-guard', 'config.json'), 'utf8'));
    assert.equal(persisted.softSteps, 12);
    assert.equal(persisted.noTaskMode, 'skip');

    const res3 = mkRes();
    await settingsRoute.handler(mkReq('POST', '/exploration-guard/api/config', { softSteps: 'abc', enabled: true }), res3);
    const got3 = JSON.parse(res3.body);
    assert.equal(got3.config.softSteps, 12, '非法值被忽略');
    assert.equal(got3.config.enabled, true);
}

// 10) PTC 批量：soft 不打断正在跑的程序；警告**追加**在 run_code 结果末尾
{
    // 夹具 9 把 softSteps/noTaskMode 落了盘，而落盘值优先于 patch：先清掉它。
    fs.rmSync(path.join(TEST_HOME, 'exploration-guard', 'config.json'), { force: true });
    const h = mount({ softSteps: 3, hardSteps: 9 });
    const ag = mkAgent();
    await tick(h, 3, ag);
    for (let i = 0; i < 12; i++) {
        assert.equal(h.call('read', { p: i }, ag, { parent: { token: 'p1' } }), undefined, 'nested call ' + i + ' must not be interrupted');
    }
    const decision = await h.post({ name: 'run_code', agent: ag }, { kind: 'accept', content: [{ type: 'text', text: 'program output' }] });
    assert.ok(Array.isArray(decision.content), 'decision still carries content');
    assert.equal(decision.content.length, 2, 'warning is appended, not replacing');
    assert.equal(decision.content[0].text, 'program output', 'original output kept verbatim');
    assert.match(decision.content[1].text, /Progress warning/);
    assert.match(decision.content[1].text, /step\(s\)/);
    assert.ok(!/Blocked:/.test(decision.content[1].text), 'a warning is not a denial');
    assert.equal(ag.notices.length, 0, 'no separate developer message: only the result is extended');
}

// 10c) 结果没有内容块时不碰返回值（宁可不告警，也不伪造结果）
{
    const h = mount({ softSteps: 1, hardSteps: 9 });
    await tick(h, 2);
    assert.equal(h.call('run_code', { code: 'x' }, A), undefined, 'soft only arms the notice');
    const decision = await h.post({ name: 'run_code', agent: A }, { kind: 'accept' });
    assert.deepEqual(decision, { kind: 'accept' }, 'no content → decision untouched');
    // 没有内容块时告警没送出去 → 一次性长文案不能被提前消费
    const next = await h.post({ name: 'run_code', agent: A }, { kind: 'accept', content: [{ type: 'text', text: 'out' }] });
    assert.match(next.content[1].text, /Three honest resets/, 'unsent warning keeps the one-shot long text');
}

// 10d) 每会话首次越软线 = 一次长告警（软加载插件提示词库）；之后越线只追加短提醒
{
    const h = mount({ softSteps: 2, hardSteps: 9 });
    const ag = mkAgent();
    await tick(h, 2, ag);
    assert.equal(h.call('run_code', { code: 'x' }, ag), undefined, 'soft only arms the notice');
    const first = await h.post({ name: 'run_code', agent: ag }, { kind: 'accept', content: [{ type: 'text', text: 'out1' }] });
    assert.equal(first.content.length, 2, 'warning appended');
    assert.match(first.content[1].text, /Progress warning/);
    assert.match(first.content[1].text, /plan before you explore/i);
    assert.match(first.content[1].text, /Three honest resets/);
    assert.match(first.content[1].text, /update_goal to a terminal state/);
    await tick(h, 1, ag);
    assert.equal(h.call('run_code', { code: 'y' }, ag), undefined, 'second step above soft still opens');
    const second = await h.post({ name: 'run_code', agent: ag }, { kind: 'accept', content: [{ type: 'text', text: 'out2' }] });
    assert.equal(second.content[0].text, 'out2', 'later batch output untouched');
    assert.match(second.content[1].text, /Progress warning/);
    assert.ok(!/Three honest resets/.test(second.content[1].text), 'long text appears once per session');
    assert.ok(second.content[1].text.length < first.content[1].text.length, 'later reminder is the short one');
}

// 10b) 软档下 run_code 照常开跑（它是唯一的模型直呼入口）
{
    const h = mount({ softSteps: 2, hardSteps: 4 });
    await tick(h, 3);
    assert.equal(h.call('run_code', { code: 'x' }, A), undefined, 'run_code opens at soft');
    assert.equal(h.call('read', { p: 1 }, A, { parent: { token: 'q' } }), undefined, 'and its nested calls still run');
}

// 11) 单步内多次调用不推进熔断（按步计）；程序内的 todo_write 完成项照样清零
{
    const h = mount({ softSteps: 3, hardSteps: 6 });
    await tick(h, 1);
    for (let i = 0; i < 5; i++) assert.equal(h.call('read', { p: i }, A), undefined, 'calls inside one step are free');
    await tick(h, 2);
    assert.equal(typeof h.call('read', { p: 9 }, A), 'string', 'three steps trip soft');
    h.call('todo_write', { todos: [{ content: 'x', status: 'completed' }] }, A);
    assert.equal(h.call('read', { p: 10 }, A), undefined, 'progress resets the step counter');
}

// 12) hard 档只锁 run_code 本身；文案与原生拦截不同（不冒充嵌套拦截图）
{
    const h = mount({ softSteps: 2, hardSteps: 4 });
    await tick(h, 6);
    const reason = h.call('run_code', { code: 'x' }, A);
    assert.equal(typeof reason, 'string', 'run_code is closed at hard');
    assert.match(reason, /run_code is closed at the hard threshold/);
    assert.match(reason, /hard=4/);
    assert.match(reason, /never mark work complete just to unblock/);
    assert.ok(!/Nested calls are refused/.test(reason), 'PTC 文案不复用原生拦截措辞');
    assert.equal(h.call('todo_write', { todos: [] }, A), undefined, 'progress tools stay open');
}

// 13) 计数按步：同一 step 内连开多段程序、上百次嵌套调用都不推进熔断
{
    const h = mount({ softSteps: 3, hardSteps: 9 });
    await tick(h, 1);
    for (let i = 0; i < 6; i++) assert.equal(h.call('run_code', { code: 'x' + i }, A), undefined, 'many programs in one step');
    for (let i = 0; i < 30; i++) assert.equal(h.call('read', { p: i }, A, { parent: { t: 1 } }), undefined, 'nested calls are free');
    await tick(h, 2);
    assert.equal(typeof h.call('read', { p: 99 }, A), 'string', 'steps are the unit that trips it');
    assert.match(h.call('read', { p: 98 }, A), /3 step\(s\)/);
}

// 14) 清单重写删掉旧完成项、同时新增完成项：completed 计数不变也必须算进展
{
    const h = mount({ softSteps: 2, hardSteps: 9 });
    h.call('todo_write', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] }, A);
    await tick(h, 2);
    assert.equal(typeof h.call('read', { p: 1 }, A), 'string', 'no progress yet');
    h.call('todo_write', { todos: [{ content: 'c', status: 'completed' }, { content: 'b', status: 'pending' }] }, A);
    assert.equal(h.call('read', { p: 2 }, A), undefined, 'a newly completed item unlocks even at equal count');
}

// 15) 原样重写（旧完成项也留着）仍然不算进展
{
    const h = mount({ softSteps: 2, hardSteps: 9 });
    const list = [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }];
    h.call('todo_write', { todos: list }, A);
    await tick(h, 2);
    assert.equal(typeof h.call('read', { p: 1 }, A), 'string');
    h.call('todo_write', { todos: list }, A);
    assert.equal(typeof h.call('read', { p: 2 }, A), 'string', 'rewriting the same list does not count');
}

// ---------- v0.4.0：read shaping ----------
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-ws-'));
const SA = { session: { id: 's-shape', header: { cwd: WS } } };
const NO_CWD = { session: { id: 's-nowcwd' } };

function writeDoc(rel, lines) {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, lines.join('\n') + '\n', 'utf8');
}

/** 模拟原生 read 的结果：N: 行内容。 */
function fakeRead(lines) {
    return { kind: 'accept', content: [{ type: 'text', text: lines.map((line, i) => `${i + 1}: ${line}`).join('\n') + '\n' }] };
}
const execRead = (rel, agent = SA, extra = {}) => ({ name: 'read', arguments: Object.assign({ file_path: rel }, extra), agent });

// 10) .md 全文读 → 标题大纲；围栏里的伪标题不算；正文不外泄
{
    const h = mount({});
    const mdLines = ['# Doc title', ''];
    for (let i = 0; i < 80; i += 1) {
        mdLines.push(`## Section ${i}`, '', `BODYMARKER line ${i}`, '');
        if (i === 10) mdLines.push('```md', '# fenced pseudo heading', '```', '');
    }
    writeDoc('docs/big.md', mdLines);
    const original = fakeRead(mdLines);
    const shaped = await h.post(execRead('docs/big.md'), original);
    const text = shaped.content[0].text;
    assert.match(text, /NOT file text/, 'says it is not file text');
    assert.match(text, /## Section 0/, 'heading lines verbatim');
    assert.match(text, /sha256:[0-9a-f]{12}/, 'carries a fingerprint');
    assert.match(text, /^ {3}1- {3}2: # Doc title$/m, 'first heading carries its range');
    assert.match(text, /Read one section by its line range/, 'states the selective-read intent');
    assert.ok(!text.includes('BODYMARKER'), 'no body text leaks');
    assert.ok(!text.includes('fenced pseudo heading'), 'fenced block is not a heading');
    assert.ok(text.length < original.content[0].text.length * 0.6, 'strictly cheaper');
}

// 11) .gd 全文读 → 成员表；缩进在函数体内的局部变量不算
{
    const h = mount({});
    const gdLines = ['class_name Big', 'extends Node', '', 'signal died', '', 'var hp: int = 10', ''];
    for (let i = 0; i < 30; i += 1) gdLines.push(`func f${i}() -> void:`, '\tvar local := 1', '\tprint(local)', '');
    writeDoc('scripts/big.gd', gdLines);
    const shaped = await h.post(execRead('scripts/big.gd'), fakeRead(gdLines));
    const text = shaped.content[0].text;
    assert.match(text, /GDScript/, 'names the language');
    assert.match(text, /func f0\(\) -> void:/, 'member line verbatim');
    assert.match(text, /var hp: int = 10/);
    assert.ok(!text.includes('var local'), 'indented locals are not members');
    assert.ok(!text.includes('print(local)'));
}

// 12) 小文件、显式窗口读、错误结果、非文本结果、读不到的文件——全部原样放行
{
    const h = mount({});
    const small = ['# a', '', '## b', '', '## c', '', 'body', '', 'body', '', 'body'];
    writeDoc('docs/small.md', small);
    const original = fakeRead(small);
    assert.equal(await h.post(execRead('docs/small.md'), original), original, 'below line floor');

    const big = fs.readFileSync(path.join(WS, 'docs/big.md'), 'utf8').split('\n');
    const bigRead = fakeRead(big);
    assert.equal(await h.post(execRead('docs/big.md', SA, { offset: 5 }), bigRead), bigRead, 'offset read untouched');
    assert.equal(await h.post(execRead('docs/big.md', SA, { limit: 50 }), bigRead), bigRead, 'limit read untouched');
    assert.equal(await h.post(execRead('docs/big.md'), bigRead, { isError: true }), bigRead, 'error result untouched');

    const imageOnly = { kind: 'accept', content: [{ type: 'image', data: 'x' }] };
    assert.equal(await h.post(execRead('docs/big.md'), imageOnly), imageOnly, 'non-text result untouched');
    assert.equal(await h.post(execRead('docs/missing.md'), bigRead), bigRead, 'unreadable path untouched');
    assert.equal(await h.post(execRead('docs/big.md', NO_CWD), bigRead), bigRead, 'no session cwd → no guessing');
}

// 13) 编辑后重读 → 只回编辑窗口 + 总行数 + 指纹，且锚点逐字可见
{
    const h = mount({});
    const lines = [];
    for (let i = 0; i < 200; i += 1) lines.push(`line ${i} MARKER${i}`);
    const edited = lines.map((line) => (line.startsWith('line 120 ') ? 'line 120 EDITED anchor text' : line));
    writeDoc('docs/edited.md', lines);
    await h.post({ name: 'edit', arguments: { file_path: 'docs/edited.md', old_string: 'line 120 MARKER120', new_string: 'line 120 EDITED anchor text' }, agent: SA },
        { kind: 'accept', content: [{ type: 'text', text: 'updated' }] });
    writeDoc('docs/edited.md', edited);

    const shaped = await h.post(execRead('docs/edited.md'), fakeRead(edited));
    const text = shaped.content[0].text;
    assert.match(text, /verifyRead/, 'names the verification read');
    assert.match(text, /200 lines/, 'states the real total');
    assert.match(text, /EDITED anchor text/, 'anchor line is shown verbatim');
    assert.ok(!text.includes('MARKER190'), 'far region is not shipped');
    assert.match(text, /sha256:[0-9a-f]{12}/);
    assert.ok(!text.includes('offset=1 limit='), 'does not teach a whole-file re-read');
    // verifyRegionLines 是窗口总行数（默认 24），不是单侧行数。
    const numbered = text.split('\n').filter((line) => /^\s*\d+: /.test(line)).length;
    assert.equal(numbered, 24, 'window is exactly verifyRegionLines');

    // 锚点只用一次：紧接着的全文读回到大纲/原文口径（此处是 .md → 下一条分支不适用，故原样）
    const again = await h.post(execRead('docs/edited.md'), fakeRead(edited));
    assert.ok(!again.content[0].text.includes('verifyRead'), 'anchor is consumed once');
}

// 14) 三个开关各自可关；配置 API 往返这几个键
{
    const off = mount({ outlineMd: false, outlineGd: false, verifyRegion: false });
    const big = fs.readFileSync(path.join(WS, 'docs/big.md'), 'utf8').split('\n');
    const original = fakeRead(big);
    assert.equal(await off.post(execRead('docs/big.md'), original), original, 'switches off → untouched');

    const gdOnly = mount({ outlineMd: false });
    const gd = fs.readFileSync(path.join(WS, 'scripts/big.gd'), 'utf8').split('\n');
    assert.match((await gdOnly.post(execRead('scripts/big.gd'), fakeRead(gd))).content[0].text, /GDScript/);
    assert.equal(await gdOnly.post(execRead('docs/big.md'), original), original, 'md switch works independently');

    // verifyRegion 单独关：有未消费锚点也不出窗口（H 终审指出此前只在全关 mount 里验过）
    const noVerify = mount({ verifyRegion: false });
    await noVerify.post({ name: 'edit', arguments: { file_path: 'docs/edited2.md', old_string: 'a', new_string: 'line 40 EDITED two' }, agent: SA },
        { kind: 'accept', content: [{ type: 'text', text: 'updated' }] });
    const lines2 = [];
    for (let i = 0; i < 120; i += 1) lines2.push(i === 40 ? 'line 40 EDITED two' : `line ${i} filler text here`);
    writeDoc('docs/edited2.md', lines2);
    const untouchedRead = fakeRead(lines2);
    // .md 无标题 → 大纲也不适用，因此这条读必须原样
    assert.equal(await noVerify.post(execRead('docs/edited2.md'), untouchedRead), untouchedRead, 'verifyRegion off → no window');

    const routes = [];
    const ctx = {
        tools: { guard: () => {} },
        on: () => {},
        effect: (fn) => fn(),
        webServer: { register: (route) => { routes.push(route); return () => {}; } },
    };
    apply(ctx, {});
    const settingsRoute = routes.find((r) => r.path === '/exploration-guard');
    const mkRes = () => ({ status: 0, body: '', writeHead(s) { this.status = s; }, end(t) { this.body = t; } });
    const mkReq = (method, url, payload) => ({
        method,
        url,
        async *[Symbol.asyncIterator]() { if (payload !== undefined) yield Buffer.from(JSON.stringify(payload), 'utf8'); },
    });
    const res1 = mkRes();
    await settingsRoute.handler(mkReq('GET', '/exploration-guard/api/config'), res1);
    const got = JSON.parse(res1.body).config;
    assert.equal(got.outlineMd, true);
    assert.equal(got.outlineMinLines, 80);
    assert.equal(got.verifyRegionLines, 24);

    const res2 = mkRes();
    await settingsRoute.handler(mkReq('POST', '/exploration-guard/api/config', { outlineMd: false, outlineMinLines: 120, verifyRegionLines: 40 }), res2);
    const applied = JSON.parse(res2.body).config;
    assert.equal(applied.outlineMd, false);
    assert.equal(applied.outlineMinLines, 120);
    assert.equal(applied.verifyRegionLines, 40);
}

// 15) BOM 文件的第一行标题不能丢（实测事故：PowerShell 5.1 写出的 .md 带 BOM）
{
    // 上一组夹具把 outlineMd=false 写进了共享的持久化文件；本组要的是出厂默认，
    // 先清掉持久化（等价于新装一次）。
    fs.rmSync(path.join(TEST_HOME, 'exploration-guard', 'config.json'), { force: true });
    const h = mount({});
    const lines = ['# BOM title', ''];
    for (let i = 0; i < 40; i += 1) {
        lines.push(`## B${i}`, '');
        for (let k = 0; k < 6; k += 1) lines.push(`body ${k} of section ${i} with some words to make the outline cheaper`);
        lines.push('');
    }
    const abs = path.join(WS, 'docs/bom.md');
    fs.writeFileSync(abs, '\uFEFF' + lines.join('\n') + '\n', 'utf8');
    const shaped = await h.post(execRead('docs/bom.md'), fakeRead(lines));
    const text = shaped.content[0].text;
    assert.match(text, /^\[exploration-guard outline\]/, 'outline header first');
    assert.match(text, /1-\s*2: # BOM title/, 'BOM does not hide the first heading');
    assert.match(text, /3-\s*11: ## B0/, 'heading carries its section range');
    assert.match(text, /354-\s*362: ## B39/, 'last range ends at the file tail');
}

// 16) write（整文件）后的验证读：走头部窗口，文案不能说成 "edited region"
{
    const h = mount({});
    const lines = [];
    for (let i = 0; i < 200; i += 1) lines.push(`written line ${i} with a little padding text`);
    writeDoc('docs/written.txt', lines);
    await h.post({ name: 'write', arguments: { file_path: 'docs/written.txt', content: lines.join('\n') }, agent: SA },
        { kind: 'accept', content: [{ type: 'text', text: 'created' }] });
    const shaped = await h.post(execRead('docs/written.txt'), fakeRead(lines));
    const text = shaped.content[0].text;
    assert.match(text, /verifyRead/, 'write also gets a verification read');
    assert.match(text, /after your write returned ONLY the file head/, 'head window is described honestly');
    assert.ok(!text.includes('edited region'), 'does not claim an edited region for a whole-file write');
    const numbered = text.split('\n').filter((line) => /^\s*\d+: /.test(line)).length;
    assert.equal(numbered, 24, 'head window honours verifyRegionLines');
    assert.match(text, /^\[exploration-guard verifyRead\][\s\S]*showing lines 1-24:/);
}

// ---------- v0.4.1：grep 摘要 ----------
function grepText(fileCount, perFile) {
    const files = [];
    let total = 0;
    for (let f = 0; f < fileCount; f += 1) {
        const lines = [`src/file${f}.gd`];
        for (let i = 0; i < perFile; i += 1) {
            lines.push(`Line ${i * 7 + 1}: var field_${f}_${i}: int = ${i}  # padding to look real`);
            total += 1;
        }
        files.push(lines.join('\n'));
    }
    return `Found ${total} match${total === 1 ? '' : 'es'}\n\n${files.join('\n\n')}\n`;
}
function fakeStore() {
    const saved = [];
    return {
        saved,
        async saveText(request) {
            saved.push(request);
            return { locator: 'C:/tmp/spill/grep-1.txt', retrievalHint: 'stored by test store' };
        },
    };
}
const execGrep = (agent = SA) => ({ name: 'grep', arguments: { pattern: 'var ' }, agent, callId: 'c1' });

// 17) 超过阈值 → 摘要索引；全量进 spill；行号全保留
{
    const store = fakeStore();
    const h = mount({}, { spillStore: store });
    const full = grepText(20, 6); // 120 matches
    const shaped = await h.post(execGrep(), { kind: 'accept', content: [{ type: 'text', text: full }] });
    const text = shaped.content[0].text;
    assert.match(text, /^\[exploration-guard grepSummary\] Index, NOT all matches: 120 matches in 20 files/);
    assert.match(text, /This listing saved to: C:\/tmp\/spill\/grep-1\.txt/);
    assert.match(text, /src\/file0\.gd \(6 matches\)/);
    assert.match(text, /Line 1: var field_0_0: int = 0/, 'first matches verbatim');
    assert.match(text, /\+3 more at lines 22, 29, 36/, 'remaining line numbers kept');
    assert.match(text, /offset=1 limit=\d+/, 'copy-pasteable escape hatch with the real line count');
    assert.equal(store.saved.length, 1, 'full output spilled once');
    assert.equal(store.saved[0].content, full, 'spill gets the byte-identical full text');
    assert.equal(store.saved[0].source.toolName, 'grep');
    assert.equal(store.saved[0].owner.sessionId, 's-shape');
    assert.ok(text.length < full.length * 0.75, 'strictly cheaper');
}

// 18) 低于阈值 / 无 spillStore / 计数不符 / 未知形态 / 开关关 → 原样
{
    const store = fakeStore();
    const h = mount({}, { spillStore: store });
    const small = grepText(5, 4); // 20 matches < 80
    const smallDecision = { kind: 'accept', content: [{ type: 'text', text: small }] };
    assert.equal(await h.post(execGrep(), smallDecision), smallDecision, 'below threshold untouched');
    assert.equal(store.saved.length, 0, 'no spill when not shaping');

    const noStore = mount({});
    const big = grepText(20, 6);
    const bigDecision = { kind: 'accept', content: [{ type: 'text', text: big }] };
    assert.equal(await noStore.post(execGrep(), bigDecision), bigDecision, 'no spillStore → untouched');

    const mismatched = big.replace(/^Found \d+ matches/, 'Found 999 matches');
    const mismatchDecision = { kind: 'accept', content: [{ type: 'text', text: mismatched }] };
    assert.equal(await h.post(execGrep(), mismatchDecision), mismatchDecision, 'count mismatch → untouched');

    const alien = { kind: 'accept', content: [{ type: 'text', text: 'some other tool output\nwith lines' }] };
    assert.equal(await h.post(execGrep(), alien), alien, 'unknown shape → untouched');

    const off = mount({ grepSummary: false }, { spillStore: fakeStore() });
    assert.equal(await off.post(execGrep(), bigDecision), bigDecision, 'switch off → untouched');
}

// 19) 工具自身截断的形态（Found 250 of 769）也要能摘要，且保留工具的 spill 路径
{
    const store = fakeStore();
    const h = mount({}, { spillStore: store });
    const body = grepText(20, 12).replace(/^Found \d+ matches\n\n/, ''); // 240 行明细
    const truncated = `Found 240 of 769 matches\n\n${body}\n(Full grep result stored at: C:\\tmp\\tool-spill\\grep.txt)\n`;
    const shaped = await h.post(execGrep(), { kind: 'accept', content: [{ type: 'text', text: truncated }] });
    const text = shaped.content[0].text;
    assert.match(text, /240 of 769 matches shown, 20 files in this slice/);
    assert.match(text, /Full 769-match list \(tool spill\): C:\\tmp\\tool-spill\\grep\.txt/, 'keeps the tool own spill path');
    // 工具截断时明细条数必须与 "of" 前的数字一致，否则不Shape
    const broken = truncated.replace('Found 240 of 769', 'Found 250 of 769');
    const brokenDecision = { kind: 'accept', content: [{ type: 'text', text: broken }] };
    assert.equal(await h.post(execGrep(), brokenDecision), brokenDecision, 'shown-count mismatch → untouched');

    // 工具括注（完整结果未能保存）不能被当成"文件"
    const withNote = `Found 240 of 769 matches\n\n${body}(The complete result could not be saved; narrow the search.)\n`;
    const noted = await h.post(execGrep(), { kind: 'accept', content: [{ type: 'text', text: withNote }] });
    const noteText = noted.content[0].text;
    assert.match(noteText, /^\(The complete result could not be saved/m, 'tool note carried verbatim');
    assert.ok(!/could not be saved[^\n]*\(0 matches\)/.test(noteText), 'note is not mistaken for a file');
}

// 20) 稠密文件与文件数上限：索引自身必须小（否则会被 save-token 的 240 行窗口二次裁掉）
{
    const store = fakeStore();
    const h = mount({}, { spillStore: store });
    const parts = ['Found 160 matches', ''];
    // 一个 120 命中的稠密文件：只给行号，不给样例
    parts.push('src/dense.gd');
    for (let i = 0; i < 120; i += 1) parts.push(`Line ${i + 1}: var dense_${i}: int`);
    // 一个 30 命中的中稠密文件：只留 1 条样例
    parts.push('', 'src/mid.gd');
    for (let i = 0; i < 30; i += 1) parts.push(`Line ${i + 1}: var mid_${i}: int`);
    // 一个 10 命中的普通文件：perFile=3
    parts.push('', 'src/normal.gd');
    for (let i = 0; i < 10; i += 1) parts.push(`Line ${i + 1}: var normal_${i}: int`);
    const full = `${parts.join('\n')}\n`;
    const shaped = await h.post(execGrep(), { kind: 'accept', content: [{ type: 'text', text: full }] });
    const text = shaped.content[0].text;
    assert.ok(!/src\/dense\.gd[\s\S]{0,80}Line \d+: var dense_/.test(text), 'dense file ships no samples');
    assert.match(text, /src\/dense\.gd \(120 matches\)\n\+120 more at lines /, 'dense file is line numbers only');
    const midSamples = text.split('\n').filter((line) => /^Line \d+: var mid_/.test(line)).length;
    assert.equal(midSamples, 1, 'mid-dense file keeps exactly one sample');
    const normalSamples = text.split('\n').filter((line) => /^Line \d+: var normal_/.test(line)).length;
    assert.equal(normalSamples, 3, 'normal file keeps perFile samples');
    assert.ok(text.split('\n').length <= 210, `index stays small (${text.split('\n').length} lines)`);
}

// 21) 文件数超过上限：只列前 40 个文件，其余一句带过并指向 locator
{
    const store = fakeStore();
    const h = mount({}, { spillStore: store });
    const full = grepText(60, 6); // 360 matches over 60 files
    const shaped = await h.post(execGrep(), { kind: 'accept', content: [{ type: 'text', text: full }] });
    const text = shaped.content[0].text;
    const listed = text.split('\n').filter((line) => /^src\/file\d+\.gd \(\d+ matches\)$/.test(line)).length;
    assert.ok(listed <= 40, `lists at most 40 files (${listed})`);
    assert.match(text, /^\+\d+ more files \(not listed here\)/m, 'says the rest are not listed');
    assert.match(text, /offset=1 limit=\d+/, 'still gives the concrete way to the full listing');
}

// 收尾链（check/_tool_plugins.py）读末行 RESULT 判绿，缺行即判红——本文件必须自报计数。
console.log('PASS dsh-exploration-guard: 14 guard fixtures + 12 read/grep shaping fixtures');
console.log('RESULT run.mjs: pass=26 fail=0');