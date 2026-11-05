// host-hooks.mjs - preload for the test entries (node --import ./test/host-hooks.mjs ...).
// The plugin declares @deepseek-ai/dsh-llm and @deepseek-ai/dsh-tools as PEERS: the
// host provides them at runtime, and a local copy would shadow the host's classes.
// Under a plain node process an app.asar bundle is not a readable directory, so the
// preload resolves the peers from the host bundle when it can and otherwise installs
// minimal stand-ins (enough to load the plugin; the freeze logic is what is tested).
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const STUBS = {
    "@deepseek-ai/dsh-llm": "data:text/javascript,export function ToolCallId(v){return String(v)}",
    "@deepseek-ai/dsh-tools": "data:text/javascript,export function defineTool(o){return o}export function renderToolsSdk(){return ''}export function renderToolsSdkPy(){return ''}",
};

/** Locate the host bundle's node_modules, if this process can see it. */
export function findHostNm() {
    let dir = path.dirname(process.execPath);
    for (let i = 0; i < 8; i++) {
        for (const prefix of [["app.asar"], ["resources", "app.asar"]]) {
            const candidate = path.join(dir, ...prefix, "dsh", "node_modules", "@deepseek-ai");
            if (existsSync(path.join(candidate, "dsh-tools", "package.json"))) return candidate;
        }
        dir = path.dirname(dir);
    }
    return null;
}

export const hostNm = findHostNm();
/** True when the real host modules (not the stand-ins) are in use. */
export const HOST_MODULES_OK = hostNm !== null;

const map = {
    "@deepseek-ai/dsh-llm": hostNm === null ? STUBS["@deepseek-ai/dsh-llm"] : pathToFileURL(path.join(hostNm, "dsh-llm", "lib", "index.js")).href,
    "@deepseek-ai/dsh-tools": hostNm === null ? STUBS["@deepseek-ai/dsh-tools"] : pathToFileURL(path.join(hostNm, "dsh-tools", "lib", "index.js")).href,
};
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (Object.hasOwn(map, specifier)) return { url: map[specifier], shortCircuit: true };
        return nextResolve(specifier, context);
    },
});
