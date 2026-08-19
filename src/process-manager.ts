/**
 * DshProcessManager —— dsh web 子进程托管器（核心模块，§3.2）。
 *
 * 职责：
 *  - 端口预检：启动前先探测目标端口，按端口策略（§4）决策：复用外部实例 / 空闲则 spawn / 被占用则报错
 *  - 子进程托管：spawn `node <dshBin> web --port <port>`，cwd 取 dsh 项目根（由 dshBin 路径推导）
 *  - 健康检查：starting 期间每 800ms 探测 http://127.0.0.1:<port>/，最多 60s
 *  - 日志：子进程 stdout/stderr 追加写入日志文件（append 模式，带时间戳）
 *  - kill：只 kill 自己 spawn 的进程（external=false）；Windows 用 taskkill /T /F 兜底清掉孙子进程
 *  - 事件：'status-changed' 回调，驱动状态栏与视图更新
 *
 * 状态机：'stopped' | 'starting' | 'running' | 'error'
 *
 * 注意：本文件同时被 Node 单测（node --test）与 Obsidian 运行时加载，
 * 只用可擦除 TypeScript 语法（无 enum、无构造器参数属性），且不依赖浏览器 fetch（用 Node http 探测，无 CORS 问题）。
 */
import { spawn, type ChildProcess } from 'child_process';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

/** 引擎标识（dsh / opencode） */
export type Engine = 'dsh' | 'opencode';

/** 进程状态机 */
export type DshProcessState = 'stopped' | 'starting' | 'running' | 'error';

/** 端口健康检查结果（decidePortAction 的输入，§3.4） */
export type PortHealth =
	| { kind: 'http-response'; status: number }              // 端口上有 HTTP 服务在响应
	| { kind: 'network-error'; code: string; message?: string } // 网络层错误（ECONNREFUSED 等）
	| { kind: 'other-error'; message: string };              // 其他异常（超时等）

/** 端口决策结果（§4 端口策略） */
export type PortAction =
	| { action: 'reuse'; external: true }                        // 已有实例在跑 → 直接复用，不 spawn、不 kill
	| { action: 'spawn'; external: false; warn?: string }        // 空闲 → spawn 新进程（warn 为告警信息）
	| { action: 'error'; reason: string };                       // 端口被其他程序占用 → 报错提示换端口

/**
 * 端口策略纯函数（§3.2 端口预检 / §4 明确规则，防呆）：
 *  - HTTP 2xx 响应 → 已有实例（可能是用户手动启动的 dsh）→ 复用（external=true，不 spawn、不 kill）
 *  - HTTP 非 2xx 响应（如 403/404）→ 端口被其他程序占用 → 报错提示换端口，不强行 spawn
 *  - ECONNREFUSED 等网络错误 → 空闲 → spawn
 *  - 其他异常（超时等）→ 视为空闲但告警日志 → 尝试 spawn
 */
export function decidePortAction(health: PortHealth): PortAction {
	switch (health.kind) {
		case 'http-response':
			if (health.status >= 200 && health.status < 300) {
				return { action: 'reuse', external: true };
			}
			return {
				action: 'error',
				reason: `端口已有 HTTP 服务在响应（状态码 ${health.status}），但非正常 2xx，疑似被其他程序占用，请更换端口。`,
			};
		case 'network-error':
			if (health.code === 'ECONNREFUSED') {
				// 连接被拒 → 空闲 → spawn
				return { action: 'spawn', external: false };
			}
			return {
				action: 'spawn',
				external: false,
				warn: `端口探测网络错误（${health.code}），按空闲处理并尝试启动。`,
			};
		case 'other-error':
			return {
				action: 'spawn',
				external: false,
				warn: `端口探测异常（${health.message}），按空闲处理并尝试启动。`,
			};
	}
}

/**
 * 由 dshBin 路径推导 dsh 项目根（子进程 cwd）。
 * bin.js 固定位于 <项目根>/apps/cli/lib/bin.js，从其所在目录上溯 3 级即为项目根。
 * 例：D:/deepseek-harness/apps/cli/lib/bin.js → D:\deepseek-harness
 */
export function deriveDshCwd(dshBin: string): string {
	return path.resolve(path.dirname(dshBin), '..', '..', '..');
}

/**
 * 探测 http://127.0.0.1:<port>/，返回结构化 PortHealth。
 * 用 Node http（而非 fetch）：Obsidian 渲染进程里 fetch 有 CORS 限制，http 模块无此问题，且单测在纯 Node 下同样可用。
 *  - 有 HTTP 响应 → http-response（含状态码）
 *  - 网络错误（ECONNREFUSED 等）→ network-error
 *  - 其他异常（超时等）→ other-error
 */
