import { userInfo } from "node:os";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "@snoai/utils/logger";
import { createTestEnv } from "../../../apps/mem-claw/helpers/test-db";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createRetriever } from "../../../../packages/memory/src/engine/retrieval/retriever";
import { AccessTracker } from "../../../../packages/memory/src/engine/retrieval/access-tracker";
import { PluginObservability } from "../../../../packages/memory/src/engine/observability/adapter";
import { MemoryScopePolicy } from "../../../../packages/memory/src/engine/security/memory-scope-policy";
import { onAgentEnd } from "../../../../packages/memory/src/engine/bindings/sno-station-mem-ambient-learning-hook";
import { onBeforeAgentStart } from "../../../../packages/memory/src/engine/bindings/sno-station-mem-auto-recall-hook";
import { MemoryContractRuntime } from "../../../../packages/memory/src/engine/contract-runtime";
import { pluginConfigSchema } from "../../../../packages/memory/config/plugin-config-schema";
import { defaultSettings } from "../../../../packages/memory/config/settings";
import type { Registration, Turn } from "../../../../packages/memory/src/contract/index";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

async function fixture() {
	const env = await createTestEnv();
	const config = pluginConfigSchema.parse({ mode: "local-first", modelCalls: defaultSettings().modelCalls, ambientLearning: true, autoRecall: true, captureAssistant: true, observe: { enabled: false } });
	const store = new MemoryStore({ dbPath: env.dbPath, vectorDim: env.embedder.dimensions, embedder: env.embedder, memoryTelemetry: config.memoryTelemetry });
	const accessTracker = new AccessTracker({ store, recallLifecycle: config.recallLifecycle });
	const logger = createLogger("zebra:contract-parity");
	const services = { config, store, embedder: env.embedder, accessTracker, logger,
		retriever: createRetriever(store, env.embedder, undefined, config.retrieval), stateDir: dirname(env.dbPath),
		observability: new PluginObservability(config, dirname(env.dbPath), logger) };
	cleanups.push(async () => { await accessTracker.destroy(); await store.close(); env.cleanup(); });
	const registration: Registration = { skinId: "parity" };
	return { services, config, registration };
}
function rows(store: MemoryStore) {
	return (store.sqlite.prepare("SELECT * FROM nodix_memories ORDER BY content_hash").all() as Record<string, unknown>[])
		.map(({ id, fact_id, timestamp, ...row }) => row);
}
function auxiliaryRows(store: MemoryStore) {
	const tables = store.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE '%entities%' OR name LIKE '%ledger%' OR name LIKE '%extraction_timestamps%') ORDER BY name").all() as { name: string }[];
	expect(tables.length).toBeGreaterThan(0);
	return Object.fromEntries(tables.map(({ name }) => [name,
		store.sqlite.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
			.map(row => JSON.stringify(row)).sort()]));
}

