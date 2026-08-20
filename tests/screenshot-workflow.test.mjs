import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { build } from 'esbuild';

const bundle = await build({
	stdin: {
		contents: [
			"export * from './screenshot-core.ts';",
			"export * from './screenshot-image.ts';",
			"export * from './screenshot-types.ts';",
			"export * from './screenshot-workflow-gate.ts';",
			"export * from './screenshot-workflow.ts';",
			"export * from './image-references.ts';",
		].join('\n'),
		resolveDir: process.cwd(),
		sourcefile: 'screenshot-workflow-test-entry.ts',
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	write: false,
});
const bundledSource = bundle.outputFiles[0]?.text;
if (!bundledSource) {
	throw new Error('Failed to bundle screenshot workflow modules for tests.');
}
const screenshot = await import(`data:text/javascript,${encodeURIComponent(bundledSource)}`);
const {
	MAX_SCREENSHOT_INPUT_BYTES,
	MAX_SCREENSHOT_OUTPUT_BYTES,
	SCREENSHOT_CONFLICT_MESSAGE,
	ScreenshotImageProcessor,
	ScreenshotOrphanError,
	ScreenshotPasteSession,
	ScreenshotWorkflowError,
	ScreenshotWorkflowGate,
	assertScreenshotSnapshotUnchanged,
	buildScreenshotCandidatePath,
	buildScreenshotEmbed,
	buildScreenshotFolderPath,
	buildScreenshotInsertion,
	evaluateScreenshotStart,
	extractPastedImageFiles,
	formatScreenshotTimestamp,
	parseVisionImageReferenceCandidates,
	sanitizeScreenshotNoteName,
	saveScreenshotTransaction,
	screenshotPasteInstruction,
	validateScreenshotDimensions,
} = screenshot;

function createImageHarness(overrides = {}) {
	const cleanup = { decoded: 0, canvases: [] };
	const canvas = { width: 0, height: 0 };
	const environment = {
		decode: overrides.decode ?? (async () => ({
			source: { kind: 'bitmap' },
			width: overrides.width ?? 1920,
			height: overrides.height ?? 1080,
			dispose: () => { cleanup.decoded += 1; },
		})),
		createCanvas: overrides.createCanvas ?? (() => {
			cleanup.canvases.push(canvas);
			return canvas;
		}),
		draw: overrides.draw ?? (() => undefined),
		encodePng: overrides.encodePng ?? (async () => new Blob(['png'], { type: 'image/png' })),
		now: overrides.now ?? (() => new Date(2026, 7, 7, 16, 30, 15, 184)),
	};
	return { cleanup, processor: new ScreenshotImageProcessor(environment) };
}

function baseExpectedSnapshot() {
	return {
		editorContent: 'note',
		diskContent: 'note',
		mtime: 100,
		size: 4,
		cursor: { line: 0, ch: 2 },
		cursorOffset: 2,
	};
}

function baseCurrentSnapshot(overrides = {}) {
	return {
		activeViewMatches: true,
		activeFileMatches: true,
		fileExistsAtOriginalPath: true,
		fileIdentityMatches: true,
		filePathMatches: true,
		modeIsEditable: true,
		editorIdentityMatches: true,
		editorContent: 'note',
		diskContent: 'note',
		mtime: 100,
		size: 4,
		cursor: { line: 0, ch: 2 },
		cursorOffset: 2,
		...overrides,
	};
}

function createTransactionHarness(overrides = {}) {
	const calls = [];
	const existing = new Set(overrides.existing ?? []);
	let assertCalls = 0;
	const host = {
		assertUnchanged: async () => {
			assertCalls += 1;
			calls.push(`assert:${assertCalls}`);
			if (overrides.conflictAt === assertCalls) {
				throw new ScreenshotWorkflowError(overrides.assertErrorCode ?? 'conflict');
			}
		},
		readPngData: async () => {
			calls.push('read');
			if (overrides.readFails) throw new Error('binary');
			return new Uint8Array([1, 2, 3]).buffer;
		},
		ensureFolder: async (path) => {
			calls.push(`folder:${path}`);
			if (overrides.folderFails) throw new Error('folder');
		},
		pathExists: (path) => existing.has(path),
		createBinary: async (path) => {
			calls.push(`create:${path}`);
			if (overrides.racingPath === path && !existing.has(path)) {
				existing.add(path);
				throw new Error('already exists');
			}
			if (overrides.createFails) throw new Error('disk');
			existing.add(path);
			return { path };
		},
		filePath: (file) => file.path,
		generateMarkdownLink: (file) => {
			calls.push('link');
			if (overrides.linkFails) throw new Error('link');
			return overrides.markdownLink ?? `[[${file.path}]]`;
		},
		insertAtSnapshotCursor: (text) => {
			calls.push(`insert:${text}`);
			if (overrides.insertFails) throw new Error('editor');
		},
		trashFile: async (file) => {
			calls.push(`trash:${file.path}`);
			if (overrides.trashFails) throw new Error('trash');
		},
	};
	return { calls, host };
}

function saveOptions(host) {
	return {
		folderPath: '课堂附件/高等数学-定积分',
		timestamp: '20260807-163015-184',
		capturedAt: new Date(2026, 7, 7, 16, 30, 15, 184),
		originalEditorContent: 'before after',
		cursorOffset: 6,
		host,
	};
}

test('mobile startup is rejected before any screenshot work', () => {
	assert.equal(evaluateScreenshotStart({
		isDesktopApp: false,
		hasMarkdownView: true,
		isEditableMode: true,
	}), 'unsupported-platform');
});

test('missing Markdown view and reading mode are rejected', () => {
	assert.equal(evaluateScreenshotStart({
		isDesktopApp: true,
		hasMarkdownView: false,
		isEditableMode: false,
	}), 'no-active-markdown');
	assert.equal(evaluateScreenshotStart({
		isDesktopApp: true,
		hasMarkdownView: true,
		isEditableMode: false,
	}), 'read-only');
});

test('platform-specific paste instructions use explicit system shortcuts', () => {
	assert.match(screenshotPasteInstruction('windows'), /Win \+ Shift \+ S/);
	assert.match(screenshotPasteInstruction('macos'), /Control \+ Command \+ Shift \+ 4/);
	assert.match(screenshotPasteInstruction('linux'), /系统截图工具/);
});

test('the screenshot gate rejects duplicate starts and resets', () => {
	const gate = new ScreenshotWorkflowGate();
	assert.equal(gate.tryStart(), true);
	assert.equal(gate.tryStart(), false);
	assert.equal(gate.isActive, true);
	gate.finish();
	assert.equal(gate.isActive, false);
	assert.equal(gate.tryStart(), true);
});

test('paste extraction accepts image files without reading clipboard text', () => {
	const image = { name: 'shot.webp' };
	let textReads = 0;
	const files = extractPastedImageFiles([
		{ kind: 'string', type: 'text/plain', getAsFile: () => { textReads += 1; return null; } },
		{ kind: 'file', type: 'image/webp', getAsFile: () => image },
	]);
	assert.deepEqual(files, [image]);
	assert.equal(textReads, 0);
});

test('non-image paste yields no image and multiple images remain explicit', () => {
	assert.deepEqual(extractPastedImageFiles([
		{ kind: 'file', type: 'text/plain', getAsFile: () => ({}) },
	]), []);
	assert.equal(extractPastedImageFiles([
		{ kind: 'file', type: 'image/png', getAsFile: () => ({ id: 1 }) },
		{ kind: 'file', type: 'image/jpeg', getAsFile: () => ({ id: 2 }) },
	]).length, 2);
});

test('a valid pasted image is decoded, encoded as PNG, and timestamped after processing', async () => {
	const harness = createImageHarness();
	const image = await harness.processor.process(new Blob(['source'], { type: 'image/jpeg' }));
	assert.equal(image.width, 1920);
	assert.equal(image.height, 1080);
	assert.equal(image.blob.type, 'image/png');
	assert.equal(image.capturedAt.getMilliseconds(), 184);
	assert.equal(harness.cleanup.decoded, 1);
	assert.equal(harness.cleanup.canvases[0].width, 0);
	assert.equal(harness.cleanup.canvases[0].height, 0);
	image.dispose();
	assert.throws(() => image.blob, /取消/);
});

test('raw clipboard images above 25 MiB are rejected before decoding', async () => {
	let decodeCalls = 0;
	const harness = createImageHarness({
		decode: async () => { decodeCalls += 1; throw new Error('unexpected'); },
	});
	await assert.rejects(
		harness.processor.process({ size: MAX_SCREENSHOT_INPUT_BYTES + 1, type: 'image/png' }),
		(error) => error.code === 'input-too-large',
	);
	assert.equal(decodeCalls, 0);
});

test('zero, excessive edge, and excessive total pixel dimensions are rejected', () => {
	for (const [width, height] of [[0, 1], [16_385, 1], [10_000, 8_001]]) {
		assert.throws(() => validateScreenshotDimensions(width, height),
			(error) => error.code === 'invalid-dimensions');
	}
	assert.doesNotThrow(() => validateScreenshotDimensions(10_000, 8_000));
});

test('decode, canvas, and PNG encoding failures are safely classified', async () => {
	const decode = createImageHarness({ decode: async () => { throw new Error('pixels'); } });
	await assert.rejects(decode.processor.process(new Blob(['x'])),
		(error) => error.code === 'decode-failed');
	const canvas = createImageHarness({ draw: () => { throw new Error('pixels'); } });
	await assert.rejects(canvas.processor.process(new Blob(['x'])),
		(error) => error.code === 'canvas-failed');
	const encode = createImageHarness({ encodePng: async () => null });
	await assert.rejects(encode.processor.process(new Blob(['x'])),
		(error) => error.code === 'encode-failed');
});

test('a PNG above the final 25 MiB limit is rejected and resources are cleared', async () => {
	const oversized = { size: MAX_SCREENSHOT_OUTPUT_BYTES + 1, type: 'image/png' };
	const harness = createImageHarness({ encodePng: async () => oversized });
	await assert.rejects(harness.processor.process(new Blob(['x'])),
		(error) => error.code === 'output-too-large');
	assert.equal(harness.cleanup.decoded, 1);
	assert.equal(harness.cleanup.canvases[0].width, 0);
});

test('pasting again revokes the old preview and disposes the old image', async () => {
	let timestamp = 0;
	const processor = createImageHarness({
		now: () => new Date(2026, 7, 7, 16, 30, 15, timestamp++),
	}).processor;
	const revoked = [];
	let urlSequence = 0;
	const session = new ScreenshotPasteSession(processor, {
		createObjectUrl: () => `blob:preview-${++urlSequence}`,
		revokeObjectUrl: (url) => revoked.push(url),
	});
	const first = await session.accept([new Blob(['first'], { type: 'image/png' })]);
	assert.equal(first.status, 'ready');
	const firstImage = first.image;
	const second = await session.accept([new Blob(['second'], { type: 'image/png' })]);
	assert.equal(second.status, 'ready');
	assert.deepEqual(revoked, ['blob:preview-1']);
	assert.throws(() => firstImage.blob, /取消/);
	assert.equal(second.image.capturedAt.getMilliseconds(), 1);
	session.dispose();
	assert.deepEqual(revoked, ['blob:preview-1', 'blob:preview-2']);
});

test('closing while image processing is pending discards the late result', async () => {
	let resolveDecode;
	const harness = createImageHarness({
		decode: () => new Promise((resolve) => { resolveDecode = resolve; }),
	});
	const urls = [];
	const session = new ScreenshotPasteSession(harness.processor, {
		createObjectUrl: (blob) => { urls.push(blob); return 'blob:late'; },
		revokeObjectUrl: () => undefined,
	});
	const task = session.accept([new Blob(['source'])]);
	session.dispose();
	resolveDecode({ source: {}, width: 1, height: 1, dispose: () => undefined });
	assert.equal((await task).status, 'stale');
	assert.equal(urls.length, 0);
});

test('note names are sanitized against traversal, separators, trailing dots, and emptiness', () => {
	assert.equal(sanitizeScreenshotNoteName('../高数\\积分:第一讲. '), '..-高数-积分-第一讲');
	assert.equal(sanitizeScreenshotNoteName('..'), '未命名笔记');
	assert.equal(sanitizeScreenshotNoteName('   ...   '), '未命名笔记');
	assert.equal(buildScreenshotFolderPath('章节/一'), '课堂附件/章节-一');
});

test('Windows reserved device names are made safe', () => {
	for (const name of ['CON', 'prn', 'AUX.txt', 'NUL', 'COM1', 'LPT9']) {
		assert.equal(sanitizeScreenshotNoteName(name).startsWith('_'), true);
	}
});

test('timestamps contain milliseconds and candidates add -2 and -3', () => {
	const timestamp = formatScreenshotTimestamp(new Date(2026, 7, 7, 16, 30, 15, 184));
	assert.equal(timestamp, '20260807-163015-184');
	assert.equal(buildScreenshotCandidatePath('课堂附件/笔记', timestamp, 1),
		'课堂附件/笔记/20260807-163015-184.png');
	assert.match(buildScreenshotCandidatePath('课堂附件/笔记', timestamp, 2), /-2\.png$/);
	assert.match(buildScreenshotCandidatePath('课堂附件/笔记', timestamp, 3), /-3\.png$/);
});

test('both Wiki and Markdown link preferences become image embeds', () => {
	assert.equal(buildScreenshotEmbed('[[课堂附件/图.png]]'), '![[课堂附件/图.png]]');
	assert.equal(buildScreenshotEmbed('[图](课堂附件/图.png)'), '![图](课堂附件/图.png)');
});

test('the insertion block includes visible time and one complete image reference', () => {
	const insertion = buildScreenshotInsertion(
		'',
		0,
		'[[课堂附件/笔记/图.png]]',
		new Date(2026, 7, 7, 16, 30, 15, 184),
	);
	assert.equal(insertion, '> 截图时间：16:30:15\n![[课堂附件/笔记/图.png]]');
});

test('insertion adds safe line breaks around a cursor inside a paragraph', () => {
	const content = 'beforeafter';
	const insertion = buildScreenshotInsertion(
		content,
		6,
		'[[图.png]]',
		new Date(2026, 0, 1, 1, 2, 3),
	);
	assert.equal(
		`${content.slice(0, 6)}${insertion}${content.slice(6)}`,
		'before\n\n> 截图时间：01:02:03\n![[图.png]]\n\nafter',
	);
	assert.equal(
		buildScreenshotInsertion('before\n\nafter', 7, '[[图.png]]', new Date(2026, 0, 1, 1, 2, 3)),
		'> 截图时间：01:02:03\n![[图.png]]',
	);
});

test('editor content and fresh disk content changes both trigger conflict', () => {
	for (const current of [
		baseCurrentSnapshot({ editorContent: 'changed' }),
		baseCurrentSnapshot({ diskContent: 'external change' }),
	]) {
		assert.throws(
			() => assertScreenshotSnapshotUnchanged(baseExpectedSnapshot(), current),
			(error) => error.code === 'conflict' && error.message === SCREENSHOT_CONFLICT_MESSAGE,
		);
	}
});

test('view, file, mode, cursor, metadata, and identity changes trigger conflict', () => {
	for (const override of [
		{ activeViewMatches: false },
		{ activeFileMatches: false },
		{ fileExistsAtOriginalPath: false },
		{ fileIdentityMatches: false },
		{ filePathMatches: false },
		{ modeIsEditable: false },
		{ editorIdentityMatches: false },
		{ cursor: { line: 0, ch: 3 } },
		{ cursorOffset: null },
		{ mtime: 101 },
		{ size: 5 },
	]) {
		assert.throws(() => assertScreenshotSnapshotUnchanged(
			baseExpectedSnapshot(),
			baseCurrentSnapshot(override),
		), (error) => error.code === 'conflict');
	}
});

test('an unchanged complete snapshot is accepted', () => {
	assert.doesNotThrow(() => assertScreenshotSnapshotUnchanged(
		baseExpectedSnapshot(),
		baseCurrentSnapshot(),
	));
});

test('a successful transaction checks conflicts, saves once, and inserts once', async () => {
	const harness = createTransactionHarness();
	const result = await saveScreenshotTransaction(saveOptions(harness.host));
	assert.equal(result.vaultPath, '课堂附件/高等数学-定积分/20260807-163015-184.png');
	assert.equal(harness.calls.filter((call) => call.startsWith('create:')).length, 1);
	assert.equal(harness.calls.filter((call) => call.startsWith('insert:')).length, 1);
	assert.equal(harness.calls.filter((call) => call.startsWith('trash:')).length, 0);
	assert.equal(harness.calls.filter((call) => call.startsWith('assert:')).length, 4);
});

test('an existing filename and a concurrent collision advance safely to -2 and -3', async () => {
	const first = '课堂附件/高等数学-定积分/20260807-163015-184.png';
	const second = '课堂附件/高等数学-定积分/20260807-163015-184-2.png';
	const harness = createTransactionHarness({ existing: [first], racingPath: second });
	const result = await saveScreenshotTransaction(saveOptions(harness.host));
	assert.match(result.vaultPath, /-3\.png$/);
});

test('folder creation failure creates no PNG and inserts nothing', async () => {
	const harness = createTransactionHarness({ folderFails: true });
	await assert.rejects(saveScreenshotTransaction(saveOptions(harness.host)),
		(error) => error.code === 'folder-failed');
	assert.equal(harness.calls.some((call) => call.startsWith('create:')), false);
	assert.equal(harness.calls.some((call) => call.startsWith('insert:')), false);
});

test('binary read or createBinary failure never inserts Markdown', async () => {
	for (const overrides of [{ readFails: true }, { createFails: true }]) {
		const harness = createTransactionHarness(overrides);
		await assert.rejects(saveScreenshotTransaction(saveOptions(harness.host)));
		assert.equal(harness.calls.some((call) => call.startsWith('insert:')), false);
	}
});

test('a conflict before attachment creation leaves no PNG', async () => {
	const harness = createTransactionHarness({ conflictAt: 1 });
	await assert.rejects(saveScreenshotTransaction(saveOptions(harness.host)),
		(error) => error.code === 'conflict');
	assert.equal(harness.calls.some((call) => call.startsWith('create:')), false);
});

test('a conflict after PNG creation trashes it and inserts nothing', async () => {
	const harness = createTransactionHarness({ conflictAt: 4 });
	await assert.rejects(saveScreenshotTransaction(saveOptions(harness.host)),
		(error) => error.code === 'conflict');
	assert.equal(harness.calls.some((call) => call.startsWith('trash:')), true);
	assert.equal(harness.calls.some((call) => call.startsWith('insert:')), false);
});

test('plugin unload abort after PNG creation also trashes it', async () => {
	const harness = createTransactionHarness({ conflictAt: 4, assertErrorCode: 'aborted' });
	await assert.rejects(saveScreenshotTransaction(saveOptions(harness.host)),
		(error) => error.code === 'aborted');
	assert.equal(harness.calls.some((call) => call.startsWith('trash:')), true);
	assert.equal(harness.calls.some((call) => call.startsWith('insert:')), false);
});

test('link generation and editor insertion failures both trash the new PNG', async () => {
	for (const overrides of [{ linkFails: true }, { insertFails: true }]) {
		const harness = createTransactionHarness(overrides);
		await assert.rejects(saveScreenshotTransaction(saveOptions(harness.host)));
		assert.equal(harness.calls.filter((call) => call.startsWith('trash:')).length, 1);
	}
});

test('trash failure reports the exact orphan Vault path', async () => {
	const harness = createTransactionHarness({ insertFails: true, trashFails: true });
	await assert.rejects(saveScreenshotTransaction(saveOptions(harness.host)), (error) => {
		assert.ok(error instanceof ScreenshotOrphanError);
		assert.equal(error.vaultPath,
			'课堂附件/高等数学-定积分/20260807-163015-184.png');
		return true;
	});
});

test('generated classroom screenshot embeds are discoverable by the existing vision parser', () => {
	const markdown = '> 截图时间：16:30:15\n![[课堂附件/高等数学/20260807-163015-184.png]]';
	const references = parseVisionImageReferenceCandidates(markdown);
	assert.equal(references.length, 1);
	assert.equal(references[0].link, '课堂附件/高等数学/20260807-163015-184.png');
});

test('the obsolete capture entry is removed while the reusable paste modules remain', async () => {
	const mainSource = await readFile('main.ts', 'utf8');
	assert.doesNotMatch(mainSource, /test-classroom-screenshot-compatibility|getDisplayMedia/);
	assert.doesNotMatch(mainSource, /capture-classroom-screenshot|setTitle\('截取课堂图片'\)/);
	assert.match(mainSource, /setTitle\('创建课堂笔记'\)/);
	assert.match(mainSource, /setTitle\('AI 整理当前课堂笔记'\)/);
	await readFile('screenshot-paste-modal.ts', 'utf8');
	await readFile('screenshot-service.ts', 'utf8');
});

test('the paste workflow never reads clipboard proactively or emits image data to logs', async () => {
	const screenshotSources = await Promise.all([
		'screenshot-core.ts',
		'screenshot-image.ts',
		'screenshot-paste-modal.ts',
		'screenshot-service.ts',
		'screenshot-types.ts',
		'screenshot-workflow.ts',
	].map((path) => readFile(path, 'utf8')));
	const mainSource = await readFile('main.ts', 'utf8');
	const combined = [...screenshotSources, mainSource].join('\n');
	assert.doesNotMatch(combined, /navigator\.clipboard|clipboard\.read|toDataURL|base64/i);
	assert.doesNotMatch(screenshotSources.join('\n'),
		/console\.|from ['"]electron['"]|node:fs|child_process/);
});

test('plugin unload releases the background session and Modal close releases pasted images', async () => {
	const [mainSource, modalSource] = await Promise.all([
		readFile('main.ts', 'utf8'),
		readFile('screenshot-paste-modal.ts', 'utf8'),
	]);
	assert.match(mainSource, /onunload\(\)[\s\S]*?classroomSessionController\?\.dispose\(\)/);
	assert.match(mainSource, /for \(const modal of this\.openModals\)[\s\S]*?modal\.close\(\)/);
	assert.match(modalSource, /onClose\(\)[\s\S]*?this\.session\.dispose\(\)/);
});

test('cancel closes the paste Modal without invoking the save handler', async () => {
	const modalSource = await readFile('screenshot-paste-modal.ts', 'utf8');
	assert.match(modalSource, /setButtonText\('取消'\)[\s\S]*?onClick\(\(\) => this\.close\(\)\)/);
	assert.match(modalSource, /private async save\(\)[\s\S]*?this\.onSave\(image\)/);
});

test('the production service uses Vault APIs and declares the current public API minimum version', async () => {
	const [serviceSource, manifestSource] = await Promise.all([
		readFile('screenshot-service.ts', 'utf8'),
		readFile('manifest.json', 'utf8'),
	]);
	assert.doesNotMatch(serviceSource, /\.adapter\.|node:fs/);
	assert.match(serviceSource, /vault\.createFolder\(/);
	assert.match(serviceSource, /vault\.createBinary\(/);
	assert.match(serviceSource, /fileManager\.generateMarkdownLink\(/);
	assert.equal(JSON.parse(manifestSource).minAppVersion, '1.7.2');
});
