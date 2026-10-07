---
name: gitlab
description: 使用已连接的 GitLab 项目与 Issues 工具。当用户要求查 GitLab 项目或开 Issue 时使用。
---

# GitLab

每个调用都要 project 标识，且 GitLab 接受两种写法 —— 挑错会得到 404 而不是报错提示。

## 工具

- `list_projects` / `get_project` — 项目，返回数字 id 与 `path_with_namespace`
- `list_issues` / `create_issue` — Issues
- `get_current_user` — 当前账号

## project 标识

- 数字 id（如 `1234`）最稳，优先用它。
- 路径必须是完整的 `group/subgroup/project`，不能只给项目名。
- 用户给的是名字时先 `list_projects` 换 id；同名跨 group 很常见，列候选让用户确认，别挑第一个。

## 工作流

1. 解析 project → 拿到数字 id。
2. 读：`list_issues` 先筛（state、labels），需要正文再逐条取。
3. 写：`create_issue` 需要 project + 标题；描述用 Markdown。写完回报 issue iid 与链接。

## 边界

- 只能创建 Issue，不能改/关/评论，也没有 MR 工具。用户要求这些时说明限制并给链接。
- 自建实例的地址由连接器配置决定；报 404 时先怀疑 project 标识，再怀疑权限。
- 不回显 token。
