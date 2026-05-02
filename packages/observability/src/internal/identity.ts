import { randomBytes } from "node:crypto";
import { chmodSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { createId } from "@paralleldrive/cuid2";
import { v7 as uuidv7, validate as validateUuid } from "uuid";
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

export function isValidIdentity(value: unknown): value is Identity {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as IdentityRecord;
	return (
		record.version === 1 &&
		typeof record.user_cuid === "string" &&
		record.user_cuid.length > 0 &&
		typeof record.machine_uuid === "string" &&
		validateUuid(record.machine_uuid) &&
		typeof record.machine_secret === "string" &&
		MACHINE_SECRET_PATTERN.test(record.machine_secret) &&
		typeof record.created_at === "string" &&
		(record.default_project_id === undefined ||
			record.default_project_id === null ||
			typeof record.default_project_id === "string")
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
	if (
		record.version !== 1 ||
		typeof record.user_cuid !== "string" ||
		record.user_cuid.length === 0 ||
		typeof record.machine_uuid !== "string" ||
		!validateUuid(record.machine_uuid) ||
		typeof record.created_at !== "string"
	) {
		return null;
	}
	const machineSecret =
		typeof record.machine_secret === "string" && MACHINE_SECRET_PATTERN.test(record.machine_secret)
			? record.machine_secret
			: generateMachineSecret();
	const identity: Identity = {
		version: 1,
		user_cuid: record.user_cuid,
		machine_uuid: record.machine_uuid,
		machine_secret: machineSecret,
		created_at: record.created_at,
	};
	if (record.default_project_id === null || typeof record.default_project_id === "string") {
		identity.default_project_id = record.default_project_id;
	}
	return identity;
}

function createIdentity(): Identity {
	return {
		version: 1,
		user_cuid: createId(),
		machine_uuid: uuidv7(),
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
			error: error instanceof Error ? error.message : String(error),
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
			});
		}
	} catch {}
}
