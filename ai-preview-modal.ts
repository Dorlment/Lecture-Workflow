import { App, Modal, Notice, Setting } from 'obsidian';

import type { AiPreviewData } from './ai-workflow';
import { PreviewWriteSession } from './ai-note';

type ConfirmHandler = (preview: AiPreviewData) => Promise<boolean>;

export class AiPreviewModal extends Modal {
	private readonly writeSession = new PreviewWriteSession();
	private writeButtonEl: HTMLButtonElement | null = null;
	private regenerateRequested = false;

	constructor(
		app: App,
		private readonly preview: AiPreviewData,
		private readonly onConfirm: ConfirmHandler,
		private readonly onRegenerate: () => void,
		private readonly onClosed: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.addClass('lecture-workflow-ai-preview');
		this.contentEl.createEl('h2', { text: 'AI 结构化笔记预览' });
		if (this.preview.replacesExistingResult) {
			this.contentEl.createEl('p', {
				text: '当前笔记已有 AI 结果；确认后将替换旧结果。',
				cls: 'lecture-workflow-ai-replace-warning',
			});
		}
		if (!this.preview.isComplete) {
			this.contentEl.createEl('p', {
				text: `结果不完整，已禁止写入：${this.preview.incompleteReason ?? '格式校验失败。'} 可复制当前结果或重新生成。`,
				cls: 'lecture-workflow-ai-incomplete-warning',
			});
		}
		const previewEl = this.contentEl.createEl('textarea', {
			cls: 'lecture-workflow-ai-preview-content',
		});
		previewEl.value = this.preview.generatedMarkdown;
		previewEl.readOnly = true;

		const actions = new Setting(this.contentEl);
		actions.settingEl.addClass('lecture-workflow-actions');
		actions
			.addButton((button) =>
				button.setButtonText('取消').onClick(() => {
					this.writeSession.cancel();
					this.close();
				}),
			)
			.addButton((button) =>
				button.setButtonText('复制结果').onClick(async () => {
					try {
						await navigator.clipboard.writeText(this.preview.generatedMarkdown);
						new Notice('AI 结果已复制。');
					} catch {
						new Notice('复制失败，请手动选择预览内容复制。');
					}
				}),
			)
			.addButton((button) =>
				button.setButtonText('重新生成').onClick(() => {
					this.regenerateRequested = true;
					this.close();
				}),
			)
			.addButton((button) => {
				this.writeButtonEl = button.buttonEl;
				button
					.setButtonText('写入当前笔记')
					.setCta()
					.onClick(() => this.confirmWrite());
				button.buttonEl.disabled = !this.preview.isComplete;
			});
	}

	onClose(): void {
		this.writeSession.cancel();
		this.writeButtonEl = null;
		this.contentEl.empty();
		this.onClosed();
		if (this.regenerateRequested) {
			this.onRegenerate();
		}
	}

	private async confirmWrite(): Promise<void> {
		if (this.writeButtonEl) {
			this.writeButtonEl.disabled = true;
		}
		let succeeded: boolean | null = false;
		try {
			succeeded = await this.writeSession.confirm(() => this.onConfirm(this.preview));
		} catch (error) {
			console.error('Lecture Workflow: unexpected AI preview write failure', error);
			new Notice('写入 AI 结果失败，预览内容已保留。');
		}
		if (succeeded === null) {
			return;
		}
		if (succeeded) {
			this.close();
			return;
		}
		if (this.writeButtonEl) {
			this.writeButtonEl.disabled = false;
		}
	}
}
