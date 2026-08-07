import type {
	AudioCaptureCapabilities,
	AudioCaptureDeviceInfo,
	AudioCaptureMediaDevices,
	AudioCaptureProbeHost,
	AudioCaptureProbeStartResult,
	AudioCaptureProbeState,
	AudioCaptureSource,
	AudioInputDeviceListStatus,
	AudioInputDeviceOption,
	SystemAudioCapabilityStatus,
} from './audio-capture-types';

const VOLUME_UPDATE_INTERVAL_MS = 67;
const ANALYSER_FFT_SIZE = 256;
const DEFAULT_INPUT_LABEL = '系统默认输入设备';
const LOOPBACK_NAME_PATTERN = /立体声混音|stereo\s*mix|what\s*u\s*hear|wave\s*out\s*mix|cable\s*output|vb-?cable|blackhole|loopback/i;

export class AudioCaptureProbe {
	private currentState: AudioCaptureProbeState;
	private readonly listeners = new Set<(state: AudioCaptureProbeState) => void>();
	private stream: MediaStream | null = null;
	private audioContext: AudioContext | null = null;
	private sourceNode: MediaStreamAudioSourceNode | null = null;
	private analyser: AnalyserNode | null = null;
	private samples: Float32Array<ArrayBuffer> | null = null;
	private animationFrameId: number | null = null;
	private lastVolumeUpdateAt = Number.NEGATIVE_INFINITY;
	private requestVersion = 0;
	private deviceRefreshVersion = 0;
	private systemAudioStatus: SystemAudioCapabilityStatus;
	private unsubscribeDeviceChange: (() => void) | null = null;
	private disposed = false;

	constructor(private readonly host: AudioCaptureProbeHost) {
		this.systemAudioStatus = this.detectInitialSystemAudioStatus();
		this.currentState = emptyAudioCaptureProbeState();
		this.subscribeToDeviceChanges();
	}

	get state(): AudioCaptureProbeState {
		return {
			...this.currentState,
			inputDevices: this.currentState.inputDevices.map((device) => ({ ...device })),
		};
	}

	getCapabilities(): AudioCaptureCapabilities {
		const isDesktop = this.host.isDesktopApp();
		const mediaDevices = isDesktop ? this.safeMediaDevices() : null;
		const systemAudioApi = typeof mediaDevices?.getDisplayMedia === 'function';
		return {
			microphone: typeof mediaDevices?.getUserMedia === 'function',
			systemAudioApi,
			systemAudioStatus: isDesktop && systemAudioApi
				? this.systemAudioStatus
				: 'api-unavailable',
			deviceEnumeration: isDesktop
				&& typeof mediaDevices?.enumerateDevices === 'function'
				&& typeof this.host.enumerateDevices === 'function',
		};
	}

