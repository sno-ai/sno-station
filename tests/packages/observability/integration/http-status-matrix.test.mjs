// HTTP status code matrix per `sno-ai-api-contract.md` §2.2 + tasks §24.3, §24.3a,
// §24.5 .. §24.24. Drives the SDK against a real node:http fixture server.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { BufferStore } from "../../../../packages/sno-observe/dist/internal/buffer-store.js";
import { bootstrapIdentity } from "../../../../packages/sno-observe/dist/internal/identity.js";
import { machineSecretHash } from "../../../../packages/sno-observe/dist/internal/machine-registration.js";
import { SnoObserveRuntime } from "../../../../packages/sno-observe/dist/internal/runtime.js";
import { parseEventInput } from "../../../../packages/sno-observe/dist/internal/schemas.js";
import { startMockServer } from "../fixtures/sno-ai-mock-server.mjs";

function testHash(index) {
	return index.toString(16).padStart(64, "0");
}

function tempEnv(baseUrl) {
	const dir = mkdtempSync(join(tmpdir(), "sno-observe-http-"));
	return {
		dir,
		env: {
			SNO_PROFILE_DIR: dir,
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
		lane: "memory",
		agent_id: "codex",
		payload: {
			key_hash: testHash(i),
			byte_len: 1,
			content_tokens: 1,
			tokens_method: "char_approximation",
		},
	});
}

function permanentGapDetails(identity, overrides = {}) {
	return {
		code: "chain_predecessor_not_ready",
		machine_uuid: identity.machine_uuid,
		agent_id: "codex",
		chain_epoch: 0,
		expected_seq: 1,
		received_seq: 2,
		latest_state: "committed",
		last_committed_seq: 0,
		chain_stall_ms: 300_001,
		...overrides,
	};
}

