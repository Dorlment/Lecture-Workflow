import type { AudioCompanionRuntimeState } from './audio-companion-runtime-types';

export interface AudioCompanionWorkbenchBindingHost {
	readState(): AudioCompanionRuntimeState;
	subscribe(listener: (state: AudioCompanionRuntimeState) => void): () => void;
	apply(state: AudioCompanionRuntimeState): void;
	schedule(callback: () => void, delayMs: number): number;
	cancel(timerId: number): void;
}

export class AudioCompanionWorkbenchBinding {
	private unsubscribe: (() => void) | null = null;
	private timerId: number | null = null;
	private pendingState: AudioCompanionRuntimeState | null = null;
	private generation = 0;

	constructor(
		private readonly host: AudioCompanionWorkbenchBindingHost,
		private readonly throttleMs = 150,
	) {}

	open(): void {
		if (this.unsubscribe) {
			return;
		}
		this.generation += 1;
		this.host.apply(this.host.readState());
		const generation = this.generation;
		let subscribing = true;
		this.unsubscribe = this.host.subscribe((state) => {
			if (!subscribing) {
				this.queue(state, generation);
			}
		});
		subscribing = false;
	}

	close(): void {
		this.generation += 1;
		this.unsubscribe?.();
		this.unsubscribe = null;
		if (this.timerId !== null) {
			this.host.cancel(this.timerId);
			this.timerId = null;
		}
		this.pendingState = null;
	}

	private queue(state: AudioCompanionRuntimeState, generation: number): void {
		if (generation !== this.generation) {
			return;
		}
		this.pendingState = { ...state };
		if (this.timerId !== null) {
			return;
		}
		this.timerId = this.host.schedule(() => {
			this.timerId = null;
			if (generation !== this.generation) {
				this.pendingState = null;
				return;
			}
			const pending = this.pendingState;
			this.pendingState = null;
			if (pending) {
				this.host.apply(pending);
			}
		}, this.throttleMs);
	}
}
