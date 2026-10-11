# Project workbench

The workbench extends the durable executor described in [PROJECT_EXECUTION.md](PROJECT_EXECUTION.md). Open **Long-running projects**, **Project blueprints**, **Portfolio scheduling**, or **Project reviews** in the dashboard. Every resource belongs to a tenant; a project also fixes its space and runner repository.

## Reusable blueprints

A blueprint is a versioned project definition with named Agent roles and typed parameters. Supported parameter types include strings, integers, booleans, enums and safe relative paths. Parameter constraints, task conditions and bounded matrix axes expand into a validated project DAG. Matrix dependencies can match shared axes, so a locale-specific review depends on its own locale's implementation.

The preview endpoint validates the expanded plan, writable claims and Agent mappings without creating projects or starting a model. Instantiate an exact immutable version to create a draft project. A role must map to a real Agent in the selected tenant and space. Updating or archiving the blueprint leaves earlier versions and already instantiated projects intact.

Blueprint documents use `schema: "zakura.project-blueprint"` and `version: 1`. Import never executes recipes or fetches remote definitions. Placeholders are expanded once: text inserted by a parameter does not become another executable template expression. Candidate expansion is bounded even when conditions skip the candidates.

## Project references and decisions

The Knowledge tab stores notes, decisions and questions with immutable revisions, tags and source references. Sources can identify a project-owned snapshot/path, a knowledge revision, or an HTTPS URL. Recording a URL does not fetch it. Discussion comments are separate durable records.

Search uses lexical BM25 ranking over a project-local SQL index with Latin word and CJK tokenization. Search results include bounded snippets, Unicode code-point highlight offsets and an explicit truncation indicator. This is lexical retrieval; it does not claim embedding similarity or semantic entailment.

Decisions start as proposals and require a human member session to approve or reject. Questions can be resolved and reopened. Editing an approved decision invalidates its approval. Archived or deleted current records retain their historical revision evidence.

Project tasks can call `knowledge_search`, `knowledge_read` and `project_note`. Retrieved content is untrusted reference material. The note mutation and its tool receipt commit together; a worker recovering after a lost response can inspect the exact admitted operation instead of creating the note twice. These tools cannot approve decisions, resolve human questions or approve project delivery.

## Portfolio scheduling

The portfolio shows queue state, blockers and accounted token/model/tool budgets across projects. Owner/admin sessions can enable tenant scheduling policy and Agent concurrency limits. The default policy preserves the executor's existing dispatch order.

When enabled, the scheduler persists weighted virtual service, priority and aging. Service history survives worker restarts. Tenant task slots and per-Agent model/tool dispatch slots are admitted in database transactions. A saturated Agent makes a task wait without consuming a model/tool allowance merely for waiting. These are logical execution admission limits, not Docker CPU or memory guarantees.

Project scheduling priority and weight are live control-plane settings. The frozen run plan, checks and execution budget remain unchanged. Batch pause/resume/cancel reports a result for each item and does not claim cross-run atomicity. Campaign-managed runs use their campaign controls to preserve the shared activity budget and concurrency limit.

## Immutable code analysis

The Code semantics tab indexes immutable snapshots. Go declarations, method signatures and local references are parsed from Go ASTs. TypeScript/JavaScript indexing uses bounded lexical analysis and explicitly reports partial understanding rather than claiming a full type checker. Comments, strings, templates and regex literals are not executed.

Symbol navigation, module dependency graphs, reverse impact paths and exported API comparisons retain evidence about incomplete files, conditional builds and unsupported constructs. An incomplete index cannot silently turn into a confident API-removal claim. Related test files are inferred from actual dependency paths; this is not test coverage measurement.

The Go refactoring panel uses object-bound definitions and references to propose a rename. It rejects incomplete type checking, conflicting names and ambiguous build configurations. Applying a validated preview creates an isolated candidate snapshot; it does not modify the original space or an actively executing task branch. A human can start a new run from that candidate using the current local plan and fresh acceptance checks.

Refactoring checks run in a bounded helper process of the runner's own binary. No workspace program is executed and no dependency is downloaded. Missing required local Go sources or unsupported external dependencies produce an explicit unsupported result.

## Execution evidence and scheduling experiments

The Insights tab derives task intervals from durable claimed/finished/failed events. Heartbeat timestamps do not masquerade as task start or finish times. Pauses, human review, unknown operations and retry boundaries have separate intervals, including incomplete or uncertain intervals.

The workbench can compare runs by frozen task identity and relevant dependency inputs. Changed definitions or ancestors invalidate reusable timing evidence. Critical paths, retries, blocked ancestors and actual accounted usage remain tied to their source events.

What-if scheduling is a local discrete-event simulation. It observes dependencies, writable-claim conflicts and configured capacities. Missing duration evidence stays unknown until a user supplies an assumption. Sample estimates and uncertainty are reported separately from observed runs. The simulator does not launch an Agent or fabricate money costs from token counts.

## Reviewed delivery bundles

Create a delivery from an approved or applied, conflict-free merge preview. The server freezes the selected snapshot, final acceptance evidence and human review provenance before requesting archive creation. Version/name pairs are unique per project. An interrupted request leaves a visible intent; **Inspect receipt** reads durable runner evidence.

A delivery tar contains only `delivery.json` and `workspace.tar`. The inner archive is the existing content-addressed workspace format. Import validates the complete envelope, payload SHA-256, snapshot manifest and every object. Archive filenames are never extracted as arbitrary filesystem paths. The envelope rejects extra entries, special files and trailing nonzero data.

The manifest hash, payload digest and whole-archive digest verify integrity. They are not digital signatures, and an imported review statement is not an authenticated local approval. No foreign task result, budget configuration or approval is copied into the execution database.

