import {
	arrayBufferToBase64,
	normalizePath,
	TFile,
} from 'obsidian';
import type { MetadataCache, Vault } from 'obsidian';

import type {
	VisionAttachmentHost,
	VisionCacheEmbed,
	VisionFileHandle,
} from './image-attachments';

export class ObsidianVisionAttachmentHost implements VisionAttachmentHost<TFile, TFile> {
	constructor(
		private readonly metadataCache: MetadataCache,
		private readonly vault: Vault,
	) {}

	getCachedEmbeds(noteFile: TFile): VisionCacheEmbed[] | null {
		const embeds = this.metadataCache.getFileCache(noteFile)?.embeds;
		return embeds?.map((embed) => ({
			original: embed.original,
			link: embed.link,
			position: {
				start: { offset: embed.position.start.offset },
				end: { offset: embed.position.end.offset },
			},
		})) ?? null;
	}

	resolveLink(link: string, sourcePath: string): VisionFileHandle<TFile> | null {
		const file = this.metadataCache.getFirstLinkpathDest(link, sourcePath);
		return file instanceof TFile ? this.toHandle(file) : null;
	}

	getFileByPath(vaultPath: string): VisionFileHandle<TFile> | null {
		const file = this.vault.getAbstractFileByPath(normalizePath(vaultPath));
		return file instanceof TFile ? this.toHandle(file) : null;
	}

	readBinary(file: TFile): Promise<ArrayBuffer> {
		return this.vault.readBinary(file);
	}

	encodeBase64(data: ArrayBuffer): string {
		return arrayBufferToBase64(data);
	}

	private toHandle(file: TFile): VisionFileHandle<TFile> {
		return {
			file,
			vaultPath: normalizePath(file.path),
			extension: file.extension.toLowerCase(),
			mtime: file.stat.mtime,
			size: file.stat.size,
		};
	}
}
