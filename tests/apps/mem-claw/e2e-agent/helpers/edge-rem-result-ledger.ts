import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rmdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

export type EdgeRemResultClassification = "NO-RESULT" | "RESULT";
export type EdgeRemResultOutcome = "fail" | "pass";

interface EdgeRemAttempt {
	attemptId: string;
	classification?: EdgeRemResultClassification;
	gatewayDispatchedAt?: string;
	gatewayNoActionConfirmedAt?: string;
	gatewayNoActionEvidence?: string;
	jobOperations?: number;
	outcome?: EdgeRemResultOutcome;
	pid: number;
	reason?: string;
	remJobDispatchedAt?: string;
	setupOnlyReclaimConfirmedAt?: string;
	setupOnlyReclaimEvidence?: ValidatedSetupOnlyReclaimEvidence;
	scopeMismatchConfirmedAt?: string;
	scopeMismatchEvidence?: ValidatedScopeMismatchEvidence;
	startedAt: string;
	uninstantiatedConfirmedAt?: string;
	uninstantiatedEvidence?: ValidatedUninstantiatedEvidence;
}

type ValidatedScopeMismatchEvidence = {
	candidateIdentityPath: string;
	candidateIdentitySha256: string;
	jobScope: string;
	publicStatePath: string;
	publicStateSha256: string;
	storedRowCount: number;
	storedScopes: string[];
	waveJobsPath: string;
	waveJobsSha256: string;
};

type SetupOnlyReclaimEvidence = {
	cleanupArtifactPath: string;
	contentQueries: string[];
	mode: "post-delete-content-sweep" | "pre-job-row-ids";
	noRemJobEvidenceArtifactPath?: string;
	setupArtifactPaths: string[];
};

type ValidatedSetupOnlyReclaimEvidence = SetupOnlyReclaimEvidence & {
	cleanupArtifactSha256: string;
	deletedIds: string[];
	noRemJobEvidenceArtifactSha256?: string;
	setupArtifacts: { path: string; rowId: string; sha256: string }[];
};

type ValidatedUninstantiatedEvidence = {
	path: string;
	reason: "keep" | "no_pair";
	sha256: string;
};

interface EdgeRemResultLedger {
	cases: Record<string, { attempts: EdgeRemAttempt[] }>;
	journeyId: string;
}

export async function startEdgeRemAttempt(input: {
	attemptId: string;
	caseName: string;
	journeyId: string;
	ledgerPath: string;
}): Promise<void> {
	await updateLedger(input.ledgerPath, input.journeyId, (ledger) => {
		const entry = ledger.cases[input.caseName] ?? { attempts: [] };
		ledger.cases[input.caseName] = entry;
		const uninstantiatedAttempts = entry.attempts.filter(
			(attempt) => attempt.uninstantiatedConfirmedAt !== undefined,
		).length;
		if (uninstantiatedAttempts >= 2) {
			throw new Error(`${input.caseName} already used its one sharper-input retry`);
		}
		for (const attempt of entry.attempts) {
			if (attempt.classification === "RESULT") {
				throw new Error(`${input.caseName} already has a RESULT`);
			}
			if (
				attempt.remJobDispatchedAt !== undefined &&
				attempt.jobOperations !== 0 &&
				attempt.uninstantiatedConfirmedAt === undefined &&
				attempt.scopeMismatchConfirmedAt === undefined
			) {
				throw new Error(`${input.caseName} prior attempt dispatched a REM job`);
			}
			if (isProcessAlive(attempt.pid)) {
				throw new Error(`${input.caseName} prior attempt process is still alive`);
			}
			if (
				attempt.gatewayDispatchedAt !== undefined &&
				attempt.gatewayNoActionConfirmedAt === undefined &&
				attempt.setupOnlyReclaimConfirmedAt === undefined &&
				attempt.uninstantiatedConfirmedAt === undefined &&
				attempt.scopeMismatchConfirmedAt === undefined
			) {
				throw new Error(
					`${input.caseName} prior attempt was gateway-dispatched without confirmed no-action`,
				);
			}
		}
		entry.attempts.push({
			attemptId: input.attemptId,
			pid: process.pid,
			startedAt: new Date().toISOString(),
		});
	});
}

