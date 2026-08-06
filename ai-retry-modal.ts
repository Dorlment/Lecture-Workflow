import { App, Modal, Setting } from 'obsidian';

import type { AiRetryOption } from './ai-retry';
import type { TextProviderId } from './provider-types';

export class AiRetryModal extends Modal {
	constructor(
		app: App,
		private readonly failureMessage: string,
		private readonly options: AiRetryOption[],
		private readonly onSelect: (providerId: TextProviderId) => void,
		private readonly onClosed: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.addClass('lecture-workflow-ai-retry');
		this.contentEl.createEl('h2', { text: 'AI 整理请求失败' });
		this.contentEl.createEl('p', { text: this.failureMessage });
		this.contentEl.createEl('p', {
			text: '插件不会自动重试或切换服务商；点击重试将由你主动发送一个新请求。',
		});

		const actions = new Setting(this.contentEl);
		actions.settingEl.addClass('lecture-workflow-actions');
		for (const option of this.options) {
				actions.addButton((button) =>
				button
					.setButtonText(option.label)
					.onClick(() => {
						this.close();
						this.onSelect(option.providerId);
					}),
			);
		}
		actions.addButton((button) => button.setButtonText('取消').onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
		this.onClosed();
	}
}
