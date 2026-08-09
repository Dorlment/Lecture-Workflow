import {
	AUDIO_COMPANION_PROTOCOL_VERSION,
	AUDIO_COMPANION_TARGET_FORMAT,
	type AudioCompanionCapability,
	type AudioCompanionClientMessage,
	type AudioCompanionErrorMessage,
	type AudioCompanionFrame,
	type AudioCompanionPlatform,
	type AudioCompanionReadyMessage,
	type AudioCompanionRemoteErrorCode,
	type AudioCompanionRemoteStatus,
	type AudioCompanionServerMessage,
	type AudioCompanionSource,
	type AudioCompanionStatusMessage,
} from './audio-companion-types';

export const AUDIO_COMPANION_MAX_CONTROL_BYTES = 32 * 1024;
export const AUDIO_COMPANION_MAX_PCM_BYTES = 64 * 1024;
export const AUDIO_COMPANION_FRAME_HEADER_BYTES = 32;
export const AUDIO_COMPANION_TOKEN_MIN_ENCODED_LENGTH = 43;
export const AUDIO_COMPANION_TOKEN_MAX_ENCODED_LENGTH = 256;

const FRAME_MAGIC = [0x4c, 0x57, 0x41, 0x46] as const; // LWAF
const FRAME_VERSION = 1;
const SAMPLE_FORMAT_S16LE = 1;
const BYTES_PER_S16_SAMPLE = 2;
const textEncoder = new TextEncoder();

const SOURCES = new Set<AudioCompanionSource>([
	'windows-wasapi-loopback',
	'macos-screencapturekit',
	'linux-pipewire',
	'microphone-input',
]);
const PLATFORMS = new Set<AudioCompanionPlatform>([
	'windows',
	'macos',
	'linux',
	'unknown',
]);
const CAPABILITIES = new Set<AudioCompanionCapability>([
	'audio-frame-v1',
	'heartbeat-v1',
	'source-selection-v1',
]);
const REMOTE_STATUSES = new Set<AudioCompanionRemoteStatus>([
	'connecting',
	'ready',
	'capturing',
	'stopped',
	'error',
]);
const REMOTE_ERROR_CODES = new Set<AudioCompanionRemoteErrorCode>([
	'AUTH_FAILED',
	'PROTOCOL_MISMATCH',
	'INVALID_REQUEST',
	'SOURCE_UNAVAILABLE',
	'FORMAT_UNSUPPORTED',
	'CAPTURE_FAILED',
	'BUSY',
	'INTERNAL_ERROR',
]);

export class AudioCompanionProtocolError extends Error {
	constructor(readonly reason: string) {
		super('The local audio helper sent an invalid protocol message.');
		this.name = 'AudioCompanionProtocolError';
	}
}

export function isValidAudioCompanionToken(token: string): boolean {
	const decodedByteFloor = Math.floor(token.length * 6 / 8);
	return token.length >= AUDIO_COMPANION_TOKEN_MIN_ENCODED_LENGTH
		&& token.length <= AUDIO_COMPANION_TOKEN_MAX_ENCODED_LENGTH
		&& token.length % 4 !== 1
		&& decodedByteFloor >= 32
		&& /^[A-Za-z0-9_-]+$/.test(token);
}

export function encodeAudioCompanionControlMessage(
	message: AudioCompanionClientMessage,
): string {
	const encoded = JSON.stringify(message);
	if (textEncoder.encode(encoded).byteLength > AUDIO_COMPANION_MAX_CONTROL_BYTES) {
		throw new AudioCompanionProtocolError('control-message-too-large');
	}
	return encoded;
}

export function parseAudioCompanionServerMessage(
	text: string,
): AudioCompanionServerMessage {
	if (textEncoder.encode(text).byteLength > AUDIO_COMPANION_MAX_CONTROL_BYTES) {
		throw new AudioCompanionProtocolError('control-message-too-large');
	}
	let value: unknown;
	try {
		value = JSON.parse(text) as unknown;
	} catch {
		throw new AudioCompanionProtocolError('invalid-json');
	}
	if (!isRecord(value) || typeof value.type !== 'string') {
		throw new AudioCompanionProtocolError('invalid-control-message');
	}
	if (value.protocolVersion !== AUDIO_COMPANION_PROTOCOL_VERSION) {
		throw new AudioCompanionProtocolError('protocol-version');
	}
	switch (value.type) {
		case 'READY':
			return parseReady(value);
		case 'STATUS':
			return parseStatus(value);
		case 'ERROR':
			return parseError(value);
		case 'PING':
		case 'PONG':
			if (!hasOnlyKeys(value, ['type', 'protocolVersion', 'id'])
				|| !isSafeNonNegativeInteger(value.id)) {
				throw new AudioCompanionProtocolError('invalid-heartbeat');
			}
			return {
				type: value.type,
				protocolVersion: AUDIO_COMPANION_PROTOCOL_VERSION,
				id: value.id,
			};
		default:
			throw new AudioCompanionProtocolError('unknown-message-type');
	}
}

