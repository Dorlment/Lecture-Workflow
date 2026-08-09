export const PROGRESS_NOTICE_SUCCESS_DURATION_MS = 2_000;
export const PROGRESS_NOTICE_FAILURE_DURATION_MS = 6_000;

export interface ProgressNoticeView {
	setMessage(message: string): unknown;
	hide(): void;
}

export interface ProgressNoticeScheduler {
	setTimeout(callback: () => void, delayMs: number): number;
	clearTimeout(handle: number): void;
}

export interface ProgressNoticeEnvironment {
	createNotice(message: string, durationMs: number): ProgressNoticeView;
	scheduler: ProgressNoticeScheduler;
}

export interface ProgressNoticeLease {
	readonly isOwner: boolean;
	update(message: string): void;
	success(message: string): void;
	failure(message: string): void;
	cancel(message?: string): void;
	finishIfPending(): void;
}

type ProgressNoticeEntryState = 'active' | 'settling' | 'hidden';

interface ProgressNoticeEntry {
	key: string;
	notice: ProgressNoticeView;
	state: ProgressNoticeEntryState;
	hideTimer: number | null;
	hideCalled: boolean;
}

export class ProgressNoticeManager {
	private readonly entries = new Map<string, ProgressNoticeEntry>();
	private disposed = false;

	constructor(private readonly environment: ProgressNoticeEnvironment) {}

	start(key: string, message: string): ProgressNoticeLease {
		if (this.disposed) {
			return new NoopProgressNoticeLease(false);
		}
		const existing = this.entries.get(key);
		if (existing?.state === 'active') {
			return new ManagedProgressNoticeLease(this, existing, false);
		}
		if (existing) {
			this.hideEntry(existing);
		}
		let notice: ProgressNoticeView;
		try {
			notice = this.environment.createNotice(
				redactSensitiveNoticeMessage(message, '正在处理，请稍候…'),
				0,
			);
		} catch {
			return new NoopProgressNoticeLease(true);
		}
		const entry: ProgressNoticeEntry = {
			key,
			notice,
			state: 'active',
			hideTimer: null,
			hideCalled: false,
		};
		this.entries.set(key, entry);
		return new ManagedProgressNoticeLease(this, entry, true);
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		for (const entry of [...this.entries.values()]) {
			this.hideEntry(entry);
		}
		this.entries.clear();
	}

	update(entry: ProgressNoticeEntry, owner: boolean, message: string): void {
		if (!this.canMutate(entry, owner) || entry.state !== 'active') {
			return;
		}
		try {
			entry.notice.setMessage(
				redactSensitiveNoticeMessage(message, '正在处理，请稍候…'),
			);
		} catch {
			this.hideEntry(entry);
		}
	}

	settle(
		entry: ProgressNoticeEntry,
		owner: boolean,
		message: string,
		durationMs: number,
		fallback: string,
	): void {
		if (!this.canMutate(entry, owner) || entry.state !== 'active') {
			return;
		}
		entry.state = 'settling';
		try {
			entry.notice.setMessage(redactSensitiveNoticeMessage(message, fallback));
			entry.hideTimer = this.environment.scheduler.setTimeout(
				() => this.hideEntry(entry),
				durationMs,
			);
		} catch {
			this.hideEntry(entry);
		}
	}

	finishIfPending(entry: ProgressNoticeEntry, owner: boolean): void {
		if (!this.canMutate(entry, owner) || entry.state !== 'active') {
			return;
		}
		this.hideEntry(entry);
	}

	private canMutate(entry: ProgressNoticeEntry, owner: boolean): boolean {
		return owner
			&& !this.disposed
			&& this.entries.get(entry.key) === entry
			&& entry.state !== 'hidden';
	}

	private hideEntry(entry: ProgressNoticeEntry): void {
		if (entry.state === 'hidden') {
			return;
		}
		entry.state = 'hidden';
		if (entry.hideTimer !== null) {
			this.environment.scheduler.clearTimeout(entry.hideTimer);
			entry.hideTimer = null;
		}
		if (!entry.hideCalled) {
			entry.hideCalled = true;
			try {
				entry.notice.hide();
			} catch {
				// The host already removed the Notice; local ownership is still released.
			}
		}
		if (this.entries.get(entry.key) === entry) {
			this.entries.delete(entry.key);
		}
	}
}

class ManagedProgressNoticeLease implements ProgressNoticeLease {
	constructor(
		private readonly manager: ProgressNoticeManager,
		private readonly entry: ProgressNoticeEntry,
		readonly isOwner: boolean,
	) {}

	update(message: string): void {
		this.manager.update(this.entry, this.isOwner, message);
	}

	success(message: string): void {
		this.manager.settle(
			this.entry,
			this.isOwner,
			message,
			PROGRESS_NOTICE_SUCCESS_DURATION_MS,
			'操作已完成。',
		);
	}

	failure(message: string): void {
		this.manager.settle(
			this.entry,
			this.isOwner,
			message,
			PROGRESS_NOTICE_FAILURE_DURATION_MS,
			'操作失败，请检查配置或稍后重试。',
		);
	}

	cancel(message = '操作已取消。'): void {
		this.manager.settle(
			this.entry,
			this.isOwner,
			message,
			PROGRESS_NOTICE_SUCCESS_DURATION_MS,
			'操作已取消。',
		);
	}

	finishIfPending(): void {
		this.manager.finishIfPending(this.entry, this.isOwner);
	}
}

class NoopProgressNoticeLease implements ProgressNoticeLease {
	constructor(readonly isOwner: boolean) {}

	update(_message: string): void {}
	success(_message: string): void {}
	failure(_message: string): void {}
	cancel(_message?: string): void {}
	finishIfPending(): void {}
}

export function redactSensitiveNoticeMessage(message: string, fallback: string): string {
	if (typeof message !== 'string') {
		return fallback;
	}
	const withoutControls = [...message]
		.filter((character) => {
			const codePoint = character.codePointAt(0);
			return codePoint !== undefined
				&& (codePoint === 10 || codePoint === 13 || codePoint >= 32)
				&& codePoint !== 127;
		})
		.join('')
		.trim();
	if (!withoutControls) {
		return fallback;
	}
	const redacted = withoutControls
		.replace(/data:[^,\s]+(?:;[^,\s]+)*;base64,[A-Za-z0-9+/_=-]+/gi, '[敏感内容已隐藏]')
		.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [敏感内容已隐藏]')
		.replace(/\bsk-[A-Za-z0-9_-]{12,}/gi, '[敏感内容已隐藏]')
		.replace(/\b(?:api[ _-]?key|token|base64|pcm)\s*[:=]\s*[^\s;]+/gi, '[敏感内容已隐藏]')
		.replace(/\b[A-Za-z0-9+/_-]{48,}={0,2}\b/g, '[敏感内容已隐藏]');
	return redacted.slice(0, 400) || fallback;
}
