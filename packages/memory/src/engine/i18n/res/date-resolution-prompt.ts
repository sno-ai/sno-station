import { atomicExtractionSkillReference } from "../../extraction/atomic-extraction-skill";

export function buildDateResolutionPrompt(): string {
	return atomicExtractionSkillReference("calendar-meaning");
}
