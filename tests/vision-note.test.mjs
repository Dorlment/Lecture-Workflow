import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { build } from 'esbuild';

const bundle = await build({
	stdin: {
		contents: [
			"export * from './image-references.ts';",
			"export * from './image-attachments.ts';",
			"export * from './image-placeholders.ts';",
			"export * from './settings-data.ts';",
			"export * from './vision-limits.ts';",
		].join('\n'),
		resolveDir: process.cwd(),
		sourcefile: 'vision-test-entry.ts',
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	write: false,
});
const bundledSource = bundle.outputFiles[0]?.text;
if (!bundledSource) {
	throw new Error('Failed to bundle vision foundation modules for tests.');
}
const vision = await import(`data:text/javascript,${encodeURIComponent(bundledSource)}`);
const adapterBundle = await build({
	entryPoints: ['obsidian-vision-attachment-host.ts'],
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	write: false,
	plugins: [{
		name: 'mock-obsidian',
		setup(buildApi) {
			buildApi.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'mock' }));
			buildApi.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
				contents: [
					'export class TFile {}',
					"export const normalizePath = (value) => value.replaceAll('\\\\', '/');",
					"export const arrayBufferToBase64 = () => 'MOCK_BASE64';",
				].join('\n'),
			}));
		},
	}],
});
const adapterSource = adapterBundle.outputFiles[0]?.text;
if (!adapterSource) {
	throw new Error('Failed to bundle Obsidian vision attachment adapter for tests.');
}
const adapterModule = await import(`data:text/javascript,${encodeURIComponent(adapterSource)}`);
const { ObsidianVisionAttachmentHost } = adapterModule;
const {
	MAX_SINGLE_VISION_IMAGE_BYTES,
	MAX_TOTAL_VISION_DATA_URL_CHARACTERS,
	MAX_TOTAL_VISION_IMAGE_BYTES,
	collectVisionImages,
	detectVisionImageMimeType,
	normalizeSettings,
	parseVisionImageReferences,
	validateAndRestoreImagePlaceholders,
	verifyVisionAttachmentSnapshots,
} = vision;

class MockVisionHost {
	constructor({ cache = null, images = [], encodeBase64 } = {}) {
		this.cache = cache;
		this.byLink = new Map();
		this.byPath = new Map();
		this.readCalls = [];
		this.encoder = encodeBase64 ?? ((data) => 'A'.repeat(Math.ceil(data.byteLength / 3) * 4));
		for (const image of images) {
			this.addImage(image);
		}
	}

	addImage(image) {
		this.byLink.set(image.link, image.handle);
		this.byPath.set(image.handle.vaultPath, image.handle);
	}

	getCachedEmbeds() {
		return this.cache;
	}

	resolveLink(link) {
		return this.byLink.get(link) ?? null;
	}

	getFileByPath(path) {
		return this.byPath.get(path) ?? null;
	}

	async readBinary(file) {
		this.readCalls.push(file.name);
		if (file.readError) {
			throw file.readError;
		}
		return file.bytes;
	}

	encodeBase64(data) {
		return this.encoder(data);
	}
}

function makeBytes(format, length) {
	const minimum = format === 'webp' ? 12 : format === 'png' ? 8 : 3;
	const bytes = new Uint8Array(Math.max(length ?? minimum, minimum));
	if (format === 'png') {
		bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	} else if (format === 'jpeg') {
		bytes.set([0xff, 0xd8, 0xff]);
	} else if (format === 'webp') {
		bytes.set([0x52, 0x49, 0x46, 0x46], 0);
		bytes.set([0x57, 0x45, 0x42, 0x50], 8);
	}
	return bytes.buffer;
}

function makeImage({
	link = '图片.png',
	path = `附件/${link}`,
	extension = path.split('.').at(-1).toLowerCase(),
	format = extension === 'jpg' || extension === 'jpeg' ? 'jpeg' : extension,
	length,
	statSize,
	mtime = 123,
	readError,
} = {}) {
	const bytes = makeBytes(format, length);
	const file = { name: path, bytes, readError };
	return {
		link,
		handle: {
			file,
			vaultPath: path,
			extension,
			mtime,
			size: statSize ?? bytes.byteLength,
		},
	};
}

