/**
 * 设置：DshSettings 接口 + DEFAULT_SETTINGS + DshSettingTab（§2.1 / §2.5）。
 * v2.0 双引擎：engine 选择 + dsh/opencode 独立配置 + 按引擎拆分的日志路径。
 * 纯 Obsidian API + 原生 DOM，无 UI 框架。
 */
import { App, PluginSettingTab, Setting } from 'obsidian';
import type { Engine } from './process-manager';
import type DshPlugin from './main';

export interface DshSettings {
	/** 当前引擎（记忆上次选择，重启恢复），默认 'dsh' */
	engine: Engine;
	/** 自动托管当前引擎子进程，默认开 */
	autoManageProcess: boolean;

	// ---------- DSH 配置 ----------
	/** dsh 监听端口，默认 3080，范围 1024-65535 */
	port: number;
	/** dsh 可执行路径（bin.js）；留空自动探测：DSH_BIN → PATH 中 dsh → 常见安装位置 */
	dshBinPath: string;
	/** node 可执行路径，默认 node（PATH 中的 node），仅 dsh 用 */
	nodePath: string;
	/** dsh 日志文件，默认 <vault>/.obsidian/plugins/obsidian-dsh/dsh-web.log */
	dshLogFilePath: string;

	// ---------- OpenCode 配置 ----------
	/** opencode 监听端口，默认 3081 */
	opencodePort: number;
	/** opencode 可执行路径（exe）；留空自动探测：OPENCODE_BIN → PATH 中 opencode → 常见安装位置 */
	opencodeBinPath: string;
	/** opencode 工作目录，默认 D:\workspace */
	opencodeCwd: string;
	/** opencode 日志文件，默认 <vault>/.obsidian/plugins/obsidian-dsh/opencode-web.log */
	opencodeLogFilePath: string;
}

export const DEFAULT_SETTINGS: DshSettings = {
	engine: 'dsh',
	autoManageProcess: true,

	port: 3080,
	dshBinPath: '', // 留空 → 启动时自动探测（见 main.ts resolveDshBinPath）
	nodePath: 'node',
	dshLogFilePath: '', // 留空 → 插件加载时按 vault 路径填充默认值

	opencodePort: 3081,
	opencodeBinPath: '', // 留空 → 启动时自动探测（见 main.ts resolveOpencodeBinPath）
	opencodeCwd: 'D:\\workspace',
	opencodeLogFilePath: '', // 留空 → 插件加载时按 vault 路径填充默认值
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

		// ---------- 顶部：默认引擎 + 自动托管 ----------
		new Setting(containerEl)
			.setName('默认引擎')
			.setDesc('选择当前托管/查看的引擎：DSH 或 OpenCode。切换时自动停止上一引擎托管的进程（外部实例不 kill）。')
			.addDropdown((dd) => {
				dd.addOption('dsh', 'DSH');
				dd.addOption('opencode', 'OpenCode');
				dd.setValue(this.plugin.settings.engine);
				dd.onChange(async (value) => {
					// switchEngine 内部会：设置 settings.engine → 保存 → 停旧管理器 → 按新引擎重建 → 刷新视图
					await this.plugin.switchEngine((value as Engine) || 'dsh');
				});
			});

		new Setting(containerEl)
			.setName('自动托管进程')
			.setDesc('开启后插件自动 spawn / 复用当前引擎的子进程（默认开启）；关闭后需要手动运行对应引擎。')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoManageProcess).onChange(async (value) => {
					this.plugin.settings.autoManageProcess = value;
					await this.plugin.saveSettings();
					this.plugin.applySettings();
				})
			);

		// ---------- DSH 配置 ----------
		new Setting(containerEl).setName('DSH 配置').setHeading();

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
			.setName('DSH 日志位置')
			.setDesc('dsh web 子进程 stdout/stderr 的日志文件路径（追加写入，带时间戳）')
			.addText((text) =>
				text
					.setPlaceholder('.obsidian/plugins/obsidian-dsh/dsh-web.log')
					.setValue(this.plugin.settings.dshLogFilePath)
					.onChange((value) => {
						this.plugin.settings.dshLogFilePath = value.trim();
						this.debounceApply();
					})
			);

		// ---------- OpenCode 配置 ----------
		new Setting(containerEl).setName('OpenCode 配置').setHeading();

		new Setting(containerEl)
			.setName('OpenCode 端口')
			.setDesc(`opencode serve 监听端口（默认 3081）。若该端口已有实例在运行，插件会直接复用。`)
			.addText((text) =>
				text
					.setPlaceholder('3081')
					.setValue(String(this.plugin.settings.opencodePort))
					.onChange((value) => {
						this.plugin.settings.opencodePort = clampPort(Number(value));
						this.debounceApply();
					})
			);

		new Setting(containerEl)
			.setName('OpenCode 可执行路径')
			.setDesc('opencode 的 exe 路径；留空自动探测：环境变量 OPENCODE_BIN → PATH 中的 opencode → 常见安装位置')
			.addText((text) =>
				text
					.setPlaceholder('C:/Users/.../opencode-ai/bin/opencode.exe')
					.setValue(this.plugin.settings.opencodeBinPath)
					.onChange((value) => {
						this.plugin.settings.opencodeBinPath = value.trim() || DEFAULT_SETTINGS.opencodeBinPath;
						this.debounceApply();
					})
			);

		new Setting(containerEl)
			.setName('OpenCode 工作目录')
			.setDesc('opencode serve 启动时的工作目录（默认 D:\\workspace）')
			.addText((text) =>
				text
					.setPlaceholder('D:\\workspace')
					.setValue(this.plugin.settings.opencodeCwd)
					.onChange((value) => {
						this.plugin.settings.opencodeCwd = value.trim() || DEFAULT_SETTINGS.opencodeCwd;
						this.debounceApply();
					})
			);

		new Setting(containerEl)
			.setName('OpenCode 日志位置')
			.setDesc('opencode serve 子进程 stdout/stderr 的日志文件路径（追加写入，带时间戳）')
			.addText((text) =>
				text
					.setPlaceholder('.obsidian/plugins/obsidian-dsh/opencode-web.log')
					.setValue(this.plugin.settings.opencodeLogFilePath)
					.onChange((value) => {
						this.plugin.settings.opencodeLogFilePath = value.trim();
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
