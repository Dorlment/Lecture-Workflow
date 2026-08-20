import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { build } from 'esbuild';

const bundle = await build({
	stdin: {
		contents: "export * from './classroom-workbench-opener.ts';",
		resolveDir: process.cwd(),
		sourcefile: 'classroom-workbench-opener-test-entry.ts',
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	write: false,
});
const bundledSource = bundle.outputFiles[0]?.text;
if (!bundledSource) throw new Error('Failed to bundle classroom workbench opener.');
const { ClassroomWorkbenchOpenError, ClassroomWorkbenchOpener } = await import(
	`data:text/javascript,${encodeURIComponent(bundledSource)}`
);

const dismissBundle = await build({
	stdin: {
		contents: "export * from './classroom-workbench-dismiss.ts';",
		resolveDir: process.cwd(),
		sourcefile: 'classroom-workbench-dismiss-test-entry.ts',
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	write: false,
});
const dismissSource = dismissBundle.outputFiles[0]?.text;
if (!dismissSource) throw new Error('Failed to bundle classroom workbench dismiss boundary.');
const {
	dismissClassroomWorkbench,
	getClassroomWorkbenchDismissMode,
} = await import(`data:text/javascript,${encodeURIComponent(dismissSource)}`);

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

function openerHarness(options = {}) {
	const calls = [];
	const created = options.createdLeaf ?? {
		setViewState: async (state) => {
			calls.push(['setViewState', state]);
			if (options.setViewStatePromise) await options.setViewStatePromise;
			if (options.setViewStateFails) throw new Error('private setup detail');
		},
	};
	const existing = options.existingLeaf ?? null;
	const leaves = existing ? [existing] : [];
	const workspace = {
		getLeavesOfType(type) {
			calls.push(['getLeavesOfType', type]);
			return leaves;
		},
		getRightLeaf(split) {
			calls.push(['getRightLeaf', split]);
			if (options.noRightLeaf) return null;
			leaves.push(created);
			return created;
		},
		async revealLeaf(leaf) {
			calls.push(['revealLeaf', leaf]);
			if (options.revealFails) throw new Error('private layout detail');
		},
		setActiveLeaf(leaf, params) {
			calls.push(['setActiveLeaf', leaf, params]);
		},
	};
	return {
		calls,
		created,
		opener: new ClassroomWorkbenchOpener(workspace, 'lecture-workflow-classroom-workbench'),
	};
}

test('plugin registers one official ItemView and disposes audio on unload', async () => {
	const [main, workbench] = await Promise.all([
		readFile('main.ts', 'utf8'),
		readFile('classroom-workbench-view.ts', 'utf8'),
	]);
	assert.match(workbench, /class ClassroomWorkbenchView extends ItemView/);
	assert.match(workbench, /lecture-workflow-classroom-workbench/);
	assert.match(main, /registerView\(CLASSROOM_WORKBENCH_VIEW_TYPE/);
	assert.match(main, /onunload\(\)[\s\S]*?audioCaptureProbe\?\.dispose\(\)/);
	assert.doesNotMatch(main, /detachLeavesOfType\(CLASSROOM_WORKBENCH_VIEW_TYPE\)/);
});

test('plugin owns one runtime-only audio companion and disposes it on unload', async () => {
	const [main, workbench] = await Promise.all([
		readFile('main.ts', 'utf8'),
		readFile('classroom-workbench-view.ts', 'utf8'),
	]);
	assert.match(main, /audioCompanionClient = new AudioCompanionClient/);
	assert.match(main, /getSessionContext: \(\) => this\.getAudioCompanionClassroomContext\(\)/);
	assert.match(main, /getAudioCompanionClassroomContext\(\)[\s\S]*?classroomSessionController\?\.getState\(\)/);
	assert.match(main, /sessionId: state\.sessionId[\s\S]*?startedAtUnixMs: state\.startedAt\.getTime\(\)/);
	assert.match(main, /onunload\(\)[\s\S]*?audioCompanionClient\?\.dispose\(\)/);
	assert.match(workbench, /new AudioCompanionWorkbenchBinding/);
	assert.match(workbench, /audioCompanionBinding\?\.close\(\)/);
});

test('workbench shows companion runtime status, metrics, and explicit controls', async () => {
	const workbench = await readFile('classroom-workbench-view.ts', 'utf8');
	assert.match(workbench, /createCard\('系统音频助手'\)/);
	assert.match(workbench, /系统音频仅在本机实时处理，不保存、不上传、不转写。/);
	const card = workbench.match(/const companionCard[\s\S]*?const audioCard/)?.[0];
	assert.ok(card);
	assert.match(card, /'启动系统音频'/);
	assert.match(card, /'停止系统音频'/);
	assert.match(card, /已处理帧数/);
	assert.match(card, /实时 RMS/);
	assert.doesNotMatch(card, /'开始录制'|'上传音频'|'开始转写'/);
});

test('without an existing Leaf the opener creates, awaits, reveals, and activates the workbench', async () => {
	const harness = openerHarness();
	await harness.opener.open();
	assert.deepEqual(harness.calls.map(([name]) => name), [
		'getLeavesOfType',
		'getRightLeaf',
		'setViewState',
		'revealLeaf',
		'setActiveLeaf',
	]);
	assert.deepEqual(harness.calls[1], ['getRightLeaf', true]);
	assert.deepEqual(harness.calls[2], ['setViewState', {
		type: 'lecture-workflow-classroom-workbench',
		active: true,
	}]);
	assert.deepEqual(harness.calls.at(-1), ['setActiveLeaf', harness.created, { focus: true }]);
});

test('an existing or hidden workbench Leaf is reused and revealed without creating another', async () => {
	const existing = { setViewState: async () => undefined };
	const harness = openerHarness({ existingLeaf: existing });
	await harness.opener.open();
	assert.equal(harness.calls.some(([name]) => name === 'getRightLeaf'), false);
	assert.equal(harness.calls.some(([name]) => name === 'setViewState'), false);
	assert.deepEqual(harness.calls[1], ['revealLeaf', existing]);
	assert.deepEqual(harness.calls[2], ['setActiveLeaf', existing, { focus: true }]);
});

test('rapid repeated opens share one in-flight task and create only one Leaf', async () => {
	const pending = deferred();
	const harness = openerHarness({ setViewStatePromise: pending.promise });
	const first = harness.opener.open();
	const second = harness.opener.open();
	assert.equal(first, second);
	assert.equal(harness.calls.filter(([name]) => name === 'getRightLeaf').length, 1);
	pending.resolve();
	await Promise.all([first, second]);
	assert.equal(harness.calls.filter(([name]) => name === 'revealLeaf').length, 1);
});

test('setViewState and reveal failures have safe structured stages', async () => {
	const setFailure = openerHarness({ setViewStateFails: true });
	await assert.rejects(setFailure.opener.open(), (error) =>
		error instanceof ClassroomWorkbenchOpenError && error.stage === 'set-view-state');
	assert.equal(setFailure.calls.some(([name]) => name === 'revealLeaf'), false);

	const revealFailure = openerHarness({ revealFails: true });
	await assert.rejects(revealFailure.opener.open(), (error) =>
		error instanceof ClassroomWorkbenchOpenError && error.stage === 'reveal-leaf');
	assert.equal(revealFailure.calls.some(([name]) => name === 'setActiveLeaf'), false);
});

test('the sole Ribbon menu and command both expose the workbench', async () => {
	const main = await readFile('main.ts', 'utf8');
	assert.equal((main.match(/addRibbonIcon\(/g) ?? []).length, 1);
	assert.match(main, /id: 'open-classroom-workbench'[\s\S]*?openClassroomWorkbench\(\)/);
	assert.doesNotMatch(main, /void this\.openClassroomWorkbench\(\)/);
	const menu = main.match(/private showRibbonMenu\([\s\S]*?menu\.showAtMouseEvent\(event\)/)?.[0];
	assert.ok(menu);
	const titles = [...menu.matchAll(/setTitle\(([^\n]+)\)/g)].map((match) => match[1]);
	assert.deepEqual(titles, [
		"'创建课堂笔记'",
		'classroomSessionMenuTitle(classroomState)',
		"'打开课堂工作台'",
		"'AI 整理当前课堂笔记'",
	]);
});

test('Ribbon and command share one handled async open path with a clear Notice', async () => {
	const main = await readFile('main.ts', 'utf8');
	assert.match(main, /callback: \(\) => this\.openClassroomWorkbench\(\)/);
	assert.match(main, /\.onClick\(\(\) => this\.openClassroomWorkbench\(\)\)/);
	const method = main.match(/private async openClassroomWorkbench\(\)[\s\S]*?\n\t\}/)?.[0];
	assert.ok(method);
	assert.match(method, /await opener\.open\(\)/);
	assert.match(method, /catch \(error\)/);
	assert.match(method, /无法打开课堂工作台，请重新加载插件后重试。/);
	assert.match(method, /safeErrorType\(error\)/);
	assert.doesNotMatch(method, /console\.error\([^\n]*error\)/);
});

test('workbench classroom controls use the existing controller-backed plugin methods', async () => {
	const [main, workbench] = await Promise.all([
		readFile('main.ts', 'utf8'),
		readFile('classroom-workbench-view.ts', 'utf8'),
	]);
	assert.match(main, /getClassroomState: \(\) => this\.getBackgroundScreenshotState\(\)/);
	assert.match(main, /subscribeClassroom:[\s\S]*?onBackgroundScreenshotStateChange\(listener\)/);
	assert.match(main, /startClassroom: \(\) => this\.startBackgroundScreenshotSession\(\)/);
	assert.match(main, /stopClassroom: \(\) => this\.stopBackgroundScreenshotSession\(\)/);
	assert.match(workbench, /host\.startClassroom\(\)/);
	assert.match(workbench, /host\.stopClassroom\(\)/);
	assert.doesNotMatch(workbench, /new ScreenshotBackgroundSession|createClipboardAdapter/);
});

test('workbench subscribes on open and releases subscriptions plus audio on close', async () => {
	const source = await readFile('classroom-workbench-view.ts', 'utf8');
	assert.match(source, /onOpen\(\)[\s\S]*?subscribeClassroom[\s\S]*?audioProbe\.subscribe/);
	assert.match(source, /onClose\(\)[\s\S]*?unsubscribeClassroom\?\.\(\)[\s\S]*?unsubscribeAudio\?\.\(\)/);
	assert.match(source, /onClose\(\)[\s\S]*?await this\.audioProbe\.stop\(\)/);
	assert.match(source, /stopElapsedTimer\(\)/);
});

test('live updates mutate existing fields without rebuilding the workbench DOM', async () => {
	const source = await readFile('classroom-workbench-view.ts', 'utf8');
	for (const methodName of ['applyClassroomState', 'applyAudioState']) {
		const method = source.match(new RegExp(`private ${methodName}\\([\\s\\S]*?\\n\\t\\}`))?.[0];
		assert.ok(method);
		assert.doesNotMatch(method, /empty\(|createEl\(|createDiv\(|new Setting/);
		assert.match(method, /setText|\.value =/);
	}
});

test('audio probe remains independent from screenshot session identity and timeline', async () => {
	const [probe, workbench] = await Promise.all([
		readFile('audio-capture-probe.ts', 'utf8'),
		readFile('classroom-workbench-view.ts', 'utf8'),
	]);
	const combined = `${probe}\n${workbench}`;
	assert.doesNotMatch(probe, /sessionId|startedAt|offsetMs|screenshot-timeline|Vault\.process|createBinary/);
	assert.doesNotMatch(combined, /Vault\.process|createBinary/);
	assert.doesNotMatch(probe, /ClassroomSessionController|ScreenshotBackgroundSession/);
});

test('the workbench includes accessible text states and a non-color-only volume indicator', async () => {
	const [view, styles] = await Promise.all([
		readFile('classroom-workbench-view.ts', 'utf8'),
		readFile('styles.css', 'utf8'),
	]);
	assert.match(view, /createEl\('progress'\)/);
	assert.match(view, /aria-label.*实时音量/);
	assert.match(view, /active: '检测中'/);
	assert.match(view, /'requesting-permission': '正在请求权限'/);
	assert.match(view, /unsupported: '当前环境不支持'/);
	assert.match(view, /error: '测试失败'/);
	assert.match(styles, /var\(--interactive-accent\)/);
	assert.match(styles, /overflow-x: hidden/);
	assert.doesNotMatch(styles, /animation:|#[0-9a-f]{3,8}/i);
});

test('workbench header exposes a responsive collapse or close action', async () => {
	const [view, styles] = await Promise.all([
		readFile('classroom-workbench-view.ts', 'utf8'),
		readFile('styles.css', 'utf8'),
	]);
	assert.match(view, /createEl\('h2', \{ text: '课堂工作台' \}\)/);
	assert.match(view, /dismissMode === 'collapse' \? '收起工作台' : '关闭工作台'/);
	assert.match(styles, /\.lecture-workflow-workbench-header[\s\S]*?display: flex/);
	assert.match(styles, /\.lecture-workflow-classroom-workbench[\s\S]*?width: 100%[\s\S]*?max-width: 100%[\s\S]*?min-width: 0/);
	assert.match(styles, /container-type: inline-size/);
	assert.match(styles, /overflow-x: hidden/);
});

test('official sidedock collapse is preferred and the safe Leaf detach fallback is explicit', () => {
	const calls = [];
	const sidedock = { collapse() { calls.push('collapse'); } };
	const leaf = { detach() { calls.push('detach'); } };
	assert.equal(getClassroomWorkbenchDismissMode(sidedock), 'collapse');
	assert.equal(dismissClassroomWorkbench(sidedock, leaf), 'collapse');
	assert.deepEqual(calls, ['collapse']);

	const unsupportedSidedock = {};
	assert.equal(getClassroomWorkbenchDismissMode(unsupportedSidedock), 'close');
	assert.equal(dismissClassroomWorkbench(unsupportedSidedock, leaf), 'close');
	assert.deepEqual(calls, ['collapse', 'detach']);
	assert.throws(() => dismissClassroomWorkbench({
		collapse() { throw new Error('host layout failure'); },
	}, leaf), /host layout failure/);
});

test('collapse stops only the audio probe and keeps the screenshot classroom session running', async () => {
	const view = await readFile('classroom-workbench-view.ts', 'utf8');
	const method = view.match(/private async dismissWorkbench\(\)[\s\S]*?\n\t\}/)?.[0];
	assert.ok(method);
	assert.match(method, /await this\.audioProbe\.stop\(\)[\s\S]*?host\.dismissWorkbench\(\)/);
	assert.doesNotMatch(method, /stopClassroom|classroomSession|stopBackground/);
	assert.match(method, /无法收起课堂工作台，请使用 Obsidian 右侧边栏按钮。/);
});

test('main wires collapse through the public rightSplit boundary without private DOM access', async () => {
	const [main, dismiss] = await Promise.all([
		readFile('main.ts', 'utf8'),
		readFile('classroom-workbench-dismiss.ts', 'utf8'),
	]);
	assert.match(main, /getDismissMode:[\s\S]*?this\.app\.workspace\.rightSplit/);
	assert.match(main, /dismissWorkbench:[\s\S]*?this\.app\.workspace\.rightSplit/);
	assert.doesNotMatch(`${main}\n${dismiss}`, /querySelector|querySelectorAll|\.rightSplit\[[^\]]+\]/);
	assert.doesNotMatch(dismiss, /\bany\b/);
});

test('narrow workbench layout uses container-responsive full-width button grids', async () => {
	const [view, styles] = await Promise.all([
		readFile('classroom-workbench-view.ts', 'utf8'),
		readFile('styles.css', 'utf8'),
	]);
	assert.match(view, /lecture-workflow-workbench-actions lecture-workflow-workbench-actions-two/);
	assert.match(view, /lecture-workflow-workbench-actions lecture-workflow-workbench-audio-actions/);
	assert.match(styles, /repeat\(auto-fit, minmax\(min\(100%, 11rem\), 1fr\)\)/);
	assert.match(styles, /\.lecture-workflow-workbench-actions button[\s\S]*?width: 100%/);
	assert.match(styles, /\.lecture-workflow-workbench-stop-audio[\s\S]*?grid-column: 1 \/ -1/);
	assert.doesNotMatch(styles, /\.lecture-workflow-classroom-workbench[^}]*width:\s*\d+px/);
});

test('session and audio details are collapsible while long values cannot overflow', async () => {
	const [view, styles] = await Promise.all([
		readFile('classroom-workbench-view.ts', 'utf8'),
		readFile('styles.css', 'utf8'),
	]);
	assert.match(view, /createEl\('details',[\s\S]*?createEl\('summary', \{ text: '详细状态' \}\)/);
	assert.match(view, /createEl\('details',[\s\S]*?createEl\('summary', \{ text: '音频详细信息' \}\)/);
	assert.match(view, /sessionSummaryPrimaryEl\.setAttr\('title', targetPath\)/);
	assert.match(view, /sessionIdEl\.setAttr\('title', state\.sessionId \?\? ''\)/);
	assert.match(styles, /\.lecture-workflow-workbench-summary-primary[\s\S]*?text-overflow: ellipsis[\s\S]*?white-space: nowrap/);
	assert.match(styles, /> \.is-path[\s\S]*?text-overflow: ellipsis/);
});

test('audio input UI exposes runtime device selection without auto-selecting a candidate', async () => {
	const view = await readFile('classroom-workbench-view.ts', 'utf8');
	assert.match(view, /createCard\('音频输入测试'\)/);
	assert.match(view, /createEl\('select'\)/);
	assert.match(view, /audioProbe\.selectInputDevice\(inputDeviceSelect\.value \|\| null\)/);
	assert.match(view, /'刷新设备'/);
	assert.match(view, /'测试所选设备'/);
	assert.match(view, /'停止音频测试'/);
	assert.match(view, /可能是系统音频输入/);
	assert.doesNotMatch(view, /isLoopbackCandidate[\s\S]{0,200}selectInputDevice/);
});

test('system audio UI distinguishes unverified, denied, no-track, and unsupported states', async () => {
	const view = await readFile('classroom-workbench-view.ts', 'utf8');
	for (const text of [
		'接口存在，尚未验证',
		'权限被拒绝或用户取消',
		'没有音频轨道',
		'不可用：当前 Obsidian Electron 宿主不支持',
		'临时失败',
	]) {
		assert.match(view, new RegExp(text));
	}
	assert.match(view, /systemAudioStatus === 'host-unsupported'/);
	assert.match(view, /systemAudioButton\.disabled/);
	assert.match(view, /这不是权限问题/);
});

test('audio device controls remain runtime-only and do not affect classroom screenshots', async () => {
	const [main, view, probe] = await Promise.all([
		readFile('main.ts', 'utf8'),
		readFile('classroom-workbench-view.ts', 'utf8'),
		readFile('audio-capture-probe.ts', 'utf8'),
	]);
	assert.doesNotMatch(probe, /loadData|saveData|localStorage|sessionStorage/);
	assert.doesNotMatch(`${probe}\n${view}`, /ScreenshotBackgroundSession|createBinary|Vault\.process/);
	assert.match(main, /audioCaptureProbe = createBrowserAudioCaptureProbe/);
	assert.doesNotMatch(main, /settings\.[A-Za-z0-9_]*(?:device|audioInput)/i);
});

test('audio tests never add a default shortcut or alter the screenshot toggle command', async () => {
	const main = await readFile('main.ts', 'utf8');
	const openCommand = main.match(/id: 'open-classroom-workbench'[\s\S]*?\n\t\t\}\);/)?.[0];
	assert.ok(openCommand);
	assert.doesNotMatch(openCommand, /hotkeys|modifiers|key:/);
	assert.match(main, /id: 'toggle-classroom-listening'/);
	assert.match(main, /classroomSessionController\?\.getState\(\)\.status === 'listening'/);
});

test('release metadata declares v0.1.1, preserves history, and requires the desktop runtime', async () => {
	const [manifest, packageJson, packageLock, versions] = await Promise.all([
		readFile('manifest.json', 'utf8').then(JSON.parse),
		readFile('package.json', 'utf8').then(JSON.parse),
		readFile('package-lock.json', 'utf8').then(JSON.parse),
		readFile('versions.json', 'utf8').then(JSON.parse),
	]);
	assert.equal(manifest.minAppVersion, '1.7.2');
	assert.equal(manifest.version, '0.1.1');
	assert.equal(manifest.isDesktopOnly, true);
	assert.equal(manifest.description, 'Turns classroom transcripts, screenshots, and realtime speech into structured study notes.');
	assert.doesNotMatch(manifest.description, /Obsidian/u);
	assert.match(manifest.description, /[.!?]$/u);
	assert.equal(packageJson.version, '0.1.1');
	assert.equal(packageJson.description, manifest.description);
	assert.equal(packageLock.version, '0.1.1');
	assert.equal(packageLock.packages[''].version, '0.1.1');
	assert.deepEqual(versions, {
		'0.1.0': '1.7.2',
		'0.1.1': '1.7.2',
	});
});

test('community submission includes the project license and runtime third-party notices', async () => {
	const [license, notices, helperNotices] = await Promise.all([
		readFile('LICENSE', 'utf8'),
		readFile('THIRD_PARTY_NOTICES.md', 'utf8'),
		readFile('companion/windows/THIRD_PARTY_NOTICES.txt', 'utf8'),
	]);
	assert.match(license, /^MIT License\s+Copyright \(c\) 2026 Dorlment/u);
	assert.match(notices, /## ws[\s\S]*?`ws` 8\.21\.1[\s\S]*?License: MIT/u);
	assert.match(notices, /## NAudio[\s\S]*?`NAudio\.Core` 2\.3\.0[\s\S]*?License: MIT/u);
	assert.match(notices, /## Microsoft \.NET apphost[\s\S]*?License: MIT/u);
	assert.match(helperNotices, /NAudio\.Core 2\.3\.0 and NAudio\.Wasapi 2\.3\.0/u);
	assert.match(helperNotices, /Microsoft \.NET application host/u);
});

test('v0.1 README documents the real workflow, privacy, and capability boundaries', async () => {
	const readme = await readFile('README.md', 'utf8');
	for (const text of [
		'创建课堂笔记',
		'开始课堂监听',
		'课堂截图 / 实时转写',
		'AI 整理当前课堂笔记',
		'Qwen Vision 不负责最终完整笔记的生成',
		'实时识别的定稿会自动追加到当前课堂笔记的「原始文字稿」',
		'插件不保存录音',
		'Text Provider 结构化输出上限：8192 tokens',
		'Qwen Vision 视觉证据输出上限：2048 tokens',
		'单次最多选择 10 张图片',
		'默认 Provider 请求超时：150 秒',
		'Custom OpenAI-compatible（高级）',
		'只有在用户主动执行相应功能时，插件才会向第三方 AI 服务发起请求',
		'Windows Audio Companion 只通过 `localhost` 与插件通信',
	]) {
		assert.match(readme, new RegExp(text));
	}
	assert.match(readme, /Obsidian 默认的 Vault 配置目录名称通常是 `\.[o]bsidian`/u);
	assert.match(readme, /Lecture Workflow 使用 \[MIT License\]\(LICENSE\)/u);
	assert.match(readme, /\[Third-party notices\]\(THIRD_PARTY_NOTICES\.md\)/u);
	assert.match(readme, /不读取剪贴板文字，也不会自动上传图片/);
	assert.match(readme, /API Key 保存在本地插件配置 `data\.json` 中，当前未加密/);
	assert.match(readme, /`finishReason=length` 不会自动 repair/);
	assert.match(readme, /`context-limit` 时，插件不会静默截断 transcript/);
	assert.doesNotMatch(readme, /Snipaste Ctrl\+1|Windows Win\+Shift\+S/);
});

test('release hardening keeps primary classroom information visible and nests technical diagnostics', async () => {
	const view = await readFile('classroom-workbench-view.ts', 'utf8');
	assert.match(view, /const companionDetails = companionCard\.createEl\('details'/);
	assert.match(view, /summaryRow\(companionDetails, '已处理帧数'\)/);
	assert.match(view, /companionDetails\.createDiv\(\{[\s\S]*?lecture-workflow-audio-volume/);
	assert.match(view, /const realtimeAsrDuration = summaryRow\(asrOverviewDetails, '已发送音频'\)/);
	assert.match(view, /const asrDetails = asrOverviewDetails\.createEl\('details'/);
	assert.match(view, /asrDetails\.createEl\('summary', \{ text: '开发者诊断' \}\)/);
	assert.match(view, /summaryRow\(asrDetails, 'WebSocket 缓冲字节'\)/);
	assert.match(view, /实时识别的定稿会自动追加到当前课堂笔记的「原始文字稿」，插件不保存录音。/);
	assert.doesNotMatch(view, /实时文字仅保存在本次插件运行内存中，不写入笔记/);
});

test('release hardening uses one AI organization name and an actionable ASR setup message', async () => {
	const [main, runtimeUi] = await Promise.all([
		readFile('main.ts', 'utf8'),
		readFile('realtime-asr-runtime-ui.ts', 'utf8'),
	]);
	assert.equal((main.match(/AI 整理当前课堂笔记/g) ?? []).length, 2);
	assert.doesNotMatch(main, /AI 整理当前笔记/);
	for (const source of [main, runtimeUi]) {
		assert.match(source, /实时转写未配置。请先在 Lecture Workflow 设置中完成 Qwen 实时转写配置，然后重新开始课堂。/);
	}
});
