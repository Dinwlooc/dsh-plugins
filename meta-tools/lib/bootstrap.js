/**
 * Cold-start bootstrap + child-only prompt set.
 *
 * v3.2 (Owner 2026-10-31): every body file under `.dsh/public/meta/` is a must-read
 * for EVERY task type by design, so it is injected into the system prompt once per
 * agent instead of being re-read by the model. Signing mirrors (`*.revlog.md`) and
 * knowledge papers (`NNNN-*.md`) are never part of the must-read set.
 *
 * v4 (Owner 2026-11-04): `.dsh/meta/SUBAGENTS.md` (name configurable) is the CHILD-ONLY prompt. Its
 * prototype is the H-seat prompt `.dsh/meta/HIGH.md`, which was hand-dispatched
 * until now. A delegated agent (`session.header.origin === "subagent"`) receives
 * that file INSTEAD of the parent's whole prompt set when it exists; with no file
 * the v3.3 ladder stays (children skipped unless `bootstrapSubagents`).
 * Switch: `subagentPrompt` (project file `.dsh/meta/config.json` wins over the
 * instance config; default on). Both sets are read once at `agent/created` and
 * registered on that agent's ctx, so the prompt prefix stays stable for a session.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizePromptFileName, rememberWorkspace, SUBAGENT_FILE_DEFAULT } from "./library.js";

export const BOOTSTRAP_SECTION = "dsh-meta-tools:bootstrap";
/** Sits just before the (shadowed) route pointer at 3150. */
export const BOOTSTRAP_ORDER = 3140;
/** Child-only prompt section (v4); only one of the two sections is ever registered. */
export const SUBAGENT_SECTION = "dsh-meta-tools:subagent-prompt";
export const SUBAGENT_ORDER = 3140;
/** Default workspace-relative file; the NAME is Owner config (settings column). */
export const SUBAGENT_FILE = ".dsh/meta/" + SUBAGENT_FILE_DEFAULT;
/** Knowledge papers are `NNNN-*.md`; revlogs are the signing mirrors. */
const PAPER_RE = /^\d{4}-.+\.md$/;

/**
 * Read the injectable bodies of the strong-loaded prompt folder: `.md` only,
 * revlogs and knowledge papers skipped, BOM stripped, whole blocks skipped past
 * the cap.
 * @param dir absolute prompt folder
 * @param maxChars hard cap on the joined text (0 = no cap)
 * @returns { files, parts, omitted, truncated }
 */
function readBodyBlocks(dir, maxChars = 0) {
    let names;
    try {
        names = readdirSync(dir).sort();
    } catch {
        return { files: [], parts: [], omitted: 0, truncated: false };
    }
    const files = [];
    let omitted = 0;
    let truncated = false;
    const parts = [];
    let used = 0;
    for (const name of names) {
        if (!name.endsWith(".md")) continue;
        if (name.endsWith(".revlog.md")) continue; // signing mirror, not a must-read body
        if (PAPER_RE.test(name)) continue; // papers are search-only
        const abs = join(dir, name);
        let body;
        try {
            if (!statSync(abs).isFile()) continue;
            body = readFileSync(abs, "utf8").replace(/^\uFEFF+/, "");
        } catch {
            continue;
        }
        const block = `### ${name}\n${body.trim()}\n`;
        if (maxChars > 0 && used + block.length > maxChars) {
            truncated = true;
            omitted++;
            continue;
        }
        used += block.length;
        files.push(name);
        parts.push(block);
    }
    return { files, parts, omitted, truncated };
}

/**
 * Read the always-read prompt set of one workspace.
 * @param metaDir absolute `.dsh/public/meta`
 * @param maxChars hard cap on the joined text (0/undefined = no cap)
 * @returns { text, files, omitted, truncated } — text is "" when the dir is absent
 */
export function loadMetaBootstrap(metaDir, maxChars = 0) {
    const { files, parts, omitted, truncated } = readBodyBlocks(metaDir, maxChars);
    if (parts.length === 0) return { text: "", files: [], omitted, truncated };
    const header = [
        "## Meta library: always-read prompts (already loaded)",
        "The files below are this workspace's must-read prompts for every task type; their full text follows, so do not re-read them with a file tool. `meta_route` lists them too, and the model's own library plus the task-type files still have to be read on demand.",
        "",
    ].join("\n");
    return { text: header + parts.join("\n"), files, omitted, truncated };
}

