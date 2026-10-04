import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, connectReporting } from "../../../../packages/memory/src/contract/client";
import { parseOutput } from "../../../../packages/memory/src/contract/index";
import { readProviderAuthority, resolveProviderAuthority } from "../../../../packages/memory/src/engine/provider/provider-authority";
import { PERSISTED_PROVIDER_SYSTEM } from "../../../../packages/memory/src/model/signed-registry-constants";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { startRemSidecar } from "../../../../packages/memory/src/sidecar/server";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db";
import { bindTestMemory } from "../../../apps/mem-claw/helpers/memory-sidecar-fixture";
import { writeSettingsFixture } from "../fixtures/settings-file-fixture";

const previousProfile = process.env.SNO_PROFILE_DIR;
const database = createTestDb();
const root = mkdtempSync(join(tmpdir(), "project-reporting-"));
const userId = "01930000-0000-7000-8000-000000000001";
const otherUserId = "01930000-0000-7000-8000-000000000002";
const workspace = join(root, "one", "same-name");
const emptyWorkspace = join(root, "two", "same-name");
const unknownWorkspace = join(root, "unseen");
const scope = { principal: "untrusted-caller", project: unknownWorkspace, session: "report", host: { workspace: unknownWorkspace } };
let server: Awaited<ReturnType<typeof startRemSidecar>> | undefined;
let store: MemoryStore;
let projectId: string;
let emptyProjectId: string;
let token: string;

function snapshot(): unknown {
	const tables = database.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
	return tables.map(({ name }) => ({ name, rows: database.sqlite.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() }));
}

async function inspect(op: unknown): Promise<ReturnType<typeof parseOutput<"inspect">>> {
	const response = await fetch(`http://127.0.0.1:${server?.port}/v1/inspect`, {
		method: "POST", headers: { "content-type": "application/json", "x-sidecar-token": token, "x-sno-station-mem-skin": "reporting-without-init" },
		body: JSON.stringify({ op, scope }), signal: AbortSignal.timeout(30_000),
	});
	expect(response.status).toBe(200);
	return parseOutput("inspect", await response.json());
}

beforeAll(async () => {
	process.env.SNO_PROFILE_DIR = root;
	writeSettingsFixture(root, { user: { id: userId }, mode: "local-first", rerank: { mode: "none" },
		embedding: { cacheDir: "" }, store: { path: database.dbPath, encryptionKey: database.encryptionKey } });
	bindTestMemory(root, database.dbPath, {}, database.encryptionKey);
	store = new MemoryStore({ dbPath: database.dbPath, vectorDim: 1024 });
	const authority = { trustedUserId: userId, externalSystem: PERSISTED_PROVIDER_SYSTEM, agentKey: "fixture-agent" };
	projectId = (await resolveProviderAuthority(store, { ...authority, projectKey: workspace })).projectId;
	emptyProjectId = (await resolveProviderAuthority(store, { ...authority, projectKey: emptyWorkspace })).projectId;
	const otherProject = await resolveProviderAuthority(store, { ...authority, trustedUserId: otherUserId, projectKey: join(root, "other-user") });
	server = await startRemSidecar();
	token = JSON.parse(readFileSync(join(root, "station", "sidecar.json"), "utf8")).token;
	await inspect({ op: "storage" });
	const insert = database.sqlite.prepare("INSERT INTO nodix_memories(id, fact_id, text, category, project_id, timestamp, timezone, metadata, content_hash, lane) VALUES (?, ?, ?, 'lesson', ?, 1, 'UTC', '{}', ?, ?)");
	for (const [id, project, lane] of [["active", projectId, "active"], ["parked", projectId, "parked"], ["general", "global", "active"], ["unmapped", "unmapped-project", "active"], ["other", otherProject.projectId, "active"]]) {
		insert.run(id, id, `Reporting fixture ${id}`, project, id, lane);
	}
});

afterAll(async () => {
	await server?.stop();
	store?.close();
	database.cleanup();
	rmSync(root, { recursive: true, force: true });
	if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR;
	else process.env.SNO_PROFILE_DIR = previousProfile;
});

