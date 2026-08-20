import { App, requireApiVersion, TFile } from 'obsidian';

import {
	extractTranscriptSection,
	hasAiRegion,
} from './ai-note';
import {
	assertAiOutputWritable,
	generateStructuredMarkdown,
} from './ai-generation';
import { buildTimelineContext } from './classroom-timeline-read-model';
import type { GenerationDiagnostics } from './generation-diagnostics';
import {
	collectVisionImages,
	verifyVisionAttachmentSnapshots,
	type VisionFileHandle,
} from './image-attachments';
import { parseVisionImageReferences } from './image-references';
import { ObsidianVisionAttachmentHost } from './obsidian-vision-attachment-host';
import type { TextProviderId, VisionProviderId } from './provider-types';
import type { ProviderRegistry } from './providers/registry';
import {
	assertTargetPath,
	freshReadConflictSafeWrite,
	processConflictSafeWrite,
} from './note-conflict';
import { generateVisionStructuredMarkdown } from './vision-generation';
import type {
	ParsedVisionImageReference,
	ResolvedVisionImage,
	VisionAttachmentSnapshot,
	VisionImageReference,
} from './vision-types';
import {
	extractScreenshotOffsets,
	mapImagesToTimeline,
	selectImagesByTimeline,
} from './vision-image-selector';

export interface AiGenerationSnapshot {
	filePath: string;
	transcript: string;
	originalTranscriptSection: string;
	originalContent: string;
	initialMtime: number;
	initialSize: number;
	replacesExistingResult: boolean;
	imageReferences: VisionImageReference[];
}

export interface VisionGenerationSnapshot extends AiGenerationSnapshot {
	resolvedImages: ResolvedVisionImage[];
	attachmentSnapshots: VisionAttachmentSnapshot[];
	/** Candidate image references found in the note before timeline selection. */
	sourceImageCount: number;
}

export interface AiPreviewData {
	filePath: string;
	generatedMarkdown: string;
	originalTranscriptSection: string;
	originalContent: string;
	initialMtime: number;
	initialSize: number;
	replacesExistingResult: boolean;
	isComplete: boolean;
	incompleteReason: string | null;
	providerId: TextProviderId;
	providerName: string;
	attempts: number;
	usesVision?: boolean;
	attachmentSnapshots?: VisionAttachmentSnapshot[];
	diagnostics?: GenerationDiagnostics;
}

export const VISION_WORKFLOW_CONFLICT_MESSAGE = '笔记或课堂图片在 AI 整理期间已发生变化，为避免写入过期结果，已取消写入。请关闭预览后重新整理。';

export class VisionWorkflowConflictError extends Error {
	readonly code = 'vision-workflow-conflict';

	constructor(
		readonly vaultPaths: string[],
		readonly phase: 'request' | 'write',
	) {
		super(phase === 'write'
			? VISION_WORKFLOW_CONFLICT_MESSAGE
			: `课堂图片在确认期间已发生变化，已取消请求：${vaultPaths.join('、')}`);
		this.name = 'VisionWorkflowConflictError';
	}
}

export class AiWorkflowService {
	constructor(
		private readonly app: App,
		private readonly providerRegistry: ProviderRegistry,
	) {}

	async prepare(file: TFile): Promise<AiGenerationSnapshot> {
		const content = await this.app.vault.read(file);
		const section = extractTranscriptSection(content);
		if (!section) {
			throw new Error('找不到“## 原始文字稿”标题。');
		}
		if (!section.transcript.trim()) {
			throw new Error('原始文字稿为空，未发送 AI 请求。');
		}
		return {
			filePath: file.path,
			transcript: section.transcript,
			originalTranscriptSection: section.protectedText,
			originalContent: content,
			initialMtime: file.stat.mtime,
			initialSize: file.stat.size,
			replacesExistingResult: hasAiRegion(content),
			imageReferences: parseVisionImageReferences(content),
		};
	}

