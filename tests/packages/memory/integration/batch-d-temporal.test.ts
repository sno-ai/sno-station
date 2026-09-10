/** Real LLM API required. No mocking. Missing keys = FAIL. */

import { describe, expect, it } from "vitest";
import { stripEnvelopeMetadata } from "../../../../apps/mem-claw/src/extraction/extraction-text-sanitizer.ts";
import {
	buildInsightMetadata,
	isMemoryExpired,
	parseInsightMetadata,
} from "../../../../apps/mem-claw/src/extraction/memory-metadata-codec.ts";
import { isoDateFromMs } from "../../../../apps/mem-claw/src/shared/iso-date-time.ts";
import {
	classifyTemporal,
	inferExpiry,
	type TemporalType,
} from "../../../../apps/mem-claw/src/extraction/memory-temporality-classifier.ts";
import {
	createRetentionScorer,
	DEFAULT_DECAY_CONFIG,
	type DecayConfig,
} from "../../../../apps/mem-claw/src/operations/selective-forgetting-scorer.ts";
import type { DecayableMemory } from "../../../../apps/mem-claw/src/shared/types.ts";

const episodicInsightMetadata = {
	kind: "episodic",
	memory_category: "episodic",
} as const;

// ============================================================================
// D2: memory-temporality-classifier.ts
// ============================================================================

describe("classifyTemporal", () => {
	// --- English dynamic keywords ---
	it.each([
		["I have a meeting today", "dynamic"],
		["Yesterday I went to the store", "dynamic"],
		["Tomorrow we deploy the release", "dynamic"],
		["She recently started jogging", "dynamic"],
		["The server is currently down", "dynamic"],
		["I need help right now", "dynamic"],
		["This week we do sprint planning", "dynamic"],
		["Last week the server crashed", "dynamic"],
		["Tonight we have team dinner at 7pm", "dynamic"],
		["I'll handle this later today", "dynamic"],
		["This morning I reviewed the PR", "dynamic"],
	] as [string, TemporalType][])("EN dynamic: %s → %s", (text, expected) => {
		expect(classifyTemporal(text)).toBe(expected);
	});

	// --- English static keywords ---
	it.each([
		["My favorite color is blue", "static"],
		["I prefer dark mode", "static"],
		["She always drinks coffee in the morning", "static"],
		["My name is Alice", "static"],
		["He was born in 1990", "static"],
		["I graduated from MIT", "static"],
		["I live in San Francisco", "static"],
		["I work at Anthropic", "static"],
		["My hobby is rock climbing", "static"],
		["I am allergic to peanuts", "static"],
	] as [string, TemporalType][])("EN static: %s → %s", (text, expected) => {
		expect(classifyTemporal(text)).toBe(expected);
	});

	// --- Chinese keywords ---
	it("ZH dynamic: 今天有个会议", () => {
		expect(classifyTemporal("今天有个会议")).toBe("dynamic");
	});

	it("ZH dynamic: 昨天去了商店", () => {
		expect(classifyTemporal("昨天去了商店")).toBe("dynamic");
	});

	it("ZH dynamic: 明天要部署", () => {
		expect(classifyTemporal("明天要部署")).toBe("dynamic");
	});

	it("ZH static: 我喜欢蓝色", () => {
		expect(classifyTemporal("我喜欢蓝色")).toBe("static");
	});

	it("ZH static: 他的名字叫做小明", () => {
		expect(classifyTemporal("他的名字叫做小明")).toBe("static");
	});

	// --- Word-boundary protection ---
	it("EN word-boundary: 'collateral' does NOT match 'later'", () => {
		expect(classifyTemporal("Collateral damage from the refactor")).toBe(
			"static",
		);
	});

	it("EN word-boundary: 'bilateral' does NOT match 'later'", () => {
		expect(classifyTemporal("The bilateral trade agreement")).toBe("static");
	});

	it("EN word-boundary: 'collateralize' does NOT match 'later'", () => {
		expect(classifyTemporal("We need to collateralize the loan")).toBe(
			"static",
		);
	});

	it.each([
		"We moved this to the player layer",
		"The sailors shouted ahoy from the deck",
		"The hierarchy has three levels",
	])("cross-language word boundaries keep ordinary English static: %s", (text) => {
		expect(classifyTemporal(text)).toBe("static");
	});

	it("bare 'later' is static — too ambiguous for temporal classification", () => {
		expect(classifyTemporal("I'll handle this later")).toBe("static");
		expect(classifyTemporal("Handle errors later in the pipeline")).toBe(
			"static",
		);
		expect(classifyTemporal("The company was founded 10 years later")).toBe(
			"static",
		);
	});

	it("compound 'later today/tonight/this' is dynamic", () => {
		expect(classifyTemporal("I'll do it later today")).toBe("dynamic");
		expect(classifyTemporal("We'll discuss later tonight")).toBe("dynamic");
		expect(classifyTemporal("Finish later this week")).toBe("dynamic");
	});

	// --- Both match → dynamic wins ---
	it("both dynamic and static keywords → dynamic wins", () => {
		// "today" is dynamic, "favorite" is static
		expect(classifyTemporal("Today I found my new favorite restaurant")).toBe(
			"dynamic",
		);
	});

	// --- Neither match → static (safe default) ---
	it("neither dynamic nor static keywords → defaults to static", () => {
		expect(
			classifyTemporal("The quick brown fox jumps over the lazy dog"),
		).toBe("static");
	});

	it("empty string → static", () => {
		expect(classifyTemporal("")).toBe("static");
	});
});

