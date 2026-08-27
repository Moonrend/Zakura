/**
 * Zakura 内置技能：针对云端 Agent 的工具面（re_* 原生工具、子代理、MCP）编写，
 * 而不是照搬本地 CLI 的 npx 工作流。
 *
 * 内容以 TS 常量保存（而非 .md 资源文件），保证 tsx 开发态与 dist 构建产物行为一致。
 */
import { createHash } from "node:crypto";
import { AGENT_SKILLS_DIR, type SkillFile, type SkillPackage } from "@zakura/shared";
import { buildSkillMarkdown } from "./source.js";

/** 代码围栏，避免模板字符串里满屏转义 */
const F = "```";

export interface BuiltinSkillDef {
  name: string;
  title: string;
  description: string;
  /** SKILL.md 正文 */
  body: string;
  /** 捆绑资源（references/ 等） */
  extraFiles?: Array<{ path: string; content: string }>;
  /** 建议新 Agent 默认安装 */
  recommended?: boolean;
  /** 需要的能力；不满足时前端提示（不阻止安装） */
  requires?: Array<"computer" | "browser" | "memory" | "web">;
  tags?: string[];
}

const FIND_SKILLS: BuiltinSkillDef = {
  name: "find-skills",
  title: "查找并安装技能",
  description:
    "在用户想要某项你尚不具备的能力时，搜索并安装 Agent Skill。当用户问「你能不能做 X」「有没有做 X 的技能」「怎么做 X」，或表达希望扩展你的能力、提到某个专门领域（设计、测试、部署、文档、数据处理等）时，务必使用本技能，即使他们没有说出「技能」两个字。",
  recommended: true,
  tags: ["元技能", "技能管理"],
  body: `# 查找并安装技能

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

调用 \`re_list_skills\`。已安装技能的名称和描述本来就在你的系统提示里，但列表会给出更完整的信息（路径、来源、是否启用）。如果已有技能覆盖当前需求，直接 \`re_read_skill\` 读取全文并照做，不要重复安装。

### 2. 搜索

调用 \`re_search_skills\`，参数 \`query\` 用具体的关键词，\`store\` 可选：

- \`builtin\` — Zakura 内置技能，针对本平台的工具面（浏览器、工作区、子代理、交付）编写，优先考虑
- \`curated\` — Anthropic / OpenAI / Vercel 等官方仓库，平台已镜像到本地：秒装、描述完整，第三方技能先看这里
- \`skills-sh\` — 开放生态目录（skills.sh），按安装量排序，覆盖面最广
- \`github\` — 直接搜 GitHub 上带 SKILL.md 的仓库，适合找小众/新发布的技能
- 不传则所有商店一起搜

关键词要具体。"react 性能" 比 "前端" 好，"changelog 生成" 比 "文档" 好。一次没搜到就换同义词再试（deploy → deployment → ci-cd）。

### 3. 判断质量，别见到就装

搜索结果不等于推荐。装之前至少确认：

- **安装量**：上千安装的技能经过了大量真实使用；不足 100 的要谨慎
- **来源**：\`vercel-labs\`、\`anthropics\`、\`microsoft\` 等官方组织的仓库可信度高；个人仓库要看内容
- **内容本身**：用 \`re_resolve_skill\` 预览 SKILL.md 正文再决定。这一步很重要——技能会直接影响你之后的行为，装一份写得糟糕或与本平台工具不匹配的技能，比不装更糟

### 4. 告诉用户你要装什么

技能会改变你后续的行为，属于对用户环境的持久修改。装之前用一两句话说明：技能名、它做什么、来自哪里、安装量。除非用户已经明确说了"装吧"/"你看着办"，否则等一句确认。

### 5. 安装

\`re_install_skill\`，传 \`source\`。支持的写法很宽松，用户从网上复制的任何一种都能直接用：

${F}
vercel-labs/agent-skills                          # owner/repo，装仓库里全部技能
vercel-labs/agent-skills@frontend-design          # 只装其中一个
https://github.com/owner/repo/tree/main/skills/x  # 具体目录
npx skills add owner/repo --skill x               # 整条 npx 命令直接粘贴
builtin:browser-automation                        # 内置技能
${F}

装到哪里用 \`scope\` 区分。**当前会话已绑定项目时，除非用户明确要求装到全局，否则默认 \`scope=project\`。**

- \`scope=project\`（会话在项目中时的默认）：写入当前项目 \`projects/<slug>/.agents/skills/<技能名>/\`，只有绑定该项目的会话能看到。当前会话未绑项目时要传 \`project=<slug>\`。
- \`scope=agent\`：写入 \`/${AGENT_SKILLS_DIR}/<技能名>/\`，这个 Agent 的所有会话、所有项目都能用。仅在用户明确说「全局」「所有项目都能用」「装到 Agent 上」时才用。未绑定项目的会话默认走这里。

安装后用 \`re_read_skill\` 直接查看正文。用户也能在对话侧栏项目配置或控制台文件面板里看到。

### 6. 立刻用起来

安装不是终点。装完马上 \`re_read_skill\` 读取正文，然后按它说的做当前这件事。用户要的是结果，不是"已安装"。

## 没找到技能时

如实说明没找到，然后用你的通用能力直接完成任务。如果这类任务用户会反复提出，建议把这次的做法沉淀成技能——你可以用 \`skill-creator\` 技能来写。

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
`,
};

