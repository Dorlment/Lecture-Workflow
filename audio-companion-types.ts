export const AUDIO_COMPANION_PROTOCOL_VERSION = 1 as const;
export const AUDIO_COMPANION_DEFAULT_ENDPOINT = 'ws://127.0.0.1:43127/v1/audio';

export const AUDIO_COMPANION_TARGET_FORMAT = {
	sampleFormat: 's16le',
	sampleRate: 16_000,
	channels: 1,
} as const;

export type AudioCompanionClientStatus =
	| 'idle'
	| 'connecting'
	| 'authenticating'
	| 'ready'
	| 'capturing'
	| 'stopping'
	| 'disconnected'
	| 'error';

export type AudioCompanionUiStatus =
	| 'unconfigured'
	| 'disconnected'
	| 'connecting'
	| 'connected'
	| 'incompatible'
	| 'failed';

export type AudioCompanionSource =
	| 'windows-wasapi-loopback'
	| 'macos-screencapturekit'
	| 'linux-pipewire'
	| 'microphone-input';

export type AudioCompanionPlatform = 'windows' | 'macos' | 'linux' | 'unknown';

export type AudioCompanionCapability =
	| 'audio-frame-v1'
	| 'heartbeat-v1'
	| 'source-selection-v1';

export type AudioCompanionErrorCode =
	| 'not-configured'
	| 'invalid-endpoint'
	| 'token-missing'
	| 'session-unavailable'
	| 'busy'
	| 'connect-failed'
	| 'connect-timeout'
	| 'auth-timeout'
	| 'auth-failed'
	| 'protocol-incompatible'
	| 'protocol-error'
	| 'heartbeat-timeout'
	| 'stop-timeout'
	| 'unexpected-disconnect'
	| 'disposed'
	| 'remote-error';

export type AudioCompanionRemoteErrorCode =
	| 'AUTH_FAILED'
	| 'PROTOCOL_MISMATCH'
	| 'INVALID_REQUEST'
	| 'SOURCE_UNAVAILABLE'
	| 'FORMAT_UNSUPPORTED'
	| 'CAPTURE_FAILED'
	| 'BUSY'
	| 'INTERNAL_ERROR';

export interface AudioCompanionClientState {
	status: AudioCompanionClientStatus;
	configured: boolean;
	errorCode: AudioCompanionErrorCode | null;
	remoteErrorCode: AudioCompanionRemoteErrorCode | null;
	helperVersion: string | null;
	platform: AudioCompanionPlatform | null;
	supportedSources: AudioCompanionSource[];
}

export interface AudioCompanionConfiguration {
	endpoint: string;
	token: string;
}

export interface AudioCompanionSessionContext {
	sessionId: string;
	startedAtUnixMs: number;
}

export interface AudioCompanionHelloMessage {
	type: 'HELLO';
	protocolVersion: typeof AUDIO_COMPANION_PROTOCOL_VERSION;
	sessionId: string;
	clientVersion: string;
	auth: {
		scheme: 'pairing-token';
		token: string;
	};
}

export interface AudioCompanionReadyMessage {
	type: 'READY';
	protocolVersion: typeof AUDIO_COMPANION_PROTOCOL_VERSION;
	helperVersion: string;
	platform: AudioCompanionPlatform;
	supportedSources: AudioCompanionSource[];
	supportedFormats: Array<{
		sampleFormat: 's16le';
		sampleRate: number;
		channels: number;
	}>;
	capabilities: AudioCompanionCapability[];
}

export interface AudioCompanionStartMessage {
	type: 'START';
	protocolVersion: typeof AUDIO_COMPANION_PROTOCOL_VERSION;
	sessionId: string;
	sourceId: AudioCompanionSource;
	format: typeof AUDIO_COMPANION_TARGET_FORMAT;
	sessionStartedAtUnixMs: number;
	captureStartOffsetMs: number;
}

export type AudioCompanionRemoteStatus =
	| 'connecting'
	| 'ready'
	| 'capturing'
	| 'stopped'
	| 'error';

export interface AudioCompanionStatusMessage {
	type: 'STATUS';
	protocolVersion: typeof AUDIO_COMPANION_PROTOCOL_VERSION;
	status: AudioCompanionRemoteStatus;
}

export interface AudioCompanionStopMessage {
	type: 'STOP';
	protocolVersion: typeof AUDIO_COMPANION_PROTOCOL_VERSION;
	sessionId: string;
}

export interface AudioCompanionErrorMessage {
	type: 'ERROR';
	protocolVersion: typeof AUDIO_COMPANION_PROTOCOL_VERSION;
	code: AudioCompanionRemoteErrorCode;
	messageZh: string;
	retryable: boolean;
}

export interface AudioCompanionPingMessage {
	type: 'PING';
	protocolVersion: typeof AUDIO_COMPANION_PROTOCOL_VERSION;
	id: number;
}

export interface AudioCompanionPongMessage {
	type: 'PONG';
	protocolVersion: typeof AUDIO_COMPANION_PROTOCOL_VERSION;
	id: number;
}

export type AudioCompanionClientMessage =
	| AudioCompanionHelloMessage
	| AudioCompanionStartMessage
	| AudioCompanionStopMessage
	| AudioCompanionPingMessage
	| AudioCompanionPongMessage;

export type AudioCompanionServerMessage =
	| AudioCompanionReadyMessage
	| AudioCompanionStatusMessage
	| AudioCompanionErrorMessage
	| AudioCompanionPingMessage
	| AudioCompanionPongMessage;

export interface AudioCompanionFrame {
	sequence: number;
	offsetMs: number;
	sampleCount: number;
	/** Derived locally from sampleCount / sampleRate; never trusted from the wire. */
	durationMs: number;
	sampleRate: number;
	channels: number;
	sampleFormat: 's16le';
	pcm: Uint8Array;
}

export interface AudioCompanionSocketCloseEvent {
	code: number;
	wasClean: boolean;
}

export interface AudioCompanionSocket {
	readonly readyState: number;
	onOpen: (() => void) | null;
	onMessage: ((data: unknown) => void) | null;
	onError: ((errorName: string) => void) | null;
	onClose: ((event: AudioCompanionSocketCloseEvent) => void) | null;
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

export type AudioCompanionWebSocketFactory = (endpoint: string) => AudioCompanionSocket;

export interface AudioCompanionScheduler {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
	setInterval(callback: () => void, delayMs: number): unknown;
	clearInterval(handle: unknown): void;
}

export interface AudioCompanionDiagnostic {
	code: AudioCompanionErrorCode;
	remoteErrorCode: AudioCompanionRemoteErrorCode | null;
	stage: AudioCompanionClientStatus;
	type: string;
}

export interface AudioCompanionClientOptions {
	clientVersion: string;
	getSessionContext(): AudioCompanionSessionContext | null;
	webSocketFactory: AudioCompanionWebSocketFactory;
	scheduler?: AudioCompanionScheduler;
	onDiagnostic?(diagnostic: AudioCompanionDiagnostic): void;
}

export type AudioCompanionConfigureResult =
	| { status: 'configured' }
	| { status: 'busy' }
	| { status: 'invalid'; code: 'invalid-endpoint' | 'token-missing' };

export type AudioCompanionStartResult =
	| 'starting'
	| 'busy'
	| 'not-ready'
	| 'session-unavailable'
	| 'source-unavailable';
