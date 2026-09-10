import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ContractError } from "./error";
import { getSnoStationMemStateDir, getStartupLogPath, readBoundStorePath } from "./profile";
import { checkDiscovery, processAlive, readDiscovery, type Discovery } from "./discovery";
import { MEMORY_START_TIMEOUT_MS } from "./routes";

export async function startSidecar(): Promise<Discovery> {
	const storePath = await readBoundStorePath();
	const current = await readDiscovery();
	if (current && processAlive(current.pid)) { await checkDiscovery(current, storePath); return current; }
	await mkdir(getSnoStationMemStateDir(), { recursive: true, mode: 0o700 });
	const log = await open(getStartupLogPath(), "a", 0o600);
	let failed = false;
	try {
		const entry = fileURLToPath(new URL("./sidecar/main.js", import.meta.url));
		const child = spawn(process.execPath, [entry], { detached: true, stdio: ["ignore", log.fd, log.fd], env: process.env });
		child.once("error", () => { failed = true; });
		child.once("exit", code => { if (code !== 75) failed = true; });
		child.unref();
	} finally { await log.close(); }
	const deadline = Date.now() + MEMORY_START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const discovery = await readDiscovery();
		if (discovery && processAlive(discovery.pid)) { await checkDiscovery(discovery, storePath); return discovery; }
		if (failed) throw new ContractError("storage-unavailable");
		await delay(50);
	}
	throw new ContractError("sidecar-unreachable");
}
