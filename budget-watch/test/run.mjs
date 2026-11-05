// nfm-budget-watch 自测：假 ctx + 假 usage chunk，不安装、不联网。
// 运行：node test/run.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`);
}

function usage(input, output = 0, cacheRead = 0, cacheWrite = 0, model = '') {
    return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, model };
}

function makeEnv(home, extra = {}) {
    const handlers = {};
    const tools = [];
    const guards = [];
    const routes = [];
    const ctx = {
        tools: {
            register(tool) { tools.push(tool); return () => {}; },
            guard(fn) { guards.push(fn); return () => {}; },
        },
        webServer: { register(route) { routes.push(route); return () => {}; } },
        effect: (fn) => fn(),
        on(event, handler) { handlers[event] = handler; return () => {}; },
        get() { return undefined; },
    };
    // 自动发放单独加夹具验证；旧夹具默认关掉，避免账本被自动登记改写。
apply(ctx, { thresholds: [0.6, 1.0], homeDir: home, remindUnregistered: false, autoRegister: false, ...extra });
    return {
        handlers,
        request: handlers['agent/request'],
        stream: handlers['llm/stream'],
        register: tools.find((t) => t.name === 'budget_register'),
        status: tools.find((t) => t.name === 'budget_status'),
        guards,
        routes,
    };
}

function agentWith(id) {
    const events = [];
    return {
        id,
        session: {
            id,
            events,
            append(type, data, opts) { events.push({ type, data, opts }); },
        },
    };
}

async function meter(stream, sessionId, u) {
    const upstream = async function* () { yield { type: 'usage', usage: u }; };
    for await (const _chunk of stream({ sessionId }, upstream)) { /* drain */ }
}

// 提醒的唯一写入点是 agent/request（step 内、step/start 已落盘之后）：
// 夹具直接调用它，坐标由调用方给出，模拟 agent loop 的真实顺序。
async function runRequest(request, agent, position = { turn: 1, step: 1 }) {
    const config = { provider: 'test-provider', model: 'test-model' };
    return request({ agent, ...position }, async () => config);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-test-'));

// 1) 无 grant 且零用量：不插话
{
    const { request } = makeEnv(home);
    const agent = agentWith('s1');
    const res = await runRequest(request, agent);
    check('no-grant zero-usage passes through', agent.session.events.length === 0 && res.provider === 'test-provider');
}

// 2) 60% 只在 developer/message 上插一次，且坐标是当前已打开的 step；不碰用户消息
{
    const { request, handlers, register, stream } = makeEnv(home);
    const agent = agentWith('s80');
    await register.execute({ tokens: 1000, newTask: true }, { agent });
    await meter(stream, 's80', usage(500));
    await runRequest(request, agent);
    check('50% no notice', agent.session.events.length === 0);
    await meter(stream, 's80', usage(400));
    const res = await runRequest(request, agent, { turn: 3, step: 7 });
    const events = agent.session.events;
    const expected = '[budget-watch] 已用 900 tok（≥60%）。压缩步数：合并调用、减少探索、能问 Owner 就别猜。';
    check('60% accelerate warning', events.length === 1
        && events[0].type === 'developer/message'
        && events[0].data.message.content[0].text === expected
        && events[0].data.message.role === 'developer'
        && events[0].opts.surfaceOp === 'append', JSON.stringify(events[0]?.data?.message?.role || events[0]?.type));
    check('notice carries the open step coordinates',
        events[0].data.turn === 3 && events[0].data.step === 7,
        JSON.stringify([events[0]?.data?.turn, events[0]?.data?.step]));
    check('notice does not touch the user channel',
        handlers['agent/pre-step'] === undefined && res.provider === 'test-provider');
    await runRequest(request, agent, { turn: 3, step: 8 });
    check('warning only once', agent.session.events.length === 1);
}

// 2b) 100% 档：文案改为「停止文件输出工作」
{
    const { request, register, stream } = makeEnv(home);
    const agent = agentWith('s100');
    await register.execute({ tokens: 1000, newTask: true }, { agent });
    await meter(stream, 's100', usage(1100));
    await runRequest(request, agent, { turn: 1, step: 2 });
    const events = agent.session.events;
    const expected = '[budget-watch] 预算已用尽（≥100%）。停止文件输出工作：先向 Owner 报告现状与剩余事项，等新预算。';
    check('100% stop-output warning', events.length === 1
        && events[0].data.message.content[0].text === expected, events[0]?.data?.message?.content?.[0]?.text);
}

// 3) 双口径：直计费模型按「未命中缓存输入+输出」；套餐模型（glm*）按全量
{
    const { status, register, stream } = makeEnv(home);
    const agent = agentWith('sbuckets');
    await register.execute({ tokens: 1000 }, { agent });
    await meter(stream, 'sbuckets', usage(100, 200, 300, 400)); // billed: uncached(0)+200
    let out = await status.execute({}, { agent });
    // 计权口径（2026-10-30）：W = miss + hit·(hit/miss) + out·(out/miss) + write·1
    // 100 + 300·0.0202 + 200·4.0 + 400 = 1306 → 1.2k
    check('direct-billing cost is weighted (miss-equivalent = 1.3k)', /used=1\.2k\b/.test(out), out.split('\n')[0]);
    await register.execute({ tokens: 1000 }, { agent }); // 重计：used 归零
    await meter(stream, 'sbuckets', usage(100, 200, 300, 400, 'glm-5.3-flash')); // quota: 全量 1000
    out = await status.execute({}, { agent });
    check('plan-quota model counts full total (1000)', /used=1.0k\b/.test(out), out.split('\n')[0]);
}

// 3b) provider 的分离式字段（2026-10-30 实测）：inputTokens 只算未命中，
//     totalTokens = input + cacheRead + output + write。旧实现按包含式取 max(0, input-cacheRead)，
//     会把几乎每一步都夹成 0，本会话曾因此漏记 124,515 未命中。
{
    const { status, register, stream } = makeEnv(home);
    const agent = agentWith('sdisjoint');
    await register.execute({ tokens: 1000 }, { agent });
    await meter(stream, 'sdisjoint', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 0, totalTokens: 1050 });
    const out = await status.execute({}, { agent });
    // 100 miss + 900 hit·0.0202 + 50 out·4.0 = 318
    check('disjoint usage: weighted (100 + 900·0.02 + 50·4 = 318)', /used=318\b/.test(out), out.split('\n')[0]);
    const ledger = JSON.parse(fs.readFileSync(path.join(home, 'budget-watch', 'sdisjoint.json'), 'utf8'));
    check('disjoint usage: hit stays 900, miss 100', ledger.models['?'].hit === 900 && ledger.models['?'].miss === 100, JSON.stringify(ledger.models));
    check('disjoint usage: total is the reported 1050', ledger.sessionTotal === 1050, String(ledger.sessionTotal));
}

