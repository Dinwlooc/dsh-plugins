/**
 * meta_route — the basic routing tool (v3: paths-only).
 *
 * Call 1 (no taskType): inventory — routable task types, removed tombstones,
 * the calling model's library dir, config paths. ALSO the sole provisioning
 * point (v3, H-fix: the old agent/created hook scaffolded with the static
 * root and wrote a stray library into the profile dir; doing it here uses the
 * SESSION root by construction): creates the model dir + taskType dirs when
 * missing. No model registry, no character constants, no meta.md stub —
 * models self-maintain those with native writes (Owner ruling 2026-10-27).
 *
 * Call 2 (taskType): must-read PATHS ONLY (v3 Owner addition: never concatenate
 * bodies — context compression and tool slimming make inline bodies stale; the
 * model opens paths with its native read tool). Paths are workspace-relative
 * INCLUDING the `.dsh/` prefix, each with a line count, capped at routeMaxFiles.
 *
 * Must-read set (v2 contract): public/meta/* (strong-loaded) + model meta.md +
 * model meta/ + model <taskType>/ + public/<taskType>/细则.md.
 * Optional: remaining bodies in those dirs. Removed tombstones de-route a type.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { relative } from "node:path";
import {
    composeTaskTypes, libRoot, listBodies, modelLibraryPath, readFileText,
    readProjectConfig, readTaskTypeRegistry, resolveModelIdentity, resolveRootCfg,
} from "./library.js";
import { MESSAGES, render } from "./messages.js";
import { modelOfSession } from "./model-map.js";

function agentSessionOf(exec) {
    const a = exec?.agent;
    if (a === null || a === undefined) return null;
    if (typeof a === "object" && a.session !== undefined && a.session !== null) return a.session;
    return a;
}

/** Knowledge papers are NNNN-*.md; they are searched after routing, never preloaded. */
const PAPER_RE = /^\d{4}-.+\.md$/;
const KNOWLEDGE_BASE = ".dsh/public";

/** GUI rendering of a route result: content-parts array (harness calls .some on it). */
function renderRoute(_args, value) {
    if (value.code !== "OK") return [{ type: "text", text: render(MESSAGES.routeError, { code: value.code }) }];
    // Show the alias when one applied: the model must SEE that another model's
    // library is what it just routed to (identity is a config fact, not a guess).
    const who = value.aliasOf === undefined || value.aliasOf === null
        ? value.model
        : `${value.model} -> ${value.identity} (alias)`;
    if (!value.mustRead) {
        if (value.setup) {
            return [{ type: "text", text: render(MESSAGES.routeSetup, {
                who, steps: value.setup.steps.join(" → "), dir: value.modelDir,
            }) }];
        }
        const plan = value.plan;
        if (plan !== undefined) {
            const perType = value.taskTypes
                .map((t) => `${t}: ${(plan.perType[t] ?? []).join(", ") || "(none)"}`)
                .join(" | ");
            return [{ type: "text", text: render(MESSAGES.routePlan, {
                who,
                types: value.taskTypes.join(", "),
                shared: plan.shared.join(", ") || "(none)",
                perType,
                kb: value.knowledgeBase,
                dir: value.modelDir,
                // public/meta bodies are already in the system prompt (v3.2).
                boot: plan.bootstrapInjected ? " (public/meta already in the system prompt — do not re-read)" : "",
                opt: plan.omitted > 0 ? ` | +${plan.omitted} beyond cap` : "",
            }) }];
        }
        return [{ type: "text", text: render(MESSAGES.routeList, {
            who, types: value.taskTypes.join(", "), kb: value.knowledgeBase, dir: value.modelDir,
        }) }];
    }
    const files = value.mustRead.map((m) => m.path).join(", ");
    const opt = value.omitted > 0 ? ` (+${value.omitted} beyond cap)` : "";
    return [{ type: "text", text: render(MESSAGES.routeMustRead, {
        who, taskType: value.taskType, n: value.mustRead.length, files, opt, kb: value.knowledgeBase,
    }) }];
}

/** Workspace-relative path WITH the .dsh/ prefix (the model opens it with the native read tool). */
function relPath(base, abs) {
    return relative(dirname(base), abs).replace(/\\/g, "/");
}

