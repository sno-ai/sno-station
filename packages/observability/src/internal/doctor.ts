import { existsSync, readFileSync, statSync } from "node:fs";
import { BufferStore } from "./buffer-store.js";
import { normalizeBaseUrl } from "./http.js";
import { isValidIdentity } from "./identity.js";
import {
	getBufferPath,
	getConsentPath,
	getIdentityLockPath,
	getIdentityPath,
	type PathEnv,
} from "./paths.js";
import { CONSENT_VALUES, type DoctorCheck, type DoctorReport } from "./types.js";

interface ConsentState {
	version?: unknown;
	value?: unknown;
	updated_at?: unknown;
}

interface DiagnosticPaths {
	identityPath: string;
	lockPath: string;
	bufferPath: string;
	consentPath: string;
	baseUrl: string;
	baseUrlError: string | null;
}

interface BufferCheckResult {
	check: DoctorCheck;
	pendingCount: number;
	shippedCount: number;
}

interface DiagnosticEnv extends PathEnv {
	SNO_OBSERVE_BASE_URL?: string;
}

export function createDoctorReport(env: DiagnosticEnv = process.env): DoctorReport {
	const paths = resolveDiagnosticPaths(env);
	const buffer = safeBufferCheck(paths.bufferPath);
	return {
		identity: safeDoctorCheck("identity", paths.identityPath, () =>
			checkIdentity(paths.identityPath),
		),
		buffer: buffer.check,
		consent: safeDoctorCheck("consent", paths.consentPath, () => checkConsent(paths.consentPath)),
		last_ship:
			paths.baseUrlError === null
				? checkLastShip(paths.baseUrl, buffer.shippedCount, buffer.pendingCount)
				: {
						name: "last_ship",
						status: "fail",
						detail: `invalid observability endpoint: ${paths.baseUrlError}`,
					},
		lockfile: safeDoctorCheck("lockfile", paths.lockPath, () => checkLockfile(paths.lockPath)),
	};
}

function resolveDiagnosticPaths(env: DiagnosticEnv): DiagnosticPaths {
	const endpoint = normalizeDiagnosticBaseUrl(
		env.SNO_OBSERVE_BASE_URL ?? "https://www.sno.ai",
	);
	return {
		identityPath: getIdentityPath(env),
		lockPath: getIdentityLockPath(env),
		bufferPath: getBufferPath(env),
		consentPath: getConsentPath(env),
		baseUrl: endpoint.value,
		baseUrlError: endpoint.error,
	};
}

function checkIdentity(path: string): DoctorCheck {
	const stat = statPath(path);
	if (stat === null) {
		return {
			name: "identity",
			status: "warn",
			detail:
				"identity not bootstrapped - first SDK use or `sno register` will create it automatically",
			path,
		};
	}
	const parsed = readJson<unknown>(path);
	if (!parsed.ok) {
		return {
			name: "identity",
			status: "fail",
			detail: `identity is not readable JSON at ${path}`,
			path,
		};
	}
	if (!isValidIdentity(parsed.value)) {
		return {
			name: "identity",
			status: "fail",
			detail: `identity is malformed at ${path}`,
			path,
		};
	}
	const modeIssue = modeDetail(path, stat.mode);
	if (modeIssue !== null) {
		return {
			name: "identity",
			status: "warn",
			detail: `identity present but ${modeIssue}`,
			path,
		};
	}
	return {
		name: "identity",
		status: "ok",
		detail: "identity present (anonymous machine)",
		path,
	};
}

function checkBuffer(path: string): BufferCheckResult {
	const stat = statPath(path);
	if (stat === null) {
		return {
			check: {
				name: "buffer",
				status: "warn",
				detail: `buffer not initialized at ${path}`,
				path,
			},
			pendingCount: 0,
			shippedCount: 0,
		};
	}
	let store: BufferStore | null = null;
	try {
		store = new BufferStore(path);
		const stats = store.getQueueStats();
		const totalEvents = store.countAll();
		const shippedCount = store.countShipped();
		const walStatus = existsSync(`${path}-wal`) ? "wal sidecar present" : "wal sidecar absent";
		const safeguard = store.getQueueSafeguard();
		const quarantineReason =
			stats.latestQuarantineReason === null
				? "none"
				: stats.latestQuarantineReason;
		return {
			check: {
				name: "buffer",
				status:
					safeguard === null && stats.activeChainRecoveryCount === 0 ? "ok" : "warn",
				detail: `buffer reachable (queue_depth=${stats.pendingCount}/${totalEvents}; oldest_age_ms=${stats.oldestPendingAgeMs}; retry_count=${stats.maxAttempts}; quarantined_count=${stats.quarantinedCount}; latest_quarantine_reason=${quarantineReason}; active_chain_recovery_count=${stats.activeChainRecoveryCount}; active_chain_recovery_reason=${stats.activeChainRecoveryReason ?? "none"}; database_size_bytes=${stats.databaseSizeBytes}; logical_bytes=${stats.logicalBytes}; physical_bytes=${stats.physicalBytes}; wal_bytes=${stats.walBytes}; freelist_pages=${stats.freelistPages}; freelist_bytes=${stats.freelistBytes}; freelist_ratio=${stats.freelistRatio}; remaining_epochs=${stats.remainingEpochs}; last_compaction_at_ms=${stats.lastCompactionAtMs ?? "none"}; compaction_reason=${stats.compactionReason}; safeguard=${safeguard ?? "none"}; ${walStatus})`,
				path,
			},
			pendingCount: stats.pendingCount,
			shippedCount,
		};
	} catch (error) {
		return {
			check: {
				name: "buffer",
				status: "fail",
				detail: `buffer not reachable at ${path}: ${errorMessage(error)}`,
				path,
			},
			pendingCount: 0,
			shippedCount: 0,
		};
	} finally {
		store?.close();
	}
}

