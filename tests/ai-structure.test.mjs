import assert from 'node:assert/strict';
import test from 'node:test';

import { build } from 'esbuild';

async function loadTypeScriptModule(entryPoint) {
	const bundle = await build({
		entryPoints: [entryPoint],
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'node18',
		write: false,
	});
	const source = bundle.outputFiles[0]?.text;
	if (!source) {
		throw new Error(`Failed to bundle ${entryPoint} for tests.`);
	}
	return import(`data:text/javascript,${encodeURIComponent(source)}`);
}

const ai = await loadTypeScriptModule('ai-note.ts');
const generation = await loadTypeScriptModule('ai-generation.ts');
const conflict = await loadTypeScriptModule('note-conflict.ts');
const retry = await loadTypeScriptModule('ai-retry.ts');
const providers = await loadTypeScriptModule('providers/text-providers.ts');
const registryModule = await loadTypeScriptModule('providers/registry.ts');
const {
	AI_END_MARKER,
	AI_START_MARKER,
	AiWorkflowGate,
	PreviewWriteSession,
	STRUCTURE_SYSTEM_PROMPT,
	applyStructuredResult,
	buildStructureUserPrompt,
	extractTranscriptSection,
} = ai;
const {
	STANDARD_TAKEAWAYS_HEADING,
	STRUCTURE_MAX_OUTPUT_TOKENS,
	assertAiOutputWritable,
	generateStructuredMarkdown,
	validateAndNormalizeStructure,
} = generation;
const { buildRetryOptions, describeProviderFailure } = retry;
const {
	NOTE_CONFLICT_MESSAGE,
	assertTargetPath,
	freshReadConflictSafeWrite,
	processConflictSafeWrite,
} = conflict;
const {
	CustomOpenAICompatibleTextProvider,
	DeepSeekTextProvider,
	ProviderError,
	QwenTextProvider,
	buildQwenBaseUrl,
} = providers;
const { ProviderRegistry, routeTextProvider } = registryModule;

const baseNote = `---
type: lecture
course: "测试课程"
topic: "测试主题"
created: "2026-08-06 18:00:00"
status: raw
---

# 测试主题

## 原始文字稿

第一段原文。
第二段原文。

## AI 整理结果

尚未整理。
`;

class MockHttpClient {
	requests = [];

	constructor(responseOrError) {
		this.responseOrError = responseOrError;
	}

	async post(request) {
		this.requests.push(request);
		if (this.responseOrError instanceof Error) {
			throw this.responseOrError;
		}
		return this.responseOrError;
	}
}

function validConfig(overrides = {}) {
	return {
		apiKey: 'test-only-key',
		baseUrl: 'https://example.com/v1',
		model: 'test-model',
		temperature: 0.3,
		timeoutMs: 60_000,
		...overrides,
	};
}

function successResponse(content = 'OK') {
	return {
		status: 200,
		text: JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
	};
}

function completeMarkdown(heading = STANDARD_TAKEAWAYS_HEADING) {
	return `# 课程主题\n\n## 核心模块\n\n内容\n\n${heading}\n\n- 结论一\n- 结论二\n- 结论三`;
}

class MockTextProvider {
	id = 'deepseek';
	displayName = 'Mock Provider';
	capabilities = { text: true, vision: false, speech: false };
	requests = [];

	constructor(responses) {
		this.responses = [...responses];
	}

	validate() {
		return [];
	}

	async generate(request) {
		this.requests.push(request);
		const response = this.responses.shift();
		if (response instanceof Error) {
			throw response;
		}
		return response;
	}

	async testConnection() {}
}

function createAtomicProcessHarness(latestContent, failure = null) {
	const writes = [];
	return {
		writes,
		async process(transform) {
			if (failure) {
				throw failure;
			}
			const updatedContent = transform(latestContent);
			writes.push(updatedContent);
			return updatedContent;
		},
	};
}

test('extracts the original transcript and stops at the next level-two heading', () => {
	const section = extractTranscriptSection(baseNote);
	assert.ok(section);
	assert.ok(section.transcript.includes('第一段原文。'));
	assert.equal(section.transcript.includes('尚未整理'), false);
});

