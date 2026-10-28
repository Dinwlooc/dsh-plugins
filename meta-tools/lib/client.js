/**
 * dsh-meta-tools — client half: theme-preset card in Settings → General.
 * Pattern copied from the verified godot-creator-ui client (HTTP poll +
 * settings.general.item slot); theme tokens only, no host primitives.
 */
window.__ModuleLoader__.load({
    id: "dsh-meta-tools",
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;

        const react = require("react");
        const h = react.createElement;

        const THEME_API = "/api/meta-tools/theme";
        const STYLE_ID = "dsh-meta-tools/styles";
        const POLL_MS = 4000;

        const CSS = `
.dmt-card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:12px;background:var(--dsw-alias-bg-l1,transparent)}
.dmt-head{display:flex;align-items:flex-start;gap:8px}
.dmt-head-text{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
.dmt-title{font-size:13px;font-weight:650;color:var(--dsw-alias-label-primary,#1c2430)}
.dmt-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#5b6673);overflow-wrap:anywhere}
.dmt-note{font-size:11px;color:var(--dsw-alias-label-dimmed,#8b95a1)}
.dmt-btn{flex:none;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#1c2430);font:inherit;font-size:12px;cursor:pointer}
.dmt-btn:hover{background:rgba(127,127,127,.10)}
.dmt-btn:disabled{opacity:.5;cursor:default}
.dmt-themes{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.dmt-theme{display:flex;align-items:center;gap:8px;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));border-radius:9px;font-size:12px}
.dmt-theme[data-active=true]{border-color:rgba(71,140,191,.55);background:rgba(71,140,191,.10)}
.dmt-theme-name{font-weight:650;flex:none}
.dmt-theme-types{min-width:0;flex:1;color:var(--dsw-alias-label-secondary,#5b6673);overflow-wrap:anywhere}
.dmt-badge{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary,#5b6673)}
.dmt-error{font-size:12px;color:var(--dsw-alias-state-error-primary,#d2544d);overflow-wrap:anywhere}
`;

        function installStyles() {
            if (typeof document === "undefined") return;
            if (document.getElementById(STYLE_ID) !== null) return;
            const style = document.createElement("style");
            style.id = STYLE_ID;
            style.textContent = CSS;
            document.head.appendChild(style);
        }

        function useThemeState() {
            const [state, setState] = react.useState(undefined);
            const [error, setError] = react.useState(undefined);
            const [busy, setBusy] = react.useState(false);
            const load = react.useCallback(async () => {
                try {
                    const response = await fetch(THEME_API, { headers: { accept: "application/json" } });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    setState(await response.json());
                    setError(undefined);
                } catch (cause) {
                    setError(cause instanceof Error ? cause.message : String(cause));
                }
            }, []);
            react.useEffect(() => {
                let stopped = false;
                const tick = () => {
                    if (stopped) return;
                    if (typeof document === "undefined" || !document.hidden) void load();
                };
                void load();
                const timer = setInterval(tick, POLL_MS);
                return () => {
                    stopped = true;
                    clearInterval(timer);
                };
            }, [load]);
            const switchTheme = react.useCallback(async (name) => {
                setBusy(true);
                try {
                    const response = await fetch(THEME_API, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ theme: name }),
                    });
                    const body = await response.json();
                    if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
                    setState(body);
                    setError(undefined);
                } catch (cause) {
                    setError(cause instanceof Error ? cause.message : String(cause));
                } finally {
                    setBusy(false);
                }
            }, []);
            // Author the WHOLE themes table (H round 10): one volatile dict cell; the
            // dsh Settings row persists edits to the profile patch — the card mirrors
            // Settings by posting the full map after add/remove.
            const writeThemes = react.useCallback(async (nextThemes) => {
                setBusy(true);
                try {
                    const response = await fetch(THEME_API, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ themes: nextThemes }),
                    });
                    const body = await response.json();
                    if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
                    setState(body);
                    setError(undefined);
                } catch (cause) {
                    setError(cause instanceof Error ? cause.message : String(cause));
                } finally {
                    setBusy(false);
                }
            }, []);
            const [newName, setNewName] = react.useState("");
            const [newTypes, setNewTypes] = react.useState("");
            const addTheme = react.useCallback(() => {
                const name = newName.trim();
                const types = newTypes.split(/[,，、]/u).map((t) => t.trim()).filter(Boolean);
                if (name === "" || types.length === 0) return;
                void writeThemes({ ...(state?.themes ?? {}), [name]: { taskTypes: types } });
                setNewName("");
                setNewTypes("");
            }, [newName, newTypes, state, writeThemes]);
            const removeTheme = react.useCallback((name) => {
                const next = { ...(state?.themes ?? {}) };
                delete next[name];
                void writeThemes(next);
            }, [state, writeThemes]);
            return { state, error, busy, switchTheme, writeThemes, addTheme, removeTheme, newName, setNewName, newTypes, setNewTypes, reload: load };
        }

        function ThemeCard() {
            const { state, error, busy, switchTheme, writeThemes, addTheme, removeTheme, newName, setNewName, newTypes, setNewTypes, reload } = useThemeState();
            const themes = state?.themes ?? {};
            const active = state?.presetTheme ?? "";
            const names = Object.keys(themes);
            return h(
                "div",
                { className: "dmt-card" },
                h(
                    "div",
                    { className: "dmt-head" },
                    h("div", { className: "dmt-head-text" },
                        h("div", { className: "dmt-title" }, "Meta 库主题预设"),
                        h("div", { className: "dmt-sub" }, state === undefined
                            ? "读取中…"
                            : `当前主题：${active || "（未选）"} · 本工作区已有 .dsh：${state.hasDsh ? "是" : "否"}`),
                        h("div", { className: "dmt-note" },
                            "主题只在无 .dsh 的新工作区自动应用生成文件；已有库只采纳、不重构。切换即时生效；持久化请在下方 dsh 设置项或 patch 配置里改 presetTheme。"),
                    ),
                    h("button", { type: "button", className: "dmt-btn", onClick: reload }, "刷新"),
                ),
                names.length === 0
                    ? h("div", { className: "dmt-note" }, "暂无主题：在 bundle patch 配置的 themes 里声明（theme → taskTypes）。")
                    : h("ul", { className: "dmt-themes" },
                        names.map((name) => h("li", { className: "dmt-theme", key: name, "data-active": name === active },
                            h("span", { className: "dmt-theme-name" }, name),
                            h("span", { className: "dmt-theme-types" }, (themes[name]?.taskTypes ?? []).join("、") || "(空)"),
                            name === active
                                ? h("span", { className: "dmt-badge" }, "当前")
                                : h("button", { type: "button", className: "dmt-btn", disabled: busy, onClick: () => void switchTheme(name) }, "启用"),
                            h("button", { type: "button", className: "dmt-btn", disabled: busy || name === active, title: name === active ? "激活中的主题不可删除：先切换再删" : "删除该主题", onClick: () => removeTheme(name) }, "删除"),
                        ))),
                h("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap" } },
                    h("input", { value: newName, placeholder: "主题名", onChange: (e) => setNewName(e.target.value), style: { flex: "0 0 110px", height: "26px", border: "1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16))", borderRadius: "7px", font: "inherit", fontSize: "12px", padding: "0 8px", background: "transparent", color: "var(--dsw-alias-label-primary,#1c2430)" } }),
                    h("input", { value: newTypes, placeholder: "任务类型，逗号分隔", onChange: (e) => setNewTypes(e.target.value), style: { flex: "1 1 160px", height: "26px", border: "1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16))", borderRadius: "7px", font: "inherit", fontSize: "12px", padding: "0 8px", background: "transparent", color: "var(--dsw-alias-label-primary,#1c2430)" } }),
                    h("button", { type: "button", className: "dmt-btn", disabled: busy, onClick: addTheme }, "新增主题"),
                ),
                h("div", { className: "dmt-note" }, "增删即写 themes 单元并同步 dsh 设置（设置里的编辑会持久化到 profile patch，跨重启保留）。激活中的主题不可删除：先切换再删。"),
                error !== undefined ? h("div", { className: "dmt-error" }, `读取/切换失败：${error}`) : null,
            );
        }

        function apply(ctx) {
            ctx.effect(installStyles, "dsh-meta-tools: styles");
            ctx.slots.inject("settings.general.item", () =>
                ctx.slots.register({ name: "settings.general.item", id: "dsh-meta-tools-theme", order: 41 }, () => h(ThemeCard)),
            );
        }

        exports.apply = apply;
        exports.inject = ["slots"];
        exports.name = "dsh-meta-tools/client";
        return module.exports;
    },
});
