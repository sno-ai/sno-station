import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkDiscovery, readDiscovery, type Discovery } from "./discovery";
import { ContractError, DEGRADED_REASONS, type DegradedReason } from "./error";
import type { ContractInputs, Inspection, Message, Mutation, RecallOptions, Registration, ScopeCtx, Turn, UsageSignal } from "./inputs";
import type { ContractMethod, MemoryContract } from "./index";
import { getPrincipal, readBoundStorePath } from "./profile";
import { outputSchemas, type ContractOutputs, type InspectData } from "./results";
import { MEMORY_ROUTES, MEMORY_SKIN_HEADER, MEMORY_START_TIMEOUT_MS, MEMORY_HEALTH_TIMEOUT_MS } from "./routes";

export type { MemoryContract, ScopeCtx, Registration, RecallOptions, Turn, Mutation, Inspection, UsageSignal, Message, ContractOutputs, JsonValue } from "./index";
export { ContractError } from "./error";
export interface ConnectOptions { skinId: string; storePath?: string }
export interface DegradedConnection { degraded: true; reason: DegradedReason }

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
		if (reason) return new ContractError(reason);
	}
	return new ContractError("engine-failed");
}

export async function connect(options: ConnectOptions): Promise<MemoryClient | DegradedConnection> {
	try {
		const storePath = await readBoundStorePath(options.storePath);
		let discovery = await readDiscovery();
		if (!discovery || !await checkDiscovery(discovery, storePath).then(() => true, () => false)) {
			try {
				await promisify(execFile)(process.execPath, [fileURLToPath(new URL("./cli.js", import.meta.url)), "sidecar", "start"], {
					timeout: MEMORY_START_TIMEOUT_MS + MEMORY_HEALTH_TIMEOUT_MS, maxBuffer: 64 * 1024,
				});
			} catch { throw new ContractError("storage-unavailable"); }
			discovery = await readDiscovery();
		}
		if (!discovery) throw new ContractError("sidecar-unreachable");
		await checkDiscovery(discovery, storePath);
		return new MemoryClient(options.skinId, storePath, discovery);
	} catch (error) { return { degraded: true, reason: failureReason(error) }; }
}

export class MemoryClient implements MemoryContract {
	readonly degraded = false;
	readonly principal: string = getPrincipal();
	readonly pid: number;
	readonly port: number;
	readonly #discovery: Discovery;

	constructor(readonly skinId: string, readonly storePath: string, discovery: Discovery) {
		this.#discovery = discovery;
		this.pid = discovery.pid;
		this.port = discovery.port;
	}

	private async request<K extends ContractMethod>(method: K, input: ContractInputs[K]): Promise<ContractOutputs[K]> {
		const route = MEMORY_ROUTES[method];
		try {
			const discovery = await readDiscovery() ?? this.#discovery;
			const response = await postJson(discovery.port, route.path,
				{ "Content-Type": "application/json", [MEMORY_SKIN_HEADER]: this.skinId },
				JSON.stringify({ ...input, scope: { ...input.scope, principal: this.principal } }),
				AbortSignal.timeout(route.timeoutMs));
			const body = response.body;
			if (!response.ok) throw responseError(body);
			const parsed = outputSchemas[method].safeParse(body);
			if (!parsed.success) throw new ContractError("engine-failed");
			if (parsed.data.degraded) throw new ContractError(parsed.data.reason);
			return parsed.data;
		} catch (error) { throw new ContractError(failureReason(error)); }
	}

	init(scope: ScopeCtx, registration: Registration): Promise<ContractOutputs["init"]> {
		return this.request("init", { scope, registration });
	}
	async getRecall(query: string, scope: ScopeCtx, options: RecallOptions): Promise<ContractOutputs["getRecall"]> {
		try { return await this.request("getRecall", { query, scope, options }); }
		catch (error) { return { degraded: true, reason: failureReason(error), recallId: "", contextText: "" }; }
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
			return { degraded: true, reason: failureReason(error), result };
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
