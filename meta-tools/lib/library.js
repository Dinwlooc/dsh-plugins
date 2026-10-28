/**
 * Meta library layout, confinement, scaffold, model registry, hashing, recycle bin.
 *
 * The library root is `<workspace>/.dsh`. Every path a model hands to the tools is
 * resolved and confined there (lexical + realpath, symlink escape guard — same
 * discipline as the godot-creator plugin's project_files, design paper
 * `.dsh/public/插件/0017-智能查询与删除工具设计.md`).
 *
 * Layout (Owner draft, folded with H review decisions):
 *   .dsh/.tmp/                     scratch (scaffold adoption record lives here)
 *   .dsh/meta/                     library-level meta (分类标准 etc., hand-written)
 *   .dsh/public/<taskType>/        shared per-task-type prompts/knowledge
 *   .dsh/custom_tools/             reusable scripts
 *   .dsh/<系>/<model>/             per-model library; 系 = model id's first prefix,
 *     meta/<model>.md                grouping only — the registry KEY is the exact
 *     <taskType>/                    model id (H-finding 3)
 *   Every written .md has a companion `<name>.md.revlog.md`: strict-append revision
 *   log (timestamp + model signature + revision basis), trimmed to maxLines. The
 *   revlog is the DECLARED signature carrier — prompt files contain only body text.
 *
 * Zero runtime dependencies on purpose (node builtins only), mirroring
 * godot-creator: the package is linked into the profile by absolute path, so Node
 * resolves imports from this directory, not the profile's node_modules.
 */
import { createVolatile, updateVolatile } from "@deepseek-ai/cosmokit";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Model-recognized error codes (weak-model forwardable; never throw past execute). */
export const CODES = Object.freeze([
    "OK", "USAGE", "NOT_FOUND", "OUTSIDE_LIB", "PROTECTED",
    "NOT_READ", "STALE", "DELETE_FAILED", "MODEL_UNKNOWN", "IO_ERROR",
]);

/** Directories that only the library machinery or the owner may touch via tools. */
const PROTECTED_NAMES = new Set([".tmp"]);