	async refreshAudioInputDevices(): Promise<AudioInputDeviceListStatus> {
		if (this.disposed
			|| !this.host.isDesktopApp()
			|| !this.getCapabilities().deviceEnumeration
			|| typeof this.host.enumerateDevices !== 'function') {
			this.setState({
				...this.currentState,
				inputDevices: defaultInputDevices(),
				selectedInputDeviceId: null,
				inputDeviceListStatus: 'unsupported',
				inputDeviceListMessage: '当前环境不支持枚举音频输入设备。',
			});
			return 'unsupported';
		}

		const refreshVersion = ++this.deviceRefreshVersion;
		this.setState({
			...this.currentState,
			inputDeviceListStatus: 'loading',
			inputDeviceListMessage: null,
		});
		let rawDevices: readonly AudioCaptureDeviceInfo[];
		try {
			rawDevices = await this.host.enumerateDevices();
		} catch {
			if (!this.isCurrentDeviceRefresh(refreshVersion)) {
				return this.currentState.inputDeviceListStatus;
			}
			this.setState({
				...this.currentState,
				inputDeviceListStatus: 'error',
				inputDeviceListMessage: '无法刷新音频输入设备列表。',
			});
			return 'error';
		}

		if (!this.isCurrentDeviceRefresh(refreshVersion)) {
			return this.currentState.inputDeviceListStatus;
		}
		const inputDevices = buildAudioInputDeviceOptions(rawDevices);
		const selectedId = this.currentState.selectedInputDeviceId;
		const selectedMissing = selectedId !== null
			&& !inputDevices.some((device) => device.id === selectedId);
		if (selectedMissing
			&& this.currentState.source === 'microphone'
			&& (this.currentState.status === 'active'
				|| this.currentState.status === 'requesting-permission'
				|| this.currentState.status === 'stopping')) {
			await this.stop();
		}
		if (!this.isCurrentDeviceRefresh(refreshVersion)) {
			return this.currentState.inputDeviceListStatus;
		}

		const missingMessage = selectedMissing
			? '当前选择的音频输入设备已断开，音频测试已停止。'
			: null;
		this.setState({
			...this.currentState,
			...(selectedMissing && this.currentState.source === 'microphone'
				? {
					status: 'ended' as const,
					errorCode: 'device-unavailable' as const,
					errorMessage: missingMessage,
				}
				: {}),
			inputDevices,
			selectedInputDeviceId: selectedMissing ? null : selectedId,
			inputDeviceListStatus: 'ready',
			inputDeviceListMessage: missingMessage,
		});
		return 'ready';
	}

	async selectInputDevice(deviceId: string | null): Promise<boolean> {
		if (this.disposed) {
			return false;
		}
		const validSelection = deviceId === null
			|| this.currentState.inputDevices.some((device) => device.id === deviceId);
		if (!validSelection) {
			return false;
		}
		if (deviceId === this.currentState.selectedInputDeviceId) {
			return true;
		}
		if (this.currentState.source === 'microphone'
			&& (this.currentState.status === 'active'
				|| this.currentState.status === 'requesting-permission'
				|| this.currentState.status === 'stopping')) {
			await this.stop();
		}
		if (this.disposed) {
			return false;
		}
		this.setState({
			...this.currentState,
			selectedInputDeviceId: deviceId,
			inputDeviceListMessage: null,
		});
		return true;
	}

