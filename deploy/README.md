# 后端运行说明

需要 Node.js 24+。本运行包包含 API、管理页面和运行依赖，不包含本地 Agent、用户数据或服务端凭据。

将 `deploy/server.env.example` 复制到运行包之外，填写方舟、管理员及可选 OSS 配置。生产环境必须使用绝对 `LIGHTMAO_DATA_DIR`，关闭 `LIGHTMAO_DEMO`，启用安全 Cookie，并将 `LIGHTMAO_WEB_ORIGINS` 设为实际 HTTPS 来源。

```bash
node --env-file=/etc/lightmao/server.env dist/api/index.js
```

确保环境文件只有服务账号可读。不要将密钥放入前端构建变量，不要在日志中打印环境变量。

API 默认只监听 `127.0.0.1:4318`。使用 `deploy/nginx.conf.example` 和 `deploy/lightmao-api.service` 作为反向代理及 systemd 模板，调整域名、证书、目录和运行账号后再启用。健康检查为 `/api/health`，管理页面为 `/admin`。

停止 API 后整体备份数据目录，包含 SQLite、对象文件及关联状态；不要只复制正在写入的 SQLite 主文件。运行包中的 `tools/backend-data.mjs` 提供备份与恢复工具，恢复时使用独立的新目录：

```bash
node tools/backend-data.mjs backup --data-dir /var/lib/lightmao --output /backups/lightmao-snapshot
node tools/backend-data.mjs restore --backup /backups/lightmao-snapshot --output /var/lib/lightmao-restored
```

更新运行包时保留数据目录及服务配置。

桌面客户端连接该后端的 HTTPS 地址，方舟及 OSS 密钥始终留在后端。
