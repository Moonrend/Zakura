# Restricted agent execution mode

Zakura already supports long-lived Docker workspaces with container isolation, writable project files, terminals, browser tools, and ACP. This feature adds an optional, more restrictive per-command Docker execution policy and an agent tool allowlist. It does not replace the existing workspace container or claim that previous container execution lacked isolation. Ordinary host execution remains available without container isolation; host working-directory path validation alone is not a sandbox.

## Selecting the mode

For an agent-wide tool boundary, set the agent's persisted `config.executionMode` to `"sandbox"` through the existing authenticated agent configuration PATCH API, and configure the runner image below. The server rereads the tenant-scoped agent configuration on every tool invocation. It forces `shell_exec` into sandbox mode even if model arguments request host mode; only `ask_user` is otherwise permitted. Arbitrary MCP tools, filesystem tools, browser tools, code mode, delegation, and service tools are denied. The tool catalog is limited to `shell_exec` and `ask_user`; ACP startup/reuse is refused. Invalid configuration modes fail closed. Omitting the agent configuration keeps legacy host behavior.

Enable sandbox mode before starting agent runs. Changing the policy does not retroactively stop existing host jobs or ACP processes; stop those separately before relying on the new boundary.

This is separate from choosing sandbox mode on an individual shell command. Manual user filesystem/admin APIs are outside the agent tool boundary, and configured model providers still receive prompts and conversation content. Sandbox mode is not a promise that no data leaves the application.


- `shell_exec` accepts `execution_mode: "sandbox"` or `"host"`. The server checks the runner's `sandbox.policy` capability before requesting sandbox execution, so an older runner cannot silently ignore the mode.
- Agent RPC `host.exec`, `host.exec.start`, `host.exec.get`, and `host.exec.kill` accept `executionMode: "sandbox"`. Supply the same valid `spaceId` and execution mode when polling or cancelling a job.
- Setting `ZAKURA_SANDBOX_ENABLED=true` on the agent enforces sandbox mode when its handler is created. A request for host mode cannot disable operator enforcement. Without enforcement, omitted execution mode preserves host compatibility.
- Shell results distinguish `executionMode: host` (no container isolation), `workspace-container` (existing Docker workspace isolation), and `sandbox` (confirmed restricted policy). `restrictedPolicyApplied` is true only for the last mode. `isolated` records container isolation, not a claim of virtual-machine isolation or containment of the entire application. Sandbox execution adds `timedOut`, `cancelled`, and `truncated`; background jobs also report operational errors.
- `sandbox.policy` describes the configured policy, default mode, and enforcement. Image configuration is not evidence that the Docker daemon or image is usable.
- The restricted execution mode currently supports host workspaces only; it mounts that dedicated workspace into a fresh restricted container. Existing container workspaces retain their normal behavior and cannot opt into this mode yet. Unsupported workspace backends, PTY sessions, and Docker execution/management transports are refused rather than silently downgraded.

## Operator prerequisites

Use a trusted, local Linux Docker daemon with a current engine supporting `bind-recursive=disabled`. The daemon must share the agent's filesystem. The agent does not forward `DOCKER_HOST`, context overrides, credentials, proxies, or application environment to the Docker client.

Provision an approved local image in advance and set `ZAKURA_SANDBOX_IMAGE` on the agent. Pin a reviewed image digest for reproducibility. Execution uses `--pull=never`; it does not pull images. The image must include the executable and supporting files the command needs, contain no application secrets, and declare no Docker `VOLUME` paths. The runtime inspects and refuses images declaring volumes. Image-baked environment and image content are trusted operator inputs, so a clean parent environment does not sanitize a secret-bearing image.

Workspace files must be readable by UID/GID 65534. Workspace roots must use real directories; sockets, devices and FIFOs are rejected. The operator must prevent concurrent host-side mutations while execution runs. Path and file-type checks have time-of-check/time-of-use limitations; they are not an independent isolation boundary. Other agent file or management APIs remain separately authorized control-plane operations: this feature is a command-execution boundary, not a replacement for control-plane authentication and authorization.

## Fixed restrictions

| Resource | Policy |
| --- | --- |
| Network | `none`; no external network interface |
| User | UID/GID 65534, all capabilities dropped, no new privileges |
| Filesystem | Read-only image and read-only `/workspace` bind; nested mounts excluded |
| Writable scratch | Ephemeral `/tmp`, 64 MiB, noexec/nosuid/nodev |
| Memory / swap | 512 MiB memory, no additional swap |
| CPU / processes | 1 CPU, 64 PIDs |
| Open files / core | 256 open files; core dumps disabled |
| Execution timeout | Default and maximum 300,000 ms |
| Captured output | 256 KiB per stdout/stderr stream, then discarded with truncation flag |
| Input | 64 KiB stdin, 64 KiB combined command strings, 256 command arguments |
| Concurrency | 4 active executions; 128 retained/background job records with completed-result eviction |
| Environment | No caller-supplied environment; fixed HOME/TMPDIR/PATH |

Read-only workspace means build/install workflows must use `/tmp` and cannot persist output back into the project through this API. Runtime resource flags depend on actual Docker/kernel enforcement; argument-policy unit tests alone do not establish enforcement.

## Failure and lifecycle behavior

