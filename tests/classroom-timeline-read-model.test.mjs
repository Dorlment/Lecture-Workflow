import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const moduleBundle = await build({
	stdin: {
		contents: "export * from './classroom-timeline-read-model.ts';",
		resolveDir: process.cwd(),
		sourcefile: 'timeline-read-model-test-entry.ts',
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	write: false,
	external: ['obsidian'],
});
const source = moduleBundle.outputFiles[0]?.text;
if (!source) throw new Error('Failed to bundle timeline read model.');
const api = await import(`data:text/javascript,${encodeURIComponent(source)}`);

const { buildClassroomTimelineReadModel, buildTimelineContext } = api;

test('transcript only', () => {
	const markdown = `## 原始文字稿

[00:00:10] 第一段内容
[00:00:30] 第二段内容
[00:01:00] 第三段内容

## AI 整理结果
`;

	const result = buildClassroomTimelineReadModel(markdown);

	assert.equal(result.length, 3);
	assert.equal(result[0].kind, 'transcript');
	assert.equal(result[0].offsetMs, 10000);
	assert.equal(result[0].text, '第一段内容');
	assert.equal(result[1].offsetMs, 30000);
	assert.equal(result[2].offsetMs, 60000);
});

test('screenshot only', () => {
	const markdown = `<!-- lecture-workflow:timeline:start -->
## ⏱ 课堂时间线

<!-- lecture-workflow:event id=session1-screenshot-0001 type=screenshot offsetMs=15000 capturedAt=2024-01-01T00:00:15.000Z -->
### 00:00:15 · 课堂截图

![[screenshot1.png]]

<!-- lecture-workflow:event id=session1-screenshot-0002 type=screenshot offsetMs=45000 capturedAt=2024-01-01T00:00:45.000Z -->
### 00:00:45 · 课堂截图

![[screenshot2.png]]

<!-- lecture-workflow:timeline:end -->
`;

	const result = buildClassroomTimelineReadModel(markdown);

	assert.equal(result.length, 2);
	assert.equal(result[0].kind, 'screenshot');
	assert.equal(result[0].offsetMs, 15000);
	assert.equal(result[0].eventId, 'session1-screenshot-0001');
	assert.equal(result[1].offsetMs, 45000);
});

test('transcript + screenshot interleaved by offsetMs', () => {
	const markdown = `## 原始文字稿

[00:00:10] 第一段
[00:00:30] 第二段
[00:01:00] 第三段

<!-- lecture-workflow:timeline:start -->
## ⏱ 课堂时间线

<!-- lecture-workflow:event id=s1 type=screenshot offsetMs=20000 capturedAt=2024-01-01T00:00:20.000Z -->
### 00:00:20 · 课堂截图

![[screenshot1.png]]

<!-- lecture-workflow:event id=s2 type=screenshot offsetMs=50000 capturedAt=2024-01-01T00:00:50.000Z -->
### 00:00:50 · 课堂截图

![[screenshot2.png]]

<!-- lecture-workflow:timeline:end -->

## AI 整理结果
`;

	const result = buildClassroomTimelineReadModel(markdown);

	assert.equal(result.length, 5);
	// Expected order: 10s transcript, 20s screenshot, 30s transcript, 50s screenshot, 60s transcript
	assert.equal(result[0].kind, 'transcript');
	assert.equal(result[0].offsetMs, 10000);
	assert.equal(result[1].kind, 'screenshot');
	assert.equal(result[1].offsetMs, 20000);
	assert.equal(result[2].kind, 'transcript');
	assert.equal(result[2].offsetMs, 30000);
	assert.equal(result[3].kind, 'screenshot');
	assert.equal(result[3].offsetMs, 50000);
	assert.equal(result[4].kind, 'transcript');
	assert.equal(result[4].offsetMs, 60000);
});

test('STOP/START: large transcript offset preserved after restart', () => {
	const markdown = `## 原始文字稿

[00:00:10] Run 1 第一段
[00:00:17] Run 1 最后一段
[00:01:02] Run 2 第一段（STOP/START 后）
[00:01:07] Run 2 第二段

## AI 整理结果
`;

	const result = buildClassroomTimelineReadModel(markdown);

	assert.equal(result.length, 4);
	assert.equal(result[0].offsetMs, 10000);
	assert.equal(result[1].offsetMs, 17000);
	assert.equal(result[2].offsetMs, 62000); // 1:02 = 62s
	assert.equal(result[3].offsetMs, 67000); // 1:07 = 67s
});

test('malformed / empty transcript lines ignored', () => {
	const markdown = `## 原始文字稿

[00:00:10] 有效内容
[00:00:22]
[00:00:30]    
[invalid] 无效格式
[00:00:40] 另一段有效内容

## AI 整理结果
`;

	const result = buildClassroomTimelineReadModel(markdown);

	assert.equal(result.length, 2);
	assert.equal(result[0].offsetMs, 10000);
	assert.equal(result[0].text, '有效内容');
	assert.equal(result[1].offsetMs, 40000);
	assert.equal(result[1].text, '另一段有效内容');
});

test('does not parse [HH:MM:SS] outside ## 原始文字稿', () => {
	const markdown = `## 其他 section

[00:00:10] 不应该被解析

## 原始文字稿

[00:00:20] 应该被解析

## AI 整理结果

[00:00:30] 也不应该被解析
`;

	const result = buildClassroomTimelineReadModel(markdown);

	assert.equal(result.length, 1);
	assert.equal(result[0].offsetMs, 20000);
	assert.equal(result[0].text, '应该被解析');
});

test('same offsetMs: transcript before screenshot (stable sort)', () => {
	const markdown = `## 原始文字稿

[00:00:30] 同时的文字

<!-- lecture-workflow:timeline:start -->
## ⏱ 课堂时间线

<!-- lecture-workflow:event id=s1 type=screenshot offsetMs=30000 capturedAt=2024-01-01T00:00:30.000Z -->
### 00:00:30 · 课堂截图

![[screenshot.png]]

<!-- lecture-workflow:timeline:end -->
`;

	const result = buildClassroomTimelineReadModel(markdown);

	assert.equal(result.length, 2);
	assert.equal(result[0].kind, 'transcript');
	assert.equal(result[0].offsetMs, 30000);
	assert.equal(result[1].kind, 'screenshot');
	assert.equal(result[1].offsetMs, 30000);
});

test('empty markdown returns []', () => {
	const result = buildClassroomTimelineReadModel('');
	assert.equal(result.length, 0);
});

test('no transcript section, only screenshots', () => {
	const markdown = `<!-- lecture-workflow:timeline:start -->
## ⏱ 课堂时间线

<!-- lecture-workflow:event id=s1 type=screenshot offsetMs=5000 capturedAt=2024-01-01T00:00:05.000Z -->
### 00:00:05 · 课堂截图

![[screenshot.png]]

<!-- lecture-workflow:timeline:end -->
`;

	const result = buildClassroomTimelineReadModel(markdown);

	assert.equal(result.length, 1);
	assert.equal(result[0].kind, 'screenshot');
	assert.equal(result[0].offsetMs, 5000);
});

test('no screenshots, only transcript', () => {
	const markdown = `## 原始文字稿

[00:00:05] 只有文字

## AI 整理结果
`;

	const result = buildClassroomTimelineReadModel(markdown);

	assert.equal(result.length, 1);
	assert.equal(result[0].kind, 'transcript');
	assert.equal(result[0].offsetMs, 5000);
});

test('buildTimelineContext: returns null for empty timeline', () => {
	const result = buildTimelineContext('');
	assert.equal(result, null);
});

test('buildTimelineContext: returns null when no transcript or screenshots', () => {
	const markdown = `## 其他内容

一些文字

## AI 整理结果
`;
	const result = buildTimelineContext(markdown);
	assert.equal(result, null);
});

test('buildTimelineContext: returns formatted string with transcript and screenshots', () => {
	const markdown = `## 原始文字稿

[00:03:20] 今天讲积分应用
[00:03:42] 接下来来看例题

<!-- lecture-workflow:timeline:start -->
## ⏱ 课堂时间线

<!-- lecture-workflow:event id=s1 type=screenshot offsetMs=205000 capturedAt=2024-01-01T00:03:25.000Z -->
### 00:03:25 · 课堂截图

![[screenshot1.png]]

<!-- lecture-workflow:event id=s2 type=screenshot offsetMs=250000 capturedAt=2024-01-01T00:04:10.000Z -->
### 00:04:10 · 课堂截图

![[screenshot2.png]]

<!-- lecture-workflow:timeline:end -->
`;

	const result = buildTimelineContext(markdown);

	assert.notEqual(result, null);
	assert.ok(result.includes('课堂统一时间线'));
	assert.ok(result.includes('[00:03:20] [文字] 今天讲积分应用'));
	assert.ok(result.includes('[00:03:25] [截图]'));
	assert.ok(result.includes('[00:03:42] [文字] 接下来来看例题'));
	assert.ok(result.includes('[00:04:10] [截图]'));
});

test('buildTimelineContext: truncates long transcript text', () => {
	const markdown = `## 原始文字稿

[00:00:10] 这是一段非常非常长的文字内容，超过了三十个字符的限制，应该被截断显示

## AI 整理结果
`;

	const result = buildTimelineContext(markdown);

	assert.notEqual(result, null);
	// Check that the line contains the timestamp and [文字] marker
	assert.ok(result.includes('[00:00:10] [文字]'));
	// Check that it contains an ellipsis indicating truncation
	assert.ok(result.includes('…'));
	// Check that the full text is NOT present
	assert.ok(!result.includes('应该被截断显示'));
});

test('buildTimelineContext: preserves order from buildClassroomTimelineReadModel', () => {
	const markdown = `## 原始文字稿

[00:01:00] 第二段文字
[00:00:10] 第一段文字

<!-- lecture-workflow:timeline:start -->
## ⏱ 课堂时间线

<!-- lecture-workflow:event id=s1 type=screenshot offsetMs=30000 capturedAt=2024-01-01T00:00:30.000Z -->
### 00:00:30 · 课堂截图

![[screenshot.png]]

<!-- lecture-workflow:timeline:end -->
`;

	const result = buildTimelineContext(markdown);

	assert.notEqual(result, null);
	const lines = result.split('\n').filter(line => line.startsWith('[00:'));
	assert.equal(lines.length, 3);
	assert.ok(lines[0].includes('[00:00:10]'));
	assert.ok(lines[1].includes('[00:00:30]'));
	assert.ok(lines[2].includes('[00:01:00]'));
});
