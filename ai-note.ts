import { SubmissionGuard } from './lecture-note';

export const AI_START_MARKER = '<!-- lecture-workflow:ai:start -->';
export const AI_END_MARKER = '<!-- lecture-workflow:ai:end -->';

export type AiWorkflowState = 'idle' | 'generating' | 'preview';

export class AiWorkflowGate {
	private currentState: AiWorkflowState = 'idle';

	get state(): AiWorkflowState {
		return this.currentState;
	}

	beginGeneration(): boolean {
		if (this.currentState !== 'idle') {
			return false;
		}
		this.currentState = 'generating';
		return true;
	}

	showPreview(): void {
		if (this.currentState !== 'generating') {
			throw new Error('AI workflow is not generating.');
		}
		this.currentState = 'preview';
	}

	async completeWithPreview<T>(action: () => Promise<T>): Promise<T> {
		if (this.currentState !== 'generating') {
			throw new Error('AI workflow is not generating.');
		}
		try {
			const result = await action();
			this.showPreview();
			return result;
		} catch (error) {
			this.reset();
			throw error;
		}
	}

	reset(): void {
		this.currentState = 'idle';
	}
}

export class PreviewWriteSession {
	private cancelled = false;
	private readonly guard = new SubmissionGuard();

	cancel(): void {
		this.cancelled = true;
	}

	async confirm(action: () => Promise<boolean>): Promise<boolean | null> {
		if (this.cancelled || !this.guard.tryStart()) {
			return null;
		}
		try {
			return await action();
		} finally {
			this.guard.finish();
		}
	}
}

export interface TranscriptSection {
	transcript: string;
	protectedText: string;
	sectionStart: number;
	sectionEnd: number;
}

export const STRUCTURE_SYSTEM_PROMPT = `你是课堂笔记整理助手。只返回完整的 Markdown 正文，不要返回外层代码围栏，不要解释生成过程。
必须忠实整理原始文字稿，不得扩写成模型自己的教程，不得补充原稿不存在且无法确认的技术事实，也不得把常见情况表述成绝对规则。
对原稿中疑似错误或无法确认的内容，不要直接强化或擅自纠正；请标记“原稿表述可能需要核实”，且不要伪造纠正依据。
删除口水话、语气词、无关互动和重复。保留必要事实、步骤、原稿已有的代码和复杂例子；简单概念不要堆砌示例，不要凭空加入无关代码。
优先使用列表，减少连续长段文字。核心概念和重要结论使用加粗；对比内容使用 Markdown 表格；保持清晰标题层级。
输出必须以“# 课程大主题”及合理的二、三级标题组织，并且必须包含二级标题“## 💡 核心 Takeaways（3分钟速记）”。
该速记区必须包含 3～5 条 Markdown 列表结论。不要生成“## AI 结构化笔记”标题，插件会统一添加。`;

export function extractTranscriptSection(content: string): TranscriptSection | null {
	const headingPattern = /^##[ \t]+原始文字稿[ \t]*$/gm;
	const heading = headingPattern.exec(content);
	if (!heading) {
		return null;
	}
	let transcriptStart = heading.index + heading[0].length;
	if (content.startsWith('\r\n', transcriptStart)) {
		transcriptStart += 2;
	} else if (content.startsWith('\n', transcriptStart)) {
		transcriptStart += 1;
	}
	const nextHeadingPattern = /^##[ \t]+.+$/gm;
	nextHeadingPattern.lastIndex = transcriptStart;
	const nextHeading = nextHeadingPattern.exec(content);
	const markerIndex = content.indexOf(AI_START_MARKER, transcriptStart);
	const boundaries = [nextHeading?.index, markerIndex >= 0 ? markerIndex : undefined]
		.filter((index): index is number => index !== undefined);
	const sectionEnd = boundaries.length > 0 ? Math.min(...boundaries) : content.length;
	return {
		transcript: content.slice(transcriptStart, sectionEnd),
		protectedText: content.slice(heading.index, sectionEnd),
		sectionStart: heading.index,
		sectionEnd,
	};
}

