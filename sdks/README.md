# Zakura REST SDKs

This directory contains repository-local Go, TypeScript, Python and Rust SDKs
for the server's registered HTTP API. Each SDK exposes the same 551 operations
at the initial revision. An operation's name follows its HTTP verb and path;
`GET /api/agents/{id}` becomes `GetApiAgentsById` in Go,
`client.agents.getApiAgentsById` in TypeScript and `get_api_agents_by_id` in
Python and Rust.

These are initial SDK implementations, not published registry releases.
Request payloads and response envelopes remain the caller's responsibility:
the route tree describes URLs and verbs, not domain schemas. Go decoding and
TypeScript/Rust generics let callers supply their own response types without
claiming runtime schema validation. Python returns ordinary decoded JSON.
Authorization and server-side validation are still enforced by the server.

## Go

Use a local module replacement until a release is tagged:

```go
// go.mod
require github.com/Moonrend/Zakura/sdks/go v0.0.0
replace github.com/Moonrend/Zakura/sdks/go => /path/to/Zakura/sdks/go
```

```go
import (
    "context"
    "net/url"
    "github.com/Moonrend/Zakura/sdks/go/zakura"
)

client, err := zakura.NewClient(zakura.Config{
    BaseURL: "http://localhost:8080",
    Token: "your-access-token",
})
if err != nil { panic(err) }
response, err := client.GetApiAgents().
    WithQuery(url.Values{"limit": {"20"}}).
    Execute(context.Background())
if err != nil { panic(err) }
var agents any
if err := response.Decode(&agents); err != nil { panic(err) }
```

Builders copy path parameters, query values, headers and raw bytes. JSON
values are borrowed until `Build`/`Execute`; do not mutate them concurrently.
`Client.Open(ctx, options)` provides an unbuffered response for downloads or
streams. Its caller owns the context deadline and must close the response
body. The bounded, retry-aware path is `Execute`.
Token providers and custom HTTP transports must honor the supplied context.

## TypeScript

Node 22+ or a browser with Fetch, Streams, AbortController and structuredClone
is required. The workspace package is `@zakura/sdk`; run
`pnpm --filter @zakura/sdk build` before importing its package entry point.

```ts
import { Client } from "@zakura/sdk";

const client = new Client({
  baseURL: "http://localhost:8080",
  token: "your-access-token",
});
const response = await client.agents.getApiAgents().withQuery({ limit: 20 }).execute();
const agents = response.json<unknown>();

const abort = new AbortController();
const request = client.agents.getApiAgentsById("agent-id").withSignal(abort.signal);
// abort.abort() cancels execute(), including token lookup and retry waits.
const agent = await request.json<unknown>();
```

Builders snapshot JSON, raw bodies, queries and headers. `build()` constructs
a Fetch Request; `execute()` applies the configured timeout and byte bound.
Injected Fetch functions must release network resources when their request's
signal is aborted. The SDK bounds awaiting an uncooperative function but
cannot terminate work inside user code.

## Python

Python 3.10+; the HTTP implementation uses the standard library.

```sh
python -m pip install ./sdks/python
```

```py
from zakura_sdk import Client

client = Client("http://localhost:8080", token="your-access-token")
response = client.get_api_agents().with_query(limit=20).execute()
agents = response.json()
created = client.post_api_agents().with_json({"name": "example"}).json()
```

Python calls are synchronous. Socket timeouts bound blocking HTTP operations;
the client also checks the overall deadline between construction, transport
and retries. Token callbacks must return promptly, and custom transports must
honor the timeout and response limit supplied to `send`. There is no external
cancellation API. Builders snapshot JSON, query values, headers and bytes.

## Rust

Add a local path dependency until the crate is published:

```toml
[dependencies]
zakura-sdk = { path = "/path/to/Zakura/sdks/rust" }
serde_json = "1"
```

```rust
use zakura_sdk::{Client, Config};

let mut config = Config::new("http://localhost:8080");
config.token = "your-access-token".into();
let client = Client::new(config)?;
let agents: serde_json::Value = client.get_api_agents().json()?;
let agent: serde_json::Value = client.get_api_agents_by_id("agent-id").json()?;
```

Rust uses blocking reqwest with rustls. Invoke it on a blocking worker when
integrating into an async runtime. Builders own their options; client clones
share the transport. Token callbacks and custom synchronous transports must
honor their execution contracts. There is no external cancellation API.

## Shared behavior

- Base URLs must be absolute HTTP(S), without embedded credentials, queries
  or fragments. A path prefix is supported. Pass the token separately.
- Path arguments are percent encoded as individual segments. Empty values,
  dot segments and arguments exceeding 4,096 UTF-8 bytes are rejected.
- The default timeout is 30 seconds; buffered responses are capped at 8 MiB.
  Both are configurable. Successful non-JSON responses can be read as bytes.
- Redirects are returned as API errors. SDKs do not forward credentials through
  redirects. HTTP errors preserve status, request ID and bounded body for
  inspection without including tokens or response bodies in error messages.
- The default is one attempt. If explicitly enabled (maximum eight attempts),
  only GET/HEAD retry HTTP 429, 502, 503 or 504. `Retry-After` and exponential
  delays are bounded. Mutations and transport errors are never retried.
- JSON bodies and raw bodies are mutually exclusive. JSON null is supported.
  Use raw bytes with `application/x-www-form-urlencoded` for OAuth forms.
- Pagination helpers require a caller-provided next-cursor function because
  the server has multiple response envelopes. They guard repeated cursors
  and a configured page cap; they do not infer pagination for every endpoint.
- WebSocket, terminal/desktop proxy and wildcard routes are excluded. Buffered
  calls are unsuitable for unlimited streams; use an appropriate transport.

## Generation and verification

The build-time catalog command migrates an isolated in-memory SQLite database
and walks the actual Chi router. It binds no port and cancels the runtime
context before registration. It does not change an application database.

```sh
# Go 1.26+ and rustfmt must be available on PATH.
python3 scripts/sdk/generate.py
python3 scripts/sdk/generate.py --check
(cd apps/server && go run ./cmd/zakura-route-catalog) > /tmp/zakura-routes.json
python3 scripts/sdk/verify_routes.py --routes /tmp/zakura-routes.json
python3 scripts/sdk/count_source.py
```

`--routes` optionally accepts an exported catalog for offline generation.
Generated sources have a `DO NOT EDIT` marker; edit the generator instead.
The generator formats Go and Rust with their standard formatters and resolves
operation-name collisions with deterministic suffixes. The contract verifier
executes all builders with Unicode, slash, percent and query punctuation in
path parameters and compares their methods/URLs to the live catalog. Its
probes are temporary and are removed on completion.

Implementation SLOC counts nonblank source lines, excludes comment-only
lines and Python docstrings, and includes declarations, imports and syntax
braces. Only production code under the four SDK source roots is counted:
tests, documentation, catalogs, generators, manifests, lockfiles and build
output are excluded. The report distinguishes handwritten transport code
from generated executable endpoint implementation. These SDKs do not add
bulk fixtures or generated sample data.

Run the focused checks with:

```sh
(cd sdks/go && go test -race ./... && go vet ./...)
pnpm --filter @zakura/sdk typecheck
pnpm --filter @zakura/sdk test
(cd sdks/python && PYTHONPATH=. python3 -m unittest discover -s tests -v)
cargo test --locked --manifest-path sdks/rust/Cargo.toml
cargo clippy --locked --manifest-path sdks/rust/Cargo.toml --all-targets -- -D warnings
```

All SDK sources follow the repository's AGPL-3.0-only license.
