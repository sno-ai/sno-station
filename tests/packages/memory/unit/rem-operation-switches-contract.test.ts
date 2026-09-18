import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const harnessPath = join(
	repoRoot,
	"evals/memora/evals/agent_eval/run_memora_mem_claw.sh",
);

type ProductExports = Record<string, unknown>;

async function productBoundary<T>(name: string): Promise<T> {
	const product = (await import("../../../../packages/sno-station-mem/src/engine/rem/index.ts")) as ProductExports;
	const candidate = product[name];
	expect(candidate, `missing production boundary ${name}`).toBeTypeOf("function");
	return candidate as T;
}

function completeConfiguration(): Record<string, unknown> {
	return {
		profileId: "sno-e2e",
		budgets: { maxPairs: 10 },
		retrieval: { neighborLimit: 10, similarityThreshold: 0.8 },
		coverage: { accuracyFloor: 1 },
		retries: { liveContentionRetries: 1 },
		modelRoute: "http://localhost:8070/codex/v1/chat/completions",
		facetPolicy: {
			aggregationGrammar: "current-first-v1",
			historyGrammar: "history-evidence-v1",
		},
		calibration: {
			minimumPublishableScoreEffect: 0.02,
			minimumTargetCount: 30,
			minimumTargetPercent: 0.8,
		},
		operations: {
			"rem-update": true,
			"rem-replace": true,
			"rem-distill": false,
			"rem-retire": false,
		},
		enableGateDigests: {
			"p5-production-config": "a".repeat(64),
			"p6-monthly-non-regression": "b".repeat(64),
			"p7-detector-gate-verdict": "c".repeat(64),
			"population-routing": "d".repeat(64),
			"rem-update": "e".repeat(64),
			"rem-replace": "f".repeat(64),
		},
	};
}

function cloneConfiguration(): Record<string, unknown> {
	return structuredClone(completeConfiguration());
}

function shellMasterSwitchProbe(value: string | undefined): ReturnType<typeof spawnSync> {
	const source = readFileSync(harnessPath, "utf8");
	const start = source.indexOf('if [ -z "$' + '{SNO_EDGE_REM+x}" ]; then');
	const endMarker = "export SNO_EDGE_REM";
	const end = source.indexOf(endMarker, start);
	expect(start, "master parser start is absent from the production harness").toBeGreaterThanOrEqual(0);
	expect(end, "master parser export is absent from the production harness").toBeGreaterThan(start);
	const parser = source.slice(start, end + endMarker.length);
	return spawnSync("bash", ["-c", `${parser}\nprintf 'value=%s\\n' "$SNO_EDGE_REM"`], {
		encoding: "utf8",
		env: {
			PATH: process.env["PATH"] ?? "",
			...(value === undefined ? {} : { SNO_EDGE_REM: value }),
		},
	});
}

