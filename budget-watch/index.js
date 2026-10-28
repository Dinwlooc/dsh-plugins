// dsh-budget-watch（原名 nfm-budget-watch）— DSH 只提醒、不中断的 token 预算看门狗。
//
// 口径（Owner 2026-10-25 修订）：预算不按 provider 原始总值计，而按「计费消费 + 套餐消费」之和评估——
//   · 直计费模型（如 Deepseek）：未命中缓存输入 + 输出（billed）；
//   · 套餐总量模型（如 GLM）：输入+输出+缓存读写全量（quota，模型名含 planModelHints 即判）。
// 每一笔 Owner 发放（"+tok"）都从当前实际示数重计：granted=本次发放额，忽略超额与余额，无追加语义。
// 默认预算经验值 1M tok（原 10M 是 Deepseek 时代经验值，弃用）。
// 设计红线：永不 reject、永不 throw、永不拦工具——只在下一步追加一条很短的 user 消息。
//
// 记账来源：包装 `llm/stream` 观察 provider 的 usage chunk（带 sessionId 的请求）。
// 零依赖：不 import @deepseek-ai/*（link 安装的 profile 解析不到 peer 依赖）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const name = 'budget-watch';
export const inject = ['tools'];

const DEFAULT_THRESHOLDS = [0.8];

const DEFAULTS = Object.freeze({
    enabled: true,
    thresholds: DEFAULT_THRESHOLDS,
    remindUnregistered: false,
    homeDir: '',
    debugProbe: false,
    // 模型名含这些子串 → 按套餐总量（quota）计；否则按直计费（billed）计。
    planModelHints: ['glm'],
    // 金钱锚点（Owner 2026-10-27）：分档单价，¥/1M token，按模型名子串匹配（首个命中）。
    // 三档 = 缓存命中输入(hit) / 缓存未命中输入(miss) / 输出(out)；cacheWrite 按 miss 价计。
    // 来源：api-docs.deepseek.com/quick_start/pricing（USD/1M；此处按 ¥7.1/$ 折成人民币峰值价）。
    //   V4.1-Flash: hit $0.006 / miss $0.30 / out $1.20
    //   V4-Pro    : hit $0.044 / miss $1.32 / out $3.96
    // 套餐模型用 { subscription: true }：订阅制，不可折算，单列不参与求和。
    prices: [
        ['deepseek-v4-pro', { hit: 0.31, miss: 9.37, out: 28.12 }],
        ['deepseek-flash', { hit: 0.043, miss: 2.13, out: 8.52 }],
        ['glm', { subscription: true }],
    ],
    // 未能归因到具体模型的 token（'?' 桶 / provider:xxx 标签）按此价估，绝不当作免费。
    defaultRates: { hit: 0.043, miss: 2.13, out: 8.52 },
    // USD → CNY 换算率（仅文档用；上表已是人民币）
    usdToCny: 7.1,
});

function toRates(value) {
    if (!value || typeof value !== 'object' || value.subscription) return null;
    const hit = Number(value.hit);
    const miss = Number(value.miss);
    const out = Number(value.out);
    if (!Number.isFinite(hit) || !Number.isFinite(miss) || !Number.isFinite(out)) return null;
    if (hit < 0 || miss < 0 || out < 0) return null;
    return { hit, miss, out };
}

