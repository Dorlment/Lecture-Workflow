import assert from 'node:assert/strict';
import test from 'node:test';

import { build } from 'esbuild';

async function bundleEntry(contents, plugins = []) {
	const bundle = await build({
		stdin: {
			contents,
			resolveDir: process.cwd(),
			sourcefile: 'vision-workflow-test-entry.ts',
		},
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'node18',
		write: false,
		plugins,
	});
	const source = bundle.outputFiles[0]?.text;
	if (!source) {
		throw new Error('Failed to bundle visual workflow test entry.');
	}
	return import(`data:text/javascript,${encodeURIComponent(source)}`);
}

const workflow = await bundleEntry([
	"export * from './vision-generation.ts';",
	"export * from './vision-workflow-routing.ts';",
	"export * from './ai-note.ts';",
	"export * from './ai-retry.ts';",
	"export * from './image-attachments.ts';",
].join('\n'));

const {
	VISION_EVIDENCE_SYSTEM_PROMPT,
	VISION_SYSTEM_PROMPT,
	applyStructuredResult,
	buildVisionRetryOptions,
	decideVisionWorkflowRoute,
	fingerprintArrayBuffer,
	generateVisionStructuredMarkdown,
	shouldAcceptVisionResult,
} = workflow;

class MockVisionProvider {
	id = 'qwen';
	displayName = 'Mock Qwen-VL';
	capabilities = { text: true, vision: true, speech: false };
	requests = [];

	constructor(responses) {
		this.responses = [...responses];
	}

	validateVision() { return []; }

	async generateVision(request) {
		this.requests.push(request);
		const response = this.responses.shift();
		if (response instanceof Error) {
			throw response;
		}
		return response;
	}
}

class MockRepairProvider {
	id = 'qwen';
	displayName = 'Mock Qwen Text';
	capabilities = { text: true, vision: false, speech: false };
	requests = [];

	constructor(responses = []) {
		this.responses = [...responses];
	}

	validate() { return []; }
	async testConnection() {}

	async generate(request) {
		this.requests.push(request);
		const response = this.responses.shift();
		if (response instanceof Error) {
			throw response;
		}
		return response;
	}
}

function response(content, finishReason = 'stop') {
	return { content, finishReason };
}

function resolvedImage(id = 'IMG_001', overrides = {}) {
	return {
		id,
		vaultPath: `附件/${id}.png`,
		originalReference: `![[附件/${id}.png|说明]]`,
		mimeType: 'image/png',
		byteLength: 8,
		mtime: 1,
		dataUrl: 'data:image/png;base64,AAAA',
		nearbyContext: `${id} 的附近文字`,
		...overrides,
	};
}

function validVisualMarkdown(placeholders = ['IMG_001']) {
	return `# 课堂主题

## 核心知识

重点内容。

${placeholders.map((id) => `{{IMAGE:${id}}}`).join('\n\n')}

## 💡 核心 Takeaways（3分钟速记）

- 结论一
- 结论二
- 结论三`;
}

