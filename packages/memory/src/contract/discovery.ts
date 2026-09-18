import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ContractError } from "./error";
import { getDiscoveryPath } from "./profile";
import { MEMORY_HEALTH_TIMEOUT_MS } from "./routes";

export interface Discovery { pid: number; port: number; token: string }
const discoverySchema: z.ZodType<Discovery> = z.strictObject({
	pid: z.number().int().positive(), port: z.number().int().min(1).max(65535), token: z.string().regex(/^[a-f0-9]{64}$/),
});

export async function readDiscovery(): Promise<Discovery | undefined> {
	let text: string;
	try { text = await readFile(getDiscoveryPath(), "utf8"); }
	catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw new ContractError("sidecar-unreachable");
	}
	try { return discoverySchema.parse(JSON.parse(text)); }
	catch { throw new ContractError("sidecar-unreachable"); }
}

export function processAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return error instanceof Error && "code" in error && error.code === "EPERM"; }
}

export async function checkDiscovery(discovery: Discovery, _storePath: string): Promise<void> {
	try {
		const response = await fetch(`http://127.0.0.1:${discovery.port}/healthz`, {
			headers: { Authorization: `Bearer ${discovery.token}` }, signal: AbortSignal.timeout(MEMORY_HEALTH_TIMEOUT_MS),
		});
		if (!response.ok) throw new ContractError("sidecar-unresponsive");
		const health: unknown = await response.json();
		if (!health || typeof health !== "object" || !("status" in health) || health.status !== "ok") throw new ContractError("sidecar-unresponsive");
	} catch (error) {
		if (error instanceof ContractError) throw error;
		throw new ContractError("sidecar-unresponsive");
	}
}
