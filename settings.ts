import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
} from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';

import type { TextProviderId } from './provider-types';
import type { ScreenshotBackgroundState } from './screenshot-background-types';
import { ScreenshotSettingsStateBinding } from './screenshot-settings-state';
import {
	buildQwenBaseUrl,
} from './providers/text-providers';
import { ProviderRegistry } from './providers/registry';
import { ObsidianHttpClient } from './providers/obsidian-http';
import {
	DEFAULT_SETTINGS,
	normalizeVisionImageCount,
} from './settings-data';
import type { LectureWorkflowSettings } from './types';

export { DEFAULT_SETTINGS } from './settings-data';

interface SettingsPlugin extends Plugin {
	settings: LectureWorkflowSettings;
	saveSettings(): Promise<void>;
	testTextProvider(id: TextProviderId): Promise<void>;
	getBackgroundScreenshotState?(): ScreenshotBackgroundState;
	useCurrentNoteForBackgroundScreenshots?(): void;
	startBackgroundScreenshotSession?(): void | Promise<void>;
	stopBackgroundScreenshotSession?(): void | Promise<void>;
	onBackgroundScreenshotStateChange?(
		listener: (state: ScreenshotBackgroundState) => void,
	): () => void;
}

interface BackgroundScreenshotUi {
	statusEl?: HTMLElement;
	targetEl?: HTMLElement;
	startedAtEl?: HTMLElement;
	elapsedEl?: HTMLElement;
	detectedEl?: HTMLElement;
	savedEl?: HTMLElement;
	insertedEl?: HTMLElement;
	failedEl?: HTMLElement;
	lastDetectionEl?: HTMLElement;
	lastSavedPathEl?: HTMLElement;
	lastErrorEl?: HTMLElement;
	lastResultEl?: HTMLElement;
	useCurrentButton?: HTMLButtonElement;
	startButton?: HTMLButtonElement;
	stopButton?: HTMLButtonElement;
}

export class LectureWorkflowSettingTab extends PluginSettingTab {
	private readonly lectureWorkflowPlugin: SettingsPlugin;
	private lastSavedSettings: LectureWorkflowSettings;
	private latestSaveRequest = 0;
	private saveQueue: Promise<void> = Promise.resolve();
	private backgroundStateBinding: ScreenshotSettingsStateBinding | null = null;
	private backgroundScreenshotUi: BackgroundScreenshotUi | null = null;
	private backgroundElapsedTimer: number | null = null;