// 3c) 峰值感知：burn 记录每次 provider 调用的预算单位增量，status 给出 peak/burst
{
    const { status, register, stream } = makeEnv(home);
    const agent = agentWith('sburn');
    await register.execute({ tokens: 1000 }, { agent });
    await meter(stream, 'sburn', usage(100));
    await meter(stream, 'sburn', usage(100));
    await meter(stream, 'sburn', usage(700));
    const out = await status.execute({}, { agent });
    const line = out.split('\n')[1];
    check('no burn line (trimmed)', !/peak=|burst=|last=\+/.test(out) && out.split('\n').length === 2, out.split('\n')[1]);
}

// 3d) 计权口径（2026-10-30）：输出按 out/miss 折算，时段因子按档位乘在价格上
{
    const { status, register, stream } = makeEnv(home);
    const agent = agentWith('sweight');
    await register.execute({ tokens: 1_000_000 }, { agent });
    await meter(stream, 'sweight', usage(0, 250_000, 0, 0, 'deepseek-flash')); // 0 miss + 250k out·4.0
    let out = await status.execute({}, { agent });
    check('weighted: output folds to miss-equivalent (250k·4 = 1.00M)', /used=1\.00M/.test(out), out.split('\n')[0]);

    const half = makeEnv(home, { timeFactors: { out: 0.5 } });
    const agent2 = agentWith('sweight2');
    await half.register.execute({ tokens: 1_000_000 }, { agent: agent2 });
    await meter(half.stream, 'sweight2', usage(0, 250_000, 0, 0, 'deepseek-flash'));
    out = await half.status.execute({}, { agent: agent2 });
    check('weighted: time factor scales the fold (0.5 → 500k)', /used=500\.0k|used=500k/.test(out), out.split('\n')[0]);
}

