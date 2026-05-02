import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PathEnv {
	[key: string]: string | undefined;
	SNO_HOME?: string;
	SNO_IDENTITY_PATH?: string;
	SNO_BUFFER_PATH?: string;
	SNO_CONSENT_PATH?: string;
	SNO_OBSERVE_BASE_URL?: string;
}

export function getSnoHome(env: PathEnv = process.env): string {
	return env.SNO_HOME ?? join(homedir(), ".sno");
}

export function getIdentityPath(env: PathEnv = process.env): string {
	return env.SNO_IDENTITY_PATH ?? join(getSnoHome(env), "identity.json");
}

export function getIdentityLockPath(env: PathEnv = process.env): string {
	return join(dirname(getIdentityPath(env)), "identity.lock");
}

export function getBufferPath(env: PathEnv = process.env): string {
	return env.SNO_BUFFER_PATH ?? join(getSnoHome(env), "buffer.db");
}

export function getConsentPath(env: PathEnv = process.env): string {
	return env.SNO_CONSENT_PATH ?? join(getSnoHome(env), "state", "consent.json");
}

export function getPausePath(env: PathEnv = process.env): string {
	return join(getSnoHome(env), "state", "consent-prior.json");
}

export function getRedactionRulesPath(env: PathEnv = process.env): string {
	return join(getSnoHome(env), "redaction-rules.txt");
}
