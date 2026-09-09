import { randomBytes } from "node:crypto";
import { chmodSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { createCuid2, createUUIDv7, isCuid2, isLowercaseCanonicalUUIDv7 } from "@snoai/common-core";
import { atomicWriteJson, ensureDir, readJsonFile, withFileLock } from "./fs-utils.js";
import { logger } from "./log.js";
import { getIdentityLockPath, getIdentityPath, type PathEnv } from "./paths.js";
import type { Identity } from "./types.js";

interface IdentityRecord {
	version?: unknown;
	user_cuid?: unknown;
	machine_uuid?: unknown;
	machine_secret?: unknown;
	created_at?: unknown;
	default_project_id?: unknown;
	user_account_id?: unknown;
}

const MACHINE_SECRET_PATTERN = /^[0-9a-f]{64}$/u;

export function bootstrapIdentity(env: PathEnv = process.env): Identity {
	const identityPath = getIdentityPath(env);
	const lockPath = getIdentityLockPath(env);
	ensureIdentityDir(identityPath);
	return withFileLock(lockPath, () => {
		const existing = readJsonFile<unknown>(identityPath);
		const identity = normalizeIdentity(existing);
		if (identity !== null) {
			if (!isValidIdentity(existing)) {
				atomicWriteJson(identityPath, identity, 0o600);
			}
			warnIfPermissiveMode(identityPath);
			return identity;
		}
		const next = createIdentity();
		atomicWriteJson(identityPath, next, 0o600);
		return next;
	});
}

export function updateIdentity(
	mutate: (identity: Identity) => Identity,
	env: PathEnv = process.env,
): Identity {
	const identityPath = getIdentityPath(env);
	const lockPath = getIdentityLockPath(env);
	ensureIdentityDir(identityPath);
	return withFileLock(lockPath, () => {
		const existing = readJsonFile<unknown>(identityPath);
		const identity = normalizeIdentity(existing) ?? createIdentity();
		const updated = mutate(identity);
		atomicWriteJson(identityPath, updated, 0o600);
		return updated;
	});
}

export function updateValidIdentity(
	mutate: (identity: Identity) => Identity,
	env: PathEnv = process.env,
): Identity | null {
	const identityPath = getIdentityPath(env);
	const lockPath = getIdentityLockPath(env);
	ensureIdentityDir(identityPath);
	return withFileLock(lockPath, () => {
		const existing = readJsonFile<unknown>(identityPath);
		const identity = normalizeIdentity(existing);
		if (identity === null) {
			return null;
		}
		const updated = mutate(identity);
		atomicWriteJson(identityPath, updated, 0o600);
		return updated;
	});
}

export function isValidIdentity(value: unknown): value is Identity {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as IdentityRecord;
	return (
		record.version === 1 &&
		typeof record.user_cuid === "string" &&
		isCuid2(record.user_cuid) &&
		typeof record.machine_uuid === "string" &&
		isLowercaseCanonicalUUIDv7(record.machine_uuid) &&
		typeof record.machine_secret === "string" &&
		MACHINE_SECRET_PATTERN.test(record.machine_secret) &&
		typeof record.created_at === "string" &&
		(record.default_project_id === undefined ||
			record.default_project_id === null ||
			typeof record.default_project_id === "string") &&
		(record.user_account_id === undefined ||
			record.user_account_id === null ||
			(typeof record.user_account_id === "string" && isCuid2(record.user_account_id)))
	);
}

function normalizeIdentity(value: unknown): Identity | null {
	if (isValidIdentity(value)) {
		return value;
	}
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const record = value as IdentityRecord;
	if (!isNormalizableIdentityRecord(record)) {
		return null;
	}
	return {
		version: 1,
		user_cuid: record.user_cuid,
		machine_uuid: record.machine_uuid,
		machine_secret: record.machine_secret,
		created_at: record.created_at,
		...(record.default_project_id === undefined
			? {}
			: { default_project_id: record.default_project_id }),
	};
}

function isNormalizableIdentityRecord(record: IdentityRecord): record is IdentityRecord & {
	version: 1;
	user_cuid: string;
	machine_uuid: string;
	machine_secret: string;
	created_at: string;
	default_project_id?: string | null;
} {
	return (
		record.version === 1 &&
		typeof record.user_cuid === "string" &&
		isCuid2(record.user_cuid) &&
		typeof record.machine_uuid === "string" &&
		isLowercaseCanonicalUUIDv7(record.machine_uuid) &&
		typeof record.machine_secret === "string" &&
		MACHINE_SECRET_PATTERN.test(record.machine_secret) &&
		typeof record.created_at === "string" &&
		(record.default_project_id === undefined ||
			record.default_project_id === null ||
			typeof record.default_project_id === "string")
	);
}

function createIdentity(): Identity {
	return {
		version: 1,
		user_cuid: createCuid2(),
		machine_uuid: createUUIDv7(),
		machine_secret: generateMachineSecret(),
		created_at: new Date().toISOString(),
	};
}

function generateMachineSecret(): string {
	return randomBytes(32).toString("hex");
}

function ensureIdentityDir(identityPath: string): void {
	const dir = dirname(identityPath);
	ensureDir(dir);
	if (process.platform === "win32") {
		return;
	}
	try {
		chmodSync(dir, 0o700);
	} catch (error) {
		logger.warn("sno observe identity directory mode could not be tightened", {
			path: dir,
			error,
		}, {
			event_name: "sno.observe.internal.identity.ensureidentitydir",
			file: "packages/sno-observe/src/internal/identity.ts",
			function: "ensureIdentityDir",
			site_id: "sno.observe.internal.identity.ensureidentitydir.1",
		});
	}
}

function warnIfPermissiveMode(path: string): void {
	if (process.platform === "win32") {
		return;
	}
	try {
		const mode = statSync(path).mode & 0o777;
		if ((mode & 0o077) !== 0) {
			logger.warn("sno observe identity file has permissive mode", {
				path,
				mode: mode.toString(8),
			}, {
				event_name: "sno.observe.internal.identity.warnifpermissivemode",
				file: "packages/sno-observe/src/internal/identity.ts",
				function: "warnIfPermissiveMode",
				site_id: "sno.observe.internal.identity.warnifpermissivemode.2",
			});
		}
	} catch {}
}
