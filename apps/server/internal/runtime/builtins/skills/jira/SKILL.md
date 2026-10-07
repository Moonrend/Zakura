---
name: jira
description: 使用已连接的 Jira Issues 与 Projects 工具。当用户要求用 JQL 查单、开 Issue 或看项目时使用。
---

# Jira

搜索走 JQL，所以查询的精度完全取决于你写的 JQL。宽查询会拉回上千条并挤掉上下文。

## 工具

- `search_issues` — JQL 查询
- `get_issue` — 单条详情（含描述与评论）
- `list_projects` — 项目及其 key
- `get_myself` — 当前账号
- `create_issue` / `add_comment` — 唯一两个写操作

## 写 JQL

始终带上 project 和排序，并限制条数：

```
project = ENG AND status != Done ORDER BY updated DESC
```

- 「我的」用 `assignee = currentUser()`，不要拼邮箱。
- 项目名 → 先 `list_projects` 换成 key（用户说的是名字，JQL 要 key）。
- 只有关键词时用 `text ~ "..."`，拿到候选后再 `get_issue` 读详情，别把搜索结果当完整内容。

## 写操作

`create_issue` 需要 project key + issuetype + summary。issuetype 名称各站点不同
（`Task`/`任务`/`Story`），失败时读回错误里的可选值再重试一次，不要连续盲试。
评论前先 `get_issue` 确认目标。写完回报 issue key。

## 边界

- 没有状态流转、附件、删除工具；用户要求转状态时说明限制并给出链接。
- 不回显 token；403/401 时报出缺失权限而不是重试。