describe("inferExpiry", () => {
	const BASE = 1_700_000_000_000; // fixed timestamp for deterministic tests
	const HOUR = 60 * 60 * 1000;
	const DAY = 24 * HOUR;

	it("'tomorrow' → +24h", () => {
		expect(inferExpiry("Tomorrow we deploy", BASE)).toBe(BASE + 24 * HOUR);
	});

	it("'next week' → +7d", () => {
		expect(inferExpiry("Next week is sprint planning", BASE)).toBe(
			BASE + 7 * DAY,
		);
	});

	it("'today' → +18h", () => {
		expect(inferExpiry("Today I learned about Rust", BASE)).toBe(
			BASE + 18 * HOUR,
		);
	});

	it("'tonight' → +12h", () => {
		expect(inferExpiry("Tonight we have team dinner", BASE)).toBe(
			BASE + 12 * HOUR,
		);
	});

	it("'this week' → +3d", () => {
		expect(inferExpiry("This week we're doing sprint planning", BASE)).toBe(
			BASE + 3 * DAY,
		);
	});

	it("'this month' → +15d", () => {
		expect(inferExpiry("This month the project wraps up", BASE)).toBe(
			BASE + 15 * DAY,
		);
	});

	it("'next month' → +30d", () => {
		expect(inferExpiry("Next month we launch v2", BASE)).toBe(BASE + 30 * DAY);
	});

	it("'day after tomorrow' → +48h (matched before 'tomorrow')", () => {
		expect(inferExpiry("Day after tomorrow is the deadline", BASE)).toBe(
			BASE + 48 * HOUR,
		);
	});

	it("ZH: '明天' → +24h", () => {
		expect(inferExpiry("明天要开会", BASE)).toBe(BASE + 24 * HOUR);
	});

	it("ZH: '下周' → +7d", () => {
		expect(inferExpiry("下周有冲刺规划", BASE)).toBe(BASE + 7 * DAY);
	});

	it("ZH: '今天' → +18h", () => {
		expect(inferExpiry("今天学了Rust", BASE)).toBe(BASE + 18 * HOUR);
	});

	it("ZH: '后天' → +48h", () => {
		expect(inferExpiry("后天是截止日期", BASE)).toBe(BASE + 48 * HOUR);
	});

	it("no temporal expression → undefined", () => {
		expect(inferExpiry("My favorite color is blue", BASE)).toBeUndefined();
	});

	it("static keywords do NOT trigger expiry", () => {
		expect(inferExpiry("I prefer dark mode", BASE)).toBeUndefined();
	});

	it("defaults to Date.now() when now not provided", () => {
		const before = Date.now();
		const result = inferExpiry("tomorrow test");
		const after = Date.now();
		expect(result).toBeDefined();
		if (result === undefined) {
			throw new Error("expected inferExpiry to return a timestamp");
		}
		// Result should be ~24h from now (within the test execution window)
		expect(result).toBeGreaterThanOrEqual(before + 24 * HOUR);
		expect(result).toBeLessThanOrEqual(after + 24 * HOUR);
	});
});

