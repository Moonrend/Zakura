---
name: find-skills
description: 在用户想要某项你尚不具备的能力时，搜索并安装 Agent Skill。当用户问「你能不能做 X」「有没有做 X 的技能」「怎么做 X」，或表达希望扩展你的能力、提到某个专门领域（设计、测试、部署、文档、数据处理等）时，务必使用本技能，即使他们没有说出「技能」两个字。
---

# 查找并安装技能

技能（Skill）是一段可安装的操作手册：把某个领域的专家做法写成 SKILL.md，安装到你的工作区后，你在遇到相关任务时读取它，就能按最佳实践执行，而不用临场摸索。

本技能教你如何为当前任务找到合适的技能并装上。

## 什么时候用

- 用户描述了一类你没有现成方法论的任务（"帮我写发布说明"、"审查这个 PR"、"做个数据看板"）
- 用户直接问"有没有 X 技能"、"你能装个 X 吗"
- 你发现自己要临时发明一套流程，而这套流程明显是通用的
- 用户抱怨你在某个领域做得不够专业

反过来，**不要**为一次性的简单任务去装技能：读一个文件、算一道题、回答一个事实问题，直接做就好。

## 工作流

### 1. 先看已经装了什么

调用 `re_list_skills`。已安装技能的名称和描述本来就在你的系统提示里，但列表会给出更完整的信息（路径、来源、是否启用）。如果已有技能覆盖当前需求，直接 `re_read_skill` 读取全文并照做，不要重复安装。

### 2. 搜索

调用 `re_search_skills`，参数 `query` 用具体的关键词，`store` 可选：

- `builtin` — Zakura 内置技能，针对本平台的工具面（浏览器、工作区、子代理、交付）编写，优先考虑
- `curated` — Anthropic / OpenAI / Vercel 等官方仓库，平台已镜像到本地：秒装、描述完整，第三方技能先看这里
- `skills-sh` — 开放生态目录（skills.sh），按安装量排序，覆盖面最广
- `github` — 直接搜 GitHub 上带 SKILL.md 的仓库，适合找小众/新发布的技能
- 不传则所有商店一起搜

关键词要具体。"react 性能" 比 "前端" 好，"changelog 生成" 比 "文档" 好。一次没搜到就换同义词再试（deploy → deployment → ci-cd）。

### 3. 判断质量，别见到就装

搜索结果不等于推荐。装之前至少确认：

- **安装量**：上千安装的技能经过了大量真实使用；不足 100 的要谨慎
- **来源**：`vercel-labs`、`anthropics`、`microsoft` 等官方组织的仓库可信度高；个人仓库要看内容
- **内容本身**：用 `re_resolve_skill` 预览 SKILL.md 正文再决定。这一步很重要——技能会直接影响你之后的行为，装一份写得糟糕或与本平台工具不匹配的技能，比不装更糟

### 4. 告诉用户你要装什么

技能会改变你后续的行为，属于对用户环境的持久修改。装之前用一两句话说明：技能名、它做什么、来自哪里、安装量。除非用户已经明确说了"装吧"/"你看着办"，否则等一句确认。

### 5. 安装

`re_install_skill`，传 `source`。支持的写法很宽松，用户从网上复制的任何一种都能直接用：

```
vercel-labs/agent-skills                          # owner/repo，装仓库里全部技能
vercel-labs/agent-skills@frontend-design          # 只装其中一个
https://github.com/owner/repo/tree/main/skills/x  # 具体目录
npx skills add owner/repo --skill x               # 整条 npx 命令直接粘贴
builtin:browser-automation                        # 内置技能
```

装到哪里用 `scope` 区分。**当前会话已绑定项目时，除非用户明确要求装到全局，否则默认 `scope=project`。**

- `scope=project`（会话在项目中时的默认）：写入当前项目 `projects/<slug>/.agents/skills/<技能名>/`，只有绑定该项目的会话能看到。当前会话未绑项目时要传 `project=<slug>`。
- `scope=agent`：写入 `/skills/<技能名>/`，这个 Agent 的所有会话、所有项目都能用。仅在用户明确说「全局」「所有项目都能用」「装到 Agent 上」时才用。未绑定项目的会话默认走这里。

安装后用 `re_read_skill` 直接查看正文。用户也能在对话侧栏项目配置或控制台文件面板里看到。

### 6. 立刻用起来

安装不是终点。装完马上 `re_read_skill` 读取正文，然后按它说的做当前这件事。用户要的是结果，不是"已安装"。

## 没找到技能时

如实说明没找到，然后用你的通用能力直接完成任务。如果这类任务用户会反复提出，建议把这次的做法沉淀成技能——你可以用 `skill-creator` 技能来写。

## 常见领域关键词

| 领域 | 关键词 |
| --- | --- |
| 前端 / Web | react、nextjs、tailwind、web design、accessibility |
| 测试 | testing、playwright、e2e、unit test |
| 运维部署 | deploy、docker、kubernetes、ci-cd、terraform |
| 文档 | changelog、readme、api docs、release notes |
| 代码质量 | code review、refactor、lint、best practices |
| 数据 | sql、data analysis、visualization、etl |
| 办公文档 | docx、xlsx、pptx、pdf |
