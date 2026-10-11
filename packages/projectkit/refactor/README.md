# Immutable Go rename patches

`Rename` loads Go source and module declarations from an immutable snapshot. It
parses every local package, resolves declarations, uses and selector objects with
`go/types`, creates digest-bound byte edits, and type-checks the entire rewritten
local graph. Existing identifier uses must still bind to the same declarations
at their adjusted source positions. Local shadowing, aliases, generic method
receivers and Unicode identifiers are supported.

The production runner performs this computation in its own agent binary using
one exact internal worker argument. Snapshot source is sent through bounded
stdin; the helper has no credentials or workspace path. Cancellation or the
15-second checker timeout kills and reaps that process. At most two analysis
workers are admitted on one runner, before source files are loaded.

A preview creates no branch. Human confirmation repeats the analysis, checks the
complete preview fingerprint, persists an operation intent, creates a new
private branch and captures its immutable candidate snapshot. Retries reuse the
same operation receipt. The candidate receives no task acceptance or review.
Starting a run from it freezes the current project's plan, agents, budget and
checks; publication still follows normal task acceptance and merge review.

## Supported analysis boundary

- Local source imports must resolve to packages present in the snapshot.
- Standard imports use `GOROOT/src` on the runner, when installed. Missing
  standard sources are an explicit refusal; dependencies are never downloaded.
- Go 1.23 source semantics are used. Unsupported constructs are refused.
- Build constraints and platform-specific local file names are refused rather
  than silently selecting one target or combining incompatible build variants.
- Parse errors, missing third-party dependencies, cgo and import cycles refuse a
  preview. An index from the separate syntax-only semantic package is never
  accepted as proof of successful type checking.
- Refactoring Go identifiers does not rewrite reflection strings, documentation,
  external consumers or JSON names. Exported renames are reported for review.
- Methods, fields and interface contracts are checked where the snapshot actually
  uses them. Compatibility outside the snapshot is not established.

Bounds: 500 source/module files, 1 MiB per file, 8 MiB total, 200,000 AST nodes,
20,000 edits, 32 MiB worker input and 8 MiB output. Edits require the original
SHA-256 and exact old identifier bytes; changed input is rejected.
