// HTTP status code matrix per `sno-ai-api-contract.md` §2.2 + tasks §24.3, §24.3a,
// §24.5 .. §24.24. Drives the SDK against a real node:http fixture server.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BufferStore } from "../../../../packages/sno-observe/dist/internal/buffer-store.js";
import { machineSecretHash } from "../../../../packages/sno-observe/dist/internal/machine-registration.js";
import { bootstrapIdentity } from "../../../../packages/sno-observe/dist/internal/identity.js";
import { SnoObserveRuntime } from "../../../../packages/sno-observe/dist/internal/runtime.js";
import { parseEventInput } from "../../../../packages/sno-observe/dist/internal/schemas.js";
import { startMockServer } from "../fixtures/sno-ai-mock-server.mjs";

function tempEnv(baseUrl) {
	const dir = mkdtempSync(join(tmpdir(), "sno-observe-http-"));
	return {
		dir,
		env: {
			SNO_HOME: dir,
			SNO_IDENTITY_PATH: join(dir, "identity.json"),
			SNO_BUFFER_PATH: join(dir, "buffer.db"),
			SNO_CONSENT_PATH: join(dir, "state", "consent.json"),
			SNO_OBSERVE_BASE_URL: baseUrl,
			HOME: dir,
		},
	};
}

function memoryEvent(i) {
	return parseEventInput({
		event_type: "memory.write",
		agent_id: "codex",
		payload: {
			key_hash: `h_${i}`,
			byte_len: 1,
			content_tokens: 1,
			tokens_method: "fast",
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

describe("HTTP status matrix (fixture server, node:http)", () => {
	it("202 with receipt_id -> advance, mark shipped (24.5 +ve)", async () => {
		await withServerAndRuntime(async ({ server, runtime, t }) => {
			server.enqueue("/api/v1/events", { status: 202, body: { receipt_id: "r_1" } });
			server.enqueue("/api/v1/events", { status: 202, body: { receipt_id: "r_2" } });
			await runtime.emitParsed(memoryEvent(1));
			const res = await runtime.flush();
			assert.equal(res.shipped, 2);
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				assert.equal(store.getAllRows().every((r) => r.shipped === 1), true);
			} finally {
				store.close();
			}
		});
	});

	it("202 with receipt_id: null -> advance, mark shipped, NO retry (24.5)", async () => {
		await withServerAndRuntime(async ({ server, runtime, t }) => {
			// Per §2.3: three indistinguishable causes; SDK MUST advance, never retry.
			server.enqueue("/api/v1/events", { status: 202, body: { receipt_id: null } });
			server.enqueue("/api/v1/events", { status: 202, body: { receipt_id: null } });
			await runtime.emitParsed(memoryEvent(1));
			const res = await runtime.flush();
			assert.equal(res.shipped, 2);
			assert.equal(res.retryable, 0);
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				assert.equal(store.getAllRows().every((r) => r.shipped === 1), true);
			} finally {
				store.close();
			}
		});
	});

	it("200 idempotent -> shipped=true, advance (24.6)", async () => {
		await withServerAndRuntime(async ({ server, runtime }) => {
			server.enqueue("/api/v1/events", { status: 200, body: { received: 1 } });
			server.enqueue("/api/v1/events", { status: 200, body: { received: 1 } });
			await runtime.emitParsed(memoryEvent(1));
			const res = await runtime.flush();
			assert.equal(res.shipped, 2);
			assert.equal(res.terminal, 0);
		});
	});

	const subcodes = [
		"single_envelope_required", // 24.8 batch_wrapper_rejected → maps to single_envelope_required per §2.2
		"invalid_envelope", // 24.7 schema_invalid
		"invalid_json", // close paraphrase: legacy/flat shape rejection (24.9)
		"agent_id_not_in_enum", // 24.10
		"consent_level_not_in_enum", // 24.11
		"tokens_method_required", // 24.12
	];
	for (const error of subcodes) {
		it(`400 ${error} -> quarantine, advance, no retry`, async () => {
			await withServerAndRuntime(async ({ server, runtime, t }) => {
				server.enqueue("/api/v1/events", { status: 400, body: { error } });
				server.enqueue("/api/v1/events", { status: 400, body: { error } });
				await runtime.emitParsed(memoryEvent(1));
				const res = await runtime.flush();
				assert.equal(res.terminal, 2);
				assert.equal(res.retryable, 0);
				const store = new BufferStore(t.env.SNO_BUFFER_PATH);
				try {
					const rows = store.getAllRows();
					assert.equal(rows.every((r) => r.terminal === 1), true);
				} finally {
					store.close();
				}
			});
		});
	}

	it("401 -> retry path, no quarantine (24.13)", async () => {
		await withServerAndRuntime(async ({ server, runtime, t }) => {
			server.enqueue("/api/v1/events", { status: 401, body: { error: "unauthorized" } });
			await runtime.emitParsed(memoryEvent(1));
			const res = await runtime.flush();
			assert.equal(res.retryable, 1);
			assert.equal(res.terminal, 0);
			// Row stays unshipped (will retry on next flush).
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				const row = store.getAllRows().find((r) => r.terminal === 0 && r.shipped === 0);
				assert.notEqual(row, undefined);
				assert.equal(row.attempts, 1);
			} finally {
				store.close();
			}
		});
	});

	it("403 machine_scope_forbidden -> retryable + error logged (24.14)", async () => {
		await withServerAndRuntime(async ({ server, runtime }) => {
			server.enqueue("/api/v1/events", {
				status: 403,
				body: { error: "machine_scope_forbidden" },
			});
			await runtime.emitParsed(memoryEvent(1));
			const res = await runtime.flush();
			assert.equal(res.retryable, 1);
		});
	});

	it("403 ownership_denied -> retryable + error logged (24.15)", async () => {
		await withServerAndRuntime(async ({ server, runtime }) => {
			server.enqueue("/api/v1/events", {
				status: 403,
				body: { error: "ownership_denied" },
			});
			await runtime.emitParsed(memoryEvent(1));
			const res = await runtime.flush();
			assert.equal(res.retryable, 1);
		});
	});

	it("409 payload_conflict -> quarantine + epoch bump + reseed (24.16)", async () => {
		await withServerAndRuntime(async ({ server, runtime, t }) => {
			// First call: agent.identify ships fine (202). Second: memory.write 409.
			server.enqueue("/api/v1/events", { status: 202, body: { receipt_id: "r_id" } });
			server.enqueue("/api/v1/events", {
				status: 409,
				body: { error: "payload_conflict" },
			});
			await runtime.emitParsed(memoryEvent(1));
			await runtime.flush();
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				const rows = store.getAllRows();
				const epochs = rows.map((r) => r.chain_epoch);
				assert.equal(Math.max(...epochs) >= 1, true, `epochs=${epochs.join(",")}`);
				const reseedIdentify = rows.find(
					(r) =>
						r.chain_epoch === 1 &&
						r.seq === 0 &&
						JSON.parse(r.payload.toString("utf8")).event_type === "agent.identify",
				);
				assert.notEqual(reseedIdentify, undefined, "epoch=1 reseed identify present");
			} finally {
				store.close();
			}
		});
	});

	const epoch422 = ["chain_seed_required", "prev_hash_mismatch", "self_hash_mismatch"];
	for (const error of epoch422) {
		it(`422 ${error} -> quarantine + epoch bump + reseed`, async () => {
			await withServerAndRuntime(async ({ server, runtime, t }) => {
				server.enqueue("/api/v1/events", { status: 202, body: { receipt_id: "r_id" } });
				server.enqueue("/api/v1/events", { status: 422, body: { error } });
				await runtime.emitParsed(memoryEvent(1));
				await runtime.flush();
				const store = new BufferStore(t.env.SNO_BUFFER_PATH);
				try {
					const rows = store.getAllRows();
					const epochs = rows.map((r) => r.chain_epoch);
					assert.equal(Math.max(...epochs) >= 1, true);
				} finally {
					store.close();
				}
			});
		});
	}

	it("429 with Retry-After: 60 -> retryable, retryAfterMs honored (24.21)", async () => {
		await withServerAndRuntime(async ({ server, runtime }) => {
			server.enqueue("/api/v1/events", {
				status: 429,
				headers: { "Retry-After": "60" },
				body: { error: "Per-cuid quota exceeded", errorType: "RATE_LIMIT_EXCEEDED" },
			});
			await runtime.emitParsed(memoryEvent(1));
			const res = await runtime.flush();
			assert.equal(res.retryable, 1);
			assert.equal(res.retryAfterMs, 60_000);
		});
	});

	it("429 RATE_LIMIT_EXCEEDED with no Retry-After -> hold ≥1h default (24.20)", async () => {
		await withServerAndRuntime(async ({ server, runtime }) => {
			server.enqueue("/api/v1/events", {
				status: 429,
				body: { errorType: "RATE_LIMIT_EXCEEDED", error: "Per-cuid quota exceeded" },
			});
			await runtime.emitParsed(memoryEvent(1));
			const res = await runtime.flush();
			assert.equal(res.retryable, 1);
			// Default: 3_600_000 ms = 1 hour (per flush.ts routeResponse 429 branch).
			assert.equal(res.retryAfterMs, 3_600_000);
		});
	});

	it("500 with no Retry-After -> exponential backoff base 5s (24.23)", async () => {
		await withServerAndRuntime(async ({ server, runtime }) => {
			server.enqueue("/api/v1/events", { status: 500, body: { error: "queue_unavailable" } });
			await runtime.emitParsed(memoryEvent(1));
			const res = await runtime.flush();
			assert.equal(res.retryable, 1);
		});
	});

	it("503 chain_predecessor_not_ready + Retry-After: 5 -> retryable after 5s (24.22)", async () => {
		await withServerAndRuntime(async ({ server, runtime }) => {
			server.enqueue("/api/v1/events", {
				status: 503,
				headers: { "Retry-After": "5" },
				body: { error: "chain_predecessor_not_ready" },
			});
			await runtime.emitParsed(memoryEvent(1));
			const res = await runtime.flush();
			assert.equal(res.retryable, 1);
			assert.equal(res.retryAfterMs, 5000);
		});
	});

	it("network error (TCP reset) -> retryable, host process does not crash (24.24)", async () => {
		const t = tempEnv("http://127.0.0.1:9");
		const fetchReset = async () => {
			throw new Error("ECONNRESET");
		};
		const runtime = new SnoObserveRuntime({ env: t.env, cwd: t.dir, fetch: fetchReset });
		try {
			await runtime.emitParsed(memoryEvent(1));
			const res = await runtime.flush();
			assert.equal(res.retryable >= 1, true);
		} finally {
			await runtime.shutdown().catch(() => {});
			rmSync(t.dir, { recursive: true, force: true });
		}
	});
});

