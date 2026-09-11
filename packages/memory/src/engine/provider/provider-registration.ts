import { PERSISTED_PROVIDER_SYSTEM } from "../../model/signed-registry-constants";
import { resolve } from "node:path";
import { createLogger } from "@snoai/utils/logger";
import { isLowercaseCanonicalUUIDv7 } from "@snoai/common-core";
import type { ProviderHostConfig as SnoStationMemConfig } from "../../contract/provider-runtime-types";




import type { SnoStationMemMemoryRuntime } from "../../contract/provider-runtime-types";
import {
	readProviderAuthority,
	resolveProviderAuthority,
} from "./provider-authority";

import { SnoStationMemProviderSearchManager } from "./provider-search-manager";
import type { ProviderIdentity } from "./provider-types";
import type { PluginConfig } from "../shared/types";
import type { MemoryStore } from "../../store/store";
const diagnosticLog = createLogger("sno-station-mem:provider-registration");
type AgentEntry = {
	id?: unknown;
	workspace?: unknown;
};
export function readTrustedUserId(config: PluginConfig): string {
	const userId = config.provider.userId;
	if (typeof userId !== "string" || userId.trim().length === 0) {
		throw new Error("sno-station-mem provider requires provider.userId");
	}
	const trimmed = userId.trim();
	if (!isLowercaseCanonicalUUIDv7(trimmed)) {
		throw new Error("sno-station-mem provider userId must be a lowercase UUID-v7");
	}
	return trimmed;
}
export function readConfiguredAgents(cfg: SnoStationMemConfig): AgentEntry[] {
	const entries = cfg.agents?.entries;
	if (entries && Object.keys(entries).length > 0) {
		return Object.entries(entries)
			.filter(([id]) => id.length > 0)
			.map(([id, entry]) => ({ ...entry, id }));
	}
	return (cfg.agents?.list ?? []) as AgentEntry[];
}
export function readAgentWorkspace(cfg: SnoStationMemConfig, agentId: string): string {
	const agent = readConfiguredAgents(cfg).find((entry) => entry.id === agentId);
	if (!agent) {
		throw new Error("sno-station-mem provider requires a configured sno-station-mem agent");
	}
	const workspace = agent?.workspace ?? cfg.agents?.defaults?.workspace;
	if (typeof workspace !== "string" || workspace.trim().length === 0) {
		throw new Error("sno-station-mem provider requires an explicit sno-station-mem agent workspace");
	}
	return resolve(workspace);
}
export async function resolveProviderIdentity(params: {
	cfg: SnoStationMemConfig;
	config: PluginConfig;
	store: MemoryStore;
	agentId: string;
}): Promise<{ identity: ProviderIdentity; workspaceDir: string }> {
	const userId = readTrustedUserId(params.config);
	const workspaceDir = readAgentWorkspace(params.cfg, params.agentId);
	const identity = await resolveProviderAuthority(params.store, {
		trustedUserId: userId,
		externalSystem: PERSISTED_PROVIDER_SYSTEM,
		projectKey: workspaceDir,
		agentKey: params.agentId,
	});
	return { identity, workspaceDir };
}
export async function readProviderIdentity(params: {
	cfg: SnoStationMemConfig;
	config: PluginConfig;
	store: MemoryStore;
	agentId: string;
}): Promise<{ identity: ProviderIdentity; workspaceDir: string }> {
	const userId = readTrustedUserId(params.config);
	const workspaceDir = readAgentWorkspace(params.cfg, params.agentId);
	const identity = await readProviderAuthority(params.store, {
		trustedUserId: userId,
		externalSystem: PERSISTED_PROVIDER_SYSTEM,
		projectKey: workspaceDir,
		agentKey: params.agentId,
	});
	return { identity, workspaceDir };
}
export function createMemoryRuntime(params: {
	config: PluginConfig;
	store: MemoryStore;
	stateDir: string;
}): SnoStationMemMemoryRuntime {
	const managers = new Map<string, SnoStationMemProviderSearchManager>();
	const failedClosingManagers = new Map<string, Set<SnoStationMemProviderSearchManager>>();

	function managerKey(identity: ProviderIdentity, workspaceDir: string): string {
		return `${identity.userId}:${identity.projectId}:${identity.agentId}:${workspaceDir}`;
	}

	function rememberFailedClose(key: string, manager: SnoStationMemProviderSearchManager): void {
		const existing = failedClosingManagers.get(key);
		if (existing) {
			existing.add(manager);
			return;
		}
		failedClosingManagers.set(key, new Set([manager]));
	}

	async function closeFailedManagers(key: string): Promise<void> {
		const failed = failedClosingManagers.get(key);
		if (!failed) return;
		for (const manager of Array.from(failed)) {
			await manager.close();
			failed.delete(manager);
		}
		if (failed.size === 0) failedClosingManagers.delete(key);
	}

	return {
		async getMemorySearchManager({ cfg, agentId }) {
			const started = performance.now();
			let outcome = "success";
			let failure: unknown;
			try {
				const resolved = await resolveProviderIdentity({
					cfg,
					config: params.config,
					store: params.store,
					agentId,
				});
				const key = managerKey(resolved.identity, resolved.workspaceDir);
				const existing = managers.get(key);
				if (existing) return { manager: existing };
				const manager = new SnoStationMemProviderSearchManager({
					store: params.store,
					identity: resolved.identity,
					workspaceDir: resolved.workspaceDir,
				});
				const winner = managers.get(key);
				if (winner) {
					await manager.close();
					return { manager: winner };
				}
				managers.set(key, manager);
				return { manager };
			} catch (error) {
				outcome = "failed";
				failure = error;
				return {
					manager: null,
					error: error instanceof Error ? error.message : String(error),
				};
			} finally {
				diagnosticLog[outcome === "failed" ? "error" : "debug"]("Provider memory manager resolved", { outcome, error: failure,
					duration_ms: performance.now() - started },
					{ event_name: "memory.provider.manager.resolved", file: "packages/sno-station-mem/src/engine/provider/provider-registration.ts", function: "createMemoryRuntime.getMemorySearchManager", site_id: "memory.provider.manager.resolved" });
			}
		},
		resolveMemoryBackendConfig() {
			return { backend: "qmd" };
		},
		async closeMemorySearchManager({ cfg, agentId }) {
			let resolved: { identity: ProviderIdentity; workspaceDir: string };
			try {
				resolved = await resolveProviderIdentity({
					cfg,
					config: params.config,
					store: params.store,
					agentId,
				});
			} catch (error) {
				diagnosticLog.warn("Provider manager close lacks identity", { outcome: "skipped", error },
					{ event_name: "memory.provider.manager.close.skipped", file: "packages/sno-station-mem/src/engine/provider/provider-registration.ts", function: "createMemoryRuntime.closeMemorySearchManager", site_id: "memory.provider.manager.close.skipped" });
				// Close paths must not create a second failure after a failed identity resolution.
				return;
			}
			const key = managerKey(resolved.identity, resolved.workspaceDir);
			await closeFailedManagers(key);
			const manager = managers.get(key);
			if (!manager) return;
			managers.delete(key);
			try {
				await manager.close();
			} catch (error) {
				if (managers.has(key)) {
					rememberFailedClose(key, manager);
				} else {
					managers.set(key, manager);
				}
				diagnosticLog.warn("Provider manager close retained for retry", { outcome: "failed", error },
					{ event_name: "memory.provider.manager.close.failed", file: "packages/sno-station-mem/src/engine/provider/provider-registration.ts", function: "createMemoryRuntime.closeMemorySearchManager", site_id: "memory.provider.manager.close.failed" });
				throw error;
			}
		},
		async closeAllMemorySearchManagers() {
			const started = performance.now();
			let closedCount = 0;
			let failure: unknown;
			let failed = false;
			try {
			for (const failed of failedClosingManagers.values()) {
				for (const manager of failed) {
					await manager.close();
					closedCount += 1;
				}
			}
			failedClosingManagers.clear();
			for (const manager of managers.values()) {
				await manager.close();
				closedCount += 1;
			}
			managers.clear();
			} catch (error) {
				failure = error;
				failed = true;
				throw error;
			} finally {
				diagnosticLog[failed ? "warn" : "debug"]("Provider managers shutdown completed", {
					outcome: failed ? "partial" : "success", closed_count: closedCount,
					error: failure, duration_ms: performance.now() - started },
					{ event_name: "memory.provider.managers.shutdown.completed", file: "packages/sno-station-mem/src/engine/provider/provider-registration.ts", function: "createMemoryRuntime.closeAllMemorySearchManagers", site_id: "memory.provider.managers.shutdown.completed" });
			}
		},
	};
}