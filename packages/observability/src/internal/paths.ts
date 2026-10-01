import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const standaloneSettingsSchema = z.object({
	telemetry: z.object({ observe: z.object({ baseUrl: z.string().optional() }).optional() }).optional(),
	logging: z.object({ level: z.enum(["debug", "info", "warn", "error"]).optional() }).optional(),
});

export interface PathEnv {
	[key: string]: string | undefined;
	SNO_PROFILE_DIR?: string;
	SNO_IDENTITY_PATH?: string;
	SNO_BUFFER_PATH?: string;
	SNO_CONSENT_PATH?: string;
}

export function getSnoProfileDir(env: PathEnv = process.env): string {
	return env.SNO_PROFILE_DIR ?? join(homedir(), ".sno");
}

export function readStandaloneSettings(env: PathEnv = process.env): {
	baseUrl: string;
	loggingLevel: string | undefined;
} {
	let settings: unknown;
	const settingsPath = join(getSnoProfileDir(env), "settings.json");
	try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); }
	catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return { baseUrl: "https://www.sno.ai", loggingLevel: undefined };
		}
		throw new Error(`settings unavailable: ${settingsPath}: JSON; see https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md`, { cause: error });
	}
	const parsed = standaloneSettingsSchema.safeParse(settings);
	if (!parsed.success) {
		throw new Error(`settings unavailable: ${settingsPath}: ${parsed.error.issues[0]?.path.join(".") || "settings"}; see https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md`);
	}
	return { baseUrl: parsed.data.telemetry?.observe?.baseUrl ?? "https://www.sno.ai",
		loggingLevel: parsed.data.logging?.level };
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

export function getLogPath(env: PathEnv = process.env): string {
	return join(getSnoProfileDir(env), "observe.log");
}