	async prepareVision(
		snapshot: AiGenerationSnapshot,
		maxImages: number,
	): Promise<VisionGenerationSnapshot> {
		await this.assertSnapshotCurrent(snapshot);
		const target = this.app.vault.getAbstractFileByPath(snapshot.filePath);
		if (!(target instanceof TFile)) {
			throw new Error('目标笔记已不存在，已中止图片读取。');
		}
		const host = new ObsidianVisionAttachmentHost(this.app.metadataCache, this.app.vault);
		const sourceImageCount = snapshot.imageReferences.length;

		// Create selection function for time-based image selection
		const selectImages = <TImageFile>(
			resolved: Array<{ reference: ParsedVisionImageReference; handle: VisionFileHandle<TImageFile> }>,
		): Array<{ reference: ParsedVisionImageReference; handle: VisionFileHandle<TImageFile> }> => {
			// Extract screenshot offsets from timeline
			const timelineOffsets = extractScreenshotOffsets(snapshot.originalContent);

			// Map resolved images to their timeline offsets
			const imagePaths = resolved.map((img) => img.handle.vaultPath);
			const imagesWithOffsets = mapImagesToTimeline(imagePaths, timelineOffsets);

			// Select up to maxImages using time-based strategy
			const selection = selectImagesByTimeline(imagesWithOffsets, maxImages);

			// Return selected images in their original order, skipping any unexpected undefined entries
			const selected: Array<{ reference: ParsedVisionImageReference; handle: VisionFileHandle<TImageFile> }> = [];
			for (const item of selection.selected) {
				const resolvedItem = resolved[item.originalIndex];
				if (resolvedItem) {
					selected.push(resolvedItem);
				}
			}
			return selected;
		};

		const collected = await collectVisionImages({
			noteFile: target,
			notePath: snapshot.filePath,
			markdownSnapshot: snapshot.originalContent,
			maxImages,
			selectImages,
		}, host);
		if (collected.images.length === 0) {
			throw new Error('没有找到可发送的本地课堂图片。');
		}
		return {
			...snapshot,
			imageReferences: collected.references,
			resolvedImages: collected.images,
			attachmentSnapshots: collected.attachmentSnapshots,
			sourceImageCount,
		};
	}

	async generate(
		snapshot: AiGenerationSnapshot,
		providerId = this.providerRegistry.getActiveTextProviderId(),
	): Promise<AiPreviewData> {
		await this.assertSnapshotCurrent(snapshot);
		const provider = this.providerRegistry.getTextProvider(providerId);
		const timelineContext = buildTimelineContext(snapshot.originalContent);
		const outcome = await generateStructuredMarkdown(provider, snapshot.transcript, timelineContext);
		return {
			filePath: snapshot.filePath,
			generatedMarkdown: outcome.markdown,
			originalTranscriptSection: snapshot.originalTranscriptSection,
			originalContent: snapshot.originalContent,
			initialMtime: snapshot.initialMtime,
			initialSize: snapshot.initialSize,
			replacesExistingResult: snapshot.replacesExistingResult,
			isComplete: outcome.isComplete,
			incompleteReason: outcome.incompleteReason,
			providerId,
			providerName: provider.displayName,
			attempts: outcome.attempts,
			usesVision: false,
			attachmentSnapshots: [],
			diagnostics: outcome.diagnostics,
		};
	}

	async generateVision(
		snapshot: VisionGenerationSnapshot,
		providerId: VisionProviderId,
		signal?: AbortSignal,
	): Promise<AiPreviewData> {
		try {
			await this.assertSnapshotCurrent(snapshot);
			await this.assertAttachmentsCurrent(snapshot.attachmentSnapshots, 'request');
			const provider = this.providerRegistry.getVisionProviderForConfirmedRetry(providerId);
			const repairProvider = this.providerRegistry.getActiveTextProvider();
			const timelineContext = buildTimelineContext(snapshot.originalContent);
			const outcome = await generateVisionStructuredMarkdown(
				provider,
				repairProvider,
				snapshot.transcript,
				snapshot.resolvedImages,
				signal,
				timelineContext,
				snapshot.sourceImageCount,
			);
			return {
				filePath: snapshot.filePath,
				generatedMarkdown: outcome.markdown,
				originalTranscriptSection: snapshot.originalTranscriptSection,
				originalContent: snapshot.originalContent,
				initialMtime: snapshot.initialMtime,
				initialSize: snapshot.initialSize,
				replacesExistingResult: snapshot.replacesExistingResult,
				isComplete: outcome.isComplete,
				incompleteReason: outcome.incompleteReason,
				providerId,
				providerName: provider.displayName,
				attempts: outcome.attempts,
				usesVision: true,
				attachmentSnapshots: snapshot.attachmentSnapshots.map((item) => ({ ...item })),
				diagnostics: outcome.diagnostics,
			};
		} finally {
			this.disposeVisionSnapshot(snapshot);
		}
	}

