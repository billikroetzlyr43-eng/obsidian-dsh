/**
 * DshView —— ItemView：顶部引擎分段切换条 [DSH][OpenCode] + iframe 全尺寸嵌入当前引擎 Web UI（§2.2 / §2.5 / §3.3）。
 *  - 分段切换条：左对齐两个按钮，当前引擎加 .is-active 高亮，按钮内带状态圆点
 *  - iframe 不设 sandbox（Web UI 需要完整权限），allow 允许复制粘贴
 *  - 连接态：iframe load → 隐藏 loading；error 事件或健康检查失败 → 错误面板（原因 + 重试 + 端口/日志信息）
 *  - 重试：重新健康检查 → 通过则 reload iframe；未通过则提示并附日志路径
 */
import { ItemView, WorkspaceLeaf } from 'obsidian';
import type DshPlugin from './main';
import { probePort, decidePortAction, type Engine, type DshStatusInfo } from './process-manager';

export const VIEW_TYPE_DSH = 'obsidian-dsh-view';

const ENGINE_TABS: { engine: Engine; label: string; short: string }[] = [
	{ engine: 'dsh', label: 'DSH', short: 'dsh' },
	{ engine: 'opencode', label: 'OpenCode', short: 'opencode' },
];

export class DshView extends ItemView {
	private plugin: DshPlugin;
	private iframeEl: HTMLIFrameElement | null = null;
	private loadingEl: HTMLElement | null = null;
	private errorEl: HTMLElement | null = null;
	private errorDetailEl: HTMLElement | null = null;
	private errorMetaEl: HTMLElement | null = null;
	private tabEls = new Map<Engine, HTMLElement>();
	private dotEls = new Map<Engine, HTMLElement>();
	private statusUnsub: (() => void) | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: DshPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_DSH;
	}

	getDisplayText(): string {
		return 'AI Engine';
	}

	getIcon(): string {
		return 'bot';
	}

	async onOpen(): Promise<void> {
		// 去掉 view-content 默认内边距，避免白边（配合 styles.css）
		this.contentEl.addClass('dsh-view-content');
		this.buildDom();
		await this.refresh();
	}

	async onClose(): Promise<void> {
		// 解除状态订阅（切换引擎/关闭视图时防止旧 listener 泄漏）
		this.statusUnsub?.();
		this.statusUnsub = null;
		this.contentEl.empty();
	}

	/** 重建 DOM：引擎分段条 + loading + iframe + 错误面板（stage 全尺寸填充） */
	private buildDom(): void {
		this.contentEl.empty();

		const container = this.contentEl.createDiv({ cls: 'dsh-view-container' });

		// 顶部引擎分段切换条（§2.5）
		const tabs = container.createDiv({ cls: 'eng-tabs' });
		for (const t of ENGINE_TABS) {
			const btn = tabs.createEl('button', { cls: 'eng-tab', attr: { 'data-engine': t.engine } });
			const dot = btn.createSpan({ cls: 'eng-dot' });
			btn.createSpan({ cls: 'eng-tab-label', text: t.label });
			btn.addEventListener('click', () => {
				if (t.engine !== this.plugin.getEngine()) {
					this.plugin.switchEngine(t.engine);
				}
			});
			this.tabEls.set(t.engine, btn);
			this.dotEls.set(t.engine, dot);
		}

		// stage：loading + iframe + 错误面板（absolute inset:0，相对 stage 定位）
		const stage = container.createDiv({ cls: 'dsh-view-stage' });

		this.loadingEl = stage.createDiv({ cls: 'dsh-view-loading', text: '正在连接…' });

		this.iframeEl = stage.createEl('iframe', { cls: 'dsh-view-iframe' });
		// sandbox 不设（Web UI 需要完整权限）；allow 放开剪贴板读写
		this.iframeEl.setAttribute('allow', 'clipboard-write; clipboard-read');
		this.iframeEl.addEventListener('load', () => this.onIframeLoaded());
		this.iframeEl.addEventListener('error', () => this.onIframeError());

		this.errorEl = stage.createDiv({ cls: 'dsh-view-error' });
		this.errorEl.style.display = 'none';
		this.errorEl.createDiv({ cls: 'dsh-view-error-title', text: '无法连接' });
		this.errorDetailEl = this.errorEl.createDiv({ cls: 'dsh-view-error-detail' });
		this.errorMetaEl = this.errorEl.createDiv({ cls: 'dsh-view-error-meta' });
		const retryBtn = this.errorEl.createEl('button', { cls: 'mod-cta', text: '重试' });
		retryBtn.addEventListener('click', () => this.refresh());
	}

	/** 刷新切换条：当前引擎高亮 + 状态圆点（当前引擎取 manager 状态，另一引擎置灰） */
	private updateTabs(): void {
		const current = this.plugin.getEngine();
		const manager = this.plugin.getManager();
		const st = manager ? manager.getState() : 'stopped';

		for (const t of ENGINE_TABS) {
			const btn = this.tabEls.get(t.engine);
			if (!btn) continue;
			if (t.engine === current) {
				btn.addClass('is-active');
			} else {
				btn.removeClass('is-active');
			}
			const dot = this.dotEls.get(t.engine);
			if (!dot) continue;
			const dotState = t.engine === current ? st : 'stopped';
			dot.removeClass('eng-dot-running', 'eng-dot-starting', 'eng-dot-error', 'eng-dot-stopped');
			dot.addClass(`eng-dot-${dotState}`);
			dot.setAttribute('title', dotState);
		}
	}

	/**
	 * 刷新视图连接：确保进程（自动托管时）→ 健康检查 → 加载 iframe / 显示错误面板。
	 * 重试按钮也调用本方法。
	 */
	async refresh(): Promise<void> {
		const engine = this.plugin.getEngine();
		const port = this.plugin.getEnginePort();
		const engineName = this.plugin.getEngineName();

		// 解绑旧的状态订阅（防重复绑定）
		this.statusUnsub?.();
		this.statusUnsub = null;

		this.updateTabs();
		this.showLoading(engineName);

		// 自动托管：先确保进程（预检 → 复用/spawn/报错）
		if (this.plugin.settings.autoManageProcess) {
			const manager = this.plugin.getManager();
			if (!manager) {
				this.showError('进程托管未初始化', '自动托管已开启但托管器未初始化，请到设置里切换后重试。');
				this.updateTabs();
				return;
			}
			// 订阅状态：进程 starting→running 时自动加载 iframe，error 时展示错误面板（免手动点重试）
			this.statusUnsub = manager.onStatusChanged((info: DshStatusInfo) => {
				this.updateTabs();
				if (this.plugin.getEngine() !== engine) {
					// 引擎已被切走，忽略旧引擎回调
					return;
				}
				if (info.state === 'running' && info.port === this.plugin.getEnginePort()) {
					this.loadIframe(info.port);
				} else if (info.state === 'starting') {
					this.showLoading(this.plugin.getEngineName());
				} else if (info.state === 'error') {
					this.showError(`${this.plugin.getEngineName()} 启动失败`, info.reason ?? '未知错误');
				}
			});
			await manager.ensureRunning();
			const st = manager.getState();
			this.updateTabs();
			if (st === 'error') {
				this.showError(`${engineName} 启动失败`, manager.getErrorReason() ?? '未知错误');
				return;
			}
			if (st !== 'running') {
				this.showLoaderUntil(engineName);
				return;
			}
		}

		// 健康检查（关闭自动托管时也做一次，用于给出明确错误信息）
		const health = await probePort(port);
		const action = decidePortAction(health);
		if (action.action === 'reuse') {
			this.loadIframe(port);
		} else if (action.action === 'error') {
			this.showError('端口被其他程序占用', `${action.reason}\n请到插件设置中更换${engineName}端口。`);
		} else {
			this.showError(
				'无法连接',
				`${engineName} 未在运行。若已关闭“自动托管进程”，请手动运行：\n${
					engine === 'opencode'
						? `<opencodeBin> serve --port ${port}`
						: `node <dshBin> web --port ${port}`
				}`
			);
		}
	}

	// ---------- 展示状态 ----------

	/** 引擎 starting 期间保持 loading 态，等待状态订阅在 running 时自动加载 iframe */
	private showLoaderUntil(engineName: string): void {
		this.showLoading(engineName);
	}

	private showLoading(engineName: string): void {
		if (this.loadingEl) {
			this.loadingEl.textContent = `正在连接 ${engineName}…`;
			this.loadingEl.style.display = '';
		}
		if (this.iframeEl) this.iframeEl.style.display = 'none';
		if (this.errorEl) this.errorEl.style.display = 'none';
	}

	private showIframe(): void {
		if (this.loadingEl) this.loadingEl.style.display = 'none';
		if (this.iframeEl) this.iframeEl.style.display = '';
		if (this.errorEl) this.errorEl.style.display = 'none';
	}

	private showError(title: string, detail: string): void {
		if (this.loadingEl) this.loadingEl.style.display = 'none';
		if (this.iframeEl) this.iframeEl.style.display = 'none';
		if (this.errorEl) this.errorEl.style.display = '';
		const titleEl = this.errorEl?.querySelector('.dsh-view-error-title');
		if (titleEl) titleEl.textContent = title;
		if (this.errorDetailEl) this.errorDetailEl.textContent = detail;
		if (this.errorMetaEl) {
			this.errorMetaEl.textContent = `引擎：${this.plugin.getEngineName()} ｜ 端口：${this.plugin.getEnginePort()} ｜ 日志：${this.plugin.resolveLogPath()}`;
		}
	}

	// ---------- iframe 加载 ----------

	/** 健康检查通过后加载/重载 iframe（当前引擎端口） */
	private loadIframe(port: number): void {
		if (!this.iframeEl) return;
		const url = `http://127.0.0.1:${port}/`;
		// 重新赋值 src 会触发 reload（重试场景）
		this.iframeEl.src = url;
	}

	private onIframeLoaded(): void {
		// 页面加载完成 → 隐藏 loading
		this.showIframe();
	}

	private onIframeError(): void {
		this.showError(
			'页面加载失败',
			`无法加载 ${this.iframeEl?.src ?? ''}\n请确认引擎服务可访问，或点击重试。`
		);
	}
}
