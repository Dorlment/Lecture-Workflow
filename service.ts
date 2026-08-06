import {
	App,
	normalizePath,
	TFile,
	TFolder,
} from 'obsidian';

import {
	assertSafeVaultFolderPath,
	buildLectureNote,
	createLectureFileBaseName,
	findAvailableFilePath,
} from './lecture-note';
import type { LectureNoteInput } from './types';

export class LectureNoteService {
	constructor(private readonly app: App) {}

	async create(input: LectureNoteInput, configuredFolder: string): Promise<TFile> {
		const requestedFolder = configuredFolder.trim() || '课堂笔记';
		assertSafeVaultFolderPath(requestedFolder);
		const folderPath = normalizePath(requestedFolder);
		assertSafeVaultFolderPath(folderPath);
		await this.ensureFolder(folderPath);

		const now = new Date();
		const created = formatDateTime(now);
		const date = formatDate(now);
		const baseName = createLectureFileBaseName(date, input.course, input.topic);
		const filePath = findAvailableFilePath(
			folderPath,
			baseName,
			(path) => Boolean(this.app.vault.getAbstractFileByPath(path)),
		);
		const content = buildLectureNote(input, created);
		const file = await this.app.vault.create(filePath, content);

		await this.app.workspace.getLeaf(false).openFile(file);
		return file;
	}

	private async ensureFolder(folderPath: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(folderPath);
		if (existing instanceof TFolder) {
			return;
		}
		if (existing) {
			throw new Error(`保存目录路径已被文件占用：${folderPath}`);
		}

		let currentPath = '';
		for (const segment of folderPath.split('/').filter(Boolean)) {
			currentPath = normalizePath(
				currentPath ? `${currentPath}/${segment}` : segment,
			);
			const current = this.app.vault.getAbstractFileByPath(currentPath);
			if (current instanceof TFolder) {
				continue;
			}
			if (current) {
				throw new Error(`保存目录路径已被文件占用：${currentPath}`);
			}
			await this.app.vault.adapter.mkdir(currentPath);
		}
	}
}

function formatDate(date: Date): string {
	return [
		date.getFullYear(),
		padNumber(date.getMonth() + 1),
		padNumber(date.getDate()),
	].join('-');
}

function formatDateTime(date: Date): string {
	return `${formatDate(date)} ${[
		padNumber(date.getHours()),
		padNumber(date.getMinutes()),
		padNumber(date.getSeconds()),
	].join(':')}`;
}

function padNumber(value: number): string {
	return String(value).padStart(2, '0');
}