	async write(preview: AiPreviewData): Promise<void> {
		assertAiOutputWritable({
			markdown: preview.generatedMarkdown,
			isComplete: preview.isComplete,
			incompleteReason: preview.incompleteReason,
			attempts: preview.attempts,
			finishReason: preview.diagnostics?.finishReason ?? null,
		});
		if (preview.usesVision && preview.attachmentSnapshots) {
			await this.assertAttachmentsCurrent(preview.attachmentSnapshots, 'write');
		}
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile || activeFile.path !== preview.filePath) {
			throw new Error('当前笔记已经切换，已中止写入。');
		}
		const target = this.app.vault.getAbstractFileByPath(preview.filePath);
		if (!(target instanceof TFile)) {
			assertTargetPath(preview.filePath, null);
			return;
		}
		assertTargetPath(preview.filePath, target.path);

		let writtenContent: string;
		if (requireApiVersion('1.1.0')) {
			writtenContent = await processConflictSafeWrite(
				(transform) => this.app.vault.process(target, (latestContent) => {
					this.assertTargetStillCurrent(preview.filePath, target);
					return transform(latestContent);
				}),
				preview.originalContent,
				preview.generatedMarkdown,
			);
		} else {
			writtenContent = await freshReadConflictSafeWrite(
				async () => {
					this.assertTargetStillCurrent(preview.filePath, target);
					const latestContent = await this.app.vault.read(target);
					this.assertTargetStillCurrent(preview.filePath, target);
					return latestContent;
				},
				async (updatedContent) => {
					this.assertTargetStillCurrent(preview.filePath, target);
					await this.app.vault.modify(target, updatedContent);
				},
				preview.originalContent,
				preview.generatedMarkdown,
			);
		}
		const writtenSection = extractTranscriptSection(writtenContent);
		if (!writtenSection || writtenSection.protectedText !== preview.originalTranscriptSection) {
			throw new Error('写入后的原始文字稿保护校验失败。');
		}
	}

	disposeVisionSnapshot(snapshot: VisionGenerationSnapshot): void {
		for (const image of snapshot.resolvedImages) {
			image.dataUrl = '';
		}
		snapshot.resolvedImages.splice(0, snapshot.resolvedImages.length);
		snapshot.attachmentSnapshots.splice(0, snapshot.attachmentSnapshots.length);
		snapshot.imageReferences.splice(0, snapshot.imageReferences.length);
	}

	private async assertSnapshotCurrent(snapshot: AiGenerationSnapshot): Promise<void> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile || activeFile.path !== snapshot.filePath) {
			throw new Error('当前笔记已经切换，已中止 AI 请求。');
		}
		const target = this.app.vault.getAbstractFileByPath(snapshot.filePath);
		if (!(target instanceof TFile)) {
			throw new Error('目标笔记已不存在，已中止 AI 请求。');
		}
		const currentContent = await this.app.vault.read(target);
		assertTargetPath(snapshot.filePath, target.path);
		if (currentContent !== snapshot.originalContent) {
			throw new Error('笔记在 AI 整理期间已发生变化，已中止 AI 请求。');
		}
	}

	private assertTargetStillCurrent(expectedPath: string, target: TFile): void {
		assertTargetPath(expectedPath, target.path);
		assertTargetPath(expectedPath, this.app.workspace.getActiveFile()?.path ?? null);
	}

	private async assertAttachmentsCurrent(
		snapshots: VisionAttachmentSnapshot[],
		phase: 'request' | 'write',
	): Promise<void> {
		const host = new ObsidianVisionAttachmentHost(this.app.metadataCache, this.app.vault);
		const result = await verifyVisionAttachmentSnapshots(snapshots, host);
		if (!result.valid) {
			throw new VisionWorkflowConflictError(
				result.conflicts.map((conflict) => conflict.vaultPath),
				phase,
			);
		}
	}
}

export function isVisionWorkflowConflictError(error: unknown): error is VisionWorkflowConflictError {
	return Boolean(
		error
		&& typeof error === 'object'
		&& 'code' in error
		&& error.code === 'vision-workflow-conflict',
	);
}
