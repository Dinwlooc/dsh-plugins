import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-test-'));
process.env.DSH_HOME = TEST_HOME;

const { apply, compareVersions, buildReport } = await import('../index.js');

const results = [];
const check = (name, ok, detail) => {
    results.push({ name, ok });
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  :: ' + detail : ''));
};

check('0.2.1-rc.4 < 0.2.1-rc.5', compareVersions('0.2.1-rc.4', '0.2.1-rc.5') < 0);
check('0.2.1-rc.5 < 0.2.1 stable', compareVersions('0.2.1-rc.5', '0.2.1') < 0);
check('0.2.0 < 0.2.1-rc.1', compareVersions('0.2.0', '0.2.1-rc.1') < 0);

let hits = 0;
globalThis.fetch = async () => {
    hits++;
    return {
        ok: true,
        async json() {
            return [
                { tag_name: 'dsh-v0.2.1-rc.3', published_at: '2026-10-23T00:00:00Z', body: '- older' },
                { tag_name: 'dsh-v0.2.1-rc.5', published_at: '2026-10-30T00:00:00Z', body: '### Improvements\n- Improve thinking display.\n- Second item.\n- Third.\n- Fourth.\n- Fifth.' },
                { tag_name: 'not-a-version', published_at: '', body: '' },
            ];
        },
    };
};
const first = await buildReport({ current: '0.2.1-rc.3' });
check('fetch filters non-version tags', first.newest === '0.2.1-rc.5', String(first.newest));
check('fetch counts how far behind', first.behind === 1, String(first.behind));
check('entries carry structured bullets', Array.isArray(first.entries[0].bullets) && first.entries[0].bullets[0].includes('Improve thinking display'));
check('bullets are capped at 4', first.entries[0].bullets.length === 4, 'n=' + first.entries[0].bullets.length);
check('report carries no rendered text', typeof first.entries[0].body === 'undefined');
const second = await buildReport({ current: '0.2.1-rc.3' });
check('second call is served from cache', second.cached === true && hits === 1, 'fetches=' + hits);
check('cache file written under DSH_HOME', fs.existsSync(path.join(TEST_HOME, 'release-notes', 'cache.json')));

const routes = [];
const tools = [];
let effectRan = false;
const ctx = {
    webServer: { register: (spec) => { routes.push(spec); return () => {}; } },
    tools: { register: (tool) => { tools.push(tool); return () => {}; } },
    effect: (fn) => { effectRan = true; return fn(); },
};
apply(ctx);
check('apply registers no model tool', tools.length === 0, 'tools=' + tools.length);
// 锚定：面板端点存在且有处理函数（客户端用一个前缀路由收全部 /release-notes/*）。
// 路由条数是形状——设置旋钮端点（/api/release-notes/config）是后加的能力，不算需求变化。
const prefixRoute = routes.find((r) => r.path === '/release-notes');
check('release-notes prefix route registered', prefixRoute !== undefined, JSON.stringify(routes.map((r) => r.path)));
check('route is a prefix route with a handler', prefixRoute.kind === 'prefix' && typeof prefixRoute.handler === 'function');
// 唯一性是需求边界，不是形状：同一端点被注册两次（两套引擎并存时踩过）必须红。
check('prefix route path registered exactly once', routes.filter((r) => r.path === '/release-notes').length === 1, JSON.stringify(routes.map((r) => r.path)));
check('route registration runs inside ctx.effect', effectRan === true);

const callHandler = async (url, method) => {
    const out = { status: 0, body: '' };
    const res = { writeHead(status) { out.status = status; }, end(body) { out.body = body; } };
    await prefixRoute.handler({ url, method }, res);
    return out;
};
const ok = await callHandler('/release-notes/api/report', 'GET');
check('GET report returns 200 JSON', ok.status === 200 && JSON.parse(ok.body).newest === '0.2.1-rc.5', 'status=' + ok.status);
check('unknown path returns 404', (await callHandler('/release-notes/api/nope', 'GET')).status === 404);
check('POST returns 405', (await callHandler('/release-notes/api/report', 'POST')).status === 405);


// 面板位置契约（2026-10-30）：客户端必须注册 conversation.view（与 Chat/Trajectory/X-Ray 同排），
// 不是 settings.section。有人改回设置页时这条会 FAIL。
{
    const captured = {};
    globalThis.window = { __ModuleLoader__: { load: (m) => { captured.m = m; } } };
    globalThis.document = { documentElement: { getAttribute: () => 'zh-CN' } };
    await import('../client.js');
    const mod = captured.m.factory((name) => {
        if (name !== 'react') throw new Error('unexpected require ' + name);
        return {
            createElement: (type, props, ...kids) => ({ type, props, kids }),
            useState: (v) => [v, () => {}],
            useCallback: (f) => f,
            useEffect: () => {},
        };
    });
    const regs = [];
    const injections = [];
    mod.apply({
        slots: {
            inject: (name, fn) => { injections.push(name); fn(); },
            register: (def, comp) => { regs.push({ def, comp }); return () => {}; },
        },
    });
    // 锚定 2026-10-30 Owner 裁定：更新日志页签必须挂在 conversation.view（与 Chat/Trajectory/X-Ray 同排），
    // 不在 settings.section。设置旋钮是另一块面板，不改变这条契约——所以按 name 找页签，不数注册条数。
    const viewReg = regs.find((r) => r.def && r.def.name === 'conversation.view');
    check('client registers into conversation.view', viewReg !== undefined, JSON.stringify(injections));
    check('conversation.view slot is injected', injections.includes('conversation.view'));
    check('view id/order/label', viewReg !== undefined && viewReg.def.id === 'release-notes' && viewReg.def.order === 30 && viewReg.def.label() === '更新日志');
    const el = viewReg.comp({});
    check('panel renders a view wrapper', el !== undefined && typeof el.type === 'function');
}

const failed = results.filter((r) => !r.ok).length;
console.log('\nRESULT dsh-release-notes: pass=' + (results.length - failed) + ' fail=' + failed);
process.exit(failed === 0 ? 0 : 1);
