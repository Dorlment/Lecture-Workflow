import { EditorState, type Extension } from '@codemirror/state';
import type { Editor } from 'obsidian';
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
		if (content.trim() !== '' && content.trim() !== `### ${clock} · 课堂截图`) continue;
		ranges.push({ from: start + from, to: start + to, eventId: marker[1]! });
	}
	return ranges;
}

/** A deleted attachment may leave an embed in the note. Only remove an event
 * when that embed was its last content; retain annotations and other images. */
export function deletedScreenshotTimelineRanges(
	markdown: string,
	isDeletedLink: (link: string) => boolean,
): EmptyScreenshotRange[] {
	const alreadyEmpty = new Set(emptyScreenshotTimelineRanges(markdown).map((range) => range.eventId));
	const withoutDeletedImage = markdown.replace(/!\[\[([^\]\n]+)\]\]|!\[[^\]\n]*\]\(([^\n)]+)\)/g, (embed: string, wiki: string | undefined, url: string | undefined) => {
		const link = wiki?.split('|')[0] ?? url?.replace(/^<|>$/g, '');
		if (!link || !isDeletedLink(link)) return embed;
		// Keep offsets stable so returned ranges apply to the original document.
		return ' '.repeat(embed.length);
	});
	return emptyScreenshotTimelineRanges(withoutDeletedImage).filter((range) => !alreadyEmpty.has(range.eventId));
}

/** Fallback for editor API calls that explicitly disable transaction filters. */
export function screenshotTimelineEditorChange(editor: Pick<Editor, 'getValue' | 'offsetToPos' | 'transaction'>): void {
	if (emptyScreenshotTimelineRanges(editor.getValue()).length === 0) return;
	queueMicrotask(() => {
		const ranges = emptyScreenshotTimelineRanges(editor.getValue());
		if (ranges.length === 0) return;
		editor.transaction({ changes: ranges.map(({ from, to }) => ({
			from: editor.offsetToPos(from), to: editor.offsetToPos(to), text: '',
		})) });
	});
}

/** Merge cleanup into the user's deletion so a single undo restores the full entry. */
export function screenshotTimelineDeletionExtension(): Extension {
	return EditorState.transactionFilter.of((transaction) => {
		// Obsidian's rendered-image edits can dispatch unannotated changes or
		// input/cut events. Detect removal from the document instead of depending
		// on CodeMirror's keyboard-delete annotation. Leave history replay alone.
		if (!transaction.docChanged || transaction.isUserEvent('undo') || transaction.isUserEvent('redo')) return transaction;
		let removedContent = false;
		transaction.changes.iterChangedRanges((from, to) => {
			if (transaction.startState.doc.sliceString(from, to).trim()) removedContent = true;
		});
		if (!removedContent) return transaction;
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
