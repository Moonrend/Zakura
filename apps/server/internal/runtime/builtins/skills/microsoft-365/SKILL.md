---
name: microsoft-365
description: 使用已连接的 Outlook、OneDrive、SharePoint、Teams 与 Microsoft Graph 完成 Microsoft 365 工作。当用户提到微软邮箱、会议、文件、Teams、组织目录或 Entra 账号时使用。
---

# Microsoft 365

通过 Microsoft Graph 组合 Outlook、文件、Teams 与组织目录能力。每一步使用最小权限和最窄查询，不把搜索结果当成已确认事实。

## 能力选择

- Outlook：邮件、草稿、日历和会议。所有时间都显式保留时区。
- OneDrive / SharePoint：搜索与读取文件；同名文件要用站点、路径、所有者和修改时间消歧。
- Teams：团队、频道、聊天与消息。发送或回复前确认目标会话。
- Graph Directory：解析用户、群组与组织身份；不要仅凭显示名称执行写操作。

## 工作流

1. 先检查当前可用 MCP 与权限，明确是委托用户权限还是应用权限。
2. 搜索时先限制资源、时间范围和人员，再读取详情；分页结果按相关性停止，不做无界扫描。
3. 跨服务任务先解析稳定 ID。例如从邮件附件更新 Teams 讨论，应先确定消息、文件 driveItem 与频道 ID。
4. 写操作前核对目标租户、账号、收件人、频道、日期和影响范围。用户明确要求的单次动作可直接执行；含糊或批量动作必须先确认。
5. 汇报实际完成的动作、Graph/MCP 返回的资源链接或 ID，以及任何权限不足。

## 安全

不展示 access token、refresh token、Client Secret 或原始 Authorization header。遇到跨租户资源或权限拒绝时停止并说明需要的权限，不尝试绕过管理员策略。
