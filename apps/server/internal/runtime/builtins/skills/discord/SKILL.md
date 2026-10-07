---
name: discord
description: 使用已连接的 Discord 服务器与用户资料工具。当用户要求查看所在服务器或 Discord 账号信息时使用。
---

# Discord

这是**只读**连接器，走用户 OAuth。发频道消息、读消息历史、管理成员都需要 Bot Token
加上 guild 内授权，这里没有 —— 先认清边界，别去尝试不存在的操作。

## 工具

- `list_guilds` — 当前用户加入的服务器（id、名称、权限位）
- `get_guild` — 单个服务器详情
- `get_me` — 当前 Discord 账号
- `list_connections` — 该账号关联的外部账号（Steam、GitHub 等）

## 工作流

1. `list_guilds` 拿到 id，再按需 `get_guild`；不要对每个服务器都展开详情。
2. 用户说服务器名时在 `list_guilds` 结果里匹配；重名就列候选。
3. `list_connections` 属于敏感个人数据，只在用户明确要求时调用。

## 边界

用户要求「发消息到某频道」「看聊天记录」「踢人/改权限」时，直接说明本连接器只读、
需要配置 Bot 才能做，并停下 —— 不要转而去猜别的工具。
需要发消息的场景可以改用 Slack 或飞书连接器。

不回显 token。
