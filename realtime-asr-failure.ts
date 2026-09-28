import type { RealtimeAsrFailureReason } from './realtime-asr-types';

const SERVICE_CODES = new Set([
	'CLIENT_ERROR', 'SERVER_ERROR', 'InvalidApiKey', 'InvalidParameter',
	'InvalidParameter.UnsupportedFormat', 'InvalidParameter.AudioFormat',
	'InvalidInput', 'InvalidModel', 'ModelNotFound', 'BadRequest',
	'Throttling', 'Throttling.RateQuota', 'Throttling.AllocationQuota',
	'AccessDenied', 'Forbidden', 'QuotaExceeded', 'Arrearage',
	'ServiceUnavailable', 'InternalError',
]);

/** Extract fixed categories only; never retain a server body, transcript, or secret. */
export function classifyRealtimeAsrServiceFailure(code: string, message: unknown): {
	serviceCode: string | null;
	reason: RealtimeAsrFailureReason;
	serviceTimeoutSeconds: number | null;
} {
	const serviceCode = SERVICE_CODES.has(code) ? code : null;
	const text = typeof message === 'string' ? message.slice(0, 2_048).toLowerCase() : '';
	let reason: RealtimeAsrFailureReason = 'unknown';
	let serviceTimeoutSeconds: number | null = null;
	if (/timeout|timed out/.test(text)) {
		reason = 'timeout';
		const match = /timeout after (\d{1,3})(?:\.\d+)? seconds/.exec(text);
		serviceTimeoutSeconds = match ? Number(match[1]) : null;
	} else if (/InvalidApiKey|AccessDenied|Forbidden/.test(serviceCode ?? '')
		|| /invalid api.?key|unauthorized|authentication failed|access denied/.test(text)) {
		reason = 'authentication';
	} else if (/Throttling/.test(serviceCode ?? '') || /rate limit|too many requests/.test(text)) {
		reason = 'rate-limit';
	} else if (/QuotaExceeded|Arrearage/.test(serviceCode ?? '') || /insufficient balance|out of credits/.test(text)) {
		reason = 'quota';
	} else if (/Invalid|ModelNotFound|BadRequest/.test(serviceCode ?? '')) {
		reason = 'invalid-configuration';
	} else if (/SERVER_ERROR|ServiceUnavailable|InternalError/.test(serviceCode ?? '')) {
		reason = 'service-unavailable';
	}
	return { serviceCode, reason, serviceTimeoutSeconds };
}
