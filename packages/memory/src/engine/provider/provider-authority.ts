import { FIXED_PROTOCOL_VALUE_65, FIXED_PROTOCOL_VALUE_66, FIXED_PROTOCOL_VALUE_67, FIXED_PROTOCOL_VALUE_68, FIXED_PROTOCOL_VALUE_76, PERSISTED_PROVIDER_SYSTEM } from "../../model/signed-registry-constants";
/** @file provider-authority.ts
 * @purpose Resolves SnoStationMem external project/agent keys to internal provider authority.
 * @boundary SQLite mapping tables and project-agent membership checks.
 */

import { createUUIDv7, isLowercaseCanonicalUUIDv7 } from "@snoai/common-core";
import { StorageError } from "../shared/errors";
import type { MemoryStore } from "../../store/store";
import type {
	ProviderAuthorityInput,
	ProviderIdentity,
	ProviderMembershipGrantInput,
} from "./provider-types";

interface ProjectMappingRow {
	project_id: string;
}

interface AgentMappingRow {
	agent_id: string;
}

function validateAuthorityInput(input: ProviderAuthorityInput): {
	userId: string;
	projectKey: string;
	agentKey: string;
} {
	const userId = input.trustedUserId.trim();
	if (userId.length === 0) {
		throw new StorageError("Provider authority userId is required");
	}
	if (!isLowercaseCanonicalUUIDv7(userId)) {
		throw new StorageError("trusted userId must be a lowercase UUID-v7");
	}
	if (input.externalSystem !== PERSISTED_PROVIDER_SYSTEM) {
		throw new StorageError(FIXED_PROTOCOL_VALUE_76);
	}
	const projectKey = input.projectKey.trim();
	if (projectKey.length === 0) {
		throw new StorageError("Provider authority projectKey is required");
	}
	const agentKey = input.agentKey.trim();
	if (agentKey.length === 0) {
		throw new StorageError("Provider authority agentKey is required");
	}
	return { userId, projectKey, agentKey };
}

function selectProjectMapping(
	store: MemoryStore,
	userId: string,
	projectKey: string,
): ProjectMappingRow | undefined {
	return store.sqlite
		.prepare(
			FIXED_PROTOCOL_VALUE_65,
		)
		.get(userId, projectKey) as ProjectMappingRow | undefined;
}

function selectAgentMapping(
	store: MemoryStore,
	userId: string,
	agentKey: string,
): AgentMappingRow | undefined {
	return store.sqlite
		.prepare(
			FIXED_PROTOCOL_VALUE_66,
		)
		.get(userId, agentKey) as AgentMappingRow | undefined;
}

// Cross-connection race handling (e.g. the sno-mem CLI writing to the same
// state dir while the gateway is live) lives in TWO layers, both required:
// the callers' IMMEDIATE-mode transactions (see resolveProviderAuthority /
// grantProviderProjectAgentMembership) acquire the write lock BEFORE these
// SELECTs run, so a competing connection can't interleave between read and
// insert; and INSERT OR IGNORE + mandatory re-select makes a losing writer
// gracefully adopt the winner's row instead of throwing on the composite
// primary key (drizzle/0010_provider_mappings.sql) if lock ordering ever
// doesn't apply. These helpers must only be called inside such a transaction.
function ensureProjectMapping(
	store: MemoryStore,
	userId: string,
	projectKey: string,
): { projectId: string; created: boolean } {
	const existing = selectProjectMapping(store, userId, projectKey);
	if (existing) return { projectId: existing.project_id, created: false };
	const projectId = createUUIDv7();
	store.sqlite
		.prepare(
			FIXED_PROTOCOL_VALUE_67,
		)
		.run(userId, projectKey, projectId, Date.now());
	const winner = selectProjectMapping(store, userId, projectKey);
	if (!winner) {
		throw new StorageError("Provider project mapping insert did not persist");
	}
	return { projectId: winner.project_id, created: winner.project_id === projectId };
}

function ensureAgentMapping(store: MemoryStore, userId: string, agentKey: string): string {
	const existing = selectAgentMapping(store, userId, agentKey);
	if (existing) return existing.agent_id;
	const agentId = createUUIDv7();
	store.sqlite
		.prepare(
			FIXED_PROTOCOL_VALUE_68,
		)
		.run(userId, agentKey, agentId, Date.now());
	const winner = selectAgentMapping(store, userId, agentKey);
	if (!winner) {
		throw new StorageError("Provider agent mapping insert did not persist");
	}
	return winner.agent_id;
}

