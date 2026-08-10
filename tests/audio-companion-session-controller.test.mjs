import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as nodeTimers from 'node:timers';

import { build } from 'esbuild';

const bundle = await build({
	stdin: {
		contents: [
			"export * from './audio-companion-client.ts';",
			"export * from './audio-companion-session-controller.ts';",
			"export * from './audio-frame-consumer.ts';",
			"export * from './companion-process-manager.ts';",
			"export * from './companion-readiness-probe.ts';",
		].join('\n'),
		resolveDir: process.cwd(),
		sourcefile: 'audio-companion-session-controller-test-entry.ts',
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	write: false,
});
const bundledSource = bundle.outputFiles[0]?.text;
if (!bundledSource) throw new Error('Failed to bundle audio companion session controller.');
const {
	AudioCompanionClient,
	AudioCompanionClientError,
	AudioCompanionSessionController,
	AudioFrameConsumer,
	CompanionProcessManager,
	CompanionReadinessError,
} = await import(`data:text/javascript,${encodeURIComponent(bundledSource)}`);

function deferred() {
	let resolve;
	const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
	return { promise, resolve };
}

class FakeClient {
	state = clientState('idle');
	stateListeners = new Set();
	frameListeners = new Set();
	configureCalls = [];
	startCalls = [];
	stopCalls = 0;
	clearCalls = 0;
	connectError = null;
	startResult = 'starting';
	configure(configuration) {
		this.configureCalls.push(configuration);
		this.state = { ...this.state, configured: true };
		return { status: 'configured' };
	}
	async connect() {
		if (this.connectError) throw this.connectError;
		this.emitState(clientState('ready', true));
	}
	startCapture(source) {
		this.startCalls.push(source);
		if (this.startResult === 'starting') this.emitState(clientState('capturing', true));
		return this.startResult;
	}
	async stopCapture() {
		this.stopCalls += 1;
		this.emitState(clientState('ready', true));
	}
	clearConfiguration() {
		this.clearCalls += 1;
		this.emitState(clientState('idle'));
	}
	subscribe(listener) {
		this.stateListeners.add(listener);
		listener(this.state);
		return () => this.stateListeners.delete(listener);
	}
	subscribeAudioFrames(listener) {
		this.frameListeners.add(listener);
		return () => this.frameListeners.delete(listener);
	}
	emitState(state) {
		this.state = state;
		for (const listener of [...this.stateListeners]) listener(state);
	}
	emitFrame(frame) {
		for (const listener of [...this.frameListeners]) listener(frame);
	}
}

class FakeClassroom {
	context = { sessionId: 'class-20260810', startedAtUnixMs: 1_000_000 };
	listeners = new Set();
	getSessionContext = () => this.context;
	subscribe = (listener) => {
		this.listeners.add(listener);
		listener(this.context);
		return () => this.listeners.delete(listener);
	};
	setContext(context) {
		this.context = context;
		for (const listener of [...this.listeners]) listener(context);
	}
}

function clientState(status, configured = false, errorCode = null, remoteErrorCode = null) {
	return {
		status,
		configured,
		errorCode,
		remoteErrorCode,
		helperVersion: configured ? '1.0.0' : null,
		platform: configured ? 'windows' : null,
		supportedSources: configured ? ['windows-wasapi-loopback'] : [],
	};
}

function frame(sequence = 0) {
	return {
		sequence,
		offsetMs: sequence * 20,
		sampleCount: 2,
		durationMs: 0.125,
		sampleRate: 16_000,
		channels: 1,
		sampleFormat: 's16le',
		pcm: new Uint8Array([0, 128, 255, 127]),
	};
}

async function waitUntil(predicate, timeoutMs = 1_000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('Timed out waiting for test state.');
		await new Promise((resolve) => setImmediate(resolve));
	}
}

class FakeProtocolSocket {
	readyState = 0;
	onOpen = null;
	onMessage = null;
	onError = null;
	onClose = null;
	sentTypes = [];
	closeCalls = 0;
	send(data) {
		const message = JSON.parse(data);
		this.sentTypes.push(message.type);
	}
	close() {
		this.closeCalls += 1;
		this.readyState = 3;
	}
	open() {
		this.readyState = 1;
		this.onOpen?.();
	}
	message(value) {
		this.onMessage?.(JSON.stringify(value));
	}
}

