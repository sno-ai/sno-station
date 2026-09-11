/**
 * PRD §5 reflection v3 layered + mapped-memory + governance behavioral tests.
 *
 * Real LLM API required. Real ONNX embedder, real `better-sqlite3` temp DB.
 * No runtime mocks of LLM, DB, embedder, or HTTP — only the three sanctioned
 * fault-injection wrappers from `_helpers/reflection-fault-wrappers.ts` and
 * one canned-reflection stub at the embedded PI runner boundary (per §5
 * harness spec).
 *
 * Test isolation (PRD §5 Group 4): every test generates a unique
 * `sessionKey = test-{name}-{Date.now()}` so the global serial-guard Set/Map
 * cannot collide.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadAgentReflectionSlicesFromEntries } from "../../../../packages/sno-station-mem/src/engine/reflection/memory-entry-projector.ts";
import {
	runWithSerialGuard,
	SERIAL_WINDOW_MS,
} from "../../../../packages/sno-station-mem/src/engine/reflection/session-serial-guard.ts";
import type {
	AgentLlmPort,
	AgentLlmRequest,
} from "../../../../packages/sno-station-mem/src/model/agent-llm-port.ts";
import type { MemoryEntry } from "../../../../packages/sno-station-mem/src/engine/shared/types.ts";
import { getSnoStationMemDataDir } from "../../../../packages/sno-station-mem/src/store/data-paths.ts";
import {
	createReflectionHarness,
	installEmbeddedRunnerStub,
	type ReflectionHarness,
} from "../../../apps/mem-claw/integration/_helpers/reflection-command-new-harness.ts";
import {
	wrapEmbedderWithCallCounter,
	wrapEmbedderWithSentinelDelay,
	wrapEmbedderWithSentinelThrow,
	wrapStoreWithSentinelThrow,
} from "../../../apps/mem-claw/integration/_helpers/reflection-fault-wrappers.ts";

function requireValue<T>(value: T | undefined, message: string): T {
	if (value === undefined) {
		throw new Error(message);
	}
	return value;
}

beforeAll(() => {
	// Ensure the embedded PI runner stub is wired in BEFORE any code path
	// calls `loadEmbeddedPiRunner` (the runner promise is module-cached).
	installEmbeddedRunnerStub();
});

const harnesses: ReflectionHarness[] = [];
afterEach(() => {
	while (harnesses.length > 0) {
		const h = harnesses.pop();
		try {
			h?.cleanup();
		} catch {
			// best-effort
		}
	}
});

function newHarness(
	options?: Parameters<typeof createReflectionHarness>[0],
): Promise<ReflectionHarness> {
	return createReflectionHarness(options).then((h) => {
		harnesses.push(h);
		return h;
	});
}

/**
 * Generate a unique session key for the test. PRD §5 Group 4 mandates that
 * each test uses a fresh sessionKey so the global serial-guard Set/Map
 * cannot collide.
 *
 * The sessionKey ALSO encodes the agentId per `parseAgentIdFromSessionKey`
 * (`agent:<id>:...` or `session:<id>:...` format) so the production wiring
 * routes the reflection to the correct agent. Without this prefix every
 * reflection lands as `agent:main` regardless of the event.context.agentId.
 */
function tk(name: string, agentId = "main"): string {
	const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	return `agent:${agentId}:${name}-${suffix}`;
}