export function hasAiRegion(content: string): boolean {
	return content.includes(AI_START_MARKER) && content.includes(AI_END_MARKER);
}

export function applyStructuredResult(content: string, generatedMarkdown: string): string {
	const originalTranscript = extractTranscriptSection(content);
	if (!originalTranscript) {
		throw new Error('找不到“## 原始文字稿”标题。');
	}
	const normalizedResult = stripOuterMarkdownFence(generatedMarkdown);
	if (!normalizedResult.trim()) {
		throw new Error('AI 返回了空内容。');
	}
	if (normalizedResult.includes(AI_START_MARKER) || normalizedResult.includes(AI_END_MARKER)) {
		throw new Error('AI 返回内容包含插件保护标记，已中止写入。');
	}
	const region = `${AI_START_MARKER}\n## AI 结构化笔记\n\n${normalizedResult.trim()}\n${AI_END_MARKER}`;
	let updated = replaceOrInsertAiRegion(content, region);
	updated = updateFrontmatterStatus(updated);
	const updatedTranscript = extractTranscriptSection(updated);
	if (!updatedTranscript || updatedTranscript.protectedText !== originalTranscript.protectedText) {
		throw new Error('原始文字稿保护校验失败，已中止写入。');
	}
	return updated;
}

export function buildStructureUserPrompt(transcript: string, timelineContext?: string | null): string {
	const base = `请整理以下课堂原始文字稿。不得遗漏重要事实，也不得添加文字稿中不存在的信息。\n\n${transcript}`;
	if (timelineContext) {
		return `${base}\n\n${timelineContext}`;
	}
	return base;
}

function replaceOrInsertAiRegion(content: string, region: string): string {
	const startIndex = content.indexOf(AI_START_MARKER);
	const endIndex = content.indexOf(AI_END_MARKER);
	if ((startIndex >= 0) !== (endIndex >= 0) || (startIndex >= 0 && endIndex < startIndex)) {
		throw new Error('现有 AI 区域标记不完整，已中止写入。');
	}
	if (startIndex >= 0 && endIndex >= 0) {
		const secondStart = content.indexOf(AI_START_MARKER, startIndex + AI_START_MARKER.length);
		const secondEnd = content.indexOf(AI_END_MARKER, endIndex + AI_END_MARKER.length);
		if (secondStart >= 0 || secondEnd >= 0) {
			throw new Error('检测到多个 AI 区域，已中止写入。');
		}
		return `${content.slice(0, startIndex)}${region}${content.slice(endIndex + AI_END_MARKER.length)}`;
	}

	const legacyHeading = /^##[ \t]+AI 整理结果[ \t]*$/gm;
	const legacy = legacyHeading.exec(content);
	if (legacy) {
		const nextHeading = /^##[ \t]+.+$/gm;
		nextHeading.lastIndex = legacy.index + legacy[0].length;
		const next = nextHeading.exec(content);
		const end = next?.index ?? content.length;
		return `${content.slice(0, legacy.index)}${region}\n${content.slice(end)}`;
	}
	const separator = content.endsWith('\n\n')
		? ''
		: content.endsWith('\n')
			? '\n'
			: '\n\n';
	return `${content}${separator}${region}\n`;
}

function updateFrontmatterStatus(content: string): string {
	const frontmatter = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(content);
	if (!frontmatter) {
		return content;
	}
	const body = frontmatter[2] ?? '';
	const lineEnding = frontmatter[1]?.includes('\r\n') ? '\r\n' : '\n';
	const updatedBody = /^status:[^\r\n]*$/m.test(body)
		? body.replace(/^status:[^\r\n]*$/m, 'status: structured')
		: `${body}${body ? lineEnding : ''}status: structured`;
	return `${frontmatter[1]}${updatedBody}${frontmatter[3]}${content.slice(frontmatter[0].length)}`;
}

function stripOuterMarkdownFence(value: string): string {
	const trimmed = value.trim();
	const match = /^```(?:markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
	return match?.[1] ?? trimmed;
}
