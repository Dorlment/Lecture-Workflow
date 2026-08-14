import type WebSocket from 'ws';
import type { RawData } from 'ws';

import { BailianStreamingAsrProvider } from './bailian-streaming-asr-provider';
import {
	buildBailianAsrEndpoint,
	buildBailianFinishTask,
	buildBailianRunTask,
	classifyBailianAsrInboundEvent,
	parseBailianAsrServerEvent,
} from './bailian-asr-protocol';
import type { AudioCompanionFrame } from './audio-companion-types';
import type {
	RealtimeAsrConfiguration,
	RealtimeAsrDiagnostics,
	RealtimeAsrErrorCode,
	RealtimeAsrScheduler,
	RealtimeAsrTransportFactory,
	RealtimeAsrWebSocketTransport,
} from './realtime-asr-types';
import {
	REALTIME_ASR_CHUNK_BYTES,
	REALTIME_ASR_FRAME_BYTES,
	REALTIME_ASR_MAX_BUFFERED_AMOUNT,
	REALTIME_ASR_MAX_PENDING_SENDS,
	RealtimeAsrError,
	RealtimeAsrTransportError,
	realtimeAsrClientFrameOverhead,
} from './realtime-asr-types';
import {
	createNodeRealtimeAsrTransport,
	loadBundledWs,
	type RealtimeAsrWsLoader,
} from './realtime-asr-websocket';

export const REALTIME_ASR_AB_DURATION_MS = 75_000;
export const REALTIME_ASR_AB_TARGET_CHUNKS = 750;
const CHUNK_INTERVAL_MS = 100;
const INTERVAL_SAMPLE_MS = 15_000;
const BETWEEN_RUNS_DELAY_MS = 2_000;
const CONNECT_TIMEOUT_MS = 10_000;
const TASK_START_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 10_000;
const DRAIN_TIMEOUT_MS = 11_000;
const FINISH_TIMEOUT_MS = 8_000;
const BACKLOG_BUFFER_THRESHOLD = Math.floor(REALTIME_ASR_MAX_BUFFERED_AMOUNT * 0.9);

export type RealtimeAsrTransportAbRunnerKind =
	| 'current-transport'
	| 'official-sequence-minimal';

export type RealtimeAsrTransportAbRunStatus =
	| 'normal'
	| 'backlog'
	| 'failed'
	| 'cancelled'
	| 'inconclusive';

export type RealtimeAsrTransportAbConclusion =
	| 'probable-network-or-service-path'
	| 'probable-production-transport-difference'
	| 'transient-or-not-reproduced'
	| 'diagnostic-not-equivalent-or-minimal-runner-defect'
	| 'inconclusive';

export type RealtimeAsrTransportAbStableErrorCode =
	| RealtimeAsrErrorCode
	| 'cancelled'
	| 'diagnostic-busy'
	| 'configuration-error'
	| 'diagnostic-internal-error';

export interface RealtimeAsrTransportAbResult {
	runnerKind: RealtimeAsrTransportAbRunnerKind;
	status: RealtimeAsrTransportAbRunStatus;
	durationTargetMs: number;
	wallElapsedMs: number;
	cancelled: boolean;
	completed: boolean;
	stableErrorCode: RealtimeAsrTransportAbStableErrorCode | null;
	targetChunkCount: number;
	dispatchCount: number;
	successCount: number;
	failureCount: number;
	callbackSettledCount: number;
	finalInFlightCount: number;
	maxInFlightCount: number;
	finalQueuedCount: number;
	maxQueuedCount: number;
	lastSendWriteLatencyMs: number | null;
	averageSendWriteLatencyMs: number;
	p50SendWriteLatencyMs: number;
	p95SendWriteLatencyMs: number;
	p99SendWriteLatencyMs: number;
	maxSendWriteLatencyMs: number;
	oldestInFlightAgeMs: number | null;
	maxObservedInFlightAgeMs: number;
	finalBufferedAmount: number;
	maxBufferedAmount: number;
	minDispatchIntervalMs: number | null;
	maxDispatchIntervalMs: number | null;
	maxDispatchBurstCount: number;
	dispatchedAudioDurationMs: number;
	currentDispatchLeadMs: number;
	maxDispatchLeadMs: number;
	taskStartedEventCount: number;
	resultGeneratedEventCount: number;
	taskFailedEventCount: number;
	taskFinishedEventCount: number;
	unknownEventCount: number;
	perMessageDeflateConfigured: boolean;
	perMessageDeflateNegotiated: boolean;
	intervalSamples: RealtimeAsrTransportAbIntervalSample[];
}

export interface RealtimeAsrTransportAbIntervalSample {
	elapsedMs: number;
	dispatchCount: number;
	callbackSettledCount: number;
	inFlightCount: number;
	bufferedAmount: number;
	eventLoopLagCurrentMs: number;
	eventLoopLagMaxMs: number;
}

export interface RealtimeAsrTransportAbComparison {
	currentTransport: RealtimeAsrTransportAbResult;
	officialSequenceMinimal: RealtimeAsrTransportAbResult;
	conclusion: RealtimeAsrTransportAbConclusion;
}

export type RealtimeAsrTransportAbPhase =
	| 'idle'
	| 'current-transport'
	| 'between-runs'
	| 'official-sequence-minimal'
	| 'completed'
	| 'cancelled';

export interface RealtimeAsrTransportAbProgress {
	phase: RealtimeAsrTransportAbPhase;
	remainingMs: number;
	currentResult: RealtimeAsrTransportAbResult | null;
	minimalResult: RealtimeAsrTransportAbResult | null;
	comparison: RealtimeAsrTransportAbComparison | null;
}

export interface RealtimeAsrTransportAbRunOptions {
	configuration: RealtimeAsrConfiguration;
	getApiKey(): string;
	signal: AbortSignal;
	onProgress(progress: RealtimeAsrTransportAbProgress): void;
}

export type RealtimeAsrTransportAbVariantRunner = (
	options: RealtimeAsrTransportAbRunOptions,
) => Promise<RealtimeAsrTransportAbResult>;

export interface RealtimeAsrTransportAbDiagnosticOptions {
	getConfiguration(): RealtimeAsrConfiguration;
	getApiKey(): string;
	currentRunner?: RealtimeAsrTransportAbVariantRunner;
	minimalRunner?: RealtimeAsrTransportAbVariantRunner;
	scheduler?: RealtimeAsrScheduler;
}

export class RealtimeAsrTransportAbDiagnostic {
	private readonly scheduler: RealtimeAsrScheduler;
	private readonly currentRunner: RealtimeAsrTransportAbVariantRunner;
	private readonly minimalRunner: RealtimeAsrTransportAbVariantRunner;
	private abortController: AbortController | null = null;
	private runTask: Promise<RealtimeAsrTransportAbComparison | null> | null = null;
	private disposed = false;
	private currentProgress: RealtimeAsrTransportAbProgress = emptyProgress();
	private readonly listeners = new Set<(progress: RealtimeAsrTransportAbProgress) => void>();

