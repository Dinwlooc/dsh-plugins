/**
 * project_files — find & delete files in the Godot project tree.
 *
 * Design paper: .dsh/public/插件/0017-智能查询与删除工具设计.md (v1 scope).
 * Renamed from project_fs (ops query/remove → find/delete) per Owner 2026-10-25;
 * the rename is mechanical — guardrail semantics are unchanged.
 *
 * Division of labor (stated in the tool description as the contract):
 *   - filesystem_manage (godot-ai MCP): resource CONTENT operations (move/rename/
 *     reimport/read/write) for files the editor already knows.
 *   - project_files (this): type-aware FIND (noise-filtered glob + meta-md papers) and
 *     DELETE with guardrails (recycle bin, root confinement, reference interception).
 *
 * Dependency-free on purpose (see lib/index.js header). Removal goes to the OS recycle
 * bin via PowerShell's VisualBasic FileIO API — not a hard delete — because a wrong
 * removal must stay recoverable. The host process is not under the DSH file sandbox,
 * so the tool carries its own equivalent guardrails: realpath confinement to the
 * project root, a protected list (root, project.godot, .godot/), symlink non-follow,
 * res:// reference interception, and stop-at-first-block batch semantics.
 */
import { execFile } from "node:child_process";
import { realpath, lstat, unlink, stat } from "node:fs/promises";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname, relative, isAbsolute, resolve, sep } from "node:path";

export const PROJECT_FILES_NAME = "project_files";

/** Paper §3.1: state enum mirrors .dsh/public/README.md (line 28). */
const STATES = Object.freeze(["active", "superseded", "refuted"]);

/** Paper §3.1: type → extension map; unknown extensions go to `other`, never resource. */
const TYPE_EXTS = Object.freeze({
    scene: [".tscn", ".scn"],
    script: [".gd"],
    csharp: [".cs"],
    resource: [".tres", ".res"],
    texture: [".png", ".jpg", ".jpeg", ".webp", ".svg", ".bmp"],
    audio: [".wav", ".ogg", ".mp3"],
    md: [".md"],
});
const ALL_TYPES = Object.freeze([...Object.keys(TYPE_EXTS), "meta-md", "other"]);

/** Paper §3.1: noise filtered at the traversal layer, not by post-filtering a listing. */
const NOISE_EXTS = new Set([".uid", ".import", ".tmp"]);
const NOISE_DIRS = new Set([".godot", ".trash"]);

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// glob → regex (dependency-free; supports **, *, ? over forward-slash relpaths)
// ---------------------------------------------------------------------------

function globToRegex(pattern) {
    let re = "";
    for (let i = 0; i < pattern.length; i += 1) {
        const ch = pattern[i];
        if (ch === "*") {
            if (pattern[i + 1] === "*") {
                // `**` crosses directories; a surrounding slash collapses.
                if (pattern[i + 2] === "/" && (i === 0 || pattern[i - 1] === "/")) i += 2;
                else if (pattern[i - 1] === "/" && pattern[i + 1] === "/") i += 1;
                re += "(?:.*)";
            } else {
                re += "[^/]*";
            }
        } else if (ch === "?") re += "[^/]";
        else re += ch.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
    }
    return new RegExp(`^${re}$`, "u");
}

// ---------------------------------------------------------------------------
// meta-md frontmatter parsing (paper §3.1: BOM, CRLF, bold-variant, malformed safe)
// ---------------------------------------------------------------------------

const HEADER_KEYS = Object.freeze({ 标题: "title", title: "title", 性质: "nature", 状态: "state", 版号: "version" });

/**
 * Returns { fields, malformed } — fields is null when there is no usable header.
 * Malformed (unclosed YAML block, duplicate keys) degrades to no header, counted.
 */