class FakeManagedChild {
	stdinEnded = 0;
	killCalls = 0;
	exited = false;
	exitListeners = new Set();
	errorListeners = new Set();
	stdin = {
		write: (_data, callback) => callback(),
		end: () => {
			this.stdinEnded += 1;
			queueMicrotask(() => this.exit(0));
		},
	};
	onExit = (listener) => {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	};
	onError = (listener) => {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	};
	kill = () => {
		this.killCalls += 1;
		this.exit(null, 'SIGTERM');
	};
	exit(code, signal = null) {
		if (this.exited) return;
		this.exited = true;
		for (const listener of [...this.exitListeners]) listener(code, signal);
	}
}

function controllerHarness(options = {}) {
	const client = options.client ?? new FakeClient();
	const classroom = options.classroom ?? new FakeClassroom();
	const frameConsumer = new AudioFrameConsumer();
	const launches = [];
	const processExits = [];
	const processManager = {
		startCalls: [],
		shutdownCalls: 0,
		disposeCalls: 0,
		async start(spec, token) {
			this.startCalls.push({ spec, token });
			const exit = deferred();
			processExits.push(exit);
			return { exit: exit.promise };
		},
		async shutdown() {
			this.shutdownCalls += 1;
			processExits.at(-1)?.resolve({ reason: 'exit', code: 0, signal: null });
		},
		dispose() { this.disposeCalls += 1; },
	};
	const readinessProbe = options.readinessProbe ?? {
		calls: 0,
		async waitUntilReady() { this.calls += 1; },
	};
	const resolver = options.resolver ?? {
		async resolve() {
			launches.push(true);
			return {
				executable: 'helper.exe',
				args: ['server', '--token-stdin', '--stop-on-stdin-eof'],
			};
		},
	};
	const controller = new AudioCompanionSessionController({
		isWindowsDesktop: () => options.isWindowsDesktop ?? true,
		classroom,
		launchResolver: resolver,
		processManager,
		readinessProbe,
		client,
		frameConsumer,
		randomSource: {
			fill(target) { target.fill(7); },
		},
		scheduler: {
			setTimeout: (callback, delayMs) => nodeTimers.setTimeout(callback, delayMs),
			clearTimeout: (handle) => nodeTimers.clearTimeout(handle),
		},
	});
	return {
		client,
		classroom,
		controller,
		frameConsumer,
		launches,
		processExits,
		processManager,
		readinessProbe,
	};
}

test('non-Windows runtime never resolves or launches the helper', async () => {
	const harness = controllerHarness({ isWindowsDesktop: false });
	assert.equal(await harness.controller.start(), 'unsupported');
	assert.equal(harness.launches.length, 0);
	assert.equal(harness.processManager.startCalls.length, 0);
	assert.equal(harness.controller.state.status, 'unsupported');
});

test('missing classroom session prevents helper discovery', async () => {
	const classroom = new FakeClassroom();
	classroom.context = null;
	const harness = controllerHarness({ classroom });
	assert.equal(await harness.controller.start(), 'session-unavailable');
	assert.equal(harness.launches.length, 0);
	assert.equal(harness.controller.state.errorCode, 'session-unavailable');
});

test('default unavailable resolver reports helper-unavailable without Node work', async () => {
	const harness = controllerHarness({ resolver: { resolve: async () => null } });
	assert.equal(await harness.controller.start(), 'helper-unavailable');
	assert.equal(harness.processManager.startCalls.length, 0);
	assert.equal(harness.controller.state.status, 'helper-unavailable');
});

test('start reuses classroom session and reaches capturing through the existing client', async () => {
	const harness = controllerHarness();
	assert.equal(await harness.controller.start(), 'capturing');
	assert.equal(harness.processManager.startCalls.length, 1);
	assert.match(harness.processManager.startCalls[0].token, /^[A-Za-z0-9_-]{43}$/);
	assert.deepEqual(harness.client.startCalls, ['windows-wasapi-loopback']);
	assert.equal(harness.controller.state.status, 'capturing');
	assert.equal(harness.client.frameListeners.size, 1);
	assert.equal(harness.classroom.listeners.size, 1);
	assert.equal(Object.hasOwn(harness.controller.state, 'token'), false);
});

