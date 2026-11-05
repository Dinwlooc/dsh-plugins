/**
 * dsh-budget-watch — client half: Settings section with live editable knobs.
 * Registration follows the verified settings.section form (same as dsh-meta-tools).
 * Data path: GET/POST /api/budget-watch/config (whole-object patch; unknown keys are rejected).
 */
window.__ModuleLoader__.load({
    id: "dsh-budget-watch",
    factory: (require) => {
        const react = require("react");
        const h = react.createElement;
        const API = "/api/budget-watch/config";
        const STYLE_ID = "dsh-budget-watch/styles";
        const CSS = ".st-card{display:flex;flex-direction:column;gap:12px;padding:18px 20px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:12px}.st-title{font-size:15px;font-weight:650}.st-sub{font-size:12px;line-height:1.5;color:#e6ebf1}.st-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:6px 0;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18))}.st-label{display:flex;flex-direction:column;gap:2px;font-size:13px}.st-hint{font-size:11px;line-height:1.5;color:#e6ebf1;max-width:52ch}.st-toggle{flex:none;min-width:64px;padding:6px 14px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:999px;background:transparent;cursor:pointer;font-size:12px;color:inherit}.st-toggle[data-on=true]{border-color:var(--dsw-alias-state-success-primary,#2f9e6b);color:var(--dsw-alias-state-success-primary,#2f9e6b)}.st-input{flex:none;width:180px;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:12px}.st-err{font-size:12px;color:var(--dsw-alias-state-error-primary,#d2544d)}.bw-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:2px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:999px;font-size:12px;white-space:nowrap}.bw-chip[data-tone=\"ok\"]{color:#2e7d32}.bw-chip[data-tone=\"warn\"]{color:#b26a00}.bw-chip[data-tone=\"stop\"]{color:#c62828}.bw-dot{width:6px;height:6px;border-radius:50%;background:currentColor}";
        function ensureStyle() {
            if (document.getElementById(STYLE_ID) !== null) return;
            const el = document.createElement("style");
            el.id = STYLE_ID;
            el.textContent = CSS;
            document.head.appendChild(el);
        }
        const PANEL = "/api/budget-watch/panel";
        function Chip(props) {
            const sessionId = props && typeof props.sessionId === "string" && props.sessionId !== "" ? props.sessionId : null;
            const endpoint = PANEL + (sessionId === null ? "" : "?session=" + encodeURIComponent(sessionId));
            const [state, setState] = react.useState(null);
            react.useEffect(() => {
                let live = true;
                const load = () => fetch(endpoint, { headers: { accept: "application/json" } })
                    .then((r) => (r.ok ? r.json() : null))
                    .then((json) => { if (live) setState(json); })
                    .catch(() => { if (live) setState(null); });
                load();
                const timer = setInterval(load, 3000);
                return () => { live = false; clearInterval(timer); };
            }, []);
                        if (!state) return null;
            if (state.ok !== true) {
                const why = state.reason === "ambiguous-session" ? "多会话，无法确定示数" : state.reason === "no-ledger" ? "本会话尚无记录" : "读取失败";
                return h("span", { className: "bw-chip", "data-tone": "ok", title: why }, h("span", { className: "bw-dot" }), h("span", null, "缓存读取 —"));
            }
            const pct = typeof state.stepPct === "number" ? state.stepPct * 100 : 0;
            const step = typeof state.stepHit === "number" ? state.stepHit : 0;
            const tokens = typeof state.stepHitTokens === "number" ? state.stepHitTokens : 0;
            const coldStart = typeof state.coldStart === "number" ? state.coldStart : 0;
            const tone = state.level === "stop" ? "stop" : state.level === "warn" ? "warn" : "ok";
            const budget = typeof state.budgetPct === "number" ? " · 预算 " + Math.round(state.budgetPct * 100) + "%" : "";
            return h("span", { className: "bw-chip", "data-tone": tone, title: "本步缓存读取 " + Math.round(tokens || 0) + " tok，折算 " + Math.round(step || 0) + " ÷ 冷启动 " + Math.round(coldStart || 0) + (pct > 0 ? "；每 " + Math.round(100 / pct) + " 步 ≈ 一次冷启动" : "") },
                h("span", { className: "bw-dot" }),
                h("span", null, "缓存读取 " + pct.toFixed(1) + "%" + budget));
        }
        function post(patch, done) {
            fetch(API, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(patch) })
                .then((r) => r.json())
                .then((json) => done(json))
                .catch((error) => done({ ok: false, error: String(error && error.message ? error.message : error) }));
        }
        function asText(value) {
            if (Array.isArray(value)) return value.join(", ");
            return value === null || value === undefined ? "" : String(value);
        }
        function Row(props) {
            const field = props.field;
            const value = props.value;
            const commit = (next) => { if (JSON.stringify(next) !== JSON.stringify(value)) props.onSave(field.key, next); };
            let control;
            if (field.type === "boolean") {
                control = h("button", { className: "st-toggle", "data-on": value === true ? "true" : "false", disabled: props.busy, onClick: () => commit(!(value === true)) }, value === true ? "已开" : "已关");
            } else if (field.type === "enum") {
                control = h("select", { className: "st-input", value: asText(value), disabled: props.busy, onChange: (e) => commit(e.target.value) },
                    (field.options || []).map((option) => h("option", { key: option.value, value: option.value }, option.label || option.value)));
            } else if (field.type === "number") {
                control = h("input", { className: "st-input", type: "number", defaultValue: asText(value), min: field.min, max: field.max, disabled: props.busy, onBlur: (e) => commit(Number(e.target.value)), onKeyDown: (e) => { if (e.key === "Enter") e.target.blur(); } });
            } else if (field.type === "numberList") {
                control = h("input", { className: "st-input", type: "text", defaultValue: asText(value), disabled: props.busy, onBlur: (e) => commit(String(e.target.value).split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))), onKeyDown: (e) => { if (e.key === "Enter") e.target.blur(); } });
            } else if (field.type === "stringList") {
                control = h("input", { className: "st-input", type: "text", defaultValue: asText(value), disabled: props.busy, onBlur: (e) => commit(String(e.target.value).split(",").map((s) => s.trim()).filter(Boolean)), onKeyDown: (e) => { if (e.key === "Enter") e.target.blur(); } });
            } else {
                control = h("input", { className: "st-input", type: "text", defaultValue: asText(value), disabled: props.busy, onBlur: (e) => commit(String(e.target.value)), onKeyDown: (e) => { if (e.key === "Enter") e.target.blur(); } });
            }
            return h("div", { className: "st-row" },
                h("div", { className: "st-label" }, h("span", null, field.label || field.key), field.hint ? h("span", { className: "st-hint" }, field.hint) : null),
                control);
        }
        function Panel() {
            ensureStyle();
            const [state, setState] = react.useState(null);
            const [error, setError] = react.useState(null);
            const [busy, setBusy] = react.useState(false);
            react.useEffect(() => {
                let live = true;
                fetch(API, { headers: { accept: "application/json" } })
                    .then((r) => r.json())
                    .then((json) => { if (live) setState(json); })
                    .catch((err) => { if (live) setError(String(err && err.message ? err.message : err)); });
                return () => { live = false; };
            }, []);
            if (error !== null) return h("div", { className: "st-card" }, h("div", { className: "st-err" }, error));
            if (state === null || state.ok !== true) return h("div", { className: "st-card" }, h("div", { className: "st-sub" }, "读取中…"));
            const save = (key, value) => {
                setBusy(true);
                post({ [key]: value }, (json) => {
                    setBusy(false);
                    if (json && json.ok === true) { setState(json); setError(null); }
                    else setError(String(json && json.error ? json.error : "保存失败"));
                });
            };
            return h("div", { className: "st-card" },
                h("div", { className: "st-title" }, "预算看门狗"),
                h("div", { className: "st-sub" }, "改动即时生效并写入 ~/.dsh/dsh-budget-watch/config.json；开关不改变工具面。"),
                error !== null ? h("div", { className: "st-err" }, error) : null,
                state.fields.map((field) => h(Row, { key: field.key, field, value: state.values[field.key], onSave: save, busy })));
        }
        const inject = ["slots"];
        function apply(ctx) {
            if (!ctx || !ctx.slots) return;
            if (typeof ctx.effect === "function") ctx.effect(ensureStyle, "dsh-budget-watch: styles");
            else ensureStyle();
            ctx.slots.inject("conversation.session.header.actions", () =>
                ctx.slots.register({ name: "conversation.session.header.actions", id: "dsh-budget-watch-panel", order: -6 }, (props) => h(Chip, props)));
            ctx.slots.inject("settings.section", () =>
                ctx.slots.register({ name: "settings.section", id: "dsh-budget-watch", order: 650, label: "预算看门狗" }, () => h(Panel)));
        }
        return { inject, apply };
    },
});