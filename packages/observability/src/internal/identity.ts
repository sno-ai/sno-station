import { statSync } from "node:fs";
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
	created_at?: unknown;
	claimed?: unknown;
	user_account_id?: unknown;
	access_token?: unknown;
	refresh_token?: unknown;
	default_project_id?: unknown;
}

export function bootstrapIdentity(env: PathEnv = process.env): Identity {
	const identityPath = getIdentityPath(env);
	const lockPath = getIdentityLockPath(env);
	ensureDir(dirname(identityPath));
	return withFileLock(lockPath, () => {
		const existing = readJsonFile<Identity>(identityPath);
		if (isValidIdentity(existing)) {
			warnIfPermissiveMode(identityPath);
			return existing;
		}
		const identity = createIdentity();
		atomicWriteJson(identityPath, identity, 0o600);
		return identity;
	});
}

export function updateIdentity(
	mutate: (identity: Identity) => Identity,
	env: PathEnv = process.env,
): Identity {
	const identityPath = getIdentityPath(env);
	const lockPath = getIdentityLockPath(env);
	ensureDir(dirname(identityPath));
	return withFileLock(lockPath, () => {
		const existing = readJsonFile<Identity>(identityPath);
		const identity = isValidIdentity(existing) ? existing : createIdentity();
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
		typeof record.created_at === "string" &&
		typeof record.claimed === "boolean" &&
		(record.user_account_id === null || typeof record.user_account_id === "string") &&
		(record.access_token === null || typeof record.access_token === "string") &&
		(record.refresh_token === null || typeof record.refresh_token === "string") &&
		(record.default_project_id === undefined ||
			record.default_project_id === null ||
			typeof record.default_project_id === "string")
	);
}

function createIdentity(): Identity {
	return {
		version: 1,
		user_cuid: createId(),
		machine_uuid: uuidv7(),
		created_at: new Date().toISOString(),
		claimed: false,
		user_account_id: null,
		access_token: null,
		refresh_token: null,
		default_project_id: null,
	};
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
