/**
 * Godot Creator UI — host half.
 *
 * Serves the Godot AI integration snapshot that the client half renders in the
 * session-header status chip and the Settings diagnostics card.
 *
 * Version policy — deliberately decoupled from any specific Godot AI or addon version:
 *   - No pinned version, no expected tool count or catalog hash, no compatibility gate.
 *   - The endpoint is DISCOVERED from the addon's built-in DSH configuration
 *     (`$DSH_HOME/cordis.patch.yml` or a profile patch: the `mcp-godot-ai` entry's
 *     `--port` argument) instead of being assumed. Explicit plugin config still wins.
 *   - The two data sources are independent: a missing `/godot-ai/status` only means
 *     "backend identity unknown", never "offline", because the MCP probe still runs.
 *   - The MCP session is negotiated: this client proposes a protocol revision and then
 *     adopts whatever the server returns, including in the follow-up header.
 *   - Transport auth is DISCOVERED, not assumed: Godot AI 4.3.0 publishes a per-port
 *     capability (`http-<port>.json` in the platform capability directory) and rejects
 *     unauthenticated HTTP with 401 TRANSPORT_AUTH_REQUIRED. When that file exists the
 *     Bearer header is sent; when it does not (servers before 4.3.0) the request goes
 *     out unauthenticated. A rotated capability is re-read once on a 401.
 *   - Every remote field is read defensively; an addon that renames or drops one shows
 *     a blank, not a crash or a false "offline".
 *
 * Besides the status route, the package registers one model-facing, read-only tool:
 * `usage_report`. It measures nothing itself — it reads the host's own projection
 * units (`tokenUsage`, `contextPressure` and `contextBreakdown` from the base
 * bundle's token-meter) for the calling agent's session, so the model can see its
 * own token and context overhead at the end of a task and decide whether to continue
 * cheaply or stop and ask the user. Wall-clock timing is DSH's time-context plugin;
 * budget accounting is budget-watch — this tool duplicates neither.
 *
 * Zero runtime dependencies on purpose: the package is linked into a DSH profile by
 * absolute path, so Node resolves imports from this directory (not from the profile's
 * node_modules). Everything here uses node builtins plus global fetch.
 */
import { Buffer } from "node:buffer";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProjectFilesTool } from "./project-files.js";

export const name = "godot-creator-ui";
// `tools` and `sessionProjections` are base-layer services: present in every profile.
export const inject = ["webServer", "tools", "sessionProjections"];

const STATUS_PATH = "/api/godot-creator/status";
const PRESET_ID = "godot-creator";
/** Client-proposed revision. The server answers with the revision it will use. */
const PROPOSED_MCP_PROTOCOL = "2025-06-18";

const DEFAULTS = Object.freeze({
    host: "127.0.0.1",
    // undefined means "discover from the DSH configuration, then fall back to 8000".
    port: undefined,
    fallbackPort: 8000,
    statusPath: "/godot-ai/status",
    mcpPath: "/mcp",
    sessionTool: "session_manage",
    serverName: "godot-ai",
    dshHome: undefined,
    // undefined = platform default (see defaultCapabilityDir); "" disables capability lookup.
    capabilityDir: undefined,
    discoverTtlMs: 60000,
    capabilityTtlMs: 60000,
    // How long to stop probing after the server reports MCP_SESSION_LIMIT_REACHED.
    sessionLimitBackoffMs: 60000,
    cacheTtlMs: 1500,
    timeoutMs: 5000,
    mcpClientName: "godot-creator-ui",
    mcpClientVersion: "1.0.0",
});

/**
 * Where the Godot AI addon publishes its per-port transport capability.
 * Mirrors `McpTransportCapability.path_for_http_port` in the addon:
 *   Windows  %LOCALAPPDATA%\godot-ai\capabilities\http-<port>.json
 *   macOS    ~/Library/Application Support/godot-ai/capabilities/http-<port>.json
 *   Linux    $XDG_CONFIG_HOME/godot-ai/capabilities/http-<port>.json
 * A missing file is normal: servers before 4.3.0 require no capability at all.
 */
function defaultCapabilityDir() {
    if (process.platform === "win32") {
        const local = process.env.LOCALAPPDATA;
        return local === undefined || local === "" ? undefined : join(local, "godot-ai", "capabilities");
    }
    if (process.platform === "darwin") {
        return join(homedir(), "Library", "Application Support", "godot-ai", "capabilities");
    }
    const configHome = process.env.XDG_CONFIG_HOME;
    const base = configHome === undefined || configHome === "" ? join(homedir(), ".config") : configHome;
    return join(base, "godot-ai", "capabilities");
}

