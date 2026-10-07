import type {
	RealtimeAsrErrorCode,
	RealtimeAsrInboundEventKind,
	RealtimeAsrOverflowReason,
	RealtimeAsrRuntimeState,
} from './realtime-asr-types';

export interface RealtimeAsrUiState {
	statusLabel: string;
	errorMessage: string;
	canStart: boolean;
	canStop: boolean;
	startLabel: string;
}

export function realtimeAsrInboundEventKindLabel(
	kind: RealtimeAsrInboundEventKind,
): string {
	const labels: Record<RealtimeAsrInboundEventKind, string> = {
		none: '无',
		'task-started': 'Task 已启动',
		'result-generated': '识别结果',
		heartbeat: '心跳',
		'task-failed': 'Task 失败',
		'task-finished': 'Task 已结束',
		unknown: '未知事件',
	};
	return labels[kind];
}

export function realtimeAsrRuntimeUiState(
	state: RealtimeAsrRuntimeState,
	audioCapturing: boolean,
): RealtimeAsrUiState {
	const active = state.status === 'connecting'
		|| state.status === 'starting-task'
		|| state.status === 'streaming'
		|| state.status === 'stopping';
	return {
		statusLabel: statusLabel(state.status),
		errorMessage: state.errorCode ? errorMessage(state) : '',
		canStart: audioCapturing && !active,
		canStop: state.status === 'streaming'
			|| state.status === 'connecting'
			|| state.status === 'starting-task',
		startLabel: state.status === 'error' || state.status === 'stopped'
			? '重新启动实时转写'
			: '启动实时转写',
	};
}

export function realtimeAsrBooleanLabel(value: boolean): string {
	return value ? '是' : '否';
}

export function realtimeAsrPumpBlockReasonLabel(
	reason: unknown,
): string {
	switch (reason) {
		case 'none': return '无';
		case 'socket-not-open': return 'Socket 未打开';
		case 'task-not-started': return '识别任务尚未启动';
		case 'audio-not-ready': return '音频发送尚未就绪';
		case 'stopping': return '正在停止';
		case 'disposed': return 'Provider 已释放';
		case 'finished': return '任务已结束';
		case 'queue-empty': return '发送队列为空';
		case 'inflight-limit': return '待回调发送已达上限';
		case 'pending-callback-limit': return '待回调发送达到安全上限';
		case 'media-deadline': return '等待下一个音频发送时刻';
		case 'ws-buffer-limit': return 'WebSocket 缓冲已达上限';
		default: return '未知状态';
	}
}

export function realtimeAsrOverflowReasonLabel(
	reason: RealtimeAsrOverflowReason | null,
): string {
	switch (reason) {
		case null: return '无';
		case 'app-queue-limit': return '应用实时音频队列达到安全上限';
		case 'ws-buffer-limit': return 'WebSocket 发送缓冲达到安全上限';
	}
}

function statusLabel(status: RealtimeAsrRuntimeState['status']): string {
	const labels: Record<RealtimeAsrRuntimeState['status'], string> = {
		disabled: '当前环境不可用',
		'configuration-error': '配置不完整',
		idle: '未启动',
		connecting: '正在连接',
		'starting-task': '正在启动识别任务',
		streaming: '正在实时转写',
		stopping: '正在停止',
		stopped: '已停止',
		error: '运行失败',
	};
	return labels[status];
}

