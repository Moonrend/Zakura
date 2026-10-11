# Project runner RPC contract

All methods accept `spaceId` and `projectId` (1–128 ASCII letters, digits, `_`, `-`; first character alphanumeric). The runner derives all storage paths. No root, image, network, bind mount, user, host environment, or Docker flags are accepted. Unknown JSON fields are rejected.

Mutation methods require `operationId` using the same opaque identifier grammar. The durable journal records canonical method + complete parameters before side effects. Reusing an operation ID with different arguments is an error. Completed/failed operations return their saved outcome. An interrupted operation has `unknown` status and is never blindly repeated. Journal records are scoped by both space and project.

| Method | Extra request fields | Result |
| --- | --- | --- |
| `project.base` | `operationId` | `{snapshotId}` from the current source workspace |
| `project.snapshot` | `snapshotId` | shared workspace snapshot metadata |
| `project.snapshot.read` | `snapshotId`, `path`, optional `maxBytes` | `{snapshotId,path,content,base64,size,revision}` from immutable CAS content |
| `project.compose` | `operationId`, `baseSnapshot`, `snapshots: string[]` | `{snapshotId}` |
| `project.branch.create` | `operationId`, `snapshotId`, optional `branchId` | `{branchId, snapshotId}` |
| `project.branch.read` | `branchId`, `path`, optional `maxBytes` | `{path, content, base64, size}` |
| `project.branch.list` | `branchId`, optional `path` | `{path, entries: [{name,path,isDir,size,mode,revision}]}` |
| `project.branch.write` | `operationId`, `branchId`, `path`, `content` or `base64`, optional `expectedRevision` | `{path, revision}` |
| `project.branch.remove` | `operationId`, `branchId`, `path`, optional `recursive` | `{ok}` |
| `project.branch.rename` | `operationId`, `branchId`, `oldPath`, `newPath` | `{ok}` |
| `project.branch.patch` | `operationId`, `branchId`, `path`, `expectedRevision`, `oldText`, `newText`, optional `all` | `{path, revision}` |
| `project.branch.capture` | `operationId`, `branchId` | `{snapshotId}` |
| `project.branch.diff` | `baseSnapshot`, `snapshotId` | shared workspace diff |
| `project.merge.plan` | `operationId`, `baseSnapshot`, `snapshotId` | shared merge plan with opaque `planId` |
| `project.merge.resolve` | `operationId`, `planId`, `resolutions: workspace.Resolution[]` | `{planId, expectedBase, plan, originalPlanId}` with immutable resolved target |
| `project.merge.apply` | `operationId`, `planId`, `expectedBase`, `reviewId`, `reviewSnapshot`, `approved: true` | shared apply result |
| `project.verify` | `operationId`, `branchId`, `checks: mission.CheckSpec[]` | `mission.Verification` |
| `project.exec` | `operationId`, `branchId`, `command: string[]`, optional `workingDir`, `timeoutMs`, `stdin` | `{exitCode, stdout, stderr, timedOut, cancelled, truncated}` |
| `project.operation.inspect` | `operationId` | `{known, status, effectState?, result?, error?}`; absent → `known:false`; interrupted → `status:unknown` |
| `project.branch.gc` | `operationId`, `branchIds: string[]` | `{removed: string[]}` |
| `project.branches` | none | `{branches}` |
| `project.policy` | none | bounded project execution isolation policy |
| `project.source.activities` | none | `{activities:[{id,spaceId,status,runtimeLive,startedAt,updatedAt}]}` for current space and unscoped active source records |
| `project.source.confirm` | `operationId`, `activityIds`, `reviewId`, `approved:true`, optional `comment` | `{confirmed,reviewId}` after an explicit authorized operator attestation |

`expectedRevision` is the full SHA-256 of prior bytes (`missing` for a missing file). Empty content is supported. Base64 and content are mutually exclusive. Paths are relative POSIX workspace paths; `/workspace/` is accepted solely as a container prefix, never an arbitrary absolute host path. Symlinks and special files are rejected. File tools are serialized with commands on the same project.

`project.exec` uses a new restricted Docker execution implementation with exactly one writable runner-derived branch bind mount. Source workspace is never mounted. Default network is `none`, root filesystem is read-only, Docker client credentials and host environment are stripped, all capabilities are dropped, no-new-privileges is enabled, limits apply to memory, CPUs, processes, file descriptors, stdin, output, and timeout. Image is operator configured only. Docker absence is an explicit error; host execution is never a fallback. Command failure remains a command result with a real nonzero exit code; backend/cleanup failures are RPC errors persisted in the operation journal.

Source workspace capture and merge application take the same space lock as legacy `host.fs.*` RPCs. Apply requires a fresh expected base plus an explicit approved human review ID provided by the authenticated control plane; the control plane must authorize that review against this project's exact run and snapshot. Runner trusts the authenticated control plane's authorization, never a model tool argument.

Merge apply accepts no content or resolutions. `reviewSnapshot` must exactly equal the immutable merge plan result snapshot. Resolve produces a new plan, which must be reviewed separately before apply.

Project disk usage has preflight, a 100 ms cancellation watchdog, and postflight bounds (512 MiB, 100,000 entries, 8 MiB per file); watchdog can overshoot between scans. Deploy on a filesystem with project quotas for strict disk allocation protection. The runner never presents this watchdog as a kernel quota.

For `project.merge.apply`, a proved rejection before publication (invalid review binding, unresolved plan, expected-base mismatch, or full source snapshot mismatch under its space lock) persists `effectState:"not_performed"`. A failed RPC is never generally interpreted as no effect; Docker cleanup errors, apply journal failures, and interrupted operations remain ambiguous. The control plane may abandon and regenerate a preview only from this explicit proof.

Source coordination additionally registers legacy host.exec, host.exec.start and host.pty.start before launch. Source capture, merge preview, recovery and publication atomically suspend new launches and reject known active processes, with publication rejection attested as not_performed. POSIX host exec jobs get separate process groups; lifecycle completion waits for ordinary descendants, and explicit job cancellation/timeouts target that group. PTY sessions already create an independent group. The kernel must report no remaining process-group members before protection is released; persistent zombie groups remain conservatively active and require operator recovery after restart. host.exec.get may report foreground running:false with sourceActive:true while descendants still write. Arbitrary trusted commands that call setsid, unmanaged host daemons, and out-of-band writers are operator managed and must be quiesced for source publication; CAS alone cannot protect writers holding old file descriptors. Non-POSIX coordination covers the foreground process only.

Before each legacy host launch, a durable source-process intent is written outside the workspace. Reaping the tracked process group persists settled before releasing publication protection. An agent restart retains outstanding active intents and blocks source publication. The operator must quiesce the corresponding host processes and attest the exact orphaned activity set through the human recovery API; there is no model-accessible override. Failure to persist a settled record stays conservative and requires operator recovery. This is separate from the project execution operation journal.

Source recovery is reviewable through source.activities and source.confirm. runtimeLive means currently registered by this handler, not proof that an orphaned process is dead. Confirm requires the exact complete current orphaned activity ID set for this space, refuses any current registration in the space, and refuses all unscoped/global active records. It persists human_attestation plus the review ID/comment before clearing each activity. The authenticated control plane must restrict confirmation to the human space owner/admin, disallow OAuth/API/model-tool access, require an explicit writers_stopped assertion, and audit the approval. An unscoped activity can only be recovered through runner node administration; no project-scoped bypass is provided. A single agent process owns each StorageRoot.
