import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createSnoObserve } from "../../../../packages/sno-observe/dist/index.js";
import { BufferStore } from "../../../../packages/sno-observe/dist/internal/buffer-store.js";
import { exportEvents } from "../../../../packages/sno-observe/dist/internal/export.js";
import { validPayloads, scope } from "../fixtures/temp-env.mjs";

function tempEnv() {
	const dir = mkdtempSync(join(tmpdir(), "sno-observe-api-"));
	return {
		dir,
		env: {
			SNO_HOME: dir,
			SNO_IDENTITY_PATH: join(dir, "identity.json"),
			SNO_BUFFER_PATH: join(dir, "buffer.db"),
			SNO_CONSENT_PATH: join(dir, "state", "consent.json"),
			SNO_TOKEN_PATH: join(dir, "state", "tokens.json"),
			SNO_OBSERVE_BASE_URL: "https://custom.sno.test/base",
			SNO_API_KEY: "test-api-key",
			HOME: dir,
		},
	};
}

describe("public API routing and export inference", () => {
	it("routes audit.verify through runtime env and fetch options", async () => {
		const t = tempEnv();
		const calls = [];
		const observe = createSnoObserve({
			env: t.env,
			cwd: t.dir,
			fetch: async (url, init) => {
				calls.push({ url: String(url), authorization: init.headers.Authorization });
				return new Response(JSON.stringify({ verified: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
		});
		try {
			const result = await observe.audit.verify("event 1");
			assert.equal(result.verified, true);
			assert.deepEqual(calls, [
				{
					url: "https://custom.sno.test/base/api/v1/audit/verify?event_id=event%201",
					authorization: "Bearer test-api-key",
				},
			]);
		} finally {
			await observe.shutdown().catch(() => {});
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("infers jsonl format from .jsonl export paths", () => {
		const dir = mkdtempSync(join(tmpdir(), "sno-observe-export-"));
		const store = new BufferStore(join(dir, "buffer.db"));
		try {
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
			const result = exportEvents(store, { path: join(dir, "events.jsonl") });
			assert.equal(result.format, "jsonl");
			const data = result.data;
			assert.equal(data instanceof Uint8Array, true);
			assert.equal(
				new TextDecoder().decode(data).includes("\"event_type\":\"agent.identify\""),
				true,
			);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
