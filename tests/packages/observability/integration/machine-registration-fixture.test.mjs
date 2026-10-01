import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createCuid2, createUUIDv7 } from "../../../../packages/common-core/dist/index.js";
import {
	machineSecretHash,
	registerMachine,
} from "../../../../packages/observability/dist/internal/machine-registration.js";
import { bootstrapIdentity } from "../../../../packages/observability/dist/internal/identity.js";
import { skipIfNoLiveEndpoint } from "../fixtures/live-endpoint.mjs";

function tempEnv() {
	const dir = mkdtempSync(join(tmpdir(), "sno-observe-machine-"));
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

function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("anonymous machine registration - fixture paths", () => {
	it("register-machine sends only the hash and returns the anonymous identity", async () => {
		const t = tempEnv();
		try {
			const id = bootstrapIdentity(t.env);
			const calls = [];
			const result = await registerMachine(id, {
				baseUrl: "https://sno.test",
				env: t.env,
				fetch: async (url, init) => {
					calls.push({ url: String(url), init });
					const body = JSON.parse(String(init.body));
					return jsonResponse({
						user_cuid: body.user_cuid,
						machine_uuid: body.machine_uuid,
						claimed: false,
					});
				},
			});
			assert.deepEqual(result, {
				registered: true,
				claimed: false,
				userCuid: id.user_cuid,
				machineUuid: id.machine_uuid,
			});
			assert.equal(calls.length, 1);
			assert.equal(calls[0].url, "https://sno.test/api/v1/identity/register-machine");
			assert.equal(calls[0].init.headers.Authorization, undefined);
			const body = JSON.parse(String(calls[0].init.body));
			assert.deepEqual(Object.keys(body).sort(), [
				"machine_secret_hash",
				"machine_uuid",
				"user_cuid",
			]);
			assert.equal(body.machine_secret_hash, machineSecretHash(id.machine_secret));
			assert.equal(String(calls[0].init.body).includes(id.machine_secret), false);
		} finally {
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("second registration reuses the same local identity and remains idempotent", async () => {
		const t = tempEnv();
		try {
			const calls = [];
			const fetchImpl = async (url, init) => {
				calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
				const body = JSON.parse(String(init.body));
				return jsonResponse({
					user_cuid: body.user_cuid,
					machine_uuid: body.machine_uuid,
					claimed: false,
				});
			};
			const first = bootstrapIdentity(t.env);
			await registerMachine(first, { baseUrl: "https://sno.test", env: t.env, fetch: fetchImpl });
			const second = bootstrapIdentity(t.env);
			await registerMachine(second, { baseUrl: "https://sno.test", env: t.env, fetch: fetchImpl });

			assert.deepEqual(first, second);
			assert.equal(calls.length, 2);
			assert.deepEqual(calls[0].body, calls[1].body);
		} finally {
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("rejects a register-machine response without claimed state", async () => {
		const t = tempEnv();
		try {
			const id = bootstrapIdentity(t.env);
			await assert.rejects(
				() =>
					registerMachine(id, {
						baseUrl: "https://sno.test",
						env: t.env,
						fetch: async () =>
							jsonResponse({
								user_cuid: id.user_cuid,
								machine_uuid: id.machine_uuid,
							}),
					}),
				(error) =>
					error instanceof Error &&
					"code" in error &&
					error.code === "machine_registration_failed",
			);
		} finally {
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("registration conflict surfaces the server error code", async () => {
		const t = tempEnv();
		try {
			const id = bootstrapIdentity(t.env);
			await assert.rejects(
				() =>
					registerMachine(id, {
						baseUrl: "https://sno.test",
						env: t.env,
						fetch: async () =>
							jsonResponse(
								{ error: "machine_secret_mismatch", message: "machine secret mismatch" },
								409,
							),
					}),
				(error) =>
					error instanceof Error &&
					"code" in error &&
					error.code === "machine_secret_mismatch" &&
					/machine secret mismatch/u.test(error.message),
			);
		} finally {
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("rejects a register-machine response that echoes a different identity", async () => {
		const t = tempEnv();
		try {
			const id = bootstrapIdentity(t.env);
			await assert.rejects(
				() =>
					registerMachine(id, {
						baseUrl: "https://sno.test",
						env: t.env,
						fetch: async () =>
							jsonResponse({
								user_cuid: createCuid2(),
								machine_uuid: createUUIDv7(),
								claimed: false,
							}),
					}),
				(error) =>
					error instanceof Error &&
					"code" in error &&
					error.code === "machine_registration_identity_mismatch" &&
					/different identity/u.test(error.message),
			);
		} finally {
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("persists a valid account id when register-machine returns one", async () => {
		const t = tempEnv();
		try {
			const id = bootstrapIdentity(t.env);
			const accountCuid = createCuid2();
			const result = await registerMachine(id, {
				baseUrl: "https://sno.test",
				env: t.env,
				fetch: async () =>
					jsonResponse({
						user_cuid: id.user_cuid,
						machine_uuid: id.machine_uuid,
						claimed: true,
						user_account_id: accountCuid,
					}),
			});

			assert.equal(result.userAccountId, accountCuid);
			const saved = JSON.parse(readFileSync(t.env.SNO_IDENTITY_PATH, "utf8"));
			assert.equal(saved.user_account_id, accountCuid);
		} finally {
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("accepts a claimed register-machine response without account id", async () => {
		const t = tempEnv();
		try {
			const id = bootstrapIdentity(t.env);
			const result = await registerMachine(id, {
				baseUrl: "https://sno.test",
				env: t.env,
				fetch: async () =>
					jsonResponse({
						user_cuid: id.user_cuid,
						machine_uuid: id.machine_uuid,
						claimed: true,
					}),
			});

			assert.equal(result.claimed, true);
			assert.equal(result.userAccountId, undefined);
			const saved = JSON.parse(readFileSync(t.env.SNO_IDENTITY_PATH, "utf8"));
			assert.equal(saved.user_account_id, undefined);
		} finally {
			rmSync(t.dir, { recursive: true, force: true });
		}
	});
});

describe("anonymous machine registration - live endpoint (gated)", () => {
	it("registers against the live endpoint when SNO_OBSERVE_LIVE_BASE_URL is set", async (t) => {
		const baseUrl = skipIfNoLiveEndpoint(t);
		if (baseUrl === null) {
			return;
		}
		const env_ = tempEnv();
		try {
			const id = bootstrapIdentity(env_.env);
			const result = await registerMachine(id, {
				baseUrl,
				env: env_.env,
			});
			assert.equal(result.registered, true);
			assert.equal(result.userCuid, id.user_cuid);
			assert.equal(result.machineUuid, id.machine_uuid);
			assert.equal(typeof result.claimed, "boolean");
		} finally {
			rmSync(env_.dir, { recursive: true, force: true });
		}
	});
});