function collect(markdown, host, maxImages = 10) {
	return collectVisionImages({
		noteFile: { path: '课堂笔记/测试.md' },
		notePath: '课堂笔记/测试.md',
		markdownSnapshot: markdown,
		maxImages,
	}, host);
}

test('parses a basic Wiki image with exact source offsets', () => {
	const markdown = '开头\n![[图片.png]]\n结尾';
	const [reference] = parseVisionImageReferences(markdown);
	assert.equal(reference.id, 'IMG_001');
	assert.equal(reference.original, '![[图片.png]]');
	assert.equal(reference.link, '图片.png');
	assert.equal(markdown.slice(reference.sourceStart, reference.sourceEnd), reference.original);
});

test('parses Wiki paths, aliases, sizes, and alias plus size', () => {
	const references = parseVisionImageReferences([
		'![[附件/路径图.png]]',
		'![[别名图.jpg|说明]]',
		'![[尺寸图.webp|300]]',
		'![[组合图.jpeg|课堂板书|640]]',
	].join('\n'));
	assert.deepEqual(references.map((item) => item.link), [
		'附件/路径图.png', '别名图.jpg', '尺寸图.webp', '组合图.jpeg',
	]);
	assert.equal(references[1].altOrAlias, '说明');
	assert.equal(references[2].sizeHint, '300');
	assert.equal(references[3].altOrAlias, '课堂板书');
	assert.equal(references[3].sizeHint, '640');
});

test('parses basic Markdown images and preserves alt text', () => {
	const references = parseVisionImageReferences('![](图片.png)\n![说明](附件/图片.jpg)');
	assert.equal(references.length, 2);
	assert.equal(references[0].syntax, 'markdown');
	assert.equal(references[1].altOrAlias, '说明');
	assert.equal(references[1].link, '附件/图片.jpg');
});

test('sorts references by source offset before assigning IDs', () => {
	const markdown = '![先](先.png) 后面 ![[后.webp]]';
	const references = parseVisionImageReferences(markdown);
	assert.deepEqual(references.map(({ id, link }) => [id, link]), [
		['IMG_001', '先.png'], ['IMG_002', '后.webp'],
	]);
});

test('ignores image syntax in fenced code, inline code, HTML comments, and old AI regions', () => {
	const markdown = [
		'```md', '![[代码.png]]', '```',
		'`![[行内.png]]`',
		'<!-- ![[注释.png]] -->',
		'<!-- lecture-workflow:ai:start -->', '![[旧结果.png]]', '<!-- lecture-workflow:ai:end -->',
		'![[保留.png]]',
	].join('\n');
	assert.deepEqual(parseVisionImageReferences(markdown).map((item) => item.link), ['保留.png']);
});

test('does not let a closing inline-code delimiter hide later real image references', () => {
	const markdown = '`示例` ![[真实.png]] `另一个示例`';
	assert.deepEqual(parseVisionImageReferences(markdown).map((item) => item.link), ['真实.png']);
});

test('does not parse external URLs, data URLs, file URLs, or absolute paths', () => {
	const markdown = [
		'![](https://example.com/a.png)',
		'![](http://example.com/a.png)',
		'![](data:image/png;base64,AAAA)',
		'![](file:///tmp/a.png)',
		'![](C:\\temp\\a.png)',
		'![](/tmp/a.png)',
	].join('\n');
	assert.equal(parseVisionImageReferences(markdown).length, 0);
});

test('deduplicates identical references before assigning stable IDs', () => {
	const references = parseVisionImageReferences('![[图片.png]]\n再次 ![[图片.png|说明]]');
	assert.equal(references.length, 1);
	assert.equal(references[0].id, 'IMG_001');
	assert.equal(references[0].original, '![[图片.png]]');
});

