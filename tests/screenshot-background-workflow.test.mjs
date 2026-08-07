import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { build } from 'esbuild';

const bundle = await build({
	stdin: {
		contents: [
			"export * from './screenshot-background-workflow.ts';",
			"export * from './screenshot-timeline.ts';",
			"export * from './screenshot-background-session.ts';",
		].join('\n'),
		resolveDir: process.cwd(),
		sourcefile: 'screenshot-background-workflow-test-entry.ts',
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	write: false,
});
const source = bundle.outputFiles[0]?.text;
if (!source) {
	throw new Error('Failed to bundle background screenshot workflow modules.');
}
const workflow = await import(`data:text/javascript,${encodeURIComponent(source)}`);
const {
	BackgroundScreenshotWriter,
	TIMELINE_END_MARKER,
	TIMELINE_START_MARKER,
	buildBackgroundScreenshotCandidatePath,
	buildBackgroundScreenshotFolder,
	buildClassroomSessionId,
	formatClassroomOffset,
	formatScreenshotOffsetFilename,
	insertScreenshotTimelineEvent,
} = workflow;

function screenshotEvent(overrides = {}) {
	return {
		eventId: '20260807-090000-000-screenshot-0001',
		type: 'screenshot',
		width: 1280,
		height: 720,
		detectedAt: new Date('2026-08-07T01:03:25.420Z'),
		offsetMs: 205_420,
		status: 'detected',
		savedPath: null,
		error: null,
		...overrides,
	};
}

function writerHarness(options = {}) {
	const target = { path: '课堂笔记/高等数学.md' };
	const files = new Map(options.files ?? []);
	const created = [];
	const ensured = [];
	let markdown = options.markdown ?? '# 高等数学\n\n## 原始文字稿\n\n内容\n';
	let available = options.available !== false;
	let active = options.active !== false;
	let processCalls = 0;
	let createAttempts = 0;
	const host = {
		isTargetAvailable: (file) => available && file === target,
		ensureFolder: async (path) => {
			ensured.push(path);
			if (options.folderFails) throw new Error('folder');
		},
		pathExists: (path) => files.has(path),
		createBinary: async (path, data) => {
			createAttempts += 1;
			if (options.raceFirstCreate && createAttempts === 1) {
				files.set(path, { path, concurrent: true });
				throw new Error('concurrent collision');
			}
			if (options.createFails) throw new Error('create');
			if (files.has(path)) throw new Error('collision');
			const file = { path, bytes: [...data] };
			files.set(path, file);
			created.push(file);
			return file;
		},
		filePath: (file) => file.path,
		generateMarkdownLink: (file) => {
			if (options.linkFails) throw new Error('link');
			return `[[${file.path}]]`;
		},
		process: async (_file, callback) => {
			processCalls += 1;
			if (options.processFails) throw new Error('process');
			if (options.concurrentEdit) markdown += '\n用户同时新增的内容';
			markdown = callback(markdown);
		},
	};
	const writer = new BackgroundScreenshotWriter(host);
	const capture = (event = screenshotEvent()) => ({
		sessionId: '20260807-090000-000',
		startedAt: new Date('2026-08-07T01:00:00.000Z'),
		targetFile: target,
		targetNameAtStart: '高等数学',
		event,
		pngData: Uint8Array.from([137, 80, 78, 71, 1]),
		isActive: () => active,
	});
	return {
		writer,
		target,
		files,
		created,
		ensured,
		capture,
		get markdown() { return markdown; },
		get processCalls() { return processCalls; },
		get createAttempts() { return createAttempts; },
		setActive(value) { active = value; },
		setAvailable(value) { available = value; },
	};
}

test('session IDs and screenshot filenames retain millisecond precision', () => {
	const date = new Date(2026, 7, 7, 9, 10, 11, 42);
	assert.equal(buildClassroomSessionId(date), '20260807-091011-042');
	assert.equal(formatClassroomOffset(205_420), '00:03:25');
	assert.equal(formatScreenshotOffsetFilename(205_420), '00-03-25-420');
});

test('attachment paths use the safe note name, session ID, and stable suffixes', () => {
	const folder = buildBackgroundScreenshotFolder('课程: 第一讲', '20260807-090000-000');
	assert.equal(folder, '课堂附件/课程- 第一讲/20260807-090000-000/screenshots');
	assert.equal(buildBackgroundScreenshotCandidatePath(folder, '00-03-25-420', 1),
		`${folder}/00-03-25-420.png`);
	assert.equal(buildBackgroundScreenshotCandidatePath(folder, '00-03-25-420', 3),
		`${folder}/00-03-25-420-3.png`);
});

test('a missing timeline is created before the original transcript', () => {
	const original = '---\nstatus: raw\n---\n\n# 课程\n\n## 原始文字稿\n\n原文';
	const result = insertScreenshotTimelineEvent(original, screenshotEvent(), '![[image.png]]');
	assert.equal(result.inserted, true);
	assert.ok(result.markdown.indexOf(TIMELINE_START_MARKER) < result.markdown.indexOf('## 原始文字稿'));
	assert.match(result.markdown, /### 00:03:25 · 课堂截图\n\n!\[\[image\.png\]\]/);
	assert.match(result.markdown, /offsetMs=205420/);
	assert.ok(result.markdown.includes(original.slice(0, original.indexOf('## 原始文字稿'))));
});

test('without a transcript the timeline is inserted before AI, then falls back to the end', () => {
	const beforeAi = insertScreenshotTimelineEvent(
		'# 课程\n\n<!-- lecture-workflow:ai:start -->\nAI\n<!-- lecture-workflow:ai:end -->',
		screenshotEvent(),
		'![[image.png]]',
	).markdown;
	assert.ok(beforeAi.indexOf(TIMELINE_START_MARKER) < beforeAi.indexOf('<!-- lecture-workflow:ai:start -->'));
	const appended = insertScreenshotTimelineEvent('# 课程\n\n正文', screenshotEvent(), '![[image.png]]').markdown;
	assert.ok(appended.endsWith(`${TIMELINE_END_MARKER}\n`));
});

test('an existing timeline receives new events inside its markers', () => {
	const first = insertScreenshotTimelineEvent('# 课程', screenshotEvent(), '![[one.png]]').markdown;
	const secondEvent = screenshotEvent({
		eventId: '20260807-090000-000-screenshot-0002',
		offsetMs: 300_001,
	});
	const second = insertScreenshotTimelineEvent(first, secondEvent, '![[two.png]]').markdown;
	assert.equal((second.match(/lecture-workflow:event/g) ?? []).length, 2);
	assert.ok(second.indexOf('one.png') < second.indexOf('two.png'));
	assert.ok(second.indexOf('two.png') < second.indexOf(TIMELINE_END_MARKER));
});

test('events are inserted in offset order even when detected input is out of order', () => {
	const late = screenshotEvent({ eventId: 'late', offsetMs: 500_000 });
	const early = screenshotEvent({ eventId: 'early', offsetMs: 1_000 });
	let markdown = insertScreenshotTimelineEvent('# 课程', late, '![[late.png]]').markdown;
	markdown = insertScreenshotTimelineEvent(markdown, early, '![[early.png]]').markdown;
	assert.ok(markdown.indexOf('early.png') < markdown.indexOf('late.png'));
});

test('an event ID already in the timeline is never inserted twice', () => {
	const event = screenshotEvent();
	const first = insertScreenshotTimelineEvent('# 课程', event, '![[one.png]]');
	const second = insertScreenshotTimelineEvent(first.markdown, event, '![[duplicate.png]]');
	assert.equal(second.duplicate, true);
	assert.equal(second.markdown, first.markdown);
	assert.doesNotMatch(second.markdown, /duplicate\.png/);
});

test('malformed or duplicate timeline markers fail closed without changing Markdown', () => {
	for (const markdown of [
		`# 课程\n${TIMELINE_START_MARKER}\n未闭合`,
		`# 课程\n${TIMELINE_START_MARKER}\n${TIMELINE_START_MARKER}\n${TIMELINE_END_MARKER}`,
	]) {
		assert.throws(
			() => insertScreenshotTimelineEvent(markdown, screenshotEvent(), '![[image.png]]'),
			/时间线标记不完整/,
		);
	}
});

test('the writer creates folders, saves PNG, and updates the latest Markdown atomically', async () => {
	const harness = writerHarness({ concurrentEdit: true });
	const result = await harness.writer.write(harness.capture());
	assert.equal(result.status, 'inserted');
	assert.equal(harness.ensured.length, 1);
	assert.equal(harness.created.length, 1);
	assert.match(harness.created[0].path,
		/^课堂附件\/高等数学\/20260807-090000-000\/screenshots\/00-03-25-420\.png$/);
	assert.match(harness.markdown, /用户同时新增的内容/);
	assert.match(harness.markdown, /!\[\[课堂附件\/高等数学\//);
	assert.equal(harness.processCalls, 1);
});

test('existing filenames and create races advance without overwriting files', async () => {
	const folder = '课堂附件/高等数学/20260807-090000-000/screenshots';
	const firstPath = `${folder}/00-03-25-420.png`;
	const harness = writerHarness({ files: [[firstPath, { path: firstPath, original: true }]] });
	const result = await harness.writer.write(harness.capture());
	assert.equal(result.status, 'inserted');
	assert.equal(harness.created[0].path, `${folder}/00-03-25-420-2.png`);
	assert.equal(harness.files.get(firstPath).original, true);
});

test('a createBinary collision race retries with the next stable suffix', async () => {
	const harness = writerHarness({ raceFirstCreate: true });
	const result = await harness.writer.write(harness.capture());
	assert.equal(result.status, 'inserted');
	assert.equal(harness.createAttempts, 2);
	assert.match(harness.created[0].path, /00-03-25-420-2\.png$/);
});

test('different offsets in one session produce distinct relative-time filenames', async () => {
	const harness = writerHarness();
	await harness.writer.write(harness.capture());
	await harness.writer.write(harness.capture(screenshotEvent({
		eventId: '20260807-090000-000-screenshot-0002',
		offsetMs: 206_005,
	})));
	assert.deepEqual(harness.created.map((file) => file.path.split('/').at(-1)), [
		'00-03-25-420.png',
		'00-03-26-005.png',
	]);
});

test('retrying the same event reuses its saved file and cannot duplicate the timeline event', async () => {
	const harness = writerHarness();
	const capture = harness.capture();
	assert.equal((await harness.writer.write(capture)).status, 'inserted');
	assert.equal((await harness.writer.write(capture)).status, 'inserted');
	assert.equal(harness.created.length, 1);
	assert.equal((harness.markdown.match(/lecture-workflow:event/g) ?? []).length, 1);
});

test('target rename keeps writing through the same file object', async () => {
	const harness = writerHarness();
	harness.target.path = '课堂笔记/高数-重命名.md';
	const result = await harness.writer.write(harness.capture());
	assert.equal(result.status, 'inserted');
	assert.match(harness.markdown, /lecture-workflow:timeline:start/);
});

test('a deleted target or stopped session creates no file and no timeline', async () => {
	for (const option of [{ available: false }, { active: false }]) {
		const harness = writerHarness(option);
		const before = harness.markdown;
		const result = await harness.writer.write(harness.capture());
		assert.equal(result.status, 'failed');
		assert.equal(harness.created.length, 0);
		assert.equal(harness.markdown, before);
	}
});

test('image save failure never invokes Vault.process', async () => {
	const harness = writerHarness({ createFails: true });
	const before = harness.markdown;
	const result = await harness.writer.write(harness.capture());
	assert.equal(result.status, 'failed');
	assert.equal(harness.processCalls, 0);
	assert.equal(harness.markdown, before);
});

test('timeline insertion failure keeps the already saved image for recovery', async () => {
	const harness = writerHarness({ processFails: true });
	const result = await harness.writer.write(harness.capture());
	assert.equal(result.status, 'saved-only');
	assert.equal(harness.created.length, 1);
	assert.equal(harness.files.has(result.savedPath), true);
	assert.doesNotMatch(harness.markdown, /lecture-workflow:timeline:start/);
});

test('background service uses Vault APIs and never depends on Editor or active view', async () => {
	const service = await readFile('screenshot-background-service.ts', 'utf8');
	assert.match(service, /vault\.createFolder\(/);
	assert.match(service, /vault\.createBinary\(/);
	assert.match(service, /vault\.process\(/);
	assert.doesNotMatch(service, /Editor|MarkdownView|getActiveFile|getActiveView|node:fs|\.adapter\./);
});

test('background save sources never log or serialize image and secret payloads', async () => {
	const sources = await Promise.all([
		'screenshot-background-service.ts',
		'screenshot-background-workflow.ts',
		'screenshot-timeline.ts',
	].map((path) => readFile(path, 'utf8')));
	const combined = sources.join('\n');
	assert.doesNotMatch(combined, /console\.|Base64|base64|toDataURL|API Key|readText|readHTML/);
});

test('the classroom event model reserves transcript and audio event types', async () => {
	const types = await readFile('screenshot-background-types.ts', 'utf8');
	assert.match(types, /ClassroomEventType = 'screenshot' \| 'transcript' \| 'audio'/);
	assert.match(types, /interface ClassroomSession<TFile>/);
});