// ============================================================================
// D3: insight-metadata temporal fields
// ============================================================================

describe("isMemoryExpired", () => {
	const NOW = 1_700_000_000_000;

	it("valid_until in the past → expired", () => {
		expect(isMemoryExpired({ valid_until: NOW - 1000 }, NOW)).toBe(true);
	});

	it("valid_until exactly now → expired (boundary: <=)", () => {
		expect(isMemoryExpired({ valid_until: NOW }, NOW)).toBe(true);
	});

	it("valid_until in the future → not expired", () => {
		expect(isMemoryExpired({ valid_until: NOW + 1000 }, NOW)).toBe(false);
	});

	it("valid_until undefined → not expired", () => {
		expect(isMemoryExpired({ valid_until: undefined }, NOW)).toBe(false);
	});

	it("an episodic row is never expired: its window is the event's, not the memory's", () => {
		// The classifier writes the event's own day as valid_from/valid_until, so a record
		// of any past event would otherwise count as expired the moment it was written.
		expect(
			isMemoryExpired({ memory_category: "episodic", valid_until: NOW - 1000 }, NOW),
		).toBe(false);
	});

	it("a non-episodic row with a lapsed window still expires", () => {
		expect(
			isMemoryExpired({ memory_category: "profile", valid_until: NOW - 1000 }, NOW),
		).toBe(true);
	});

	it("defaults to Date.now() when at not provided", () => {
		// valid_until far in the past
		expect(isMemoryExpired({ valid_until: 1000 })).toBe(true);
		// valid_until far in the future
		expect(isMemoryExpired({ valid_until: Date.now() + 999_999_999 })).toBe(
			false,
		);
	});
});

describe("parseInsightMetadata temporal fields", () => {
	it("parses memory_temporal_type and valid_until from JSON", () => {
		const meta = JSON.stringify({
			...episodicInsightMetadata,
			memory_temporal_type: "dynamic",
			valid_until: 1_700_000_100_000,
		});
		const parsed = parseInsightMetadata(meta);
		expect(parsed.memory_temporal_type).toBe("dynamic");
		expect(parsed.valid_until).toBe(1_700_000_100_000);
	});

	it("parses static temporal type", () => {
		const meta = JSON.stringify({
			...episodicInsightMetadata,
			memory_temporal_type: "static",
		});
		const parsed = parseInsightMetadata(meta);
		expect(parsed.memory_temporal_type).toBe("static");
		expect(parsed.valid_until).toBeUndefined();
	});

	it("invalid temporal type → undefined", () => {
		const meta = JSON.stringify({
			...episodicInsightMetadata,
			memory_temporal_type: "bogus",
		});
		const parsed = parseInsightMetadata(meta);
		expect(parsed.memory_temporal_type).toBeUndefined();
	});

	it("missing fields → undefined (legacy compat)", () => {
		const parsed = parseInsightMetadata(JSON.stringify(episodicInsightMetadata));
		expect(parsed.memory_temporal_type).toBeUndefined();
		expect(parsed.valid_until).toBeUndefined();
	});

	it("negative valid_until → undefined", () => {
		const meta = JSON.stringify({ ...episodicInsightMetadata, valid_until: -1 });
		const parsed = parseInsightMetadata(meta);
		expect(parsed.valid_until).toBeUndefined();
	});

	it("zero valid_until → undefined", () => {
		const meta = JSON.stringify({ ...episodicInsightMetadata, valid_until: 0 });
		const parsed = parseInsightMetadata(meta);
		expect(parsed.valid_until).toBeUndefined();
	});

	it("parses ISO event_at from JSON", () => {
		const meta = JSON.stringify({
			...episodicInsightMetadata,
			event_at: "2024-03-15T12:30:00Z",
		});
		const parsed = parseInsightMetadata(meta);
		expect(parsed.event_at).toBe("2024-03-15T12:30:00Z");
	});

	it("rejects non-ISO event_at strings", () => {
		const meta = JSON.stringify({
			...episodicInsightMetadata,
			event_at: "March 15, 2024",
		});
		const parsed = parseInsightMetadata(meta);
		// The unparseable event_at is rejected; an episodic memory still needs a
		// date, so it falls back to valid_from (the session day) rather than blank.
		expect(parsed.event_at).toBe(isoDateFromMs(parsed.valid_from));
	});

	it("rejects impossible calendar event_at dates", () => {
		const meta = JSON.stringify({
			...episodicInsightMetadata,
			event_at: "2024-02-30",
		});
		const parsed = parseInsightMetadata(meta);
		// The unparseable event_at is rejected; an episodic memory still needs a
		// date, so it falls back to valid_from (the session day) rather than blank.
		expect(parsed.event_at).toBe(isoDateFromMs(parsed.valid_from));
	});
});

