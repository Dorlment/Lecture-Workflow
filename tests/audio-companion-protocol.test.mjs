import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { build } from 'esbuild';

const bundle = await build({
	stdin: {
		contents: [
			"export * from './audio-companion-types.ts';",
			"export * from './audio-companion-endpoint.ts';",
			"export * from './audio-companion-protocol.ts';",
			"export * from './audio-companion-client.ts';",
		].join('\n'),
		resolveDir: process.cwd(),
		sourcefile: 'audio-companion-protocol-test-entry.ts',
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	write: false,
});
const bundledSource = bundle.outputFiles[0]?.text;
if (!bundledSource) throw new Error('Failed to bundle audio companion modules.');
const {
	AUDIO_COMPANION_DEFAULT_ENDPOINT,
	AUDIO_COMPANION_MAX_CONTROL_BYTES,
	AUDIO_COMPANION_MAX_PCM_BYTES,
	AudioCompanionClient,
	AudioCompanionClientError,
	AudioCompanionProtocolError,
	audioCompanionUiStatus,
	encodeAudioCompanionControlMessage,
	isValidAudioCompanionToken,
	parseAudioCompanionFrame,
	parseAudioCompanionServerMessage,
	validateAudioCompanionEndpoint,
} = await import(`data:text/javascript,${encodeURIComponent(bundledSource)}`);

const READY = {
	type: 'READY',
	protocolVersion: 1,
	helperVersion: '1.0.0',
	platform: 'windows',
	supportedSources: ['windows-wasapi-loopback'],
	supportedFormats: [{ sampleFormat: 's16le', sampleRate: 16_000, channels: 1 }],
	capabilities: ['audio-frame-v1', 'heartbeat-v1', 'source-selection-v1'],
};

const sharedFrameFixture = JSON.parse(await readFile(
	new URL('./fixtures/audio-companion-frame-v1.json', import.meta.url),
	'utf8',
));

function pairingToken() {
	return 'A'.repeat(43);
}

class FakeScheduler {
	constructor(now = 1_000_000) {
		this.currentTime = now;
		this.nextId = 1;
		this.tasks = new Map();
	}

	now = () => this.currentTime;

	setTimeout = (callback, delayMs) => this.addTask(callback, delayMs, null);

	clearTimeout = (id) => this.tasks.delete(id);

	setInterval = (callback, delayMs) => this.addTask(callback, delayMs, delayMs);

	clearInterval = (id) => this.tasks.delete(id);

	advance(ms) {
		const end = this.currentTime + ms;
		while (true) {
			const next = [...this.tasks.entries()]
				.filter(([, task]) => task.due <= end)
				.sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
			if (!next) break;
			const [id, task] = next;
			this.currentTime = task.due;
			if (task.interval === null) {
				this.tasks.delete(id);
			} else {
				task.due += task.interval;
			}
			task.callback();
		}
		this.currentTime = end;
	}

	addTask(callback, delayMs, interval) {
		const id = this.nextId++;
		this.tasks.set(id, { callback, due: this.currentTime + delayMs, interval });
		return id;
	}
}

class FakeSocket {
	readyState = 0;
	onOpen = null;
	onMessage = null;
	onError = null;
	onClose = null;
	sent = [];
	closeCalls = [];

	send(data) {
		this.sent.push(data);
	}

	close(code, reason) {
		this.readyState = 3;
		this.closeCalls.push({ code, reason });
	}

	open() {
		this.readyState = 1;
		this.onOpen?.();
	}

	message(data) {
		this.onMessage?.(data);
	}

	fail(name = 'NetworkError') {
		this.onError?.(name);
	}

	unexpectedClose() {
		this.readyState = 3;
		this.onClose?.({ code: 1006, wasClean: false });
	}
}

function clientHarness(options = {}) {
	const scheduler = new FakeScheduler(options.now ?? 1_000_000);
	const sockets = [];
	const endpoints = [];
	const frames = [];
	const diagnostics = [];
	const states = [];
	let session = options.session ?? {
		sessionId: '20260809-143000-123',
		startedAtUnixMs: scheduler.now() - 12_500,
	};
	const client = new AudioCompanionClient({
		clientVersion: '1.0.0',
		getSessionContext: () => session,
		webSocketFactory: (endpoint) => {
			endpoints.push(endpoint);
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
		scheduler,
		onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
	});
	client.subscribeAudioFrames((frame) => frames.push(frame));
	client.subscribe((state) => states.push(state));
	return {
		client,
		diagnostics,
		endpoints,
		frames,
		scheduler,
		sockets,
		states,
		configure(token = pairingToken(), endpoint = AUDIO_COMPANION_DEFAULT_ENDPOINT) {
			return client.configure({ endpoint, token });
		},
		setSession(value) { session = value; },
	};
}

async function connectReady(harness) {
	harness.configure();
	const connected = harness.client.connect();
	const socket = harness.sockets[0];
	socket.open();
	socket.message(JSON.stringify(READY));
	await connected;
	return socket;
}

function createFrame({
	sequence = 1,
	offsetMs = 12_520n,
	sampleRate = 16_000,
	channels = 1,
	sampleCount = 320,
	payloadLength = sampleCount * channels * 2,
	actualPayloadLength = payloadLength,
	format = 1,
	flags = 0,
} = {}) {
	const bytes = new Uint8Array(32 + actualPayloadLength);
	bytes.set([0x4c, 0x57, 0x41, 0x46], 0);
	const view = new DataView(bytes.buffer);
	view.setUint8(4, 1);
	view.setUint8(5, format);
	view.setUint8(6, channels);
	view.setUint8(7, flags);
	view.setUint32(8, sequence, true);
	view.setUint32(12, sampleRate, true);
	view.setUint32(16, sampleCount, true);
	view.setUint32(20, payloadLength, true);
	view.setBigUint64(24, offsetMs, true);
	return bytes.buffer;
}

function startCapturing(harness, socket) {
	assert.equal(harness.client.startCapture('windows-wasapi-loopback'), 'starting');
	const start = JSON.parse(socket.sent.at(-1));
	assert.equal(start.type, 'START');
	assert.equal(start.captureStartOffsetMs, 12_500);
	socket.message(JSON.stringify({ type: 'STATUS', protocolVersion: 1, status: 'capturing' }));
	assert.equal(harness.client.state.status, 'capturing');
}

test('valid HELLO authentication and READY negotiation reach ready state', async () => {
	const harness = clientHarness();
	const socket = await connectReady(harness);
	assert.equal(harness.endpoints[0], AUDIO_COMPANION_DEFAULT_ENDPOINT);
	const hello = JSON.parse(socket.sent[0]);
	assert.deepEqual({
		type: hello.type,
		protocolVersion: hello.protocolVersion,
		sessionId: hello.sessionId,
		clientVersion: hello.clientVersion,
		authScheme: hello.auth.scheme,
	}, {
		type: 'HELLO',
		protocolVersion: 1,
		sessionId: '20260809-143000-123',
		clientVersion: '1.0.0',
		authScheme: 'pairing-token',
	});
	assert.equal(harness.client.state.status, 'ready');
	assert.equal(harness.client.state.helperVersion, '1.0.0');
});

test('pairing token requires a base64url-compatible encoding of at least 32 bytes', () => {
	assert.equal(isValidAudioCompanionToken('A'.repeat(42)), false);
	assert.equal(isValidAudioCompanionToken(pairingToken()), true);
	assert.equal(isValidAudioCompanionToken('A'.repeat(45)), false);
	assert.equal(isValidAudioCompanionToken(`${'A'.repeat(42)}=`), false);
	assert.deepEqual(clientHarness().configure('short'), {
		status: 'invalid',
		code: 'token-missing',
	});
});

test('server authentication rejection is distinct and safely rejects connection', async () => {
	const harness = clientHarness();
	harness.configure();
	const connection = harness.client.connect();
	harness.sockets[0].open();
	harness.sockets[0].message(JSON.stringify({
		type: 'ERROR',
		protocolVersion: 1,
		code: 'AUTH_FAILED',
		messageZh: '配对凭据无效。',
		retryable: false,
	}));
	await assert.rejects(connection, (error) =>
		error instanceof AudioCompanionClientError && error.code === 'auth-failed');
	assert.equal(harness.client.state.errorCode, 'auth-failed');
});

test('all stable remote ERROR codes are preserved without exposing remote messages', async () => {
	for (const remoteCode of [
		'AUTH_FAILED',
		'PROTOCOL_MISMATCH',
		'INVALID_REQUEST',
		'SOURCE_UNAVAILABLE',
		'FORMAT_UNSUPPORTED',
		'CAPTURE_FAILED',
		'BUSY',
		'INTERNAL_ERROR',
	]) {
		const harness = clientHarness();
		harness.configure();
		const connected = harness.client.connect();
		const socket = harness.sockets[0];
		socket.open();
		socket.message(JSON.stringify({
			type: 'ERROR',
			protocolVersion: 1,
			code: remoteCode,
			messageZh: 'should never escape the parser boundary',
			retryable: false,
		}));
		await assert.rejects(connected, (error) => error.remoteErrorCode === remoteCode);
		assert.equal(harness.client.state.remoteErrorCode, remoteCode);
		assert.equal(harness.diagnostics.at(-1).remoteErrorCode, remoteCode);
		assert.doesNotMatch(JSON.stringify(harness.client.state), /should never escape/);
	}
});

test('malformed remote ERROR safely degrades without preserving untrusted content', async () => {
	const harness = clientHarness();
	harness.configure();
	const connected = harness.client.connect();
	const socket = harness.sockets[0];
	socket.open();
	socket.message(JSON.stringify({
		type: 'ERROR',
		protocolVersion: 1,
		code: 'UNKNOWN_REMOTE_CODE',
		messageZh: 'untrusted response body',
		retryable: false,
	}));
	await assert.rejects(connected, (error) =>
		error.code === 'remote-error' && error.remoteErrorCode === null);
	assert.equal(harness.client.state.errorCode, 'remote-error');
	assert.equal(harness.client.state.remoteErrorCode, null);
	assert.doesNotMatch(JSON.stringify(harness.client.state), /untrusted response body/);
});

test('audio frame subscriptions can be removed without affecting protocol state', async () => {
	const harness = clientHarness();
	const socket = await connectReady(harness);
	startCapturing(harness, socket);
	const observed = [];
	const unsubscribe = harness.client.subscribeAudioFrames((frame) => observed.push(frame.sequence));
	socket.message(createFrame({ sequence: 1 }));
	unsubscribe();
	socket.message(createFrame({ sequence: 2, offsetMs: 12_540n }));
	assert.deepEqual(observed, [1]);
	assert.equal(harness.client.state.status, 'capturing');
});

test('incompatible protocol versions are rejected before READY is accepted', async () => {
	const harness = clientHarness();
	harness.configure();
	const connection = harness.client.connect();
	harness.sockets[0].open();
	harness.sockets[0].message(JSON.stringify({ ...READY, protocolVersion: 2 }));
	await assert.rejects(connection, (error) => error.code === 'protocol-incompatible');
	assert.equal(audioCompanionUiStatus(harness.client.state), 'incompatible');
});

test('endpoint validation accepts only the three fixed loopback forms', () => {
	for (const endpoint of [
		'ws://127.0.0.1:43127/v1/audio',
		'ws://localhost:43127/v1/audio',
		'ws://[::1]:43127/v1/audio',
	]) {
		assert.equal(validateAudioCompanionEndpoint(endpoint).valid, true, endpoint);
	}
	for (const endpoint of [
		'ws://192.168.1.8:43127/v1/audio',
		'ws://8.8.8.8:43127/v1/audio',
		'ws://127.0.0.1:9000/v1/audio',
		'ws://127.0.0.1:43127/wrong',
		'wss://127.0.0.1:43127/v1/audio',
		'ws://user:pass@127.0.0.1:43127/v1/audio',
		'ws://127.0.0.1:43127/v1/audio?token=forbidden',
	]) {
		assert.equal(validateAudioCompanionEndpoint(endpoint).valid, false, endpoint);
	}
});

test('connection timeout closes the socket and restores an actionable error state', async () => {
	const harness = clientHarness();
	harness.configure();
	const rejected = assert.rejects(harness.client.connect(), (error) => error.code === 'connect-timeout');
	harness.scheduler.advance(5_000);
	await rejected;
	assert.equal(harness.client.state.status, 'error');
	assert.equal(harness.sockets[0].closeCalls.length, 1);
});

test('authentication timeout starts after open and does not expose HELLO content', async () => {
	const harness = clientHarness();
	harness.configure();
	const rejected = assert.rejects(harness.client.connect(), (error) => error.code === 'auth-timeout');
	harness.sockets[0].open();
	harness.scheduler.advance(5_000);
	await rejected;
	assert.deepEqual(harness.diagnostics, [{
		code: 'auth-timeout',
		remoteErrorCode: null,
		stage: 'authenticating',
		type: 'TimeoutError',
	}]);
});

test('heartbeat timeout is terminal and does not reconnect automatically', async () => {
	const harness = clientHarness();
	const socket = await connectReady(harness);
	harness.scheduler.advance(5_000);
	assert.equal(JSON.parse(socket.sent.at(-1)).type, 'PING');
	harness.scheduler.advance(10_000);
	assert.equal(harness.client.state.errorCode, 'heartbeat-timeout');
	assert.equal(harness.sockets.length, 1);
});

test('unexpected disconnect rejects authentication and never creates another socket', async () => {
	const harness = clientHarness();
	harness.configure();
	const rejected = assert.rejects(
		harness.client.connect(),
		(error) => error.code === 'unexpected-disconnect',
	);
	harness.sockets[0].open();
	harness.sockets[0].unexpectedClose();
	await rejected;
	assert.equal(harness.sockets.length, 1);
	assert.equal(harness.client.state.status, 'error');
});

test('active capture stops only after STATUS stopped and stop timeout is bounded', async () => {
	const success = clientHarness();
	const successSocket = await connectReady(success);
	startCapturing(success, successSocket);
	const stopped = success.client.stopCapture();
	assert.equal(success.client.state.status, 'stopping');
	assert.equal(JSON.parse(successSocket.sent.at(-1)).type, 'STOP');
	successSocket.message(JSON.stringify({ type: 'STATUS', protocolVersion: 1, status: 'stopped' }));
	await stopped;
	assert.equal(success.client.state.status, 'ready');

	const timeout = clientHarness();
	const timeoutSocket = await connectReady(timeout);
	startCapturing(timeout, timeoutSocket);
	const rejected = assert.rejects(timeout.client.stopCapture(), (error) => error.code === 'stop-timeout');
	timeout.scheduler.advance(3_000);
	await rejected;
});

test('repeated connect and START actions never create duplicate connections or requests', async () => {
	const harness = clientHarness();
	harness.configure();
	const connected = harness.client.connect();
	await assert.rejects(harness.client.connect(), (error) => error.code === 'busy');
	assert.equal(harness.sockets.length, 1);
	harness.sockets[0].open();
	harness.sockets[0].message(JSON.stringify(READY));
	await connected;
	assert.equal(harness.client.startCapture('windows-wasapi-loopback'), 'starting');
	assert.equal(harness.client.startCapture('windows-wasapi-loopback'), 'busy');
	assert.equal(harness.sockets[0].sent.filter((item) => JSON.parse(item).type === 'START').length, 1);
});

test('dispose detaches socket callbacks, clears listeners, and emits nothing later', async () => {
	const harness = clientHarness();
	const socket = await connectReady(harness);
	const before = harness.states.length;
	harness.client.dispose();
	socket.message(JSON.stringify({ type: 'STATUS', protocolVersion: 1, status: 'error' }));
	socket.unexpectedClose();
	assert.equal(harness.states.length, before);
	assert.equal(socket.closeCalls.length, 1);
	await assert.rejects(harness.client.connect(), (error) => error.code === 'disposed');
});

test('invalid JSON, unknown messages, and missing fields are protocol errors', () => {
	for (const message of [
		'{',
		JSON.stringify({ type: 'UNKNOWN', protocolVersion: 1 }),
		JSON.stringify({ type: 'STATUS', protocolVersion: 1 }),
	]) {
		assert.throws(
			() => parseAudioCompanionServerMessage(message),
			AudioCompanionProtocolError,
		);
	}
});

test('control messages enforce the 32 KiB UTF-8 limit', () => {
	const oversized = JSON.stringify({
		type: 'ERROR',
		protocolVersion: 1,
		code: 'INTERNAL_ERROR',
		messageZh: '错'.repeat(AUDIO_COMPANION_MAX_CONTROL_BYTES),
		retryable: false,
	});
	assert.throws(() => parseAudioCompanionServerMessage(oversized), /invalid protocol message/);
	assert.throws(() => encodeAudioCompanionControlMessage({
		type: 'HELLO',
		protocolVersion: 1,
		sessionId: 's',
		clientVersion: 'v'.repeat(AUDIO_COMPANION_MAX_CONTROL_BYTES),
		auth: { scheme: 'pairing-token', token: pairingToken() },
	}), /invalid protocol message/);
});

test('binary frame derives duration from sampleCount and parses uint64 offset safely', () => {
	const frame = parseAudioCompanionFrame(createFrame({ sampleCount: 320, offsetMs: 12_520n }));
	assert.deepEqual({
		sequence: frame.sequence,
		offsetMs: frame.offsetMs,
		sampleCount: frame.sampleCount,
		durationMs: frame.durationMs,
		pcmLength: frame.pcm.byteLength,
	}, {
		sequence: 1,
		offsetMs: 12_520,
		sampleCount: 320,
		durationMs: 20,
		pcmLength: 640,
	});
	assert.throws(
		() => parseAudioCompanionFrame(createFrame({ offsetMs: BigInt(Number.MAX_SAFE_INTEGER) + 1n })),
		/invalid protocol message/,
	);
});

test('PCM size, actual payload length, and sampleCount must all agree', () => {
	assert.throws(
		() => parseAudioCompanionFrame(createFrame({
			sampleCount: AUDIO_COMPANION_MAX_PCM_BYTES / 2 + 1,
		})),
		/invalid protocol message/,
	);
	assert.throws(
		() => parseAudioCompanionFrame(createFrame({ payloadLength: 640, actualPayloadLength: 638 })),
		/invalid protocol message/,
	);
	assert.throws(
		() => parseAudioCompanionFrame(createFrame({ sampleCount: 319, payloadLength: 640 })),
		/invalid protocol message/,
	);
});

test('binary frames before capturing and regressing sequences are protocol errors', async () => {
	const early = clientHarness();
	const earlySocket = await connectReady(early);
	earlySocket.message(createFrame());
	assert.equal(early.client.state.errorCode, 'protocol-error');
	assert.equal(early.frames.length, 0);

	const active = clientHarness();
	const activeSocket = await connectReady(active);
	startCapturing(active, activeSocket);
	activeSocket.message(createFrame({ sequence: 2 }));
	activeSocket.message(createFrame({ sequence: 1, offsetMs: 12_540n }));
	assert.equal(active.frames.length, 1);
	assert.equal(active.client.state.errorCode, 'protocol-error');
});

test('START uses the shared classroom offset at send time and session changes are rejected', async () => {
	const harness = clientHarness();
	const socket = await connectReady(harness);
	harness.scheduler.advance(250);
	assert.equal(harness.client.startCapture('windows-wasapi-loopback'), 'starting');
	const start = JSON.parse(socket.sent.at(-1));
	assert.equal(start.captureStartOffsetMs, 12_750);
	assert.equal(start.sessionStartedAtUnixMs, harness.scheduler.now() - 12_750);

	const changed = clientHarness();
	await connectReady(changed);
	changed.setSession({ sessionId: 'another-session', startedAtUnixMs: 1 });
	assert.equal(changed.client.startCapture('windows-wasapi-loopback'), 'session-unavailable');
});

test('diagnostics, errors, UI state, and source contain no secret or PCM logging surface', async () => {
	const harness = clientHarness();
	harness.configure();
	const rejected = assert.rejects(harness.client.connect());
	harness.sockets[0].fail('NetworkError');
	await rejected;
	const serialized = JSON.stringify({
		diagnostics: harness.diagnostics,
		state: harness.client.state,
		error: new AudioCompanionClientError('connect-failed'),
	});
	assert.doesNotMatch(serialized, /A{20}|PCM|base64|audio content/i);
	const [clientSource, protocolSource] = await Promise.all([
		readFile('audio-companion-client.ts', 'utf8'),
		readFile('audio-companion-protocol.ts', 'utf8'),
	]);
	assert.doesNotMatch(`${clientSource}\n${protocolSource}`, /console\.|localStorage|sessionStorage|saveData|loadData/);
	assert.doesNotMatch(clientSource, /fetch\(|requestUrl|MediaRecorder|child_process|node:fs|ipcRenderer|ipcMain/);
});

test('workbench status mapping covers all six companion display states', () => {
	const base = {
		configured: true,
		errorCode: null,
		remoteErrorCode: null,
		helperVersion: null,
		platform: null,
		supportedSources: [],
	};
	assert.equal(audioCompanionUiStatus({ ...base, configured: false, status: 'idle' }), 'unconfigured');
	assert.equal(audioCompanionUiStatus({ ...base, status: 'disconnected' }), 'disconnected');
	assert.equal(audioCompanionUiStatus({ ...base, status: 'connecting' }), 'connecting');
	assert.equal(audioCompanionUiStatus({ ...base, status: 'authenticating' }), 'connecting');
	assert.equal(audioCompanionUiStatus({ ...base, status: 'ready' }), 'connected');
	assert.equal(audioCompanionUiStatus({
		...base,
		status: 'error',
		errorCode: 'protocol-incompatible',
	}), 'incompatible');
	assert.equal(audioCompanionUiStatus({
		...base,
		status: 'error',
		errorCode: 'connect-failed',
	}), 'failed');
});

test('TypeScript frame parser reads the shared C# golden fixture', () => {
	const packet = Uint8Array.from(Buffer.from(sharedFrameFixture.packetHex, 'hex'));
	const frame = parseAudioCompanionFrame(packet);

	assert.equal(frame.sequence, sharedFrameFixture.sequence);
	assert.equal(frame.offsetMs, sharedFrameFixture.offsetMs);
	assert.equal(frame.sampleRate, sharedFrameFixture.sampleRate);
	assert.equal(frame.channels, sharedFrameFixture.channels);
	assert.equal(frame.sampleFormat, sharedFrameFixture.sampleFormat);
	assert.equal(frame.sampleCount, sharedFrameFixture.sampleCount);
	assert.equal(Buffer.from(frame.pcm).toString('hex'), sharedFrameFixture.pcmHex);
});

test('Windows helper documentation requires manual v0.1 installation at the resolver path', async () => {
	const [rootReadme, companionReadme] = await Promise.all([
		readFile('README.md', 'utf8'),
		readFile('companion/windows/README.md', 'utf8'),
	]);
	const combined = `${rootReadme}\n${companionReadme}`;
	assert.match(combined, /lecture-workflow-windows-helper-win-x64-v0\.1\.0\.zip/);
	assert.match(combined, /<Vault>\/\.obsidian\/plugins\/lecture-workflow\/companion\/windows\/LectureWorkflow\.AudioCompanion\.Windows\.exe/);
	assert.match(combined, /companion\/windows\/lecture-workflow-windows-helper-win-x64-v0\.1\.0\/LectureWorkflow\.AudioCompanion\.Windows\.exe/);
	assert.match(companionReadme, /Microsoft\.NETCore\.App 10\.0/);
	assert.match(companionReadme, /Microsoft\.AspNetCore\.App 10\.0/);
	assert.match(companionReadme, /complete runtime\s+dependency set retained from the actual publish output/);
	assert.match(combined, /does not download, extract, install, replace, or update this helper|\u4e0d\u4f1a\u81ea\u52a8\u4e0b\u8f7d\u3001\u5b89\u88c5\u3001\u89e3\u538b\u6216\u66f4\u65b0 Helper/);
	assert.doesNotMatch(companionReadme, /^# .*POC$/mu);
});

test('one-paste Windows acceptance script keeps its pairing token in process memory', async () => {
	const readme = await readFile('companion/windows/README.md', 'utf8');
	const match = readme.match(/## One-paste default-device-change acceptance test[\s\S]*?```powershell\r?\n([\s\S]*?)\r?\n```/);
	assert.ok(match, 'Expected the development-only PowerShell acceptance script.');
	const script = match[1];

	assert.match(script, /New-Object byte\[\] 32/);
	assert.match(script, /RandomNumberGenerator\]::Create\(\)/);
	assert.match(script, /\$rng\.GetBytes\(\$tokenBytes\)/);
	assert.match(script, /\$rng\.Dispose\(\)/);
	assert.match(script, /RedirectStandardInput = \$true/);
	assert.match(script, /StandardInput\.WriteLine\(\$PairingToken\)/);
	assert.match(script, /--stop-on-stdin-eof/);
	assert.match(script, /--duration-seconds', '10'/);
	assert.equal((script.match(/'server-test-client'/g) ?? []).length, 2);
	assert.match(script, /BeginConnect\('127\.0\.0\.1', 43127/);
	assert.match(script, /\.WaitOne\(500\)/);
	assert.match(script, /EndConnect\(\$asyncResult\)/);
	assert.match(script, /EndConnect\(\$asyncResult\)\r?\n\s*return \$true/);
	assert.doesNotMatch(script, /return \$client\.Connected/);
	assert.match(script, /\$waitHandle\.Close\(\)/);
	assert.match(script, /\$client\.Dispose\(\)/);
	assert.match(script, /AddSeconds\(60\)/);
	assert.match(script, /server-exited-before-ready/);
	assert.match(script, /acceptance-port-still-in-use/);
	assert.match(script, /\[Array\]::Clear\(\$tokenBytes, 0, \$tokenBytes\.Length\)/);
	assert.match(script, /\$pairingToken = \$null/);
	assert.doesNotMatch(script, /Clipboard|SetEnvironmentVariable|\$env:|Set-Content|Add-Content|Out-File|WriteAllText|WriteAllBytes/i);
	assert.doesNotMatch(script, /ConnectAsync|RandomNumberGenerator\]::GetBytes\(|ArgumentList|\.Kill\(\$true\)|ArgumentList\.Add\(\$PairingToken\)|Write-(?:Host|Output).*PairingToken/i);
});
