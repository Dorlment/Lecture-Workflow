import type { LectureWorkflowSettings } from '../types';
import type {
	HttpClient,
	TextProvider,
	TextProviderId,
	VisionProvider,
	VisionProviderId,
} from '../provider-types';
import { ProviderError } from '../provider-types';
import {
	CustomOpenAICompatibleTextProvider,
	DeepSeekTextProvider,
	QwenTextProvider,
} from './text-providers';
import {
	CustomOpenAICompatibleVisionProvider,
	QwenVisionProvider,
} from './vision-providers';

export class ProviderRegistry {
	constructor(
		private readonly settings: LectureWorkflowSettings,
		private readonly httpClient: HttpClient,
	) {}

	getActiveTextProviderId(): TextProviderId {
		return routeTextProvider(this.settings.setupMode, this.settings.advancedTextProvider);
	}

	getActiveTextProvider(): TextProvider {
		return this.getTextProvider(this.getActiveTextProviderId());
	}

	getTextProvider(id: TextProviderId): TextProvider {
		const common = {
			temperature: this.settings.temperature,
			timeoutMs: this.settings.requestTimeoutMs,
		};
		if (id === 'deepseek') {
			return new DeepSeekTextProvider({ ...this.settings.deepseek, ...common }, this.httpClient);
		}
		if (id === 'qwen') {
			return new QwenTextProvider({ ...this.settings.qwen, ...common }, this.httpClient);
		}
		return new CustomOpenAICompatibleTextProvider(
			{ ...this.settings.customOpenAI, ...common },
			this.httpClient,
		);
	}

	getSelectedVisionProvider(): VisionProvider {
		return this.getVisionProvider(this.settings.visionProvider);
	}

	getVisionProvider(id: VisionProviderId): VisionProvider {
		if (!this.settings.enableVisionInput) {
			throw new ProviderError('图片参与 AI 整理尚未启用。', 'configuration');
		}
		if (id !== this.settings.visionProvider) {
			throw new ProviderError('请求的视觉 Provider 与设置中明确选择的 Provider 不一致。', 'configuration');
		}
		return this.createVisionProvider(id);
	}

	getVisionProviderForConfirmedRetry(id: VisionProviderId): VisionProvider {
		if (!this.settings.enableVisionInput) {
			throw new ProviderError('图片参与 AI 整理尚未启用。', 'configuration');
		}
		return this.createVisionProvider(id);
	}

	private createVisionProvider(id: VisionProviderId): VisionProvider {
		const common = {
			temperature: this.settings.temperature,
			timeoutMs: this.settings.requestTimeoutMs,
		};
		if (id === 'qwen') {
			return new QwenVisionProvider({
				...this.settings.qwen,
				...common,
			}, this.httpClient);
		}
		if (!this.settings.customOpenAI.supportsVision) {
			throw new ProviderError(
				'自定义 Provider 未声明支持 OpenAI 图像输入格式，已阻止视觉请求。',
				'configuration',
			);
		}
		return new CustomOpenAICompatibleVisionProvider(
			{ ...this.settings.customOpenAI, ...common },
			this.httpClient,
		);
	}
}

export function routeTextProvider(
	setupMode: LectureWorkflowSettings['setupMode'],
	advancedProvider: TextProviderId,
): TextProviderId {
	if (setupMode === 'simple') {
		return 'qwen';
	}
	if (setupMode === 'recommended') {
		return 'deepseek';
	}
	return advancedProvider;
}
