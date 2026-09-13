import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeListener,
  inboundFromGithub,
  inboundFromSlack,
  matchRoutineListener,
  parseRoutineListener,
  RoutineListenerError,
  shouldAutoStopListener,
} from "../src/routine.js";

describe("parseRoutineListener", () => {
  it("rejects wildcard github repo", () => {
    assert.throws(
      () => parseRoutineListener({ source: "github", repo: "acme/*", events: ["pr_opened"] }),
      RoutineListenerError,
    );
  });

  it("parses slack keyword listener", () => {
    const l = parseRoutineListener({
      source: "slack",
      channel: "#eng",
      match: "keyword",
      keywords: ["deploy"],
    });
    assert.equal(l.source, "slack");
    if (l.source === "slack") {
      assert.equal(l.channel, "#eng");
      assert.deepEqual(l.keywords, ["deploy"]);
    }
  });

  it("rejects origin mixed with webhook", () => {
    assert.throws(
      () =>
        parseRoutineListener({
          source: "group",
          listeners: [
            { source: "origin", repo: "acme/app", events: ["pr_opened"] },
            { source: "webhook" },
          ],
        }),
      RoutineListenerError,
    );
  });

  it("rejects slack keyword without keywords", () => {
    assert.throws(
      () => parseRoutineListener({ source: "slack", match: "keyword" }),
      RoutineListenerError,
    );
  });

  it("rejects CI-only listener without PR or branch", () => {
    assert.throws(
      () =>
        parseRoutineListener({
          source: "github",
          repo: "acme/app",
          events: ["ci_failed"],
        }),
      RoutineListenerError,
    );
  });

  it("parses CI-only listener with branch", () => {
    const l = parseRoutineListener({
      source: "github",
      repo: "acme/app",
      events: ["ci_failed"],
      branch: "main",
    });
    assert.equal(l.source, "github");
    if (l.source === "github") assert.equal(l.branch, "main");
  });
});

describe("matchRoutineListener", () => {
  it("matches slack keyword in channel", () => {
    const l = parseRoutineListener({
      source: "slack",
      channel: "#eng",
      match: "keyword",
      keywords: ["deploy"],
    });
    const hit = inboundFromSlack({
      channel: "#eng",
      text: "ready to deploy prod",
    });
    const miss = inboundFromSlack({
      channel: "#eng",
      text: "lunch?",
    });
    assert.equal(matchRoutineListener(l, hit), true);
    assert.equal(matchRoutineListener(l, miss), false);
  });

  it("matches github PR merge on the right repo", () => {
    const l = parseRoutineListener({
      source: "github",
      repo: "moonrend/zakura",
      events: ["pr_merged", "ci_failed"],
    });
    const events = inboundFromGithub("pull_request", {
      action: "closed",
      pull_request: { number: 12, merged: true },
      repository: { full_name: "moonrend/zakura" },
      sender: { login: "wuyuan" },
    });
    assert.ok(events.some((e) => e.type === "pr_merged"));
    assert.ok(events.every((e) => matchRoutineListener(l, e) === (e.type === "pr_merged")));
  });

  it("accepts prNumber as a string", () => {
    const l = parseRoutineListener({
      source: "github",
      repo: "acme/app",
      events: ["pr_merged"],
      prNumber: "123",
    });
    assert.equal(l.source, "github");
    if (l.source === "github") assert.equal(l.prNumber, 123);
  });

  it("auto-stops a PR watcher on merge", () => {
    const l = parseRoutineListener({
      source: "github",
      repo: "acme/app",
      events: ["pr_merged", "pr_closed"],
      prNumber: 123,
    });
    const [merged] = inboundFromGithub("pull_request", {
      action: "closed",
      pull_request: { number: 123, merged: true },
      repository: { full_name: "acme/app" },
    });
    assert.ok(merged);
    assert.equal(shouldAutoStopListener(l, merged!), true);
  });

  it("webhook listener always matches", () => {
    const l = parseRoutineListener({ source: "webhook" });
    assert.equal(
      matchRoutineListener(l, { source: "webhook", type: "ping" }),
      true,
    );
  });

  it("extracts PR number from workflow_run.pull_requests", () => {
    const l = parseRoutineListener({
      source: "github",
      repo: "acme/app",
      events: ["ci_failed"],
      prNumber: 9,
    });
    const events = inboundFromGithub("workflow_run", {
      action: "completed",
      workflow_run: {
        conclusion: "failure",
        head_branch: "feat",
        pull_requests: [{ number: 9 }],
      },
      repository: { full_name: "acme/app" },
    });
    assert.ok(events.some((e) => e.type === "ci_failed" && e.prNumber === 9));
    assert.equal(
      matchRoutineListener(l, events.find((e) => e.type === "ci_failed")!),
      true,
    );
  });
});

describe("describeListener", () => {
  it("renders a short chinese-friendly label", () => {
    const l = parseRoutineListener({
      source: "github",
      repo: "moonrend/zakura",
      events: ["pr_merged"],
    });
    assert.match(describeListener(l), /GitHub moonrend\/zakura/);
  });
});