test('visual evidence from Qwen is passed to DeepSeek for final generation', async () => {
	const evidence = '图片中清晰可见 DeepSeek Harness';
	const vision = new MockVisionProvider([response(evidence)]);
	const repair = new MockRepairProvider([response(validVisualMarkdown())]);
	await generateVisionStructuredMarkdown(vision, repair, 'ASR: DeepSeek Hannes', [resolvedImage()]);
	assert.equal(vision.requests[0].systemPrompt, VISION_EVIDENCE_SYSTEM_PROMPT);
	assert.equal(vision.requests[0].images[0], undefined, 'request image references are cleared after completion');
	assert.equal(repair.requests.length, 1);
	assert.equal(repair.requests[0].systemPrompt, VISION_SYSTEM_PROMPT);
	assert.match(repair.requests[0].userPrompt, /视觉证据/);
	assert.match(repair.requests[0].userPrompt, new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
	assert.match(repair.requests[0].userPrompt, /ASR: DeepSeek Hannes/);
	assert.match(repair.requests[0].userPrompt, /技术术语、产品名、英文专有名词/);
});

test('visual route preserves text-only behavior when no images exist', () => {
	assert.equal(decideVisionWorkflowRoute(0, true), 'text-only');
	assert.equal(decideVisionWorkflowRoute(0, false), 'text-only');
});

test('disabled vision requires an explicit text-only choice while enabled vision uses confirmation', () => {
	assert.equal(decideVisionWorkflowRoute(2, false), 'offer-text-only');
	assert.equal(decideVisionWorkflowRoute(2, true), 'vision');
});

test('a cancelled wait rejects late visual responses before preview', () => {
	const controller = new AbortController();
	assert.equal(shouldAcceptVisionResult(controller.signal), true);
	controller.abort();
	assert.equal(shouldAcceptVisionResult(controller.signal), false);
});

test('visual Prompt inherits Takeaways and strict image placeholder rules', async () => {
	const vision = new MockVisionProvider([response('视觉证据文本')]);
	const repair = new MockRepairProvider([response(validVisualMarkdown())]);
	await generateVisionStructuredMarkdown(vision, repair, '原始文字稿', [resolvedImage()]);
	assert.match(VISION_SYSTEM_PROMPT, /删除口水话/);
	assert.match(VISION_SYSTEM_PROMPT, /核心 Takeaways/);
	assert.match(VISION_SYSTEM_PROMPT, /3～5/);
	assert.match(VISION_SYSTEM_PROMPT, /PPT、板书、流程图和代码截图/);
	assert.match(VISION_SYSTEM_PROMPT, /\{\{IMAGE:IMG_001\}\}/);
	assert.equal(vision.requests[0].images[0], undefined, 'request image references are cleared after completion');
});

test('valid placeholders are restored to exact original references before preview', async () => {
	const image = resolvedImage();
	const outcome = await generateVisionStructuredMarkdown(
		new MockVisionProvider([response('视觉证据文本')]),
		new MockRepairProvider([response(validVisualMarkdown())]),
		'原稿',
		[image],
	);
	assert.equal(outcome.isComplete, true);
	assert.equal(outcome.attempts, 1);
	assert.match(outcome.markdown, /!\[\[附件\/IMG_001\.png\|说明\]\]/);
	assert.equal(outcome.markdown.includes('{{IMAGE:'), false);
	assert.equal(outcome.markdown.includes('data:image'), false);
});

test('outer Markdown fences are removed before visual validation', async () => {
	const outcome = await generateVisionStructuredMarkdown(
		new MockVisionProvider([response('视觉证据文本')]),
		new MockRepairProvider([response(`\`\`\`markdown\n${validVisualMarkdown()}\n\`\`\``)]),
		'原稿',
		[resolvedImage()],
	);
	assert.equal(outcome.isComplete, true);
	assert.equal(outcome.markdown.startsWith('```'), false);
});

test('missing legal images are appended deterministically without a repair request', async () => {
	const images = [resolvedImage('IMG_001'), resolvedImage('IMG_002')];
	const repair = new MockRepairProvider([response(validVisualMarkdown(['IMG_001']))]);
	const outcome = await generateVisionStructuredMarkdown(
		new MockVisionProvider([response('视觉证据文本')]),
		repair,
		'原稿',
		images,
	);
	assert.equal(outcome.isComplete, true);
	assert.equal(outcome.attempts, 1);
	assert.equal(repair.requests.length, 1);
	assert.match(outcome.markdown, /## 相关课堂图片/);
	for (const image of images) {
		assert.equal(outcome.markdown.split(image.originalReference).length - 1, 1);
	}
});

for (const [name, invalidMarkdown] of [
	['unknown ID', validVisualMarkdown(['IMG_999'])],
	['duplicate ID', validVisualMarkdown(['IMG_001', 'IMG_001'])],
	['inline placement', validVisualMarkdown().replace('{{IMAGE:IMG_001}}', '文字 {{IMAGE:IMG_001}}')],
	['code-block placement', validVisualMarkdown().replace('{{IMAGE:IMG_001}}', '```\n{{IMAGE:IMG_001}}\n```')],
	['direct Wiki embed', validVisualMarkdown().replace('{{IMAGE:IMG_001}}', '![[编造.png]]')],
	['direct Markdown embed', validVisualMarkdown().replace('{{IMAGE:IMG_001}}', '![编造](编造.png)')],
]) {
	test(`${name} triggers exactly one text-only format repair`, async () => {
		const repair = new MockRepairProvider([response(invalidMarkdown), response(validVisualMarkdown())]);
		const vision = new MockVisionProvider([response('视觉证据文本')]);
		const outcome = await generateVisionStructuredMarkdown(
			vision,
			repair,
			'原稿',
			[resolvedImage()],
		);
		assert.equal(outcome.isComplete, true);
		assert.equal(outcome.attempts, 2);
		assert.equal(vision.requests.length, 1);
		assert.equal(repair.requests.length, 2);
		assert.equal('images' in repair.requests[0], false);
	});
}

test('a missing or invalid Takeaways section triggers one repair', async () => {
	const invalid = validVisualMarkdown().replace('## 💡 核心 Takeaways（3分钟速记）', '## 总结');
	const repair = new MockRepairProvider([response(invalid), response(validVisualMarkdown())]);
	const outcome = await generateVisionStructuredMarkdown(
		new MockVisionProvider([response('视觉证据文本')]),
		repair,
		'原稿',
		[resolvedImage()],
	);
	assert.equal(outcome.isComplete, true);
	assert.equal(repair.requests.length, 2);
});

test('visual repair requests contain summaries but never image data or API secrets', async () => {
	const invalid = validVisualMarkdown(['IMG_999']);
	const repair = new MockRepairProvider([response(`${invalid}\n\ndata:image/png;base64,SECRETBYTES`), response(validVisualMarkdown())]);
	await generateVisionStructuredMarkdown(
		new MockVisionProvider([response('视觉证据文本')]),
		repair,
		'原稿',
		[resolvedImage('IMG_001', { nearbyContext: '附近 data:image/png;base64,CONTEXTDATA' })],
	);
	const repairBody = JSON.stringify(repair.requests[1]);
	assert.match(repairBody, /IMG_001/);
	assert.match(repairBody, /附近/);
	assert.equal(repairBody.includes('data:image'), false);
	assert.equal(repairBody.includes('SECRETBYTES'), false);
	assert.equal(repairBody.includes('CONTEXTDATA'), false);
});

test('a second invalid result stops after one repair and remains non-writable', async () => {
	const repair = new MockRepairProvider([response('# 第一次不完整'), response('# 仍然不完整')]);
	const outcome = await generateVisionStructuredMarkdown(
		new MockVisionProvider([response('视觉证据文本')]),
		repair,
		'原稿',
		[resolvedImage()],
	);
	assert.equal(outcome.isComplete, false);
	assert.equal(outcome.attempts, 2);
	assert.equal(repair.requests.length, 2);
	assert.match(outcome.incompleteReason, /仍不完整/);
});

test('a failed repair request preserves the first result without leaking its error', async () => {
	const firstResult = '# 首次不完整\n\n可供用户复制的内容';
	const repair = new MockRepairProvider([response(firstResult), new Error('sk-secret transcript body')]);
	const outcome = await generateVisionStructuredMarkdown(
		new MockVisionProvider([response('视觉证据文本')]),
		repair,
		'原稿',
		[resolvedImage()],
	);
	assert.equal(outcome.isComplete, false);
	assert.equal(outcome.attempts, 2);
	assert.equal(outcome.markdown, firstResult);
	assert.match(outcome.incompleteReason, /已保留首次结果/);
	assert.equal(outcome.incompleteReason.includes('sk-secret'), false);
	assert.equal(repair.requests.length, 2);
});

test('length and other incomplete finish reasons block writing without repair loops', async () => {
	for (const finishReason of ['length', 'content_filter']) {
		const repair = new MockRepairProvider([response(validVisualMarkdown(), finishReason)]);
		const outcome = await generateVisionStructuredMarkdown(
			new MockVisionProvider([response('视觉证据文本')]),
			repair,
			'原稿',
			[resolvedImage()],
		);
		assert.equal(outcome.isComplete, false);
		assert.equal(outcome.attempts, 1);
		assert.equal(repair.requests.length, 1);
	}
});

test('visual retry options never include DeepSeek or automatic text fallback', () => {
	assert.deepEqual(buildVisionRetryOptions('qwen', true).map((item) => item.providerId), ['qwen']);
	assert.deepEqual(buildVisionRetryOptions('custom', false).map((item) => item.providerId), ['custom']);
	assert.deepEqual(buildVisionRetryOptions('custom', true).map((item) => item.providerId), ['custom', 'qwen']);
});

test('applying visual output preserves original transcript and source image references', () => {
	const original = `---\nstatus: raw\n---\n\n# 主题\n\n## 原始文字稿\n\n逐字原稿  \n\n![[附件/原图.png|300]]\n\n## AI 整理结果\n\n尚未整理。\n`;
	const generated = validVisualMarkdown().replace('{{IMAGE:IMG_001}}', '![[附件/原图.png|300]]');
	const updated = applyStructuredResult(original, generated);
	assert.match(updated, /逐字原稿 {2}/);
	assert.equal(updated.split('![[附件/原图.png|300]]').length - 1, 2);
	assert.match(updated, /^status: structured$/m);
});

test('attachment content fingerprints detect same-size replacements', () => {
	const first = new Uint8Array([1, 2, 3, 4]).buffer;
	const replacement = new Uint8Array([1, 2, 3, 5]).buffer;
	assert.notEqual(fingerprintArrayBuffer(first), fingerprintArrayBuffer(replacement));
});

const serviceModule = await bundleEntry(
	"export { TFile } from 'obsidian'; export * from './ai-workflow.ts';",
	[{
		name: 'mock-obsidian-workflow',
		setup(buildApi) {
			buildApi.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'mock' }));
			buildApi.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
				contents: `
					export class TFile {
						constructor(path, content = '', bytes = new ArrayBuffer(0)) {
							this.path = path;
							this.name = path.split('/').at(-1);
							this.extension = this.name.includes('.') ? this.name.split('.').at(-1) : '';
							this.content = content;
							this.bytes = bytes;
							this.stat = { mtime: 1, size: bytes.byteLength || content.length };
						}
					}
					export const requireApiVersion = () => true;
					export const normalizePath = (value) => value.replaceAll('\\\\', '/');
					export const arrayBufferToBase64 = () => 'AAAA';
				`,
			}));
		},
	}],
);