function readMetadata(metadataJson: string): Record<string, unknown> {
	try {
		return JSON.parse(metadataJson) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function rowsAsEntries(
	rows: Array<{
		id: string;
		text: string;
		category: string;
		project_id: string;
		metadata: string;
		timestamp: number;
	}>,
): MemoryEntry[] {
	return rows.map((r) => ({
		id: r.id,
		text: r.text,
		projectId: r.project_id,
		category: r.category as MemoryEntry["category"],
		metadata: r.metadata,
		timestamp: r.timestamp,
		importance: 0.7,
		contentHash: "",
	}));
}

// ===========================================================================
// Group 2 smoke — Test 5
// ===========================================================================

describe("reflection v3 — Group 2 (layered roundtrip)", () => {
	it("Test 5: single reflection writes 1 event + N invariant + N derived rows", async () => {
		const h = await newHarness();
		const sessionKey = tk("g2-t5");

		await h.fireCommandNew({ sessionKey, agentId: "main" });

		const eventCount = await h.pollForReflectionRow(8000);
		if (eventCount === 0) {
			// Surface why for debugging — see PRD §5 advisor note.
			// eslint-disable-next-line no-console
			console.error("warn log dump:", h.harness.logMessages.warn);
			// eslint-disable-next-line no-console
			console.error("info log dump:", h.harness.logMessages.info.slice(-20));
		}
		expect(eventCount).toBe(1);

		const rows = h.listReflectionRows();
		const events = rows.filter(
			(r) => readMetadata(r.metadata).type === "memory-reflection-event",
		);
		const invariants = rows.filter(
			(r) =>
				readMetadata(r.metadata).type === "memory-reflection-item" &&
				readMetadata(r.metadata).itemKind === "invariant",
		);
		const derived = rows.filter(
			(r) =>
				readMetadata(r.metadata).type === "memory-reflection-item" &&
				readMetadata(r.metadata).itemKind === "derived",
		);
		const legacyCombined = rows.filter(
			(r) => readMetadata(r.metadata).type === "memory-reflection",
		);

		expect(events.length).toBe(1);
		expect(invariants.length).toBeGreaterThanOrEqual(1);
		expect(derived.length).toBeGreaterThanOrEqual(1);
		expect(legacyCombined.length).toBe(0);
	});

	it("Test 6: cross-session dedup — exact duplicate yields one item-invariant row", async () => {
		const h = await newHarness();
		const md = `## Context
- Session A.

## Invariants
- Always validate user input before parsing.

## Derived
- Run-A specific delta one.
`;
		h.setReflectionMarkdown(md);

		await h.fireCommandNew({ sessionKey: tk("g2-t6-a"), agentId: "main" });
		await h.pollForReflectionRow(8000);

		// Second run, same invariant text verbatim, distinct derived so the
		// event row is not deduped.
		const md2 = `## Context
- Session B.

## Invariants
- Always validate user input before parsing.

## Derived
- Run-B different delta two.
`;
		h.setReflectionMarkdown(md2);
		await h.fireCommandNew({ sessionKey: tk("g2-t6-b"), agentId: "main" });
		// poll for at least 2 events
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline) {
			const events = h
				.listReflectionRows()
				.filter(
					(r) => readMetadata(r.metadata).type === "memory-reflection-event",
				);
			if (events.length >= 2) break;
			await new Promise((r) => setTimeout(r, 50));
		}

		const rows = h.listReflectionRows();
		const invariantText = "Always validate user input before parsing.";
		const matchingInvariants = rows.filter((r) => {
			const md = readMetadata(r.metadata);
			return (
				md.type === "memory-reflection-item" &&
				md.itemKind === "invariant" &&
				r.text === invariantText
			);
		});
		expect(matchingInvariants.length).toBe(1);
	});

	it("Test 6b: paraphrase boundary — at 0.97 threshold, paraphrase IS stored", async () => {
		const h = await newHarness();
		const md = `## Context
- Session A.

## Invariants
- Always validate user input.

## Derived
- Run-A delta.
`;
		h.setReflectionMarkdown(md);
		await h.fireCommandNew({ sessionKey: tk("g2-t6b-a"), agentId: "main" });
		await h.pollForReflectionRow(8000);

		const md2 = `## Context
- Session B.

## Invariants
- Always validate inputs from users before processing them downstream.

## Derived
- Run-B delta.
`;
		h.setReflectionMarkdown(md2);
		await h.fireCommandNew({ sessionKey: tk("g2-t6b-b"), agentId: "main" });
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline) {
			const events = h
				.listReflectionRows()
				.filter(
					(r) => readMetadata(r.metadata).type === "memory-reflection-event",
				);
			if (events.length >= 2) break;
			await new Promise((r) => setTimeout(r, 50));
		}

		const rows = h.listReflectionRows();
		const invariants = rows.filter((r) => {
			const md = readMetadata(r.metadata);
			return (
				md.type === "memory-reflection-item" && md.itemKind === "invariant"
			);
		});
		// At dedupeThreshold=0.97, the paraphrase should NOT collapse to one
		// row — both originals are kept.
		const a = invariants.find((r) => r.text === "Always validate user input.");
		const b = invariants.find(
			(r) =>
				r.text ===
				"Always validate inputs from users before processing them downstream.",
		);
		expect(a).toBeDefined();
		expect(b).toBeDefined();
	});
});

// ===========================================================================
// Group 1 — Cross-agent isolation at the helper boundary
// ===========================================================================

