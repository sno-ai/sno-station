import { atomicExtractionSkillReference } from "../../extraction/atomic-extraction-skill";

export function buildDateResolutionPrompt(): string {
	return `${atomicExtractionSkillReference("calendar-meaning")}\nJudge only the time of the supplied claim. Return reason and time in the supplied JSON schema.`;
}
