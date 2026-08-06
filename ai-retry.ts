import type { ProviderErrorCode, TextProviderId } from './provider-types';

export interface AiRetryOption {
	providerId: TextProviderId;
	label: string;
}

export interface SafeProviderFailure {
	message: string;
	code: ProviderErrorCode | 'unknown';
	isRetryableConnectionFailure: boolean;
}

export function describeProviderFailure(providerName: string, error: unknown): SafeProviderFailure {
	const code = readProviderErrorCode(error);
	const descriptions: Record<SafeProviderFailure['code'], string> = {
		configuration: '配置不完整或无效。',
		authentication: 'API Key 无效或没有访问权限。',
		'not-found': 'Base URL 或模型名称不正确。',
		'rate-limit': '账户额度不足或请求受到限流。',
		timeout: '请求超时；长文字稿或代理/VPN 可能影响连接。',
		network: '网络连接失败；请检查网络、代理或 VPN。',
		server: '服务端暂时不可用。',
		'context-limit': '文字稿超出模型上下文限制，内容没有被静默截断。',
		'empty-response': '服务返回了空内容。',
		'invalid-response': '服务返回格式异常。',
		unknown: '发生未知错误，请重试或检查 Provider 设置。',
	};
	return {
		message: `${providerName}（${errorTypeLabel(code)}）：${descriptions[code]}`,
		code,
		isRetryableConnectionFailure: code === 'timeout' || code === 'network',
	};
}

function readProviderErrorCode(error: unknown): ProviderErrorCode | 'unknown' {
	if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'string') {
		return 'unknown';
	}
	const knownCodes: ProviderErrorCode[] = [
		'configuration',
		'authentication',
		'not-found',
		'rate-limit',
		'timeout',
		'network',
		'server',
		'context-limit',
		'empty-response',
		'invalid-response',
	];
	return knownCodes.includes(error.code as ProviderErrorCode)
		? error.code as ProviderErrorCode
		: 'unknown';
}

export function buildRetryOptions(
	failedProviderId: TextProviderId,
	qwenConfigured: boolean,
): AiRetryOption[] {
	const sameProvider: AiRetryOption = {
		providerId: failedProviderId,
		label: `使用 ${providerLabel(failedProviderId)} 重试`,
	};
	if (failedProviderId !== 'deepseek' || !qwenConfigured) {
		return [sameProvider];
	}
	return [
		sameProvider,
		{ providerId: 'qwen', label: '改用 Qwen 重试' },
	];
}

function providerLabel(id: TextProviderId): string {
	if (id === 'deepseek') {
		return 'DeepSeek';
	}
	if (id === 'qwen') {
		return 'Qwen';
	}
	return 'Custom Provider';
}

function errorTypeLabel(code: SafeProviderFailure['code']): string {
	const labels: Record<SafeProviderFailure['code'], string> = {
		configuration: '配置错误',
		authentication: '认证错误',
		'not-found': '地址或模型错误',
		'rate-limit': '额度或限流',
		timeout: '超时',
		network: '网络错误',
		server: '服务器错误',
		'context-limit': '上下文超限',
		'empty-response': '空响应',
		'invalid-response': '响应格式错误',
		unknown: '未知错误',
	};
	return labels[code];
}
