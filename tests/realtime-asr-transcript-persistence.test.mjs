import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const moduleBundle = await build({
	stdin: {
		contents: [
			"export * from './realtime-asr-transcript-persistence.ts';",
		].join('\n'),
		resolveDir: process.cwd(),
		sourcefile: 'transcript-persistence-test-entry.ts',
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	write: false,
});
const source = moduleBundle.outputFiles[0]?.text;
if (!source) throw new Error('Failed to bundle transcript persistence modules.');
const api = await import(`data:text/javascript,${encodeURIComponent(source)}`);

const {
	RealtimeAsrTranscriptPersistence,
	computeClassroomOffsetMs,
	MAX_PENDING_TRANSCRIPT_ENTRIES,
} = api;

function createFakeScheduler() {
	let currentTime = 0;
	return {
		now: () => currentTime,
		advance: (ms) => { currentTime += ms; },
		setTime: (t) => { currentTime = t; },
	};
}

function createDeterministicIdFactory() {
	let counter = 0;
	return () => `run-${++counter}`;
}

function createFinalSegment(sentenceId, text, beginTimeMs, endTimeMs) {
	return {
		sentenceId,
		text,
		beginTimeMs,
		endTimeMs,
		isFinal: true,
	};
}

function createPartialSegment(sentenceId, text, beginTimeMs) {
	return {
		sentenceId,
		text,
		beginTimeMs,
		endTimeMs: null,
		isFinal: false,
	};
}

test('P0-1: partial segments are not persisted', () => {
	const scheduler = createFakeScheduler();
	const persistence = new RealtimeAsrTranscriptPersistence({ scheduler, idFactory: createDeterministicIdFactory() });

	persistence.beginRun('session-1');
	persistence.receiveSegment(createPartialSegment(1, 'partial text', 0), 0);

	assert.equal(persistence.pendingCount(), 0);
	assert.equal(persistence.shouldFlush(), false);
});

test('P0-2: final segments enter buffer', () => {
	const scheduler = createFakeScheduler();
	const persistence = new RealtimeAsrTranscriptPersistence({ scheduler, idFactory: createDeterministicIdFactory() });

	persistence.beginRun('session-1');
	persistence.receiveSegment(createFinalSegment(1, 'final text', 0, 100), 0);

	assert.equal(persistence.pendingCount(), 1);
});

test('P0-3: duplicate finals are not enqueued', () => {
	const scheduler = createFakeScheduler();
	const persistence = new RealtimeAsrTranscriptPersistence({ scheduler, idFactory: createDeterministicIdFactory() });

	persistence.beginRun('session-1');
	persistence.receiveSegment(createFinalSegment(1, 'final text', 0, 100), 0);
	persistence.receiveSegment(createFinalSegment(1, 'final text', 0, 100), 0);

	assert.equal(persistence.pendingCount(), 1);
});

test('P0-4: flush output is sorted by offset', () => {
	const scheduler = createFakeScheduler();
	const persistence = new RealtimeAsrTranscriptPersistence({ scheduler, idFactory: createDeterministicIdFactory() });

	persistence.beginRun('session-1');
	persistence.receiveSegment(createFinalSegment(3, 'third', 2000, 3000), 0);
	persistence.receiveSegment(createFinalSegment(1, 'first', 0, 1000), 0);
	persistence.receiveSegment(createFinalSegment(2, 'second', 1000, 2000), 0);

	const batch = persistence.prepareFlush();
	assert.ok(batch);
	assert.equal(batch.entries.length, 3);
	assert.equal(batch.entries[0].text, 'first');
	assert.equal(batch.entries[1].text, 'second');
	assert.equal(batch.entries[2].text, 'third');
});

test('P0-5: time window flush trigger (no real sleep)', () => {
	const scheduler = createFakeScheduler();
	const persistence = new RealtimeAsrTranscriptPersistence({
		scheduler,
		idFactory: createDeterministicIdFactory(),
		maxFlushIntervalMs: 5000,
	});

	persistence.beginRun('session-1');
	persistence.receiveSegment(createFinalSegment(1, 'text', 0, 100), 0);

	assert.equal(persistence.shouldFlush(), false);

	scheduler.advance(5000);

	assert.equal(persistence.shouldFlush(), true);
});

test('P0-6: count trigger at MAX_BUFFERED_FINALS', () => {
	const scheduler = createFakeScheduler();
	const persistence = new RealtimeAsrTranscriptPersistence({
		scheduler,
		idFactory: createDeterministicIdFactory(),
		maxBufferedFinals: 10,
	});

	persistence.beginRun('session-1');

	for (let i = 0; i < 9; i++) {
		persistence.receiveSegment(createFinalSegment(i, `text-${i}`, i * 100, (i + 1) * 100), 0);
	}
	assert.equal(persistence.shouldFlush(), false);

	persistence.receiveSegment(createFinalSegment(9, 'text-9', 900, 1000), 0);
	assert.equal(persistence.shouldFlush(), true);
});

test('P0-7: endRun forces flush of all pending', () => {
	const scheduler = createFakeScheduler();
	const persistence = new RealtimeAsrTranscriptPersistence({ scheduler, idFactory: createDeterministicIdFactory() });

	persistence.beginRun('session-1');
	persistence.receiveSegment(createFinalSegment(1, 'text-1', 0, 100), 0);
	persistence.receiveSegment(createFinalSegment(2, 'text-2', 100, 200), 0);

	persistence.endRun();

	assert.equal(persistence.shouldFlush(), true);
	const batch = persistence.prepareFlush();
	assert.ok(batch);
	assert.equal(batch.entries.length, 2);
});

test('P0-8: new beginRun after endRun changes asrRunId', () => {
	const scheduler = createFakeScheduler();
	const idFactory = createDeterministicIdFactory();
	const persistence = new RealtimeAsrTranscriptPersistence({ scheduler, idFactory });

	persistence.beginRun('session-1');
	const firstRunId = persistence.activeRunId;
	persistence.receiveSegment(createFinalSegment(1, 'text', 0, 100), 0);
	persistence.endRun();

	persistence.beginRun('session-1');
	const secondRunId = persistence.activeRunId;
	persistence.receiveSegment(createFinalSegment(1, 'text', 0, 100), 0);

	assert.notEqual(firstRunId, secondRunId);

	const batch = persistence.prepareFlush();
	assert.ok(batch);
	assert.equal(batch.entries.length, 2);
	assert.notEqual(batch.entries[0].eventId, batch.entries[1].eventId);
});

test('P0-9: delayed old run flush does not go to new run', () => {
	const scheduler = createFakeScheduler();
	const persistence = new RealtimeAsrTranscriptPersistence({ scheduler, idFactory: createDeterministicIdFactory() });

	persistence.beginRun('session-1');
	persistence.receiveSegment(createFinalSegment(1, 'old-text', 0, 100), 0);
	persistence.endRun();

	persistence.beginRun('session-1');
	persistence.receiveSegment(createFinalSegment(1, 'new-text', 0, 100), 0);

	const batch = persistence.prepareFlush();
	assert.ok(batch);
	assert.equal(batch.entries.length, 2);

	const oldEntry = batch.entries.find(e => e.text === 'old-text');
	const newEntry = batch.entries.find(e => e.text === 'new-text');
	assert.ok(oldEntry);
	assert.ok(newEntry);
	assert.notEqual(oldEntry.asrRunId, newEntry.asrRunId);
});

test('P0-10: classroomOffset arithmetic (R2 not integration-confirmed)', () => {
	assert.equal(computeClassroomOffsetMs(1000, 500), 1500);
	assert.equal(computeClassroomOffsetMs(0, 0), 0);
	assert.equal(computeClassroomOffsetMs(null, 500), null);
});

test('P0-16: flush failure allows retry, final not lost', () => {
	const scheduler = createFakeScheduler();
	const persistence = new RealtimeAsrTranscriptPersistence({ scheduler, idFactory: createDeterministicIdFactory() });

	persistence.beginRun('session-1');
	persistence.receiveSegment(createFinalSegment(1, 'text', 0, 100), 0);

	const batch1 = persistence.prepareFlush();
	assert.ok(batch1);
	assert.equal(batch1.entries.length, 1);

	persistence.rollbackFlush(batch1.token);

	assert.equal(persistence.pendingCount(), 1);
	scheduler.advance(5000);
	assert.equal(persistence.shouldFlush(), true);

	const batch2 = persistence.prepareFlush();
	assert.ok(batch2);
	assert.equal(batch2.entries.length, 1);
	assert.equal(batch2.entries[0].text, 'text');

	persistence.commitFlush(batch2.token);
	assert.equal(persistence.pendingCount(), 0);
});

test('P0-17: overlapping flush prevented', () => {
	const scheduler = createFakeScheduler();
	const persistence = new RealtimeAsrTranscriptPersistence({ scheduler, idFactory: createDeterministicIdFactory() });

	persistence.beginRun('session-1');
	persistence.receiveSegment(createFinalSegment(1, 'text', 0, 100), 0);

	const batch1 = persistence.prepareFlush();
	assert.ok(batch1);

	const batch2 = persistence.prepareFlush();
	assert.equal(batch2, null);

	persistence.commitFlush(batch1.token);

	assert.throws(() => persistence.commitFlush(batch1.token), /Invalid flush token/);
});

test('receiveSegment before beginRun is ignored', () => {
	const scheduler = createFakeScheduler();
	const persistence = new RealtimeAsrTranscriptPersistence({ scheduler, idFactory: createDeterministicIdFactory() });

	persistence.receiveSegment(createFinalSegment(1, 'text', 0, 100), 0);

	assert.equal(persistence.pendingCount(), 0);
});

test('receiveSegment after endRun is ignored', () => {
	const scheduler = createFakeScheduler();
	const persistence = new RealtimeAsrTranscriptPersistence({ scheduler, idFactory: createDeterministicIdFactory() });

	persistence.beginRun('session-1');
	persistence.endRun();
	persistence.receiveSegment(createFinalSegment(1, 'text', 0, 100), 0);

	assert.equal(persistence.pendingCount(), 0);
});

test('eventId is stable and composite', () => {
	const scheduler = createFakeScheduler();
	const persistence = new RealtimeAsrTranscriptPersistence({ scheduler, idFactory: createDeterministicIdFactory() });

	persistence.beginRun('session-1');
	persistence.receiveSegment(createFinalSegment(42, 'text', 0, 100), 0);

	const batch = persistence.prepareFlush();
	assert.ok(batch);
	assert.equal(batch.entries[0].eventId, 'session-1-asr-run-1-42');
});

test('audioBaseOffsetMs null prevents entry', () => {
	const scheduler = createFakeScheduler();
	const persistence = new RealtimeAsrTranscriptPersistence({ scheduler, idFactory: createDeterministicIdFactory() });

	persistence.beginRun('session-1');
	persistence.receiveSegment(createFinalSegment(1, 'text', 0, 100), null);

	assert.equal(persistence.pendingCount(), 0);
});

test('P1-1A: normal operation with regular flush does not trigger overflow', () => {
	const scheduler = createFakeScheduler();
	const persistence = new RealtimeAsrTranscriptPersistence({ scheduler, idFactory: createDeterministicIdFactory() });

	for (let run = 0; run < 20; run++) {
		persistence.beginRun('session-1');
		for (let i = 0; i < 10; i++) {
			persistence.receiveSegment(createFinalSegment(i, `text-${run}-${i}`, i * 100, (i + 1) * 100), 0);
		}
		persistence.endRun();
		const batch = persistence.prepareFlush();
		assert.ok(batch);
		persistence.commitFlush(batch.token);
	}

	assert.equal(persistence.pendingCount(), 0);
	assert.equal(persistence.pendingOverflow, false);
});

test('P1-1B: multiple runs without flush hit cap and stop growing', () => {
	const scheduler = createFakeScheduler();
	const persistence = new RealtimeAsrTranscriptPersistence({ scheduler, idFactory: createDeterministicIdFactory() });

	for (let run = 0; run < 15; run++) {
		persistence.beginRun('session-1');
		for (let i = 0; i < 10; i++) {
			persistence.receiveSegment(createFinalSegment(i, `text-${run}-${i}`, i * 100, (i + 1) * 100), 0);
		}
		persistence.endRun();
	}

	assert.equal(persistence.pendingCount(), MAX_PENDING_TRANSCRIPT_ENTRIES);
	assert.equal(persistence.pendingOverflow, true);
});

test('P1-1C: recovery after overflow via flush', () => {
	const scheduler = createFakeScheduler();
	const persistence = new RealtimeAsrTranscriptPersistence({ scheduler, idFactory: createDeterministicIdFactory() });

	for (let run = 0; run < 15; run++) {
		persistence.beginRun('session-1');
		for (let i = 0; i < 10; i++) {
			persistence.receiveSegment(createFinalSegment(i, `text-${run}-${i}`, i * 100, (i + 1) * 100), 0);
		}
		persistence.endRun();
	}

	assert.equal(persistence.pendingOverflow, true);
	assert.equal(persistence.pendingCount(), MAX_PENDING_TRANSCRIPT_ENTRIES);

	const batch = persistence.prepareFlush();
	assert.ok(batch);
	assert.equal(batch.entries.length, MAX_PENDING_TRANSCRIPT_ENTRIES);
	persistence.commitFlush(batch.token);

	assert.equal(persistence.pendingCount(), 0);
	assert.equal(persistence.pendingOverflow, false);

	persistence.beginRun('session-1');
	persistence.receiveSegment(createFinalSegment(1, 'recovered', 0, 100), 0);
	assert.equal(persistence.pendingCount(), 1);
});

test('empty text final is not persisted', () => {
	const scheduler = createFakeScheduler();
	const persistence = new RealtimeAsrTranscriptPersistence({ scheduler, idFactory: createDeterministicIdFactory() });

	persistence.beginRun('session-1');
	persistence.receiveSegment(createFinalSegment(1, '', 0, 100), 0);

	assert.equal(persistence.pendingCount(), 0);
	assert.equal(persistence.shouldFlush(), false);
});

test('whitespace-only text final is not persisted', () => {
	const scheduler = createFakeScheduler();
	const persistence = new RealtimeAsrTranscriptPersistence({ scheduler, idFactory: createDeterministicIdFactory() });

	persistence.beginRun('session-1');
	persistence.receiveSegment(createFinalSegment(1, '   ', 0, 100), 0);

	assert.equal(persistence.pendingCount(), 0);
});

test('newline/tab-only text final is not persisted', () => {
	const scheduler = createFakeScheduler();
	const persistence = new RealtimeAsrTranscriptPersistence({ scheduler, idFactory: createDeterministicIdFactory() });

	persistence.beginRun('session-1');
	persistence.receiveSegment(createFinalSegment(1, '\n\t', 0, 100), 0);

	assert.equal(persistence.pendingCount(), 0);
});

test('normal text final enters persistence normally', () => {
	const scheduler = createFakeScheduler();
	const persistence = new RealtimeAsrTranscriptPersistence({ scheduler, idFactory: createDeterministicIdFactory() });

	persistence.beginRun('session-1');
	persistence.receiveSegment(createFinalSegment(1, '有效文本', 0, 100), 0);

	assert.equal(persistence.pendingCount(), 1);
});

test('P1-1D: rejected entries during overflow do not silently corrupt state', () => {
	const scheduler = createFakeScheduler();
	const persistence = new RealtimeAsrTranscriptPersistence({ scheduler, idFactory: createDeterministicIdFactory() });

	for (let run = 0; run < 15; run++) {
		persistence.beginRun('session-1');
		for (let i = 0; i < 10; i++) {
			persistence.receiveSegment(createFinalSegment(i, `text-${run}-${i}`, i * 100, (i + 1) * 100), 0);
		}
		persistence.endRun();
	}

	const countBefore = persistence.pendingCount();

	persistence.beginRun('session-1');
	persistence.receiveSegment(createFinalSegment(1, 'should-be-rejected', 0, 100), 0);
	persistence.endRun();

	assert.equal(persistence.pendingCount(), countBefore);
	assert.equal(persistence.pendingOverflow, true);
});

test('STOP/START Case 1: Run 1 audioBaseOffsetMs=100000 beginTimeMs=5000 => classroomOffset 105000', () => {
	const scheduler = createFakeScheduler();
	const persistence = new RealtimeAsrTranscriptPersistence({ scheduler, idFactory: createDeterministicIdFactory() });

	persistence.beginRun('session-1');
	persistence.receiveSegment(createFinalSegment(1, '第一段', 5000, 6000), 100000);

	const batch = persistence.prepareFlush();
	assert.ok(batch);
	assert.equal(batch.entries.length, 1);
	assert.equal(batch.entries[0].classroomOffsetMs, 105000);
});

test('STOP/START Case 2: Run 2 audioBaseOffsetMs=180000 beginTimeMs=7000 => classroomOffset 187000 not 7000', () => {
	const scheduler = createFakeScheduler();
	const persistence = new RealtimeAsrTranscriptPersistence({ scheduler, idFactory: createDeterministicIdFactory() });

	// Run 1
	persistence.beginRun('session-1');
	persistence.receiveSegment(createFinalSegment(1, '第一段', 5000, 6000), 100000);
	persistence.endRun();
	const batch1 = persistence.prepareFlush();
	assert.ok(batch1);
	persistence.commitFlush(batch1.token);

	// Run 2 after STOP → START
	persistence.beginRun('session-1');
	persistence.receiveSegment(createFinalSegment(1, '第二段', 7000, 8000), 180000);

	const batch2 = persistence.prepareFlush();
	assert.ok(batch2);
	assert.equal(batch2.entries.length, 1);
	assert.equal(batch2.entries[0].classroomOffsetMs, 187000);
	assert.equal(batch2.entries[0].classroomEndOffsetMs, 188000);
});

test('STOP/START Case 3: three consecutive runs produce monotonically increasing offsets', () => {
	const scheduler = createFakeScheduler();
	const persistence = new RealtimeAsrTranscriptPersistence({ scheduler, idFactory: createDeterministicIdFactory() });

	const offsets = [100000, 180000, 300000];
	const beginTimes = [5000, 7000, 3000];
	const allEntries = [];

	for (let run = 0; run < 3; run++) {
		persistence.beginRun('session-1');
		persistence.receiveSegment(
			createFinalSegment(1, `run-${run}`, beginTimes[run], beginTimes[run] + 1000),
			offsets[run],
		);
		persistence.endRun();
		const batch = persistence.prepareFlush();
		assert.ok(batch);
		allEntries.push(...batch.entries);
		persistence.commitFlush(batch.token);
	}

	assert.equal(allEntries.length, 3);
	assert.equal(allEntries[0].classroomOffsetMs, 105000);
	assert.equal(allEntries[1].classroomOffsetMs, 187000);
	assert.equal(allEntries[2].classroomOffsetMs, 303000);

	// Monotonically increasing
	assert.ok(allEntries[0].classroomOffsetMs < allEntries[1].classroomOffsetMs);
	assert.ok(allEntries[1].classroomOffsetMs < allEntries[2].classroomOffsetMs);
});

test('STOP/START Case 4: empty final filtering still works across runs', () => {
	const scheduler = createFakeScheduler();
	const persistence = new RealtimeAsrTranscriptPersistence({ scheduler, idFactory: createDeterministicIdFactory() });

	// Run 1 with empty final
	persistence.beginRun('session-1');
	persistence.receiveSegment(createFinalSegment(1, '', 5000, 6000), 100000);
	persistence.receiveSegment(createFinalSegment(2, '   ', 7000, 8000), 100000);
	persistence.receiveSegment(createFinalSegment(3, '有效文本', 9000, 10000), 100000);
	assert.equal(persistence.pendingCount(), 1);
	persistence.endRun();
	const batch1 = persistence.prepareFlush();
	assert.ok(batch1);
	assert.equal(batch1.entries.length, 1);
	assert.equal(batch1.entries[0].text, '有效文本');
	persistence.commitFlush(batch1.token);

	// Run 2 with empty final
	persistence.beginRun('session-1');
	persistence.receiveSegment(createFinalSegment(1, '\n\t', 3000, 4000), 180000);
	persistence.receiveSegment(createFinalSegment(2, '第二段有效', 5000, 6000), 180000);
	assert.equal(persistence.pendingCount(), 1);
	persistence.endRun();
	const batch2 = persistence.prepareFlush();
	assert.ok(batch2);
	assert.equal(batch2.entries.length, 1);
	assert.equal(batch2.entries[0].text, '第二段有效');
	assert.equal(batch2.entries[0].classroomOffsetMs, 185000);
});
