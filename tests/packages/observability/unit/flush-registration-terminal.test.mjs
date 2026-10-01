import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BufferStore } from "../../../../packages/observability/dist/internal/buffer-store.js";
import { SnoObserveRuntime } from "../../../../packages/observability/dist/internal/runtime.js";
import { parseEventInput } from "../../../../packages/observability/dist/internal/schemas.js";
import { cleanupTempSnoEnv, createTempSnoEnv, validPayloads } from "../fixtures/temp-env.mjs";

describe("flush registration refused", () => {
	it("keeps every row pending, says so in the log, and ships once the server relents", async () => {
		const temp = createTempSnoEnv("sno-observe-register-terminal-");
		const previousProfile = process.env.SNO_PROFILE_DIR;
		process.env.SNO_PROFILE_DIR = temp.dir;
		let refuse = true;
		const posted = [];
		const fetch = async (url, init) => {
			const body = JSON.parse(String(init.body));
			if (String(url).endsWith("/api/v1/identity/register-machine")) {
				if (refuse) {
					return new Response(JSON.stringify({ error: "machine_secret_conflict" }), {
						status: 409,
						headers: { "Content-Type": "application/json" },
					});
				}
				return new Response(
					JSON.stringify({ user_cuid: body.user_cuid, machine_uuid: body.machine_uuid, claimed: false }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			posted.push(body.event_type);
			return new Response(JSON.stringify({ receipt_id: body.event_id }), {
				status: 202,
				headers: { "Content-Type": "application/json" },
			});
		};
		const runtime = new SnoObserveRuntime({ env: temp.env, cwd: temp.dir, fetch });
		try {
			await runtime.emitParsed(
				parseEventInput({ event_type: "memory.write", lane: "memory", agent_id: "codex", payload: validPayloads["memory.write"] }),
			);
			const refused = await runtime.flush();
			assert.deepEqual({ shipped: refused.shipped, terminal: refused.terminal }, { shipped: 0, terminal: 0 });
			assert.equal(refused.retryable >= 1, true);
			assert.equal(posted.length, 0);
			const log = readFileSync(join(temp.dir, "observe.log"), "utf8");
			assert.equal(log.includes('"level":"error"') && log.includes("machine_secret_conflict"), true);
			await runtime.shutdown();

			refuse = false;
			const store = new BufferStore(temp.env.SNO_BUFFER_PATH);
			try {
				assert.equal(store.countPending(), 2);
				store.clearElapsedRetryDeadline(Date.now() + 60_000);
			} finally {
				store.close();
			}
			const restarted = new SnoObserveRuntime({ env: temp.env, cwd: temp.dir, fetch });
			try {
				const result = await restarted.flush();
				assert.deepEqual({ shipped: result.shipped, retryable: result.retryable }, { shipped: 2, retryable: 0 });
				assert.deepEqual(posted, ["agent.identify", "memory.write"]);
			} finally {
				await restarted.shutdown();
			}
		} finally {
			await runtime.shutdown().catch(() => {});
			if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR;
			else process.env.SNO_PROFILE_DIR = previousProfile;
			cleanupTempSnoEnv(temp);
		}
	});
});