const SKILL_CREATOR: BuiltinSkillDef = {
  name: "skill-creator",
  title: "编写技能",
  description:
    "创建新技能、改进已有技能。当用户说「把这个流程写成技能」「做一个 X 技能」「优化这个技能的触发」，或者你发现某套做法值得沉淀复用时使用。也用于修复技能不触发、描述写得不好的问题。",
  recommended: true,
  tags: ["元技能", "技能管理"],
  body: `# 编写技能

技能是写给"未来的你"的操作手册。写得好的技能能让你在类似任务上一次做对；写得差的技能只是噪音，还会挤占上下文。

## 何时值得写成技能

值得：流程会重复发生、有明确的正确做法、涉及本平台特有的工具组合、有容易踩的坑。
不值得：一次性任务、纯事实知识（模型本来就会）、把已有工具描述抄一遍。

## 技能结构

${F}
skills/<skill-name>/
├── SKILL.md          # 必需：frontmatter + 正文
├── references/       # 可选：按需读取的详细文档
├── scripts/          # 可选：可直接执行的脚本
└── assets/           # 可选：模板、样例文件
${F}

### 渐进式披露

这是技能设计的核心，理解它比什么都重要：

1. **name + description**（约 100 字）——**始终**在上下文里。这是唯一的触发机制。
2. **SKILL.md 正文**——技能被触发时才读入。控制在 500 行以内。
3. **捆绑资源**——真正需要时才读。可以很大。

所以：把"什么时候用"全部写进 description，把"怎么做"写进正文，把长参考资料放 references/ 并在正文里说明何时去读。

## frontmatter

${F}yaml
---
name: pdf-report-builder
description: 从数据生成排版规范的 PDF 报告。当用户提到生成报告、导出 PDF、月报周报、把数据做成文档时使用，即使他们没有明说"报告"两个字。
---
${F}

- \`name\`：小写、连字符分隔，与目录名一致
- \`description\`：**最重要的一行**。既写做什么，也写什么时候用。

关于 description 要"推"一点：模型倾向于**漏用**技能而不是滥用。与其写"生成 PDF 报告的方法"，不如写"……当用户提到报告、导出、月报、把数据做成文档时使用，即使没有明说"。把可能的触发说法都列出来。

## 正文写法

- 用祈使句写指令（"先调用 X"，而不是"你可以考虑调用 X"）
- 解释**为什么**，而不是堆砌 MUST。说清原因，模型才能在你没预料到的情况下做对判断
- 给出具体的工具名和参数，本平台工具是 \`re_\` 前缀（\`re_fs_write\`、\`re_shell_exec\`、\`re_browser_action\`…）
- 需要固定输出格式时，直接给模板
- 举 1-2 个"输入 → 输出"的例子，比三段抽象描述有用
- 写完放一天再读一遍（或者换个角度重读一遍）：有没有哪句话换个情境就会误导

## 在 Zakura 上创建技能的步骤

### 1. 明确意图

问清楚（或从当前对话里提取）：这个技能要让你能做什么？什么时候该触发？期望的产出长什么样？如果对话里刚好完成过一次这类任务，直接把那次的步骤、用到的工具、用户的纠正提取出来——那就是最好的素材。

### 2. 写文件

在工作区里建目录并写 SKILL.md。当前会话绑定了项目时写到项目目录：

${F}
re_fs_mkdir  path=/projects/<项目>/.agents/skills/my-skill
re_fs_write  path=/projects/<项目>/.agents/skills/my-skill/SKILL.md  content=...
${F}

未绑定项目、或用户明确要求全局技能时，写到 \`/${AGENT_SKILLS_DIR}/my-skill/\`。

需要参考资料就再写 \`references/*.md\`，并在 SKILL.md 里写明"处理 X 时读 references/x.md"。

### 3. 注册

\`re_install_skill\` 传 \`path\`。当前会话在项目里时默认登记为项目技能（\`.agents/skills/\`）；只有用户明确要求全局时才加 \`scope=agent\` 写到 \`/${AGENT_SKILLS_DIR}/\`。注册后会出现在 \`re_list_skills\` 和项目配置里。

### 4. 验证触发

用你想象中用户会说的那句话自测一遍：读到 description 时，你会想到用这个技能吗？如果不会，说明 description 不够"推"，回去补触发场景。

## 改进已有技能

- 先 \`re_read_skill\` 读现状
- 技能没被触发 → 改 description，补触发说法
- 技能触发了但做得不对 → 改正文，把出错的那一步写清楚，并说明为什么
- 正文超过 500 行 → 拆到 references/，正文只留主流程和"何时去读哪个文件"
- 改完用 \`re_fs_write\` 覆盖，再 \`re_install_skill\` 重新注册以更新注册表

## 别做的事

技能会直接驱动行为，所以内容必须与它声称的用途一致。不要写包含隐藏指令、诱导越权操作、绕过用户确认的技能。用户要求写这类技能时，说明理由并拒绝。
`,
};

