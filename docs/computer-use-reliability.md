# Computer use 排查与验证

桌面工具、CDP 浏览器和电脑页面共用容器工作区。它们依赖 Runner 在线、工作区类型正确、显示服务就绪，以及完整图片能到达模型。以下约定适用于 `computer_*`、`desktop_info`、`browser_observe` 和 `browser_action`；工具名称及现有模型路由保持兼容。

## 桌面无障碍 snapshot 与 ref

`computer_observe observe=snapshot`（默认）通过 Linux AT-SPI 读取整个桌面的无障碍树，包含应用/活动窗口上下文、文本树、节点角色和名称、可聚焦/可编辑/禁用等状态、可用动作和 `e1`、`e2` 等 ref。桌面尺寸仍来自 `DISPLAY=:99`。`screenshot=true` 可同时附带完整 PNG；`observe=screenshot` 与旧 `computer_screenshot` 兼容。无障碍失败不会阻止单独截图或坐标输入。

典型调用顺序（MCP 名称加 `re_` 前缀）：

```text
computer_observe {"observe":"snapshot","screenshot":true}
computer_click   {"ref":"e5"}
computer_type    {"ref":"e7","text":"Hello"}
computer_observe {"observe":"snapshot"}
```

示例 ref 必须替换为实际返回值。桌面 ref 和 `browser_observe` 的网页 ref 属于不同工具，不能混用。

| 工具 | ref 与兼容调用 |
| --- | --- |
| `computer_click` | `ref` 优先；未传 ref 时使用 `x/y`。普通左键优先使用控件的 click/press/activate 动作；输入框不会因为 click 而执行提交。右键、双击或无可用动作时读取节点实时屏幕边界，再用 xdotool 点击 |
| `computer_type` | `ref` 聚焦并确认成功后输入 `text`；支持 EditableText 的控件在光标/选区处插入 Unicode 文本，否则使用键盘。未传 ref 时可用 `x/y` 点击聚焦；均省略则向当前焦点输入，保留旧行为 |
| `computer_key` | 可用 `ref` 先聚焦；省略时使用当前焦点 |
| `computer_move` / `computer_scroll` | `ref` 优先，未传时使用 `x/y`；`dy=0` 不产生点击 |
| `computer_drag` | 起点 `ref` / `x,y`，终点 `to_ref` / `to_x,to_y`，可混合。两端全部验证成功后才按下鼠标，失败也会释放按钮 |

ref 仅保存在 Server 内存中，按工作区服务、租户、Agent 和 Runner 绑定隔离，最多使用 5 分钟。新 snapshot（包括失败的尝试）废弃旧 ref；同一服务实例不会复用 ref 编号。动作时按 AT-SPI bus 的会话 ID、应用唯一连接名、对象路径和角色/名称/父节点签名重新解析，拒绝失效、隐藏、禁用或已被替换的节点，不使用缓存坐标。携带错误 ref 时**不会**转而执行同次调用中的坐标；错误会要求 `computer_observe observe=snapshot`。动作不会因超时或断线自动重放。

读取有界：`max_nodes` 默认 300、范围 1–500，同时限制遍历深度、耗时和文本量；返回给模型的 snapshot 按完整节点裁剪，为 cloud-agent 的 12000 字符工具文本上限保留空间。检查 `truncated` 和 `warnings`，遗漏的节点没有 ref。snapshot 成功但附带截图失败时保留文本树和 warning；动作完成后的截图失败仍明确说明动作已完成，应先观察再决定是否重试。

### 镜像依赖与共享会话

完整镜像 `docker/workspace/Dockerfile` 安装 `dbus`、`dbus-x11`、`at-spi2-core`、`libatk-adaptor`、`python3-dbus`、`python3-gi`、`gir1.2-atspi-2.0`，并将 `desktop-a11y.py` 安装为 `/usr/local/bin/zakura-desktop-a11y`。helper 固定使用 `/usr/bin/python3`，不依赖 Agent 的 Python venv。轻量 base 镜像不提供图形桌面。

