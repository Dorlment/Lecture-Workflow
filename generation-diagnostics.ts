/**
 * Generation Diagnostics
 *
 * Minimal observability for the AI structuring pipeline. Diagnostics are
 * attached to generation outcomes and preview data so that manual benchmark
 * runs can measure transcript/image capacity boundaries, durations,
 * finishReason, attempts and completeness without changing AI behavior.
 */

export interface GenerationDiagnostics {
	/** Number of characters in the raw transcript sent to the text provider. */
	transcriptChars: number;
	/**
	 * Rough estimate only: Math.ceil(transcriptChars / 2).
	 * This is NOT the model's real tokenizer count.
	 */
	estimatedInputTokens: number;
	/** Candidate classroom image references found in the note before selection. */
	sourceImageCount: number;
	/** Images actually selected and sent to the vision provider. */
	selectedImageCount: number;
	/** Vision provider call duration; absent for text-only runs. */
	visionDurationMs?: number;
	/** Total time spent in text provider calls (generation + repair). */
	textDurationMs: number;
	/** Wall-clock duration of the whole generation call. */
	totalDurationMs: number;
	/** Real finishReason of the final text provider response. */
	finishReason: string | null;
	/** Number of text provider calls (vision provider calls are not counted). */
	attempts: number;
	isComplete: boolean;
	incompleteReason: string | null;
}

/**
 * Rough input-token estimate: ceil(chars / 2).
 * Deliberately naive — no tokenizer dependency is introduced.
 */
export function estimateInputTokens(transcriptChars: number): number {
	return Math.ceil(transcriptChars / 2);
}

/**
 * Emit exactly one structured benchmark log line for manual measurement.
 * Never logs prompts, transcripts, image data, keys or tokens.
 */
export function logGenerationBenchmark(diagnostics: GenerationDiagnostics): void {
	console.log('[LectureWorkflow][benchmark]', JSON.stringify(diagnostics));
}
