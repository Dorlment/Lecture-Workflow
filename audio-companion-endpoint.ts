import { AUDIO_COMPANION_DEFAULT_ENDPOINT } from './audio-companion-types';

export interface AudioCompanionEndpointResult {
	valid: boolean;
	endpoint: string | null;
}

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function validateAudioCompanionEndpoint(
	value: string = AUDIO_COMPANION_DEFAULT_ENDPOINT,
): AudioCompanionEndpointResult {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { valid: false, endpoint: null };
	}
	const hostname = url.hostname.toLowerCase();
	if (url.protocol !== 'ws:'
		|| !ALLOWED_HOSTS.has(hostname)
		|| url.port !== '43127'
		|| url.pathname !== '/v1/audio'
		|| url.username !== ''
		|| url.password !== ''
		|| url.search !== ''
		|| url.hash !== '') {
		return { valid: false, endpoint: null };
	}
	return { valid: true, endpoint: url.href };
}
