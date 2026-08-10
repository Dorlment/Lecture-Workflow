import {
	CompanionProcessError,
	type CompanionChildProcess,
	type CompanionLaunchSpec,
	type CompanionProcessExit,
	type CompanionProcessHandle,
	type CompanionProcessScheduler,
	type CompanionSpawnFactory,
	type RuntimeNodeModuleLoader,
} from './companion-process-types';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const FORCED_EXIT_TIMEOUT_MS = 1_000;

interface ActiveProcess {
	child: CompanionChildProcess;
	exit: Promise<CompanionProcessExit>;
	resolveExit(result: CompanionProcessExit): void;
	termination: Promise<void>;
	resolveTermination(): void;
	detach(): void;
	resultSettled: boolean;
	released: boolean;
}

export interface CompanionProcessManagerOptions {
	spawn: CompanionSpawnFactory;
	scheduler?: CompanionProcessScheduler;
	shutdownTimeoutMs?: number;
}

export class CompanionProcessManager {
	private active: ActiveProcess | null = null;
	private readonly scheduler: CompanionProcessScheduler;
	private readonly shutdownTimeoutMs: number;
	private shutdownTask: Promise<void> | null = null;
	private disposed = false;

	constructor(options: CompanionProcessManagerOptions) {
		this.scheduler = options.scheduler ?? browserProcessScheduler();
		this.spawn = options.spawn;
		this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
	}

	private readonly spawn: CompanionSpawnFactory;

	get isRunning(): boolean {
		return this.active !== null;
	}

	async start(spec: CompanionLaunchSpec, token: string): Promise<CompanionProcessHandle> {
		if (this.disposed || this.active) {
			throw new CompanionProcessError('busy');
		}
		assertLaunchSpec(spec, token);

		let child: CompanionChildProcess;
		try {
			child = this.spawn(spec.executable, [...spec.args], {
				...(spec.cwd ? { cwd: spec.cwd } : {}),
				stdio: ['pipe', 'ignore', 'ignore'],
				windowsHide: true,
			});
		} catch (error) {
			if (error instanceof CompanionProcessError) {
				throw error;
			}
			throw new CompanionProcessError('launch-failed');
		}
		if (!child.stdin) {
			tryKill(child);
			throw new CompanionProcessError('stdin-unavailable');
		}

		let resolveExitPromise: (result: CompanionProcessExit) => void = () => undefined;
		const exit = new Promise<CompanionProcessExit>((resolve) => {
			resolveExitPromise = resolve;
		});
		let resolveTerminationPromise: () => void = () => undefined;
		const termination = new Promise<void>((resolve) => {
			resolveTerminationPromise = resolve;
		});
		const active: ActiveProcess = {
			child,
			exit,
			resolveExit: resolveExitPromise,
			termination,
			resolveTermination: resolveTerminationPromise,
			detach: () => undefined,
			resultSettled: false,
			released: false,
		};
		const unsubscribeExit = child.onExit((code, signal) => {
			this.reportResult(active, { reason: 'exit', code, signal });
			this.release(active);
		});
		const unsubscribeError = child.onError((error) => {
			this.reportResult(active, { reason: 'error', errorType: safeErrorName(error) });
		});
		active.detach = once(() => {
			unsubscribeExit();
			unsubscribeError();
		});
		this.active = active;

		try {
			await Promise.race([
				writeTokenLine(child, token),
				exit.then(() => {
					throw new CompanionProcessError('launch-failed');
				}),
			]);
		} catch (error) {
			this.terminate(active);
			if (error instanceof CompanionProcessError) {
				throw error;
			}
			throw new CompanionProcessError('stdin-write-failed');
		}
		return { exit };
	}

	shutdown(): Promise<void> {
		if (this.shutdownTask) {
			return this.shutdownTask;
		}
		const active = this.active;
		if (!active) {
			return Promise.resolve();
		}
		this.shutdownTask = this.shutdownActive(active).finally(() => {
			this.shutdownTask = null;
		});
		return this.shutdownTask;
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		const active = this.active;
		if (active) {
			this.terminate(active);
		}
	}

	private async shutdownActive(active: ActiveProcess): Promise<void> {
		tryEnd(active.child);
		const exited = await raceWithTimeout(
			active.termination,
			this.shutdownTimeoutMs,
			this.scheduler,
		);
		if (exited) {
			return;
		}
		tryKill(active.child);
		await raceWithTimeout(active.termination, FORCED_EXIT_TIMEOUT_MS, this.scheduler);
		if (!active.released) {
			this.reportResult(active, { reason: 'terminated', code: null, signal: null });
			this.release(active);
		}
	}

