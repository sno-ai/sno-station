/** @file b-profile-projection.ts
 * @purpose Projects B-profile model candidates without destroying content-bearing records.
 * @boundary Pure validation and projection only; no transport, persistence, or pipeline wiring.
 */

import { z, type ZodIssue } from "zod";
import attributeDictionaryResource from "../../../config/attribute-dictionary.json" with {
	type: "json",
};
import {
	buildAttributeSlugIndex,
	parseAttributeDictionary,
	resolveAttributeSlug,
	type AttributeSlugIndex,
} from "./attribute-slug-matcher";
import { normalizeTopicToSectionName } from "./b-profile-section-dictionary-provider";
import { PROFILE_IDENTITY_SECTION } from "./profile-section-writer";
import type { MemoryLane } from "../shared/types";

const payloadSchema = z.record(z.string(), z.unknown());
const candidateSchema = z.record(z.string(), z.unknown());
const bProfilePayloadSchema = z
	.object({ profile_candidates: z.array(z.unknown()) })
	.strict();
const forbiddenCodeOwnedFields = new Set(["section_name", "fact_key", "skills", "active_tasks"]);

/**
 * Addressing is owned by the slug the model emits, resolved against the committed dictionary.
 *
 * It used to be owned by a `section` field, and the deployed adapter has never emitted one:
 * measured 2026-08-18, a live reply carries `slug`, so `section` read `undefined`, every
 * candidate took the unregistered branch, and the whole lane stored nothing a reader could see.
 */
const EXCLUDED_SLUGS = new Set(["trait.constraint"]);

/**
 * `trait.constraint` stays in the artifact and leaves the vocabulary here, so a candidate naming
 * it resolves to nothing exactly like any other unknown name — owner ruling 2026-08-18: a
 * likes/dislikes payload cannot express an inability, and two annotation models agreed on that
 * slug 14% of the time.
 */
const slugVocabulary: AttributeSlugIndex = (() => {
	const dictionary = parseAttributeDictionary(attributeDictionaryResource);
	const slugs = dictionary.slugs.filter((entry) => !EXCLUDED_SLUGS.has(entry.slug));
	return buildAttributeSlugIndex({ ...dictionary, slugs });
})();

type ProfileSection = "identity" | "entities" | "preferences";

/** The families whose records address the single identity section. */
const IDENTITY_FAMILIES = new Set(["identity", "contact"]);
/** Families whose payload is a likes/dislikes pair. */
const LIKES_DISLIKES_FAMILIES = new Set([
	"preference",
	"interest",
	"trait",
	"personality",
	"value",
]);

const likesDislikesPayloadSchema = z
	.object({ likes: z.array(z.string()), dislikes: z.array(z.string()) })
	.strict();
const valueNotesPayloadSchema = z
	.object({ value: z.string(), notes: z.string().nullable() })
	.strict();

type ShapedPayload =
	| { shape: "likes_dislikes"; likes: string[]; dislikes: string[] }
	| { shape: "value_notes"; value: string; notes: string | null };

/** The section a family addresses. Derived in code, never read from the model. */
function sectionForFamily(family: string): ProfileSection {
	if (IDENTITY_FAMILIES.has(family)) return "identity";
	if (family === "entity") return "entities";
	return "preferences";
}

/**
 * The canonical slug and its family, or undefined when the vocabulary claims nothing.
 *
 * The family is the slug's own prefix, not the dictionary entry's `family` field: that field is
 * display-cased ("Trait" against the slug's "trait"), and a second source for one fact is a
 * second thing that can disagree with the slug it describes.
 */
function resolveCandidateSlug(emitted: unknown): { slug: string; family: string } | undefined {
	if (typeof emitted !== "string") return undefined;
	const match = resolveAttributeSlug(slugVocabulary, emitted);
	if (!match) return undefined;
	// A slug with no dot IS its own family, and exactly one shipped slug is that shape:
	// `identity`, the most load-bearing name in the vocabulary. Rejecting it here dropped every
	// bare identity claim. A LEADING dot is still no family at all and stays unresolvable.
	const separator = match.slug.indexOf(".");
	if (separator === 0) return undefined;
	const family = separator === -1 ? match.slug : match.slug.slice(0, separator);
	return { slug: match.slug, family };
}