The server uses workspace-scoped background start/get/kill RPCs for sandbox commands. Cancelling an agent run sends a scoped kill and waits up to fifteen seconds for a terminal acknowledgment. Cleanup or terminal execution errors are surfaced, and an unconfirmed cancellation is reported as uncertain rather than successful.

Starting a job uses a separate ten-second deadline so that an agent-run cancellation does not immediately discard the job identity needed for cleanup. If the start response is lost or cannot be confirmed, the server does not retry: the outcome is unknown, and any started job remains bounded by its hard execution timeout. Operator follow-up may still be needed when connectivity or daemon failures prevent cleanup confirmation.

Missing configuration, unavailable Docker, image inspection failure, invalid inputs, unsupported isolation options, or container creation failures return errors without executing the command on the host. Container creation and execution are separate. Cancellation during creation may leave a stopped container and reports that uncertainty; it must not start an untracked command.

Timeouts and cancellation terminate the client, then force-remove the named container using a separate bounded cleanup context. If removal fails, the runtime checks container absence. An inability to verify cleanup is returned as an operational error requiring operator attention. This is best-effort cleanup under daemon failures, not a guarantee against daemon outages. Do not treat a cancelled job as fully cleaned up when its error reports otherwise.

## Validation

From `apps/agent`:

```sh
go test -race ./...
go vet ./...
```

`validation_test.go` covers restrictive Docker arguments, request bounds, missing-backend refusal, output bounds under concurrent access, workspace mapping, job quotas, workspace-scoped access, clean Docker client environment, and synthetic timeout/cancellation. The synthetic Docker fixture only tests client orchestration; it does not launch containers or prove OS isolation. RPC tests cover policy enforcement, unsupported transports, missing workspace identity, and fail-closed configuration.

A separate integration test uses a **real Docker daemon** and benign commands. On a dedicated Docker-capable test host, pre-pull an approved Alpine-compatible image, set its pinned reference, and run:

```sh
ZAKURA_SANDBOX_INTEGRATION=1 ZAKURA_SANDBOX_IMAGE='<approved-local-image@sha256:digest>' \
  go test ./internal/sandbox -run '^TestSandboxRealDockerIntegration$' -count=1 -v
```

The image needs `sh`, `cat`, `id`, `pwd`, `touch`, `ls`, `head`, and `sleep`. The test checks workspace readability, non-root user, denied workspace writes, ephemeral scratch, clean parent environment, loopback-only networking, capped output, timeout/cancellation and absence of newly remaining sandbox containers. Run without concurrent sandbox workloads so cleanup assertions are meaningful. Opt-in with missing Docker/image fails rather than skips. Without opt-in it explicitly skips.

The development executor had no Docker CLI or daemon access, so real Docker isolation was **not locally verified**. The dedicated CI integration stage must pass on the exact change before claiming real-backend validation. These tests are defensive behavior checks; they do not constitute a sandbox-escape assessment or production certification.

## Server tool boundary and deadline validation

The server's `shell_exec` invokes `bash -lc`; the configured production image must include **bash**, not only `sh`. The CI image explicitly installs bash before exercising the complete server -> WebSocket runner -> Docker path. This integration uses benign fixture output and sleep commands, and is separate from direct backend tests.

Restricted output uses an in-memory bounded preview only, including when runner policy enforces sandboxing for a legacy request. The server does not spill that output through host filesystem RPCs. The structured `truncated` flag combines the runner byte cap and the server 24,000-byte preview threshold. Ordinary host/container workspace spillover behavior is unchanged.

Command execution timeout is passed separately from the RPC observation budget (up to 30 seconds of transport/cleanup grace). Caller cancellation is still acted upon immediately. Cleanup has an independent 15-second confirmation budget, covering the runner's 10-second cleanup and process wait. Bounded final stdout/stderr and timeout/cancellation flags are preserved only after verified terminal cleanup; unconfirmed cleanup remains an error.

The opt-in `ZAKURA_SERVER_SANDBOX_INTEGRATION=1` test requires `ZAKURA_SANDBOX_AGENT_BINARY` pointing to a built runner and `ZAKURA_SANDBOX_IMAGE` pointing to the bash-capable image. It checks long stdout/stderr without host writes, final output after timeout, caller cancellation, and operator-enforced sandbox output. Missing prerequisites fail rather than skip when opted in.

Internal ACP, cloud, provider and admin-default configuration saves now apply field-scoped compare-and-swap mutations to current JSON, retrying a bounded number of times on concurrent changes. They do not restore an unchanged `executionMode` from an old snapshot. The public full-config replacement API remains deliberate replacement, including intentional policy changes; callers using that API must not submit an unrelated stale whole-object snapshot. Regression tests cover SQLite and an opt-in disposable PostgreSQL service.

RPC write queue acquisition and socket writes are also deadline-bound; an interrupted partial WebSocket frame closes that connection rather than being reused. A failed transport can still make cleanup unconfirmable, which remains an explicit error rather than a containment guarantee.

Runner RPC responses are reassembled from bounded WebSocket fragments before JSON decoding. Real client libraries can fragment ordinary long stdout/stderr responses; the server preserves those responses and handles interleaved control frames rather than silently losing them. The combined message remains limited to 16 MiB.