	private terminate(active: ActiveProcess): void {
		tryEnd(active.child);
		tryKill(active.child);
		this.reportResult(active, { reason: 'terminated', code: null, signal: null });
		this.release(active);
	}

	private reportResult(active: ActiveProcess, result: CompanionProcessExit): void {
		if (active.resultSettled) {
			return;
		}
		active.resultSettled = true;
		active.resolveExit(result);
	}

	private release(active: ActiveProcess): void {
		if (active.released) {
			return;
		}
		active.released = true;
		active.detach();
		if (this.active === active) {
			this.active = null;
		}
		active.resolveTermination();
	}
}

export function createNodeCompanionSpawnFactory(
	loader: RuntimeNodeModuleLoader,
): CompanionSpawnFactory {
	return (executable, args, options) => {
		const loaded = loader.load('node:child_process');
		if (!isNodeChildProcessModule(loaded)) {
			throw new CompanionProcessError('node-runtime-unavailable');
		}
		const child = loaded.spawn(executable, args, options);
		if (!isNodeChildProcess(child)) {
			throw new CompanionProcessError('launch-failed');
		}
		return adaptNodeChildProcess(child);
	};
}

interface NodeWritableLike {
	write(data: string, callback: (error?: Error | null) => void): unknown;
	end(): void;
}

interface NodeChildProcessLike {
	stdin: NodeWritableLike | null;
	on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
	on(event: 'error', listener: (error: unknown) => void): unknown;
	off(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
	off(event: 'error', listener: (error: unknown) => void): unknown;
	kill(): unknown;
}

interface NodeChildProcessModuleLike {
	spawn(executable: string, args: readonly string[], options: unknown): unknown;
}

function adaptNodeChildProcess(child: NodeChildProcessLike): CompanionChildProcess {
	return {
		stdin: child.stdin,
		onExit(listener) {
			child.on('exit', listener);
			return () => child.off('exit', listener);
		},
		onError(listener) {
			child.on('error', listener);
			return () => child.off('error', listener);
		},
		kill() {
			child.kill();
		},
	};
}

function isNodeChildProcessModule(value: unknown): value is NodeChildProcessModuleLike {
	return Boolean(value && typeof value === 'object' && 'spawn' in value
		&& typeof value.spawn === 'function');
}

function isNodeChildProcess(value: unknown): value is NodeChildProcessLike {
	return Boolean(value && typeof value === 'object'
		&& 'on' in value && typeof value.on === 'function'
		&& 'off' in value && typeof value.off === 'function'
		&& 'kill' in value && typeof value.kill === 'function'
		&& 'stdin' in value);
}

function assertLaunchSpec(spec: CompanionLaunchSpec, token: string): void {
	const values = [spec.executable, spec.cwd ?? '', ...spec.args];
	if (!spec.executable.trim()
		|| spec.args.some((argument) => argument.includes('\0'))
		|| values.some((value) => value.includes(token))) {
		throw new CompanionProcessError('invalid-launch-spec');
	}
}

function writeTokenLine(child: CompanionChildProcess, token: string): Promise<void> {
	const stdin = child.stdin;
	if (!stdin) {
		return Promise.reject(new CompanionProcessError('stdin-unavailable'));
	}
	return new Promise<void>((resolve, reject) => {
		try {
			stdin.write(`${token}\n`, (error) => {
				if (error) {
					reject(new CompanionProcessError('stdin-write-failed'));
					return;
				}
				resolve();
			});
		} catch {
			reject(new CompanionProcessError('stdin-write-failed'));
		}
	});
}

async function raceWithTimeout(
	promise: Promise<unknown>,
	delayMs: number,
	scheduler: CompanionProcessScheduler,
): Promise<boolean> {
	let timeoutHandle: unknown = null;
	try {
		return await Promise.race([
			promise.then(() => true),
			new Promise<boolean>((resolve) => {
				timeoutHandle = scheduler.setTimeout(() => resolve(false), delayMs);
			}),
		]);
	} finally {
		if (timeoutHandle !== null) {
			scheduler.clearTimeout(timeoutHandle);
		}
	}
}

function tryEnd(child: CompanionChildProcess): void {
	try {
		child.stdin?.end();
	} catch {
		// A closed stdin already satisfies the shutdown contract.
	}
}

function tryKill(child: CompanionChildProcess): void {
	try {
		child.kill();
	} catch {
		// The process may already have exited.
	}
}

function safeErrorName(error: unknown): string {
	if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)) {
		return error.name;
	}
	return 'UnknownError';
}

function once(callback: () => void): () => void {
	let called = false;
	return () => {
		if (called) {
			return;
		}
		called = true;
		callback();
	};
}

function browserProcessScheduler(): CompanionProcessScheduler {
	return {
		setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
		clearTimeout: (handle) => window.clearTimeout(handle as number),
	};
}