describe("buildInsightMetadata temporal fields", () => {
	it("applies temporal patch fields", () => {
		const built = buildInsightMetadata(
			{ text: "test", category: "episodic" },
			{
				memory_temporal_type: "dynamic",
				valid_until: 1_700_000_100_000,
			},
		);
		expect(built.memory_temporal_type).toBe("dynamic");
		expect(built.valid_until).toBe(1_700_000_100_000);
	});

	it("preserves base temporal fields when patch is undefined", () => {
		const base = JSON.stringify({
			...episodicInsightMetadata,
			memory_temporal_type: "dynamic",
			valid_until: 1_700_000_100_000,
		});
		const built = buildInsightMetadata(
			{ text: "test", category: "episodic", metadata: base },
			{ confidence: 0.9 },
		);
		expect(built.memory_temporal_type).toBe("dynamic");
		expect(built.valid_until).toBe(1_700_000_100_000);
	});

	it("overwrites base temporal type with patch", () => {
		const base = JSON.stringify({
			...episodicInsightMetadata,
			memory_temporal_type: "dynamic",
		});
		const built = buildInsightMetadata(
			{ text: "test", category: "episodic", metadata: base },
			{ memory_temporal_type: "static" },
		);
		expect(built.memory_temporal_type).toBe("static");
	});

	it("invalid patch temporal type → undefined", () => {
		const built = buildInsightMetadata(
			{ text: "test", category: "episodic" },
			{ memory_temporal_type: "bogus" as "static" | "dynamic" },
		);
		expect(built.memory_temporal_type).toBeUndefined();
	});

	it("round-trips through parse → build", () => {
		const original = JSON.stringify({
			...episodicInsightMetadata,
			memory_temporal_type: "dynamic",
			valid_until: 1_700_000_100_000,
			source: "ambient-learning",
		});
		const parsed = parseInsightMetadata(original);
		const rebuilt = buildInsightMetadata(
			{ text: "test", category: "episodic", metadata: original },
			{},
		);
		expect(rebuilt.memory_temporal_type).toBe(parsed.memory_temporal_type);
		expect(rebuilt.valid_until).toBe(parsed.valid_until);
	});

	it("rejects non-ISO event_at patch strings", () => {
		const built = buildInsightMetadata(
			{ text: "test", category: "episodic" },
			{ event_at: "Friday afternoon" },
		);
		// Unparseable event_at is rejected; an episodic memory still needs a date,
		// so it falls back to valid_from (the session day) rather than blank.
		expect(built.event_at).toBe(isoDateFromMs(built.valid_from));
	});

	it("rejects impossible calendar event_at patch dates", () => {
		const built = buildInsightMetadata(
			{ text: "test", category: "episodic" },
			{ event_at: "2024-04-31" },
		);
		// Unparseable event_at is rejected; an episodic memory still needs a date,
		// so it falls back to valid_from (the session day) rather than blank.
		expect(built.event_at).toBe(isoDateFromMs(built.valid_from));
	});

	it("keeps a valid existing event_at when an update patch date is unparseable", () => {
		const original = JSON.stringify({
			kind: "episodic",
			memory_category: "episodic",
			event_at: "2024-03-15",
			valid_from: Date.parse("2024-03-15T00:00:00Z"),
		});
		const rebuilt = buildInsightMetadata(
			{ text: "test", category: "episodic", metadata: original },
			{ event_at: "Friday afternoon" },
		);
		// The unparseable patch value must NOT shadow the valid stored date and
		// silently move the event onto the session day.
		expect(rebuilt.event_at).toBe("2024-03-15");
	});
});

// ============================================================================
// D4: decay-engine 3× faster dynamic
// ============================================================================

