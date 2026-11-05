/**
 * dsh-meta-tools — client half: the INDEPENDENT "Meta-tools" settings column.
 *
 * Owner ruling 2026-10-29: meta-tools configuration used to be one card inside
 * Settings → General (`settings.general.item`); it is now its own settings
 * section (`settings.section`) holding every meta-tools setting:
 *   - the per-project sign switch (meta_sign ON/OFF)
 *   - the theme presets (switch / add / remove), unchanged in behaviour
 *
 * Pattern copied from the verified dsh-exploration-guard client (HTTP poll +
 * settings.section slot, hand-written module loader handshake, no host
 * primitives). The sign switch does NOT unregister the tool: it edits
 * `.dsh/meta/config.json` ("signEnabled"), and the tool answers with a
 * skip instruction instead of a signature.
 */
window.__ModuleLoader__.load({
    id: "dsh-meta-tools",
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;

        const react = require("react");
        const h = react.createElement;

        const API = "/api/meta-tools/config";
        const STYLE_ID = "dsh-meta-tools/styles";
        const POLL_MS = 4000;

        const STR = {
            zh: {
                section: "Meta-tools 配置",
                title: "Meta-tools",
                subtitle: "元层库（.dsh）的工具与服务配置：签发开关、库主题预设。改动即时生效，不需要重装插件。",
                signTitle: "签发（meta_sign）",
                signHint: "关闭后 meta_sign 仍留在工具面（不卸载，避免上下文缓存失效），但每次调用只回英文报错：项目已禁用签发，并提示模型跳过签发、不要在回复正文里提及。",
                subagentPromptTitle: "子代理专用提示词",
                subagentFileTitle: "提示词文件名",
                subagentFileHint: "…/.dsh/meta/ 下的文件名（单个 .md，不可写路径；非法名回退 SUBAGENTS.md）",
                subagentFilePresent: "已检测到文件，子代理收到该提示词",
                subagentFileMissing: "未检测到文件：子代理当前不会收到任何提示词",
                subagentPromptHint: "开启后，子代理改为注入 .dsh/meta/ 下指定文件的正文（默认 SUBAGENTS.md，可在本栏改名），并整体替换父会话的提示词集；文件名与是否检测到文件都在本栏可见。只影响新建子代理，主会话始终注入。",
                on: "ON",
                off: "OFF",
                loading: "读取中…",
                refresh: "刷新",
                themesTitle: "库主题预设",
                themesHint: "主题只在没有 .dsh 的新工作区自动应用生成文件；已有库只采纳、不重构。",
                active: "当前",
                enable: "启用",
                remove: "删除",
                currentTheme: "当前主题",
                none: "（未选）",
                noThemes: "暂无主题：在 bundle patch 配置的 themes 里声明（theme → taskTypes），或用下方表单新增。",
                newName: "主题名",
                newTypes: "任务类型，逗号分隔",
                addTheme: "新增主题",
                storage: "存储",
                saved: "已保存（即时生效）",
                saving: "保存中…",
                loadFailed: "读取失败",
                saveFailed: "保存失败",
                hasDshYes: "是（主题不自动应用）",
                hasDshNo: "否（首次构建时应用主题）",
                activeUndeletable: "激活中的主题不可删除：先切换再删",
                dshExists: "本工作区已有 .dsh",
            },
            en: {
                section: "Meta Tools",
                title: "Meta-tools",
                subtitle: "Tools and services for the meta library (.dsh): the sign switch and theme presets. Changes apply immediately; no reinstall needed.",
                signTitle: "Signing (meta_sign)",
                signHint: "When OFF the meta_sign tool STAYS on the tool surface (never unregistered — that would invalidate the prompt cache), but every call returns an English error: signing is disabled for this project. It also tells the model to skip signing and not mention it in the reply body.",
                subagentPromptTitle: "Subagent-only prompt",
                subagentFileTitle: "Prompt file name",
                subagentFileHint: "a single .md name under …/.dsh/meta/ (no path; an invalid name falls back to SUBAGENTS.md)",
                subagentFilePresent: "file found — children receive this prompt",
                subagentFileMissing: "file missing — children currently receive no prompt",
                subagentPromptHint: "ON: delegated children are injected with the file under .dsh/meta/ (default SUBAGENTS.md, renameable in this column) instead of the parent prompt set. The column also shows whether the file exists. Applies to newly created children; the main agent is always injected.",
                on: "ON",
                off: "OFF",
                loading: "Loading…",
                refresh: "Refresh",
                themesTitle: "Library theme presets",
                themesHint: "Presets only auto-apply (generate files) in a workspace without .dsh; an existing library is adopted, not restructured.",
                active: "Active",
                enable: "Activate",
                remove: "Remove",
                currentTheme: "Active theme",
                none: "(none)",
                noThemes: "No themes yet: declare them in the bundle patch config (theme → taskTypes), or add one below.",
                newName: "Theme name",
                newTypes: "Task types, comma separated",
                addTheme: "Add theme",
                storage: "Stored in",
                saved: "Saved (applies immediately)",
                saving: "Saving…",
                loadFailed: "Load failed",
                saveFailed: "Save failed",
                hasDshYes: "yes (presets do not auto-apply)",
                hasDshNo: "no (presets apply on first scaffold)",
                activeUndeletable: "The active theme cannot be removed: switch first",
                dshExists: ".dsh in this workspace",
            },
        };

        function pickLocale() {
            try {
                const lang = (document.documentElement.getAttribute("lang") || navigator.language || "en").toLowerCase();
                return lang.startsWith("zh") ? "zh" : "en";
            } catch {
                return "en";
            }
        }

        const CSS = `
.dmt-card{display:flex;flex-direction:column;gap:14px;padding:18px 20px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:12px;background:var(--dsw-alias-bg-l1,transparent)}
.dmt-head{display:flex;align-items:flex-start;gap:10px}
.dmt-head-text{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}
.dmt-title{font-size:15px;font-weight:650;color:var(--dsw-alias-label-primary,#1c2430)}
.dmt-sub{font-size:12px;line-height:1.5;color:#e6ebf1;overflow-wrap:anywhere}
.dmt-row{display:flex;align-items:center;justify-content:space-between;gap:16px}
.dmt-label{display:flex;flex-direction:column;gap:2px;font-size:13px;color:var(--dsw-alias-label-primary,#1c2430)}
.dmt-hint{font-size:11px;line-height:1.5;color:#e6ebf1;max-width:62ch}
.dmt-toggle{flex:none;min-width:64px;padding:6px 14px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:999px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}
.dmt-toggle[data-on=true]{border-color:var(--dsw-alias-state-success-primary,#2f9e6b);color:var(--dsw-alias-state-success-primary,#2f9e6b)}
.dmt-toggle:disabled{opacity:.5;cursor:default}
.dmt-btn{flex:none;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}
.dmt-btn:hover{background:rgba(127,127,127,.10)}
.dmt-btn:disabled{opacity:.5;cursor:default}
.dmt-section-title{font-size:13px;font-weight:650;color:var(--dsw-alias-label-primary,#1c2430)}
.dmt-themes{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.dmt-theme{display:flex;align-items:center;gap:8px;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));border-radius:9px;font-size:12px}
.dmt-theme[data-active=true]{border-color:rgba(71,140,191,.55);background:rgba(71,140,191,.10)}
.dmt-theme-name{font-weight:650;flex:none}
.dmt-theme-types{min-width:0;flex:1;color:#e6ebf1;overflow-wrap:anywhere}
.dmt-badge{flex:none;font-size:11px;color:#e6ebf1}
.dmt-form{display:flex;gap:6px;flex-wrap:wrap}
.dmt-input{height:26px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:7px;font:inherit;font-size:12px;padding:0 8px;background:transparent;color:inherit}
.dmt-footer{display:flex;align-items:center;gap:12px;justify-content:space-between;font-size:11px;color:#e6ebf1;overflow-wrap:anywhere}
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

        function useSettings() {
            const t = STR[pickLocale()];
            const [state, setState] = react.useState(undefined);
            const [error, setError] = react.useState(undefined);
            const [busy, setBusy] = react.useState(false);
            const [status, setStatus] = react.useState("");

            const load = react.useCallback(async () => {
                try {
                    const response = await fetch(API, { headers: { accept: "application/json" } });
                    const body = await response.json();
                    if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
                    setState(body);
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

            const post = react.useCallback(async (payload) => {
                setBusy(true);
                setStatus(t.saving);
                try {
                    const response = await fetch(API, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify(payload),
                    });
                    const body = await response.json();
                    if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
                    setState(body);
                    setError(undefined);
                    setStatus(t.saved);
                } catch (cause) {
                    setError(cause instanceof Error ? cause.message : String(cause));
                    setStatus(t.saveFailed);
                } finally {
                    setBusy(false);
                }
            }, [t]);

            return { state, error, busy, status, reload: load, post };
        }

        function KnobsInline() {
            const st = react.useState(null); const state = st[0]; const setState = st[1];
            const er = react.useState(undefined); const error = er[0]; const setError = er[1];
            react.useEffect(() => {
                let live = true;
                fetch("/api/meta-tools/knobs", { headers: { accept: "application/json" } })
                    .then((r) => r.json())
                    .then((json) => { if (live) setState(json); })
                    .catch((e) => { if (live) setError(String(e && e.message ? e.message : e)); });
                return () => { live = false; };
            }, []);
            const save = (key, value) => {
                fetch("/api/meta-tools/knobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ [key]: value }) })
                    .then((r) => r.json())
                    .then((json) => { if (json && json.ok === true) { setState(json); setError(undefined); } else setError(String(json && json.error ? json.error : "save failed")); })
                    .catch((e) => setError(String(e && e.message ? e.message : e)));
            };
            if (state === null || state.ok !== true) return error === undefined ? h("div", { className: "dmt-hint" }, "读取中…") : h("div", { className: "dmt-error" }, error);
            return h("div", null,
                h("div", { className: "dmt-section-title" }, "开关与数值"),
                error !== undefined ? h("div", { className: "dmt-error" }, error) : null,
                state.fields.map((f) => h("div", { key: f.key, className: "dmt-label" },
                    h("span", null, f.label || f.key),
                    f.type === "boolean"
                        ? h("button", { className: "dmt-toggle", "data-on": state.values[f.key] === true ? "true" : "false", onClick: () => save(f.key, !(state.values[f.key] === true)) }, state.values[f.key] === true ? "已开" : "已关")
                        : f.type === "enum"
                            ? h("select", { className: "dmt-input", defaultValue: state.values[f.key] ?? "", onChange: (e) => save(f.key, e.target.value) },
                                (f.options ?? []).map((o) => h("option", { key: o.value, value: o.value }, o.label ?? o.value)))
                            : f.type === "string"
                                ? h("input", { className: "dmt-input", defaultValue: state.values[f.key] === null ? "" : String(state.values[f.key]), onBlur: (e) => save(f.key, e.target.value) })
                                : h("input", { className: "dmt-input", type: "number", defaultValue: state.values[f.key] === null ? "" : String(state.values[f.key]), onBlur: (e) => save(f.key, Number(e.target.value)) }),
                    f.hint ? h("span", { className: "dmt-hint" }, f.hint) : null)));
        }

        function Panel() {
            const t = STR[pickLocale()];
            const { state, error, busy, status, reload, post } = useSettings();
            const themes = state?.themes ?? {};
            const active = state?.presetTheme ?? "";
            const names = Object.keys(themes);
            const [newName, setNewName] = react.useState("");
            const [newTypes, setNewTypes] = react.useState("");

            const signOn = state?.signEnabled !== false;
const subOn = state?.bootstrapSubagents === true;
            const subPromptOn = state?.subagentPrompt !== false;
            // File-name field: type-ahead autosave (700 ms idle) + Enter/blur save, with a
            // visible state so the column never looks "saved" when it is not.
            const [fileDraft, setFileDraft] = react.useState(null);
            const [fileSave, setFileSave] = react.useState("");
            react.useEffect(() => {
                if (fileDraft === null) return;
                const value = fileDraft.trim();
                const current = state?.subagentPromptFile ?? "";
                if (value === "" || value === current) return;
                const id = setTimeout(() => {
                    setFileSave(t.saving);
                    void post({ subagentPromptFile: value }).then(() => setFileSave(t.saved)).catch(() => setFileSave(t.saveFailed));
                }, 700);
                return () => clearTimeout(id);
            }, [fileDraft, state?.subagentPromptFile, t, post]);
            const addTheme = () => {
                const name = newName.trim();
                const types = newTypes.split(/[,，、]/u).map((v) => v.trim()).filter(Boolean);
                if (name === "" || types.length === 0) return;
                void post({ themes: { ...themes, [name]: { taskTypes: types } } });
                setNewName("");
                setNewTypes("");
            };
            const removeTheme = (name) => {
                const next = { ...themes };
                delete next[name];
                void post({ themes: next });
            };

            const inputStyle = { flex: "0 0 110px" };
            const typesStyle = { flex: "1 1 160px" };

            return h(
                "div",
                { className: "dmt-card" },
                h(KnobsInline),
                h(
                    "div",
                    { className: "dmt-head" },
                    h("div", { className: "dmt-head-text" },
                        h("div", { className: "dmt-title" }, t.title),
                        h("div", { className: "dmt-sub" }, t.subtitle),
                    ),
                    h("button", { type: "button", className: "dmt-btn", onClick: reload }, t.refresh),
                ),

                h("div", { className: "dmt-row" },
                    h("div", { className: "dmt-label" },
                        h("span", null, t.signTitle),
                        h("span", { className: "dmt-hint" }, t.signHint)),
                    h("button", {
                        type: "button",
                        className: "dmt-toggle",
                        "data-on": signOn,
                        disabled: busy || state === undefined,
                        onClick: () => void post({ signEnabled: !signOn }),
                    }, signOn ? t.on : t.off)),

                h("div", { className: "dmt-row" },
                    h("div", { className: "dmt-label" },
                        h("span", null, t.subagentPromptTitle),
                        h("span", { className: "dmt-hint" }, t.subagentPromptHint)),
                    h("div", { className: "dmt-form" },
                        h("input", {
                            className: "dmt-input",
                            style: { flex: "0 0 180px" },
                            value: fileDraft ?? state?.subagentPromptFile ?? "SUBAGENTS.md",
                            placeholder: "SUBAGENTS.md",
                            title: t.subagentFileHint,
                            onChange: (e) => { setFileDraft(e.target.value); setFileSave(""); },
                            onBlur: (e) => {
                                const value = e.target.value.trim();
                                if (value !== "" && value !== (state?.subagentPromptFile ?? "")) {
                                    setFileSave(t.saving);
                                    void post({ subagentPromptFile: value }).then(() => setFileSave(t.saved)).catch(() => setFileSave(t.saveFailed));
                                }
                            },
                            onKeyDown: (e) => { if (e.key === "Enter") { e.currentTarget.blur(); } },
                        }),
                        h("button", {
                            type: "button",
                            className: "dmt-toggle",
                            "data-on": subPromptOn,
                            disabled: busy || state === undefined,
                            onClick: () => void post({ subagentPrompt: !subPromptOn }),
                        }, subPromptOn ? t.on : t.off)),
                    h("span", { className: "dmt-hint" }, (state?.subagentPromptPresent === true ? t.subagentFilePresent : t.subagentFileMissing) + (fileSave ? " · " + fileSave : ""))),

                h("div", { className: "dmt-label" },
                    h("span", { className: "dmt-section-title" }, t.themesTitle),
                    h("span", { className: "dmt-hint" }, t.themesHint)),

                names.length === 0
                    ? h("div", { className: "dmt-hint" }, t.noThemes)
                    : h("ul", { className: "dmt-themes" },
                        names.map((name) => h("li", { className: "dmt-theme", key: name, "data-active": name === active },
                            h("span", { className: "dmt-theme-name" }, name),
                            h("span", { className: "dmt-theme-types" }, (themes[name]?.taskTypes ?? []).join("、") || "-"),
                            name === active
                                ? h("span", { className: "dmt-badge" }, t.active)
                                : h("button", { type: "button", className: "dmt-btn", disabled: busy, onClick: () => void post({ theme: name }) }, t.enable),
                            h("button", {
                                type: "button",
                                className: "dmt-btn",
                                disabled: busy || name === active,
                                title: name === active ? t.activeUndeletable : t.remove,
                                onClick: () => removeTheme(name),
                            }, t.remove),
                        ))),

                h("div", { className: "dmt-form" },
                    h("input", { className: "dmt-input", style: inputStyle, value: newName, placeholder: t.newName, onChange: (e) => setNewName(e.target.value) }),
                    h("input", { className: "dmt-input", style: typesStyle, value: newTypes, placeholder: t.newTypes, onChange: (e) => setNewTypes(e.target.value) }),
                    h("button", { type: "button", className: "dmt-btn", disabled: busy, onClick: addTheme }, t.addTheme)),

                h("div", { className: "dmt-footer" },
                    h("span", null, state === undefined
                        ? t.loading
                        : `${t.currentTheme}: ${active || t.none} · ${t.dshExists}: ${state.hasDsh ? t.hasDshYes : t.hasDshNo} · ${t.storage}: ${state.storage ?? ".dsh/meta/config.json"}`),
                    h("span", null, status)),

                error !== undefined ? h("div", { className: "dmt-error" }, `${t.loadFailed} / ${t.saveFailed}: ${error}`) : null,
            );
        }

        function apply(ctx) {
            ctx.effect(installStyles, "dsh-meta-tools: styles");
            const label = STR[pickLocale()].section;
            ctx.slots.inject("settings.section", () =>
                ctx.slots.register({ name: "settings.section", id: "dsh-meta-tools", order: 630, label }, () => h(Panel)),
            );
        }

        exports.apply = apply;
        exports.inject = ["slots"];
        exports.name = "dsh-meta-tools/client";
        return module.exports;
    },
});
