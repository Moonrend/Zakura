# Portfolio execution controls

The authenticated `/api/project-portfolio` endpoints operate on the current
principal's tenant. Bound agent and space credentials cannot use them. Members
can query the portfolio, adjust scheduling and control selected runs. Changing
tenant policy requires a human owner/admin session; API keys and OAuth cannot
change that policy.

- `GET /`: `PortfolioOverview`; optional `spaceId`, `limit` (1–200). Totals include
  every project selected by the filter; displayed projects are bounded by limit,
  with the most recent 25 runs per project. `truncated` identifies omitted rows.
- `GET /policy`: `PortfolioPolicy`; revision zero means no configured policy.
- `PUT /policy`: policy fields plus `expectedRevision`; returns the next policy.
  Agent-specific limits must name agents belonging to this tenant.
- `PATCH /projects/{pid}/scheduling`: `{expectedRevision,priority,weight}`;
  returns the project with a new revision. This does not alter frozen run
  definitions or their model, approval or acceptance policies.
- `POST /runs/actions`: `{action,items:[{projectId,runId,expectedRevision}]}`;
  action is pause/resume/cancel. Returns `{items:[PortfolioActionResult]}`.
  Each item commits separately; already applied controls are never rolled back.
  Duplicates, missing revisions and batches larger than 100 are rejected before
  any control is applied.

Disabled/default policies preserve the earlier task priority ordering. Enabled
policies serialize admissions under a tenant row lock, then a project row lock.
That lock order matches tenant draining. Per-project integer virtual service
increases by `1000000 / (weight * (priority + 21))` on each acquired task lease.
Weight defaults to 1, ranges 1–100, and priority ranges -20–20. A project whose
oldest eligible task and most recent dispatch both predate `agingSeconds` is
promoted ahead of ordinary virtual-service order. Dependency-blocked and
saturated runs do not hide another project's runnable work.

Fairness counts lease admissions, including recovered assignments. It does not
promise preemption or equal CPU time, token usage, response latency or physical
resource allocation. Long-running work keeps its slot until it finishes or its
lease expires. The worker pool and frozen per-run MaxConcurrent still apply.
Tenant policy MaxActiveTasks and per-agent model/tool concurrency are additional
dispatch gates; zero means uncapped by this policy. Existing admitted work is
not forcibly cancelled when a limit is lowered.

Model/tool reservations are persisted before dispatch, including while policy
is disabled, so enabling a limit sees existing dispatches. Reservations follow
the current lease fence, are released on persisted completion, and expire for
admission accounting when the task lease expires or its status/fence changes.
A lost response retains the original conservative budget charge and effect
recovery rules. Resource waits retain the worker heartbeat and react to pause
or cancellation; they do not fail a task or charge an unissued model call.

The limits bound leased dispatch admissions. An external provider may continue
processing a request after its client is cancelled or its server worker crashes;
these limits are not a provider-side physical concurrency guarantee. They do
not change the runner's Docker CPU/memory or disk policies.

Blockers are an advisory snapshot. `nextEligibleAt`, when present, is a current
lease expiry at which admission can be checked again; heartbeats may renew it
and completion can release it earlier. Usage totals come from persisted run
counters and include lost-call reservations; monetary cost is not inferred.
SQLite and PostgreSQL share the same SQL transitions. PostgreSQL concurrency
coverage is gated by `ZAKURA_TEST_POSTGRES_DSN`; absence is an explicit skip.
