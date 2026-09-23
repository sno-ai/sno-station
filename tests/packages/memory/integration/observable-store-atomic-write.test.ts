/** @file observable-store-atomic-write.test.ts
 * @purpose Proves an atomic extraction write reports one memory.write per created row, the event
 *          OpenClaw phase 11 waits for; the atomic path once bypassed the observable store.
 * @boundary Real encrypted SQLite write door; only the Observe sender is replaced by a recorder.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AtomicKeyedRecord } from "../../../../packages/memory/src/engine/extraction/atomic-profile-keying";
import { buildAtomicWriteCards } from "../../../../packages/memory/src/engine/extraction/atomic-write-projection";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { PluginObservability } from "../../../../packages/memory/src/engine/observability/adapter";
import { pluginConfigSchema } from "../../../../packages/memory/src/engine/shared/types";
import { ObservableMemoryStore } from "../../../../packages/memory/src/engine/observability/observable-memory-store";
import type {
	AtomicExtractionLedgerKey,
	AtomicExtractionRunParameters,
} from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db";

const PROJECT_ID = "atomic-observe-write";
const EXTRACTOR_VERSION = "atomic-v3-observe-write-test";
const SESSION_TIMESTAMP_MS = Date.UTC(2026, 8, 22, 23, 0);
const RUN_PARAMETERS: AtomicExtractionRunParameters = {
	maxInputTokens: 4_096,
	outputTokenBudget: 2_000,
	subchunkCount: 1,
};

function standingRecord(claimText: string): AtomicKeyedRecord {
	return {
		kind: "standing",
		category: "profile",
		claimText,
		subject: "user",
		subjectKind: "user",
		attribute: null,
		refusedAttribute: null,
		value: claimText,
		temporalPhrase: null,
		resolvedTime: null,
		time: { kind: "none" },
		endsCurrent: false,
		endedAt: null,
		importance: "medium",
		changesCurrentState: false,
		todo: "none",
		closeReason: null,
		sourceSpan: { turnIndex: 0, quote: claimText, startOffset: 0, endOffset: claimText.length },
		relations: [],
		singleClaim: true,
		lane: "active",
		dispositionReason: null,
		resplit: false,
	};
}

interface Emitted {
	eventType: string;
	sessionUuid?: string;
	scope?: { project_id?: string };
	payload: { key_hash: string; byte_len: number };
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("observable atomic extraction write", () => {
	let fixture: TestDb;
	let store: ObservableMemoryStore;
	let emitted: Emitted[];
	let tracked: Promise<unknown>[];

	beforeEach(() => {
		fixture = createTestDb();
		emitted = [];
		tracked = [];
		const recorder = {
			enabled: true,
			hashText: (text: string) => `hash:${text}`,
			emit: async (event: Emitted) => {
				emitted.push(event);
			},
			emitError: async () => undefined,
			trackBestEffort: (_label: string, task: () => unknown) => {
				tracked.push(Promise.resolve().then(task));
			},
		} as unknown as PluginObservability;
		store = new ObservableMemoryStore(
			{ dbPath: fixture.dbPath, embedder },
			recorder,
			() => "session-atomic",
			{ provider: "openai-compatible" } as never,
		);
	});

	afterEach(async () => {
		await store.close();
		fixture.cleanup();
	});

	it("reports every created row as memory.write", async () => {
		const key: AtomicExtractionLedgerKey = {
			conversationId: "conversation-observe-write",
			chunkHash: "chunk-observe-write",
			pipelineVersion: EXTRACTOR_VERSION,
		};
		store.beginAtomicExtractionChunk({
			...key,
			rawChunk: "raw transcript for observe write",
			routingSnapshotId: "routing-snapshot-observe-write",
			runParameters: RUN_PARAMETERS,
			nowMs: SESSION_TIMESTAMP_MS,
		});
		store.recordAtomicExtractionCalls(key, SESSION_TIMESTAMP_MS + 1);
		const cards = buildAtomicWriteCards({
			records: [
				standingRecord("The user's package manager is pnpm-7f3a."),
				standingRecord("The user prefers richer memory context."),
			],
			idempotencyKeys: ["observe-write-package-manager", "observe-write-memory-mode"],
			sourceTurnOffset: 0,
			sessionTimestampMs: SESSION_TIMESTAMP_MS,
			timezone: "UTC",
		});

		const result = await store.storeAtomicExtractionChunk({
			ledgerKey: key,
			projectId: PROJECT_ID,
			extractorVersion: EXTRACTOR_VERSION,
			nowMs: SESSION_TIMESTAMP_MS + 2,
			cards,
		});
		await Promise.all(tracked);

		expect(result.createdCount).toBe(2);
		const rows = fixture.sqlite
			.prepare("SELECT id, content_hash, text FROM nodix_memories WHERE project_id = ?")
			.all(PROJECT_ID) as Array<{ id: string; content_hash: string | null; text: string }>;
		expect(rows.map((row) => row.id).sort()).toEqual([...result.cardIds].sort());
		const writes = emitted.filter((event) => event.eventType === "memory.write");
		expect(
			writes
				.map((event) => ({
					session: event.sessionUuid,
					scope: event.scope?.project_id,
					key: event.payload.key_hash,
					bytes: event.payload.byte_len,
				}))
				.sort((a, b) => a.key.localeCompare(b.key)),
		).toEqual(
			rows
				.map((row) => ({
					session: "session-atomic",
					// A project id that is not an absolute path sends no scope.project_id (REQ-4).
					scope: undefined,
					key: `hash:${row.content_hash || row.id}`,
					bytes: Buffer.byteLength(row.text, "utf8"),
				}))
				.sort((a, b) => a.key.localeCompare(b.key)),
		);
	});
});

// REQ-7: automatic capture writes through this atomic path, so the capturing agent's id must
// reach every stored card's metadata; with no writer id, no key is written.
describe("atomic extraction write carries the writer", () => {
	let fixture: TestDb;
	let store: ObservableMemoryStore;

	beforeEach(() => {
		fixture = createTestDb();
		const recorder = {
			enabled: false,
			hashText: (text: string) => text,
			emit: async () => undefined,
			emitError: async () => undefined,
			trackBestEffort: () => undefined,
		} as unknown as PluginObservability;
		store = new ObservableMemoryStore({ dbPath: fixture.dbPath, embedder }, recorder, () => "session-writer",
			{ provider: "openai-compatible" } as never);
	});

	afterEach(async () => {
		await store.close();
		fixture.cleanup();
	});

	async function writeWith(writer: string | undefined, claim: string): Promise<Record<string, unknown>> {
		const key: AtomicExtractionLedgerKey = { conversationId: `c-${claim}`, chunkHash: `h-${claim}`, pipelineVersion: EXTRACTOR_VERSION };
		store.beginAtomicExtractionChunk({ ...key, rawChunk: claim, routingSnapshotId: `r-${claim}`,
			runParameters: RUN_PARAMETERS, nowMs: SESSION_TIMESTAMP_MS });
		store.recordAtomicExtractionCalls(key, SESSION_TIMESTAMP_MS + 1);
		const cards = buildAtomicWriteCards({
			records: [standingRecord(claim)], idempotencyKeys: [`k-${claim}`], sourceTurnOffset: 0,
			sessionTimestampMs: SESSION_TIMESTAMP_MS, timezone: "UTC",
			...(writer ? { writerAgentId: writer } : {}),
		} as Parameters<typeof buildAtomicWriteCards>[0]);
		const result = await store.storeAtomicExtractionChunk({ ledgerKey: key, projectId: PROJECT_ID,
			extractorVersion: EXTRACTOR_VERSION, nowMs: SESSION_TIMESTAMP_MS + 2, cards });
		const [id] = result.cardIds;
		const row = fixture.sqlite.prepare("SELECT metadata FROM nodix_memories WHERE id = ?").get(id) as { metadata: string };
		return JSON.parse(row.metadata) as Record<string, unknown>;
	}

	it("stores writer_agent_id for a captured card and none without a writer", async () => {
		expect((await writeWith("codex", "The user's terminal is kitty-4e1a.")).writer_agent_id).toBe("codex");
		expect(Object.hasOwn(await writeWith(undefined, "The user's font is iosevka-77c2."), "writer_agent_id")).toBe(false);
	});
});

// QCG-3 (REQ-4): with a real PluginObservability writing buffer.db, a write whose project id is an
// absolute checkout path carries the rule's p_ id; a non-path project id carries none.
describe("memory.write project scope", () => {
	const ENV_KEYS = ["SNO_HOME", "SNO_PROFILE_DIR", "SNO_BUFFER_PATH",
		"SNO_IDENTITY_PATH", "SNO_CONSENT_PATH"] as const;
	let root: string;
	let previous: Record<string, string | undefined>;
	let fixture: TestDb;

	beforeEach(() => {
		previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
		root = mkdtempSync(join(tmpdir(), "memory-write-project-"));
		delete process.env.SNO_HOME;
		process.env.SNO_PROFILE_DIR = root;
		process.env.SNO_BUFFER_PATH = join(root, "buffer.db");
		process.env.SNO_IDENTITY_PATH = join(root, "identity.json");
		process.env.SNO_CONSENT_PATH = join(root, "state", "consent.json");
		fixture = createTestDb();
	});

	afterEach(() => {
		fixture.cleanup();
		rmSync(root, { recursive: true, force: true });
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	async function write(projectId: string, claim: string): Promise<void> {
		const config = pluginConfigSchema.parse({
			embedding: { provider: "local-onnx" },
			observe: { enabled: true, agentId: "claude-code", baseUrl: "http://127.0.0.1:9" },
		});
		const observability = new PluginObservability(config, root, { warn: () => undefined });
		const store = new ObservableMemoryStore(
			{ dbPath: fixture.dbPath, embedder },
			observability,
			() => "01995a3c-7b2c-7d4e-8f00-0a1b2c3d4e5f",
			{ provider: "openai-compatible" } as never,
		);
		const key: AtomicExtractionLedgerKey = {
			conversationId: `conversation-${claim}`,
			chunkHash: `chunk-${claim}`,
			pipelineVersion: EXTRACTOR_VERSION,
		};
		store.beginAtomicExtractionChunk({
			...key, rawChunk: claim, routingSnapshotId: `routing-${claim}`, runParameters: RUN_PARAMETERS,
			nowMs: SESSION_TIMESTAMP_MS,
		});
		store.recordAtomicExtractionCalls(key, SESSION_TIMESTAMP_MS + 1);
		const cards = buildAtomicWriteCards({
			records: [standingRecord(claim)], idempotencyKeys: [`key-${claim}`], sourceTurnOffset: 0,
			sessionTimestampMs: SESSION_TIMESTAMP_MS, timezone: "UTC",
		});
		const result = await store.storeAtomicExtractionChunk({
			ledgerKey: key, projectId, extractorVersion: EXTRACTOR_VERSION, nowMs: SESSION_TIMESTAMP_MS + 2, cards,
		});
		expect(result.createdCount).toBe(1);
		await store.close();
		await observability.shutdown();
	}

	function writeScopes(): (string | undefined)[] {
		const path = join(root, "buffer.db");
		if (!existsSync(path)) return [];
		const db = new Database(path, { readonly: true });
		try {
			return (db.prepare("SELECT payload FROM events ORDER BY rowid").all() as { payload: Buffer }[])
				.map((row) => JSON.parse(row.payload.toString("utf8")))
				.filter((e) => e.event_type === "memory.write")
				.map((e) => e.scope.project_id);
		} finally {
			db.close();
		}
	}

	it("sends the rule's id for a checkout path and none for hermes:/x", async () => {
		const checkout = join(root, "checkout");
		mkdirSync(checkout);
		execFileSync("git", ["init", "-q", checkout]);
		execFileSync("git", ["-C", checkout, "remote", "add", "origin", "https://github.com/Example/Project.git"]);
		await write(checkout, "The user's editor is helix-2c9d.");
		await write("hermes:/x", "The user's shell is fish-81ab.");
		const expected = `p_${createHash("sha256").update("github.com/example/project").digest("hex").slice(0, 16)}`;
		expect(writeScopes()).toEqual([expected, undefined]);
	});
});
