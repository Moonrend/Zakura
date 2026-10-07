---
name: workspace-projects
description: 在云端工作区里建项目、写代码、装依赖、跑脚本和测试。当任务涉及写程序、跑命令、处理数据文件、搭建可运行的东西时使用。也覆盖工作区文件的组织约定和排障方法。
---

# 工作区与代码工程

你有一个持久的 Linux 工作区（`/workspace`），文件在会话之间保留，用户能在控制台文件面板里看到同一份文件。预装：python3/pip/venv、node/npm/npx、gcc/g++/make、git、jq、rg、fd、sqlite3、curl/wget。

## 工具选择

| 场景 | 用什么 |
| --- | --- |
| 读单个文件 | `re_fs_read`（支持 line_offset / n_lines 读大文件的一段） |
| 写/覆盖文件 | `re_fs_write` |
| 改文件里的一小段 | `re_fs_edit`（唯一匹配替换，比重写整个文件安全） |
| 看目录 | `re_fs_list` |
| 找文件 / 搜内容 | `re_shell_exec` 跑 `fd` / `rg` |
| 装依赖、跑测试、执行程序 | `re_shell_exec` |

写代码文件优先用 `re_fs_*`——它们会触发控制台文件面板刷新，用户能实时看到你在写什么。用 shell 的 heredoc 写文件则不会。

## 目录约定

平台会自动创建这些顶层目录。**一层 `projects/<名>/` 就是一个独立项目**；会话和定时任务绑到项目后，shell 默认 cwd 就是该目录。

```
/workspace
├── projects/<项目名>/    # 独立项目。clone、写代码、定时任务产物都放这里
├── data/                 # 输入数据
├── outputs/              # 交付产物（用户主要看这里）
├── uploads/              # 用户上传的附件
└── skills/  # 已安装技能
```

- 克隆仓库：`git clone <url> /workspace/projects/<项目名>`，禁止堆在 `/workspace` 根
- 当前会话若已绑定项目，命令默认就在那个目录执行；跨项目用绝对路径
- 缓存放 `/workspace/.cache/{npm,pip}`（已预设），不要污染项目目录
- 项目根可放 `AGENTS.md`（或 `CLAUDE.md`），会自动注入本会话
- 项目技能：`<项目>/.agents/skills/<名>/SKILL.md` 或 `.claude/skills/`，绑定该项目的会话会自动列入技能清单
- 项目 hooks：`<项目>/.agents/hooks.json`（也读 `.claude/hooks.json` / `.claude/settings.json` 的 hooks）

## 执行命令

`re_shell_exec` 走 PTY（`bash -lc`），输出实时给用户看。没有命令白名单，`working_dir` 相对工作区根。

- 一条命令做一件事，便于定位失败
- 长输出先过滤再看：`... | tail -50`、`... | rg -i error`
- 需要几分钟的任务（构建、训练）：输出会直播，不必改用 `tail` 假装在等
- 交互式提示（`read`、确认、密码）：看返回的 stdout，再带 `job_id` + `stdin`（含换行）继续；能非交互就加 `-y` / `DEBIAN_FRONTEND=noninteractive`
- 装依赖前先看有没有：`python3 -c "import x"` / `node -e "require('x')"` 比无脑 `pip install` 快

## 排错

命令失败时**读完整错误信息再动手**。最常见的三类：

1. 路径不对——`re_fs_list` 确认文件真的在你以为的地方
2. 依赖缺失——错误信息里通常直接写了缺什么
3. 权限/端口——换端口，或检查是不是有进程占用（`ss -ltnp`）

同一个方法连续失败两次就换思路，不要在同一堵墙上反复撞。改动前后跑一次验证（测试、`--version`、一次真实调用），别靠"应该没问题"。

## 起服务

跑本地服务时绑 `0.0.0.0`，然后用 `re_expose_port` 生成外网可访问的地址给用户预览。详见 `deliver-artifacts` 技能。

## 交给用户之前

- 代码：至少跑一次，确认能运行
- 数据处理：抽查几行输出，确认格式对
- 汇报时给出**工作区路径**，用户能自己去看
