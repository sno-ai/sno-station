import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { getSettingsPath } from "./profile";
import { startSidecar } from "./start";
import { checkDiscovery, processAlive, readDiscovery, type Discovery } from "./discovery";
import { ContractError, DEGRADED_REASONS, type DegradedReason } from "./error";
import type { ContractInputs, HostEvent, InitRegistration, Inspection, Message, Mutation, RecallOptions, ScopeCtx, Turn, UsageSignal } from "./inputs";
import type { ContractMethod, MemoryContract } from "./index";
import { getPrincipal } from "./profile";
import { outputSchemas, type ContractOutputs, type InspectData } from "./results";
import { MEMORY_ROUTES, MEMORY_SKIN_HEADER } from "./routes";

export type { MemoryContract, ScopeCtx, Registration, InitRegistration, RecallOptions, Turn, Mutation, Inspection, UsageSignal, Message, ContractOutputs, JsonValue, HostEvent } from "./index";
export { ContractError } from "./error";
export interface ConnectOptions { skinId: string }
export interface DegradedConnection { degraded: true; reason: DegradedReason; error?: string }

function clientSettings(): { storePath: string; memoryPackage: { path: string; node: string } } {
	const path = getSettingsPath();
	let value: unknown;
	try { value = JSON.parse(readFileSync(path, "utf8")); }
	catch { throw new ContractError("storage-unavailable", `settings unavailable: ${path}: file; run sno setup`); }
	const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
	const memoryPackage = record.memoryPackage && typeof record.memoryPackage === "object"
		? record.memoryPackage as Record<string, unknown> : {};
	for (const field of ["path", "node"] as const) {
		if (typeof memoryPackage[field] !== "string" || !memoryPackage[field])
			throw new ContractError("storage-unavailable", `settings unavailable: ${path}: memoryPackage.${field}; run sno setup`);
	}
	const store = record.store && typeof record.store === "object" ? record.store as Record<string, unknown> : {};
	return { storePath: typeof store.path === "string" ? store.path : "", memoryPackage: memoryPackage as { path: string; node: string } };
}

function failureReason(error: unknown): DegradedReason {
	if (error instanceof ContractError) return error.reason;
	if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "timeout";
	return "sidecar-unreachable";
}

/**
 * Plain node:http instead of fetch: undici's default dispatcher cuts headers and body at
 * 300 s, silently under the 900 s route budgets; here the route deadline is the only clock.
 */