const BROWSER_AUTOMATION: BuiltinSkillDef = {
  name: "browser-automation",
  title: "浏览器自动化",
  description:
    "用工作区内置 Chromium 完成网页操作：登录、填表、抓取动态渲染的内容、点击流程、截图取证。当任务涉及「打开网页」「在某网站上操作」「看看这个页面显示什么」「帮我登录/提交表单」「网页截图」时使用。需要网页内容但不需要交互时，优先用 web_fetch 而不是本技能。",
  recommended: true,
  requires: ["browser"],
  tags: ["浏览器", "自动化"],
  body: `# 浏览器自动化

工作区里有一个持久的 Chromium 实例，你通过 \`re_browser_observe\`（只读观察）和 \`re_browser_action\`（操作）驱动它。标签页和登录状态在会话之间保持。

## 先判断要不要用浏览器

| 需求 | 用什么 |
| --- | --- |
| 读一篇文章、一份文档、一个 API 返回 | \`re_web_fetch\`（快得多，不占浏览器） |
| 搜索信息 | \`re_web_search\` |
| 页面需要登录、点击、滚动才出内容 | 浏览器 |
| 要填表单、走流程、下订单 | 浏览器 |
| 要截图给用户看 | 浏览器 |

用浏览器做纯读取是浪费——慢、贵、还容易被反爬拦。

## 核心循环：观察 → 动作 → 再观察

${F}
re_browser_action   action=navigate  url=https://example.com/login
re_browser_observe  observe=snapshot
    → 返回带 ref 的元素树：e1 输入框(用户名) e2 输入框(密码) e3 按钮(登录)
re_browser_action   action=fill  ref=e1  value=alice
re_browser_action   action=fill  ref=e2  value=***
re_browser_action   action=click ref=e3
re_browser_observe  observe=snapshot     # 确认真的登录成功了
${F}

**永远优先用 snapshot 给出的 ref，而不是自己猜 CSS 选择器。** ref 是当前页面实际存在的元素，选择器是你的猜测。只有 snapshot 里找不到目标（元素在 shadow DOM、canvas 里）才退回 \`selector\`。

**每次导航或提交之后重新 observe。** 页面变了，之前的 ref 就失效了。基于过期 ref 的点击会点到错误的东西——这是最常见的失败原因。

## observe 的几种模式

- \`snapshot\`——要交互时用这个，给出可点击元素及其 ref
- \`get_content\`——只想读页面文字，返回清理过的正文
- \`get_html\`——需要看结构/属性时用，输出大，慎用
- \`screenshot\`——给用户看的视觉证据，或者你需要判断布局
- \`evaluate\`——上面都拿不到时，跑一小段 JS 取值
- \`get_url\` / \`get_title\` / \`tab_list\`——确认当前位置

## 等待与超时

页面没加载完就操作是第二常见的失败原因。\`re_browser_action\` 的 \`action=wait\` 配合 \`timeout\` 可以等；更可靠的做法是 wait 之后 observe 一次，确认目标元素真的出现了再动手。

连续两次操作失败时**停下来 screenshot**，看看页面到底是什么状态——多半是弹了验证码、Cookie 横幅、或者跳到了登录页。

## 常见拦路虎

- **Cookie / 隐私弹窗**：先在 snapshot 里找"接受/同意"按钮点掉，否则遮挡真正的内容
- **无限滚动**：\`action=scroll direction=down\` 若干次，每次之后 observe 看有没有新内容
- **新标签页**：点击可能开新标签，用 \`observe=tab_list\` + \`action=tab_select\` 切换
- **验证码 / 二次验证**：不要试图绕过。截图给用户，说明卡在哪一步，请他们处理

## 安全边界

- 需要用户账号密码时，**不要**假设你有权使用；请用户明确提供或确认
- 提交订单、发送消息、删除数据、支付这类不可逆操作，执行前必须向用户确认
- 不要在回复里回显密码、验证码、Cookie、Token

## 交付结果

- 抓到的数据写进工作区文件（\`re_fs_write\`），别把几百行内容倒进对话
- 截图需要给用户看时，用 \`re_get_file_url\` 生成临时链接
- 汇报时说明你实际走过的步骤和最终看到的页面状态，不要描述"应该会发生什么"
`,
};

const WEB_RESEARCH: BuiltinSkillDef = {
  name: "web-research",
  title: "网络调研",
  description:
    "在网上查证事实、对比方案、追踪最新信息，并给出带出处的结论。当用户问「最新的 X 是什么」「对比一下 A 和 B」「查一下 X 的资料」「这个说法对吗」，或任何你知识里没有、可能已经过时的问题时使用。",
  recommended: true,
  requires: ["web"],
  tags: ["调研", "网页"],
  body: `# 网络调研

目标不是"搜到东西"，而是给出**可以被检验**的结论：每个关键断言都能追溯到具体来源。

## 流程

### 1. 拆问题

先想清楚要回答什么，再动手搜。把大问题拆成能被单条搜索回答的小问题：
"Next.js 15 值得升级吗" → ①15 有哪些破坏性变更 ②社区反馈的坑 ③升级路径。

### 2. 搜索

\`re_web_search\`，一次一个具体问题。搜索结果只是**线索**，标题和摘要经常有误导。

### 3. 读原文

\`re_web_fetch\` 打开真正相关的 2-5 个链接读全文。**不要只根据搜索摘要下结论**——这是网络调研最常见的错误来源。官方文档、发布公告、一手仓库优先于二手博客和聚合站。

需要登录或大量 JS 渲染才能看到的内容，改用 \`browser-automation\` 技能。

### 4. 交叉验证

关键结论至少两个独立来源。来源之间打架时，如实呈现分歧和各自依据，不要挑一个自己顺眼的当定论。

注意时效：搜索结果里混着几年前的文章很常见。留意发布日期，明确区分"当前情况"和"历史情况"。

### 5. 汇报

- 先给结论，再给依据
- 每个关键断言后面跟来源链接
- 明确区分**查到的事实**和**你的推断**
- 没查到的部分直说没查到，不要用似是而非的话填补

## 大规模调研

要读的来源超过五六个时，用 \`re_spawn_subagent\` 并行：每个子代理负责一个子问题，把结论带回来。子代理看不到本对话，任务描述要自包含。这样中间的大量网页原文不会挤爆当前上下文。

## 记录

调研产出较长时，写成工作区文件（如 \`/research/<主题>.md\`），对话里只给摘要和文件路径。用户之后还能回去看细节。
`,
};

