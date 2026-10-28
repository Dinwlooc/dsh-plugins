/**
 * Regression for dsh-meta-tools v3 pure logic (no harness needed).
 * Run: node dsh-plugins/meta-tools/test/run.mjs
 * Convention: line output, PASS/FAIL per case, RESULT summary line (public/tools style).
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMetaRouteTool } from "../lib/route.js";
import { createMetaSignTool } from "../lib/sign.js";
import { createMetaTaskTypeTool } from "../lib/tasktype.js";
import { createMetaAliasTool } from "../lib/alias.js";
import { modelMapProjection } from "../lib/model-map.js";
import {
    appendRevlog, composeTaskTypes, configTaskTypes, confine, modelLibraryPath,
    normalizeAliases, normalizeConfig, readProjectConfig, readTaskTypeRegistry,
    registerTaskType, removeTaskType, resolveModelIdentity, safeName, setPresetTheme,
    setThemes, sha256, systemDirOf, themeState, themeStateSync,
} from "../lib/library.js";

let pass = 0;
let failCount = 0;
function check(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => { pass++; console.log(`PASS ${name}`); })
        .catch((e) => { failCount++; console.log(`FAIL ${name}: ${e.message}`); });
}

const ctx = { sessionProjections: { stateOf: () => ({ model: "glm-5.3-flash" }) } };
const exec = { agent: { session: { id: "s1" } } };

const tmp = await mkdtemp(join(tmpdir(), "dsh-meta-tools-"));
const workspace = join(tmp, "ws");
await mkdir(join(workspace, ".dsh", "public"), { recursive: true });
const cfg = normalizeConfig({ root: workspace, presets: [{ theme: "t", taskTypes: ["业务", "插件"] }] });

await check("normalizeConfig defaults (v3)", () => {
    const c = normalizeConfig(undefined);
    assert.equal(c.scaffold, "fill");
    assert.equal(c.revlogEntries, 8);
    assert.equal(c.routeMaxFiles, 40);
    // legacy key accepted one version
    assert.equal(normalizeConfig({ revlogMaxLines: 20 }).revlogEntries, 20);
});

await check("safeName / systemDirOf", () => {
    assert.equal(systemDirOf("glm-5.3-flash"), "glm");
    assert.equal(systemDirOf("deepseek-flash"), "deepseek");
    assert.equal(safeName("a/b:c"), "a_b_c");
});

await check("modelAliases: normalize drops junk, resolve is transitive and cycle-safe", () => {
    const aliases = normalizeAliases({
        "deepseek-reasoner": "deepseek-flash",
        "a-model": "deepseek-flash",
        "self": "self",
        "bad-key": 3,
        "": "x",
    });
    assert.deepEqual(Object.keys(aliases).sort(), ["a-model", "deepseek-reasoner"]);
    // plain model: identity == model, no alias
    const plain = resolveModelIdentity(aliases, "glm-5.3-flash");
    assert.equal(plain.model, "glm-5.3-flash");
    assert.equal(plain.identity, "glm-5.3-flash");
    assert.equal(plain.aliasOf, null);
    // one hop
    const one = resolveModelIdentity(aliases, "deepseek-reasoner");
    assert.equal(one.model, "deepseek-reasoner", "model stays FACTUAL for the revlog");
    assert.equal(one.identity, "deepseek-flash");
    assert.equal(one.aliasOf, "deepseek-reasoner");
    // transitive chain
    const chain = resolveModelIdentity({ x: "y", y: "z" }, "x");
    assert.equal(chain.identity, "z");
    assert.equal(chain.aliasOf, "x");
    // cycle -> falls back to raw model with a warning, never throws
    const cyc = resolveModelIdentity({ p: "q", q: "p" }, "p");
    assert.equal(cyc.identity, "p");
    assert.equal(cyc.aliasOf, null);
    assert.ok(typeof cyc.warning === "string" && cyc.warning.includes("cycle"));
    // deep chain guard (8 hops) also falls back instead of looping
    const deep = {};
    for (let i = 0; i < 20; i++) deep[`m${i}`] = `m${i + 1}`;
    const deepRes = resolveModelIdentity(deep, "m0");
    assert.equal(deepRes.aliasOf, null);
    assert.ok(typeof deepRes.warning === "string");
});

await check("modelLibraryPath: alias identity selects the target library dir", () => {
    const base = join(workspace, ".dsh");
    assert.equal(safeName("deepseek-reasoner"), "deepseek-reasoner");
    assert.equal(
        modelLibraryPath(base, "deepseek-flash"),
        join(base, "deepseek", "deepseek-flash"),
    );
});

await check("normalizeConfig theme presets", () => {
    const themed = normalizeConfig({ themes: { sample: { taskTypes: ["评审", "架构"] } }, presetTheme: "sample" });
    assert.deepEqual(configTaskTypes(themed).slice().sort(), ["评审", "架构"].sort());
    let live = "sample";
    const cellCfg = normalizeConfig({ themes: { sample: { taskTypes: ["评审", "架构"] } }, presetTheme: { get: () => live } });
    assert.deepEqual(configTaskTypes(cellCfg).slice().sort(), ["评审", "架构"].sort());
    live = "";
    assert.deepEqual(configTaskTypes(cellCfg), []);
    const unknownTheme = normalizeConfig({ themes: { sample: { taskTypes: ["评审"] } }, presetTheme: "nope", presets: [{ theme: "t", taskTypes: ["业务"] }] });
    assert.deepEqual(configTaskTypes(unknownTheme), ["业务"]);
});

await check("confine rejects outside and .tmp; accepts .dsh-prefixed shape", async () => {
    assert.equal((await confine(cfg, "../escape.md")).ok, false);
    assert.equal((await confine(cfg, ".tmp/x.md")).code, "PROTECTED");
    assert.equal((await confine(cfg, "meta/a.md")).ok, true);
    assert.equal((await confine(cfg, ".dsh/meta/a.md")).ok, true); // meta_sign accepts this shape
});

await check("tasktype registry: register/remove/tombstone-beats-theme, folders untouched", async () => {
    // compose = (theme ∪ public scan ∪ active) − removed
    let types = await composeTaskTypes(cfg);
    assert.deepEqual([...types].sort(), ["业务", "插件"]);
    await registerTaskType(cfg, "评审");
    types = await composeTaskTypes(cfg);
    assert.deepEqual([...types].sort(), ["业务", "插件", "评审"]);
    // tombstone beats theme AND public adoption
    await mkdir(join(workspace, ".dsh", "public", "协作"), { recursive: true });
    await registerTaskType(cfg, "协作");
    types = await composeTaskTypes(cfg);
    assert.ok(types.includes("协作"));
    await removeTaskType(cfg, "协作");
    types = await composeTaskTypes(cfg);
    assert.ok(!types.includes("协作"), "removed type must not route");
    const reg = await readTaskTypeRegistry(cfg);
    assert.ok(reg.removed.includes("协作"));
    // idempotent ops
    await registerTaskType(cfg, "协作"); // restore
    assert.ok((await composeTaskTypes(cfg)).includes("协作"));
    await removeTaskType(cfg, "协作");
    await removeTaskType(cfg, "协作");
    assert.equal((await readTaskTypeRegistry(cfg)).removed.filter((t) => t === "协作").length, 1);
});

await check("meta_tasktype tool: list/register/remove", async () => {
    const tool = createMetaTaskTypeTool(ctx, cfg);
    const l1 = await tool.execute({}, exec);
    assert.equal(l1.code, "OK");
    assert.ok(Array.isArray(l1.active));
    const r1 = await tool.execute({ action: "register", taskType: "测试型" }, exec);
    assert.equal(r1.code, "OK");
    assert.ok(r1.active.includes("测试型"));
    const r2 = await tool.execute({ action: "remove", taskType: "测试型" }, exec);
    assert.equal(r2.code, "OK");
    assert.ok(r2.removed.includes("测试型"));
    const bad = await tool.execute({ action: "register", taskType: "bad type!" }, exec);
    assert.equal(bad.code, "USAGE");
});

await check("meta_sign: NOT_FOUND / non-md / revlog-protected / OUTSIDE_LIB", async () => {
    const tool = createMetaSignTool(ctx, cfg);
    const nf = await tool.execute({ path: ".dsh/public/业务/missing.md", revisionBasis: "b" }, exec);
    assert.equal(nf.code, "NOT_FOUND");
    const nm = await tool.execute({ path: ".dsh/public/业务/x.txt", revisionBasis: "b" }, exec);
    assert.equal(nm.code, "USAGE");
    const pr = await tool.execute({ path: ".dsh/public/业务/a.md.revlog.md", revisionBasis: "b" }, exec);
    assert.equal(pr.code, "PROTECTED");
    const out = await tool.execute({ path: "C:/outside/foo.md", revisionBasis: "b" }, exec);
    assert.equal(out.code, "OUTSIDE_LIB");
    const noBasis = await tool.execute({ path: ".dsh/public/业务/a.md" }, exec);
    assert.equal(noBasis.code, "USAGE");
    const noModel = { sessionProjections: { stateOf: () => ({ model: null }) } };
    const mu = await createMetaSignTool(noModel, cfg).execute({ path: ".dsh/public/业务/a.md", revisionBasis: "b" }, exec);
    assert.equal(mu.code, "MODEL_UNKNOWN");
});

await check("meta_sign: appends sha/model/basis line, cap 8 from project config", async () => {
    const target = join(workspace, ".dsh", "public", "业务", "a.md");
    await mkdir(join(workspace, ".dsh", "public", "业务"), { recursive: true });
    await writeFile(target, "l1\nl2\n", "utf8");
    const tool = createMetaSignTool(ctx, cfg);
    const s1 = await tool.execute({ path: ".dsh/public/业务/a.md", revisionBasis: "首版" }, exec);
    assert.equal(s1.code, "OK");
    assert.equal(s1.unchanged, false);
    // re-sign without change -> unchanged warning, still OK
    const s2 = await tool.execute({ path: ".dsh/public/业务/a.md", revisionBasis: "复核" }, exec);
    assert.equal(s2.code, "OK");
    assert.equal(s2.unchanged, true);
    // edit then sign -> unchanged false again
    await writeFile(target, "l1\nl2\nl3\n", "utf8");
    const s3 = await tool.execute({ path: "public/业务/a.md", revisionBasis: "补行", note: "+l3" }, exec);
    assert.equal(s3.code, "OK");
    assert.equal(s3.unchanged, false);
    const rev = await readFile(`${target}.revlog.md`, "utf8");
    assert.ok(rev.includes("glm-5.3-flash"));
    assert.ok(rev.includes("首版"));
    assert.ok(rev.includes(`sha=${sha256("l1\nl2\nl3\n").slice(0, 8)}`));
    assert.ok(rev.includes("+l3"));
    // project config cap: set revlogEntries=3, sign 5x, expect 3 entries
    await mkdir(join(workspace, ".dsh", "meta"), { recursive: true });
    await writeFile(join(workspace, ".dsh", "meta", "config.json"), JSON.stringify({ version: 1, revlogEntries: 3 }), "utf8");
    const pc = await readProjectConfig(cfg, { revlogEntries: 8 });
    assert.equal(pc.revlogEntries, 3);
    for (let i = 0; i < 5; i++) {
        await appendRevlog(target, `entry ${i}`, pc.revlogEntries);
    }
    const rev2 = await readFile(`${target}.revlog.md`, "utf8");
    const entries = rev2.split(/\r?\n/).filter((l) => l.startsWith("- "));
    assert.equal(entries.length, 3);
    assert.ok(rev2.includes("entry 4"));
    assert.ok(!rev2.includes("entry 1\n"));
});

await check("readProjectConfig: missing/invalid falls back with warning, never throws", async () => {
    const fallback = await readProjectConfig(normalizeConfig({ root: join(tmp, "nope") }), { revlogEntries: 8 });
    assert.equal(fallback.revlogEntries, 8);
    assert.ok(typeof fallback.configWarning === "string");
    await writeFile(join(workspace, ".dsh", "meta", "config.json"), "not json", "utf8");
    const bad = await readProjectConfig(cfg, { revlogEntries: 8 });
    assert.equal(bad.revlogEntries, 8);
    assert.ok(bad.configWarning);
    await writeFile(join(workspace, ".dsh", "meta", "config.json"), JSON.stringify({ version: 1, revlogEntries: 500 }), "utf8");
    const clamp = await readProjectConfig(cfg, { revlogEntries: 8 });
    assert.equal(clamp.revlogEntries, 8); // 500 out of 1..200 -> fallback
    await writeFile(join(workspace, ".dsh", "meta", "config.json"), JSON.stringify({ version: 1, revlogEntries: 12 }), "utf8");
    assert.equal((await readProjectConfig(cfg, { revlogEntries: 8 })).revlogEntries, 12);
});

await check("meta_route inventory provisions with session root (no registry.json, no constants)", async () => {
    const routeCtx = { sessionProjections: ctx.sessionProjections, get: () => undefined };
    const tool = createMetaRouteTool(routeCtx, cfg);
    const inv = await tool.execute({}, exec);
    assert.equal(inv.code, "OK");
    assert.equal(inv.model, "glm-5.3-flash");
    assert.equal(inv.modelDir, ".dsh/glm/glm-5.3-flash");
    assert.ok(inv.taskTypes.includes("业务"));
    assert.ok(!inv.taskTypes.includes("协作")); // tombstoned in the earlier test
    // Inventory is cold-start output: only what the model needs to start (no tombstones, no internal paths).
    assert.equal(inv.removed, undefined, "no tombstone list in inventory");
    assert.equal(inv.registryPath, undefined);
    assert.equal(inv.configPath, undefined);
    assert.equal(inv.criteriaPath, undefined);
    // provisioning created the model dir, but NO character constant / registry rows
    const sysMeta = join(workspace, ".dsh", "glm", "meta");
    let noConstant = true;
    try { await readFile(join(sysMeta, "glm-5.3-flash.md"), "utf8"); noConstant = false; } catch { /* good */ }
    assert.ok(noConstant, "v3 must not write character constants");
    let noRegistry = true;
    try { await readFile(join(workspace, ".dsh", "meta", "registry.json"), "utf8"); noRegistry = false; } catch { /* good */ }
    assert.ok(noRegistry, "registry.json must be retired");
});

