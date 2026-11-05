// dsh-prompt-trim — 预设侧的空段遮蔽器。
//
// 目的：把已被工具说明 / 工具返回覆盖的系统提示段移出常驻注入（0014「系统提示段也是工具面」）。
// 机制：dsh-system-prompt 的 assemble() 用 layers.merge(scope, …) 按名字合并各层段，scoped 段
// 遮蔽 global 段（源码注释："A scoped section shadows a global section with the same name"）。
// 本插件挂在 agent preset 里，注册同名空文本段即可让全局段消失。
// 不能改成全局注册：同一层重名会抛 "prompt section ... is already registered"。
export const name = 'dsh-prompt-trim';
export const inject = ['systemPrompt', 'webServer'];

/**
 * 被遮蔽的段。
 * 第二项是 dsh-system-prompt 的 SECTION_ORDERS 放置名（取它让排序位置与原段一致）；
 * 没有放置名的段用第三项显式给定 order。
 */
const SHADOWS = [
    ['harness:source', 'HARNESS_SOURCE'],
    ['app:web-surface', 'WEB_SURFACE'],
    ['ui:deliverable-file-references', 'DELIVERABLE_FILE_REFERENCES'],
    ['dsh-meta-tools:route-pointer', null, 3150],
];

import { overlayStored, handleSettings } from './settings.js';

/** Settings surface for the Web UI (persisted at ~/.dsh/prompt-trim/config.json). */
export const SETTINGS_FIELDS = Object.freeze([
    { key: 'enabled', type: 'boolean', label: '总开关', hint: '关掉后所有遮蔽取消，系统提示回到完整注入。' },
    { key: 'shadowSource', type: 'boolean', label: '遮蔽 harness:source' },
    { key: 'shadowWebSurface', type: 'boolean', label: '遮蔽 app:web-surface' },
    { key: 'shadowDeliverable', type: 'boolean', label: '遮蔽 deliverable-file-references' },
    { key: 'shadowRoutePointer', type: 'boolean', label: '遮蔽 meta-tools route-pointer' },
]);

const FLAGS = ['shadowSource', 'shadowWebSurface', 'shadowDeliverable', 'shadowRoutePointer'];

export function apply(ctx, config = {}) {
    const state = overlayStored('prompt-trim', SETTINGS_FIELDS, {
        enabled: true,
        shadowSource: true,
        shadowWebSurface: true,
        shadowDeliverable: true,
        shadowRoutePointer: true,
    });

    let disposeShadows = null;

    function sync() {
        if (typeof disposeShadows === 'function') {
            try { disposeShadows(); } catch { /* already disposed */ }
            disposeShadows = null;
        }
        if (state.enabled === false) return;
        const active = SHADOWS.filter((_, index) => state[FLAGS[index]] !== false);
        if (active.length === 0) return;
        const disposers = active.map(([sectionName, orderName, fallbackOrder]) => {
            const order = typeof orderName === 'string' ? ctx.systemPrompt.getSectionOrder(orderName) : fallbackOrder;
            if (!Number.isFinite(order)) {
                throw new TypeError('dsh-prompt-trim: no finite order for section "' + sectionName + '"');
            }
            return ctx.systemPrompt.section({ name: sectionName, order, text: '' });
        });
        disposeShadows = () => {
            for (const dispose of disposers.reverse()) {
                try { dispose(); } catch { /* already disposed with the context */ }
            }
        };
    }

    ctx.effect(() => {
        sync();
        return () => {
            if (typeof disposeShadows === 'function') {
                try { disposeShadows(); } catch { /* already disposed with the context */ }
            }
        };
    }, 'dsh-prompt-trim: shadowed sections');

    // Toggling must rebuild the shadow set: registering/unregistering prompt sections
    // is the only mechanism, so the prefix changes on save (unavoidable).
    const originalOnSave = state;
    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: '/api/prompt-trim/config',
        handler: async (req, res) => {
            await handleSettings('prompt-trim', SETTINGS_FIELDS, originalOnSave, req, res);
            if (req.method === 'POST') {
                try { sync(); } catch { /* the next request reports it */ }
            }
        },
    }), 'dsh-prompt-trim: settings');
}
