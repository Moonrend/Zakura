---
name: notion
description: 使用已连接的 Notion 页面、数据库与用户工具完成知识库工作。当用户要求搜索 Notion、读写页面或查询数据库时使用。
---

# Notion

Notion 的内容在**块**里，不在页面对象里。`get_page` 只给属性和元信息 ——
要正文必须 `list_children`。这是最容易答错的一点。

## 工具

- `search` — 按关键词跨工作区定位页面/数据库
- `get_page` — 页面属性（**不含正文**）
- `list_children` — 页面的块，正文在这里
- `get_database` / `query_database` — schema 与记录
- `create_page` / `append_blocks` — 两个写操作
- `get_me` / `list_users` — 账号与成员

## 读取顺序

1. `search` 定位，拿到 id 和它是 page 还是 database。
2. 页面：`get_page` 看属性 → `list_children` 读正文。嵌套块要按需再展开子块，
   不要一次递归整棵树。
3. 数据库：先 `get_database` 读 schema，再 `query_database` —— 属性名和类型必须
   跟 schema 完全一致，否则过滤条件会被拒。

## 写操作

- `create_page` 必须有 parent（页面或数据库 id）。往数据库里建页时，properties
  要匹配 schema，必填属性不能省。
- `append_blocks` 追加到末尾，不能改写已有块。
- 建页/追加前把父级位置和内容摘要给用户确认。写完回报页面链接。

## 边界

不能删除页面或块、不能改已有块、不能改数据库 schema。
只能看到集成被授权的页面 —— 搜不到时先怀疑没共享给集成，而不是不存在。
不回显 OAuth token。
