export interface ClassroomWorkbenchLeaf {
	setViewState(state: { type: string; active: boolean }): Promise<void>;
}

export interface ClassroomWorkbenchWorkspace<TLeaf extends ClassroomWorkbenchLeaf> {
	getLeavesOfType(viewType: string): TLeaf[];
	getRightLeaf(split: boolean): TLeaf | null;
	revealLeaf(leaf: TLeaf): Promise<void>;
	setActiveLeaf(leaf: TLeaf, params: { focus: boolean }): void;
}

export class ClassroomWorkbenchOpener<TLeaf extends ClassroomWorkbenchLeaf> {
	private inFlight: Promise<void> | null = null;

	constructor(
		private readonly workspace: ClassroomWorkbenchWorkspace<TLeaf>,
		private readonly viewType: string,
	) {}

	open(): Promise<void> {
		if (this.inFlight) {
			return this.inFlight;
		}
		const task = this.openOnce();
		this.inFlight = task;
		void task.finally(() => {
			if (this.inFlight === task) {
				this.inFlight = null;
			}
		}).catch(() => undefined);
		return task;
	}

	private async openOnce(): Promise<void> {
		let leaf = this.workspace.getLeavesOfType(this.viewType)[0];
		if (!leaf) {
			leaf = this.workspace.getRightLeaf(true) ?? undefined;
			if (!leaf) {
				throw new ClassroomWorkbenchOpenError('create-leaf');
			}
			try {
				await leaf.setViewState({
					type: this.viewType,
					active: true,
				});
			} catch {
				throw new ClassroomWorkbenchOpenError('set-view-state');
			}
		}

		try {
			await this.workspace.revealLeaf(leaf);
			this.workspace.setActiveLeaf(leaf, { focus: true });
		} catch {
			throw new ClassroomWorkbenchOpenError('reveal-leaf');
		}
	}
}

export type ClassroomWorkbenchOpenStage =
	| 'create-leaf'
	| 'set-view-state'
	| 'reveal-leaf';

export class ClassroomWorkbenchOpenError extends Error {
	constructor(readonly stage: ClassroomWorkbenchOpenStage) {
		super('Classroom workbench could not be opened.');
		this.name = 'ClassroomWorkbenchOpenError';
	}
}
