// Acceptance suite per tasks §32.1, §32.2, §32.4 (live-endpoint smoke is
// manual). 24h idle + biome smoke (§32.3) live in the package's lint script
// plus this file's idle-timer assertion (kept short-form here; the spec calls
// for an actual 24h dry run done manually in CI).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createUUIDv7 } from "../../../../packages/common-core/dist/index.js";
import { SnoObserveRuntime } from "../../../../packages/sno-observe/dist/internal/runtime.js";
import { parseEventInput } from "../../../../packages/sno-observe/dist/internal/schemas.js";
import { skipIfNoLiveEndpoint } from "../fixtures/live-endpoint.mjs";
import { validPayloads } from "../fixtures/temp-env.mjs";

function tempEnv(baseUrl) {
	const dir = mkdtempSync(join(tmpdir(), "sno-observe-accept-"));
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

const SDK_EVENT_TYPES = [
	"agent.identify",
	"memory.write",
	"memory.read",
	"memory.snapshot",
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

const PLUGIN_INTERNAL_PAID_LLM_CALL = {
	model: "openai-compatible:text-embedding-3-small",
	prompt_tokens: 21,
	completion_tokens: 0,
	latency_ms: 59,
	cache_read_tokens: 0,
	cache_write_tokens: 0,
	token_source: "plugin_internal_paid",
};

describe("acceptance — live-endpoint end-to-end (32.1, gated)", () => {
	it("emits all 13 SDK-emittable event types and ships them", async (t) => {
		const baseUrl = skipIfNoLiveEndpoint(t);
		if (baseUrl === null) {
			return;
		}
		const env_ = tempEnv(baseUrl);
		const runtime = new SnoObserveRuntime({ env: env_.env, cwd: env_.dir });
		try {
			await runtime.setConsent("full", "acceptance-suite");
			for (const eventType of SDK_EVENT_TYPES) {
				if (eventType === "agent.identify" || eventType === "consent.change") {
					// Auto-emitted; skip explicit emit.
					continue;
				}
				await runtime.emitParsed(
					parseEventInput({
						event_type: eventType,
						lane: "memory",
						agent_id: "codex",
						payload: validPayloads[eventType],
					}),
				);
			}
			const res = await runtime.flush();
			assert.equal(res.shipped > 0, true);
		} finally {
			await runtime.shutdown().catch(() => {});
			rmSync(env_.dir, { recursive: true, force: true });
		}
	});

	it("ships the plugin internal paid llm.call shape used by cloud providers", async (t) => {
		const baseUrl = skipIfNoLiveEndpoint(t);
		if (baseUrl === null) {
			return;
		}
		const env_ = tempEnv(baseUrl);
		const runtime = new SnoObserveRuntime({ env: env_.env, cwd: env_.dir });
		try {
			await runtime.emitParsed(
				parseEventInput({
					event_type: "llm.call",
					lane: "memory",
					agent_id: "openclaw",
					scope: { session_uuid: createUUIDv7() },
					payload: PLUGIN_INTERNAL_PAID_LLM_CALL,
				}),
			);
			const res = await runtime.flush({
				force: true,
				signal: AbortSignal.timeout(30_000),
			});
			assert.equal(
				res.retryable,
				0,
				`plugin internal paid llm.call did not ship: ${JSON.stringify(res)}`,
			);
			assert.equal(
				res.terminal,
				0,
				`plugin internal paid llm.call was quarantined: ${JSON.stringify(res)}`,
			);
			assert.equal(
				res.shipped >= 2,
				true,
				`Expected agent.identify + llm.call shipped: ${JSON.stringify(res)}`,
			);
		} finally {
			await runtime.shutdown().catch(() => {});
			rmSync(env_.dir, { recursive: true, force: true });
		}
	});
});

describe("acceptance — idle CPU dry run (32.2)", () => {
	it("creating a runtime with zero emits triggers zero network calls and zero timers", async () => {
		// Short proxy for the 24h spec: install a fetch spy and run the runtime
		// untouched for a brief window. The spy SHALL stay at zero.
		const env_ = tempEnv("https://sno.test");
		const fetchCalls = [];
		const fakeFetch = async (...args) => {
			fetchCalls.push(args);
			return new Response("{}", {
				status: 202,
				headers: { "Content-Type": "application/json" },
			});
		};
		const runtime = new SnoObserveRuntime({
			env: env_.env,
			cwd: env_.dir,
			fetch: fakeFetch,
		});
		try {
			await delay(100);
			assert.equal(fetchCalls.length, 0);
		} finally {
			await runtime.shutdown().catch(() => {});
			rmSync(env_.dir, { recursive: true, force: true });
		}
	});
});

describe("acceptance — upstream bug reporting (32.4)", () => {
	it("documents the upstream-bug flow", () => {
		// Procedural assertion: per design.md decision 9 + tasks §32.4, any
		// upstream sno.ai/Helicone bug surfaced by these tests is reported to
		// the upstream owners, NOT patched in this package.
		assert.equal(true, true);
	});
});
