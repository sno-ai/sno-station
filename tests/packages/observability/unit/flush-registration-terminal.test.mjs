import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BufferStore } from "../../../../packages/sno-observe/dist/internal/buffer-store.js";
import { bootstrapIdentity } from "../../../../packages/sno-observe/dist/internal/identity.js";
import { SnoObserveRuntime } from "../../../../packages/sno-observe/dist/internal/runtime.js";
import { parseEventInput } from "../../../../packages/sno-observe/dist/internal/schemas.js";
import { cleanupTempSnoEnv, createTempSnoEnv } from "../fixtures/temp-env.mjs";

const hashA = "a".repeat(64);

function memoryWriteEvent() {
	return parseEventInput({
		event_type: "memory.write",
		lane: "memory",
		agent_id: "codex",
		payload: {
			key_hash: hashA,
			byte_len: 1,
			content_tokens: 1,
			tokens_method: "char_approximation",
		},
	});
}

describe("flush registration terminal errors", () => {
	it("quarantines pending rows instead of retrying terminal register-machine conflicts", async () => {
		const temp = createTempSnoEnv("sno-observe-register-terminal-");
		const identity = bootstrapIdentity(temp.env);
		let eventPostCalls = 0;
		const runtime = new SnoObserveRuntime({
			env: temp.env,
			cwd: temp.dir,
			fetch: async (url) => {
				if (String(url).endsWith("/api/v1/identity/register-machine")) {
					return new Response(JSON.stringify({ error: "machine_secret_conflict" }), {
						status: 409,
						headers: { "Content-Type": "application/json" },
					});
				}
				eventPostCalls += 1;
				return new Response(JSON.stringify({ receipt_id: "should-not-post" }), {
					status: 202,
					headers: { "Content-Type": "application/json" },
				});
			},
		});
		try {
			await runtime.emitParsed(memoryWriteEvent());
			const result = await runtime.flush();
			assert.equal(result.shipped, 0);
			assert.equal(result.retryable, 0);
			assert.equal(result.terminal, 2);
			assert.equal(eventPostCalls, 0);

			const store = new BufferStore(temp.env.SNO_BUFFER_PATH);
			try {
				const rows = store.getAllRows();
				assert.equal(rows.length, 2);
				assert.equal(rows.every((row) => row.terminal === 1), true);
				assert.equal(rows.every((row) => row.shipped === 0), true);
				assert.equal(rows[0].machine_id, identity.machine_uuid);
			} finally {
				store.close();
			}
		} finally {
			await runtime.shutdown().catch(() => {});
			cleanupTempSnoEnv(temp);
		}
	});
});
