# Agent and model experiment campaigns

An experiment freezes a template version and one common parameter set. Up to 16 variants can choose real role→agent mappings and optional role→model selectors. Each variant receives a separate project with the same task graph and acceptance checks. Creation produces drafts; it does not capture source or start model calls.

`POST /api/project-campaigns` body `{name,sourceProjectId,templateId,templateVersion?:number,expectedTemplateRevision,baselineId,budget:Budget,parameters:Record<string,scalar>,variants:[{id,name,agentMapping:Record<string,string>,models?:Record<string,string>}]}` → Campaign (201).
`GET /api/project-campaigns?sourceProjectId=...` → `{items:Campaign[]}`.
`GET /{cid}` → `{campaign,comparison}`.
`POST /{cid}/provision` body `{expectedRevision}` retries provision of recorded, stable project IDs, without replacing existing projects.
`POST /{cid}/freeze` body `{expectedRevision,confirmation:"freeze",comment}` captures source once using a persisted operation identity and then copies that immutable CAS snapshot to each variant's project repository. Requires a real human session.
`POST /{cid}/inspect` body `{expectedRevision,comment}` reads durable runner receipts for unknown captures/copies and SQL run IDs for pending starts; it never repeats a capture or creates a new run. Requires a real human session.
`POST /{cid}/variants/{vid}/copy` body `{expectedRevision,comment}` initiates an as-yet unattempted CAS copy from the frozen source snapshot; requires a real human session. Unknown copies require inspect.
`POST /{cid}/variants/{vid}/start` body `{expectedRevision,confirmation:"start",comment}` durably reserves a single run identity, then starts that variant using its copied common snapshot and fixed project caps. Requires a real human session. Completed variants cannot start a second run.
`POST /{cid}/variants/{vid}/retry-start` accepts the same start body and explicitly retries a `start_unknown` reservation using its original run identity and frozen plan; it cannot allocate another run.
`POST /{cid}/control` body `{expectedRevision,action:"pause"|"resume"|"cancel",comment}` applies real existing engine controls one run at a time and returns `{campaign,results:[{variantId,runId,status,error?}]}`. Outcomes can be partial; they are audited. Requires a real human session.
`GET /{cid}/audit` → `{items:Audit[]}`.

Campaign: `{id,tenantId,spaceId,revision,status,definition:Definition,baseSnapshot?,captureState,captureOperationId?,captureError?,createdBy,createdAt,updatedAt}`. Definition `{name,sourceProjectId,templateId,templateVersion,baselineId,budget,reservedBudget,variants:Variant[]}`.
Variant `{id,name,project:Project,definitionHash,state,copyOperationId?,runId?,error?}`. States prepared/provisioned/copying/copy_unknown/copy_failed/ready/starting/start_unknown/start_failed/started. Campaign capture states unfrozen/capturing/unknown/ready/failed.

Tokens/model/tool/wall caps are positive and divided equally with floor rounding at creation; unused caps and remainder are not lent to other variants. Every child has maxConcurrent=1. A campaign starts at most budget.maxConcurrent active variant runs; paused or unresolved starts retain their reservation. Each variant may create exactly one run. Ordinary child-project edit/delete/start/fork/import-run endpoints reject these managed projects.

Comparison uses persisted run counters and snapshot-bound acceptance evidence. `chargedTokens` is the durable engine's budget accounting and includes conservative charges for lost/unknown provider responses; `providerReportedTokens` remains null unless separately evidenced. No monetary prices are invented. Acceptance rate is unknown until a terminal run has evidence for every required check. One variant run is one sample; the API does not present a probability or claim statistical significance. Agent/model differences are disclosed; any other execution or acceptance difference makes the comparison non-comparable.

The immutable grant freezes the local task graph, prompts, checks, agent IDs, model selectors and fixed caps. Agent configuration, available tools, gateway routing and provider model versions remain live execution dependencies; their external versions are not frozen and the actually resolved provider model identity is unknown in comparison output. Operators should keep those settings stable when interpreting a trial.

`elapsedSeconds` is observed wall time from run creation through its latest persisted update for a terminal run, or through the comparison observation time for a live run. It includes queue and paused time; a separate worker-active duration or terminal transition timestamp is not inferred. Verification selection uses the latest record for each actual task and its current immutable snapshot; invalid newer proof never falls back to an older passing proof.

An interrupted start with no committed SQL run is recorded as `start_unknown` on inspect. Pause/resume reports `not_started` for such an identity and retains its fixed grant; a human must explicitly retry the original identity after resume. Cancellation records `cancelled_without_run`, preserves the reserved identity for audit, and fences any late caller from inserting that run.
