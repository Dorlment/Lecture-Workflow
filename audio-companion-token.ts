export const AUDIO_COMPANION_TOKEN_BYTES = 32;
export const AUDIO_COMPANION_TOKEN_LENGTH = 43;

const BASE64_URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export interface AudioCompanionRandomSource {
	fill(target: Uint8Array): void;
}

export function createAudioCompanionToken(
	randomSource: AudioCompanionRandomSource = createWebCryptoRandomSource(),
): string {
	const bytes = new Uint8Array(AUDIO_COMPANION_TOKEN_BYTES);
	try {
		randomSource.fill(bytes);
		const token = encodeBase64Url(bytes);
		if (token.length !== AUDIO_COMPANION_TOKEN_LENGTH) {
			throw new AudioCompanionTokenError();
		}
		return token;
	} finally {
		bytes.fill(0);
	}
}

export function createWebCryptoRandomSource(): AudioCompanionRandomSource {
	return {
		fill(target) {
			const cryptoApi = window.crypto;
			if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
				throw new AudioCompanionTokenError();
			}
			cryptoApi.getRandomValues(target);
		},
	};
}

export class AudioCompanionTokenError extends Error {
	constructor() {
		super('A secure runtime pairing token could not be created.');
		this.name = 'AudioCompanionTokenError';
	}
}

function encodeBase64Url(bytes: Uint8Array): string {
	let result = '';
	for (let index = 0; index < bytes.length; index += 3) {
		const first = bytes[index] ?? 0;
		const secondAvailable = index + 1 < bytes.length;
		const thirdAvailable = index + 2 < bytes.length;
		const second = bytes[index + 1] ?? 0;
		const third = bytes[index + 2] ?? 0;
		const combined = (first << 16) | (second << 8) | third;
		result += BASE64_URL_ALPHABET[(combined >>> 18) & 0x3f];
		result += BASE64_URL_ALPHABET[(combined >>> 12) & 0x3f];
		if (secondAvailable) {
			result += BASE64_URL_ALPHABET[(combined >>> 6) & 0x3f];
		}
		if (thirdAvailable) {
			result += BASE64_URL_ALPHABET[combined & 0x3f];
		}
	}
	return result;
}
