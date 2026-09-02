/**
 * session/prompt 多模态内容块规划。
 *
 * 核心约束只有一条，但违反的代价很高：能力未声明就绝不内联。
 * ACP agent 收到不支持的 ContentBlock 会拒掉**整轮** prompt——
 * 用户看到的是"发消息没反应"，而不是"图片没发出去"。
 * 所以这里对每种降级路径都钉一个用例。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACP_INLINE_ATTACHMENT_MAX_BYTES,
  acpAttachmentUri,
  planAcpPromptBlocks,
  type AcpPromptAttachment,
} from "../src/acp.js";

const ROOT = "/workspace";

function img(overrides: Partial<AcpPromptAttachment> = {}): AcpPromptAttachment {
  return {
    name: "shot.png",
    path: "/uploads/shot.png",
    mime: "image/png",
    size: 1024,
    kind: "image",
    ...overrides,
  };
}

describe("acpAttachmentUri", () => {
  it("生成绝对 file:// URI", () => {
    assert.equal(acpAttachmentUri(ROOT, "/uploads/a.png"), "file:///workspace/uploads/a.png");
  });

  it("容忍缺失的前导斜杠与重复的尾部斜杠", () => {
    assert.equal(acpAttachmentUri("/workspace/", "uploads/a.png"), "file:///workspace/uploads/a.png");
  });
});

describe("planAcpPromptBlocks", () => {
  it("无附件时只保留文本", () => {
    const plan = planAcpPromptBlocks({ text: "hi", workspaceRoot: ROOT });
    assert.equal(plan.text, "hi");
    assert.deepEqual(plan.items, []);
  });

  it("agent 声明 image 能力时内联图片", () => {
    const plan = planAcpPromptBlocks({
      text: "看图",
      attachments: [img()],
      capabilities: { image: true },
      workspaceRoot: ROOT,
    });
    assert.equal(plan.items.length, 1);
    const item = plan.items[0]!;
    assert.equal(item.action, "inline");
    assert.equal(item.action === "inline" && item.blockType, "image");
    assert.equal(item.uri, "file:///workspace/uploads/shot.png");
  });

  it("未声明 image 能力时降级为 resource_link 而非丢弃", () => {
    const plan = planAcpPromptBlocks({
      text: "看图",
      attachments: [img()],
      capabilities: {},
      workspaceRoot: ROOT,
    });
    const item = plan.items[0]!;
    assert.equal(item.action, "link");
    assert.equal(item.action === "link" && item.reason, "capability");
  });

  it("capabilities 为 undefined 时按全不支持处理", () => {
    const plan = planAcpPromptBlocks({
      text: "看图",
      attachments: [img()],
      workspaceRoot: ROOT,
    });
    assert.equal(plan.items[0]!.action, "link");
  });

  it("超过内联上限的图片降级为链接，即使能力已声明", () => {
    const plan = planAcpPromptBlocks({
      text: "大图",
      attachments: [img({ size: ACP_INLINE_ATTACHMENT_MAX_BYTES + 1 })],
      capabilities: { image: true },
      workspaceRoot: ROOT,
    });
    const item = plan.items[0]!;
    assert.equal(item.action, "link");
    assert.equal(item.action === "link" && item.reason, "too-large");
  });

  it("恰好等于上限的图片仍然内联（边界不越界）", () => {
    const plan = planAcpPromptBlocks({
      text: "临界",
      attachments: [img({ size: ACP_INLINE_ATTACHMENT_MAX_BYTES })],
      capabilities: { image: true },
      workspaceRoot: ROOT,
    });
    assert.equal(plan.items[0]!.action, "inline");
  });

  it("音频按 audio 能力独立判定，不受 image 能力影响", () => {
    const audio: AcpPromptAttachment = {
      name: "v.mp3",
      path: "/uploads/v.mp3",
      mime: "audio/mpeg",
      size: 2048,
      kind: "file",
    };
    const denied = planAcpPromptBlocks({
      text: "",
      attachments: [audio],
      capabilities: { image: true },
      workspaceRoot: ROOT,
    });
    assert.equal(denied.items[0]!.action, "link");

    const allowed = planAcpPromptBlocks({
      text: "",
      attachments: [audio],
      capabilities: { audio: true },
      workspaceRoot: ROOT,
    });
    const item = allowed.items[0]!;
    assert.equal(item.action, "inline");
    assert.equal(item.action === "inline" && item.blockType, "audio");
  });

  it("普通文件恒为链接，且不标降级原因（并非降级）", () => {
    const plan = planAcpPromptBlocks({
      text: "",
      attachments: [
        { name: "a.pdf", path: "/uploads/a.pdf", mime: "application/pdf", size: 10, kind: "file" },
      ],
      capabilities: { image: true, audio: true, embeddedContext: true },
      workspaceRoot: ROOT,
    });
    const item = plan.items[0]!;
    assert.equal(item.action, "link");
    assert.equal(item.action === "link" && item.reason, undefined);
  });

  it("kind=image 但 mime 缺失时仍按图片处理", () => {
    const plan = planAcpPromptBlocks({
      text: "",
      attachments: [img({ mime: "" })],
      capabilities: { image: true },
      workspaceRoot: ROOT,
    });
    assert.equal(plan.items[0]!.action, "inline");
  });

  it("跳过路径为空的脏数据而不是抛错", () => {
    const plan = planAcpPromptBlocks({
      text: "",
      attachments: [img({ path: "" }), img()],
      capabilities: { image: true },
      workspaceRoot: ROOT,
    });
    assert.equal(plan.items.length, 1);
  });
});