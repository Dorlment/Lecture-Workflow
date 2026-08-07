import { parseVisionImageReferenceCandidates } from './image-references';
import { normalizeVisionImageCount } from './settings-data';
import {
	MAX_SINGLE_VISION_IMAGE_BYTES,
	MAX_TOTAL_VISION_DATA_URL_CHARACTERS,
	MAX_TOTAL_VISION_IMAGE_BYTES,
	VISION_NEARBY_CONTEXT_CODE_POINTS,
} from './vision-limits';
import type {
	ParsedVisionImageReference,
	ResolvedVisionImage,
	VisionAttachmentSnapshot,
	VisionImageMimeType,
	VisionImageReference,
} from './vision-types';

export interface VisionCacheEmbed {
	original: string;
	link: string;
	position: {
		start: { offset: number };
		end: { offset: number };
	};
}

export interface VisionFileHandle<TFile> {
	file: TFile;
	vaultPath: string;
	extension: string;
	mtime: number;
	size: number;
}

export interface VisionAttachmentHost<TNoteFile, TImageFile> {
	getCachedEmbeds(noteFile: TNoteFile): VisionCacheEmbed[] | null;
	resolveLink(link: string, sourcePath: string): VisionFileHandle<TImageFile> | null;
	getFileByPath(vaultPath: string): VisionFileHandle<TImageFile> | null;
	readBinary(file: TImageFile): Promise<ArrayBuffer>;
	encodeBase64(data: ArrayBuffer): string;
}

export interface CollectVisionImagesOptions<TNoteFile> {
	noteFile: TNoteFile;
	notePath: string;
	markdownSnapshot: string;
	maxImages: number;
}

export interface CollectedVisionImages {
	referenceSource: 'metadata-cache' | 'snapshot-parser';
	references: VisionImageReference[];
	images: ResolvedVisionImage[];
	attachmentSnapshots: VisionAttachmentSnapshot[];
}

export interface VisionAttachmentIssue {
	vaultPath: string;
	reason: string;
}

export class VisionAttachmentError extends Error {
	readonly issues: VisionAttachmentIssue[];

	constructor(issues: VisionAttachmentIssue[]) {
		super(`图片附件校验失败：${issues.map((issue) => `${issue.vaultPath}：${issue.reason}`).join('；')}`);
		this.name = 'VisionAttachmentError';
		this.issues = issues;
	}
}

export interface AttachmentSnapshotConflict {
	vaultPath: string;
	reason: 'missing' | 'path-changed' | 'metadata-changed' | 'read-failed' | 'size-changed' | 'content-changed';
}

export interface AttachmentSnapshotCheckResult {
	valid: boolean;
	conflicts: AttachmentSnapshotConflict[];
}