	async start(source: AudioCaptureSource): Promise<AudioCaptureProbeStartResult> {
		if (this.disposed) {
			return 'stale';
		}
		if (source === 'system-audio' && this.systemAudioStatus === 'host-unsupported') {
			this.setFailure(
				source,
				'unsupported',
				'host-unsupported',
				hostUnsupportedMessage(),
			);
			return 'unsupported';
		}
		if (this.currentState.status === 'requesting-permission'
			|| this.currentState.status === 'stopping') {
			return 'busy';
		}

		const requestVersion = ++this.requestVersion;
		if (this.hasRuntimeResources()) {
			this.setState({ ...this.currentState, status: 'stopping', volume: 0 });
			await this.releaseRuntimeResources();
			if (!this.isCurrentRequest(requestVersion)) {
				return 'stale';
			}
		}
		const mediaDevices = this.safeMediaDevices();
		const request = source === 'microphone'
			? mediaDevices?.getUserMedia
			: mediaDevices?.getDisplayMedia;
		if (!this.host.isDesktopApp() || typeof request !== 'function') {
			if (source === 'system-audio') {
				this.systemAudioStatus = 'api-unavailable';
			}
			this.setFailure(
				source,
				'unsupported',
				'unsupported',
				unsupportedMessage(source),
			);
			return 'unsupported';
		}

		if (source === 'system-audio') {
			this.systemAudioStatus = 'requesting';
		}
		this.setState({
			...this.emptyRuntimeState(),
			status: 'requesting-permission',
			source,
		});

		let stream: MediaStream;
		try {
			const pendingStream = source === 'microphone'
				? request.call(mediaDevices, microphoneConstraints(
					this.currentState.selectedInputDeviceId,
				))
				: request.call(mediaDevices, { audio: true, video: true });
			stream = await pendingStream;
		} catch (error) {
			if (!this.isCurrentRequest(requestVersion)) {
				return 'stale';
			}
			if (source === 'system-audio' && isNotSupported(error)) {
				this.systemAudioStatus = 'host-unsupported';
				this.setFailure(
					source,
					'unsupported',
					'host-unsupported',
					hostUnsupportedMessage(),
				);
				return 'unsupported';
			}
			if (isPermissionDenied(error)) {
				if (source === 'system-audio') {
					this.systemAudioStatus = 'permission-denied';
				}
				this.setFailure(
					source,
					'permission-denied',
					'permission-denied',
					permissionDeniedMessage(source),
				);
				return 'permission-denied';
			}
			if (source === 'system-audio') {
				this.systemAudioStatus = 'temporary-failure';
			}
			this.setFailure(
				source,
				'error',
				'request-failed',
				requestFailedMessage(source, safeErrorName(error)),
			);
			return 'error';
		}

		if (!this.isCurrentRequest(requestVersion)) {
			stopStream(stream);
			return 'stale';
		}

		const audioTrack = stream.getAudioTracks().find((track) => track.readyState === 'live');
		if (!audioTrack) {
			stopStream(stream);
			if (source === 'system-audio') {
				this.systemAudioStatus = 'no-audio-track';
			}
			this.setFailure(
				source,
				'no-audio-track',
				'no-audio-track',
				noAudioTrackMessage(source),
			);
			return 'no-audio-track';
		}
		if (source === 'system-audio') {
			this.systemAudioStatus = 'verified';
		}

		let audioContext: AudioContext | null = null;
		let sourceNode: MediaStreamAudioSourceNode | null = null;
		let analyser: AnalyserNode | null = null;
		try {
			audioContext = this.host.createAudioContext();
			sourceNode = audioContext.createMediaStreamSource(stream);
			analyser = audioContext.createAnalyser();
			analyser.fftSize = ANALYSER_FFT_SIZE;
			sourceNode.connect(analyser);
		} catch {
			stopStream(stream);
			disconnectNode(sourceNode);
			disconnectNode(analyser);
			if (audioContext) {
				void closeAudioContext(audioContext);
			}
			this.setFailure(
				source,
				'error',
				'audio-context-failed',
				'无法初始化实时音量检测。音频流已停止。',
			);
			return 'error';
		}

		if (!this.isCurrentRequest(requestVersion)) {
			stopStream(stream);
			disconnectNode(sourceNode);
			disconnectNode(analyser);
			void closeAudioContext(audioContext);
			return 'stale';
		}

		this.stream = stream;
		this.audioContext = audioContext;
		this.sourceNode = sourceNode;
		this.analyser = analyser;
		try {
			this.samples = new Float32Array(analyser.fftSize);
			const settings = audioTrack.getSettings();
			this.setState({
				...this.emptyRuntimeState(),
				status: 'active',
				source,
				deviceLabel: audioTrack.label.trim() || null,
				sampleRate: finitePositive(settings.sampleRate)
					?? finitePositive(audioContext.sampleRate),
				channelCount: finitePositive(settings.channelCount),
				trackReadyState: audioTrack.readyState,
				muted: audioTrack.muted,
			});
			if (source === 'microphone') {
				this.refreshAudioInputDevices().catch(() => undefined);
			}
			if (audioContext.state === 'suspended') {
				void audioContext.resume().catch(() => {
					if (!this.isCurrentRequest(requestVersion)) {
						return;
					}
					this.requestVersion += 1;
					void this.releaseRuntimeResources();
					this.setFailure(
						source,
						'error',
						'audio-context-failed',
						'实时音量检测无法启动。音频流已停止。',
					);
				});
			}
			audioTrack.addEventListener('ended', () => {
				if (this.isCurrentRequest(requestVersion)) {
					this.handleTrackEnded(source);
				}
			}, { once: true });
			this.scheduleVolumeUpdate(requestVersion);
		} catch {
			this.requestVersion += 1;
			await this.releaseRuntimeResources();
			this.setFailure(
				source,
				'error',
				'audio-context-failed',
				'无法启动实时音量检测。音频流已停止。',
			);
			return 'error';
		}
		return 'active';
	}

