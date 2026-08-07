export type AudioCaptureSource = 'microphone' | 'system-audio';

export type AudioCaptureProbeStatus =
	| 'idle'
	| 'requesting-permission'
	| 'active'
	| 'stopping'
	| 'stopped'
	| 'unsupported'
	| 'permission-denied'
	| 'no-audio-track'
	| 'ended'
	| 'error';

export type AudioCaptureProbeErrorCode =
	| 'unsupported'
	| 'host-unsupported'
	| 'permission-denied'
	| 'no-audio-track'
	| 'request-failed'
	| 'audio-context-failed'
	| 'device-list-failed'
	| 'device-unavailable';

export type SystemAudioCapabilityStatus =
	| 'api-unavailable'
	| 'unverified'
	| 'requesting'
	| 'verified'
	| 'permission-denied'
	| 'no-audio-track'
	| 'host-unsupported'
	| 'temporary-failure';

export type AudioInputDeviceListStatus =
	| 'idle'
	| 'loading'
	| 'ready'
	| 'unsupported'
	| 'error';

export interface AudioInputDeviceOption {
	id: string | null;
	label: string;
	isDefault: boolean;
	isLoopbackCandidate: boolean;
	hasLabel: boolean;
}

export interface AudioCaptureCapabilities {
	microphone: boolean;
	systemAudioApi: boolean;
	systemAudioStatus: SystemAudioCapabilityStatus;
	deviceEnumeration: boolean;
}

export interface AudioCaptureProbeState {
	status: AudioCaptureProbeStatus;
	source: AudioCaptureSource | null;
	deviceLabel: string | null;
	sampleRate: number | null;
	channelCount: number | null;
	trackReadyState: MediaStreamTrackState | null;
	muted: boolean | null;
	volume: number;
	errorCode: AudioCaptureProbeErrorCode | null;
	errorMessage: string | null;
	inputDevices: AudioInputDeviceOption[];
	selectedInputDeviceId: string | null;
	inputDeviceListStatus: AudioInputDeviceListStatus;
	inputDeviceListMessage: string | null;
}

export type AudioCaptureProbeStartResult =
	| 'active'
	| 'busy'
	| 'unsupported'
	| 'permission-denied'
	| 'no-audio-track'
	| 'error'
	| 'stale';

export interface AudioCaptureMediaDevices {
	getUserMedia?: MediaDevices['getUserMedia'];
	getDisplayMedia?: MediaDevices['getDisplayMedia'];
	enumerateDevices?: MediaDevices['enumerateDevices'];
}

export interface AudioCaptureDeviceInfo {
	deviceId: string;
	kind: string;
	label: string;
}

export interface AudioCaptureProbeHost {
	isDesktopApp(): boolean;
	getMediaDevices(): AudioCaptureMediaDevices | null;
	enumerateDevices?(): Promise<readonly AudioCaptureDeviceInfo[]>;
	subscribeDeviceChange?(listener: () => void): () => void;
	createAudioContext(): AudioContext;
	requestAnimationFrame(callback: FrameRequestCallback): number;
	cancelAnimationFrame(handle: number): void;
}