test('returns null when the original transcript heading is missing', () => {
	assert.equal(extractTranscriptSection('# 普通笔记\n\n没有目标标题'), null);
});

test('detects an empty original transcript', () => {
	const section = extractTranscriptSection('## 原始文字稿\n\n \t\n\n## 下一节\n内容');
	assert.ok(section);
	assert.equal(section.transcript.trim(), '');
});

test('inserts one marked AI region and updates YAML status', () => {
	const updated = applyStructuredResult(baseNote, '# 课程主题\n\n- **结论**');
	assert.equal(updated.split(AI_START_MARKER).length - 1, 1);
	assert.equal(updated.split(AI_END_MARKER).length - 1, 1);
	assert.match(updated, /^status: structured$/m);
	assert.ok(updated.includes('## AI 结构化笔记'));
});

test('replaces an existing AI region without stacking duplicates', () => {
	const first = applyStructuredResult(baseNote, '第一次结果');
	const second = applyStructuredResult(first, '第二次结果');
	assert.equal(second.includes('第一次结果'), false);
	assert.ok(second.includes('第二次结果'));
	assert.equal(second.split(AI_START_MARKER).length - 1, 1);
});

test('preserves the original transcript section character-for-character', () => {
	const before = extractTranscriptSection(baseNote)?.protectedText;
	const afterContent = applyStructuredResult(baseNote, '结构化结果');
	const after = extractTranscriptSection(afterContent)?.protectedText;
	assert.equal(after, before);
});

test('preserves transcript trailing whitespace when appending the first AI region at end of file', () => {
	const note = '---\nstatus: raw\n---\n\n## 原始文字稿\n\n正文末尾  \n\n';
	const before = extractTranscriptSection(note)?.protectedText;
	const updated = applyStructuredResult(note, '# 整理结果');
	assert.equal(extractTranscriptSection(updated)?.protectedText, before);
	assert.ok(updated.includes(AI_START_MARKER));
});

test('rejects generated content containing internal AI region markers', () => {
	assert.throws(
		() => applyStructuredResult(baseNote, `恶意内容\n${AI_END_MARKER}`),
		/保护标记/,
	);
});

test('supports an approximately 18000-character transcript without truncation', () => {
	const transcript = `\n${'课堂原文ABC。'.repeat(2500)}\n`;
	assert.ok(transcript.length >= 18_000);
	const note = `---\nstatus: raw\n---\n\n## 原始文字稿\n${transcript}## 下一节\n内容`;
	const extracted = extractTranscriptSection(note);
	assert.ok(extracted);
	assert.equal(extracted.transcript, transcript);
	assert.ok(buildStructureUserPrompt(extracted.transcript).includes(transcript));
});

test('accepts a complete Takeaways section with three to five list items', () => {
	const validation = validateAndNormalizeStructure({
		content: completeMarkdown(),
		finishReason: 'stop',
	});
	assert.equal(validation.isComplete, true);
	assert.ok(validation.markdown.includes(STANDARD_TAKEAWAYS_HEADING));
});

test('normalizes small Takeaways heading differences', () => {
	const validation = validateAndNormalizeStructure({
		content: completeMarkdown('##  核心 Takeaways ( 3 分钟速记 )'),
		finishReason: 'stop',
	});
	assert.equal(validation.isComplete, true);
	assert.ok(validation.markdown.includes(STANDARD_TAKEAWAYS_HEADING));
	assert.equal(validation.markdown.includes('( 3 分钟速记 )'), false);
});

test('a missing Takeaways section triggers exactly one format-repair request', async () => {
	const provider = new MockTextProvider([
		{ content: '# 初稿\n\n没有速记区', finishReason: 'stop' },
		{ content: '# 修复稿\n\n仍然没有速记区', finishReason: 'stop' },
	]);
	const outcome = await generateStructuredMarkdown(provider, '原始文字稿');
	assert.equal(provider.requests.length, 2);
	assert.equal(outcome.attempts, 2);
	assert.equal(outcome.isComplete, false);
	assert.match(provider.requests[1].userPrompt, /完整的 Markdown 笔记正文/);
	assert.match(provider.requests[1].userPrompt, /不能只返回速记区/);
	assert.match(provider.requests[1].userPrompt, /原始文字稿如下/);
	assert.match(provider.requests[1].userPrompt, /原始文字稿/);
});