async function flushThirdRowAgainstGap(body) {
	let result;
	await withServerAndRuntime(async ({ server, runtime }) => {
		server.enqueue("/api/v1/events", { status: 202, body: { receipt_id: "r_id" } });
		server.enqueue("/api/v1/events", { status: 202, body: { receipt_id: "r_1" } });
		server.enqueue("/api/v1/events", { status: 409, body });
		await runtime.emitParsed(memoryEvent(1));
		await runtime.emitParsed(memoryEvent(2));
		result = await runtime.flush();
	});
	return result;
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

function registerMachineResponse(init) {
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

describe("HTTP status matrix (fixture server, node:http)", () => {
	it("202 with receipt_id -> advance, mark shipped (24.5 +ve)", async () => {
		await withServerAndRuntime(async ({ server, runtime, t }) => {
			server.enqueue("/api/v1/events", {
				status: 202,
				body: { receipt_id: "r_1" },
			});
			server.enqueue("/api/v1/events", {
				status: 202,
				body: { receipt_id: "r_2" },
			});
			await runtime.emitParsed(memoryEvent(1));
			const res = await runtime.flush();
			assert.equal(res.shipped, 2);
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				assert.equal(
					store.getAllRows().every((r) => r.shipped === 1),
					true,
				);
			} finally {
				store.close();
			}
		});
	});

	it("202 with receipt_id: null -> advance, mark shipped, NO retry (24.5)", async () => {
		await withServerAndRuntime(async ({ server, runtime, t }) => {
			// Per §2.3: three indistinguishable causes; SDK MUST advance, never retry.
			server.enqueue("/api/v1/events", {
				status: 202,
				body: { receipt_id: null },
			});
			server.enqueue("/api/v1/events", {
				status: 202,
				body: { receipt_id: null },
			});
			await runtime.emitParsed(memoryEvent(1));
			const res = await runtime.flush();
			assert.equal(res.shipped, 2);
			assert.equal(res.retryable, 0);
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				assert.equal(
					store.getAllRows().every((r) => r.shipped === 1),
					true,
				);
			} finally {
				store.close();
			}
		});
	});

	it("202 with malformed body still marks only the submitted row shipped", async () => {
		await withServerAndRuntime(async ({ server, runtime, t }) => {
			server.enqueue("/api/v1/events", { status: 202, body: "{" });
			server.enqueue("/api/v1/events", { status: 202, body: "{" });
			await runtime.emitParsed(memoryEvent(1));
			assert.deepEqual(await runtime.flush(), { shipped: 2, terminal: 0, retryable: 0 });
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				assert.equal(store.getAllRows().every((row) => row.shipped === 1), true);
			} finally {
				store.close();
			}
		});
	});

	it("200 unexpected event ingest status -> retryable, no advance", async () => {
		await withServerAndRuntime(async ({ server, runtime, t }) => {
			server.enqueue("/api/v1/events", { status: 200, body: { received: 1 } });
			await runtime.emitParsed(memoryEvent(1));
			const res = await runtime.flush();
			assert.equal(res.shipped, 0);
			assert.equal(res.terminal, 0);
			assert.equal(res.retryable, 1);
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

	it("event and registration POSTs reject redirects instead of replaying payloads", async () => {
		const t = tempEnv("https://sno.test");
		let eventCalls = 0;
		const runtime = new SnoObserveRuntime({
			env: t.env,
			cwd: t.dir,
			fetch: async (url, init) => {
				assert.equal(init.redirect, "error");
				if (String(url).endsWith("/api/v1/identity/register-machine")) {
					return registerMachineResponse(init);
				}
				eventCalls += 1;
				throw new TypeError("redirect mode is set to error");
			},
		});
		try {
			await runtime.emitParsed(memoryEvent(1));
			assert.equal((await runtime.flush()).retryable, 1);
			assert.equal(eventCalls, 1);
		} finally {
			await runtime.shutdown().catch(() => {});
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("301, 302, 307, and 308 cannot redirect registration or event payloads", async () => {
		for (const status of [301, 302, 307, 308]) {
			for (const path of ["/api/v1/identity/register-machine", "/api/v1/events"]) {
				const server = await startMockServer();
				const t = tempEnv(server.baseUrl);
				server.enqueue(path, {
					status,
					headers: { Location: `${server.baseUrl}/redirect-target` },
				});
				const runtime = new SnoObserveRuntime({ env: t.env, cwd: t.dir });
				try {
					await runtime.emitParsed(memoryEvent(1));
					assert.equal((await runtime.flush()).retryable, 1);
					assert.equal(server.calls.some((call) => call.url === "/redirect-target"), false);
				} finally {
					runtime.flushEngine?.dispose?.();
					runtime.store?.close?.();
					await server.stop();
					rmSync(t.dir, { recursive: true, force: true });
				}
			}
		}
	});

	it("machine_already_registered continues with an authenticated event POST", async () => {
		const t = tempEnv("https://sno.test");
		let eventCalls = 0;
		const runtime = new SnoObserveRuntime({
			env: t.env,
			cwd: t.dir,
			fetch: async (url, init) => {
				if (String(url).endsWith("/api/v1/identity/register-machine")) {
					return new Response(JSON.stringify({ error: "machine_already_registered" }), {
						status: 409,
					});
				}
				eventCalls += 1;
				assert.match(init.headers.Authorization, /^Bearer /u);
				return new Response(JSON.stringify({ receipt_id: "r" }), { status: 202 });
			},
		});
		try {
			await runtime.emitParsed(memoryEvent(1));
			assert.equal((await runtime.flush()).shipped, 2);
			assert.equal(eventCalls, 2);
		} finally {
			await runtime.shutdown().catch(() => {});
			rmSync(t.dir, { recursive: true, force: true });
		}
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
		it(`400 ${error} on agent.identify -> quarantine suffix without reseed`, async () => {
			await withServerAndRuntime(async ({ server, runtime, t }) => {
				server.enqueue("/api/v1/events", { status: 400, body: { error } });
				await runtime.emitParsed(memoryEvent(1));
				const res = await runtime.flush();
				assert.equal(res.terminal, 2);
				assert.equal(res.retryable, 0);
				const store = new BufferStore(t.env.SNO_BUFFER_PATH);
				try {
					const rows = store.getAllRows();
					assert.equal(rows[0].terminal, 1);
					assert.equal(rows[1].terminal, 1);
					const reseed = rows.find(
						(r) =>
							JSON.parse(r.payload.toString("utf8")).event_type === "agent.identify" &&
							r.chain_epoch === 1,
					);
					assert.equal(reseed, undefined);
				} finally {
					store.close();
				}
			});
		});
	}

	it("409 chain rejection on agent.identify does not create a reseed loop", async () => {
		await withServerAndRuntime(async ({ server, runtime, t }) => {
			server.enqueue("/api/v1/events", { status: 409, body: { code: "payload_conflict" } });
			await runtime.emitParsed(memoryEvent(1));
			assert.deepEqual(await runtime.flush(), { shipped: 0, terminal: 2, retryable: 0 });
			const rejected = await runtime.emitParsed(memoryEvent(2));
			assert.equal(rejected.accepted, false);
			assert.equal(rejected.reason, "chain_retired");
			await runtime.shutdown();
			const restarted = new SnoObserveRuntime({ env: t.env, cwd: t.dir });
			try {
				const afterRestart = await restarted.emitParsed(memoryEvent(3));
				assert.equal(afterRestart.accepted, false);
				assert.equal(afterRestart.reason, "chain_retired");
				assert.equal(restarted.doctor().buffer.status, "warn");
			} finally {
				await restarted.shutdown().catch(() => {});
			}
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				assert.equal(store.getAllRows().length, 2);
				assert.equal(store.countPending(), 0);
			} finally {
				store.close();
			}
		});
	});

	it("persisted reseed-required state recovers after a crash boundary", async () => {
		const server = await startMockServer();
		const t = tempEnv(server.baseUrl);
		const runtime = new SnoObserveRuntime({ env: t.env, cwd: t.dir });
		try {
			await runtime.emitParsed(memoryEvent(1));
			await runtime.emitParsed(memoryEvent(2));
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				const rejected = store.getAllRows()[1];
				store.quarantineEpochSuffix(
					rejected,
					422,
					"prev_hash_mismatch",
					"",
					"reseed_required",
				);
			} finally {
				store.close();
			}
			await runtime.shutdown();

			const restarted = new SnoObserveRuntime({ env: t.env, cwd: t.dir });
			try {
				const emitted = await restarted.emitParsed(memoryEvent(3));
				assert.equal(emitted.accepted, true);
				assert.equal(emitted.chainEpoch, 1);
				const check = new BufferStore(t.env.SNO_BUFFER_PATH);
				try {
					const newEpoch = check.getAllRows().filter((row) => row.chain_epoch === 1);
					assert.deepEqual(newEpoch.map((row) => row.seq), [0, 1]);
				} finally {
					check.close();
				}
			} finally {
				await restarted.shutdown().catch(() => {});
			}
		} finally {
			await runtime.shutdown().catch(() => {});
			await server.stop();
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("unexpected 4xx -> retryable, no quarantine", async () => {
		await withServerAndRuntime(async ({ server, runtime }) => {
			server.enqueue("/api/v1/events", { status: 404, body: { error: "not_found" } });
			await runtime.emitParsed(memoryEvent(1));
			const res = await runtime.flush();
			assert.equal(res.terminal, 0);
			assert.equal(res.retryable, 1);
		});
	});

	for (const status of [400, 403]) {
		it(`${status} with an unknown code remains retryable`, async () => {
			await withServerAndRuntime(async ({ server, runtime }) => {
				server.enqueue("/api/v1/events", { status, body: { error: "future_contract_code" } });
				await runtime.emitParsed(memoryEvent(1));
				const result = await runtime.flush();
				assert.equal(result.retryable, 1);
				assert.equal(result.terminal, 0);
			});
		});
	}

	it("400 after an accepted predecessor quarantines the broken suffix before reseed", async () => {
		await withServerAndRuntime(async ({ server, runtime, t }) => {
			server.enqueue("/api/v1/events", { status: 202, body: { ok: true } });
			server.enqueue("/api/v1/events", { status: 400, body: { error: "invalid_envelope" } });
			await runtime.emitParsed(memoryEvent(1));
			await runtime.emitParsed(memoryEvent(2));

			const res = await runtime.flush();
			assert.deepEqual(res, { shipped: 1, terminal: 2, retryable: 0 });

			server.enqueue("/api/v1/events", { status: 202, body: { ok: true } });
			server.enqueue("/api/v1/events", { status: 202, body: { ok: true } });
			await runtime.emitParsed(memoryEvent(3));
			const secondRes = await runtime.flush();
			assert.deepEqual(secondRes, { shipped: 2, terminal: 0, retryable: 0 });

			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				const rows = store.getAllRows();
				assert.equal(rows[1].terminal, 1);
				assert.equal(rows[2].terminal, 1);
				const reseed = rows.find(
					(r) =>
						JSON.parse(r.payload.toString("utf8")).event_type === "agent.identify" &&
						r.chain_epoch === 1,
				);
				assert.notEqual(reseed, undefined);
				assert.equal(reseed.shipped, 1);
			} finally {
				store.close();
			}
		});
	});

	it("401 -> retry path, no quarantine (24.13)", async () => {
		await withServerAndRuntime(async ({ server, runtime, t }) => {
			server.enqueue("/api/v1/events", {
				status: 401,
				body: { error: "unauthorized" },
			});
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

	it("403 identity_mismatch -> terminal quarantine, no retry", async () => {
		await withServerAndRuntime(async ({ server, runtime, t }) => {
			server.enqueue("/api/v1/events", {
				status: 403,
				body: { error: "identity_mismatch" },
			});
			await runtime.emitParsed(memoryEvent(1));
			const res = await runtime.flush();
			assert.equal(res.retryable, 0);
			assert.equal(res.terminal, 2);
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				const rows = store.getAllRows();
				assert.equal(rows[0].terminal, 1);
				assert.equal(rows[1].terminal, 1);
			} finally {
				store.close();
			}
		});
	});

	it("403 scope_user_mismatch -> terminal quarantine, no retry", async () => {
		await withServerAndRuntime(async ({ server, runtime, t }) => {
			server.enqueue("/api/v1/events", {
				status: 403,
				body: { error: "scope_user_mismatch" },
			});
			await runtime.emitParsed(memoryEvent(1));
			const res = await runtime.flush();
			assert.equal(res.retryable, 0);
			assert.equal(res.terminal, 2);
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				const rows = store.getAllRows();
				assert.equal(rows[0].terminal, 1);
				assert.equal(rows[1].terminal, 1);
			} finally {
				store.close();
			}
		});
	});

	it("409 payload_conflict -> quarantine + epoch bump + reseed (24.16)", async () => {
		await withServerAndRuntime(async ({ server, runtime, t }) => {
			// First call: agent.identify ships fine (202). Second: memory.write 409.
			server.enqueue("/api/v1/events", {
				status: 202,
				body: { receipt_id: "r_id" },
			});
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

	it("409 duplicate_event -> mark shipped without reseeding", async () => {
		await withServerAndRuntime(async ({ server, runtime, t }) => {
			server.enqueue("/api/v1/events", {
				status: 202,
				body: { receipt_id: "r_id" },
			});
			server.enqueue("/api/v1/events", {
				status: 409,
				body: { error: "duplicate_event" },
			});
			await runtime.emitParsed(memoryEvent(1));
			const res = await runtime.flush();
			assert.deepEqual(res, { shipped: 2, terminal: 0, retryable: 0 });
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				const rows = store.getAllRows();
				assert.equal(rows.length, 2);
				assert.equal(
					rows.every((r) => r.shipped === 1),
					true,
				);
				assert.equal(Math.max(...rows.map((r) => r.chain_epoch)), 0);
			} finally {
				store.close();
			}
		});
	});

	it("409 nested accepted-duplicate code marks the exact row shipped", async () => {
		await withServerAndRuntime(async ({ server, runtime, t }) => {
			server.enqueue("/api/v1/events", {
				status: 409,
				body: { error: { code: "event_already_accepted" } },
			});
			server.enqueue("/api/v1/events", {
				status: 424,
				body: { error: "dependency_failed", retryable: true },
			});
			await runtime.emitParsed(memoryEvent(1));
			const result = await runtime.flush();
			assert.equal(result.shipped, 1);
			assert.equal(result.retryable, 1);
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				const rows = store.getAllRows();
				assert.equal(rows[0].shipped, 1);
				assert.equal(rows[1].shipped, 0);
			} finally {
				store.close();
			}
		});
	});

	it("409 reason payload_conflict -> quarantine + epoch bump + reseed", async () => {
		await withServerAndRuntime(async ({ server, runtime, t }) => {
			server.enqueue("/api/v1/events", {
				status: 202,
				body: { receipt_id: "r_id" },
			});
			server.enqueue("/api/v1/events", {
				status: 409,
				body: { reason: "payload_conflict", detail: "payload conflicts with accepted event" },
			});
			await runtime.emitParsed(memoryEvent(1));
			const res = await runtime.flush();
			assert.equal(res.shipped, 1);
			assert.equal(res.terminal, 1);
			assert.equal(res.retryable, 0);
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				const rows = store.getAllRows();
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

	it("422 without explicit chain error -> retryable without reseed", async () => {
		await withServerAndRuntime(async ({ server, runtime, t }) => {
			server.enqueue("/api/v1/events", {
				status: 202,
				body: { receipt_id: "r_id" },
			});
			server.enqueue("/api/v1/events", {
				status: 422,
				body: { error: "temporarily_unknown" },
			});
			await runtime.emitParsed(memoryEvent(1));
			const res = await runtime.flush();
			assert.equal(res.shipped, 1);
			assert.equal(res.terminal, 0);
			assert.equal(res.retryable, 1);
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				const rows = store.getAllRows();
				assert.equal(rows[1].terminal, 0);
				assert.equal(Math.max(...rows.map((r) => r.chain_epoch)), 0);
			} finally {
				store.close();
			}
		});
	});

	it("422 reason prev_hash_mismatch -> quarantine suffix, reseed, no retry", async () => {
		await withServerAndRuntime(async ({ server, runtime, t }) => {
			server.enqueue("/api/v1/events", {
				status: 202,
				body: { receipt_id: "r_id" },
			});
			server.enqueue("/api/v1/events", {
				status: 422,
				body: { reason: "prev_hash_mismatch", detail: "previous hash does not match" },
			});
			await runtime.emitParsed(memoryEvent(1));
			await runtime.emitParsed(memoryEvent(2));
			const res = await runtime.flush();
			assert.deepEqual(res, { shipped: 1, terminal: 2, retryable: 0 });
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				const rows = store.getAllRows();
				const envelopes = rows.map((row) => JSON.parse(row.payload.toString("utf8")));
				assert.equal(rows[1].terminal, 1);
				assert.equal(rows[2].terminal, 1);
				assert.equal(
					envelopes.some(
						(envelope) => envelope.event_type === "agent.identify" && envelope.chain_epoch === 1,
					),
					true,
				);
			} finally {
				store.close();
			}
		});
	});

	it("422 chain rejection quarantines the rejected epoch suffix before reseed", async () => {
		await withServerAndRuntime(async ({ server, runtime, t }) => {
			server.enqueue("/api/v1/events", {
				status: 202,
				body: { receipt_id: "r_id" },
			});
			server.enqueue("/api/v1/events", {
				status: 422,
				body: { error: "prev_hash_mismatch" },
			});
			await runtime.emitParsed(memoryEvent(1));
			await runtime.emitParsed(memoryEvent(2));
			const res = await runtime.flush();
			assert.deepEqual(res, { shipped: 1, terminal: 2, retryable: 0 });
			assert.equal(server.calls.filter((call) => call.url === "/api/v1/events").length, 2);

			server.enqueue("/api/v1/events", {
				status: 202,
				body: { receipt_id: "r_reseed" },
			});
			server.enqueue("/api/v1/events", {
				status: 202,
				body: { receipt_id: "r_new" },
			});
			await runtime.emitParsed(memoryEvent(3));
			const secondRes = await runtime.flush();
			assert.deepEqual(secondRes, { shipped: 2, terminal: 0, retryable: 0 });

			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				const rows = store.getAllRows();
				const envelopes = rows.map((row) => JSON.parse(row.payload.toString("utf8")));
				const reseedRows = envelopes.filter(
					(envelope) => envelope.event_type === "agent.identify" && envelope.chain_epoch === 1,
				);
				assert.equal(reseedRows.length, 1);
				assert.equal(rows.length, 5);
				assert.equal(rows[1].terminal, 1);
				assert.equal(rows[2].terminal, 1);
				assert.equal(rows[3].shipped, 1);
				assert.equal(rows[4].shipped, 1);
			} finally {
				store.close();
			}
		});
	});

	const epoch422 = ["chain_seed_required", "prev_hash_mismatch", "self_hash_mismatch"];
	for (const error of epoch422) {
		it(`422 ${error} -> quarantine + epoch bump + reseed`, async () => {
			await withServerAndRuntime(async ({ server, runtime, t }) => {
				server.enqueue("/api/v1/events", {
					status: 202,
					body: { receipt_id: "r_id" },
				});
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
				body: {
					error: "Per-cuid quota exceeded",
					errorType: "RATE_LIMIT_EXCEEDED",
				},
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
				body: {
					errorType: "RATE_LIMIT_EXCEEDED",
					error: "Per-cuid quota exceeded",
				},
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
			server.enqueue("/api/v1/events", {
				status: 500,
				body: { error: "queue_unavailable" },
			});
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

	it("409 nested-only long-stalled missing predecessor -> quarantine suffix and reseed", async () => {
		await withServerAndRuntime(async ({ server, runtime, t }) => {
			const identity = bootstrapIdentity(t.env);
			server.enqueue("/api/v1/events", { status: 202, body: { receipt_id: "r_id" } });
			server.enqueue("/api/v1/events", { status: 202, body: { receipt_id: "r_1" } });
			server.enqueue("/api/v1/events", {
				status: 409,
				headers: { "Retry-After": "5" },
				body: { error: permanentGapDetails(identity) },
			});
			await runtime.emitParsed(memoryEvent(1));
			await runtime.emitParsed(memoryEvent(2));
			const res = await runtime.flush();

			assert.deepEqual(res, { shipped: 2, terminal: 1, retryable: 0 });
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				const rows = store.getAllRows();
				assert.equal(rows[0].shipped, 1);
				assert.equal(rows[1].shipped, 1);
				assert.equal(rows[2].terminal, 1);
				assert.notEqual(
					rows.find((row) => row.chain_epoch === 1 && row.seq === 0 && row.terminal === 0),
					undefined,
				);
				assert.equal(store.getQueueStats().quarantinedCount, 1);
				assert.equal(store.getQueueStats().latestQuarantineReason, "permanent_predecessor_gap");
			} finally {
				store.close();
			}
		});
	});

	it("409 top-level code and facts can prove a permanent predecessor gap", async () => {
		await withServerAndRuntime(async ({ server, runtime, t }) => {
			const identity = bootstrapIdentity(t.env);
			server.enqueue("/api/v1/events", { status: 202, body: { receipt_id: "r_id" } });
			server.enqueue("/api/v1/events", { status: 202, body: { receipt_id: "r_1" } });
			server.enqueue("/api/v1/events", {
				status: 409,
				body: permanentGapDetails(identity),
			});
			await runtime.emitParsed(memoryEvent(1));
			await runtime.emitParsed(memoryEvent(2));
			assert.deepEqual(await runtime.flush(), { shipped: 2, terminal: 1, retryable: 0 });
		});
	});

	it("409 can prove a permanent gap immediately after genesis", async () => {
		await withServerAndRuntime(async ({ server, runtime, t }) => {
			const identity = bootstrapIdentity(t.env);
			server.enqueue("/api/v1/events", { status: 202, body: { receipt_id: "r_id" } });
			server.enqueue("/api/v1/events", {
				status: 409,
				body: permanentGapDetails(identity, {
					expected_seq: 0,
					received_seq: 1,
					last_committed_seq: -1,
				}),
			});
			await runtime.emitParsed(memoryEvent(1));
			assert.deepEqual(await runtime.flush(), { shipped: 1, terminal: 1, retryable: 0 });
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				assert.notEqual(
					store
						.getAllRows()
						.find((row) => row.chain_epoch === 1 && row.seq === 0 && row.terminal === 0),
					undefined,
				);
			} finally {
				store.close();
			}
		});
	});

	const malformedBodies = [
		["empty body", ""],
		["invalid JSON", "{"],
		["truncated JSON", '{"error":{"code":"chain_predecessor_not_ready"'],
		["array", []],
		["null", null],
		["scalar", 17],
	];
	for (const [name, body] of malformedBodies) {
		it(`409 ${name} remains retryable without throwing`, async () => {
			const result = await flushThirdRowAgainstGap(body);
			assert.deepEqual(result, { shipped: 2, terminal: 0, retryable: 1, retryAfterMs: 5_000 });
		});
	}

	it("oversized response body is discarded and remains retryable", async () => {
		await withServerAndRuntime(async ({ server, runtime }) => {
			server.enqueue("/api/v1/events", {
				status: 400,
				body: JSON.stringify({ code: "invalid_envelope", padding: "x".repeat(128 * 1024) }),
			});
			await runtime.emitParsed(memoryEvent(1));
			const result = await runtime.flush();
			assert.equal(result.retryable, 1);
			assert.equal(result.terminal, 0);
		});
	});

	it("chunked oversized response is canceled at the read limit", async () => {
		const t = tempEnv("https://sno.test");
		let canceled = false;
		let chunksRead = 0;
		const runtime = new SnoObserveRuntime({
			env: t.env,
			cwd: t.dir,
			fetch: async (url, init) => {
				if (String(url).endsWith("/api/v1/identity/register-machine")) {
					const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
					return new Response(
						JSON.stringify({
							user_cuid: body.user_cuid,
							machine_uuid: body.machine_uuid,
							claimed: false,
						}),
						{ status: 200 },
					);
				}
				return new Response(
					new ReadableStream({
						pull(controller) {
							chunksRead += 1;
							controller.enqueue(new Uint8Array(32 * 1024));
						},
						cancel() {
							canceled = true;
						},
					}),
					{ status: 400 },
				);
			},
		});
		try {
			await runtime.emitParsed(memoryEvent(1));
			const result = await runtime.flush();
			assert.equal(result.retryable, 1);
			assert.equal(canceled, true);
			assert.equal(chunksRead >= 3 && chunksRead <= 4, true);
		} finally {
			await runtime.shutdown().catch(() => {});
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	const invalidGapFacts = [
		["missing expected sequence", { expected_seq: undefined }],
		["null expected sequence", { expected_seq: null }],
		["string expected sequence", { expected_seq: "1" }],
		["negative expected sequence", { expected_seq: -1 }],
		["fractional expected sequence", { expected_seq: 1.5 }],
		["unsafe expected sequence", { expected_seq: Number.MAX_SAFE_INTEGER + 1 }],
		["contradictory received sequence", { received_seq: 3 }],
		["contradictory committed sequence", { last_committed_seq: 1 }],
		["mismatched machine", { machine_uuid: "01900000-0000-7000-8000-000000000000" }],
		["mismatched agent", { agent_id: "openclaw" }],
		["mismatched epoch", { chain_epoch: 496491 }],
		["non-committed latest state", { latest_state: "pending" }],
		["recent stall", { chain_stall_ms: 299_999 }],
		["string stall", { chain_stall_ms: "300001" }],
	];
	for (const [name, overrides] of invalidGapFacts) {
		it(`409 ${name} cannot reset the chain`, async () => {
			await withServerAndRuntime(async ({ server, runtime, t }) => {
				const identity = bootstrapIdentity(t.env);
				server.enqueue("/api/v1/events", { status: 202, body: { receipt_id: "r_id" } });
				server.enqueue("/api/v1/events", { status: 202, body: { receipt_id: "r_1" } });
				server.enqueue("/api/v1/events", {
					status: 409,
					body: { error: permanentGapDetails(identity, overrides) },
				});
				await runtime.emitParsed(memoryEvent(1));
				await runtime.emitParsed(memoryEvent(2));
				const result = await runtime.flush();
				assert.equal(result.retryable, 1);
				assert.equal(result.terminal, 0);
				const store = new BufferStore(t.env.SNO_BUFFER_PATH);
				try {
					assert.equal(Math.max(...store.getAllRows().map((row) => row.chain_epoch)), 0);
				} finally {
					store.close();
				}
			});
		});
	}


	for (const codeField of ["code", "reason", "error_code"]) {
		it(`contradictory ${codeField} and nested error.code remain retryable`, async () => {
			await withServerAndRuntime(async ({ server, runtime, t }) => {
				const identity = bootstrapIdentity(t.env);
				server.enqueue("/api/v1/events", { status: 202, body: { receipt_id: "r_id" } });
				server.enqueue("/api/v1/events", { status: 202, body: { receipt_id: "r_1" } });
				server.enqueue("/api/v1/events", {
					status: 409,
					body: {
						[codeField]: "payload_conflict",
						error: permanentGapDetails(identity),
					},
				});
				await runtime.emitParsed(memoryEvent(1));
				await runtime.emitParsed(memoryEvent(2));
				const result = await runtime.flush();
				assert.equal(result.retryable, 1);
				assert.equal(result.terminal, 0);
			});
		});
	}

	it("contradictory string error and reason remain retryable", async () => {
		await withServerAndRuntime(async ({ server, runtime, t }) => {
			const identity = bootstrapIdentity(t.env);
			server.enqueue("/api/v1/events", { status: 202, body: { receipt_id: "r_id" } });
			server.enqueue("/api/v1/events", { status: 202, body: { receipt_id: "r_1" } });
			server.enqueue("/api/v1/events", {
				status: 409,
				body: {
					...permanentGapDetails(identity),
					reason: "chain_predecessor_not_ready",
					error: "payload_conflict",
				},
			});
			await runtime.emitParsed(memoryEvent(1));
			await runtime.emitParsed(memoryEvent(2));
			const result = await runtime.flush();
			assert.equal(result.retryable, 1);
			assert.equal(result.terminal, 0);
		});
	});

	it("terminal response logs omit the receiver body", async (testContext) => {
		const writes = [];
		const write = testContext.mock.method(process.stderr, "write", (chunk) => {
			writes.push(String(chunk));
			return true;
		});
		try {
			await withServerAndRuntime(async ({ server, runtime }) => {
				server.enqueue("/api/v1/events", {
					status: 400,
					body: { code: "invalid_envelope", detail: "full-content-secret" },
				});
				await runtime.emitParsed(memoryEvent(1));
				assert.equal((await runtime.flush()).terminal > 0, true);
			});
			assert.equal(writes.join("").includes("full-content-secret"), false);
		} finally {
			write.mock.restore();
		}
	});

	for (const status of [408, 424, 429, 500, 502, 599, 418]) {
		it(`${status} remains bounded-retryable`, async () => {
			await withServerAndRuntime(async ({ server, runtime }) => {
				server.enqueue("/api/v1/events", { status, body: { error: "hostile_response" } });
				await runtime.emitParsed(memoryEvent(1));
				const result = await runtime.flush();
				assert.equal(result.retryable, 1);
				assert.equal(result.terminal, 0);
			});
		});
	}

	it("malformed Retry-After does not throw or create a tight retry loop", async () => {
		await withServerAndRuntime(async ({ server, runtime }) => {
			server.enqueue("/api/v1/events", {
				status: 424,
				headers: { "Retry-After": "not-a-delay" },
				body: { error: "dependency_failed", retryable: true },
			});
			await runtime.emitParsed(memoryEvent(1));
			const result = await runtime.flush({ force: false });
			assert.equal(result.retryable, 1);
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(server.calls.filter((call) => call.url === "/api/v1/events").length, 1);
		});
	});

	it("unsafe Retry-After is capped to a bounded delay", async () => {
		await withServerAndRuntime(async ({ server, runtime }) => {
			server.enqueue("/api/v1/events", {
				status: 424,
				headers: { "Retry-After": "9999999999999999999" },
				body: { error: "dependency_failed", retryable: true },
			});
			await runtime.emitParsed(memoryEvent(1));
			const result = await runtime.flush();
			assert.equal(result.retryable, 1);
			assert.equal(result.retryAfterMs, 24 * 60 * 60 * 1_000);
		});
	});

	it("repeated poison-row retries are log-rate-limited by stable failure key", async () => {
		const writes = [];
		const originalWrite = process.stderr.write;
		let now = Date.now();
		const nowMock = mock.method(Date, "now", () => now);
		const randomMock = mock.method(Math, "random", () => 0);
		process.stderr.write = (chunk) => {
			writes.push(String(chunk));
			return true;
		};
		try {
			await withServerAndRuntime(async ({ server, runtime }) => {
				for (let index = 0; index < 8; index += 1) {
					server.enqueue("/api/v1/events", { status: 409, body: { error: "unknown_conflict" } });
				}
				await runtime.emitParsed(memoryEvent(1));
				for (let index = 0; index < 8; index += 1) {
					const result = await runtime.flush();
					assert.equal(result.retryable, 1);
					now += result.retryAfterMs;
				}
				assert.equal(server.calls.filter((call) => call.url === "/api/v1/events").length, 8);
			});
		} finally {
			process.stderr.write = originalWrite;
			nowMock.mock.restore();
			randomMock.mock.restore();
		}
		assert.equal(writes.filter((line) => line.includes("conflict response")).length, 1);
	});

	it("stderr failure cannot escape sender response handling", async () => {
		const originalWrite = process.stderr.write;
		process.stderr.write = () => {
			throw new Error("EPIPE");
		};
		try {
			await withServerAndRuntime(async ({ server, runtime }) => {
				server.enqueue("/api/v1/events", { status: 418, body: "{" });
				await runtime.emitParsed(memoryEvent(1));
				const result = await runtime.flush();
				assert.equal(result.retryable, 1);
			});
		} finally {
			process.stderr.write = originalWrite;
		}
	});

	it("timeout remains retryable and does not escape flush", async () => {
		const t = tempEnv("http://127.0.0.1:9");
		const runtime = new SnoObserveRuntime({
			env: t.env,
			cwd: t.dir,
			fetch: async () => {
				throw new DOMException("timed out", "TimeoutError");
			},
		});
		try {
			await runtime.emitParsed(memoryEvent(1));
			assert.equal((await runtime.flush()).retryable >= 1, true);
		} finally {
			await runtime.shutdown().catch(() => {});
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("attempt safeguard rejects new events explicitly without growing the queue", async () => {
		const t = tempEnv("http://127.0.0.1:9");
		const identity = bootstrapIdentity(t.env);
		const store = new BufferStore(t.env.SNO_BUFFER_PATH);
		try {
			const identify = store.append({
				eventId: "poison-identify",
				eventType: "agent.identify",
				lane: "memory",
				tsEdgeMs: Date.now(),
				consentLevel: "metadata-only",
				redacted: false,
				scope: {
					user_id: identity.user_cuid,
					machine_id: identity.machine_uuid,
					agent_id: "codex",
				},
				payload: {
					agent_id: "codex",
					machine_id: identity.machine_uuid,
					sdk_version: "0.1.0",
				},
				terminal: false,
			});
			for (let attempt = 0; attempt < 100; attempt += 1) {
				store.incrementAttempts(identify.rowid);
			}
		} finally {
			store.close();
		}
		const runtime = new SnoObserveRuntime({ env: t.env, cwd: t.dir });
			try {
				const result = await runtime.emitParsed(memoryEvent(1));
				assert.deepEqual(result, {
				accepted: false,
				eventId: result.eventId,
				reason: "buffer_safeguard",
				});
				const independent = await runtime.emitParsed({
					...memoryEvent(2),
					agentId: "openclaw",
				});
				assert.equal(independent.accepted, true);
				const check = new BufferStore(t.env.SNO_BUFFER_PATH);
				try {
					assert.equal(check.countAll(), 3);
			} finally {
				check.close();
			}
			const doctorDetail = runtime.doctor().buffer.detail;
				assert.match(doctorDetail, /queue_depth=3/u);
			assert.match(doctorDetail, /retry_count=100/u);
			assert.match(doctorDetail, /quarantined_count=0/u);
		} finally {
			await runtime.shutdown().catch(() => {});
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("409 mismatched long-stalled missing predecessor -> remains retryable", async () => {
		await withServerAndRuntime(async ({ server, runtime }) => {
			server.enqueue("/api/v1/events", {
				status: 409,
				body: {
					error: {
						code: "chain_predecessor_not_ready",
						machine_uuid: "01900000-0000-7000-8000-000000000000",
						agent_id: "openclaw",
						chain_epoch: 496491,
						expected_seq: 3400,
						received_seq: 3401,
						latest_state: "committed",
						last_committed_seq: 3399,
						chain_stall_ms: 300_001,
					},
				},
			});
			await runtime.emitParsed(memoryEvent(1));
			const res = await runtime.flush();

			assert.equal(res.retryable, 1);
			assert.equal(res.terminal, 0);
		});
	});

	it("409 recent missing predecessor -> remains retryable", async () => {
		await withServerAndRuntime(async ({ server, runtime }) => {
			server.enqueue("/api/v1/events", {
				status: 409,
				headers: { "Retry-After": "5" },
				body: {
					reason: "chain_predecessor_not_ready",
					error: {
						code: "chain_predecessor_not_ready",
						expected_seq: 3400,
						received_seq: 3401,
						latest_state: "committed",
						last_committed_seq: 3399,
						chain_stall_ms: 299_999,
					},
				},
			});
			await runtime.emitParsed(memoryEvent(1));
			const res = await runtime.flush();

			assert.equal(res.retryable, 1);
			assert.equal(res.terminal, 0);
			assert.equal(res.retryAfterMs, 5_000);
		});
	});

	it("network error (TCP reset) -> retryable, host process does not crash (24.24)", async () => {
		const t = tempEnv("http://127.0.0.1:9");
		const fetchReset = async () => {
			throw new Error("ECONNRESET");
		};
		const runtime = new SnoObserveRuntime({
			env: t.env,
			cwd: t.dir,
			fetch: fetchReset,
		});
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
			server.enqueue("/api/v1/events", {
				status: 202,
				body: { receipt_id: "r1" },
			});
			server.enqueue("/api/v1/events", {
				status: 202,
				body: { receipt_id: "r2" },
			});
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