describe("Decay engine temporal type", () => {
	const NOW = 1_700_000_000_000;
	const DAY_MS = 86_400_000;

	function makeMemory(
		overrides: Partial<DecayableMemory> = {},
	): DecayableMemory {
		return {
			id: "test-mem",
			importance: 0.7,
			confidence: 0.7,
			tier: "working",
			accessCount: 1,
			createdAt: NOW - 14 * DAY_MS,
			lastAccessedAt: NOW - 14 * DAY_MS,
			metadata: JSON.stringify(episodicInsightMetadata),
			...overrides,
		};
	}

	it("dynamic memory decays faster than static at same age/importance", () => {
		const engine = createRetentionScorer();
		const staticMem = makeMemory({ id: "static", temporalType: "static" });
		const dynamicMem = makeMemory({ id: "dynamic", temporalType: "dynamic" });

		const staticScore = engine.score(staticMem, NOW);
		const dynamicScore = engine.score(dynamicMem, NOW);

		// Dynamic should have lower recency (decays 3× faster)
		expect(dynamicScore.recency).toBeLessThan(staticScore.recency);
		// Composite also lower since recency is a significant component
		expect(dynamicScore.composite).toBeLessThan(staticScore.composite);
	});

	it("undefined temporalType decays same as static (safe default)", () => {
		const engine = createRetentionScorer();
		const staticMem = makeMemory({ id: "static", temporalType: "static" });
		const undefinedMem = makeMemory({
			id: "undefined",
			temporalType: undefined,
		});

		const staticScore = engine.score(staticMem, NOW);
		const undefinedScore = engine.score(undefinedMem, NOW);

		expect(undefinedScore.recency).toBeCloseTo(staticScore.recency, 10);
		expect(undefinedScore.composite).toBeCloseTo(staticScore.composite, 10);
	});

	it("falls back to metadata.memory_temporal_type when temporalType is omitted", () => {
		const engine = createRetentionScorer();
		const staticMem = makeMemory({
			id: "static-meta",
			metadata: JSON.stringify({
				...episodicInsightMetadata,
				memory_temporal_type: "static",
			}),
		});
		const dynamicMem = makeMemory({
			id: "dynamic-meta",
			metadata: JSON.stringify({
				...episodicInsightMetadata,
				memory_temporal_type: "dynamic",
			}),
		});

		const staticScore = engine.score(staticMem, NOW);
		const dynamicScore = engine.score(dynamicMem, NOW);

		expect(dynamicScore.recency).toBeLessThan(staticScore.recency);
		expect(dynamicScore.composite).toBeLessThan(staticScore.composite);
	});

	it("dynamic decay ratio is approximately 3× (verifiable via recency)", () => {
		// Use a known half-life so we can predict the ratio
		const config: DecayConfig = {
			temporalDecay: true,
			recencyHalfLifeDays: 30,
			recencyWeight: 1,
			frequencyWeight: 0,
			intrinsicWeight: 0,
			staleThreshold: 0.1,
			searchBoostMin: 0.3,
			importanceModulation: 0, // remove importance modulation for clean ratio
			betaCore: 1,
			betaWorking: 1,
			betaPeripheral: 1,
			coreDecayFloor: 0,
			workingDecayFloor: 0,
			peripheralDecayFloor: 0,
		};
		const engine = createRetentionScorer(config);

		// At 10 days old with beta=1, mu=0:
		// static:  recency = exp(-ln2 * 10 / 30)
		// dynamic: recency = exp(-ln2 * 10 / 10)  (halfLife / 3 = 10)
		const age10 = makeMemory({
			createdAt: NOW - 10 * DAY_MS,
			lastAccessedAt: NOW - 10 * DAY_MS,
			importance: 0,
		});

		const staticScore = engine.score(
			{ ...age10, id: "s", temporalType: "static" },
			NOW,
		);
		const dynamicScore = engine.score(
			{ ...age10, id: "d", temporalType: "dynamic" },
			NOW,
		);

		// static: exp(-ln2 * 10/30) ≈ 0.794
		expect(staticScore.recency).toBeCloseTo(Math.exp((-Math.LN2 * 10) / 30), 5);
		// dynamic: exp(-ln2 * 10/10) = exp(-ln2) = 0.5
		expect(dynamicScore.recency).toBeCloseTo(
			Math.exp((-Math.LN2 * 10) / 10),
			5,
		);
	});

	it("temporalDecay OFF: dynamic decay matches static decay", () => {
		const engine = createRetentionScorer({
			...DEFAULT_DECAY_CONFIG,
			temporalDecay: false,
		});
		const staticMem = makeMemory({ id: "static-off", temporalType: "static" });
		const dynamicMem = makeMemory({
			id: "dynamic-off",
			temporalType: "dynamic",
		});

		const staticScore = engine.score(staticMem, NOW);
		const dynamicScore = engine.score(dynamicMem, NOW);

		expect(dynamicScore.recency).toBeCloseTo(staticScore.recency, 10);
		expect(dynamicScore.composite).toBeCloseTo(staticScore.composite, 10);
	});
});