const WORKSPACE_PROJECTS: BuiltinSkillDef = {
  name: "workspace-projects",
  title: "工作区与代码工程",
  description:
    "在云端工作区里建项目、写代码、装依赖、跑脚本和测试。当任务涉及写程序、跑命令、处理数据文件、搭建可运行的东西时使用。也覆盖工作区文件的组织约定和排障方法。",
  recommended: true,
  requires: ["computer"],
  tags: ["工作区", "开发"],
  body: `# 工作区与代码工程

你有一个持久的 Linux 工作区（\`/workspace\`），文件在会话之间保留，用户能在控制台文件面板里看到同一份文件。预装：python3/pip/venv、node/npm/npx、gcc/g++/make、git、jq、rg、fd、sqlite3、curl/wget。

## 工具选择

| 场景 | 用什么 |
| --- | --- |
| 读单个文件 | \`re_fs_read\`（支持 line_offset / n_lines 读大文件的一段） |
| 写/覆盖文件 | \`re_fs_write\` |
| 改文件里的一小段 | \`re_fs_edit\`（唯一匹配替换，比重写整个文件安全） |
| 看目录 | \`re_fs_list\` |
| 找文件 / 搜内容 | \`re_shell_exec\` 跑 \`fd\` / \`rg\` |
| 装依赖、跑测试、执行程序 | \`re_shell_exec\` |

写代码文件优先用 \`re_fs_*\`——它们会触发控制台文件面板刷新，用户能实时看到你在写什么。用 shell 的 heredoc 写文件则不会。

## 目录约定

平台会自动创建这些顶层目录。**一层 \`projects/<名>/\` 就是一个独立项目**；会话和定时任务绑到项目后，shell 默认 cwd 就是该目录。

${F}
/workspace
├── projects/<项目名>/    # 独立项目。clone、写代码、定时任务产物都放这里
├── data/                 # 输入数据
├── outputs/              # 交付产物（用户主要看这里）
├── uploads/              # 用户上传的附件
└── ${AGENT_SKILLS_DIR}/  # 已安装技能
${F}

- 克隆仓库：\`git clone <url> /workspace/projects/<项目名>\`，禁止堆在 \`/workspace\` 根
- 当前会话若已绑定项目，命令默认就在那个目录执行；跨项目用绝对路径
- 缓存放 \`/workspace/.cache/{npm,pip}\`（已预设），不要污染项目目录
- 项目根可放 \`AGENTS.md\`（或 \`CLAUDE.md\`），会自动注入本会话
- 项目技能：\`<项目>/.agents/skills/<名>/SKILL.md\` 或 \`.claude/skills/\`，绑定该项目的会话会自动列入技能清单
- 项目 hooks：\`<项目>/.agents/hooks.json\`（也读 \`.claude/hooks.json\` / \`.claude/settings.json\` 的 hooks）

## 执行命令

\`re_shell_exec\` 走 PTY（\`bash -lc\`），输出实时给用户看。没有命令白名单，\`working_dir\` 相对工作区根。

- 一条命令做一件事，便于定位失败
- 长输出先过滤再看：\`... | tail -50\`、\`... | rg -i error\`
- 需要几分钟的任务（构建、训练）：输出会直播，不必改用 \`tail\` 假装在等
- 交互式提示（\`read\`、确认、密码）：看返回的 stdout，再带 \`job_id\` + \`stdin\`（含换行）继续；能非交互就加 \`-y\` / \`DEBIAN_FRONTEND=noninteractive\`
- 装依赖前先看有没有：\`python3 -c "import x"\` / \`node -e "require('x')"\` 比无脑 \`pip install\` 快

## 排错

命令失败时**读完整错误信息再动手**。最常见的三类：

1. 路径不对——\`re_fs_list\` 确认文件真的在你以为的地方
2. 依赖缺失——错误信息里通常直接写了缺什么
3. 权限/端口——换端口，或检查是不是有进程占用（\`ss -ltnp\`）

同一个方法连续失败两次就换思路，不要在同一堵墙上反复撞。改动前后跑一次验证（测试、\`--version\`、一次真实调用），别靠"应该没问题"。

## 起服务

跑本地服务时绑 \`0.0.0.0\`，然后用 \`re_expose_port\` 生成外网可访问的地址给用户预览。详见 \`deliver-artifacts\` 技能。

## 交给用户之前

- 代码：至少跑一次，确认能运行
- 数据处理：抽查几行输出，确认格式对
- 汇报时给出**工作区路径**，用户能自己去看
`,
};

const DELIVER_ARTIFACTS: BuiltinSkillDef = {
  name: "deliver-artifacts",
  title: "交付产物与预览",
  description:
    "把工作区里的成果交到用户手上：生成文件下载链接、暴露端口做在线预览、整理交付清单。当你做完了东西需要用户查看、下载、试用，或用户说「发给我」「让我看看效果」「能访问吗」时使用。",
  recommended: true,
  requires: ["computer"],
  tags: ["交付", "分享"],
  body: `# 交付产物与预览

做完了不等于交付完。用户拿不到、看不见的产出等于没做。

## 文件：临时下载链接

${F}
re_get_file_url  path=/outputs/report.pdf  ttl_minutes=1440  disposition=inline
    → https://…  （持链接者可下载，到期或撤销后失效）
${F}

- \`disposition=inline\`——图片、PDF 在浏览器里直接预览
- \`disposition=attachment\`（默认）——触发下载
- \`ttl_minutes\`——默认 60 分钟，最长 7 天。按用户实际需要给，别一律给最长
- 上限 32MB；更大的文件先压缩，或改用端口暴露提供服务

**不要把大段文件内容倒进对话**。图片、PDF、CSV、压缩包一律给链接。

用完清理：\`re_list_file_urls\` 看有哪些还开着，\`re_revoke_file_url\` 撤销不再需要的。链接是公开的，任何拿到的人都能下载——包含敏感信息的文件要提醒用户，并给短 TTL。

## 服务：端口暴露

工作区里跑起来的服务（Web 应用、API、看板）可以暴露成外网地址：

${F}
re_list_exposers                       # 看有哪些通道可用
re_expose_port  port=3000  ttl_minutes=120  name="预览"
    → https://…
re_list_exposures                      # 当前开着哪些
re_unexpose_port  exposure_id=…        # 用完关掉
${F}

- 服务必须绑 \`0.0.0.0\` 而不是 \`127.0.0.1\`，否则隧道连不上
- 暴露前先自测：\`curl -sS localhost:3000 | head\`，别把一个 502 发给用户
- 平台安全策略会限制端口、TTL 和并发数，被拒绝时读错误信息换个端口
- 暴露的服务是公网可达的。别暴露没有鉴权又能改数据的接口

## 交付清单

多个产出时，在最后一条回复里给一份清单：

${F}
产物：
- 报告 /outputs/report.pdf（下载链接，24 小时内有效）
- 源码 /projects/demo/（工作区可直接查看）
- 在线预览 https://…（2 小时内有效）

已验证：报告 12 页排版正常；预览页在 Chrome 打开正常。
未完成：数据源 B 的接口 403，需要你提供 API Key。
${F}

说清楚**验证过什么**和**还差什么**，比一句"已完成"有用得多。
`,
};

