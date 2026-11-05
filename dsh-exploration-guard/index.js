// dsh-exploration-guard — 按「任务进展」而不是「调用重复」熔断探索黑洞。
//
// 计数：agent-loop 的 step（agent/pre-step 每次 +1）。
// 进展：todo_write 的 completed 计数增加（首次建表也算）/ update_goal 终结 / create_goal。
// soft 步数起否决非进度工具；hard 步数起只放行 allowAlways（记录任务、求助）。
// 全部走 ctx.tools.guard：同步、单调、不注入消息、不占用户发言位。
//
// 设置：宿主暴露 /exploration-guard/api/config（GET/POST），值持久化在
// $DSH_HOME/exploration-guard/config.json；文件值覆盖 patch 里的初始 config，
// POST 后即时生效（守卫每次调用读同一份可变 cfg）。
//
// v0.4.0 追加子业务 read shaping（同一插件内的独立开关，不改变上面的熔断）：
// - 无 offset / limit 的全文 read，若目标文件够大：.md → 标题大纲 + 行号，
//   .gd → 成员声明 + 行号；正文一律不给，改由 offset/limit 取（那条路径不整形）。
// - 同一会话里刚 edit/write 过的文件再被全文 read：只回编辑窗口 + 总行数 + 指纹。
// 判定位置是 tools/post-execute 的 waterfall（返回改写后的 decision），
// 与 ctx.tools.guard（执行前否决）互不重叠；save-token 已按设计豁免 read，不冲突。
// 安全性：解析失败、文件读不到、结果非文本、行数不够、整形后不比原文省——一律原样放行。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fingerprint, splitLines, mdOutline, gdMembers, verifyWindow, buildOutlineStub, buildVerifyStub, parseGrepOutput, buildGrepSummaryStub } from './shape.js';
import { MESSAGES, render } from './messages.js';
import { overlayStored, handleSettings } from './settings.js';

export const name = 'exploration-guard';
export const inject = ['tools', 'webServer'];

const DEFAULTS = Object.freeze({
    enabled: true,
    softSteps: 15,
    hardSteps: 25,
    progressTools: Object.freeze(['todo_write', 'create_goal', 'update_goal']),
    allowAlways: Object.freeze(['todo_write', 'get_goal', 'create_goal', 'update_goal', 'ask_user_question', 'meta_route', 'meta_sign']),
    noTaskMode: 'count',
    resetOnIdle: true,
    // read shaping（v0.4.0）
    outlineMd: true,
    outlineGd: true,
    verifyRegion: true,
    outlineMinLines: 80,
    verifyRegionLines: 24,
    grepSummary: true,
    grepSummaryAfter: 80,
    grepPerFile: 3,
    editAnchorTtlMs: 1200000,
});

const CONFIG_LOCATION = '$DSH_HOME/exploration-guard/config.json';

// 传输工具：PTC 下 run_code 是唯一的模型直呼入口，否决它等于锁死整个会话
// （连 allowAlways 里的 todo_write 也进不去）。它照常计一次工作量，但永远放行；
// 受限只作用在程序内的嵌套调用上。
const TRANSPORT_TOOLS = Object.freeze(['run_code']);

// 文案集中在 messages.js：softBlock / hardBlock 管原生拦截，ptcSoftNotice / ptcHardBlock 管 PTC 档。

function homeDir() {
    const env = process.env.DSH_HOME;
    if (typeof env === 'string' && env.length > 0) return env;
    return path.join(os.homedir(), '.dsh');
}

function configFile() {
    return path.join(homeDir(), 'exploration-guard', 'config.json');
}

function readPersisted() {
    try {
        const parsed = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writePersisted(values) {
    const file = configFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(values, null, 2), 'utf8');
}

/** 单字段校验：不可用的值返回 undefined（保持原值）。 */
export function normalizeField(key, value) {
    switch (key) {
        case 'enabled':
        case 'resetOnIdle':
        case 'outlineMd':
        case 'outlineGd':
        case 'verifyRegion':
        case 'grepSummary':
            return typeof value === 'boolean' ? value : undefined;
        case 'softSteps':
        case 'hardSteps':
            return clampInt(value, 1, 500);
        case 'outlineMinLines':
        case 'verifyRegionLines':
            return clampInt(value, 1, 2000);
        case 'grepSummaryAfter':
            return clampInt(value, 1, 500);
        case 'grepPerFile':
            return clampInt(value, 1, 20);
        case 'noTaskMode':
            return value === 'count' || value === 'skip' ? value : undefined;
        default:
            return undefined;
    }
}

/** 取整并夹在 [min, max]；非数字返回 undefined（保持原值）。 */
function clampInt(value, min, max) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return undefined;
    const rounded = Math.round(n);
    if (rounded < min || rounded > max) return undefined;
    return rounded;
}

