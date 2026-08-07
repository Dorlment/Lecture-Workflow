import type {
	QwenRegion,
	SetupMode,
	TextProviderId,
	VisionProviderId,
} from './provider-types';

export interface LectureWorkflowSettings {
	notesFolder: string;
	setupMode: SetupMode;
	temperature: number;
	requestTimeoutMs: number;
	advancedTextProvider: TextProviderId;
	enableVisionInput: boolean;
	visionProvider: VisionProviderId;
	maxVisionImages: number;
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
		visionModel: string;
	};
	customOpenAI: {
		apiKey: string;
		baseUrl: string;
		model: string;
		supportsVision: boolean;
	};
}

export interface LectureNoteInput {
	course: string;
	topic: string;
	transcript: string;
}