/** The payload in the one shape its family allows, or undefined when it is a different shape. */
function shapePayloadForFamily(
	family: string,
	payload: Record<string, unknown>,
): ShapedPayload | undefined {
	if (LIKES_DISLIKES_FAMILIES.has(family)) {
		const parsed = likesDislikesPayloadSchema.safeParse(payload);
		return parsed.success ? { shape: "likes_dislikes", ...parsed.data } : undefined;
	}
	const parsed = valueNotesPayloadSchema.safeParse(payload);
	return parsed.success ? { shape: "value_notes", ...parsed.data } : undefined;
}

export const B_PROFILE_DROP_REASONS = [
	"candidate_not_object",
	"payload_not_object",
	"entity_capability_parked",
	"slug_not_in_vocabulary",
	"payload_shape_mismatch",
	"code_owned_fields_stripped",
	"preference_topic_generalized",
	"payload_not_renderable",
] as const;

export type BProfileDropReason = (typeof B_PROFILE_DROP_REASONS)[number];
export type BProfileDisposition =
	| "discard-after-retry"
	| "parked"
	| "quarantined"
	| "strip-and-continue";

export const B_PROFILE_DISPOSITION_BY_REASON: Readonly<
	Record<BProfileDropReason, BProfileDisposition>
> = {
	candidate_not_object: "discard-after-retry",
	payload_not_object: "discard-after-retry",
	entity_capability_parked: "parked",
	slug_not_in_vocabulary: "quarantined",
	payload_shape_mismatch: "quarantined",
	code_owned_fields_stripped: "strip-and-continue",
	preference_topic_generalized: "strip-and-continue",
	payload_not_renderable: "quarantined",
};

export interface BProfileWireRecord {
	category: "profile";
	section_name: string;
	fact_key: string;
	abstract: string;
	overview: string;
	content: string;
}

export interface BProfileProjectedRecord extends BProfileWireRecord {
	rawTopicPhrase?: string;
	/** The canonical dictionary slug this record resolved to; absent on audit records. */
	slug?: string;
	lane: MemoryLane;
	rawCandidateJson: string;
	dispositionReason?: BProfileDropReason;
}

export interface BProfileDispositionRecord {
	reason: BProfileDropReason;
	disposition: BProfileDisposition;
	rawCandidateJson: string;
}

export interface BProfileProjectionError {
	code: "INVALID_B_PROFILE_PAYLOAD";
	issues: ZodIssue[];
}

export type BProfileProjectionResult =
	| {
			ok: true;
			memories: BProfileProjectedRecord[];
			dropped: Record<string, number>;
			dispositions: BProfileDispositionRecord[];
	  }
	| { ok: false; error: BProfileProjectionError };

interface RenderedProfile {
	abstract: string;
	overview: string;
	content: string;
}

export function projectProfileCandidates(input: unknown): BProfileProjectionResult {
	const parsed = bProfilePayloadSchema.safeParse(input);
	if (!parsed.success) {
		return {
			ok: false,
			error: { code: "INVALID_B_PROFILE_PAYLOAD", issues: parsed.error.issues },
		};
	}

	const memories: BProfileProjectedRecord[] = [];
	const dropped: Record<string, number> = {};
	const dispositions: BProfileDispositionRecord[] = [];
	for (const rawCandidate of parsed.data.profile_candidates) {
		const projected = projectCandidate(rawCandidate, dropped, dispositions);
		if (projected) memories.push(projected);
	}
	return { ok: true, memories, dropped, dispositions };
}

