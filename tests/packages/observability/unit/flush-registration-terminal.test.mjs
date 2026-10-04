import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SnoObserveRuntime } from "../../../../packages/observability/dist/internal/runtime.js";
import { parseEventInput } from "../../../../packages/observability/dist/internal/schemas.js";
import { cleanupTempSnoEnv, createTempSnoEnv, validPayloads } from "../fixtures/temp-env.mjs";

describe("flush registration refused", () => {
	it("still ships every row and says so in the log", async () => {
		const temp = createTempSnoEnv("sno-observe-register-refused-");
		const previousProfile = process.env.SNO_PROFILE_DIR;
		process.env.SNO_PROFILE_DIR = temp.dir;
		const posted = [];
		const fetch = async (url, init) => {
			const body = JSON.parse(String(init.body));
			if (String(url).endsWith("/api/v1/identity/register-machine")) {
				return new Response(JSON.stringify({ error: "machine_secret_conflict" }), {
					status: 409,
					headers: { "Content-Type": "application/json" },
				});
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
			const result = await runtime.flush();
			assert.deepEqual(
				{ shipped: result.shipped, terminal: result.terminal, retryable: result.retryable },
				{ shipped: 2, terminal: 0, retryable: 0 },
			);
			assert.deepEqual(posted, ["agent.identify", "memory.write"]);
			const log = readFileSync(join(temp.dir, "observe.log"), "utf8");
			assert.equal(log.includes('"level":"error"') && log.includes("machine_secret_conflict"), true);
		} finally {
			await runtime.shutdown().catch(() => {});
			if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR;
			else process.env.SNO_PROFILE_DIR = previousProfile;
			cleanupTempSnoEnv(temp);
		}
	});
});
