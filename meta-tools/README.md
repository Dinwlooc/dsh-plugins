# dsh-meta-tools

DeepSeek Harness host plugin: model-facing tools that build and maintain a
per-model **prompt & knowledge meta library** in any workspace, under `.dsh/`.

**Integrated surface**: routing + cold-start plan + provisioning (`meta_route`),
revision signing (`meta_sign`), the project task-type registry
(`meta_tasktype`), model-identity aliases (`meta_alias`), theme presets
(`meta_theme`), prompt injection (`public/meta` for the main agent,
`.dsh/meta/SUBAGENTS.md` for delegated children), a vendored tool-search disclosure
engine (`tool_search` / `tool_describe` / `tool_call` / `tool_slimmer_*`) with
a session-frozen catalog, and its own **Meta-tools** Settings column.

## 文案位置（0.3.1）

模型面文案（工具输出与提示语，会进上下文）集中在 `lib/messages.js`；四个工具的 presenter 只做数据装配。改文案 = 改一个文件，不碰逻辑。

## Scope declaration

**No weak-AI support** : the tools assume a model that
can follow two-phase routing and native-file-tool discipline. There is no
`--brief` mode, no weak-model fallback.

## What it installs (v3)

- `meta_route` — zero-arg inventory call (routable task types, the calling model's
  library dir, knowledge-base entry; ALSO the sole provisioning point: creates the
  model dir + taskType dirs with the SESSION root). If the project has no task
  types, it returns setup steps for `meta_tasktype`. The routing call with
  `taskType` returns must-read **PROMPT/细则 PATHS ONLY** (workspace-relative, with
  line counts, capped at `routeMaxFiles`) — never inline bodies, and never
  knowledge papers (`NNNN-*.md`): those are found by `grep` / `project_files find`
  after routing . The model opens paths with its native read tool.
- `meta_sign`（签发）— the revision recorder, **opt-in**: it is called only when
  the project's own rules ask for a signing record (this plugin does not require
  one). Signing appends `- <ISO> | <model> |
  <revisionBasis> | sha=<8> lines=<n>[ | note]` to the companion `<file>.revlog.md`
  and trims to `revlogEntries`. Hard checks: confinement, NOT_FOUND, `.md` only,
  `.revlog.md` refused. Soft: an unchanged-hash sign succeeds with an `unchanged`
  warning (re-attestation is legitimate). It does NOT edit the file.
- `meta_alias` — the model-identity alias table `.dsh/meta/config.json`
  `modelAliases`: `list|set|remove`. A raw session model id routes to ANOTHER
  model's library (shared must-reads) while reports/revlog keep the factual
  model. Cross-family aliases are allowed but warned; empty/self aliases and
  cycles are rejected.
- `meta_tasktype` — model self-service for the PROJECT task-type registry
  `.dsh/meta/tasktypes.json` `{active: [], removed: []}`. `register` activates (or
  creates) a type; `remove` tombstones it — folders are KEPT, routing excludes it;
  tombstones win over theme presets and public/ adoption. Harness preset packages
  are unaffected.
- `meta_theme` — view/switch theme presets (unchanged from v2).
- One system-prompt section pointing the model to `meta_route`.
- **v3.2 bootstrap section** : every body file under
  `.dsh/public/meta/` is a must-read for **every** task type by design, so it is
  injected into the system prompt once per agent (`agent/created` → a section on
  `agent.ctx`, constant for the session). Signing mirrors (`*.revlog.md`) and
  knowledge papers (`NNNN-*.md`) are never injected. `inventoryPlan` then stops
  listing those files (no double payment). Switch: `bootstrap` (default `true`)
  and `bootstrapMaxChars` (default 64000; 0 = no cap).

- **v3.3 subagent switch** : the same bootstrap is skipped for delegated children
  by default (`.dsh/meta/config.json` `{"bootstrapSubagents": true}` opts them back
  in). Detection is the child session header `origin: "subagent"`; the main agent is
  always injected. Settings panel row: 「子模型提示词注入」.
- **v4 child-only prompt** : `.dsh/meta/SUBAGENTS.md` is injected into delegated
  children INSTEAD of the parent prompt set — a full replacement, not an append.
  Its prototype is the H seat's hand-dispatched `.dsh/meta/HIGH.md`. **Both the
  switch and the FILE NAME are Owner config in the Meta-tools settings column**
  (project `.dsh/meta/config.json` wins over the instance default; default on /
  `SUBAGENTS.md`), and the column reports whether the file is actually present —
  ON with no file means children get no prompt, never a silent "looks fine". The
  file is NOT size-capped (one Owner-authored file; truncating it is worse), and
  the whole child prompt is subordinate to the main `bootstrap` switch. When the
  file is absent the v3.3 ladder applies unchanged. Only newly created children
  are affected.