function normalizeConfig(raw) {
    const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
    cfg.warnings = [];
    const list = Array.isArray(cfg.thresholds) ? cfg.thresholds : DEFAULT_THRESHOLDS;
    cfg.thresholds = [...new Set(list
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v > 0 && v <= 1))]
        .sort((a, b) => a - b);
    if (cfg.thresholds.length === 0) cfg.thresholds = [...DEFAULT_THRESHOLDS];

    // prices: [[prefix, {hit,miss,out}|{subscription:true}]] 或 { prefix: rates }。
    // 脏行（非有限数/负数/缺档位）整行丢弃并留一条警告——NaN 会毒化整笔求和。
    const rawPrices = cfg.prices;
    const table = [];
    let dropped = 0;
    const pushRow = (prefix, value) => {
        if (typeof prefix !== 'string' || prefix.trim() === '') { dropped++; return; }
        if (value && typeof value === 'object' && value.subscription === true) {
            table.push([prefix.trim().toLowerCase(), { subscription: true }]);
            return;
        }
        const rates = toRates(value);
        if (rates === null) { dropped++; return; }
        table.push([prefix.trim().toLowerCase(), rates]);
    };
    if (Array.isArray(rawPrices)) {
        for (const row of rawPrices) {
            if (Array.isArray(row) && row.length >= 2) pushRow(row[0], row[1]);
            else dropped++;
        }
    } else if (rawPrices && typeof rawPrices === 'object') {
        for (const [k, v] of Object.entries(rawPrices)) pushRow(k, v);
    } else if (rawPrices !== undefined) {
        dropped++;
    }
    cfg.prices = table.length > 0 ? table : DEFAULTS.prices.map(([k, v]) => [k, { ...v }]);
    if (dropped > 0) cfg.warnings.push(`prices: dropped ${dropped} invalid row(s)`);

    const dr = toRates(cfg.defaultRates);
    if (dr === null) {
        cfg.warnings.push('defaultRates invalid — falling back to flash rates');
        cfg.defaultRates = { ...DEFAULTS.defaultRates };
    } else {
        cfg.defaultRates = dr;
    }
    return cfg;
}

function baseHome(config) {
    return config.homeDir || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function ledgerDir(config) {
    return path.join(baseHome(config), 'budget-watch');
}

/** 会话 id 只允许安全字符，防止路径穿越（sessionId 可由工具参数显式传入）。 */
function safeSessionId(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (s === '' || s.length > 200) return null;
    if (s === '.' || s === '..' || s.includes('..')) return null;
    if (!/^[A-Za-z0-9._:-]+$/.test(s)) return null;
    return s;
}

/**
 * 一个会话可能有两种命名形态：`<id>.json` 与 `session-<id>.json`
 * （DSH 升级前后 session.id 带/不带 `session-` 前缀）。写入必须落回同一个文件，
 * 否则同一会话会分裂成两个账本——这正是并行会话下"数字对不上"的来源。
 */
function ledgerCandidates(config, sessionId) {
    const dir = ledgerDir(config);
    const primary = path.join(dir, `${sessionId}.json`);
    const alt = sessionId.startsWith('session-')
        ? sessionId.slice('session-'.length)
        : `session-${sessionId}`;
    if (alt === '' || alt === sessionId) return [primary];
    return [primary, path.join(dir, `${alt}.json`)];
}

const ledgerFiles = new Map(); // requestId -> 实际账本文件（命中旧命名时固定下来）

function ledgerFileFor(config, sessionId) {
    if (ledgerFiles.has(sessionId)) return ledgerFiles.get(sessionId);
    const candidates = ledgerCandidates(config, sessionId);
    let file = candidates[0];
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) { file = candidate; break; }
        } catch { /* 探测失败按不存在处理 */ }
    }
    ledgerFiles.set(sessionId, file);
    return file;
}

function emptyLedger(sessionId) {
    return {
        sessionId,
        sessionTotal: 0,
        cost: { billed: 0, quota: 0 },
        models: {},
        task: null,
        unregisteredNotified: false,
        updatedAt: null,
    };
}

/** 分档费率 for a model id: {rates} | {subscription:true} | null(未知→按 defaultRates). */
function ratesOf(config, model) {
    const m = String(model || '').toLowerCase();
    if (m === '' || m === '?' || m.startsWith('provider:')) return null;
    for (const [prefix, value] of config.prices) {
        if (m.includes(prefix)) return value;
    }
    return null;
}