describe("reflection v3 — Group 1 (cross-agent isolation)", () => {
	it("Test 1: main's derived → sub-agent invisible", async () => {
		const h = await newHarness();
		const md = `## Context
- Main session.

## Invariants
- Always log errors with stack traces.

## Derived
- This run showed main-only derived insight alpha and adjusted next run.
`;
		h.setReflectionMarkdown(md);
		await h.fireCommandNew({ sessionKey: tk("g1-t1-main"), agentId: "main" });
		await h.pollForReflectionRow(8000);

		const md2 = `## Context
- Sub-agent session.

## Invariants
- Always validate sub-agent inputs.

## Derived
- This run showed sub-agent derived delta gamma.
`;
		h.setReflectionMarkdown(md2);
		await h.fireCommandNew({
			sessionKey: tk("g1-t1-sub", "sub-agent-A"),
			agentId: "sub-agent-A",
		});
		await new Promise((r) => setTimeout(r, 200));

		const entries = rowsAsEntries(h.listReflectionRows());
		const subSlices = loadAgentReflectionSlicesFromEntries({
			entries,
			agentId: "sub-agent-A",
		});
		expect(
			subSlices.derived.some((d) =>
				d.includes("main-only derived insight alpha"),
			),
		).toBe(false);
	});

	it("Test 2: main's invariant → sub-agent visible (parity preserved)", async () => {
		const h = await newHarness();
		const md = `## Context
- Main session.

## Invariants
- Always honor the main fleet-shared invariant zulu rule.

## Derived
- This run showed main derived only.
`;
		h.setReflectionMarkdown(md);
		await h.fireCommandNew({ sessionKey: tk("g1-t2-main"), agentId: "main" });
		await h.pollForReflectionRow(8000);

		const entries = rowsAsEntries(h.listReflectionRows());
		const subSlices = loadAgentReflectionSlicesFromEntries({
			entries,
			agentId: "sub-agent-A",
		});
		expect(subSlices.invariants.some((s) => s.includes("zulu rule"))).toBe(
			true,
		);
	});

	it("Test 3: agent-x → agent-y invisible", async () => {
		const h = await newHarness();
		const md = `## Context
- agent-x session.

## Invariants
- Always apply agent-x specific invariant kilo when handling requests.

## Derived
- This run showed agent-x derived lima delta.
`;
		h.setReflectionMarkdown(md);
		await h.fireCommandNew({
			sessionKey: tk("g1-t3-x", "agent-x"),
			agentId: "agent-x",
		});
		await h.pollForReflectionRow(8000);

		const entries = rowsAsEntries(h.listReflectionRows());
		const ySlices = loadAgentReflectionSlicesFromEntries({
			entries,
			agentId: "agent-y",
		});
		if (ySlices.invariants.some((s) => s.includes("kilo"))) {
			// eslint-disable-next-line no-console
			console.error(
				"entries dump:",
				entries.map((e) => ({ text: e.text, metadata: e.metadata })),
			);
			// eslint-disable-next-line no-console
			console.error("ySlices:", ySlices);
		}
		expect(ySlices.derived.length).toBe(0);
		expect(ySlices.invariants.some((s) => s.includes("kilo"))).toBe(false);
	});

	it("Test 4: malformed itemKind row → fail-closed", async () => {
		const h = await newHarness();
		// Insert a malformed row directly via SQLite — bypass the store API so
		// metadata is whatever we want.
		const malformedMetadata = JSON.stringify({
			type: "memory-reflection-item",
			itemKind: null,
			agentId: "main",
		});
		const malformedId = `malformed-${Date.now()}`;
		h.sqlite
			.prepare(
				"INSERT INTO nodix_memories (id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash, fact_id) VALUES (?, ?, 'lesson', ?, 0.7, ?, 'UTC', ?, ?, ?)",
			)
			.run(
				malformedId,
				"malformed payload that should never surface",
				h.defaultScope,
				Date.now(),
				malformedMetadata,
				`hash-${malformedId}`,
				malformedId,
			);

		const entries = rowsAsEntries(h.listReflectionRows());
		const mainSlices = loadAgentReflectionSlicesFromEntries({
			entries,
			agentId: "main",
		});
		const subSlices = loadAgentReflectionSlicesFromEntries({
			entries,
			agentId: "sub-agent-A",
		});
		expect(
			[...mainSlices.invariants, ...mainSlices.derived].some((s) =>
				s.includes("malformed payload"),
			),
		).toBe(false);
		expect(
			[...subSlices.invariants, ...subSlices.derived].some((s) =>
				s.includes("malformed payload"),
			),
		).toBe(false);
	});
});

// ===========================================================================
// Group 3 — Mapped-memory routing
// ===========================================================================