/**
 * Read the CHILD-ONLY prompt (`.dsh/meta/<configured>.md`). Same BOM discipline as
 * the prompt set; a single file, so there is no cap and no partial inclusion.
 * @param dir the session working directory
 * @returns { text, file } — text is "" when the file is absent or empty
 */
export function loadSubagentPrompt(dir, fileName = SUBAGENT_FILE_DEFAULT) {
    const name = normalizePromptFileName(fileName);
    const abs = join(dir, ".dsh", "meta", name);
    try {
        if (!statSync(abs).isFile()) return { text: "", file: null };
        const body = readFileSync(abs, "utf8").replace(/^\uFEFF+/, "").trim();
        if (body === "") return { text: "", file: null };
        const header = [
            "## Subagent prompts (already loaded)",
            "This workspace injects this child-only prompt into delegated subagents; the full text follows, so do not re-read it with a file tool. It REPLACES the parent's prompt set for this session.",
            "",
        ].join("\n");
        return { text: header + body + "\n", file: ".dsh/meta/" + name };
    } catch {
        return { text: "", file: null };
    }
}

/**
 * Project-level switches that shape subagent injection, read live from
 * `.dsh/meta/config.json` (file truth only; absent keys stay absent).
 * @param dir the session working directory
 * @returns {{ bootstrapSubagents?: boolean, subagentPrompt?: boolean }}
 */
export function readProjectSwitches(dir) {
    try {
        const cfg = JSON.parse(readFileSync(join(dir, ".dsh", "meta", "config.json"), "utf8"));
        if (cfg === null || typeof cfg !== "object") return {};
        const out = {};
        if (typeof cfg.bootstrapSubagents === "boolean") out.bootstrapSubagents = cfg.bootstrapSubagents;
        if (typeof cfg.subagentPrompt === "boolean") out.subagentPrompt = cfg.subagentPrompt;
        if (typeof cfg.subagentPromptFile === "string") out.subagentPromptFile = cfg.subagentPromptFile;
        return out;
    } catch {
        return {};
    }
}

/** Legacy predicate: children ALSO get the parent public/meta prefix. */
export function projectAllowsSubagents(dir) {
    return readProjectSwitches(dir).bootstrapSubagents === true;
}

/** Per-directory memo so an assemble-time fallback does not re-read the prompt set every request. */
const metaTextCache = new Map();

/** Resolve the session workspace: the workingDirectory service first, session cwd second. */
function dirFor(ctx, session) {
    try {
        const wd = ctx.get("workingDirectory");
        const dir = typeof wd?.get === "function" ? wd.get(session) : undefined;
        if (typeof dir === "string" && dir !== "") return dir;
    } catch { /* service absent: fall through */ }
    try {
        const cwd = session?.header?.cwd;
        return typeof cwd === "string" && cwd !== "" ? cwd : undefined;
    } catch {
        return undefined;
    }
}

/** Cached read of the always-read prompt set for one workspace. */
function cachedMetaText(dir, maxChars) {
    let stamp = 0;
    try { stamp = statSync(dir).mtimeMs; } catch { return ""; }
    const key = dir + "|" + maxChars;
    const hit = metaTextCache.get(key);
    if (hit !== undefined && hit.stamp === stamp) return hit.text;
    const text = loadMetaBootstrap(dir, maxChars).text;
    metaTextCache.set(key, { stamp, text });
    return text;
}

/**
 * The prompt section a session should receive, or null when nothing applies.
 * Shared by the agent/created hook and the assemble fallback so both paths can
 * never disagree about what "the prompt set" is.
 * @param session the agent session
 * @param cfg normalized plugin config
 * @param dir the session workspace (already resolved)
 */
