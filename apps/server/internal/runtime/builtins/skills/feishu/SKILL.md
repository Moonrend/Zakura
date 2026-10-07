---
name: feishu
description: 使用已连接的飞书文档、多维表格与消息工具。当用户提到飞书文档、表格、群聊或发消息时使用。
---

# 飞书

唯一的写操作是发消息，而且发出去不能撤回。发之前必须确认收件会话和正文。

## 工具

- `get_current_user` — 当前账号
- `list_chats` — 会话列表（chat_id 从这里来）
- `get_document` / `get_raw_content` / `list_blocks` — 文档
- `list_tables` / `search_records` — 多维表格
- `send_message` — 发送文本（唯一写操作）

## 读文档

- 要通读全文用 `get_raw_content`（纯文本，最省 token）。
- 要按结构定位或引用某段用 `list_blocks`。
- `get_document` 只给标题与元信息，不含正文。
先判断需要哪种粒度，不要三个都调一遍。

## 多维表格

`list_tables` 拿 table_id，再 `search_records` 带条件查。不要无条件拉全表。

## 发消息

1. `list_chats` 解析出 chat_id —— 不要用群名当 receive_id。
2. 群名重复时列候选让用户确认发哪个。
3. 把最终文案原样回给用户确认后再发；发完回报目标会话名。

## 边界

不能编辑文档、不能改表格记录、不能撤回消息。用户要求这些时说明限制。
不回显 token。