test('uses validated MetadataCache embed offsets when cache matches the snapshot', async () => {
	const markdown = '正文\n![[图片.png|说明]]';
	const original = '![[图片.png|说明]]';
	const start = markdown.indexOf(original);
	const host = new MockVisionHost({
		cache: [{ original, link: '图片.png', position: { start: { offset: start }, end: { offset: start + original.length } } }],
		images: [makeImage()],
	});
	const result = await collect(markdown, host);
	assert.equal(result.referenceSource, 'metadata-cache');
	assert.equal(result.images[0].originalReference, original);
});

test('sorts validated MetadataCache entries before deduplication and IMG numbering', async () => {
	const markdown = '![[先.png]]\n![[后.png]]';
	const originals = ['![[先.png]]', '![[后.png]]'];
	const cache = originals.map((original) => {
		const start = markdown.indexOf(original);
		return {
			original,
			link: original.slice(3, -2),
			position: { start: { offset: start }, end: { offset: start + original.length } },
		};
	}).reverse();
	const images = [
		makeImage({ link: '先.png', path: '附件/先.png' }),
		makeImage({ link: '后.png', path: '附件/后.png' }),
	];
	const result = await collect(markdown, new MockVisionHost({ cache, images }));
	assert.deepEqual(result.images.map(({ id, vaultPath }) => [id, vaultPath]), [
		['IMG_001', '附件/先.png'], ['IMG_002', '附件/后.png'],
	]);
});

test('falls back to the bounded parser when MetadataCache is missing', async () => {
	const result = await collect('![[图片.png]]', new MockVisionHost({ images: [makeImage()] }));
	assert.equal(result.referenceSource, 'snapshot-parser');
});

test('falls back when a cached offset does not match the complete Markdown snapshot', async () => {
	const original = '![[图片.png]]';
	const host = new MockVisionHost({
		cache: [{ original, link: '图片.png', position: { start: { offset: 1 }, end: { offset: original.length + 1 } } }],
		images: [makeImage()],
	});
	const result = await collect(original, host);
	assert.equal(result.referenceSource, 'snapshot-parser');
});

test('rejects an unresolved or non-TFile link result', async () => {
	await assert.rejects(() => collect('![[图片.png]]', new MockVisionHost()), /不是 Vault 内 TFile/);
});

test('the Obsidian adapter rejects getFirstLinkpathDest results that are not TFile instances', () => {
	const host = new ObsidianVisionAttachmentHost(
		{
			getFirstLinkpathDest: () => ({ path: '附件/伪目录.png' }),
			getFileCache: () => null,
		},
		{ getAbstractFileByPath: () => null },
	);
	assert.equal(host.resolveLink('伪目录.png', '课堂笔记/测试.md'), null);
});

test('rejects a link that would resolve outside the Vault', async () => {
	await assert.rejects(() => collect('![[../../outside.png]]', new MockVisionHost()), /不可解析/);
});

test('deduplicates different links that resolve to the same normalized TFile path', async () => {
	const first = makeImage({ link: '图片.png', path: '附件/图片.png' });
	const alias = { link: '附件/图片.png', handle: first.handle };
	const result = await collect('![[图片.png]]\n![[附件/图片.png|别名]]', new MockVisionHost({ images: [first, alias] }));
	assert.equal(result.images.length, 1);
	assert.equal(result.references.length, 1);
	assert.equal(result.images[0].originalReference, '![[图片.png]]');
});

test('detects PNG, JPEG, and WebP by file magic', () => {
	assert.equal(detectVisionImageMimeType(makeBytes('png')), 'image/png');
	assert.equal(detectVisionImageMimeType(makeBytes('jpeg')), 'image/jpeg');
	assert.equal(detectVisionImageMimeType(makeBytes('webp')), 'image/webp');
});

test('maps both .jpg and .jpeg to JPEG after magic validation', async () => {
	for (const extension of ['jpg', 'jpeg']) {
		const image = makeImage({ link: `图.${extension}`, path: `附件/图.${extension}`, extension, format: 'jpeg' });
		const result = await collect(`![[图.${extension}]]`, new MockVisionHost({ images: [image] }));
		assert.equal(result.images[0].mimeType, 'image/jpeg');
	}
});

