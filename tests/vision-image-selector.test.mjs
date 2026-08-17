import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const moduleBundle = await build({
	stdin: {
		contents: "export * from './vision-image-selector.ts';",
		resolveDir: process.cwd(),
		sourcefile: 'vision-image-selector-test-entry.ts',
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	write: false,
	external: ['obsidian'],
});
const source = moduleBundle.outputFiles[0]?.text;
if (!source) throw new Error('Failed to bundle vision image selector.');
const api = await import(`data:text/javascript,${encodeURIComponent(source)}`);

const { selectImagesByTimeline, extractScreenshotOffsets, mapImagesToTimeline } = api;

function createImage(index, offsetMs) {
	return {
		originalIndex: index,
		offsetMs,
		imagePath: `image-${index}.png`,
	};
}

test('0 images: returns empty selection', () => {
	const result = selectImagesByTimeline([], 10);
	assert.equal(result.selected.length, 0);
	assert.equal(result.totalCount, 0);
	assert.equal(result.selectedCount, 0);
	assert.equal(result.wasFiltered, false);
});

test('1 image: returns single image', () => {
	const images = [createImage(0, 10000)];
	const result = selectImagesByTimeline(images, 10);
	assert.equal(result.selected.length, 1);
	assert.equal(result.selected[0].offsetMs, 10000);
	assert.equal(result.wasFiltered, false);
});

test('10 images: returns all images in order', () => {
	const images = Array.from({ length: 10 }, (_, i) => createImage(i, i * 10000));
	const result = selectImagesByTimeline(images, 10);
	assert.equal(result.selected.length, 10);
	assert.equal(result.wasFiltered, false);
	// Verify order
	for (let i = 0; i < 10; i++) {
		assert.equal(result.selected[i].offsetMs, i * 10000);
	}
});

test('11 images: selects 10, keeps first and last', () => {
	const images = Array.from({ length: 11 }, (_, i) => createImage(i, i * 10000));
	const result = selectImagesByTimeline(images, 10);
	assert.equal(result.selected.length, 10);
	assert.equal(result.wasFiltered, true);
	// First image (offset 0)
	assert.equal(result.selected[0].offsetMs, 0);
	// Last image (offset 100000)
	assert.equal(result.selected[9].offsetMs, 100000);
});

test('20 images: selects 10 with temporal coverage', () => {
	const images = Array.from({ length: 20 }, (_, i) => createImage(i, i * 5000));
	const result = selectImagesByTimeline(images, 10);
	assert.equal(result.selected.length, 10);
	assert.equal(result.wasFiltered, true);
	// First image (offset 0)
	assert.equal(result.selected[0].offsetMs, 0);
	// Last image (offset 95000)
	assert.equal(result.selected[9].offsetMs, 95000);
	// Verify middle images cover the time span
	const offsets = result.selected.map(img => img.offsetMs);
	// Check that we have images from different time ranges
	const hasEarly = offsets.some(o => o < 20000);
	const hasMiddle = offsets.some(o => o >= 20000 && o < 70000);
	const hasLate = offsets.some(o => o >= 70000);
	assert.ok(hasEarly, 'Should have early images');
	assert.ok(hasMiddle, 'Should have middle images');
	assert.ok(hasLate, 'Should have late images');
});

test('50 images: selects 10 with uniform distribution', () => {
	const images = Array.from({ length: 50 }, (_, i) => createImage(i, i * 2000));
	const result = selectImagesByTimeline(images, 10);
	assert.equal(result.selected.length, 10);
	assert.equal(result.wasFiltered, true);
	// First and last
	assert.equal(result.selected[0].offsetMs, 0);
	assert.equal(result.selected[9].offsetMs, 98000);
	// Verify roughly uniform distribution
	const offsets = result.selected.map(img => img.offsetMs);
	const gaps = [];
	for (let i = 1; i < offsets.length; i++) {
		gaps.push(offsets[i] - offsets[i - 1]);
	}
	// Gaps should be relatively consistent (within 2x of each other)
	const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
	for (const gap of gaps) {
		assert.ok(gap >= avgGap * 0.5 && gap <= avgGap * 2, 
			`Gap ${gap} should be within reasonable range of average ${avgGap}`);
	}
});

test('first and last always preserved', () => {
	const images = [
		createImage(0, 1000),
		createImage(1, 2000),
		createImage(2, 3000),
		createImage(3, 4000),
		createImage(4, 5000),
	];
	const result = selectImagesByTimeline(images, 3);
	assert.equal(result.selected.length, 3);
	assert.equal(result.selected[0].offsetMs, 1000); // First
	assert.equal(result.selected[2].offsetMs, 5000); // Last
});

test('output always sorted by offsetMs', () => {
	// Input in random order
	const images = [
		createImage(0, 50000),
		createImage(1, 10000),
		createImage(2, 30000),
		createImage(3, 20000),
		createImage(4, 40000),
	];
	const result = selectImagesByTimeline(images, 3);
	const offsets = result.selected.map(img => img.offsetMs);
	// Verify sorted
	for (let i = 1; i < offsets.length; i++) {
		assert.ok(offsets[i] >= offsets[i - 1], 'Output should be sorted by offsetMs');
	}
});

test('deterministic: same input produces same output', () => {
	const images = Array.from({ length: 20 }, (_, i) => createImage(i, i * 5000));
	const result1 = selectImagesByTimeline(images, 10);
	const result2 = selectImagesByTimeline(images, 10);
	assert.equal(result1.selected.length, result2.selected.length);
	for (let i = 0; i < result1.selected.length; i++) {
		assert.equal(result1.selected[i].offsetMs, result2.selected[i].offsetMs);
		assert.equal(result1.selected[i].originalIndex, result2.selected[i].originalIndex);
	}
});

test('does not modify original array', () => {
	const images = Array.from({ length: 15 }, (_, i) => createImage(i, i * 5000));
	const original = images.map(img => ({ ...img }));
	selectImagesByTimeline(images, 10);
	// Verify original unchanged
	for (let i = 0; i < images.length; i++) {
		assert.equal(images[i].offsetMs, original[i].offsetMs);
		assert.equal(images[i].originalIndex, original[i].originalIndex);
	}
});

test('extractScreenshotOffsets: parses timeline correctly', () => {
	const markdown = `## ⏱ 课堂时间线

<!-- lecture-workflow:event id=s1 type=screenshot offsetMs=10000 capturedAt=2024-01-01T00:00:10.000Z -->
### 00:00:10 · 课堂截图

![[screenshot1.png]]

<!-- lecture-workflow:event id=s2 type=screenshot offsetMs=30000 capturedAt=2024-01-01T00:00:30.000Z -->
### 00:00:30 · 课堂截图

![[screenshot2.png]]
`;
	const offsets = extractScreenshotOffsets(markdown);
	assert.equal(offsets.length, 2);
	assert.equal(offsets[0].offsetMs, 10000);
	assert.equal(offsets[0].imagePath, 'screenshot1.png');
	assert.equal(offsets[1].offsetMs, 30000);
	assert.equal(offsets[1].imagePath, 'screenshot2.png');
});

test('mapImagesToTimeline: maps images to offsets', () => {
	const imagePaths = ['img1.png', 'img2.png', 'img3.png'];
	const timelineOffsets = [
		{ offsetMs: 10000, imagePath: 'img1.png' },
		{ offsetMs: 30000, imagePath: 'img3.png' },
	];
	const result = mapImagesToTimeline(imagePaths, timelineOffsets);
	assert.equal(result.length, 3);
	assert.equal(result[0].offsetMs, 10000);
	assert.equal(result[1].offsetMs, Number.MAX_SAFE_INTEGER); // No timeline entry
	assert.equal(result[2].offsetMs, 30000);
});

test('integration: full pipeline with 15 images', () => {
	// Simulate 15 screenshots in timeline
	const markdown = Array.from({ length: 15 }, (_, i) => {
		const offsetMs = i * 10000;
		const minutes = Math.floor(offsetMs / 60000);
		const seconds = Math.floor((offsetMs % 60000) / 1000);
		return `<!-- lecture-workflow:event id=s${i} type=screenshot offsetMs=${offsetMs} capturedAt=2024-01-01T00:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.000Z -->
### ${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')} · 课堂截图

![[screenshot-${i}.png]]
`;
	}).join('\n');

	const imagePaths = Array.from({ length: 15 }, (_, i) => `screenshot-${i}.png`);
	const timelineOffsets = extractScreenshotOffsets(markdown);
	const imagesWithOffsets = mapImagesToTimeline(imagePaths, timelineOffsets);
	const result = selectImagesByTimeline(imagesWithOffsets, 10);

	assert.equal(result.selected.length, 10);
	assert.equal(result.wasFiltered, true);
	// First image
	assert.equal(result.selected[0].offsetMs, 0);
	// Last image
	assert.equal(result.selected[9].offsetMs, 140000);
	// Verify temporal coverage
	const offsets = result.selected.map(img => img.offsetMs);
	assert.ok(offsets.some(o => o < 30000), 'Should have early images');
	assert.ok(offsets.some(o => o >= 30000 && o < 100000), 'Should have middle images');
	assert.ok(offsets.some(o => o >= 100000), 'Should have late images');
});
