# 聊天中的交互界面

Zakura 的云端和 ACP 助手可以在回复中生成交互界面。无需额外配置，直接尝试「生成一个可调整数量和单价的费用计算器」或「用可筛选的表格比较这些方案」。简单问题仍用文字回答。

首批组件包括布局、卡片、文本、分隔线、输入框、选择框、复选框、滑块、按钮、表格和单指标柱状图。绑定字段和注册的计算函数在浏览器中即时更新，只有点击继续对话按钮才会向助手发送请求。表单自动保存到当前会话，刷新后恢复；多端同时修改时会提示冲突并保留本地输入。生成界面不会清空聊天输入框里的草稿。

## 输出格式

在助手正文中使用 `json-render` 代码围栏。围栏内可以是完整 JSON spec，也可以是每行一条 JSON Patch 的 SpecStream；围栏外仍是 Markdown。只有助手消息会渲染界面。

````markdown
```json-render
{"op":"add","path":"/catalogVersion","value":1}
{"op":"add","path":"/state","value":{"quantity":2}}
{"op":"add","path":"/elements","value":{}}
{"op":"add","path":"/root","value":"main"}
{"op":"add","path":"/elements/main","value":{"type":"Card","props":{"title":"费用计算"},"children":["quantity","total","send"]}}
{"op":"add","path":"/elements/quantity","value":{"type":"Slider","props":{"label":"数量","value":{"$bindState":"/quantity"},"min":1,"max":20},"children":[]}}
{"op":"add","path":"/elements/total","value":{"type":"Text","props":{"text":{"$computed":"calculate","args":{"operation":"product","values":[{"$state":"/quantity"},10]}}},"children":[]}}
{"op":"add","path":"/elements/send","value":{"type":"Button","props":{"label":"按此数量继续"},"children":[],"on":{"press":{"action":"continueConversation","params":{"message":"按选择的数量继续"}}}}}
```
````

先输出版本、初始状态、空 `elements` 和 `root`，再添加完整组件，可以逐步显示界面。补丁只支持对象字段的 `add`、`replace`、`remove`；数组必须整体赋值。

## 本地交互

状态是最多 64 个字段的单层对象，值只能是字符串、数字、布尔值或 null。每个绑定字段都必须有类型正确的默认值。

- `$bindState: "/key"` 绑定输入组件的 `value` 或复选框的 `checked`。
- `$state: "/key"` 读取当前值。
- `$computed: "calculate"` 支持 sum、product、difference、divide、power。
- `$computed: "formatNumber"` 格式化数字，可带 digits 和 unit。
- `$computed: "filterRows"` 根据 query 筛选 rows。
- `visible` 接受布尔值或指向布尔字段的 `$state`。
- `Button.on.press` 仅支持 `setState`（本地更新）和 `continueConversation`（显式发送消息并附完整当前状态）。

不支持任意 HTML、脚本、CSS、URL、网络请求、watcher 或挂载时执行动作。生成中的界面只预览，完成校验后才可编辑。无法解析或不支持版本的内容会显示错误和可展开源码。

## 保存与回放

`PUT /api/agents/{id}/cloud/sessions/{sid}/ui-state` 继承现有鉴权和资源范围校验。请求携带 messageId、blockIndex、catalogVersion、contentHash、expectedRevision 和 state。服务端从已落库的助手正文验证界面来源，在数据库事务中检查版本并追加 `ui_state_updated` 事件。过期版本返回 409。

纯状态更新不会进入模型的对话历史。只有显式提交会发送用户消息与表单快照。状态按助手消息和内容块归属，选择不同回答分支时分别恢复。fork 仅复制分叉位置之前的状态。OpenAI gateway 会话保持只读。

## 开发

组件定义与提示词来源：`apps/web/src/lib/generative-ui-catalog.ts`；React 实现：`apps/web/src/components/chat/generative-ui/`。依赖固定为 json-render 0.21.1。新增组件或改变格式时需考虑历史版本兼容。

修改 catalog 后执行：

```sh
pnpm ui:catalog
pnpm ui:catalog:check
pnpm --filter @zakura/shared build
pnpm --filter @zakura/web typecheck
pnpm --filter @zakura/shared exec tsx --tsconfig ../../apps/web/tsconfig.json --test ../../apps/web/src/lib/generative-ui.test.ts ../../apps/web/src/lib/cloud-agent.test.ts
go -C apps/server test ./internal/runtime -run 'GenerativeUI|UIState|ACPGenerativeUI'
```

导出脚本生成 Go 嵌入的组件 schema 和提示词，服务端运行时无需 Node.js。CI 检查生成内容与前端 catalog 的一致性。
