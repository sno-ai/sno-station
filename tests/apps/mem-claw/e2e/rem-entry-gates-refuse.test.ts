/** Frozen independent pre-open acceptance for OpenSpec task 2.3. */

import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRemOwnerNullOperationalConfiguration } from "../helpers/rem-entry-config-fixture.ts";
import { createTestDb } from "../helpers/test-db.ts";

type Decision = { decision: "allow" | "refuse"; reasonCode: string | null; outcome?: string };
type ProductExports = Record<string, unknown>;

async function sidecarBoundary<T>(name: string): Promise<T> {
	const product = (await import("../../../../packages/memory/src/sidecar/rem-batch-executor.ts")) as ProductExports;
	const candidate = product[name];
	expect(candidate, `missing production entry boundary ${name}`).toBeTypeOf("function");
	return candidate as T;
}

async function withStateRoot(run: (stateRoot: string) => Promise<void>): Promise<void> {
	const stateRoot = mkdtempSync(join(tmpdir(), "rem-entry-gates-"));
	try {
		await run(stateRoot);
	} finally {
		rmSync(stateRoot, { recursive: true, force: true });
	}
}

function sha256(bytes: string | Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value !== "object") throw new Error("unsupported canonical JSON value");
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function prepareGateFiles(stateRoot: string, condition: string, profileId = "sno-e2e"): string {
	const gateRoot = join(stateRoot, "sno-station-mem/rem-gates");
	mkdirSync(gateRoot, { recursive: true });
	const operationalConfiguration = {
		...createRemOwnerNullOperationalConfiguration(),
		profileId,
	};
	const { enableGateDigests: _excludedArtifactDigests, ...identityConfiguration } =
		operationalConfiguration;
	const configurationSha256 = sha256(canonicalJson(identityConfiguration));
	const common = {
		schemaVersion: 1,
		profileId,
		configurationSha256,
		createdAt: "2026-08-08T08:00:00Z",
	};
	const immutableProfile = `${JSON.stringify({ ...common, artifactId: "p5-immutable-profile", resolvedParameters: { reasoningEffort: "medium" } })}\n`;
	const artifacts: Record<string, Record<string, unknown>> = {
		"p5-production-config": {
			...common,
			artifactId: "p5-production-config",
			result: condition === "p5-semantic-fail" ? "fail" : "pass",
			servedModel: "gpt-5.6-terra",
			resolvedParameters: { reasoningEffort: "medium" },
			readbackSource: "immutable-profile",
			immutableProfileSha256: sha256(immutableProfile),
		},
		"p6-monthly-non-regression": {
			...common,
			artifactId: "p6-monthly-non-regression",
			period: "2026-08",
			minima: { accuracy: 1 },
			measured: { accuracy: 1 },
			result: "pass",
		},
		"p7-detector-gate-verdict": {
			...common,
			artifactId: "p7-detector-gate-verdict",
			kind: "measured-pass",
			minima: { accuracy: 1 },
			measured: { accuracy: 1 },
			result: "pass",
			...(condition === "p7-scope-mismatch" ? { profileId: "SNO-E2E" } : {}),
		},
		"population-routing": {
			...common,
			artifactId: "population-routing",
			producedAtHead: "a".repeat(40),
			classifierSha256: "b".repeat(64),
			fixtureSetSha256: "c".repeat(64),
			derivationCommand: "npm run rem:derive-routing",
			invocationId: "entry-fixture",
			observations: [
				["value-swap", "transition-narrative", "ACCEPTED"],
				["negated-current", "transition-narrative", "ACCEPTED"],
				["list-prune", "transition-narrative", "ACCEPTED"],
				["required-refuse-rider", "transition-narrative", "ACCEPTED"],
				["pure-negation", "no-owner", "ACCEPTED"],
				["mutant-1", "n/a", "REJECTED"],
				["mutant-2", "n/a", "REJECTED"],
				["mutant-3", "n/a", "REJECTED"],
			].map(([fixtureId, observedRoute, observedVerdict]) => ({
				fixtureId,
				inputSha256: sha256(fixtureId ?? ""),
				observedRoute,
				observedVerdict,
			})),
		},
	};
	writeFileSync(join(gateRoot, "p5-immutable-profile.json"), immutableProfile, { mode: 0o600 });
	const digests: Record<string, string> = { "p5-immutable-profile": sha256(immutableProfile) };
	for (const [artifactId, artifact] of Object.entries(artifacts)) {
		const bytes = `${JSON.stringify(artifact)}\n`;
		writeFileSync(join(gateRoot, `${artifactId}.json`), bytes, { mode: 0o600 });
		digests[artifactId] = sha256(bytes);
	}
	if (condition === "p5-missing") unlinkSync(join(gateRoot, "p5-production-config.json"));
	if (condition === "p6-digest-mismatch") digests["p6-monthly-non-regression"] = "0".repeat(64);
	if (condition === "p7-symlink") {
		const p7Path = join(gateRoot, "p7-detector-gate-verdict.json");
		unlinkSync(p7Path);
		symlinkSync(join(gateRoot, "p5-production-config.json"), p7Path);
	}
	for (const artifactId of [...Object.keys(artifacts), "p5-immutable-profile"]) {
		const path = join(gateRoot, `${artifactId}.json`);
		if (condition !== "p5-missing" || artifactId !== "p5-production-config") {
			if (condition !== "p7-symlink" || artifactId !== "p7-detector-gate-verdict") chmodSync(path, 0o600);
		}
	}
	// Merge rather than replace: the digest map is strict and also carries the
	// per-operation gate digests, which this fixture does not write as files.
	return JSON.stringify({
		...operationalConfiguration,
		enableGateDigests: {
			...(operationalConfiguration["enableGateDigests"] as Record<string, string>),
			...digests,
		},
	});
}

