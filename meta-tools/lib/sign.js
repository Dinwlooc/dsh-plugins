/**
 * meta_sign — 签发: record a revision note for a meta-layer file (v3).
 *
 * The model EDITS the file with its native write/edit tools, then signs it here.
 * This tool does NOT edit the file: it appends one line to the companion
 * `<file>.revlog.md` — `- <ISO> | <model> | <revisionBasis> | sha=<8> lines=<n>`
 * — and trims the log to revlogEntries (project config .dsh/meta/config.json,
 * default 8; oldest dropped).
 *
 * Verification is cheap, never policing (H design Q2): hard-fails are
 * OUTSIDE_LIB / NOT_FOUND / non-.md / .revlog.md targets; the sha8 in each
 * line makes "edited without signing" machine-auditable afterwards. If the
 * file hash equals the last logged entry the sign still succeeds with an
 * `unchanged` warning (re-attestation is legitimate).
 */
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { stat } from "node:fs/promises";
import {
    appendRevlog, confine, libRoot, readFileText, readProjectConfig,
    resolveRootCfg, revlogPathFor, sha256,
} from "./library.js";
import { modelOfSession } from "./model-map.js";

function agentSessionOf(exec) {
    const a = exec?.agent;
    if (a === null || a === undefined) return null;
    if (typeof a === "object" && a.session !== undefined && a.session !== null) return a.session;
    return a;
}

const fail = (code, extra = {}) => ({ code, ...extra });

function renderSign(_args, value) {
    if (value.code !== "OK") return [{ type: "text", text: `meta_sign ${value.code}` }];
    return [{ type: "text", text: `meta_sign: ${value.path}${value.unchanged ? " (unchanged)" : ""} revlog=${value.revlog.entries} entries${value.droppedOldest > 0 ? `, dropped ${value.droppedOldest}` : ""}` }];
}

export function createMetaSignTool(ctx, cfg) {
    return {
        name: "meta_sign",
        description:
            "签发 — records a revision note; it does NOT edit the file. After you write or edit a meta-layer file under .dsh/ with your native write/edit tools, call this on that file: it appends a timestamp + your model name + revisionBasis line to the companion .revlog.md (cap from .dsh/meta/config.json revlogEntries, default 8, oldest dropped). path may be workspace-relative (incl. or excl. .dsh/) or absolute inside .dsh; revisionBasis is required (Owner quote or observed problem).",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                path: { type: "string", description: "The file you just wrote/edited, e.g. \".dsh/public/meta/分类标准.md\" or \"public/meta/分类标准.md\" or absolute; must end in .md" },
                revisionBasis: { type: "string", description: "Owner quote or observed problem justifying this revision" },
                note: { type: "string", description: "Optional one-line summary of WHAT changed" },
            },
        },
        output: { schema: { type: "object" }, render: (args, value) => renderSign(args, value) },
        async execute(args, exec) {
            const model = modelOfSession(ctx, agentSessionOf(exec));
            if (model === null) return fail("MODEL_UNKNOWN", { hint: "no request/context seen yet for this session; retry after your next turn starts" });
            if (typeof args?.path !== "string" || args.path.trim() === "") return fail("USAGE", { hint: "path is required" });
            if (typeof args?.revisionBasis !== "string" || args.revisionBasis.trim() === "") {
                return fail("USAGE", { hint: "revisionBasis (Owner quote or observed problem) is required" });
            }
            const rcfg = await resolveRootCfg(ctx, exec, cfg);
            // Accept "x.md", ".dsh/x.md", and absolute-inside-.dsh shapes.
            let raw = args.path.trim().replace(/\\/g, "/");
            if (/^\.dsh\//i.test(raw)) raw = raw.slice(5);
            const conf = isAbsolute(args.path)
                ? await confine(rcfg, args.path)
                : await confine(rcfg, raw);
            if (!conf.ok) return fail(conf.code, { hint: "path must be inside .dsh" });
            if (!/\.md$/u.test(conf.rel) || extname(conf.rel) !== ".md") return fail("USAGE", { hint: "path must end in .md" });
            if (conf.rel.endsWith(".revlog.md")) return fail("PROTECTED", { hint: "revlogs are written only by meta_sign itself" });

            let info;
            try {
                info = await stat(conf.abs);
            } catch {
                return fail("NOT_FOUND", { path: conf.rel, hint: "sign only files that exist — write it first with your native tools" });
            }
            if (!info.isFile()) return fail("USAGE", { hint: "only files can be signed" });

            const text = await readFileText(conf.abs);
            const hash = text === null ? "00000000" : sha256(text).slice(0, 8);
            // Soft check: same hash as the last logged entry -> unchanged warning.
            let unchanged = false;
            const prev = await readFileText(revlogPathFor(conf.abs));
            if (prev !== null) {
                const last = prev.split(/\r?\n/).filter((l) => l.startsWith("- ")).pop();
                if (last !== undefined && last.includes(`sha=${hash}`)) unchanged = true;
            }

            const pcfg = await readProjectConfig(rcfg, { revlogEntries: cfg.revlogEntries ?? 8 });
            const lines = text === null ? 0 : text.split(/\r?\n/).length;
            const note = typeof args.note === "string" && args.note.trim() !== "" ? ` | ${args.note.trim()}` : "";
            const rev = await appendRevlog(
                conf.abs,
                `${new Date().toISOString()} | ${model} | ${args.revisionBasis.trim()} | sha=${hash} lines=${lines}${note}`,
                pcfg.revlogEntries,
            );
            const base = libRoot(rcfg);
            return {
                code: "OK",
                path: relative(base, conf.abs).replace(/\\/g, "/"),
                unchanged,
                ...(unchanged ? { hint: "file hash equals the last logged entry — re-attestation?" } : {}),
                ...(pcfg.configWarning !== undefined ? { configWarning: pcfg.configWarning } : {}),
                revlog: { path: relative(base, rev.revPath).replace(/\\/g, "/"), entries: rev.total, droppedOldest: rev.dropped },
            };
        },
    };
}
