import type { PersistentTranscriptEntry } from './realtime-asr-transcript-persistence';

const TRANSCRIPT_HEADING = '## 原始文字稿';
const TRANSCRIPT_HEADING_PATTERN = /^##[ \t]+原始文字稿[ \t]*$/m;
const AI_START_MARKER = '<!-- lecture-workflow:ai:start -->';
const PLACEHOLDER = '（未提供原始文字稿。）';

/**
 * Vault-level content check is only a defensive fallback.
 */
export function appendFinalsToTranscript(
	markdown: string,
	finals: readonly PersistentTranscriptEntry[],
): string {
	if (finals.length === 0) return markdown;

	const newline = detectNewline(markdown);

	const headingMatch = TRANSCRIPT_HEADING_PATTERN.exec(markdown);
	if (!headingMatch) {
		const lines = finals.map(formatFinalLine);
		return insertTranscriptSection(markdown, lines, newline);
	}

	const sectionStart = headingMatch.index + headingMatch[0].length;
	const sectionEnd = findSectionEnd(markdown, sectionStart);
	const sectionContent = markdown.slice(sectionStart, sectionEnd);

	if (sectionContent.trim() === PLACEHOLDER) {
		const before = markdown.slice(0, sectionStart);
		const after = markdown.slice(sectionEnd);
		const lines = finals.map(formatFinalLine);
		const newContent = newline + lines.join(newline) + newline;
		return before + newContent + after;
	}

	const newFinals = finals.filter(entry => {
		const line = formatFinalLine(entry);
		return !sectionContent.includes(line);
	});

	if (newFinals.length === 0) return markdown;

	const before = markdown.slice(0, sectionEnd);
	const after = markdown.slice(sectionEnd);
	const lines = newFinals.map(formatFinalLine);
	const needsLeadingNewline = before.length > 0 && !before.endsWith(newline);
	const appendContent = (needsLeadingNewline ? newline : '') + lines.join(newline) + newline;
	return before + appendContent + after;
}

function formatFinalLine(entry: PersistentTranscriptEntry): string {
	const time = formatClassroomOffset(entry.classroomOffsetMs);
	return `[${time}] ${entry.text}`;
}

function findSectionEnd(markdown: string, start: number): number {
	const rest = markdown.slice(start);
	const nextHeadingMatch = /^##[ \t]/m.exec(rest);
	const aiMarkerIndex = rest.indexOf(AI_START_MARKER);

	let end = markdown.length;
	if (nextHeadingMatch) {
		end = Math.min(end, start + nextHeadingMatch.index);
	}
	if (aiMarkerIndex >= 0) {
		end = Math.min(end, start + aiMarkerIndex);
	}
	return end;
}

function insertTranscriptSection(
	markdown: string,
	lines: string[],
	newline: string,
): string {
	const section = [
		TRANSCRIPT_HEADING,
		'',
		...lines,
		'',
	].join(newline);

	const aiMarkerIndex = markdown.indexOf(AI_START_MARKER);
	if (aiMarkerIndex >= 0) {
		const before = markdown.slice(0, aiMarkerIndex);
		const after = markdown.slice(aiMarkerIndex);
		const needsLeadingNewline = before.length > 0 && !before.endsWith(newline);
		return before + (needsLeadingNewline ? newline : '') + section + newline + after;
	}

	const needsLeadingNewline = markdown.length > 0 && !markdown.endsWith(newline);
	return markdown + (needsLeadingNewline ? newline : '') + newline + section;
}

function detectNewline(markdown: string): string {
	return markdown.includes('\r\n') ? '\r\n' : '\n';
}

function formatClassroomOffset(offsetMs: number): string {
	if (!Number.isSafeInteger(offsetMs) || offsetMs < 0) {
		throw new Error('Invalid classroom offset');
	}
	const totalSeconds = Math.floor(offsetMs / 1_000);
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	return [hours, minutes, seconds].map(v => String(v).padStart(2, '0')).join(':');
}
