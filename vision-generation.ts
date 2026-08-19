import {
	STRUCTURE_SYSTEM_PROMPT,
} from './ai-note';
import {
	STANDARD_TAKEAWAYS_HEADING,
	STRUCTURE_MAX_OUTPUT_TOKENS,
	validateAndNormalizeStructure,
} from './ai-generation';
import type { GenerationDiagnostics } from './generation-diagnostics';
import { estimateInputTokens } from './generation-diagnostics';
import { validateAndRestoreImagePlaceholders } from './image-placeholders';
import type {
	ProviderResponse,
	TextProvider,
	VisionImageInput,
	VisionProvider,
} from './provider-types';
import type { ResolvedVisionImage } from './vision-types';

export const VISION_SYSTEM_PROMPT = `${STRUCTURE_SYSTEM_PROMPT}

你还会收到按原始顺序编号的课堂图片。请理解 PPT、板书、流程图和代码截图，并把图片信息与相邻文字知识点结合，避免重复叙述图文中相同内容。
无法识别的图片内容不得猜测，不得伪造图片中不存在的文字、事实或结论。不得输出 Base64、Data URL、附件路径，也不得直接输出 Wiki 或 Markdown 图片语法。
唯一允许的图片输出形式是 {{IMAGE:IMG_001}}。占位符必须独立成行，放在最相关知识点解释之后；同一图片最多出现一次。无法确定位置时可以遗漏，插件会把遗漏图片放入“## 相关课堂图片”。不得解释占位符协议。`;

export const VISION_REPAIR_SYSTEM_PROMPT = `你是课堂笔记 Markdown 格式修复助手。只返回修复后的完整 Markdown 正文，不要返回代码围栏或解释。
忠实保留上一次输出的信息，不扩写、不编造。必须修复 Takeaways 和图片占位符格式；不得输出 Base64、Data URL、附件路径、Wiki 图片语法或 Markdown 图片语法。`;

export const VISION_EVIDENCE_SYSTEM_PROMPT = `你是课堂图片视觉分析助手。请只根据图片内容输出简洁、可验证的视觉事实，不要生成 Markdown 笔记，不要猜测，不要输出 Base64、Data URL 或附件路径。
对于每张图片，用 1-2 句话描述图片中清晰可见的文字、图表结构或关键信息。如果图片内容无法确认，说明“无法确认”。`;

export interface VisionGenerationOutcome {
	markdown: string;
	isComplete: boolean;
	incompleteReason: string | null;
	attempts: number;
	finishReason: string | null;
	diagnostics?: GenerationDiagnostics;
}

interface VisionOutputValidation {
	markdown: string;
	isComplete: boolean;
	reason: string | null;
}

interface VisionRepairImageSummary {
	id: string;
	nearbyContext: string;
}