test('frames update safe metrics only while the session subscription is active', async () => {
	const harness = controllerHarness();
	await harness.controller.start();
	const pcm = frame().pcm;
	const original = pcm.slice();
	harness.client.emitFrame({ ...frame(), pcm });
	assert.equal(harness.controller.state.frameCount, 1);
	assert.ok(harness.controller.state.rms > 0);
	assert.deepEqual(pcm, original);
	await harness.controller.stop();
	assert.equal(harness.client.frameListeners.size, 0);
	harness.client.emitFrame(frame(1));
	assert.equal(harness.controller.state.frameCount, 1);
});

test('normal stop clears client configuration and shuts down the owned child', async () => {
	const harness = controllerHarness();
	await harness.controller.start();
	await harness.controller.stop();
	assert.equal(harness.client.stopCalls, 1);
	assert.equal(harness.client.clearCalls, 1);
	assert.equal(harness.processManager.shutdownCalls, 1);
	assert.equal(harness.classroom.listeners.size, 0);
	assert.equal(harness.controller.state.status, 'stopped');
});

test('duplicate starts are rejected and duplicate stops share cleanup', async () => {
	const readiness = deferred();
	const harness = controllerHarness({
		readinessProbe: { waitUntilReady: () => readiness.promise },
	});
	const first = harness.controller.start();
	await Promise.resolve();
	assert.equal(await harness.controller.start(), 'busy');
	readiness.resolve();
	assert.equal(await first, 'capturing');
	await Promise.all([harness.controller.stop(), harness.controller.stop()]);
	assert.equal(harness.processManager.startCalls.length, 1);
	assert.equal(harness.processManager.shutdownCalls, 1);
});

test('stable remote authentication errors survive controller cleanup', async () => {
	const client = new FakeClient();
	client.connectError = new AudioCompanionClientError('auth-failed', 'AUTH_FAILED');
	const harness = controllerHarness({ client });
	assert.equal(await harness.controller.start(), 'error');
	assert.equal(harness.controller.state.errorCode, 'auth-failed');
	assert.equal(harness.controller.state.remoteErrorCode, 'AUTH_FAILED');
	assert.equal(harness.processManager.shutdownCalls, 1);
});

test('readiness failures clean up and a later run can start again', async () => {
	let attempts = 0;
	const harness = controllerHarness({
		readinessProbe: {
			async waitUntilReady() {
				attempts += 1;
				if (attempts === 1) throw new CompanionReadinessError('readiness-timeout');
			},
		},
	});
	assert.equal(await harness.controller.start(), 'error');
	assert.equal(harness.controller.state.errorCode, 'readiness-timeout');
	assert.equal(await harness.controller.start(), 'capturing');
	assert.equal(harness.processManager.startCalls.length, 2);
});

test('AUTH_FAILED remains the first failure when cleanup makes the child exit', async () => {
	const client = new FakeClient();
	client.connectError = new AudioCompanionClientError('auth-failed', 'AUTH_FAILED');
	const harness = controllerHarness({ client });
	await harness.controller.start();
	assert.equal(harness.controller.state.errorCode, 'auth-failed');
	assert.equal(harness.controller.state.remoteErrorCode, 'AUTH_FAILED');
	assert.equal(harness.processManager.shutdownCalls, 1);
});

test('unexpected client failure after capture releases session subscriptions', async () => {
	const harness = controllerHarness();
	await harness.controller.start();
	harness.client.emitState(clientState('error', true, 'remote-error', 'SOURCE_UNAVAILABLE'));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(harness.controller.state.status, 'error');
	assert.equal(harness.controller.state.remoteErrorCode, 'SOURCE_UNAVAILABLE');
	assert.equal(harness.client.frameListeners.size, 0);
	assert.equal(harness.processManager.shutdownCalls, 1);
});

test('unexpected child exit while capturing still reports child-exited', async () => {
	const harness = controllerHarness();
	await harness.controller.start();
	harness.processExits[0].resolve({ reason: 'exit', code: 1, signal: null });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(harness.controller.state.status, 'error');
	assert.equal(harness.controller.state.errorCode, 'child-exited');
	assert.equal(harness.processManager.shutdownCalls, 1);
});

