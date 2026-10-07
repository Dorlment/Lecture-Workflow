import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({ stdin: {
	contents: "export * from './screenshot-timeline-cleanup.ts'; export { EditorState } from '@codemirror/state';",
	resolveDir: process.cwd(), sourcefile: 'cleanup-tests.ts',
}, bundle: true, format: 'esm', platform: 'node', write: false });
const { emptyScreenshotTimelineRanges, screenshotTimelineDeletionExtension, EditorState }
	= await import(`data:text/javascript,${encodeURIComponent(bundle.outputFiles[0].text)}`);

const start = '<!-- lecture-workflow:timeline:start -->';
const end = '<!-- lecture-workflow:timeline:end -->';
function entry(id, content = '', type = 'screenshot') {
	return `<!-- lecture-workflow:event id=${id} type=${type} offsetMs=1000 capturedAt=2026-10-07T00:00:01.000Z -->\n### 00:00:01 · 课堂截图\n\n${content}\n\n`;
}
function note(body) { return `标题\n\n${start}\n## ⏱ 课堂时间线\n\n${body}${end}\n\n## 原始文字稿\n保留的文字`; }
function clean(markdown) {
	for (const { from, to } of emptyScreenshotTimelineRanges(markdown).reverse()) {
		markdown = markdown.slice(0, from) + markdown.slice(to);
	}
	return markdown;
}

test('cleans existing orphan timestamps while preserving images, annotations and transcript events', () => {
	const keep = entry('image', '![[课件.png]]') + entry('annotation', '我手动写的笔记')
		+ entry('markdown-image', '![课件](课件.png)') + entry('text', '', 'transcript');
	const original = note(entry('empty1') + keep + entry('empty2'));
	assert.equal(clean(original), note(keep));
	assert.equal(clean(original.replaceAll('\n', '\r\n')), note(keep).replaceAll('\n', '\r\n'));
});

test('leaves ambiguous markers, fenced examples, edited headings and content outside the timeline alone', () => {
	for (const markdown of [
		entry('outside'),
		note(entry('edited').replace('### 00:00:01', '### 00:00:02')),
		note('```md\n' + entry('example') + '```\n'),
		note(entry('empty') + '<!-- lecture-workflow:event malformed -->\n'),
		note(entry('empty')) + start,
	]) assert.equal(clean(markdown), markdown);
});

test('deleting an image clears its entry in the same undo step and preserves adjacent events', () => {
	const image = '![[课件.png]]';
	const original = note(entry('delete', image) + entry('keep', '![[保留.png]]'));
	let state = EditorState.create({ doc: original, extensions: [screenshotTimelineDeletionExtension()] });
	const from = original.indexOf(image);
	const deletion = state.update({ changes: { from, to: from + image.length }, userEvent: 'delete.selection' });
	const inverse = deletion.changes.invert(state.doc);
	assert.equal(deletion.isUserEvent('delete.selection'), true);
	state = deletion.state;
	assert.equal(state.doc.toString(), note(entry('keep', '![[保留.png]]')));
	state = state.update({ changes: inverse, userEvent: 'undo' }).state;
	assert.equal(state.doc.toString(), original);
	state = state.update({ changes: deletion.changes, userEvent: 'redo' }).state;
	assert.equal(state.doc.toString(), note(entry('keep', '![[保留.png]]')));
});

test('keeps user notes and remaining images when one image is deleted', () => {
	for (const content of ['![[删除.png]]\n补充笔记', '![[删除.png]]\n![[保留.png]]']) {
		const original = note(entry('keep', content));
		const state = EditorState.create({ doc: original, extensions: [screenshotTimelineDeletionExtension()] });
		const from = original.indexOf('![[删除.png]]');
		const updated = state.update({ changes: { from, to: from + '![[删除.png]]'.length }, userEvent: 'delete.selection' });
		assert.equal(updated.newDoc.toString(), original.replace('![[删除.png]]', ''));
	}
});

test('does not clean preexisting orphans during unrelated edits or plugin insertion', () => {
	const original = note(entry('orphan'));
	const state = EditorState.create({ doc: original, extensions: [screenshotTimelineDeletionExtension()] });
	assert.equal(state.update({ changes: { from: 0, to: 1 }, userEvent: 'delete.backward' }).newDoc.toString(), original.slice(1));
	assert.equal(state.update({ changes: { from: 0, insert: '新增文字' }, userEvent: 'input' }).newDoc.toString(), '新增文字' + original);
});
