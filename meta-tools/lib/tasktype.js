/**
 * meta_tasktype — model-facing project task-type registry ops (v3).
 *
 * The PROJECT registry .dsh/meta/tasktypes.json = { active: [], removed: [] }.
 * register: add a type (removed tombstone -> active; folder untouched).
 * remove: tombstone a type (folder KEPT on disk, routing excludes it).
 * restore = register (idempotent alias). Harness preset packages (themes in
 * patch config) are unaffected: they still contribute candidate types; only
 * the tombstone can de-route them, and only for THIS project.
 */
import {
    composeTaskTypes, readTaskTypeRegistry, registerTaskType, removeTaskType,
    resolveRootCfg,
} from "./library.js";

const fail = (code, extra = {}) => ({ code, ...extra });

function render(args, value) {
    if (value.code !== "OK") return [{ type: "text", text: `meta_tasktype ${value.code}` }];
    if (args?.action === "list" || args?.action === undefined) {
        return [{ type: "text", text: `meta_tasktype: active=[${value.active.join(", ")}] removed=[${value.removed.join(", ")}]` }];
    }
    return [{ type: "text", text: `meta_tasktype ${args.action}: ${value.changed} | active=[${value.active.join(", ")}] removed=[${value.removed.join(", ")}]` }];
}

export function createMetaTaskTypeTool(ctx, cfg) {
    return {
        name: "meta_tasktype",
        description:
            "Manage THIS project's meta task-type registry (.dsh/meta/tasktypes.json): list active/removed types; register a new task type (creates nothing on disk — add files yourself under .dsh/public/<type>/ and your model dir); remove/restore tombstones a type — its folders are KEPT but routing excludes it. Does not affect harness preset packages.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                action: { type: "string", enum: ["list", "register", "remove"], description: "list (default) | register (activate or create) | remove (tombstone; folder kept, not routed)" },
                taskType: { type: "string", description: "register/remove only: the type name (CJK-safe letters/digits/_/-)" },
            },
        },
        output: { schema: { type: "object" }, render: (args, value) => render(args, value) },
        async execute(args, exec) {
            const action = args?.action ?? "list";
            const rcfg = await resolveRootCfg(ctx, exec, cfg);
            if (action === "list") {
                const types = await composeTaskTypes(rcfg);
                const reg = await readTaskTypeRegistry(rcfg);
                return { code: "OK", active: types, removed: reg.removed, registryPath: ".dsh/meta/tasktypes.json" };
            }
            if (typeof args?.taskType !== "string" || !/^[\p{L}\p{N}_-]+$/u.test(args.taskType)) {
                return fail("USAGE", { hint: "taskType is required (letters/digits/_/-; CJK ok)" });
            }
            const name = args.taskType.trim();
            const reg = action === "register" ? await registerTaskType(rcfg, name) : await removeTaskType(rcfg, name);
            const types = await composeTaskTypes(rcfg);
            return {
                code: "OK",
                changed: name,
                action,
                active: types,
                removed: reg.removed,
                hint: action === "register"
                    ? "routing picks it up on the next call; create .dsh/public/<type>/细则.md yourself if the type needs shared must-reads"
                    : "folders kept on disk; routing excludes it from the next call",
            };
        },
    };
}
