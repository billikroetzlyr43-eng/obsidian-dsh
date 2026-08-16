/**
 * obsidian-dsh 插件入口（§2 功能需求）：
 *  - ribbon 图标 + 命令“打开 DSH”→ 打开 ItemView（右侧 pane）
 *  - 自动托管 dsh web 子进程（配置可开关，默认开）：视图需要且进程不在 → 自动 spawn；插件卸载时只 kill 自己 spawn 的
 *  - 状态栏显示 dsh 状态，点击可开关视图
 *  - 设置页（端口 / 自动托管 / dsh 路径 / node 路径 / 日志位置）
 *
 * 纯 Obsidian API + 原生 DOM，无 UI 框架。
 */
import { Plugin, FileSystemAdapter } from 'obsidian';
import { existsSync } from 'fs';
import * as path from 'path';
import { DshView, VIEW_TYPE_DSH } from './dsh-view';
import { DEFAULT_SETTINGS, DshSettings, DshSettingTab, clampPort } from './settings';
import { DshProcessManager, type DshProcessConfig } from './process-manager';

export default class DshPlugin extends Plugin {
	// 覆盖 obsidian Plugin 基类新增的 settings?: unknown，按官方文档模式声明具体类型并给初始化器
	settings: DshSettings = DEFAULT_SETTINGS;
	private manager: DshProcessManager | null = null;
	private statusBarEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		// ItemView 注册（§2.1）
		this.registerView(VIEW_TYPE_DSH, (leaf) => new DshView(leaf, this));

		// ribbon 图标 + 命令（§2.1）
		this.addRibbonIcon('bot', '打开 DSH', () => this.toggleView());
		this.addCommand({ id: 'open-dsh', name: '打开 DSH', callback: () => this.toggleView() });

		// 设置页（§2.5）
		this.addSettingTab(new DshSettingTab(this.app, this));

		// 状态栏（§2.4）：显示 dsh 状态，点击开关视图
		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass('dsh-status-bar');
		this.statusBarEl.addEventListener('click', () => this.toggleView());
		this.statusBarEl.title = '点击打开/关闭 DSH 视图';

		// 进程托管（默认开）：视图需要时才 spawn，加载阶段只创建托管器
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
		if (!this.settings.logFilePath) {
			this.settings.logFilePath = this.defaultLogPath();
		}
	}

	/** 保存设置到 data.json */
	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** 默认日志路径：<vault>/.obsidian/plugins/obsidian-dsh/dsh-web.log */
	defaultLogPath(): string {
		const adapter = this.app.vault.adapter;
		const base = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : '';
		return path.join(base, '.obsidian', 'plugins', 'obsidian-dsh', 'dsh-web.log');
	}

	/** 解析日志路径（设置为空时用默认值） */
	resolveLogPath(): string {
		return this.settings.logFilePath || this.defaultLogPath();
	}

	/** 设置保存后调用：同步进程托管配置、状态栏与视图 */
	async applySettings(): Promise<void> {
		if (this.settings.autoManageProcess) {
			if (!this.manager) {
				this.initManager();
			} else {
				await this.manager.updateConfig({
					nodePath: this.settings.nodePath,
					dshBinPath: this.settings.dshBinPath,
					port: this.settings.port,
					logFile: this.resolveLogPath(),
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

	getManager(): DshProcessManager | null {
		return this.manager;
	}

	private initManager(): void {
		const config: DshProcessConfig = {
			nodePath: this.settings.nodePath,
			dshBinPath: this.resolveDshBinPath(),
			port: this.settings.port,
			logFile: this.resolveLogPath(),
		};
		this.manager = new DshProcessManager(config);
		this.manager.onStatusChanged(() => this.updateStatusBar());
	}

	/**
	 * 解析 dsh bin 路径（发布版不硬编码本机路径）：
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
				// 命令名：交给 spawn 按 PATH 解析，无法预先验证存在性
				return c;
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

	/** 打开 DSH 视图（右侧 pane，§2.1） */
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

	// ---------- 状态栏 ----------

	private updateStatusBar(): void {
		const el = this.statusBarEl;
		if (!el) return;
		const manager = this.manager;
		if (!manager) {
			el.setText('DSH: ○ 未启动');
			el.title = '自动托管已关闭，点击打开 DSH 视图';
			return;
		}
		const st = manager.getState();
		const port = manager.getPort();
		switch (st) {
			case 'running':
				el.setText(`DSH: ● 运行中 :${port}`);
				el.title = manager.isExternal() ? '复用已有实例（非插件托管，不会 kill）' : 'dsh web 运行中';
				break;
			case 'starting':
				el.setText(`DSH: ◐ 启动中 :${port}`);
				el.title = '正在启动 dsh web…';
				break;
			case 'error':
				el.setText('DSH: ✗ 错误');
				el.title = manager.getErrorReason() ?? 'dsh 启动失败';
				break;
			default:
				el.setText('DSH: ○ 未启动');
				el.title = '点击打开 DSH 视图';
		}
	}
}
