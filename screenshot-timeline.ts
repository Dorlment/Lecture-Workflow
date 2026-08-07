import type { ClassroomScreenshotEvent } from './screenshot-background-types';

export const TIMELINE_START_MARKER = '<!-- lecture-workflow:timeline:start -->';
export const TIMELINE_END_MARKER = '<!-- lecture-workflow:timeline:end -->';
const AI_START_MARKER = '<!-- lecture-workflow:ai:start -->';
const TRANSCRIPT_HEADING_PATTERN = /^##[ \t]+原始文字稿[ \t]*$/m;
const EVENT_MARKER_PATTERN = /^<!-- lecture-workflow:event id=([^\s>]+) type=([a-z]+) offsetMs=(\d+) capturedAt=([^\s>]+) -->$/gm;

export interface TimelineInsertionResult {
	markdown: string;
	inserted: boolean;
	duplicate: boolean;
}

export function insertScreenshotTimelineEvent(
	markdown: string,
	event: ClassroomScreenshotEvent,
	imageEmbed: string,
): TimelineInsertionResult {
	assertEvent(event);
	const newline = markdown.includes('\r\n') ? '\r\n' : '\n';
	const eventBlock = buildScreenshotTimelineEvent(event, imageEmbed, newline);
	const duplicatePattern = new RegExp(
		`^<!-- lecture-workflow:event id=${escapeRegExp(event.eventId)}(?:\\s|>)`,
		'm',
	);
	if (duplicatePattern.test(markdown)) {
		return { markdown, inserted: false, duplicate: true };
	}

	const startIndex = markdown.indexOf(TIMELINE_START_MARKER);
	const endIndex = markdown.indexOf(TIMELINE_END_MARKER);
	const startMarkerCount = countOccurrences(markdown, TIMELINE_START_MARKER);
	const endMarkerCount = countOccurrences(markdown, TIMELINE_END_MARKER);
	if (startMarkerCount > 1
		|| endMarkerCount > 1
		|| (startIndex < 0) !== (endIndex < 0)
		|| (startIndex >= 0 && endIndex < startIndex)) {
		throw new Error('课堂时间线标记不完整，已停止写入。');
	}

	if (startIndex < 0) {
		const timeline = [
			TIMELINE_START_MARKER,
			'## ⏱ 课堂时间线',
			'',
			eventBlock,
			'',
			TIMELINE_END_MARKER,
		].join(newline);
		return {
			markdown: insertAtPreferredLocation(markdown, timeline, newline),
			inserted: true,
			duplicate: false,
		};
	}

	const timelineBodyStart = startIndex + TIMELINE_START_MARKER.length;
	const timelineBody = markdown.slice(timelineBodyStart, endIndex);
	const markers = parseEventMarkers(timelineBody, timelineBodyStart);
	const allEventMarkerCount = (timelineBody.match(/<!-- lecture-workflow:event\b/g) ?? []).length;
	if (allEventMarkerCount !== markers.length) {
		throw new Error('课堂时间线包含无法识别的事件标记，已停止写入。');
	}
	const laterEvent = markers.find((marker) => marker.offsetMs > event.offsetMs);
	const insertionIndex = laterEvent?.index ?? endIndex;
	return {
		markdown: insertBlock(markdown, insertionIndex, eventBlock, newline),
		inserted: true,
		duplicate: false,
	};
}

export function buildScreenshotTimelineEvent(
	event: ClassroomScreenshotEvent,
	imageEmbed: string,
	newline = '\n',
): string {
	assertEvent(event);
	if (!imageEmbed.startsWith('!')) {
		throw new Error('截图链接不是图片嵌入。');
	}
	return [
		`<!-- lecture-workflow:event id=${event.eventId} type=screenshot offsetMs=${event.offsetMs} capturedAt=${event.detectedAt.toISOString()} -->`,
		`### ${formatClassroomOffset(event.offsetMs)} · 课堂截图`,
		'',
		imageEmbed,
	].join(newline);
}

export function formatClassroomOffset(offsetMs: number): string {
	const safeOffset = normalizeOffset(offsetMs);
	const totalSeconds = Math.floor(safeOffset / 1_000);
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

export function formatScreenshotOffsetFilename(offsetMs: number): string {
	return `${formatClassroomOffset(offsetMs).replace(/:/g, '-')}-${String(normalizeOffset(offsetMs) % 1_000).padStart(3, '0')}`;
}

function insertAtPreferredLocation(markdown: string, timeline: string, newline: string): string {
	const transcriptMatch = TRANSCRIPT_HEADING_PATTERN.exec(markdown);
	const aiStart = markdown.indexOf(AI_START_MARKER);
	const insertionIndex = transcriptMatch?.index
		?? (aiStart >= 0 ? aiStart : markdown.length);
	return insertBlock(markdown, insertionIndex, timeline, newline);
}

function insertBlock(markdown: string, index: number, block: string, newline: string): string {
	const before = markdown.slice(0, index);
	const after = markdown.slice(index);
	const prefix = before.length === 0
		? ''
		: before.endsWith(`${newline}${newline}`)
			? ''
			: before.endsWith(newline) ? newline : `${newline}${newline}`;
	const suffix = after.length === 0
		? newline
		: after.startsWith(`${newline}${newline}`)
			? ''
			: after.startsWith(newline) ? newline : `${newline}${newline}`;
	return `${before}${prefix}${block}${suffix}${after}`;
}

function parseEventMarkers(
	timelineBody: string,
	absoluteOffset: number,
): Array<{ index: number; offsetMs: number }> {
	const markers: Array<{ index: number; offsetMs: number }> = [];
	EVENT_MARKER_PATTERN.lastIndex = 0;
	for (const match of timelineBody.matchAll(EVENT_MARKER_PATTERN)) {
		markers.push({
			index: absoluteOffset + (match.index ?? 0),
			offsetMs: Number(match[3]),
		});
	}
	return markers;
}

function assertEvent(event: ClassroomScreenshotEvent): void {
	if (!/^[A-Za-z0-9._-]+$/.test(event.eventId)
		|| event.type !== 'screenshot'
		|| normalizeOffset(event.offsetMs) !== event.offsetMs
		|| Number.isNaN(event.detectedAt.getTime())) {
		throw new Error('课堂截图事件无效。');
	}
}

function normalizeOffset(offsetMs: number): number {
	if (!Number.isSafeInteger(offsetMs) || offsetMs < 0) {
		throw new Error('课堂截图相对时间无效。');
	}
	return offsetMs;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOccurrences(value: string, needle: string): number {
	return value.split(needle).length - 1;
}
