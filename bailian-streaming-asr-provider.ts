import type { AudioCompanionFrame } from './audio-companion-types';
import {
	AudioChunkAggregator,
	type RealtimeAsrAudioChunk,
} from './audio-chunk-aggregator';
import {
	buildBailianAsrEndpoint,
	buildBailianFinishTask,
	buildBailianRunTask,
	classifyBailianAsrInboundEvent,
	parseBailianAsrServerEvent,
} from './bailian-asr-protocol';
import type {
	RealtimeAsrConfiguration,
	RealtimeAsrDiagnostics,
	RealtimeAsrErrorCode,
	RealtimeAsrOverflowReason,
	RealtimeAsrPumpBlockReason,
	RealtimeAsrProvider,
	RealtimeAsrProviderCallbacks,
	RealtimeAsrScheduler,
	RealtimeAsrTransportFactory,
} from './realtime-asr-types';
import {
	REALTIME_ASR_MAX_BUFFERED_AMOUNT,
	REALTIME_ASR_CHUNK_BYTES,
	REALTIME_ASR_FRAME_BYTES,
	REALTIME_ASR_MAX_PENDING_SENDS,
	REALTIME_ASR_MAX_QUEUED_CHUNKS,
	REALTIME_ASR_MAX_WARMUP_CHUNKS,
	REALTIME_ASR_MIN_RECOVERY_INTERVAL_MS,
	RealtimeAsrError,
	RealtimeAsrTransportError,
	realtimeAsrClientFrameOverhead,
} from './realtime-asr-types';

const TASK_START_TIMEOUT_MS = 10_000;
const FINISH_TIMEOUT_MS = 8_000;
const CONNECT_TIMEOUT_MS = 10_000;
const CONTROL_SEND_TIMEOUT_MS = 5_000;
const BINARY_SEND_TIMEOUT_MS = 10_000;
const STOP_DRAIN_TIMEOUT_MS = 11_000;
const BUFFER_REPUMP_DELAY_MS = 50;
const MEDIA_CHUNK_INTERVAL_MS = 100;
const FULL_RECOVERY_DEBT_MS = 2_000;
const EVENT_LOOP_LAG_SAMPLE_LIMIT = 256;

interface DispatchChunk extends RealtimeAsrAudioChunk {
	source: 'warmup' | 'live';
	ordinal: number;
	settled: boolean;
	dispatchedAt: number | null;
}

interface InFlightLifecycleDiagnostic {
	dispatchOrdinal: number;
	dispatchedAtMs: number;
	currentAgeMs: number;
}

export interface BailianStreamingAsrProviderOptions {
	configuration: RealtimeAsrConfiguration;
	getApiKey(): string;
	transportFactory: RealtimeAsrTransportFactory;
	taskIdFactory(): string;
	callbacks: RealtimeAsrProviderCallbacks;
	scheduler?: RealtimeAsrScheduler;
}

export class BailianStreamingAsrProvider implements RealtimeAsrProvider {
	private readonly scheduler: RealtimeAsrScheduler;
	private readonly aggregator = new AudioChunkAggregator();
	private readonly taskId: string;
	private transport: ReturnType<RealtimeAsrTransportFactory> | null = null;
	private warmupQueue: DispatchChunk[] = [];
	private queue: DispatchChunk[] = [];
	private readonly inFlight = new Map<number, DispatchChunk>();
	private drainWait: Deferred<void> | null = null;
	private socketOpen = false;
	private taskStarted = false;
	private audioSendReady = false;
	private pumpActive = false;
	private pumpRequested = false;
	private pumpTimer: unknown = null;
	private pumpTimerDueAt: number | null = null;
	private nextMediaDeadlineMs: number | null = null;
	private drainWhileStopping = false;
	private stopping = false;
	private finished = false;
	private disposed = false;
	private startWait: Deferred<void> | null = null;
	private finishWait: Deferred<void> | null = null;
	private signal: AbortSignal | null = null;
	private readonly lifecycleAbort = new AbortController();
	private externalAbort: (() => void) | null = null;
	private sentFrameCount = 0;
	private audioBaseOffsetMs: number | null = null;
	private firstDispatchedOrdinal: number | null = null;
	private nextOrdinal = 0;
	private lastInboundAtMs: number | null = null;
	private taskStartedAtMs: number | null = null;
	private liveStartedAtMs: number | null = null;
	private lastDispatchAtMs: number | null = null;
	private dispatchIntervalTotalMs = 0;
	private dispatchIntervalCount = 0;
	private dispatchBurstCount = 0;
	private consecutiveRecoveryDispatches = 0;
	private eventLoopLagSamples: number[] = [];
	private readonly progressStartedAtMs: number;
	private diagnostics: RealtimeAsrDiagnostics = emptyDiagnostics();

	constructor(private readonly options: BailianStreamingAsrProviderOptions) {
		this.scheduler = options.scheduler ?? browserScheduler();
		this.taskId = options.taskIdFactory();
		this.progressStartedAtMs = this.scheduler.now();
	}

