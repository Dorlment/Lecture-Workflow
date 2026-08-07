import {
	App,
	normalizePath,
	TFile,
	TFolder,
} from 'obsidian';

import type {
	BackgroundScreenshotCapture,
	BackgroundScreenshotCaptureResult,
} from './screenshot-background-types';
import {
	BackgroundScreenshotWriter,
} from './screenshot-background-workflow';

export class ObsidianBackgroundScreenshotService {
	private readonly writer: BackgroundScreenshotWriter<TFile, TFile>;

	constructor(private readonly app: App) {
		this.writer = new BackgroundScreenshotWriter<TFile, TFile>({
			isTargetAvailable: (file) =>
				this.app.vault.getAbstractFileByPath(file.path) === file,
			ensureFolder: (path) => this.ensureFolder(path),
			pathExists: (path) => Boolean(this.app.vault.getAbstractFileByPath(normalizePath(path))),
			createBinary: (path, data) => this.app.vault.createBinary(
				normalizePath(path),
				toExactArrayBuffer(data),
			),
			filePath: (file) => file.path,
			generateMarkdownLink: (file, targetFile) =>
				this.app.fileManager.generateMarkdownLink(file, targetFile.path),
			process: async (file, callback) => {
				await this.app.vault.process(file, callback);
			},
		});
	}

	process(
		capture: BackgroundScreenshotCapture<TFile>,
	): Promise<BackgroundScreenshotCaptureResult> {
		return this.writer.write(capture);
	}

	dispose(): void {
		this.writer.dispose();
	}

	private async ensureFolder(folderPath: string): Promise<void> {
		let currentPath = '';
		for (const segment of normalizePath(folderPath).split('/')) {
			if (!segment || segment === '.' || segment === '..') {
				throw new Error('Invalid screenshot folder.');
			}
			currentPath = normalizePath(currentPath ? `${currentPath}/${segment}` : segment);
			const existing = this.app.vault.getAbstractFileByPath(currentPath);
			if (existing instanceof TFolder) {
				continue;
			}
			if (existing) {
				throw new Error('Screenshot folder conflicts with a file.');
			}
			try {
				await this.app.vault.createFolder(currentPath);
			} catch {
				if (!(this.app.vault.getAbstractFileByPath(currentPath) instanceof TFolder)) {
					throw new Error('Screenshot folder creation failed.');
				}
			}
		}
	}
}

function toExactArrayBuffer(data: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(data.byteLength);
	copy.set(data);
	return copy.buffer;
}
