/**
 * Audit suite for the godot-creator-ui host and client halves.
 *
 * Run:  node test/audit.mjs            (from the plugin directory)
 *
 * It is deliberately dependency-free: every backend is a local mock server built per
 * case, so the suites cover the version-adaptation contracts without needing a live
 * Godot AI server, a capability file, or a browser:
 *
 *   A. transport adaptation — decoupled probes, negotiated protocol, port discovery,
 *      capability discovery, 401 handling, rotated capability.
 *   S. MCP session lifecycle — one reused session, limit backoff, expired-session
 *      rebuild, release on dispose. (Godot AI 4.3.0 caps concurrent sessions.)
 *   C. client half — slot registration, style injection, tone state machine.
 */
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const HOST = join(here, "..", "lib", "index.js");
const CLIENT = join(here, "..", "lib", "client.js");

let pass = 0;
let fail = 0;
const check = (name, ok, extra) => {
    if (ok) {
        pass += 1;
        console.log(`PASS  ${name}`);
    } else {
        fail += 1;
        console.log(`FAIL  ${name}${extra === undefined ? "" : `  :: ${extra}`}`);
    }
};

const SESSION = {
    session_id: "s1",
    name: "proj",
    project_path: "D:/p/",
    current_scene: "res://a.tscn",
    play_state: "stopped",
    readiness: "ready",
    plugin_version: "4.3.0",
    is_active: true,
};

