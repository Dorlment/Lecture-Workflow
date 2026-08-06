import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
} from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';

import type { LectureWorkflowSettings } from './types';

export const DEFAULT_SETTINGS: LectureWorkflowSettings = {
	notesFolder: '课堂笔记',
};

interface SettingsPlugin extends Plugin {
	settings: LectureWorkflowSettings;
	saveSettings(): Promise<void>;
}

export class LectureWorkflowSettingTab extends PluginSettingTab {
	private readonly lectureWorkflowPlugin: SettingsPlugin;
	private lastSavedNotesFolder: string;
	private latestSaveRequest = 0;
	private saveQueue: Promise<void> = Promise.resolve();

	constructor(app: App, plugin: SettingsPlugin) {
		super(app, plugin);
		this.lectureWorkflowPlugin = plugin;
		this.lastSavedNotesFolder = plugin.settings.notesFolder;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: '课堂笔记保存目录',
				desc: '相对于当前 vault 根目录的路径。留空时使用“课堂笔记”。',
				control: {
					type: 'text',
					key: 'notesFolder',
					defaultValue: DEFAULT_SETTINGS.notesFolder,
					placeholder: DEFAULT_SETTINGS.notesFolder,
				},
			},
		];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key !== 'notesFolder' || typeof value !== 'string') {
			return;
		}

		await this.persistNotesFolder(value, (previousValue) => {
			const input = this.containerEl.querySelector<HTMLInputElement>('input');
			if (input) {
				input.value = previousValue;
			}
		});
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('课堂笔记保存目录')
			.setDesc('相对于当前 vault 根目录的路径。留空时使用“课堂笔记”。')
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.notesFolder)
					.setValue(this.lectureWorkflowPlugin.settings.notesFolder)
					.onChange(async (value) => {
						await this.persistNotesFolder(value, (previousValue) => {
							text.setValue(previousValue);
						});
					}),
			);
	}

	private async persistNotesFolder(
		value: string,
		restoreInput: (previousValue: string) => void,
	): Promise<void> {
		const nextValue = value.trim() || DEFAULT_SETTINGS.notesFolder;
		const requestNumber = ++this.latestSaveRequest;
		this.lectureWorkflowPlugin.settings.notesFolder = nextValue;

		const saveOperation = this.saveQueue.then(async () => {
			this.lectureWorkflowPlugin.settings.notesFolder = nextValue;
			try {
				await this.lectureWorkflowPlugin.saveSettings();
				this.lastSavedNotesFolder = nextValue;
			} catch (error) {
				this.lectureWorkflowPlugin.settings.notesFolder =
					this.lastSavedNotesFolder;
				if (requestNumber === this.latestSaveRequest) {
					restoreInput(this.lastSavedNotesFolder);
				}
				const message = error instanceof Error ? error.message : String(error);
				new Notice(`保存设置失败，已恢复之前的目录：${message}`);
			}
		});

		this.saveQueue = saveOperation;
		await saveOperation;
	}
}
