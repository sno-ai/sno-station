import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createCuid2 } from "../../../../packages/common-core/dist/index.js";
import { claimMachine } from "../../../../packages/sno-observe/dist/internal/device-claim.js";
import { bootstrapIdentity } from "../../../../packages/sno-observe/dist/internal/identity.js";
import { cleanupTempSnoEnv, createTempSnoEnv } from "../fixtures/temp-env.mjs";

const accountCuid = createCuid2();

describe("device claim", () => {
	it("throws if identity changes before the claim can be persisted", async () => {
		const temp = createTempSnoEnv("sno-observe-claim-identity-");
		const identity = bootstrapIdentity(temp.env);
		try {
			await assert.rejects(
				() =>
					claimMachine(identity, {
						env: temp.env,
						fetch: createClaimFetch({
							onToken() {
								writeFileSync(
									temp.env.SNO_IDENTITY_PATH,
									`${JSON.stringify({ ...identity, user_cuid: "other_user" }, null, 2)}\n`,
								);
							},
						}),
					}),
				(error) => {
					assert.equal(error.code, "claim_identity_changed");
					return true;
				},
			);

			const saved = JSON.parse(readFileSync(temp.env.SNO_IDENTITY_PATH, "utf8"));
			assert.equal(saved.user_cuid, "other_user");
			assert.equal(saved.user_account_id, undefined);
		} finally {
			cleanupTempSnoEnv(temp);
		}
	});

	it("honors AbortSignal while waiting for device authorization", async () => {
		const temp = createTempSnoEnv("sno-observe-claim-abort-");
		const identity = bootstrapIdentity(temp.env);
		const controller = new AbortController();
		let sawTokenSignal = false;
		try {
			await assert.rejects(
				() =>
					claimMachine(identity, {
						env: temp.env,
						fetch: createClaimFetch({
							onToken(_body, init) {
								sawTokenSignal = init?.signal instanceof AbortSignal;
								setTimeout(() => controller.abort(), 0);
								return { status: 400, body: { error: "authorization_pending" } };
							},
						}),
						pollIntervalMs: 10000,
						signal: controller.signal,
					}),
				(error) => {
					assert.equal(error.code, "claim_aborted");
					return true;
				},
			);
			assert.equal(sawTokenSignal, true);
		} finally {
			cleanupTempSnoEnv(temp);
		}
	});

	it("retries a transient token polling network error", async () => {
		const temp = createTempSnoEnv("sno-observe-claim-network-");
		const identity = bootstrapIdentity(temp.env);
		let tokenCalls = 0;
		try {
			const result = await claimMachine(identity, {
				env: temp.env,
				fetch: createClaimFetch({
					onToken() {
						tokenCalls += 1;
						if (tokenCalls === 1) {
							throw new TypeError("socket hang up");
						}
						return { status: 200, body: claimedBody() };
					},
				}),
				pollIntervalMs: 1,
				timeoutMs: 5000,
			});

			assert.equal(result.userAccountId, accountCuid);
			assert.equal(tokenCalls, 2);
			const saved = JSON.parse(readFileSync(temp.env.SNO_IDENTITY_PATH, "utf8"));
			assert.equal(saved.user_account_id, accountCuid);
		} finally {
			cleanupTempSnoEnv(temp);
		}
	});

	it("accepts device authorization responses without optional fields", async () => {
		const temp = createTempSnoEnv("sno-observe-claim-minimal-code-");
		const identity = bootstrapIdentity(temp.env);
		let claimCode;
		try {
			const result = await claimMachine(identity, {
				env: temp.env,
				fetch: createClaimFetch({
					deviceCodeBody: {
						verification_uri_complete: undefined,
						interval: undefined,
					},
				}),
				onCode(code) {
					claimCode = code;
				},
				timeoutMs: 5000,
			});

			assert.equal(result.userAccountId, accountCuid);
			assert.equal(claimCode.verificationUriComplete, undefined);
			assert.equal(claimCode.interval, 5);
		} finally {
			cleanupTempSnoEnv(temp);
		}
	});

	it("rejects an unusable device authorization URL", async () => {
		const temp = createTempSnoEnv("sno-observe-claim-bad-url-");
		const identity = bootstrapIdentity(temp.env);
		try {
			await assert.rejects(
				() =>
					claimMachine(identity, {
						env: temp.env,
						fetch: createClaimFetch({
							deviceCodeBody: {
								verification_uri: "http://www.sno.ai/cli/connect",
							},
						}),
					}),
				(error) => {
					assert.equal(error.code, "claim_failed");
					assert.match(error.message, /device code request failed/u);
					return true;
				},
			);
		} finally {
			cleanupTempSnoEnv(temp);
		}
	});

	it("rejects non-positive device authorization timing", async () => {
		const temp = createTempSnoEnv("sno-observe-claim-bad-timing-");
		const identity = bootstrapIdentity(temp.env);
		try {
			await assert.rejects(
				() =>
					claimMachine(identity, {
						env: temp.env,
						fetch: createClaimFetch({
							deviceCodeBody: {
								expires_in: 0,
								interval: 0,
							},
						}),
					}),
				(error) => {
					assert.equal(error.code, "claim_failed");
					assert.match(error.message, /device code request failed/u);
					return true;
				},
			);
		} finally {
			cleanupTempSnoEnv(temp);
		}
	});
});

function createClaimFetch({ deviceCodeBody, onToken } = {}) {
	return async (url, init) => {
		const path = new URL(String(url)).pathname;
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
		if (path === "/api/v1/identity/register-machine") {
			return jsonResponse(
				{
					user_cuid: body.user_cuid,
					machine_uuid: body.machine_uuid,
					claimed: false,
				},
				200,
			);
		}
		if (path === "/api/v1/device/code") {
			return jsonResponse(
				{
					device_code: "dev_code",
					user_code: "SNO-CODE",
					verification_uri: "https://www.sno.ai/cli/connect",
					verification_uri_complete: "https://www.sno.ai/cli/connect?code=SNO-CODE",
					expires_in: 1800,
					interval: 1,
					...deviceCodeBody,
				},
				200,
			);
		}
		if (path === "/api/v1/device/token") {
			const response = onToken?.(body, init) ?? { status: 200, body: claimedBody() };
			return jsonResponse(response.body, response.status);
		}
		return jsonResponse({ error: "not_found" }, 404);
	};
}

function claimedBody() {
	return { user_account_id: accountCuid };
}

function jsonResponse(body, status) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
