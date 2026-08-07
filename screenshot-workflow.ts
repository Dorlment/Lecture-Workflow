import {
	buildScreenshotCandidatePath,
	buildScreenshotInsertion,
} from './screenshot-core';
import {
	ScreenshotOrphanError,
	ScreenshotWorkflowError,
} from './screenshot-types';

const MAX_SCREENSHOT_FILE_ATTEMPTS = 1_000;

export interface ScreenshotTransactionHost<TFile> {
	assertUnchanged(): Promise<void>;
	readPngData(): Promise<ArrayBuffer>;
	ensureFolder(folderPath: string): Promise<void>;
	pathExists(vaultPath: string): boolean;
	createBinary(vaultPath: string, data: ArrayBuffer): Promise<TFile>;
	filePath(file: TFile): string;
	generateMarkdownLink(file: TFile): string;
	insertAtSnapshotCursor(text: string): void;
	trashFile(file: TFile): Promise<void>;
}

export interface SaveScreenshotTransactionOptions<TFile> {
	folderPath: string;
	timestamp: string;
	capturedAt: Date;
	originalEditorContent: string;
	cursorOffset: number;
	host: ScreenshotTransactionHost<TFile>;
}

export interface SavedScreenshot<TFile> {
	file: TFile;
	vaultPath: string;
	insertion: string;
}

export async function saveScreenshotTransaction<TFile>(
	options: SaveScreenshotTransactionOptions<TFile>,
): Promise<SavedScreenshot<TFile>> {
	await options.host.assertUnchanged();

	let binary: ArrayBuffer;
	try {
		binary = await options.host.readPngData();
	} catch (error) {
		if (error instanceof ScreenshotWorkflowError) {
			throw error;
		}
		throw new ScreenshotWorkflowError('encode-failed');
	}
	await options.host.assertUnchanged();

	try {
		await options.host.ensureFolder(options.folderPath);
	} catch (error) {
		if (error instanceof ScreenshotWorkflowError) {
			throw error;
		}
		throw new ScreenshotWorkflowError('folder-failed');
	}
	await options.host.assertUnchanged();

	const created = await createAvailableScreenshotFile(
		options.folderPath,
		options.timestamp,
		binary,
		options.host,
	);

	try {
		await options.host.assertUnchanged();
		let markdownLink: string;
		try {
			markdownLink = options.host.generateMarkdownLink(created.file);
		} catch {
			throw new ScreenshotWorkflowError('link-failed');
		}
		const insertion = buildScreenshotInsertion(
			options.originalEditorContent,
			options.cursorOffset,
			markdownLink,
			options.capturedAt,
		);
		try {
			options.host.insertAtSnapshotCursor(insertion);
		} catch {
			throw new ScreenshotWorkflowError('insert-failed');
		}
		return {
			file: created.file,
			vaultPath: created.vaultPath,
			insertion,
		};
	} catch (error) {
		try {
			await options.host.trashFile(created.file);
		} catch {
			throw new ScreenshotOrphanError(created.vaultPath);
		}
		throw error;
	}
}

async function createAvailableScreenshotFile<TFile>(
	folderPath: string,
	timestamp: string,
	binary: ArrayBuffer,
	host: ScreenshotTransactionHost<TFile>,
): Promise<{ file: TFile; vaultPath: string }> {
	for (let sequence = 1; sequence <= MAX_SCREENSHOT_FILE_ATTEMPTS; sequence += 1) {
		const vaultPath = buildScreenshotCandidatePath(folderPath, timestamp, sequence);
		if (host.pathExists(vaultPath)) {
			continue;
		}
		try {
			const file = await host.createBinary(vaultPath, binary);
			return { file, vaultPath: host.filePath(file) };
		} catch {
			if (host.pathExists(vaultPath)) {
				continue;
			}
			throw new ScreenshotWorkflowError('create-failed');
		}
	}
	throw new ScreenshotWorkflowError('create-failed');
}
