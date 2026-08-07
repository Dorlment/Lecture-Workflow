import { Menu, Notice, Plugin } from 'obsidian';

import { AiPreviewModal } from './ai-preview-modal';
import { AiRetryModal } from './ai-retry-modal';
import {
	buildRetryOptions,
	buildVisionRetryOptions,
	describeProviderFailure,
} from './ai-retry';
import { AiWorkflowGate } from './ai-note';
import type {
	AiGenerationSnapshot,
	AiPreviewData,
	VisionGenerationSnapshot,
} from './ai-workflow';
import {
	AiWorkflowService,
	isVisionWorkflowConflictError,
	VISION_WORKFLOW_CONFLICT_MESSAGE,
} from './ai-workflow';
import { CreateLectureNoteModal } from './modal';
import {
	isNoteConflictError,
	isNoteLatestReadError,
	NOTE_CONFLICT_MESSAGE,
	NOTE_LATEST_READ_FAILED_MESSAGE,
} from './note-conflict';
import type { TextProviderId, VisionProviderId } from './provider-types';
import { ProviderError } from './provider-types';
import { ObsidianHttpClient } from './providers/obsidian-http';
import { ProviderRegistry } from './providers/registry';
import { LectureNoteService } from './service';
import {
	DEFAULT_SETTINGS,
	LectureWorkflowSettingTab,
} from './settings';
import { normalizeSettings } from './settings-data';
import type {
	LectureNoteInput,
	LectureWorkflowSettings,
} from './types';
import {
	VisionConfirmationModal,
	VisionDisabledChoiceModal,
} from './vision-confirmation-modal';
import {
	decideVisionWorkflowRoute,
	shouldAcceptVisionResult,
} from './vision-workflow-routing';

export default class LectureWorkflowPlugin extends Plugin {
	settings: LectureWorkflowSettings = DEFAULT_SETTINGS;
	private readonly openModals = new Set<{ close(): void }>();
	private readonly aiWorkflowGate = new AiWorkflowGate();
	private activeVisionAbortController: AbortController | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addCommand({
			id: 'create-lecture-note',
			name: '创建课堂笔记',
			callback: () => this.openCreateLectureNoteModal(),
		});

		this.addCommand({
			id: 'ai-structure-current-lecture-note',
			name: 'AI 整理当前课堂笔记',
			callback: () => this.runAiWorkflow(),
		});

		this.addRibbonIcon('notebook-pen', 'Lecture Workflow', (event) => {
			this.showRibbonMenu(event);
		});

