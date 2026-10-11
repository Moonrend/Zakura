# Persistent project execution API

The engine depends only on `mission.Executor`, `mission.WorkspaceProvider`, and
SQL persistence. The runtime adapter owns model and runner credentials.

`NewStore(db *sql.DB, dialect string, rebind func(string) string) *Store` uses
the application database and migration `0006_project_execution.sql`.

Public project methods return domain values and errors:

- `CreateProject(ctx, mission.Project) (mission.Project, error)`
- `GetProject(ctx, tenant, projectID) (mission.Project, error)`
- `ListProjects(ctx, tenant, spaceID, limit) ([]mission.Project, error)`
- `UpdateProject(ctx, tenant, projectID, expectedRevision, mission.Project) (mission.Project, error)`
- `DeleteProject(ctx, tenant, projectID, expectedRevision, beforeDelete ...func(*sql.Tx) error) error`;
  hooks run under the project's transaction lock before deletion, allowing the
  merge subsystem to preserve unresolved apply records atomically.
- `CreateRun(ctx, tenant, projectID, baseSnapshot, expectedProjectRevision ...int64) (mission.Run, error)`
- `ForkRun(ctx, tenant, projectID, sourceRunID, expectedProjectRevision) (mission.Run, error)`
- `GetRun(ctx, tenant, projectID, runID) (mission.Run, error)`
- `GetRunProject(ctx, tenant, projectID, runID) (mission.Project, error)` returns the frozen definition.
- `ListRuns(ctx, tenant, projectID, limit) ([]mission.Run, error)`
- `ListTasks(ctx, tenant, projectID, runID) ([]mission.Task, error)`
- `GetTask(ctx, tenant, projectID, runID, taskID) (mission.Task, error)`
- `ListOperations`, `ListVerifications`, `ListReviews` take
  `(ctx, tenant, projectID, runID, optionalTaskID ...string)`.
- `ListEvents(ctx, tenant, projectID, runID, afterSequence, limit) ([]mission.Event, error)`;
  empty `runID` reads project-wide events.
- `GetCheckpoint(ctx, scope, runID, taskID) (mission.Checkpoint, error)`
- `RecordReview(ctx, tenant, projectID, runID, mission.Review) (mission.Review, error)`
- `ResolveOperation(ctx, tenant, projectID, runID, operationID, expectedRevision, Resolution) (mission.Operation, error)`
- `TenantDraining(ctx, tenant) (bool, error)` reads the durable deletion fence.
- `RequireTenantActive(ctx, tx *sql.Tx, tenant) error` checks that fence;
  `tx=nil` uses the store database for an early check. Publication mutations call
  this after locking their project row in the transaction. New project creation
  and tenant cancellation lock the tenant row first; transactions that already
  hold a project lock never acquire the tenant lock in reverse order.

`Resolution.Decision` is `approved|denied` for a never-started operation waiting
for approval, or `completed|failed|not_performed` for an operation whose external
effect is unknown. Every resolution requires an author and explanatory comment.
`not_performed` is an explicit attestation that the earlier operation did not
take effect; it permits another attempt with the same operation ID while the
run remains executable. A cancelled or budget-exhausted run records the known
absence of effect without restarting dispatch.

`NewEngine(store, executor, workspaces, EngineConfig) *Engine` is initialized
without starting goroutines. `Start(ctx) error` starts workers;
`Stop(ctx) error` cancels local work and awaits completion.

Engine controls delegate to transactional store transitions:

- `Pause(ctx, tenant, projectID, runID, expectedRevision) (mission.Run, error)`
- `Resume(ctx, tenant, projectID, runID, expectedRevision) (mission.Run, error)`
- `Cancel(ctx, tenant, projectID, runID, expectedRevision) (mission.Run, error)`
- `RetryTask(ctx, tenant, projectID, runID, taskID, expectedRevision) (mission.Task, error)`
- `CancelTenant(ctx, tenant) error` persists revocation before cancelling local workers.
- `ComposeTaskOutputs(ctx, tenant, projectID, runID, taskIDs) (string, error)`
  combines accepted immutable outputs against their causal common ancestors;
  it accepts execution task IDs and can be used before starting workers.

`ForkRun` freezes the current project revision into a new run. The source must
be paused or stopped and have no unresolved operations. Only completed,
verified tasks with the same goal, execution inputs, complete acceptance checks,
and unchanged transitive dependency history retain their immutable outputs.
Task title, scheduling priority, and retry policy changes preserve completed work.
New task and
session IDs, zero budgets, and fresh reviews prevent the new run from inheriting
mutable branches, old approvals, or external operation intents. Rejected reused
outputs are revised on new branches seeded from the immutable artifact. Reviews
approve dependencies before consumers. Rejecting a reused ancestor invalidates
its reused descendants; those tasks rebuild from newly accepted dependency files.

Tenant cancellation first seals execution with a persistent draining fence, then
revokes every run in the same transaction. In-flight API requests cannot create
new projects, runs, or task mutations after that fence commits. Audit reads and
human resolution of unknown effects remain available. A refused or failed tenant
deletion retains the fence and returns an error; draining is never automatically
cleared by a new execution request.

Every mutation uses expected revision or an active worker fence. A run freezes
plan/config; editing its project cannot change execution or approval policy.
Dependencies contribute their immutable snapshots through `Compose`; branches
are not constructed from dependency text alone. Fork parameters are
`(ctx, scope, composedBaseSnapshot, stableTaskID)` and must be idempotent.
Task IDs and session IDs are immutable per-run identities, distinct from plan
task IDs. The composed snapshot is persisted as `Task.BaseSnapshot` so later
recovery can validate the task's own changes without treating dependency files
as new writes. `ValidateWrites` compares the output against that exact baseline.

Model calls reserve token allowance atomically before dispatch. A lost model
response consumes its reservation conservatively; known responses settle actual
usage. `Assignment.TokenAllowance` constrains the adapter's request. Tool calls
are persisted before dispatch. A crash after tool completion but before checkpoint
advancement reuses the stored result. Ambiguous external writes wait for inspection
or human attestation; they are never automatically reissued.
