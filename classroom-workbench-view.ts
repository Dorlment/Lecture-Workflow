import {
	ItemView,
	Notice,
	WorkspaceLeaf,
} from 'obsidian';

import type { AudioCaptureProbe } from './audio-capture-probe';
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
	startClassroom(): void;
	stopClassroom(): void;
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
}

export class ClassroomWorkbenchView extends ItemView {
	private ui: ClassroomWorkbenchUi | null = null;
	private unsubscribeClassroom: (() => void) | null = null;
	private unsubscribeAudio: (() => void) | null = null;
	private elapsedTimer: number | null = null;
	private inputDeviceOptionsSignature = '';
	private lastDeviceUnavailableNotice: string | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly host: ClassroomWorkbenchHost,
		private readonly audioProbe: AudioCaptureProbe,
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
		this.stopElapsedTimer();
		await this.audioProbe.stop();
		this.inputDeviceOptionsSignature = '';
		this.lastDeviceUnavailableNotice = null;
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