describe("capture contract preserves the existing hook path", () => {
	it.each([
		{ name: "ambientLearning is false", ambientLearning: false, sessionKey: "agent:parity:benchmark-answer" },
		{ name: "the session is a subagent", ambientLearning: true, sessionKey: "agent:parity:subagent:answer" },
	])("skips capture when $name", async ({ ambientLearning, sessionKey }) => {
		const { services, config } = await fixture();
		const writes = vi.spyOn(services.store, "store");
		const result = await onAgentEnd(services, { ...config, ambientLearning }, services.store,
			services.embedder, new MemoryScopePolicy({ default: "agent:parity" }), undefined,
			{ success: true, messages: [{ role: "user", content: "My stable personal preference is jasmine tea." }] },
			{ agentId: "parity", sessionKey }, services.stateDir);
		expect(result).toBe("skipped");
		expect(writes).toHaveBeenCalledTimes(0);
		expect(services.store.sqlite.prepare("SELECT text FROM nodix_memories").all()).toEqual([]);
	});

	it.each([
		{ name: "autoRecall is false", settings: { autoRecall: false }, agentId: "parity", sessionKey: "agent:parity:answer" },
		{ name: "the agent is excluded", settings: { autoRecallExcludeAgents: ["parity"] }, agentId: "parity", sessionKey: "agent:parity:answer" },
		{ name: "the session agent is excluded", settings: { autoRecallExcludeAgents: ["parity"] }, agentId: undefined, sessionKey: "agent:parity:answer" },
		{ name: "the agent is absent from the whitelist", settings: { autoRecallIncludeAgents: ["support"] }, agentId: "parity", sessionKey: "agent:parity:answer" },
		{ name: "the session is a subagent", settings: {}, agentId: "parity", sessionKey: "agent:parity:subagent:answer" },
		{ name: "the agent id is a chat id", settings: {}, agentId: "657229412030480397", sessionKey: "agent:657229412030480397:answer" },
	])("skips auto recall when $name", async ({ settings, agentId, sessionKey }) => {
		const { services, config } = await fixture();
		await services.store.store({ text: "My stable personal preference is jasmine tea.",
			category: "episodic", projectId: "agent:parity", importance: 0.9 });
		const retrieval = vi.spyOn(services.retriever, "retrieve");
		const result = await onBeforeAgentStart(services, { ...config, ...settings },
			services.retriever, services.store, new MemoryScopePolicy({ default: "agent:parity" }),
			new Map(), new Map(), { prompt: "What is my stable personal preference for tea?" },
			{ agentId, sessionKey }, services.stateDir);
		expect(retrieval).toHaveBeenCalledTimes(0);
		expect(result).toBeUndefined();
	});

	it("lets the auto recall whitelist override the blocklist", async () => {
		const { services, config } = await fixture();
		await services.store.store({ text: "My stable personal preference is jasmine tea.",
			category: "episodic", projectId: "agent:parity", importance: 0.9 });
		const result = await onBeforeAgentStart(services,
			{ ...config, autoRecallIncludeAgents: ["parity"], autoRecallExcludeAgents: ["parity"] },
			services.retriever, services.store, new MemoryScopePolicy({ default: "agent:parity" }),
			new Map(), new Map(), { prompt: "What is my stable personal preference for tea?" },
			{ agentId: "parity", sessionKey: "agent:parity:answer" }, services.stateDir);
		expect(result?.prependContext).toContain("jasmine tea");
	});

	it("reports partial and failed local capture from durable writes", async () => {
		const { services, config } = await fixture();
		services.store.sqlite.exec(`CREATE TRIGGER fail_capture BEFORE INSERT ON nodix_memories
			WHEN NEW.text = 'I keep a red notebook.' BEGIN SELECT RAISE(FAIL, 'test write failure'); END`);
		const capture = () => onAgentEnd(services, config, services.store, services.embedder,
			new MemoryScopePolicy({ default: "agent:parity" }), undefined,
			{ success: true, messages: [
				{ role: "user", content: "I keep a blue notebook." },
				{ role: "user", content: "I keep a red notebook." },
			] }, { agentId: "parity", sessionKey: "agent:parity:failures" }, services.stateDir);
		expect(await capture()).toBe("partial");
		expect(services.store.sqlite.prepare("SELECT text FROM nodix_memories").all())
			.toEqual([{ text: "I keep a blue notebook." }]);
		services.store.sqlite.exec(`DELETE FROM nodix_memories; DROP TRIGGER fail_capture;
			CREATE TRIGGER fail_capture BEFORE INSERT ON nodix_memories
			BEGIN SELECT RAISE(FAIL, 'test write failure'); END`);
		expect(await capture()).toBe("failed");
		expect(services.store.sqlite.prepare("SELECT text FROM nodix_memories").all()).toEqual([]);
	});

	it("keeps the statement anchor beside a resolved event date", async () => {
		const { services, config } = await fixture();
		await services.store.store({
			text: "Avery visited the botanical garden last week.", category: "episodic",
			projectId: "agent:parity", importance: 0.9,
			metadata: JSON.stringify({ kind: "episodic", temporal_date: "2022-09-05/2022-09-12",
				temporal_precision: "week", temporal_resolution_status: "resolved",
				source_order: { session_moment: 1663162980000 },
				source_span: { quote: "I visited the botanical garden last week." } }),
		});
		const result = await onBeforeAgentStart(services, config, services.retriever, services.store,
			new MemoryScopePolicy({ default: "agent:parity" }), new Map(), new Map(),
			{ prompt: "When did Avery visit the botanical garden?" },
			{ agentId: "parity", sessionKey: "agent:parity:date-proof" }, services.stateDir);
		expect(result?.prependContext).toContain('"event_date":"2022-09-05/2022-09-12"');
		expect(result?.prependContext).toContain('"said_on":"2022-09-14"');
		expect(result?.prependContext).toContain('"quote":"I visited the botanical garden last week."');
	});

	it("commits the same durable row bytes before returning, without widening the supplied project", async () => {
		const original = await fixture();
		const contract = await fixture();
		const scope = { principal: userInfo().username, project: "agent:parity", session: "agent:parity:release", host: { agentId: "parity", sessionKey: "agent:parity:release", sessionTimezone: "America/Los_Angeles" } };
		const turn: Turn = { turnId: "release-turn", rewindEpoch: 0, messages: [
			// The first real user turn from agent phase 105.
			{ role: "user", content: "My stable personal preference is jasmine tea.", at: Date.parse("2026-09-09T18:00:00Z") },
		] };
		// The move-only check separately compares this retained hook to its frozen pre-move source.
		await onAgentEnd(original.services, original.config, original.services.store, original.services.embedder,
			new MemoryScopePolicy({ default: scope.project }), undefined,
			{ success: true, messages: turn.messages.map(({ at, ...message }) => ({ ...message, timestamp: at })) },
			{ agentId: "parity", sessionKey: scope.session, sessionTimezone: scope.host.sessionTimezone }, original.services.stateDir);
		const runtime = new MemoryContractRuntime(contract.services);
		await runtime.init(scope, contract.registration);
		let release: (() => void) | undefined;
		let deferred: Promise<unknown> | undefined;
		if (process.env.ZEBRA_PLANT_DEFERRED_CAPTURE === "1") {
			// Deliberately return the receipt while the real engine waits at the hand-off.
			const hold = new Promise<void>(resolve => { release = resolve; });
			deferred = hold.then(() => runtime.capture(turn, scope));
		} else {
			expect(await runtime.capture(turn, scope)).toMatchObject({ degraded: false, committed: true });
		}
		const before = rows(original.services.store), after = rows(contract.services.store);
		expect(before.length).toBeGreaterThan(0);
		try { expect(after).toEqual(before); }
		finally { release?.(); await deferred; }
		expect(auxiliaryRows(contract.services.store)).toEqual(auxiliaryRows(original.services.store));
		const query = "What is my stable personal preference for tea?";
		const previous = await onBeforeAgentStart(original.services, original.config,
			original.services.retriever, original.services.store, new MemoryScopePolicy({ default: scope.project }),
			new Map(), new Map(), { prompt: query }, { agentId: "parity", sessionKey: scope.session }, original.services.stateDir);
		const recalled = await runtime.getRecall(query, scope, { source: "auto" });
		// Stable content identifies hits across the two independently allocated row-id spaces.
		function stable(text: string, store: MemoryStore) {
			for (const row of store.sqlite.prepare("SELECT id FROM nodix_memories").all() as { id: string }[]) {
				text = text.replaceAll(row.id, "<memory-id>").replaceAll(row.id.slice(0, 8), "<memory-id-prefix>");
			}
			return text;
		}
		expect(previous?.prependContext).toContain("jasmine tea");
		expect(stable(recalled.contextText, contract.services.store)).toEqual(stable(previous?.prependContext ?? "", original.services.store));
		expect(await contract.services.store.stats("agent:unrelated")).toMatchObject({ total: 0 });
	});
	it("serves scoped and whole-store requests without an operator admission check", async () => {
		const { services, registration } = await fixture();
		const scope = { principal: userInfo().username, project: "agent:parity", session: "agent:parity:admin" };
		const runtime = new MemoryContractRuntime(services);
		await runtime.init(scope, registration);
		await services.store.store({ text: "Copper folder belongs to the release team.", category: "episodic", projectId: scope.project, importance: 0.7 });
		await services.store.store({ text: "Blue folder belongs to the support team.", category: "episodic", projectId: "agent:support", importance: 0.7 });
		expect(await runtime.inspect({ op: "stats", scope: scope.project }, scope)).toMatchObject({ result: { total: 1 } });
		const operator = scope;
		expect(await runtime.inspect({ op: "stats" }, operator)).toMatchObject({ result: { total: 2 } });
		await runtime.mutate({ op: "clear", all: true, confirm: true }, operator);
		expect(await services.store.stats()).toMatchObject({ total: 0 });
	});
});