test('stop cancels pending resolver without launching a child', async () => {
	let resolverSignal = null;
	const resolverNeverSettles = new Promise(() => {});
	const harness = controllerHarness({
		resolver: {
			resolve(signal) {
				resolverSignal = signal;
				return resolverNeverSettles;
			},
		},
	});
	const starting = harness.controller.start();
	await Promise.resolve();
	assert.equal(resolverSignal?.aborted, false);
	await harness.controller.stop();
	assert.equal(await starting, 'error');
	assert.equal(resolverSignal.aborted, true);
	assert.equal(harness.processManager.startCalls.length, 0);
	assert.equal(harness.client.configureCalls.length, 0);
	assert.equal(harness.controller.state.status, 'stopped');
});

test('dispose cancels pending resolver without launching or connecting', async () => {
	let resolverSignal = null;
	const harness = controllerHarness({
		resolver: {
			resolve(signal) {
				resolverSignal = signal;
				return new Promise(() => {});
			},
		},
	});
	const starting = harness.controller.start();
	await Promise.resolve();
	harness.controller.dispose();
	assert.equal(await starting, 'error');
	assert.equal(resolverSignal.aborted, true);
	assert.equal(harness.processManager.startCalls.length, 0);
	assert.equal(harness.client.configureCalls.length, 0);
});

test('late resolver completion after stop is discarded', async () => {
	const resolution = deferred();
	const harness = controllerHarness({
		resolver: { resolve: () => resolution.promise },
	});
	const starting = harness.controller.start();
	await Promise.resolve();
	await harness.controller.stop();
	assert.equal(await starting, 'error');
	resolution.resolve({ executable: 'late-helper.exe', args: [] });
	await Promise.resolve();
	assert.equal(harness.processManager.startCalls.length, 0);
	assert.equal(harness.client.configureCalls.length, 0);
	assert.equal(harness.controller.state.status, 'stopped');
});

test('a new run is not polluted by an old resolver completing late', async () => {
	const firstResolution = deferred();
	let calls = 0;
	const harness = controllerHarness({
		resolver: {
			resolve() {
				calls += 1;
				return calls === 1
					? firstResolution.promise
					: Promise.resolve({ executable: 'helper.exe', args: [] });
			},
		},
	});
	const firstStart = harness.controller.start();
	await Promise.resolve();
	await harness.controller.stop();
	assert.equal(await firstStart, 'error');
	assert.equal(await harness.controller.start(), 'capturing');
	firstResolution.resolve({ executable: 'late-helper.exe', args: [] });
	await Promise.resolve();
	assert.equal(harness.processManager.startCalls.length, 1);
	assert.equal(harness.controller.state.status, 'capturing');
});

test('ending the shared classroom session stops capture without creating another timeline', async () => {
	const harness = controllerHarness();
	await harness.controller.start();
	harness.classroom.setContext(null);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(harness.controller.state.status, 'stopped');
	assert.equal(harness.client.stopCalls, 1);
});

test('a classroom session change during connection prevents START from being sent', async () => {
	const classroom = new FakeClassroom();
	classroom.subscribe = (listener) => {
		classroom.listeners.add(listener);
		listener(null);
		return () => classroom.listeners.delete(listener);
	};
	const harness = controllerHarness({ classroom });
	assert.equal(await harness.controller.start(), 'error');
	assert.equal(harness.client.startCalls.length, 0);
	assert.equal(harness.processManager.shutdownCalls, 1);
});

test('dispose during capture removes listeners and force-cleans owned resources once', async () => {
	const harness = controllerHarness();
	await harness.controller.start();
	harness.controller.dispose();
	harness.controller.dispose();
	assert.equal(harness.client.frameListeners.size, 0);
	assert.equal(harness.classroom.listeners.size, 0);
	assert.equal(harness.processManager.disposeCalls, 1);
	assert.deepEqual(harness.frameConsumer.state, { frameCount: 0, rms: 0 });
});