const {
	AiWorkflowService,
	TFile,
	VISION_WORKFLOW_CONFLICT_MESSAGE,
	isVisionWorkflowConflictError,
} = serviceModule;

function pngBytes(lastByte = 0) {
	const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, lastByte]);
	return bytes.buffer;
}

function lectureNote(imageReference = '') {
	const markdownHardBreak = '  ';
	return `---
status: raw
---

# 主题

## 原始文字稿

完整原始文字稿。${markdownHardBreak}
${imageReference ? `\n${imageReference}\n` : ''}
## AI 整理结果

尚未整理。
`;
}

function completeTextMarkdown() {
	return '# 主题\n\n## 内容\n\n文字内容\n\n## 💡 核心 Takeaways（3分钟速记）\n\n- 一\n- 二\n- 三';
}

function createServiceHarness({ withImage = true, imageBytes = pngBytes(0x0a) } = {}) {
	const reference = withImage ? '![[附件/课堂图.png|300]]' : '';
	const note = new TFile('课堂笔记/测试.md', lectureNote(reference));
	note.stat.size = note.content.length;
	const attachment = new TFile('附件/课堂图.png', '', imageBytes);
	const files = new Map([[note.path, note], [attachment.path, attachment]]);
	let binaryReads = 0;
	const vault = {
		async read(file) {
			if (file.readError) throw file.readError;
			return file.content;
		},
		async readBinary(file) {
			binaryReads += 1;
			if (file.binaryReadError) throw file.binaryReadError;
			return file.bytes;
		},
		getAbstractFileByPath(path) { return files.get(path) ?? null; },
		async process(file, transform) {
			if (file.processReadError) throw file.processReadError;
			file.content = transform(file.content);
			file.stat.size = file.content.length;
			file.stat.mtime += 1;
			return file.content;
		},
		async modify(file, content) { file.content = content; },
	};
	const metadataCache = {
		getFileCache() { return null; },
		getFirstLinkpathDest(link) {
			return link === '附件/课堂图.png' ? files.get(attachment.path) ?? null : null;
		},
	};
	const workspace = { getActiveFile: () => note };
	const app = { vault, metadataCache, workspace };
	const visionProvider = new MockVisionProvider([response('视觉证据文本')]);
	const textProvider = new MockRepairProvider([response(validVisualMarkdown())]);
	const registry = {
		getActiveTextProviderId: () => 'deepseek',
		getTextProvider: () => textProvider,
		getActiveTextProvider: () => textProvider,
		getVisionProviderForConfirmedRetry: () => visionProvider,
	};
	return {
		app,
		attachment,
		files,
		note,
		registry,
		service: new AiWorkflowService(app, registry),
		textProvider,
		visionProvider,
		get binaryReads() { return binaryReads; },
	};
}

