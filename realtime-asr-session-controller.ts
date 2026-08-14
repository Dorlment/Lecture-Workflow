import type { AudioCompanionSessionContext } from './audio-companion-types';
import type {
	RealtimeAsrAudioFrameSource,
	RealtimeAsrConfiguration,
	RealtimeAsrDiagnostics,
	RealtimeAsrErrorCode,
	RealtimeAsrFinalSegment,
	RealtimeAsrProvider,
	RealtimeAsrProviderFactory,
	RealtimeAsrRuntimeControl,
	RealtimeAsrRuntimeState,
	RealtimeAsrSegment,
} from './realtime-asr-types';
import { RealtimeAsrError } from './realtime-asr-types';

const MAX_FINAL_SEGMENTS = 100;
const MAX_FINAL_TEXT_CHARS = 100_000;
const MAX_FINAL_WORDS = 10_000;
const MAX_FINAL_WORD_CHARS = 100_000;

export interface RealtimeAsrSessionControllerOptions {
	isSupportedRuntime(): boolean;
	getConfiguration(): RealtimeAsrConfiguration;
	getApiKey(): string;
	getClassroomSessionContext(): AudioCompanionSessionContext | null;
	audio: RealtimeAsrAudioFrameSource;
	providerFactory: RealtimeAsrProviderFactory;
	now?: () => number;
}

export class RealtimeAsrSessionController implements RealtimeAsrRuntimeControl {
	private currentState = emptyState();
	private readonly listeners = new Set<(state: RealtimeAsrRuntimeState) => void>();
	private provider: RealtimeAsrProvider | null = null;
	private frameUnsubscribe: (() => void) | null = null;
	private audioUnsubscribe: (() => void) | null = null;
	private abortController: AbortController | null = null;
	private startTask: Promise<ReturnTypeResult> | null = null;
	private stopTask: Promise<void> | null = null;
	private partialSentenceId: number | null = null;
	private finalizedSentenceIds = new Set<number>();
	private runVersion = 0;
	private disposed = false;
	private notificationStartedAtMs = 0;
	private notificationCount = 0;
	private readonly now: () => number;

	constructor(private readonly options: RealtimeAsrSessionControllerOptions) {
		this.now = options.now ?? defaultNow;
		this.notificationStartedAtMs = this.now();
	}

	get state(): RealtimeAsrRuntimeState {
		return cloneState(this.currentState);
	}

	start(): Promise<ReturnTypeResult> {
		if (this.disposed) return Promise.resolve('disabled');
		if (this.startTask || this.stopTask || isActive(this.currentState.status)) {
			return Promise.resolve('busy');
		}
		const task = this.startInternal().finally(() => {
			if (this.startTask === task) this.startTask = null;
		});
		this.startTask = task;
		return task;
	}

	stop(): Promise<void> {
		if (this.stopTask) return this.stopTask;
		if (!this.provider && !this.startTask) return Promise.resolve();
		const task = this.stopInternal().finally(() => {
			if (this.stopTask === task) this.stopTask = null;
		});
		this.stopTask = task;
		return task;
	}

	subscribe(listener: (state: RealtimeAsrRuntimeState) => void): () => void {
		if (this.disposed) return () => undefined;
		this.listeners.add(listener);
		listener(this.state);
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.runVersion += 1;
		this.abortController?.abort();
		this.releaseSubscriptions();
		this.provider?.dispose();
		this.provider = null;
		this.listeners.clear();
	}