export const SETTINGS_FIELDS = Object.freeze([
    { key: 'enabled', type: 'boolean', label: '总开关', hint: '关掉后不再计步、不再提醒。' },
    { key: 'softSteps', type: 'number', min: 1, max: 200, label: '软阈值步数', hint: '到达即提醒合并调用。' },
    { key: 'hardSteps', type: 'number', min: 1, max: 500, label: '硬阈值步数', hint: '到达即要求换策略。' },
    { key: 'resetOnIdle', type: 'boolean', label: '空闲重置', hint: '一轮结束即清零计数。' },
    { key: 'noTaskMode', type: 'enum', options: [{ value: 'count', label: '照常计数' }, { value: 'skip', label: '无任务时跳过' }], label: '无任务模式' },
    { key: 'outlineMd', type: 'boolean', label: 'md 大纲', hint: '大文件先给标题大纲。' },
    { key: 'outlineGd', type: 'boolean', label: 'gd 大纲', hint: '脚本文件先给函数大纲。' },
    { key: 'verifyRegion', type: 'boolean', label: '窗口校验', hint: '读窗口后校验行号区间。' },
    { key: 'progressTools', type: 'stringList', label: '进度工具', hint: '命中即视为有进展的工具名。' },
    { key: 'allowAlways', type: 'stringList', label: '始终放行', hint: '永不熔断的工具名。' },
    { key: 'outlineMinLines', type: 'number', min: 0, max: 5000, label: '大纲最小行数' },
    { key: 'verifyRegionLines', type: 'number', min: 0, max: 5000, label: '校验区间行数' },
    { key: 'grepSummary', type: 'boolean', label: 'grep 汇总' },
    { key: 'grepPerFile', type: 'number', min: 1, max: 100, label: 'grep 每文件条数' },
    { key: 'editAnchorTtlMs', type: 'number', min: 0, max: 3600000, label: '锚点有效期(ms)' },
]);