export async function collectVisionImages<TNoteFile, TImageFile>(
	options: CollectVisionImagesOptions<TNoteFile>,
	host: VisionAttachmentHost<TNoteFile, TImageFile>,
): Promise<CollectedVisionImages> {
	const selected = selectVisionReferenceCandidates(
		options.markdownSnapshot,
		host.getCachedEmbeds(options.noteFile),
	);
	const issues: VisionAttachmentIssue[] = [];
	const resolved = resolveAndDeduplicateReferences(
		selected.references,
		options.notePath,
		host,
		issues,
	);
	const maxImages = normalizeVisionImageCount(options.maxImages);
	if (resolved.length > maxImages) {
		for (const entry of resolved.slice(maxImages)) {
			issues.push({
				vaultPath: entry.handle.vaultPath,
				reason: `图片数量超过当前上限 ${maxImages}，不会静默截断`,
			});
		}
	}
	for (const entry of resolved) {
		if (!mimeTypeForExtension(entry.handle.extension)) {
			issues.push({
				vaultPath: entry.handle.vaultPath,
				reason: `不支持扩展名 .${entry.handle.extension}`,
			});
			continue;
		}
		if (entry.handle.size > MAX_SINGLE_VISION_IMAGE_BYTES) {
			issues.push({
				vaultPath: entry.handle.vaultPath,
				reason: `文件元数据大小 ${entry.handle.size} 字节超过单张上限 ${MAX_SINGLE_VISION_IMAGE_BYTES} 字节`,
			});
		}
	}
	if (issues.length > 0) {
		throw new VisionAttachmentError(issues);
	}

	const references: VisionImageReference[] = resolved.map((entry, index) => ({
		...entry.reference,
		id: `IMG_${String(index + 1).padStart(3, '0')}`,
	}));
	const images: ResolvedVisionImage[] = [];
	const attachmentSnapshots: VisionAttachmentSnapshot[] = [];
	let totalBytes = 0;
	let totalDataUrlCharacters = 0;

	for (const [index, reference] of references.entries()) {
		const handle = resolved[index]?.handle;
		if (!handle) {
			throw new Error('Vision reference mapping invariant failed.');
		}
		let binary: ArrayBuffer;
		try {
			binary = await host.readBinary(handle.file);
		} catch {
			issues.push({ vaultPath: handle.vaultPath, reason: 'Vault.readBinary 读取失败' });
			continue;
		}
		if (binary.byteLength > MAX_SINGLE_VISION_IMAGE_BYTES) {
			issues.push({
				vaultPath: handle.vaultPath,
				reason: `实际大小 ${binary.byteLength} 字节超过单张上限 ${MAX_SINGLE_VISION_IMAGE_BYTES} 字节`,
			});
			continue;
		}
		totalBytes += binary.byteLength;
		if (totalBytes > MAX_TOTAL_VISION_IMAGE_BYTES) {
			issues.push({
				vaultPath: handle.vaultPath,
				reason: `加入此文件后原图总大小超过 ${MAX_TOTAL_VISION_IMAGE_BYTES} 字节`,
			});
			break;
		}
		const mimeType = detectVisionImageMimeType(binary);
		const expectedMimeType = mimeTypeForExtension(handle.extension);
		if (!mimeType) {
			issues.push({ vaultPath: handle.vaultPath, reason: '文件为空、过短或魔数不是受支持的图片格式' });
			continue;
		}
		if (!expectedMimeType) {
			issues.push({ vaultPath: handle.vaultPath, reason: `不支持扩展名 .${handle.extension}` });
			continue;
		}
		if (mimeType !== expectedMimeType) {
			issues.push({
				vaultPath: handle.vaultPath,
				reason: `扩展名声明 ${expectedMimeType}，但文件魔数为 ${mimeType}`,
			});
			continue;
		}
		let base64: string;
		try {
			base64 = host.encodeBase64(binary);
		} catch {
			issues.push({ vaultPath: handle.vaultPath, reason: 'Base64 转换失败' });
			continue;
		}
		const dataUrl = `data:${mimeType};base64,${base64}`;
		totalDataUrlCharacters += dataUrl.length;
		if (totalDataUrlCharacters > MAX_TOTAL_VISION_DATA_URL_CHARACTERS) {
			issues.push({
				vaultPath: handle.vaultPath,
				reason: `加入此文件后 Data URL 总字符数超过 ${MAX_TOTAL_VISION_DATA_URL_CHARACTERS}`,
			});
			break;
		}
		images.push({
			id: reference.id,
			vaultPath: handle.vaultPath,
			originalReference: reference.original,
			mimeType,
			byteLength: binary.byteLength,
			mtime: handle.mtime,
			dataUrl,
			nearbyContext: extractNearbyContext(
				options.markdownSnapshot,
				reference.sourceStart,
				reference.sourceEnd,
			),
		});
		attachmentSnapshots.push({
			vaultPath: handle.vaultPath,
			mtime: handle.mtime,
			size: handle.size,
			byteLength: binary.byteLength,
			contentFingerprint: fingerprintArrayBuffer(binary),
		});
	}
	if (issues.length > 0) {
		throw new VisionAttachmentError(issues);
	}
	return {
		referenceSource: selected.source,
		references,
		images,
		attachmentSnapshots,
	};
}

export async function verifyVisionAttachmentSnapshots<TNoteFile, TImageFile>(
	snapshots: VisionAttachmentSnapshot[],
	host: VisionAttachmentHost<TNoteFile, TImageFile>,
): Promise<AttachmentSnapshotCheckResult> {
	const conflicts: AttachmentSnapshotConflict[] = [];
	for (const snapshot of snapshots) {
		const latest = host.getFileByPath(snapshot.vaultPath);
		if (!latest) {
			conflicts.push({ vaultPath: snapshot.vaultPath, reason: 'missing' });
			continue;
		}
		if (latest.vaultPath !== snapshot.vaultPath) {
			conflicts.push({ vaultPath: snapshot.vaultPath, reason: 'path-changed' });
			continue;
		}
		if (latest.mtime !== snapshot.mtime || latest.size !== snapshot.size) {
			conflicts.push({ vaultPath: snapshot.vaultPath, reason: 'metadata-changed' });
			continue;
		}
		try {
			const binary = await host.readBinary(latest.file);
			if (binary.byteLength !== snapshot.byteLength) {
				conflicts.push({ vaultPath: snapshot.vaultPath, reason: 'size-changed' });
			} else if (snapshot.contentFingerprint
				&& fingerprintArrayBuffer(binary) !== snapshot.contentFingerprint) {
				conflicts.push({ vaultPath: snapshot.vaultPath, reason: 'content-changed' });
			}
		} catch {
			conflicts.push({ vaultPath: snapshot.vaultPath, reason: 'read-failed' });
		}
	}
	return { valid: conflicts.length === 0, conflicts };
}

