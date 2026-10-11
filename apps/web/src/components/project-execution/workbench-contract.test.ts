import assert from "node:assert/strict";
import test from "node:test";
import {
  changeKnowledgeState,
  getKnowledge,
  highlightedParts,
  instantiateTemplate,
  parseBlueprintDocument,
  portfolioAction,
  savePortfolioPolicy,
  saveTemplate,
  searchKnowledge,
  semanticFile,
  type ProjectTemplate,
  type PortfolioPolicy,
} from "../../lib/project-workbench";
import { simulateRun } from "../../lib/project-insights";

test("knowledge highlighting preserves Unicode code points and treats source markup as text", () => {
  assert.deepEqual(
    highlightedParts("猫🐾<script>星绒", [
      { start: 1, end: 2 },
      { start: 10, end: 12 },
    ]),
    [
      { text: "猫", matched: false },
      { text: "🐾", matched: true },
      { text: "<script>", matched: false },
      { text: "星绒", matched: true },
    ],
  );
  assert.deepEqual(
    highlightedParts("abc", [
      { start: -1, end: 2 },
      { start: 0, end: 1 },
      { start: 0, end: 3 },
      { start: 2, end: 99 },
    ]),
    [
      { text: "a", matched: true },
      { text: "bc", matched: false },
    ],
  );
});

test("blueprint import refuses incompatible schemas before an HTTP mutation", () => {
  assert.throws(
    () =>
      parseBlueprintDocument(
        '{"schema":"foreign","version":1,"blueprint":{"tasks":[],"parameters":[]}}',
      ),
    /格式或版本/,
  );
  assert.throws(
    () =>
      parseBlueprintDocument(
        '{"schema":"zakura.project-blueprint","version":2,"blueprint":{"tasks":[],"parameters":[]}}',
      ),
    /格式或版本/,
  );
  assert.throws(() => parseBlueprintDocument("null"), /JSON 对象/);
  const document = {
    schema: "zakura.project-blueprint",
    version: 1,
    blueprint: { tasks: [], parameters: [] },
  };
  assert.deepEqual(parseBlueprintDocument(JSON.stringify(document)), document);
});

test("workbench controls preserve exact human-reviewed revisions and immutable inputs", async (t) => {
  const calls: {
    path: string;
    method: string;
    body: Record<string, unknown>;
  }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: unknown, init?: RequestInit) => {
      calls.push({
        path: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : {},
      });
      return Response.json({ id: "result", items: [] });
    },
  );
  const current = {
    id: "template/id",
    revision: 18,
    currentVersion: 7,
    definition: { name: "蓝图" },
  } as ProjectTemplate;
  await instantiateTemplate(current, 3, {
    spaceId: "space",
    parameters: { path: "猫🐾/src", count: 2, enabled: false },
    agentMapping: { builder: "agent" },
  });
  assert.equal(
    calls.at(-1)!.path,
    "/api/project-templates/template%2Fid/instantiate",
  );
  assert.equal(calls.at(-1)!.body.expectedRevision, 18);
  assert.equal(calls.at(-1)!.body.version, 3);
  assert.deepEqual(calls.at(-1)!.body.parameters, {
    path: "猫🐾/src",
    count: 2,
    enabled: false,
  });
  await saveTemplate(current.definition, current);
  assert.equal(calls.at(-1)!.method, "PATCH");
  assert.equal(calls.at(-1)!.body.expectedRevision, 18);
  await getKnowledge("project/id", "entry/id", 4);
  assert.equal(
    calls.at(-1)!.path,
    "/api/project-executions/project%2Fid/knowledge/entry%2Fid?revision=4",
  );
  await changeKnowledgeState(
    "pid",
    { id: "kid", revision: 9 } as never,
    "approve",
    "核对来源后批准",
  );
  assert.deepEqual(calls.at(-1)!.body, {
    expectedRevision: 9,
    action: "approve",
    comment: "核对来源后批准",
  });
  const items = [
    { projectId: "p1", runId: "r1", expectedRevision: 3 },
    { projectId: "p2", runId: "r2", expectedRevision: 7 },
  ];
  await portfolioAction("cancel", items);
  assert.deepEqual(calls.at(-1)!.body, { action: "cancel", items });
  await savePortfolioPolicy({
    revision: 10,
    enabled: true,
    maxActiveTasks: 3,
    defaultAgentModelCalls: 1,
    defaultAgentToolCalls: 2,
    agents: [],
    agingSeconds: 60,
  } satisfies PortfolioPolicy);
  assert.equal(calls.at(-1)!.body.expectedRevision, 10);
  await searchKnowledge("pid", "猫🐾 & ?", {
    tag: "设计/确认",
    includeArchived: true,
  });
  const knowledgeURL = new URL(calls.at(-1)!.path, "https://example.test");
  assert.equal(knowledgeURL.searchParams.get("q"), "猫🐾 & ?");
  assert.equal(knowledgeURL.searchParams.get("tag"), "设计/确认");
  await semanticFile("pid", "immutable", "目录/a ?#.go");
  assert.equal(
    new URL(calls.at(-1)!.path, "https://example.test").searchParams.get(
      "path",
    ),
    "目录/a ?#.go",
  );
  const scenarios = [
    {
      id: "explicit",
      label: "手工假设",
      maxConcurrent: 3,
      durations: { task: 0 },
      capacities: { gpu: 1 },
      resources: { task: { gpu: 1 } },
      costs: {},
      serializeWrites: false,
    },
  ];
  await simulateRun("pid", "rid", scenarios, 0.9);
  assert.deepEqual(calls.at(-1)!.body, { scenarios, quantile: 0.9 });
  assert.equal(
    calls.at(-1)!.path,
    "/api/project-executions/pid/runs/rid/simulate",
  );
});