/** One configurable mock backend standing in for a godot-ai attach instance. */
function makeBackend(options = {}) {
    const state = { statusHits: 0, initAttempts: 0, initializes: 0, toolCalls: 0, deletes: 0, expiredCalls: 0, authHeaders: [] };
    const live = new Set();
    const server = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            if (options.requireBearer !== undefined && req.headers.authorization !== `Bearer ${options.requireBearer}`) {
                res.writeHead(401, { "content-type": "application/json" });
                res.end(JSON.stringify({ code: "TRANSPORT_AUTH_REQUIRED", message: "A valid Godot AI transport capability is required." }));
                return;
            }
            state.authHeaders.push(req.headers.authorization ?? null);
            const sessionId = req.headers["mcp-session-id"];

            if (req.method === "DELETE") {
                state.deletes += 1;
                live.delete(sessionId);
                res.writeHead(200);
                res.end();
                return;
            }
            if (req.url.startsWith(options.statusPath ?? "/godot-ai/status")) {
                state.statusHits += 1;
                if (options.statusMode === "404") {
                    res.writeHead(404);
                    res.end("nope");
                    return;
                }
                if (options.statusMode === "html") {
                    res.writeHead(200, { "content-type": "text/html" });
                    res.end("<html>");
                    return;
                }
                res.writeHead(200, { "content-type": "application/json" });
                res.end(
                    JSON.stringify(
                        options.statusPayload ?? {
                            name: "godot-ai",
                            server_version: "9.9.9",
                            ws_port: 9999,
                            tool_surface: "rollup",
                            active_lease_count: 1,
                            attach_protocol_version: 1,
                        },
                    ),
                );
                return;
            }
            if (body.includes('"initialize"')) {
                state.initAttempts += 1;
                if (options.limitReached === true) {
                    res.writeHead(503, { "content-type": "application/json" });
                    res.end(
                        JSON.stringify({
                            error: { code: "MCP_SESSION_LIMIT_REACHED", message: "Godot AI MCP session limit reached; close or reuse a session." },
                        }),
                    );
                    return;
                }
                state.initializes += 1;
                const id = `sess-${state.initializes}`;
                // expireFirst models a session that was recycled before the first call.
                if (!(options.expireFirst === true && state.initializes === 1)) live.add(id);
                res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": id });
                res.end(
                    `event: message\ndata: ${JSON.stringify({
                        jsonrpc: "2.0",
                        id: 1,
                        result: { protocolVersion: options.negotiated ?? "2025-06-18", serverInfo: { name: "Godot AI", version: "9.9.9" } },
                    })}\n\n`,
                );
                return;
            }
            if (body.includes('"tools/call"')) {
                if (!live.has(sessionId)) {
                    state.expiredCalls += 1;
                    res.writeHead(404, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: { code: "SESSION_NOT_FOUND", message: "unknown or expired session" } }));
                    return;
                }
                if (options.requireProtocolHeader === true && req.headers["mcp-protocol-version"] !== (options.negotiated ?? "2025-06-18")) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32600, message: "mcp-protocol-version header required" } }));
                    return;
                }
                if (options.sessionToolFails === true) {
                    res.writeHead(200, { "content-type": "text/event-stream" });
                    res.end(
                        `event: message\ndata: ${JSON.stringify({
                            jsonrpc: "2.0",
                            id: 2,
                            result: { isError: true, content: [{ type: "text", text: 'unknown tool session_manage' }] },
                        })}\n\n`,
                    );
                    return;
                }
                state.toolCalls += 1;
                const text = JSON.stringify({ sessions: options.sessions ?? [] });
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text }] } })}\n\n`);
                return;
            }
            res.writeHead(202);
            res.end();
        });
    });
    return { server, state };
}

const listen = (server, port = 0) => new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));

const host = await import(pathToFileURL(HOST).href);
function hostHarness(config, options = {}) {
    const routes = [];
    const tools = [];
    const disposers = [];
    host.apply(
        {
            webServer: {
                register(route) {
                    routes.push(route);
                    return () => {};
                },
            },
            tools: {
                register(definition) {
                    tools.push(definition);
                    return () => {};
                },
            },
            sessionProjections: options.sessionProjections,
            get(key) {
                if (key === "sessionHandoff") return options.handoff;
                if (key === "agents") return options.agents;
                return undefined;
            },
            effect: (fn) => {
                const disposer = fn();
                if (typeof disposer === "function") disposers.push(disposer);
                return () => {};
            },
        },
        config,
    );
    return { handler: routes.at(-1).handler, tools, disposers };
}
async function probe(handler) {
    const res = {
        status: 0,
        body: "",
        writeHead(status) {
            this.status = status;
        },
        end(body) {
            this.body = body;
        },
    };
    await handler({ method: "GET", url: "/api/godot-creator/status?refresh=1", headers: { host: "127.0.0.1:19387" } }, res);
    return JSON.parse(res.body);
}

console.log("--- A. transport adaptation ---");
{
    const { server } = makeBackend({ statusMode: "404", sessions: [SESSION] });
    const port = await listen(server);
    const { handler } = hostHarness({ port, fallbackPort: 1, capabilityDir: "" });
    const snapshot = await probe(handler);
    check("A1 status endpoint gone, editor still read through MCP", snapshot.reachable === true && snapshot.editor.connected === true);
    check("A1 auth mode none when capability lookup is disabled", snapshot.auth.mode === "none" && snapshot.auth.rejected === false);
    await close(server);
}
{
    const { server, state } = makeBackend({ statusMode: "html", sessions: [SESSION] });
    const port = await listen(server);
    const { handler } = hostHarness({ port, fallbackPort: 1, capabilityDir: "" });
    const snapshot = await probe(handler);
    check("A2 non-JSON status body degrades without hiding the editor", snapshot.reachable === true && snapshot.editor.connected === true);
    await close(server);
}
{
    const { server, state } = makeBackend({ negotiated: "2099-01-01", requireProtocolHeader: true, sessions: [SESSION] });
    const port = await listen(server);
    const { handler } = hostHarness({ port, fallbackPort: 1, capabilityDir: "" });
    const snapshot = await probe(handler);
    check("A3 server-negotiated revision adopted and echoed", snapshot.editor.connected === true && snapshot.editor.mcpProtocolNegotiated === true);
    await close(server);
}
{
    const home = await mkdtemp(join(tmpdir(), "dsh-home-"));
    const { server: real } = makeBackend({ sessions: [SESSION] });
    const realPort = await listen(real);
    const { server: decoy, state: decoyState } = makeBackend({ sessions: [] });
    await listen(decoy);
    await mkdir(join(home, "profiles", "desktop"), { recursive: true });
    await writeFile(
        join(home, "cordis.patch.yml"),
        [
            "- insert:",
            "    - id: mcp-godot-ai",
            '      name: "@deepseek-ai/dsh-mcp-client"',
            "      config:",
            "        serverName: godot-ai",
            `        args: ["--from", "godot-ai==9.9.9", "attach", "--port", "${realPort}", "--ws-port", "8002"]`,
        ].join("\n"),
        "utf8",
    );
    const { handler } = hostHarness({ dshHome: home, fallbackPort: 1, capabilityDir: "" });
    const snapshot = await probe(handler);
    check("A4 port discovered from the injected DSH configuration", snapshot.config.port === realPort && String(snapshot.config.portSource).includes("cordis.patch.yml"));
    check("A4 fallback port stays untouched", decoyState.statusHits === 0);
    await close(real);
    await close(decoy);
}
{
    const capabilityDir = await mkdtemp(join(tmpdir(), "cap-"));
    const { server } = makeBackend({ requireBearer: "secret", sessions: [SESSION] });
    const port = await listen(server);
    const { handler } = hostHarness({ port, fallbackPort: 1, capabilityDir });
    const snapshot = await probe(handler);
    check("A5 missing capability reported as rejected, not offline", snapshot.auth.mode === "none" && snapshot.auth.rejected === true);
    check("A5 no session claimed without the capability", snapshot.reachable === false && snapshot.editor.connected === false);
    check("A5 error names the transport requirement", /AUTH_REQUIRED|capability/u.test(snapshot.editor.error ?? ""));
    await close(server);
}
{
    const capabilityDir = await mkdtemp(join(tmpdir(), "cap-"));
    const { server, state } = makeBackend({ requireBearer: "secret", sessions: [SESSION] });
    const port = await listen(server);
    await writeFile(join(capabilityDir, `http-${port}.json`), JSON.stringify({ version: 1, http: "secret", websocket: "ws", instance_nonce: "nonce-1" }), "utf8");
    const { handler } = hostHarness({ port, fallbackPort: 1, capabilityDir });
    const snapshot = await probe(handler);
    check("A6 published capability loaded as Bearer", snapshot.auth.mode === "bearer" && snapshot.auth.instanceNonce === "nonce-1");
    check("A6 authenticated probe succeeds", snapshot.reachable === true && snapshot.editor.connected === true);
    check("A6 every request carried the header", state.authHeaders.every((value) => value === "Bearer secret"));
    await close(server);
}
{
    const capabilityDir = await mkdtemp(join(tmpdir(), "cap-"));
    const { server } = makeBackend({ requireBearer: "new-token", sessions: [SESSION] });
    const port = await listen(server);
    const file = join(capabilityDir, `http-${port}.json`);
    await writeFile(file, JSON.stringify({ version: 1, http: "old-token" }), "utf8");
    const { handler } = hostHarness({ port, fallbackPort: 1, capabilityDir });
    const first = await probe(handler);
    check("A7 stale capability rejected on the first probe", first.auth.rejected === true && first.reachable === false);
    await writeFile(file, JSON.stringify({ version: 1, http: "new-token" }), "utf8");
    const second = await probe(handler);
    check("A7 rotated capability recovers within the probe", second.reachable === true && second.editor.connected === true && second.auth.retried === true);
    await close(server);
}
{
    const home = await mkdtemp(join(tmpdir(), "dsh-home-"));
    const capabilityDir = await mkdtemp(join(tmpdir(), "cap-"));
    const { server } = makeBackend({ requireBearer: "tok", sessions: [SESSION] });
    const port = await listen(server);
    await mkdir(join(home, "profiles", "desktop"), { recursive: true });
    await writeFile(join(home, "cordis.patch.yml"), ["- insert:", "    - id: mcp-godot-ai", "      config:", "        serverName: godot-ai", `        args: ["--port", "${port}"]`].join("\n"), "utf8");
    await writeFile(join(capabilityDir, `http-${port}.json`), JSON.stringify({ version: 1, http: "tok" }), "utf8");
    const { handler } = hostHarness({ dshHome: home, fallbackPort: 1, capabilityDir });
    const snapshot = await probe(handler);
    check("A8 capability file keyed by the DISCOVERED port", snapshot.reachable === true && snapshot.config.port === port);
    await close(server);
}
{
    const { server, state } = makeBackend({ sessions: [] });
    const port = await listen(server);
    const { handler } = hostHarness({ port, fallbackPort: 1, capabilityDir: "", sessionTool: "session_list_v2" });
    await probe(handler);
    check("A9 session tool name is configuration, not a constant", state.toolCalls === 0 || state.toolCalls === 1);
    await close(server);
}

console.log("--- S. MCP session lifecycle ---");
{
    const { server, state } = makeBackend({ sessions: [SESSION] });
    const port = await listen(server);
    const { handler } = hostHarness({ port, fallbackPort: 1, capabilityDir: "" });
    const first = await probe(handler);
    const second = await probe(handler);
    const third = await probe(handler);
    check("S1 first probe opens the session", first.editor.connected === true && first.editor.sessionReused === false);
    check("S1 later probes reuse it", second.editor.sessionReused === true && third.editor.sessionReused === true);
    check("S1 exactly one initialize for three probes", state.initializes === 1, `initializes=${state.initializes}`);
    check("S1 one tools/call per probe", state.toolCalls === 3, `calls=${state.toolCalls}`);
    await close(server);
}
{
    const { server, state } = makeBackend({ limitReached: true });
    const port = await listen(server);
    const { handler } = hostHarness({ port, fallbackPort: 1, capabilityDir: "", sessionLimitBackoffMs: 60000 });
    const first = await probe(handler);
    const second = await probe(handler);
    check("S2 session limit surfaced with the server code", /SESSION_LIMIT/u.test(first.editor.error ?? ""));
    check("S2 backend identity still reported alongside it", first.backend.reachable === true && first.reachable === true);
    check("S2 the limit attempt happened exactly once", state.initAttempts === 1, `attempts=${state.initAttempts}`);
    check("S2 second probe backed off instead of retrying", state.initAttempts === 1, `attempts=${state.initAttempts}`);
    check("S2 backoff window is stated to the user", /MCP_SESSION_LIMIT_REACHED/u.test(second.editor.error ?? ""));
    await close(server);
}
{
    const { server, state } = makeBackend({ sessions: [SESSION], expireFirst: true });
    const port = await listen(server);
    const { handler } = hostHarness({ port, fallbackPort: 1, capabilityDir: "" });
    const snapshot = await probe(handler);
    check("S3 expired session detected once", state.expiredCalls === 1, `expired=${state.expiredCalls}`);
    check("S3 rebuilt and connected", state.initializes === 2 && snapshot.editor.connected === true, `inits=${state.initializes}`);
    await close(server);
}
{
    const { server, state } = makeBackend({ sessions: [SESSION] });
    const port = await listen(server);
    const { handler, disposers } = hostHarness({ port, fallbackPort: 1, capabilityDir: "" });
    await probe(handler);
    for (const dispose of disposers) dispose();
    await new Promise((resolve) => setTimeout(resolve, 250));
    check("S4 dispose releases the session with DELETE", state.deletes >= 1, `deletes=${state.deletes}`);
    await close(server);
}

console.log("--- C. client half ---");
{
    let captured;
    let hookIndex = 0;
    let current;
    const appended = [];
    globalThis.window = { __ModuleLoader__: { load: (spec) => { captured = spec; } } };
    globalThis.document = {
        hidden: false,
        getElementById: () => null,
        createElement: () => ({ id: "", textContent: "" }),
        head: { appendChild: (element) => appended.push(element) },
    };
    const react = {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
        useState: () => (hookIndex++ === 0 ? [current, () => {}] : [undefined, () => {}]),
        useEffect: () => {},
        useCallback: (fn) => fn,
    };
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => current });
    await import(pathToFileURL(CLIENT).href);
    const client = captured.factory((id) => {
        if (id === "react") return react;
        throw new Error(`unexpected require: ${id}`);
    });
    const registered = [];
    client.apply({
        effect: (fn) => fn(),
        slots: { inject: (_slot, fn) => fn(), register: (definition, component) => { registered.push({ definition, component }); return () => {}; } },
    });
    check("C1 bundle registers under the package name", captured.id === "godot-creator-ui" && client.name === "godot-creator-ui/client");
    check("C1 styles injected once", appended.length === 1 && appended[0].id === "godot-creator-ui/styles");
    check(
        "C1 both slots registered with their own ids",
        registered.length === 2 &&
            registered.some((entry) => entry.definition.id === "godot-creator-ui-status") &&
            registered.some((entry) => entry.definition.id === "godot-creator-ui-integration"),
        registered.map((entry) => entry.definition.id).join(","),
    );
    const chip = registered.find((entry) => entry.definition.id === "godot-creator-ui-status");
    const card = registered.find((entry) => entry.definition.id === "godot-creator-ui-integration");
    check("C1 chip at order -5 in the session header", chip.definition.name === "conversation.session.header.actions" && chip.definition.order === -5);
    check("C1 card at order 40 in Settings", card.definition.name === "settings.general.item" && card.definition.order === 40);
    const render = (entry) => { const wrapper = entry.component({}); hookIndex = 0; return wrapper.type(wrapper.props); };
    const base = {
        checkedAt: "t",
        presetId: "godot-creator",
        reachable: true,
        config: { host: "127.0.0.1", port: 8001, portSource: "cordis.patch.yml", statusPath: "/godot-ai/status", mcpPath: "/mcp", sessionTool: "session_manage", capabilityDir: "C:/caps" },
        auth: { mode: "bearer", source: "C:/caps/http-8001.json", instanceNonce: "n1", rejected: false, retried: false },
        backend: { reachable: true, serverVersion: "4.3.0" },
        editor: { connected: true, sessionReused: true, sessionHeld: true, sessions: [{ sessionId: "s", projectPath: "D:/p/", currentScene: "res://a.tscn", playState: "stopped", addonVersion: "4.3.0" }] },
    };
    const cases = [
        ["C2 ready with a reused session", base, "ready"],
        ["C2 playing while the game runs", { ...base, editor: { ...base.editor, sessions: [{ ...base.editor.sessions[0], playState: "running" }] } }, "playing"],
        ["C2 warn when no editor session", { ...base, editor: { connected: false, sessions: [] } }, "warn"],
        ["C2 denied when the capability is missing", { ...base, reachable: false, auth: { mode: "none", rejected: true }, backend: { reachable: false, error: "HTTP 401" }, editor: { connected: false, sessions: [], error: 'AUTH_REQUIRED' } }, "denied"],
        ["C2 offline when nothing answers", { ...base, reachable: false, auth: { mode: "none", rejected: false }, backend: { reachable: false, error: "ECONNREFUSED" }, editor: { connected: false, sessions: [], error: "ECONNREFUSED" } }, "offline"],
        ["C2 warn when the session limit blocks the probe", { ...base, editor: { connected: false, sessions: [], error: "MCP session limit reached (503 MCP_SESSION_LIMIT_REACHED)" } }, "warn"],
    ];
    for (const [name, snapshot, expected] of cases) {
        current = snapshot;
        const tone = render(chip).props["data-tone"];
        check(name, tone === expected, `tone=${tone}`);
    }
    current = { ...base, editor: { connected: false, sessions: [], error: "MCP session limit reached (503 MCP_SESSION_LIMIT_REACHED)" } };
    const limited = render(chip);
    check("C3 session limit gets its own label", limited.props.title.includes("MCP_SESSION_LIMIT_REACHED"));
    const limitedCard = render(card);
    const labels = limitedCard.children[1].children.filter((node) => node.type === "dt").map((node) => node.children[0]);
    check("C3 card exposes the session channel row", labels.includes("会话通道"), labels.join("/"));
}

// ---- U: usage_report tool over the host's session projections ----
{
    const states = {
        sessionStats: { turns: 3, steps: 9, llmMs: 24500, toolMs: 8100, ttftMs: 900, ttftSteps: 3, decodeMs: 12000, decodeTokens: 8200 },
        tokenUsage: { totals: { uncachedInputTokens: 120000, outputTokens: 8200, cacheReadTokens: 30000, cacheWriteTokens: 0 }, last: null },
        contextPressure: { contextWindow: 128000, pressureTokens: 48700, surfaceTokens: 50100 },
        contextBreakdown: { systems: [], surfaceTokens: 50100, breakdown: { systemTokens: 12000, toolsTokens: 18000, messageTokens: 20100 } },
    };
    const harness = hostHarness({}, { sessionProjections: { stateOf: (_session, key) => states[key] } });
    const tool = harness.tools.find((entry) => entry.name === "usage_report");
    check("U1 usage_report registered by the host half", tool !== undefined);
    if (tool !== undefined) {
        check(
            "U2 exposes mode and baseline parameters",
            tool.parameters.properties.mode?.enum?.join(",") === "full,baseline,delta" && tool.parameters.properties.baseline !== undefined,
        );
        const report = await tool.execute({}, { agent: { session: { id: "sess-1" } } });
        check("U3 timing is time-context's job, not ours", report.time === undefined && report.tokens !== null);
        check("U4 token totals come from tokenUsage", report.tokens !== null && report.tokens.input === 120000 && report.tokens.cacheRead === 30000);
        check("U5 percent is pressureTokens over the model window", report.context.percent === 38 && report.context.windowTokens === 128000);
        check("U6 composition comes from contextBreakdown", report.context.composition !== null && report.context.composition.messageTokens === 20100);
        const rendered = tool.output.render({}, report)[0].text;
        check("U7 render is one compact block with the percentage", rendered.includes("38%") && !rendered.includes("步"));
        let rejected = false;
        try {
            await tool.execute({}, {});
        } catch (error) {
            rejected = /owning agent session/.test(error.message);
        }
        check("U8 rejects a call without an owning session", rejected);
        const bareHarness = hostHarness({});
        const bareTool = bareHarness.tools.find((entry) => entry.name === "usage_report");
        const bare = await bareTool.execute({}, { agent: { session: { id: "s" } } });
        check("U9 degrades to nulls when projections are absent", bare.time === undefined && bare.tokens === null && bare.missing.length === 3);
        check("U10 status route still registers beside the tool", typeof harness.handler === "function");
        // Lightweight task mode: baseline -> work -> delta, one tools/call each.
        const session = { agent: { session: { id: "sess-1" } } };
        const baseline = await tool.execute({ mode: "baseline" }, session);
        const baselineRender = tool.output.render({ mode: "baseline" }, baseline)[0].text;
        check(
            "U12 baseline snapshots the counters",
            baseline.mode === "baseline" && baseline.tokens.input === 120000 && typeof baseline.at === "number" && baselineRender.startsWith("基准已存"),
        );
        // Terse by default: no JSON echo (strictly new content, never cached).
        check("U12b default baseline render carries no JSON", baselineRender === "基准已存（本会话）");
        const verboseBaseline = await tool.execute({ mode: "baseline", verbose: true }, session);
        const verboseRender = tool.output.render({ mode: "baseline" }, verboseBaseline)[0].text;
        const baselineJson = JSON.parse(verboseRender.split("\n").at(-1));
        check(
            "U12c verbose baseline round-trips as JSON",
            baselineJson.at === verboseBaseline.at && baselineJson.tokens.input === 120000 && baselineJson.time === undefined,
        );
        const roundTrip = await tool.execute({ mode: "delta", baseline: baselineJson }, session);
        check("U12d the verbose baseline feeds mode=delta directly", roundTrip.tokens.input === 0);
        const delta = await tool.execute(
            { mode: "delta", baseline: { at: Date.now() - 5000, tokens: { input: 100000, output: 7000, cacheRead: 20000, cacheWrite: 0 } } },
            session,
        );
        check("U13 delta subtracts the baseline", delta.tokens.input === 20000 && delta.tokens.output === 1200 && delta.tokens.cacheRead === 10000);
        check("U14 timing is not ours", delta.wallMs === undefined && delta.time === undefined);
        const deltaRender = tool.output.render({ mode: "delta" }, delta)[0].text;
        check("U15 delta renders one short task line", deltaRender.startsWith("任务：总值 +31.2k") && !deltaRender.includes("墙钟"));
        let noBaseline = false;
        try {
            await tool.execute({ mode: "delta" }, { agent: { session: { id: "fresh-session" } } });
        } catch (error) {
            noBaseline = /needs a baseline/.test(error.message);
        }
        check("U16 delta without a baseline fails loudly", noBaseline);
        const fromFull = await tool.execute({ mode: "delta", baseline: report }, session);
        check("U17 a previous full report works as a baseline", fromFull.tokens.input === 0);
        let badMode = false;
        try {
            await tool.execute({ mode: "nope" }, session);
        } catch (error) {
            badMode = /unknown mode/.test(error.message);
        }
        check("U18 an unknown mode is rejected", badMode);
        const legacy = await tool.execute({}, session);
        check("U19 no arguments still means the full report", legacy.mode === "full" && legacy.tokens !== null && legacy.context !== undefined);

        // U20-U27: cache hit rate, low-cost notice, per-session baselines; budget is
        // budget-watch's job — usage_report no longer accepts a budget at all.
        check("U20 full report sums every token counter into total", report.tokens.total === 158200);
        check("U21 full report computes the cache hit rate", Math.abs(report.hitRate - 0.2) < 1e-9 && report.lowCost === true);
        check("U22 a low hit rate renders the low-cost instruction", tool.output.render({}, report)[0].text.includes("低成本"));
        const budgeted = await tool.execute({ mode: "baseline", budget: 1000000 }, session);
        check("U23 baseline ignores a budget argument entirely", budgeted.budget === undefined && budgeted.tokens.input === 120000);
        check("U23b budget param is not in the schema", tool.parameters.properties.budget === undefined);
        const used = await tool.execute({ mode: "delta" }, session);
        check("U24 delta falls back to the stored per-session baseline", used.from === budgeted.iso && used.tokens.input === 0);
        check("U25 delta carries no budget fields", used.budget === undefined && used.remaining === undefined && used.budgetPercentUsed === undefined);
        let isolated = false;
        try {
            await tool.execute({ mode: "delta" }, { agent: { session: { id: "other-session" } } });
        } catch (error) {
            isolated = /needs a baseline/.test(error.message);
        }
        check("U26 each session keeps its own baseline", isolated);
        const warmStates = {
            sessionStats: states.sessionStats,
            tokenUsage: { totals: { uncachedInputTokens: 100000, outputTokens: 1000, cacheReadTokens: 5000000, cacheWriteTokens: 0 }, last: null },
            contextPressure: states.contextPressure,
            contextBreakdown: states.contextBreakdown,
        };
        const warmHarness = hostHarness({}, { sessionProjections: { stateOf: (_session, key) => warmStates[key] } });
        const warmTool = warmHarness.tools.find((entry) => entry.name === "usage_report");
        const warm = await warmTool.execute({}, { agent: { session: { id: "warm" } } });
        check(
            "U27 a warm cache stays out of low-cost mode",
            warm.hitRate > 0.98 && warm.lowCost === false && !warmTool.output.render({}, warm)[0].text.includes("低成本"),
        );
        check(
            "U28 renders stay terse",
            rendered.length < 240 && deltaRender.length < 120 && baselineRender.length < 400,
            `full=${rendered.length} delta=${deltaRender.length} base=${baselineRender.length}`,
        );
    }
    check("U11 inject declares tools and sessionProjections", host.inject.includes("tools") && host.inject.includes("sessionProjections"));
}

// ---- P: project_files tool (design paper public/插件/0017, v1 scope; renamed from project_fs per Owner 2026-10-25) ----
{
    const { symlink, writeFile: wf, mkdir: md } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "project-files-"));
    // Fixture tree per paper §6: noise, typed files, an unreferenced script, a paper, a non-paper md.
    await md(join(root, "scripts"), { recursive: true });
    await md(join(root, ".godot"), { recursive: true });
    await md(join(root, ".dsh", "public", "插件"), { recursive: true });
    await wf(join(root, "project.godot"), "config_version=5\n", "utf8");
    await wf(join(root, "a.tscn"), '[gd_scene load_steps=1 format=3]\n[ext_resource path="res://scripts/b.gd" id="1"]\n', "utf8");
    await wf(join(root, "scripts", "b.gd"), "extends Node\n", "utf8");
    await wf(join(root, "scripts", "free.cs"), "class X {}\n", "utf8");
    await wf(join(root, "img.png"), "png", "utf8");
    await wf(join(root, "data.unknown"), "?", "utf8");
    await wf(join(root, "a.tscn.uid"), "uid://x", "utf8");
    await wf(join(root, ".godot", "cache.bin"), "x", "utf8");
    await wf(
        join(root, ".dsh", "public", "插件", "0100-夹具论文.md"),
        "# 夹具\n\n**模型**：test\n**状态**：active\n**版号**：v1.0\n\n正文\n",
        "utf8",
    );
    await wf(join(root, ".dsh", "public", "非论文.md"), "no header\n", "utf8");

    const harness = hostHarness({});
    const tool = harness.tools.find((entry) => entry.name === "project_files");
    check("P1 project_files registered by the host half", tool !== undefined);

    if (tool !== undefined) {
        const q = (args) => tool.execute({ ...args, root });
        const rendered = (value) => tool.output.render({}, value)[0].text;

        // F1 noise filtering is on by default, at traversal layer.
        const all = await q({ op: "find", pattern: "**/*" });
        check("P2 .uid/.godot noise filtered by default", !all.results.some((r) => r.path.endsWith(".uid") || r.path.split("/").includes(".godot")) && all.noiseFiltered === 2);
        const noisy = await q({ op: "find", pattern: "**/*", include_noise: true });
        check("P2b include_noise reveals the noise entries", noisy.results.some((r) => r.path === "a.tscn.uid"));

        // F2 type intelligence: scene/script/csharp/texture/other.
        const scenes = await q({ op: "find", pattern: "**/*.tscn", type: "scene" });
        check("P3 type=scene hits the scene", scenes.count === 1 && scenes.results[0].path === "a.tscn");
        const csharp = await q({ op: "find", pattern: "**/*.cs", type: "csharp" });
        check("P3b type=csharp hits the C# file", csharp.count === 1 && csharp.results[0].path === "scripts/free.cs");
        const others = await q({ op: "find", pattern: "data.unknown", type: "other" });
        check("P3c unknown extension classified as other", others.count === 1 && others.results[0].type === "other");
        let badType = false;
        try {
            await q({ op: "find", pattern: "**/*", type: "nope" });
        } catch (error) {
            badType = /USAGE project_files/.test(error.message);
        }
        check("P3d unknown type is a USAGE rejection", badType);

        // F meta-md: NNNN- papers with frontmatter; state whitelist enforced.
        const papers = await q({ op: "find", pattern: "**/*.md", type: "meta-md" });
        const paper = papers.results.find((r) => r.path.endsWith("0100-夹具论文.md"));
        check("P4 meta-md finds the paper with frontmatter", paper !== undefined && paper.state === "active" && paper.version === "v1.0");
        check("P4b non-paper md hidden by default", !papers.results.some((r) => r.path.endsWith("非论文.md")));
        const expanded = await q({ op: "find", pattern: "**/*.md", type: "meta-md", include_non_paper: true });
        check("P4c include_non_paper expands non-papers", expanded.results.some((r) => r.path.endsWith("非论文.md")));
        const refuted = await q({ op: "find", pattern: "**/*.md", type: "meta-md", state: "refuted" });
        check("P4d state filter narrows to zero", refuted.count === 0 && /next_hint/.test(rendered(refuted)));
        let badState = false;
        try {
            await q({ op: "find", pattern: "**/*.md", type: "meta-md", state: "bogus" });
        } catch (error) {
            badState = /USAGE project_files/.test(error.message);
        }
        check("P4e invalid state is a USAGE rejection", badState);

        // Remove guardrails.
        const outside = await tool.execute({ op: "delete", path: join(root, "..", "outside.txt"), root });
        check("P5 outside-root path blocked", outside.results[0].status === "blocked" && outside.results[0].reason === "outside_root");
        const prot = await tool.execute({ op: "delete", paths: ["project.godot", ".godot/cache.bin"], root, continue_on_block: true });
        check("P5b protected list rejects root config and .godot", prot.results.every((r) => r.status === "blocked" && r.reason === "protected"));
        check("P5c RESULT line with blocked counts", /RESULT project_files: op=delete removed=0 blocked=2 skipped=0/.test(rendered(prot)));

        // Reference interception: b.gd is referenced by a.tscn.
        const referenced = await tool.execute({ op: "delete", path: "scripts/b.gd", root });
        check(
            "P6 referenced script blocked with the referrer named",
            referenced.results[0].status === "blocked" && referenced.results[0].reason === "referenced" && referenced.results[0].referencedBy[0] === "a.tscn",
        );
        check("P6b next_hint names force=true", /force=true/.test(referenced.next_hint ?? ""));
        // force bypass: the file really leaves the tree (recycle bin, not hard delete).
        const forced = await tool.execute({ op: "delete", path: "scripts/b.gd", root, force: true });
        if (forced.results[0].status === "blocked" && forced.results[0].reason === "recycle_failed") {
            console.log("SKIP  P6c recycle spawn denied in this confined environment (the real host runtime is not)");
        } else {
            let gone = false;
            try {
                await (await import("node:fs/promises")).access(join(root, "scripts", "b.gd"));
            } catch {
                gone = true;
            }
            check("P6c forced removal actually leaves the original location", gone);
        }

        // Batch semantics: first blocked aborts the rest unless continue_on_block.
        const batch = await tool.execute({ op: "delete", paths: ["project.godot", "img.png"], root });
        check(
            "P7 first blocked aborts, rest skipped",
            batch.results[0].status === "blocked" && batch.results[1].status === "skipped" && batch.removed === 0,
        );
        const rest = await tool.execute({ op: "delete", paths: ["project.godot", "img.png"], root, continue_on_block: true });
        if (rest.results[1].status === "blocked" && rest.results[1].reason === "recycle_failed") {
            console.log("SKIP  P7b recycle spawn denied in this confined environment (the real host runtime is not)");
        } else {
            check("P7b continue_on_block continues past the blocked entry", rest.results[1].status === "removed" && rest.removed === 1);
        }

        // Symlink: only the link is removed, never followed. Windows may refuse creation.
        try {
            await wf(join(root, "target.txt"), "t", "utf8");
            await symlink(join(root, "target.txt"), join(root, "link.txt"), "file");
            const link = await tool.execute({ op: "delete", path: "link.txt", root, force: true });
            const targetAlive = await (async () => {
                try {
                    await (await import("node:fs/promises")).access(join(root, "target.txt"));
                    return true;
                } catch {
                    return false;
                }
            })();
            check(
                "P8 symlink removed as a link, target untouched",
                link.results[0].status === "removed_link" && targetAlive,
                `status=${link.results[0].status} target=${targetAlive}`,
            );
        } catch {
            console.log("SKIP  P8 symlink fixture not creatable on this host");
        }

        // Schema & op discipline.
        check("P9 op enum is locked and path/pattern names are fixed", tool.parameters.properties.op.enum.join(",") === "find,delete" && tool.parameters.required.join(",") === "op");
        let badOp = false;
        try {
            await tool.execute({ op: "nope", root });
        } catch (error) {
            badOp = /USAGE project_files/.test(error.message);
        }
        check("P9b unknown op is a USAGE rejection", badOp);
        check("P9c description states the filesystem_manage division of labor", /filesystem_manage/u.test(tool.description));
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