function zeroMix() {
    return { hit: 0, miss: 0, out: 0, write: 0 };
}

function normalizeMix(value) {
    const raw = value && typeof value === 'object' ? value : {};
    const out = zeroMix();
    for (const key of Object.keys(out)) {
        const v = Number(raw[key]);
        out[key] = Number.isFinite(v) && v > 0 ? v : 0;
    }
    return out;
}

/** 一条（模型 × 三档）账 → { cost, uncosted, mix } */
function moneyOf(config, models) {
    let cost = 0;
    let unattributedTokens = 0;
    let attributedTokens = 0;
    let subscriptionTokens = 0;
    const rows = [];
    for (const [model, rawMix] of Object.entries(models || {})) {
        const mix = normalizeMix(rawMix);
        const tokens = mix.hit + mix.miss + mix.out + mix.write;
        if (tokens <= 0) continue;
        const rates = ratesOf(config, model);
        if (rates && rates.subscription) {
            subscriptionTokens += tokens;
            rows.push({ model, tokens, kind: 'subscription', mix });
            continue;
        }
        const use = rates !== null ? rates : config.defaultRates;
        const sub = mix.hit / 1e6 * use.hit
            + mix.miss / 1e6 * use.miss
            + mix.write / 1e6 * use.miss
            + mix.out / 1e6 * use.out;
        cost += sub;
        if (rates !== null) attributedTokens += tokens;
        else unattributedTokens += tokens;
        rows.push({ model, tokens, kind: rates !== null ? 'priced' : 'unattributed', cost: sub, mix });
    }
    const total = attributedTokens + unattributedTokens + subscriptionTokens;
    return { cost, rows, attributedTokens, unattributedTokens, subscriptionTokens, total };
}

function fmtYuan(value) {
    const v = Number(value) || 0;
    if (v === 0) return '¥0';
    if (v < 0.01) return `¥${v.toFixed(4)}`;
    if (v < 1) return `¥${v.toFixed(3)}`;
    if (v < 100) return `¥${v.toFixed(2)}`;
    return `¥${v.toFixed(1)}`;
}

function normalizeCost(value) {
    const raw = value && typeof value === 'object' ? value : {};
    return {
        billed: Number.isSafeInteger(raw.billed) && raw.billed >= 0 ? raw.billed : 0,
        quota: Number.isSafeInteger(raw.quota) && raw.quota >= 0 ? raw.quota : 0,
    };
}

function normalizeTask(value) {
    if (!value || typeof value !== 'object') return null;
    const grants = Array.isArray(value.grants) ? value.grants.filter((g) => g && typeof g === 'object') : [];
    const granted = Number.isSafeInteger(value.granted) && value.granted > 0 ? value.granted : 0;
    if (granted <= 0) return null;
    return {
        id: typeof value.id === 'string' ? value.id : crypto.randomUUID(),
        startedAt: typeof value.startedAt === 'string' ? value.startedAt : null,
        baselineUsed: Number.isSafeInteger(value.baselineUsed) && value.baselineUsed >= 0 ? value.baselineUsed : 0,
        baselineCost: normalizeCost(value.baselineCost),
        granted,
        grants,
        announced: value.announced && typeof value.announced === 'object' ? { ...value.announced } : {},
    };
}

function normalizeLedger(value, sessionId) {
    const base = emptyLedger(sessionId);
    if (!value || typeof value !== 'object') return base;
    return {
        sessionId,
        sessionTotal: Number.isSafeInteger(value.sessionTotal) && value.sessionTotal >= 0 ? value.sessionTotal : 0,
        cost: normalizeCost(value.cost),
        models: value.models && typeof value.models === 'object' ? { ...value.models } : {},
        task: normalizeTask(value.task),
        unregisteredNotified: Boolean(value.unregisteredNotified),
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    };
}

const ledgerCache = new Map(); // 账本文件路径 -> ledger（两种会话 id 形态解析到同一文件时不分裂）

