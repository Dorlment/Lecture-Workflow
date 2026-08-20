import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

import { build } from 'esbuild';

const moduleBundle = await build({
	stdin: {
		contents: [
			"export * from './realtime-asr-types.ts';",
			"export * from './audio-chunk-aggregator.ts';",
			"export * from './bailian-asr-protocol.ts';",
			"export * from './bailian-streaming-asr-provider.ts';",
			"export * from './realtime-asr-session-controller.ts';",
			"export * from './realtime-asr-runtime-ui.ts';",
			"export * from './realtime-asr-workbench-binding.ts';",
			"export * from './realtime-asr-websocket.ts';",
			"export * from './realtime-asr-transport-ab-diagnostic.ts';",
		].join('\n'),
		resolveDir: process.cwd(),
		sourcefile: 'realtime-asr-test-entry.ts',
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	write: false,
	external: ['ws'],
});
const source = moduleBundle.outputFiles[0]?.text;
if (!source) throw new Error('Failed to bundle Realtime ASR modules.');
const api = await import(`data:text/javascript,${encodeURIComponent(source)}`);

const {
	AudioChunkAggregator,
	BailianStreamingAsrProvider,
	RealtimeAsrError,
	RealtimeAsrTransportError,
	RealtimeAsrSessionController,
	RealtimeAsrTransportAbDiagnostic,
	RealtimeAsrWorkbenchBinding,
	classifyRealtimeAsrTransportAbConclusion,
	classifyRealtimeAsrTransportAbResult,
	createDiagnosticPcmChunk,
	createNodeRealtimeAsrTransport,
	buildBailianAsrEndpoint,
	buildBailianFinishTask,
	buildBailianRunTask,
	parseBailianAsrServerEvent,
	realtimeAsrClientFrameOverhead,
	realtimeAsrBooleanLabel,
	realtimeAsrInboundEventKindLabel,
	realtimeAsrOverflowReasonLabel,
	realtimeAsrPumpBlockReasonLabel,
	realtimeAsrRuntimeUiState,
	runCurrentTransportDiagnostic,
	runOfficialSequenceMinimalDiagnostic,
} = api;

function frame(sequence, fill = sequence, overrides = {}) {
	return {
		sequence,
		offsetMs: 1_000 + sequence * 20,
		sampleCount: 320,
		durationMs: 20,
		sampleRate: 16_000,
		channels: 1,
		sampleFormat: 's16le',
		pcm: new Uint8Array(640).fill(fill),
		...overrides,
	};
}

function serverEvent(event, taskId = 'task-1', payload = {}) {
	return JSON.stringify({
		header: { event, task_id: taskId, attributes: {} },
		payload,
	});
}

function resultEvent(sentence, taskId = 'task-1') {
	return serverEvent('result-generated', taskId, {
		output: { sentence },
		usage: sentence.sentence_end ? { duration: 1 } : null,
	});
}

test('builds the exact Beijing endpoint and rejects unsafe workspace IDs', () => {
	assert.equal(
		buildBailianAsrEndpoint('cn-beijing', ' workspace_123 '),
		'wss://workspace_123.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference',
	);
	assert.equal(buildBailianAsrEndpoint('cn-beijing', 'bad/path'), '');
	assert.equal(buildBailianAsrEndpoint('other', 'workspace'), '');
});

test('run-task and finish-task match the official duplex PCM contract', () => {
	const run = JSON.parse(buildBailianRunTask('task-1', 'model-1'));
	assert.deepEqual(run, {
		header: { action: 'run-task', task_id: 'task-1', streaming: 'duplex' },
		payload: {
			task_group: 'audio', task: 'asr', function: 'recognition', model: 'model-1',
			parameters: { format: 'pcm', sample_rate: 16_000, heartbeat: true },
			input: {},
		},
	});
	assert.deepEqual(JSON.parse(buildBailianFinishTask('task-1')), {
		header: { action: 'finish-task', task_id: 'task-1', streaming: 'duplex' },
		payload: { input: {} },
	});
});

test('parses partial with null end_time and final with valid word timestamps', () => {
	const partial = parseBailianAsrServerEvent(resultEvent({
		begin_time: 10, end_time: null, text: 'partial', sentence_end: false,
		sentence_id: 1, words: [],
	}), 'task-1');
	assert.equal(partial.segment.endTimeMs, null);
	const final = parseBailianAsrServerEvent(resultEvent({
		begin_time: 10, end_time: 50, text: 'final', sentence_end: true,
		sentence_id: 1,
		words: [{ begin_time: 10, end_time: 50, text: 'final', punctuation: '。' }],
	}), 'task-1');
	assert.deepEqual(final.segment.words, [{
		beginTimeMs: 10, endTimeMs: 50, text: 'final', punctuation: '。',
	}]);
});

test('allows absent or empty final words but rejects malformed words and final null end_time', () => {
	for (const words of [undefined, []]) {
		const sentence = {
			begin_time: 0, end_time: 20, text: 'ok', sentence_end: true, sentence_id: 1,
			...(words === undefined ? {} : { words }),
		};
		assert.equal(parseBailianAsrServerEvent(resultEvent(sentence), 'task-1').type, 'result-generated');
	}
	assert.throws(() => parseBailianAsrServerEvent(resultEvent({
		begin_time: 0, end_time: null, text: 'bad', sentence_end: true, sentence_id: 1,
	}), 'task-1'), RealtimeAsrError);
	assert.throws(() => parseBailianAsrServerEvent(resultEvent({
		begin_time: 0, end_time: 20, text: 'bad', sentence_end: true, sentence_id: 1,
		words: [{ begin_time: 20, end_time: 10, text: 'bad', punctuation: '' }],
	}), 'task-1'), RealtimeAsrError);
	assert.throws(() => parseBailianAsrServerEvent(resultEvent({
		begin_time: 10, end_time: 5, text: 'bad partial', sentence_end: false, sentence_id: 1,
	}), 'task-1'), RealtimeAsrError);
	assert.throws(() => parseBailianAsrServerEvent(resultEvent({
		begin_time: 10, end_time: 20, text: 'bad word', sentence_end: true, sentence_id: 1,
		words: [{ begin_time: 0, end_time: 5, text: 'bad', punctuation: '' }],
	}), 'task-1'), RealtimeAsrError);
});

test('ignores a valid heartbeat before normal transcript parsing', () => {
	const event = parseBailianAsrServerEvent(resultEvent({
		heartbeat: true, sentence_id: 0,
	}), 'task-1');
	assert.deepEqual(event, { type: 'result-generated', heartbeat: true });
});

test('rejects malformed JSON, unknown events, and mismatched task IDs', () => {
	assert.throws(() => parseBailianAsrServerEvent('{', 'task-1'), RealtimeAsrError);
	assert.throws(() => parseBailianAsrServerEvent(serverEvent('unknown'), 'task-1'), RealtimeAsrError);
	assert.throws(() => parseBailianAsrServerEvent(serverEvent('task-started', 'other'), 'task-1'), RealtimeAsrError);
});

test('aggregates five validated frames into an unchanged 100ms PCM chunk', () => {
	const aggregator = new AudioChunkAggregator();
	let chunk = null;
	for (let index = 0; index < 5; index += 1) chunk = aggregator.push(frame(index, index + 1));
	assert.equal(chunk.frameCount, 5);
	assert.equal(chunk.data.byteLength, 3_200);
	for (let index = 0; index < 5; index += 1) {
		assert.equal(chunk.data[index * 640], index + 1);
	}
});

test('flushes one to four complete frames as residual binary PCM', () => {
	for (let count = 1; count <= 4; count += 1) {
		const aggregator = new AudioChunkAggregator();
		for (let index = 0; index < count; index += 1) aggregator.push(frame(index));
		const residual = aggregator.flushResidual();
		assert.equal(residual.frameCount, count);
		assert.equal(residual.data.byteLength, count * 640);
	}
});

test('client frame overhead follows masked WebSocket length boundaries', () => {
	assert.equal(realtimeAsrClientFrameOverhead(0), 6);
	assert.equal(realtimeAsrClientFrameOverhead(125), 6);
	assert.equal(realtimeAsrClientFrameOverhead(126), 8);
	assert.equal(realtimeAsrClientFrameOverhead(65_535), 8);
	assert.equal(realtimeAsrClientFrameOverhead(65_536), 14);
	for (const payloadLength of [640, 1_280, 1_920, 2_560, 3_200]) {
		assert.equal(realtimeAsrClientFrameOverhead(payloadLength), 8);
	}
});

test('rejects invalid format, bytes, and discontinuous sequence', () => {
	const format = new AudioChunkAggregator();
	assert.throws(() => format.push(frame(0, 0, { sampleRate: 48_000 })), /audio-format-invalid/);
	const bytes = new AudioChunkAggregator();
	assert.throws(() => bytes.push(frame(0, 0, { pcm: new Uint8Array(2) })), /audio-format-invalid/);
	const sequence = new AudioChunkAggregator();
	sequence.push(frame(0));
	assert.throws(() => sequence.push(frame(2)), /audio-sequence-invalid/);
});

class FakeTransport {
	bufferedAmount = 0;
	perMessageDeflateConfigured = false;
	perMessageDeflateNegotiated = false;
	connectOptions = null;
	texts = [];
	binaries = [];
	disposeCalls = 0;
	async connect(options) { this.connectOptions = options; }
	async sendText(message) { this.texts.push(message); }
	async sendBinary(data) { this.binaries.push(data.slice()); }
	close() {}
	dispose() { this.disposeCalls += 1; }
	emit(message) { this.connectOptions.handlers.onText(message); }
	fail(error) { this.connectOptions.handlers.onError(error); }
}

function providerHarness(scheduler = {
	now: () => Date.now(),
	setTimeout: () => Symbol('timeout'),
	clearTimeout: () => {},
}, transport = new FakeTransport(), getApiKey = () => 'unit-test-secret') {
	const phases = [];
	const segments = [];
	const progress = [];
	const failures = [];
	const phaseDiagnostics = [];
	let progressHook = null;
	const provider = new BailianStreamingAsrProvider({
		configuration: {
			workspaceId: 'workspace-test', region: 'cn-beijing', model: 'model-test',
		},
		getApiKey,
		transportFactory: () => transport,
		scheduler,
		taskIdFactory: () => 'task-1',
		callbacks: {
			onPhase: (value) => {
				phases.push(value);
				phaseDiagnostics.push({
					phase: value,
					diagnostics: progress.at(-1)?.diagnostics ?? null,
				});
			},
			onSegment: (value) => segments.push(value),
			onProgress: (value) => {
				progress.push(value);
				progressHook?.(value);
			},
			onFailure: (value) => failures.push(value),
		},
	});
	return {
		provider, transport, phases, phaseDiagnostics, segments, progress, failures,
		setProgressHook(callback) { progressHook = callback; },
	};
}

test('provider places Authorization only in transport options and discards PCM buffered before task-started', async () => {
	const harness = providerHarness();
	const start = harness.provider.start(new AbortController().signal);
	await waitFor(() => harness.transport.texts.length === 1);
	for (let index = 0; index < 5; index += 1) harness.provider.acceptFrame(frame(index));
	assert.equal(harness.transport.binaries.length, 0);
	assert.equal(harness.transport.connectOptions.authorization, 'Bearer unit-test-secret');
	assert.doesNotMatch(harness.transport.connectOptions.endpoint, /secret|Bearer/i);
	harness.transport.emit(serverEvent('task-started'));
	await start;
	assert.equal(harness.transport.binaries.length, 0);
	assert.equal(harness.progress.at(-1).diagnostics.warmupDroppedChunkCount, 1);
	for (let index = 5; index < 10; index += 1) harness.provider.acceptFrame(frame(index));
	await waitFor(() => harness.transport.binaries.length === 1);
	await waitFor(() => harness.progress.at(-1)?.sentFrameCount === 5);
	assert.equal(harness.transport.binaries[0].byteLength, 3_200);
	assert.equal(harness.progress.at(-1).sentFrameCount, 5);
	assert.equal(harness.progress.at(-1).audioBaseOffsetMs, 1_100);
	harness.provider.dispose();
});

test('provider preserves unexpected compression failure and exposes only boolean diagnostics', async () => {
	class CompressionTransport extends FakeTransport {
		perMessageDeflateNegotiated = true;
		async connect(options) {
			this.connectOptions = options;
			throw new RealtimeAsrTransportError('unexpected-websocket-compression');
		}
	}
	const harness = providerHarness(undefined, new CompressionTransport());
	await assert.rejects(
		harness.provider.start(new AbortController().signal),
		(error) => error.code === 'unexpected-websocket-compression',
	);
	assert.deepEqual(harness.failures, ['unexpected-websocket-compression']);
	const diagnostics = harness.progress.at(-1).diagnostics;
	assert.equal(diagnostics.perMessageDeflateConfigured, false);
	assert.equal(diagnostics.perMessageDeflateNegotiated, true);
	assert.equal(harness.transport.binaries.length, 0);
	assert.doesNotMatch(JSON.stringify(diagnostics), /secret|Authorization|extensions|permessage-deflate/i);
});

test('provider obtains the current API key only when start connects and keeps it out of long-lived configuration', async () => {
	let key = 'first-runtime-key';
	let getterCalls = 0;
	const getApiKey = () => { getterCalls += 1; return key; };
	const first = providerHarness(undefined, new FakeTransport(), getApiKey);
	assert.equal(getterCalls, 0);
	assert.equal(Object.hasOwn(first.provider.options.configuration, 'apiKey'), false);
	const firstStart = first.provider.start(new AbortController().signal);
	await waitFor(() => first.transport.texts.length === 1);
	assert.equal(getterCalls, 1);
	assert.equal(first.transport.connectOptions.authorization, 'Bearer first-runtime-key');
	first.transport.emit(serverEvent('task-started'));
	await firstStart;
	first.provider.dispose();

	key = 'second-runtime-key';
	const second = providerHarness(undefined, new FakeTransport(), getApiKey);
	const secondStart = second.provider.start(new AbortController().signal);
	await waitFor(() => second.transport.texts.length === 1);
	assert.equal(getterCalls, 2);
	assert.equal(second.transport.connectOptions.authorization, 'Bearer second-runtime-key');
	second.transport.emit(serverEvent('task-started'));
	await secondStart;
	second.provider.dispose();
});

test('runTaskEverSent is set only after run-task write succeeds', async () => {
	const transport = new FakeTransport();
	transport.sendText = async () => { throw new Error('safe local failure'); };
	const harness = providerHarness(undefined, transport);
	await assert.rejects(
		harness.provider.start(new AbortController().signal),
		/connection-failed/,
	);
	const diagnostics = harness.progress.at(-1).diagnostics;
	assert.equal(diagnostics.socketEverOpened, true);
	assert.equal(diagnostics.runTaskEverSent, false);
	assert.equal(diagnostics.taskEverStarted, false);
	assert.equal(diagnostics.firstAudioEverDispatched, false);
});

test('provider rolls the pre-start warm-up queue at two seconds without reporting backpressure', async () => {
	const harness = providerHarness();
	void harness.provider.start(new AbortController().signal).catch(() => undefined);
	await waitFor(() => harness.transport.texts.length === 1);
	for (let index = 0; index < 100; index += 1) harness.provider.acceptFrame(frame(index));
	const droppedData = harness.provider.warmupQueue[0].data;
	assert.deepEqual(harness.failures, []);
	for (let index = 100; index < 105; index += 1) harness.provider.acceptFrame(frame(index));
	const diagnostics = harness.progress.at(-1).diagnostics;
	assert.deepEqual(harness.failures, []);
	assert.equal(diagnostics.warmupQueuedChunkCount, 20);
	assert.equal(diagnostics.warmupDroppedChunkCount, 1);
	assert.equal(diagnostics.warmupDroppedDurationMs, 100);
	assert.ok(droppedData.every((value) => value === 0));
	harness.provider.dispose();
});

test('provider sends residual PCM before finish-task and waits for task-finished', async () => {
	const harness = providerHarness();
	const start = harness.provider.start(new AbortController().signal);
	await waitFor(() => harness.transport.texts.length === 1);
	harness.transport.emit(serverEvent('task-started'));
	await start;
	for (let index = 0; index < 3; index += 1) harness.provider.acceptFrame(frame(index));
	const stop = harness.provider.stop();
	await waitFor(() => harness.transport.texts.length === 2);
	assert.equal(harness.transport.binaries[0].byteLength, 1_920);
	assert.equal(JSON.parse(harness.transport.texts[1]).header.action, 'finish-task');
	let stopped = false;
	stop.then(() => { stopped = true; });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(stopped, false);
	harness.transport.emit(serverEvent('task-finished'));
	await stop;
});

test('provider accepts residual results after finish-task and safely maps task failure', async () => {
	const harness = providerHarness();
	const start = harness.provider.start(new AbortController().signal);
	await waitFor(() => harness.transport.texts.length === 1);
	harness.transport.emit(serverEvent('task-started'));
	await start;
	const stop = harness.provider.stop();
	await waitFor(() => harness.transport.texts.length === 2);
	harness.transport.emit(resultEvent({
		begin_time: 0, end_time: 20, text: 'tail', sentence_end: true, sentence_id: 1,
	}));
	assert.equal(harness.segments.at(-1).text, 'tail');
	harness.transport.emit(serverEvent('task-finished'));
	await stop;

	const failed = providerHarness();
	const failedStart = failed.provider.start(new AbortController().signal);
	await waitFor(() => failed.transport.texts.length === 1);
	failed.transport.emit(JSON.stringify({
		header: { event: 'task-failed', task_id: 'task-1', error_code: 'REMOTE', error_message: 'secret body' },
		payload: {},
	}));
	await assert.rejects(failedStart);
	assert.deepEqual(failed.failures, ['task-failed']);
	assert.equal(failed.progress.at(-1).diagnostics.taskFailedEventCount, 1);
	assert.equal(failed.progress.at(-1).diagnostics.lastInboundEventKind, 'task-failed');
});

test('provider counts only safe inbound event kinds while transcript stays on the segment channel', async () => {
	const scheduler = new VirtualRealtimeScheduler();
	const harness = providerHarness(scheduler);
	const starting = harness.provider.start(new AbortController().signal);
	await waitFor(() => harness.transport.texts.length === 1);
	harness.transport.emit(serverEvent('task-started'));
	await starting;
	await scheduler.advanceBy(250);
	harness.transport.emit(resultEvent({ heartbeat: true, sentence_id: 0 }));
	harness.transport.emit(resultEvent({
		begin_time: 0, end_time: null, text: 'safe partial', sentence_end: false, sentence_id: 1,
	}));
	let diagnostics = harness.progress.at(-1).diagnostics;
	assert.equal(diagnostics.inboundMessageCount, 3);
	assert.equal(diagnostics.taskStartedEventCount, 1);
	assert.equal(diagnostics.resultGeneratedEventCount, 2);
	assert.equal(diagnostics.ignoredHeartbeatCount, 1);
	assert.equal(diagnostics.unknownEventCount, 0);
	assert.equal(diagnostics.lastInboundEventKind, 'result-generated');
	assert.equal(diagnostics.firstResultGeneratedLatencyMs, 250);
	assert.equal(harness.segments.length, 1);
	assert.equal(harness.segments[0].text, 'safe partial');
	const stopping = harness.provider.stop();
	await waitFor(() => harness.transport.texts.length === 2);
	harness.transport.emit(serverEvent('task-finished'));
	await stopping;
	diagnostics = harness.progress.at(-1).diagnostics;
	assert.equal(diagnostics.taskFinishedEventCount, 1);
	assert.equal(diagnostics.lastInboundEventKind, 'task-finished');
	assert.ok(diagnostics.providerStatePublishCount > 0);
	assert.ok(diagnostics.providerStatePublishRate >= 0);
	assert.ok(diagnostics.eventLoopLagCurrentMs >= 0);
	assert.ok(diagnostics.eventLoopLagMaxMs >= diagnostics.eventLoopLagCurrentMs);

	const unknown = providerHarness();
	const unknownStart = unknown.provider.start(new AbortController().signal);
	await waitFor(() => unknown.transport.texts.length === 1);
	unknown.transport.emit(serverEvent('not-supported'));
	await assert.rejects(unknownStart);
	assert.deepEqual(unknown.failures, ['protocol-error']);
	assert.equal(unknown.progress.at(-1).diagnostics.inboundMessageCount, 1);
	assert.equal(unknown.progress.at(-1).diagnostics.unknownEventCount, 1);
	assert.equal(unknown.progress.at(-1).diagnostics.lastInboundEventKind, 'unknown');
});

class ControlledScheduler {
	tasks = new Map();
	nextId = 1;
	now() { return 0; }
	setTimeout(callback) { const id = this.nextId++; this.tasks.set(id, callback); return id; }
	clearTimeout(id) { this.tasks.delete(id); }
	runAll() {
		const callbacks = [...this.tasks.values()];
		this.tasks.clear();
		for (const callback of callbacks) callback();
	}
}

test('provider bounds task-start and finish waits with safe timeout codes', async () => {
	const startScheduler = new ControlledScheduler();
	const starting = providerHarness(startScheduler);
	const start = starting.provider.start(new AbortController().signal);
	await waitFor(() => starting.transport.texts.length === 1);
	startScheduler.runAll();
	await assert.rejects(start, /task-start-failed/);
	assert.deepEqual(starting.failures, ['task-start-failed']);

	const finishScheduler = new ControlledScheduler();
	const finishing = providerHarness(finishScheduler);
	const ready = finishing.provider.start(new AbortController().signal);
	await waitFor(() => finishing.transport.texts.length === 1);
	finishing.transport.emit(serverEvent('task-started'));
	await ready;
	const stop = finishing.provider.stop();
	await waitFor(() => finishing.transport.texts.length === 2);
	finishScheduler.runAll();
	await stop;
	assert.deepEqual(finishing.failures, ['finish-timeout']);
});

test('provider stop during task startup closes without sending partial audio or finish-task', async () => {
	const harness = providerHarness();
	const start = harness.provider.start(new AbortController().signal);
	await waitFor(() => harness.transport.texts.length === 1);
	harness.provider.acceptFrame(frame(0));
	harness.provider.acceptFrame(frame(1));
	await harness.provider.stop();
	await assert.rejects(start);
	assert.equal(harness.transport.binaries.length, 0);
	assert.equal(harness.transport.texts.length, 1);
	assert.deepEqual(harness.failures, []);
});

test('provider pauses on WebSocket bufferedAmount pressure and resumes without overflowing', async () => {
	const harness = providerHarness();
	const start = harness.provider.start(new AbortController().signal);
	await waitFor(() => harness.transport.texts.length === 1);
	harness.transport.emit(serverEvent('task-started'));
	await start;
	harness.transport.bufferedAmount = 256 * 1024;
	for (let index = 0; index < 5; index += 1) harness.provider.acceptFrame(frame(index));
	assert.deepEqual(harness.failures, []);
	assert.equal(harness.transport.binaries.length, 0);
	assert.equal(harness.progress.at(-1).diagnostics.queuedChunkCount, 1);
	assert.equal(harness.progress.at(-1).diagnostics.lastPumpBlockReason, 'ws-buffer-limit');
	harness.transport.bufferedAmount = 0;
	harness.provider.requestPump();
	await waitFor(() => harness.transport.binaries.length === 1);
	await waitFor(() => harness.progress.at(-1).diagnostics.sentChunkCount === 1);
	assert.equal(harness.progress.at(-1).diagnostics.overflowReason, null);
	harness.provider.dispose();
});

test('provider enforces the real queued-chunk limit behind a slow sender and releases owned PCM', async () => {
	const transport = new FakeTransport();
	transport.sendBinary = async () => new Promise(() => {});
	const harness = providerHarness(undefined, transport);
	const start = harness.provider.start(new AbortController().signal);
	await waitFor(() => transport.texts.length === 1);
	transport.emit(serverEvent('task-started'));
	await start;
	for (let index = 0; index < 510; index += 1) harness.provider.acceptFrame(frame(index));
	assert.deepEqual(harness.failures, ['audio-buffer-overflow']);
	assert.equal(transport.disposeCalls, 1);
	assert.equal(harness.provider.queue.length, 0);
	assert.equal(harness.provider.aggregator.pendingFrameCount, 0);
});

test('finish-task send failures settle once and dispose the transport', async () => {
	for (const mode of ['throw', 'reject']) {
		const transport = new FakeTransport();
		transport.sendText = (message) => {
			transport.texts.push(message);
			if (JSON.parse(message).header.action === 'finish-task') {
				if (mode === 'throw') throw new Error('local detail');
				return Promise.reject(new Error('local detail'));
			}
			return Promise.resolve();
		};
		const harness = providerHarness(undefined, transport);
		const start = harness.provider.start(new AbortController().signal);
		await waitFor(() => transport.texts.length === 1);
		transport.emit(serverEvent('task-started'));
		await start;
		await harness.provider.stop();
		transport.connectOptions.handlers.onClose(1006);
		transport.connectOptions.handlers.onError({ code: 'connection-failed' });
		assert.deepEqual(harness.failures, ['connection-failed']);
		assert.equal(transport.disposeCalls, 1);
	}
});

test('provider bounds hung connect and binary send operations and dispose clears finish timers', async () => {
	const connectScheduler = new ControlledScheduler();
	const connectingTransport = new FakeTransport();
	connectingTransport.connect = async (options) => {
		connectingTransport.connectOptions = options;
		await new Promise(() => {});
	};
	const connecting = providerHarness(connectScheduler, connectingTransport);
	const connect = connecting.provider.start(new AbortController().signal);
	await waitFor(() => connectScheduler.tasks.size === 1);
	connectScheduler.runAll();
	await assert.rejects(connect, /connection-failed/);
	assert.deepEqual(connecting.failures, ['connection-failed']);

	const sendScheduler = new ControlledScheduler();
	const sendingTransport = new FakeTransport();
	sendingTransport.sendBinary = async () => new Promise(() => {});
	const sending = providerHarness(sendScheduler, sendingTransport);
	const started = sending.provider.start(new AbortController().signal);
	await waitFor(() => sending.transport.texts.length === 1);
	sending.transport.emit(serverEvent('task-started'));
	await started;
	for (let index = 0; index < 5; index += 1) sending.provider.acceptFrame(frame(index));
	await waitFor(() => sendScheduler.tasks.size === 1);
	sendScheduler.runAll();
	await waitFor(() => sending.failures.length === 1);
	assert.deepEqual(sending.failures, ['audio-send-timeout']);

	const disposeScheduler = new ControlledScheduler();
	const disposing = providerHarness(disposeScheduler);
	const ready = disposing.provider.start(new AbortController().signal);
	await waitFor(() => disposing.transport.texts.length === 1);
	disposing.transport.emit(serverEvent('task-started'));
	await ready;
	const stopping = disposing.provider.stop();
	await waitFor(() => disposing.transport.texts.length === 2);
	assert.equal(disposeScheduler.tasks.size, 1);
	disposing.provider.dispose();
	await stopping;
	assert.equal(disposeScheduler.tasks.size, 0);
});

class InjectedWebSocket {
	static instance = null;
	OPEN = 1;
	CLOSED = 3;
	readyState = 0;
	bufferedAmount = 0;
	extensions = '';
	listeners = new Map();
	sends = [];
	constructor(endpoint, options) {
		this.endpoint = endpoint;
		this.options = options;
		InjectedWebSocket.instance = this;
	}
	on(event, listener) { this.addListener(event, listener, false); }
	once(event, listener) { this.addListener(event, listener, true); }
	off(event, listener) {
		this.listeners.set(
			event,
			(this.listeners.get(event) ?? []).filter((entry) => entry.listener !== listener),
		);
	}
	removeAllListeners() { this.listeners.clear(); }
	addListener(event, listener, once) {
		const values = this.listeners.get(event) ?? [];
		values.push({ listener, once });
		this.listeners.set(event, values);
	}
	emit(event, ...args) {
		const values = this.listeners.get(event) ?? [];
		this.listeners.set(event, values.filter((entry) => !entry.once));
		for (const entry of values) entry.listener(...args);
	}
	send(data, options, callback) { this.sends.push({ binary: options.binary, compress: options.compress, text: typeof data === 'string' }); callback(); }
	close() { this.readyState = this.CLOSED; }
	terminate() { this.readyState = this.CLOSED; }
}

test('production transport keeps Bearer out of the URL and maps HTTP 401/403 safely', async () => {
	for (const statusCode of [401, 403]) {
		InjectedWebSocket.instance = null;
		const transport = createNodeRealtimeAsrTransport(async () => InjectedWebSocket);
		const connect = transport.connect({
			endpoint: 'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference',
			authorization: 'Bearer safe-test-secret',
			signal: new AbortController().signal,
			handlers: { onText() {}, onBinary() {}, onClose() {}, onError() {} },
		});
		await waitFor(() => InjectedWebSocket.instance !== null);
		const socket = InjectedWebSocket.instance;
		assert.doesNotMatch(socket.endpoint, /secret|Bearer/i);
		assert.equal(socket.options.headers.Authorization, 'Bearer safe-test-secret');
		assert.equal(socket.options.perMessageDeflate, false);
		socket.emit('unexpected-response', {}, { statusCode, resume() {} });
		await assert.rejects(connect, (error) => error.code === 'auth-failed');
		assert.doesNotMatch(JSON.stringify(transport), /safe-test-secret/);
		transport.dispose();
	}
});

test('production transport decodes text bytes and releases callbacks after dispose', async () => {
	InjectedWebSocket.instance = null;
	const messages = [];
	const transport = createNodeRealtimeAsrTransport(async () => InjectedWebSocket);
	const connect = transport.connect({
		endpoint: 'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference',
		authorization: 'Bearer safe-test-secret',
		signal: new AbortController().signal,
		handlers: {
			onText(message) { messages.push(message); },
			onBinary() {}, onClose() {}, onError() {},
		},
	});
	await waitFor(() => InjectedWebSocket.instance !== null);
	const socket = InjectedWebSocket.instance;
	socket.readyState = socket.OPEN;
	socket.emit('open');
	await connect;
	assert.equal(transport.perMessageDeflateConfigured, false);
	assert.equal(transport.perMessageDeflateNegotiated, false);
	await transport.sendText('safe-control');
	await transport.sendBinary(new Uint8Array(640));
	assert.deepEqual(socket.sends.map(({ binary, compress, text }) => ({ binary, compress, text })), [
		{ binary: false, compress: false, text: true },
		{ binary: true, compress: false, text: false },
	]);
	socket.emit('message', Buffer.from('转写结果', 'utf8'), false);
	assert.deepEqual(messages, ['转写结果']);
	transport.dispose();
	socket.emit('message', Buffer.from('late', 'utf8'), false);
	assert.deepEqual(messages, ['转写结果']);
});

test('production transport rejects an unexpectedly negotiated compression extension before PCM', async () => {
	class UnexpectedCompressionSocket extends InjectedWebSocket {
		extensions = 'permessage-deflate';
	}
	const transport = createNodeRealtimeAsrTransport(async () => UnexpectedCompressionSocket);
	const connecting = transport.connect({
		endpoint: 'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference',
		authorization: 'Bearer safe-test-secret',
		signal: new AbortController().signal,
		handlers: { onText() {}, onBinary() {}, onClose() {}, onError() {} },
	});
	await waitFor(() => InjectedWebSocket.instance instanceof UnexpectedCompressionSocket);
	const socket = InjectedWebSocket.instance;
	socket.readyState = socket.OPEN;
	socket.emit('open');
	await assert.rejects(connecting, (error) => error.code === 'unexpected-websocket-compression');
	assert.equal(transport.perMessageDeflateConfigured, false);
	assert.equal(transport.perMessageDeflateNegotiated, true);
	assert.equal(socket.sends.length, 0);
	assert.doesNotMatch(JSON.stringify(transport), /safe-test-secret|Sec-WebSocket-Extensions/i);
	transport.dispose();
});

test('diagnostic PCM is deterministic bounded non-speech s16le and absent from result shapes', () => {
	const first = createDiagnosticPcmChunk(7);
	const again = createDiagnosticPcmChunk(7);
	const next = createDiagnosticPcmChunk(8);
	assert.equal(first.byteLength, 3_200);
	assert.deepEqual(first, again);
	assert.notDeepEqual(first, next);
	const view = new DataView(first.buffer, first.byteOffset, first.byteLength);
	for (let offset = 0; offset < first.byteLength; offset += 2) {
		assert.ok(Math.abs(view.getInt16(offset, true)) <= 512);
	}
	assert.doesNotMatch(JSON.stringify(emptyAbResult()), /pcm|base64|apiKey|authorization|transcript/i);
	first.fill(0);
	again.fill(0);
	next.fill(0);
});

test('production transport listeners do not retain the sensitive connect options object', async () => {
	InjectedWebSocket.instance = null;
	const messages = [];
	const handlers = {
		onText(message) { messages.push(message); },
		onBinary() {}, onClose() {}, onError() {},
	};
	const connectOptions = {
		endpoint: 'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference',
		authorization: 'Bearer short-lived-secret',
		signal: new AbortController().signal,
		handlers,
	};
	const transport = createNodeRealtimeAsrTransport(async () => InjectedWebSocket);
	const connect = transport.connect(connectOptions);
	await waitFor(() => InjectedWebSocket.instance !== null);
	const socket = InjectedWebSocket.instance;
	socket.readyState = socket.OPEN;
	socket.emit('open');
	await connect;
	connectOptions.authorization = 'replacement';
	connectOptions.handlers = {
		onText() { throw new Error('sensitive options object was retained'); },
		onBinary() {}, onClose() {}, onError() {},
	};
	socket.emit('message', Buffer.from('isolated', 'utf8'), false);
	assert.deepEqual(messages, ['isolated']);
	transport.dispose();
});

test('production transport settles callback errors, synchronous throws, and pending sends on dispose', async () => {
	class CallbackErrorSocket extends InjectedWebSocket {
		send(_data, _options, callback) { callback(new Error('safe test failure')); }
	}
	class ThrowingSocket extends InjectedWebSocket {
		send() { throw new Error('safe test failure'); }
	}
	class HangingSocket extends InjectedWebSocket {
		pendingCallback = null;
		send(_data, _options, callback) { this.pendingCallback = callback; }
	}

	for (const SocketClass of [CallbackErrorSocket, ThrowingSocket]) {
		const transport = createNodeRealtimeAsrTransport(async () => SocketClass);
		const connecting = transport.connect({
			endpoint: 'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference',
			authorization: 'Bearer safe-test-secret',
			signal: new AbortController().signal,
			handlers: { onText() {}, onBinary() {}, onClose() {}, onError() {} },
		});
		await waitFor(() => InjectedWebSocket.instance instanceof SocketClass);
		const socket = InjectedWebSocket.instance;
		socket.readyState = socket.OPEN;
		socket.emit('open');
		await connecting;
		await assert.rejects(
			transport.sendBinary(new Uint8Array(640)),
			(error) => error.code === 'connection-failed',
		);
		transport.dispose();
	}

	const hangingTransport = createNodeRealtimeAsrTransport(async () => HangingSocket);
	const connecting = hangingTransport.connect({
		endpoint: 'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference',
		authorization: 'Bearer safe-test-secret',
		signal: new AbortController().signal,
		handlers: { onText() {}, onBinary() {}, onClose() {}, onError() {} },
	});
	await waitFor(() => InjectedWebSocket.instance instanceof HangingSocket);
	const socket = InjectedWebSocket.instance;
	socket.readyState = socket.OPEN;
	socket.emit('open');
	await connecting;
	const pending = hangingTransport.sendBinary(new Uint8Array(640));
	assert.equal(hangingTransport.pendingSends.size, 1);
	hangingTransport.dispose();
	await assert.rejects(pending, (error) => error.code === 'remote-closed');
	assert.equal(hangingTransport.pendingSends.size, 0);
	socket.pendingCallback?.();
});

class VirtualRealtimeScheduler {
	currentTime = 0;
	nextId = 1;
	tasks = new Map();
	now() { return this.currentTime; }
	setTimeout(callback, delayMs) {
		const id = this.nextId++;
		this.tasks.set(id, { callback, dueAt: this.currentTime + delayMs });
		return id;
	}
	clearTimeout(id) { this.tasks.delete(id); }
	async advanceBy(delayMs) {
		await new Promise((resolve) => setImmediate(resolve));
		this.currentTime += delayMs;
		for (;;) {
			const due = [...this.tasks.entries()]
				.filter(([, task]) => task.dueAt <= this.currentTime)
				.sort((left, right) => left[1].dueAt - right[1].dueAt);
			if (due.length === 0) break;
			for (const [id, task] of due) {
				if (!this.tasks.delete(id)) continue;
				task.callback();
			}
			await new Promise((resolve) => setImmediate(resolve));
		}
	}
}

class JitteredRealtimeScheduler extends VirtualRealtimeScheduler {
	jitterIndex = 0;
	constructor(jitterPattern = [1, 3, 5, 7, 9, 11, 13, 15]) {
		super();
		this.jitterPattern = jitterPattern;
	}
	setTimeout(callback, delayMs) {
		const id = this.nextId++;
		const jitter = delayMs <= 0
			? 0
			: this.jitterPattern[this.jitterIndex++ % this.jitterPattern.length];
		this.tasks.set(id, { callback, dueAt: this.currentTime + delayMs + jitter });
		return id;
	}
	async advanceTo(targetTime) {
		if (targetTime < this.currentTime) throw new Error('Cannot move the monotonic clock backwards.');
		for (;;) {
			const nextDueAt = Math.min(
				...([...this.tasks.values()].map((task) => task.dueAt)),
				Number.POSITIVE_INFINITY,
			);
			if (nextDueAt > targetTime) break;
			this.currentTime = nextDueAt;
			await this.runDueAtCurrentTime();
		}
		this.currentTime = targetTime;
		await Promise.resolve();
		await Promise.resolve();
	}
	async stallTo(targetTime) {
		if (targetTime < this.currentTime) throw new Error('Cannot move the monotonic clock backwards.');
		this.currentTime = targetTime;
		await this.runDueAtCurrentTime();
	}
	nextDueAt() {
		return Math.min(
			...([...this.tasks.values()].map((task) => task.dueAt)),
			Number.POSITIVE_INFINITY,
		);
	}
	async runDueAtCurrentTime() {
		for (;;) {
			const due = [...this.tasks.entries()]
				.filter(([, task]) => task.dueAt <= this.currentTime)
				.sort((left, right) => left[1].dueAt - right[1].dueAt);
			if (due.length === 0) break;
			for (const [id, task] of due) {
				if (!this.tasks.delete(id)) continue;
				task.callback();
			}
			await Promise.resolve();
			await Promise.resolve();
		}
	}
}

test('A/B diagnostic is single-instance, runs current before minimal, and waits two seconds', async () => {
	const scheduler = new VirtualRealtimeScheduler();
	const order = [];
	const progress = [];
	const diagnostic = new RealtimeAsrTransportAbDiagnostic({
		getConfiguration: () => ({ workspaceId: 'workspace-test', region: 'cn-beijing', model: 'model-test' }),
		getApiKey: () => 'runtime-test-key',
		currentRunner: async () => { order.push('current'); return emptyAbResult({ runnerKind: 'current-transport', status: 'normal' }); },
		minimalRunner: async () => { order.push('minimal'); return emptyAbResult({ runnerKind: 'official-sequence-minimal', status: 'normal' }); },
		scheduler,
	});
	diagnostic.subscribe((value) => progress.push(value));
	const first = diagnostic.run();
	const duplicate = diagnostic.run();
	assert.equal(first, duplicate);
	await waitFor(() => order.length === 1);
	assert.deepEqual(order, ['current']);
	assert.equal(diagnostic.progress.phase, 'between-runs');
	await scheduler.advanceBy(1_999);
	assert.deepEqual(order, ['current']);
	await scheduler.advanceBy(1);
	const comparison = await first;
	assert.deepEqual(order, ['current', 'minimal']);
	assert.equal(comparison.conclusion, 'transient-or-not-reproduced');
	assert.equal(diagnostic.progress.phase, 'completed');
	assert.ok(progress.length >= 4);
	diagnostic.dispose();
	assert.equal(scheduler.tasks.size, 0);
});

test('cancelling the first A/B route prevents the minimal route and clears the delay', async () => {
	const scheduler = new VirtualRealtimeScheduler();
	let minimalCalls = 0;
	const diagnostic = new RealtimeAsrTransportAbDiagnostic({
		getConfiguration: () => ({ workspaceId: 'workspace-test', region: 'cn-beijing', model: 'model-test' }),
		getApiKey: () => 'runtime-test-key',
		currentRunner: async ({ signal }) => new Promise((resolve) => {
			signal.addEventListener('abort', () => resolve(emptyAbResult({
				runnerKind: 'current-transport', status: 'cancelled', cancelled: true,
				stableErrorCode: 'cancelled',
			})), { once: true });
		}),
		minimalRunner: async () => { minimalCalls += 1; return emptyAbResult(); },
		scheduler,
	});
	const running = diagnostic.run();
	await waitFor(() => diagnostic.isRunning);
	diagnostic.cancel();
	assert.equal(await running, null);
	assert.equal(minimalCalls, 0);
	assert.equal(diagnostic.progress.phase, 'cancelled');
	assert.equal(scheduler.tasks.size, 0);
	diagnostic.dispose();
});

test('A/B result and final conclusion classifiers cover all fixed outcomes', () => {
	const normal = emptyAbResult({ status: 'normal' });
	const backlog = emptyAbResult({
		status: 'backlog', stableErrorCode: 'audio-buffer-overflow', maxQueuedCount: 20,
	});
	const failed = emptyAbResult({ status: 'failed', stableErrorCode: 'connection-failed' });
	const cancelled = emptyAbResult({ status: 'cancelled', cancelled: true, stableErrorCode: 'cancelled' });
	const inconclusive = emptyAbResult({
		status: 'inconclusive', dispatchCount: 449, successCount: 449,
		maxInFlightCount: 0, maxQueuedCount: 0,
	});
	assert.equal(classifyRealtimeAsrTransportAbResult(normal), 'normal');
	assert.equal(classifyRealtimeAsrTransportAbResult(backlog), 'backlog');
	assert.equal(classifyRealtimeAsrTransportAbResult(failed), 'failed');
	assert.equal(classifyRealtimeAsrTransportAbResult(cancelled), 'cancelled');
	assert.equal(classifyRealtimeAsrTransportAbResult(inconclusive), 'inconclusive');
	assert.equal(classifyRealtimeAsrTransportAbConclusion(backlog, backlog), 'probable-network-or-service-path');
	assert.equal(classifyRealtimeAsrTransportAbConclusion(backlog, normal), 'probable-production-transport-difference');
	assert.equal(classifyRealtimeAsrTransportAbConclusion(normal, normal), 'transient-or-not-reproduced');
	assert.equal(classifyRealtimeAsrTransportAbConclusion(
		{ ...normal, resultGeneratedEventCount: 1 }, failed,
	), 'diagnostic-not-equivalent-or-minimal-runner-defect');
	assert.equal(classifyRealtimeAsrTransportAbConclusion(normal, inconclusive), 'inconclusive');
});

test('current and official-sequence runners send identical generated PCM for 750 paced chunks', async () => {
	const currentScheduler = new VirtualRealtimeScheduler();
	const currentChecksums = [];
	class CurrentSocket extends InjectedWebSocket {
		constructor(endpoint, options) {
			super(endpoint, options);
			queueMicrotask(() => { this.readyState = this.OPEN; this.emit('open'); });
		}
		send(data, options, callback) {
			this.sends.push({ binary: options.binary, compress: options.compress, text: typeof data === 'string' });
			if (typeof data === 'string') {
				const control = JSON.parse(data);
				callback();
				queueMicrotask(() => this.emit(
					'message',
					Buffer.from(serverEvent(
						control.header.action === 'run-task' ? 'task-started' : 'task-finished',
						control.header.task_id,
					)),
					false,
				));
				return;
			}
			currentChecksums.push(checksum(data));
			callback();
		}
		terminate() { this.readyState = this.CLOSED; queueMicrotask(() => this.emit('close', 1000)); }
	}
	const currentPromise = runCurrentTransportDiagnostic({
		configuration: { workspaceId: 'workspace-test', region: 'cn-beijing', model: 'model-test' },
		getApiKey: () => 'runtime-test-key',
		signal: new AbortController().signal,
		onProgress() {},
		scheduler: currentScheduler,
		transportFactory: () => createNodeRealtimeAsrTransport(async () => CurrentSocket),
		taskIdFactory: () => 'task-current',
	});
	const current = await driveVirtualPromise(currentPromise, currentScheduler);
	const currentSocket = InjectedWebSocket.instance;

	const minimalScheduler = new VirtualRealtimeScheduler();
	const minimalChecksums = [];
	class MinimalSocket extends InjectedWebSocket {
		constructor(endpoint, options) {
			super(endpoint, options);
			queueMicrotask(() => { this.readyState = this.OPEN; this.emit('open'); });
		}
		send(data, options, callback) {
			this.sends.push({ binary: options.binary, compress: options.compress, text: typeof data === 'string' });
			if (typeof data === 'string') {
				const control = JSON.parse(data);
				callback();
				queueMicrotask(() => this.emit(
					'message',
					Buffer.from(serverEvent(
						control.header.action === 'run-task' ? 'task-started' : 'task-finished',
						control.header.task_id,
					)),
					false,
				));
				return;
			}
			minimalChecksums.push(checksum(data));
			callback();
		}
		terminate() { this.readyState = this.CLOSED; queueMicrotask(() => this.emit('close', 1000)); }
	}
	const minimalPromise = runOfficialSequenceMinimalDiagnostic({
		configuration: { workspaceId: 'workspace-test', region: 'cn-beijing', model: 'model-test' },
		getApiKey: () => 'runtime-test-key',
		signal: new AbortController().signal,
		onProgress() {},
		scheduler: minimalScheduler,
		loadWs: async () => MinimalSocket,
		taskIdFactory: () => 'task-minimal',
	});
	const minimal = await driveVirtualPromise(minimalPromise, minimalScheduler);
	const diagnosticSocket = InjectedWebSocket.instance;

	assert.equal(current.status, 'normal', JSON.stringify(current));
	assert.equal(minimal.status, 'normal', JSON.stringify(minimal));
	assert.equal(current.durationTargetMs, 75_000);
	assert.equal(minimal.durationTargetMs, 75_000);
	assert.ok(current.wallElapsedMs >= 75_000);
	assert.ok(minimal.wallElapsedMs >= 75_000);
	assert.equal(current.dispatchCount, 750);
	assert.equal(minimal.dispatchCount, 750);
	assert.equal(current.successCount, 750);
	assert.equal(minimal.successCount, 750);
	assert.deepEqual(current.intervalSamples.map((sample) => sample.elapsedMs), [15_000, 30_000, 45_000, 60_000, 75_000]);
	assert.deepEqual(minimal.intervalSamples.map((sample) => sample.elapsedMs), [15_000, 30_000, 45_000, 60_000, 75_000]);
	assert.equal(current.maxDispatchBurstCount, 1);
	assert.equal(minimal.maxDispatchBurstCount, 1);
	assert.ok((current.minDispatchIntervalMs ?? 0) >= 100);
	assert.ok((minimal.minDispatchIntervalMs ?? 0) >= 100);
	assert.deepEqual(currentChecksums, minimalChecksums);
	assert.equal(currentSocket.options.perMessageDeflate, false);
	assert.ok(currentSocket.sends.every((entry) => entry.compress === false));
	assert.equal(diagnosticSocket.options.perMessageDeflate, false);
	assert.ok(diagnosticSocket.sends.every((entry) => entry.compress === false));
	assert.doesNotMatch(JSON.stringify(current), /runtime-test-key|pcm|base64|transcript|workspace-test/i);
	assert.doesNotMatch(JSON.stringify(minimal), /runtime-test-key|pcm|base64|transcript|workspace-test/i);
	assert.equal(currentScheduler.tasks.size, 0);
	assert.equal(minimalScheduler.tasks.size, 0);
});

test('A/B production PCM follows an absolute source clock while the minimal route remains the network timing reference', async () => {
	class ClockDiagnosticSocket extends InjectedWebSocket {
		constructor(endpoint, options) {
			super(endpoint, options);
			queueMicrotask(() => { this.readyState = this.OPEN; this.emit('open'); });
		}
		send(data, _options, callback) {
			callback();
			if (typeof data !== 'string') return;
			const control = JSON.parse(data);
			queueMicrotask(() => this.emit(
				'message',
				Buffer.from(serverEvent(
					control.header.action === 'run-task' ? 'task-started' : 'task-finished',
					control.header.task_id,
				)),
				false,
			));
		}
		close() { this.readyState = this.CLOSED; queueMicrotask(() => this.emit('close', 1000)); }
		terminate() { this.readyState = this.CLOSED; queueMicrotask(() => this.emit('close', 1000)); }
	}
	const currentScheduler = new JitteredRealtimeScheduler();
	const current = await driveJitteredPromise(runCurrentTransportDiagnostic({
		configuration: { workspaceId: 'workspace-test', region: 'cn-beijing', model: 'model-test' },
		getApiKey: () => 'runtime-test-key', signal: new AbortController().signal,
		onProgress() {}, scheduler: currentScheduler,
		transportFactory: () => createNodeRealtimeAsrTransport(async () => ClockDiagnosticSocket),
		taskIdFactory: () => 'absolute-source-task',
	}), currentScheduler);
	const minimalScheduler = new JitteredRealtimeScheduler();
	const minimal = await driveJitteredPromise(runOfficialSequenceMinimalDiagnostic({
		configuration: { workspaceId: 'workspace-test', region: 'cn-beijing', model: 'model-test' },
		getApiKey: () => 'runtime-test-key', signal: new AbortController().signal,
		onProgress() {}, scheduler: minimalScheduler,
		loadWs: async () => ClockDiagnosticSocket,
		taskIdFactory: () => 'minimal-reference-task',
	}), minimalScheduler);
	assert.equal(current.status, 'normal', JSON.stringify(current));
	assert.equal(minimal.status, 'normal', JSON.stringify(minimal));
	assert.equal(current.dispatchCount, 750);
	assert.equal(minimal.dispatchCount, 750);
	assert.ok(current.wallElapsedMs < 76_000);
	assert.ok(minimal.wallElapsedMs > 78_000);
	assert.ok(minimal.wallElapsedMs - current.wallElapsedMs > 3_000);
	assert.equal(currentScheduler.tasks.size, 0);
	assert.equal(minimalScheduler.tasks.size, 0);
});

test('official-sequence runner cancellation settles sends, closes the socket, and stops before finish-task', async () => {
	const scheduler = new VirtualRealtimeScheduler();
	const abortController = new AbortController();
	class CancellingSocket extends InjectedWebSocket {
		binaryCount = 0;
		constructor(endpoint, options) {
			super(endpoint, options);
			queueMicrotask(() => { this.readyState = this.OPEN; this.emit('open'); });
		}
		send(data, options, callback) {
			this.sends.push({ binary: options.binary, compress: options.compress, text: typeof data === 'string' });
			if (typeof data === 'string') {
				const control = JSON.parse(data);
				callback();
				if (control.header.action === 'run-task') {
					queueMicrotask(() => this.emit(
						'message', Buffer.from(serverEvent('task-started', control.header.task_id)), false,
					));
				}
				return;
			}
			this.binaryCount += 1;
			callback();
			if (this.binaryCount === 3) abortController.abort();
		}
		terminate() { this.readyState = this.CLOSED; queueMicrotask(() => this.emit('close', 1000)); }
	}
	const result = await driveVirtualPromise(runOfficialSequenceMinimalDiagnostic({
		configuration: { workspaceId: 'workspace-test', region: 'cn-beijing', model: 'model-test' },
		getApiKey: () => 'runtime-test-key',
		signal: abortController.signal,
		onProgress() {}, scheduler,
		loadWs: async () => CancellingSocket,
		taskIdFactory: () => 'task-cancel',
	}), scheduler);
	const socket = InjectedWebSocket.instance;
	assert.equal(result.status, 'cancelled');
	assert.equal(result.cancelled, true);
	assert.equal(socket.binaryCount, 3);
	assert.equal(socket.readyState, socket.CLOSED);
	assert.equal(socket.listeners.size, 0);
	assert.equal(scheduler.tasks.size, 0);
	assert.equal(socket.sends.filter((entry) => entry.text).length, 1);
});

test('official-sequence runner bounds connect, task-started, and task-finished waits', async () => {
	for (const scenario of ['connect', 'task-started', 'task-finished']) {
		const scheduler = new VirtualRealtimeScheduler();
		class TimeoutSocket extends InjectedWebSocket {
			constructor(endpoint, options) {
				super(endpoint, options);
				if (scenario !== 'connect') {
					queueMicrotask(() => { this.readyState = this.OPEN; this.emit('open'); });
				}
			}
			send(data, options, callback) {
				this.sends.push({ binary: options.binary, compress: options.compress, text: typeof data === 'string' });
				callback();
				if (typeof data !== 'string') return;
				const control = JSON.parse(data);
				if (scenario === 'task-finished' && control.header.action === 'run-task') {
					queueMicrotask(() => this.emit(
						'message', Buffer.from(serverEvent('task-started', control.header.task_id)), false,
					));
				}
			}
			terminate() { this.readyState = this.CLOSED; queueMicrotask(() => this.emit('close', 1000)); }
		}
		const result = await driveVirtualPromise(runOfficialSequenceMinimalDiagnostic({
			configuration: { workspaceId: 'workspace-test', region: 'cn-beijing', model: 'model-test' },
			getApiKey: () => 'runtime-test-key', signal: new AbortController().signal,
			onProgress() {}, scheduler, loadWs: async () => TimeoutSocket,
			taskIdFactory: () => `task-${scenario}`,
		}), scheduler, 1_200);
		const socket = InjectedWebSocket.instance;
		assert.equal(result.status, 'failed');
		assert.equal(result.stableErrorCode, scenario === 'connect'
			? 'connection-failed'
			: scenario === 'task-started' ? 'task-start-failed' : 'finish-timeout');
		assert.equal(socket.readyState, socket.CLOSED);
		assert.equal(socket.listeners.size, 0);
		assert.equal(scheduler.tasks.size, 0);
	}
});

test('A/B diagnostics remain internally testable but are not registered in the production command palette', async () => {
	const [main, modal, diagnostic] = await Promise.all([
		readFile('main.ts', 'utf8'),
		readFile('realtime-asr-transport-ab-modal.ts', 'utf8'),
		readFile('realtime-asr-transport-ab-diagnostic.ts', 'utf8'),
	]);
	assert.doesNotMatch(main, /id: 'run-realtime-asr-transport-ab-diagnostic'/);
	assert.doesNotMatch(main, /name: '运行Realtime ASR Transport A\/B诊断（开发）'/);
	assert.match(main, /private openRealtimeAsrTransportAbDiagnostic\(\): void/);
	assert.match(main, /请先停止当前课堂监听和实时转写。/);
	assert.match(main, /realtimeAsrTransportAbModal\?\.close\(\)/);
	assert.match(modal, /每一路固定运行75秒[\s\S]*?两路总计约150秒真实百炼ASR用量/);
	assert.match(modal, /开始诊断[\s\S]*?取消诊断[\s\S]*?重新运行[\s\S]*?关闭/);
	assert.match(modal, /onClose\(\)[\s\S]*?diagnostic\.cancel\(\)[\s\S]*?diagnostic\.dispose\(\)/);
	assert.match(diagnostic, /new BailianStreamingAsrProvider/);
	assert.match(diagnostic, /createNodeRealtimeAsrTransport/);
	assert.match(diagnostic, /new Ws\(endpoint,[\s\S]*?perMessageDeflate: false/);
	assert.match(diagnostic, /compress: false/);
	assert.doesNotMatch(diagnostic, /AudioCompanionSessionController|WasapiLoopbackCapture|writeFile|saveData|createBinary/);
	assert.doesNotMatch(modal, /apiKey|Authorization|workspaceId|endpoint|Base64|transcript/);
});

function productionSenderHarness({
	latencyForBinary = () => 20,
	flushDelayForBinary = null,
	repeatCallback = false,
	autoTaskStarted = true,
	openDelayMs = 0,
	taskStartedDelayMs = 0,
	runTaskWriteDelayMs = 0,
	scheduler: suppliedScheduler = null,
	captureBinaryPayloads = true,
} = {}) {
	const scheduler = suppliedScheduler ?? new VirtualRealtimeScheduler();
	const control = {
		socket: null,
		binaries: [],
		binaryDispatchTimes: [],
		binaryIdentifiers: [],
		textActions: [],
		activeCallbacks: 0,
		maxActiveCallbacks: 0,
		maxBufferedAmount: 0,
		pendingBinaryCallbacks: [],
		taskId: null,
		emitTaskStarted() {
			if (!this.socket || !this.taskId) throw new Error('run-task is not ready');
			this.socket.emit(
				'message',
				Buffer.from(serverEvent('task-started', this.taskId)),
				false,
			);
		},
	};
	class SenderSocket extends InjectedWebSocket {
		constructor(endpoint, options) {
			super(endpoint, options);
			control.socket = this;
			const open = () => {
				this.readyState = this.OPEN;
				this.emit('open');
			};
			if (openDelayMs === 0) queueMicrotask(open);
			else scheduler.setTimeout(open, openDelayMs);
		}
		send(data, _options, callback) {
			if (typeof data === 'string') {
				const message = JSON.parse(data);
				const completeWrite = () => {
					callback();
					control.textActions.push(message.header.action);
					if (message.header.action === 'run-task') control.taskId = message.header.task_id;
					const event = message.header.action === 'run-task'
						? (autoTaskStarted ? 'task-started' : null)
						: message.header.action === 'finish-task'
							? 'task-finished'
							: null;
					if (event) {
						const emitEvent = () => this.emit(
							'message',
							Buffer.from(serverEvent(event, message.header.task_id)),
							false,
						);
						if (event !== 'task-started' || taskStartedDelayMs === 0) {
							queueMicrotask(emitEvent);
						} else {
							scheduler.setTimeout(emitEvent, taskStartedDelayMs);
						}
					}
				};
				if (message.header.action === 'run-task' && runTaskWriteDelayMs > 0) {
					scheduler.setTimeout(completeWrite, runTaskWriteDelayMs);
				} else completeWrite();
				return;
			}
			const binaryIndex = control.binaries.length;
			control.binaries.push(data.slice(0, captureBinaryPayloads ? data.byteLength : 4));
			control.binaryIdentifiers.push(new DataView(
				data.buffer,
				data.byteOffset,
				data.byteLength,
			).getUint32(0, true));
			control.binaryDispatchTimes.push(scheduler.now());
			if (flushDelayForBinary !== null) {
				const framedBytes = data.byteLength + realtimeAsrClientFrameOverhead(data.byteLength);
				this.bufferedAmount += framedBytes;
				control.maxBufferedAmount = Math.max(control.maxBufferedAmount, this.bufferedAmount);
				const flushDelayMs = flushDelayForBinary(binaryIndex);
				scheduler.setTimeout(() => {
					this.bufferedAmount = Math.max(0, this.bufferedAmount - framedBytes);
				}, flushDelayMs);
			}
			control.activeCallbacks += 1;
			control.maxActiveCallbacks = Math.max(
				control.maxActiveCallbacks,
				control.activeCallbacks,
			);
			const callbackDelayMs = latencyForBinary(binaryIndex);
			let callbackAccounted = false;
			const invokeCallback = (error) => {
				if (!callbackAccounted) {
					callbackAccounted = true;
					control.activeCallbacks -= 1;
				}
				callback(error);
			};
			if (callbackDelayMs === null) {
				control.pendingBinaryCallbacks.push(invokeCallback);
				return;
			}
			scheduler.setTimeout(() => {
				invokeCallback();
				if (repeatCallback) invokeCallback();
			}, callbackDelayMs);
		}
	}
	const transport = createNodeRealtimeAsrTransport(async () => SenderSocket);
	const harness = providerHarness(scheduler, transport);
	return { ...harness, scheduler, control };
}

async function startProductionSender(harness) {
	await harness.provider.start(new AbortController().signal);
	assert.equal(harness.control.socket.options.perMessageDeflate, false);
}

function pushChunks(provider, firstSequence, chunkCount) {
	let sequence = firstSequence;
	for (let chunk = 0; chunk < chunkCount; chunk += 1) {
		for (let part = 0; part < 5; part += 1) provider.acceptFrame(frame(sequence++));
	}
	return sequence;
}

function pushIdentifiedChunk(provider, firstSequence, chunkId) {
	let sequence = firstSequence;
	for (let part = 0; part < 5; part += 1) {
		const value = frame(sequence++, 0);
		if (part === 0) {
			new DataView(value.pcm.buffer, value.pcm.byteOffset, value.pcm.byteLength)
				.setUint32(0, chunkId, true);
		}
		provider.acceptFrame(value);
	}
	return sequence;
}

function latestDiagnostics(harness) {
	return harness.progress.at(-1)?.diagnostics;
}

function assertChunkLedger(diagnostics) {
	assert.equal(
		diagnostics.producedChunkCount,
		diagnostics.warmupDroppedChunkCount
			+ diagnostics.sentChunkCount
			+ diagnostics.warmupQueuedChunkCount
			+ diagnostics.queuedChunkCount
			+ diagnostics.inFlightSendCount,
	);
}

function assertDispatchLedger(diagnostics) {
	assert.equal(
		diagnostics.dispatchChunkCount,
		diagnostics.sendCallbackSettledCount + diagnostics.inFlightSendCount,
	);
	assert.equal(
		diagnostics.sendCallbackSettledCount,
		diagnostics.sendCallbackSuccessCount + diagnostics.sendCallbackFailureCount,
	);
}

async function pushRealtimeChunks(harness, firstSequence, chunkCount, intervalMs = 100) {
	let sequence = firstSequence;
	let maxLiveQueued = 0;
	let maxInFlight = 0;
	let maxOutstanding = 0;
	for (let chunk = 0; chunk < chunkCount; chunk += 1) {
		sequence = pushChunks(harness.provider, sequence, 1);
		let diagnostics = latestDiagnostics(harness);
		assertChunkLedger(diagnostics);
		assertDispatchLedger(diagnostics);
		maxLiveQueued = Math.max(maxLiveQueued, diagnostics.queuedChunkCount);
		maxInFlight = Math.max(maxInFlight, diagnostics.inFlightSendCount);
		maxOutstanding = Math.max(maxOutstanding, diagnostics.outstandingChunkCount);
		await harness.scheduler.advanceBy(intervalMs);
		diagnostics = latestDiagnostics(harness);
		assertChunkLedger(diagnostics);
		assertDispatchLedger(diagnostics);
		maxLiveQueued = Math.max(maxLiveQueued, diagnostics.queuedChunkCount);
		maxInFlight = Math.max(maxInFlight, diagnostics.inFlightSendCount);
		maxOutstanding = Math.max(maxOutstanding, diagnostics.outstandingChunkCount);
	}
	return { sequence, maxLiveQueued, maxInFlight, maxOutstanding };
}

async function advanceInSteps(scheduler, totalMs, stepMs = 100) {
	let remaining = totalMs;
	while (remaining > 0) {
		const step = Math.min(stepMs, remaining);
		await scheduler.advanceBy(step);
		remaining -= step;
	}
}

test('production pre-ready routing keeps one hundred chunks out of the live queue', async () => {
	const beforeSocket = productionSenderHarness({
		autoTaskStarted: false,
		openDelayMs: 60_000,
	});
	const beforeSocketStart = beforeSocket.provider
		.start(new AbortController().signal)
		.catch(() => undefined);
	pushChunks(beforeSocket.provider, 0, 100);
	let diagnostics = latestDiagnostics(beforeSocket);
	assert.equal(diagnostics.socketOpen, false);
	assert.equal(diagnostics.taskStarted, false);
	assert.equal(diagnostics.audioSendReady, false);
	assert.equal(diagnostics.warmupQueuedChunkCount, 20);
	assert.equal(diagnostics.warmupDroppedChunkCount, 80);
	assert.equal(diagnostics.queuedChunkCount, 0);
	assert.equal(diagnostics.inFlightSendCount, 0);
	assert.equal(beforeSocket.provider.liveOutstandingChunkCount(), 0);
	assert.equal(diagnostics.overflowReason, null);
	assert.deepEqual(beforeSocket.failures, []);
	beforeSocket.provider.dispose();
	await beforeSocketStart;

	const beforeTask = productionSenderHarness({ autoTaskStarted: false });
	const beforeTaskStart = beforeTask.provider
		.start(new AbortController().signal)
		.catch(() => undefined);
	await waitFor(() => beforeTask.control.textActions.includes('run-task'));
	pushChunks(beforeTask.provider, 0, 100);
	diagnostics = latestDiagnostics(beforeTask);
	assert.equal(diagnostics.socketOpen, true);
	assert.equal(diagnostics.taskStarted, false);
	assert.equal(diagnostics.audioSendReady, false);
	assert.equal(diagnostics.warmupQueuedChunkCount, 20);
	assert.equal(diagnostics.warmupDroppedChunkCount, 80);
	assert.equal(diagnostics.queuedChunkCount, 0);
	assert.equal(diagnostics.inFlightSendCount, 0);
	assert.equal(beforeTask.provider.liveOutstandingChunkCount(), 0);
	assert.equal(diagnostics.overflowReason, null);
	assert.deepEqual(beforeTask.failures, []);
	beforeTask.provider.dispose();
	await beforeTaskStart;
});

test('production sender discards warm-up chunks when task-started opens the live gate', async () => {
	const harness = productionSenderHarness({
		autoTaskStarted: false,
		latencyForBinary: () => 0,
	});
	const starting = harness.provider.start(new AbortController().signal);
	await waitFor(() => harness.control.textActions.includes('run-task'));
	pushChunks(harness.provider, 0, 10);
	let diagnostics = latestDiagnostics(harness);
	assert.equal(diagnostics.producedChunkCount, 10);
	assert.equal(diagnostics.sentChunkCount, 0);
	assert.equal(diagnostics.queuedChunkCount, 0);
	assert.equal(diagnostics.warmupQueuedChunkCount, 10);
	assert.equal(diagnostics.inFlightSendCount, 0);
	assert.equal(diagnostics.taskStarted, false);
	assert.equal(diagnostics.audioSendReady, false);
	assert.equal(diagnostics.lastPumpBlockReason, 'task-not-started');
	const warmupPayloads = harness.provider.warmupQueue.map((chunk) => chunk.data);

	harness.control.emitTaskStarted();
	await starting;
	diagnostics = latestDiagnostics(harness);
	assert.equal(diagnostics.taskStarted, true);
	assert.equal(diagnostics.audioSendReady, true);
	assert.equal(diagnostics.warmupDroppedChunkCount, 10);
	assert.equal(diagnostics.warmupDroppedDurationMs, 1_000);
	assert.equal(diagnostics.warmupQueuedChunkCount, 0);
	assert.equal(diagnostics.inFlightSendCount, 0);
	assert.equal(diagnostics.sentChunkCount, 0);
	assert.equal(harness.control.binaries.length, 0);
	assert.ok(warmupPayloads.every((payload) => payload.every((value) => value === 0)));
	const streaming = harness.phaseDiagnostics.find((entry) => entry.phase === 'streaming');
	assert.equal(streaming?.diagnostics?.taskStarted, true);
	assert.equal(streaming?.diagnostics?.audioSendReady, true);
	pushChunks(harness.provider, 50, 1);
	await harness.scheduler.advanceBy(0);
	await waitFor(() => latestDiagnostics(harness)?.sentChunkCount === 1);
	diagnostics = latestDiagnostics(harness);
	assert.equal(diagnostics.queuedChunkCount, 0);
	assert.equal(diagnostics.warmupQueuedChunkCount, 0);
	assert.equal(diagnostics.inFlightSendCount, 0);
	assert.equal(harness.progress.at(-1).audioBaseOffsetMs, 2_000);
	assert.equal(harness.control.binaries.length, 1);
	assert.equal(harness.control.binaries[0][0], 50);
	assertChunkLedger(diagnostics);
	await harness.provider.stop();
});

test('production sender discards 2.4 seconds of startup audio then sustains sixty seconds of healthy live PCM', async () => {
	const harness = productionSenderHarness({
		taskStartedDelayMs: 2_400,
		latencyForBinary: () => 325,
	});
	const starting = harness.provider.start(new AbortController().signal);
	await waitFor(() => harness.control.textActions.includes('run-task'));
	let sequence = 0;
	({ sequence } = await pushRealtimeChunks(harness, sequence, 24));
	await starting;
	let diagnostics = latestDiagnostics(harness);
	assert.deepEqual(harness.failures, []);
	assert.equal(diagnostics.producedChunkCount, 24);
	assert.equal(diagnostics.warmupDroppedChunkCount, 24);
	assert.equal(diagnostics.warmupDroppedDurationMs, 2_400);
	assert.equal(diagnostics.warmupQueuedChunkCount, 0);
	assert.equal(diagnostics.sentChunkCount, 0);
	assert.equal(harness.control.binaries.length, 0);
	assert.equal(diagnostics.socketEverOpened, true);
	assert.equal(diagnostics.runTaskEverSent, true);
	assert.equal(diagnostics.taskEverStarted, true);
	assertChunkLedger(diagnostics);
	const live = await pushRealtimeChunks(harness, sequence, 600);
	sequence = live.sequence;
	await harness.scheduler.advanceBy(1_000);
	await waitFor(() => latestDiagnostics(harness)?.sentChunkCount === 600);
	diagnostics = latestDiagnostics(harness);
	assert.deepEqual(harness.failures, []);
	assert.equal(diagnostics.producedChunkCount, 624);
	assert.equal(diagnostics.warmupDroppedChunkCount, 24);
	assert.equal(diagnostics.sentChunkCount, 600);
	assert.equal(diagnostics.warmupQueuedChunkCount, 0);
	assert.equal(diagnostics.queuedChunkCount, 0);
	assert.equal(diagnostics.inFlightSendCount, 0);
	assert.equal(diagnostics.overflowReason, null);
	assert.ok(live.maxLiveQueued <= 1);
	assert.equal(diagnostics.firstAudioEverDispatched, true);
	assert.equal(harness.control.binaries.length, 600);
	assert.equal(harness.control.binaries[0][0], 120);
	assert.equal(harness.progress.at(-1).audioBaseOffsetMs, 3_400);
	assert.equal(diagnostics.producedChunkCount, diagnostics.warmupDroppedChunkCount + diagnostics.sentChunkCount);
	assertChunkLedger(diagnostics);
	await harness.provider.stop();
});

test('production sender bounds warm-up until connect timeout without misreporting backpressure', async () => {
	const harness = productionSenderHarness({ openDelayMs: 60_000 });
	const starting = harness.provider.start(new AbortController().signal);
	const rejected = assert.rejects(starting, /connection-failed/);
	let sequence = 0;
	for (let chunk = 0; chunk < 99; chunk += 1) {
		sequence = pushChunks(harness.provider, sequence, 1);
		await harness.scheduler.advanceBy(100);
	}
	let diagnostics = latestDiagnostics(harness);
	assert.equal(diagnostics.warmupQueuedChunkCount, 20);
	assert.equal(diagnostics.warmupDroppedChunkCount, 79);
	assert.equal(diagnostics.socketEverOpened, false);
	sequence = pushChunks(harness.provider, sequence, 1);
	await harness.scheduler.advanceBy(100);
	await rejected;
	diagnostics = latestDiagnostics(harness);
	assert.deepEqual(harness.failures, ['connection-failed']);
	assert.equal(diagnostics.overflowReason, null);
	assert.equal(diagnostics.warmupQueuedChunkCount, 0);
	assert.equal(diagnostics.warmupDroppedChunkCount, 80);
	assert.equal(harness.provider.warmupQueue.length, 0);
});

test('production sender discards five seconds of rolling warm-up then sustains sixty seconds of healthy live PCM', async () => {
	const harness = productionSenderHarness({
		taskStartedDelayMs: 5_000,
		latencyForBinary: () => 325,
	});
	const starting = harness.provider.start(new AbortController().signal);
	await waitFor(() => harness.control.textActions.includes('run-task'));
	let sequence = 0;
	({ sequence } = await pushRealtimeChunks(harness, sequence, 50));
	await starting;
	let diagnostics = latestDiagnostics(harness);
	assert.equal(diagnostics.socketEverOpened, true);
	assert.equal(diagnostics.runTaskEverSent, true);
	assert.equal(diagnostics.taskEverStarted, true);
	assert.equal(diagnostics.warmupQueuedChunkCount, 0);
	assert.equal(diagnostics.warmupDroppedChunkCount, 50);
	assert.equal(diagnostics.warmupDroppedDurationMs, 5_000);
	assert.equal(diagnostics.sentChunkCount, 0);
	assert.equal(harness.control.binaries.length, 0);
	assertChunkLedger(diagnostics);
	const live = await pushRealtimeChunks(harness, sequence, 600);
	await harness.scheduler.advanceBy(1_000);
	await waitFor(() => latestDiagnostics(harness)?.sentChunkCount === 600);
	diagnostics = latestDiagnostics(harness);
	assert.deepEqual(harness.failures, []);
	assert.equal(diagnostics.producedChunkCount, 650);
	assert.equal(diagnostics.warmupDroppedChunkCount, 50);
	assert.equal(diagnostics.sentChunkCount, 600);
	assert.equal(diagnostics.warmupQueuedChunkCount, 0);
	assert.equal(diagnostics.queuedChunkCount, 0);
	assert.equal(diagnostics.inFlightSendCount, 0);
	assert.equal(diagnostics.overflowReason, null);
	assert.ok(live.maxLiveQueued <= 1);
	assert.equal(harness.control.binaries.length, 600);
	assert.equal(harness.control.binaries[0][0], 250);
	assert.equal(harness.progress.at(-1).audioBaseOffsetMs, 6_000);
	assert.equal(diagnostics.producedChunkCount, diagnostics.warmupDroppedChunkCount + diagnostics.sentChunkCount);
	assertChunkLedger(diagnostics);
	await harness.provider.stop();
});

test('production sender lets task-start timeout own a missing task-started failure', async () => {
	const harness = productionSenderHarness({ autoTaskStarted: false });
	const starting = harness.provider.start(new AbortController().signal);
	const rejected = assert.rejects(starting, /task-start-failed/);
	await waitFor(() => harness.control.textActions.includes('run-task'));
	let sequence = 0;
	for (let chunk = 0; chunk < 100; chunk += 1) {
		sequence = pushChunks(harness.provider, sequence, 1);
		await harness.scheduler.advanceBy(100);
	}
	await rejected;
	const diagnostics = latestDiagnostics(harness);
	assert.deepEqual(harness.failures, ['task-start-failed']);
	assert.equal(diagnostics.overflowReason, null);
	assert.equal(diagnostics.socketEverOpened, true);
	assert.equal(diagnostics.runTaskEverSent, true);
	assert.equal(diagnostics.taskEverStarted, false);
	assert.equal(diagnostics.warmupQueuedChunkCount, 0);
});

test('production task-start timeout begins only after run-task write succeeds', async () => {
	const harness = productionSenderHarness({
		autoTaskStarted: false,
		runTaskWriteDelayMs: 4_000,
	});
	const starting = harness.provider.start(new AbortController().signal);
	const rejected = assert.rejects(starting, /task-start-failed/);
	await waitFor(() => harness.control.socket !== null);
	await harness.scheduler.advanceBy(3_999);
	let diagnostics = latestDiagnostics(harness);
	assert.equal(diagnostics.socketEverOpened, true);
	assert.equal(diagnostics.runTaskEverSent, false);
	assert.deepEqual(harness.failures, []);
	await harness.scheduler.advanceBy(1);
	await waitFor(() => harness.control.textActions.includes('run-task'));
	diagnostics = latestDiagnostics(harness);
	assert.equal(diagnostics.runTaskEverSent, true);
	await harness.scheduler.advanceBy(9_999);
	assert.deepEqual(harness.failures, []);
	await harness.scheduler.advanceBy(1);
	await rejected;
	assert.deepEqual(harness.failures, ['task-start-failed']);
});

test('production sender stays bounded at the 400ms callback realtime throughput boundary', async () => {
	const harness = productionSenderHarness({
		latencyForBinary: () => 400,
	});
	await startProductionSender(harness);
	const live = await pushRealtimeChunks(harness, 0, 600);
	await harness.scheduler.advanceBy(1_000);
	await waitFor(() => latestDiagnostics(harness)?.sentChunkCount === 600);
	const diagnostics = latestDiagnostics(harness);
	assert.deepEqual(harness.failures, []);
	assert.equal(diagnostics.producedChunkCount, 600);
	assert.equal(diagnostics.sentChunkCount, 600);
	assert.equal(diagnostics.queuedChunkCount, 0);
	assert.equal(diagnostics.inFlightSendCount, 0);
	assert.equal(diagnostics.overflowReason, null);
	assert.ok(live.maxLiveQueued <= 1);
	assert.equal(harness.control.maxActiveCallbacks, 4);
	assertChunkLedger(diagnostics);
	await harness.provider.stop();
});

test('production sender dispatches the first post-start chunk without waiting for more PCM', async () => {
	const harness = productionSenderHarness({
		autoTaskStarted: false,
		latencyForBinary: () => 0,
	});
	const starting = harness.provider.start(new AbortController().signal);
	await waitFor(() => harness.control.textActions.includes('run-task'));
	harness.control.emitTaskStarted();
	await starting;
	assert.equal(latestDiagnostics(harness).lastPumpBlockReason, 'queue-empty');
	pushChunks(harness.provider, 0, 1);
	await waitFor(() => harness.control.binaries.length === 1);
	assert.equal(harness.control.binaries.length, 1);
	assert.equal(latestDiagnostics(harness).producedChunkCount, 1);
	await harness.scheduler.advanceBy(0);
	await waitFor(() => latestDiagnostics(harness)?.sentChunkCount === 1);
	await harness.provider.stop();
});

test('production sender dispatches a twenty-chunk batch at one chunk per media deadline', async () => {
	const harness = productionSenderHarness({ latencyForBinary: () => 0 });
	await startProductionSender(harness);
	pushChunks(harness.provider, 0, 20);
	let diagnostics = latestDiagnostics(harness);
	assert.equal(diagnostics.producedChunkCount, 20);
	assert.equal(diagnostics.inFlightSendCount, 1);
	assert.equal(diagnostics.queuedChunkCount, 19);
	assert.notDeepEqual(
		[diagnostics.sentChunkCount, diagnostics.queuedChunkCount, diagnostics.inFlightSendCount],
		[0, 20, 0],
	);
	assert.deepEqual(harness.failures, []);
	await advanceInSteps(harness.scheduler, 1_900);
	await waitFor(() => latestDiagnostics(harness)?.sentChunkCount === 20);
	diagnostics = latestDiagnostics(harness);
	assert.equal(diagnostics.queuedChunkCount, 0);
	assert.equal(diagnostics.inFlightSendCount, 0);
	assert.equal(diagnostics.lastPumpBlockReason, 'queue-empty');
	assert.deepEqual(
		harness.control.binaryDispatchTimes,
		Array.from({ length: 20 }, (_, index) => index * 100),
	);
	assert.equal(diagnostics.minDispatchIntervalMs, 100);
	assert.equal(diagnostics.maxDispatchBurstCount, 1);
	await harness.provider.stop();
});

test('batched twenty-millisecond Companion frames cannot bypass the one-chunk media cadence', async () => {
	const harness = productionSenderHarness({ latencyForBinary: () => 0 });
	await startProductionSender(harness);
	for (let sequence = 0; sequence < 50; sequence += 1) {
		harness.provider.acceptFrame(frame(sequence, sequence));
	}
	assert.equal(latestDiagnostics(harness).producedChunkCount, 10);
	assert.equal(harness.control.binaries.length, 1);
	assert.equal(latestDiagnostics(harness).queuedChunkCount, 9);
	await advanceInSteps(harness.scheduler, 900);
	await waitFor(() => latestDiagnostics(harness).sentChunkCount === 10);
	assert.deepEqual(
		harness.control.binaryDispatchTimes,
		Array.from({ length: 10 }, (_, index) => index * 100),
	);
	assert.equal(latestDiagnostics(harness).maxDispatchBurstCount, 1);
	await harness.provider.stop();
});

test('a five-hundred-millisecond late scheduler recovers without a synchronous burst', async () => {
	const harness = productionSenderHarness({ latencyForBinary: () => 0 });
	await startProductionSender(harness);
	pushChunks(harness.provider, 0, 6);
	assert.deepEqual(harness.control.binaryDispatchTimes, [0]);
	await harness.scheduler.advanceBy(500);
	assert.deepEqual(harness.control.binaryDispatchTimes, [0, 500]);
	assert.equal(latestDiagnostics(harness).queuedChunkCount, 4);
	while (latestDiagnostics(harness).sentChunkCount < 6) {
		const nextDueAt = Math.min(
			...([...harness.scheduler.tasks.values()].map((task) => task.dueAt)),
		);
		await harness.scheduler.advanceBy(nextDueAt - harness.scheduler.now());
	}
	const recoveryIntervals = harness.control.binaryDispatchTimes
		.slice(2)
		.map((time, index) => time - harness.control.binaryDispatchTimes[index + 1]);
	assert.ok(recoveryIntervals.every((interval) => interval >= 50 && interval < 100));
	assert.equal(latestDiagnostics(harness).maxDispatchBurstCount, 1);
	assert.ok((latestDiagnostics(harness).minDispatchIntervalMs ?? 0) >= 50);
	assert.equal(latestDiagnostics(harness).controlledRecoveryDispatchCount, 4);
	assert.ok(latestDiagnostics(harness).maxDeadlineLatenessMs >= 400);
	await harness.provider.stop();
});

test('adaptive phase-locked sender survives ten independent minutes, deep write pressure, and event-loop stalls', async () => {
	const scheduler = new JitteredRealtimeScheduler(
		Array.from({ length: 25 }, (_, index) => index + 1),
	);
	const harness = productionSenderHarness({
		scheduler,
		latencyForBinary: (index) => index < 1_200 ? 7_600 : 8,
		flushDelayForBinary: (index) => index < 1_200 ? 7_000 : 20,
		captureBinaryPayloads: false,
	});
	await startProductionSender(harness);
	const chunkCount = 6_000;
	const producerEpochMs = scheduler.now();
	const stalls = [
		{
			earliestStartMs: producerEpochMs + 300_000,
			durationMs: 500,
			startMs: null,
			endMs: null,
			baselineDebtMs: null,
			recoveredAt: null,
		},
		{
			earliestStartMs: producerEpochMs + 450_000,
			durationMs: 2_000,
			startMs: null,
			endMs: null,
			baselineDebtMs: null,
			recoveredAt: null,
		},
	];
	let produced = 0;
	let sequence = 0;
	let maxQueued = 0;
	let maxQueuedAt = 0;
	let maxInFlight = 0;
	const observe = () => {
		const diagnostics = latestDiagnostics(harness);
		assertChunkLedger(diagnostics);
		assertDispatchLedger(diagnostics);
		if (diagnostics.queuedChunkCount > maxQueued) {
			maxQueued = diagnostics.queuedChunkCount;
			maxQueuedAt = scheduler.now();
		}
		maxInFlight = Math.max(maxInFlight, diagnostics.inFlightSendCount);
		for (const stall of stalls) {
			if (stall.endMs !== null && stall.recoveredAt === null
				&& scheduler.now() > stall.endMs
				&& diagnostics.queuedChunkCount <= 2
				&& diagnostics.currentDeadlineLatenessMs
					<= (stall.baselineDebtMs ?? 0) + 100) {
				stall.recoveredAt = scheduler.now();
			}
		}
	};
	const produceOne = () => {
		sequence = pushIdentifiedChunk(harness.provider, sequence, produced);
		produced += 1;
		observe();
	};
	const runStallIfReady = async () => {
		const nextStall = stalls.find((stall) => stall.startMs === null);
		if (!nextStall
			|| scheduler.now() < nextStall.earliestStartMs
			|| latestDiagnostics(harness).queuedChunkCount !== 0) return false;
		nextStall.startMs = scheduler.now();
		nextStall.endMs = nextStall.startMs + nextStall.durationMs;
		nextStall.baselineDebtMs = latestDiagnostics(harness).currentDeadlineLatenessMs;
		await scheduler.stallTo(nextStall.endMs);
		observe();
		while (produced < chunkCount
			&& producerEpochMs + produced * 100 <= nextStall.endMs) {
			produceOne();
		}
		return true;
	};
	while (produced < chunkCount) {
		const producerAt = producerEpochMs + produced * 100;
		const nextTimerAt = scheduler.nextDueAt();
		if (nextTimerAt < producerAt) {
			await scheduler.advanceTo(nextTimerAt);
			observe();
			continue;
		}
		await scheduler.advanceTo(producerAt);
		produceOne();
		await runStallIfReady();
	}
	while (latestDiagnostics(harness).outstandingChunkCount > 0) {
		const nextTimerAt = scheduler.nextDueAt();
		assert.notEqual(nextTimerAt, Number.POSITIVE_INFINITY);
		await scheduler.advanceTo(nextTimerAt);
		observe();
	}
	const diagnostics = latestDiagnostics(harness);
	assert.deepEqual(harness.failures, []);
	assert.equal(diagnostics.producedChunkCount, chunkCount);
	assert.equal(diagnostics.sentChunkCount, chunkCount);
	assert.equal(diagnostics.queuedChunkCount, 0);
	assert.equal(diagnostics.inFlightSendCount, 0);
	assert.equal(diagnostics.overflowReason, null);
	assert.ok(maxQueued < 20, JSON.stringify({ maxQueued, maxQueuedAt, stalls }));
	assert.ok(maxInFlight >= 70 && maxInFlight <= 81);
	for (const stall of stalls) {
		assert.notEqual(stall.startMs, null, JSON.stringify(stalls));
		assert.notEqual(stall.endMs, null, JSON.stringify(stalls));
		assert.notEqual(stall.recoveredAt, null, JSON.stringify(stalls));
		assert.ok(
			stall.recoveredAt - stall.endMs < 20_000,
			JSON.stringify({ stall, maxQueued }),
		);
	}
	assert.deepEqual(
		harness.control.binaryIdentifiers,
		Array.from({ length: chunkCount }, (_, index) => index),
	);
	assert.equal(diagnostics.maxDispatchBurstCount, 1);
	assert.ok((diagnostics.minDispatchIntervalMs ?? 0) >= 50);
	assert.ok(diagnostics.averageDispatchIntervalMs >= 99);
	assert.ok(diagnostics.averageDispatchIntervalMs <= 101);
	assert.ok(diagnostics.controlledRecoveryDispatchCount > 0);
	assert.ok(diagnostics.maxDeadlineLatenessMs >= 1_900);
	assert.ok(diagnostics.schedulerWakeupCount > 0);
	assert.ok(harness.control.maxBufferedAmount >= 200 * 1024);
	assert.ok(harness.control.maxBufferedAmount <= 256 * 1024);
	assert.ok(diagnostics.maxWsBufferedAmount <= 256 * 1024);
	assert.ok(diagnostics.maxObservedInFlightAgeMs >= 7_500);
	assert.ok(diagnostics.maxObservedInFlightAgeMs < 10_000);
	assert.ok(diagnostics.maxOutstandingChunkCount <= 101);
	assertDispatchLedger(diagnostics);
	await harness.provider.stop();
	while (scheduler.tasks.size > 0) await scheduler.advanceTo(scheduler.nextDueAt());
	assert.equal(harness.provider.pumpTimer, null);
	assert.equal(harness.transport.pendingSends.size, 0);
	assert.equal(scheduler.tasks.size, 0);
});

test('production sender preserves a pump rerun requested during an active drain', async () => {
	const harness = productionSenderHarness({ latencyForBinary: () => 0 });
	await startProductionSender(harness);
	let injected = false;
	harness.setProgressHook((progress) => {
		if (injected || !progress.diagnostics.pumpActive
			|| progress.diagnostics.inFlightSendCount !== 1) return;
		injected = true;
		pushChunks(harness.provider, 5, 1);
	});
	pushChunks(harness.provider, 0, 1);
	assert.equal(harness.control.binaries.length, 1);
	assert.equal(injected, true);
	assert.ok(harness.progress.some((entry) => entry.diagnostics.pumpScheduled));
	await harness.scheduler.advanceBy(100);
	await waitFor(() => harness.control.binaries.length === 2);
	await harness.scheduler.advanceBy(0);
	await waitFor(() => latestDiagnostics(harness)?.sentChunkCount === 2);
	const diagnostics = latestDiagnostics(harness);
	assert.equal(diagnostics.pumpActive, false);
	assert.equal(diagnostics.pumpScheduled, false);
	assert.equal(diagnostics.queuedChunkCount, 0);
	assert.equal(diagnostics.inFlightSendCount, 0);
	await harness.provider.stop();
});

test('production sender sustains sixty seconds of healthy realtime PCM without startup backlog', async () => {
	const harness = productionSenderHarness({ latencyForBinary: () => 325 });
	await startProductionSender(harness);
	const live = await pushRealtimeChunks(harness, 0, 600);
	await harness.scheduler.advanceBy(1_000);
	await waitFor(() => latestDiagnostics(harness)?.sentChunkCount === 600);
	const diagnostics = latestDiagnostics(harness);
	assert.deepEqual(harness.failures, []);
	assert.equal(diagnostics.producedChunkCount, 600);
	assert.equal(diagnostics.sentChunkCount, 600);
	assert.equal(diagnostics.outstandingChunkCount, 0);
	assert.ok(live.maxLiveQueued <= 1);
	assert.equal(harness.progress.at(-1).sentFrameCount, 3_000);
	assert.equal(harness.control.maxActiveCallbacks, 4);
	assertChunkLedger(diagnostics);
	await harness.provider.stop();
});

test('production sender settles every eight-millisecond callback for sixty seconds of realtime PCM', async () => {
	const harness = productionSenderHarness({ latencyForBinary: () => 8 });
	await startProductionSender(harness);
	const live = await pushRealtimeChunks(harness, 0, 600);
	await harness.scheduler.advanceBy(100);
	await waitFor(() => latestDiagnostics(harness)?.sentChunkCount === 600);
	const diagnostics = latestDiagnostics(harness);
	assert.deepEqual(harness.failures, []);
	assert.equal(diagnostics.sentChunkCount, 600);
	assert.equal(diagnostics.dispatchChunkCount, 600);
	assert.equal(diagnostics.sendCallbackSuccessCount, 600);
	assert.equal(diagnostics.sendCallbackFailureCount, 0);
	assert.equal(diagnostics.sendCallbackSettledCount, 600);
	assert.equal(diagnostics.oldestInFlightAgeMs, null);
	assert.ok(diagnostics.maxObservedInFlightAgeMs <= 100);
	assert.ok(live.maxLiveQueued <= 1);
	assert.equal(harness.control.binaryDispatchTimes.length, 600);
	assert.ok(
		harness.control.binaryDispatchTimes.at(-1) - harness.control.binaryDispatchTimes[0]
			>= 59_900,
	);
	assert.equal(diagnostics.producedAudioDurationMs, 60_000);
	assert.equal(diagnostics.dispatchedAudioDurationMs, 60_000);
	assert.equal(diagnostics.minDispatchIntervalMs, 100);
	assert.equal(diagnostics.maxDispatchBurstCount, 1);
	assertDispatchLedger(diagnostics);
	await harness.provider.stop();
});

test('production sender sustains sixty seconds with 1000 to 1100ms callbacks under the public buffer limit', async () => {
	const harness = productionSenderHarness({
		latencyForBinary: (index) => index % 2 === 0 ? 1_000 : 1_100,
	});
	await startProductionSender(harness);
	const live = await pushRealtimeChunks(harness, 0, 600);
	await harness.scheduler.advanceBy(2_000);
	await waitFor(() => latestDiagnostics(harness)?.sentChunkCount === 600);
	const diagnostics = latestDiagnostics(harness);
	assert.deepEqual(harness.failures, []);
	assert.equal(diagnostics.sentChunkCount, 600);
	assert.equal(diagnostics.queuedChunkCount, 0);
	assert.equal(diagnostics.inFlightSendCount, 0);
	assert.equal(diagnostics.overflowReason, null);
	assert.ok(live.maxInFlight > 4);
	assert.ok(live.maxOutstanding <= 20);
	assert.ok(live.maxLiveQueued <= 1);
	assert.equal(diagnostics.dispatchChunkCount, 600);
	assert.equal(diagnostics.sendCallbackSettledCount, 600);
	assertDispatchLedger(diagnostics);
	await harness.provider.stop();
});

test('production sender recovers from mixed callback latency without retaining in-flight slots', async () => {
	const delays = [8, 8, 200, 8];
	const harness = productionSenderHarness({
		latencyForBinary: (index) => delays[index % delays.length],
	});
	await startProductionSender(harness);
	await pushRealtimeChunks(harness, 0, 600);
	await harness.scheduler.advanceBy(500);
	await waitFor(() => latestDiagnostics(harness)?.sentChunkCount === 600);
	const diagnostics = latestDiagnostics(harness);
	assert.deepEqual(harness.failures, []);
	assert.equal(diagnostics.inFlightSendCount, 0);
	assert.equal(diagnostics.queuedChunkCount, 0);
	assert.equal(diagnostics.dispatchChunkCount, 600);
	assert.equal(diagnostics.sendCallbackSettledCount, 600);
	assert.equal(diagnostics.sendCallbackFailureCount, 0);
	assert.ok(diagnostics.maxObservedInFlightAgeMs >= 200);
	assertDispatchLedger(diagnostics);
	await harness.provider.stop();
});

test('one five-second callback exposes increasing oldest age while the other slots keep draining', async () => {
	const harness = productionSenderHarness({
		latencyForBinary: (index) => index === 0 ? 5_000 : 8,
	});
	await startProductionSender(harness);
	let sequence = 0;
	({ sequence } = await pushRealtimeChunks(harness, sequence, 20));
	let diagnostics = latestDiagnostics(harness);
	const lifecycle = harness.provider.inFlightLifecycleDiagnostics();
	assert.equal(lifecycle.length, 1);
	assert.equal(lifecycle[0].dispatchOrdinal, 0);
	assert.equal(lifecycle[0].dispatchedAtMs, 0);
	assert.ok(lifecycle[0].currentAgeMs >= 2_000);
	assert.ok(diagnostics.oldestInFlightAgeMs >= 2_000);
	assert.ok(diagnostics.maxObservedInFlightAgeMs >= 2_000);
	assert.equal(diagnostics.sentChunkCount, 19);
	assertDispatchLedger(diagnostics);
	await pushRealtimeChunks(harness, sequence, 29);
	diagnostics = latestDiagnostics(harness);
	assert.deepEqual(harness.failures, []);
	assert.equal(diagnostics.sentChunkCount, 48);
	assert.equal(diagnostics.inFlightSendCount, 1);
	assert.ok(diagnostics.maxObservedInFlightAgeMs >= 4_900);
	assertDispatchLedger(diagnostics);
	harness.provider.dispose();
	diagnostics = latestDiagnostics(harness);
	assert.equal(diagnostics.inFlightSendCount, 0);
	assert.equal(diagnostics.sendCallbackFailureCount, 1);
	assert.equal(diagnostics.sendCallbackSettledCount, 49);
	assertDispatchLedger(diagnostics);
});

test('dispose settles a send whose WebSocket callback never returns and releases in-flight ownership', async () => {
	const harness = productionSenderHarness({
		latencyForBinary: (index) => index === 0 ? null : 8,
	});
	await startProductionSender(harness);
	pushChunks(harness.provider, 0, 1);
	await waitFor(() => latestDiagnostics(harness)?.inFlightSendCount === 1);
	let diagnostics = latestDiagnostics(harness);
	assert.equal(diagnostics.dispatchChunkCount, 1);
	assert.equal(diagnostics.sendCallbackSettledCount, 0);
	assertDispatchLedger(diagnostics);
	harness.provider.dispose();
	diagnostics = latestDiagnostics(harness);
	assert.equal(diagnostics.inFlightSendCount, 0);
	assert.equal(diagnostics.dispatchChunkCount, 1);
	assert.equal(diagnostics.sendCallbackFailureCount, 1);
	assert.equal(diagnostics.sendCallbackSettledCount, 1);
	assertDispatchLedger(diagnostics);
});

test('pending callback limit pauses without overflowing and one settlement resumes FIFO dispatch', async () => {
	const harness = productionSenderHarness({
		latencyForBinary: () => null,
		flushDelayForBinary: () => 10,
	});
	await startProductionSender(harness);
	await pushRealtimeChunks(harness, 0, 81);
	let diagnostics = latestDiagnostics(harness);
	assert.deepEqual(harness.failures, []);
	assert.equal(diagnostics.inFlightSendCount, 81);
	assert.equal(diagnostics.queuedChunkCount, 0);
	assert.equal(harness.control.maxBufferedAmount, 3_208);
	pushChunks(harness.provider, 405, 1);
	diagnostics = latestDiagnostics(harness);
	assert.equal(diagnostics.lastPumpBlockReason, 'pending-callback-limit');
	assert.equal(diagnostics.overflowReason, null);
	assert.equal(diagnostics.queuedChunkCount, 1);
	assert.equal(diagnostics.inFlightSendCount, 81);
	assert.equal(harness.control.binaries.length, 81);
	harness.control.pendingBinaryCallbacks[0]();
	await new Promise((resolve) => setImmediate(resolve));
	diagnostics = latestDiagnostics(harness);
	assert.equal(harness.control.binaries.length, 82);
	assert.equal(diagnostics.queuedChunkCount, 0);
	assert.equal(diagnostics.inFlightSendCount, 81);
	assert.equal(diagnostics.dispatchChunkCount, 82);
	assert.equal(diagnostics.sendCallbackSettledCount, 1);
	assertDispatchLedger(diagnostics);
	harness.provider.dispose();
});

test('a never-returning callback fails at ten seconds and late callbacks remain no-ops', async () => {
	const harness = productionSenderHarness({
		latencyForBinary: () => null,
		flushDelayForBinary: () => 10,
	});
	await startProductionSender(harness);
	const live = await pushRealtimeChunks(harness, 0, 81);
	pushChunks(harness.provider, live.sequence, 10);
	let diagnostics = latestDiagnostics(harness);
	assert.equal(diagnostics.inFlightSendCount, 81);
	assert.equal(diagnostics.queuedChunkCount, 10);
	assert.equal(diagnostics.lastPumpBlockReason, 'pending-callback-limit');
	assert.equal(diagnostics.overflowReason, null);
	await harness.scheduler.advanceBy(1_899);
	assert.deepEqual(harness.failures, []);
	await harness.scheduler.advanceBy(1);
	assert.deepEqual(harness.failures, ['audio-send-timeout']);
	diagnostics = latestDiagnostics(harness);
	assert.equal(diagnostics.inFlightSendCount, 0);
	assert.equal(diagnostics.queuedChunkCount, 0);
	assert.equal(diagnostics.sendCallbackSettledCount, 81);
	assert.equal(diagnostics.sendCallbackFailureCount, 81);
	assert.equal(harness.provider.pumpTimer, null);
	assert.equal(harness.transport.pendingSends.size, 0);
	assertDispatchLedger(diagnostics);
	for (const callback of harness.control.pendingBinaryCallbacks) callback();
	await new Promise((resolve) => setImmediate(resolve));
	const afterLateCallbacks = latestDiagnostics(harness);
	assert.equal(afterLateCallbacks.sendCallbackSettledCount, 81);
	assert.equal(afterLateCallbacks.sendCallbackSuccessCount, 0);
	assert.equal(afterLateCallbacks.inFlightSendCount, 0);
	assertDispatchLedger(afterLateCallbacks);
});

test('the twenty-first undispatched live chunk alone triggers app queue overflow', async () => {
	const harness = productionSenderHarness({ latencyForBinary: () => null });
	await startProductionSender(harness);
	const live = await pushRealtimeChunks(harness, 0, 81);
	pushChunks(harness.provider, live.sequence, 20);
	let diagnostics = latestDiagnostics(harness);
	assert.deepEqual(harness.failures, []);
	assert.equal(diagnostics.inFlightSendCount, 81);
	assert.equal(diagnostics.queuedChunkCount, 20);
	assert.equal(diagnostics.overflowReason, null);
	pushChunks(harness.provider, live.sequence + 100, 1);
	assert.deepEqual(harness.failures, ['audio-buffer-overflow']);
	diagnostics = latestDiagnostics(harness);
	assert.equal(diagnostics.overflowReason, 'app-queue-limit');
	assert.notEqual(diagnostics.overflowReason, 'pending-callback-limit');
	assert.equal(diagnostics.inFlightSendCount, 0);
	assert.equal(diagnostics.queuedChunkCount, 0);
	assertDispatchLedger(diagnostics);
});

test('production sender stays bounded when write callbacks are faster than realtime input', async () => {
	const harness = productionSenderHarness({ latencyForBinary: () => 80 });
	await startProductionSender(harness);
	let sequence = 0;
	for (let chunk = 0; chunk < 100; chunk += 1) {
		sequence = pushChunks(harness.provider, sequence, 1);
		await harness.scheduler.advanceBy(100);
	}
	const diagnostics = latestDiagnostics(harness);
	assert.equal(diagnostics.sentChunkCount, 100);
	assert.equal(diagnostics.outstandingChunkCount, 0);
	assert.ok(diagnostics.maxOutstandingChunkCount <= 1);
	assert.deepEqual(harness.failures, []);
	await harness.provider.stop();
});

test('production sender drains a temporary write-callback jitter without duplicate chunks', async () => {
	const harness = productionSenderHarness({
		latencyForBinary: (index) => index >= 10 && index < 20 ? 350 : 20,
	});
	await startProductionSender(harness);
	let sequence = 0;
	for (let chunk = 0; chunk < 80; chunk += 1) {
		sequence = pushChunks(harness.provider, sequence, 1);
		await harness.scheduler.advanceBy(100);
	}
	await harness.scheduler.advanceBy(1_000);
	const diagnostics = latestDiagnostics(harness);
	assert.deepEqual(harness.failures, []);
	assert.equal(diagnostics.producedChunkCount, 80);
	assert.equal(diagnostics.sentChunkCount, 80);
	assert.equal(diagnostics.outstandingChunkCount, 0);
	assert.ok(diagnostics.maxOutstandingChunkCount > 1);
	assert.ok(harness.control.maxActiveCallbacks <= 4);
	await harness.provider.stop();
});

test('production sender sustains sixty seconds with 1.9 to 2.2 second callback jitter', async () => {
	const callbackDelays = [1_900, 2_000, 2_100, 2_200];
	const harness = productionSenderHarness({
		latencyForBinary: (index) => callbackDelays[index % callbackDelays.length],
		flushDelayForBinary: () => 40,
	});
	await startProductionSender(harness);
	const live = await pushRealtimeChunks(harness, 0, 600);
	await harness.scheduler.advanceBy(3_000);
	await waitFor(() => latestDiagnostics(harness).sentChunkCount === 600);
	const diagnostics = latestDiagnostics(harness);
	assert.deepEqual(harness.failures, []);
	assert.equal(diagnostics.sentChunkCount, 600);
	assert.equal(diagnostics.queuedChunkCount, 0);
	assert.equal(diagnostics.inFlightSendCount, 0);
	assert.equal(diagnostics.overflowReason, null);
	assert.ok(live.maxInFlight > 20);
	assert.ok(live.maxInFlight <= 81);
	assert.ok(live.maxLiveQueued <= 1);
	assert.ok(live.maxOutstanding <= 101);
	assert.ok(harness.control.maxBufferedAmount <= 256 * 1024);
	assert.equal(diagnostics.dispatchChunkCount, 600);
	assert.equal(diagnostics.sendCallbackSettledCount, 600);
	assertDispatchLedger(diagnostics);
	await harness.provider.stop();
});

test('production sender uses one cancellable scheduler for media deadlines and WebSocket buffering', async () => {
	const harness = productionSenderHarness({
		latencyForBinary: () => 200,
		flushDelayForBinary: () => 1_000,
	});
	await startProductionSender(harness);
	harness.control.socket.bufferedAmount = 256 * 1024 - 3_208;
	pushChunks(harness.provider, 0, 1);
	assert.equal(harness.control.binaries.length, 1);
	assert.equal(harness.control.socket.bufferedAmount, 256 * 1024);
	pushChunks(harness.provider, 5, 1);
	const mediaTimer = harness.provider.pumpTimer;
	assert.notEqual(mediaTimer, null);
	assert.equal(harness.scheduler.tasks.has(mediaTimer), true);
	assert.equal(latestDiagnostics(harness).lastPumpBlockReason, 'media-deadline');
	await harness.scheduler.advanceBy(100);
	assert.equal(latestDiagnostics(harness).lastPumpBlockReason, 'ws-buffer-limit');
	assert.equal(latestDiagnostics(harness).queuedChunkCount, 1);
	assert.equal(harness.control.binaries.length, 1);
	const bufferTimer = harness.provider.pumpTimer;
	assert.notEqual(bufferTimer, null);
	harness.provider.requestPump();
	assert.notEqual(harness.provider.pumpTimer, null);
	assert.equal(
		[...harness.scheduler.tasks.values()].filter((task) => task.dueAt === 150).length,
		1,
	);
	harness.control.socket.bufferedAmount = 0;
	await harness.scheduler.advanceBy(50);
	assert.equal(harness.provider.pumpTimer, null);
	assert.equal(harness.control.binaries.length, 2);
	await harness.scheduler.advanceBy(200);
	assert.equal(latestDiagnostics(harness).sentChunkCount, 2);
	assert.equal(latestDiagnostics(harness).overflowReason, null);
	assertDispatchLedger(latestDiagnostics(harness));
	await harness.provider.stop();

	const disposing = productionSenderHarness();
	await startProductionSender(disposing);
	disposing.control.socket.bufferedAmount = 256 * 1024;
	pushChunks(disposing.provider, 0, 1);
	assert.notEqual(disposing.provider.pumpTimer, null);
	disposing.provider.dispose();
	assert.equal(disposing.provider.pumpTimer, null);
	assert.equal(disposing.scheduler.tasks.size, 0);
});

test('out-of-order callbacks settle each ordinal once and base offset waits for ordinal zero', async () => {
	const harness = productionSenderHarness({
		latencyForBinary: (index) => index === 0 ? 300 : 20,
		repeatCallback: true,
	});
	await startProductionSender(harness);
	pushChunks(harness.provider, 0, 4);
	await advanceInSteps(harness.scheduler, 220, 20);
	assert.equal(latestDiagnostics(harness).sentChunkCount, 2);
	assert.equal(latestDiagnostics(harness).sendCallbackSettledCount, 2);
	assert.equal(harness.provider.inFlightLifecycleDiagnostics()[0].dispatchOrdinal, 0);
	assert.equal(harness.progress.at(-1).audioBaseOffsetMs, null);
	assertDispatchLedger(latestDiagnostics(harness));
	await advanceInSteps(harness.scheduler, 100, 20);
	assert.equal(latestDiagnostics(harness).sentChunkCount, 4);
	assert.equal(latestDiagnostics(harness).dispatchChunkCount, 4);
	assert.equal(latestDiagnostics(harness).sendCallbackSuccessCount, 4);
	assert.equal(latestDiagnostics(harness).sendCallbackFailureCount, 0);
	assert.equal(latestDiagnostics(harness).sendCallbackSettledCount, 4);
	assert.equal(harness.progress.at(-1).sentFrameCount, 20);
	assert.equal(harness.progress.at(-1).audioBaseOffsetMs, 1_000);
	assert.equal(harness.control.maxActiveCallbacks, 2);
	assertDispatchLedger(latestDiagnostics(harness));
	await harness.provider.stop();
});

test('low bufferedAmount still respects media deadlines without waiting for callbacks', async () => {
	const harness = productionSenderHarness({ latencyForBinary: () => 20 });
	await startProductionSender(harness);
	pushChunks(harness.provider, 0, 5);
	assert.equal(harness.control.binaries.length, 1);
	assert.equal(harness.control.maxActiveCallbacks, 1);
	assert.equal(latestDiagnostics(harness).inFlightSendCount, 1);
	assert.equal(latestDiagnostics(harness).sentChunkCount, 0);
	await advanceInSteps(harness.scheduler, 420, 20);
	assert.equal(harness.control.binaries.length, 5);
	assert.equal(latestDiagnostics(harness).sentChunkCount, 5);
	await harness.provider.stop();
});

test('normal stop drains queued and in-flight writes before finish-task', async () => {
	const harness = productionSenderHarness({ latencyForBinary: () => 2_200 });
	await startProductionSender(harness);
	pushChunks(harness.provider, 0, 6);
	assert.equal(harness.control.binaries.length, 1);
	const stop = harness.provider.stop();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(harness.control.textActions, ['run-task']);
	await advanceInSteps(harness.scheduler, 500);
	assert.equal(harness.control.binaries.length, 6);
	assert.equal(latestDiagnostics(harness).inFlightSendCount, 6);
	await harness.scheduler.advanceBy(2_200);
	await stop;
	assert.deepEqual(harness.control.textActions, ['run-task', 'finish-task']);
	assert.equal(latestDiagnostics(harness).sentChunkCount, 6);
	assertDispatchLedger(latestDiagnostics(harness));
	assert.equal(harness.provider.pumpTimer, null);
});

test('stop relies on the send timeout and never sends finish-task for a hung callback', async () => {
	const harness = productionSenderHarness({ latencyForBinary: () => null });
	await startProductionSender(harness);
	pushChunks(harness.provider, 0, 1);
	const stop = harness.provider.stop();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(harness.control.textActions, ['run-task']);
	await harness.scheduler.advanceBy(9_999);
	assert.deepEqual(harness.failures, []);
	await harness.scheduler.advanceBy(1);
	await stop;
	assert.deepEqual(harness.failures, ['audio-send-timeout']);
	assert.deepEqual(harness.control.textActions, ['run-task']);
	const diagnostics = latestDiagnostics(harness);
	assert.equal(diagnostics.inFlightSendCount, 0);
	assert.equal(diagnostics.queuedChunkCount, 0);
	assert.equal(harness.provider.pumpTimer, null);
	assert.equal(harness.scheduler.tasks.size, 0);
	assertDispatchLedger(diagnostics);
});

test('graceful stop resets the stopping gate and reports finished as the final pump state', async () => {
	const harness = productionSenderHarness();
	await startProductionSender(harness);
	pushChunks(harness.provider, 0, 3);
	await advanceInSteps(harness.scheduler, 500, 20);
	assert.equal(latestDiagnostics(harness).sentChunkCount, 3);
	await harness.provider.stop();
	assert.deepEqual(harness.control.textActions, ['run-task', 'finish-task']);
	const diagnostics = latestDiagnostics(harness);
	assert.equal(diagnostics.stopping, false);
	assert.equal(diagnostics.socketOpen, false);
	assert.equal(diagnostics.taskStarted, false);
	assert.equal(diagnostics.audioSendReady, false);
	assert.equal(diagnostics.pumpScheduled, false);
	assert.equal(diagnostics.lastPumpBlockReason, 'finished');
});

test('stopping stays true while teardown drains and flips false only after completion', async () => {
	const harness = productionSenderHarness({ latencyForBinary: () => 2_200 });
	await startProductionSender(harness);
	pushChunks(harness.provider, 0, 4);
	assert.equal(harness.control.binaries.length, 1);
	const stop = harness.provider.stop();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(latestDiagnostics(harness).stopping, true);
	await advanceInSteps(harness.scheduler, 500, 20);
	assert.equal(latestDiagnostics(harness).stopping, true);
	assert.deepEqual(harness.control.textActions, ['run-task']);
	await harness.scheduler.advanceBy(2_200);
	await stop;
	assert.deepEqual(harness.control.textActions, ['run-task', 'finish-task']);
	assert.equal(latestDiagnostics(harness).stopping, false);
});

test('finish timeout teardown also resets the stopping gate', async () => {
	const scheduler = new VirtualRealtimeScheduler();
	const harness = providerHarness(scheduler, new FakeTransport());
	const start = harness.provider.start(new AbortController().signal);
	await waitFor(() => harness.transport.texts.length === 1);
	harness.transport.emit(serverEvent('task-started'));
	await start;
	const stop = harness.provider.stop();
	await waitFor(() => harness.transport.texts.length === 2);
	await scheduler.advanceBy(7_999);
	assert.deepEqual(harness.failures, []);
	await scheduler.advanceBy(1);
	await stop;
	assert.deepEqual(harness.failures, ['finish-timeout']);
	const diagnostics = latestDiagnostics(harness);
	assert.equal(diagnostics.stopping, false);
	assert.equal(diagnostics.socketOpen, false);
	assert.equal(diagnostics.taskStarted, false);
	assert.equal(diagnostics.audioSendReady, false);
});

test('dispose during a draining stop still resets the stopping gate', async () => {
	const scheduler = new VirtualRealtimeScheduler();
	class HangingBinaryTransport extends FakeTransport {
		sendBinary() { return new Promise(() => {}); }
	}
	const harness = providerHarness(scheduler, new HangingBinaryTransport());
	const start = harness.provider.start(new AbortController().signal);
	await waitFor(() => harness.transport.texts.length === 1);
	harness.transport.emit(serverEvent('task-started'));
	await start;
	for (let index = 0; index < 5; index += 1) harness.provider.acceptFrame(frame(index));
	await waitFor(() => latestDiagnostics(harness).inFlightSendCount === 1);
	assert.equal(latestDiagnostics(harness).stopping, false);
	const stop = harness.provider.stop();
	await waitFor(() => latestDiagnostics(harness).stopping === true);
	harness.provider.dispose();
	await stop;
	assert.deepEqual(harness.failures, []);
	const diagnostics = latestDiagnostics(harness);
	assert.equal(diagnostics.stopping, false);
	assert.equal(diagnostics.queuedChunkCount, 0);
	assert.equal(diagnostics.inFlightSendCount, 0);
	assert.ok(harness.transport.disposeCalls >= 1);
});

class FakeProvider {
	callbacks;
	frames = [];
	startCalls = 0;
	stopCalls = 0;
	disposeCalls = 0;
	constructor(callbacks, getApiKey = () => 'safe-test-key') {
		this.callbacks = callbacks;
		this.getApiKey = getApiKey;
	}
	async start() {
		this.startCalls += 1;
		if (!this.getApiKey().trim()) throw new RealtimeAsrError('configuration-error');
		this.callbacks.onPhase('streaming');
	}
	acceptFrame(value) { this.frames.push(value); }
	async stop() { this.stopCalls += 1; }
	dispose() { this.disposeCalls += 1; }
}

function controllerHarness(
	configuration = {},
	audioSession = { sessionId: 'class-1', startedAtUnixMs: 123 },
) {
	const { apiKey = 'safe-test-key', ...nonSecretConfiguration } = configuration;
	let audioState = { status: 'capturing' };
	const stateListeners = new Set();
	const frameListeners = new Set();
	const providers = [];
	const audio = {
		get state() { return audioState; },
		get sessionContext() { return audioSession; },
		subscribe(listener) {
			stateListeners.add(listener); listener(audioState);
			return () => stateListeners.delete(listener);
		},
		subscribeValidatedFrames(listener) {
			frameListeners.add(listener); return () => frameListeners.delete(listener);
		},
	};
	const controller = new RealtimeAsrSessionController({
		isSupportedRuntime: () => true,
		getConfiguration: () => ({
			workspaceId: 'workspace', region: 'cn-beijing', model: 'model',
			...nonSecretConfiguration,
		}),
		getApiKey: () => apiKey,
		getClassroomSessionContext: () => ({ sessionId: 'class-1', startedAtUnixMs: 123 }),
		audio,
		providerFactory: ({ callbacks, getApiKey }) => {
			const provider = new FakeProvider(callbacks, getApiKey); providers.push(provider); return provider;
		},
	});
	return {
		controller, providers, frameListeners,
		emitFrame(value) { for (const listener of [...frameListeners]) listener(value); },
		emitAudio(status) {
			audioState = { status };
			for (const listener of [...stateListeners]) listener(audioState);
		},
	};
}

class AutoProtocolTransport extends FakeTransport {
	constructor(finishFailure = false) {
		super();
		this.finishFailure = finishFailure;
	}
	async sendText(message) {
		this.texts.push(message);
		const parsed = JSON.parse(message);
		const taskId = parsed.header.task_id;
		if (parsed.header.action === 'run-task') {
			queueMicrotask(() => this.emit(serverEvent('task-started', taskId)));
		}
		if (parsed.header.action === 'finish-task') {
			if (this.finishFailure) throw new Error('local finish detail');
			queueMicrotask(() => this.emit(serverEvent('task-finished', taskId)));
		}
	}
}

function productionControllerHarness(createTransport) {
	let audioState = { status: 'capturing' };
	const stateListeners = new Set();
	const frameListeners = new Set();
	const transports = [];
	let taskId = 0;
	let key = 'first-controller-key';
	let keyReads = 0;
	const audio = {
		get state() { return audioState; },
		get sessionContext() { return { sessionId: 'class-1', startedAtUnixMs: 123 }; },
		subscribe(listener) {
			stateListeners.add(listener); listener(audioState);
			return () => stateListeners.delete(listener);
		},
		subscribeValidatedFrames(listener) {
			frameListeners.add(listener); return () => frameListeners.delete(listener);
		},
	};
	const controller = new RealtimeAsrSessionController({
		isSupportedRuntime: () => true,
		getConfiguration: () => ({
			workspaceId: 'workspace', region: 'cn-beijing', model: 'model',
		}),
		getApiKey: () => { keyReads += 1; return key; },
		getClassroomSessionContext: () => ({ sessionId: 'class-1', startedAtUnixMs: 123 }),
		audio,
		providerFactory: ({ configuration, getApiKey, callbacks }) => {
			const transport = createTransport();
			transports.push(transport);
			return new BailianStreamingAsrProvider({
				configuration,
				getApiKey,
				transportFactory: () => transport,
				taskIdFactory: () => `production-task-${++taskId}`,
				callbacks,
				scheduler: {
					now: () => Date.now(),
					setTimeout: () => Symbol('timeout'),
					clearTimeout: () => {},
				},
			});
		},
	});
	return {
		controller, transports,
		emitFrame(value) { for (const listener of [...frameListeners]) listener(value); },
		setKey(value) { key = value; },
		get keyReads() { return keyReads; },
		setAudioStatus(status) {
			audioState = { status };
			for (const listener of [...stateListeners]) listener(audioState);
		},
	};
}

test('controller reports a missing runtime API key as configuration-error', async () => {
	const harness = controllerHarness({ apiKey: '' });
	assert.equal(await harness.controller.start(), 'configuration-error');
	assert.equal(harness.providers.length, 1);
	assert.equal(harness.controller.state.status, 'configuration-error');
});

test('controller rejects PCM from an Audio Companion run with another classroom identity', async () => {
	const harness = controllerHarness({}, { sessionId: 'old-class', startedAtUnixMs: 1 });
	assert.equal(await harness.controller.start(), 'error');
	assert.equal(harness.providers.length, 0);
	assert.equal(harness.controller.state.errorCode, 'connection-failed');
});

test('controller subscribes frames only during a run and supports stop then restart', async () => {
	const harness = controllerHarness();
	assert.equal(await harness.controller.start(), 'streaming');
	assert.equal(harness.frameListeners.size, 1);
	harness.emitFrame(frame(0));
	assert.equal(harness.providers[0].frames.length, 1);
	await harness.controller.stop();
	assert.equal(harness.frameListeners.size, 0);
	harness.emitFrame(frame(1));
	assert.equal(harness.providers[0].frames.length, 1);
	assert.equal(await harness.controller.start(), 'streaming');
	assert.equal(harness.providers.length, 2);
	harness.controller.dispose();
});

test('production provider finish failure leaves the controller in error after cleanup', async () => {
	const harness = productionControllerHarness(() => new AutoProtocolTransport(true));
	assert.equal(await harness.controller.start(), 'streaming');
	await harness.controller.stop();
	assert.equal(harness.controller.state.status, 'error');
	assert.equal(harness.controller.state.errorCode, 'connection-failed');
	assert.equal(harness.transports[0].disposeCalls, 1);
	harness.controller.dispose();
});

test('controller restart gets the current key and derives audioBaseOffset from the new first sent chunk', async () => {
	const harness = productionControllerHarness(() => new AutoProtocolTransport());
	assert.equal(harness.keyReads, 0);
	assert.equal(await harness.controller.start(), 'streaming');
	for (let index = 0; index < 5; index += 1) harness.emitFrame(frame(index));
	await waitFor(() => harness.controller.state.sentFrameCount === 5);
	assert.equal(harness.controller.state.audioBaseOffsetMs, 1_000);
	assert.equal(harness.transports[0].connectOptions.authorization, 'Bearer first-controller-key');
	await harness.controller.stop();

	harness.setKey('second-controller-key');
	assert.equal(await harness.controller.start(), 'streaming');
	for (let index = 0; index < 5; index += 1) {
		harness.emitFrame(frame(index, index, { offsetMs: 9_000 + index * 20 }));
	}
	await waitFor(() => harness.controller.state.sentFrameCount === 5);
	assert.equal(harness.controller.state.audioBaseOffsetMs, 9_000);
	assert.equal(harness.transports[1].connectOptions.authorization, 'Bearer second-controller-key');
	assert.equal(harness.keyReads, 2);
	await harness.controller.stop();
	harness.controller.dispose();
});

test('controller reports stopped with the stopping gate reset after a graceful provider stop', async () => {
	const harness = productionControllerHarness(() => new AutoProtocolTransport());
	assert.equal(await harness.controller.start(), 'streaming');
	for (let index = 0; index < 5; index += 1) harness.emitFrame(frame(index));
	await waitFor(() => harness.controller.state.sentFrameCount === 5);
	await harness.controller.stop();
	assert.equal(harness.controller.state.status, 'stopped');
	assert.equal(harness.controller.state.diagnostics.stopping, false);
	assert.equal(harness.controller.state.diagnostics.lastPumpBlockReason, 'finished');
	harness.controller.dispose();
});

test('controller keeps partial/final in memory, deduplicates, stores words, and bounds finals to 100', async () => {
	const harness = controllerHarness();
	await harness.controller.start();
	const callbacks = harness.providers[0].callbacks;
	callbacks.onSegment({ sentenceId: 1, text: 'partial', beginTimeMs: 0, endTimeMs: null, isFinal: false });
	assert.equal(harness.controller.state.partialText, 'partial');
	for (let sentenceId = 1; sentenceId <= 105; sentenceId += 1) {
		callbacks.onSegment({
			sentenceId, text: `final-${sentenceId}`, beginTimeMs: sentenceId,
			endTimeMs: sentenceId + 1, isFinal: true,
			words: [{ text: 'word', punctuation: '', beginTimeMs: sentenceId, endTimeMs: sentenceId + 1 }],
		});
	}
	callbacks.onSegment({ sentenceId: 105, text: 'duplicate', beginTimeMs: 0, endTimeMs: 1, isFinal: true });
	const state = harness.controller.state;
	assert.equal(state.partialText, '');
	assert.equal(state.recentFinalSegments.length, 100);
	assert.equal(state.recentFinalSegments[0].sentenceId, 6);
	assert.equal(state.recentFinalSegments.at(-1).words[0].text, 'word');
	assert.equal(state.lastFinalText, 'final-105');
	callbacks.onSegment({
		sentenceId: 106, text: 'bounded words', beginTimeMs: 0, endTimeMs: 1, isFinal: true,
		words: Array.from({ length: 1_000 }, () => ({
			text: 'x'.repeat(101), punctuation: '', beginTimeMs: 0, endTimeMs: 1,
		})),
	});
	assert.equal(harness.controller.state.recentFinalSegments.at(-1).words, undefined);
	harness.controller.dispose();
});

test('controller manages partial text by sentence identity across final and late events', async () => {
	const final = (sentenceId, text = `final-${sentenceId}`) => ({
		sentenceId, text, beginTimeMs: sentenceId, endTimeMs: sentenceId + 1, isFinal: true,
	});
	const partial = (sentenceId, text = `partial-${sentenceId}`) => ({
		sentenceId, text, beginTimeMs: sentenceId, endTimeMs: null, isFinal: false,
	});

	const ordered = controllerHarness();
	await ordered.controller.start();
	const orderedCallbacks = ordered.providers[0].callbacks;
	orderedCallbacks.onSegment(partial(1));
	orderedCallbacks.onSegment(final(1));
	assert.equal(ordered.controller.state.partialText, '');
	orderedCallbacks.onSegment(partial(1, 'late-after-final'));
	assert.equal(ordered.controller.state.partialText, '');
	orderedCallbacks.onSegment(final(1, 'duplicate'));
	assert.equal(ordered.controller.state.recentFinalSegments.length, 1);
	assert.equal(ordered.controller.state.lastFinalText, 'final-1');
	ordered.controller.dispose();

	const interleaved = controllerHarness();
	await interleaved.controller.start();
	const callbacks = interleaved.providers[0].callbacks;
	callbacks.onSegment(partial(1, 'A'));
	callbacks.onSegment(partial(2, 'B'));
	callbacks.onSegment(final(1));
	assert.equal(interleaved.controller.state.partialText, 'B');
	callbacks.onSegment(partial(1, 'late-A'));
	assert.equal(interleaved.controller.state.partialText, 'B');
	callbacks.onSegment(final(3));
	assert.equal(interleaved.controller.state.partialText, 'B');
	callbacks.onSegment(final(2));
	assert.equal(interleaved.controller.state.partialText, '');
	assert.deepEqual(
		interleaved.controller.state.recentFinalSegments.map((segment) => segment.sentenceId),
		[1, 3, 2],
	);
	interleaved.controller.dispose();
});

test('controller contains synchronous provider factory failures and remains restartable', async () => {
	let factoryCalls = 0;
	const audio = {
		state: { status: 'capturing' },
		sessionContext: { sessionId: 'class-1', startedAtUnixMs: 123 },
		subscribe() { return () => {}; },
		subscribeValidatedFrames() { return () => {}; },
	};
	const controller = new RealtimeAsrSessionController({
		isSupportedRuntime: () => true,
		getConfiguration: () => ({
			workspaceId: 'workspace', region: 'cn-beijing', model: 'model',
		}),
		getApiKey: () => 'safe-test-key',
		getClassroomSessionContext: () => ({ sessionId: 'class-1', startedAtUnixMs: 123 }),
		audio,
		providerFactory: () => { factoryCalls += 1; throw new Error('local constructor details'); },
	});
	assert.equal(await controller.start(), 'error');
	assert.equal(controller.state.errorCode, 'connection-failed');
	assert.equal(await controller.start(), 'error');
	assert.equal(factoryCalls, 2);
	controller.dispose();
});

test('audio failure stops ASR while ASR failure does not stop audio', async () => {
	const harness = controllerHarness();
	await harness.controller.start();
	harness.providers[0].callbacks.onFailure('task-failed');
	assert.equal(harness.controller.state.status, 'error');
	assert.equal(harness.providers[0].disposeCalls, 1);
	assert.equal(harness.frameListeners.size, 0);
	assert.equal(await harness.controller.start(), 'streaming');
	harness.emitAudio('error');
	await waitFor(() => harness.controller.state.status === 'stopped');
});

test('graceful stop retains residual finals and preserves a finish timeout as an error', async () => {
	const residual = controllerHarness();
	await residual.controller.start();
	residual.providers[0].stop = async () => {
		residual.providers[0].callbacks.onSegment({
			sentenceId: 1, text: 'tail final', beginTimeMs: 0, endTimeMs: 20, isFinal: true,
		});
	};
	await residual.controller.stop();
	assert.equal(residual.controller.state.status, 'stopped');
	assert.equal(residual.controller.state.lastFinalText, 'tail final');

	const timedOut = controllerHarness();
	await timedOut.controller.start();
	timedOut.providers[0].stop = async () => {
		timedOut.providers[0].callbacks.onFailure('finish-timeout');
	};
	await timedOut.controller.stop();
	assert.equal(timedOut.controller.state.status, 'error');
	assert.equal(timedOut.controller.state.errorCode, 'finish-timeout');
});

test('controller retains final gate diagnostics after error and stop, then resets them on restart', async () => {
	const errorRun = controllerHarness();
	await errorRun.controller.start();
	const finalDiagnostics = {
		...asrState('streaming').diagnostics,
		producedChunkCount: 20,
		queuedChunkCount: 20,
		socketOpen: true,
		taskStarted: true,
		audioSendReady: false,
		socketEverOpened: true,
		runTaskEverSent: true,
		taskEverStarted: true,
		firstAudioEverDispatched: false,
		warmupQueuedChunkCount: 0,
		warmupDroppedChunkCount: 4,
		warmupDroppedDurationMs: 400,
		lastPumpBlockReason: 'audio-not-ready',
	};
	errorRun.providers[0].callbacks.onProgress({
		sentFrameCount: 0,
		sentAudioDurationMs: 0,
		audioBaseOffsetMs: null,
		diagnostics: finalDiagnostics,
	});
	errorRun.providers[0].callbacks.onFailure('audio-buffer-overflow');
	assert.equal(errorRun.controller.state.status, 'error');
	assert.deepEqual(
		{
			...errorRun.controller.state.diagnostics,
			sessionNotificationCount: 0,
			sessionNotificationRate: 0,
		},
		finalDiagnostics,
	);
	assert.equal(await errorRun.controller.start(), 'streaming');
	assert.deepEqual(
		{
			...errorRun.controller.state.diagnostics,
			sessionNotificationCount: 0,
			sessionNotificationRate: 0,
		},
		asrState('idle').diagnostics,
	);
	errorRun.controller.dispose();

	const stoppedRun = controllerHarness();
	await stoppedRun.controller.start();
	stoppedRun.providers[0].callbacks.onProgress({
		sentFrameCount: 5,
		sentAudioDurationMs: 100,
		audioBaseOffsetMs: 1_000,
		diagnostics: finalDiagnostics,
	});
	await stoppedRun.controller.stop();
	assert.equal(stoppedRun.controller.state.status, 'stopped');
	assert.deepEqual(
		{
			...stoppedRun.controller.state.diagnostics,
			sessionNotificationCount: 0,
			sessionNotificationRate: 0,
		},
		finalDiagnostics,
	);
	stoppedRun.controller.dispose();
});

test('concurrent start is busy and dispose removes current frame subscription', async () => {
	const harness = controllerHarness();
	await harness.controller.start();
	assert.equal(await harness.controller.start(), 'busy');
	harness.controller.dispose();
	assert.equal(harness.frameListeners.size, 0);
});

test('stop during task startup aborts the pending run and removes every subscription', async () => {
	let audioState = { status: 'capturing' };
	const stateListeners = new Set();
	const frameListeners = new Set();
	let stopCalls = 0;
	const controller = new RealtimeAsrSessionController({
		isSupportedRuntime: () => true,
		getConfiguration: () => ({
			workspaceId: 'workspace', region: 'cn-beijing', model: 'model',
		}),
		getApiKey: () => 'safe-test-key',
		getClassroomSessionContext: () => ({ sessionId: 'class-1', startedAtUnixMs: 123 }),
		audio: {
			get state() { return audioState; },
			get sessionContext() { return { sessionId: 'class-1', startedAtUnixMs: 123 }; },
			subscribe(listener) {
				stateListeners.add(listener); listener(audioState);
				return () => stateListeners.delete(listener);
			},
			subscribeValidatedFrames(listener) {
				frameListeners.add(listener); return () => frameListeners.delete(listener);
			},
		},
		providerFactory: ({ callbacks }) => ({
			start(signal) {
				callbacks.onPhase('starting-task');
				return new Promise((resolve, reject) => {
					signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
				});
			},
			acceptFrame() {},
			async stop() { stopCalls += 1; },
			dispose() {},
		}),
	});
	const start = controller.start();
	await waitFor(() => controller.state.status === 'starting-task');
	await controller.stop();
	assert.equal(await start, 'error');
	assert.equal(stopCalls, 1);
	assert.equal(frameListeners.size, 0);
	assert.equal(stateListeners.size, 0);
	assert.equal(controller.state.status, 'stopped');
	controller.dispose();
});

test('stale provider callbacks cannot mutate a restarted ASR run', async () => {
	const harness = controllerHarness();
	await harness.controller.start();
	const staleCallbacks = harness.providers[0].callbacks;
	staleCallbacks.onFailure('remote-closed');
	assert.equal(await harness.controller.start(), 'streaming');
	staleCallbacks.onSegment({
		sentenceId: 99, text: 'stale', beginTimeMs: 0, endTimeMs: 20, isFinal: true,
	});
	staleCallbacks.onProgress({
		sentFrameCount: 999, sentAudioDurationMs: 999_000, audioBaseOffsetMs: 0,
	});
	assert.equal(harness.controller.state.lastFinalText, '');
	assert.equal(harness.controller.state.sentFrameCount, 0);
	harness.controller.dispose();
});

test('Workbench binding restores the latest ASR snapshot without starting a session', () => {
	let state = asrState('streaming', {
		partialText: 'live',
		sentAudioDurationMs: 500,
			diagnostics: {
				...asrState('idle').diagnostics,
				socketOpen: true,
				taskStarted: true,
				audioSendReady: true,
				socketEverOpened: true,
				runTaskEverSent: true,
				taskEverStarted: true,
				firstAudioEverDispatched: true,
				lastPumpBlockReason: 'queue-empty',
		},
	});
	const listeners = new Set();
	const applied = [];
	const timers = new Map();
	let nextTimer = 1;
	const binding = new RealtimeAsrWorkbenchBinding({
		readState: () => state,
		subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
		apply(value) { applied.push(value); },
		schedule(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
		cancel(id) { timers.delete(id); },
	});
	binding.open();
	assert.equal(applied[0].partialText, 'live');
	assert.equal(applied[0].diagnostics.audioSendReady, true);
	state = asrState('error', {
		partialText: 'new',
		diagnostics: {
			...state.diagnostics,
			lastPumpBlockReason: 'audio-not-ready',
		},
	});
	for (const listener of [...listeners]) listener(state);
	assert.equal(timers.size, 0);
	assert.equal(applied.at(-1).status, 'error');
	binding.close();
	assert.equal(listeners.size, 0);
	assert.equal(timers.size, 0);
	binding.open();
	assert.equal(applied.at(-1).partialText, 'new');
	assert.equal(applied.at(-1).diagnostics.lastPumpBlockReason, 'audio-not-ready');
});

test('Workbench coalesces ten minutes of 20ms runtime notifications to four ordinary renders per second', () => {
	let now = 1;
	let state = asrState('streaming', {
		classroomSessionId: 'class-1', startedAt: 123,
	});
	const listeners = new Set();
	const timers = new Map();
	let nextTimer = 1;
	const applied = [];
	const binding = new RealtimeAsrWorkbenchBinding({
		readState: () => state,
		subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
		apply(value) { applied.push(value); },
		now: () => now,
		schedule(callback, delayMs) {
			const id = nextTimer++;
			timers.set(id, { callback, dueAt: now + delayMs });
			return id;
		},
		cancel(id) { timers.delete(id); },
	});
	binding.open();
	for (let elapsed = 20; elapsed <= 600_000; elapsed += 20) {
		now = 1 + elapsed;
		state = asrState('streaming', {
			classroomSessionId: 'class-1', startedAt: 123,
			sentFrameCount: elapsed / 20,
			diagnostics: {
				...state.diagnostics,
				dispatchChunkCount: Math.floor(elapsed / 100),
				sendCallbackSettledCount: Math.floor(elapsed / 100),
			},
		});
		for (const listener of [...listeners]) listener(state);
		for (const [id, timer] of [...timers]) {
			if (timer.dueAt > now || !timers.delete(id)) continue;
			timer.callback();
		}
	}
	assert.ok(applied.length <= 2_402, `rendered ${applied.length} times`);
	assert.ok(state.sentFrameCount - applied.at(-1).sentFrameCount <= 13);
	assert.ok(6_000 - applied.at(-1).diagnostics.dispatchChunkCount <= 3);
	assert.ok(applied.at(-1).diagnostics.workbenchRenderRate <= 4.01);
	state = asrState('error', {
		classroomSessionId: 'class-1', startedAt: 123,
		sentFrameCount: 30_000,
		errorCode: 'audio-buffer-overflow',
		diagnostics: state.diagnostics,
	});
	for (const listener of [...listeners]) listener(state);
	assert.equal(applied.at(-1).status, 'error');
	assert.equal(applied.at(-1).sentFrameCount, 30_000);
	assert.equal(applied.at(-1).diagnostics.dispatchChunkCount, 6_000);
	assert.equal(timers.size, 0);
	binding.close();
	assert.equal(timers.size, 0);
	assert.equal(listeners.size, 0);
});

test('Workbench subscription does not change production dispatch, callback, or FIFO metrics', async () => {
	const run = async (withWorkbench) => {
		const harness = productionSenderHarness({ latencyForBinary: () => 0 });
		let runtimeState = asrState('streaming', {
			classroomSessionId: 'class-1', startedAt: 123,
		});
		const listeners = new Set();
		let binding = null;
		if (withWorkbench) {
			binding = new RealtimeAsrWorkbenchBinding({
				readState: () => runtimeState,
				subscribe(listener) {
					listeners.add(listener);
					listener(runtimeState);
					return () => listeners.delete(listener);
				},
				apply() {},
				now: () => harness.scheduler.now(),
				schedule: (callback, delayMs) => harness.scheduler.setTimeout(callback, delayMs),
				cancel: (timerId) => harness.scheduler.clearTimeout(timerId),
			});
			binding.open();
			harness.setProgressHook((progress) => {
				runtimeState = asrState('streaming', {
					classroomSessionId: 'class-1', startedAt: 123,
					sentFrameCount: progress.sentFrameCount,
					sentAudioDurationMs: progress.sentAudioDurationMs,
					audioBaseOffsetMs: progress.audioBaseOffsetMs,
					diagnostics: progress.diagnostics,
				});
				for (const listener of [...listeners]) listener(runtimeState);
			});
		}
		await startProductionSender(harness);
		await pushRealtimeChunks(harness, 0, 600);
		while (latestDiagnostics(harness).outstandingChunkCount > 0) {
			await harness.scheduler.advanceBy(100);
		}
		const diagnostics = latestDiagnostics(harness);
		const identifiers = [...harness.control.binaryIdentifiers];
		binding?.close();
		await harness.provider.stop();
		return {
			dispatchChunkCount: diagnostics.dispatchChunkCount,
			sendCallbackSettledCount: diagnostics.sendCallbackSettledCount,
			sentChunkCount: diagnostics.sentChunkCount,
			identifiers,
		};
	};
	assert.deepEqual(await run(true), await run(false));
});

test('Workbench UI enables controls only for compatible audio/ASR states', () => {
	assert.equal(realtimeAsrRuntimeUiState(asrState('idle'), true).canStart, true);
	assert.equal(realtimeAsrRuntimeUiState(asrState('streaming'), true).canStop, true);
	assert.equal(realtimeAsrRuntimeUiState(asrState('idle'), false).canStart, false);
	assert.match(realtimeAsrRuntimeUiState(asrState('error', { errorCode: 'auth-failed' }), true).errorMessage, /身份验证/);
	assert.equal(
		realtimeAsrRuntimeUiState(asrState('error', { errorCode: 'task-start-failed' }), true).errorMessage,
		'实时识别任务启动超时。',
	);
	assert.equal(
		realtimeAsrRuntimeUiState(asrState('error', { errorCode: 'audio-send-timeout' }), true).errorMessage,
		'音频发送回调超时，实时转写已安全停止。',
	);
	const baseDiagnostics = asrState('idle').diagnostics;
	assert.equal(
		realtimeAsrRuntimeUiState(asrState('error', {
			errorCode: 'audio-buffer-overflow',
			diagnostics: { ...baseDiagnostics, overflowReason: 'app-queue-limit' },
		}), true).errorMessage,
		'应用实时音频队列达到安全上限，实时转写已安全停止。',
	);
	assert.equal(
		realtimeAsrRuntimeUiState(asrState('error', {
			errorCode: 'audio-buffer-overflow',
			diagnostics: { ...baseDiagnostics, overflowReason: 'ws-buffer-limit' },
		}), true).errorMessage,
		'WebSocket 发送缓冲达到安全上限，实时转写已安全停止。',
	);
	assert.equal(
		realtimeAsrRuntimeUiState(
			asrState('error', { errorCode: 'unexpected-websocket-compression' }),
			true,
		).errorMessage,
		'WebSocket 意外协商了压缩，实时转写已安全停止。',
	);
});

test('Workbench gate diagnostics use fixed boolean and exhaustive safe Chinese labels', () => {
	assert.equal(realtimeAsrBooleanLabel(true), '是');
	assert.equal(realtimeAsrBooleanLabel(false), '否');
	assert.deepEqual(
		[
			'none', 'socket-not-open', 'task-not-started', 'audio-not-ready', 'stopping',
			'disposed', 'finished', 'queue-empty', 'inflight-limit',
			'pending-callback-limit', 'media-deadline', 'ws-buffer-limit',
		].map((reason) => realtimeAsrPumpBlockReasonLabel(reason)),
		[
			'无', 'Socket 未打开', '识别任务尚未启动', '音频发送尚未就绪', '正在停止',
			'Provider 已释放', '任务已结束', '发送队列为空', '待回调发送已达上限',
			'待回调发送达到安全上限',
			'等待下一个音频发送时刻',
			'WebSocket 缓冲已达上限',
		],
	);
	assert.equal(realtimeAsrPumpBlockReasonLabel('untrusted-dynamic-value'), '未知状态');
	assert.deepEqual(
		[null, 'app-queue-limit', 'ws-buffer-limit'].map((reason) => (
			realtimeAsrOverflowReasonLabel(reason)
		)),
		['无', '应用实时音频队列达到安全上限', 'WebSocket 发送缓冲达到安全上限'],
	);
	assert.deepEqual(
		['none', 'task-started', 'result-generated', 'heartbeat', 'task-failed', 'task-finished', 'unknown']
			.map((kind) => realtimeAsrInboundEventKindLabel(kind)),
		['无', 'Task 已启动', '识别结果', '心跳', 'Task 失败', 'Task 已结束', '未知事件'],
	);
});

test('bundle gate embeds ws, leaves no external ws require, and does not initialize Node builtins on module load', async () => {
	const buildConfig = await readFile('esbuild.config.mjs', 'utf8');
	const require = createRequire(import.meta.url);
	const wsNodeEntry = require.resolve('ws');
	const output = await build({
		stdin: {
			contents: "export { createNodeRealtimeAsrTransport } from './realtime-asr-websocket.ts';",
			resolveDir: process.cwd(),
			sourcefile: 'realtime-asr-bundle-gate.ts',
		},
		bundle: true,
		format: 'cjs',
		platform: 'browser',
		target: 'es2021',
		write: false,
		external: ['bufferutil', 'utf-8-validate', 'buffer', 'crypto', 'events', 'http', 'https', 'net', 'stream', 'tls', 'url', 'util', 'zlib'],
		plugins: [{
			name: 'bundle-node-ws-entry',
			setup(builder) { builder.onResolve({ filter: /^ws$/ }, () => ({ path: wsNodeEntry })); },
		}],
	});
	const bundled = output.outputFiles[0].text;
	assert.doesNotMatch(bundled, /require\(["']ws["']\)/);
	assert.match(bundled, /permessage-deflate/);
	assert.match(buildConfig, /This bundle includes ws[\s\S]*?licensed under MIT/);
	assert.match(buildConfig, /Copyright \(c\) 2011 Einar Otto Stangvik/);
	vm.runInNewContext(bundled, {
		module: { exports: {} }, exports: {},
		require(name) { throw new Error(`Node module initialized during mobile-safe load: ${name}`); },
		console,
	});
});

test('settings and plugin integration reuse one Qwen key and do not persist transcript or PCM', async () => {
	const [types, settings, main, controller, workbench, binding] = await Promise.all([
		readFile('types.ts', 'utf8'), readFile('settings-data.ts', 'utf8'),
		readFile('main.ts', 'utf8'), readFile('realtime-asr-session-controller.ts', 'utf8'),
		readFile('classroom-workbench-view.ts', 'utf8'),
		readFile('realtime-asr-workbench-binding.ts', 'utf8'),
	]);
	assert.match(types, /qwen:[\s\S]*?apiKey:[\s\S]*?asrModel:/);
	assert.match(settings, /qwen-audio-3\.0-asr-flash-streaming/);
	assert.equal((main.match(/new RealtimeAsrSessionController/g) ?? []).length, 1);
	assert.match(main, /RealtimeAsrSessionController[\s\S]*?audio: this\.audioCompanionSessionController/);
	assert.doesNotMatch(controller, /saveData|createBinary|Vault|Markdown|requestUrl|fetch\(/);
	assert.match(workbench, /RealtimeAsrWorkbenchBinding/);
	assert.match(workbench, /perMessageDeflateConfigured[\s\S]*?perMessageDeflateNegotiated/);
	assert.match(workbench, /partialText[\s\S]*?lastFinalText[\s\S]*?sentAudioDurationMs/);
	assert.match(workbench, /详细状态/);
	assert.match(workbench, /开发者诊断/);
	assert.match(workbench, /queuedChunkCount[\s\S]*?inFlightSendCount[\s\S]*?wsBufferedAmount/);
	assert.match(
		workbench,
		/dispatchChunkCount[\s\S]*?sendCallbackSuccessCount[\s\S]*?sendCallbackFailureCount[\s\S]*?sendCallbackSettledCount/,
	);
	assert.match(workbench, /oldestInFlightAgeMs[\s\S]*?maxObservedInFlightAgeMs/);
	assert.match(
		workbench,
		/socketOpen[\s\S]*?taskStarted[\s\S]*?audioSendReady[\s\S]*?pumpActive[\s\S]*?pumpScheduled[\s\S]*?stopping[\s\S]*?lastPumpBlockReason/,
	);
	assert.match(
		workbench,
		/socketEverOpened[\s\S]*?runTaskEverSent[\s\S]*?taskEverStarted[\s\S]*?firstAudioEverDispatched[\s\S]*?warmupQueuedChunkCount[\s\S]*?warmupDroppedChunkCount[\s\S]*?warmupDroppedDurationMs/,
	);
	assert.match(
		workbench,
		/inboundMessageCount[\s\S]*?resultGeneratedEventCount[\s\S]*?ignoredHeartbeatCount[\s\S]*?lastInboundEventKind[\s\S]*?firstResultGeneratedLatencyMs/,
	);
	assert.match(
		workbench,
		/liveWallElapsedMs[\s\S]*?producedAudioDurationMs[\s\S]*?dispatchedAudioDurationMs[\s\S]*?currentDispatchLeadMs[\s\S]*?minDispatchIntervalMs[\s\S]*?maxDispatchBurstCount/,
	);
	assert.match(
		workbench,
		/averageDispatchIntervalMs[\s\S]*?currentDeadlineLatenessMs[\s\S]*?maxDeadlineLatenessMs[\s\S]*?controlledRecoveryDispatchCount[\s\S]*?schedulerWakeupCount/,
	);
	assert.match(
		workbench,
		/eventLoopLagCurrentMs[\s\S]*?eventLoopLagMaxMs[\s\S]*?eventLoopLagP95Ms[\s\S]*?providerStatePublishCount[\s\S]*?sessionNotificationCount[\s\S]*?workbenchRenderCount[\s\S]*?maxStateListenerDurationMs/,
	);
	assert.match(binding, /throttleMs = 250/);
	assert.match(binding, /lifecycleChanged[\s\S]*?applyNow\(state\)/);
	assert.doesNotMatch(workbench, /apiKey|Authorization|\.pcm|raw server|rawJson/);
	assert.match(workbench, /realtimeAsrBinding\?\.close\(\)/);
});

function asrState(status, overrides = {}) {
	return {
		status, classroomSessionId: null, partialText: '', recentFinalSegments: [],
		lastFinalText: '', sentFrameCount: 0, sentAudioDurationMs: 0,
		errorCode: null, startedAt: null, audioBaseOffsetMs: null,
			diagnostics: {
			eventLoopLagCurrentMs: 0, eventLoopLagMaxMs: 0, eventLoopLagP95Ms: 0,
			providerStatePublishCount: 0, providerStatePublishRate: 0,
			sessionNotificationCount: 0, sessionNotificationRate: 0,
			workbenchRenderCount: 0, workbenchRenderRate: 0,
			workbenchLastRenderDurationMs: 0, workbenchMaxRenderDurationMs: 0,
			maxStateListenerDurationMs: 0,
			perMessageDeflateConfigured: false,
			perMessageDeflateNegotiated: false,
			producedChunkCount: 0, sentChunkCount: 0, queuedChunkCount: 0,
			inFlightSendCount: 0, outstandingChunkCount: 0, maxOutstandingChunkCount: 0,
			wsBufferedAmount: 0, maxWsBufferedAmount: 0,
			sendWriteLatencyMs: null, oldestInFlightAgeMs: null,
			maxObservedInFlightAgeMs: 0, dispatchChunkCount: 0,
			sendCallbackSuccessCount: 0, sendCallbackFailureCount: 0,
			sendCallbackSettledCount: 0, overflowReason: null,
			socketOpen: false, taskStarted: false, audioSendReady: false,
			pumpActive: false, pumpScheduled: false, stopping: false,
			lastPumpBlockReason: 'socket-not-open',
			socketEverOpened: false, runTaskEverSent: false,
			taskEverStarted: false, firstAudioEverDispatched: false,
			warmupQueuedChunkCount: 0, warmupDroppedChunkCount: 0,
			warmupDroppedDurationMs: 0,
			inboundMessageCount: 0, taskStartedEventCount: 0,
			resultGeneratedEventCount: 0, taskFailedEventCount: 0,
			taskFinishedEventCount: 0, ignoredHeartbeatCount: 0,
			unknownEventCount: 0, lastInboundEventKind: 'none',
			lastInboundEventAgeMs: null, firstResultGeneratedLatencyMs: null,
			liveWallElapsedMs: 0, producedAudioDurationMs: 0,
			dispatchedAudioDurationMs: 0, currentDispatchLeadMs: 0,
			maxDispatchLeadMs: 0, minDispatchIntervalMs: null,
			averageDispatchIntervalMs: 0, currentDeadlineLatenessMs: 0,
			maxDeadlineLatenessMs: 0, controlledRecoveryDispatchCount: 0,
			schedulerWakeupCount: 0,
			maxDispatchBurstCount: 0,
		},
		...overrides,
	};
}

function emptyAbResult(overrides = {}) {
	return {
		runnerKind: 'current-transport',
		status: 'normal',
		durationTargetMs: 75_000,
		wallElapsedMs: 75_000,
		cancelled: false,
		completed: true,
		stableErrorCode: null,
		targetChunkCount: 750,
		dispatchCount: 750,
		successCount: 750,
		failureCount: 0,
		callbackSettledCount: 750,
		finalInFlightCount: 0,
		maxInFlightCount: 1,
		finalQueuedCount: 0,
		maxQueuedCount: 1,
		lastSendWriteLatencyMs: 0,
		averageSendWriteLatencyMs: 0,
		p50SendWriteLatencyMs: 0,
		p95SendWriteLatencyMs: 0,
		p99SendWriteLatencyMs: 0,
		maxSendWriteLatencyMs: 0,
		oldestInFlightAgeMs: null,
		maxObservedInFlightAgeMs: 0,
		finalBufferedAmount: 0,
		maxBufferedAmount: 0,
		minDispatchIntervalMs: 100,
		maxDispatchIntervalMs: 100,
		maxDispatchBurstCount: 1,
		dispatchedAudioDurationMs: 75_000,
		currentDispatchLeadMs: 0,
		maxDispatchLeadMs: 100,
		taskStartedEventCount: 1,
		resultGeneratedEventCount: 0,
		taskFailedEventCount: 0,
		taskFinishedEventCount: 1,
		unknownEventCount: 0,
		perMessageDeflateConfigured: false,
		perMessageDeflateNegotiated: false,
		intervalSamples: [],
		...overrides,
	};
}

function checksum(data) {
	let value = 2_166_136_261;
	for (const byte of data) {
		value ^= byte;
		value = Math.imul(value, 16_777_619) >>> 0;
	}
	return value;
}

async function driveVirtualPromise(promise, scheduler, maxSteps = 1_100) {
	let settled = false;
	let value;
	let failure;
	promise.then(
		(result) => { settled = true; value = result; },
		(error) => { settled = true; failure = error; },
	);
	for (let step = 0; step < maxSteps && !settled; step += 1) {
		await scheduler.advanceBy(100);
	}
	if (!settled) throw new Error('Virtual diagnostic did not settle.');
	if (failure) throw failure;
	return value;
}

async function driveJitteredPromise(promise, scheduler, maxSteps = 5_000) {
	let settled = false;
	let value;
	let failure;
	promise.then(
		(result) => { settled = true; value = result; },
		(error) => { settled = true; failure = error; },
	);
	for (let step = 0; step < maxSteps && !settled; step += 1) {
		await new Promise((resolve) => setImmediate(resolve));
		if (settled) break;
		const nextDueAt = scheduler.nextDueAt();
		if (nextDueAt === Number.POSITIVE_INFINITY) {
			await new Promise((resolve) => setImmediate(resolve));
			continue;
		}
		await scheduler.advanceTo(nextDueAt);
	}
	if (!settled) throw new Error('Jittered diagnostic did not settle.');
	if (failure) throw failure;
	return value;
}

async function waitFor(predicate, timeoutMs = 1_000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition.');
		await new Promise((resolve) => setImmediate(resolve));
	}
}
