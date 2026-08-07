export type VisionImageSyntax = 'wiki' | 'markdown';
export type VisionImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface VisionImageReference {
	id: string;
	sourceStart: number;
	sourceEnd: number;
	original: string;
	link: string;
	syntax: VisionImageSyntax;
	altOrAlias?: string;
	sizeHint?: string;
}

export type ParsedVisionImageReference = Omit<VisionImageReference, 'id'>;

export interface ResolvedVisionImage {
	id: string;
	vaultPath: string;
	originalReference: string;
	mimeType: VisionImageMimeType;
	byteLength: number;
	mtime: number;
	dataUrl: string;
	nearbyContext: string;
}

export interface VisionAttachmentSnapshot {
	vaultPath: string;
	mtime: number;
	size: number;
	byteLength: number;
	contentFingerprint?: string;
}

export type VisionPlaceholderStatus =
	| 'valid'
	| 'recoverable-missing-images'
	| 'invalid-unknown-id'
	| 'invalid-duplicate-id'
	| 'invalid-placement'
	| 'invalid-direct-embed';

export interface VisionPlaceholderValidationResult {
	status: VisionPlaceholderStatus;
	restoredMarkdown?: string;
	missingIds: string[];
	message?: string;
}
