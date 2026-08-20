import assert from 'node:assert/strict';
import test from 'node:test';

import { build } from 'esbuild';

async function loadVisionProviders() {
	const bundle = await build({
		stdin: {
			contents: [
				"export * from './provider-types.ts';",
				"export * from './providers/text-providers.ts';",
				"export * from './providers/vision-providers.ts';",
				"export * from './providers/registry.ts';",
				"export * from './settings-data.ts';",
			].join('\n'),
			resolveDir: process.cwd(),
			sourcefile: 'vision-provider-test-entry.ts',
		},
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'node18',
		write: false,
	});
	const source = bundle.outputFiles[0]?.text;
	if (!source) {
		throw new Error('Failed to bundle vision Provider modules for tests.');
	}
	return import(`data:text/javascript,${encodeURIComponent(source)}`);
}

async function loadSettingsModule() {
	const bundle = await build({
		entryPoints: ['settings.ts'],
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'node18',
		write: false,
		plugins: [{
			name: 'mock-obsidian-settings',
			setup(buildApi) {
				buildApi.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'mock' }));
				buildApi.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
					contents: `
						export class Plugin {}
						export class PluginSettingTab {
							constructor(app, plugin) {
								this.app = app;
								this.plugin = plugin;
								this.containerEl = process.__settingsContainer;
							}
						}
						export class Notice {
							constructor(message) { process.__settingNotices.push(message); }
						}
						class Component {
							constructor(record) {
								this.record = record;
								this.inputEl = {};
								this.selectEl = {};
								this.buttonEl = {};
							}
							setValue(value) { this.record.value = value; return this; }
							setPlaceholder(value) { this.record.placeholder = value; return this; }
							setDisabled(value) { this.record.disabled = value; return this; }
							setLimits(min, max, step) { this.record.limits = [min, max, step]; return this; }
							setButtonText(value) { this.record.buttonText = value; return this; }
							addOption(value, label) { this.record.options.push([value, label]); return this; }
							onChange(callback) { this.record.onChange = callback; return this; }
							onClick(callback) { this.record.onClick = callback; return this; }
						}
						export class Setting {
							constructor() {
								this.record = { options: [] };
								process.__settingRecords.push(this.record);
								this.settingEl = { empty() {}, createDiv() { return process.__settingsContainer; } };
							}
							setName(value) { this.record.name = value; return this; }
							setDesc(value) { this.record.desc = value; return this; }
							setHeading() { this.record.heading = true; return this; }
							addText(callback) { this.record.type = 'text'; callback(new Component(this.record)); return this; }
							addDropdown(callback) { this.record.type = 'dropdown'; callback(new Component(this.record)); return this; }
							addToggle(callback) { this.record.type = 'toggle'; callback(new Component(this.record)); return this; }
							addSlider(callback) { this.record.type = 'slider'; callback(new Component(this.record)); return this; }
							addButton(callback) { this.record.type = 'button'; callback(new Component(this.record)); return this; }
						}
						export async function requestUrl() { throw new Error('Network must not be called in settings tests.'); }
					`,
				}));
			},
		}],
	});
	const source = bundle.outputFiles[0]?.text;
	if (!source) {
		throw new Error('Failed to bundle settings.ts for tests.');
	}
	return import(`data:text/javascript,${encodeURIComponent(source)}`);
}

const providers = await loadVisionProviders();
const {
	CustomOpenAICompatibleTextProvider,
	CustomOpenAICompatibleVisionProvider,
	DeepSeekTextProvider,
	ProviderError,
	ProviderRegistry,
	QwenVisionProvider,
	VISION_DEFAULT_MAX_OUTPUT_TOKENS,
	normalizeSettings,
} = providers;

class MockHttpClient {
	requests = [];

	constructor(responseOrError = successResponse()) {
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

function successResponse(content = '视觉结果', finishReason = 'stop') {
	return {
		status: 200,
		text: JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }] }),
	};
}

function qwenVisionConfig(overrides = {}) {
	return {
		apiKey: 'unit-test-key',
		region: 'cn-beijing',
		workspaceId: 'workspace-test',
		visionModel: 'qwen3-vl-plus',
		temperature: 0.3,
		timeoutMs: 150_000,
		...overrides,
	};
}

