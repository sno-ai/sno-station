// Consent.change always ships when value changes (task §21.8).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SnoObserveRuntime } from "../../../../packages/sno-observe/dist/internal/runtime.js";
import { createFetchRecorder } from "../fixtures/temp-env.mjs";

function tempEnv() {
	const dir = mkdtempSync(join(tmpdir(), "sno-observe-consent-"));
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

describe("consent.change always ships when value changes (21.8)", () => {
	it("metadata-only -> off ships consent.change", async () => {
		const t = tempEnv();
		const { calls, fetch } = createFetchRecorder();
		const runtime = new SnoObserveRuntime({ env: t.env, cwd: t.dir, fetch });
		try {
			await runtime.setConsent("off", "test-1");
			const eventTypes = calls.map((c) => JSON.parse(c.body).event_type);
			assert.equal(eventTypes.includes("consent.change"), true, JSON.stringify(eventTypes));
		} finally {
			await runtime.shutdown().catch(() => {});
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("off -> metadata-only ships consent.change", async () => {
		const t = tempEnv();
		const { calls, fetch } = createFetchRecorder();
		const runtime = new SnoObserveRuntime({ env: t.env, cwd: t.dir, fetch });
		try {
			await runtime.setConsent("off", "go-off");
			const before = calls.length;
			await runtime.setConsent("metadata-only", "back-on");
			await runtime.flush();
			const consentPosts = calls
				.slice(before)
				.map((c) => JSON.parse(c.body))
				.filter((e) => e.event_type === "consent.change");
			assert.equal(consentPosts.length >= 1, true);
		} finally {
			await runtime.shutdown().catch(() => {});
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("metadata-only -> full ships consent.change", async () => {
		const t = tempEnv();
		const { calls, fetch } = createFetchRecorder();
		const runtime = new SnoObserveRuntime({ env: t.env, cwd: t.dir, fetch });
		try {
			await runtime.setConsent("full", "elevate");
			await runtime.flush();
			const consentPosts = calls
				.map((c) => JSON.parse(c.body))
				.filter((e) => e.event_type === "consent.change");
			assert.equal(consentPosts.length >= 1, true);
		} finally {
			await runtime.shutdown().catch(() => {});
			rmSync(t.dir, { recursive: true, force: true });
		}
	});
});
