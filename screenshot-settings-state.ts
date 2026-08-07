import type { ScreenshotBackgroundState } from './screenshot-background-types';

export interface ScreenshotSettingsStateBindingHost {
	readState(): ScreenshotBackgroundState;
	subscribe(listener: (state: ScreenshotBackgroundState) => void): () => void;
	apply(state: ScreenshotBackgroundState): void;
	schedule(callback: () => void, delayMs: number): number;
	cancel(timerId: number): void;
}

export class ScreenshotSettingsStateBinding {
	private unsubscribe: (() => void) | null = null;
	private timerId: number | null = null;
	private pendingState: ScreenshotBackgroundState | null = null;

	constructor(
		private readonly host: ScreenshotSettingsStateBindingHost,
		private readonly throttleMs = 100,
	) {}

	open(): void {
		this.host.apply(this.host.readState());
		if (this.unsubscribe) {
			return;
		}
		this.unsubscribe = this.host.subscribe((state) => this.queue(state));
	}

	close(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		if (this.timerId !== null) {
			this.host.cancel(this.timerId);
			this.timerId = null;
		}
		this.pendingState = null;
	}

	private queue(state: ScreenshotBackgroundState): void {
		this.pendingState = state;
		if (this.timerId !== null) {
			return;
		}
		let ranSynchronously = false;
		const timerId = this.host.schedule(() => {
			ranSynchronously = true;
			this.timerId = null;
			const pending = this.pendingState;
			this.pendingState = null;
			if (pending) {
				this.host.apply(pending);
			}
		}, this.throttleMs);
		if (!ranSynchronously) {
			this.timerId = timerId;
		}
	}
}
