import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ContractError } from "./error";
import { getSnoStationMemStateDir, getStartupLogPath } from "./profile";
import { checkDiscovery, processAlive, readDiscovery, type Discovery } from "./discovery";
import { MEMORY_START_TIMEOUT_MS } from "./routes";

/** True when something accepts connections on the loopback port; the sidecar listens before it writes discovery. */
function listening(port: number): Promise<boolean> {
	return new Promise(resolve => {
		const socket = connect({ host: "127.0.0.1", port });
		const done = (open: boolean) => { socket.destroy(); resolve(open); };
		socket.setTimeout(1_000, () => done(false));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

export async function startSidecar(memoryPackage: { path: string; node: string }): Promise<Discovery> {
	const current = await readDiscovery();
	// A sidecar killed outright leaves its discovery file, and its pid can later belong to an unrelated process. Only a
	// live pid whose port still listens is the running sidecar; anything else is a leftover and a new one starts.
	if (current && processAlive(current.pid) && await listening(current.port)) {
		const deadline = Date.now() + MEMORY_START_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (await checkDiscovery(current).then(() => true, () => false)) return current;
			await delay(Math.min(250, Math.max(0, deadline - Date.now())));
		}
		throw new ContractError("sidecar-unresponsive");
	}
	await mkdir(getSnoStationMemStateDir(), { recursive: true, mode: 0o700 });
	const log = await open(getStartupLogPath(), "a", 0o600);
	let failed = false;
	try {
		const entry = join(memoryPackage.path, "dist", "sidecar", "main.js");
		const child = spawn(memoryPackage.node, [entry], { detached: true, stdio: ["ignore", log.fd, log.fd], env: process.env });
		child.once("error", () => { failed = true; });
		child.once("exit", code => { if (code !== 0) failed = true; });
		child.unref();
	} finally { await log.close(); }
	const deadline = Date.now() + MEMORY_START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const discovery = await readDiscovery();
		if (discovery && processAlive(discovery.pid) && await listening(discovery.port)) { await checkDiscovery(discovery); return discovery; }
		if (failed) throw new ContractError("storage-unavailable");
		await delay(50);
	}
	throw new ContractError("sidecar-unreachable");
}
