/** @file insight-distill-types.ts
 * @purpose Shared contracts and constants for Insight Distill modules.
 * @boundary Type/config declarations only; no runtime extraction orchestration.
 */

export type ExtractionDropDisposition =
	| "malformed-text"
	| "subject_not_user";

export interface ExtractionDropRecord {
	disposition: ExtractionDropDisposition;
	originalText: string;
}
