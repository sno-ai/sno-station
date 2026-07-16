// Idempotent ship + unshipped survival across restart per tasks §22.3, §22.7.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BufferStore } from "../../../../packages/sno-observe/dist/internal/buffer-store.js";
import { SnoObserveRuntime } from "../../../../packages/sno-observe/dist/internal/runtime.js";
import { parseEventInput } from "../../../../packages/sno-observe/dist/internal/schemas.js";
import { validPayloads, scope } from "../fixtures/temp-env.mjs";

const bufferStoreModuleUrl = new URL(
	"../../../../packages/sno-observe/dist/internal/buffer-store.js",
	import.meta.url,
).href;

function testHash(index) {
	return index.toString(16).padStart(64, "0");
}

function tempEnv() {
	const dir = mkdtempSync(join(tmpdir(), "sno-observe-idemp-"));
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

describe("accepted replay + retention (22.3, 22.7)", () => {
	it("kill before DB-flag → restart → 202 accepted replay → row marked shipped (22.3)", async () => {
		const t = tempEnv();
		try {
			const acceptedBodies = [];
			const r1 = new SnoObserveRuntime({
				env: t.env,
				cwd: t.dir,
				fetch: async (url, init) => {
					if (String(url).endsWith("/api/v1/identity/register-machine")) {
						return registerMachineResponse(init);
					}
					acceptedBodies.push(String(init.body));
					throw new Error("connection reset after receiver commit");
				},
			});
			await r1.emitParsed(memoryEvent(1));
			assert.equal((await r1.flush()).retryable, 1);
			assert.equal(acceptedBodies.length, 1);
			r1.flushEngine?.dispose?.();
			r1.store?.close?.();
			const crashedStore = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				crashedStore.clearElapsedRetryDeadline(Date.now() + 60_000);
			} finally {
				crashedStore.close();
			}

			const replayedBodies = [];
			const fakeFetch = async (url, init) => {
				if (String(url).endsWith("/api/v1/identity/register-machine")) {
					return registerMachineResponse(init);
				}
				const body = String(init.body);
				replayedBodies.push(body);
				if (body === acceptedBodies[0]) {
					return new Response(JSON.stringify({ error: "duplicate_event" }), { status: 409 });
				}
				return new Response(JSON.stringify({ receipt_id: "r_replay" }), {
					status: 202,
					headers: { "Content-Type": "application/json" },
				});
			};
			const r2 = new SnoObserveRuntime({ env: t.env, cwd: t.dir, fetch: fakeFetch });
			try {
				const res = await r2.flush();
				assert.equal(res.shipped >= 1, true);
				assert.equal(replayedBodies[0], acceptedBodies[0]);
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
			r1.flushEngine?.dispose?.();
			r1.store?.close?.();

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

	it("separate operating-system processes share the SQLite flush lease", async () => {
		const t = tempEnv();
		const store = new BufferStore(t.env.SNO_BUFFER_PATH);
		store.close();
		const holder = spawnLeaseProbe(t.env.SNO_BUFFER_PATH, "holder", true);
		try {
			assert.deepEqual(await readProbe(holder), { leaseDelay: 0, retryDelay: 0 });
			const contender = spawnLeaseProbe(t.env.SNO_BUFFER_PATH, "contender", false);
			const blocked = await readProbe(contender);
			assert.equal(blocked.leaseDelay > 0, true);
			assert.equal(blocked.retryDelay, 0);
			assert.equal(await waitForExit(contender), 0);
			holder.stdin.end("release\n");
			assert.equal(await waitForExit(holder), 0);
			const successor = spawnLeaseProbe(t.env.SNO_BUFFER_PATH, "successor", false);
			assert.deepEqual(await readProbe(successor), { leaseDelay: 0, retryDelay: 0 });
			assert.equal(await waitForExit(successor), 0);
		} finally {
			holder.kill();
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("a separate operating-system process honors a persisted chain retry deadline", async () => {
		const t = tempEnv();
		const store = new BufferStore(t.env.SNO_BUFFER_PATH);
		store.append({
			eventId: "id-0",
			eventType: "agent.identify",
			lane: "memory",
			tsEdgeMs: 1,
			consentLevel: "metadata-only",
			redacted: false,
			scope,
			payload: validPayloads["agent.identify"],
			terminal: false,
		});
		store.deferChainRetriesUntil(
			{ machineId: scope.machine_id, agentId: "codex", chainEpoch: 0 },
			Date.now() + 60_000,
		);
		store.close();
		const probe = spawnChainRetryProbe(t.env.SNO_BUFFER_PATH);
		try {
			const result = await readProbe(probe);
			assert.equal(result.readyCount, 0);
			assert.equal(result.retryDelay > 0, true);
			assert.equal(await waitForExit(probe), 0);
		} finally {
			probe.kill();
			rmSync(t.dir, { recursive: true, force: true });
		}
	});
});

function spawnChainRetryProbe(path) {
	const source = `
		import { BufferStore } from ${JSON.stringify(bufferStoreModuleUrl)};
		const store = new BufferStore(process.argv[1]);
		process.stdout.write(JSON.stringify({
			readyCount: store.getReadyPending().length,
			retryDelay: store.getNextChainRetryDelay(),
		}) + "\\n");
		store.close();
	`;
	return spawn(process.execPath, ["--input-type=module", "--eval", source, path], {
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function spawnLeaseProbe(path, owner, hold) {
	const source = `
		import { BufferStore } from ${JSON.stringify(bufferStoreModuleUrl)};
		const store = new BufferStore(process.argv[1]);
		const owner = process.argv[2];
		const hold = process.argv[3] === "hold";
		const leaseDelay = store.acquireFlushLease(owner);
		process.stdout.write(JSON.stringify({ leaseDelay, retryDelay: store.getRetryDelay() }) + "\\n");
		if (hold && leaseDelay === 0) {
			process.stdin.once("data", () => {
				store.releaseFlushLease(owner);
				store.close();
			});
		} else {
			if (leaseDelay === 0) store.releaseFlushLease(owner);
			store.close();
		}
	`;
	return spawn(process.execPath, ["--input-type=module", "--eval", source, path, owner, hold ? "hold" : "exit"], {
		cwd: process.cwd(),
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function readProbe(child) {
	return new Promise((resolve, reject) => {
		let output = "";
		let errorOutput = "";
		const timer = setTimeout(() => reject(new Error("lease probe timed out")), 5_000);
		child.stderr.on("data", (chunk) => {
			errorOutput += String(chunk);
		});
		child.stdout.on("data", (chunk) => {
			output += String(chunk);
			const newline = output.indexOf("\n");
			if (newline >= 0) {
				clearTimeout(timer);
				resolve(JSON.parse(output.slice(0, newline)));
			}
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code) => {
			if (output.indexOf("\n") < 0) {
				clearTimeout(timer);
				reject(new Error(`lease probe exited ${code}: ${errorOutput}`));
			}
		});
	});
}

function waitForExit(child) {
	return new Promise((resolve, reject) => {
		if (child.exitCode !== null) {
			resolve(child.exitCode);
			return;
		}
		const timer = setTimeout(() => reject(new Error("lease probe did not exit")), 5_000);
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve(code);
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
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