function loadLedger(config, sessionId) {
    const file = ledgerFileFor(config, sessionId);
    if (ledgerCache.has(file)) return ledgerCache.get(file);
    let ledger = emptyLedger(sessionId);
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        // 文件里记录的 sessionId 才是这个账本的真实身份（可能带/不带 session- 前缀）。
        ledger = normalizeLedger(raw, typeof raw?.sessionId === 'string' && raw.sessionId ? raw.sessionId : sessionId);
    } catch {
        // 无账本文件：用内存空账本
    }
    ledgerCache.set(file, ledger);
    return ledger;
}

function saveLedger(config, ledger) {
    const file = ledgerFileFor(config, ledger.sessionId);
    ledgerCache.set(file, ledger);
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        ledger.updatedAt = new Date().toISOString();
        fs.writeFileSync(file, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
        return true;
    } catch {
        return false;
    }
}

/** Provider usage record → 双口径消费 + 三档分词（hit/miss/out/write）。 */
function usageSplit(usage, config) {
    const hints = Array.isArray(config.planModelHints) ? config.planModelHints : DEFAULTS.planModelHints;
    const u = usage && typeof usage === 'object' ? usage : {};
    const model = String(u.model || u.modelName || u.provider || '').toLowerCase();
    const isPlan = hints.some((h) => model.includes(String(h).toLowerCase()));
    const input = Number(u.inputTokens) || 0;
    const output = Number(u.outputTokens) || 0;
    const cacheRead = Number(u.cacheReadTokens) || 0;
    const cacheWrite = Number(u.cacheWriteTokens) || 0;
    const uncached = Number.isFinite(Number(u.uncachedInputTokens)) ? Number(u.uncachedInputTokens) : Math.max(0, input - cacheRead);
    return {
        billed: uncached + output,
        quota: input + output + cacheRead + cacheWrite,
        total: input + output + cacheRead + cacheWrite,
        model: String(u.model || u.modelName || ''),
        mix: { hit: cacheRead, miss: uncached, out: output, write: cacheWrite },
        isPlan,
    };
}

function fmt(n) {
    const value = Number(n) || 0;
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
    return String(value);
}

function sessionIdOf(agent) {
    // 只认 session.id：agent.id 与 session.id 形态不同，混用会把同一会话记进两个账本。
    return safeSessionId(agent?.session?.id) || 'unknown';
}

function warningText(used) {
    const formatted = String(Math.max(0, Math.round(used))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `[budget-watch] Used: ${formatted} tokens. Prepare to wrap up.`;
}

function makeMessage(text) {
    return {
        role: 'user',
        id: crypto.randomUUID(),
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
    };
}

function pctOf(part, whole) {
    return whole > 0 ? `${Math.round((100 * part) / whole)}%` : 'n/a';
}

/** 单价表 → 一行可读文本（三档，¥/M）。 */
function priceTableText(config) {
    return config.prices
        .map(([k, v]) => (v.subscription
            ? `${k}=subscription`
            : `${k}=hit¥${v.hit}/miss¥${v.miss}/out¥${v.out}`))
        .join(' ');
}

function moneyText(config, models, sessionTotal) {
    const m = moneyOf(config, models);
    const tracked = m.total;
    const legacy = Math.max(0, (Number(sessionTotal) || 0) - tracked);
    const denominator = Math.max(Number(sessionTotal) || 0, tracked);
    const attrPct = pctOf(m.attributedTokens, denominator);
    // 老账本（升级前的纯数字桶）三档不可知：不猜、不按 0 计，单列 unpriced。
    const legacyClause = legacy > 0 ? `; ${fmt(legacy)} tok legacy (mix unknown, unpriced)` : '';
    const unattrClause = m.unattributedTokens > 0
        ? `, ${fmt(m.unattributedTokens)} tok unattributed @default`
        : '';
    const headline = `money≈${fmtYuan(m.cost)} (attr ${attrPct}${unattrClause}${legacyClause})`;
    const subClause = m.subscriptionTokens > 0
        ? ` + subscription ${fmt(m.subscriptionTokens)} tok (not convertible)`
        : '';
    // 性价比曲线原料：每模型三档占比 + 折算后 ¥/M。
    const rows = m.rows
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 4)
        .map((r) => {
            const t = r.tokens;
            const mix = `hit${pctOf(r.mix.hit, t)}/miss${pctOf(r.mix.miss, t)}/out${pctOf(r.mix.out, t)}`;
            if (r.kind === 'subscription') return `${r.model}=${fmt(t)}[subscription ${mix}]`;
            const perM = (Number(r.cost) || 0) / (t / 1e6);
            return `${r.model}=${fmt(t)}[${mix}]≈¥${perM.toFixed(2)}/M${r.kind === 'unattributed' ? '*' : ''}`;
        })
        .join(' ');
    return {
        headline: `${headline}${subClause}`,
        rows,
        prices: priceTableText(config),
        noModelData: m.rows.length === 0,
    };
}