	async stop(): Promise<void> {
		const status = this.currentState.status;
		if (status === 'idle' || status === 'stopped') {
			return;
		}
		const requestVersion = ++this.requestVersion;
		const source = this.currentState.source;
		this.setState({ ...this.currentState, status: 'stopping', volume: 0 });
		await this.releaseRuntimeResources();
		if (requestVersion === this.requestVersion && !this.disposed) {
			this.setState({
				...this.emptyRuntimeState(),
				status: 'stopped',
				source,
			});
		}
	}

	subscribe(listener: (state: AudioCaptureProbeState) => void): () => void {
		this.listeners.add(listener);
		listener(this.state);
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		this.disposed = true;
		this.requestVersion += 1;
		this.deviceRefreshVersion += 1;
		this.unsubscribeDeviceChange?.();
		this.unsubscribeDeviceChange = null;
		void this.releaseRuntimeResources();
		this.currentState = emptyAudioCaptureProbeState();
		this.listeners.clear();
	}

	private detectInitialSystemAudioStatus(): SystemAudioCapabilityStatus {
		if (!this.host.isDesktopApp()) {
			return 'api-unavailable';
		}
		return typeof this.safeMediaDevices()?.getDisplayMedia === 'function'
			? 'unverified'
			: 'api-unavailable';
	}

	private subscribeToDeviceChanges(): void {
		if (!this.host.isDesktopApp() || typeof this.host.subscribeDeviceChange !== 'function') {
			return;
		}
		try {
			this.unsubscribeDeviceChange = this.host.subscribeDeviceChange(() => {
				this.refreshAudioInputDevices().catch(() => undefined);
			});
		} catch {
			this.unsubscribeDeviceChange = null;
		}
	}

	private safeMediaDevices(): AudioCaptureMediaDevices | null {
		try {
			return this.host.getMediaDevices();
		} catch {
			return null;
		}
	}

	private isCurrentRequest(requestVersion: number): boolean {
		return !this.disposed && requestVersion === this.requestVersion;
	}

	private isCurrentDeviceRefresh(refreshVersion: number): boolean {
		return !this.disposed && refreshVersion === this.deviceRefreshVersion;
	}

	private hasRuntimeResources(): boolean {
		return this.stream !== null
			|| this.audioContext !== null
			|| this.sourceNode !== null
			|| this.analyser !== null
			|| this.animationFrameId !== null;
	}

	private emptyRuntimeState(): AudioCaptureProbeState {
		return {
			...emptyAudioCaptureProbeState(),
			inputDevices: this.currentState.inputDevices,
			selectedInputDeviceId: this.currentState.selectedInputDeviceId,
			inputDeviceListStatus: this.currentState.inputDeviceListStatus,
			inputDeviceListMessage: this.currentState.inputDeviceListMessage,
		};
	}

	private scheduleVolumeUpdate(requestVersion: number): void {
		this.animationFrameId = this.host.requestAnimationFrame((timestamp) => {
			this.animationFrameId = null;
			if (!this.isCurrentRequest(requestVersion)
				|| this.currentState.status !== 'active'
				|| !this.analyser
				|| !this.samples) {
				return;
			}
			try {
				if (timestamp - this.lastVolumeUpdateAt >= VOLUME_UPDATE_INTERVAL_MS) {
					this.analyser.getFloatTimeDomainData(this.samples);
					this.lastVolumeUpdateAt = timestamp;
					this.setState({
						...this.currentState,
						volume: calculateRmsVolume(this.samples),
						trackReadyState: this.stream?.getAudioTracks()[0]?.readyState ?? null,
						muted: this.stream?.getAudioTracks()[0]?.muted ?? null,
					});
				}
			} catch {
				this.requestVersion += 1;
				void this.releaseRuntimeResources();
				this.setFailure(
					this.currentState.source ?? 'microphone',
					'error',
					'audio-context-failed',
					'实时音量检测已中止。音频流已停止。',
				);
				return;
			}
			this.scheduleVolumeUpdate(requestVersion);
		});
	}

