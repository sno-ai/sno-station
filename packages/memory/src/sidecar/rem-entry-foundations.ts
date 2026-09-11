import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
	defineRemSafetyGuard,
	deriveRemConfigurationSha256,
	parseRemOperationalConfiguration,
	requireRemOwnerDecisions,
	validateRemGrammarChange,
	validateRemEnableGateDigestKeys,
	type RemDatabaseLike,
	type RemOperationalConfiguration,
} from "../engine/rem/index.js";
import { openSqliteDatabaseReadonly } from "../store/sqlite-runtime";

type EntryDecision =
	| { decision: "allow"; reasonCode: null; outcome?: "no-action" }
	| { decision: "refuse"; reasonCode: string };

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const finiteRecordSchema = z
	.record(z.string(), z.number().finite())
	.refine((value) => Object.keys(value).length > 0);
const commonArtifactShape = {
	schemaVersion: z.literal(1),
	artifactId: z.string().min(1),
	profileId: z.string().min(1),
	configurationSha256: sha256Schema,
	createdAt: z.string().datetime(),
};
const p5Schema = z
	.object({
		...commonArtifactShape,
		artifactId: z.literal("p5-production-config"),
		result: z.enum(["pass", "fail"]),
		servedModel: z.string().min(1),
		resolvedParameters: z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length > 0),
		readbackSource: z.enum(["wrapper", "immutable-profile"]),
		immutableProfileSha256: sha256Schema.nullable(),
		wrapperInvocationId: z.string().min(1).optional(),
		wrapperReadbackSha256: sha256Schema.optional(),
	})
	.strict();
const p6Schema = z.object({
	...commonArtifactShape,
	artifactId: z.literal("p6-monthly-non-regression"),
	period: z.string().regex(/^\d{4}-\d{2}$/u),
	minima: finiteRecordSchema,
	measured: finiteRecordSchema,
	result: z.enum(["pass", "fail"]),
}).strict();
const p6WaiverSchema = z.object({
	...commonArtifactShape,
	artifactId: z.literal("p6-monthly-non-regression"),
	kind: z.literal("owner-waiver"),
	result: z.literal("pass"),
	waivedBy: z.string().min(1),
	waiverReason: z.string().min(1),
}).strict();
const p7MeasuredSchema = z.object({
	...commonArtifactShape,
	artifactId: z.literal("p7-detector-gate-verdict"),
	kind: z.literal("measured-pass"),
	minima: finiteRecordSchema,
	measured: finiteRecordSchema,
	result: z.enum(["pass", "fail"]),
}).strict();
const p7WaiverSchema = z.object({
	...commonArtifactShape,
	artifactId: z.literal("p7-detector-gate-verdict"),
	kind: z.literal("owner-waiver"),
	result: z.literal("pass"),
	waivedBy: z.string().min(1),
	waiverReason: z.string().min(1),
}).strict();
const routingSchema = z.object({
	...commonArtifactShape,
	artifactId: z.literal("population-routing"),
	producedAtHead: z.string().regex(/^[0-9a-f]{40}$/u),
	classifierSha256: sha256Schema,
	fixtureSetSha256: sha256Schema,
	derivationCommand: z.string().min(1),
	invocationId: z.string().min(1),
	observations: z.array(z.object({
		fixtureId: z.string().min(1),
		inputSha256: sha256Schema,
		observedRoute: z.string().min(1),
		observedVerdict: z.string().min(1),
	}).strict()),
}).strict();
const routingWaiverSchema = z.object({
	...commonArtifactShape,
	artifactId: z.literal("population-routing"),
	kind: z.literal("owner-waiver"),
	result: z.literal("pass"),
	waivedBy: z.string().min(1),
	waiverReason: z.string().min(1),
}).strict();

