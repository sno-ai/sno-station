import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { APP_NAME } from "./constants.js";

export function profileRoot(): string {
	return resolve(process.env["SNO_PROFILE_DIR"] ?? join(homedir(), ".sno"));
}

export function appStateRoot(): string {
	return join(profileRoot(), APP_NAME);
}

function checkedId(id: string): string {
	if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("invalid-conversation-id");
	return id;
}

export function sessionPath(conversationId: string): string {
	return join(appStateRoot(), "sessions", `${checkedId(conversationId)}.json`);
}

/** The shared conversation record (build contract), read by rem-reflect, Reach, heartbeat and the quota check. */
export function conversationPath(conversationId: string): string {
	return join(profileRoot(), "cursor", "conversations", `${checkedId(conversationId)}.json`);
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

export function sidecarDiscoveryPath(): string {
	return join(profileRoot(), "station", "sidecar.json");
}
