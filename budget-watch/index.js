// dsh-budget-watch（原名 nfm-budget-watch）— DSH 只提醒、不中断的 token 预算看门狗。
//
// 口径（Owner 2026-10-25 修订）：预算不按 provider 原始总值计，而按「计费消费 + 套餐消费」之和评估——
//   · 直计费模型（如 Deepseek）：未命中缓存输入 + 输出（billed）；
//   · 套餐总量模型（如 GLM）：输入+输出+缓存读写全量（quota，模型名含 planModelHints 即判）。
// 每一笔 Owner 发放（"+tok"）都从当前实际示数重计：granted=本次发放额，忽略超额与余额，无追加语义。
// 默认预算经验值 1M tok（原 10M 是 Deepseek 时代经验值，弃用）。
// 设计红线：永不 reject、永不 throw、永不拦工具——只在下一个请求前追加一条很短的 developer 消息。
//
// 记账来源：包装 `llm/stream` 观察 provider 的 usage chunk（带 sessionId 的请求）。
// 零依赖：不 import @deepseek-ai/*（link 安装的 profile 解析不到 peer 依赖）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRates } from './rates.js';
import { MESSAGES, render } from './messages.js';
import { overlayStored, handleSettings } from './settings.js';

export const name = 'budget-watch';
export const inject = ['tools', 'webServer'];

const DEFAULT_THRESHOLDS = [0.6, 1.0];

