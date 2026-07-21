# 开源版 / SaaS 版

Zakura 以**同一套核心代码**交付两种部署形态；SaaS 能力集中在可剥离包 `@zakura/saas`。

| | 开源版 (`oss`) | SaaS 版 (`saas`) |
|--|----------------|------------------|
| 包 | 无 `@zakura/saas`（或未启用） | 需要 `@zakura/saas` |
| 账户 | 单账户（`/setup` 安装管理员） | 自助注册 + 成员邀请 |
| 租户 | 隐式唯一 Default | 创建 / 切换 / 超管后台 |
| 启用 | 默认 | `ZAKURA_EDITION=saas` |

## 登录 OAuth（SaaS）

平台超管可在 `/dashboard/admin` 配置 **ZeroCat OAuth**（授权码 + PKCE）：

- 回调地址：`{ZAKURA_WEB_URL}/oauth/zerocat/callback`
- Client Secret 加密存入平台 settings，不回传前端
- 启用且配置完整后，登录页出现「使用 ZeroCat 登录」
- 首次登录可按配置自动创建用户与租户（或仅允许已有邮箱关联）

## 启用 SaaS（开发仓）

在仓库根目录或 `apps/server/` 的 `.env` 中设置（server 启动时会自动加载）：

```bash
ZAKURA_EDITION=saas
```

重启 server 后：

- 启动日志应出现 `edition  : saas (multi-tenant)`
- `GET /api/platform` 返回 `edition: "saas"`、`registrationEnabled: true`
- 开放 `POST /api/auth/register`、成员/邀请、多租户与 `/api/admin/*`
- Web：`/register`、成员页、租户切换、超管台
- 若原先按单账户安装：默认租户 owner 会自动提升为平台超管；**请重新登录** 以刷新 session

若日志仍是 `oss`，检查：`@zakura/saas` 是否已 `pnpm install` 且 `packages/saas` 已 build（`pnpm --filter @zakura/saas build`）。

## 剥离为纯开源树

```bash
# 预览
pnpm strip:saas -- --dry-run

# 输出到旁路目录（推荐，不改坏当前仓）
pnpm strip:saas -- --out ../Zakura-oss

# 或原地删除（破坏性）
pnpm strip:saas
```

脚本会：

1. 删除 `packages/saas`
2. 删除 SaaS-only Web 路由（见 `packages/saas/strip-manifest.json`）
3. 从 `apps/server` / `apps/web` 的 `package.json` 去掉 `@zakura/saas` 依赖

剥离后即使误设 `ZAKURA_EDITION=saas`，server 也会回退到 `oss` 并打 warning。

## 代码边界

| 位置 | 职责 |
|------|------|
| `apps/server` | 核心 API；`registerTenantRoutes` 仅 current/onboarding |
| `apps/server/src/saas-loader.ts` | 解析 edition、动态加载 `@zakura/saas` |
| `packages/saas` | 注册、多租户、成员邀请、超管路由 |
| `apps/web` 中 strip-manifest 列出的页面 | SaaS UI（strip 时删除） |

数据层始终保留 `tenants` / `tenant_id`（隔离模型）；开源版只是不暴露多租户与多账户能力。
