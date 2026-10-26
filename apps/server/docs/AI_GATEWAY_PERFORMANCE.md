# AI gateway performance integration — 2026-10-26

PR #22 is integrated with upstream `0d74e46b741eef70ff9310532e119ccb7481a74e`.
The original PR head was `ecac8a3e9ea3481907677e6727694eb87d1ab641`.
This is a merge into the existing fork branch, not a merge into upstream main.

## Conflicts and semantic integration

| Conflicting file | Upstream changes | Resolution |
|---|---|---|
| `internal/runtime/gateway.go` | New protocol bridge, encrypted config loader, context cache/route affinity, structured provider errors, buffered commit barrier | Keep upstream behavior; reconnect native JSON fast path, 256/64 idle connection pool, cancellation-aware retries, exact first-event bound and prefetched-byte replay. Preserve first-event error detection. |
| `internal/runtime/gateway_stream.go` (add/add) | File now owns SSE dialect decoder/encoder | Keep decoder/encoder; move original transport helpers into `gateway_transport.go`. Reset translated-stream size accounting per event rather than per connection. |
| `internal/runtime/http.go` | Space authorization/scopes, model mapping/defaults, session capture, client headers and keepalive writer | Keep upstream request decoding and recording; add partial-SSE abort tracking underneath keepalive with atomic state. Propagate `http.ErrAbortHandler` through recovery middleware. |

The batch route lookup merged without textual conflicts. Tests retain tenant
isolation, live status changes, shared upstream deduplication, weighted selection
and the >500-upstream subquery path. No configuration cache is added.

Native JSON bypass applies only when no dialect conversion or route defaults
require decoding. Anthropic thinking sanitization, default tokens and cache
breakpoints use the upstream converter. Integers keep `json.Number` precision.
The HTTP handler intentionally retains its upstream decode/remarshal because
model mapping and session recording now need decoded input.

Retryable responses are closed immediately before retrying. Final failover error
bodies are read up to 1 MiB with a 100 ms wait limit (also interrupted by context
cancellation), preserving ordinary structured errors and Retry-After. Slow error
bodies can lose diagnostic detail; unread bodies can forfeit HTTP/1 reuse.
Successful SSE passthrough uses a pooled 32 KiB buffer and flushes every read.
There is no connection-lifetime 64 MiB cutoff; translated events remain bounded
individually and the first commit event remains bounded at 64 KiB.

## Current measurements

Linux amd64, Go 1.26.9, AMD EPYC 9V74, `GOMAXPROCS=8`. Medians of three
runs per version on this host. Baseline and integrated runs were executed
sequentially, after tests; they are local microbenchmarks, not provider inference
or end-to-end latency measurements. The same benchmark source and test fixture
adapter were installed in a detached upstream worktree. No production code in
the baseline was changed.

| Benchmark | Main µs/op | Integrated µs/op | Speed ratio | B/op main / integrated | Allocs/op main / integrated |
|---|---:|---:|---:|---:|---:|
| First 32 KiB SSE event (complete commit barrier) | 68.611 | 54.374 | 1.26x | 237,931 / 237,931 | 16 / 19 |
| Native 60 KiB payload + local HTTP round trip | 776.446 | 638.446 | 1.22x | 377,347 / 184,237 | 171 / 138 |
| Resolve 1 candidate | 64.062 | 55.695 | 1.15x | 22,623 / 22,962 | 303 / 306 |
| Resolve 32 candidates | 1071.596 | 378.048 | 2.83x | 299,257 / 144,708 | 5,240 / 2,586 |
| Resolve 128 candidates | 3633.164 | 1266.342 | 2.87x | 1,181,415 / 545,980 | 20,516 / 9,511 |

Raw output: [main](benchmarks/ai-gateway-20261026-main.txt),
[integrated](benchmarks/ai-gateway-20261026-merged.txt).
The first-event benchmark now calls the complete `commitStream` barrier,
including error probing and replay wrapping. The original 15.44x comparison
against `f57acf6` used a different helper-only benchmark and is historical;
upstream already adopted buffered parsing, so it is not the current result.
First-event bytes are unchanged and allocation count rises from 16 to 19.
Single-candidate lookup adds three allocations; timing differences on a shared
host are noisy. HTTP round-trip allocations include the mock provider and
transport. SQLite results do not establish PostgreSQL production query plans.

## Validation

Passed with `GOMAXPROCS=8` from `apps/server`:

```sh
go test ./... -count=1 -timeout=180s
go vet ./...
go test ./internal/runtime -run 'TestGateway|TestCloudRunToolContinuation|TestContextCache' -count=1 -timeout=90s
go test -race ./internal/runtime -run 'TestGateway|TestCloudRunToolContinuation|TestContextCache' -count=1 -timeout=180s
go test -race ./internal/platform/httpx -count=1
go test ./internal/runtime -run '^$' -bench BenchmarkGateway -benchmem -count=3
```

Coverage includes incremental live HTTP SSE, replay/framing/size boundaries,
streams and translated readers exceeding 64 MiB lifetime, partial response
abort, cancelable transport retries, stalled error bodies, native integer
precision, route defaults, Anthropic cache conversion, upstream bridge/session
and keepalive tests, batch-query counts and tenant isolation. PostgreSQL tests
that require an external database retain their normal environment-based skips;
no external PostgreSQL server, real provider, proxy or production concurrency
was exercised. No upstream merge or production deployment was performed.
