// The SDK never refuses, drops, samples, or strands an event, and every server answer that is
// not an acceptance moves the chain on instead of freezing it. Real SQLite, fake server only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import DatabaseConstructor from "better-sqlite3";
import { createSnoObserve } from "../../../../packages/observability/dist/index.js";
import { createDoctorReport } from "../../../../packages/observability/dist/internal/doctor.js";
import { cleanupTempSnoEnv, createTempSnoEnv, validPayloads } from "../fixtures/temp-env.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A fake sno.ai that records every envelope and answers per event id. */
function fakeServer(answer = () => undefined) {
	const posted = [];
	const fetch = async (url, init) => {
		const body = JSON.parse(String(init.body));
		if (String(url).endsWith("/api/v1/identity/register-machine")) {
			return json({ user_cuid: body.user_cuid, machine_uuid: body.machine_uuid, claimed: false }, 200);
		}
		posted.push(body);
		return answer(body, posted) ?? json({ receipt_id: body.event_id }, 202);
	};
	return { posted, fetch };
}

function json(body, status) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function memoryWrite(agentId = "codex") {
	return { event_type: "memory.write", lane: "memory", agent_id: agentId, payload: validPayloads["memory.write"] };
}

describe("nothing blocks an observe upload", () => {
	it("consent changes ship on the security lane and an llm.call-first epoch still identifies on memory", async () => {
		const temp = createTempSnoEnv("sno-observe-lanes-");
		const server = fakeServer();
		const observe = createSnoObserve({ env: temp.env, cwd: temp.dir, fetch: server.fetch });
		try {
			await observe.emit({ event_type: "llm.call", lane: "llm", agent_id: "hermes", payload: validPayloads["llm.call"] });
			await observe.consent.set("full", "test");
			await observe.flush({ force: true });
			const lanes = server.posted.map((envelope) => `${envelope.event_type}:${envelope.lane}`);
			assert.equal(lanes.includes("agent.identify:memory"), true);
			assert.equal(lanes.includes("llm.call:llm"), true);
			assert.equal(lanes.includes("consent.change:security"), true);
			assert.equal(lanes.some((entry) => entry.startsWith("agent.identify:") && !entry.endsWith(":memory")), false);
			assert.equal(server.posted.every((envelope) => envelope.scope.agent_id === "hermes"), true);
		} finally {
			await observe.shutdown();
			cleanupTempSnoEnv(temp);
		}
	});

	it("a rejected row becomes evidence and every later row ships in a fresh epoch on the same flush", async () => {
		const temp = createTempSnoEnv("sno-observe-reject-");
		const previousProfile = process.env.SNO_PROFILE_DIR;
		process.env.SNO_PROFILE_DIR = temp.dir;
		let badId;
		const server = fakeServer((envelope) =>
			envelope.event_id === badId ? json({ error: "lane_event_type_mismatch" }, 400) : undefined,
		);
		const observe = createSnoObserve({ env: temp.env, cwd: temp.dir, fetch: server.fetch });
		try {
			await observe.emit(memoryWrite());
			badId = (await observe.emit(memoryWrite())).eventId;
			const after = [(await observe.emit(memoryWrite())).eventId, (await observe.emit(memoryWrite())).eventId];
			const result = await observe.flush({ force: true });
			assert.equal(result.retryable, 0);
			assert.equal(result.terminal, 1);
			assert.equal(server.posted.filter((envelope) => envelope.event_id === badId).length, 1);
			const carried = server.posted.filter((envelope) => after.includes(envelope.event_id));
			assert.deepEqual(carried.map((envelope) => [envelope.chain_epoch, envelope.seq]), [[1, 1], [1, 2]]);
			assert.equal(carried.every((envelope) => envelope.hash_chain.prev !== "GENESIS"), true);
			const db = new DatabaseConstructor(temp.env.SNO_BUFFER_PATH, { readonly: true });
			try {
				assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE shipped = 0").get().n, 0);
				assert.equal(db.prepare("SELECT reason FROM quarantine").get().reason, "lane_event_type_mismatch");
			} finally {
				db.close();
			}
			const log = readFileSync(join(temp.dir, "observe.log"), "utf8");
			assert.equal(log.includes("lane_event_type_mismatch"), true);
		} finally {
			await observe.shutdown();
			if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR;
			else process.env.SNO_PROFILE_DIR = previousProfile;
			cleanupTempSnoEnv(temp);
		}
	});

	it("an epoch the server has never heard of is re-sent from GENESIS on the same flush", async () => {
		const temp = createTempSnoEnv("sno-observe-unknown-epoch-");
		const server = fakeServer((envelope) =>
			envelope.chain_epoch === 0 && envelope.seq > 0
				? json(
						{
							reason: "chain_predecessor_not_ready",
							error: {
								code: "chain_predecessor_not_ready",
								chain_epoch: 0,
								expected_seq: envelope.seq - 1,
								received_seq: envelope.seq,
								latest_seq: null,
								latest_state: null,
								last_committed_seq: null,
								chain_stall_ms: null,
							},
						},
						409,
					)
				: undefined,
		);
		const observe = createSnoObserve({ env: temp.env, cwd: temp.dir, fetch: server.fetch });
		try {
			const ids = [(await observe.emit(memoryWrite())).eventId, (await observe.emit(memoryWrite())).eventId];
			const result = await observe.flush({ force: true });
			assert.equal(result.retryable, 0);
			// epoch 0's identify, then the identify and both rows of epoch 1
			assert.equal(result.shipped, 4);
			const accepted = server.posted.filter((envelope) => envelope.chain_epoch === 1);
			assert.deepEqual(
				accepted.map((envelope) => [envelope.event_type, envelope.seq, envelope.hash_chain.prev === "GENESIS"]),
				[["agent.identify", 0, true], ["memory.write", 1, false], ["memory.write", 2, false]],
			);
			assert.deepEqual(accepted.slice(1).map((envelope) => envelope.event_id), ids);
		} finally {
			await observe.shutdown();
			cleanupTempSnoEnv(temp);
		}
	});

	it("server consent lower than local: each refused row is re-sent at metadata-only, the setting stays", async () => {
		const temp = createTempSnoEnv("sno-observe-suppressed-");
		const server = fakeServer((envelope) =>
			envelope.consent_level === "full"
				? json({ error: "consent_suppressed", reason: "chain_reset_required" }, 409)
				: undefined,
		);
		const observe = createSnoObserve({ env: temp.env, cwd: temp.dir, fetch: server.fetch });
		try {
			await observe.emit(memoryWrite());
			await observe.consent.set("full", "test");
			const id = (await observe.emit({
				event_type: "prompt.submit",
				lane: "memory",
				agent_id: "codex",
				payload: validPayloads["prompt.submit"],
			})).eventId;
			const result = await observe.flush({ force: true });
			assert.equal(result.retryable, 0);
			// every "full" row is refused once and re-sent lowered; the local setting is the user's
			const sent = server.posted.filter((envelope) => envelope.event_id === id);
			assert.deepEqual(sent.map((envelope) => envelope.consent_level), ["full", "metadata-only"]);
			assert.equal(observe.consent.get(), "full");
			const db = new DatabaseConstructor(temp.env.SNO_BUFFER_PATH, { readonly: true });
			try {
				assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE shipped = 0").get().n, 0);
			} finally {
				db.close();
			}
		} finally {
			await observe.shutdown();
			cleanupTempSnoEnv(temp);
		}
	});

	it("server consent off for one row: only that row is kept locally, the rows behind it still ship", async () => {
		const temp = createTempSnoEnv("sno-observe-consent-off-");
		let refusedId;
		const server = fakeServer((envelope) =>
			envelope.event_id === refusedId
				? json({ error: "consent_suppressed", reason: "chain_reset_required" }, 409)
				: undefined,
		);
		const observe = createSnoObserve({ env: temp.env, cwd: temp.dir, fetch: server.fetch });
		try {
			refusedId = (await observe.emit(memoryWrite())).eventId;
			const laterId = (await observe.emit(memoryWrite())).eventId;
			const result = await observe.flush({ force: true });
			assert.deepEqual({ terminal: result.terminal, retryable: result.retryable }, { terminal: 1, retryable: 0 });
			assert.equal(server.posted.filter((envelope) => envelope.event_id === refusedId).length, 1);
			assert.equal(server.posted.filter((envelope) => envelope.event_id === laterId).length, 1);
			const db = new DatabaseConstructor(temp.env.SNO_BUFFER_PATH, { readonly: true });
			try {
				assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE shipped = 0").get().n, 0);
				assert.equal(db.prepare("SELECT event_id FROM quarantine").get().event_id, refusedId);
			} finally {
				db.close();
			}
		} finally {
			await observe.shutdown();
			cleanupTempSnoEnv(temp);
		}
	});

	it("an identify the server refuses for good does not breed new identifies", async () => {
		const temp = createTempSnoEnv("sno-observe-identify-refused-");
		const server = fakeServer((envelope) =>
			envelope.event_type === "agent.identify" ? json({ error: "invalid_envelope" }, 400) : undefined,
		);
		const observe = createSnoObserve({ env: temp.env, cwd: temp.dir, fetch: server.fetch });
		try {
			await observe.emit(memoryWrite());
			await observe.emit(memoryWrite());
			const result = await observe.flush({ force: true });
			assert.deepEqual({ shipped: result.shipped, terminal: result.terminal, retryable: result.retryable }, { shipped: 0, terminal: 3, retryable: 0 });
			assert.equal(server.posted.length, 1);
			const db = new DatabaseConstructor(temp.env.SNO_BUFFER_PATH, { readonly: true });
			try {
				assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE shipped = 0").get().n, 0);
				assert.equal(db.prepare("SELECT COUNT(*) AS n FROM quarantine").get().n, 3);
				assert.equal(db.prepare("SELECT MAX(chain_epoch) AS e FROM chain_tail").get().e, 0);
			} finally {
				db.close();
			}
		} finally {
			await observe.shutdown();
			cleanupTempSnoEnv(temp);
		}
	});

	it("server consent off on the memory lane: the chain waits for it, nothing is dropped", async () => {
		const temp = createTempSnoEnv("sno-observe-lane-off-");
		const server = fakeServer((envelope) =>
			envelope.event_type === "agent.identify"
				? json({ error: "consent_suppressed", reason: "chain_reset_required" }, 409)
				: undefined,
		);
		const observe = createSnoObserve({ env: temp.env, cwd: temp.dir, fetch: server.fetch });
		try {
			await observe.emit(memoryWrite());
			await observe.emit(memoryWrite());
			const result = await observe.flush({ force: true });
			assert.deepEqual({ shipped: result.shipped, terminal: result.terminal, retryable: result.retryable }, { shipped: 0, terminal: 0, retryable: 1 });
			assert.equal(result.retryAfterMs >= 3_600_000, true);
			assert.equal(server.posted.length, 1);
			const db = new DatabaseConstructor(temp.env.SNO_BUFFER_PATH, { readonly: true });
			try {
				assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE shipped = 0 AND terminal = 0").get().n, 3);
				assert.equal(db.prepare("SELECT COUNT(*) AS n FROM quarantine").get().n, 0);
			} finally {
				db.close();
			}
		} finally {
			await observe.shutdown();
			cleanupTempSnoEnv(temp);
		}
	});

	it("a day-old stuck row with a hundred failed attempts does not stop new events from being recorded", async () => {
		const temp = createTempSnoEnv("sno-observe-old-queue-");
		const server = fakeServer();
		const observe = createSnoObserve({ env: temp.env, cwd: temp.dir, fetch: server.fetch });
		try {
			await observe.emit(memoryWrite());
			const db = new DatabaseConstructor(temp.env.SNO_BUFFER_PATH);
			try {
				db.prepare("UPDATE events SET created_at = ?, attempts = 100").run(Date.now() - 3 * DAY_MS);
			} finally {
				db.close();
			}
			const later = await observe.emit(memoryWrite());
			assert.equal(later.accepted, true);
			assert.equal(later.reason, undefined);
			await observe.flush({ force: true });
			assert.equal(server.posted.some((envelope) => envelope.event_id === later.eventId), true);
		} finally {
			await observe.shutdown();
			cleanupTempSnoEnv(temp);
		}
	});

	it("every tool.call is recorded and a fractional latency is rounded, not refused", async () => {
		const temp = createTempSnoEnv("sno-observe-tools-");
		const server = fakeServer();
		const observe = createSnoObserve({ env: temp.env, cwd: temp.dir, fetch: server.fetch });
		try {
			for (let i = 0; i < 40; i += 1) {
				const result = await observe.emit({
					event_type: "tool.call",
					lane: "skill",
					agent_id: "claude-code",
					payload: { ...validPayloads["tool.call"], tool_name: `tool-${i}`, latency_ms: 12.7 },
				});
				assert.equal(result.accepted, true);
			}
			await observe.flush({ force: true });
			const tools = server.posted.filter((envelope) => envelope.event_type === "tool.call");
			assert.equal(tools.length, 40);
			assert.equal(tools.every((envelope) => envelope.payload.latency_ms === 13), true);
		} finally {
			await observe.shutdown();
			cleanupTempSnoEnv(temp);
		}
	});

	it("the shipped count survives retention and diagnostics stay off the host's stdout and stderr", async () => {
		const temp = createTempSnoEnv("sno-observe-doctor-");
		const server = fakeServer();
		const previousProfile = process.env.SNO_PROFILE_DIR;
		process.env.SNO_PROFILE_DIR = temp.dir;
		const out = mock.method(process.stdout, "write", () => true);
		const err = mock.method(process.stderr, "write", () => true);
		const observe = createSnoObserve({ env: temp.env, cwd: temp.dir, fetch: server.fetch });
		try {
			await observe.emit(memoryWrite());
			await observe.flush({ force: true });
			const db = new DatabaseConstructor(temp.env.SNO_BUFFER_PATH);
			try {
				db.prepare("UPDATE events SET created_at = ?").run(Date.now() - 3 * DAY_MS);
			} finally {
				db.close();
			}
			await observe.flush({ force: true });
			const report = createDoctorReport(temp.env);
			assert.equal(report.buffer.detail.includes("queue_depth=0/0"), true);
			assert.equal(report.last_ship.detail, "2 event(s) shipped to https://sno.test so far; nothing pending");
			assert.equal(out.mock.callCount(), 0);
			assert.equal(err.mock.callCount(), 0);
		} finally {
			out.mock.restore();
			err.mock.restore();
			await observe.shutdown();
			if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR;
			else process.env.SNO_PROFILE_DIR = previousProfile;
			cleanupTempSnoEnv(temp);
		}
	});
});
