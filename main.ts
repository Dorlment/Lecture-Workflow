import {
	Menu,
	Notice,
	Platform,
	Plugin,
	TFile,
	type WorkspaceLeaf,
} from 'obsidian';

import {
	AudioCaptureProbe,
	createBrowserAudioCaptureProbe,
} from './audio-capture-probe';
import {
	AudioCompanionClient,
	createBrowserAudioCompanionWebSocketFactory,
} from './audio-companion-client';
import { AudioCompanionSessionController } from './audio-companion-session-controller';
import { AudioFrameConsumer } from './audio-frame-consumer';
import { BailianStreamingAsrProvider } from './bailian-streaming-asr-provider';
import { AiPreviewModal } from './ai-preview-modal';
import { AiRetryModal } from './ai-retry-modal';
import {
	buildRetryOptions,
	buildVisionRetryOptions,
	describeProviderFailure,
} from './ai-retry';
import { AiWorkflowGate } from './ai-note';
import type {
	AiGenerationSnapshot,
	AiPreviewData,
	VisionGenerationSnapshot,
} from './ai-workflow';
import {
	AiWorkflowService,
	isVisionWorkflowConflictError,
	VISION_WORKFLOW_CONFLICT_MESSAGE,
} from './ai-workflow';
import { CreateLectureNoteModal } from './modal';
import {
	ClassroomSessionController,
	classroomSessionMenuTitle,
} from './classroom-session-controller';
import { createWindowsPluginRelativeLaunchResolver } from './companion-launch-resolver';
import {
	CompanionProcessManager,
	createNodeCompanionSpawnFactory,
} from './companion-process-manager';
import {
	CompanionReadinessProbe,
	createNodeTcpConnector,
} from './companion-readiness-probe';
import {
	CLASSROOM_WORKBENCH_VIEW_TYPE,
	ClassroomWorkbenchView,
} from './classroom-workbench-view';
import {
	dismissClassroomWorkbench,
	getClassroomWorkbenchDismissMode,
} from './classroom-workbench-dismiss';
import {
	ClassroomWorkbenchOpenError,
	ClassroomWorkbenchOpener,
} from './classroom-workbench-opener';
import {
	isNoteConflictError,
	isNoteLatestReadError,
	NOTE_CONFLICT_MESSAGE,
	NOTE_LATEST_READ_FAILED_MESSAGE,
} from './note-conflict';
import type { TextProviderId, VisionProviderId } from './provider-types';
import { ProviderError } from './provider-types';
import { ObsidianHttpClient } from './providers/obsidian-http';
import { ProviderRegistry } from './providers/registry';
import {
	ProgressNoticeManager,
	type ProgressNoticeLease,
} from './progress-notice';
import { LectureNoteService } from './service';
import {
	DEFAULT_SETTINGS,
	LectureWorkflowSettingTab,
} from './settings';
import { normalizeSettings } from './settings-data';
import { createRuntimeNodeModuleLoader } from './runtime-node-loader';
import { createObsidianCompanionPluginDirectoryProvider } from './obsidian-companion-plugin-directory';
import { runtimeErrorMessage } from './audio-companion-runtime-ui';
import { RealtimeAsrSessionController } from './realtime-asr-session-controller';
import { RealtimeAsrTranscriptSessionManager } from './realtime-asr-transcript-session-manager';
import { RealtimeAsrTransportAbDiagnostic } from './realtime-asr-transport-ab-diagnostic';
import { RealtimeAsrTransportAbModal } from './realtime-asr-transport-ab-modal';
import { createNodeRealtimeAsrTransport } from './realtime-asr-websocket';
import { ObsidianBackgroundScreenshotService } from './screenshot-background-service';
import {
	buildClassroomSessionId,
	ScreenshotBackgroundSession,
} from './screenshot-background-session';
import type {
	ClassroomScreenshotEvent,
	ScreenshotBackgroundState,
} from './screenshot-background-types';
import { createElectronClipboardAdapter } from './screenshot-clipboard-adapter';
import type {
	LectureNoteInput,
	LectureWorkflowSettings,
} from './types';
import {
	VisionConfirmationModal,
	VisionDisabledChoiceModal,
} from './vision-confirmation-modal';
import {
	decideVisionWorkflowRoute,
	shouldAcceptVisionResult,
} from './vision-workflow-routing';

