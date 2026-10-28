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
 */
import { Buffer } from "node:buffer";
import Schema from "@deepseek-ai/schemastery";
import { normalizeConfig, resolveRootCfg, setPresetTheme, setThemes, themeState } from "./library.js";
import { modelMapProjection } from "./model-map.js";
import { createMetaRouteTool } from "./route.js";
import { createMetaSignTool } from "./sign.js";
import { createMetaTaskTypeTool } from "./tasktype.js";
import { createMetaAliasTool } from "./alias.js";
import { createThemeTool } from "./theme-tool.js";

export const name = "dsh-meta-tools";
// sessionProjections is REQUIRED — the model map is the plugin's spine; without
// the service the plugin stays inactive. webServer serves the theme card.
export const inject = ["tools", "systemPrompt", "sessionProjections", "webServer"];

const THEME_ROUTE = "/api/meta-tools/theme";

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
    presetTheme: Schema.string().volatile(),
    themes: Schema.dict(Schema.object({ taskTypes: Schema.array(Schema.string()) })).volatile(),
});

const ROUTE_SECTION = {
    name: "dsh-meta-tools:route-pointer",
    order: 3150, // after MCP_SERVERS, before TOOLS_SDK — library guidance sits with tool guidance
    text: [
        "## Meta library (this workspace)",
        "This workspace keeps a per-model prompt & knowledge library under `.dsh/`. At the start of any new task, call `meta_route` once (no arguments) for the routable task types and your library dir, then call it with your task type to receive must-read file PATHS — open them with your native read tool before working (bodies are never inlined).",
        "Maintain library files with your native read/write/edit tools; after each write to a meta-layer file, record the revision with `meta_sign` (签发 — timestamp, model and revisionBasis land in the companion .revlog.md, last 8 entries kept; cap in .dsh/meta/config.json). Add/remove project task types with `meta_tasktype` (removed types keep folders but stop routing). Sibling models may share ONE library through `meta_alias` (`.dsh/meta/config.json` modelAliases): routing then uses the identity library while reports and revlog keep the factual model.",
    ].join("\n"),
};

export function apply(ctx, rawConfig) {
    const cfg = normalizeConfig(rawConfig);
    if (cfg.enabled === false) return;

    ctx.sessionProjections.register(modelMapProjection);

    // System-prompt pointer (own effect so a missing service cannot take the tools down).
    ctx.effect(() => ctx.systemPrompt.section(ROUTE_SECTION), "dsh-meta-tools: route section");

    // Model-facing tools (v3: no read ledger, no hooks, no registration).
    ctx.effect(() => ctx.tools.register(createMetaRouteTool(ctx, cfg)), "dsh-meta-tools: meta_route");
    ctx.effect(() => ctx.tools.register(createMetaSignTool(ctx, cfg)), "dsh-meta-tools: meta_sign");
    ctx.effect(() => ctx.tools.register(createMetaTaskTypeTool(ctx, cfg)), "dsh-meta-tools: meta_tasktype");
    ctx.effect(() => ctx.tools.register(createMetaAliasTool(ctx, cfg)), "dsh-meta-tools: meta_alias");
    ctx.effect(() => ctx.tools.register(createThemeTool(cfg)), "dsh-meta-tools: meta_theme");

    // Settings UI channel: the client card polls this route (godot-creator-ui pattern).
    ctx.effect(() => {
        const disposeRoute = ctx.webServer.register({
            kind: "exact",
            path: THEME_ROUTE,
            handler: async (req, res) => {
                try {
                    assertTrustedRequest(req);
                    if (req.method === "GET") {
                        sendJson(res, 200, await themeState(cfg));
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
    }, "dsh-meta-tools: theme route");
}

// resolveRootCfg is re-exported for tests; keep the import used.
export { resolveRootCfg };
