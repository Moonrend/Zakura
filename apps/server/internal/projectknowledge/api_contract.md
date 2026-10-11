# Project collaboration knowledge

The runtime registers `registerProjectKnowledge` inside the existing
`/api/project-executions/{pid}` route. Initialization creates a SQL Store; there
are no background workers, remote embeddings, or network fetches. Go JSON types
are in `packages/projectkit/knowledge/types.go`.

| Method | Path below the project | Request | Response |
| --- | --- | --- | --- |
| GET | `/knowledge` | `kind,status,tag[],runId,taskId,includeArchived,cursor,limit` | `ListResult` |
| POST | `/knowledge` | `Draft` | `Entry` |
| GET | `/knowledge/search` | `q`, filters above, `limit,snippetRunes` | `SearchResult` |
| GET | `/knowledge/{kid}` | optional exact positive `revision` | `Entry` |
| PATCH | `/knowledge/{kid}` | complete `Draft`, `expectedRevision`, optional `comment` | `Entry` |
| DELETE | `/knowledge/{kid}` | `expectedRevision,comment` | tombstoned `Entry` |
| GET | `/knowledge/{kid}/history` | `before` revision, `limit` | `{items: Revision[]}` |
| POST | `/knowledge/{kid}/state` | `expectedRevision,action,comment` | `Entry` |
| GET | `/knowledge/{kid}/comments` | optional previous comment-ID `cursor`, `limit` | `{items: Comment[],cursor}` |
| POST | `/knowledge/{kid}/comments` | `expectedRevision,body` | `Comment` |

An entry starts as `note/active`, `decision/proposed`, or `question/open`.
Human member sessions can `approve`/`reject` proposed decisions and
`resolve`/`reopen` questions. API keys and OAuth access tokens cannot perform
these actions. Editing a decision always resets its status to proposed; editing
a resolved question reopens it. The exact prior approved revision remains
readable. `archive` excludes entries from default search, `restore` restores the
unchanged state, and `delete` removes current body/index while retaining
revisions and comments. Delete is a tombstone, not a right-to-erasure operation.

`snapshot` provenance is accepted only for exact snapshot IDs present in the
same project's run bases, task bases/results, or merge result plans. A path is
clean relative metadata; this endpoint does not assert its existence or read
the runner object. `knowledge` provenance requires an exact immutable revision
in the same project. `url` provenance accepts HTTPS URLs without credentials,
and never fetches them. All source contents remain untrusted references.

Search uses BM25 (k1=1.2, b=0.75), fixed title/body/tag field weights,
case-folded Latin/digit words, CJK unigrams and adjacent bigrams. It is lexical
ranking, not semantic search. Corpus statistics are calculated for the same
filters in a repeatable-read transaction. Candidate selection above the budget
is explicitly reported with `truncated=true`. Score ties sort by entry ID.
Highlights and snippet offsets count Unicode code points, allowing a browser to
render `Array.from(text)` safely as text nodes.

Limits: 4096 query bytes, 32 distinct query terms, 2000 candidates, 100 HTTP
results, 1000 snippet code points, 65536 body bytes, 8192 distinct document terms,
32 tags/sources, and 10000 retained entries per project. Listing/history/comments
are paginated. Model search is further limited to 500 candidates and 10 results
without full bodies. Model read excerpts allow at most 8000 code points.

Bridge helpers:

```go
func (h *handler) projectKnowledgePerform(context.Context, mission.Assignment, mission.Operation) (mission.ToolResult, error)
func (h *handler) projectKnowledgeInspect(context.Context, mission.Assignment, mission.Operation) (mission.Inspection, error)
```

`project_note` is an internal workspace write: it only creates notes and uses
the engine's admitted persisted tool arguments. Under the project mutation
lock, the store verifies the running operation, task lease/fence and run status.
Document, posting index, revision, project audit event and operation receipt
commit in one transaction. Retries return the receipt; restart inspection checks
tenant/project/run/task and arguments hash. A failed receipt insert rolls back
the note. Model tools cannot approve decisions, resolve questions, change
existing documents, or inject new system instructions.

Verification: `go test -race ./knowledge` in projectkit,
`go test -race ./internal/projectknowledge` in the server, and
`TestProjectKnowledgePublicHTTPHumanReviewAndRevisionReferences` in runtime.
`TestKnowledgePostgresCASAndSearchMVCC` requires `ZAKURA_TEST_POSTGRES_DSN` and
explicitly skips without it.
