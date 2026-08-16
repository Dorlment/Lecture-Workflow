import type { App, TFile } from 'obsidian';
import type {
	RealtimeAsrRuntimeState,
	RealtimeAsrStatus,
} from './realtime-asr-types';
import {
	RealtimeAsrTranscriptPersistence,
} from './realtime-asr-transcript-persistence';
import { RealtimeAsrTranscriptVaultWriter } from './realtime-asr-transcript-vault-writer';

export interface RealtimeAsrTranscriptSessionManagerOptions {
	app: App;
	subscribeToAsrState: (listener: (state: RealtimeAsrRuntimeState) => void) => () => void;
	resolveTargetFile: () => TFile | null;
}

const FLUSH_CHECK_INTERVAL_MS = 1_000;

export class RealtimeAsrTranscriptSessionManager {
	private readonly app: App;
	private readonly persistence: RealtimeAsrTranscriptPersistence;
	private readonly vaultWriter: RealtimeAsrTranscriptVaultWriter;
	private readonly subscribeToAsrState: RealtimeAsrTranscriptSessionManagerOptions['subscribeToAsrState'];
	private readonly resolveTargetFile: () => TFile | null;

	private asrUnsubscribe: (() => void) | null = null;
	private flushTimer: number | null = null;
	private lastStatus: RealtimeAsrStatus | null = null;
	private runAudioBaseOffsetMs: number | null = null;
	private disposed = false;

	constructor(options: RealtimeAsrTranscriptSessionManagerOptions) {
		this.app = options.app;
		this.subscribeToAsrState = options.subscribeToAsrState;
		this.resolveTargetFile = options.resolveTargetFile;
		this.persistence = new RealtimeAsrTranscriptPersistence();
		this.vaultWriter = new RealtimeAsrTranscriptVaultWriter({ app: options.app });
	}

	start(): void {
		if (this.disposed) return;
		this.asrUnsubscribe = this.subscribeToAsrState((state) => this.handleAsrState(state));
		this.flushTimer = window.setInterval(() => this.checkAndFlush(), FLUSH_CHECK_INTERVAL_MS);
	}

	stop(): void {
		if (this.flushTimer !== null) {
			window.clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
		if (this.asrUnsubscribe) {
			this.asrUnsubscribe();
			this.asrUnsubscribe = null;
		}
	}

	dispose(): void {
		this.disposed = true;
		this.stop();
	}

	get pendingCount(): number {
		return this.persistence.pendingCount();
	}

	get hasOverflow(): boolean {
		return this.persistence.pendingOverflow;
	}

	private handleAsrState(state: RealtimeAsrRuntimeState): void {
		if (this.disposed) return;

		const status = state.status;
		const prevStatus = this.lastStatus;

		if (this.isRunStart(status, prevStatus) && state.classroomSessionId) {
			this.persistence.beginRun(state.classroomSessionId);
			this.runAudioBaseOffsetMs = null;
		}

		if (this.isRunEnd(status, prevStatus)) {
			this.persistence.endRun();
			this.runAudioBaseOffsetMs = null;
			void this.flushNow();
		}

		if (state.audioBaseOffsetMs !== null && this.runAudioBaseOffsetMs === null) {
			this.runAudioBaseOffsetMs = state.audioBaseOffsetMs;
		}

		if (state.recentFinalSegments.length > 0 && this.runAudioBaseOffsetMs !== null) {
			for (const segment of state.recentFinalSegments) {
				this.persistence.receiveSegment(segment, this.runAudioBaseOffsetMs);
			}
		}

		if (this.persistence.shouldFlush()) {
			void this.flushNow();
		}

		this.lastStatus = status;
	}

	private isRunStart(status: RealtimeAsrStatus, prevStatus: RealtimeAsrStatus | null): boolean {
		if (status !== 'connecting') return false;
		if (prevStatus === null) return true;
		return prevStatus === 'idle'
			|| prevStatus === 'stopped'
			|| prevStatus === 'error'
			|| prevStatus === 'disabled'
			|| prevStatus === 'configuration-error';
	}

	private isRunEnd(status: RealtimeAsrStatus, prevStatus: RealtimeAsrStatus | null): boolean {
		if (status !== 'stopped' && status !== 'error') return false;
		if (prevStatus === null) return false;
		return prevStatus === 'connecting'
			|| prevStatus === 'starting-task'
			|| prevStatus === 'streaming'
			|| prevStatus === 'stopping';
	}

	private checkAndFlush(): void {
		if (this.disposed) return;
		if (this.persistence.shouldFlush()) {
			void this.flushNow();
		}
	}

	private async flushNow(): Promise<void> {
		if (this.disposed) return;

		const batch = this.persistence.prepareFlush();
		if (!batch) return;

		const targetFile = this.resolveTargetFile();
		if (!targetFile) {
			this.persistence.rollbackFlush(batch.token);
			return;
		}

		const success = await this.vaultWriter.write(targetFile, batch.entries);
		if (success) {
			this.persistence.commitFlush(batch.token);
		} else {
			this.persistence.rollbackFlush(batch.token);
		}
	}
}
