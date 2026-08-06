import { App, requireApiVersion, TFile } from 'obsidian';

import {
	extractTranscriptSection,
	hasAiRegion,
} from './ai-note';
import {
	assertAiOutputWritable,
	generateStructuredMarkdown,
} from './ai-generation';
import type { TextProviderId } from './provider-types';
import type { ProviderRegistry } from './providers/registry';
import {
	assertTargetPath,
	freshReadConflictSafeWrite,
	processConflictSafeWrite,
} from './note-conflict';

export interface AiGenerationSnapshot {
	filePath: string;
	transcript: string;
	originalTranscriptSection: string;
	originalContent: string;
	initialMtime: number;
	initialSize: number;
	replacesExistingResult: boolean;
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
		};
	}

	async generate(
		snapshot: AiGenerationSnapshot,
		providerId = this.providerRegistry.getActiveTextProviderId(),
	): Promise<AiPreviewData> {
		await this.assertSnapshotCurrent(snapshot);
		const provider = this.providerRegistry.getTextProvider(providerId);
		const outcome = await generateStructuredMarkdown(provider, snapshot.transcript);
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
		};
	}

	async write(preview: AiPreviewData): Promise<void> {
		assertAiOutputWritable({
			markdown: preview.generatedMarkdown,
			isComplete: preview.isComplete,
			incompleteReason: preview.incompleteReason,
			attempts: preview.attempts,
			finishReason: null,
		});
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
}
