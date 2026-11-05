// peer.js - resolve the host-provided peer packages (@deepseek-ai/dsh-*) at runtime.
//
// WHY: this plugin declares @deepseek-ai/dsh-llm / dsh-tools as PEERS. Under a
// workspace `link:` install there is no node_modules entry for them, so a static
// bare import throws ERR_MODULE_NOT_FOUND, and the lazy `import("./tool-search.js")`
// in lib/index.js only warns - the whole disclosure integration (bridge tools,
// manifest, tools:sdk re-render) silently disappears and the tool face stays full.
//
// Host 0.2.2-rc.1 moved the PTC SDK renderer out of @deepseek-ai/dsh-tools into
// @deepseek-ai/dsh-tool-executor-ptc, so the old specifier resolves nothing even
// when installed. Resolution order per package: bare specifier (a real install),
// then the host bundle located from process.execPath (same walk as
// test/host-hooks.mjs).
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Host bundle node_modules/@deepseek-ai roots, nearest first. */
function hostRoots() {
    const roots = [];
    let dir = path.dirname(process.execPath);
    for (let i = 0; i < 8; i++) {
        for (const prefix of [["app.asar"], ["resources", "app.asar"]]) {
            const candidate = path.join(dir, ...prefix, "dsh", "node_modules", "@deepseek-ai");
            if (existsSync(path.join(candidate, "dsh-tools", "package.json"))) roots.push(candidate);
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return roots;
}

const HOST_ROOTS = hostRoots();

/** Import a specifier, falling back to the host bundle's own copy. */
async function resolvePackage(specifier) {
    let bare;
    try {
        return await import(specifier);
    } catch (error) {
        bare = error;
    }
    const name = specifier.slice(specifier.indexOf("/") + 1);
    for (const root of HOST_ROOTS) {
        const entry = path.join(root, name, "lib", "index.js");
        if (!existsSync(entry)) continue;
        try {
            return await import(pathToFileURL(entry).href);
        } catch { /* next host copy */ }
    }
    throw bare;
}

let pending;

/**
 * Load the peer surface once per process.
 * @returns {Promise<{ToolCallId: Function, defineTool: Function, renderToolsSdk: Function, renderToolsSdkPy: Function}>}
 * @throws when an installed copy and the host bundle both lack the symbol
 */
export function loadPeers() {
    pending ??= (async () => {
        const llm = await resolvePackage("@deepseek-ai/dsh-llm");
        const tools = await resolvePackage("@deepseek-ai/dsh-tools");
        let render = null;
        for (const specifier of ["@deepseek-ai/dsh-tool-executor-ptc", "@deepseek-ai/dsh-tools"]) {
            let candidate = null;
            try {
                candidate = await resolvePackage(specifier);
            } catch {
                candidate = null;
            }
            if (candidate !== null && typeof candidate.renderToolsSdk === "function") {
                render = candidate;
                break;
            }
        }
        if (typeof llm.ToolCallId !== "function") throw new Error("peer @deepseek-ai/dsh-llm exposes no ToolCallId");
        if (typeof tools.defineTool !== "function") throw new Error("peer @deepseek-ai/dsh-tools exposes no defineTool");
        if (render === null) throw new Error("no peer exposes renderToolsSdk (checked dsh-tool-executor-ptc, dsh-tools)");
        return {
            ToolCallId: llm.ToolCallId,
            defineTool: tools.defineTool,
            renderToolsSdk: render.renderToolsSdk,
            renderToolsSdkPy: render.renderToolsSdkPy,
        };
    })();
    return pending;
}
