import {
	App,
	MarkdownView,
	normalizePath,
	TFile,
	TFolder,
} from 'obsidian';

import {
	assertScreenshotSnapshotUnchanged,
	buildScreenshotFolderPath,
	evaluateScreenshotStart,
	formatScreenshotTimestamp,
} from './screenshot-core';
import {
	ScreenshotWorkflowError,
} from './screenshot-types';
import type {
	ProcessedScreenshot,
	ScreenshotSnapshot,
} from './screenshot-types';
import { saveScreenshotTransaction } from './screenshot-workflow';
import type { SavedScreenshot } from './screenshot-workflow';

export class ScreenshotService {
	constructor(
		private readonly app: App,
		private readonly isOtherWriteWorkflowActive: () => boolean,
	) {}

	async prepare(signal?: AbortSignal): Promise<ScreenshotSnapshot> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const startStatus = evaluateScreenshotStart({
			isDesktopApp: true,
			hasMarkdownView: Boolean(view?.file?.extension === 'md'),
			isEditableMode: view?.getMode() === 'source',
		});
		if (startStatus !== 'ready') {
			throw new ScreenshotWorkflowError(startStatus);
		}
		if (!view?.file) {
			throw new ScreenshotWorkflowError('no-active-markdown');
		}
		if (signal?.aborted) {
			throw new ScreenshotWorkflowError('aborted');
		}
		if (this.isOtherWriteWorkflowActive()) {
			throw new ScreenshotWorkflowError('busy');
		}

		const file = view.file;
		const editor = view.editor;
		const editorContent = editor.getValue();
		const cursor = editor.getCursor();
		const cursorOffset = editor.posToOffset(cursor);
		const mtime = file.stat.mtime;
		const size = file.stat.size;
		const startedAt = new Date();
		let diskContent: string;
		try {
			diskContent = await this.app.vault.read(file);
		} catch {
			throw new ScreenshotWorkflowError('conflict');
		}
		if (signal?.aborted) {
			throw new ScreenshotWorkflowError('aborted');
		}
		if (editorContent !== diskContent
			|| this.app.workspace.getActiveViewOfType(MarkdownView) !== view
			|| this.app.workspace.getActiveFile() !== file
			|| view.file !== file
			|| view.getMode() !== 'source'
			|| editor.getValue() !== editorContent
			|| editor.posToOffset(editor.getCursor()) !== cursorOffset
			|| file.path !== normalizePath(file.path)
			|| file.stat.mtime !== mtime
			|| file.stat.size !== size
			|| this.app.vault.getAbstractFileByPath(file.path) !== file
			|| this.isOtherWriteWorkflowActive()) {
			throw new ScreenshotWorkflowError('conflict');
		}

