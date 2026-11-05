/**
 * dsh-meta-tools — meta-layer library tools for DeepSeek Harness (v3).
 *
 * v3 (Owner rulings 2026-10-27):
 *   - NO model registry: .dsh/meta/registry.json is retired; the project meta
 *     folder carries a TASK-TYPE registry only (.dsh/meta/tasktypes.json).
 *   - Models self-register/remove task types via `meta_tasktype` (tombstoned
 *     types keep their folders but are not routed; harness presets untouched).
 *   - meta_file (custom read/write/delete/search) is REMOVED — native tools are
 *     better. Replaced by `meta_sign` (签发): after a native write/edit, sign
 *     the file to append a timestamp+model+revisionBasis line to the companion
 *     .revlog.md (cap from .dsh/meta/config.json, default 8 entries).
 *   - `meta_route` phase 2 returns PATHS ONLY (never inline bodies).
 *   - Provisioning happens in the meta_route inventory call (session root by
 *     construction) — the agent/created + turn/end hooks are gone.
 *
 * Still installed: one system-prompt section pointing to meta_route, the
 * session→model projection (lib/model-map.js), and meta_theme.
 *
 * v4 (Owner 2026-10-29) — settings surface only, tool surface UNCHANGED:
 *   - meta-tools configuration is its own Settings section (`settings.section`)
 *     instead of a card under Settings → General; the section covers the theme
 *     presets AND the per-project sign switch.
 *   - the sign switch (`.dsh/meta/config.json` `signEnabled`) NEVER unregisters
 *     meta_sign — a changing tool surface invalidates the prompt cache. "Off"
 *     means every call answers `SIGN_DISABLED`: an English reminder that signing
 *     is disabled for this project plus "skip it and do not mention it in the
 *     reply body" (no revlog write).
 */
import { Buffer } from "node:buffer";
import Schema from "@deepseek-ai/schemastery";
import {
    metaSettingsState, normalizeConfig, resolveRootCfg, setBootstrapSubagents, setPresetTheme, setSignEnabled,
    setSubagentPrompt, setSubagentPromptFile, setThemes,
} from "./library.js";
import { modelMapProjection } from "./model-map.js";
import { installBootstrap } from "./bootstrap.js";
import { createMetaRouteTool } from "./route.js";
import { createMetaSignTool } from "./sign.js";
import { createMetaTaskTypeTool } from "./tasktype.js";
import { createMetaAliasTool } from "./alias.js";
import { createThemeTool } from "./theme-tool.js";

export const name = "dsh-meta-tools";
// sessionProjections is REQUIRED — the model map is the plugin's spine; without
// the service the plugin stays inactive. webServer serves the theme card.
export const inject = ["tools", "systemPrompt", "sessionProjections", "webServer"];

// Settings channel for the independent "Meta-tools" settings column: themes,
// active theme and the per-project sign switch (Owner 2026-10-29).
const SETTINGS_ROUTE = "/api/meta-tools/config";

/** Same-origin guard (copied from the verified godot-creator-ui host half). */
function assertTrustedRequest(req) {
    const origin = req.headers.origin;
    if (typeof origin !== "string" || origin === "" || origin === "null") return;
    const host = req.headers.host;
    if (typeof host !== "string" || host === "") throw new Error("cross-origin requests are not allowed");
    let parsed;
    try {
        parsed = new URL(origin);
    } catch {
        throw new Error("cross-origin requests are not allowed");
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.host !== host) {
        throw new Error("cross-origin requests are not allowed");
    }
}

function sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
    });
    res.end(body);
}

