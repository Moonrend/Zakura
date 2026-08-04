/**
 * GitHub / Slack 平台连接器自检。
 */
import assert from "node:assert/strict";
import {
  githubBuiltinUrl,
  resolveGithubProduct,
  createGithubProvider,
} from "../src/providers/github/index.js";
import {
  slackBuiltinUrl,
  resolveSlackProduct,
  createSlackProvider,
} from "../src/providers/slack/index.js";

assert.equal(resolveGithubProduct("zakura://github/issues"), "issues");
assert.equal(githubBuiltinUrl("repos"), "zakura://github/repos");
assert.equal(resolveSlackProduct("zakura://slack/messages"), "messages");
assert.equal(slackBuiltinUrl("users"), "zakura://slack/users");

const github = createGithubProvider();
assert.equal(github.id, "github");
const slack = createSlackProvider();
assert.equal(slack.id, "slack");

const ghValidated = github.validateConfig?.({ product: "pulls" });
assert.equal(ghValidated?.mcpUrl, "zakura://github/pulls");

const slValidated = slack.validateConfig?.({ product: "channels" });
assert.equal(slValidated?.mcpUrl, "zakura://slack/channels");

console.log("github-slack connector self-check ok");
