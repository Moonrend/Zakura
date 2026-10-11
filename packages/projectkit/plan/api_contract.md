# Project planner contract

This package owns immutable validation and analysis; it never invokes models,
commands, filesystems or the network. It depends on `mission` and the sibling acceptance schema validator.

Stable integration entry points:

- `ValidatePlan(plan mission.Plan, config mission.Config) error`
- `Analyze(plan mission.Plan, config mission.Config) (Analysis, error)`
- `ScheduleCandidates(plan mission.Plan, tasks []mission.Task, config mission.Config, options ScheduleOptions) (ScheduleResult, error)`
- `Compare(base, candidate mission.Plan, config mission.Config, options CompareOptions) (Comparison, error)`
- `Replan(base, candidate mission.Plan, tasks []mission.Task, config mission.Config) (ReplanResult, error)`
- `PathsOverlap(a, b string) (bool, error)`
- `ExecutionEquivalent(a, b mission.TaskSpec) bool`
- `AcceptanceEquivalent(a, b []mission.CheckSpec) bool`

`ValidationError` contains structured `Issue` entries with code/task/check/field
locations. Analyses are deterministic; schedules are deterministic for frozen runtime state and an explicit `Now`. Writes are relative,
canonical workspace paths; directory claims include their descendants.
Scheduling never silently starts tasks whose prerequisites have failed or have
not passed acceptance. Active task writes exclude overlapping candidates.

The initial resource estimator uses explicit ScheduleOptions.Estimates rather
than invented model cost. Unknown estimates are surfaced, never advertised as
accurate token/time predictions. Comparison explains uncertainty.

# Acceptance contract

The sibling `acceptance` package owns CheckSpec validation and evaluation:

- `ValidateChecks([]mission.CheckSpec) error`
- `Evaluate(ctx context.Context, checks []mission.CheckSpec, environment Environment, options Options) (Report, error)`
- `VerifyEvidence(report Report, snapshotID string) error`
- `ValidateVerification(specs []mission.CheckSpec, v mission.Verification) error`
- `VerificationPassed(specs []mission.CheckSpec, v mission.Verification) (bool, error)`

Environment binds an opaque immutable SnapshotID, `Files FileSystem`, and an
optional runner-owned `Commands CommandExecutor`. File access uses relative
canonical paths; implementations must reject escapes/symlinks and read the bound
snapshot, not the current mutable branch. Command execution is never implemented
in the server: the runner must disable networking and attest that isolation in
the CommandResult. Failure to attest isolation fails a command check.

Checks: path_exists, path_absent, text_contains, text_excludes, regex, json_valid,
json_pointer, command. json_pointer Pattern is an RFC 6901 pointer, optionally
followed by `=JSON` for an exact typed value comparison. An unambiguous object
form `{ "pointer": "/key=with=equals", "equals": 3 }` handles equals in key names. Network-free commands
receive argv, deadline, working directory '.', and bounded stdout/stderr size.
All results include snapshot-bound hash evidence. Missing files cannot satisfy
negative text checks. Truncation cannot turn text/JSON matching into success.
Optional failed checks remain failed but do not make the whole report failed;
required checks do. With no required checks the aggregate is `unverified`, never
`passed`. Every task requires a required acceptance condition. Invalid specifications
always fail validation. Evidence hashes verify integrity; authenticity comes from the
authenticated runner channel and immutable snapshot store.
