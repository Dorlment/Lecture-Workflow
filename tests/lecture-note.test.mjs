import assert from 'node:assert/strict';
import test from 'node:test';

import { build } from 'esbuild';

const bundle = await build({
	entryPoints: ['lecture-note.ts'],
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	write: false,
});
const bundledSource = bundle.outputFiles[0]?.text;
if (!bundledSource) {
	throw new Error('Failed to bundle lecture-note.ts for tests.');
}

const utilities = await import(
	`data:text/javascript,${encodeURIComponent(bundledSource)}`
);
const {
	assertSafeVaultFolderPath,
	buildLectureNote,
	createLectureFileBaseName,
	findAvailableFilePath,
	sanitizeFileNameSegment,
	SubmissionGuard,
} = utilities;

test('removes every Windows-invalid filename character', () => {
	const invalidCharacters = '<>:"/\\|?*';
	const sanitized = sanitizeFileNameSegment(`课程${invalidCharacters}主题`);

	for (const character of invalidCharacters) {
		assert.equal(sanitized.includes(character), false);
	}
	assert.equal(sanitized, '课程---------主题');
});

test('limits the complete Markdown filename length', () => {
	const baseName = createLectureFileBaseName(
		'2026-08-06',
		'课程'.repeat(200),
		'主题'.repeat(200),
	);
	const fileName = `${baseName}.md`;

	assert.ok(fileName.length <= 180);
	assert.ok(baseName.includes('课程'));
	assert.ok(baseName.includes('主题'));
});

test('adds -2 and -3 without exceeding the filename limit', () => {
	const folder = '课堂笔记';
	const baseName = createLectureFileBaseName(
		'2026-08-06',
		'课程'.repeat(200),
		'主题'.repeat(200),
	);
	const existingPaths = new Set();
	const first = findAvailableFilePath(folder, baseName, (path) => existingPaths.has(path));
	existingPaths.add(first);
	const second = findAvailableFilePath(folder, baseName, (path) => existingPaths.has(path));
	existingPaths.add(second);
	const third = findAvailableFilePath(folder, baseName, (path) => existingPaths.has(path));

	assert.match(first, /\.md$/);
	assert.match(second, /-2\.md$/);
	assert.match(third, /-3\.md$/);
	assert.ok(second.split('/').at(-1).length <= 180);
	assert.ok(third.split('/').at(-1).length <= 180);
});

test('writes special course and topic text as valid JSON-compatible YAML scalars', () => {
	const course = '编程："类型" #1';
	const topic = '对象: "属性" #重点';
	const content = buildLectureNote(
		{ course, topic, transcript: '原文' },
		'2026-08-06 17:30:00',
	);
	const frontmatter = content.split('---')[1];
	assert.ok(frontmatter);
	const courseLine = frontmatter.match(/^course: (.+)$/m)?.[1];
	const topicLine = frontmatter.match(/^topic: (.+)$/m)?.[1];

	assert.ok(courseLine);
	assert.ok(topicLine);
	assert.equal(JSON.parse(courseLine), course);
	assert.equal(JSON.parse(topicLine), topic);
});

test('preserves a long transcript without truncation or escaping', () => {
	const transcript = `${'第一行：原始文字 # 内容 <不转义>\n'.repeat(500)}最后一行\\路径?`;
	const content = buildLectureNote(
		{ course: '课程', topic: '主题', transcript },
		'2026-08-06 17:30:00',
	);

	assert.ok(content.includes(`## 原始文字稿\n\n${transcript}\n\n## AI 整理结果`));
	assert.equal(content.indexOf(transcript), content.lastIndexOf(transcript));
});

test('preserves transcript leading and trailing whitespace exactly', () => {
	const transcript = '\n\n  第一行保留前导空格\n最后一行保留尾随空格  \n\n';
	const content = buildLectureNote(
		{ course: '课程', topic: '主题', transcript },
		'2026-08-06 17:30:00',
	);

	assert.ok(content.includes(`## 原始文字稿\n\n${transcript}\n\n## AI 整理结果`));
});

test('uses the default prompt only for a blank transcript', () => {
	const content = buildLectureNote(
		{ course: '课程', topic: '主题', transcript: ' \n\t\n ' },
		'2026-08-06 17:30:00',
	);

	assert.ok(content.includes('（未提供原始文字稿。）'));
	assert.equal(content.includes(' \n\t\n '), false);
});

test('prevents duplicate submissions until the active submission finishes', () => {
	const guard = new SubmissionGuard();

	assert.equal(guard.tryStart(), true);
	assert.equal(guard.isSubmitting, true);
	assert.equal(guard.tryStart(), false);
	guard.finish();
	assert.equal(guard.isSubmitting, false);
	assert.equal(guard.tryStart(), true);
});

test('rejects folder paths that can escape the Vault', () => {
	for (const folder of [
		'../Vault 外',
		'课堂笔记/../../Vault 外',
		'课堂笔记\\..\\Vault 外',
		'C:\\其他目录',
		'/绝对路径',
	]) {
		assert.throws(
			() => assertSafeVaultFolderPath(folder),
			/Vault 内的相对路径/,
		);
	}

	assert.doesNotThrow(() => assertSafeVaultFolderPath('课堂笔记/高等数学'));
});
