import { App, Modal, Setting } from 'obsidian';

import type { TextProviderId, VisionProviderId } from './provider-types';

export interface VisionConfirmationSummary {
	imageCount: number;
	totalBytes: number;
	vaultPaths: string[];
	visionProviderId: VisionProviderId;
	visionProviderName: string;
	model: string;
	textProviderId: TextProviderId;
	isRetry: boolean;
}

export class VisionConfirmationModal extends Modal {
	private confirmed = false;

	constructor(
		app: App,
		private readonly summary: VisionConfirmationSummary,
		private readonly onConfirm: () => void,
		private readonly onClosed: (confirmed: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.addClass('lecture-workflow-vision-confirmation');
		this.contentEl.createEl('h2', { text: '确认发送课堂图片' });
		this.contentEl.createEl('p', {
			text: `检测到 ${this.summary.imageCount} 张图片，原始总大小 ${formatByteSize(this.summary.totalBytes)}。`,
		});
		this.contentEl.createEl('p', {
			text: `本次视觉 Provider：${this.summary.visionProviderName}；模型：${this.summary.model}。`,
		});
		if (this.summary.textProviderId === 'deepseek' && this.summary.visionProviderId === 'qwen') {
			this.contentEl.createEl('p', {
				text: '课堂图片将由 Qwen-VL 进行视觉理解，视觉结果将作为辅助上下文提供给文本模型；完整文字稿由文本模型负责最终结构化整理。',
				cls: 'lecture-workflow-ai-replace-warning',
			});
		}
		if (this.summary.isRetry) {
			this.contentEl.createEl('p', {
				text: '这是一次新的视觉请求，可能再次产生调用费用。',
				cls: 'lecture-workflow-ai-replace-warning',
			});
		}
		this.contentEl.createEl('p', {
			text: '图片与文字稿将发送给所选第三方模型服务商，可能产生额外 Token 或调用费用。插件不会把图片上传到公共图床。',
		});
		const list = this.contentEl.createEl('ul');
		for (const path of this.summary.vaultPaths) {
			list.createEl('li', { text: path });
		}

		const actions = new Setting(this.contentEl);
		actions.settingEl.addClass('lecture-workflow-actions');
		actions
			.addButton((button) => button.setButtonText('取消').onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText('发送并整理')
					.setCta()
					.onClick(() => {
						if (this.confirmed) {
							return;
						}
						this.confirmed = true;
						this.close();
						this.onConfirm();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		this.onClosed(this.confirmed);
	}
}

export class VisionDisabledChoiceModal extends Modal {
	private selectedTextOnly = false;

	constructor(
		app: App,
		private readonly imageCount: number,
		private readonly onTextOnly: () => void,
		private readonly onClosed: (selectedTextOnly: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.addClass('lecture-workflow-vision-choice');
		this.contentEl.createEl('h2', { text: '检测到课堂图片' });
		this.contentEl.createEl('p', {
			text: `检测到 ${this.imageCount} 张本地图片，但“图片参与 AI 整理”尚未启用。`,
		});
		this.contentEl.createEl('p', {
			text: '选择“仅整理文字”将明确忽略本次图片，并继续原有纯文字流程；插件不会修改设置。',
		});
		const actions = new Setting(this.contentEl);
		actions.settingEl.addClass('lecture-workflow-actions');
		actions
			.addButton((button) => button.setButtonText('取消').onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText('仅整理文字')
					.setCta()
					.onClick(() => {
						if (this.selectedTextOnly) {
							return;
						}
						this.selectedTextOnly = true;
						this.close();
						this.onTextOnly();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		this.onClosed(this.selectedTextOnly);
	}
}

export function formatByteSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KiB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}