function normalizeConfig(raw) {
    const config = raw !== null && typeof raw === "object" ? raw : {};
    const str = (key, fallback) => {
        const value = config[key];
        return typeof value === "string" && value !== "" ? value : fallback;
    };
    const num = (key, fallback) => {
        const value = Number(config[key]);
        return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    const port = num("port", undefined);
    return {
        host: str("host", DEFAULTS.host),
        port: Number.isInteger(port) && port < 65536 ? port : undefined,
        fallbackPort: num("fallbackPort", DEFAULTS.fallbackPort),
        statusPath: str("statusPath", DEFAULTS.statusPath),
        mcpPath: str("mcpPath", DEFAULTS.mcpPath),
        sessionTool: str("sessionTool", DEFAULTS.sessionTool),
        serverName: str("serverName", DEFAULTS.serverName),
        dshHome: str("dshHome", process.env.DSH_HOME ?? join(homedir(), ".dsh")),
        capabilityDir: config.capabilityDir === "" ? undefined : str("capabilityDir", defaultCapabilityDir()),
        discoverTtlMs: num("discoverTtlMs", DEFAULTS.discoverTtlMs),
        capabilityTtlMs: num("capabilityTtlMs", DEFAULTS.capabilityTtlMs),
        sessionLimitBackoffMs: num("sessionLimitBackoffMs", DEFAULTS.sessionLimitBackoffMs),
        cacheTtlMs: Number.isFinite(Number(config.cacheTtlMs)) && Number(config.cacheTtlMs) >= 0 ? Number(config.cacheTtlMs) : DEFAULTS.cacheTtlMs,
        timeoutMs: num("timeoutMs", DEFAULTS.timeoutMs),
        mcpClientName: str("mcpClientName", DEFAULTS.mcpClientName),
        mcpClientVersion: str("mcpClientVersion", DEFAULTS.mcpClientVersion),
    };
}

/**
 * Discover the Godot AI HTTP port from the addon's built-in DSH configuration.
 *
 * The official Godot AI setup tells DSH how to launch the attach process, and that
 * entry carries the ports. Reading the entry — instead of assuming 8000 — means a
 * different port (another editor, a user-chosen port, a future default) keeps working.
 */
async function discoverPort(cfg) {
    const candidates = [join(cfg.dshHome, "cordis.patch.yml")];
    try {
        const profiles = await readdir(join(cfg.dshHome, "profiles"), { withFileTypes: true });
        for (const entry of profiles) {
            if (entry.isDirectory()) candidates.push(join(cfg.dshHome, "profiles", entry.name, "cordis.patch.yml"));
        }
    } catch {
        /* no profiles directory: the home patch alone is enough */
    }

    for (const path of candidates) {
        let text;
        try {
            text = await readFile(path, "utf8");
        } catch {
            continue;
        }
        const anchor = text.indexOf(cfg.serverName);
        if (anchor < 0) continue;
        const window = text.slice(anchor, anchor + 2000);
        // Tolerates both YAML `--port 8000` and JSON-array `"--port", "8000"` spellings.
        const match = /--port[^\d]{1,12}(\d{2,5})/u.exec(window);
        if (match === null) continue;
        const port = Number(match[1]);
        if (Number.isInteger(port) && port > 0 && port < 65536) return { port, source: path };
    }
    return undefined;
}

/**
 * Read the transport capability the addon published for this port.
 * Returns undefined when the file is absent (pre-4.3.0 server), unreadable, or malformed —
 * the caller then sends the request unauthenticated, exactly as older servers expect.
 */
async function readCapability(cfg, port) {
    if (cfg.capabilityDir === undefined) return undefined;
    const file = join(cfg.capabilityDir, `http-${port}.json`);
    try {
        const parsed = JSON.parse(await readFile(file, "utf8"));
        const token = parsed?.http;
        if (typeof token !== "string" || token === "") return undefined;
        return {
            token,
            source: file,
            instanceNonce: typeof parsed.instance_nonce === "string" ? parsed.instance_nonce : undefined,
            version: typeof parsed.version === "number" ? parsed.version : undefined,
        };
    } catch {
        return undefined;
    }
}

/** Same-origin guard: an Origin header, when present, must match the Host header. */
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

function parseSsePayload(text) {
    const messages = [];
    for (const line of text.split(/\r?\n/u)) {
        if (!line.startsWith("data:")) continue;
        try {
            messages.push(JSON.parse(line.slice(5).trim()));
        } catch {
            /* ignore malformed frame */
        }
    }
    if (messages.length === 0 && text.trim() !== "") {
        try {
            messages.push(JSON.parse(text));
        } catch {
            /* not JSON at all */
        }
    }
    return messages;
}

/**
 * MCP streamable-HTTP session manager, one session per (server instance, port).
 *
 * The session is the scarce resource: Godot AI 4.3.0 caps concurrent MCP sessions
 * (`MAX_MCP_SESSIONS = 32`) and only recycles an idle one after 30 minutes, answering
 * further `initialize` calls with `503 MCP_SESSION_LIMIT_REACHED`. A status display that
 * handshook on every poll therefore exhausted the budget; this keeps ONE session,
 * reuses it for every `tools/call`, releases it with `DELETE` when it is replaced, and
 * backs off instead of hammering while the server reports the limit.
 *
 * Revision handling follows the spec's negotiation: this client proposes a revision,
 * the server answers with the one it will use, and every later request echoes that
 * revision in the `mcp-protocol-version` header. An unknown future revision is adopted
 * rather than rejected, so a newer addon does not need a code change here.
 *
 * `capability` is the optional 4.3.0+ transport token; when present every request
 * carries `Authorization: Bearer <token>`.
 */
function serverErrorCode(text) {
    const match = /"code"\s*:\s*"([A-Z_]+)"/u.exec(text);
    return match?.[1];
}

function createMcpSession(cfg) {
    // The live session, keyed by the server instance that issued it: a capability
    // `instance_nonce` change means the server restarted and the id is meaningless.
    let current = { port: undefined, nonce: undefined, id: undefined, protocolVersion: undefined };
    let backoffUntil = 0;

    const authHeaders = (capability) => (capability === undefined ? {} : { authorization: `Bearer ${capability.token}` });

    async function rpc(endpoint, capability, body, options) {
        const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", ...authHeaders(capability) };
        if (options?.sessionId !== undefined) headers["mcp-session-id"] = options.sessionId;
        if (options?.protocolVersion !== undefined) headers["mcp-protocol-version"] = options.protocolVersion;
        const response = await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        return { status: response.status, sessionId: response.headers.get("mcp-session-id"), text: await response.text() };
    }

    /** Best-effort release so a replaced session frees its slot immediately. */
    async function release(endpoint, capability) {
        const id = current.id;
        current = { port: undefined, nonce: undefined, id: undefined, protocolVersion: undefined };
        if (id === undefined) return;
        try {
            await fetch(endpoint, {
                method: "DELETE",
                headers: { ...authHeaders(capability), "mcp-session-id": id },
                signal: AbortSignal.timeout(cfg.timeoutMs),
            });
        } catch {
            /* the server recycles an idle session by itself */
        }
    }

    function limitError() {
        const seconds = Math.max(0, Math.ceil((backoffUntil - Date.now()) / 1000));
        return new Error(
            `MCP session limit reached (503 MCP_SESSION_LIMIT_REACHED)：服务端并发会话额度已满（Godot AI 默认 32 个，空闲 30 分钟才回收）。已退避 ${seconds} 秒；重启 Godot AI 服务可立即释放。`,
        );
    }

    async function initialize(endpoint, capability, port) {
        const init = await rpc(
            endpoint,
            capability,
            {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: PROPOSED_MCP_PROTOCOL,
                    capabilities: {},
                    clientInfo: { name: cfg.mcpClientName, version: cfg.mcpClientVersion },
                },
            },
            {},
        );
        if (serverErrorCode(init.text) === "MCP_SESSION_LIMIT_REACHED" || init.status === 503) {
            backoffUntil = Date.now() + cfg.sessionLimitBackoffMs;
            throw limitError();
        }
        const message = parseSsePayload(init.text)[0];
        if (init.status >= 400 || message?.error !== undefined) {
            const detail = message?.error !== undefined ? `: ${JSON.stringify(message.error)}` : `: ${init.text.slice(0, 200)}`;
            throw new Error(`MCP initialize failed (HTTP ${init.status})${detail}`);
        }
        if (init.sessionId === undefined) throw new Error("MCP initialize returned no session id");
        const negotiated = typeof message?.result?.protocolVersion === "string" ? message.result.protocolVersion : undefined;
        current = { port, nonce: capability?.instanceNonce, id: init.sessionId, protocolVersion: negotiated ?? PROPOSED_MCP_PROTOCOL };
        await rpc(
            endpoint,
            capability,
            { jsonrpc: "2.0", method: "notifications/initialized" },
            { sessionId: current.id, protocolVersion: current.protocolVersion },
        );
        return { session: current, serverInfo: message?.result?.serverInfo, negotiated };
    }

    /** The session this port/instance should use, initializing only when needed. */
    async function ensureSession(endpoint, capability, port) {
        const reusable = current.id !== undefined && current.port === port && current.nonce === capability?.instanceNonce;
        if (reusable) return { session: current, reused: true, serverInfo: undefined, negotiated: undefined };
        if (current.id !== undefined) await release(endpoint, capability);
        const created = await initialize(endpoint, capability, port);
        return { ...created, reused: false };
    }

    const toolCall = (toolName, args) => ({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: toolName, arguments: args },
    });

    return {
        async callTool(endpoint, toolName, args, capability, port) {
            if (Date.now() < backoffUntil) throw limitError();
            let { session, reused, serverInfo, negotiated } = await ensureSession(endpoint, capability, port);
            let call = await rpc(endpoint, capability, toolCall(toolName, args), {
                sessionId: session.id,
                protocolVersion: session.protocolVersion,
            });
            // A recycled/expired session answers 404 (or a session-scoped 400): rebuild once.
            if ((call.status === 404 || call.status === 400) && serverErrorCode(call.text) !== "MCP_SESSION_LIMIT_REACHED") {
                await release(endpoint, capability);
                const rebuilt = await initialize(endpoint, capability, port);
                session = rebuilt.session;
                reused = false;
                serverInfo = rebuilt.serverInfo;
                negotiated = rebuilt.negotiated;
                call = await rpc(endpoint, capability, toolCall(toolName, args), {
                    sessionId: session.id,
                    protocolVersion: session.protocolVersion,
                });
            }
            if (serverErrorCode(call.text) === "MCP_SESSION_LIMIT_REACHED" || call.status === 503) {
                backoffUntil = Date.now() + cfg.sessionLimitBackoffMs;
                await release(endpoint, capability);
                throw limitError();
            }
            const message = parseSsePayload(call.text)[0];
            if (call.status >= 400 || message?.error !== undefined) {
                const detail = message?.error?.message ?? `HTTP ${call.status}`;
                throw new Error(`MCP tools/call "${toolName}" failed: ${detail}`);
            }
            if (message?.result?.isError === true) {
                const detail = message.result.content?.[0]?.text;
                throw new Error(typeof detail === "string" ? detail : `MCP tool "${toolName}" reported an error`);
            }
            const text = message?.result?.content?.[0]?.text;
            if (typeof text !== "string") throw new Error(`MCP tool "${toolName}" returned no text content`);
            return {
                value: JSON.parse(text),
                serverInfo: serverInfo ?? message?.result?.serverInfo,
                proposedProtocolVersion: PROPOSED_MCP_PROTOCOL,
                negotiatedProtocolVersion: negotiated ?? session.protocolVersion,
                reused,
            };
        },
        /** Release the held session: plugin dispose, or a new server instance. */
        async dispose(endpoint, capability) {
            await release(endpoint, capability);
        },
        sessionState() {
            return { held: current.id !== undefined, backoffUntil };
        },
    };
}