// 4) 顺序契约（回归夹具）：提醒器不得注册 agent/pre-step——在那里写 developer/message
//    会排在 step/start 之前，V4 校验器判 does not match an open turn and step，重启后整段历史读不出。
{
    const handlers = {};
    const tools = [];
    const ctx = {
        tools: { register(t) { tools.push(t); return () => {}; } },
        on(e, h) { handlers[e] = h; return () => {}; },
        get() { return undefined; },
    };
    apply(ctx, { homeDir: home });
    check('no agent/pre-step writer', handlers['agent/pre-step'] === undefined);
    check('writer is agent/request', typeof handlers['agent/request'] === 'function');
}

// 5) 每一笔发放都重计基线（Owner 2026-10-25：无追加语义，忽略超额与余额）
{
    const { request, register, stream } = makeEnv(home);
    const agent = agentWith('sregrant');
    await register.execute({ tokens: 1000 }, { agent });
    await meter(stream, 'sregrant', usage(900));
    await runRequest(request, agent);
    check('first warning at 90%', agent.session.events.length === 1);
    await register.execute({ tokens: 1000 }, { agent }); // 重计：granted=1000，used=0
    const ledger = JSON.parse(fs.readFileSync(path.join(home, 'budget-watch', 'sregrant.json'), 'utf8'));
    await runRequest(request, agent, { turn: 2, step: 1 });
    check('grant re-baselines (granted stays 1.0k, used 0)', ledger.task.granted === 1000 && agent.session.events.length === 1);
}

// 6) newTask 重置基线
{
    const { status, register, stream } = makeEnv(home);
    const agent = agentWith('snewtask');
    await meter(stream, 'snewtask', usage(900));
    await register.execute({ tokens: 1000, newTask: true }, { agent });
    const out = await status.execute({}, { agent });
    check('newTask resets baseline', /used=0\b/.test(out), out.split('\n')[0]);
}

// 7) 未登记预算不再提醒（remindUnregistered=false）
{
    const { request, stream } = makeEnv(home);
    const agent = agentWith('snogrant');
    await meter(stream, 'snogrant', usage(10));
    await runRequest(request, agent);
    check('unregistered reminder disabled', agent.session.events.length === 0);
}

// 8) 非法参数不抛异常
{
    const { register } = makeEnv(home);
    const agent = agentWith('sbad');
    let out = '';
    try { out = await register.execute({ tokens: -5 }, { agent }); } catch (e) { out = 'THREW:' + e.message; }
    check('invalid tokens handled', /必须是正/.test(out), out.slice(0, 40));
}

// 9) 落盘存在
{
    const files = fs.readdirSync(path.join(home, 'budget-watch'));
    check('ledger files persisted', files.length > 0, files.slice(0, 3).join(','));
}

