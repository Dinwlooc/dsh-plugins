// tool-search.test.mjs - session-frozen manifest fixtures (bad sample must FAIL).
// Compares the FULL rendered runtime-context snapshot, not just the manifest text.
import { HOST_MODULES_OK } from "./host-hooks.mjs";

const real = HOST_MODULES_OK;

const { createToolSearch, freezeManifest, installToolSearch } = await import("../lib/tool-search.js");
const out = [];
const ok = (n, c, note = "") => out.push((c ? "PASS " : "FAIL ") + n + (note ? " | " + note : ""));
// Same join as the host's renderContextSnapshot (contexts joined, fixed preamble).
const snapshot = (assembly) => {
    const body = assembly.contexts.map((c) => c.text).join("\n\n");
    return body === "" ? "" : "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n" + body;
};
const makeTools = () => {
    let schemas = Array.from({ length: 20 }, (_, i) => ({ name: "tool_" + i, description: "does thing " + i, parameters: { type: "object", properties: {} } }));
    return {
        add: (name) => schemas.push({ name, description: "registered later", parameters: { type: "object", properties: {} } }),
        shrink: (n) => { schemas = schemas.slice(0, n); },
        get: () => schemas,
        ctx: {
            tools: { schemas: () => schemas.map((s) => ({ ...s })), get: (n) => schemas.find((s) => s.name === n), execute: async () => ({}) },
            logger: { warn() {} },
            on() {},
        },
    };
};
const assembly = (schemas) => ({
    sections: [{ name: "tools:sdk", text: "SDK" }],
    tools: schemas.map((s) => ({ name: s.name, description: s.description, parameters: s.parameters })),
    contexts: [],
});

// 1. warm-set + registry change inside one session -> identical snapshot
const t1 = makeTools();
const b1 = createToolSearch(t1.ctx);
const scope = { session: { id: "s1", header: { cwd: process.cwd() } } };
const first = freezeManifest(await b1.engine.assemble(assembly(t1.get()), scope), scope, b1.frozen);
const s1 = snapshot(first);
ok("first assembly carries a catalog", s1.includes("tool-search:catalog") || s1.includes("tool_0"));
t1.add("late_tool");
const secondRaw = await b1.engine.assemble(assembly(t1.get()), scope);
const second = freezeManifest(secondRaw, scope, b1.frozen);
ok("registry change -> identical snapshot", snapshot(second) === s1);
ok("bad sample: engine alone drifts", snapshot(secondRaw) !== s1);
// The frozen FACE (tool table), not only the listing text, must survive a registry change.
ok("frozen face keeps the tool table",
    Array.isArray(second.tools) && JSON.stringify(second.tools) === JSON.stringify(first.tools)
    && !second.tools.some((t) => t.name === "late_tool"),
    "tools=" + (Array.isArray(second.tools) ? second.tools.length : "none"));

// 2. a second session gets its own live snapshot
const scope2 = { session: { id: "s2", header: { cwd: process.cwd() } } };
const other = freezeManifest(await b1.engine.assemble(assembly(t1.get()), scope2), scope2, b1.frozen);
ok("per-session isolation", snapshot(other) !== s1 && snapshot(other).includes("late_tool"));

// 3. tier 0 first: no manifest, no freeze; the first manifest freezes once and stays
const t2 = makeTools();
t2.shrink(4);
const b2 = createToolSearch(t2.ctx);
const s3 = { session: { id: "s3", header: { cwd: process.cwd() } } };
const t0 = freezeManifest(await b2.engine.assemble(assembly(t2.get()), s3), s3, b2.frozen);
ok("tier 0 leaves nothing frozen", !b2.frozen.has("session:s3") && !snapshot(t0).includes("Deferred tool catalog"));
for (let i = 0; i < 25; i++) t2.add("extra_" + i);
const grow = freezeManifest(await b2.engine.assemble(assembly(t2.get()), s3), s3, b2.frozen);
const growSnap = snapshot(grow);
ok("tier 0 -> 1 freezes the first real manifest", b2.frozen.has("session:s3") && growSnap.includes("Deferred tool catalog"));
t2.add("post_freeze");
const after = freezeManifest(await b2.engine.assemble(assembly(t2.get()), s3), s3, b2.frozen);
ok("post-freeze registration stays invisible", snapshot(after) === growSnap);