/** SHA-256 of file bytes, hex — audit token for meta_sign revlog lines. */
export function sha256(text) {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Atomic same-directory write (tmp + rename): narrows the read-check/write TOCTOU
 * window to the accepted project-wide residual (dsh-fs-sandbox README). */
export async function writeFileAtomic(abs, text) {
    const tmp = `${abs}.tmp`;
    await writeFile(tmp, text, "utf8");
    await rename(tmp, abs);
}

/** Valid task-type name (CJK-safe); invalid entries are dropped, not rejected. */
function normalizeTypesList(arr) {
    return Array.isArray(arr) ? arr.filter((t) => typeof t === "string" && /^[\p{L}\p{N}_-]+$/u.test(t)) : [];
}

/** Live themes map: resolve the volatile cell on EVERY call (H round 10) — a
 * Settings edit swaps the cell snapshot atomically, never a snapshot at apply. */
export function liveThemes(cfg) {
    let themes = cfg.themes;
    if (cfg.themesCell !== undefined) {
        try {
            const value = cfg.themesCell.get();
            if (value !== null && typeof value === "object" && !Array.isArray(value)) themes = value;
        } catch { /* dead cell: static fallback */ }
    }
    return Object.fromEntries(
        Object.entries(themes !== null && typeof themes === "object" ? themes : {})
            .map(([k, v]) => [k, { taskTypes: normalizeTypesList(v?.taskTypes) }]),
    );
}

export function normalizeConfig(raw) {
    const c = raw !== null && typeof raw === "object" ? raw : {};
    const presets = Array.isArray(c.presets) ? c.presets : [];
    // `themes` may be a Volatile CELL (Settings-editable dict, H round 10) or a plain
    // object (patch config / tests). Consumers resolve via liveThemes() every call.
    const themesRaw = c.themes;
    const themesCell = themesRaw !== null && typeof themesRaw === "object" && typeof themesRaw.get === "function" ? themesRaw : undefined;
    const themesStatic = themesRaw !== null && typeof themesRaw === "object" && typeof themesRaw.get !== "function" && !Array.isArray(themesRaw) ? themesRaw : {};
    const normalizeTypes = normalizeTypesList;
    // Canonical taskTypes: presetTheme names a theme in themes[] → its types;
    // else legacy presets[] (compat); else [] (public/ adoption still applies).
    // presetTheme may be a Volatile CELL (schemastery .volatile() passes a frozen
    // {get()} reference — H diagnosis round 7): store it as-is and resolve the
    // live string on every consumption via configTaskTypes(); a plain string
    // (tests/patch config) also works.
    const themeRaw = c.presetTheme;
    return {
        enabled: c.enabled !== false,
        // scaffold 'fill' = create missing dirs only, never touch existing files (H-a/g).
        scaffold: c.scaffold === "off" ? "off" : "fill",
        presetThemeCell: themeRaw !== null && typeof themeRaw === "object" && typeof themeRaw.get === "function" ? themeRaw : undefined,
        presetTheme: typeof themeRaw === "string" ? themeRaw.trim() : "",
        themesCell,
        themes: Object.fromEntries(Object.entries(themesStatic).map(([k, v]) => [k, { taskTypes: normalizeTypesList(v?.taskTypes) }])),
        legacyTaskTypes: presets.flatMap((p) => (p !== null && typeof p === "object" ? normalizeTypes(p.taskTypes) : [])),
        // Legacy shape kept for patch-config compat; consumers read cfg.taskTypes.
        presets: presets
            .filter((p) => p !== null && typeof p === "object")
            .map((p) => ({
                theme: typeof p.theme === "string" ? p.theme.trim() : "",
                taskTypes: normalizeTypes(p.taskTypes),
            }))
            .filter((p) => p.theme !== ""),
        revlogEntries: Number.isInteger(c.revlogEntries) && c.revlogEntries > 0 ? c.revlogEntries
            : Number.isInteger(c.revlogMaxLines) && c.revlogMaxLines > 0 ? c.revlogMaxLines // legacy key, one version
            : 8,
        routeMaxFiles: Number.isInteger(c.routeMaxFiles) && c.routeMaxFiles > 0 ? c.routeMaxFiles : 40,
        // Library root override; default = session working directory (resolveRootCfg).
        root: typeof c.root === "string" && c.root !== "" ? resolve(c.root) : undefined,
    };
}

/** The library root: `<root>/.dsh`. */
export function libRoot(cfg) {
    return join(cfg.root ?? process.cwd(), ".dsh");
}

/**
 * Per-call config with the library root resolved for the CALLING session.
 * Priority: explicit cfg.root → the session's working directory (the same
 * service run_code uses, so a multi-workspace host points each agent at its
 * own .dsh) → process.cwd() at activation. Defensive: any shape or service
 * failure falls back silently to the static root.
 */
export async function resolveRootCfg(ctx, exec, cfg) {
    if (cfg.root !== undefined) return cfg;
    try {
        const directories = ctx?.get?.("workingDirectory");
        if (typeof directories?.ensure !== "function") return cfg;
        const agent = exec?.agent;
        if (agent === undefined || agent === null) return cfg;
        const dir = await directories.ensure(agent, exec?.signal);
        const path = typeof dir === "string"
            ? dir
            : dir?.path ?? dir?.directory ?? dir?.root ?? dir?.cwd;
        if (typeof path === "string" && path !== "") return { ...cfg, root: path };
    } catch { /* fall back to the static root */ }
    return cfg;
}

/**
 * Confine a tool-supplied path to the library. Returns
 * `{ ok: true, abs, rel }` or `{ ok: false, code: 'OUTSIDE_LIB' }`.
 * Lexical check first, then realpath when the target exists (symlink escape guard).
 */
export async function confine(cfg, rawPath) {
    if (typeof rawPath !== "string" || rawPath.trim() === "") return { ok: false, code: "OUTSIDE_LIB" };
    const base = libRoot(cfg);
    const lex = isAbsolute(rawPath) ? resolve(rawPath) : resolve(base, rawPath);
    const rel = relative(base, lex);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return { ok: false, code: "OUTSIDE_LIB" };
    // Refuse direct writes into .tmp and its children: scratch is not library content.
    const first = rel.split(sep)[0];
    if (PROTECTED_NAMES.has(first)) return { ok: false, code: "PROTECTED" };
    let abs = lex;
    try {
        abs = await realpathOf(lex);
    } catch (error) {
        if (error?.code === "ENOENT") return { ok: true, abs: lex, rel };
        return { ok: false, code: "IO_ERROR" };
    }
    const relReal = relative(base, abs);
    if (relReal.startsWith("..") || isAbsolute(relReal)) return { ok: false, code: "OUTSIDE_LIB" };
    return { ok: true, abs, rel: relReal.split(sep).join("/") };
}

async function realpathOf(p) {
    const { realpath } = await import("node:fs/promises");
    return realpath(p);
}

/**
 * Idempotent scaffold (H-decision g): create only MISSING directories; never
 * write or touch any existing file. Existing unexpected trees are adopted, not
 * restructured (H-finding 1): every directory already under .dsh/public registers
 * as a task type. Writes one adoption record under .dsh/.tmp (plugin-owned).
 */
export async function scaffold(cfg) {
    const base = libRoot(cfg);
    const created = [];
    const existed = [];
    const ensure = async (dir) => {
        try {
            await mkdir(dir, { recursive: true });
            created.push(dir);
        } catch {
            existed.push(dir);
        }
    };
    // mkdir recursive succeeds on existing dirs; track what was actually missing.
    const ensureTracked = async (dir) => {
        const missing = await missingDir(dir);
        await mkdir(dir, { recursive: true });
        (missing ? created : existed).push(dir);
    };
    const preexisting = !(await missingDir(base));
    await ensureTracked(base);
    for (const d of [join(base, ".tmp"), join(base, "meta"), join(base, "public"), join(base, "custom_tools")]) {
        await ensureTracked(d);
    }
    // Owner mandate 2026-10-26: theme presets AUTO-APPLY ONLY in workspaces without
    // .dsh (they generate the initial structure there). An existing library is
    // adopt-not-restructure: its public/ subdirs are adopted by scanning instead.
    const themeDirs = preexisting ? [] : configTaskTypes(cfg);
    for (const taskType of themeDirs) {
        await ensureTracked(join(base, "public", taskType));
    }
    // Adoption record: what this scaffold pass saw (plugin-owned .tmp file).
    const record = { at: new Date().toISOString(), created, existed, preexistingDsh: preexisting, autoAppliedThemeDirs: themeDirs };
    try {
        await writeFile(join(base, ".tmp", "meta-tools-scaffold.json"), JSON.stringify(record, null, 2), "utf8");
    } catch { /* scratch write is best-effort */ }
    return record;
}

async function missingDir(dir) {
    try {
        await stat(dir);
        return false;
    } catch {
        return true;
    }
}

/** Live task types from config: resolve the volatile presetTheme/themes cells on
 * EVERY call (Settings changes mutate the cells in place — never snapshot once). */
export function configTaskTypes(cfg) {
    let theme = cfg.presetTheme;
    if (theme === "" && cfg.presetThemeCell !== undefined) {
        try {
            theme = cfg.presetThemeCell.get();
        } catch { theme = ""; }
    }
    const themes = liveThemes(cfg);
    const themed = typeof theme === "string" && theme !== "" ? themes[theme.trim()] : undefined;
    const fromTheme = themed !== undefined && themed !== null && typeof themed === "object" ? themed.taskTypes : undefined;
    return Array.isArray(fromTheme) ? fromTheme : cfg.legacyTaskTypes;
}

/** Sanitize a model id into a safe folder name (keep [A-Za-z0-9._-]; clamp length). */
export function safeName(modelId) {
    return modelId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "unknown";
}

/** 系目录 = first prefix of the model id, grouping only (H-finding 3). Case-preserving:
 * existing 系 dirs on disk (Deepseek) must match exactly or constants land elsewhere. */
export function systemDirOf(modelId) {
    return safeName(modelId.split(/[-_.]/)[0] ?? "unknown");
}

/** Absolute per-model library dir: `<base>/<系>/<model>` (系 = grouping only). */
export function modelLibraryPath(base, modelId) {
    return join(base, systemDirOf(modelId), safeName(modelId));
}

/**
 * Model-identity aliases (Owner ruling 2026-10-28): models of similar nature
 * share ONE library identity, so a new sibling model reuses an existing model's
 * routed must-reads instead of forking a half-empty library.
 *
 * Shape: { "<raw session model id>": "<identity model id>" } — read live from
 * `.dsh/meta/config.json` `modelAliases` (single source of truth: no registry,
 * no character constants — the same discipline as tasktypes.json).
 * Invalid entries are DROPPED, never rejected (weak-model forwardable).
 */
export function normalizeAliases(raw) {
    const out = {};
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
    for (const [key, value] of Object.entries(raw)) {
        const from = typeof key === "string" ? key.trim() : "";
        const to = typeof value === "string" ? value.trim() : "";
        if (from === "" || to === "" || from === to) continue;
        out[from] = to;
    }
    return out;
}

/**
 * Resolve a raw session model id through the alias map (transitive, cycle-safe).
 *
 * `model` is ALWAYS the factual session model (what request/context says — it is
 * what the revlog must record); `identity` is the LIBRARY KEY used for routing and
 * provisioning. A cycle or over-deep chain falls back to the raw model with a
 * `warning` instead of throwing: a broken config must never take routing down.
 */
export function resolveModelIdentity(aliases, model) {
    const raw = typeof model === "string" ? model.trim() : "";
    const map = aliases !== null && typeof aliases === "object" && !Array.isArray(aliases) ? aliases : {};
    let current = raw;
    const chain = [raw];
    const MAX_DEPTH = 8;
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
        const next = typeof map[current] === "string" ? map[current].trim() : "";
        if (next === "" || next === current) {
            return { model: raw, identity: current, aliasOf: current === raw ? null : raw, chain };
        }
        if (chain.includes(next)) {
            return {
                model: raw, identity: raw, aliasOf: null, chain,
                warning: `modelAliases cycle: ${[...chain, next].join(" -> ")}`,
            };
        }
        chain.push(next);
        current = next;
    }
    // Still resolvable after MAX_DEPTH: a partial identity (m0 -> m8, m8 -> m9
    // pending) is worse than none — fall back to the raw model, keep the chain.
    return {
        model: raw, identity: raw, aliasOf: null, chain,
        warning: `modelAliases chain too deep (>${MAX_DEPTH}): ${chain.join(" -> ")} -> ...`,
    };
}