function rewriteArtifactWithMatchingDigest(
	configSource: string,
	path: string,
	artifactId: string,
	artifact: unknown,
): string {
	const bytes = `${JSON.stringify(artifact)}\n`;
	writeFileSync(path, bytes, { mode: 0o600 });
	const config = JSON.parse(configSource) as Record<string, unknown> & {
		enableGateDigests: Record<string, string>;
	};
	config.enableGateDigests[artifactId] = sha256(bytes);
	return JSON.stringify(config);
}

describe("REM artifact preconditions", () => {
	it.each([
		{ condition: "p5-missing", expected: "artifact_missing", allow: false },
		{ condition: "p6-digest-mismatch", expected: "artifact_digest_mismatch", allow: false },
		{ condition: "p7-symlink", expected: "artifact_not_regular", allow: false },
		{ condition: "p7-scope-mismatch", expected: "artifact_scope_mismatch", allow: false },
		{ condition: "p5-semantic-fail", expected: "artifact_semantic_fail", allow: false },
		{ condition: "all-valid", expected: null, allow: true },
	] as const)("validates real gate files for $condition", async ({ condition, expected, allow }) => {
		await withStateRoot(async (stateRoot) => {
			const configSource = prepareGateFiles(stateRoot, condition);
			const validate = await sidecarBoundary<(input: { stateRoot: string; configSource: string }) => Promise<Decision>>(
				"validateRemEntryArtifacts",
			);
			const result = await validate({ stateRoot, configSource });
			expect(result).toEqual({ decision: allow ? "allow" : "refuse", reasonCode: expected });
		});
	});
});

describe("REM enable configuration", () => {
	it.each([
		{ value: undefined, expected: "enable_config_absent", allow: false },
		{ value: "", expected: "enable_config_blank", allow: false },
		{ value: "{", expected: "enable_config_malformed", allow: false },
		// `enabled` was retired by the operation-switch contract; a configuration
		// still carrying it is refused rather than read as a disabled state.
		{ value: JSON.stringify({ enabled: false }), expected: "enable_config_malformed", allow: false },
		{ value: "valid", expected: null, allow: true },
	] as const)("parses the $expected configuration state", async ({ value, expected, allow }) => {
		await withStateRoot(async (stateRoot) => {
			const valid = prepareGateFiles(stateRoot, "all-valid");
			const parse = await sidecarBoundary<(value: string | undefined) => Decision>(
				"parseRemEnableConfiguration",
			);
			const result = parse(value === "valid" ? valid : value);
			expect(result.decision).toBe(allow ? "allow" : "refuse");
			expect(result.reasonCode).toBe(expected);
		});
	});
});

describe("REM pre-read ordering", () => {
	it("refuses before opening an unusable persona-store sentinel", async () => {
		await withStateRoot(async (stateRoot) => {
			const personaDbPath = join(stateRoot, "unusable-persona.sqlite");
			const before = randomBytes(64);
			writeFileSync(personaDbPath, before, { mode: 0o000 });
			const run = await sidecarBoundary<(input: Record<string, unknown>) => Promise<Decision>>(
				"runRemEntryPreflight",
			);
			const result = await run({
				stateRoot,
				personaDbPath,
				configSource: prepareGateFiles(stateRoot, "p5-missing"),
			});
			expect(result.reasonCode).toBe("artifact_missing");
			chmodSync(personaDbPath, 0o600);
			expect(readFileSync(personaDbPath)).toEqual(before);
		});
	});

	it("reaches a real encrypted store only after valid entry gates", async () => {
		await withStateRoot(async (stateRoot) => {
			const fixture = createTestDb();
			try {
				const run = await sidecarBoundary<(input: Record<string, unknown>) => Promise<Decision>>(
					"runRemEntryPreflight",
				);
				const result = await run({
					stateRoot,
					personaDbPath: fixture.dbPath,
					configSource: prepareGateFiles(stateRoot, "all-valid"),
				});
				expect(result.decision).toBe("allow");
				expect(result.outcome).toBe("no-action");
			} finally {
				fixture.cleanup();
			}
		});
	});
});