- **v3.1 cold-start plan** : the zero-arg inventory also
  returns `plan {shared: [...], perType: {<type>: [...]}}` — every routable
  type's must-read paths (no bodies, no line counts). One call is therefore
  normally enough to start reading; the `taskType` call remains for line counts
  and a re-checked route. Switch: `inventoryPlan` (default `true`); with `false`
  the old two-call flow and its `nextHint` remain.
- The session→model projection (`request/context` fold) so tools know which model
  is calling.

## Tool search & disclosure (0.4.0)

- Vendored from `dsh-tool-search@0.1.8` (MIT, `LICENSE.upstream`) into `lib/tools/`; the integration and its policy live in `lib/tool-search.js`. No upstream file is edited, so re-vendoring is a file copy.
- Registers `tool_search` / `tool_describe` / `tool_call` / `tool_slimmer_catalog` / `tool_slimmer_update_config` plus the `system-prompt/assemble` disclosure transform. Groups and the eager `core` list keep living in `~/.dsh/dsh-tool-search.json` (or `<workspace>/.dsh/dsh-tool-search.json`), so existing configuration carries over unchanged.
- **Session-frozen tool face (owner policy)**: the first non-empty disclosure of a session freezes the WHOLE face — tier, tool table, the rendered `tools:sdk` declaration block and the manifest text — and every later assembly reuses it verbatim. The SDK block matters on its own: it is re-rendered from the live registry on every assembly, so one newly registered tool (e.g. `ask_user_question`) otherwise appends a declaration and invalidates the cached prompt prefix. Freezing only the listing text was not enough: the tier decision re-reads the live registry on every assembly, so warming a tool or registering a plugin rewrote the tool table and re-pushed the entire runtime-context snapshot (measured: three snapshots in one session, 3.3k chars each, one of them an order-only change). Consequences, by design:
  - **Names stay listed, schemas are masked** — the tier is capped at 2 (names-only), so tier 3 can never drop tools from the face; accurate schemas come back on demand via `tool_describe`.
  - **Warming does not expand the prompt** — `tool_search`/`tool_describe` still rank and resolve against the live registry, but a match no longer injects a schema, so the prompt prefix stays byte-stable.
  - **New tools need a new session** (or a reload) to appear; an old session keeps its frozen face.
  - **A frozen face can go stale** — calling a tool that was listed at freeze time but has since been unregistered answers with an explicit "no longer registered — restart the session" error instead of a silent failure.
- **Install this, then remove the original `dsh-tool-search`**: two engines produce two catalogs. Duplicates are collapsed defensively, but the original must go.
- `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-tools` are PEERS — the host provides them. Do not vendor local copies; they would shadow the host's classes (the test preload exists for exactly that reason).
- Tests: `pnpm test`, or `node --import ./test/host-hooks.mjs test/run.mjs` and `node --import ./test/host-hooks.mjs test/tool-search.test.mjs`. The preload resolves the peers from a host bundle when present and falls back to minimal stand-ins otherwise; the freeze fixtures compare the whole rendered snapshot and cover tier 0→1, per-session isolation, duplicate collapse, the frozen tool table and the tier≤2 cap.

## Prompt-set injection determinism (0.5.0)

The always-read prompt set (`.dsh/public/meta/*.md`, revlogs and `NNNN-*` papers
excluded) reaches an agent as a system-prompt section named
`dsh-meta-tools:bootstrap` at order 3140; a delegated agent instead receives
`dsh-meta-tools:subagent-prompt` (the file named by `subagentPromptFile`, default
`HIGH.md`). `bootstrapMaxChars` caps the parent set (0 = no cap); a block that
would overflow the cap is skipped whole, never truncated.