		this.addSettingTab(new LectureWorkflowSettingTab(this.app, this));
	}

	onunload(): void {
		this.activeVisionAbortController?.abort();
		this.activeVisionAbortController = null;
		for (const modal of this.openModals) {
			modal.close();
		}
		this.openModals.clear();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async testTextProvider(id: TextProviderId): Promise<void> {
		try {
			const registry = this.createProviderRegistry();
			await registry.getTextProvider(id).testConnection();
			new Notice('连接测试成功。');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`连接测试失败：${message}`);
		}
	}

	private async loadSettings(): Promise<void> {
		const savedSettings = (await this.loadData()) as Partial<LectureWorkflowSettings> | null;
		this.settings = normalizeSettings(savedSettings);
	}

	private openCreateLectureNoteModal(): void {
		let modal: CreateLectureNoteModal;
		modal = new CreateLectureNoteModal(
			this.app,
			async (input) => this.createLectureNote(input),
			() => this.openModals.delete(modal),
		);
		this.openModals.add(modal);
		modal.open();
	}

	private async createLectureNote(input: LectureNoteInput): Promise<boolean> {
		const service = new LectureNoteService(this.app);
		let file;
		try {
			file = await service.create(input, this.settings.notesFolder);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`创建课堂笔记失败：${message}`);
			return false;
		}

		try {
			await service.open(file);
		} catch (error) {
			console.error('Lecture Workflow: failed to open created note', error);
			new Notice(`笔记已创建，但无法自动打开：${file.path}`);
			return true;
		}

		new Notice(`课堂笔记已创建：${file.path}`);
		return true;
	}

	private createProviderRegistry(): ProviderRegistry {
		return new ProviderRegistry(this.settings, new ObsidianHttpClient());
	}

	private showRibbonMenu(event: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle('创建课堂笔记')
				.setIcon('file-plus-2')
				.onClick(() => this.openCreateLectureNoteModal()),
		);
		menu.addItem((item) =>
			item
				.setTitle('AI 整理当前笔记')
				.setIcon('wand-sparkles')
				.onClick(() => this.runAiWorkflow()),
		);
		menu.showAtMouseEvent(event);
	}

	private async runAiWorkflow(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== 'md') {
			new Notice('请先打开一篇 Markdown 课堂笔记。');
			return;
		}
		if (!this.aiWorkflowGate.beginGeneration()) {
			new Notice('AI 整理正在进行，请勿重复提交。');
			return;
		}

		const registry = this.createProviderRegistry();
		const service = new AiWorkflowService(this.app, registry);
		let snapshot: AiGenerationSnapshot;
		try {
			snapshot = await service.prepare(file);
		} catch (error) {
			this.aiWorkflowGate.reset();
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`AI 整理失败：${message}`);
			return;
		}
		const route = decideVisionWorkflowRoute(
			snapshot.imageReferences.length,
			this.settings.enableVisionInput,
		);
		if (route === 'text-only') {
			await this.performGeneration(
				snapshot,
				service,
				registry,
				registry.getActiveTextProviderId(),
			);
			return;
		}
		if (route === 'offer-text-only') {
			this.openVisionDisabledChoice(snapshot, service, registry);
			return;
		}
		await this.prepareVisionConfirmation(
			snapshot,
			service,
			registry,
			this.settings.visionProvider,
			false,
		);
	}

	private openVisionDisabledChoice(
		snapshot: AiGenerationSnapshot,
		service: AiWorkflowService,
		registry: ProviderRegistry,
	): void {
		let modal: VisionDisabledChoiceModal;
		modal = new VisionDisabledChoiceModal(
			this.app,
			snapshot.imageReferences.length,
			() => {
				void this.performGeneration(
					snapshot,
					service,
					registry,
					registry.getActiveTextProviderId(),
				);
			},
			(selectedTextOnly) => {
				this.openModals.delete(modal);
				if (!selectedTextOnly) {
					this.aiWorkflowGate.reset();
				}
			},
		);
		this.openModals.add(modal);
		modal.open();
	}

	private async prepareVisionConfirmation(
		snapshot: AiGenerationSnapshot,
		service: AiWorkflowService,
		registry: ProviderRegistry,
		providerId: VisionProviderId,
		isRetry: boolean,
	): Promise<void> {
		let prepared: VisionGenerationSnapshot | null = null;
		try {
			const provider = registry.getVisionProviderForConfirmedRetry(providerId);
			const validation = provider.validateVision();
			if (validation.length > 0) {
				throw new ProviderError(validation.join(' '), 'configuration');
			}
			prepared = await service.prepareVision(snapshot, this.settings.maxVisionImages);
			const summary = {
				imageCount: prepared.resolvedImages.length,
				totalBytes: prepared.resolvedImages.reduce((total, image) => total + image.byteLength, 0),
				vaultPaths: prepared.resolvedImages.map((image) => image.vaultPath),
				visionProviderId: providerId,
				visionProviderName: provider.displayName,
				model: providerId === 'qwen'
					? this.settings.qwen.visionModel
					: this.settings.customOpenAI.model,
				textProviderId: registry.getActiveTextProviderId(),
				isRetry,
			};
			this.openVisionConfirmation(summary, prepared, snapshot, service, registry, providerId);
		} catch (error) {
			if (prepared) {
				service.disposeVisionSnapshot(prepared);
			}
			this.aiWorkflowGate.reset();
			if (error instanceof ProviderError) {
				const failure = describeProviderFailure(
					providerId === 'qwen' ? 'Qwen-VL' : 'Custom Vision',
					error,
				);
				new Notice(`图片整理准备失败：${failure.message}`);
				return;
			}
			const message = error instanceof Error ? error.message : '未知错误。';
			new Notice(`图片整理准备失败：${message}`);
		}
	}

	private openVisionConfirmation(
		summary: ConstructorParameters<typeof VisionConfirmationModal>[1],
		prepared: VisionGenerationSnapshot,
		baseSnapshot: AiGenerationSnapshot,
		service: AiWorkflowService,
		registry: ProviderRegistry,
		providerId: VisionProviderId,
	): void {
		let modal: VisionConfirmationModal;
		modal = new VisionConfirmationModal(
			this.app,
			summary,
			() => {
				void this.performVisionGeneration(
					prepared,
					baseSnapshot,
					service,
					registry,
					providerId,
				);
			},
			(confirmed) => {
				this.openModals.delete(modal);
				if (!confirmed) {
					service.disposeVisionSnapshot(prepared);
					this.aiWorkflowGate.reset();
				}
			},
		);
		this.openModals.add(modal);
		modal.open();
	}

	private async startGenerationFromSnapshot(
		snapshot: AiGenerationSnapshot,
		service: AiWorkflowService,
		registry: ProviderRegistry,
		providerId: TextProviderId,
	): Promise<void> {
		if (!this.aiWorkflowGate.beginGeneration()) {
			new Notice('AI 整理正在进行，请勿重复提交。');
			return;
		}
		await this.performGeneration(snapshot, service, registry, providerId);
	}

	private async performGeneration(
		snapshot: AiGenerationSnapshot,
		service: AiWorkflowService,
		registry: ProviderRegistry,
		providerId: TextProviderId,
	): Promise<void> {
		const provider = registry.getTextProvider(providerId);
		new Notice(`正在使用 ${provider.displayName} 生成 AI 结构化笔记…`);
		try {
			const preview = await this.aiWorkflowGate.completeWithPreview(
				() => service.generate(snapshot, providerId),
			);
			if (!preview.isComplete) {
				new Notice('AI 结果不完整，已禁止写入；可在预览中复制或重新生成。');
			}
			this.openAiPreview(preview, snapshot, service, registry);
		} catch (error) {
			this.aiWorkflowGate.reset();
			this.handleGenerationFailure(error, snapshot, service, registry, providerId);
		}
	}

	private async performVisionGeneration(
		prepared: VisionGenerationSnapshot,
		baseSnapshot: AiGenerationSnapshot,
		service: AiWorkflowService,
		registry: ProviderRegistry,
		providerId: VisionProviderId,
	): Promise<void> {
		const controller = new AbortController();
		this.activeVisionAbortController = controller;
		try {
			const provider = registry.getVisionProviderForConfirmedRetry(providerId);
			new Notice(`正在使用 ${provider.displayName} 同时整理文字稿和课堂图片…`);
			const preview = await this.aiWorkflowGate.completeWithPreview(
				() => service.generateVision(prepared, providerId, controller.signal),
			);
			if (!shouldAcceptVisionResult(controller.signal)) {
				this.aiWorkflowGate.reset();
				return;
			}
			if (!preview.isComplete) {
				new Notice('视觉 AI 结果不完整，已禁止写入；可在预览中复制或重新生成。');
			}
			this.openAiPreview(preview, baseSnapshot, service, registry);
		} catch (error) {
			this.aiWorkflowGate.reset();
			if (!controller.signal.aborted) {
				this.handleVisionGenerationFailure(
					error,
					baseSnapshot,
					service,
					registry,
					providerId,
				);
			}
		} finally {
			service.disposeVisionSnapshot(prepared);
			if (this.activeVisionAbortController === controller) {
				this.activeVisionAbortController = null;
			}
		}
	}

	private handleVisionGenerationFailure(
		error: unknown,
		snapshot: AiGenerationSnapshot,
		service: AiWorkflowService,
		registry: ProviderRegistry,
		providerId: VisionProviderId,
	): void {
		if (isVisionWorkflowConflictError(error)) {
			new Notice(error.message);
			return;
		}
		if (!(error instanceof ProviderError)) {
			const message = error instanceof Error ? error.message : '未知错误。';
			new Notice(`视觉 AI 整理失败：${message}`);
			return;
		}
		const providerName = providerId === 'qwen' ? 'Qwen-VL' : 'Custom Vision';
		const failure = describeProviderFailure(providerName, error);
		new Notice(`视觉 AI 整理失败：${failure.message}`);
		if (!failure.isRetryableConnectionFailure) {
			return;
		}
		let qwenConfigured = false;
		try {
			qwenConfigured = registry
				.getVisionProviderForConfirmedRetry('qwen')
				.validateVision()
				.length === 0;
		} catch {
			qwenConfigured = false;
		}
		this.openVisionRetryModal(
			failure.message,
			buildVisionRetryOptions(providerId, qwenConfigured),
			snapshot,
			service,
			registry,
		);
	}

	private openVisionRetryModal(
		failureMessage: string,
		options: ReturnType<typeof buildVisionRetryOptions>,
		snapshot: AiGenerationSnapshot,
		service: AiWorkflowService,
		registry: ProviderRegistry,
	): void {
		let modal: AiRetryModal;
		modal = new AiRetryModal(
			this.app,
			failureMessage,
			options,
			(providerId) => {
				if (providerId === 'qwen' || providerId === 'custom') {
					void this.startVisionRetry(snapshot, service, registry, providerId);
				}
			},
			() => this.openModals.delete(modal),
		);
		this.openModals.add(modal);
		modal.open();
	}

	private async startVisionRetry(
		snapshot: AiGenerationSnapshot,
		service: AiWorkflowService,
		registry: ProviderRegistry,
		providerId: VisionProviderId,
	): Promise<void> {
		if (!this.aiWorkflowGate.beginGeneration()) {
			new Notice('AI 整理正在进行，请勿重复提交。');
			return;
		}
		await this.prepareVisionConfirmation(
			snapshot,
			service,
			registry,
			providerId,
			true,
		);
	}

	private handleGenerationFailure(
		error: unknown,
		snapshot: AiGenerationSnapshot,
		service: AiWorkflowService,
		registry: ProviderRegistry,
		providerId: TextProviderId,
	): void {
		if (!(error instanceof ProviderError)) {
			const message = error instanceof Error ? error.message : '未知错误。';
			new Notice(`AI 整理失败：${message}`);
			return;
		}
		const providerName = registry.getTextProvider(providerId).displayName;
		const failure = describeProviderFailure(providerName, error);
		new Notice(`AI 整理失败：${failure.message}`);
		if (providerId === 'deepseek' && failure.isRetryableConnectionFailure) {
			const qwenConfigured = registry.getTextProvider('qwen').validate().length === 0;
			this.openRetryModal(
				failure.message,
				buildRetryOptions(providerId, qwenConfigured),
				snapshot,
				service,
				registry,
			);
		}
	}

	private openRetryModal(
		failureMessage: string,
		options: ReturnType<typeof buildRetryOptions>,
		snapshot: AiGenerationSnapshot,
		service: AiWorkflowService,
		registry: ProviderRegistry,
	): void {
		let modal: AiRetryModal;
		modal = new AiRetryModal(
			this.app,
			failureMessage,
			options,
			(providerId) => {
				void this.startGenerationFromSnapshot(snapshot, service, registry, providerId);
			},
			() => this.openModals.delete(modal),
		);
		this.openModals.add(modal);
		modal.open();
	}

	private openAiPreview(
		preview: AiPreviewData,
		snapshot: AiGenerationSnapshot,
		service: AiWorkflowService,
		registry: ProviderRegistry,
	): void {
		let modal: AiPreviewModal;
		modal = new AiPreviewModal(
			this.app,
			preview,
			async (data) => {
				try {
					await service.write(data);
					new Notice('AI 结构化笔记已写入。');
					return true;
				} catch (error) {
					if (isVisionWorkflowConflictError(error)) {
						new Notice(VISION_WORKFLOW_CONFLICT_MESSAGE);
						return false;
					}
					if (isNoteConflictError(error)) {
						new Notice(data.usesVision
							? VISION_WORKFLOW_CONFLICT_MESSAGE
							: NOTE_CONFLICT_MESSAGE);
						return false;
					}
					if (isNoteLatestReadError(error)) {
						new Notice(data.usesVision
							? VISION_WORKFLOW_CONFLICT_MESSAGE
							: NOTE_LATEST_READ_FAILED_MESSAGE);
						return false;
					}
					const message = error instanceof Error ? error.message : String(error);
					new Notice(`写入 AI 结果失败：${message}`);
					return false;
				}
			},
			() => {
				if (preview.usesVision
					&& (preview.providerId === 'qwen' || preview.providerId === 'custom')) {
					void this.startVisionRetry(
						snapshot,
						service,
						registry,
						preview.providerId,
					);
				} else {
					void this.startGenerationFromSnapshot(
						snapshot,
						service,
						registry,
						preview.providerId,
					);
				}
			},
			() => {
				this.openModals.delete(modal);
				this.aiWorkflowGate.reset();
			},
		);
		this.openModals.add(modal);
		modal.open();
	}
}
