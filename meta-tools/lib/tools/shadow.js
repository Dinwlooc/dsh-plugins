// dsh-meta-tools · 完全遮蔽层 (Owner 2026-11-06)
//
// WHY: some tools (MCP especially) are injected by an external owner — the Godot
// addon re-registers its whole tool set on every reconnect, so deleting them in
// this preset is futile. The registry stays intact; what gets closed is the
// DISCOVERY surface: a shadowed tool is absent from the manifest, invisible to
// tool_search, unknown to tool_describe and refused by tool_call. Registration,
// approvals and events keep working, so nothing else breaks.
//
// Scope: per workspace, from <cwd>/.dsh/meta/tool-shadow.json. The preset itself
// stays untouched — a different project can keep every tool.
//
// File shape (version/key order irrelevant; unknown keys ignored):
//   { "version": 1,
//     "shadow": ["mcp__godot-ai__csg_manage", "mcp__godot-ai__grid*"] }
// A trailing "*" is a prefix match; everything else is an exact name.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** File name inside the workspace's meta config directory. */
export const SHADOW_FILE = "tool-shadow.json";

/** Absolute path of the shadow file for a workspace. */
export function shadowPath(cwd) {
    return join(cwd, ".dsh", "meta", SHADOW_FILE);
}

/** The empty (nothing shadowed) resolution. */
export const EMPTY_SHADOW = Object.freeze({
    patterns: Object.freeze([]),
    path: undefined,
    has: () => false,
});

/**
 * Parse and shape-validate a shadow file.
 * @param text - raw file text.
 * @param path - file path, used in diagnostics.
 * @returns the validated patterns.
 */
export function parseShadowFile(text, path) {
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        throw new Error("shadow: malformed " + path + ": not valid JSON");
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("shadow: malformed " + path + ": expected a JSON object");
    }
    const list = raw.shadow;
    if (list === undefined)
        return [];
    if (!Array.isArray(list)) {
        throw new Error("shadow: " + path + ': "shadow" must be an array of tool names');
    }
    const patterns = [];
    for (const item of list) {
        if (typeof item !== "string" || item.trim() === "") {
            throw new Error("shadow: " + path + ': every "shadow" entry must be a non-empty string');
        }
        patterns.push(item.trim());
    }
    return patterns;
}

/** Exact match, or prefix match when the pattern ends in "*". */
export function matchesShadow(name, pattern) {
    if (pattern.endsWith("*")) {
        return name.startsWith(pattern.slice(0, -1));
    }
    return name === pattern;
}

/**
 * mtime-cached reader for workspace shadow files. A missing file resolves to
 * EMPTY_SHADOW; a malformed file is warned about once and treated as empty, so
 * a broken config can never take a session down.
 */
export class ShadowStore {
    cache = new Map();
    warn;
    constructor(warn) {
        this.warn = typeof warn === "function" ? warn : () => { };
    }
    /**
     * Resolve the shadow set for a workspace.
     * @param cwd - the session workspace; undefined means no workspace scoping.
     * @returns {{patterns: string[], path?: string, has: (name: string) => boolean}}
     */
    async resolve(cwd) {
        if (typeof cwd !== "string" || cwd === "")
            return EMPTY_SHADOW;
        const path = shadowPath(cwd);
        try {
            const meta = await stat(path);
            const cached = this.cache.get(path);
            if (cached !== undefined && cached.mtimeMs === meta.mtimeMs)
                return cached.data;
            const patterns = parseShadowFile(await readFile(path, "utf8"), path);
            const data = {
                patterns,
                path,
                has: (name) => patterns.some((pattern) => matchesShadow(name, pattern)),
            };
            this.cache.set(path, { mtimeMs: meta.mtimeMs, data });
            return data;
        }
        catch (error) {
            if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
                this.cache.delete(path);
                return EMPTY_SHADOW;
            }
            const message = error instanceof Error ? error.message : String(error);
            this.warn("dsh-meta-tools: ignoring shadow config: " + message);
            return EMPTY_SHADOW;
        }
    }
    /** Drop cached reads (tests, config updates). */
    invalidateAll() {
        this.cache.clear();
    }
}