function sectionFor(session, cfg, dir) {
    if (typeof dir !== "string" || dir === "") return null;
    const maxChars = Number.isInteger(cfg.bootstrapMaxChars) && cfg.bootstrapMaxChars > 0 ? cfg.bootstrapMaxChars : 0;
    let origin;
    try { origin = session?.header?.origin; } catch { origin = undefined; }
    if (origin === "subagent") {
        const sw = readProjectSwitches(dir);
        // v4: project file wins over the instance default (same rule as signEnabled).
        const promptOn = typeof sw.subagentPrompt === "boolean" ? sw.subagentPrompt : cfg.subagentPrompt !== false;
        const file = sw.subagentPromptFile ?? cfg.subagentPromptFile ?? SUBAGENT_FILE_DEFAULT;
        const child = promptOn ? loadSubagentPrompt(dir, file) : { text: "" };
        if (child.text !== "") return { name: SUBAGENT_SECTION, order: SUBAGENT_ORDER, text: child.text };
        if (cfg.bootstrapSubagents === true || sw.bootstrapSubagents === true) {
            const text = cachedMetaText(join(dir, ".dsh", "public", "meta"), maxChars);
            if (text !== "") return { name: BOOTSTRAP_SECTION, order: BOOTSTRAP_ORDER, text };
        }
        return null;
    }
    const text = cachedMetaText(join(dir, ".dsh", "public", "meta"), maxChars);
    if (text === "") return null;
    return { name: BOOTSTRAP_SECTION, order: BOOTSTRAP_ORDER, text };
}

/** Insert a section at its declared order, never duplicating an already-registered one. */
function withSection(assembly, section) {
    const sections = assembly.sections;
    if (!Array.isArray(sections)) return assembly;
    if (sections.some((entry) => entry && entry.name === section.name)) return assembly;
    let at = sections.findIndex((entry) => typeof entry?.order === "number" && entry.order > section.order);
    if (at < 0) at = sections.length;
    return { ...assembly, sections: [...sections.slice(0, at), section, ...sections.slice(at)] };
}

/**
 * Register the prompt section per agent.
 * The section is disposed with `agent.ctx`; the plugin also keeps the disposer
 * so unloading the plugin removes it even if the agent outlives the plugin.
 *
 * Determinism (Owner 2026-11-06): `agent/created` alone is not reliable — a
 * session that started while the plugin or its services were still mounting
 * silently went without the prompt set, and a reload then injected it mid-session
 * (a full prompt-prefix change). The assemble fallback below closes both gaps:
 * every assembly that lacks the section gets it, with the same text and position.
 */
export function installBootstrap(ctx, cfg) {
    if (cfg.bootstrap === false) return;
    if (typeof ctx?.on !== "function") return; // unit-test / degraded host
    const owned = new Set();
    ctx.on("agent/created", ({ agent }) => {
        let session;
        try {
            session = agent?.session;
        } catch {
            return;
        }
        if (session === undefined || session === null) return;
        let dir;
        try {
            const wd = ctx.get("workingDirectory");
            dir = typeof wd?.get === "function" ? wd.get(session) : undefined;
        } catch {
            dir = undefined;
        }
        if (typeof dir !== "string" || dir === "") return;
        rememberWorkspace(dir);
        const section = sectionFor(session, cfg, dir);
        if (section === null) return;
        let dispose;
        try {
            dispose = agent.ctx.effect(
                () => agent.ctx.systemPrompt.section(section),
                "dsh-meta-tools: bootstrap section",
            );
        } catch {
            return;
        }
        owned.add(dispose);
        agent.ctx.effect(() => () => { owned.delete(dispose); }, "dsh-meta-tools: bootstrap bookkeeping");
    });
    // Deterministic fallback: any assembly for a session that never received the
    // section (mount race, plugin reload, agent recreated outside this hook) gets
    // it here, with the same text and the same declared order.
    ctx.effect(() => ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
        const settled = await next();
        try {
            const session = context?.agent?.session;
            if (session === undefined || session === null) return settled;
            if (!Array.isArray(settled?.sections)) return settled;
            if (settled.sections.some((entry) => entry && (entry.name === BOOTSTRAP_SECTION || entry.name === SUBAGENT_SECTION))) return settled;
            const section = sectionFor(session, cfg, dirFor(ctx, session));
            if (section === null) return settled;
            return withSection(settled, section);
        } catch {
            return settled;
        }
    }), "dsh-meta-tools: bootstrap fallback");
    ctx.effect(() => () => {
        for (const dispose of owned) {
            try {
                dispose();
            } catch { /* already disposed with the agent */ }
        }
        owned.clear();
    }, "dsh-meta-tools: bootstrap disposal");
}
