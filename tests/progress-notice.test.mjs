import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { build } from 'esbuild';

const bundle = await build({
	stdin: {
		contents: "export * from './progress-notice.ts';",
		resolveDir: process.cwd(),
		sourcefile: 'progress-notice-test-entry.ts',
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	write: false,
});
const bundledSource = bundle.outputFiles[0]?.text;
if (!bundledSource) throw new Error('Failed to bundle progress Notice module.');
const {
	PROGRESS_NOTICE_FAILURE_DURATION_MS,
	PROGRESS_NOTICE_SUCCESS_DURATION_MS,
	ProgressNoticeManager,
} = await import(`data:text/javascript,${encodeURIComponent(bundledSource)}`);

class FakeScheduler {
	constructor() {
		this.now = 0;
		this.nextId = 1;
		this.tasks = new Map();
		this.cleared = [];
	}

	setTimeout = (callback, delayMs) => {
		const id = this.nextId++;
		this.tasks.set(id, { callback, due: this.now + delayMs });
		return id;
	};

	clearTimeout = (id) => {
		this.cleared.push(id);
		this.tasks.delete(id);
	};

	advance(ms) {
		const end = this.now + ms;
		while (true) {
			const next = [...this.tasks.entries()]
				.filter(([, task]) => task.due <= end)
				.sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
			if (!next) break;
			const [id, task] = next;
			this.tasks.delete(id);
			this.now = task.due;
			task.callback();
		}
		this.now = end;
	}
}

function harness() {
	const scheduler = new FakeScheduler();
	const notices = [];
	const manager = new ProgressNoticeManager({
		createNotice(message, durationMs) {
			const notice = {
				createdMessage: message,
				durationMs,
				messages: [message],
				hideCalls: 0,
				setMessage(next) {
					notice.messages.push(next);
				},
				hide() {
					notice.hideCalls += 1;
				},
			};
			notices.push(notice);
			return notice;
		},
		scheduler,
	});
	return { manager, notices, scheduler };
}

test('an active operation creates a persistent Notice and never hides before settlement', () => {
	const { manager, notices, scheduler } = harness();
	const lease = manager.start('ai-workflow', '正在生成…');
	assert.equal(lease.isOwner, true);
	assert.equal(notices.length, 1);
	assert.equal(notices[0].durationMs, 0);
	scheduler.advance(60_000);
	assert.equal(notices[0].hideCalls, 0);
	assert.equal(notices[0].messages.at(-1), '正在生成…');
});

test('an unresolved Promise keeps its lifecycle Notice visible', async () => {
	const { manager, notices, scheduler } = harness();
	let resolve;
	const pending = new Promise((resolvePromise) => { resolve = resolvePromise; });
	const workflow = async () => {
		const lease = manager.start('promise', '正在等待异步任务…');
		try {
			await pending;
			lease.success('异步任务完成。');
		} finally {
			lease.finishIfPending();
		}
	};
	const running = workflow();
	scheduler.advance(60_000);
	assert.equal(notices[0].hideCalls, 0);
	resolve();
	await running;
	assert.equal(notices[0].messages.at(-1), '异步任务完成。');
	assert.equal(notices[0].hideCalls, 0);
});

test('same active key returns a non-owner that cannot mutate or settle the Notice', () => {
	const { manager, notices, scheduler } = harness();
	const owner = manager.start('ai-workflow', '正在生成…');
	const follower = manager.start('ai-workflow', '重复提示');
	assert.equal(owner.isOwner, true);
	assert.equal(follower.isOwner, false);
	assert.equal(notices.length, 1);
	follower.update('恶意覆盖');
	follower.success('错误成功');
	follower.failure('错误失败');
	follower.cancel('错误取消');
	follower.finishIfPending();
	scheduler.advance(60_000);
	assert.deepEqual(notices[0].messages, ['正在生成…']);
	assert.equal(notices[0].hideCalls, 0);
	owner.success('生成完成。');
	assert.equal(notices[0].messages.at(-1), '生成完成。');
});

test('success updates once and hides after two seconds without relying on finally cleanup', () => {
	const { manager, notices, scheduler } = harness();
	const lease = manager.start('operation', '正在处理…');
	lease.success('处理完成。');
	lease.finishIfPending();
	assert.equal(notices[0].messages.at(-1), '处理完成。');
	scheduler.advance(PROGRESS_NOTICE_SUCCESS_DURATION_MS - 1);
	assert.equal(notices[0].hideCalls, 0);
	scheduler.advance(1);
	assert.equal(notices[0].hideCalls, 1);
});

test('failure remains for six seconds and normal failure explicitly settles before finally', () => {
	const { manager, notices, scheduler } = harness();
	const lease = manager.start('operation', '正在处理…');
	lease.failure('处理失败。');
	lease.finishIfPending();
	scheduler.advance(PROGRESS_NOTICE_FAILURE_DURATION_MS - 1);
	assert.equal(notices[0].hideCalls, 0);
	scheduler.advance(1);
	assert.equal(notices[0].hideCalls, 1);
});

test('cancellation explicitly settles and hides after two seconds', () => {
	const { manager, notices, scheduler } = harness();
	const lease = manager.start('operation', '正在处理…');
	lease.cancel('已取消整理。');
	lease.finishIfPending();
	assert.equal(notices[0].messages.at(-1), '已取消整理。');
	scheduler.advance(PROGRESS_NOTICE_SUCCESS_DURATION_MS);
	assert.equal(notices[0].hideCalls, 1);
});

test('settling locks the final message against updates and duplicate outcomes', () => {
	const { manager, notices, scheduler } = harness();
	const lease = manager.start('operation', '正在处理…');
	lease.failure('最终失败。');
	lease.update('迟到的进行中状态');
	lease.success('迟到的成功');
	lease.cancel('迟到的取消');
	assert.deepEqual(notices[0].messages, ['正在处理…', '最终失败。']);
	scheduler.advance(PROGRESS_NOTICE_FAILURE_DURATION_MS);
	lease.update('隐藏后的更新');
	assert.deepEqual(notices[0].messages, ['正在处理…', '最终失败。']);
});

test('finishIfPending immediately hides without inventing an outcome', () => {
	const { manager, notices, scheduler } = harness();
	const lease = manager.start('operation', '正在处理…');
	lease.finishIfPending();
	assert.deepEqual(notices[0].messages, ['正在处理…']);
	assert.equal(notices[0].hideCalls, 1);
	assert.equal(scheduler.tasks.size, 0);
	lease.finishIfPending();
	assert.equal(notices[0].hideCalls, 1);
});

test('a new operation replaces a settling Notice while an active operation is deduplicated', () => {
	const { manager, notices } = harness();
	const first = manager.start('operation', '第一次');
	first.success('第一次完成');
	const second = manager.start('operation', '第二次');
	assert.equal(second.isOwner, true);
	assert.equal(notices.length, 2);
	assert.equal(notices[0].hideCalls, 1);
	assert.equal(notices[1].hideCalls, 0);
});

test('dispose cancels delayed timers, hides immediately, and hide is called at most once', () => {
	const { manager, notices, scheduler } = harness();
	const settled = manager.start('settled', '正在处理…');
	settled.success('完成。');
	manager.start('active', '仍在处理…');
	manager.dispose();
	assert.equal(scheduler.tasks.size, 0);
	assert.deepEqual(notices.map((notice) => notice.hideCalls), [1, 1]);
	scheduler.advance(60_000);
	manager.dispose();
	assert.deepEqual(notices.map((notice) => notice.hideCalls), [1, 1]);
	settled.failure('销毁后的迟到失败');
	assert.equal(notices[0].messages.at(-1), '完成。');
});

test('sensitive token, API Key, PCM, Base64, and Data URL content is redacted', () => {
	const { manager, notices } = harness();
	const lease = manager.start(
		'secret',
		'正在处理 token=temporary-secret API Key=private-key PCM=1,2,3',
	);
	lease.failure(
		'失败 Bearer abc.def API_Key=another-secret Base64=QUJDREVGRw== '
		+ 'data:audio/pcm;base64,QUJDREVGRw== '
		+ 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwx',
	);
	const rendered = notices[0].messages.join('\n');
	for (const secret of [
		'temporary-secret',
		'private-key',
		'1,2,3',
		'abc.def',
		'another-secret',
		'QUJDREVGRw==',
		'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwx',
	]) {
		assert.doesNotMatch(rendered, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
	}
});

test('AI integration uses lifecycle Notices once and preserves durable status surfaces', async () => {
	const [main, workbench, screenshotModal] = await Promise.all([
		readFile('main.ts', 'utf8'),
		readFile('classroom-workbench-view.ts', 'utf8'),
		readFile('screenshot-paste-modal.ts', 'utf8'),
	]);
	assert.match(main, /new ProgressNoticeManager/);
	assert.match(main, /onunload\(\)[\s\S]*?progressNotices\.dispose\(\)/);
	assert.match(main, /progressNotices\.start\([\s\S]*?'ai-workflow'/);
	assert.match(main, /正在读取课堂笔记/);
	assert.match(main, /正在读取并检查课堂图片/);
	assert.match(main, /progressNotices\.start\([\s\S]*?'ai-write'/);
	assert.match(main, /progressNotices\.start\([\s\S]*?`provider-test:\$\{id\}`/);
	assert.doesNotMatch(main, /new Notice\(`正在使用/);
	assert.doesNotMatch(main, /new Notice\('AI 结构化笔记已写入。'\)/);
	assert.doesNotMatch(main, /new Notice\('AI 结果不完整/);
	assert.doesNotMatch(main, /new Notice\('视觉 AI 结果不完整/);
	assert.doesNotMatch(main, /new Notice\(`图片整理准备失败/);
	assert.doesNotMatch(main, /new Notice\(`视觉 AI 整理失败/);
	assert.doesNotMatch(main, /new Notice\(`AI 整理失败/);
	assert.doesNotMatch(main, /new Notice\(`连接测试失败/);
	assert.match(main, /'ai-write'[\s\S]*?progress\.finishIfPending\(\)/);
	assert.doesNotMatch(main, /new Notice\('笔记在 AI 整理期间已发生变化/);
	assert.doesNotMatch(main, /new Notice\('AI 结构化笔记已写入/);
	assert.match(workbench, /applyAudioState|applyClassroomState/);
	assert.match(screenshotModal, /setStatus\('正在处理粘贴的图片…'\)/);
});