export async function generateVisionStructuredMarkdown(
	visionProvider: VisionProvider,
	repairProvider: TextProvider,
	transcript: string,
	images: ResolvedVisionImage[],
	signal?: AbortSignal,
	timelineContext?: string | null,
	sourceImageCount?: number,
): Promise<VisionGenerationOutcome> {
	const startedAt = Date.now();
	let visionDurationMs: number | undefined;
	let textDurationMs = 0;
	const imageInputs: VisionImageInput[] = images.map((image) => ({
		id: image.id,
		mimeType: image.mimeType,
		dataUrl: image.dataUrl,
		nearbyContext: image.nearbyContext,
	}));
	const repairSummaries: VisionRepairImageSummary[] = images.map((image) => ({
		id: image.id,
		nearbyContext: sanitizeRepairText(image.nearbyContext),
	}));
	const references = images.map((image) => ({
		id: image.id,
		originalReference: image.originalReference,
	}));

	// Step 1: Vision provider extracts concise visual evidence from classroom images.
	let evidenceResult: ProviderResponse;
	const visionStartedAt = Date.now();
	try {
		evidenceResult = await visionProvider.generateVision({
			systemPrompt: VISION_EVIDENCE_SYSTEM_PROMPT,
			textPrompt: buildVisionEvidencePrompt(images, timelineContext),
			images: imageInputs,
			maxTokens: 2048,
		}, signal);
	} finally {
		visionDurationMs = Date.now() - visionStartedAt;
		clearVisionImageInputs(imageInputs);
	}
	const visualEvidence = evidenceResult.content.trim();

	// Step 2: Text provider generates the final structured Markdown using
	// the full transcript, timeline context, and visual evidence.
	const finalUserPrompt = buildVisionTextPrompt(transcript, timelineContext, visualEvidence);
	let textStartedAt = Date.now();
	const firstResult = await repairProvider.generate({
		systemPrompt: VISION_SYSTEM_PROMPT,
		userPrompt: finalUserPrompt,
		maxTokens: STRUCTURE_MAX_OUTPUT_TOKENS,
	}, signal);
	textDurationMs += Date.now() - textStartedAt;
	const firstValidation = validateVisionOutput(firstResult, references);
	if (isIncompleteVisionFinishReason(firstResult.finishReason)) {
		return withDiagnostics(incompleteOutcome(
			firstValidation.markdown,
			firstResult.finishReason,
			1,
			`文本整理模型因 ${firstResult.finishReason ?? '未知原因'} 提前停止，结果可能不完整。`,
		), transcript, images.length, sourceImageCount, startedAt, visionDurationMs, textDurationMs);
	}
	if (firstValidation.isComplete) {
		return withDiagnostics(completeOutcome(firstValidation.markdown, firstResult.finishReason, 1),
			transcript, images.length, sourceImageCount, startedAt, visionDurationMs, textDurationMs);
	}

	// Step 3: Text provider repairs format if needed.
	let repairedResult: ProviderResponse;
	textStartedAt = Date.now();
	try {
		repairedResult = await repairProvider.generate({
			systemPrompt: VISION_REPAIR_SYSTEM_PROMPT,
			userPrompt: buildVisionRepairPrompt(
				firstValidation.markdown,
				repairSummaries,
				firstValidation.reason,
			),
			maxTokens: STRUCTURE_MAX_OUTPUT_TOKENS,
		}, signal);
	} catch {
		textDurationMs += Date.now() - textStartedAt;
		return withDiagnostics(incompleteOutcome(
			firstValidation.markdown,
			firstResult.finishReason,
			2,
			'自动格式修复请求失败，已保留首次结果供复制。',
		), transcript, images.length, sourceImageCount, startedAt, visionDurationMs, textDurationMs);
	}
	textDurationMs += Date.now() - textStartedAt;
	const repairedValidation = validateVisionOutput(repairedResult, references);
	if (isIncompleteVisionFinishReason(repairedResult.finishReason)) {
		return withDiagnostics(incompleteOutcome(
			repairedValidation.markdown,
			repairedResult.finishReason,
			2,
			'视觉格式修复请求提前停止，结果仍然不完整。',
		), transcript, images.length, sourceImageCount, startedAt, visionDurationMs, textDurationMs);
	}
	if (!repairedValidation.isComplete) {
		return withDiagnostics(incompleteOutcome(
			repairedValidation.markdown,
			repairedResult.finishReason,
			2,
			`自动格式修复后结果仍不完整：${repairedValidation.reason ?? '格式校验失败。'}`,
		), transcript, images.length, sourceImageCount, startedAt, visionDurationMs, textDurationMs);
	}
	return withDiagnostics(completeOutcome(repairedValidation.markdown, repairedResult.finishReason, 2),
		transcript, images.length, sourceImageCount, startedAt, visionDurationMs, textDurationMs);
}

export function buildVisionEvidencePrompt(
	images: ResolvedVisionImage[],
	timelineContext?: string | null,
): string {
	const imageList = images
		.map((image) => `- ${image.id}：${sanitizeRepairText(image.nearbyContext)}`)
		.join('\n');
	return `请分析以下课堂图片，只输出图片中清晰可见的文字和关键视觉信息。

${timelineContext ? `${timelineContext}\n\n` : ''}图片列表：
${imageList}`;
}

export function buildVisionTextPrompt(
	transcript: string,
	timelineContext?: string | null,
	visualEvidence?: string | null,
): string {
	const base = `请整理以下课堂原始文字稿，并结合视觉证据生成结构化笔记。不得遗漏重要事实，也不得添加文字稿和视觉证据中不存在的信息。

课堂原始文字稿：

${transcript}

${timelineContext ? `${timelineContext}\n\n` : ''}视觉证据：
${visualEvidence ?? ''}

当文字稿中的技术术语、产品名、英文专有名词与视觉证据中清晰可见的文字冲突时，优先采用视觉证据中明确可见的拼写。不要修改原始文字稿，不要对无视觉证据的内容进行猜测或自动纠错。

图片占位符必须独立成行，使用 {{IMAGE:IMG_001}} 格式。同一图片最多出现一次。无法确定位置时可以遗漏，插件会把遗漏图片放入“## 相关课堂图片”。不得解释占位符协议。`;
	return base;
}