function readSession(entry) {
    if (entry === null || typeof entry !== "object") return undefined;
    const text = (key) => (typeof entry[key] === "string" ? entry[key] : undefined);
    return {
        sessionId: text("session_id"),
        name: text("name"),
        godotVersion: text("godot_version"),
        projectPath: text("project_path"),
        currentScene: text("current_scene"),
        playState: text("play_state"),
        readiness: text("readiness"),
        addonVersion: text("plugin_version"),
        serverVersion: text("server_version"),
        protocolVersion: typeof entry.protocol_version === "number" ? entry.protocol_version : undefined,
        editorPid: typeof entry.editor_pid === "number" ? entry.editor_pid : undefined,
        launchMode: text("server_launch_mode"),
        isActive: entry.is_active === true,
    };
}

function createProbe(cfg) {
    let cached = { at: 0, value: undefined };
    let inflight;
    let discovery = { at: 0, port: undefined, value: undefined };
    let capabilityCache = { at: 0, port: undefined, value: undefined };
    // One MCP session for the whole plugin lifetime, reused by every probe.
    const session = createMcpSession(cfg);

    /** Explicit config wins; otherwise discover from the DSH configuration, then fall back. */
    async function resolvePort() {
        if (cfg.port !== undefined) return { port: cfg.port, portSource: "config" };
        if (discovery.value !== undefined && Date.now() - discovery.at < cfg.discoverTtlMs) return discovery.value;
        const found = await discoverPort(cfg);
        const resolved = found === undefined
            ? { port: cfg.fallbackPort, portSource: "fallback" }
            : { port: found.port, portSource: found.source };
        discovery = { at: Date.now(), value: resolved };
        return resolved;
    }

    /**
     * Capability lookup, cached per port. `force` re-reads after a 401 so a rotated
     * token (a fresh addon/editor launch) recovers on the next probe instead of staying
     * offline until the cache expires.
     */
    async function resolveCapability(port, force) {
        if (force !== true && capabilityCache.port === port && Date.now() - capabilityCache.at < cfg.capabilityTtlMs) {
            return capabilityCache.value;
        }
        const value = await readCapability(cfg, port);
        capabilityCache = { at: Date.now(), port, value };
        return value;
    }

    async function probeBackend(statusUrl, capability) {
        const backend = { reachable: false, url: statusUrl };
        try {
            const headers = {};
            if (capability !== undefined) headers.authorization = `Bearer ${capability.token}`;
            const response = await fetch(statusUrl, { signal: AbortSignal.timeout(cfg.timeoutMs), headers });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            backend.reachable = true;
            backend.name = typeof data.name === "string" ? data.name : undefined;
            backend.serverVersion = typeof data.server_version === "string" ? data.server_version : undefined;
            backend.wsPort = typeof data.ws_port === "number" ? data.ws_port : undefined;
            backend.toolSurface = typeof data.tool_surface === "string" ? data.tool_surface : undefined;
            backend.toolCatalogHash = typeof data.tool_catalog_hash === "string" ? data.tool_catalog_hash : undefined;
            backend.attachProtocolVersion = typeof data.attach_protocol_version === "number" ? data.attach_protocol_version : undefined;
            backend.activeLeaseCount = typeof data.active_lease_count === "number" ? data.active_lease_count : undefined;
            backend.packagePath = typeof data.package_path === "string" ? data.package_path : undefined;
            backend.instanceId = typeof data.instance_id === "string" ? data.instance_id : undefined;
        } catch (error) {
            backend.error = error instanceof Error ? error.message : String(error);
        }
        return backend;
    }

    async function probeEditor(mcpUrl, capability, port) {
        const editor = { connected: false, sessions: [] };
        try {
            const result = await session.callTool(mcpUrl, cfg.sessionTool, { op: "list" }, capability, port);
            const sessions = Array.isArray(result.value?.sessions) ? result.value.sessions : [];
            editor.sessions = sessions.map(readSession).filter((entry) => entry !== undefined);
            editor.connected = editor.sessions.length > 0;
            editor.activeSessionId = editor.sessions.find((entry) => entry.isActive)?.sessionId;
            editor.sessionTool = cfg.sessionTool;
            editor.mcpProtocolVersion = result.negotiatedProtocolVersion ?? result.proposedProtocolVersion;
            editor.mcpProtocolNegotiated = result.negotiatedProtocolVersion !== undefined;
            editor.mcpServerName = result.serverInfo?.name;
            editor.mcpServerVersion = result.serverInfo?.version;
            // ONE session is held across probes; `reused` proves the budget is not leaking.
            editor.sessionReused = result.reused === true;
            editor.sessionHeld = session.sessionState().held;
        } catch (error) {
            editor.error = error instanceof Error ? error.message : String(error);
            editor.sessionTool = cfg.sessionTool;
            editor.sessionHeld = session.sessionState().held;
        }
        return editor;
    }

    /** True when a probe failed specifically because the transport wants a capability. */
    function authRejected(backend, editor) {
        return [backend.error, editor.error].some(
            (message) => typeof message === "string" && /AUTH_REQUIRED|capability|HTTP 401/iu.test(message),
        );
    }

    async function runProbes(port, capability) {
        const statusUrl = `http://${cfg.host}:${port}${cfg.statusPath}`;
        const mcpUrl = `http://${cfg.host}:${port}${cfg.mcpPath}`;
        // Both sources are probed independently: neither one failing may hide the other.
        const [backend, editor] = await Promise.all([
            probeBackend(statusUrl, capability),
            probeEditor(mcpUrl, capability, port),
        ]);
        return { backend, editor };
    }

    async function collect() {
        const { port, portSource } = await resolvePort();
        let capability = await resolveCapability(port, false);
        let { backend, editor } = await runProbes(port, capability);

        // A capability rotates when the addon or editor restarts; re-read once so a stale
        // token recovers on this probe instead of staying blind until the cache expires.
        let retried = false;
        if (authRejected(backend, editor)) {
            const refreshed = await resolveCapability(port, true);
            retried = true;
            if (refreshed !== undefined || capability !== undefined) {
                capability = refreshed;
                ({ backend, editor } = await runProbes(port, capability));
            }
        }

        return {
            checkedAt: new Date().toISOString(),
            presetId: PRESET_ID,
            // The integration is reachable when either source answered; the chip uses this,
            // so a renamed/absent status endpoint never renders as "offline".
            reachable: backend.reachable === true || editor.error === undefined,
            config: {
                host: cfg.host,
                port,
                portSource,
                statusPath: cfg.statusPath,
                mcpPath: cfg.mcpPath,
                sessionTool: cfg.sessionTool,
                capabilityDir: cfg.capabilityDir ?? null,
            },
            auth:
                capability === undefined
                    ? { mode: "none", rejected: authRejected(backend, editor), retried }
                    : {
                          mode: "bearer",
                          source: capability.source,
                          instanceNonce: capability.instanceNonce,
                          version: capability.version,
                          rejected: authRejected(backend, editor),
                          retried,
                      },
            backend,
            editor,
        };
    }

    return {
        async snapshot(force) {
            const now = Date.now();
            if (force !== true && cached.value !== undefined && now - cached.at < cfg.cacheTtlMs) return cached.value;
            if (inflight !== undefined) return inflight;
            inflight = collect()
                .then((value) => {
                    cached = { at: Date.now(), value };
                    return value;
                })
                .finally(() => {
                    inflight = undefined;
                });
            return inflight;
        },
        async resolvedConfig() {
            const { port, portSource } = await resolvePort();
            return { host: cfg.host, port, portSource, statusPath: cfg.statusPath, mcpPath: cfg.mcpPath, sessionTool: cfg.sessionTool };
        },
        /** Release the held MCP session so its slot is not leaked across reloads. */
        async dispose() {
            try {
                const { port } = await resolvePort();
                const capability = await resolveCapability(port, false);
                await session.dispose(`http://${cfg.host}:${port}${cfg.mcpPath}`, capability);
            } catch {
                /* dispose is best-effort */
            }
        },
    };
}

