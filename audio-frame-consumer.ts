import type { AudioCompanionFrame } from './audio-companion-types';

export interface AudioFrameConsumerState {
	frameCount: number;
	rms: number;
}

export class AudioFrameConsumer {
	private currentState: AudioFrameConsumerState = { frameCount: 0, rms: 0 };
	private disposed = false;

	get state(): AudioFrameConsumerState {
		return { ...this.currentState };
	}

	consume(frame: AudioCompanionFrame): void {
		if (this.disposed) {
			return;
		}
		this.currentState = {
			frameCount: this.currentState.frameCount + 1,
			rms: calculatePcmS16LeRms(frame.pcm),
		};
	}

	reset(): void {
		if (!this.disposed) {
			this.currentState = { frameCount: 0, rms: 0 };
		}
	}

	dispose(): void {
		this.disposed = true;
		this.currentState = { frameCount: 0, rms: 0 };
	}
}

export function calculatePcmS16LeRms(pcm: Uint8Array): number {
	if (pcm.byteLength < 2) {
		return 0;
	}
	const sampleCount = Math.floor(pcm.byteLength / 2);
	const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
	let sumSquares = 0;
	for (let index = 0; index < sampleCount; index += 1) {
		const sample = view.getInt16(index * 2, true);
		const normalized = sample < 0 ? sample / 32_768 : sample / 32_767;
		sumSquares += normalized * normalized;
	}
	return Math.min(1, Math.sqrt(sumSquares / sampleCount));
}
