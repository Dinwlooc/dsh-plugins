// dsh-request-guard — one plugin, three layers of protection against a session
// that a malformed provider response can otherwise wedge or poison.
//
// The incident this exists for (raw log evidence, GLM 4.6V twice):
//   provider emits a tool-call block with id="" and name="";
//   agent-loop dispatches it, tries to persist `tool/result` with an empty
//   callId, session-format validation rejects the write, the turn never settles
//   and every later resume rediscovers the same pending call — permanent wedge.
//
// Layers:
//   A (write side, llm/stream): fill an empty tool-call id with a stable
//     synthetic one. The turn can then settle and the session survives.
//   B (read side, wrapped llm service): repair the OUTBOUND message array —
//     drop nameless calls and orphan results, synthesize results for calls that
//     lost theirs, normalize non-object arguments. This is what makes a history
//     that is ALREADY poisoned usable again.
//   C (error side, agent/request-error): a pairing/adjacency 400 is retried
//     once, after B has had a chance to clean the retried request.
//
// Stage B cannot use the public `llm/stream` waterfall: agent-loop deep-freezes
// the derived messages and the options object, so listeners can only observe.
// Wrapping the `llm` service's `stream` method lets us hand the adapter a NEW
// options object. We wrap the live service instance (not a resolved module), so
// there is no @deepseek-ai/dsh-llm version pin and no duplicate-copy hazard.
// Every layer fails open: a repair error must never break a working request.

import { repairMessages } from './lib/repair.js';

export const name = 'request-guard';
export const inject = ['webServer'];

const DEFAULTS = Object.freeze({
    enabled: true,
    idPrefix: 'call-synth',
    repairRequests: true,
    healOnRetry: true,
    maxHealsPerTurn: 1,
});

/** pairing/adjacency failure texts that stage B can actually fix. */
const PAIRING_FAILURE = /tool[_ ]?calls?|tool_use|tool_result|toolCallId|tool messages?/i;

