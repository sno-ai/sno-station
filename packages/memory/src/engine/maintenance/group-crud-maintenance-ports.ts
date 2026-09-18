/** @file group-crud-maintenance-ports.ts
 * @purpose Connects group CRUD maintenance judgements to the production model transport.
 * @boundary Prompt text comes from shipped skills; this module only renders inputs and decodes replies.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AtomicGenericExtractionTransport } from "../extraction/atomic-generic-extractor";
import {
	decodeAtomicEntityIdentityReply,
	renderAtomicEntityIdentityPrompt,
} from "../extraction/entity-identity-judgment";
import type {
	GroupCrudEntityIdentityJudgementPort,
	GroupCrudStateKeyingJudgementPort,
} from "./group-crud-maintenance";
import type { LlmClient } from "../../model/llm-client";

const STATE_KEYING_SKILL_PATH = path.join("skills", "key-state-attribute", "SKILL.md");

function readStateKeyingSkill(): string {
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	for (const root of [
		path.resolve(moduleDir, ".."),
		path.resolve(moduleDir, "../.."),
		path.resolve(moduleDir, "../../.."),
	]) {
		const candidate = path.join(root, STATE_KEYING_SKILL_PATH);
		if (existsSync(candidate)) return readFileSync(candidate, "utf8");
	}
	throw new Error(`sno-station-mem state keying skill is missing: ${STATE_KEYING_SKILL_PATH}`);
}

export function createModelGroupCrudEntityIdentityJudgementPort(
	transport: AtomicGenericExtractionTransport,
): GroupCrudEntityIdentityJudgementPort {
	return {
		async respond({ displayName, existingDisplayNames }) {
			const completion = await transport.complete({
				prompt: renderAtomicEntityIdentityPrompt({
					displayName,
					existingEntities: existingDisplayNames,
				}),
				maxTokens: 64,
			});
			if (completion === null) throw new Error("Entity identity judgement returned no response");
			if (completion.truncated) return { decision: "undecided" };
			const answer = decodeAtomicEntityIdentityReply(completion.text);
			if (answer === "new") return { decision: "new" };
			if (answer === undefined) return { decision: "undecided" };
			return existingDisplayNames.some(({ entityId }) => entityId === answer)
				? { decision: "existing", entityId: answer }
				: { decision: "undecided" };
		},
	};
}

export function decodeGroupCrudStateKeyingReply(
	reply: string | null,
	offeredSlugs: readonly string[],
): string | null {
	if (reply === null) return null;
	const answer = reply.trim();
	return offeredSlugs.includes(answer) ? answer : null;
}

export function createModelGroupCrudStateKeyingJudgementPort(
	client: LlmClient,
): GroupCrudStateKeyingJudgementPort {
	return {
		async respond({ text, offeredSlugs }) {
			const prompt = [
				readStateKeyingSkill(),
				JSON.stringify({ row_text: text, offered_slugs: offeredSlugs }),
			].join("\n\n");
			const reply = await client.completeText({
				prompt,
				callLabel: "memory-extract-atomic-generic",
				adapterSlot: "memory-extract",
				maxTokens: 64,
				emptyReplyAttempts: 1,
				enableThinking: false,
			});
			if (reply === null && client.getLastError() !== null) {
				throw new Error(client.getLastError() ?? "State keying judgement failed");
			}
			return decodeGroupCrudStateKeyingReply(reply, offeredSlugs);
		},
	};
}