const DEFAULTS = Object.freeze({
    enabled: true,
    thresholds: DEFAULT_THRESHOLDS,
    remindUnregistered: false,
    // 自动发放（Owner 2026-11-01）：新会话自动按默认额度登记；超量后连续两轮（turn，不是 step）
    // 没有新的 budget_register，就在下一轮开头再自动登记一次。把「忘了发放」变成一次自动兜底。
    autoRegister: true,
    autoRegisterTokens: 100_000,
    // 面板：被视为「有编辑效果」的工具（首次命中即记冷启动折算值），以及单步占冷启动的比例阈值。
    panelEdits: Object.freeze(['write', 'edit', 'tool_search', 'tool_describe', 'tool_call']),
    panelThresholds: Object.freeze([0.05, 0.10]),
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
    // 时段因子（Owner 2026-10-30）：按缓存档位分别乘在价格上，用于闲时/忙时折算。
    // 计权单位是「等效未命中 token」，因此因子只影响折算比例，不改 token 计数。
    timeFactors: { hit: 1, miss: 1, out: 1 },
    // USD → CNY 换算率（仅文档用；上表已是人民币）
    usdToCny: 7.1,
    // 折算关系源（Owner 2026-11-06）：绝对值不入账，只取 models.dev 给的相对倍数。
    // config.prices 命中时优先于它；两者都没有才退回 defaultRates（flash 比例）。
    ratesUrl: 'https://models.dev/api.json',
    ratesRefreshHours: 24,
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

    cfg.autoRegister = cfg.autoRegister !== false;
    const autoTokens = Number(cfg.autoRegisterTokens);
    cfg.autoRegisterTokens = Number.isSafeInteger(autoTokens) && autoTokens > 0
        ? autoTokens
        : DEFAULTS.autoRegisterTokens;

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
        cost: { billed: 0, quota: 0, weighted: 0 },
        models: {},
        task: null,
        unregisteredNotified: false,
        // 自动发放的轮次计数：lastTurn 本轮号，overTurn 超量首次出现的轮号，dry 超量后没有登记的轮数。
        auto: { lastTurn: 0, overTurn: 0, dry: 0 },
        updatedAt: null,
        // 每次 provider 调用的「预算单位」增量（直计费=billed，套餐=quota），最近 12 笔。
        // 存在的理由：累计值只能告诉你「用了多少坐标」，看不出「哪一次烧得凶」。
        burn: [],
        // 记忆循环面板：coldStart=首次编辑类调用时的折算值(分母)，prev=上一步折算值，stepPct=本步占比。
        loop: { coldStart: null, prev: null, prevHit: null, stepPct: null, announced: {} },
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

/** 某档位的时段因子；非法值退回 1（绝不因为配置写错而让记账失败）。 */
function factorOf(config, tier) {
    const tf = config.timeFactors;
    if (!tf || typeof tf !== 'object') return 1;
    const value = Number(tf[tier]);
    return Number.isFinite(value) && value > 0 ? value : 1;
}

/** 绝对费率 → 相对 miss 的倍数；折算只认比例，币种与每百万单位在相除时抵消。 */
function ratiosOfRates(rates) {
    const miss = Number(rates && rates.miss);
    if (!(miss > 0)) return null;
    return {
        hit: Number(rates.hit) / miss,
        miss: 1,
        out: Number(rates.out) / miss,
        write: 1,
    };
}

/**
 * 折算关系：config.prices 明示 > models.dev 相对价 > null（调用方退回 defaultRates）。
 * 只看倍数，不看绝对值（Owner 2026-11-06）。
 */
function ratioOf(config, model) {
    const rates = ratesOf(config, model);
    if (rates && rates.subscription) return null;
    if (rates !== null) return ratiosOfRates(rates);
    const book = config.rates;
    if (book && typeof book.lookup === 'function') {
        const found = book.lookup(model);
        if (found) return found;
    }
    return null;
}

/**
 * 计权：把 hit/miss/out/write 全部折算成「等效未命中缓存 token」（Owner 2026-10-30）。
 *   W = 加权金额 / miss 单价   → miss 恒为 1，其余按价格比例折算，时段因子只改比例。
 * 订阅模型不可折算，返回 null（由调用方按 quota 计）。
 */
function weightedOf(config, mix, model) {
    const rates = ratesOf(config, model);
    if (rates && rates.subscription) return null;
    const use = ratioOf(config, model) || ratiosOfRates(config.defaultRates);
    if (use === null) return null;
    const fh = factorOf(config, 'hit');
    const fm = factorOf(config, 'miss');
    const fo = factorOf(config, 'out');
    const missRate = use.miss * fm;
    if (!(missRate > 0)) return null;
    const amount = (mix.hit / 1e6) * use.hit * fh
        + (mix.miss / 1e6) * use.miss * fm
        + (mix.write / 1e6) * use.miss * fm
        + (mix.out / 1e6) * use.out * fo;
    return Math.round((amount / (missRate / 1e6)));
}

/** 同一折算口径，只取「命中缓存」那一档：W_hit = hit 金额 / miss 单价。 */
function hitWeightedOf(config, mix, model) {
    const rates = ratesOf(config, model);
    if (rates && rates.subscription) return null;
    const use = ratioOf(config, model) || ratiosOfRates(config.defaultRates);
    if (use === null) return null;
    const missRate = use.miss * factorOf(config, 'miss');
    if (!(missRate > 0)) return null;
    const amount = (mix.hit / 1e6) * use.hit * factorOf(config, 'hit');
    return Math.round(amount / (missRate / 1e6));
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
        weighted: Number.isSafeInteger(raw.weighted) && raw.weighted >= 0 ? raw.weighted : 0,
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
        baselineWeighted: Number.isSafeInteger(value.baselineWeighted) && value.baselineWeighted >= 0 ? value.baselineWeighted : 0,
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
        auto: normalizeAuto(value.auto),
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
        burn: Array.isArray(value.burn)
            ? value.burn.filter((n) => Number.isFinite(n) && n >= 0).slice(-12)
            : [],
    };
}

const ledgerCache = new Map(); // 账本文件路径 -> ledger（两种会话 id 形态解析到同一文件时不分裂）

/** 只读：账本不存在就返回 null，绝不顺手建空账本（面板轮询会污染别的会话）。 */
function peekLedger(config, sessionId) {
    try {
        const file = ledgerFileFor(config, sessionId);
        if (!fs.existsSync(file)) return null;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed !== null && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

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
    // 两种 provider 字段语义并存（2026-10-30 实测）：
    //   · 分离式：inputTokens 只算未命中，totalTokens = input + cacheRead + output + write
    //     （DeepSeek 实测：20873516 = 134724 + 20604672 + 134120，逐事件成立）；
    //   · 包含式：inputTokens 已含 cacheRead，totalTokens = input + output + write。
    // 旧实现一律按包含式取 max(0, input - cacheRead)：遇到分离式时几乎每步都被夹成 0，
    // 本会话漏记 124,515 未命中（真实 134,724，记成 10,209）。用 totalTokens 同一性判别。
    const totalReported = Number(u.totalTokens);
    const disjoint = Number.isFinite(totalReported) && totalReported > 0
        && Math.abs(totalReported - (input + cacheRead + output + cacheWrite)) <= 1;
    const uncached = Number.isFinite(Number(u.uncachedInputTokens))
        ? Number(u.uncachedInputTokens)
        : disjoint
            ? input
            : Math.max(0, input - cacheRead);
    // provider 报的 totalTokens 优先；它缺席（老 fixture / 老路由）时退回旧公式。
    const totalTokens = Number.isFinite(totalReported) && totalReported > 0
        ? totalReported
        : input + output + cacheRead + cacheWrite;
    return {
        billed: uncached + output,
        quota: totalTokens,
        total: totalTokens,
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

/** 阈值文案分层：>=1 中止文件输出；>=0.6 压缩步数；其余走通用提醒（兼容自定义阈值）。 */
function warningText(used, crossed = []) {
    const formatted = String(Math.max(0, Math.round(used))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const top = Math.max(0, ...crossed);
    if (top >= 1) return render(MESSAGES.warnStop, { used: formatted });
    if (top >= 0.6) return render(MESSAGES.warnAccelerate, { used: formatted });
    return render(MESSAGES.warnThreshold, { used: formatted });
}

/**
 * 提醒不动用户的发言通道：写成 developer/message（role=developer），由会话 surface 承接，
 * GUI 里是开发/上下文行，模型照样在下一步读到。事件必须带 surfaceOp:'append'。
 * 旧实现往 decision.messages 里塞 role:'user'/source:{kind:'user'} 的消息，等于冒充 Owner 说话。
 *
 * 写入时机是硬约束：V4 校验器（dsh-session-persistence-jsonl 的 Relationships.requireStep）
 * 要求 developer/message 落在已打开的 turn+step 里，日志顺序必须是 step/start -> developer/message。
 * 所以本插件只在 agent/request 时刻写入——agent loop 在 step() 内触发它，此刻 step/start 已落盘。
 * 写回 agent/pre-step 就是顺序违规：运行时 session.append 不校验、当场无感，重启加载历史时报
 * "developer/message does not match an open turn and step"，该会话从此 history unavailable。
 */
function developerNotice(text) {
    return {
        role: 'developer',
        id: crypto.randomUUID(),
        content: [{ type: 'text', text }],
        source: { kind: 'cordis-host-runner' },
    };
}

function emitNotice(agent, turn, step, text) {
    const session = agent?.session;
    if (!session || typeof session.append !== 'function') return false;
    // 坐标未知或非法就不写：宁可这一步不提醒，也不伪造 turn/step 制造格式违规。
    if (!Number.isInteger(turn) || !Number.isInteger(step) || turn < 1 || step < 1) return false;
    try {
        session.append('developer/message', {
            turn,
            step,
            message: developerNotice(text),
        }, { surfaceOp: 'append' });
        return true;
    } catch {
        return false;
    }
}

function pctOf(part, whole) {
    return whole > 0 ? `${Math.round((100 * part) / whole)}%` : 'n/a';
}

/**
 * 一行金额速览：¥ 总额（归因不足时才追加 attr%）+ 前两名模型的 hit/miss/out 占比与折算价。
 * 输出预算（Owner 2026-10-29）：它是给模型的 token 钟，不是账单——单价表、legacy 明细、
 * 订阅单列说明都是静态/边缘信息，不再每次回显。
 */
function moneyLine(config, models, sessionTotal) {
    const m = moneyOf(config, models);
    if (m.rows.length === 0) return null;
    const denominator = Math.max(Number(sessionTotal) || 0, m.total);
    const parts = [`money≈${fmtYuan(m.cost)}`];
    if (m.attributedTokens < denominator) parts.push(`attr ${pctOf(m.attributedTokens, denominator)}`);
    if (m.subscriptionTokens > 0) parts.push(`subscription ${fmt(m.subscriptionTokens)}`);
    return parts.join(' ');
}

function shortSession(id) {
    const s = String(id || 'unknown');
    return s.length > 18 ? `${s.slice(0, 18)}…` : s;
}

/**
 * 峰值感知：把「累计坐标」补成「这一次花了多少、窗口里最凶的一次有多凶」。
 * burst = peak / median（同一窗口内），≥3 表示有明显尖峰，模型据此判断是不是自己刚刚
 * 一口气读了太多东西。窗口 12 笔，与 ledger.burn 同源。
 */
function burnSummary(burn) {
    const list = Array.isArray(burn) ? burn.filter((n) => Number.isFinite(n) && n >= 0) : [];
    if (list.length === 0) return null;
    const peak = Math.max(...list);
    const sorted = [...list].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return {
        last: list[list.length - 1],
        peak,
        idx: list.indexOf(peak) + 1,
        n: list.length,
        burst: median > 0 ? Math.round((peak / median) * 10) / 10 : 0,
    };
}

function statusText(ledger, config) {
    const models = ledger.models && typeof ledger.models === 'object' ? ledger.models : {};
    const lines = [];
    if (!ledger.task) {
        lines.push(render(MESSAGES.statusUnregistered, { session: ledger.sessionId, total: fmt(ledger.sessionTotal) }));
    } else {
        const base = normalizeCost(ledger.task.baselineCost);
        const used = Math.max(0, ledger.cost.weighted - (ledger.task.baselineWeighted || 0))
            + Math.max(0, ledger.cost.quota - base.quota);
        const pct = `${((used / ledger.task.granted) * 100).toFixed(1)}%`;
        lines.push(render(MESSAGES.statusRegistered, {
            granted: fmt(ledger.task.granted),
            used: fmt(used),
            remaining: fmt(Math.max(0, ledger.task.granted - used)),
            pct,
        }));
    }
    const money = moneyLine(config, models, ledger.sessionTotal);
    if (money) lines.push(money);
    if (Array.isArray(config.warnings) && config.warnings.length > 0) lines.push(render(MESSAGES.statusWarning, { warnings: config.warnings.join('; ') }));
    return lines.join('\n');
}

function resolveSessionId(args, exec) {
    if (args && args.sessionId !== undefined) {
        const explicit = safeSessionId(args.sessionId);
        if (!explicit) return { error: MESSAGES.errSessionIdInvalid };
        return { id: explicit, explicit: true };
    }
    const own = safeSessionId(exec?.agent?.session?.id);
    if (!own) return { error: MESSAGES.errNoSession };
    return { id: own, explicit: false };
}

/** 超量后要连续多少轮没有新的登记，才自动补发一次。 */
const AUTO_DRY_ROUNDS = 2;

/** 自动发放计数：坏值一律归零，绝不让它挡住预算判定。 */
function normalizeAuto(value) {
    const src = value && typeof value === 'object' ? value : {};
    const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
    return { lastTurn: int(src.lastTurn), overTurn: int(src.overTurn), dry: int(src.dry) };
}

/** 本次发放区间内已用的预算单位（重计基线之后；直计费 + 套餐两口径之和）。 */
function usedOf(ledger) {
    const base = normalizeCost(ledger?.task?.baselineCost);
    return Math.max(0, ledger.cost.weighted - (ledger?.task?.baselineWeighted || 0))
        + Math.max(0, ledger.cost.quota - base.quota);
}

/**
 * 登记一笔发放。Owner 规则：从当前实际示数重计，granted=本次发放额，忽略超额与余额，无追加语义。
 * 工具与自动发放共用这一份实现——两条路径写出的账本形状必须一致。
 * @param ledger - 已加载的账本（就地修改）。
 * @param tokens - 发放额（raw token）。
 * @param note - 来源标注（自动发放写 auto:…，便于回读区分）。
 * @returns 新的 task 记录。
 */
function applyGrant(ledger, tokens, note) {
    const at = new Date().toISOString();
    const grant = {
        id: crypto.randomUUID(),
        tokens,
        at,
        note: typeof note === 'string' ? note.slice(0, 200) : '',
    };
    ledger.task = {
        id: crypto.randomUUID(),
        startedAt: at,
        baselineUsed: ledger.sessionTotal,
        baselineWeighted: ledger.cost.weighted,
        baselineCost: normalizeCost(ledger.cost),
        granted: tokens,
        grants: [...(ledger.task?.grants ?? []).slice(-9), grant],
        announced: {},
    };
    ledger.unregisteredNotified = true;
    ledger.auto = { ...normalizeAuto(ledger.auto), overTurn: 0, dry: 0 };
    return ledger.task;
}

function createRegisterTool(ctx, config) {
    return {
        name: 'budget_register',
        description:
            'Register the token budget the Owner just granted (raw tokens; 1M = 1000000). Call once per grant. '
            + 'Every grant re-baselines from the current reading: granted = this grant, no top-up. '
            + 'Ledgers are per session (this call writes the calling session); pass sessionId only to target another session explicitly. '
            + 'Meter = weighted miss-equivalents (every tier folded through the price table, time factors included) plus quota for plan models; sub-agent spend may leak in.',
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
            // Owner 规则：每一笔 "+tok" 都从当前实际示数重计，忽略超额与余额——没有追加语义。
            // 显式登记同时清掉自动发放的轮次计数：模型已经补登，自动兜底不该再插一脚。
            applyGrant(ledger, tokens, args?.note);
            saveLedger(config, ledger);
            const used = usedOf(ledger);
            const scope = target.explicit ? '（显式指定）' : '';
            return `[budget-watch] session=${ledger.sessionId}${scope} 已登记（重计）granted=${fmt(ledger.task.granted)} used=${fmt(used)} remaining=${fmt(Math.max(0, ledger.task.granted - used))}。`;
        },
    };
}

function createStatusTool(ctx, config) {
    return {
        name: 'budget_status',
        description:
            'One-session token clock: granted/used/remaining/pct for the task budget, plus one ¥ line. Read-only; defaults to the calling session. '
            + 'Pass sessionId only to inspect another session (e.g. a sub-agent ledger). Check it before wrapping up or asking for more budget.',
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


/** 面板路由：纯 GUI，不注册任何模型面工具。 */
export const PANEL_ROUTE = '/api/budget-watch/panel';

function loopOf(ledger) {
    if (ledger === null || typeof ledger !== 'object') return { coldStart: null, prev: null, stepPct: null, announced: {} };
    if (ledger.loop === undefined || ledger.loop === null || typeof ledger.loop !== 'object') {
        ledger.loop = { coldStart: null, prev: null, prevHit: null, stepPct: null, announced: {} };
    }
    if (ledger.loop.announced === undefined) ledger.loop.announced = {};
    return ledger.loop;
}

/** 当前折算总量（直计费加权 + 套餐量），与预算提醒同一口径。 */
function meterOf(ledger) {
    const cost = ledger && ledger.cost ? ledger.cost : {};
    return Math.max(0, Number(cost.weighted) || 0) + Math.max(0, Number(cost.quota) || 0);
}

/**
 * 守卫：第一次出现「有编辑效果」的工具调用时，把当前折算值记成冷启动基准。
 * 之后每一步的折算增量除以它，就是「单步记忆循环消耗占冷启动的百分比」。
 */
export function panelOnGuard(config, agent) {
    const edits = Array.isArray(config.panelEdits) ? config.panelEdits : DEFAULTS.panelEdits;
    return (exec) => {
        try {
            const name = typeof exec?.name === 'string' ? exec.name : '';
            if (!edits.includes(name)) return undefined;
            const sessionId = sessionIdOf(exec?.agent);
            if (!sessionId || sessionId === 'unknown') return undefined;
            const ledger = loadLedger(config, sessionId);
            const loop = loopOf(ledger);
            if (loop.coldStart === null) {
                // 冷启动一次的花费 = 「从本次预算发放（任务起点）到第一次动工」这段时间的折算增量。
                const base = Number(ledger.task && ledger.task.baselineWeighted);
                const fromTaskStart = meterOf(ledger) - (Number.isFinite(base) ? base : 0);
                loop.coldStart = fromTaskStart > 0 ? fromTaskStart : meterOf(ledger);
                loop.prev = loop.coldStart;
                loop.stepPct = null;
                saveLedger(config, ledger);
            }
        } catch {
            // 面板统计失败绝不影响工具执行。
        }
        return undefined;
    };
}

/** 每步结束：算本步折算增量占冷启动的比例，跨 5% / 10% 时各提醒一次。 */
export function loopOnRequest(config, agent, turn, step) {
    const sessionId = sessionIdOf(agent);
    if (!sessionId || sessionId === 'unknown') return null;
    const ledger = loadLedger(config, sessionId);
    const loop = loopOf(ledger);
    if (loop.coldStart === null || !(loop.coldStart > 0)) return null;
    // Owner 2026-11-04：分子 = 本步「缓存读取值本身」（折算后），不是新增量；分母 = 冷启动基准。
    const hit = Math.max(0, Number(loop.lastHit) || 0);
    loop.prev = meterOf(ledger);
    loop.stepHit = hit;
    loop.stepHitTokens = Math.max(0, Number(loop.lastHitTokens) || 0);
    loop.stepPct = loop.stepHit / loop.coldStart;
    const thresholds = Array.isArray(config.panelThresholds) ? config.panelThresholds : DEFAULTS.panelThresholds;
    const crossed = thresholds.filter((t) => loop.stepPct >= t && !loop.announced[String(t)]);
    saveLedger(config, ledger);
    if (crossed.length === 0) return null;
    const pct = (loop.stepPct * 100).toFixed(1);
    const top = Math.max(...crossed);
    const text = top >= 0.10
        ? render(MESSAGES.panelStop, { pct })
        : render(MESSAGES.panelStep, { pct });
    if (!emitNotice(agent, turn, step, text)) return null;
    for (const t of crossed) loop.announced[String(t)] = true;
    saveLedger(config, ledger);
    return text;
}

/** 会话标题栏面板要的唯一一份状态。 */
/** 最近 5 分钟内被写过的会话数，用于判断「最近活跃」是否足以代表当前页面。 */
function recentLedgerSessions(config) {
    try {
        const dir = ledgerDir(config);
        const now = Date.now();
        let count = 0;
        for (const name of fs.readdirSync(dir)) {
            if (!name.endsWith('.json')) continue;
            const full = path.join(dir, name);
            try { if (now - fs.statSync(full).mtimeMs < 5 * 60 * 1000) count += 1; } catch { /* 忽略 */ }
        }
        return count;
    } catch {
        return 0;
    }
}

export function panelState(config, sessionId) {
    const ledger = peekLedger(config, sessionId);
    if (ledger === null) return { ok: false, reason: 'no-ledger', sessionId };
    const loop = loopOf(ledger);
    const task = ledger.task || null;
    const used = task
        ? Math.max(0, ledger.cost.weighted - (task.baselineWeighted || 0)) + Math.max(0, (ledger.cost.quota || 0) - (Number(task.baselineCost && task.baselineCost.quota) || 0))
        : 0;
    return {
        ok: true,
        sessionId,
        coldStart: loop.coldStart,
        stepHit: Number(loop.stepHit) || 0,
        stepHitTokens: Number(loop.stepHitTokens) || 0,
        stepPct: loop.stepPct,
        granted: task ? task.granted : null,
        used: Math.round(used),
        budgetPct: task && task.granted > 0 ? used / task.granted : null,
        level: loop.stepPct === null ? 'idle' : loop.stepPct >= 0.10 ? 'stop' : loop.stepPct >= 0.05 ? 'warn' : 'ok',
        config: {
            autoRegister: config.autoRegister !== false,
            autoRegisterTokens: config.autoRegisterTokens,
            thresholds: Array.isArray(config.thresholds) ? config.thresholds : [],
            dryRounds: AUTO_DRY_ROUNDS,
        },
    };
}

/**
 * 浏览器没有 slot props 时，从请求本身认会话：页面地址(referer)或 cookie 里的 UUID，
 * 并且必须能在账本目录里找到同名文件——宁可认不出，也不猜。
 */
function sessionFromRequest(config, req) {
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const candidates = [];
    const headers = (req && req.headers) || {};
    if (typeof headers.referer === 'string') candidates.push(headers.referer);
    if (typeof headers.cookie === 'string') candidates.push(headers.cookie);
    if (typeof headers.origin === 'string') candidates.push(headers.origin);
    for (const raw of candidates) {
        const match = raw.match(uuid);
        if (!match) continue;
        const id = match[0].toLowerCase();
        try {
            if (fs.existsSync(ledgerFileFor(config, id))) return id;
        } catch { /* 继续找下一个来源 */ }
    }
    return null;
}

export function createPanelHandler(config) {
    return (req, res) => {
        try {
            const url = new URL(String(req?.url || '/'), 'http://localhost');
            const explicit = url.searchParams.get('session') || sessionFromRequest(config, req);
            const sessionId = explicit || lastActiveSessionId || 'unknown';
            // 多会话时不允许用「最近活跃」冒充：宁可说不知道，也不串会话的示数。
            if (!explicit && recentLedgerSessions(config) > 1) {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                res.end(JSON.stringify({ ok: false, reason: 'ambiguous-session', candidates: recentLedgerSessions(config) }));
                return;
            }
            const body = JSON.stringify(panelState(config, sessionId));
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(body);
        } catch (error) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }));
        }
    };
}

export const SETTINGS_FIELDS = Object.freeze([
    { key: 'enabled', type: 'boolean', label: '总开关', hint: '关掉后不发阈值提醒、不自动发放；工具与面板仍在。' },
    { key: 'autoRegister', type: 'boolean', label: '自动发放', hint: '新会话自动登记一次；超量后连续两轮无登记再补发。' },
    { key: 'autoRegisterTokens', type: 'number', min: 1000, max: 10000000, label: '自动发放额度', hint: 'raw token，默认 100000。' },
    { key: 'thresholds', type: 'numberList', min: 0, max: 1, label: '提醒阈值', hint: '如 0.6,1.0 —— 占已发放额度的比例。' },
    { key: 'remindUnregistered', type: 'boolean', label: '未登记提醒', hint: '没有预算登记时也提醒。' },
    { key: 'debugProbe', type: 'boolean', label: '调试探针', hint: '额外诊断输出。' },
    { key: 'panelThresholds', type: 'numberList', min: 0, max: 1, label: '面板阈值', hint: '单步占冷启动的比例阈值。' },
    { key: 'panelEdits', type: 'stringList', label: '编辑类工具', hint: '首次命中即记冷启动基准的工具名。' },
    { key: 'planModelHints', type: 'stringList', label: '套餐模型', hint: '模型名含这些子串时按套餐总量计费。' },
]);

export function apply(ctx, rawConfig) {
    const config = normalizeConfig(rawConfig);
    overlayStored('budget-watch', SETTINGS_FIELDS, config);

    // 折算关系源：先用磁盘缓存顶上，缓存过期才在后台刷新。任何失败都退回 config.prices。
    // 绝不 await、绝不进入 llm/stream 路径——记账永远是同步的。
    try {
        const rates = createRates({
            dir: ledgerDir(config),
            url: typeof config.ratesUrl === 'string' && config.ratesUrl !== '' ? config.ratesUrl : undefined,
            ttlHours: Number(config.ratesRefreshHours),
            disabled: process.env.DSH_BUDGET_WATCH_OFFLINE === '1',
            log: () => {},
        });
        config.rates = rates;
        rates.load();
    }
    catch {
        // 折算源不可用时保持 config.prices / defaultRates 的老口径。
    }

    ctx.tools.register(createRegisterTool(ctx, config));
    ctx.tools.register(createStatusTool(ctx, config));

    // 面板：编辑类工具首次出现即记冷启动基准（纯 GUI 统计，不向模型暴露任何工具）。
    if (typeof ctx.tools.guard === 'function') ctx.tools.guard(panelOnGuard(config));

    // 计量：观察每次带 sessionId 的流式模型调用的 provider usage。
    ctx.on('llm/stream', (options, next) => meterStream(config, options, next()));

    // 提醒只在 agent/request 时刻写：它在 step() 内部触发，此时 step/start 已落盘，
    // 写出的 developer/message 落在合法打开的 step 里（与 V4 校验器的顺序要求一致）。
    // 放在 agent/pre-step 会写在该 step 打开之前，日志顺序违规，重启后整段历史读不出来。
    ctx.on('agent/request', (payload, next) => {
        try {
            noteActiveSession(payload.agent);
            const autoText = autoBudgetOnRequest(config, payload.agent, payload.turn, payload.step);
            if (autoText !== null) emitNotice(payload.agent, payload.turn, payload.step, autoText);
        } catch {
            // 自动发放失败绝不影响 agent 流程。
        }
        try {
            loopOnRequest(config, payload.agent, payload.turn, payload.step);
            noticeOnRequest(config, payload.agent, payload.turn, payload.step);
        } catch {
            // 任何异常都不影响 agent 流程：预算看门狗永不阻断。
        }
        return next();
    });

    if (typeof ctx.webServer?.register === 'function' && typeof ctx.effect === 'function') {
        ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: PANEL_ROUTE, handler: createPanelHandler(config) }));
        ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/budget-watch/config', handler: (req, res) => handleSettings('budget-watch', SETTINGS_FIELDS, config, req, res) }));
        // 手动重建冷启动基准：把 loop 清空，下一次编辑类/工具检索类调用会按新口径重记。
        ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/budget-watch/reset-loop', handler: (req, res) => {
            try {
                const url = new URL(String(req?.url || '/'), 'http://localhost');
                const sessionId = url.searchParams.get('session');
                if (!sessionId) {
                    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: false, error: 'session query parameter is required' }));
                    return;
                }
                const ledger = loadLedger(config, sessionId);
                ledger.loop = { coldStart: null, prev: null, prevHit: null, stepPct: null, announced: {}, lastHit: null, lastHitTokens: 0, lastWeighted: null };
                saveLedger(config, ledger);
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                res.end(JSON.stringify({ ok: true, sessionId }));
            } catch (error) {
                res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }));
            }
        } }));
    }
}

