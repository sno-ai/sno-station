import { AsyncLocalStorage } from "node:async_hooks";
import { createLogger } from "@snoai/utils/logger";

interface Operation {
	signal: AbortSignal;
	writes: number;
	transactionDepth: number;
}

const operations = new AsyncLocalStorage<Operation>();
const log = createLogger("sno-station-mem:cancellation");

/** Carries cancellation through the existing nested extraction and reflection writers. */
export async function withMemoryOperation<T>(method: string, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
	if (!signal) return run();
	const operation: Operation = { signal, writes: 0, transactionDepth: 0 };
	return operations.run(operation, async () => {
		try {
			signal.throwIfAborted();
			const result = await run();
			signal.throwIfAborted();
			return result;
		} finally {
			if (signal.aborted) log.error("memory.operation.aborted", {
				method, outcome: "aborted", writes: operation.writes,
			}, { event_name: "memory.operation.aborted", file: "packages/sno-station-mem/src/engine/operation-cancellation.ts",
				function: "withMemoryOperation", site_id: "memory.operation.aborted" });
		}
	});
}

export function memoryOperationSignal(signal?: AbortSignal): AbortSignal | undefined {
	const request = operations.getStore()?.signal;
	if (!request) return signal;
	if (!signal || request === signal) return request;
	return AbortSignal.any([request, signal]);
}

export function checkMemoryOperation(): void {
	const operation = operations.getStore();
	if (!operation?.transactionDepth) operation?.signal.throwIfAborted();
}

/** One synchronous SQL statement; failed statements never count as completed writes. */
export function memoryWrite<T>(write: () => T): T {
	checkMemoryOperation();
	const result = write();
	const operation = operations.getStore();
	if (operation) operation.writes++;
	return result;
}

/** A started transaction finishes atomically; rollback also restores its write count. */
export function memoryTransaction<T>(transaction: () => T): T {
	checkMemoryOperation();
	const operation = operations.getStore();
	if (!operation) return transaction();
	const writes = operation.writes;
	operation.transactionDepth++;
	try { return transaction(); }
	catch (error) { operation.writes = writes; throw error; }
	finally { operation.transactionDepth--; }
}

/** Do not cancel an in-progress file write; check before starting the next step. */
export async function memoryFileWrite<T>(write: () => Promise<T>): Promise<T> {
	checkMemoryOperation();
	const result = await write();
	const operation = operations.getStore();
	if (operation) operation.writes++;
	return result;
}
