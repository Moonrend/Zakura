# AI gateway performance refactor

Baseline: `f57acf6` on `Moonrend/Zakura/main`. Environment: Linux amd64,
Go 1.26.9, AMD EPYC 9V74, GOMAXPROCS=8. Results are medians of three runs on
the same host, separately from the test suite. These are local microbenchmarks,
not production latency claims.

## Changes

- Use a 4 KiB buffered first-event reader instead of one-byte reads. Replay
  prefetched bytes, support LF/CRLF, and retain the 64 KiB first-event bound.
- Flush each upstream stream chunk through `http.ResponseController`, set
  `X-Accel-Buffering: no`, and reuse a 32 KiB copy buffer. Bound working memory
  rather than truncating streams at 64 MiB total lifetime bytes.
- Resolve upstreams in two database queries instead of 1+N. Deduplicate shared
  upstreams and keep the cheap single-upstream lookup. Above 500 distinct
  upstreams, use a tenant-scoped subquery to avoid bind-parameter limits.
  No configuration cache is introduced: updates remain immediately visible.
  Preserve weighted selection and ordered failover.
- Remove the HTTP handler's full JSON decode/remarshal. Leave nested native
  OpenAI payloads opaque and replace only the model. Copy validated raw values
  directly, avoiding another validation/compaction pass. Protocol conversion
  uses `UseNumber`, preserving integer precision. Reject non-object and
  trailing/multiple JSON documents.
- Increase reusable idle connections to 256 overall, 64 per host.
- Close failed response bodies without waiting for a stalled error-body stream.
  Unread errors may forfeit HTTP/1 connection reuse; successful response reuse
  is unchanged. Retry waits respect cancellation, including transport errors,
  with no delay after the last failure.
- Check non-stream response size before writing headers. Return 502 on a
  pre-commit read failure; abort partial responses on subsequent read/write
  failures. Recovery middleware propagates `http.ErrAbortHandler` without
  appending an error document to SSE output.

## Results

| Benchmark | Before | After | Interpretation |
|---|---:|---:|---|
| Read first 32 KiB SSE event | 445.198 µs | 28.844 µs | 15.44× faster parsing |
| Native 60 KiB request, local HTTP round trip | 589.306 µs | 540.929 µs | 8.2% lower time |
| Resolve 1 candidate | 49.244 µs | 49.591 µs | Essentially unchanged (+0.7%) |
| Resolve 32 candidates | 796.446 µs | 359.790 µs | 2.21× faster |
| Resolve 128 candidates | 2,784.406 µs | 1,247.169 µs | 2.23× faster |

| Allocation bytes per operation | Before | After | Reduction |
|---|---:|---:|---:|
| Native 60 KiB request, local HTTP round trip | 300,055 | 181,935 | 39.4% |
| Resolve 32 candidates | 293,249 | 138,708 | 52.7% |
| Resolve 128 candidates | 1,158,098 | 522,093 | 54.9% |

First-event allocated bytes are essentially unchanged (131,042 → 131,106),
while allocation count falls from 13 to 7. Single-candidate allocation cost
increases slightly (22,414 → 22,750 bytes, 303 → 306 allocations).
The HTTP benchmark includes the mock provider and transport, so its allocation
figures are not isolated gateway heap measurements. The first-event benchmark
excludes network/provider generation time. Incremental delivery is verified
with an upstream that waits for downstream receipt before completing.

## Validation and reproduction

Run from `apps/server`:

```sh
go test ./...
go vet ./...
go test -race ./internal/runtime -run 'TestGateway|TestCloudRunToolContinuation' -count=1
go test -race ./internal/platform/httpx -count=1
go test ./internal/runtime -run '^$' -bench BenchmarkGateway -benchmem -count=3
```

Regression cases cover live HTTP incremental delivery, prefetch replay, LF/CRLF,
long-line buffer boundaries, exact/oversized first events, incomplete first
events, streams exceeding 64 MiB, pre/post-commit read failures, canceled retries,
stalled HTTP 500 bodies, protocol normalization, integer precision, two-query
resolution, immediate status updates, tenant isolation, shared upstreams, and
catalogs beyond the bind-limit threshold. Existing failover/commit-barrier and
cloud tool-continuation tests remain passing.

Actual provider generation latency, network conditions, PostgreSQL query plans,
reverse-proxy settings, and production concurrency have not been measured.
No production deployment is part of this change. Measure gateway and provider
latency separately when checking the deployed service.
