export type VisionWorkflowRoute = 'text-only' | 'offer-text-only' | 'vision';

export function decideVisionWorkflowRoute(
	imageCount: number,
	enableVisionInput: boolean,
): VisionWorkflowRoute {
	if (imageCount === 0) {
		return 'text-only';
	}
	return enableVisionInput ? 'vision' : 'offer-text-only';
}

export function shouldAcceptVisionResult(signal: AbortSignal): boolean {
	return !signal.aborted;
}
