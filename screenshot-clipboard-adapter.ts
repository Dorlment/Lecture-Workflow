import type {
	ClipboardImageCandidate,
	ScreenshotClipboardAdapter,
	ScreenshotClipboardAdapterResult,
} from './screenshot-background-types';

interface ByteSequence {
	readonly byteLength: number;
	readonly [index: number]: number;
}

interface ElectronNativeImageLike {
	isEmpty?: () => boolean;
	getSize?: () => { width: number; height: number };
	resize?: (options: {
		width?: number;
		height?: number;
		quality?: 'good' | 'better' | 'best';
	}) => ElectronNativeImageLike;
	toBitmap?: () => ByteSequence;
	toPNG?: () => ByteSequence;
}

interface ElectronClipboardLike {
	availableFormats?: () => string[];
	readImage?: () => ElectronNativeImageLike;
}

interface AvailableElectronClipboard {
	availableFormats(): string[];
	readImage(): ElectronNativeImageLike;
}

interface ElectronModuleLike {
	clipboard?: ElectronClipboardLike;
}

export interface ElectronClipboardFactoryOptions {
	isDesktopApp: boolean;
	loadElectronModule?: () => unknown;
}

export function createElectronClipboardAdapter(
	options: ElectronClipboardFactoryOptions,
): ScreenshotClipboardAdapterResult {
	if (!options.isDesktopApp) {
		return { status: 'unsupported' };
	}

	let loaded: unknown;
	try {
		loaded = (options.loadElectronModule ?? loadElectronModule)();
	} catch {
		return { status: 'unsupported' };
	}
	const electron = asElectronModule(loaded);
	const clipboard = electron?.clipboard;
	if (!isAvailableClipboard(clipboard)) {
		return { status: 'unsupported' };
	}
	return {
		status: 'ready',
		adapter: new ElectronClipboardAdapter(clipboard),
	};
}

class ElectronClipboardAdapter implements ScreenshotClipboardAdapter {
	private disposed = false;

	constructor(private readonly clipboard: AvailableElectronClipboard) {}

	readImageCandidate(): ClipboardImageCandidate | null {
		if (this.disposed) {
			return null;
		}
		let formats: string[];
		try {
			formats = this.clipboard.availableFormats();
		} catch {
			throw new ClipboardCapabilityError();
		}
		if (!formats.some(isImageClipboardFormat)) {
			return null;
		}

		let nativeImage: ElectronNativeImageLike;
		try {
			nativeImage = this.clipboard.readImage();
		} catch {
			throw new ClipboardCapabilityError();
		}
		assertNativeImageCapabilities(nativeImage);
		if (nativeImage.isEmpty()) {
			return null;
		}
		const { width, height } = nativeImage.getSize();
		if (!Number.isSafeInteger(width)
			|| !Number.isSafeInteger(height)
			|| width <= 0
			|| height <= 0) {
			throw new ClipboardCapabilityError();
		}

		let thumbnail: ElectronNativeImageLike;
		let thumbnailBytes: ByteSequence;
		try {
			thumbnail = nativeImage.resize({
				width: Math.min(16, width),
				height: Math.min(16, height),
				quality: 'good',
			});
			if (typeof thumbnail.toBitmap !== 'function') {
				throw new ClipboardCapabilityError();
			}
			thumbnailBytes = thumbnail.toBitmap();
		} catch {
			throw new ClipboardCapabilityError();
		}
		return new ElectronClipboardImageCandidate(
			nativeImage,
			width,
			height,
			`${width}x${height}:${fingerprintBytes(thumbnailBytes)}`,
		);
	}

	dispose(): void {
		this.disposed = true;
	}
}

class ElectronClipboardImageCandidate implements ClipboardImageCandidate {
	private nativeImage: ElectronNativeImageLike | null;
	private completeFingerprint: string | null = null;
	private pngData: Uint8Array | null = null;

	constructor(
		nativeImage: ElectronNativeImageLike,
		readonly width: number,
		readonly height: number,
		readonly lightFingerprint: string,
	) {
		this.nativeImage = nativeImage;
	}

	fullFingerprint(): string {
		if (this.completeFingerprint) {
			return this.completeFingerprint;
		}
		const pngData = this.getPngData();
		this.completeFingerprint = `${this.width}x${this.height}:${fingerprintBytes(pngData)}`;
		return this.completeFingerprint;
	}

	takePngData(): Uint8Array {
		return this.getPngData().slice();
	}

	release(): void {
		this.nativeImage = null;
		this.completeFingerprint = null;
		this.pngData = null;
	}

	private getPngData(): Uint8Array {
		if (this.pngData) {
			return this.pngData;
		}
		const image = this.nativeImage;
		if (!image || typeof image.toPNG !== 'function') {
			throw new ClipboardCapabilityError();
		}
		let pngBytes: ByteSequence;
		try {
			pngBytes = image.toPNG();
		} catch {
			throw new ClipboardCapabilityError();
		}
		this.pngData = copyBytes(pngBytes);
		return this.pngData;
	}
}

export class ClipboardCapabilityError extends Error {
	constructor() {
		super('Electron clipboard image capability is unavailable.');
		this.name = 'ClipboardCapabilityError';
	}
}

function loadElectronModule(): unknown {
	const runtimeRequire = (window as Window & {
		require?: (moduleId: string) => unknown;
	}).require;
	if (typeof runtimeRequire !== 'function') {
		throw new ClipboardCapabilityError();
	}
	return runtimeRequire('electron');
}

function asElectronModule(value: unknown): ElectronModuleLike | null {
	return value && typeof value === 'object' ? value : null;
}

function isAvailableClipboard(
	clipboard: ElectronClipboardLike | undefined,
): clipboard is AvailableElectronClipboard {
	return Boolean(clipboard
		&& typeof clipboard.availableFormats === 'function'
		&& typeof clipboard.readImage === 'function');
}

function assertNativeImageCapabilities(
	image: ElectronNativeImageLike,
): asserts image is Required<ElectronNativeImageLike> {
	if (!image
		|| typeof image.isEmpty !== 'function'
		|| typeof image.getSize !== 'function'
		|| typeof image.resize !== 'function'
		|| typeof image.toPNG !== 'function') {
		throw new ClipboardCapabilityError();
	}
}

function isImageClipboardFormat(format: string): boolean {
	return format.toLowerCase().startsWith('image/');
}

function fingerprintBytes(bytes: ByteSequence): string {
	let first = 0x811c9dc5;
	let second = 0x9e3779b9;
	for (let index = 0; index < bytes.byteLength; index += 1) {
		const value = bytes[index] ?? 0;
		first = Math.imul(first ^ value, 0x01000193);
		second = Math.imul(second ^ (value + index), 0x85ebca6b);
	}
	return `${bytes.byteLength}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}

function copyBytes(bytes: ByteSequence): Uint8Array {
	const result = new Uint8Array(bytes.byteLength);
	for (let index = 0; index < bytes.byteLength; index += 1) {
		result[index] = bytes[index] ?? 0;
	}
	return result;
}