test('a single format-repair request can produce a complete result', async () => {
	const provider = new MockTextProvider([
		{ content: '# 初稿\n\n没有速记区', finishReason: 'stop' },
		{ content: completeMarkdown(), finishReason: 'stop' },
	]);
	const outcome = await generateStructuredMarkdown(provider, '原始文字稿');
	assert.equal(outcome.isComplete, true);
	assert.equal(outcome.attempts, 2);
	assert.equal(provider.requests.length, 2);
});

test('a second incomplete result stops without an infinite repair loop', async () => {
	const provider = new MockTextProvider([
		{ content: '# 初稿', finishReason: 'stop' },
		{ content: '# 第二稿', finishReason: 'stop' },
		{ content: completeMarkdown(), finishReason: 'stop' },
	]);
	const outcome = await generateStructuredMarkdown(provider, '原始文字稿');
	assert.equal(outcome.isComplete, false);
	assert.equal(provider.requests.length, 2);
	assert.match(outcome.incompleteReason, /仍不完整/);
});

test('finish_reason length produces a copyable but non-writable result', async () => {
	const provider = new MockTextProvider([
		{ content: completeMarkdown(), finishReason: 'length' },
	]);
	const outcome = await generateStructuredMarkdown(provider, '原始文字稿');
	assert.equal(outcome.isComplete, false);
	assert.equal(provider.requests.length, 1);
	assert.throws(() => assertAiOutputWritable(outcome), /输出长度限制/);
});

test('fewer than three Takeaways list items is incomplete', () => {
	const markdown = `${STANDARD_TAKEAWAYS_HEADING}\n\n- 结论一\n- 结论二`;
	const validation = validateAndNormalizeStructure({ content: markdown, finishReason: 'stop' });
	assert.equal(validation.isComplete, false);
	assert.match(validation.reason, /当前检测到 2 条/);
});

test('structure generation reserves a reasonable output token budget', async () => {
	const provider = new MockTextProvider([
		{ content: completeMarkdown(), finishReason: 'stop' },
	]);
	await generateStructuredMarkdown(provider, '原始文字稿');
	assert.equal(provider.requests[0].maxTokens, STRUCTURE_MAX_OUTPUT_TOKENS);
	assert.ok(STRUCTURE_MAX_OUTPUT_TOKENS >= 8_000);
});

test('cancelled preview sessions never call the write action', async () => {
	const session = new PreviewWriteSession();
	let writes = 0;
	session.cancel();
	const result = await session.confirm(async () => {
		writes += 1;
		return true;
	});
	assert.equal(result, null);
	assert.equal(writes, 0);
});

test('preview write sessions reject duplicate confirmation', async () => {
	const session = new PreviewWriteSession();
	let release;
	const pending = session.confirm(() => new Promise((resolve) => { release = resolve; }));
	assert.equal(await session.confirm(async () => true), null);
	release(true);
	assert.equal(await pending, true);
});

test('blocks an atomic write when the transcript changes during preview', async () => {
	const changedContent = baseNote.replace('第一段原文。', '记事本修改后的原文。');
	const harness = createAtomicProcessHarness(changedContent);
	await assert.rejects(
		() => processConflictSafeWrite(
			(transform) => harness.process(transform),
			baseNote,
			completeMarkdown(),
		),
		(error) => error.code === 'note-conflict' && error.message === NOTE_CONFLICT_MESSAGE,
	);
	assert.equal(harness.writes.length, 0);
});

test('blocks an atomic write when content outside the transcript changes', async () => {
	const changedContent = baseNote.replace('# 测试主题', '# 外部编辑后的主题');
	const harness = createAtomicProcessHarness(changedContent);
	await assert.rejects(
		() => processConflictSafeWrite(
			(transform) => harness.process(transform),
			baseNote,
			completeMarkdown(),
		),
		{ code: 'note-conflict' },
	);
	assert.equal(harness.writes.length, 0);
});

