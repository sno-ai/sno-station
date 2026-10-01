import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { APP_NAME } from "./constants.js";

export function profileRoot(): string {
	return resolve(process.env["SNO_PROFILE_DIR"] ?? join(homedir(), ".sno"));
}

export function appStateRoot(): string {
	return join(profileRoot(), APP_NAME);
}

export function sessionPath(sessionId: string): string {
	if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("invalid-session-id");
	return join(appStateRoot(), "sessions", `${sessionId}.json`);
}

export function spoolDirectory(): string {
	return join(appStateRoot(), "spool");
}

export function workerLockPath(): string {
	return join(appStateRoot(), "worker.lock");
}

export function workerLogPath(): string {
	return join(appStateRoot(), "worker.log");
}

export function importDirectory(): string {
	return join(appStateRoot(), "import");
}

export function sidecarDiscoveryPath(): string {
	return join(profileRoot(), "station", "sidecar.json");
}
