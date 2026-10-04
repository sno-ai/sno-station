// What each server answer does to the buffer, against a real node:http fixture server.
// Contract: 202 ships; a refusal (400, 403, 413, an unknown 409/422) never parks or deletes the row: the rows
// behind it travel first and it is sent last; a chain-position complaint moves the row itself to a fresh
// epoch; everything else waits with backoff. Nothing is ever stranded.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BufferStore, decodeEnvelope } from "../../../../packages/observability/dist/internal/buffer-store.js";
import { SnoObserveRuntime } from "../../../../packages/observability/dist/internal/runtime.js";
import { parseEventInput } from "../../../../packages/observability/dist/internal/schemas.js";
import { startMockServer } from "../fixtures/sno-ai-mock-server.mjs";
import { writeObserveSettings } from "../fixtures/temp-env.mjs";

function tempEnv(baseUrl) {
	const dir = mkdtempSync(join(tmpdir(), "sno-observe-http-"));
	writeObserveSettings(dir, { baseUrl });
	return {
		dir,
		env: {
			SNO_PROFILE_DIR: dir,
			SNO_IDENTITY_PATH: join(dir, "identity.json"),
			SNO_BUFFER_PATH: join(dir, "buffer.db"),
			SNO_CONSENT_PATH: join(dir, "state", "consent.json"),
			HOME: dir,
		},
	};
}

function memoryEvent(i) {
	return parseEventInput({
		event_type: "memory.write",
		lane: "memory",
		agent_id: "codex",
		payload: {
			key_hash: i.toString(16).padStart(64, "0"),
			byte_len: 1,
			content_tokens: 1,
			tokens_method: "char_approximation",
		},
	});
}

async function withServerAndRuntime(fn) {
	const server = await startMockServer();
	const t = tempEnv(server.baseUrl);
	const runtime = new SnoObserveRuntime({ env: t.env, cwd: t.dir });
	try {
		await fn({ server, t, runtime });
	} finally {
		await runtime.shutdown().catch(() => {});
		await server.stop();
		rmSync(t.dir, { recursive: true, force: true });
	}
}

function postedEvents(server) {
	return server.calls
		.filter((call) => call.url === "/api/v1/events")
		.map((call) => JSON.parse(call.body))
		.map((envelope) => `${envelope.event_type}@${envelope.chain_epoch}.${envelope.seq}`);
}

function rows(t) {
	const store = new BufferStore(t.env.SNO_BUFFER_PATH);
	try {
		return {
			pending: store.countPending(),
			quarantined: store.countQuarantined(),
			rows: store
				.getAllRows()
				.map((row) => `${decodeEnvelope(row.payload).event_type}@${row.chain_epoch}.${row.seq}:${row.shipped ? "shipped" : "pending"}`),
		};
	} finally {
		store.close();
	}
}

/** Two events emitted, seq 1 gets `answer`, everything else 202. */
async function flushTwoWithSecondAnswered(answer) {
	let outcome;
	await withServerAndRuntime(async ({ server, runtime, t }) => {
		server.enqueue("/api/v1/events", { status: 202, body: { receipt_id: "r_identify" } });
		server.enqueue("/api/v1/events", answer);
		await runtime.emitParsed(memoryEvent(1));
		await runtime.emitParsed(memoryEvent(2));
		const result = await runtime.flush();
		outcome = { result, posted: postedEvents(server), ...rows(t) };
	});
	return outcome;
}