// ============================================================================
// D7: Subagent runtime wrapper stripping
// ============================================================================

describe("stripEnvelopeMetadata — subagent wrappers", () => {
	it("strips [Subagent Context] prefix line", () => {
		const input =
			"[Subagent Context] You are running as a subagent of the main agent.\nActual content here.";
		const result = stripEnvelopeMetadata(input);
		expect(result).toBe("Actual content here.");
	});

	it("strips [Subagent Task] prefix line", () => {
		const input =
			"[Subagent Task] Complete the code review.\nReal discussion below.";
		const result = stripEnvelopeMetadata(input);
		expect(result).toBe("Complete the code review.\nReal discussion below.");
	});

	it("strips multiple runtime wrapper lines", () => {
		const input = [
			"[Subagent Context] You are running as a subagent.",
			"Results auto-announce to your requester.",
			"Do not use any memory tools.",
			"",
			"The actual conversation starts here.",
		].join("\n");
		const result = stripEnvelopeMetadata(input);
		expect(result).toBe("The actual conversation starts here.");
	});

	it("leaves normal text unchanged", () => {
		const input = "Just a regular message about TypeScript.";
		expect(stripEnvelopeMetadata(input)).toBe(input);
	});

	it("handles empty string", () => {
		expect(stripEnvelopeMetadata("")).toBe("");
	});

	it("strips wrapper but preserves real content after it", () => {
		const input = [
			"[Subagent Context] You are running as a subagent. Reply with a brief acknowledgment only.",
			"I need to implement the temporal classifier for the memory plugin.",
		].join("\n");
		const result = stripEnvelopeMetadata(input);
		expect(result).toContain("temporal classifier");
	});

	it("case-insensitive matching", () => {
		const input =
			"[SUBAGENT CONTEXT] You are running as a subagent.\nContent here.";
		const result = stripEnvelopeMetadata(input);
		expect(result).toBe("Content here.");
	});
});

describe("stripEnvelopeMetadata — envelope context blocks", () => {
	it("strips thread starter blocks when terminated by a blank line", () => {
		const input = [
			"Thread starter (untrusted, for context):",
			"Alice: please remember that I prefer Node.js for TS services.",
			"Bob: acknowledged.",
			"",
			"Real conversation starts here.",
		].join("\n");

		expect(stripEnvelopeMetadata(input)).toBe("Real conversation starts here.");
	});

	it("strips forwarded context blocks with multiple metadata lines", () => {
		const input = [
			"Forwarded message context (untrusted metadata):",
			"From: alerts@example.com",
			"Sent: 2026-04-20 08:00 UTC",
			"Subject: nightly sync",
			"",
			"The actual user request follows here.",
		].join("\n");

		expect(stripEnvelopeMetadata(input)).toBe(
			"The actual user request follows here.",
		);
	});

	it("drops the header of an unterminated thread starter block but preserves non-metadata content", () => {
		// Unterminated block fallback: the envelope header line is always noise for
		// the extraction LLM and is dropped; content lines that do not look like
		// metadata (isLikelyDelimitedMetadataLine) survive, so a user message can
		// never be swallowed by a missing blank-line terminator.
		const input = [
			"Thread starter (untrusted, for context):",
			"Alice: this block has no blank-line terminator",
		].join("\n");

		expect(stripEnvelopeMetadata(input)).toBe(
			"Alice: this block has no blank-line terminator",
		);
	});
});
