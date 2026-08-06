import type { QwenRegion, SetupMode, TextProviderId } from './provider-types';

export interface LectureWorkflowSettings {
	notesFolder: string;
	setupMode: SetupMode;
	temperature: number;
	requestTimeoutMs: number;
	advancedTextProvider: TextProviderId;
	deepseek: {
		apiKey: string;
		baseUrl: string;
		model: string;
	};
	qwen: {
		apiKey: string;
		region: QwenRegion;
		workspaceId: string;
		model: string;
	};
	customOpenAI: {
		apiKey: string;
		baseUrl: string;
		model: string;
	};
}

export interface LectureNoteInput {
	course: string;
	topic: string;
	transcript: string;
}