function projectCandidate(
	rawCandidate: unknown,
	dropped: Record<string, number>,
	dispositions: BProfileDispositionRecord[],
): BProfileProjectedRecord | undefined {
	const rawCandidateJson = stableCandidateJson(rawCandidate);
	const candidateResult = candidateSchema.safeParse(rawCandidate);
	if (!candidateResult.success) {
		return drop(dispositions, dropped, "candidate_not_object", rawCandidateJson);
	}
	const candidate = candidateResult.data;
	const payloadResult = payloadSchema.safeParse(candidate.payload);
	if (!payloadResult.success) {
		return drop(dispositions, dropped, "payload_not_object", rawCandidateJson);
	}
	const payload = payloadResult.data;
	const resolved = resolveCandidateSlug(candidate.slug);
	if (!resolved) {
		// The vocabulary claimed nothing, so there is no address. The record is kept for
		// diagnosis rather than discarded, and it is one candidate's fate: its siblings in the
		// same reply are projected normally and the reply itself stays valid.
		recordDisposition(dispositions, dropped, "slug_not_in_vocabulary", rawCandidateJson);
		return buildAuditRecord({
			candidate,
			rawCandidateJson,
			sectionName: "preferences.general",
			lane: "quarantined",
			reason: "slug_not_in_vocabulary",
		});
	}
	const section = sectionForFamily(resolved.family);

	if (section === "entities") {
		// Deriving the section is an addressing repair; switching the entity capability on is a
		// separate product decision that is not taken here, so these stay parked.
		recordDisposition(dispositions, dropped, "entity_capability_parked", rawCandidateJson);
		return buildAuditRecord({
			candidate,
			rawCandidateJson,
			sectionName: resolveEntitySection(candidate, payload),
			lane: "parked",
			reason: "entity_capability_parked",
		});
	}

	const forbidden = findForbiddenFields(candidate, payload);
	if (forbidden.length > 0) {
		recordDisposition(dispositions, dropped, "code_owned_fields_stripped", rawCandidateJson);
		for (const field of forbidden) {
			delete candidate[field];
			delete payload[field];
		}
	}

	const topic = candidate.topic_phrase;
	let sectionName =
		section === "identity"
			? PROFILE_IDENTITY_SECTION
			: normalizeTopicToSectionName(typeof topic === "string" ? topic : "");
	if (section === "preferences" && !sectionName.startsWith("preferences.")) {
		sectionName = "preferences.general";
	}
	if (section === "preferences" && sectionName === "preferences.general") {
		recordDisposition(dispositions, dropped, "preference_topic_generalized", rawCandidateJson);
	}
	const shaped = shapePayloadForFamily(resolved.family, payload);
	if (!shaped) {
		// The slug named a family, and the payload is not that family's shape. One candidate's
		// fate again: siblings survive and the reply stays valid.
		recordDisposition(dispositions, dropped, "payload_shape_mismatch", rawCandidateJson);
		return buildAuditRecord({
			candidate,
			rawCandidateJson,
			sectionName,
			lane: "quarantined",
			reason: "payload_shape_mismatch",
		});
	}
	const rendered = renderProfile(shaped);
	if (!rendered) {
		recordDisposition(dispositions, dropped, "payload_not_renderable", rawCandidateJson);
		return buildAuditRecord({
			candidate,
			rawCandidateJson,
			sectionName,
			lane: "quarantined",
			reason: "payload_not_renderable",
		});
	}
	// No length floor here, unlike free-text capture. A keyed card earns its place from the slug
	// it resolved to, not from how long its value reads: the adapter is trained to answer a bare
	// value ("Berlin", "台北"), and the 10-code-point free-text floor quarantined every one of
	// them. Emptiness is still refused above, by renderProfile returning undefined.
	return buildProjectedRecord(sectionName, rendered, candidate, rawCandidateJson, {
		lane: "active",
		slug: resolved.slug,
	});
}

function buildProjectedRecord(
	sectionName: string,
	rendered: RenderedProfile,
	candidate: Record<string, unknown>,
	rawCandidateJson: string,
	disposition: { lane: MemoryLane; reason?: BProfileDropReason; slug?: string },
): BProfileProjectedRecord {
	return {
		category: "profile",
		section_name: sectionName,
		fact_key: sectionName,
		...rendered,
		lane: disposition.lane,
		rawCandidateJson,
		...(disposition.reason ? { dispositionReason: disposition.reason } : {}),
		...(disposition.slug ? { slug: disposition.slug } : {}),
		...(typeof candidate.topic_phrase === "string"
			? { rawTopicPhrase: candidate.topic_phrase }
			: {}),
	};
}

