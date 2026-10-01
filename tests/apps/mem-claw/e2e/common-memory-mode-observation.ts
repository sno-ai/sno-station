import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createLlmClient } from "../../../../packages/memory/src/model/llm-client";
import type { ModelCallId } from "../../../../packages/memory/src/model/model-call-table";
import { extractionConfigSchema } from "../../../../packages/memory/config/plugin-config-feature-schema";
import {
	LLM_OCCASIONS,
	PRODUCT_MODES,
	llmRoutingConfigSchema,
	type LlmOccasion,
} from "../../../../packages/memory/config/plugin-config-mode-schema";
import { loadConfig } from "../e2e-agent/helpers/config";
import { sendGatewayTurn } from "../e2e-agent/helpers/http";

const calls = {
	memoryExtract: "E1",
	profileSectionMerge: "P4",
	profileActiveTaskClassify: "T1",
	conflictAdjudication: "P1",
	summaryBuild: "R1",
	dateResolution: "E11",
} satisfies Record<LlmOccasion, ModelCallId>;
// Local-first keeps only the profile section calls on the host model.
const localFirstHostOccasions: readonly LlmOccasion[] = ["profileSectionMerge"];

const configurationSchema = z.object({
	plugins: z.object({
		entries: z.object({
			"sno-mem-claw": z.object({
				config: z.object({
					mode: z.enum(PRODUCT_MODES),
					remEnhanced: z.unknown().optional(),
					language: z.unknown().optional(),
					extraction: z.unknown().optional(),
				}),
			}),
		}),
	}),
});

const { values } = parseArgs({
	options: {
		config: { type: "string", multiple: true },
		output: { type: "string" },
		baseline: { type: "string" },
		preflight: { type: "string" },
		"validate-only": { type: "boolean", default: false },
	},
});
assert.equal(values.config?.length, PRODUCT_MODES.length, "three real configuration paths required");
assert.ok(values.output, "--output is required");
const configurations = await Promise.all(
	(values.config ?? []).map(async (path) => {
		const raw = await readFile(path, "utf8");
		const config = configurationSchema.parse(JSON.parse(raw)).plugins.entries["sno-mem-claw"].config;
		// remEnhanced carries only the REM trigger, which is installed settings, not routing.
		const { extraction, remEnhanced: _remEnhanced, ...routingInput } = config;
		return { path, sha256: createHash("sha256").update(raw).digest("hex"), routing: llmRoutingConfigSchema.parse(routingInput), llm: extractionConfigSchema.parse(extraction).llm };
	}),
);
assert.deepEqual(configurations.map(({ routing }) => routing.mode).sort(), [...PRODUCT_MODES].sort());
assert.deepEqual(Object.keys(calls).sort(), [...LLM_OCCASIONS].sort());