// 10) 三档计价：缓存命中/未命中/输出各自单价（官方分档，Owner 2026-10-27）
{
    const { status, stream } = makeEnv(home);
    const agent = agentWith('s3tier');
    // usage(input, output, cacheRead, cacheWrite, model)：input=3M 其中 cacheRead=2M → miss=1M
    // flash: hit 2M*0.043=0.086 + miss 1M*2.13=2.13 + out 0.5M*8.52=4.26 → ¥6.476
    await meter(stream, 's3tier', usage(3_000_000, 500_000, 2_000_000, 0, 'deepseek-flash'));
    const out = await status.execute({}, { agent });
    check('three-tier money (hit/miss/out)', /¥6\.4[0-9]?/.test(out), out.split('\n')[2]);
    check('no per-model mix (trimmed)', !/deepseek-flash=/.test(out), out);
}
// 11) 未归因桶：按 defaultRates 计价并标 *
{
    const { status, stream } = makeEnv(home);
    const agent = agentWith('sunknown');
    await meter(stream, 'sunknown', usage(1_000_000, 0, 0, 0, 'unknown-model'));
    const out = await status.execute({}, { agent });
    check('unattributed priced at default (not free)', /attr 0%/.test(out) && /money≈¥2\.13/.test(out) && !/unknown-model=/.test(out), out.split('\n')[2]);
}
// 12) 订阅模型：不参与 ¥ 求和，单列 not convertible
{
    const { status, stream } = makeEnv(home);
    const agent = agentWith('ssub');
    await meter(stream, 'ssub', usage(1_000_000, 0, 0, 0, 'glm-5.3-flash'));
    const out = await status.execute({}, { agent });
    check('subscription excluded from ¥ sum', /money≈¥0/.test(out) && /subscription 1\.00M\b/.test(out), out.split('\n')[1]);
    check('no subscription row (only the total bucket)', !/glm-5\.3-flash=/.test(out), out.split('\n')[1]);
}
// 13) provider 只作标签桶，不作价格键
{
    const handlers = {};
    const tools = [];
    const ctx = {
        tools: { register(t) { tools.push(t); return () => {}; } },
        on(e, h) { handlers[e] = h; return () => {}; },
        get() { return undefined; },
    };
    apply(ctx, { homeDir: home, prices: [['zai', { hit: 99, miss: 99, out: 99 }]] });
    const status = tools.find((t) => t.name === 'budget_status');
    const stream = handlers['llm/stream'];
    const agent = agentWith('sprovider');
    const upstream = async function* () { yield { type: 'usage', usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }; };
    for await (const _c of stream({ sessionId: 'sprovider', provider: 'zai' }, upstream)) { /* drain */ }
    const out = await status.execute({}, { agent });
    // provider 桶走 defaultRates（miss ¥2.13/M），未被 zai=¥99 计价；且标 *
    check('provider never a price key', /money≈¥2\.13/.test(out) && !/zai=/.test(out), out.split('\n')[1]);
}
// 14) 旧账本（无 models 字段 / 数字形）不抛错，渲染 (no per-model data)
{
    const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-legacy-'));
    fs.mkdirSync(path.join(home2, 'budget-watch'), { recursive: true });
    fs.writeFileSync(path.join(home2, 'budget-watch', 'slegacy.json'), JSON.stringify({
        sessionId: 'slegacy', sessionTotal: 12345, cost: { billed: 1, quota: 0 },
        task: null, unregisteredNotified: false, updatedAt: null,
    }), 'utf8');
    let out = '';
    let threw = false;
    try {
        const handlers = {};
        const tools = [];
        apply({ tools: { register(t) { tools.push(t); return () => {}; } }, on(e, h) { handlers[e] = h; return () => {}; }, get() { return undefined; } }, { homeDir: home2 });
        out = await tools.find((t) => t.name === 'budget_status').execute({}, { agent: agentWith('slegacy') });
    } catch (e) { threw = true; out = 'THREW:' + e.message; }
    check('legacy ledger without models', !threw && /未登记预算/.test(out) && !/session=/.test(out), out.split('\n')[0]);
}
// 15) prices 脏行被丢弃并给出警告（NaN 不得毒化求和）
{
    const handlers = {};
    const tools = [];
    apply({ tools: { register(t) { tools.push(t); return () => {}; } }, on(e, h) { handlers[e] = h; return () => {}; }, get() { return undefined; } }, {
        homeDir: home,
        prices: [['deepseek-flash', NaN], ['bad', -1], ['glm', { subscription: true }]],
    });
    const status = tools.find((t) => t.name === 'budget_status');
    const out = await status.execute({}, { agent: agentWith('sbadprices') });
    check('invalid price rows dropped with warning', /dropped 2 invalid row/.test(out) && out.split('\n').pop().startsWith('warn:'), out.split('\n').pop());
}

