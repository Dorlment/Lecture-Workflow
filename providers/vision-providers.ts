import type {
	HttpClient,
	ProviderCapabilities,
	ProviderResponse,
	VisionGenerationRequest,
	VisionProvider,
	VisionProviderId,
} from '../provider-types';
import { ProviderError } from '../provider-types';
import {
	OpenAICompatibleChatClient,
} from './openai-compatible';
import type {
	OpenAICompatibleConfig,
	OpenAICompatibleUserContent,
} from './openai-compatible';
import { buildQwenBaseUrl } from './text-providers';

export const VISION_DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const SUPPORTED_VISION_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export interface QwenVisionProviderConfig {
	apiKey: string;
	region: 'cn-beijing';
	workspaceId: string;
	visionModel: string;
	temperature: number;
	timeoutMs: number;
}

export interface CustomVisionProviderConfig extends OpenAICompatibleConfig {
	supportsVision: boolean;
}

abstract class OpenAICompatibleVisionProvider implements VisionProvider {
	abstract readonly id: VisionProviderId;
	abstract readonly displayName: string;
	abstract readonly capabilities: ProviderCapabilities;

	constructor(
		private readonly chatClient: OpenAICompatibleChatClient,
		private readonly temperature: number,
	) {}

	validateVision(request?: VisionGenerationRequest): string[] {
		return [
			...this.validateProviderConfig(),
			...(request ? validateVisionRequest(request) : []),
		];
	}

	async generateVision(
		request: VisionGenerationRequest,
		signal?: AbortSignal,
	): Promise<ProviderResponse> {
		const validationErrors = this.validateVision(request);
		if (validationErrors.length > 0) {
			throw new ProviderError(validationErrors.join(' '), 'configuration');
		}
		return this.chatClient.complete(
			{
				systemPrompt: request.systemPrompt,
				userContent: buildVisionUserContent(request),
				temperature: this.temperature,
				maxTokens: request.maxTokens ?? VISION_DEFAULT_MAX_OUTPUT_TOKENS,
			},
			signal,
		);
	}

	protected abstract validateProviderConfig(): string[];
}

export class QwenVisionProvider extends OpenAICompatibleVisionProvider {
	readonly id = 'qwen' as const;
	readonly displayName = 'Qwen-VL / 阿里云百炼';
	readonly capabilities: ProviderCapabilities = {
		text: true,
		vision: true,
		speech: false,
	};
	private readonly qwenConfig: QwenVisionProviderConfig;
	private readonly configClient: OpenAICompatibleChatClient;

	constructor(config: QwenVisionProviderConfig, httpClient: HttpClient) {
		const compatibleConfig: OpenAICompatibleConfig = {
			apiKey: config.apiKey,
			baseUrl: buildQwenBaseUrl(config.region, config.workspaceId),
			model: config.visionModel,
			temperature: config.temperature,
			timeoutMs: config.timeoutMs,
		};
		const client = new OpenAICompatibleChatClient(compatibleConfig, httpClient);
		super(client, config.temperature);
		this.qwenConfig = config;
		this.configClient = client;
	}

	protected validateProviderConfig(): string[] {
		const errors = this.configClient.validateConfig();
		if (this.qwenConfig.region !== 'cn-beijing') {
			errors.push('当前仅支持华北2（北京）Region。');
		}
		if (!/^[a-zA-Z0-9_-]+$/.test(this.qwenConfig.workspaceId.trim())) {
			errors.push('Workspace ID 不能为空，且只能包含字母、数字、下划线和连字符。');
		}
		return errors;
	}
}

export class CustomOpenAICompatibleVisionProvider extends OpenAICompatibleVisionProvider {
	readonly id = 'custom' as const;
	readonly displayName = 'Custom OpenAI-compatible Vision';
	readonly capabilities: ProviderCapabilities;
	private readonly customConfig: CustomVisionProviderConfig;
	private readonly configClient: OpenAICompatibleChatClient;

	constructor(config: CustomVisionProviderConfig, httpClient: HttpClient) {
		const client = new OpenAICompatibleChatClient(
			config,
			httpClient,
			undefined,
			(status) => [400, 415, 422].includes(status)
				? new ProviderError(
					'自定义 Provider 拒绝了图像输入；视觉支持仅为用户声明，插件无法保证服务端兼容。',
					'server',
					status,
				)
				: null,
		);
		super(client, config.temperature);
		this.customConfig = config;
		this.configClient = client;
		this.capabilities = {
			text: true,
			vision: config.supportsVision === true,
			speech: false,
		};
	}

	protected validateProviderConfig(): string[] {
		const errors = this.configClient.validateConfig();
		if (!this.customConfig.supportsVision) {
			errors.push('自定义 Provider 未启用图片支持；该能力由用户声明，插件无法保证服务端兼容。');
		}
		return errors;
	}
}

export function buildVisionUserContent(
	request: Pick<VisionGenerationRequest, 'textPrompt' | 'images'>,
): OpenAICompatibleUserContent {
	const content: Exclude<OpenAICompatibleUserContent, string> = [
		{ type: 'text', text: request.textPrompt },
	];
	for (const image of request.images) {
		content.push({
			type: 'text',
			text: `图片编号：${image.id}\n附近文字：${image.nearbyContext}`,
		});
		content.push({
			type: 'image_url',
			image_url: { url: image.dataUrl },
		});
	}
	return content;
}

export function validateVisionRequest(request: VisionGenerationRequest): string[] {
	const errors: string[] = [];
	if (request.images.length === 0) {
		errors.push('视觉请求至少需要一张图片。');
		return errors;
	}
	const seenIds = new Set<string>();
	for (const image of request.images) {
		if (!image.id.trim()) {
			errors.push('图片 ID 不能为空。');
		} else if (seenIds.has(image.id)) {
			errors.push(`图片 ID 重复：${image.id}。`);
		}
		seenIds.add(image.id);
		if (!SUPPORTED_VISION_MIME_TYPES.has(image.mimeType)) {
			errors.push(`图片 ${image.id || '(无 ID)'} 使用了不支持的 MIME 类型。`);
			continue;
		}
		const prefix = `data:${image.mimeType};base64,`;
		if (!image.dataUrl.startsWith(prefix) || image.dataUrl.length === prefix.length) {
			errors.push(`图片 ${image.id || '(无 ID)'} 的 MIME 类型与 Data URL 不一致或内容为空。`);
		}
	}
	return errors;
}