/** The same directory scan the routing call uses, split into the SHARED part
 * (public/meta + the model's meta.md + meta/) and the per-task-type part
 * (<model>/<type> + public/<type>). Prompt bodies only — knowledge papers stay
 * search-only. */
async function collectDir(dir, budget) {
    const out = [];
    for (const name of await listBodies(dir)) {
        if (PAPER_RE.test(name)) continue;
        const abs = join(dir, name);
        if (!existsSync(abs)) continue;
        if (budget.left <= 0) { budget.omitted++; continue; }
        budget.left--;
        out.push(abs);
    }
    return out;
}

/**
 * Cold-start plan (v3.1): one inventory call already carries the must-read
 * PATHS for every routable type, so the model usually skips the second call.
 * Bodies are still never inlined; line counts stay in the routing call.
 */
export async function buildPlan(rcfg, base, modelRoot, types, skipPublicMeta = false) {
    const budget = { left: rcfg.routeMaxFiles, omitted: 0 };
    const shared = [];
    const sharedDirs = [join(base, "public", "meta"), modelRoot, join(modelRoot, "meta")];
    for (const dir of sharedDirs) {
        // v3.2: with the bootstrap section on, public/meta bodies are already in
        // the system prompt — listing them again would pay for them twice.
        if (skipPublicMeta && dir === sharedDirs[0]) continue;
        for (const abs of await collectDir(dir, budget)) shared.push(relPath(base, abs));
    }
    const perType = {};
    for (const t of types) {
        const list = [];
        for (const dir of [join(modelRoot, t), join(base, "public", t)]) {
            for (const abs of await collectDir(dir, budget)) list.push(relPath(base, abs));
        }
        perType[t] = list;
    }
    return { shared, perType, omitted: budget.omitted };
}