// Real schemastery schema (loader applies `~standard.validate`). Volatile fields
// are the Settings-UI rows; the rest are patch-config editable (reinstall to change).
export const Config = Schema.object({
    enabled: Schema.boolean().default(true),
    scaffold: Schema.string().default("fill"),
    revlogEntries: Schema.natural().default(8), // fallback when .dsh/meta/config.json is absent/invalid
    routeMaxFiles: Schema.natural().default(40), // route listing cap — deliberately NOT model-editable
    // v3.1 (Owner ask 2026-10-31): the zero-arg inventory also lists every type's
    // must-read paths, so a cold start usually needs ONE meta_route call.
    inventoryPlan: Schema.boolean().default(true),
    // v3.2 (Owner 2026-10-31): .dsh/public/meta/*.md are must-read for EVERY task
    // type, so they are injected into the system prompt per agent instead of being
    // re-read. bootstrapMaxChars caps the injected text (0 = no cap).
    bootstrap: Schema.boolean().default(true),
    bootstrapMaxChars: Schema.natural().default(64000),
    // v3.3: delegated children re-pay the same bootstrap prefix; default OFF for subagents.
    bootstrapSubagents: Schema.boolean().default(false),
    // v4 (Owner 2026-11-04): CHILD-ONLY prompt file `.dsh/meta/SUBAGENTS.md` (the name
    // is config); a child receives it INSTEAD of the parent prefix. Project file wins.
    subagentPrompt: Schema.boolean().default(true),
    // v4: the FILE NAME is Owner config, editable in the Meta-tools settings column.
    subagentPromptFile: Schema.string().default("SUBAGENTS.md"),
    // Per-project sign switch INSTANCE DEFAULT (Owner 2026-10-29): the project file
    // .dsh/meta/config.json signEnabled wins; the tool itself stays registered, so
    // switching signing off never reshapes the tool surface / prompt cache.
    signEnabled: Schema.boolean().default(true),
    presetTheme: Schema.string().volatile(),
    themes: Schema.dict(Schema.object({ taskTypes: Schema.array(Schema.string()) })).volatile(),
});

const ROUTE_SECTION = {
    name: "dsh-meta-tools:route-pointer",
    order: 3150, // after MCP_SERVERS, before TOOLS_SDK — library guidance sits with tool guidance
    // Only "what to do first". Signing, aliasing and type registration live in their own
    // tool descriptions (read at call time); library upkeep uses native read/write/edit.
    text: [
        "## Meta library (this workspace)",
        "`.dsh/` holds this workspace's per-model prompt and knowledge library. At the start of a task, call `meta_route` with no arguments for the task types, then once more with your type for the must-read paths and open them with the native read tool. Papers are not preloaded — find them with grep or project_files find. Every other mechanism is described by its own tool.",
    ].join("\n"),
};

export function apply(ctx, rawConfig) {
    const cfg = normalizeConfig(rawConfig);
    if (cfg.enabled === false) return;

    ctx.sessionProjections.register(modelMapProjection);

    // System-prompt pointer (own effect so a missing service cannot take the tools down).
    ctx.effect(() => ctx.systemPrompt.section(ROUTE_SECTION), "dsh-meta-tools: route section");

    // v3.2: the type-independent must-read set (public/meta bodies) is injected
    // per agent, so the model does not have to read it.
    installBootstrap(ctx, cfg);

    // Tool disclosure (vendored dsh-tool-search 0.1.8, see lib/tool-search.js):
    // the catalog manifest is frozen per agent scope, so one session pays the
    // runtime-context snapshot once and never again. Loaded lazily: a host that
    // cannot resolve the peer packages must not take the whole plugin down.
    ctx.effect(() => {
        import("./tool-search.js")
            .then(({ installToolSearch }) => installToolSearch(ctx))
            .catch((error) => {
                try { ctx.logger?.warn?.("dsh-meta-tools: tool-search unavailable: " + (error?.message ?? error)); } catch { /* best-effort */ }
            });
        return () => {};
    }, "dsh-meta-tools: tool-search");

    // Model-facing tools (v3: no read ledger, no hooks, no registration).
    ctx.effect(() => ctx.tools.register(createMetaRouteTool(ctx, cfg)), "dsh-meta-tools: meta_route");
    ctx.effect(() => ctx.tools.register(createMetaSignTool(ctx, cfg)), "dsh-meta-tools: meta_sign");
    overlayStored('meta-tools', SETTINGS_FIELDS, cfg);
    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: '/api/meta-tools/knobs',
        handler: (req, res) => handleSettings('meta-tools', SETTINGS_FIELDS, cfg, req, res),
    }), 'dsh-meta-tools: knobs');