if (!values["validate-only"]) {
	assert.ok(values.preflight, "--preflight is required for live calls");
	assert.ok(values.baseline, "--baseline is required for post-cutover comparison");
	const preflight = z.object({
		sha256: z.string(),
		checks: z.array(z.object({ id: z.string(), verdict: z.literal("green") })).min(3),
	}).passthrough().parse(JSON.parse(await readFile(values.preflight, "utf8")));
	const preflightHash = preflight.sha256;
	const preflightFileSha256 = createHash("sha256").update(await readFile(values.preflight)).digest("hex");
	const gateway = { ...await loadConfig(), gatewayTimeoutMs: 60_000 };
	let failed = 0;
	const outputPath = values.output;
	const rows: Array<{ mode: string; occasion: string; transport: string; endpoints: string[] }> = [];
	await writeFile(outputPath, "", { flag: "wx" });
	await appendFile(outputPath, `${JSON.stringify({ callsign: "zebra", kind: "start", host: hostname(), node: process.version, preflight: values.preflight, preflightHash, preflightFileSha256, configurations: configurations.map(({ path, sha256, routing }) => ({ path, sha256, mode: routing.mode })) })}\n`);
	for (const { routing, path, llm } of configurations) {
		for (const occasion of LLM_OCCASIONS) {
			const callId = calls[occasion];
			const endpoints = new Set<string>();
			const attempts: string[] = [];
			let outgoingRequests = 0;
			const originalFetch = globalThis.fetch;
			// Observe requests while preserving the real transport and its response.
			globalThis.fetch = async (input, init) => {
				outgoingRequests += 1;
				const url = new URL(input instanceof Request ? input.url : input.toString());
				if (/\/(?:chat\/)?completions$/.test(url.pathname)) endpoints.add(`${url.origin}${url.pathname}`);
				return originalFetch(input, init);
			};
			try {
				const client = createLlmClient({
					...llm,
					routing,
					timeoutMs: 60_000,
					onTransportAttempt: ({ transport }) => attempts.push(transport),
					agentPort: {
						async complete(request) {
							endpoints.add(`${gateway.gatewayUrl}/v1/responses`);
							const result = await sendGatewayTurn(gateway, `zebra-mode-${randomUUID()}`, {
								input: [request.system, request.prompt].filter(Boolean).join("\n\n"),
								model: gateway.gatewayModel,
								stream: false,
							});
							return { kind: "ok", text: result.text };
						},
					},
				});
				const result = await client.completeText({
					callId,
					prompt: occasion === "conflictAdjudication"
						? "Older memory: User prefers concise replies. Newer memory: User prefers concise replies. Return exactly keep."
						: 'Return JSON only: {"ready":true}.',
					maxTokens: 128,
					timeoutMs: 60_000,
					emptyReplyAttempts: 1,
				});
				if (routing.mode === "local-first" && !localFirstHostOccasions.includes(occasion)) {
					assert.equal(result, null, "local-first must not call a model");
					assert.equal(attempts.length, 0);
					assert.equal(endpoints.size, 0);
					assert.equal(outgoingRequests, 0, "local-first issued an HTTP request");
				} else {
					assert.ok(result?.trim(), `${routing.mode}/${occasion}: no model response`);
					assert.ok(attempts.length > 0, "no transport observed");
					const gpu = routing.mode === "rem-enhanced" && ["memoryExtract", "conflictAdjudication"].includes(occasion);
					assert.deepEqual(attempts, [gpu ? (occasion === "conflictAdjudication" ? "raw-completions" : "chat-completions") : "agent-host-seam"], "default mode transport sequence changed");
					assert.ok(endpoints.size > 0, "no endpoint observed");
				}
				const row = { mode: routing.mode, occasion, transport: attempts.at(-1) ?? "off", endpoints: [...endpoints].sort() };
				rows.push(row);
				await appendFile(outputPath, `${JSON.stringify({ ...row, kind: "cell", attempts, verdict: "green", configuration: path, callId, outputSha256: createHash("sha256").update(result ?? "").digest("hex") })}\n`);
				process.stderr.write(`zebra modes ${rows.length}/${PRODUCT_MODES.length * LLM_OCCASIONS.length}: ${routing.mode}/${occasion}\n`);
			} catch (error) {
				failed += 1;
				const row = { mode: routing.mode, occasion, transport: attempts.at(-1) ?? "off", endpoints: [...endpoints].sort() };
				rows.push(row);
				await appendFile(outputPath, `${JSON.stringify({ ...row, kind: "cell", attempts, verdict: "red", configuration: path, callId, error: error instanceof Error ? error.message : String(error) })}\n`);
				process.stderr.write(`zebra modes ${rows.length}/${PRODUCT_MODES.length * LLM_OCCASIONS.length} RED: ${routing.mode}/${occasion}\n`);
			} finally {
				globalThis.fetch = originalFetch;
			}
		}
	}
	if (values.baseline) {
		const lines = (await readFile(values.baseline, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		const complete = lines.find((line) => line.kind === "complete");
		assert.ok(complete, "baseline did not complete");
		try {
			assert.deepEqual(rows, complete.rows, "observed routing changed");
		} catch {
			failed += 1;
			await appendFile(outputPath, `${JSON.stringify({ kind: "routing-comparison", verdict: "red" })}\n`);
		}
	}
	await appendFile(outputPath, `${JSON.stringify({ kind: "complete", rows, failed, verdict: failed ? "red" : "green", boundary: "GPT1 core resolver with VM gateway agent port; does not prove installed loopback callback" })}\n`);
	if (failed) process.exitCode = 1;
}
