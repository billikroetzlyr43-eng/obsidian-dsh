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
var path2 = __toESM(require("path"));

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
    this.cfg = cfg;
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
  /** spawn 子进程并进入 starting 态，随后开始健康检查循环 */
  async startChild() {
    const { nodePath, dshBinPath, port } = this.cfg;
    if (!dshBinPath) {
      this.setState(
        "error",
        "\u672A\u914D\u7F6E dsh \u53EF\u6267\u884C\u8DEF\u5F84\uFF1A\u8BF7\u5728\u63D2\u4EF6\u8BBE\u7F6E\u4E2D\u586B\u5199 dsh \u7684 bin.js \u8DEF\u5F84\uFF0C\u6216\u8BBE\u7F6E\u73AF\u5883\u53D8\u91CF DSH_BIN\u3002"
      );
      return;
    }
    const dshCwd = deriveDshCwd(dshBinPath);
    if (!fs.existsSync(dshCwd)) {
      this.setState("error", `dsh \u9879\u76EE\u6839\u76EE\u5F55\u4E0D\u5B58\u5728\uFF1A${dshCwd}\uFF0C\u8BF7\u68C0\u67E5\u201Cdsh \u53EF\u6267\u884C\u8DEF\u5F84\u201D\u8BBE\u7F6E\u3002`);
      return;
    }
    this.openLog();
    this.log(`spawn\uFF1A${nodePath} ${dshBinPath} web --port ${port}\uFF08cwd=${dshCwd}\uFF09`);
    this.setState("starting");
    let child;
    try {
      child = (0, import_child_process.spawn)(nodePath, [dshBinPath, "web", "--port", String(port)], {
        cwd: dshCwd,
        detached: false,
        windowsHide: true
      });
    } catch (err) {
      this.setState("error", `\u542F\u52A8 dsh \u8FDB\u7A0B\u5931\u8D25\uFF1A${err?.message ?? String(err)}`);
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
      this.setState("error", `\u542F\u52A8 dsh \u8FDB\u7A0B\u5931\u8D25\uFF1A${err.message}`);
    });
    child.on("exit", (code, signal) => {
      this.log(`\u5B50\u8FDB\u7A0B\u9000\u51FA code=${code} signal=${signal}`);
      this.child = null;
      this.stopHealthCheck();
      if (this.state === "starting" || this.state === "running") {
        this.setState("error", `dsh web \u8FDB\u7A0B\u9000\u51FA\uFF08code=${code ?? "\u65E0"}\uFF09\uFF0C\u8BF7\u67E5\u770B\u65E5\u5FD7\uFF1A${this.cfg.logFile}`);
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
          `dsh \u542F\u52A8\u540E ${HEALTH_PROBE_MAX_MS / 1e3} \u79D2\u5185\u5065\u5EB7\u68C0\u67E5\u672A\u901A\u8FC7\uFF0C\u8BF7\u67E5\u770B\u65E5\u5FD7\uFF1A${this.cfg.logFile}`
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
var DshView = class extends import_obsidian.ItemView {
  plugin;
  iframeEl = null;
  loadingEl = null;
  errorEl = null;
  errorDetailEl = null;
  errorMetaEl = null;
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType() {
    return VIEW_TYPE_DSH;
  }
  getDisplayText() {
    return "DSH";
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
    this.contentEl.empty();
  }
  /** 重建 DOM：loading + iframe + 错误面板（全尺寸填充） */
  buildDom() {
    this.contentEl.empty();
    const container = this.contentEl.createDiv({ cls: "dsh-view-container" });
    this.loadingEl = container.createDiv({ cls: "dsh-view-loading", text: "\u6B63\u5728\u8FDE\u63A5 dsh\u2026" });
    this.iframeEl = container.createEl("iframe", { cls: "dsh-view-iframe" });
    this.iframeEl.setAttribute("allow", "clipboard-write; clipboard-read");
    this.iframeEl.addEventListener("load", () => this.onIframeLoaded());
    this.iframeEl.addEventListener("error", () => this.onIframeError());
    this.errorEl = container.createDiv({ cls: "dsh-view-error" });
    this.errorEl.style.display = "none";
    this.errorEl.createDiv({ cls: "dsh-view-error-title", text: "\u65E0\u6CD5\u8FDE\u63A5 dsh" });
    this.errorDetailEl = this.errorEl.createDiv({ cls: "dsh-view-error-detail" });
    this.errorMetaEl = this.errorEl.createDiv({ cls: "dsh-view-error-meta" });
    const retryBtn = this.errorEl.createEl("button", { cls: "mod-cta", text: "\u91CD\u8BD5" });
    retryBtn.addEventListener("click", () => this.refresh());
  }
  /**
   * 刷新视图连接：确保进程（自动托管时）→ 健康检查 → 加载 iframe / 显示错误面板。
   * 重试按钮也调用本方法。
   */
  async refresh() {
    const port = this.plugin.settings.port;
    this.showLoading();
    if (this.plugin.settings.autoManageProcess) {
      const manager = this.plugin.getManager();
      if (!manager) {
        this.showError("\u8FDB\u7A0B\u6258\u7BA1\u672A\u521D\u59CB\u5316", "\u81EA\u52A8\u6258\u7BA1\u5DF2\u5F00\u542F\u4F46\u6258\u7BA1\u5668\u672A\u521D\u59CB\u5316\uFF0C\u8BF7\u5230\u8BBE\u7F6E\u91CC\u5207\u6362\u540E\u91CD\u8BD5\u3002");
        return;
      }
      await manager.ensureRunning();
      const st = manager.getState();
      if (st === "error") {
        this.showError("dsh \u542F\u52A8\u5931\u8D25", manager.getErrorReason() ?? "\u672A\u77E5\u9519\u8BEF");
        return;
      }
      if (st !== "running") {
        this.showError("dsh \u672A\u5C31\u7EEA", `\u5F53\u524D\u72B6\u6001\uFF1A${st}\uFF0C\u8BF7\u7A0D\u540E\u70B9\u51FB\u91CD\u8BD5\u3002`);
        return;
      }
    }
    const health = await probePort(port);
    const action = decidePortAction(health);
    if (action.action === "reuse") {
      this.loadIframe(port);
    } else if (action.action === "error") {
      this.showError("\u7AEF\u53E3\u88AB\u5176\u4ED6\u7A0B\u5E8F\u5360\u7528", `${action.reason}
\u8BF7\u5230\u63D2\u4EF6\u8BBE\u7F6E\u4E2D\u66F4\u6362\u7AEF\u53E3\u3002`);
    } else {
      this.showError(
        "\u65E0\u6CD5\u8FDE\u63A5 dsh",
        "dsh web \u672A\u5728\u8FD0\u884C\u3002\u82E5\u5DF2\u5173\u95ED\u201C\u81EA\u52A8\u6258\u7BA1\u8FDB\u7A0B\u201D\uFF0C\u8BF7\u624B\u52A8\u8FD0\u884C\uFF1A\nnode <dshBin> web --port <\u7AEF\u53E3>"
      );
    }
  }
  // ---------- 展示状态 ----------
  showLoading() {
    if (this.loadingEl)
      this.loadingEl.style.display = "";
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
      this.errorMetaEl.textContent = `\u7AEF\u53E3\uFF1A${this.plugin.settings.port} \uFF5C \u65E5\u5FD7\uFF1A${this.plugin.resolveLogPath()}`;
    }
  }
  // ---------- iframe 加载 ----------
  /** 健康检查通过后加载/重载 iframe */
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
\u8BF7\u786E\u8BA4 dsh \u670D\u52A1\u53EF\u8BBF\u95EE\uFF0C\u6216\u70B9\u51FB\u91CD\u8BD5\u3002`
    );
  }
};

// src/settings.ts
var import_obsidian2 = require("obsidian");
var DEFAULT_SETTINGS = {
  port: 3080,
  autoManageProcess: true,
  dshBinPath: "",
  // 留空 → 启动时自动探测（见 main.ts resolveDshBinPath）
  nodePath: "node",
  logFilePath: ""
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
    new import_obsidian2.Setting(containerEl).setName("\u7AEF\u53E3").setDesc(`dsh web \u76D1\u542C\u7AEF\u53E3\uFF08\u8303\u56F4 ${PORT_MIN}-${PORT_MAX}\uFF0C\u9ED8\u8BA4 3080\uFF09\u3002\u82E5\u8BE5\u7AEF\u53E3\u5DF2\u6709\u5B9E\u4F8B\u5728\u8FD0\u884C\uFF08\u5982\u7528\u6237\u624B\u52A8\u542F\u52A8\u7684 dsh\uFF09\uFF0C\u63D2\u4EF6\u4F1A\u76F4\u63A5\u590D\u7528\uFF0C\u4E0D\u91CD\u590D\u542F\u52A8\u3002`).addText(
      (text) => text.setPlaceholder("3080").setValue(String(this.plugin.settings.port)).onChange((value) => {
        this.plugin.settings.port = clampPort(Number(value));
        this.debounceApply();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("\u81EA\u52A8\u6258\u7BA1\u8FDB\u7A0B").setDesc("\u5F00\u542F\u540E\u63D2\u4EF6\u81EA\u52A8 spawn / \u590D\u7528 dsh web \u5B50\u8FDB\u7A0B\uFF08\u9ED8\u8BA4\u5F00\u542F\uFF09\uFF1B\u5173\u95ED\u540E\u9700\u8981\u624B\u52A8\u8FD0\u884C dsh web\u3002").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.autoManageProcess).onChange(async (value) => {
        this.plugin.settings.autoManageProcess = value;
        await this.plugin.saveSettings();
        this.plugin.applySettings();
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
    new import_obsidian2.Setting(containerEl).setName("\u8FDB\u7A0B\u65E5\u5FD7\u4F4D\u7F6E").setDesc("dsh web \u5B50\u8FDB\u7A0B stdout/stderr \u7684\u65E5\u5FD7\u6587\u4EF6\u8DEF\u5F84\uFF08\u8FFD\u52A0\u5199\u5165\uFF0C\u5E26\u65F6\u95F4\u6233\uFF09").addText(
      (text) => text.setPlaceholder(".obsidian/plugins/obsidian-dsh/dsh-web.log").setValue(this.plugin.settings.logFilePath).onChange((value) => {
        this.plugin.settings.logFilePath = value.trim();
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
var DshPlugin = class extends import_obsidian3.Plugin {
  // 覆盖 obsidian Plugin 基类新增的 settings?: unknown，按官方文档模式声明具体类型并给初始化器
  settings = DEFAULT_SETTINGS;
  manager = null;
  statusBarEl = null;
  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE_DSH, (leaf) => new DshView(leaf, this));
    this.addRibbonIcon("bot", "\u6253\u5F00 DSH", () => this.toggleView());
    this.addCommand({ id: "open-dsh", name: "\u6253\u5F00 DSH", callback: () => this.toggleView() });
    this.addSettingTab(new DshSettingTab(this.app, this));
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("dsh-status-bar");
    this.statusBarEl.addEventListener("click", () => this.toggleView());
    this.statusBarEl.title = "\u70B9\u51FB\u6253\u5F00/\u5173\u95ED DSH \u89C6\u56FE";
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
    if (!this.settings.logFilePath) {
      this.settings.logFilePath = this.defaultLogPath();
    }
  }
  /** 保存设置到 data.json */
  async saveSettings() {
    await this.saveData(this.settings);
  }
  /** 默认日志路径：<vault>/.obsidian/plugins/obsidian-dsh/dsh-web.log */
  defaultLogPath() {
    const adapter = this.app.vault.adapter;
    const base = adapter instanceof import_obsidian3.FileSystemAdapter ? adapter.getBasePath() : "";
    return path2.join(base, ".obsidian", "plugins", "obsidian-dsh", "dsh-web.log");
  }
  /** 解析日志路径（设置为空时用默认值） */
  resolveLogPath() {
    return this.settings.logFilePath || this.defaultLogPath();
  }
  /** 设置保存后调用：同步进程托管配置、状态栏与视图 */
  async applySettings() {
    if (this.settings.autoManageProcess) {
      if (!this.manager) {
        this.initManager();
      } else {
        await this.manager.updateConfig({
          nodePath: this.settings.nodePath,
          dshBinPath: this.settings.dshBinPath,
          port: this.settings.port,
          logFile: this.resolveLogPath()
        });
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
  // ---------- 进程托管 ----------
  getManager() {
    return this.manager;
  }
  initManager() {
    const config = {
      nodePath: this.settings.nodePath,
      dshBinPath: this.resolveDshBinPath(),
      port: this.settings.port,
      logFile: this.resolveLogPath()
    };
    this.manager = new DshProcessManager(config);
    this.manager.onStatusChanged(() => this.updateStatusBar());
  }
  /**
   * 解析 dsh bin 路径（发布版不硬编码本机路径）：
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
        return c;
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
  /** 打开 DSH 视图（右侧 pane，§2.1） */
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
  // ---------- 状态栏 ----------
  updateStatusBar() {
    const el = this.statusBarEl;
    if (!el)
      return;
    const manager = this.manager;
    if (!manager) {
      el.setText("DSH: \u25CB \u672A\u542F\u52A8");
      el.title = "\u81EA\u52A8\u6258\u7BA1\u5DF2\u5173\u95ED\uFF0C\u70B9\u51FB\u6253\u5F00 DSH \u89C6\u56FE";
      return;
    }
    const st = manager.getState();
    const port = manager.getPort();
    switch (st) {
      case "running":
        el.setText(`DSH: \u25CF \u8FD0\u884C\u4E2D :${port}`);
        el.title = manager.isExternal() ? "\u590D\u7528\u5DF2\u6709\u5B9E\u4F8B\uFF08\u975E\u63D2\u4EF6\u6258\u7BA1\uFF0C\u4E0D\u4F1A kill\uFF09" : "dsh web \u8FD0\u884C\u4E2D";
        break;
      case "starting":
        el.setText(`DSH: \u25D0 \u542F\u52A8\u4E2D :${port}`);
        el.title = "\u6B63\u5728\u542F\u52A8 dsh web\u2026";
        break;
      case "error":
        el.setText("DSH: \u2717 \u9519\u8BEF");
        el.title = manager.getErrorReason() ?? "dsh \u542F\u52A8\u5931\u8D25";
        break;
      default:
        el.setText("DSH: \u25CB \u672A\u542F\u52A8");
        el.title = "\u70B9\u51FB\u6253\u5F00 DSH \u89C6\u56FE";
    }
  }
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsic3JjL21haW4udHMiLCAic3JjL2RzaC12aWV3LnRzIiwgInNyYy9wcm9jZXNzLW1hbmFnZXIudHMiLCAic3JjL3NldHRpbmdzLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIG9ic2lkaWFuLWRzaCBcdTYzRDJcdTRFRjZcdTUxNjVcdTUzRTNcdUZGMDhcdTAwQTcyIFx1NTI5Rlx1ODBGRFx1OTcwMFx1NkM0Mlx1RkYwOVx1RkYxQVxuICogIC0gcmliYm9uIFx1NTZGRVx1NjgwNyArIFx1NTQ3RFx1NEVFNFx1MjAxQ1x1NjI1M1x1NUYwMCBEU0hcdTIwMURcdTIxOTIgXHU2MjUzXHU1RjAwIEl0ZW1WaWV3XHVGRjA4XHU1M0YzXHU0RkE3IHBhbmVcdUZGMDlcbiAqICAtIFx1ODFFQVx1NTJBOFx1NjI1OFx1N0JBMSBkc2ggd2ViIFx1NUI1MFx1OEZEQlx1N0EwQlx1RkYwOFx1OTE0RFx1N0Y2RVx1NTNFRlx1NUYwMFx1NTE3M1x1RkYwQ1x1OUVEOFx1OEJBNFx1NUYwMFx1RkYwOVx1RkYxQVx1ODlDNlx1NTZGRVx1OTcwMFx1ODk4MVx1NEUxNFx1OEZEQlx1N0EwQlx1NEUwRFx1NTcyOCBcdTIxOTIgXHU4MUVBXHU1MkE4IHNwYXduXHVGRjFCXHU2M0QyXHU0RUY2XHU1Mzc4XHU4RjdEXHU2NUY2XHU1M0VBIGtpbGwgXHU4MUVBXHU1REYxIHNwYXduIFx1NzY4NFxuICogIC0gXHU3MkI2XHU2MDAxXHU2ODBGXHU2NjNFXHU3OTNBIGRzaCBcdTcyQjZcdTYwMDFcdUZGMENcdTcwQjlcdTUxRkJcdTUzRUZcdTVGMDBcdTUxNzNcdTg5QzZcdTU2RkVcbiAqICAtIFx1OEJCRVx1N0Y2RVx1OTg3NVx1RkYwOFx1N0FFRlx1NTNFMyAvIFx1ODFFQVx1NTJBOFx1NjI1OFx1N0JBMSAvIGRzaCBcdThERUZcdTVGODQgLyBub2RlIFx1OERFRlx1NUY4NCAvIFx1NjVFNVx1NUZEN1x1NEY0RFx1N0Y2RVx1RkYwOVxuICpcbiAqIFx1N0VBRiBPYnNpZGlhbiBBUEkgKyBcdTUzOUZcdTc1MUYgRE9NXHVGRjBDXHU2NUUwIFVJIFx1Njg0Nlx1NjdCNlx1MzAwMlxuICovXG5pbXBvcnQgeyBQbHVnaW4sIEZpbGVTeXN0ZW1BZGFwdGVyIH0gZnJvbSAnb2JzaWRpYW4nO1xuaW1wb3J0IHsgZXhpc3RzU3luYyB9IGZyb20gJ2ZzJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgeyBEc2hWaWV3LCBWSUVXX1RZUEVfRFNIIH0gZnJvbSAnLi9kc2gtdmlldyc7XG5pbXBvcnQgeyBERUZBVUxUX1NFVFRJTkdTLCBEc2hTZXR0aW5ncywgRHNoU2V0dGluZ1RhYiwgY2xhbXBQb3J0IH0gZnJvbSAnLi9zZXR0aW5ncyc7XG5pbXBvcnQgeyBEc2hQcm9jZXNzTWFuYWdlciwgdHlwZSBEc2hQcm9jZXNzQ29uZmlnIH0gZnJvbSAnLi9wcm9jZXNzLW1hbmFnZXInO1xuXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBEc2hQbHVnaW4gZXh0ZW5kcyBQbHVnaW4ge1xuXHQvLyBcdTg5ODZcdTc2RDYgb2JzaWRpYW4gUGx1Z2luIFx1NTdGQVx1N0M3Qlx1NjVCMFx1NTg5RVx1NzY4NCBzZXR0aW5ncz86IHVua25vd25cdUZGMENcdTYzMDlcdTVCOThcdTY1QjlcdTY1ODdcdTY4NjNcdTZBMjFcdTVGMEZcdTU4RjBcdTY2MEVcdTUxNzdcdTRGNTNcdTdDN0JcdTU3OEJcdTVFNzZcdTdFRDlcdTUyMURcdTU5Q0JcdTUzMTZcdTU2Njhcblx0c2V0dGluZ3M6IERzaFNldHRpbmdzID0gREVGQVVMVF9TRVRUSU5HUztcblx0cHJpdmF0ZSBtYW5hZ2VyOiBEc2hQcm9jZXNzTWFuYWdlciB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIHN0YXR1c0JhckVsOiBIVE1MRWxlbWVudCB8IG51bGwgPSBudWxsO1xuXG5cdGFzeW5jIG9ubG9hZCgpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRhd2FpdCB0aGlzLmxvYWRTZXR0aW5ncygpO1xuXG5cdFx0Ly8gSXRlbVZpZXcgXHU2Q0U4XHU1MThDXHVGRjA4XHUwMEE3Mi4xXHVGRjA5XG5cdFx0dGhpcy5yZWdpc3RlclZpZXcoVklFV19UWVBFX0RTSCwgKGxlYWYpID0+IG5ldyBEc2hWaWV3KGxlYWYsIHRoaXMpKTtcblxuXHRcdC8vIHJpYmJvbiBcdTU2RkVcdTY4MDcgKyBcdTU0N0RcdTRFRTRcdUZGMDhcdTAwQTcyLjFcdUZGMDlcblx0XHR0aGlzLmFkZFJpYmJvbkljb24oJ2JvdCcsICdcdTYyNTNcdTVGMDAgRFNIJywgKCkgPT4gdGhpcy50b2dnbGVWaWV3KCkpO1xuXHRcdHRoaXMuYWRkQ29tbWFuZCh7IGlkOiAnb3Blbi1kc2gnLCBuYW1lOiAnXHU2MjUzXHU1RjAwIERTSCcsIGNhbGxiYWNrOiAoKSA9PiB0aGlzLnRvZ2dsZVZpZXcoKSB9KTtcblxuXHRcdC8vIFx1OEJCRVx1N0Y2RVx1OTg3NVx1RkYwOFx1MDBBNzIuNVx1RkYwOVxuXHRcdHRoaXMuYWRkU2V0dGluZ1RhYihuZXcgRHNoU2V0dGluZ1RhYih0aGlzLmFwcCwgdGhpcykpO1xuXG5cdFx0Ly8gXHU3MkI2XHU2MDAxXHU2ODBGXHVGRjA4XHUwMEE3Mi40XHVGRjA5XHVGRjFBXHU2NjNFXHU3OTNBIGRzaCBcdTcyQjZcdTYwMDFcdUZGMENcdTcwQjlcdTUxRkJcdTVGMDBcdTUxNzNcdTg5QzZcdTU2RkVcblx0XHR0aGlzLnN0YXR1c0JhckVsID0gdGhpcy5hZGRTdGF0dXNCYXJJdGVtKCk7XG5cdFx0dGhpcy5zdGF0dXNCYXJFbC5hZGRDbGFzcygnZHNoLXN0YXR1cy1iYXInKTtcblx0XHR0aGlzLnN0YXR1c0JhckVsLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdGhpcy50b2dnbGVWaWV3KCkpO1xuXHRcdHRoaXMuc3RhdHVzQmFyRWwudGl0bGUgPSAnXHU3MEI5XHU1MUZCXHU2MjUzXHU1RjAwL1x1NTE3M1x1OTVFRCBEU0ggXHU4OUM2XHU1NkZFJztcblxuXHRcdC8vIFx1OEZEQlx1N0EwQlx1NjI1OFx1N0JBMVx1RkYwOFx1OUVEOFx1OEJBNFx1NUYwMFx1RkYwOVx1RkYxQVx1ODlDNlx1NTZGRVx1OTcwMFx1ODk4MVx1NjVGNlx1NjI0RCBzcGF3blx1RkYwQ1x1NTJBMFx1OEY3RFx1OTYzNlx1NkJCNVx1NTNFQVx1NTIxQlx1NUVGQVx1NjI1OFx1N0JBMVx1NTY2OFxuXHRcdGlmICh0aGlzLnNldHRpbmdzLmF1dG9NYW5hZ2VQcm9jZXNzKSB7XG5cdFx0XHR0aGlzLmluaXRNYW5hZ2VyKCk7XG5cdFx0fVxuXHRcdHRoaXMudXBkYXRlU3RhdHVzQmFyKCk7XG5cdH1cblxuXHRvbnVubG9hZCgpOiB2b2lkIHtcblx0XHQvLyBcdTUzRUEga2lsbCBcdTgxRUFcdTVERjEgc3Bhd24gXHU3Njg0XHU4RkRCXHU3QTBCXHVGRjBDXHU3RUREXHU0RTBEIGtpbGwgXHU3NTI4XHU2MjM3XHU2MjRCXHU1MkE4XHU1NDJGXHU1MkE4XHU3Njg0XHU1QjlFXHU0RjhCXHVGRjA4ZXh0ZXJuYWw9dHJ1ZSBcdTY1RjYgc3RvcCBcdTUxODVcdTkwRThcdTRGMUFcdThERjNcdThGQzdcdUZGMDlcblx0XHR0aGlzLm1hbmFnZXI/LmRpc3Bvc2UoKTtcblx0XHR0aGlzLm1hbmFnZXIgPSBudWxsO1xuXHR9XG5cblx0Ly8gLS0tLS0tLS0tLSBcdThCQkVcdTdGNkUgLS0tLS0tLS0tLVxuXG5cdGFzeW5jIGxvYWRTZXR0aW5ncygpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRjb25zdCBkYXRhID0gYXdhaXQgdGhpcy5sb2FkRGF0YSgpO1xuXHRcdHRoaXMuc2V0dGluZ3MgPSBPYmplY3QuYXNzaWduKHt9LCBERUZBVUxUX1NFVFRJTkdTLCBkYXRhID8/IHt9KTtcblx0XHR0aGlzLnNldHRpbmdzLnBvcnQgPSBjbGFtcFBvcnQodGhpcy5zZXR0aW5ncy5wb3J0KTtcblx0XHRpZiAoIXRoaXMuc2V0dGluZ3MubG9nRmlsZVBhdGgpIHtcblx0XHRcdHRoaXMuc2V0dGluZ3MubG9nRmlsZVBhdGggPSB0aGlzLmRlZmF1bHRMb2dQYXRoKCk7XG5cdFx0fVxuXHR9XG5cblx0LyoqIFx1NEZERFx1NUI1OFx1OEJCRVx1N0Y2RVx1NTIzMCBkYXRhLmpzb24gKi9cblx0YXN5bmMgc2F2ZVNldHRpbmdzKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGF3YWl0IHRoaXMuc2F2ZURhdGEodGhpcy5zZXR0aW5ncyk7XG5cdH1cblxuXHQvKiogXHU5RUQ4XHU4QkE0XHU2NUU1XHU1RkQ3XHU4REVGXHU1Rjg0XHVGRjFBPHZhdWx0Pi8ub2JzaWRpYW4vcGx1Z2lucy9vYnNpZGlhbi1kc2gvZHNoLXdlYi5sb2cgKi9cblx0ZGVmYXVsdExvZ1BhdGgoKTogc3RyaW5nIHtcblx0XHRjb25zdCBhZGFwdGVyID0gdGhpcy5hcHAudmF1bHQuYWRhcHRlcjtcblx0XHRjb25zdCBiYXNlID0gYWRhcHRlciBpbnN0YW5jZW9mIEZpbGVTeXN0ZW1BZGFwdGVyID8gYWRhcHRlci5nZXRCYXNlUGF0aCgpIDogJyc7XG5cdFx0cmV0dXJuIHBhdGguam9pbihiYXNlLCAnLm9ic2lkaWFuJywgJ3BsdWdpbnMnLCAnb2JzaWRpYW4tZHNoJywgJ2RzaC13ZWIubG9nJyk7XG5cdH1cblxuXHQvKiogXHU4OUUzXHU2NzkwXHU2NUU1XHU1RkQ3XHU4REVGXHU1Rjg0XHVGRjA4XHU4QkJFXHU3RjZFXHU0RTNBXHU3QTdBXHU2NUY2XHU3NTI4XHU5RUQ4XHU4QkE0XHU1MDNDXHVGRjA5ICovXG5cdHJlc29sdmVMb2dQYXRoKCk6IHN0cmluZyB7XG5cdFx0cmV0dXJuIHRoaXMuc2V0dGluZ3MubG9nRmlsZVBhdGggfHwgdGhpcy5kZWZhdWx0TG9nUGF0aCgpO1xuXHR9XG5cblx0LyoqIFx1OEJCRVx1N0Y2RVx1NEZERFx1NUI1OFx1NTQwRVx1OEMwM1x1NzUyOFx1RkYxQVx1NTQwQ1x1NkI2NVx1OEZEQlx1N0EwQlx1NjI1OFx1N0JBMVx1OTE0RFx1N0Y2RVx1MzAwMVx1NzJCNlx1NjAwMVx1NjgwRlx1NEUwRVx1ODlDNlx1NTZGRSAqL1xuXHRhc3luYyBhcHBseVNldHRpbmdzKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGlmICh0aGlzLnNldHRpbmdzLmF1dG9NYW5hZ2VQcm9jZXNzKSB7XG5cdFx0XHRpZiAoIXRoaXMubWFuYWdlcikge1xuXHRcdFx0XHR0aGlzLmluaXRNYW5hZ2VyKCk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRhd2FpdCB0aGlzLm1hbmFnZXIudXBkYXRlQ29uZmlnKHtcblx0XHRcdFx0XHRub2RlUGF0aDogdGhpcy5zZXR0aW5ncy5ub2RlUGF0aCxcblx0XHRcdFx0XHRkc2hCaW5QYXRoOiB0aGlzLnNldHRpbmdzLmRzaEJpblBhdGgsXG5cdFx0XHRcdFx0cG9ydDogdGhpcy5zZXR0aW5ncy5wb3J0LFxuXHRcdFx0XHRcdGxvZ0ZpbGU6IHRoaXMucmVzb2x2ZUxvZ1BhdGgoKSxcblx0XHRcdFx0fSk7XG5cdFx0XHR9XG5cdFx0fSBlbHNlIGlmICh0aGlzLm1hbmFnZXIpIHtcblx0XHRcdGF3YWl0IHRoaXMubWFuYWdlci5kaXNwb3NlKCk7XG5cdFx0XHR0aGlzLm1hbmFnZXIgPSBudWxsO1xuXHRcdH1cblx0XHR0aGlzLnVwZGF0ZVN0YXR1c0JhcigpO1xuXHRcdGNvbnN0IHZpZXcgPSB0aGlzLmdldFZpZXcoKTtcblx0XHRpZiAodmlldykge1xuXHRcdFx0YXdhaXQgdmlldy5yZWZyZXNoKCk7XG5cdFx0fVxuXHR9XG5cblx0Ly8gLS0tLS0tLS0tLSBcdThGREJcdTdBMEJcdTYyNThcdTdCQTEgLS0tLS0tLS0tLVxuXG5cdGdldE1hbmFnZXIoKTogRHNoUHJvY2Vzc01hbmFnZXIgfCBudWxsIHtcblx0XHRyZXR1cm4gdGhpcy5tYW5hZ2VyO1xuXHR9XG5cblx0cHJpdmF0ZSBpbml0TWFuYWdlcigpOiB2b2lkIHtcblx0XHRjb25zdCBjb25maWc6IERzaFByb2Nlc3NDb25maWcgPSB7XG5cdFx0XHRub2RlUGF0aDogdGhpcy5zZXR0aW5ncy5ub2RlUGF0aCxcblx0XHRcdGRzaEJpblBhdGg6IHRoaXMucmVzb2x2ZURzaEJpblBhdGgoKSxcblx0XHRcdHBvcnQ6IHRoaXMuc2V0dGluZ3MucG9ydCxcblx0XHRcdGxvZ0ZpbGU6IHRoaXMucmVzb2x2ZUxvZ1BhdGgoKSxcblx0XHR9O1xuXHRcdHRoaXMubWFuYWdlciA9IG5ldyBEc2hQcm9jZXNzTWFuYWdlcihjb25maWcpO1xuXHRcdHRoaXMubWFuYWdlci5vblN0YXR1c0NoYW5nZWQoKCkgPT4gdGhpcy51cGRhdGVTdGF0dXNCYXIoKSk7XG5cdH1cblxuXHQvKipcblx0ICogXHU4OUUzXHU2NzkwIGRzaCBiaW4gXHU4REVGXHU1Rjg0XHVGRjA4XHU1M0QxXHU1RTAzXHU3MjQ4XHU0RTBEXHU3ODZDXHU3RjE2XHU3ODAxXHU2NzJDXHU2NzNBXHU4REVGXHU1Rjg0XHVGRjA5XHVGRjFBXG5cdCAqIDEpIFx1OEJCRVx1N0Y2RVx1NEUyRFx1NEZERFx1NUI1OFx1NzY4NFx1NTAzQ1x1RkYxQjIpIFx1NzNBRlx1NTg4M1x1NTNEOFx1OTFDRiBEU0hfQklOXHVGRjFCMykgUEFUSCBcdTRFMkRcdTc2ODQgYGRzaGAgXHU1NDdEXHU0RUU0XHVGRjFCXG5cdCAqIDQpIFx1NUUzOFx1ODlDMVx1NUI4OVx1ODhDNVx1NEY0RFx1N0Y2RVx1RkYwOFx1NTQyQiBEOi9kZWVwc2Vlay1oYXJuZXNzIFx1NUYwMFx1NTNEMVx1NzZFRVx1NUY1NVx1RkYwOVx1RkYxQjUpIFx1N0E3QSBcdTIxOTIgXHU3NTMxIFByb2Nlc3NNYW5hZ2VyIFx1NjJBNVx1OTUxOVx1NjNEMFx1NzkzQVx1MzAwMlxuXHQgKi9cblx0cmVzb2x2ZURzaEJpblBhdGgoKTogc3RyaW5nIHtcblx0XHRpZiAodGhpcy5zZXR0aW5ncy5kc2hCaW5QYXRoKSB7XG5cdFx0XHRyZXR1cm4gdGhpcy5zZXR0aW5ncy5kc2hCaW5QYXRoO1xuXHRcdH1cblx0XHRjb25zdCBjYW5kaWRhdGVzID0gW1xuXHRcdFx0cHJvY2Vzcy5lbnYuRFNIX0JJTixcblx0XHRcdCdkc2gnLFxuXHRcdFx0J0Q6L2RlZXBzZWVrLWhhcm5lc3MvYXBwcy9jbGkvbGliL2Jpbi5qcycsXG5cdFx0XS5maWx0ZXIoKHApOiBwIGlzIHN0cmluZyA9PiAhIXApO1xuXHRcdGZvciAoY29uc3QgYyBvZiBjYW5kaWRhdGVzKSB7XG5cdFx0XHRpZiAoYyA9PT0gJ2RzaCcpIHtcblx0XHRcdFx0Ly8gXHU1NDdEXHU0RUU0XHU1NDBEXHVGRjFBXHU0RUE0XHU3RUQ5IHNwYXduIFx1NjMwOSBQQVRIIFx1ODlFM1x1Njc5MFx1RkYwQ1x1NjVFMFx1NkNENVx1OTg4NFx1NTE0OFx1OUE4Q1x1OEJDMVx1NUI1OFx1NTcyOFx1NjAyN1xuXHRcdFx0XHRyZXR1cm4gYztcblx0XHRcdH1cblx0XHRcdHRyeSB7XG5cdFx0XHRcdGlmIChleGlzdHNTeW5jKGMpKSB7XG5cdFx0XHRcdFx0cmV0dXJuIGM7XG5cdFx0XHRcdH1cblx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHQvLyBcdTVGRkRcdTc1NjVcdTRFMERcdTUzRUZcdTg5RTNcdTY3OTBcdThERUZcdTVGODRcdUZGMENcdTdFRTdcdTdFRURcdTYzQTJcdTZENEJcblx0XHRcdH1cblx0XHR9XG5cdFx0cmV0dXJuICcnO1xuXHR9XG5cblx0Ly8gLS0tLS0tLS0tLSBcdTg5QzZcdTU2RkUgLS0tLS0tLS0tLVxuXG5cdGdldFZpZXcoKTogRHNoVmlldyB8IG51bGwge1xuXHRcdGNvbnN0IGxlYXZlcyA9IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRMZWF2ZXNPZlR5cGUoVklFV19UWVBFX0RTSCk7XG5cdFx0cmV0dXJuIGxlYXZlcy5sZW5ndGggPiAwID8gKGxlYXZlc1swXS52aWV3IGFzIERzaFZpZXcpIDogbnVsbDtcblx0fVxuXG5cdC8qKiBcdTVGMDBcdTUxNzNcdTg5QzZcdTU2RkVcdUZGMUFcdTVERjJcdTYyNTNcdTVGMDBcdTUyMTlcdTUxNzNcdTk1RURcdUZGMENcdTY3MkFcdTYyNTNcdTVGMDBcdTUyMTlcdTYyNTNcdTVGMDBcdUZGMDhcdTcyQjZcdTYwMDFcdTY4MEZcdTcwQjlcdTUxRkJcdThCRURcdTRFNDlcdUZGMDkgKi9cblx0dG9nZ2xlVmlldygpOiB2b2lkIHtcblx0XHRjb25zdCBleGlzdGluZyA9IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRMZWF2ZXNPZlR5cGUoVklFV19UWVBFX0RTSCk7XG5cdFx0aWYgKGV4aXN0aW5nLmxlbmd0aCA+IDApIHtcblx0XHRcdGV4aXN0aW5nWzBdLmRldGFjaCgpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHR0aGlzLm9wZW5WaWV3KCk7XG5cdH1cblxuXHQvKiogXHU2MjUzXHU1RjAwIERTSCBcdTg5QzZcdTU2RkVcdUZGMDhcdTUzRjNcdTRGQTcgcGFuZVx1RkYwQ1x1MDBBNzIuMVx1RkYwOSAqL1xuXHRhc3luYyBvcGVuVmlldygpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRjb25zdCBleGlzdGluZyA9IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRMZWF2ZXNPZlR5cGUoVklFV19UWVBFX0RTSCk7XG5cdFx0aWYgKGV4aXN0aW5nLmxlbmd0aCA+IDApIHtcblx0XHRcdHRoaXMuYXBwLndvcmtzcGFjZS5yZXZlYWxMZWFmKGV4aXN0aW5nWzBdKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0Ly8gXHU1M0YzXHU0RkE3IHBhbmVcdUZGMUJcdTUzRjNcdTY4MEZcdTRFMERcdTUzRUZcdTc1MjhcdTY1RjZcdTkwMDBcdTU2REVcdTY2NkVcdTkwMUFcdTY4MDdcdTdCN0VcdTk4NzVcblx0XHRjb25zdCBsZWFmID0gdGhpcy5hcHAud29ya3NwYWNlLmdldFJpZ2h0TGVhZihmYWxzZSkgPz8gdGhpcy5hcHAud29ya3NwYWNlLmdldExlYWYoJ3RhYicpO1xuXHRcdGF3YWl0IGxlYWYuc2V0Vmlld1N0YXRlKHsgdHlwZTogVklFV19UWVBFX0RTSCwgYWN0aXZlOiB0cnVlIH0pO1xuXHRcdHRoaXMuYXBwLndvcmtzcGFjZS5yZXZlYWxMZWFmKGxlYWYpO1xuXHR9XG5cblx0Ly8gLS0tLS0tLS0tLSBcdTcyQjZcdTYwMDFcdTY4MEYgLS0tLS0tLS0tLVxuXG5cdHByaXZhdGUgdXBkYXRlU3RhdHVzQmFyKCk6IHZvaWQge1xuXHRcdGNvbnN0IGVsID0gdGhpcy5zdGF0dXNCYXJFbDtcblx0XHRpZiAoIWVsKSByZXR1cm47XG5cdFx0Y29uc3QgbWFuYWdlciA9IHRoaXMubWFuYWdlcjtcblx0XHRpZiAoIW1hbmFnZXIpIHtcblx0XHRcdGVsLnNldFRleHQoJ0RTSDogXHUyNUNCIFx1NjcyQVx1NTQyRlx1NTJBOCcpO1xuXHRcdFx0ZWwudGl0bGUgPSAnXHU4MUVBXHU1MkE4XHU2MjU4XHU3QkExXHU1REYyXHU1MTczXHU5NUVEXHVGRjBDXHU3MEI5XHU1MUZCXHU2MjUzXHU1RjAwIERTSCBcdTg5QzZcdTU2RkUnO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHRjb25zdCBzdCA9IG1hbmFnZXIuZ2V0U3RhdGUoKTtcblx0XHRjb25zdCBwb3J0ID0gbWFuYWdlci5nZXRQb3J0KCk7XG5cdFx0c3dpdGNoIChzdCkge1xuXHRcdFx0Y2FzZSAncnVubmluZyc6XG5cdFx0XHRcdGVsLnNldFRleHQoYERTSDogXHUyNUNGIFx1OEZEMFx1ODg0Q1x1NEUyRCA6JHtwb3J0fWApO1xuXHRcdFx0XHRlbC50aXRsZSA9IG1hbmFnZXIuaXNFeHRlcm5hbCgpID8gJ1x1NTkwRFx1NzUyOFx1NURGMlx1NjcwOVx1NUI5RVx1NEY4Qlx1RkYwOFx1OTc1RVx1NjNEMlx1NEVGNlx1NjI1OFx1N0JBMVx1RkYwQ1x1NEUwRFx1NEYxQSBraWxsXHVGRjA5JyA6ICdkc2ggd2ViIFx1OEZEMFx1ODg0Q1x1NEUyRCc7XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0Y2FzZSAnc3RhcnRpbmcnOlxuXHRcdFx0XHRlbC5zZXRUZXh0KGBEU0g6IFx1MjVEMCBcdTU0MkZcdTUyQThcdTRFMkQgOiR7cG9ydH1gKTtcblx0XHRcdFx0ZWwudGl0bGUgPSAnXHU2QjYzXHU1NzI4XHU1NDJGXHU1MkE4IGRzaCB3ZWJcdTIwMjYnO1xuXHRcdFx0XHRicmVhaztcblx0XHRcdGNhc2UgJ2Vycm9yJzpcblx0XHRcdFx0ZWwuc2V0VGV4dCgnRFNIOiBcdTI3MTcgXHU5NTE5XHU4QkVGJyk7XG5cdFx0XHRcdGVsLnRpdGxlID0gbWFuYWdlci5nZXRFcnJvclJlYXNvbigpID8/ICdkc2ggXHU1NDJGXHU1MkE4XHU1OTMxXHU4RDI1Jztcblx0XHRcdFx0YnJlYWs7XG5cdFx0XHRkZWZhdWx0OlxuXHRcdFx0XHRlbC5zZXRUZXh0KCdEU0g6IFx1MjVDQiBcdTY3MkFcdTU0MkZcdTUyQTgnKTtcblx0XHRcdFx0ZWwudGl0bGUgPSAnXHU3MEI5XHU1MUZCXHU2MjUzXHU1RjAwIERTSCBcdTg5QzZcdTU2RkUnO1xuXHRcdH1cblx0fVxufVxuIiwgIi8qKlxuICogRHNoVmlldyBcdTIwMTRcdTIwMTQgSXRlbVZpZXdcdUZGMUFpZnJhbWUgXHU1MTY4XHU1QzNBXHU1QkY4XHU1RDRDXHU1MTY1IGRzaCBXZWIgVUlcdUZGMDhcdTAwQTcyLjIgLyBcdTAwQTczLjNcdUZGMDlcdTMwMDJcbiAqICAtIGlmcmFtZSBcdTRFMERcdThCQkUgc2FuZGJveFx1RkYwOGRzaCBVSSBcdTk3MDBcdTg5ODFcdTVCOENcdTY1NzRcdTY3NDNcdTk2NTBcdUZGMDlcdUZGMENhbGxvdyBcdTUxNDFcdThCQjhcdTU5MERcdTUyMzZcdTdDOThcdThEMzRcbiAqICAtIFx1OEZERVx1NjNBNVx1NjAwMVx1RkYxQWlmcmFtZSBsb2FkIFx1MjE5MiBcdTk2OTBcdTg1Q0YgbG9hZGluZ1x1RkYxQmVycm9yIFx1NEU4Qlx1NEVGNlx1NjIxNlx1NTA2NVx1NUVCN1x1NjhDMFx1NjdFNVx1NTkzMVx1OEQyNSBcdTIxOTIgXHU5NTE5XHU4QkVGXHU5NzYyXHU2NzdGXHVGRjA4XHU1MzlGXHU1NkUwICsgXHU5MUNEXHU4QkQ1ICsgXHU3QUVGXHU1M0UzL1x1NjVFNVx1NUZEN1x1NEZFMVx1NjA2Rlx1RkYwOVxuICogIC0gXHU5MUNEXHU4QkQ1XHVGRjFBXHU5MUNEXHU2NUIwXHU1MDY1XHU1RUI3XHU2OEMwXHU2N0U1IFx1MjE5MiBcdTkwMUFcdThGQzdcdTUyMTkgcmVsb2FkIGlmcmFtZVx1RkYxQlx1NjcyQVx1OTAxQVx1OEZDN1x1NTIxOVx1NjNEMFx1NzkzQVx1NUU3Nlx1OTY0NFx1NjVFNVx1NUZEN1x1OERFRlx1NUY4NFxuICovXG5pbXBvcnQgeyBJdGVtVmlldywgV29ya3NwYWNlTGVhZiB9IGZyb20gJ29ic2lkaWFuJztcbmltcG9ydCB0eXBlIERzaFBsdWdpbiBmcm9tICcuL21haW4nO1xuaW1wb3J0IHsgcHJvYmVQb3J0LCBkZWNpZGVQb3J0QWN0aW9uIH0gZnJvbSAnLi9wcm9jZXNzLW1hbmFnZXInO1xuXG5leHBvcnQgY29uc3QgVklFV19UWVBFX0RTSCA9ICdvYnNpZGlhbi1kc2gtdmlldyc7XG5cbmV4cG9ydCBjbGFzcyBEc2hWaWV3IGV4dGVuZHMgSXRlbVZpZXcge1xuXHRwcml2YXRlIHBsdWdpbjogRHNoUGx1Z2luO1xuXHRwcml2YXRlIGlmcmFtZUVsOiBIVE1MSUZyYW1lRWxlbWVudCB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIGxvYWRpbmdFbDogSFRNTEVsZW1lbnQgfCBudWxsID0gbnVsbDtcblx0cHJpdmF0ZSBlcnJvckVsOiBIVE1MRWxlbWVudCB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIGVycm9yRGV0YWlsRWw6IEhUTUxFbGVtZW50IHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgZXJyb3JNZXRhRWw6IEhUTUxFbGVtZW50IHwgbnVsbCA9IG51bGw7XG5cblx0Y29uc3RydWN0b3IobGVhZjogV29ya3NwYWNlTGVhZiwgcGx1Z2luOiBEc2hQbHVnaW4pIHtcblx0XHRzdXBlcihsZWFmKTtcblx0XHR0aGlzLnBsdWdpbiA9IHBsdWdpbjtcblx0fVxuXG5cdGdldFZpZXdUeXBlKCk6IHN0cmluZyB7XG5cdFx0cmV0dXJuIFZJRVdfVFlQRV9EU0g7XG5cdH1cblxuXHRnZXREaXNwbGF5VGV4dCgpOiBzdHJpbmcge1xuXHRcdHJldHVybiAnRFNIJztcblx0fVxuXG5cdGdldEljb24oKTogc3RyaW5nIHtcblx0XHRyZXR1cm4gJ2JvdCc7XG5cdH1cblxuXHRhc3luYyBvbk9wZW4oKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0Ly8gXHU1M0JCXHU2Mzg5IHZpZXctY29udGVudCBcdTlFRDhcdThCQTRcdTUxODVcdThGQjlcdThERERcdUZGMENcdTkwN0ZcdTUxNERcdTc2N0RcdThGQjlcdUZGMDhcdTkxNERcdTU0MDggc3R5bGVzLmNzc1x1RkYwOVxuXHRcdHRoaXMuY29udGVudEVsLmFkZENsYXNzKCdkc2gtdmlldy1jb250ZW50Jyk7XG5cdFx0dGhpcy5idWlsZERvbSgpO1xuXHRcdGF3YWl0IHRoaXMucmVmcmVzaCgpO1xuXHR9XG5cblx0YXN5bmMgb25DbG9zZSgpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHR0aGlzLmNvbnRlbnRFbC5lbXB0eSgpO1xuXHR9XG5cblx0LyoqIFx1OTFDRFx1NUVGQSBET01cdUZGMUFsb2FkaW5nICsgaWZyYW1lICsgXHU5NTE5XHU4QkVGXHU5NzYyXHU2NzdGXHVGRjA4XHU1MTY4XHU1QzNBXHU1QkY4XHU1ODZCXHU1MTQ1XHVGRjA5ICovXG5cdHByaXZhdGUgYnVpbGREb20oKTogdm9pZCB7XG5cdFx0dGhpcy5jb250ZW50RWwuZW1wdHkoKTtcblxuXHRcdGNvbnN0IGNvbnRhaW5lciA9IHRoaXMuY29udGVudEVsLmNyZWF0ZURpdih7IGNsczogJ2RzaC12aWV3LWNvbnRhaW5lcicgfSk7XG5cblx0XHR0aGlzLmxvYWRpbmdFbCA9IGNvbnRhaW5lci5jcmVhdGVEaXYoeyBjbHM6ICdkc2gtdmlldy1sb2FkaW5nJywgdGV4dDogJ1x1NkI2M1x1NTcyOFx1OEZERVx1NjNBNSBkc2hcdTIwMjYnIH0pO1xuXG5cdFx0dGhpcy5pZnJhbWVFbCA9IGNvbnRhaW5lci5jcmVhdGVFbCgnaWZyYW1lJywgeyBjbHM6ICdkc2gtdmlldy1pZnJhbWUnIH0pO1xuXHRcdC8vIHNhbmRib3ggXHU0RTBEXHU4QkJFXHVGRjA4ZHNoIFVJIFx1OTcwMFx1ODk4MVx1NUI4Q1x1NjU3NFx1Njc0M1x1OTY1MFx1RkYwOVx1RkYxQmFsbG93IFx1NjUzRVx1NUYwMFx1NTI2QVx1OEQzNFx1Njc3Rlx1OEJGQlx1NTE5OVxuXHRcdHRoaXMuaWZyYW1lRWwuc2V0QXR0cmlidXRlKCdhbGxvdycsICdjbGlwYm9hcmQtd3JpdGU7IGNsaXBib2FyZC1yZWFkJyk7XG5cdFx0dGhpcy5pZnJhbWVFbC5hZGRFdmVudExpc3RlbmVyKCdsb2FkJywgKCkgPT4gdGhpcy5vbklmcmFtZUxvYWRlZCgpKTtcblx0XHR0aGlzLmlmcmFtZUVsLmFkZEV2ZW50TGlzdGVuZXIoJ2Vycm9yJywgKCkgPT4gdGhpcy5vbklmcmFtZUVycm9yKCkpO1xuXG5cdFx0dGhpcy5lcnJvckVsID0gY29udGFpbmVyLmNyZWF0ZURpdih7IGNsczogJ2RzaC12aWV3LWVycm9yJyB9KTtcblx0XHR0aGlzLmVycm9yRWwuc3R5bGUuZGlzcGxheSA9ICdub25lJztcblx0XHR0aGlzLmVycm9yRWwuY3JlYXRlRGl2KHsgY2xzOiAnZHNoLXZpZXctZXJyb3ItdGl0bGUnLCB0ZXh0OiAnXHU2NUUwXHU2Q0Q1XHU4RkRFXHU2M0E1IGRzaCcgfSk7XG5cdFx0dGhpcy5lcnJvckRldGFpbEVsID0gdGhpcy5lcnJvckVsLmNyZWF0ZURpdih7IGNsczogJ2RzaC12aWV3LWVycm9yLWRldGFpbCcgfSk7XG5cdFx0dGhpcy5lcnJvck1ldGFFbCA9IHRoaXMuZXJyb3JFbC5jcmVhdGVEaXYoeyBjbHM6ICdkc2gtdmlldy1lcnJvci1tZXRhJyB9KTtcblx0XHRjb25zdCByZXRyeUJ0biA9IHRoaXMuZXJyb3JFbC5jcmVhdGVFbCgnYnV0dG9uJywgeyBjbHM6ICdtb2QtY3RhJywgdGV4dDogJ1x1OTFDRFx1OEJENScgfSk7XG5cdFx0cmV0cnlCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB0aGlzLnJlZnJlc2goKSk7XG5cdH1cblxuXHQvKipcblx0ICogXHU1MjM3XHU2NUIwXHU4OUM2XHU1NkZFXHU4RkRFXHU2M0E1XHVGRjFBXHU3ODZFXHU0RkREXHU4RkRCXHU3QTBCXHVGRjA4XHU4MUVBXHU1MkE4XHU2MjU4XHU3QkExXHU2NUY2XHVGRjA5XHUyMTkyIFx1NTA2NVx1NUVCN1x1NjhDMFx1NjdFNSBcdTIxOTIgXHU1MkEwXHU4RjdEIGlmcmFtZSAvIFx1NjYzRVx1NzkzQVx1OTUxOVx1OEJFRlx1OTc2Mlx1Njc3Rlx1MzAwMlxuXHQgKiBcdTkxQ0RcdThCRDVcdTYzMDlcdTk0QUVcdTRFNUZcdThDMDNcdTc1MjhcdTY3MkNcdTY1QjlcdTZDRDVcdTMwMDJcblx0ICovXG5cdGFzeW5jIHJlZnJlc2goKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0Y29uc3QgcG9ydCA9IHRoaXMucGx1Z2luLnNldHRpbmdzLnBvcnQ7XG5cdFx0dGhpcy5zaG93TG9hZGluZygpO1xuXG5cdFx0Ly8gXHU4MUVBXHU1MkE4XHU2MjU4XHU3QkExXHVGRjFBXHU1MTQ4XHU3ODZFXHU0RkREXHU4RkRCXHU3QTBCXHVGRjA4XHU5ODg0XHU2OEMwIFx1MjE5MiBcdTU5MERcdTc1Mjgvc3Bhd24vXHU2MkE1XHU5NTE5XHVGRjA5XG5cdFx0aWYgKHRoaXMucGx1Z2luLnNldHRpbmdzLmF1dG9NYW5hZ2VQcm9jZXNzKSB7XG5cdFx0XHRjb25zdCBtYW5hZ2VyID0gdGhpcy5wbHVnaW4uZ2V0TWFuYWdlcigpO1xuXHRcdFx0aWYgKCFtYW5hZ2VyKSB7XG5cdFx0XHRcdHRoaXMuc2hvd0Vycm9yKCdcdThGREJcdTdBMEJcdTYyNThcdTdCQTFcdTY3MkFcdTUyMURcdTU5Q0JcdTUzMTYnLCAnXHU4MUVBXHU1MkE4XHU2MjU4XHU3QkExXHU1REYyXHU1RjAwXHU1NDJGXHU0RjQ2XHU2MjU4XHU3QkExXHU1NjY4XHU2NzJBXHU1MjFEXHU1OUNCXHU1MzE2XHVGRjBDXHU4QkY3XHU1MjMwXHU4QkJFXHU3RjZFXHU5MUNDXHU1MjA3XHU2MzYyXHU1NDBFXHU5MUNEXHU4QkQ1XHUzMDAyJyk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblx0XHRcdGF3YWl0IG1hbmFnZXIuZW5zdXJlUnVubmluZygpO1xuXHRcdFx0Y29uc3Qgc3QgPSBtYW5hZ2VyLmdldFN0YXRlKCk7XG5cdFx0XHRpZiAoc3QgPT09ICdlcnJvcicpIHtcblx0XHRcdFx0dGhpcy5zaG93RXJyb3IoJ2RzaCBcdTU0MkZcdTUyQThcdTU5MzFcdThEMjUnLCBtYW5hZ2VyLmdldEVycm9yUmVhc29uKCkgPz8gJ1x1NjcyQVx1NzdFNVx1OTUxOVx1OEJFRicpO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cdFx0XHRpZiAoc3QgIT09ICdydW5uaW5nJykge1xuXHRcdFx0XHR0aGlzLnNob3dFcnJvcignZHNoIFx1NjcyQVx1NUMzMVx1N0VFQScsIGBcdTVGNTNcdTUyNERcdTcyQjZcdTYwMDFcdUZGMUEke3N0fVx1RkYwQ1x1OEJGN1x1N0EwRFx1NTQwRVx1NzBCOVx1NTFGQlx1OTFDRFx1OEJENVx1MzAwMmApO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Ly8gXHU1MDY1XHU1RUI3XHU2OEMwXHU2N0U1XHVGRjA4XHU1MTczXHU5NUVEXHU4MUVBXHU1MkE4XHU2MjU4XHU3QkExXHU2NUY2XHU0RTVGXHU1MDVBXHU0RTAwXHU2QjIxXHVGRjBDXHU3NTI4XHU0RThFXHU3RUQ5XHU1MUZBXHU2NjBFXHU3ODZFXHU5NTE5XHU4QkVGXHU0RkUxXHU2MDZGXHVGRjA5XG5cdFx0Y29uc3QgaGVhbHRoID0gYXdhaXQgcHJvYmVQb3J0KHBvcnQpO1xuXHRcdGNvbnN0IGFjdGlvbiA9IGRlY2lkZVBvcnRBY3Rpb24oaGVhbHRoKTtcblx0XHRpZiAoYWN0aW9uLmFjdGlvbiA9PT0gJ3JldXNlJykge1xuXHRcdFx0dGhpcy5sb2FkSWZyYW1lKHBvcnQpO1xuXHRcdH0gZWxzZSBpZiAoYWN0aW9uLmFjdGlvbiA9PT0gJ2Vycm9yJykge1xuXHRcdFx0dGhpcy5zaG93RXJyb3IoJ1x1N0FFRlx1NTNFM1x1ODhBQlx1NTE3Nlx1NEVENlx1N0EwQlx1NUU4Rlx1NTM2MFx1NzUyOCcsIGAke2FjdGlvbi5yZWFzb259XFxuXHU4QkY3XHU1MjMwXHU2M0QyXHU0RUY2XHU4QkJFXHU3RjZFXHU0RTJEXHU2NkY0XHU2MzYyXHU3QUVGXHU1M0UzXHUzMDAyYCk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdHRoaXMuc2hvd0Vycm9yKFxuXHRcdFx0XHQnXHU2NUUwXHU2Q0Q1XHU4RkRFXHU2M0E1IGRzaCcsXG5cdFx0XHRcdCdkc2ggd2ViIFx1NjcyQVx1NTcyOFx1OEZEMFx1ODg0Q1x1MzAwMlx1ODJFNVx1NURGMlx1NTE3M1x1OTVFRFx1MjAxQ1x1ODFFQVx1NTJBOFx1NjI1OFx1N0JBMVx1OEZEQlx1N0EwQlx1MjAxRFx1RkYwQ1x1OEJGN1x1NjI0Qlx1NTJBOFx1OEZEMFx1ODg0Q1x1RkYxQVxcbm5vZGUgPGRzaEJpbj4gd2ViIC0tcG9ydCA8XHU3QUVGXHU1M0UzPidcblx0XHRcdCk7XG5cdFx0fVxuXHR9XG5cblx0Ly8gLS0tLS0tLS0tLSBcdTVDNTVcdTc5M0FcdTcyQjZcdTYwMDEgLS0tLS0tLS0tLVxuXG5cdHByaXZhdGUgc2hvd0xvYWRpbmcoKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMubG9hZGluZ0VsKSB0aGlzLmxvYWRpbmdFbC5zdHlsZS5kaXNwbGF5ID0gJyc7XG5cdFx0aWYgKHRoaXMuaWZyYW1lRWwpIHRoaXMuaWZyYW1lRWwuc3R5bGUuZGlzcGxheSA9ICdub25lJztcblx0XHRpZiAodGhpcy5lcnJvckVsKSB0aGlzLmVycm9yRWwuc3R5bGUuZGlzcGxheSA9ICdub25lJztcblx0fVxuXG5cdHByaXZhdGUgc2hvd0lmcmFtZSgpOiB2b2lkIHtcblx0XHRpZiAodGhpcy5sb2FkaW5nRWwpIHRoaXMubG9hZGluZ0VsLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG5cdFx0aWYgKHRoaXMuaWZyYW1lRWwpIHRoaXMuaWZyYW1lRWwuc3R5bGUuZGlzcGxheSA9ICcnO1xuXHRcdGlmICh0aGlzLmVycm9yRWwpIHRoaXMuZXJyb3JFbC5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnO1xuXHR9XG5cblx0cHJpdmF0ZSBzaG93RXJyb3IodGl0bGU6IHN0cmluZywgZGV0YWlsOiBzdHJpbmcpOiB2b2lkIHtcblx0XHRpZiAodGhpcy5sb2FkaW5nRWwpIHRoaXMubG9hZGluZ0VsLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG5cdFx0aWYgKHRoaXMuaWZyYW1lRWwpIHRoaXMuaWZyYW1lRWwuc3R5bGUuZGlzcGxheSA9ICdub25lJztcblx0XHRpZiAodGhpcy5lcnJvckVsKSB0aGlzLmVycm9yRWwuc3R5bGUuZGlzcGxheSA9ICcnO1xuXHRcdGNvbnN0IHRpdGxlRWwgPSB0aGlzLmVycm9yRWw/LnF1ZXJ5U2VsZWN0b3IoJy5kc2gtdmlldy1lcnJvci10aXRsZScpO1xuXHRcdGlmICh0aXRsZUVsKSB0aXRsZUVsLnRleHRDb250ZW50ID0gdGl0bGU7XG5cdFx0aWYgKHRoaXMuZXJyb3JEZXRhaWxFbCkgdGhpcy5lcnJvckRldGFpbEVsLnRleHRDb250ZW50ID0gZGV0YWlsO1xuXHRcdGlmICh0aGlzLmVycm9yTWV0YUVsKSB7XG5cdFx0XHR0aGlzLmVycm9yTWV0YUVsLnRleHRDb250ZW50ID0gYFx1N0FFRlx1NTNFM1x1RkYxQSR7dGhpcy5wbHVnaW4uc2V0dGluZ3MucG9ydH0gXHVGRjVDIFx1NjVFNVx1NUZEN1x1RkYxQSR7dGhpcy5wbHVnaW4ucmVzb2x2ZUxvZ1BhdGgoKX1gO1xuXHRcdH1cblx0fVxuXG5cdC8vIC0tLS0tLS0tLS0gaWZyYW1lIFx1NTJBMFx1OEY3RCAtLS0tLS0tLS0tXG5cblx0LyoqIFx1NTA2NVx1NUVCN1x1NjhDMFx1NjdFNVx1OTAxQVx1OEZDN1x1NTQwRVx1NTJBMFx1OEY3RC9cdTkxQ0RcdThGN0QgaWZyYW1lICovXG5cdHByaXZhdGUgbG9hZElmcmFtZShwb3J0OiBudW1iZXIpOiB2b2lkIHtcblx0XHRpZiAoIXRoaXMuaWZyYW1lRWwpIHJldHVybjtcblx0XHRjb25zdCB1cmwgPSBgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2A7XG5cdFx0Ly8gXHU5MUNEXHU2NUIwXHU4RDRCXHU1MDNDIHNyYyBcdTRGMUFcdTg5RTZcdTUzRDEgcmVsb2FkXHVGRjA4XHU5MUNEXHU4QkQ1XHU1NzNBXHU2NjZGXHVGRjA5XG5cdFx0dGhpcy5pZnJhbWVFbC5zcmMgPSB1cmw7XG5cdH1cblxuXHRwcml2YXRlIG9uSWZyYW1lTG9hZGVkKCk6IHZvaWQge1xuXHRcdC8vIGRzaCBcdTk4NzVcdTk3NjJcdTUyQTBcdThGN0RcdTVCOENcdTYyMTAgXHUyMTkyIFx1OTY5MFx1ODVDRiBsb2FkaW5nXG5cdFx0dGhpcy5zaG93SWZyYW1lKCk7XG5cdH1cblxuXHRwcml2YXRlIG9uSWZyYW1lRXJyb3IoKTogdm9pZCB7XG5cdFx0dGhpcy5zaG93RXJyb3IoXG5cdFx0XHQnXHU5ODc1XHU5NzYyXHU1MkEwXHU4RjdEXHU1OTMxXHU4RDI1Jyxcblx0XHRcdGBcdTY1RTBcdTZDRDVcdTUyQTBcdThGN0QgJHt0aGlzLmlmcmFtZUVsPy5zcmMgPz8gJyd9XFxuXHU4QkY3XHU3ODZFXHU4QkE0IGRzaCBcdTY3MERcdTUyQTFcdTUzRUZcdThCQkZcdTk1RUVcdUZGMENcdTYyMTZcdTcwQjlcdTUxRkJcdTkxQ0RcdThCRDVcdTMwMDJgXG5cdFx0KTtcblx0fVxufVxuIiwgIi8qKlxuICogRHNoUHJvY2Vzc01hbmFnZXIgXHUyMDE0XHUyMDE0IGRzaCB3ZWIgXHU1QjUwXHU4RkRCXHU3QTBCXHU2MjU4XHU3QkExXHU1NjY4XHVGRjA4XHU2ODM4XHU1RkMzXHU2QTIxXHU1NzU3XHVGRjBDXHUwMEE3My4yXHVGRjA5XHUzMDAyXG4gKlxuICogXHU4MDRDXHU4RDIzXHVGRjFBXG4gKiAgLSBcdTdBRUZcdTUzRTNcdTk4ODRcdTY4QzBcdUZGMUFcdTU0MkZcdTUyQThcdTUyNERcdTUxNDhcdTYzQTJcdTZENEJcdTc2RUVcdTY4MDdcdTdBRUZcdTUzRTNcdUZGMENcdTYzMDlcdTdBRUZcdTUzRTNcdTdCNTZcdTc1NjVcdUZGMDhcdTAwQTc0XHVGRjA5XHU1MUIzXHU3QjU2XHVGRjFBXHU1OTBEXHU3NTI4XHU1OTE2XHU5MEU4XHU1QjlFXHU0RjhCIC8gXHU3QTdBXHU5NUYyXHU1MjE5IHNwYXduIC8gXHU4OEFCXHU1MzYwXHU3NTI4XHU1MjE5XHU2MkE1XHU5NTE5XG4gKiAgLSBcdTVCNTBcdThGREJcdTdBMEJcdTYyNThcdTdCQTFcdUZGMUFzcGF3biBgbm9kZSA8ZHNoQmluPiB3ZWIgLS1wb3J0IDxwb3J0PmBcdUZGMENjd2QgXHU1M0Q2IGRzaCBcdTk4NzlcdTc2RUVcdTY4MzlcdUZGMDhcdTc1MzEgZHNoQmluIFx1OERFRlx1NUY4NFx1NjNBOFx1NUJGQ1x1RkYwOVxuICogIC0gXHU1MDY1XHU1RUI3XHU2OEMwXHU2N0U1XHVGRjFBc3RhcnRpbmcgXHU2NzFGXHU5NUY0XHU2QkNGIDgwMG1zIFx1NjNBMlx1NkQ0QiBodHRwOi8vMTI3LjAuMC4xOjxwb3J0Pi9cdUZGMENcdTY3MDBcdTU5MUEgNjBzXG4gKiAgLSBcdTY1RTVcdTVGRDdcdUZGMUFcdTVCNTBcdThGREJcdTdBMEIgc3Rkb3V0L3N0ZGVyciBcdThGRkRcdTUyQTBcdTUxOTlcdTUxNjVcdTY1RTVcdTVGRDdcdTY1ODdcdTRFRjZcdUZGMDhhcHBlbmQgXHU2QTIxXHU1RjBGXHVGRjBDXHU1RTI2XHU2NUY2XHU5NUY0XHU2MjMzXHVGRjA5XG4gKiAgLSBraWxsXHVGRjFBXHU1M0VBIGtpbGwgXHU4MUVBXHU1REYxIHNwYXduIFx1NzY4NFx1OEZEQlx1N0EwQlx1RkYwOGV4dGVybmFsPWZhbHNlXHVGRjA5XHVGRjFCV2luZG93cyBcdTc1MjggdGFza2tpbGwgL1QgL0YgXHU1MTVDXHU1RTk1XHU2RTA1XHU2Mzg5XHU1QjU5XHU1QjUwXHU4RkRCXHU3QTBCXG4gKiAgLSBcdTRFOEJcdTRFRjZcdUZGMUEnc3RhdHVzLWNoYW5nZWQnIFx1NTZERVx1OEMwM1x1RkYwQ1x1OUE3MVx1NTJBOFx1NzJCNlx1NjAwMVx1NjgwRlx1NEUwRVx1ODlDNlx1NTZGRVx1NjZGNFx1NjVCMFxuICpcbiAqIFx1NzJCNlx1NjAwMVx1NjczQVx1RkYxQSdzdG9wcGVkJyB8ICdzdGFydGluZycgfCAncnVubmluZycgfCAnZXJyb3InXG4gKlxuICogXHU2Q0U4XHU2MTBGXHVGRjFBXHU2NzJDXHU2NTg3XHU0RUY2XHU1NDBDXHU2NUY2XHU4OEFCIE5vZGUgXHU1MzU1XHU2RDRCXHVGRjA4bm9kZSAtLXRlc3RcdUZGMDlcdTRFMEUgT2JzaWRpYW4gXHU4RkQwXHU4ODRDXHU2NUY2XHU1MkEwXHU4RjdEXHVGRjBDXG4gKiBcdTUzRUFcdTc1MjhcdTUzRUZcdTY0RTZcdTk2NjQgVHlwZVNjcmlwdCBcdThCRURcdTZDRDVcdUZGMDhcdTY1RTAgZW51bVx1MzAwMVx1NjVFMFx1Njc4NFx1OTAyMFx1NTY2OFx1NTNDMlx1NjU3MFx1NUM1RVx1NjAyN1x1RkYwOVx1RkYwQ1x1NEUxNFx1NEUwRFx1NEY5RFx1OEQ1Nlx1NkQ0Rlx1ODlDOFx1NTY2OCBmZXRjaFx1RkYwOFx1NzUyOCBOb2RlIGh0dHAgXHU2M0EyXHU2RDRCXHVGRjBDXHU2NUUwIENPUlMgXHU5NUVFXHU5ODk4XHVGRjA5XHUzMDAyXG4gKi9cbmltcG9ydCB7IHNwYXduLCB0eXBlIENoaWxkUHJvY2VzcyB9IGZyb20gJ2NoaWxkX3Byb2Nlc3MnO1xuaW1wb3J0ICogYXMgaHR0cCBmcm9tICdodHRwJztcbmltcG9ydCAqIGFzIGZzIGZyb20gJ2ZzJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5cbi8qKiBcdThGREJcdTdBMEJcdTcyQjZcdTYwMDFcdTY3M0EgKi9cbmV4cG9ydCB0eXBlIERzaFByb2Nlc3NTdGF0ZSA9ICdzdG9wcGVkJyB8ICdzdGFydGluZycgfCAncnVubmluZycgfCAnZXJyb3InO1xuXG4vKiogXHU3QUVGXHU1M0UzXHU1MDY1XHU1RUI3XHU2OEMwXHU2N0U1XHU3RUQzXHU2NzlDXHVGRjA4ZGVjaWRlUG9ydEFjdGlvbiBcdTc2ODRcdThGOTNcdTUxNjVcdUZGMENcdTAwQTczLjRcdUZGMDkgKi9cbmV4cG9ydCB0eXBlIFBvcnRIZWFsdGggPVxuXHR8IHsga2luZDogJ2h0dHAtcmVzcG9uc2UnOyBzdGF0dXM6IG51bWJlciB9ICAgICAgICAgICAgICAvLyBcdTdBRUZcdTUzRTNcdTRFMEFcdTY3MDkgSFRUUCBcdTY3MERcdTUyQTFcdTU3MjhcdTU0Q0RcdTVFOTRcblx0fCB7IGtpbmQ6ICduZXR3b3JrLWVycm9yJzsgY29kZTogc3RyaW5nOyBtZXNzYWdlPzogc3RyaW5nIH0gLy8gXHU3RjUxXHU3RURDXHU1QzQyXHU5NTE5XHU4QkVGXHVGRjA4RUNPTk5SRUZVU0VEIFx1N0I0OVx1RkYwOVxuXHR8IHsga2luZDogJ290aGVyLWVycm9yJzsgbWVzc2FnZTogc3RyaW5nIH07ICAgICAgICAgICAgICAvLyBcdTUxNzZcdTRFRDZcdTVGMDJcdTVFMzhcdUZGMDhcdThEODVcdTY1RjZcdTdCNDlcdUZGMDlcblxuLyoqIFx1N0FFRlx1NTNFM1x1NTFCM1x1N0I1Nlx1N0VEM1x1Njc5Q1x1RkYwOFx1MDBBNzQgXHU3QUVGXHU1M0UzXHU3QjU2XHU3NTY1XHVGRjA5ICovXG5leHBvcnQgdHlwZSBQb3J0QWN0aW9uID1cblx0fCB7IGFjdGlvbjogJ3JldXNlJzsgZXh0ZXJuYWw6IHRydWUgfSAgICAgICAgICAgICAgICAgICAgICAgIC8vIFx1NURGMlx1NjcwOVx1NUI5RVx1NEY4Qlx1NTcyOFx1OEREMSBcdTIxOTIgXHU3NkY0XHU2M0E1XHU1OTBEXHU3NTI4XHVGRjBDXHU0RTBEIHNwYXduXHUzMDAxXHU0RTBEIGtpbGxcblx0fCB7IGFjdGlvbjogJ3NwYXduJzsgZXh0ZXJuYWw6IGZhbHNlOyB3YXJuPzogc3RyaW5nIH0gICAgICAgIC8vIFx1N0E3QVx1OTVGMiBcdTIxOTIgc3Bhd24gXHU2NUIwXHU4RkRCXHU3QTBCXHVGRjA4d2FybiBcdTRFM0FcdTU0NEFcdThCNjZcdTRGRTFcdTYwNkZcdUZGMDlcblx0fCB7IGFjdGlvbjogJ2Vycm9yJzsgcmVhc29uOiBzdHJpbmcgfTsgICAgICAgICAgICAgICAgICAgICAgIC8vIFx1N0FFRlx1NTNFM1x1ODhBQlx1NTE3Nlx1NEVENlx1N0EwQlx1NUU4Rlx1NTM2MFx1NzUyOCBcdTIxOTIgXHU2MkE1XHU5NTE5XHU2M0QwXHU3OTNBXHU2MzYyXHU3QUVGXHU1M0UzXG5cbi8qKlxuICogXHU3QUVGXHU1M0UzXHU3QjU2XHU3NTY1XHU3RUFGXHU1MUZEXHU2NTcwXHVGRjA4XHUwMEE3My4yIFx1N0FFRlx1NTNFM1x1OTg4NFx1NjhDMCAvIFx1MDBBNzQgXHU2NjBFXHU3ODZFXHU4OUM0XHU1MjE5XHVGRjBDXHU5NjMyXHU1NDQ2XHVGRjA5XHVGRjFBXG4gKiAgLSBIVFRQIDJ4eCBcdTU0Q0RcdTVFOTQgXHUyMTkyIFx1NURGMlx1NjcwOVx1NUI5RVx1NEY4Qlx1RkYwOFx1NTNFRlx1ODBGRFx1NjYyRlx1NzUyOFx1NjIzN1x1NjI0Qlx1NTJBOFx1NTQyRlx1NTJBOFx1NzY4NCBkc2hcdUZGMDlcdTIxOTIgXHU1OTBEXHU3NTI4XHVGRjA4ZXh0ZXJuYWw9dHJ1ZVx1RkYwQ1x1NEUwRCBzcGF3blx1MzAwMVx1NEUwRCBraWxsXHVGRjA5XG4gKiAgLSBIVFRQIFx1OTc1RSAyeHggXHU1NENEXHU1RTk0XHVGRjA4XHU1OTgyIDQwMy80MDRcdUZGMDlcdTIxOTIgXHU3QUVGXHU1M0UzXHU4OEFCXHU1MTc2XHU0RUQ2XHU3QTBCXHU1RThGXHU1MzYwXHU3NTI4IFx1MjE5MiBcdTYyQTVcdTk1MTlcdTYzRDBcdTc5M0FcdTYzNjJcdTdBRUZcdTUzRTNcdUZGMENcdTRFMERcdTVGM0FcdTg4NEMgc3Bhd25cbiAqICAtIEVDT05OUkVGVVNFRCBcdTdCNDlcdTdGNTFcdTdFRENcdTk1MTlcdThCRUYgXHUyMTkyIFx1N0E3QVx1OTVGMiBcdTIxOTIgc3Bhd25cbiAqICAtIFx1NTE3Nlx1NEVENlx1NUYwMlx1NUUzOFx1RkYwOFx1OEQ4NVx1NjVGNlx1N0I0OVx1RkYwOVx1MjE5MiBcdTg5QzZcdTRFM0FcdTdBN0FcdTk1RjJcdTRGNDZcdTU0NEFcdThCNjZcdTY1RTVcdTVGRDcgXHUyMTkyIFx1NUMxRFx1OEJENSBzcGF3blxuICovXG5leHBvcnQgZnVuY3Rpb24gZGVjaWRlUG9ydEFjdGlvbihoZWFsdGg6IFBvcnRIZWFsdGgpOiBQb3J0QWN0aW9uIHtcblx0c3dpdGNoIChoZWFsdGgua2luZCkge1xuXHRcdGNhc2UgJ2h0dHAtcmVzcG9uc2UnOlxuXHRcdFx0aWYgKGhlYWx0aC5zdGF0dXMgPj0gMjAwICYmIGhlYWx0aC5zdGF0dXMgPCAzMDApIHtcblx0XHRcdFx0cmV0dXJuIHsgYWN0aW9uOiAncmV1c2UnLCBleHRlcm5hbDogdHJ1ZSB9O1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0YWN0aW9uOiAnZXJyb3InLFxuXHRcdFx0XHRyZWFzb246IGBcdTdBRUZcdTUzRTNcdTVERjJcdTY3MDkgSFRUUCBcdTY3MERcdTUyQTFcdTU3MjhcdTU0Q0RcdTVFOTRcdUZGMDhcdTcyQjZcdTYwMDFcdTc4MDEgJHtoZWFsdGguc3RhdHVzfVx1RkYwOVx1RkYwQ1x1NEY0Nlx1OTc1RVx1NkI2M1x1NUUzOCAyeHhcdUZGMENcdTc1OTFcdTRGM0NcdTg4QUJcdTUxNzZcdTRFRDZcdTdBMEJcdTVFOEZcdTUzNjBcdTc1MjhcdUZGMENcdThCRjdcdTY2RjRcdTYzNjJcdTdBRUZcdTUzRTNcdTMwMDJgLFxuXHRcdFx0fTtcblx0XHRjYXNlICduZXR3b3JrLWVycm9yJzpcblx0XHRcdGlmIChoZWFsdGguY29kZSA9PT0gJ0VDT05OUkVGVVNFRCcpIHtcblx0XHRcdFx0Ly8gXHU4RkRFXHU2M0E1XHU4OEFCXHU2MkQyIFx1MjE5MiBcdTdBN0FcdTk1RjIgXHUyMTkyIHNwYXduXG5cdFx0XHRcdHJldHVybiB7IGFjdGlvbjogJ3NwYXduJywgZXh0ZXJuYWw6IGZhbHNlIH07XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRhY3Rpb246ICdzcGF3bicsXG5cdFx0XHRcdGV4dGVybmFsOiBmYWxzZSxcblx0XHRcdFx0d2FybjogYFx1N0FFRlx1NTNFM1x1NjNBMlx1NkQ0Qlx1N0Y1MVx1N0VEQ1x1OTUxOVx1OEJFRlx1RkYwOCR7aGVhbHRoLmNvZGV9XHVGRjA5XHVGRjBDXHU2MzA5XHU3QTdBXHU5NUYyXHU1OTA0XHU3NDA2XHU1RTc2XHU1QzFEXHU4QkQ1XHU1NDJGXHU1MkE4XHUzMDAyYCxcblx0XHRcdH07XG5cdFx0Y2FzZSAnb3RoZXItZXJyb3InOlxuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0YWN0aW9uOiAnc3Bhd24nLFxuXHRcdFx0XHRleHRlcm5hbDogZmFsc2UsXG5cdFx0XHRcdHdhcm46IGBcdTdBRUZcdTUzRTNcdTYzQTJcdTZENEJcdTVGMDJcdTVFMzhcdUZGMDgke2hlYWx0aC5tZXNzYWdlfVx1RkYwOVx1RkYwQ1x1NjMwOVx1N0E3QVx1OTVGMlx1NTkwNFx1NzQwNlx1NUU3Nlx1NUMxRFx1OEJENVx1NTQyRlx1NTJBOFx1MzAwMmAsXG5cdFx0XHR9O1xuXHR9XG59XG5cbi8qKlxuICogXHU3NTMxIGRzaEJpbiBcdThERUZcdTVGODRcdTYzQThcdTVCRkMgZHNoIFx1OTg3OVx1NzZFRVx1NjgzOVx1RkYwOFx1NUI1MFx1OEZEQlx1N0EwQiBjd2RcdUZGMDlcdTMwMDJcbiAqIGJpbi5qcyBcdTU2RkFcdTVCOUFcdTRGNERcdTRFOEUgPFx1OTg3OVx1NzZFRVx1NjgzOT4vYXBwcy9jbGkvbGliL2Jpbi5qc1x1RkYwQ1x1NEVDRVx1NTE3Nlx1NjI0MFx1NTcyOFx1NzZFRVx1NUY1NVx1NEUwQVx1NkVBRiAzIFx1N0VBN1x1NTM3M1x1NEUzQVx1OTg3OVx1NzZFRVx1NjgzOVx1MzAwMlxuICogXHU0RjhCXHVGRjFBRDovZGVlcHNlZWstaGFybmVzcy9hcHBzL2NsaS9saWIvYmluLmpzIFx1MjE5MiBEOlxcZGVlcHNlZWstaGFybmVzc1xuICovXG5leHBvcnQgZnVuY3Rpb24gZGVyaXZlRHNoQ3dkKGRzaEJpbjogc3RyaW5nKTogc3RyaW5nIHtcblx0cmV0dXJuIHBhdGgucmVzb2x2ZShwYXRoLmRpcm5hbWUoZHNoQmluKSwgJy4uJywgJy4uJywgJy4uJyk7XG59XG5cbi8qKlxuICogXHU2M0EyXHU2RDRCIGh0dHA6Ly8xMjcuMC4wLjE6PHBvcnQ+L1x1RkYwQ1x1OEZENFx1NTZERVx1N0VEM1x1Njc4NFx1NTMxNiBQb3J0SGVhbHRoXHUzMDAyXG4gKiBcdTc1MjggTm9kZSBodHRwXHVGRjA4XHU4MDBDXHU5NzVFIGZldGNoXHVGRjA5XHVGRjFBT2JzaWRpYW4gXHU2RTMyXHU2N0QzXHU4RkRCXHU3QTBCXHU5MUNDIGZldGNoIFx1NjcwOSBDT1JTIFx1OTY1MFx1NTIzNlx1RkYwQ2h0dHAgXHU2QTIxXHU1NzU3XHU2NUUwXHU2QjY0XHU5NUVFXHU5ODk4XHVGRjBDXHU0RTE0XHU1MzU1XHU2RDRCXHU1NzI4XHU3RUFGIE5vZGUgXHU0RTBCXHU1NDBDXHU2ODM3XHU1M0VGXHU3NTI4XHUzMDAyXG4gKiAgLSBcdTY3MDkgSFRUUCBcdTU0Q0RcdTVFOTQgXHUyMTkyIGh0dHAtcmVzcG9uc2VcdUZGMDhcdTU0MkJcdTcyQjZcdTYwMDFcdTc4MDFcdUZGMDlcbiAqICAtIFx1N0Y1MVx1N0VEQ1x1OTUxOVx1OEJFRlx1RkYwOEVDT05OUkVGVVNFRCBcdTdCNDlcdUZGMDlcdTIxOTIgbmV0d29yay1lcnJvclxuICogIC0gXHU1MTc2XHU0RUQ2XHU1RjAyXHU1RTM4XHVGRjA4XHU4RDg1XHU2NUY2XHU3QjQ5XHVGRjA5XHUyMTkyIG90aGVyLWVycm9yXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwcm9iZVBvcnQocG9ydDogbnVtYmVyLCB0aW1lb3V0TXMgPSAzMDAwKTogUHJvbWlzZTxQb3J0SGVhbHRoPiB7XG5cdHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuXHRcdGNvbnN0IHJlcSA9IGh0dHAuZ2V0KFxuXHRcdFx0e1xuXHRcdFx0XHRob3N0OiAnMTI3LjAuMC4xJyxcblx0XHRcdFx0cG9ydCxcblx0XHRcdFx0cGF0aDogJy8nLFxuXHRcdFx0XHRoZWFkZXJzOiB7IEhvc3Q6IGAxMjcuMC4wLjE6JHtwb3J0fWAgfSxcblx0XHRcdFx0dGltZW91dDogdGltZW91dE1zLFxuXHRcdFx0fSxcblx0XHRcdChyZXMpID0+IHtcblx0XHRcdFx0Ly8gXHU2RDg4XHU4RDM5XHU1NENEXHU1RTk0XHU0RjUzXHVGRjBDXHU5MDdGXHU1MTREXHU4RkRFXHU2M0E1XHU2MzAyXHU4RDc3XG5cdFx0XHRcdHJlcy5yZXN1bWUoKTtcblx0XHRcdFx0cmVzb2x2ZSh7IGtpbmQ6ICdodHRwLXJlc3BvbnNlJywgc3RhdHVzOiByZXMuc3RhdHVzQ29kZSA/PyAwIH0pO1xuXHRcdFx0fVxuXHRcdCk7XG5cdFx0cmVxLm9uKCd0aW1lb3V0JywgKCkgPT4ge1xuXHRcdFx0Ly8gXHU4RDg1XHU2NUY2IFx1MjE5MiBvdGhlci1lcnJvclx1RkYwOFx1MDBBNzRcdUZGMUFcdTg5QzZcdTRFM0FcdTdBN0FcdTk1RjJcdTRGNDZcdTU0NEFcdThCNjZcdUZGMENcdTVDMURcdThCRDUgc3Bhd25cdUZGMDlcblx0XHRcdHJlcS5kZXN0cm95KG5ldyBFcnJvcihgXHU4QkY3XHU2QzQyXHU4RDg1XHU2NUY2XHVGRjA4JHt0aW1lb3V0TXN9bXNcdUZGMDlgKSk7XG5cdFx0fSk7XG5cdFx0cmVxLm9uKCdlcnJvcicsIChlcnI6IEVycm9yICYgeyBjb2RlPzogc3RyaW5nIH0pID0+IHtcblx0XHRcdGlmIChlcnIuY29kZSkge1xuXHRcdFx0XHRyZXNvbHZlKHsga2luZDogJ25ldHdvcmstZXJyb3InLCBjb2RlOiBlcnIuY29kZSwgbWVzc2FnZTogZXJyLm1lc3NhZ2UgfSk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRyZXNvbHZlKHsga2luZDogJ290aGVyLWVycm9yJywgbWVzc2FnZTogZXJyLm1lc3NhZ2UgfSk7XG5cdFx0XHR9XG5cdFx0fSk7XG5cdH0pO1xufVxuXG4vKiogXHU4RkRCXHU3QTBCXHU2MjU4XHU3QkExXHU5MTREXHU3RjZFICovXG5leHBvcnQgaW50ZXJmYWNlIERzaFByb2Nlc3NDb25maWcge1xuXHRub2RlUGF0aDogc3RyaW5nOyAgIC8vIG5vZGUgXHU1M0VGXHU2MjY3XHU4ODRDXHU4REVGXHU1Rjg0XHVGRjBDXHU5RUQ4XHU4QkE0ICdub2RlJ1x1RkYwOFBBVEggXHU0RTJEXHU3Njg0IG5vZGVcdUZGMDlcblx0ZHNoQmluUGF0aDogc3RyaW5nOyAvLyBkc2ggd2ViIGJpbiBcdThERUZcdTVGODRcdUZGMENcdTlFRDhcdThCQTQgRDovZGVlcHNlZWstaGFybmVzcy9hcHBzL2NsaS9saWIvYmluLmpzXG5cdHBvcnQ6IG51bWJlcjsgICAgICAgLy8gXHU3NkQxXHU1NDJDXHU3QUVGXHU1M0UzXG5cdGxvZ0ZpbGU6IHN0cmluZzsgICAgLy8gXHU2NUU1XHU1RkQ3XHU2NTg3XHU0RUY2XHU4REVGXHU1Rjg0XG59XG5cbi8qKiBcdTcyQjZcdTYwMDFcdTRGRTFcdTYwNkZcdUZGMDhcdTcyQjZcdTYwMDFcdTY4MEYvXHU4OUM2XHU1NkZFXHU2MzZFXHU2QjY0XHU2NkY0XHU2NUIwXHVGRjA5ICovXG5leHBvcnQgaW50ZXJmYWNlIERzaFN0YXR1c0luZm8ge1xuXHRzdGF0ZTogRHNoUHJvY2Vzc1N0YXRlO1xuXHRwb3J0OiBudW1iZXI7XG5cdGV4dGVybmFsOiBib29sZWFuOyAgLy8gdHJ1ZSA9IFx1NTkwRFx1NzUyOFx1NTkxNlx1OTBFOFx1NUI5RVx1NEY4Qlx1RkYwOFx1N0VERFx1NEUwRCBraWxsXHVGRjA5XG5cdHJlYXNvbj86IHN0cmluZzsgICAgLy8gZXJyb3IgXHU2NUY2XHU3Njg0XHU1MzlGXHU1NkUwXG59XG5cbmV4cG9ydCB0eXBlIFN0YXR1c0xpc3RlbmVyID0gKGluZm86IERzaFN0YXR1c0luZm8pID0+IHZvaWQ7XG5cbi8qKiBzdGFydGluZyBcdTY3MUZcdTk1RjRcdTUwNjVcdTVFQjdcdTY4QzBcdTY3RTVcdTk1RjRcdTk2OTQgKi9cbmNvbnN0IEhFQUxUSF9QUk9CRV9JTlRFUlZBTF9NUyA9IDgwMDtcbi8qKiBcdTUwNjVcdTVFQjdcdTY4QzBcdTY3RTVcdTY3MDBcdTk1N0ZcdTdCNDlcdTVGODVcdTY1RjZcdTk1RjQgKi9cbmNvbnN0IEhFQUxUSF9QUk9CRV9NQVhfTVMgPSA2MF8wMDA7XG5cbmV4cG9ydCBjbGFzcyBEc2hQcm9jZXNzTWFuYWdlciB7XG5cdHByaXZhdGUgY2ZnOiBEc2hQcm9jZXNzQ29uZmlnO1xuXHRwcml2YXRlIHN0YXRlOiBEc2hQcm9jZXNzU3RhdGUgPSAnc3RvcHBlZCc7XG5cdHByaXZhdGUgY2hpbGQ6IENoaWxkUHJvY2VzcyB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIGV4dGVybmFsID0gZmFsc2U7XG5cdHByaXZhdGUgZXJyb3JSZWFzb246IHN0cmluZyB8IHVuZGVmaW5lZDtcblx0cHJpdmF0ZSBsaXN0ZW5lcnMgPSBuZXcgU2V0PFN0YXR1c0xpc3RlbmVyPigpO1xuXHRwcml2YXRlIGhlYWx0aFRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRJbnRlcnZhbD4gfCBudWxsID0gbnVsbDtcblx0cHJpdmF0ZSBsb2dTdHJlYW06IGZzLldyaXRlU3RyZWFtIHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgc3RvcHBpbmcgPSBmYWxzZTtcblxuXHRjb25zdHJ1Y3RvcihjZmc6IERzaFByb2Nlc3NDb25maWcpIHtcblx0XHR0aGlzLmNmZyA9IGNmZztcblx0fVxuXG5cdC8vIC0tLS0tLS0tLS0gXHU1M0VBXHU4QkZCXHU2N0U1XHU4QkUyIC0tLS0tLS0tLS1cblxuXHRnZXRTdGF0ZSgpOiBEc2hQcm9jZXNzU3RhdGUge1xuXHRcdHJldHVybiB0aGlzLnN0YXRlO1xuXHR9XG5cblx0Z2V0UG9ydCgpOiBudW1iZXIge1xuXHRcdHJldHVybiB0aGlzLmNmZy5wb3J0O1xuXHR9XG5cblx0aXNFeHRlcm5hbCgpOiBib29sZWFuIHtcblx0XHRyZXR1cm4gdGhpcy5leHRlcm5hbDtcblx0fVxuXG5cdGdldEVycm9yUmVhc29uKCk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG5cdFx0cmV0dXJuIHRoaXMuZXJyb3JSZWFzb247XG5cdH1cblxuXHQvLyAtLS0tLS0tLS0tIFx1NEU4Qlx1NEVGNiAtLS0tLS0tLS0tXG5cblx0LyoqIFx1NkNFOFx1NTE4Q1x1NzJCNlx1NjAwMVx1NTNEOFx1NjZGNFx1NzZEMVx1NTQyQ1x1RkYwQ1x1OEZENFx1NTZERVx1NTNENlx1NkQ4OFx1NTFGRFx1NjU3MCAqL1xuXHRvblN0YXR1c0NoYW5nZWQobGlzdGVuZXI6IFN0YXR1c0xpc3RlbmVyKTogKCkgPT4gdm9pZCB7XG5cdFx0dGhpcy5saXN0ZW5lcnMuYWRkKGxpc3RlbmVyKTtcblx0XHRyZXR1cm4gKCkgPT4ge1xuXHRcdFx0dGhpcy5saXN0ZW5lcnMuZGVsZXRlKGxpc3RlbmVyKTtcblx0XHR9O1xuXHR9XG5cblx0cHJpdmF0ZSBlbWl0KCk6IHZvaWQge1xuXHRcdGNvbnN0IGluZm86IERzaFN0YXR1c0luZm8gPSB7XG5cdFx0XHRzdGF0ZTogdGhpcy5zdGF0ZSxcblx0XHRcdHBvcnQ6IHRoaXMuY2ZnLnBvcnQsXG5cdFx0XHRleHRlcm5hbDogdGhpcy5leHRlcm5hbCxcblx0XHRcdHJlYXNvbjogdGhpcy5lcnJvclJlYXNvbixcblx0XHR9O1xuXHRcdHRoaXMubGlzdGVuZXJzLmZvckVhY2goKGwpID0+IGwoaW5mbykpO1xuXHR9XG5cblx0cHJpdmF0ZSBzZXRTdGF0ZShzdGF0ZTogRHNoUHJvY2Vzc1N0YXRlLCByZWFzb24/OiBzdHJpbmcpOiB2b2lkIHtcblx0XHR0aGlzLnN0YXRlID0gc3RhdGU7XG5cdFx0aWYgKHJlYXNvbiAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHR0aGlzLmVycm9yUmVhc29uID0gcmVhc29uO1xuXHRcdH1cblx0XHR0aGlzLmxvZyhgXHU3MkI2XHU2MDAxXHU1M0Q4XHU2NkY0IFx1MjE5MiAke3N0YXRlfSR7cmVhc29uID8gYFx1RkYwOCR7cmVhc29ufVx1RkYwOWAgOiAnJ31gKTtcblx0XHR0aGlzLmVtaXQoKTtcblx0fVxuXG5cdC8vIC0tLS0tLS0tLS0gXHU3QUVGXHU1M0UzXHU5ODg0XHU2OEMwIFx1MjE5MiBcdTUxQjNcdTdCNTYgXHUyMTkyIFx1NjI2N1x1ODg0QyAtLS0tLS0tLS0tXG5cblx0LyoqXG5cdCAqIFx1Nzg2RVx1NEZERCBkc2ggXHU1M0VGXHU3NTI4XHVGRjFBXHU3QUVGXHU1M0UzXHU5ODg0XHU2OEMwIFx1MjE5MiBkZWNpZGVQb3J0QWN0aW9uIFx1NTFCM1x1N0I1Nlx1RkYwOFx1NTkwRFx1NzUyOC9zcGF3bi9cdTYyQTVcdTk1MTlcdUZGMDlcdTIxOTIgXHU2MjY3XHU4ODRDXHUzMDAyXG5cdCAqIFx1NURGMlx1NTcyOCBydW5uaW5nIC8gc3RhcnRpbmcgXHU2NUY2XHU3NkY0XHU2M0E1XHU4RkQ0XHU1NkRFXHVGRjFCZXJyb3IgLyBzdG9wcGVkIFx1NzJCNlx1NjAwMVx1NEYxQVx1OTFDRFx1NjVCMFx1OEQ3MFx1NEUwMFx1OTA0RFx1OTg4NFx1NjhDMFx1RkYwOFx1NjUyRlx1NjMwMVx1OTFDRFx1OEJENVx1RkYwOVx1MzAwMlxuXHQgKi9cblx0YXN5bmMgZW5zdXJlUnVubmluZygpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRpZiAodGhpcy5zdGF0ZSA9PT0gJ3J1bm5pbmcnIHx8IHRoaXMuc3RhdGUgPT09ICdzdGFydGluZycpIHtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0dGhpcy5zdG9wcGluZyA9IGZhbHNlO1xuXHRcdHRoaXMubG9nKGBcdTdBRUZcdTUzRTNcdTk4ODRcdTY4QzBcdTVGMDBcdTU5Q0JcdUZGMUFodHRwOi8vMTI3LjAuMC4xOiR7dGhpcy5jZmcucG9ydH0vYCk7XG5cdFx0Y29uc3QgaGVhbHRoID0gYXdhaXQgcHJvYmVQb3J0KHRoaXMuY2ZnLnBvcnQpO1xuXHRcdGNvbnN0IGFjdGlvbiA9IGRlY2lkZVBvcnRBY3Rpb24oaGVhbHRoKTtcblx0XHR0aGlzLmxvZyhgXHU3QUVGXHU1M0UzXHU5ODg0XHU2OEMwXHU3RUQzXHU2NzlDXHVGRjFBYWN0aW9uPSR7YWN0aW9uLmFjdGlvbn1gKTtcblxuXHRcdHN3aXRjaCAoYWN0aW9uLmFjdGlvbikge1xuXHRcdFx0Y2FzZSAncmV1c2UnOlxuXHRcdFx0XHQvLyBcdTVERjJcdTY3MDlcdTVCOUVcdTRGOEJcdTU3MjhcdThERDFcdUZGMDhcdTUzRUZcdTgwRkRcdTY2MkZcdTc1MjhcdTYyMzdcdTYyNEJcdTUyQThcdTU0MkZcdTUyQThcdTc2ODQgZHNoXHVGRjA5XHUyMTkyIFx1NzZGNFx1NjNBNVx1NTkwRFx1NzUyOFx1RkYwQ1x1NEUwRCBzcGF3blx1MzAwMVx1NEUwRCBraWxsXG5cdFx0XHRcdHRoaXMuZXh0ZXJuYWwgPSB0cnVlO1xuXHRcdFx0XHR0aGlzLmNoaWxkID0gbnVsbDtcblx0XHRcdFx0dGhpcy5zZXRTdGF0ZSgncnVubmluZycsIGBcdTU5MERcdTc1MjhcdTVERjJcdTY3MDlcdTVCOUVcdTRGOEJcdUZGMDhcdTdBRUZcdTUzRTMgJHt0aGlzLmNmZy5wb3J0fVx1RkYwOWApO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHRjYXNlICdlcnJvcic6XG5cdFx0XHRcdC8vIFx1N0FFRlx1NTNFM1x1ODhBQlx1NTE3Nlx1NEVENlx1N0EwQlx1NUU4Rlx1NTM2MFx1NzUyOCBcdTIxOTIgXHU2MkE1XHU5NTE5XHU2M0QwXHU3OTNBXHU2MzYyXHU3QUVGXHU1M0UzXG5cdFx0XHRcdHRoaXMuZXh0ZXJuYWwgPSBmYWxzZTtcblx0XHRcdFx0dGhpcy5zZXRTdGF0ZSgnZXJyb3InLCBhY3Rpb24ucmVhc29uKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0Y2FzZSAnc3Bhd24nOlxuXHRcdFx0XHR0aGlzLmV4dGVybmFsID0gZmFsc2U7XG5cdFx0XHRcdGlmIChhY3Rpb24ud2Fybikge1xuXHRcdFx0XHRcdHRoaXMubG9nKGBbXHU1NDRBXHU4QjY2XSAke2FjdGlvbi53YXJufWApO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGF3YWl0IHRoaXMuc3RhcnRDaGlsZCgpO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0fVxuXHR9XG5cblx0Ly8gLS0tLS0tLS0tLSBzcGF3biArIFx1NTA2NVx1NUVCN1x1NjhDMFx1NjdFNSAtLS0tLS0tLS0tXG5cblx0LyoqIHNwYXduIFx1NUI1MFx1OEZEQlx1N0EwQlx1NUU3Nlx1OEZEQlx1NTE2NSBzdGFydGluZyBcdTYwMDFcdUZGMENcdTk2OEZcdTU0MEVcdTVGMDBcdTU5Q0JcdTUwNjVcdTVFQjdcdTY4QzBcdTY3RTVcdTVGQUFcdTczQUYgKi9cblx0cHJpdmF0ZSBhc3luYyBzdGFydENoaWxkKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGNvbnN0IHsgbm9kZVBhdGgsIGRzaEJpblBhdGgsIHBvcnQgfSA9IHRoaXMuY2ZnO1xuXG5cdFx0aWYgKCFkc2hCaW5QYXRoKSB7XG5cdFx0XHR0aGlzLnNldFN0YXRlKFxuXHRcdFx0XHQnZXJyb3InLFxuXHRcdFx0XHQnXHU2NzJBXHU5MTREXHU3RjZFIGRzaCBcdTUzRUZcdTYyNjdcdTg4NENcdThERUZcdTVGODRcdUZGMUFcdThCRjdcdTU3MjhcdTYzRDJcdTRFRjZcdThCQkVcdTdGNkVcdTRFMkRcdTU4NkJcdTUxOTkgZHNoIFx1NzY4NCBiaW4uanMgXHU4REVGXHU1Rjg0XHVGRjBDXHU2MjE2XHU4QkJFXHU3RjZFXHU3M0FGXHU1ODgzXHU1M0Q4XHU5MUNGIERTSF9CSU5cdTMwMDInXG5cdFx0XHQpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGNvbnN0IGRzaEN3ZCA9IGRlcml2ZURzaEN3ZChkc2hCaW5QYXRoKTtcblxuXHRcdGlmICghZnMuZXhpc3RzU3luYyhkc2hDd2QpKSB7XG5cdFx0XHR0aGlzLnNldFN0YXRlKCdlcnJvcicsIGBkc2ggXHU5ODc5XHU3NkVFXHU2ODM5XHU3NkVFXHU1RjU1XHU0RTBEXHU1QjU4XHU1NzI4XHVGRjFBJHtkc2hDd2R9XHVGRjBDXHU4QkY3XHU2OEMwXHU2N0U1XHUyMDFDZHNoIFx1NTNFRlx1NjI2N1x1ODg0Q1x1OERFRlx1NUY4NFx1MjAxRFx1OEJCRVx1N0Y2RVx1MzAwMmApO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdHRoaXMub3BlbkxvZygpO1xuXHRcdHRoaXMubG9nKGBzcGF3blx1RkYxQSR7bm9kZVBhdGh9ICR7ZHNoQmluUGF0aH0gd2ViIC0tcG9ydCAke3BvcnR9XHVGRjA4Y3dkPSR7ZHNoQ3dkfVx1RkYwOWApO1xuXHRcdHRoaXMuc2V0U3RhdGUoJ3N0YXJ0aW5nJyk7XG5cblx0XHRsZXQgY2hpbGQ6IENoaWxkUHJvY2Vzcztcblx0XHR0cnkge1xuXHRcdFx0Ly8gZGV0YWNoZWQ6IGZhbHNlIFx1MjAxNFx1MjAxNCBcdThGREJcdTdBMEJcdTk2OEZcdTYzRDJcdTRFRjZcdUZGMDhPYnNpZGlhblx1RkYwOVx1NzUxRlx1NTQ3RFx1NTQ2OFx1NjcxRlx1N0JBMVx1NzQwNlx1RkYwQ1x1NEUwRFx1ODEzMVx1NzlCQlx1OEZEQlx1N0EwQlx1N0VDNFxuXHRcdFx0Y2hpbGQgPSBzcGF3bihub2RlUGF0aCwgW2RzaEJpblBhdGgsICd3ZWInLCAnLS1wb3J0JywgU3RyaW5nKHBvcnQpXSwge1xuXHRcdFx0XHRjd2Q6IGRzaEN3ZCxcblx0XHRcdFx0ZGV0YWNoZWQ6IGZhbHNlLFxuXHRcdFx0XHR3aW5kb3dzSGlkZTogdHJ1ZSxcblx0XHRcdH0pO1xuXHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0dGhpcy5zZXRTdGF0ZSgnZXJyb3InLCBgXHU1NDJGXHU1MkE4IGRzaCBcdThGREJcdTdBMEJcdTU5MzFcdThEMjVcdUZGMUEkeyhlcnIgYXMgRXJyb3IpPy5tZXNzYWdlID8/IFN0cmluZyhlcnIpfWApO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHR0aGlzLmNoaWxkID0gY2hpbGQ7XG5cblx0XHQvLyBcdTY1RTVcdTVGRDdcdUZGMUFzdGRvdXQvc3RkZXJyIFx1OEZGRFx1NTJBMFx1NTE5OVx1NTE2NVx1NjVFNVx1NUZEN1x1NjU4N1x1NEVGNlx1RkYwQ1x1NUUyNlx1NjVGNlx1OTVGNFx1NjIzM1xuXHRcdGNoaWxkLnN0ZG91dD8ub24oJ2RhdGEnLCAoY2h1bms6IEJ1ZmZlcikgPT4ge1xuXHRcdFx0dGhpcy5sb2coYFtzdGRvdXRdICR7Y2h1bmsudG9TdHJpbmcoKX1gKTtcblx0XHR9KTtcblx0XHRjaGlsZC5zdGRlcnI/Lm9uKCdkYXRhJywgKGNodW5rOiBCdWZmZXIpID0+IHtcblx0XHRcdHRoaXMubG9nKGBbc3RkZXJyXSAke2NodW5rLnRvU3RyaW5nKCl9YCk7XG5cdFx0fSk7XG5cblx0XHRjaGlsZC5vbignZXJyb3InLCAoZXJyKSA9PiB7XG5cdFx0XHQvLyBcdTRFOENcdThGREJcdTUyMzZcdTY1RTBcdTZDRDVcdTU0MkZcdTUyQThcdUZGMDhub2RlUGF0aCBcdTk1MTlcdThCRUZcdTdCNDlcdUZGMDlcblx0XHRcdHRoaXMubG9nKGBcdTVCNTBcdThGREJcdTdBMEIgZXJyb3IgXHU0RThCXHU0RUY2XHVGRjFBJHtlcnIubWVzc2FnZX1gKTtcblx0XHRcdHRoaXMuY2hpbGQgPSBudWxsO1xuXHRcdFx0dGhpcy5zdG9wSGVhbHRoQ2hlY2soKTtcblx0XHRcdHRoaXMuc2V0U3RhdGUoJ2Vycm9yJywgYFx1NTQyRlx1NTJBOCBkc2ggXHU4RkRCXHU3QTBCXHU1OTMxXHU4RDI1XHVGRjFBJHtlcnIubWVzc2FnZX1gKTtcblx0XHR9KTtcblxuXHRcdGNoaWxkLm9uKCdleGl0JywgKGNvZGUsIHNpZ25hbCkgPT4ge1xuXHRcdFx0dGhpcy5sb2coYFx1NUI1MFx1OEZEQlx1N0EwQlx1OTAwMFx1NTFGQSBjb2RlPSR7Y29kZX0gc2lnbmFsPSR7c2lnbmFsfWApO1xuXHRcdFx0dGhpcy5jaGlsZCA9IG51bGw7XG5cdFx0XHR0aGlzLnN0b3BIZWFsdGhDaGVjaygpO1xuXHRcdFx0Ly8gc3RvcHBpbmcgXHU2NUY2IHN0YXRlIFx1NURGMlx1NjYyRiAnc3RvcHBlZCdcdUZGMENcdTRFMERcdTg5ODZcdTc2RDZcblx0XHRcdGlmICh0aGlzLnN0YXRlID09PSAnc3RhcnRpbmcnIHx8IHRoaXMuc3RhdGUgPT09ICdydW5uaW5nJykge1xuXHRcdFx0XHR0aGlzLnNldFN0YXRlKCdlcnJvcicsIGBkc2ggd2ViIFx1OEZEQlx1N0EwQlx1OTAwMFx1NTFGQVx1RkYwOGNvZGU9JHtjb2RlID8/ICdcdTY1RTAnfVx1RkYwOVx1RkYwQ1x1OEJGN1x1NjdFNVx1NzcwQlx1NjVFNVx1NUZEN1x1RkYxQSR7dGhpcy5jZmcubG9nRmlsZX1gKTtcblx0XHRcdH1cblx0XHR9KTtcblxuXHRcdHRoaXMuYmVnaW5IZWFsdGhDaGVjaygpO1xuXHR9XG5cblx0LyoqIHN0YXJ0aW5nIFx1NjcxRlx1OTVGNFx1NkJDRiA4MDBtcyBcdTUwNjVcdTVFQjdcdTY4QzBcdTY3RTVcdUZGMENcdTY3MDBcdTU5MUEgNjBzXHVGRjFCXHU1MDY1XHU1RUI3XHU1MzczXHU4RjZDIHJ1bm5pbmcgKi9cblx0cHJpdmF0ZSBiZWdpbkhlYWx0aENoZWNrKCk6IHZvaWQge1xuXHRcdHRoaXMuc3RvcEhlYWx0aENoZWNrKCk7XG5cdFx0Y29uc3Qgc3RhcnQgPSBEYXRlLm5vdygpO1xuXHRcdHRoaXMuaGVhbHRoVGltZXIgPSBzZXRJbnRlcnZhbChhc3luYyAoKSA9PiB7XG5cdFx0XHRpZiAodGhpcy5zdG9wcGluZykge1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBoZWFsdGggPSBhd2FpdCBwcm9iZVBvcnQodGhpcy5jZmcucG9ydCk7XG5cdFx0XHRjb25zdCBhY3Rpb24gPSBkZWNpZGVQb3J0QWN0aW9uKGhlYWx0aCk7XG5cdFx0XHRpZiAoYWN0aW9uLmFjdGlvbiA9PT0gJ3JldXNlJykge1xuXHRcdFx0XHQvLyBcdTUwNjVcdTVFQjdcdTY4QzBcdTY3RTVcdTkwMUFcdThGQzcgXHUyMTkyIHJ1bm5pbmdcdUZGMDhcdTgxRUFcdTVERjEgc3Bhd24gXHU3Njg0XHU4RkRCXHU3QTBCXHVGRjBDXHU0RUNEXHU1RjUyXHU4MUVBXHU1REYxXHU3QkExXHU3NDA2XHVGRjA5XG5cdFx0XHRcdHRoaXMuc3RvcEhlYWx0aENoZWNrKCk7XG5cdFx0XHRcdHRoaXMuZXh0ZXJuYWwgPSBmYWxzZTtcblx0XHRcdFx0dGhpcy5zZXRTdGF0ZSgncnVubmluZycsIGBcdTUwNjVcdTVFQjdcdTY4QzBcdTY3RTVcdTkwMUFcdThGQzdcdUZGMDhcdTdBRUZcdTUzRTMgJHt0aGlzLmNmZy5wb3J0fVx1RkYwOWApO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cdFx0XHRpZiAoRGF0ZS5ub3coKSAtIHN0YXJ0ID4gSEVBTFRIX1BST0JFX01BWF9NUykge1xuXHRcdFx0XHQvLyA2MHMgXHU2NzJBXHU1QzMxXHU3RUVBIFx1MjE5MiBcdTYyQTVcdTk1MTlcdTVFNzZcdTZFMDVcdTc0MDZcdTgxRUFcdTVERjEgc3Bhd24gXHU3Njg0XHU4RkRCXHU3QTBCXHVGRjBDXHU5MDdGXHU1MTREXHU1MEY1XHU1QzM4XHU4RkRCXHU3QTBCXG5cdFx0XHRcdHRoaXMuc3RvcEhlYWx0aENoZWNrKCk7XG5cdFx0XHRcdHRoaXMuc2V0U3RhdGUoXG5cdFx0XHRcdFx0J2Vycm9yJyxcblx0XHRcdFx0XHRgZHNoIFx1NTQyRlx1NTJBOFx1NTQwRSAke0hFQUxUSF9QUk9CRV9NQVhfTVMgLyAxMDAwfSBcdTc5RDJcdTUxODVcdTUwNjVcdTVFQjdcdTY4QzBcdTY3RTVcdTY3MkFcdTkwMUFcdThGQzdcdUZGMENcdThCRjdcdTY3RTVcdTc3MEJcdTY1RTVcdTVGRDdcdUZGMUEke3RoaXMuY2ZnLmxvZ0ZpbGV9YFxuXHRcdFx0XHQpO1xuXHRcdFx0XHRhd2FpdCB0aGlzLmtpbGxPd25DaGlsZCgpO1xuXHRcdFx0fVxuXHRcdFx0Ly8gXHU2NzJBXHU1QzMxXHU3RUVBXHVGRjBDXHU3RUU3XHU3RUVEXHU2M0EyXHU2RDRCXG5cdFx0fSwgSEVBTFRIX1BST0JFX0lOVEVSVkFMX01TKTtcblx0fVxuXG5cdHByaXZhdGUgc3RvcEhlYWx0aENoZWNrKCk6IHZvaWQge1xuXHRcdGlmICh0aGlzLmhlYWx0aFRpbWVyKSB7XG5cdFx0XHRjbGVhckludGVydmFsKHRoaXMuaGVhbHRoVGltZXIpO1xuXHRcdFx0dGhpcy5oZWFsdGhUaW1lciA9IG51bGw7XG5cdFx0fVxuXHR9XG5cblx0Ly8gLS0tLS0tLS0tLSBraWxsXHVGRjA4XHU1M0VBIGtpbGwgXHU4MUVBXHU1REYxIHNwYXduIFx1NzY4NFx1RkYwOSAtLS0tLS0tLS0tXG5cblx0LyoqXG5cdCAqIFx1NTA1Q1x1NkI2Mlx1NjI1OFx1N0JBMVx1RkYxQVx1NTNFQSBraWxsIFx1ODFFQVx1NURGMSBzcGF3biBcdTc2ODRcdThGREJcdTdBMEJcdUZGMUJcdTU5MTZcdTkwRThcdTVCOUVcdTRGOEJcdUZGMDhleHRlcm5hbD10cnVlXHVGRjA5XHU3RUREXHU0RTBEIGtpbGxcdTMwMDJcblx0ICogXHU1RTQyXHU3QjQ5XHUzMDAyXG5cdCAqL1xuXHRhc3luYyBzdG9wKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGlmICh0aGlzLnN0b3BwaW5nKSB7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdHRoaXMuc3RvcHBpbmcgPSB0cnVlO1xuXHRcdHRoaXMuc3RvcEhlYWx0aENoZWNrKCk7XG5cdFx0aWYgKHRoaXMuZXh0ZXJuYWwpIHtcblx0XHRcdC8vIFx1NTkxNlx1OTBFOFx1NUI5RVx1NEY4Qlx1RkYxQVx1NTNFQVx1NkUwNVx1NjI1OFx1N0JBMVx1NzJCNlx1NjAwMVx1RkYwQ1x1N0VERFx1NEUwRCBraWxsIFx1NzUyOFx1NjIzN1x1NjI0Qlx1NTJBOFx1NTQyRlx1NTJBOFx1NzY4NFx1OEZEQlx1N0EwQlxuXHRcdFx0dGhpcy5sb2coJ2V4dGVybmFsIFx1NUI5RVx1NEY4Qlx1RkYxQVx1NEVDNVx1NTA1Q1x1NkI2Mlx1NjI1OFx1N0JBMVx1NzJCNlx1NjAwMVx1RkYwQ1x1NEUwRCBraWxsIFx1NTkxNlx1OTBFOFx1OEZEQlx1N0EwQicpO1xuXHRcdFx0dGhpcy5zZXRTdGF0ZSgnc3RvcHBlZCcpO1xuXHRcdFx0dGhpcy5zdG9wcGluZyA9IGZhbHNlO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHR0aGlzLnNldFN0YXRlKCdzdG9wcGVkJyk7XG5cdFx0YXdhaXQgdGhpcy5raWxsT3duQ2hpbGQoKTtcblx0XHR0aGlzLnN0b3BwaW5nID0gZmFsc2U7XG5cdH1cblxuXHQvKioga2lsbCBcdTgxRUFcdTVERjEgc3Bhd24gXHU3Njg0XHU4RkRCXHU3QTBCXHVGRjFBV2luZG93cyBcdTRFMEIgcHJvY2Vzcy5raWxsIFx1NTQwRVx1ODg2NSB0YXNra2lsbCAvVCAvRiBcdTUxNUNcdTVFOTVcdUZGMDhcdTVCNTBcdThGREJcdTdBMEJcdTUzRUZcdTgwRkRcdTVFMjZcdTVCNTlcdTVCNTBcdThGREJcdTdBMEJcdUZGMDkgKi9cblx0cHJpdmF0ZSBhc3luYyBraWxsT3duQ2hpbGQoKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0Y29uc3QgY2hpbGQgPSB0aGlzLmNoaWxkO1xuXHRcdHRoaXMuY2hpbGQgPSBudWxsO1xuXHRcdGlmICghY2hpbGQgfHwgIWNoaWxkLnBpZCkge1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHRjb25zdCBwaWQgPSBjaGlsZC5waWQ7XG5cdFx0dGhpcy5sb2coYGtpbGwgXHU4MUVBXHU1REYxXHU2MjU4XHU3QkExXHU3Njg0XHU4RkRCXHU3QTBCIHBpZD0ke3BpZH1gKTtcblx0XHR0cnkge1xuXHRcdFx0cHJvY2Vzcy5raWxsKHBpZCk7XG5cdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHR0aGlzLmxvZyhgcHJvY2Vzcy5raWxsIFx1NTkzMVx1OEQyNVx1RkYwOFx1NTNFRlx1ODBGRFx1NURGMlx1OTAwMFx1NTFGQVx1RkYwOVx1RkYxQSR7KGVyciBhcyBFcnJvcik/Lm1lc3NhZ2UgPz8gU3RyaW5nKGVycil9YCk7XG5cdFx0fVxuXHRcdGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSAnd2luMzInKSB7XG5cdFx0XHQvLyB0YXNra2lsbCBcdTUxNUNcdTVFOTVcdUZGMUEvVCBcdTkwMTJcdTVGNTJcdTY3NDBcdThGREJcdTdBMEJcdTY4MTFcdUZGMEMvRiBcdTVGM0FcdTUyMzZcblx0XHRcdGF3YWl0IHRoaXMucnVuVGFza2tpbGwocGlkKTtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIHJ1blRhc2traWxsKHBpZDogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0cmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG5cdFx0XHRjb25zdCB0ID0gc3Bhd24oJ3Rhc2traWxsJywgWycvcGlkJywgU3RyaW5nKHBpZCksICcvVCcsICcvRiddLCB7IHdpbmRvd3NIaWRlOiB0cnVlIH0pO1xuXHRcdFx0dC5vbignZXJyb3InLCAoKSA9PiByZXNvbHZlKCkpO1xuXHRcdFx0dC5vbignZXhpdCcsICgpID0+IHJlc29sdmUoKSk7XG5cdFx0XHR0Lm9uKCdjbG9zZScsICgpID0+IHJlc29sdmUoKSk7XG5cdFx0fSk7XG5cdH1cblxuXHQvLyAtLS0tLS0tLS0tIFx1OTE0RFx1N0Y2RVx1NEUwRVx1NzUxRlx1NTQ3RFx1NTQ2OFx1NjcxRiAtLS0tLS0tLS0tXG5cblx0LyoqXG5cdCAqIFx1OEJCRVx1N0Y2RVx1NTNEOFx1NjZGNFx1NjVGNlx1NjZGNFx1NjVCMFx1OTE0RFx1N0Y2RVx1MzAwMlx1ODJFNVx1ODFFQVx1NURGMVx1NjI1OFx1N0JBMVx1NzY4NFx1NUI1MFx1OEZEQlx1N0EwQlx1N0FFRlx1NTNFM1x1NEUwRVx1NjVCMFx1NzY4NFx1NEUwRFx1NEUwMFx1ODFGNCBcdTIxOTIgXHU1MDVDXHU2Mzg5XHU4MUVBXHU1REYxXHU3Njg0XHU2NUU3XHU4RkRCXHU3QTBCXG5cdCAqIFx1RkYwOFx1NTkxNlx1OTBFOFx1NUI5RVx1NEY4Qlx1NEUwRFx1NTJBOFx1RkYwOVx1RkYwQ1x1N0I0OVx1NUY4NVx1NEUwQlx1NkIyMSBlbnN1cmVSdW5uaW5nIFx1NTcyOFx1NjVCMFx1N0FFRlx1NTNFM1x1NEUwQVx1OTFDRFx1NjVCMFx1NjJDOVx1OEQ3N1x1MzAwMlxuXHQgKi9cblx0YXN5bmMgdXBkYXRlQ29uZmlnKGNmZzogUGFydGlhbDxEc2hQcm9jZXNzQ29uZmlnPik6IFByb21pc2U8dm9pZD4ge1xuXHRcdGNvbnN0IG9sZFBvcnQgPSB0aGlzLmNmZy5wb3J0O1xuXHRcdGNvbnN0IG5ld1BvcnQgPSBjZmcucG9ydCA/PyBvbGRQb3J0O1xuXHRcdGNvbnN0IG93bnNDaGlsZCA9ICF0aGlzLmV4dGVybmFsICYmIHRoaXMuY2hpbGQgIT09IG51bGw7XG5cdFx0T2JqZWN0LmFzc2lnbih0aGlzLmNmZywgY2ZnKTtcblx0XHRpZiAob3duc0NoaWxkICYmIG5ld1BvcnQgIT09IG9sZFBvcnQpIHtcblx0XHRcdHRoaXMubG9nKGBcdTdBRUZcdTUzRTNcdTc1MzEgJHtvbGRQb3J0fSBcdTY1MzlcdTRFM0EgJHtuZXdQb3J0fVx1RkYwQ1x1NTA1Q1x1NkI2Mlx1ODFFQVx1NURGMVx1NjI1OFx1N0JBMVx1NzY4NFx1NjVFN1x1OEZEQlx1N0EwQmApO1xuXHRcdFx0YXdhaXQgdGhpcy5zdG9wKCk7XG5cdFx0fVxuXHR9XG5cblx0LyoqIFx1NjNEMlx1NEVGNlx1NTM3OFx1OEY3RFx1NjVGNlx1OEMwM1x1NzUyOFx1RkYxQWtpbGwgXHU4MUVBXHU1REYxIHNwYXduIFx1NzY4NFx1OEZEQlx1N0EwQlx1NUU3Nlx1NTE3M1x1OTVFRFx1NjVFNVx1NUZEN1x1NkQ0MSAqL1xuXHRhc3luYyBkaXNwb3NlKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGF3YWl0IHRoaXMuc3RvcCgpO1xuXHRcdHRoaXMuY2xvc2VMb2coKTtcblx0XHR0aGlzLmxpc3RlbmVycy5jbGVhcigpO1xuXHR9XG5cblx0Ly8gLS0tLS0tLS0tLSBcdTY1RTVcdTVGRDcgLS0tLS0tLS0tLVxuXG5cdC8qKiBcdTYyNTNcdTVGMDBcdTY1RTVcdTVGRDdcdTZENDFcdUZGMDhhcHBlbmQgXHU2QTIxXHU1RjBGXHVGRjA5XHVGRjBDXHU3NkVFXHU1RjU1XHU0RTBEXHU1QjU4XHU1NzI4XHU1MjE5XHU1MjFCXHU1RUZBICovXG5cdHByaXZhdGUgb3BlbkxvZygpOiB2b2lkIHtcblx0XHRpZiAodGhpcy5sb2dTdHJlYW0pIHtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IGRpciA9IHBhdGguZGlybmFtZSh0aGlzLmNmZy5sb2dGaWxlKTtcblx0XHRcdGZzLm1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXHRcdFx0dGhpcy5sb2dTdHJlYW0gPSBmcy5jcmVhdGVXcml0ZVN0cmVhbSh0aGlzLmNmZy5sb2dGaWxlLCB7IGZsYWdzOiAnYScgfSk7XG5cdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHQvLyBcdTY1RTVcdTVGRDdcdTUxOTlcdTRFMERcdTRFODZcdTRFMERcdTgwRkRcdTk2M0JcdTU4NUVcdTRFM0JcdTZENDFcdTdBMEJcdUZGMENcdTRFQzVcdTYzQTdcdTUyMzZcdTUzRjBcdTU0NEFcdThCNjZcblx0XHRcdGNvbnNvbGUuZXJyb3IoJ1tvYnNpZGlhbi1kc2hdIFx1NjI1M1x1NUYwMFx1NjVFNVx1NUZEN1x1NjU4N1x1NEVGNlx1NTkzMVx1OEQyNTonLCBlcnIpO1xuXHRcdFx0dGhpcy5sb2dTdHJlYW0gPSBudWxsO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgY2xvc2VMb2coKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMubG9nU3RyZWFtKSB7XG5cdFx0XHR0aGlzLmxvZ1N0cmVhbS5lbmQoKTtcblx0XHRcdHRoaXMubG9nU3RyZWFtID0gbnVsbDtcblx0XHR9XG5cdH1cblxuXHQvKiogXHU1RTI2XHU2NUY2XHU5NUY0XHU2MjMzXHU4RkZEXHU1MkEwXHU0RTAwXHU4ODRDXHU2NUU1XHU1RkQ3XHVGRjA4XHU1MTk5XHU2NUU1XHU1RkQ3XHU2NTg3XHU0RUY2ICsgXHU2M0E3XHU1MjM2XHU1M0YwXHVGRjA5ICovXG5cdHByaXZhdGUgbG9nKG1lc3NhZ2U6IHN0cmluZyk6IHZvaWQge1xuXHRcdGNvbnN0IGxpbmUgPSBgWyR7bmV3IERhdGUoKS50b0lTT1N0cmluZygpfV0gJHttZXNzYWdlfWA7XG5cdFx0Y29uc29sZS5sb2coJ1tvYnNpZGlhbi1kc2hdJywgbGluZSk7XG5cdFx0aWYgKHRoaXMubG9nU3RyZWFtKSB7XG5cdFx0XHR0aGlzLmxvZ1N0cmVhbS53cml0ZShsaW5lICsgJ1xcbicpO1xuXHRcdH1cblx0fVxufVxuIiwgIi8qKlxuICogXHU4QkJFXHU3RjZFXHVGRjFBRHNoU2V0dGluZ3MgXHU2M0E1XHU1M0UzICsgREVGQVVMVF9TRVRUSU5HUyArIERzaFNldHRpbmdUYWJcdUZGMDhcdTAwQTcyLjVcdUZGMDlcdTMwMDJcbiAqIFx1N0VBRiBPYnNpZGlhbiBBUEkgKyBcdTUzOUZcdTc1MUYgRE9NXHVGRjBDXHU2NUUwIFVJIFx1Njg0Nlx1NjdCNlx1MzAwMlxuICovXG5pbXBvcnQgeyBBcHAsIFBsdWdpblNldHRpbmdUYWIsIFNldHRpbmcgfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQgdHlwZSBEc2hQbHVnaW4gZnJvbSAnLi9tYWluJztcblxuZXhwb3J0IGludGVyZmFjZSBEc2hTZXR0aW5ncyB7XG5cdC8qKiBkc2ggd2ViIFx1NzZEMVx1NTQyQ1x1N0FFRlx1NTNFM1x1RkYwQ1x1OUVEOFx1OEJBNCAzMDgwXHVGRjBDXHU4MzAzXHU1NkY0IDEwMjQtNjU1MzUgKi9cblx0cG9ydDogbnVtYmVyO1xuXHQvKiogXHU4MUVBXHU1MkE4XHU2MjU4XHU3QkExIGRzaCB3ZWIgXHU1QjUwXHU4RkRCXHU3QTBCXHVGRjBDXHU5RUQ4XHU4QkE0XHU1RjAwICovXG5cdGF1dG9NYW5hZ2VQcm9jZXNzOiBib29sZWFuO1xuXHQvKiogZHNoIFx1NTNFRlx1NjI2N1x1ODg0Q1x1OERFRlx1NUY4NFx1RkYwOGJpbi5qc1x1RkYwOVx1RkYxQlx1NzU1OVx1N0E3QVx1NjVGNlx1ODFFQVx1NTJBOFx1NjNBMlx1NkQ0Qlx1RkYxQVx1NzNBRlx1NTg4M1x1NTNEOFx1OTFDRiBEU0hfQklOIFx1MjE5MiBQQVRIIFx1NEUyRFx1NzY4NCBkc2ggXHUyMTkyIFx1NUUzOFx1ODlDMVx1NUI4OVx1ODhDNVx1NEY0RFx1N0Y2RSAqL1xuXHRkc2hCaW5QYXRoOiBzdHJpbmc7XG5cdC8qKiBub2RlIFx1NTNFRlx1NjI2N1x1ODg0Q1x1OERFRlx1NUY4NFx1RkYwQ1x1OUVEOFx1OEJBNCBub2RlXHVGRjA4UEFUSCBcdTRFMkRcdTc2ODQgbm9kZVx1RkYwOSAqL1xuXHRub2RlUGF0aDogc3RyaW5nO1xuXHQvKiogXHU4RkRCXHU3QTBCXHU2NUU1XHU1RkQ3XHU0RjREXHU3RjZFXHVGRjBDXHU5RUQ4XHU4QkE0IDx2YXVsdD4vLm9ic2lkaWFuL3BsdWdpbnMvb2JzaWRpYW4tZHNoL2RzaC13ZWIubG9nICovXG5cdGxvZ0ZpbGVQYXRoOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjb25zdCBERUZBVUxUX1NFVFRJTkdTOiBEc2hTZXR0aW5ncyA9IHtcblx0cG9ydDogMzA4MCxcblx0YXV0b01hbmFnZVByb2Nlc3M6IHRydWUsXG5cdGRzaEJpblBhdGg6ICcnLCAvLyBcdTc1NTlcdTdBN0EgXHUyMTkyIFx1NTQyRlx1NTJBOFx1NjVGNlx1ODFFQVx1NTJBOFx1NjNBMlx1NkQ0Qlx1RkYwOFx1ODlDMSBtYWluLnRzIHJlc29sdmVEc2hCaW5QYXRoXHVGRjA5XG5cdG5vZGVQYXRoOiAnbm9kZScsXG5cdGxvZ0ZpbGVQYXRoOiAnJywgLy8gXHU3NTU5XHU3QTdBIFx1MjE5MiBcdTYzRDJcdTRFRjZcdTUyQTBcdThGN0RcdTY1RjZcdTYzMDkgdmF1bHQgXHU4REVGXHU1Rjg0XHU1ODZCXHU1MTQ1XHU5RUQ4XHU4QkE0XHU1MDNDXG59O1xuXG4vKiogXHU3QUVGXHU1M0UzXHU4MzAzXHU1NkY0XHVGRjA4XHUwMEE3Mi41XHVGRjA5ICovXG5leHBvcnQgY29uc3QgUE9SVF9NSU4gPSAxMDI0O1xuZXhwb3J0IGNvbnN0IFBPUlRfTUFYID0gNjU1MzU7XG5cbi8qKiBcdTdBRUZcdTUzRTNcdTk0QjNcdTUyMzZcdTUyMzAgWzEwMjQsIDY1NTM1XSAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNsYW1wUG9ydChwb3J0OiBudW1iZXIpOiBudW1iZXIge1xuXHRpZiAoIU51bWJlci5pc0Zpbml0ZShwb3J0KSkge1xuXHRcdHJldHVybiBERUZBVUxUX1NFVFRJTkdTLnBvcnQ7XG5cdH1cblx0cmV0dXJuIE1hdGgubWluKFBPUlRfTUFYLCBNYXRoLm1heChQT1JUX01JTiwgTWF0aC50cnVuYyhwb3J0KSkpO1xufVxuXG5leHBvcnQgY2xhc3MgRHNoU2V0dGluZ1RhYiBleHRlbmRzIFBsdWdpblNldHRpbmdUYWIge1xuXHRwcml2YXRlIHBsdWdpbjogRHNoUGx1Z2luO1xuXHRwcml2YXRlIGFwcGx5VGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG5cblx0Y29uc3RydWN0b3IoYXBwOiBBcHAsIHBsdWdpbjogRHNoUGx1Z2luKSB7XG5cdFx0c3VwZXIoYXBwLCBwbHVnaW4pO1xuXHRcdHRoaXMucGx1Z2luID0gcGx1Z2luO1xuXHR9XG5cblx0ZGlzcGxheSgpOiB2b2lkIHtcblx0XHRjb25zdCB7IGNvbnRhaW5lckVsIH0gPSB0aGlzO1xuXHRcdGNvbnRhaW5lckVsLmVtcHR5KCk7XG5cblx0XHRuZXcgU2V0dGluZyhjb250YWluZXJFbClcblx0XHRcdC5zZXROYW1lKCdcdTdBRUZcdTUzRTMnKVxuXHRcdFx0LnNldERlc2MoYGRzaCB3ZWIgXHU3NkQxXHU1NDJDXHU3QUVGXHU1M0UzXHVGRjA4XHU4MzAzXHU1NkY0ICR7UE9SVF9NSU59LSR7UE9SVF9NQVh9XHVGRjBDXHU5RUQ4XHU4QkE0IDMwODBcdUZGMDlcdTMwMDJcdTgyRTVcdThCRTVcdTdBRUZcdTUzRTNcdTVERjJcdTY3MDlcdTVCOUVcdTRGOEJcdTU3MjhcdThGRDBcdTg4NENcdUZGMDhcdTU5ODJcdTc1MjhcdTYyMzdcdTYyNEJcdTUyQThcdTU0MkZcdTUyQThcdTc2ODQgZHNoXHVGRjA5XHVGRjBDXHU2M0QyXHU0RUY2XHU0RjFBXHU3NkY0XHU2M0E1XHU1OTBEXHU3NTI4XHVGRjBDXHU0RTBEXHU5MUNEXHU1OTBEXHU1NDJGXHU1MkE4XHUzMDAyYClcblx0XHRcdC5hZGRUZXh0KCh0ZXh0KSA9PlxuXHRcdFx0XHR0ZXh0XG5cdFx0XHRcdFx0LnNldFBsYWNlaG9sZGVyKCczMDgwJylcblx0XHRcdFx0XHQuc2V0VmFsdWUoU3RyaW5nKHRoaXMucGx1Z2luLnNldHRpbmdzLnBvcnQpKVxuXHRcdFx0XHRcdC5vbkNoYW5nZSgodmFsdWUpID0+IHtcblx0XHRcdFx0XHRcdHRoaXMucGx1Z2luLnNldHRpbmdzLnBvcnQgPSBjbGFtcFBvcnQoTnVtYmVyKHZhbHVlKSk7XG5cdFx0XHRcdFx0XHR0aGlzLmRlYm91bmNlQXBwbHkoKTtcblx0XHRcdFx0XHR9KVxuXHRcdFx0KTtcblxuXHRcdG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuXHRcdFx0LnNldE5hbWUoJ1x1ODFFQVx1NTJBOFx1NjI1OFx1N0JBMVx1OEZEQlx1N0EwQicpXG5cdFx0XHQuc2V0RGVzYygnXHU1RjAwXHU1NDJGXHU1NDBFXHU2M0QyXHU0RUY2XHU4MUVBXHU1MkE4IHNwYXduIC8gXHU1OTBEXHU3NTI4IGRzaCB3ZWIgXHU1QjUwXHU4RkRCXHU3QTBCXHVGRjA4XHU5RUQ4XHU4QkE0XHU1RjAwXHU1NDJGXHVGRjA5XHVGRjFCXHU1MTczXHU5NUVEXHU1NDBFXHU5NzAwXHU4OTgxXHU2MjRCXHU1MkE4XHU4RkQwXHU4ODRDIGRzaCB3ZWJcdTMwMDInKVxuXHRcdFx0LmFkZFRvZ2dsZSgodG9nZ2xlKSA9PlxuXHRcdFx0XHR0b2dnbGUuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MuYXV0b01hbmFnZVByb2Nlc3MpLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuXHRcdFx0XHRcdHRoaXMucGx1Z2luLnNldHRpbmdzLmF1dG9NYW5hZ2VQcm9jZXNzID0gdmFsdWU7XG5cdFx0XHRcdFx0YXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG5cdFx0XHRcdFx0dGhpcy5wbHVnaW4uYXBwbHlTZXR0aW5ncygpO1xuXHRcdFx0XHR9KVxuXHRcdFx0KTtcblxuXHRcdG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuXHRcdFx0LnNldE5hbWUoJ2RzaCBcdTUzRUZcdTYyNjdcdTg4NENcdThERUZcdTVGODQnKVxuXHRcdFx0LnNldERlc2MoJ2RzaCB3ZWIgXHU3Njg0IGJpbi5qcyBcdThERUZcdTVGODRcdUZGMENcdTlFRDhcdThCQTQgRDovZGVlcHNlZWstaGFybmVzcy9hcHBzL2NsaS9saWIvYmluLmpzJylcblx0XHRcdC5hZGRUZXh0KCh0ZXh0KSA9PlxuXHRcdFx0XHR0ZXh0XG5cdFx0XHRcdFx0LnNldFBsYWNlaG9sZGVyKCdEOi9kZWVwc2Vlay1oYXJuZXNzL2FwcHMvY2xpL2xpYi9iaW4uanMnKVxuXHRcdFx0XHRcdC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5kc2hCaW5QYXRoKVxuXHRcdFx0XHRcdC5vbkNoYW5nZSgodmFsdWUpID0+IHtcblx0XHRcdFx0XHRcdHRoaXMucGx1Z2luLnNldHRpbmdzLmRzaEJpblBhdGggPSB2YWx1ZS50cmltKCkgfHwgREVGQVVMVF9TRVRUSU5HUy5kc2hCaW5QYXRoO1xuXHRcdFx0XHRcdFx0dGhpcy5kZWJvdW5jZUFwcGx5KCk7XG5cdFx0XHRcdFx0fSlcblx0XHRcdCk7XG5cblx0XHRuZXcgU2V0dGluZyhjb250YWluZXJFbClcblx0XHRcdC5zZXROYW1lKCdub2RlIFx1NTNFRlx1NjI2N1x1ODg0Q1x1OERFRlx1NUY4NCcpXG5cdFx0XHQuc2V0RGVzYygnXHU1NDJGXHU1MkE4IGRzaCB3ZWIgXHU0RjdGXHU3NTI4XHU3Njg0IG5vZGUgXHU1NDdEXHU0RUU0XHVGRjBDXHU5RUQ4XHU4QkE0IG5vZGVcdUZGMDhcdTUzNzMgUEFUSCBcdTRFMkRcdTc2ODQgbm9kZVx1RkYwOScpXG5cdFx0XHQuYWRkVGV4dCgodGV4dCkgPT5cblx0XHRcdFx0dGV4dFxuXHRcdFx0XHRcdC5zZXRQbGFjZWhvbGRlcignbm9kZScpXG5cdFx0XHRcdFx0LnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLm5vZGVQYXRoKVxuXHRcdFx0XHRcdC5vbkNoYW5nZSgodmFsdWUpID0+IHtcblx0XHRcdFx0XHRcdHRoaXMucGx1Z2luLnNldHRpbmdzLm5vZGVQYXRoID0gdmFsdWUudHJpbSgpIHx8ICdub2RlJztcblx0XHRcdFx0XHRcdHRoaXMuZGVib3VuY2VBcHBseSgpO1xuXHRcdFx0XHRcdH0pXG5cdFx0XHQpO1xuXG5cdFx0bmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG5cdFx0XHQuc2V0TmFtZSgnXHU4RkRCXHU3QTBCXHU2NUU1XHU1RkQ3XHU0RjREXHU3RjZFJylcblx0XHRcdC5zZXREZXNjKCdkc2ggd2ViIFx1NUI1MFx1OEZEQlx1N0EwQiBzdGRvdXQvc3RkZXJyIFx1NzY4NFx1NjVFNVx1NUZEN1x1NjU4N1x1NEVGNlx1OERFRlx1NUY4NFx1RkYwOFx1OEZGRFx1NTJBMFx1NTE5OVx1NTE2NVx1RkYwQ1x1NUUyNlx1NjVGNlx1OTVGNFx1NjIzM1x1RkYwOScpXG5cdFx0XHQuYWRkVGV4dCgodGV4dCkgPT5cblx0XHRcdFx0dGV4dFxuXHRcdFx0XHRcdC5zZXRQbGFjZWhvbGRlcignLm9ic2lkaWFuL3BsdWdpbnMvb2JzaWRpYW4tZHNoL2RzaC13ZWIubG9nJylcblx0XHRcdFx0XHQuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MubG9nRmlsZVBhdGgpXG5cdFx0XHRcdFx0Lm9uQ2hhbmdlKCh2YWx1ZSkgPT4ge1xuXHRcdFx0XHRcdFx0dGhpcy5wbHVnaW4uc2V0dGluZ3MubG9nRmlsZVBhdGggPSB2YWx1ZS50cmltKCk7XG5cdFx0XHRcdFx0XHR0aGlzLmRlYm91bmNlQXBwbHkoKTtcblx0XHRcdFx0XHR9KVxuXHRcdFx0KTtcblx0fVxuXG5cdC8qKiBcdTY1ODdcdTY3MkNcdThGOTNcdTUxNjVcdTk2MzJcdTYyOTZcdUZGMDhcdTdBRUZcdTUzRTMvXHU4REVGXHU1Rjg0XHU5MDEwXHU1QjU3XHU3QjI2IG9uQ2hhbmdlXHVGRjBDNDAwbXMgXHU1NDBFXHU1MThEXHU0RkREXHU1QjU4XHU0RTBFXHU1RTk0XHU3NTI4XHVGRjBDXHU5MDdGXHU1MTREXHU1M0NEXHU1OTBEXHU1MDVDXHU1NDJGXHU4RkRCXHU3QTBCXHVGRjA5ICovXG5cdHByaXZhdGUgZGVib3VuY2VBcHBseSgpOiB2b2lkIHtcblx0XHRpZiAodGhpcy5hcHBseVRpbWVyKSB7XG5cdFx0XHRjbGVhclRpbWVvdXQodGhpcy5hcHBseVRpbWVyKTtcblx0XHR9XG5cdFx0dGhpcy5hcHBseVRpbWVyID0gc2V0VGltZW91dChhc3luYyAoKSA9PiB7XG5cdFx0XHR0aGlzLmFwcGx5VGltZXIgPSBudWxsO1xuXHRcdFx0YXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG5cdFx0XHR0aGlzLnBsdWdpbi5hcHBseVNldHRpbmdzKCk7XG5cdFx0fSwgNDAwKTtcblx0fVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIjs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7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Q1I7QUFBQSxNQUNELFFBQVE7QUFBQSxNQUVSO0FBQUEsSUFDRDtBQUNBLFdBQU87QUFBQSxFQUNSO0FBQUE7QUFBQSxFQUlBLFVBQTBCO0FBQ3pCLFVBQU0sU0FBUyxLQUFLLElBQUksVUFBVSxnQkFBZ0IsYUFBYTtBQUMvRCxXQUFPLE9BQU8sU0FBUyxJQUFLLE9BQU8sQ0FBQyxFQUFFLE9BQW1CO0FBQUEsRUFDMUQ7QUFBQTtBQUFBLEVBR0EsYUFBbUI7QUFDbEIsVUFBTSxXQUFXLEtBQUssSUFBSSxVQUFVLGdCQUFnQixhQUFhO0FBQ2pFLFFBQUksU0FBUyxTQUFTLEdBQUc7QUFDeEIsZUFBUyxDQUFDLEVBQUUsT0FBTztBQUNuQjtBQUFBLElBQ0Q7QUFDQSxTQUFLLFNBQVM7QUFBQSxFQUNmO0FBQUE7QUFBQSxFQUdBLE1BQU0sV0FBMEI7QUFDL0IsVUFBTSxXQUFXLEtBQUssSUFBSSxVQUFVLGdCQUFnQixhQUFhO0FBQ2pFLFFBQUksU0FBUyxTQUFTLEdBQUc7QUFDeEIsV0FBSyxJQUFJLFVBQVUsV0FBVyxTQUFTLENBQUMsQ0FBQztBQUN6QztBQUFBLElBQ0Q7QUFFQSxVQUFNLE9BQU8sS0FBSyxJQUFJLFVBQVUsYUFBYSxLQUFLLEtBQUssS0FBSyxJQUFJLFVBQVUsUUFBUSxLQUFLO0FBQ3ZGLFVBQU0sS0FBSyxhQUFhLEVBQUUsTUFBTSxlQUFlLFFBQVEsS0FBSyxDQUFDO0FBQzdELFNBQUssSUFBSSxVQUFVLFdBQVcsSUFBSTtBQUFBLEVBQ25DO0FBQUE7QUFBQSxFQUlRLGtCQUF3QjtBQUMvQixVQUFNLEtBQUssS0FBSztBQUNoQixRQUFJLENBQUM7QUFBSTtBQUNULFVBQU0sVUFBVSxLQUFLO0FBQ3JCLFFBQUksQ0FBQyxTQUFTO0FBQ2IsU0FBRyxRQUFRLGdDQUFZO0FBQ3ZCLFNBQUcsUUFBUTtBQUNYO0FBQUEsSUFDRDtBQUNBLFVBQU0sS0FBSyxRQUFRLFNBQVM7QUFDNUIsVUFBTSxPQUFPLFFBQVEsUUFBUTtBQUM3QixZQUFRLElBQUk7QUFBQSxNQUNYLEtBQUs7QUFDSixXQUFHLFFBQVEsbUNBQWUsSUFBSSxFQUFFO0FBQ2hDLFdBQUcsUUFBUSxRQUFRLFdBQVcsSUFBSSwwR0FBMEI7QUFDNUQ7QUFBQSxNQUNELEtBQUs7QUFDSixXQUFHLFFBQVEsbUNBQWUsSUFBSSxFQUFFO0FBQ2hDLFdBQUcsUUFBUTtBQUNYO0FBQUEsTUFDRCxLQUFLO0FBQ0osV0FBRyxRQUFRLDBCQUFXO0FBQ3RCLFdBQUcsUUFBUSxRQUFRLGVBQWUsS0FBSztBQUN2QztBQUFBLE1BQ0Q7QUFDQyxXQUFHLFFBQVEsZ0NBQVk7QUFDdkIsV0FBRyxRQUFRO0FBQUEsSUFDYjtBQUFBLEVBQ0Q7QUFDRDsiLAogICJuYW1lcyI6IFsiaW1wb3J0X29ic2lkaWFuIiwgInBhdGgiLCAicmVzb2x2ZSIsICJpbXBvcnRfb2JzaWRpYW4iXQp9Cg==
