export class ScreenshotWorkflowGate {
	private active = false;

	get isActive(): boolean {
		return this.active;
	}

	tryStart(): boolean {
		if (this.active) {
			return false;
		}
		this.active = true;
		return true;
	}

	finish(): void {
		this.active = false;
	}
}
