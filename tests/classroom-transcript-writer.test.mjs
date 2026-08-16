import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const moduleBundle = await build({
	stdin: {
		contents: [
			"export * from './classroom-transcript-writer.ts';",
			"export * from './realtime-asr-transcript-persistence.ts';",
		].join('\n'),
		resolveDir: process.cwd(),
		sourcefile: 'transcript-writer-test-entry.ts',
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	write: false,
});
const source = moduleBundle.outputFiles[0]?.text;
if (!source) throw new Error('Failed to bundle transcript writer modules.');
const api = await import(`data:text/javascript,${encodeURIComponent(source)}`);

const { appendFinalsToTranscript } = api;

function createEntry(overrides) {
	return {
		eventId: 'session-1-asr-run-1-1',
		classroomSessionId: 'session-1',
		asrRunId: 'run-1',
		sentenceId: 1,
		text: '测试文本',
		beginTimeMs: 0,
		endTimeMs: 100,
		classroomOffsetMs: 15000,
		classroomEndOffsetMs: 15100,
		receivedAt: 0,
		persisted: false,
		...overrides,
	};
}

test('P0-11: existing ## 原始文字稿 section appends correctly', () => {
	const markdown = `# 笔记

## 课程信息

一些信息

## 原始文字稿

已有内容

## AI 整理结果

尚未整理。
`;

	const entry = createEntry({ classroomOffsetMs: 30000, text: '新内容' });
	const result = appendFinalsToTranscript(markdown, [entry]);

	assert.ok(result.includes('[00:00:30] 新内容'));
	assert.ok(result.includes('已有内容'));
	const sectionStart = result.indexOf('## 原始文字稿');
	const sectionEnd = result.indexOf('## AI 整理结果');
	const section = result.slice(sectionStart, sectionEnd);
	assert.ok(section.indexOf('已有内容') < section.indexOf('[00:00:30] 新内容'));
});

test('P0-12: placeholder replaced on first write', () => {
	const markdown = `# 笔记

## 原始文字稿

（未提供原始文字稿。）

## AI 整理结果

尚未整理。
`;

	const entry = createEntry({ classroomOffsetMs: 15000, text: '第一句' });
	const result = appendFinalsToTranscript(markdown, [entry]);

	assert.ok(!result.includes('（未提供原始文字稿。）'));
	assert.ok(result.includes('[00:00:15] 第一句'));
});

test('P0-13: missing section is created', () => {
	const markdown = `# 笔记

## 课程信息

一些信息
`;

	const entry = createEntry({ classroomOffsetMs: 15000, text: '新内容' });
	const result = appendFinalsToTranscript(markdown, [entry]);

	assert.ok(result.includes('## 原始文字稿'));
	assert.ok(result.includes('[00:00:15] 新内容'));
});

test('P0-14: existing user text is not overwritten', () => {
	const markdown = `## 原始文字稿

用户手打的文字

## AI 整理结果
`;

	const entry = createEntry({ classroomOffsetMs: 15000, text: 'ASR内容' });
	const result = appendFinalsToTranscript(markdown, [entry]);

	assert.ok(result.includes('用户手打的文字'));
	assert.ok(result.includes('[00:00:15] ASR内容'));
	const sectionStart = result.indexOf('## 原始文字稿');
	const sectionEnd = result.indexOf('## AI 整理结果');
	const section = result.slice(sectionStart, sectionEnd);
	assert.ok(section.indexOf('用户手打的文字') < section.indexOf('[00:00:15] ASR内容'));
});

test('P0-15: identical [HH:MM:SS] text is not duplicated', () => {
	const markdown = `## 原始文字稿

[00:00:15] 已存在的文本

## AI 整理结果
`;

	const entry = createEntry({ classroomOffsetMs: 15000, text: '已存在的文本' });
	const result = appendFinalsToTranscript(markdown, [entry]);

	const matches = result.match(/\[00:00:15\] 已存在的文本/g);
	assert.equal(matches.length, 1);
});

test('empty finals array returns unchanged markdown', () => {
	const markdown = `## 原始文字稿

内容

## AI 整理结果
`;

	const result = appendFinalsToTranscript(markdown, []);
	assert.equal(result, markdown);
});

test('section created before AI marker when no transcript section exists', () => {
	const markdown = `# 笔记

<!-- lecture-workflow:ai:start -->
## AI 结构化笔记

内容
<!-- lecture-workflow:ai:end -->
`;

	const entry = createEntry({ classroomOffsetMs: 15000, text: '新内容' });
	const result = appendFinalsToTranscript(markdown, [entry]);

	const transcriptIndex = result.indexOf('## 原始文字稿');
	const aiIndex = result.indexOf('<!-- lecture-workflow:ai:start -->');
	assert.ok(transcriptIndex >= 0);
	assert.ok(transcriptIndex < aiIndex);
});

test('CRLF line endings are preserved', () => {
	const markdown = `## 原始文字稿\r\n\r\n内容\r\n\r\n## AI 整理结果\r\n`;

	const entry = createEntry({ classroomOffsetMs: 15000, text: '新内容' });
	const result = appendFinalsToTranscript(markdown, [entry]);

	assert.ok(result.includes('\r\n'));
	assert.ok(result.includes('[00:00:15] 新内容'));
});

test('multiple finals are formatted correctly', () => {
	const markdown = `## 原始文字稿

## AI 整理结果
`;

	const entries = [
		createEntry({ sentenceId: 1, classroomOffsetMs: 15000, text: '第一句' }),
		createEntry({ sentenceId: 2, classroomOffsetMs: 30000, text: '第二句' }),
		createEntry({ sentenceId: 3, classroomOffsetMs: 45000, text: '第三句' }),
	];
	const result = appendFinalsToTranscript(markdown, entries);

	assert.ok(result.includes('[00:00:15] 第一句'));
	assert.ok(result.includes('[00:00:30] 第二句'));
	assert.ok(result.includes('[00:00:45] 第三句'));
});

test('writer does not write empty timestamp line', () => {
	const markdown = `## 原始文字稿

## AI 整理结果
`;

	const entry = createEntry({ classroomOffsetMs: 22000, text: '' });
	const result = appendFinalsToTranscript(markdown, [entry]);

	assert.ok(!result.match(/\[00:00:22\]\s*$/m));
	assert.ok(result.includes('## 原始文字稿'));
});

test('existing empty timestamps are cleaned from transcript section', () => {
	const markdown = `## 原始文字稿

[00:00:10] A
[00:00:22]
[00:00:54] B

## AI 整理结果
`;

	const result = appendFinalsToTranscript(markdown, []);

	assert.ok(!result.match(/^\[00:00:22\]\s*$/m));
	assert.ok(result.includes('[00:00:10] A'));
	assert.ok(result.includes('[00:00:54] B'));
});

test('valid time gaps are preserved, not compressed', () => {
	const markdown = `## 原始文字稿

[00:01:20] A
[00:02:05] B

## AI 整理结果
`;

	const result = appendFinalsToTranscript(markdown, []);

	assert.ok(result.includes('[00:01:20] A'));
	assert.ok(result.includes('[00:02:05] B'));
	const idxA = result.indexOf('[00:01:20]');
	const idxB = result.indexOf('[00:02:05]');
	assert.ok(idxA < idxB);
});

test('only transcript section is cleaned, other sections untouched', () => {
	const markdown = `## 其他 section

[00:00:22]

## 原始文字稿

[00:00:10] A
[00:00:22]
[00:00:54] B

## AI 整理结果
`;

	const result = appendFinalsToTranscript(markdown, []);

	const otherSectionStart = result.indexOf('## 其他 section');
	const transcriptStart = result.indexOf('## 原始文字稿');
	const otherSection = result.slice(otherSectionStart, transcriptStart);
	assert.ok(otherSection.includes('[00:00:22]'));

	const transcriptSection = result.slice(transcriptStart);
	assert.ok(!transcriptSection.match(/^\[00:00:22\]\s*$/m));
});

test('malformed timestamp-like lines are not cleaned', () => {
	const markdown = `## 原始文字稿

[12]
[1:2]
[::]
[1234]
[00:00:22] hello
普通用户文本
[00:00:10] A
[00:00:22]
[00:00:54] B

## AI 整理结果
`;

	const result = appendFinalsToTranscript(markdown, []);

	assert.ok(result.includes('[12]'));
	assert.ok(result.includes('[1:2]'));
	assert.ok(result.includes('[::]'));
	assert.ok(result.includes('[1234]'));
	assert.ok(result.includes('[00:00:22] hello'));
	assert.ok(result.includes('普通用户文本'));
	assert.ok(result.includes('[00:00:10] A'));
	assert.ok(result.includes('[00:00:54] B'));
	assert.ok(!result.match(/^\[00:00:22\]\s*$/m));
});

test('empty HH:MM:SS with trailing whitespace is cleaned', () => {
	const markdown = `## 原始文字稿\n\n[12:34:56]${'   '}\n[01:02:03]\t\n[00:00:10] A\n\n## AI 整理结果\n`;

	const result = appendFinalsToTranscript(markdown, []);

	assert.ok(!result.match(/^\[12:34:56\]\s*$/m));
	assert.ok(!result.match(/^\[01:02:03\]\s*$/m));
	assert.ok(result.includes('[00:00:10] A'));
});

test('formatClassroomOffset handles large offsets', () => {
	const markdown = `## 原始文字稿

## AI 整理结果
`;

	const entry = createEntry({ classroomOffsetMs: 3661000, text: '一小时后' });
	const result = appendFinalsToTranscript(markdown, [entry]);

	assert.ok(result.includes('[01:01:01] 一小时后'));
});
