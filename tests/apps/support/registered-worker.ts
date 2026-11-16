import { spawn } from "node:child_process";
import { resolve } from "node:path";

/** Run the real CLI until registration, keep it alive for the file assertions, then reap it. */
export async function withRegisteredWorker(entry: string, check: () => Promise<void>): Promise<void> {
	const worker = spawn(process.execPath, ["--import", "tsx", entry, "worker"], {
		cwd: resolve(import.meta.dirname, "../../.."), env: process.env, stdio: ["ignore", "pipe", "pipe"],
	});
	const closed = new Promise<void>(resolve => worker.once("close", () => resolve()));
	let output = "";
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`worker registration timed out: ${output}`)), 15_000);
			worker.once("error", reject);
			worker.once("close", code => reject(new Error(`worker exited ${code} before registration: ${output}`)));
			worker.stderr.on("data", chunk => { output += chunk; });
			worker.stdout.on("data", chunk => {
				output += chunk;
				if (output.includes('"event":"worker-registered"')) resolve();
			});
		});
		clearTimeout(timer);
		await check();
	} finally {
		clearTimeout(timer);
		worker.kill("SIGTERM");
		await closed;
	}
}
