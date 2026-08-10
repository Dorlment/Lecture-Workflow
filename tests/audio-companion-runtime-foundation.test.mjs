import assert from 'node:assert/strict';
import test from 'node:test';
import * as nodeTimers from 'node:timers';

import { build } from 'esbuild';

const bundle = await build({
	stdin: {
		contents: [
			"export * from './audio-companion-token.ts';",
			"export * from './audio-frame-consumer.ts';",
			"export * from './companion-launch-resolver.ts';",
			"export * from './companion-process-types.ts';",
			"export * from './companion-process-manager.ts';",
			"export * from './companion-readiness-probe.ts';",
			"export * from './runtime-node-loader.ts';",
		].join('\n'),
		resolveDir: process.cwd(),
		sourcefile: 'audio-companion-runtime-foundation-test-entry.ts',
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	write: false,
});
const bundledSource = bundle.outputFiles[0]?.text;
if (!bundledSource) throw new Error('Failed to bundle runtime foundation modules.');
const {
	AudioFrameConsumer,
	CompanionProcessError,
	CompanionProcessManager,
	CompanionReadinessError,
	CompanionReadinessProbe,
	calculatePcmS16LeRms,
	createAudioCompanionToken,
	createFixedCompanionLaunchResolver,
	createNodeCompanionSpawnFactory,
	createNodeTcpConnector,
	createUnavailableCompanionLaunchResolver,
} = await import(`data:text/javascript,${encodeURIComponent(bundledSource)}`);

class FakeChild {
	stdinLines = [];
	stdinEnded = 0;
	killCalls = 0;
	exitListeners = new Set();
	errorListeners = new Set();
	writeError = null;
	stdin = {
		write: (data, callback) => {
			this.stdinLines.push(data);
			callback(this.writeError);
		},
		end: () => { this.stdinEnded += 1; },
	};
	onExit = (listener) => {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	};
	onError = (listener) => {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	};
	kill = () => { this.killCalls += 1; };
	exit(code = 0, signal = null) {
		for (const listener of [...this.exitListeners]) listener(code, signal);
	}
	fail(error = new Error('private child detail')) {
		for (const listener of [...this.errorListeners]) listener(error);
	}
}

function processHarness(options = {}) {
	const child = options.child ?? new FakeChild();
	const spawnCalls = [];
	const manager = new CompanionProcessManager({
		spawn: (executable, args, spawnOptions) => {
			spawnCalls.push({ executable, args, options: spawnOptions });
			return child;
		},
		scheduler: {
			setTimeout: (callback, delayMs) => nodeTimers.setTimeout(callback, delayMs),
			clearTimeout: (handle) => nodeTimers.clearTimeout(handle),
		},
		shutdownTimeoutMs: options.shutdownTimeoutMs ?? 5,
	});
	return { child, manager, spawnCalls };
}

const launchSpec = {
	executable: 'LectureWorkflow.AudioCompanion.Windows.exe',
	args: ['server', '--token-stdin', '--stop-on-stdin-eof'],
	cwd: 'companion-runtime',
};

function token() {
	return 'A'.repeat(43);
}

test('token uses deterministic 32-byte Base64URL input and clears source bytes', () => {
	let filledTarget;
	const generated = createAudioCompanionToken({
		fill(target) {
			filledTarget = target;
			for (let index = 0; index < target.length; index += 1) target[index] = index;
		},
	});
	assert.equal(generated.length, 43);
	assert.match(generated, /^[A-Za-z0-9_-]{43}$/);
	assert.deepEqual([...filledTarget], Array(32).fill(0));
});

test('launch resolver is independent from process execution', async () => {
	const signal = new AbortController().signal;
	assert.equal(await createUnavailableCompanionLaunchResolver().resolve(signal), null);
	const resolved = await createFixedCompanionLaunchResolver(launchSpec).resolve(signal);
	assert.deepEqual(resolved, launchSpec);
	assert.notEqual(resolved.args, launchSpec.args);
});

test('built-in launch resolvers reject an already-cancelled discovery run', async () => {
	const abort = new AbortController();
	abort.abort();
	await assert.rejects(createUnavailableCompanionLaunchResolver().resolve(abort.signal));
	await assert.rejects(createFixedCompanionLaunchResolver(launchSpec).resolve(abort.signal));
});

test('process manager passes token only through child stdin', async () => {
	const harness = processHarness();
	await harness.manager.start(launchSpec, token());
	assert.deepEqual(harness.child.stdinLines, [`${token()}\n`]);
	assert.equal(JSON.stringify(harness.spawnCalls).includes(token()), false);
	assert.deepEqual(harness.spawnCalls[0], {
		executable: launchSpec.executable,
		args: launchSpec.args,
		options: {
			cwd: launchSpec.cwd,
			stdio: ['pipe', 'ignore', 'ignore'],
			windowsHide: true,
		},
	});
	harness.child.exit();
});

test('process manager rejects a launch spec containing the token', async () => {
	const harness = processHarness();
	await assert.rejects(
		harness.manager.start({ ...launchSpec, args: ['server', token()] }, token()),
		(error) => error instanceof CompanionProcessError && error.code === 'invalid-launch-spec',
	);
	assert.equal(harness.spawnCalls.length, 0);
});

test('process manager prevents duplicate owned children', async () => {
	const harness = processHarness();
	await harness.manager.start(launchSpec, token());
	await assert.rejects(harness.manager.start(launchSpec, token()), (error) => error.code === 'busy');
	assert.equal(harness.spawnCalls.length, 1);
	harness.child.exit();
});

test('normal process shutdown closes stdin and waits for exit without killing', async () => {
	const harness = processHarness();
	await harness.manager.start(launchSpec, token());
	const stopping = harness.manager.shutdown();
	assert.equal(harness.child.stdinEnded, 1);
	harness.child.exit();
	await stopping;
	assert.equal(harness.child.killCalls, 0);
	assert.equal(harness.manager.isRunning, false);
});

test('process dispose is idempotent and only terminates its owned child once', async () => {
	const harness = processHarness();
	await harness.manager.start(launchSpec, token());
	harness.manager.dispose();
	harness.manager.dispose();
	assert.equal(harness.child.stdinEnded, 1);
	assert.equal(harness.child.killCalls, 1);
	assert.equal(harness.manager.isRunning, false);
});

test('child errors report a safe result while retaining ownership until shutdown', async () => {
	const harness = processHarness();
	const handle = await harness.manager.start(launchSpec, token());
	harness.child.fail(Object.assign(new Error('secret device name'), { name: 'SpawnError' }));
	assert.deepEqual(await handle.exit, { reason: 'error', errorType: 'SpawnError' });
	assert.doesNotMatch(JSON.stringify(await handle.exit), /secret device name/);
	assert.equal(harness.manager.isRunning, true);
	await harness.manager.shutdown();
	assert.equal(harness.child.stdinEnded, 1);
	assert.equal(harness.child.killCalls, 1);
	assert.equal(harness.manager.isRunning, false);
	assert.equal(harness.child.exitListeners.size, 0);
	assert.equal(harness.child.errorListeners.size, 0);
});

test('child error followed by natural exit releases ownership exactly once', async () => {
	const harness = processHarness();
	const handle = await harness.manager.start(launchSpec, token());
	harness.child.fail(new Error('private detail'));
	const stopping = harness.manager.shutdown();
	harness.child.exit(1);
	await stopping;
	assert.equal((await handle.exit).reason, 'error');
	assert.equal(harness.child.stdinEnded, 1);
	assert.equal(harness.child.killCalls, 0);
	assert.equal(harness.manager.isRunning, false);
	assert.equal(harness.child.exitListeners.size, 0);
	assert.equal(harness.child.errorListeners.size, 0);
});

test('child error and exit races do not double-release owned resources', async () => {
	const harness = processHarness();
	const handle = await harness.manager.start(launchSpec, token());
	harness.child.fail(new Error('private detail'));
	harness.child.exit(1);
	assert.equal((await handle.exit).reason, 'error');
	await harness.manager.shutdown();
	assert.equal(harness.child.stdinEnded, 0);
	assert.equal(harness.child.killCalls, 0);
	assert.equal(harness.manager.isRunning, false);
	assert.equal(harness.child.exitListeners.size, 0);
	assert.equal(harness.child.errorListeners.size, 0);
});

test('dispose after child error releases listeners and the owned child once', async () => {
	const harness = processHarness();
	await harness.manager.start(launchSpec, token());
	harness.child.fail(new Error('private detail'));
	harness.manager.dispose();
	harness.manager.dispose();
	assert.equal(harness.child.stdinEnded, 1);
	assert.equal(harness.child.killCalls, 1);
	assert.equal(harness.manager.isRunning, false);
	assert.equal(harness.child.exitListeners.size, 0);
	assert.equal(harness.child.errorListeners.size, 0);
});

test('dynamic child_process loader is not touched until spawn is invoked', () => {
	const calls = [];
	const spawn = createNodeCompanionSpawnFactory({
		load(moduleId) {
			calls.push(moduleId);
			return {};
		},
	});
	assert.deepEqual(calls, []);
	assert.throws(() => spawn('helper.exe', [], {
		stdio: ['pipe', 'ignore', 'ignore'],
		windowsHide: true,
	}), (error) => error.code === 'node-runtime-unavailable');
	assert.deepEqual(calls, ['node:child_process']);
});

test('readiness succeeds without parsing process output', async () => {
	const attempts = [];
	const probe = new CompanionReadinessProbe({
		connector: {
			connect: async (options) => { attempts.push(options); },
		},
	});
	await probe.waitUntilReady(new Promise(() => {}), new AbortController().signal);
	assert.equal(attempts.length, 1);
	assert.equal(attempts[0].host, '127.0.0.1');
	assert.equal(attempts[0].port, 43127);
});

test('readiness reports timeout without opening a connection after deadline', async () => {
	let attempts = 0;
	const probe = new CompanionReadinessProbe({
		connector: { connect: async () => { attempts += 1; } },
		totalTimeoutMs: 0,
	});
	await assert.rejects(
		probe.waitUntilReady(new Promise(() => {}), new AbortController().signal),
		(error) => error instanceof CompanionReadinessError && error.code === 'readiness-timeout',
	);
	assert.equal(attempts, 0);
});

test('readiness polls failed production sockets until timeout and disposes every attempt', async () => {
	let now = 0;
	let attempts = 0;
	let destroyCalls = 0;
	const activeTimers = new Set();
	const scheduler = {
		now: () => now,
		setTimeout(callback, delayMs) {
			const handle = { active: true };
			activeTimers.add(handle);
			queueMicrotask(() => {
				if (!handle.active) return;
				handle.active = false;
				activeTimers.delete(handle);
				now += delayMs;
				callback();
			});
			return handle;
		},
		clearTimeout(handle) {
			handle.active = false;
			activeTimers.delete(handle);
		},
	};
	const connector = createNodeTcpConnector({
		load() {
			return {
				createConnection() {
					attempts += 1;
					const listeners = new Map();
					const socket = {
						once(event, listener) {
							listeners.set(event, listener);
							if (event === 'error') queueMicrotask(listener);
						},
						off(event) { listeners.delete(event); },
						setTimeout() {},
						destroy() { destroyCalls += 1; },
					};
					return socket;
				},
			};
		},
	});
	const probe = new CompanionReadinessProbe({
		connector,
		scheduler,
		totalTimeoutMs: 10,
		attemptTimeoutMs: 2,
		pollIntervalMs: 5,
	});
	await assert.rejects(
		probe.waitUntilReady(new Promise(() => {}), new AbortController().signal),
		(error) => error.code === 'readiness-timeout',
	);
	assert.equal(attempts, 2);
	assert.equal(destroyCalls, attempts);
	assert.equal(activeTimers.size, 0);
});

test('readiness cancellation does not attempt a TCP connection', async () => {
	const abort = new AbortController();
	abort.abort();
	let attempts = 0;
	const probe = new CompanionReadinessProbe({
		connector: { connect: async () => { attempts += 1; } },
	});
	await assert.rejects(
		probe.waitUntilReady(new Promise(() => {}), abort.signal),
		(error) => error.code === 'cancelled',
	);
	assert.equal(attempts, 0);
});

test('readiness stops immediately when the child exits', async () => {
	const probe = new CompanionReadinessProbe({
		connector: { connect: () => new Promise(() => {}) },
	});
	await assert.rejects(
		probe.waitUntilReady(Promise.resolve({ reason: 'exit', code: 1, signal: null }), new AbortController().signal),
		(error) => error.code === 'child-exited',
	);
});

test('node TCP connector destroys its short-lived socket after connecting', async () => {
	const listeners = new Map();
	let destroyCalls = 0;
	const socket = {
		once(event, listener) {
			listeners.set(event, listener);
			if (event === 'connect') queueMicrotask(listener);
		},
		off(event) { listeners.delete(event); },
		setTimeout() {},
		destroy() { destroyCalls += 1; },
	};
	const connector = createNodeTcpConnector({
		load(moduleId) {
			assert.equal(moduleId, 'node:net');
			return { createConnection: () => socket };
		},
	});
	await connector.connect({
		host: '127.0.0.1',
		port: 43127,
		timeoutMs: 500,
		signal: new AbortController().signal,
	});
	assert.equal(destroyCalls, 1);
});

test('audio frame consumer calculates RMS without mutating or retaining PCM', () => {
	const pcm = new Uint8Array([0x00, 0x80, 0xff, 0x7f, 0x00, 0x00]);
	const original = pcm.slice();
	const consumer = new AudioFrameConsumer();
	consumer.consume({
		sequence: 0,
		offsetMs: 0,
		sampleCount: 3,
		durationMs: 0.1875,
		sampleRate: 16000,
		channels: 1,
		sampleFormat: 's16le',
		pcm,
	});
	assert.equal(consumer.state.frameCount, 1);
	assert.ok(consumer.state.rms > 0.8 && consumer.state.rms <= 1);
	assert.deepEqual(pcm, original);
	assert.equal(Object.hasOwn(consumer.state, 'pcm'), false);
});

test('RMS handles silence, full-scale signed samples, reset, and dispose', () => {
	assert.equal(calculatePcmS16LeRms(new Uint8Array([0, 0, 0, 0])), 0);
	assert.equal(calculatePcmS16LeRms(new Uint8Array([0, 128])), 1);
	const consumer = new AudioFrameConsumer();
	consumer.reset();
	consumer.dispose();
	assert.deepEqual(consumer.state, { frameCount: 0, rms: 0 });
});
