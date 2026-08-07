import {
	MAX_SCREENSHOT_INPUT_BYTES,
	MAX_SCREENSHOT_OUTPUT_BYTES,
	validateScreenshotDimensions,
} from './screenshot-core';
import { ScreenshotWorkflowError } from './screenshot-types';
import type { ProcessedScreenshot } from './screenshot-types';

export interface DecodedScreenshotImage {
	readonly source: CanvasImageSource;
	readonly width: number;
	readonly height: number;
	dispose(): void;
}

export interface ScreenshotImageEnvironment {
	decode(blob: Blob): Promise<DecodedScreenshotImage>;
	createCanvas(): HTMLCanvasElement;
	draw(
		canvas: HTMLCanvasElement,
		source: CanvasImageSource,
		width: number,
		height: number,
	): void;
	encodePng(canvas: HTMLCanvasElement): Promise<Blob | null>;
	now(): Date;
}

export interface ScreenshotPreviewEnvironment {
	createObjectUrl(blob: Blob): string;
	revokeObjectUrl(url: string): void;
}

export interface PasteImageItem {
	kind: string;
	type: string;
	getAsFile(): File | null;
}

export type ScreenshotPasteResult =
	| { status: 'ready'; image: ProcessedScreenshot; previewUrl: string }
	| { status: 'image-required' }
	| { status: 'multiple-images' }
	| { status: 'stale' };

export class ScreenshotImageProcessor {
	constructor(private readonly environment: ScreenshotImageEnvironment) {}

	async process(blob: Blob): Promise<ProcessedScreenshot> {
		if (blob.size > MAX_SCREENSHOT_INPUT_BYTES) {
			throw new ScreenshotWorkflowError('input-too-large');
		}

		let decoded: DecodedScreenshotImage | null = null;
		let canvas: HTMLCanvasElement | null = null;
		try {
			try {
				decoded = await this.environment.decode(blob);
			} catch {
				throw new ScreenshotWorkflowError('decode-failed');
			}
			validateScreenshotDimensions(decoded.width, decoded.height);

			try {
				canvas = this.environment.createCanvas();
				canvas.width = decoded.width;
				canvas.height = decoded.height;
				this.environment.draw(canvas, decoded.source, decoded.width, decoded.height);
			} catch {
				throw new ScreenshotWorkflowError('canvas-failed');
			}

			let pngBlob: Blob | null;
			try {
				pngBlob = await this.environment.encodePng(canvas);
			} catch {
				throw new ScreenshotWorkflowError('encode-failed');
			}
			if (!pngBlob || pngBlob.type !== 'image/png') {
				throw new ScreenshotWorkflowError('encode-failed');
			}
			if (pngBlob.size > MAX_SCREENSHOT_OUTPUT_BYTES) {
				throw new ScreenshotWorkflowError('output-too-large');
			}
			return new DisposableProcessedScreenshot(
				pngBlob,
				decoded.width,
				decoded.height,
				this.environment.now(),
			);
		} finally {
			decoded?.dispose();
			if (canvas) {
				canvas.width = 0;
				canvas.height = 0;
			}
		}
	}
}

export class ScreenshotPasteSession {
	private generation = 0;
	private disposed = false;
	private currentImage: ProcessedScreenshot | null = null;
	private currentPreviewUrl: string | null = null;

	constructor(
		private readonly processor: ScreenshotImageProcessor,
		private readonly previewEnvironment: ScreenshotPreviewEnvironment,
	) {}

	get image(): ProcessedScreenshot | null {
		return this.currentImage;
	}

	async accept(images: Blob[]): Promise<ScreenshotPasteResult> {
		if (images.length === 0) {
			return { status: 'image-required' };
		}
		if (images.length > 1) {
			return { status: 'multiple-images' };
		}
		const image = images[0];
		if (!image) {
			return { status: 'image-required' };
		}

		const generation = ++this.generation;
		this.releaseCurrent();
		const processed = await this.processor.process(image);
		if (this.disposed || generation !== this.generation) {
			processed.dispose();
			return { status: 'stale' };
		}

		let previewUrl: string;
		try {
			previewUrl = this.previewEnvironment.createObjectUrl(processed.blob);
		} catch {
			processed.dispose();
			throw new ScreenshotWorkflowError('decode-failed');
		}
		this.currentImage = processed;
		this.currentPreviewUrl = previewUrl;
		return { status: 'ready', image: processed, previewUrl };
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.generation += 1;
		this.releaseCurrent();
	}

	private releaseCurrent(): void {
		if (this.currentPreviewUrl) {
			this.previewEnvironment.revokeObjectUrl(this.currentPreviewUrl);
			this.currentPreviewUrl = null;
		}
		this.currentImage?.dispose();
		this.currentImage = null;
	}
}

export function extractPastedImageFiles(items: Iterable<PasteImageItem>): File[] {
	const images: File[] = [];
	for (const item of items) {
		if (item.kind !== 'file' || !item.type.toLowerCase().startsWith('image/')) {
			continue;
		}
		const file = item.getAsFile();
		if (file) {
			images.push(file);
		}
	}
	return images;
}

export function createBrowserScreenshotImageEnvironment(): ScreenshotImageEnvironment {
	return {
		decode: async (blob) => {
			const bitmap = await activeWindow.createImageBitmap(blob);
			return {
				source: bitmap,
				width: bitmap.width,
				height: bitmap.height,
				dispose: () => bitmap.close(),
			};
		},
		createCanvas: () => createEl('canvas'),
		draw: (canvas, source, width, height) => {
			const context = canvas.getContext('2d');
			if (!context) {
				throw new ScreenshotWorkflowError('canvas-failed');
			}
			context.drawImage(source, 0, 0, width, height);
		},
		encodePng: (canvas) => new Promise((resolve) => {
			canvas.toBlob(resolve, 'image/png');
		}),
		now: () => new Date(),
	};
}

export function createBrowserScreenshotPreviewEnvironment(): ScreenshotPreviewEnvironment {
	return {
		createObjectUrl: (blob) => URL.createObjectURL(blob),
		revokeObjectUrl: (url) => URL.revokeObjectURL(url),
	};
}

class DisposableProcessedScreenshot implements ProcessedScreenshot {
	private blobReference: Blob | null;

	constructor(
		blob: Blob,
		readonly width: number,
		readonly height: number,
		readonly capturedAt: Date,
	) {
		this.blobReference = blob;
	}

	get byteLength(): number {
		return this.blob.size;
	}

	get blob(): Blob {
		if (!this.blobReference) {
			throw new ScreenshotWorkflowError('aborted');
		}
		return this.blobReference;
	}

	dispose(): void {
		this.blobReference = null;
	}
}