test('rejects extension and magic mismatches', async () => {
	const image = makeImage({ link: '伪装.png', path: '附件/伪装.png', extension: 'png', format: 'jpeg' });
	await assert.rejects(() => collect('![[伪装.png]]', new MockVisionHost({ images: [image] })), /魔数/);
});

test('rejects empty, too-short, and unsupported image files', async () => {
	for (const image of [
		{ ...makeImage(), handle: { ...makeImage().handle, file: { name: 'empty', bytes: new ArrayBuffer(0) }, size: 0 } },
		{ ...makeImage(), handle: { ...makeImage().handle, file: { name: 'short', bytes: new Uint8Array([0x89]).buffer }, size: 1 } },
		makeImage({ link: '动图.gif', path: '附件/动图.gif', extension: 'gif', format: 'png' }),
	]) {
		const link = image.link;
		await assert.rejects(() => collect(`![[${link}]]`, new MockVisionHost({ images: [image] })), /不支持|为空|过短|魔数/);
	}
});

test('enforces the configured image count without silently truncating', async () => {
	const images = [1, 2, 3].map((number) => makeImage({ link: `${number}.png`, path: `附件/${number}.png` }));
	await assert.rejects(
		() => collect(images.map((image) => `![[${image.link}]]`).join('\n'), new MockVisionHost({ images }), 2),
		/图片数量超过当前上限 2/,
	);
});

test('rejects a single image above 5 MiB before reading when stat already shows the excess', async () => {
	const image = makeImage({ length: 8, statSize: MAX_SINGLE_VISION_IMAGE_BYTES + 1 });
	const host = new MockVisionHost({ images: [image] });
	await assert.rejects(() => collect('![[图片.png]]', host), /单张上限/);
	assert.equal(host.readCalls.length, 0);
});

test('uses actual byteLength as the final single-image size authority', async () => {
	const image = makeImage({ length: MAX_SINGLE_VISION_IMAGE_BYTES + 1, statSize: 8 });
	await assert.rejects(() => collect('![[图片.png]]', new MockVisionHost({ images: [image] })), /实际大小/);
});

test('rejects raw image totals above 15 MiB', async () => {
	const images = [1, 2, 3, 4].map((number) => makeImage({
		link: `${number}.png`, path: `附件/${number}.png`, length: 4 * 1024 * 1024,
	}));
	await assert.rejects(
		() => collect(images.map((image) => `![[${image.link}]]`).join('\n'), new MockVisionHost({ images })),
		new RegExp(String(MAX_TOTAL_VISION_IMAGE_BYTES)),
	);
});

test('checks actual Data URL character totals after encoding', async () => {
	const images = [1, 2, 3].map((number) => makeImage({
		link: `${number}.png`, path: `附件/${number}.png`, length: MAX_SINGLE_VISION_IMAGE_BYTES,
	}));
	await assert.rejects(
		() => collect(images.map((image) => `![[${image.link}]]`).join('\n'), new MockVisionHost({ images })),
		new RegExp(String(MAX_TOTAL_VISION_DATA_URL_CHARACTERS)),
	);
});

test('production Base64 conversion does not depend on Node Buffer', async () => {
	const source = await readFile('obsidian-vision-attachment-host.ts', 'utf8');
	assert.equal(/\bBuffer\b/.test(source), false);
	assert.match(source, /arrayBufferToBase64/);
});

test('limits nearby context without cutting surrogate pairs', async () => {
	const image = makeImage();
	const markdown = `${'😀'.repeat(500)}![[图片.png]]${'课'.repeat(500)}`;
	const result = await collect(markdown, new MockVisionHost({ images: [image] }));
	assert.ok(Array.from(result.images[0].nearbyContext).length <= 400 + Array.from('[图片引用]').length);
	assert.equal(result.images[0].nearbyContext.includes('�'), false);
	assert.equal(result.images[0].nearbyContext.includes('![[图片.png]]'), false);
});

