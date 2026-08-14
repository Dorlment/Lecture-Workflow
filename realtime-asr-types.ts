import type {
	AudioCompanionFrame,
	AudioCompanionSessionContext,
} from './audio-companion-types';
import type { AudioCompanionRuntimeState } from './audio-companion-runtime-types';

export const REALTIME_ASR_DEFAULT_MODEL = 'qwen-audio-3.0-asr-flash-streaming';
export const REALTIME_ASR_SAMPLE_RATE = 16_000;
export const REALTIME_ASR_FRAME_SAMPLES = 320;
export const REALTIME_ASR_FRAME_BYTES = 640;
export const REALTIME_ASR_FRAMES_PER_CHUNK = 5;
export const REALTIME_ASR_MAX_WARMUP_CHUNKS = 20;
export const REALTIME_ASR_MAX_QUEUED_CHUNKS = 20;
export const REALTIME_ASR_MAX_BUFFERED_AMOUNT = 256 * 1024;
export const REALTIME_ASR_MIN_RECOVERY_INTERVAL_MS = 50;
export const REALTIME_ASR_CHUNK_BYTES = REALTIME_ASR_FRAME_BYTES
	* REALTIME_ASR_FRAMES_PER_CHUNK;
export const REALTIME_ASR_MAX_PENDING_SENDS = Math.floor(
	REALTIME_ASR_MAX_BUFFERED_AMOUNT / REALTIME_ASR_CHUNK_BYTES,
);

export function realtimeAsrClientFrameOverhead(payloadLength: number): 6 | 8 | 14 {
	if (payloadLength <= 125) return 6;
	if (payloadLength <= 65_535) return 8;
	return 14;
}

export type RealtimeAsrOverflowReason = 'app-queue-limit' | 'ws-buffer-limit';

export type RealtimeAsrPumpBlockReason =
	| 'none'
	| 'socket-not-open'
	| 'task-not-started'
	| 'audio-not-ready'
	| 'stopping'
	| 'disposed'
	| 'finished'
	| 'queue-empty'
	| 'inflight-limit'
	| 'pending-callback-limit'
	| 'media-deadline'
	| 'ws-buffer-limit';

export type RealtimeAsrInboundEventKind =
	| 'none'
	| 'task-started'
	| 'result-generated'
	| 'heartbeat'
	| 'task-failed'
	| 'task-finished'
	| 'unknown';

export interface RealtimeAsrDiagnostics {
	eventLoopLagCurrentMs: number;
	eventLoopLagMaxMs: number;
	eventLoopLagP95Ms: number;
	providerStatePublishCount: number;
	providerStatePublishRate: number;
	sessionNotificationCount: number;
	sessionNotificationRate: number;
	workbenchRenderCount: number;
	workbenchRenderRate: number;
	workbenchLastRenderDurationMs: number;
	workbenchMaxRenderDurationMs: number;
	maxStateListenerDurationMs: number;
	perMessageDeflateConfigured: boolean;
	perMessageDeflateNegotiated: boolean;
	producedChunkCount: number;
	sentChunkCount: number;
	queuedChunkCount: number;
	inFlightSendCount: number;
	outstandingChunkCount: number;
	maxOutstandingChunkCount: number;
	wsBufferedAmount: number;
	maxWsBufferedAmount: number;
	sendWriteLatencyMs: number | null;
	oldestInFlightAgeMs: number | null;
	maxObservedInFlightAgeMs: number;
	dispatchChunkCount: number;
	sendCallbackSuccessCount: number;
	sendCallbackFailureCount: number;
	sendCallbackSettledCount: number;
	overflowReason: RealtimeAsrOverflowReason | null;
	socketOpen: boolean;
	taskStarted: boolean;
	audioSendReady: boolean;
	pumpActive: boolean;
	pumpScheduled: boolean;
	stopping: boolean;
	lastPumpBlockReason: RealtimeAsrPumpBlockReason;
	socketEverOpened: boolean;
	runTaskEverSent: boolean;
	taskEverStarted: boolean;
	firstAudioEverDispatched: boolean;
	warmupQueuedChunkCount: number;
	warmupDroppedChunkCount: number;
	warmupDroppedDurationMs: number;
	inboundMessageCount: number;
	taskStartedEventCount: number;
	resultGeneratedEventCount: number;
	taskFailedEventCount: number;
	taskFinishedEventCount: number;
	ignoredHeartbeatCount: number;
	unknownEventCount: number;
	lastInboundEventKind: RealtimeAsrInboundEventKind;
	lastInboundEventAgeMs: number | null;
	firstResultGeneratedLatencyMs: number | null;
	liveWallElapsedMs: number;
	producedAudioDurationMs: number;
	dispatchedAudioDurationMs: number;
	currentDispatchLeadMs: number;
	maxDispatchLeadMs: number;
	minDispatchIntervalMs: number | null;
	averageDispatchIntervalMs: number;
	currentDeadlineLatenessMs: number;
	maxDeadlineLatenessMs: number;
	controlledRecoveryDispatchCount: number;
	schedulerWakeupCount: number;
	maxDispatchBurstCount: number;
}

