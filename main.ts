import { Notice, Plugin } from 'obsidian';

export default class LectureWorkflowPlugin extends Plugin {
	onload(): void {
		this.addCommand({
			id: 'hello-lecture-workflow',
			name: 'Hello Lecture Workflow',
			callback: () => {
				new Notice('Hello Lecture Workflow');
			},
		});
	}
}
