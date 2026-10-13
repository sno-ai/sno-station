import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Stop producers before the service; deleting settings prevents a late hook from starting it again.
export async function cleanupProfile(profile, skin, prefix) {
	rmSync(join(profile, "settings.json"), { force: true });
	const processes = () => execFileSync("ps", ["-eo", "pid=,ppid=,stat="], { encoding: "utf8" })
		.trim().split("\n").map(line => {
			const [pid, parent, state] = line.trim().split(/\s+/);
			return { pid: Number(pid), parent: Number(parent), state };
		});
	const signal = (pid, name) => {
		try { process.kill(pid, name); } catch (error) { if (error.code !== "ESRCH") throw error; }
	};
	async function stop(pid) {
		const tree = processes();
		const owned = new Set([pid]);
		for (let previous = 0; previous !== owned.size;) {
			previous = owned.size;
			for (const row of tree) if (owned.has(row.parent)) owned.add(row.pid);
		}
		for (const name of ["SIGTERM", "SIGKILL"]) {
			for (const target of [...owned].reverse()) signal(target, name);
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline) {
				if (!processes().some(row => owned.has(row.pid) && !row.state.startsWith("Z"))) return;
				await delay(50);
			}
		}
		throw new Error(`Profile cleanup could not stop process ${pid}`);
	}
	const read = path => {
		try { return readFileSync(path, "utf8"); }
		catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
	};
	try {
		const lock = read(join(profile, `sno-mem-${skin}`, "worker.lock"));
		if (lock) await stop(Number(lock.split(" ")[0]));
		const discovery = read(join(profile, "station", "sidecar.json"));
		if (discovery) await stop(JSON.parse(discovery).pid);
	} finally {
		rmSync(profile, { recursive: true, force: true });
		if (prefix) rmSync(prefix, { recursive: true, force: true });
	}
}