const SUBAGENT_ORCHESTRATION: BuiltinSkillDef = {
  name: "subagent-orchestration",
  title: "子代理与任务编排",
  description:
    "把大任务拆成可并行的子任务，用子代理并发执行，或委派给其他 Agent。当任务涉及大量独立的探索/调研/改造工作、需要读很多材料但只要结论、或者某部分工作明显属于另一个 Agent 的职责时使用。",
  recommended: false,
  tags: ["编排", "子代理"],
  body: `# 子代理与任务编排

你可以派生子代理（\`re_spawn_subagent\`）或委派给同租户的其他 Agent（\`delegate_to_agent\`）。两者都是**阻塞调用**：发出去，等结果回来。

## 什么时候值得拆

值得：

- 任务能切成互不依赖的块（审查 10 个文件、调研 5 个方案、改造 8 个模块）
- 中间过程很长但你只要结论（读完整个仓库回答一个问题）
- 需要大量试错，而失败的尝试不该污染当前对话

不值得：

- 单步就能完成的事——派生的开销比自己做还大
- 需要和用户来回确认的事——子代理接触不到用户
- 强依赖当前对话隐含状态的事——子代理看不见这些

## 子代理 vs 委派

| | \`re_spawn_subagent\` | \`delegate_to_agent\` |
| --- | --- | --- |
| 工作区 | 与你共享 | 对方自己的 |
| 工具 | 与你相同 | 对方的工具与记忆 |
| 适用 | 拆分你自己的工作 | 对方有你没有的能力/职责 |

## 写好任务描述

子代理**看不到本次对话、你的记忆、你刚才的发现**。任务描述必须自包含，这是成败的关键：

${F}
task:  审查 /projects/api/src/auth 目录下的全部 TypeScript 文件，找出鉴权相关的安全问题。
context: 这是一个 Hono + Drizzle 的服务端项目，鉴权用 JWT，密钥从环境变量 SECRET 读。
         已知 /login 路由刚重构过，重点看那里。不要改代码，只报告。
expected_output: Markdown 列表，每项含：文件:行号、问题、为什么是问题、建议改法。按严重程度排序。
${F}

写清三件事：**做什么**（范围和边界）、**背景**（它无从得知的前提）、**要什么格式**（否则回来的东西没法直接用）。

## 并行

同一轮里发多个 \`re_spawn_subagent\` 调用会自动并行执行。要并行就一次性全发出去，不要一个一个等——串行发起会白白浪费时间。

子代理在深度限制内还能再派生下一级，复杂任务可以分层拆解。但别为简单任务嵌套。

## 收口

子代理返回的是原始结论，你要做的是：

1. 检查质量——有没有答非所问、有没有明显编造
2. 合并去重——多个子代理可能报同一个问题
3. 形成整体结论——用户要的是一个答案，不是 N 份报告的拼接

**不要**把子代理的返回内容原样粘给用户。你是负责整合的那一个。

## 排错

- 子代理说"信息不足"→ 你的 task/context 漏了前提，补上重发
- 结果格式五花八门 → expected_output 没写清楚
- 明显跑偏 → 任务边界太模糊，缩小范围重来
`,
};

const MEMORY_CURATION: BuiltinSkillDef = {
  name: "memory-curation",
  title: "记忆整理",
  description:
    "维护关于用户和长期任务的记忆：该记什么、不该记什么、如何检索和更新。当用户说「记住这个」「你怎么忘了」「别再记这个了」，或你发现自己在反复询问已经知道的信息时使用。",
  recommended: false,
  requires: ["memory"],
  tags: ["记忆"],
  body: `# 记忆整理

平台会在对话后自动提取记忆，并在新对话开始时召回相关内容注入上下文。你的记忆工具（\`re_search_memory\`、\`re_add_memory\`、\`re_update_memory\`、\`re_delete_memory\`、\`re_pin_memory\`）用于**精确操作**，不是日常记录手段。

## 该记什么

- 用户的身份与偏好：角色、技术栈、语言习惯、明确说过的做事方式
- 长期项目的约束与决策：为什么选了 A 不选 B、不能动哪些东西
- 用户给出的纠正：他说过"别这样做"的事
- 外部资源指针：常用的仓库、看板、文档地址

## 不该记什么

- 本次对话就能看到的上下文——下次对话它可能已经不相关了
- 代码结构、文件内容——它们会变，读文件更准
- 一次性的临时状态："现在在调试 X"
- 用户没打算长期保留的敏感信息（密钥、密码、私人信息）

判断标准：**下次遇到类似任务，这条信息能让我少问一个问题或少走一段弯路吗？** 不能就别记。

## 写法

一条记忆一件事，写成完整的陈述句，把相对时间转成绝对日期（"上周决定的" → "2026-07-20 决定"）。带上**为什么**——只记结论，下次就不知道该不该推翻它。

差：\`用户不喜欢 tailwind\`
好：\`用户在 zakura 项目中要求不用 Tailwind 的 @apply（2026-07 提出，理由是团队里其他人看不懂编译后的样式）；普通 utility class 是可以的。\`

## 更新与删除

记忆冲突时以用户当前说法为准，并且要**更新旧记忆**而不是叠加一条新的——两条互相矛盾的记忆比没有记忆更糟。

用户说"别再记这个了"/"那条不对"时，\`re_search_memory\` 找到对应条目，\`re_update_memory\` 改正或 \`re_delete_memory\` 删除，然后确认已处理。

## 检索

召回是自动的，但你怀疑有相关背景没被召回时，主动 \`re_search_memory\` 一次。开始一个跨会话的长期任务前尤其值得查一下。

## 边界

记忆是关于用户的持久数据。用户要求删除时立即执行，不要保留副本。不确定该不该记的信息，问一句比擅自记录好。
`,
};

