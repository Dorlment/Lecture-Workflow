import { Notice, Plugin } from 'obsidian';

import { CreateLectureNoteModal } from './modal';
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
	private readonly openModals = new Set<CreateLectureNoteModal>();

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addCommand({
			id: 'create-lecture-note',
			name: '创建课堂笔记',
			callback: () => this.openCreateLectureNoteModal(),
		});

		this.addRibbonIcon('notebook-pen', '创建课堂笔记', () => {
			this.openCreateLectureNoteModal();
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

	private async loadSettings(): Promise<void> {
		const savedSettings = (await this.loadData()) as Partial<LectureWorkflowSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings ?? {});
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
}
