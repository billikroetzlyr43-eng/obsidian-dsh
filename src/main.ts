/**
 * obsidian-dsh 插件入口（v2.0 双引擎：dsh / opencode）。
 *  - ribbon 图标 + 命令“打开 AI Engine”→ 打开 ItemView（右侧 pane）
 *  - 视图内分段切换条 [DSH][OpenCode]，点击切换当前引擎（单活性：切走时停掉托管进程，外部实例不 kill）
 *  - 自动托管当前引擎子进程（配置可开关，默认开）；插件卸载时只 kill 自己 spawn 的
 *  - 状态栏显示当前引擎状态，点击可开关视图
 *
 * 纯 Obsidian API + 原生 DOM，无 UI 框架。
 */
import { Plugin, FileSystemAdapter } from 'obsidian';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { DshView, VIEW_TYPE_DSH } from './dsh-view';
import { DEFAULT_SETTINGS, DshSettings, DshSettingTab, clampPort } from './settings';
import { DshProcessManager, type DshProcessConfig, type Engine } from './process-manager';

/** 引擎显示名映射 */
const ENGINE_NAME: Record<Engine, string> = {
	dsh: 'DSH',
	opencode: 'OpenCode',
};
/** 引擎短名（状态栏用） */
const ENGINE_SHORT: Record<Engine, string> = {
	dsh: 'DSH',
	opencode: 'OC',
};

export default class DshPlugin extends Plugin {
	// 覆盖 obsidian Plugin 基类新增的 settings?: unknown，按官方文档模式声明具体类型并给初始化器
	settings: DshSettings = DEFAULT_SETTINGS;
	private manager: DshProcessManager | null = null;
	private statusBarEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		// ItemView 注册（§2.1）
		this.registerView(VIEW_TYPE_DSH, (leaf) => new DshView(leaf, this));

		// ribbon 图标 + 命令（§2.6 命令改名“打开 AI Engine”）
		this.addRibbonIcon('bot', '打开 AI Engine', () => this.toggleView());
		this.addCommand({ id: 'open-dsh', name: '打开 AI Engine', callback: () => this.toggleView() });

		// 设置页（§2.5）
		this.addSettingTab(new DshSettingTab(this.app, this));

		// 状态栏（§2.4）：显示当前引擎状态，点击开关视图
		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass('dsh-status-bar');
		this.statusBarEl.addEventListener('click', () => this.toggleView());
		this.statusBarEl.title = '点击打开/关闭 AI Engine 视图';

