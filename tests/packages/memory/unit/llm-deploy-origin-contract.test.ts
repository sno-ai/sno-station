import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

function readShellFunction(source: string, name: string): string {
	const body = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$`, "m").exec(source)?.[0];
	if (!body) throw new Error(`shell function is missing: ${name}`);
	return body;
}

describe("LLM deployment origin contract", () => {
	it("binds REM stage verification to the owning sno CLI without an OpenClaw fallback", () => {
		const source = readFileSync(DEPLOY_SCRIPT, "utf8");
		const ensure = readShellFunction(source, "ensure_remote_sno_cli");
		const install = readShellFunction(source, "install_committed_sno_cli");
		const probe = readShellFunction(source, "probe_remote_sno_cli");
		const verify = readShellFunction(source, "verify_rem_stage");

		expect(source).toContain('shared_sno_cli="/home/user/.cargo/bin/sno"');
		expect(source).toContain('profile_sno_cli="$OPENCLAW_STATE_DIR/bin/sno"');
		expect(probe).toContain("'$remote_sno_cli' --version");
		expect(probe).toContain("'$remote_sno_cli' station --help");
		expect(probe).toContain("rem-start");
		expect(probe).toContain("rem-status");
		expect(probe).toContain("REFUSE:");
		expect(ensure).toMatch(
			/probe_remote_sno_cli[\s\S]*remote_sno_cli="\$profile_sno_cli"[\s\S]*probe_remote_sno_cli[\s\S]*install_committed_sno_cli/,
		);
		expect(install).toContain('git -C "$SNO_CLI_ROOT" status --porcelain');
		expect(install).toContain('cargo build --release --locked --manifest-path "$SNO_CLI_ROOT/Cargo.toml"');
		expect(install).toContain('[[ "$remote_sha256" != "$local_sha256" ]]');
		expect(install).toContain("mv -f -- '$remote_stage' '$profile_sno_cli'");
		expect(install).not.toContain("mv -f -- '$remote_stage' '$shared_sno_cli'");
		expect(verify).toContain("sno_remote station rem-start");
		expect(verify).toContain("sno_remote station rem-status");
		expect(verify).not.toContain("oc_cli");
	});

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
