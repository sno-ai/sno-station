import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import DatabaseConstructor from "better-sqlite3";
import { createCuid2 } from "../../../../packages/common-core/dist/index.js";
import * as publicModule from "../../../../packages/observability/dist/index.js";
import { snoObserve } from "../../../../packages/observability/dist/index.js";
import { verifyAuditEvent } from "../../../../packages/observability/dist/internal/audit-verify.js";
import {
	BufferStore,
	decodeEnvelope,
} from "../../../../packages/observability/dist/internal/buffer-store.js";
import {
	canonicalPreimage,
	computeSelfHash,
} from "../../../../packages/observability/dist/internal/canonical-hash.js";
import { ConsentStore } from "../../../../packages/observability/dist/internal/consent.js";
import {
	ChainSeedError,
	InvalidAgentIdError,
	InvalidConsentError,
	InvalidEventPayloadError,
	InvalidEventTypeError,
} from "../../../../packages/observability/dist/internal/errors.js";
import { exportEvents } from "../../../../packages/observability/dist/internal/export.js";
import { sha256Hex } from "../../../../packages/observability/dist/internal/hash.js";
import { bootstrapIdentity } from "../../../../packages/observability/dist/internal/identity.js";
import {
	machineSecretHash,
	registerMachine,
} from "../../../../packages/observability/dist/internal/machine-registration.js";
import { getIdentityLockPath } from "../../../../packages/observability/dist/internal/paths.js";
import {
	detectProjectId,
	normalizeGitRemote,
} from "../../../../packages/observability/dist/internal/project-id.js";
import { redactEventPayload } from "../../../../packages/observability/dist/internal/redact.js";
import { SnoObserveRuntime } from "../../../../packages/observability/dist/internal/runtime.js";
import { shouldSampleTool } from "../../../../packages/observability/dist/internal/sampling.js";
import {
	parseConsentValue,
	parseEventInput,
} from "../../../../packages/observability/dist/internal/schemas.js";
import {
	countTokens,
	countTokensFast,
} from "../../../../packages/observability/dist/internal/tokens.js";
import { AGENT_IDS, EVENT_TYPES } from "../../../../packages/observability/dist/internal/types.js";
import {
	createEnvelope,
	serializeEnvelope,
} from "../../../../packages/observability/dist/internal/wire-envelope.js";

const expectedEventTypes = [
	"agent.identify",
	"memory.write",
	"memory.read",
	"memory.snapshot",
	"memory.telemetry",
	"llm.call",
	"tool.call",
	"session.start",
	"session.end",
	"prompt.submit",
	"permission.request",
	"consent.change",
	"error",
	"cost.summary",
];

function testHash(index) {
	return index.toString(16).padStart(64, "0");
}

const validPayloads = {
	"agent.identify": {
		agent_id: "codex",
		machine_id: "018f7d0c-fd8b-7ccf-9b9b-0a2ea938ad0d",
		sdk_version: "0.1.0",
	},
	"memory.write": {
		key_hash: testHash(1),
		byte_len: 12,
		content_tokens: 3,
		tokens_method: "char_approximation",
	},
	"memory.read": {
		query_hash: testHash(2),
		query_tokens: 2,
		k: 5,
		hit_count: 1,
		result_tokens: 10,
		latency_ms: 4,
		tokens_method: "tiktoken",
	},
	"memory.snapshot": {
		session_uuid: "018f7d0c-fd8b-7ccf-9b9b-0a2ea938ad0d",
		snapshot_reason: "session_end",
		total_entries: 2,
		total_bytes: 256,
		oldest_entry_ts_ms: 1730000000000,
		newest_entry_ts_ms: 1730000001000,
	},
	"memory.telemetry": {
		sync_kind: "memory_events",
		first_event_id: 1,
		last_event_id: 2,
		event_count: 2,
		event_types: { create: 1, recall: 1 },
		events: [
			{
				event_id: 1,
				event_type: "create",
				fact_id: "fact-1",
				memory_kind: "episodic",
				timestamp_ms: 1730000000000,
				agent_id: "codex",
				project_id: "p_test",
				content_hash: testHash(8),
			},
			{
				event_id: 2,
				event_type: "recall",
				fact_id: "fact-1",
				memory_kind: "episodic",
				timestamp_ms: 1730000001000,
				session_uuid: "session-1",
				turn_id: "turn-1",
				agent_id: "codex",
				project_id: "p_test",
				retrieval_rank: 1,
				retrieval_score: 0.7,
			},
		],
	},
	"llm.call": {
		model: "gpt-4o",
		prompt_tokens: 10,
		completion_tokens: 3,
		latency_ms: 120,
		cache_read_tokens: 0,
		cache_write_tokens: 0,
		token_source: "host_agent_paid",
	},
	"tool.call": {
		tool_name: "bash",
		decision: "allow",
		input_hash: testHash(3),
		output_hash: testHash(4),
		latency_ms: 8,
	},
	"session.start": { session_uuid: "018f7d0c-fd8b-7ccf-9b9b-0a2ea938ad0d" },
	"session.end": {
		session_uuid: "018f7d0c-fd8b-7ccf-9b9b-0a2ea938ad0d",
		duration_ms: 1000,
	},
	"prompt.submit": { prompt_hash: testHash(5), byte_len: 9 },
	"permission.request": {
		kind: "shell",
		decision: "deny",
		target_hash: testHash(6),
	},
	"consent.change": { from: "metadata-only", to: "off", reason: "test" },
	error: { kind: "recoverable", message_hash: testHash(7), recoverable: true },
	"cost.summary": {
		session_uuid: "018f7d0c-fd8b-7ccf-9b9b-0a2ea938ad0d",
		tokens_in: 20,
		tokens_out: 5,
		llm_calls: 1,
		tool_calls: 1,
		memory_reads: 2,
		memory_writes: 3,
		host_agent_prompt_tokens: 10,
		host_agent_completion_tokens: 3,
		plugin_internal_prompt_tokens: 10,
		plugin_internal_completion_tokens: 2,
		local_memory_input_tokens: 12,
		local_memory_output_tokens: 8,
	},
};

