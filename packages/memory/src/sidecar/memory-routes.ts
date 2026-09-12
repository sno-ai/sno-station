import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "@snoai/utils/logger";
import { ContractError } from "../contract/error";
import { MEMORY_BODY_LIMIT_BYTES, MEMORY_ERROR_STATUS, MEMORY_ROUTES, MEMORY_SKIN_HEADER, memoryMethod } from "../contract/routes";
import type { MemoryRuntimePool } from "./memory-runtime";

const log = createLogger("sno-station-mem:memory-routes");

class BodyLimitError extends Error {}

export async function serveMemoryRoute(request: IncomingMessage, response: ServerResponse, pathname: string,
	pool: MemoryRuntimePool, activeTasks: Set<Promise<void>>): Promise<boolean> {
	const method = memoryMethod(pathname);
	if (!method || request.method !== "POST") return false;
	const skinId = request.headers[MEMORY_SKIN_HEADER];
	let timer: NodeJS.Timeout | undefined;
	try {
		if (typeof skinId !== "string" || !skinId.trim()) throw new ContractError("invalid-input");
		const task = (async () => pool.invoke(method, await readBody(request), skinId))();
		const completion = task.then(() => undefined, () => undefined);
		activeTasks.add(completion);
		void completion.finally(() => activeTasks.delete(completion));
		const result = await Promise.race([task, new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new ContractError("timeout")), MEMORY_ROUTES[method].timeoutMs);
		})]);
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify(result));
	} catch (error) {
		if (!(error instanceof ContractError) && !(error instanceof BodyLimitError)) {
			log.error("Memory engine request failed", {
				method, skinId, error,
				error_message: error instanceof Error ? error.message : String(error),
				error_stack: error instanceof Error ? error.stack : undefined,
			}, {
				event_name: "memory.sidecar.request.failed", file: "packages/sno-station-mem/src/sidecar/memory-routes.ts",
				function: "serveMemoryRoute", site_id: "memory.sidecar.request.failed",
			});
		}
		const reason = error instanceof BodyLimitError ? "invalid-input" : error instanceof ContractError ? error.reason : "engine-failed";
		const status = error instanceof BodyLimitError ? 413 : MEMORY_ERROR_STATUS[reason];
		if (!response.headersSent) response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify({ degraded: true, reason, ...(error instanceof BodyLimitError ? { error: "payload_too_large" } : {}) }));
	} finally { if (timer) clearTimeout(timer); }
	return true;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = []; let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > MEMORY_BODY_LIMIT_BYTES) throw new BodyLimitError();
		chunks.push(buffer);
	}
	try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
	catch { throw new ContractError("invalid-input"); }
}
