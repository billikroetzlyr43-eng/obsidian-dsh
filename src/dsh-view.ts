/**
 * DshView —— ItemView：iframe 全尺寸嵌入 dsh Web UI（§2.2 / §3.3）。
 *  - iframe 不设 sandbox（dsh UI 需要完整权限），allow 允许复制粘贴
 *  - 连接态：iframe load → 隐藏 loading；error 事件或健康检查失败 → 错误面板（原因 + 重试 + 端口/日志信息）
 *  - 重试：重新健康检查 → 通过则 reload iframe；未通过则提示并附日志路径
 */
import { ItemView, WorkspaceLeaf } from 'obsidian';
import type DshPlugin from './main';
import { probePort, decidePortAction } from './process-manager';

export const VIEW_TYPE_DSH = 'obsidian-dsh-view';

export class DshView extends ItemView {
	private plugin: DshPlugin;
	private iframeEl: HTMLIFrameElement | null = null;
	private loadingEl: HTMLElement | null = null;
	private errorEl: HTMLElement | null = null;
	private errorDetailEl: HTMLElement | null = null;
	private errorMetaEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: DshPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_DSH;
	}

	getDisplayText(): string {
		return 'DSH';
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
		this.contentEl.empty();
	}

	/** 重建 DOM：loading + iframe + 错误面板（全尺寸填充） */
	private buildDom(): void {
		this.contentEl.empty();

		const container = this.contentEl.createDiv({ cls: 'dsh-view-container' });

		this.loadingEl = container.createDiv({ cls: 'dsh-view-loading', text: '正在连接 dsh…' });

		this.iframeEl = container.createEl('iframe', { cls: 'dsh-view-iframe' });
		// sandbox 不设（dsh UI 需要完整权限）；allow 放开剪贴板读写
		this.iframeEl.setAttribute('allow', 'clipboard-write; clipboard-read');
		this.iframeEl.addEventListener('load', () => this.onIframeLoaded());
		this.iframeEl.addEventListener('error', () => this.onIframeError());

		this.errorEl = container.createDiv({ cls: 'dsh-view-error' });
		this.errorEl.style.display = 'none';
		this.errorEl.createDiv({ cls: 'dsh-view-error-title', text: '无法连接 dsh' });
		this.errorDetailEl = this.errorEl.createDiv({ cls: 'dsh-view-error-detail' });
		this.errorMetaEl = this.errorEl.createDiv({ cls: 'dsh-view-error-meta' });
		const retryBtn = this.errorEl.createEl('button', { cls: 'mod-cta', text: '重试' });
		retryBtn.addEventListener('click', () => this.refresh());
	}

	/**
	 * 刷新视图连接：确保进程（自动托管时）→ 健康检查 → 加载 iframe / 显示错误面板。
	 * 重试按钮也调用本方法。
	 */
	async refresh(): Promise<void> {
		const port = this.plugin.settings.port;
		this.showLoading();

		// 自动托管：先确保进程（预检 → 复用/spawn/报错）
		if (this.plugin.settings.autoManageProcess) {
			const manager = this.plugin.getManager();
			if (!manager) {
				this.showError('进程托管未初始化', '自动托管已开启但托管器未初始化，请到设置里切换后重试。');
				return;
			}
			await manager.ensureRunning();
			const st = manager.getState();
			if (st === 'error') {
				this.showError('dsh 启动失败', manager.getErrorReason() ?? '未知错误');
				return;
			}
			if (st !== 'running') {
				this.showError('dsh 未就绪', `当前状态：${st}，请稍后点击重试。`);
				return;
			}
		}

		// 健康检查（关闭自动托管时也做一次，用于给出明确错误信息）
		const health = await probePort(port);
		const action = decidePortAction(health);
		if (action.action === 'reuse') {
			this.loadIframe(port);
		} else if (action.action === 'error') {
			this.showError('端口被其他程序占用', `${action.reason}\n请到插件设置中更换端口。`);
		} else {
			this.showError(
				'无法连接 dsh',
				'dsh web 未在运行。若已关闭“自动托管进程”，请手动运行：\nnode <dshBin> web --port <端口>'
			);
		}
	}

	// ---------- 展示状态 ----------

	private showLoading(): void {
		if (this.loadingEl) this.loadingEl.style.display = '';
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
			this.errorMetaEl.textContent = `端口：${this.plugin.settings.port} ｜ 日志：${this.plugin.resolveLogPath()}`;
		}
	}

	// ---------- iframe 加载 ----------

	/** 健康检查通过后加载/重载 iframe */
	private loadIframe(port: number): void {
		if (!this.iframeEl) return;
		const url = `http://127.0.0.1:${port}/`;
		// 重新赋值 src 会触发 reload（重试场景）
		this.iframeEl.src = url;
	}

	private onIframeLoaded(): void {
		// dsh 页面加载完成 → 隐藏 loading
		this.showIframe();
	}

	private onIframeError(): void {
		this.showError(
			'页面加载失败',
			`无法加载 ${this.iframeEl?.src ?? ''}\n请确认 dsh 服务可访问，或点击重试。`
		);
	}
}