entrypoint 在 GUI 应用启动前建立共享 session bus：`DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/zakura-display/session-bus`，激活 AT-SPI 并设置 `org.a11y.Status` 的 `IsEnabled` / `ScreenReaderEnabled`。镜像环境同时设置 `GTK_MODULES=atk-bridge`、`NO_AT_BRIDGE=0`、`QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`；Chromium 保留 `--force-renderer-accessibility`。这些环境变量让后续 `docker exec` / Shell 启动的应用加入同一桌面会话。没有新增公共网络端口。

升级需重新构建 full 镜像并重建工作区容器，使 helper、依赖和镜像环境一起生效。仅重启旧容器或只运行 CJK/strip-go 镜像修补不能安装这些依赖。旧镜像的 snapshot 会返回缺失 helper/依赖的诊断，仍可使用原有截图、坐标工具。D-Bus 重启会使已有 ref 失效；某些 GUI 应用需要重新启动才能注册到新总线。

容器内检查：

```bash
DISPLAY=:99 xdotool getdisplaygeometry
zakura-desktop-a11y probe
zakura-desktop-a11y snapshot '{"maxNodes":80}'
cat /var/log/zakura/a11y.log
```

helper 的输出包含内部节点句柄；供 agent 使用的 `eN` ref 由 Server 工具生成。`desktop_info.ready` 表示显示/输入栈就绪，无障碍总线是否可用应通过 snapshot 或 probe 判断。

### 限制

- 仅支持当前容器的 Linux X11 / `DISPLAY=:99`，不覆盖宿主桌面、Wayland、Windows 或 macOS。
- 只能读取应用主动暴露的 AT-SPI 信息。自绘控件、画布、游戏、缺少桥接的旧程序或在其他 D-Bus session 启动的应用可能只出现空窗口或没有节点；无应用时返回明确 warning。网页内容仍优先用 CDP browser 工具。
- 不读取 `password text` 的 Text 接口内容；普通可访问文本、角色、名称和截图仍都是不可信的页面数据，不能覆盖用户指令。
- 原生 click 动作依赖应用正确实现；坐标动作依赖应用报告的屏幕边界。裁剪、窗口遮挡、菜单浮层、焦点竞争及应用复用同一 accessible 对象表示新内容时，无法保证旧观察仍完整反映当前 UI。每组动作后重新观察；无法访问、无屏幕边界或屏外控件使用新截图定位，必要时先滚动/切换窗口。
- EditableText 插入触发应用的文本变更行为，不保证产生逐键事件；需要快捷键时用 `computer_key`。没有 EditableText 的控件或坐标输入沿用 xdotool，Unicode 输入受应用和 X11 键盘映射影响，应观察实际文本。
- Server 对同一 Agent 的桌面观察和输入串行处理，但无法阻止用户或 GUI 应用同时改变界面。聚焦失败不发送文本/按键，操作结果仍应通过后续观察确认。

## 本次定位的故障

