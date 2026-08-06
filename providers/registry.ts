import type { LectureWorkflowSettings } from '../types';
import type { HttpClient, TextProvider, TextProviderId } from '../provider-types';
import {
	CustomOpenAICompatibleTextProvider,
	DeepSeekTextProvider,
	QwenTextProvider,
} from './text-providers';

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
