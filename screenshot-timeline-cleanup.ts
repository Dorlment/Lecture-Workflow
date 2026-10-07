import { EditorState, type Extension } from '@codemirror/state';
import { TIMELINE_START_MARKER, TIMELINE_END_MARKER } from './screenshot-timeline';

export interface EmptyScreenshotRange {
	from: number;
	to: number;
	eventId: string;
}

/** Remove only plugin-generated screenshot entries containing no remaining content. */
export function emptyScreenshotTimelineRanges(markdown: string): EmptyScreenshotRange[] {
	if (markdown.split(TIMELINE_START_MARKER).length !== 2
		|| markdown.split(TIMELINE_END_MARKER).length !== 2) return [];
	const start = markdown.indexOf(TIMELINE_START_MARKER) + TIMELINE_START_MARKER.length;
	const end = markdown.indexOf(TIMELINE_END_MARKER);
	if (end < start) return [];
	const body = markdown.slice(start, end);
	// Skip ambiguous fenced examples rather than editing their contents.
	if (/^[ \t]*(?:`{3,}|~{3,})/m.test(body)) return [];
	const markers = [...body.matchAll(/^<!-- lecture-workflow:event id=([^\s>]+) type=([a-z]+) offsetMs=(\d+) capturedAt=[^\s>]+ -->\r?$/gm)];
	if ((body.match(/<!-- lecture-workflow:event\b/g) ?? []).length !== markers.length) return [];
	const ranges: EmptyScreenshotRange[] = [];
	for (let index = 0; index < markers.length; index++) {
		const marker = markers[index]!;
		if (marker[2] !== 'screenshot') continue;
		const from = marker.index;
		const to = markers[index + 1]?.index ?? body.length;
		const content = body.slice(from + marker[0].length, to);
		const offset = Number(marker[3]);
		if (!Number.isSafeInteger(offset)) continue;
		const seconds = Math.floor(offset / 1000);
		const clock = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
			.map((value) => String(value).padStart(2, '0')).join(':');
		if (content.trim() !== `### ${clock} · 课堂截图`) continue;
		ranges.push({ from: start + from, to: start + to, eventId: marker[1]! });
	}
	return ranges;
}

/** Merge cleanup into the user's deletion so a single undo restores the full entry. */
export function screenshotTimelineDeletionExtension(): Extension {
	return EditorState.transactionFilter.of((transaction) => {
		if (!transaction.docChanged || !transaction.isUserEvent('delete')) return transaction;
		const before = transaction.startState.doc.toString();
		const after = transaction.newDoc.toString();
		if (!before.includes(TIMELINE_START_MARKER)) return transaction;
		const alreadyEmpty = new Set(emptyScreenshotTimelineRanges(before).map((range) => range.eventId));
		const ranges = emptyScreenshotTimelineRanges(after).filter((range) => !alreadyEmpty.has(range.eventId)
			&& before.includes(`<!-- lecture-workflow:event id=${range.eventId} type=screenshot `));
		if (ranges.length === 0) return transaction;
		return [transaction, { changes: ranges.map(({ from, to }) => ({ from, to, insert: '' })), sequential: true }];
	});
}
