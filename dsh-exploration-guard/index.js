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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
});

const CONFIG_LOCATION = '$DSH_HOME/exploration-guard/config.json';

// 文案规则（Owner 2026-10-28）：尽量短，且必须让模型分清"受限期间什么有用、什么无用"。
// 关键事实一：计数是"距上次 completed 增加的步数"，重写同一张清单**不算**进展——
// 这正是上一轮模型反复被拦却不知为何的原因，所以文案里要带 completed= 现值。
// 关键事实二：受限期间只有白名单工具能过（todo_write / goal / ask_user_question 等），
// 读文件、写文件、跑 shell 一律被拒。
const SOFT_TEMPLATE = 'Blocked: {steps} step(s) since the last completed todo (soft={soft}, completed={done}). Rewriting the list does not count. Honest ways out: mark a genuinely finished item completed, update_goal blocked, or ask the Owner. Other tools are refused.';
const HARD_TEMPLATE = 'Blocked: {steps} step(s) (hard={hard}, completed={done}). Only honest progress passes: mark a genuinely finished item completed, update_goal blocked, or ask the Owner — never mark work complete just to unblock. Everything else is refused.';

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
            return typeof value === 'boolean' ? value : undefined;
        case 'softSteps':
        case 'hardSteps': {
            const n = typeof value === 'number' ? value : Number(value);
            if (!Number.isFinite(n)) return undefined;
            const rounded = Math.round(n);
            if (rounded < 1 || rounded > 500) return undefined;
            return rounded;
        }
        case 'noTaskMode':
            return value === 'count' || value === 'skip' ? value : undefined;
        default:
            return undefined;
    }
}

export function apply(ctx, config = {}) {
    const cfg = {
        enabled: config.enabled !== false,
        softSteps: Number.isInteger(config.softSteps) && config.softSteps > 0 ? config.softSteps : DEFAULTS.softSteps,
        hardSteps: Number.isInteger(config.hardSteps) && config.hardSteps > 0 ? config.hardSteps : DEFAULTS.hardSteps,
        progressTools: Array.isArray(config.progressTools) ? config.progressTools.map(String) : [...DEFAULTS.progressTools],
        allowAlways: Array.isArray(config.allowAlways) ? config.allowAlways.map(String) : [...DEFAULTS.allowAlways],
        noTaskMode: config.noTaskMode === 'skip' ? 'skip' : 'count',
        resetOnIdle: config.resetOnIdle !== false,
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
                    state.completed = -1;
                    state.hasTaskList = false;
                    state.denied = 0;
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

            if (isProgress(state, toolName, exec?.arguments, cfg)) {
                state.lastProgress = state.steps;
                return undefined;
            }
            if (cfg.noTaskMode === 'skip' && !state.hasTaskList) return undefined;

            const since = state.steps - state.lastProgress;
            if (since < cfg.softSteps) return undefined;
            if (cfg.allowAlways.includes(toolName)) return undefined;

            state.denied += 1;
            const template = since >= cfg.hardSteps ? HARD_TEMPLATE : SOFT_TEMPLATE;
            return template
                .replace('{steps}', String(since))
                .replace('{soft}', String(cfg.softSteps))
                .replace('{hard}', String(cfg.hardSteps))
                .replace('{done}', String(Math.max(0, state.completed)));
        } catch {
            return undefined;
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
        state = { sessionId: undefined, steps: 0, lastProgress: 0, completed: -1, hasTaskList: false, denied: 0 };
        states.set(agent, state);
    }
    return state;
}

function completedCount(todos) {
    if (!Array.isArray(todos)) return undefined;
    let completed = 0;
    for (const item of todos) {
        if (item && typeof item === 'object' && item.status === 'completed') completed += 1;
    }
    return completed;
}

/** @returns {boolean} whether this call actually advanced a task node. */
function isProgress(state, toolName, args, config) {
    if (!config.progressTools.includes(toolName)) return false;
    try {
        if (toolName === 'todo_write') {
            const completed = completedCount(args?.todos);
            if (completed === undefined) return false;
            state.hasTaskList = true;
            const first = state.completed < 0;
            const advanced = first || completed > state.completed;
            state.completed = completed;
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

export { isProgress, completedCount, DEFAULTS };
