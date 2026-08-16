/**
 * decidePortAction 端口决策单测（§3.4 / §4 端口策略）。
 * 运行：node --test tests/  （Node 24 原生 TS 类型擦除，无需编译）
 *
 * 覆盖：
 *  - HTTP 2xx → 复用（external=true，不 spawn）
 *  - HTTP 非 2xx（403/404 等）→ 报错提示换端口
 *  - ECONNREFUSED → 空闲 → spawn
 *  - 其他网络错误 → spawn + 告警
 *  - 超时等异常 → 视为空闲但告警 → spawn
 *  - deriveDshCwd 推导
 *
 * 另有集成测试（可选，需 DSH_INTEGRATION=1 才会真正 spawn dsh web，见文件末尾）。
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { decidePortAction, deriveDshCwd, probePort, DshProcessManager } from '../src/process-manager.ts';

test('HTTP 200 响应 → 复用已有实例（external=true，不 spawn、不 kill）', () => {
	const action = decidePortAction({ kind: 'http-response', status: 200 });
	assert.deepEqual(action, { action: 'reuse', external: true });
});

test('其它 2xx（如 204）→ 复用', () => {
	const action = decidePortAction({ kind: 'http-response', status: 204 });
	assert.equal(action.action, 'reuse');
	assert.equal(action.external, true);
});

test('HTTP 非 2xx（403）→ 报错提示换端口，不强行 spawn', () => {
	const action = decidePortAction({ kind: 'http-response', status: 403 });
	assert.equal(action.action, 'error');
	assert.match(action.reason, /其他程序占用/);
});

test('HTTP 404 → 同样视为端口被占用 → error', () => {
	const action = decidePortAction({ kind: 'http-response', status: 404 });
	assert.equal(action.action, 'error');
});

test('ECONNREFUSED 网络错误 → 空闲 → spawn', () => {
	const action = decidePortAction({ kind: 'network-error', code: 'ECONNREFUSED' });
	assert.deepEqual(action, { action: 'spawn', external: false });
});

test('非 ECONNREFUSED 网络错误 → spawn 且带告警', () => {
	const action = decidePortAction({ kind: 'network-error', code: 'ENETUNREACH' });
	assert.equal(action.action, 'spawn');
	assert.equal(action.external, false);
	assert.ok(action.warn, '应带告警信息');
});

test('其他异常（超时等）→ 视为空闲但告警日志，尝试 spawn', () => {
	const action = decidePortAction({ kind: 'other-error', message: '请求超时' });
	assert.equal(action.action, 'spawn');
	assert.equal(action.external, false);
	assert.ok(action.warn, '应带告警信息');
});

test('deriveDshCwd 由 bin.js 路径推导 dsh 项目根（子进程 cwd）', () => {
	const cwd = deriveDshCwd('D:/deepseek-harness/apps/cli/lib/bin.js');
	assert.equal(cwd, path.resolve('D:/deepseek-harness'));
});

/**
 * 等待托管器进入期望状态（集成测试用：ensureRunning 是异步 spawn，dsh web 真实启动需数秒~数十秒）。
 */
async function waitForState(manager: DshProcessManager, expected: string, timeoutMs = 65_000): Promise<void> {
	const start = Date.now();
	while (manager.getState() !== expected) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`等待状态 ${expected} 超时（当前 ${manager.getState()}）`);
		}
		await new Promise((r) => setTimeout(r, 500));
	}
}

/**
 * 集成测试（可选）：真正 spawn dsh web → 健康检查通过 → 日志写入 → stop 后进程被 kill。
 * 需要环境变量 DSH_INTEGRATION=1 才会执行（避免污染日常单测），
 * 端口取 3099（§5 验证清单步骤 4 场景），dsh 项目根为 D:/deepseek-harness。
 */
test(
	'集成：spawn dsh web(3099) → 健康检查通过 → 日志写入 → stop 后进程被 kill',
	{ skip: process.env.DSH_INTEGRATION !== '1' },
	async () => {
		const port = 3099;

		// 预检：3099 应空闲（§5.4 端口空闲场景）
		const pre = await probePort(port);
		assert.equal(decidePortAction(pre).action, 'spawn', '3099 应处于空闲状态');

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-dsh-test-'));
		const logFile = path.join(tmpDir, 'dsh-web.log');
		const manager = new DshProcessManager({
			nodePath: 'node',
			dshBinPath: 'D:/deepseek-harness/apps/cli/lib/bin.js',
			port,
			logFile,
		});

		try {
			await manager.ensureRunning();
			// 等待健康检查通过（dsh web 真实启动 10-30s，最多等 65s）
			await waitForState(manager, 'running');
			assert.equal(manager.getState(), 'running', '健康检查通过后应进入 running');
			assert.equal(manager.isExternal(), false, '自己 spawn 的进程 external=false');
			assert.ok(fs.existsSync(logFile), '日志文件应存在');
			assert.ok(fs.readFileSync(logFile, 'utf8').length > 0, '日志文件应有内容');

			await manager.stop();
			assert.equal(manager.getState(), 'stopped', 'stop 后应回到 stopped');

			// 稍等 kill 完成，再确认端口已空闲（进程确实被杀，且只 kill 自己 spawn 的）
			await new Promise((r) => setTimeout(r, 800));
			const post = await probePort(port);
			assert.equal(decidePortAction(post).action, 'spawn', 'stop 后端口应重新空闲（进程已被 kill）');
		} finally {
			await manager.dispose();
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	}
);