/**
 * Task-type registry (v3, Owner ruling 2026-10-27): .dsh/meta/tasktypes.json —
 * { version, active: [], removed: [] }. Models self-register/remove task types;
 * `removed` entries are tombstones: the folder stays on disk, routing excludes it.
 * Preset/theme config and public/ scanning are UNAFFECTED (harness presets keep
 * working); the tombstone wins over both. Derived cache of intent — never truth.
 */
export function taskTypeRegistryPath(cfg) {
    return join(libRoot(cfg), "meta", "tasktypes.json");
}

export async function readTaskTypeRegistry(cfg) {
    const fresh = { version: 1, active: [], removed: [] };
    try {
        const raw = JSON.parse(await readFile(taskTypeRegistryPath(cfg), "utf8"));
        return {
            version: 1,
            active: normalizeTypesList(raw.active),
            removed: normalizeTypesList(raw.removed),
        };
    } catch {
        return fresh;
    }
}

/** Atomic read-modify-write of the registry; `edit` receives and returns it. */
async function editTaskTypeRegistry(cfg, edit) {
    const reg = edit(await readTaskTypeRegistry(cfg));
    reg.active = [...new Set(reg.active)].filter((t) => !reg.removed.includes(t));
    reg.removed = [...new Set(reg.removed)];
    const tmp = `${taskTypeRegistryPath(cfg)}.tmp`;
    await mkdir(dirname(taskTypeRegistryPath(cfg)), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(reg, null, 2)}\n`, "utf8");
    await rename(tmp, taskTypeRegistryPath(cfg));
    return reg;
}

export async function registerTaskType(cfg, name) {
    return editTaskTypeRegistry(cfg, (reg) => {
        reg.removed = reg.removed.filter((t) => t !== name);
        if (!reg.active.includes(name)) reg.active.push(name);
        return reg;
    });
}

export async function removeTaskType(cfg, name) {
    return editTaskTypeRegistry(cfg, (reg) => {
        reg.active = reg.active.filter((t) => t !== name);
        if (!reg.removed.includes(name)) reg.removed.push(name);
        return reg;
    });
}

/** Effective routable types: (theme/preset ∪ adopted public/ dirs ∪ active) − removed.
 * Tombstone wins over every other source; "meta" is the reserved strong-load folder. */
export async function composeTaskTypes(cfg) {
    const base = libRoot(cfg);
    const reg = await readTaskTypeRegistry(cfg);
    const removed = new Set(reg.removed);
    const types = new Set();
    for (const t of configTaskTypes(cfg)) if (!removed.has(t)) types.add(t);
    try {
        for (const entry of await readdir(join(base, "public"), { withFileTypes: true })) {
            // "meta" is the RESERVED strong-loaded folder (Owner ruling 2026-10-27:
            // 中文"元层"=task type, meta=strong-loaded prompts) — never a task type.
            if (entry.isDirectory() && entry.name !== "meta" && !removed.has(entry.name)) types.add(entry.name);
        }
    } catch { /* no public dir yet */ }
    for (const t of reg.active) types.add(t);
    return [...types].sort();
}

/** True when this workspace already has a .dsh library (theme presets do NOT auto-apply there). */
export async function hasDsh(cfg) {
    return !(await missingDir(libRoot(cfg)));
}

/** Live theme state: resolve the volatile cells on every read. */
export function themeStateSync(cfg) {
    let presetTheme = cfg.presetTheme;
    if (cfg.presetThemeCell !== undefined) {
        try {
            const value = cfg.presetThemeCell.get();
            if (typeof value === "string") presetTheme = value;
        } catch { /* cell dead: keep static fallback */ }
    }
    return { themes: liveThemes(cfg), presetTheme };
}

export async function themeState(cfg) {
    const state = themeStateSync(cfg);
    state.hasDsh = await hasDsh(cfg);
    // Owner mandate 2026-10-26: presets only auto-apply (generate files) in a
    // workspace that has no .dsh yet; existing libraries are adopted, not restructured.
    state.themeAutoApplies = state.hasDsh !== true;
    return state;
}

/** Switch the active theme LIVE (Settings-equivalent): mutate the volatile cell
 * in place, exactly like the loader's own commitVolatileConfig. Persistence
 * across restart stays with the dsh Settings / patch config — same as Settings. */
export async function setPresetTheme(cfg, name) {
    if (cfg.presetThemeCell === undefined) {
        throw new Error("presetTheme is not volatile in this install (update dsh-meta-tools)");
    }
    const theme = typeof name === "string" ? name.trim() : "";
    if (liveThemes(cfg)[theme] === undefined) {
        throw new Error(`unknown theme "${theme}" (have: ${Object.keys(liveThemes(cfg)).join(", ") || "none"})`);
    }
    // updateVolatile(target, source) copies from another CELL — wrap the plain value.
    updateVolatile(cfg.presetThemeCell, createVolatile(theme));
    return themeState(cfg);
}

/** Author the WHOLE themes table live (Settings card / HTTP POST {themes}). The
 * dict is one volatile cell (H round 10); the Settings edit persists via the
 * profile patch — this in-place swap gives the same liveness without a remount. */
export async function setThemes(cfg, themes) {
    if (cfg.themesCell === undefined) {
        throw new Error("themes is not volatile in this install (update dsh-meta-tools)");
    }
    if (themes === null || typeof themes !== "object" || Array.isArray(themes)) {
        throw new Error("themes must be an object: { <name>: { taskTypes: [...] } }");
    }
    // updateVolatile forbids non-JSON values — normalize to plain JSON up front.
    const clean = Object.fromEntries(
        Object.entries(themes).map(([k, v]) => [k, { taskTypes: normalizeTypesList(v?.taskTypes) }]),
    );
    updateVolatile(cfg.themesCell, createVolatile(clean));
    return themeState(cfg);
}

/** List .md files (bodies only, no revlogs) directly inside a directory, sorted. */
export async function listBodies(dir) {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.endsWith(".revlog.md"))
        .map((e) => e.name)
        .sort();
}

/** Companion revlog path for a library body file. */
export function revlogPathFor(absPath) {
    return `${absPath}.revlog.md`;
}

/**
 * Append one revision line to the companion revlog and trim to maxEntries
 * (entry COUNT cap, v3 Owner ruling: default 8; drop the OLDEST beyond it,
 * keep the header). The line itself carries the audit token: timestamp +
 * model + revisionBasis + sha=<8> + lines=<n>.
 */
export async function appendRevlog(absBodyPath, line, maxEntries) {
    const revPath = revlogPathFor(absBodyPath);
    let existing = "";
    try {
        existing = await readFileText(revPath) ?? "";
    } catch { /* first entry */ }
    const header = `# 修订日志 ${absBodyPath}\n\n（署名载体：时间戳 + 模型署名 + 修订依据 + sha8；正文文件只含正文。上限 ${maxEntries} 条，超出自动淘汰最旧。）\n`;
    const lines = (existing.startsWith("# 修订日志") ? existing : `${header}\n${existing}`).split(/\r?\n/);
    lines.push(`- ${line}`);
    // Keep header (up to first blank line) + last maxEntries entries.
    const headEnd = lines.indexOf("");
    const head = lines.slice(0, headEnd < 0 ? lines.length : headEnd);
    const entries = lines.slice(headEnd < 0 ? 0 : headEnd).filter((l) => l.startsWith("- "));
    const kept = entries.slice(-maxEntries);
    const dropped = entries.length - kept.length;
    const text = `${head.join("\n")}\n\n${kept.join("\n")}\n`;
    await writeFile(revPath, text, "utf8");
    return { revPath, total: kept.length, dropped };
}