const scope = {
	user_id: "u_test",
	machine_id: "018f7d0c-fd8b-7ccf-9b9b-0a2ea938ad0d",
	agent_id: "codex",
	project_id: "p_test",
};

function testUuidV7(index) {
	return `018f7d0c-fd8b-7${(index % 0x1000).toString(16).padStart(3, "0")}-9b9b-${index.toString(16).padStart(12, "0")}`;
}

describe("sno observe Node package", () => {
	it("validates the public SDK event surface", () => {
		assert.deepEqual(EVENT_TYPES, expectedEventTypes);
		for (const eventType of expectedEventTypes) {
			assert.equal(
				parseEventInput({
					event_type: eventType,
					lane: "memory",
					agent_id: "codex",
					payload: validPayloads[eventType],
				}).eventType,
				eventType,
			);
		}

		for (const agentId of AGENT_IDS) {
			assert.equal(
				parseEventInput({
					event_type: "session.start",
					lane: "memory",
					agent_id: agentId,
					payload: { session_uuid: "018f7d0c-fd8b-7ccf-9b9b-0a2ea938ad0d" },
				}).agentId,
				agentId,
			);
		}

		assert.throws(
			() =>
				parseEventInput({
					event_type: "session.start",
					lane: "memory",
					agent_id: "claude-cli",
					payload: { session_uuid: "018f7d0c-fd8b-7ccf-9b9b-0a2ea938ad0d" },
				}),
			InvalidAgentIdError,
		);
		assert.throws(
			() =>
				parseEventInput({
					event_type: "audit.anchor",
					lane: "memory",
					agent_id: "codex",
					payload: {},
				}),
			InvalidEventTypeError,
		);
		assert.throws(
			() =>
				parseEventInput({
					event_type: "prompt.submit",
					lane: "memory",
					agent_id: "codex",
					consent_level: "metadata-only",
					payload: {
						prompt_hash: testHash(5),
						byte_len: 9,
						prompt_text: "raw prompt",
					},
				}),
			InvalidEventPayloadError,
		);
		assert.throws(
			() =>
				parseEventInput({
					event_type: "error",
					lane: "memory",
					agent_id: "codex",
					consent_level: "metadata-only",
					payload: { ...validPayloads.error, message: "raw error text" },
				}),
			InvalidEventPayloadError,
		);
		assert.throws(
			() =>
				parseEventInput({
					event_type: "tool.call",
					lane: "memory",
					agent_id: "codex",
					payload: {
						...validPayloads["tool.call"],
						input: "raw",
						output: "raw",
					},
				}),
			InvalidEventPayloadError,
		);
		assert.throws(
			() =>
				parseEventInput({
					event_type: "llm.call",
					lane: "memory",
					agent_id: "codex",
					payload: {
						...validPayloads["llm.call"],
						tokens_method: "char_approximation",
					},
				}),
			InvalidEventPayloadError,
		);
		assert.throws(
			() =>
				parseEventInput({
					event_type: "memory.write",
					lane: "memory",
					agent_id: "codex",
					payload: { key_hash: testHash(1), byte_len: 12, content_tokens: 3 },
				}),
			InvalidEventPayloadError,
		);
		assert.throws(() => parseEventInput([]), InvalidEventPayloadError);
		assert.throws(() => parseEventInput({ events: [] }), InvalidEventPayloadError);
		assert.throws(
			() =>
				parseEventInput({
					event_type: "memory.write",
					lane: "memory",
					agent_id: "codex",
					payload: {
						...validPayloads["memory.write"],
						raw: "unexpected",
					},
				}),
			InvalidEventPayloadError,
		);
	});

	it("matches the canonical hash vector and compact envelope shape", () => {
		const fixture = JSON.parse(
			readFileSync(
				fileURLToPath(new URL("../fixtures/test-vectors/canonical-hash.json", import.meta.url)),
				"utf8",
			),
		);
		const input = {
			eventId: fixture.envelope.event_id,
			eventType: fixture.envelope.event_type,
			lane: "memory",
			tsEdgeMs: fixture.envelope.ts_edge_ms,
			scope: fixture.envelope.scope,
			chainEpoch: fixture.envelope.chain_epoch,
			seq: fixture.envelope.seq,
			consentLevel: fixture.envelope.consent_level,
			redacted: fixture.envelope.redacted,
			payload: fixture.envelope.payload,
			prev: fixture.envelope.hash_chain.prev,
		};

		const preimage = canonicalPreimage(input);
		assert.equal(preimage, fixture.preimage);
		assert.equal(preimage.split("\n").length, 11);
		assert.equal(preimage.endsWith("\n"), false);
		assert.equal(computeSelfHash(input), fixture.expected_self_hash);
		assert.equal(
			computeSelfHash({ ...input, payload: { world: "hello", answer: 42 } }),
			computeSelfHash({ ...input, payload: { answer: 42, world: "hello" } }),
		);

		const parsed = JSON.parse(serializeEnvelope(createFixtureEnvelope(fixture)));
		assert.deepEqual(Object.keys(parsed), [
			"schema_version",
			"event_id",
			"event_type",
			"lane",
			"ts_edge_ms",
			"consent_level",
			"redacted",
			"chain_epoch",
			"seq",
			"scope",
			"hash_chain",
			"payload",
		]);
		assert.equal(parsed.schema_version, "v1");
		assert.equal(parsed.chain_epoch, fixture.envelope.chain_epoch);
		assert.equal(parsed.seq, fixture.envelope.seq);
		assert.deepEqual(Object.keys(parsed.hash_chain), ["prev", "self"]);
		assert.equal(
			serializeEnvelope(createFixtureEnvelope(fixture)),
			serializeEnvelope(createFixtureEnvelope(fixture)),
		);
	});

	it("normalizes legacy persisted envelopes for verification and CSV export", () => {
		const temp = createTempSnoEnv();
		const dbPath = join(temp.dir, "buffer.db");
		let store = new BufferStore(dbPath);
		try {
			store.append({
				eventId: "event-identify-legacy",
				eventType: "agent.identify",
				lane: "memory",
				tsEdgeMs: 1730000000000,
				consentLevel: "metadata-only",
				redacted: false,
				scope,
				payload: validPayloads["agent.identify"],
				terminal: false,
			});
			store.append({
				eventId: "event-memory-legacy",
				eventType: "memory.write",
				lane: "memory",
				tsEdgeMs: 1730000000001,
				consentLevel: "metadata-only",
				redacted: false,
				scope,
				payload: validPayloads["memory.write"],
				terminal: false,
			});
			const rows = store.getAllRows();
			store.close();
			store = undefined;

			const db = new DatabaseConstructor(dbPath);
			try {
				const update = db.prepare("UPDATE events SET payload = ? WHERE rowid = ?");
				for (const row of rows) {
					const envelope = JSON.parse(row.payload.toString("utf8"));
					const legacyEnvelope = {
						...envelope,
						hash_chain: {
							chain_epoch: envelope.chain_epoch,
							seq: envelope.seq,
							prev: envelope.hash_chain.prev,
							self: envelope.hash_chain.self,
						},
					};
					delete legacyEnvelope.schema_version;
					delete legacyEnvelope.chain_epoch;
					delete legacyEnvelope.seq;
					update.run(Buffer.from(JSON.stringify(legacyEnvelope), "utf8"), row.rowid);
				}
			} finally {
				db.close();
			}

			const legacyStore = new BufferStore(dbPath);
			try {
				assert.equal(legacyStore.verifyLocalChain(), true);
				const decoded = decodeEnvelope(legacyStore.getAllRows()[1].payload);
				assert.equal(decoded.schema_version, "v1");
				assert.equal(decoded.chain_epoch, 0);
				assert.equal(decoded.seq, 1);
				assert.deepEqual(Object.keys(decoded.hash_chain), ["prev", "self"]);

				const csv = new TextDecoder().decode(exportEvents(legacyStore, { format: "csv" }).data);
				assert.match(csv, /event-memory-legacy/u);
				assert.doesNotMatch(csv, /undefined/u);
			} finally {
				legacyStore.close();
			}
		} finally {
			if (store !== undefined) {
				store.close();
			}
			cleanupTempSnoEnv(temp);
		}
	});

	it("bootstraps identity and persists the hash chain in SQLite", () => {
		const temp = createTempSnoEnv();
		const dbPath = join(temp.dir, "buffer.db");
		try {
			const identity = bootstrapIdentity(temp.env);
			assert.deepEqual(bootstrapIdentity(temp.env), identity);
			assert.equal(getIdentityLockPath(temp.env), join(temp.dir, "identity.lock"));
			assert.equal(identity.version, 1);
			assert.match(
				identity.machine_uuid,
				/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
			);
			assert.match(identity.machine_secret, /^[0-9a-f]{64}$/u);
			if (process.platform !== "win32") {
				assert.equal(statSync(temp.env.SNO_IDENTITY_PATH).mode & 0o777, 0o600);
			}

			writeFileSync(
				temp.env.SNO_IDENTITY_PATH,
				`${JSON.stringify({ ...identity, user_account_id: "acct_mock_123" }, null, 2)}\n`,
				{ mode: 0o600 },
			);
			const migratedLegacyAccount = bootstrapIdentity(temp.env);
			assert.equal(migratedLegacyAccount.user_cuid, identity.user_cuid);
			assert.equal(migratedLegacyAccount.machine_uuid, identity.machine_uuid);
			assert.equal(migratedLegacyAccount.user_account_id, undefined);
			const migratedPersisted = JSON.parse(readFileSync(temp.env.SNO_IDENTITY_PATH, "utf8"));
			assert.equal(migratedPersisted.user_account_id, undefined);

			writeFileSync(temp.env.SNO_IDENTITY_PATH, "{not-json", { mode: 0o600 });
			const regenerated = bootstrapIdentity(temp.env);
			const persisted = JSON.parse(readFileSync(temp.env.SNO_IDENTITY_PATH, "utf8"));
			assert.equal(persisted.user_cuid, regenerated.user_cuid);
			writeFileSync(
				temp.env.SNO_IDENTITY_PATH,
				JSON.stringify({ version: 1, user_cuid: "missing-fields" }),
				{ mode: 0o600 },
			);
			const regeneratedMissing = bootstrapIdentity(temp.env);
			assert.notEqual(regeneratedMissing.user_cuid, "missing-fields");

			const store = new BufferStore(dbPath);
			try {
				assert.throws(
					() =>
						store.append({
							eventId: "event-memory-first",
							eventType: "memory.write",
							lane: "memory",
							tsEdgeMs: 1730000000000,
							consentLevel: "metadata-only",
							redacted: false,
							scope,
							payload: validPayloads["memory.write"],
							terminal: false,
						}),
					ChainSeedError,
				);
				const first = store.append({
					eventId: "event-identify",
					eventType: "agent.identify",
					lane: "memory",
					tsEdgeMs: 1730000000000,
					consentLevel: "metadata-only",
					redacted: false,
					scope,
					payload: validPayloads["agent.identify"],
					terminal: false,
				});
				const second = store.append({
					eventId: "event-memory",
					eventType: "memory.write",
					lane: "memory",
					tsEdgeMs: 1730000000001,
					consentLevel: "metadata-only",
					redacted: false,
					scope,
					payload: validPayloads["memory.write"],
					terminal: false,
				});
				assert.equal(first.seq, 0);
				assert.equal(second.seq, 1);
				assert.equal(second.envelope.hash_chain.prev, first.selfHash);
				assert.equal(store.verifyLocalChain(), true);
			} finally {
				store.close();
			}

			const reopened = new BufferStore(dbPath);
			try {
				const next = reopened.append({
					eventId: "event-session",
					eventType: "session.start",
					lane: "memory",
					tsEdgeMs: 1730000000002,
					consentLevel: "metadata-only",
					redacted: false,
					scope,
					payload: validPayloads["session.start"],
					terminal: false,
				});
				assert.equal(next.seq, 2);
				assert.equal(reopened.verifyLocalChain(), true);
				assert.throws(
					() =>
						parseEventInput({
							event_type: "session.start",
							lane: "memory",
							agent_id: "claude-cli",
							payload: { session_uuid: "018f7d0c-fd8b-7ccf-9b9b-0a2ea938ad0d" },
						}),
					InvalidAgentIdError,
				);
				assert.equal(reopened.countAll(), 3);
				const rows = reopened.getAllRows();
				reopened.markShipped(rows[0].rowid);
				reopened.markShipped(rows[1].rowid);
				assert.equal(
					reopened.pruneRetention(
						Number.MAX_SAFE_INTEGER,
						24 * 60 * 60 * 1000,
						Date.now() + 90_000_000,
					).deletedEvents,
					2,
				);
				assert.deepEqual(
					reopened.getAllRows().map((row) => row.event_id),
					["event-session"],
				);
			} finally {
				reopened.close();
			}
		} finally {
			cleanupTempSnoEnv(temp);
		}
	});

	it("derives project IDs from git remotes, cwd, and identity fallback", () => {
		const temp = createTempSnoEnv();
		try {
			assert.equal(normalizeGitRemote("https://github.com/foo/bar.git"), "github.com/foo/bar");
			assert.equal(normalizeGitRemote("https://x:y@github.com/foo/bar.git"), "github.com/foo/bar");
			assert.equal(normalizeGitRemote("git@github.com:foo/bar.git"), "github.com/foo/bar");

			const firstDir = join(temp.dir, "first");
			const secondDir = join(temp.dir, "second");
			mkdirSync(firstDir);
			mkdirSync(secondDir);
			const firstClone = join(temp.dir, "first-clone");
			const secondClone = join(temp.dir, "second-clone");
			initGitRepo(firstClone, "https://github.com/foo/bar.git");
			initGitRepo(secondClone, "https://x:y@github.com/foo/bar.git");
			assert.equal(detectProjectId(firstClone, temp.env), detectProjectId(secondClone, temp.env));
			const movedClone = join(temp.dir, "moved-clone");
			renameSync(firstClone, movedClone);
			assert.equal(detectProjectId(movedClone, temp.env), detectProjectId(secondClone, temp.env));

			assert.equal(
				detectProjectId(firstDir, temp.env),
				`p_${sha256Hex(firstDir.toLowerCase()).slice(0, 16)}`,
			);
			assert.notEqual(detectProjectId(firstDir, temp.env), detectProjectId(secondDir, temp.env));

			const defaultProject = detectProjectId("/", temp.env);
			assert.match(defaultProject, /^p_default_\d+$/u);
			assert.equal(detectProjectId("/", temp.env), defaultProject);
			const identity = JSON.parse(readFileSync(temp.env.SNO_IDENTITY_PATH, "utf8"));
			assert.equal(identity.default_project_id, defaultProject);
		} finally {
			cleanupTempSnoEnv(temp);
		}
	});

	it("redacts metadata, samples tools deterministically, and counts large prompts quickly", async () => {
		for (const consent of ["off", "metadata-only", "full"]) {
			const result = redactEventPayload({ note: "contact alice@example.com" }, consent);
			assert.equal(JSON.stringify(result.value).includes("alice@example.com"), false);
		}
		const redacted = redactEventPayload(
			{
				content: "raw memory body",
				note: "contact alice@example.com +1-415-555-0100 card 4111 1111 1111 1111 key sk_live_<REDACTED> ip 192.168.1.42 v6 2001:0db8:85a3:0000:0000:8a2e:0370:7334 ghp_<REDACTED> xox_<REDACTED> AIza1234567890abcdef AKIA1234567890ABCDEF",
			},
			"metadata-only",
		);
		const serialized = JSON.stringify(redacted.value);
		assert.equal(redacted.redacted, true);
		for (const marker of ["<email>", "<phone>", "<card>", "<api-key>", "<ip>"]) {
			assert.equal(serialized.includes(marker), true);
		}
		assert.equal(serialized.includes("alice@example.com"), false);

		const temp = createTempSnoEnv();
		try {
			const rulesPath = join(temp.dir, "redaction-rules.txt");
			writeFileSync(rulesPath, "CUSTOMSECRET\\d+\n");
			const custom = redactEventPayload({ note: "value CUSTOMSECRET123" }, "full", rulesPath);
			assert.equal(JSON.stringify(custom.value).includes("CUSTOMSECRET123"), false);
			assert.equal(shouldSampleTool("event-1", "bash exec", 20, temp.env), true);
			assert.equal(
				shouldSampleTool("event-1", "bash exec", 20, {
					...temp.env,
					SNO_OBSERVE_TOOLS_ALWAYS: "bash",
				}),
				true,
			);
			assert.equal(
				shouldSampleTool("event-1", "bash exec", 20, {
					...temp.env,
					SNO_OBSERVE_TOOLS_OFF: "bash",
				}),
				false,
			);
			assert.equal(
				shouldSampleTool("event-1", "read file", 20, temp.env),
				shouldSampleTool("event-1", "read file", 20, temp.env),
			);
		} finally {
			cleanupTempSnoEnv(temp);
		}

		const count = await countTokens("x".repeat(100_001));
		assert.equal(count.method, "char_approximation");
		assert.equal(count.tokens, countTokensFast("x".repeat(100_001)));
		const smallCount = await countTokens("hello");
		assert.equal(smallCount.method, "tiktoken");

		let sampled = 0;
		for (let index = 0; index < 10_000; index += 1) {
			if (shouldSampleTool(`event-${index}`, "read file", 20)) {
				sampled += 1;
			}
		}
		assert.equal(sampled >= 450 && sampled <= 550, true);
	});

	it("flushes one compact envelope per request and marks rows shipped", async () => {
		const temp = createTempSnoEnv();
		const { calls, fetch } = createFetchRecorder();
		const runtime = new SnoObserveRuntime({
			env: temp.env,
			cwd: temp.dir,
			fetch,
		});
		try {
			const events = [];
			const unsubscribe = runtime.subscribe((event) => {
				events.push(`${event.eventType}:${event.accepted}`);
			});
			const emitResult = await runtime.emitParsed(
				parseEventInput({
					event_type: "memory.write",
					lane: "memory",
					agent_id: "codex",
					payload: validPayloads["memory.write"],
				}),
			);
			unsubscribe();
			assert.equal(emitResult.accepted, true);
			assert.deepEqual(events, ["memory.write:true"]);

			assert.deepEqual(await runtime.flush(), {
				shipped: 2,
				terminal: 0,
				retryable: 0,
			});
			assert.equal(calls.length, 2);
			assert.equal(existsSync(join(temp.dir, ".mem-claw", "state", "audit.jsonl")), false);
			assert.equal(readFileSync(temp.env.SNO_BUFFER_PATH).includes("alice@example.com"), false);
			for (const call of calls) {
				assert.equal(call.url, "https://sno.test/api/v1/events");
				assert.equal(call.headers["Content-Type"], "application/json");
				assert.match(call.headers.Authorization, /^Bearer [0-9a-f]{64}$/u);
				const posted = JSON.parse(call.body);
				assert.equal(Array.isArray(posted), false);
				assert.deepEqual(Object.keys(posted), [
					"schema_version",
					"event_id",
					"event_type",
					"lane",
					"ts_edge_ms",
					"consent_level",
					"redacted",
					"chain_epoch",
					"seq",
					"scope",
					"hash_chain",
					"payload",
				]);
			}

			const store = new BufferStore(temp.env.SNO_BUFFER_PATH);
			try {
				const rows = store.getAllRows();
				const envelopes = rows.map((row) => decodeEnvelope(row.payload));
				assert.deepEqual(
					envelopes.map((envelope) => envelope.event_type),
					["agent.identify", "memory.write"],
				);
				assert.deepEqual(
					rows.map((row) => row.shipped),
					[1, 1],
				);
				assert.equal(envelopes[0].hash_chain.prev, "GENESIS");
				assert.equal(envelopes[1].hash_chain.prev, envelopes[0].hash_chain.self);
				assert.equal(JSON.stringify(envelopes).includes("alice@example.com"), false);
				assert.equal(store.verifyLocalChain(), true);
			} finally {
				store.close();
			}
		} finally {
			await runtime.shutdown().catch(() => {});
			cleanupTempSnoEnv(temp);
		}
	});

	it("uses only persisted identity for account scope", async () => {
		const anonymousTemp = createTempSnoEnv("sno-observe-anonymous-account-scope-");
		const anonymousRuntime = new SnoObserveRuntime({
			env: anonymousTemp.env,
			cwd: anonymousTemp.dir,
			fetch: createFetchRecorder().fetch,
		});
		try {
			await anonymousRuntime.emitParsed(
				parseEventInput({
					event_type: "memory.write",
					lane: "memory",
					agent_id: "codex",
					scope: { user_account_id: "acct_from_caller" },
					payload: validPayloads["memory.write"],
				}),
			);
			const store = new BufferStore(anonymousTemp.env.SNO_BUFFER_PATH);
			try {
				const envelopes = store.getAllRows().map((row) => decodeEnvelope(row.payload));
				assert.equal(envelopes[1].scope.user_account_id, undefined);
			} finally {
				store.close();
			}
		} finally {
			await anonymousRuntime.shutdown().catch(() => {});
			cleanupTempSnoEnv(anonymousTemp);
		}

		const claimedTemp = createTempSnoEnv("sno-observe-claimed-account-scope-");
		const identity = bootstrapIdentity(claimedTemp.env);
		const accountCuid = createCuid2();
		writeFileSync(
			claimedTemp.env.SNO_IDENTITY_PATH,
			`${JSON.stringify({ ...identity, user_account_id: accountCuid }, null, 2)}\n`,
		);
		const claimedRuntime = new SnoObserveRuntime({
			env: claimedTemp.env,
			cwd: claimedTemp.dir,
			fetch: createFetchRecorder().fetch,
		});
		try {
			await claimedRuntime.emitParsed(
				parseEventInput({
					event_type: "memory.write",
					lane: "memory",
					agent_id: "codex",
					scope: { user_account_id: "acct_from_caller" },
					payload: validPayloads["memory.write"],
				}),
			);
			const store = new BufferStore(claimedTemp.env.SNO_BUFFER_PATH);
			try {
				const envelopes = store.getAllRows().map((row) => decodeEnvelope(row.payload));
				assert.equal(envelopes[1].scope.user_account_id, accountCuid);
			} finally {
				store.close();
			}
		} finally {
			await claimedRuntime.shutdown().catch(() => {});
			cleanupTempSnoEnv(claimedTemp);
		}
	});

	it("routes retryable and terminal chain responses conservatively", async () => {
		const retryTemp = createTempSnoEnv("sno-observe-retry-");
		const retryRecorder = createFetchRecorder([{ status: 503, headers: { "Retry-After": "5" } }]);
		const retryRuntime = new SnoObserveRuntime({
			env: retryTemp.env,
			cwd: retryTemp.dir,
			fetch: retryRecorder.fetch,
		});
		try {
			await retryRuntime.emitParsed(memoryWriteEvent("h_retry"));
			assert.deepEqual(await retryRuntime.flush(), {
				shipped: 0,
				terminal: 0,
				retryable: 1,
				retryAfterMs: 5_000,
			});
			assert.equal(retryRecorder.calls.length, 1);
			const retryStore = new BufferStore(retryTemp.env.SNO_BUFFER_PATH);
			try {
				const rows = retryStore.getAllRows();
				assert.equal(rows[0].attempts, 1);
				assert.equal(rows[0].shipped, 0);
				assert.equal(rows[1].attempts, 0);
			} finally {
				retryStore.close();
			}
		} finally {
			await retryRuntime.shutdown().catch(() => {});
			cleanupTempSnoEnv(retryTemp);
		}

		const chainTemp = createTempSnoEnv("sno-observe-chain-reject-");
		const chainRecorder = createFetchRecorder([
			202,
			{ status: 422, body: JSON.stringify({ error: "self_hash_mismatch" }) },
		]);
		const chainRuntime = new SnoObserveRuntime({
			env: chainTemp.env,
			cwd: chainTemp.dir,
			fetch: chainRecorder.fetch,
		});
		try {
			await chainRuntime.emitParsed(memoryWriteEvent("h_conflict"));
			assert.deepEqual(await chainRuntime.flush(), {
				shipped: 1,
				terminal: 1,
				retryable: 0,
			});
			const chainStore = new BufferStore(chainTemp.env.SNO_BUFFER_PATH);
			try {
				const rows = chainStore.getAllRows();
				const envelopes = rows.map((row) => decodeEnvelope(row.payload));
				assert.deepEqual(
					envelopes.map((envelope) => envelope.event_type),
					["agent.identify", "memory.write", "agent.identify"],
				);
				assert.deepEqual(
					rows.map((row) => row.shipped),
					[1, 0, 0],
				);
				assert.deepEqual(
					rows.map((row) => row.terminal),
					[0, 1, 0],
				);
				assert.deepEqual(
					envelopes.map((envelope) => envelope.chain_epoch),
					[0, 0, 1],
				);
				assert.deepEqual(
					envelopes.map((envelope) => envelope.seq),
					[0, 1, 0],
				);
				assert.equal(envelopes[2].hash_chain.prev, "GENESIS");
			} finally {
				chainStore.close();
			}
		} finally {
			await chainRuntime.shutdown().catch(() => {});
			cleanupTempSnoEnv(chainTemp);
		}
	});

	it("keeps off-period events local across consent transitions", async () => {
		const temp = createTempSnoEnv();
		const { calls, fetch } = createFetchRecorder();
		const runtime = new SnoObserveRuntime({
			env: temp.env,
			cwd: temp.dir,
			fetch,
		});
		try {
			const consentStore = new ConsentStore(temp.env);
			assert.equal(consentStore.get(), "metadata-only");
			assert.throws(() => parseConsentValue("metadata"), InvalidConsentError);

			await runtime.emitParsed(memoryWriteEvent("h_before"));
			await runtime.setConsent("off", "test off");
			const offEmit = await runtime.emitParsed(memoryWriteEvent("h_off"));
			assert.deepEqual(
				{ accepted: offEmit.accepted, reason: offEmit.reason },
				{ accepted: false, reason: "consent_off" },
			);
			assert.deepEqual(
				calls.map((call) => JSON.parse(call.body).event_type),
				["agent.identify", "memory.write", "consent.change"],
			);

			await runtime.setConsent("metadata-only", "test resume");
			await runtime.flush();
			const posted = calls.map((call) => JSON.parse(call.body));
			assert.deepEqual(
				posted.map((event) => event.event_type),
				["agent.identify", "memory.write", "consent.change", "agent.identify", "consent.change"],
			);
			assert.deepEqual(
				posted.map((event) => event.chain_epoch),
				[0, 0, 0, 2, 2],
			);
			assert.deepEqual(
				posted.filter((event) => event.seq === 0).map((event) => event.event_type),
				["agent.identify", "agent.identify"],
			);

			const store = new BufferStore(temp.env.SNO_BUFFER_PATH);
			try {
				const offRows = store
					.getAllRows()
					.filter((row) => decodeEnvelope(row.payload).consent_level === "off");
				assert.equal(
					offRows
						.filter((row) => decodeEnvelope(row.payload).event_type === "memory.write")
						.every((row) => row.shipped === 0 && row.terminal === 1),
					true,
				);
			} finally {
				store.close();
			}

			const noOpCalls = calls.length;
			assert.equal(await runtime.setConsent("metadata-only", "no-op"), "metadata-only");
			await runtime.flush();
			assert.equal(calls.length, noOpCalls);
		} finally {
			await runtime.shutdown().catch(() => {});
			cleanupTempSnoEnv(temp);
		}
	});

	it("does not let event consent override stored consent off", async () => {
		const temp = createTempSnoEnv();
		const { calls, fetch } = createFetchRecorder();
		const runtime = new SnoObserveRuntime({
			env: temp.env,
			cwd: temp.dir,
			fetch,
		});
		try {
			await runtime.setConsent("off", "stored off");
			const event = memoryWriteEvent("h_override");
			event.consentLevel = "full";
			const result = await runtime.emitParsed(event);
			await runtime.flush();

			assert.deepEqual(
				{ accepted: result.accepted, reason: result.reason },
				{ accepted: false, reason: "consent_off" },
			);
			assert.deepEqual(
				calls.map((call) => JSON.parse(call.body).event_type),
				["agent.identify", "consent.change"],
			);
		} finally {
			await runtime.shutdown().catch(() => {});
			cleanupTempSnoEnv(temp);
		}
	});

	it("does not let subscriber failures block emit or flush", async () => {
		const temp = createTempSnoEnv();
		const { calls, fetch } = createFetchRecorder();
		const runtime = new SnoObserveRuntime({
			env: temp.env,
			cwd: temp.dir,
			fetch,
		});
		const unsubscribe = runtime.subscribe(() => {
			throw new Error("subscriber failed");
		});
		try {
			const result = await runtime.emitParsed(memoryWriteEvent("h_subscriber_throw"));
			const flushed = await runtime.flush();

			assert.equal(result.accepted, true);
			assert.deepEqual(flushed, {
				shipped: 2,
				terminal: 0,
				retryable: 0,
			});
			assert.deepEqual(
				calls.map((call) => JSON.parse(call.body).event_type),
				["agent.identify", "memory.write"],
			);
		} finally {
			unsubscribe();
			await runtime.shutdown().catch(() => {});
			cleanupTempSnoEnv(temp);
		}
	});

	it("keeps sequential chains gap-free and reports every emit outcome to subscribers", async () => {
		const chainTemp = createTempSnoEnv("sno-observe-seq-");
		const store = new BufferStore(chainTemp.env.SNO_BUFFER_PATH);
		try {
			for (let index = 0; index < 100; index += 1) {
				store.append({
					eventId: `event-${index}`,
					eventType: index === 0 ? "agent.identify" : "session.start",
					lane: "memory",
					tsEdgeMs: 1730000000000 + index,
					consentLevel: "metadata-only",
					redacted: false,
					scope,
					payload: index === 0 ? validPayloads["agent.identify"] : validPayloads["session.start"],
					terminal: false,
				});
			}
			assert.deepEqual(
				store.getAllRows().map((row) => row.seq),
				Array.from({ length: 100 }, (_, index) => index),
			);
			assert.equal(store.verifyLocalChain(), true);
		} finally {
			store.close();
			cleanupTempSnoEnv(chainTemp);
		}

		const emitTemp = createTempSnoEnv("sno-observe-seq-emit-");
		new ConsentStore(emitTemp.env).write("off");
		const emitRuntime = new SnoObserveRuntime({
			env: emitTemp.env,
			cwd: emitTemp.dir,
			fetch: createFetchRecorder().fetch,
		});
		try {
			await emitRuntime.emitParsed(
				parseEventInput({
					event_id: testUuidV7(0),
					event_type: "agent.identify",
					lane: "memory",
					agent_id: "codex",
					payload: validPayloads["agent.identify"],
				}),
			);
			for (let index = 1; index < 100; index += 1) {
				await emitRuntime.emitParsed(
					parseEventInput({
						event_id: testUuidV7(index),
						event_type: "session.start",
						lane: "memory",
						agent_id: "codex",
						payload: validPayloads["session.start"],
					}),
				);
			}
			const emitStore = new BufferStore(emitTemp.env.SNO_BUFFER_PATH);
			try {
				assert.deepEqual(
					emitStore.getAllRows().map((row) => row.seq),
					Array.from({ length: 100 }, (_, index) => index),
				);
				assert.equal(emitStore.verifyLocalChain(), true);
			} finally {
				emitStore.close();
			}
		} finally {
			await emitRuntime.shutdown().catch(() => {});
			cleanupTempSnoEnv(emitTemp);
		}

		const temp = createTempSnoEnv("sno-observe-subscribe-");
		const { fetch } = createFetchRecorder();
		const runtime = new SnoObserveRuntime({
			env: temp.env,
			cwd: temp.dir,
			fetch,
		});
		const seen = [];
		const unsubscribe = runtime.subscribe((event) => seen.push(event));
		try {
			const sampledToolName = "read file";
			await runtime.emitParsed(memoryWriteEvent("h_sub_happy"));
			await runtime.setConsent("off", "subscribe off");
			await runtime.emitParsed(memoryWriteEvent("h_sub_off"));
			await runtime.setConsent("metadata-only", "subscribe resume");
			await runtime.emitParsed(
				parseEventInput({
					event_id: findUnsampledToolEventId(sampledToolName, temp.env),
					event_type: "tool.call",
					lane: "memory",
					agent_id: "codex",
					payload: {
						...validPayloads["tool.call"],
						tool_name: sampledToolName,
					},
				}),
			);
			assert.deepEqual(
				seen
					.filter((event) => event.eventType === "memory.write" || event.eventType === "tool.call")
					.map((event) => ({
						eventType: event.eventType,
						accepted: event.accepted,
						reason: event.reason,
					})),
				[
					{ eventType: "memory.write", accepted: true, reason: undefined },
					{ eventType: "memory.write", accepted: false, reason: "consent_off" },
					{ eventType: "tool.call", accepted: false, reason: "tool_unsampled" },
				],
			);
		} finally {
			unsubscribe();
			await runtime.shutdown().catch(() => {});
			cleanupTempSnoEnv(temp);
		}
	});

	it("registers anonymous machines, verifies audits with machine bearer auth, and exposes the public namespace", async () => {
		assert.deepEqual(Object.keys(publicModule), ["createSnoObserve", "snoObserve"]);
			assert.deepEqual(Object.keys(snoObserve), [
				"emit",
				"flush",
				"drain",
				"consent",
			"observe",
			"register",
			"claim",
			"audit",
			"doctor",
			"shouldSampleTool",
			"hashRedactedText",
			"subscribe",
			"shutdown",
		]);
		assert.deepEqual(Object.keys(snoObserve.consent), ["get", "set"]);
		assert.deepEqual(Object.keys(snoObserve.observe), ["pause", "resume", "export"]);
		assert.deepEqual(Object.keys(snoObserve.audit), ["verify"]);
		const isolatedObserve = publicModule.createSnoObserve();
		assert.notEqual(isolatedObserve, snoObserve);
		assert.deepEqual(Object.keys(isolatedObserve), Object.keys(snoObserve));
		await isolatedObserve.shutdown();

		const temp = createTempSnoEnv();
		try {
			const calls = [];
			const fetchImpl = async (url, init) => {
				calls.push({ url: String(url), init });
				const body = JSON.parse(String(init.body));
				return new Response(
					JSON.stringify({
						user_cuid: body.user_cuid,
						machine_uuid: body.machine_uuid,
						claimed: false,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			};
			const identity = bootstrapIdentity(temp.env);
			assert.deepEqual(
				await registerMachine(identity, {
					baseUrl: "https://sno.test",
					env: temp.env,
					fetch: fetchImpl,
				}),
				{
					registered: true,
					claimed: false,
					userCuid: identity.user_cuid,
					machineUuid: identity.machine_uuid,
				},
			);
			assert.deepEqual(
				calls.map((call) => call.url),
				["https://sno.test/api/v1/identity/register-machine"],
			);
			const body = JSON.parse(String(calls[0].init.body));
			assert.equal(body.machine_secret_hash, machineSecretHash(identity.machine_secret));
			assert.equal(String(calls[0].init.body).includes(identity.machine_secret), false);
		} finally {
			cleanupTempSnoEnv(temp);
		}

		const conflictTemp = createTempSnoEnv("sno-observe-conflict-");
		try {
			const identity = bootstrapIdentity(conflictTemp.env);
			await assert.rejects(
				() =>
					registerMachine(identity, {
						baseUrl: "https://sno.test",
						env: conflictTemp.env,
						fetch: async () =>
							new Response(JSON.stringify({ error: "machine_secret_mismatch" }), {
								status: 409,
								headers: { "Content-Type": "application/json" },
							}),
					}),
				/machine_secret_mismatch/u,
			);
		} finally {
			cleanupTempSnoEnv(conflictTemp);
		}

		const auditTemp = createTempSnoEnv("sno-observe-audit-");
		try {
			const identity = bootstrapIdentity(auditTemp.env);
			const auditCalls = [];
			const result = await verifyAuditEvent("event 1", {
				baseUrl: "https://sno.test",
				machineSecret: identity.machine_secret,
				fetch: async (url, init) => {
					auditCalls.push({ url: String(url), headers: init.headers });
					return new Response(JSON.stringify({ verified: true, anchor_id: "a_1" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				},
			});
			assert.deepEqual(result, { verified: true, anchor_id: "a_1" });
			assert.equal(auditCalls[0].url, "https://sno.test/api/v1/audit/verify?event_id=event%201");
			assert.equal(auditCalls[0].headers.Authorization, `Bearer ${identity.machine_secret}`);

			const falseResult = await verifyAuditEvent("event-2", {
				baseUrl: "https://sno.test",
				machineSecret: identity.machine_secret,
				fetch: async () =>
					new Response(JSON.stringify({ verified: false, gdpr_scrubbed: true }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
			});
			assert.deepEqual(falseResult, { verified: false, gdpr_scrubbed: true });
			await assert.rejects(
				() =>
					verifyAuditEvent("missing", {
						baseUrl: "https://sno.test",
						machineSecret: identity.machine_secret,
						fetch: async () =>
							new Response(JSON.stringify({ error: "not found" }), {
								status: 404,
							}),
					}),
				/event not found or not owned/u,
			);
		} finally {
			cleanupTempSnoEnv(auditTemp);
		}
	});

	it("reports doctor diagnostics without bootstrapping local state", () => {
		const temp = createTempSnoEnv("sno-observe-doctor-");
		try {
			const runtime = new SnoObserveRuntime({ env: temp.env });
			const report = runtime.doctor();

			assert.deepEqual(Object.keys(report), [
				"identity",
				"buffer",
				"consent",
				"last_ship",
				"lockfile",
			]);
			assert.equal(report.identity.status, "warn");
			assert.equal(report.buffer.status, "warn");
			assert.equal(report.consent.status, "ok");
			assert.equal(report.last_ship.detail, "last successful POST to https://sno.test: never");
			assert.equal(existsSync(temp.env.SNO_IDENTITY_PATH), false);
			assert.equal(existsSync(temp.env.SNO_BUFFER_PATH), false);
		} finally {
			cleanupTempSnoEnv(temp);
		}
	});
});

function createFixtureEnvelope(fixture) {
	return createEnvelope({
		eventId: fixture.envelope.event_id,
		eventType: fixture.envelope.event_type,
		lane: "memory",
		tsEdgeMs: fixture.envelope.ts_edge_ms,
		consentLevel: fixture.envelope.consent_level,
		redacted: fixture.envelope.redacted,
		chainEpoch: fixture.envelope.chain_epoch,
		seq: fixture.envelope.seq,
		scope: fixture.envelope.scope,
		hashChain: {
			prev: fixture.envelope.hash_chain.prev,
			self: fixture.expected_self_hash,
		},
		payload: fixture.envelope.payload,
	});
}

function memoryWriteEvent(keyHash) {
	return parseEventInput({
		event_type: "memory.write",
		lane: "memory",
		agent_id: "codex",
		scope: { note: "contact alice@example.com" },
		payload: {
			key_hash: keyHash,
			byte_len: 4,
			content_tokens: 1,
			tokens_method: "char_approximation",
		},
	});
}

function createTempSnoEnv(prefix = "sno-observe-") {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	return {
		dir,
		env: {
			SNO_PROFILE_DIR: dir,
			SNO_IDENTITY_PATH: join(dir, "identity.json"),
			SNO_BUFFER_PATH: join(dir, "buffer.db"),
			SNO_CONSENT_PATH: join(dir, "state", "consent.json"),
			SNO_OBSERVE_BASE_URL: "https://sno.test",
			HOME: dir,
		},
	};
}

function initGitRepo(dir, remote) {
	mkdirSync(dir);
	for (const args of [["init"], ["remote", "add", "origin", remote]]) {
		const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	}
}

function findUnsampledToolEventId(toolName, env) {
	for (let index = 0; index < 1000; index += 1) {
		const eventId = testUuidV7(index + 1000);
		if (!shouldSampleTool(eventId, toolName, 20, env)) {
			return eventId;
		}
	}
	throw new Error("unable to find unsampled event id");
}

function cleanupTempSnoEnv(temp) {
	rmSync(temp.dir, { recursive: true, force: true });
}

function createFetchRecorder(statuses = []) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		if (String(url).endsWith("/api/v1/identity/register-machine")) {
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
			return new Response(
				JSON.stringify({
					user_cuid: body.user_cuid,
					machine_uuid: body.machine_uuid,
					claimed: false,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		calls.push({
			url: String(url),
			init,
			body: typeof init?.body === "string" ? init.body : undefined,
			headers: headerRecord(init?.headers),
		});
		const statusSpec = statuses.shift() ?? 202;
		const status = typeof statusSpec === "number" ? statusSpec : statusSpec.status;
		const headers = {
			"Content-Type": "application/json",
			...(typeof statusSpec === "number" ? {} : (statusSpec.headers ?? {})),
		};
		const body =
			typeof statusSpec === "number" || statusSpec.body === undefined
				? JSON.stringify({ received: status === 200 || status === 202 ? 1 : 0 })
				: statusSpec.body;
		return new Response(body, {
			status,
			headers,
		});
	};
	return { calls, fetch: fetchImpl };
}

function headerRecord(headers) {
	if (headers === undefined) {
		return {};
	}
	if (headers instanceof Headers) {
		return Object.fromEntries(headers.entries());
	}
	if (Array.isArray(headers)) {
		return Object.fromEntries(headers);
	}
	return { ...headers };
}
