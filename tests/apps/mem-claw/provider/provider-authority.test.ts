import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import {
	grantProviderProjectAgentMembership,
	readProviderAuthority,
	resolveProviderAuthority,
} from "../../../../packages/memory/src/engine/provider/provider-authority.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

const userAlphaId = "019f3d5e-7a30-7cc0-8f4f-0b9c72e4a001";
const userBetaId = "019f3d5e-7a30-7cc0-8f4f-0b9c72e4a002";
const uuidV7Pattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("provider authority", () => {
	let store: MemoryStore;
	let cleanup: () => void;

	beforeEach(() => {
		const testDb = createTestDb();
		cleanup = testDb.cleanup;
		store = new MemoryStore({ dbPath: testDb.dbPath, embedder });
	});

	afterEach(() => {
		store.closeSync();
		cleanup();
	});

	it("denies missing user, project, or agent identity", async () => {
		await expect(
			resolveProviderAuthority(store, {
				trustedUserId: "",
				externalSystem: "openclaw",
				projectKey: "main",
				agentKey: "agent-a",
			}),
		).rejects.toThrow(/userId is required/);

		await expect(
			resolveProviderAuthority(store, {
				trustedUserId: userAlphaId,
				externalSystem: "openclaw",
				projectKey: "",
				agentKey: "agent-a",
			}),
		).rejects.toThrow(/projectKey is required/);

		await expect(
			resolveProviderAuthority(store, {
				trustedUserId: userAlphaId,
				externalSystem: "openclaw",
				projectKey: "main",
				agentKey: "",
			}),
		).rejects.toThrow(/agentKey is required/);
	});

	it("rejects external user strings as authority", async () => {
		await expect(
			resolveProviderAuthority(store, {
				trustedUserId: "user-alpha",
				externalSystem: "openclaw",
				projectKey: "main",
				agentKey: "agent-a",
			}),
		).rejects.toThrow(/trusted userId must be a lowercase UUID-v7/);
	});

	it("provisions trusted external main to internal uuid project and agent ids", async () => {
		const identity = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "main",
			agentKey: "main",
		});

		expect(identity.userId).toBe(userAlphaId);
		expect(identity.projectId).not.toBe("main");
		expect(identity.projectId).toMatch(uuidV7Pattern);
		expect(identity.agentId).not.toBe("main");
		expect(identity.agentId).toMatch(uuidV7Pattern);

		const projectRows = store.sqlite
			.prepare(
				"SELECT user_id, external_system, external_project_key, project_id FROM nodix_provider_project_mappings",
			)
			.all() as Array<{
			user_id: string;
			external_system: string;
			external_project_key: string;
			project_id: string;
		}>;
		expect(projectRows).toEqual([
			{
				user_id: userAlphaId,
				external_system: "openclaw",
				external_project_key: "main",
				project_id: identity.projectId,
			},
		]);

		const providerTables = store.sqlite
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'nodix_provider_%'",
			)
			.all() as Array<{ name: string }>;
		expect(providerTables.map((row) => row.name)).not.toContain(
			"nodix_provider_user_mappings",
		);
	});

	it("keeps the same external project key isolated across users", async () => {
		const alpha = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "main",
			agentKey: "agent-a",
		});
		const beta = await resolveProviderAuthority(store, {
			trustedUserId: userBetaId,
			externalSystem: "openclaw",
			projectKey: "main",
			agentKey: "agent-a",
		});

		expect(alpha.projectId).not.toBe(beta.projectId);
		expect(alpha.agentId).not.toBe(beta.agentId);
	});

	it("joins a second agent to the existing project of the same workspace", async () => {
		const agentA = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "main",
			agentKey: "agent-a",
		});

		const agentB = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "main",
			agentKey: "agent-b",
		});

		expect(agentB.projectId).toBe(agentA.projectId);
		expect(agentB.agentId).toMatch(uuidV7Pattern);
		expect(agentB.agentId).not.toBe(agentA.agentId);
	});

	it("fails a grant when the granting identity is not already a project member", async () => {
		const agentA = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "main",
			agentKey: "agent-a",
		});
		const spoofedGrantor = {
			...agentA,
			agentId: "019f3d5e-7a30-7cc0-8f4f-0b9c72e4a099",
		};

		await expect(
			grantProviderProjectAgentMembership(store, {
				trustedUserId: userAlphaId,
				externalSystem: "openclaw",
				projectKey: "main",
				agentKey: "agent-b",
				grantor: spoofedGrantor,
			}),
		).rejects.toThrow(/granting agent is not a project member/);
	});

	it("resolves trusted provisioning consistently under concurrent first contact for one agent", async () => {
		const [agentA, agentB] = await Promise.allSettled([
			resolveProviderAuthority(store, {
				trustedUserId: userAlphaId,
				externalSystem: "openclaw",
				projectKey: "main",
				agentKey: "agent-a",
			}),
			resolveProviderAuthority(store, {
				trustedUserId: userAlphaId,
				externalSystem: "openclaw",
				projectKey: "main",
				agentKey: "agent-a",
			}),
		]);

		expect([agentA.status, agentB.status].sort()).toEqual(["fulfilled", "fulfilled"]);

		const memberships = store.sqlite
			.prepare("SELECT user_id, project_id, agent_id FROM nodix_provider_project_agents")
			.all() as Array<{ user_id: string; project_id: string; agent_id: string }>;
		expect(memberships).toHaveLength(1);
		expect(memberships[0]?.user_id).toBe(userAlphaId);
	});

	it("lets one agent join every workspace it uses", async () => {
		const projectA = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "project-a",
			agentKey: "agent-a",
		});
		const projectB = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "project-b",
			agentKey: "agent-b",
		});

		await expect(
			resolveProviderAuthority(store, {
				trustedUserId: userAlphaId,
				externalSystem: "openclaw",
				projectKey: "project-b",
				agentKey: "agent-a",
			}),
		).resolves.toMatchObject({ projectId: projectB.projectId, agentId: projectA.agentId });
	});

	it("reads back a previously provisioned authority without re-provisioning", async () => {
		const provisioned = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "main",
			agentKey: "agent-a",
		});

		const read = await readProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "main",
			agentKey: "agent-a",
		});

		expect(read).toEqual(provisioned);
	});

	it("fails to read authority when no project has been provisioned", async () => {
		await expect(
			readProviderAuthority(store, {
				trustedUserId: userAlphaId,
				externalSystem: "openclaw",
				projectKey: "never-provisioned",
				agentKey: "agent-a",
			}),
		).rejects.toThrow(/provisioning is required/);
	});

	it("fails to read authority when agent mapping exists but membership does not", async () => {
		await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "project-a",
			agentKey: "agent-a",
		});
		await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "project-b",
			agentKey: "agent-b",
		});

		await expect(
			readProviderAuthority(store, {
				trustedUserId: userAlphaId,
				externalSystem: "openclaw",
				projectKey: "project-a",
				agentKey: "agent-b",
			}),
		).rejects.toThrow(/membership is required/);
	});
});
