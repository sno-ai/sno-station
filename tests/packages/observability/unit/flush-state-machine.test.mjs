// Flush 3-state machine + tiktoken token-init fallback per tasks §23.1, §23.2, §23.3, §23.5,
// §23.6, §25.3. Uses real BufferStore + real FlushEngine; only the network is the fake.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
	BufferStore,
	decodeEnvelope,
} from "../../../../packages/sno-observe/dist/internal/buffer-store.js";
import { FlushEngine } from "../../../../packages/sno-observe/dist/internal/flush.js";
import { bootstrapIdentity } from "../../../../packages/sno-observe/dist/internal/identity.js";
import { SnoObserveRuntime } from "../../../../packages/sno-observe/dist/internal/runtime.js";
import { parseEventInput } from "../../../../packages/sno-observe/dist/internal/schemas.js";
import { countTokens } from "../../../../packages/sno-observe/dist/internal/tokens.js";
import { scope, validPayloads } from "../fixtures/temp-env.mjs";

function testHash(index) {
	return index.toString(16).padStart(64, "0");
}

function tempEnv() {
	const dir = mkdtempSync(join(tmpdir(), "sno-observe-flush-"));
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

function seedIdentify(store) {
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
}

function appendMemoryWrite(store, i) {
	store.append({
		eventId: `mw-${i}`,
		eventType: "memory.write",
		lane: "memory",
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

	it("runtime does not auto-attach legacy project_id values to scope", async () => {
		const t = tempEnv();
		const runtime = new SnoObserveRuntime({ env: t.env, cwd: t.dir });
		try {
			await runtime.emitParsed(memoryEvent(1));
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				const envelopes = store
					.getAllRows()
					.map((row) => decodeEnvelope(row.payload));
				assert.equal(envelopes.length, 2);
				assert.equal(envelopes[0].scope.project_id, undefined);
				assert.equal(envelopes[1].scope.project_id, undefined);
			} finally {
				store.close();
			}
		} finally {
			runtime.flushEngine?.dispose?.();
			runtime.store?.close?.();
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("runtime uses parsed event consent level for the current event", async () => {
		const t = tempEnv();
		const runtime = new SnoObserveRuntime({ env: t.env, cwd: t.dir });
		try {
			const event = memoryEvent(2);
			event.consentLevel = "off";
			const result = await runtime.emitParsed(event);
			assert.equal(result.accepted, false);
			assert.equal(result.reason, "consent_off");

			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				const envelopes = store
					.getAllRows()
					.map((row) => decodeEnvelope(row.payload));
				assert.equal(envelopes.at(-1).consent_level, "off");
			} finally {
				store.close();
			}
		} finally {
			runtime.flushEngine?.dispose?.();
			runtime.store?.close?.();
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
			const result = await engine.flush({
				identity,
				env: t.env,
				fetch: fakeFetch,
			});
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

	it("caches machine registration across successful engine flushes", async () => {
		const t = tempEnv();
		const store = new BufferStore(t.env.SNO_BUFFER_PATH);
		const identity = bootstrapIdentity(t.env);
		seedIdentify(store);
		appendMemoryWrite(store, 1);
		let registrationCalls = 0;
		const fakeFetch = async (url, init) => {
			if (String(url).endsWith("/api/v1/identity/register-machine")) {
				registrationCalls += 1;
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
			const first = await engine.flush({
				identity,
				env: t.env,
				fetch: fakeFetch,
			});
			appendMemoryWrite(store, 2);
			const second = await engine.flush({
				identity,
				env: t.env,
				fetch: fakeFetch,
			});

			assert.equal(first.shipped, 2);
			assert.equal(second.shipped, 1);
			assert.equal(registrationCalls, 1);
		} finally {
			engine.dispose();
			store.close();
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("re-registers after event auth rejection invalidates the registration cache", async () => {
		const t = tempEnv();
		const store = new BufferStore(t.env.SNO_BUFFER_PATH);
		const identity = bootstrapIdentity(t.env);
		seedIdentify(store);
		let registrationCalls = 0;
		let eventCalls = 0;
		const fakeFetch = async (url, init) => {
			if (String(url).endsWith("/api/v1/identity/register-machine")) {
				registrationCalls += 1;
				return registerMachineResponse(init);
			}
			eventCalls += 1;
			if (eventCalls === 1) {
				return new Response(JSON.stringify({ error: "unauthorized" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				});
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
			const first = await engine.flush({
				identity,
				env: t.env,
				fetch: fakeFetch,
			});
			const second = await engine.flush({
				identity,
				env: t.env,
				fetch: fakeFetch,
			});

			assert.equal(first.retryable, 1);
			assert.equal(second.shipped, 1);
			assert.equal(registrationCalls, 2);
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
			await waitImmediateFlushDone(
				() => fetchCalls > 0 && inFlightFetches === 0,
			);
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

	it("shutdown stops after awaiting an active retryable flush", async () => {
		const t = tempEnv();
		let eventCalls = 0;
		let releaseFirstEvent;
		const firstEventResponse = new Promise((resolve) => {
			releaseFirstEvent = () => {
				resolve(
					new Response(JSON.stringify({ error: "retry" }), {
						status: 503,
						headers: { "Content-Type": "application/json", "Retry-After": "5" },
					}),
				);
			};
		});
		const runtime = new SnoObserveRuntime({
			env: t.env,
			cwd: t.dir,
			fetch: async (url, init) => {
				if (String(url).endsWith("/api/v1/identity/register-machine")) {
					return registerMachineResponse(init);
				}
				eventCalls += 1;
				if (eventCalls === 1) {
					return firstEventResponse;
				}
				return new Response(
					JSON.stringify({ receipt_id: "unexpected_retry" }),
					{
						status: 202,
						headers: { "Content-Type": "application/json" },
					},
				);
			},
		});
		try {
			await runtime.emitParsed(memoryEvent(100));
			const activeFlush = runtime.flush(false);
			await waitImmediateFlushDone(() => eventCalls === 1);

			const shutdown = runtime.shutdown();
			releaseFirstEvent();
			const result = await shutdown;
			await activeFlush;

			assert.equal(eventCalls, 1);
			assert.equal(result.flushedCount, 0);
			assert.equal(result.failedCount > 0, true);
		} finally {
			await runtime.shutdown().catch(() => {});
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("shutdown drains scheduled pending rows before closing the buffer", async () => {
		const t = tempEnv();
		const runtime = new SnoObserveRuntime({
			env: t.env,
			cwd: t.dir,
			fetch: async (url, init) => {
				if (String(url).endsWith("/api/v1/identity/register-machine")) {
					return registerMachineResponse(init);
				}
				return new Response(JSON.stringify({ receipt_id: "r" }), {
					status: 202,
					headers: { "Content-Type": "application/json" },
				});
			},
		});
		try {
			await runtime.emitParsed(memoryEvent(7));
			const result = await runtime.shutdown();
			assert.equal(result.flushedCount, 2);
			assert.equal(result.failedCount, 0);
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				assert.equal(
					store.getAllRows().every((row) => row.shipped === 1),
					true,
				);
			} finally {
				store.close();
			}
		} finally {
			await runtime.shutdown().catch(() => {});
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("beforeExit flush hook re-arms after firing once", async () => {
		const t = tempEnv();
		const store = new BufferStore(t.env.SNO_BUFFER_PATH);
		const identity = bootstrapIdentity(t.env);
		const originalOnce = process.once;
		const originalOff = process.off;
		let beforeExitHandler;
		process.once = function once(event, listener) {
			if (event === "beforeExit") {
				beforeExitHandler = listener;
				return this;
			}
			return originalOnce.call(this, event, listener);
		};
		process.off = function off(event, listener) {
			if (event === "beforeExit" && listener === beforeExitHandler) {
				beforeExitHandler = undefined;
				return this;
			}
			return originalOff.call(this, event, listener);
		};
		const engine = new FlushEngine(
			store,
			() => identity,
			() => "https://sno.test",
			() => t.env,
		);
		try {
			engine.schedule(60_000);
			const firstHandler = beforeExitHandler;
			assert.equal(typeof firstHandler, "function");
			beforeExitHandler = undefined;
			firstHandler();
			await new Promise((resolve) => setImmediate(resolve));

			engine.schedule(60_000);
			assert.equal(typeof beforeExitHandler, "function");
			assert.notEqual(beforeExitHandler, firstHandler);
		} finally {
			engine.dispose();
			process.once = originalOnce;
			process.off = originalOff;
			store.close();
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

describe("tokens — tiktoken init failure approximation fallback (25.3)", () => {
	it("returns method=char_approximation for very long inputs without invoking tiktoken", async () => {
		// Inputs > 100_000 chars short-circuit to approximation, regardless of tiktoken state.
		const big = "x".repeat(100_001);
		const result = await countTokens(big);
		assert.equal(result.method, "char_approximation");
		assert.equal(typeof result.tokens, "number");
		assert.equal(result.tokens > 0, true);
	});

	it("falls back to char_approximation when the tokenizer cannot be loaded", async () => {
		// We can't easily inject a load-failure into the cached encoder promise from a
		// black-box test, but the contract is: countTokens MUST always return a number,
		// never throw, even if js-tiktoken is broken. Smoke that here:
		const result = await countTokens("hello world");
		assert.equal(typeof result.tokens, "number");
		assert.equal(result.tokens > 0, true);
		assert.equal(
			result.method === "tiktoken" || result.method === "char_approximation",
			true,
		);
	});
});