Registration used to depend on `agent/created` alone. A session created while the
plugin (or the `workingDirectory` service) was still mounting went without the
section, and a later reload re-created the agent and injected it mid-session —
a full prompt-prefix change worth several thousand tokens. Both hooks now share
one resolver (`sectionFor`) and one workspace reader (`dirFor`, cached by the
directory's mtime):

- `agent/created` registers the section on that agent's ctx (normal path);
- `system-prompt/assemble` inserts the same section at the same order when an
  assembly lacks it (fallback path). Insertion is skipped when a section with
  that name is already present, so the two paths can never double-inject.

Behaviour: parent sessions always carry the prompt set from their first request;
subagent sessions carry the child prompt only (the parent set is opt-in via
`bootstrapSubagents`); a workspace without `.dsh/public/meta` gets nothing.

## What v3 removed 

- **The model registry**: `.dsh/meta/registry.json` (models[]) is retired; the
  project meta folder carries a task-type registry only. No character constants,
  no meta.md stubs, no turn/end registration hook.
- **`meta_file`** (custom read/write/delete/search) — native tools are better.
  Deletion of meta files goes through the godot-creator `project_files` (main
  session only); search through native `grep` with `path` set to `.dsh`.

## Library layout

```
.dsh/.tmp/                     scratch (scaffold adoption record)
.dsh/meta/tasktypes.json       PROJECT task-type registry (active/removed; model-maintained)
.dsh/meta/config.json          project config {revlogEntries, signEnabled, modelAliases,
                               bootstrapSubagents, subagentPrompt} (model-editable)
.dsh/meta/SUBAGENTS.md         CHILD-ONLY prompt (replaces the parent set; name is config)
.dsh/public/meta/              strong-loaded prompts (loaded for EVERY task type)
.dsh/public/<taskType>/         shared per-task-type files (细则.md = must-read; NNNN-*.md = search-only)
.dsh/<系>/<model>/             per-model library (dirs provisioned by meta_route)
.dsh/<系>/<model>/meta.md      per-model second-level meta (self-maintained)
```

## Configuration (independent "Meta-tools" settings column)

Owner ruling 2026-10-29: meta-tools configuration is its own Settings **section**
(`settings.section`, label "Meta-tools 配置" / "Meta Tools") — it is no longer a
card inside Settings → General. The section holds the per-project sign switch and
the theme presets, and talks to the host through `/api/meta-tools/config`
(GET = state, POST = `{signEnabled}` | `{bootstrapSubagents}` | `{theme}` | `{themes}`).

### Per-project sign switch (`.dsh/meta/config.json` → `signEnabled`)

- The toggle edits the PROJECT file (other keys preserved: `revlogEntries`,
  `modelAliases`); the patch-level `signEnabled` is only the instance default for
  projects without that key. A workspace with no `.dsh` yet refuses the toggle
  (storing it would create `.dsh` and cancel theme auto-apply for the first
  scaffold).
- **The tool is never unregistered.** Removing `meta_sign` mid-session would
  reshape the tool surface and invalidate the prompt cache , so
  "off" is an ANSWER: every call returns code `SIGN_DISABLED` with an English
  reminder that signing is disabled for this project, plus the instruction to
  skip signing silently and **not mention the error or the setting in the reply
  body**. No revlog is written.
- The disabled check runs before argument validation, so a call while off never
  produces a misleading `USAGE` / `NOT_FOUND`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | bool | `true` | master switch |
| `scaffold` | string | `"fill"` | `off` disables dir filling |
| `revlogEntries` | number | `8` | fallback entry cap (project config wins; legacy `revlogMaxLines` accepted one version) |
| `routeMaxFiles` | number | `40` | must-read path cap — deliberately NOT model-editable |
| `signEnabled` | bool | `true` | instance default for the sign switch (`.dsh/meta/config.json` wins) |
| `subagentPrompt` | bool | `true` | instance default for the child-only prompt (`.dsh/meta/config.json` wins) |
| `subagentPromptFile` | string | `"SUBAGENTS.md"` | child prompt file name under `.dsh/meta/` (flat `.md` only; project file wins) |

Preset packages are **patch-level config only** (not in the Settings UI): set them
in the bundle patch row's `config:` — `presets: [{ theme: "...", taskTypes:
["...", ...] }]`. normalizeConfig is their only validator.

## Install

Author in a workspace directory, then `plugin_manager` → `install_bundle` with the
package directory. Changes are live profile-wide after activation (registry
tool-list refresh needs a new session).

## Known limits (v3)

- Library root: explicit config `root` wins; otherwise the CALLING session's
  working directory, falling back to `process.cwd()` at activation. Provisioning
  runs inside tools (session root by construction) — the v2 agent/created hook
  that scaffolded the profile dir is gone.
- Tool `output.render` must return a content-parts array (`[{type:'text',...}]`).
- Per-round model registration is gone; `meta_route` inventory provisions.
- Concurrent signing of one file: appendRevlog is read-modify-write (tmp+rename);
  the last writer can drop an entry. Accepted in v3; the sha8 keeps it auditable.
- Revlog cap 8 (entries) is a different carrier from the in-body 修订史折叠
  (6→2, 元层更新原则) — do not "fix" one against the other.
