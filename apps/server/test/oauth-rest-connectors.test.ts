/**
 * 新增 OAuth REST 连接器自检。
 */
import assert from "node:assert/strict";
import { createNotionProvider, resolveNotionProduct } from "../src/providers/notion/index.js";
import { createLinearProvider, resolveLinearProduct } from "../src/providers/linear/index.js";
import { createFeishuProvider, resolveFeishuProduct } from "../src/providers/feishu/index.js";
import { createDiscordProvider, resolveDiscordProduct } from "../src/providers/discord/index.js";
import { createGitlabProvider, resolveGitlabProduct } from "../src/providers/gitlab/index.js";
import { createJiraProvider, resolveJiraProduct } from "../src/providers/jira/index.js";

assert.equal(resolveNotionProduct("zakura://notion/pages"), "pages");
assert.equal(resolveLinearProduct("zakura://linear/issues"), "issues");
assert.equal(resolveFeishuProduct("zakura://feishu/im"), "im");
assert.equal(resolveDiscordProduct("zakura://discord/guilds"), "guilds");
assert.equal(resolveGitlabProduct("zakura://gitlab/projects"), "projects");
assert.equal(resolveJiraProduct("zakura://jira/issues"), "issues");

for (const factory of [
  createNotionProvider,
  createLinearProvider,
  createFeishuProvider,
  createDiscordProvider,
  createGitlabProvider,
  createJiraProvider,
]) {
  const p = factory();
  assert.ok(p.id);
  assert.ok(p.validateConfig);
}

assert.equal(
  createNotionProvider().validateConfig?.({ product: "databases" })?.mcpUrl,
  "zakura://notion/databases",
);
assert.equal(
  createJiraProvider().validateConfig?.({ product: "projects" })?.mcpUrl,
  "zakura://jira/projects",
);

console.log("oauth-rest connectors self-check ok");
