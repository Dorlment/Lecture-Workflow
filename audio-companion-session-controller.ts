import {
	AudioCompanionClient,
	AudioCompanionClientError,
} from './audio-companion-client';
import {
	AUDIO_COMPANION_DEFAULT_ENDPOINT,
	type AudioCompanionClientState,
	type AudioCompanionRemoteErrorCode,
	type AudioCompanionSessionContext,
} from './audio-companion-types';
import {
	AudioCompanionTokenError,
	createAudioCompanionToken,
	type AudioCompanionRandomSource,
} from './audio-companion-token';
import { AudioFrameConsumer } from './audio-frame-consumer';
import type { CompanionLaunchResolver } from './companion-launch-resolver';
import { CompanionProcessManager } from './companion-process-manager';
import {
	CompanionProcessError,
	type CompanionProcessHandle,
} from './companion-process-types';
import {
	CompanionReadinessError,
	CompanionReadinessProbe,
} from './companion-readiness-probe';
import type {
	AudioCompanionClassroomSessionSource,
	AudioCompanionRuntimeLocalErrorCode,
	AudioCompanionRuntimeScheduler,
	AudioCompanionRuntimeStartResult,
	AudioCompanionRuntimeState,
} from './audio-companion-runtime-types';

const CAPTURE_START_TIMEOUT_MS = 10_000;

export interface AudioCompanionSessionControllerOptions {
	isWindowsDesktop(): boolean;
	classroom: AudioCompanionClassroomSessionSource;
	launchResolver: CompanionLaunchResolver;
	processManager: CompanionProcessManager;
	readinessProbe: CompanionReadinessProbe;
	client: AudioCompanionClient;
	frameConsumer: AudioFrameConsumer;
	randomSource?: AudioCompanionRandomSource;
	scheduler?: AudioCompanionRuntimeScheduler;
}

export class AudioCompanionSessionController {
	private currentState: AudioCompanionRuntimeState = emptyRuntimeState();
	private readonly listeners = new Set<(state: AudioCompanionRuntimeState) => void>();
	private readonly scheduler: AudioCompanionRuntimeScheduler;
	private startTask: Promise<AudioCompanionRuntimeStartResult> | null = null;
	private stopTask: Promise<void> | null = null;
	private cleanupTask: Promise<void> | null = null;
	private runAbort: AbortController | null = null;
	private token: string | null = null;
	private frameUnsubscribe: (() => void) | null = null;
	private clientUnsubscribe: (() => void) | null = null;
	private classroomUnsubscribe: (() => void) | null = null;
	private processMonitor: Promise<void> | null = null;
	private runVersion = 0;
	private monitorClientErrors = false;
	private disposed = false;

	constructor(private readonly options: AudioCompanionSessionControllerOptions) {
		this.scheduler = options.scheduler ?? browserRuntimeScheduler();
	}

	get state(): AudioCompanionRuntimeState {
		return { ...this.currentState };
	}

	start(): Promise<AudioCompanionRuntimeStartResult> {
		if (this.disposed) {
			return Promise.resolve('error');
		}
		if (this.startTask || this.stopTask || isRuntimeActive(this.currentState.status)) {
			return Promise.resolve('busy');
		}
		const task = this.startInternal().finally(() => {
			if (this.startTask === task) {
				this.startTask = null;
			}
		});
		this.startTask = task;
		return task;
	}

	stop(): Promise<void> {
		if (this.stopTask) {
			return this.stopTask;
		}
		if (!isRuntimeActive(this.currentState.status) && !this.startTask) {
			return Promise.resolve();
		}
		const task = this.stopInternal().finally(() => {
			if (this.stopTask === task) {
				this.stopTask = null;
			}
		});
		this.stopTask = task;
		return task;
	}

	subscribe(listener: (state: AudioCompanionRuntimeState) => void): () => void {
		if (this.disposed) {
			return () => undefined;
		}
		this.listeners.add(listener);
		listener(this.state);
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.runVersion += 1;
		this.runAbort?.abort();
		this.runAbort = null;
		this.releaseSubscriptions();
		this.options.client.clearConfiguration();
		this.options.processManager.dispose();
		this.options.frameConsumer.dispose();
		this.token = null;
		this.listeners.clear();
	}

