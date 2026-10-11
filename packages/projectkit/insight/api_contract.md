# Execution insights and what-if scheduling

Register with `h.registerProjectInsights(p)` inside the existing
`/project-executions/{pid}` router. Existing tenant access middleware applies.
Reads do not require a runner or model connection and never alter execution.

- GET `/insights?limit=20` -> `ProjectInsight`: projectId, runs:
  RunInsight[], estimates: DurationEstimate[], warnings: Notice[].
- GET `/runs/{rid}/insights` -> RunInsight.
- GET `/runs/compare?left={runId}&right={runId}` -> Comparison.
- POST `/runs/{rid}/simulate` -> Simulation. Body:
  `{quantile:0.5|0.9, scenarios:[{id,label,maxConcurrent,durations,
  capacities,resources,costs,serializeWrites?}]}`.
  durations maps stable spec IDs to assumed seconds; capacities maps named
  resources to integer capacity; resources maps spec IDs to resource demands;
  costs maps spec IDs to `{tokens,modelCalls,toolCalls}`. Missing resource
  demands consume no named resource. Missing capacity for a demanded resource
  is rejected. serializeWrites defaults true and adds simulated reservations for
  overlapping declared paths. This is a what-if policy, not proof of a runtime
  lock (runner branches are isolated). 1–8 scenarios, 1–1000 concurrency.
- GET `/runs/{rid}/insights/report?format=json|markdown` downloads a report.
  Report includes no prompts, tool arguments, result bodies or credentials.

Exact field tags are defined in types.go. Important frontend structures:

```ts
type Notice = { code:string; taskId?:string; message:string };
type Usage = { tokens:number; modelCalls:number; toolCalls:number };
type Blocker = {code:string; taskId?:string; operationId?:string;
  message:string; evidence:string; chain?:string[]};
type Interval = {start:string; end?:string; seconds?:number;
  startSequence:number; endSequence?:number; outcome:string; recoveries:number};
type Checkpoint = {id:string;sequence:number;nextTool:number;
  eventSequence:number;createdAt:string};
type TaskInsight = {taskId:string;specId:string;title:string;status:string;
  attempt:number;reused:boolean;intervals:Interval[];observedSeconds?:number;
  durationComplete:boolean;firstStartedAt?:string;finishedAt?:string;
  reviewSeconds?:number;retryRequests:number;recoveries:number;
  checkpoints:Checkpoint[];usage:Usage;operationStatuses:Record<string,number>;
  verificationStatuses:Record<string,number>;tokensPerObservedSecond?:number;
  blockers:Blocker[];warnings:Notice[]};
type CriticalPath = {taskIds:string[];seconds?:number;
  knownLowerBoundSeconds:number;unknownTaskIds:string[]};
type RunInsight = {runId:string;projectId:string;planVersion:number;status:string;
  createdAt:string;usage:Usage;attributedUsage:Usage;unattributedUsage:Usage;
  elapsedSeconds?:number;finishedAt?:string;tasks:TaskInsight[];
  criticalPath:CriticalPath;statusCounts:Record<string,number>;warnings:Notice[];
  eventCount:number;evidenceComplete:boolean};
type DurationEstimate = {specId:string;source:"unknown"|"observed";samples:number;
  p50Seconds?:number;p90Seconds?:number;medianInterval?:{low:number;high:number;
  confidence:number;replicates:number};runIds:string[];warnings:string[]};
type Comparison = {left:RunInsight;right:RunInsight;warnings:Notice[];
  tasks:{specId:string;change:"unchanged"|"added"|"removed"|"execution_changed"|
  "reused";comparable:boolean;reason?:string;left?:TaskInsight;right?:TaskInsight;
  durationDeltaSeconds?:number;tokenDelta?:number}[]};
type ScenarioResult = {id:string;label:string;status:"complete"|"unknown"|"blocked";
  maxConcurrent:number;makespanSeconds?:number;utilization?:number;
  resourceUtilization:Record<string,number>;timeline:{specId:string;
  startSeconds:number;endSeconds:number;durationSeconds:number;
  durationSource:"override"|"observed";resources:Record<string,number>}[];
  criticalPath:CriticalPath;unknownTaskIds:string[];blockers:Blocker[];
  budget:{status:"within"|"unknown"|"exceeded";known:Usage;
  missingTaskIds:string[];exceeded:string[];message:string};warnings:string[]};
type Simulation = {runId:string;planVersion:number;quantile:number;
  estimates:DurationEstimate[];scenarios:ScenarioResult[];assumptions:string[]};
```

Durations use claimed/finished/failed/control events in durable sequence order.
Heartbeat UpdatedAt is never a substitute. Unknown/open/reversed-time intervals
have no duration. Crash recovery claims do not double-count an already open span.
Review waiting is measured separately. Execution span is wall time, not CPU.

Historical samples require unchanged goal, execution inputs, checks and
transitive dependency inputs. Reused artifacts are excluded. Quantiles and
deterministic 512-resample 95% bootstrap intervals are descriptive; small samples
and correlated runs cannot promise future performance. Missing estimates remain
explicit unknowns and can be replaced with user assumptions.

Simulation runs the complete frozen DAG from time zero with deterministic
priority/critical-path/spec-ID tie breaking, no dispatch and no inference of
remaining work. Budget costs are user assumptions: missing cost estimates make
the budget assessment unknown even if the timeline can be simulated.