		return {
			file,
			filePath: file.path,
			editorContent,
			diskContent,
			mtime,
			size,
			view,
			editor,
			cursor,
			cursorOffset,
			startedAt,
		};
	}

	async save(
		snapshot: ScreenshotSnapshot,
		image: ProcessedScreenshot,
		signal?: AbortSignal,
	): Promise<SavedScreenshot<TFile>> {
		const folderPath = normalizePath(buildScreenshotFolderPath(snapshot.file.basename));
		assertGeneratedScreenshotFolder(folderPath);
		return saveScreenshotTransaction({
			folderPath,
			timestamp: formatScreenshotTimestamp(image.capturedAt),
			capturedAt: image.capturedAt,
			originalEditorContent: snapshot.editorContent,
			cursorOffset: snapshot.cursorOffset,
			host: {
				assertUnchanged: () => this.assertUnchanged(snapshot, signal),
				readPngData: () => {
					if (signal?.aborted) {
						throw new ScreenshotWorkflowError('aborted');
					}
					return image.blob.arrayBuffer();
				},
				ensureFolder: (path) => this.ensureFolder(path),
				pathExists: (path) => Boolean(this.app.vault.getAbstractFileByPath(path)),
				createBinary: (path, data) => this.app.vault.createBinary(path, data),
				filePath: (file) => file.path,
				generateMarkdownLink: (file) =>
					this.app.fileManager.generateMarkdownLink(file, snapshot.filePath),
				insertAtSnapshotCursor: (text) => {
					snapshot.editor.replaceRange(text, snapshot.cursor);
				},
				trashFile: (file) => this.trashCreatedScreenshot(file),
			},
		});
	}

	private async assertUnchanged(
		snapshot: ScreenshotSnapshot,
		signal?: AbortSignal,
	): Promise<void> {
		if (signal?.aborted) {
			throw new ScreenshotWorkflowError('aborted');
		}
		if (this.isOtherWriteWorkflowActive()) {
			throw new ScreenshotWorkflowError('conflict');
		}
		let diskContent: string;
		try {
			diskContent = await this.app.vault.read(snapshot.file);
		} catch {
			throw new ScreenshotWorkflowError('conflict');
		}
		if (signal?.aborted) {
			throw new ScreenshotWorkflowError('aborted');
		}
		let cursorOffset: number | null = null;
		try {
			cursorOffset = snapshot.editor.posToOffset(snapshot.editor.getCursor());
		} catch {
			cursorOffset = null;
		}
		const currentFile = this.app.vault.getAbstractFileByPath(snapshot.filePath);
		assertScreenshotSnapshotUnchanged(snapshot, {
			activeViewMatches:
				this.app.workspace.getActiveViewOfType(MarkdownView) === snapshot.view,
			activeFileMatches: this.app.workspace.getActiveFile() === snapshot.file,
			fileExistsAtOriginalPath: currentFile instanceof TFile,
			fileIdentityMatches: currentFile === snapshot.file,
			filePathMatches: snapshot.file.path === snapshot.filePath
				&& snapshot.view.file?.path === snapshot.filePath,
			modeIsEditable: snapshot.view.getMode() === 'source',
			editorIdentityMatches: snapshot.view.editor === snapshot.editor,
			editorContent: snapshot.editor.getValue(),
			diskContent,
			mtime: snapshot.file.stat.mtime,
			size: snapshot.file.stat.size,
			cursor: snapshot.editor.getCursor(),
			cursorOffset,
		});
	}

	private async ensureFolder(folderPath: string): Promise<void> {
		let currentPath = '';
		for (const segment of folderPath.split('/')) {
			currentPath = normalizePath(currentPath ? `${currentPath}/${segment}` : segment);
			const existing = this.app.vault.getAbstractFileByPath(currentPath);
			if (existing instanceof TFolder) {
				continue;
			}
			if (existing) {
				throw new ScreenshotWorkflowError('folder-failed');
			}
			try {
				await this.app.vault.createFolder(currentPath);
			} catch {
				if (!(this.app.vault.getAbstractFileByPath(currentPath) instanceof TFolder)) {
					throw new ScreenshotWorkflowError('folder-failed');
				}
			}
		}
	}

	private async trashCreatedScreenshot(file: TFile): Promise<void> {
		const trashFile = Reflect.get(this.app.fileManager, 'trashFile') as unknown;
		if (typeof trashFile === 'function') {
			await Reflect.apply(trashFile, this.app.fileManager, [file]);
			return;
		}
		const vaultTrash = Reflect.get(this.app.vault, 'trash') as unknown;
		if (typeof vaultTrash !== 'function') {
			throw new ScreenshotWorkflowError('insert-failed');
		}
		await Reflect.apply(vaultTrash, this.app.vault, [file, false]);
	}
}

function assertGeneratedScreenshotFolder(folderPath: string): void {
	const segments = folderPath.split('/');
	if (segments.length !== 2
		|| segments[0] !== '课堂附件'
		|| !segments[1]
		|| segments.some((segment) => segment === '.' || segment === '..')
		|| /^[\\/]/.test(folderPath)
		|| /^[a-zA-Z]:/.test(folderPath)) {
		throw new ScreenshotWorkflowError('folder-failed');
	}
}
