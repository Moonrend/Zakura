import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../../lib/api";
import {
  getSignoffPolicyHistory,
  getSignoffs,
  saveSignoffPolicy,
  signoffActorReason,
  signoffExpiry,
  signoffHumanReason,
  signoffTarget,
  voteSignoff,
  withdrawSignoff,
  type SignoffEvidence,
  type SignoffPolicy,
  type SignoffPolicyContext,
  type SignoffRecord,
  type SignoffVote,
} from "../../lib/project-signoff";
import { SignoffProof } from "./signoff-panel";

const policy: SignoffPolicy = {
  revision: 8,
  hash: "current-policy-hash",
  configured: true,
  minApprovals: 2,
  eligibleReviewerIds: ["human-1", "human-2"],
  eligibleRoles: ["member"],
  disallowProjectCreator: true,
  expirySeconds: 3600,
};
function reviewed(): SignoffRecord {
  return {
    preview: {
      id: "preview/猫🐾",
      runId: "run/&?#",
      projectId: "project",
      revision: 21,
      status: "ready",
      plan: { result: { id: "immutable-snapshot" } },
    },
    summary: {
      policy: { ...policy },
      binding: {
        previewId: "preview/猫🐾",
        runId: "run/&?#",
        snapshotId: "immutable-snapshot",
        evidenceHash: "frozen-checks-hash",
      },
    },
  } as SignoffRecord;
}

test("signoff mutation contracts preserve reviewed CAS and let the server derive the human actor", async (t) => {
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
      return Response.json(
        String(input).endsWith("/history") ? [policy] : { id: "result" },
      );
    },
  );
  const record = reviewed();
  const captured = signoffTarget(record);
  record.preview.revision = 22;
  record.summary.policy.hash = "concurrently-changed-policy";
  await voteSignoff(
    "project/id",
    captured,
    "approved",
    "我核对了猫🐾的真实验收。",
  );
  const vote = calls.at(-1)!;
  assert.equal(vote.method, "POST");
  assert.equal(
    new URL(vote.path, "https://test.example").searchParams.get("runId"),
    "run/&?#",
  );
  assert.ok(
    vote.path.startsWith(
      "/api/project-executions/project%2Fid/merges/preview%2F",
    ),
  );
  assert.deepEqual(vote.body, {
    expectedRevision: 21,
    snapshotId: "immutable-snapshot",
    policyHash: "current-policy-hash",
    decision: "approved",
    comment: "我核对了猫🐾的真实验收。",
  });
  assert.equal("userId" in vote.body, false);
  assert.equal("role" in vote.body, false);
  await withdrawSignoff("project/id", captured, "own-vote/&?");
  assert.ok(
    calls.at(-1)!.path.includes("/signoffs/own-vote%2F%26%3F/withdraw?"),
  );
  assert.deepEqual(calls.at(-1)!.body, {
    expectedRevision: 21,
    snapshotId: "immutable-snapshot",
    policyHash: "current-policy-hash",
  });
  await saveSignoffPolicy("project/id", policy, { ...policy, minApprovals: 3 });
  assert.deepEqual(calls.at(-1)!.body, {
    minApprovals: 3,
    eligibleReviewerIds: ["human-1", "human-2"],
    eligibleRoles: ["member"],
    disallowProjectCreator: true,
    expirySeconds: 3600,
    expectedRevision: 8,
  });
  await getSignoffs("project/id", "run/&?#", "preview/猫🐾");
  assert.equal(
    new URL(calls.at(-1)!.path, "https://test.example").searchParams.get(
      "runId",
    ),
    "run/&?#",
  );
  assert.deepEqual(await getSignoffPolicyHistory("project/id"), [policy]);
});

test("a signoff conflict is returned once without fetching or silently replacing the reviewed revision", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return Response.json({ error: "preview changed" }, { status: 409 });
  });
  const captured = signoffTarget(reviewed());
  await assert.rejects(
    voteSignoff("project", captured, "approved", "检查已完成"),
    (error: unknown) => error instanceof ApiError && error.status === 409,
  );
  assert.equal(requests, 1);
  assert.equal(captured.expectedRevision, 21);
  assert.equal(captured.policyHash, "current-policy-hash");
  const inconsistent = reviewed();
  inconsistent.summary.binding.snapshotId = "another-artifact";
  assert.throws(() => signoffTarget(inconsistent), /绑定不一致/);
  assert.equal(requests, 1);
});

test("UI actor affordances require a matching human session and permit an ineligible reviewer to withdraw their own vote", () => {
  const context: SignoffPolicyContext = {
    policy,
    members: [],
    membersTruncated: true,
    currentUserId: "human-1",
    currentRole: "member",
    humanSession: true,
    canConfigure: false,
  };
  assert.equal(signoffActorReason(context, "human-1", policy, "creator"), null);
  assert.match(
    signoffActorReason(
      { ...context, humanSession: false, canConfigure: true },
      "human-1",
      policy,
      "creator",
    )!,
    /真人/,
  );
  assert.match(
    signoffActorReason(context, undefined, policy, "creator")!,
    /真人/,
  );
  assert.match(
    signoffActorReason(context, "other-human", policy, "creator")!,
    /不一致/,
  );
  assert.match(
    signoffActorReason(context, "human-1", policy, "human-1")!,
    /创建者/,
  );
  assert.match(
    signoffActorReason(
      context,
      "human-1",
      { ...policy, eligibleReviewerIds: ["human-2"] },
      "creator",
    )!,
    /名单/,
  );
  assert.equal(
    signoffHumanReason(context, "human-1"),
    null,
    "withdrawal requires active human membership, not eligibility to cast a new vote",
  );
});

test("proof rendering preserves Unicode identifiers as escaped text and expiry uses UTC", () => {
  const evidence: SignoffEvidence = {
    policyRevision: 8,
    policyHash: "current-policy-hash",
    required: 2,
    binding: reviewed().summary.binding,
    participants: [
      {
        userId: "human-1",
        voteId: "票🐾<script>",
        createdAt: "2026-10-11T08:00:00+08:00",
        snapshotId: "猫🐾.go",
      },
    ],
  };
  const html = renderToStaticMarkup(
    React.createElement(SignoffProof, {
      evidence,
      members: [
        {
          userId: "human-1",
          name: "陈🐾<img onerror=alert(1)>",
          role: "member",
        },
      ],
    }),
  );
  assert.ok(html.includes("陈🐾&lt;img onerror=alert(1)&gt;"));
  assert.ok(html.includes("票🐾&lt;script&gt;"));
  assert.ok(html.includes("猫🐾.go"));
  assert.ok(html.includes("2026-10-11T00:00:00.000Z"));
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("<img "), false);
  const vote = {
    policyHash: policy.hash,
    createdAt: "2026-10-11T08:00:00+08:00",
  } as SignoffVote;
  assert.equal(signoffExpiry(vote, policy), "2026-10-11T01:00:00.000Z");
  assert.equal(
    signoffExpiry(vote, { ...policy, hash: "new-policy" }),
    "旧策略票据，当前策略下无效",
  );
});