Downloads support one HTTP byte range, ETags and authenticated streaming. Transfers use bounded 128 KiB chunks. Uploads reserve their declared size against a per-project cache quota. A duplicate chunk must match already committed bytes; a restart removes any tail written before its offset metadata committed. Completed import evidence pins the immutable snapshot against repository cleanup.

The browser performs SHA-256 verification and supports files up to 64 MiB. The service's chunked API supports bounded archives up to 768 MiB. Browser pause preserves the transfer ID and durable offset; resume requires the same digest and size. **Validate and import** creates an isolated snapshot. **Execute with the current plan** starts fresh local tasks, checks and reviews from that snapshot.

Human-reviewed ready versions can be assigned to named release channels using revision comparisons. Revocation preserves provenance and is refused while a channel still points to that version. Move the channel to another reviewed version first.

## Requirements and acceptance traceability

A requirements baseline maps functional, nonfunctional or constraint clauses to exact local task/check IDs. Analysis identifies unmapped clauses, missing checks and stale plan references. A human approval freezes the local plan and baseline; editing invalidates approval without rewriting history.

Bind an approved immutable baseline explicitly to a run. The binding cannot later be replaced. Run coverage distinguishes missing, pending, failed, changed-plan, unapproved-review and passed evidence. A declared check is not a passing verification. Imported manifest claims never satisfy the local review requirement.

When the baseline explicitly requires coverage before publication, the merge-review, merge-apply and delivery-create transactions re-check it under the same project mutation lock. Required mapped tasks must be included in the selected merge, and their checks must have passed against the final merged snapshot. An unrelated accepted task or a successful check on an earlier task snapshot cannot satisfy the gate. Projects without an explicit binding retain their existing behavior.

## Controlled comparison campaigns

A campaign expands one immutable blueprint version into bounded Agent/model variants. It preserves every resolved project definition and allocates fixed per-variant budget caps from a total activity budget. Unused allocations are not silently borrowed by another variant. Creating a campaign leaves its child projects in draft until a human starts the activity.

The activity captures one source base and copies that immutable snapshot into each child project's own repository. Captures, copies and run creation have durable intent IDs. Interrupted starts recover the exact reserved run ID; they cannot create a second run to hide an unknown outcome.

The campaign controls shared active-variant concurrency. Paused and unknown variants retain reservations. Generic project edits, forks, retries and standalone starts cannot bypass these limits. Individual pause/cancel remains available because it reduces activity; resume belongs to the campaign controller.

Comparison reports actual required-check observations, accounted tokens/model/tool calls and observed elapsed time. Charged tokens can conservatively include an unknown provider response; the report does not label these as provider-reported usage. One run per variant is not presented as a statistically reliable success probability or an invented financial saving.

The campaign freezes local plans, Agent IDs, model selectors and budget caps. Agent configuration, tool catalogs, gateway routing and provider versions remain live execution dependencies. An unresolved provider model identity is reported as unknown rather than presented as a frozen external model version.

## Human review inbox

Project reviews combines task reviews, uncertain or approval-gated operations, merge actions, source-recovery attestations, knowledge decisions/questions and requirement baselines. It links to the specific existing workbench item. Refresh explicitly reports an item that another reviewer has already handled.

Lists are bounded and use stable filter-bound cursors and a snapshot cutoff. Summary counts aggregate all matching visible records rather than just the current page. Tool arguments and secret-bearing raw error text are not included. Source attestations remain visible only to the signed-in human owner/admin roles that can resolve them. The inbox does not automatically approve or bulk-publish results.

## Independent reviewer signoffs

Projects can require more than one independent reviewer before a final merge is approved. A human owner/admin configures the quorum, eligible tenant members or roles, optional project-creator exclusion and vote expiry. The default is one reviewer, preserving the existing workflow.

Each vote binds an exact immutable preview snapshot and policy version. A reviewer cannot count twice. The preview remains ready until enough valid positive votes exist. A negative decision rejects the preview; withdrawing a vote before publication can return an approved preview to ready. Applying, applied and uncertain source effects retain their committed review history.

Policy changes invalidate unpublished approval evidence and require reviewers to sign again. Publication re-checks current member eligibility, distinct votes, expiry and the policy under the project transaction. The delivery manifest records the observed participants as unsigned provenance. A machine credential cannot cast a human vote, change the policy or inherit imported signoffs.

## Task code context

The task context panel and `project_context` tool build bounded reference packs from a task's immutable causal base snapshot. The server supplies that task's declared writes, acceptance paths and frozen prompt as retrieval seeds; the model cannot choose another project or a host path.

Selection combines lexical matches with actual declarations and bounded module/reference neighbors. Each snippet records its snapshot, full file digest, offsets and selection reason. Partial parsing, unsupported constructs, omitted files and resource limits remain visible. This is lexical and graph retrieval, not an embedding or a claim that the snippets prove a requirement.

The complete JSON reply is byte-bounded and Unicode-safe. Reference text is returned as tool data, never promoted into system instructions. No workspace program executes and no remote dependency or embedding service is contacted. Provider token usage is still charged by the executor's existing model admission and settlement rules.

## Validation and limits

New schemas are additive migrations 0008–0015. SQLite and PostgreSQL use the same scoped records and revision contracts. The sandbox-validation workflow exercises race detection, PostgreSQL competing admissions and revision/search snapshots, real server/runner Docker boundaries, client contracts and the production Next build.

The executor still requires an operator-provisioned project Docker image for command checks. Code analysis, archive import and local simulations do not bypass that boundary. Large or unsupported projects can return explicit resource or analysis limits. No feature treats an unavailable runner, missing sample or unknown external effect as successful completion.