/**
 * Project-level meta config (v3): .dsh/meta/config.json — model-editable.
 * { version, revlogEntries } — live-read per call, clamped 1..200; missing or
 * invalid values fall back to `fallback` with a warning, never throw.
 */
export async function readProjectConfig(cfg, fallback = {}) {
    const result = { ...fallback, configWarning: undefined, modelAliases: {} };
    try {
        const raw = JSON.parse(await readFile(join(libRoot(cfg), "meta", "config.json"), "utf8"));
        const entries = raw?.revlogEntries;
        if (Number.isInteger(entries) && entries >= 1 && entries <= 200) {
            result.revlogEntries = entries;
        } else {
            result.configWarning = `revlogEntries invalid (${JSON.stringify(entries) ?? "missing"}) — using ${fallback.revlogEntries}`;
        }
        // Identity aliases are independent of revlogEntries: a bad cap must not
        // silently drop a valid alias table (and vice versa).
        result.modelAliases = normalizeAliases(raw?.modelAliases);
    } catch {
        result.configWarning = "no/invalid .dsh/meta/config.json — using defaults";
    }
    return result;
}

/** SINGLE BOM-strip choke point (H round 9): every text consumer (read, search,
 * write disk-recheck, revlog) sees stripped text, so all hashes agree even when a
 * foreign process re-adds a BOM. Strips ALL leading U+FEFF (stacked-BOM robust). */
export function stripBom(text) {
    let i = 0;
    while (text.charCodeAt(i) === 0xfeff) i++;
    return i === 0 ? text : text.slice(i);
}

/** Read a file as utf8 text (BOM-stripped), or null when it does not exist / is unreadable. */
export async function readFileText(absPath) {
    try {
        return stripBom(await readFile(absPath, "utf8"));
    } catch {
        return null;
    }
}
