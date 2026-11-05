// budget-watch · 折算关系源自测：假 api.json、假 fetch、临时目录，不联网。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ratiosFromCost, buildRatios, createRates, normalizeModelName } from '../rates.js';

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`);
}

// —— 1. cost → 相对倍数 ——
const r1 = ratiosFromCost({ input: 0.15, output: 0.6, cache_read: 0.003 });
check('ratios: hit=0.02 miss=1 out=4', Math.abs(r1.hit - 0.02) < 1e-9 && r1.miss === 1 && Math.abs(r1.out - 4) < 1e-9);
check('ratios: cache_write 缺省按 miss=1', r1.write === 1);
check('ratios: 有 cache_write 时取比例', ratiosFromCost({ input: 2, output: 8, cache_read: 0.5, cache_write: 3 }).write === 1.5);
check('ratios: 缺 input → null', ratiosFromCost({ output: 1 }) === null);
check('ratios: input=0 → null', ratiosFromCost({ input: 0, output: 1 }) === null);

// —— 2. 目录构建：优先级、一致、冲突 ——
const api = {
    deepseek: { models: { 'deepseek-flash': { cost: { input: 1, output: 4, cache_read: 0.02 }, canonical_model_id: 'deepseek-flash' } } },
    other: { models: { 'deepseek-flash': { cost: { input: 2, output: 10, cache_read: 0.1 } } } },
    toy: { models: { 'toy-1': { cost: { input: 1, output: 2, cache_read: 0.01 } } } },
    toy2: { models: { 'toy-1': { cost: { input: 1, output: 2, cache_read: 0.01 } } } },
    bad: { models: { 'clash-1': { cost: { input: 1, output: 2 } } } },
    bad2: { models: { 'clash-1': { cost: { input: 1, output: 9 } } } },
};
const built = buildRatios(api);
check('build: 首选 deepseek 的报价', built.byModel.get('deepseek-flash').out === 4);
check('build: 多 provider 一致时收录', built.byModel.get('toy-1').out === 2);
check('build: 报价冲突 → 记冲突且不收录', built.conflicts.has('clash-1') && !built.byModel.has('clash-1'));

// —— 3. 名字归一 ——
check('normalize: 去 provider 前缀', normalizeModelName('OpenAI/GPT-4o') === 'gpt-4o');
check('normalize: 空白', normalizeModelName('  DeepSeek-Flash ') === 'deepseek-flash');

// —— 4. 源：缓存往返 + 冲突 + 离线 ——
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-rates-'));
let calls = 0;
const fakeFetch = async () => { calls++; return { ok: true, status: 200, json: async () => api }; };
const s1 = createRates({ dir, fetchImpl: fakeFetch, ttlHours: 24 });
s1.load();
await s1.refresh();
check('source: 刷新成功', s1.state().status === 'ready' && s1.size > 0, JSON.stringify(s1.state()));
check('source: lookup 命中', (s1.lookup('deepseek-flash') || {}).out === 4);
check('source: 冲突模型返回 null', s1.lookup('clash-1') === null);
check('source: 未知模型返回 null', s1.lookup('nope') === null);
check('source: 缓存文件已写', fs.existsSync(path.join(dir, 'rates-cache.json')));

const s2 = createRates({ dir, fetchImpl: async () => { throw new Error('offline'); }, ttlHours: 24 });
s2.load();
check('source: 缓存热启动不联网', s2.size > 0 && s2.lookup('deepseek-flash') !== null);

const s3 = createRates({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'bw-rates-')), fetchImpl: async () => { throw new Error('offline'); } });
await s3.refresh();
check('source: 拉取失败标记 error', s3.state().status === 'error' && s3.lookup('deepseek-flash') === null);

const s4 = createRates({ dir: '', disabled: true });
s4.load();
await s4.refresh();
check('source: disabled 不触网', s4.state().status === 'off' && calls === 1);

fs.rmSync(dir, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`
RESULT rates.test: total=${results.length} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