	private async startInternal(): Promise<AudioCompanionRuntimeStartResult> {
		if (!this.options.isWindowsDesktop()) {
			this.setState({
				...emptyRuntimeState(),
				status: 'unsupported',
				errorCode: 'unsupported-runtime',
			});
			return 'unsupported';
		}
		const session = this.options.classroom.getSessionContext();
		if (!session) {
			this.setFailure('session-unavailable');
			return 'session-unavailable';
		}

		const runVersion = ++this.runVersion;
		this.runAbort = new AbortController();
		this.options.frameConsumer.reset();
		this.setState({
			...emptyRuntimeState(),
			status: 'launching',
		});
		try {
			const launchSpec = await resolveLaunchSpec(
				this.options.launchResolver,
				this.requireRunSignal(),
			);
			this.assertCurrentRun(runVersion);
			if (!launchSpec) {
				this.runAbort.abort();
				this.runAbort = null;
				this.setState({
					...emptyRuntimeState(),
					status: 'helper-unavailable',
					errorCode: 'helper-unavailable',
				});
				return 'helper-unavailable';
			}

			this.token = createAudioCompanionToken(this.options.randomSource);
			const process = await this.options.processManager.start(launchSpec, this.token);
			this.assertCurrentRun(runVersion);
			this.monitorProcess(process, runVersion);
			this.setStatus('waiting-for-readiness');
			await this.options.readinessProbe.waitUntilReady(
				process.exit,
				this.requireRunSignal(),
			);
			this.assertCurrentRun(runVersion);

			this.setStatus('connecting');
			const configured = this.options.client.configure({
				endpoint: AUDIO_COMPANION_DEFAULT_ENDPOINT,
				token: this.token,
			});
			if (configured.status !== 'configured') {
				throw new AudioCompanionRuntimeError('launch-failed');
			}
			await this.options.client.connect();
			this.assertCurrentRun(runVersion);
			this.setStatus('ready');
			this.installSessionSubscriptions(session, runVersion);
			this.assertCurrentRun(runVersion);

			const waitForCapturing = waitForClientCapturing(
				this.options.client,
				this.scheduler,
				this.requireRunSignal(),
			);
			const startResult = this.options.client.startCapture('windows-wasapi-loopback');
			if (startResult !== 'starting') {
				throw new AudioCompanionRuntimeError(
					startResult === 'session-unavailable'
						? 'session-unavailable'
						: startResult === 'source-unavailable'
							? 'remote-error'
							: 'busy',
				);
			}
			await waitForCapturing;
			this.assertCurrentRun(runVersion);
			this.monitorClientErrors = true;
			this.setStatus('capturing');
			return 'capturing';
		} catch (error) {
			if (this.stopTask || this.disposed || runVersion !== this.runVersion) {
				return 'error';
			}
			const failure = mapRuntimeFailure(error);
			const failureVersion = this.claimFailure(runVersion);
			if (failureVersion === null) {
				return 'error';
			}
			await this.cleanupResources().catch(() => undefined);
			if (!this.disposed && failureVersion === this.runVersion && !this.stopTask) {
				this.setFailure(failure.errorCode, failure.remoteErrorCode);
			}
			return failure.errorCode === 'session-unavailable'
				? 'session-unavailable'
				: 'error';
		}
	}

	private async stopInternal(): Promise<void> {
		this.setStatus('stopping');
		this.runVersion += 1;
		this.runAbort?.abort();
		try {
			await this.options.client.stopCapture();
		} catch {
			// Local teardown remains authoritative when the helper cannot confirm STOP.
		}
		try {
			await this.cleanupResources();
		} catch {
			if (!this.disposed) {
				this.setFailure('cleanup-failed');
			}
			return;
		}
		if (!this.disposed) {
			this.setState({
				...emptyRuntimeState(),
				status: 'stopped',
				frameCount: this.options.frameConsumer.state.frameCount,
				rms: this.options.frameConsumer.state.rms,
			});
		}
	}

	private cleanupResources(): Promise<void> {
		if (this.cleanupTask) {
			return this.cleanupTask;
		}
		const task = this.cleanupInternal().finally(() => {
			if (this.cleanupTask === task) {
				this.cleanupTask = null;
			}
		});
		this.cleanupTask = task;
		return task;
	}

	private async cleanupInternal(): Promise<void> {
		this.monitorClientErrors = false;
		this.runAbort?.abort();
		this.runAbort = null;
		this.releaseSubscriptions();
		this.options.client.clearConfiguration();
		try {
			await this.options.processManager.shutdown();
		} finally {
			this.token = null;
			this.processMonitor = null;
		}
	}

