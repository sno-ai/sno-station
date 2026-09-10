import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../../..");

function source(relative: string): string {
	return readFileSync(resolve(repoRoot, relative), "utf8");
}

function expectInOrder(text: string, earlier: string, later: string): void {
	const earlierIndex = text.indexOf(earlier);
	const laterIndex = text.indexOf(later);
	expect(earlierIndex, `missing production edge: ${earlier}`).toBeGreaterThanOrEqual(0);
	expect(laterIndex, `missing production edge: ${later}`).toBeGreaterThan(earlierIndex);
}

function requireQcg26(condition: boolean, marker: string, detail: string): void {
	if (!condition) throw new Error(`${marker}: ${detail}`);
}

describe("REM operation switches through production entry", () => {
	it("rem-operation-identifiers-production-entry exposes exactly the four current operations", async () => {
		const product = await import("../../../../packages/rem-core/src/index.ts");
		const retired = JSON.parse(
			readFileSync(
				resolve(repoRoot, "tests/apps/mem-claw/fixtures/rem-retired-vocabulary.negative.json"),
				"utf8",
			),
		) as { operations: string[] };
		requireQcg26(
			JSON.stringify(product.REM_OPERATION_TYPES) ===
				JSON.stringify(["rem-update", "rem-replace", "rem-distill", "rem-retire"]),
			"QCG26_ASSERT_QCG1_OPERATION_DISPATCH",
			`operations=${JSON.stringify(product.REM_OPERATION_TYPES)}`,
		);
		expect(product.REM_OPERATION_TYPES).toEqual([
			"rem-update",
			"rem-replace",
			"rem-distill",
			"rem-retire",
		]);
		expect(product.parseRemOperationType("rem-update")).toBe("rem-update");
		expect(product.parseRemOperationType("rem-replace")).toBe("rem-replace");
		expect(product.parseRemOperationType("rem-distill")).toBe("rem-distill");
		expect(product.parseRemOperationType("rem-retire")).toBe("rem-retire");
		for (const operation of retired.operations) {
			expect(product.parseRemOperationType(operation), operation).toBeUndefined();
		}
	});

	it("rem-master-switch-no-alias reaches the persona lifecycle branch", () => {
		const runner = source("evals/memora/evals/agent_eval/run_memora_mem_claw.sh");
		requireQcg26(
			runner.includes('if [ "$SNO_EDGE_REM" = "1" ] && ! $PERSONA_FAILED; then'),
			"QCG26_ASSERT_QCG3_MASTER_LIFECYCLE",
			"master switch no longer guards the persona REM lifecycle",
		);
	});

	it("rem-operation-switch-refuses-before-scan reads execution configuration first", () => {
		const server = source("apps/mem-claw/src/sidecar/server.ts");
		expectInOrder(server, "readRemOperationalConfig()", "runRemProductionOrderedWave({");
		expectInOrder(server, "switched-off", "runRemProductionOrderedWave({");
	});

	it("rem-unbuilt-operation-distinct-reason distinguishes switched-off from not-built", () => {
		const server = source("apps/mem-claw/src/sidecar/server.ts");
		expect(server).toContain("switched-off");
		expect(server).toContain("not-built");
		expect(server.indexOf("switched-off")).not.toBe(server.indexOf("not-built"));
	});

	it("rem-enable-gate-called-in-production wires the selected operation gate before the batch", () => {
		const server = source("apps/mem-claw/src/sidecar/server.ts");
		const gateIndex = server.indexOf("loadRemEnableGate(");
		const batchIndex = server.indexOf("runRemProductionOrderedWave({");
		requireQcg26(
			gateIndex >= 0 && batchIndex > gateIndex,
			"QCG26_ASSERT_QCG10_ENABLE_GATE_CALL",
			`enable gate index=${gateIndex}, batch index=${batchIndex}`,
		);
		expect(server).toContain("artifactSha256");
	});

	it("rem-low-yield-ends-done keeps persona judging after zero applied operations", () => {
		const executor = source("apps/mem-claw/src/sidecar/rem-batch-executor.ts");
		const runner = source("evals/memora/evals/agent_eval/run_memora_mem_claw.sh");
		expect(executor).not.toMatch(/terminalState:\s*[^\n]*"degraded"/u);
		requireQcg26(
			runner.includes('echo "FAIL: REM wave submission failed for $PERSONA"\n                    PERSONA_FAILED=true'),
			"QCG26_ASSERT_QCG12_PERSONA_ROUTING",
			"REM completion status is not consumed by persona routing",
		);
	});

	it("rem-switch-off-writes-nothing retains the ordinary persona-store lifecycle edge", () => {
		const runner = source("evals/memora/evals/agent_eval/run_memora_mem_claw.sh");
		requireQcg26(
			runner.includes('start_rem_lifecycle "$PERSONA_REM_DATABASE"'),
			"QCG26_ASSERT_QCG11_PERSONA_STORE_EDGE",
			"ordinary Memora no longer launches REM against its persona database",
		);
	});

	it("rem-job-stats-five-fields publishes quality without a zero-actionable perfect score", () => {
		const jobStore = source("apps/mem-claw/src/sidecar/rem-job-store.ts");
		for (const field of [
			"applied_count",
			"actionable_candidate_count",
			"applied_fraction",
			"parse_failure_count",
			"top_refusal_reasons",
		]) {
			expect(jobStore, field).toContain(field);
		}
		const executor = source("apps/mem-claw/src/sidecar/rem-batch-executor.ts");
		expect(executor).toMatch(/actionableCandidateCount\s*===\s*0\s*\?\s*null/u);
	});

	it("rem-all-call-outage-still-fails preserves the real failure gate", () => {
		const executor = source("apps/mem-claw/src/sidecar/rem-batch-executor.ts");
		requireQcg26(
			executor.split("if (llmCalls > 0 && successfulLlmCalls === 0)").length - 1 === 2 &&
				executor.split("throw new Error(").filter((block) => block.includes("REM LLM calls all failed:")).length >= 2,
			"QCG26_ASSERT_QCG14_ALL_CALL_OUTAGE",
			"one built operation lost its all-call-outage failure",
		);
		const server = source("apps/mem-claw/src/sidecar/server.ts");
		expect(server).toContain('state: "failed"');
	});

	it("rem-operation-switch-single-source has no environment flag or request override", () => {
		const server = source("apps/mem-claw/src/sidecar/server.ts");
		requireQcg26(
			!server.match(/SNO_EDGE_REM_(UPDATE|REPLACE|DISTILL|RETIRE)/u),
			"QCG26_ASSERT_QCG16_SINGLE_SOURCE",
			"an environment operation override reached the execution snapshot",
		);
		expect(server).not.toMatch(/input\.(operations|operationEnabled|enabled)/u);
		expect(server).toContain("readRemOperationalConfig()");
	});

	it("rem-invalid-model-response refuses without a write mark", () => {
		const adapter = source("apps/mem-claw/src/storage/rem-sqlite-adapter.ts");
		expect(adapter).not.toContain('return "degraded"');
		expect(adapter).toContain('reasonCode: "model_response_invalid"');
		const jobStore = source("apps/mem-claw/src/sidecar/rem-job-store.ts");
		expect(jobStore).not.toMatch(/RemJobState[^\n]*degraded/u);
	});

	it("rem-per-operation-gate-digest binds the configured digest to the production gate", () => {
		const server = source("apps/mem-claw/src/sidecar/server.ts");
		requireQcg26(
			server.includes("artifactSha256: configuration.enableGateDigests[operation],"),
			"QCG26_ASSERT_QCG18_DIGEST_BINDING",
			"configured operation digest is not passed to the production gate",
		);
		expectInOrder(server, "loadRemEnableGate(", "runRemProductionOrderedWave({");
	});

	it("rem-refusal-record-not-in-persona-store records only in sidecar journals", () => {
		const server = source("apps/mem-claw/src/sidecar/server.ts");
		requireQcg26(
			server.includes('await appendChassisRefusal(journal, running, operation, "refused", reason);'),
			"QCG26_ASSERT_QCG19_REFUSAL_JOURNAL",
			"clean refusals no longer publish to the chassis journal",
		);
		expect(server).toContain("rem-chassis-journal");
		expect(server).toContain("switched-off");
		expectInOrder(server, "switched-off", "runRemProductionOrderedWave({");
	});

	it("rem-switch-read-at-execution-time does not retain startup or enqueue configuration", () => {
		const server = source("apps/mem-claw/src/sidecar/server.ts");
		const execution = server.indexOf("async function runChassisJob");
		const read = server.indexOf("readRemOperationalConfig()", execution);
		expect(read, "execution-time configuration read is absent").toBeGreaterThan(execution);
		expectInOrder(server.slice(execution), "readRemOperationalConfig()", "runRemProductionOrderedWave({");
	});

	it("rem-wrapper-exports-master-switch always supplies an explicit effective value", () => {
		const wrapper = source("dev-scripts/run-memora.sh");
		requireQcg26(
			wrapper.includes("export SNO_EDGE_REM"),
			"QCG26_ASSERT_QCG21_WRAPPER_EXPORT",
			"sanctioned wrapper no longer exports the effective master switch",
		);
		expect(wrapper).toContain("SNO_EDGE_REM");
		expect(wrapper).toMatch(/export SNO_EDGE_REM/u);
		expect(wrapper).toMatch(/SNO_EDGE_REM[^\n]*1/u);
	});

	it("rem-erase-has-no-operation-path keeps erase outside the dispatcher and deletion path", async () => {
		const product = await import("../../../../packages/rem-core/src/index.ts");
		requireQcg26(
			product.parseRemOperationType("erase") === undefined,
			"QCG26_ASSERT_QCG24_ERASE_DISPATCH",
			"erase entered the REM operation dispatcher",
		);
		expect(product.parseRemOperationType("erase")).toBeUndefined();
		const server = source("apps/mem-claw/src/sidecar/server.ts");
		expect(server).not.toMatch(/case\s+["']erase["']/u);
		expect(server).not.toMatch(/erase|deleteMemory|DELETE FROM nodix_memories/u);
	});

	it("rem-switch-independence keeps each request on its own operation key", () => {
		const server = source("apps/mem-claw/src/sidecar/server.ts");
		requireQcg26(
			server.includes("!configuration.operations[operation]") &&
				!server.includes('jobType === "rem-update" ? "rem-replace"'),
			"QCG26_ASSERT_QCG25_INDEPENDENT_SWITCH",
			"operation switch lookup is coupled to a sibling operation",
		);
	});

	it("rem-terminal-state-matrix publishes the completed job state", () => {
		const server = source("apps/mem-claw/src/sidecar/server.ts");
		requireQcg26(
			server.includes('state: "done",\n\t\t\tfinished_at: new Date().toISOString(),\n\t\t\tstats: completionStats,'),
			"QCG26_ASSERT_QCG29_TERMINAL_PUBLICATION",
			"completed job result is not published as done with its statistics",
		);
	});
});