ctx.effect(() => ctx.tools.register(createMetaTaskTypeTool(ctx, cfg)), "dsh-meta-tools: meta_tasktype");
    ctx.effect(() => ctx.tools.register(createMetaAliasTool(ctx, cfg)), "dsh-meta-tools: meta_alias");
    ctx.effect(() => ctx.tools.register(createThemeTool(cfg)), "dsh-meta-tools: meta_theme");

    // Settings UI channel: the client settings column polls this route (godot-creator-ui pattern).
    ctx.effect(() => {
        const disposeRoute = ctx.webServer.register({
            kind: "exact",
            path: SETTINGS_ROUTE,
            handler: async (req, res) => {
                try {
                    assertTrustedRequest(req);
                    if (req.method === "GET") {
                        sendJson(res, 200, await metaSettingsState(cfg));
                        return;
                    }
                    if (req.method === "POST") {
                        const chunks = [];
                        for await (const chunk of req) chunks.push(chunk);
                        let body = {};
                        try {
                            body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
                        } catch {
                            sendJson(res, 400, { error: "invalid JSON body" });
                            return;
                        }
                        if (body.bootstrapSubagents !== undefined) {
                            sendJson(res, 200, await setBootstrapSubagents(cfg, body.bootstrapSubagents));
                            return;
                        }
                        if (body.subagentPromptFile !== undefined) {
                            sendJson(res, 200, await setSubagentPromptFile(cfg, body.subagentPromptFile));
                            return;
                        }
                        if (body.subagentPrompt !== undefined) {
                            sendJson(res, 200, await setSubagentPrompt(cfg, body.subagentPrompt));
                            return;
                        }
                        if (body.signEnabled !== undefined) {
                            sendJson(res, 200, await setSignEnabled(cfg, body.signEnabled));
                            return;
                        }
                        if (body.themes !== undefined) {
                            sendJson(res, 200, await setThemes(cfg, body.themes));
                            return;
                        }
                        sendJson(res, 200, await setPresetTheme(cfg, body.theme));
                        return;
                    }
                    sendJson(res, 405, { error: "method not allowed" });
                } catch (error) {
                    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
                }
            },
        });
        return disposeRoute;
    }, "dsh-meta-tools: settings route");
}

// resolveRootCfg is re-exported for tests; keep the import used.
export { resolveRootCfg };

import { overlayStored, handleSettings } from '../settings.js';

/** Settings surface for the Web UI (persisted at ~/.dsh/meta-tools/config.json). */
export const SETTINGS_FIELDS = Object.freeze([
    { key: 'enabled', type: 'boolean', label: '总开关', hint: '关掉后路由与签发工具仍注册，但不再注入提示词。' },
    { key: 'inventoryPlan', type: 'boolean', label: '清单计划', hint: '路由清单附带必读路径计划。' },
    { key: 'bootstrap', type: 'boolean', label: '启动注入', hint: '会话创建时注入 public/meta 正文。' },
    { key: 'bootstrapMaxChars', type: 'number', min: 0, max: 500000, label: '注入上限字符' },
    { key: 'bootstrapSubagents', type: 'boolean', label: '子代理也注入' },
    { key: 'revlogEntries', type: 'number', min: 0, max: 64, label: 'revlog 条数上限' },
    { key: 'routeMaxFiles', type: 'number', min: 1, max: 500, label: '路由列文件上限' },
    { key: 'scaffold', type: 'enum', options: [{ value: 'fill', label: '仅补缺失目录' }, { value: 'off', label: '不预填' }], label: '目录预填', hint: '只补缺失目录，不动已有文件。' },
    { key: 'root', type: 'string', clearOnEmpty: true, label: '库根目录', hint: '留空=跟随会话工作目录；填错会整体指向别处。' },
]);
