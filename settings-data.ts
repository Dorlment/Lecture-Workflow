import {
	DEEPSEEK_DEFAULT_BASE_URL,
	DEEPSEEK_DEFAULT_MODEL,
	QWEN_DEFAULT_MODEL,
} from './providers/text-providers';
import type { LectureWorkflowSettings } from './types';
import { MAX_VISION_IMAGE_COUNT } from './vision-limits';

export const QWEN_DEFAULT_VISION_MODEL = 'qwen3-vl-plus';

export const DEFAULT_SETTINGS: LectureWorkflowSettings = {
	notesFolder: '课堂笔记',
	setupMode: 'recommended',
	temperature: 0.3,
	requestTimeoutMs: 150_000,
	advancedTextProvider: 'deepseek',
	enableVisionInput: false,
	visionProvider: 'qwen',
	maxVisionImages: MAX_VISION_IMAGE_COUNT,
	deepseek: {
		apiKey: '',
		baseUrl: DEEPSEEK_DEFAULT_BASE_URL,
		model: DEEPSEEK_DEFAULT_MODEL,
	},
	qwen: {
		apiKey: '',
		region: 'cn-beijing',
		workspaceId: '',
		model: QWEN_DEFAULT_MODEL,
		visionModel: QWEN_DEFAULT_VISION_MODEL,
	},
	customOpenAI: {
		apiKey: '',
		baseUrl: '',
		model: '',
		supportsVision: false,
	},
};

export function normalizeSettings(
	savedSettings: Partial<LectureWorkflowSettings> | null | undefined,
): LectureWorkflowSettings {
	const saved = savedSettings ?? {};
	return {
		...DEFAULT_SETTINGS,
		...saved,
		enableVisionInput: typeof saved.enableVisionInput === 'boolean'
			? saved.enableVisionInput
			: DEFAULT_SETTINGS.enableVisionInput,
		visionProvider: saved.visionProvider === 'custom' || saved.visionProvider === 'qwen'
			? saved.visionProvider
			: DEFAULT_SETTINGS.visionProvider,
		maxVisionImages: normalizeVisionImageCount(saved.maxVisionImages),
		deepseek: { ...DEFAULT_SETTINGS.deepseek, ...saved.deepseek },
		qwen: { ...DEFAULT_SETTINGS.qwen, ...saved.qwen },
		customOpenAI: { ...DEFAULT_SETTINGS.customOpenAI, ...saved.customOpenAI },
	};
}

export function normalizeVisionImageCount(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return DEFAULT_SETTINGS.maxVisionImages;
	}
	return Math.min(MAX_VISION_IMAGE_COUNT, Math.max(1, Math.round(value)));
}
