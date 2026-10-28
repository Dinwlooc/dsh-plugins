/**
 * meta_theme — view/switch the meta-library theme preset.
 *
 * One operation, two callers (user-actions rule): the Settings UI card calls the
 * SAME ops via the plugin's HTTP route (/api/meta-tools/theme), and the agent
 * calls them through this tool. `set` mutates the volatile cell in place — the
 * live effect matches the dsh Settings toggle; persistence across restart stays
 * with dsh Settings / patch config (identical to Settings).
 */
import { setPresetTheme, setThemes, themeState } from "./library.js";

export const THEME_TOOL_NAME = "meta_theme";

function renderState(value) {
    const themes = Object.entries(value.themes ?? {})
        .map(([name, def]) => `${name}: ${(def?.taskTypes ?? []).join("、") || "(空)"}`)
        .join("\n");
    return [
        `当前主题：${value.presetTheme || "(未选)"}`,
        `主题清单：\n${themes || "(无)"}`,
        `本工作区已存在 .dsh：${value.hasDsh ? "是 → 主题不自动应用，仅采纳现有结构" : "否 → 主题将在首次构建时自动应用生成文件"}`,
        `切换：meta_theme {action:"set", theme:"<名称>"}（即时生效；持久化请在 dsh 设置或 patch 配置里改 presetTheme）`,
    ].join("\n");
}

export function createThemeTool(cfg) {
    return {
        name: THEME_TOOL_NAME,
        description:
            "View, switch, or author the meta-library theme presets (theme → taskTypes). action=get (default) shows themes, the active theme and whether this workspace's .dsh exists; action=set switches the active theme live; action=setThemes replaces the whole themes table live (the dsh Settings row for `themes` persists it to the profile patch). Theme presets only AUTO-APPLY in workspaces without .dsh.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                action: { type: "string", enum: ["get", "set", "setThemes"], description: "get (default) | set (switch active theme) | setThemes (author the whole themes table)" },
                theme: { type: "string", description: "action=set only: the theme name to activate" },
                themes: {
                    type: "object",
                    additionalProperties: true,
                    description: 'action=setThemes only: the whole table { "<name>": { taskTypes: ["..."] } } — replaces all themes live; the dsh Settings row persists it to the profile patch',
                },
            },
        },
        output: {
            schema: { type: "object" },
            render: (_args, value) => [{ type: "text", text: renderState(value) }],
        },
        async execute(args) {
            const action = args?.action ?? "get";
            if (action === "set") return setPresetTheme(cfg, args?.theme);
            if (action === "setThemes") return setThemes(cfg, args?.themes);
            if (action === "get") return themeState(cfg);
            throw new Error(`${THEME_TOOL_NAME}: unknown action "${action}" (use get | set | setThemes)`);
        },
    };
}
