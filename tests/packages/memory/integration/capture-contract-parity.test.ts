import { userInfo } from "node:os";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "@snoai/utils/logger";
import { getDekSync } from "@snoai/sno-station-core-crypto";
import { createTestEnv } from "../../../apps/mem-claw/helpers/test-db";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store";
import { createRetriever } from "../../../../packages/sno-station-mem/src/engine/retrieval/retriever";
import { AccessTracker } from "../../../../packages/sno-station-mem/src/engine/retrieval/access-tracker";
import { PluginObservability } from "../../../../packages/sno-station-mem/src/engine/observability/adapter";
import { MemoryScopePolicy } from "../../../../packages/sno-station-mem/src/engine/security/memory-scope-policy";
import { onAgentEnd } from "../../../../packages/sno-station-mem/src/engine/bindings/sno-station-mem-ambient-learning-hook";
import { onBeforeAgentStart } from "../../../../packages/sno-station-mem/src/engine/bindings/sno-station-mem-auto-recall-hook";
import { MemoryContractRuntime } from "../../../../packages/sno-station-mem/src/engine/contract-runtime";
import { pluginConfigSchema } from "../../../../packages/sno-station-mem/src/contract/config/plugin-config-schema";
import type { Registration, Turn } from "../../../../packages/sno-station-mem/src/contract/index";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

async function fixture() {
	const env = await createTestEnv();
	const config = pluginConfigSchema.parse({ mode: "local-first", ambientLearning: true, autoRecall: true, captureAssistant: true, observe: { enabled: false } });
	const store = new MemoryStore({ dbPath: env.dbPath, vectorDim: env.embedder.dimensions, embedder: env.embedder, memoryTelemetry: config.memoryTelemetry });
	const accessTracker = new AccessTracker({ store, recallLifecycle: config.recallLifecycle });
	const logger = createLogger("zebra:contract-parity");
	const services = { store, embedder: env.embedder, accessTracker, logger,
		retriever: createRetriever(store, env.embedder, undefined, config.retrieval), stateDir: dirname(env.dbPath),
		observability: new PluginObservability(config, dirname(env.dbPath), logger) };
	cleanups.push(async () => { await accessTracker.destroy(); await store.close(); env.cleanup(); });
	const { mode, remEnhanced, agentNative, language, ...settings } = config;
	const registration: Registration = { skinId: "parity", settings, routing: { mode, remEnhanced, agentNative, language } };
	return { services, config, registration, sameKey: Buffer.from(getDekSync()) };
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
	it("commits the same durable row bytes before returning, without widening the supplied project", async () => {
		const original = await fixture();
		const contract = await fixture();
		expect(original.sameKey.equals(contract.sameKey)).toBe(true);
		original.sameKey.fill(0);
		contract.sameKey.fill(0);
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
	it("refuses operator-wide requests before SQL access and preserves scoped and operator-wide results", async () => {
		const { services, registration } = await fixture();
		const scope = { principal: userInfo().username, project: "agent:parity", session: "agent:parity:admin" };
		const runtime = new MemoryContractRuntime(services);
		await runtime.init(scope, registration);
		await services.store.store({ text: "Copper folder belongs to the release team.", category: "episodic", projectId: scope.project, importance: 0.7 });
		await services.store.store({ text: "Blue folder belongs to the support team.", category: "episodic", projectId: "agent:support", importance: 0.7 });
		const prepare = vi.spyOn(services.store.sqlite, "prepare");
		await expect(runtime.mutate({ op: "clear", all: true, confirm: true }, scope)).rejects.toThrow("system-caller-required");
		await expect(runtime.inspect({ op: "stats" }, scope)).rejects.toThrow("system-caller-required");
		expect(prepare).not.toHaveBeenCalled();
		prepare.mockRestore();
		expect(await runtime.inspect({ op: "stats", scope: scope.project }, scope)).toMatchObject({ result: { total: 1 } });
		const operator = { ...scope, host: { systemCaller: true } };
		expect(await runtime.inspect({ op: "stats" }, operator)).toMatchObject({ result: { total: 2 } });
		await runtime.mutate({ op: "clear", all: true, confirm: true }, operator);
		expect(await services.store.stats()).toMatchObject({ total: 0 });
	});
});