	private async startInternal(): Promise<ReturnTypeResult> {
		if (!this.options.isSupportedRuntime()) {
			this.setState({ ...emptyState(), status: 'disabled' });
			return 'disabled';
		}
		const configuration = this.options.getConfiguration();
		const classroom = this.options.getClassroomSessionContext();
		if (!configuration.workspaceId.trim()
			|| !configuration.model.trim()
			|| configuration.region !== 'cn-beijing'
			|| !classroom) {
			this.setState({
				...emptyState(),
				status: 'configuration-error',
				errorCode: 'configuration-error',
			});
			return 'configuration-error';
		}
		if (this.options.audio.state.status !== 'capturing') {
			this.setFailure('connection-failed');
			return 'error';
		}
		const audioSession = this.options.audio.sessionContext;
		if (!audioSession
			|| audioSession.sessionId !== classroom.sessionId
			|| audioSession.startedAtUnixMs !== classroom.startedAtUnixMs) {
			this.setFailure('connection-failed');
			return 'error';
		}
		const runVersion = ++this.runVersion;
		this.notificationStartedAtMs = this.now();
		this.notificationCount = 0;
		this.partialSentenceId = null;
		this.finalizedSentenceIds.clear();
		this.abortController = new AbortController();
		this.setState({
			...emptyState(),
			status: 'connecting',
			classroomSessionId: classroom.sessionId,
			startedAt: classroom.startedAtUnixMs,
		});
		try {
			const provider = this.options.providerFactory({
				configuration: { ...configuration },
				getApiKey: () => this.options.getApiKey(),
				classroomSessionId: classroom.sessionId,
				callbacks: {
					onPhase: (status) => {
						if (this.isCurrent(runVersion)) this.setStatus(status);
					},
					onSegment: (segment) => {
						if (this.isCurrent(runVersion)) this.applySegment(segment);
					},
					onProgress: (progress) => {
						if (this.isCurrent(runVersion)) {
							this.setState({ ...this.currentState, ...progress });
						}
					},
					onFailure: (code) => {
						if (this.isCurrent(runVersion)) this.handleFailure(code, runVersion);
					},
				},
			});
			this.provider = provider;
			this.frameUnsubscribe = this.options.audio.subscribeValidatedFrames((frame) => {
				if (this.isCurrent(runVersion)) provider.acceptFrame(frame);
			});
			this.audioUnsubscribe = this.options.audio.subscribe((state) => {
				if (this.isCurrent(runVersion)
					&& state.status !== 'capturing'
					&& state.status !== 'ready') {
					this.stop().catch(() => undefined);
				}
			});
			await provider.start(this.abortController.signal);
			if (!this.isCurrent(runVersion)) return 'error';
			return 'streaming';
		} catch (error) {
			const code = realtimeAsrErrorCode(error);
			if (this.isCurrent(runVersion)) {
				this.handleFailure(code, runVersion);
			}
			return code === 'configuration-error' ? 'configuration-error' : 'error';
		}
	}

	private async stopInternal(): Promise<void> {
		const provider = this.provider;
		const wasStreaming = this.currentState.status === 'streaming';
		this.setStatus('stopping');
		if (!wasStreaming) this.runVersion += 1;
		this.frameUnsubscribe?.();
		this.frameUnsubscribe = null;
		if (!wasStreaming) this.abortController?.abort();
		try {
			await provider?.stop();
		} finally {
			if (wasStreaming) this.runVersion += 1;
			this.abortController?.abort();
			this.abortController = null;
			this.releaseSubscriptions();
			provider?.dispose();
			if (this.provider === provider) this.provider = null;
			if (!this.disposed && this.currentState.status !== 'error') {
				this.setState({
					...this.currentState,
					status: 'stopped',
					partialText: '',
					errorCode: null,
				});
			}
		}
	}

	private handleFailure(code: RealtimeAsrErrorCode, runVersion: number): void {
		if (!this.isCurrent(runVersion)) return;
		this.runVersion += 1;
		this.abortController?.abort();
		this.abortController = null;
		this.releaseSubscriptions();
		this.provider?.dispose();
		this.provider = null;
		if (code === 'configuration-error') {
			this.setState({
				...this.currentState,
				status: 'configuration-error',
				errorCode: code,
			});
			return;
		}
		this.setFailure(code);
	}

	private applySegment(segment: RealtimeAsrSegment): void {
		if (!segment.isFinal) {
			if (this.finalizedSentenceIds.has(segment.sentenceId)) return;
			if (this.partialSentenceId !== null && segment.sentenceId < this.partialSentenceId) {
				return;
			}
			this.partialSentenceId = segment.sentenceId;
			this.setState({ ...this.currentState, partialText: segment.text });
			return;
		}
		const existing = this.currentState.recentFinalSegments;
		if (this.partialSentenceId === segment.sentenceId) {
			this.partialSentenceId = null;
			if (existing.some((item) => item.sentenceId === segment.sentenceId)) {
				this.setState({ ...this.currentState, partialText: '' });
				return;
			}
		}
		if (existing.some((item) => item.sentenceId === segment.sentenceId)) return;
		const boundedSegment = boundSegmentWords(segment);
		const bounded = boundFinalSegments([...existing, boundedSegment]);
		this.finalizedSentenceIds = new Set(bounded.map((item) => item.sentenceId));
		this.setState({
			...this.currentState,
			partialText: this.partialSentenceId === null ? '' : this.currentState.partialText,
			recentFinalSegments: bounded,
			lastFinalText: segment.text,
		});
	}

