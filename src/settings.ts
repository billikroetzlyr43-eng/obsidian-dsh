/**
 * 设置：DshSettings 接口 + DEFAULT_SETTINGS + DshSettingTab（§2.5）。
 * 纯 Obsidian API + 原生 DOM，无 UI 框架。
 */
import { App, PluginSettingTab, Setting } from 'obsidian';
import type DshPlugin from './main';

export interface DshSettings {
	/** dsh web 监听端口，默认 3080，范围 1024-65535 */
	port: number;
	/** 自动托管 dsh web 子进程，默认开 */
	autoManageProcess: boolean;
	/** dsh 可执行路径（bin.js）；留空时自动探测：环境变量 DSH_BIN → PATH 中的 dsh → 常见安装位置 */
	dshBinPath: string;
	/** node 可执行路径，默认 node（PATH 中的 node） */
	nodePath: string;
	/** 进程日志位置，默认 <vault>/.obsidian/plugins/obsidian-dsh/dsh-web.log */
	logFilePath: string;
}

export const DEFAULT_SETTINGS: DshSettings = {
	port: 3080,
	autoManageProcess: true,
	dshBinPath: '', // 留空 → 启动时自动探测（见 main.ts resolveDshBinPath）
	nodePath: 'node',
	logFilePath: '', // 留空 → 插件加载时按 vault 路径填充默认值
};

/** 端口范围（§2.5） */
export const PORT_MIN = 1024;
export const PORT_MAX = 65535;

/** 端口钳制到 [1024, 65535] */
export function clampPort(port: number): number {
	if (!Number.isFinite(port)) {
		return DEFAULT_SETTINGS.port;
	}
	return Math.min(PORT_MAX, Math.max(PORT_MIN, Math.trunc(port)));
}

export class DshSettingTab extends PluginSettingTab {
	private plugin: DshPlugin;
	private applyTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(app: App, plugin: DshPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('端口')
			.setDesc(`dsh web 监听端口（范围 ${PORT_MIN}-${PORT_MAX}，默认 3080）。若该端口已有实例在运行（如用户手动启动的 dsh），插件会直接复用，不重复启动。`)
			.addText((text) =>
				text
					.setPlaceholder('3080')
					.setValue(String(this.plugin.settings.port))
					.onChange((value) => {
						this.plugin.settings.port = clampPort(Number(value));
						this.debounceApply();
					})
			);

		new Setting(containerEl)
			.setName('自动托管进程')
			.setDesc('开启后插件自动 spawn / 复用 dsh web 子进程（默认开启）；关闭后需要手动运行 dsh web。')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoManageProcess).onChange(async (value) => {
					this.plugin.settings.autoManageProcess = value;
					await this.plugin.saveSettings();
					this.plugin.applySettings();
				})
			);

		new Setting(containerEl)
			.setName('dsh 可执行路径')
			.setDesc('dsh web 的 bin.js 路径，默认 D:/deepseek-harness/apps/cli/lib/bin.js')
			.addText((text) =>
				text
					.setPlaceholder('D:/deepseek-harness/apps/cli/lib/bin.js')
					.setValue(this.plugin.settings.dshBinPath)
					.onChange((value) => {
						this.plugin.settings.dshBinPath = value.trim() || DEFAULT_SETTINGS.dshBinPath;
						this.debounceApply();
					})
			);

		new Setting(containerEl)
			.setName('node 可执行路径')
			.setDesc('启动 dsh web 使用的 node 命令，默认 node（即 PATH 中的 node）')
			.addText((text) =>
				text
					.setPlaceholder('node')
					.setValue(this.plugin.settings.nodePath)
					.onChange((value) => {
						this.plugin.settings.nodePath = value.trim() || 'node';
						this.debounceApply();
					})
			);

		new Setting(containerEl)
			.setName('进程日志位置')
			.setDesc('dsh web 子进程 stdout/stderr 的日志文件路径（追加写入，带时间戳）')
			.addText((text) =>
				text
					.setPlaceholder('.obsidian/plugins/obsidian-dsh/dsh-web.log')
					.setValue(this.plugin.settings.logFilePath)
					.onChange((value) => {
						this.plugin.settings.logFilePath = value.trim();
						this.debounceApply();
					})
			);
	}

	/** 文本输入防抖（端口/路径逐字符 onChange，400ms 后再保存与应用，避免反复停启进程） */
	private debounceApply(): void {
		if (this.applyTimer) {
			clearTimeout(this.applyTimer);
		}
		this.applyTimer = setTimeout(async () => {
			this.applyTimer = null;
			await this.plugin.saveSettings();
			this.plugin.applySettings();
		}, 400);
	}
}
