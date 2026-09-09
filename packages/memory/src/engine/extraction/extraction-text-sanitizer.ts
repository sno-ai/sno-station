/** @file extraction-text-sanitizer.ts
 * @purpose Normalize runtime payload text before it reaches memory extraction.
 * @boundary Removes channel/runtime envelope metadata only; does not classify or persist memories.
 */

import { sanitizeContentIngress } from "@snoai/content-sanitizer";
import { stripAmbientLearningInjectedPrefix } from "./ambient-learning-text-normalizer";
import { stripLeadingRuntimeWrappers } from "./runtime-wrapper-sanitizer";

/**
 * Build the string that goes into the `text` column of nodix_memories.
 *
 * The FTS5 BM25 index is derived from this column only (see
 * drizzle/0001_virtual_tables.sql). Concatenating abstract and content gives
 * BM25 the same source surface used for vector embedding.
 */
export function buildIndexedText(abstract: string, content: string): string {
	const trimmed = content.trim();
	if (!trimmed || trimmed === abstract.trim()) return abstract;
	return `${abstract}\n${trimmed}`;
}

function isLikelyDelimitedMetadataLine(line: string | undefined): boolean {
	const trimmed = line?.trim();
	if (!trimmed) return false;
	if (/^(?:sender token|hidden starter|private context)\b/i.test(trimmed)) return true;
	if (/^(?:sender|message|conversation|thread|channel|workspace|timestamp|created_at|replied message)\b/i.test(trimmed)) {
		return true;
	}
	if (/^[{[\]},]+$/.test(trimmed)) return true;
	if (/^"[^"]+"\s*:/.test(trimmed)) return true;
	return false;
}

function stripDelimitedMetadataBlock(text: string, headerPattern: RegExp): string {
	const lines = text.split("\n");
	const kept: string[] = [];

	for (let idx = 0; idx < lines.length; idx += 1) {
		const line = lines[idx];
		if (!line || !headerPattern.test(line)) {
			kept.push(line ?? "");
			continue;
		}

		let scanIdx = idx + 1;
		while (scanIdx < lines.length && lines[scanIdx]?.trim() !== "") {
			scanIdx += 1;
		}

		if (scanIdx >= lines.length) {
			let fallbackIdx = idx + 1;
			while (
				fallbackIdx < lines.length &&
				isLikelyDelimitedMetadataLine(lines[fallbackIdx])
			) {
				fallbackIdx += 1;
			}
			idx = fallbackIdx - 1;
			continue;
		}

		while (scanIdx < lines.length && lines[scanIdx]?.trim() === "") {
			scanIdx += 1;
		}
		idx = scanIdx - 1;
	}

	return kept.join("\n");
}

/**
 * Strip platform envelope metadata injected by OpenClaw channels before the
 * conversation text reaches the extraction LLM.
 */
export function stripEnvelopeMetadata(text: string): string {
	const threadStarterHeaderRe = /^Thread starter\s*\(untrusted, for context\):\s*$/i;
	const forwardedContextHeaderRe = /^Forwarded message context\s*\(untrusted metadata\):\s*$/i;

	let cleaned = stripLeadingRuntimeWrappers(text);
	cleaned = stripAmbientLearningInjectedPrefix("user", cleaned);
	cleaned = cleaned.replace(/^<<<EXTERNAL_UNTRUSTED_CONTENT\b.*$/gim, "");
	cleaned = cleaned.replace(/^<<<END_EXTERNAL_UNTRUSTED_CONTENT\b.*$/gim, "");
	cleaned = cleaned.replace(
		/^Sender\s*\(untrusted metadata\):\s*\n```json\n[\s\S]*?\n```\s*/gim,
		"",
	);
	cleaned = cleaned.replace(
		/^Conversation info\s*\(untrusted metadata\):\s*\n```json\n[\s\S]*?\n```\s*/gim,
		"",
	);
	cleaned = stripDelimitedMetadataBlock(cleaned, threadStarterHeaderRe);
	cleaned = stripDelimitedMetadataBlock(cleaned, forwardedContextHeaderRe);
	cleaned = cleaned.replace(/^\[Queued messages while agent was busy\]\s*/gim, "");
	cleaned = cleaned.replace(/^System:\s*\[[\d\-: +GMT]+\]\s+\S+\[.*?\].*$/gm, "");
	cleaned = cleaned.replace(
		/(?:Conversation info|Sender|Replied message)\s*\(untrusted[^)]*\):\s*```json\s*\{[\s\S]*?\}\s*```/g,
		"",
	);
	cleaned = cleaned.replace(
		/```json\s*\{[^}]*"message_id"\s*:[^}]*"sender_id"\s*:[^}]*\}\s*```/g,
		"",
	);
	cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

	return sanitizeContentIngress({
		source: "openclaw",
		content: cleaned,
	}).projections.plainText;
}
