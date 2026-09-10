import { userInfo } from "node:os";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "@snoai/utils/logger";
import { createTestEnv } from "../../../apps/mem-claw/helpers/test-db";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store";
import { MemoryRetriever } from "../../../../packages/sno-station-mem/src/engine/retrieval/retriever";
import { AccessTracker } from "../../../../packages/sno-station-mem/src/engine/retrieval/access-tracker";
import { PluginObservability } from "../../../../packages/sno-station-mem/src/engine/observability/adapter";
import { MemoryScopePolicy } from "../../../../packages/sno-station-mem/src/engine/security/memory-scope-policy";
import { onAgentEnd } from "../../../../packages/sno-station-mem/src/engine/bindings/sno-station-mem-ambient-learning-hook";
import { MemoryContractRuntime } from "../../../../packages/sno-station-mem/src/engine/contract-runtime";
import { pluginConfigSchema } from "../../../../packages/sno-station-mem/src/contract/config/plugin-config-schema";
import type { Registration, Turn } from "../../../../packages/sno-station-mem/src/contract/index";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

async function fixture() {
	const env = await createTestEnv();
	const config = pluginConfigSchema.parse({ mode: "local-first", ambientLearning: true, captureAssistant: true, observe: { enabled: false } });
	const store = new MemoryStore({ dbPath: env.dbPath, vectorDim: env.embedder.dimensions, embedder: env.embedder, memoryTelemetry: config.memoryTelemetry });
	const accessTracker = new AccessTracker({ store, recallLifecycle: config.recallLifecycle });
	const logger = createLogger("zebra:contract-parity");
	const services = { store, embedder: env.embedder, accessTracker, logger,
		retriever: new MemoryRetriever(store, env.embedder), stateDir: dirname(env.dbPath),
		observability: new PluginObservability(config, dirname(env.dbPath), logger) };
	cleanups.push(async () => { await accessTracker.destroy(); await store.close(); env.cleanup(); });
	const { mode, remEnhanced, agentNative, language, ...settings } = config;
	const registration: Registration = { skinId: "parity", settings, routing: { mode, remEnhanced, agentNative, language } };
	return { services, config, registration };
}
function rows(store: MemoryStore) {
	return store.sqlite.prepare("SELECT text, category, project_id, importance, timestamp, timezone, metadata, content_hash, lane FROM nodix_memories ORDER BY content_hash").all();
}

describe("capture contract preserves the existing hook path", () => {
	it("commits the same durable row bytes before returning, without widening the supplied project", async () => {
		const original = await fixture();
		const contract = await fixture();
		const scope = { principal: userInfo().username, project: "agent:parity", session: "agent:parity:release", host: { agentId: "parity", sessionKey: "agent:parity:release", sessionTimezone: "America/Los_Angeles" } };
		const turn: Turn = { turnId: "release-turn", rewindEpoch: 0, messages: [
			{ role: "user", content: "The release meeting is Friday at 10:00. Bring the copper folder.", at: Date.parse("2026-09-09T18:00:00Z") },
			{ role: "assistant", content: "I will bring the copper folder to the release meeting.", at: Date.parse("2026-09-09T18:00:01Z") },
		] };
		// The move-only check separately compares this retained hook to its frozen pre-move source.
		await onAgentEnd(original.services, original.config, original.services.store, original.services.embedder,
			new MemoryScopePolicy({ default: scope.project }), undefined,
			{ success: true, messages: turn.messages.map(({ at, ...message }) => ({ ...message, timestamp: at })) },
			{ agentId: "parity", sessionKey: scope.session, sessionTimezone: scope.host.sessionTimezone }, original.services.stateDir);
		const runtime = new MemoryContractRuntime(contract.services);
		await runtime.init(scope, contract.registration);
		expect(await runtime.capture(turn, scope)).toMatchObject({ degraded: false, committed: true });
		const before = rows(original.services.store), after = rows(contract.services.store);
		expect(before.length).toBeGreaterThan(0);
		expect(after).toEqual(before);
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
