import { Menu, Notice, Plugin } from 'obsidian';

import { AiPreviewModal } from './ai-preview-modal';
import { AiRetryModal } from './ai-retry-modal';
import {
	buildRetryOptions,
	describeProviderFailure,
} from './ai-retry';
import { AiWorkflowGate } from './ai-note';
import type {
	AiGenerationSnapshot,
	AiPreviewData,
} from './ai-workflow';
import { AiWorkflowService } from './ai-workflow';
import { CreateLectureNoteModal } from './modal';
import {
	isNoteConflictError,
	isNoteLatestReadError,
	NOTE_CONFLICT_MESSAGE,
	NOTE_LATEST_READ_FAILED_MESSAGE,
} from './note-conflict';
import type { TextProviderId } from './provider-types';
import { ProviderError } from './provider-types';
import { ObsidianHttpClient } from './providers/obsidian-http';
import { ProviderRegistry } from './providers/registry';
import { LectureNoteService } from './service';
import {
	DEFAULT_SETTINGS,
	LectureWorkflowSettingTab,
} from './settings';
import type {
	LectureNoteInput,
	LectureWorkflowSettings,
} from './types';

export default class LectureWorkflowPlugin extends Plugin {
	settings: LectureWorkflowSettings = DEFAULT_SETTINGS;
	private readonly openModals = new Set<{ close(): void }>();
	private readonly aiWorkflowGate = new AiWorkflowGate();

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
		this.settings = {
			...DEFAULT_SETTINGS,
			...(savedSettings ?? {}),
			deepseek: { ...DEFAULT_SETTINGS.deepseek, ...savedSettings?.deepseek },
			qwen: { ...DEFAULT_SETTINGS.qwen, ...savedSettings?.qwen },
			customOpenAI: { ...DEFAULT_SETTINGS.customOpenAI, ...savedSettings?.customOpenAI },
		};
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
		await this.performGeneration(
			snapshot,
			service,
			registry,
			registry.getActiveTextProviderId(),
		);
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
					if (isNoteConflictError(error)) {
						new Notice(NOTE_CONFLICT_MESSAGE);
						return false;
					}
					if (isNoteLatestReadError(error)) {
						new Notice(NOTE_LATEST_READ_FAILED_MESSAGE);
						return false;
					}
					const message = error instanceof Error ? error.message : String(error);
					new Notice(`写入 AI 结果失败：${message}`);
					return false;
				}
			},
			() => {
				void this.startGenerationFromSnapshot(
					snapshot,
					service,
					registry,
					preview.providerId,
				);
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
