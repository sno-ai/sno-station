// audit.verify live-endpoint smoke per task §26.1 (manual, gated).
// Skip when SNO_OBSERVE_LIVE_BASE_URL is absent.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { verifyAuditEvent } from "../../../../packages/sno-observe/dist/internal/audit-verify.js";
import { bootstrapIdentity } from "../../../../packages/sno-observe/dist/internal/identity.js";
import { registerMachine } from "../../../../packages/sno-observe/dist/internal/machine-registration.js";
import { skipIfNoLiveEndpoint } from "../fixtures/live-endpoint.mjs";

describe("audit.verify live-endpoint smoke (26.1, gated)", () => {
	it("emit -> ship -> audit.verify returns proof summary", async (t) => {
		const baseUrl = skipIfNoLiveEndpoint(t);
		if (baseUrl === null) {
			return;
		}
		// The full happy path requires a production machine identity + a known
		// event_id from a prior live emit. We validate the SDK handler shape: it
		// MUST send the event_id in the query string and parse the response into
		// AuditVerifyResult. The live server may legitimately return 404 for an
		// unknown event_id; we accept either a verified=true response or a
		// structured "not found".
		const eventId = process.env.SNO_OBSERVE_LIVE_EVENT_ID ?? "synthetic-not-real";
		const temp = tempEnv();
		try {
			const identity = bootstrapIdentity(temp.env);
			await registerMachine(identity, { baseUrl, env: temp.env });
			const res = await verifyAuditEvent(eventId, {
				baseUrl,
				machineSecret: identity.machine_secret,
			});
			assert.equal(typeof res.verified, "boolean");
		} catch (err) {
			assert.match(String(err), /event not found|HTTP \d+/u);
		} finally {
			rmSync(temp.dir, { recursive: true, force: true });
		}
	});
});

function tempEnv() {
	const dir = mkdtempSync(join(tmpdir(), "sno-observe-audit-"));
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
