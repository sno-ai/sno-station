import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";


const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const SYNC_SCRIPT = resolve(REPO_ROOT, "dev-scripts/sync-plugin-to-vm.sh");
const DEPLOY_SCRIPT = resolve(REPO_ROOT, "evals/sno-memory-bench/deploy-mem-claw.sh");
const ORIGIN_CHECKER = resolve(REPO_ROOT, "dev-scripts/check-llm-deploy-origin.sh");

function checkOrigin(script: string, origin?: string): ReturnType<typeof spawnSync> {
	return spawnSync("bash", [script, "--check-llm-origin"], {
		encoding: "utf8",
		env: {
			...process.env,
			...(origin ? { REM_ENHANCED_GPU_BASE_URL: origin } : {}),
		},
	});
}

describe("LLM deployment origin contract", () => {
	it.each([
		"https://rt3-llm.sno.ai:99999",
		"https://rt3-llm.sno.ai:notaport",
		"https://rt3-llm.sno.ai?route=extract",
		"https://user:password@rt3-llm.sno.ai",
		"https://rt3-llm.sno.ai/extract/v1",
	])("shared checker rejects invalid origin %s", (origin) => {
		const result = spawnSync("bash", [ORIGIN_CHECKER, origin], { encoding: "utf8" });

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("valid HTTPS origin");
	});

	for (const [label, script] of [
		["sync", SYNC_SCRIPT],
		["evaluation deploy", DEPLOY_SCRIPT],
	] as const) {
		it(`${label} defaults to a path-free Sno GPU origin`, () => {
			const result = checkOrigin(script);

			expect(result.status, String(result.stderr)).toBe(0);
			expect(result.stdout).toContain("https://rt3-llm.sno.ai");
			expect(result.stdout).not.toContain("/extract/v1/extract/v1");
		});

		it(`${label} rejects a base that already contains the signed route prefix`, () => {
			const result = checkOrigin(script, "https://rt3-llm.sno.ai/extract/v1");

			expect(result.status).toBe(1);
			expect(result.stderr).toContain("valid HTTPS origin");
		});
	}

	it("full evaluation deployment rejects a path-bearing origin before preflight", () => {
		const result = spawnSync("bash", [DEPLOY_SCRIPT, "--skip-build", "--skip-smoke"], {
			encoding: "utf8",
			env: {
				...process.env,
				REM_ENHANCED_GPU_BASE_URL: "https://rt3-llm.sno.ai/extract/v1",
			},
		});

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("valid HTTPS origin");
		expect(result.stdout).not.toContain("preflight");
	});
});
