---
name: github
description: 使用已连接的 GitHub 仓库、Issues、PR 与搜索工具完成开发协作。当用户要求查仓库、开 Issue、审 PR 或搜代码时使用。
---

# GitHub

所有调用都要 owner + repo。用户通常只说仓库名，先解析清楚再动手。

## 工具

- `list_repos` / `get_repo` / `list_branches` — 仓库与分支
- `search_repositories` / `search_code` / `search_issues` — 跨仓库搜索
- `list_issues` / `get_issue` / `create_issue` / `create_issue_comment`
- `list_pulls` / `get_pull` / `create_pull`

## 先搜后读

搜索返回的是摘要，不是正文。定位到目标后再用 `get_issue` / `get_pull` 取详情，
不要把搜索结果当完整内容回答。

`search_code` 走 GitHub 代码搜索语法，务必带限定符收窄：

```
repo:owner/name path:src extension:ts "functionName"
```

无限定符的关键词搜索会跨全站返回噪音。

## 创建 PR

`create_pull` 需要 head 与 base 两个分支。开之前：

1. `list_branches` 确认两个分支都真实存在（拼错分支名只会得到一个含糊的 422）。
2. 确认方向：head 是改动来源，base 是合入目标 —— 反了就是一个反向 PR。
3. 默认分支不一定是 `main`，用 `get_repo` 读，别假设。

## 写操作

创建 Issue/PR、发评论前，把仓库、标题、目标分支和正文一并给用户确认。
写完回报编号与链接。同一件事不要重复创建 —— 先 `search_issues` 查有没有已存在的单。

## 边界

不能合并 PR、不能推送代码、不能改仓库设置。需要提交代码时用工作区里的 `git` 与
`gh` 命令，而不是这些工具。
不回显 OAuth token；403 时报出缺少的 scope。