	constructor(app: App, plugin: SettingsPlugin) {
		super(app, plugin);
		this.lectureWorkflowPlugin = plugin;
		this.lastSavedSettings = cloneSettings(plugin.settings);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Lecture Workflow 设置',
				desc: '课堂笔记保存与 AI Provider 配置。',
					render: (setting) => {
					setting.settingEl.empty();
					const container = setting.settingEl.createDiv({
						cls: 'lecture-workflow-settings-container',
					});
					this.renderSettings(container);
					this.ensureBackgroundScreenshotSubscription();
				},
			},
		];
	}

	display(): void {
		this.containerEl.empty();
		this.renderSettings(this.containerEl);
		this.ensureBackgroundScreenshotSubscription();
	}

	hide(): void {
		this.backgroundStateBinding?.close();
		this.backgroundStateBinding = null;
		this.clearBackgroundUiTimers();
		this.backgroundScreenshotUi = null;
		super.hide();
	}

	private renderSettings(containerEl: HTMLElement): void {
		const settings = this.lectureWorkflowPlugin.settings;
		new Setting(containerEl).setName('基本设置').setHeading();

		new Setting(containerEl)
			.setName('课堂笔记保存目录')
			.setDesc('相对于当前 vault 根目录的路径。留空时使用“课堂笔记”。')
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.notesFolder)
					.setValue(settings.notesFolder)
					.onChange(async (value) => {
						await this.updateSettings((next) => {
							next.notesFolder = value.trim() || DEFAULT_SETTINGS.notesFolder;
						});
					}),
			);

		this.renderBackgroundScreenshotSettings(containerEl);

		new Setting(containerEl).setName('AI 设置').setHeading();
		containerEl.createEl('p', {
			text: 'API Key 保存在本地插件配置 data.json 中，未加密；请勿共享或提交至 Git。',
			cls: 'lecture-workflow-secret-warning',
		});

		new Setting(containerEl)
			.setName('配置模式')
			.setDesc('推荐模式：DeepSeek 处理文字；Qwen 为后续视觉和语音能力预留。')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('simple', '简易模式（Qwen）')
					.addOption('recommended', '推荐模式（DeepSeek + Qwen）')
					.addOption('advanced', '高级模式')
					.setValue(settings.setupMode)
					.onChange(async (value) => {
						await this.updateSettings((next) => {
							next.setupMode = value as LectureWorkflowSettings['setupMode'];
						}, true);
					}),
			);

		new Setting(containerEl)
			.setName('Temperature')
			.setDesc('控制输出随机性，范围 0～2。')
			.addSlider((slider) =>
				slider
					.setLimits(0, 2, 0.1)
					.setValue(settings.temperature)
					.onChange(async (value) => {
						await this.updateSettings((next) => {
							next.temperature = value;
						});
					}),
			);

		new Setting(containerEl)
			.setName('请求超时（秒）')
			.setDesc('至少 1 秒；长文字稿建议 120 秒或更高。使用代理/VPN 时可能影响部分供应商连接。')
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '1';
				text.setValue(String(Math.round(settings.requestTimeoutMs / 1000)))
					.onChange(async (value) => {
						const seconds = Number(value);
						if (!Number.isFinite(seconds) || seconds < 1) {
							return;
						}
						await this.updateSettings((next) => {
							next.requestTimeoutMs = Math.round(seconds * 1000);
						});
					});
			});

		const registry = new ProviderRegistry(settings, new ObsidianHttpClient());
		const activeProvider = registry.getActiveTextProvider();
		const validation = activeProvider.validate();
		new Setting(containerEl)
			.setName('当前文字提供商状态')
			.setDesc(`${activeProvider.displayName}：${validation.length === 0 ? '配置完整' : validation.join(' ')}`);

		new Setting(containerEl)
			.setName('高级模式文字提供商')
			.setDesc('仅控制高级模式下的文字 Provider，不影响独立的视觉 Provider。')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('deepseek', 'DeepSeek')
					.addOption('qwen', 'Qwen / 阿里云百炼')
					.addOption('custom', 'Custom OpenAI-compatible')
					.setValue(settings.advancedTextProvider)
					.onChange(async (value) => {
						await this.updateSettings((next) => {
							next.advancedTextProvider = value as TextProviderId;
						}, true);
					}),
			);

		this.renderVisionSettings(containerEl, settings);

		this.renderDeepSeekSettings(containerEl, settings);
		this.renderQwenSettings(containerEl, settings);
		this.renderCustomSettings(containerEl, settings);
	}

	private renderBackgroundScreenshotSettings(containerEl: HTMLElement): void {
		const state = this.getBackgroundScreenshotState();
		new Setting(containerEl).setName('后台课堂截图').setHeading();
		containerEl.createEl('p', {
			text: '日常上课可直接通过左侧 Lecture Workflow 图标启动或停止课堂监听；此处主要用于配置目标和查看详细状态。',
		});
		containerEl.createEl('p', {
			text: '启动后可切换到网课页面，使用 Snipaste Ctrl+1 或 Windows Win+Shift+S 截图。插件只检测新复制的图片，不读取文字，也不会上传图片。',
		});

		const statusSetting = new Setting(containerEl)
			.setName('当前状态')
			.setDesc(backgroundScreenshotStateLabel(state));
		const targetSetting = new Setting(containerEl)
			.setName('目标课堂笔记')
			.setDesc(state.targetPath ?? '未选择');
		const startedAtSetting = new Setting(containerEl)
			.setName('会话开始时间')
			.setDesc(formatSessionStart(state.startedAt));
		const elapsedSetting = new Setting(containerEl)
			.setName('已运行时长')
			.setDesc(formatSessionElapsed(state));
		const detectedSetting = new Setting(containerEl)
			.setName('本次已检测截图数量')
			.setDesc(`${state.detectedCount} 张`);
		const savedSetting = new Setting(containerEl)
			.setName('已保存数量')
			.setDesc(`${state.savedCount} 张`);
		const insertedSetting = new Setting(containerEl)
			.setName('已插入数量')
			.setDesc(`${state.insertedCount} 张`);
		const failedSetting = new Setting(containerEl)
			.setName('失败数量')
			.setDesc(`${state.failedCount} 张`);
		const lastDetectionSetting = new Setting(containerEl)
			.setName('最近截图尺寸')
			.setDesc(formatLastDetection(state));
		const lastSavedPathSetting = new Setting(containerEl)
			.setName('最近保存路径')
			.setDesc(state.lastSavedPath ?? '无');
		const lastErrorSetting = new Setting(containerEl)
			.setName('最近错误')
			.setDesc(state.lastError ?? '无');
		const lastResultSetting = new Setting(containerEl)
			.setName('最近一次结果')
			.setDesc(formatLastResult(state));

		const controls = new Setting(containerEl)
			.setName('课堂截图会话')
			.setDesc('这是临时运行状态；插件重新加载、卸载或应用关闭后会自动停止。');
		let useCurrentButton: HTMLButtonElement | undefined;
		let startButton: HTMLButtonElement | undefined;
		let stopButton: HTMLButtonElement | undefined;
		controls.addButton((button) => {
				useCurrentButton = button.buttonEl;
				button
					.setButtonText('使用当前笔记')
					.setDisabled(state.status === 'listening')
					.onClick(() => {
						this.lectureWorkflowPlugin.useCurrentNoteForBackgroundScreenshots?.();
					});
			})
			.addButton((button) => {
				startButton = button.buttonEl;
				button
					.setButtonText('开始监听')
					.setDisabled(state.status === 'listening')
					.onClick(async () => {
						await this.lectureWorkflowPlugin.startBackgroundScreenshotSession?.();
					});
			})
			.addButton((button) => {
				stopButton = button.buttonEl;
				button
					.setButtonText('停止监听')
					.setDisabled(state.status !== 'listening')
					.onClick(async () => {
						await this.lectureWorkflowPlugin.stopBackgroundScreenshotSession?.();
					});
			});

		this.backgroundScreenshotUi = {
			statusEl: statusSetting.descEl,
			targetEl: targetSetting.descEl,
			startedAtEl: startedAtSetting.descEl,
			elapsedEl: elapsedSetting.descEl,
			detectedEl: detectedSetting.descEl,
			savedEl: savedSetting.descEl,
			insertedEl: insertedSetting.descEl,
			failedEl: failedSetting.descEl,
			lastDetectionEl: lastDetectionSetting.descEl,
			lastSavedPathEl: lastSavedPathSetting.descEl,
			lastErrorEl: lastErrorSetting.descEl,
			lastResultEl: lastResultSetting.descEl,
			useCurrentButton,
			startButton,
			stopButton,
		};
		this.applyBackgroundScreenshotState(state);
		this.ensureBackgroundElapsedTimer();
	}

	private ensureBackgroundScreenshotSubscription(): void {
		if (this.backgroundStateBinding) {
			return;
		}
		if (!this.lectureWorkflowPlugin.onBackgroundScreenshotStateChange) {
			return;
		}
		this.backgroundStateBinding = new ScreenshotSettingsStateBinding({
			readState: () => this.getBackgroundScreenshotState(),
			subscribe: (listener) =>
				this.lectureWorkflowPlugin.onBackgroundScreenshotStateChange?.(listener)
				?? (() => undefined),
			apply: (state) => this.applyBackgroundScreenshotState(state),
			schedule: (callback, delayMs) => typeof window === 'undefined'
				? runImmediately(callback)
				: window.setTimeout(callback, delayMs),
			cancel: (timerId) => {
				if (typeof window !== 'undefined') {
					window.clearTimeout(timerId);
				}
			},
		});
		this.backgroundStateBinding.open();
	}

	private applyBackgroundScreenshotState(state: ScreenshotBackgroundState): void {
		const ui = this.backgroundScreenshotUi;
		if (!ui) {
			return;
		}
		setDynamicText(ui.statusEl, backgroundScreenshotStateLabel(state));
		setDynamicText(ui.targetEl, state.targetPath ?? '未选择');
		setDynamicText(ui.startedAtEl, formatSessionStart(state.startedAt));
		setDynamicText(ui.elapsedEl, formatSessionElapsed(state));
		setDynamicText(ui.detectedEl, `${state.detectedCount} 张`);
		setDynamicText(ui.savedEl, `${state.savedCount} 张`);
		setDynamicText(ui.insertedEl, `${state.insertedCount} 张`);
		setDynamicText(ui.failedEl, `${state.failedCount} 张`);
		setDynamicText(ui.lastDetectionEl, formatLastDetection(state));
		setDynamicText(ui.lastSavedPathEl, state.lastSavedPath ?? '无');
		setDynamicText(ui.lastErrorEl, state.lastError ?? '无');
		setDynamicText(ui.lastResultEl, formatLastResult(state));
		if (ui.useCurrentButton) {
			ui.useCurrentButton.disabled = state.status === 'listening';
		}
		if (ui.startButton) {
			ui.startButton.disabled = state.status === 'listening';
		}
		if (ui.stopButton) {
			ui.stopButton.disabled = state.status !== 'listening';
		}
	}

	private ensureBackgroundElapsedTimer(): void {
		if (this.backgroundElapsedTimer !== null || typeof window === 'undefined') {
			return;
		}
		this.backgroundElapsedTimer = window.setInterval(() => {
			const state = this.getBackgroundScreenshotState();
			setDynamicText(this.backgroundScreenshotUi?.elapsedEl, formatSessionElapsed(state));
		}, 1_000);
	}

	private clearBackgroundUiTimers(): void {
		if (typeof window === 'undefined') {
			this.backgroundElapsedTimer = null;
			return;
		}
		if (this.backgroundElapsedTimer !== null) {
			window.clearInterval(this.backgroundElapsedTimer);
			this.backgroundElapsedTimer = null;
		}
	}

	private getBackgroundScreenshotState(): ScreenshotBackgroundState {
		return this.lectureWorkflowPlugin.getBackgroundScreenshotState?.()
			?? emptyBackgroundScreenshotState();
	}

	private renderVisionSettings(containerEl: HTMLElement, settings: LectureWorkflowSettings): void {
		new Setting(containerEl).setName('图片参与 AI 整理').setHeading();
		containerEl.createEl('p', {
			text: '启用后，当前笔记引用的图片会发送给所选第三方模型服务商，可能产生额外 Token 或调用费用。插件不会把图片上传到公共图床；关闭开关时不会读取或发送图片。',
			cls: 'lecture-workflow-secret-warning',
		});

		new Setting(containerEl)
			.setName('启用图片参与整理')
			.setDesc('默认关闭。只有启用后，后续视觉流程才允许取得视觉 Provider。')
			.addToggle((toggle) =>
				toggle
					.setValue(settings.enableVisionInput)
					.onChange(async (value) => {
						await this.updateSettings((next) => {
							next.enableVisionInput = value;
						}, true);
					}),
			);

		new Setting(containerEl)
			.setName('视觉 Provider')
			.setDesc('与简易、推荐和高级文字配置模式完全独立。')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('qwen', 'Qwen')
					.addOption('custom', '自定义 OpenAI-compatible')
					.setValue(settings.visionProvider)
					.onChange(async (value) => {
						await this.updateSettings((next) => {
							next.visionProvider = value as LectureWorkflowSettings['visionProvider'];
						}, true);
					});
				dropdown.selectEl.disabled = !settings.enableVisionInput;
			});

		if (settings.visionProvider === 'qwen') {
			new Setting(containerEl)
				.setName('Qwen 视觉模型')
				.setDesc('仅用于视觉请求，不修改现有 Qwen 文字模型。')
				.addText((text) => {
					text.inputEl.disabled = !settings.enableVisionInput;
					text
						.setPlaceholder(DEFAULT_SETTINGS.qwen.visionModel)
						.setValue(settings.qwen.visionModel)
						.onChange(async (value) => {
							await this.updateSettings((next) => {
								next.qwen.visionModel = value.trim();
							});
						});
				});
		}

		new Setting(containerEl)
			.setName('最大图片数量')
			.setDesc('允许 1～10 张；无效输入会恢复为合法值。')
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '1';
				text.inputEl.max = '10';
				text.inputEl.disabled = !settings.enableVisionInput;
				text.setValue(String(settings.maxVisionImages)).onChange(async (value) => {
					const normalized = normalizeVisionImageCount(Number(value));
					await this.updateSettings((next) => {
						next.maxVisionImages = normalized;
					});
					if (value !== String(normalized)) {
						text.setValue(String(normalized));
					}
				});
			});
	}

	private renderDeepSeekSettings(containerEl: HTMLElement, settings: LectureWorkflowSettings): void {
		new Setting(containerEl).setName('DeepSeek').setHeading();
		this.addSecretSetting(containerEl, 'API Key', settings.deepseek.apiKey, async (value) => {
			await this.updateSettings((next) => { next.deepseek.apiKey = value; });
		});
		this.addTextSetting(containerEl, 'Base URL', settings.deepseek.baseUrl, async (value) => {
			await this.updateSettings((next) => { next.deepseek.baseUrl = value.trim(); });
		});
		this.addTextSetting(containerEl, 'Model', settings.deepseek.model, async (value) => {
			await this.updateSettings((next) => { next.deepseek.model = value.trim(); });
		});
		this.addTestButton(containerEl, '测试 DeepSeek 连接', 'deepseek');
	}

	private renderQwenSettings(containerEl: HTMLElement, settings: LectureWorkflowSettings): void {
		new Setting(containerEl).setName('Qwen / 阿里云百炼').setHeading();
		this.addSecretSetting(containerEl, 'API Key', settings.qwen.apiKey, async (value) => {
			await this.updateSettings((next) => { next.qwen.apiKey = value; });
		});
		new Setting(containerEl)
			.setName('Region')
			.setDesc('当前至少支持华北2（北京）。')
			.addDropdown((dropdown) =>
				dropdown.addOption('cn-beijing', '华北2（北京）').setValue(settings.qwen.region),
			);
		new Setting(containerEl)
			.setName('Workspace ID')
			.addText((text) => {
				text.setValue(settings.qwen.workspaceId).onChange(async (value) => {
					await this.updateSettings((next) => { next.qwen.workspaceId = value.trim(); }, true);
				});
			});
		new Setting(containerEl)
			.setName('API base URL')
			.setDesc('根据 region 和 Workspace ID 自动生成。')
			.addText((text) => {
				text.setValue(buildQwenBaseUrl(settings.qwen.region, settings.qwen.workspaceId));
				text.inputEl.readOnly = true;
			});
		this.addTextSetting(containerEl, 'Text Model', settings.qwen.model, async (value) => {
			await this.updateSettings((next) => { next.qwen.model = value.trim(); });
		});
		this.addTestButton(containerEl, '测试 Qwen 连接', 'qwen');
	}

	private renderCustomSettings(containerEl: HTMLElement, settings: LectureWorkflowSettings): void {
		new Setting(containerEl).setName('Custom OpenAI-compatible').setHeading();
		this.addSecretSetting(containerEl, 'API Key', settings.customOpenAI.apiKey, async (value) => {
			await this.updateSettings((next) => { next.customOpenAI.apiKey = value; });
		});
		this.addTextSetting(containerEl, 'Base URL', settings.customOpenAI.baseUrl, async (value) => {
			await this.updateSettings((next) => { next.customOpenAI.baseUrl = value.trim(); });
		});
		this.addTextSetting(containerEl, 'Model', settings.customOpenAI.model, async (value) => {
			await this.updateSettings((next) => { next.customOpenAI.model = value.trim(); });
		});
		new Setting(containerEl)
			.setName('自定义 Provider 支持图片')
			.setDesc('仅在确认该模型兼容 OpenAI 图像输入格式时开启。该开关只是用户声明，插件无法保证服务端兼容。')
			.addToggle((toggle) =>
				toggle.setValue(settings.customOpenAI.supportsVision).onChange(async (value) => {
					await this.updateSettings((next) => {
						next.customOpenAI.supportsVision = value;
					}, true);
				}),
			);
		this.addTestButton(containerEl, '测试自定义连接', 'custom');
	}

	private addSecretSetting(
		containerEl: HTMLElement,
		name: string,
		value: string,
		onChange: (value: string) => Promise<void>,
	): void {
		new Setting(containerEl).setName(name).addText((text) => {
			text.inputEl.type = 'password';
			text.setValue(value).onChange(onChange);
		});
	}

	private addTextSetting(
		containerEl: HTMLElement,
		name: string,
		value: string,
		onChange: (value: string) => Promise<void>,
	): void {
		new Setting(containerEl).setName(name).addText((text) => text.setValue(value).onChange(onChange));
	}

	private addTestButton(containerEl: HTMLElement, name: string, id: TextProviderId): void {
		new Setting(containerEl).setName(name).addButton((button) =>
			button.setButtonText('测试连接').onClick(async () => {
				button.buttonEl.disabled = true;
				try {
					await this.lectureWorkflowPlugin.testTextProvider(id);
				} finally {
					button.buttonEl.disabled = false;
				}
			}),
		);
	}

	private async updateSettings(
		mutate: (settings: LectureWorkflowSettings) => void,
		rerender = false,
	): Promise<void> {
		const nextSettings = cloneSettings(this.lectureWorkflowPlugin.settings);
		mutate(nextSettings);
		const requestNumber = ++this.latestSaveRequest;
		this.lectureWorkflowPlugin.settings = nextSettings;

		const operation = this.saveQueue.then(async () => {
			this.lectureWorkflowPlugin.settings = cloneSettings(nextSettings);
			try {
				await this.lectureWorkflowPlugin.saveSettings();
				this.lastSavedSettings = cloneSettings(nextSettings);
				if (rerender && requestNumber === this.latestSaveRequest) {
					this.rerenderSettings();
				}
			} catch {
				this.lectureWorkflowPlugin.settings = cloneSettings(this.lastSavedSettings);
				if (requestNumber === this.latestSaveRequest) {
					this.rerenderSettings();
				}
				new Notice('保存设置失败，已恢复之前的配置。');
			}
		});
		this.saveQueue = operation;
		await operation;
	}

	private rerenderSettings(): void {
		this.containerEl.empty();
		this.renderSettings(this.containerEl);
	}
}

