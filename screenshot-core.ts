import { ScreenshotWorkflowError } from './screenshot-types';
import type { EditorPosition } from 'obsidian';

export const MAX_SCREENSHOT_INPUT_BYTES = 25 * 1024 * 1024;
export const MAX_SCREENSHOT_OUTPUT_BYTES = 25 * 1024 * 1024;
export const MAX_SCREENSHOT_EDGE_PIXELS = 16_384;
export const MAX_SCREENSHOT_TOTAL_PIXELS = 80_000_000;
export const SCREENSHOT_ATTACHMENT_ROOT = '课堂附件';

const MAX_SAFE_NOTE_NAME_LENGTH = 120;
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

export type ScreenshotStartStatus =
	| 'ready'
	| 'unsupported-platform'
	| 'no-active-markdown'
	| 'read-only';

export type ScreenshotDesktopPlatform = 'windows' | 'macos' | 'linux';

export interface ScreenshotSnapshotState {
	activeViewMatches: boolean;
	activeFileMatches: boolean;
	fileExistsAtOriginalPath: boolean;
	fileIdentityMatches: boolean;
	filePathMatches: boolean;
	modeIsEditable: boolean;
	editorIdentityMatches: boolean;
	editorContent: string;
	diskContent: string;
	mtime: number;
	size: number;
	cursor: EditorPosition;
	cursorOffset: number | null;
}

export interface ExpectedScreenshotSnapshotState {
	editorContent: string;
	diskContent: string;
	mtime: number;
	size: number;
	cursor: EditorPosition;
	cursorOffset: number;
}

export function evaluateScreenshotStart(options: {
	isDesktopApp: boolean;
	hasMarkdownView: boolean;
	isEditableMode: boolean;
}): ScreenshotStartStatus {
	if (!options.isDesktopApp) {
		return 'unsupported-platform';
	}
	if (!options.hasMarkdownView) {
		return 'no-active-markdown';
	}
	return options.isEditableMode ? 'ready' : 'read-only';
}

export function screenshotPasteInstruction(platform: ScreenshotDesktopPlatform): string {
	if (platform === 'macos') {
		return '按 Control + Command + Shift + 4 截取区域到剪贴板，返回此窗口后按 Command + V。';
	}
	if (platform === 'linux') {
		return '使用系统截图工具将区域截图复制到剪贴板，返回此窗口后按 Ctrl + V。';
	}
	return '按 Win + Shift + S 选择要截取的区域，完成后返回此窗口并按 Ctrl + V。';
}

export function assertScreenshotSnapshotUnchanged(
	expected: ExpectedScreenshotSnapshotState,
	current: ScreenshotSnapshotState,
): void {
	const cursorMatches = current.cursor.line === expected.cursor.line
		&& current.cursor.ch === expected.cursor.ch;
	if (!current.activeViewMatches
		|| !current.activeFileMatches
		|| !current.fileExistsAtOriginalPath
		|| !current.fileIdentityMatches
		|| !current.filePathMatches
		|| !current.modeIsEditable
		|| !current.editorIdentityMatches
		|| current.editorContent !== expected.editorContent
		|| current.diskContent !== expected.diskContent
		|| current.mtime !== expected.mtime
		|| current.size !== expected.size
		|| !cursorMatches
		|| current.cursorOffset !== expected.cursorOffset) {
		throw new ScreenshotWorkflowError('conflict');
	}
}

export function validateScreenshotDimensions(width: number, height: number): void {
	if (!Number.isSafeInteger(width)
		|| !Number.isSafeInteger(height)
		|| width <= 0
		|| height <= 0
		|| width > MAX_SCREENSHOT_EDGE_PIXELS
		|| height > MAX_SCREENSHOT_EDGE_PIXELS
		|| width * height > MAX_SCREENSHOT_TOTAL_PIXELS) {
		throw new ScreenshotWorkflowError('invalid-dimensions');
	}
}

export function sanitizeScreenshotNoteName(value: string): string {
	const withoutControlCharacters = Array.from(value, (character) =>
		character.charCodeAt(0) <= 31 ? '-' : character,
	).join('');
	let sanitized = withoutControlCharacters
		.replace(/[<>:"/\\|?*]/g, '-')
		.replace(/\s+/g, ' ')
		.replace(/[. ]+$/g, '')
		.trim()
		.slice(0, MAX_SAFE_NOTE_NAME_LENGTH)
		.replace(/[. ]+$/g, '');
	if (!sanitized || sanitized === '.' || sanitized === '..') {
		sanitized = '未命名笔记';
	}
	if (WINDOWS_RESERVED_NAME.test(sanitized)) {
		sanitized = `_${sanitized}`;
	}
	return sanitized;
}

export function buildScreenshotFolderPath(noteBaseName: string): string {
	return `${SCREENSHOT_ATTACHMENT_ROOT}/${sanitizeScreenshotNoteName(noteBaseName)}`;
}

export function formatScreenshotTimestamp(date: Date): string {
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
		+ `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
		+ `-${String(date.getMilliseconds()).padStart(3, '0')}`;
}

export function formatScreenshotClockTime(date: Date): string {
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function buildScreenshotCandidatePath(
	folderPath: string,
	timestamp: string,
	sequence: number,
): string {
	if (!Number.isSafeInteger(sequence) || sequence < 1) {
		throw new ScreenshotWorkflowError('create-failed');
	}
	const suffix = sequence === 1 ? '' : `-${sequence}`;
	return `${folderPath}/${timestamp}${suffix}.png`;
}

export function buildScreenshotEmbed(markdownLink: string): string {
	const trimmed = markdownLink.trim();
	if (!trimmed || /[\r\n]/.test(trimmed)) {
		throw new ScreenshotWorkflowError('link-failed');
	}
	return trimmed.startsWith('!') ? trimmed : `!${trimmed}`;
}

export function buildScreenshotInsertion(
	content: string,
	cursorOffset: number,
	markdownLink: string,
	capturedAt: Date,
): string {
	if (!Number.isSafeInteger(cursorOffset)
		|| cursorOffset < 0
		|| cursorOffset > content.length) {
		throw new ScreenshotWorkflowError('conflict');
	}
	const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
	const before = content.slice(0, cursorOffset);
	const after = content.slice(cursorOffset);
	const prefix = before.length === 0 || endsWithLineBreak(before)
		? ''
		: `${lineEnding}${lineEnding}`;
	const suffix = after.length === 0 || startsWithLineBreak(after)
		? ''
		: `${lineEnding}${lineEnding}`;
	const block = `> 截图时间：${formatScreenshotClockTime(capturedAt)}`
		+ `${lineEnding}${buildScreenshotEmbed(markdownLink)}`;
	return `${prefix}${block}${suffix}`;
}

function endsWithLineBreak(value: string): boolean {
	return value.endsWith('\n') || value.endsWith('\r');
}

function startsWithLineBreak(value: string): boolean {
	return value.startsWith('\n') || value.startsWith('\r');
}

function pad(value: number): string {
	return String(value).padStart(2, '0');
}
