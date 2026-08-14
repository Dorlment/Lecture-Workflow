import { App, Modal, Setting } from 'obsidian';

import type {
	RealtimeAsrTransportAbComparison,
	RealtimeAsrTransportAbConclusion,
	RealtimeAsrTransportAbProgress,
	RealtimeAsrTransportAbResult,
	RealtimeAsrTransportAbRunStatus,
} from './realtime-asr-transport-ab-diagnostic';
import { RealtimeAsrTransportAbDiagnostic } from './realtime-asr-transport-ab-diagnostic';

export class RealtimeAsrTransportAbModal extends Modal {
	private unsubscribe: (() => void) | null = null;
	private startButton: HTMLButtonElement | null = null;
	private cancelButton: HTMLButtonElement | null = null;
	private rerunButton: HTMLButtonElement | null = null;
	private phaseEl: HTMLElement | null = null;
	private countdownEl: HTMLElement | null = null;
	private resultEl: HTMLElement | null = null;
	private running = false;

	constructor(
		app: App,
		private readonly diagnostic: RealtimeAsrTransportAbDiagnostic,
		private readonly onClosed: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('lecture-workflow-modal', 'lecture-workflow-asr-ab-modal');
		contentEl.createEl('h2', { text: 'Realtime ASR Transport A/B诊断（开发）' });
		contentEl.createEl('p', {
			text: '用于比较当前生产链路与官方时序最小实现的本地写出延迟和缓冲行为。诊断结论仅为排查推断，不是绝对归因。',
		});
		const facts = contentEl.createEl('ul');
		for (const text of [
			'每一路固定运行75秒，两路总计约150秒真实百炼ASR用量。',
			'使用内存生成的确定性非语音PCM，不录制系统音频，播放课程音频不会影响诊断。',
			'会调用当前配置的百炼服务；API Key仅在当前运行内存中使用。',
			'不写入Vault，不保存PCM，不保存或展示转写正文。',
		]) facts.createEl('li', { text });

		const status = contentEl.createDiv({ cls: 'lecture-workflow-asr-ab-status' });
		this.phaseEl = summaryRow(status, '当前阶段');
		this.countdownEl = summaryRow(status, '剩余时间');
		this.resultEl = contentEl.createDiv({ cls: 'lecture-workflow-asr-ab-results' });

		const actions = new Setting(contentEl);
		actions.settingEl.addClass('lecture-workflow-actions');
		actions.addButton((button) => {
			this.startButton = button.buttonEl;
			button.setButtonText('开始诊断').setCta().onClick(() => this.start());
		});
		actions.addButton((button) => {
			this.cancelButton = button.buttonEl;
			button.setButtonText('取消诊断').onClick(() => this.cancel());
		});
		actions.addButton((button) => {
			this.rerunButton = button.buttonEl;
			button.setButtonText('重新运行').onClick(() => this.start());
		});
		actions.addButton((button) => button.setButtonText('关闭').onClick(() => this.close()));
		this.unsubscribe = this.diagnostic.subscribe((progress) => this.render(progress));
		this.render(this.diagnostic.progress);
	}

	onClose(): void {
		this.diagnostic.cancel();
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.diagnostic.dispose();
		this.contentEl.empty();
		this.startButton = null;
		this.cancelButton = null;
		this.rerunButton = null;
		this.phaseEl = null;
		this.countdownEl = null;
		this.resultEl = null;
		this.onClosed();
	}

	private start(): void {
		if (this.running || this.diagnostic.isRunning) return;
		this.running = true;
		this.updateButtons();
		this.diagnostic.clear();
		void this.diagnostic.run().catch(() => {
			this.showFixedFailure();
		}).finally(() => {
			this.running = false;
			this.updateButtons();
		});
	}

	private cancel(): void {
		this.diagnostic.cancel();
	}

	private render(progress: RealtimeAsrTransportAbProgress): void {
		this.phaseEl?.setText(phaseLabel(progress.phase));
		this.countdownEl?.setText(formatRemaining(progress.remainingMs));
		this.updateButtons();
		if (!this.resultEl) return;
		this.resultEl.empty();
		if (progress.comparison) {
			this.renderComparison(progress.comparison);
			return;
		}
		if (progress.phase === 'cancelled') {
			this.resultEl.createEl('p', { text: '诊断已取消，连接、计时器和待处理发送已清理。' });
		}
	}

