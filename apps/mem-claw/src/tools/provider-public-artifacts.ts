/** @file provider-public-artifacts.ts
 * @purpose Lists authorized mem-claw public memory artifacts for OpenClaw.
 * @boundary Generated row files are read-only views; source rows remain the authority.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative as relativePath, resolve } from "node:path";
import type { MemoryPluginPublicArtifact } from "openclaw/plugin-sdk/memory-host-core";
import { MAX_LIST_LIMIT } from "@snoai/memory/internal/config/index";
import { listCanonicalMemoryFiles } from "@snoai/memory/internal/engine/provider/canonical-memory-corpus";
import {
	isProviderRowArtifactFileName,
	isProviderRowId,
	providerRowPath,
	renderProviderRowMemory,
} from "@snoai/memory/internal/engine/provider/provider-row-renderer";
import { ContractError } from "@snoai/memory/client";
import type { MemoryConnection, HostMemoryContext } from "../install/memory-connection";
import type { MemoryEntry } from "@snoai/memory/internal/engine/shared/types";

const PROVIDER_PROJECT_ID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const artifactProjectQueues = new Map<string, Promise<void>>();

export interface ListMemClawProviderPublicArtifactsParams {
	connection: MemoryConnection;
	context: HostMemoryContext;
	agentId: string;
	stateDir: string;
	workspaceDir?: string;
}

function isMissingDir(error: unknown): boolean {
	return !!error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT";
}

function isInside(parent: string, child: string): boolean {
	const relative = relativePath(parent, child);
	return relative === "" || (!relative.startsWith("..") && !isAbsolute(relative));
}

function rowArtifactRoot(stateDir: string, projectId: string): string {
	if (!PROVIDER_PROJECT_ID_RE.test(projectId)) {
		throw new Error("Provider project id must be a lowercase UUID-v7");
	}
	const base = resolve(stateDir, "mem-claw", "provider-artifacts");
	const root = resolve(base, projectId);
	if (!isInside(base, root)) {
		throw new Error("Provider row artifact root escaped state directory");
	}
	return root;
}

function rowArtifactPath(root: string, relPath: string): string {
	const absolutePath = resolve(root, ...relPath.split("/"));
	if (!isInside(root, absolutePath)) {
		throw new Error("Provider row artifact path escaped root");
	}
	return absolutePath;
}

async function withArtifactProjectQueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const previous = artifactProjectQueues.get(key) ?? Promise.resolve();
	let releaseCurrent: () => void = () => {};
	const current = new Promise<void>((resolveCurrent) => {
		releaseCurrent = resolveCurrent;
	});
	const queued = previous.catch(() => undefined).then(() => current);
	artifactProjectQueues.set(key, queued);
	await previous.catch(() => undefined);
	try {
		return await fn();
	} finally {
		releaseCurrent();
		if (artifactProjectQueues.get(key) === queued) {
			artifactProjectQueues.delete(key);
		}
	}
}

async function writeAtomicIfChanged(filePath: string, text: string): Promise<void> {
	const existing = await readFile(filePath, "utf8").catch((error: unknown) => {
		if (isMissingDir(error)) return undefined;
		throw error;
	});
	if (existing === text) return;
	await mkdir(dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(tempPath, text);
		await rename(tempPath, filePath);
	} catch (error) {
		await rm(tempPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function pruneStaleRowArtifacts(root: string, validRelPaths: Set<string>): Promise<void> {
	const rowDir = join(root, "mem-claw");
	const entries = await readdir(rowDir, { withFileTypes: true }).catch((error: unknown) => {
		if (isMissingDir(error)) return [];
		throw error;
	});
	for (const entry of entries) {
		if (!entry.isFile() || !isProviderRowArtifactFileName(entry.name)) continue;
		const relPath = `mem-claw/${entry.name}`;
		if (!validRelPaths.has(relPath)) {
			const absolutePath = resolve(rowDir, entry.name);
			if (!isInside(rowDir, absolutePath)) continue;
			await rm(absolutePath, { force: true });
		}
	}
}

// Artifacts belong to one provider project: name it explicitly so the read never spans the agent's other readable scopes.
async function listAllProjectRows(connection: MemoryConnection, context: HostMemoryContext, project: string): Promise<{ projectId: string; rows: MemoryEntry[] }> {
  const rows: MemoryEntry[] = [], client = await connection.ready(), scope = await connection.scope(context, project);
  for (let offset = 0; ; offset += MAX_LIST_LIMIT) {
    const result = await client.inspect({ op: "list", limit: MAX_LIST_LIMIT, offset }, scope);
    if (result.degraded) throw new ContractError(result.reason);
    if (result.result.op !== "list") throw new ContractError("engine-failed");
    rows.push(...result.result.entries);
    if (result.result.entries.length < MAX_LIST_LIMIT) return { projectId: result.result.project, rows };
  }
}

function artifact(params: {
	kind: string;
	workspaceDir: string;
	relativePath: string;
	absolutePath: string;
	agentId: string;
}): MemoryPluginPublicArtifact {
	return {
		kind: params.kind,
		workspaceDir: params.workspaceDir,
		relativePath: params.relativePath,
		absolutePath: params.absolutePath,
		agentIds: [params.agentId],
		contentType: "markdown",
	};
}

export async function listSnoStationMemProviderPublicArtifacts(
	params: ListMemClawProviderPublicArtifactsParams,
): Promise<MemoryPluginPublicArtifact[]> {
	const artifacts: MemoryPluginPublicArtifact[] = [];
	if (params.workspaceDir) {
		const files = await listCanonicalMemoryFiles(params.workspaceDir);
		for (const file of files) {
			artifacts.push(
				artifact({
					kind: "memory-file",
					workspaceDir: resolve(params.workspaceDir),
					relativePath: file.path,
					absolutePath: file.realPath,
					agentId: params.agentId,
				}),
			);
		}
	}

	// Read and prune under one queue per project, so a stale read can never overwrite a newer write,
	// and an empty project still prunes the files its last row left behind.
	const project = params.workspaceDir ?? `agent:${params.agentId}`;
	await withArtifactProjectQueue(project, async () => {
		const { projectId, rows } = await listAllProjectRows(params.connection, params.context, project);
		const root = rowArtifactRoot(params.stateDir, projectId);
		const validRowPaths = new Set<string>();
		for (const row of rows.sort((left, right) => left.id.localeCompare(right.id))) {
			if (row.projectId !== projectId) continue;
			if (!isProviderRowId(row.id)) continue;
			const relPath = providerRowPath(row.id);
			const absolutePath = rowArtifactPath(root, relPath);
			validRowPaths.add(relPath);
			await writeAtomicIfChanged(absolutePath, renderProviderRowMemory(row));
			artifacts.push(
				artifact({
					kind: "mem-claw-row",
					workspaceDir: root,
					relativePath: relPath,
					absolutePath,
					agentId: params.agentId,
				}),
			);
		}
		await pruneStaleRowArtifacts(root, validRowPaths);
	});

	return artifacts.sort((left, right) =>
		left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
	);
}