function errorMessage(state: RealtimeAsrRuntimeState): string {
	const code = state.errorCode;
	if (!code) return '';
	const failure = state.diagnostics.failure;
	if (failure?.origin === 'service') {
		const reasons = {
			timeout: `Qwen 服务端报告请求超时${failure.serviceTimeoutSeconds === null ? '' : `（${failure.serviceTimeoutSeconds} 秒）`}。`,
			authentication: 'Qwen 拒绝身份验证或访问权限，请检查 API Key、Workspace ID 和北京地域是否匹配。',
			'rate-limit': 'Qwen 限制了请求频率或并发数，请稍后重试并检查百炼配额。',
			quota: 'Qwen 报告额度、余额或账单异常，请检查百炼账户余额、账单和预算限制。',
			'free-tier-exhausted': failure.serviceCode === 'AllocationQuota.FreeTierOnly'
				? 'Qwen 报告免费额度已耗尽或过期，且当前仅允许使用免费额度。请在百炼控制台补全付费信息，或关闭「仅使用免费额度」后重试；启用付费调用可能产生费用。'
				: 'Qwen 报告免费额度已耗尽或过期，请在百炼控制台检查该模型的免费额度、有效期及付费调用是否可用。',
			'invalid-configuration': 'Qwen 拒绝了模型或请求参数，请检查实时转写模型是否可用。',
			'service-unavailable': 'Qwen 服务暂时不可用，请稍后重新启动实时转写。',
			unknown: failure.phase === 'starting-task'
				? 'Qwen 在启动识别任务时拒绝了请求，本轮尚未发送音频。具体原因未识别，请检查模型可用性、访问权限及额度；可将任务 ID 提供给阿里云排查。'
				: 'Qwen 返回了尚未识别的任务错误，请复制报错详情并将任务 ID 提供给阿里云进一步排查。',
		};
		const audioGap = failure.phase === 'streaming' && failure.reason === 'timeout'
			? failure.lastAudioReceivedAgeMs === null
				? '本轮尚未收到助手音频帧，请先播放课程声音并检查系统音频状态。'
				: failure.lastAudioReceivedAgeMs >= 5_000
					? `报错前 ${seconds(failure.lastAudioReceivedAgeMs)} 秒未收到助手音频帧，请检查播放是否暂停、输出设备是否切换。`
					: '报错前仍收到助手音频帧，请结合发送缓冲和网络状态排查后重新启动转写。'
			: '';
		return reasons[failure.reason] + audioGap;
	}
	if (failure?.httpStatus === 429) return 'Qwen 在连接阶段返回 HTTP 429（限流），请稍后重试并检查并发配额。';
	if (failure?.httpStatus === 401 || failure?.httpStatus === 403) {
		return `Qwen 身份验证或权限检查失败（HTTP ${failure.httpStatus}），请检查 API Key、Workspace ID 与北京地域是否匹配。`;
	}
	if (failure?.httpStatus !== null && failure?.httpStatus !== undefined && failure.httpStatus >= 500) {
		return `Qwen 在连接阶段返回 HTTP ${failure.httpStatus}，服务暂时不可用，请稍后重试。`;
	}
	if (failure?.httpStatus !== null && failure?.httpStatus !== undefined && failure.httpStatus >= 400) {
		return `Qwen 在连接阶段返回 HTTP ${failure.httpStatus}，请检查 Workspace ID、地域和服务地址。`;
	}
	if (failure?.networkCode) {
		const network = failure.networkCode;
		if (network === 'ENOTFOUND' || network === 'EAI_AGAIN') return 'Qwen 地址解析失败，请检查网络、DNS 和 Workspace ID。';
		if (network.includes('CERT') || network === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return 'Qwen 安全连接的证书校验失败，请检查系统时间和代理的证书配置。';
		return `连接 Qwen 时发生网络错误（${network}），请检查网络或代理后重试。`;
	}
	if (failure && code === 'task-start-failed') return '已连接 Qwen，但发送启动请求后 30 秒仍未收到任务启动确认。请检查模型、服务状态和网络后重试。';
	if (failure && code === 'audio-send-timeout') return `音频在本地 WebSocket 中等待发送完成${failure.localTimeoutMs === undefined ? '超时' : `超过 ${seconds(failure.localTimeoutMs)} 秒`}，转写已停止。请检查网络、代理及报错详情中的发送缓冲。`;
	if (code === 'audio-buffer-overflow') {
		switch (state.diagnostics.overflowReason) {
			case 'app-queue-limit':
				return '应用实时音频队列达到安全上限，实时转写已安全停止。';
			case 'ws-buffer-limit':
				return 'WebSocket 发送缓冲达到安全上限，实时转写已安全停止。';
			default:
				return '实时音频缓冲达到安全上限，实时转写已安全停止。';
		}
	}
	const messages: Record<RealtimeAsrErrorCode, string> = {
		'configuration-error': '实时转写未配置。请先在 Lecture Workflow 设置中完成 Qwen 实时转写配置，然后重新开始课堂。',
		'auth-failed': '百炼身份验证失败，请检查 Qwen 配置。',
		'connection-failed': '无法连接百炼实时转写服务。',
		'connection-timeout': '连接 Qwen 超过 30 秒，尚未完成 WebSocket 握手。请检查网络、代理和 Workspace ID 后重试。',
		'control-send-timeout': 'Qwen 任务控制指令在本地等待发送完成超过 5 秒，请检查网络或代理后重试。',
		'task-start-failed': '实时识别任务启动超时。',
		'task-failed': '百炼实时转写任务失败。',
		'protocol-error': '百炼返回了无法安全处理的协议消息。',
		'audio-format-invalid': '系统音频格式不符合实时转写要求。',
		'audio-unavailable': '系统音频尚未开始捕获，或助手与当前课堂会话不匹配。请先在工作台重新启动系统音频。',
		'audio-sequence-invalid': '系统音频帧不连续，已停止本轮转写。',
		'audio-buffer-overflow': '实时音频缓冲达到安全上限，实时转写已安全停止。',
		'audio-send-timeout': '音频发送回调超时，实时转写已安全停止。',
		'unexpected-websocket-compression': 'WebSocket 意外协商了压缩，实时转写已安全停止。',
		'finish-timeout': '等待百炼结束实时转写超时。',
		'remote-closed': '百炼实时转写连接已关闭。',
	};
	return messages[code];
}

function seconds(ms: number): string {
	return (Math.max(0, ms) / 1_000).toFixed(1);
}

/** A copyable report deliberately excludes configuration, server bodies and recognized text. */
export function realtimeAsrFailureReport(state: RealtimeAsrRuntimeState): string {
	if (!state.errorCode) return '';
	const failure = state.diagnostics.failure;
	const lines = ['Qwen 实时转写报错', `错误：${state.errorCode}`, `说明：${errorMessage(state)}`];
	if (!failure) return lines.join('\n');
	const phases = { connecting: '建立连接', 'starting-task': '启动识别任务', streaming: '实时转写', stopping: '结束转写' };
	lines.push(`失败阶段：${phases[failure.phase]}`, `本轮持续：${seconds(failure.elapsedMs)} 秒`);
	if (failure.localTimeoutMs !== undefined) lines.push(`本地等待上限：${seconds(failure.localTimeoutMs)} 秒`);
	if (failure.serviceCode) lines.push(`服务错误码：${failure.serviceCode}`);
	else if (failure.origin === 'service') lines.push('服务错误码：未识别（未保留原始值）');
	if (failure.httpStatus !== null) lines.push(`HTTP 状态：${failure.httpStatus}`);
	if (failure.networkCode) lines.push(`网络错误码：${failure.networkCode}`);
	if (failure.closeCode !== null) lines.push(`WebSocket 关闭码：${failure.closeCode}`);
	lines.push(
		`最近收到助手音频：${failure.lastAudioReceivedAgeMs === null ? '本轮未收到' : `${seconds(failure.lastAudioReceivedAgeMs)} 秒前`}`,
		`最近尝试发送音频：${failure.lastAudioDispatchAgeMs === null ? '本轮未发送' : `${seconds(failure.lastAudioDispatchAgeMs)} 秒前`}`,
		`失败时排队块数：${failure.queuedChunks}；待发送回调：${failure.pendingSends}；发送缓冲：${failure.bufferedBytes} 字节`,
	);
	if (failure.taskId) lines.push(`任务 ID：${failure.taskId}`);
	return lines.join('\n');
}
