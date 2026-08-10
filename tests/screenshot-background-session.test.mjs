import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { build } from 'esbuild';

const bundle = await build({
	stdin: {
		contents: [
			"export * from './screenshot-background-types.ts';",
			"export * from './screenshot-clipboard-adapter.ts';",
			"export * from './screenshot-background-session.ts';",
			"export * from './screenshot-settings-state.ts';",
		].join('\n'),
		resolveDir: process.cwd(),
		sourcefile: 'screenshot-background-test-entry.ts',
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	write: false,
});
const bundledSource = bundle.outputFiles[0]?.text;
if (!bundledSource) {
	throw new Error('Failed to bundle background screenshot modules for tests.');
}
const background = await import(`data:text/javascript,${encodeURIComponent(bundledSource)}`);
const {
	SCREENSHOT_CLIPBOARD_POLL_INTERVAL_MS,
	ScreenshotBackgroundSession,
	ScreenshotSettingsStateBinding,
	createElectronClipboardAdapter,
} = background;

function bytes(...values) {
	return Uint8Array.from(values);
}

function nativeImage(id, width = 1280, height = 720, counters = {}) {
	const counts = Object.assign({ bitmap: 0, png: 0 }, counters);
	return {
		isEmpty: () => false,
		getSize: () => ({ width, height }),
		resize: () => ({
			toBitmap: () => {
				counts.bitmap += 1;
				return bytes(width & 255, height & 255, id);
			},
		}),
		toPNG: () => {
			counts.png += 1;
			return bytes(137, 80, 78, 71, id);
		},
		counts,
	};
}

function clipboardHarness(initialImage = null) {
	const calls = { formats: 0, image: 0, text: 0, html: 0 };
	let image = initialImage;
	let formats = image ? ['image/png'] : ['text/plain'];
	const clipboard = {
		availableFormats: () => {
			calls.formats += 1;
			return formats;
		},
		readImage: () => {
			calls.image += 1;
			return image;
		},
		readText: () => {
			calls.text += 1;
			return 'secret text';
		},
		readHTML: () => {
			calls.html += 1;
			return '<p>secret</p>';
		},
	};
	return {
		calls,
		clipboard,
		setImage(next) {
			image = next;
			formats = next ? ['image/png'] : ['text/plain'];
		},
		setTextOnly() {
			formats = ['text/plain'];
		},
	};
}

function createSessionHarness(options = {}) {
	const file = { path: '课堂笔记/网络课.md', basename: '网络课', extension: 'md' };
	const availableFiles = new Set([file]);
	const detections = [];
	const eventResults = [];
	const stopped = [];
	const intervals = new Map();
	let nextIntervalId = 1;
	let conflicting = Boolean(options.conflicting);
	const adapterResult = options.adapterResult ?? { status: 'unsupported' };
	const host = {
		isDesktopApp: () => options.desktop !== false,
		isConflictingWorkflowActive: () => conflicting,
		createClipboardAdapter: () => adapterResult,
		createSessionId: () => '20260807-171011-000',
		filePath: (target) => target.path,
		fileName: (target) => target.basename,
		isTargetFileAvailable: (target) => availableFiles.has(target),
		now: options.now ?? (() => new Date('2026-08-07T09:10:11.000Z')),
		setInterval: (callback, intervalMs) => {
			const id = nextIntervalId++;
			intervals.set(id, { callback, intervalMs });
			return id;
		},
		clearInterval: (id) => intervals.delete(id),
		processScreenshot: options.processScreenshot ?? (async (capture) => {
			detections.push(capture.event);
			return {
				status: 'inserted',
				savedPath: `课堂附件/网络课/${capture.sessionId}/screenshots/00-00-00-000.png`,
			};
		}),
		onEventResult: (event) => eventResults.push(event),
		onStopped: (reason) => stopped.push(reason),
	};
	const session = new ScreenshotBackgroundSession(host);
	return {
		file,
		session,
		detections,
		eventResults,
		stopped,
		intervals,
		availableFiles,
		setConflicting(value) { conflicting = value; },
		poll() {
			for (const interval of [...intervals.values()]) {
				interval.callback();
			}
		},
	};
}

async function flushAsyncWork() {
	await new Promise((resolve) => setImmediate(resolve));
}

function readyHarness(initialImage = null, options = {}) {
	const clipboard = clipboardHarness(initialImage);
	const result = createElectronClipboardAdapter({
		isDesktopApp: true,
		loadElectronModule: () => ({ clipboard: clipboard.clipboard }),
	});
	assert.equal(result.status, 'ready');
	const session = createSessionHarness({ ...options, adapterResult: result });
	return { clipboard, ...session };
}

function bindingHarness() {
	let state = { status: 'idle', detectedCount: 0 };
	let listener = null;
	let subscribeCount = 0;
	let unsubscribeCount = 0;
	let nextTimer = 1;
	const timers = new Map();
	const applied = [];
	const binding = new ScreenshotSettingsStateBinding({
		readState: () => state,
		subscribe: (nextListener) => {
			subscribeCount += 1;
			listener = nextListener;
			return () => {
				unsubscribeCount += 1;
				if (listener === nextListener) listener = null;
			};
		},
		apply: (nextState) => applied.push(nextState),
		schedule: (callback, delayMs) => {
			const id = nextTimer++;
			timers.set(id, { callback, delayMs });
			return id;
		},
		cancel: (id) => timers.delete(id),
	});
	return {
		binding,
		applied,
		timers,
		get subscribeCount() { return subscribeCount; },
		get unsubscribeCount() { return unsubscribeCount; },
		setState(nextState) {
			state = nextState;
			listener?.(state);
		},
		flush() {
			for (const [id, timer] of [...timers]) {
				timers.delete(id);
				timer.callback();
			}
		},
	};
}

test('mobile does not load Electron or start clipboard polling', () => {
	let loads = 0;
	const adapter = createElectronClipboardAdapter({
		isDesktopApp: false,
		loadElectronModule: () => { loads += 1; return {}; },
	});
	assert.deepEqual(adapter, { status: 'unsupported' });
	assert.equal(loads, 0);

	const harness = createSessionHarness({ desktop: false });
	harness.session.setTarget(harness.file);
	assert.equal(harness.session.start(), 'unsupported-platform');
	assert.equal(harness.intervals.size, 0);
});

test('a session cannot start without a fixed Markdown target', () => {
	const harness = createSessionHarness();
	assert.equal(harness.session.start(), 'no-target');
});

test('Electron module absence and incomplete clipboard APIs are unsupported', () => {
	assert.equal(createElectronClipboardAdapter({
		isDesktopApp: true,
		loadElectronModule: () => { throw new Error('module unavailable'); },
	}).status, 'unsupported');
	for (const clipboard of [{}, { availableFormats() { return []; } }, { readImage() {} }]) {
		assert.equal(createElectronClipboardAdapter({
			isDesktopApp: true,
			loadElectronModule: () => ({ clipboard }),
		}).status, 'unsupported');
	}
});

test('starting ignores an existing clipboard image and polls every 900 ms', () => {
	const existing = nativeImage(1);
	const harness = readyHarness(existing);
	harness.session.setTarget(harness.file);
	assert.equal(harness.session.start(), 'started');
	assert.equal(harness.session.state.detectedCount, 0);
	assert.equal(existing.counts.png, 1);
	assert.deepEqual([...harness.intervals.values()].map((item) => item.intervalMs),
		[SCREENSHOT_CLIPBOARD_POLL_INTERVAL_MS]);
	assert.equal(SCREENSHOT_CLIPBOARD_POLL_INTERVAL_MS, 900);
});

test('one new image is counted once and a second distinct image increments the count', () => {
	const first = nativeImage(1);
	const second = nativeImage(2);
	const harness = readyHarness(first);
	harness.session.setTarget(harness.file);
	harness.session.start();
	harness.clipboard.setImage(second);
	harness.poll();
	harness.poll();
	assert.equal(harness.session.state.detectedCount, 1);
	assert.equal(second.counts.png, 1, 'unchanged lightweight fingerprint avoids repeated PNG encoding');

	harness.clipboard.setImage(nativeImage(3, 800, 600));
	harness.poll();
	assert.equal(harness.session.state.detectedCount, 2);
	assert.deepEqual(harness.session.state.lastDetection, {
		width: 800,
		height: 600,
		detectedAt: new Date('2026-08-07T09:10:11.000Z'),
	});
});

test('a successful capture updates detected, saved, and inserted classroom session counters', async () => {
	const harness = readyHarness(null);
	harness.session.setTarget(harness.file);
	harness.session.start();
	harness.clipboard.setImage(nativeImage(4));
	harness.poll();
	assert.equal(harness.session.state.detectedCount, 1);
	assert.equal(harness.session.state.events[0].status, 'detected');
	await flushAsyncWork();
	assert.equal(harness.session.state.savedCount, 1);
	assert.equal(harness.session.state.insertedCount, 1);
	assert.equal(harness.session.state.failedCount, 0);
	assert.equal(harness.session.state.events[0].status, 'inserted');
});

test('screenshot events share the session start and retain millisecond offset precision', () => {
	const times = [
		new Date('2026-08-07T09:00:00.125Z'),
		new Date('2026-08-07T09:03:25.545Z'),
	];
	const harness = readyHarness(null, { now: () => times.shift() ?? times.at(-1) });
	harness.session.setTarget(harness.file);
	harness.session.start();
	harness.clipboard.setImage(nativeImage(5));
	harness.poll();
	const state = harness.session.state;
	assert.equal(state.sessionId, '20260807-171011-000');
	assert.equal(state.startedAt.toISOString(), '2026-08-07T09:00:00.125Z');
	assert.equal(state.events[0].offsetMs, 205_420);
	assert.equal(state.events[0].eventId, `${state.sessionId}-screenshot-0001`);
	assert.equal(harness.session.classroomSession.targetFile, harness.file);
	assert.equal(harness.session.classroomSession.startedAt.toISOString(), state.startedAt.toISOString());
});

test('save and insertion failures update failed state without losing the event', async () => {
	const harness = readyHarness(null, {
		processScreenshot: async () => ({ status: 'failed', error: 'mock safe failure' }),
	});
	harness.session.setTarget(harness.file);
	harness.session.start();
	harness.clipboard.setImage(nativeImage(6));
	harness.poll();
	await flushAsyncWork();
	assert.equal(harness.session.state.detectedCount, 1);
	assert.equal(harness.session.state.savedCount, 0);
	assert.equal(harness.session.state.failedCount, 1);
	assert.equal(harness.session.state.lastError, 'mock safe failure');
	assert.equal(harness.session.state.events[0].status, 'failed');
});

test('a saved-only result records a recoverable path and one failed insertion', async () => {
	const harness = readyHarness(null, {
		processScreenshot: async () => ({
			status: 'saved-only',
			savedPath: '课堂附件/课程/session/screenshots/00-00-01-000.png',
			error: 'mock timeline failure',
		}),
	});
	harness.session.setTarget(harness.file);
	harness.session.start();
	harness.clipboard.setImage(nativeImage(8));
	harness.poll();
	await flushAsyncWork();
	assert.equal(harness.session.state.savedCount, 1);
	assert.equal(harness.session.state.insertedCount, 0);
	assert.equal(harness.session.state.failedCount, 1);
	assert.equal(harness.session.state.events[0].status, 'saved');
	assert.match(harness.session.state.lastSavedPath, /00-00-01-000\.png$/);
});

test('stopping immediately prevents a queued screenshot from being saved or inserted', async () => {
	let processCalls = 0;
	const harness = readyHarness(null, {
		processScreenshot: async () => {
			processCalls += 1;
			return { status: 'inserted', savedPath: 'should-not-exist.png' };
		},
	});
	harness.session.setTarget(harness.file);
	harness.session.start();
	harness.clipboard.setImage(nativeImage(7));
	harness.poll();
	harness.session.stop();
	await flushAsyncWork();
	assert.equal(processCalls, 0);
	assert.equal(harness.session.state.savedCount, 0);
	assert.equal(harness.session.state.insertedCount, 0);
});

test('a previously seen full image is not counted or saved again after another image', async () => {
	const first = nativeImage(1);
	const second = nativeImage(2);
	const harness = readyHarness(first);
	harness.session.setTarget(harness.file);
	harness.session.start();
	harness.clipboard.setImage(second);
	harness.poll();
	harness.clipboard.setImage(first);
	harness.poll();
	await flushAsyncWork();
	assert.equal(harness.session.state.detectedCount, 1);
	assert.equal(harness.detections.length, 1);
});

test('text-only clipboard changes neither call image/text readers nor increment count', () => {
	const harness = readyHarness(null);
	harness.session.setTarget(harness.file);
	harness.session.start();
	harness.clipboard.setTextOnly();
	harness.poll();
	assert.equal(harness.session.state.detectedCount, 0);
	assert.equal(harness.clipboard.calls.image, 0);
	assert.equal(harness.clipboard.calls.text, 0);
	assert.equal(harness.clipboard.calls.html, 0);
});

test('stop prevents further detection and resets runtime resources', () => {
	const harness = readyHarness(null);
	harness.session.setTarget(harness.file);
	harness.session.start();
	harness.session.stop();
	harness.clipboard.setImage(nativeImage(2));
	harness.poll();
	assert.equal(harness.session.state.detectedCount, 0);
	assert.equal(harness.session.state.status, 'idle');
	assert.equal(harness.intervals.size, 0);
});

test('target deletion stops and clears the fixed file', () => {
	const harness = readyHarness(null);
	harness.session.setTarget(harness.file);
	harness.session.start();
	harness.availableFiles.delete(harness.file);
	harness.session.handleTargetDeleted(harness.file);
	assert.equal(harness.session.state.status, 'idle');
	assert.equal(harness.session.state.targetPath, null);
	assert.match(harness.session.state.lastError, /目标课堂笔记已被删除/);
	assert.deepEqual(harness.stopped, ['target-deleted']);
});

test('renaming the same TFile safely follows its new Vault path', () => {
	const harness = readyHarness(null);
	harness.session.setTarget(harness.file);
	harness.session.start();
	harness.file.path = '课堂笔记/重命名课程.md';
	harness.file.basename = '重命名课程';
	harness.session.handleTargetRenamed(harness.file);
	assert.equal(harness.session.state.targetPath, '课堂笔记/重命名课程.md');
	assert.equal(harness.session.state.targetName, '重命名课程');
	assert.equal(harness.session.state.status, 'listening');
});

test('unsubscribing a settings listener does not stop the background session', () => {
	const harness = readyHarness(null);
	let notifications = 0;
	const unsubscribe = harness.session.subscribe(() => { notifications += 1; });
	unsubscribe();
	harness.session.setTarget(harness.file);
	harness.session.start();
	assert.equal(harness.session.state.status, 'listening');
	assert.equal(notifications, 1);
});

test('plugin disposal stops polling and clears the target', () => {
	const harness = readyHarness(null);
	harness.session.setTarget(harness.file);
	harness.session.start();
	harness.session.dispose();
	assert.equal(harness.session.state.status, 'idle');
	assert.equal(harness.session.state.targetPath, null);
	assert.equal(harness.intervals.size, 0);
	assert.deepEqual(harness.stopped, ['unload']);
});

test('AI conflict prevents session startup and a later conflict stops polling', () => {
	const blocked = readyHarness(null, { conflicting: true });
	blocked.session.setTarget(blocked.file);
	assert.equal(blocked.session.start(), 'busy');
	assert.equal(blocked.intervals.size, 0);

	const running = readyHarness(null);
	running.session.setTarget(running.file);
	running.session.start();
	running.setConflicting(true);
	running.poll();
	assert.equal(running.session.state.status, 'idle');
});

test('a runtime clipboard capability failure stops with unsupported state', () => {
	const clipboard = clipboardHarness(null);
	const result = createElectronClipboardAdapter({
		isDesktopApp: true,
		loadElectronModule: () => ({ clipboard: clipboard.clipboard }),
	});
	const harness = createSessionHarness({ adapterResult: result });
	harness.session.setTarget(harness.file);
	harness.session.start();
	clipboard.setImage({ isEmpty: () => false });
	harness.poll();
	assert.equal(harness.session.state.status, 'unsupported');
	assert.deepEqual(harness.stopped, ['capability-failed']);
});

test('initial, detected, and duplicate candidates release their image references', () => {
	const released = [];
	const candidates = [
		{ width: 10, height: 10, lightFingerprint: 'a', fullFingerprint: () => 'full-a', takePngData: () => bytes(1), release: () => released.push('a') },
		{ width: 20, height: 20, lightFingerprint: 'b', fullFingerprint: () => 'full-b', takePngData: () => bytes(2), release: () => released.push('b') },
		{ width: 10, height: 10, lightFingerprint: 'a', fullFingerprint: () => 'full-a', takePngData: () => bytes(1), release: () => released.push('a-again') },
	];
	const adapter = {
		readImageCandidate: () => candidates.shift() ?? null,
		dispose: () => undefined,
	};
	const harness = createSessionHarness({ adapterResult: { status: 'ready', adapter } });
	harness.session.setTarget(harness.file);
	harness.session.start();
	harness.poll();
	harness.poll();
	assert.deepEqual(released, ['a', 'b', 'a-again']);
	assert.equal(harness.session.state.detectedCount, 1);
});

test('background production code has strict privacy and no persistence surface', async () => {
	const [adapterSource, sessionSource, mainSource, settingsSource] = await Promise.all([
		readFile('screenshot-clipboard-adapter.ts', 'utf8'),
		readFile('screenshot-background-session.ts', 'utf8'),
		readFile('main.ts', 'utf8'),
		readFile('settings.ts', 'utf8'),
	]);
	const combined = `${adapterSource}\n${sessionSource}`;
	assert.doesNotMatch(combined, /readText|readHTML|readBuffer|readFindText/);
	assert.doesNotMatch(combined, /console\.|base64|toDataURL|createBinary|modifyBinary|vault\./i);
	assert.doesNotMatch(adapterSource, /^import .*electron/m);
	assert.match(adapterSource, /runtimeRequire\('electron'\)/);
	assert.doesNotMatch(settingsSource, /saveSettings\(\)[\s\S]{0,120}startBackgroundScreenshotSession/);
	assert.match(mainSource, /runAiWorkflow\(\)[\s\S]*?classroomSessionController\?\.getState\(\)\.status === 'listening'/);
	assert.match(mainSource, /startBackgroundScreenshotSession\(\)[\s\S]*?aiWorkflowGate\.state !== 'idle'/);
});

test('background start fixes the active TFile without requiring an editor or editing mode', async () => {
	const mainSource = await readFile('main.ts', 'utf8');
	const method = mainSource.match(/async startBackgroundScreenshotSession\(\): Promise<void> \{[\s\S]*?\n\t\}/)?.[0];
	assert.ok(method);
	assert.match(method, /workspace\.getActiveFile\(\)/);
	assert.doesNotMatch(method, /MarkdownView|Editor|getMode|source/);
});

test('settings and status bar expose the runtime probe without persisting it', async () => {
	const [mainSource, settingsSource, dataSource] = await Promise.all([
		readFile('main.ts', 'utf8'),
		readFile('settings.ts', 'utf8'),
		readFile('settings-data.ts', 'utf8'),
	]);
	assert.match(settingsSource, /setName\('后台课堂截图'\)/);
	assert.match(settingsSource, /setButtonText\('使用当前笔记'\)/);
	assert.match(settingsSource, /setButtonText\('开始监听'\)/);
	assert.match(settingsSource, /setButtonText\('停止监听'\)/);
	assert.match(settingsSource, /Snipaste Ctrl\+1 或 Windows Win\+Shift\+S/);
	assert.match(mainSource, /addStatusBarItem\(\)/);
	assert.match(mainSource, /课堂监听中 · \$\{state\.targetName\} · 已保存 \$\{state\.savedCount\} 张/);
	assert.doesNotMatch(dataSource, /screenshotBackground|listening|detectedCount/);
});

test('an open settings page receives throttled live state without full rerenders', () => {
	const harness = bindingHarness();
	harness.binding.open();
	assert.deepEqual(harness.applied, [{ status: 'idle', detectedCount: 0 }]);
	harness.setState({ status: 'listening', detectedCount: 1 });
	harness.setState({ status: 'listening', detectedCount: 2 });
	assert.equal(harness.timers.size, 1);
	assert.equal([...harness.timers.values()][0].delayMs, 100);
	harness.flush();
	assert.deepEqual(harness.applied.at(-1), { status: 'listening', detectedCount: 2 });
});

test('opening settings repeatedly never registers duplicate state listeners', () => {
	const harness = bindingHarness();
	harness.binding.open();
	harness.binding.open();
	assert.equal(harness.subscribeCount, 1);
	harness.setState({ status: 'listening', detectedCount: 3 });
	assert.equal(harness.timers.size, 1);
});

test('closing settings removes only its UI subscription and reopening restores latest state', () => {
	const harness = bindingHarness();
	harness.binding.open();
	harness.binding.close();
	assert.equal(harness.unsubscribeCount, 1);
	harness.setState({ status: 'listening', detectedCount: 4 });
	assert.equal(harness.applied.at(-1).detectedCount, 0);
	harness.binding.open();
	assert.equal(harness.subscribeCount, 2);
	assert.deepEqual(harness.applied.at(-1), { status: 'listening', detectedCount: 4 });
});

test('settings state updates do not create a clipboard polling interval', async () => {
	const settingsSource = await readFile('settings.ts', 'utf8');
	const bindingSource = await readFile('screenshot-settings-state.ts', 'utf8');
	assert.doesNotMatch(`${settingsSource}\n${bindingSource}`, /createClipboardAdapter|pollNow|readImageCandidate/);
	assert.doesNotMatch(bindingSource, /setInterval/);
	assert.doesNotMatch(bindingSource, /rerenderSettings|containerEl\.empty/);
	assert.match(settingsSource, /useCurrentButton\.disabled = state\.status === 'listening'/);
	assert.match(settingsSource, /startButton\.disabled = state\.status === 'listening'/);
	assert.match(settingsSource, /stopButton\.disabled = state\.status !== 'listening'/);
});