	private handleTrackEnded(source: AudioCaptureSource): void {
		this.requestVersion += 1;
		void this.releaseRuntimeResources();
		this.setState({
			...this.emptyRuntimeState(),
			status: 'ended',
			source,
			errorMessage: '音频来源已结束，设备资源已释放。',
		});
	}

	private async releaseRuntimeResources(): Promise<void> {
		if (this.animationFrameId !== null) {
			this.host.cancelAnimationFrame(this.animationFrameId);
			this.animationFrameId = null;
		}
		this.lastVolumeUpdateAt = Number.NEGATIVE_INFINITY;
		disconnectNode(this.sourceNode);
		disconnectNode(this.analyser);
		this.sourceNode = null;
		this.analyser = null;
		this.samples = null;
		const stream = this.stream;
		this.stream = null;
		if (stream) {
			stopStream(stream);
		}
		const audioContext = this.audioContext;
		this.audioContext = null;
		if (audioContext) {
			await closeAudioContext(audioContext);
		}
	}

	private setFailure(
		source: AudioCaptureSource,
		status: AudioCaptureProbeState['status'],
		errorCode: NonNullable<AudioCaptureProbeState['errorCode']>,
		errorMessage: string,
	): void {
		this.setState({
			...this.emptyRuntimeState(),
			status,
			source,
			errorCode,
			errorMessage,
		});
	}

	private setState(state: AudioCaptureProbeState): void {
		this.currentState = state;
		const snapshot = this.state;
		for (const listener of this.listeners) {
			try {
				listener(snapshot);
			} catch {
				// A detached UI listener must not break media cleanup or other listeners.
			}
		}
	}
}

export function createBrowserAudioCaptureProbe(isDesktopApp: () => boolean): AudioCaptureProbe {
	const getBrowserMediaDevices = (): MediaDevices | null =>
		typeof navigator === 'undefined' ? null : navigator.mediaDevices;
	return new AudioCaptureProbe({
		isDesktopApp,
		getMediaDevices: getBrowserMediaDevices,
		enumerateDevices: async () => {
			const mediaDevices = getBrowserMediaDevices();
			if (!mediaDevices || typeof mediaDevices.enumerateDevices !== 'function') {
				throw new Error('Device enumeration unavailable.');
			}
			return mediaDevices.enumerateDevices();
		},
		subscribeDeviceChange: (listener) => {
			const mediaDevices = getBrowserMediaDevices();
			if (!mediaDevices || typeof mediaDevices.addEventListener !== 'function') {
				return () => undefined;
			}
			mediaDevices.addEventListener('devicechange', listener);
			return () => mediaDevices.removeEventListener('devicechange', listener);
		},
		createAudioContext: () => {
			if (typeof window === 'undefined' || typeof window.AudioContext !== 'function') {
				throw new Error('AudioContext unavailable.');
			}
			return new window.AudioContext();
		},
		requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
		cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle),
	});
}

export function calculateRmsVolume(samples: Float32Array): number {
	if (samples.length === 0) {
		return 0;
	}
	let sumSquares = 0;
	for (const sample of samples) {
		sumSquares += sample * sample;
	}
	return Math.min(1, Math.sqrt(sumSquares / samples.length));
}

export function isLikelyLoopbackDeviceName(label: string): boolean {
	return label.trim().length > 0 && LOOPBACK_NAME_PATTERN.test(label);
}

