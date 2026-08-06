import { App, Modal, Notice, Setting } from 'obsidian';

import { SubmissionGuard } from './lecture-note';
import type { LectureNoteInput } from './types';

type SubmitHandler = (input: LectureNoteInput) => Promise<boolean>;

export class CreateLectureNoteModal extends Modal {
	private course = '';
	private topic = '';
	private transcript = '';
	private readonly onSubmit: SubmitHandler;
	private readonly onClosed: () => void;
	private readonly submissionGuard = new SubmissionGuard();
	private submitButtonEl: HTMLButtonElement | null = null;
	private readonly submitInputEls: HTMLInputElement[] = [];
	private readonly submitKeyDownHandler = (event: KeyboardEvent): void => {
		this.handleSubmitKeyDown(event);
	};

	constructor(app: App, onSubmit: SubmitHandler, onClosed: () => void) {
		super(app);
		this.onSubmit = onSubmit;
		this.onClosed = onClosed;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('lecture-workflow-modal');
		contentEl.createEl('h2', { text: '创建课堂笔记' });

		new Setting(contentEl)
			.setName('课程名称')
			.setDesc('必填')
			.addText((text) => {
				text
					.setPlaceholder('例如：高等数学')
					.onChange((value) => {
						this.course = value;
					});
				text.inputEl.addEventListener('keydown', this.submitKeyDownHandler);
				this.submitInputEls.push(text.inputEl);
				text.inputEl.focus();
			});

		new Setting(contentEl)
			.setName('课堂主题')
			.setDesc('必填')
			.addText((text) => {
				text
					.setPlaceholder('例如：定积分的应用')
					.onChange((value) => {
						this.topic = value;
					});
				text.inputEl.addEventListener('keydown', this.submitKeyDownHandler);
				this.submitInputEls.push(text.inputEl);
			});

		const transcriptSetting = new Setting(contentEl)
			.setName('原始文字稿')
			.setDesc('可选');
		transcriptSetting.settingEl.addClass('lecture-workflow-transcript-setting');
		transcriptSetting.addTextArea((textArea) =>
			textArea
				.setPlaceholder('粘贴课堂录音转写或手工记录……')
				.onChange((value) => {
					this.transcript = value;
				}),
		);

		const actions = new Setting(contentEl);
		actions.settingEl.addClass('lecture-workflow-actions');
		actions
			.addButton((button) =>
				button
					.setButtonText('取消')
					.onClick(() => this.close()),
			)
			.addButton((button) => {
				this.submitButtonEl = button.buttonEl;
				button
					.setButtonText('创建')
					.setCta()
					.onClick(() => this.submit());
			});
	}

	onClose(): void {
		for (const inputEl of this.submitInputEls) {
			inputEl.removeEventListener('keydown', this.submitKeyDownHandler);
		}
		this.submitInputEls.length = 0;
		this.contentEl.empty();
		this.submitButtonEl = null;
		this.onClosed();
	}

	private handleSubmitKeyDown(event: KeyboardEvent): void {
		if (event.key !== 'Enter') {
			return;
		}

		event.preventDefault();
		void this.submit();
	}

	private async submit(): Promise<void> {
		const course = this.course.trim();
		const topic = this.topic.trim();

		if (!course || !topic) {
			new Notice('请填写课程名称和课堂主题。');
			return;
		}
		if (!this.submissionGuard.tryStart()) {
			return;
		}

		if (this.submitButtonEl) {
			this.submitButtonEl.disabled = true;
		}

		let succeeded = false;
		try {
			succeeded = await this.onSubmit({
				course,
				topic,
				transcript: this.transcript,
			});
		} catch (error) {
			console.error('Lecture Workflow: unexpected note submission failure', error);
			new Notice('创建课堂笔记失败，请稍后重试。');
		} finally {
			this.submissionGuard.finish();
		}

		if (succeeded) {
			this.close();
			return;
		}
		if (this.submitButtonEl) {
			this.submitButtonEl.disabled = false;
		}
	}
}