test('prepare with no images reads no attachment binary and uses only the text Provider', async () => {
	const harness = createServiceHarness({ withImage: false });
	const snapshot = await harness.service.prepare(harness.note);
	assert.equal(snapshot.imageReferences.length, 0);
	assert.equal(harness.binaryReads, 0);
	const preview = await harness.service.generate(snapshot, 'deepseek');
	assert.equal(harness.binaryReads, 0);
	assert.equal(harness.textProvider.requests.length, 1);
	assert.equal(harness.visionProvider.requests.length, 0);
	assert.equal(preview.usesVision, false);
});

test('detecting images while vision is disabled requires no binary read and text-only remains explicit', async () => {
	const harness = createServiceHarness();
	const snapshot = await harness.service.prepare(harness.note);
	assert.equal(snapshot.imageReferences.length, 1);
	assert.equal(harness.binaryReads, 0);
	await harness.service.generate(snapshot, 'deepseek');
	assert.equal(harness.binaryReads, 0);
	assert.equal(harness.textProvider.requests.length, 1);
	assert.equal(harness.visionProvider.requests.length, 0);
});

test('preparing valid visual attachments performs reads but zero Provider requests before confirmation', async () => {
	const harness = createServiceHarness();
	const snapshot = await harness.service.prepare(harness.note);
	const prepared = await harness.service.prepareVision(snapshot, 10);
	assert.equal(harness.binaryReads, 1);
	assert.equal(harness.visionProvider.requests.length, 0);
	const retainedImage = prepared.resolvedImages[0];
	harness.service.disposeVisionSnapshot(prepared);
	assert.equal(retainedImage.dataUrl, '');
	assert.equal(prepared.resolvedImages.length, 0);
	assert.equal(harness.visionProvider.requests.length, 0);
});