| 故障 | 修复后的行为 |
| --- | --- |
| 创建工作区未传入 computer/browser 启用标志，完整镜像实际以 shell-only 模式启动 | 创建时传入启用标志、DISPLAY 和尺寸；区分 shell 与 display 就绪状态，启动失败返回诊断 |
| workspace 查找取同一 Agent 的第一个容器，可能选中 ACP adapter/sidecar | 新容器标记 `zakura.purpose=workspace`，兼容没有 purpose 标签的旧工作区，排除 ACP 容器 |
| Chromium 监听容器回环地址，通过发布端口和 PUBLIC_HOST 无法可靠访问 | CDP HTTP/WebSocket 与桌面 VNC 使用已认证的 Runner stdio 通道；不发布新的公共 CDP/VNC 端口 |
| 双击使用不存在的 xdotool 子命令，文本经 shell 拼接，失败仍可能显示成功 | 使用正确的重复点击和独立 argv；校验输入与坐标，失败返回工具错误 |
| 截图被截成 base64 预览，cloud-agent 又只读取文本，模型实际收不到图像 | MCP 返回完整 image 内容，cloud-agent 将图片放入下一轮视觉输入；文本和持久化事件仅保存元数据 |
| 每次 CDP 调用丢失标签页选择/ref；fill 等动作与描述不符 | 保留 Agent 级标签页选择与绑定文档的 ref，拒绝过期 ref；支持 Unicode 输入和实际声明的 ref 操作 |
| 桌面仅有截图/坐标工具，缺少 AT-SPI 依赖和共享 D-Bus 会话 | 新增 `computer_observe snapshot` 与经过实时验证的 ref 输入；完整镜像启动共享无障碍总线，缺少支持时保留截图/坐标调用 |
| 导航未可靠等待、断线无恢复、surface 截图失败 | 等待导航结果；安全观察最多重连重试一次；surface 失败降级为视口截图并返回 warning |
| 页内历史跳转没有新 loader，被误判超时；未加载完成的页面无法截图 | 历史跳转检查实际 history entry；截图和 snapshot 返回当前页面及 readyState，导航超时后仍可观察 |
| 历史页面恢复时短暂 inactive，CDP 错误又没有方法信息 | 导航后的只读查询等待页面恢复，不重放导航；其他协议错误直接报告具体方法和原因 |
| 代理启动期间丢输入/泄漏连接，公开 WSS URL 残留开发端口 | 提前注册生命周期处理、限制缓冲并传递背压；断线获取新 ticket 重连，正确设置 hostname 与 port |

## 截图与坐标约定

- 桌面坐标是 `DISPLAY=:99` 的原始屏幕像素，左上角为原点。`desktop_info` 在显示可用时返回实际 width/height；每个桌面动作返回尺寸，可用 `screenshot=true` 附带操作后的图片。
- 浏览器坐标是网页视口的 CSS 像素，不包含浏览器工具栏。截图的 width/height 是 PNG 原始尺寸；`viewport`、`screenshotScale` 和 `screenshotOrigin` 描述转换关系：`viewportPoint = imagePoint / screenshotScale + screenshotOrigin - viewportScroll`，x/y 分别计算。整页截图中的屏外元素先滚动到视口，再观察和点击。
- 默认 `output=image` 返回完整 PNG 和轻量文本；`base64Preview` 不能解码为图片。`output=metadata` 省略图片，`output=base64` 显式返回完整文本，超过 120000 字符则报错，不返回截断图片。
- 单张截图最多 8 MiB。cloud-agent 每次工具结果最多接收两张图片，运行历史仅保留最近、合计不超过 8 MiB 的两张工具图片；持久化事件保留文本。Responses 使用带 call id 的图像工具输出，其他适配器在完整工具批次之后附加视觉内容。
- `path=screenshots/page.png` 可将桌面或浏览器截图保存到工作区，再通过 `get_file_url` 提供文件链接。路径受工作区边界限制。
- `screenshot_annotate` 是兼容名称，返回 snapshot 加原图，不在图像上绘制 ref。
- 动作后截图失败会说明动作已完成，应先观察再决定是否重试，避免重复提交。CDP 写操作不会因中途断线被自动重放。网页和截图文字按不可信内容处理。

## 启动与现场检查

1. 确认 Agent 启用了电脑并绑定在线 Runner。本机（host）工作区提供文件和终端；图形桌面需要 Docker 容器工作区，电脑页面提供切换入口。
2. 升级 workspace 镜像，使 `docker/workspace/entrypoint.sh` 的健康检查与重启逻辑生效。旧容器需要停止并重新创建以应用新的启用标志；仅执行 `docker restart` 不会改变创建时的环境变量。`/workspace` 使用持久化挂载，容器内临时浏览器 profile 会随重建丢失。
3. 先调用 `desktop_info` 查看 supported、ready、reason 和 dimensionsSource，再 `computer_observe observe=snapshot screenshot=true`。输入前确认 ref、焦点与当前截图，使用小批动作并在每批后重新观察。
4. 在工作区 Shell 检查 `DISPLAY=:99 xdotool getdisplaygeometry`、VNC `127.0.0.1:5900` 和 `curl -fsS http://127.0.0.1:9222/json/version`。截图需要 `scrot`、ImageMagick `import` 或 `xwd + convert` 中的一组。
5. 查看容器内 `/var/log/zakura/workspace.log`、`xvfb.log`、`x11vnc.log`、`chrome.log`、`a11y.log`；Server 侧查看 `desktop.proxy` 和 `agent_ws.cdp_tunnel` 故障事件。电脑未就绪时 ticket 接口会返回原因。

