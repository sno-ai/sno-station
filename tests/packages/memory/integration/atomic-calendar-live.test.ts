/** Real shipping extraction prompt and signed transport; no substitute model. */
import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import { buildAtomicGenericExtractionPrompt, createAtomicGenericExtractionTransport } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-generic-extractor";
import { parseAtomicExtractionReply } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-extraction-reply";
import { runAtomicExtractionGauntlet } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-extraction-gauntlet";
import { createLlmClient } from "../../../../packages/sno-station-mem/src/model/llm-client";
import { ATOMIC_EXTRACTION_SKILL_HASH } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-extraction-skill";

const cases = [
	{ name: "past duration", text: "I've known these friends for 4 years, since I moved from my home country.", anchor: "2023-06-09T19:55:00Z", label: "2019" },
	{ name: "weekday abbreviation", text: "I just joined a new LGBTQ activist group last Tues.", anchor: "2023-07-20T20:56:00Z", label: "2023-07-18" },
	{ name: "future offset", text: "I will move to Kyoto four years from now.", anchor: "2023-06-09T19:55:00Z", label: "2027" },
	{ name: "undated historical event", text: "I moved from my home country, but I have not said when.", anchor: "2023-06-09T19:55:00Z", label: null },
	{ name: "Chinese past duration", text: "我搬到京都已经四年了。", anchor: "2023-06-09T19:55:00Z", label: "2019" },
	{ name: "explicit source date", text: "I moved to Kyoto on March 15, 2020.", anchor: "2023-06-09T19:55:00Z", label: "2020-03-15" },
] as const;

describe("real model understands time; code calculates", () => {
	it.each(cases)("$name", async ({ name, text, anchor, label }) => {
		const apiKey = process.env.SNO_MEM_CLAW_LLM_INTERNAL_KEY;
		if (!apiKey) throw new Error("SNO_MEM_CLAW_LLM_INTERNAL_KEY is required");
		const client = createLlmClient({ preset: "mem_claw/sno_extract_chat", apiKey, timeoutMs: 90_000 });
		const config = await client.getResolvedConfig();
		const transport = createAtomicGenericExtractionTransport(client);
		const turns = [{ role: "user" as const, content: text }];
		for (let repeat = 0; repeat < 3; repeat += 1) {
			const completion = await transport.complete({ prompt: buildAtomicGenericExtractionPrompt(turns, anchor), maxTokens: 4096 });
			if (!completion || completion.truncated) throw new Error("Missing or truncated real model reply");
			const parsed = parseAtomicExtractionReply(completion.text, turns.length);
			process.stdout.write(JSON.stringify({ host: hostname(), model: config.model, endpoint: config.baseURL, name, repeat, raw: completion.text }) + "\n");
			if (!parsed.ok) throw new Error(`Invalid reply: ${completion.text}`);
			expect(parsed.records.length).toBeGreaterThan(0);
			const records = await runAtomicExtractionGauntlet({ records: parsed.records, turns, sessionDateTime: anchor, sessionTimezone: "UTC" });
			process.stdout.write(JSON.stringify({ host: hostname(), model: config.model, endpoint: config.baseURL,
				skillHash: ATOMIC_EXTRACTION_SKILL_HASH, name, repeat, records: records.map(({ claimText, time, resolvedTime }) => ({ claimText, time, resolvedTime })) }) + "\n");
			const dates = records.flatMap((record) => record.resolvedTime ? [record.resolvedTime.label] : []);
			if (label === null) expect(dates).toEqual([]);
			else {
				expect(dates).toContain(label);
				expect(dates.every((date) => date === label)).toBe(true);
			}
		}
	}, 300_000);
});
