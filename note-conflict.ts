import { applyStructuredResult } from './ai-note';

export const NOTE_CONFLICT_MESSAGE = '笔记在 AI 整理期间已发生变化，为避免覆盖，已取消写入。请关闭预览后重新整理。';
export const NOTE_LATEST_READ_FAILED_MESSAGE = '无法读取笔记的最新内容，为避免覆盖，已取消写入。请关闭预览后重新整理。';

export class NoteConflictError extends Error {
	readonly code = 'note-conflict';

	constructor() {
		super(NOTE_CONFLICT_MESSAGE);
		this.name = 'NoteConflictError';
	}
}

export class NoteLatestReadError extends Error {
	readonly code = 'note-latest-read-failed';

	constructor() {
		super(NOTE_LATEST_READ_FAILED_MESSAGE);
		this.name = 'NoteLatestReadError';
	}
}

export function buildConflictCheckedContent(
	originalContent: string,
	latestContent: string,
	generatedMarkdown: string,
): string {
	if (latestContent !== originalContent) {
		throw new NoteConflictError();
	}
	return applyStructuredResult(latestContent, generatedMarkdown);
}

export function assertTargetPath(expectedPath: string, actualPath: string | null): void {
	if (actualPath !== expectedPath) {
		throw new NoteConflictError();
	}
}

export async function processConflictSafeWrite(
	processLatest: (transform: (latestContent: string) => string) => Promise<string>,
	originalContent: string,
	generatedMarkdown: string,
): Promise<string> {
	let callbackStarted = false;
	let conflictDetected = false;
	try {
		return await processLatest((latestContent) => {
			callbackStarted = true;
			try {
				return buildConflictCheckedContent(originalContent, latestContent, generatedMarkdown);
			} catch (error) {
				if (isNoteConflictError(error)) {
					conflictDetected = true;
				}
				throw error;
			}
		});
	} catch (error) {
		if (conflictDetected || isNoteConflictError(error)) {
			throw new NoteConflictError();
		}
		if (!callbackStarted) {
			throw new NoteLatestReadError();
		}
		throw error;
	}
}

export async function freshReadConflictSafeWrite(
	readLatest: () => Promise<string>,
	write: (updatedContent: string) => Promise<void>,
	originalContent: string,
	generatedMarkdown: string,
): Promise<string> {
	let latestContent: string;
	try {
		latestContent = await readLatest();
	} catch (error) {
		if (isNoteConflictError(error)) {
			throw new NoteConflictError();
		}
		throw new NoteLatestReadError();
	}
	const updatedContent = buildConflictCheckedContent(
		originalContent,
		latestContent,
		generatedMarkdown,
	);
	await write(updatedContent);
	return updatedContent;
}

export function isNoteConflictError(error: unknown): boolean {
	return hasErrorCode(error, 'note-conflict');
}

export function isNoteLatestReadError(error: unknown): boolean {
	return hasErrorCode(error, 'note-latest-read-failed');
}

function hasErrorCode(error: unknown, code: string): boolean {
	return Boolean(
		error
		&& typeof error === 'object'
		&& 'code' in error
		&& error.code === code,
	);
}