function checkConsent(path: string): DoctorCheck {
	const parsed = readJson<ConsentState>(path);
	if (!parsed.ok && parsed.reason === "missing") {
		return {
			name: "consent",
			status: "ok",
			detail: "consent metadata-only (default)",
			path,
		};
	}
	if (!parsed.ok) {
		return {
			name: "consent",
			status: "fail",
			detail: `consent is not readable JSON at ${path}`,
			path,
		};
	}
	if (!isConsentState(parsed.value)) {
		return {
			name: "consent",
			status: "fail",
			detail: `consent is malformed at ${path}`,
			path,
		};
	}
	return {
		name: "consent",
		status: "ok",
		detail: `consent ${parsed.value.value}`,
		path,
	};
}

function checkLastShip(baseUrl: string, shippedCount: number, pendingCount: number): DoctorCheck {
	let detail = `last successful POST to ${baseUrl}: never`;
	let status: DoctorCheck["status"] = "ok";
	if (pendingCount > 0) {
		status = "warn";
		detail = `${pendingCount} event(s) pending for ${baseUrl}; ${shippedCount} previously shipped`;
	} else if (shippedCount > 0) {
		detail = "local buffer contains shipped events; endpoint and timestamp are not tracked";
	}
	return {
		name: "last_ship",
		status,
		detail,
	};
}

function checkLockfile(path: string): DoctorCheck {
	if (!existsSync(path)) {
		return {
			name: "lockfile",
			status: "ok",
			detail: "no identity lockfile present",
			path,
		};
	}
	const pid = readLockfilePid(path);
	if (pid === null) {
		return {
			name: "lockfile",
			status: "warn",
			detail: `identity lockfile present at ${path} without a PID`,
			path,
		};
	}
	if (isPidRunning(pid)) {
		return {
			name: "lockfile",
			status: "ok",
			detail: `identity lockfile held by pid ${pid}`,
			path,
		};
	}
	return {
		name: "lockfile",
		status: "warn",
		detail: `stale lockfile detected at ${path} - safe to remove if no \`sno\` process is running`,
		path,
	};
}

function statPath(path: string): { mode: number } | null {
	try {
		return statSync(path);
	} catch (error) {
		if (isFileNotFound(error)) {
			return null;
		}
		throw error;
	}
}

function readJson<T>(
	path: string,
): { ok: true; value: T } | { ok: false; reason: "missing" | "invalid" } {
	try {
		return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) as T };
	} catch (error) {
		return { ok: false, reason: isFileNotFound(error) ? "missing" : "invalid" };
	}
}

function isConsentState(value: unknown): value is ConsentState {
	if (!isRecord(value)) {
		return false;
	}
	const state = value as ConsentState;
	return state.version === 1 && isConsentValue(state.value) && typeof state.updated_at === "string";
}

function isConsentValue(value: unknown): value is (typeof CONSENT_VALUES)[number] {
	return typeof value === "string" && CONSENT_VALUES.some((candidate) => candidate === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function modeDetail(path: string, mode: number): string | null {
	if (process.platform === "win32") {
		return null;
	}
	const permissions = mode & 0o777;
	if ((permissions & 0o077) === 0) {
		return null;
	}
	return `${path} mode ${permissions.toString(8)} is permissive`;
}

function readLockfilePid(path: string): number | null {
	try {
		const match = readFileSync(path, "utf8").match(/\d+/u);
		if (match === null) {
			return null;
		}
		const pid = Number(match[0]);
		return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

function isPidRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (isProcessMissing(error)) {
			return false;
		}
		return true;
	}
}

function normalizeDiagnosticBaseUrl(value: string): { value: string; error: string | null } {
	try {
		return { value: normalizeBaseUrl(value), error: null };
	} catch (error) {
		return { value: value.replace(/\/$/u, ""), error: errorMessage(error) };
	}
}

function safeBufferCheck(path: string): BufferCheckResult {
	try {
		return checkBuffer(path);
	} catch (error) {
		return {
			check: {
				name: "buffer",
				status: "fail",
				detail: `buffer check failed at ${path}: ${errorMessage(error)}`,
				path,
			},
			pendingCount: 0,
			shippedCount: 0,
		};
	}
}

function safeDoctorCheck(name: DoctorCheck["name"], path: string, check: () => DoctorCheck): DoctorCheck {
	try {
		return check();
	} catch (error) {
		return {
			name,
			status: "fail",
			detail: `${name} check failed at ${path}: ${errorMessage(error)}`,
			path,
		};
	}
}

function isFileNotFound(error: unknown): boolean {
	return isNodeErrorWithCode(error, "ENOENT");
}

function isProcessMissing(error: unknown): boolean {
	return isNodeErrorWithCode(error, "ESRCH");
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "unknown error";
}