export function probePort(port: number, timeoutMs = 3000): Promise<PortHealth> {
	return new Promise((resolve) => {
		const req = http.get(
			{
				host: '127.0.0.1',
				port,
				path: '/',
				headers: { Host: `127.0.0.1:${port}` },
				timeout: timeoutMs,
			},
			(res) => {
				// 消费响应体，避免连接挂起
				res.resume();
				resolve({ kind: 'http-response', status: res.statusCode ?? 0 });
			}
		);
		req.on('timeout', () => {
			// 超时 → other-error（§4：视为空闲但告警，尝试 spawn）
			req.destroy(new Error(`请求超时（${timeoutMs}ms）`));
		});
		req.on('error', (err: Error & { code?: string }) => {
			if (err.code) {
				resolve({ kind: 'network-error', code: err.code, message: err.message });
			} else {
				resolve({ kind: 'other-error', message: err.message });
			}
		});
	});
}

/** 进程托管配置（§2.2 泛化：engine + 按引擎字段；nodePath 仅 dsh 用） */
export interface DshProcessConfig {
	engine: Engine;                 // 当前引擎
	nodePath?: string;              // node 可执行路径（仅 dsh），默认 'node'
	dshBinPath?: string;            // dsh web bin 路径（仅 dsh）
	opencodeBinPath?: string;       // opencode 可执行路径（仅 opencode）
	port: number;                   // 监听端口
	logFile: string;                // 日志文件路径
	cwd?: string;                   // 工作目录（opencode 用：cfg.cwd）
}

/** buildSpawnArgs 的入参：统一以 binPath 表达可执行/脚本路径 */
export interface SpawnConfig {
	engine: Engine;
	binPath: string;
	nodePath?: string;
	port: number;
	cwd?: string;
}

/**
 * 按引擎组装 spawn 命令（纯函数，便于单测，§2.2）：
 *  - dsh：`node <bin> web --port <p>`，cwd 由 bin 路径推导（deriveDshCwd）
 *  - opencode：`<bin> serve --port <p>`，cwd 取配置的工作目录
 */
export function buildSpawnArgs(
	engine: Engine,
	cfg: SpawnConfig
): { command: string; args: string[]; cwd: string } {
	if (engine === 'opencode') {
		return {
			command: cfg.binPath,
			args: ['serve', '--port', String(cfg.port)],
			cwd: cfg.cwd || '',
		};
	}
	// dsh
	return {
		command: cfg.nodePath || 'node',
		args: [cfg.binPath, 'web', '--port', String(cfg.port)],
		cwd: deriveDshCwd(cfg.binPath),
	};
}

/** opencode 工作目录的简单归一（目录存在性检查放 startChild 里） */
export function deriveOpencodeCwd(cwd?: string): string {
	return (cwd || '').trim();
}

/** 状态信息（状态栏/视图据此更新） */
export interface DshStatusInfo {
	state: DshProcessState;
	port: number;
	external: boolean;  // true = 复用外部实例（绝不 kill）
	reason?: string;    // error 时的原因
}

export type StatusListener = (info: DshStatusInfo) => void;

/** starting 期间健康检查间隔 */
const HEALTH_PROBE_INTERVAL_MS = 800;
/** 健康检查最长等待时间 */
const HEALTH_PROBE_MAX_MS = 60_000;

export class DshProcessManager {
	private cfg: DshProcessConfig;
	private state: DshProcessState = 'stopped';
	private child: ChildProcess | null = null;
	private external = false;
	private errorReason: string | undefined;
	private listeners = new Set<StatusListener>();
	private healthTimer: ReturnType<typeof setInterval> | null = null;
	private logStream: fs.WriteStream | null = null;
	private stopping = false;

	constructor(cfg: DshProcessConfig) {
		// 兼容未显式指定 engine 的老调用（集成单测），默认 dsh
		this.cfg = { ...cfg, engine: cfg.engine ?? 'dsh' };
	}

	// ---------- 只读查询 ----------

	getState(): DshProcessState {
		return this.state;
	}

	getPort(): number {
		return this.cfg.port;
	}

	isExternal(): boolean {
		return this.external;
	}

	getErrorReason(): string | undefined {
		return this.errorReason;
	}

	// ---------- 事件 ----------

