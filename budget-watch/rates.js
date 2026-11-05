// budget-watch · 折算关系源：从 models.dev 取各模型的**相对费率**（hit / miss / out / write）。
//
// WHY（Owner 2026-11-06）：折算只需要关系——同一模型三档之间、不同模型之间的倍数。
// 币种、每百万单位、高峰倍率在相除时全部抵消，所以这里**只存比例、不存金额**：
// miss 恒为 1，hit/out/write 是相对 miss 的倍数。绝对价（展示用的 ¥）仍由 config.prices 决定。
//
// 失败即退回：网络不通、结构不符、同模型多 provider 报价冲突 → 一律不入账，
// 调用方继续用 config.prices / defaultRates（绝不编一个数出来）。
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_URL = 'https://models.dev/api.json';
export const CACHE_NAME = 'rates-cache.json';
export const PREFERRED_PROVIDERS = ['deepseek'];

/** models.dev 的一条 cost → 相对 miss 的倍数；缺 input/output 视为不可用。 */
export function ratiosFromCost(cost) {
    if (!cost || typeof cost !== 'object') return null;
    const input = Number(cost.input);
    const output = Number(cost.output);
    if (!(input > 0) || !Number.isFinite(output) || output < 0) return null;
    const read = Number(cost.cache_read);
    // 两种缺省的取向不同：cache_read 缺失会把缓存读算成免费，属编数，整条丢弃；
    // cache_write 缺失按 1（等价于旧的「缓存写按 miss 计价」），是有依据的安全默认。
    const write = Number(cost.cache_write);
    if (!Number.isFinite(read) || read < 0) return null;
    return {
        hit: read / input,
        miss: 1,
        out: output / input,
        write: Number.isFinite(write) && write >= 0 ? write / input : 1,
    };
}

const sameRatios = (a, b) => a.hit === b.hit && a.out === b.out && a.write === b.write;

/**
 * api.json → { byModel: Map<model, ratios>, conflicts: Set<model> }。
 * 同一个 model id 在多个 provider 下出现：优先 PREFERRED_PROVIDERS，
 * 其次只有「所有报价一致」才收录，否则记冲突并丢弃（宁可退回也不猜）。
 */
export function buildRatios(api, options = {}) {
    const preferred = options.preferredProviders ?? PREFERRED_PROVIDERS;
    const byModel = new Map();
    const conflicts = new Set();
    const seen = new Map(); // model → [{provider, ratios}]
    for (const [providerId, provider] of Object.entries(api || {})) {
        const models = provider && typeof provider === 'object' ? provider.models : null;
        if (!models || typeof models !== 'object') continue;
        for (const [modelId, entry] of Object.entries(models)) {
            const ratios = ratiosFromCost(entry && entry.cost);
            if (ratios === null) continue;
            const keys = new Set([String(modelId).toLowerCase()]);
            const canonical = entry && typeof entry.canonical_model_id === 'string' ? entry.canonical_model_id : '';
            if (canonical !== '') keys.add(canonical.toLowerCase());
            for (const key of keys) {
                if (!seen.has(key)) seen.set(key, []);
                seen.get(key).push({ provider: String(providerId).toLowerCase(), ratios });
            }
        }
    }
    for (const [model, rows] of seen) {
        const pickPreferred = rows.find((r) => preferred.includes(r.provider));
        const distinct = rows.filter((r, i) => rows.findIndex((x) => sameRatios(x.ratios, r.ratios)) === i);
        if (pickPreferred) byModel.set(model, pickPreferred.ratios);
        else if (distinct.length === 1) byModel.set(model, distinct[0].ratios);
        else conflicts.add(model);
    }
    return { byModel, conflicts };
}

