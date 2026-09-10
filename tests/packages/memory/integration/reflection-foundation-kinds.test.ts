/** Real LLM + real ONNX embedder + real encrypted SQLite. Missing deps = FAIL. */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../apps/mem-claw/src/extraction/embedding-provider-client.ts";
import { parseInsightMetadata } from "../../../../apps/mem-claw/src/extraction/memory-metadata-codec.ts";
import { runMappedMemoryLoop } from "../../../../apps/mem-claw/src/reflection/reflection-mapped-memory-loop.ts";
import { storeReflectionEntries } from "../../../../apps/mem-claw/src/reflection/reflection-store-writer.ts";
import { createLlmClient } from "../../../../apps/mem-claw/src/shared/llm-client.ts";
import type { MemoryEntry } from "../../../../apps/mem-claw/src/shared/types.ts";
import { MemoryStore } from "../../../../apps/mem-claw/src/storage/store.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

const LLM = createLlmClient({ preset: "mem_claw/sno_ai_extract", timeoutMs: 60_000 });
const OLD_CATEGORIES = new Set(["identity", "preference", "entity", "event"]);
const NOW = Date.parse("2026-06-11T12:00:00.000Z");

let testEmbedder: Embedder;

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

interface Fixture {
	store: MemoryStore;
	cleanup: () => void;
}

function buildFixture(): Fixture {
	const testDb = createTestDb();
	const store = new MemoryStore({ dbPath: testDb.dbPath, embedder: testEmbedder });
	return {
		store,
		cleanup: () => {
			store.close();
			testDb.cleanup();
		},
	};
}

function readMeta(row: MemoryEntry) {
	return parseInsightMetadata(row.metadata, row);
}

function makeLogSink() {
	return {
		info: () => {},
		warn: () => {},
		debug: () => {},
	};
}

async function runMapped(store: MemoryStore, reflectionText: string, scope: string) {
	await runMappedMemoryLoop({
		reflectionText,
		store,
		embedder: testEmbedder,
		llm: LLM,
		targetScope: scope,
		sourceAgentId: "main",
		sessionKey: `${scope}-session`,
		sessionId: `${scope}-session-id`,
		runAt: NOW,
		usedFallback: false,
		toolErrorSignals: [],
		eventId: `${scope}-event`,
		logger: makeLogSink(),
	});
}

describe("reflection foundation memory kinds", () => {
	let fixture: Fixture | undefined;

	afterEach(() => {
		fixture?.cleanup();
		fixture = undefined;
	});

	it("stores reflection factual events as episodic and emits no old categories", async () => {
		fixture = buildFixture();
		const scope = "reflection-foundation-event";
		await storeReflectionEntries({
			reflectionText: [
				"## Invariants",
				"- Always check the migration marker before startup.",
				"",
				"## Derived",
				"- Run the fixture sweep after category cutover.",
			].join("\n"),
			sessionKey: "event-session",
			sessionId: "event-session-id",
			agentId: "main",
			command: "new",
			scope,
			toolErrorSignals: [],
			runAt: NOW,
			usedFallback: false,
			eventId: "reflection-foundation-event-id",
			writeLegacyCombined: false,
			dedupeThreshold: 0.97,
			embed: (text) => testEmbedder.embed(text),
			searchSemantic: (vector, options) =>
				fixture?.store.searchSemantic(vector, options) ?? Promise.resolve([]),
			store: async (entry) => {
				const result = await fixture?.store.store(entry);
				if (!result) throw new Error("missing fixture store");
				return { id: result.id };
			},
		});

		const rows = await fixture.store.list({ projectId: scope, limit: 20 });
		const eventRow = rows.find((row) => readMeta(row).type === "memory-reflection-event");
		expect(eventRow).toBeDefined();
		expect(eventRow?.category).toBe("episodic");
		expect([...new Set(rows.map((row) => row.category))].some((kind) => OLD_CATEGORIES.has(kind))).toBe(
			false,
		);
	});

	it("stores agent-general anti-patterns as deduped lessons with anti-pattern signatures", async () => {
		fixture = buildFixture();
		const scope = "reflection-foundation-agent-model";
		const first = "Always check the log after restarting the dev server.";
		const nearDuplicate = "Always check the logs after restarting the dev server.";
		await runMapped(
			fixture.store,
			[
				"## Agent model deltas (about the assistant/system)",
				`- ${first}`,
				`- ${nearDuplicate}`,
			].join("\n"),
			scope,
		);

		const rows = await fixture.store.list({ projectId: scope, limit: 10 });
		expect(rows).toHaveLength(1);
		const row = rows[0] as MemoryEntry;
		const metadata = readMeta(row);
		expect(row.category).toBe("lesson");
		expect(metadata.kind).toBe("lesson");
		expect(metadata.mappedKind).toBe("agent-model");
		expect(metadata.anti_pattern_signature).toMatch(/^reflection:agent-model:/);
		expect(OLD_CATEGORIES.has(row.category)).toBe(false);
	});

	it("routes user-specific dislikes into profile preferences through the section writer", async () => {
		fixture = buildFixture();
		const scope = "reflection-foundation-user-model";
		await runMapped(
			fixture.store,
			["## User model deltas (about the human)", "- Dislikes verbose answers."].join("\n"),
			scope,
		);

		const profile = fixture.store.getByFactKey(scope, "profile:preferences.general");
		expect(profile).toBeDefined();
		if (!profile) throw new Error("expected profile preference row");
		const metadata = readMeta(profile);
		expect(profile.category).toBe("profile");
		expect(metadata.kind).toBe("profile");
		expect(metadata.section_name).toBe("preferences.general");
		expect(profile.text.toLowerCase()).toContain("verbose");
		expect(OLD_CATEGORIES.has(profile.category)).toBe(false);
	});
});