export async function reclassifyEdgeRemScopeMismatch(input: {
	attemptId: string;
	candidateIdentityPath: string;
	caseName: string;
	journeyId: string;
	ledgerPath: string;
	publicStatePath: string;
	waveJobsPath: string;
}): Promise<void> {
	const evidence = await validateScopeMismatchEvidence(input);
	await updateLedger(input.ledgerPath, input.journeyId, (ledger) => {
		const attempt = ledger.cases[input.caseName]?.attempts.find(
			(candidate) => candidate.attemptId === input.attemptId,
		);
		if (
			!attempt ||
			attempt.classification !== "RESULT" ||
			attempt.outcome !== "fail" ||
			attempt.remJobDispatchedAt === undefined
		) {
			throw new Error("scope-mismatch reclassification requires a dispatched failed RESULT");
		}
		attempt.classification = "NO-RESULT";
		delete attempt.outcome;
		attempt.reason = "scope-mismatch:no-rows-in-scope";
		attempt.scopeMismatchConfirmedAt = new Date().toISOString();
		attempt.scopeMismatchEvidence = evidence;
	});
}

async function validateScopeMismatchEvidence(input: {
	candidateIdentityPath: string;
	publicStatePath: string;
	waveJobsPath: string;
}): Promise<ValidatedScopeMismatchEvidence> {
	for (const path of [
		input.candidateIdentityPath,
		input.publicStatePath,
		input.waveJobsPath,
	]) {
		if (!isAbsolute(path)) throw new Error("scope-mismatch evidence paths must be absolute");
	}
	const [candidateIdentityBytes, publicStateBytes, waveJobsBytes] = await Promise.all([
		readFile(input.candidateIdentityPath),
		readFile(input.publicStatePath),
		readFile(input.waveJobsPath),
	]);
	const identity = JSON.parse(candidateIdentityBytes.toString("utf8")) as { scope?: unknown };
	const publicState = JSON.parse(publicStateBytes.toString("utf8")) as { rows?: unknown };
	const waveJobs = JSON.parse(waveJobsBytes.toString("utf8")) as {
		replace?: { stats?: { operations?: unknown } };
		update?: { stats?: { operations?: unknown } };
	};
	if (typeof identity.scope !== "string" || identity.scope.length === 0) {
		throw new Error("scope-mismatch candidate identity has no job scope");
	}
	if (
		waveJobs.replace?.stats?.operations !== 0 ||
		waveJobs.update?.stats?.operations !== 0
	) {
		throw new Error("scope-mismatch reclassification requires both jobs to report zero operations");
	}
	if (!Array.isArray(publicState.rows) || publicState.rows.length === 0) {
		throw new Error("scope-mismatch public state has no stored rows");
	}
	const storedScopes = publicState.rows.map((row) => {
		if (typeof row !== "object" || row === null || Array.isArray(row)) {
			throw new Error("scope-mismatch public state contains an invalid row");
		}
		const scope = (row as Record<string, unknown>)["scope"];
		if (typeof scope !== "string" || scope.length === 0) {
			throw new Error("scope-mismatch public row has no scope");
		}
		return scope;
	});
	if (storedScopes.some((scope) => scope === identity.scope)) {
		throw new Error("scope-mismatch evidence contains a row in the job scope");
	}
	return {
		candidateIdentityPath: input.candidateIdentityPath,
		candidateIdentitySha256: createHash("sha256").update(candidateIdentityBytes).digest("hex"),
		jobScope: identity.scope,
		publicStatePath: input.publicStatePath,
		publicStateSha256: createHash("sha256").update(publicStateBytes).digest("hex"),
		storedRowCount: storedScopes.length,
		storedScopes: [...new Set(storedScopes)].sort(),
		waveJobsPath: input.waveJobsPath,
		waveJobsSha256: createHash("sha256").update(waveJobsBytes).digest("hex"),
	};
}

