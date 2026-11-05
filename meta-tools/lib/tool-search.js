// dsh-meta-tools · tool-search integration (vendored engine + session-frozen manifest).
//
// WHY: the catalog manifest rides the runtime-context channel. Whenever its text
// changes (a tool warms, a plugin installs or uninstalls), the agent loop appends a
// FULL runtime-context snapshot to history. Freezing the manifest for the lifetime
// of one session keeps that channel byte-stable: zero re-entry per session.
// Sessions are assumed disposable, so a stale listing is cheaper than a re-push.
//
// Freeze granularity: one key per session id (fallback: the assemble scope object).
// The first assembly that carries a NON-EMPTY manifest records it verbatim; every
// later assembly reuses it even if the registry or the warm set changed. A session
// that starts below the disclosure threshold freezes nothing and keeps behaving
// live until a manifest actually exists, then freezes it once.
//
// Tools that appear after the freeze stay discoverable through tool_search: the
// search path reads the live registry, only the listing text is frozen.

import { RuntimeConfigStore, ToolSearchConfigSchema } from "./tools/config.js";
import { ToolSearchEngine } from "./tools/engine.js";
import { BRIDGE_NAMES, registerBridgeTools } from "./tools/bridge.js";
import { MANAGEMENT_NAMES, registerManagementTools } from "./tools/setup.js";
import { MANIFEST_CONTEXT } from "./tools/disclosure.js";
import { SDK_SECTION } from "./tools/sdk.js";
import { PTC_TRANSPORT_TOOL } from "./tools/ptc.js";

/** run_code and the bridge itself are never invoked through the bridge. */
const BLOCKED_FROM_BRIDGE = new Set([...BRIDGE_NAMES, ...MANAGEMENT_NAMES, "skill", PTC_TRANSPORT_TOOL]);

/** Mirror of the upstream schema defaults (the vendored engine reads these fields). */
const TUNING = {
    enabled: "auto",
    thresholdPct: 5,
    listingMaxTokens: 4000,
    contextWindow: 128000,
    searchDefaultLimit: 5,
    maxSearchLimit: 20,
    minCatalogSize: 12,
    configScope: "auto",
    core: ["todo_write"],
    matcherTimeoutMs: 15000,
    maxWarmTools: 8,
};

const GLOBAL_KEY = Symbol("no-scope");

/** Validate the static tuning through the vendored schema, falling back to TUNING. */
function resolveTuning() {
    try {
        return { ...TUNING, ...ToolSearchConfigSchema({ ...TUNING }) };
    } catch {
        return { ...TUNING };
    }
}

/** Freeze key: the session id when the host exposes one, else the scope identity. */
function sessionIdOf(scope) {
    const candidates = [scope?.session?.id, scope?.agent?.session?.id, scope?.sessionId];
    for (const id of candidates) if (typeof id === "string" && id !== "") return id;
    return undefined;
}

function scopeKey(scope) {
    const id = sessionIdOf(scope);
    if (id !== undefined) return "session:" + id;
    if (scope && typeof scope === "object") return scope;
    return GLOBAL_KEY;
}

/**
 * What the freeze is keyed on. The hook hands `context` ({ agent, scope? }); keying on
 * `context.scope` alone silently disabled the freeze (every assembly a fresh key).
 */
function freezeScopeOf(context) {
    const scope = context?.scope;
    if (sessionIdOf(scope) !== undefined) return scope;
    return scope ?? context?.agent ?? context;
}

/** The rendered SDK declaration block of an assembly (undefined when absent). */
function sdkTextOf(assembly) {
    const sections = assembly?.sections;
    if (!Array.isArray(sections)) return undefined;
    return sections.find((entry) => entry && entry.name === SDK_SECTION)?.text;
}

/** All catalog entries currently in an assembly (two engines would leave two). */
function catalogsOf(contexts) {
    return contexts.filter((entry) => entry && entry.name === MANIFEST_CONTEXT);
}

/**
 * Force the assembly manifest to the frozen text for this scope.
 * Also collapses duplicate catalog contexts, so a stray second engine can never
 * reintroduce a second, drifting listing. Pure for an already-frozen scope: no
 * other context is added, removed or edited.
 * @param {object} assembled settled assembly whose contexts carry the manifest
 * @param {object|undefined} scope the assemble scope (agent)
 * @param {Map} frozen scope key -> manifest text captured on first non-empty assembly
 * @returns {object} the assembly to hand to the agent loop
 */
