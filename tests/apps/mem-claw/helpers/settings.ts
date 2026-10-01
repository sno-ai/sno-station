import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const profileRoot = process.env.SNO_PROFILE_DIR ?? join(homedir(), ".sno");

export function readTestSnoGpuSettings(): { baseUrl: string; apiKey: string } {
	const path = join(profileRoot, "settings.json");
	return (JSON.parse(readFileSync(path, "utf8")) as { snoGpu: { baseUrl: string; apiKey: string } }).snoGpu;
}

export function readTestModelCalls(): Record<string, Record<string, "off" | "host" | "sno-gpu">> {
	const path = new URL("../../../../packages/memory/settings.default.json", import.meta.url);
	return (JSON.parse(readFileSync(path, "utf8")) as { modelCalls: Record<string, Record<string, "off" | "host" | "sno-gpu">> }).modelCalls;
}
