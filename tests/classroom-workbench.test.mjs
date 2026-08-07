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
		'classroomSessionMenuTitle(classroomState)',
		"'打开课堂工作台'",
		"'创建课堂笔记'",
		"'AI 整理当前笔记'",
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

test('manifest declares the official revealLeaf compatibility floor', async () => {
	const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
	assert.equal(manifest.minAppVersion, '1.7.2');
	assert.equal(manifest.version, '1.0.0');
});
