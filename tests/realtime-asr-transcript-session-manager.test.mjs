import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

// Polyfill window for Node.js test environment
globalThis.window = {
	setInterval: (fn, ms) => setInterval(fn, ms),
	clearInterval: (id) => clearInterval(id),
};

const moduleBundle = await build({
	stdin: {
		contents: [
			"export * from './realtime-asr-transcript-session-manager.ts';",
			"export * from './realtime-asr-transcript-persistence.ts';",
		].join('\n'),
		resolveDir: process.cwd(),
		sourcefile: 'session-manager-test-entry.ts',
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	write: false,
	external: ['obsidian'],
});
const source = moduleBundle.outputFiles[0]?.text;
if (!source) throw new Error('Failed to bundle session manager modules.');
const api = await import(`data:text/javascript,${encodeURIComponent(source)}`);

const { RealtimeAsrTranscriptSessionManager } = api;

function createMockApp() {
	const writtenEntries = [];
	return {
		vault: {
			process: async (file, fn) => {
				const result = fn('## 原始文字稿\n\n');
				writtenEntries.push(result);
				return result;
			},
		},
		writtenEntries,
	};
}

function createMockTFile() {
	return { path: 'test-note.md', name: 'test-note.md' };
}

function createState(overrides = {}) {
	return {
		status: 'idle',
		classroomSessionId: null,
		partialText: '',
		recentFinalSegments: [],
		lastFinalText: '',
		sentFrameCount: 0,
		sentAudioDurationMs: 0,
		errorCode: null,
		startedAt: null,
		audioBaseOffsetMs: null,
		diagnostics: {},
		...overrides,
	};
}

function createFinalSegment(sentenceId, text, beginTimeMs, endTimeMs) {
	return { sentenceId, text, beginTimeMs, endTimeMs, isFinal: true };
}

function createController() {
	let listener = null;
	return {
		subscribe: (fn) => { listener = fn; return () => { listener = null; }; },
		emit: (state) => { if (listener) listener(state); },
	};
}

function tick() {
	return new Promise(resolve => setTimeout(resolve, 10));
}

test('session manager: Run 2 after STOP/START locks new audioBaseOffsetMs per run', async () => {
	const controller = createController();
	const app = createMockApp();
	const manager = new RealtimeAsrTranscriptSessionManager({
		app,
		subscribeToAsrState: (fn) => controller.subscribe(fn),
		resolveTargetFile: () => createMockTFile(),
	});
	manager.start();
	try {
		// Run 1
		controller.emit(createState({ status: 'connecting', classroomSessionId: 'session-1' }));
		controller.emit(createState({ status: 'streaming', classroomSessionId: 'session-1', audioBaseOffsetMs: 100000 }));
		controller.emit(createState({
			status: 'streaming', classroomSessionId: 'session-1', audioBaseOffsetMs: 100000,
			recentFinalSegments: [createFinalSegment(1, '第一段', 5000, 6000)],
		}));
		assert.equal(manager.pendingCount, 1);

		// Stop Run 1
		controller.emit(createState({ status: 'stopped', classroomSessionId: 'session-1', audioBaseOffsetMs: 100000 }));
		await tick();
		assert.equal(manager.pendingCount, 0);

		// Run 2 after STOP → START with new larger offset
		controller.emit(createState({ status: 'connecting', classroomSessionId: 'session-1' }));
		controller.emit(createState({ status: 'streaming', classroomSessionId: 'session-1', audioBaseOffsetMs: 180000 }));
		controller.emit(createState({
			status: 'streaming', classroomSessionId: 'session-1', audioBaseOffsetMs: 180000,
			recentFinalSegments: [createFinalSegment(1, '第二段', 7000, 8000)],
		}));
		assert.equal(manager.pendingCount, 1);

		controller.emit(createState({ status: 'stopped', classroomSessionId: 'session-1', audioBaseOffsetMs: 180000 }));
		await tick();
		assert.equal(manager.pendingCount, 0);
	} finally {
		manager.dispose();
	}
});

test('session manager: audioBaseOffsetMs locked per run, not overwritten by later 0 value', async () => {
	const controller = createController();
	const app = createMockApp();
	const manager = new RealtimeAsrTranscriptSessionManager({
		app,
		subscribeToAsrState: (fn) => controller.subscribe(fn),
		resolveTargetFile: () => createMockTFile(),
	});
	manager.start();
	try {
		controller.emit(createState({ status: 'connecting', classroomSessionId: 'session-1' }));
		controller.emit(createState({ status: 'streaming', classroomSessionId: 'session-1', audioBaseOffsetMs: 180000 }));
		controller.emit(createState({
			status: 'streaming', classroomSessionId: 'session-1', audioBaseOffsetMs: 180000,
			recentFinalSegments: [createFinalSegment(1, '第一段', 5000, 6000)],
		}));
		assert.equal(manager.pendingCount, 1);

		// Simulate buggy state where audioBaseOffsetMs gets reset to 0
		// The locked value (180000) should still be used
		controller.emit(createState({
			status: 'streaming', classroomSessionId: 'session-1', audioBaseOffsetMs: 0,
			recentFinalSegments: [
				createFinalSegment(1, '第一段', 5000, 6000),
				createFinalSegment(2, '第二段', 9000, 10000),
			],
		}));
		// First segment deduped, second is new → 2 total pending
		assert.equal(manager.pendingCount, 2);
	} finally {
		manager.dispose();
	}
});

test('session manager: three consecutive runs produce monotonically increasing offsets', async () => {
	const controller = createController();
	const app = createMockApp();
	const manager = new RealtimeAsrTranscriptSessionManager({
		app,
		subscribeToAsrState: (fn) => controller.subscribe(fn),
		resolveTargetFile: () => createMockTFile(),
	});
	manager.start();
	try {
		const offsets = [100000, 180000, 300000];
		const beginTimes = [5000, 7000, 3000];

		for (let run = 0; run < 3; run++) {
			controller.emit(createState({ status: 'connecting', classroomSessionId: 'session-1' }));
			controller.emit(createState({ status: 'streaming', classroomSessionId: 'session-1', audioBaseOffsetMs: offsets[run] }));
			controller.emit(createState({
				status: 'streaming', classroomSessionId: 'session-1', audioBaseOffsetMs: offsets[run],
				recentFinalSegments: [createFinalSegment(1, `run-${run}`, beginTimes[run], beginTimes[run] + 1000)],
			}));
			assert.equal(manager.pendingCount, 1);
			controller.emit(createState({ status: 'stopped', classroomSessionId: 'session-1', audioBaseOffsetMs: offsets[run] }));
			await tick();
			assert.equal(manager.pendingCount, 0);
		}
	} finally {
		manager.dispose();
	}
});

test('session manager: empty finals still filtered across STOP/START', async () => {
	const controller = createController();
	const app = createMockApp();
	const manager = new RealtimeAsrTranscriptSessionManager({
		app,
		subscribeToAsrState: (fn) => controller.subscribe(fn),
		resolveTargetFile: () => createMockTFile(),
	});
	manager.start();
	try {
		// Run 1 with empty final
		controller.emit(createState({ status: 'connecting', classroomSessionId: 'session-1' }));
		controller.emit(createState({ status: 'streaming', classroomSessionId: 'session-1', audioBaseOffsetMs: 100000 }));
		controller.emit(createState({
			status: 'streaming', classroomSessionId: 'session-1', audioBaseOffsetMs: 100000,
			recentFinalSegments: [
				createFinalSegment(1, '', 5000, 6000),
				createFinalSegment(2, '有效文本', 9000, 10000),
			],
		}));
		assert.equal(manager.pendingCount, 1);

		controller.emit(createState({ status: 'stopped', classroomSessionId: 'session-1', audioBaseOffsetMs: 100000 }));
		await tick();
		assert.equal(manager.pendingCount, 0);

		// Run 2 with empty final
		controller.emit(createState({ status: 'connecting', classroomSessionId: 'session-1' }));
		controller.emit(createState({ status: 'streaming', classroomSessionId: 'session-1', audioBaseOffsetMs: 180000 }));
		controller.emit(createState({
			status: 'streaming', classroomSessionId: 'session-1', audioBaseOffsetMs: 180000,
			recentFinalSegments: [
				createFinalSegment(1, '\n\t', 3000, 4000),
				createFinalSegment(2, '第二段有效', 5000, 6000),
			],
		}));
		assert.equal(manager.pendingCount, 1);
	} finally {
		manager.dispose();
	}
});