test('invalid image data blocks the entire visual request', async () => {
	const harness = createServiceHarness({ imageBytes: new Uint8Array([1, 2, 3, 4]).buffer });
	const snapshot = await harness.service.prepare(harness.note);
	await assert.rejects(() => harness.service.prepareVision(snapshot, 10), /魔数|为空|过短/);
	assert.equal(harness.visionProvider.requests.length, 0);
});

test('confirmed visual generation calls Qwen-VL and returns a preview without Data URLs', async () => {
	const harness = createServiceHarness();
	const snapshot = await harness.service.prepare(harness.note);
	const prepared = await harness.service.prepareVision(snapshot, 10);
	const preview = await harness.service.generateVision(prepared, 'qwen');
	assert.equal(harness.visionProvider.requests.length, 1);
	assert.equal(preview.usesVision, true);
	assert.match(preview.generatedMarkdown, /!\[\[附件\/课堂图\.png\|300\]\]/);
	assert.equal(JSON.stringify(preview).includes('data:image'), false);
	assert.equal(prepared.resolvedImages.length, 0);
});

test('confirmed Custom Vision uses the explicitly selected Provider without changing the workflow', async () => {
	const harness = createServiceHarness();
	harness.visionProvider.id = 'custom';
	harness.visionProvider.displayName = 'Mock Custom Vision';
	const snapshot = await harness.service.prepare(harness.note);
	const prepared = await harness.service.prepareVision(snapshot, 10);
	const preview = await harness.service.generateVision(prepared, 'custom');
	assert.equal(harness.visionProvider.requests.length, 1);
	assert.equal(preview.providerId, 'custom');
	assert.equal(preview.providerName, 'Mock Custom Vision');
	assert.equal(preview.usesVision, true);
});

