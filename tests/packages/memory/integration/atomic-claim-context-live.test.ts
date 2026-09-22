/** Real shipping extraction prompt against the real model: a record must stand alone and keep the
 * field a reply fills in. Measured 2026-09-19 on the LoCoMo store: "The song is by Tupac and Dr.
 * Dre" stored without Calvin, Jon's advice line stored as nothing, Tim's "Harry Potter" answer
 * stored without the piano question it answered. */
import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveLlmEndpoint } from "../../../../packages/memory/src/model/llm-endpoint-resolution";
import { buildAtomicGenericExtractionPrompt, createAtomicGenericExtractionTransport } from "../../../../packages/memory/src/engine/extraction/atomic-generic-extractor";
import { parseAtomicExtractionReply } from "../../../../packages/memory/src/engine/extraction/atomic-extraction-reply";
import { createLlmClient } from "../../../../packages/memory/src/model/llm-client";
import { ATOMIC_EXTRACTION_SKILL_HASH } from "../../../../packages/memory/src/engine/extraction/atomic-extraction-skill";

const cases = [
	{
		name: "a split record names its referent and keeps a past habit",
		anchor: "2023-09-22T20:57:00Z",
		turns: [
			"Dave: Ha, that sounds fun! Any song that stands out?",
			"Calvin: Yeah, there's this one song that always makes me smile. It played during a road trip with my dad and we had so much fun singing along to it.",
			"Dave: Cool! Which song was it?",
			"Calvin: We used to rock a song by Tupac and Dr. Dre called \"California Love\". Ah, those were the days!",
		],
		expected: [/Calvin.*Tupac|Tupac.*Calvin/u, /used to.*California Love|California Love.*used to/iu],
	},
	{
		name: "a listener's advice is that listener's claim",
		anchor: "2023-02-01T00:48:00Z",
		turns: [
			"Gina: I'm sure with my hard work and effort, I can make a special shopping experience for my customers.",
			"Jon: That's a great goal! Creating a special experience for customers is the key to making them feel welcome and coming back. I think you can create that space you're imagining.",
		],
		expected: [/^Jon.*special.*experience.*(welcome|coming back)/u],
	},
	{
		name: "an answer keeps the field its question asked about",
		anchor: "2023-08-21T16:29:00Z",
		turns: [
			"John: That's awesome, Tim! What do you like to play?",
			"Tim: Thanks! I love playing different songs on the piano, but my favorite one to jam to is a theme from a movie I really enjoy. It brings back lots of great memories.",
			"John: Which movie?",
			"Tim: Yeah, \"Harry Potter and the Philosopher's Stone\" is special to me. It was the first movie from the series and brings back some great memories. Watching it with my family was amazing. It was so magical!",
		],
		expected: [/Tim.*(piano|jam|play).*Harry Potter/u],
	},
] as const;

describe("real model keeps each claim readable on its own", () => {
	it.each(cases)("$name", async ({ name, anchor, turns, expected }) => {
		const apiKey = process.env.SNO_MEM_CLAW_LLM_INTERNAL_KEY;
		if (!apiKey) throw new Error("SNO_MEM_CLAW_LLM_INTERNAL_KEY is required");
		const client = createLlmClient({ preset: "mem_claw/sno_extract_chat", apiKey, timeoutMs: 120_000 });
		const endpoint = await resolveLlmEndpoint({ configuredPreset: "mem_claw/sno_extract_chat", occasion: "memoryExtract", transport: "chat-completions" });
		const transport = createAtomicGenericExtractionTransport(client);
		const promptTurns = turns.map((content) => ({ role: "user" as const, content }));
		for (let repeat = 0; repeat < 3; repeat += 1) {
			const completion = await transport.complete({ prompt: buildAtomicGenericExtractionPrompt(promptTurns, anchor), maxTokens: 4096 });
			if (!completion || completion.truncated) throw new Error("Missing or truncated real model reply");
			const parsed = parseAtomicExtractionReply(completion.text, promptTurns.length);
			if (!parsed.ok) throw new Error(`Invalid reply: ${completion.text}`);
			const claims = parsed.records.map((record) => record.claimText);
			process.stdout.write(JSON.stringify({ host: hostname(), model: endpoint.preset.model, endpoint: endpoint.url,
				skillHash: ATOMIC_EXTRACTION_SKILL_HASH, name, repeat, claims }) + "\n");
			for (const pattern of expected) expect(claims.some((claim) => pattern.test(claim)), `${pattern} in ${JSON.stringify(claims)}`).toBe(true);
			// The skill's worked examples are shapes; measured 2026-09-19, a named example (a film, a
			// piano) was copied into an unrelated window as a fact.
			expect(claims.filter((claim) => /Lisbon|Windward|Ada Lin|\bAlex\b|\bSam\b/u.test(claim))).toEqual([]);
		}
	}, 300_000);
});
