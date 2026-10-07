---
name: deliver-artifacts
description: 把工作区里的成果交到用户手上：生成文件下载链接、暴露端口做在线预览、整理交付清单。当你做完了东西需要用户查看、下载、试用，或用户说「发给我」「让我看看效果」「能访问吗」时使用。
---

# 交付产物与预览

做完了不等于交付完。用户拿不到、看不见的产出等于没做。

## 文件：临时下载链接

```
re_get_file_url  path=/outputs/report.pdf  ttl_minutes=1440  disposition=inline
    → https://…  （持链接者可下载，到期或撤销后失效）
```

- `disposition=inline`——图片、PDF 在浏览器里直接预览
- `disposition=attachment`（默认）——触发下载
- `ttl_minutes`——默认 60 分钟，最长 7 天。按用户实际需要给，别一律给最长
- 上限 32MB；更大的文件先压缩，或改用端口暴露提供服务

**不要把大段文件内容倒进对话**。图片、PDF、CSV、压缩包一律给链接。

用完清理：`re_list_file_urls` 看有哪些还开着，`re_revoke_file_url` 撤销不再需要的。链接是公开的，任何拿到的人都能下载——包含敏感信息的文件要提醒用户，并给短 TTL。

## 服务：端口暴露

工作区里跑起来的服务（Web 应用、API、看板）可以暴露成外网地址：

```
re_list_exposers                       # 看有哪些通道可用
re_expose_port  port=3000  ttl_minutes=120  name="预览"
    → https://…
re_list_exposures                      # 当前开着哪些
re_unexpose_port  exposure_id=…        # 用完关掉
```

- 服务必须绑 `0.0.0.0` 而不是 `127.0.0.1`，否则隧道连不上
- 暴露前先自测：`curl -sS localhost:3000 | head`，别把一个 502 发给用户
- 平台安全策略会限制端口、TTL 和并发数，被拒绝时读错误信息换个端口
- 暴露的服务是公网可达的。别暴露没有鉴权又能改数据的接口

## 交付清单

多个产出时，在最后一条回复里给一份清单：

```
产物：
- 报告 /outputs/report.pdf（下载链接，24 小时内有效）
- 源码 /projects/demo/（工作区可直接查看）
- 在线预览 https://…（2 小时内有效）

已验证：报告 12 页排版正常；预览页在 Chrome 打开正常。
未完成：数据源 B 的接口 403，需要你提供 API Key。
```

说清楚**验证过什么**和**还差什么**，比一句"已完成"有用得多。