	constructor(private readonly options: RealtimeAsrTransportAbDiagnosticOptions) {
		this.scheduler = options.scheduler ?? browserScheduler();
		this.currentRunner = options.currentRunner ?? ((runOptions) =>
			runCurrentTransportDiagnostic({ ...runOptions, scheduler: this.scheduler }));
		this.minimalRunner = options.minimalRunner ?? ((runOptions) =>
			runOfficialSequenceMinimalDiagnostic({ ...runOptions, scheduler: this.scheduler }));
	}

	get isRunning(): boolean {
		return this.runTask !== null;
	}

	get progress(): RealtimeAsrTransportAbProgress {
		return cloneProgress(this.currentProgress);
	}

	subscribe(listener: (progress: RealtimeAsrTransportAbProgress) => void): () => void {
		if (this.disposed) return () => undefined;
		this.listeners.add(listener);
		listener(this.progress);
		return () => this.listeners.delete(listener);
	}

	run(): Promise<RealtimeAsrTransportAbComparison | null> {
		if (this.disposed) return Promise.resolve(null);
		if (this.runTask) return this.runTask;
		const task = this.runInternal().finally(() => {
			if (this.runTask === task) this.runTask = null;
		});
		this.runTask = task;
		return task;
	}

	cancel(): void {
		this.abortController?.abort();
	}

	clear(): void {
		if (this.isRunning) return;
		this.setProgress(emptyProgress());
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.abortController?.abort();
		this.abortController = null;
		this.listeners.clear();
		this.currentProgress = emptyProgress();
	}

	private async runInternal(): Promise<RealtimeAsrTransportAbComparison | null> {
		const configuration = this.options.getConfiguration();
		let apiKey = this.options.getApiKey().trim();
		if (!buildBailianAsrEndpoint(configuration.region, configuration.workspaceId)
			|| !configuration.model.trim()
			|| !apiKey) {
			apiKey = '';
			throw new RealtimeAsrError('configuration-error');
		}
		this.abortController = new AbortController();
		const signal = this.abortController.signal;
		let currentResult: RealtimeAsrTransportAbResult | null = null;
		let minimalResult: RealtimeAsrTransportAbResult | null = null;
		const sharedOptions = (phase: RealtimeAsrTransportAbRunnerKind): RealtimeAsrTransportAbRunOptions => ({
			configuration: { ...configuration },
			getApiKey: () => apiKey,
			signal,
			onProgress: (progress) => this.setProgress({
				...progress,
				phase,
				currentResult,
				minimalResult,
				comparison: null,
			}),
		});
		try {
			this.setProgress({ ...emptyProgress(), phase: 'current-transport', remainingMs: REALTIME_ASR_AB_DURATION_MS });
			currentResult = await this.currentRunner(sharedOptions('current-transport'));
			if (signal.aborted) {
				this.setProgress({ ...this.currentProgress, phase: 'cancelled', remainingMs: 0, currentResult });
				return null;
			}
			this.setProgress({
				phase: 'between-runs',
				remainingMs: BETWEEN_RUNS_DELAY_MS,
				currentResult,
				minimalResult: null,
				comparison: null,
			});
			await abortableDelay(BETWEEN_RUNS_DELAY_MS, this.scheduler, signal);
			if (signal.aborted) return null;
			this.setProgress({
				phase: 'official-sequence-minimal',
				remainingMs: REALTIME_ASR_AB_DURATION_MS,
				currentResult,
				minimalResult: null,
				comparison: null,
			});
			minimalResult = await this.minimalRunner(sharedOptions('official-sequence-minimal'));
			if (signal.aborted) {
				this.setProgress({
					phase: 'cancelled', remainingMs: 0, currentResult, minimalResult, comparison: null,
				});
				return null;
			}
			const comparison = {
				currentTransport: currentResult,
				officialSequenceMinimal: minimalResult,
				conclusion: classifyRealtimeAsrTransportAbConclusion(currentResult, minimalResult),
			};
			this.setProgress({
				phase: 'completed', remainingMs: 0, currentResult, minimalResult, comparison,
			});
			return comparison;
		} catch (error) {
			if (signal.aborted || isAbortError(error)) {
				this.setProgress({
					phase: 'cancelled', remainingMs: 0, currentResult, minimalResult, comparison: null,
				});
				return null;
			}
			throw error;
		} finally {
			apiKey = '';
			this.abortController = null;
		}
	}

	private setProgress(progress: RealtimeAsrTransportAbProgress): void {
		if (this.disposed) return;
		this.currentProgress = cloneProgress(progress);
		for (const listener of this.listeners) listener(this.progress);
	}
}

interface ConcreteRunnerOptions extends RealtimeAsrTransportAbRunOptions {
	scheduler: RealtimeAsrScheduler;
	transportFactory?: RealtimeAsrTransportFactory;
	loadWs?: RealtimeAsrWsLoader;
	taskIdFactory?: () => string;
}

