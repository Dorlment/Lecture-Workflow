import {
	ItemView,
	Notice,
	WorkspaceLeaf,
} from 'obsidian';

import type { AudioCaptureProbe } from './audio-capture-probe';
import type {
	AudioCompanionRuntimeControl,
	AudioCompanionRuntimeState,
} from './audio-companion-runtime-types';
import { audioCompanionRuntimeUiState } from './audio-companion-runtime-ui';
import { AudioCompanionWorkbenchBinding } from './audio-companion-workbench-binding';
import {
	realtimeAsrBooleanLabel,
	realtimeAsrInboundEventKindLabel,
	realtimeAsrOverflowReasonLabel,
	realtimeAsrPumpBlockReasonLabel,
	realtimeAsrRuntimeUiState,
} from './realtime-asr-runtime-ui';
import type {
	RealtimeAsrRuntimeControl,
	RealtimeAsrRuntimeState,
} from './realtime-asr-types';
import { RealtimeAsrWorkbenchBinding } from './realtime-asr-workbench-binding';
import type {
	AudioCaptureProbeState,
	AudioInputDeviceOption,
	SystemAudioCapabilityStatus,
} from './audio-capture-types';
import type { ClassroomWorkbenchDismissMode } from './classroom-workbench-dismiss';
import type { ScreenshotBackgroundState } from './screenshot-background-types';

export const CLASSROOM_WORKBENCH_VIEW_TYPE = 'lecture-workflow-classroom-workbench';

export interface ClassroomWorkbenchHost {
	getClassroomState(): ScreenshotBackgroundState;
	subscribeClassroom(
		listener: (state: ScreenshotBackgroundState) => void,
	): () => void;
	startClassroom(): void | Promise<void>;
	stopClassroom(): void | Promise<void>;
	startSystemAudio(): Promise<void>;
	stopSystemAudio(): Promise<void>;
	startRealtimeAsr(): Promise<void>;
	stopRealtimeAsr(): Promise<void>;
	getDismissMode(): ClassroomWorkbenchDismissMode;
	dismissWorkbench(): ClassroomWorkbenchDismissMode;
}

interface ClassroomWorkbenchUi {
	dismissButton: HTMLButtonElement;
	sessionSummaryPrimaryEl: HTMLElement;
	sessionSummarySecondaryEl: HTMLElement;
	targetEl: HTMLElement;
	statusEl: HTMLElement;
	sessionIdEl: HTMLElement;
	startedAtEl: HTMLElement;
	elapsedEl: HTMLElement;
	detectedCountEl: HTMLElement;
	savedCountEl: HTMLElement;
	insertedCountEl: HTMLElement;
	failedCountEl: HTMLElement;
	startButton: HTMLButtonElement;
	stopButton: HTMLButtonElement;
	microphoneSupportEl: HTMLElement;
	systemSupportEl: HTMLElement;
	systemExplanationEl: HTMLElement;
	audioSourceEl: HTMLElement;
	audioStatusEl: HTMLElement;
	inputDeviceSelectEl: HTMLSelectElement;
	inputDeviceStatusEl: HTMLElement;
	loopbackHintEl: HTMLElement;
	deviceLabelEl: HTMLElement;
	sampleRateEl: HTMLElement;
	channelCountEl: HTMLElement;
	trackStateEl: HTMLElement;
	mutedEl: HTMLElement;
	volumeEl: HTMLProgressElement;
	volumeTextEl: HTMLElement;
	errorEl: HTMLElement;
	refreshDevicesButton: HTMLButtonElement;
	testSelectedInputButton: HTMLButtonElement;
	systemAudioButton: HTMLButtonElement;
	stopAudioButton: HTMLButtonElement;
	audioCompanionStatusEl: HTMLElement;
	audioCompanionFrameCountEl: HTMLElement;
	audioCompanionRmsEl: HTMLProgressElement;
	audioCompanionRmsTextEl: HTMLElement;
	audioCompanionErrorEl: HTMLElement;
	startAudioCompanionButton: HTMLButtonElement;
	stopAudioCompanionButton: HTMLButtonElement;
	realtimeAsrStatusEl: HTMLElement;
	realtimeAsrPartialEl: HTMLElement;
	realtimeAsrFinalEl: HTMLElement;
	realtimeAsrDurationEl: HTMLElement;
	realtimeAsrErrorEl: HTMLElement;
	realtimeAsrDiagnosticsEls: {
		eventLoopLagCurrent: HTMLElement;
		eventLoopLagMax: HTMLElement;
		eventLoopLagP95: HTMLElement;
		providerStatePublishCount: HTMLElement;
		providerStatePublishRate: HTMLElement;
		sessionNotificationCount: HTMLElement;
		sessionNotificationRate: HTMLElement;
		workbenchRenderCount: HTMLElement;
		workbenchRenderRate: HTMLElement;
		workbenchLastRenderDuration: HTMLElement;
		workbenchMaxRenderDuration: HTMLElement;
		maxStateListenerDuration: HTMLElement;
		perMessageDeflateConfigured: HTMLElement;
		perMessageDeflateNegotiated: HTMLElement;
		produced: HTMLElement;
		sent: HTMLElement;
		queued: HTMLElement;
		inFlight: HTMLElement;
		outstanding: HTMLElement;
		maxOutstanding: HTMLElement;
		wsBuffered: HTMLElement;
		maxWsBuffered: HTMLElement;
		sendWriteLatency: HTMLElement;
		oldestInFlightAge: HTMLElement;
		maxObservedInFlightAge: HTMLElement;
		dispatchCount: HTMLElement;
		callbackSuccessCount: HTMLElement;
		callbackFailureCount: HTMLElement;
		callbackSettledCount: HTMLElement;
		overflowReason: HTMLElement;
		socketOpen: HTMLElement;
		taskStarted: HTMLElement;
		audioSendReady: HTMLElement;
		pumpActive: HTMLElement;
		pumpScheduled: HTMLElement;
		stopping: HTMLElement;
		lastPumpBlockReason: HTMLElement;
		socketEverOpened: HTMLElement;
		runTaskEverSent: HTMLElement;
		taskEverStarted: HTMLElement;
		firstAudioEverDispatched: HTMLElement;
		warmupQueued: HTMLElement;
		warmupDropped: HTMLElement;
		warmupDroppedDuration: HTMLElement;
		inboundMessageCount: HTMLElement;
		taskStartedEventCount: HTMLElement;
		resultGeneratedEventCount: HTMLElement;
		taskFailedEventCount: HTMLElement;
		taskFinishedEventCount: HTMLElement;
		ignoredHeartbeatCount: HTMLElement;
		unknownEventCount: HTMLElement;
		lastInboundEventKind: HTMLElement;
		lastInboundEventAge: HTMLElement;
		firstResultGeneratedLatency: HTMLElement;
		liveWallElapsed: HTMLElement;
		producedAudioDuration: HTMLElement;
		dispatchedAudioDuration: HTMLElement;
		currentDispatchLead: HTMLElement;
		maxDispatchLead: HTMLElement;
		minDispatchInterval: HTMLElement;
		averageDispatchInterval: HTMLElement;
		currentDeadlineLateness: HTMLElement;
		maxDeadlineLateness: HTMLElement;
		controlledRecoveryDispatchCount: HTMLElement;
		schedulerWakeupCount: HTMLElement;
		maxDispatchBurstCount: HTMLElement;
	};
	startRealtimeAsrButton: HTMLButtonElement;
	stopRealtimeAsrButton: HTMLButtonElement;
}