describe("read-only project reporting", () => {
	it("returns unknown for an unseen directory without provisioning any data", async () => {
		const before = snapshot();
		const output = await inspect({ op: "currentProject", workspace: unknownWorkspace });
		expect(output).toEqual({ degraded: false, result: { op: "currentProject", workspace: unknownWorkspace, status: "unknown", project: null } });
		expect(snapshot()).toEqual(before);
		process.stdout.write(`reporting unknown ${JSON.stringify(output)}\n`);
	});

	it("lists empty mapped projects, separate same-name paths, general and unresolved memory", async () => {
		const before = snapshot();
		const output = await inspect({ op: "projects" });
		expect(output.degraded).toBe(false);
		if (output.result.op !== "projects") throw new Error("Missing project catalog");
		expect(output.result.projects).toEqual(expect.arrayContaining([
			{ projectId, workspace, memoryCount: 2, kind: "project" },
			{ projectId: emptyProjectId, workspace: emptyWorkspace, memoryCount: 0, kind: "project" },
			{ projectId: "global", workspace: null, memoryCount: 1, kind: "general" },
			{ projectId: "unmapped-project", workspace: null, memoryCount: 1, kind: "project" },
		]));
		expect(output.result.projects).toHaveLength(4);
		expect(snapshot()).toEqual(before);
		process.stdout.write(`reporting catalog ${JSON.stringify(output)}\n`);
	});

	it("resolves the engine's normalized existing workspace without adding a reporting agent", async () => {
		const before = snapshot();
		const output = await inspect({ op: "currentProject", workspace: join(workspace, "nested", "..") });
		expect(output).toEqual({ degraded: false, result: { op: "currentProject", workspace, status: "known",
			project: { projectId, workspace, memoryCount: 2, kind: "project" } } });
		expect(await inspect({ op: "currentProject", workspace: emptyWorkspace })).toEqual({ degraded: false,
			result: { op: "currentProject", workspace: emptyWorkspace, status: "known",
				project: { projectId: emptyProjectId, workspace: emptyWorkspace, memoryCount: 0, kind: "project" } } });
		await expect(readProviderAuthority(store, { trustedUserId: userId, externalSystem: PERSISTED_PROVIDER_SYSTEM,
			projectKey: workspace, agentKey: "reporting-without-init" })).rejects.toThrow("membership is required");
		expect(snapshot()).toEqual(before);
		process.stdout.write(`reporting current ${JSON.stringify(output)}\n`);
	});

	it("supports the public client and existing stats without init or mutations", async () => {
		const client = await connectReporting({ skinId: "reporting-client-without-init" });
		expect(client.degraded).toBe(false);
		if (client.degraded) throw new Error(client.reason);
		const before = snapshot();
		const op = { op: "projects" } as const;
		const catalog = await client.inspect(op, scope);
		expect(catalog.result.op).toBe("projects");
		const output = await client.inspect({ op: "stats" }, scope);
		expect(output).toMatchObject({ degraded: false, result: { op: "stats", total: 5, projectBreakdown: { [projectId]: 2, global: 1, "unmapped-project": 1 } } });
		expect(snapshot()).toEqual(before);
		process.stdout.write(`reporting stats ${JSON.stringify(output)}\n`);
	});

	it("rejects a blank lookup path without creating data", async () => {
		const before = snapshot();
		const response = await fetch(`http://127.0.0.1:${server?.port}/v1/inspect`, {
			method: "POST", headers: { "x-sidecar-token": token },
			body: JSON.stringify({ op: { op: "currentProject", workspace: " " }, scope }),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ degraded: true, reason: "invalid-input" });
		expect(snapshot()).toEqual(before);
	});
	it("reports an unavailable stopped service without starting it or reconnecting existing reporting clients", async () => {
		const reader = await connectReporting({ skinId: "reporting-stopped-service" });
		const ordinary = await connect({ skinId: "ordinary-existing-client" });
		expect(reader.degraded).toBe(false);
		expect(ordinary.degraded).toBe(false);
		if (reader.degraded || ordinary.degraded) throw new Error("Running service connection failed");
		const before = snapshot();
		const running = server;
		server = undefined;
		await running?.stop();
		const discovery = join(root, "station", "sidecar.json");
		expect(existsSync(discovery)).toBe(false);
		const fresh = await connectReporting({ skinId: "reporting-after-stop" });
		expect(fresh).toMatchObject({ degraded: true, reason: "sidecar-unreachable" });
		for (const client of [reader, ordinary]) {
			const unavailable = await client.inspect({ op: "projects" }, scope);
			expect(unavailable).toMatchObject({ degraded: true, reason: "sidecar-unreachable" });
			expect(existsSync(discovery)).toBe(false);
		}
		expect(snapshot()).toEqual(before);
		process.stdout.write(`reporting stopped ${JSON.stringify({ fresh, discoveryCreated: existsSync(discovery) })}\n`);
	});

});
