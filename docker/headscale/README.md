# Zakura 平台托管 Headscale（**仅 SaaS**）

独立于主应用的 Tailscale 控制面，供多租户统一组网。OSS 单账户版不支持 Headscale，请使用 Tailscale 云并可选将主设备入网。

## 组件

| 服务 | 端口 | 说明 |
|------|------|------|
| **Headscale** | `8080` HTTP、`50443` gRPC、`3478/udp` STUN、`9090` metrics | 协调服务器（镜像建议 `0.29.2+`，需支持 `autogroup:self`） |
| **Headplane** | 默认映射 `3045→3000`（见 `.env`） | Web UI（agent + Docker 集成） |

ACL（[`config/policy.hujson`](config/policy.hujson)）：

- tagOwners 中的用户别名**必须含 `@`**（如 `platform@`），否则 Headscale 拒绝启动
- `tag:platform`：Zakura 主实例，可访问全部设备
- 每租户一个 Headscale User（`tenant-<id>@`），设备仅能访问自己的设备 + 平台节点

## 快速部署

```bash
cd docker/headscale
cp .env.example .env
# 编辑 .env 与 config/headscale.yaml：
#   - server_url → 公网 HTTPS
#   - dns.base_domain → 与 server_url 主机名不同（如 mesh.example.com）
# 编辑 config/headplane.yaml：
#   - server.base_url / headscale.public_url
#   - server.cookie_secret（32 字符）

docker compose up -d headscale
docker compose exec headscale headscale users create platform@
docker compose exec headscale headscale apikeys create --expiration 999d
# 将 API key 写入 .env 的 HEADSCALE_API_KEY 与 config/headplane.yaml → headscale.api_key

docker compose up -d
```

Headplane：`http://127.0.0.1:3045/admin/`（本地默认端口；经反代后为 `https://headscale.example.com/admin/`），用 API key 登录。

### 平台主节点 preauth key（可选手动）

```bash
# 列出 platform@ 用户 id
docker compose exec headscale headscale users list
# 创建带 tag:platform 的可复用 key（供 Zakura Server 入网）
docker compose exec headscale headscale preauthkeys create \
  -u 1 --reusable --tags tag:platform -e 8760h
# CLI 的 -u 为用户数字 ID（users list 第一列），不是用户名
```

主实例配置（写入 **超管后台**，**不要**写主应用 `.env`，也不要暴露给租户）：

1. 部署 Headscale 并创建 API key（见上文）
2. 打开 Zakura **超管** →「平台 Headscale」
3. 填写 Headscale URL、API Key，开启「启用平台托管网络」
4. 可选：粘贴 `tag:platform` 的 PreAuth Key；不填则首次启用时自动签发

配置存入数据库 `settings`（`owner_key=platform` / `key=network.headscale`），API Key 加密存储。仅平台超管可读写。

## HTTPS 反代（必需）

Tailscale 客户端要求 `server_url` 为 HTTPS。示例 Caddy：

```caddy
headscale.example.com {
  handle /admin* {
    reverse_proxy localhost:3000
  }
  reverse_proxy localhost:8080
}
```

Nginx 需同时转发 gRPC（`50443`）或把 gRPC 也挂到 443；STUN `3478/udp` 直通宿主机。

## 与主 compose 的关系

- **不要**把本目录服务并入根目录 `docker-compose.yml`
- 主应用通过控制台保存的 URL + API Key 管理用户 / preauth key / 节点
- 可同机不同 compose project；网络互通走公网 HTTPS 或内网 URL

## 备份与轮换

- SQLite：`docker volume` `zakura-headscale_headscale-data`（或 `docker compose exec` 拷贝 `/var/lib/headscale/db.sqlite`）
- API key 丢失：`headscale apikeys expire` 后重新 `create`，更新 Headplane 与主应用配置
- ACL：改 `config/policy.hujson` 后 `docker compose restart headscale`

## 健康检查

```bash
curl -sS "$HEADSCALE_SERVER_URL/version"
docker compose exec headscale headscale nodes list
```