	private installSessionSubscriptions(
		session: AudioCompanionSessionContext,
		runVersion: number,
	): void {
		this.frameUnsubscribe = this.options.client.subscribeAudioFrames((frame) => {
			if (runVersion !== this.runVersion || this.disposed) {
				return;
			}
			this.options.frameConsumer.consume(frame);
			const consumerState = this.options.frameConsumer.state;
			this.setState({
				...this.currentState,
				frameCount: consumerState.frameCount,
				rms: consumerState.rms,
			});
		});
		this.clientUnsubscribe = this.options.client.subscribe((state) => {
			if (this.monitorClientErrors && state.status === 'error') {
				this.requestFailure(
					state.errorCode ?? 'remote-error',
					state.remoteErrorCode,
					runVersion,
				);
			}
		});
		this.classroomUnsubscribe = this.options.classroom.subscribe((current) => {
			if (!sameSession(current, session)) {
				this.requestStop(runVersion);
			}
		});
	}

	private monitorProcess(process: CompanionProcessHandle, runVersion: number): void {
		const task = process.exit.then(() => {
			if (runVersion === this.runVersion
				&& !this.disposed
				&& this.currentState.status !== 'stopping') {
				this.requestFailure('child-exited', null, runVersion);
			}
		});
		this.processMonitor = task.catch(() => undefined);
	}

	private requestFailure(
		errorCode: AudioCompanionRuntimeLocalErrorCode,
		remoteErrorCode: AudioCompanionRemoteErrorCode | null,
		runVersion: number,
	): void {
		const failureVersion = this.claimFailure(runVersion);
		if (failureVersion === null) {
			return;
		}
		const task = this.cleanupResources().catch(() => undefined).then(() => {
			if (!this.disposed && failureVersion === this.runVersion && !this.stopTask) {
				this.setFailure(errorCode, remoteErrorCode);
			}
		});
		this.processMonitor = task.catch(() => undefined);
	}

	private claimFailure(runVersion: number): number | null {
		if (runVersion !== this.runVersion || this.disposed || this.stopTask) {
			return null;
		}
		this.runVersion += 1;
		this.monitorClientErrors = false;
		this.runAbort?.abort();
		return this.runVersion;
	}

	private requestStop(runVersion: number): void {
		if (runVersion !== this.runVersion || this.disposed) {
			return;
		}
		this.stop().catch(() => undefined);
	}

	private releaseSubscriptions(): void {
		this.frameUnsubscribe?.();
		this.frameUnsubscribe = null;
		this.clientUnsubscribe?.();
		this.clientUnsubscribe = null;
		this.classroomUnsubscribe?.();
		this.classroomUnsubscribe = null;
	}

	private requireRunSignal(): AbortSignal {
		if (!this.runAbort) {
			throw new AudioCompanionRuntimeError('cleanup-failed');
		}
		return this.runAbort.signal;
	}

	private assertCurrentRun(runVersion: number): void {
		if (this.disposed || runVersion !== this.runVersion || this.runAbort?.signal.aborted) {
			throw new AudioCompanionRuntimeError('cleanup-failed');
		}
	}

	private setStatus(status: AudioCompanionRuntimeState['status']): void {
		this.setState({
			...this.currentState,
			status,
			errorCode: null,
			remoteErrorCode: null,
		});
	}

	private setFailure(
		errorCode: AudioCompanionRuntimeLocalErrorCode,
		remoteErrorCode: AudioCompanionRemoteErrorCode | null = null,
	): void {
		this.setState({
			...this.currentState,
			status: 'error',
			errorCode,
			remoteErrorCode,
		});
	}

	private setState(state: AudioCompanionRuntimeState): void {
		if (this.disposed) {
			return;
		}
		this.currentState = { ...state };
		for (const listener of this.listeners) {
			try {
				listener(this.state);
			} catch {
				// Detached observers cannot interrupt audio resource cleanup.
			}
		}
	}
}

class AudioCompanionRuntimeError extends Error {
	constructor(readonly code: AudioCompanionRuntimeLocalErrorCode) {
		super(`Audio companion runtime failed: ${code}.`);
		this.name = 'AudioCompanionRuntimeError';
	}
}

