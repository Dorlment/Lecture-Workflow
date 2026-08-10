import type {
	AudioCompanionErrorCode,
	AudioCompanionRemoteErrorCode,
	AudioCompanionSessionContext,
} from './audio-companion-types';

export type AudioCompanionRuntimeStatus =
	| 'unsupported'
	| 'helper-unavailable'
	| 'idle'
	| 'launching'
	| 'waiting-for-readiness'
	| 'connecting'
	| 'ready'
	| 'capturing'
	| 'stopping'
	| 'stopped'
	| 'error';

export type AudioCompanionRuntimeLocalErrorCode =
	| 'unsupported-runtime'
	| 'helper-unavailable'
	| 'session-unavailable'
	| 'token-generation-failed'
	| 'launch-failed'
	| 'child-exited'
	| 'readiness-timeout'
	| 'capture-start-timeout'
	| 'cleanup-failed'
	| AudioCompanionErrorCode;

export interface AudioCompanionRuntimeState {
	status: AudioCompanionRuntimeStatus;
	errorCode: AudioCompanionRuntimeLocalErrorCode | null;
	remoteErrorCode: AudioCompanionRemoteErrorCode | null;
	frameCount: number;
	rms: number;
}

export type AudioCompanionRuntimeStartResult =
	| 'capturing'
	| 'busy'
	| 'unsupported'
	| 'helper-unavailable'
	| 'session-unavailable'
	| 'error';

export interface AudioCompanionRuntimeScheduler {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface AudioCompanionClassroomSessionSource {
	getSessionContext(): AudioCompanionSessionContext | null;
	subscribe(listener: (context: AudioCompanionSessionContext | null) => void): () => void;
}

export interface AudioCompanionRuntimeControl {
	readonly state: AudioCompanionRuntimeState;
	start(): Promise<AudioCompanionRuntimeStartResult>;
	stop(): Promise<void>;
	subscribe(listener: (state: AudioCompanionRuntimeState) => void): () => void;
}