function postJson(port: number, path: string, headers: Record<string, string>, body: string, signal: AbortSignal): Promise<{ ok: boolean; body: unknown }> {
	return new Promise((resolve, reject) => {
		const request = httpRequest({ host: "127.0.0.1", port, path, method: "POST", signal,
			headers: { ...headers, "Content-Length": Buffer.byteLength(body) } }, response => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.on("error", reject);
			response.on("end", () => {
				const status = response.statusCode ?? 0;
				try { resolve({ ok: status >= 200 && status < 300, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
				catch (error) { reject(error); }
			});
		});
		request.on("error", reject);
		request.end(body);
	});
}

function responseError(body: unknown): ContractError {
	if (body && typeof body === "object" && "reason" in body) {
		const reason = DEGRADED_REASONS.find(value => value === body.reason);
		if (reason) return new ContractError(reason, "error" in body && typeof body.error === "string" ? body.error : reason);
		if (typeof body.reason === "string") return new ContractError("engine-failed", body.reason);
	}
	return new ContractError("engine-failed");
}

export async function connect(options: ConnectOptions): Promise<MemoryClient | DegradedConnection> {
	try {
		const { storePath, memoryPackage } = clientSettings();
		let discovery = await readDiscovery();
		if (discovery) {
			try { await checkDiscovery(discovery); }
			catch (error) {
				if (error instanceof ContractError && error.message.startsWith("settings unavailable:")) throw error;
				discovery = undefined;
			}
		}
		if (!discovery) {
			discovery = await startSidecar(memoryPackage);
		}
		if (!discovery) throw new ContractError("sidecar-unreachable");
		await checkDiscovery(discovery);
		return new MemoryClient(options.skinId, storePath, discovery);
	} catch (error) { return { degraded: true, reason: failureReason(error), ...(error instanceof Error && { error: error.message }) }; }
}

export class MemoryClient implements MemoryContract {
	readonly degraded = false;
	readonly principal: string = getPrincipal();
	readonly pid: number;
	readonly port: number;
	#registration: { scope: ScopeCtx; registration: InitRegistration } | undefined;
	#registeredPid: number | undefined;

	constructor(readonly skinId: string, readonly storePath: string, discovery: Discovery) {
		this.pid = discovery.pid;
		this.port = discovery.port;
	}

	private async request<K extends ContractMethod>(method: K, input: ContractInputs[K], signal?: AbortSignal): Promise<ContractOutputs[K]> {
		const route = MEMORY_ROUTES[method];
		try {
			signal?.throwIfAborted();
			let discovery = await readDiscovery();
			if (!discovery || !processAlive(discovery.pid)) {
				const { memoryPackage } = clientSettings();
				discovery = await startSidecar(memoryPackage);
			}
			if (method !== "init" && this.#registration && this.#registeredPid !== discovery.pid) {
				await this.request("init", this.#registration, signal);
			}
			const response = await postJson(discovery.port, route.path,
				{ "Content-Type": "application/json", [MEMORY_SKIN_HEADER]: this.skinId },
				JSON.stringify({ ...input, scope: { ...input.scope, principal: this.principal } }),
				signal ? AbortSignal.any([signal, AbortSignal.timeout(route.timeoutMs)]) : AbortSignal.timeout(route.timeoutMs));
			const body = response.body;
			if (!response.ok) throw responseError(body);
			const parsed = outputSchemas[method].safeParse(body);
			if (!parsed.success) throw new ContractError("engine-failed");
			if (parsed.data.degraded) throw new ContractError(parsed.data.reason, parsed.data.error ?? parsed.data.reason);
			if (method === "init") this.#registeredPid = discovery.pid;
			return parsed.data;
		} catch (error) { throw error instanceof ContractError ? error : new ContractError(failureReason(error)); }
	}

	init(scope: ScopeCtx, registration: InitRegistration): Promise<ContractOutputs["init"]> {
		this.#registration = { scope, registration };
		return this.request("init", { scope, registration });
	}
	hostEvent(event: HostEvent, scope: ScopeCtx): Promise<ContractOutputs["hostEvent"]> {
		return this.request("hostEvent", { scope, event });
	}
	async getRecall(query: string, scope: ScopeCtx, options: RecallOptions, signal?: AbortSignal): Promise<ContractOutputs["getRecall"]> {
		try { return await this.request("getRecall", { query, scope, options }, signal); }
		catch (error) { return { degraded: true, reason: failureReason(error), error: error instanceof Error ? error.message : String(error), recallId: "", contextText: "" }; }
	}
	capture(turn: Turn, scope: ScopeCtx): Promise<ContractOutputs["capture"]> {
		return this.request("capture", { turn, scope });
	}
	mutate(op: Mutation, scope: ScopeCtx): Promise<ContractOutputs["mutate"]> {
		return this.request("mutate", { op, scope });
	}
	async inspect(op: Inspection, scope: ScopeCtx): Promise<ContractOutputs["inspect"]> {
		try { return await this.request("inspect", { op, scope }); }
		catch (error) {
			let result: InspectData;
			if (op.op === "storage") result = { op: "storage", dimension: null, failed: true };
			else if (op.op === "stats") result = { op: "stats", total: 0, projectBreakdown: {}, categoryBreakdown: {} };
			else if (op.op === "get") result = { op: "get", entry: null };
			else result = { op: op.op, project: scope.project, entries: [] };
			return { degraded: true, reason: failureReason(error), error: error instanceof Error ? error.message : String(error), result };
		}
	}
	recordUsage(recallId: string, signal: UsageSignal, scope: ScopeCtx): Promise<ContractOutputs["recordUsage"]> {
		return this.request("recordUsage", { recallId, signal, scope });
	}
	onSessionEnd(messages: Message[], scope: ScopeCtx): Promise<ContractOutputs["onSessionEnd"]> {
		return this.request("onSessionEnd", { messages, scope });
	}
	async staticBlock(scope: ScopeCtx): Promise<ContractOutputs["staticBlock"]> {
		try { return await this.request("staticBlock", { scope }); }
		catch (error) { return { degraded: true, reason: failureReason(error), contextText: "" }; }
	}
}
