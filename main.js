"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => DshPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian3 = require("obsidian");
var import_fs = require("fs");
var import_child_process2 = require("child_process");
var path2 = __toESM(require("path"));
var os = __toESM(require("os"));

// src/dsh-view.ts
var import_obsidian = require("obsidian");

// src/process-manager.ts
var import_child_process = require("child_process");
var http = __toESM(require("http"));
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
function decidePortAction(health) {
  switch (health.kind) {
    case "http-response":
      if (health.status >= 200 && health.status < 300) {
        return { action: "reuse", external: true };
      }
      return {
        action: "error",
        reason: `\u7AEF\u53E3\u5DF2\u6709 HTTP \u670D\u52A1\u5728\u54CD\u5E94\uFF08\u72B6\u6001\u7801 ${health.status}\uFF09\uFF0C\u4F46\u975E\u6B63\u5E38 2xx\uFF0C\u7591\u4F3C\u88AB\u5176\u4ED6\u7A0B\u5E8F\u5360\u7528\uFF0C\u8BF7\u66F4\u6362\u7AEF\u53E3\u3002`
      };
    case "network-error":
      if (health.code === "ECONNREFUSED") {
        return { action: "spawn", external: false };
      }
      return {
        action: "spawn",
        external: false,
        warn: `\u7AEF\u53E3\u63A2\u6D4B\u7F51\u7EDC\u9519\u8BEF\uFF08${health.code}\uFF09\uFF0C\u6309\u7A7A\u95F2\u5904\u7406\u5E76\u5C1D\u8BD5\u542F\u52A8\u3002`
      };
    case "other-error":
      return {
        action: "spawn",
        external: false,
        warn: `\u7AEF\u53E3\u63A2\u6D4B\u5F02\u5E38\uFF08${health.message}\uFF09\uFF0C\u6309\u7A7A\u95F2\u5904\u7406\u5E76\u5C1D\u8BD5\u542F\u52A8\u3002`
      };
  }
}
function deriveDshCwd(dshBin) {
  return path.resolve(path.dirname(dshBin), "..", "..", "..");
}
function probePort(port, timeoutMs = 3e3) {
  return new Promise((resolve2) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/",
        headers: { Host: `127.0.0.1:${port}` },
        timeout: timeoutMs
      },
      (res) => {
        res.resume();
        resolve2({ kind: "http-response", status: res.statusCode ?? 0 });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error(`\u8BF7\u6C42\u8D85\u65F6\uFF08${timeoutMs}ms\uFF09`));
    });
    req.on("error", (err) => {
      if (err.code) {
        resolve2({ kind: "network-error", code: err.code, message: err.message });
      } else {
        resolve2({ kind: "other-error", message: err.message });
      }
    });
  });
}
function buildSpawnArgs(engine, cfg) {
  if (engine === "opencode") {
    return {
      command: cfg.binPath,
      args: ["serve", "--port", String(cfg.port)],
      cwd: cfg.cwd || ""
    };
  }
  return {
    command: cfg.nodePath || "node",
    args: [cfg.binPath, "web", "--port", String(cfg.port)],
    cwd: deriveDshCwd(cfg.binPath)
  };
}
var HEALTH_PROBE_INTERVAL_MS = 800;
var HEALTH_PROBE_MAX_MS = 6e4;
var DshProcessManager = class {
  cfg;
  state = "stopped";
  child = null;
  external = false;
  errorReason;
  listeners = /* @__PURE__ */ new Set();
  healthTimer = null;
  logStream = null;
  stopping = false;
  constructor(cfg) {
    this.cfg = { ...cfg, engine: cfg.engine ?? "dsh" };
  }
  // ---------- 只读查询 ----------
  getState() {
    return this.state;
  }
  getPort() {
    return this.cfg.port;
  }
  isExternal() {
    return this.external;
  }
  getErrorReason() {
    return this.errorReason;
  }
  // ---------- 事件 ----------
  /** 注册状态变更监听，返回取消函数 */
  onStatusChanged(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit() {
    const info = {
      state: this.state,
      port: this.cfg.port,
      external: this.external,
      reason: this.errorReason
    };
    this.listeners.forEach((l) => l(info));
  }
  setState(state, reason) {
    this.state = state;
    if (reason !== void 0) {
      this.errorReason = reason;
    }
    this.log(`\u72B6\u6001\u53D8\u66F4 \u2192 ${state}${reason ? `\uFF08${reason}\uFF09` : ""}`);
    this.emit();
  }
  // ---------- 端口预检 → 决策 → 执行 ----------
  /**
   * 确保 dsh 可用：端口预检 → decidePortAction 决策（复用/spawn/报错）→ 执行。
   * 已在 running / starting 时直接返回；error / stopped 状态会重新走一遍预检（支持重试）。
   */
  async ensureRunning() {
    if (this.state === "running" || this.state === "starting") {
      return;
    }
    this.stopping = false;
    this.log(`\u7AEF\u53E3\u9884\u68C0\u5F00\u59CB\uFF1Ahttp://127.0.0.1:${this.cfg.port}/`);
    const health = await probePort(this.cfg.port);
    const action = decidePortAction(health);
    this.log(`\u7AEF\u53E3\u9884\u68C0\u7ED3\u679C\uFF1Aaction=${action.action}`);
    switch (action.action) {
      case "reuse":
        this.external = true;
        this.child = null;
        this.setState("running", `\u590D\u7528\u5DF2\u6709\u5B9E\u4F8B\uFF08\u7AEF\u53E3 ${this.cfg.port}\uFF09`);
        return;
      case "error":
        this.external = false;
        this.setState("error", action.reason);
        return;
      case "spawn":
        this.external = false;
        if (action.warn) {
          this.log(`[\u544A\u8B66] ${action.warn}`);
        }
        await this.startChild();
        return;
    }
  }
  // ---------- spawn + 健康检查 ----------
  /** spawn 子进程并进入 starting 态，随后开始健康检查循环（§2.2 用 buildSpawnArgs 组装命令） */
  async startChild() {
    const { engine } = this.cfg;
    const binPath = engine === "opencode" ? this.cfg.opencodeBinPath ?? "" : this.cfg.dshBinPath ?? "";
    if (!binPath) {
      this.setState(
        "error",
        engine === "opencode" ? "\u672A\u914D\u7F6E opencode \u53EF\u6267\u884C\u8DEF\u5F84\uFF1A\u8BF7\u5728\u63D2\u4EF6\u8BBE\u7F6E\u4E2D\u586B\u5199 opencode \u7684 exe \u8DEF\u5F84\uFF0C\u6216\u8BBE\u7F6E\u73AF\u5883\u53D8\u91CF OPENCODE_BIN\u3002" : "\u672A\u914D\u7F6E dsh \u53EF\u6267\u884C\u8DEF\u5F84\uFF1A\u8BF7\u5728\u63D2\u4EF6\u8BBE\u7F6E\u4E2D\u586B\u5199 dsh \u7684 bin.js \u8DEF\u5F84\uFF0C\u6216\u8BBE\u7F6E\u73AF\u5883\u53D8\u91CF DSH_BIN\u3002"
      );
      return;
    }
    const { command, args, cwd } = buildSpawnArgs(engine, {
      engine,
      binPath,
      nodePath: this.cfg.nodePath,
      port: this.cfg.port,
      cwd: this.cfg.cwd
    });
    if (!cwd || !fs.existsSync(cwd)) {
      this.setState(
        "error",
        engine === "opencode" ? `opencode \u5DE5\u4F5C\u76EE\u5F55\u4E0D\u5B58\u5728\uFF1A${cwd || "(\u7A7A)"}\uFF0C\u8BF7\u68C0\u67E5\u201COpenCode \u5DE5\u4F5C\u76EE\u5F55\u201D\u8BBE\u7F6E\u3002` : `dsh \u9879\u76EE\u6839\u76EE\u5F55\u4E0D\u5B58\u5728\uFF1A${cwd}\uFF0C\u8BF7\u68C0\u67E5\u201Cdsh \u53EF\u6267\u884C\u8DEF\u5F84\u201D\u8BBE\u7F6E\u3002`
      );
      return;
    }
    this.openLog();
    this.log(`spawn\uFF1A${command} ${args.join(" ")}\uFF08cwd=${cwd}\uFF09`);
    this.setState("starting");
    let child;
    try {
      child = (0, import_child_process.spawn)(command, args, {
        cwd,
        detached: false,
        windowsHide: true
      });
    } catch (err) {
      this.setState("error", `\u542F\u52A8 ${engine} \u8FDB\u7A0B\u5931\u8D25\uFF1A${err?.message ?? String(err)}`);
      return;
    }
    this.child = child;
    child.stdout?.on("data", (chunk) => {
      this.log(`[stdout] ${chunk.toString()}`);
    });
    child.stderr?.on("data", (chunk) => {
      this.log(`[stderr] ${chunk.toString()}`);
    });
    child.on("error", (err) => {
      this.log(`\u5B50\u8FDB\u7A0B error \u4E8B\u4EF6\uFF1A${err.message}`);
      this.child = null;
      this.stopHealthCheck();
      this.setState("error", `\u542F\u52A8 ${engine} \u8FDB\u7A0B\u5931\u8D25\uFF1A${err.message}`);
    });
    child.on("exit", (code, signal) => {
      this.log(`\u5B50\u8FDB\u7A0B\u9000\u51FA code=${code} signal=${signal}`);
      this.child = null;
      this.stopHealthCheck();
      if (this.state === "starting" || this.state === "running") {
        this.setState("error", `${engine} web \u8FDB\u7A0B\u9000\u51FA\uFF08code=${code ?? "\u65E0"}\uFF09\uFF0C\u8BF7\u67E5\u770B\u65E5\u5FD7\uFF1A${this.cfg.logFile}`);
      }
    });
    this.beginHealthCheck();
  }
  /** starting 期间每 800ms 健康检查，最多 60s；健康即转 running */
  beginHealthCheck() {
    this.stopHealthCheck();
    const start = Date.now();
    this.healthTimer = setInterval(async () => {
      if (this.stopping) {
        return;
      }
      const health = await probePort(this.cfg.port);
      const action = decidePortAction(health);
      if (action.action === "reuse") {
        this.stopHealthCheck();
        this.external = false;
        this.setState("running", `\u5065\u5EB7\u68C0\u67E5\u901A\u8FC7\uFF08\u7AEF\u53E3 ${this.cfg.port}\uFF09`);
        return;
      }
      if (Date.now() - start > HEALTH_PROBE_MAX_MS) {
        this.stopHealthCheck();
        this.setState(
          "error",
          `${this.cfg.engine} \u542F\u52A8\u540E ${HEALTH_PROBE_MAX_MS / 1e3} \u79D2\u5185\u5065\u5EB7\u68C0\u67E5\u672A\u901A\u8FC7\uFF0C\u8BF7\u67E5\u770B\u65E5\u5FD7\uFF1A${this.cfg.logFile}`
        );
        await this.killOwnChild();
      }
    }, HEALTH_PROBE_INTERVAL_MS);
  }
  stopHealthCheck() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }
  // ---------- kill（只 kill 自己 spawn 的） ----------
  /**
   * 停止托管：只 kill 自己 spawn 的进程；外部实例（external=true）绝不 kill。
   * 幂等。
   */
  async stop() {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.stopHealthCheck();
    if (this.external) {
      this.log("external \u5B9E\u4F8B\uFF1A\u4EC5\u505C\u6B62\u6258\u7BA1\u72B6\u6001\uFF0C\u4E0D kill \u5916\u90E8\u8FDB\u7A0B");
      this.setState("stopped");
      this.stopping = false;
      return;
    }
    this.setState("stopped");
    await this.killOwnChild();
    this.stopping = false;
  }
  /** kill 自己 spawn 的进程：Windows 下 process.kill 后补 taskkill /T /F 兜底（子进程可能带孙子进程） */
  async killOwnChild() {
    const child = this.child;
    this.child = null;
    if (!child || !child.pid) {
      return;
    }
    const pid = child.pid;
    this.log(`kill \u81EA\u5DF1\u6258\u7BA1\u7684\u8FDB\u7A0B pid=${pid}`);
    try {
      process.kill(pid);
    } catch (err) {
      this.log(`process.kill \u5931\u8D25\uFF08\u53EF\u80FD\u5DF2\u9000\u51FA\uFF09\uFF1A${err?.message ?? String(err)}`);
    }
    if (process.platform === "win32") {
      await this.runTaskkill(pid);
    }
  }
  runTaskkill(pid) {
    return new Promise((resolve2) => {
      const t = (0, import_child_process.spawn)("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      t.on("error", () => resolve2());
      t.on("exit", () => resolve2());
      t.on("close", () => resolve2());
    });
  }
  // ---------- 配置与生命周期 ----------
  /**
   * 设置变更时更新配置。若自己托管的子进程端口与新的不一致 → 停掉自己的旧进程
   * （外部实例不动），等待下次 ensureRunning 在新端口上重新拉起。
   */
  async updateConfig(cfg) {
    const oldPort = this.cfg.port;
    const newPort = cfg.port ?? oldPort;
    const ownsChild = !this.external && this.child !== null;
    Object.assign(this.cfg, cfg);
    if (ownsChild && newPort !== oldPort) {
      this.log(`\u7AEF\u53E3\u7531 ${oldPort} \u6539\u4E3A ${newPort}\uFF0C\u505C\u6B62\u81EA\u5DF1\u6258\u7BA1\u7684\u65E7\u8FDB\u7A0B`);
      await this.stop();
    }
  }
  /** 插件卸载时调用：kill 自己 spawn 的进程并关闭日志流 */
  async dispose() {
    await this.stop();
    this.closeLog();
    this.listeners.clear();
  }
  // ---------- 日志 ----------
  /** 打开日志流（append 模式），目录不存在则创建 */
  openLog() {
    if (this.logStream) {
      return;
    }
    try {
      const dir = path.dirname(this.cfg.logFile);
      fs.mkdirSync(dir, { recursive: true });
      this.logStream = fs.createWriteStream(this.cfg.logFile, { flags: "a" });
    } catch (err) {
      console.error("[obsidian-dsh] \u6253\u5F00\u65E5\u5FD7\u6587\u4EF6\u5931\u8D25:", err);
      this.logStream = null;
    }
  }
  closeLog() {
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
  }
  /** 带时间戳追加一行日志（写日志文件 + 控制台） */
  log(message) {
    const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${message}`;
    console.log("[obsidian-dsh]", line);
    if (this.logStream) {
      this.logStream.write(line + "\n");
    }
  }
};

// src/dsh-view.ts
var VIEW_TYPE_DSH = "obsidian-dsh-view";
var ENGINE_TABS = [
  { engine: "dsh", label: "DSH", short: "dsh" },
  { engine: "opencode", label: "OpenCode", short: "opencode" }
];
var DshView = class extends import_obsidian.ItemView {
  plugin;
  iframeEl = null;
  loadingEl = null;
  errorEl = null;
  errorDetailEl = null;
  errorMetaEl = null;
  tabEls = /* @__PURE__ */ new Map();
  dotEls = /* @__PURE__ */ new Map();
  statusUnsub = null;
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType() {
    return VIEW_TYPE_DSH;
  }
  getDisplayText() {
    return "AI Engine";
  }
  getIcon() {
    return "bot";
  }
  async onOpen() {
    this.contentEl.addClass("dsh-view-content");
    this.buildDom();
    await this.refresh();
  }
  async onClose() {
    this.statusUnsub?.();
    this.statusUnsub = null;
    this.contentEl.empty();
  }
  /** 重建 DOM：引擎分段条 + loading + iframe + 错误面板（stage 全尺寸填充） */
  buildDom() {
    this.contentEl.empty();
    const container = this.contentEl.createDiv({ cls: "dsh-view-container" });
    const tabs = container.createDiv({ cls: "eng-tabs" });
    for (const t of ENGINE_TABS) {
      const btn = tabs.createEl("button", { cls: "eng-tab", attr: { "data-engine": t.engine } });
      const dot = btn.createSpan({ cls: "eng-dot" });
      btn.createSpan({ cls: "eng-tab-label", text: t.label });
      btn.addEventListener("click", () => {
        if (t.engine !== this.plugin.getEngine()) {
          this.plugin.switchEngine(t.engine);
        }
      });
      this.tabEls.set(t.engine, btn);
      this.dotEls.set(t.engine, dot);
    }
    const stage = container.createDiv({ cls: "dsh-view-stage" });
    this.loadingEl = stage.createDiv({ cls: "dsh-view-loading", text: "\u6B63\u5728\u8FDE\u63A5\u2026" });
    this.iframeEl = stage.createEl("iframe", { cls: "dsh-view-iframe" });
    this.iframeEl.setAttribute("allow", "clipboard-write; clipboard-read");
    this.iframeEl.addEventListener("load", () => this.onIframeLoaded());
    this.iframeEl.addEventListener("error", () => this.onIframeError());
    this.errorEl = stage.createDiv({ cls: "dsh-view-error" });
    this.errorEl.style.display = "none";
    this.errorEl.createDiv({ cls: "dsh-view-error-title", text: "\u65E0\u6CD5\u8FDE\u63A5" });
    this.errorDetailEl = this.errorEl.createDiv({ cls: "dsh-view-error-detail" });
    this.errorMetaEl = this.errorEl.createDiv({ cls: "dsh-view-error-meta" });
    const retryBtn = this.errorEl.createEl("button", { cls: "mod-cta", text: "\u91CD\u8BD5" });
    retryBtn.addEventListener("click", () => this.refresh());
  }
  /** 刷新切换条：当前引擎高亮 + 状态圆点（当前引擎取 manager 状态，另一引擎置灰） */
  updateTabs() {
    const current = this.plugin.getEngine();
    const manager = this.plugin.getManager();
    const st = manager ? manager.getState() : "stopped";
    for (const t of ENGINE_TABS) {
      const btn = this.tabEls.get(t.engine);
      if (!btn)
        continue;
      if (t.engine === current) {
        btn.addClass("is-active");
      } else {
        btn.removeClass("is-active");
      }
      const dot = this.dotEls.get(t.engine);
      if (!dot)
        continue;
      const dotState = t.engine === current ? st : "stopped";
      dot.removeClass("eng-dot-running", "eng-dot-starting", "eng-dot-error", "eng-dot-stopped");
      dot.addClass(`eng-dot-${dotState}`);
      dot.setAttribute("title", dotState);
    }
  }
  /**
   * 刷新视图连接：确保进程（自动托管时）→ 健康检查 → 加载 iframe / 显示错误面板。
   * 重试按钮也调用本方法。
   */
  async refresh() {
    const engine = this.plugin.getEngine();
    const port = this.plugin.getEnginePort();
    const engineName = this.plugin.getEngineName();
    this.statusUnsub?.();
    this.statusUnsub = null;
    this.updateTabs();
    this.showLoading(engineName);
    if (this.plugin.settings.autoManageProcess) {
      const manager = this.plugin.getManager();
      if (!manager) {
        this.showError("\u8FDB\u7A0B\u6258\u7BA1\u672A\u521D\u59CB\u5316", "\u81EA\u52A8\u6258\u7BA1\u5DF2\u5F00\u542F\u4F46\u6258\u7BA1\u5668\u672A\u521D\u59CB\u5316\uFF0C\u8BF7\u5230\u8BBE\u7F6E\u91CC\u5207\u6362\u540E\u91CD\u8BD5\u3002");
        this.updateTabs();
        return;
      }
      this.statusUnsub = manager.onStatusChanged((info) => {
        this.updateTabs();
        if (this.plugin.getEngine() !== engine) {
          return;
        }
        if (info.state === "running" && info.port === this.plugin.getEnginePort()) {
          this.loadIframe(info.port);
        } else if (info.state === "starting") {
          this.showLoading(this.plugin.getEngineName());
        } else if (info.state === "error") {
          this.showError(`${this.plugin.getEngineName()} \u542F\u52A8\u5931\u8D25`, info.reason ?? "\u672A\u77E5\u9519\u8BEF");
        }
      });
      await manager.ensureRunning();
      const st = manager.getState();
      this.updateTabs();
      if (st === "error") {
        this.showError(`${engineName} \u542F\u52A8\u5931\u8D25`, manager.getErrorReason() ?? "\u672A\u77E5\u9519\u8BEF");
        return;
      }
      if (st !== "running") {
        this.showLoaderUntil(engineName);
        return;
      }
    }
    const health = await probePort(port);
    const action = decidePortAction(health);
    if (action.action === "reuse") {
      this.loadIframe(port);
    } else if (action.action === "error") {
      this.showError("\u7AEF\u53E3\u88AB\u5176\u4ED6\u7A0B\u5E8F\u5360\u7528", `${action.reason}
\u8BF7\u5230\u63D2\u4EF6\u8BBE\u7F6E\u4E2D\u66F4\u6362${engineName}\u7AEF\u53E3\u3002`);
    } else {
      this.showError(
        "\u65E0\u6CD5\u8FDE\u63A5",
        `${engineName} \u672A\u5728\u8FD0\u884C\u3002\u82E5\u5DF2\u5173\u95ED\u201C\u81EA\u52A8\u6258\u7BA1\u8FDB\u7A0B\u201D\uFF0C\u8BF7\u624B\u52A8\u8FD0\u884C\uFF1A
${engine === "opencode" ? `<opencodeBin> serve --port ${port}` : `node <dshBin> web --port ${port}`}`
      );
    }
  }
  // ---------- 展示状态 ----------
  /** 引擎 starting 期间保持 loading 态，等待状态订阅在 running 时自动加载 iframe */
  showLoaderUntil(engineName) {
    this.showLoading(engineName);
  }
  showLoading(engineName) {
    if (this.loadingEl) {
      this.loadingEl.textContent = `\u6B63\u5728\u8FDE\u63A5 ${engineName}\u2026`;
      this.loadingEl.style.display = "";
    }
    if (this.iframeEl)
      this.iframeEl.style.display = "none";
    if (this.errorEl)
      this.errorEl.style.display = "none";
  }
  showIframe() {
    if (this.loadingEl)
      this.loadingEl.style.display = "none";
    if (this.iframeEl)
      this.iframeEl.style.display = "";
    if (this.errorEl)
      this.errorEl.style.display = "none";
  }
  showError(title, detail) {
    if (this.loadingEl)
      this.loadingEl.style.display = "none";
    if (this.iframeEl)
      this.iframeEl.style.display = "none";
    if (this.errorEl)
      this.errorEl.style.display = "";
    const titleEl = this.errorEl?.querySelector(".dsh-view-error-title");
    if (titleEl)
      titleEl.textContent = title;
    if (this.errorDetailEl)
      this.errorDetailEl.textContent = detail;
    if (this.errorMetaEl) {
      this.errorMetaEl.textContent = `\u5F15\u64CE\uFF1A${this.plugin.getEngineName()} \uFF5C \u7AEF\u53E3\uFF1A${this.plugin.getEnginePort()} \uFF5C \u65E5\u5FD7\uFF1A${this.plugin.resolveLogPath()}`;
    }
  }
  // ---------- iframe 加载 ----------
  /** 健康检查通过后加载/重载 iframe（当前引擎端口） */
  loadIframe(port) {
    if (!this.iframeEl)
      return;
    const url = `http://127.0.0.1:${port}/`;
    this.iframeEl.src = url;
  }
  onIframeLoaded() {
    this.showIframe();
  }
  onIframeError() {
    this.showError(
      "\u9875\u9762\u52A0\u8F7D\u5931\u8D25",
      `\u65E0\u6CD5\u52A0\u8F7D ${this.iframeEl?.src ?? ""}
\u8BF7\u786E\u8BA4\u5F15\u64CE\u670D\u52A1\u53EF\u8BBF\u95EE\uFF0C\u6216\u70B9\u51FB\u91CD\u8BD5\u3002`
    );
  }
};

// src/settings.ts
var import_obsidian2 = require("obsidian");
var DEFAULT_SETTINGS = {
  engine: "dsh",
  autoManageProcess: true,
  port: 3080,
  dshBinPath: "",
  // 留空 → 启动时自动探测（见 main.ts resolveDshBinPath）
  nodePath: "node",
  dshLogFilePath: "",
  // 留空 → 插件加载时按 vault 路径填充默认值
  opencodePort: 3081,
  opencodeBinPath: "",
  // 留空 → 启动时自动探测（见 main.ts resolveOpencodeBinPath）
  opencodeCwd: "D:\\workspace",
  opencodeLogFilePath: ""
  // 留空 → 插件加载时按 vault 路径填充默认值
};
var PORT_MIN = 1024;
var PORT_MAX = 65535;
function clampPort(port) {
  if (!Number.isFinite(port)) {
    return DEFAULT_SETTINGS.port;
  }
  return Math.min(PORT_MAX, Math.max(PORT_MIN, Math.trunc(port)));
}
var DshSettingTab = class extends import_obsidian2.PluginSettingTab {
  plugin;
  applyTimer = null;
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian2.Setting(containerEl).setName("\u9ED8\u8BA4\u5F15\u64CE").setDesc("\u9009\u62E9\u5F53\u524D\u6258\u7BA1/\u67E5\u770B\u7684\u5F15\u64CE\uFF1ADSH \u6216 OpenCode\u3002\u5207\u6362\u65F6\u81EA\u52A8\u505C\u6B62\u4E0A\u4E00\u5F15\u64CE\u6258\u7BA1\u7684\u8FDB\u7A0B\uFF08\u5916\u90E8\u5B9E\u4F8B\u4E0D kill\uFF09\u3002").addDropdown((dd) => {
      dd.addOption("dsh", "DSH");
      dd.addOption("opencode", "OpenCode");
      dd.setValue(this.plugin.settings.engine);
      dd.onChange(async (value) => {
        await this.plugin.switchEngine(value || "dsh");
      });
    });
    new import_obsidian2.Setting(containerEl).setName("\u81EA\u52A8\u6258\u7BA1\u8FDB\u7A0B").setDesc("\u5F00\u542F\u540E\u63D2\u4EF6\u81EA\u52A8 spawn / \u590D\u7528\u5F53\u524D\u5F15\u64CE\u7684\u5B50\u8FDB\u7A0B\uFF08\u9ED8\u8BA4\u5F00\u542F\uFF09\uFF1B\u5173\u95ED\u540E\u9700\u8981\u624B\u52A8\u8FD0\u884C\u5BF9\u5E94\u5F15\u64CE\u3002").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.autoManageProcess).onChange(async (value) => {
        this.plugin.settings.autoManageProcess = value;
        await this.plugin.saveSettings();
        this.plugin.applySettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("DSH \u914D\u7F6E").setHeading();
    new import_obsidian2.Setting(containerEl).setName("\u7AEF\u53E3").setDesc(`dsh web \u76D1\u542C\u7AEF\u53E3\uFF08\u8303\u56F4 ${PORT_MIN}-${PORT_MAX}\uFF0C\u9ED8\u8BA4 3080\uFF09\u3002\u82E5\u8BE5\u7AEF\u53E3\u5DF2\u6709\u5B9E\u4F8B\u5728\u8FD0\u884C\uFF08\u5982\u7528\u6237\u624B\u52A8\u542F\u52A8\u7684 dsh\uFF09\uFF0C\u63D2\u4EF6\u4F1A\u76F4\u63A5\u590D\u7528\uFF0C\u4E0D\u91CD\u590D\u542F\u52A8\u3002`).addText(
      (text) => text.setPlaceholder("3080").setValue(String(this.plugin.settings.port)).onChange((value) => {
        this.plugin.settings.port = clampPort(Number(value));
        this.debounceApply();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("dsh \u53EF\u6267\u884C\u8DEF\u5F84").setDesc("dsh web \u7684 bin.js \u8DEF\u5F84\uFF0C\u9ED8\u8BA4 D:/deepseek-harness/apps/cli/lib/bin.js").addText(
      (text) => text.setPlaceholder("D:/deepseek-harness/apps/cli/lib/bin.js").setValue(this.plugin.settings.dshBinPath).onChange((value) => {
        this.plugin.settings.dshBinPath = value.trim() || DEFAULT_SETTINGS.dshBinPath;
        this.debounceApply();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("node \u53EF\u6267\u884C\u8DEF\u5F84").setDesc("\u542F\u52A8 dsh web \u4F7F\u7528\u7684 node \u547D\u4EE4\uFF0C\u9ED8\u8BA4 node\uFF08\u5373 PATH \u4E2D\u7684 node\uFF09").addText(
      (text) => text.setPlaceholder("node").setValue(this.plugin.settings.nodePath).onChange((value) => {
        this.plugin.settings.nodePath = value.trim() || "node";
        this.debounceApply();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("DSH \u65E5\u5FD7\u4F4D\u7F6E").setDesc("dsh web \u5B50\u8FDB\u7A0B stdout/stderr \u7684\u65E5\u5FD7\u6587\u4EF6\u8DEF\u5F84\uFF08\u8FFD\u52A0\u5199\u5165\uFF0C\u5E26\u65F6\u95F4\u6233\uFF09").addText(
      (text) => text.setPlaceholder(".obsidian/plugins/obsidian-dsh/dsh-web.log").setValue(this.plugin.settings.dshLogFilePath).onChange((value) => {
        this.plugin.settings.dshLogFilePath = value.trim();
        this.debounceApply();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("OpenCode \u914D\u7F6E").setHeading();
    new import_obsidian2.Setting(containerEl).setName("OpenCode \u7AEF\u53E3").setDesc(`opencode serve \u76D1\u542C\u7AEF\u53E3\uFF08\u9ED8\u8BA4 3081\uFF09\u3002\u82E5\u8BE5\u7AEF\u53E3\u5DF2\u6709\u5B9E\u4F8B\u5728\u8FD0\u884C\uFF0C\u63D2\u4EF6\u4F1A\u76F4\u63A5\u590D\u7528\u3002`).addText(
      (text) => text.setPlaceholder("3081").setValue(String(this.plugin.settings.opencodePort)).onChange((value) => {
        this.plugin.settings.opencodePort = clampPort(Number(value));
        this.debounceApply();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("OpenCode \u53EF\u6267\u884C\u8DEF\u5F84").setDesc("opencode \u7684 exe \u8DEF\u5F84\uFF1B\u7559\u7A7A\u81EA\u52A8\u63A2\u6D4B\uFF1A\u73AF\u5883\u53D8\u91CF OPENCODE_BIN \u2192 PATH \u4E2D\u7684 opencode \u2192 \u5E38\u89C1\u5B89\u88C5\u4F4D\u7F6E").addText(
      (text) => text.setPlaceholder("C:/Users/.../opencode-ai/bin/opencode.exe").setValue(this.plugin.settings.opencodeBinPath).onChange((value) => {
        this.plugin.settings.opencodeBinPath = value.trim() || DEFAULT_SETTINGS.opencodeBinPath;
        this.debounceApply();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("OpenCode \u5DE5\u4F5C\u76EE\u5F55").setDesc("opencode serve \u542F\u52A8\u65F6\u7684\u5DE5\u4F5C\u76EE\u5F55\uFF08\u9ED8\u8BA4 D:\\workspace\uFF09").addText(
      (text) => text.setPlaceholder("D:\\workspace").setValue(this.plugin.settings.opencodeCwd).onChange((value) => {
        this.plugin.settings.opencodeCwd = value.trim() || DEFAULT_SETTINGS.opencodeCwd;
        this.debounceApply();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("OpenCode \u65E5\u5FD7\u4F4D\u7F6E").setDesc("opencode serve \u5B50\u8FDB\u7A0B stdout/stderr \u7684\u65E5\u5FD7\u6587\u4EF6\u8DEF\u5F84\uFF08\u8FFD\u52A0\u5199\u5165\uFF0C\u5E26\u65F6\u95F4\u6233\uFF09").addText(
      (text) => text.setPlaceholder(".obsidian/plugins/obsidian-dsh/opencode-web.log").setValue(this.plugin.settings.opencodeLogFilePath).onChange((value) => {
        this.plugin.settings.opencodeLogFilePath = value.trim();
        this.debounceApply();
      })
    );
  }
  /** 文本输入防抖（端口/路径逐字符 onChange，400ms 后再保存与应用，避免反复停启进程） */
  debounceApply() {
    if (this.applyTimer) {
      clearTimeout(this.applyTimer);
    }
    this.applyTimer = setTimeout(async () => {
      this.applyTimer = null;
      await this.plugin.saveSettings();
      this.plugin.applySettings();
    }, 400);
  }
};

// src/main.ts
var ENGINE_NAME = {
  dsh: "DSH",
  opencode: "OpenCode"
};
var ENGINE_SHORT = {
  dsh: "DSH",
  opencode: "OC"
};
var DshPlugin = class extends import_obsidian3.Plugin {
  // 覆盖 obsidian Plugin 基类新增的 settings?: unknown，按官方文档模式声明具体类型并给初始化器
  settings = DEFAULT_SETTINGS;
  manager = null;
  statusBarEl = null;
  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE_DSH, (leaf) => new DshView(leaf, this));
    this.addRibbonIcon("bot", "\u6253\u5F00 AI Engine", () => this.toggleView());
    this.addCommand({ id: "open-dsh", name: "\u6253\u5F00 AI Engine", callback: () => this.toggleView() });
    this.addSettingTab(new DshSettingTab(this.app, this));
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("dsh-status-bar");
    this.statusBarEl.addEventListener("click", () => this.toggleView());
    this.statusBarEl.title = "\u70B9\u51FB\u6253\u5F00/\u5173\u95ED AI Engine \u89C6\u56FE";
    if (this.settings.autoManageProcess) {
      this.initManager();
    }
    this.updateStatusBar();
  }
  onunload() {
    this.manager?.dispose();
    this.manager = null;
  }
  // ---------- 设置 ----------
  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
    this.settings.port = clampPort(this.settings.port);
    this.settings.opencodePort = clampPort(this.settings.opencodePort);
    if (!this.settings.dshLogFilePath) {
      this.settings.dshLogFilePath = this.defaultLogPath("dsh");
    }
    if (!this.settings.opencodeLogFilePath) {
      this.settings.opencodeLogFilePath = this.defaultLogPath("opencode");
    }
  }
  /** 保存设置到 data.json */
  async saveSettings() {
    await this.saveData(this.settings);
  }
  /** 默认日志路径（§2.4 按引擎隔离）：<vault>/.obsidian/plugins/obsidian-dsh/<engine>-web.log */
  defaultLogPath(engine) {
    const adapter = this.app.vault.adapter;
    const base = adapter instanceof import_obsidian3.FileSystemAdapter ? adapter.getBasePath() : "";
    return path2.join(base, ".obsidian", "plugins", "obsidian-dsh", `${engine === "opencode" ? "opencode" : "dsh"}-web.log`);
  }
  /** 解析当前（或指定）引擎的日志路径（设置为空时用默认值） */
  resolveLogPath(engine = this.settings.engine) {
    return engine === "opencode" ? this.settings.opencodeLogFilePath || this.defaultLogPath("opencode") : this.settings.dshLogFilePath || this.defaultLogPath("dsh");
  }
  /** 设置保存后调用：同步进程托管配置、状态栏与视图（§2.6） */
  async applySettings() {
    if (this.settings.autoManageProcess) {
      if (!this.manager) {
        this.initManager();
      } else {
        const config = this.buildProcessConfig(this.settings.engine);
        await this.manager.updateConfig(config);
      }
    } else if (this.manager) {
      await this.manager.dispose();
      this.manager = null;
    }
    this.updateStatusBar();
    const view = this.getView();
    if (view) {
      await view.refresh();
    }
  }
  /**
   * 切换引擎（§2.6 单活性）：
   *  1. next === 当前 → 直接 return
   *  2. 写 settings.engine → 保存
   *  3. 若 manager 存在 → dispose（自托管进程被杀；external 实例只停托管）→ 置 null
   *  4. （自动托管时）按新引擎 initManager → 更新状态栏 → 视图 refresh
   */
  async switchEngine(next) {
    if (next === this.settings.engine) {
      return;
    }
    this.settings.engine = next;
    await this.saveSettings();
    if (this.manager) {
      await this.manager.dispose();
      this.manager = null;
    }
    if (this.settings.autoManageProcess) {
      this.initManager();
    }
    this.updateStatusBar();
    const view = this.getView();
    if (view) {
      await view.refresh();
    }
  }
  // ---------- 进程托管 ----------
  getManager() {
    return this.manager;
  }
  /** 按当前引擎组装托管配置（§2.6） */
  buildProcessConfig(engine) {
    if (engine === "opencode") {
      return {
        engine: "opencode",
        opencodeBinPath: this.resolveOpencodeBinPath(),
        port: this.settings.opencodePort,
        cwd: this.settings.opencodeCwd,
        logFile: this.resolveLogPath("opencode")
      };
    }
    return {
      engine: "dsh",
      dshBinPath: this.resolveDshBinPath(),
      nodePath: this.settings.nodePath,
      port: this.settings.port,
      logFile: this.resolveLogPath("dsh")
    };
  }
  initManager() {
    this.manager = new DshProcessManager(this.buildProcessConfig(this.settings.engine));
    this.manager.onStatusChanged(() => this.updateStatusBar());
  }
  /**
   * 解析 dsh bin 路径（发布版不硬编码本机路径，§2.3）：
   * 1) 设置中保存的值；2) 环境变量 DSH_BIN；3) PATH 中的 `dsh` 命令；
   * 4) 常见安装位置（含 D:/deepseek-harness 开发目录）；5) 空 → 由 ProcessManager 报错提示。
   */
  resolveDshBinPath() {
    if (this.settings.dshBinPath) {
      return this.settings.dshBinPath;
    }
    const candidates = [
      process.env.DSH_BIN,
      "dsh",
      "D:/deepseek-harness/apps/cli/lib/bin.js"
    ].filter((p) => !!p);
    for (const c of candidates) {
      if (c === "dsh") {
        try {
          (0, import_child_process2.execSync)("dsh --version", { stdio: "ignore", timeout: 3e3 });
          return c;
        } catch {
          continue;
        }
      }
      try {
        if ((0, import_fs.existsSync)(c)) {
          return c;
        }
      } catch {
      }
    }
    return "";
  }
  /**
   * 解析 opencode bin 路径（§2.3，发布版不硬编码本机用户名）：
   * 1) 设置值 opencodeBinPath；2) 环境变量 OPENCODE_BIN；3) PATH 中的 `opencode` 命令名；
   * 4) 常见安装：os.homedir()/AppData/Roaming/npm/node_modules/opencode-ai/bin/opencode.exe；
   * 5) 空 → 由 ProcessManager 报错提示。
   */
  resolveOpencodeBinPath() {
    if (this.settings.opencodeBinPath) {
      return this.settings.opencodeBinPath;
    }
    const commonExe = path2.join(
      os.homedir(),
      "AppData",
      "Roaming",
      "npm",
      "node_modules",
      "opencode-ai",
      "bin",
      "opencode.exe"
    );
    const candidates = [process.env.OPENCODE_BIN, commonExe, "opencode"].filter((p) => !!p);
    for (const c of candidates) {
      if (c === "opencode") {
        try {
          (0, import_child_process2.execSync)("opencode --version", { stdio: "ignore", timeout: 3e3 });
          return c;
        } catch {
          continue;
        }
      }
      try {
        if ((0, import_fs.existsSync)(c)) {
          return c;
        }
      } catch {
      }
    }
    return "";
  }
  // ---------- 视图 ----------
  getView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_DSH);
    return leaves.length > 0 ? leaves[0].view : null;
  }
  /** 开关视图：已打开则关闭，未打开则打开（状态栏点击语义） */
  toggleView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_DSH);
    if (existing.length > 0) {
      existing[0].detach();
      return;
    }
    this.openView();
  }
  /** 打开 AI Engine 视图（右侧 pane，§2.1） */
  async openView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_DSH);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_DSH, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
  // ---------- 供视图查询的引擎信息 ----------
  getEngine() {
    return this.settings.engine;
  }
  getEngineName() {
    return ENGINE_NAME[this.settings.engine];
  }
  getEngineShort() {
    return ENGINE_SHORT[this.settings.engine];
  }
  /** 当前引擎端口 */
  getEnginePort() {
    return this.settings.engine === "opencode" ? this.settings.opencodePort : this.settings.port;
  }
  // ---------- 状态栏 ----------
  updateStatusBar() {
    const el = this.statusBarEl;
    if (!el)
      return;
    const manager = this.manager;
    if (!manager) {
      el.setText("AI: \u25CB \u672A\u542F\u52A8");
      el.title = "\u81EA\u52A8\u6258\u7BA1\u5DF2\u5173\u95ED\uFF0C\u70B9\u51FB\u6253\u5F00 AI Engine \u89C6\u56FE";
      return;
    }
    const short = this.getEngineShort();
    const st = manager.getState();
    const port = manager.getPort();
    switch (st) {
      case "running":
        el.setText(`AI \u25CF ${short} :${port}`);
        el.title = manager.isExternal() ? "\u590D\u7528\u5DF2\u6709\u5B9E\u4F8B\uFF08\u975E\u63D2\u4EF6\u6258\u7BA1\uFF0C\u4E0D\u4F1A kill\uFF09" : `${this.getEngineName()} \u8FD0\u884C\u4E2D`;
        break;
      case "starting":
        el.setText(`AI \u25D0 ${short} :${port}`);
        el.title = `\u6B63\u5728\u542F\u52A8 ${this.getEngineName()}\u2026`;
        break;
      case "error":
        el.setText(`AI \u2717 ${short}`);
        el.title = manager.getErrorReason() ?? `${this.getEngineName()} \u542F\u52A8\u5931\u8D25`;
        break;
      default:
        el.setText(`AI \u25CB ${short}`);
        el.title = "\u70B9\u51FB\u6253\u5F00 AI Engine \u89C6\u56FE";
    }
  }
};
