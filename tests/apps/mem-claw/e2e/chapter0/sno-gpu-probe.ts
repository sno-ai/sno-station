import { createLlmClient } from "../../../../../packages/memory/src/model/llm-client.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveLlmEndpoint } from "../../../../../packages/memory/src/model/llm-endpoint-resolution.ts";
import {
	pickLlmRoutingConfig,
	resolveLlmRoute,
} from "../../../../../packages/memory/src/model/llm-mode-routing.ts";

for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const) {
	if (process.env[name]?.trim()) throw new Error(`${name} must be absent`);
}
const settingsPath = join(process.env.SNO_PROFILE_DIR ?? join(homedir(), ".sno"), "settings.json");
const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { mode: "rem-enhanced"; modelCalls: Parameters<typeof pickLlmRoutingConfig>[0]["modelCalls"]; snoGpu: { apiKey: string } };
if (!settings.snoGpu.apiKey.trim()) throw new Error(`snoGpu.apiKey is missing in ${settingsPath}`);

process.stderr.write("[sno-gpu-probe] 1/1 request started\n");
const routing = pickLlmRoutingConfig({ mode: settings.mode, modelCalls: settings.modelCalls });
const route = resolveLlmRoute({
	callId: "REM5",
	config: routing,
});
if ("off" in route || route.tier !== "snoRemMem" || route.transport !== "chat-completions") {
	throw new Error(`unexpected REM route: ${JSON.stringify(route)}`);
}
const client = createLlmClient({
	preset: "mem_claw/sno_extract_chat",
	routing,
	timeoutMs: 60_000,
});
const resolved = await client.getResolvedConfig();
const endpoint = await resolveLlmEndpoint({
	configuredPreset: "mem_claw/sno_extract_chat",
	callId: "REM5",
	transport: "chat-completions",
});
const body = await client.completeJson<Record<string, unknown>>({
	callId: "REM5",
	maxTokens: 64,
	prompt: 'Return JSON only: {"chapter0":"ready"}.',
});
const usage = client.getLastUsage();
if (!body || Object.keys(body).length === 0) throw new Error("Sno GPU returned no parsed body");
if (!usage || usage.inputTokens <= 0 || usage.outputTokens <= 0) {
	throw new Error("Sno GPU returned no positive provider usage");
}
process.stdout.write(
	`${JSON.stringify({
	body,
	endpoint: endpoint.url,
	model: resolved.model,
	preset: resolved.preset,
	provider: resolved.provider,
		temperatureConfigured: false,
		usage,
	})}\n`,
);
process.stderr.write("[sno-gpu-probe] 1/1 request completed\n");
