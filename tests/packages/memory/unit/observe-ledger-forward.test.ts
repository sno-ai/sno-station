/**
 * Observe v2 (QCG-4, QCG-5 emitError half, QCG-6): the lane map covers the new types, skin errors
 * carry component and context, and the local ledger reaches buffer.db through a real
 * PluginObservability at most once, in batches of 50, keeping each row's own timestamp.
 * Nothing is mocked; the ingest base URL is a closed loopback port, so rows stay in buffer.db.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	laneForEventType,
	PluginObservability,
} from "../../../../packages/memory/src/engine/observability/adapter.ts";
import { pluginConfigSchema } from "../../../../packages/memory/src/engine/shared/types.ts";

type Envelope = {
	event_type: string;
	lane: string;
	ts_edge_ms: number;
	payload: Record<string, unknown>;
};
type EmitInput = Parameters<PluginObservability["tryEmit"]>[0];

const ENV_KEYS = [
	"HOME",
	"XDG_CONFIG_HOME",
	"SNO_HOME",
	"SNO_PROFILE_DIR",
	"SNO_BUFFER_PATH",
	"SNO_IDENTITY_PATH",
	"SNO_CONSENT_PATH",
] as const;
const T0 = 1_758_300_000_000;
const SAMPLES = [
	{
		event_type: "reach.message",
		lane: "squad",
		payload: { kind: "call", from_harness: "claude-code", to_harness: "codex", outcome: "ok", latency_ms: 812 },
	},
	{
		event_type: "rsi.run",
		lane: "rsi",
		payload: { sessions_read: 12, duration_ms: 4400, trigger: "timer", outcome: "ok" },
	},
	{
		event_type: "skill.run",
		lane: "skill",
		payload: {
			harness: "claude-code",
			skill_name: "peer-review",
			skill_version: "local",
			category: "J",
			duration_ms: 1,
			outcome: "ok",
		},
	},
];

let root: string;
let previousEnv: Record<string, string | undefined>;
let logs: string[];
const instances: PluginObservability[] = [];

/** A real PluginObservability that also records the sidecar offset visible at each tryEmit. */
class ObservedObservability extends PluginObservability {
	readonly seen: { eventType: string; synced: string }[] = [];

	override async tryEmit(input: EmitInput): Promise<boolean> {
		const synced = join(root, "observe", "ledger.synced");
		this.seen.push({
			eventType: input.eventType,
			synced: existsSync(synced) ? readFileSync(synced, "utf8").trim() : "absent",
		});
		return super.tryEmit(input);
	}
}

function observability(): ObservedObservability {
	const config = pluginConfigSchema.parse({
		embedding: { provider: "local-onnx" },
		observe: { enabled: true, agentId: "claude-code", baseUrl: "http://127.0.0.1:9" },
	});
	const instance = new ObservedObservability(config, root, { warn: (message) => logs.push(message) });
	instances.push(instance);
	return instance;
}

function envelopes(): Envelope[] {
	const path = join(root, "buffer.db");
	if (!existsSync(path)) return [];
	const db = new Database(path, { readonly: true });
	try {
		const rows = db.prepare("SELECT payload FROM events ORDER BY rowid").all() as { payload: Buffer }[];
		return rows.map((row) => JSON.parse(row.payload.toString("utf8")) as Envelope);
	} finally {
		db.close();
	}
}

/** Envelopes that came from the ledger (everything but the chain seed and error reports). */
function ledgerEnvelopes(): Envelope[] {
	return envelopes().filter((row) => row.event_type !== "agent.identify" && row.event_type !== "error");
}

/** Ledger line `n` (1-based) as written by `sno observe append`. */
function ledgerLine(n: number): string {
	const sample = SAMPLES[n % SAMPLES.length];
	return `${JSON.stringify({ ts_ms: T0 + n * 1000, event_type: sample.event_type, lane: sample.lane, payload: sample.payload })}\n`;
}

