/**
 * Pure message-repair rules for `dsh-request-guard` (stage B).
 *
 * Operates on DSH-native messages (before any provider adapter converts them):
 *   assistant:  { role: 'assistant', content: [ { type: 'tool-call', id, name, arguments } ] }
 *   results:    { role: 'toolResult', content: [ { type: 'tool-result', toolCallId, ... } ] }
 *
 * Why this layer exists at all: `@deepseek-ai/dsh-agent-loop` deep-freezes the
 * derived messages, so the public `llm/stream` waterfall cannot edit them. The
 * caller of `stream()` still can — a wrapped `stream` hands the adapter a NEW
 * options object, which is how upstream dsh-healer does it too (we use the
 * service instance instead of resolving the module, so no version pinning).
 *
 * Rules (all conservative — when in doubt, keep the message):
 *   R1 tool-call with an empty/blank `name`  -> drop the block (nothing can execute it)
 *   R2 tool-result with no matching tool-call -> drop the message
 *   R3 assistant tool-call without a matching result in the messages that
 *      immediately follow -> synthesize one, so providers that require strict
 *      adjacency (Anthropic-style) never see an orphaned `tool_use`
 *   R4 results separated from their call by another assistant message -> drop
 *   R5 tool-call `arguments` that is not a plain object -> {}
 */

const EMPTY = '';

function isBlank(value) {
    return typeof value !== 'string' || value.trim() === EMPTY;
}

function blocksOf(message) {
    return Array.isArray(message?.content) ? message.content : null;
}

/** tool-call ids declared by an assistant message (surviving ones only). */
export function toolCallIds(message) {
    const blocks = blocksOf(message);
    if (message?.role !== 'assistant' || blocks === null) return [];
    const ids = [];
    for (const block of blocks) {
        if (block?.type !== 'tool-call') continue;
        if (typeof block.id !== 'string' || block.id === EMPTY) continue;
        if (isBlank(block.name)) continue;
        ids.push(block.id);
    }
    return ids;
}

/** results carried by a toolResult message. */
export function resultIds(message) {
    const blocks = blocksOf(message);
    if (message?.role !== 'toolResult' || blocks === null) return [];
    const ids = [];
    for (const block of blocks) {
        if (block?.type === 'tool-result' && typeof block.toolCallId === 'string' && block.toolCallId !== EMPTY) ids.push(block.toolCallId);
    }
    return ids;
}

function repairAssistant(message, report) {
    const blocks = blocksOf(message);
    if (message?.role !== 'assistant' || blocks === null) return { message, changed: false };
    let changed = false;
    const next = [];
    for (const block of blocks) {
        if (block?.type !== 'tool-call') { next.push(block); continue; }
        if (isBlank(block.name)) {
            report.droppedNamelessCalls += 1;
            changed = true;
            continue;
        }
        let out = block;
        const args = block.arguments;
        if (args === null || typeof args !== 'object' || Array.isArray(args)) {
            out = { ...out, arguments: {} };
            report.normalizedArguments += 1;
            changed = true;
        }
        next.push(out);
    }
    if (!changed) return { message, changed: false };
    if (next.length === 0) return { message: null, changed: true }; // whole assistant body was a nameless call
    return { message: { ...message, content: next }, changed: true };
}

function syntheticResultMessage(callId, toolName) {
    return {
        role: 'toolResult',
        content: [{
            type: 'tool-result',
            toolCallId: callId,
            content: [{ type: 'text', text: `No result was recorded for tool "${toolName ?? 'unknown'}" (repaired by dsh-request-guard).` }],
            isError: true,
        }],
    };
}

/**
 * Repair an outbound message array.
 *
 * @param {Array<object>} messages
 * @returns {{ messages: Array<object>, report: object, changed: boolean }}
 *   `messages` is the ORIGINAL array identity when nothing changed (cheap equality check).
 */
export function repairMessages(messages) {
    const report = {
        droppedNamelessCalls: 0,
        droppedOrphanResults: 0,
        droppedStrandedResults: 0,
        synthesizedResults: 0,
        normalizedArguments: 0,
        droppedAssistants: 0,
    };
    if (!Array.isArray(messages) || messages.length === 0) return { messages, report, changed: false };

    // Pass 1: assistant blocks (R1/R5). Remember ids that survive per message.
    const staged = messages.map((message) => repairAssistant(message, report));
    const kept = [];
    for (const step of staged) {
        if (step.message === null) report.droppedAssistants += 1;
        else kept.push(step.message);
    }

    // Pass 2: adjacency (R2/R3/R4).
    const out = [];
    let announced = new Set(); // ids declared by any assistant seen so far
    const consumed = new Set(); // ids whose result has already been placed
    for (let index = 0; index < kept.length; index += 1) {
        const message = kept[index];
        if (message?.role === 'toolResult') {
            const blocks = blocksOf(message) ?? [];
            const keptBlocks = [];
            let orphan = 0;
            let stranded = 0;
            for (const block of blocks) {
                if (block?.type !== 'tool-result') { keptBlocks.push(block); continue; }
                if (!announced.has(block.toolCallId)) { orphan += 1; continue; }
                if (consumed.has(block.toolCallId)) { stranded += 1; continue; } // R4: duplicate / replayed result
                consumed.add(block.toolCallId);
                keptBlocks.push(block);
            }
            if (orphan > 0) report.droppedOrphanResults += 1;
            if (stranded > 0) report.droppedStrandedResults += 1;
            if (keptBlocks.length === 0) continue;
            out.push(orphan + stranded > 0 ? { ...message, content: keptBlocks } : message);
            continue;
        }

        const callIds = toolCallIds(message);
        out.push(message);
        for (const id of callIds) announced.add(id);
        if (callIds.length === 0) continue;

        // R3: a call whose result never shows up in the messages that
        // immediately follow gets a synthetic one. Look ahead first — the real
        // result is never replaced by a synthetic duplicate.
        const ahead = new Set();
        for (let cursor = index + 1; cursor < kept.length && kept[cursor]?.role === 'toolResult'; cursor += 1) {
            for (const id of resultIds(kept[cursor])) {
                if (callIds.includes(id) && !consumed.has(id)) ahead.add(id);
            }
        }
        for (const id of callIds) {
            if (consumed.has(id) || ahead.has(id)) continue;
            consumed.add(id);
            const block = blocksOf(message).find((b) => b?.type === 'tool-call' && b.id === id);
            out.push(syntheticResultMessage(id, block?.name));
            report.synthesizedResults += 1;
        }
    }

    const changed = out.length !== messages.length
        || out.some((message, index) => message !== messages[index])
        || report.droppedNamelessCalls > 0 || report.droppedOrphanResults > 0
        || report.droppedStrandedResults > 0
        || report.synthesizedResults > 0 || report.normalizedArguments > 0
        || report.droppedAssistants > 0;
    if (!changed) return { messages, report, changed: false };
    return { messages: out, report, changed: true };
}