export class ClassroomWorkbenchView extends ItemView {
	private ui: ClassroomWorkbenchUi | null = null;
	private unsubscribeClassroom: (() => void) | null = null;
	private unsubscribeAudio: (() => void) | null = null;
	private audioCompanionBinding: AudioCompanionWorkbenchBinding | null = null;
	private realtimeAsrBinding: RealtimeAsrWorkbenchBinding | null = null;
	private elapsedTimer: number | null = null;
	private inputDeviceOptionsSignature = '';
	private lastDeviceUnavailableNotice: string | null = null;
	private lastClassroomState: ScreenshotBackgroundState | null = null;
	private lastAudioCompanionState: AudioCompanionRuntimeState | null = null;
	private lastRealtimeAsrState: RealtimeAsrRuntimeState | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly host: ClassroomWorkbenchHost,
		private readonly audioProbe: AudioCaptureProbe,
		private readonly audioCompanion: AudioCompanionRuntimeControl,
		private readonly realtimeAsr: RealtimeAsrRuntimeControl,
	) {
		super(leaf);
	}

	getViewType(): string {
		return CLASSROOM_WORKBENCH_VIEW_TYPE;
	}

	getDisplayText(): string {
		return '课堂工作台';
	}

	getIcon(): string {
		return 'panel-right';
	}

	async onOpen(): Promise<void> {
		this.renderOnce();
		this.unsubscribeClassroom = this.host.subscribeClassroom(
			(state) => this.applyClassroomState(state),
		);
		this.unsubscribeAudio = this.audioProbe.subscribe(
			(state) => this.applyAudioState(state),
		);
		this.audioCompanionBinding = new AudioCompanionWorkbenchBinding({
			readState: () => this.audioCompanion.state,
			subscribe: (listener) => this.audioCompanion.subscribe(listener),
			apply: (state) => this.applyAudioCompanionState(state),
			schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
			cancel: (timerId) => window.clearTimeout(timerId),
		});
		this.audioCompanionBinding.open();
		this.realtimeAsrBinding = new RealtimeAsrWorkbenchBinding({
			readState: () => this.realtimeAsr.state,
			subscribe: (listener) => this.realtimeAsr.subscribe(listener),
			apply: (state) => this.applyRealtimeAsrState(state),
			schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
			cancel: (timerId) => window.clearTimeout(timerId),
		});
		this.realtimeAsrBinding.open();
		this.applyClassroomState(this.host.getClassroomState());
		this.applyAudioState(this.audioProbe.state);
		this.startElapsedTimer();
		await this.audioProbe.refreshAudioInputDevices();
	}

	async onClose(): Promise<void> {
		this.unsubscribeClassroom?.();
		this.unsubscribeClassroom = null;
		this.unsubscribeAudio?.();
		this.unsubscribeAudio = null;
		this.audioCompanionBinding?.close();
		this.audioCompanionBinding = null;
		this.realtimeAsrBinding?.close();
		this.realtimeAsrBinding = null;
		this.stopElapsedTimer();
		await this.audioProbe.stop();
		this.inputDeviceOptionsSignature = '';
		this.lastDeviceUnavailableNotice = null;
		this.lastClassroomState = null;
		this.lastAudioCompanionState = null;
		this.lastRealtimeAsrState = null;
		this.ui = null;
		this.contentEl.empty();
	}

	private renderOnce(): void {
		this.contentEl.empty();
		this.contentEl.addClass('lecture-workflow-classroom-workbench');

		const header = this.contentEl.createDiv({
			cls: 'lecture-workflow-workbench-header',
		});
		header.createEl('h2', { text: '课堂工作台' });
		const dismissMode = this.host.getDismissMode();
		const dismissButton = this.createButton(
			header,
			dismissMode === 'collapse' ? '收起工作台' : '关闭工作台',
			async () => this.dismissWorkbench(),
		);
		dismissButton.addClass('lecture-workflow-workbench-dismiss');

		const summary = this.contentEl.createDiv({
			cls: 'lecture-workflow-workbench-summary',
		});
		const sessionSummaryPrimary = summary.createEl('p', {
			text: '未开始课堂监听',
			cls: 'lecture-workflow-workbench-summary-primary',
		});
		const sessionSummarySecondary = summary.createEl('p', {
			text: '已运行 00:00:00 · 截图 0 张',
			cls: 'lecture-workflow-workbench-summary-secondary',
		});

		const classroomCard = this.createCard('课堂监听');
		const classroomActions = classroomCard.createDiv({
			cls: 'lecture-workflow-workbench-actions lecture-workflow-workbench-actions-two',
		});
		const startButton = this.createButton(
			classroomActions,
			'开始课堂监听',
			() => this.host.startClassroom(),
		);
		const stopButton = this.createButton(
			classroomActions,
			'停止课堂监听',
			() => this.host.stopClassroom(),
		);
		classroomCard.createEl('p', {
			text: '与左侧菜单、命令面板、设置页和状态栏共享同一个课堂会话。',
			cls: 'lecture-workflow-workbench-help',
		});

		const classroomDetails = classroomCard.createEl('details', {
			cls: 'lecture-workflow-workbench-details',
		});
		classroomDetails.createEl('summary', { text: '详细状态' });
		const target = detailRow(classroomDetails, '目标笔记', 'is-path');
		const status = detailRow(classroomDetails, '当前状态');
		const sessionId = detailRow(classroomDetails, 'Session ID', 'is-session-id');
		const startedAt = detailRow(classroomDetails, '开始时间');
		const elapsed = detailRow(classroomDetails, '已运行时长');
		const detectedCount = detailRow(classroomDetails, '已检测截图');
		const savedCount = detailRow(classroomDetails, '已保存截图');
		const insertedCount = detailRow(classroomDetails, '已插入事件');
		const failedCount = detailRow(classroomDetails, '失败数量');

		const companionCard = this.createCard('系统音频助手');
		const audioCompanionStatus = summaryRow(companionCard, '当前状态');
		const companionDetails = companionCard.createEl('details', {
			cls: 'lecture-workflow-workbench-details',
		});
		companionDetails.createEl('summary', { text: '详细状态' });
		const audioCompanionFrameCount = summaryRow(companionDetails, '已处理帧数');
		const companionVolume = companionDetails.createDiv({
			cls: 'lecture-workflow-audio-volume',
		});
		const companionVolumeHeader = companionVolume.createDiv({
			cls: 'lecture-workflow-audio-volume-header',
		});
		companionVolumeHeader.createSpan({ text: '实时 RMS' });
		const audioCompanionRmsText = companionVolumeHeader.createSpan({ text: '0%' });
		const audioCompanionRms = companionVolume.createEl('progress');
		audioCompanionRms.max = 1;
		audioCompanionRms.value = 0;
		audioCompanionRms.setAttr('aria-label', '系统音频实时 RMS：0%');
		const audioCompanionError = companionCard.createEl('p', {
			text: '',
			cls: 'lecture-workflow-workbench-help lecture-workflow-workbench-error',
		});
		const companionActions = companionCard.createDiv({
			cls: 'lecture-workflow-workbench-actions lecture-workflow-workbench-actions-two',
		});
		const startAudioCompanionButton = this.createButton(
			companionActions,
			'启动系统音频',
			() => this.host.startSystemAudio(),
		);
		const stopAudioCompanionButton = this.createButton(
			companionActions,
			'停止系统音频',
			() => this.host.stopSystemAudio(),
		);
		companionCard.createEl('p', {
			text: '系统音频仅在本机实时处理，不保存、不上传、不转写。',
			cls: 'lecture-workflow-workbench-help',
		});

		const asrCard = this.createCard('实时转写');
		const realtimeAsrStatus = summaryRow(asrCard, '当前状态');
		const realtimeAsrPartial = summaryRow(asrCard, '当前识别');
		const realtimeAsrFinal = summaryRow(asrCard, '最近定稿');
		const asrOverviewDetails = asrCard.createEl('details', {
			cls: 'lecture-workflow-workbench-details',
		});
		asrOverviewDetails.createEl('summary', { text: '详细状态' });
		const realtimeAsrDuration = summaryRow(asrOverviewDetails, '已发送音频');
		const asrDetails = asrOverviewDetails.createEl('details', {
			cls: 'lecture-workflow-workbench-details',
		});
		asrDetails.createEl('summary', { text: '开发者诊断' });
		const realtimeAsrDiagnosticsEls = {
			eventLoopLagCurrent: summaryRow(asrDetails, '事件循环当前延迟'),
			eventLoopLagMax: summaryRow(asrDetails, '事件循环最大延迟'),
			eventLoopLagP95: summaryRow(asrDetails, '事件循环 P95 延迟'),
			providerStatePublishCount: summaryRow(asrDetails, 'Provider 状态发布数'),
			providerStatePublishRate: summaryRow(asrDetails, 'Provider 状态发布频率'),
			sessionNotificationCount: summaryRow(asrDetails, 'Session 通知数'),
			sessionNotificationRate: summaryRow(asrDetails, 'Session 通知频率'),
			workbenchRenderCount: summaryRow(asrDetails, 'Workbench 渲染数'),
			workbenchRenderRate: summaryRow(asrDetails, 'Workbench 渲染频率'),
			workbenchLastRenderDuration: summaryRow(asrDetails, 'Workbench 最近渲染耗时'),
			workbenchMaxRenderDuration: summaryRow(asrDetails, 'Workbench 最大渲染耗时'),
			maxStateListenerDuration: summaryRow(asrDetails, '状态监听最大耗时'),
			perMessageDeflateConfigured: summaryRow(asrDetails, 'permessage-deflate 配置'),
			perMessageDeflateNegotiated: summaryRow(asrDetails, 'permessage-deflate 已协商'),
			produced: summaryRow(asrDetails, '已生成块'),
			sent: summaryRow(asrDetails, '已发送块'),
			queued: summaryRow(asrDetails, '排队块'),
			inFlight: summaryRow(asrDetails, '待回调发送'),
			outstanding: summaryRow(asrDetails, '未结算块'),
			maxOutstanding: summaryRow(asrDetails, '最大未结算块'),
			wsBuffered: summaryRow(asrDetails, 'WebSocket 缓冲字节'),
			maxWsBuffered: summaryRow(asrDetails, '最大 WebSocket 缓冲'),
			sendWriteLatency: summaryRow(asrDetails, '本地写出延迟'),
			oldestInFlightAge: summaryRow(asrDetails, '最老 inFlight 年龄'),
			maxObservedInFlightAge: summaryRow(asrDetails, '历史最大 inFlight 年龄'),
			dispatchCount: summaryRow(asrDetails, '已 dispatch 块'),
			callbackSuccessCount: summaryRow(asrDetails, 'Callback 成功'),
			callbackFailureCount: summaryRow(asrDetails, 'Callback 失败'),
			callbackSettledCount: summaryRow(asrDetails, 'Callback 已结算'),
			overflowReason: summaryRow(asrDetails, '缓冲溢出原因'),
			socketOpen: summaryRow(asrDetails, 'Socket 已打开'),
			taskStarted: summaryRow(asrDetails, 'Task 已启动'),
			audioSendReady: summaryRow(asrDetails, '音频发送就绪'),
			pumpActive: summaryRow(asrDetails, 'Pump 运行中'),
			pumpScheduled: summaryRow(asrDetails, 'Pump 待运行'),
			stopping: summaryRow(asrDetails, '正在停止'),
			lastPumpBlockReason: summaryRow(asrDetails, 'Pump 阻断原因'),
			socketEverOpened: summaryRow(asrDetails, 'Socket 曾打开'),
			runTaskEverSent: summaryRow(asrDetails, 'run-task 曾发送'),
			taskEverStarted: summaryRow(asrDetails, 'Task 曾启动'),
			firstAudioEverDispatched: summaryRow(asrDetails, '首个音频曾发送'),
			warmupQueued: summaryRow(asrDetails, 'Warm-up 当前块数'),
			warmupDropped: summaryRow(asrDetails, 'Warm-up 已丢弃块数'),
			warmupDroppedDuration: summaryRow(asrDetails, 'Warm-up 已丢弃时长'),
			inboundMessageCount: summaryRow(asrDetails, '入站消息数'),
			taskStartedEventCount: summaryRow(asrDetails, 'task-started 数'),
			resultGeneratedEventCount: summaryRow(asrDetails, 'result-generated 数'),
			taskFailedEventCount: summaryRow(asrDetails, 'task-failed 数'),
			taskFinishedEventCount: summaryRow(asrDetails, 'task-finished 数'),
			ignoredHeartbeatCount: summaryRow(asrDetails, '已忽略心跳数'),
			unknownEventCount: summaryRow(asrDetails, '未知事件数'),
			lastInboundEventKind: summaryRow(asrDetails, '最近入站事件'),
			lastInboundEventAge: summaryRow(asrDetails, '最近入站事件年龄'),
			firstResultGeneratedLatency: summaryRow(asrDetails, '首个结果延迟'),
			liveWallElapsed: summaryRow(asrDetails, 'Live 墙钟时长'),
			producedAudioDuration: summaryRow(asrDetails, '已生成 Live 音频'),
			dispatchedAudioDuration: summaryRow(asrDetails, '已 Dispatch 音频'),
			currentDispatchLead: summaryRow(asrDetails, '当前 Dispatch 超前'),
			maxDispatchLead: summaryRow(asrDetails, '最大 Dispatch 超前'),
			minDispatchInterval: summaryRow(asrDetails, '实际最小 Dispatch 间隔'),
			averageDispatchInterval: summaryRow(asrDetails, '平均 Dispatch 间隔'),
			currentDeadlineLateness: summaryRow(asrDetails, '当前 Deadline 迟到'),
			maxDeadlineLateness: summaryRow(asrDetails, '最大 Deadline 迟到'),
			controlledRecoveryDispatchCount: summaryRow(asrDetails, '受控回正 Dispatch 数'),
			schedulerWakeupCount: summaryRow(asrDetails, '调度器唤醒数'),
			maxDispatchBurstCount: summaryRow(asrDetails, '最大 Dispatch 突发数'),
		};
		const realtimeAsrError = asrCard.createEl('p', {
			text: '',
			cls: 'lecture-workflow-workbench-help lecture-workflow-workbench-error',
		});
		const asrActions = asrCard.createDiv({
			cls: 'lecture-workflow-workbench-actions lecture-workflow-workbench-actions-two',
		});
		const startRealtimeAsrButton = this.createButton(
			asrActions,
			'启动实时转写',
			() => this.host.startRealtimeAsr(),
		);
		const stopRealtimeAsrButton = this.createButton(
			asrActions,
			'停止实时转写',
			() => this.host.stopRealtimeAsr(),
		);
		asrCard.createEl('p', {
			text: '实时识别的定稿会自动追加到当前课堂笔记的「原始文字稿」，插件不保存录音。',
			cls: 'lecture-workflow-workbench-help',
		});

		const audioCard = this.createCard('音频输入测试');
		audioCard.createEl('p', {
			text: '本阶段只检测音频，不会保存、上传或转写声音。请选择麦克风、立体声混音或其他输入设备。',
			cls: 'lecture-workflow-audio-privacy',
		});
		const audioSource = summaryRow(audioCard, '当前来源');
		const audioStatus = summaryRow(audioCard, '当前状态');

		const inputDeviceField = audioCard.createEl('label', {
			cls: 'lecture-workflow-audio-input-field',
		});
		inputDeviceField.createSpan({ text: '音频输入设备' });
		const inputDeviceSelect = inputDeviceField.createEl('select');
		this.registerDomEvent(inputDeviceSelect, 'change', async () => {
			await this.audioProbe.selectInputDevice(inputDeviceSelect.value || null);
		});
		const inputDeviceStatus = audioCard.createEl('p', {
			text: '尚未刷新设备列表。',
			cls: 'lecture-workflow-workbench-help',
		});
		const loopbackHint = audioCard.createEl('p', {
			text: '',
			cls: 'lecture-workflow-workbench-help',
		});

		const volumeContainer = audioCard.createDiv({
			cls: 'lecture-workflow-audio-volume',
		});
		const volumeHeader = volumeContainer.createDiv({
			cls: 'lecture-workflow-audio-volume-header',
		});
		volumeHeader.createSpan({ text: '实时音量' });
		const volumeText = volumeHeader.createSpan({ text: '0%' });
		const volume = volumeContainer.createEl('progress');
		volume.max = 1;
		volume.value = 0;
		volume.setAttr('aria-label', '实时音量：0%');

		const audioActions = audioCard.createDiv({
			cls: 'lecture-workflow-workbench-actions lecture-workflow-workbench-audio-actions',
		});
		const refreshDevicesButton = this.createButton(
			audioActions,
			'刷新设备',
			async () => {
				await this.audioProbe.refreshAudioInputDevices();
			},
		);
		const testSelectedInputButton = this.createButton(
			audioActions,
			'测试所选设备',
			async () => {
				await this.audioProbe.start('microphone');
			},
		);
		const stopAudioButton = this.createButton(
			audioActions,
			'停止音频测试',
			async () => {
				await this.audioProbe.stop();
			},
		);
		stopAudioButton.addClass('lecture-workflow-workbench-stop-audio');

		const systemAudioSection = audioCard.createDiv({
			cls: 'lecture-workflow-system-audio-capability',
		});
		systemAudioSection.createEl('h4', { text: '直接系统音频能力' });
		const systemSupport = summaryRow(systemAudioSection, '能力状态');
		const systemExplanation = systemAudioSection.createEl('p', {
			text: '接口状态尚未检查。',
			cls: 'lecture-workflow-workbench-help',
		});
		const systemAudioButton = this.createButton(
			systemAudioSection,
			'测试直接系统音频',
			async () => {
				await this.audioProbe.start('system-audio');
			},
		);

		const audioDetails = audioCard.createEl('details', {
			cls: 'lecture-workflow-workbench-details',
		});
		audioDetails.createEl('summary', { text: '音频详细信息' });
		const microphoneSupport = detailRow(audioDetails, '麦克风支持');
		const deviceLabel = detailRow(audioDetails, '当前设备名称', 'is-path');
		const sampleRate = detailRow(audioDetails, 'Sample rate');
		const channelCount = detailRow(audioDetails, 'Channel count');
		const trackState = detailRow(audioDetails, 'Track readyState');
		const muted = detailRow(audioDetails, '是否静音');
		const error = detailRow(audioDetails, '最近安全错误', 'is-error');

		this.ui = {
			dismissButton,
			sessionSummaryPrimaryEl: sessionSummaryPrimary,
			sessionSummarySecondaryEl: sessionSummarySecondary,
			targetEl: target,
			statusEl: status,
			sessionIdEl: sessionId,
			startedAtEl: startedAt,
			elapsedEl: elapsed,
			detectedCountEl: detectedCount,
			savedCountEl: savedCount,
			insertedCountEl: insertedCount,
			failedCountEl: failedCount,
			startButton,
			stopButton,
			microphoneSupportEl: microphoneSupport,
			systemSupportEl: systemSupport,
			systemExplanationEl: systemExplanation,
			audioSourceEl: audioSource,
			audioStatusEl: audioStatus,
			inputDeviceSelectEl: inputDeviceSelect,
			inputDeviceStatusEl: inputDeviceStatus,
			loopbackHintEl: loopbackHint,
			deviceLabelEl: deviceLabel,
			sampleRateEl: sampleRate,
			channelCountEl: channelCount,
			trackStateEl: trackState,
			mutedEl: muted,
			volumeEl: volume,
			volumeTextEl: volumeText,
			errorEl: error,
			refreshDevicesButton,
			testSelectedInputButton,
			systemAudioButton,
			stopAudioButton,
			audioCompanionStatusEl: audioCompanionStatus,
			audioCompanionFrameCountEl: audioCompanionFrameCount,
			audioCompanionRmsEl: audioCompanionRms,
			audioCompanionRmsTextEl: audioCompanionRmsText,
			audioCompanionErrorEl: audioCompanionError,
			startAudioCompanionButton,
			stopAudioCompanionButton,
			realtimeAsrStatusEl: realtimeAsrStatus,
			realtimeAsrPartialEl: realtimeAsrPartial,
			realtimeAsrFinalEl: realtimeAsrFinal,
			realtimeAsrDurationEl: realtimeAsrDuration,
			realtimeAsrErrorEl: realtimeAsrError,
			realtimeAsrDiagnosticsEls,
			startRealtimeAsrButton,
			stopRealtimeAsrButton,
		};
	}

	private createCard(title: string): HTMLElement {
		const card = this.contentEl.createDiv({
			cls: 'lecture-workflow-workbench-card',
		});
		card.createEl('h3', { text: title });
		return card;
	}

	private createButton(
		container: HTMLElement,
		text: string,
		onClick: () => void | Promise<unknown>,
	): HTMLButtonElement {
		const button = container.createEl('button', { text });
		this.registerDomEvent(button, 'click', async () => {
			await onClick();
		});
		return button;
	}

	private async dismissWorkbench(): Promise<void> {
		try {
			await this.audioProbe.stop();
			this.host.dismissWorkbench();
		} catch (error) {
			console.error('Lecture Workflow: classroom workbench dismiss failed', {
				type: safeErrorType(error),
			});
			new Notice('无法收起课堂工作台，请使用 Obsidian 右侧边栏按钮。');
		}
	}

	private applyClassroomState(state: ScreenshotBackgroundState): void {
		this.lastClassroomState = state;
		const ui = this.ui;
		if (!ui) {
			return;
		}
		const targetPath = state.targetPath ?? '未选择';
		const targetName = state.targetName ?? targetPath;
		ui.targetEl.setText(targetPath);
		ui.targetEl.setAttr('title', targetPath);
		ui.statusEl.setText(classroomStatusLabel(state));
		ui.sessionIdEl.setText(state.sessionId ?? '无');
		ui.sessionIdEl.setAttr('title', state.sessionId ?? '');
		ui.startedAtEl.setText(state.startedAt?.toLocaleString() ?? '未开始');
		ui.elapsedEl.setText(formatClassroomElapsed(state));
		ui.detectedCountEl.setText(`${state.detectedCount} 张`);
		ui.savedCountEl.setText(`${state.savedCount} 张`);
		ui.insertedCountEl.setText(`${state.insertedCount} 条`);
		ui.failedCountEl.setText(`${state.failedCount} 条`);
		if (state.status === 'listening') {
			ui.sessionSummaryPrimaryEl.setText(`正在监听 · ${targetName}`);
			ui.sessionSummaryPrimaryEl.setAttr('title', targetPath);
		} else {
			ui.sessionSummaryPrimaryEl.setText('未开始课堂监听');
			ui.sessionSummaryPrimaryEl.removeAttribute('title');
		}
		this.updateSessionSummarySecondary(state);
		ui.startButton.disabled = state.status === 'listening';
		ui.stopButton.disabled = state.status !== 'listening';
		if (this.lastAudioCompanionState) {
			this.applyAudioCompanionState(this.lastAudioCompanionState);
		}
	}

	private applyAudioState(state: AudioCaptureProbeState): void {
		const ui = this.ui;
		if (!ui) {
			return;
		}
		const capabilities = this.audioProbe.getCapabilities();
		ui.microphoneSupportEl.setText(capabilities.microphone ? '支持' : '不支持');
		ui.systemSupportEl.setText(systemAudioCapabilityLabel(
			capabilities.systemAudioStatus,
		));
		ui.systemExplanationEl.setText(systemAudioCapabilityExplanation(
			capabilities.systemAudioStatus,
		));
		ui.audioSourceEl.setText(audioSourceLabel(state));
		ui.audioStatusEl.setText(audioStatusLabel(state));
		this.updateAudioInputOptions(ui.inputDeviceSelectEl, state.inputDevices);
		ui.inputDeviceSelectEl.value = state.selectedInputDeviceId ?? '';
		ui.inputDeviceStatusEl.setText(audioInputDeviceStatusLabel(state));
		ui.loopbackHintEl.setText(loopbackDeviceHint(state.inputDevices));
		ui.deviceLabelEl.setText(state.deviceLabel ?? '未提供');
		ui.deviceLabelEl.setAttr('title', state.deviceLabel ?? '');
		ui.sampleRateEl.setText(state.sampleRate ? `${state.sampleRate} Hz` : '未知');
		ui.channelCountEl.setText(state.channelCount ? String(state.channelCount) : '未知');
		ui.trackStateEl.setText(state.trackReadyState ?? '无');
		ui.mutedEl.setText(state.muted === null ? '未知' : state.muted ? '是' : '否');
		ui.volumeEl.value = state.volume;
		const percentage = Math.round(state.volume * 100);
		ui.volumeTextEl.setText(`${percentage}%`);
		ui.volumeEl.setAttr('aria-label', `实时音量：${percentage}%`);
		ui.errorEl.setText(state.errorMessage ?? '无');
		const requesting = state.status === 'requesting-permission'
			|| state.status === 'stopping';
		ui.inputDeviceSelectEl.disabled = requesting;
		ui.refreshDevicesButton.disabled = requesting
			|| state.inputDeviceListStatus === 'loading'
			|| !capabilities.deviceEnumeration;
		ui.testSelectedInputButton.disabled = requesting || !capabilities.microphone;
		ui.systemAudioButton.disabled = requesting
			|| capabilities.systemAudioStatus === 'api-unavailable'
			|| capabilities.systemAudioStatus === 'host-unsupported';
		ui.stopAudioButton.disabled = !requesting && state.status !== 'active';
		if (state.errorCode === 'device-unavailable'
			&& state.errorMessage
			&& state.errorMessage !== this.lastDeviceUnavailableNotice) {
			this.lastDeviceUnavailableNotice = state.errorMessage;
			new Notice(state.errorMessage);
		} else if (state.errorCode !== 'device-unavailable') {
			this.lastDeviceUnavailableNotice = null;
		}
	}

	private applyAudioCompanionState(state: AudioCompanionRuntimeState): void {
		this.lastAudioCompanionState = state;
		const ui = this.ui;
		if (!ui) {
			return;
		}
		const presentation = audioCompanionRuntimeUiState(
			state,
			this.lastClassroomState?.status === 'listening',
		);
		ui.audioCompanionStatusEl.setText(presentation.statusLabel);
		ui.audioCompanionFrameCountEl.setText(String(state.frameCount));
		ui.audioCompanionRmsEl.value = state.rms;
		const rmsPercentage = Math.round(state.rms * 100);
		ui.audioCompanionRmsTextEl.setText(`${rmsPercentage}%`);
		ui.audioCompanionRmsEl.setAttr('aria-label', `系统音频实时 RMS：${rmsPercentage}%`);
		ui.audioCompanionErrorEl.setText(presentation.errorMessage);
		ui.audioCompanionErrorEl.toggleClass('is-hidden', !presentation.errorMessage);
		ui.startAudioCompanionButton.setText(presentation.startLabel);
		ui.startAudioCompanionButton.disabled = !presentation.canStart;
		ui.stopAudioCompanionButton.disabled = !presentation.canStop;
		if (this.lastRealtimeAsrState) this.applyRealtimeAsrState(this.lastRealtimeAsrState);
	}

	private applyRealtimeAsrState(state: RealtimeAsrRuntimeState): void {
		this.lastRealtimeAsrState = state;
		const ui = this.ui;
		if (!ui) return;
		const presentation = realtimeAsrRuntimeUiState(
			state,
			this.lastAudioCompanionState?.status === 'capturing',
		);
		ui.realtimeAsrStatusEl.setText(presentation.statusLabel);
		ui.realtimeAsrPartialEl.setText(state.partialText || '无');
		ui.realtimeAsrFinalEl.setText(state.lastFinalText || '无');
		ui.realtimeAsrDurationEl.setText(formatAudioDuration(state.sentAudioDurationMs));
		const diagnostics = state.diagnostics;
		ui.realtimeAsrDiagnosticsEls.eventLoopLagCurrent.setText(
			`${diagnostics.eventLoopLagCurrentMs} ms`,
		);
		ui.realtimeAsrDiagnosticsEls.eventLoopLagMax.setText(
			`${diagnostics.eventLoopLagMaxMs} ms`,
		);
		ui.realtimeAsrDiagnosticsEls.eventLoopLagP95.setText(
			`${diagnostics.eventLoopLagP95Ms} ms`,
		);
		ui.realtimeAsrDiagnosticsEls.providerStatePublishCount.setText(
			String(diagnostics.providerStatePublishCount),
		);
		ui.realtimeAsrDiagnosticsEls.providerStatePublishRate.setText(
			`${diagnostics.providerStatePublishRate}/s`,
		);
		ui.realtimeAsrDiagnosticsEls.sessionNotificationCount.setText(
			String(diagnostics.sessionNotificationCount),
		);
		ui.realtimeAsrDiagnosticsEls.sessionNotificationRate.setText(
			`${diagnostics.sessionNotificationRate}/s`,
		);
		ui.realtimeAsrDiagnosticsEls.workbenchRenderCount.setText(
			String(diagnostics.workbenchRenderCount),
		);
		ui.realtimeAsrDiagnosticsEls.workbenchRenderRate.setText(
			`${diagnostics.workbenchRenderRate}/s`,
		);
		ui.realtimeAsrDiagnosticsEls.workbenchLastRenderDuration.setText(
			`${diagnostics.workbenchLastRenderDurationMs} ms`,
		);
		ui.realtimeAsrDiagnosticsEls.workbenchMaxRenderDuration.setText(
			`${diagnostics.workbenchMaxRenderDurationMs} ms`,
		);
		ui.realtimeAsrDiagnosticsEls.maxStateListenerDuration.setText(
			`${diagnostics.maxStateListenerDurationMs} ms`,
		);
		ui.realtimeAsrDiagnosticsEls.perMessageDeflateConfigured.setText(
			realtimeAsrBooleanLabel(diagnostics.perMessageDeflateConfigured),
		);
		ui.realtimeAsrDiagnosticsEls.perMessageDeflateNegotiated.setText(
			realtimeAsrBooleanLabel(diagnostics.perMessageDeflateNegotiated),
		);
		ui.realtimeAsrDiagnosticsEls.produced.setText(String(diagnostics.producedChunkCount));
		ui.realtimeAsrDiagnosticsEls.sent.setText(String(diagnostics.sentChunkCount));
		ui.realtimeAsrDiagnosticsEls.queued.setText(String(diagnostics.queuedChunkCount));
		ui.realtimeAsrDiagnosticsEls.inFlight.setText(String(diagnostics.inFlightSendCount));
		ui.realtimeAsrDiagnosticsEls.outstanding.setText(String(diagnostics.outstandingChunkCount));
		ui.realtimeAsrDiagnosticsEls.maxOutstanding.setText(
			String(diagnostics.maxOutstandingChunkCount),
		);
		ui.realtimeAsrDiagnosticsEls.wsBuffered.setText(String(diagnostics.wsBufferedAmount));
		ui.realtimeAsrDiagnosticsEls.maxWsBuffered.setText(
			String(diagnostics.maxWsBufferedAmount),
		);
		ui.realtimeAsrDiagnosticsEls.sendWriteLatency.setText(
			diagnostics.sendWriteLatencyMs === null ? '无' : `${diagnostics.sendWriteLatencyMs} ms`,
		);
		ui.realtimeAsrDiagnosticsEls.oldestInFlightAge.setText(
			diagnostics.oldestInFlightAgeMs === null ? '无' : `${diagnostics.oldestInFlightAgeMs} ms`,
		);
		ui.realtimeAsrDiagnosticsEls.maxObservedInFlightAge.setText(
			`${diagnostics.maxObservedInFlightAgeMs} ms`,
		);
		ui.realtimeAsrDiagnosticsEls.dispatchCount.setText(String(diagnostics.dispatchChunkCount));
		ui.realtimeAsrDiagnosticsEls.callbackSuccessCount.setText(
			String(diagnostics.sendCallbackSuccessCount),
		);
		ui.realtimeAsrDiagnosticsEls.callbackFailureCount.setText(
			String(diagnostics.sendCallbackFailureCount),
		);
		ui.realtimeAsrDiagnosticsEls.callbackSettledCount.setText(
			String(diagnostics.sendCallbackSettledCount),
		);
		ui.realtimeAsrDiagnosticsEls.overflowReason.setText(
			realtimeAsrOverflowReasonLabel(diagnostics.overflowReason),
		);
		ui.realtimeAsrDiagnosticsEls.socketOpen.setText(
			realtimeAsrBooleanLabel(diagnostics.socketOpen),
		);
		ui.realtimeAsrDiagnosticsEls.taskStarted.setText(
			realtimeAsrBooleanLabel(diagnostics.taskStarted),
		);
		ui.realtimeAsrDiagnosticsEls.audioSendReady.setText(
			realtimeAsrBooleanLabel(diagnostics.audioSendReady),
		);
		ui.realtimeAsrDiagnosticsEls.pumpActive.setText(
			realtimeAsrBooleanLabel(diagnostics.pumpActive),
		);
		ui.realtimeAsrDiagnosticsEls.pumpScheduled.setText(
			realtimeAsrBooleanLabel(diagnostics.pumpScheduled),
		);
		ui.realtimeAsrDiagnosticsEls.stopping.setText(
			realtimeAsrBooleanLabel(diagnostics.stopping),
		);
		ui.realtimeAsrDiagnosticsEls.lastPumpBlockReason.setText(
			realtimeAsrPumpBlockReasonLabel(diagnostics.lastPumpBlockReason),
		);
		ui.realtimeAsrDiagnosticsEls.socketEverOpened.setText(
			realtimeAsrBooleanLabel(diagnostics.socketEverOpened),
		);
		ui.realtimeAsrDiagnosticsEls.runTaskEverSent.setText(
			realtimeAsrBooleanLabel(diagnostics.runTaskEverSent),
		);
		ui.realtimeAsrDiagnosticsEls.taskEverStarted.setText(
			realtimeAsrBooleanLabel(diagnostics.taskEverStarted),
		);
		ui.realtimeAsrDiagnosticsEls.firstAudioEverDispatched.setText(
			realtimeAsrBooleanLabel(diagnostics.firstAudioEverDispatched),
		);
		ui.realtimeAsrDiagnosticsEls.warmupQueued.setText(
			String(diagnostics.warmupQueuedChunkCount),
		);
		ui.realtimeAsrDiagnosticsEls.warmupDropped.setText(
			String(diagnostics.warmupDroppedChunkCount),
		);
		ui.realtimeAsrDiagnosticsEls.warmupDroppedDuration.setText(
			formatAudioDuration(diagnostics.warmupDroppedDurationMs),
		);
		ui.realtimeAsrDiagnosticsEls.inboundMessageCount.setText(String(diagnostics.inboundMessageCount));
		ui.realtimeAsrDiagnosticsEls.taskStartedEventCount.setText(String(diagnostics.taskStartedEventCount));
		ui.realtimeAsrDiagnosticsEls.resultGeneratedEventCount.setText(String(diagnostics.resultGeneratedEventCount));
		ui.realtimeAsrDiagnosticsEls.taskFailedEventCount.setText(String(diagnostics.taskFailedEventCount));
		ui.realtimeAsrDiagnosticsEls.taskFinishedEventCount.setText(String(diagnostics.taskFinishedEventCount));
		ui.realtimeAsrDiagnosticsEls.ignoredHeartbeatCount.setText(String(diagnostics.ignoredHeartbeatCount));
		ui.realtimeAsrDiagnosticsEls.unknownEventCount.setText(String(diagnostics.unknownEventCount));
		ui.realtimeAsrDiagnosticsEls.lastInboundEventKind.setText(
			realtimeAsrInboundEventKindLabel(diagnostics.lastInboundEventKind),
		);
		ui.realtimeAsrDiagnosticsEls.lastInboundEventAge.setText(
			diagnostics.lastInboundEventAgeMs === null ? '无' : `${diagnostics.lastInboundEventAgeMs} ms`,
		);
		ui.realtimeAsrDiagnosticsEls.firstResultGeneratedLatency.setText(
			diagnostics.firstResultGeneratedLatencyMs === null
				? '无'
				: `${diagnostics.firstResultGeneratedLatencyMs} ms`,
		);
		ui.realtimeAsrDiagnosticsEls.liveWallElapsed.setText(`${diagnostics.liveWallElapsedMs} ms`);
		ui.realtimeAsrDiagnosticsEls.producedAudioDuration.setText(
			`${diagnostics.producedAudioDurationMs} ms`,
		);
		ui.realtimeAsrDiagnosticsEls.dispatchedAudioDuration.setText(
			`${diagnostics.dispatchedAudioDurationMs} ms`,
		);
		ui.realtimeAsrDiagnosticsEls.currentDispatchLead.setText(
			`${diagnostics.currentDispatchLeadMs} ms`,
		);
		ui.realtimeAsrDiagnosticsEls.maxDispatchLead.setText(`${diagnostics.maxDispatchLeadMs} ms`);
		ui.realtimeAsrDiagnosticsEls.minDispatchInterval.setText(
			diagnostics.minDispatchIntervalMs === null ? '无' : `${diagnostics.minDispatchIntervalMs} ms`,
		);
		ui.realtimeAsrDiagnosticsEls.averageDispatchInterval.setText(
			`${diagnostics.averageDispatchIntervalMs} ms`,
		);
		ui.realtimeAsrDiagnosticsEls.currentDeadlineLateness.setText(
			`${diagnostics.currentDeadlineLatenessMs} ms`,
		);
		ui.realtimeAsrDiagnosticsEls.maxDeadlineLateness.setText(
			`${diagnostics.maxDeadlineLatenessMs} ms`,
		);
		ui.realtimeAsrDiagnosticsEls.controlledRecoveryDispatchCount.setText(
			String(diagnostics.controlledRecoveryDispatchCount),
		);
		ui.realtimeAsrDiagnosticsEls.schedulerWakeupCount.setText(
			String(diagnostics.schedulerWakeupCount),
		);
		ui.realtimeAsrDiagnosticsEls.maxDispatchBurstCount.setText(
			String(diagnostics.maxDispatchBurstCount),
		);
		ui.realtimeAsrErrorEl.setText(presentation.errorMessage);
		ui.realtimeAsrErrorEl.toggleClass('is-hidden', !presentation.errorMessage);
		ui.startRealtimeAsrButton.setText(presentation.startLabel);
		ui.startRealtimeAsrButton.disabled = !presentation.canStart;
		ui.stopRealtimeAsrButton.disabled = !presentation.canStop;
	}

	private updateAudioInputOptions(
		select: HTMLSelectElement,
		devices: AudioInputDeviceOption[],
	): void {
		const signature = devices
			.map((device) => [
				device.id ?? '',
				device.label,
				device.isLoopbackCandidate ? '1' : '0',
			].join('\u0000'))
			.join('\u0001');
		if (signature === this.inputDeviceOptionsSignature) {
			return;
		}
		this.inputDeviceOptionsSignature = signature;
		select.empty();
		for (const device of devices) {
			select.createEl('option', {
				value: device.id ?? '',
				text: device.isLoopbackCandidate
					? `${device.label} · 可能是系统音频输入`
					: device.label,
			});
		}
	}

	private updateSessionSummarySecondary(state: ScreenshotBackgroundState): void {
		this.ui?.sessionSummarySecondaryEl.setText(
			`已运行 ${formatClassroomElapsed(state)} · 截图 ${state.savedCount} 张`,
		);
	}

	private startElapsedTimer(): void {
		if (this.elapsedTimer !== null) {
			return;
		}
		this.elapsedTimer = window.setInterval(() => {
			const state = this.host.getClassroomState();
			this.ui?.elapsedEl.setText(formatClassroomElapsed(state));
			this.updateSessionSummarySecondary(state);
		}, 1_000);
	}

	private stopElapsedTimer(): void {
		if (this.elapsedTimer !== null) {
			window.clearInterval(this.elapsedTimer);
			this.elapsedTimer = null;
		}
	}
}

