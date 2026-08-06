import type { LectureNoteInput } from './types';

const DEFAULT_TRANSCRIPT = '（未提供原始文字稿。）';
const MAX_FILE_NAME_LENGTH = 180;
const MARKDOWN_EXTENSION = '.md';

export class SubmissionGuard {
	isSubmitting = false;

	tryStart(): boolean {
		if (this.isSubmitting) {
			return false;
		}

		this.isSubmitting = true;
		return true;
	}

	finish(): void {
		this.isSubmitting = false;
	}
}

export function assertSafeVaultFolderPath(folderPath: string): void {
	const trimmedPath = folderPath.trim();
	const segments = trimmedPath.split(/[\\/]/);
	const isAbsolute = /^[\\/]/.test(trimmedPath) || /^[a-zA-Z]:/.test(trimmedPath);

	if (!trimmedPath || isAbsolute || segments.includes('..')) {
		throw new Error('保存目录必须是 Vault 内的相对路径，且不能包含“..”。');
	}
}

export function sanitizeFileNameSegment(value: string): string {
	const withoutControlCharacters = Array.from(value, (character) =>
		character.charCodeAt(0) <= 31 ? '-' : character,
	).join('');
	const sanitized = withoutControlCharacters
		.replace(/[<>:"/\\|?*]/g, '-')
		.replace(/\s+/g, ' ')
		.replace(/[. ]+$/g, '')
		.trim();

	return sanitized || '未命名';
}

export function createLectureFileBaseName(
	date: string,
	course: string,
	topic: string,
): string {
	const safeCourse = sanitizeFileNameSegment(course);
	const safeTopic = sanitizeFileNameSegment(topic);
	const maximumBaseLength = MAX_FILE_NAME_LENGTH - MARKDOWN_EXTENSION.length;
	const fixedLength = date.length + 2;
	const availableForValues = Math.max(maximumBaseLength - fixedLength, 2);
	const courseLength = Math.max(Math.floor(availableForValues / 2), 1);
	const topicLength = Math.max(availableForValues - courseLength, 1);
	const shortenedCourse = trimFileNameEnd(safeCourse.slice(0, courseLength));
	const shortenedTopic = trimFileNameEnd(safeTopic.slice(0, topicLength));

	return `${date}-${shortenedCourse || '未命名'}-${shortenedTopic || '未命名'}`
		.slice(0, maximumBaseLength)
		.replace(/[. ]+$/g, '');
}

export function findAvailableFilePath(
	folderPath: string,
	baseName: string,
	pathExists: (path: string) => boolean,
): string {
	let suffix = 1;
	let candidate = `${folderPath}/${baseName}${MARKDOWN_EXTENSION}`;

	while (pathExists(candidate)) {
		suffix += 1;
		const suffixText = `-${suffix}`;
		const maximumBaseLength =
			MAX_FILE_NAME_LENGTH - MARKDOWN_EXTENSION.length - suffixText.length;
		const shortenedBaseName = trimFileNameEnd(baseName.slice(0, maximumBaseLength));
		candidate = `${folderPath}/${shortenedBaseName}${suffixText}${MARKDOWN_EXTENSION}`;
	}

	return candidate;
}

export function buildLectureNote(input: LectureNoteInput, created: string): string {
	const transcript = input.transcript.trim() ? input.transcript : DEFAULT_TRANSCRIPT;

	return `---
type: lecture
course: ${JSON.stringify(input.course)}
topic: ${JSON.stringify(input.topic)}
created: ${JSON.stringify(created)}
status: raw
---

# ${input.topic}

## 课程信息

- 课程：${input.course}
- 主题：${input.topic}
- 创建时间：${created}

## 原始文字稿

${transcript}

## AI 整理结果

尚未整理。
`;
}

function trimFileNameEnd(value: string): string {
	return value.replace(/[. ]+$/g, '');
}