export function apply(ctx, config = {}) {
    const cfg = {
        enabled: config.enabled !== false,
        softSteps: Number.isInteger(config.softSteps) && config.softSteps > 0 ? config.softSteps : DEFAULTS.softSteps,
        hardSteps: Number.isInteger(config.hardSteps) && config.hardSteps > 0 ? config.hardSteps : DEFAULTS.hardSteps,
        progressTools: Array.isArray(config.progressTools) ? config.progressTools.map(String) : [...DEFAULTS.progressTools],
        allowAlways: Array.isArray(config.allowAlways) ? config.allowAlways.map(String) : [...DEFAULTS.allowAlways],
        noTaskMode: config.noTaskMode === 'skip' ? 'skip' : 'count',
        resetOnIdle: config.resetOnIdle !== false,
        outlineMd: config.outlineMd !== false,
        outlineGd: config.outlineGd !== false,
        verifyRegion: config.verifyRegion !== false,
        outlineMinLines: Number.isInteger(config.outlineMinLines) && config.outlineMinLines > 0 ? config.outlineMinLines : DEFAULTS.outlineMinLines,
        verifyRegionLines: Number.isInteger(config.verifyRegionLines) && config.verifyRegionLines > 0 ? config.verifyRegionLines : DEFAULTS.verifyRegionLines,
        grepSummary: config.grepSummary !== false,
        grepSummaryAfter: Number.isInteger(config.grepSummaryAfter) && config.grepSummaryAfter > 0 ? config.grepSummaryAfter : DEFAULTS.grepSummaryAfter,
        grepPerFile: Number.isInteger(config.grepPerFile) && config.grepPerFile > 0 ? config.grepPerFile : DEFAULTS.grepPerFile,
        editAnchorTtlMs: Number.isInteger(config.editAnchorTtlMs) && config.editAnchorTtlMs > 0 ? config.editAnchorTtlMs : DEFAULTS.editAnchorTtlMs,
    };

    // 文件值覆盖 patch 初始值（设置界面的写入落在这里）。
    const persisted = {};
    for (const [key, value] of Object.entries(readPersisted())) {
        const normalized = normalizeField(key, value);
        if (normalized !== undefined) {
            cfg[key] = normalized;
            persisted[key] = normalized;
        }
    }
    if (cfg.hardSteps < cfg.softSteps) cfg.hardSteps = cfg.softSteps;

    const states = new WeakMap();

    ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        try {
            if (!cfg.enabled) return decision;
            const agent = payload?.agent;
            const state = stateFor(states, agent);
            if (state === undefined) return decision;
            const sessionId = agent?.session?.id;
            if (typeof sessionId === 'string') {
                if (state.sessionId === undefined) state.sessionId = sessionId;
                else if (sessionId !== state.sessionId) {
                    state.sessionId = sessionId;
                    state.steps = 0;
                    state.lastProgress = 0;
                    state.calls = 0;
                    state.lastProgressCall = 0;
                    state.completed = -1;
                    state.hasTaskList = false;
                    state.denied = 0;
                    state.edits = new Map();
                    state.completedKeys = new Set();
                    state.notice = null;
                    state.softWarned = false;
                }
            }
            state.steps += 1;
        } catch {
            // 计数失败绝不影响主流程。
        }
        return decision;
    });

    ctx.on('agent/status', (payload) => {
        try {
            if (!cfg.enabled || !cfg.resetOnIdle) return;
            if (payload?.status !== 'idle') return;
            const state = stateFor(states, payload?.agent);
            if (state === undefined) return;
            state.steps = 0;
            state.lastProgress = 0;
            state.calls = 0;
            state.lastProgressCall = 0;
        } catch {
            // ignore
        }
    });

    ctx.tools.guard((exec) => {
        try {
            if (!cfg.enabled) return undefined;
            const toolName = typeof exec?.name === 'string' ? exec.name : '';
            if (toolName.length === 0) return undefined;
            const state = stateFor(states, exec?.agent);
            if (state === undefined) return undefined;

            state.calls += 1;
            if (isProgress(state, toolName, exec?.arguments, cfg)) {
                state.lastProgress = state.steps;
                state.lastProgressCall = state.calls;
                return undefined;
            }
            if (cfg.noTaskMode === 'skip' && !state.hasTaskList) return undefined;

            // 计数按 **步**：一段程序算一步，程序内多少次嵌套调用都不推进熔断（Owner 2026-10-31）。
            const since = state.steps - state.lastProgress;
            const nested = exec?.parent !== undefined;
            const values = {
                steps: since,
                soft: cfg.softSteps,
                hard: cfg.hardSteps,
                done: Math.max(0, state.completed),
            };

            // PTC 程序内部（exec.parent 存在）：软阈值只挂"返回后告警"，绝不打断正在跑的批量程序。
            if (nested) {
                if (since >= cfg.softSteps && state.notice === null) state.notice = values;
                return undefined;
            }
            // 传输工具：软阈值照开（只武装告警），硬阈值才锁；文案与原生拦截不同。
            if (TRANSPORT_TOOLS.includes(toolName)) {
                if (since >= cfg.hardSteps) {
                    state.denied += 1;
                    return render(MESSAGES.ptcHardBlock, values);
                }
                if (since >= cfg.softSteps && state.notice === null) state.notice = values;
                return undefined;
            }
            if (since < cfg.softSteps) return undefined;
            if (cfg.allowAlways.includes(toolName)) return undefined;

            state.denied += 1;
            return render(since >= cfg.hardSteps ? MESSAGES.hardBlock : MESSAGES.softBlock, values);
        } catch {
            return undefined;
        }
    });

    // read shaping：只改 write/read 的结果形状，不改任何任务计数。
    // 任何一步不确定就 return decision（原样放行）。
    ctx.on('tools/post-execute', async (exec, result, next) => {
        const decision = await next();
        try {
            if (!cfg.enabled) return decision;
            const postToolName = typeof exec?.name === 'string' ? exec.name : '';
            // PTC 软阈值：程序跑完后把警告**追加**到这次 run_code 的结果里。
            // 不替换返回值、不另发消息、不改任何状态位——原程序输出原样留在前面。
            if (postToolName === 'run_code' && exec?.parent === undefined && result?.isError !== true) {
                const postState = stateFor(states, exec?.agent);
                if (postState !== undefined && postState.notice !== null) {
                    const blocks = contentOf(decision, result);
                    if (blocks.length > 0) {
                        // 会话内首次越软线：长告警一次（软加载插件提示词库）；之后再越线只追加短提醒。
                        const template = postState.softWarned ? MESSAGES.ptcSoftNotice : MESSAGES.ptcFirstSoftNotice;
                        const notice = render(template, postState.notice);
                        // 只有真的追加成功才消费：没送出去的告警留到下一步重试，一次性长文案不会被吞掉。
                        postState.notice = null;
                        postState.softWarned = true;
                        const extended = Object.assign({}, decision, {
                            content: blocks.concat([{ type: 'text', text: notice }]),
                        });
                        return extended;
                    }
                }
            }
            if (!decision || decision.kind !== 'accept') return decision;
            if (Object.prototype.hasOwnProperty.call(decision, 'value')) return decision;
            if (result !== undefined && result !== null && result.isError === true) return decision;
            const toolName = typeof exec?.name === 'string' ? exec.name : '';

            // grep 摘要：宽泛搜索的命中太多，改成"每文件计数 + 前几条原文 + 其余行号"，
            // 全量落到 spill（可用 read 的 offset/limit 原样取回），因此是有损可见、无损可取。
            if (toolName === 'grep') {
                if (!cfg.grepSummary) return decision;
                const fullText = textOf(decision, result);
                if (fullText === null) return decision;
                const parsed = parseGrepOutput(fullText);
                if (parsed === null || parsed.shown < cfg.grepSummaryAfter) return decision;
                // 超大输出不落盘（省下的上下文换成几 MB 的临时文件不划算）。
                if (fullText.length > 512 * 1024) return decision;
                const store = ctx.get('spillStore');
                if (store === undefined || store === null || typeof store.saveText !== 'function') return decision;
                const sessionId = exec?.agent?.session?.header?.id ?? exec?.agent?.session?.id;
                if (typeof sessionId !== 'string') return decision;
                let ref;
                try {
                    ref = await store.saveText({
                        owner: { sessionId },
                        source: { toolName: 'grep', callId: exec?.callId, label: 'result' },
                        suggestedName: 'grep.txt',
                        content: fullText,
                    });
                } catch {
                    return decision;
                }
                if (!ref || typeof ref.locator !== 'string') return decision;
                const listing = splitLines(fullText);
                const stub = buildGrepSummaryStub({
                    shown: parsed.shown,
                    total: parsed.total,
                    files: parsed.files,
                    perFile: cfg.grepPerFile,
                    locator: ref.locator,
                    spillPath: parsed.spillPath,
                    notes: parsed.notes,
                    hint: ref.retrievalHint,
                    listingLines: listing === null ? undefined : listing.length,
                });
                // never-worse：摘要至少要省下 25%，否则原样给全量更划算。
                if (stub.length <= fullText.length * 0.75) return replaceText(decision, stub);
                return decision;
            }

            const args = exec?.arguments ?? {};
            const rawPath = typeof args.file_path === 'string' ? args.file_path : '';
            if (rawPath.length === 0) return decision;
            const agent = exec?.agent;
            if (agent === undefined || agent === null) return decision;
            const state = stateFor(states, agent);
            if (state === undefined) return decision;
            const abs = resolveAgainst(agent, rawPath);
            if (abs === null) return decision;

            if (toolName === 'edit' || toolName === 'write') {
                recordEdit(state, abs, toolName, args);
                return decision;
            }
            if (toolName !== 'read') return decision;
            // 显式窗口读（offset / limit）永不被整形：那是模型自己指名的范围。
            if (args.offset !== undefined || args.limit !== undefined) return decision;

            const ext = path.extname(abs).toLowerCase();
            const wantsOutline = (ext === '.md' || ext === '.mdx') ? cfg.outlineMd : (ext === '.gd' ? cfg.outlineGd : false);
            const pending = takeEdit(state, abs, cfg);
            if (pending === undefined && !wantsOutline) return decision;

            let text;
            try {
                text = fs.readFileSync(abs, 'utf8');
            } catch {
                return decision;
            }
            const lines = splitLines(text);
            if (lines === null || lines.length === 0) return decision;
            const originalLen = resultTextLength(decision, result);
            if (originalLen < 0) return decision;
            const sha = fingerprint(text);
            if (sha === null) return decision;

            if (pending !== undefined && cfg.verifyRegion) {
                // verifyRegionLines 就是窗口总行数（面板这么写的），不再是单侧行数。
                const window = verifyWindow(lines, pending.anchor, cfg.verifyRegionLines);
                if (window !== null) {
                    const stub = buildVerifyStub({ total: lines.length, sha, anchor: pending.anchor, window, lines });
                    // never-worse：窗口不比整文件省就别换。
                    if (stub.length <= originalLen * 0.7) return replaceText(decision, stub);
                }
            }

            if (wantsOutline && lines.length >= cfg.outlineMinLines) {
                const outline = ext === '.gd' ? gdMembers(lines) : mdOutline(lines);
                if (outline !== null) {
                    const stub = buildOutlineStub({ kind: ext === '.gd' ? 'gd' : 'md', total: lines.length, sha, outline });
                    if (stub.length <= originalLen * 0.6) return replaceText(decision, stub);
                }
            }
            return decision;
        } catch {
            // 整形失败绝不影响主流程。
            return decision;
        }
    });

    // 设置界面后端：GET 读当前值；POST 局部更新并落盘，即时生效。
    ctx.effect(() => {
        const handler = async (req, res) => {
            try {
                const url = String(req.url ?? '').split('?')[0].replace(/\/+$/, '');
                if (req.method === 'GET' && url.endsWith('/api/config')) {
                    sendJson(res, 200, { ok: true, config: snapshot(cfg), defaults: { ...DEFAULTS }, file: CONFIG_LOCATION });
                    return;
                }
                if (req.method === 'POST' && url.endsWith('/api/config')) {
                    let body = {};
                    try {
                        const chunks = [];
                        for await (const chunk of req) chunks.push(chunk);
                        const raw = Buffer.concat(chunks).toString('utf8');
                        if (raw.length > 0) body = JSON.parse(raw);
                    } catch {
                        body = {};
                    }
                    const applied = {};
                    for (const [key, value] of Object.entries(body ?? {})) {
                        const normalized = normalizeField(key, value);
                        if (normalized !== undefined) {
                            cfg[key] = normalized;
                            persisted[key] = normalized;
                            applied[key] = normalized;
                        }
                    }
                    if (cfg.hardSteps < cfg.softSteps) {
                        cfg.hardSteps = cfg.softSteps;
                        persisted.hardSteps = cfg.hardSteps;
                        applied.hardSteps = cfg.hardSteps;
                    }
                    writePersisted(persisted);
                    sendJson(res, 200, { ok: true, applied, config: snapshot(cfg), file: CONFIG_LOCATION });
                    return;
                }
                sendJson(res, 404, { ok: false, error: 'unknown exploration-guard endpoint' });
            } catch (error) {
                // 不回显异常正文：fs 错误里常带绝对路径。详情只进宿主日志。
                console.warn('[exploration-guard] settings API failed:', error);
                sendJson(res, 500, { ok: false, error: 'settings request failed' });
            }
        };
        overlayStored('exploration-guard', SETTINGS_FIELDS, cfg);
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/exploration-guard/config', handler: (req, res) => handleSettings('exploration-guard', SETTINGS_FIELDS, cfg, req, res) }), 'exploration-guard: settings');

    return ctx.webServer.register({ kind: 'prefix', path: '/exploration-guard', handler });
    }, 'exploration-guard: settings API');
}