	private renderComparison(comparison: RealtimeAsrTransportAbComparison): void {
		if (!this.resultEl) return;
		this.resultEl.createEl('h3', { text: 'A/B结果' });
		const table = this.resultEl.createEl('table', { cls: 'lecture-workflow-asr-ab-table' });
		const head = table.createEl('thead').createEl('tr');
		head.createEl('th', { text: '指标' });
		head.createEl('th', { text: '当前生产链路' });
		head.createEl('th', { text: '官方时序最小实现' });
		const body = table.createEl('tbody');
		for (const field of resultFields()) {
			const row = body.createEl('tr');
			row.createEl('th', { text: field.label });
			row.createEl('td', { text: field.value(comparison.currentTransport) });
			row.createEl('td', { text: field.value(comparison.officialSequenceMinimal) });
		}
		this.resultEl.createEl('p', {
			text: `诊断推断：${conclusionLabel(comparison.conclusion)}`,
			cls: 'lecture-workflow-workbench-help',
		});
		this.resultEl.createEl('p', {
			text: '该结论只反映本次受控运行的数值差异，不构成网络或服务端问题的绝对归因。',
			cls: 'lecture-workflow-workbench-help',
		});
	}

	private showFixedFailure(): void {
		if (!this.resultEl) return;
		this.resultEl.empty();
		this.resultEl.createEl('p', {
			text: '无法启动A/B诊断，请检查当前百炼配置后重试。',
			cls: 'lecture-workflow-workbench-error',
		});
	}

	private updateButtons(): void {
		const active = this.running || this.diagnostic.isRunning;
		if (this.startButton) this.startButton.disabled = active;
		if (this.cancelButton) this.cancelButton.disabled = !active;
		if (this.rerunButton) this.rerunButton.disabled = active
			|| this.diagnostic.progress.phase !== 'completed';
	}
}

function resultFields(): Array<{
	label: string;
	value(result: RealtimeAsrTransportAbResult): string;
}> {
	return [
		{ label: '状态', value: (value) => runStatusLabel(value.status) },
		{ label: '目标时长(ms)', value: numberValue('durationTargetMs') },
		{ label: '墙钟时长(ms)', value: numberValue('wallElapsedMs') },
		{ label: '已取消', value: booleanValue('cancelled') },
		{ label: '已完成', value: booleanValue('completed') },
		{ label: '稳定错误码', value: (value) => value.stableErrorCode ?? '无' },
		{ label: '目标块数', value: numberValue('targetChunkCount') },
		{ label: 'Dispatch数', value: numberValue('dispatchCount') },
		{ label: 'Callback成功', value: numberValue('successCount') },
		{ label: 'Callback失败', value: numberValue('failureCount') },
		{ label: 'Callback已结算', value: numberValue('callbackSettledCount') },
		{ label: '最终inFlight', value: numberValue('finalInFlightCount') },
		{ label: '最大inFlight', value: numberValue('maxInFlightCount') },
		{ label: '最终排队', value: numberValue('finalQueuedCount') },
		{ label: '最大排队', value: numberValue('maxQueuedCount') },
		{ label: '最后写出延迟(ms)', value: nullableNumberValue('lastSendWriteLatencyMs') },
		{ label: '平均写出延迟(ms)', value: numberValue('averageSendWriteLatencyMs') },
		{ label: 'P50写出延迟(ms)', value: numberValue('p50SendWriteLatencyMs') },
		{ label: 'P95写出延迟(ms)', value: numberValue('p95SendWriteLatencyMs') },
		{ label: 'P99写出延迟(ms)', value: numberValue('p99SendWriteLatencyMs') },
		{ label: '最大写出延迟(ms)', value: numberValue('maxSendWriteLatencyMs') },
		{ label: '最老inFlight年龄(ms)', value: nullableNumberValue('oldestInFlightAgeMs') },
		{ label: '历史最大inFlight年龄(ms)', value: numberValue('maxObservedInFlightAgeMs') },
		{ label: '最终WebSocket缓冲', value: numberValue('finalBufferedAmount') },
		{ label: '最大WebSocket缓冲', value: numberValue('maxBufferedAmount') },
		{ label: '最小Dispatch间隔(ms)', value: nullableNumberValue('minDispatchIntervalMs') },
		{ label: '最大Dispatch间隔(ms)', value: nullableNumberValue('maxDispatchIntervalMs') },
		{ label: '最大Dispatch突发数', value: numberValue('maxDispatchBurstCount') },
		{ label: '已Dispatch音频(ms)', value: numberValue('dispatchedAudioDurationMs') },
		{ label: '当前Dispatch超前(ms)', value: numberValue('currentDispatchLeadMs') },
		{ label: '最大Dispatch超前(ms)', value: numberValue('maxDispatchLeadMs') },
		{ label: 'task-started数', value: numberValue('taskStartedEventCount') },
		{ label: 'result-generated数', value: numberValue('resultGeneratedEventCount') },
		{ label: 'task-failed数', value: numberValue('taskFailedEventCount') },
		{ label: 'task-finished数', value: numberValue('taskFinishedEventCount') },
		{ label: '未知事件数', value: numberValue('unknownEventCount') },
		{ label: '压缩配置', value: booleanValue('perMessageDeflateConfigured') },
		{ label: '压缩已协商', value: booleanValue('perMessageDeflateNegotiated') },
		{
			label: '每15秒采样',
			value: (value) => value.intervalSamples.length === 0
				? '无'
				: value.intervalSamples.map((sample) => [
					`${sample.elapsedMs}ms`,
					`D${sample.dispatchCount}`,
					`C${sample.callbackSettledCount}`,
					`I${sample.inFlightCount}`,
					`B${sample.bufferedAmount}`,
					`L${sample.eventLoopLagCurrentMs}/${sample.eventLoopLagMaxMs}`,
				].join(':')).join(' | '),
		},
	];
}