test('an unchanged attachment snapshot passes a fresh metadata and binary read', async () => {
	const image = makeImage();
	const result = await collect('![[图片.png]]', new MockVisionHost({ images: [image] }));
	const check = await verifyVisionAttachmentSnapshots(result.attachmentSnapshots, new MockVisionHost({ images: [image] }));
	assert.deepEqual(check, { valid: true, conflicts: [] });
});

test('deleted, renamed, metadata-changed, and actual-size-changed attachments conflict', async () => {
	const snapshot = { vaultPath: '附件/图片.png', mtime: 1, size: 8, byteLength: 8 };
	const deleted = await verifyVisionAttachmentSnapshots([snapshot], new MockVisionHost());
	assert.equal(deleted.conflicts[0].reason, 'missing');
	const renamedImage = makeImage({ path: '附件/新名.png', mtime: 1, statSize: 8 });
	const renamedHost = new MockVisionHost({ images: [renamedImage] });
	renamedHost.byPath.set(snapshot.vaultPath, renamedImage.handle);
	assert.equal((await verifyVisionAttachmentSnapshots([snapshot], renamedHost)).conflicts[0].reason, 'path-changed');
	const changed = makeImage({ path: snapshot.vaultPath, mtime: 2, statSize: 8 });
	assert.equal((await verifyVisionAttachmentSnapshots([snapshot], new MockVisionHost({ images: [changed] }))).conflicts[0].reason, 'metadata-changed');
	const sizeChanged = makeImage({ path: snapshot.vaultPath, mtime: 1, statSize: 8, length: 12 });
	assert.equal((await verifyVisionAttachmentSnapshots([snapshot], new MockVisionHost({ images: [sizeChanged] }))).conflicts[0].reason, 'size-changed');
});

test('a latest attachment read failure is a conflict by default', async () => {
	const snapshot = { vaultPath: '附件/图片.png', mtime: 1, size: 8, byteLength: 8 };
	const image = makeImage({ path: snapshot.vaultPath, mtime: 1, statSize: 8, readError: new Error('mock failure') });
	const check = await verifyVisionAttachmentSnapshots([snapshot], new MockVisionHost({ images: [image] }));
	assert.equal(check.valid, false);
	assert.equal(check.conflicts[0].reason, 'read-failed');
});

const placeholderImages = [
	{ id: 'IMG_001', originalReference: '![[图片.png|说明|300]]' },
	{ id: 'IMG_002', originalReference: '![板书](附件/板书.jpg)' },
];

test('restores a valid standalone placeholder to the exact original reference', () => {
	const result = validateAndRestoreImagePlaceholders('# 主题\n\n{{IMAGE:IMG_001}}', [placeholderImages[0]]);
	assert.equal(result.status, 'valid');
	assert.match(result.restoredMarkdown, /!\[\[图片\.png\|说明\|300\]\]/);
});

test('rejects unknown and duplicate placeholder IDs', () => {
	assert.equal(validateAndRestoreImagePlaceholders('{{IMAGE:IMG_999}}', placeholderImages).status, 'invalid-unknown-id');
	assert.equal(
		validateAndRestoreImagePlaceholders('{{IMAGE:IMG_001}}\n{{IMAGE:IMG_001}}', placeholderImages).status,
		'invalid-duplicate-id',
	);
});

test('rejects malformed placeholders even when another placeholder is valid', () => {
	const result = validateAndRestoreImagePlaceholders('{{IMAGE:IMG_001}}\n{{IMAGE:IMG_002', placeholderImages);
	assert.equal(result.status, 'invalid-unknown-id');
	assert.equal(result.restoredMarkdown, undefined);
});

test('rejects placeholders that are not standalone lines or are inside code fences', () => {
	assert.equal(
		validateAndRestoreImagePlaceholders('文字 {{IMAGE:IMG_001}}', placeholderImages).status,
		'invalid-placement',
	);
	assert.equal(
		validateAndRestoreImagePlaceholders('```\n{{IMAGE:IMG_001}}\n```', placeholderImages).status,
		'invalid-placement',
	);
});

