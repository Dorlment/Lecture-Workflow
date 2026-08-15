import type { RealtimeAsrSegment } from './realtime-asr-types';

/**
 * Bailian begin_time reference semantics require integration validation before Vault wiring.
 */
export function computeClassroomOffsetMs(
	audioBaseOffsetMs: number | null,
	timeMs: number,
): number | null {
	if (audioBaseOffsetMs === null) return null;
	return audioBaseOffsetMs + timeMs;
}

export interface PersistentTranscriptEntry {
	eventId: string;
	classroomSessionId: string;
	asrRunId: string;
	sentenceId: number;
	text: string;
	beginTimeMs: number;
	endTimeMs: number;
	classroomOffsetMs: number;
	classroomEndOffsetMs: number;
	receivedAt: number;
	persisted: boolean;
}

export interface FlushBatch {
	readonly token: symbol;
	readonly entries: readonly PersistentTranscriptEntry[];
}

export interface TranscriptPersistenceScheduler {
	now(): number;
}

export interface TranscriptPersistenceOptions {
	idFactory?: () => string;
	scheduler?: TranscriptPersistenceScheduler;
	maxBufferedFinals?: number;
	maxFlushIntervalMs?: number;
}

export const DEFAULT_MAX_BUFFERED_FINALS = 10;
export const DEFAULT_MAX_FLUSH_INTERVAL_MS = 5_000;
export const STOP_FLUSH_TIMEOUT_MS = 5_000;
export const MAX_PENDING_TRANSCRIPT_ENTRIES = 100;

export class RealtimeAsrTranscriptPersistence {
	private readonly idFactory: () => string;
	private readonly scheduler: TranscriptPersistenceScheduler;
	private readonly maxBufferedFinals: number;
	private readonly maxFlushIntervalMs: number;

	private currentRunId: string | null = null;
	private currentClassroomSessionId: string | null = null;
	private readonly seenSentenceIds = new Set<number>();
	private readonly buffer: PersistentTranscriptEntry[] = [];
	private pendingFlush: FlushBatch | null = null;

	constructor(options: TranscriptPersistenceOptions = {}) {
		this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
		this.scheduler = options.scheduler ?? { now: () => Date.now() };
		this.maxBufferedFinals = options.maxBufferedFinals ?? DEFAULT_MAX_BUFFERED_FINALS;
		this.maxFlushIntervalMs = options.maxFlushIntervalMs ?? DEFAULT_MAX_FLUSH_INTERVAL_MS;
	}

	get activeRunId(): string | null {
		return this.currentRunId;
	}

	get activeClassroomSessionId(): string | null {
		return this.currentClassroomSessionId;
	}

	beginRun(classroomSessionId: string): void {
		this.currentRunId = this.idFactory();
		this.currentClassroomSessionId = classroomSessionId;
		this.seenSentenceIds.clear();
	}

	endRun(): void {
		this.currentRunId = null;
		this.currentClassroomSessionId = null;
		this.seenSentenceIds.clear();
	}

	get pendingOverflow(): boolean {
		return this.buffer.length >= MAX_PENDING_TRANSCRIPT_ENTRIES;
	}

	receiveSegment(segment: RealtimeAsrSegment, audioBaseOffsetMs: number | null): void {
		if (!segment.isFinal) return;
		if (this.currentRunId === null || this.currentClassroomSessionId === null) return;
		if (this.seenSentenceIds.has(segment.sentenceId)) return;
		if (this.buffer.length >= MAX_PENDING_TRANSCRIPT_ENTRIES) return;

		const classroomOffsetMs = computeClassroomOffsetMs(audioBaseOffsetMs, segment.beginTimeMs);
		const classroomEndOffsetMs = computeClassroomOffsetMs(audioBaseOffsetMs, segment.endTimeMs);

		if (classroomOffsetMs === null || classroomEndOffsetMs === null) return;

		const entry: PersistentTranscriptEntry = {
			eventId: buildEventId(this.currentClassroomSessionId, this.currentRunId, segment.sentenceId),
			classroomSessionId: this.currentClassroomSessionId,
			asrRunId: this.currentRunId,
			sentenceId: segment.sentenceId,
			text: segment.text,
			beginTimeMs: segment.beginTimeMs,
			endTimeMs: segment.endTimeMs,
			classroomOffsetMs,
			classroomEndOffsetMs,
			receivedAt: this.scheduler.now(),
			persisted: false,
		};

		this.seenSentenceIds.add(segment.sentenceId);
		this.buffer.push(entry);
	}

	shouldFlush(): boolean {
		if (this.pendingFlush !== null) return false;
		const pending = this.buffer.filter(e => !e.persisted);
		if (pending.length === 0) return false;
		if (this.currentRunId === null) return true;
		if (pending.length >= this.maxBufferedFinals) return true;
		const firstPending = pending[0];
		if (!firstPending) return false;
		if (this.scheduler.now() - firstPending.receivedAt >= this.maxFlushIntervalMs) return true;
		return false;
	}

	prepareFlush(): FlushBatch | null {
		if (this.pendingFlush !== null) return null;
		const pending = this.buffer.filter(e => !e.persisted);
		if (pending.length === 0) return null;

		pending.sort((a, b) => {
			if (a.classroomOffsetMs !== b.classroomOffsetMs) return a.classroomOffsetMs - b.classroomOffsetMs;
			if (a.sentenceId !== b.sentenceId) return a.sentenceId - b.sentenceId;
			return a.eventId.localeCompare(b.eventId);
		});

		const token = Symbol('flush');
		this.pendingFlush = { token, entries: pending };
		return this.pendingFlush;
	}

	commitFlush(token: symbol): void {
		const flush = this.pendingFlush;
		if (flush === null || flush.token !== token) {
			throw new Error('Invalid flush token');
		}
		for (const entry of flush.entries) {
			entry.persisted = true;
		}
		for (let i = this.buffer.length - 1; i >= 0; i--) {
			const entry = this.buffer[i];
			if (entry?.persisted) {
				this.buffer.splice(i, 1);
			}
		}
		this.pendingFlush = null;
	}

	rollbackFlush(token: symbol): void {
		const flush = this.pendingFlush;
		if (flush === null || flush.token !== token) {
			throw new Error('Invalid flush token');
		}
		this.pendingFlush = null;
	}

	pendingCount(): number {
		return this.buffer.filter(e => !e.persisted).length;
	}
}

function buildEventId(classroomSessionId: string, asrRunId: string, sentenceId: number): string {
	return `${classroomSessionId}-asr-${asrRunId}-${sentenceId}`;
}
