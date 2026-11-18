import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { vi } from "vitest";

export async function stubReach(home: string): Promise<string> {
	const reach = join(home, "reach");
	await mkdir(reach);
	await writeFile(join(home, "sno"), "#!/bin/sh\nexit 127\n", { mode: 0o700 });
	const path = process.env.PATH;
	vi.stubEnv("SNO_REACH_ROOT", reach);
	vi.stubEnv("PATH", path ? `${home}${delimiter}${path}` : home);
	return reach;
}