const GOOGLE_WORKSPACE: BuiltinSkillDef = {
  name: "google-workspace",
  title: "Google Workspace",
  description:
    "使用已连接的 Gmail、Drive、Calendar、People 和 Chat MCP 完成跨应用工作。当用户要求处理 Google 邮件、日历、云盘、联系人、会议安排或 Workspace 协作时使用。",
  tags: ["Google", "邮件", "日历", "云盘", "协作"],
  body: `# Google Workspace

把 Google Workspace 看作一套相关的数据，而不是五个互不相干的工具。先确认用户目标和授权范围，再选择最少的 MCP 调用完成任务。

## 能力选择

- Gmail：检索邮件、阅读会话、管理草稿与发送。先搜索再读取，避免无边界遍历邮箱。
- Drive：搜索文件、读取内容和管理文件。优先按名称、所有者、类型或更新时间缩小范围。
- Calendar：检查日历与空闲时间、创建或更新事件。写入前明确时区、参与者和日期。
- People：查找联系人和组织目录，用于消歧邮箱地址与人员身份。
- Chat：查找空间和消息、发送协作消息。发送前确认目标空间和最终文案。

## 工作流

1. 调用可用工具列表确认当前 Agent 已绑定哪些 Google MCP；缺少能力时说明具体缺失项。
2. 对读取任务先做窄范围搜索，再读取少量最相关结果；不要一次抓取整个邮箱或云盘。
3. 跨应用任务先解析身份与时间。例如“把 Alice 邮件里的方案放到明天下午会议”应先定位联系人、邮件和时区，再检查日历冲突。
4. 草稿、日历建议和待发送内容可以直接准备；发送邮件、发消息、创建或取消日程前展示关键字段并取得确认，除非用户已明确授权该具体动作。
5. 返回实际结果与可追溯链接或 ID；某个连接器不可用时不要编造数据。

## 数据边界

只访问完成当前请求所需的最小范围。不要在回复中泄露 OAuth token、内部 header 或与任务无关的私人内容。多人同名时先消歧，不要猜收件人。
`,
};

const MICROSOFT_365: BuiltinSkillDef = {
  name: "microsoft-365",
  title: "Microsoft 365",
  description:
    "使用已连接的 Outlook、OneDrive、SharePoint、Teams 与 Microsoft Graph 完成 Microsoft 365 工作。当用户提到微软邮箱、会议、文件、Teams、组织目录或 Entra 账号时使用。",
  tags: ["Microsoft", "Outlook", "Teams", "OneDrive", "Graph"],
  body: `# Microsoft 365

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
`,
};

const SLACK: BuiltinSkillDef = {
  name: "slack",
  title: "Slack",
  description:
    "使用已连接的 Slack 频道、消息与用户工具完成工作区沟通。当用户要求发消息、查频道历史或查找同事时使用。",
  tags: ["Slack", "协作", "消息"],
  body: `# Slack

\`post_message\` 会立刻对真人可见且无法撤回。它和其它工具不是一个风险等级，
对待方式也不该一样。

## 工具

- \`list_channels\` / \`get_channel\` — 频道，channel id 从这里来
- \`history\` — 频道消息历史
- \`list_users\` / \`get_user\` — 成员消歧
- \`post_message\` — 发送（唯一写操作，不可撤回）

## 解析目标

- 频道名 → \`list_channels\` 换 id。\`#general\` 这种字面名不能直接当 id 用。
- 提到人 → \`list_users\` 拿 user id，用 \`<@Uxxxx>\` 格式 mention；直接写名字不会真的 @ 到人。
- 私信/私有频道可能不在列表里（取决于授权范围）；找不到就说明，不要换个频道发。

## 发送前

1. 把**目标频道名**和**完整正文**一起给用户看。
2. 除非用户在本轮已明确说了「发到 X」并给出内容，否则等确认。
3. 发完回报频道与时间戳。

## 读历史

\`history\` 按频道拉取，默认量就不小。先限定条数，只在确有必要时往前翻页；
不要为了「看看有什么」而整频道倒灌进上下文。

## 边界

不能编辑或删除已发消息、不能建频道、不能传文件。权限不足时报出缺少的 scope，不要重试。
不回显 token。
`,
};

const GITHUB: BuiltinSkillDef = {
  name: "github",
  title: "GitHub",
  description:
    "使用已连接的 GitHub 仓库、Issues、PR 与搜索工具完成开发协作。当用户要求查仓库、开 Issue、审 PR 或搜代码时使用。",
  tags: ["GitHub", "开发", "PR", "Issue"],
  body: `# GitHub

所有调用都要 owner + repo。用户通常只说仓库名，先解析清楚再动手。

## 工具

- \`list_repos\` / \`get_repo\` / \`list_branches\` — 仓库与分支
- \`search_repositories\` / \`search_code\` / \`search_issues\` — 跨仓库搜索
- \`list_issues\` / \`get_issue\` / \`create_issue\` / \`create_issue_comment\`
- \`list_pulls\` / \`get_pull\` / \`create_pull\`

## 先搜后读

搜索返回的是摘要，不是正文。定位到目标后再用 \`get_issue\` / \`get_pull\` 取详情，
不要把搜索结果当完整内容回答。

\`search_code\` 走 GitHub 代码搜索语法，务必带限定符收窄：

\`\`\`
repo:owner/name path:src extension:ts "functionName"
\`\`\`

无限定符的关键词搜索会跨全站返回噪音。

## 创建 PR

\`create_pull\` 需要 head 与 base 两个分支。开之前：

1. \`list_branches\` 确认两个分支都真实存在（拼错分支名只会得到一个含糊的 422）。
2. 确认方向：head 是改动来源，base 是合入目标 —— 反了就是一个反向 PR。
3. 默认分支不一定是 \`main\`，用 \`get_repo\` 读，别假设。

## 写操作

创建 Issue/PR、发评论前，把仓库、标题、目标分支和正文一并给用户确认。
写完回报编号与链接。同一件事不要重复创建 —— 先 \`search_issues\` 查有没有已存在的单。

## 边界

不能合并 PR、不能推送代码、不能改仓库设置。需要提交代码时用工作区里的 \`git\` 与
\`gh\` 命令，而不是这些工具。
不回显 OAuth token；403 时报出缺少的 scope。
`,
};

