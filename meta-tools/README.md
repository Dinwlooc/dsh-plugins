# dsh-meta-tools

DeepSeek Harness host plugin: model-facing tools that build and maintain a
per-model **prompt & knowledge meta library** in any workspace, under `.dsh/`.

## Scope declaration

**No weak-AI support** (Owner decision 2026-10-26): the tools assume a model that
can follow two-phase routing and native-file-tool discipline. There is no
`--brief` mode, no weak-model fallback.

## What it installs (v3)

- `meta_route` — zero-arg inventory call (routable task types, removed tombstones,
  the calling model's library dir, config paths; ALSO the sole provisioning point:
  creates the model dir + taskType dirs with the SESSION root), then a routing call
  with `taskType` that returns must-read **PATHS ONLY** (workspace-relative, with
  line counts, capped at `routeMaxFiles`) — never inline bodies; the model opens
  paths with its native read tool (Owner addition 2026-10-27).
- `meta_sign`（签发）— the revision recorder. After the model writes/edits a
  meta-layer file with native tools, signing appends `- <ISO> | <model> |
  <revisionBasis> | sha=<8> lines=<n>[ | note]` to the companion `<file>.revlog.md`
  and trims to `revlogEntries`. Hard checks: confinement, NOT_FOUND, `.md` only,
  `.revlog.md` refused. Soft: an unchanged-hash sign succeeds with an `unchanged`
  warning (re-attestation is legitimate). It does NOT edit the file.
- `meta_tasktype` — model self-service for the PROJECT task-type registry
  `.dsh/meta/tasktypes.json` `{active: [], removed: []}`. `register` activates (or
  creates) a type; `remove` tombstones it — folders are KEPT, routing excludes it;
  tombstones win over theme presets and public/ adoption. Harness preset packages
  are unaffected.
- `meta_theme` — view/switch theme presets (unchanged from v2).
- One system-prompt section pointing the model to `meta_route`.
- The session→model projection (`request/context` fold) so tools know which model
  is calling.

## What v3 removed (Owner rulings 2026-10-27)

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
.dsh/meta/config.json          issuance config {revlogEntries} (model-editable)
.dsh/public/meta/              strong-loaded prompts (loaded for EVERY task type)
.dsh/public/<taskType>/        shared per-task-type files (细则.md = must-read)
.dsh/<系>/<model>/             per-model library (dirs provisioned by meta_route)
.dsh/<系>/<model>/meta.md      per-model second-level meta (self-maintained)
```

## Configuration (Settings UI)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | bool | `true` | master switch |
| `scaffold` | string | `"fill"` | `off` disables dir filling |
| `revlogEntries` | number | `8` | fallback entry cap (project config wins; legacy `revlogMaxLines` accepted one version) |
| `routeMaxFiles` | number | `40` | must-read path cap — deliberately NOT model-editable |

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
