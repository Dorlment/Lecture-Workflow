import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { build } from 'esbuild';

const bundle = await build({
	stdin: {
		contents: "export * from './classroom-session-controller.ts';",
		resolveDir: process.cwd(),
		sourcefile: 'classroom-session-controller-test-entry.ts',
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	write: false,
});
const bundledSource = bundle.outputFiles[0]?.text;
if (!bundledSource) {
	throw new Error('Failed to bundle classroom session controller for tests.');
}
const { ClassroomSessionController, classroomSessionMenuTitle } = await import(
	`data:text/javascript,${encodeURIComponent(bundledSource)}`
);

function emptyState(overrides = {}) {
	return {
		status: 'idle',
		sessionId: null,
		startedAt: null,
		endedAt: null,
		targetPath: null,
		targetName: null,
		detectedCount: 0,
		savedCount: 0,
		insertedCount: 0,
		failedCount: 0,
		lastDetection: null,
		lastSavedPath: null,
		lastError: null,
		events: [],
		...overrides,
	};
}

function controllerHarness(options = {}) {
	let state = emptyState();
	let target = null;
	let startResult = options.startResult ?? 'started';
	const calls = [];
	const listeners = new Set();
	const runtime = {
		get isListening() { return state.status === 'listening'; },
		get state() { return { ...state, events: [...state.events] }; },
		setTarget(file) {
			calls.push(['setTarget', file]);
			if (state.status === 'listening') return false;
			target = file;
			state = { ...state, targetPath: file.path, targetName: file.basename };
			return true;
		},
		start() {
			calls.push(['start']);
			if (startResult === 'started') {
				state = { ...state, status: 'listening' };
			}
			return startResult;
		},
		stop(reason = 'manual') {
			calls.push(['stop', reason]);
			state = { ...state, status: 'idle' };
		},
		dispose() { calls.push(['dispose']); },
		handleTargetDeleted(file) { calls.push(['delete', file]); },
		handleTargetRenamed(file) { calls.push(['rename', file]); },
		subscribe(listener) {
			calls.push(['subscribe']);
			listeners.add(listener);
			listener(runtime.state);
			return () => {
				calls.push(['unsubscribe']);
				listeners.delete(listener);
			};
		},
	};
	const controller = new ClassroomSessionController(runtime);
	return {
		calls,
		controller,
		get target() { return target; },
		setStartResult(result) { startResult = result; },
		setState(next) { state = { ...state, ...next }; },
		emit() {
			for (const listener of listeners) listener(runtime.state);
		},
	};
}

const noteA = { path: '课堂笔记/A.md', basename: 'A', extension: 'md' };
const noteB = { path: '课堂笔记/B.md', basename: 'B', extension: 'md' };

test('controller start fixes the supplied current note and starts once', () => {
	const harness = controllerHarness();
	assert.equal(harness.controller.start(noteA), 'started');
	assert.equal(harness.target, noteA);
	assert.deepEqual(harness.calls.map(([name]) => name), ['setTarget', 'start']);
	assert.equal(harness.controller.getState().status, 'listening');
});

test('the Ribbon menu title follows the latest session state', () => {
	assert.equal(classroomSessionMenuTitle(emptyState()), '开始课堂监听');
	assert.equal(classroomSessionMenuTitle(emptyState({ status: 'listening' })), '停止课堂监听');
});

test('toggle refuses to reuse a stale target when no active note is supplied', () => {
	const harness = controllerHarness();
	harness.controller.setTarget(noteA);
	assert.equal(harness.controller.toggle(null), 'no-target');
	assert.equal(harness.calls.filter(([name]) => name === 'start').length, 0);
});

test('toggle stops the fixed session without switching to another active note', () => {
	const harness = controllerHarness();
	harness.controller.start(noteA);
	harness.setState({ savedCount: 4 });
	assert.equal(harness.controller.toggle(noteB), 'stopped');
	assert.equal(harness.target, noteA);
	assert.equal(harness.calls.filter(([name]) => name === 'setTarget').length, 1);
	assert.deepEqual(harness.calls.at(-1), ['stop', 'manual']);
});

test('repeated starts are busy and never create a second runtime start', () => {
	const harness = controllerHarness();
	assert.equal(harness.controller.start(noteA), 'started');
	assert.equal(harness.controller.start(noteB), 'busy');
	assert.equal(harness.calls.filter(([name]) => name === 'start').length, 1);
	assert.equal(harness.target, noteA);
});

test('stop returns the saved count from the one runtime state source', () => {
	const harness = controllerHarness();
	harness.controller.start(noteA);
	harness.setState({ savedCount: 7 });
	assert.deepEqual(harness.controller.stop('manual'), { stopped: true, savedCount: 7 });
	assert.deepEqual(harness.controller.stop('manual'), { stopped: false, savedCount: 7 });
	assert.equal(harness.calls.filter(([name]) => name === 'stop').length, 1);
});

test('runtime startup failures pass through without creating controller state', () => {
	for (const result of ['unsupported-platform', 'unsupported', 'no-target', 'busy']) {
		const harness = controllerHarness({ startResult: result });
		assert.equal(harness.controller.start(noteA), result);
		assert.equal(harness.controller.getState().status, 'idle');
	}
});

test('controller subscriptions delegate once and can be removed', () => {
	const harness = controllerHarness();
	const states = [];
	const unsubscribe = harness.controller.subscribe((state) => states.push(state.status));
	harness.setState({ status: 'listening' });
	harness.emit();
	unsubscribe();
	harness.setState({ status: 'idle' });
	harness.emit();
	assert.deepEqual(states, ['idle', 'listening']);
	assert.equal(harness.calls.filter(([name]) => name === 'subscribe').length, 1);
	assert.equal(harness.calls.filter(([name]) => name === 'unsubscribe').length, 1);
});

test('rename, deletion, and unload lifecycle are delegated to the runtime', () => {
	const harness = controllerHarness();
	harness.controller.handleTargetRenamed(noteA);
	harness.controller.handleTargetDeleted(noteA);
	harness.controller.dispose();
	assert.deepEqual(harness.calls, [
		['rename', noteA],
		['delete', noteA],
		['dispose'],
	]);
});

test('Ribbon, command, settings, and status bar share the controller entry points', async () => {
	const [mainSource, settingsSource] = await Promise.all([
		readFile('main.ts', 'utf8'),
		readFile('settings.ts', 'utf8'),
	]);
	assert.equal((mainSource.match(/addRibbonIcon\(/g) ?? []).length, 1);
	assert.match(mainSource, /id: 'toggle-classroom-listening'[\s\S]*?callback: \(\) => this\.toggleClassroomListening\(\)/);
	assert.match(mainSource, /showRibbonMenu\([\s\S]*?getBackgroundScreenshotState\(\)/);
	assert.match(mainSource, /setTitle\(classroomSessionMenuTitle\(classroomState\)\)/);
	assert.match(mainSource, /setTitle\(classroomSessionMenuTitle[\s\S]*?onClick\(\(\) => this\.toggleClassroomListening\(\)\)/);
	assert.match(mainSource, /registerDomEvent\(this\.screenshotStatusBarEl, 'click',[\s\S]*?stopBackgroundScreenshotSession\(\)/);
	assert.match(settingsSource, /startBackgroundScreenshotSession\?\.\(\)/);
	assert.match(settingsSource, /stopBackgroundScreenshotSession\?\.\(\)/);
	assert.match(settingsSource, /日常上课可直接通过左侧 Lecture Workflow 图标启动或停止课堂监听/);
});

test('start UI reads the current active Markdown file and uses exact safe notices', async () => {
	const mainSource = await readFile('main.ts', 'utf8');
	assert.match(mainSource, /toggleClassroomListening\(\)[\s\S]*?workspace\.getActiveFile\(\)/);
	assert.match(mainSource, /controller\.toggle\(activeFile\)/);
	assert.match(mainSource, /请先打开一篇课堂笔记，再启动课堂监听。/);
	assert.match(mainSource, /课堂监听已启动：\$\{activeFile\.basename\}/);
	assert.match(mainSource, /课堂监听已停止，共保存 \$\{savedCount\} 张截图。/);
	assert.match(mainSource, /课堂监听中 · \$\{state\.targetName\} · 已保存 \$\{state\.savedCount\} 张/);
});

test('the controller adds no persistence, hotkey, network, or provider switching surface', async () => {
	const [controllerSource, mainSource] = await Promise.all([
		readFile('classroom-session-controller.ts', 'utf8'),
		readFile('main.ts', 'utf8'),
	]);
	assert.doesNotMatch(controllerSource, /saveData|data\.json|fetch\(|requestUrl|API.?Key|base64|console\./i);
	const command = mainSource.match(/id: 'toggle-classroom-listening'[\s\S]*?\n\t\t\}\);/)?.[0];
	assert.ok(command);
	assert.doesNotMatch(command, /hotkeys|modifiers|key:/);
	assert.doesNotMatch(controllerSource, /DeepSeek|Qwen|Provider/);
});