export function freezeManifest(assembled, scope, frozen) {
    if (!assembled || !Array.isArray(assembled.contexts)) return assembled;
    const key = scopeKey(scope);
    const catalogs = catalogsOf(assembled.contexts);
    const current = catalogs.length > 0 ? catalogs[0].text : "";
    let contexts = assembled.contexts;
    if (catalogs.length > 1) {
        const keep = catalogs[0];
        contexts = contexts.filter((entry) => entry.name !== MANIFEST_CONTEXT || entry === keep);
    }
    const unchangedShape = contexts === assembled.contexts;
    if (!frozen.has(key)) {
        // Freeze the WHOLE face (tool table + manifest), not just the listing text:
        // tier/warm churn otherwise rewrites the tool table and re-pushes the prompt.
        if (current !== "") frozen.set(key, { text: current, tools: assembled.tools, sdk: sdkTextOf(assembled) });
        return unchangedShape ? assembled : { ...assembled, contexts };
    }
    const stored = frozen.get(key);
    const want = typeof stored === "string" ? stored : stored.text;
    const frozenTools = typeof stored === "object" && stored !== null && "tools" in stored ? stored.tools : undefined;
    const frozenSdk = typeof stored === "object" && stored !== null && "sdk" in stored ? stored.sdk : undefined;
    const at = contexts.findIndex((entry) => entry && entry.name === MANIFEST_CONTEXT);
    const textSame = (at >= 0 ? contexts[at].text : "") === want;
    const toolsSame = frozenTools === undefined || assembled.tools === frozenTools;
    const sdkText = sdkTextOf(assembled);
    const sdkSame = frozenSdk === undefined || sdkText === undefined || sdkText === frozenSdk;
    if (textSame && toolsSame && sdkSame) {
        return unchangedShape ? assembled : { ...assembled, contexts };
    }
    if (at >= 0) {
        contexts = contexts.map((entry, index) => (index === at ? { ...entry, text: want } : entry));
    } else {
        contexts = [...contexts, { name: MANIFEST_CONTEXT, text: want }];
    }
    // The SDK declaration block is rendered from the live registry on every assembly;
    // without restoring it, one newly registered tool grows the system prompt again.
    let sections = assembled.sections;
    if (frozenSdk !== undefined && Array.isArray(sections)) {
        sections = sections.map((entry) => (entry && entry.name === SDK_SECTION ? { ...entry, text: frozenSdk } : entry));
    }
    const next = { ...assembled, contexts };
    if (sections !== undefined && sections !== assembled.sections) next.sections = sections;
    if (frozenTools !== undefined) next.tools = frozenTools;
    return next;
}

/**
 * Build the engine and the frozen-manifest registry without touching the plugin context.
 * @param {object} ctx plugin context (needs tools, and logger for warnings)
 * @returns {{engine: object, frozen: Map, config: object}}
 */
export function createToolSearch(ctx) {
    const config = resolveTuning();
    const warn = (message) => { try { ctx.logger?.warn?.(message); } catch { /* logging is best-effort */ } };
    const store = new RuntimeConfigStore(warn);
    const engine = new ToolSearchEngine(ctx, config, store);
    return { engine, frozen: new Map(), config };
}

/**
 * Install the disclosure hook and the five bridge/management tools on the plugin.
 * Every registration goes through ctx.effect, so a hot reload disposes the old
 * engine and tool set instead of leaking them or colliding on names.
 * @param {object} ctx plugin context
 * @param {{engine: object, frozen: Map, config: object}} [built] reuse a prepared state (tests)
 * @returns {{engine: object, frozen: Map, config: object}}
 */
export function installToolSearch(ctx, built = createToolSearch(ctx)) {
    const { engine, frozen, config } = built;
    // The disclosure hook is installed even when another engine still owns the
    // bridge names: freezing is independent of who serves the five tools, and a
    // later unload of that engine must not leave the session without a manifest.
    ctx.effect(() => ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
        const settled = await next();
        if (config.enabled === "off") return settled;
        const assembled = await engine.assemble(settled, context?.scope);
        return freezeManifest(assembled, freezeScopeOf(context), frozen);
    }), "dsh-meta-tools: tool-search disclosure");

    // Never take the whole meta-tools plugin down over a name clash: another
    // disclosure engine (usually the original dsh-tool-search) may still hold the
    // bridge names. Skip our registration, warn once, and keep meta-tools alive.
    const clash = [...BRIDGE_NAMES, ...MANAGEMENT_NAMES].filter((name) => {
        try { return ctx.tools.get(name) !== undefined; } catch { return false; }
    });
    if (clash.length > 0) {
        try {
            ctx.logger?.warn?.("dsh-meta-tools: tool-search bridge skipped, names already registered: " + clash.join(", "));
        } catch { /* logging is best-effort */ }
        return built;
    }
    const deps = {
        search: (query, limit, agent) => engine.search(query, limit, agent),
        describe: (name, agent) => engine.describe(name, agent), // Promise (shadow lookup is async)
        warm: (names, agent) => engine.warmTools(agent, names),
        canCall: async (name, agent) => {
            if (BLOCKED_FROM_BRIDGE.has(name)) return false;
            return ctx.tools.get(name, agent) !== undefined;
        },
        // Workspace shadow set (Owner 2026-11-06): a shadowed tool answers exactly like
        // an unknown one, so the model cannot probe for the hidden list.
        isShadowed: (name, agent) => engine.isShadowed(name, agent),
        exists: (name, agent) => {
            try { return ctx.tools.get(name, agent) !== undefined; } catch { return false; }
        },
    };
    ctx.effect(() => registerBridgeTools(ctx, deps), "dsh-meta-tools: tool-search bridge");
    ctx.effect(() => registerManagementTools(ctx, engine), "dsh-meta-tools: tool-search management");
    return built;
}
