import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "@snoai/utils/logger";
import { ContractError } from "../contract/error";
import { MEMORY_ROUTES, MEMORY_DEFAULT_SKIN_ID, MEMORY_ERROR_STATUS, MEMORY_SKIN_HEADER, memoryMethod } from "../contract/routes";
import type { MemoryRuntimePool } from "./memory-runtime";

import { PayloadTooLargeError, readRequestBody } from "./request-body";

const log = createLogger("sno-station-mem:memory-routes");

export async function serveMemoryRoute(request: IncomingMessage, response: ServerResponse, pathname: string,
	openPool: () => Promise<MemoryRuntimePool>, activeTasks: Set<Promise<void>>): Promise<boolean> {
	const method = memoryMethod(pathname);
	if (!method || request.method !== "POST") return false;
	const skinId = request.headers[MEMORY_SKIN_HEADER];
	let timer: NodeJS.Timeout | undefined;
	const controller = new AbortController();
	try {
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				const error = new ContractError("timeout");
				controller.abort(error);
				reject(error);
			}, MEMORY_ROUTES[method].timeoutMs);
		});
		const task = (async () => {
			const body = await readBody(request, controller.signal);
			controller.signal.throwIfAborted();
			const pool = await openPool();
			controller.signal.throwIfAborted();
			return pool.invoke(method, body, typeof skinId === "string" && skinId.trim() ? skinId : MEMORY_DEFAULT_SKIN_ID);
		})();
		const completion = task.then(() => undefined, () => undefined);
		activeTasks.add(completion);
		void completion.finally(() => activeTasks.delete(completion));
		const result = await Promise.race([task, deadline]);
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify(result));
	} catch (error) {
			log.error("Memory engine request failed", {
				method, skinId, error,
				error_message: error instanceof Error ? error.message : String(error),
				error_stack: error instanceof Error ? error.stack : undefined,
			}, {
				event_name: "memory.sidecar.request.failed", file: "packages/sno-station-mem/src/sidecar/memory-routes.ts",
				function: "serveMemoryRoute", site_id: "memory.sidecar.request.failed",
			});
		if (error instanceof PayloadTooLargeError) {
			response.writeHead(413, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "payload_too_large" }));
			return true;
		}
		const reason = error instanceof ContractError ? error.reason : "engine-failed";
		const status = MEMORY_ERROR_STATUS[reason];
		if (!response.headersSent) response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify({ degraded: true, reason }));
	} finally { clearTimeout(timer); }
	return true;
}

async function readBody(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
	const body = await readRequestBody(request, signal);
	try { return JSON.parse(body); }
	catch { throw new ContractError("invalid-input"); }
}
