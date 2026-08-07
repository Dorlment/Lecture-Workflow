import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { build } from 'esbuild';

const bundle = await build({
	stdin: {
		contents: [
			"export * from './audio-capture-types.ts';",
			"export * from './audio-capture-probe.ts';",
		].join('\n'),
		resolveDir: process.cwd(),
		sourcefile: 'audio-capture-probe-test-entry.ts',
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	write: false,
});
const bundledSource = bundle.outputFiles[0]?.text;
if (!bundledSource) throw new Error('Failed to bundle audio capture probe.');
const {
	AudioCaptureProbe,
	buildAudioInputDeviceOptions,
	calculateRmsVolume,
	isLikelyLoopbackDeviceName,
} = await import(
	`data:text/javascript,${encodeURIComponent(bundledSource)}`
);

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function track(kind = 'audio', overrides = {}) {
	let endedListener = null;
	const item = {
		kind,
		label: overrides.label ?? (kind === 'audio' ? 'Default microphone' : 'Shared screen'),
		readyState: overrides.readyState ?? 'live',
		muted: overrides.muted ?? false,
		stopCalls: 0,
		getSettings: () => ({
			sampleRate: overrides.sampleRate ?? 48_000,
			channelCount: overrides.channelCount ?? 2,
		}),
		addEventListener: (type, listener) => {
			if (type === 'ended') endedListener = listener;
		},
		stop() {
			item.stopCalls += 1;
			item.readyState = 'ended';
		},
		emitEnded() {
			item.readyState = 'ended';
			endedListener?.();
		},
	};
	return item;
}

function stream(audioTracks = [track()], videoTracks = []) {
	const tracks = [...audioTracks, ...videoTracks];
	return {
		getAudioTracks: () => audioTracks,
		getVideoTracks: () => videoTracks,
		getTracks: () => tracks,
	};
}

function contextHarness(options = {}) {
	const analyser = {
		fftSize: 0,
		disconnectCalls: 0,
		getFloatTimeDomainData(samples) {
			if (options.sampleFails) throw new Error('private sample content');
			samples.fill(options.sample ?? 0.5);
		},
		disconnect() { analyser.disconnectCalls += 1; },
	};
	const source = {
		connectCalls: 0,
		disconnectCalls: 0,
		connect(node) {
			assert.equal(node, analyser);
			source.connectCalls += 1;
		},
		disconnect() { source.disconnectCalls += 1; },
	};
	const context = {
		state: options.state ?? 'running',
		sampleRate: 44_100,
		closeCalls: 0,
		resumeCalls: 0,
		createMediaStreamSource() {
			if (options.sourceFails) throw new Error('private stream detail');
			return source;
		},
		createAnalyser: () => analyser,
		async resume() {
			context.resumeCalls += 1;
			if (options.resumeFails) throw new Error('private resume detail');
			context.state = 'running';
		},
		async close() {
			context.closeCalls += 1;
			context.state = 'closed';
		},
	};
	return { analyser, context, source };
}

function probeHarness(options = {}) {
	const calls = { microphone: 0, system: 0 };
	let enumerateCalls = 0;
	let deviceChangeListener = null;
	let currentDevices = options.devices ?? [];
	const constraints = [];
	const frames = new Map();
	let nextFrame = 1;
	const contexts = [];
	const microphoneResult = options.microphoneResult ?? stream();
	const systemResult = options.systemResult ?? stream([track()], [track('video')]);
	const mediaDevices = options.mediaDevices === null ? null : {
		...(options.noMicrophone ? {} : {
			getUserMedia: (value) => {
				calls.microphone += 1;
				constraints.push(value);
				return Promise.resolve(options.microphoneFactory
					? options.microphoneFactory(value, calls.microphone)
					: microphoneResult);
			},
		}),
		...(options.noSystem ? {} : {
			getDisplayMedia: (value) => {
				calls.system += 1;
				constraints.push(value);
				return Promise.resolve(systemResult);
			},
		}),
		...(options.withDevices ? {
			enumerateDevices: () => Promise.resolve(currentDevices),
		} : {}),
		...options.mediaDevices,
	};
	const host = {
		isDesktopApp: () => options.desktop !== false,
		getMediaDevices: () => mediaDevices,
		...(options.withDevices ? {
			enumerateDevices: async () => {
				enumerateCalls += 1;
				if (options.enumerateFails) throw new Error('private device detail');
				return currentDevices;
			},
			subscribeDeviceChange: (listener) => {
				deviceChangeListener = listener;
				return () => { deviceChangeListener = null; };
			},
		} : {}),
		createAudioContext: () => {
			const result = contextHarness(options.contextOptions);
			contexts.push(result);
			return result.context;
		},
		requestAnimationFrame: (callback) => {
			const id = nextFrame++;
			frames.set(id, callback);
			return id;
		},
		cancelAnimationFrame: (id) => frames.delete(id),
	};
	const probe = new AudioCaptureProbe(host);
	return {
		calls,
		constraints,
		contexts,
		frames,
		mediaDevices,
		probe,
		get enumerateCalls() { return enumerateCalls; },
		emitDeviceChange() { deviceChangeListener?.(); },
		setDevices(devices) { currentDevices = devices; },
		runFrame(timestamp) {
			const [id, callback] = frames.entries().next().value ?? [];
			if (callback) {
				frames.delete(id);
				callback(timestamp);
			}
		},
	};
}

test('mobile and missing mediaDevices report both sources unsupported without requests', async () => {
	for (const options of [{ desktop: false }, { mediaDevices: null }]) {
		const harness = probeHarness(options);
		assert.deepEqual(harness.probe.getCapabilities(), {
			microphone: false,
			systemAudioApi: false,
			systemAudioStatus: 'api-unavailable',
			deviceEnumeration: false,
		});
		assert.equal(await harness.probe.start('microphone'), 'unsupported');
		assert.deepEqual(harness.calls, { microphone: 0, system: 0 });
	}
});

test('missing source-specific APIs are classified independently', async () => {
	const harness = probeHarness({ noMicrophone: true });
	assert.deepEqual(harness.probe.getCapabilities(), {
		microphone: false,
		systemAudioApi: true,
		systemAudioStatus: 'unverified',
		deviceEnumeration: false,
	});
	assert.equal(await harness.probe.start('microphone'), 'unsupported');
	assert.match(harness.probe.state.errorMessage, /不支持麦克风/);

	const noSystem = probeHarness({ noSystem: true });
	assert.equal(await noSystem.probe.start('system-audio'), 'unsupported');
	assert.match(noSystem.probe.state.errorMessage, /没有可用的直接系统音频捕获接口/);
});

test('microphone requests audio only and exposes safe track metadata', async () => {
	const audio = track('audio', { label: '课堂麦克风', sampleRate: 48_000, channelCount: 1 });
	const harness = probeHarness({ microphoneResult: stream([audio]) });
	assert.equal(await harness.probe.start('microphone'), 'active');
	assert.deepEqual(harness.constraints, [{ audio: true, video: false }]);
	assert.deepEqual({
		status: harness.probe.state.status,
		source: harness.probe.state.source,
		deviceLabel: harness.probe.state.deviceLabel,
		sampleRate: harness.probe.state.sampleRate,
		channelCount: harness.probe.state.channelCount,
		trackReadyState: harness.probe.state.trackReadyState,
		muted: harness.probe.state.muted,
		volume: harness.probe.state.volume,
		errorCode: harness.probe.state.errorCode,
		errorMessage: harness.probe.state.errorMessage,
	}, {
		status: 'active',
		source: 'microphone',
		deviceLabel: '课堂麦克风',
		sampleRate: 48_000,
		channelCount: 1,
		trackReadyState: 'live',
		muted: false,
		volume: 0,
		errorCode: null,
		errorMessage: null,
	});
});

test('system audio uses standard display media and never reads the video track', async () => {
	const audio = track('audio');
	const video = track('video');
	const media = stream([audio], [video]);
	const harness = probeHarness({ systemResult: media });
	assert.equal(await harness.probe.start('system-audio'), 'active');
	assert.deepEqual(harness.constraints, [{ audio: true, video: true }]);
	assert.equal(video.stopCalls, 0, 'the permission-coupled video track remains alive during the probe');
	assert.equal(harness.probe.state.source, 'system-audio');
	assert.equal(harness.probe.getCapabilities().systemAudioStatus, 'verified');
	await harness.probe.stop();
	assert.equal(audio.stopCalls, 1);
	assert.equal(video.stopCalls, 1);
});

test('microphone and system permission denials are safe and explicit', async () => {
	for (const source of ['microphone', 'system-audio']) {
		const denied = { name: 'NotAllowedError', message: 'private operating-system detail' };
		const harness = probeHarness({
			mediaDevices: {
				getUserMedia: () => Promise.reject(denied),
				getDisplayMedia: () => Promise.reject(denied),
			},
		});
		assert.equal(await harness.probe.start(source), 'permission-denied');
		assert.equal(harness.probe.state.status, 'permission-denied');
		assert.doesNotMatch(harness.probe.state.errorMessage, /private|operating-system/);
	}
});

test('getDisplayMedia presence is unverified until a request actually succeeds', () => {
	const harness = probeHarness();
	assert.equal(harness.probe.getCapabilities().systemAudioApi, true);
	assert.equal(harness.probe.getCapabilities().systemAudioStatus, 'unverified');
	assert.equal(harness.calls.system, 0);
});

test('NotSupportedError marks the host unsupported and blocks repeat requests for this run', async () => {
	let requestCount = 0;
	const harness = probeHarness({
		mediaDevices: {
			getDisplayMedia: () => {
				requestCount += 1;
				return Promise.reject({ name: 'NotSupportedError', message: 'private host detail' });
			},
		},
	});
	assert.equal(await harness.probe.start('system-audio'), 'unsupported');
	assert.equal(harness.probe.getCapabilities().systemAudioStatus, 'host-unsupported');
	assert.equal(harness.probe.state.errorCode, 'host-unsupported');
	assert.match(harness.probe.state.errorMessage, /不是权限问题/);
	assert.doesNotMatch(harness.probe.state.errorMessage, /重试|private/);
	assert.equal(await harness.probe.start('system-audio'), 'unsupported');
	assert.equal(requestCount, 1);
});

test('NotAllowedError remains distinct from an unsupported host', async () => {
	const harness = probeHarness({
		mediaDevices: {
			getDisplayMedia: () => Promise.reject({ name: 'NotAllowedError' }),
		},
	});
	assert.equal(await harness.probe.start('system-audio'), 'permission-denied');
	assert.equal(harness.probe.getCapabilities().systemAudioStatus, 'permission-denied');
	assert.match(harness.probe.state.errorMessage, /拒绝或取消/);
	assert.doesNotMatch(harness.probe.state.errorMessage, /宿主不支持|不是权限问题/);
});

test('other system-audio request errors remain temporary and do not permanently disable testing', async () => {
	let requestCount = 0;
	const harness = probeHarness({
		mediaDevices: {
			getDisplayMedia: () => {
				requestCount += 1;
				return Promise.reject({ name: 'AbortError' });
			},
		},
	});
	assert.equal(await harness.probe.start('system-audio'), 'error');
	assert.equal(harness.probe.getCapabilities().systemAudioStatus, 'temporary-failure');
	assert.equal(await harness.probe.start('system-audio'), 'error');
	assert.equal(requestCount, 2);
});

test('a stream without a live audio track is rejected and every returned track stops', async () => {
	const endedAudio = track('audio', { readyState: 'ended' });
	const video = track('video');
	const harness = probeHarness({ systemResult: stream([endedAudio], [video]) });
	assert.equal(await harness.probe.start('system-audio'), 'no-audio-track');
	assert.equal(endedAudio.stopCalls, 1);
	assert.equal(video.stopCalls, 1);
	assert.match(harness.probe.state.errorMessage, /没有提供系统音频轨道/);
	assert.equal(harness.probe.getCapabilities().systemAudioStatus, 'no-audio-track');
});

test('device enumeration keeps only audio inputs and safely labels unnamed devices', async () => {
	const harness = probeHarness({
		withDevices: true,
		devices: [
			{ kind: 'videoinput', deviceId: 'camera-secret', label: 'Camera' },
			{ kind: 'audiooutput', deviceId: 'speaker-secret', label: 'Speaker' },
			{ kind: 'audioinput', deviceId: 'default', label: 'Default' },
			{ kind: 'audioinput', deviceId: 'mic-a', label: '' },
			{ kind: 'audioinput', deviceId: 'mic-b', label: 'USB 麦克风' },
		],
	});
	assert.equal(await harness.probe.refreshAudioInputDevices(), 'ready');
	assert.deepEqual(harness.probe.state.inputDevices.map((device) => ({
		label: device.label,
		hasLabel: device.hasLabel,
	})), [
		{ label: '系统默认输入设备 · Default', hasLabel: true },
		{ label: '音频输入设备 1', hasLabel: false },
		{ label: 'USB 麦克风', hasLabel: true },
	]);
});

test('a later refresh exposes labels made available after microphone permission', async () => {
	const harness = probeHarness({
		withDevices: true,
		devices: [{ kind: 'audioinput', deviceId: 'mic-a', label: '' }],
	});
	await harness.probe.refreshAudioInputDevices();
	assert.equal(harness.probe.state.inputDevices[1].label, '音频输入设备 1');
	harness.setDevices([{ kind: 'audioinput', deviceId: 'mic-a', label: '已授权麦克风' }]);
	await harness.probe.refreshAudioInputDevices();
	assert.equal(harness.probe.state.inputDevices[1].label, '已授权麦克风');
});

test('default and selected input devices use the correct getUserMedia constraints', async () => {
	const defaultHarness = probeHarness();
	await defaultHarness.probe.start('microphone');
	assert.deepEqual(defaultHarness.constraints[0], { audio: true, video: false });

	const selectedHarness = probeHarness({
		withDevices: true,
		devices: [{ kind: 'audioinput', deviceId: 'selected-input', label: 'Selected microphone' }],
	});
	await selectedHarness.probe.refreshAudioInputDevices();
	assert.equal(await selectedHarness.probe.selectInputDevice('selected-input'), true);
	await selectedHarness.probe.start('microphone');
	assert.deepEqual(selectedHarness.constraints[0], {
		audio: { deviceId: { exact: 'selected-input' } },
		video: false,
	});
});

test('loopback names are hints only and never change the selected input', async () => {
	for (const label of [
		'立体声混音', 'Stereo Mix', 'What U Hear', 'Wave Out Mix',
		'CABLE Output', 'VB-CABLE', 'BlackHole 2ch', 'Loopback Audio',
	]) {
		assert.equal(isLikelyLoopbackDeviceName(label), true, label);
	}
	assert.equal(isLikelyLoopbackDeviceName('Built-in Microphone'), false);
	const options = buildAudioInputDeviceOptions([
		{ kind: 'audioinput', deviceId: 'default', label: 'Stereo Mix' },
		{ kind: 'audioinput', deviceId: 'loop-device', label: 'sTeReO mIx' },
	]);
	assert.equal(options[0].isLoopbackCandidate, true);
	assert.equal(options[1].isLoopbackCandidate, true);
	const harness = probeHarness({ withDevices: true, devices: [
		{ kind: 'audioinput', deviceId: 'loop-device', label: 'Stereo Mix' },
	] });
	await harness.probe.refreshAudioInputDevices();
	assert.equal(harness.probe.state.selectedInputDeviceId, null);
	assert.equal(harness.calls.microphone, 0);
});

test('selecting another device releases the active stream before the next request', async () => {
	const firstTrack = track('audio', { label: 'First' });
	const secondTrack = track('audio', { label: 'Second' });
	const harness = probeHarness({
		withDevices: true,
		devices: [
			{ kind: 'audioinput', deviceId: 'first', label: 'First' },
			{ kind: 'audioinput', deviceId: 'second', label: 'Second' },
		],
		microphoneFactory: (_constraints, count) =>
			count === 1 ? stream([firstTrack]) : stream([secondTrack]),
	});
	await harness.probe.refreshAudioInputDevices();
	await harness.probe.selectInputDevice('first');
	await harness.probe.start('microphone');
	await harness.probe.selectInputDevice('second');
	assert.equal(firstTrack.stopCalls, 1);
	assert.notEqual(harness.probe.state.status, 'active');
	await harness.probe.start('microphone');
	assert.equal(harness.calls.microphone, 2);
	assert.equal(harness.probe.state.deviceLabel, 'Second');
});

test('devicechange refreshes the list without selecting or opening a stream', async () => {
	const harness = probeHarness({
		withDevices: true,
		devices: [{ kind: 'audioinput', deviceId: 'one', label: 'One' }],
	});
	await harness.probe.refreshAudioInputDevices();
	const before = harness.enumerateCalls;
	harness.setDevices([{ kind: 'audioinput', deviceId: 'two', label: 'Two' }]);
	harness.emitDeviceChange();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(harness.enumerateCalls, before + 1);
	assert.equal(harness.probe.state.selectedInputDeviceId, null);
	assert.deepEqual(harness.calls, { microphone: 0, system: 0 });
});

test('removing the selected active device stops it instead of switching automatically', async () => {
	const activeTrack = track('audio', { label: 'Removable' });
	const harness = probeHarness({
		withDevices: true,
		devices: [{ kind: 'audioinput', deviceId: 'removable', label: 'Removable' }],
		microphoneResult: stream([activeTrack]),
	});
	await harness.probe.refreshAudioInputDevices();
	await harness.probe.selectInputDevice('removable');
	await harness.probe.start('microphone');
	await new Promise((resolve) => setImmediate(resolve));
	harness.setDevices([]);
	harness.emitDeviceChange();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(activeTrack.stopCalls, 1);
	assert.equal(harness.probe.state.status, 'ended');
	assert.equal(harness.probe.state.errorCode, 'device-unavailable');
	assert.equal(harness.probe.state.selectedInputDeviceId, null);
	assert.equal(harness.calls.microphone, 1);
});

test('dispose removes the devicechange subscription and prevents later enumeration', async () => {
	const harness = probeHarness({ withDevices: true, devices: [] });
	await harness.probe.refreshAudioInputDevices();
	const before = harness.enumerateCalls;
	harness.probe.dispose();
	harness.emitDeviceChange();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(harness.enumerateCalls, before);
});

test('RMS volume updates are throttled and retained only as one scalar', async () => {
	const harness = probeHarness({ contextOptions: { sample: 0.5 } });
	const volumes = [];
	harness.probe.subscribe((state) => volumes.push(state.volume));
	await harness.probe.start('microphone');
	harness.runFrame(0);
	harness.runFrame(20);
	harness.runFrame(67);
	assert.equal(harness.probe.state.volume, 0.5);
	assert.equal(volumes.filter((value) => value === 0.5).length, 2);
	assert.equal(calculateRmsVolume(Float32Array.from([1, -1])), 1);
	assert.equal(calculateRmsVolume(new Float32Array()), 0);
});

test('rapid repeated permission clicks create only one MediaStream request', async () => {
	const pending = deferred();
	const harness = probeHarness({
		mediaDevices: {
			getUserMedia: () => {
				harness.calls.microphone += 1;
				return pending.promise;
			},
		},
	});
	const first = harness.probe.start('microphone');
	assert.equal(await harness.probe.start('microphone'), 'busy');
	assert.equal(harness.calls.microphone, 1);
	pending.resolve(stream());
	assert.equal(await first, 'active');
});

test('stopping a pending request makes its late stream stale and releases all tracks', async () => {
	const pending = deferred();
	const lateAudio = track();
	const lateVideo = track('video');
	const harness = probeHarness({
		mediaDevices: { getDisplayMedia: () => pending.promise },
	});
	const request = harness.probe.start('system-audio');
	await harness.probe.stop();
	pending.resolve(stream([lateAudio], [lateVideo]));
	assert.equal(await request, 'stale');
	assert.equal(lateAudio.stopCalls, 1);
	assert.equal(lateVideo.stopCalls, 1);
	assert.equal(harness.probe.state.status, 'stopped');
});

test('switching active sources stops the old stream before opening the new one', async () => {
	const oldAudio = track();
	const newAudio = track();
	const harness = probeHarness({
		microphoneResult: stream([oldAudio]),
		systemResult: stream([newAudio], [track('video')]),
	});
	await harness.probe.start('microphone');
	await harness.probe.start('system-audio');
	assert.equal(oldAudio.stopCalls, 1);
	assert.equal(harness.probe.state.source, 'system-audio');
	assert.deepEqual(harness.calls, { microphone: 1, system: 1 });
});

test('stop releases tracks, animation work, analyser nodes, and AudioContext', async () => {
	const audio = track();
	const video = track('video');
	const harness = probeHarness({ systemResult: stream([audio], [video]) });
	await harness.probe.start('system-audio');
	assert.equal(harness.frames.size, 1);
	await harness.probe.stop();
	assert.equal(audio.stopCalls, 1);
	assert.equal(video.stopCalls, 1);
	assert.equal(harness.frames.size, 0);
	assert.equal(harness.contexts[0].context.closeCalls, 1);
	assert.equal(harness.contexts[0].source.disconnectCalls, 1);
	assert.equal(harness.contexts[0].analyser.disconnectCalls, 1);
	assert.equal(harness.probe.state.status, 'stopped');
});

test('natural audio track ending transitions to ended and releases resources', async () => {
	const audio = track();
	const video = track('video');
	const harness = probeHarness({ systemResult: stream([audio], [video]) });
	await harness.probe.start('system-audio');
	audio.emitEnded();
	await Promise.resolve();
	assert.equal(harness.probe.state.status, 'ended');
	assert.equal(video.stopCalls, 1);
	assert.equal(harness.contexts[0].context.closeCalls, 1);
});

test('an analyser read failure releases media without leaking sample details', async () => {
	const audio = track();
	const harness = probeHarness({
		microphoneResult: stream([audio]),
		contextOptions: { sampleFails: true },
	});
	await harness.probe.start('microphone');
	harness.runFrame(0);
	await Promise.resolve();
	assert.equal(harness.probe.state.status, 'error');
	assert.equal(audio.stopCalls, 1);
	assert.doesNotMatch(harness.probe.state.errorMessage, /private|sample content/);
});

test('AudioContext setup failure stops the stream and exposes no private error', async () => {
	const audio = track();
	const harness = probeHarness({
		microphoneResult: stream([audio]),
		contextOptions: { sourceFails: true },
	});
	assert.equal(await harness.probe.start('microphone'), 'error');
	assert.equal(audio.stopCalls, 1);
	assert.equal(harness.contexts[0].context.closeCalls, 1);
	assert.doesNotMatch(harness.probe.state.errorMessage, /private|stream detail/);
});

test('a suspended AudioContext is resumed and a resume failure releases the stream', async () => {
	const success = probeHarness({ contextOptions: { state: 'suspended' } });
	assert.equal(await success.probe.start('microphone'), 'active');
	await Promise.resolve();
	assert.equal(success.contexts[0].context.resumeCalls, 1);

	const audio = track();
	const failure = probeHarness({
		microphoneResult: stream([audio]),
		contextOptions: { state: 'suspended', resumeFails: true },
	});
	assert.equal(await failure.probe.start('microphone'), 'active');
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(failure.probe.state.status, 'error');
	assert.equal(audio.stopCalls, 1);
	assert.doesNotMatch(failure.probe.state.errorMessage, /private|resume detail/);
});

test('dispose invalidates pending requests and never emits retained data', async () => {
	const pending = deferred();
	const audio = track();
	const harness = probeHarness({ mediaDevices: { getUserMedia: () => pending.promise } });
	const request = harness.probe.start('microphone');
	harness.probe.dispose();
	pending.resolve(stream([audio]));
	assert.equal(await request, 'stale');
	assert.equal(audio.stopCalls, 1);
	assert.equal(harness.probe.state.status, 'idle');
});

test('production audio probe has no persistence, network, recording, or logging surface', async () => {
	const source = await readFile('audio-capture-probe.ts', 'utf8');
	assert.doesNotMatch(source, /MediaRecorder|createBinary|vault\.|process\(|requestUrl|fetch\(|WebSocket|base64|toDataURL/i);
	assert.doesNotMatch(source, /console\.|readText|readHTML|loadData|saveData|localStorage|sessionStorage/);
	assert.doesNotMatch(source, /JSON\.stringify\([^)]*device|console\.[^(]+\([^)]*device/i);
	assert.doesNotMatch(source, /child_process|node:fs|desktopCapturer|ipcRenderer|ipcMain/);
	assert.doesNotMatch(source, /^const .*navigator|^const .*window|^const .*AudioContext/m);
});
