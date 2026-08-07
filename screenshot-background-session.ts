import type {
	BackgroundScreenshotCapture,
	BackgroundScreenshotCaptureResult,
	ClassroomSession,
	ClassroomScreenshotEvent,
	ClipboardImageCandidate,
	ScreenshotBackgroundDetection,
	ScreenshotBackgroundState,
	ScreenshotBackgroundStopReason,
	ScreenshotClipboardAdapter,
	ScreenshotClipboardAdapterResult,
	StartBackgroundScreenshotResult,
} from './screenshot-background-types';

export const SCREENSHOT_CLIPBOARD_POLL_INTERVAL_MS = 900;

export interface ScreenshotBackgroundSessionHost<TFile> {
	isDesktopApp(): boolean;
	isConflictingWorkflowActive(): boolean;
	createClipboardAdapter(): ScreenshotClipboardAdapterResult;
	createSessionId(startedAt: Date): string;
	filePath(file: TFile): string;
	fileName(file: TFile): string;
	isTargetFileAvailable(file: TFile): boolean;
	now(): Date;
	setInterval(callback: () => void, intervalMs: number): number;
	clearInterval(intervalId: number): void;
	processScreenshot(capture: BackgroundScreenshotCapture<TFile>): Promise<BackgroundScreenshotCaptureResult>;
	onEventResult(event: ClassroomScreenshotEvent): void;
	onStopped(reason: ScreenshotBackgroundStopReason): void;
}

export class ScreenshotBackgroundSession<TFile> {
	private currentState: ScreenshotBackgroundState = emptyState();
	private targetFile: TFile | null = null;
	private targetNameAtStart: string | null = null;
	private adapter: ScreenshotClipboardAdapter | null = null;
	private intervalId: number | null = null;
	private polling = false;
	private disposed = false;
	private lastLightFingerprint: string | null = null;
	private readonly seenFullFingerprints = new Set<string>();
	private readonly listeners = new Set<(state: ScreenshotBackgroundState) => void>();
	private processingQueue: Promise<void> = Promise.resolve();

	constructor(private readonly host: ScreenshotBackgroundSessionHost<TFile>) {}

	get state(): ScreenshotBackgroundState {
		return cloneState(this.currentState);
	}

	get isListening(): boolean {
		return this.currentState.status === 'listening';
	}

	get classroomSession(): ClassroomSession<TFile> | null {
		const { sessionId, startedAt } = this.currentState;
		if (!sessionId || !startedAt || !this.targetFile) {
			return null;
		}
		return {
			sessionId,
			targetFile: this.targetFile,
			startedAt: new Date(startedAt),
			endedAt: this.currentState.endedAt ? new Date(this.currentState.endedAt) : null,
			status: this.currentState.status,
			detectedCount: this.currentState.detectedCount,
			savedCount: this.currentState.savedCount,
			insertedCount: this.currentState.insertedCount,
			failedCount: this.currentState.failedCount,
			events: this.currentState.events.map(cloneEvent),
		};
	}

	setTarget(file: TFile): boolean {
		if (this.isListening) {
			return false;
		}
		this.targetFile = file;
		this.updateTargetState();
		this.emit();
		return true;
	}

	start(): StartBackgroundScreenshotResult {
		if (this.isListening) {
			return 'busy';
		}
		if (!this.host.isDesktopApp()) {
			return 'unsupported-platform';
		}
		if (!this.targetFile || !this.host.isTargetFileAvailable(this.targetFile)) {
			return 'no-target';
		}
		if (this.host.isConflictingWorkflowActive()) {
			return 'busy';
		}

		const adapterResult = this.host.createClipboardAdapter();
		if (adapterResult.status !== 'ready') {
			this.setUnsupported();
			return 'unsupported';
		}
		const startedAt = this.host.now();
		const sessionId = this.host.createSessionId(startedAt);
		this.adapter = adapterResult.adapter;
		this.disposed = false;
		this.targetNameAtStart = this.host.fileName(this.targetFile);
		this.lastLightFingerprint = null;
		this.seenFullFingerprints.clear();
		this.processingQueue = Promise.resolve();
		this.currentState = {
			...emptyState(),
			status: 'listening',
			sessionId,
			startedAt,
		};
		this.updateTargetState();
		try {
			this.recordInitialClipboardImage();
		} catch {
			this.setUnsupported();
			return 'unsupported';
		}
		this.intervalId = this.host.setInterval(
			() => this.pollNow(),
			SCREENSHOT_CLIPBOARD_POLL_INTERVAL_MS,
		);
		this.emit();
		return 'started';
	}

	stop(reason: ScreenshotBackgroundStopReason = 'manual'): void {
		this.stopInternal(reason, false);
	}

	dispose(): void {
		this.disposed = true;
		this.stopInternal('unload', true);
		this.listeners.clear();
	}