function hasMembership(
	store: MemoryStore,
	userId: string,
	projectId: string,
	agentId: string,
): boolean {
	const row = store.sqlite
		.prepare(
			"SELECT 1 FROM nodix_provider_project_agents WHERE user_id = ? AND project_id = ? AND agent_id = ? LIMIT 1",
		)
		.get(userId, projectId, agentId);
	return row !== undefined;
}

function insertMembership(
	store: MemoryStore,
	userId: string,
	projectId: string,
	agentId: string,
): void {
	store.sqlite
		.prepare(
			"INSERT OR IGNORE INTO nodix_provider_project_agents(user_id, project_id, agent_id, created_at_ms) VALUES (?, ?, ?, ?)",
		)
		.run(userId, projectId, agentId, Date.now());
}

function requireProjectMapping(
	store: MemoryStore,
	userId: string,
	projectKey: string,
): string {
	const project = selectProjectMapping(store, userId, projectKey);
	if (!project) throw new StorageError("Provider project provisioning is required");
	return project.project_id;
}

export async function resolveProviderAuthority(
	store: MemoryStore,
	input: ProviderAuthorityInput,
): Promise<ProviderIdentity> {
	const { userId, projectKey, agentKey } = validateAuthorityInput(input);
	return store.writeMutex.runExclusive((): ProviderIdentity => {
		let resolved: ProviderIdentity | undefined;
		// IMMEDIATE: take the write lock before the first SELECT inside — a plain
		// (DEFERRED) BEGIN would let a second connection interleave a competing
		// write between the ensure* helpers' read and insert. Must live HERE on
		// the outermost transaction: better-sqlite3 runs nested transactions as
		// savepoints and ignores an inner .immediate().
		store.sqlite
			.transaction(() => {
				const project = ensureProjectMapping(store, userId, projectKey);
				const agentId = ensureAgentMapping(store, userId, agentKey);
				if (project.created) {
					insertMembership(store, userId, project.projectId, agentId);
				} else if (!hasMembership(store, userId, project.projectId, agentId)) {
					throw new StorageError("Provider project-agent membership is required");
				}
				resolved = { userId, projectId: project.projectId, agentId };
			})
			.immediate();
		if (!resolved) throw new StorageError("Provider authority resolution failed");
		return resolved;
	});
}

export async function readProviderAuthority(
	store: MemoryStore,
	input: ProviderAuthorityInput,
): Promise<ProviderIdentity> {
	const { userId, projectKey, agentKey } = validateAuthorityInput(input);
	return store.writeMutex.runExclusive((): ProviderIdentity => {
		const project = selectProjectMapping(store, userId, projectKey);
		if (!project) throw new StorageError("Provider project provisioning is required");
		const agent = selectAgentMapping(store, userId, agentKey);
		if (!agent || !hasMembership(store, userId, project.project_id, agent.agent_id)) {
			throw new StorageError("Provider project-agent membership is required");
		}
		return { userId, projectId: project.project_id, agentId: agent.agent_id };
	});
}

export async function grantProviderProjectAgentMembership(
	store: MemoryStore,
	input: ProviderMembershipGrantInput,
): Promise<ProviderIdentity> {
	const { userId, projectKey, agentKey } = validateAuthorityInput(input);
	if (input.grantor.userId !== userId) {
		throw new StorageError("granting identity user mismatch");
	}
	return store.writeMutex.runExclusive((): ProviderIdentity => {
		let granted: ProviderIdentity | undefined;
		// IMMEDIATE for the same cross-connection reason as resolveProviderAuthority.
		store.sqlite
			.transaction(() => {
				const projectId = requireProjectMapping(store, userId, projectKey);
				if (projectId !== input.grantor.projectId) {
					throw new StorageError("granting identity project mismatch");
				}
				if (!hasMembership(store, userId, projectId, input.grantor.agentId)) {
					throw new StorageError("granting agent is not a project member");
				}
				const targetAgentId = ensureAgentMapping(store, userId, agentKey);
				insertMembership(store, userId, projectId, targetAgentId);
				granted = { userId, projectId, agentId: targetAgentId };
			})
			.immediate();
		if (!granted) throw new StorageError("Provider membership grant failed");
		return granted;
	});
}
