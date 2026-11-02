# LightMao

面向游戏开发的桌面 Agent 工作台，包含 Electron 桌面端、本地 Pi Agent、React 管理页面和 Fastify 后端。

支持项目与会话、恢复与分叉、Plan / Goal、Sub-Agent、插件与技能、资料空间、定时任务和 Trace。可调用方舟图片、视频、视觉理解及 System One 模型，制作游戏素材并验证浏览器与 Godot 游戏。

## 本地运行

需要 Node.js 24+、pnpm 11。首次安装会下载 Electron 运行时。

```bash
pnpm install
cp .env.example .env
pnpm dev
```

工作台为 <http://127.0.0.1:4317>，管理页面为 <http://127.0.0.1:4317/admin>。API 默认端口 4318，本地 Agent 默认端口 4319。开发模式提供明确标记的演示入口；真实模型未配置时会明确报错。

启动 Electron：

```bash
pnpm build
pnpm desktop
```

桌面默认关窗收起到托盘；明确退出会停止它启动的服务，复用的独立服务继续运行。开发数据保存在忽略的 `.lightmao/` 中。

## 模型与本地工具

仅在 API 服务所在机器的 `.env` 填写方舟密钥，变量见 [.env.example](.env.example)。前端及本地 Agent 不接收服务端模型或 OSS 密钥。

- 主 Agent 默认使用 `deepseek-v4-1-flash-261017`，最大输出配置为 128000。
- 视觉理解使用 Seed-Evolving；System One、图片和视频分别路由到专用模型。
- 首次启动由环境变量初始化路由，后续在管理页面修改；环境变量不会覆盖管理员已保存的配置。
- 内置角色序列帧、透明大招和批量图标技能；输出 PNG 帧、图集、锚点清单及检查报告。生成成功不代表素材或游戏验收通过。

运行默认使用全部内置权限；账号后续的明确选择会保留。执行仍校验项目范围、会话来源、共享租约和操作系统隔离。

游戏验证需要另行提供工具路径：

```dotenv
LIGHTMAO_GODOT_PATH=/absolute/path/Godot.app
LIGHTMAO_FFMPEG_PATH=/absolute/path/ffmpeg
```

Godot 在项目副本中运行；媒体处理需要 FFmpeg。当前本地执行隔离主要验证 macOS Seatbelt，其他平台的隔离执行仍待完善。

## 构建与部署

```bash
pnpm package:desktop
pnpm package:backend
```

桌面构建生成 macOS 应用和 DMG，后端构建生成独立 Node.js 24 运行包，产物存放在忽略的 `release/`。桌面安装版连接独立后端，不携带服务端密钥或开发数据。Developer ID 签名、公证及其他平台安装包仍待完善。

生产部署使用 [deploy/server.env.example](deploy/server.env.example)，操作步骤见 [后端运行说明](deploy/README.md)。关闭演示入口，配置管理员和 HTTPS，数据目录放在运行包之外。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm test:desktop
```

普通测试使用独立临时数据和本地协议夹具，不调用收费模型。浏览器测试需要 Playwright Chromium；原生测试使用 Electron。`verify:*live` 等实测脚本会访问真实模型或存储，运行前应检查其范围与额度。

提交前可安装仓库内的密钥检查钩子：

```bash
pnpm guard:install
pnpm check:secrets
```

密钥文件、设计文档与本地参考资料、工作区、验证回执和分发产物不随代码提交。`.env.example` 和部署模板仅提供空值及配置示例。

## 代码目录

```text
apps/desktop/       Electron 主进程与本地代理
apps/web/           工作台和管理页面
apps/agent/         Agent、项目、会话与本地执行
apps/api/           用户、资料、模型网关与后台接口
packages/           共享类型、存储和技能工具
examples/           可运行示例
scripts/            构建、维护与验证脚本
tests/              行为与服务集成测试
deploy/             后端部署模板与运行说明
```