function snapshot(cfg) {
    return {
        enabled: cfg.enabled,
        softSteps: cfg.softSteps,
        hardSteps: cfg.hardSteps,
        noTaskMode: cfg.noTaskMode,
        resetOnIdle: cfg.resetOnIdle,
        outlineMd: cfg.outlineMd,
        outlineGd: cfg.outlineGd,
        verifyRegion: cfg.verifyRegion,
        outlineMinLines: cfg.outlineMinLines,
        verifyRegionLines: cfg.verifyRegionLines,
        grepSummary: cfg.grepSummary,
        grepSummaryAfter: cfg.grepSummaryAfter,
        grepPerFile: cfg.grepPerFile,
    };
}

function sendJson(res, status, payload) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(payload));
}

function stateFor(states, agent) {
    if (agent === undefined || agent === null) return undefined;
    let state = states.get(agent);
    if (state === undefined) {
        state = { sessionId: undefined, steps: 0, lastProgress: 0, calls: 0, lastProgressCall: 0, completed: -1, completedKeys: new Set(), hasTaskList: false, denied: 0, edits: new Map(), notice: null, softWarned: false };
        states.set(agent, state);
    }
    return state;
}

/** 取结果的内容块：先看 decision 上是否已被上游改写，再退回原始 result。 */
function contentOf(decision, result) {
    const fromDecision = decision?.content;
    if (Array.isArray(fromDecision) && fromDecision.length > 0) return fromDecision;
    const fromResult = result?.content;
    if (Array.isArray(fromResult) && fromResult.length > 0) return fromResult;
    return [];
}