describe("reflection v3 — Group 3 (mapped-memory routing)", () => {
	it("routes mapped profile merges through the host seam", async () => {
		const requests: AgentLlmRequest[] = [];
		let reflectionText = `## Context
- first

## User model deltas (about the human)
- Prefers light mode.

## Invariants
- Keep preferences current.

## Derived
- First reflection.
`;
		const agentPort: AgentLlmPort = {
			async complete(request) {
				requests.push(request);
				// The profile lane is two model calls, not one: a judge settles the verdict, and only a
				// merge verdict reaches the section writer. This stub used to answer the judge with
				// the reflection markdown, which is not a verdict, so the lane stopped there and the
				// writer was never called — and the assertion below named a sentence that appears
				// nowhere in the product, so the case read as a string mismatch instead of a stub
				// that could not complete the flow. Measured 2026-08-28: four model calls, two
				// reflections and two judges, no writer.
				if (request.prompt.includes("Judge one retirement inside a current-state profile section")) {
					return { kind: "ok", text: JSON.stringify({ retire: true }) };
				}
				if (request.prompt.includes("Judge one current-state profile update")) {
					return {
						kind: "ok",
						text: JSON.stringify({
							verdict: "merge",
							retired_clause_indices: [0],
						}),
					};
				}
				if (request.prompt.includes("Write one current-state profile section")) {
					return {
						kind: "ok",
						text: JSON.stringify({
							action: "merge",
							content: "Prefers dark mode.",
							superseded: ["Prefers light mode."],
						}),
					};
				}
				return { kind: "ok", text: reflectionText };
			},
		};
		const h = await newHarness({
			agentPort,
			pluginConfigOverrides: {
				mode: "agent-native",
				agentNative: { flavor: "subscription" },
				llmGates: { agentWriteCapture: true },
			},
		});

		await h.fireCommandNew({ sessionKey: tk("g3-host-first"), agentId: "main" });
		reflectionText = `## Context
- second

## User model deltas (about the human)
- Prefers dark mode.

## Invariants
- Keep preferences current.

## Derived
- Second reflection.
`;
		await h.fireCommandNew({ sessionKey: tk("g3-host-second"), agentId: "main" });

		// The real opening of the profile-section writer's prompt, from
		// `packages/sno-station-mem/src/engine/extraction/profile-section-writer.ts`. The sentence asserted here
		// before was "You update one current-state profile section.", which the product has never
		// emitted, so this case had not passed since it was written on 2026-07-18.
		expect(
			requests.some((request) =>
				request.prompt.includes("Write one current-state profile section"),
			),
		).toBe(true);
	});

	it("Test 7: User model section → profile rows with mappedKind=user-model", async () => {
		const h = await newHarness();
		const md = `## Context
- t7

## User model deltas (about the human)
- Prefers concise responses with no preamble.
- Works in PST timezone.
- Reads code top-down.

## Invariants
- t7 invariant.

## Derived
- t7 derived.
`;
		h.setReflectionMarkdown(md);
		await h.fireCommandNew({ sessionKey: tk("g3-t7"), agentId: "main" });
		await h.pollForReflectionRow(8000);

		const allRows = h.sqlite
			.prepare("SELECT id, text, category, metadata FROM nodix_memories")
			.all() as Array<{
			id: string;
			text: string;
			category: string;
			metadata: string;
		}>;
		const userModelRows = allRows.filter(
			(r) =>
				r.category === "profile" &&
				readMetadata(r.metadata).mappedKind === "user-model",
		);
		expect(userModelRows.length).toBe(3);
		for (const r of userModelRows) {
			const md = readMetadata(r.metadata);
			expect(md._reflectionHeading).toBe("User model deltas (about the human)");
			expect(md.section_name).toBe("preferences.general");
		}
	});

	it("Test 7b: identical text across distinct mappedKinds stays distinct (decision vs lesson)", async () => {
		const h = await newHarness();
		const md = `## Context
- t7b

## Decisions (durable)
- Always validate input

## Lessons & pitfalls (symptom / cause / fix / prevention)
- Always validate input

## Invariants
- t7b invariant.

## Derived
- t7b derived.
`;
		h.setReflectionMarkdown(md);
		await h.fireCommandNew({ sessionKey: tk("g3-t7b"), agentId: "main" });
		await h.pollForReflectionRow(8000);

		const allRows = h.sqlite
			.prepare(
				"SELECT id, text, category, importance, metadata FROM nodix_memories WHERE text = ?",
			)
			.all("Always validate input") as Array<{
			id: string;
			text: string;
			category: string;
			importance: number;
			metadata: string;
		}>;
		expect(allRows.length).toBe(2);
		const decision = allRows.find(
			(r) =>
				r.category === "episodic" &&
				readMetadata(r.metadata).mappedKind === "decision",
		);
		const lesson = allRows.find(
			(r) =>
				r.category === "lesson" &&
				readMetadata(r.metadata).mappedKind === "lesson",
		);
		expect(decision).toBeDefined();
		expect(lesson).toBeDefined();
		expect(decision?.importance).toBeCloseTo(0.85, 2);
		expect(lesson?.importance).toBeCloseTo(0.8, 2);
	});

	it("Test 7c: identical text across lesson mappedKinds that share a category", async () => {
		const h = await newHarness();
		const md = `## Context
- t7c

## Agent model deltas (about the assistant/system)
- Prefers terse responses

## Lessons & pitfalls (symptom / cause / fix / prevention)
- Prefers terse responses

## Invariants
- t7c invariant.

## Derived
- t7c derived.
`;
		h.setReflectionMarkdown(md);
		await h.fireCommandNew({ sessionKey: tk("g3-t7c"), agentId: "main" });
		await h.pollForReflectionRow(8000);

		const allRows = h.sqlite
			.prepare(
				"SELECT id, text, category, importance, metadata FROM nodix_memories WHERE text = ?",
			)
			.all("Prefers terse responses") as Array<{
			id: string;
			text: string;
			category: string;
			importance: number;
			metadata: string;
		}>;
		expect(allRows.length).toBe(2);
		expect(allRows.every((r) => r.category === "lesson")).toBe(true);
		const agentModel = allRows.find(
			(r) => readMetadata(r.metadata).mappedKind === "agent-model",
		);
		const lesson = allRows.find(
			(r) => readMetadata(r.metadata).mappedKind === "lesson",
		);
		expect(agentModel).toBeDefined();
		expect(lesson).toBeDefined();
		expect(agentModel?.importance).toBeCloseTo(0.8, 2);
		expect(lesson?.importance).toBeCloseTo(0.8, 2);
	});

	it("Test 8: decision mappedKind gets higher importance than lesson", async () => {
		const h = await newHarness();
		const md = `## Context
- t8

## Decisions (durable)
- Adopt content-hash dedup for reflections.

## Lessons & pitfalls (symptom / cause / fix / prevention)
- Symptom: stale cache. Cause: missing invalidation. Fix: clear() on main writes.

## Invariants
- t8 invariant.

## Derived
- t8 derived.
`;
		h.setReflectionMarkdown(md);
		await h.fireCommandNew({ sessionKey: tk("g3-t8"), agentId: "main" });
		await h.pollForReflectionRow(8000);

		const decisionRow = h.sqlite
			.prepare(
				"SELECT category, importance, metadata, json_extract(metadata, '$.mappedKind') AS mappedKind FROM nodix_memories WHERE category = 'episodic' AND json_extract(metadata, '$.mappedKind') = 'decision' ORDER BY timestamp DESC LIMIT 1",
			)
			.get() as
			| { category: string; importance: number; metadata: string; mappedKind: string }
			| undefined;
		const lessonRow = h.sqlite
			.prepare(
				"SELECT category, importance, metadata, json_extract(metadata, '$.mappedKind') AS mappedKind FROM nodix_memories WHERE category = 'lesson' AND json_extract(metadata, '$.mappedKind') = 'lesson' ORDER BY timestamp DESC LIMIT 1",
			)
			.get() as
			| { category: string; importance: number; metadata: string; mappedKind: string }
			| undefined;
		expect(decisionRow).toBeDefined();
		expect(decisionRow?.category).toBe("episodic");
		const decision = requireValue(decisionRow, "expected mapped decision row");
		expect(decision.mappedKind).toBe("decision");
		expect(decision.importance).toBeGreaterThanOrEqual(0.85);
		expect(lessonRow).toBeDefined();
		const lesson = requireValue(lessonRow, "expected mapped lesson row");
		expect(lesson.category).toBe("lesson");
		expect(lesson.mappedKind).toBe("lesson");
		expect(lesson.importance).toBeCloseTo(0.8, 2);
	});

	it("Test 8b: governance candidates → .learnings/*.md files with shared eventId source", async () => {
		const h = await newHarness();
		const md = `## Context
- t8b

## Learning governance candidates (.learnings / promotion / skill extraction)
### Entry
- type: LRN
- summary: Always run typecheck after editing TypeScript files
- details: This avoids regressions caught only at compile time.
- area: typescript
- priority: high
- status: open

## Invariants
- t8b invariant.

## Derived
- t8b derived.
`;
		h.setReflectionMarkdown(md);
		await h.fireCommandNew({ sessionKey: tk("g3-t8b"), agentId: "main" });
		await h.pollForReflectionRow(8000);

		// Wait briefly for the governance append (FS write is sequential after
		// the layered store completes, but we already polled past the event row)
		const learningsPath = join(
			process.env.MEM_CLAW_DATA_DIR_ROOT ? getSnoStationMemDataDir() : join(h.stateDir, "mem-claw"),
			".learnings",
			"LEARNINGS.md",
		);
		const deadline = Date.now() + 4000;
		while (Date.now() < deadline) {
			if (existsSync(learningsPath)) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(existsSync(learningsPath)).toBe(true);
		const content = readFileSync(learningsPath, "utf-8");
		expect(content).toContain(
			"Always run typecheck after editing TypeScript files",
		);

		// Find the eventId from the layered event row, assert it appears as the
		// source of the governance entry.
			const eventRow = h.sqlite
				.prepare(
					"SELECT metadata FROM nodix_memories WHERE category = 'episodic' AND json_extract(metadata, '$.type') = 'memory-reflection-event' ORDER BY timestamp DESC LIMIT 1",
				)
				.get() as { metadata: string } | undefined;
		expect(eventRow).toBeDefined();
		const eventId = readMetadata(
			requireValue(eventRow, "expected reflection event row").metadata,
		).eventId as string;
		expect(eventId).toBeTruthy();
		expect(content).toContain(`mem-claw/reflection/${eventId}`);
	});

	it("Test 9: mapped item with embed failure is fail-closed and isolated", async () => {
		const h = await newHarness();
		const sentinel = "<<embed-fail>>";
		const md = `## Context
- t9

## Agent model deltas (about the assistant/system)
- ${sentinel}
- Reads top-down.
- Prefers Chinese summaries.
- Works late at night.

## Invariants
- t9 invariant.

## Derived
- t9 derived.
`;
		h.setReflectionMarkdown(md);
		const handle = wrapEmbedderWithSentinelThrow(h.embedder, sentinel);
		try {
			await h.fireCommandNew({ sessionKey: tk("g3-t9"), agentId: "main" });
			await h.pollForReflectionRow(8000);
		} finally {
			handle.restore();
		}

			const allRows = h.sqlite
				.prepare(
					"SELECT text FROM nodix_memories WHERE category = 'lesson' AND json_extract(metadata, '$.mappedKind') = 'agent-model'",
				)
				.all() as Array<{ text: string }>;
		expect(allRows.some((r) => r.text === sentinel)).toBe(false);
		expect(allRows.length).toBe(3);
	});

	it("Test 9b: mapped item with searchSemantic failure is fail-closed and isolated", async () => {
		const h = await newHarness();
		const sentinelText = "search-fail-sentinel-zeta";
		const md = `## Context
- t9b

## Agent model deltas (about the assistant/system)
- ${sentinelText}
- Sibling preference uno.
- Sibling preference dos.
- Sibling preference tres.

## Invariants
- t9b invariant.

## Derived
- t9b derived.
`;
		h.setReflectionMarkdown(md);

		// Compute the sentinel vector once so we can match it inside the wrapper.
		const sentinelVector = await h.embedder.embed(sentinelText);
		const matchFn = (vec: Float32Array) => {
			if (vec.length !== sentinelVector.length) return false;
			for (let i = 0; i < vec.length; i++) {
				const current = vec[i];
				const sentinel = sentinelVector[i];
				if (
					current === undefined ||
					sentinel === undefined ||
					Math.abs(current - sentinel) > 1e-6
				) {
					return false;
				}
			}
			return true;
		};
		const handle = wrapStoreWithSentinelThrow(h.store, matchFn);
		try {
			await h.fireCommandNew({ sessionKey: tk("g3-t9b"), agentId: "main" });
			await h.pollForReflectionRow(8000);
		} finally {
			handle.restore();
		}

			const allRows = h.sqlite
				.prepare(
					"SELECT text FROM nodix_memories WHERE category = 'lesson' AND json_extract(metadata, '$.mappedKind') = 'agent-model'",
				)
				.all() as Array<{ text: string }>;
		expect(allRows.some((r) => r.text === sentinelText)).toBe(false);
		expect(allRows.length).toBe(3);
	});

	it("Test 10a: dedup branch — 150 identical bullets → 1 embed call, 1 row", async () => {
		const h = await newHarness();
		const bullets = Array.from(
			{ length: 150 },
			() => "- The user prefers concise replies",
		).join("\n");
		const md = `## Context
- t10a

## Agent model deltas (about the assistant/system)
${bullets}

## Invariants
- t10a invariant.

## Derived
- t10a derived.
`;
		h.setReflectionMarkdown(md);
		// Predicate scopes the count to ONLY the mapped-loop embeds (PRD §5
		// Group 3 Test 10a). Layered-store embeds + internal chunk embeds for
		// the event/invariant/derived rows are NOT under test here.
		const counter = wrapEmbedderWithCallCounter(
			h.embedder,
			(t) => t === "The user prefers concise replies",
		);
		try {
			counter.reset();
			await h.fireCommandNew({ sessionKey: tk("g3-t10a"), agentId: "main" });
			await h.pollForReflectionRow(8000);
		} finally {
			counter.restore();
		}

		expect(counter.count.embed).toBe(1);
			const rows = h.sqlite
				.prepare(
					"SELECT id FROM nodix_memories WHERE text = ? AND category = 'lesson' AND json_extract(metadata, '$.mappedKind') = 'agent-model'",
				)
				.all("The user prefers concise replies") as Array<{ id: string }>;
		expect(rows.length).toBe(1);
		const dedupLog = h.harness.logMessages.info.find((m) =>
			m.includes("mapped input dedup'd from 150 to 1"),
		);
		expect(dedupLog).toBeDefined();
		const truncationWarn = h.harness.logMessages.warn.find((m) =>
			m.includes("mapped items truncated"),
		);
		expect(truncationWarn).toBeUndefined();
	});

	it("Test 10b: cap branch — 150 distinct bullets → 100 embed calls, ≤100 rows", async () => {
		const h = await newHarness();
		const bullets = Array.from(
			{ length: 150 },
			(_, i) =>
				`- The user prefers style number ${i} of many distinct preferences`,
		).join("\n");
		const md = `## Context
- t10b

## Agent model deltas (about the assistant/system)
${bullets}

## Invariants
- t10b invariant.

## Derived
- t10b derived.
`;
		h.setReflectionMarkdown(md);
		// Predicate scopes count to the mapped-loop bullets only — see Test 10a.
		const counter = wrapEmbedderWithCallCounter(h.embedder, (t) =>
			t.startsWith("The user prefers style number "),
		);
		try {
			counter.reset();
			await h.fireCommandNew({ sessionKey: tk("g3-t10b"), agentId: "main" });
			await h.pollForReflectionRow(15_000);
		} finally {
			counter.restore();
		}

		expect(counter.count.embed).toBe(100);
			const rowCount = h.sqlite
				.prepare(
					"SELECT COUNT(*) AS n FROM nodix_memories WHERE category = 'lesson' AND json_extract(metadata, '$.mappedKind') = 'agent-model'",
				)
				.get() as { n: number };
		expect(rowCount.n).toBeLessThanOrEqual(100);
		expect(rowCount.n).toBeGreaterThanOrEqual(50);
		const truncWarn = h.harness.logMessages.warn.find((m) =>
			m.includes("mapped items truncated from 150 to 100"),
		);
		expect(truncWarn).toBeDefined();
		const dedupInfo = h.harness.logMessages.info.find((m) =>
			m.includes("mapped input dedup'd"),
		);
		expect(dedupInfo).toBeUndefined();
	}, 30_000);

	it("Test 10c: dedup → cap order — 100 identical + 50 distinct → 51 embed calls", async () => {
		const h = await newHarness();
		const identical = Array.from(
			{ length: 100 },
			() => "- The user prefers concise summaries always",
		).join("\n");
		const distinct = Array.from(
			{ length: 50 },
			(_, i) =>
				`- Distinct preference number ${i} with unique trailing tokens alpha bravo`,
		).join("\n");
		const md = `## Context
- t10c

## Agent model deltas (about the assistant/system)
${identical}
${distinct}

## Invariants
- t10c invariant.

## Derived
- t10c derived.
`;
		h.setReflectionMarkdown(md);
		// Predicate covers BOTH the identical-bullet shape and the distinct-bullet
		// shape — the mapped-loop is what we're counting.
		const counter = wrapEmbedderWithCallCounter(
			h.embedder,
			(t) =>
				t === "The user prefers concise summaries always" ||
				t.startsWith("Distinct preference number "),
		);
		try {
			counter.reset();
			await h.fireCommandNew({ sessionKey: tk("g3-t10c"), agentId: "main" });
			await h.pollForReflectionRow(15_000);
		} finally {
			counter.restore();
		}

		// Primary assertion: dedup → 51 unique → 51 ≤ 100 cap → 51 embed calls.
		// Wrong order (cap → dedup) would yield 1 embed call (50× difference).
		expect(counter.count.embed).toBe(51);
			const rowCount = h.sqlite
				.prepare(
					"SELECT COUNT(*) AS n FROM nodix_memories WHERE category = 'lesson' AND json_extract(metadata, '$.mappedKind') = 'agent-model'",
				)
				.get() as { n: number };
		expect(rowCount.n).toBeGreaterThanOrEqual(30);
	}, 30_000);
});

// ===========================================================================
// Group 4 — Serial guard
// ===========================================================================

describe("reflection v3 — Group 4 (serial guard)", () => {
	it("Test 11: debounce window blocks rapid re-entry", async () => {
		const h = await newHarness();
		const sessionKey = tk("g4-t11");
		await h.fireCommandNew({ sessionKey, agentId: "main" });
		await h.pollForReflectionRow(8000);
		const eventsAfterFirst = h
			.listReflectionRows()
			.filter(
				(r) => readMetadata(r.metadata).type === "memory-reflection-event",
			).length;

		// Immediately re-fire — within debounce window.
		await h.fireCommandNew({ sessionKey, agentId: "main" });
		await new Promise((r) => setTimeout(r, 500));

		const eventsAfterSecond = h
			.listReflectionRows()
			.filter(
				(r) => readMetadata(r.metadata).type === "memory-reflection-event",
			).length;
		expect(eventsAfterSecond).toBe(eventsAfterFirst);
		const debounceLog = h.harness.logMessages.info.find(
			(m) => m.includes("debounce window") && m.includes(sessionKey),
		);
		expect(debounceLog).toBeDefined();
	});

	it("Test 11b: in-flight lock blocks parallel re-entry past debounce window", async () => {
		const h = await newHarness();
		const sentinel = "trip-the-slow-embed-sentinel-omega";
		const md = `## Context
- t11b

## User model deltas (about the human)
- ${sentinel}

## Invariants
- t11b invariant.

## Derived
- t11b derived.
`;
		h.setReflectionMarkdown(md);
		const slowDelay = 500;
		const handle = wrapEmbedderWithSentinelDelay(
			h.embedder,
			sentinel,
			slowDelay,
		);
		try {
			const sessionKey = tk("g4-t11b");
			// First call — kick it off, do NOT await yet.
			const firstPromise = h.fireCommandNew({ sessionKey, agentId: "main" });

			// Let the first run reach the async embedder and hold the in-flight lock.
			await new Promise((r) => setTimeout(r, 50));

			// Second call — should hit the in-flight skip log, not debounce.
			await h.fireCommandNew({ sessionKey, agentId: "main" });

			await firstPromise;
			handle.restore();
		} catch (err) {
			handle.restore();
			throw err;
		}

		const inflightLog = h.harness.logMessages.info.find((m) =>
			m.includes("already in-flight"),
		);
		expect(inflightLog).toBeDefined();
	});

	it("Test 12: early-throw still sets debounce stamp and releases in-flight lock", async () => {
		const h = await newHarness();
		// Force a generator failure → reflectionResult.usedFallback=true → no
		// layered store write (the §4.3 spec says the debounce stamp + lock
		// release happen regardless of error).
		h.setReflectionFailure("forced LLM quota exhausted");
		try {
			const sessionKey = tk("g4-t12");
			await h.fireCommandNew({ sessionKey, agentId: "main" });

			// Re-fire immediately — debounce path should skip, NOT inflight (lock
			// was released in finally).
			await h.fireCommandNew({ sessionKey, agentId: "main" });

			const debounceSkip = h.harness.logMessages.info.find(
				(m) => m.includes("debounce window") && m.includes(sessionKey),
			);
			const inflightSkip = h.harness.logMessages.info.find(
				(m) => m.includes("already in-flight") && m.includes(sessionKey),
			);
			expect(debounceSkip).toBeDefined();
			expect(inflightSkip).toBeUndefined();
		} finally {
			// Stub control file is process-wide; clear so Group 5 tests can run
			// reflections normally. Without this, fail.txt persists and every
			// subsequent reflection takes the fallback path.
			h.setReflectionFailure(null);
		}
	});

	it("Test 12b: helper releases lock and stamps debounce on synchronous throw", async () => {
		const K = `unit-12b-${Date.now()}`;
		let aRan = false;
		let bRan = false;
		let cRan = false;

		const start = Date.now();
		vi.useFakeTimers();
		vi.setSystemTime(start);
		try {
			// (a) Throwing work — must reject and stamp debounce.
			await expect(
				runWithSerialGuard(K, async () => {
					aRan = true;
					throw new Error("synthetic throw");
				}),
			).rejects.toThrow("synthetic throw");
			expect(aRan).toBe(true);

			// (b) Immediately re-enter — debounce should suppress.
			const ranB = await runWithSerialGuard(K, async () => {
				bRan = true;
			});
			expect(ranB).toBe(false);
			expect(bRan).toBe(false);

			// (c) After SERIAL_WINDOW_MS+ — debounce no longer applies. If the
			// in-flight lock had leaked, this would also be skipped.
			vi.setSystemTime(start + SERIAL_WINDOW_MS + 200);
			const ranC = await runWithSerialGuard(K, async () => {
				cRan = true;
			});
			expect(ranC).toBe(true);
			expect(cRan).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

// ===========================================================================
// Group 5 — Recall injection
// ===========================================================================

describe("reflection v3 — Group 5 (recall injection)", () => {
	it("Test 13: invariants appear in agent prompt when flag is on", async () => {
		const h = await newHarness({
			pluginConfigOverrides: {
				memoryReflection: {
					injectMode: "none",
					storeToDb: true,
					injectIntoPrompt: true,
				},
			},
		});
		const distinctive = "marker-test-13-juliet";
		const md = `## Context
- t13

## Invariants
- ${distinctive} should appear in the prompt.

## Derived
- t13 derived.
`;
		h.setReflectionMarkdown(md);
		await h.fireCommandNew({
			sessionKey: tk("g5-t13", "agent-x"),
			agentId: "agent-x",
		});
		await h.pollForReflectionRow(8000);

		const result = await h.firePromptBuild({
			sessionKey: tk("g5-t13-recall", "agent-x"),
			agentId: "agent-x",
		});
		expect(result?.prependContext).toBeDefined();
		const prependContext = requireValue(
			result?.prependContext,
			"expected reflection prepend context",
		);
		expect(prependContext).toContain("<reflection-invariants>");
		expect(prependContext).toContain(distinctive);
	});

	it("Test 13b: empty slice → zero tag emission with flag on", async () => {
		const h = await newHarness({
			pluginConfigOverrides: {
				memoryReflection: {
					injectMode: "none",
					storeToDb: true,
					injectIntoPrompt: true,
				},
			},
		});
		// No reflection has run — slice loader returns empty.
		const result = await h.firePromptBuild({
			sessionKey: tk("g5-t13b", "agent-x"),
			agentId: "agent-x",
		});
		const text = result?.prependContext ?? "";
		expect(text).not.toContain("<reflection-invariants>");
		expect(text).not.toContain("<reflection-derived>");
	});

	it("Test 13c: flag-off → zero tag emission regardless of slice content", async () => {
		const h = await newHarness({
			pluginConfigOverrides: {
				memoryReflection: {
					injectMode: "none",
					storeToDb: true,
					injectIntoPrompt: false,
				},
			},
		});
		const md = `## Context
- t13c

## Invariants
- marker-13c-flag-off should NOT appear because the flag is off.

## Derived
- t13c derived.
`;
		h.setReflectionMarkdown(md);
		await h.fireCommandNew({
			sessionKey: tk("g5-t13c", "agent-x"),
			agentId: "agent-x",
		});
		await h.pollForReflectionRow(8000);

		// Flag is off — no priority-14 handler is registered.
		const reg = h.harness.registeredOnHooks.find(
			(x) => x.hookName === "before_prompt_build" && x.opts?.priority === 14,
		);
		expect(reg).toBeUndefined();

		// Even if some other path renders a prompt, the v3 reflection handler
		// must not be present.
		const result = await h.firePromptBuild({
			sessionKey: tk("g5-t13c-recall", "agent-x"),
			agentId: "agent-x",
		});
		expect(result).toBeUndefined();
	});

	it("Test 13d: main reflection invalidates sub-agent cache (PRESENCE within ms)", async () => {
		const h = await newHarness({
			pluginConfigOverrides: {
				memoryReflection: {
					injectMode: "none",
					storeToDb: true,
					injectIntoPrompt: true,
				},
			},
		});

		// (1) Cold-start recall as sub-agent-A — empty slices populate the
		// cache entry `sub-agent-A::*` with `{invariants: [], derived: []}`.
		const recall1 = await h.firePromptBuild({
			sessionKey: tk("g5-t13d-recall-1", "sub-agent-A"),
			agentId: "sub-agent-A",
		});
		expect(recall1).toBeUndefined();

		// (2) Run a `command:new` reflection as agentId="main" with a token.
		const token = "main-inv-c4f1";
		const md = `## Context
- t13d

## Invariants
- ${token} fleet-shared by main writes.

## Derived
- t13d derived.
`;
		h.setReflectionMarkdown(md);
		await h.fireCommandNew({ sessionKey: tk("g5-t13d-main"), agentId: "main" });
		await h.pollForReflectionRow(8000);

		// (3) IMMEDIATELY (within the same event-loop tick batch, NOT after
		// 15s TTL) trigger another recall as sub-agent-A. Without §4.4.0
		// main-aware purge, the stale empty-slice cache entry would be served.
		const recall2 = await h.firePromptBuild({
			sessionKey: tk("g5-t13d-recall-2", "sub-agent-A"),
			agentId: "sub-agent-A",
		});
		expect(recall2?.prependContext).toBeDefined();
		const prependContext = requireValue(
			recall2?.prependContext,
			"expected refreshed reflection prepend context",
		);
		expect(prependContext).toContain("<reflection-invariants>");
		expect(prependContext).toContain(token);
	});

	it("Test 14: cross-agent prompt-boundary leak — ABSENCE assertion", async () => {
		const h = await newHarness({
			pluginConfigOverrides: {
				memoryReflection: {
					injectMode: "none",
					storeToDb: true,
					injectIntoPrompt: true,
				},
			},
		});
		const secret = "secret-marker-3f9a";
		const md = `## Context
- t14

## Invariants
- agent-x specific invariant should not leak.

## Derived
- ${secret} is agent-x's derived insight only.
`;
		h.setReflectionMarkdown(md);
		await h.fireCommandNew({
			sessionKey: tk("g5-t14-x", "agent-x"),
			agentId: "agent-x",
		});
		await h.pollForReflectionRow(8000);

		const result = await h.firePromptBuild({
			sessionKey: tk("g5-t14-y", "agent-y"),
			agentId: "agent-y",
		});
		const text = result?.prependContext ?? "";
		expect(text).not.toContain(secret);
	});
});
