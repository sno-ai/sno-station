/** @file adapter-a-conflict-adjudicator.ts
 * @purpose Renders and parses a fail-safe conflict verdict for an ordered memory pair.
 * @boundary Accepts package-level memory views only; callers adapt their storage records.
 */

import { createHash } from "node:crypto";

export type AdapterAVerdict = "replacement" | "keep" | "uncertain";

export interface AdapterAMemoryView {
	text: string;
	kind: "profile" | "episodic" | "state";
	validFrom: string;
	assertedAt: string;
	contentHash: string;
}

export interface AdapterAMemoryRecord {
	text: string;
	kind: string;
	validFrom: number;
	assertedAt: number;
	contentHash: string;
}

export interface OrderedAdapterAPair {
	older: AdapterAMemoryView;
	newer: AdapterAMemoryView;
	candidateRole: "older" | "newer";
}

export function adapterAViewFromRecord(record: AdapterAMemoryRecord): AdapterAMemoryView {
	if (record.kind !== "profile" && record.kind !== "episodic" && record.kind !== "state") {
		throw new Error(`Adapter A does not accept ${record.kind} memories`);
	}
	return {
		text: record.text,
		kind: record.kind,
		validFrom: isoUtcSeconds(record.validFrom),
		assertedAt: isoUtcSeconds(record.assertedAt),
		contentHash: record.contentHash,
	};
}

export function prospectiveProfileView(text: string, at: number): AdapterAMemoryView {
	return {
		text: text.trim(),
		kind: "profile",
		validFrom: isoUtcSeconds(at),
		assertedAt: isoUtcSeconds(at),
		contentHash: createHash("sha256").update(text.trim()).digest("hex"),
	};
}

export function orderAdapterAPair(
	existing: AdapterAMemoryView,
	candidate: AdapterAMemoryView,
): OrderedAdapterAPair {
	const comparison = compareViews(existing, candidate);
	if (comparison <= 0) {
		return { older: existing, newer: candidate, candidateRole: "newer" };
	}
	return { older: candidate, newer: existing, candidateRole: "older" };
}

export function renderAdapterAPrompt(
	older: AdapterAMemoryView,
	newer: AdapterAMemoryView,
): string {
	return [
		"Judge the relationship of the newer memory to the older memory.",
		"",
		"Older:",
		`kind: ${older.kind}`,
		`validFrom: ${older.validFrom}`,
		`assertedAt: ${older.assertedAt}`,
		`text: ${older.text}`,
		"",
		"Newer:",
		`kind: ${newer.kind}`,
		`validFrom: ${newer.validFrom}`,
		`assertedAt: ${newer.assertedAt}`,
		`text: ${newer.text}`,
		"",
		"Verdict:",
	].join("\n");
}

export function renderAdapterAChatPrompt(pair: Pick<OrderedAdapterAPair, "older" | "newer">): string {
	return [
		"Adjudicate whether the newer memory replaces the older memory.",
		"Return either one JSON object, {\"verdict\":\"replacement|keep|uncertain\"}, or exactly one verdict token.",
		"replacement: the newer memory directly changes or corrects the same fact, state, or preference, so the older memory is no longer true.",
		"keep: the older memory remains valid, is historical, concerns a different fact, coexists with the newer memory, or is only refined without being erased.",
		"uncertain: the relationship is unclear or the evidence is insufficient. Prefer uncertain over guessing.",
		"Apply the same semantics regardless of memory kind.",
		`Older memory:\n${JSON.stringify(pair.older)}`,
		`Newer memory:\n${JSON.stringify(pair.newer)}`,
	].join("\n\n");
}

export function parseAdapterAChatVerdict(raw: string): AdapterAVerdict {
	const trimmed = raw.trim();
	if (trimmed === "replacement" || trimmed === "keep" || trimmed === "uncertain") {
		return trimmed;
	}
	const json = extractJsonFromResponse(trimmed);
	if (!json) return "uncertain";
	try {
		const parsed: unknown = JSON.parse(json);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return "uncertain";
		}
		const verdict = (parsed as Record<string, unknown>)["verdict"];
		return verdict === "replacement" || verdict === "keep" || verdict === "uncertain"
			? verdict
			: "uncertain";
	} catch {
		return "uncertain";
	}
}

function compareViews(a: AdapterAMemoryView, b: AdapterAMemoryView): number {
	const validFrom = Date.parse(a.validFrom) - Date.parse(b.validFrom);
	if (validFrom !== 0) return validFrom;
	return Date.parse(a.assertedAt) - Date.parse(b.assertedAt);
}

function isoUtcSeconds(value: number): string {
	if (!Number.isFinite(value)) throw new Error("Adapter A timestamp must be finite");
	return new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function extractJsonFromResponse(text: string): string | null {
	const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
	if (fenceMatch) {
		return (fenceMatch[1] ?? "").trim();
	}

	const firstBrace = text.indexOf("{");
	if (firstBrace === -1) return null;

	let depth = 0;
	let lastBrace = -1;
	let inString = false;
	let escaped = false;

	for (let i = firstBrace; i < text.length; i++) {
		const ch = text[i];
		if (ch === undefined) continue;

		if (escaped) {
			escaped = false;
			continue;
		}

		if (ch === "\\") {
			escaped = inString;
			continue;
		}

		if (ch === '"') {
			inString = !inString;
			continue;
		}

		if (inString) continue;
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				lastBrace = i;
				break;
			}
		}
	}

	if (lastBrace === -1) return null;
	return text.substring(firstBrace, lastBrace + 1);
}