// 6. names stay listed even when the full listing blows the budget (tier capped at 2)
const t3 = makeTools();
const b3 = createToolSearch(t3.ctx);
const s6 = { session: { id: "s6", header: { cwd: process.cwd() } } };
for (let i = 0; i < 400; i++) t3.add("bulk_" + i);
const capped = freezeManifest(await b3.engine.assemble(assembly(t3.get()), s6), s6, b3.frozen);
const capSnap = snapshot(capped);
ok("tier capped at 2: every tool stays listed by name", capSnap.includes("tool_0") && capSnap.includes("bulk_399"));

// 7. the SDK declaration block is part of the frozen face (a new tool must not grow it)
const sdkFrozen = new Map();
const asm1 = { sections: [{ name: "tools:sdk", text: "SDK-A" }], tools: [{ name: "a" }], contexts: [{ name: "tool-search:catalog", text: "CAT-A" }] };
const asm2 = { sections: [{ name: "tools:sdk", text: "SDK-B" }], tools: [{ name: "a" }, { name: "ask_user_question" }], contexts: [{ name: "tool-search:catalog", text: "CAT-B" }] };
const sc = { session: { id: "s7" } };
freezeManifest(asm1, sc, sdkFrozen);
const kept = freezeManifest(asm2, sc, sdkFrozen);
ok("frozen face keeps the SDK block",
    kept.sections[0].text === "SDK-A" && kept.tools.length === 1 && kept.contexts[0].text === "CAT-A");

// 4. two engines -> one catalog context after freeze (duplicates collapsed)
const dup = { contexts: [{ name: "tool-search:catalog", text: "A" }, { name: "tool-search:catalog", text: "B" }, { name: "sandbox", text: "S" }] };
const deduped = freezeManifest(dup, { session: { id: "s4" } }, new Map());
ok("duplicate catalogs collapsed", deduped.contexts.filter((c) => c.name === "tool-search:catalog").length === 1);

// 5. wiring: every registration is effect-scoped, all five tools land
const effects = [];
const registered = [];
const fakeCtx = {
    tools: { schemas: () => [], get: () => undefined, execute: async () => ({}), register: (tool) => { registered.push(tool.name); return () => {}; } },
    logger: { warn() {} },
    on: () => () => {},
    effect: (fn, label) => { effects.push(label); return fn(); },
};
installToolSearch(fakeCtx);
ok("registrations are effect-scoped", effects.length === 3, effects.join(","));
ok("all five tools registered", ["tool_search", "tool_describe", "tool_call", "tool_slimmer_catalog", "tool_slimmer_update_config"].every((n) => registered.includes(n)), registered.join(","));

// 6. another engine already owns the bridge names -> skip, never take meta-tools down
let registeredOnClash = 0;
let clashEffects = 0;
let clashHooks = 0;
const clashCtx = {
    tools: { schemas: () => [], get: (n) => (n === "tool_search" ? {} : undefined), execute: async () => ({}), register: () => { registeredOnClash++; return () => {}; } },
    logger: { warn() {} },
    on: () => { clashHooks++; return () => {}; },
    effect: (fn) => { clashEffects++; return fn(); },
};
let clashThrew = false;
try { installToolSearch(clashCtx); } catch { clashThrew = true; }
ok("name clash skips tools but keeps the freeze hook", !clashThrew && registeredOnClash === 0 && clashHooks === 1 && clashEffects === 1);

console.log(out.join("\n"));
console.log("RESULT tool-search-fixtures: " + out.filter((l) => l.startsWith("PASS")).length + "/" + out.length + (real ? " (host modules)" : " (stubs)"));