export type RealtimeAsrStatus =
	| 'disabled'
	| 'configuration-error'
	| 'idle'
	| 'connecting'
	| 'starting-task'
	| 'streaming'
	| 'stopping'
	| 'stopped'
	| 'error';

export type RealtimeAsrErrorCode =
	| 'configuration-error'
	| 'auth-failed'
	| 'connection-failed'
	| 'task-start-failed'
	| 'task-failed'
	| 'protocol-error'
	| 'audio-format-invalid'
	| 'audio-sequence-invalid'
	| 'audio-buffer-overflow'
	| 'audio-send-timeout'
	| 'unexpected-websocket-compression'
	| 'finish-timeout'
	| 'remote-closed';

export interface RealtimeAsrWord {
	text: string;
	punctuation: string;
	beginTimeMs: number;
	endTimeMs: number;
}

export interface RealtimeAsrPartialSegment {
	sentenceId: number;
	text: string;
	beginTimeMs: number;
	endTimeMs: number | null;
	isFinal: false;
}

export interface RealtimeAsrFinalSegment {
	sentenceId: number;
	text: string;
	beginTimeMs: number;
	endTimeMs: number;
	isFinal: true;
	words?: RealtimeAsrWord[];
}

export type RealtimeAsrSegment = RealtimeAsrPartialSegment | RealtimeAsrFinalSegment;

export interface RealtimeAsrRuntimeState {
	status: RealtimeAsrStatus;
	classroomSessionId: string | null;
	partialText: string;
	recentFinalSegments: RealtimeAsrFinalSegment[];
	lastFinalText: string;
	sentFrameCount: number;
	sentAudioDurationMs: number;
	errorCode: RealtimeAsrErrorCode | null;
	startedAt: number | null;
	audioBaseOffsetMs: number | null;
	diagnostics: RealtimeAsrDiagnostics;
}

export interface RealtimeAsrConfiguration {
	workspaceId: string;
	region: 'cn-beijing';
	model: string;
}

export interface RealtimeAsrTransportHandlers {
	onText(message: string): void;
	onBinary(data: Uint8Array): void;
	onClose(code: number): void;
	onError(error: RealtimeAsrTransportError): void;
}

export interface RealtimeAsrTransportConnectOptions {
	endpoint: string;
	authorization: string;
	signal: AbortSignal;
	handlers: RealtimeAsrTransportHandlers;
}

export interface RealtimeAsrWebSocketTransport {
	readonly bufferedAmount: number;
	readonly perMessageDeflateConfigured: boolean;
	readonly perMessageDeflateNegotiated: boolean;
	connect(options: RealtimeAsrTransportConnectOptions): Promise<void>;
	sendText(message: string): Promise<void>;
	sendBinary(data: Uint8Array): Promise<void>;
	close(): void;
	dispose(): void;
}

export type RealtimeAsrTransportFactory = () => RealtimeAsrWebSocketTransport;

export class RealtimeAsrTransportError extends Error {
	constructor(readonly code:
		| 'auth-failed'
		| 'connection-failed'
		| 'remote-closed'
		| 'unexpected-websocket-compression') {
		super(`Realtime ASR transport failed: ${code}.`);
		this.name = 'RealtimeAsrTransportError';
	}
}

export class RealtimeAsrError extends Error {
	constructor(readonly code: RealtimeAsrErrorCode) {
		super(`Realtime ASR failed: ${code}.`);
		this.name = 'RealtimeAsrError';
	}
}

export interface RealtimeAsrScheduler {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface RealtimeAsrProviderCallbacks {
	onPhase(status: 'connecting' | 'starting-task' | 'streaming' | 'stopping'): void;
	onSegment(segment: RealtimeAsrSegment): void;
	onProgress(progress: {
		sentFrameCount: number;
		sentAudioDurationMs: number;
		audioBaseOffsetMs: number | null;
		diagnostics: RealtimeAsrDiagnostics;
	}): void;
	onFailure(errorCode: RealtimeAsrErrorCode): void;
}

export interface RealtimeAsrProvider {
	start(signal: AbortSignal): Promise<void>;
	acceptFrame(frame: AudioCompanionFrame): void;
	stop(): Promise<void>;
	dispose(): void;
}

export interface RealtimeAsrProviderFactoryOptions {
	configuration: RealtimeAsrConfiguration;
	getApiKey(): string;
	classroomSessionId: string;
	callbacks: RealtimeAsrProviderCallbacks;
}

export type RealtimeAsrProviderFactory = (
	options: RealtimeAsrProviderFactoryOptions,
) => RealtimeAsrProvider;

export interface RealtimeAsrAudioFrameSource {
	readonly state: AudioCompanionRuntimeState;
	readonly sessionContext: AudioCompanionSessionContext | null;
	subscribe(listener: (state: AudioCompanionRuntimeState) => void): () => void;
	subscribeValidatedFrames(listener: (frame: AudioCompanionFrame) => void): () => void;
}

export interface RealtimeAsrRuntimeControl {
	readonly state: RealtimeAsrRuntimeState;
	start(): Promise<'streaming' | 'busy' | 'configuration-error' | 'disabled' | 'error'>;
	stop(): Promise<void>;
	subscribe(listener: (state: RealtimeAsrRuntimeState) => void): () => void;
}
