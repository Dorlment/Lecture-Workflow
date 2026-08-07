import type {
	ScreenshotBackgroundState,
	ScreenshotBackgroundStopReason,
	StartBackgroundScreenshotResult,
} from './screenshot-background-types';

/**
 * Narrow runtime boundary for the current screenshot participant. Future audio
 * and transcription participants can be coordinated here without owning a
 * second copy of classroom-session state.
 */
export interface ClassroomSessionRuntime<TFile> {
	readonly isListening: boolean;
	readonly state: ScreenshotBackgroundState;
	setTarget(file: TFile): boolean;
	start(): StartBackgroundScreenshotResult;
	stop(reason?: ScreenshotBackgroundStopReason): void;
	dispose(): void;
	handleTargetDeleted(file: TFile): void;
	handleTargetRenamed(file: TFile): void;
	subscribe(listener: (state: ScreenshotBackgroundState) => void): () => void;
}

export type ClassroomSessionToggleResult =
	| StartBackgroundScreenshotResult
	| 'stopped';

export interface ClassroomSessionStopResult {
	stopped: boolean;
	savedCount: number;
}

export function classroomSessionMenuTitle(state: ScreenshotBackgroundState): string {
	return state.status === 'listening' ? '停止课堂监听' : '开始课堂监听';
}

export class ClassroomSessionController<TFile> {
	constructor(private readonly runtime: ClassroomSessionRuntime<TFile>) {}

	getState(): ScreenshotBackgroundState {
		return this.runtime.state;
	}

	setTarget(targetFile: TFile): boolean {
		return this.runtime.setTarget(targetFile);
	}

	start(targetFile: TFile): StartBackgroundScreenshotResult {
		if (this.runtime.isListening || !this.runtime.setTarget(targetFile)) {
			return 'busy';
		}
		return this.runtime.start();
	}

	stop(
		reason: ScreenshotBackgroundStopReason = 'manual',
	): ClassroomSessionStopResult {
		const state = this.runtime.state;
		if (!this.runtime.isListening) {
			return { stopped: false, savedCount: state.savedCount };
		}
		this.runtime.stop(reason);
		return { stopped: true, savedCount: state.savedCount };
	}

	toggle(activeFile: TFile | null): ClassroomSessionToggleResult {
		if (this.runtime.isListening) {
			this.runtime.stop('manual');
			return 'stopped';
		}
		if (!activeFile) {
			return 'no-target';
		}
		return this.start(activeFile);
	}

	subscribe(listener: (state: ScreenshotBackgroundState) => void): () => void {
		return this.runtime.subscribe(listener);
	}

	handleTargetDeleted(file: TFile): void {
		this.runtime.handleTargetDeleted(file);
	}

	handleTargetRenamed(file: TFile): void {
		this.runtime.handleTargetRenamed(file);
	}

	dispose(): void {
		this.runtime.dispose();
	}
}