/**
 * 自动发放（Owner 2026-11-01）。两条规则：
 *  1. 新会话（账本里还没有任何发放）→ 按 autoRegisterTokens 自动登记一次，静默；
 *  2. 超量之后，连续 AUTO_DRY_ROUNDS 轮（turn，不是 step）没有新的 budget_register，
 *     就在下一轮开头的请求里再自动登记一次，并追加一条很短的说明。
 * 计数只在每轮第一次请求时推进：同一轮内的多个 step 不会把轮数刷满。
 * @returns {string|null} 需要追加给模型的说明；静默登记返回 null。
 */
/** 会话头部与设置卡片拿不到 props 时的回退：面板默认服务最近活跃会话。 */
let lastActiveSessionId = 'unknown';

function noteActiveSession(agent) {
    try {
        const sessionId = sessionIdOf(agent);
        if (sessionId !== 'unknown') lastActiveSessionId = sessionId;
    } catch {
        // 回退值不值得影响主流程。
    }
}

function autoBudgetOnRequest(config, agent, turn, step) {
    if (!config.autoRegister) return null;
    if (!Number.isInteger(turn) || turn < 1) return null;
    const sessionId = sessionIdOf(agent);
    if (sessionId === 'unknown') return null;
    const ledger = loadLedger(config, sessionId);
    const auto = normalizeAuto(ledger.auto);

    // 规则 1：新会话，静默按默认额度登记。
    if (!ledger.task) {
        applyGrant(ledger, config.autoRegisterTokens, 'auto: session start');
        auto.lastTurn = turn;
        ledger.auto = auto;
        saveLedger(config, ledger);
        return null;
    }

    if (turn === auto.lastTurn) return null; // 同一轮内的 step 不推进轮次计数
    auto.lastTurn = turn;

    if (usedOf(ledger) < ledger.task.granted) {
        auto.overTurn = 0;
        auto.dry = 0;
        ledger.auto = auto;
        saveLedger(config, ledger);
        return null;
    }
    if (auto.overTurn === 0) {
        // 超量首次出现的这一轮即计入「没有登记的轮」（Owner 2026-11-03：超量轮本身也计入）。
        auto.overTurn = turn;
        auto.dry = 1;
        ledger.auto = auto;
        saveLedger(config, ledger);
        return null;
    }
    if (auto.dry < AUTO_DRY_ROUNDS) {
        auto.dry += 1;
        ledger.auto = auto;
        saveLedger(config, ledger);
        return null;
    }

    // 规则 2：连续 AUTO_DRY_ROUNDS 轮没有新的登记 → 本轮开头自动补发。
    applyGrant(ledger, config.autoRegisterTokens, 'auto: dry rounds');
    auto.lastTurn = turn;
    ledger.auto = auto;
    saveLedger(config, ledger);
    return render(MESSAGES.autoRegistered, {
        rounds: AUTO_DRY_ROUNDS,
        granted: fmt(ledger.task.granted),
    });
}

