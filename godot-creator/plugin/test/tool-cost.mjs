/**
 * Per-tool token cost analyzer for a DSH session log.
 *
 *   node test/tool-cost.mjs [path/to/session.v4.jsonl.zstd]
 *
 * Omit the path to analyze the newest session log under ~/.dsh/sessions.
 *
 * Why: every tool call costs three things, and they are not symmetric.
 *   1. OUTPUT       — the call arguments the model writes (`data.arguments`).
 *   2. MISS INPUT   — the tool result, which enters the next request as new tokens.
 *   3. HIT INPUT    — that same result stays in the prefix and is re-read (cached)
 *                     by every later request, so its cached volume ≈ result × steps left.
 * This script attributes all three per tool, which turns "tools cost tokens" into a
 * ranking: big-result tools (read/inspect/logs) dominate input; big-argument tools
 * (pwsh/edit/write) dominate output; cheap-state tools (todo/usage/editor_state) are noise.
 *
 * Reading the log: session logs are append-only zstd, one frame per append batch, so a
 * single-shot decompressor stops at the first frame. Split on the zstd frame magic and
 * decode each segment, merging a segment into the next when the magic appears inside
 * compressed data (false split).
 *
 * Token estimates are bytes/4 — a mixed English/Chinese/JSON heuristic, not a tokenizer.
 * Totals printed from `assistant/message.usage` are the provider's own numbers and are
 * therefore exact; the per-tool split is the derived estimate.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function newestSessionLog() {
    const root = join(homedir(), ".dsh", "sessions");
    let best = null;
    for (const scope of readdirSync(root)) {
        const dir = join(root, scope);
        let entries = [];
        try {
            entries = readdirSync(dir);
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.startsWith("session-")) continue;
            const file = join(dir, entry, "session.v4.jsonl.zstd");
            try {
                const stat = statSync(file);
                if (best === null || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs };
            } catch {
                /* not every session dir has a log yet */
            }
        }
    }
    if (best === null) throw new Error("no session log found under ~/.dsh/sessions");
    return best.file;
}

function decompressAll(path) {
    const buf = readFileSync(path);
    const positions = [];
    for (let i = 0; i + 4 <= buf.length; i++) {
        if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) positions.push(i);
    }
    const parts = [];
    let pending = Buffer.alloc(0);
    for (let k = 0; k < positions.length; k++) {
        const start = positions[k];
        const end = k + 1 < positions.length ? positions[k + 1] : buf.length;
        const segment = Buffer.concat([pending, buf.subarray(start, end)]);
        try {
            parts.push(zlib.zstdDecompressSync(segment));
            pending = Buffer.alloc(0);
        } catch {
            pending = segment; // false split: the magic appeared inside compressed data
        }
    }
    if (pending.length > 0) throw new Error(`unresolved compressed tail: ${pending.length} bytes`);
    return Buffer.concat(parts).toString("utf8");
}

const path = process.argv[2] ?? newestSessionLog();
const events = decompressAll(path)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
        try {
            return JSON.parse(line);
        } catch {
            return null;
        }
    })
    .filter((event) => event !== null);

const assistantSeqs = events.filter((e) => e.type === "assistant/message").map((e) => e.seq).sort((a, b) => a - b);
const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const calls = new Map();
const perTool = {};

for (const event of events) {
    if (event.type === "assistant/message") {
        const usage = event.data?.usage ?? event.data?.message?.usage;
        if (usage) {
            totals.input += usage.inputTokens ?? 0;
            totals.output += usage.outputTokens ?? 0;
            totals.cacheRead += usage.cacheReadTokens ?? 0;
            totals.cacheWrite += usage.cacheWriteTokens ?? 0;
        }
        continue;
    }
    if (event.type === "tool/call") {
        const data = event.data;
        const argBytes = typeof data.arguments === "string" ? data.arguments.length : JSON.stringify(data.arguments ?? "").length;
        calls.set(data.callId, { tool: data.name, argTok: Math.round(argBytes / 4) });
        continue;
    }
    if (event.type !== "tool/result") continue;

    const data = event.data;
    const callId = data.toolCallId ?? data.message?.toolCallId;
    const call = calls.get(callId);
    if (call === undefined) continue; // result from before the retained log window
    const blocks = data.message?.content ?? data.content ?? [];
    let bytes = 0;
    for (const block of blocks) bytes += (block.text ?? block.content ?? JSON.stringify(block)).length;
    const resultTok = Math.round(bytes / 4);
    // Remaining assistant requests after this result: its cached-hit multiplier.
    let seen = 0;
    while (seen < assistantSeqs.length && assistantSeqs[seen] <= event.seq) seen += 1;
    const remaining = assistantSeqs.length - seen;

    const tool = (perTool[call.tool] ??= { calls: 0, argTok: 0, missTok: 0, hitTok: 0, maxRes: 0, results: 0 });
    tool.calls += 1;
    tool.argTok += call.argTok;
    tool.missTok += resultTok;
    tool.hitTok += resultTok * remaining;
    tool.results += 1;
    tool.maxRes = Math.max(tool.maxRes, resultTok);
}

const rows = Object.entries(perTool)
    .map(([tool, value]) => ({ tool, ...value }))
    .sort((a, b) => b.hitTok - a.hitTok);
const sum = (key) => rows.reduce((acc, row) => acc + row[key], 0);
const k = (value) => Math.round(value / 1000);
const m = (value) => (value / 1e6).toFixed(1);

console.log(`log: ${path}`);
console.log(
    `session: ${assistantSeqs.length} assistant steps, ${calls.size} tool calls | uncached input ${m(totals.input)}M | cache read ${m(totals.cacheRead)}M | output ${k(totals.output)}k`,
);
console.log(
    `tool-result share: miss ${k(sum("missTok"))}k (${Math.round((sum("missTok") / totals.input) * 100)}% of uncached) | hit ${m(sum("hitTok"))}M (${Math.round((sum("hitTok") / totals.cacheRead) * 100)}% of cached) | args ${k(sum("argTok"))}k`,
);
console.log("");
console.log("tool".padEnd(28) + "calls".padStart(6) + "args".padStart(8) + "miss".padStart(8) + "hit".padStart(9) + "hit/miss".padStart(9) + "maxRes".padStart(8));
for (const row of rows) {
    console.log(
        row.tool.padEnd(28) +
            String(row.calls).padStart(6) +
            String(row.argTok).padStart(8) +
            String(row.missTok).padStart(8) +
            m(row.hitTok).padStart(9) +
            (row.missTok > 0 ? `${Math.round(row.hitTok / row.missTok)}x` : "-").padStart(9) +
            String(row.maxRes).padStart(8),
    );
}