function shortSession(id) {
    const s = String(id || 'unknown');
    return s.length > 18 ? `${s.slice(0, 18)}…` : s;
}

function statusText(ledger, config) {
    const models = ledger.models && typeof ledger.models === 'object' ? ledger.models : {};
    const money = moneyText(config, models, ledger.sessionTotal);
    const warn = Array.isArray(config.warnings) && config.warnings.length > 0 ? `\nwarn: ${config.warnings.join('; ')}` : '';
    const tag = `session=${ledger.sessionId}`;
    if (!ledger.task) {
        return `[budget-watch] ${tag} 尚未登记预算（本会话累计 ${fmt(ledger.sessionTotal)} tok）。Owner 发放后请调用 budget_register（例：tokens=1000000）。\n${money.headline}\n预算判定：billed+quota 原始 token，与 granted 比较；¥ 仅作决策参考。${money.noModelData ? '\nmodels: (no per-model data)' : `\nmodels: ${money.rows}`}\nprices(¥/M): ${money.prices}${warn}`;
    }
    const base = normalizeCost(ledger.task.baselineCost);
    const used = Math.max(0, ledger.cost.billed - base.billed) + Math.max(0, ledger.cost.quota - base.quota);
    const pct = `${((used / ledger.task.granted) * 100).toFixed(1)}%`;
    const announced = Object.keys(ledger.task.announced).filter((k) => ledger.task.announced[k]).join(',') || 'none';
    return [
        `[budget-watch] ${tag} task granted=${fmt(ledger.task.granted)} used=${fmt(used)} (billed+quota) remaining=${fmt(Math.max(0, ledger.task.granted - used))} pct=${pct} announced=${announced}`,
        `session_total=${fmt(ledger.sessionTotal)} cost=billed ${fmt(ledger.cost.billed)} + quota ${fmt(ledger.cost.quota)} baseline=${fmt(ledger.task.baselineUsed)} grants=${ledger.task.grants.length}`,
        `${money.headline}`,
        money.noModelData ? 'models: (no per-model data)' : `models: ${money.rows}`,
        `prices(¥/M): ${money.prices}${warn}`,
    ].join('\n');
}

function resolveSessionId(args, exec) {
    if (args && args.sessionId !== undefined) {
        const explicit = safeSessionId(args.sessionId);
        if (!explicit) return { error: 'sessionId 非法：只允许字母、数字与 . _ : -' };
        return { id: explicit, explicit: true };
    }
    const own = safeSessionId(exec?.agent?.session?.id);
    if (!own) return { error: '当前调用没有归属会话，无法定位预算账本（并行会话请显式传 sessionId）。' };
    return { id: own, explicit: false };
}