test('a visual Provider failure clears all retained image data and leaves the note untouched', async () => {
	const harness = createServiceHarness();
	const originalContent = harness.note.content;
	harness.visionProvider.responses = [new Error('mock network failure')];
	const snapshot = await harness.service.prepare(harness.note);
	const prepared = await harness.service.prepareVision(snapshot, 10);
	const retainedImage = prepared.resolvedImages[0];
	await assert.rejects(() => harness.service.generateVision(prepared, 'qwen'), /network failure/);
	assert.equal(retainedImage.dataUrl, '');
	assert.equal(prepared.resolvedImages.length, 0);
	assert.equal(prepared.attachmentSnapshots.length, 0);
	assert.equal(harness.note.content, originalContent);
});

test('a latest note read failure blocks the visual request and clears image data', async () => {
	const harness = createServiceHarness();
	const snapshot = await harness.service.prepare(harness.note);
	const prepared = await harness.service.prepareVision(snapshot, 10);
	harness.note.readError = new Error('mock latest note read failure');
	await assert.rejects(() => harness.service.generateVision(prepared, 'qwen'), /latest note read failure/);
	assert.equal(harness.visionProvider.requests.length, 0);
	assert.equal(prepared.resolvedImages.length, 0);
});

test('a note edit after confirmation blocks the network request and clears image references', async () => {
	const harness = createServiceHarness();
	const snapshot = await harness.service.prepare(harness.note);
	const prepared = await harness.service.prepareVision(snapshot, 10);
	harness.note.content = harness.note.content.replace('完整原始文字稿', '外部修改');
	await assert.rejects(() => harness.service.generateVision(prepared, 'qwen'), /发生变化/);
	assert.equal(harness.visionProvider.requests.length, 0);
	assert.equal(prepared.resolvedImages.length, 0);
});

test('attachment deletion, modification, or latest read failure blocks requests before Provider calls', async () => {
	for (const mutate of [
		(harness) => harness.files.delete(harness.attachment.path),
		(harness) => { harness.attachment.path = '附件/课堂图-已改名.png'; },
		(harness) => { harness.attachment.stat.mtime += 1; },
		(harness) => { harness.attachment.binaryReadError = new Error('mock latest read failure'); },
	]) {
		const harness = createServiceHarness();
		const snapshot = await harness.service.prepare(harness.note);
		const prepared = await harness.service.prepareVision(snapshot, 10);
		mutate(harness);
		await assert.rejects(
			() => harness.service.generateVision(prepared, 'qwen'),
			(error) => isVisionWorkflowConflictError(error),
		);
		assert.equal(harness.visionProvider.requests.length, 0);
	}
});