export function parseFrontmatter(text) {
    const lines = text.replace(/^\uFEFF/u, "").split(/\r?\n/).slice(0, 40);
    const fields = {};
    const seen = new Set();
    let malformed = false;

    if (lines[0] === "---") {
        let closed = false;
        for (let i = 1; i < lines.length; i += 1) {
            const line = lines[i];
            if (line === "---" || line === "...") { closed = true; break; }
            const m = /^([A-Za-z_\u4e00-\u9fff-]+)\s*:\s*(.*)$/u.exec(line);
            if (m === null) { if (line.trim() !== "") malformed = true; continue; }
            if (seen.has(m[1])) { malformed = true; continue; }
            seen.add(m[1]);
            const key = HEADER_KEYS[m[1]];
            if (key !== undefined) fields[key] = m[2].trim().replace(/^["']|["']$/gu, "");
        }
        if (!closed) return { fields: null, malformed: true };
    } else {
        // Project bold-variant: consecutive `**键**：值` lines near the top.
        let collected = 0;
        for (const line of lines) {
            const m = /^\*\*(.+?)\*\*\s*[：:]\s*(.*)$/u.exec(line);
            if (m === null) { if (collected > 0) break; continue; }
            const key = HEADER_KEYS[m[1].trim()];
            if (key === undefined) continue;
            if (seen.has(m[1].trim())) { malformed = true; continue; }
            seen.add(m[1].trim());
            fields[key] = m[2].trim();
            collected += 1;
        }
        if (collected === 0) return { fields: null, malformed: false };
    }
    return { fields: Object.keys(fields).length > 0 ? fields : null, malformed };
}

const PAPER_PREFIX = /^\d{4,}-/u;

function classifyType(relPath) {
    const ext = relPath.slice(relPath.lastIndexOf(".")).toLowerCase();
    for (const [type, exts] of Object.entries(TYPE_EXTS)) {
        if (exts.includes(ext)) return type;
    }
    return "other";
}

/** True when the rel path is traversal noise (paper §3.1). */
function isNoise(relPath) {
    const parts = relPath.split("/");
    const name = parts.at(-1).toLowerCase();
    if (NOISE_DIRS.has(parts[0]) || parts.some((p) => NOISE_DIRS.has(p))) return true;
    if (NOISE_EXTS.has(name.slice(name.lastIndexOf(".")))) return true;
    return false;
}

async function walk(root, dir, out) {
    let entries;
    try {
        entries = await readdir(join(root, dir), { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
            out.dirs += 1;
            await walk(root, rel, out);
        } else if (entry.isFile()) {
            out.files.push(rel);
        }
    }
}

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

async function runFind(args, root) {
    const pattern = args.pattern;
    if (typeof pattern !== "string" || pattern === "") {
        throw new UsageError(`USAGE ${PROJECT_FILES_NAME}: op=find requires pattern (glob relative to project root)`);
    }
    const rawTypes = args.type === undefined ? [] : Array.isArray(args.type) ? args.type : [args.type];
    for (const t of rawTypes) {
        if (!ALL_TYPES.includes(t)) {
            throw new UsageError(`USAGE ${PROJECT_FILES_NAME}: unknown type "${t}" (use ${ALL_TYPES.join("/")})`);
        }
    }
    const state = args.state;
    if (state !== undefined && !STATES.includes(state)) {
        throw new UsageError(`USAGE ${PROJECT_FILES_NAME}: unknown state "${state}" (use ${STATES.join("/")})`);
    }
    const types = rawTypes.length > 0 ? rawTypes : undefined; // default: widest
    const regex = globToRegex(pattern);
    const includeNoise = args.include_noise === true;
    const includeNonPaper = args.include_non_paper === true;
    const verbose = args.verbose === true;

    const tree = { files: [], dirs: 0 };
    await walk(root, "", tree);

    const results = [];
    let noiseFiltered = 0;
    let malformedCount = 0;

    for (const rel of tree.files) {
        const isNoiseFile = isNoise(rel);
        if (isNoiseFile && !includeNoise) {
            noiseFiltered += 1;
            continue;
        }
        if (types !== undefined && types.includes("meta-md")) {
            // meta-md branch: .dsh/public papers only (NNNN- prefix), frontmatter filter.
            if (/^\.dsh\/public\/.*\.md$/u.test(rel)) {
                const base = rel.split("/").at(-1);
                if (PAPER_PREFIX.test(base) || includeNonPaper) {
                    let text;
                    try {
                        text = await readFile(join(root, rel), "utf8");
                    } catch {
                        continue;
                    }
                    const { fields, malformed } = parseFrontmatter(text);
                    if (malformed) malformedCount += 1;
                    if (!PAPER_PREFIX.test(base)) {
                        // Non-paper md: only with include_non_paper, no state filter applies.
                    } else if (state !== undefined && fields?.state !== state) continue;
                    results.push({ path: rel, type: "meta-md", ...(fields ?? {}), ...(verbose ? { chars: text.length } : {}) });
                }
                continue;
            }
            if (types.length === 1) continue; // meta-md only: skip everything else
        }
        if (!regex.test(rel)) continue;
        if (types !== undefined && !types.includes("meta-md")) {
            const t = classifyType(rel);
            if (!types.includes(t)) continue;
        }
        results.push({ path: rel, type: classifyType(rel) });
    }

    results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    // Privacy: never echo the absolute project root to the model — paths stay project-relative.
    return { op: "find", pattern, count: results.length, noiseFiltered, malformedFrontmatter: malformedCount, results };
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

const REFERENCE_FILE_EXTS = new Set([".tscn", ".tres", ".gd", ".cs"]);
const REFERENCE_SCAN_CAP = 20000;

/** Best-effort static res:// reference scan (paper §3.2: binary/动态 load 不承诺完整). */
async function findReferences(root, targetRel) {
    const resPath = `res://${targetRel.split("\\").join("/")}`;
    const hits = [];
    let scanned = 0;
    async function scan(dir) {
        if (hits.length > 0 || scanned >= REFERENCE_SCAN_CAP) return;
        let entries;
        try {
            entries = await readdir(join(root, dir), { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (hits.length > 0) return;
            const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
            if (NOISE_DIRS.has(entry.name)) continue;
            if (entry.isDirectory()) {
                await scan(rel);
                continue;
            }
            if (!entry.isFile()) continue;
            const ext = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
            if (!REFERENCE_FILE_EXTS.has(ext)) continue;
            scanned += 1;
            let text;
            try {
                text = await readFile(join(root, rel), "utf8");
            } catch {
                continue;
            }
            if (text.includes(resPath)) hits.push(rel);
        }
    }
    await scan("");
    return hits;
}

/**
 * Recycle-bin delete via PowerShell VisualBasic (paper §3.2 decision 2).
 * Encoded command avoids all quoting hazards in paths.
 */
export function recyclePaths(paths) {
    if (process.platform !== "win32") {
        return Promise.reject(new Error("recycle-bin removal is implemented for Windows (PowerShell VisualBasic FileIO)"));
    }
    const list = paths.map((p) => `'${p.replace(/'/gu, "''")}'`).join(", ");
    const script =
        `Add-Type -AssemblyName Microsoft.VisualBasic; ` +
        `foreach ($p in @(${list})) { ` +
        `if (Test-Path -LiteralPath $p -PathType Container) { ` +
        `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } ` +
        `elseif (Test-Path -LiteralPath $p -PathType Leaf) { ` +
        `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } }`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return new Promise((resolve, reject) => {
        execFile(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
            // stdio "ignore": in a confined environment a piped stdio spawn is denied
            // (EPERM); the recycle outcome is verified by the caller instead.
            {
                timeout: 30000,
                windowsHide: true,
                stdio: "ignore",
            },
            (error) => (error === undefined || error === null ? resolve() : reject(error)),
        );
    });
}

/** Project root: explicit override, then the editor session's project_path, then cwd walk-up. */
async function resolveRoot(probe, override) {
    if (typeof override === "string" && override !== "") return realpath(override);
    if (probe !== undefined && probe !== null) {
        try {
            const snapshot = await probe.snapshot(false);
            const active = snapshot?.editor?.sessions?.find((s) => s.isActive) ?? snapshot?.editor?.sessions?.[0];
            if (typeof active?.projectPath === "string" && active.projectPath !== "") return realpath(active.projectPath);
        } catch {
            /* fall through to cwd walk-up */
        }
    }
    let dir = process.cwd();
    for (;;) {
        try {
            await stat(join(dir, "project.godot"));
            return realpath(dir);
        } catch {
            const parent = dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }
    throw new UsageError(`USAGE ${PROJECT_FILES_NAME}: cannot resolve the project root (no editor session, no project.godot above cwd); pass root explicitly`);
}

async function runDelete(args, probe) {
    const paths = args.paths ?? (args.path !== undefined ? [args.path] : undefined);
    if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => typeof p !== "string" || p === "")) {
        throw new UsageError(`USAGE ${PROJECT_FILES_NAME}: op=delete requires path (single) or paths (array of non-empty strings)`);
    }
    const force = args.force === true;
    const continueOnBlock = args.continue_on_block === true;
    const root = await resolveRoot(probe, args.root);
    const norm = (p) => p.split("\\").join("/").replace(/\/+$/u, "");

    const results = [];
    let stopped = false;
    for (const raw of paths) {
        if (stopped) {
            results.push({ path: norm(raw), status: "skipped", reason: "aborted_after_blocked" });
            continue;
        }
        const relRaw = isAbsolute(raw) ? norm(relative(root, raw)) : norm(raw);
        const entry = { path: relRaw === "" ? "." : relRaw };

        // Lexical containment first (paper §3.2.1): an absolute or ../ path outside the
        // root is rejected even when the target does not exist.
        const lex = resolve(join(root, relRaw));
        const relLex = norm(relative(root, lex));
        if (relLex === "" || relLex.startsWith("..") || isAbsolute(relLex)) {
            results.push({ ...entry, status: "blocked", reason: "outside_root" });
            if (!continueOnBlock) stopped = true;
            continue;
        }

        // Confinement: the realpath must stay inside the root (symlink escape guard).
        let abs;
        try {
            abs = await realpath(lex);
        } catch {
            results.push({ ...entry, status: "blocked", reason: "not_found" });
            if (!continueOnBlock) stopped = true;
            continue;
        }
        const rel = norm(relative(root, abs));
        if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
            results.push({ ...entry, status: "blocked", reason: "outside_root" });
            if (!continueOnBlock) stopped = true;
            continue;
        }

        // Protected list (paper §3.2.2).
        if (rel === "project.godot" || rel === ".godot" || rel.startsWith(".godot/")) {
            results.push({ ...entry, status: "blocked", reason: "protected" });
            if (!continueOnBlock) stopped = true;
            continue;
        }

        // Symlinks/junctions: remove the link itself, never follow (paper §3.2.3).
        let lst;
        try {
            lst = await lstat(abs);
        } catch {
            results.push({ ...entry, status: "blocked", reason: "not_found" });
            if (!continueOnBlock) stopped = true;
            continue;
        }
        const isLink = lst.isSymbolicLink();

        // Reference interception (paper §3.2.5), best-effort, force bypasses.
        if (!force && !isLink) {
            const refs = await findReferences(root, rel);
            if (refs.length > 0) {
                results.push({ ...entry, status: "blocked", reason: "referenced", referencedBy: refs });
                if (!continueOnBlock) stopped = true;
                continue;
            }
        }

        try {
            await recyclePaths([abs]);
        } catch (error) {
            // Privacy: strip the absolute root from any error detail before it reaches the model.
            const detail = (error instanceof Error ? error.message : String(error)).split(abs).join(relRaw).split(root).join("<project>");
            results.push({ ...entry, status: "blocked", reason: "recycle_failed", detail });
            if (!continueOnBlock) stopped = true;
            continue;
        }
        // Post-delete verification (H-review): a failed recycle must never be reported removed.
        let stillThere = true;
        try {
            await lstat(abs);
        } catch {
            stillThere = false;
        }
        if (stillThere) {
            results.push({ ...entry, status: "blocked", reason: "recycle_unverified" });
            if (!continueOnBlock) stopped = true;
            continue;
        }
        results.push({ ...entry, status: isLink ? "removed_link" : "removed" });
    }

    const blocked = results.filter((r) => r.status === "blocked");
    const removed = results.filter((r) => r.status === "removed" || r.status === "removed_link").length;
    const hints = [];
    if (blocked.some((r) => r.reason === "referenced")) hints.push("blocked: referenced → 需要 force=true");
    if (blocked.some((r) => r.reason === "outside_root")) hints.push("blocked: outside_root → 路径必须落在项目根内");
    if (results.some((r) => r.status === "skipped")) hints.push("有 skipped 项 → continue_on_block=true 继续");
    return { op: "delete", removed, results, ...(hints.length > 0 ? { next_hint: hints.join("; ") } : {}) };
}

// ---------------------------------------------------------------------------
// rendering (project 行式规范: 结论行 + RESULT 末行)
// ---------------------------------------------------------------------------

function render(value) {
    const lines = [];
    if (value.op === "find") {
        if (value.count === 0) {
            lines.push(`EMPTY ${value.count} matches for "${value.pattern}"`);
        }
        for (const r of value.results) {
            const meta = r.state !== undefined ? ` state=${r.state}` : "";
            lines.push(`${r.type}\t${r.path}${meta}`);
        }
        lines.push(`RESULT ${PROJECT_FILES_NAME}: op=find n=${value.count} noise_filtered=${value.noiseFiltered} malformed_fm=${value.malformedFrontmatter}${value.count === 0 ? " next_hint=放宽 pattern 或 include_noise=true" : ""}`);
    } else {
        for (const r of value.results) {
            const suffix = r.reason !== undefined ? ` (${r.reason}${r.referencedBy !== undefined ? `: ${r.referencedBy.join(", ")}` : ""})` : "";
            lines.push(`${r.status.toUpperCase()} ${r.path}${suffix}`);
        }
        const blocked = value.results.filter((r) => r.status === "blocked").length;
        const skipped = value.results.filter((r) => r.status === "skipped").length;
        lines.push(`RESULT ${PROJECT_FILES_NAME}: op=delete removed=${value.removed} blocked=${blocked} skipped=${skipped}${value.next_hint !== undefined ? ` next_hint=${value.next_hint}` : ""}`);
    }
    return [{ type: "text", text: lines.join("\n") }];
}

// ---------------------------------------------------------------------------

export function createProjectFilesTool(probe) {
    return {
        name: PROJECT_FILES_NAME,
        description:
            "Find and delete files in the Godot project. find: type-aware glob search that hides Godot noise (.uid/.import/.godot) by default and can search .dsh/public meta papers by frontmatter state. delete: move files to the OS recycle bin (recoverable); paths outside the project root, project.godot/.godot, and files still referenced by res:// are blocked with a reason. filesystem_manage cannot delete reliably — use this tool for any file deletion; use filesystem_manage for move/rename/reimport/read.",
        parameters: {
            type: "object",
            additionalProperties: false,
            required: ["op"],
            properties: {
                op: { type: "string", enum: ["find", "delete"], description: "find = type-aware glob search; delete = recycle-bin delete with guardrails" },
                pattern: { type: "string", description: "op=find: glob relative to the project root (e.g. **/*.tscn)" },
                type: {
                    oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
                    description: "op=find: scene/script/csharp/resource/texture/audio/md/meta-md/other (multi-value; omit for no filter)",
                },
                state: { type: "string", enum: [...STATES], description: "op=find with type=meta-md: only papers whose frontmatter state matches" },
                include_noise: { type: "boolean", description: "op=find: also return .uid/.import/.godot/.trash/.tmp noise" },
                include_non_paper: { type: "boolean", description: "op=find with type=meta-md: also return non-NNNN- .md files" },
                verbose: { type: "boolean", description: "op=find: include extra per-file detail" },
                path: { type: "string", description: "op=delete: single path relative to the project root" },
                paths: { type: "array", items: { type: "string" }, description: "op=delete: batch paths; the first blocked entry aborts the rest unless continue_on_block" },
                force: { type: "boolean", description: "op=delete: bypass the res:// reference check" },
                continue_on_block: { type: "boolean", description: "op=delete: keep going past a blocked entry instead of skipping the rest" },
                // `root` is deliberately NOT in the schema (H-review P0): the model may not
                // re-point the guardrails at an arbitrary root. resolveRoot is authoritative
                // (editor session project_path → project.godot walk-up); tests pass root
                // directly to execute, which the schema does not police.
            },
        },
        output: { schema: { type: "object" }, render: (_args, value) => render(value) },
        async execute(args) {
            const op = args?.op;
            if (op === "find") return runFind(args ?? {}, await resolveRoot(probe, args?.root));
            if (op === "delete") return runDelete(args ?? {}, probe);
            throw new UsageError(`USAGE ${PROJECT_FILES_NAME}: op must be "find" or "delete"`);
        },
    };
}