	pollNow(): void {
		if (!this.isListening || this.polling || !this.adapter || !this.targetFile) {
			return;
		}
		if (!this.host.isTargetFileAvailable(this.targetFile)) {
			this.stopInternal('target-deleted', true);
			return;
		}
		if (this.host.isConflictingWorkflowActive()) {
			this.stopInternal('manual', false);
			return;
		}

		this.polling = true;
		try {
			this.updateTargetState();
			const candidate = this.adapter.readImageCandidate();
			this.inspectCandidate(candidate, true);
		} catch {
			this.setUnsupported();
		} finally {
			this.polling = false;
		}
	}

	handleTargetDeleted(file: TFile): void {
		if (file === this.targetFile) {
			this.stopInternal('target-deleted', true);
		}
	}

	handleTargetRenamed(file: TFile): void {
		if (file !== this.targetFile) {
			return;
		}
		this.updateTargetState();
		this.emit();
	}

	subscribe(listener: (state: ScreenshotBackgroundState) => void): () => void {
		this.listeners.add(listener);
		listener(this.state);
		return () => this.listeners.delete(listener);
	}

	private recordInitialClipboardImage(): void {
		const candidate = this.adapter?.readImageCandidate() ?? null;
		this.inspectCandidate(candidate, false);
	}

	private inspectCandidate(
		candidate: ClipboardImageCandidate | null,
		countAsNew: boolean,
	): void {
		if (!candidate) {
			return;
		}
		try {
			if (candidate.lightFingerprint === this.lastLightFingerprint) {
				return;
			}
			this.lastLightFingerprint = candidate.lightFingerprint;
			const fullFingerprint = candidate.fullFingerprint();
			if (this.seenFullFingerprints.has(fullFingerprint)) {
				return;
			}
			this.seenFullFingerprints.add(fullFingerprint);
			if (!countAsNew) {
				return;
			}
			const pngData = candidate.takePngData();
			const event = this.createEvent(candidate);
			this.currentState = {
				...this.currentState,
				detectedCount: this.currentState.detectedCount + 1,
				lastDetection: detectionFromEvent(event),
				events: [...this.currentState.events, event],
			};
			this.emit();
			this.enqueueProcessing(event, pngData);
		} finally {
			candidate.release();
		}
	}

	private createEvent(candidate: ClipboardImageCandidate): ClassroomScreenshotEvent {
		const detectedAt = this.host.now();
		const startedAt = this.currentState.startedAt;
		const sessionId = this.currentState.sessionId;
		if (!startedAt || !sessionId) {
			throw new Error('Screenshot session is not initialized.');
		}
		const sequence = this.currentState.detectedCount + 1;
		return {
			eventId: `${sessionId}-screenshot-${String(sequence).padStart(4, '0')}`,
			type: 'screenshot',
			width: candidate.width,
			height: candidate.height,
			detectedAt,
			offsetMs: Math.max(0, detectedAt.getTime() - startedAt.getTime()),
			status: 'detected',
			savedPath: null,
			error: null,
		};
	}

	private enqueueProcessing(event: ClassroomScreenshotEvent, pngData: Uint8Array): void {
		const sessionId = this.currentState.sessionId;
		const startedAt = this.currentState.startedAt;
		const targetFile = this.targetFile;
		const targetNameAtStart = this.targetNameAtStart;
		if (!sessionId || !startedAt || !targetFile || !targetNameAtStart) {
			pngData.fill(0);
			return;
		}
		this.processingQueue = this.processingQueue.catch(() => undefined).then(async () => {
			let result: BackgroundScreenshotCaptureResult;
			try {
				if (!this.isCaptureActive(sessionId, event.eventId)) {
					result = { status: 'failed', error: '课堂截图会话已停止。' };
				} else {
					result = await this.host.processScreenshot({
						sessionId,
						startedAt,
						targetFile,
						targetNameAtStart,
						event: cloneEvent(event),
						pngData,
						isActive: () => this.isCaptureActive(sessionId, event.eventId),
					});
				}
			} catch {
				result = { status: 'failed', error: '后台课堂截图处理失败。' };
			} finally {
				pngData.fill(0);
			}
			this.applyCaptureResult(sessionId, event.eventId, result);
		});
	}

	private isCaptureActive(sessionId: string, eventId: string): boolean {
		return !this.disposed
			&& this.isListening
			&& this.currentState.sessionId === sessionId
			&& this.currentState.events.some((event) =>
				event.eventId === eventId && event.status === 'detected');
	}

