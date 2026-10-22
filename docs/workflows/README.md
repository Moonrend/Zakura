# Workflow preflight and scheduling laboratory

Zakura's workflow laboratory is a planning tool for multi-step agent work. It
checks dependencies and capacity assumptions before anyone runs a workflow.
The planner never starts an agent, executes a tool, reads another tenant's
resources, calls a model, or provisions a computer.

Open **工作流预检** in the dashboard sidebar, or visit
`/dashboard/workflows`. The page and its API require the existing Zakura login.

## Using the laboratory

1. Choose a research, code-review, or release template, or start with one node.
2. Edit node names, durations, per-attempt costs, attempts, and dependencies.
3. Use the advanced JSON editor for resource capacities, concurrency groups,
   timeouts, identifiers, and backoff settings. Apply the JSON before planning.
4. Select **仅检查定义** for diagnostics, **生成计划** for one scenario, or
   **对比正常 / 重试场景** for side-by-side estimates.
5. Inspect the dependency graph, timeline, critical path, waiting time, cost,
   capacity peaks, utilization, budget warnings, and deadline warnings.
6. Export the definition or result as JSON. Import a definition to reproduce it.

Definitions are held in the current page only. They are not automatically
persisted to the server or browser storage. Export before navigating away if
you want to retain a draft. Exported files contain exactly the supplied workflow
and its planning assumptions; do not put credentials in node names.

## API

All routes are registered under the runtime's existing authentication and API
scope middleware. There are no public workflow routes.

| Method | Route | Result |
| --- | --- | --- |
| GET | `/api/workflows/meta` | Version, limits, modes, priorities, and `executionEnabled: false` |
| GET | `/api/workflows/templates` | Freshly allocated sample definitions |
| POST | `/api/workflows/validate` | Structural and capacity diagnostics |
| POST | `/api/workflows/plan` | Validation, graph analysis, and a resource schedule |

POST bodies have the shape `{ "definition": ..., "options": ... }`.
Unknown JSON fields, fractional integers, integer overflow, trailing JSON
values, and bodies larger than 2 MiB are rejected with HTTP 400.
`validate` returns HTTP 200 with `valid: false` for an invalid graph. `plan`
returns HTTP 422 with validation diagnostics and no analysis or schedule.
Budget and deadline warnings do not invalidate a structurally valid plan.
Responses have `Cache-Control: no-store`.

### Definition fields

| Field | Meaning |
| --- | --- |
| `version` | Must be integer `1` |
| `name` | Nonblank UTF-8 name, at most 256 bytes |
| `nodes` | Between 1 and 128 nodes, at most 2048 dependency edges |

### Node fields

| Field | Meaning / default |
| --- | --- |
| `id` | Unique ASCII identifier, matching `[A-Za-z][A-Za-z0-9_.-]{0,63}` |
| `name` | Optional display name, at most 256 UTF-8 bytes |
| `kind` | `agent`, `tool`, or `checkpoint`; default `agent` |
| `dependsOn` | Unique IDs of nodes that must finish before this node starts |
| `durationMs` | Estimated successful-attempt duration, integer 1–86,400,000 |
| `timeoutMs` | Failed-attempt timeout; 0 defaults to `durationMs`; nonzero value must be at least `durationMs` |
| `maxAttempts` | Total attempts, 1–10; omitted or 0 defaults to 1 |
| `backoffMs` | Initial retry delay, 0–86,400,000 |
| `backoffMultiplier` | Integer multiplier, 1–4; omitted or 0 defaults to 2 |
| `maxBackoffMs` | Cap for each retry delay; omitted or 0 defaults to 86,400,000 |
| `costMicros` | Per-attempt cost in micro-units of a consistent currency, 0–1,000,000,000,000 |
| `resources` | Resource name → required integer units |
| `concurrencyKey` | Optional group whose capacity is supplied in `concurrencyLimits` |

Node kinds describe the planned work; they do not enable execution. Resource
names are arbitrary identifiers such as `model`, `runner`, `cpu`, or `gpu`.
Every requested resource must have an explicit capacity. Each node's request
must fit by itself, or validation reports `unschedulable_resource`.

### Option fields

| Field | Meaning / default |
| --- | --- |
| `maxParallel` | Maximum simultaneously active nodes, 1–128; omitted or 0 defaults to 4 |
| `resources` | Resource capacities, 1–1,000,000 units each; at most 32 keys |
| `concurrencyLimits` | Maximum simultaneous nodes per group, 1–1,000,000; at most 32 keys |
| `mode` | `nominal` or `retryBound`; default `nominal` |
| `priority` | `criticalPath` or `id`; default `criticalPath` |
| `budgetMicros` | Warning threshold; 0 means no budget; maximum 1,000,000,000,000,000 |
| `deadlineMs` | Warning threshold from workflow start; 0 means no deadline; same maximum |

The planner works with integer milliseconds and integer currency micro-units.
One million micro-units equals one unit of whichever currency the caller uses.
No exchange rate conversion or provider pricing lookup is performed.

## Analysis and scheduling semantics

### Graph validation

