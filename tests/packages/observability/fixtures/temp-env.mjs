// Shared test helpers: tmpdir-isolated SNO_PROFILE_DIR, fixture event factories, fetch recorder.
// Used by both unit/ and integration/ tests; not a test file itself.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createTempSnoEnv(prefix = "sno-observe-") {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	return {
		dir,
		env: {
			SNO_PROFILE_DIR: dir,
			SNO_IDENTITY_PATH: join(dir, "identity.json"),
			SNO_BUFFER_PATH: join(dir, "buffer.db"),
			SNO_CONSENT_PATH: join(dir, "state", "consent.json"),
			SNO_OBSERVE_BASE_URL: "https://sno.test",
			HOME: dir,
		},
	};
}

export function cleanupTempSnoEnv(temp) {
	rmSync(temp.dir, { recursive: true, force: true });
}

export function initGitRepo(dir, remote) {
	mkdirSync(dir);
	for (const args of [["init"], ["remote", "add", "origin", remote]]) {
		const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	}
}

export function createFetchRecorder(statuses = []) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		if (String(url).endsWith("/api/v1/identity/register-machine")) {
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
			return new Response(
				JSON.stringify({
					user_cuid: body.user_cuid,
					machine_uuid: body.machine_uuid,
					claimed: false,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		calls.push({
			url: String(url),
			init,
			body: typeof init?.body === "string" ? init.body : undefined,
			headers: headerRecord(init?.headers),
		});
		const statusSpec = statuses.shift() ?? 202;
		const status = typeof statusSpec === "number" ? statusSpec : statusSpec.status;
		const headers = {
			"Content-Type": "application/json",
			...(typeof statusSpec === "number" ? {} : (statusSpec.headers ?? {})),
		};
		const body =
			typeof statusSpec === "number" || statusSpec.body === undefined
				? JSON.stringify({ received: status === 200 || status === 202 ? 1 : 0 })
				: statusSpec.body;
		return new Response(body, { status, headers });
	};
	return { calls, fetch: fetchImpl };
}

export function headerRecord(headers) {
	if (headers === undefined) {
		return {};
	}
	if (headers instanceof Headers) {
		return Object.fromEntries(headers.entries());
	}
	if (Array.isArray(headers)) {
		return Object.fromEntries(headers);
	}
	return { ...headers };
}

export function testHash(index) {
	return index.toString(16).padStart(64, "0");
}

export const validPayloads = {
	"agent.identify": {
		agent_id: "codex",
		machine_id: "018f7d0c-fd8b-7ccf-9b9b-0a2ea938ad0d",
		sdk_version: "0.1.0",
	},
	"memory.write": {
		key_hash: testHash(1),
		byte_len: 12,
		content_tokens: 3,
		tokens_method: "char_approximation",
	},
	"memory.read": {
		query_hash: testHash(2),
		query_tokens: 2,
		k: 5,
		hit_count: 1,
		result_tokens: 10,
		latency_ms: 4,
		tokens_method: "tiktoken",
	},
	"memory.snapshot": {
		session_uuid: "018f7d0c-fd8b-7ccf-9b9b-0a2ea938ad0d",
		snapshot_reason: "session_end",
		total_entries: 2,
		total_bytes: 256,
		oldest_entry_ts_ms: 1730000000000,
		newest_entry_ts_ms: 1730000001000,
	},
	"memory.telemetry": {
		sync_kind: "memory_events",
		first_event_id: 1,
		last_event_id: 2,
		event_count: 2,
		event_types: { create: 1, recall: 1 },
		events: [
			{
				event_id: 1,
				event_type: "create",
				fact_id: "fact-1",
				memory_kind: "episodic",
				timestamp_ms: 1730000000000,
				agent_id: "codex",
				project_id: "p_test",
				content_hash: testHash(8),
			},
			{
				event_id: 2,
				event_type: "recall",
				fact_id: "fact-1",
				memory_kind: "episodic",
				timestamp_ms: 1730000001000,
				session_uuid: "session-1",
				turn_id: "turn-1",
				agent_id: "codex",
				project_id: "p_test",
				retrieval_rank: 1,
				retrieval_score: 0.7,
			},
		],
	},
	"llm.call": {
		model: "gpt-4o",
		prompt_tokens: 10,
		completion_tokens: 3,
		latency_ms: 120,
		cache_read_tokens: 0,
		cache_write_tokens: 0,
		token_source: "host_agent_paid",
	},
	"tool.call": {
		tool_name: "bash",
		decision: "allow",
		input_hash: testHash(3),
		output_hash: testHash(4),
		latency_ms: 8,
	},
	"session.start": { session_uuid: "018f7d0c-fd8b-7ccf-9b9b-0a2ea938ad0d" },
	"session.end": { session_uuid: "018f7d0c-fd8b-7ccf-9b9b-0a2ea938ad0d", duration_ms: 1000 },
	"prompt.submit": { prompt_hash: testHash(5), byte_len: 9 },
	"permission.request": { kind: "shell", decision: "deny", target_hash: testHash(6) },
	"consent.change": { from: "metadata-only", to: "off", reason: "test" },
	error: { kind: "recoverable", message_hash: testHash(7), recoverable: true },
	"cost.summary": {
		session_uuid: "018f7d0c-fd8b-7ccf-9b9b-0a2ea938ad0d",
		tokens_in: 20,
		tokens_out: 5,
		llm_calls: 1,
		tool_calls: 1,
		memory_reads: 2,
		memory_writes: 3,
		host_agent_prompt_tokens: 10,
		host_agent_completion_tokens: 3,
		plugin_internal_prompt_tokens: 10,
		plugin_internal_completion_tokens: 2,
		local_memory_input_tokens: 12,
		local_memory_output_tokens: 8,
	},
};

export const expectedEventTypes = [
	"agent.identify",
	"memory.write",
	"memory.read",
	"memory.snapshot",
	"memory.telemetry",
	"llm.call",
	"tool.call",
	"session.start",
	"session.end",
	"prompt.submit",
	"permission.request",
	"consent.change",
	"error",
	"cost.summary",
];

export const scope = {
	user_id: "u_test",
	machine_id: "018f7d0c-fd8b-7ccf-9b9b-0a2ea938ad0d",
	agent_id: "codex",
	project_id: "p_test",
};

export const distRoot = "../../../../packages/observability/dist";