export function buildVisionRepairPrompt(
	markdown: string,
	images: VisionRepairImageSummary[],
	reason: string | null,
): string {
	const imageList = images
		.map((image) => `- ${image.id}：${sanitizeRepairText(image.nearbyContext)}`)
		.join('\n');
	return `上一次视觉整理结果格式不完整：${sanitizeRepairText(reason ?? '格式校验失败。')}
请重新返回修复后的完整 Markdown，不能只返回局部补丁。

必须包含“${STANDARD_TAKEAWAYS_HEADING}”，并包含 3～5 条 Markdown 列表结论。
合法图片 ID 及简短附近文字如下：
${imageList}

每个图片 ID 最多使用一次，唯一允许的格式为独立行 {{IMAGE:IMG_001}}。可以遗漏无法定位的合法图片，插件会确定性追加；不得创造未知 ID，不得直接输出图片嵌入。

上一次完整输出：

${sanitizeRepairText(markdown)}`;
}

export function validateVisionOutput(
	result: ProviderResponse,
	images: Array<{ id: string; originalReference: string }>,
): VisionOutputValidation {
	const fencedContent = stripOuterMarkdownFence(result.content).replace(/\r\n?/g, '\n');
	const structure = validateAndNormalizeStructure({
		content: fencedContent,
		finishReason: result.finishReason,
	});
	const placeholders = validateAndRestoreImagePlaceholders(structure.markdown, images);
	const placeholderInvalid = placeholders.status.startsWith('invalid-');
	const reasons = [
		...(structure.isComplete ? [] : [structure.reason]),
		...(placeholderInvalid ? [placeholders.message] : []),
	].filter((reason): reason is string => Boolean(reason));
	if (!structure.isComplete || placeholderInvalid) {
		return {
			markdown: structure.markdown,
			isComplete: false,
			reason: reasons.join(' '),
		};
	}
	return {
		markdown: placeholders.restoredMarkdown ?? structure.markdown,
		isComplete: true,
		reason: null,
	};
}

export function isIncompleteVisionFinishReason(finishReason: string | null): boolean {
	if (!finishReason) {
		return false;
	}
	const normalized = finishReason.trim().toLowerCase().replace(/[ -]+/g, '_');
	return !['stop', 'completed', 'complete', 'end_turn'].includes(normalized);
}

export function clearVisionImageInputs(images: VisionImageInput[]): void {
	for (const image of images) {
		image.dataUrl = '';
	}
	images.splice(0, images.length);
}

function stripOuterMarkdownFence(value: string): string {
	const trimmed = value.trim();
	const match = /^```(?:markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
	return match?.[1] ?? trimmed;
}

function sanitizeRepairText(value: string): string {
	return value
		.replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/_=-]*/gi, '[已移除图片数据]')
		.replace(/\b(?:sk-)[a-z0-9_-]{12,}\b/gi, '[已移除敏感内容]');
}

function withDiagnostics(
	outcome: VisionGenerationOutcome,
	transcript: string,
	selectedImageCount: number,
	sourceImageCount: number | undefined,
	startedAt: number,
	visionDurationMs: number | undefined,
	textDurationMs: number,
): VisionGenerationOutcome {
	return {
		...outcome,
		diagnostics: {
			transcriptChars: transcript.length,
			estimatedInputTokens: estimateInputTokens(transcript.length),
			sourceImageCount: sourceImageCount ?? selectedImageCount,
			selectedImageCount,
			visionDurationMs,
			textDurationMs,
			totalDurationMs: Date.now() - startedAt,
			finishReason: outcome.finishReason,
			attempts: outcome.attempts,
			isComplete: outcome.isComplete,
			incompleteReason: outcome.incompleteReason,
		},
	};
}

function completeOutcome(
	markdown: string,
	finishReason: string | null,
	attempts: number,
): VisionGenerationOutcome {
	return { markdown, isComplete: true, incompleteReason: null, attempts, finishReason };
}

function incompleteOutcome(
	markdown: string,
	finishReason: string | null,
	attempts: number,
	incompleteReason: string,
): VisionGenerationOutcome {
	return { markdown, isComplete: false, incompleteReason, attempts, finishReason };
}
