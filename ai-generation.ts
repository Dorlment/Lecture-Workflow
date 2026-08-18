import {
	AI_END_MARKER,
	AI_START_MARKER,
	buildStructureUserPrompt,
	STRUCTURE_SYSTEM_PROMPT,
} from './ai-note';
import type { TextGenerationResult, TextProvider } from './provider-types';

export const STANDARD_TAKEAWAYS_HEADING = '## 💡 核心 Takeaways（3分钟速记）';
export const STRUCTURE_MAX_OUTPUT_TOKENS = 8192;

export interface AiGenerationOutcome {
	markdown: string;
	isComplete: boolean;
	incompleteReason: string | null;
	attempts: number;
	finishReason: string | null;
}

interface StructureValidation {
	markdown: string;
	isComplete: boolean;
	reason: string | null;
}

export async function generateStructuredMarkdown(
	provider: TextProvider,
	transcript: string,
	timelineContext?: string | null,
): Promise<AiGenerationOutcome> {
	const firstResult = await provider.generate({
		systemPrompt: STRUCTURE_SYSTEM_PROMPT,
		userPrompt: buildStructureUserPrompt(transcript, timelineContext),
		maxTokens: STRUCTURE_MAX_OUTPUT_TOKENS,
	});
	const firstValidation = validateAndNormalizeStructure(firstResult);
	if (isLengthTruncation(firstResult.finishReason)) {
		return incompleteOutcome(firstValidation.markdown, firstResult.finishReason, 1,
			'模型因输出长度限制提前停止，结果可能被截断。');
	}
	if (firstValidation.isComplete) {
		return completeOutcome(firstValidation.markdown, firstResult.finishReason, 1);
	}

	const repairedResult = await provider.generate({
		systemPrompt: STRUCTURE_SYSTEM_PROMPT,
		userPrompt: buildFormatRepairPrompt(
			transcript,
			firstValidation.markdown,
			firstValidation.reason,
		),
		maxTokens: STRUCTURE_MAX_OUTPUT_TOKENS,
	});
	const repairedValidation = validateAndNormalizeStructure(repairedResult);
	if (isLengthTruncation(repairedResult.finishReason)) {
		return incompleteOutcome(repairedValidation.markdown, repairedResult.finishReason, 2,
			'格式修复结果因输出长度限制提前停止，仍然不完整。');
	}
	if (!repairedValidation.isComplete) {
		return incompleteOutcome(
			repairedValidation.markdown,
			repairedResult.finishReason,
			2,
			`自动格式修复后结果仍不完整：${repairedValidation.reason ?? '格式校验失败。'}`,
		);
	}
	return completeOutcome(repairedValidation.markdown, repairedResult.finishReason, 2);
}

export function validateAndNormalizeStructure(result: TextGenerationResult): StructureValidation {
	const markdown = result.content.replace(/\r\n?/g, '\n');
	if (markdown.includes(AI_START_MARKER) || markdown.includes(AI_END_MARKER)) {
		return { markdown, isComplete: false, reason: '结果包含插件内部保护标记。' };
	}

	const lines = markdown.split('\n');
	let headingIndex = -1;
	for (let index = 0; index < lines.length; index += 1) {
		const heading = parseHeading(lines[index] ?? '');
		if (heading?.level === 2 && isTakeawaysTitle(heading.title)) {
			headingIndex = index;
			lines[index] = STANDARD_TAKEAWAYS_HEADING;
			break;
		}
	}
	if (headingIndex < 0) {
		return { markdown: lines.join('\n'), isComplete: false, reason: '缺少核心 Takeaways 二级标题。' };
	}

	let takeawayCount = 0;
	for (let index = headingIndex + 1; index < lines.length; index += 1) {
		const line = lines[index] ?? '';
		const heading = parseHeading(line);
		if (heading && heading.level <= 2) {
			break;
		}
		if (/^[ \t]{0,3}(?:[-+*]|\d+[.)、])[ \t]+\S/.test(line)) {
			takeawayCount += 1;
		}
	}
	if (takeawayCount < 3 || takeawayCount > 5) {
		return {
			markdown: lines.join('\n'),
			isComplete: false,
			reason: `核心 Takeaways 必须包含 3～5 条列表结论，当前检测到 ${takeawayCount} 条。`,
		};
	}
	return { markdown: lines.join('\n'), isComplete: true, reason: null };
}

export function assertAiOutputWritable(outcome: AiGenerationOutcome): void {
	if (!outcome.isComplete) {
		throw new Error(outcome.incompleteReason ?? 'AI 结果不完整，禁止写入。');
	}
}

export function isLengthTruncation(finishReason: string | null): boolean {
	if (!finishReason) {
		return false;
	}
	const normalized = finishReason.trim().toLowerCase().replace(/[ -]+/g, '_');
	return normalized === 'length'
		|| normalized === 'max_tokens'
		|| normalized === 'max_completion_tokens'
		|| normalized === 'max_output_tokens';
}

function parseHeading(line: string): { level: number; title: string } | null {
	const match = /^[ \t]{0,3}(#{1,6})[ \t]*(.*?)[ \t]*#*[ \t]*$/.exec(line);
	if (!match?.[1] || !match[2]) {
		return null;
	}
	return { level: match[1].length, title: match[2] };
}

function isTakeawaysTitle(title: string): boolean {
	const normalized = title
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '')
		.replace(/[\s:：·_-]+/g, '');
	return normalized.includes('核心takeaways') && normalized.includes('(3分钟速记)');
}

function buildFormatRepairPrompt(
	transcript: string,
	markdown: string,
	reason: string | null,
): string {
	return `上一次生成的课堂笔记格式不完整：${reason ?? '格式校验失败。'}
请修复格式，并重新返回完整的 Markdown 笔记正文，不能只返回速记区或局部补丁。
必须包含“${STANDARD_TAKEAWAYS_HEADING}”，并在该标题下给出 3～5 条 Markdown 列表结论。
继续遵守系统指令：忠实于现有内容，不补充无法确认的事实，不输出插件内部标记。

原始文字稿如下：

${transcript}

上一次完整输出如下：

${markdown}`;
}

function completeOutcome(
	markdown: string,
	finishReason: string | null,
	attempts: number,
): AiGenerationOutcome {
	return { markdown, isComplete: true, incompleteReason: null, attempts, finishReason };
}

function incompleteOutcome(
	markdown: string,
	finishReason: string | null,
	attempts: number,
	incompleteReason: string,
): AiGenerationOutcome {
	return { markdown, isComplete: false, incompleteReason, attempts, finishReason };
}