	private releaseSubscriptions(): void {
		this.frameUnsubscribe?.();
		this.frameUnsubscribe = null;
		this.audioUnsubscribe?.();
		this.audioUnsubscribe = null;
	}

	private isCurrent(runVersion: number): boolean {
		return !this.disposed && runVersion === this.runVersion;
	}

	private setStatus(status: RealtimeAsrRuntimeState['status']): void {
		this.setState({ ...this.currentState, status, errorCode: null });
	}

	private setFailure(errorCode: RealtimeAsrErrorCode): void {
		this.setState({ ...this.currentState, status: 'error', errorCode });
	}

	private setState(state: RealtimeAsrRuntimeState): void {
		if (this.disposed) return;
		this.notificationCount += 1;
		const next = cloneState(state);
		next.diagnostics.sessionNotificationCount = this.notificationCount;
		next.diagnostics.sessionNotificationRate = ratePerSecond(
			this.notificationCount,
			this.now() - this.notificationStartedAtMs,
		);
		this.currentState = next;
		for (const listener of this.listeners) {
			const startedAt = this.now();
			try { listener(this.state); } catch { /* UI observers are isolated. */ }
			this.currentState.diagnostics.maxStateListenerDurationMs = Math.max(
				this.currentState.diagnostics.maxStateListenerDurationMs,
				roundMetric(Math.max(0, this.now() - startedAt)),
			);
		}
	}
}

function boundSegmentWords(segment: RealtimeAsrFinalSegment): RealtimeAsrFinalSegment {
	if (!segment.words) return segment;
	const wordTextChars = segment.words.reduce(
		(total, word) => total + word.text.length + word.punctuation.length,
		0,
	);
	if (segment.words.length > MAX_FINAL_WORDS || wordTextChars > MAX_FINAL_WORD_CHARS) {
		const { words: _words, ...withoutWords } = segment;
		return withoutWords;
	}
	return segment;
}

type ReturnTypeResult = 'streaming' | 'busy' | 'configuration-error' | 'disabled' | 'error';

function emptyState(): RealtimeAsrRuntimeState {
	return {
		status: 'idle',
		classroomSessionId: null,
		partialText: '',
		recentFinalSegments: [],
		lastFinalText: '',
		sentFrameCount: 0,
		sentAudioDurationMs: 0,
		errorCode: null,
		startedAt: null,
		audioBaseOffsetMs: null,
		diagnostics: emptyDiagnostics(),
	};
}

function cloneState(state: RealtimeAsrRuntimeState): RealtimeAsrRuntimeState {
	return {
		...state,
		diagnostics: { ...state.diagnostics },
		recentFinalSegments: state.recentFinalSegments.map((segment) => ({
			...segment,
			...(segment.words ? { words: segment.words.map((word) => ({ ...word })) } : {}),
		})),
	};
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

function defaultNow(): number {
	return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function roundMetric(value: number): number {
	return Math.round(value * 1_000) / 1_000;
}

function ratePerSecond(count: number, elapsedMs: number): number {
	if (count <= 0) return 0;
	return roundMetric(count * 1_000 / Math.max(1, elapsedMs));
}

function boundFinalSegments(segments: RealtimeAsrFinalSegment[]): RealtimeAsrFinalSegment[] {
	const result = segments.slice(-MAX_FINAL_SEGMENTS);
	const totals = () => result.reduce((current, segment) => ({
		text: current.text + segment.text.length,
		words: current.words + (segment.words?.length ?? 0),
		wordText: current.wordText + (segment.words?.reduce(
			(sum, word) => sum + word.text.length + word.punctuation.length,
			0,
		) ?? 0),
	}), { text: 0, words: 0, wordText: 0 });
	let total = totals();
	while (result.length > 1 && (total.text > MAX_FINAL_TEXT_CHARS
		|| total.words > MAX_FINAL_WORDS
		|| total.wordText > MAX_FINAL_WORD_CHARS)) {
		result.shift();
		total = totals();
	}
	return result;
}

function isActive(status: RealtimeAsrRuntimeState['status']): boolean {
	return status === 'connecting'
		|| status === 'starting-task'
		|| status === 'streaming'
		|| status === 'stopping';
}

function realtimeAsrErrorCode(error: unknown): RealtimeAsrErrorCode {
	if (error instanceof RealtimeAsrError) return error.code;
	if (error && typeof error === 'object' && 'code' in error) {
		const code = (error as { code?: unknown }).code;
		if (code === 'configuration-error') return code;
	}
	return 'connection-failed';
}
