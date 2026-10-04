// Review finding 2026-10-04 (machine-account-binding): two events the server refuses every time
// must not make each flush open new chain epochs and resend identifies. Real SQLite, fake server only.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import DatabaseConstructor from "better-sqlite3";
import { createSnoObserve } from "../../../../packages/observability/dist/index.js";
import { cleanupTempSnoEnv, createTempSnoEnv, validPayloads } from "../fixtures/temp-env.mjs";

const json = (body, status) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("refused rows do not churn", () => {
	it("two events refused every time cost a bounded number of requests and new epochs per flush", async () => {
		const temp = createTempSnoEnv("sno-observe-two-refused-");
		const previousProfile = process.env.SNO_PROFILE_DIR;
		process.env.SNO_PROFILE_DIR = temp.dir;
		const refused = new Set();
		const posted = [];
		const fetch = async (url, init) => {
			const body = JSON.parse(String(init.body));
			if (String(url).endsWith("/api/v1/identity/register-machine")) {
				return json({ user_cuid: body.user_cuid, machine_uuid: body.machine_uuid, claimed: false }, 200);
			}
			posted.push(body);
			return refused.has(body.event_id) ? json({ error: "event_body_too_large" }, 413) : json({ receipt_id: body.event_id }, 202);
		};
		const memory = () => ({ event_type: "memory.write", lane: "memory", agent_id: "claude-code", payload: validPayloads["memory.write"] });
		const observe = createSnoObserve({ env: temp.env, cwd: temp.dir, fetch });
		try {
			const ids = [];
			for (let index = 0; index < 5; index++) {
				const id = (await observe.emit(memory())).eventId;
				ids.push(id);
				if (index === 0 || index === 2) refused.add(id);
			}
			for (let flush = 0; flush < 3; flush++) {
				await observe.flush({ force: true });
				const db = new DatabaseConstructor(temp.env.SNO_BUFFER_PATH);
				db.prepare("UPDATE chain_retry SET retry_not_before = 0").run();
				db.close();
			}
			const db = new DatabaseConstructor(temp.env.SNO_BUFFER_PATH, { readonly: true });
			const epochs = db.prepare("SELECT COALESCE(MAX(chain_epoch), 0) AS value FROM events").get().value;
			db.close();
			// 5 rows, 2 refused forever: three flushes need a handful of requests and epochs, not hundreds.
			assert.equal(posted.length <= 30, true, `posted ${posted.length} requests in 3 flushes`);
			assert.equal(epochs <= 6, true, `chain epoch grew to ${epochs}`);
			for (const id of ids.filter((value) => !refused.has(value))) {
				assert.equal(posted.some((envelope) => envelope.event_id === id), true);
			}
		} finally {
			await observe.shutdown();
			if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR;
			else process.env.SNO_PROFILE_DIR = previousProfile;
			cleanupTempSnoEnv(temp);
		}
	});
});
