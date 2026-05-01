// Fixture HTTP server for sno-observe tests. Node-only (`node:http`); zero Bun APIs.
// Per design.md Decision 9 + tasks.md §15.3: replays the §10 / §2.2 status-code matrix
// on demand. Tests pass a `script` of responses via `enqueue(...)` or pre-seed a sequence
// in `start({ script: [...] })`.
//
// Usage:
//   const server = await startMockServer();
//   server.enqueue("/api/v1/events", { status: 202, body: { receipt_id: "r_1" } });
//   const url = server.baseUrl;          // "http://127.0.0.1:<port>"
//   await server.stop();

import { createServer } from "node:http";

export const statusCodeMatrix = Object.freeze({
	accepted: { status: 202, body: { receipt_id: "r_matrix" } },
	softDrop: { status: 202, body: { receipt_id: null } },
	idempotent: { status: 200, body: { received: 1 } },
	singleEnvelopeRequired: { status: 400, body: { error: "single_envelope_required" } },
	invalidEnvelope: { status: 400, body: { error: "invalid_envelope" } },
	invalidJson: { status: 400, body: { error: "invalid_json" } },
	agentIdNotInEnum: { status: 400, body: { error: "agent_id_not_in_enum" } },
	consentLevelNotInEnum: { status: 400, body: { error: "consent_level_not_in_enum" } },
	tokensMethodRequired: { status: 400, body: { error: "tokens_method_required" } },
	unauthorized: { status: 401, body: { error: "unauthorized" } },
	claimedCuidRequiresBearer: {
		status: 403,
		body: { error: "claimed_cuid_requires_bearer" },
	},
	claimedCuidInvalidBearer: {
		status: 403,
		body: { error: "claimed_cuid_invalid_bearer" },
	},
	payloadConflict: { status: 409, body: { error: "payload_conflict" } },
	chainSeedRequired: { status: 422, body: { error: "chain_seed_required" } },
	prevHashMismatch: { status: 422, body: { error: "prev_hash_mismatch" } },
	selfHashMismatch: { status: 422, body: { error: "self_hash_mismatch" } },
	rateLimitDaily: {
		status: 429,
		headers: { "X-RateLimit-Remaining": "0" },
		body: { errorType: "RATE_LIMIT_EXCEEDED", error: "Per-cuid quota exceeded" },
	},
	rateLimitRetryAfter: {
		status: 429,
		headers: { "Retry-After": "60" },
		body: { error: "Per-IP rate limit exceeded" },
	},
	chainPredecessorNotReady: {
		status: 503,
		headers: { "Retry-After": "5" },
		body: { error: "chain_predecessor_not_ready" },
	},
	serverError: { status: 500, body: { error: "queue_unavailable" } },
});

export function matrixResponse(name, overrides = {}) {
	const entry = statusCodeMatrix[name];
	if (entry === undefined) {
		throw new Error(`unknown status matrix response: ${name}`);
	}
	return {
		...entry,
		...overrides,
		headers: { ...(entry.headers ?? {}), ...(overrides.headers ?? {}) },
		body: overrides.body ?? entry.body,
	};
}

/**
 * @typedef {Object} ScriptEntry
 * @property {number} status
 * @property {Record<string, string>} [headers]
 * @property {object|string|null} [body]   // serialized as JSON if object/null; raw if string
 * @property {(req: import("node:http").IncomingMessage, body: string) => boolean} [match]
 *
 * @typedef {Object} CallRecord
 * @property {string} url
 * @property {string} method
 * @property {Record<string,string>} headers
 * @property {string} body
 * @property {number} ts
 */

export async function startMockServer({ script = [] } = {}) {
	/** @type {Map<string, ScriptEntry[]>} */
	const queues = new Map();
	/** @type {CallRecord[]} */
	const calls = [];

	for (const entry of script) {
		const path = entry.path ?? "/api/v1/events";
		if (!queues.has(path)) {
			queues.set(path, []);
		}
		queues.get(path).push(entry);
	}

	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			const path = (req.url ?? "").split("?")[0];
			calls.push({
				url: req.url ?? "/",
				method: req.method ?? "GET",
				headers: { ...req.headers },
				body,
				ts: Date.now(),
			});
			const queue = queues.get(path) ?? [];
			let entry;
			for (let i = 0; i < queue.length; i += 1) {
				const candidate = queue[i];
				if (candidate.match === undefined || candidate.match(req, body)) {
					entry = candidate;
					queue.splice(i, 1);
					break;
				}
			}
			if (entry === undefined) {
				// Default 202 receipt for events ingest, 404 for everything else.
				if (path === "/api/v1/events") {
					entry = { status: 202, body: { receipt_id: "r_default" } };
				} else if (path === "/api/v1/audit/verify") {
					entry = { status: 200, body: { verified: true, anchor_id: "a_default" } };
				} else {
					entry = { status: 404, body: { error: "no_script_entry" } };
				}
			}
			const headers = {
				"Content-Type": "application/json",
				...(entry.headers ?? {}),
			};
			const payload =
				entry.body === undefined
					? ""
					: typeof entry.body === "string"
						? entry.body
						: JSON.stringify(entry.body);
			res.writeHead(entry.status, headers);
			res.end(payload);
		});
		req.on("error", () => res.end());
	});

	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const baseUrl = `http://127.0.0.1:${address.port}`;

	return {
		baseUrl,
		calls,
		queues,
		/** @param {string} path @param {ScriptEntry} entry */
		enqueue(path, entry) {
			if (!queues.has(path)) {
				queues.set(path, []);
			}
			queues.get(path).push(entry);
		},
		enqueueMatrix(path, name, overrides = {}) {
			this.enqueue(path, matrixResponse(name, overrides));
		},
		reset() {
			calls.length = 0;
			queues.clear();
		},
		async stop() {
			await new Promise((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});
		},
	};
}

// CLI smoke: `node sno-ai-mock-server.mjs` starts on port 0 and prints baseUrl.
if (import.meta.url === `file://${process.argv[1]}`) {
	startMockServer().then((s) => {
		console.log(s.baseUrl);
	});
}