/**
 * 一次请求开始前检查阈值，需要时写一条 developer/message。
 * 坐标取自当前请求的 turn/step：这两个值对应一个已经打开的 step。
 * 送不出去就不记账（下一步重试），避免「提醒丢了但阈值已标灰」。
 * @param config - 规范化配置。
 * @param agent - 触发本次请求的 Agent（payload.agent 由 agentEvents 融合注入）。
 * @param turn - 本次请求所属 turn。
 * @param step - 本次请求所属 step，必须已打开。
 */
function noticeOnRequest(config, agent, turn, step) {
    if (!config.enabled) return;
    const session = agent?.session;
    if (!session || typeof session.append !== 'function') return;
    const sessionId = sessionIdOf(agent);
    const ledger = loadLedger(config, sessionId);

    let text = null;
    let crossed = [];
    if (ledger.task) {
        const base = normalizeCost(ledger.task.baselineCost);
        const used = Math.max(0, ledger.cost.weighted - (ledger.task.baselineWeighted || 0))
            + Math.max(0, ledger.cost.quota - base.quota);
        crossed = config.thresholds.filter((t) => used / ledger.task.granted >= t && !ledger.task.announced[String(t)]);
        if (crossed.length > 0) text = warningText(used, crossed);
    } else if (config.remindUnregistered && ledger.sessionTotal > 0 && !ledger.unregisteredNotified) {
        text = '[budget-watch] 本会话尚未登记预算。Owner 用自然语言发放后，请调用 budget_register 填报（如 tokens=1000000）；插件只提醒、不中断。';
    }

    if (text === null) return;
    if (!emitNotice(agent, turn, step, text)) return;
    if (ledger.task) {
        for (const t of crossed) ledger.task.announced[String(t)] = true;
    } else {
        ledger.unregisteredNotified = true;
    }
    saveLedger(config, ledger);
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
                    else {
                        ledger.cost.billed += split.billed;
                        const w = weightedOf(config, split.mix, key);
                        if (w !== null) ledger.cost.weighted += w;
                        const wh = hitWeightedOf(config, split.mix, key);
                        if (wh !== null) {
                            ledger.cost.hitWeighted = (Number(ledger.cost.hitWeighted) || 0) + wh;
                            // 「本次请求读了多大的缓存」本身就是该测度的分子：覆盖而不是累加。
                            ledger.loop = ledger.loop || {};
                            ledger.loop.lastHit = wh;
                            ledger.loop.lastHitTokens = Math.max(0, Number(split.mix.hit) || 0);
                            ledger.loop.lastWeighted = w;
                        }
                    }
                    // 峰值感知：这一次调用花了多少预算单位（与预算比较同一单位）。
                    const spend = split.isPlan ? split.quota : split.billed;
                    if (!Array.isArray(ledger.burn)) ledger.burn = [];
                    ledger.burn.push(spend);
                    if (ledger.burn.length > 12) ledger.burn.shift();
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
