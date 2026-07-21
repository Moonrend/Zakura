# `@zakura/saas`

Zakura **SaaS 版**扩展：多租户、公开注册、成员邀请、平台超管。

开源发行时用根目录脚本剥离：

```bash
pnpm strip:saas -- --out ../Zakura-oss
```

详见 [`docs/edition.md`](../../docs/edition.md)。

## 导出

| 入口 | 内容 |
|------|------|
| `@zakura/saas` | edition 常量 / SaaS web 路由列表 |
| `@zakura/saas/server` | `registerSaasRoutes(app, deps)` |

Server 在 `ZAKURA_EDITION=saas` 且本包可解析时动态挂载。
