import { AI_END_MARKER, AI_START_MARKER } from './ai-note';
import type {
	ParsedVisionImageReference,
	VisionImageReference,
} from './vision-types';

interface SourceRange {
	start: number;
	end: number;
}

const IMAGE_LIKE_EXTENSIONS = new Set([
	'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'tif', 'tiff', 'avif', 'heic',
]);

export function parseVisionImageReferences(markdown: string): VisionImageReference[] {
	return assignVisionImageIds(parseVisionImageReferenceCandidates(markdown));
}

export function parseVisionImageReferenceCandidates(
	markdown: string,
): ParsedVisionImageReference[] {
	return findImageSyntaxCandidates(markdown)
		.filter((reference) => isSupportedLocalLinkShape(reference.link))
		.sort((left, right) => left.sourceStart - right.sourceStart);
}

export function findDirectImageEmbeds(markdown: string): ParsedVisionImageReference[] {
	return findImageSyntaxCandidates(markdown)
		.sort((left, right) => left.sourceStart - right.sourceStart);
}

export function assignVisionImageIds(
	references: ParsedVisionImageReference[],
	getDeduplicationKey: (reference: ParsedVisionImageReference) => string = (reference) =>
		normalizeLinkKey(reference.link),
): VisionImageReference[] {
	const seen = new Set<string>();
	const unique = references
		.slice()
		.sort((left, right) => left.sourceStart - right.sourceStart)
		.filter((reference) => {
			const key = getDeduplicationKey(reference);
			if (seen.has(key)) {
				return false;
			}
			seen.add(key);
			return true;
		});
	return unique.map((reference, index) => ({
		...reference,
		id: `IMG_${String(index + 1).padStart(3, '0')}`,
	}));
}

export function getIgnoredMarkdownRanges(markdown: string): SourceRange[] {
	const ranges: SourceRange[] = [];
	addAiRegionRanges(markdown, ranges);
	addHtmlCommentRanges(markdown, ranges);
	addFencedCodeRanges(markdown, ranges);
	addInlineCodeRanges(markdown, ranges);
	return mergeRanges(ranges);
}

export function isAllowedMarkdownRange(
	start: number,
	end: number,
	ignoredRanges: SourceRange[],
): boolean {
	return !ignoredRanges.some((range) => start < range.end && end > range.start);
}

export function isExternalOrAbsoluteImageLink(link: string): boolean {
	const trimmed = link.trim();
	return trimmed.startsWith('/')
		|| trimmed.startsWith('\\\\')
		|| /^[a-zA-Z]:[\\/]/.test(trimmed)
		|| /^(?:https?|data|file):/i.test(trimmed)
		|| /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
}

function findImageSyntaxCandidates(markdown: string): ParsedVisionImageReference[] {
	const ignoredRanges = getIgnoredMarkdownRanges(markdown);
	const references: ParsedVisionImageReference[] = [];
	collectWikiReferences(markdown, ignoredRanges, references);
	collectMarkdownReferences(markdown, ignoredRanges, references);
	return references;
}

function collectWikiReferences(
	markdown: string,
	ignoredRanges: SourceRange[],
	references: ParsedVisionImageReference[],
): void {
	const pattern = /!\[\[([^\]\r\n]+)\]\]/g;
	for (const match of markdown.matchAll(pattern)) {
		const original = match[0];
		const start = match.index;
		if (start === undefined || !original) {
			continue;
		}
		const end = start + original.length;
		if (!isAllowedMarkdownRange(start, end, ignoredRanges)) {
			continue;
		}
		const parsed = parseWikiBody(match[1] ?? '');
		if (!parsed) {
			continue;
		}
		references.push({
			sourceStart: start,
			sourceEnd: end,
			original,
			link: parsed.link,
			syntax: 'wiki',
			...(parsed.altOrAlias ? { altOrAlias: parsed.altOrAlias } : {}),
			...(parsed.sizeHint ? { sizeHint: parsed.sizeHint } : {}),
		});
	}
}

function collectMarkdownReferences(
	markdown: string,
	ignoredRanges: SourceRange[],
	references: ParsedVisionImageReference[],
): void {
	const pattern = /!\[([^\]\\\r\n]*)\]\(([^()\r\n]+)\)/g;
	for (const match of markdown.matchAll(pattern)) {
		const original = match[0];
		const start = match.index;
		if (start === undefined || !original) {
			continue;
		}
		const end = start + original.length;
		if (!isAllowedMarkdownRange(start, end, ignoredRanges)) {
			continue;
		}
		const link = parseBasicMarkdownDestination(match[2] ?? '');
		if (!link) {
			continue;
		}
		const alt = match[1] ?? '';
		references.push({
			sourceStart: start,
			sourceEnd: end,
			original,
			link,
			syntax: 'markdown',
			...(alt ? { altOrAlias: alt } : {}),
		});
	}
}