	/** 注册状态变更监听，返回取消函数 */
	onStatusChanged(listener: StatusListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emit(): void {
		const info: DshStatusInfo = {
			state: this.state,
			port: this.cfg.port,
			external: this.external,
			reason: this.errorReason,
		};
		this.listeners.forEach((l) => l(info));
	}

	private setState(state: DshProcessState, reason?: string): void {
		this.state = state;
		if (reason !== undefined) {
			this.errorReason = reason;
		}
		this.log(`状态变更 → ${state}${reason ? `（${reason}）` : ''}`);
		this.emit();
	}

	// ---------- 端口预检 → 决策 → 执行 ----------

	/**
	 * 确保 dsh 可用：端口预检 → decidePortAction 决策（复用/spawn/报错）→ 执行。
	 * 已在 running / starting 时直接返回；error / stopped 状态会重新走一遍预检（支持重试）。
	 */
	async ensureRunning(): Promise<void> {
		if (this.state === 'running' || this.state === 'starting') {
			return;
		}
		this.stopping = false;
		this.log(`端口预检开始：http://127.0.0.1:${this.cfg.port}/`);
		const health = await probePort(this.cfg.port);
		const action = decidePortAction(health);
		this.log(`端口预检结果：action=${action.action}`);

		switch (action.action) {
			case 'reuse':
				// 已有实例在跑（可能是用户手动启动的 dsh）→ 直接复用，不 spawn、不 kill
				this.external = true;
				this.child = null;
				this.setState('running', `复用已有实例（端口 ${this.cfg.port}）`);
				return;
			case 'error':
				// 端口被其他程序占用 → 报错提示换端口
				this.external = false;
				this.setState('error', action.reason);
				return;
			case 'spawn':
				this.external = false;
				if (action.warn) {
					this.log(`[告警] ${action.warn}`);
				}
				await this.startChild();
				return;
		}
	}

	// ---------- spawn + 健康检查 ----------

	/** spawn 子进程并进入 starting 态，随后开始健康检查循环（§2.2 用 buildSpawnArgs 组装命令） */
	private async startChild(): Promise<void> {
		const { engine } = this.cfg;

		// 按引擎解析可执行/脚本路径
		const binPath = engine === 'opencode' ? this.cfg.opencodeBinPath ?? '' : this.cfg.dshBinPath ?? '';

		if (!binPath) {
			this.setState(
				'error',
				engine === 'opencode'
					? '未配置 opencode 可执行路径：请在插件设置中填写 opencode 的 exe 路径，或设置环境变量 OPENCODE_BIN。'
					: '未配置 dsh 可执行路径：请在插件设置中填写 dsh 的 bin.js 路径，或设置环境变量 DSH_BIN。'
			);
			return;
		}

		const { command, args, cwd } = buildSpawnArgs(engine, {
			engine,
			binPath,
			nodePath: this.cfg.nodePath,
			port: this.cfg.port,
			cwd: this.cfg.cwd,
		});

		if (!cwd || !fs.existsSync(cwd)) {
			this.setState(
				'error',
				engine === 'opencode'
					? `opencode 工作目录不存在：${cwd || '(空)'}，请检查“OpenCode 工作目录”设置。`
					: `dsh 项目根目录不存在：${cwd}，请检查“dsh 可执行路径”设置。`
			);
			return;
		}

		this.openLog();
		this.log(`spawn：${command} ${args.join(' ')}（cwd=${cwd}）`);
		this.setState('starting');

		let child: ChildProcess;
		try {
			// detached: false —— 进程随插件（Obsidian）生命周期管理，不脱离进程组
			child = spawn(command, args, {
				cwd,
				detached: false,
				windowsHide: true,
			});
		} catch (err) {
			this.setState('error', `启动 ${engine} 进程失败：${(err as Error)?.message ?? String(err)}`);
			return;
		}
		this.child = child;

		// 日志：stdout/stderr 追加写入日志文件，带时间戳
		child.stdout?.on('data', (chunk: Buffer) => {
			this.log(`[stdout] ${chunk.toString()}`);
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			this.log(`[stderr] ${chunk.toString()}`);
		});

		child.on('error', (err) => {
			// 二进制无法启动（nodePath 错误等）
			this.log(`子进程 error 事件：${err.message}`);
			this.child = null;
			this.stopHealthCheck();
			this.setState('error', `启动 ${engine} 进程失败：${err.message}`);
		});

		child.on('exit', (code, signal) => {
			this.log(`子进程退出 code=${code} signal=${signal}`);
			this.child = null;
			this.stopHealthCheck();
			// stopping 时 state 已是 'stopped'，不覆盖
			if (this.state === 'starting' || this.state === 'running') {
				this.setState('error', `${engine} web 进程退出（code=${code ?? '无'}），请查看日志：${this.cfg.logFile}`);
			}
		});

		this.beginHealthCheck();
	}

	/** starting 期间每 800ms 健康检查，最多 60s；健康即转 running */
	private beginHealthCheck(): void {
		this.stopHealthCheck();
		const start = Date.now();
		this.healthTimer = setInterval(async () => {
			if (this.stopping) {
				return;
			}
			const health = await probePort(this.cfg.port);
			const action = decidePortAction(health);
			if (action.action === 'reuse') {
				// 健康检查通过 → running（自己 spawn 的进程，仍归自己管理）
				this.stopHealthCheck();
				this.external = false;
				this.setState('running', `健康检查通过（端口 ${this.cfg.port}）`);
				return;
			}
			if (Date.now() - start > HEALTH_PROBE_MAX_MS) {
				// 60s 未就绪 → 报错并清理自己 spawn 的进程，避免僵尸进程
				this.stopHealthCheck();
				this.setState(
					'error',
					`${this.cfg.engine} 启动后 ${HEALTH_PROBE_MAX_MS / 1000} 秒内健康检查未通过，请查看日志：${this.cfg.logFile}`
				);
				await this.killOwnChild();
			}
			// 未就绪，继续探测
		}, HEALTH_PROBE_INTERVAL_MS);
	}

	private stopHealthCheck(): void {
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
	async stop(): Promise<void> {
		if (this.stopping) {
			return;
		}
		this.stopping = true;
		this.stopHealthCheck();
		if (this.external) {
			// 外部实例：只清托管状态，绝不 kill 用户手动启动的进程
			this.log('external 实例：仅停止托管状态，不 kill 外部进程');
			this.setState('stopped');
			this.stopping = false;
			return;
		}
		this.setState('stopped');
		await this.killOwnChild();
		this.stopping = false;
	}

	/** kill 自己 spawn 的进程：Windows 下 process.kill 后补 taskkill /T /F 兜底（子进程可能带孙子进程） */
	private async killOwnChild(): Promise<void> {
		const child = this.child;
		this.child = null;
		if (!child || !child.pid) {
			return;
		}
		const pid = child.pid;
		this.log(`kill 自己托管的进程 pid=${pid}`);
		try {
			process.kill(pid);
		} catch (err) {
			this.log(`process.kill 失败（可能已退出）：${(err as Error)?.message ?? String(err)}`);
		}
		if (process.platform === 'win32') {
			// taskkill 兜底：/T 递归杀进程树，/F 强制
			await this.runTaskkill(pid);
		}
	}

	private runTaskkill(pid: number): Promise<void> {
		return new Promise((resolve) => {
			const t = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
			t.on('error', () => resolve());
			t.on('exit', () => resolve());
			t.on('close', () => resolve());
		});
	}

	// ---------- 配置与生命周期 ----------

	/**
	 * 设置变更时更新配置。若自己托管的子进程端口与新的不一致 → 停掉自己的旧进程
	 * （外部实例不动），等待下次 ensureRunning 在新端口上重新拉起。
	 */
	async updateConfig(cfg: Partial<DshProcessConfig>): Promise<void> {
		const oldPort = this.cfg.port;
		const newPort = cfg.port ?? oldPort;
		const ownsChild = !this.external && this.child !== null;
		Object.assign(this.cfg, cfg);
		if (ownsChild && newPort !== oldPort) {
			this.log(`端口由 ${oldPort} 改为 ${newPort}，停止自己托管的旧进程`);
			await this.stop();
		}
	}

	/** 插件卸载时调用：kill 自己 spawn 的进程并关闭日志流 */
	async dispose(): Promise<void> {
		await this.stop();
		this.closeLog();
		this.listeners.clear();
	}

	// ---------- 日志 ----------

	/** 打开日志流（append 模式），目录不存在则创建 */
	private openLog(): void {
		if (this.logStream) {
			return;
		}
		try {
			const dir = path.dirname(this.cfg.logFile);
			fs.mkdirSync(dir, { recursive: true });
			this.logStream = fs.createWriteStream(this.cfg.logFile, { flags: 'a' });
		} catch (err) {
			// 日志写不了不能阻塞主流程，仅控制台告警
			console.error('[obsidian-dsh] 打开日志文件失败:', err);
			this.logStream = null;
		}
	}

	private closeLog(): void {
		if (this.logStream) {
			this.logStream.end();
			this.logStream = null;
		}
	}

	/** 带时间戳追加一行日志（写日志文件 + 控制台） */
	private log(message: string): void {
		const line = `[${new Date().toISOString()}] ${message}`;
		console.log('[obsidian-dsh]', line);
		if (this.logStream) {
			this.logStream.write(line + '\n');
		}
	}
}
