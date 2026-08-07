import {
	findDirectImageEmbeds,
	getIgnoredMarkdownRanges,
	isAllowedMarkdownRange,
} from './image-references';
import type {
	ResolvedVisionImage,
	VisionPlaceholderValidationResult,
} from './vision-types';

interface PlaceholderOccurrence {
	id: string;
	start: number;
	end: number;
	original: string;
}

const RELATED_IMAGES_HEADING = '## 相关课堂图片';

export function validateAndRestoreImagePlaceholders(
	markdown: string,
	images: Array<Pick<ResolvedVisionImage, 'id' | 'originalReference'>>,
): VisionPlaceholderValidationResult {
	if (findDirectImageEmbeds(markdown).length > 0) {
		return invalidResult('invalid-direct-embed', '模型输出包含了未经占位符验证的图片嵌入。');
	}
	const occurrences = collectPlaceholderOccurrences(markdown);
	let withoutRecognizedPlaceholders = markdown;
	for (const occurrence of occurrences.slice().sort((left, right) => right.start - left.start)) {
		withoutRecognizedPlaceholders = `${withoutRecognizedPlaceholders.slice(0, occurrence.start)}${withoutRecognizedPlaceholders.slice(occurrence.end)}`;
	}
	if (withoutRecognizedPlaceholders.includes('{{IMAGE:')) {
		return invalidResult('invalid-unknown-id', '模型输出包含无法识别的图片占位符。');
	}
	const ignoredRanges = getIgnoredMarkdownRanges(markdown);
	for (const occurrence of occurrences) {
		if (!isAllowedMarkdownRange(occurrence.start, occurrence.end, ignoredRanges)
			|| !isStandaloneLine(markdown, occurrence)) {
			return invalidResult('invalid-placement', `图片占位符 ${occurrence.id} 必须单独占一行且不能位于代码块中。`);
		}
	}
	const known = new Map(images.map((image) => [image.id, image] as const));
	for (const occurrence of occurrences) {
		if (!known.has(occurrence.id)) {
			return invalidResult('invalid-unknown-id', `模型引用了未知图片编号 ${occurrence.id}。`);
		}
	}
	const seen = new Set<string>();
	for (const occurrence of occurrences) {
		if (seen.has(occurrence.id)) {
			return invalidResult('invalid-duplicate-id', `模型重复引用了图片编号 ${occurrence.id}。`);
		}
		seen.add(occurrence.id);
	}

	let restored = markdown;
	for (const occurrence of occurrences.slice().sort((left, right) => right.start - left.start)) {
		const image = known.get(occurrence.id);
		if (!image) {
			return invalidResult('invalid-unknown-id', `模型引用了未知图片编号 ${occurrence.id}。`);
		}
		restored = `${restored.slice(0, occurrence.start)}${image.originalReference}${restored.slice(occurrence.end)}`;
	}
	const missingIds = images.filter((image) => !seen.has(image.id)).map((image) => image.id);
	if (missingIds.length > 0) {
		const missingReferences = missingIds.map((id) => known.get(id)?.originalReference ?? '');
		restored = appendToRelatedImagesSection(restored, missingReferences);
		return {
			status: 'recoverable-missing-images',
			restoredMarkdown: restored,
			missingIds,
			message: '模型遗漏的图片已确定性追加到“相关课堂图片”章节。',
		};
	}
	return { status: 'valid', restoredMarkdown: restored, missingIds: [] };
}

function collectPlaceholderOccurrences(markdown: string): PlaceholderOccurrence[] {
	const pattern = /\{\{IMAGE:([^}\r\n]+)\}\}/g;
	const occurrences: PlaceholderOccurrence[] = [];
	for (const match of markdown.matchAll(pattern)) {
		const start = match.index;
		const original = match[0];
		if (start === undefined || !original) {
			continue;
		}
		occurrences.push({
			id: match[1] ?? '',
			start,
			end: start + original.length,
			original,
		});
	}
	return occurrences;
}

function isStandaloneLine(markdown: string, occurrence: PlaceholderOccurrence): boolean {
	const lineStart = markdown.lastIndexOf('\n', occurrence.start - 1) + 1;
	const nextNewline = markdown.indexOf('\n', occurrence.end);
	const lineEnd = nextNewline < 0 ? markdown.length : nextNewline;
	return markdown.slice(lineStart, lineEnd).trim() === occurrence.original;
}

function appendToRelatedImagesSection(markdown: string, references: string[]): string {
	const payload = references.join('\n');
	const headingPattern = /^##[ \t]+相关课堂图片[ \t]*$/gm;
	const heading = headingPattern.exec(markdown);
	if (!heading) {
		const separator = markdown.endsWith('\n\n') ? '' : markdown.endsWith('\n') ? '\n' : '\n\n';
		return `${markdown}${separator}${RELATED_IMAGES_HEADING}\n\n${payload}\n`;
	}
	const sectionBodyStart = heading.index + heading[0].length;
	const nextHeadingPattern = /^##[ \t]+.+$/gm;
	nextHeadingPattern.lastIndex = sectionBodyStart;
	const nextHeading = nextHeadingPattern.exec(markdown);
	const insertionPoint = nextHeading?.index ?? markdown.length;
	const prefix = markdown.slice(0, insertionPoint);
	const suffix = markdown.slice(insertionPoint);
	const beforePayload = prefix.endsWith('\n\n') ? '' : prefix.endsWith('\n') ? '\n' : '\n\n';
	const afterPayload = suffix ? (suffix.startsWith('\n') ? '\n' : '\n\n') : '\n';
	return `${prefix}${beforePayload}${payload}${afterPayload}${suffix}`;
}

function invalidResult(
	status: 'invalid-unknown-id' | 'invalid-duplicate-id' | 'invalid-placement' | 'invalid-direct-embed',
	message: string,
): VisionPlaceholderValidationResult {
	return { status, missingIds: [], message };
}
