/**
 * Two-lane extraction: the id-keyed enrichment merge, the single-fact fallback, and the
 * output-token batching. These are the deterministic guarantees the two-lane rebuild rests on —
 * a fact is bound to ITS OWN enrichment by id (never by position), a coverage mismatch is
 * rejected so the batch can retry/bisect rather than mis-bind, a fact that never enriches still
 * yields one complete retrievable record, and no batch is capped by fact count.
 */

import { describe, expect, it } from "vitest";
import {
	type AtomicCapturedFact,
	fallbackAtomicCapturedFact,
	parseAtomicEnrichmentReply,
} from "../../../../packages/memory/src/engine/extraction/atomic-extraction-reply";
import { chunkAtomicCapturedFacts } from "../../../../packages/memory/src/engine/extraction/atomic-generic-extractor";

function capturedFact(id: number, fact: string, overrides: Partial<AtomicCapturedFact> = {}): AtomicCapturedFact {
	return {
		id,
		fact,
		subject: "the user",
		subject_kind: "user",
		temporal_phrase: null,
		ended_at_phrase: null,
		source_span: { turn_index: 0, quote: fact },
		...overrides,
	};
}

function enrichment(id: number, value: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id,
		kind: "standing",
		attribute: null,
		value,
		ends_current: false,
		importance: "medium",
		changes_current_state: false,
		todo: "none",
		close_reason: null,
		single_claim: true,
		relations: [],
		time: { kind: "none" },
		ended_time: { kind: "none" },
		...overrides,
	};
}

function reply(...enrichments: Record<string, unknown>[]): string {
	return JSON.stringify({ enrichments });
}

describe("parseAtomicEnrichmentReply — id-keyed merge with coverage validation", () => {
	const facts = [capturedFact(0, "the user likes coffee"), capturedFact(1, "the user lives in Boston")];

	it("carries each fact's own claim_text verbatim and its own enrichment, in fact order", () => {
		const records = parseAtomicEnrichmentReply(
			reply(enrichment(0, "coffee"), enrichment(1, "Boston")),
			facts,
		);
		expect(records).toBeDefined();
		expect(records?.map((r) => r.claimText)).toEqual([
			"the user likes coffee",
			"the user lives in Boston",
		]);
		expect(records?.map((r) => r.value)).toEqual(["coffee", "Boston"]);
	});

	it("binds a fact to ITS OWN enrichment by id even when the reply is in reverse order (never by position)", () => {
		// enrichments arrive [id 1, id 0]. A position merge would give fact 0 the "Boston" value.
		const records = parseAtomicEnrichmentReply(
			reply(enrichment(1, "Boston"), enrichment(0, "coffee")),
			facts,
		);
		expect(records).toBeDefined();
		// Output stays in fact order, each carrying its own id's value — proving position play no part.
		expect(records?.[0]?.claimText).toBe("the user likes coffee");
		expect(records?.[0]?.value).toBe("coffee");
		expect(records?.[1]?.claimText).toBe("the user lives in Boston");
		expect(records?.[1]?.value).toBe("Boston");
	});

	it("rejects a reply with a duplicate id (so the batch retries, never mis-binds)", () => {
		expect(parseAtomicEnrichmentReply(reply(enrichment(0, "a"), enrichment(0, "b")), facts)).toBeUndefined();
	});

	it("rejects a reply missing a fact's id", () => {
		expect(parseAtomicEnrichmentReply(reply(enrichment(0, "coffee")), facts)).toBeUndefined();
	});

	it("rejects a reply carrying an unknown id", () => {
		expect(
			parseAtomicEnrichmentReply(reply(enrichment(0, "coffee"), enrichment(9, "who?")), facts),
		).toBeUndefined();
	});
});

describe("fallbackAtomicCapturedFact — a fact that never enriches is still complete and retrievable", () => {
	it("yields one record whose value is the fact text, with valid default enums", () => {
		const record = fallbackAtomicCapturedFact(capturedFact(3, "the user adopted a dog named Rex"));
		expect(record.claimText).toBe("the user adopted a dog named Rex");
		expect(record.value).toBe("the user adopted a dog named Rex");
		expect(record.value.length).toBeGreaterThan(0);
		expect(record.kind).toBe("occurrence");
		expect(record.todo).toBe("none");
		expect(record.attribute).toBeNull();
		expect(record.time.kind).toBe("unresolved");
		expect(record.endedTime.kind).toBe("none");
	});
});

describe("chunkAtomicCapturedFacts — batched by output-token budget, never capped by fact count", () => {
	it("keeps a small fact list in one batch and loses no fact", () => {
		const facts = [capturedFact(0, "a"), capturedFact(1, "b"), capturedFact(2, "c")];
		const batches = chunkAtomicCapturedFacts(facts);
		expect(batches.flat().map((f) => f.id)).toEqual([0, 1, 2]);
		expect(batches.length).toBe(1);
	});

	it("splits a large fact list into multiple batches while preserving every fact exactly once", () => {
		const facts = Array.from({ length: 120 }, (_, i) => capturedFact(i, `fact number ${i} with enough words to carry real output weight`));
		const batches = chunkAtomicCapturedFacts(facts);
		expect(batches.length).toBeGreaterThan(1);
		const ids = batches.flat().map((f) => f.id);
		expect(ids).toEqual(facts.map((f) => f.id));
		expect(new Set(ids).size).toBe(facts.length);
	});

	it("gives an over-budget single fact its own one-fact batch rather than dropping it", () => {
		const huge = capturedFact(0, "x ".repeat(6000));
		const batches = chunkAtomicCapturedFacts([huge]);
		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(1);
		expect(batches[0]?.[0]?.id).toBe(0);
	});
});