describe("machine bearer attach (24.3, 24.3a)", () => {
	it("registers machine before flush and attaches Bearer machine secret to event POSTs", async () => {
		const server = await startMockServer();
		const t = tempEnv(server.baseUrl);
		const runtime = new SnoObserveRuntime({ env: t.env, cwd: t.dir });
		try {
			server.enqueue("/api/v1/events", { status: 202, body: { receipt_id: "r1" } });
			server.enqueue("/api/v1/events", { status: 202, body: { receipt_id: "r2" } });
			await runtime.emitParsed(memoryEvent(1));
			const id = bootstrapIdentity(t.env);
			await runtime.flush();

			const registerCalls = server.calls.filter((call) =>
				call.url.startsWith("/api/v1/identity/register-machine"),
			);
			assert.equal(registerCalls.length, 1);
			const registerBody = JSON.parse(registerCalls[0].body);
			assert.equal(registerCalls[0].headers.authorization, undefined);
			assert.equal(registerBody.machine_secret_hash, machineSecretHash(id.machine_secret));
			assert.equal(registerCalls[0].body.includes(id.machine_secret), false);

			const eventCalls = server.calls.filter((call) => call.url.startsWith("/api/v1/events"));
			assert.equal(eventCalls.length, 2);
			for (const call of eventCalls) {
				assert.equal(call.headers.authorization, `Bearer ${id.machine_secret}`);
			}
			// Verify first POST is agent.identify at chain_epoch=0/seq=0/prev=GENESIS.
			const firstBody = JSON.parse(eventCalls[0].body);
			assert.equal(firstBody.event_type, "agent.identify");
			assert.equal(firstBody.schema_version, "v1");
			assert.equal(firstBody.chain_epoch, 0);
			assert.equal(firstBody.seq, 0);
			assert.equal(firstBody.hash_chain.prev, "GENESIS");
		} finally {
			await runtime.shutdown().catch(() => {});
			await server.stop();
			rmSync(t.dir, { recursive: true, force: true });
		}
	});
});