export async function markEdgeRemJobDispatched(input: {
	attemptId: string;
	caseName: string;
	journeyId: string;
	ledgerPath: string;
}): Promise<void> {
	await updateAttempt(input, (attempt) => {
		attempt.remJobDispatchedAt = new Date().toISOString();
	});
}

export async function markEdgeRemGatewayDispatched(input: {
	attemptId: string;
	caseName: string;
	journeyId: string;
	ledgerPath: string;
}): Promise<void> {
	await updateAttempt(input, (attempt) => {
		attempt.gatewayDispatchedAt = new Date().toISOString();
	});
}

export async function finishEdgeRemAttempt(input: {
	attemptId: string;
	caseName: string;
	classification: EdgeRemResultClassification;
	journeyId: string;
	ledgerPath: string;
	gatewayNoActionEvidence?: string;
	jobOperations?: number;
	outcome?: EdgeRemResultOutcome;
	reason: string;
	setupOnlyReclaimEvidence?: SetupOnlyReclaimEvidence;
	uninstantiatedEvidencePath?: string;
}): Promise<void> {
	const setupOnlyReclaimEvidence = input.setupOnlyReclaimEvidence
		? await validateSetupOnlyReclaimEvidence(input.setupOnlyReclaimEvidence, {
				attemptId: input.attemptId,
				caseName: input.caseName,
			})
		: undefined;
	const uninstantiatedEvidence = input.uninstantiatedEvidencePath
		? await validateUninstantiatedEvidence(input.uninstantiatedEvidencePath, {
				attemptId: input.attemptId,
				caseName: input.caseName,
			})
		: undefined;
	await updateAttempt(input, (attempt) => {
		if (
			input.jobOperations !== undefined &&
			(!Number.isInteger(input.jobOperations) || input.jobOperations < 0)
		) {
			throw new Error("edge REM job operations must be a non-negative integer");
		}
		if (
			input.classification === "RESULT" &&
			attempt.remJobDispatchedAt !== undefined &&
			(input.jobOperations === undefined || input.jobOperations < 1)
		) {
			throw new Error("edge REM RESULT requires at least one operation from the job under test");
		}
		attempt.classification = input.classification;
		if (input.jobOperations !== undefined) attempt.jobOperations = input.jobOperations;
		attempt.reason = input.reason;
		if (input.gatewayNoActionEvidence !== undefined) {
			if (
				input.classification !== "NO-RESULT" ||
				attempt.gatewayDispatchedAt === undefined ||
				attempt.remJobDispatchedAt !== undefined
			) {
				throw new Error(
					"gateway no-action confirmation requires a dispatched NO-RESULT before REM job dispatch",
				);
			}
			attempt.gatewayNoActionConfirmedAt = new Date().toISOString();
			attempt.gatewayNoActionEvidence = input.gatewayNoActionEvidence;
		}
		if (setupOnlyReclaimEvidence !== undefined) {
			if (
				input.classification !== "NO-RESULT" ||
				attempt.gatewayDispatchedAt === undefined ||
				attempt.remJobDispatchedAt !== undefined
			) {
				throw new Error(
					"setup-only reclaim requires a dispatched NO-RESULT before any REM job dispatch",
				);
			}
			attempt.setupOnlyReclaimConfirmedAt = new Date().toISOString();
			attempt.setupOnlyReclaimEvidence = setupOnlyReclaimEvidence;
		}
		if (uninstantiatedEvidence !== undefined) {
			if (
				input.classification !== "NO-RESULT" ||
				input.outcome !== undefined ||
				attempt.remJobDispatchedAt === undefined
			) {
				throw new Error(
					"uninstantiated evidence requires a dispatched NO-RESULT without an outcome",
				);
			}
			attempt.uninstantiatedConfirmedAt = new Date().toISOString();
			attempt.uninstantiatedEvidence = uninstantiatedEvidence;
		}
		if (input.outcome !== undefined) attempt.outcome = input.outcome;
	});
}

