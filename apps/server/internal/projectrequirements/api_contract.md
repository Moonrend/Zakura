# Signed requirements and acceptance traceability

`registerProjectRequirements` mounts inside the existing project `{pid}` route.
The handler initializes `projectRequirements *projectrequirements.Store`.

| Method | Project path | Body/query | Response |
| --- | --- | --- | --- |
| GET | `/requirements` | cursor, limit, includeRetired | `{items,nextCursor?}` |
| POST | `/requirements` | `Draft` | `Baseline` |
| GET | `/requirements/{qid}` | optional exact revision | `Baseline` |
| PATCH | `/requirements/{qid}` | complete Draft, expectedRevision, comment | `Baseline` |
| POST | `/requirements/{qid}/review` | expectedRevision, expectedProjectRevision, decision approved/rejected, comment | `Baseline` |
| POST | `/requirements/{qid}/archive` | expectedRevision, comment | `Baseline` |
| DELETE | `/requirements/{qid}` | expectedRevision, comment | retained tombstone |
| GET | `/requirements/{qid}/history` | before revision, limit | `{items: Revision[]}` |
| GET | `/requirements/{qid}/analysis` | none | current-project mapping `Analysis` |
| POST | `/requirements/{qid}/bind` | expectedRevision, runId | `RunBinding` |
| GET | `/requirements/runs/{rid}` | none | `{binding: RunBinding|null,coverage: Coverage}` |

Go JSON models are in `packages/projectkit/requirements/types.go`; the frontend
API client is `apps/web/src/lib/project-requirements.ts`. The panel supports
`{project: Project,initialId?: string}` for review inbox deep links.

Each requirement has an ID, functional/nonfunctional/constraint kind, title,
description, required flag, and explicit `[{taskSpecId,checkId}]` mappings.
Mappings apply to exact task definitions, not check IDs from unrelated tasks.
An orphaned required requirement or missing task/check prevents approval.
Optional mappings remain visible as warnings. A mapped optional task check must
still actually pass if its requirement is mandatory.

Only authenticated human member sessions may sign a baseline. API keys and
OAuth access tokens cannot review it. Review locks the project, checks both
baseline and project revisions, and freezes task execution/check semantics.
Every edit removes current approval. Old signed revisions remain immutable.
Retiring a baseline does not rewrite existing run bindings.

Run binding is explicit and permanent: one run has at most one signed baseline.
The baseline's immutable contents/revision/hash and frozen plan hash are stored
in the sidecar transaction. A later baseline edit cannot silently change the
criteria for a running or historical run. Baseline plan semantics must match the
run's frozen plan. No binding preserves the existing publication behavior.
First binding is rejected after that run has an applying, unresolved or applied
merge, or a preparing, unresolved, ready or revoked outbound delivery. This
prevents adding mandatory criteria after a publication intent has already
committed. An identical existing binding stays idempotent after publication.
Rejected reviews retain an editable draft with a new immutable `rejected`
history action; they do not introduce an additional baseline status.

Coverage distinguishes `missing`, `pending`, `failed`, `review_unapproved`,
`changed_plan`, and `passed`. Check existence is never counted as success.
Evidence requires the actual mapped task in the same run, current immutable
task snapshot, a complete acceptance proof matching frozen check semantics, and
the exact mapped check's passed result. If the frozen run requires human task
reviews, only the latest local SQL review ordered by durable project audit
sequence counts. Imported delivery manifest reviews do not qualify.

Publication hooks:

```go
func (h *handler) requireProjectRequirementsTx(ctx context.Context,tx *sql.Tx,scope mission.Scope,runID string) error
func (h *handler) requireProjectRequirementsArtifactTx(ctx context.Context,tx *sql.Tx,scope mission.Scope,runID string,taskSnapshots map[string]string,verifications []mission.Verification,finalSnapshotID string) error
```

The caller already holds the project's mutation lock. Merge approval, merge
application and delivery creation use the stronger artifact gate in that same
transaction. In addition to run coverage, every mandatory mapped task must be
included in the publication selection and its mapped check must pass a valid
proof on the final composed snapshot. Publishing an unrelated task subset
cannot satisfy the baseline, even when the rest of the run passed earlier.
The final artifact still needs the existing explicit human merge review.

Limits are 500 clauses, 100 mappings per clause, 5000 mappings per baseline,
256KiB total requirement text, and 500 retained baselines per project. Drafts,
histories and lists are bounded/paginated. Mutation transactions obey the
existing durable tenant shutdown fence. Every mutation and binding adds a
project audit event, and there are no direct tenant foreign keys that invert
the project mutation lock order.

Validation includes package/Store race tests for stale or forged evidence,
unrelated/foreign task and review records, stale plan/revision rejection,
immutable baseline bindings, subset publication denial, final snapshot check
failure, and real public HTTP human approval/tenant authorization. UI rendering
uses text nodes and encoded evidence deep links. This is structured traceability:
humans must still decide whether a proposed check meaningfully proves the
written requirement; the system does not infer that semantic relationship.
