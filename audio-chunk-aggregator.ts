import type { AudioCompanionFrame } from './audio-companion-types';
import {
	REALTIME_ASR_FRAME_BYTES,
	REALTIME_ASR_FRAME_SAMPLES,
	REALTIME_ASR_FRAMES_PER_CHUNK,
	REALTIME_ASR_SAMPLE_RATE,
	RealtimeAsrError,
} from './realtime-asr-types';

export interface RealtimeAsrAudioChunk {
	data: Uint8Array;
	frameCount: number;
	firstOffsetMs: number;
}

export class AudioChunkAggregator {
	private parts: Uint8Array[] = [];
	private firstOffsetMs: number | null = null;
	private previousSequence: number | null = null;

	get pendingFrameCount(): number {
		return this.parts.length;
	}

	push(frame: AudioCompanionFrame): RealtimeAsrAudioChunk | null {
		validateFrame(frame, this.previousSequence);
		this.previousSequence = frame.sequence;
		if (this.firstOffsetMs === null) {
			this.firstOffsetMs = frame.offsetMs;
		}
		this.parts.push(frame.pcm.slice());
		return this.parts.length === REALTIME_ASR_FRAMES_PER_CHUNK
			? this.takeChunk()
			: null;
	}

	flushResidual(): RealtimeAsrAudioChunk | null {
		return this.parts.length > 0 ? this.takeChunk() : null;
	}

	reset(): void {
		for (const part of this.parts) {
			part.fill(0);
		}
		this.parts = [];
		this.firstOffsetMs = null;
		this.previousSequence = null;
	}

	private takeChunk(): RealtimeAsrAudioChunk {
		const frameCount = this.parts.length;
		const data = new Uint8Array(frameCount * REALTIME_ASR_FRAME_BYTES);
		for (let index = 0; index < frameCount; index += 1) {
			const part = this.parts[index];
			if (part) {
				data.set(part, index * REALTIME_ASR_FRAME_BYTES);
				part.fill(0);
			}
		}
		const chunk = {
			data,
			frameCount,
			firstOffsetMs: this.firstOffsetMs ?? 0,
		};
		this.parts = [];
		this.firstOffsetMs = null;
		return chunk;
	}
}

function validateFrame(frame: AudioCompanionFrame, previousSequence: number | null): void {
	if (previousSequence !== null && frame.sequence !== previousSequence + 1) {
		throw new RealtimeAsrError('audio-sequence-invalid');
	}
	if (frame.sampleRate !== REALTIME_ASR_SAMPLE_RATE
		|| frame.channels !== 1
		|| frame.sampleFormat !== 's16le'
		|| frame.sampleCount !== REALTIME_ASR_FRAME_SAMPLES
		|| frame.durationMs !== 20
		|| frame.pcm.byteLength !== REALTIME_ASR_FRAME_BYTES) {
		throw new RealtimeAsrError('audio-format-invalid');
	}
}
