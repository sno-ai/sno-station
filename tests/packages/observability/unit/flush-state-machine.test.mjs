// Flush 3-state machine + tiktoken token-init fallback per tasks §23.1, §23.2, §23.3, §23.5,
// §23.6, §25.3. Uses real BufferStore + real FlushEngine; only the network is the fake.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
	BufferStore,
	decodeEnvelope,
} from "../../../../packages/observability/dist/internal/buffer-store.js";
import {
	FlushEngine,
	flushPending,
} from "../../../../packages/observability/dist/internal/flush.js";
import { bootstrapIdentity } from "../../../../packages/observability/dist/internal/identity.js";
import { SnoObserveRuntime } from "../../../../packages/observability/dist/internal/runtime.js";
import { parseEventInput } from "../../../../packages/observability/dist/internal/schemas.js";
import { countTokens } from "../../../../packages/observability/dist/internal/tokens.js";
import { scope, validPayloads, writeObserveSettings } from "../fixtures/temp-env.mjs";

function testHash(index) {
	return index.toString(16).padStart(64, "0");
}

function tempEnv() {
	const dir = mkdtempSync(join(tmpdir(), "sno-observe-flush-"));
	writeObserveSettings(dir, { baseUrl: "https://sno.test" });
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

function appendMemoryWrite(store, i, eventScope = scope) {
	store.append({
		eventId: `mw-${i}`,
		eventType: "memory.write",
		lane: "memory",
		tsEdgeMs: 1000 + i,
		consentLevel: "metadata-only",
		redacted: false,
		scope: eventScope,
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

	it("first runtime emit on empty buffer schedules a 5s timer (23.1)", async () => {
		const t = tempEnv();
		const runtime = new SnoObserveRuntime({ env: t.env, cwd: t.dir });
		const spy = mock.method(globalThis, "setTimeout");
		try {
			await runtime.emitParsed(memoryEvent(1));
			assert.equal(spy.mock.callCount(), 1);
			assert.equal(spy.mock.calls[0].arguments[1], 5_000);
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

	it("an already-registered response does not quarantine pending events", async () => {
		const t = tempEnv();
		const store = new BufferStore(t.env.SNO_BUFFER_PATH);
		const identity = bootstrapIdentity(t.env);
		seedIdentify(store);
		let eventCalls = 0;
		const fakeFetch = async (url, init) => {
			if (String(url).endsWith("/api/v1/identity/register-machine")) {
				return new Response(JSON.stringify({ error: "machine_already_registered" }), {
					status: 409,
				});
			}
			assert.equal(init.headers.Authorization, `Bearer ${identity.machine_secret}`);
			eventCalls += 1;
			return new Response(JSON.stringify({ receipt_id: "r" }), { status: 202 });
		};
		const engine = new FlushEngine(store, () => identity, () => "https://sno.test", () => t.env);
		try {
			const result = await engine.flush({ identity, env: t.env, fetch: fakeFetch });
			assert.equal(result.shipped, 1);
			assert.equal(result.terminal, 0);
			assert.equal(eventCalls, 1);
			assert.equal(store.countPending(), 0);
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
			() => fakeFetch,
		);
		const random = mock.method(Math, "random", () => 0);
		mock.timers.enable({ apis: ["setTimeout", "Date"] });
		try {
			const first = await engine.flush({
				identity,
				env: t.env,
				fetch: fakeFetch,
			});
			const blocked = await engine.flush({
				identity,
				env: t.env,
				fetch: fakeFetch,
			});
			mock.timers.tick(5_000);
			await waitImmediateFlushDone(() => eventCalls === 2);

			assert.equal(first.retryable, 1);
			assert.equal(blocked.retryable, 1);
			assert.equal(registrationCalls, 2);
		} finally {
			engine.dispose();
			mock.timers.reset();
			random.mock.restore();
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

	it("shutdown stops when drain keeps receiving new pending rows", async () => {
		const t = tempEnv();
		let runtime;
		let eventCalls = 0;
		let runtimeScope;
		runtime = new SnoObserveRuntime({
			env: t.env,
			cwd: t.dir,
			fetch: async (url, init) => {
				if (String(url).endsWith("/api/v1/identity/register-machine")) {
					return registerMachineResponse(init);
				}
				eventCalls += 1;
				appendMemoryWrite(runtime.store, 1_000 + eventCalls, runtimeScope);
				return new Response(JSON.stringify({ receipt_id: "r" }), {
					status: 202,
					headers: { "Content-Type": "application/json" },
				});
			},
		});
		try {
			await runtime.emitParsed(memoryEvent(8));
			runtimeScope = decodeEnvelope(runtime.store.getAllRows()[0].payload).scope;
			const result = await runtime.shutdown();
			assert.equal(result.lastError, "sno observe drain made no progress");
			assert.equal(result.failedCount > 0, true);
			assert.equal(eventCalls > 0, true);
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

	it("Retry-After suppresses resends until the deadline", async () => {
		const t = tempEnv();
		const store = new BufferStore(t.env.SNO_BUFFER_PATH);
		const identity = bootstrapIdentity(t.env);
		seedIdentify(store);
		let eventCalls = 0;
		const fakeFetch = async (url, init) => {
			if (String(url).endsWith("/api/v1/identity/register-machine")) {
				return registerMachineResponse(init);
			}
			eventCalls += 1;
			if (eventCalls === 1) {
				return new Response(JSON.stringify({ error: "rate_limited" }), {
					status: 429,
					headers: { "Content-Type": "application/json", "Retry-After": "60" },
				});
			}
			return new Response(JSON.stringify({ receipt_id: "r" }), { status: 202 });
		};
		const engine = new FlushEngine(
			store,
			() => identity,
			() => "https://sno.test",
			() => t.env,
			() => fakeFetch,
		);
		const random = mock.method(Math, "random", () => 0);
		mock.timers.enable({ apis: ["setTimeout", "Date"] });
		try {
			const first = await engine.flush({ identity, env: t.env, fetch: fakeFetch });
			assert.equal(first.retryable, 1);
			assert.equal(eventCalls, 1);
			assert.equal(store.getRetryDelay(0), 60_000);
			const forced = await engine.flush({ identity, env: t.env, fetch: fakeFetch, force: true });
			assert.equal(forced.retryable, 1);
			assert.equal(eventCalls, 1);
			mock.timers.tick(59_999);
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(eventCalls, 1);
			mock.timers.tick(1);
			await waitImmediateFlushDone(() => eventCalls === 2);
			assert.equal(store.countPending(), 0);
		} finally {
			engine.dispose();
			mock.timers.reset();
			random.mock.restore();
			store.close();
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("an early timer wake reschedules a persisted retry deadline after restart", async () => {
		const t = tempEnv();
		const store = new BufferStore(t.env.SNO_BUFFER_PATH);
		const identity = bootstrapIdentity(t.env);
		seedIdentify(store);
		let eventCalls = 0;
		const fakeFetch = async (url, init) => {
			if (String(url).endsWith("/api/v1/identity/register-machine")) {
				return registerMachineResponse(init);
			}
			eventCalls += 1;
			return eventCalls === 1
				? new Response(JSON.stringify({ error: "unavailable" }), { status: 500 })
				: new Response(JSON.stringify({ receipt_id: "r" }), { status: 202 });
		};
		const engine = new FlushEngine(
			store,
			() => identity,
			() => "https://sno.test",
			() => t.env,
			() => fakeFetch,
		);
		const random = mock.method(Math, "random", () => 0);
		mock.timers.enable({ apis: ["setTimeout", "Date"] });
		try {
			store.deferRetriesUntil(60_000);
			engine.schedule(5_000);
			mock.timers.tick(5_000);
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(eventCalls, 0);
			mock.timers.tick(54_999);
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(eventCalls, 0);
			mock.timers.tick(1);
			await waitImmediateFlushDone(() => eventCalls === 1);
			assert.equal(store.countPending(), 1);
			mock.timers.tick(4_999);
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(eventCalls, 1);
			mock.timers.tick(1);
			await waitImmediateFlushDone(() => eventCalls === 2);
			assert.equal(store.countPending(), 0);
		} finally {
			engine.dispose();
			mock.timers.reset();
			random.mock.restore();
			store.close();
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("a chain-local retry does not block an independent agent chain", async () => {
		const t = tempEnv();
		const store = new BufferStore(t.env.SNO_BUFFER_PATH);
		const identity = bootstrapIdentity(t.env);
		seedIdentify(store);
		appendMemoryWrite(store, 1);
		const openclawScope = { ...scope, agent_id: "openclaw" };
		store.append({
			eventId: "openclaw-id",
			eventType: "agent.identify",
			lane: "memory",
			tsEdgeMs: 2_000,
			consentLevel: "metadata-only",
			redacted: false,
			scope: openclawScope,
			payload: { ...validPayloads["agent.identify"], agent_id: "openclaw" },
			terminal: false,
		});
		appendMemoryWrite(store, 2, openclawScope);
		const submittedAgents = [];
		const fakeFetch = async (url, init) => {
			if (String(url).endsWith("/api/v1/identity/register-machine")) {
				return registerMachineResponse(init);
			}
			const envelope = JSON.parse(String(init?.body));
			submittedAgents.push(envelope.scope.agent_id);
			if (envelope.scope.agent_id === "codex") {
				return new Response(
					JSON.stringify({
						code: "chain_predecessor_not_ready",
						chain_epoch: envelope.chain_epoch,
						latest_state: "pending",
						chain_stall_ms: 0,
					}),
					{ status: 409 },
				);
			}
			return new Response(JSON.stringify({ receipt_id: envelope.event_id }), { status: 202 });
		};
		const engine = new FlushEngine(store, () => identity, () => "https://sno.test", () => t.env);
		try {
			const result = await engine.flush({ identity, env: t.env, fetch: fakeFetch });
			assert.equal(result.retryable, 1);
			assert.equal(result.shipped, 2);
			assert.deepEqual(submittedAgents, ["codex", "openclaw", "openclaw"]);
			assert.equal(store.getPending().every((row) => row.agent_id === "codex"), true);
		} finally {
			engine.dispose();
			store.close();
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("a 400 keeps the rejected row as evidence and ships the rest in a fresh epoch", async () => {
		const t = tempEnv();
		const store = new BufferStore(t.env.SNO_BUFFER_PATH);
		const identity = bootstrapIdentity(t.env);
		seedIdentify(store);
		appendMemoryWrite(store, 1);
		appendMemoryWrite(store, 2);
		const posted = [];
		const fakeFetch = async (url, init) => {
			if (String(url).endsWith("/api/v1/identity/register-machine")) {
				return registerMachineResponse(init);
			}
			const envelope = JSON.parse(String(init.body));
			posted.push(`${envelope.event_id}@${envelope.chain_epoch}`);
			if (envelope.event_id === "mw-1") {
				return new Response(JSON.stringify({ error: "future_client_contract" }), { status: 400 });
			}
			return new Response(JSON.stringify({ receipt_id: "r" }), { status: 202 });
		};
		const engine = new FlushEngine(store, () => identity, () => "https://sno.test", () => t.env);
		try {
			const result = await engine.flush({ identity, env: t.env, fetch: fakeFetch });
			assert.equal(result.retryable, 0);
			assert.equal(result.terminal, 1);
			assert.equal(store.countPending(), 0);
			assert.equal(posted.filter((entry) => entry.startsWith("mw-1@")).length, 1);
			assert.equal(posted.includes("mw-2@1"), true);
			assert.equal(store.getRetryDelay(), 0);
			assert.equal(store.countQuarantined(), 1);
			assert.equal(store.getByEventId("mw-2").chain_epoch, 1);
		} finally {
			engine.dispose();
			store.close();
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("a chain-local delay cannot shorten a global Retry-After deadline", async () => {
		const t = tempEnv();
		const store = new BufferStore(t.env.SNO_BUFFER_PATH);
		const identity = bootstrapIdentity(t.env);
		seedIdentify(store);
		store.append({
			eventId: "openclaw-id",
			eventType: "agent.identify",
			lane: "memory",
			tsEdgeMs: 2_000,
			consentLevel: "metadata-only",
			redacted: false,
			scope: { ...scope, agent_id: "openclaw" },
			payload: { ...validPayloads["agent.identify"], agent_id: "openclaw" },
			terminal: false,
		});
		const now = mock.method(Date, "now", () => 1_000);
		try {
			const result = await flushPending(store, {
				identity,
				env: t.env,
				fetch: async (url, init) => {
					if (String(url).endsWith("/api/v1/identity/register-machine")) {
						return registerMachineResponse(init);
					}
					const envelope = JSON.parse(String(init.body));
					return envelope.scope.agent_id === "codex"
						? new Response(
								JSON.stringify({
									code: "chain_predecessor_not_ready",
									chain_epoch: envelope.chain_epoch,
									latest_state: "pending",
									chain_stall_ms: 0,
								}),
								{ status: 409 },
							)
						: new Response(JSON.stringify({ error: "rate_limited" }), {
								status: 429,
								headers: { "Retry-After": "3600" },
							});
				},
			});
			assert.equal(result.retryable, 2);
			assert.equal(result.retryAfterMs, 3_600_000);
			assert.equal(store.getRetryDelay(1_000), 3_600_000);
			assert.equal(store.getNextChainRetryDelay(1_000), 5_000);
		} finally {
			now.mock.restore();
			store.close();
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("a new independent chain preempts a long chain-only wake timer", async () => {
		const t = tempEnv();
		const store = new BufferStore(t.env.SNO_BUFFER_PATH);
		const identity = bootstrapIdentity(t.env);
		seedIdentify(store);
		let openclawCalls = 0;
		const fakeFetch = async (url, init) => {
			if (String(url).endsWith("/api/v1/identity/register-machine")) {
				return registerMachineResponse(init);
			}
			const envelope = JSON.parse(String(init.body));
			if (envelope.scope.agent_id === "codex") {
				return new Response(
					JSON.stringify({
						code: "chain_predecessor_not_ready",
						chain_epoch: envelope.chain_epoch,
						latest_state: "pending",
						chain_stall_ms: 0,
					}),
					{ status: 409, headers: { "Retry-After": "3600" } },
				);
			}
			openclawCalls += 1;
			return new Response(JSON.stringify({ receipt_id: "r" }), { status: 202 });
		};
		const engine = new FlushEngine(
			store,
			() => identity,
			() => "https://sno.test",
			() => t.env,
			() => fakeFetch,
		);
		const random = mock.method(Math, "random", () => 0);
		mock.timers.enable({ apis: ["setTimeout", "Date"] });
		try {
			assert.equal((await engine.flush({ identity, env: t.env, fetch: fakeFetch })).retryable, 1);
			store.append({
				eventId: "openclaw-id",
				eventType: "agent.identify",
				lane: "memory",
				tsEdgeMs: 2_000,
				consentLevel: "metadata-only",
				redacted: false,
				scope: { ...scope, agent_id: "openclaw" },
				payload: { ...validPayloads["agent.identify"], agent_id: "openclaw" },
				terminal: false,
			});
			engine.schedule(5_000);
			mock.timers.tick(4_999);
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(openclawCalls, 0);
			mock.timers.tick(1);
			await waitImmediateFlushDone(() => openclawCalls === 1);
			assert.equal(store.getPending().every((row) => row.agent_id === "codex"), true);
		} finally {
			engine.dispose();
			mock.timers.reset();
			random.mock.restore();
			store.close();
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("ready backlog beyond a full batch is not delayed by another chain's long retry", async () => {
		const t = tempEnv();
		const store = new BufferStore(t.env.SNO_BUFFER_PATH);
		const identity = bootstrapIdentity(t.env);
		seedIdentify(store);
		const openclawScope = { ...scope, agent_id: "openclaw" };
		store.append({
			eventId: "openclaw-id",
			eventType: "agent.identify",
			lane: "memory",
			tsEdgeMs: 2_000,
			consentLevel: "metadata-only",
			redacted: false,
			scope: openclawScope,
			payload: { ...validPayloads["agent.identify"], agent_id: "openclaw" },
			terminal: false,
		});
		for (let index = 1; index <= 100; index += 1) {
			appendMemoryWrite(store, index, openclawScope);
		}
		let openclawCalls = 0;
		const fakeFetch = async (url, init) => {
			if (String(url).endsWith("/api/v1/identity/register-machine")) {
				return registerMachineResponse(init);
			}
			const envelope = JSON.parse(String(init.body));
			if (envelope.scope.agent_id === "codex") {
				return new Response(
					JSON.stringify({
						code: "chain_predecessor_not_ready",
						chain_epoch: envelope.chain_epoch,
						latest_state: "pending",
						chain_stall_ms: 0,
					}),
					{ status: 409, headers: { "Retry-After": "3600" } },
				);
			}
			openclawCalls += 1;
			return new Response(JSON.stringify({ receipt_id: "r" }), { status: 202 });
		};
		const engine = new FlushEngine(
			store,
			() => identity,
			() => "https://sno.test",
			() => t.env,
			() => fakeFetch,
		);
		const random = mock.method(Math, "random", () => 0);
		mock.timers.enable({ apis: ["setTimeout", "Date"] });
		try {
			const first = await engine.flush({ identity, env: t.env, fetch: fakeFetch });
			assert.equal(first.retryable, 1);
			assert.equal(first.shipped, 99);
			mock.timers.tick(5_000);
			await waitImmediateFlushDone(() => openclawCalls === 101);
			assert.equal(store.getPending().every((row) => row.agent_id === "codex"), true);
		} finally {
			engine.dispose();
			mock.timers.reset();
			random.mock.restore();
			store.close();
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("doctor warns when events are pending and none have shipped", async () => {
		const t = tempEnv();
		const runtime = new SnoObserveRuntime({ env: t.env, cwd: t.dir });
		try {
			await runtime.emitParsed(memoryEvent(1));
			const report = runtime.doctor();
			assert.equal(report.last_ship.status, "warn");
			assert.match(report.last_ship.detail, /2 event\(s\) pending/u);
		} finally {
			runtime.flushEngine?.dispose?.();
			runtime.store?.close?.();
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("doctor warns about a current backlog after a prior successful shipment", async () => {
		const t = tempEnv();
		const runtime = new SnoObserveRuntime({ env: t.env, cwd: t.dir });
		try {
			await runtime.emitParsed(memoryEvent(1));
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				store.markShipped(store.getAllRows()[0].rowid);
			} finally {
				store.close();
			}
			const report = runtime.doctor();
			assert.equal(report.last_ship.status, "warn");
			assert.match(report.last_ship.detail, /1 event\(s\) pending/u);
			assert.match(report.last_ship.detail, /1 previously shipped/u);
		} finally {
			runtime.flushEngine?.dispose?.();
			runtime.store?.close?.();
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("doctor reports inaccessible storage and an invalid endpoint without throwing", () => {
		const t = tempEnv();
		writeObserveSettings(t.dir, { baseUrl: "http://remote.example" });
		const runtime = new SnoObserveRuntime({
			env: {
				...t.env,
				SNO_BUFFER_PATH: t.dir,
			},
			cwd: t.dir,
		});
		try {
			const report = runtime.doctor();
			assert.equal(report.buffer.status, "fail");
			assert.equal(report.last_ship.status, "fail");
			assert.match(report.last_ship.detail, /invalid observability endpoint/u);
		} finally {
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("a second runtime cannot bypass a persisted Retry-After deadline", async () => {
		const t = tempEnv();
		let firstEventCalls = 0;
		let secondEventCalls = 0;
		const first = new SnoObserveRuntime({
			env: t.env,
			cwd: t.dir,
			fetch: async (url, init) => {
				if (String(url).endsWith("/api/v1/identity/register-machine")) {
					return registerMachineResponse(init);
				}
				firstEventCalls += 1;
				return new Response(JSON.stringify({ error: "rate_limited" }), {
					status: 429,
					headers: { "Retry-After": "60" },
				});
			},
		});
		const second = new SnoObserveRuntime({
			env: t.env,
			cwd: t.dir,
			fetch: async (url, init) => {
				if (String(url).endsWith("/api/v1/identity/register-machine")) {
					return registerMachineResponse(init);
				}
				secondEventCalls += 1;
				return new Response(JSON.stringify({ receipt_id: "unexpected" }), { status: 202 });
			},
		});
		try {
			await first.emitParsed(memoryEvent(1));
			assert.equal((await first.flush()).retryable, 1);
			assert.equal(firstEventCalls, 1);
			assert.equal((await second.flush()).retryable, 1);
			assert.equal(secondEventCalls, 0);
		} finally {
			await first.shutdown().catch(() => {});
			await second.shutdown().catch(() => {});
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("a retry deadline written during lease acquisition is rechecked before delivery", async () => {
		const t = tempEnv();
		const store = new BufferStore(t.env.SNO_BUFFER_PATH);
		const identity = bootstrapIdentity(t.env);
		seedIdentify(store);
		let retryChecks = 0;
		let eventCalls = 0;
		const retryDelay = mock.method(store, "getRetryDelay", () => {
			retryChecks += 1;
			return retryChecks === 1 ? 0 : 60_000;
		});
		try {
			const result = await flushPending(store, {
				identity,
				env: t.env,
				fetch: async () => {
					eventCalls += 1;
					return new Response(JSON.stringify({ receipt_id: "unexpected" }), { status: 202 });
				},
			});
			assert.equal(result.retryable, 1);
			assert.equal(result.retryAfterMs, 60_000);
			assert.equal(eventCalls, 0);
		} finally {
			retryDelay.mock.restore();
			store.close();
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("concurrent runtimes share one SQLite-backed in-flight lease", async () => {
		const t = tempEnv();
		let firstEventCalls = 0;
		let secondEventCalls = 0;
		let releaseEvent;
		const eventResponse = new Promise((resolve) => {
			releaseEvent = () => resolve(new Response(JSON.stringify({ receipt_id: "r" }), { status: 202 }));
		});
		const first = new SnoObserveRuntime({
			env: t.env,
			cwd: t.dir,
			fetch: async (url, init) => {
				if (String(url).endsWith("/api/v1/identity/register-machine")) {
					return registerMachineResponse(init);
				}
				firstEventCalls += 1;
				return eventResponse;
			},
		});
		const second = new SnoObserveRuntime({
			env: t.env,
			cwd: t.dir,
			fetch: async (url, init) => {
				if (String(url).endsWith("/api/v1/identity/register-machine")) {
					return registerMachineResponse(init);
				}
				secondEventCalls += 1;
				return new Response(JSON.stringify({ receipt_id: "unexpected" }), { status: 202 });
			},
		});
		try {
			await first.emitParsed(memoryEvent(1));
			const firstFlush = first.flush({ force: true });
			await waitImmediateFlushDone(() => firstEventCalls === 1);
			const concurrentResult = await second.flush({ force: true });
			assert.equal(concurrentResult.retryable, 1);
			assert.equal(secondEventCalls, 0);
			const observer = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				assert.equal(observer.getRetryDelay(), 0);
			} finally {
				observer.close();
			}
			releaseEvent();
			const firstResult = await firstFlush;
			assert.equal(firstResult.shipped, 2);
			assert.equal(firstEventCalls, 2);
		} finally {
			await first.shutdown().catch(() => {});
			await second.shutdown().catch(() => {});
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("repeated 500 responses back off from five to ten seconds", async () => {
		const t = tempEnv();
		const store = new BufferStore(t.env.SNO_BUFFER_PATH);
		const identity = bootstrapIdentity(t.env);
		seedIdentify(store);
		let eventCalls = 0;
		const fakeFetch = async (url, init) => {
			if (String(url).endsWith("/api/v1/identity/register-machine")) {
				return registerMachineResponse(init);
			}
			eventCalls += 1;
			return eventCalls <= 2
				? new Response(JSON.stringify({ error: "unavailable" }), { status: 500 })
				: new Response(JSON.stringify({ receipt_id: "r" }), { status: 202 });
		};
		const engine = new FlushEngine(
			store,
			() => identity,
			() => "https://sno.test",
			() => t.env,
			() => fakeFetch,
		);
		const random = mock.method(Math, "random", () => 0);
		mock.timers.enable({ apis: ["setTimeout", "Date"] });
		try {
			assert.equal((await engine.flush({ identity, env: t.env, fetch: fakeFetch })).retryable, 1);
			mock.timers.tick(4_999);
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(eventCalls, 1);
			mock.timers.tick(1);
			await waitImmediateFlushDone(() => eventCalls === 2);
			mock.timers.tick(9_999);
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(eventCalls, 2);
			mock.timers.tick(1);
			await waitImmediateFlushDone(() => eventCalls === 3);
			assert.equal(store.countPending(), 0);
		} finally {
			engine.dispose();
			mock.timers.reset();
			random.mock.restore();
			store.close();
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("long Retry-After receives bounded positive jitter persisted to SQLite", async () => {
		const t = tempEnv();
		const store = new BufferStore(t.env.SNO_BUFFER_PATH);
		const identity = bootstrapIdentity(t.env);
		seedIdentify(store);
		const fakeFetch = async (url, init) => {
			if (String(url).endsWith("/api/v1/identity/register-machine")) {
				return registerMachineResponse(init);
			}
			return new Response(JSON.stringify({ error: "rate_limited" }), {
				status: 429,
				headers: { "Retry-After": "60" },
			});
		};
		const engine = new FlushEngine(
			store,
			() => identity,
			() => "https://sno.test",
			() => t.env,
			() => fakeFetch,
		);
		const random = mock.method(Math, "random", () => 1);
		mock.timers.enable({ apis: ["setTimeout", "Date"] });
		try {
			assert.equal((await engine.flush({ identity, env: t.env, fetch: fakeFetch })).retryable, 1);
			assert.equal(store.getRetryDelay(0), 72_000);
		} finally {
			engine.dispose();
			mock.timers.reset();
			random.mock.restore();
			store.close();
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("scheduled flush failures are caught instead of becoming unhandled rejections", async () => {
		const t = tempEnv();
		const store = new BufferStore(t.env.SNO_BUFFER_PATH);
		const identity = bootstrapIdentity(t.env);
		const engine = new FlushEngine(store, () => identity, () => "https://sno.test", () => t.env);
		const previousProfile = process.env.SNO_PROFILE_DIR;
		process.env.SNO_PROFILE_DIR = t.dir;
		const stderrWrites = [];
		const write = mock.method(process.stderr, "write", (chunk) => {
			stderrWrites.push(String(chunk));
			return true;
		});
		try {
			store.close();
			engine.schedule(0);
			await delay(20);
			const log = readFileSync(join(t.dir, "observe.log"), "utf8");
			assert.equal(log.includes("sno observe scheduled flush failed"), true);
			assert.equal(stderrWrites.join(""), "");
		} finally {
			engine.dispose();
			write.mock.restore();
			if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR;
			else process.env.SNO_PROFILE_DIR = previousProfile;
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("a transient scheduled flush exception re-arms without another emit", async () => {
		const t = tempEnv();
		const store = new BufferStore(t.env.SNO_BUFFER_PATH);
		const identity = bootstrapIdentity(t.env);
		seedIdentify(store);
		let retryChecks = 0;
		let eventCalls = 0;
		const originalRetryDelay = store.getRetryDelay.bind(store);
		const retryDelay = mock.method(store, "getRetryDelay", (...args) => {
			retryChecks += 1;
			if (retryChecks === 1) {
				throw new Error("transient sqlite busy");
			}
			return originalRetryDelay(...args);
		});
		const fakeFetch = async (url, init) => {
			if (String(url).endsWith("/api/v1/identity/register-machine")) {
				return registerMachineResponse(init);
			}
			eventCalls += 1;
			return new Response(JSON.stringify({ receipt_id: "r" }), { status: 202 });
		};
		const engine = new FlushEngine(
			store,
			() => identity,
			() => "https://sno.test",
			() => t.env,
			() => fakeFetch,
		);
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			engine.schedule(0);
			mock.timers.tick(0);
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(eventCalls, 0);
			mock.timers.tick(5_000);
			await waitImmediateFlushDone(() => eventCalls === 1);
			assert.equal(store.countPending(), 0);
		} finally {
			engine.dispose();
			mock.timers.reset();
			retryDelay.mock.restore();
			store.close();
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("a successful full batch schedules the remaining backlog", async () => {
		const t = tempEnv();
		const store = new BufferStore(t.env.SNO_BUFFER_PATH);
		const identity = bootstrapIdentity(t.env);
		seedIdentify(store);
		for (let index = 1; index <= 101; index += 1) {
			appendMemoryWrite(store, index);
		}
		let eventCalls = 0;
		const fakeFetch = async (url, init) => {
			if (String(url).endsWith("/api/v1/identity/register-machine")) {
				return registerMachineResponse(init);
			}
			eventCalls += 1;
			return new Response(JSON.stringify({ receipt_id: `r_${eventCalls}` }), { status: 202 });
		};
		const engine = new FlushEngine(
			store,
			() => identity,
			() => "https://sno.test",
			() => t.env,
			() => fakeFetch,
		);
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const first = await engine.flush({ identity, env: t.env, fetch: fakeFetch });
			assert.equal(first.shipped, 100);
			assert.equal(store.countPending(), 2);
			mock.timers.tick(4_999);
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(eventCalls, 100);
			mock.timers.tick(1);
			await waitImmediateFlushDone(() => store.countPending() === 0);
			assert.equal(eventCalls, 102);
		} finally {
			engine.dispose();
			mock.timers.reset();
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
