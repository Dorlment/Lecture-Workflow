import type {
	AudioCompanionRuntimeLocalErrorCode,
	AudioCompanionRuntimeState,
	AudioCompanionRuntimeStatus,
} from './audio-companion-runtime-types';
import type { AudioCompanionRemoteErrorCode } from './audio-companion-types';

export interface AudioCompanionRuntimeUiState {
	statusLabel: string;
	errorMessage: string;
	canStart: boolean;
	canStop: boolean;
	startLabel: string;
}

export function audioCompanionRuntimeUiState(
	state: AudioCompanionRuntimeState,
	hasClassroomSession: boolean,
): AudioCompanionRuntimeUiState {
	const active = isStartingOrActive(state.status);
	return {
		statusLabel: runtimeStatusLabel(state.status),
		errorMessage: runtimeErrorMessage(state.errorCode, state.remoteErrorCode),
		canStart: hasClassroomSession
			&& state.status !== 'unsupported'
			&& !active,
		canStop: state.status === 'capturing',
		startLabel: state.status === 'error'
			|| state.status === 'helper-unavailable'
			|| state.status === 'stopped'
			? '重新启动系统音频'
			: '启动系统音频',
	};
}

export function runtimeStatusLabel(status: AudioCompanionRuntimeStatus): string {
	const labels: Record<AudioCompanionRuntimeStatus, string> = {
		unsupported: '当前平台不支持',
		'helper-unavailable': '助手不可用',
		idle: '未启动',
		launching: '正在启动助手',
		'waiting-for-readiness': '正在等待助手就绪',
		connecting: '正在连接助手',
		ready: '助手已连接',
		capturing: '正在捕获系统音频',
		stopping: '正在停止',
		stopped: '已停止',
		error: '运行失败',
	};
	return labels[status];
}

export function runtimeErrorMessage(
	localCode: AudioCompanionRuntimeLocalErrorCode | null,
	remoteCode: AudioCompanionRemoteErrorCode | null,
): string {
	if (remoteCode) {
		return remoteErrorMessage(remoteCode);
	}
	if (!localCode) {
		return '';
	}
	const messages: Partial<Record<AudioCompanionRuntimeLocalErrorCode, string>> = {
		'unsupported-runtime': '系统音频助手目前仅支持 Obsidian Windows 桌面端。',
		'helper-unavailable': 'Windows 音频助手尚未安装或开发运行文件尚未准备好。',
		'session-unavailable': '请先启动课堂监听，再启动系统音频。',
		'token-generation-failed': '无法安全初始化音频助手身份验证。',
		'launch-failed': '无法启动 Windows 音频助手。',
		'child-exited': 'Windows 音频助手已意外退出。',
		'readiness-timeout': '等待 Windows 音频助手启动超时。',
		'capture-start-timeout': '等待系统音频捕获启动超时。',
		'cleanup-failed': '系统音频会话已停止，但清理确认失败。',
		busy: '系统音频流程正在进行，请勿重复启动。',
		'connect-timeout': '连接 Windows 音频助手超时。',
		'auth-timeout': 'Windows 音频助手身份验证超时。',
		'heartbeat-timeout': 'Windows 音频助手连接已失去响应。',
		'stop-timeout': 'Windows 音频助手停止确认超时。',
		'connect-failed': '无法连接 Windows 音频助手。',
		'unexpected-disconnect': 'Windows 音频助手连接已关闭。',
		'invalid-endpoint': 'Windows 音频助手端点无效。',
		'token-missing': 'Windows 音频助手身份验证信息不可用。',
		'auth-failed': 'Windows 音频助手身份验证失败。',
		'protocol-incompatible': '插件与音频助手版本不兼容。',
		disposed: '系统音频助手已停止。',
		'protocol-error': 'Windows 音频助手返回了无效协议数据。',
		'remote-error': 'Windows 音频助手报告运行错误。',
		'not-configured': 'Windows 音频助手尚未配置。',
	};
	return messages[localCode] ?? '系统音频助手运行失败。';
}

function remoteErrorMessage(code: AudioCompanionRemoteErrorCode): string {
	const messages: Record<AudioCompanionRemoteErrorCode, string> = {
		SOURCE_UNAVAILABLE: '系统默认音频输出设备发生变化或不可用，请重新开始监听。',
		BUSY: '音频助手当前已有活动连接，请结束其他 Lecture Workflow 音频会话后重试。',
		AUTH_FAILED: '音频助手身份验证失败，请重新启动监听。',
		PROTOCOL_MISMATCH: '插件与音频助手版本不兼容。',
		CAPTURE_FAILED: '无法捕获系统音频，请重新尝试。',
		FORMAT_UNSUPPORTED: '当前系统音频格式暂不支持。',
		INVALID_REQUEST: '音频助手拒绝了当前请求。',
		INTERNAL_ERROR: '音频助手发生内部错误。',
	};
	return messages[code];
}

function isStartingOrActive(status: AudioCompanionRuntimeStatus): boolean {
	return status === 'launching'
		|| status === 'waiting-for-readiness'
		|| status === 'connecting'
		|| status === 'ready'
		|| status === 'capturing'
		|| status === 'stopping';
}