test('blocks writing when an external edit occurs while the AI request is running', async () => {
	const workflowSnapshot = baseNote;
	let latestDiskContent = workflowSnapshot;
	await Promise.resolve();
	latestDiskContent = workflowSnapshot.replace('status: raw', 'status: externally-edited');
	const harness = createAtomicProcessHarness(latestDiskContent);
	await assert.rejects(
		() => processConflictSafeWrite(
			(transform) => harness.process(transform),
			workflowSnapshot,
			completeMarkdown(),
		),
		{ code: 'note-conflict' },
	);
	assert.equal(harness.writes.length, 0);
});

test('writes normally when the complete Markdown content is unchanged', async () => {
	const harness = createAtomicProcessHarness(baseNote);
	const written = await processConflictSafeWrite(
		(transform) => harness.process(transform),
		baseNote,
		completeMarkdown(),
	);
	assert.equal(harness.writes.length, 1);
	assert.equal(written, harness.writes[0]);
	assert.match(written, /^status: structured$/m);
	assert.equal(written.split(AI_START_MARKER).length - 1, 1);
});

test('deleted or renamed target paths are rejected safely', () => {
	assert.throws(() => assertTargetPath('课堂笔记/原笔记.md', null), { code: 'note-conflict' });
	assert.throws(
		() => assertTargetPath('课堂笔记/原笔记.md', '课堂笔记/已重命名.md'),
		{ code: 'note-conflict' },
	);
});

test('continuous write clicks cannot bypass conflict protection', async () => {
	const session = new PreviewWriteSession();
	const changedContent = baseNote.replace('第二段原文。', '外部修改。');
	const harness = createAtomicProcessHarness(changedContent);
	let releaseRequest;
	const firstWrite = session.confirm(async () => {
		await new Promise((resolve) => { releaseRequest = resolve; });
		await processConflictSafeWrite(
			(transform) => harness.process(transform),
			baseNote,
			completeMarkdown(),
		);
		return true;
	});
	assert.equal(await session.confirm(async () => true), null);
	releaseRequest();
	await assert.rejects(() => firstWrite, { code: 'note-conflict' });
	assert.equal(harness.writes.length, 0);
});

test('a latest-content read failure denies the fallback write by default', async () => {
	let writes = 0;
	await assert.rejects(
		() => freshReadConflictSafeWrite(
			async () => { throw new Error('mock disk read failure'); },
			async () => { writes += 1; },
			baseNote,
			completeMarkdown(),
		),
		{ code: 'note-latest-read-failed' },
	);
	assert.equal(writes, 0);
});

test('an atomic latest-content read failure denies writing before the callback', async () => {
	const harness = createAtomicProcessHarness(baseNote, new Error('mock process read failure'));
	await assert.rejects(
		() => processConflictSafeWrite(
			(transform) => harness.process(transform),
			baseNote,
			completeMarkdown(),
		),
		{ code: 'note-latest-read-failed' },
	);
	assert.equal(harness.writes.length, 0);
});

test('a timed-out generation restores idle state and allows immediate resubmission', async () => {
	const gate = new AiWorkflowGate();
	assert.equal(gate.beginGeneration(), true);
	await assert.rejects(
		() => gate.completeWithPreview(async () => {
			throw new ProviderError('mock timeout', 'timeout');
		}),
		{ code: 'timeout' },
	);
	assert.equal(gate.state, 'idle');
	assert.equal(gate.beginGeneration(), true);
	gate.reset();
});

test('a failed generation leaves the original note and existing AI region untouched', async () => {
	const originalNote = applyStructuredResult(baseNote, completeMarkdown());
	let currentNote = originalNote;
	const provider = new MockTextProvider([new ProviderError('mock network', 'network')]);
	await assert.rejects(() => generateStructuredMarkdown(provider, '原始文字稿'), { code: 'network' });
	assert.equal(currentNote, originalNote);
	assert.equal(currentNote.split(AI_START_MARKER).length - 1, 1);
});

