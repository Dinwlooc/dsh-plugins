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

function makeEnv(home) {
    const handlers = {};
    const tools = [];
    const ctx = {
        tools: { register(tool) { tools.push(tool); return () => {}; } },
        on(event, handler) { handlers[event] = handler; return () => {}; },
        get() { return undefined; },
    };
    apply(ctx, { thresholds: [0.8], homeDir: home, remindUnregistered: false });
    return {
        preStep: handlers['agent/pre-step'],
        stream: handlers['llm/stream'],
        register: tools.find((t) => t.name === 'budget_register'),
        status: tools.find((t) => t.name === 'budget_status'),
    };
}

function agentWith(id) {
    return { id, session: { id } };
}

async function meter(stream, sessionId, u) {
    const upstream = async function* () { yield { type: 'usage', usage: u }; };
    for await (const _chunk of stream({ sessionId }, upstream)) { /* drain */ }
}

async function runStep(preStep, agent, nextImpl) {
    const next = nextImpl || (async () => ({
        kind: 'enter',
        messages: [{ role: 'user', id: 'old', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
        startsRequestSeries: true,
    }));
    return preStep({ agent, turn: 1, step: 1, messages: [], signal: undefined }, next);
}
const lastText = (res) => res.messages[res.messages.length - 1]?.content?.[0]?.text || '';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-test-'));

// 1) 无 grant 且零用量：不插话
{
    const { preStep } = makeEnv(home);
    const res = await runStep(preStep, agentWith('s1'));
    check('no-grant zero-usage passes through', res.messages.length === 1);
}

// 2) 只在 80% 插一次；文案为英文，仅 [budget-watch] + Used + prepare to wrap up
{
    const { preStep, register, stream } = makeEnv(home);
    const agent = agentWith('s80');
    await register.execute({ tokens: 1000, newTask: true }, { agent });
    await meter(stream, 's80', usage(500));
    const at50 = await runStep(preStep, agent);
    check('50% no message', at50.messages.length === 1);
    await meter(stream, 's80', usage(400));
    const at90 = await runStep(preStep, agent);
    const expected = '[budget-watch] Used: 900 tokens. Prepare to wrap up.';
    check('80% exact english warning', at90.messages.length === 2 && lastText(at90) === expected, lastText(at90));
    const again = await runStep(preStep, agent);
    check('warning only once', again.messages.length === 1);
}

// 3) 双口径：直计费模型按「未命中缓存输入+输出」；套餐模型（glm*）按全量
{
    const { status, register, stream } = makeEnv(home);
    const agent = agentWith('sbuckets');
    await register.execute({ tokens: 1000 }, { agent });
    await meter(stream, 'sbuckets', usage(100, 200, 300, 400)); // billed: uncached(0)+200
    let out = await status.execute({}, { agent });
    check('direct-billing cost (uncached input+output = 200)', /used=200\b/.test(out), out.split('\n')[0]);
    await register.execute({ tokens: 1000 }, { agent }); // 重计：used 归零
    await meter(stream, 'sbuckets', usage(100, 200, 300, 400, 'glm-5.3-flash')); // quota: 全量 1000
    out = await status.execute({}, { agent });
    check('plan-quota model counts full total (1000)', /used=1.0k\b/.test(out), out.split('\n')[0]);
}

// 4) reject 原样透传，不插话、不写 task
{
    const { preStep, stream } = makeEnv(home);
    const agent = agentWith('sreject');
    await meter(stream, 'sreject', usage(999));
    const res = await runStep(preStep, agent, async () => ({ kind: 'reject' }));
    const ledger = JSON.parse(fs.readFileSync(path.join(home, 'budget-watch', 'sreject.json'), 'utf8'));
    check('reject passthrough', res.kind === 'reject');
    check('reject adds no warning/task', res.messages === undefined && ledger.task === null);
}

// 5) 每一笔发放都重计基线（Owner 2026-10-25：无追加语义，忽略超额与余额）
{
    const { preStep, register, stream } = makeEnv(home);
    const agent = agentWith('sregrant');
    await register.execute({ tokens: 1000 }, { agent });
    await meter(stream, 'sregrant', usage(900));
    const r1 = await runStep(preStep, agent);
    check('first warning at 90%', r1.messages.length === 2);
    await register.execute({ tokens: 1000 }, { agent }); // 重计：granted=1000，used=0
    const ledger = JSON.parse(fs.readFileSync(path.join(home, 'budget-watch', 'sregrant.json'), 'utf8'));
    const r2 = await runStep(preStep, agent);
    check('grant re-baselines (granted stays 1.0k, used 0)', ledger.task.granted === 1000 && r2.messages.length === 1);
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
    const { preStep, stream } = makeEnv(home);
    const agent = agentWith('snogrant');
    await meter(stream, 'snogrant', usage(10));
    const r1 = await runStep(preStep, agent);
    check('unregistered reminder disabled', r1.messages.length === 1);
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
    check('per-model mix shown', /deepseek-flash=3\.50M\[hit57%\/miss29%\/out14%\]/.test(out), out.split('\n')[3]);
}
// 11) 未归因桶：按 defaultRates 计价并标 *
{
    const { status, stream } = makeEnv(home);
    const agent = agentWith('sunknown');
    await meter(stream, 'sunknown', usage(1_000_000, 0, 0, 0, 'unknown-model'));
    const out = await status.execute({}, { agent });
    check('unattributed priced at default (not free)', /attr 0%/.test(out) && /unknown-model=1\.00M/.test(out) && /\*/.test(out), out.split('\n')[2]);
}
// 12) 订阅模型：不参与 ¥ 求和，单列 not convertible
{
    const { status, stream } = makeEnv(home);
    const agent = agentWith('ssub');
    await meter(stream, 'ssub', usage(1_000_000, 0, 0, 0, 'glm-5.3-flash'));
    const out = await status.execute({}, { agent });
    check('subscription excluded from ¥ sum', /money≈¥0/.test(out) && /subscription 1\.00M tok \(not convertible\)/.test(out), out.split('\n')[2]);
    check('subscription row labeled', /glm-5\.3-flash=1\.00M\[subscription/.test(out), out.split('\n')[3]);
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
    check('provider never a price key',
        /provider:zai=1\.00M/.test(out) && /money≈¥2\.13/.test(out) && /provider:zai=1\.00M\[[^\]]*\]≈¥2\.13\/M\*/.test(out),
        out.split('\n')[1] + ' | ' + out.split('\n')[3]);
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
    check('legacy ledger without models', !threw && /no per-model data/.test(out), out.split('\n')[0]);
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
    check('invalid price rows dropped with warning', /dropped 2 invalid row/.test(out) && /glm=subscription/.test(out), out.split('\n').pop());
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
    check('parallel sessions isolated (A used=200)', /session=sessA/.test(oa) && /used=200\b/.test(oa), oa.split('\n')[0]);
    check('parallel sessions isolated (B used=4.0k)', /session=sessB/.test(ob) && /used=4\.0k\b/.test(ob), ob.split('\n')[0]);
}
// 17) 显式 sessionId：父会话可查子会话账本
{
    const { status } = makeEnv(home);
    const out = await status.execute({ sessionId: 'sessB' }, { agent: agentWith('sessA') });
    check('explicit sessionId queries another ledger', /session=sessB/.test(out) && /used=4\.0k\b/.test(out), out.split('\n')[0]);
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

const failed = results.filter((r) => !r.ok);
console.log(`\nRESULT budget-watch test: pass=${results.length - failed.length} fail=${failed.length}`);
process.exit(failed.length ? 1 : 0);
