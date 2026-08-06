export type SetupMode = 'simple' | 'recommended' | 'advanced';
export type TextProviderId = 'deepseek' | 'qwen' | 'custom';
export type QwenRegion = 'cn-beijing';

export interface ProviderCapabilities {
	text: boolean;
	vision: boolean;
	speech: boolean;
}

export interface TextGenerationRequest {
	systemPrompt: string;
	userPrompt: string;
	maxTokens?: number;
}

export interface TextGenerationResult {
	content: string;
	finishReason: string | null;
}

export interface TextProvider {
	readonly id: TextProviderId;
	readonly displayName: string;
	readonly capabilities: ProviderCapabilities;
	validate(): string[];
	generate(request: TextGenerationRequest): Promise<TextGenerationResult>;
	testConnection(): Promise<void>;
}

export interface VisionProvider {
	readonly id: string;
	readonly capabilities: ProviderCapabilities;
}

export interface SpeechProvider {
	readonly id: string;
	readonly capabilities: ProviderCapabilities;
}

export interface HttpRequest {
	url: string;
	headers: Record<string, string>;
	body: string;
	timeoutMs: number;
}

export interface HttpResponse {
	status: number;
	text: string;
}

export interface HttpClient {
	post(request: HttpRequest): Promise<HttpResponse>;
}

export type ProviderErrorCode =
	| 'configuration'
	| 'authentication'
	| 'not-found'
	| 'rate-limit'
	| 'timeout'
	| 'network'
	| 'server'
	| 'context-limit'
	| 'empty-response'
	| 'invalid-response';

export class ProviderError extends Error {
	constructor(
		message: string,
		readonly code: ProviderErrorCode,
		readonly status?: number,
	) {
		super(message);
		this.name = 'ProviderError';
	}
}