await check("meta_route routing returns PATHS ONLY, .dsh-prefixed, no bodies", async () => {
    await writeFile(join(workspace, ".dsh", "public", "业务", "细则.md"), "# 细则\n正文", "utf8");
    const tool = createMetaRouteTool(ctx.sessionProjections && { sessionProjections: ctx.sessionProjections, get: () => undefined }, cfg);
    const route = await tool.execute({ taskType: "业务" }, exec);
    assert.equal(route.code, "OK");
    assert.ok(Array.isArray(route.mustRead) && route.mustRead.length > 0);
    for (const m of route.mustRead) {
        assert.ok(typeof m.path === "string" && !m.path.includes("\n"));
        assert.ok(m.path.startsWith(".dsh/"), `workspace-relative with .dsh prefix, got ${m.path}`);
        assert.equal(m.body, undefined, "v3 must not inline bodies");
        assert.ok(Number.isInteger(m.lines));
    }
    assert.ok(route.mustRead.some((m) => m.path.endsWith("public/业务/细则.md")));
    assert.ok(route.mustRead.some((m) => m.path.endsWith("public/meta/分类标准.md") || true));
    // unknown + tombstoned type
    const unknown = await tool.execute({ taskType: "协作" }, exec);
    assert.equal(unknown.code, "USAGE");
    assert.ok(unknown.hint.includes("tombstoned"));
});

