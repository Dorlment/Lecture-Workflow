export interface CompanionLaunchSpec {
	executable: string;
	args: readonly string[];
	cwd?: string;
}

export type CompanionProcessExit =
	| { reason: 'exit'; code: number | null; signal: string | null }
	| { reason: 'error'; errorType: string }
	| { reason: 'terminated'; code: null; signal: null };

export interface CompanionChildStdin {
	write(data: string, callback: (error?: Error | null) => void): void;
	end(): void;
}

export interface CompanionChildProcess {
	readonly stdin: CompanionChildStdin | null;
	onExit(listener: (code: number | null, signal: string | null) => void): () => void;
	onError(listener: (error: unknown) => void): () => void;
	kill(): void;
}

export interface CompanionSpawnOptions {
	cwd?: string;
	stdio: readonly ['pipe', 'ignore', 'ignore'];
	windowsHide: true;
}

export type CompanionSpawnFactory = (
	executable: string,
	args: readonly string[],
	options: CompanionSpawnOptions,
) => CompanionChildProcess;

export interface RuntimeNodeModuleLoader {
	load(moduleId: 'node:child_process' | 'node:net'): unknown;
}

export interface CompanionProcessScheduler {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface CompanionProcessHandle {
	readonly exit: Promise<CompanionProcessExit>;
}

export type CompanionProcessErrorCode =
	| 'busy'
	| 'invalid-launch-spec'
	| 'node-runtime-unavailable'
	| 'launch-failed'
	| 'stdin-unavailable'
	| 'stdin-write-failed';

export class CompanionProcessError extends Error {
	constructor(readonly code: CompanionProcessErrorCode) {
		super(`Audio companion process failed: ${code}.`);
		this.name = 'CompanionProcessError';
	}
}