export async function runCurrentTransportDiagnostic(
	options: ConcreteRunnerOptions,
): Promise<RealtimeAsrTransportAbResult> {
	const startedAt = options.scheduler.now();
	const metrics = new WriteMetrics(options.scheduler);
	const intervalSampler = new IntervalSampler(startedAt);
	let latestDiagnostics: RealtimeAsrDiagnostics | null = null;
	let stableErrorCode: RealtimeAsrTransportAbStableErrorCode | null = null;
	let maxQueuedCount = 0;
	let maxInFlightCount = 0;
	const runnerAbort = new AbortController();
	const abortRunner = () => runnerAbort.abort();
	options.signal.addEventListener('abort', abortRunner, { once: true });
	const transportFactory = options.transportFactory ?? (() => createNodeRealtimeAsrTransport());
	const provider = new BailianStreamingAsrProvider({
		configuration: { ...options.configuration },
		getApiKey: () => options.getApiKey(),
		transportFactory: () => {
			return new MeasuredTransport(transportFactory(), metrics);
		},
		taskIdFactory: options.taskIdFactory ?? (() => crypto.randomUUID()),
		scheduler: options.scheduler,
		callbacks: {
			onPhase: () => undefined,
			onSegment: () => undefined,
				onProgress: (progress) => {
					latestDiagnostics = { ...progress.diagnostics };
				maxQueuedCount = Math.max(maxQueuedCount, progress.diagnostics.queuedChunkCount);
					maxInFlightCount = Math.max(maxInFlightCount, progress.diagnostics.inFlightSendCount);
					intervalSampler.capture(options.scheduler.now(), {
						dispatchCount: progress.diagnostics.dispatchChunkCount,
						callbackSettledCount: progress.diagnostics.sendCallbackSettledCount,
						inFlightCount: progress.diagnostics.inFlightSendCount,
						bufferedAmount: progress.diagnostics.wsBufferedAmount,
						eventLoopLagCurrentMs: progress.diagnostics.eventLoopLagCurrentMs,
						eventLoopLagMaxMs: progress.diagnostics.eventLoopLagMaxMs,
					});
				},
			onFailure: (code) => {
				stableErrorCode ??= code;
				runnerAbort.abort();
			},
		},
	});
	let completedGeneration = false;
	let cancelled = false;
	try {
		await provider.start(runnerAbort.signal);
		await generateAbsoluteDiagnosticAudio({
			scheduler: options.scheduler,
			signal: runnerAbort.signal,
			onChunk: (chunkIndex, chunk) => {
				feedProviderChunk(provider, chunkIndex, chunk);
			},
			onProgress: (remainingMs) => options.onProgress({
				phase: 'current-transport', remainingMs,
				currentResult: null, minimalResult: null, comparison: null,
			}),
		});
		completedGeneration = true;
		await provider.stop();
	} catch (error) {
		cancelled = options.signal.aborted || isAbortError(error);
		if (!cancelled) stableErrorCode ??= safeErrorCode(error);
	} finally {
		provider.dispose();
		options.signal.removeEventListener('abort', abortRunner);
	}
	const diagnostics = latestDiagnostics ?? emptyRunnerDiagnostics();
	const result = buildResult({
		runnerKind: 'current-transport',
		startedAt,
		now: options.scheduler.now(),
		cancelled,
		completedGeneration,
		stableErrorCode: cancelled ? 'cancelled' : stableErrorCode,
		dispatchCount: diagnostics.dispatchChunkCount,
		successCount: diagnostics.sendCallbackSuccessCount,
		failureCount: diagnostics.sendCallbackFailureCount,
		callbackSettledCount: diagnostics.sendCallbackSettledCount,
		finalInFlightCount: diagnostics.inFlightSendCount,
		maxInFlightCount,
		finalQueuedCount: diagnostics.queuedChunkCount,
		maxQueuedCount,
		metrics,
		oldestInFlightAgeMs: diagnostics.oldestInFlightAgeMs,
		maxObservedInFlightAgeMs: diagnostics.maxObservedInFlightAgeMs,
		finalBufferedAmount: metrics.lastBufferedAmount,
		minDispatchIntervalMs: diagnostics.minDispatchIntervalMs,
		maxDispatchIntervalMs: metrics.maxDispatchIntervalMs,
		maxDispatchBurstCount: diagnostics.maxDispatchBurstCount,
		dispatchedAudioDurationMs: diagnostics.dispatchedAudioDurationMs,
		currentDispatchLeadMs: diagnostics.currentDispatchLeadMs,
		maxDispatchLeadMs: diagnostics.maxDispatchLeadMs,
		taskStartedEventCount: diagnostics.taskStartedEventCount,
		resultGeneratedEventCount: diagnostics.resultGeneratedEventCount,
		taskFailedEventCount: diagnostics.taskFailedEventCount,
		taskFinishedEventCount: diagnostics.taskFinishedEventCount,
		unknownEventCount: diagnostics.unknownEventCount,
		perMessageDeflateConfigured: diagnostics.perMessageDeflateConfigured,
		perMessageDeflateNegotiated: diagnostics.perMessageDeflateNegotiated,
		intervalSamples: intervalSampler.samples,
	});
	return { ...result, status: classifyRealtimeAsrTransportAbResult(result) };
}