function customVisionConfig(overrides = {}) {
	return {
		apiKey: 'unit-test-key',
		baseUrl: 'https://custom.example/v1',
		model: 'custom-vision-model',
		temperature: 0.3,
		timeoutMs: 150_000,
		supportsVision: false,
		...overrides,
	};
}

function image(id = 'IMG_001', mimeType = 'image/png') {
	return {
		id,
		mimeType,
		dataUrl: `data:${mimeType};base64,AAAA`,
		nearbyContext: `${id} 附近课堂文字`,
	};
}

function visionRequest(overrides = {}) {
	return {
		systemPrompt: '系统整理要求',
		textPrompt: '完整整理要求与文字稿',
		images: [image()],
		maxTokens: 8192,
		...overrides,
	};
}

function registrySettings(overrides = {}) {
	const base = normalizeSettings({
		setupMode: 'recommended',
		enableVisionInput: true,
		visionProvider: 'qwen',
		deepseek: { apiKey: 'unit-test-key', baseUrl: 'https://api.deepseek.com', model: 'deepseek' },
		qwen: {
			apiKey: 'unit-test-key',
			region: 'cn-beijing',
			workspaceId: 'workspace-test',
			model: 'qwen-text-model',
			visionModel: 'qwen3-vl-plus',
		},
		customOpenAI: {
			apiKey: 'unit-test-key',
			baseUrl: 'https://custom.example/v1',
			model: 'custom-model',
			supportsVision: false,
		},
	});
	return {
		...base,
		...overrides,
		qwen: { ...base.qwen, ...overrides.qwen },
		customOpenAI: { ...base.customOpenAI, ...overrides.customOpenAI },
	};
}

test('Provider capabilities declare DeepSeek vision=false and Qwen vision=true', () => {
	const deepSeek = new DeepSeekTextProvider(
		{ apiKey: 'unit-test-key', baseUrl: 'https://api.deepseek.com', model: 'deepseek', temperature: 0.3, timeoutMs: 150_000 },
		new MockHttpClient(),
	);
	const qwen = new QwenVisionProvider(qwenVisionConfig(), new MockHttpClient());
	assert.equal(deepSeek.capabilities.vision, false);
	assert.equal(qwen.capabilities.vision, true);
});

test('Custom vision capability follows only the explicit supportsVision declaration', () => {
	assert.equal(new CustomOpenAICompatibleVisionProvider(customVisionConfig(), new MockHttpClient()).capabilities.vision, false);
	assert.equal(
		new CustomOpenAICompatibleVisionProvider(customVisionConfig({ supportsVision: true }), new MockHttpClient()).capabilities.vision,
		true,
	);
});

test('visual Provider selection is independent of simple, recommended, and advanced text modes', () => {
	for (const setupMode of ['simple', 'recommended', 'advanced']) {
		const registry = new ProviderRegistry(registrySettings({ setupMode }), new MockHttpClient());
		assert.equal(registry.getSelectedVisionProvider().id, 'qwen');
	}
});

test('Registry refuses vision while disabled and never exposes DeepSeek as a vision option', () => {
	const disabled = new ProviderRegistry(registrySettings({ enableVisionInput: false }), new MockHttpClient());
	assert.throws(() => disabled.getSelectedVisionProvider(), /尚未启用/);
	const enabled = new ProviderRegistry(registrySettings(), new MockHttpClient());
	assert.throws(() => enabled.getVisionProvider('deepseek'), /不一致/);
});

test('Registry requires the explicitly selected visual Provider', () => {
	const registry = new ProviderRegistry(registrySettings(), new MockHttpClient());
	assert.throws(() => registry.getVisionProvider('custom'), /明确选择/);
});

test('Registry rejects a selected Custom Provider that has not declared vision support', () => {
	const client = new MockHttpClient();
	const registry = new ProviderRegistry(registrySettings({ visionProvider: 'custom' }), client);
	assert.throws(() => registry.getSelectedVisionProvider(), /未声明支持/);
	assert.equal(client.requests.length, 0);
});