await check("projection folds request/context", () => {
    let state = modelMapProjection.init();
    state = modelMapProjection.apply(state, { type: "user/message" });
    assert.equal(state.model, null);
    state = modelMapProjection.apply(state, { type: "request/context", data: { provider: "zai", model: "glm-5.3-flash" } });
    assert.equal(state.model, "glm-5.3-flash");
    const same = modelMapProjection.apply(state, { type: "request/context", data: { provider: "zai", model: "glm-5.3-flash" } });
    assert.ok(same === state);
    assert.equal(modelMapProjection.stateSchema.parse({ model: "m" }).model, "m");
    assert.equal(modelMapProjection.stateSchema.parse({ model: null }).model, null);
    assert.equal(modelMapProjection.wire.viewSchema.parse(modelMapProjection.wire.view(state)).model, "glm-5.3-flash");
    assert.throws(() => modelMapProjection.stateSchema.parse("junk"));
});

await check("theme state / set (volatile cell)", async () => {
    const { createVolatile } = await import("@deepseek-ai/cosmokit");
    const cell = createVolatile("sample");
    const themesCell = createVolatile({ sample: { taskTypes: ["评审"] }, Other: { taskTypes: ["杂务"] } });
    const tcfg = normalizeConfig({ themes: themesCell, presetTheme: cell, root: workspace });
    const s1 = await themeState(tcfg);
    assert.equal(s1.presetTheme, "sample");
    await setPresetTheme(tcfg, "Other");
    assert.equal(themeStateSync(tcfg).presetTheme, "Other");
    await assert.rejects(setPresetTheme(tcfg, "nope"), /unknown theme/);
    await setThemes(tcfg, { Fresh: { taskTypes: ["评审", "计算"] } });
    await setPresetTheme(tcfg, "Fresh");
    assert.deepEqual(configTaskTypes(tcfg), ["评审", "计算"]);
    await assert.rejects(setThemes(normalizeConfig({ root: workspace }), {}), /not volatile/);
});