export function parseAudioCompanionFrame(data: ArrayBuffer | ArrayBufferView): AudioCompanionFrame {
	const bytes = data instanceof ArrayBuffer
		? new Uint8Array(data)
		: new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	if (bytes.byteLength < AUDIO_COMPANION_FRAME_HEADER_BYTES) {
		throw new AudioCompanionProtocolError('frame-header-too-short');
	}
	for (let index = 0; index < FRAME_MAGIC.length; index += 1) {
		if (bytes[index] !== FRAME_MAGIC[index]) {
			throw new AudioCompanionProtocolError('frame-magic');
		}
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const frameVersion = view.getUint8(4);
	const sampleFormat = view.getUint8(5);
	const channels = view.getUint8(6);
	const flags = view.getUint8(7);
	const sequence = view.getUint32(8, true);
	const sampleRate = view.getUint32(12, true);
	const sampleCount = view.getUint32(16, true);
	const payloadLength = view.getUint32(20, true);
	const offsetBigInt = view.getBigUint64(24, true);
	if (frameVersion !== FRAME_VERSION
		|| sampleFormat !== SAMPLE_FORMAT_S16LE
		|| channels !== AUDIO_COMPANION_TARGET_FORMAT.channels
		|| flags !== 0
		|| sampleRate !== AUDIO_COMPANION_TARGET_FORMAT.sampleRate
		|| sampleCount === 0) {
		throw new AudioCompanionProtocolError('frame-format');
	}
	if (payloadLength > AUDIO_COMPANION_MAX_PCM_BYTES) {
		throw new AudioCompanionProtocolError('pcm-payload-too-large');
	}
	if (payloadLength !== bytes.byteLength - AUDIO_COMPANION_FRAME_HEADER_BYTES) {
		throw new AudioCompanionProtocolError('payload-length-mismatch');
	}
	const expectedLength = sampleCount * channels * BYTES_PER_S16_SAMPLE;
	if (!Number.isSafeInteger(expectedLength) || payloadLength !== expectedLength) {
		throw new AudioCompanionProtocolError('sample-count-mismatch');
	}
	if (offsetBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new AudioCompanionProtocolError('offset-out-of-range');
	}
	return {
		sequence,
		offsetMs: Number(offsetBigInt),
		sampleCount,
		durationMs: sampleCount / sampleRate * 1_000,
		sampleRate,
		channels,
		sampleFormat: 's16le',
		pcm: bytes.subarray(AUDIO_COMPANION_FRAME_HEADER_BYTES),
	};
}

function parseReady(value: Record<string, unknown>): AudioCompanionReadyMessage {
	if (!hasOnlyKeys(value, [
		'type',
		'protocolVersion',
		'helperVersion',
		'platform',
		'supportedSources',
		'supportedFormats',
		'capabilities',
	])
		|| !isBoundedString(value.helperVersion, 1, 64)
		|| typeof value.platform !== 'string'
		|| !PLATFORMS.has(value.platform as AudioCompanionPlatform)
		|| !isEnumArray(value.supportedSources, SOURCES)
		|| !isEnumArray(value.capabilities, CAPABILITIES)
		|| !Array.isArray(value.supportedFormats)
		|| !value.supportedFormats.every(isSupportedFormat)) {
		throw new AudioCompanionProtocolError('invalid-ready');
	}
	return {
		type: 'READY',
		protocolVersion: AUDIO_COMPANION_PROTOCOL_VERSION,
		helperVersion: value.helperVersion,
		platform: value.platform as AudioCompanionPlatform,
		supportedSources: [...value.supportedSources] as AudioCompanionSource[],
		supportedFormats: value.supportedFormats.map(() => ({
			sampleFormat: 's16le',
			sampleRate: AUDIO_COMPANION_TARGET_FORMAT.sampleRate,
			channels: AUDIO_COMPANION_TARGET_FORMAT.channels,
		})),
		capabilities: [...value.capabilities] as AudioCompanionCapability[],
	};
}

function parseStatus(value: Record<string, unknown>): AudioCompanionStatusMessage {
	if (!hasOnlyKeys(value, ['type', 'protocolVersion', 'status'])
		|| typeof value.status !== 'string'
		|| !REMOTE_STATUSES.has(value.status as AudioCompanionRemoteStatus)) {
		throw new AudioCompanionProtocolError('invalid-status');
	}
	return {
		type: 'STATUS',
		protocolVersion: AUDIO_COMPANION_PROTOCOL_VERSION,
		status: value.status as AudioCompanionRemoteStatus,
	};
}

function parseError(value: Record<string, unknown>): AudioCompanionErrorMessage {
	if (!hasOnlyKeys(value, ['type', 'protocolVersion', 'code', 'messageZh', 'retryable'])
		|| typeof value.code !== 'string'
		|| !REMOTE_ERROR_CODES.has(value.code as AudioCompanionRemoteErrorCode)
		|| !isBoundedString(value.messageZh, 1, 160)
		|| hasControlCharacters(value.messageZh)
		|| typeof value.retryable !== 'boolean') {
		throw new AudioCompanionProtocolError('invalid-error');
	}
	return {
		type: 'ERROR',
		protocolVersion: AUDIO_COMPANION_PROTOCOL_VERSION,
		code: value.code as AudioCompanionRemoteErrorCode,
		messageZh: value.messageZh,
		retryable: value.retryable,
	};
}

function isSupportedFormat(value: unknown): boolean {
	return isRecord(value)
		&& hasOnlyKeys(value, ['sampleFormat', 'sampleRate', 'channels'])
		&& value.sampleFormat === AUDIO_COMPANION_TARGET_FORMAT.sampleFormat
		&& value.sampleRate === AUDIO_COMPANION_TARGET_FORMAT.sampleRate
		&& value.channels === AUDIO_COMPANION_TARGET_FORMAT.channels;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const expected = new Set(keys);
	const actual = Object.keys(value);
	return actual.length === expected.size && actual.every((key) => expected.has(key));
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
	return typeof value === 'string' && value.length >= min && value.length <= max;
}

function hasControlCharacters(value: string): boolean {
	return [...value].some((character) => {
		const codePoint = character.codePointAt(0);
		return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
	});
}

function isSafeNonNegativeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isEnumArray<T extends string>(value: unknown, allowed: Set<T>): value is T[] {
	return Array.isArray(value)
		&& value.length <= 32
		&& value.every((item) => typeof item === 'string' && allowed.has(item as T));
}
