import { buildScreenshotEmbed, sanitizeScreenshotNoteName } from './screenshot-core';
import type {
	BackgroundScreenshotCapture,
	BackgroundScreenshotCaptureResult,
} from './screenshot-background-types';
import {
	formatScreenshotOffsetFilename,
	insertScreenshotTimelineEvent,
} from './screenshot-timeline';

export const MAX_BACKGROUND_SCREENSHOT_BYTES = 25 * 1024 * 1024;
const MAX_FILENAME_ATTEMPTS = 1_000;

export interface BackgroundScreenshotWriterHost<TTargetFile, TImageFile> {
	isTargetAvailable(file: TTargetFile): boolean;
	ensureFolder(path: string): Promise<void>;
	pathExists(path: string): boolean;
	createBinary(path: string, data: Uint8Array): Promise<TImageFile>;
	filePath(file: TImageFile): string;
	generateMarkdownLink(file: TImageFile, targetFile: TTargetFile): string;
	process(file: TTargetFile, callback: (markdown: string) => string): Promise<void>;
}

export class BackgroundScreenshotWriter<TTargetFile, TImageFile> {
	private readonly savedEvents = new Map<string, TImageFile>();

	constructor(private readonly host: BackgroundScreenshotWriterHost<TTargetFile, TImageFile>) {}

	async write(
		capture: BackgroundScreenshotCapture<TTargetFile>,
	): Promise<BackgroundScreenshotCaptureResult> {
		if (capture.pngData.byteLength === 0
			|| capture.pngData.byteLength > MAX_BACKGROUND_SCREENSHOT_BYTES) {
			return { status: 'failed', error: '截图 PNG 为空或超过 25 MiB 安全限制。' };
		}
		if (!capture.isActive() || !this.host.isTargetAvailable(capture.targetFile)) {
			return { status: 'failed', error: '课堂截图会话已停止或目标笔记不可用。' };
		}

		let imageFile = this.savedEvents.get(capture.event.eventId);
		if (!imageFile) {
			const folderPath = buildBackgroundScreenshotFolder(
				capture.targetNameAtStart,
				capture.sessionId,
			);
			try {
				await this.host.ensureFolder(folderPath);
			} catch {
				return { status: 'failed', error: '无法创建课堂截图附件目录。' };
			}
			if (!capture.isActive() || !this.host.isTargetAvailable(capture.targetFile)) {
				return { status: 'failed', error: '课堂截图会话已停止或目标笔记不可用。' };
			}
			try {
				imageFile = await createAvailableFile(
					folderPath,
					formatScreenshotOffsetFilename(capture.event.offsetMs),
					capture.pngData,
					this.host,
				);
			} catch {
				return { status: 'failed', error: '无法在 Vault 中保存课堂截图。' };
			}
			this.savedEvents.set(capture.event.eventId, imageFile);
		}

		const savedPath = this.host.filePath(imageFile);
		if (!capture.isActive() || !this.host.isTargetAvailable(capture.targetFile)) {
			return {
				status: 'saved-only',
				savedPath,
				error: '截图已保存，但会话已停止或目标笔记不可用，未写入课堂时间线。',
			};
		}

		let imageEmbed: string;
		try {
			imageEmbed = buildScreenshotEmbed(
				this.host.generateMarkdownLink(imageFile, capture.targetFile),
			);
		} catch {
			return {
				status: 'saved-only',
				savedPath,
				error: '截图已保存，但无法生成 Obsidian 图片链接。',
			};
		}

		let insertedOrPresent = false;
		try {
			await this.host.process(capture.targetFile, (markdown) => {
				if (!capture.isActive()) {
					return markdown;
				}
				const result = insertScreenshotTimelineEvent(
					markdown,
					capture.event,
					imageEmbed,
				);
				insertedOrPresent = result.inserted || result.duplicate;
				return result.markdown;
			});
		} catch {
			return {
				status: 'saved-only',
				savedPath,
				error: '截图已保存，但无法写入课堂时间线。',
			};
		}
		if (!insertedOrPresent) {
			return {
				status: 'saved-only',
				savedPath,
				error: '截图已保存，但课堂截图会话已停止，未写入时间线。',
			};
		}
		return { status: 'inserted', savedPath };
	}

	dispose(): void {
		this.savedEvents.clear();
	}
}

export function buildBackgroundScreenshotFolder(noteName: string, sessionId: string): string {
	if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId === '.' || sessionId === '..') {
		throw new Error('课堂会话 ID 无效。');
	}
	return `课堂附件/${sanitizeScreenshotNoteName(noteName)}/${sessionId}/screenshots`;
}

export function buildBackgroundScreenshotCandidatePath(
	folderPath: string,
	filenameStem: string,
	sequence: number,
): string {
	if (!/^[0-9-]+$/.test(filenameStem)
		|| !Number.isSafeInteger(sequence)
		|| sequence < 1) {
		throw new Error('课堂截图文件名无效。');
	}
	const suffix = sequence === 1 ? '' : `-${sequence}`;
	return `${folderPath}/${filenameStem}${suffix}.png`;
}

async function createAvailableFile<TTargetFile, TImageFile>(
	folderPath: string,
	filenameStem: string,
	pngData: Uint8Array,
	host: BackgroundScreenshotWriterHost<TTargetFile, TImageFile>,
): Promise<TImageFile> {
	for (let sequence = 1; sequence <= MAX_FILENAME_ATTEMPTS; sequence += 1) {
		const path = buildBackgroundScreenshotCandidatePath(folderPath, filenameStem, sequence);
		if (host.pathExists(path)) {
			continue;
		}
		try {
			return await host.createBinary(path, pngData);
		} catch {
			if (host.pathExists(path)) {
				continue;
			}
			throw new Error('Screenshot create failed.');
		}
	}
	throw new Error('Screenshot filename attempts exhausted.');
}