const NOTION: BuiltinSkillDef = {
  name: "notion",
  title: "Notion",
  description:
    "使用已连接的 Notion 页面、数据库与用户工具完成知识库工作。当用户要求搜索 Notion、读写页面或查询数据库时使用。",
  tags: ["Notion", "知识库", "文档"],
  body: `# Notion

Notion 的内容在**块**里，不在页面对象里。\`get_page\` 只给属性和元信息 ——
要正文必须 \`list_children\`。这是最容易答错的一点。

## 工具

- \`search\` — 按关键词跨工作区定位页面/数据库
- \`get_page\` — 页面属性（**不含正文**）
- \`list_children\` — 页面的块，正文在这里
- \`get_database\` / \`query_database\` — schema 与记录
- \`create_page\` / \`append_blocks\` — 两个写操作
- \`get_me\` / \`list_users\` — 账号与成员

## 读取顺序

1. \`search\` 定位，拿到 id 和它是 page 还是 database。
2. 页面：\`get_page\` 看属性 → \`list_children\` 读正文。嵌套块要按需再展开子块，
   不要一次递归整棵树。
3. 数据库：先 \`get_database\` 读 schema，再 \`query_database\` —— 属性名和类型必须
   跟 schema 完全一致，否则过滤条件会被拒。

## 写操作

- \`create_page\` 必须有 parent（页面或数据库 id）。往数据库里建页时，properties
  要匹配 schema，必填属性不能省。
- \`append_blocks\` 追加到末尾，不能改写已有块。
- 建页/追加前把父级位置和内容摘要给用户确认。写完回报页面链接。

## 边界

不能删除页面或块、不能改已有块、不能改数据库 schema。
只能看到集成被授权的页面 —— 搜不到时先怀疑没共享给集成，而不是不存在。
不回显 OAuth token。
`,
};

const LINEAR_SKILL: BuiltinSkillDef = {
  name: "linear",
  title: "Linear",
  description:
    "使用已连接的 Linear Issues、Projects 与 Teams 工具。当用户要求查 Issue、开单或看项目进度时使用。",
  tags: ["Linear", "Issue", "项目管理"],
  body: `# Linear

Linear 的写操作都要求 teamId，而用户几乎只会说团队名。先解析 ID，再动手。

## 工具

- \`list_teams\` — 团队及其 id、key
- \`list_issues\` / \`get_issue\` — 按团队/状态筛列表，取单条详情
- \`list_projects\` / \`get_project\` — 项目与进度
- \`create_issue\` / \`create_comment\` — 唯一两个写操作
- \`viewer\` — 当前账号，用于「分配给我」这类指代

## 解析顺序

1. 团队名 → \`list_teams\` 取 id。名称重复或模糊时列出候选让用户选，不要猜。
2. 「我的」「分给我」→ \`viewer\` 取当前用户 id，不要用邮箱猜。
3. Issue 标识符（\`ENG-123\`）可直接给 \`get_issue\`；只有标题时先 \`list_issues\` 定位。

## 写操作

创建 Issue 前必须齐备 teamId + 标题；优先级、负责人、项目缺失就用默认值，不要虚构。
评论前先 \`get_issue\` 确认是目标那条 —— 编号相近的单据很容易搞错。
写完回报 Issue 标识符与链接，方便用户核对。

## 边界

- 没有删除或状态流转工具；用户要求关单/改状态时说明只能评论，并给出 Issue 链接。
- 不回显 token。权限不足时报出缺少的 scope，而不是重试。
`,
};

const FEISHU_SKILL: BuiltinSkillDef = {
  name: "feishu",
  title: "飞书",
  description:
    "使用已连接的飞书文档、多维表格与消息工具。当用户提到飞书文档、表格、群聊或发消息时使用。",
  tags: ["飞书", "文档", "消息"],
  body: `# 飞书

唯一的写操作是发消息，而且发出去不能撤回。发之前必须确认收件会话和正文。

## 工具

- \`get_current_user\` — 当前账号
- \`list_chats\` — 会话列表（chat_id 从这里来）
- \`get_document\` / \`get_raw_content\` / \`list_blocks\` — 文档
- \`list_tables\` / \`search_records\` — 多维表格
- \`send_message\` — 发送文本（唯一写操作）

## 读文档

- 要通读全文用 \`get_raw_content\`（纯文本，最省 token）。
- 要按结构定位或引用某段用 \`list_blocks\`。
- \`get_document\` 只给标题与元信息，不含正文。
先判断需要哪种粒度，不要三个都调一遍。

## 多维表格

\`list_tables\` 拿 table_id，再 \`search_records\` 带条件查。不要无条件拉全表。

## 发消息

1. \`list_chats\` 解析出 chat_id —— 不要用群名当 receive_id。
2. 群名重复时列候选让用户确认发哪个。
3. 把最终文案原样回给用户确认后再发；发完回报目标会话名。

## 边界

不能编辑文档、不能改表格记录、不能撤回消息。用户要求这些时说明限制。
不回显 token。
`,
};

const DISCORD_SKILL: BuiltinSkillDef = {
  name: "discord",
  title: "Discord",
  description:
    "使用已连接的 Discord 服务器与用户资料工具。当用户要求查看所在服务器或 Discord 账号信息时使用。",
  tags: ["Discord", "社区"],
  body: `# Discord

这是**只读**连接器，走用户 OAuth。发频道消息、读消息历史、管理成员都需要 Bot Token
加上 guild 内授权，这里没有 —— 先认清边界，别去尝试不存在的操作。

## 工具

- \`list_guilds\` — 当前用户加入的服务器（id、名称、权限位）
- \`get_guild\` — 单个服务器详情
- \`get_me\` — 当前 Discord 账号
- \`list_connections\` — 该账号关联的外部账号（Steam、GitHub 等）

## 工作流

1. \`list_guilds\` 拿到 id，再按需 \`get_guild\`；不要对每个服务器都展开详情。
2. 用户说服务器名时在 \`list_guilds\` 结果里匹配；重名就列候选。
3. \`list_connections\` 属于敏感个人数据，只在用户明确要求时调用。

## 边界

用户要求「发消息到某频道」「看聊天记录」「踢人/改权限」时，直接说明本连接器只读、
需要配置 Bot 才能做，并停下 —— 不要转而去猜别的工具。
需要发消息的场景可以改用 Slack 或飞书连接器。

不回显 token。
`,
};