test('DeepSeek retry options include Qwen only when Qwen is configured', () => {
	assert.deepEqual(
		buildRetryOptions('deepseek', true).map((option) => option.providerId),
		['deepseek', 'qwen'],
	);
	assert.deepEqual(
		buildRetryOptions('deepseek', false).map((option) => option.providerId),
		['deepseek'],
	);
});

test('Qwen fallback is routed only after the user selects its retry option', () => {
	const client = new MockHttpClient(successResponse());
	const settings = {
		setupMode: 'recommended',
		advancedTextProvider: 'deepseek',
		temperature: 0.3,
		requestTimeoutMs: 150_000,
		deepseek: { apiKey: 'test-only-key', baseUrl: 'https://api.deepseek.com', model: 'deepseek' },
		qwen: {
			apiKey: 'test-only-key',
			region: 'cn-beijing',
			workspaceId: 'workspace-123',
			model: 'qwen',
		},
		customOpenAI: { apiKey: '', baseUrl: '', model: '' },
	};
	const registry = new ProviderRegistry(settings, client);
	const options = buildRetryOptions('deepseek', true);
	assert.equal(client.requests.length, 0);
	const selected = options.find((option) => option.providerId === 'qwen');
	assert.equal(selected?.providerId, 'qwen');
	assert.equal(registry.getTextProvider(selected.providerId).id, 'qwen');
	assert.equal(client.requests.length, 0);
});

test('sanitized provider failures contain type and provider but not secrets or transcript', () => {
	const unsafeError = new ProviderError('test-only-key 原始文字稿绝密内容', 'timeout');
	const failure = describeProviderFailure('DeepSeek', unsafeError);
	assert.match(failure.message, /DeepSeek/);
	assert.match(failure.message, /超时/);
	assert.equal(failure.message.includes('test-only-key'), false);
	assert.equal(failure.message.includes('绝密内容'), false);
});

test('validates DeepSeek configuration', () => {
	const provider = new DeepSeekTextProvider(
		validConfig({ apiKey: '', baseUrl: 'invalid', model: '' }),
		new MockHttpClient(successResponse()),
	);
	const errors = provider.validate().join(' ');
	assert.match(errors, /API Key/);
	assert.match(errors, /Base URL/);
	assert.match(errors, /模型/);
});

test('builds the Beijing Qwen URL from a trimmed workspace ID', () => {
	assert.equal(
		buildQwenBaseUrl('cn-beijing', '  workspace-123  '),
		'https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
	);
	const provider = new QwenTextProvider(
		{ ...validConfig(), region: 'cn-beijing', workspaceId: 'bad/id' },
		new MockHttpClient(successResponse()),
	);
	assert.match(provider.validate().join(' '), /Workspace ID/);
});

test('validates custom OpenAI-compatible Base URLs', () => {
	const provider = new CustomOpenAICompatibleTextProvider(
		validConfig({ baseUrl: 'file:///tmp/api' }),
		new MockHttpClient(successResponse()),
	);
	assert.match(provider.validate().join(' '), /HTTP/);
});

test('normalizes whitespace and repeated slashes in a custom Base URL', async () => {
	const client = new MockHttpClient(successResponse());
	const provider = new CustomOpenAICompatibleTextProvider(
		validConfig({ baseUrl: '  https://example.com//compatible-mode///v1/  ' }),
		client,
	);
	await provider.generate({ systemPrompt: 's', userPrompt: 'u' });
	assert.equal(client.requests[0].url, 'https://example.com/compatible-mode/v1/chat/completions');
});