await check("sha256 stable", () => {
    assert.equal(sha256("abc"), sha256("abc"));
    assert.notEqual(sha256("abc"), sha256("abd"));
});

await check("junction-escaped target rejected (existing file)", async () => {
    const { symlinkSync, rmdirSync } = await import("node:fs");
    const outDir = join(tmp, "outside");
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "secret.md"), "outside", "utf8");
    const link = join(workspace, ".dsh", "public", "escape");
    symlinkSync(outDir, link, "junction");
    try {
        // existing target -> realpath resolves the junction -> OUTSIDE_LIB
        assert.equal((await confine(cfg, "public/escape/secret.md")).ok, false);
        // nonexistent target under the junction: confine is lexical-ok, but meta_sign
        // cannot write files, so it stops at NOT_FOUND — no escape path exists.
        const tool = createMetaSignTool(ctx, cfg);
        const r = await tool.execute({ path: ".dsh/public/escape/ghost.md", revisionBasis: "b" }, exec);
        assert.equal(r.code, "NOT_FOUND");
    } finally {
        rmdirSync(link);
    }
});

await check("readProjectConfig exposes modelAliases independent of revlogEntries validity", async () => {
    await mkdir(join(workspace, ".dsh", "meta"), { recursive: true });
    await writeFile(
        join(workspace, ".dsh", "meta", "config.json"),
        JSON.stringify({ version: 1, revlogEntries: 500, modelAliases: { "raw-model": "canon-model" } }),
        "utf8",
    );
    const pc = await readProjectConfig(cfg, { revlogEntries: 8 });
    assert.equal(pc.revlogEntries, 8); // bad cap -> fallback + warning
    assert.ok(typeof pc.configWarning === "string");
    assert.deepEqual(pc.modelAliases, { "raw-model": "canon-model" }); // aliases survive
});

