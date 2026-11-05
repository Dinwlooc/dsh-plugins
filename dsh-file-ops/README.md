# dsh-file-ops

Structured text operations over one file or a whole tree: block copy / move / swap, whole-word replace
across a directory, and paged sentence lookup.

Five model-facing tools. **Writes go through `ctx.fs`** — the mounted backend enforces the sandbox, writes
atomically and checks the version — and **the tool presents its own diff card**, the same contract
`@deepseek-ai/dsh-tool-fs` uses:

```js
presentResult => { card: 'diff', title, diffs: [{ path, oldText, newText }], locations: [{ path }] }
```

## Observation

Every file is observed through `ctx.fs` immediately before it is mutated, and the resulting version is
emitted as `fs/observed`, so a later `edit` by the model sees a fresh version instead of `FS_NOT_OBSERVED`.
A file that changed between the read and the commit is refused, not overwritten.

## Tools

| tool | does |
|---|---|
| `replace_in_files` | whole-word, case-sensitive literal replace in every file with one suffix under a directory; empty replacement deletes |
| `copy_block` | copy a line range to a target line, same file or another; `position` after/before, `mode` insert/overwrite |
| `move_block` | move a line range and remove the source lines; same-file targets are rebased |
| `swap_blocks` | the block moves above the target line, the target line returns to the block first-line slot; `X,A1,A2,Y,L,Z` block `2-3` with line `5` gives `X,L,Y,A1,A2,Z` |
| `find_sentences` | sentences containing a literal, grouped by file and line, 10 per page, verbatim |

Line numbers are 1-based and inclusive; paths resolve against the session workspace unless absolute.
Searches skip `.git`, `.godot`, `.import`, `.trash`, `.tmp`, `node_modules`, `__pycache__`.

## Safety

- Cross-file move and swap touch two files; if the second commit fails the first is restored, and the
  restore is skipped (reported as such) when the file changed since this tool wrote it.
- Mixed line endings in one file are refused; CRLF files keep their endings.

## Test

`node test/run.mjs` — fixtures over a fake `ctx.fs`; ends with `RESULT dsh-file-ops: pass=42 fail=0`.
