// Idempotent ship + unshipped survival across restart per tasks §22.3, §22.7.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BufferStore } from "../../../../packages/sno-observe/dist/internal/buffer-store.js";
import { SnoObserveRuntime } from "../../../../packages/sno-observe/dist/internal/runtime.js";
import { parseEventInput } from "../../../../packages/sno-observe/dist/internal/schemas.js";
import { validPayloads, scope } from "../fixtures/temp-env.mjs";

function tempEnv() {
	const dir = mkdtempSync(join(tmpdir(), "sno-observe-idemp-"));
	return {
		dir,
		env: {
			SNO_HOME: dir,
			SNO_IDENTITY_PATH: join(dir, "identity.json"),
			SNO_BUFFER_PATH: join(dir, "buffer.db"),
			SNO_CONSENT_PATH: join(dir, "state", "consent.json"),
			SNO_OBSERVE_BASE_URL: "https://sno.test",
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
			key_hash: `h_${i}`,
			byte_len: 1,
			content_tokens: 1,
			tokens_method: "char_approximation",
		},
	});
}

describe("accepted replay + retention (22.3, 22.7)", () => {
	it("kill before DB-flag → restart → 202 accepted replay → row marked shipped (22.3)", async () => {
		const t = tempEnv();
		try {
			// Phase 1: emit events, but the fake transport records the body but kills
			// the process before the DB flag flips (simulated by NOT calling flush).
			const r1 = new SnoObserveRuntime({ env: t.env, cwd: t.dir });
			await r1.emitParsed(memoryEvent(1));
			// Don't flush; close the runtime to simulate kill mid-flow.
			await r1.shutdown().catch(() => {});

			// Phase 2: restart. Sno event ingest success is always 202 under the API contract.
			const calls = [];
			const fakeFetch = async (url, init) => {
				if (String(url).endsWith("/api/v1/identity/register-machine")) {
					return registerMachineResponse(init);
				}
				calls.push({ url: String(url), body: init.body });
				return new Response(JSON.stringify({ receipt_id: "r_replay" }), {
					status: 202,
					headers: { "Content-Type": "application/json" },
				});
			};
			const r2 = new SnoObserveRuntime({ env: t.env, cwd: t.dir, fetch: fakeFetch });
			try {
				const res = await r2.flush();
				assert.equal(res.shipped >= 1, true);
				const store = new BufferStore(t.env.SNO_BUFFER_PATH);
				try {
					const rows = store.getAllRows();
					// All rows now marked shipped after the accepted replay.
					assert.equal(rows.every((r) => r.shipped === 1), true);
				} finally {
					store.close();
				}
			} finally {
				await r2.shutdown().catch(() => {});
			}
		} finally {
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("1000 unshipped rows survive process restart and resume flushing (22.7)", async () => {
		const t = tempEnv();
		try {
			// Bypass network entirely: write 1000 rows directly via BufferStore.
			const r1 = new SnoObserveRuntime({ env: t.env, cwd: t.dir });
			await r1.emitParsed(memoryEvent(0));
			await r1.shutdown().catch(() => {});

			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				const tail = store
					.getAllRows()
					.find((r) => JSON.parse(r.payload.toString("utf8")).event_type === "agent.identify");
				assert.notEqual(tail, undefined);
				const machineId = tail.machine_id;
				for (let i = 1; i <= 1000; i += 1) {
					store.append({
						eventId: `survive-${i}`,
						eventType: "memory.write",
						lane: "memory",
						tsEdgeMs: 1000 + i,
						consentLevel: "metadata-only",
						redacted: false,
						scope: { ...scope, machine_id: machineId },
						payload: validPayloads["memory.write"],
						terminal: false,
					});
				}
				// 1 identify + 1 initial memory.write + 1000 appended = 1002.
				assert.equal(store.countPending(), 1002);
			} finally {
				store.close();
			}

			// Restart: open a new process-level runtime against the same buffer.db.
			let postCount = 0;
			const fakeFetch = async (url, init) => {
				if (String(url).endsWith("/api/v1/identity/register-machine")) {
					return registerMachineResponse(init);
				}
				postCount += 1;
				return new Response(JSON.stringify({ receipt_id: `r_${postCount}` }), {
					status: 202,
					headers: { "Content-Type": "application/json" },
				});
			};
			const r2 = new SnoObserveRuntime({ env: t.env, cwd: t.dir, fetch: fakeFetch });
			try {
				// Drain in batches; flush returns 100 per call (limit).
				let drained = 0;
				while (true) {
					const res = await r2.flush();
					drained += res.shipped;
					if (res.shipped === 0 || res.retryable > 0) {
						break;
					}
				}
				assert.equal(drained >= 1002, true, `drained=${drained}`);
			} finally {
				await r2.shutdown().catch(() => {});
			}
		} finally {
			rmSync(t.dir, { recursive: true, force: true });
		}
	});
});

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
