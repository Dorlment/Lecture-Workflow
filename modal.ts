import { App, Modal, Notice, Setting } from 'obsidian';

import type { LectureNoteInput } from './types';

type SubmitHandler = (input: LectureNoteInput) => Promise<boolean>;

export class CreateLectureNoteModal extends Modal {
	private course = '';
	private topic = '';
	private transcript = '';
	private readonly onSubmit: SubmitHandler;

	constructor(app: App, onSubmit: SubmitHandler) {
		super(app);
		this.onSubmit = onSubmit;
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
				text.inputEl.addEventListener('keydown', (event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
					}
				});
				text.inputEl.focus();
			});

		new Setting(contentEl)
			.setName('课堂主题')
			.setDesc('必填')
			.addText((text) =>
				text
					.setPlaceholder('例如：定积分的应用')
					.onChange((value) => {
						this.topic = value;
					}),
			);

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
			.addButton((button) =>
				button
					.setButtonText('创建')
					.setCta()
					.onClick(async () => {
						const course = this.course.trim();
						const topic = this.topic.trim();

						if (!course || !topic) {
							new Notice('请填写课程名称和课堂主题。');
							return;
						}

						button.buttonEl.disabled = true;
						const succeeded = await this.onSubmit({
							course,
							topic,
							transcript: this.transcript.trim(),
						});
						button.buttonEl.disabled = false;

						if (succeeded) {
							this.close();
						}
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