export function createMetaRouteTool(ctx, cfg) {
    return {
        name: "meta_route",
        description:
            "Meta-layer routing for this workspace's prompt & knowledge library (.dsh). When the session model is aliased (meta_alias / .dsh/meta/config.json modelAliases) routing uses the IDENTITY library and the result reports model -> identity (alias). Call once with no arguments to list the routable task types, this model's library dir, and the knowledge-base entry (articles are NOT listed; search them after routing). If the project has no task types, the inventory returns setup steps for meta_tasktype. The inventory also returns the must-read path plan for every type: plan.shared plus plan.perType[yourType], workspace-relative, open them with your native read tool. Call again with taskType only when you need line counts or a re-checked route; knowledge papers are excluded and should be found with grep/project_files find.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                taskType: {
                    type: "string",
                    description: "Second call only: the task type to route (must be one returned by the first call). Omit for the inventory call.",
                },
            },
        },
        output: { schema: { type: "object" }, render: (args, value) => renderRoute(args, value) },
        async execute(args, exec) {
            const model = modelOfSession(ctx, agentSessionOf(exec));
            if (model === null) return { code: "MODEL_UNKNOWN", hint: "no request/context seen yet for this session; retry after your next turn starts" };
            const rcfg = await resolveRootCfg(ctx, exec, cfg);
            const base = libRoot(rcfg);
            // Identity (Owner ruling 2026-10-28): a raw session model may be aliased
            // onto a sibling's library. `model` stays factual for the report/revlog;
            // `identity` keys the directory and the must-read set.
            const pcfg = await readProjectConfig(rcfg, { revlogEntries: cfg.revlogEntries ?? 8 });
            const ident = resolveModelIdentity(pcfg.modelAliases, model);
            const identity = ident.identity;
            const modelRoot = modelLibraryPath(base, identity);
            // Workspace-relative WITH the .dsh/ prefix (relative to the workspace root).
            const modelDir = relative(join(base, ".."), modelRoot).replace(/\\/g, "/");
            const aliasFields = {
                ...(ident.aliasOf !== null ? { aliasOf: ident.aliasOf, identity } : {}),
                ...(ident.warning !== undefined ? { aliasWarning: ident.warning } : {}),
                ...(pcfg.configWarning !== undefined ? { configWarning: pcfg.configWarning } : {}),
            };
            const types = await composeTaskTypes(rcfg);

            // Inventory call + sole provisioning point (session root by construction).
            if (args?.taskType === undefined || args.taskType === "") {
                try {
                    await mkdir(modelRoot, { recursive: true });
                    for (const t of types) await mkdir(join(modelRoot, t), { recursive: true });
                } catch { /* best-effort; native writes recreate on demand */ }
                const inventory = {
                    code: "OK",
                    model,
                    ...aliasFields,
                    modelDir,
                    taskTypes: types,
                    knowledgeBase: KNOWLEDGE_BASE,
                    knowledgeHint: "knowledge articles are not listed here; after choosing a taskType, find them with grep or project_files find",
                };
                if (types.length === 0) {
                    // Fresh project: the plugin cannot invent a taxonomy. Teach the
                    // model the minimum sequence, then route again.
                    return {
                        ...inventory,
                        setup: {
                            hint: "No task types registered for this project.",
                            steps: [
                                'meta_tasktype {"action":"register","taskType":"<type>"}',
                                `create .dsh/public/<type>/细则.md and ${modelDir}/<type>/<model>.md`,
                                'meta_route {"taskType":"<type>"}',
                            ],
                        },
                    };
                }
                // v3.1 (Owner ask 2026-10-31): the inventory carries the path plan
                // for EVERY type, so one call is normally enough. The routing call
                // stays for line counts and for an explicit, re-checked route.
                const injected = cfg.bootstrap !== false;
                const plan = cfg.inventoryPlan === false
                    ? undefined
                    : { ...(await buildPlan(rcfg, base, modelRoot, types, injected)), bootstrapInjected: injected };
                return {
                    ...inventory,
                    ...(plan === undefined ? {} : { plan }),
                    nextHint: plan === undefined
                        ? "call again with taskType=<one of taskTypes> to receive must-read paths"
                        : "read plan.shared plus plan.perType[yourType] with the native read tool; call meta_route {taskType} only when you need line counts",
                };
            }

            // Routing call: paths only, workspace-relative WITH the .dsh/ prefix.
            const taskType = String(args.taskType);
            if (!types.includes(taskType)) {
                const reg = await readTaskTypeRegistry(rcfg);
                return {
                    code: "USAGE", model, ...aliasFields, taskTypes: types, removed: reg.removed,
                    hint: reg.removed.includes(taskType)
                        ? `"${taskType}" is tombstoned (folder kept, not routed) — registerTaskType it via meta_tasktype to re-enable`
                        : `unknown taskType "${taskType}"`,
                };
            }

            const paths = [];
            let omitted = 0;
            const push = (absPath) => {
                if (paths.length >= rcfg.routeMaxFiles) {
                    omitted++;
                    return;
                }
                paths.push(absPath);
            };
            const dirs = [
                join(base, "public", "meta"),
                modelRoot,
                join(modelRoot, "meta"),
                join(modelRoot, taskType),
                join(base, "public", taskType),
            ];
            const bodies = [];
            for (const dir of dirs) {
                for (const name of await listBodies(dir)) {
                    // Prompts and 细则 only. Knowledge papers are discovered by search
                    // after routing (Owner 2026-10-29: the route must not carry the KB).
                    if (PAPER_RE.test(name)) continue;
                    bodies.push(join(dir, name));
                }
            }
            // Insertion order is the strong-load order: public/meta prompts, then
            // the model's meta.md, meta/ methods, type prompt, and shared 细则.
            for (const abs of bodies) {
                if (!existsSync(abs)) continue;
                push(abs);
            }

            // Line counts are best-effort one reads (cheap, bounded by cap).
            const mustRead = [];
            for (const abs of paths.slice(0, rcfg.routeMaxFiles)) {
                const text = await readFileText(abs);
                mustRead.push({
                    path: relative(dirname(base), abs).replace(/\\/g, "/"), // workspace-relative incl. ".dsh/"
                    lines: text === null ? null : text.split(/\r?\n/).length,
                });
            }
            return {
                code: "OK",
                model,
                ...aliasFields,
                taskType,
                mustRead,
                omitted,
                knowledgeBase: KNOWLEDGE_BASE,
                knowledgeHint: `papers under ${KNOWLEDGE_BASE}/${taskType} are not preloaded; search them with grep or project_files find`,
                hint: "open these paths with your native read tool; bodies are not inlined",
                budgetFiles: rcfg.routeMaxFiles,
            };
        },
    };
}