export async function runOfficialSequenceMinimalDiagnostic(
	options: ConcreteRunnerOptions,
): Promise<RealtimeAsrTransportAbResult> {
	const startedAt = options.scheduler.now();
	const metrics = new WriteMetrics(options.scheduler);
	const intervalSampler = new IntervalSampler(startedAt);
	const eventLoopProbe = new DiagnosticEventLoopLagProbe(options.scheduler);
	eventLoopProbe.start();
	const taskId = (options.taskIdFactory ?? (() => crypto.randomUUID()))();
	const endpoint = buildBailianAsrEndpoint(
		options.configuration.region,
		options.configuration.workspaceId,
	);
	let apiKey = options.getApiKey().trim();
	let authorization = `Bearer ${apiKey}`;
	let stableErrorCode: RealtimeAsrTransportAbStableErrorCode | null = null;
	let cancelled = false;
	let completedGeneration = false;
	let socket: InstanceType<typeof WebSocket> | null = null;
	let taskStartedEventCount = 0;
	let resultGeneratedEventCount = 0;
	let taskFailedEventCount = 0;
	let taskFinishedEventCount = 0;
	let unknownEventCount = 0;
	let taskStarted = false;
	let perMessageDeflateNegotiated = false;
	let maxInFlightCount = 0;
	const pending = new Set<PendingMinimalSend>();
	let taskStartedWait = deferred<void>();
	let taskFinishedWait = deferred<void>();
	let closeWait = deferred<void>();
	try {
		const Ws = await (options.loadWs ?? loadBundledWs)();
		if (options.signal.aborted) throw abortError();
		socket = new Ws(endpoint, {
			headers: { Authorization: authorization },
			maxPayload: REALTIME_ASR_MAX_BUFFERED_AMOUNT,
			perMessageDeflate: false,
		});
		apiKey = '';
		authorization = '';
		const currentSocket = socket;
		currentSocket.on('message', (data, isBinary) => {
			if (isBinary || options.signal.aborted) {
				stableErrorCode ??= 'protocol-error';
				return;
			}
			const message = decodeTextData(data);
			const kind = classifyBailianAsrInboundEvent(message, taskId);
			try {
				const event = parseBailianAsrServerEvent(message, taskId);
				switch (event.type) {
					case 'task-started':
						taskStartedEventCount += 1;
						taskStarted = true;
						taskStartedWait.resolve();
						break;
					case 'result-generated':
						resultGeneratedEventCount += 1;
						break;
					case 'task-failed':
						taskFailedEventCount += 1;
						stableErrorCode ??= 'task-failed';
						taskStartedWait.reject(new RealtimeAsrError('task-failed'));
						taskFinishedWait.reject(new RealtimeAsrError('task-failed'));
						break;
					case 'task-finished':
						taskFinishedEventCount += 1;
						taskFinishedWait.resolve();
						break;
				}
			} catch {
				if (kind === 'unknown') unknownEventCount += 1;
				stableErrorCode ??= 'protocol-error';
				taskStartedWait.reject(new RealtimeAsrError('protocol-error'));
				taskFinishedWait.reject(new RealtimeAsrError('protocol-error'));
			}
		});
		currentSocket.on('close', () => {
			if (taskFinishedEventCount === 0 && !options.signal.aborted) {
				stableErrorCode ??= 'remote-closed';
			}
			closeWait.resolve();
		});
		currentSocket.on('error', () => {
			stableErrorCode ??= 'connection-failed';
			taskStartedWait.reject(new RealtimeAsrError('connection-failed'));
			taskFinishedWait.reject(new RealtimeAsrError('connection-failed'));
		});
		await waitForSocketOpen(currentSocket, options.scheduler, options.signal);
		perMessageDeflateNegotiated = hasPerMessageDeflate(currentSocket.extensions);
		if (perMessageDeflateNegotiated) {
			throw new RealtimeAsrError('unexpected-websocket-compression');
		}
		await sendMinimalControl(
			currentSocket,
			buildBailianRunTask(taskId, options.configuration.model),
			options.scheduler,
			options.signal,
		);
		await withDeadline(
			taskStartedWait.promise,
			TASK_START_TIMEOUT_MS,
			options.scheduler,
			options.signal,
			'task-start-failed',
		);
		if (!taskStarted) throw new RealtimeAsrError('task-start-failed');
		await generatePacedDiagnosticAudio({
			scheduler: options.scheduler,
			signal: options.signal,
			onChunk: (_chunkIndex, chunk) => {
				if (stableErrorCode) {
					chunk.fill(0);
					throw new RealtimeAsrError(stableErrorCode as RealtimeAsrErrorCode);
				}
				if (pending.size >= REALTIME_ASR_MAX_PENDING_SENDS
					|| currentSocket.bufferedAmount + chunk.byteLength
						+ realtimeAsrClientFrameOverhead(chunk.byteLength)
						> REALTIME_ASR_MAX_BUFFERED_AMOUNT) {
					chunk.fill(0);
					stableErrorCode = 'audio-buffer-overflow';
					return;
				}
				const entry = dispatchMinimalBinary(
					currentSocket, chunk, metrics, options.scheduler, options.signal,
				);
				pending.add(entry);
				maxInFlightCount = Math.max(maxInFlightCount, pending.size);
				void entry.promise.catch((error: unknown) => {
					stableErrorCode ??= safeErrorCode(error);
				}).finally(() => pending.delete(entry));
			},
			onProgress: (remainingMs) => {
				intervalSampler.capture(options.scheduler.now(), {
					dispatchCount: metrics.dispatchCount,
					callbackSettledCount: metrics.successCount + metrics.failureCount,
					inFlightCount: pending.size,
					bufferedAmount: currentSocket.bufferedAmount,
					eventLoopLagCurrentMs: eventLoopProbe.currentMs,
					eventLoopLagMaxMs: eventLoopProbe.maxMs,
				});
				options.onProgress({
					phase: 'official-sequence-minimal', remainingMs,
					currentResult: null, minimalResult: null, comparison: null,
				});
			},
			});
		intervalSampler.capture(options.scheduler.now(), {
			dispatchCount: metrics.dispatchCount,
			callbackSettledCount: metrics.successCount + metrics.failureCount,
			inFlightCount: pending.size,
			bufferedAmount: currentSocket.bufferedAmount,
			eventLoopLagCurrentMs: eventLoopProbe.currentMs,
			eventLoopLagMaxMs: eventLoopProbe.maxMs,
		});
		completedGeneration = true;
		if (stableErrorCode) throw new RealtimeAsrError(stableErrorCode);
		await withDeadline(
			Promise.all([...pending].map((entry) => entry.promise)).then(() => undefined),
			DRAIN_TIMEOUT_MS,
			options.scheduler,
			options.signal,
			'audio-send-timeout',
		);
		await sendMinimalControl(
			currentSocket,
			buildBailianFinishTask(taskId),
			options.scheduler,
			options.signal,
		);
		await withDeadline(
			taskFinishedWait.promise,
			FINISH_TIMEOUT_MS,
			options.scheduler,
			options.signal,
			'finish-timeout',
		);
	} catch (error) {
		cancelled = options.signal.aborted || isAbortError(error);
		if (!cancelled) stableErrorCode ??= safeErrorCode(error);
	} finally {
		eventLoopProbe.stop();
		apiKey = '';
		authorization = '';
		if (socket) {
			if (!cancelled && !stableErrorCode && taskFinishedEventCount > 0
				&& socket.readyState === socket.OPEN) {
				socket.close(1_000);
				await waitForCleanup(closeWait.promise, 1_000, options.scheduler);
			}
			if (socket.readyState !== socket.CLOSED) socket.terminate();
			await settleMinimalPending(pending, new RealtimeAsrTransportError('remote-closed'));
			await waitForCleanup(closeWait.promise, 100, options.scheduler);
			socket.removeAllListeners();
		}
		taskStartedWait.reject(new RealtimeAsrError('remote-closed'));
		taskFinishedWait.reject(new RealtimeAsrError('remote-closed'));
		closeWait.resolve();
	}
	const result = buildResult({
		runnerKind: 'official-sequence-minimal',
		startedAt,
		now: options.scheduler.now(),
		cancelled,
		completedGeneration,
		stableErrorCode: cancelled ? 'cancelled' : stableErrorCode,
		dispatchCount: metrics.dispatchCount,
		successCount: metrics.successCount,
		failureCount: metrics.failureCount,
		callbackSettledCount: metrics.successCount + metrics.failureCount,
		finalInFlightCount: pending.size,
		maxInFlightCount,
		finalQueuedCount: 0,
		maxQueuedCount: 0,
		metrics,
		oldestInFlightAgeMs: metrics.oldestInFlightAgeMs,
		maxObservedInFlightAgeMs: metrics.maxObservedInFlightAgeMs,
		finalBufferedAmount: socket?.bufferedAmount ?? metrics.lastBufferedAmount,
		minDispatchIntervalMs: metrics.minDispatchIntervalMs,
		maxDispatchIntervalMs: metrics.maxDispatchIntervalMs,
		maxDispatchBurstCount: metrics.maxDispatchBurstCount,
		dispatchedAudioDurationMs: metrics.dispatchCount * CHUNK_INTERVAL_MS,
		currentDispatchLeadMs: metrics.currentDispatchLeadMs,
		maxDispatchLeadMs: metrics.maxDispatchLeadMs,
		taskStartedEventCount,
		resultGeneratedEventCount,
		taskFailedEventCount,
		taskFinishedEventCount,
		unknownEventCount,
		perMessageDeflateConfigured: false,
		perMessageDeflateNegotiated,
		intervalSamples: intervalSampler.samples,
	});
	return { ...result, status: classifyRealtimeAsrTransportAbResult(result) };
}

export function createDiagnosticPcmChunk(chunkIndex: number): Uint8Array {
	const data = new Uint8Array(REALTIME_ASR_CHUNK_BYTES);
	const view = new DataView(data.buffer);
	const firstSample = chunkIndex * 1_600;
	for (let sample = 0; sample < 1_600; sample += 1) {
		const phase = 2 * Math.PI * 437 * (firstSample + sample) / 16_000;
		const value = Math.round(Math.sin(phase) * 512);
		view.setInt16(sample * 2, value, true);
	}
	return data;
}

