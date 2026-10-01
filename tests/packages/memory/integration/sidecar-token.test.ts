import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRemSidecar } from "../../../../packages/memory/src/sidecar/server";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db";
import { writeSettingsFixture } from "../fixtures/settings-file-fixture";

const previousProfile = process.env.SNO_PROFILE_DIR;
const database = createTestDb();
const stateDir = mkdtempSync(join(tmpdir(), "sidecar-token-"));
let server: Awaited<ReturnType<typeof startRemSidecar>>;
let token: string;
const url = (path: string): string => `http://127.0.0.1:${server.port}${path}`;
const inspect = { scope: { principal: "caller", project: "global", session: "token" }, op: { op: "list" } };
const post = (headers: Record<string, string>): Promise<Response> =>
	fetch(url("/v1/inspect"), { method: "POST", headers, body: JSON.stringify(inspect), signal: AbortSignal.timeout(10_000) });

beforeAll(async () => {
	process.env.SNO_PROFILE_DIR = stateDir;
	writeSettingsFixture(stateDir, { mode: "local-first", rerank: { mode: "none" },
		store: { path: database.dbPath, encryptionKey: database.encryptionKey } });
	server = await startRemSidecar();
	token = JSON.parse(readFileSync(join(stateDir, "station", "sidecar.json"), "utf8")).token;
});
afterAll(async () => {
	await server?.stop();
	database.cleanup();
	rmSync(stateDir, { recursive: true, force: true });
	if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR;
	else process.env.SNO_PROFILE_DIR = previousProfile;
});

describe("sidecar token", () => {
	it("refuses a missing or wrong token with 401 and an empty body on every non-health route", async () => {
		for (const headers of [{}, { "x-sidecar-token": "0".repeat(64) }, { Authorization: `Bearer ${token}` }]) {
			const response = await post(headers);
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({});
		}
		expect((await fetch(url("/rem/jobs/x"), { signal: AbortSignal.timeout(10_000) })).status).toBe(401);
	});

	it("serves a normal route with the discovery token", async () => {
		const response = await post({ "x-sidecar-token": token });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ degraded: false, result: { op: "list", project: "global", entries: [] } });
	});

	it("serves /healthz without a token and without the user name or store path", async () => {
		const response = await fetch(url("/healthz"), { signal: AbortSignal.timeout(10_000) });
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(Object.keys(body).sort()).toEqual(["accessCounters", "log_level", "status"]);
		expect(JSON.stringify(body)).not.toContain(database.dbPath);
	});
});
