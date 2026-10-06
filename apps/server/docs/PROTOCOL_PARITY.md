# Protocol parity ledger

This ledger covers backend entrypoints and wire protocols that cannot be found
reliably by scanning literal HTTP route registrations. It complements
`ROUTE_PARITY.md`; neither registration nor a smoke handshake alone proves full
semantic parity.

| Surface | Pinned implementation | Native Go implementation | Positive wire coverage | Current result |
|---|---|---|---|---|
| OAuth 2.0/OIDC metadata, DCR/CIMD, authorization, token, revocation, userinfo, durable RS256 JWKS and private-key JWT | `apps/server/src/oauth/http.ts`, `services/oauth*.ts` | `internal/platform/identity/oauth_*.go` | authorization-code and refresh CAS, DCR SHA-256 compatibility, CIMD fake metadata, fake JWKS assertion, TypeScript signing-key import, ID/access token and userinfo tests | implemented and locally passing |
| OAuth login and upstream-provider callbacks | SaaS routes and `api/mcp-routes.ts` | identity and runtime OAuth handlers | deterministic fake-provider login, state replay, upstream OAuth tests | implemented and locally passing |
| Main agent MCP Streamable HTTP (`/mcp`, `/mcp/*`) | `apps/server/src/mcp/http.ts` and `index.ts` | runtime MCP handlers | retired tenant-root response, agent initialize, API-key/OAuth cross-agent denial, policy-filtered JSON-RPC tool tests | implemented and locally passing |
| Per-component MCP upstream client | `apps/server/src/services/mcp-client.ts` | runtime MCP client/call routes | deterministic fake upstream plus reversible RFC6570 resource-template qualification/expansion tests | implemented and locally passing |
| Stdio MCP to Streamable HTTP sidecar | `apps/server/src/mcp/stdio-bridge.ts`, `providers/stdio-mcp.ts` | `cmd/zakura-stdio-bridge`, `internal/integrations/stdio_bridge.go` and runtime-node provisioning | fake child initialize/tool RPC, concurrent same-ID sessions, SSE notification, deletion and runner provisioning tests | implemented and locally passing |
| Socket.IO / Engine.IO v4 (`/api/socket.io`) | `realtime/socket-gateway.ts`, `realtime/yjs-sync.ts` | `internal/runtime/socketio*.go` | polling and raw WebSocket auth, tenant presence, backlog/ack/reconnect, lossless Yjs checkpoints, state-vector diffs, restart and concurrent merge | implemented and locally passing |
| Runtime-node runner hub WebSocket and persistent ACP process sessions | `services/runner-hub.ts`, `services/acp/session.ts` | `internal/runtime/runner_hub.go`, `internal/runtime/acp_runtime.go` | scoped runner enrollment/token, `sys.info`, selected-node process boot/recovery, prompt/cancel, live mode/model/config/commands, permission and elicitation resolution, and no-host-fallback tests | implemented and locally passing |
| Desktop and terminal proxy WebSockets | desktop proxy/workspace services | `internal/runtime/workspace_proxy.go` | ticket validation and proxy/path-jail tests | implemented and locally passing |
| ZakuraBot raw WebSocket | `services/zakurabot-gateway.ts` | `internal/runtime/zakurabot_ws.go` | hello/auth roster/history/send/interrupt/ping and rejection tests | implemented and locally passing |
| ZakuraBot mounted HTTP app/session APIs | `api/zakurabot-app-routes.ts`, `api/zakurabot-session-routes.ts` | `internal/runtime/zakurabot_app.go` | roster/history/session/reaction plus selected-runner exec, desktop/frame PNG, jailed upload/download and pending-question answer lifecycle tests | implemented and locally passing |
| OpenAI Responses and Chat Completions, Anthropic Messages, SSE | `api/openai-gateway-routes.ts` | runtime model gateway | request normalization, weighted routing, ordered failover, retry/cancel, first-event commit barrier and bounded tool continuation tests | implemented and locally passing |
| Workspace migration SSE | `api/migration-routes.ts` | runtime migration handlers | `text/event-stream` progress-frame test | implemented and locally passing |
| SCIM 2.0 users/groups | `api/scim-routes.ts` | `internal/platform/identity/enterprise.go` | authenticated user/group lifecycle and tenant-bound tests | implemented and locally passing |
| OTLP log ingestion | `api/otel-routes.ts` | runtime public protocols | env contract, filter and rate-limit tests | implemented and locally passing |
| Remote connector/channel inbound webhooks and email | connector/channel services | integrations handlers | durable idempotent inbound/delivery tests using fake transports | implemented and locally passing |

## Acceptance rules

- A surface is complete only when the native implementation performs the real
  protocol state transition and has a positive workflow test. An endpoint that
  returns a placeholder, empty object, or “unsupported” error is not complete.
- External providers are verified with deterministic local fakes. Live paid
  calls and production credentials are outside the local test suite.
- PostgreSQL wire behavior must pass the repository's real `lib/pq` workflow;
  an embedded PostgreSQL-compatible parser is additional coverage, not a
  substitute.
- The preserved frontend browser workflow must complete setup, onboarding and
  dashboard/API interactions against the Go server and PostgreSQL before a
  production-readiness claim.