	async start(signal: AbortSignal): Promise<void> {
		if (this.disposed || this.transport) {
			throw new RealtimeAsrError('connection-failed');
		}
		const endpoint = buildBailianAsrEndpoint(
			this.options.configuration.region,
			this.options.configuration.workspaceId,
		);
		if (!endpoint || !this.options.configuration.model) {
			throw new RealtimeAsrError('configuration-error');
		}
		this.signal = signal;
		this.externalAbort = () => this.lifecycleAbort.abort();
		signal.addEventListener('abort', this.externalAbort, { once: true });
		if (signal.aborted) this.externalAbort();
		this.options.callbacks.onPhase('connecting');
		const transport = this.options.transportFactory();
		this.transport = transport;
		this.captureCompressionDiagnostics(transport);
		try {
			try {
				await this.connectTransport(transport, endpoint);
			} finally {
				this.captureCompressionDiagnostics(transport);
			}
			this.assertActive();
			this.socketOpen = true;
			this.diagnostics.socketEverOpened = true;
			this.requestPump();
			this.options.callbacks.onPhase('starting-task');
			this.startWait = deferred<void>();
			await withTimeout(transport.sendText(buildBailianRunTask(
				this.taskId,
				this.options.configuration.model,
			)), CONTROL_SEND_TIMEOUT_MS, this.scheduler, this.lifecycleAbort.signal, 'connection-failed');
			this.diagnostics.runTaskEverSent = true;
			this.publishProgress();
			await withTimeout(
				this.startWait.promise,
				TASK_START_TIMEOUT_MS,
				this.scheduler,
				this.lifecycleAbort.signal,
				'task-start-failed',
			);
			if (!this.taskStarted || !this.audioSendReady) {
				throw new RealtimeAsrError('protocol-error');
			}
		} catch (error) {
			const code = mapProviderError(error);
			this.fail(code);
			throw new RealtimeAsrError(code);
		}
	}

	private captureCompressionDiagnostics(
		transport: ReturnType<RealtimeAsrTransportFactory>,
	): void {
		this.diagnostics.perMessageDeflateConfigured
			= transport.perMessageDeflateConfigured === true;
		this.diagnostics.perMessageDeflateNegotiated
			= transport.perMessageDeflateNegotiated === true;
		this.publishProgress();
	}

	private async connectTransport(
		transport: ReturnType<RealtimeAsrTransportFactory>,
		endpoint: string,
	): Promise<void> {
		let apiKey = this.options.getApiKey().trim();
		if (!apiKey) throw new RealtimeAsrError('configuration-error');
		let authorization = `Bearer ${apiKey}`;
		try {
			await withTimeout(transport.connect({
				endpoint,
				authorization,
				signal: this.lifecycleAbort.signal,
				handlers: {
					onText: (message) => this.handleText(message),
					onBinary: () => this.fail('protocol-error'),
					onClose: () => this.fail('remote-closed'),
					onError: (error) => this.fail(mapTransportError(error)),
				},
			}), CONNECT_TIMEOUT_MS, this.scheduler, this.lifecycleAbort.signal, 'connection-failed');
		} finally {
			apiKey = '';
			authorization = '';
		}
	}

	acceptFrame(frame: AudioCompanionFrame): void {
		if (this.disposed || this.finished || this.stopping) return;
		try {
			const chunk = this.aggregator.push(frame);
			if (!chunk) return;
			if (this.audioSendReady) {
				this.enqueueLive(this.prepareChunk(chunk, 'live'));
			} else {
				this.enqueueWarmup(this.prepareChunk(chunk, 'warmup'));
			}
		} catch (error) {
			this.fail(mapProviderError(error));
		}
	}

