# AI Engine (DSH / OpenCode) for Obsidian

在 Obsidian 内嵌 AI Agent Web UI 的插件，支持 **DSH（DeepSeek Harness）** 与 **OpenCode** 双引擎一键切换：插件自动托管所选引擎的子进程，ItemView 内 iframe 全尺寸嵌入官方界面。

An Obsidian plugin that embeds both the [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) and [OpenCode](https://github.com/sst/opencode) Web UIs in a full-size iframe, with one-click engine switching.

## 特性 / Features

- 🧭 **双引擎一键切换** — 视图顶部分段切换条 `[DSH][OpenCode]`，点击即切换引擎（单活性：切走时停掉自家托管的进程，外部实例不 kill）
  Segmented switch between DSH and OpenCode; single-active semantics (kills only processes it spawned).
- 🖥️ **官方 UI 零重建** — 直接嵌入 dsh Web UI / opencode serve Web UI
  Official Web UIs embedded as-is.
- 🔄 **进程自动托管** — 端口预检三态决策：已有实例(2xx)→复用；空闲(ECONNREFUSED)→自动 spawn；被其他程序占用(非2xx)→报错提示换端口（dsh 3080，opencode 3081）
  Smart port strategy: reuse / spawn / error, per engine.
- 🔐 **安全 kill 语义** — 只 kill 自己 spawn 的进程，绝不误杀手动启动的实例
  Kills only self-spawned processes; manually started instances are reused, never killed.
- 📊 **状态栏指示** — `AI ● DSH :3080` / `AI ● OC :3081` / `◐ 启动中` / `✗ 错误`，点击开关视图；视图自动跟随引擎状态（starting→running 自动加载，无需手动重试）
  Status bar indicator; view auto-follows the engine state.
- ⚙️ **完整设置页** — 默认引擎 / 自动托管 / 双引擎各自的端口、可执行路径、工作目录（opencode）、日志位置
  Per-engine settings: port, binary path, working dir, log path.
- 🚨 **错误面板 + 重试** — 连接失败显示原因与日志路径，一键重试
  Error panel with reason, log path and retry button.

## 安装 / Installation

1. 下载最新 release 的 `main.js`、`manifest.json`、`styles.css`
2. 放入 `<vault>/.obsidian/plugins/obsidian-dsh/`
3. Obsidian 设置 → 第三方插件 → 启用 **AI Engine**（插件 id 保持 `obsidian-dsh`）

Or build from source:

```bash
npm install
node esbuild.config.mjs   # 产出 main.js（若 vault 插件目录存在会自动复制）
```

## 使用 / Usage

1. 点击左侧 ribbon 机器人图标（或命令面板搜索「打开 AI Engine」）
2. 视图顶部分段条选择 **DSH** 或 **OpenCode**，插件自动探测/启动对应引擎，iframe 加载官方 UI
3. 引擎可执行路径自动探测（设置值 → 环境变量 `DSH_BIN`/`OPENCODE_BIN` → PATH → 常见安装位置），也可在设置里手动指定

默认端口：dsh `3080`、opencode `3081`。若端口已有实例在运行（如手动启动），插件会直接复用、不重复启动、卸载时不误杀。

## 前置要求 / Prerequisites

- Obsidian 桌面版（`isDesktopOnly: true`）
- dsh：本机安装 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- OpenCode：本机安装 [opencode](https://github.com/sst/opencode)（npm 全局安装即可）

## 测试 / Tests

```bash
node --test tests/process-manager.test.ts          # 端口决策 + spawn 命令组装单测（Node 24 原生跑 .ts）
DSH_INTEGRATION=1 node --test tests/process-manager.test.ts   # 集成：真实 spawn dsh → 健康检查 → kill
```

## 工作原理 / How it works

```
Obsidian (Electron)
 ├─ DshProcessManager ──spawn──▶ dsh:      node <dsh>/apps/cli/lib/bin.js web --port <port>
 │                              opencode: <opencode.exe> serve --port <port>   （cwd=配置工作目录）
 ├─ DshView (ItemView, "AI Engine")
 │   ├─ eng-tabs: [DSH] [OpenCode] 切换（switchEngine：dispose 旧管理器 → init 新 → refresh）
 │   └─ iframe ──▶ http://127.0.0.1:<current port>/
 └─ 单管理器单实例，engine 状态由 status-changed 事件驱动 UI 自动跟随
```

## License

MIT © 2026 kroetz