/** 取结果里第一个 text 块的字符串；没有就 null。 */
function textOf(decision, result) {
    for (const block of contentOf(decision, result)) {
        if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') return block.text;
    }
    return null;
}

/** 结果里第一个 text 块的长度；没有文本块返回 -1（调用方据此放弃整形）。 */
function resultTextLength(decision, result) {
    const text = textOf(decision, result);
    return text === null ? -1 : text.length;
}

/** 只替换文本块，其余 decision 字段（kind 等）原样保留。 */
function replaceText(decision, text) {
    return Object.assign({}, decision, { content: [{ type: 'text', text }] });
}

/**
 * 相对路径只按会话工作区解析（agent.session.header.cwd）。
 * 工作区未知时不猜进程 cwd——猜错会把别处的同名文件当成这次读的文件。
 */
function resolveAgainst(agent, rawPath) {
    try {
        if (path.isAbsolute(rawPath)) return path.normalize(rawPath);
        const base = agent?.session?.header?.cwd;
        if (typeof base !== 'string' || base.length === 0) return null;
        return path.resolve(base, rawPath);
    } catch {
        return null;
    }
}

const EDIT_ANCHOR_LIMIT = 16;

/** 记下 edit/write 的锚点：edit 用 new_string 的第一条非空行；write 记空锚点（整文件）。 */
function recordEdit(state, abs, toolName, args) {
    if (!(state.edits instanceof Map)) state.edits = new Map();
    let anchor = '';
    if (toolName === 'edit' && typeof args.new_string === 'string') {
        const first = args.new_string.split('\n').find((line) => line.trim().length > 0);
        anchor = first === undefined ? '' : first.trim();
    }
    // 同一路径后写覆盖前写；Map 保序，超限淘汰最旧的。
    if (state.edits.has(abs)) state.edits.delete(abs);
    state.edits.set(abs, { anchor, tool: toolName, at: Date.now() });
    while (state.edits.size > EDIT_ANCHOR_LIMIT) {
        const oldest = state.edits.keys().next();
        if (oldest.done) break;
        state.edits.delete(oldest.value);
    }
}