	async stop(): Promise<void> {
		if (this.disposed || this.finished) return;
		if (this.stopping) {
			await this.finishWait?.promise.catch(() => undefined);
			return;
		}
		this.stopping = true;
		this.drainWhileStopping = true;
		this.refreshPumpDiagnostics();
		this.options.callbacks.onPhase('stopping');
		try {
			if (!this.taskStarted || !this.transport) {
				this.finished = true;
				this.startWait?.reject(new RealtimeAsrError('connection-failed'));
				this.close();
				return;
			}
			const residual = this.aggregator.flushResidual();
			if (residual) this.enqueueLive(this.prepareChunk(residual, 'live'), true);
			this.requestPump();
			await withTimeout(
				this.waitForDrain(),
				STOP_DRAIN_TIMEOUT_MS,
				this.scheduler,
				this.lifecycleAbort.signal,
				'audio-send-timeout',
			);
			if (!this.transport) throw new RealtimeAsrError('connection-failed');
			this.finishWait = deferred<void>();
			await withTimeout(
				this.transport.sendText(buildBailianFinishTask(this.taskId)),
				CONTROL_SEND_TIMEOUT_MS,
				this.scheduler,
				this.lifecycleAbort.signal,
				'connection-failed',
			);
			await withTimeout(
				this.finishWait.promise,
				FINISH_TIMEOUT_MS,
				this.scheduler,
				this.lifecycleAbort.signal,
				'finish-timeout',
			);
		} catch (error) {
			const code = mapProviderError(error);
			if (!this.disposed && !this.lifecycleAbort.signal.aborted) this.fail(code);
		} finally {
			this.close();
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.lifecycleAbort.abort();
		this.close();
	}

	private handleText(message: string): void {
		if (this.disposed || this.finished) return;
		const classifiedKind = classifyBailianAsrInboundEvent(message, this.taskId);
		this.diagnostics.inboundMessageCount += 1;
		this.lastInboundAtMs = this.scheduler.now();
		this.diagnostics.lastInboundEventKind = classifiedKind;
		if (classifiedKind === 'unknown') this.diagnostics.unknownEventCount += 1;
		try {
			const event = parseBailianAsrServerEvent(message, this.taskId);
			switch (event.type) {
				case 'task-started':
					if (this.taskStarted || this.stopping) throw new RealtimeAsrError('protocol-error');
					this.diagnostics.taskStartedEventCount += 1;
					this.taskStarted = true;
					this.audioSendReady = true;
					this.diagnostics.taskEverStarted = true;
					this.taskStartedAtMs = this.scheduler.now();
					this.discardWarmupQueue();
					this.requestPump();
					if (this.disposed || this.finished || !this.audioSendReady) return;
					this.startWait?.resolve();
					this.options.callbacks.onPhase('streaming');
					return;
				case 'result-generated':
					if (!this.taskStarted) throw new RealtimeAsrError('protocol-error');
					this.diagnostics.resultGeneratedEventCount += 1;
					if (this.diagnostics.firstResultGeneratedLatencyMs === null
						&& this.taskStartedAtMs !== null) {
						this.diagnostics.firstResultGeneratedLatencyMs = Math.max(
							0,
							this.scheduler.now() - this.taskStartedAtMs,
						);
					}
					if (event.heartbeat) {
						this.diagnostics.ignoredHeartbeatCount += 1;
						this.diagnostics.lastInboundEventKind = 'heartbeat';
					} else {
						this.options.callbacks.onSegment(event.segment);
					}
					this.publishProgress();
					return;
				case 'task-finished':
					this.diagnostics.taskFinishedEventCount += 1;
					if (!this.stopping) throw new RealtimeAsrError('protocol-error');
					this.finished = true;
					this.finishWait?.resolve();
					return;
				case 'task-failed':
					this.diagnostics.taskFailedEventCount += 1;
					this.publishProgress();
					this.fail('task-failed');
					return;
			}
		} catch (error) {
			this.fail(mapProviderError(error));
		}
	}

	private prepareChunk(
		chunk: RealtimeAsrAudioChunk,
		source: DispatchChunk['source'],
	): DispatchChunk {
		if (chunk.data.byteLength < REALTIME_ASR_FRAME_BYTES
			|| chunk.data.byteLength > REALTIME_ASR_CHUNK_BYTES
			|| chunk.data.byteLength % REALTIME_ASR_FRAME_BYTES !== 0) {
			throw new RealtimeAsrError('audio-format-invalid');
		}
		const prepared = {
			...chunk,
			source,
			ordinal: this.nextOrdinal++,
			settled: false,
			dispatchedAt: null,
		};
		this.diagnostics.producedChunkCount += 1;
		if (source === 'live') {
			this.liveStartedAtMs ??= this.scheduler.now();
			this.diagnostics.producedAudioDurationMs += chunk.frameCount * 20;
		}
		this.publishProgress();
		return prepared;
	}

	private enqueueWarmup(chunk: DispatchChunk): void {
		if (this.stopping || this.disposed || this.finished) {
			chunk.data.fill(0);
			return;
		}
		if (this.warmupQueue.length >= REALTIME_ASR_MAX_WARMUP_CHUNKS) {
			const dropped = this.warmupQueue.shift();
			if (dropped) {
				dropped.data.fill(0);
				this.diagnostics.warmupDroppedChunkCount += 1;
				this.diagnostics.warmupDroppedDurationMs += dropped.frameCount * 20;
			}
		}
		this.warmupQueue.push(chunk);
		this.refreshQueueDiagnostics();
		this.publishProgress();
		this.requestPump();
	}

	/**
	 * Warm-up audio is a bounded startup safety buffer, not replay input. Once the
	 * remote task is ready, discard it so startup backlog cannot consume live
	 * sender capacity. The existing dropped counters intentionally include both
	 * rolling eviction and this task-start discard.
	 */
	private discardWarmupQueue(): void {
		for (const chunk of this.warmupQueue) {
			chunk.data.fill(0);
			this.diagnostics.warmupDroppedChunkCount += 1;
			this.diagnostics.warmupDroppedDurationMs += chunk.frameCount * 20;
		}
		this.warmupQueue = [];
		this.refreshQueueDiagnostics();
		this.publishProgress();
	}

	private enqueueLive(chunk: DispatchChunk, allowWhileStopping = false): void {
		if ((!allowWhileStopping && this.stopping) || this.disposed || this.finished) {
			chunk.data.fill(0);
			return;
		}
		if (this.queue.length >= REALTIME_ASR_MAX_QUEUED_CHUNKS) {
			chunk.data.fill(0);
			this.overflow('app-queue-limit');
			return;
		}
		this.queue.push(chunk);
		this.refreshQueueDiagnostics();
		this.publishProgress();
		this.requestPump();
	}

	private outstandingChunkCount(): number {
		return this.warmupQueue.length + this.queue.length + this.inFlight.size;
	}

	private liveOutstandingChunkCount(): number {
		return this.queue.length;
	}

	private requestPump(): void {
		this.pumpRequested = true;
		this.refreshPumpDiagnostics();
		if (this.pumpActive) {
			this.publishProgress();
			return;
		}
		this.cancelPumpTimer();
		this.pumpActive = true;
		this.refreshPumpDiagnostics();
		try {
			this.pumpRequested = false;
			this.refreshPumpDiagnostics();
			this.drainPump();
		} finally {
			this.pumpActive = false;
			if (this.pumpRequested && !this.disposed && !this.finished) {
				const dueAt = this.pumpTimerDueAt
					?? this.nextDispatchNotBeforeMs()
					?? this.scheduler.now();
				this.schedulePumpAt(dueAt);
			}
			this.refreshPumpDiagnostics();
			this.publishProgress();
		}
	}

	private drainPump(): void {
		const blockReason = this.pumpBlockReason();
		this.diagnostics.lastPumpBlockReason = blockReason;
		if (blockReason === 'media-deadline') {
			const dueAt = this.nextDispatchNotBeforeMs();
			if (dueAt !== null) this.schedulePumpAt(dueAt);
			return;
		}
		if (blockReason === 'ws-buffer-limit') {
			this.schedulePumpAt(this.scheduler.now() + BUFFER_REPUMP_DELAY_MS);
			return;
		}
		if (blockReason !== 'none') return;
		const transport = this.transport;
		if (!transport) {
			this.fail('connection-failed');
			return;
		}
		const chunk = this.queue.shift();
		if (!chunk) return;
		const dispatchedAt = this.scheduler.now();
		chunk.dispatchedAt = dispatchedAt;
		this.inFlight.set(chunk.ordinal, chunk);
		this.diagnostics.dispatchChunkCount += 1;
		this.recordMediaDispatch(chunk, dispatchedAt);
		this.nextMediaDeadlineMs = this.nextAbsoluteMediaDeadline(
			dispatchedAt,
			chunk.frameCount * 20,
		);
		this.refreshQueueDiagnostics();
		this.publishProgress();
		let send: Promise<void>;
		try {
			if (chunk.settled
				|| this.inFlight.get(chunk.ordinal) !== chunk
				|| this.disposed
				|| this.finished) {
				throw new RealtimeAsrError('connection-failed');
			}
			if (this.firstDispatchedOrdinal === null) {
				this.firstDispatchedOrdinal = chunk.ordinal;
				this.diagnostics.firstAudioEverDispatched = true;
				this.publishProgress();
			}
			send = Promise.resolve(transport.sendBinary(chunk.data));
		} catch (error) {
			this.settleSend(chunk, mapProviderError(error));
			return;
		}
		void withTimeout(
			send,
			BINARY_SEND_TIMEOUT_MS,
			this.scheduler,
			this.lifecycleAbort.signal,
			'audio-send-timeout',
		).then(
			() => this.settleSend(chunk, null),
			(error: unknown) => this.settleSend(chunk, mapProviderError(error)),
		);
		if (this.queue.length > 0) this.schedulePumpAt(this.nextMediaDeadlineMs);
	}

	private pumpBlockReason(): RealtimeAsrPumpBlockReason {
		if (this.disposed) return 'disposed';
		if (this.finished) return 'finished';
		if (this.stopping && !this.drainWhileStopping) return 'stopping';
		if (!this.socketOpen || !this.transport) return 'socket-not-open';
		if (!this.taskStarted) return 'task-not-started';
		if (!this.audioSendReady) return 'audio-not-ready';
		if (this.queue.length === 0) return 'queue-empty';
		if (this.inFlight.size >= REALTIME_ASR_MAX_PENDING_SENDS) {
			return 'pending-callback-limit';
		}
		const dispatchNotBeforeMs = this.nextDispatchNotBeforeMs();
		if (dispatchNotBeforeMs !== null
			&& this.scheduler.now() < dispatchNotBeforeMs) {
			return 'media-deadline';
		}
		const transport = this.transport;
		this.sampleWsBufferedAmount(transport.bufferedAmount);
		const chunk = this.queue[0];
		if (!chunk) return 'queue-empty';
		const projectedBufferedAmount = transport.bufferedAmount
			+ chunk.data.byteLength
			+ realtimeAsrClientFrameOverhead(chunk.data.byteLength);
		if (projectedBufferedAmount > REALTIME_ASR_MAX_BUFFERED_AMOUNT) {
			return 'ws-buffer-limit';
		}
		return 'none';
	}

	private schedulePumpAt(dueAt: number): void {
		if (this.disposed || this.finished) return;
		const normalizedDueAt = Math.max(this.scheduler.now(), dueAt);
		if (this.pumpTimer !== null
			&& this.pumpTimerDueAt !== null
			&& this.pumpTimerDueAt <= normalizedDueAt) return;
		this.cancelPumpTimer();
		this.pumpTimerDueAt = normalizedDueAt;
		this.pumpTimer = this.scheduler.setTimeout(() => {
			this.pumpTimer = null;
			this.pumpTimerDueAt = null;
			this.recordEventLoopLag(normalizedDueAt);
			this.diagnostics.schedulerWakeupCount += 1;
			if (!this.disposed && !this.finished) this.requestPump();
		}, Math.max(0, normalizedDueAt - this.scheduler.now()));
		this.refreshPumpDiagnostics();
	}

	private cancelPumpTimer(): void {
		if (this.pumpTimer === null) return;
		this.scheduler.clearTimeout(this.pumpTimer);
		this.pumpTimer = null;
		this.pumpTimerDueAt = null;
	}

	private settleSend(chunk: DispatchChunk, error: RealtimeAsrErrorCode | null): void {
		if (chunk.settled || this.inFlight.get(chunk.ordinal) !== chunk) return;
		chunk.settled = true;
		this.inFlight.delete(chunk.ordinal);
		this.diagnostics.sendCallbackSettledCount += 1;
		if (error) this.diagnostics.sendCallbackFailureCount += 1;
		else this.diagnostics.sendCallbackSuccessCount += 1;
		if (chunk.dispatchedAt !== null) {
			this.diagnostics.sendWriteLatencyMs = Math.max(
				0,
				this.scheduler.now() - chunk.dispatchedAt,
			);
		}
		this.sampleWsBufferedAmount(this.transport?.bufferedAmount ?? 0);
		if (error) {
			this.refreshQueueDiagnostics();
			this.publishProgress();
			this.rejectDrain(error);
			try {
				this.fail(error);
			} finally {
				chunk.data.fill(0);
			}
			return;
		}
		if (chunk.ordinal === this.firstDispatchedOrdinal) {
			this.audioBaseOffsetMs = chunk.firstOffsetMs;
		}
		this.sentFrameCount += chunk.frameCount;
		this.diagnostics.sentChunkCount += 1;
		chunk.data.fill(0);
		this.refreshQueueDiagnostics();
		this.publishProgress();
		this.resolveDrainIfIdle();
		this.requestPump();
	}

	private waitForDrain(): Promise<void> {
		if (this.outstandingChunkCount() === 0) return Promise.resolve();
		this.drainWait ??= deferred<void>();
		return this.drainWait.promise;
	}

	private resolveDrainIfIdle(): void {
		if (this.outstandingChunkCount() !== 0 || !this.drainWait) return;
		const wait = this.drainWait;
		this.drainWait = null;
		wait.resolve();
	}

	private rejectDrain(code: RealtimeAsrErrorCode): void {
		const wait = this.drainWait;
		this.drainWait = null;
		wait?.reject(new RealtimeAsrError(code));
	}

	private overflow(reason: RealtimeAsrOverflowReason): void {
		this.diagnostics.overflowReason = reason;
		this.refreshQueueDiagnostics();
		this.publishProgress();
		this.rejectDrain('audio-buffer-overflow');
		this.fail('audio-buffer-overflow');
	}

	private sampleWsBufferedAmount(value: number): void {
		const safeValue = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
		this.diagnostics.wsBufferedAmount = safeValue;
		this.diagnostics.maxWsBufferedAmount = Math.max(
			this.diagnostics.maxWsBufferedAmount,
			safeValue,
		);
	}

	private recordMediaDispatch(chunk: DispatchChunk, dispatchedAt: number): void {
		const nominalDeadline = this.nominalMediaDeadline();
		const deadlineLateness = nominalDeadline === null
			? 0
			: Math.max(0, dispatchedAt - nominalDeadline);
		this.diagnostics.currentDeadlineLatenessMs = deadlineLateness;
		this.diagnostics.maxDeadlineLatenessMs = Math.max(
			this.diagnostics.maxDeadlineLatenessMs,
			deadlineLateness,
		);
		if (this.lastDispatchAtMs === dispatchedAt) {
			this.dispatchBurstCount += 1;
		} else {
			if (this.lastDispatchAtMs !== null) {
				const interval = Math.max(0, dispatchedAt - this.lastDispatchAtMs);
				this.dispatchIntervalTotalMs += interval;
				this.dispatchIntervalCount += 1;
				this.diagnostics.minDispatchIntervalMs = this.diagnostics.minDispatchIntervalMs === null
					? interval
					: Math.min(this.diagnostics.minDispatchIntervalMs, interval);
				this.diagnostics.averageDispatchIntervalMs = roundMetric(
					this.dispatchIntervalTotalMs / this.dispatchIntervalCount,
				);
				if (interval < MEDIA_CHUNK_INTERVAL_MS) {
					this.diagnostics.controlledRecoveryDispatchCount += 1;
				}
			}
			this.dispatchBurstCount = 1;
		}
		this.lastDispatchAtMs = dispatchedAt;
		this.diagnostics.maxDispatchBurstCount = Math.max(
			this.diagnostics.maxDispatchBurstCount,
			this.dispatchBurstCount,
		);
		this.diagnostics.dispatchedAudioDurationMs += chunk.frameCount * 20;
		this.refreshMediaClockDiagnostics();
	}

	private nominalMediaDeadline(): number | null {
		if (this.liveStartedAtMs === null) return null;
		return this.liveStartedAtMs + this.diagnostics.dispatchedAudioDurationMs;
	}

	private nextAbsoluteMediaDeadline(
		dispatchedAt: number,
		dispatchedDurationMs: number,
	): number {
		const nominalDeadline = this.nominalMediaDeadline() ?? dispatchedAt;
		const recoveryInterval = this.adaptiveRecoveryIntervalMs(
			dispatchedAt,
			nominalDeadline,
			dispatchedDurationMs,
		);
		if (recoveryInterval === null) return nominalDeadline;
		return Math.max(
			nominalDeadline,
			dispatchedAt + recoveryInterval,
		);
	}

	private nextDispatchNotBeforeMs(): number | null {
		const hardIntervalDeadline = this.lastDispatchAtMs === null
			? null
			: this.lastDispatchAtMs + REALTIME_ASR_MIN_RECOVERY_INTERVAL_MS;
		if (this.nextMediaDeadlineMs === null) return hardIntervalDeadline;
		if (hardIntervalDeadline === null) return this.nextMediaDeadlineMs;
		return Math.max(this.nextMediaDeadlineMs, hardIntervalDeadline);
	}

	/**
	 * Recover against the absolute media phase without ever dispatching twice in
	 * one pump turn. Debt and live queue depth form continuous pressure signals:
	 * either can shorten the next interval. A square-root response handles measured
	 * pressure, while a consecutive-debt ramp starts near 90 ms and progressively
	 * creates enough margin to overcome persistent timer jitter.
	 * Cleared debt restores the absolute 100 ms phase. A separate last-dispatch
	 * not-before boundary prevents synchronous batches from bypassing the 50 ms hard
	 * floor. Recovery remains subordinate to pending-send and WebSocket gates.
	 */
	private adaptiveRecoveryIntervalMs(
		dispatchedAt: number,
		nextNominalDeadline: number,
		dispatchedDurationMs: number,
	): number | null {
		const dispatchedChunkDeadline = nextNominalDeadline - dispatchedDurationMs;
		const deadlineDebtMs = Math.max(0, dispatchedAt - dispatchedChunkDeadline);
		if (deadlineDebtMs === 0 || this.queue.length === 0) {
			this.consecutiveRecoveryDispatches = 0;
			return null;
		}
		this.consecutiveRecoveryDispatches = Math.min(
			9,
			this.consecutiveRecoveryDispatches + 1,
		);
		const debtPressure = Math.min(1, deadlineDebtMs / FULL_RECOVERY_DEBT_MS);
		const queuePressure = Math.min(
			1,
			this.queue.length / REALTIME_ASR_MAX_QUEUED_CHUNKS,
		);
		const persistentDebtPressure = Math.min(
			1,
			0.2 + (this.consecutiveRecoveryDispatches - 1) * 0.1,
		);
		const recoveryPressure = Math.max(
			Math.sqrt(Math.max(debtPressure, queuePressure)),
			persistentDebtPressure,
		);
		return MEDIA_CHUNK_INTERVAL_MS
			- recoveryPressure * (
				MEDIA_CHUNK_INTERVAL_MS - REALTIME_ASR_MIN_RECOVERY_INTERVAL_MS
			);
	}

	private refreshMediaClockDiagnostics(): void {
		const now = this.scheduler.now();
		this.diagnostics.liveWallElapsedMs = this.liveStartedAtMs === null
			? 0
			: Math.max(0, now - this.liveStartedAtMs);
		this.diagnostics.currentDispatchLeadMs = this.diagnostics.dispatchedAudioDurationMs
			- this.diagnostics.liveWallElapsedMs;
		this.diagnostics.maxDispatchLeadMs = Math.max(
			this.diagnostics.maxDispatchLeadMs,
			this.diagnostics.currentDispatchLeadMs,
		);
		const nominalDeadline = this.nominalMediaDeadline();
		this.diagnostics.currentDeadlineLatenessMs = this.queue.length > 0
			&& nominalDeadline !== null
			? Math.max(0, now - nominalDeadline)
			: 0;
		this.diagnostics.maxDeadlineLatenessMs = Math.max(
			this.diagnostics.maxDeadlineLatenessMs,
			this.diagnostics.currentDeadlineLatenessMs,
		);
		this.diagnostics.lastInboundEventAgeMs = this.lastInboundAtMs === null
			? null
			: Math.max(0, now - this.lastInboundAtMs);
	}

	private refreshQueueDiagnostics(): void {
		this.diagnostics.queuedChunkCount = this.queue.length;
		this.diagnostics.warmupQueuedChunkCount = this.warmupQueue.length;
		this.diagnostics.inFlightSendCount = this.inFlight.size;
		this.diagnostics.outstandingChunkCount = this.outstandingChunkCount();
		this.diagnostics.maxOutstandingChunkCount = Math.max(
			this.diagnostics.maxOutstandingChunkCount,
			this.diagnostics.outstandingChunkCount,
		);
		this.refreshInFlightAgeDiagnostics();
		this.refreshPumpDiagnostics();
	}

	private refreshInFlightAgeDiagnostics(): void {
		const lifecycle = this.inFlightLifecycleDiagnostics();
		const oldestAge = lifecycle.reduce<number | null>(
			(oldest, entry) => oldest === null ? entry.currentAgeMs : Math.max(oldest, entry.currentAgeMs),
			null,
		);
		this.diagnostics.oldestInFlightAgeMs = oldestAge;
		if (oldestAge !== null) {
			this.diagnostics.maxObservedInFlightAgeMs = Math.max(
				this.diagnostics.maxObservedInFlightAgeMs,
				oldestAge,
			);
		}
	}

	private inFlightLifecycleDiagnostics(): InFlightLifecycleDiagnostic[] {
		const now = this.scheduler.now();
		return [...this.inFlight.values()].map((chunk) => {
			const dispatchedAtMs = chunk.dispatchedAt ?? now;
			return {
				dispatchOrdinal: chunk.ordinal,
				dispatchedAtMs,
				currentAgeMs: Math.max(0, now - dispatchedAtMs),
			};
		});
	}

	private refreshPumpDiagnostics(): void {
		this.diagnostics.socketOpen = this.socketOpen;
		this.diagnostics.taskStarted = this.taskStarted;
		this.diagnostics.audioSendReady = this.audioSendReady;
		this.diagnostics.pumpActive = this.pumpActive;
		this.diagnostics.pumpScheduled = this.pumpRequested || this.pumpTimer !== null;
		this.diagnostics.stopping = this.stopping;
	}

	private publishProgress(): void {
		this.refreshInFlightAgeDiagnostics();
		this.refreshMediaClockDiagnostics();
		this.diagnostics.providerStatePublishCount += 1;
		this.diagnostics.providerStatePublishRate = ratePerSecond(
			this.diagnostics.providerStatePublishCount,
			this.scheduler.now() - this.progressStartedAtMs,
		);
		const listenerStartedAt = this.scheduler.now();
		this.options.callbacks.onProgress({
			sentFrameCount: this.sentFrameCount,
			sentAudioDurationMs: this.sentFrameCount * 20,
			audioBaseOffsetMs: this.audioBaseOffsetMs,
			diagnostics: { ...this.diagnostics },
		});
		this.diagnostics.maxStateListenerDurationMs = Math.max(
			this.diagnostics.maxStateListenerDurationMs,
			roundMetric(Math.max(0, this.scheduler.now() - listenerStartedAt)),
		);
	}

	private recordEventLoopLag(expectedAtMs: number): void {
		const now = this.scheduler.now();
		const lag = roundMetric(Math.max(0, now - expectedAtMs));
		this.diagnostics.eventLoopLagCurrentMs = lag;
		this.diagnostics.eventLoopLagMaxMs = Math.max(
			this.diagnostics.eventLoopLagMaxMs,
			lag,
		);
		this.eventLoopLagSamples.push(lag);
		if (this.eventLoopLagSamples.length > EVENT_LOOP_LAG_SAMPLE_LIMIT) {
			this.eventLoopLagSamples.shift();
		}
		this.diagnostics.eventLoopLagP95Ms = percentileMetric(
			this.eventLoopLagSamples,
			0.95,
		);
	}

	private fail(code: RealtimeAsrErrorCode): void {
		if (this.disposed || this.finished) return;
		this.finished = true;
		this.lifecycleAbort.abort();
		this.startWait?.reject(new RealtimeAsrError(code));
		this.finishWait?.reject(new RealtimeAsrError(code));
		this.rejectDrain(code);
		try {
			this.options.callbacks.onFailure(code);
		} catch {
			// Runtime observers cannot prevent transport and PCM cleanup.
		} finally {
			this.close();
		}
	}

	private close(): void {
		if (this.externalAbort && this.signal) {
			this.signal.removeEventListener('abort', this.externalAbort);
		}
		this.externalAbort = null;
		this.signal = null;
		this.aggregator.reset();
		this.socketOpen = false;
		this.taskStarted = false;
		this.audioSendReady = false;
		this.pumpRequested = false;
		this.cancelPumpTimer();
		this.nextMediaDeadlineMs = null;
		this.consecutiveRecoveryDispatches = 0;
		this.drainWhileStopping = false;
		this.stopping = false;
		const transport = this.transport;
		this.transport = null;
		transport?.dispose();
		for (const chunk of this.warmupQueue) chunk.data.fill(0);
		this.warmupQueue = [];
		for (const chunk of this.queue) chunk.data.fill(0);
		this.queue = [];
		this.refreshInFlightAgeDiagnostics();
		for (const chunk of this.inFlight.values()) {
			if (!chunk.settled) {
				this.diagnostics.sendCallbackFailureCount += 1;
				this.diagnostics.sendCallbackSettledCount += 1;
			}
			chunk.settled = true;
			chunk.data.fill(0);
		}
		this.inFlight.clear();
		this.refreshQueueDiagnostics();
		this.diagnostics.lastPumpBlockReason = this.pumpBlockReason();
		this.publishProgress();
		this.rejectDrain('connection-failed');
		this.startWait = null;
		this.finishWait = null;
	}

	private assertActive(): void {
		if (this.disposed || this.lifecycleAbort.signal.aborted) {
			throw new RealtimeAsrError('connection-failed');
		}
	}
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T | PromiseLike<T>): void;
	reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	void promise.catch(() => undefined);
	return { promise, resolve, reject };
}

