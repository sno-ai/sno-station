// Consent.change always ships when value changes (task §21.8).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BufferStore } from "../../../../packages/sno-observe/dist/internal/buffer-store.js";
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
			const resumePosts = calls.slice(before).map((c) => JSON.parse(c.body));
			const consentPosts = resumePosts.filter((e) => e.event_type === "consent.change");
			assert.equal(consentPosts.length >= 1, true);
			assert.deepEqual(
				resumePosts.map((e) => e.event_type),
				["agent.identify", "consent.change"],
			);
			assert.equal(resumePosts[0].chain_epoch, resumePosts[1].chain_epoch);
			assert.equal(resumePosts[0].seq, 0);
			assert.equal(resumePosts[1].seq, 1);
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				const rows = store.getAllRows();
				const postedEpoch = resumePosts[0].chain_epoch;
				const blockedPredecessors = rows.filter(
					(row) =>
						row.chain_epoch === postedEpoch && row.seq < resumePosts[1].seq && row.terminal === 1,
				);
				assert.deepEqual(blockedPredecessors, []);
			} finally {
				store.close();
			}
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

	it("persists consent even when the transition flush cannot ship", async () => {
		const t = tempEnv();
		const runtime = new SnoObserveRuntime({
			env: t.env,
			cwd: t.dir,
			fetch: async (url, init) => {
				if (String(url).endsWith("/api/v1/identity/register-machine")) {
					return registerMachineResponse(init);
				}
				return new Response(JSON.stringify({ error: "unavailable" }), {
					status: 503,
					headers: { "Content-Type": "application/json" },
				});
			},
		});
		try {
			const result = await runtime.setConsent("off", "network-down");
			assert.equal(result, "off");
			assert.equal(runtime.getConsent(), "off");
		} finally {
			await runtime.shutdown().catch(() => {});
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("preserves paused prior consent across failed pause flush and fresh resume", async () => {
		const t = tempEnv();
		const fetch = async (url, init) => {
			if (String(url).endsWith("/api/v1/identity/register-machine")) {
				return registerMachineResponse(init);
			}
			return new Response(JSON.stringify({ error: "unavailable" }), {
				status: 503,
				headers: { "Content-Type": "application/json" },
			});
		};
		const firstRuntime = new SnoObserveRuntime({ env: t.env, cwd: t.dir, fetch });
		try {
			assert.equal(await firstRuntime.setConsent("full", "start-full"), "full");
			assert.equal(await firstRuntime.pause(), "off");
			assert.equal(firstRuntime.getConsent(), "off");
			await firstRuntime.shutdown().catch(() => {});

			const resumedRuntime = new SnoObserveRuntime({ env: t.env, cwd: t.dir, fetch });
			try {
				assert.equal(await resumedRuntime.resume(), "full");
				assert.equal(resumedRuntime.getConsent(), "full");
			} finally {
				await resumedRuntime.shutdown().catch(() => {});
			}
		} finally {
			await firstRuntime.shutdown().catch(() => {});
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
