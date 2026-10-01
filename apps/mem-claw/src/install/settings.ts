import { readFileSync } from "node:fs";
import { z } from "zod";
import { getSettingsPath } from "@snoai/memory/internal/contract/profile";
import { SUPPORTED_LOCALES } from "@snoai/memory/internal/engine/i18n/locales";
import type { Settings } from "@snoai/memory/internal/config/settings";

type PluginSettings = {
	recall: Pick<Settings["recall"], "auto" | "sessionStart" | "prompt" | "explicitLimit">;
	capture: Settings["capture"];
	memoryPackage: Settings["memoryPackage"];
	user: Pick<Settings["user"], "language">;
	telemetry: Pick<Settings["telemetry"], "observe" | "redactionRules">;
};

const schema: z.ZodType<PluginSettings> = z.object({
	recall: z.object({
		auto: z.boolean(),
		sessionStart: z.object({ limit: z.number(), maxChars: z.number(), timeoutMs: z.number() }),
		prompt: z.object({ limit: z.number(), maxChars: z.number(), timeoutMs: z.number(), minChars: z.number(), minScore: z.number() }),
		explicitLimit: z.number(),
	}),
	capture: z.object({
		assistant: z.boolean(), ambient: z.boolean(),
		sessionMemory: z.object({ enabled: z.boolean(), messageCount: z.number() }),
		sessionStrategy: z.enum(["memoryReflection", "systemSessionMemory", "none"]),
	}),
	memoryPackage: z.object({ path: z.string().min(1), node: z.string().min(1) }),
	user: z.object({ language: z.enum(SUPPORTED_LOCALES) }),
	telemetry: z.object({
		observe: z.object({ enabled: z.boolean(), baseUrl: z.string() }),
		redactionRules: z.array(z.string()),
	}),
});

export function readPluginSettings(): PluginSettings {
	const path = getSettingsPath();
	let raw: unknown;
	try { raw = JSON.parse(readFileSync(path, "utf8")); }
	catch { throw new Error(`settings unavailable: ${path}: file; run sno setup`); }
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		const field = parsed.error.issues[0]?.path.join(".") || "settings";
		throw new Error(`settings unavailable: ${path}: ${field}; run sno setup`);
	}
	return parsed.data;
}
