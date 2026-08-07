import type {
	Editor,
	EditorPosition,
	MarkdownView,
	TFile,
} from 'obsidian';

export type ScreenshotWorkflowErrorCode =
	| 'unsupported-platform'
	| 'no-active-markdown'
	| 'read-only'
	| 'busy'
	| 'conflict'
	| 'image-required'
	| 'multiple-images'
	| 'input-too-large'
	| 'invalid-dimensions'
	| 'decode-failed'
	| 'canvas-failed'
	| 'encode-failed'
	| 'output-too-large'
	| 'folder-failed'
	| 'create-failed'
	| 'link-failed'
	| 'insert-failed'
	| 'aborted'
	| 'unknown';

export const SCREENSHOT_CONFLICT_MESSAGE =
	'笔记在截图期间已发生变化，为避免插入到错误位置，已取消保存。请关闭窗口后重新截图。';

export class ScreenshotWorkflowError extends Error {
	constructor(readonly code: ScreenshotWorkflowErrorCode) {
		super(messageForScreenshotError(code));
		this.name = 'ScreenshotWorkflowError';
	}
}

export class ScreenshotOrphanError extends ScreenshotWorkflowError {
	constructor(readonly vaultPath: string) {
		super('insert-failed');
		this.name = 'ScreenshotOrphanError';
	}
}

export interface ScreenshotSnapshot {
	file: TFile;
	filePath: string;
	editorContent: string;
	diskContent: string;
	mtime: number;
	size: number;
	view: MarkdownView;
	editor: Editor;
	cursor: EditorPosition;
	cursorOffset: number;
	startedAt: Date;
}

export interface ProcessedScreenshot {
	readonly width: number;
	readonly height: number;
	readonly byteLength: number;
	readonly capturedAt: Date;
	readonly blob: Blob;
	dispose(): void;
}

export function isScreenshotWorkflowError(error: unknown): error is ScreenshotWorkflowError {
	return error instanceof ScreenshotWorkflowError;
}

function messageForScreenshotError(code: ScreenshotWorkflowErrorCode): string {
	const messages: Record<ScreenshotWorkflowErrorCode, string> = {
		'unsupported-platform': '课堂截图目前仅支持 Obsidian 桌面端。',
		'no-active-markdown': '请先打开一篇可编辑的 Markdown 笔记。',
		'read-only': '当前 Markdown 笔记处于阅读模式，请切换到编辑模式后重试。',
		busy: '课堂截图流程正在进行，请勿重复启动。',
		conflict: SCREENSHOT_CONFLICT_MESSAGE,
		'image-required': '剪贴板中没有可用图片，请先完成系统截图。',
		'multiple-images': '剪贴板中包含多张图片，请一次只粘贴一张。',
		'input-too-large': '截图原始文件超过 25 MiB，无法处理。',
		'invalid-dimensions': '截图尺寸无效或超过安全限制。',
		'decode-failed': '无法解码剪贴板图片，请重新截图后再试。',
		'canvas-failed': '无法处理截图画面，请重新截图后再试。',
		'encode-failed': '无法将截图编码为 PNG，请重新截图后再试。',
		'output-too-large': '处理后的 PNG 超过 25 MiB，无法保存。',
		'folder-failed': '无法创建课堂截图附件目录。',
		'create-failed': '无法在 Vault 中保存课堂截图。',
		'link-failed': '截图已回收：无法生成 Obsidian 图片链接。',
		'insert-failed': '截图已回收：无法插入当前笔记。',
		aborted: '课堂截图流程已取消。',
		unknown: '课堂截图处理失败，请稍后重试。',
	};
	return messages[code];
}