test('real client protocol ERROR survives controller cleanup and owned child exit', async () => {
	const sockets = [];
	const classroom = new FakeClassroom();
	const client = new AudioCompanionClient({
		clientVersion: '1.0.0',
		getSessionContext: () => classroom.context,
		webSocketFactory: () => {
			const socket = new FakeProtocolSocket();
			sockets.push(socket);
			return socket;
		},
		scheduler: {
			now: () => Date.now(),
			setTimeout: (callback, delayMs) => nodeTimers.setTimeout(callback, delayMs),
			clearTimeout: (handle) => nodeTimers.clearTimeout(handle),
			setInterval: (callback, delayMs) => nodeTimers.setInterval(callback, delayMs),
			clearInterval: (handle) => nodeTimers.clearInterval(handle),
		},
	});
	const child = new FakeManagedChild();
	const processManager = new CompanionProcessManager({
		spawn: () => child,
		scheduler: {
			setTimeout: (callback, delayMs) => nodeTimers.setTimeout(callback, delayMs),
			clearTimeout: (handle) => nodeTimers.clearTimeout(handle),
		},
		shutdownTimeoutMs: 10,
	});
	const controller = new AudioCompanionSessionController({
		isWindowsDesktop: () => true,
		classroom,
		launchResolver: {
			resolve: async () => ({ executable: 'helper.exe', args: ['server', '--token-stdin'] }),
		},
		processManager,
		readinessProbe: { waitUntilReady: async () => undefined },
		client,
		frameConsumer: new AudioFrameConsumer(),
		randomSource: { fill: (target) => target.fill(11) },
		scheduler: {
			setTimeout: (callback, delayMs) => nodeTimers.setTimeout(callback, delayMs),
			clearTimeout: (handle) => nodeTimers.clearTimeout(handle),
		},
	});
	const starting = controller.start();
	await waitUntil(() => sockets.length === 1);
	const socket = sockets[0];
	socket.open();
	await waitUntil(() => socket.sentTypes.includes('HELLO'));
	socket.message({
		type: 'READY',
		protocolVersion: 1,
		helperVersion: '1.0.0',
		platform: 'windows',
		supportedSources: ['windows-wasapi-loopback'],
		supportedFormats: [{ sampleFormat: 's16le', sampleRate: 16000, channels: 1 }],
		capabilities: ['audio-frame-v1', 'heartbeat-v1', 'source-selection-v1'],
	});
	await waitUntil(() => socket.sentTypes.includes('START'));
	socket.message({ type: 'STATUS', protocolVersion: 1, status: 'capturing' });
	assert.equal(await starting, 'capturing');
	socket.message({
		type: 'ERROR',
		protocolVersion: 1,
		code: 'SOURCE_UNAVAILABLE',
		messageZh: 'must remain inside the parser boundary',
		retryable: true,
	});
	await waitUntil(() => controller.state.status === 'error');
	assert.equal(controller.state.errorCode, 'remote-error');
	assert.equal(controller.state.remoteErrorCode, 'SOURCE_UNAVAILABLE');
	assert.equal(processManager.isRunning, false);
	assert.equal(child.stdinEnded, 1);
	assert.equal(child.killCalls, 0);
	assert.equal(child.exitListeners.size, 0);
	assert.equal(child.errorListeners.size, 0);
	assert.equal(socket.onMessage, null);
	assert.doesNotMatch(JSON.stringify(controller.state), /parser boundary/);
	controller.dispose();
	client.dispose();
});

test('plugin wiring owns one controller and no permanent main-level frame listener', async () => {
	const [main, manifest, processManager, readiness, loader] = await Promise.all([
		readFile('main.ts', 'utf8'),
		readFile('manifest.json', 'utf8'),
		readFile('companion-process-manager.ts', 'utf8'),
		readFile('companion-readiness-probe.ts', 'utf8'),
		readFile('runtime-node-loader.ts', 'utf8'),
	]);
	assert.equal((main.match(/new AudioCompanionSessionController/g) ?? []).length, 1);
	assert.match(main, /audioCompanionSessionController\?\.dispose\(\)/);
	assert.doesNotMatch(main, /onAudioFrame\s*:/);
	assert.match(main, /createWindowsPluginRelativeLaunchResolver\(/);
	assert.match(main, /createObsidianCompanionPluginDirectoryProvider\(this\)/);
	assert.equal(JSON.parse(manifest).isDesktopOnly, false);
	assert.doesNotMatch(`${processManager}\n${readiness}\n${loader}`, /from ['"]node:/);
	assert.doesNotMatch(processManager, /43127|COMPANION_PORT|launchResolver/);
});
