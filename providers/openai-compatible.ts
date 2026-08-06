import type {
	HttpClient,
	ProviderCapabilities,
	TextGenerationRequest,
	TextGenerationResult,
	TextProvider,
	TextProviderId,
} from '../provider-types';
import { ProviderError } from '../provider-types';

export interface OpenAICompatibleConfig {
	apiKey: string;
	baseUrl: string;
	model: string;
	temperature: number;
	timeoutMs: number;
}

interface ChatCompletionResponse {
	choices?: Array<{
		finish_reason?: unknown;
		message?: {
			content?: unknown;
		};
	}>;
	error?: {
		message?: unknown;
	};
}

export abstract class OpenAICompatibleTextProvider implements TextProvider {
	abstract readonly id: TextProviderId;
	abstract readonly displayName: string;
	readonly capabilities: ProviderCapabilities = {
		text: true,
		vision: false,
		speech: false,
	};

	constructor(
		protected readonly config: OpenAICompatibleConfig,
		private readonly httpClient: HttpClient,
	) {}

	validate(): string[] {
		const errors: string[] = [];
		if (!this.config.apiKey.trim()) {
			errors.push('缺少 API Key。');
		}
		if (!this.config.model.trim()) {
			errors.push('缺少模型名称。');
		}
		try {
			normalizeBaseUrl(this.config.baseUrl);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
		if (!Number.isFinite(this.config.temperature) || this.config.temperature < 0 || this.config.temperature > 2) {
			errors.push('Temperature 必须在 0 到 2 之间。');
		}
		if (!Number.isFinite(this.config.timeoutMs) || this.config.timeoutMs < 1000) {
			errors.push('请求超时必须至少为 1000 毫秒。');
		}
		return [...errors, ...this.validateProviderConfig()];
	}

	async generate(request: TextGenerationRequest): Promise<TextGenerationResult> {
		return this.complete(request, false);
	}

	async testConnection(): Promise<void> {
		await this.complete(
			{
				systemPrompt: 'You are a connection test. Reply with exactly OK.',
				userPrompt: 'OK',
				maxTokens: 8,
			},
			true,
		);
	}

	protected validateProviderConfig(): string[] {
		return [];
	}

	protected providerErrorMessage(message: string): string {
		return message;
	}

	private async complete(
		request: TextGenerationRequest,
		isConnectionTest: boolean,
	): Promise<TextGenerationResult> {
		const validationErrors = this.validate();
		if (validationErrors.length > 0) {
			throw new ProviderError(validationErrors.join(' '), 'configuration');
		}

		const endpoint = `${normalizeBaseUrl(this.config.baseUrl)}/chat/completions`;
		const body = JSON.stringify({
			model: this.config.model.trim(),
			messages: [
				{ role: 'system', content: request.systemPrompt },
				{ role: 'user', content: request.userPrompt },
			],
			temperature: isConnectionTest ? 0 : this.config.temperature,
			max_tokens: request.maxTokens,
			stream: false,
		});
		const response = await this.httpClient.post({
			url: endpoint,
			headers: {
				Authorization: `Bearer ${this.config.apiKey.trim()}`,
			},
			body,
			timeoutMs: this.config.timeoutMs,
		});

		let payload: ChatCompletionResponse;
		try {
			payload = JSON.parse(response.text) as ChatCompletionResponse;
		} catch {
			if (response.status >= 400) {
				throw statusError(response.status, '服务返回了非 JSON 错误响应。');
			}
			throw new ProviderError('服务返回格式异常。', 'invalid-response', response.status);
		}

		if (response.status >= 400) {
			const rawMessage = typeof payload.error?.message === 'string'
				? payload.error.message
				: '服务请求失败。';
			throw statusError(response.status, this.providerErrorMessage(rawMessage));
		}

		const content = payload.choices?.[0]?.message?.content;
		if (typeof content !== 'string') {
			throw new ProviderError('服务返回格式异常。', 'invalid-response', response.status);
		}
		if (!content.trim()) {
			throw new ProviderError('服务返回了空内容。', 'empty-response', response.status);
		}
		const finishReason = payload.choices?.[0]?.finish_reason;
		return {
			content,
			finishReason: typeof finishReason === 'string' ? finishReason : null,
		};
	}
}

export function normalizeBaseUrl(value: string): string {
	const trimmed = value.trim();
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error('Base URL 无效。');
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new Error('Base URL 必须使用 HTTP 或 HTTPS。');
	}
	if (url.search || url.hash) {
		throw new Error('Base URL 不能包含查询参数或片段。');
	}
	url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '');
	return url.toString().replace(/\/$/, '');
}

function statusError(status: number, rawMessage: string): ProviderError {
	const message = rawMessage.toLowerCase();
	if (status === 401 || status === 403) {
		return new ProviderError('API Key 无效或没有访问权限。', 'authentication', status);
	}
	if (status === 404) {
		return new ProviderError('Base URL 或模型名称不正确。', 'not-found', status);
	}
	if (status === 429) {
		return new ProviderError('请求受到限流，或账户额度不足。', 'rate-limit', status);
	}
	if (message.includes('context') || message.includes('maximum') || message.includes('too long')) {
		return new ProviderError('文字稿超出模型上下文限制；当前版本不会静默截断，请缩短文字稿后重试。', 'context-limit', status);
	}
	if (status >= 500) {
		return new ProviderError('AI 服务暂时不可用，请稍后重试。', 'server', status);
	}
	return new ProviderError(`AI 请求失败（HTTP ${status}）。`, 'server', status);
}
