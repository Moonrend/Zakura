# Durable project execution

Open **长期项目** in the dashboard to define a delivery goal, dependency tasks,
writable paths and acceptance checks. Each execution freezes its plan and budget;
editing a project cannot change a running execution's rules.

The [project workbench guide](PROJECT_WORKBENCH.md) covers versioned blueprints,
project references, portfolio scheduling, code analysis, reviewed delivery bundles,
requirements traceability and controlled Agent/model comparison campaigns.

## Runtime setup

Assign an online Zakura runtime node to the project's space. File tasks work
through the runner without a desktop. Commands and command acceptance checks
require Docker and an operator-provisioned image:

```sh
docker pull your-project-toolchain:version
export ZAKURA_PROJECT_IMAGE=your-project-toolchain:version
```

The image must already exist on the runner; commands do not pull images. Include
the project's required compilers and dependencies in that image. The `shell_exec`
tool uses Bash; command acceptance rules use the supplied argument vector.
Networking is disabled. The runner mounts only the task branch as writable,
drops capabilities, enables no-new-privileges, and keeps the container root
filesystem read-only. The container uses the runner's UID/GID so branch ownership
works without changing the original workspace's permissions.

Docker is required for commands. A missing image/backend is an execution error;
there is no host fallback. `/api/project-executions/{id}/policy` reports the
actual configured policy. The workspace size watchdog can overshoot between
checks; strict allocation limits require filesystem quotas on the runner.

## Delivery and review

1. Create tasks with stable plan IDs, assigned agents, prerequisite IDs, and
   relative writable paths. A directory claim includes descendants; `src/**`
   is also accepted. Every task needs at least one required acceptance check.
2. Validate the plan. The graph shows dependency layers, critical paths and
   conflicting write scopes. Independent tasks can run concurrently within the
   run budget; overlapping writes are serialized.
3. Start an execution from a captured original workspace. Dependencies contribute
   their immutable file outputs to each task branch. Common ancestors are used
   as merge baselines, so inherited changes do not become false conflicts.
4. Inspect checkpoints, operations and acceptance evidence. Required review gates
   block dependents until a member approves the exact accepted snapshot.
5. Compare alternative task outputs. Select accepted outputs for a merge preview.
   Conflicts require explicit resolutions and produce a new immutable preview.
6. The complete merged artifact runs the selected tasks' acceptance checks again.
   A human member approves its exact snapshot and explicitly applies it. The
   original workspace must still match the preview baseline.

File, text, regular-expression, strict JSON and RFC 6901 checks run against the
frozen snapshot. Command checks run in a disposable copy, so tests cannot change
the artifact under review. Optional failures remain visible. Evidence includes
the snapshot and frozen rule hashes; a model's success statement is insufficient.

## Recovery and replanning

Model decisions are saved before tools execute. Tool intents and results have
stable operation identities. A process restart restores the persisted cursor and
reuses completed results rather than invoking the same tool again. Worker leases
and increasing fences reject decisions returned by an obsolete worker.

An interrupted external write can have an unknown outcome. It remains blocked
until inspection or a member's explicit attestation resolves it. `not_performed`
means the member verified that the earlier effect did not occur; it is not a
generic retry button. External effects default to `deny`; `review` waits for a
member before dispatch. API keys and delegated OAuth tokens cannot approve or
attest human reviews.

Pause before editing a plan. The replanning view identifies changed tasks and
dependent outputs that need replay. Save the new project plan, then fork a
settled/paused execution. The new run retains only accepted outputs whose whole
task definition and transitive prerequisites remain unchanged. A changed project
goal invalidates reuse. New review policy requires fresh approvals, and a rejected
reused artifact retries in a new branch. Unresolved effects must be reconciled
before forking.

A source publication stores its intent before contacting the runner. If the
reply is lost, inspect the merge record instead of applying it again. A runner
proof that it rejected publication before touching the source permits a new
preview. Ambiguous publications retain their audit history and block subsequent
publication until reconciled.

Known host jobs and PTYs coordinate with publication for their registered
process-group lifetimes. The runner rejects publication while they can still
write. Independently started host processes and processes intentionally escaping
that tracking remain a trusted-host deployment boundary; stop such writers before
publishing. Original source capture also rejects a changing tree.

Source process registrations survive runner restarts. The project detail page
shows current and orphaned registrations. A tenant owner or administrator must
verify on the runtime node that **all old writers have stopped**, then confirm
the exact orphaned activity IDs with an explanatory comment. This records a
durable human attestation; it does not terminate processes. Current live jobs and
unscoped registrations cannot be cleared through a project. The kernel must prove
a tracked process group is gone, so lingering zombie groups conservatively block
publication until node-level recovery. Never treat a restart as proof of quiescence.

If confirmation loses its reply, inspect the original attestation first. A new
manual confirmation requires rereading and checking the complete current orphan
set; it retains the earlier unknown record. Inspecting that earlier record can
mark it `superseded` only when successful human confirmation receipts cover every
original activity ID. Their identities are never reused; this records resolution
of the registrations without claiming the lost RPC succeeded. API keys, delegated tokens and normal
members cannot make source writer attestations.

Tenant deletion installs a durable shutdown fence before cancelling execution.
An in-flight source capture cannot create new work afterward. Unresolved tool
effects, publications and pending source confirmations prevent deletion so their
audit records remain available
for reconciliation. If cleanup fails, the shutdown fence remains in place;
resolve the outstanding records and retry deletion. Recovery of an outstanding
source confirmation remains available to an administrator while fenced. Other
tenants keep running.

## API and build layout

The authenticated API lives under `/api/project-executions`. Project, run, task,
operation and publication mutations use expected revisions. Agent/space-bound
credentials cannot read or control tenant-wide projects. All queries bind the
tenant, project and run together. Deletion preserves unresolved effect history.

Shared code lives in `packages/projectkit`; both Go applications use a local
module replacement. Build container images from the repository root:

```sh
docker build -f docker/server/Dockerfile -t zakura-server .
docker build -f apps/server/Dockerfile -t zakura-server-only .
./apps/server/scripts/build-stdio-images.sh
```

Run `go test -race ./...` in `packages/projectkit`, `apps/agent`, and
`apps/server`. Set `ZAKURA_PROJECT_DOCKER_TEST=1` with `ZAKURA_PROJECT_IMAGE` to
run the real writable-branch Docker test. CI provisions that image explicitly.
Set `ZAKURA_TEST_POSTGRES_DSN` to run the durable store's real PostgreSQL concurrency
test; without it the test explicitly skips rather than using a substitute database.
