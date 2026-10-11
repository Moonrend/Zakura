# Immutable artifact semantics

`Build(ctx, Source, snapshotID, Limits)` reads advertised snapshot entries only.
`Index.Summary`, `Search`, `File`, `Navigate` and `Compare` return stable JSON
structures defined in `types.go`. Positions use UTF-8 byte offsets and 1-based
Unicode-rune columns, not JavaScript UTF-16 columns.

Go analysis is AST based. Package declarations, methods, fields, local variables,
imports, calls and identifier uses are indexed. AST object links and conservative
local package lookup resolve navigation; selectors without sufficient type
information stay unresolved. Generic parameter names are normalized for function
API comparison, while receiver shape, argument types and result types remain
significant. Build constraints are visible and conditional declarations retain
explicit confidence. Ambiguous declarations are not converted into certain
compatibility claims.

JS/TS analysis is lexical and always partial. Strings, comments and regular
expression contents do not produce declarations. Static module paths and exports
provide evidence; dynamic paths, template expressions and computed surfaces are
not type-checked. Source diagnostics and incomplete analysis are returned to the
client. There is no compiler, shell execution or dependency download.

Dependency edges distinguish imports, same-package compilation and references.
Import cycles exclude Go same-package edges. Comparisons classify changes as
breaking, additive, review or unknown, traverse reverse dependencies with a
concrete explanation path, and suggest tests that actually exist in the snapshot.
Related tests are candidates, not coverage measurements. Identical content is a
rename candidate only for a unique old/new match; duplicate matches are ambiguous.

The runner cache is bounded to 16 indexes and 64 MiB and uses repository scope,
full immutable snapshot ID and index version. Every cache hit first verifies the
snapshot still exists. Mutable branch heads are never cache keys. File and
comparison outputs expose truncation and full counts; the reply itself is
bounded to 8 MiB. Source, AST/token, symbol, reference, graph and diagnostic budgets
are enforced independently. Missing data cannot be treated as API removal.

RPC family: `project.semantic.index/search/file/symbol/compare`.
HTTP prefix: `/project-executions/{pid}/snapshots/{snapshot}/semantic`.
Task comparison additionally verifies tenant, project, run and task ownership at
`/runs/{rid}/semantic/compare?leftTask=...&rightTask=...` before selecting snapshots.
