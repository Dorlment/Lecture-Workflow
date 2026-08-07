import {
	App,
	Modal,
	Notice,
	Setting,
} from 'obsidian';

import { SubmissionGuard } from './lecture-note';
import { screenshotPasteInstruction } from './screenshot-core';
import type { ScreenshotDesktopPlatform } from './screenshot-core';
import {
	createBrowserScreenshotImageEnvironment,
	createBrowserScreenshotPreviewEnvironment,
	extractPastedImageFiles,
	ScreenshotImageProcessor,
	ScreenshotPasteSession,
} from './screenshot-image';
import {
	isScreenshotWorkflowError,
	ScreenshotWorkflowError,
} from './screenshot-types';
import type { ProcessedScreenshot } from './screenshot-types';

type SaveScreenshotHandler = (image: ProcessedScreenshot) => Promise<boolean>;

export class ScreenshotPasteModal extends Modal {
	private readonly session = new ScreenshotPasteSession(
		new ScreenshotImageProcessor(createBrowserScreenshotImageEnvironment()),
		createBrowserScreenshotPreviewEnvironment(),
	);
	private readonly saveGuard = new SubmissionGuard();
	private saveButtonEl: HTMLButtonElement | null = null;
	private pasteAreaEl: HTMLElement | null = null;
	private previewImageEl: HTMLImageElement | null = null;
	private statusEl: HTMLElement | null = null;
	private closed = false;
	private readonly pasteHandler = (event: ClipboardEvent): void => {
		void this.handlePaste(event);
	};

	constructor(
		app: App,
		private readonly platform: ScreenshotDesktopPlatform,
		private readonly onSave: SaveScreenshotHandler,
		private readonly onClosed: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.closed = false;
		this.contentEl.addClass('lecture-workflow-screenshot-modal');
		this.contentEl.createEl('h2', { text: '粘贴课堂截图' });
		this.contentEl.createEl('p', {
			cls: 'lecture-workflow-screenshot-instruction',
			text: screenshotPasteInstruction(this.platform),
		});

		this.pasteAreaEl = this.contentEl.createDiv({
			cls: 'lecture-workflow-screenshot-paste-area',
			text: '等待粘贴截图…',
			attr: {
				role: 'region',
				tabindex: '0',
				'aria-label': '粘贴课堂截图区域',
			},
		});
		const preview = this.contentEl.createDiv({
			cls: 'lecture-workflow-screenshot-preview is-hidden',
		});
		this.previewImageEl = preview.createEl('img', {
			attr: { alt: '课堂截图预览' },
		});
		this.statusEl = this.contentEl.createEl('p', {
			cls: 'lecture-workflow-screenshot-status',
			text: '尚未收到图片。',
		});

		const actions = new Setting(this.contentEl);
		actions.settingEl.addClass('lecture-workflow-screenshot-actions');
		actions
			.addButton((button) => button
				.setButtonText('取消')
				.onClick(() => this.close()))
			.addButton((button) => {
				this.saveButtonEl = button.buttonEl;
				button
					.setButtonText('保存并插入')
					.setCta()
					.setDisabled(true)
					.onClick(() => this.save());
			});

		this.contentEl.addEventListener('paste', this.pasteHandler);
		this.pasteAreaEl.focus();
	}

	onClose(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.contentEl.removeEventListener('paste', this.pasteHandler);
		this.session.dispose();
		this.contentEl.empty();
		this.saveButtonEl = null;
		this.pasteAreaEl = null;
		this.previewImageEl = null;
		this.statusEl = null;
		this.onClosed();
	}

	private async handlePaste(event: ClipboardEvent): Promise<void> {
		const clipboardData = event.clipboardData;
		const images = clipboardData
			? extractPastedImageFiles(Array.from(clipboardData.items))
			: [];
		if (images.length === 0) {
			new Notice(new ScreenshotWorkflowError('image-required').message);
			return;
		}
		if (images.length > 1) {
			new Notice(new ScreenshotWorkflowError('multiple-images').message);
			return;
		}

		event.preventDefault();
		this.clearPreviewElement();
		this.setSaveEnabled(false);
		this.setStatus('正在处理粘贴的图片…');
		try {
			const result = await this.session.accept(images);
			if (this.closed || result.status === 'stale') {
				return;
			}
			if (result.status !== 'ready') {
				throw new ScreenshotWorkflowError(result.status);
			}
			if (this.previewImageEl) {
				this.previewImageEl.src = result.previewUrl;
				this.previewImageEl.parentElement?.removeClass('is-hidden');
			}
			this.setStatus(
				`已接收 PNG：${result.image.width}×${result.image.height}，`
				+ `${formatByteSize(result.image.byteLength)}。`,
			);
			this.setSaveEnabled(true);
		} catch (error) {
			if (this.closed) {
				return;
			}
			const safeError = isScreenshotWorkflowError(error)
				? error
				: new ScreenshotWorkflowError('unknown');
			this.setStatus(safeError.message);
			new Notice(safeError.message);
			this.setSaveEnabled(Boolean(this.session.image));
		}
	}

	private async save(): Promise<void> {
		const image = this.session.image;
		if (!image || !this.saveGuard.tryStart()) {
			return;
		}
		this.setSaveEnabled(false);
		let succeeded = false;
		try {
			succeeded = await this.onSave(image);
		} catch {
			const safeError = new ScreenshotWorkflowError('unknown');
			this.setStatus(safeError.message);
			new Notice(safeError.message);
		} finally {
			this.saveGuard.finish();
		}
		if (succeeded) {
			this.close();
			return;
		}
		this.setSaveEnabled(Boolean(this.session.image));
	}

	private clearPreviewElement(): void {
		if (!this.previewImageEl) {
			return;
		}
		this.previewImageEl.removeAttribute('src');
		this.previewImageEl.parentElement?.addClass('is-hidden');
	}

	private setSaveEnabled(enabled: boolean): void {
		if (this.saveButtonEl) {
			this.saveButtonEl.disabled = !enabled;
		}
	}

	private setStatus(message: string): void {
		this.statusEl?.setText(message);
	}
}

function formatByteSize(byteLength: number): string {
	if (byteLength >= 1024 * 1024) {
		return `${(byteLength / (1024 * 1024)).toFixed(2)} MiB`;
	}
	return `${Math.max(1, Math.ceil(byteLength / 1024))} KiB`;
}