export function classifyRealtimeAsrTransportAbResult(
	result: Omit<RealtimeAsrTransportAbResult, 'status'> | RealtimeAsrTransportAbResult,
): RealtimeAsrTransportAbRunStatus {
	if (result.cancelled || result.stableErrorCode === 'cancelled') return 'cancelled';
	if (result.stableErrorCode === 'audio-buffer-overflow'
		|| result.stableErrorCode === 'audio-send-timeout'
		|| result.maxBufferedAmount >= BACKLOG_BUFFER_THRESHOLD
		|| result.maxInFlightCount >= REALTIME_ASR_MAX_PENDING_SENDS
		|| result.maxQueuedCount >= 20
		|| (result.dispatchCount < result.targetChunkCount
			&& (result.maxInFlightCount > 0 || result.maxQueuedCount > 0))) {
		return 'backlog';
	}
	if (result.stableErrorCode) return 'failed';
	if (result.dispatchCount === REALTIME_ASR_AB_TARGET_CHUNKS
		&& result.successCount === REALTIME_ASR_AB_TARGET_CHUNKS
		&& result.failureCount === 0
		&& result.finalInFlightCount === 0
		&& result.finalQueuedCount === 0
		&& result.maxBufferedAmount < REALTIME_ASR_MAX_BUFFERED_AMOUNT
		&& result.taskFailedEventCount === 0) {
		return 'normal';
	}
	return 'inconclusive';
}

export function classifyRealtimeAsrTransportAbConclusion(
	current: RealtimeAsrTransportAbResult,
	minimal: RealtimeAsrTransportAbResult,
): RealtimeAsrTransportAbConclusion {
	if (current.status === 'backlog' && minimal.status === 'backlog') {
		return 'probable-network-or-service-path';
	}
	if ((current.status === 'backlog' || current.status === 'failed')
		&& minimal.status === 'normal') {
		return 'probable-production-transport-difference';
	}
	if (current.status === 'normal' && minimal.status === 'normal') {
		return 'transient-or-not-reproduced';
	}
	if (minimal.status === 'failed' && current.resultGeneratedEventCount > 0) {
		return 'diagnostic-not-equivalent-or-minimal-runner-defect';
	}
	return 'inconclusive';
}

class WriteMetrics {
	readonly latencies: number[] = [];
	dispatchCount = 0;
	successCount = 0;
	failureCount = 0;
	maxBufferedAmount = 0;
	lastBufferedAmount = 0;
	lastSendWriteLatencyMs: number | null = null;
	maxSendWriteLatencyMs = 0;
	minDispatchIntervalMs: number | null = null;
	maxDispatchIntervalMs: number | null = null;
	maxDispatchBurstCount = 0;
	maxDispatchLeadMs = 0;
	oldestInFlightAgeMs: number | null = null;
	maxObservedInFlightAgeMs = 0;
	private lastDispatchAt: number | null = null;
	private firstDispatchAt: number | null = null;
	private burstCount = 0;
	private readonly pending = new Map<number, number>();
	private nextOrdinal = 0;

	constructor(private readonly scheduler: RealtimeAsrScheduler) {}

	beginWrite(bufferedAmount: number): (success: boolean, bufferedAmount: number) => void {
		const ordinal = this.nextOrdinal++;
		const now = this.scheduler.now();
		this.firstDispatchAt ??= now;
		this.dispatchCount += 1;
		this.observeBufferedAmount(bufferedAmount);
		this.pending.set(ordinal, now);
		if (this.lastDispatchAt === now) this.burstCount += 1;
		else {
			if (this.lastDispatchAt !== null) {
				const interval = Math.max(0, now - this.lastDispatchAt);
				this.minDispatchIntervalMs = this.minDispatchIntervalMs === null
					? interval : Math.min(this.minDispatchIntervalMs, interval);
				this.maxDispatchIntervalMs = this.maxDispatchIntervalMs === null
					? interval : Math.max(this.maxDispatchIntervalMs, interval);
			}
			this.burstCount = 1;
		}
		this.lastDispatchAt = now;
		this.maxDispatchBurstCount = Math.max(this.maxDispatchBurstCount, this.burstCount);
		this.maxDispatchLeadMs = Math.max(this.maxDispatchLeadMs, this.currentDispatchLeadMs);
		let settled = false;
		return (success, finalBufferedAmount) => {
			if (settled) return;
			settled = true;
			const startedAt = this.pending.get(ordinal);
			this.pending.delete(ordinal);
			const latency = Math.max(0, this.scheduler.now() - (startedAt ?? this.scheduler.now()));
			this.latencies.push(latency);
			this.lastSendWriteLatencyMs = latency;
			this.maxSendWriteLatencyMs = Math.max(this.maxSendWriteLatencyMs, latency);
			if (success) this.successCount += 1;
			else this.failureCount += 1;
			this.observeBufferedAmount(finalBufferedAmount);
			this.refreshAges();
		};
	}

	observeBufferedAmount(value: number): void {
		const safe = safeMetric(value);
		this.lastBufferedAmount = safe;
		this.maxBufferedAmount = Math.max(this.maxBufferedAmount, safe);
		this.refreshAges();
	}

	get averageLatencyMs(): number {
		return percentileAverage(this.latencies);
	}

	get oldestPendingAgeMs(): number | null {
		this.refreshAges();
		return this.oldestInFlightAgeMs;
	}

	get currentDispatchLeadMs(): number {
		if (this.firstDispatchAt === null) return 0;
		return this.dispatchCount * CHUNK_INTERVAL_MS
			- Math.max(0, this.scheduler.now() - this.firstDispatchAt);
	}

	private refreshAges(): void {
		const now = this.scheduler.now();
		let oldest: number | null = null;
		for (const startedAt of this.pending.values()) {
			const age = Math.max(0, now - startedAt);
			oldest = oldest === null ? age : Math.max(oldest, age);
		}
		this.oldestInFlightAgeMs = oldest;
		if (oldest !== null) {
			this.maxObservedInFlightAgeMs = Math.max(this.maxObservedInFlightAgeMs, oldest);
		}
	}
}

type IntervalSampleValues = Omit<RealtimeAsrTransportAbIntervalSample, 'elapsedMs'>;

class IntervalSampler {
	readonly samples: RealtimeAsrTransportAbIntervalSample[] = [];
	private nextElapsedMs = INTERVAL_SAMPLE_MS;

	constructor(private readonly startedAtMs: number) {}

	capture(now: number, values: IntervalSampleValues): void {
		const elapsedMs = Math.max(0, now - this.startedAtMs);
		while (elapsedMs >= this.nextElapsedMs
			&& this.nextElapsedMs <= REALTIME_ASR_AB_DURATION_MS) {
			this.samples.push({
				elapsedMs: this.nextElapsedMs,
				...values,
			});
			this.nextElapsedMs += INTERVAL_SAMPLE_MS;
		}
	}
}

