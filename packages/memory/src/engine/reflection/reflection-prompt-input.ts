import { chunk, countTokens } from "@snoai/chunking";

export function prepareReflectionPromptInputs(
	conversation: string,
	maxInputChars: number,
): string[] {
	const trimmed = conversation.trim();
	if (!trimmed) return [];
	const maxTokens = Math.max(1, Math.floor(maxInputChars / 3));
	if (countTokens(trimmed) <= maxTokens) return [trimmed];
	return chunk(trimmed, {
		contentType: "conversation",
		targetTokens: maxTokens,
		maxTokens,
	}).map((draft) => draft.chunkText);
}
