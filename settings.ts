import {
	App,
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

	constructor(app: App, plugin: SettingsPlugin) {
		super(app, plugin);
		this.lectureWorkflowPlugin = plugin;
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

		this.lectureWorkflowPlugin.settings.notesFolder =
			value.trim() || DEFAULT_SETTINGS.notesFolder;
		await this.lectureWorkflowPlugin.saveSettings();
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
						this.lectureWorkflowPlugin.settings.notesFolder =
							value.trim() || DEFAULT_SETTINGS.notesFolder;
						await this.lectureWorkflowPlugin.saveSettings();
					}),
			);
	}
}
