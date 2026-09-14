# Computer use 排查与验证

桌面工具、CDP 浏览器和电脑页面共用容器工作区。它们依赖 Runner 在线、工作区类型正确、显示服务就绪，以及完整图片能到达模型。以下约定适用于 `computer_*`、`desktop_info`、`browser_observe` 和 `browser_action`；工具名称及现有模型路由保持兼容。

## 本次定位的故障

| 故障 | 修复后的行为 |
| --- | --- |
| 创建工作区未传入 computer/browser 启用标志，完整镜像实际以 shell-only 模式启动 | 创建时传入启用标志、DISPLAY 和尺寸；区分 shell 与 display 就绪状态，启动失败返回诊断 |
| workspace 查找取同一 Agent 的第一个容器，可能选中 ACP adapter/sidecar | 新容器标记 `zakura.purpose=workspace`，兼容没有 purpose 标签的旧工作区，排除 ACP 容器 |
| Chromium 监听容器回环地址，通过发布端口和 PUBLIC_HOST 无法可靠访问 | CDP HTTP/WebSocket 与桌面 VNC 使用已认证的 Runner stdio 通道；不发布新的公共 CDP/VNC 端口 |
| 双击使用不存在的 xdotool 子命令，文本经 shell 拼接，失败仍可能显示成功 | 使用正确的重复点击和独立 argv；校验输入与坐标，失败返回工具错误 |
| 截图被截成 base64 预览，cloud-agent 又只读取文本，模型实际收不到图像 | MCP 返回完整 image 内容，cloud-agent 将图片放入下一轮视觉输入；文本和持久化事件仅保存元数据 |
| 每次 CDP 调用丢失标签页选择/ref；fill 等动作与描述不符 | 保留 Agent 级标签页选择与绑定文档的 ref，拒绝过期 ref；支持 Unicode 输入和实际声明的 ref 操作 |
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
3. 先调用 `desktop_info` 查看 supported、ready、reason 和 dimensionsSource，再截图。输入前确认焦点与当前截图，使用小批动作并在每批后重新观察。
4. 在工作区 Shell 检查 `DISPLAY=:99 xdotool getdisplaygeometry`、VNC `127.0.0.1:5900` 和 `curl -fsS http://127.0.0.1:9222/json/version`。截图需要 `scrot`、ImageMagick `import` 或 `xwd + convert` 中的一组。
5. 查看容器内 `/var/log/zakura/workspace.log`、`xvfb.log`、`x11vnc.log`、`chrome.log`；Server 侧查看 `desktop.proxy` 和 `agent_ws.cdp_tunnel` 故障事件。电脑未就绪时 ticket 接口会返回原因。

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

参考：[OpenAI computer use 指南](https://developers.openai.com/api/docs/guides/tools-computer-use)、[function calling 指南](https://developers.openai.com/api/docs/guides/function-calling)。
