import type {
	CompanionProcessExit,
	RuntimeNodeModuleLoader,
} from './companion-process-types';

export const COMPANION_HOST = '127.0.0.1';
export const COMPANION_PORT = 43_127;

const DEFAULT_TOTAL_TIMEOUT_MS = 60_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 500;
const DEFAULT_POLL_INTERVAL_MS = 200;

export interface CompanionTcpConnector {
	connect(options: {
		host: typeof COMPANION_HOST;
		port: typeof COMPANION_PORT;
		timeoutMs: number;
		signal: AbortSignal;
	}): Promise<void>;
}

export interface CompanionReadinessScheduler {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface CompanionReadinessProbeOptions {
	connector: CompanionTcpConnector;
	scheduler?: CompanionReadinessScheduler;
	totalTimeoutMs?: number;
	attemptTimeoutMs?: number;
	pollIntervalMs?: number;
}

export type CompanionReadinessErrorCode =
	| 'cancelled'
	| 'child-exited'
	| 'readiness-timeout'
	| 'node-runtime-unavailable';

export class CompanionReadinessError extends Error {
	constructor(readonly code: CompanionReadinessErrorCode) {
		super(`Audio companion readiness failed: ${code}.`);
		this.name = 'CompanionReadinessError';
	}
}

export class CompanionReadinessProbe {
	private readonly scheduler: CompanionReadinessScheduler;
	private readonly totalTimeoutMs: number;
	private readonly attemptTimeoutMs: number;
	private readonly pollIntervalMs: number;

	constructor(private readonly options: CompanionReadinessProbeOptions) {
		this.scheduler = options.scheduler ?? browserReadinessScheduler();
		this.totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
		this.attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
		this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	}

	async waitUntilReady(
		childExit: Promise<CompanionProcessExit>,
		signal: AbortSignal,
	): Promise<void> {
		const deadline = this.scheduler.now() + this.totalTimeoutMs;
		while (this.scheduler.now() < deadline) {
			throwIfAborted(signal);
			const attempt = new AbortController();
			const relayAbort = () => attempt.abort();
			signal.addEventListener('abort', relayAbort, { once: true });
			try {
				const connected = await Promise.race([
					this.options.connector.connect({
						host: COMPANION_HOST,
						port: COMPANION_PORT,
						timeoutMs: this.attemptTimeoutMs,
						signal: attempt.signal,
					}).then(() => true).catch((error: unknown) => {
						if (error instanceof CompanionReadinessError
							&& error.code === 'node-runtime-unavailable') {
							throw error;
						}
						return false;
					}),
					childExit.then(() => {
						throw new CompanionReadinessError('child-exited');
					}),
				]);
				if (connected) {
					return;
				}
			} finally {
				signal.removeEventListener('abort', relayAbort);
				attempt.abort();
			}
			await Promise.race([
				sleep(this.pollIntervalMs, this.scheduler, signal),
				childExit.then(() => {
					throw new CompanionReadinessError('child-exited');
				}),
			]);
		}
		throwIfAborted(signal);
		throw new CompanionReadinessError('readiness-timeout');
	}
}

export function createNodeTcpConnector(
	loader: RuntimeNodeModuleLoader,
): CompanionTcpConnector {
	let cachedModule: NodeNetModuleLike | null = null;
	return {
		connect({ host, port, timeoutMs, signal }) {
			if (!cachedModule) {
				const loaded = loader.load('node:net');
				if (!isNodeNetModule(loaded)) {
					throw new CompanionReadinessError('node-runtime-unavailable');
				}
				cachedModule = loaded;
			}
			return connectNodeSocket(cachedModule, host, port, timeoutMs, signal);
		},
	};
}

interface NodeSocketLike {
	once(event: 'connect' | 'error' | 'timeout', listener: (...args: unknown[]) => void): unknown;
	off(event: 'connect' | 'error' | 'timeout', listener: (...args: unknown[]) => void): unknown;
	setTimeout(timeoutMs: number): unknown;
	destroy(): void;
}

interface NodeNetModuleLike {
	createConnection(options: { host: string; port: number }): unknown;
}

function connectNodeSocket(
	netModule: NodeNetModuleLike,
	host: string,
	port: number,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let socket: NodeSocketLike;
		try {
			const created = netModule.createConnection({ host, port });
			if (!isNodeSocket(created)) {
				throw new CompanionReadinessError('node-runtime-unavailable');
			}
			socket = created;
		} catch (error) {
			reject(error instanceof Error ? error : new CompanionReadinessError('node-runtime-unavailable'));
			return;
		}
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			socket.off('connect', handleConnect);
			socket.off('error', handleError);
			socket.off('timeout', handleTimeout);
			signal.removeEventListener('abort', handleAbort);
			socket.destroy();
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		};
		const handleConnect = () => finish();
		const handleError = () => finish(new Error('TcpConnectError'));
		const handleTimeout = () => finish(new Error('TcpConnectTimeout'));
		const handleAbort = () => finish(new Error('AbortError'));
		socket.once('connect', handleConnect);
		socket.once('error', handleError);
		socket.once('timeout', handleTimeout);
		socket.setTimeout(timeoutMs);
		signal.addEventListener('abort', handleAbort, { once: true });
		if (signal.aborted) {
			handleAbort();
		}
	});
}

function isNodeNetModule(value: unknown): value is NodeNetModuleLike {
	return Boolean(value && typeof value === 'object' && 'createConnection' in value
		&& typeof value.createConnection === 'function');
}

function isNodeSocket(value: unknown): value is NodeSocketLike {
	return Boolean(value && typeof value === 'object'
		&& 'once' in value && typeof value.once === 'function'
		&& 'off' in value && typeof value.off === 'function'
		&& 'setTimeout' in value && typeof value.setTimeout === 'function'
		&& 'destroy' in value && typeof value.destroy === 'function');
}

function sleep(
	delayMs: number,
	scheduler: CompanionReadinessScheduler,
	signal: AbortSignal,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let handle: unknown = null;
		const onAbort = () => {
			if (handle !== null) {
				scheduler.clearTimeout(handle);
			}
			reject(new CompanionReadinessError('cancelled'));
		};
		handle = scheduler.setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, delayMs);
		signal.addEventListener('abort', onAbort, { once: true });
		if (signal.aborted) {
			onAbort();
		}
	});
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		throw new CompanionReadinessError('cancelled');
	}
}

function browserReadinessScheduler(): CompanionReadinessScheduler {
	return {
		now: () => Date.now(),
		setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
		clearTimeout: (handle) => window.clearTimeout(handle as number),
	};
}