describe("REM population routing", () => {
	it.each([
		{ artifactId: "p6-monthly-non-regression", boundary: "validateRemEntryArtifacts" },
		{ artifactId: "population-routing", boundary: "assembleRemPopulation" },
	] as const)("allows a strict $artifactId owner waiver for sno-e2e", async ({ artifactId, boundary }) => {
		await withStateRoot(async (stateRoot) => {
			const fixture = createTestDb();
			try {
				let configSource = prepareGateFiles(stateRoot, "all-valid");
				const artifactPath = join(stateRoot, `sno-station-mem/rem-gates/${artifactId}.json`);
				const currentArtifact = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
				configSource = rewriteArtifactWithMatchingDigest(configSource, artifactPath, artifactId, {
					schemaVersion: currentArtifact.schemaVersion,
					artifactId,
					profileId: currentArtifact.profileId,
					configurationSha256: currentArtifact.configurationSha256,
					createdAt: currentArtifact.createdAt,
					kind: "owner-waiver",
					result: "pass",
					waivedBy: "owner",
					waiverReason: "No measured artifact exists and no repository producer can create it.",
				});
				const invoke = await sidecarBoundary<(input: Record<string, unknown>) => Promise<Decision>>(boundary);
				const result = await invoke({ stateRoot, personaDbPath: fixture.dbPath, configSource });
				expect(result).toEqual({ decision: "allow", reasonCode: null });
			} finally {
				fixture.cleanup();
			}
		});
	});

	it.each([
		{ artifactId: "p6-monthly-non-regression", expectedReason: "artifact_schema", extraField: false },
		{ artifactId: "population-routing", expectedReason: "artifact_semantic_fail", extraField: false },
		{ artifactId: "p6-monthly-non-regression", expectedReason: "artifact_schema", extraField: true },
		{ artifactId: "population-routing", expectedReason: "artifact_semantic_fail", extraField: true },
	] as const)(
		"refuses an out-of-scope or non-strict $artifactId owner waiver",
		async ({ artifactId, expectedReason, extraField }) => {
			await withStateRoot(async (stateRoot) => {
				const profileId = extraField ? "sno-e2e" : "production";
				let configSource = prepareGateFiles(stateRoot, "all-valid", profileId);
				const artifactPath = join(stateRoot, `sno-station-mem/rem-gates/${artifactId}.json`);
				const currentArtifact = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
				configSource = rewriteArtifactWithMatchingDigest(configSource, artifactPath, artifactId, {
					schemaVersion: currentArtifact.schemaVersion,
					artifactId,
					profileId,
					configurationSha256: currentArtifact.configurationSha256,
					createdAt: currentArtifact.createdAt,
					kind: "owner-waiver",
					result: "pass",
					waivedBy: "owner",
					waiverReason: "No measured artifact exists and no repository producer can create it.",
					...(extraField ? { legacyDecision: true } : {}),
				});
				const validate = await sidecarBoundary<
					(input: { stateRoot: string; configSource: string }) => Promise<Decision>
				>("validateRemEntryArtifacts");
				const result = await validate({ stateRoot, configSource });
				expect(result).toEqual({ decision: "refuse", reasonCode: expectedReason });
			});
		},
	);

	it("names a real stale routing artifact as the blocking obligation", async () => {
		await withStateRoot(async (stateRoot) => {
			const fixture = createTestDb();
			try {
				let configSource = prepareGateFiles(stateRoot, "all-valid");
				const routingPath = join(stateRoot, "sno-station-mem/rem-gates/population-routing.json");
				configSource = rewriteArtifactWithMatchingDigest(
					configSource,
					routingPath,
					"population-routing",
					{ artifactId: "population-routing", observations: [] },
				);
				const assemble = await sidecarBoundary<(input: Record<string, unknown>) => Promise<Decision>>(
					"assembleRemPopulation",
				);
				const result = await assemble({ stateRoot, personaDbPath: fixture.dbPath, configSource });
				expect(result).toEqual({ decision: "refuse", reasonCode: "RO-2" });
			} finally {
				fixture.cleanup();
			}
		});
	});

	it("allows population assembly only from all five production-derived obligations", async () => {
		await withStateRoot(async (stateRoot) => {
			const fixture = createTestDb();
			try {
				const assemble = await sidecarBoundary<(input: Record<string, unknown>) => Promise<Decision>>(
					"assembleRemPopulation",
				);
				const result = await assemble({
					stateRoot,
					personaDbPath: fixture.dbPath,
					configSource: prepareGateFiles(stateRoot, "all-valid"),
				});
				expect(result.decision).toBe("allow");
			} finally {
				fixture.cleanup();
			}
		});
	});
});