function withTimeout(
	promise: Promise<void>,
	delayMs: number,
	scheduler: RealtimeAsrScheduler,
	signal: AbortSignal,
	code: RealtimeAsrErrorCode,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const timer = scheduler.setTimeout(() => finish(new RealtimeAsrError(code)), delayMs);
		const abort = () => finish(new RealtimeAsrError('connection-failed'));
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			scheduler.clearTimeout(timer);
			signal.removeEventListener('abort', abort);
			if (error) reject(error); else resolve();
		};
		signal.addEventListener('abort', abort, { once: true });
		promise.then(() => finish(), (error: unknown) => finish(
			error instanceof Error ? error : new RealtimeAsrError(code),
		));
		if (signal.aborted) abort();
	});
}

function mapTransportError(error: RealtimeAsrTransportError): RealtimeAsrErrorCode {
	return error.code;
}

function mapProviderError(error: unknown): RealtimeAsrErrorCode {
	if (error instanceof RealtimeAsrError) return error.code;
	if (error instanceof RealtimeAsrTransportError) return mapTransportError(error);
	return 'connection-failed';
}

function emptyDiagnostics(): RealtimeAsrDiagnostics {
	return {
		eventLoopLagCurrentMs: 0, eventLoopLagMaxMs: 0, eventLoopLagP95Ms: 0,
		providerStatePublishCount: 0, providerStatePublishRate: 0,
		sessionNotificationCount: 0, sessionNotificationRate: 0,
		workbenchRenderCount: 0, workbenchRenderRate: 0,
		workbenchLastRenderDurationMs: 0, workbenchMaxRenderDurationMs: 0,
		maxStateListenerDurationMs: 0,
		perMessageDeflateConfigured: false,
		perMessageDeflateNegotiated: false,
		producedChunkCount: 0,
		sentChunkCount: 0,
		queuedChunkCount: 0,
		inFlightSendCount: 0,
		outstandingChunkCount: 0,
		maxOutstandingChunkCount: 0,
		wsBufferedAmount: 0,
		maxWsBufferedAmount: 0,
		sendWriteLatencyMs: null,
		oldestInFlightAgeMs: null,
		maxObservedInFlightAgeMs: 0,
		dispatchChunkCount: 0,
		sendCallbackSuccessCount: 0,
		sendCallbackFailureCount: 0,
		sendCallbackSettledCount: 0,
		overflowReason: null,
		socketOpen: false,
		taskStarted: false,
		audioSendReady: false,
		pumpActive: false,
		pumpScheduled: false,
		stopping: false,
		lastPumpBlockReason: 'socket-not-open',
		socketEverOpened: false,
		runTaskEverSent: false,
		taskEverStarted: false,
		firstAudioEverDispatched: false,
		warmupQueuedChunkCount: 0,
		warmupDroppedChunkCount: 0,
		warmupDroppedDurationMs: 0,
		inboundMessageCount: 0,
		taskStartedEventCount: 0,
		resultGeneratedEventCount: 0,
		taskFailedEventCount: 0,
		taskFinishedEventCount: 0,
		ignoredHeartbeatCount: 0,
		unknownEventCount: 0,
		lastInboundEventKind: 'none',
		lastInboundEventAgeMs: null,
		firstResultGeneratedLatencyMs: null,
		liveWallElapsedMs: 0,
		producedAudioDurationMs: 0,
		dispatchedAudioDurationMs: 0,
		currentDispatchLeadMs: 0,
		maxDispatchLeadMs: 0,
		minDispatchIntervalMs: null,
		averageDispatchIntervalMs: 0,
		currentDeadlineLatenessMs: 0,
		maxDeadlineLatenessMs: 0,
		controlledRecoveryDispatchCount: 0,
		schedulerWakeupCount: 0,
		maxDispatchBurstCount: 0,
	};
}

function ratePerSecond(count: number, elapsedMs: number): number {
	if (count <= 0) return 0;
	return roundMetric(count * 1_000 / Math.max(1, elapsedMs));
}

function percentileMetric(values: number[], ratio: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil(sorted.length * ratio) - 1),
	);
	return sorted[index] ?? 0;
}

function roundMetric(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0;
	return Math.round(value * 1_000) / 1_000;
}

function browserScheduler(): RealtimeAsrScheduler {
	return {
		now: () => window.performance.now(),
		setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
		clearTimeout: (handle) => window.clearTimeout(handle as number),
	};
}