Node and dependency identifiers must be unique. Self-dependencies, undefined
parents, cycles, invalid capacities, and impossible resource requirements are
errors. Strongly connected components identify actual cycle members; acyclic
children blocked by a cycle are not incorrectly labeled as cycle members.

The topological order is breadth-first by dependency layer, with lexical IDs
within each layer. Array and map ordering in a valid input do not affect the
output. The canonical fingerprint is SHA-256 over the normalized definition
and options, including explicit defaults and sorted nodes and dependencies.
Changing a duration, resource assumption, or display name changes the hash.
The hash is a reproducibility identifier, not an authorization token.

### Timing

In `nominal` mode, every node succeeds on its first attempt. Duration and cost
are its `durationMs` and `costMicros`. If any node permits retries, the response
warns that retries are excluded from this scenario.

In `retryBound` mode, earlier attempts consume the full supplied timeout and
the final attempt succeeds at its estimated duration. With `A` attempts,
success duration `D`, failed duration `T`, initial backoff `B`, multiplier `M`,
and per-delay cap `C`:

```text
node time = D + (A - 1) × T + sum(min(B × M^i, C), i = 0 ... A - 2)
node cost = A × costMicros
```

If no timeout is supplied, `T = D`. The default delay cap is one day. Resources
and concurrency-group slots remain occupied during all attempts and backoff.
This deliberately models a conservative allocation scenario. It is not a
promise that retries succeed or a measurement of real provider latency.

Earliest starts and finishes ignore capacity contention and follow dependency
constraints. Latest starts and slack use the longest dependency path as the
common project finish. Nodes with zero slack are critical. One longest path
is returned with lexical ties; multiple zero-slack paths may exist.

### Resource scheduling

The scheduler is deterministic, non-preemptive list scheduling. Among ready
nodes it prioritizes the longest remaining dependency tail, then lexical ID,
or lexical ID alone when `priority` is `id`. It starts every ready node that
fits available parallelism, resources, and concurrency-group capacity. A
higher-priority node that does not fit does not prevent a smaller ready node
from using remaining resources.

All completions at the same instant release resources together before new
nodes start. Occupancy intervals are half-open `[startMs, endMs)`. `waitMs`
measures capacity waiting after all parents have finished; it excludes time
spent waiting on unfinished parents.

The scheduler is a heuristic for a resource-constrained project scheduling
problem. Its result is not generally guaranteed to minimize makespan. The
response sets `optimal: true` only if completion equals a valid theoretical
lower bound: the maximum of dependency critical path, total work divided by
parallelism, and resource-weighted work divided by capacity. `false` means
optimality is unproven, not that the schedule is necessarily suboptimal.

`utilization` is total active-node time divided by `makespanMs × maxParallel`.
It includes modeled retries and backoff in the retry scenario. Resource usage
snapshots are taken immediately after starts at each event and include a final
zero-occupancy snapshot. `peakResources` records only resources actually used.

Budgets and deadlines produce warnings, not runtime enforcement. Human
checkpoints need an explicit time estimate and are treated like other nodes.
Network jitter, provider queues, unknown failures, conditional branches,
streaming, cached work, and real execution are outside this planning model.

## Bounds and arithmetic

Definitions are bounded before graph traversal. Retry delays are capped, and
all server arithmetic fits signed 64-bit integers at the largest valid input.
All public integer results remain below JavaScript's exact-integer limit.
Per-resource work is computed in integer unit-milliseconds before division.
A canceled request stops before planning or at the next scheduling event.
There is no mutable package-level planner state; concurrent calls can share an
unchanged request safely. Callers must not mutate it during a call.

## Verification

From the repository root:

```bash
python3 scripts/generate-workflow-corpus.py --check
(cd apps/server && go test ./...)
(cd apps/server && go test -race ./internal/workflow ./internal/runtime)
(cd apps/server && go vet ./...)
pnpm --filter @zakura/shared build
pnpm --filter @zakura/shared test
pnpm --filter @zakura/web typecheck
```

Optional fuzzing and benchmarking:

```bash
(cd apps/server && go test ./internal/workflow -run '^$' -fuzz FuzzWorkflowPlan -fuzztime 10s)
(cd apps/server && go test ./internal/workflow -run '^$' -bench BenchmarkPlan128 -benchmem)
```

The corpus consists of 128 exact expected-result cases generated by an
independent Python reference implementation: eight graph families × two
retry modes × two priorities × four capacity configurations. Python analysis
enumerates paths instead of using the Go forward/backward passes. Its scheduler
recomputes ready sets and occupancy from interval records instead of using the
Go dependency and capacity counters. The generator never calls the Go planner.

The checked-in files record actual inputs, node timing, dependency layers,
costs, resource lower bounds, complete schedules, and feasibility flags. They
are formatted regression data, not handwritten application source. This keeps
large diffs reviewable: review the generator and algorithms first, then run
`--check` and the golden tests to reproduce every fixture byte.

Additional tests cover malformed HTTP input, unauthenticated access, tenant
independence, body limits, cycles, missing resources, integer bounds, retry
caps, cancellation, concurrent determinism, input permutation, immutability,
1000 seeded random schedule-invariant cases, and TypeScript import safety.
The fuzz target exercises arbitrary decoded requests and validates all
successful schedules against independently reconstructed occupancy intervals.
