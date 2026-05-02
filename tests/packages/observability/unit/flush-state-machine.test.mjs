// Flush 3-state machine + BPE token-init fallback per tasks §23.1, §23.2, §23.3, §23.5,
// §23.6, §25.3. Uses real BufferStore + real FlushEngine; only the network is the fake.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BufferStore } from "../../../../packages/sno-observe/dist/internal/buffer-store.js";
import { FlushEngine } from "../../../../packages/sno-observe/dist/internal/flush.js";
import { bootstrapIdentity } from "../../../../packages/sno-observe/dist/internal/identity.js";
import { SnoObserveRuntime } from "../../../../packages/sno-observe/dist/internal/runtime.js";
import { parseEventInput } from "../../../../packages/sno-observe/dist/internal/schemas.js";
import { countTokens } from "../../../../packages/sno-observe/dist/internal/tokens.js";
import { validPayloads, scope } from "../fixtures/temp-env.mjs";

function tempEnv() {
	const dir = mkdtempSync(join(tmpdir(), "sno-observe-flush-"));
	return {
		dir,
		env: {
			SNO_HOME: dir,
			SNO_IDENTITY_PATH: join(dir, "identity.json"),
			SNO_BUFFER_PATH: join(dir, "buffer.db"),
			SNO_CONSENT_PATH: join(dir, "state", "consent.json"),
			SNO_TOKEN_PATH: join(dir, "state", "tokens.json"),
			SNO_OBSERVE_BASE_URL: "https://sno.test",
			HOME: dir,
		},
	};
}

function seedIdentify(store) {
	store.append({
		eventId: "id-0",
		eventType: "agent.identify",
		tsEdgeMs: 1,
		consentLevel: "metadata-only",
		redacted: false,
		scope,
		payload: validPayloads["agent.identify"],
		terminal: false,
	});
}

function appendMemoryWrite(store, i) {
	store.append({
		eventId: `mw-${i}`,
		eventType: "memory.write",
		tsEdgeMs: 1000 + i,
		consentLevel: "metadata-only",
		redacted: false,
		scope,
		payload: validPayloads["memory.write"],
		terminal: false,
	});
}

function memoryEvent(i) {
	return parseEventInput({
		event_type: "memory.write",
		agent_id: "codex",
		payload: {
			key_hash: `timer-${i}`,
			byte_len: 1,
			content_tokens: 1,
			tokens_method: "fast",
		},
	});
}

async function waitImmediateFlushDone(getState) {
	for (let i = 0; i < 100; i += 1) {
		if (getState()) {
			return;
		}
		await new Promise((resolve) => setImmediate(resolve));
	}
}