export default class LectureWorkflowPlugin extends Plugin {
	settings: LectureWorkflowSettings = DEFAULT_SETTINGS;
	private readonly openModals = new Set<{ close(): void }>();
	private readonly aiWorkflowGate = new AiWorkflowGate();
	private readonly progressNotices = new ProgressNoticeManager({
		createNotice: (message, durationMs) => new Notice(message, durationMs),
		scheduler: {
			setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
			clearTimeout: (handle) => window.clearTimeout(handle),
		},
	});
	private activeVisionAbortController: AbortController | null = null;
	private classroomSessionController: ClassroomSessionController<TFile> | null = null;
	private audioCaptureProbe: AudioCaptureProbe | null = null;
	private audioCompanionClient: AudioCompanionClient | null = null;
	private audioCompanionSessionController: AudioCompanionSessionController | null = null;
	private audioFrameConsumer: AudioFrameConsumer | null = null;
	private realtimeAsrSessionController: RealtimeAsrSessionController | null = null;
	private transcriptSessionManager: RealtimeAsrTranscriptSessionManager | null = null;
	private realtimeAsrTransportAbModal: RealtimeAsrTransportAbModal | null = null;
	private classroomWorkbenchOpener: ClassroomWorkbenchOpener<WorkspaceLeaf> | null = null;
	private screenshotBackgroundService: ObsidianBackgroundScreenshotService | null = null;
	private screenshotStatusBarEl: HTMLElement | null = null;
	private unsubscribeScreenshotState: (() => void) | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.initializeScreenshotBackgroundSession();
		this.audioCaptureProbe = createBrowserAudioCaptureProbe(() => Platform.isDesktopApp);
		this.audioCompanionClient = new AudioCompanionClient({
			clientVersion: this.manifest.version,
			getSessionContext: () => this.getAudioCompanionClassroomContext(),
			webSocketFactory: createBrowserAudioCompanionWebSocketFactory(),
		});
		const nodeLoader = createRuntimeNodeModuleLoader();
		const processManager = new CompanionProcessManager({
			spawn: createNodeCompanionSpawnFactory(nodeLoader),
		});
		const readinessProbe = new CompanionReadinessProbe({
			connector: createNodeTcpConnector(nodeLoader),
		});
		this.audioFrameConsumer = new AudioFrameConsumer();
		this.audioCompanionSessionController = new AudioCompanionSessionController({
			isWindowsDesktop: () => Platform.isDesktopApp && Platform.isWin,
			classroom: {
				getSessionContext: () => this.getAudioCompanionClassroomContext(),
				subscribe: (listener) => this.onBackgroundScreenshotStateChange(() => {
					listener(this.getAudioCompanionClassroomContext());
				}),
			},
			launchResolver: createWindowsPluginRelativeLaunchResolver(
				createObsidianCompanionPluginDirectoryProvider(this),
			),
			processManager,
			readinessProbe,
			client: this.audioCompanionClient,
			frameConsumer: this.audioFrameConsumer,
		});
		this.realtimeAsrSessionController = new RealtimeAsrSessionController({
			isSupportedRuntime: () => Platform.isDesktopApp && Platform.isWin,
			getConfiguration: () => ({
				workspaceId: this.settings.qwen.workspaceId,
				region: this.settings.qwen.region,
				model: this.settings.qwen.asrModel,
			}),
			getApiKey: () => this.settings.qwen.apiKey,
			getClassroomSessionContext: () => this.getAudioCompanionClassroomContext(),
			audio: this.audioCompanionSessionController,
			providerFactory: (providerOptions) =>
				new BailianStreamingAsrProvider({
					configuration: providerOptions.configuration,
					getApiKey: () => providerOptions.getApiKey(),
					transportFactory: () => createNodeRealtimeAsrTransport(),
					taskIdFactory: () => crypto.randomUUID(),
					callbacks: providerOptions.callbacks,
				}),
		});
		this.transcriptSessionManager = new RealtimeAsrTranscriptSessionManager({
			app: this.app,
			subscribeToAsrState: (listener) => this.realtimeAsrSessionController!.subscribe(listener),
			resolveTargetFile: () => this.resolveTranscriptTargetFile(),
		});
		this.transcriptSessionManager.start();
		this.register(this.transcriptSessionManager.dispose.bind(this.transcriptSessionManager));
		this.registerClassroomWorkbenchView();
		this.classroomWorkbenchOpener = new ClassroomWorkbenchOpener(
			this.app.workspace,
			CLASSROOM_WORKBENCH_VIEW_TYPE,
		);

		this.addCommand({
			id: 'create-lecture-note',
			name: '创建课堂笔记',
			callback: () => this.openCreateLectureNoteModal(),
		});

		this.addCommand({
			id: 'ai-structure-current-lecture-note',
			name: 'AI 整理当前课堂笔记',
			callback: () => this.runAiWorkflow(),
		});

		this.addCommand({
			id: 'toggle-classroom-listening',
			name: '切换课堂监听',
			callback: () => this.toggleClassroomListening(),
		});

		this.addCommand({
			id: 'open-classroom-workbench',
			name: '打开课堂工作台',
			callback: () => this.openClassroomWorkbench(),
		});

		this.addCommand({
			id: 'run-realtime-asr-transport-ab-diagnostic',
			name: '运行Realtime ASR Transport A/B诊断（开发）',
			callback: () => this.openRealtimeAsrTransportAbDiagnostic(),
		});

		this.addRibbonIcon('notebook-pen', 'Lecture Workflow', (event) => {
			this.showRibbonMenu(event);
		});