const expectedRouting = new Map<string, readonly [string, string]>([
	["value-swap", ["transition-narrative", "ACCEPTED"]],
	["negated-current", ["transition-narrative", "ACCEPTED"]],
	["list-prune", ["transition-narrative", "ACCEPTED"]],
	["required-refuse-rider", ["transition-narrative", "ACCEPTED"]],
	["pure-negation", ["no-owner", "ACCEPTED"]],
	["mutant-1", ["n/a", "REJECTED"]],
	["mutant-2", ["n/a", "REJECTED"]],
	["mutant-3", ["n/a", "REJECTED"]],
]);

export const remOrderedWaveEntryGuard: typeof requireRemOwnerDecisions = defineRemSafetyGuard(
	{ guardId: "guard.rem.ordered-wave-entry" },
	requireRemOwnerDecisions,
);

export function parseRemEnableConfiguration(value: string | undefined): EntryDecision {
	return parseConfigurationSource(value).decision;
}

export function resolveRemEntryConfiguration(value: string | undefined):
	| { decision: "allow"; reasonCode: null; configuration: RemOperationalConfiguration }
	| { decision: "refuse"; reasonCode: string } {
	const parsed = parseConfigurationSource(value);
	if (parsed.configuration === undefined) {
		return parsed.decision.decision === "refuse"
			? parsed.decision
			: { decision: "refuse", reasonCode: "enable_config_malformed" };
	}
	return { decision: "allow", reasonCode: null, configuration: parsed.configuration };
}

export async function validateRemEntryArtifacts(input: {
	stateRoot: string;
	configSource: string;
}): Promise<EntryDecision> {
	const parsed = parseConfigurationSource(input.configSource);
	if (parsed.configuration === undefined) return parsed.decision;
	const decision = validateArtifacts(input.stateRoot, parsed.configuration, true);
	if (decision.decision === "refuse") {
		recordPreOpenRefusal(input.stateRoot, parsed.configuration.profileId, decision.reasonCode);
	}
	return decision;
}

export async function runRemEntryPreflight(input: {
	stateRoot: string;
	personaDbPath: string;
	configSource: string;
}): Promise<EntryDecision> {
	const gate = await validateRemEntryArtifacts(input);
	if (gate.decision === "refuse") return gate;
	const handle = openSqliteDatabaseReadonly(input.personaDbPath);
	handle.db.close();
	return { decision: "allow", reasonCode: null, outcome: "no-action" };
}

export const validateRemOperationalGrammarActivation = (input: {
	stateRoot: string;
	configSource: string;
}): EntryDecision => {
	const parsed = parseConfigurationSource(input.configSource);
	if (parsed.configuration === undefined) return parsed.decision;
	const snoStationMemRoot = path.join(input.stateRoot, "sno-station-mem");
	const acceptedPath = path.join(snoStationMemRoot, "rem-operational-config.accepted.json");
	let beforeSource: string;
	try {
		beforeSource = readFileSync(acceptedPath, "utf8");
	} catch (error) {
		// An ABSENT baseline is a first activation, not a fault. The accepted file is written
		// only at the tail of this function, after this gate passes, so refusing on absence made
		// a fresh state root permanently unable to activate. An UNUSABLE baseline — present but
		// unreadable, or anything other than ENOENT — still refuses exactly as before.
		//
		// The baseline is adopted IN MEMORY and nothing is written here. Publishing it up front
		// would leave a configuration that never passed the corpus and A/B checks sitting on
		// disk as the baseline every later activation compares against, so a failed first boot
		// would poison the correct one that follows it.
		if (!isFileNotFound(error)) {
			return { decision: "refuse", reasonCode: "grammar.previousConfigurationMissing" };
		}
		beforeSource = input.configSource;
	}
	const before = parseConfigurationSource(beforeSource);
	if (before.configuration === undefined) {
		return { decision: "refuse", reasonCode: "grammar.previousConfigurationMissing" };
	}
	const corpusRoot = path.join(snoStationMemRoot, "rem-grammar-corpus");
	let corpusBytes: Buffer;
	try {
		const names = readdirSync(corpusRoot).sort();
		if (names.length === 0) throw new Error("empty corpus");
		corpusBytes = Buffer.concat(names.map((name) => readFileSync(path.join(corpusRoot, name))));
	} catch {
		return { decision: "refuse", reasonCode: "grammar.corpusMissing" };
	}
	const beforeConfigurationSha256 = deriveRemConfigurationSha256(before.configuration);
	const afterConfigurationSha256 = deriveRemConfigurationSha256(parsed.configuration);
	let abArtifact: Parameters<typeof validateRemGrammarChange>[0]["abArtifact"];
	try {
		const value: unknown = JSON.parse(
			readFileSync(path.join(snoStationMemRoot, "rem-gates", "facet-policy-grammar-ab.json"), "utf8"),
		);
		if (isGrammarArtifact(value)) abArtifact = value;
	} catch {
		abArtifact = undefined;
	}
	const decision = validateRemGrammarChange({
		beforeConfigurationSha256,
		before: before.configuration,
		beforeCorpusSha256: createHash("sha256").update(corpusBytes).digest("hex"),
		afterConfigurationSha256,
		after: parsed.configuration,
		...(abArtifact === undefined ? {} : { abArtifact }),
	});
	if (decision.decision === "refuse") {
		return { decision: "refuse", reasonCode: "grammar.abMissingOrFailed" };
	}
	mkdirSync(snoStationMemRoot, { recursive: true });
	const temporaryPath = path.join(snoStationMemRoot, `.rem-operational-config.${randomUUID()}.tmp`);
	writeFileSync(temporaryPath, input.configSource, { mode: 0o600 });
	chmodSync(temporaryPath, 0o600);
	renameSync(temporaryPath, acceptedPath);
	return { decision: "allow", reasonCode: null };
};

function isFileNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function isGrammarArtifact(
	value: unknown,
): value is NonNullable<Parameters<typeof validateRemGrammarChange>[0]["abArtifact"]> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record["beforeConfigurationSha256"] === "string" &&
		typeof record["afterConfigurationSha256"] === "string" &&
		typeof record["corpusSha256"] === "string" &&
		Array.isArray(record["metricDefinitions"]) &&
		record["metricDefinitions"].every((item) => typeof item === "string") &&
		(record["result"] === "pass" || record["result"] === "fail") &&
		Object.keys(record).length === 5
	);
}

export async function assembleRemPopulation(input: {
	stateRoot: string;
	personaDbPath: string;
	configSource: string;
}): Promise<EntryDecision> {
	const parsed = parseConfigurationSource(input.configSource);
	if (parsed.configuration === undefined) return { decision: "refuse", reasonCode: "RO-5" };
	const prerequisites = validateArtifacts(input.stateRoot, parsed.configuration, false);
	if (prerequisites.decision === "refuse") return { decision: "refuse", reasonCode: "RO-1" };
	const routing = validateRoutingArtifact(input.stateRoot, parsed.configuration);
	if (routing.decision === "refuse") return { decision: "refuse", reasonCode: "RO-2" };
	return { decision: "allow", reasonCode: null };
}

export async function runRemOrderedWave(input: {
	database?: RemDatabaseLike;
	configuration: RemOperationalConfiguration;
}): Promise<EntryDecision> {
	return remOrderedWaveEntryGuard({ configuration: input.configuration });
}

function parseConfigurationSource(value: string | undefined): {
	decision: EntryDecision;
	configuration?: RemOperationalConfiguration;
} {
	if (value === undefined) return { decision: { decision: "refuse", reasonCode: "enable_config_absent" } };
	if (value.trim().length === 0) return { decision: { decision: "refuse", reasonCode: "enable_config_blank" } };
	let decoded: unknown;
	try {
		decoded = JSON.parse(value);
	} catch {
		return { decision: { decision: "refuse", reasonCode: "enable_config_malformed" } };
	}
	try {
		return {
			decision: { decision: "allow", reasonCode: null },
			configuration: parseRemOperationalConfiguration(decoded),
		};
	} catch {
		return { decision: { decision: "refuse", reasonCode: "enable_config_malformed" } };
	}
}

