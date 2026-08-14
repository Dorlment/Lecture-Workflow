import type {
	RealtimeAsrFinalSegment,
	RealtimeAsrInboundEventKind,
	RealtimeAsrPartialSegment,
	RealtimeAsrSegment,
	RealtimeAsrWord,
} from './realtime-asr-types';
import { RealtimeAsrError } from './realtime-asr-types';

const MAX_SERVER_MESSAGE_CHARS = 256 * 1024;
const MAX_TEXT_CHARS = 8_192;
const MAX_WORDS = 2_048;

export type BailianAsrServerEvent =
	| { type: 'task-started' }
	| { type: 'result-generated'; heartbeat: true }
	| { type: 'result-generated'; heartbeat: false; segment: RealtimeAsrSegment }
	| { type: 'task-finished' }
	| { type: 'task-failed' };

export function buildBailianAsrEndpoint(
	region: string,
	workspaceId: string,
): string {
	const normalized = workspaceId.trim();
	if (region !== 'cn-beijing' || !/^[a-zA-Z0-9_-]+$/.test(normalized)) {
		return '';
	}
	return `wss://${normalized}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`;
}

export function buildBailianRunTask(taskId: string, model: string): string {
	return JSON.stringify({
		header: {
			action: 'run-task',
			task_id: taskId,
			streaming: 'duplex',
		},
		payload: {
			task_group: 'audio',
			task: 'asr',
			function: 'recognition',
			model,
			parameters: {
				format: 'pcm',
				sample_rate: 16_000,
				heartbeat: true,
			},
			input: {},
		},
	});
}

export function buildBailianFinishTask(taskId: string): string {
	return JSON.stringify({
		header: {
			action: 'finish-task',
			task_id: taskId,
			streaming: 'duplex',
		},
		payload: { input: {} },
	});
}

export function parseBailianAsrServerEvent(
	message: string,
	taskId: string,
): BailianAsrServerEvent {
	if (message.length > MAX_SERVER_MESSAGE_CHARS) {
		throw new RealtimeAsrError('protocol-error');
	}
	let value: unknown;
	try {
		value = JSON.parse(message);
	} catch {
		throw new RealtimeAsrError('protocol-error');
	}
	const root = record(value);
	const header = record(root.header);
	if (header.task_id !== taskId || typeof header.event !== 'string') {
		throw new RealtimeAsrError('protocol-error');
	}
	switch (header.event) {
		case 'task-started':
			record(root.payload);
			return { type: 'task-started' };
		case 'task-finished':
			record(root.payload);
			return { type: 'task-finished' };
		case 'task-failed':
			if (typeof header.error_code !== 'string') {
				throw new RealtimeAsrError('protocol-error');
			}
			return { type: 'task-failed' };
		case 'result-generated':
			return parseResult(root);
		default:
			throw new RealtimeAsrError('protocol-error');
	}
}

/**
 * Classifies an inbound control message for bounded diagnostics only. Strict
 * protocol validation remains the responsibility of parseBailianAsrServerEvent.
 * This function never returns server text or arbitrary event names.
 */
export function classifyBailianAsrInboundEvent(
	message: string,
	taskId: string,
): RealtimeAsrInboundEventKind {
	if (message.length > MAX_SERVER_MESSAGE_CHARS) return 'unknown';
	try {
		const value: unknown = JSON.parse(message);
		if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown';
		const header = (value as Record<string, unknown>).header;
		if (!header || typeof header !== 'object' || Array.isArray(header)) return 'unknown';
		const recordHeader = header as Record<string, unknown>;
		if (recordHeader.task_id !== taskId) return 'unknown';
		switch (recordHeader.event) {
			case 'task-started':
			case 'result-generated':
			case 'task-failed':
			case 'task-finished':
				return recordHeader.event;
			default:
				return 'unknown';
		}
	} catch {
		return 'unknown';
	}
}

function parseResult(root: Record<string, unknown>): BailianAsrServerEvent {
	const payload = record(root.payload);
	const output = record(payload.output);
	const sentence = record(output.sentence);
	if (sentence.heartbeat === true) {
		if (sentence.sentence_id !== 0) {
			throw new RealtimeAsrError('protocol-error');
		}
		return { type: 'result-generated', heartbeat: true };
	}
	const sentenceId = nonNegativeInteger(sentence.sentence_id);
	const text = boundedString(sentence.text, MAX_TEXT_CHARS);
	const beginTimeMs = nonNegativeInteger(sentence.begin_time);
	if (sentence.sentence_end === false) {
		const endTimeMs = sentence.end_time === null
			? null
			: nonNegativeInteger(sentence.end_time);
		if (endTimeMs !== null && endTimeMs < beginTimeMs) {
			throw new RealtimeAsrError('protocol-error');
		}
		const segment: RealtimeAsrPartialSegment = {
			sentenceId,
			text,
			beginTimeMs,
			endTimeMs,
			isFinal: false,
		};
		return { type: 'result-generated', heartbeat: false, segment };
	}
	if (sentence.sentence_end !== true) {
		throw new RealtimeAsrError('protocol-error');
	}
	const endTimeMs = nonNegativeInteger(sentence.end_time);
	if (endTimeMs < beginTimeMs) {
		throw new RealtimeAsrError('protocol-error');
	}
	const words = parseWords(sentence.words, beginTimeMs, endTimeMs);
	const segment: RealtimeAsrFinalSegment = {
		sentenceId,
		text,
		beginTimeMs,
		endTimeMs,
		isFinal: true,
		...(words === undefined ? {} : { words }),
	};
	return { type: 'result-generated', heartbeat: false, segment };
}

function parseWords(
	value: unknown,
	sentenceBeginTimeMs: number,
	sentenceEndTimeMs: number,
): RealtimeAsrWord[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || value.length > MAX_WORDS) {
		throw new RealtimeAsrError('protocol-error');
	}
	let previousBeginTimeMs = sentenceBeginTimeMs;
	return value.map((entry) => {
		const word = record(entry);
		const beginTimeMs = nonNegativeInteger(word.begin_time);
		const endTimeMs = nonNegativeInteger(word.end_time);
		if (beginTimeMs < sentenceBeginTimeMs
			|| endTimeMs > sentenceEndTimeMs
			|| beginTimeMs < previousBeginTimeMs
			|| endTimeMs < beginTimeMs) {
			throw new RealtimeAsrError('protocol-error');
		}
		previousBeginTimeMs = beginTimeMs;
		return {
			text: boundedString(word.text, 1_024),
			punctuation: boundedString(word.punctuation, 64),
			beginTimeMs,
			endTimeMs,
		};
	});
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new RealtimeAsrError('protocol-error');
	}
	return value as Record<string, unknown>;
}

function nonNegativeInteger(value: unknown): number {
	if (typeof value !== 'number'
		|| !Number.isSafeInteger(value)
		|| value < 0) {
		throw new RealtimeAsrError('protocol-error');
	}
	return value;
}

function boundedString(value: unknown, maximum: number): string {
	if (typeof value !== 'string' || value.length > maximum) {
		throw new RealtimeAsrError('protocol-error');
	}
	return value;
}