describe("REM operation-switch data contracts", () => {
	it("refuses REM skip-store without an explicit source database", () => {
		const source = readFileSync(harnessPath, "utf8");
		expect(source).toContain(
			'if [ "$SNO_EDGE_REM" = "1" ] && $SKIP_STORE && [ -z "$REM_QCG11_SOURCE_STORE" ]; then',
		);
		expect(source).toContain('die "REM mode --skip-store requires REM_QCG11_SOURCE_STORE"');
	});

	it("rem-master-switch-parse accepts only 0 and 1 and reports the received value", () => {
		for (const value of ["0", "1"]) {
			const result = shellMasterSwitchProbe(value);
			expect(result.status).toBe(0);
			expect(result.stdout).toBe(`value=${value}\n`);
		}
		for (const value of ["2", ""]) {
			const result = shellMasterSwitchProbe(value);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("SNO_EDGE_REM");
			expect(result.stderr).toContain(value === "" ? "empty" : value);
		}
	});

	it("rem-master-switch-absent-defaults-off-contract records the default", () => {
		const result = shellMasterSwitchProbe(undefined);
		if (result.stdout !== "value=0\n") {
			throw new Error(`QCG26_ASSERT_MASTER_DEFAULT_OFF: ${result.stdout}`);
		}
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("value=0\n");
		expect(result.stderr).toMatch(/SNO_EDGE_REM.*default.*off/i);
	});

	it("rem-operational-config-no-enable-field rejects the retired master field", async () => {
		const parse = await productBoundary<(value: unknown) => Record<string, unknown>>(
			"parseRemOperationalConfiguration",
		);
		const valid = completeConfiguration();
		expect(parse(valid)).toEqual(valid);
		expect(() => parse({ ...valid, enabled: true })).toThrow(/enabled/i);
	});

	it("rem-operations-four-key-schema accepts all sixteen combinations and rejects bad keys", async () => {
		const parse = await productBoundary<(value: unknown) => Record<string, unknown>>(
			"parseRemOperationalConfiguration",
		);
		const names = ["rem-update", "rem-replace", "rem-distill", "rem-retire"] as const;
		for (let mask = 0; mask < 16; mask += 1) {
			const candidate = cloneConfiguration();
			candidate["operations"] = Object.fromEntries(
				names.map((name, index) => [name, (mask & (1 << index)) !== 0]),
			);
			expect(parse(candidate)["operations"]).toEqual(candidate["operations"]);
		}

		for (const [offendingKey, mutate] of [
			[
				"rem-retire",
				(value: Record<string, unknown>) =>
					delete (value["operations"] as Record<string, unknown>)["rem-retire"],
			],
			[
				"erase",
				(value: Record<string, unknown>) =>
					((value["operations"] as Record<string, unknown>)["erase"] = false),
			],
			[
				"rem-update",
				(value: Record<string, unknown>) =>
					((value["operations"] as Record<string, unknown>)["rem-update"] = "yes"),
			],
		] as const) {
			const candidate = cloneConfiguration();
			mutate(candidate);
			expect(() => parse(candidate), offendingKey).toThrow(new RegExp(offendingKey, "i"));
		}
	});

	it("rem-gate-digest-built-operations-only rejects unbuilt-operation digest entries", async () => {
		const parse = await productBoundary<(value: unknown) => Record<string, unknown>>(
			"parseRemOperationalConfiguration",
		);
		const valid = completeConfiguration();
		expect(parse(valid)).toEqual(valid);
		for (const name of ["rem-distill", "rem-retire"]) {
			const candidate = cloneConfiguration();
			(candidate["enableGateDigests"] as Record<string, unknown>)[name] = "0".repeat(64);
			expect(() => parse(candidate), name).toThrow(new RegExp(name, "i"));
		}
	});

	it("rem-identifier-artifact-drift regenerates exactly and names a changed consumer", () => {
		const verifier = join(repoRoot, "dev-scripts/tests/rem-operation-identifiers-drift.sh");
		const unchanged = spawnSync("bash", [verifier], {
			cwd: repoRoot,
			encoding: "utf8",
		});
		expect(unchanged.status, unchanged.stderr).toBe(0);

		const scratch = mkdtempSync(join(tmpdir(), "rem-operation-drift-"));
		try {
			const consumer = join(scratch, "consumer.sh");
			writeFileSync(consumer, 'MEM_CLAW_REM_TYPES="rem-updated-by-hand,rem-replace"\n');
			const changed = spawnSync("bash", [verifier], {
				cwd: repoRoot,
				encoding: "utf8",
				env: {
					...process.env,
					REM_OPERATION_DRIFT_MUTATION_FILE: consumer,
					REM_OPERATION_DRIFT_MUTATION_FROM: "rem-update",
					REM_OPERATION_DRIFT_MUTATION_TO: "rem-updated-by-hand",
				},
			});
			expect(changed.status).not.toBe(0);
			expect(`${changed.stdout}\n${changed.stderr}`).toContain(consumer);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