function createRegisterTool(ctx, config) {
    return {
        name: 'budget_register',
        description:
            'Register a token budget granted by the Owner in natural language (e.g. "+1M tok"). Call this once per grant before continuing. '
            + 'Every grant RE-BASELINES from the current actual reading: granted = this grant, ignoring overage and remaining balance (no top-up semantics; newTask is accepted but has no effect). '
            + 'tokens = the grant amount in raw tokens (1M = 1000000). Default budget expectation is 1M tok. '
            + 'Ledgers are per session (this call writes the CALLING session by default); pass sessionId only to target a different session explicitly (e.g. a sub-agent ledger from the parent). '
            + 'Accounting: billed (uncached input + output, direct-billing models) + quota (full total, plan-quota models), summed and compared with the budget. '
            + 'The plugin only warns at thresholds; it never interrupts. Sub-agent token spend may leak into this meter — treat it as approximate.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                tokens: { type: 'integer', minimum: 1, description: 'Grant amount in raw tokens, e.g. 1000000 for "+1M tok".' },
                note: { type: 'string', description: 'Optional note: which task/owner message this grant came from.' },
                sessionId: { type: 'string', description: 'Optional explicit session id. Omit to target the calling session (recommended).' },
            },
            required: ['tokens'],
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args, exec) {
            const target = resolveSessionId(args, exec);
            if (target.error) return `[budget-watch] ${target.error}`;
            const sessionId = target.id;
            const tokens = args?.tokens;
            if (!Number.isSafeInteger(tokens) || tokens <= 0) {
                return '[budget-watch] tokens 必须是正的安全整数（例：1000000 表示 1M）。';
            }
            const ledger = loadLedger(config, sessionId);
            const grant = {
                id: crypto.randomUUID(),
                tokens,
                at: new Date().toISOString(),
                note: typeof args?.note === 'string' ? args.note.slice(0, 200) : '',
            };
            // Owner 规则：每一笔 "+tok" 都从当前实际示数重计，忽略超额与余额——没有追加语义。
            ledger.task = {
                id: crypto.randomUUID(),
                startedAt: grant.at,
                baselineUsed: ledger.sessionTotal,
                baselineCost: normalizeCost(ledger.cost),
                granted: tokens,
                grants: [...(ledger.task?.grants ?? []).slice(-9), grant],
                announced: {},
            };
            ledger.unregisteredNotified = true;
            saveLedger(config, ledger);
            const base = normalizeCost(ledger.task.baselineCost);
            const used = Math.max(0, ledger.cost.billed - base.billed) + Math.max(0, ledger.cost.quota - base.quota);
            const scope = target.explicit ? '（显式指定）' : '';
            return `[budget-watch] session=${ledger.sessionId}${scope} 已登记 +${fmt(tokens)}（重计），本任务预算 ${fmt(ledger.task.granted)}；已用 ${fmt(used)}（billed+quota），剩余 ${fmt(Math.max(0, ledger.task.granted - used))}。`;
        },
    };
}

function createStatusTool(ctx, config) {
    return {
        name: 'budget_status',
        description:
            'Query ONE session\'s budget ledger: session id, task granted/used/remaining/percent and announced thresholds. Read-only. '
            + 'Defaults to the CALLING session; pass sessionId only to inspect a different session (e.g. a sub-agent ledger). '
            + 'Use it before wrapping up or asking the Owner for more budget.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                sessionId: { type: 'string', description: 'Optional explicit session id. Omit to query the calling session (recommended).' },
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args, exec) {
            const target = resolveSessionId(args, exec);
            if (target.error) return `[budget-watch] ${target.error}`;
            return statusText(loadLedger(config, target.id), config);
        },
    };
}