	private applyCaptureResult(
		sessionId: string,
		eventId: string,
		result: BackgroundScreenshotCaptureResult,
	): void {
		if (this.currentState.sessionId !== sessionId) {
			return;
		}
		const eventIndex = this.currentState.events.findIndex((event) => event.eventId === eventId);
		if (eventIndex < 0 || this.currentState.events[eventIndex]?.status !== 'detected') {
			return;
		}
		const events = this.currentState.events.map((event, index) => {
			if (index !== eventIndex) {
				return event;
			}
			if (result.status === 'inserted') {
				return { ...event, status: 'inserted' as const, savedPath: result.savedPath };
			}
			if (result.status === 'saved-only') {
				return {
					...event,
					status: 'saved' as const,
					savedPath: result.savedPath,
					error: result.error,
				};
			}
			return { ...event, status: 'failed' as const, error: result.error };
		});
		const updatedEvent = events[eventIndex];
		if (!updatedEvent) {
			return;
		}
		this.currentState = {
			...this.currentState,
			events,
			savedCount: this.currentState.savedCount
				+ (result.status === 'inserted' || result.status === 'saved-only' ? 1 : 0),
			insertedCount: this.currentState.insertedCount
				+ (result.status === 'inserted' ? 1 : 0),
			failedCount: this.currentState.failedCount
				+ (result.status === 'inserted' ? 0 : 1),
			lastSavedPath: result.status === 'failed'
				? this.currentState.lastSavedPath
				: result.savedPath,
			lastError: result.status === 'inserted' ? null : result.error,
		};
		this.emit();
		try {
			this.host.onEventResult(cloneEvent(updatedEvent));
		} catch {
			// UI feedback failures must not stop later screenshot events.
		}
	}

	private setUnsupported(): void {
		this.clearRuntimeResources();
		this.currentState = {
			...this.currentState,
			status: 'unsupported',
			endedAt: this.currentState.startedAt ? this.host.now() : null,
			lastError: '当前环境不支持后台剪贴板图片监听。',
		};
		this.emit();
		this.host.onStopped('capability-failed');
	}

	private stopInternal(reason: ScreenshotBackgroundStopReason, clearTarget: boolean): void {
		const wasListening = this.isListening;
		this.clearRuntimeResources();
		if (clearTarget) {
			this.targetFile = null;
		}
		this.currentState = {
			...this.currentState,
			status: 'idle',
			endedAt: wasListening ? this.host.now() : this.currentState.endedAt,
			...(reason === 'target-deleted'
				? { lastError: '目标课堂笔记已被删除，监听已停止。' }
				: {}),
			...(clearTarget ? { targetPath: null, targetName: null } : {}),
		};
		this.emit();
		if (wasListening || reason === 'target-deleted') {
			this.host.onStopped(reason);
		}
	}

	private clearRuntimeResources(): void {
		if (this.intervalId !== null) {
			this.host.clearInterval(this.intervalId);
			this.intervalId = null;
		}
		this.adapter?.dispose();
		this.adapter = null;
		this.polling = false;
		this.lastLightFingerprint = null;
		this.seenFullFingerprints.clear();
	}

	private updateTargetState(): void {
		if (!this.targetFile) {
			return;
		}
		this.currentState = {
			...this.currentState,
			targetPath: this.host.filePath(this.targetFile),
			targetName: this.host.fileName(this.targetFile),
		};
	}

	private emit(): void {
		const state = this.state;
		for (const listener of this.listeners) {
			listener(state);
		}
	}
}

export function buildClassroomSessionId(startedAt: Date): string {
	return [
		String(startedAt.getFullYear()).padStart(4, '0'),
		String(startedAt.getMonth() + 1).padStart(2, '0'),
		String(startedAt.getDate()).padStart(2, '0'),
		'-',
		String(startedAt.getHours()).padStart(2, '0'),
		String(startedAt.getMinutes()).padStart(2, '0'),
		String(startedAt.getSeconds()).padStart(2, '0'),
		'-',
		String(startedAt.getMilliseconds()).padStart(3, '0'),
	].join('');
}

function emptyState(): ScreenshotBackgroundState {
	return {
		status: 'idle',
		sessionId: null,
		startedAt: null,
		endedAt: null,
		targetPath: null,
		targetName: null,
		detectedCount: 0,
		savedCount: 0,
		insertedCount: 0,
		failedCount: 0,
		lastDetection: null,
		lastSavedPath: null,
		lastError: null,
		events: [],
	};
}

function detectionFromEvent(event: ClassroomScreenshotEvent): ScreenshotBackgroundDetection {
	return {
		width: event.width,
		height: event.height,
		detectedAt: new Date(event.detectedAt),
	};
}

function cloneEvent(event: ClassroomScreenshotEvent): ClassroomScreenshotEvent {
	return { ...event, detectedAt: new Date(event.detectedAt) };
}

function cloneState(state: ScreenshotBackgroundState): ScreenshotBackgroundState {
	return {
		...state,
		startedAt: state.startedAt ? new Date(state.startedAt) : null,
		endedAt: state.endedAt ? new Date(state.endedAt) : null,
		lastDetection: state.lastDetection
			? { ...state.lastDetection, detectedAt: new Date(state.lastDetection.detectedAt) }
			: null,
		events: state.events.map(cloneEvent),
	};
}