describe("HTTP status matrix (fixture server, node:http)", () => {
	it("202 ships and marks the row", async () => {
		await withServerAndRuntime(async ({ runtime, t }) => {
			await runtime.emitParsed(memoryEvent(1));
			assert.deepEqual(await runtime.flush(), { shipped: 2, terminal: 0, retryable: 0 });
			assert.deepEqual(rows(t), {
				pending: 0,
				quarantined: 0,
				rows: ["agent.identify@0.0:shipped", "memory.write@0.1:shipped"],
			});
		});
	});

	for (const [label, answer] of [
		["400 with a known code", { status: 400, body: { error: "invalid_envelope" } }],
		["400 with a code the client has never seen", { status: 400, body: { error: "future_client_contract" } }],
		["400 with no code at all", { status: 400, body: "" }],
		["403 identity_mismatch", { status: 403, body: { error: "identity_mismatch" } }],
		["409 payload_conflict", { status: 409, body: { error: "payload_conflict" } }],
		["422 self_hash_mismatch", { status: 422, body: { error: "self_hash_mismatch" } }],
		["409 with an unknown code beside a sub-reason", { status: 409, body: { error: "future_code", reason: "chain_reset_required" } }],
		["413 body too large", { status: 413, body: { error: "event_body_too_large" } }],
	]) {
		it(`${label}: the row is sent again after the row behind it, nothing is parked`, async () => {
			const outcome = await flushTwoWithSecondAnswered(answer);
			assert.deepEqual(
				{ shipped: outcome.result.shipped, terminal: outcome.result.terminal, retryable: outcome.result.retryable },
				{ shipped: 4, terminal: 0, retryable: 0 },
			);
			// The refused row moves behind the row that was queued after it, in a fresh epoch.
			assert.deepEqual(outcome.posted, [
				"agent.identify@0.0",
				"memory.write@0.1",
				"agent.identify@1.0",
				"memory.write@1.1",
				"memory.write@1.2",
			]);
			assert.equal(outcome.pending, 0);
			assert.equal(outcome.quarantined, 0);
		});
	}

	for (const [label, answer] of [
		["422 prev_hash_mismatch", { status: 422, body: { error: "prev_hash_mismatch" } }],
		["422 chain_seed_required", { status: 422, body: { error: "chain_seed_required" } }],
		["409 chain_gap", { status: 409, body: { error: "chain_gap" } }],
		["409 with no code", { status: 409, body: "" }],
		[
			"409 predecessor the server has no record of",
			{
				status: 409,
				body: {
					reason: "chain_predecessor_not_ready",
					error: {
						code: "chain_predecessor_not_ready",
						chain_epoch: 0,
						expected_seq: 0,
						received_seq: 1,
						latest_seq: null,
						latest_state: null,
						last_committed_seq: null,
						chain_stall_ms: null,
					},
				},
			},
		],
		[
			"409 predecessor the server gave up waiting for",
			{
				status: 409,
				body: {
					code: "chain_predecessor_not_ready",
					chain_epoch: 0,
					expected_seq: 0,
					received_seq: 1,
					latest_state: "committed",
					last_committed_seq: -1,
					chain_stall_ms: 300_001,
				},
			},
		],
	]) {
		it(`${label}: the row itself moves to a fresh epoch and ships on the same flush`, async () => {
			const outcome = await flushTwoWithSecondAnswered(answer);
			assert.deepEqual(
				{ shipped: outcome.result.shipped, terminal: outcome.result.terminal, retryable: outcome.result.retryable },
				{ shipped: 4, terminal: 0, retryable: 0 },
			);
			assert.deepEqual(outcome.posted, [
				"agent.identify@0.0",
				"memory.write@0.1",
				"agent.identify@1.0",
				"memory.write@1.1",
				"memory.write@1.2",
			]);
			assert.equal(outcome.pending, 0);
			assert.equal(outcome.quarantined, 0);
		});
	}

	it("409 predecessor still in flight elsewhere: only that chain waits, then ships in place", async () => {
		await withServerAndRuntime(async ({ server, runtime, t }) => {
			server.enqueue("/api/v1/events", { status: 202, body: { receipt_id: "r_identify" } });
			server.enqueue("/api/v1/events", {
				status: 409,
				body: {
					code: "chain_predecessor_not_ready",
					chain_epoch: 0,
					expected_seq: 0,
					received_seq: 1,
					latest_state: "pending",
					chain_stall_ms: 10,
				},
			});
			await runtime.emitParsed(memoryEvent(1));
			const first = await runtime.flush();
			assert.deepEqual({ shipped: first.shipped, retryable: first.retryable }, { shipped: 1, retryable: 1 });
			assert.equal(rows(t).pending, 1);
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				assert.equal(store.getNextChainRetryDelay() > 0, true);
				assert.equal(store.getRetryDelay(), 0);
			} finally {
				store.close();
			}
		});
	});

	for (const [label, answer, minDelayMs] of [
		["401", { status: 401, body: { error: "unauthorized" } }, 5_000],
		["429 with Retry-After", { status: 429, headers: { "Retry-After": "60" }, body: { error: "rate" } }, 60_000],
		["500", { status: 500, body: { error: "queue_unavailable" } }, 5_000],
		["503 with Retry-After", { status: 503, headers: { "Retry-After": "5" }, body: "" }, 5_000],
		["200 (not an acceptance)", { status: 200, body: { received: 1 } }, 5_000],
	]) {
		it(`${label}: the row waits and is sent again later, never dropped`, async () => {
			await withServerAndRuntime(async ({ server, runtime, t }) => {
				server.enqueue("/api/v1/events", answer);
				await runtime.emitParsed(memoryEvent(1));
				const result = await runtime.flush();
				assert.deepEqual({ shipped: result.shipped, terminal: result.terminal, retryable: result.retryable }, { shipped: 0, terminal: 0, retryable: 1 });
				assert.equal(result.retryAfterMs >= minDelayMs, true, String(result.retryAfterMs));
				assert.equal(rows(t).pending, 2);
			});
		});
	}

	it("401 re-registers the machine on the next attempt and then ships", async () => {
		await withServerAndRuntime(async ({ server, runtime, t }) => {
			server.enqueue("/api/v1/events", { status: 401, body: { error: "unauthorized" } });
			await runtime.emitParsed(memoryEvent(1));
			await runtime.flush();
			const registrations = () =>
				server.calls.filter((call) => call.url === "/api/v1/identity/register-machine").length;
			assert.equal(registrations(), 1);
			await runtime.shutdown();
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				store.clearElapsedRetryDeadline(Date.now() + 60_000);
			} finally {
				store.close();
			}
			// A fresh process picks the buffer up and must register again before posting.
			const restarted = new SnoObserveRuntime({ env: t.env, cwd: t.dir });
			try {
				const result = await restarted.flush();
				assert.deepEqual({ shipped: result.shipped, retryable: result.retryable }, { shipped: 2, retryable: 0 });
				assert.equal(registrations(), 2);
			} finally {
				await restarted.shutdown();
			}
		});
	});

	it("a network failure waits with backoff and keeps the row", async () => {
		const server = await startMockServer();
		const t = tempEnv(server.baseUrl);
		await server.stop();
		const runtime = new SnoObserveRuntime({ env: t.env, cwd: t.dir });
		try {
			await runtime.emitParsed(memoryEvent(1));
			const result = await runtime.flush();
			assert.deepEqual({ shipped: result.shipped, terminal: result.terminal, retryable: result.retryable }, { shipped: 0, terminal: 0, retryable: 1 });
			assert.equal(rows(t).pending, 2);
		} finally {
			await runtime.shutdown().catch(() => {});
			rmSync(t.dir, { recursive: true, force: true });
		}
	});
});
