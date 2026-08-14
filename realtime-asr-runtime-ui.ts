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
		'configuration-error': '请先配置 Qwen API Key、Workspace ID 和实时转写模型。',
		'auth-failed': '百炼身份验证失败，请检查 Qwen 配置。',
		'connection-failed': '无法连接百炼实时转写服务。',
		'task-start-failed': '实时识别任务启动超时。',
		'task-failed': '百炼实时转写任务失败。',
		'protocol-error': '百炼返回了无法安全处理的协议消息。',
		'audio-format-invalid': '系统音频格式不符合实时转写要求。',
		'audio-sequence-invalid': '系统音频帧不连续，已停止本轮转写。',
		'audio-buffer-overflow': '实时音频缓冲达到安全上限，实时转写已安全停止。',
		'audio-send-timeout': '音频发送回调超时，实时转写已安全停止。',
		'unexpected-websocket-compression': 'WebSocket 意外协商了压缩，实时转写已安全停止。',
		'finish-timeout': '等待百炼结束实时转写超时。',
		'remote-closed': '百炼实时转写连接已关闭。',
	};
	return messages[code];
}
