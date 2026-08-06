import assert from "node:assert/strict";
import {
  accessDeniedHint,
  formatHelp,
  formatStartWelcome,
  formatWhoami,
  isPublicSlashCommand,
  normalizeCommandName,
  parseSlashFromText,
  REMOTE_SLASH_MENU,
  settingsHasPending,
} from "../src/services/remote-channel-commands.js";
import { isRemoteSenderAllowed } from "../src/services/remote-agent-ingress.js";

assert.equal(normalizeCommandName("/Help@MyBot"), "help");
assert.equal(normalizeCommandName("STATUS"), "status");
assert.equal(isPublicSlashCommand("/request"), true);
assert.equal(isPublicSlashCommand("/new"), false);

{
  const parsed = parseSlashFromText("/new@bot_x please");
  assert.ok(parsed);
  assert.equal(parsed!.command, "/new");
  assert.equal(parsed!.args, "please");
  assert.equal(parseSlashFromText("hello"), null);
}

assert.ok(formatHelp(false).includes("/request"));
assert.ok(!formatHelp(false).includes("/new"));
assert.ok(formatHelp(true).includes("/new"));
assert.ok(!formatHelp(true).includes("/approve"));
assert.ok(formatStartWelcome(false, "42").includes("`42`"));
assert.ok(accessDeniedHint("u1").includes("/request"));
assert.ok(
  formatWhoami({
    userKey: "u1",
    allowed: false,
    allowAll: false,
    pending: true,
  }).includes("待审批"),
);

assert.equal(REMOTE_SLASH_MENU.length >= 6, true);
assert.equal(
  settingsHasPending({ pendingUsers: [{ userKey: "U1", requestedAt: "2026-01-01" }] }, "u1"),
  true,
);

// 默认验证：无白名单且未开放 → 拒绝
assert.equal(isRemoteSenderAllowed({}, "anyone"), false);
assert.equal(isRemoteSenderAllowed({ allowAll: false }, "anyone"), false);
assert.equal(isRemoteSenderAllowed({ allowAll: true }, "anyone"), true);
assert.equal(isRemoteSenderAllowed({ allowedUsers: ["42"] }, "42"), true);

console.log("remote-channel-commands self-check ok");
