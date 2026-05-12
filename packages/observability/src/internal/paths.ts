import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PathEnv {
	[key: string]: string | undefined;
	SNO_PROFILE_DIR?: string;
	SNO_HOME?: string;
	SNO_IDENTITY_PATH?: string;
	SNO_BUFFER_PATH?: string;
	SNO_CONSENT_PATH?: string;
	SNO_OBSERVE_BASE_URL?: string;
}

export function getSnoProfileDir(env: PathEnv = process.env): string {
	return env.SNO_PROFILE_DIR ?? env.SNO_HOME ?? join(homedir(), ".sno");
}

export function getIdentityPath(env: PathEnv = process.env): string {
	return env.SNO_IDENTITY_PATH ?? join(getSnoProfileDir(env), "identity.json");
}

export function getIdentityLockPath(env: PathEnv = process.env): string {
	return join(dirname(getIdentityPath(env)), "identity.lock");
}

export function getBufferPath(env: PathEnv = process.env): string {
	return env.SNO_BUFFER_PATH ?? join(getSnoProfileDir(env), "buffer.db");
}

export function getConsentPath(env: PathEnv = process.env): string {
	return env.SNO_CONSENT_PATH ?? join(getSnoProfileDir(env), "state", "consent.json");
}

export function getPausePath(env: PathEnv = process.env): string {
	return join(getSnoProfileDir(env), "state", "consent-prior.json");
}

export function getRedactionRulesPath(env: PathEnv = process.env): string {
	return join(getSnoProfileDir(env), "redaction-rules.txt");
}
