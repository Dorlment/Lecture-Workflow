import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { build } from 'esbuild';

async function bundleEntry(contents, plugins = []) {
	const bundle = await build({
		stdin: {
			contents,
			resolveDir: process.cwd(),
			sourcefile: 'generation-diagnostics-test-entry.ts',
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
		throw new Error('Failed to bundle diagnostics test entry.');
	}
	return import(`data:text/javascript,${encodeURIComponent(source)}`);
}

const module_ = await bundleEntry([
	"export * from './generation-diagnostics.ts';",
	"export * from './ai-generation.ts';",
	"export * from './vision-generation.ts';",
].join('\n'));

const {
	estimateInputTokens,
	generateStructuredMarkdown,
	generateVisionStructuredMarkdown,
} = module_;

class MockTextProvider {
	id = 'deepseek';
	displayName = 'Mock DeepSeek';
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

class MockVisionProvider {
	id = 'qwen';
	displayName = 'Mock Qwen-VL';
	capabilities = { text: true, vision: true, speech: false };
	requests = [];

	constructor(responses = []) {
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

function response(content, finishReason = 'stop') {
	return { content, finishReason };
}

function completeMarkdown() {
	return '# 主题\n\n## 内容\n\n文字内容\n\n## 💡 核心 Takeaways（3分钟速记）\n\n- 一\n- 二\n- 三';
}

function validVisualMarkdown() {
	return `# 课堂主题

## 核心知识

重点内容。

{{IMAGE:IMG_001}}

## 💡 核心 Takeaways（3分钟速记）

- 结论一
- 结论二
- 结论三`;
}

function resolvedImage(id = 'IMG_001') {
	return {
		id,
		vaultPath: `附件/${id}.png`,
		originalReference: `![[附件/${id}.png|说明]]`,
		mimeType: 'image/png',
		byteLength: 8,
		mtime: 1,
		dataUrl: 'data:image/png;base64,AAAA',
		nearbyContext: `${id} 的附近文字`,
	};
}

function assertDuration(value, label) {
	assert.equal(typeof value, 'number', `${label} must be a number`);
	assert.ok(value >= 0, `${label} must be >= 0`);
}

test('token estimate is a rough chars/2 ceiling without a tokenizer dependency', () => {
	assert.equal(estimateInputTokens(0), 0);
	assert.equal(estimateInputTokens(1), 1);
	assert.equal(estimateInputTokens(100), 50);
	assert.equal(estimateInputTokens(101), 51);
});

test('production keeps diagnostics in outcomes without benchmark console logging', async () => {
	const [diagnosticsSource, mainSource] = await Promise.all([
		readFile('generation-diagnostics.ts', 'utf8'),
		readFile('main.ts', 'utf8'),
	]);
	assert.doesNotMatch(diagnosticsSource, /console\./);
	assert.doesNotMatch(mainSource, /logGenerationBenchmark|\[LectureWorkflow\]\[benchmark\]/);
});

test('text-only success records transcriptChars, attempts=1 and real finishReason', async () => {
	const transcript = '原始文字稿内容';
	const provider = new MockTextProvider([response(completeMarkdown())]);
	const outcome = await generateStructuredMarkdown(provider, transcript);
	const diagnostics = outcome.diagnostics;
	assert.ok(diagnostics);
	assert.equal(diagnostics.transcriptChars, transcript.length);
	assert.equal(diagnostics.estimatedInputTokens, Math.ceil(transcript.length / 2));
	assert.equal(diagnostics.sourceImageCount, 0);
	assert.equal(diagnostics.selectedImageCount, 0);
	assert.equal(diagnostics.visionDurationMs, undefined);
	assertDuration(diagnostics.textDurationMs, 'textDurationMs');
	assertDuration(diagnostics.totalDurationMs, 'totalDurationMs');
	assert.equal(diagnostics.finishReason, 'stop');
	assert.equal(diagnostics.attempts, 1);
	assert.equal(diagnostics.isComplete, true);
	assert.equal(diagnostics.incompleteReason, null);
});

test('finishReason=length is recorded as incomplete with a single attempt', async () => {
	const provider = new MockTextProvider([response(completeMarkdown(), 'length')]);
	const outcome = await generateStructuredMarkdown(provider, '原始文字稿');
	assert.equal(outcome.isComplete, false);
	assert.equal(outcome.diagnostics.finishReason, 'length');
	assert.equal(outcome.diagnostics.attempts, 1);
	assert.equal(outcome.diagnostics.isComplete, false);
	assert.match(outcome.diagnostics.incompleteReason, /输出长度限制/);
	assert.equal(provider.requests.length, 1);
});

test('format repair records attempts=2 and accumulated text duration', async () => {
	const provider = new MockTextProvider([
		response('# 初稿\n\n没有速记区'),
		response(completeMarkdown()),
	]);
	const outcome = await generateStructuredMarkdown(provider, '原始文字稿');
	assert.equal(outcome.isComplete, true);
	assert.equal(outcome.diagnostics.attempts, 2);
	assert.equal(outcome.diagnostics.finishReason, 'stop');
	assertDuration(outcome.diagnostics.textDurationMs, 'textDurationMs');
	assert.ok(outcome.diagnostics.totalDurationMs >= outcome.diagnostics.textDurationMs);
});

test('vision path records image counts and separate vision/text durations', async () => {
	const vision = new MockVisionProvider([response('视觉证据文本')]);
	const text = new MockTextProvider([response(validVisualMarkdown())]);
	const transcript = '原始文字稿';
	const outcome = await generateVisionStructuredMarkdown(
		vision,
		text,
		transcript,
		[resolvedImage()],
		undefined,
		undefined,
		3,
	);
	const diagnostics = outcome.diagnostics;
	assert.ok(diagnostics);
	assert.equal(diagnostics.transcriptChars, transcript.length);
	assert.equal(diagnostics.sourceImageCount, 3);
	assert.equal(diagnostics.selectedImageCount, 1);
	assertDuration(diagnostics.visionDurationMs, 'visionDurationMs');
	assertDuration(diagnostics.textDurationMs, 'textDurationMs');
	assertDuration(diagnostics.totalDurationMs, 'totalDurationMs');
	assert.equal(diagnostics.finishReason, 'stop');
	assert.equal(diagnostics.attempts, 1, 'vision provider calls are not counted as text attempts');
	assert.equal(diagnostics.isComplete, true);
});

test('vision sourceImageCount defaults to the selected count when not provided', async () => {
	const vision = new MockVisionProvider([response('视觉证据文本')]);
	const text = new MockTextProvider([response(validVisualMarkdown())]);
	const outcome = await generateVisionStructuredMarkdown(
		vision,
		text,
		'原稿',
		[resolvedImage()],
	);
	assert.equal(outcome.diagnostics.sourceImageCount, 1);
	assert.equal(outcome.diagnostics.selectedImageCount, 1);
});

const serviceModule = await bundleEntry(
	"export { TFile } from 'obsidian'; export * from './ai-workflow.ts';",
	[{
		name: 'mock-obsidian-diagnostics',
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

const { AiWorkflowService, TFile } = serviceModule;

test('preview data carries diagnostics with source and selected image counts', async () => {
	const reference = '![[附件/课堂图.png|300]]';
	const note = new TFile(
		'课堂笔记/测试.md',
		`---\nstatus: raw\n---\n\n# 主题\n\n## 原始文字稿\n\n完整原始文字稿。  \n\n${reference}\n\n## AI 整理结果\n\n尚未整理。\n`,
	);
	const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer;
	const attachment = new TFile('附件/课堂图.png', '', pngBytes);
	const files = new Map([[note.path, note], [attachment.path, attachment]]);
	const vault = {
		async read(file) { return file.content; },
		async readBinary(file) { return file.bytes; },
		getAbstractFileByPath(path) { return files.get(path) ?? null; },
	};
	const metadataCache = {
		getFileCache() { return null; },
		getFirstLinkpathDest(link) {
			return link === '附件/课堂图.png' ? attachment : null;
		},
	};
	const workspace = { getActiveFile: () => note };
	const app = { vault, metadataCache, workspace };
	const visionProvider = new MockVisionProvider([response('视觉证据文本')]);
	const textProvider = new MockTextProvider([response(validVisualMarkdown())]);
	const registry = {
		getActiveTextProviderId: () => 'deepseek',
		getTextProvider: () => textProvider,
		getActiveTextProvider: () => textProvider,
		getVisionProviderForConfirmedRetry: () => visionProvider,
	};
	const service = new AiWorkflowService(app, registry);
	const snapshot = await service.prepare(note);
	const prepared = await service.prepareVision(snapshot, 10);
	const preview = await service.generateVision(prepared, 'qwen');
	assert.ok(preview.diagnostics);
	assert.equal(preview.diagnostics.sourceImageCount, 1);
	assert.equal(preview.diagnostics.selectedImageCount, 1);
	assertDuration(preview.diagnostics.visionDurationMs, 'visionDurationMs');
	assertDuration(preview.diagnostics.textDurationMs, 'textDurationMs');
	assert.equal(preview.diagnostics.attempts, 1);
	assert.equal(preview.diagnostics.isComplete, true);
	assert.equal(preview.diagnostics.finishReason, 'stop');
});