export function apply(ctx, rawConfig) {
    const config = normalizeConfig(rawConfig);

    ctx.tools.register(createRegisterTool(ctx, config));
    ctx.tools.register(createStatusTool(ctx, config));

    // 计量：观察每次带 sessionId 的流式模型调用的 provider usage。
    ctx.on('llm/stream', (options, next) => meterStream(config, options, next()));

    ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        if (!config.enabled) return decision;
        if (!decision || decision.kind !== 'enter') return decision;
        try {
            const session = payload?.agent?.session;
            if (!session) return decision;
            const sessionId = sessionIdOf(payload.agent);
            const ledger = loadLedger(config, sessionId);

            let text = null;
            if (ledger.task) {
                const base = normalizeCost(ledger.task.baselineCost);
                const used = Math.max(0, ledger.cost.billed - base.billed) + Math.max(0, ledger.cost.quota - base.quota);
                const pct = used / ledger.task.granted;
                const crossed = config.thresholds.filter((t) => pct >= t && !ledger.task.announced[String(t)]);
                if (crossed.length > 0) {
                    text = warningText(used);
                    for (const t of crossed) ledger.task.announced[String(t)] = true;
                    saveLedger(config, ledger);
                }
            } else if (config.remindUnregistered && ledger.sessionTotal > 0 && !ledger.unregisteredNotified) {
                text = '[budget-watch] 本会话尚未登记预算。Owner 用自然语言发放后，请调用 budget_register 填报（如 tokens=1000000）；插件只提醒、不中断。';
                ledger.unregisteredNotified = true;
                saveLedger(config, ledger);
            }

            if (text === null) return decision;
            const messages = Array.isArray(decision.messages) ? [...decision.messages, makeMessage(text)] : decision.messages;
            return { ...decision, messages };
        } catch {
            // 任何异常都不影响 agent 流程：预算看门狗永不阻断。
            return decision;
        }
    });
}

async function* meterStream(config, options, upstream) {
    // 规范化后只认安全 id：记账用的 sessionId 与工具查询用的 session.id
    // 若形态不同（带/不带 session- 前缀），ledgerFileFor 会解析回同一个文件。
    const sessionId = safeSessionId(options?.sessionId);
    const optModel = String(
        options?.model || options?.modelId || options?.model_id
        || options?.request?.model || options?.request?.modelId
        || options?.provider?.model || ''
    );
    const optProvider = String(options?.provider || options?.request?.provider || '');
    try {
        for await (const chunk of upstream) {
            if (sessionId && chunk && chunk.type === 'usage' && chunk.usage) {
                try {
                    const ledger = loadLedger(config, sessionId);
                    const split = usageSplit(chunk.usage, config);
                    if (config.debugProbe) {
                        try {
                            fs.writeFileSync(path.join(baseHome(config), 'budget-watch', 'probe.json'), JSON.stringify({
                                optionKeys: Object.keys(options || {}),
                                optionModel: optModel,
                                optionProvider: optProvider,
                                usageKeys: Object.keys(chunk.usage || {}),
                                usageSample: chunk.usage,
                            }, null, 2) + '\n', 'utf8');
                        } catch { /* probe 失败不影响记账 */ }
                    }
                    ledger.sessionTotal += split.total;
                    // 每模型三档累计（金钱锚点 + 性价比曲线的原料）。
                    // provider 只作标签桶，永不作为价格键（H 终审缺陷 3）。
                    const key = split.model || optModel
                        || (optProvider ? `provider:${optProvider}` : '?');
                    ledger.models = ledger.models && typeof ledger.models === 'object' ? ledger.models : {};
                    const acc = normalizeMix(ledger.models[key]);
                    acc.hit += split.mix.hit;
                    acc.miss += split.mix.miss;
                    acc.out += split.mix.out;
                    acc.write += split.mix.write;
                    ledger.models[key] = acc;
                    // 双口径累计：直计费模型计 billed，套餐模型计 quota；预算按两者之和评估。
                    if (split.isPlan) ledger.cost.quota += split.quota;
                    else ledger.cost.billed += split.billed;
                    saveLedger(config, ledger);
                } catch {
                    // 记账失败不打断流
                }
            }
            yield chunk;
        }
    } catch (error) {
        throw error;
    }
}