function cloneSettings(settings: LectureWorkflowSettings): LectureWorkflowSettings {
	return JSON.parse(JSON.stringify(settings)) as LectureWorkflowSettings;
}

function backgroundScreenshotStateLabel(state: ScreenshotBackgroundState): string {
	if (state.status === 'listening') {
		return '监听中';
	}
	if (state.status === 'unsupported') {
		return '当前环境不支持';
	}
	return '未启动';
}

function emptyBackgroundScreenshotState(): ScreenshotBackgroundState {
	return {
		status: 'idle',
		sessionId: null,
		startedAt: null,
		endedAt: null,
		targetPath: null,
		targetName: null,
		detectedCount: 0,
		savedCount: 0,
		insertedCount: 0,
		failedCount: 0,
		lastDetection: null,
		lastSavedPath: null,
		lastError: null,
		events: [],
	};
}

function formatSessionStart(startedAt: Date | null): string {
	return startedAt ? startedAt.toLocaleString() : '未开始';
}

function formatSessionElapsed(state: ScreenshotBackgroundState): string {
	if (!state.startedAt) {
		return '00:00:00';
	}
	const endTime = state.status === 'listening'
		? Date.now()
		: (state.endedAt?.getTime() ?? state.startedAt.getTime());
	const totalSeconds = Math.max(0, Math.floor((endTime - state.startedAt.getTime()) / 1_000));
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	return [hours, minutes, seconds]
		.map((value) => String(value).padStart(2, '0'))
		.join(':');
}

function formatLastDetection(state: ScreenshotBackgroundState): string {
	return state.lastDetection
		? `${state.lastDetection.width}×${state.lastDetection.height}`
		: '无';
}

function formatLastResult(state: ScreenshotBackgroundState): string {
	const event = state.events.at(-1);
	if (!event) {
		return '无';
	}
	if (event.status === 'inserted') {
		return `已保存并写入时间线 · ${event.eventId}`;
	}
	if (event.status === 'saved') {
		return `图片已保存，时间线待处理 · ${event.eventId}`;
	}
	if (event.status === 'failed') {
		return `失败 · ${event.eventId}`;
	}
	return `正在处理 · ${event.eventId}`;
}

function setDynamicText(element: HTMLElement | undefined, text: string): void {
	element?.setText(text);
}

function runImmediately(callback: () => void): number {
	callback();
	return 0;
}
