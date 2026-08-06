import type { HttpClient, TextProviderId } from '../provider-types';
import { OpenAICompatibleTextProvider } from './openai-compatible';
import type { OpenAICompatibleConfig } from './openai-compatible';

export { ProviderError } from '../provider-types';

export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';
export const QWEN_DEFAULT_MODEL = 'qwen3.7-flash';

export interface QwenProviderConfig extends Omit<OpenAICompatibleConfig, 'baseUrl'> {
	region: 'cn-beijing';
	workspaceId: string;
}

export class DeepSeekTextProvider extends OpenAICompatibleTextProvider {
	readonly id: TextProviderId = 'deepseek';
	readonly displayName = 'DeepSeek';
}

export class QwenTextProvider extends OpenAICompatibleTextProvider {
	readonly id: TextProviderId = 'qwen';
	readonly displayName = 'Qwen / 阿里云百炼';
	private readonly qwenConfig: QwenProviderConfig;

	constructor(config: QwenProviderConfig, httpClient: HttpClient) {
		super({ ...config, baseUrl: buildQwenBaseUrl(config.region, config.workspaceId) }, httpClient);
		this.qwenConfig = config;
	}

	protected validateProviderConfig(): string[] {
		const errors: string[] = [];
		if (this.qwenConfig.region !== 'cn-beijing') {
			errors.push('当前仅支持华北2（北京）Region。');
		}
		if (!/^[a-zA-Z0-9_-]+$/.test(this.qwenConfig.workspaceId.trim())) {
			errors.push('Workspace ID 不能为空，且只能包含字母、数字、下划线和连字符。');
		}
		return errors;
	}
}

export class CustomOpenAICompatibleTextProvider extends OpenAICompatibleTextProvider {
	readonly id: TextProviderId = 'custom';
	readonly displayName = 'Custom OpenAI-compatible';
}

export function buildQwenBaseUrl(region: string, workspaceId: string): string {
	const normalizedWorkspaceId = workspaceId.trim().replace(/^\/+|\/+$/g, '');
	if (region !== 'cn-beijing' || !normalizedWorkspaceId) {
		return '';
	}
	return `https://${normalizedWorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`;
}
