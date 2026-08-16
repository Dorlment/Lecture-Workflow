import type { App, TFile } from 'obsidian';
import type { PersistentTranscriptEntry } from './realtime-asr-transcript-persistence';
import { appendFinalsToTranscript } from './classroom-transcript-writer';

export interface TranscriptVaultWriterOptions {
	app: App;
}

export class RealtimeAsrTranscriptVaultWriter {
	private readonly app: App;
	private writeInProgress = false;

	constructor(options: TranscriptVaultWriterOptions) {
		this.app = options.app;
	}

	async write(targetFile: TFile, entries: readonly PersistentTranscriptEntry[]): Promise<boolean> {
		if (this.writeInProgress) return false;
		this.writeInProgress = true;
		try {
			await this.app.vault.process(targetFile, (content) => {
				return appendFinalsToTranscript(content, entries);
			});
			return true;
		} catch {
			return false;
		} finally {
			this.writeInProgress = false;
		}
	}
}