class DiagnosticEventLoopLagProbe {
	currentMs = 0;
	maxMs = 0;
	private timer: unknown = null;
	private expectedAtMs = 0;
	private stopped = false;

	constructor(private readonly scheduler: RealtimeAsrScheduler) {}

	start(): void {
		if (this.timer !== null || this.stopped) return;
		this.expectedAtMs = this.scheduler.now() + 250;
		this.timer = this.scheduler.setTimeout(() => {
			this.timer = null;
			if (this.stopped) return;
			const now = this.scheduler.now();
			this.currentMs = safeMetric(Math.max(0, now - this.expectedAtMs));
			this.maxMs = Math.max(this.maxMs, this.currentMs);
			this.start();
		}, 250);
	}

	stop(): void {
		this.stopped = true;
		if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
		this.timer = null;
	}
}

class MeasuredTransport implements RealtimeAsrWebSocketTransport {
	constructor(
		private readonly inner: RealtimeAsrWebSocketTransport,
		private readonly metrics: WriteMetrics,
	) {}

	get bufferedAmount(): number { return this.inner.bufferedAmount; }
	get perMessageDeflateConfigured(): boolean { return this.inner.perMessageDeflateConfigured; }
	get perMessageDeflateNegotiated(): boolean { return this.inner.perMessageDeflateNegotiated; }
	connect(options: Parameters<RealtimeAsrWebSocketTransport['connect']>[0]): Promise<void> {
		return this.inner.connect(options);
	}
	sendText(message: string): Promise<void> { return this.inner.sendText(message); }
	sendBinary(data: Uint8Array): Promise<void> {
		const settle = this.metrics.beginWrite(this.inner.bufferedAmount);
		let write: Promise<void>;
		try {
			write = this.inner.sendBinary(data);
			this.metrics.observeBufferedAmount(this.inner.bufferedAmount);
		} catch (error) {
			settle(false, this.inner.bufferedAmount);
			throw error;
		}
		return write.then(
			() => { settle(true, this.inner.bufferedAmount); },
			(error: unknown) => {
				settle(false, this.inner.bufferedAmount);
				throw error;
			},
		);
	}
	close(): void { this.inner.close(); }
	dispose(): void { this.inner.dispose(); }
}

interface PendingMinimalSend {
	promise: Promise<void>;
	cancel(error: Error): void;
}

function dispatchMinimalBinary(
	socket: InstanceType<typeof WebSocket>,
	data: Uint8Array,
	metrics: WriteMetrics,
	scheduler: RealtimeAsrScheduler,
	signal: AbortSignal,
): PendingMinimalSend {
	const settleMetrics = metrics.beginWrite(socket.bufferedAmount);
	let settled = false;
	let timeout: unknown = null;
	let resolvePromise!: () => void;
	let rejectPromise!: (error: Error) => void;
	const promise = new Promise<void>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	void promise.catch(() => undefined);
	const abort = () => finish(new RealtimeAsrTransportError('remote-closed'));
	const finish = (error?: Error) => {
		if (settled) return;
		settled = true;
		if (timeout !== null) scheduler.clearTimeout(timeout);
		signal.removeEventListener('abort', abort);
		settleMetrics(!error, socket.bufferedAmount);
		data.fill(0);
		if (error) rejectPromise(error); else resolvePromise();
	};
	timeout = scheduler.setTimeout(
		() => finish(new RealtimeAsrError('audio-send-timeout')),
		SEND_TIMEOUT_MS,
	);
	signal.addEventListener('abort', abort, { once: true });
	try {
		socket.send(data, { binary: true, compress: false }, (error) => finish(
			error ? new RealtimeAsrTransportError('connection-failed') : undefined,
		));
		metrics.observeBufferedAmount(socket.bufferedAmount);
	} catch {
		finish(new RealtimeAsrTransportError('connection-failed'));
	}
	return { promise, cancel: (error) => finish(error) };
}

async function settleMinimalPending(
	pending: Set<PendingMinimalSend>,
	error: Error,
): Promise<void> {
	for (const entry of [...pending]) entry.cancel(error);
	await Promise.allSettled([...pending].map((entry) => entry.promise));
	pending.clear();
}

async function sendMinimalControl(
	socket: InstanceType<typeof WebSocket>,
	message: string,
	scheduler: RealtimeAsrScheduler,
	signal: AbortSignal,
): Promise<void> {
	await withDeadline(new Promise<void>((resolve, reject) => {
		try {
			socket.send(message, { binary: false, compress: false }, (error) => {
				if (error) reject(new RealtimeAsrError('connection-failed'));
				else resolve();
			});
		} catch {
			reject(new RealtimeAsrError('connection-failed'));
		}
	}), CONNECT_TIMEOUT_MS, scheduler, signal, 'connection-failed');
}

async function waitForSocketOpen(
	socket: InstanceType<typeof WebSocket>,
	scheduler: RealtimeAsrScheduler,
	signal: AbortSignal,
): Promise<void> {
	await withDeadline(new Promise<void>((resolve, reject) => {
		const open = () => { cleanup(); resolve(); };
		const error = () => { cleanup(); reject(new RealtimeAsrError('connection-failed')); };
		const close = () => { cleanup(); reject(new RealtimeAsrError('remote-closed')); };
		const abort = () => { cleanup(); reject(abortError()); };
		const cleanup = () => {
			socket.off('open', open);
			socket.off('error', error);
			socket.off('close', close);
			signal.removeEventListener('abort', abort);
		};
		socket.once('open', open);
		socket.once('error', error);
		socket.once('close', close);
		signal.addEventListener('abort', abort, { once: true });
		if (signal.aborted) abort();
	}), CONNECT_TIMEOUT_MS, scheduler, signal, 'connection-failed');
}

async function generatePacedDiagnosticAudio(options: {
	scheduler: RealtimeAsrScheduler;
	signal: AbortSignal;
	onChunk(chunkIndex: number, chunk: Uint8Array): void;
	onProgress(remainingMs: number): void;
}): Promise<void> {
	let previousDispatchAt: number | null = null;
	for (let chunkIndex = 0; chunkIndex < REALTIME_ASR_AB_TARGET_CHUNKS; chunkIndex += 1) {
		if (previousDispatchAt !== null) {
			await abortableDelay(
				Math.max(0, previousDispatchAt + CHUNK_INTERVAL_MS - options.scheduler.now()),
				options.scheduler,
				options.signal,
			);
		}
		if (options.signal.aborted) throw abortError();
		previousDispatchAt = options.scheduler.now();
		const chunk = createDiagnosticPcmChunk(chunkIndex);
		try {
			options.onChunk(chunkIndex, chunk);
		} catch (error) {
			chunk.fill(0);
			throw error;
		}
		const remainingMs = Math.max(
			0,
			REALTIME_ASR_AB_DURATION_MS - (chunkIndex + 1) * CHUNK_INTERVAL_MS,
		);
		if (remainingMs === 0 || remainingMs % 1_000 === 0) {
			options.onProgress(remainingMs);
		}
	}
	if (previousDispatchAt !== null) {
		await abortableDelay(
			Math.max(0, previousDispatchAt + CHUNK_INTERVAL_MS - options.scheduler.now()),
			options.scheduler,
			options.signal,
		);
	}
}