export function apply(ctx, config = {}) {
    const cfg = {
        enabled: config.enabled !== false,
        idPrefix: typeof config.idPrefix === 'string' && config.idPrefix.length > 0 ? config.idPrefix : DEFAULTS.idPrefix,
        repairRequests: config.repairRequests !== false,
        healOnRetry: config.healOnRetry !== false,
        maxHealsPerTurn: Number.isFinite(config.maxHealsPerTurn) ? Math.max(0, Math.trunc(config.maxHealsPerTurn)) : DEFAULTS.maxHealsPerTurn,
    };
    const stats = {
        filledIds: 0,
        repairedRequests: 0,
        droppedNamelessCalls: 0,
        droppedOrphanResults: 0,
        droppedStrandedResults: 0,
        synthesizedResults: 0,
        normalizedArguments: 0,
        droppedAssistants: 0,
        retries: 0,
        streams: 0,
        lastRepairAt: null,
        lastError: null,
    };
    let counter = 0;
    const synthId = (index) => {
        counter += 1;
        return `${cfg.idPrefix}-${Date.now().toString(36)}-${index}-${counter}`;
    };

    // ---- A: write side ------------------------------------------------------
    ctx.on('llm/stream', (options, next) => {
        const upstream = next();
        if (!cfg.enabled || !upstream || typeof upstream[Symbol.asyncIterator] !== 'function') return upstream;
        return sanitizeStream(upstream, synthId, stats);
    });

    // ---- B: read side (wrap the live llm service) ---------------------------
    if (cfg.repairRequests) {
        ctx.inject(['llm'], (sub) => {
            sub.effect(() => {
                let service;
                try {
                    service = sub.get('llm');
                } catch {
                    return () => {};
                }
                const proto = service && Object.getPrototypeOf(service);
                if (!proto || typeof proto.stream !== 'function') return () => {};
                if (proto[WRAPPED]) return () => {};
                const original = proto.stream;
                proto.stream = function guardedStream(options) {
                    try {
                        if (cfg.enabled && options && Array.isArray(options.messages)) {
                            const { messages, report, changed } = repairMessages(options.messages);
                            if (changed) {
                                stats.repairedRequests += 1;
                                stats.droppedNamelessCalls += report.droppedNamelessCalls;
                                stats.droppedOrphanResults += report.droppedOrphanResults + report.droppedStrandedResults;
                                stats.synthesizedResults += report.synthesizedResults;
                                stats.normalizedArguments += report.normalizedArguments;
                                stats.droppedAssistants += report.droppedAssistants;
                                stats.lastRepairAt = Date.now();
                                options = { ...options, messages };
                            }
                        }
                    } catch (error) {
                        stats.lastError = String(error && error.message ? error.message : error);
                    }
                    return original.call(this, options);
                };
                Object.defineProperty(proto, WRAPPED, { value: true, enumerable: false });
                return () => {
                    proto.stream = original;
                    delete proto[WRAPPED];
                };
            }, 'request-guard: outbound repair');
        });
    }

    // ---- C: error side (one retry after a pairing 400) ----------------------
    if (cfg.healOnRetry) {
        const healedTurns = new Map();
        ctx.on('agent/request-error', (payload, next) => {
            const failure = payload && payload.failure;
            if (!cfg.enabled || !failure || failure.code !== 'INVALID_REQUEST') return next();
            if (typeof failure.message !== 'string' || !PAIRING_FAILURE.test(failure.message)) return next();
            const turn = payload.turn;
            const used = healedTurns.get(turn) ?? 0;
            if (used >= cfg.maxHealsPerTurn) return next();
            healedTurns.set(turn, used + 1);
            stats.retries += 1;
            return Promise.resolve({ kind: 'retry' });
        });
    }

    // ---- D: stats -----------------------------------------------------------
    ctx.effect(() => {
        const handler = async (req, res) => {
            try {
                const url = String(req.url ?? '').split('?')[0].replace(/\/+$/, '');
                if (req.method === 'GET' && url.endsWith('/api/stats')) {
                    sendJson(res, 200, {
                        ok: true,
                        enabled: cfg.enabled,
                        repairRequests: cfg.repairRequests,
                        healOnRetry: cfg.healOnRetry,
                        stats,
                    });
                    return;
                }
                sendJson(res, 404, { ok: false, error: 'unknown request-guard endpoint' });
            } catch {
                sendJson(res, 500, { ok: false, error: 'stats request failed' });
            }
        };
        return ctx.webServer.register({ kind: 'prefix', path: '/request-guard', handler });
    }, 'request-guard: stats API');
}

const WRAPPED = Symbol.for('dsh-request-guard:wrapped');

/** Pure stream transform: feed chunks in, get chunks out. Unit-testable. */
export async function* sanitizeStream(upstream, makeId, stats) {
    const ids = new Map();
    const idFor = (index) => {
        let id = ids.get(index);
        if (id === undefined) {
            id = makeId(index);
            ids.set(index, id);
        }
        return id;
    };
    if (stats) stats.streams += 1;
    for await (const chunk of upstream) {
        try {
            if (chunk === null || typeof chunk !== 'object') {
                yield chunk;
                continue;
            }
            const hasEmptyId = chunk.id === undefined || chunk.id === null || chunk.id === '';
            if (chunk.type === 'tool-call-delta' && hasEmptyId) {
                yield { ...chunk, id: idFor(chunk.index) };
                if (stats) stats.filledIds += 1;
                continue;
            }
            if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'tool-call') {
                const blockId = chunk.block.id;
                if (blockId === undefined || blockId === null || blockId === '') {
                    yield { ...chunk, block: { ...chunk.block, id: idFor(chunk.index) } };
                    if (stats) stats.filledIds += 1;
                    continue;
                }
            }
            yield chunk;
        } catch {
            yield chunk;
        }
    }
}

function sendJson(res, status, payload) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(payload));
}

export { repairMessages, toolCallIds, resultIds } from './lib/repair.js';
