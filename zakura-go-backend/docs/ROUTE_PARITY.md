# Zakura Go route parity ledger

Generated from the pinned 474-row core-handler manifest plus 46 routes dynamically loaded from the SaaS package and 18 routes hidden behind mounted Hono subrouters. `registered` proves the native Go router exposes the method/path. `focused HTTP test` means a Go test contains a concrete URL matching the route pattern; it does not by itself claim complete semantic parity. Duplicate upstream registrations remain separate rows.

The route table is only one acceptance dimension. Non-literal/configurable protocol surfaces (Socket.IO/Engine.IO, runner-hub and desktop/terminal WebSockets, MCP Streamable HTTP, and the stdio MCP bridge) are tracked separately in `PROTOCOL_PARITY.md`.

Required rows: **538**; registered rows: **538**; rows with focused Go HTTP URL evidence: **190**.

| Method | Required path | Registered | Focused HTTP test | Pinned source | Prior evidence |
|---|---|---:|---:|---|---|
| GET | `/` | yes | yes | `apps/server/src/index.ts:425` | `instance-tools.test.ts`, `identity-tenant-lifecycle.test.ts`, `identity-domains.test.ts` |
| GET | `/` | yes | yes | `apps/server/src/mcp/stdio-bridge.ts:180` | `instance-tools.test.ts`, `identity-tenant-lifecycle.test.ts`, `identity-domains.test.ts` |
| GET | `/.well-known/jwks.json` | yes | yes | `apps/server/src/oauth/http.ts:76` | `oauth-cimd.test.ts` |
| GET | `/.well-known/oauth-authorization-server` | yes | no | `apps/server/src/oauth/http.ts:68` | `mcp-upstream-oauth-security.test.ts` |
| GET | `/.well-known/oauth-authorization-server/*` | yes | no | `apps/server/src/oauth/http.ts:69` | hosted full suite / module compatibility |
| GET | `/.well-known/oauth-protected-resource` | yes | no | `apps/server/src/oauth/http.ts:85` | hosted full suite / module compatibility |
| GET | `/.well-known/oauth-protected-resource/*` | yes | no | `apps/server/src/oauth/http.ts:89` | hosted full suite / module compatibility |
| GET | `/.well-known/openid-configuration` | yes | yes | `apps/server/src/oauth/http.ts:72` | hosted full suite / module compatibility |
| GET | `/.well-known/openid-configuration/*` | yes | no | `apps/server/src/oauth/http.ts:73` | hosted full suite / module compatibility |
| GET | `/api/acp/registry` | yes | no | `apps/server/src/api/acp-routes.ts:43` | hosted full suite / module compatibility |
| GET | `/api/agents` | yes | yes | `apps/server/src/api/routes.ts:1833` | `observability.test.ts`, `spaces-lifecycle-api.test.ts`, `automation-runs.test.ts` |
| POST | `/api/agents` | yes | yes | `apps/server/src/api/routes.ts:1854` | `observability.test.ts`, `spaces-lifecycle-api.test.ts`, `automation-runs.test.ts` |
| DELETE | `/api/agents/{id}` | yes | yes | `apps/server/src/api/routes.ts:2261` | `automation-runs.test.ts`, `agent-duplicate.test.ts` |
| GET | `/api/agents/{id}` | yes | yes | `apps/server/src/api/routes.ts:2038` | `automation-runs.test.ts`, `agent-duplicate.test.ts` |
| PATCH | `/api/agents/{id}` | yes | yes | `apps/server/src/api/routes.ts:2227` | `automation-runs.test.ts`, `agent-duplicate.test.ts` |
| GET | `/api/agents/{id}/acp/adapters` | yes | no | `apps/server/src/api/acp-routes.ts:63` | hosted full suite / module compatibility |
| DELETE | `/api/agents/{id}/acp/adapters/{registryId}` | yes | no | `apps/server/src/api/acp-routes.ts:99` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/acp/adapters/{registryId}/adopt` | yes | no | `apps/server/src/api/acp-routes.ts:138` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/acp/adapters/{registryId}/install` | yes | no | `apps/server/src/api/acp-routes.ts:80` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/acp/adapters/gc` | yes | no | `apps/server/src/api/acp-routes.ts:117` | hosted full suite / module compatibility |
| DELETE | `/api/agents/{id}/acp/agents/{profileId}` | yes | no | `apps/server/src/api/acp-routes.ts:247` | hosted full suite / module compatibility |
| PUT | `/api/agents/{id}/acp/agents/{profileId}` | yes | no | `apps/server/src/api/acp-routes.ts:225` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/acp/agents/{profileId}/install` | yes | no | `apps/server/src/api/acp-routes.ts:271` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/acp/agents/{profileId}/oauth/device/cancel` | yes | no | `apps/server/src/api/acp-routes.ts:492` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/acp/agents/{profileId}/oauth/device/poll` | yes | no | `apps/server/src/api/acp-routes.ts:478` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/acp/agents/{profileId}/oauth/device/start` | yes | no | `apps/server/src/api/acp-routes.ts:463` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/acp/agents/{profileId}/probe` | yes | no | `apps/server/src/api/acp-routes.ts:258` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/acp/config` | yes | no | `apps/server/src/api/acp-routes.ts:180` | hosted full suite / module compatibility |
| PUT | `/api/agents/{id}/acp/config` | yes | no | `apps/server/src/api/acp-routes.ts:196` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/acp/draft` | yes | no | `apps/server/src/api/acp-routes.ts:314` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/acp/installs` | yes | no | `apps/server/src/api/acp-routes.ts:291` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/automation/runs` | yes | no | `apps/server/src/api/automation-routes.ts:189` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/automation/runs/{rid}` | yes | no | `apps/server/src/api/automation-routes.ts:203` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/automation/runs/{rid}/cancel` | yes | no | `apps/server/src/api/automation-routes.ts:212` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/bindings` | yes | no | `apps/server/src/api/routes.ts:2363` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/bindings` | yes | no | `apps/server/src/api/routes.ts:2370` | hosted full suite / module compatibility |
| DELETE | `/api/agents/{id}/bindings/{instanceId}` | yes | no | `apps/server/src/api/routes.ts:2386` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/cloud/composer` | yes | no | `apps/server/src/api/cloud-agent-routes.ts:220` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/cloud/config` | yes | no | `apps/server/src/api/cloud-agent-routes.ts:231` | hosted full suite / module compatibility |
| PUT | `/api/agents/{id}/cloud/config` | yes | no | `apps/server/src/api/cloud-agent-routes.ts:248` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/cloud/sessions` | yes | no | `apps/server/src/api/cloud-agent-routes.ts:444` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/cloud/sessions` | yes | no | `apps/server/src/api/cloud-agent-routes.ts:470` | hosted full suite / module compatibility |
| DELETE | `/api/agents/{id}/cloud/sessions/{sid}` | yes | no | `apps/server/src/api/cloud-agent-routes.ts:650` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/cloud/sessions/{sid}` | yes | no | `apps/server/src/api/cloud-agent-routes.ts:509` | hosted full suite / module compatibility |
| PATCH | `/api/agents/{id}/cloud/sessions/{sid}` | yes | no | `apps/server/src/api/cloud-agent-routes.ts:601` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/cloud/sessions/{sid}/cancel` | yes | no | `apps/server/src/api/cloud-agent-routes.ts:905` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/cloud/sessions/{sid}/compact` | yes | no | `apps/server/src/api/cloud-agent-routes.ts:923` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/cloud/sessions/{sid}/continue` | yes | no | `apps/server/src/api/cloud-agent-routes.ts:875` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/cloud/sessions/{sid}/fork` | yes | no | `apps/server/src/api/cloud-agent-routes.ts:947` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/cloud/sessions/{sid}/messages` | yes | no | `apps/server/src/api/cloud-agent-routes.ts:667` | hosted full suite / module compatibility |
| DELETE | `/api/agents/{id}/cloud/sessions/{sid}/queue/{messageId}` | yes | no | `apps/server/src/api/cloud-agent-routes.ts:778` | hosted full suite / module compatibility |
| PATCH | `/api/agents/{id}/cloud/sessions/{sid}/queue/{messageId}` | yes | no | `apps/server/src/api/cloud-agent-routes.ts:759` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/cloud/sessions/{sid}/queue/{messageId}/interrupt` | yes | no | `apps/server/src/api/cloud-agent-routes.ts:788` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/cloud/sessions/{sid}/regenerate` | yes | no | `apps/server/src/api/cloud-agent-routes.ts:811` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/cloud/sessions/{sid}/retry` | yes | no | `apps/server/src/api/cloud-agent-routes.ts:844` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/cloud/sessions/{sid}/tools` | yes | no | `apps/server/src/api/cloud-agent-routes.ts:585` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/connectors` | yes | yes | `apps/server/src/api/connector-routes.ts:287` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/desktop` | yes | yes | `apps/server/src/api/routes.ts:2175` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/desktop-ticket` | yes | yes | `apps/server/src/api/routes.ts:2182` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/duplicate` | yes | no | `apps/server/src/api/routes.ts:1911` | `agent-duplicate.test.ts` |
| GET | `/api/agents/{id}/exposures` | yes | no | `apps/server/src/api/network-routes.ts:385` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/exposures` | yes | no | `apps/server/src/api/network-routes.ts:394` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/fs` | yes | no | `apps/server/src/api/agent-fs-routes.ts:118` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/fs/archive` | yes | no | `apps/server/src/api/agent-fs-routes.ts:203` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/fs/delete` | yes | no | `apps/server/src/api/agent-fs-routes.ts:302` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/fs/download` | yes | no | `apps/server/src/api/agent-fs-routes.ts:176` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/fs/extract` | yes | no | `apps/server/src/api/agent-fs-routes.ts:344` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/fs/list` | yes | no | `apps/server/src/api/agent-fs-routes.ts:137` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/fs/mkdir` | yes | no | `apps/server/src/api/agent-fs-routes.ts:282` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/fs/read` | yes | no | `apps/server/src/api/agent-fs-routes.ts:156` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/fs/rename` | yes | no | `apps/server/src/api/agent-fs-routes.ts:322` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/fs/upload` | yes | no | `apps/server/src/api/agent-fs-routes.ts:255` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/fs/write` | yes | no | `apps/server/src/api/agent-fs-routes.ts:229` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/gateway/sessions` | yes | no | `apps/server/src/api/cloud-agent-routes.ts:459` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/heartbeat` | yes | no | `apps/server/src/api/automation-routes.ts:231` | hosted full suite / module compatibility |
| PATCH | `/api/agents/{id}/heartbeat` | yes | no | `apps/server/src/api/automation-routes.ts:239` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/heartbeat/run` | yes | no | `apps/server/src/api/automation-routes.ts:259` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/keys` | yes | no | `apps/server/src/api/routes.ts:2487` | hosted full suite / module compatibility |
| DELETE | `/api/agents/{id}/memory` | yes | no | `apps/server/src/api/memory-routes.ts:400` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/memory` | yes | no | `apps/server/src/api/memory-routes.ts:135` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/memory/edges` | yes | no | `apps/server/src/api/memory-routes.ts:304` | hosted full suite / module compatibility |
| DELETE | `/api/agents/{id}/memory/edges/{edgeId}` | yes | no | `apps/server/src/api/memory-routes.ts:327` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/memory/embedding-stats` | yes | no | `apps/server/src/api/memory-routes.ts:277` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/memory/graph` | yes | no | `apps/server/src/api/memory-routes.ts:297` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/memory/items` | yes | no | `apps/server/src/api/memory-routes.ts:179` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/memory/items` | yes | no | `apps/server/src/api/memory-routes.ts:207` | hosted full suite / module compatibility |
| DELETE | `/api/agents/{id}/memory/items/{memId}` | yes | no | `apps/server/src/api/memory-routes.ts:388` | hosted full suite / module compatibility |
| PATCH | `/api/agents/{id}/memory/items/{memId}` | yes | no | `apps/server/src/api/memory-routes.ts:335` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/memory/reembed` | yes | no | `apps/server/src/api/memory-routes.ts:247` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/memory/search` | yes | no | `apps/server/src/api/memory-routes.ts:197` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/migrations` | yes | yes | `apps/server/src/api/migration-routes.ts:42` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/migrations` | yes | yes | `apps/server/src/api/migration-routes.ts:20` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/progress` | yes | no | `apps/server/src/api/routes.ts:2314` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/projects` | yes | yes | `apps/server/src/api/agent-fs-routes.ts:364` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/projects` | yes | yes | `apps/server/src/api/agent-fs-routes.ts:395` | hosted full suite / module compatibility |
| DELETE | `/api/agents/{id}/projects/{slug}` | yes | yes | `apps/server/src/api/agent-fs-routes.ts:646` | hosted full suite / module compatibility |
| PATCH | `/api/agents/{id}/projects/{slug}` | yes | yes | `apps/server/src/api/agent-fs-routes.ts:494` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/projects/{slug}/config` | yes | no | `apps/server/src/api/agent-fs-routes.ts:737` | hosted full suite / module compatibility |
| PUT | `/api/agents/{id}/projects/{slug}/hooks` | yes | yes | `apps/server/src/api/agent-fs-routes.ts:796` | hosted full suite / module compatibility |
| PUT | `/api/agents/{id}/projects/{slug}/instructions` | yes | no | `apps/server/src/api/agent-fs-routes.ts:758` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/projects/{slug}/skills` | yes | yes | `apps/server/src/api/agent-fs-routes.ts:830` | hosted full suite / module compatibility |
| DELETE | `/api/agents/{id}/projects/{slug}/skills/{name}` | yes | yes | `apps/server/src/api/agent-fs-routes.ts:920` | hosted full suite / module compatibility |
| PUT | `/api/agents/{id}/projects/{slug}/skills/{name}` | yes | yes | `apps/server/src/api/agent-fs-routes.ts:890` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/projects/{slug}/skills/{name}/file` | yes | yes | `apps/server/src/api/agent-fs-routes.ts:867` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/providers` | yes | no | `apps/server/src/api/routes.ts:2401` | hosted full suite / module compatibility |
| PUT | `/api/agents/{id}/providers` | yes | no | `apps/server/src/api/routes.ts:2412` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/routines` | yes | no | `apps/server/src/api/automation-routes.ts:43` | `automation-runs.test.ts` |
| POST | `/api/agents/{id}/routines` | yes | no | `apps/server/src/api/automation-routes.ts:51` | `automation-runs.test.ts` |
| DELETE | `/api/agents/{id}/routines/{sid}` | yes | no | `apps/server/src/api/automation-routes.ts:140` | `automation-runs.test.ts` |
| GET | `/api/agents/{id}/routines/{sid}` | yes | no | `apps/server/src/api/automation-routes.ts:91` | `automation-runs.test.ts` |
| PATCH | `/api/agents/{id}/routines/{sid}` | yes | no | `apps/server/src/api/automation-routes.ts:102` | `automation-runs.test.ts` |
| POST | `/api/agents/{id}/routines/{sid}/run` | yes | no | `apps/server/src/api/automation-routes.ts:153` | `automation-runs.test.ts` |
| GET | `/api/agents/{id}/routines/{sid}/runs` | yes | no | `apps/server/src/api/automation-routes.ts:169` | `automation-runs.test.ts` |
| GET | `/api/agents/{id}/routines/{sid}/webhook-secret` | yes | no | `apps/server/src/api/automation-routes.ts:271` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/sessions/{sid}/acp-runtime` | yes | no | `apps/server/src/api/acp-routes.ts:299` | hosted full suite / module compatibility |
| PATCH | `/api/agents/{id}/sessions/{sid}/acp-runtime/config` | yes | no | `apps/server/src/api/acp-routes.ts:411` | hosted full suite / module compatibility |
| PATCH | `/api/agents/{id}/sessions/{sid}/acp-runtime/mode` | yes | no | `apps/server/src/api/acp-routes.ts:375` | hosted full suite / module compatibility |
| PATCH | `/api/agents/{id}/sessions/{sid}/acp-runtime/model` | yes | no | `apps/server/src/api/acp-routes.ts:393` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/sessions/{sid}/acp/authenticate` | yes | no | `apps/server/src/api/acp-routes.ts:433` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/sessions/{sid}/acp/elicitation` | yes | no | `apps/server/src/api/acp-routes.ts:354` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/sessions/{sid}/acp/logout` | yes | no | `apps/server/src/api/acp-routes.ts:449` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/sessions/{sid}/acp/permission` | yes | no | `apps/server/src/api/acp-routes.ts:337` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/sessions/{sid}/approvals` | yes | no | `apps/server/src/api/interaction-routes.ts:33` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/sessions/{sid}/ask-user` | yes | no | `apps/server/src/api/interaction-routes.ts:14` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/skills` | yes | no | `apps/server/src/api/skill-routes.ts:329` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/skills` | yes | no | `apps/server/src/api/skill-routes.ts:341` | hosted full suite / module compatibility |
| DELETE | `/api/agents/{id}/skills/{name}` | yes | no | `apps/server/src/api/skill-routes.ts:396` | hosted full suite / module compatibility |
| PATCH | `/api/agents/{id}/skills/{name}` | yes | no | `apps/server/src/api/skill-routes.ts:378` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/skills/{name}/file` | yes | no | `apps/server/src/api/skill-routes.ts:406` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/start` | yes | no | `apps/server/src/api/routes.ts:2272` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/stop` | yes | no | `apps/server/src/api/routes.ts:2342` | hosted full suite / module compatibility |
| POST | `/api/agents/{id}/terminal-ticket` | yes | yes | `apps/server/src/api/routes.ts:2206` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/tool-calls` | yes | yes | `apps/server/src/api/routes.ts:3311` | hosted full suite / module compatibility |
| GET | `/api/agents/{id}/tool-calls/stats` | yes | no | `apps/server/src/api/routes.ts:3320` | hosted full suite / module compatibility |
| GET | `/api/api-keys` | yes | yes | `apps/server/src/api/routes.ts:3328` | hosted full suite / module compatibility |
| POST | `/api/api-keys` | yes | yes | `apps/server/src/api/routes.ts:3347` | hosted full suite / module compatibility |
| DELETE | `/api/api-keys/{id}` | yes | no | `apps/server/src/api/routes.ts:3407` | hosted full suite / module compatibility |
| POST | `/api/auth/forgot-password` | yes | yes | `apps/server/src/api/identity-routes.ts:99` | hosted full suite / module compatibility |
| POST | `/api/auth/login` | yes | yes | `apps/server/src/api/routes.ts:797` | `identity-session-routes.test.ts` |
| POST | `/api/auth/mfa/complete` | yes | yes | `apps/server/src/api/identity-routes.ts:375` | `identity-session-routes.test.ts` |
| POST | `/api/auth/mfa/enrollment/totp/complete` | yes | yes | `apps/server/src/api/identity-routes.ts:472` | `identity-session-routes.test.ts` |
| POST | `/api/auth/mfa/enrollment/totp/start` | yes | yes | `apps/server/src/api/identity-routes.ts:461` | `identity-session-routes.test.ts` |
| POST | `/api/auth/mfa/webauthn/options` | yes | no | `apps/server/src/api/identity-routes.ts:363` | hosted full suite / module compatibility |
| POST | `/api/auth/reset-password` | yes | no | `apps/server/src/api/identity-routes.ts:107` | `identity-session-routes.test.ts` |
| POST | `/api/auth/sso/{protocol}/start` | yes | yes | `apps/server/src/api/identity-routes.ts:140` | hosted full suite / module compatibility |
| POST | `/api/auth/sso/discover` | yes | no | `apps/server/src/api/identity-routes.ts:127` | hosted full suite / module compatibility |
| POST | `/api/auth/sso/oidc/callback` | yes | yes | `apps/server/src/api/identity-routes.ts:162` | `identity-tenant-lifecycle.test.ts` |
| POST | `/api/auth/sso/saml/{slug}/acs` | yes | no | `apps/server/src/api/identity-routes.ts:238` | hosted full suite / module compatibility |
| GET | `/api/auth/sso/saml/{slug}/metadata` | yes | no | `apps/server/src/api/identity-routes.ts:321` | hosted full suite / module compatibility |
| POST | `/api/auth/sso/ticket` | yes | no | `apps/server/src/api/identity-routes.ts:330` | hosted full suite / module compatibility |
| POST | `/api/auth/verify-email` | yes | no | `apps/server/src/api/identity-routes.ts:119` | `identity-session-routes.test.ts` |
| GET | `/api/capabilities` | yes | yes | `apps/server/src/api/routes.ts:1190` | hosted full suite / module compatibility |
| GET | `/api/capabilities/web-fetch` | yes | yes | `apps/server/src/api/routes.ts:1287` | hosted full suite / module compatibility |
| PUT | `/api/capabilities/web-fetch` | yes | yes | `apps/server/src/api/routes.ts:1309` | hosted full suite / module compatibility |
| GET | `/api/capabilities/web-search` | yes | yes | `apps/server/src/api/routes.ts:1166` | hosted full suite / module compatibility |
| PUT | `/api/capabilities/web-search` | yes | yes | `apps/server/src/api/routes.ts:1254` | hosted full suite / module compatibility |
| GET | `/api/cloud/search` | yes | no | `apps/server/src/api/cloud-agent-routes.ts:419` | hosted full suite / module compatibility |
| GET | `/api/connect` | yes | yes | `apps/server/src/api/routes.ts:1004` | hosted full suite / module compatibility |
| GET | `/api/connections` | yes | yes | `apps/server/src/api/connection-routes.ts:21` | hosted full suite / module compatibility |
| DELETE | `/api/connections/{id}` | yes | yes | `apps/server/src/api/connection-routes.ts:170` | hosted full suite / module compatibility |
| POST | `/api/connections/{id}/bind` | yes | no | `apps/server/src/api/connection-routes.ts:157` | hosted full suite / module compatibility |
| POST | `/api/connections/{id}/start` | yes | yes | `apps/server/src/api/connection-routes.ts:204` | hosted full suite / module compatibility |
| POST | `/api/connections/{id}/stop` | yes | yes | `apps/server/src/api/connection-routes.ts:216` | hosted full suite / module compatibility |
| POST | `/api/connections/install` | yes | yes | `apps/server/src/api/connection-routes.ts:123` | hosted full suite / module compatibility |
| GET | `/api/connections/packages` | yes | no | `apps/server/src/api/connection-routes.ts:48` | hosted full suite / module compatibility |
| GET | `/api/connections/packages/{id}` | yes | no | `apps/server/src/api/connection-routes.ts:66` | hosted full suite / module compatibility |
| POST | `/api/connections/packages/{id}/install` | yes | no | `apps/server/src/api/connection-routes.ts:74` | hosted full suite / module compatibility |
| GET | `/api/connections/search` | yes | no | `apps/server/src/api/connection-routes.ts:27` | hosted full suite / module compatibility |
| GET | `/api/connections/sources` | yes | yes | `apps/server/src/api/connection-routes.ts:43` | hosted full suite / module compatibility |
| POST | `/api/connections/sources` | yes | yes | `apps/server/src/api/connection-routes.ts:98` | hosted full suite / module compatibility |
| DELETE | `/api/connections/sources/{id}` | yes | yes | `apps/server/src/api/connection-routes.ts:114` | hosted full suite / module compatibility |
| GET | `/api/connectors` | yes | yes | `apps/server/src/api/connector-routes.ts:86` | hosted full suite / module compatibility |
| PUT | `/api/connectors/{id}/credentials` | yes | no | `apps/server/src/api/connector-routes.ts:304` | hosted full suite / module compatibility |
| POST | `/api/connectors/{ref}/install` | yes | yes | `apps/server/src/api/connector-routes.ts:239` | hosted full suite / module compatibility |
| DELETE | `/api/connectors/{ref}/installations/{agentId}` | yes | no | `apps/server/src/api/connector-routes.ts:270` | hosted full suite / module compatibility |
| POST | `/api/connectors/{ref}/oauth/start` | yes | no | `apps/server/src/api/connector-routes.ts:174` | hosted full suite / module compatibility |
| PUT | `/api/connectors/{ref}/settings` | yes | no | `apps/server/src/api/connector-routes.ts:364` | hosted full suite / module compatibility |
| GET | `/api/connectors/profiles` | yes | yes | `apps/server/src/api/connector-routes.ts:106` | hosted full suite / module compatibility |
| DELETE | `/api/connectors/profiles/{profileKey}` | yes | yes | `apps/server/src/api/connector-routes.ts:140` | hosted full suite / module compatibility |
| PUT | `/api/connectors/profiles/{profileKey}` | yes | yes | `apps/server/src/api/connector-routes.ts:116` | hosted full suite / module compatibility |
| GET | `/api/connectors/shared-oauth` | yes | no | `apps/server/src/api/connector-routes.ts:158` | hosted full suite / module compatibility |
| GET | `/api/containers` | yes | no | `apps/server/src/api/routes.ts:1724` | hosted full suite / module compatibility |
| POST | `/api/containers/{id}/stop` | yes | no | `apps/server/src/api/routes.ts:1802` | hosted full suite / module compatibility |
| POST | `/api/containers/allocate` | yes | no | `apps/server/src/api/routes.ts:1781` | hosted full suite / module compatibility |
| GET | `/api/email-connectors` | yes | no | `apps/server/src/api/routes.ts:2766` | hosted full suite / module compatibility |
| POST | `/api/email-connectors` | yes | no | `apps/server/src/api/routes.ts:2771` | hosted full suite / module compatibility |
| DELETE | `/api/email-connectors/{id}` | yes | no | `apps/server/src/api/routes.ts:2812` | hosted full suite / module compatibility |
| PATCH | `/api/email-connectors/{id}` | yes | no | `apps/server/src/api/routes.ts:2790` | hosted full suite / module compatibility |
| POST | `/api/email/inbound/{tenantId}` | yes | yes | `apps/server/src/api/routes.ts:680` | hosted full suite / module compatibility |
| POST | `/api/email/inbound/{tenantId}/{connectorId}` | yes | yes | `apps/server/src/api/routes.ts:681` | hosted full suite / module compatibility |
| DELETE | `/api/exposures/{id}` | yes | no | `apps/server/src/api/network-routes.ts:426` | hosted full suite / module compatibility |
| GET | `/api/files/shared/{token}` | yes | yes | `apps/server/src/api/file-share-routes.ts:21` | hosted full suite / module compatibility |
| GET | `/api/health` | yes | no | `apps/server/src/observability.ts:118` | `zakurabot-channel.test.ts`, `socket-gateway.test.ts` |
| GET | `/api/instances` | yes | yes | `apps/server/src/api/routes.ts:1342` | `instance-tools.test.ts`, `mcp-stdio-route-lifecycle.test.ts` |
| POST | `/api/instances` | yes | yes | `apps/server/src/api/routes.ts:1383` | `instance-tools.test.ts`, `mcp-stdio-route-lifecycle.test.ts` |
| DELETE | `/api/instances/{id}` | yes | no | `apps/server/src/api/routes.ts:1485` | hosted full suite / module compatibility |
| GET | `/api/instances/{id}` | yes | no | `apps/server/src/api/routes.ts:1501` | hosted full suite / module compatibility |
| PATCH | `/api/instances/{id}` | yes | no | `apps/server/src/api/routes.ts:1648` | hosted full suite / module compatibility |
| GET | `/api/instances/{id}/containers/{containerId}/logs` | yes | no | `apps/server/src/api/routes.ts:1705` | hosted full suite / module compatibility |
| POST | `/api/instances/{id}/migrations` | yes | no | `apps/server/src/api/connection-routes.ts:181` | hosted full suite / module compatibility |
| POST | `/api/instances/{id}/rebuild` | yes | no | `apps/server/src/api/routes.ts:1470` | hosted full suite / module compatibility |
| GET | `/api/instances/{id}/runtime` | yes | no | `apps/server/src/api/routes.ts:1679` | hosted full suite / module compatibility |
| POST | `/api/instances/{id}/start` | yes | no | `apps/server/src/api/routes.ts:1430` | hosted full suite / module compatibility |
| POST | `/api/instances/{id}/stop` | yes | no | `apps/server/src/api/routes.ts:1445` | hosted full suite / module compatibility |
| GET | `/api/instances/{id}/tools` | yes | no | `apps/server/src/api/mcp-routes.ts:129` | hosted full suite / module compatibility |
| PATCH | `/api/instances/{id}/tools/{toolName}` | yes | no | `apps/server/src/api/mcp-routes.ts:164` | hosted full suite / module compatibility |
| GET | `/api/instances/reconcile` | yes | no | `apps/server/src/api/routes.ts:1459` | hosted full suite / module compatibility |
| POST | `/api/instances/reconcile` | yes | no | `apps/server/src/api/routes.ts:1464` | hosted full suite / module compatibility |
| GET | `/api/integrations/packages` | yes | no | `apps/server/src/api/mcp-routes.ts:1631` | hosted full suite / module compatibility |
| GET | `/api/integrations/packages/{slug}` | yes | no | `apps/server/src/api/mcp-routes.ts:1636` | hosted full suite / module compatibility |
| GET | `/api/livez` | yes | no | `apps/server/src/observability.ts:119` | hosted full suite / module compatibility |
| POST | `/api/mcp/call` | yes | no | `apps/server/src/api/mcp-routes.ts:893` | hosted full suite / module compatibility |
| POST | `/api/mcp/complete` | yes | no | `apps/server/src/api/mcp-routes.ts:957` | hosted full suite / module compatibility |
| POST | `/api/mcp/google/provision` | yes | no | `apps/server/src/api/mcp-routes.ts:1673` | hosted full suite / module compatibility |
| GET | `/api/mcp/google/provision-guide` | yes | no | `apps/server/src/api/mcp-routes.ts:1644` | hosted full suite / module compatibility |
| POST | `/api/mcp/import` | yes | yes | `apps/server/src/api/mcp-routes.ts:442` | `mcp-stdio-route-lifecycle.test.ts` |
| POST | `/api/mcp/import-stdio` | yes | yes | `apps/server/src/api/mcp-routes.ts:1178` | `mcp-stdio-route-lifecycle.test.ts` |
| POST | `/api/mcp/import-vscode` | yes | no | `apps/server/src/api/mcp-routes.ts:798` | hosted full suite / module compatibility |
| GET | `/api/mcp/oauth-redirect-uri` | yes | no | `apps/server/src/api/mcp-routes.ts:1622` | hosted full suite / module compatibility |
| POST | `/api/mcp/parse-vscode` | yes | no | `apps/server/src/api/mcp-routes.ts:873` | hosted full suite / module compatibility |
| GET | `/api/mcp/policies` | yes | yes | `apps/server/src/api/mcp-routes.ts:267` | hosted full suite / module compatibility |
| POST | `/api/mcp/policies` | yes | yes | `apps/server/src/api/mcp-routes.ts:300` | hosted full suite / module compatibility |
| DELETE | `/api/mcp/policies/{id}` | yes | yes | `apps/server/src/api/mcp-routes.ts:410` | hosted full suite / module compatibility |
| PUT | `/api/mcp/policies/{id}` | yes | yes | `apps/server/src/api/mcp-routes.ts:350` | hosted full suite / module compatibility |
| GET | `/api/mcp/policies/bootstrap` | yes | yes | `apps/server/src/api/mcp-routes.ts:212` | hosted full suite / module compatibility |
| POST | `/api/mcp/probe` | yes | no | `apps/server/src/api/mcp-routes.ts:422` | hosted full suite / module compatibility |
| POST | `/api/mcp/prompts/get` | yes | no | `apps/server/src/api/mcp-routes.ts:935` | hosted full suite / module compatibility |
| POST | `/api/mcp/resources/read` | yes | no | `apps/server/src/api/mcp-routes.ts:920` | hosted full suite / module compatibility |
| POST | `/api/mcp/store/install` | yes | no | `apps/server/src/api/mcp-routes.ts:1088` | hosted full suite / module compatibility |
| GET | `/api/mcp/store/search` | yes | no | `apps/server/src/api/mcp-routes.ts:1067` | `mcp-catalog-routes.test.ts` |
| GET | `/api/mcp/store/servers/{name}` | yes | no | `apps/server/src/api/mcp-routes.ts:1078` | hosted full suite / module compatibility |
| GET | `/api/mcp/store/sources` | yes | no | `apps/server/src/api/mcp-routes.ts:993` | `mcp-catalog-routes.test.ts` |
| POST | `/api/mcp/store/sources` | yes | no | `apps/server/src/api/mcp-routes.ts:998` | `mcp-catalog-routes.test.ts` |
| DELETE | `/api/mcp/store/sources/{id}` | yes | no | `apps/server/src/api/mcp-routes.ts:1027` | hosted full suite / module compatibility |
| POST | `/api/mcp/store/sync` | yes | yes | `apps/server/src/api/mcp-routes.ts:1033` | `mcp-catalog-routes.test.ts` |
| GET | `/api/mcp/tools` | yes | no | `apps/server/src/api/mcp-routes.ts:123` | hosted full suite / module compatibility |
| POST | `/api/mcp/upstream-oauth/authorize` | yes | no | `apps/server/src/api/mcp-routes.ts:1453` | hosted full suite / module compatibility |
| GET | `/api/mcp/upstream-oauth/callback` | yes | yes | `apps/server/src/api/mcp-routes.ts:1498` | `google-cloud-provision.test.ts`, `mcp-upstream-oauth-security.test.ts` |
| POST | `/api/mcp/upstream-oauth/start` | yes | yes | `apps/server/src/api/mcp-routes.ts:1268` | hosted full suite / module compatibility |
| POST | `/api/mcp/upstream-oauth/verify` | yes | no | `apps/server/src/api/mcp-routes.ts:1604` | hosted full suite / module compatibility |
| GET | `/api/me` | yes | yes | `apps/server/src/api/routes.ts:948` | `identity-session-routes.test.ts`, `identity-enterprise-policy.test.ts`, `content-admin-routes.test.ts` |
| PATCH | `/api/me` | yes | yes | `apps/server/src/api/identity-routes.ts:520` | `identity-session-routes.test.ts`, `identity-enterprise-policy.test.ts`, `content-admin-routes.test.ts` |
| DELETE | `/api/me/avatar` | yes | yes | `apps/server/src/api/identity-routes.ts:558` | hosted full suite / module compatibility |
| POST | `/api/me/avatar` | yes | yes | `apps/server/src/api/identity-routes.ts:546` | hosted full suite / module compatibility |
| GET | `/api/me/mfa` | yes | no | `apps/server/src/api/identity-routes.ts:631` | `identity-enterprise-policy.test.ts` |
| POST | `/api/me/mfa/totp/cancel` | yes | no | `apps/server/src/api/identity-routes.ts:657` | hosted full suite / module compatibility |
| POST | `/api/me/mfa/totp/disable` | yes | no | `apps/server/src/api/identity-routes.ts:680` | `identity-enterprise-policy.test.ts` |
| POST | `/api/me/mfa/totp/enable` | yes | no | `apps/server/src/api/identity-routes.ts:664` | hosted full suite / module compatibility |
| POST | `/api/me/mfa/totp/recovery` | yes | no | `apps/server/src/api/identity-routes.ts:706` | hosted full suite / module compatibility |
| POST | `/api/me/mfa/totp/start` | yes | no | `apps/server/src/api/identity-routes.ts:645` | hosted full suite / module compatibility |
| DELETE | `/api/me/mfa/webauthn/{id}` | yes | no | `apps/server/src/api/identity-routes.ts:752` | hosted full suite / module compatibility |
| PATCH | `/api/me/mfa/webauthn/{id}` | yes | no | `apps/server/src/api/identity-routes.ts:745` | hosted full suite / module compatibility |
| POST | `/api/me/mfa/webauthn/register` | yes | no | `apps/server/src/api/identity-routes.ts:729` | hosted full suite / module compatibility |
| POST | `/api/me/mfa/webauthn/register/options` | yes | no | `apps/server/src/api/identity-routes.ts:722` | hosted full suite / module compatibility |
| POST | `/api/me/password` | yes | no | `apps/server/src/api/identity-routes.ts:578` | hosted full suite / module compatibility |
| GET | `/api/me/sessions` | yes | yes | `apps/server/src/api/identity-routes.ts:604` | hosted full suite / module compatibility |
| DELETE | `/api/me/sessions/{id}` | yes | yes | `apps/server/src/api/identity-routes.ts:610` | hosted full suite / module compatibility |
| POST | `/api/me/sessions/revoke-others` | yes | no | `apps/server/src/api/identity-routes.ts:624` | hosted full suite / module compatibility |
| POST | `/api/me/verify-email` | yes | yes | `apps/server/src/api/identity-routes.ts:595` | hosted full suite / module compatibility |
| GET | `/api/memory-providers` | yes | yes | `apps/server/src/api/memory-routes.ts:47` | `content-admin-routes.test.ts` |
| POST | `/api/memory-providers` | yes | yes | `apps/server/src/api/memory-routes.ts:61` | `content-admin-routes.test.ts` |
| DELETE | `/api/memory-providers/{id}` | yes | no | `apps/server/src/api/memory-routes.ts:112` | hosted full suite / module compatibility |
| GET | `/api/memory-providers/{id}` | yes | no | `apps/server/src/api/memory-routes.ts:89` | hosted full suite / module compatibility |
| PATCH | `/api/memory-providers/{id}` | yes | no | `apps/server/src/api/memory-routes.ts:96` | hosted full suite / module compatibility |
| POST | `/api/memory-providers/{id}/health` | yes | no | `apps/server/src/api/memory-routes.ts:123` | hosted full suite / module compatibility |
| GET | `/api/memory-providers/meta` | yes | no | `apps/server/src/api/memory-routes.ts:43` | hosted full suite / module compatibility |
| GET | `/api/metrics` | yes | no | `apps/server/src/observability.ts:122` | hosted full suite / module compatibility |
| GET | `/api/migrations/{jobId}` | yes | yes | `apps/server/src/api/migration-routes.ts:50` | hosted full suite / module compatibility |
| GET | `/api/migrations/{jobId}/events` | yes | yes | `apps/server/src/api/migration-routes.ts:57` | hosted full suite / module compatibility |
| POST | `/api/model-catalog/import` | yes | no | `apps/server/src/api/model-router-routes.ts:611` | hosted full suite / module compatibility |
| GET | `/api/model-catalog/match` | yes | no | `apps/server/src/api/model-router-routes.ts:584` | hosted full suite / module compatibility |
| POST | `/api/model-catalog/refresh` | yes | no | `apps/server/src/api/model-router-routes.ts:597` | hosted full suite / module compatibility |
| POST | `/api/model-router/chat` | yes | no | `apps/server/src/api/model-router-routes.ts:685` | hosted full suite / module compatibility |
| POST | `/api/model-router/embed` | yes | no | `apps/server/src/api/model-router-routes.ts:627` | hosted full suite / module compatibility |
| POST | `/api/model-router/image` | yes | no | `apps/server/src/api/model-router-routes.ts:826` | hosted full suite / module compatibility |
| GET | `/api/model-router/meta` | yes | no | `apps/server/src/api/model-router-routes.ts:42` | hosted full suite / module compatibility |
| POST | `/api/model-router/rerank` | yes | no | `apps/server/src/api/model-router-routes.ts:655` | hosted full suite / module compatibility |
| GET | `/api/model-routes` | yes | yes | `apps/server/src/api/model-router-routes.ts:371` | hosted full suite / module compatibility |
| POST | `/api/model-routes` | yes | yes | `apps/server/src/api/model-router-routes.ts:403` | hosted full suite / module compatibility |
| DELETE | `/api/model-routes/{id}` | yes | no | `apps/server/src/api/model-router-routes.ts:559` | hosted full suite / module compatibility |
| GET | `/api/model-routes/{id}` | yes | no | `apps/server/src/api/model-router-routes.ts:477` | hosted full suite / module compatibility |
| PATCH | `/api/model-routes/{id}` | yes | no | `apps/server/src/api/model-router-routes.ts:496` | hosted full suite / module compatibility |
| GET | `/api/model-upstreams` | yes | yes | `apps/server/src/api/model-router-routes.ts:59` | hosted full suite / module compatibility |
| POST | `/api/model-upstreams` | yes | yes | `apps/server/src/api/model-router-routes.ts:65` | hosted full suite / module compatibility |
| DELETE | `/api/model-upstreams/{id}` | yes | yes | `apps/server/src/api/model-router-routes.ts:113` | hosted full suite / module compatibility |
| GET | `/api/model-upstreams/{id}` | yes | yes | `apps/server/src/api/model-router-routes.ts:90` | hosted full suite / module compatibility |
| PATCH | `/api/model-upstreams/{id}` | yes | yes | `apps/server/src/api/model-router-routes.ts:97` | hosted full suite / module compatibility |
| POST | `/api/model-upstreams/{id}/auth/cancel` | yes | no | `apps/server/src/api/model-router-routes.ts:188` | hosted full suite / module compatibility |
| POST | `/api/model-upstreams/{id}/auth/logout` | yes | yes | `apps/server/src/api/model-router-routes.ts:198` | hosted full suite / module compatibility |
| POST | `/api/model-upstreams/{id}/auth/poll` | yes | yes | `apps/server/src/api/model-router-routes.ts:149` | hosted full suite / module compatibility |
| POST | `/api/model-upstreams/{id}/auth/start` | yes | yes | `apps/server/src/api/model-router-routes.ts:140` | hosted full suite / module compatibility |
| POST | `/api/model-upstreams/{id}/auth/submit` | yes | no | `apps/server/src/api/model-router-routes.ts:166` | hosted full suite / module compatibility |
| POST | `/api/model-upstreams/{id}/health` | yes | no | `apps/server/src/api/model-router-routes.ts:210` | hosted full suite / module compatibility |
| GET | `/api/model-upstreams/{id}/models` | yes | no | `apps/server/src/api/model-router-routes.ts:221` | hosted full suite / module compatibility |
| POST | `/api/model-upstreams/{id}/sync-models` | yes | no | `apps/server/src/api/model-router-routes.ts:233` | hosted full suite / module compatibility |
| POST | `/api/model-upstreams/batch-delete` | yes | no | `apps/server/src/api/model-router-routes.ts:124` | hosted full suite / module compatibility |
| GET | `/api/oauth/authorize-info` | yes | yes | `apps/server/src/api/routes.ts:1047` | `oauth-login-flow.test.ts` |
| GET | `/api/oauth/clients` | yes | no | `apps/server/src/api/routes.ts:1032` | hosted full suite / module compatibility |
| POST | `/api/oauth/consent` | yes | yes | `apps/server/src/api/routes.ts:1107` | `oauth-login-flow.test.ts` |
| GET | `/api/otel/config` | yes | yes | `apps/server/src/api/otel-routes.ts:38` | `otel-ingest.test.ts` |
| POST | `/api/otel/v1/logs` | yes | yes | `apps/server/src/api/otel-routes.ts:48` | `otel-ingest.test.ts` |
| GET | `/api/platform` | yes | yes | `apps/server/src/api/routes.ts:699` | hosted full suite / module compatibility |
| GET | `/api/platform-services` | yes | yes | `apps/server/src/api/platform-service-routes.ts:40` | hosted full suite / module compatibility |
| GET | `/api/platform-services/{key}` | yes | yes | `apps/server/src/api/platform-service-routes.ts:120` | hosted full suite / module compatibility |
| PATCH | `/api/platform-services/{key}` | yes | yes | `apps/server/src/api/platform-service-routes.ts:189` | hosted full suite / module compatibility |
| POST | `/api/platform-services/{key}/${action}` | yes | no | `apps/server/src/api/platform-service-routes.ts:281` | hosted full suite / module compatibility |
| POST | `/api/platform-services/{key}/connect` | yes | no | `apps/server/src/api/platform-service-routes.ts:245` | hosted full suite / module compatibility |
| POST | `/api/platform-services/{key}/deploy` | yes | no | `apps/server/src/api/platform-service-routes.ts:229` | hosted full suite / module compatibility |
| GET | `/api/platform-services/{key}/diagnostics` | yes | no | `apps/server/src/api/platform-service-routes.ts:169` | hosted full suite / module compatibility |
| POST | `/api/platform-services/{key}/disable` | yes | no | `apps/server/src/api/platform-service-routes.ts:264` | hosted full suite / module compatibility |
| GET | `/api/platform-services/{key}/logs` | yes | no | `apps/server/src/api/platform-service-routes.ts:148` | hosted full suite / module compatibility |
| GET | `/api/platform-services/{key}/progress` | yes | no | `apps/server/src/api/platform-service-routes.ts:136` | hosted full suite / module compatibility |
| GET | `/api/platform-services/meta/quotas` | yes | no | `apps/server/src/api/platform-service-routes.ts:56` | hosted full suite / module compatibility |
| PUT | `/api/platform-services/meta/quotas` | yes | no | `apps/server/src/api/platform-service-routes.ts:67` | hosted full suite / module compatibility |
| GET | `/api/platform-services/meta/usage` | yes | no | `apps/server/src/api/platform-service-routes.ts:96` | hosted full suite / module compatibility |
| GET | `/api/providers` | yes | yes | `apps/server/src/api/routes.ts:1152` | hosted full suite / module compatibility |
| GET | `/api/ready` | yes | no | `apps/server/src/observability.ts:120` | hosted full suite / module compatibility |
| GET | `/api/readyz` | yes | no | `apps/server/src/observability.ts:121` | hosted full suite / module compatibility |
| GET | `/api/remote-channels` | yes | yes | `apps/server/src/api/routes.ts:2829` | `remote-channel-lifecycle.test.ts` |
| POST | `/api/remote-channels` | yes | yes | `apps/server/src/api/routes.ts:2844` | `remote-channel-lifecycle.test.ts` |
| DELETE | `/api/remote-channels/{id}` | yes | yes | `apps/server/src/api/routes.ts:2934` | hosted full suite / module compatibility |
| PATCH | `/api/remote-channels/{id}` | yes | yes | `apps/server/src/api/routes.ts:2884` | hosted full suite / module compatibility |
| POST | `/api/remote-channels/{id}/access/approve` | yes | no | `apps/server/src/api/routes.ts:2949` | hosted full suite / module compatibility |
| POST | `/api/remote-channels/{id}/access/deny` | yes | no | `apps/server/src/api/routes.ts:2971` | hosted full suite / module compatibility |
| ALL | `/api/remote-channels/{tenantId}/{bindingId}/webhook` | yes | no | `apps/server/src/api/routes.ts:2993` | hosted full suite / module compatibility |
| POST | `/api/routines/{id}/hook` | yes | no | `apps/server/src/api/automation-routes.ts:284` | hosted full suite / module compatibility |
| GET | `/api/runtime-nodes` | yes | yes | `apps/server/src/api/runtime-node-routes.ts:223` | `runtime-node-connectivity.test.ts`, `runtime-node-delete.test.ts`, `agent-binaries.test.ts` |
| POST | `/api/runtime-nodes` | yes | yes | `apps/server/src/api/runtime-node-routes.ts:273` | `runtime-node-connectivity.test.ts`, `runtime-node-delete.test.ts`, `agent-binaries.test.ts` |
| DELETE | `/api/runtime-nodes/{id}` | yes | yes | `apps/server/src/api/runtime-node-routes.ts:840` | hosted full suite / module compatibility |
| GET | `/api/runtime-nodes/{id}` | yes | yes | `apps/server/src/api/runtime-node-routes.ts:560` | hosted full suite / module compatibility |
| PATCH | `/api/runtime-nodes/{id}` | yes | yes | `apps/server/src/api/runtime-node-routes.ts:820` | hosted full suite / module compatibility |
| GET | `/api/runtime-nodes/{id}/bootstrap.sh` | yes | no | `apps/server/src/api/runtime-node-routes.ts:426` | hosted full suite / module compatibility |
| GET | `/api/runtime-nodes/{id}/containers` | yes | no | `apps/server/src/api/runtime-node-routes.ts:572` | hosted full suite / module compatibility |
| POST | `/api/runtime-nodes/{id}/containers/allocate` | yes | no | `apps/server/src/api/runtime-node-routes.ts:587` | hosted full suite / module compatibility |
| GET | `/api/runtime-nodes/{id}/detail` | yes | no | `apps/server/src/api/runtime-node-routes.ts:482` | hosted full suite / module compatibility |
| POST | `/api/runtime-nodes/{id}/heartbeat` | yes | yes | `apps/server/src/api/runtime-node-routes.ts:198` | hosted full suite / module compatibility |
| GET | `/api/runtime-nodes/{id}/image-updates` | yes | no | `apps/server/src/api/runtime-node-routes.ts:792` | hosted full suite / module compatibility |
| GET | `/api/runtime-nodes/{id}/install` | yes | yes | `apps/server/src/api/runtime-node-routes.ts:440` | hosted full suite / module compatibility |
| GET | `/api/runtime-nodes/{id}/install.ps1` | yes | yes | `apps/server/src/api/runtime-node-routes.ts:360` | hosted full suite / module compatibility |
| GET | `/api/runtime-nodes/{id}/install.sh` | yes | yes | `apps/server/src/api/runtime-node-routes.ts:335` | hosted full suite / module compatibility |
| POST | `/api/runtime-nodes/{id}/refresh-workspace-image` | yes | no | `apps/server/src/api/runtime-node-routes.ts:751` | hosted full suite / module compatibility |
| GET | `/api/runtime-nodes/{id}/update-runner` | yes | no | `apps/server/src/api/runtime-node-routes.ts:670` | hosted full suite / module compatibility |
| POST | `/api/runtime-nodes/{id}/update-runner` | yes | no | `apps/server/src/api/runtime-node-routes.ts:685` | hosted full suite / module compatibility |
| GET | `/api/runtime-nodes/{id}/version` | yes | no | `apps/server/src/api/runtime-node-routes.ts:634` | hosted full suite / module compatibility |
| DELETE | `/api/runtime-nodes/{nodeId}/agents/{agentId}/workspace-residual` | yes | no | `apps/server/src/api/runtime-node-routes.ts:861` | hosted full suite / module compatibility |
| GET | `/api/runtime-nodes/agent-binaries/{os}/{arch}` | yes | no | `apps/server/src/api/runtime-node-routes.ts:385` | hosted full suite / module compatibility |
| GET | `/api/runtime-nodes/mesh-status` | yes | no | `apps/server/src/api/runtime-node-routes.ts:239` | hosted full suite / module compatibility |
| POST | `/api/runtime-nodes/register` | yes | yes | `apps/server/src/api/runtime-node-routes.ts:168` | hosted full suite / module compatibility |
| GET | `/api/runtime/docker` | yes | no | `apps/server/src/api/routes.ts:691` | hosted full suite / module compatibility |
| GET | `/api/settings` | yes | yes | `apps/server/src/api/routes.ts:3418` | hosted full suite / module compatibility |
| PUT | `/api/settings/{key}` | yes | yes | `apps/server/src/api/routes.ts:3473` | hosted full suite / module compatibility |
| GET | `/api/settings/email/transactional` | yes | yes | `apps/server/src/api/routes.ts:3445` | hosted full suite / module compatibility |
| PUT | `/api/settings/email/transactional` | yes | yes | `apps/server/src/api/routes.ts:3453` | hosted full suite / module compatibility |
| GET | `/api/settings/network/active-exposures` | yes | no | `apps/server/src/api/network-routes.ts:350` | hosted full suite / module compatibility |
| POST | `/api/settings/network/active-exposures/stop-all` | yes | no | `apps/server/src/api/network-routes.ts:364` | hosted full suite / module compatibility |
| GET | `/api/settings/network/audit` | yes | no | `apps/server/src/api/network-routes.ts:341` | hosted full suite / module compatibility |
| GET | `/api/settings/network/exposure/providers` | yes | no | `apps/server/src/api/network-routes.ts:266` | hosted full suite / module compatibility |
| PATCH | `/api/settings/network/exposure/providers/{id}` | yes | no | `apps/server/src/api/network-routes.ts:272` | hosted full suite / module compatibility |
| POST | `/api/settings/network/exposure/providers/{id}/test` | yes | no | `apps/server/src/api/network-routes.ts:289` | hosted full suite / module compatibility |
| POST | `/api/settings/network/exposure/providers/cloudflare-named/create-tunnel` | yes | no | `apps/server/src/api/network-routes.ts:250` | hosted full suite / module compatibility |
| GET | `/api/settings/network/headscale` | yes | no | `apps/server/src/api/network-routes.ts:55` | hosted full suite / module compatibility |
| PUT | `/api/settings/network/headscale` | yes | no | `apps/server/src/api/network-routes.ts:66` | hosted full suite / module compatibility |
| GET | `/api/settings/network/mesh` | yes | no | `apps/server/src/api/network-routes.ts:99` | hosted full suite / module compatibility |
| POST | `/api/settings/network/mesh/acl/ensure-tags` | yes | no | `apps/server/src/api/network-routes.ts:176` | hosted full suite / module compatibility |
| POST | `/api/settings/network/mesh/auth-key` | yes | no | `apps/server/src/api/network-routes.ts:190` | hosted full suite / module compatibility |
| POST | `/api/settings/network/mesh/auth-key/generate` | yes | no | `apps/server/src/api/network-routes.ts:206` | hosted full suite / module compatibility |
| POST | `/api/settings/network/mesh/disconnect` | yes | no | `apps/server/src/api/network-routes.ts:228` | hosted full suite / module compatibility |
| POST | `/api/settings/network/mesh/oauth/connect` | yes | no | `apps/server/src/api/network-routes.ts:132` | hosted full suite / module compatibility |
| POST | `/api/settings/network/mesh/oauth/start` | yes | no | `apps/server/src/api/network-routes.ts:119` | hosted full suite / module compatibility |
| PATCH | `/api/settings/network/mesh/oauth/tags` | yes | no | `apps/server/src/api/network-routes.ts:160` | hosted full suite / module compatibility |
| POST | `/api/settings/network/mesh/platform/enable` | yes | no | `apps/server/src/api/network-routes.ts:105` | hosted full suite / module compatibility |
| POST | `/api/settings/network/mesh/sync` | yes | no | `apps/server/src/api/network-routes.ts:235` | hosted full suite / module compatibility |
| GET | `/api/settings/network/overview` | yes | yes | `apps/server/src/api/network-routes.ts:88` | hosted full suite / module compatibility |
| GET | `/api/settings/network/security` | yes | yes | `apps/server/src/api/network-routes.ts:303` | hosted full suite / module compatibility |
| PUT | `/api/settings/network/security` | yes | yes | `apps/server/src/api/network-routes.ts:309` | hosted full suite / module compatibility |
| POST | `/api/setup` | yes | yes | `apps/server/src/api/routes.ts:759` | hosted full suite / module compatibility |
| GET | `/api/skills` | yes | no | `apps/server/src/api/skill-routes.ts:264` | `content-admin-routes.test.ts` |
| DELETE | `/api/skills/{id}` | yes | no | `apps/server/src/api/skill-routes.ts:320` | hosted full suite / module compatibility |
| GET | `/api/skills/{id}` | yes | no | `apps/server/src/api/skill-routes.ts:301` | hosted full suite / module compatibility |
| PATCH | `/api/skills/{id}/auto-update` | yes | no | `apps/server/src/api/skill-routes.ts:171` | hosted full suite / module compatibility |
| POST | `/api/skills/{id}/update` | yes | no | `apps/server/src/api/skill-routes.ts:309` | hosted full suite / module compatibility |
| GET | `/api/skills/auto-update` | yes | no | `apps/server/src/api/skill-routes.ts:133` | hosted full suite / module compatibility |
| PUT | `/api/skills/auto-update` | yes | no | `apps/server/src/api/skill-routes.ts:143` | hosted full suite / module compatibility |
| GET | `/api/skills/cache` | yes | no | `apps/server/src/api/skill-routes.ts:121` | hosted full suite / module compatibility |
| POST | `/api/skills/check-updates` | yes | no | `apps/server/src/api/skill-routes.ts:158` | hosted full suite / module compatibility |
| POST | `/api/skills/install` | yes | no | `apps/server/src/api/skill-routes.ts:270` | hosted full suite / module compatibility |
| GET | `/api/skills/repos` | yes | no | `apps/server/src/api/skill-routes.ts:98` | hosted full suite / module compatibility |
| POST | `/api/skills/repos/{owner}/{repo}/sync` | yes | no | `apps/server/src/api/skill-routes.ts:108` | hosted full suite / module compatibility |
| POST | `/api/skills/resolve` | yes | no | `apps/server/src/api/skill-routes.ts:251` | hosted full suite / module compatibility |
| GET | `/api/skills/search` | yes | no | `apps/server/src/api/skill-routes.ts:75` | hosted full suite / module compatibility |
| GET | `/api/skills/stores` | yes | no | `apps/server/src/api/skill-routes.ts:60` | hosted full suite / module compatibility |
| GET | `/api/skills/tokens` | yes | no | `apps/server/src/api/skill-routes.ts:190` | `content-admin-routes.test.ts` |
| DELETE | `/api/skills/tokens/{provider}` | yes | no | `apps/server/src/api/skill-routes.ts:236` | hosted full suite / module compatibility |
| PUT | `/api/skills/tokens/{provider}` | yes | no | `apps/server/src/api/skill-routes.ts:205` | hosted full suite / module compatibility |
| GET | `/api/spaces` | yes | yes | `apps/server/src/api/routes.ts:1969` | `spaces-lifecycle-api.test.ts`, `spaces-api.test.ts`, `authenticated-agent-workflow.test.ts` |
| POST | `/api/spaces` | yes | yes | `apps/server/src/api/routes.ts:1990` | `spaces-lifecycle-api.test.ts`, `spaces-api.test.ts`, `authenticated-agent-workflow.test.ts` |
| DELETE | `/api/spaces/{id}` | yes | yes | `apps/server/src/api/routes.ts:2020` | hosted full suite / module compatibility |
| GET | `/api/spaces/{id}` | yes | yes | `apps/server/src/api/routes.ts:1982` | hosted full suite / module compatibility |
| PATCH | `/api/spaces/{id}` | yes | yes | `apps/server/src/api/routes.ts:2002` | hosted full suite / module compatibility |
| GET | `/api/spaces/{id}/graph` | yes | yes | `apps/server/src/api/routes.ts:2031` | hosted full suite / module compatibility |
| GET | `/api/system/image-updates` | yes | yes | `apps/server/src/api/routes.ts:3514` | hosted full suite / module compatibility |
| POST | `/api/system/image-updates/check` | yes | yes | `apps/server/src/api/routes.ts:3541` | hosted full suite / module compatibility |
| POST | `/api/system/image-updates/check-all` | yes | yes | `apps/server/src/api/routes.ts:3575` | hosted full suite / module compatibility |
| GET | `/api/tenant/audit` | yes | no | `apps/server/src/api/identity-routes.ts:944` | `identity-enterprise-policy.test.ts` |
| PUT | `/api/tenant/audit/retention` | yes | no | `apps/server/src/api/identity-routes.ts:993` | `identity-enterprise-policy.test.ts` |
| DELETE | `/api/tenant/current` | yes | yes | `apps/server/src/api/tenant-routes.ts:118` | hosted full suite / module compatibility |
| GET | `/api/tenant/current` | yes | yes | `apps/server/src/api/tenant-routes.ts:80` | hosted full suite / module compatibility |
| PATCH | `/api/tenant/current` | yes | yes | `apps/server/src/api/tenant-routes.ts:101` | hosted full suite / module compatibility |
| GET | `/api/tenant/identity/domains` | yes | yes | `apps/server/src/api/identity-routes.ts:801` | hosted full suite / module compatibility |
| POST | `/api/tenant/identity/domains` | yes | yes | `apps/server/src/api/identity-routes.ts:807` | hosted full suite / module compatibility |
| DELETE | `/api/tenant/identity/domains/{id}` | yes | no | `apps/server/src/api/identity-routes.ts:864` | hosted full suite / module compatibility |
| PATCH | `/api/tenant/identity/domains/{id}` | yes | no | `apps/server/src/api/identity-routes.ts:825` | hosted full suite / module compatibility |
| POST | `/api/tenant/identity/domains/{id}/verify` | yes | no | `apps/server/src/api/identity-routes.ts:848` | hosted full suite / module compatibility |
| GET | `/api/tenant/identity/mfa` | yes | yes | `apps/server/src/api/identity-routes.ts:771` | `identity-enterprise-policy.test.ts` |
| PUT | `/api/tenant/identity/mfa` | yes | yes | `apps/server/src/api/identity-routes.ts:777` | `identity-enterprise-policy.test.ts` |
| GET | `/api/tenant/identity/scim` | yes | yes | `apps/server/src/api/identity-routes.ts:900` | hosted full suite / module compatibility |
| POST | `/api/tenant/identity/scim/tokens` | yes | yes | `apps/server/src/api/identity-routes.ts:909` | hosted full suite / module compatibility |
| DELETE | `/api/tenant/identity/scim/tokens/{id}` | yes | no | `apps/server/src/api/identity-routes.ts:932` | hosted full suite / module compatibility |
| PATCH | `/api/tenant/identity/scim/tokens/{id}` | yes | no | `apps/server/src/api/identity-routes.ts:922` | hosted full suite / module compatibility |
| GET | `/api/tenant/identity/sso` | yes | yes | `apps/server/src/api/identity-routes.ts:877` | hosted full suite / module compatibility |
| PUT | `/api/tenant/identity/sso` | yes | yes | `apps/server/src/api/identity-routes.ts:885` | hosted full suite / module compatibility |
| GET | `/api/tenant/onboarding` | yes | yes | `apps/server/src/api/tenant-routes.ts:150` | hosted full suite / module compatibility |
| PATCH | `/api/tenant/onboarding` | yes | yes | `apps/server/src/api/tenant-routes.ts:160` | hosted full suite / module compatibility |
| POST | `/api/tenant/onboarding/bootstrap` | yes | yes | `apps/server/src/api/tenant-routes.ts:192` | hosted full suite / module compatibility |
| POST | `/api/tenant/onboarding/complete` | yes | no | `apps/server/src/api/tenant-routes.ts:175` | hosted full suite / module compatibility |
| GET | `/api/tenant/people` | yes | no | `apps/server/src/api/identity-routes.ts:532` | hosted full suite / module compatibility |
| GET | `/api/tenant/people/{id}` | yes | no | `apps/server/src/api/identity-routes.ts:538` | hosted full suite / module compatibility |
| GET | `/api/tenants` | yes | yes | `apps/server/src/api/tenant-routes.ts:66` | hosted full suite / module compatibility |
| GET | `/api/tool-calls` | yes | yes | `apps/server/src/api/routes.ts:3290` | `tool-call-store.test.ts` |
| GET | `/api/tool-calls/{id}` | yes | no | `apps/server/src/api/routes.ts:3304` | hosted full suite / module compatibility |
| GET | `/api/tool-calls/stats` | yes | no | `apps/server/src/api/routes.ts:3297` | `tool-call-store.test.ts` |
| GET | `/api/upstream-models` | yes | no | `apps/server/src/api/model-router-routes.ts:254` | hosted full suite / module compatibility |
| POST | `/api/upstream-models` | yes | no | `apps/server/src/api/model-router-routes.ts:271` | hosted full suite / module compatibility |
| DELETE | `/api/upstream-models/{id}` | yes | no | `apps/server/src/api/model-router-routes.ts:343` | hosted full suite / module compatibility |
| PATCH | `/api/upstream-models/{id}` | yes | no | `apps/server/src/api/model-router-routes.ts:311` | hosted full suite / module compatibility |
| POST | `/api/upstream-models/batch-delete` | yes | no | `apps/server/src/api/model-router-routes.ts:354` | hosted full suite / module compatibility |
| GET | `/api/usage/me` | yes | yes | `apps/server/src/api/usage-routes.ts:46` | `identity-enterprise-policy.test.ts` |
| GET | `/api/usage/users` | yes | yes | `apps/server/src/api/usage-routes.ts:67` | `identity-enterprise-policy.test.ts` |
| GET | `/api/usage/users/{userId}` | yes | no | `apps/server/src/api/usage-routes.ts:90` | hosted full suite / module compatibility |
| GET | `/api/users/{id}/avatar` | yes | no | `apps/server/src/api/identity-routes.ts:565` | hosted full suite / module compatibility |
| GET | `/api/zakurabot/ws` | yes | yes | `apps/server/src/api/routes.ts:2764` | `zakurabot-channel.test.ts` |
| GET | `/authorize` | yes | yes | `apps/server/src/oauth/http.ts:137` | `identity-tenant-lifecycle.test.ts`, `integration-catalog.test.ts`, `mcp-upstream-oauth-security.test.ts` |
| GET | `/health` | yes | yes | `apps/server/src/mcp/stdio-bridge.ts:176` | `zakurabot-channel.test.ts`, `model-upstream-admin-lifecycle.test.ts`, `socket-gateway.test.ts` |
| GET | `/healthz` | yes | no | `apps/server/src/observability.ts:115` | hosted full suite / module compatibility |
| GET | `/livez` | yes | no | `apps/server/src/observability.ts:114` | `observability.test.ts` |
| ALL | `/mcp` | yes | yes | `apps/server/src/index.ts:422` | `instance-tools.test.ts`, `identity-session-routes.test.ts`, `acp-mcp-gateway.test.ts` |
| ALL | `/mcp/*` | yes | no | `apps/server/src/index.ts:423` | hosted full suite / module compatibility |
| GET | `/metrics` | yes | no | `apps/server/src/observability.ts:117` | `observability.test.ts` |
| GET | `/oauth/authorize` | yes | yes | `apps/server/src/oauth/http.ts:138` | `model-upstream-auth.test.ts`, `oauth-login-flow.test.ts` |
| GET | `/oauth/discovery` | yes | no | `apps/server/src/oauth/http.ts:229` | hosted full suite / module compatibility |
| GET | `/oauth/jwks` | yes | yes | `apps/server/src/oauth/http.ts:80` | hosted full suite / module compatibility |
| POST | `/oauth/register` | yes | yes | `apps/server/src/oauth/http.ts:130` | `oauth-cimd.test.ts`, `oauth-login-flow.test.ts`, `oauth-token-replay-concurrency.test.ts` |
| POST | `/oauth/token` | yes | no | `apps/server/src/oauth/http.ts:178` | `oauth-login-flow.test.ts`, `oauth-token-replay-concurrency.test.ts` |
| GET | `/oauth/userinfo` | yes | no | `apps/server/src/oauth/http.ts:226` | hosted full suite / module compatibility |
| POST | `/oauth/userinfo` | yes | no | `apps/server/src/oauth/http.ts:227` | hosted full suite / module compatibility |
| GET | `/readyz` | yes | no | `apps/server/src/observability.ts:116` | `observability.test.ts` |
| POST | `/register` | yes | yes | `apps/server/src/oauth/http.ts:129` | `identity-tenant-lifecycle.test.ts`, `oauth-cimd.test.ts`, `mcp-upstream-oauth-security.test.ts` |
| GET | `/scim/v2/Groups` | yes | yes | `apps/server/src/api/scim-routes.ts:156` | `identity-tenant-lifecycle.test.ts` |
| PATCH | `/scim/v2/Groups/{id}` | yes | no | `apps/server/src/api/scim-routes.ts:166` | hosted full suite / module compatibility |
| GET | `/scim/v2/ServiceProviderConfig` | yes | yes | `apps/server/src/api/scim-routes.ts:41` | hosted full suite / module compatibility |
| GET | `/scim/v2/Users` | yes | yes | `apps/server/src/api/scim-routes.ts:50` | `identity-tenant-lifecycle.test.ts` |
| POST | `/scim/v2/Users` | yes | yes | `apps/server/src/api/scim-routes.ts:76` | `identity-tenant-lifecycle.test.ts` |
| DELETE | `/scim/v2/Users/{id}` | yes | no | `apps/server/src/api/scim-routes.ts:140` | hosted full suite / module compatibility |
| GET | `/scim/v2/Users/{id}` | yes | no | `apps/server/src/api/scim-routes.ts:66` | hosted full suite / module compatibility |
| PATCH | `/scim/v2/Users/{id}` | yes | no | `apps/server/src/api/scim-routes.ts:117` | hosted full suite / module compatibility |
| PUT | `/scim/v2/Users/{id}` | yes | no | `apps/server/src/api/scim-routes.ts:94` | hosted full suite / module compatibility |
| POST | `/token` | yes | yes | `apps/server/src/oauth/http.ts:177` | `oauth-login-flow.test.ts`, `oauth-token-replay-concurrency.test.ts` |
| POST | `/token/revoke` | yes | no | `apps/server/src/oauth/http.ts:180` | hosted full suite / module compatibility |
| GET | `/userinfo` | yes | yes | `apps/server/src/oauth/http.ts:224` | `oauth-cimd.test.ts`, `identity-enterprise-policy.test.ts` |
| POST | `/userinfo` | yes | yes | `apps/server/src/oauth/http.ts:225` | `oauth-cimd.test.ts`, `identity-enterprise-policy.test.ts` |
| POST | `/v1/chat/completions` | yes | no | `apps/server/src/api/openai-gateway-routes.ts:572` | `gateway-key-catalog-lifecycle.test.ts` |
| POST | `/v1/messages` | yes | no | `apps/server/src/api/openai-gateway-routes.ts:820` | hosted full suite / module compatibility |
| GET | `/v1/models` | yes | yes | `apps/server/src/api/openai-gateway-routes.ts:171` | `openai-gateway.test.ts`, `model-router.test.ts`, `gateway-key-catalog-lifecycle.test.ts` |
| POST | `/v1/responses` | yes | no | `apps/server/src/api/openai-gateway-routes.ts:244` | hosted full suite / module compatibility |
| DELETE | `/api/admin/oauth-clients/{direction}/{id}` | yes | yes | `packages/saas/src/server/routes.ts` | dynamically loaded SaaS route |
| DELETE | `/api/admin/tenants/{id}` | yes | no | `packages/saas/src/server/admin-routes.ts` | dynamically loaded SaaS route |
| DELETE | `/api/admin/tenants/{id}/members/{membershipId}` | yes | no | `packages/saas/src/server/admin-routes.ts` | dynamically loaded SaaS route |
| DELETE | `/api/admin/users/{id}` | yes | no | `packages/saas/src/server/admin-routes.ts` | dynamically loaded SaaS route |
| DELETE | `/api/tenant/invites/{id}` | yes | no | `packages/saas/src/server/routes.ts` | dynamically loaded SaaS route |
| DELETE | `/api/tenant/members/{id}` | yes | no | `packages/saas/src/server/routes.ts` | dynamically loaded SaaS route |
| GET | `/api/admin/agent-defaults` | yes | no | `packages/saas/src/server/routes.ts` | dynamically loaded SaaS route |
| GET | `/api/admin/oauth-clients` | yes | yes | `packages/saas/src/server/routes.ts` | dynamically loaded SaaS route |
| GET | `/api/admin/oauth/providers` | yes | no | `packages/saas/src/server/routes.ts` | dynamically loaded SaaS route |
| GET | `/api/admin/oauth/{provider}` | yes | yes | `packages/saas/src/server/routes.ts` | dynamically loaded SaaS route |
| GET | `/api/admin/platform` | yes | yes | `packages/saas/src/server/routes.ts` | dynamically loaded SaaS route |
| GET | `/api/admin/runners` | yes | yes | `packages/saas/src/server/admin-routes.ts` | dynamically loaded SaaS route |
| GET | `/api/admin/stats` | yes | yes | `packages/saas/src/server/admin-routes.ts` | dynamically loaded SaaS route |
| GET | `/api/admin/tenants` | yes | yes | `packages/saas/src/server/admin-routes.ts` | dynamically loaded SaaS route |
| GET | `/api/admin/tenants/{id}` | yes | no | `packages/saas/src/server/admin-routes.ts` | dynamically loaded SaaS route |
| GET | `/api/admin/users` | yes | yes | `packages/saas/src/server/admin-routes.ts` | dynamically loaded SaaS route |
| GET | `/api/admin/users/{id}` | yes | no | `packages/saas/src/server/admin-routes.ts` | dynamically loaded SaaS route |
| GET | `/api/auth/oauth/{provider}` | yes | yes | `packages/saas/src/server/routes.ts` | dynamically loaded SaaS route |
| GET | `/api/invites/{token}` | yes | yes | `packages/saas/src/server/routes.ts` | dynamically loaded SaaS route |
| GET | `/api/tenant/invites` | yes | yes | `packages/saas/src/server/routes.ts` | dynamically loaded SaaS route |
| GET | `/api/tenant/members` | yes | yes | `packages/saas/src/server/routes.ts` | dynamically loaded SaaS route |
| PATCH | `/api/admin/platform` | yes | yes | `packages/saas/src/server/routes.ts` | dynamically loaded SaaS route |
| PATCH | `/api/admin/runners/{id}` | yes | yes | `packages/saas/src/server/admin-routes.ts` | dynamically loaded SaaS route |
| PATCH | `/api/admin/tenants/{id}` | yes | no | `packages/saas/src/server/admin-routes.ts` | dynamically loaded SaaS route |
| PATCH | `/api/admin/tenants/{id}/members/{membershipId}` | yes | no | `packages/saas/src/server/admin-routes.ts` | dynamically loaded SaaS route |
| PATCH | `/api/admin/users/{id}` | yes | no | `packages/saas/src/server/admin-routes.ts` | dynamically loaded SaaS route |
| PATCH | `/api/tenant/members/{id}` | yes | no | `packages/saas/src/server/routes.ts` | dynamically loaded SaaS route |
| POST | `/api/admin/tenants` | yes | yes | `packages/saas/src/server/admin-routes.ts` | dynamically loaded SaaS route |
| POST | `/api/admin/tenants/{id}/members` | yes | no | `packages/saas/src/server/admin-routes.ts` | dynamically loaded SaaS route |
| POST | `/api/admin/tenants/{id}/suspend` | yes | no | `packages/saas/src/server/admin-routes.ts` | dynamically loaded SaaS route |
| POST | `/api/admin/tenants/{id}/unsuspend` | yes | no | `packages/saas/src/server/admin-routes.ts` | dynamically loaded SaaS route |
| POST | `/api/admin/users` | yes | yes | `packages/saas/src/server/admin-routes.ts` | dynamically loaded SaaS route |
| POST | `/api/admin/users/{id}/agent-defaults/apply` | yes | no | `packages/saas/src/server/routes.ts` | dynamically loaded SaaS route |
| POST | `/api/admin/users/{id}/suspend` | yes | no | `packages/saas/src/server/admin-routes.ts` | dynamically loaded SaaS route |
| POST | `/api/admin/users/{id}/unsuspend` | yes | no | `packages/saas/src/server/admin-routes.ts` | dynamically loaded SaaS route |
| POST | `/api/auth/oauth/{provider}/callback` | yes | yes | `packages/saas/src/server/routes.ts` | dynamically loaded SaaS route |
| POST | `/api/auth/oauth/{provider}/start` | yes | yes | `packages/saas/src/server/routes.ts` | dynamically loaded SaaS route |
| POST | `/api/auth/register` | yes | yes | `packages/saas/src/server/routes.ts` | dynamically loaded SaaS route |
| POST | `/api/auth/switch-tenant` | yes | no | `packages/saas/src/server/routes.ts` | dynamically loaded SaaS route |
| POST | `/api/invites/{token}/accept` | yes | yes | `packages/saas/src/server/routes.ts` | dynamically loaded SaaS route |
| POST | `/api/tenant/invites` | yes | yes | `packages/saas/src/server/routes.ts` | dynamically loaded SaaS route |
| POST | `/api/tenant/leave` | yes | no | `packages/saas/src/server/routes.ts` | dynamically loaded SaaS route |
| POST | `/api/tenants` | yes | yes | `packages/saas/src/server/routes.ts` | dynamically loaded SaaS route |
| PUT | `/api/admin/agent-defaults` | yes | no | `packages/saas/src/server/routes.ts` | dynamically loaded SaaS route |
| PUT | `/api/admin/oauth/login-policy` | yes | yes | `packages/saas/src/server/routes.ts` | dynamically loaded SaaS route |
| PUT | `/api/admin/oauth/{provider}` | yes | yes | `packages/saas/src/server/routes.ts` | dynamically loaded SaaS route |
| DELETE | `/api/zakurabot/agents/{id}/messages/{messageId}/reactions` | yes | no | `apps/server/src/api/zakurabot-app-routes.ts` | mounted subrouter route omitted by literal manifest |
| GET | `/api/zakurabot/agents` | yes | yes | `apps/server/src/api/zakurabot-app-routes.ts` | mounted subrouter route omitted by literal manifest |
| GET | `/api/zakurabot/agents/{id}` | yes | no | `apps/server/src/api/zakurabot-app-routes.ts` | mounted subrouter route omitted by literal manifest |
| GET | `/api/zakurabot/agents/{id}/desktop` | yes | no | `apps/server/src/api/zakurabot-app-routes.ts` | mounted subrouter route omitted by literal manifest |
| GET | `/api/zakurabot/agents/{id}/desktop/frame` | yes | no | `apps/server/src/api/zakurabot-app-routes.ts` | mounted subrouter route omitted by literal manifest |
| GET | `/api/zakurabot/agents/{id}/files/{fileId}` | yes | no | `apps/server/src/api/zakurabot-app-routes.ts` | mounted subrouter route omitted by literal manifest |
| GET | `/api/zakurabot/agents/{id}/history` | yes | no | `apps/server/src/api/zakurabot-app-routes.ts` | mounted subrouter route omitted by literal manifest |
| GET | `/api/zakurabot/agents/{id}/interactions` | yes | no | `apps/server/src/api/zakurabot-app-routes.ts` | mounted subrouter route omitted by literal manifest |
| GET | `/api/zakurabot/agents/{id}/interactions/{messageId}` | yes | no | `apps/server/src/api/zakurabot-app-routes.ts` | mounted subrouter route omitted by literal manifest |
| GET | `/api/zakurabot/agents/{id}/messages/{messageId}/reactions` | yes | no | `apps/server/src/api/zakurabot-app-routes.ts` | mounted subrouter route omitted by literal manifest |
| GET | `/api/zakurabot/bots` | yes | yes | `apps/server/src/api/zakurabot-app-routes.ts` | mounted subrouter route omitted by literal manifest |
| GET | `/api/zakurabot/sessions/{agentId}` | yes | no | `apps/server/src/api/zakurabot-session-routes.ts` | mounted subrouter route omitted by literal manifest |
| GET | `/api/zakurabot/spaces` | yes | yes | `apps/server/src/api/zakurabot-app-routes.ts` | mounted subrouter route omitted by literal manifest |
| POST | `/api/zakurabot/agents/{id}/exec` | yes | no | `apps/server/src/api/zakurabot-app-routes.ts` | mounted subrouter route omitted by literal manifest |
| POST | `/api/zakurabot/agents/{id}/files` | yes | no | `apps/server/src/api/zakurabot-app-routes.ts` | mounted subrouter route omitted by literal manifest |
| POST | `/api/zakurabot/agents/{id}/interactions/{messageId}` | yes | no | `apps/server/src/api/zakurabot-app-routes.ts` | mounted subrouter route omitted by literal manifest |
| POST | `/api/zakurabot/agents/{id}/messages/{messageId}/reactions` | yes | no | `apps/server/src/api/zakurabot-app-routes.ts` | mounted subrouter route omitted by literal manifest |
| POST | `/api/zakurabot/sessions/{agentId}` | yes | no | `apps/server/src/api/zakurabot-session-routes.ts` | mounted subrouter route omitted by literal manifest |