/**
 * Drives the production-route PCM source from an absolute monotonic media
 * timeline. It never waits for Provider queue or callback settlement. When the
 * event loop wakes late, overdue source chunks are produced on subsequent
 * turns from their original media deadlines instead of slowing down with the
 * consumer.
 */
async function generateAbsoluteDiagnosticAudio(options: {
	scheduler: RealtimeAsrScheduler;
	signal: AbortSignal;
	onChunk(chunkIndex: number, chunk: Uint8Array): void;
	onProgress(remainingMs: number): void;
}): Promise<void> {
	const mediaEpochMs = options.scheduler.now();
	for (let chunkIndex = 0; chunkIndex < REALTIME_ASR_AB_TARGET_CHUNKS; chunkIndex += 1) {
		const dueAt = mediaEpochMs + chunkIndex * CHUNK_INTERVAL_MS;
		await abortableDelay(
			Math.max(0, dueAt - options.scheduler.now()),
			options.scheduler,
			options.signal,
		);
		if (options.signal.aborted) throw abortError();
		const chunk = createDiagnosticPcmChunk(chunkIndex);
		try {
			options.onChunk(chunkIndex, chunk);
		} catch (error) {
			chunk.fill(0);
			throw error;
		}
		const remainingMs = Math.max(
			0,
			REALTIME_ASR_AB_DURATION_MS - (chunkIndex + 1) * CHUNK_INTERVAL_MS,
		);
		if (remainingMs === 0 || remainingMs % 1_000 === 0) {
			options.onProgress(remainingMs);
		}
	}
	await abortableDelay(
		Math.max(0, mediaEpochMs + REALTIME_ASR_AB_DURATION_MS - options.scheduler.now()),
		options.scheduler,
		options.signal,
	);
}

function feedProviderChunk(
	provider: BailianStreamingAsrProvider,
	chunkIndex: number,
	chunk: Uint8Array,
): void {
	try {
		for (let frameIndex = 0; frameIndex < 5; frameIndex += 1) {
			const sequence = chunkIndex * 5 + frameIndex;
			const start = frameIndex * REALTIME_ASR_FRAME_BYTES;
			const pcm = chunk.slice(start, start + REALTIME_ASR_FRAME_BYTES);
			const frame: AudioCompanionFrame = {
				sequence,
				offsetMs: sequence * 20,
				sampleCount: 320,
				durationMs: 20,
				sampleRate: 16_000,
				channels: 1,
				sampleFormat: 's16le',
				pcm,
			};
			try {
				provider.acceptFrame(frame);
			} finally {
				pcm.fill(0);
			}
		}
	} finally {
		chunk.fill(0);
	}
}

interface ResultInput {
	runnerKind: RealtimeAsrTransportAbRunnerKind;
	startedAt: number;
	now: number;
	cancelled: boolean;
	completedGeneration: boolean;
	stableErrorCode: RealtimeAsrTransportAbStableErrorCode | null;
	dispatchCount: number;
	successCount: number;
	failureCount: number;
	callbackSettledCount: number;
	finalInFlightCount: number;
	maxInFlightCount: number;
	finalQueuedCount: number;
	maxQueuedCount: number;
	metrics: WriteMetrics;
	oldestInFlightAgeMs: number | null;
	maxObservedInFlightAgeMs: number;
	finalBufferedAmount: number;
	minDispatchIntervalMs: number | null;
	maxDispatchIntervalMs: number | null;
	maxDispatchBurstCount: number;
	dispatchedAudioDurationMs: number;
	currentDispatchLeadMs: number;
	maxDispatchLeadMs: number;
	taskStartedEventCount: number;
	resultGeneratedEventCount: number;
	taskFailedEventCount: number;
	taskFinishedEventCount: number;
	unknownEventCount: number;
	perMessageDeflateConfigured: boolean;
	perMessageDeflateNegotiated: boolean;
	intervalSamples: RealtimeAsrTransportAbIntervalSample[];
}

function buildResult(input: ResultInput): Omit<RealtimeAsrTransportAbResult, 'status'> {
	const sortedLatencies = [...input.metrics.latencies].sort((left, right) => left - right);
	return {
		runnerKind: input.runnerKind,
		durationTargetMs: REALTIME_ASR_AB_DURATION_MS,
		wallElapsedMs: Math.max(0, input.now - input.startedAt),
		cancelled: input.cancelled,
		completed: input.completedGeneration && !input.stableErrorCode && !input.cancelled,
		stableErrorCode: input.stableErrorCode,
		targetChunkCount: REALTIME_ASR_AB_TARGET_CHUNKS,
		dispatchCount: input.dispatchCount,
		successCount: input.successCount,
		failureCount: input.failureCount,
		callbackSettledCount: input.callbackSettledCount,
		finalInFlightCount: input.finalInFlightCount,
		maxInFlightCount: input.maxInFlightCount,
		finalQueuedCount: input.finalQueuedCount,
		maxQueuedCount: input.maxQueuedCount,
		lastSendWriteLatencyMs: input.metrics.lastSendWriteLatencyMs,
		averageSendWriteLatencyMs: input.metrics.averageLatencyMs,
		p50SendWriteLatencyMs: percentile(sortedLatencies, 0.5),
		p95SendWriteLatencyMs: percentile(sortedLatencies, 0.95),
		p99SendWriteLatencyMs: percentile(sortedLatencies, 0.99),
		maxSendWriteLatencyMs: input.metrics.maxSendWriteLatencyMs,
		oldestInFlightAgeMs: input.oldestInFlightAgeMs,
		maxObservedInFlightAgeMs: input.maxObservedInFlightAgeMs,
		finalBufferedAmount: safeMetric(input.finalBufferedAmount),
		maxBufferedAmount: input.metrics.maxBufferedAmount,
		minDispatchIntervalMs: input.minDispatchIntervalMs,
		maxDispatchIntervalMs: input.maxDispatchIntervalMs,
		maxDispatchBurstCount: input.maxDispatchBurstCount,
		dispatchedAudioDurationMs: input.dispatchedAudioDurationMs,
		currentDispatchLeadMs: input.currentDispatchLeadMs,
		maxDispatchLeadMs: input.maxDispatchLeadMs,
		taskStartedEventCount: input.taskStartedEventCount,
		resultGeneratedEventCount: input.resultGeneratedEventCount,
		taskFailedEventCount: input.taskFailedEventCount,
		taskFinishedEventCount: input.taskFinishedEventCount,
		unknownEventCount: input.unknownEventCount,
		perMessageDeflateConfigured: input.perMessageDeflateConfigured,
		perMessageDeflateNegotiated: input.perMessageDeflateNegotiated,
		intervalSamples: input.intervalSamples.map((sample) => ({ ...sample })),
	};
}