function parseWikiBody(body: string): {
	link: string;
	altOrAlias?: string;
	sizeHint?: string;
} | null {
	const parts = body.split('|');
	if (parts.length > 3) {
		return null;
	}
	const link = parts[0]?.trim() ?? '';
	if (!link) {
		return null;
	}
	const firstOption = parts[1]?.trim();
	const secondOption = parts[2]?.trim();
	if (secondOption) {
		return {
			link,
			...(firstOption ? { altOrAlias: firstOption } : {}),
			sizeHint: secondOption,
		};
	}
	if (firstOption && /^\d+(?:x\d+)?$/i.test(firstOption)) {
		return { link, sizeHint: firstOption };
	}
	return { link, ...(firstOption ? { altOrAlias: firstOption } : {}) };
}

function parseBasicMarkdownDestination(destination: string): string | null {
	const trimmed = destination.trim();
	if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
		const enclosed = trimmed.slice(1, -1);
		return enclosed && !/[<>\r\n]/.test(enclosed) ? enclosed : null;
	}
	return !trimmed || /\s/.test(trimmed) ? null : trimmed;
}

function isSupportedLocalLinkShape(link: string): boolean {
	return !isExternalOrAbsoluteImageLink(link) && hasImageLikeExtension(link);
}

function hasImageLikeExtension(link: string): boolean {
	const path = link.split(/[?#]/, 1)[0] ?? '';
	const extension = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase();
	return extension !== undefined && IMAGE_LIKE_EXTENSIONS.has(extension);
}

function normalizeLinkKey(link: string): string {
	return link.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function addAiRegionRanges(markdown: string, ranges: SourceRange[]): void {
	let searchFrom = 0;
	while (searchFrom < markdown.length) {
		const start = markdown.indexOf(AI_START_MARKER, searchFrom);
		if (start < 0) {
			return;
		}
		const endMarker = markdown.indexOf(AI_END_MARKER, start + AI_START_MARKER.length);
		const end = endMarker < 0 ? markdown.length : endMarker + AI_END_MARKER.length;
		ranges.push({ start, end });
		searchFrom = end;
	}
}

function addHtmlCommentRanges(markdown: string, ranges: SourceRange[]): void {
	let searchFrom = 0;
	while (searchFrom < markdown.length) {
		const start = markdown.indexOf('<!--', searchFrom);
		if (start < 0) {
			return;
		}
		const closing = markdown.indexOf('-->', start + 4);
		const end = closing < 0 ? markdown.length : closing + 3;
		ranges.push({ start, end });
		searchFrom = end;
	}
}

function addFencedCodeRanges(markdown: string, ranges: SourceRange[]): void {
	const lines = markdown.matchAll(/^.*(?:\r?\n|$)/gm);
	let active: { start: number; marker: string; length: number } | null = null;
	for (const lineMatch of lines) {
		const line = lineMatch[0];
		const start = lineMatch.index;
		if (start === undefined || !line) {
			continue;
		}
		const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
		if (!active && opening?.[1]) {
			active = { start, marker: opening[1][0] ?? '`', length: opening[1].length };
			continue;
		}
		if (active) {
			const escapedMarker = active.marker === '`' ? '`' : '~';
			const closing = new RegExp(`^ {0,3}${escapedMarker}{${active.length},}[ \\t]*(?:\\r?\\n)?$`);
			if (closing.test(line)) {
				ranges.push({ start: active.start, end: start + line.length });
				active = null;
			}
		}
	}
	if (active) {
		ranges.push({ start: active.start, end: markdown.length });
	}
}

function addInlineCodeRanges(markdown: string, ranges: SourceRange[]): void {
	const existing = mergeRanges(ranges);
	const linePattern = /^.*(?:\r?\n|$)/gm;
	for (const lineMatch of markdown.matchAll(linePattern)) {
		const line = lineMatch[0];
		const lineStart = lineMatch.index;
		if (lineStart === undefined || !line) {
			continue;
		}
		const tickPattern = /`+/g;
		let opening = tickPattern.exec(line);
		while (opening) {
			const ticks = opening[0];
			const start = lineStart + opening.index;
			if (!isAllowedMarkdownRange(start, start + ticks.length, existing)) {
				opening = tickPattern.exec(line);
				continue;
			}
			let closing = tickPattern.exec(line);
			while (closing && closing[0].length !== ticks.length) {
				closing = tickPattern.exec(line);
			}
			if (!closing) {
				break;
			}
			ranges.push({ start, end: lineStart + closing.index + closing[0].length });
			opening = tickPattern.exec(line);
		}
	}
}

function mergeRanges(ranges: SourceRange[]): SourceRange[] {
	const sorted = ranges.slice().sort((left, right) => left.start - right.start);
	const merged: SourceRange[] = [];
	for (const range of sorted) {
		const previous = merged.at(-1);
		if (previous && range.start <= previous.end) {
			previous.end = Math.max(previous.end, range.end);
		} else {
			merged.push({ ...range });
		}
	}
	return merged;
}
