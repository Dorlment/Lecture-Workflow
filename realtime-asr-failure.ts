import type { RealtimeAsrFailureReason } from './realtime-asr-types';

const SERVICE_CODES = new Set([
	'CLIENT_ERROR', 'SERVER_ERROR', 'InvalidApiKey', 'InvalidParameter',
	'InvalidParameter.UnsupportedFormat', 'InvalidParameter.AudioFormat',
	'InvalidInput', 'InvalidModel', 'ModelNotFound', 'BadRequest',
	'Throttling', 'Throttling.RateQuota', 'Throttling.AllocationQuota',
	'AccessDenied', 'Forbidden', 'QuotaExceeded', 'Arrearage',
	'ServiceUnavailable', 'InternalError',
	'PrepaidBillOverdue', 'PostpaidBillOverdue', 'BudgetLimitExceeded',
	'CommodityNotPurchased', 'Throttling.Concurrency', 'Throttling.BurstRate',
	'model_not_found', 'invalid_api_key', 'access_denied', 'insufficient_quota',
	'AllocationQuota.FreeTierOnly',
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
	} else if (serviceCode === 'AllocationQuota.FreeTierOnly'
		|| /free allocated quota exceeded|free (?:quota|tier).*(?:exhausted|expired|exceeded)|免费额度.*(?:耗尽|到期|用尽)/.test(text)) {
		reason = 'free-tier-exhausted';
	} else if (/QuotaExceeded|Arrearage|PrepaidBillOverdue|PostpaidBillOverdue|BudgetLimitExceeded/.test(serviceCode ?? '')
		|| /insufficient balance|out of credits|account is in good standing|(?:prepaid|postpaid) bill is overdue|budget.*(?:exhausted|exceeded)|欠费|余额不足/.test(text)) {
		reason = 'quota';
	} else if (/InvalidApiKey|AccessDenied|Forbidden|invalid_api_key|access_denied|CommodityNotPurchased/.test(serviceCode ?? '')
		|| /invalid api.?key|unauthorized|authentication failed|access denied/.test(text)) {
		reason = 'authentication';
	} else if (/Throttling|insufficient_quota/.test(serviceCode ?? '') || /rate limit|too many requests/.test(text)) {
		reason = 'rate-limit';
	} else if (/Invalid|ModelNotFound|BadRequest|model_not_found/.test(serviceCode ?? '')
		|| /model.{0,128}(?:not found|can not be found|does not exist|not supported|unsupported|deprecated|decommissioned)|invalid (?:model|parameter)|模型.*(?:不存在|不支持|下线)/.test(text)) {
		reason = 'invalid-configuration';
	} else if (/SERVER_ERROR|ServiceUnavailable|InternalError/.test(serviceCode ?? '')) {
		reason = 'service-unavailable';
	}
	return { serviceCode, reason, serviceTimeoutSeconds };
}
