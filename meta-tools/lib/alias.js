/**
 * meta_alias — model-identity alias table ops (`.dsh/meta/config.json` modelAliases).
 *
 * Why: a sibling model starts with an EMPTY library and re-grows the same
 * must-reads from scratch. An alias maps a raw session model id onto another
 * model's library identity, so routing/provisioning reuse that library while
 * reports and revlog keep the FACTUAL model.
 *
 * Owner ruling 2026-10-28: cross-系统 aliases are usually incompatible but MUST
 * NOT be hard-blocked — a user may alias across families on purpose. This tool
 * therefore never rejects on family mismatch; it only rejects an empty/self
 * alias and a chain that would form a cycle.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { libRoot, normalizeAliases, resolveModelIdentity, resolveRootCfg } from "./library.js";

const fail = (code, extra = {}) => ({ code, ...extra });

function render(args, value) {
    if (value.code !== "OK") return [{ type: "text", text: `meta_alias ${value.code}` }];
    const rows = Object.entries(value.modelAliases ?? {}).map(([from, to]) => `${from} -> ${to}`);
    const body = rows.length > 0 ? rows.join(", ") : "(none)";
    const action = args?.action ?? "list";
    if (action === "list") return [{ type: "text", text: `meta_alias: ${body}` }];
    return [{ type: "text", text: `meta_alias ${action}: ${value.changed} | ${body}${value.warning ? ` | ${value.warning}` : ""}` }];
}

export function createMetaAliasTool(ctx, cfg) {
    return {
        name: "meta_alias",
        description:
            "Manage the model-identity alias table in .dsh/meta/config.json (`modelAliases`): `{list|set|remove}`. An alias makes a raw session model id route to ANOTHER model's meta library (shared must-reads, shared folder) while reports/revlog keep the factual model. Use it when sibling models should share one library instead of each growing an empty one. Cross-family aliases are allowed (not blocked) though usually incompatible. Rejects only empty/self aliases and cycles.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                action: { type: "string", enum: ["list", "set", "remove"], description: "list (default) | set (create/overwrite one alias) | remove (drop one alias)" },
                from: { type: "string", description: "set/remove: the RAW session model id (e.g. \"deepseek-reasoner\")" },
                to: { type: "string", description: "set: the identity model id whose library to reuse (e.g. \"deepseek-flash\")" },
            },
        },
        output: { schema: { type: "object" }, render: (args, value) => render(args, value) },
        async execute(args, exec) {
            const action = typeof args?.action === "string" ? args.action : "list";
            const rcfg = await resolveRootCfg(ctx, exec, cfg);
            const base = libRoot(rcfg);
            const file = join(base, "meta", "config.json");

            let raw = {};
            try {
                const parsed = JSON.parse(await readFile(file, "utf8"));
                if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed;
            } catch {
                raw = {};
            }
            const current = normalizeAliases(raw.modelAliases);

            if (action === "list") return { code: "OK", modelAliases: current };

            const from = typeof args?.from === "string" ? args.from.trim() : "";
            if (from === "") return fail("USAGE", { hint: "from is required (the raw session model id)" });

            if (action === "remove") {
                if (current[from] === undefined) return fail("USAGE", { hint: `no alias for "${from}"` });
                delete current[from];
                await persist(file, base, raw, current);
                return { code: "OK", changed: "removed", modelAliases: current };
            }

            const to = typeof args?.to === "string" ? args.to.trim() : "";
            if (to === "") return fail("USAGE", { hint: "to is required (the identity model id whose library to reuse)" });
            if (to === from) return fail("USAGE", { hint: "from and to are the same model — nothing to alias" });

            const candidate = { ...current, [from]: to };
            const resolved = resolveModelIdentity(candidate, from);
            if (resolved.warning !== undefined) {
                return fail("USAGE", { hint: `alias chain rejected: ${resolved.warning}` });
            }
            current[from] = to;
            await persist(file, base, raw, current);
            const crossFamily = from.split(/[-_.]/)[0] !== to.split(/[-_.]/)[0];
            return {
                code: "OK", changed: "set", modelAliases: current,
                ...(crossFamily ? { warning: `cross-family alias (${from} -> ${to}) — allowed, but the two libraries may not be compatible` } : {}),
            };
        },
    };
}

/** Write config back preserving unrelated keys (version, revlogEntries, …). */
async function persist(file, base, raw, aliases) {
    await mkdir(join(base, "meta"), { recursive: true });
    const next = { ...raw, modelAliases: aliases };
    if (next.version === undefined) next.version = 1;
    await writeFile(file, JSON.stringify(next, null, 2) + "\n", "utf8");
}
