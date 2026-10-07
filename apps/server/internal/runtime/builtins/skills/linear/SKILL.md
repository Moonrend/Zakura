---
name: linear
description: 使用已连接的 Linear Issues、Projects 与 Teams 工具。当用户要求查 Issue、开单或看项目进度时使用。
---

# Linear

Linear 的写操作都要求 teamId，而用户几乎只会说团队名。先解析 ID，再动手。

## 工具

- `list_teams` — 团队及其 id、key
- `list_issues` / `get_issue` — 按团队/状态筛列表，取单条详情
- `list_projects` / `get_project` — 项目与进度
- `create_issue` / `create_comment` — 唯一两个写操作
- `viewer` — 当前账号，用于「分配给我」这类指代

## 解析顺序

1. 团队名 → `list_teams` 取 id。名称重复或模糊时列出候选让用户选，不要猜。
2. 「我的」「分给我」→ `viewer` 取当前用户 id，不要用邮箱猜。
3. Issue 标识符（`ENG-123`）可直接给 `get_issue`；只有标题时先 `list_issues` 定位。

## 写操作

创建 Issue 前必须齐备 teamId + 标题；优先级、负责人、项目缺失就用默认值，不要虚构。
评论前先 `get_issue` 确认是目标那条 —— 编号相近的单据很容易搞错。
写完回报 Issue 标识符与链接，方便用户核对。

## 边界

- 没有删除或状态流转工具；用户要求关单/改状态时说明只能评论，并给出 Issue 链接。
- 不回显 token。权限不足时报出缺少的 scope，而不是重试。