test('an incomplete visual finish reason produces a copyable preview that cannot be written', async () => {
	const harness = createServiceHarness();
	harness.visionProvider.responses = [response('视觉证据文本')];
	harness.textProvider.responses = [response(validVisualMarkdown(), 'length')];
	const snapshot = await harness.service.prepare(harness.note);
	const prepared = await harness.service.prepareVision(snapshot, 10);
	const preview = await harness.service.generateVision(prepared, 'qwen');
	assert.equal(preview.isComplete, false);
	assert.match(preview.generatedMarkdown, /Takeaways/);
	await assert.rejects(() => harness.service.write(preview), /不完整/);
	assert.equal(harness.note.content, snapshot.originalContent);
});

test('same-size attachment replacement is detected by content fingerprint before a request', async () => {
	const harness = createServiceHarness();
	const snapshot = await harness.service.prepare(harness.note);
	const prepared = await harness.service.prepareVision(snapshot, 10);
	harness.attachment.bytes = pngBytes(0x0b);
	await assert.rejects(
		() => harness.service.generateVision(prepared, 'qwen'),
		(error) => isVisionWorkflowConflictError(error),
	);
	assert.equal(harness.visionProvider.requests.length, 0);
});

test('note changes during the request keep the preview copyable but block writing', async () => {
	const harness = createServiceHarness();
	harness.visionProvider.responses = [{
		content: validVisualMarkdown(),
		finishReason: 'stop',
	}];
	harness.visionProvider.generateVision = async function generateVision(request) {
		this.requests.push(request);
		harness.note.content = harness.note.content.replace('完整原始文字稿', '请求期间修改');
		return response(validVisualMarkdown());
	};
	const snapshot = await harness.service.prepare(harness.note);
	const prepared = await harness.service.prepareVision(snapshot, 10);
	const preview = await harness.service.generateVision(prepared, 'qwen');
	await assert.rejects(() => harness.service.write(preview), /发生变化|取消写入/);
	assert.equal(preview.generatedMarkdown.includes('data:image'), false);
});

test('attachment changes during the request block final writing with the unified conflict message', async () => {
	const harness = createServiceHarness();
	harness.visionProvider.generateVision = async function generateVision(request) {
		this.requests.push(request);
		harness.attachment.stat.mtime += 1;
		return response(validVisualMarkdown());
	};
	const snapshot = await harness.service.prepare(harness.note);
	const prepared = await harness.service.prepareVision(snapshot, 10);
	const preview = await harness.service.generateVision(prepared, 'qwen');
	await assert.rejects(
		() => harness.service.write(preview),
		(error) => error.message === VISION_WORKFLOW_CONFLICT_MESSAGE,
	);
});

test('unchanged visual results write atomically, preserve sources, and cannot be written twice', async () => {
	const harness = createServiceHarness();
	const originalReference = '![[附件/课堂图.png|300]]';
	const snapshot = await harness.service.prepare(harness.note);
	const prepared = await harness.service.prepareVision(snapshot, 10);
	const preview = await harness.service.generateVision(prepared, 'qwen');
	await harness.service.write(preview);
	assert.match(harness.note.content, /^status: structured$/m);
	assert.equal(harness.note.content.split(originalReference).length - 1, 2);
	assert.match(harness.note.content, /<!-- lecture-workflow:ai:start -->/);
	await assert.rejects(() => harness.service.write(preview), /发生变化|取消写入/);
	assert.equal(harness.note.content.split('<!-- lecture-workflow:ai:start -->').length - 1, 1);
});

test('renamed or deleted note targets cancel final writing safely', async () => {
	for (const mutate of [
		(harness) => harness.files.delete(harness.note.path),
		(harness) => { harness.note.path = '课堂笔记/已改名.md'; },
	]) {
		const harness = createServiceHarness();
		const snapshot = await harness.service.prepare(harness.note);
		const prepared = await harness.service.prepareVision(snapshot, 10);
		const preview = await harness.service.generateVision(prepared, 'qwen');
		mutate(harness);
		await assert.rejects(() => harness.service.write(preview));
	}
});