async function validateUninstantiatedEvidence(
	path: string,
	identity: { attemptId: string; caseName: string },
): Promise<ValidatedUninstantiatedEvidence> {
	if (!isAbsolute(path)) throw new Error("uninstantiated evidence path must be absolute");
	const bytes = await readFile(path);
	const parsed = JSON.parse(bytes.toString("utf8")) as {
		answerRequestedAt?: unknown;
		attemptId?: unknown;
		canonicalAddressesEqual?: unknown;
		caseName?: unknown;
		classification?: unknown;
		reason?: unknown;
		recordedVerdict?: unknown;
		verdictRecordedAt?: unknown;
	};
	const reason = parsed.reason;
	if (
		parsed.attemptId !== identity.attemptId ||
		parsed.caseName !== identity.caseName ||
		parsed.classification !== "UNINSTANTIATED" ||
		parsed.answerRequestedAt !== null ||
		parsed.canonicalAddressesEqual !== true ||
		(typeof parsed.verdictRecordedAt !== "string" ||
			Number.isNaN(Date.parse(parsed.verdictRecordedAt))) ||
		(reason !== "keep" && reason !== "no_pair") ||
		(reason === "keep" && parsed.recordedVerdict !== "keep") ||
		(reason === "no_pair" && parsed.recordedVerdict !== null)
	) {
		throw new Error("uninstantiated evidence does not prove a pre-answer keep or no-pair verdict");
	}
	return {
		path,
		reason,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}

async function validateSetupOnlyReclaimEvidence(
	evidence: SetupOnlyReclaimEvidence,
	identity: { attemptId: string; caseName: string },
): Promise<ValidatedSetupOnlyReclaimEvidence> {
	if (!isAbsolute(evidence.cleanupArtifactPath)) {
		throw new Error("setup-only cleanup artifact path must be absolute");
	}
	if (evidence.contentQueries.length === 0 || evidence.contentQueries.some((value) => !value)) {
		throw new Error("setup-only reclaim must record every content query");
	}
	const cleanupBytes = await readFile(evidence.cleanupArtifactPath);
	const cleanup = JSON.parse(cleanupBytes.toString("utf8")) as {
		deletedIds?: unknown;
		errors?: unknown;
		remaining?: unknown;
	};
	if (!Array.isArray(cleanup.deletedIds) || cleanup.deletedIds.some((id) => typeof id !== "string")) {
		throw new Error("setup-only cleanup artifact has invalid deletedIds");
	}
	if (!Array.isArray(cleanup.errors) || cleanup.errors.length > 0) {
		throw new Error("setup-only cleanup artifact must record zero errors");
	}
	if (!Array.isArray(cleanup.remaining) || cleanup.remaining.length > 0) {
		throw new Error("setup-only cleanup artifact must record zero remaining rows");
	}
	const deletedIds = cleanup.deletedIds as string[];
	const setupArtifacts = await Promise.all(
		evidence.setupArtifactPaths.map(async (path) => {
			if (!isAbsolute(path)) throw new Error("setup row artifact path must be absolute");
			const bytes = await readFile(path);
			const parsed = JSON.parse(bytes.toString("utf8")) as { rowId?: unknown };
			if (typeof parsed.rowId !== "string" || parsed.rowId.length === 0) {
				throw new Error(`setup row artifact has no rowId: ${path}`);
			}
			return {
				path,
				rowId: parsed.rowId,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			};
		}),
	);
	if (evidence.mode === "pre-job-row-ids") {
		if (setupArtifacts.length === 0) {
			throw new Error("pre-job-row-ids reclaim requires setup row artifacts");
		}
		const setupIds = new Set(setupArtifacts.map((artifact) => artifact.rowId));
		const deleted = new Set(deletedIds);
		if (
			setupIds.size !== deleted.size ||
			[...setupIds].some((rowId) => !deleted.has(rowId))
		) {
			throw new Error("pre-job setup row ids do not exactly match cleanup deletions");
		}
	} else {
		if (evidence.setupArtifactPaths.length > 0) {
			throw new Error("post-delete-content-sweep reclaim cannot substitute setup row artifacts");
		}
		if (!evidence.noRemJobEvidenceArtifactPath) {
			throw new Error("legacy content-sweep reclaim requires no-REM-job evidence");
		}
	}
	const noRemJobEvidenceArtifactSha256 = evidence.noRemJobEvidenceArtifactPath
		? await validateNoRemJobEvidence(evidence.noRemJobEvidenceArtifactPath, evidence, identity)
		: undefined;
	return {
		...evidence,
		cleanupArtifactSha256: createHash("sha256").update(cleanupBytes).digest("hex"),
		deletedIds,
		...(noRemJobEvidenceArtifactSha256
			? { noRemJobEvidenceArtifactSha256 }
			: {}),
		setupArtifacts,
	};
}

async function validateNoRemJobEvidence(
	path: string,
	evidence: SetupOnlyReclaimEvidence,
	identity: { attemptId: string; caseName: string },
): Promise<string> {
	if (!isAbsolute(path)) throw new Error("no-REM-job evidence path must be absolute");
	const bytes = await readFile(path);
	const parsed = JSON.parse(bytes.toString("utf8")) as {
		attemptId?: unknown;
		caseName?: unknown;
		cleanupArtifactPath?: unknown;
		contentQueries?: unknown;
		remJobDispatched?: unknown;
	};
	if (
		parsed.attemptId !== identity.attemptId ||
		parsed.caseName !== identity.caseName ||
		parsed.remJobDispatched !== false ||
		parsed.cleanupArtifactPath !== evidence.cleanupArtifactPath ||
		JSON.stringify(parsed.contentQueries) !== JSON.stringify(evidence.contentQueries)
	) {
		throw new Error("no-REM-job evidence does not match the ledger attempt and cleanup");
	}
	return createHash("sha256").update(bytes).digest("hex");
}

async function updateAttempt(
	input: {
		attemptId: string;
		caseName: string;
		journeyId: string;
		ledgerPath: string;
	},
	mutate: (attempt: EdgeRemAttempt) => void,
): Promise<void> {
	await updateLedger(input.ledgerPath, input.journeyId, (ledger) => {
		const attempt = ledger.cases[input.caseName]?.attempts.find(
			(candidate) => candidate.attemptId === input.attemptId,
		);
		if (!attempt) throw new Error("edge REM result ledger lost the active attempt");
		if (attempt.classification !== undefined) {
			throw new Error("edge REM terminal result is immutable");
		}
		mutate(attempt);
	});
}

async function updateLedger(
	ledgerPath: string,
	journeyId: string,
	mutate: (ledger: EdgeRemResultLedger) => void,
): Promise<void> {
	await mkdir(dirname(ledgerPath), { recursive: true });
	const lockPath = `${ledgerPath}.lock`;
	await mkdir(lockPath);
	try {
		const ledger = await readLedger(ledgerPath, journeyId);
		mutate(ledger);
		const temporaryPath = `${ledgerPath}.${process.pid}.${Date.now()}.tmp`;
		const handle = await open(temporaryPath, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(ledger, null, 2)}\n`);
		} finally {
			await handle.close();
		}
		await rename(temporaryPath, ledgerPath);
	} finally {
		await rmdir(lockPath);
	}
}

async function readLedger(
	ledgerPath: string,
	journeyId: string,
): Promise<EdgeRemResultLedger> {
	try {
		const parsed = JSON.parse(await readFile(ledgerPath, "utf8")) as EdgeRemResultLedger;
		if (parsed.journeyId !== journeyId || typeof parsed.cases !== "object") {
			throw new Error("edge REM result ledger does not match this journey");
		}
		return parsed;
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return { cases: {}, journeyId };
		throw error;
	}
}

function isNodeError(error: unknown, code: string): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === code
	);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !isNodeError(error, "ESRCH");
	}
}
