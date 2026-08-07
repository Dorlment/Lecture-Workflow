export type ScreenshotBackgroundStatus = 'idle' | 'listening' | 'unsupported';

export type ScreenshotBackgroundStopReason =
	| 'manual'
	| 'target-deleted'
	| 'capability-failed'
	| 'unload';

export type ScreenshotEventStatus = 'detected' | 'saved' | 'inserted' | 'failed';

export type ClassroomEventType = 'screenshot' | 'transcript' | 'audio';

export interface ClassroomEventBase {
	eventId: string;
	type: ClassroomEventType;
	detectedAt: Date;
	offsetMs: number;
}

export interface ScreenshotBackgroundDetection {
	width: number;
	height: number;
	detectedAt: Date;
}

export interface ClassroomScreenshotEvent extends ClassroomEventBase, ScreenshotBackgroundDetection {
	type: 'screenshot';
	status: ScreenshotEventStatus;
	savedPath: string | null;
	error: string | null;
}

export interface ScreenshotBackgroundState {
	status: ScreenshotBackgroundStatus;
	sessionId: string | null;
	startedAt: Date | null;
	endedAt: Date | null;
	targetPath: string | null;
	targetName: string | null;
	detectedCount: number;
	savedCount: number;
	insertedCount: number;
	failedCount: number;
	lastDetection: ScreenshotBackgroundDetection | null;
	lastSavedPath: string | null;
	lastError: string | null;
	events: ClassroomScreenshotEvent[];
}

export interface ClassroomSession<TFile> {
	sessionId: string;
	targetFile: TFile;
	startedAt: Date;
	endedAt: Date | null;
	status: ScreenshotBackgroundStatus;
	detectedCount: number;
	savedCount: number;
	insertedCount: number;
	failedCount: number;
	events: ClassroomScreenshotEvent[];
}

export interface ClipboardImageCandidate {
	readonly width: number;
	readonly height: number;
	readonly lightFingerprint: string;
	fullFingerprint(): string;
	takePngData(): Uint8Array;
	release(): void;
}

export interface ScreenshotClipboardAdapter {
	readImageCandidate(): ClipboardImageCandidate | null;
	dispose(): void;
}

export type ScreenshotClipboardAdapterResult =
	| { status: 'ready'; adapter: ScreenshotClipboardAdapter }
	| { status: 'unsupported' };

export type StartBackgroundScreenshotResult =
	| 'started'
	| 'unsupported-platform'
	| 'no-target'
	| 'busy'
	| 'unsupported';

export interface BackgroundScreenshotCapture<TFile> {
	sessionId: string;
	startedAt: Date;
	targetFile: TFile;
	targetNameAtStart: string;
	event: ClassroomScreenshotEvent;
	pngData: Uint8Array;
	isActive(): boolean;
}

export type BackgroundScreenshotCaptureResult =
	| { status: 'inserted'; savedPath: string }
	| { status: 'saved-only'; savedPath: string; error: string }
	| { status: 'failed'; error: string };
