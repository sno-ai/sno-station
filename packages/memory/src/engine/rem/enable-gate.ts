import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
	REM_BUILT_OPERATION_TYPES,
	type RemBuiltOperationType,
	type RemEnableGateArtifact,
} from "./types.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const artifactSchema: z.ZodType<RemEnableGateArtifact> = z
	.object({
		schema_version: z.number().int(),
		job_type: z.enum(REM_BUILT_OPERATION_TYPES),
		implementation_version: z.string().min(1),
		corpus_sha256: z.string().regex(SHA256_PATTERN),
		baseline_sha256: z.string().regex(SHA256_PATTERN),
		result: z.enum(["pass", "fail"]),
		evaluated_at: z.string().datetime(),
		expires_at: z.string().datetime(),
	})
	.strict();

export class RemEnableGateError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = "RemEnableGateError";
	}
}

export interface LoadRemEnableGateInput {
	stateDir: string;
	jobType: RemBuiltOperationType;
	implementationVersion: string;
	corpusSha256: string;
	baselineSha256: string;
	artifactSha256: string;
	now: string;
}

export const REM_ENABLE_GATE_BINDINGS = {
	// The operational schema owns artifact digests; these are the frozen wave's identity bindings.
	implementationVersion: "edge-rem-wave-20260806",
	corpusSha256: "67d1acbe4451cccc0199a9b670b2b8df17b79ba7c3d6d431b4e0e303d73869e2",
	baselineSha256: "87413c08883fddc81d479fe6dcb9d7a537ee156d2fb73716ab0603860caa64c1",
} as const;

export function loadRemEnableGate(input: LoadRemEnableGateInput): RemEnableGateArtifact {
	const artifactPath = path.join(input.stateDir, "rem-gates", `${input.jobType}.json`);
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(artifactPath);
	} catch {
		throw new RemEnableGateError("artifact_missing");
	}
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new RemEnableGateError("artifact_not_regular");
	}
	if ((stat.mode & 0o022) !== 0) {
		throw new RemEnableGateError("artifact_permissions");
	}
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		throw new RemEnableGateError("artifact_owner");
	}
	const bytes = readFileSync(artifactPath);
	const digest = createHash("sha256").update(bytes).digest("hex");
	if (digest !== input.artifactSha256) {
		throw new RemEnableGateError("artifact_digest_mismatch");
	}
	const artifact = parseArtifact(bytes);
	assertArtifactBindings(artifact, input);
	return artifact;
}

function parseArtifact(bytes: Buffer): RemEnableGateArtifact {
	let decoded: unknown;
	try {
		decoded = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new RemEnableGateError("artifact_schema");
	}
	const parsed = artifactSchema.safeParse(decoded);
	if (!parsed.success) throw new RemEnableGateError("artifact_schema");
	return parsed.data;
}

function assertArtifactBindings(
	artifact: RemEnableGateArtifact,
	input: LoadRemEnableGateInput,
): void {
	if (artifact.schema_version !== 1) {
		throw new RemEnableGateError("schema_version_mismatch");
	}
	if (artifact.job_type !== input.jobType) throw new RemEnableGateError("job_type_mismatch");
	if (artifact.implementation_version !== input.implementationVersion) {
		throw new RemEnableGateError("implementation_version_mismatch");
	}
	if (artifact.corpus_sha256 !== input.corpusSha256) {
		throw new RemEnableGateError("corpus_mismatch");
	}
	if (artifact.baseline_sha256 !== input.baselineSha256) {
		throw new RemEnableGateError("baseline_mismatch");
	}
	if (artifact.result !== "pass") throw new RemEnableGateError("result_not_pass");
	const now = Date.parse(input.now);
	const evaluatedAt = Date.parse(artifact.evaluated_at);
	const expiresAt = Date.parse(artifact.expires_at);
	if (!Number.isFinite(now) || evaluatedAt > now) {
		throw new RemEnableGateError("artifact_not_yet_valid");
	}
	if (expiresAt <= now) throw new RemEnableGateError("artifact_expired");
}
