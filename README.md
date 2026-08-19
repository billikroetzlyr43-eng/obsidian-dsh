# DSH for Obsidian

在 Obsidian 内嵌 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) Web UI：插件自动托管 `dsh web` 子进程，ItemView 内 iframe 全尺寸嵌入官方界面。

Embeds the [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) Web UI inside Obsidian: the plugin manages the `dsh web` child process and renders its official interface in a full-size iframe.

## 特性 / Features

- 🖥️ **官方 UI 零重建** — 直接嵌入 dsh Web UI（会话、轨迹、工具调用可视化全功能）
  Official dsh Web UI, no re-implementation.
- 🔄 **进程自动托管** — 端口预检三态决策：已有实例(2xx)→复用；空闲(ECONNREFUSED)→自动 spawn；被其他程序占用(非2xx)→报错提示换端口
  Smart port strategy: reuse existing instance (2xx), auto-spawn when free (ECONNREFUSED), error on foreign process (non-2xx).
- 🔐 **安全 kill 语义** — 只 kill 自己 spawn 的进程，绝不误杀手动启动的 dsh 实例
  Kills only processes it spawned; never touches manually started instances.
- 💳 **账号天然共享** — 与终端 dsh 共用同一 `~/.dsh`（凭据/会话/额度），零配置
  Shares credentials, sessions and quota with your terminal dsh out of the box.
- 📊 **状态栏指示** — `● 运行中 :3080` / `◐ 启动中` / `○ 未启动` / `✗ 错误`，点击开关视图
  Status bar indicator; click to toggle the view.
- ⚙️ **完整设置页** — 端口 / 自动托管 / dsh 路径 / node 路径 / 日志位置
  Settings: port, auto-manage toggle, dsh binary path, node path, log path.
- 🚨 **错误面板 + 重试** — 连接失败显示原因与日志路径，一键重试，不白屏
  Error panel with reason, log path and retry button.

## 安装 / Installation

1. 下载最新 release 的 `main.js`、`manifest.json`、`styles.css`
2. 放入 `<vault>/.obsidian/plugins/obsidian-dsh/`
3. Obsidian 设置 → 第三方插件 → 启用 **DSH**

Or build from source:

```bash
npm install
node esbuild.config.mjs   # 产出 main.js（若 vault 插件目录存在会自动复制）
```

## 使用 / Usage

1. 点击左侧 ribbon 机器人图标（或命令面板搜索「打开 DSH」）
2. 插件自动探测/启动 dsh web，iframe 加载官方 UI
3. 在 dsh UI 中正常使用；状态栏实时反映进程状态

默认端口 `3080`：若你已在终端手动运行 `dsh web --port 3080`，插件会检测到并直接复用（不会重复启动，卸载时也不会误杀）。

## 前置要求 / Prerequisites

- Obsidian 桌面版（`isDesktopOnly: true`）
- 本机已安装 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（`node D:/path/to/deepseek-harness/apps/cli/lib/bin.js web --port <port>` 可启动）
- Node.js（dsh 运行环境）

## 测试 / Tests

```bash
node --test tests/                              # 端口决策单测
DSH_INTEGRATION=1 node --test tests/            # 集成测试：真实 spawn dsh web → 健康检查 → kill
```

## 工作原理 / How it works

```
Obsidian (Electron)
 └─ DshProcessManager ──spawn──▶ node <dsh>/apps/cli/lib/bin.js web --port <port>
 └─ DshView (ItemView) ──iframe──▶ http://127.0.0.1:<port>/   （dsh 官方 React UI）
        │
        └─ dsh 的 /api 信任围栏校验 Host header：loopback 天然放行（防 DNS rebinding / 跨站请求）
```

## 版本历史 / Version History

- **1.0.0 (current)** — 仅 DSH 单引擎。曾于 v2.0.0 引入 OpenCode 双引擎，因 opencode serve 的会话事件流端点（`/api/session/{id}/event`）在 Web 模式挂起、模型回复无法回显，已整体回滚移除 OpenCode，恢复纯 DSH 内核。
  Single-engine (DSH only). v2.0.0 added an OpenCode dual-engine but was rolled back: opencode serve's session event-stream endpoint (`/api/session/{id}/event`) hangs in Web mode so replies never render.
- **2.0.0 (retracted)** — 双引擎一键切换（DSH ↔ OpenCode），存在上述问题已撤销。
  Dual-engine (DSH ↔ OpenCode) with one-click switch; retracted due to the issue above.
- **1.0.0** — 初始版本：嵌入 dsh Web UI。Initial release: embed dsh Web UI.

## License

MIT © 2026 kroetz