function emptyRunnerDiagnostics(): RealtimeAsrDiagnostics {
	return {
		eventLoopLagCurrentMs: 0, eventLoopLagMaxMs: 0, eventLoopLagP95Ms: 0,
		providerStatePublishCount: 0, providerStatePublishRate: 0,
		sessionNotificationCount: 0, sessionNotificationRate: 0,
		workbenchRenderCount: 0, workbenchRenderRate: 0,
		workbenchLastRenderDurationMs: 0, workbenchMaxRenderDurationMs: 0,
		maxStateListenerDurationMs: 0,
		perMessageDeflateConfigured: false, perMessageDeflateNegotiated: false,
		producedChunkCount: 0, sentChunkCount: 0, queuedChunkCount: 0,
		inFlightSendCount: 0, outstandingChunkCount: 0, maxOutstandingChunkCount: 0,
		wsBufferedAmount: 0, maxWsBufferedAmount: 0, sendWriteLatencyMs: null,
		oldestInFlightAgeMs: null, maxObservedInFlightAgeMs: 0, dispatchChunkCount: 0,
		sendCallbackSuccessCount: 0, sendCallbackFailureCount: 0,
		sendCallbackSettledCount: 0, overflowReason: null, socketOpen: false,
		taskStarted: false, audioSendReady: false, pumpActive: false, pumpScheduled: false,
		stopping: false, lastPumpBlockReason: 'socket-not-open', socketEverOpened: false,
		runTaskEverSent: false, taskEverStarted: false, firstAudioEverDispatched: false,
		warmupQueuedChunkCount: 0, warmupDroppedChunkCount: 0, warmupDroppedDurationMs: 0,
		inboundMessageCount: 0, taskStartedEventCount: 0, resultGeneratedEventCount: 0,
		taskFailedEventCount: 0, taskFinishedEventCount: 0, ignoredHeartbeatCount: 0,
		unknownEventCount: 0, lastInboundEventKind: 'none', lastInboundEventAgeMs: null,
		firstResultGeneratedLatencyMs: null, liveWallElapsedMs: 0,
		producedAudioDurationMs: 0, dispatchedAudioDurationMs: 0,
		currentDispatchLeadMs: 0, maxDispatchLeadMs: 0,
		minDispatchIntervalMs: null, averageDispatchIntervalMs: 0,
		currentDeadlineLatenessMs: 0, maxDeadlineLatenessMs: 0,
		controlledRecoveryDispatchCount: 0, schedulerWakeupCount: 0,
		maxDispatchBurstCount: 0,
	};
}

function cloneProgress(progress: RealtimeAsrTransportAbProgress): RealtimeAsrTransportAbProgress {
	return {
		...progress,
		currentResult: progress.currentResult ? cloneResult(progress.currentResult) : null,
		minimalResult: progress.minimalResult ? cloneResult(progress.minimalResult) : null,
		comparison: progress.comparison ? {
			...progress.comparison,
			currentTransport: cloneResult(progress.comparison.currentTransport),
			officialSequenceMinimal: cloneResult(progress.comparison.officialSequenceMinimal),
		} : null,
	};
}

function cloneResult(result: RealtimeAsrTransportAbResult): RealtimeAsrTransportAbResult {
	return {
		...result,
		intervalSamples: result.intervalSamples.map((sample) => ({ ...sample })),
	};
}

function emptyProgress(): RealtimeAsrTransportAbProgress {
	return {
		phase: 'idle', remainingMs: 0, currentResult: null, minimalResult: null, comparison: null,
	};
}

function safeErrorCode(error: unknown): RealtimeAsrTransportAbStableErrorCode {
	if (error instanceof RealtimeAsrError || error instanceof RealtimeAsrTransportError) {
		return error.code;
	}
	return 'diagnostic-internal-error';
}

function percentile(values: number[], ratio: number): number {
	if (values.length === 0) return 0;
	return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1))] ?? 0;
}

function percentileAverage(values: number[]): number {
	if (values.length === 0) return 0;
	return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function safeMetric(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0;
	return Math.min(Number.MAX_SAFE_INTEGER, Math.round(value));
}

function hasPerMessageDeflate(extensions: string): boolean {
	return extensions.split(',').some((value) => value.trim().toLowerCase() === 'permessage-deflate');
}

function decodeTextData(data: RawData): string {
	if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
	if (Array.isArray(data)) {
		const length = data.reduce((total, part) => total + part.byteLength, 0);
		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const part of data) {
			bytes.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), offset);
			offset += part.byteLength;
		}
		return new TextDecoder().decode(bytes);
	}
	return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve(value?: T): void;
	reject(error: Error): void;
} {
	let resolvePromise!: (value: T | PromiseLike<T>) => void;
	let rejectPromise!: (error: Error) => void;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	void promise.catch(() => undefined);
	return {
		promise,
		resolve: (value?: T) => resolvePromise(value as T),
		reject: rejectPromise,
	};
}

async function withDeadline(
	promise: Promise<void>,
	delayMs: number,
	scheduler: RealtimeAsrScheduler,
	signal: AbortSignal,
	code: RealtimeAsrErrorCode,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			scheduler.clearTimeout(timer);
			signal.removeEventListener('abort', abort);
			if (error) reject(error); else resolve();
		};
		const abort = () => finish(abortError());
		const timer = scheduler.setTimeout(
			() => finish(new RealtimeAsrError(code)),
			delayMs,
		);
		signal.addEventListener('abort', abort, { once: true });
		promise.then(() => finish(), (error: unknown) => finish(
			error instanceof Error ? error : new RealtimeAsrError(code),
		));
		if (signal.aborted) abort();
	});
}

function waitForCleanup(
	promise: Promise<void>,
	delayMs: number,
	scheduler: RealtimeAsrScheduler,
): Promise<void> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			scheduler.clearTimeout(timer);
			resolve();
		};
		const timer = scheduler.setTimeout(finish, delayMs);
		promise.then(finish, finish);
	});
}

function abortableDelay(
	delayMs: number,
	scheduler: RealtimeAsrScheduler,
	signal: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			scheduler.clearTimeout(timer);
			signal.removeEventListener('abort', abort);
			if (error) reject(error); else resolve();
		};
		const abort = () => finish(abortError());
		const timer = scheduler.setTimeout(() => finish(), Math.max(0, delayMs));
		signal.addEventListener('abort', abort, { once: true });
		if (signal.aborted) abort();
	});
}

function abortError(): Error {
	const error = new Error('Diagnostic cancelled.');
	error.name = 'AbortError';
	return error;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}

function browserScheduler(): RealtimeAsrScheduler {
	return {
		now: () => performance.now(),
		setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
		clearTimeout: (handle) => window.clearTimeout(handle as number),
	};
}
