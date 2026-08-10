import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { build } from 'esbuild';

const bundle = await build({
	stdin: {
		contents: [
			"export * from './audio-companion-workbench-binding.ts';",
			"export * from './audio-companion-runtime-ui.ts';",
		].join('\n'),
		resolveDir: process.cwd(),
		sourcefile: 'audio-companion-workbench-runtime-test-entry.ts',
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	write: false,
});
const source = bundle.outputFiles[0]?.text;
if (!source) throw new Error('Failed to bundle audio companion Workbench runtime.');
const {
	AudioCompanionWorkbenchBinding,
	audioCompanionRuntimeUiState,
} = await import(`data:text/javascript,${encodeURIComponent(source)}`);

function runtimeState(status = 'idle', overrides = {}) {
	return {
		status,
		errorCode: null,
		remoteErrorCode: null,
		frameCount: 0,
		rms: 0,
		...overrides,
	};
}

function bindingHarness(initial = runtimeState()) {
	let state = initial;
	const listeners = new Set();
	const applied = [];
	const timers = new Map();
	let nextTimer = 1;
	let subscribeCalls = 0;
	const binding = new AudioCompanionWorkbenchBinding({
		readState: () => ({ ...state }),
		subscribe: (listener) => {
			subscribeCalls += 1;
			listeners.add(listener);
			listener({ ...state });
			return () => listeners.delete(listener);
		},
		apply: (next) => applied.push(next),
		schedule: (callback) => {
			const id = nextTimer++;
			timers.set(id, callback);
			return id;
		},
		cancel: (id) => timers.delete(id),
	});
	return {
		applied,
		binding,
		listeners,
		timers,
		get subscribeCalls() { return subscribeCalls; },
		emit(next) {
			state = next;
			for (const listener of [...listeners]) listener({ ...state });
		},
		flush() {
			for (const [id, callback] of [...timers]) {
				timers.delete(id);
				callback();
			}
		},
	};
}

test('Workbench binding immediately restores a capturing snapshot without starting a session', () => {
	const harness = bindingHarness(runtimeState('capturing', { frameCount: 42, rms: 0.25 }));
	harness.binding.open();
	assert.deepEqual(harness.applied[0], runtimeState('capturing', { frameCount: 42, rms: 0.25 }));
	assert.equal(harness.subscribeCalls, 1);
	assert.equal(harness.listeners.size, 1);
});

test('Workbench binding throttles frame updates and does not add subscriptions on repeated open', () => {
	const harness = bindingHarness();
	harness.binding.open();
	harness.binding.open();
	assert.equal(harness.subscribeCalls, 1);
	harness.emit(runtimeState('capturing', { frameCount: 1, rms: 0.1 }));
	harness.emit(runtimeState('capturing', { frameCount: 2, rms: 0.2 }));
	assert.equal(harness.timers.size, 1);
	harness.flush();
	assert.deepEqual(harness.applied.at(-1), runtimeState('capturing', { frameCount: 2, rms: 0.2 }));
});

test('closing Workbench removes only UI subscription and ignores late scheduled updates', () => {
	const harness = bindingHarness(runtimeState('capturing'));
	harness.binding.open();
	harness.emit(runtimeState('capturing', { frameCount: 8, rms: 0.4 }));
	const applyCount = harness.applied.length;
	harness.binding.close();
	assert.equal(harness.listeners.size, 0);
	assert.equal(harness.timers.size, 0);
	harness.flush();
	assert.equal(harness.applied.length, applyCount);
});

test('reopening creates one fresh UI subscription and restores the latest background state', () => {
	const harness = bindingHarness(runtimeState('capturing', { frameCount: 3 }));
	harness.binding.open();
	harness.binding.close();
	harness.emit(runtimeState('capturing', { frameCount: 99, rms: 0.5 }));
	harness.binding.open();
	assert.equal(harness.subscribeCalls, 2);
	assert.deepEqual(harness.applied.at(-1), runtimeState('capturing', { frameCount: 99, rms: 0.5 }));
});

test('runtime UI maps all statuses, controls, and safe stable remote errors', () => {
	for (const status of [
		'unsupported', 'helper-unavailable', 'idle', 'launching',
		'waiting-for-readiness', 'connecting', 'ready', 'capturing',
		'stopping', 'stopped', 'error',
	]) {
		assert.ok(audioCompanionRuntimeUiState(runtimeState(status), true).statusLabel);
	}
	assert.equal(audioCompanionRuntimeUiState(runtimeState('capturing'), true).canStart, false);
	assert.equal(audioCompanionRuntimeUiState(runtimeState('capturing'), true).canStop, true);
	assert.equal(audioCompanionRuntimeUiState(runtimeState('idle'), false).canStart, false);
	assert.equal(audioCompanionRuntimeUiState(runtimeState('stopped'), true).canStart, true);
	const sourceUnavailable = audioCompanionRuntimeUiState(runtimeState('error', {
		errorCode: 'remote-error',
		remoteErrorCode: 'SOURCE_UNAVAILABLE',
	}), true);
	assert.match(sourceUnavailable.errorMessage, /默认音频输出设备发生变化或不可用/);
	const busy = audioCompanionRuntimeUiState(runtimeState('error', {
		errorCode: 'remote-error',
		remoteErrorCode: 'BUSY',
	}), true);
	assert.match(busy.errorMessage, /已有活动连接/);
});

test('plugin orchestration starts audio after classroom and stops audio before classroom in finally', async () => {
	const main = await readFile('main.ts', 'utf8');
	const start = main.match(/async startBackgroundScreenshotSession\(\)[\s\S]*?\n\t\}/)?.[0];
	const stop = main.match(/async stopBackgroundScreenshotSession\(\)[\s\S]*?\n\t\}/)?.[0];
	assert.ok(start);
	assert.ok(stop);
	assert.match(start, /controller\.start\(file\)[\s\S]*?await this\.startAudioCompanionSession\(\)/);
	assert.match(stop, /try[\s\S]*?await this\.audioCompanionSessionController\?\.stop\(\)[\s\S]*?finally[\s\S]*?classroomSessionController\?\.stop/);
	assert.doesNotMatch(start, /audioCompanionSessionController[\s\S]*?classroomSessionController\?\.stop/);
});

test('Workbench subscribes to runtime controller and close does not stop companion capture', async () => {
	const source = await readFile('classroom-workbench-view.ts', 'utf8');
	assert.match(source, /new AudioCompanionWorkbenchBinding/);
	assert.match(source, /readState: \(\) => this\.audioCompanion\.state/);
	assert.match(source, /audioCompanionBinding\.open\(\)/);
	const close = source.match(/async onClose\(\)[\s\S]*?\n\t\}/)?.[0];
	assert.ok(close);
	assert.match(close, /audioCompanionBinding\?\.close\(\)/);
	assert.doesNotMatch(close, /audioCompanion\.stop|stopSystemAudio/);
});

test('runtime integration remains local-only and does not add ASR, recording, or transcript writes', async () => {
	const sources = await Promise.all([
		'audio-companion-runtime-ui.ts',
		'audio-companion-workbench-binding.ts',
		'obsidian-companion-plugin-directory.ts',
		'companion-launch-resolver.ts',
	].map((path) => readFile(path, 'utf8')));
	const combined = sources.join('\n');
	assert.doesNotMatch(combined, /Qwen.*ASR|audio upload|save audio|实时文字稿|createBinary\([^)]*audio/i);
	assert.doesNotMatch(combined, /process\.cwd\(|child_process|node:net|registry/i);
});