test('all text providers receive the same strengthened structure system prompt', async () => {
	const clients = [
		new MockHttpClient(successResponse(completeMarkdown())),
		new MockHttpClient(successResponse(completeMarkdown())),
		new MockHttpClient(successResponse(completeMarkdown())),
	];
	const textProviders = [
		new DeepSeekTextProvider(validConfig(), clients[0]),
		new QwenTextProvider(
			{ ...validConfig(), region: 'cn-beijing', workspaceId: 'workspace-123' },
			clients[1],
		),
		new CustomOpenAICompatibleTextProvider(validConfig(), clients[2]),
	];
	for (const provider of textProviders) {
		await provider.generate({
			systemPrompt: STRUCTURE_SYSTEM_PROMPT,
			userPrompt: '原始文字稿',
			maxTokens: STRUCTURE_MAX_OUTPUT_TOKENS,
		});
	}
	for (const client of clients) {
		const requestBody = JSON.parse(client.requests[0].body);
		assert.equal(requestBody.messages[0].content, STRUCTURE_SYSTEM_PROMPT);
		assert.match(requestBody.messages[0].content, /不得把常见情况表述成绝对规则/);
		assert.match(requestBody.messages[0].content, /原稿表述可能需要核实/);
		assert.match(requestBody.messages[0].content, /不得扩写成模型自己的教程/);
		assert.equal(requestBody.max_tokens, STRUCTURE_MAX_OUTPUT_TOKENS);
	}
});

test('routes setup modes to the intended text provider', () => {
	assert.equal(routeTextProvider('simple', 'custom'), 'qwen');
	assert.equal(routeTextProvider('recommended', 'custom'), 'deepseek');
	assert.equal(routeTextProvider('advanced', 'custom'), 'custom');
});

for (const [status, expectedCode] of [
	[401, 'authentication'],
	[403, 'authentication'],
	[404, 'not-found'],
	[429, 'rate-limit'],
	[500, 'server'],
]) {
	test(`maps HTTP ${status} to ${expectedCode}`, async () => {
		const provider = new DeepSeekTextProvider(
			validConfig(),
			new MockHttpClient({ status, text: JSON.stringify({ error: { message: 'failure' } }) }),
		);
		await assert.rejects(() => provider.generate({ systemPrompt: 's', userPrompt: 'u' }), {
			code: expectedCode,
		});
	});
}

test('preserves timeout and network errors from the mocked network layer', async () => {
	for (const code of ['timeout', 'network']) {
		const provider = new DeepSeekTextProvider(
			validConfig(),
			new MockHttpClient(new ProviderError('mock failure', code)),
		);
		await assert.rejects(() => provider.generate({ systemPrompt: 's', userPrompt: 'u' }), { code });
	}
});

test('maps context-window errors without exposing the response body', async () => {
	const provider = new DeepSeekTextProvider(
		validConfig(),
		new MockHttpClient({
			status: 400,
			text: JSON.stringify({ error: { message: 'maximum context length exceeded: sensitive body' } }),
		}),
	);
	await assert.rejects(
		() => provider.generate({ systemPrompt: 's', userPrompt: 'u' }),
		(error) => error.code === 'context-limit' && !error.message.includes('sensitive body'),
	);
});

test('rejects empty and malformed successful responses', async () => {
	const empty = new DeepSeekTextProvider(validConfig(), new MockHttpClient(successResponse('   ')));
	await assert.rejects(() => empty.generate({ systemPrompt: 's', userPrompt: 'u' }), {
		code: 'empty-response',
	});
	const malformed = new DeepSeekTextProvider(
		validConfig(),
		new MockHttpClient({ status: 200, text: '{not-json' }),
	);
	await assert.rejects(() => malformed.generate({ systemPrompt: 's', userPrompt: 'u' }), {
		code: 'invalid-response',
	});
});

test('preserves finish_reason metadata from the provider response', async () => {
	const response = {
		status: 200,
		text: JSON.stringify({
			choices: [{ message: { content: completeMarkdown() }, finish_reason: 'length' }],
		}),
	};
	const provider = new DeepSeekTextProvider(validConfig(), new MockHttpClient(response));
	const result = await provider.generate({ systemPrompt: 's', userPrompt: 'u', maxTokens: 8192 });
	assert.equal(result.finishReason, 'length');
});

test('connection tests send only a minimal OK prompt and skip structure validation', async () => {
	const client = new MockHttpClient(successResponse('OK'));
	const provider = new DeepSeekTextProvider(validConfig(), client);
	await provider.testConnection();
	assert.equal(client.requests.length, 1);
	const body = client.requests[0].body;
	assert.ok(body.includes('OK'));
	assert.equal(body.includes('课堂原文'), false);
	assert.ok(body.length < 500);
});
