# Task source context

`Build` returns quoted source data from one immutable snapshot. It uses lexical
BM25 ranking and the existing syntax index's file imports/references. It does
not use embeddings, execute a workspace, type-check JavaScript, or establish
runtime reachability or test coverage. Source text never becomes a system
message. The result always has `mode: "lexical_graph"` and
`untrustedReference: true`.

The server constructs `snapshotId`, `writes`, `checkPaths`, and the task prompt
from the current tenant/project/run/task SQL record. The model builtin
`project_context` accepts only optional `query` and `maxBytes`. Before and after
the runner request it verifies the persisted running operation, exact arguments,
current task fence, live lease, active tenant, running run and matching actual
and frozen project space. Cancellation or lease expiry discards the read result.
Human requests use the same frozen task base, without requiring an execution
lease. Pending tasks without a frozen base return HTTP 409.

## Read API

`GET /api/project-executions/{pid}/runs/{rid}/tasks/{tid}/context`

Optional parameters: `query` (at most 1024 UTF-8 bytes) and `maxBytes` (512–16000,
default 4000). No snapshot, host path, foreign task, branch or seed override is
accepted. Tenant/project/run/task access uses the existing project route and
scoped SQL lookup. Runner RPC is `project.context.pack`; only the trusted server
constructs its snapshot and seed parameters.

The stable result includes snapshot ID, version, `bytes`, `maxBytes`, input
counts, `partial`, `truncated`, missing paths, omission counts and analysis
boundaries. Each snippet carries the exact snapshot ID, full file SHA-256,
original UTF-8 text, byte offsets and 1-based rune line/column positions.
`seed_claim`, `check_path`, `lexical_hit`, `dependency` and `referrer` reasons
include a confidence and, where applicable, a source path. A graph edge inherits
syntax, conditional, lexical or ambiguous confidence; it is not a type-check.

The `bytes` field is the length of the complete default `encoding/json`
serialization, including HTML escapes and metadata. The HTTP handler writes
those exact bytes without an extra newline. Tool output enters the existing
model context clipping and provider accounting. No actual token saving is
claimed and no fabricated provider usage is charged.

## Bounds and uncertainty

- Inventory validation stops above 20000 entries. At most 1000 files, 32 MiB
  of actual content, and 1 MiB per file are read. Each accepted file is read once
  and checked against its immutable digest; syntax analysis uses this bounded
  in-memory source. Seeded files precede the remaining sorted inventory.
- Ranking uses at most 64 distinct query terms. Input is tokenized on Unicode
  letters/digits, retaining whole identifiers and CamelCase components. BM25
  uses document frequency and document length rather than path-order matching.
- Graph expansion starts from at most 16 ranked seeds, spans two hops and at
  most 64 participating files, and examines at most 512 adjacency entries per
  hop. The syntax index additionally bounds nodes, symbols, references and
  edges. Reaching a bound produces a partial boundary.
- Output considers 24 ranked files and up to two non-overlapping spans per file
  (normally at most 1400 content bytes each). Each file gets an opportunity
  before a second span is considered. Shrinking preserves UTF-8 boundaries and
  original byte positions. JSON-budget omission lists can themselves be
  truncated; total counts include undisplayed entries.
- Binary/invalid UTF-8 files, missing seeds, conditional source, ambiguous
  modules, unresolved imports and unresolved references remain explicit.
  Generated code is flagged when the syntax index recognizes its marker.
- Runner work has a 10-second cancellable context. Repository reads use the
  repository's context-aware lock rather than the mutable project's mutex.
  CPU loops check cancellation; native parsing is limited by file/node bounds.

The web panel selects real runs and tasks, displays their frozen base and
selection evidence, and copies either complete JSON or plainly quoted source
references for another code agent.