		this.addSettingTab(new LectureWorkflowSettingTab(this.app, this));
	}

	onunload(): void {
		this.realtimeAsrTransportAbModal?.close();
		this.realtimeAsrTransportAbModal = null;
		this.transcriptSessionManager = null;
		this.classroomWorkbenchOpener = null;
		this.progressNotices.dispose();
		this.realtimeAsrSessionController?.dispose();
		this.realtimeAsrSessionController = null;
		this.audioCompanionSessionController?.dispose();
		this.audioCompanionSessionController = null;
		this.audioFrameConsumer = null;
		this.audioCompanionClient?.dispose();
		this.audioCompanionClient = null;
		this.audioCaptureProbe?.dispose();
		this.audioCaptureProbe = null;
		this.classroomSessionController?.dispose();
		this.classroomSessionController = null;
		this.screenshotBackgroundService?.dispose();
		this.screenshotBackgroundService = null;
		this.unsubscribeScreenshotState?.();
		this.unsubscribeScreenshotState = null;
		this.screenshotStatusBarEl?.empty();
		this.screenshotStatusBarEl?.addClass('is-hidden');
		this.screenshotStatusBarEl = null;
		this.activeVisionAbortController?.abort();
		this.activeVisionAbortController = null;
		for (const modal of this.openModals) {
			modal.close();
		}
		this.openModals.clear();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async testTextProvider(id: TextProviderId): Promise<void> {
		const registry = this.createProviderRegistry();
		const provider = registry.getTextProvider(id);
		const progress = this.progressNotices.start(
			`provider-test:${id}`,
			`正在测试 ${provider.displayName} 连接…`,
		);
		try {
			await provider.testConnection();
			progress.success(`${provider.displayName} 连接测试成功。`);
		} catch (error) {
			const failure = describeProviderFailure(provider.displayName, error);
			progress.failure(`连接测试失败：${failure.message}`);
		} finally {
			progress.finishIfPending();
		}
	}

	private async loadSettings(): Promise<void> {
		const savedSettings = (await this.loadData()) as Partial<LectureWorkflowSettings> | null;
		this.settings = normalizeSettings(savedSettings);
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

	private createProviderRegistry(): ProviderRegistry {
		return new ProviderRegistry(this.settings, new ObsidianHttpClient());
	}

	getBackgroundScreenshotState(): ScreenshotBackgroundState {
		if (!Platform.isDesktopApp) {
			return {
				status: 'unsupported',
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
		return this.classroomSessionController?.getState() ?? {
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

	useCurrentNoteForBackgroundScreenshots(): void {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== 'md') {
			new Notice('请先打开一篇 Markdown 课堂笔记。');
			return;
		}
		if (!this.classroomSessionController?.setTarget(file)) {
			new Notice('后台课堂截图监听中，请先停止当前会话。');
			return;
		}
		new Notice(`已将截图目标设为：${file.path}`);
	}

	async startBackgroundScreenshotSession(): Promise<void> {
		if (!Platform.isDesktopApp) {
			new Notice(mobileScreenshotUnsupportedMessage());
			return;
		}
		if (this.aiWorkflowGate.state !== 'idle') {
			new Notice('AI 整理正在进行，请关闭预览或等待完成后再启动截图监听。');
			return;
		}
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== 'md') {
			new Notice('请先打开一篇 Markdown 课堂笔记。');
			return;
		}
		const controller = this.classroomSessionController;
		if (!controller) {
			new Notice(backgroundScreenshotUnsupportedMessage());
			return;
		}
		const result = controller.start(file);
		if (result === 'started') {
			new Notice(`课堂监听已启动：${file.basename}`);
			await this.startAudioCompanionSession();
			return;
		}
		if (result === 'unsupported-platform') {
			new Notice(mobileScreenshotUnsupportedMessage());
			return;
		}
		if (result === 'unsupported') {
			return;
		}
		if (result === 'busy') {
			new Notice('后台课堂截图已经在监听中，或其他写入流程尚未结束。');
			return;
		}
		new Notice('请先选择一篇 Markdown 课堂笔记。');
	}

	async stopBackgroundScreenshotSession(): Promise<void> {
		let result: ReturnType<ClassroomSessionController<TFile>['stop']> | undefined;
		try {
			try {
				await this.realtimeAsrSessionController?.stop();
			} finally {
				await this.audioCompanionSessionController?.stop();
			}
		} catch {
			new Notice('系统音频停止确认失败，课堂监听仍将停止。');
		} finally {
			result = this.classroomSessionController?.stop('manual');
		}
		if (!result?.stopped) {
			return;
		}
		new Notice(`课堂监听已停止，共保存 ${result.savedCount} 张截图。`);
	}

	private async toggleClassroomListening(): Promise<void> {
		const controller = this.classroomSessionController;
		if (!controller) {
			new Notice(backgroundScreenshotUnsupportedMessage());
			return;
		}
		if (controller.getState().status === 'listening') {
			await this.stopBackgroundScreenshotSession();
			return;
		}
		if (!Platform.isDesktopApp) {
			new Notice(mobileScreenshotUnsupportedMessage());
			return;
		}
		if (this.aiWorkflowGate.state !== 'idle') {
			new Notice('AI 整理正在进行，请关闭预览或等待完成后再启动课堂监听。');
			return;
		}
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile || activeFile.extension !== 'md') {
			new Notice('请先打开一篇课堂笔记，再启动课堂监听。');
			return;
		}
		const result = controller.start(activeFile);
		if (result === 'started') {
			new Notice(`课堂监听已启动：${activeFile.basename}`);
			await this.startAudioCompanionSession();
			return;
		}
		this.handleClassroomSessionStartFailure(result);
	}

	private async startAudioCompanionSession(): Promise<void> {
		const controller = this.audioCompanionSessionController;
		if (!controller) {
			return;
		}
		let result;
		try {
			result = await controller.start();
		} catch {
			new Notice('系统音频助手启动失败，课堂截图监听将继续运行。');
			return;
		}
		if (result === 'capturing') {
			await this.startRealtimeAsrSession();
			return;
		}
		if (result === 'busy') {
			return;
		}
		const state = controller.state;
		new Notice(runtimeErrorMessage(state.errorCode, state.remoteErrorCode)
			|| '系统音频助手启动失败，课堂截图监听将继续运行。');
	}

	private async stopAudioCompanionSession(): Promise<void> {
		try {
			try {
				await this.realtimeAsrSessionController?.stop();
			} finally {
				await this.audioCompanionSessionController?.stop();
			}
		} catch {
			new Notice('无法确认系统音频已停止，请重新加载插件后检查。');
		}
	}

	private openRealtimeAsrTransportAbDiagnostic(): void {
		if (this.realtimeAsrTransportAbModal) {
			new Notice('Realtime ASR Transport A/B诊断已经打开。');
			return;
		}
		const classroomActive = this.getBackgroundScreenshotState().status === 'listening';
		const audioStatus = this.audioCompanionSessionController?.state.status;
		const audioActive = audioStatus === 'launching'
			|| audioStatus === 'waiting-for-readiness'
			|| audioStatus === 'connecting'
			|| audioStatus === 'ready'
			|| audioStatus === 'capturing'
			|| audioStatus === 'stopping';
		const asrStatus = this.realtimeAsrSessionController?.state.status;
		const asrActive = asrStatus === 'connecting'
			|| asrStatus === 'starting-task'
			|| asrStatus === 'streaming'
			|| asrStatus === 'stopping';
		if (classroomActive || audioActive || asrActive) {
			new Notice('请先停止当前课堂监听和实时转写。');
			return;
		}
		if (!Platform.isDesktopApp || !Platform.isWin) {
			new Notice('Realtime ASR Transport A/B诊断仅支持 Windows 桌面端。');
			return;
		}
		const diagnostic = new RealtimeAsrTransportAbDiagnostic({
			getConfiguration: () => ({
				workspaceId: this.settings.qwen.workspaceId,
				region: this.settings.qwen.region,
				model: this.settings.qwen.asrModel,
			}),
			getApiKey: () => this.settings.qwen.apiKey,
		});
		let modal: RealtimeAsrTransportAbModal;
		modal = new RealtimeAsrTransportAbModal(this.app, diagnostic, () => {
			this.openModals.delete(modal);
			if (this.realtimeAsrTransportAbModal === modal) {
				this.realtimeAsrTransportAbModal = null;
			}
		});
		this.realtimeAsrTransportAbModal = modal;
		this.openModals.add(modal);
		modal.open();
	}

	private async startRealtimeAsrSession(): Promise<void> {
		const controller = this.realtimeAsrSessionController;
		if (!controller) return;
		const result = await controller.start();
		if (result === 'configuration-error') {
			new Notice('实时转写未启动：请先配置 Qwen API key、Workspace ID 和实时转写模型。');
		}
	}

	private async stopRealtimeAsrSession(): Promise<void> {
		await this.realtimeAsrSessionController?.stop();
	}

	private handleClassroomSessionStartFailure(
		result: Exclude<ReturnType<ClassroomSessionController<TFile>['start']>, 'started'>,
	): void {
		if (result === 'unsupported-platform') {
			new Notice(mobileScreenshotUnsupportedMessage());
			return;
		}
		if (result === 'unsupported') {
			return;
		}
		if (result === 'busy') {
			new Notice('课堂监听已经在进行，或其他写入流程尚未结束。');
			return;
		}
		new Notice('请先打开一篇课堂笔记，再启动课堂监听。');
	}

	onBackgroundScreenshotStateChange(
		listener: (state: ScreenshotBackgroundState) => void,
	): () => void {
		return this.classroomSessionController?.subscribe(listener) ?? (() => undefined);
	}

	private getAudioCompanionClassroomContext(): {
		sessionId: string;
		startedAtUnixMs: number;
	} | null {
		const state = this.classroomSessionController?.getState();
		if (state?.status !== 'listening' || !state.sessionId || !state.startedAt) {
			return null;
		}
		return {
			sessionId: state.sessionId,
			startedAtUnixMs: state.startedAt.getTime(),
		};
	}

	private resolveTranscriptTargetFile(): TFile | null {
		const state = this.classroomSessionController?.getState();
		if (state?.status !== 'listening' || !state.targetPath) return null;
		const file = this.app.vault.getAbstractFileByPath(state.targetPath);
		if (file instanceof TFile) return file;
		return null;
	}

	private initializeScreenshotBackgroundSession(): void {
		this.screenshotBackgroundService = new ObsidianBackgroundScreenshotService(this.app);
		this.screenshotStatusBarEl = this.addStatusBarItem();
		this.screenshotStatusBarEl.addClass('is-hidden');
		this.registerDomEvent(this.screenshotStatusBarEl, 'click', () => {
			void this.stopBackgroundScreenshotSession();
		});
		const screenshotSession = new ScreenshotBackgroundSession<TFile>({
			isDesktopApp: () => Platform.isDesktopApp,
			isConflictingWorkflowActive: () => this.aiWorkflowGate.state !== 'idle',
			createClipboardAdapter: () => createElectronClipboardAdapter({
				isDesktopApp: Platform.isDesktopApp,
			}),
			createSessionId: (startedAt) => buildClassroomSessionId(startedAt),
			filePath: (file) => file.path,
			fileName: (file) => file.basename,
			isTargetFileAvailable: (file) =>
				file.extension === 'md'
				&& this.app.vault.getAbstractFileByPath(file.path) === file,
			now: () => new Date(),
			setInterval: (callback, intervalMs) => window.setInterval(callback, intervalMs),
			clearInterval: (intervalId) => window.clearInterval(intervalId),
			processScreenshot: (capture) => {
				const service = this.screenshotBackgroundService;
				if (!service) {
					return Promise.resolve({
						status: 'failed' as const,
						error: '后台课堂截图服务不可用。',
					});
				}
				return service.process(capture);
			},
			onEventResult: (event) => this.handleScreenshotEventResult(event),
			onStopped: (reason) => {
				if (reason === 'target-deleted') {
					new Notice('目标课堂笔记已被删除，后台截图监听已停止。');
				} else if (reason === 'capability-failed') {
					new Notice(backgroundScreenshotUnsupportedMessage());
				}
			},
		});
		this.classroomSessionController = new ClassroomSessionController(screenshotSession);
		this.unsubscribeScreenshotState = this.classroomSessionController.subscribe(
			(state) => this.updateScreenshotStatusBar(state),
		);
		this.registerEvent(this.app.vault.on('delete', (file) => {
			if (file instanceof TFile) {
				this.classroomSessionController?.handleTargetDeleted(file);
			}
		}));
		this.registerEvent(this.app.vault.on('rename', (file) => {
			if (file instanceof TFile) {
				this.classroomSessionController?.handleTargetRenamed(file);
			}
		}));
	}

	private updateScreenshotStatusBar(state: ScreenshotBackgroundState): void {
		const statusBar = this.screenshotStatusBarEl;
		if (!statusBar) {
			return;
		}
		if (state.status !== 'listening' || !state.targetName) {
			statusBar.empty();
			statusBar.addClass('is-hidden');
			return;
		}
		statusBar.removeClass('is-hidden');
		statusBar.setText(
			`课堂监听中 · ${state.targetName} · 已保存 ${state.savedCount} 张`,
		);
		statusBar.setAttr('aria-label', '点击停止后台课堂截图监听');
	}

	private handleScreenshotEventResult(event: ClassroomScreenshotEvent): void {
		if (!event.error) {
			return;
		}
		if (event.savedPath) {
			new Notice(`截图已保存，但写入课堂时间线失败：${event.savedPath}。${event.error}`);
			return;
		}
		new Notice(`课堂截图保存失败：${event.error}`);
	}

	private showRibbonMenu(event: MouseEvent): void {
		const menu = new Menu();
		const classroomState = this.getBackgroundScreenshotState();
		const isListening = classroomState.status === 'listening';
		menu.addItem((item) =>
			item
				.setTitle(classroomSessionMenuTitle(classroomState))
				.setIcon(isListening ? 'circle-stop' : 'radio-tower')
				.onClick(() => this.toggleClassroomListening()),
		);
		menu.addItem((item) =>
			item
				.setTitle('打开课堂工作台')
				.setIcon('panel-right')
				.onClick(() => this.openClassroomWorkbench()),
		);
		menu.addItem((item) =>
			item
				.setTitle('创建课堂笔记')
				.setIcon('file-plus-2')
				.onClick(() => this.openCreateLectureNoteModal()),
		);
		menu.addItem((item) =>
			item
				.setTitle('AI 整理当前笔记')
				.setIcon('wand-sparkles')
				.onClick(() => this.runAiWorkflow()),
		);
		menu.showAtMouseEvent(event);
	}

	private registerClassroomWorkbenchView(): void {
		this.registerView(CLASSROOM_WORKBENCH_VIEW_TYPE, (leaf) => {
			const audioProbe = this.audioCaptureProbe;
			const audioCompanion = this.audioCompanionSessionController;
			const realtimeAsr = this.realtimeAsrSessionController;
			if (!audioProbe || !audioCompanion || !realtimeAsr) {
				throw new Error('Audio runtime is not initialized.');
			}
			return new ClassroomWorkbenchView(leaf, {
				getClassroomState: () => this.getBackgroundScreenshotState(),
				subscribeClassroom: (listener) =>
					this.onBackgroundScreenshotStateChange(listener),
				startClassroom: () => this.startBackgroundScreenshotSession(),
				stopClassroom: () => this.stopBackgroundScreenshotSession(),
				startSystemAudio: () => this.startAudioCompanionSession(),
				stopSystemAudio: () => this.stopAudioCompanionSession(),
				startRealtimeAsr: () => this.startRealtimeAsrSession(),
				stopRealtimeAsr: () => this.stopRealtimeAsrSession(),
				getDismissMode: () => getClassroomWorkbenchDismissMode(
					this.app.workspace.rightSplit,
				),
				dismissWorkbench: () => dismissClassroomWorkbench(
					this.app.workspace.rightSplit,
					leaf,
				),
			}, audioProbe, audioCompanion, realtimeAsr);
		});
	}

	private async openClassroomWorkbench(): Promise<void> {
		try {
			const opener = this.classroomWorkbenchOpener;
			if (!opener) {
				throw new ClassroomWorkbenchOpenError('create-leaf');
			}
			await opener.open();
		} catch (error) {
			const stage = error instanceof ClassroomWorkbenchOpenError
				? error.stage
				: 'unknown';
			console.error('Lecture Workflow: classroom workbench open failed', {
				type: safeErrorType(error),
				stage,
			});
			new Notice('无法打开课堂工作台，请重新加载插件后重试。');
		}
	}

	private async runAiWorkflow(): Promise<void> {
		if (this.classroomSessionController?.getState().status === 'listening') {
			new Notice('后台课堂截图监听中，请先结束截图监听。');
			return;
		}
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== 'md') {
			new Notice('请先打开一篇 Markdown 课堂笔记。');
			return;
		}
		if (!this.aiWorkflowGate.beginGeneration()) {
			new Notice('AI 整理正在进行，请勿重复提交。');
			return;
		}
		const progress = this.progressNotices.start(
			'ai-workflow',
			'正在读取课堂笔记…',
		);

		const registry = this.createProviderRegistry();
		const service = new AiWorkflowService(this.app, registry);
		let snapshot: AiGenerationSnapshot;
		try {
			snapshot = await service.prepare(file);
		} catch (error) {
			this.aiWorkflowGate.reset();
			const message = error instanceof Error ? error.message : String(error);
			progress.failure(`AI 整理失败：${message}`);
			progress.finishIfPending();
			return;
		}
		const route = decideVisionWorkflowRoute(
			snapshot.imageReferences.length,
			this.settings.enableVisionInput,
		);
		if (route === 'text-only') {
			await this.performGeneration(
				snapshot,
				service,
				registry,
				registry.getActiveTextProviderId(),
				progress,
			);
			return;
		}
		if (route === 'offer-text-only') {
			progress.success('课堂笔记读取完成，等待选择整理方式。');
			this.openVisionDisabledChoice(snapshot, service, registry);
			return;
		}
		await this.prepareVisionConfirmation(
			snapshot,
			service,
			registry,
			this.settings.visionProvider,
			false,
			progress,
		);
	}

	private openVisionDisabledChoice(
		snapshot: AiGenerationSnapshot,
		service: AiWorkflowService,
		registry: ProviderRegistry,
	): void {
		let modal: VisionDisabledChoiceModal;
		modal = new VisionDisabledChoiceModal(
			this.app,
			snapshot.imageReferences.length,
			() => {
				void this.performGeneration(
					snapshot,
					service,
					registry,
					registry.getActiveTextProviderId(),
				);
			},
			(selectedTextOnly) => {
				this.openModals.delete(modal);
				if (!selectedTextOnly) {
					this.aiWorkflowGate.reset();
				}
			},
		);
		this.openModals.add(modal);
		modal.open();
	}

	private async prepareVisionConfirmation(
		snapshot: AiGenerationSnapshot,
		service: AiWorkflowService,
		registry: ProviderRegistry,
		providerId: VisionProviderId,
		isRetry: boolean,
		progress: ProgressNoticeLease,
	): Promise<void> {
		let prepared: VisionGenerationSnapshot | null = null;
		progress.update('正在读取并检查课堂图片…');
		try {
			const provider = registry.getVisionProviderForConfirmedRetry(providerId);
			const validation = provider.validateVision();
			if (validation.length > 0) {
				throw new ProviderError(validation.join(' '), 'configuration');
			}
			prepared = await service.prepareVision(snapshot, this.settings.maxVisionImages);
			const summary = {
				imageCount: prepared.resolvedImages.length,
				totalBytes: prepared.resolvedImages.reduce((total, image) => total + image.byteLength, 0),
				vaultPaths: prepared.resolvedImages.map((image) => image.vaultPath),
				visionProviderId: providerId,
				visionProviderName: provider.displayName,
				model: providerId === 'qwen'
					? this.settings.qwen.visionModel
					: this.settings.customOpenAI.model,
				textProviderId: registry.getActiveTextProviderId(),
				isRetry,
			};
			progress.success('课堂图片准备完成，等待确认。');
			this.openVisionConfirmation(summary, prepared, snapshot, service, registry, providerId);
		} catch (error) {
			if (prepared) {
				service.disposeVisionSnapshot(prepared);
			}
			this.aiWorkflowGate.reset();
			if (error instanceof ProviderError) {
				const failure = describeProviderFailure(
					providerId === 'qwen' ? 'Qwen-VL' : 'Custom Vision',
					error,
				);
				progress.failure(`图片整理准备失败：${failure.message}`);
				return;
			}
			const message = error instanceof Error ? error.message : '未知错误。';
			progress.failure(`图片整理准备失败：${message}`);
		} finally {
			progress.finishIfPending();
		}
	}

	private openVisionConfirmation(
		summary: ConstructorParameters<typeof VisionConfirmationModal>[1],
		prepared: VisionGenerationSnapshot,
		baseSnapshot: AiGenerationSnapshot,
		service: AiWorkflowService,
		registry: ProviderRegistry,
		providerId: VisionProviderId,
	): void {
		let modal: VisionConfirmationModal;
		modal = new VisionConfirmationModal(
			this.app,
			summary,
			() => {
				void this.performVisionGeneration(
					prepared,
					baseSnapshot,
					service,
					registry,
					providerId,
				);
			},
			(confirmed) => {
				this.openModals.delete(modal);
				if (!confirmed) {
					service.disposeVisionSnapshot(prepared);
					this.aiWorkflowGate.reset();
				}
			},
		);
		this.openModals.add(modal);
		modal.open();
	}

	private async startGenerationFromSnapshot(
		snapshot: AiGenerationSnapshot,
		service: AiWorkflowService,
		registry: ProviderRegistry,
		providerId: TextProviderId,
	): Promise<void> {
		if (this.classroomSessionController?.getState().status === 'listening') {
			new Notice('后台课堂截图监听中，请先结束截图监听。');
			return;
		}
		if (!this.aiWorkflowGate.beginGeneration()) {
			new Notice('AI 整理正在进行，请勿重复提交。');
			return;
		}
		await this.performGeneration(snapshot, service, registry, providerId);
	}

	private async performGeneration(
		snapshot: AiGenerationSnapshot,
		service: AiWorkflowService,
		registry: ProviderRegistry,
		providerId: TextProviderId,
		progress = this.progressNotices.start(
			'ai-workflow',
			'正在生成 AI 结构化笔记…',
		),
	): Promise<void> {
		try {
			const provider = registry.getTextProvider(providerId);
			progress.update(`正在使用 ${provider.displayName} 生成 AI 结构化笔记…`);
			const preview = await this.aiWorkflowGate.completeWithPreview(
				() => service.generate(snapshot, providerId),
			);
			if (!preview.isComplete) {
				progress.failure('AI 结果不完整，已禁止写入；可在预览中复制或重新生成。');
			} else {
				progress.success('AI 结构化笔记生成完成，请在预览中确认。');
			}
			this.openAiPreview(preview, snapshot, service, registry);
		} catch (error) {
			this.aiWorkflowGate.reset();
			this.handleGenerationFailure(
				error,
				snapshot,
				service,
				registry,
				providerId,
				progress,
			);
		} finally {
			progress.finishIfPending();
		}
	}

	private async performVisionGeneration(
		prepared: VisionGenerationSnapshot,
		baseSnapshot: AiGenerationSnapshot,
		service: AiWorkflowService,
		registry: ProviderRegistry,
		providerId: VisionProviderId,
	): Promise<void> {
		const controller = new AbortController();
		this.activeVisionAbortController = controller;
		const progress = this.progressNotices.start(
			'ai-workflow',
			'正在准备视觉 AI 整理…',
		);
		try {
			const provider = registry.getVisionProviderForConfirmedRetry(providerId);
			progress.update(`正在使用 ${provider.displayName} 同时整理文字稿和课堂图片…`);
			const preview = await this.aiWorkflowGate.completeWithPreview(
				() => service.generateVision(prepared, providerId, controller.signal),
			);
			if (!shouldAcceptVisionResult(controller.signal)) {
				this.aiWorkflowGate.reset();
				progress.cancel('视觉 AI 整理已取消。');
				return;
			}
			if (!preview.isComplete) {
				progress.failure('视觉 AI 结果不完整，已禁止写入；可在预览中复制或重新生成。');
			} else {
				progress.success('视觉 AI 整理完成，请在预览中确认。');
			}
			this.openAiPreview(preview, baseSnapshot, service, registry);
		} catch (error) {
			this.aiWorkflowGate.reset();
			if (!controller.signal.aborted) {
				this.handleVisionGenerationFailure(
					error,
					baseSnapshot,
					service,
					registry,
					providerId,
					progress,
				);
			} else {
				progress.cancel('视觉 AI 整理已取消。');
			}
		} finally {
			service.disposeVisionSnapshot(prepared);
			if (this.activeVisionAbortController === controller) {
				this.activeVisionAbortController = null;
			}
			progress.finishIfPending();
		}
	}

	private handleVisionGenerationFailure(
		error: unknown,
		snapshot: AiGenerationSnapshot,
		service: AiWorkflowService,
		registry: ProviderRegistry,
		providerId: VisionProviderId,
		progress: ProgressNoticeLease,
	): void {
		if (isVisionWorkflowConflictError(error)) {
			progress.failure(error.message);
			return;
		}
		if (!(error instanceof ProviderError)) {
			progress.failure('视觉 AI 整理失败：发生未知错误，请稍后重试。');
			return;
		}
		const providerName = providerId === 'qwen' ? 'Qwen-VL' : 'Custom Vision';
		const failure = describeProviderFailure(providerName, error);
		progress.failure(`视觉 AI 整理失败：${failure.message}`);
		if (!failure.isRetryableConnectionFailure) {
			return;
		}
		let qwenConfigured = false;
		try {
			qwenConfigured = registry
				.getVisionProviderForConfirmedRetry('qwen')
				.validateVision()
				.length === 0;
		} catch {
			qwenConfigured = false;
		}
		this.openVisionRetryModal(
			failure.message,
			buildVisionRetryOptions(providerId, qwenConfigured),
			snapshot,
			service,
			registry,
		);
	}

	private openVisionRetryModal(
		failureMessage: string,
		options: ReturnType<typeof buildVisionRetryOptions>,
		snapshot: AiGenerationSnapshot,
		service: AiWorkflowService,
		registry: ProviderRegistry,
	): void {
		let modal: AiRetryModal;
		modal = new AiRetryModal(
			this.app,
			failureMessage,
			options,
			(providerId) => {
				if (providerId === 'qwen' || providerId === 'custom') {
					void this.startVisionRetry(snapshot, service, registry, providerId);
				}
			},
			() => this.openModals.delete(modal),
		);
		this.openModals.add(modal);
		modal.open();
	}

	private async startVisionRetry(
		snapshot: AiGenerationSnapshot,
		service: AiWorkflowService,
		registry: ProviderRegistry,
		providerId: VisionProviderId,
	): Promise<void> {
		if (this.classroomSessionController?.getState().status === 'listening') {
			new Notice('后台课堂截图监听中，请先结束截图监听。');
			return;
		}
		if (!this.aiWorkflowGate.beginGeneration()) {
			new Notice('AI 整理正在进行，请勿重复提交。');
			return;
		}
		const progress = this.progressNotices.start(
			'ai-workflow',
			'正在准备课堂图片整理…',
		);
		await this.prepareVisionConfirmation(
			snapshot,
			service,
			registry,
			providerId,
			true,
			progress,
		);
	}

	private handleGenerationFailure(
		error: unknown,
		snapshot: AiGenerationSnapshot,
		service: AiWorkflowService,
		registry: ProviderRegistry,
		providerId: TextProviderId,
		progress: ProgressNoticeLease,
	): void {
		if (!(error instanceof ProviderError)) {
			progress.failure('AI 整理失败：发生未知错误，请稍后重试。');
			return;
		}
		const providerName = registry.getTextProvider(providerId).displayName;
		const failure = describeProviderFailure(providerName, error);
		progress.failure(`AI 整理失败：${failure.message}`);
		if (providerId === 'deepseek' && failure.isRetryableConnectionFailure) {
			const qwenConfigured = registry.getTextProvider('qwen').validate().length === 0;
			this.openRetryModal(
				failure.message,
				buildRetryOptions(providerId, qwenConfigured),
				snapshot,
				service,
				registry,
			);
		}
	}

	private openRetryModal(
		failureMessage: string,
		options: ReturnType<typeof buildRetryOptions>,
		snapshot: AiGenerationSnapshot,
		service: AiWorkflowService,
		registry: ProviderRegistry,
	): void {
		let modal: AiRetryModal;
		modal = new AiRetryModal(
			this.app,
			failureMessage,
			options,
			(providerId) => {
				void this.startGenerationFromSnapshot(snapshot, service, registry, providerId);
			},
			() => this.openModals.delete(modal),
		);
		this.openModals.add(modal);
		modal.open();
	}

	private openAiPreview(
		preview: AiPreviewData,
		snapshot: AiGenerationSnapshot,
		service: AiWorkflowService,
		registry: ProviderRegistry,
	): void {
		let modal: AiPreviewModal;
		modal = new AiPreviewModal(
			this.app,
			preview,
			async (data) => {
				const progress = this.progressNotices.start(
					'ai-write',
					'正在检查并写入 AI 结构化笔记…',
				);
				try {
					await service.write(data);
					progress.success('AI 结构化笔记已写入。');
					return true;
				} catch (error) {
					if (isVisionWorkflowConflictError(error)) {
						progress.failure(VISION_WORKFLOW_CONFLICT_MESSAGE);
						return false;
					}
					if (isNoteConflictError(error)) {
						progress.failure(data.usesVision
							? VISION_WORKFLOW_CONFLICT_MESSAGE
							: NOTE_CONFLICT_MESSAGE);
						return false;
					}
					if (isNoteLatestReadError(error)) {
						progress.failure(data.usesVision
							? VISION_WORKFLOW_CONFLICT_MESSAGE
							: NOTE_LATEST_READ_FAILED_MESSAGE);
						return false;
					}
					progress.failure('写入 AI 结果失败，预览内容已保留。');
					return false;
				} finally {
					progress.finishIfPending();
				}
			},
			() => {
				if (preview.usesVision
					&& (preview.providerId === 'qwen' || preview.providerId === 'custom')) {
					void this.startVisionRetry(
						snapshot,
						service,
						registry,
						preview.providerId,
					);
				} else {
					void this.startGenerationFromSnapshot(
						snapshot,
						service,
						registry,
						preview.providerId,
					);
				}
			},
			() => {
				this.openModals.delete(modal);
				this.aiWorkflowGate.reset();
			},
		);
		this.openModals.add(modal);
		modal.open();
	}
}

function mobileScreenshotUnsupportedMessage(): string {
	return '课堂截图目前仅支持 Obsidian 桌面端。';
}

function backgroundScreenshotUnsupportedMessage(): string {
	return '当前 Obsidian 版本不支持后台剪贴板图片监听，请使用手动导入方式。';
}

function safeErrorType(error: unknown): string {
	if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name)) {
		return error.name;
	}
	return 'UnknownError';
}
