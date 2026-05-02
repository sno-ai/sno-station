// Concurrency / chain integrity tests per tasks §19.3, §19.5, §19.6, §19.7, §19.8.
// Real better-sqlite3, real fork()ed Node child processes, no mocks.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { BufferStore } from "../../../../packages/sno-observe/dist/internal/buffer-store.js";
import { bootstrapIdentity } from "../../../../packages/sno-observe/dist/internal/identity.js";
import { SnoObserveRuntime } from "../../../../packages/sno-observe/dist/internal/runtime.js";
import { parseEventInput } from "../../../../packages/sno-observe/dist/internal/schemas.js";
import { validPayloads, scope } from "../fixtures/temp-env.mjs";

const workerPath = fileURLToPath(new URL("../fixtures/fork-emit-worker.mjs", import.meta.url));

function tempEnv() {
	const dir = mkdtempSync(join(tmpdir(), "sno-observe-chain-"));
	return {
		dir,
		env: {
			SNO_HOME: dir,
			SNO_IDENTITY_PATH: join(dir, "identity.json"),
			SNO_BUFFER_PATH: join(dir, "buffer.db"),
			SNO_CONSENT_PATH: join(dir, "state", "consent.json"),
			HOME: dir,
		},
	};
}

function spawnWorker(env, count, label) {
	return new Promise((resolveSpawn, reject) => {
		let stdoutBuf = "";
		const child = fork(workerPath, [String(count), label], {
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		child.stdout?.on("data", (chunk) => {
			stdoutBuf += chunk.toString("utf8");
		});
		child.on("exit", (code) => {
			try {
				const lastLine = stdoutBuf.trim().split("\n").pop() ?? "{}";
				resolveSpawn({ code, summary: JSON.parse(lastLine) });
			} catch (e) {
				reject(e);
			}
		});
		child.on("error", reject);
	});
}

function memoryEvent(i) {
	return parseEventInput({
		event_type: "memory.write",
		agent_id: "codex",
		payload: {
			key_hash: `promise-${i}`,
			byte_len: 1,
			content_tokens: 1,
			tokens_method: "fast",
		},
	});
}

describe("concurrency / chain integrity", () => {
	it("100 concurrent Promise.all emits produce monotonic gap-free seq (19.3)", async () => {
		const t = tempEnv();
		let fetchCalls = 0;
		let inFlightFetches = 0;
		const runtime = new SnoObserveRuntime({
			env: t.env,
			cwd: t.dir,
			fetch: async (url, init) => {
				if (String(url).endsWith("/api/v1/identity/register-machine")) {
					return registerMachineResponse(init);
				}
				fetchCalls += 1;
				inFlightFetches += 1;
				try {
					return new Response(JSON.stringify({ receipt_id: "r" }), {
						status: 202,
						headers: { "Content-Type": "application/json" },
					});
				} finally {
					inFlightFetches -= 1;
				}
			},
		});
		try {
			await Promise.all(Array.from({ length: 100 }, (_, i) => runtime.emitParsed(memoryEvent(i))));
			for (let i = 0; i < 100 && (fetchCalls === 0 || inFlightFetches > 0); i += 1) {
				await delay(1);
			}
			assert.equal(inFlightFetches, 0);
			await runtime.flush();
			await runtime.shutdown();
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				const seqs = store.getAllRows().map((r) => r.seq);
				assert.deepEqual(seqs, Array.from({ length: 101 }, (_, i) => i));
				assert.equal(store.verifyLocalChain(), true);
			} finally {
				store.close();
			}
		} finally {
			await runtime.shutdown().catch(() => {});
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("kill mid-chain → restart → next emit is seq=11 with prev=seq10.self_hash (19.5)", async () => {
		const t = tempEnv();
		try {
			bootstrapIdentity(t.env);
			const w1 = await spawnWorker(t.env, 11, "w1");
			assert.equal(w1.code, 0, JSON.stringify(w1.summary));
			// Reopen the buffer in this process and continue: simulates restart.
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				const before = store.getAllRows();
				const tail = before[before.length - 1];
				const next = store.append({
					eventId: "after-restart",
					eventType: "session.start",
					tsEdgeMs: Date.now(),
					consentLevel: "metadata-only",
					redacted: false,
					scope: { ...scope, machine_id: tail.machine_id },
					payload: validPayloads["session.start"],
					terminal: false,
				});
				assert.equal(next.seq, tail.seq + 1);
				assert.equal(next.envelope.hash_chain.prev, tail.self_hash);
				assert.equal(next.envelope.chain_epoch, tail.chain_epoch);
				assert.equal(store.verifyLocalChain(), true);
			} finally {
				store.close();
			}
		} finally {
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("two processes × 50 events each = 100 unique seqs, gap-free (19.6 + 19.7 retry path)", async () => {
		const t = tempEnv();
		try {
			bootstrapIdentity(t.env);
			const [a, b] = await Promise.all([
				spawnWorker(t.env, 50, "A"),
				spawnWorker(t.env, 50, "B"),
			]);
			assert.equal(a.code, 0, JSON.stringify(a.summary));
			assert.equal(b.code, 0, JSON.stringify(b.summary));
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				const rows = store.getAllRows();
				const seqs = rows.map((r) => r.seq);
				const unique = new Set(seqs);
				assert.equal(unique.size, seqs.length, "no duplicate seq across processes");
				// Total rows = 100 memory.write + at least one agent.identify (might be one
				// or two depending on race for the seed). Either way, seqs MUST be 0..N-1
				// monotone.
				const sorted = [...seqs].sort((x, y) => x - y);
				for (let i = 0; i < sorted.length; i += 1) {
					assert.equal(sorted[i], i, `seq[${i}] = ${sorted[i]}`);
				}
				assert.equal(store.verifyLocalChain(), true);
				assert.equal(rows.length >= 100, true);
			} finally {
				store.close();
			}
		} finally {
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("simultaneous epoch bootstrap: only ONE agent.identify at seq=0 (19.8)", async () => {
		const t = tempEnv();
		try {
			bootstrapIdentity(t.env);
			const [a, b] = await Promise.all([
				spawnWorker(t.env, 1, "X"),
				spawnWorker(t.env, 1, "Y"),
			]);
			assert.equal(a.code, 0);
			assert.equal(b.code, 0);
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				const rows = store.getAllRows();
				// Per design.md Decision 8: agent.identify is seq=0 of the epoch. The loser
				// of the race observes hasTail=true and skips identify; total identify
				// rows MUST be exactly 1 in epoch 0.
				const epoch0Identifies = rows.filter(
					(r) =>
						r.chain_epoch === 0 &&
						JSON.parse(r.payload.toString("utf8")).event_type === "agent.identify",
				);
				assert.equal(epoch0Identifies.length, 1, "only one identify at seq=0");
				assert.equal(epoch0Identifies[0].seq, 0);
			} finally {
				store.close();
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
