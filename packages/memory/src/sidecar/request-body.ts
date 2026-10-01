import type { IncomingMessage } from "node:http";
import { MEMORY_BODY_LIMIT_BYTES } from "../contract/routes";

export class PayloadTooLargeError extends Error {
	constructor() { super("payload_too_large"); }
}

export function readRequestBody(request: IncomingMessage, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let bytes = 0;
		const cleanup = (): void => {
			request.off("data", onData);
			request.off("end", onEnd);
			request.off("error", onError);
			request.off("aborted", onAborted);
			signal?.removeEventListener("abort", onAbort);
		};
		const onError = (error: unknown): void => {
			cleanup();
			// Drain remaining input without retaining it or destroying the response socket.
			request.resume();
			reject(error);
		};
		const onAbort = (): void => onError(signal?.reason);
		const onAborted = (): void => onError(new Error("request_aborted"));
		const onEnd = (): void => { cleanup(); resolve(Buffer.concat(chunks).toString("utf8")); };
		const onData = (chunk: Buffer | string): void => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			bytes += buffer.length;
			if (bytes > MEMORY_BODY_LIMIT_BYTES) { onError(new PayloadTooLargeError()); return; }
			chunks.push(buffer);
		};
		request.on("data", onData);
		request.once("end", onEnd);
		request.once("error", onError);
		request.once("aborted", onAborted);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
}
