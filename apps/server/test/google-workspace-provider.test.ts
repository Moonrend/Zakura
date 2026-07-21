import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  googleWorkspaceBuiltinUrl,
  resolveGoogleWorkspaceProduct,
  scopesForProduct,
} from "../src/providers/google-workspace/types.js";
import { translateDriveQuery } from "../src/providers/google-workspace/drive.js";
import { gmailToolDefs } from "../src/providers/google-workspace/gmail.js";
import { driveToolDefs } from "../src/providers/google-workspace/drive.js";
import { calendarToolDefs } from "../src/providers/google-workspace/calendar.js";
import { peopleToolDefs } from "../src/providers/google-workspace/people.js";
import { chatToolDefs } from "../src/providers/google-workspace/chat.js";
import {
  filterToolsByPermissions,
  isToolAllowedByPermissions,
} from "../src/providers/google-workspace/tool-permissions.js";

describe("google-workspace local provider", () => {
  it("resolves product from builtin and legacy MCP hosts", () => {
    assert.equal(resolveGoogleWorkspaceProduct("zakura://google-workspace/gmail"), "gmail");
    assert.equal(resolveGoogleWorkspaceProduct("https://gmailmcp.googleapis.com/mcp/v1"), "gmail");
    assert.equal(resolveGoogleWorkspaceProduct("https://drivemcp.googleapis.com/mcp/v1"), "drive");
    assert.equal(
      resolveGoogleWorkspaceProduct("https://calendarmcp.googleapis.com/mcp/v1"),
      "calendar",
    );
    assert.equal(resolveGoogleWorkspaceProduct("zakura://google-workspace/people"), "people");
    assert.equal(resolveGoogleWorkspaceProduct("https://people.googleapis.com/mcp"), "people");
    assert.equal(resolveGoogleWorkspaceProduct("zakura://google-workspace/chat"), "chat");
    assert.equal(resolveGoogleWorkspaceProduct("https://chatmcp.googleapis.com/mcp/v1"), "chat");
    assert.equal(resolveGoogleWorkspaceProduct("https://example.com"), null);
    assert.equal(googleWorkspaceBuiltinUrl("drive"), "zakura://google-workspace/drive");
  });

  it("exposes official-aligned tool names", () => {
    const gmail = new Set(gmailToolDefs.map((t) => t.name));
    for (const n of [
      "search_threads",
      "get_thread",
      "create_draft",
      "send_message",
      "send_draft",
      "list_drafts",
      "list_labels",
      "create_label",
      "label_message",
      "unlabel_message",
      "label_thread",
      "unlabel_thread",
    ]) {
      assert.ok(gmail.has(n), n);
    }
    const drive = new Set(driveToolDefs.map((t) => t.name));
    for (const n of [
      "search_files",
      "read_file_content",
      "list_recent_files",
      "get_file_metadata",
      "get_file_permissions",
      "create_file",
      "copy_file",
      "download_file_content",
    ]) {
      assert.ok(drive.has(n), n);
    }
    const cal = new Set(calendarToolDefs.map((t) => t.name));
    for (const n of [
      "list_calendars",
      "list_events",
      "get_event",
      "create_event",
      "update_event",
      "delete_event",
      "respond_to_event",
      "suggest_time",
    ]) {
      assert.ok(cal.has(n), n);
    }
    const people = new Set(peopleToolDefs.map((t) => t.name));
    for (const n of [
      "get_user_profile",
      "list_contacts",
      "search_contacts",
      "search_directory_people",
    ]) {
      assert.ok(people.has(n), n);
    }
    const chat = new Set(chatToolDefs.map((t) => t.name));
    for (const n of [
      "search_conversations",
      "list_messages",
      "search_messages",
      "send_message",
    ]) {
      assert.ok(chat.has(n), n);
    }
  });

  it("hides gmail send tools when gmail.send permission is off by default", () => {
    const visible = filterToolsByPermissions("gmail", {}, gmailToolDefs).map((t) => t.name);
    assert.ok(visible.includes("create_draft"));
    assert.ok(!visible.includes("send_message"));
    assert.ok(!visible.includes("send_draft"));
    assert.equal(isToolAllowedByPermissions("gmail", {}, "send_message"), false);
    assert.equal(
      isToolAllowedByPermissions(
        "gmail",
        { toolPermissions: { "gmail.send": true } },
        "send_message",
      ),
      true,
    );
  });

  it("translates Drive MCP query syntax to Drive API q", () => {
    assert.match(translateDriveQuery("title contains 'hello'"), /name contains 'hello'/);
    assert.equal(translateDriveQuery("parentId = 'root'"), "'root' in parents");
    assert.equal(translateDriveQuery("owner = 'me'"), "'me' in owners");
    assert.equal(translateDriveQuery("sharedWithMe = true"), "sharedWithMe");
  });

  it("scopes include product APIs", () => {
    assert.match(scopesForProduct("gmail"), /gmail\.readonly/);
    assert.match(scopesForProduct("gmail"), /gmail\.send/);
    assert.match(scopesForProduct("drive"), /drive\.file/);
    assert.match(scopesForProduct("calendar"), /calendar\.events/);
    assert.match(scopesForProduct("people"), /contacts\.readonly/);
    assert.match(scopesForProduct("people"), /directory\.readonly/);
    assert.match(scopesForProduct("chat"), /chat\.messages/);
  });
});