test('rejects direct Wiki and Markdown embeds in model output', () => {
	assert.equal(validateAndRestoreImagePlaceholders('![[模型编造.png]]', placeholderImages).status, 'invalid-direct-embed');
	assert.equal(validateAndRestoreImagePlaceholders('![模型](模型.png)', placeholderImages).status, 'invalid-direct-embed');
});

test('deterministically appends missing images under a related-images heading', () => {
	const result = validateAndRestoreImagePlaceholders('# 主题\n\n正文', placeholderImages);
	assert.equal(result.status, 'recoverable-missing-images');
	assert.deepEqual(result.missingIds, ['IMG_001', 'IMG_002']);
	assert.match(result.restoredMarkdown, /## 相关课堂图片\n\n!\[\[图片\.png\|说明\|300\]\]\n!\[板书\]\(附件\/板书\.jpg\)/);
});

test('uses an existing related-images section instead of creating a duplicate heading', () => {
	const result = validateAndRestoreImagePlaceholders('# 主题\n\n## 相关课堂图片\n\n说明\n\n## 后续', placeholderImages);
	assert.equal(result.restoredMarkdown.split('## 相关课堂图片').length - 1, 1);
	assert.ok(result.restoredMarkdown.indexOf(placeholderImages[0].originalReference) < result.restoredMarkdown.indexOf('## 后续'));
});

test('each image appears exactly once after mixed placeholder restoration and missing-image recovery', () => {
	const result = validateAndRestoreImagePlaceholders('{{IMAGE:IMG_001}}\n\n正文', placeholderImages);
	for (const image of placeholderImages) {
		assert.equal(result.restoredMarkdown.split(image.originalReference).length - 1, 1);
	}
});

test('old settings are migrated with vision defaults and nested provider defaults', () => {
	const settings = normalizeSettings({
		notesFolder: '旧目录',
		qwen: { apiKey: 'test-value', model: 'text-model' },
		customOpenAI: { baseUrl: 'https://example.com' },
	});
	assert.equal(settings.enableVisionInput, false);
	assert.equal(settings.visionProvider, 'qwen');
	assert.equal(settings.qwen.visionModel, 'qwen3-vl-plus');
	assert.equal(settings.customOpenAI.supportsVision, false);
	assert.equal(settings.maxVisionImages, 10);
	assert.equal(settings.qwen.apiKey, 'test-value');
});

test('vision settings preserve valid values and normalize maxVisionImages into 1 through 10', () => {
	assert.equal(normalizeSettings({ maxVisionImages: 0 }).maxVisionImages, 1);
	assert.equal(normalizeSettings({ maxVisionImages: 99 }).maxVisionImages, 10);
	assert.equal(normalizeSettings({ maxVisionImages: 4.6 }).maxVisionImages, 5);
	const configured = normalizeSettings({
		enableVisionInput: true,
		visionProvider: 'custom',
		customOpenAI: { supportsVision: true },
	});
	assert.equal(configured.enableVisionInput, true);
	assert.equal(configured.visionProvider, 'custom');
	assert.equal(configured.customOpenAI.supportsVision, true);
});

test('vision confirmation keeps routing guidance visible and technical fields collapsed', async () => {
	const source = await readFile('vision-confirmation-modal.ts', 'utf8');
	assert.match(source, /课堂图片将由 Qwen-VL 进行视觉理解，视觉结果将作为辅助上下文提供给文本模型；完整文字稿由文本模型负责最终结构化整理。/);
	assert.match(source, /const advancedDetails = this\.contentEl\.createEl\('details'\)/);
	assert.match(source, /advancedDetails\.createEl\('summary', \{ text: '高级信息' \}\)/);
	assert.match(source, /advancedDetails\.createEl\('p',[\s\S]*?本次视觉 Provider/);
	assert.match(source, /const list = advancedDetails\.createEl\('ul'\)/);
	assert.match(source, /检测到 \$\{this\.summary\.imageCount\} 张图片/);
	assert.match(source, /可能产生额外 Token 或调用费用/);
	assert.match(source, /setButtonText\('发送并整理'\)/);
});