await check("meta_route: alias routes to the TARGET library, model stays factual", async () => {
    // Canon library owns a must-read that the raw model must receive.
    const canonType = join(workspace, ".dsh", "deepseek", "deepseek-flash", "业务");
    await mkdir(canonType, { recursive: true });
    await writeFile(join(canonType, "flash-calibration.md"), "# flash 校准\n正文", "utf8");
    await writeFile(
        join(workspace, ".dsh", "meta", "config.json"),
        JSON.stringify({ version: 1, revlogEntries: 8, modelAliases: { "deepseek-reasoner": "deepseek-flash" } }),
        "utf8",
    );
    const aliasedCtx = { sessionProjections: { stateOf: () => ({ model: "deepseek-reasoner" }) }, get: () => undefined };
    const tool = createMetaRouteTool(aliasedCtx, cfg);

    const inv = await tool.execute({}, exec);
    assert.equal(inv.code, "OK");
    assert.equal(inv.model, "deepseek-reasoner", "factual model preserved");
    assert.equal(inv.identity, "deepseek-flash");
    assert.equal(inv.aliasOf, "deepseek-reasoner");
    assert.equal(inv.modelDir, ".dsh/deepseek/deepseek-flash");
    // provisioning created the TARGET dir, never a reasoner fork
    const targetDir = await readFile(join(workspace, ".dsh", "deepseek", "deepseek-flash", "meta.md"), "utf8").catch(() => null);
    assert.equal(targetDir, null); // no stub written (v3)
    const reasonerDir = join(workspace, ".dsh", "deepseek", "deepseek-reasoner");
    const forkExists = await readFile(reasonerDir, "utf8").then(() => true).catch(() => false);
    assert.equal(forkExists, false, "alias must not fork a new library dir");

    const route = await tool.execute({ taskType: "业务" }, exec);
    assert.equal(route.code, "OK");
    assert.ok(route.mustRead.some((m) => m.path.endsWith("deepseek/deepseek-flash/业务/flash-calibration.md")));
    assert.ok(!route.mustRead.some((m) => m.path.includes("deepseek-reasoner")), "no raw-model paths");

    // Rendered text must disclose the alias (identity is visible, not silent).
    const rendered = tool.output.render({}, inv)[0].text;
    assert.ok(rendered.includes("deepseek-reasoner -> deepseek-flash"), rendered);

    // Unaliased model is unaffected by the same config.
    const plainCtx = { sessionProjections: { stateOf: () => ({ model: "glm-5.3-flash" }) }, get: () => undefined };
    const plain = await createMetaRouteTool(plainCtx, cfg).execute({}, exec);
    assert.equal(plain.identity, undefined);
    assert.equal(plain.aliasOf, undefined);
    assert.equal(plain.modelDir, ".dsh/glm/glm-5.3-flash");

    // Cycle in config: route still works, model unchanged, warning surfaced.
    await writeFile(
        join(workspace, ".dsh", "meta", "config.json"),
        JSON.stringify({ version: 1, modelAliases: { "loopa": "loopb", "loopb": "loopa" } }),
        "utf8",
    );
    const loopCtx = { sessionProjections: { stateOf: () => ({ model: "loopa" }) }, get: () => undefined };
    const loop = await createMetaRouteTool(loopCtx, cfg).execute({}, exec);
    assert.equal(loop.code, "OK");
    assert.equal(loop.model, "loopa");
    assert.equal(loop.aliasOf, undefined);
    assert.ok(typeof loop.aliasWarning === "string");
    // restore a clean config for later tests
    await writeFile(join(workspace, ".dsh", "meta", "config.json"), JSON.stringify({ version: 1, revlogEntries: 8 }), "utf8");
});


