/**
 * dsh-request-guard — client half: Settings card with live toggles.
 *
 * Format contract: one factory under the package name; the host resolves this
 * file through package.json "exports[ './client' ]". Registration follows the
 * verified settings.section form (same as dsh-meta-tools).
 *
 * Data path: GET  /api/request-guard/config -> { values, fields }
 *            POST /api/request-guard/config -> { key: value } (whole-object patch)
 */
window.__ModuleLoader__.load({
    id: "dsh-request-guard",
    factory: (require) => {
        const react = require("react");
        const h = react.createElement;
        const API = "/api/request-guard/config";
        const STYLE_ID = "dsh-request-guard/styles";
        const CSS = ""
            + ".rg-card{display:flex;flex-direction:column;gap:12px;padding:18px 20px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:12px}"
            + ".rg-title{font-size:15px;font-weight:650;color:var(--dsw-alias-label-primary,#1c2430)}"
            + ".rg-sub{font-size:12px;line-height:1.5;color:#e6ebf1}"
            + ".rg-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:6px 0;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18))}"
            + ".rg-label{display:flex;flex-direction:column;gap:2px;font-size:13px}"
            + ".rg-hint{font-size:11px;line-height:1.5;color:#e6ebf1;max-width:52ch}"
            + ".rg-toggle{flex:none;min-width:64px;padding:6px 14px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:999px;background:transparent;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-primary,#1c2430)}"
            + ".rg-toggle[data-on=true]{border-color:var(--dsw-alias-state-success-primary,#2f9e6b);color:var(--dsw-alias-state-success-primary,#2f9e6b)}"
            + ".rg-input{flex:none;width:140px;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:12px}"
            + ".rg-error{font-size:12px;color:var(--dsw-alias-state-error-primary,#d2544d)}";

        function ensureStyle() {
            if (document.getElementById(STYLE_ID) !== null) return;
            const style = document.createElement("style");
            style.id = STYLE_ID;
            style.textContent = CSS;
            document.head.appendChild(style);
        }

        function post(patch, done) {
            fetch(API, {
                method: "POST",
                headers: { "content-type": "application/json", accept: "application/json" },
                body: JSON.stringify(patch),
            })
                .then((r) => r.json())
                .then((json) => done(json))
                .catch((error) => done({ ok: false, error: String(error && error.message ? error.message : error) }));
        }

        function Row({ field, value, onSave, busy }) {
            const commit = (next) => { if (next !== value) onSave(field.key, next); };
            let control;
            if (field.type === "boolean") {
                control = h("button", {
                    className: "rg-toggle",
                    "data-on": value === true ? "true" : "false",
                    disabled: busy,
                    onClick: () => commit(!(value === true)),
                }, value === true ? "已开" : "已关");
            } else if (field.type === "number") {
                control = h("input", {
                    className: "rg-input",
                    type: "number",
                    defaultValue: value === null || value === undefined ? "" : String(value),
                    min: field.min,
                    max: field.max,
                    disabled: busy,
                    onBlur: (event) => commit(Number(event.target.value)),
                    onKeyDown: (event) => { if (event.key === "Enter") event.target.blur(); },
                });
            } else {
                control = h("input", {
                    className: "rg-input",
                    type: "text",
                    defaultValue: value === null || value === undefined ? "" : String(value),
                    disabled: busy,
                    onBlur: (event) => commit(String(event.target.value)),
                    onKeyDown: (event) => { if (event.key === "Enter") event.target.blur(); },
                });
            }
            return h("div", { className: "rg-row" },
                h("div", { className: "rg-label" },
                    h("span", null, field.label || field.key),
                    field.hint ? h("span", { className: "rg-hint" }, field.hint) : null),
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
            if (error !== null) return h("div", { className: "rg-card" }, h("div", { className: "rg-error" }, error));
            if (state === null || state.ok !== true) return h("div", { className: "rg-card" }, h("div", { className: "rg-sub" }, "读取中…"));
            const save = (key, value) => {
                setBusy(true);
                post({ [key]: value }, (json) => {
                    setBusy(false);
                    if (json && json.ok === true) { setState(json); setError(null); }
                    else setError(String(json && json.error ? json.error : "保存失败"));
                });
            };
            return h("div", { className: "rg-card" },
                h("div", { className: "rg-title" }, "请求守卫"),
                h("div", { className: "rg-sub" }, "改动即时生效并写入 ~/.dsh/request-guard/config.json；工具面不因开关改变。"),
                error !== null ? h("div", { className: "rg-error" }, error) : null,
                state.fields.map((field) => h(Row, { key: field.key, field, value: state.values[field.key], onSave: save, busy })));
        }

        const inject = ["slots"];
        function apply(ctx) {
            if (!ctx || !ctx.slots) return;
            if (typeof ctx.effect === "function") ctx.effect(ensureStyle, "dsh-request-guard: styles");
            else ensureStyle();
            ctx.slots.inject("settings.section", () =>
                ctx.slots.register({ name: "settings.section", id: "dsh-request-guard", order: 640, label: "请求守卫" }, () => h(Panel)));
        }

        return { inject, apply };
    },
});