function validateArtifacts(
	stateRoot: string,
	configuration: RemOperationalConfiguration,
	includeRouting: boolean,
): EntryDecision {
	const gateRoot = path.join(stateRoot, "sno-station-mem", "rem-gates");
	const configurationSha256 = deriveRemConfigurationSha256(configuration);
	const artifactIds = [
		"p5-production-config",
		"p6-monthly-non-regression",
		"p7-detector-gate-verdict",
		...(includeRouting ? (["population-routing"] as const) : []),
	] as const;
	for (const artifactId of artifactIds) {
		const loaded = loadBoundArtifact(gateRoot, artifactId, configuration.enableGateDigests[artifactId]);
		if (loaded.value === undefined) return loaded.decision;
		if (loaded.value["profileId"] !== configuration.profileId || loaded.value["configurationSha256"] !== configurationSha256) {
			return { decision: "refuse", reasonCode: "artifact_scope_mismatch" };
		}
		const semantic = validateArtifactSemantics(artifactId, loaded.value, gateRoot, configuration);
		if (semantic.decision === "refuse") return semantic;
	}
	return { decision: "allow", reasonCode: null };
}

function loadBoundArtifact(
	gateRoot: string,
	artifactId: keyof RemOperationalConfiguration["enableGateDigests"],
	expectedDigest: string | undefined,
): { decision: EntryDecision; value?: Record<string, unknown> } {
	const artifactPath = path.join(gateRoot, `${artifactId}.json`);
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(artifactPath);
	} catch {
		return { decision: { decision: "refuse", reasonCode: "artifact_missing" } };
	}
	if (!stat.isFile() || stat.isSymbolicLink()) return { decision: { decision: "refuse", reasonCode: "artifact_not_regular" } };
	if ((stat.mode & 0o022) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
		return { decision: { decision: "refuse", reasonCode: "artifact_permissions" } };
	}
	const bytes = readFileSync(artifactPath);
	if (expectedDigest === undefined || createHash("sha256").update(bytes).digest("hex") !== expectedDigest) {
		return { decision: { decision: "refuse", reasonCode: "artifact_digest_mismatch" } };
	}
	try {
		const decoded: unknown = JSON.parse(bytes.toString("utf8"));
		if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) throw new Error("schema");
		return { decision: { decision: "allow", reasonCode: null }, value: decoded as Record<string, unknown> };
	} catch {
		return { decision: { decision: "refuse", reasonCode: "artifact_schema" } };
	}
}

function validateArtifactSemantics(
	artifactId: string,
	artifact: Record<string, unknown>,
	gateRoot: string,
	configuration: RemOperationalConfiguration,
): EntryDecision {
	if (artifactId === "p5-production-config") {
		const parsed = p5Schema.safeParse(artifact);
		if (!parsed.success) return { decision: "refuse", reasonCode: "artifact_schema" };
		const digestKeys = validateRemEnableGateDigestKeys({
			configuration,
			p5ReadbackSource: parsed.data.readbackSource,
		});
		if (digestKeys.decision === "refuse") return digestKeys;
		if (parsed.data.result !== "pass") return { decision: "refuse", reasonCode: "artifact_semantic_fail" };
		if (parsed.data.readbackSource === "immutable-profile") {
			const immutable = loadBoundArtifact(gateRoot, "p5-immutable-profile", configuration.enableGateDigests["p5-immutable-profile"]);
			if (immutable.value === undefined) return immutable.decision;
			const digest = createHash("sha256").update(readFileSync(path.join(gateRoot, "p5-immutable-profile.json"))).digest("hex");
			if (parsed.data.immutableProfileSha256 !== digest) return { decision: "refuse", reasonCode: "artifact_digest_mismatch" };
		}
		return { decision: "allow", reasonCode: null };
	}
	if (artifactId === "p6-monthly-non-regression") {
		const parsed = p6Schema.safeParse(artifact);
		if (parsed.success) {
			if (parsed.data.result !== "pass" || !meetsMinima(parsed.data.minima, parsed.data.measured)) {
				return { decision: "refuse", reasonCode: "artifact_semantic_fail" };
			}
			return { decision: "allow", reasonCode: null };
		}
		const waiver = p6WaiverSchema.safeParse(artifact);
		return waiver.success && waiver.data.profileId === "sno-e2e"
			? { decision: "allow", reasonCode: null }
			: { decision: "refuse", reasonCode: "artifact_schema" };
	}
	if (artifactId === "p7-detector-gate-verdict") {
		const measured = p7MeasuredSchema.safeParse(artifact);
		if (measured.success) return measured.data.result === "pass" && meetsMinima(measured.data.minima, measured.data.measured)
			? { decision: "allow", reasonCode: null }
			: { decision: "refuse", reasonCode: "artifact_semantic_fail" };
		const waiver = p7WaiverSchema.safeParse(artifact);
		return waiver.success && waiver.data.profileId === "sno-e2e"
			? { decision: "allow", reasonCode: null }
			: { decision: "refuse", reasonCode: "artifact_schema" };
	}
	if (artifactId === "population-routing") {
		const waiver = routingWaiverSchema.safeParse(artifact);
		return waiver.success && waiver.data.profileId === "sno-e2e"
			? { decision: "allow", reasonCode: null }
			: validateRoutingValue(artifact);
	}
	return { decision: "refuse", reasonCode: "artifact_schema" };
}