		// 进程托管（默认开）：加载阶段只创建托管器
		if (this.settings.autoManageProcess) {
			this.initManager();
		}
		this.updateStatusBar();
	}

	onunload(): void {
		// 只 kill 自己 spawn 的进程，绝不 kill 用户手动启动的实例（external=true 时 stop 内部会跳过）
		this.manager?.dispose();
		this.manager = null;
	}

	// ---------- 设置 ----------

	async loadSettings(): Promise<void> {
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
		this.settings.port = clampPort(this.settings.port);
		this.settings.opencodePort = clampPort(this.settings.opencodePort);
		if (!this.settings.dshLogFilePath) {
			this.settings.dshLogFilePath = this.defaultLogPath('dsh');
		}
		if (!this.settings.opencodeLogFilePath) {
			this.settings.opencodeLogFilePath = this.defaultLogPath('opencode');
		}
	}

	/** 保存设置到 data.json */
	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** 默认日志路径（§2.4 按引擎隔离）：<vault>/.obsidian/plugins/obsidian-dsh/<engine>-web.log */
	defaultLogPath(engine: Engine): string {
		const adapter = this.app.vault.adapter;
		const base = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : '';
		return path.join(base, '.obsidian', 'plugins', 'obsidian-dsh', `${engine === 'opencode' ? 'opencode' : 'dsh'}-web.log`);
	}

	/** 解析当前（或指定）引擎的日志路径（设置为空时用默认值） */
	resolveLogPath(engine: Engine = this.settings.engine): string {
		return engine === 'opencode'
			? this.settings.opencodeLogFilePath || this.defaultLogPath('opencode')
			: this.settings.dshLogFilePath || this.defaultLogPath('dsh');
	}

	/** 设置保存后调用：同步进程托管配置、状态栏与视图（§2.6） */
	async applySettings(): Promise<void> {
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
	async switchEngine(next: Engine): Promise<void> {
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

	getManager(): DshProcessManager | null {
		return this.manager;
	}

	/** 按当前引擎组装托管配置（§2.6） */
	private buildProcessConfig(engine: Engine): DshProcessConfig {
		if (engine === 'opencode') {
			return {
				engine: 'opencode',
				opencodeBinPath: this.resolveOpencodeBinPath(),
				port: this.settings.opencodePort,
				cwd: this.settings.opencodeCwd,
				logFile: this.resolveLogPath('opencode'),
			};
		}
		return {
			engine: 'dsh',
			dshBinPath: this.resolveDshBinPath(),
			nodePath: this.settings.nodePath,
			port: this.settings.port,
			logFile: this.resolveLogPath('dsh'),
		};
	}

	private initManager(): void {
		this.manager = new DshProcessManager(this.buildProcessConfig(this.settings.engine));
		this.manager.onStatusChanged(() => this.updateStatusBar());
	}

	/**
	 * 解析 dsh bin 路径（发布版不硬编码本机路径，§2.3）：
	 * 1) 设置中保存的值；2) 环境变量 DSH_BIN；3) PATH 中的 `dsh` 命令；
	 * 4) 常见安装位置（含 D:/deepseek-harness 开发目录）；5) 空 → 由 ProcessManager 报错提示。
	 */
	resolveDshBinPath(): string {
		if (this.settings.dshBinPath) {
			return this.settings.dshBinPath;
		}
		const candidates = [
			process.env.DSH_BIN,
			'dsh',
			'D:/deepseek-harness/apps/cli/lib/bin.js',
		].filter((p): p is string => !!p);
		for (const c of candidates) {
			if (c === 'dsh') {
				// 命令名：验证 PATH 中确实可执行才采用，否则继续探测真实路径（8/17 修复，防遮蔽）
				try {
					execSync('dsh --version', { stdio: 'ignore', timeout: 3000 });
					return c;
				} catch {
					continue;
				}
			}
			try {
				if (existsSync(c)) {
					return c;
				}
			} catch {
				// 忽略不可解析路径，继续探测
			}
		}
		return '';
	}

	/**
	 * 解析 opencode bin 路径（§2.3，发布版不硬编码本机用户名）：
	 * 1) 设置值 opencodeBinPath；2) 环境变量 OPENCODE_BIN；3) PATH 中的 `opencode` 命令名；
	 * 4) 常见安装：os.homedir()/AppData/Roaming/npm/node_modules/opencode-ai/bin/opencode.exe；
	 * 5) 空 → 由 ProcessManager 报错提示。
	 */
	resolveOpencodeBinPath(): string {
		if (this.settings.opencodeBinPath) {
			return this.settings.opencodeBinPath;
		}
		// 探测顺序：环境变量 → 常见安装位置的 .exe（spawn 可直接执行）→ PATH 中的 opencode 命令名。
		// ⚠️ PATH 裸命令名排在最后：Windows 下 opencode 常为 npm shim（.cmd/shell），
		// Obsidian 的 spawn 无法直接执行裸命令名，验证可用性通过才会采用。
		const commonExe = path.join(
			os.homedir(),
			'AppData',
			'Roaming',
			'npm',
			'node_modules',
			'opencode-ai',
			'bin',
			'opencode.exe'
		);
		const candidates = [process.env.OPENCODE_BIN, commonExe, 'opencode'].filter((p): p is string => !!p);
		for (const c of candidates) {
			if (c === 'opencode') {
				// 命令名：验证 PATH 中确实可执行才采用，否则继续探测真实路径
				try {
					execSync('opencode --version', { stdio: 'ignore', timeout: 3000 });
					return c;
				} catch {
					continue;
				}
			}
			try {
				if (existsSync(c)) {
					return c;
				}
			} catch {
				// 忽略不可解析路径，继续探测
			}
		}
		return '';
	}

	// ---------- 视图 ----------

	getView(): DshView | null {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_DSH);
		return leaves.length > 0 ? (leaves[0].view as DshView) : null;
	}

	/** 开关视图：已打开则关闭，未打开则打开（状态栏点击语义） */
	toggleView(): void {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_DSH);
		if (existing.length > 0) {
			existing[0].detach();
			return;
		}
		this.openView();
	}

	/** 打开 AI Engine 视图（右侧 pane，§2.1） */
	async openView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_DSH);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		// 右侧 pane；右栏不可用时退回普通标签页
		const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf('tab');
		await leaf.setViewState({ type: VIEW_TYPE_DSH, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	// ---------- 供视图查询的引擎信息 ----------

	getEngine(): Engine {
		return this.settings.engine;
	}

	getEngineName(): string {
		return ENGINE_NAME[this.settings.engine];
	}

	getEngineShort(): string {
		return ENGINE_SHORT[this.settings.engine];
	}

	/** 当前引擎端口 */
	getEnginePort(): number {
		return this.settings.engine === 'opencode' ? this.settings.opencodePort : this.settings.port;
	}

	// ---------- 状态栏 ----------

	private updateStatusBar(): void {
		const el = this.statusBarEl;
		if (!el) return;
		const manager = this.manager;
		if (!manager) {
			el.setText('AI: ○ 未启动');
			el.title = '自动托管已关闭，点击打开 AI Engine 视图';
			return;
		}
		const short = this.getEngineShort();
		const st = manager.getState();
		const port = manager.getPort();
		switch (st) {
			case 'running':
				el.setText(`AI ● ${short} :${port}`);
				el.title = manager.isExternal() ? '复用已有实例（非插件托管，不会 kill）' : `${this.getEngineName()} 运行中`;
				break;
			case 'starting':
				el.setText(`AI ◐ ${short} :${port}`);
				el.title = `正在启动 ${this.getEngineName()}…`;
				break;
			case 'error':
				el.setText(`AI ✗ ${short}`);
				el.title = manager.getErrorReason() ?? `${this.getEngineName()} 启动失败`;
				break;
			default:
				el.setText(`AI ○ ${short}`);
				el.title = '点击打开 AI Engine 视图';
		}
	}
}
