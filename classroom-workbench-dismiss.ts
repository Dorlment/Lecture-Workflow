export interface CollapsibleWorkbenchSidedock {
	collapse?: () => void;
}

export interface DetachableWorkbenchLeaf {
	detach(): void;
}

export type ClassroomWorkbenchDismissMode = 'collapse' | 'close';

export function getClassroomWorkbenchDismissMode(
	sidedock: CollapsibleWorkbenchSidedock,
): ClassroomWorkbenchDismissMode {
	return typeof sidedock.collapse === 'function' ? 'collapse' : 'close';
}

export function dismissClassroomWorkbench(
	sidedock: CollapsibleWorkbenchSidedock,
	leaf: DetachableWorkbenchLeaf,
): ClassroomWorkbenchDismissMode {
	if (typeof sidedock.collapse === 'function') {
		sidedock.collapse.call(sidedock);
		return 'collapse';
	}

	leaf.detach();
	return 'close';
}