function detailRow(
	container: HTMLElement,
	label: string,
	valueClass?: string,
): HTMLElement {
	const row = container.createDiv({ cls: 'lecture-workflow-workbench-detail' });
	row.createSpan({ text: label });
	return row.createSpan({
		text: '—',
		cls: valueClass,
	});
}

function summaryRow(container: HTMLElement, label: string): HTMLElement {
	const row = container.createDiv({ cls: 'lecture-workflow-workbench-status-row' });
	row.createSpan({ text: `${label}：` });
	return row.createSpan({ text: '—' });
}

export function formatClassroomElapsed(state: ScreenshotBackgroundState): string {
	if (!state.startedAt) {
		return '00:00:00';
	}
	const endAt = state.status === 'listening'
		? Date.now()
		: state.endedAt?.getTime() ?? state.startedAt.getTime();
	const totalSeconds = Math.max(0, Math.floor((endAt - state.startedAt.getTime()) / 1_000));
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	return [hours, minutes, seconds]
		.map((value) => String(value).padStart(2, '0'))
		.join(':');
}

function formatAudioDuration(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function audioSourceLabel(state: AudioCaptureProbeState): string {
	if (state.source === 'microphone') {
		return '麦克风';
	}
	if (state.source === 'system-audio') {
		return '系统音频';
	}
	return '未选择';
}

function systemAudioCapabilityLabel(status: SystemAudioCapabilityStatus): string {
	const labels: Record<SystemAudioCapabilityStatus, string> = {
		'api-unavailable': 'API 不存在',
		unverified: '接口存在，尚未验证',
		requesting: '请求中',
		verified: '已验证可用',
		'permission-denied': '权限被拒绝或用户取消',
		'no-audio-track': '没有音频轨道',
		'host-unsupported': '不可用：当前 Obsidian Electron 宿主不支持',
		'temporary-failure': '临时失败',
	};
	return labels[status];
}

function systemAudioCapabilityExplanation(status: SystemAudioCapabilityStatus): string {
	if (status === 'host-unsupported') {
		return '当前 Obsidian 环境不支持直接系统音频捕获。这不是权限问题。可以改用麦克风、Windows 立体声混音或其他音频输入设备。';
	}
	if (status === 'no-audio-track') {
		return '当前选择没有提供系统音频轨道。';
	}
	if (status === 'permission-denied') {
		return '系统音频共享请求被拒绝或取消；这与宿主不支持是不同状态。';
	}
	if (status === 'unverified') {
		return '检测到标准接口，但接口存在不代表当前宿主能够提供系统音频。测试只会在用户主动点击后开始。';
	}
	if (status === 'verified') {
		return '本次插件运行期间已经成功取得系统音频轨道。';
	}
	if (status === 'requesting') {
		return '正在等待系统来源选择或权限结果。';
	}
	if (status === 'temporary-failure') {
		return '本次请求临时失败，未判定为永久不支持。';
	}
	return '当前环境没有可用的直接系统音频捕获接口。';
}

function audioInputDeviceStatusLabel(state: AudioCaptureProbeState): string {
	if (state.inputDeviceListMessage) {
		return state.inputDeviceListMessage;
	}
	const labels: Record<AudioCaptureProbeState['inputDeviceListStatus'], string> = {
		idle: '尚未刷新设备列表。',
		loading: '正在刷新音频输入设备…',
		ready: `已发现 ${Math.max(0, state.inputDevices.length - 1)} 个可选输入设备。`,
		unsupported: '当前环境不支持枚举音频输入设备。',
		error: '无法刷新音频输入设备列表。',
	};
	return labels[state.inputDeviceListStatus];
}

function loopbackDeviceHint(devices: AudioInputDeviceOption[]): string {
	if (devices.some((device) => device.isLoopbackCandidate)) {
		return '检测到名称可能属于系统音频输入的设备；这只是提示，请由用户主动选择并测试。';
	}
	if (devices.some((device) => !device.isDefault && !device.hasLabel)) {
		return '部分设备名称尚不可见。麦克风权限允许后，请刷新设备列表。';
	}
	return '未检测到系统音频输入设备。当前可以使用麦克风进行课堂转写；如需直接读取电脑声音，可在 Windows 中检查“立体声混音”，或以后配置虚拟音频设备。';
}

function classroomStatusLabel(state: ScreenshotBackgroundState): string {
	if (state.status === 'listening') {
		return '监听中';
	}
	if (state.status === 'unsupported') {
		return '当前环境不支持';
	}
	return '未启动';
}

function audioStatusLabel(state: AudioCaptureProbeState): string {
	const labels: Record<AudioCaptureProbeState['status'], string> = {
		idle: '未开始',
		'requesting-permission': '正在请求权限',
		active: '检测中',
		stopping: '正在停止',
		stopped: '已停止',
		unsupported: '当前环境不支持',
		'permission-denied': '权限被拒绝',
		'no-audio-track': '没有音频轨道',
		ended: '音频来源已结束',
		error: '测试失败',
	};
	return labels[state.status];
}

function safeErrorType(error: unknown): string {
	return error instanceof Error && error.name ? error.name : 'unknown';
}