/**
 * Self-overhead tool: one read-only model-facing report over the host's measurements.
 *
 * The data already exists in the default composition — this tool adds no metering:
 *   sessionStats     (web-app bundle)  NOT used: wall-clock timing is time-context's job
 *   tokenUsage       (base bundle)     input, output, cache-read, cache-write token totals
 *   contextPressure  (base bundle)     newest provider prompt size, surface size, model window
 *   contextBreakdown (base bundle)     heuristic system / tools / messages composition
 * It reads them from `ctx.sessionProjections` for the CALLING agent's session.
 *
 * The definition is hand-built instead of imported from `@deepseek-ai/dsh-tools`: this
 * package has no node_modules chain to the dsh installation (it is junctioned into the
 * profile), so a bare import would fail to resolve. The shape mirrors exactly what that
 * package's `defineTool` returns: { name, description, parameters, output, execute }.
 */
const USAGE_TOOL_NAME = "usage_report";

function readProjection(ctx, session, key) {
    try {
        const projections = ctx.sessionProjections;
        if (projections === undefined || projections === null) return undefined;
        if (typeof projections.stateOf === "function") return projections.stateOf(session, key);
        // Older registry without stateOf: fall back to the consistent wire cut.
        const cut = projections.snapshot(session);
        return cut?.values?.[key];
    } catch {
        return undefined;
    }
}