// 16) 并行会话：账本与查询互不串
{
    const { status, register, stream } = makeEnv(home);
    const a = agentWith('sessA');
    const b = agentWith('sessB');
    await register.execute({ tokens: 1000 }, { agent: a });
    await register.execute({ tokens: 5000 }, { agent: b });
    await meter(stream, 'sessA', usage(200));
    await meter(stream, 'sessB', usage(4000));
    const oa = await status.execute({}, { agent: a });
    const ob = await status.execute({}, { agent: b });
    check('parallel sessions isolated (A used=200)', /used=200\b/.test(oa) && !/session=/.test(oa), oa.split('\n')[0]);
    check('parallel sessions isolated (B used=4.0k)', /used=4\.0k\b/.test(ob) && !/session=/.test(ob), ob.split('\n')[0]);
}
// 17) 显式 sessionId：父会话可查子会话账本
{
    const { status } = makeEnv(home);
    const out = await status.execute({ sessionId: 'sessB' }, { agent: agentWith('sessA') });
    check('explicit sessionId queries another ledger', /used=4\.0k\b/.test(out) && !/session=/.test(out), out.split('\n')[0]);
}
// 18) 旧命名 session-<id>.json 可被裸 id 读到，且写回同一文件（不分裂）
{
    const dir = path.join(home, 'budget-watch');
    fs.mkdirSync(dir, { recursive: true });
    const legacyFile = path.join(dir, 'session-legacyx.json');
    fs.writeFileSync(legacyFile, JSON.stringify({
        sessionId: 'session-legacyx', sessionTotal: 777, cost: { billed: 7, quota: 0 },
        models: {}, task: null, unregisteredNotified: false, updatedAt: null,
    }), 'utf8');
    const { status, register } = makeEnv(home);
    const out = await status.execute({}, { agent: agentWith('legacyx') });
    await register.execute({ tokens: 1000 }, { agent: agentWith('legacyx') });
    const after = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
    check('legacy session- file readable by bare id', /本会话累计 777 tok/.test(out), out.split('\n')[0]);
    check('write stays in same legacy file (no split)', after.task?.granted === 1000 && !fs.existsSync(path.join(dir, 'legacyx.json')), 'granted=' + after.task?.granted);
}
// 19) 非法/穿越 sessionId 被拒（不回退当前会话）
{
    const { status } = makeEnv(home);
    const out = await status.execute({ sessionId: '../evil' }, { agent: agentWith('sessA') });
    check('path traversal sessionId rejected', /sessionId 非法/.test(out), out.slice(0, 60));
}
// 20) 无归属会话时失败关闭（不写 unknown 账）
{
    const { status } = makeEnv(home);
    const out = await status.execute({}, { agent: {} });
    check('missing session fails closed', /没有归属会话/.test(out), out.slice(0, 60));
}

