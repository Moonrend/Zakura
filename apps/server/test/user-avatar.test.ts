import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { avatarFilePath, saveUserAvatar, AVATAR_ID } from "../src/services/identity/account.js";

describe("user avatar", () => {
  it("拒绝路径穿越的 userId", () => {
    assert.equal(AVATAR_ID.test("../etc/passwd"), false);
    assert.ok(AVATAR_ID.test("user_abc-1"));
  });

  it("拒绝非 JPEG", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zakura-avatar-"));
    try {
      const db = {
        update: () => ({
          set: () => ({
            where: async () => undefined,
          }),
        }),
      };
      await assert.rejects(
        saveUserAvatar(db as never, dir, "user_abc-1", new Uint8Array([1, 2, 3])),
        /JPEG/,
      );
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1]);
      const rev = await saveUserAvatar(db as never, dir, "user_abc-1", jpeg);
      assert.ok(rev > 0);
      assert.ok(avatarFilePath(dir, "user_abc-1").includes("avatars"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