function numberOrNull(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildUsageReport(ctx, exec) {
    const session = exec?.agent?.session;
    if (session === undefined || session === null) {
        throw new Error(`${USAGE_TOOL_NAME} requires an owning agent session`);
    }
    const usage = readProjection(ctx, session, "tokenUsage");
    const pressure = readProjection(ctx, session, "contextPressure");
    const breakdown = readProjection(ctx, session, "contextBreakdown");

    const totals = usage?.totals ?? undefined;
    const composition = breakdown?.breakdown ?? undefined;
    const usedTokens = numberOrNull(pressure?.pressureTokens) ?? numberOrNull(pressure?.surfaceTokens);
    const windowTokens = numberOrNull(pressure?.contextWindow);
    const percent =
        usedTokens !== null && windowTokens !== null && windowTokens > 0
            ? Math.round((usedTokens / windowTokens) * 1000) / 10
            : null;

    const counters = usageCounters(totals);
    const hitRate = hitRateOf(counters);

    const missing = [];
    if (totals === undefined) missing.push("tokenUsage");
    if (pressure === undefined) missing.push("contextPressure");
    if (composition === undefined) missing.push("contextBreakdown");

    return {
        now: new Date().toISOString(),
        session: typeof session.id === "string" ? session.id : null,
        // Wall-clock / step timing is DSH's built-in time-context plugin (enabled by
        // default) — this tool deliberately does not duplicate it.
        tokens: counters,
        hitRate,
        lowCost: hitRate !== null && hitRate < LOW_CACHE_HIT_RATE,
        context: {
            usedTokens,
            surfaceTokens: numberOrNull(pressure?.surfaceTokens),
            windowTokens,
            percent,
            composition:
                composition === undefined
                    ? null
                    : {
                          systemTokens: numberOrNull(composition.systemTokens),
                          toolsTokens: numberOrNull(composition.toolsTokens),
                          messageTokens: numberOrNull(composition.messageTokens),
                      },
        },
        missing,
    };
}

function formatTokens(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "?";
    if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
    return `${value}`;
}

function renderUsage(value) {
    // Deliberately terse: every rendered line becomes uncached input and is re-read by
    // every later request, so the full report keeps only what a decision needs.
    const lines = [];
    const parts = [];
    if (value.tokens !== null && value.tokens.total !== null) {
        parts.push(`总值 ${formatTokens(value.tokens.total)}${value.hitRate === null ? "" : ` · 命中 ${(value.hitRate * 100).toFixed(1)}%`}`);
    }
    if (parts.length > 0) lines.push(`开销：${parts.join(" · ")}`);
    if (value.context.usedTokens !== null || value.context.windowTokens !== null) {
        const percent = value.context.percent === null ? "?" : `${value.context.percent}%`;
        lines.push(`上下文：${formatTokens(value.context.usedTokens)} / ${formatTokens(value.context.windowTokens)} = ${percent}`);
    }
    const notice = lowCostNotice(value.hitRate);
    if (notice !== null) lines.push(notice);
    return lines.join("\n");
}

/**
 * Task-cost modes. `full` reports the session; `baseline` snapshots the counters and
 * remembers them per session — every hot start records its own, and sessions never
 * share one; `delta` subtracts a baseline and answers in one line: TOTAL tokens and
 * cache hit rate. Budget accounting is NOT here (budget-watch owns it) and neither is
 * wall-clock timing (DSH's built-in time-context plugin, enabled by default).
 *
 * One owner-set rule lives here because the tool is the only place that sees the
 * numbers: a cache hit rate below 96% must make the model cut its own tool calls.
 */
const USAGE_MODES = Object.freeze(["full", "baseline", "delta"]);
const LOW_CACHE_HIT_RATE = 0.96;
/** Per-session hot-start baselines: a new hot start in a session replaces that session's. */
const sessionBaselines = new Map();

function totalOf(counters) {
    if (counters === null || counters === undefined) return null;
    const parts = [counters.input, counters.output, counters.cacheRead, counters.cacheWrite];
    if (parts.some((part) => part === null || part === undefined)) return null;
    return parts.reduce((sum, part) => sum + part, 0);
}

/** Cache hit rate over prompt tokens: cached reads over every prompt token read. */
function hitRateOf(counters) {
    if (counters === null || counters === undefined) return null;
    const read = numberOrNull(counters.cacheRead);
    const uncached = numberOrNull(counters.input);
    if (read === null || uncached === null || read + uncached <= 0) return null;
    return read / (read + uncached);
}

/** Sent to the model, not to the user: below the threshold it must restrain itself. */
function lowCostNotice(hitRate) {
    if (hitRate === null || hitRate >= LOW_CACHE_HIT_RATE) return null;
    return `⚠ 命中率 ${(hitRate * 100).toFixed(1)}% < 96%：低成本——限制工具调用，合并批量请求。`;
}

function usageCounters(totals) {
    if (totals === undefined || totals === null) return null;
    const counters = {
        input: numberOrNull(totals.uncachedInputTokens),
        output: numberOrNull(totals.outputTokens),
        cacheRead: numberOrNull(totals.cacheReadTokens),
        cacheWrite: numberOrNull(totals.cacheWriteTokens),
    };
    counters.total = totalOf(counters);
    return counters;
}

function normalizeBaseline(value) {
    if (value === null || typeof value !== "object") return null;
    const raw = value.at ?? value.now;
    const at = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : Number.NaN;
    return {
        at: Number.isFinite(at) ? at : null,
        tokens: value.tokens ?? null,
    };
}

/** Per-field difference, clamped at zero; null when either side lacks the field. */
function diffField(current, baseline, key) {
    const now = numberOrNull(current?.[key]);
    const then = numberOrNull(baseline?.[key]);
    return now === null || then === null ? null : Math.max(0, now - then);
}

function buildBaselineReport(ctx, session, verbose) {
    const usage = readProjection(ctx, session, "tokenUsage");
    const at = Date.now();
    // Budget lives ONLY in budget-watch; wall-clock timing lives in DSH's time-context.
    // This baseline snapshots token counters only.
    const report = {
        mode: "baseline",
        at,
        iso: new Date(at).toISOString(),
        tokens: usageCounters(usage?.totals),
        verbose: verbose === true,
    };
    // The model need not carry the object around: remember it for this session only.
    if (typeof session.id === "string") sessionBaselines.set(session.id, report);
    return report;
}

function buildDeltaReport(ctx, session, explicitBaseline) {
    const stored = typeof session.id === "string" ? sessionBaselines.get(session.id) : undefined;
    const base = normalizeBaseline(explicitBaseline ?? stored);
    if (base === null || base.at === null) {
        throw new Error(
            `${USAGE_TOOL_NAME} mode=delta needs a baseline: call mode=baseline first (the object it returns may also be passed back explicitly)`,
        );
    }
    const usage = readProjection(ctx, session, "tokenUsage");
    const currentTokens = usageCounters(usage?.totals);
    const at = Date.now();

    let tokens = null;
    if (currentTokens !== null && base.tokens !== null) {
        tokens = {
            input: diffField(currentTokens, base.tokens, "input"),
            output: diffField(currentTokens, base.tokens, "output"),
            cacheRead: diffField(currentTokens, base.tokens, "cacheRead"),
            cacheWrite: diffField(currentTokens, base.tokens, "cacheWrite"),
        };
        tokens.total = totalOf(tokens);
    }
    // The task's own rate is the actionable signal; fall back to the session's when the
    // delta carries no counters (a brand-new hot start).
    const hitRate = hitRateOf(tokens) ?? hitRateOf(currentTokens);
    const used = tokens?.total ?? null;
    return {
        mode: "delta",
        from: new Date(base.at).toISOString(),
        to: new Date(at).toISOString(),
        tokens,
        hitRate,
        lowCost: hitRate !== null && hitRate < LOW_CACHE_HIT_RATE,
        used,
    };
}

function renderBaseline(value) {
    // The stored baseline needs no echo: a rendered JSON line is strictly new content,
    // never cacheable, and is re-read by every later step. Show it only on request.
    if (value.verbose !== true) return "基准已存（本会话）";
    const baseline = { at: value.at, tokens: value.tokens };
    return `基准已存（本会话）\n${JSON.stringify(baseline)}`;
}

function renderDelta(value) {
    const parts = [];
    if (value.tokens !== null) parts.push(`总值 +${formatTokens(value.tokens.total)}`);
    if (value.hitRate !== null) parts.push(`命中 ${(value.hitRate * 100).toFixed(1)}%`);
    const lines = [`任务：${parts.join(" · ")}`];
    const notice = lowCostNotice(value.hitRate);
    if (notice !== null) lines.push(notice);
    return lines.join("\n");
}

function createUsageTool(ctx) {
    return {
        name: USAGE_TOOL_NAME,
        description:
            "Report this session's own overhead and one task's share of it. mode=full (default) reports session token totals and context occupancy; mode=baseline records a hot-start token baseline for this session; mode=delta reports only what changed: total tokens, hit rate. Budgets are NOT tracked here (budget-watch owns budget_register) and neither is wall-clock timing (DSH's built-in time-context plugin); read-only; output is deliberately terse.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                mode: {
                    type: "string",
                    enum: [...USAGE_MODES],
                    description: "full (default) | baseline (snapshot for a later delta) | delta (task cost since a baseline)",
                },
                baseline: {
                    type: "object",
                    additionalProperties: true,
                    description: "mode=delta only, optional: the object mode=baseline returned. Omit it to use the baseline this session already recorded.",
                },
                verbose: {
                    type: "boolean",
                    description: "mode=baseline only, optional: also render the copyable baseline JSON. Off by default because the session already stored it.",
                },
                // `budget` is deliberately absent: budget-watch (budget_register) is the
                // single budget ledger; this tool never tracked a second one.
            },
        },
        output: {
            // Loose on purpose: the canonical value stays structured, while a stricter
            // declaration would have to encode nullable fields the wire schema lacks.
            schema: { type: "object" },
            render: (_args, value) => [
                {
                    type: "text",
                    text: value.mode === "baseline" ? renderBaseline(value) : value.mode === "delta" ? renderDelta(value) : renderUsage(value),
                },
            ],
        },
        async execute(args, exec) {
            const session = exec?.agent?.session;
            if (session === undefined || session === null) {
                throw new Error(`${USAGE_TOOL_NAME} requires an owning agent session`);
            }
            const mode = args?.mode ?? "full";
            if (!USAGE_MODES.includes(mode)) {
                throw new Error(`${USAGE_TOOL_NAME}: unknown mode "${mode}" (use ${USAGE_MODES.join(", ")})`);
            }
            if (mode === "baseline") return buildBaselineReport(ctx, session, args?.verbose);
            if (mode === "delta") return buildDeltaReport(ctx, session, args?.baseline);
            return { mode: "full", ...buildUsageReport(ctx, exec) };
        },
    };
}

export function apply(ctx, config) {
    const cfg = normalizeConfig(config);
    const probe = createProbe(cfg);

    // Model-facing self-overhead report over the host's own projection units.

    // Smart project find + guarded recycle-bin delete (design paper public/插件/0017).
    ctx.effect(() => ctx.tools.register(createProjectFilesTool(probe)), "godot-creator-ui: project_files tool");


    ctx.effect(() => {
        const disposeRoute = ctx.webServer.register({
            kind: "exact",
            path: STATUS_PATH,
            handler: async (req, res) => {
                try {
                    assertTrustedRequest(req);
                    if (req.method !== "GET") {
                        sendJson(res, 405, { error: "method not allowed" });
                        return;
                    }
                    const url = new URL(req.url ?? STATUS_PATH, "http://localhost");
                    sendJson(res, 200, await probe.snapshot(url.searchParams.get("refresh") === "1"));
                } catch (error) {
                    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
                }
            },
        });
        return () => {
            disposeRoute();
            // Release the held MCP session instead of leaving it to the 30-minute idle sweep.
            void probe.dispose();
        };
    }, "godot-creator-ui: status route");
}