test('the original text request JSON structure remains unchanged', async () => {
	const client = new MockHttpClient();
	const provider = new CustomOpenAICompatibleTextProvider(
		{ apiKey: 'unit-test-key', baseUrl: 'https://custom.example/v1', model: 'text-model', temperature: 0.3, timeoutMs: 150_000 },
		client,
	);
	await provider.generate({ systemPrompt: 'system', userPrompt: 'plain text', maxTokens: 1234 });
	assert.deepEqual(JSON.parse(client.requests[0].body), {
		model: 'text-model',
		messages: [
			{ role: 'system', content: 'system' },
			{ role: 'user', content: 'plain text' },
		],
		temperature: 0.3,
		max_tokens: 1234,
		stream: false,
	});
	assert.equal('signal' in client.requests[0], false);
});

test('Qwen-VL uses qwen.visionModel and the existing Qwen compatible endpoint', async () => {
	const client = new MockHttpClient();
	const provider = new QwenVisionProvider(qwenVisionConfig({ visionModel: 'vision-only-model' }), client);
	await provider.generateVision(visionRequest());
	assert.equal(JSON.parse(client.requests[0].body).model, 'vision-only-model');
	assert.equal(client.requests[0].url, 'https://workspace-test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
});

test('Qwen text and vision requests keep their model settings separate', async () => {
	const client = new MockHttpClient();
	const registry = new ProviderRegistry(registrySettings({
		qwen: { model: 'qwen-text-only', visionModel: 'qwen-vision-only' },
	}), client);
	await registry.getTextProvider('qwen').generate({
		systemPrompt: 'system',
		userPrompt: 'text',
		maxTokens: 100,
	});
	await registry.getSelectedVisionProvider().generateVision(visionRequest());
	assert.equal(JSON.parse(client.requests[0].body).model, 'qwen-text-only');
	assert.equal(JSON.parse(client.requests[1].body).model, 'qwen-vision-only');
});

test('Qwen visual validation checks API key, endpoint inputs, and vision model', () => {
	const provider = new QwenVisionProvider(qwenVisionConfig({
		apiKey: '',
		workspaceId: '',
		visionModel: '',
	}), new MockHttpClient());
	const errors = provider.validateVision(visionRequest()).join(' ');
	assert.match(errors, /API Key/);
	assert.match(errors, /Base URL/);
	assert.match(errors, /模型名称/);
	assert.match(errors, /Workspace ID/);
});

test('Qwen-VL content arrays preserve text, ID/context, and image order for multiple images', async () => {
	const client = new MockHttpClient();
	const provider = new QwenVisionProvider(qwenVisionConfig(), client);
	const images = [image('IMG_001', 'image/png'), image('IMG_002', 'image/jpeg')];
	await provider.generateVision(visionRequest({ images }));
	const content = JSON.parse(client.requests[0].body).messages[1].content;
	assert.deepEqual(content, [
		{ type: 'text', text: '完整整理要求与文字稿' },
		{ type: 'text', text: '图片编号：IMG_001\n附近文字：IMG_001 附近课堂文字' },
		{ type: 'image_url', image_url: { url: images[0].dataUrl } },
		{ type: 'text', text: '图片编号：IMG_002\n附近文字：IMG_002 附近课堂文字' },
		{ type: 'image_url', image_url: { url: images[1].dataUrl } },
	]);
});

test('vision requests use the established 8192-token output space when maxTokens is omitted', async () => {
	const client = new MockHttpClient();
	const provider = new QwenVisionProvider(qwenVisionConfig(), client);
	const request = visionRequest();
	delete request.maxTokens;
	await provider.generateVision(request);
	assert.equal(JSON.parse(client.requests[0].body).max_tokens, VISION_DEFAULT_MAX_OUTPUT_TOKENS);
	assert.equal(VISION_DEFAULT_MAX_OUTPUT_TOKENS, 8192);
});

test('empty images, duplicate IDs, and MIME/Data URL mismatches fail before network calls', async () => {
	for (const request of [
		visionRequest({ images: [] }),
		visionRequest({ images: [image('IMG_001'), image('IMG_001')] }),
		visionRequest({ images: [{ ...image(), mimeType: 'image/jpeg' }] }),
		visionRequest({ images: [image('IMG_001', 'image/gif')] }),
	]) {
		const client = new MockHttpClient();
		const provider = new QwenVisionProvider(qwenVisionConfig(), client);
		await assert.rejects(() => provider.generateVision(request), { code: 'configuration' });
		assert.equal(client.requests.length, 0);
	}
});

test('visual completion preserves finish_reason and passes AbortSignal by identity', async () => {
	const client = new MockHttpClient(successResponse('完成', 'length'));
	const provider = new QwenVisionProvider(qwenVisionConfig(), client);
	const controller = new AbortController();
	const result = await provider.generateVision(visionRequest(), controller.signal);
	assert.equal(result.finishReason, 'length');
	assert.equal(client.requests[0].signal, controller.signal);
});

test('an already-aborted visual request is rejected before the network call', async () => {
	const client = new MockHttpClient();
	const provider = new QwenVisionProvider(qwenVisionConfig(), client);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(() => provider.generateVision(visionRequest(), controller.signal), /取消/);
	assert.equal(client.requests.length, 0);
});

test('network errors and logs never expose Data URLs or Base64 payloads', async () => {
	const unsafeData = image().dataUrl;
	const client = new MockHttpClient(new ProviderError(`transport failed: ${unsafeData}`, 'network'));
	const provider = new QwenVisionProvider(qwenVisionConfig(), client);
	const logs = [];
	const originalError = console.error;
	console.error = (...values) => logs.push(values.join(' '));
	try {
		await assert.rejects(
			() => provider.generateVision(visionRequest()),
			(error) => !error.message.includes('data:image') && !error.message.includes('AAAA'),
		);
	} finally {
		console.error = originalError;
	}
	assert.deepEqual(logs, []);
});

test('vision Providers do not retain request objects or Data URLs after completion', async () => {
	const ephemeralClient = { async post() { return successResponse(); } };
	const provider = new QwenVisionProvider(qwenVisionConfig(), ephemeralClient);
	const request = visionRequest();
	await provider.generateVision(request);
	assert.equal(Object.values(provider).includes(request), false);
	assert.equal(JSON.stringify(provider).includes('data:image'), false);
});

test('Custom supportsVision=false rejects before any network request', async () => {
	const client = new MockHttpClient();
	const provider = new CustomOpenAICompatibleVisionProvider(customVisionConfig(), client);
	await assert.rejects(() => provider.generateVision(visionRequest()), /用户声明/);
	assert.equal(client.requests.length, 0);
});

test('Custom supportsVision=true uses the existing custom model and content-array format', async () => {
	const client = new MockHttpClient();
	const provider = new CustomOpenAICompatibleVisionProvider(
		customVisionConfig({ supportsVision: true, model: 'existing-custom-model' }),
		client,
	);
	await provider.generateVision(visionRequest());
	const body = JSON.parse(client.requests[0].body);
	assert.equal(body.model, 'existing-custom-model');
	assert.ok(Array.isArray(body.messages[1].content));
	assert.match(client.requests[0].url, /^https:\/\/custom\.example\//);
});

test('Custom visual requests never switch to Qwen implicitly', async () => {
	const client = new MockHttpClient();
	const settings = registrySettings({
		visionProvider: 'custom',
		setupMode: 'simple',
		customOpenAI: { supportsVision: true },
	});
	const provider = new ProviderRegistry(settings, client).getSelectedVisionProvider();
	await provider.generateVision(visionRequest());
	assert.equal(provider.id, 'custom');
	assert.match(client.requests[0].url, /^https:\/\/custom\.example\//);
	assert.equal(client.requests[0].url.includes('aliyuncs.com'), false);
});

test('Custom incompatible image responses return a concise capability warning', async () => {
	const response = {
		status: 415,
		text: JSON.stringify({ error: { message: `unsupported ${image().dataUrl}` } }),
	};
	const provider = new CustomOpenAICompatibleVisionProvider(
		customVisionConfig({ supportsVision: true }),
		new MockHttpClient(response),
	);
	await assert.rejects(
		() => provider.generateVision(visionRequest()),
		(error) => /用户声明|无法保证/.test(error.message) && !error.message.includes('data:image'),
	);
});

const settingsModule = await loadSettingsModule();
const { LectureWorkflowSettingTab } = settingsModule;

function resetSettingsUiMocks() {
	process.__settingRecords = [];
	process.__settingNotices = [];
	process.__settingsContainer = {
		empty() {},
		createEl(_tag, options) {
			process.__settingRecords.push({ type: 'paragraph', text: options?.text, cls: options?.cls });
			return {};
		},
	};
}

test('settings UI exposes independent vision controls, privacy text, and no DeepSeek visual option', () => {
	resetSettingsUiMocks();
	const plugin = { settings: registrySettings(), async saveSettings() {} };
	const tab = new LectureWorkflowSettingTab({}, plugin);
	tab.display();
	const byName = (name) => process.__settingRecords.find((record) => record.name === name);
	assert.equal(byName('启用图片参与整理').type, 'toggle');
	assert.deepEqual(byName('视觉 Provider').options.map(([value]) => value), ['qwen', 'custom']);
	assert.equal(byName('Qwen 视觉模型').value, 'qwen3-vl-plus');
	assert.equal(byName('最大图片数量').value, '10');
	assert.equal(byName('自定义 Provider 支持图片').type, 'toggle');
	assert.match(byName('启用图片参与整理').desc, /可选功能/);
	assert.match(byName('启用图片参与整理').desc, /视觉模型只负责理解课堂截图/);
	assert.match(byName('Qwen 视觉模型').desc, /不负责最终课堂笔记生成/);
	assert.match(byName('DeepSeek API Key').desc, /文字 AI 整理所需配置/);
	assert.match(byName('Realtime ASR Model').desc, /只用于实时课堂转写/);
	assert.match(byName('Custom OpenAI-compatible（高级）').desc, /普通用户无需配置/);
	const privacy = process.__settingRecords.find((record) => record.type === 'paragraph' && record.text?.includes('公共图床'));
	assert.match(privacy.text, /第三方模型服务商/);
	assert.match(privacy.text, /额外 Token 或调用费用/);
	const paragraphs = process.__settingRecords
		.filter((record) => record.type === 'paragraph')
		.map((record) => record.text)
		.join('\n');
	assert.match(paragraphs, /1\. 文字整理：配置 DeepSeek API Key/);
	assert.match(paragraphs, /2\. 图片理解：如需课堂截图参与 AI 整理/);
	assert.match(paragraphs, /3\. 实时转写：如需课堂语音实时转成文字/);
	assert.match(paragraphs, /4\. 完成配置后：使用对应 Provider 的「测试连接」/);
	assert.match(paragraphs, /只使用文字 AI 整理，不需要配置图片理解和实时转写/);
	assert.match(paragraphs, /API Key 保存在本地插件配置 data\.json 中，未加密/);
});

test('settings save failure restores the previously persisted vision values', async () => {
	resetSettingsUiMocks();
	const original = registrySettings();
	const plugin = {
		settings: original,
		async saveSettings() { throw new Error('mock save failure unit-test-key'); },
	};
	const tab = new LectureWorkflowSettingTab({}, plugin);
	await tab.updateSettings((next) => {
		next.visionProvider = 'custom';
		next.maxVisionImages = 3;
	});
	assert.equal(plugin.settings.visionProvider, 'qwen');
	assert.equal(plugin.settings.maxVisionImages, 10);
	assert.equal(process.__settingNotices.length, 1);
	assert.equal(process.__settingNotices[0].includes('unit-test-key'), false);
});

test('switching visual Provider does not overwrite either Provider configuration', async () => {
	resetSettingsUiMocks();
	const original = registrySettings({
		qwen: { visionModel: 'saved-qwen-vision' },
		customOpenAI: { model: 'saved-custom-model', supportsVision: true },
	});
	const plugin = { settings: original, async saveSettings() {} };
	const tab = new LectureWorkflowSettingTab({}, plugin);
	await tab.updateSettings((next) => { next.visionProvider = 'custom'; });
	assert.equal(plugin.settings.qwen.visionModel, 'saved-qwen-vision');
	assert.equal(plugin.settings.customOpenAI.model, 'saved-custom-model');
	assert.equal(plugin.settings.customOpenAI.supportsVision, true);
});