/** 取出并消费该路径的编辑锚点（一次性）；过期视为没有。 */
function takeEdit(state, abs, cfg) {
    if (!(state.edits instanceof Map)) return undefined;
    const entry = state.edits.get(abs);
    if (entry === undefined) return undefined;
    state.edits.delete(abs);
    if (Date.now() - entry.at > cfg.editAnchorTtlMs) return undefined;
    return entry;
}

function completedCount(todos) {
    if (!Array.isArray(todos)) return undefined;
    let completed = 0;
    for (const item of todos) {
        if (item && typeof item === 'object' && item.status === 'completed') completed += 1;
    }
    return completed;
}

/** 已完成项的身份集：重写清单会删掉旧完成项，只比计数会永远"没进展"。 */
function completedKeys(todos) {
    const keys = [];
    if (!Array.isArray(todos)) return keys;
    todos.forEach((item, index) => {
        if (!item || typeof item !== 'object' || item.status !== 'completed') return;
        const label = typeof item.content === 'string' && item.content.length > 0
            ? item.content
            : typeof item.text === 'string' && item.text.length > 0 ? item.text : '#' + String(index);
        keys.push(label);
    });
    return keys;
}

/** @returns {boolean} whether this call actually advanced a task node. */
function isProgress(state, toolName, args, config) {
    if (!config.progressTools.includes(toolName)) return false;
    try {
        if (toolName === 'todo_write') {
            const completed = completedCount(args?.todos);
            if (completed === undefined) return false;
            state.hasTaskList = true;
            const keys = completedKeys(args?.todos);
            // 只比计数会被"重写清单时删掉旧完成项"骗死：比较**新增的完成项身份**。
            const first = state.completed < 0;
            const advanced = first || keys.some((key) => !state.completedKeys.has(key));
            state.completed = completed;
            state.completedKeys = new Set(keys);
            return advanced;
        }
        if (toolName === 'create_goal') return true;
        if (toolName === 'update_goal') {
            const action = String(args?.action ?? '');
            return action === 'complete' || action === 'blocked';
        }
        return false;
    } catch {
        return false;
    }
}

export { isProgress, completedCount, completedKeys, DEFAULTS };