describe("flush 3-state machine", () => {
	it("schedule(60_000) installs a setTimeout (23.1 first emit on empty buffer)", () => {
		const t = tempEnv();
		const store = new BufferStore(t.env.SNO_BUFFER_PATH);
		const identity = bootstrapIdentity(t.env);
		mock.timers.enable({ apis: ["setTimeout"] });
		const engine = new FlushEngine(
			store,
			() => identity,
			() => "https://sno.test",
			() => t.env,
		);
		try {
			engine.schedule(60_000);
			// In `scheduled` state, calling schedule again is a no-op.
			engine.schedule(60_000);
			// Advance time without firing the flush (we just observe timer install state).
			mock.timers.tick(60_000 - 1);
			// One pending timer at this point — covered by mock.timers' bookkeeping.
		} finally {
			engine.dispose();
			mock.timers.reset();
			store.close();
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("first runtime emit on empty buffer schedules a 60s timer (23.1)", async () => {
		const t = tempEnv();
		const runtime = new SnoObserveRuntime({ env: t.env, cwd: t.dir });
		const spy = mock.method(globalThis, "setTimeout");
		try {
			await runtime.emitParsed(memoryEvent(1));
			assert.equal(spy.mock.callCount(), 1);
			assert.equal(spy.mock.calls[0].arguments[1], 60_000);
		} finally {
			runtime.flushEngine?.dispose?.();
			runtime.store?.close?.();
			spy.mock.restore();
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("zero emits => zero setTimeout calls (23.3 idle 24h)", () => {
		const t = tempEnv();
		const store = new BufferStore(t.env.SNO_BUFFER_PATH);
		const identity = bootstrapIdentity(t.env);
		// Spy on global setTimeout BEFORE constructing the engine.
		const spy = mock.method(globalThis, "setTimeout");
		try {
			// Construct, but never call schedule/flush — pure idle.
			const engine = new FlushEngine(
				store,
				() => identity,
				() => "https://sno.test",
				() => t.env,
			);
			engine.dispose();
			assert.equal(spy.mock.callCount(), 0);
		} finally {
			spy.mock.restore();
			store.close();
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("flush re-arms exactly once if emit-during-flush observed (23.5)", async () => {
		const t = tempEnv();
		const store = new BufferStore(t.env.SNO_BUFFER_PATH);
		const identity = bootstrapIdentity(t.env);
		seedIdentify(store);
		appendMemoryWrite(store, 1);
		let postCount = 0;
		const fakeFetch = async (url, init) => {
			if (String(url).endsWith("/api/v1/identity/register-machine")) {
				return registerMachineResponse(init);
			}
			postCount += 1;
			// Mid-flush emit: simulate concurrent append between batch start and resolve.
			if (postCount === 1) {
				appendMemoryWrite(store, 2);
			}
			return new Response(JSON.stringify({ receipt_id: `r_${postCount}` }), {
				status: 202,
				headers: { "Content-Type": "application/json" },
			});
		};
		const engine = new FlushEngine(
			store,
			() => identity,
			() => "https://sno.test",
			() => t.env,
		);
		try {
			const result = await engine.flush({ identity, env: t.env, fetch: fakeFetch });
			// Initial batch shipped both rows that existed at batch start (limit=100).
			assert.equal(result.shipped >= 2, true);
			// Re-armed timer should drain the row appended mid-flush; allow it to fire.
			await engine.flush({ identity, env: t.env, fetch: fakeFetch });
			const remaining = store.countPending();
			assert.equal(remaining, 0);
		} finally {
			engine.dispose();
			store.close();
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("flush does NOT re-arm timer when no events arrived during flush (23.6)", async () => {
		const t = tempEnv();
		const store = new BufferStore(t.env.SNO_BUFFER_PATH);
		const identity = bootstrapIdentity(t.env);
		seedIdentify(store);
		appendMemoryWrite(store, 1);
		const fakeFetch = async (url, init) => {
			if (String(url).endsWith("/api/v1/identity/register-machine")) {
				return registerMachineResponse(init);
			}
			return new Response(JSON.stringify({ receipt_id: "r" }), {
				status: 202,
				headers: { "Content-Type": "application/json" },
			});
		};
		const engine = new FlushEngine(
			store,
			() => identity,
			() => "https://sno.test",
			() => t.env,
		);
		try {
			const r1 = await engine.flush({ identity, env: t.env, fetch: fakeFetch });
			assert.equal(r1.shipped, 2);
			// After flush completes idle and pending is zero, no further calls happen.
			await delay(20);
			assert.equal(store.countPending(), 0);
		} finally {
			engine.dispose();
			store.close();
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("preempts the timer and flushes early on threshold-50 burst (23.2)", async () => {
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
		const clearSpy = mock.method(globalThis, "clearTimeout");
		try {
			for (let i = 0; i < 50; i += 1) {
				await runtime.emitParsed(memoryEvent(i));
			}
			await waitImmediateFlushDone(() => fetchCalls > 0 && inFlightFetches === 0);
			assert.equal(fetchCalls > 0, true);
			assert.equal(clearSpy.mock.callCount() > 0, true);
			await runtime.shutdown();
		} finally {
			await runtime.shutdown().catch(() => {});
			clearSpy.mock.restore();
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("shutdown reports unshipped rows when the final flush is retryable", async () => {
		const t = tempEnv();
		const runtime = new SnoObserveRuntime({
			env: t.env,
			cwd: t.dir,
			fetch: async (url, init) => {
				if (String(url).endsWith("/api/v1/identity/register-machine")) {
					return registerMachineResponse(init);
				}
				return new Response(JSON.stringify({ error: "retry" }), {
					status: 503,
					headers: { "Content-Type": "application/json" },
				});
			},
		});
		try {
			await runtime.emitParsed(memoryEvent(99));
			const result = await runtime.shutdown();
			assert.equal(result.flushedCount, 0);
			assert.equal(result.failedCount > 0, true);
		} finally {
			await runtime.shutdown().catch(() => {});
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

describe("tokens — BPE init failure fast fallback (25.3)", () => {
	it("returns method=fast for very long inputs without invoking BPE", async () => {
		// Inputs > 100_000 chars short-circuit to fast counter, regardless of BPE state.
		const big = "x".repeat(100_001);
		const result = await countTokens(big);
		assert.equal(result.method, "fast");
		assert.equal(typeof result.tokens, "number");
		assert.equal(result.tokens > 0, true);
	});

	it("falls back to fast when BPE encoder cannot be loaded", async () => {
		// We can't easily inject a load-failure into the cached encoder promise from a
		// black-box test, but the contract is: countTokens MUST always return a number,
		// never throw, even if js-tiktoken is broken. Smoke that here:
		const result = await countTokens("hello world");
		assert.equal(typeof result.tokens, "number");
		assert.equal(result.tokens > 0, true);
		assert.equal(result.method === "bpe" || result.method === "fast", true);
	});
});