function validateRoutingArtifact(stateRoot: string, configuration: RemOperationalConfiguration): EntryDecision {
	const gateRoot = path.join(stateRoot, "sno-station-mem", "rem-gates");
	const loaded = loadBoundArtifact(gateRoot, "population-routing", configuration.enableGateDigests["population-routing"]);
	if (loaded.value === undefined) return loaded.decision;
	if (loaded.value["profileId"] !== configuration.profileId || loaded.value["configurationSha256"] !== deriveRemConfigurationSha256(configuration)) {
		return { decision: "refuse", reasonCode: "artifact_scope_mismatch" };
	}
	return validateArtifactSemantics(
		"population-routing",
		loaded.value,
		gateRoot,
		configuration,
	);
}

function validateRoutingValue(value: Record<string, unknown>): EntryDecision {
	const parsed = routingSchema.safeParse(value);
	if (!parsed.success || parsed.data.observations.length !== expectedRouting.size) return { decision: "refuse", reasonCode: "artifact_semantic_fail" };
	const seen = new Set<string>();
	for (const observation of parsed.data.observations) {
		const expected = expectedRouting.get(observation.fixtureId);
		if (expected === undefined || seen.has(observation.fixtureId) || observation.observedRoute !== expected[0] || observation.observedVerdict !== expected[1]) {
			return { decision: "refuse", reasonCode: "artifact_semantic_fail" };
		}
		seen.add(observation.fixtureId);
	}
	return { decision: "allow", reasonCode: null };
}

function meetsMinima(minima: Record<string, number>, measured: Record<string, number>): boolean {
	const keys = Object.keys(minima);
	return keys.length > 0 && keys.length === Object.keys(measured).length && keys.every((key) => measured[key] !== undefined && measured[key] >= (minima[key] ?? Number.POSITIVE_INFINITY));
}

function recordPreOpenRefusal(stateRoot: string, profileId: string, reasonCode: string): void {
	const auditPath = path.join(stateRoot, "sno-station-mem", "rem-operational-audit.jsonl");
	mkdirSync(path.dirname(auditPath), { recursive: true });
	const timestamp = new Date().toISOString();
	const preOpenAttemptId = createHash("sha256").update(`${timestamp}\u001fentry-artifacts\u001fenv:SNO_REM_CONFIG_JSON`).digest("hex");
	appendFileSync(
		auditPath,
		`${JSON.stringify({
			pre_open_attempt_id: preOpenAttemptId,
			profile_id: profileId,
			gate_id: "entry-artifacts",
			reason_code: reasonCode,
			timestamp,
		})}\n`,
		{ mode: 0o600 },
	);
}
