/**
 * Classroom Timeline Read Model
 *
 * Pure read-only module that merges screenshot events and transcript finals
 * into a unified timeline for AI consumption.
 *
 * - Does not modify markdown
 * - Does not modify sessions
 * - Does not depend on Vault writes
 * - No side effects
 */

// Re-export the timeline markers for external use
export const TIMELINE_START_MARKER = '<!-- lecture-workflow:timeline:start -->';
export const TIMELINE_END_MARKER = '<!-- lecture-workflow:timeline:end -->';
const AI_START_MARKER = '<!-- lecture-workflow:ai:start -->';

const TRANSCRIPT_HEADING_PATTERN = /^##[ \t]+原始文字稿[ \t]*$/m;
const SECTION_HEADING_PATTERN = /^##?[ \t]/m;
const EVENT_MARKER_PATTERN = /^<!-- lecture-workflow:event id=([^\s>]+) type=([a-z]+) offsetMs=(\d+) capturedAt=([^\s>]+) -->$/gm;
const TRANSCRIPT_LINE_PATTERN = /^\[(\d{1,2}):(\d{2}):(\d{2})\][ \t]+(.+)$/;

export type ClassroomTimelineEntry =
	| {
			kind: 'transcript';
			offsetMs: number;
			text: string;
	  }
	| {
			kind: 'screenshot';
			offsetMs: number;
			eventId: string;
			capturedAt: string;
	  };

/**
 * Build a compact timeline context string for AI prompt injection.
 *
 * Returns null if no entries exist.
 * Format:
 *   课堂统一时间线（仅用于理解文字与截图的时间对应关系，不能替代原始文字稿）：
 *   [00:03:20] [文字] 今天讲积分应用
 *   [00:03:25] [截图]
 */
export function buildTimelineContext(markdown: string): string | null {
	const entries = buildClassroomTimelineReadModel(markdown);
	if (entries.length === 0) return null;

	const lines = entries.map((entry) => {
		const timestamp = formatOffsetAsTimestamp(entry.offsetMs);
		if (entry.kind === 'transcript') {
			const truncated = entry.text.length > 30 ? entry.text.slice(0, 30) + '…' : entry.text;
			return `${timestamp} [文字] ${truncated}`;
		}
		return `${timestamp} [截图]`;
	});

	return `课堂统一时间线（仅用于理解文字与截图的时间对应关系，不能替代原始文字稿，不得凭时间线虚构截图内容）：\n${lines.join('\n')}`;
}

function formatOffsetAsTimestamp(offsetMs: number): string {
	const totalSeconds = Math.floor(offsetMs / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return `[${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}]`;
}

/**
 * Build a unified classroom timeline from markdown content.
 *
 * Merges screenshot events from ## ⏱ 课堂时间线
 * and transcript finals from ## 原始文字稿.
 *
 * Returns entries sorted by offsetMs ascending.
 * Stable sort: entries with same offsetMs preserve their source order
 * (transcript before screenshot).
 */
export function buildClassroomTimelineReadModel(markdown: string): ClassroomTimelineEntry[] {
	const transcriptEntries = parseTranscriptEntries(markdown);
	const screenshotEntries = parseScreenshotEntries(markdown);

	return mergeAndSortEntries(transcriptEntries, screenshotEntries);
}

/**
 * Parse transcript entries from ## 原始文字稿 section.
 *
 * Only accepts strict [HH:MM:SS] format with non-empty text.
 * Stops at next ## section or AI marker.
 */
function parseTranscriptEntries(markdown: string): ClassroomTimelineEntry[] {
	const entries: ClassroomTimelineEntry[] = [];

	const headingMatch = TRANSCRIPT_HEADING_PATTERN.exec(markdown);
	if (!headingMatch) return entries;

	const sectionStart = headingMatch.index + headingMatch[0].length;
	const sectionEnd = findSectionEnd(markdown, sectionStart);
	const sectionContent = markdown.slice(sectionStart, sectionEnd);

	const newline = markdown.includes('\r\n') ? '\r\n' : '\n';
	const lines = sectionContent.split(newline);

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		// Stop at AI marker
		if (trimmed.startsWith(AI_START_MARKER)) break;

		const match = TRANSCRIPT_LINE_PATTERN.exec(trimmed);
		if (!match) continue;

		const hours = Number(match[1]);
		const minutes = Number(match[2]);
		const seconds = Number(match[3]);
		const text = match[4]?.trim();

		if (!text) continue;

		const offsetMs = ((hours * 60 + minutes) * 60 + seconds) * 1000;
		if (!Number.isSafeInteger(offsetMs) || offsetMs < 0) continue;

		entries.push({ kind: 'transcript', offsetMs, text });
	}

	return entries;
}

/**
 * Parse screenshot events from ## ⏱ 课堂时间线 section.
 *
 * Reuses the existing EVENT_MARKER_PATTERN from screenshot-timeline.ts.
 */
function parseScreenshotEntries(markdown: string): ClassroomTimelineEntry[] {
	const entries: ClassroomTimelineEntry[] = [];

	const timelineStart = markdown.indexOf(TIMELINE_START_MARKER);
	const timelineEnd = markdown.indexOf(TIMELINE_END_MARKER);

	if (timelineStart < 0 || timelineEnd < 0 || timelineEnd <= timelineStart) {
		return entries;
	}

	const timelineBody = markdown.slice(timelineStart, timelineEnd);
	const absoluteOffset = timelineStart;

	EVENT_MARKER_PATTERN.lastIndex = 0;
	for (const match of timelineBody.matchAll(EVENT_MARKER_PATTERN)) {
		const eventId = match[1];
		const eventType = match[2];
		const offsetMs = Number(match[3]);
		const capturedAt = match[4];

		if (!eventId || eventType !== 'screenshot') continue;
		if (!Number.isSafeInteger(offsetMs) || offsetMs < 0) continue;
		if (!capturedAt) continue;

		entries.push({ kind: 'screenshot', offsetMs, eventId, capturedAt });
	}

	return entries;
}

/**
 * Find the end of a section (next ## heading or end of content).
 */
function findSectionEnd(markdown: string, start: number): number {
	const remaining = markdown.slice(start);
	const match = SECTION_HEADING_PATTERN.exec(remaining);
	if (!match) return markdown.length;
	return start + match.index;
}

/**
 * Merge transcript and screenshot entries, sorted by offsetMs.
 *
 * Stable sort: when offsetMs is equal, transcript entries come before
 * screenshot entries (preserves temporal semantics: text is spoken
 * at the moment, screenshot captures the state).
 */
function mergeAndSortEntries(
	transcript: ClassroomTimelineEntry[],
	screenshots: ClassroomTimelineEntry[],
): ClassroomTimelineEntry[] {
	const merged: ClassroomTimelineEntry[] = [];

	// Tag entries with source order for stable sort
	const taggedTranscript = transcript.map((entry, index) => ({ entry, source: 0, index }));
	const taggedScreenshots = screenshots.map((entry, index) => ({ entry, source: 1, index }));

	const all = [...taggedTranscript, ...taggedScreenshots];

	all.sort((a, b) => {
		if (a.entry.offsetMs !== b.entry.offsetMs) {
			return a.entry.offsetMs - b.entry.offsetMs;
		}
		// Stable sort: transcript before screenshot at same offset
		if (a.source !== b.source) {
			return a.source - b.source;
		}
		return a.index - b.index;
	});

	for (const item of all) {
		merged.push(item.entry);
	}

	return merged;
}