export function buildAudioInputDeviceOptions(
	devices: readonly AudioCaptureDeviceInfo[],
): AudioInputDeviceOption[] {
	const options = defaultInputDevices();
	const seenIds = new Set<string>();
	let unnamedIndex = 0;
	for (const device of devices) {
		if (device.kind !== 'audioinput' || !device.deviceId) {
			continue;
		}
		const trimmedLabel = device.label.trim();
		if (device.deviceId === 'default') {
			if (trimmedLabel) {
				options[0] = {
					id: null,
					label: `${DEFAULT_INPUT_LABEL} · ${trimmedLabel}`,
					isDefault: true,
					isLoopbackCandidate: isLikelyLoopbackDeviceName(trimmedLabel),
					hasLabel: true,
				};
			}
			continue;
		}
		if (seenIds.has(device.deviceId)) {
			continue;
		}
		seenIds.add(device.deviceId);
		if (!trimmedLabel) {
			unnamedIndex += 1;
		}
		options.push({
			id: device.deviceId,
			label: trimmedLabel || `音频输入设备 ${unnamedIndex}`,
			isDefault: false,
			isLoopbackCandidate: isLikelyLoopbackDeviceName(trimmedLabel),
			hasLabel: trimmedLabel.length > 0,
		});
	}
	return options;
}

export function emptyAudioCaptureProbeState(): AudioCaptureProbeState {
	return {
		status: 'idle',
		source: null,
		deviceLabel: null,
		sampleRate: null,
		channelCount: null,
		trackReadyState: null,
		muted: null,
		volume: 0,
		errorCode: null,
		errorMessage: null,
		inputDevices: defaultInputDevices(),
		selectedInputDeviceId: null,
		inputDeviceListStatus: 'idle',
		inputDeviceListMessage: null,
	};
}

function defaultInputDevices(): AudioInputDeviceOption[] {
	return [{
		id: null,
		label: DEFAULT_INPUT_LABEL,
		isDefault: true,
		isLoopbackCandidate: false,
		hasLabel: true,
	}];
}

function microphoneConstraints(deviceId: string | null): MediaStreamConstraints {
	return deviceId === null
		? { audio: true, video: false }
		: { audio: { deviceId: { exact: deviceId } }, video: false };
}

function stopStream(stream: MediaStream): void {
	for (const track of stream.getTracks()) {
		try {
			track.stop();
		} catch {
			// One faulty track must not prevent the remaining tracks from stopping.
		}
	}
}

function disconnectNode(node: AudioNode | null): void {
	try {
		node?.disconnect();
	} catch {
		// Track stopping remains authoritative even when a node is already detached.
	}
}

async function closeAudioContext(audioContext: AudioContext): Promise<void> {
	try {
		if (audioContext.state !== 'closed') {
			await audioContext.close();
		}
	} catch {
		// Device release is best-effort after tracks have already been stopped.
	}
}

function isPermissionDenied(error: unknown): boolean {
	const name = safeErrorName(error);
	return name === 'NotAllowedError' || name === 'SecurityError';
}

function isNotSupported(error: unknown): boolean {
	return safeErrorName(error) === 'NotSupportedError';
}

function safeErrorName(error: unknown): string {
	if (typeof error === 'object' && error !== null && 'name' in error) {
		const name = String(error.name);
		return /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name) ? name : 'UnknownError';
	}
	return 'UnknownError';
}

function unsupportedMessage(source: AudioCaptureSource): string {
	return source === 'microphone'
		? '当前 Obsidian 环境不支持麦克风能力测试。'
		: '当前 Obsidian 环境没有可用的直接系统音频捕获接口。';
}

function hostUnsupportedMessage(): string {
	return '当前 Obsidian 环境不支持直接捕获系统音频。这不是权限问题。可以改用麦克风、Windows 立体声混音或其他音频输入设备。';
}

function permissionDeniedMessage(source: AudioCaptureSource): string {
	return source === 'microphone'
		? '麦克风权限被拒绝。请在系统或 Obsidian 权限设置中允许后重试。'
		: '系统音频共享请求被拒绝或取消。';
}

function noAudioTrackMessage(source: AudioCaptureSource): string {
	return source === 'system-audio'
		? '当前选择没有提供系统音频轨道。'
		: '没有检测到可用的麦克风音频轨道。';
}

function requestFailedMessage(source: AudioCaptureSource, errorName: string): string {
	const label = source === 'microphone' ? '麦克风' : '系统音频';
	return `${label}能力测试临时失败（${errorName}）。`;
}

function finitePositive(value: number | undefined): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value > 0
		? value
		: null;
}