function expectedRow(n: number): [string, string, number] {
	const sample = SAMPLES[n % SAMPLES.length];
	return [sample.event_type, sample.lane, T0 + n * 1000];
}

function writeLedger(lines: string[]): void {
	mkdirSync(join(root, "observe"), { recursive: true });
	writeFileSync(join(root, "observe", "ledger.jsonl"), lines.join(""));
}

const bytes = (lines: string[]): number => Buffer.byteLength(lines.join(""), "utf8");
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const synced = (): string => readFileSync(join(root, "observe", "ledger.synced"), "utf8").trim();

beforeEach(() => {
	previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	root = mkdtempSync(join(tmpdir(), "observe-ledger-forward-"));
	mkdirSync(join(root, "home"));
	process.env.HOME = join(root, "home");
	delete process.env.XDG_CONFIG_HOME;
	delete process.env.SNO_HOME;
	process.env.SNO_PROFILE_DIR = root;
	process.env.SNO_BUFFER_PATH = join(root, "buffer.db");
	process.env.SNO_IDENTITY_PATH = join(root, "identity.json");
	process.env.SNO_CONSENT_PATH = join(root, "state", "consent.json");
	logs = [];
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		logs.push(String(chunk));
		return true;
	});
});

afterEach(async () => {
	for (const instance of instances.splice(0)) await instance.shutdown();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("laneForEventType", () => {
	it("maps the new types to squad, rsi and skill and keeps the existing lanes", () => {
		expect(typeof laneForEventType).toBe("function");
		const expected = {
			"reach.register": "squad",
			"reach.message": "squad",
			"handoff.trigger": "squad",
			"handoff.brief": "squad",
			"handoff.release": "squad",
			"handoff.pause": "squad",
			"handoff.complete": "squad",
			"handoff.quota": "squad",
			"review.run": "squad",
			"review.fix": "squad",
			"rsi.run": "rsi",
			"rsi.proposal": "rsi",
			"rsi.verdict": "rsi",
			"rsi.impact": "rsi",
			"rsi.lesson": "rsi",
			"skill.run": "skill",
			"skill.install": "skill",
			"llm.call": "llm",
			"tool.call": "skill",
			"consent.change": "security",
			"permission.request": "security",
			"memory.write": "memory",
		};
		const actual = Object.fromEntries(
			Object.keys(expected).map((type) => [type, laneForEventType(type as Parameters<typeof laneForEventType>[0])]),
		);
		expect(actual).toEqual(expected);
	});
});

describe("PluginObservability.emitError", () => {
	it("lands one error row carrying the skin component and the operation as context", async () => {
		await observability().emitError("memory.write:throw", new Error("disk full"));
		const errors = envelopes().filter((row) => row.event_type === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0].payload).toMatchObject({
			kind: "memory.write:throw",
			component: "mem-claude",
			context: "memory.write",
			recoverable: false,
		});
	});
});

describe("forwardObserveLedger", () => {
	let ledger: typeof import("../../../../packages/memory/src/engine/telemetry/observe-ledger.ts");

	beforeAll(async () => {
		ledger = await import("../../../../packages/memory/src/engine/telemetry/observe-ledger.ts");
	});

	it("uploads 120 rows in batches of 50, offset first, skipping a malformed line once", async () => {
		const lines = range(1, 120).map((n) => (n === 7 ? "{not json\n" : ledgerLine(n)));
		writeLedger(lines);
		expect(ledger.observeLedgerPath(root)).toBe(join(root, "observe", "ledger.jsonl"));
		expect(ledger.observeLedgerSyncedPath(root)).toBe(join(root, "observe", "ledger.synced"));
		const observe = observability();
		const rows = () => ledgerEnvelopes().map((row) => [row.event_type, row.lane, row.ts_edge_ms]);

		const first = await ledger.forwardObserveLedger({ profileDir: root, observe });
		expect(first).toEqual({ status: "forwarded", forwarded: 49, offset: bytes(lines.slice(0, 50)) });
		expect(synced()).toBe(String(bytes(lines.slice(0, 50))));
		const ledgerEmits = observe.seen.filter((call) => call.eventType !== "error");
		expect(ledgerEmits).toHaveLength(49);
		expect(ledgerEmits.every((call) => call.synced === String(bytes(lines.slice(0, 50))))).toBe(true);
		expect(rows()).toEqual([...range(1, 6), ...range(8, 50)].map(expectedRow));
		expect(ledgerEnvelopes()[0].payload).toEqual(SAMPLES[1].payload);
		await vi.waitFor(() => {
			const errors = envelopes().filter((row) => row.event_type === "error");
			expect(errors).toHaveLength(1);
			expect(errors[0].payload).toMatchObject({
				kind: "observe.ledger:parse",
				component: "mem-claude",
				context: "observe.ledger",
			});
		});

		const second = await ledger.forwardObserveLedger({ profileDir: root, observe });
		expect(second).toEqual({ status: "forwarded", forwarded: 50, offset: bytes(lines.slice(0, 100)) });
		expect(rows()).toEqual([...range(1, 6), ...range(8, 100)].map(expectedRow));

		const third = await ledger.forwardObserveLedger({ profileDir: root, observe });
		expect(third).toEqual({ status: "forwarded", forwarded: 20, offset: bytes(lines) });
		expect(rows()).toEqual([...range(1, 6), ...range(8, 120)].map(expectedRow));

		const fourth = await ledger.forwardObserveLedger({ profileDir: root, observe });
		expect(fourth).toEqual({ status: "idle", forwarded: 0, offset: bytes(lines) });
		expect(ledgerEnvelopes()).toHaveLength(119);
		expect(envelopes().filter((row) => row.event_type === "error")).toHaveLength(1);
	});

	it("stops the offset before a last line that has no trailing newline", async () => {
		const lines = [ledgerLine(1), ledgerLine(2), ledgerLine(3).trimEnd()];
		writeLedger(lines);
		const result = await ledger.forwardObserveLedger({ profileDir: root, observe: observability() });
		expect(result).toEqual({ status: "forwarded", forwarded: 2, offset: bytes(lines.slice(0, 2)) });
		expect(synced()).toBe(String(bytes(lines.slice(0, 2))));
		expect(ledgerEnvelopes().map((row) => row.ts_edge_ms)).toEqual([T0 + 1000, T0 + 2000]);
	});

	it("returns idle and logs when the stored offset is beyond the ledger", async () => {
		const lines = [ledgerLine(1), ledgerLine(2)];
		writeLedger(lines);
		const beyond = String(bytes(lines) + 100);
		writeFileSync(join(root, "observe", "ledger.synced"), beyond);
		const result = await ledger.forwardObserveLedger({ profileDir: root, observe: observability() });
		expect(result.status).toBe("idle");
		expect(result.forwarded).toBe(0);
		expect(synced()).toBe(beyond);
		expect(ledgerEnvelopes()).toHaveLength(0);
		expect(logs.some((line) => line.includes("offset beyond ledger"))).toBe(true);
	});

	it("two forwards started in the same tick upload 50 then 10 rows with no duplicate", async () => {
		const lines = range(1, 60).map(ledgerLine);
		writeLedger(lines);
		const observe = observability();
		const results = await Promise.all([
			ledger.forwardObserveLedger({ profileDir: root, observe }),
			ledger.forwardObserveLedger({ profileDir: root, observe }),
		]);
		expect(results.map((result) => result.forwarded)).toEqual([50, 10]);
		expect(synced()).toBe(String(bytes(lines)));
		const keys = ledgerEnvelopes().map((row) => `${row.event_type}@${row.ts_edge_ms}`);
		expect(keys).toHaveLength(60);
		expect(new Set(keys).size).toBe(60);
	});
});
