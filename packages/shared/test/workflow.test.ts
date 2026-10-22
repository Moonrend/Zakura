import test from "node:test";
import assert from "node:assert/strict";
import {
  parseWorkflowRequest,
  workflowDuration,
  workflowTimeline,
  type WorkflowRequest,
  type WorkflowSlot,
} from "../src/workflow.js";

const request: WorkflowRequest = {
  definition: {
    version: 1,
    name: "example",
    nodes: [{ id: "start", durationMs: 1000 }],
  },
  options: { maxParallel: 2 },
};

test("workflow JSON imports valid round trips without discarding fields", () => {
  const rich: WorkflowRequest = structuredClone(request);
  rich.definition.nodes[0] = {
    id: "start",
    name: "开始",
    kind: "agent",
    durationMs: 1000,
    timeoutMs: 2000,
    costMicros: 200000,
    maxAttempts: 3,
    backoffMs: 500,
    backoffMultiplier: 2,
    maxBackoffMs: 2000,
    resources: { model: 1 },
    concurrencyKey: "user",
    dependsOn: [],
  };
  rich.options = {
    resources: { model: 2 },
    concurrencyLimits: { user: 1 },
    maxParallel: 2,
    mode: "retryBound",
    priority: "id",
    budgetMicros: 1000000,
    deadlineMs: 10000,
  };
  assert.deepEqual(parseWorkflowRequest(JSON.stringify(rich)), rich);
});

test("workflow import rejects unsafe shape, unknown fields and wrong scalar types", () => {
  const bad = [
    null,
    [],
    {},
    { ...request, extra: 1 },
    { ...request, definition: { ...request.definition, version: 2 } },
    { ...request, definition: { ...request.definition, nodes: [] } },
    { ...request, definition: { ...request.definition, nodes: [null] } },
    {
      ...request,
      definition: {
        ...request.definition,
        nodes: [{ id: 1, durationMs: 100 }],
      },
    },
    {
      ...request,
      definition: {
        ...request.definition,
        nodes: [{ id: "a", durationMs: 1.5 }],
      },
    },
    {
      ...request,
      definition: {
        ...request.definition,
        nodes: [{ id: "a", durationMs: 1, dependsOn: [1] }],
      },
    },
    {
      ...request,
      definition: {
        ...request.definition,
        nodes: [{ id: "a", durationMs: 1, resources: { gpu: "1" } }],
      },
    },
    { ...request, options: { maxParallel: Number.MAX_SAFE_INTEGER + 1 } },
    { ...request, options: { mode: "live" } },
    { ...request, options: { priority: "random" } },
    { ...request, options: { resources: [] } },
    {
      ...request,
      options: {
        resources: Object.fromEntries(
          Array.from({ length: 33 }, (_, i) => [`r${i}`, 1]),
        ),
      },
    },
  ];
  for (const value of bad)
    assert.throws(() => parseWorkflowRequest(JSON.stringify(value)));
  assert.throws(() => parseWorkflowRequest("{} {}"));
  assert.throws(() => parseWorkflowRequest("{"));
});

test("workflow import byte limit includes multi-byte Unicode", () => {
  const big = {
    ...request,
    definition: { ...request.definition, name: "猫".repeat(700000) },
  };
  assert.throws(() => parseWorkflowRequest(JSON.stringify(big)), /2 MiB/);
});

test("timeline uses half-open schedule intervals without NaN geometry", () => {
  const slot: WorkflowSlot = {
    nodeId: "a",
    startMs: 25,
    endMs: 75,
    waitMs: 0,
    resources: {},
  };
  assert.deepEqual(workflowTimeline(slot, 100), { left: 25, width: 50 });
  for (const makespan of [0, -1, NaN, Infinity])
    assert.equal(workflowTimeline(slot, makespan), null);
  for (const change of [
    { startMs: -1 },
    { endMs: 25 },
    { endMs: 101 },
    { startMs: NaN },
  ]) {
    assert.equal(workflowTimeline({ ...slot, ...change }, 100), null);
  }
});

test("duration labels remain useful across milliseconds through hours", () => {
  assert.equal(workflowDuration(-1), "—");
  assert.equal(workflowDuration(Infinity), "—");
  assert.equal(workflowDuration(25), "25 ms");
  assert.equal(workflowDuration(2000), "2.00 s");
  assert.equal(workflowDuration(90000), "1.50 min");
  assert.equal(workflowDuration(7200000), "2.00 h");
});