function buildAuditRecord(input: {
	candidate: Record<string, unknown>;
	rawCandidateJson: string;
	sectionName: string;
	lane: "parked" | "quarantined";
	reason: BProfileDropReason;
}): BProfileProjectedRecord {
	const rendered: RenderedProfile = {
		abstract: takeCodePoints(input.rawCandidateJson, 200),
		overview: input.rawCandidateJson,
		content: input.rawCandidateJson,
	};
	return buildProjectedRecord(
		input.sectionName,
		rendered,
		input.candidate,
		input.rawCandidateJson,
		{ lane: input.lane, reason: input.reason },
	);
}

function resolveEntitySection(
	_candidate: Record<string, unknown>,
	payload: Record<string, unknown>,
): string {
	const rawKind =
		typeof payload.kind === "string"
			? payload.kind
			: typeof payload.entity_kind === "string"
				? payload.entity_kind
				: "person";
	const sectionName = normalizeTopicToSectionName(rawKind);
	return sectionName.startsWith("entities.") ? sectionName : "entities.person";
}

function recordDisposition(
	dispositions: BProfileDispositionRecord[],
	dropped: Record<string, number>,
	reason: BProfileDropReason,
	rawCandidateJson: string,
): void {
	dispositions.push({
		reason,
		disposition: B_PROFILE_DISPOSITION_BY_REASON[reason],
		rawCandidateJson,
	});
	dropped[reason] = (dropped[reason] ?? 0) + 1;
}

function drop(
	dispositions: BProfileDispositionRecord[],
	dropped: Record<string, number>,
	reason: BProfileDropReason,
	rawCandidateJson: string,
): undefined {
	recordDisposition(dispositions, dropped, reason, rawCandidateJson);
	return undefined;
}

function findForbiddenFields(
	candidate: Record<string, unknown>,
	payload: Record<string, unknown>,
): string[] {
	return [...forbiddenCodeOwnedFields]
		.filter((field) => field in candidate || field in payload)
		.sort();
}

/** The payload's shape selects the renderer; the section never does. */
function renderProfile(shaped: ShapedPayload): RenderedProfile | undefined {
	return shaped.shape === "likes_dislikes" ? renderLikesDislikes(shaped) : renderValueNotes(shaped);
}

function renderLikesDislikes(payload: {
	likes: string[];
	dislikes: string[];
}): RenderedProfile | undefined {
	const likes = stringList(payload.likes);
	const dislikes = stringList(payload.dislikes);
	if (likes.length === 0 && dislikes.length === 0) return undefined;

	const parts: string[] = [];
	if (likes.length > 0) parts.push(`The user likes ${joinItems(likes)}.`);
	if (dislikes.length > 0) parts.push(`The user dislikes ${joinItems(dislikes)}.`);
	const content = parts.join(" ");
	const firstPart = parts[0] ?? content;
	return {
		abstract: codePointLength(content) <= 200 ? content : firstPart,
		overview: content,
		content,
	};
}

function renderValueNotes(payload: {
	value: string;
	notes: string | null;
}): RenderedProfile | undefined {
	const value = payload.value.trim();
	if (!value) return undefined;
	const notes = payload.notes?.trim();
	const content = notes ? `${value} (${notes})` : value;
	return { abstract: takeCodePoints(content, 200), overview: content, content };
}

function stringList(value: unknown): string[] {
	const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
	return values
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
}

function joinItems(items: string[]): string {
	if (items.length === 1) return items[0] ?? "";
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
}

function stableCandidateJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "null";
	} catch {
		return String(value);
	}
}

function codePointLength(value: string): number {
	return [...value].length;
}

function takeCodePoints(value: string, max: number): string {
	return [...value].slice(0, max).join("");
}