/** 模型名归一：去 provider 前缀与空白，转小写。 */
export function normalizeModelName(model) {
    return String(model || '')
        .trim()
        .toLowerCase()
        .replace(/^[a-z0-9._-]+\//, '');
}

/**
 * 折算关系源：内存书 + 磁盘缓存 + 单次在飞刷新。
 * 所有网络/磁盘错误都只影响 status，不抛给调用方。
 */
export function createRates(options = {}) {
    const url = options.url || DEFAULT_URL;
    const ttlHours = Number.isFinite(options.ttlHours) && options.ttlHours > 0 ? options.ttlHours : 24;
    const dir = options.dir || '';
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const now = options.now || Date.now;
    const log = typeof options.log === 'function' ? options.log : () => {};
    const cacheFile = dir === '' ? '' : path.join(dir, CACHE_NAME);

    let byModel = new Map();
    let conflicts = new Set();
    let fetchedAt = 0;
    let status = 'idle';
    let lastError = null;
    let inflight = null;

    function adopt(payload) {
        const api = payload && typeof payload === 'object' ? payload : null;
        if (api === null) return false;
        const built = buildRatios(api, { preferredProviders: options.preferredProviders });
        if (built.byModel.size === 0) return false;
        byModel = built.byModel;
        conflicts = built.conflicts;
        return true;
    }

    function readCache() {
        if (cacheFile === '') return false;
        try {
            const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            if (!raw || typeof raw !== 'object' || raw.version !== 1) return false;
            const at = Number(raw.fetchedAt);
            if (!Number.isFinite(at) || at <= 0) return false;
            const map = new Map();
            for (const [model, ratios] of Object.entries(raw.ratios || {})) {
                if (ratios && typeof ratios === 'object' && Number.isFinite(Number(ratios.hit)) && Number.isFinite(Number(ratios.out))) {
                    map.set(model, { hit: Number(ratios.hit), miss: 1, out: Number(ratios.out), write: Number(ratios.write) || 1 });
                }
            }
            if (map.size === 0) return false;
            byModel = map;
            fetchedAt = at;
            status = now() - at < ttlHours * 3600e3 ? 'ready' : 'stale';
            return true;
        }
        catch {
            return false;
        }
    }

    function writeCache() {
        if (cacheFile === '') return;
        try {
            fs.mkdirSync(dir, { recursive: true });
            const ratios = {};
            for (const [model, r] of byModel) ratios[model] = { hit: r.hit, out: r.out, write: r.write };
            fs.writeFileSync(cacheFile, JSON.stringify({ version: 1, fetchedAt, source: url, ratios }, null, 2) + '\n', 'utf8');
        }
        catch (error) {
            log('rates cache write failed: ' + String(error && error.message ? error.message : error));
        }
    }

    async function refresh() {
        if (options.disabled === true) { status = 'off'; return false; }
        if (inflight !== null) return inflight;
        status = 'loading';
        inflight = (async () => {
            try {
                if (typeof fetchImpl !== 'function') throw new Error('no fetch');
                const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
                if (!res || !res.ok) throw new Error('http ' + (res ? res.status : 'none'));
                const api = await res.json();
                if (!adopt(api)) throw new Error('unusable payload');
                fetchedAt = now();
                status = 'ready';
                lastError = null;
                writeCache();
                return true;
            }
            catch (error) {
                lastError = String(error && error.message ? error.message : error);
                if (status !== 'stale') status = byModel.size > 0 ? 'ready' : 'error';
                return false;
            }
            finally {
                inflight = null;
            }
        })();
        return inflight;
    }

    /** 先用缓存顶上，缓存过期或没有缓存就在后台刷新；永不拒绝、永不抛错。 */
    function load() {
        if (options.disabled === true) { status = 'off'; return false; }
        const cached = readCache();
        if (!cached || now() - fetchedAt >= ttlHours * 3600e3) refresh();
        return cached;
    }

    /** 同步查表：命中返回比例，未收录/冲突返回 null（调用方退回 config）。 */
    function lookup(model) {
        if (byModel.size === 0) return null;
        const key = normalizeModelName(model);
        if (key === '') return null;
        if (conflicts.has(key)) return null;
        return byModel.get(key) || null;
    }

    return {
        load,
        refresh,
        lookup,
        get size() { return byModel.size; },
        get fetchedAt() { return fetchedAt; },
        state() { return { status, lastError, fetchedAt, models: byModel.size, conflicts: conflicts.size }; },
    };
}
