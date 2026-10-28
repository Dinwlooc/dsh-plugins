/**
 * Session→model projection unit (H-decision f).
 *
 * A pure, replayable fold over the session log: `request/context` events carry the
 * resolved `{ provider, model }` of every admitted request. Folding them gives each
 * session's working model as derived cache state — checkpointed by the projection
 * registry, so it survives plugin reload, and never appended to the session log by
 * us (appendPluginRecord is reserved for DSH experimental packages).
 *
 * Registry key discipline (H-finding 3): the EXACT model string is the key; the 系
 * directory (first prefix) is grouping only.
 */
export const MODEL_MAP_KEY = "metaToolsModelMap";

/**
 * Minimal Standard-parse codec for the tiny {model} state. The projection
 * registry calls stateSchema.parse on persisted rows at restore AND
 * wire.viewSchema.parse on every view checkpoint (dsh-session-projection
 * lib/index.js:296/:304/:255) — only .parse is ever called, so a plain object
 * satisfies the contract; zod is unresolvable from a workspace-linked package.
 */
const modelMapStateSchema = {
    parse(value) {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            throw new TypeError("metaToolsModelMap state must be { model: string | null }");
        }
        const model = value.model;
        if (model !== null && typeof model !== "string") {
            throw new TypeError("metaToolsModelMap state.model must be string or null");
        }
        return { model: model ?? null };
    },
};

export const modelMapProjection = {
    key: MODEL_MAP_KEY,
    stateSchema: modelMapStateSchema,
    stateVersion: 1,
    init: () => ({ model: null }),
    apply: (state, event) => {
        if (event.type !== "request/context") return state;
        const model = event.data?.model;
        if (typeof model !== "string" || model === "" || model === state.model) return state;
        return { ...state, model };
    },
    wire: {
        viewSchema: modelMapStateSchema,
        view: (state) => ({ model: state.model ?? null }),
    },
};

/** Read the calling session's model from the projection registry (null when unknown). */
export function modelOfSession(ctx, session) {
    try {
        const projections = ctx.sessionProjections;
        if (projections === undefined || projections === null) return null;
        const state = typeof projections.stateOf === "function"
            ? projections.stateOf(session, MODEL_MAP_KEY)
            : projections.snapshot?.(session)?.values?.[MODEL_MAP_KEY];
        return typeof state?.model === "string" && state.model !== "" ? state.model : null;
    } catch {
        return null;
    }
}