function numberValue(
	key: NumericAbResultKey,
): (result: RealtimeAsrTransportAbResult) => string {
	return (result) => String(result[key]);
}

function nullableNumberValue(
	key: NullableNumericAbResultKey,
): (result: RealtimeAsrTransportAbResult) => string {
	return (result) => {
		const value = result[key];
		return value === null ? '无' : String(value);
	};
}

type NumericAbResultKey = {
	[Key in keyof RealtimeAsrTransportAbResult]:
		RealtimeAsrTransportAbResult[Key] extends number ? Key : never;
}[keyof RealtimeAsrTransportAbResult];

type NullableNumericAbResultKey = {
	[Key in keyof RealtimeAsrTransportAbResult]:
		number | null extends RealtimeAsrTransportAbResult[Key] ? Key : never;
}[keyof RealtimeAsrTransportAbResult];

function booleanValue(
	key: keyof RealtimeAsrTransportAbResult,
): (result: RealtimeAsrTransportAbResult) => string {
	return (result) => result[key] === true ? '是' : '否';
}

function phaseLabel(phase: RealtimeAsrTransportAbProgress['phase']): string {
	const labels: Record<RealtimeAsrTransportAbProgress['phase'], string> = {
		idle: '尚未开始',
		'current-transport': '当前生产链路',
		'between-runs': '正在清理第一路并等待第二路',
		'official-sequence-minimal': '官方时序最小实现',
		completed: '已完成',
		cancelled: '已取消',
	};
	return labels[phase];
}

function runStatusLabel(status: RealtimeAsrTransportAbRunStatus): string {
	const labels: Record<RealtimeAsrTransportAbRunStatus, string> = {
		normal: '正常', backlog: '积压', failed: '失败', cancelled: '已取消', inconclusive: '无法判断',
	};
	return labels[status];
}

function conclusionLabel(conclusion: RealtimeAsrTransportAbConclusion): string {
	const labels: Record<RealtimeAsrTransportAbConclusion, string> = {
		'probable-network-or-service-path': '两路均积压，可能位于网络或服务路径',
		'probable-production-transport-difference': '可能存在生产Transport差异',
		'transient-or-not-reproduced': '本次未复现或此前为暂态问题',
		'diagnostic-not-equivalent-or-minimal-runner-defect': '诊断不等价或最小实现存在缺陷',
		inconclusive: '无法判断',
	};
	return labels[conclusion];
}

function formatRemaining(milliseconds: number): string {
	const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function summaryRow(container: HTMLElement, label: string): HTMLElement {
	const row = container.createDiv({ cls: 'lecture-workflow-workbench-summary-row' });
	row.createSpan({ text: label, cls: 'lecture-workflow-workbench-summary-label' });
	return row.createSpan({ text: '—', cls: 'lecture-workflow-workbench-summary-value' });
}