// 21) 输出是 token 钟：登记后 ≤3 行、无单价表/账本明细（Owner 2026-10-29）
{
    const { status, register, stream } = makeEnv(home);
    const agent = agentWith('scompact');
    await register.execute({ tokens: 1_000_000 }, { agent });
    await meter(stream, 'scompact', usage(3_000_000, 500_000, 2_000_000, 0, 'deepseek-flash'));
    const out = await status.execute({}, { agent });
    const lines = out.split('\n');
    check('status is compact (<=3 lines)', lines.length <= 3, `lines=${lines.length}`);
    check('status has no price table / ledger dump', !/prices\(/.test(out) && !/baseline=/.test(out) && !/grants=/.test(out));
    // 计权：1M miss + 2M hit·0.0202 + 0.5M out·4.0 = 3.04M
    check('status keeps the token clock', /granted=1\.00M/.test(out) && /used=3\.04M/.test(out) && /pct=304\.0%/.test(out), lines[0]);
}

// 22) 提醒送不出去时不标灰：下一次请求重试（append 抛错 / 不可用）
{
    const { request, register, stream } = makeEnv(home);
    const agent = agentWith('sretry');
    await register.execute({ tokens: 1000 }, { agent });
    await meter(stream, 'sretry', usage(900));
    const realAppend = agent.session.append;
    agent.session.append = () => { throw new Error('boom'); };
    await runRequest(request, agent);
    check('failed delivery stays silent and unmarked', agent.session.events.length === 0);
    agent.session.append = realAppend;
    await runRequest(request, agent, { turn: 1, step: 2 });
    check('retry delivers after append recovers', agent.session.events.length === 1);
}

// 23) 自动发放：新会话按默认额度静默登记一次
{
    const { request, status } = makeEnv(home, { autoRegister: true });
    const agent = agentWith('sauto-new');
    await runRequest(request, agent, { turn: 1, step: 1 });
    const out = await status.execute({}, { agent });
    check('auto: new session registers the default grant silently',
        /granted=100\.0k/.test(out) && agent.session.events.length === 0, out.split('\n')[0]);
}

// 24) 自动发放：超量后连续两轮没有新登记 → 下一轮开头补发；同一轮内多个 step 不推进轮数
{
    const { request, register, stream, status } = makeEnv(home, { autoRegister: true, autoRegisterTokens: 1000 });
    const agent = agentWith('sauto-dry');
    await register.execute({ tokens: 100 }, { agent });
    await runRequest(request, agent, { turn: 1, step: 1 });
    await meter(stream, 'sauto-dry', usage(500));            // 超量
    await runRequest(request, agent, { turn: 2, step: 1 });  // 超量首次出现 → 开始计数
    for (let s = 2; s <= 4; s++) await runRequest(request, agent, { turn: 2, step: s }); // 同一轮的多个 step 不算轮
    let out = await status.execute({}, { agent });
    check('auto: steps inside the overage round do not advance rounds',
        /granted=100\b/.test(out), out.split('\n')[0]);
    await runRequest(request, agent, { turn: 3, step: 1 });  // dry=1
    out = await status.execute({}, { agent });
    check('auto: one dry round keeps the old grant', /granted=100\b/.test(out), out.split('\n')[0]);
    await runRequest(request, agent, { turn: 4, step: 1 });  // dry=2
    await runRequest(request, agent, { turn: 5, step: 1 });  // 两轮无登记 → 本轮开头补发
    out = await status.execute({}, { agent });
    check('auto: two dry rounds trigger a fresh grant',
        /granted=1\.0k/.test(out) && /used=0\b/.test(out), out.split('\n')[0]);
    // 80% 阈值提醒也会写入同一通道：这里只数「自动登记」这一类，且必须只有一条。
    const autoNotices = agent.session.events
        .filter((e) => e.type === 'developer/message')
        .filter((e) => /已自动登记/.test(e.data.message.content[0].text));
    check('auto: exactly one explanation notice', autoNotices.length === 1, String(autoNotices.length));
}

// 25) 自动发放：显式登记会清掉轮次计数，不立刻再补发
{
    const { request, register, stream, status } = makeEnv(home, { autoRegister: true, autoRegisterTokens: 1000 });
    const agent = agentWith('sauto-reset');
    await register.execute({ tokens: 100 }, { agent });
    await meter(stream, 'sauto-reset', usage(500));
    await runRequest(request, agent, { turn: 2, step: 1 });   // 超量计数开始
    await runRequest(request, agent, { turn: 3, step: 1 });   // dry=1
    await register.execute({ tokens: 50 }, { agent });        // 模型自己补登 → 计数清零
    await runRequest(request, agent, { turn: 4, step: 1 });
    const out = await status.execute({}, { agent });
    check('auto: explicit register resets the dry counter', /granted=50\b/.test(out), out.split('\n')[0]);
}

// 25) 面板：编辑类工具首次出现记冷启动基准，单步占比跨 5%/10% 各提醒一次
{
    const { guards, routes, request, register, stream } = makeEnv(home);
    check('panel: route registered', routes.some((r) => r.path === '/api/budget-watch/panel'));
    const agent = agentWith('spanel');
    await register.execute({ tokens: 100000, newTask: true }, { agent });
    await meter(stream, 'spanel', usage(1000));
    guards[0]({ name: 'read', agent });
    guards[0]({ name: 'write', agent });
    await meter(stream, 'spanel', usage(0, 0, 2970));
    await runRequest(request, agent, { turn: 1, step: 2 });
    const events = agent.session.events;
    check('panel: 5% notice on first edit step',
        events.length === 1 && /已达冷启动的 6\.0%/.test(events[0].data.message.content[0].text),
        events[0]?.data?.message?.content?.[0]?.text);

    const readState = async () => {
        let body = '';
        const res = { status: 0, writeHead(code) { this.status = code; }, end(text) { body = text; } };
        routes[0].handler({ url: '/api/budget-watch/panel?session=spanel' }, res);
        return JSON.parse(body);
    };
    const st = await readState();
    check('panel: state carries cold start and step pct',
        st.coldStart === 1000 && Math.abs(st.stepPct - 0.06) < 1e-6 && st.level === 'warn',
        JSON.stringify(st));
    await meter(stream, 'spanel', usage(0, 0, 2970));
    await runRequest(request, agent, { turn: 1, step: 3 });
    check('panel: 5% band announces once', agent.session.events.length === 1);
    await meter(stream, 'spanel', usage(0, 0, 5945));
    await runRequest(request, agent, { turn: 1, step: 4 });
    check('panel: 12% stop notice',
        agent.session.events.length === 2 && /停止文件输出工作/.test(agent.session.events[1].data.message.content[0].text),
        agent.session.events[1]?.data?.message?.content?.[0]?.text);
    const st2 = await readState();
    check('panel: level becomes stop', st2.level === 'stop', st2.level);
}

const failed = results.filter((r) => !r.ok);
console.log(`\nRESULT budget-watch test: pass=${results.length - failed.length} fail=${failed.length}`);
process.exit(failed.length ? 1 : 0);
