/**
 * Vision Image Selector
 *
 * Implements time-based image selection for Vision AI when there are too many screenshots.
 * Strategy: Keep first and last, uniformly sample middle images to cover full time span.
 */

export interface ImageWithOffset {
	/** Original index in the input array */
	originalIndex: number;
	/** Classroom offset in milliseconds */
	offsetMs: number;
	/** Image path or identifier */
	imagePath: string;
}

export interface SelectionResult {
	/** Selected images in chronological order */
	selected: ImageWithOffset[];
	/** Total number of input images */
	totalCount: number;
	/** Number of selected images */
	selectedCount: number;
	/** Whether selection was applied (true if input > maxImages) */
	wasFiltered: boolean;
}

/**
 * Select up to maxImages from the input, ensuring temporal coverage.
 *
 * Algorithm:
 * - If input.length <= maxImages: return all (no filtering)
 * - Otherwise:
 *   1. Sort by offsetMs (stable sort preserves original order for ties)
 *   2. Always keep first (earliest) and last (latest)
 *   3. Uniformly sample (maxImages - 2) from the middle
 *   4. Return in chronological order
 *
 * @param images Array of images with offsetMs
 * @param maxImages Maximum number of images to select (must be >= 2)
 * @returns Selection result with selected images and metadata
 */
export function selectImagesByTimeline(
	images: ImageWithOffset[],
	maxImages: number,
): SelectionResult {
	if (maxImages < 2) {
		throw new Error(`maxImages must be >= 2, got ${maxImages}`);
	}

	const totalCount = images.length;

	// No filtering needed
	if (totalCount <= maxImages) {
		return {
			selected: images.slice().sort((a, b) => a.offsetMs - b.offsetMs),
			totalCount,
			selectedCount: totalCount,
			wasFiltered: false,
		};
	}

	// Sort by offsetMs (stable sort)
	const sorted = images
		.map((img, idx) => ({ ...img, originalIndex: idx }))
		.sort((a, b) => {
			if (a.offsetMs !== b.offsetMs) {
				return a.offsetMs - b.offsetMs;
			}
			return a.originalIndex - b.originalIndex;
		});

	// Always keep first and last
	const first = sorted[0]!;
	const last = sorted[sorted.length - 1]!;

	// Sample middle images
	const middleCount = maxImages - 2;
	const middleImages = sampleMiddleImages(sorted, middleCount);

	// Combine and sort by offsetMs
	const selected = [first, ...middleImages, last].sort((a, b) => {
		if (a.offsetMs !== b.offsetMs) {
			return a.offsetMs - b.offsetMs;
		}
		return a.originalIndex - b.originalIndex;
	});

	return {
		selected,
		totalCount,
		selectedCount: selected.length,
		wasFiltered: true,
	};
}

/**
 * Uniformly sample middle images from the sorted array (excluding first and last).
 *
 * Uses systematic sampling: divide the middle range into equal intervals
 * and pick one image from each interval.
 */
function sampleMiddleImages(
	sorted: ImageWithOffset[],
	count: number,
): ImageWithOffset[] {
	if (count <= 0) {
		return [];
	}

	// Middle images are sorted[1..length-2]
	const middle = sorted.slice(1, -1);

	if (middle.length <= count) {
		return middle;
	}

	// Systematic sampling: divide into count equal intervals
	const intervalSize = middle.length / count;
	const sampled: ImageWithOffset[] = [];

	for (let i = 0; i < count; i++) {
		// Pick the middle element of each interval
		const intervalStart = Math.floor(i * intervalSize);
		const intervalEnd = Math.floor((i + 1) * intervalSize);
		const middleIndex = Math.floor((intervalStart + intervalEnd) / 2);
		const picked = middle[middleIndex];
		if (picked) {
			sampled.push(picked);
		}
	}

	return sampled;
}

/**
 * Parse timeline and extract screenshot events with their image paths.
 *
 * Returns array of { offsetMs, imagePath } for each screenshot in the timeline.
 */
export function extractScreenshotOffsets(markdown: string): Array<{ offsetMs: number; imagePath: string }> {
	const results: Array<{ offsetMs: number; imagePath: string }> = [];

	// Match screenshot event blocks
	// Format:
	// <!-- lecture-workflow:event id=... type=screenshot offsetMs=... -->
	// ### ... · 课堂截图
	//
	// ![[image.png]]

	const eventPattern = /<!-- lecture-workflow:event id=[^\s>]+ type=screenshot offsetMs=(\d+) [^>]+ -->\s*### [^·]+ · 课堂截图\s*!\[\[([^\]]+)\]\]/g;

	let match;
	while ((match = eventPattern.exec(markdown)) !== null) {
		const offsetMs = parseInt(match[1]!, 10);
		const imagePath = match[2];
		if (!isNaN(offsetMs) && imagePath) {
			results.push({ offsetMs, imagePath });
		}
	}

	return results;
}

/**
 * Map image references to their timeline offsets.
 *
 * @param imagePaths Array of image paths from vision pipeline
 * @param timelineOffsets Array of { offsetMs, imagePath } from timeline
 * @returns Array of ImageWithOffset with matched offsets
 */
export function mapImagesToTimeline(
	imagePaths: string[],
	timelineOffsets: Array<{ offsetMs: number; imagePath: string }>,
): ImageWithOffset[] {
	// Create a map from imagePath to offsetMs
	const offsetMap = new Map<string, number>();
	for (const { offsetMs, imagePath } of timelineOffsets) {
		offsetMap.set(imagePath, offsetMs);
	}

	// Map each image to its offset
	const result: ImageWithOffset[] = [];
	for (let i = 0; i < imagePaths.length; i++) {
		const imagePath = imagePaths[i];
		if (!imagePath) {
			continue;
		}
		const offsetMs = offsetMap.get(imagePath);

		// If no timeline entry, use a large offset to put it at the end
		// This ensures images without timeline data don't get selected over timed ones
		result.push({
			originalIndex: i,
			offsetMs: offsetMs ?? Number.MAX_SAFE_INTEGER,
			imagePath,
		});
	}

	return result;
}