## 本地验证

本次使用 Node 22。仓库锁定的 `undici@8` 在此环境的 Node 20.19.2 上因缺少 `markAsUncloneable` 无法加载；验证时临时使用 Node 22，没有修改依赖或模型配置。以下命令假定当前 Node 为 22 或更新的兼容版本：

```bash
corepack pnpm --filter @zakura/shared build
corepack pnpm --filter @zakura/core build
corepack pnpm -r typecheck
corepack pnpm --filter @zakura/shared test
corepack pnpm --filter @zakura/core test
bash -n docker/workspace/entrypoint.sh
```

Server 测试应在 `apps/server` 下运行，使 tsx 使用该包的 TSX/JSX 配置。全量验证需要独立测试 Redis；既有 `remote-agent-ingress.test.ts` 是未清理 Redis 连接的顶层自检，单独以 `REDIS_URL=off` 运行，其断言仍全部执行。

```bash
cd apps/server
mapfile -t zakura_server_tests < <(rg --files test -g '*.test.ts' -g '!remote-agent-ingress.test.ts' | sort)
REDIS_URL=redis://127.0.0.1:6379 corepack pnpm exec tsx --test --test-concurrency=4 --test-force-exit "${zakura_server_tests[@]}"
REDIS_URL=off corepack pnpm exec tsx --test --test-force-exit test/remote-agent-ingress.test.ts
```

`agent-cdp-chromium.test.ts` 可通过 `ZAKURA_TEST_CHROMIUM` 指向 Chromium/Chrome 可执行文件来启用。测试自行创建浏览器 profile 和本地页面，覆盖输入、选择、双击、滚动、截图、普通/页内历史跳转，以及资源不返回时的观察，不访问外部网站。

```bash
ZAKURA_TEST_CHROMIUM=/path/to/chrome REDIS_URL=off corepack pnpm exec tsx --test --test-force-exit test/agent-cdp-chromium.test.ts
```

本次已运行真实 Chromium、CDP 断线/降级测试、桌面命令和图片传递测试、代理/ticket/工作区测试。执行环境没有 Docker，因此完整的 Docker + Xvfb + noVNC 图形栈仍需在带 Docker 的 Runner 上验收。

无障碍 mock 测试包含 snapshot → ref 点击/输入/拖动、实时坐标、失效和跨 Agent ref、过期/替换 snapshot、缺失后端、截图失败、图片进入模型以及输出裁剪。以下相关回归不需要真实 X：

```bash
cd apps/server
REDIS_URL=off corepack pnpm exec tsx --test --test-force-exit \
  test/agent-desktop.test.ts test/agent-fs-paths.test.ts \
  test/agent-cdp.test.ts test/openai-tools.test.ts \
  test/openai-tool-continuation.test.ts test/cloud-agent-multiturn.test.ts
```

可选真实 AT-SPI 测试还需要本机安装上述无障碍依赖、`gir1.2-gtk-3.0`、`Xvfb` 和 `xdotool`。测试自行创建隔离显示和 D-Bus session，只操作临时 GTK 窗口，验证原生点击、输入框点击不提交、中文/字面量输入、密码文本隐藏、节点签名变化和实时位置。无须 Docker，也不访问外部网站：

```bash
cd apps/server
ZAKURA_TEST_DESKTOP_A11Y=1 REDIS_URL=off corepack pnpm exec tsx --test --test-force-exit test/agent-desktop-atspi.test.ts
```

参考：[OpenAI computer use 指南](https://developers.openai.com/api/docs/guides/tools-computer-use)、[function calling 指南](https://developers.openai.com/api/docs/guides/function-calling)。
