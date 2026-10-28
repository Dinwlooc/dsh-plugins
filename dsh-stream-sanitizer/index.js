// dsh-stream-sanitizer — 在 llm/stream 瀑布里修好畸形的 tool-call 块。
//
// 病根：provider（GLM 4.6V 实测）偶发把 tool call 的 id/name 发成空串，适配层 dsh-llm-pi-ai
// 原样写入 block-end 的 block.id = ""，agent-loop 用它构造 tool/result，
// 写入时被 dsh-session-format-v3-to-v4 的校验拒绝（空 toolCallId），整轮卡死且会话无法恢复。
//
// 处置：只补 id，不改 name、不改 arguments、不改消息内容。
//   · block-start / tool-call-delta 里 id 为空 → 分配一个本流稳定的合成 id；
//   · block-end 的 tool-call 块 id 为空 → 用同一个合成 id（并用它覆盖块内 id）；
//   · name 为空不动 —— 让上游照常报 unknown tool，但带着非空 id 落盘，回合正常结束、会话存活。
//
// 不注入消息、不删块、不碰其它 chunk 类型；任何异常都原样透传（绝不让修流器把正常流弄坏）。
export const name = 'stream-sanitizer';
export const inject = ['webServer'];

const DEFAULTS = Object.freeze({
    enabled: true,
    // 合成 id 前缀，便于在日志里认出这是本地补的。
    idPrefix: 'call-synth',
});

export function apply(ctx, config = {}) {
    const cfg = {
        enabled: config.enabled !== false,
        idPrefix: typeof config.idPrefix === 'string' && config.idPrefix.length > 0 ? config.idPrefix : DEFAULTS.idPrefix,
    };
    const stats = { fixed: 0, streams: 0, lastFixAt: null, lastIndex: null };
    let counter = 0;

    const synthId = (index) => {
        counter += 1;
        return `${cfg.idPrefix}-${Date.now().toString(36)}-${index}-${counter}`;
    };

    ctx.on('llm/stream', (options, next) => {
        const upstream = next();
        if (!cfg.enabled || !upstream || typeof upstream[Symbol.asyncIterator] !== 'function') return upstream;
        return sanitize(upstream, synthId, stats);
    });

    ctx.effect(() => {
        const handler = async (req, res) => {
            try {
                const url = String(req.url ?? '').split('?')[0].replace(/\/+$/, '');
                if (req.method === 'GET' && url.endsWith('/api/stats')) {
                    sendJson(res, 200, { ok: true, enabled: cfg.enabled, stats });
                    return;
                }
                sendJson(res, 404, { ok: false, error: 'unknown stream-sanitizer endpoint' });
            } catch {
                sendJson(res, 500, { ok: false, error: 'stats request failed' });
            }
        };
        return ctx.webServer.register({ kind: 'prefix', path: '/stream-sanitizer', handler });
    }, 'stream-sanitizer: stats API');
}

/** 纯变换：喂 chunk，出 chunk。可单测。 */
export async function* sanitize(upstream, makeId, stats) {
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
                if (stats) {
                    stats.fixed += 1;
                    stats.lastFixAt = Date.now();
                    stats.lastIndex = chunk.index ?? null;
                }
                continue;
            }
            if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'tool-call') {
                const blockId = chunk.block.id;
                if (blockId === undefined || blockId === null || blockId === '') {
                    const id = idFor(chunk.index);
                    yield { ...chunk, block: { ...chunk.block, id } };
                    if (stats) {
                        stats.fixed += 1;
                        stats.lastFixAt = Date.now();
                        stats.lastIndex = chunk.index ?? null;
                    }
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