const GITLAB_SKILL: BuiltinSkillDef = {
  name: "gitlab",
  title: "GitLab",
  description:
    "使用已连接的 GitLab 项目与 Issues 工具。当用户要求查 GitLab 项目或开 Issue 时使用。",
  tags: ["GitLab", "开发", "Issue"],
  body: `# GitLab

每个调用都要 project 标识，且 GitLab 接受两种写法 —— 挑错会得到 404 而不是报错提示。

## 工具

- \`list_projects\` / \`get_project\` — 项目，返回数字 id 与 \`path_with_namespace\`
- \`list_issues\` / \`create_issue\` — Issues
- \`get_current_user\` — 当前账号

## project 标识

- 数字 id（如 \`1234\`）最稳，优先用它。
- 路径必须是完整的 \`group/subgroup/project\`，不能只给项目名。
- 用户给的是名字时先 \`list_projects\` 换 id；同名跨 group 很常见，列候选让用户确认，别挑第一个。

## 工作流

1. 解析 project → 拿到数字 id。
2. 读：\`list_issues\` 先筛（state、labels），需要正文再逐条取。
3. 写：\`create_issue\` 需要 project + 标题；描述用 Markdown。写完回报 issue iid 与链接。

## 边界

- 只能创建 Issue，不能改/关/评论，也没有 MR 工具。用户要求这些时说明限制并给链接。
- 自建实例的地址由连接器配置决定；报 404 时先怀疑 project 标识，再怀疑权限。
- 不回显 token。
`,
};

const JIRA_SKILL: BuiltinSkillDef = {
  name: "jira",
  title: "Jira",
  description:
    "使用已连接的 Jira Issues 与 Projects 工具。当用户要求用 JQL 查单、开 Issue 或看项目时使用。",
  tags: ["Jira", "Issue", "项目管理"],
  body: `# Jira

搜索走 JQL，所以查询的精度完全取决于你写的 JQL。宽查询会拉回上千条并挤掉上下文。

## 工具

- \`search_issues\` — JQL 查询
- \`get_issue\` — 单条详情（含描述与评论）
- \`list_projects\` — 项目及其 key
- \`get_myself\` — 当前账号
- \`create_issue\` / \`add_comment\` — 唯一两个写操作

## 写 JQL

始终带上 project 和排序，并限制条数：

\`\`\`
project = ENG AND status != Done ORDER BY updated DESC
\`\`\`

- 「我的」用 \`assignee = currentUser()\`，不要拼邮箱。
- 项目名 → 先 \`list_projects\` 换成 key（用户说的是名字，JQL 要 key）。
- 只有关键词时用 \`text ~ "..."\`，拿到候选后再 \`get_issue\` 读详情，别把搜索结果当完整内容。

## 写操作

\`create_issue\` 需要 project key + issuetype + summary。issuetype 名称各站点不同
（\`Task\`/\`任务\`/\`Story\`），失败时读回错误里的可选值再重试一次，不要连续盲试。
评论前先 \`get_issue\` 确认目标。写完回报 issue key。

## 边界

- 没有状态流转、附件、删除工具；用户要求转状态时说明限制并给出链接。
- 不回显 token；403/401 时报出缺失权限而不是重试。
`,
};

export const BUILTIN_SKILLS: BuiltinSkillDef[] = [
  FIND_SKILLS,
  SKILL_CREATOR,
  BROWSER_AUTOMATION,
  WEB_RESEARCH,
  WORKSPACE_PROJECTS,
  DELIVER_ARTIFACTS,
  SUBAGENT_ORCHESTRATION,
  MEMORY_CURATION,
  GOOGLE_WORKSPACE,
  MICROSOFT_365,
  GITHUB,
  SLACK,
  NOTION,
  LINEAR_SKILL,
  FEISHU_SKILL,
  DISCORD_SKILL,
  GITLAB_SKILL,
  JIRA_SKILL,
];

export function getBuiltinSkill(name: string): BuiltinSkillDef | undefined {
  const wanted = name.trim().toLowerCase();
  return BUILTIN_SKILLS.find((s) => s.name.toLowerCase() === wanted);
}

/**
 * 内置技能的版本 = 内容哈希。
 *
 * 用常量 "builtin" 当版本时，改了正文也没人知道内容变了，
 * 已装到 Agent 工作区的旧文本就永远留在那儿。改成内容哈希后，
 * 注册表与安装记录的版本一比就能判断该不该重写工作区。
 */
export function builtinVersion(def: BuiltinSkillDef): string {
  const payload = JSON.stringify([
    def.name,
    def.description,
    def.body,
    (def.extraFiles ?? []).map((f) => [f.path, f.content]),
  ]);
  return `builtin-${createHash("sha256").update(payload).digest("hex").slice(0, 12)}`;
}

/** 内置定义 → 可安装的技能包 */
export function builtinToPackage(def: BuiltinSkillDef): SkillPackage {
  const manifest = buildSkillMarkdown(
    { name: def.name, description: def.description },
    def.body,
  );
  const files: SkillFile[] = [
    {
      path: "SKILL.md",
      content: manifest,
      encoding: "utf8",
      size: Buffer.byteLength(manifest, "utf8"),
    },
    ...(def.extraFiles ?? []).map((f) => ({
      path: f.path,
      content: f.content,
      encoding: "utf8" as const,
      size: Buffer.byteLength(f.content, "utf8"),
    })),
  ];
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    frontmatter: { name: def.name, description: def.description },
    body: def.body,
    files,
    source: { kind: "builtin", builtinId: def.name, store: "builtin", raw: `builtin:${def.name}` },
    version: builtinVersion(def),
    sizeBytes: files.reduce((sum, f) => sum + f.size, 0),
  };
}

/** 新建 Agent 时默认安装的技能 */
export function recommendedBuiltinSkills(): BuiltinSkillDef[] {
  return BUILTIN_SKILLS.filter((s) => s.recommended);
}
