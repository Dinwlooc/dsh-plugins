/**
 * Godot Creator UI — client half (hand-authored lazy-CJS bundle).
 *
 * Format contract: the DSH client module system loads this file as a script that
 * registers one factory under the package name; the browser half materializes it.
 * Only the frozen platform seed (React) is required, so no dsh.client.external row
 * is needed and no build step produced this file.
 *
 * Registers two things:
 *   conversation.session.header.actions  -> status chip (状态显示器)
 *   settings.general.item                -> integration diagnostics card
 */
window.__ModuleLoader__.load({
    id: "godot-creator-ui",
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

        const react = require("react");
        const h = react.createElement;

        const STATUS_API = "/api/godot-creator/status";
        const STYLE_ID = "godot-creator-ui/styles";
        const POLL_MS = 3000;

        const CSS = `
.gcu-chip{display:inline-flex;align-items:center;gap:6px;height:26px;max-width:260px;padding:2px 9px;border:1px solid var(--gcu-line,rgba(71,140,191,.45));border-radius:8px;background:var(--gcu-soft,rgba(71,140,191,.10));color:var(--dsw-alias-label-primary,#1c2430);font:inherit;font-size:12px;cursor:pointer;transition:background 160ms ease,border-color 160ms ease}
.gcu-chip:hover{background:rgba(71,140,191,.18)}
.gcu-chip:focus-visible{outline:2px solid #478cbf;outline-offset:2px}
.gcu-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-dimmed,#9aa5b1)}
.gcu-chip[data-tone=ready] .gcu-dot{background:#3d9a6d}
.gcu-chip[data-tone=playing] .gcu-dot{background:#478cbf;animation:gcu-pulse 1.7s ease-in-out infinite}
.gcu-chip[data-tone=warn] .gcu-dot{background:var(--dsw-alias-state-warn-primary,#c98a12)}
.gcu-chip[data-tone=offline] .gcu-dot{background:var(--dsw-alias-label-dimmed,#9aa5b1)}
.gcu-chip[data-tone=denied] .gcu-dot{background:var(--dsw-alias-state-error-primary,#d2544d)}
.gcu-chip-label{font-weight:650;flex:none}
.gcu-chip-project{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#5b6673);font-size:11px}
.gcu-card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:12px;background:var(--dsw-alias-bg-l1,transparent)}
.gcu-head{display:flex;align-items:flex-start;gap:8px}
.gcu-head-text{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
.gcu-title{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:650;color:var(--dsw-alias-label-primary,#1c2430)}
.gcu-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#5b6673);overflow-wrap:anywhere}
.gcu-btn{flex:none;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#1c2430);font:inherit;font-size:12px;cursor:pointer}
.gcu-btn:hover{background:rgba(127,127,127,.10)}
.gcu-btn:disabled{opacity:.5;cursor:default}
.gcu-grid{display:grid;grid-template-columns:104px minmax(0,1fr);gap:4px 10px;margin:0;font-size:12px}
.gcu-grid dt{color:var(--dsw-alias-label-secondary,#5b6673)}
.gcu-grid dd{margin:0;color:var(--dsw-alias-label-primary,#1c2430);overflow-wrap:anywhere}
.gcu-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}
.gcu-note{font-size:11px;color:var(--dsw-alias-label-dimmed,#8b95a1)}
.gcu-sessions{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.gcu-session{padding:7px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));border-radius:9px;font-size:12px}
.gcu-session b{font-weight:650}
@keyframes gcu-pulse{0%,100%{opacity:1}50%{opacity:.3}}
@media(prefers-reduced-motion:reduce){.gcu-chip[data-tone=playing] .gcu-dot{animation:none}}
`;

        function installStyles() {
            if (typeof document === "undefined") return;
            if (document.getElementById(STYLE_ID) !== null) return;
            const style = document.createElement("style");
            style.id = STYLE_ID;
            style.textContent = CSS;
            document.head.appendChild(style);
        }

        function basename(value) {
            if (typeof value !== "string" || value === "") return undefined;
            const trimmed = value.replace(/[\\/]+$/u, "");
            const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
            return index >= 0 ? trimmed.slice(index + 1) : trimmed;
        }

        function sceneLabel(value) {
            if (typeof value !== "string" || value === "") return undefined;
            return value.startsWith("res://") ? value.slice(6) : value;
        }

        function sessionsOf(snapshot) {
            const sessions = snapshot !== undefined && snapshot.editor !== undefined ? snapshot.editor.sessions : undefined;
            return Array.isArray(sessions) ? sessions : [];
        }

        function reachableOf(snapshot) {
            if (snapshot === undefined) return undefined;
            if (typeof snapshot.reachable === "boolean") return snapshot.reachable;
            // Older host payloads (before the two probes were decoupled).
            return snapshot.backend !== undefined && snapshot.backend.reachable === true;
        }

        function authRejected(snapshot) {
            return snapshot !== undefined && snapshot.auth !== undefined && snapshot.auth.rejected === true;
        }

        function toneOf(snapshot, error) {
            if (snapshot === undefined) return error !== undefined ? "offline" : "pending";
            // Authenticated transports (Godot AI 4.3.0+) answer 401 without the capability:
            // that is "my probe is blind", not "the integration is down".
            if (authRejected(snapshot) && reachableOf(snapshot) !== true) return "denied";
            if (reachableOf(snapshot) !== true) return "offline";
            const sessions = sessionsOf(snapshot);
            if (sessions.length === 0) return "warn";
            const playing = sessions.some((entry) => typeof entry.playState === "string" && entry.playState !== "stopped");
            return playing ? "playing" : "ready";
        }

        function failureReason(snapshot, error) {
            const parts = [];
            if (error !== undefined) parts.push(error);
            if (snapshot?.backend?.error !== undefined) parts.push(`status: ${snapshot.backend.error}`);
            if (snapshot?.editor?.error !== undefined) parts.push(`mcp: ${snapshot.editor.error}`);
            return parts.join("；");
        }

        function summaryOf(snapshot, error) {
            const tone = toneOf(snapshot, error);
            if (tone === "pending") return { label: "检测中", detail: "正在读取本机 godot-ai 状态…" };
            if (tone === "denied") {
                const dir = snapshot?.config?.capabilityDir;
                const port = snapshot?.config?.port;
                return {
                    label: "探测未授权",
                    detail:
                        `Godot AI 传输层返回 401，当前探测没有有效 capability。\n` +
                        `期望文件：${dir ? `${dir}\\http-${port ?? "?"}.json` : "(未配置 capabilityDir)"}\n` +
                        `这只影响状态显示器；DSH 自己的 MCP 工具走 stdio，不受影响。若该 Addon 版本不带此文件，请把插件的 capabilityDir 置空。`,
                };
            }
            if (tone === "offline") {
                const reason = failureReason(snapshot, error);
                return { label: "未连接", detail: `godot-ai 不可达${reason ? `（${reason}）` : ""}` };
            }
            const sessions = sessionsOf(snapshot);
            if (sessions.length === 0) {
                if (snapshot?.editor?.error !== undefined) {
                    const reason = String(snapshot.editor.error);
                    if (/SESSION_LIMIT/u.test(reason)) {
                        return {
                            label: "会话额度用尽",
                            detail:
                                `Godot AI 服务端的并发 MCP 会话额度已满（4.3.0 默认 32 个，空闲 30 分钟才回收），因此状态显示器暂时开不了通道。\n` +
                                `插件已退避，不再继续占用额度；释放方式二选一：\n` +
                                `  · 重启 Godot AI 服务（Godot 里 Godot AI 面板 → Restart Server）——立即生效；\n` +
                                `  · 或等最多 30 分钟让空闲会话被回收。\n` +
                                `这同样只影响状态显示器：DSH 自己的 MCP 工具复用它已有的会话，不受影响。\n原始错误：${reason}`,
                        };
                    }
                    return {
                        label: "会话查询失败",
                        detail: `godot-ai 可用，但会话探测失败：${reason}\n当前用于探测的工具名：${snapshot?.config?.sessionTool ?? "session_manage"}（如该 Addon 版本改名，请改 plugin/cordis.patch.yml 的 sessionTool）`,
                    };
                }
                return { label: "编辑器未打开", detail: "godot-ai 后端在线，但没有已连接的 Godot 编辑器会话" };
            }
            const active = sessions.find((entry) => entry.isActive) ?? sessions[0];
            const project = basename(active.projectPath);
            const scene = sceneLabel(active.currentScene);
            const parts = [];
            if (project !== undefined) parts.push(project);
            if (scene !== undefined) parts.push(basename(scene));
            if (typeof active.playState === "string" && active.playState !== "stopped") parts.push("运行中");
            return { label: parts.length > 0 ? parts.join(" · ") : "已连接", detail: describe(snapshot, active, sessions) };
        }

        function shortSource(value) {
            if (typeof value !== "string" || value === "") return undefined;
            const index = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
            return index >= 0 ? value.slice(index + 1) : value;
        }

        function describe(snapshot, active, sessions) {
            const backend = snapshot.backend;
            const config = snapshot.config ?? {};
            const auth = snapshot.auth ?? {};
            const lines = [
                `端点: ${config.host ?? "127.0.0.1"}:${config.port ?? "?"}（来源：${shortSource(config.portSource) ?? "?"}）· 工具名 ${config.sessionTool ?? "session_manage"}`,
                `传输凭证: ${auth.mode === "bearer" ? `Bearer（${shortSource(auth.source) ?? "已加载"}）` : "无（该版本不需要或未发布）"}${auth.rejected === true ? " · 被拒绝" : ""}${auth.retried === true ? " · 已重读一次" : ""}`,
                `后端: godot-ai ${backend?.serverVersion ?? "?"} · WS ${backend?.wsPort ?? "?"} · 租约 ${backend?.activeLeaseCount ?? "?"}`,
                `编辑器: ${sessions.length} 个会话${active?.name ? ` · ${active.name}` : ""}${active?.godotVersion ? ` · ${active.godotVersion}` : ""}`,
                `项目: ${active?.projectPath ?? "?"}`,
                `当前场景: ${active?.currentScene ?? "?"}`,
                `播放状态: ${active?.playState ?? "?"} · readiness: ${active?.readiness ?? "?"}`,
                `Addon ${active?.addonVersion ?? "?"} / attach 协议 v${active?.protocolVersion ?? "?"}`,
            ];
            if (snapshot.editor?.mcpServerVersion !== undefined) {
                lines.push(
                    `MCP: ${snapshot.editor.mcpServerName ?? "godot-ai"} ${snapshot.editor.mcpServerVersion} · 协议 ${snapshot.editor.mcpProtocolVersion ?? "?"}${snapshot.editor.mcpProtocolNegotiated === true ? "（服务端协商）" : "（客户端提议）"}`,
                );
            }
            if (backend?.reachable !== true && backend?.error !== undefined) lines.push(`status 端点: ${backend.error}`);
            lines.push(`检查时间: ${snapshot.checkedAt}`);
            return lines.join("\n");
        }

        function useSnapshot(pollMs) {
            const [snapshot, setSnapshot] = react.useState(undefined);
            const [error, setError] = react.useState(undefined);
            const [busy, setBusy] = react.useState(false);

            const load = react.useCallback(async (force) => {
                if (force === true) setBusy(true);
                try {
                    const response = await fetch(force === true ? `${STATUS_API}?refresh=1` : STATUS_API, {
                        headers: { accept: "application/json" },
                    });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    setSnapshot(await response.json());
                    setError(undefined);
                } catch (cause) {
                    setError(cause instanceof Error ? cause.message : String(cause));
                } finally {
                    if (force === true) setBusy(false);
                }
            }, []);

            react.useEffect(() => {
                let stopped = false;
                const tick = () => {
                    if (stopped) return;
                    if (typeof document === "undefined" || !document.hidden) void load(false);
                };
                void load(false);
                const timer = setInterval(tick, pollMs);
                return () => {
                    stopped = true;
                    clearInterval(timer);
                };
            }, [load, pollMs]);

            return { snapshot, error, busy, refresh: () => void load(true) };
        }

        /** 状态显示器: compact chip in the session header. */
        function GodotStatusChip() {
            const { snapshot, error, refresh } = useSnapshot(POLL_MS);
            const tone = toneOf(snapshot, error);
            const summary = summaryOf(snapshot, error);
            return h(
                "button",
                {
                    type: "button",
                    className: "gcu-chip",
                    "data-tone": tone,
                    title: summary.detail,
                    onClick: refresh,
                },
                h("span", { className: "gcu-dot" }),
                h("span", { className: "gcu-chip-label" }, "Godot"),
                h("span", { className: "gcu-chip-project" }, summary.label),
            );
        }

        function Row(label, value, mono) {
            return [h("dt", { key: `${label}-k` }, label), h("dd", { key: `${label}-v`, className: mono === true ? "gcu-mono" : undefined }, value)];
        }

        /** 集成诊断卡 in Settings → General. */
        function GodotIntegrationCard() {
            const { snapshot, error, busy, refresh } = useSnapshot(4000);
            const tone = toneOf(snapshot, error);
            const summary = summaryOf(snapshot, error);
            const sessions = sessionsOf(snapshot);
            const backend = snapshot?.backend;

            const config = snapshot?.config ?? {};
            const auth = snapshot?.auth ?? {};
            const rows = [
                Row("端点", `${config.host ?? "127.0.0.1"}:${config.port ?? "?"}（${shortSource(config.portSource) ?? "自动发现"}）`),
                Row(
                    "传输凭证",
                    auth.mode === "bearer"
                        ? `Bearer · ${shortSource(auth.source) ?? "已加载"}${auth.rejected === true ? " · 被拒绝" : ""}${auth.retried === true ? " · 已重读" : ""}`
                        : `无${auth.rejected === true ? " · 但服务端要求凭证（401）" : "（该版本不要求）"}`,
                ),
                Row("会话工具", config.sessionTool ?? "session_manage"),
                Row(
                    "会话通道",
                    /SESSION_LIMIT/u.test(String(snapshot?.editor?.error ?? ""))
                        ? "额度用尽（已退避，等待释放）"
                        : snapshot?.editor?.sessionReused === true
                          ? "复用中（全程 1 个）"
                          : snapshot?.editor?.sessionHeld === true
                            ? "已持有"
                            : "未建立",
                ),
                Row("status 端点", backend?.reachable === true ? `可达 ${config.statusPath ?? "/godot-ai/status"}` : `不可达${backend?.error ? `：${backend.error}` : ""}`),
                Row("后端", backend?.reachable === true ? `godot-ai ${backend.serverVersion ?? "?"}` : "—"),
                Row("后端详情", backend?.reachable === true ? `工具面 ${backend.toolSurface ?? "?"} · 租约 ${backend.activeLeaseCount ?? "?"} · WS ${backend.wsPort ?? "?"}` : "—"),
                Row("attach 协议", `v${backend?.attachProtocolVersion ?? "?"}`),
                Row("工具目录", backend?.toolCatalogHash ?? "—", true),
                Row("MCP 服务", snapshot?.editor?.mcpServerVersion !== undefined ? `${snapshot.editor.mcpServerName ?? "godot-ai"} ${snapshot.editor.mcpServerVersion}` : "—"),
                Row("MCP 协议", snapshot?.editor?.mcpProtocolVersion !== undefined ? `${snapshot.editor.mcpProtocolVersion}${snapshot.editor.mcpProtocolNegotiated === true ? "（服务端协商）" : "（客户端提议）"}` : "—"),
                Row("编辑器会话", sessions.length === 0 ? `无${snapshot?.editor?.error ? `（${snapshot.editor.error}）` : ""}` : `${sessions.length} 个`),
                Row("检查时间", snapshot?.checkedAt ?? "—"),
            ];

            return h(
                "div",
                { className: "gcu-card", "data-tone": tone },
                h(
                    "div",
                    { className: "gcu-head" },
                    h("span", { className: "gcu-dot" }),
                    h(
                        "div",
                        { className: "gcu-head-text" },
                        h("div", { className: "gcu-title" }, "Godot AI 集成"),
                        h("div", { className: "gcu-sub" }, summary.label),
                        h("div", { className: "gcu-note" }, `端点自动发现自 DSH 的 mcp-godot-ai 配置；会话来自 MCP ${config.sessionTool ?? "session_manage"}。`),
                    ),
                    h("button", { type: "button", className: "gcu-btn", onClick: refresh, disabled: busy }, busy ? "刷新中" : "刷新"),
                ),
                h("dl", { className: "gcu-grid" }, rows.flat()),
                sessions.length === 0
                    ? null
                    : h(
                          "ul",
                          { className: "gcu-sessions" },
                          sessions.map((entry) =>
                              h(
                                  "li",
                                  { className: "gcu-session", key: entry.sessionId ?? entry.projectPath },
                                  h("b", null, entry.name ?? entry.sessionId ?? "会话"),
                                  entry.isActive === true ? " · 当前" : "",
                                  h("br"),
                                  `项目 ${entry.projectPath ?? "?"}`,
                                  h("br"),
                                  `场景 ${entry.currentScene ?? "?"} · ${entry.playState ?? "?"} · ${entry.readiness ?? "?"}`,
                              ),
                          ),
                      ),
            );
        }

        const name = "godot-creator-ui/client";
        const inject = ["slots"];

        function apply(ctx) {
            ctx.effect(installStyles, "godot-creator-ui: styles");
            ctx.slots.inject("conversation.session.header.actions", () =>
                ctx.slots.register({ name: "conversation.session.header.actions", id: "godot-creator-ui-status", order: -5 }, () => h(GodotStatusChip)),
            );
            ctx.slots.inject("settings.general.item", () =>
                ctx.slots.register({ name: "settings.general.item", id: "godot-creator-ui-integration", order: 40 }, () => h(GodotIntegrationCard)),
            );
        }

        exports.apply = apply;
        exports.inject = inject;
        exports.name = name;
        return module.exports;
    },
});