function waitForClientCapturing(
	client: AudioCompanionClient,
	scheduler: AudioCompanionRuntimeScheduler,
	signal: AbortSignal,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		let timeoutHandle: unknown = null;
		let unsubscribe: (() => void) | null = null;
		const finish = (error?: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeoutHandle !== null) {
				scheduler.clearTimeout(timeoutHandle);
			}
			unsubscribe?.();
			signal.removeEventListener('abort', handleAbort);
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		};
		const inspect = (state: AudioCompanionClientState) => {
			if (state.status === 'capturing') {
				finish();
			} else if (state.status === 'error') {
				finish(new AudioCompanionClientError(
					state.errorCode ?? 'remote-error',
					state.remoteErrorCode,
				));
			}
		};
		const handleAbort = () => finish(new AudioCompanionRuntimeError('cleanup-failed'));
		unsubscribe = client.subscribe(inspect);
		if (settled) {
			unsubscribe();
			return;
		}
		timeoutHandle = scheduler.setTimeout(() => {
			finish(new AudioCompanionRuntimeError('capture-start-timeout'));
		}, CAPTURE_START_TIMEOUT_MS);
		signal.addEventListener('abort', handleAbort, { once: true });
		if (signal.aborted) {
			handleAbort();
		}
	});
}

function mapRuntimeFailure(error: unknown): {
	errorCode: AudioCompanionRuntimeLocalErrorCode;
	remoteErrorCode: AudioCompanionRemoteErrorCode | null;
} {
	if (error instanceof AudioCompanionClientError) {
		return { errorCode: error.code, remoteErrorCode: error.remoteErrorCode };
	}
	if (error instanceof AudioCompanionRuntimeError) {
		return { errorCode: error.code, remoteErrorCode: null };
	}
	if (error instanceof AudioCompanionTokenError) {
		return { errorCode: 'token-generation-failed', remoteErrorCode: null };
	}
	if (error instanceof CompanionReadinessError) {
		return {
			errorCode: error.code === 'readiness-timeout'
				? 'readiness-timeout'
				: error.code === 'child-exited'
					? 'child-exited'
					: 'launch-failed',
			remoteErrorCode: null,
		};
	}
	if (error instanceof CompanionProcessError) {
		return { errorCode: error.code === 'busy' ? 'busy' : 'launch-failed', remoteErrorCode: null };
	}
	return { errorCode: 'launch-failed', remoteErrorCode: null };
}

function sameSession(
	left: AudioCompanionSessionContext | null,
	right: AudioCompanionSessionContext,
): boolean {
	return Boolean(left
		&& left.sessionId === right.sessionId
		&& left.startedAtUnixMs === right.startedAtUnixMs);
}

function resolveLaunchSpec(
	resolver: CompanionLaunchResolver,
	signal: AbortSignal,
): Promise<Awaited<ReturnType<CompanionLaunchResolver['resolve']>>> {
	if (signal.aborted) {
		return Promise.reject(new AudioCompanionRuntimeError('cleanup-failed'));
	}
	const resolution = Promise.resolve().then(() => resolver.resolve(signal));
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (
			result: { status: 'resolved'; value: Awaited<ReturnType<CompanionLaunchResolver['resolve']>> }
				| { status: 'rejected'; error: Error },
		) => {
			if (settled) {
				return;
			}
			settled = true;
			signal.removeEventListener('abort', handleAbort);
			if (result.status === 'resolved') {
				resolve(result.value);
			} else {
				reject(result.error);
			}
		};
		const handleAbort = () => finish({
			status: 'rejected',
			error: new AudioCompanionRuntimeError('cleanup-failed'),
		});
		resolution.then(
			(value) => finish({ status: 'resolved', value }),
			(error: unknown) => finish({
				status: 'rejected',
				error: error instanceof Error
					? error
					: new AudioCompanionRuntimeError('launch-failed'),
			}),
		);
		signal.addEventListener('abort', handleAbort, { once: true });
		if (signal.aborted) {
			handleAbort();
		}
	});
}

function emptyRuntimeState(): AudioCompanionRuntimeState {
	return {
		status: 'idle',
		errorCode: null,
		remoteErrorCode: null,
		frameCount: 0,
		rms: 0,
	};
}

function isRuntimeActive(status: AudioCompanionRuntimeState['status']): boolean {
	return status === 'launching'
		|| status === 'waiting-for-readiness'
		|| status === 'connecting'
		|| status === 'ready'
		|| status === 'capturing'
		|| status === 'stopping';
}

function browserRuntimeScheduler(): AudioCompanionRuntimeScheduler {
	return {
		setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
		clearTimeout: (handle) => window.clearTimeout(handle as number),
	};
}