export function detectVisionImageMimeType(data: ArrayBuffer): VisionImageMimeType | null {
	const bytes = new Uint8Array(data);
	if (bytes.length >= 8
		&& bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
		&& bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
		return 'image/png';
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return 'image/jpeg';
	}
	if (bytes.length >= 12
		&& bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
		&& bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
		return 'image/webp';
	}
	return null;
}

export function fingerprintArrayBuffer(data: ArrayBuffer): string {
	const bytes = new Uint8Array(data);
	let first = 0x811c9dc5;
	let second = 0x9e3779b9;
	for (let index = 0; index < bytes.length; index += 1) {
		const byte = bytes[index] ?? 0;
		first = Math.imul(first ^ byte, 0x01000193);
		second = Math.imul(second ^ (byte + index), 0x85ebca6b);
	}
	return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

export function extractNearbyContext(markdown: string, start: number, end: number): string {
	const beforeWindow = markdown.slice(Math.max(0, start - VISION_NEARBY_CONTEXT_CODE_POINTS * 2), start);
	const afterWindow = markdown.slice(end, Math.min(markdown.length, end + VISION_NEARBY_CONTEXT_CODE_POINTS * 2));
	const before = Array.from(beforeWindow).slice(-VISION_NEARBY_CONTEXT_CODE_POINTS).join('');
	const after = Array.from(afterWindow).slice(0, VISION_NEARBY_CONTEXT_CODE_POINTS).join('');
	return `${before}[图片引用]${after}`;
}

function selectVisionReferenceCandidates(
	markdownSnapshot: string,
	cacheEmbeds: VisionCacheEmbed[] | null,
): { source: 'metadata-cache' | 'snapshot-parser'; references: ParsedVisionImageReference[] } {
	const parsed = parseVisionImageReferenceCandidates(markdownSnapshot);
	if (!cacheEmbeds) {
		return { source: 'snapshot-parser', references: parsed };
	}
	const validated: ParsedVisionImageReference[] = [];
	for (const cacheEmbed of cacheEmbeds) {
		const single = parseVisionImageReferenceCandidates(cacheEmbed.original);
		if (single.length !== 1 || single[0]?.sourceStart !== 0
			|| single[0].sourceEnd !== cacheEmbed.original.length) {
			continue;
		}
		const start = cacheEmbed.position.start.offset;
		const end = cacheEmbed.position.end.offset;
		const matching = parsed.find((reference) =>
			reference.sourceStart === start
			&& reference.sourceEnd === end
			&& reference.original === cacheEmbed.original
			&& reference.link === cacheEmbed.link);
		if (!matching || markdownSnapshot.slice(start, end) !== cacheEmbed.original) {
			return { source: 'snapshot-parser', references: parsed };
		}
		validated.push(matching);
	}
	if (validated.length !== parsed.length) {
		return { source: 'snapshot-parser', references: parsed };
	}
	return {
		source: 'metadata-cache',
		references: validated.sort((left, right) => left.sourceStart - right.sourceStart),
	};
}

function resolveAndDeduplicateReferences<TNoteFile, TImageFile>(
	references: ParsedVisionImageReference[],
	notePath: string,
	host: VisionAttachmentHost<TNoteFile, TImageFile>,
	issues: VisionAttachmentIssue[],
): Array<{ reference: ParsedVisionImageReference; handle: VisionFileHandle<TImageFile> }> {
	const resolved: Array<{ reference: ParsedVisionImageReference; handle: VisionFileHandle<TImageFile> }> = [];
	const seen = new Set<string>();
	for (const reference of references) {
		const handle = host.resolveLink(reference.link, notePath);
		if (!handle) {
			issues.push({ vaultPath: reference.link, reason: '附件不存在、不是 Vault 内 TFile 或路径不可解析' });
			continue;
		}
		const normalizedPath = normalizeVaultRelativePath(handle.vaultPath);
		if (!normalizedPath) {
			issues.push({ vaultPath: reference.link, reason: '解析结果不是安全的 Vault 相对路径' });
			continue;
		}
		if (seen.has(normalizedPath)) {
			continue;
		}
		seen.add(normalizedPath);
		resolved.push({ reference, handle: { ...handle, vaultPath: normalizedPath } });
	}
	return resolved;
}

function normalizeVaultRelativePath(path: string): string | null {
	const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
	if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)
		|| /^[a-z][a-z0-9+.-]*:/i.test(normalized)) {
		return null;
	}
	const parts = normalized.split('/');
	if (parts.some((part) => !part || part === '.' || part === '..')) {
		return null;
	}
	return parts.join('/');
}

function mimeTypeForExtension(extension: string): VisionImageMimeType | null {
	switch (extension.toLowerCase()) {
		case 'png': return 'image/png';
		case 'jpg':
		case 'jpeg': return 'image/jpeg';
		case 'webp': return 'image/webp';
		default: return null;
	}
}
