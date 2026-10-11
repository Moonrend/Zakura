import test from "node:test";
import assert from "node:assert/strict";
import {
  createProject,
  updateProject,
  controlRun,
  reviewTask,
  resolveOperation,
  applyMerge,
  reviewMerge,
  forkRun,
  getArtifactFile,
  getEvents,
  getSourceActivities,
  getSourceAttestations,
  confirmSourceQuiescence,
  inspectSourceAttestation,
  defaultDefinition,
  validateDraft,
  type Run,
  type Operation,
  type MergePreview,
} from "../../lib/project-execution";

test("project mutations bind exact revisions, snapshots and operation results", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      path: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return new Response(JSON.stringify({ id: "id" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const value = defaultDefinition("space", "agent");
    value.name = "项目";
    value.goal = "交付结果";
    value.plan.tasks[0].title = "任务";
    value.plan.tasks[0].prompt = "交付文件";
    value.plan.tasks[0].checks[0].path = "result.txt";
    await createProject(value);
    assert.equal(calls.at(-1)?.path, "/api/project-executions/");
    assert.deepEqual(calls.at(-1)?.body.plan, value.plan);
    await updateProject("project/id", { ...value, expectedRevision: 12 });
    assert.equal(calls.at(-1)?.path, "/api/project-executions/project%2Fid/");
    assert.equal(calls.at(-1)?.body.expectedRevision, 12);
    await controlRun("pid", { id: "run", revision: 9 } as Run, "pause");
    assert.deepEqual(calls.at(-1)?.body, { expectedRevision: 9 });
    await reviewTask("pid", "run", "task", "frozen", "approve", "核对通过");
    assert.equal(calls.at(-1)?.body.snapshotId, "frozen");
    await resolveOperation(
      "pid",
      "run",
      { id: "op", revision: 3 } as Operation,
      "completed",
      "目标系统确认",
      { messageId: "external-123" },
    );
    assert.deepEqual(calls.at(-1)?.body.result, { messageId: "external-123" });
    assert.equal(calls.at(-1)?.body.expectedRevision, 3);
    const preview = {
      id: "merge",
      runId: "run",
      revision: 4,
      plan: { result: { id: "immutable" } },
    } as MergePreview;
    await reviewMerge("pid", preview, "approved", "核对合并产物");
    assert.equal(calls.at(-1)?.body.snapshotId, "immutable");
    await applyMerge("pid", preview);
    assert.deepEqual(calls.at(-1)?.body, {
      expectedRevision: 4,
      confirmation: "merge",
    });
    await forkRun("pid", "original", 10);
    assert.equal(
      calls.at(-1)?.path,
      "/api/project-executions/pid/runs/original/fork",
    );
    assert.equal(calls.at(-1)?.body.expectedProjectRevision, 10);
    await getArtifactFile(
      "pid",
      { snapshotId: "snapshot" },
      "目录/文件 ?#.txt",
    );
    assert.equal(
      calls.at(-1)?.path,
      "/api/project-executions/pid/snapshots/snapshot/file?path=%E7%9B%AE%E5%BD%95%2F%E6%96%87%E4%BB%B6%20%3F%23.txt",
    );
    await getEvents("pid", 123, "run/id");
    assert.match(calls.at(-1)?.path ?? "", /after=123&runId=run%2Fid/);
    await getSourceActivities("pid");
    assert.equal(
      calls.at(-1)?.path,
      "/api/project-executions/pid/source/activities",
    );
    await getSourceAttestations("pid");
    assert.equal(
      calls.at(-1)?.path,
      "/api/project-executions/pid/source/attestations",
    );
    await confirmSourceQuiescence(
      "pid",
      ["old-job-a", "old-job-b"],
      "节点管理员核对全部进程退出",
    );
    assert.deepEqual(calls.at(-1)?.body, {
      activityIds: ["old-job-a", "old-job-b"],
      confirmation: "writers_stopped",
      comment: "节点管理员核对全部进程退出",
    });
    await inspectSourceAttestation("pid", "attestation/id");
    assert.equal(
      calls.at(-1)?.path,
      "/api/project-executions/pid/source/attestations/attestation%2Fid/inspect",
    );
    assert.deepEqual(calls.at(-1)?.body, {});
  } finally {
    globalThis.fetch = original;
  }
});
test("drafts require goals, agents and genuinely required acceptance", () => {
  const value = defaultDefinition();
  assert.ok(validateDraft(value).length >= 5);
  value.name = "真实交付";
  value.goal = "生成文件";
  value.spaceId = "space";
  const t = value.plan.tasks[0];
  t.title = "实现";
  t.prompt = "完整实现";
  t.agentId = "agent";
  t.checks[0].path = "result.txt";
  assert.deepEqual(validateDraft(value), []);
  t.checks[0].required = false;
  assert.ok(validateDraft(value).some((s) => s.includes("必需验收")));
  t.checks[0].required = true;
  t.dependsOn = ["missing"];
  assert.ok(validateDraft(value).some((s) => s.includes("依赖无效")));
});
