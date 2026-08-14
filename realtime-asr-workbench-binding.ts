import type { RealtimeAsrRuntimeState } from './realtime-asr-types';

export interface RealtimeAsrWorkbenchBindingHost {
	readState(): RealtimeAsrRuntimeState;
	subscribe(listener: (state: RealtimeAsrRuntimeState) => void): () => void;
	apply(state: RealtimeAsrRuntimeState): void;
	schedule(callback: () => void, delayMs: number): number;
	cancel(timerId: number): void;
	now?(): number;
}

export class RealtimeAsrWorkbenchBinding {
	private unsubscribe: (() => void) | null = null;
	private timerId: number | null = null;
	private pending: RealtimeAsrRuntimeState | null = null;
	private generation = 0;
	private lastObservedStatus: RealtimeAsrRuntimeState['status'] | null = null;
	private lastObservedError: RealtimeAsrRuntimeState['errorCode'] = null;
	private runIdentity: string | null = null;
	private renderStartedAtMs = 0;
	private renderCount = 0;
	private lastRenderDurationMs = 0;
	private maxRenderDurationMs = 0;

	constructor(
		private readonly host: RealtimeAsrWorkbenchBindingHost,
		private readonly throttleMs = 250,
	) {}

	open(): void {
		if (this.unsubscribe) return;
		const generation = ++this.generation;
		this.applyNow(this.host.readState());
		let subscribing = true;
		this.unsubscribe = this.host.subscribe((state) => {
			if (!subscribing) this.queue(state, generation);
		});
		subscribing = false;
	}

	close(): void {
		this.generation += 1;
		this.unsubscribe?.();
		this.unsubscribe = null;
		if (this.timerId !== null) this.host.cancel(this.timerId);
		this.timerId = null;
		this.pending = null;
	}

	private queue(state: RealtimeAsrRuntimeState, generation: number): void {
		if (generation !== this.generation) return;
		const lifecycleChanged = state.status !== this.lastObservedStatus
			|| state.errorCode !== this.lastObservedError;
		this.lastObservedStatus = state.status;
		this.lastObservedError = state.errorCode;
		if (lifecycleChanged) {
			if (this.timerId !== null) this.host.cancel(this.timerId);
			this.timerId = null;
			this.pending = null;
			this.applyNow(state);
			return;
		}
		this.pending = state;
		if (this.timerId !== null) return;
		this.timerId = this.host.schedule(() => {
			this.timerId = null;
			if (generation !== this.generation) return;
			const stateToApply = this.pending;
			this.pending = null;
			if (stateToApply) this.applyNow(stateToApply);
		}, this.throttleMs);
	}

	private applyNow(state: RealtimeAsrRuntimeState): void {
		this.lastObservedStatus = state.status;
		this.lastObservedError = state.errorCode;
		const now = this.now();
		const identity = state.startedAt === null || state.classroomSessionId === null
			? null
			: `${state.classroomSessionId}:${state.startedAt}`;
		if (identity !== null && identity !== this.runIdentity) {
			this.runIdentity = identity;
			this.renderStartedAtMs = now;
			this.renderCount = 0;
			this.lastRenderDurationMs = 0;
			this.maxRenderDurationMs = 0;
		}
		if (this.renderStartedAtMs === 0) this.renderStartedAtMs = now;
		this.renderCount += 1;
		const snapshot: RealtimeAsrRuntimeState = {
			...state,
			diagnostics: {
				...state.diagnostics,
				workbenchRenderCount: this.renderCount,
				workbenchRenderRate: ratePerSecond(
					this.renderCount,
					now - this.renderStartedAtMs,
				),
				workbenchLastRenderDurationMs: this.lastRenderDurationMs,
				workbenchMaxRenderDurationMs: this.maxRenderDurationMs,
			},
		};
		const startedAt = this.now();
		this.host.apply(snapshot);
		this.lastRenderDurationMs = roundMetric(Math.max(0, this.now() - startedAt));
		this.maxRenderDurationMs = Math.max(
			this.maxRenderDurationMs,
			this.lastRenderDurationMs,
		);
	}

	private now(): number {
		return this.host.now?.()
			?? (typeof performance === 'undefined' ? Date.now() : performance.now());
	}
}

function roundMetric(value: number): number {
	return Math.round(value * 1_000) / 1_000;
}

function ratePerSecond(count: number, elapsedMs: number): number {
	if (count <= 0) return 0;
	return roundMetric(count * 1_000 / Math.max(1, elapsedMs));
}
