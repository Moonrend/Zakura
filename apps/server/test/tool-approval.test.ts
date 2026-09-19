import assert from "node:assert/strict";
import { test } from "node:test";
import { extractJson } from "../src/services/tool-approval.js";

test("extractJson 解析裸 JSON 对象", () => {
  assert.deepEqual(extractJson('{"decision":"allow","confidence":0.9}'), {
    decision: "allow",
    confidence: 0.9,
  });
});

test("extractJson 解析 ```json 围栏与前后缀文本", () => {
  const fenced = '好的，结果如下：\n```json\n{"decision":"deny","confidence":0.8,"rationale":"危险"}\n```\n以上。';
  assert.deepEqual(extractJson(fenced), {
    decision: "deny",
    confidence: 0.8,
    rationale: "危险",
  });
  assert.deepEqual(extractJson('前缀 {"decision":"allow","confidence":1} 后缀'), {
    decision: "allow",
    confidence: 1,
  });
});

test("extractJson 无 JSON 时返回 null", () => {
  assert.equal(extractJson(""), null);
  assert.equal(extractJson("没有结构化内容"), null);
  assert.equal(extractJson("{broken"), null);
});