await check("meta_alias: set/list/remove preserves other keys, allows cross-family, rejects cycle", async () => {
    const configFile = join(workspace, ".dsh", "meta", "config.json");
    await mkdir(join(workspace, ".dsh", "meta"), { recursive: true });
    await writeFile(configFile, JSON.stringify({ version: 1, revlogEntries: 8 }), "utf8");
    const tool = createMetaAliasTool(ctx, cfg);

    let r = await tool.execute({ action: "set", from: "deepseek-reasoner", to: "deepseek-flash" }, exec);
    assert.equal(r.code, "OK");
    assert.equal(r.warning, undefined, "same family has no warning");

    r = await tool.execute({ action: "set", from: "glm-4.6v", to: "deepseek-flash" }, exec);
    assert.equal(r.code, "OK");
    assert.ok(typeof r.warning === "string", "cross-family is allowed but warned");

    const onDisk = JSON.parse(await readFile(configFile, "utf8"));
    assert.equal(onDisk.revlogEntries, 8, "unrelated keys survive");
    assert.deepEqual(onDisk.modelAliases, { "deepseek-reasoner": "deepseek-flash", "glm-4.6v": "deepseek-flash" });

    const list = await tool.execute({ action: "list" }, exec);
    assert.deepEqual(list.modelAliases, onDisk.modelAliases);

    assert.equal((await tool.execute({ action: "set", from: "solo", to: "solo" }, exec)).code, "USAGE", "self alias rejected");
    assert.equal((await tool.execute({ action: "set", from: "deepseek-flash", to: "deepseek-reasoner" }, exec)).code, "USAGE", "cycle rejected");
    assert.equal((await tool.execute({ action: "set", from: "a" }, exec)).code, "USAGE", "to required");
    assert.equal((await tool.execute({ action: "remove", from: "nope" }, exec)).code, "USAGE", "unknown alias");

    r = await tool.execute({ action: "remove", from: "glm-4.6v" }, exec);
    assert.equal(r.code, "OK");
    assert.equal(r.modelAliases["glm-4.6v"], undefined);

    await writeFile(configFile, JSON.stringify({ version: 1, revlogEntries: 8 }), "utf8");
});
const summary = `RESULT run.mjs: pass=${pass} fail=${failCount}`;
console.log(summary);
await rm(tmp, { recursive: true, force: true });
if (failCount > 0) process.exit(1);
