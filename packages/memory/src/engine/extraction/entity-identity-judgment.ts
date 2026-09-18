/** @file entity-identity-judgment.ts
 * @purpose Resolves unseen entity names through the shipped identity judgment skill.
 * @boundary The model judges; this module selects candidates, validates, journals, and applies.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AtomicGenericExtractionTransport } from "./atomic-generic-extractor";
import { readModelReplyJson } from "../shared/model-reply-text";
import type {
	AtomicMemoryEntityRegistration,
	AtomicMemoryEntityResolution,
} from "../../store/memory-store-base";
import {
	type AtomicEntityIdentityStore,
	listAtomicMemoryEntityCandidates,
	recordAtomicEntityIdentityJournal,
} from "../../store/memory-store-atomic-entity-api";
import { randomUUID } from "../../store/memory-store-shared";

const SKILL_PATH = path.join("skills", "resolve-entity-identity", "SKILL.md");
const responseSchema = z.object({ entity_id: z.string().min(1) }).strict();

function readIdentitySkill(): string {
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	for (const root of [
		path.resolve(moduleDir, ".."),
		path.resolve(moduleDir, "../.."),
		path.resolve(moduleDir, "../../.."),
	]) {
		const candidate = path.join(root, SKILL_PATH);
		if (existsSync(candidate)) return readFileSync(candidate, "utf8");
	}
	throw new Error(`sno-station-mem entity identity skill is missing: ${SKILL_PATH}`);
}

export function decodeAtomicEntityIdentityReply(reply: string): string | undefined {
	return readModelReplyJson(reply, (value) => {
		const parsed = responseSchema.safeParse(value);
		return parsed.success ? parsed.data.entity_id : undefined;
	});
}

export function renderAtomicEntityIdentityPrompt(input: {
	displayName: string;
	existingEntities: ReadonlyArray<{ entityId: string; displayName: string }>;
}): string {
	return [
		readIdentitySkill(),
		JSON.stringify({
			new_display_name: input.displayName,
			existing_entities: input.existingEntities.map(({ entityId, displayName }) => ({
				entity_id: entityId,
				display_name: displayName,
			})),
		}),
	].join("\n\n");
}

function journalDetail(
	projectId: string,
	fallback: AtomicMemoryEntityRegistration,
	offeredEntityIds: readonly string[],
): Parameters<typeof recordAtomicEntityIdentityJournal>[1]["detail"] {
	return {
		project_id: projectId,
		display_name: fallback.displayName,
		normalized_name: fallback.normalizedName,
		entity_id: fallback.entityId,
		offered_entity_ids: offeredEntityIds,
	};
}

export async function resolveAtomicEntityIdentity(input: {
	store: AtomicEntityIdentityStore;
	projectId: string;
	displayName: string;
	jobId: string;
	nowMs: number;
	transport: AtomicGenericExtractionTransport;
}): Promise<AtomicMemoryEntityResolution & { isNew?: true; mergeId?: string }> {
	const current = input.store.resolveAtomicMemoryEntity(input.projectId, input.displayName);
	if (!current.registration) return current;
	const fallback = current.registration;
	let offeredEntityIds: string[] = [];
	let completion: Awaited<ReturnType<AtomicGenericExtractionTransport["complete"]>>;
	try {
		const candidates = await listAtomicMemoryEntityCandidates(
			input.store,
			input.projectId,
			fallback.displayName,
		);
		offeredEntityIds = [...new Set(candidates.map((candidate) => candidate.entityId))];
		completion = await input.transport.complete({
			prompt: renderAtomicEntityIdentityPrompt({
				displayName: fallback.displayName,
				existingEntities: candidates,
			}),
			maxTokens: 64,
		});
	} catch (error) {
		recordAtomicEntityIdentityJournal(input.store.sqlite, {
			jobId: input.jobId,
			outcome: "failed",
			reason: error instanceof Error ? error.message : String(error),
			detail: journalDetail(input.projectId, fallback, offeredEntityIds),
		});
		// A failed judgment keeps the prior behavior: mint the deterministic slug identity.
		return current;
	}
	const answer = completion?.truncated
		? undefined
		: decodeAtomicEntityIdentityReply(completion?.text ?? "");
	if (answer === undefined) {
		recordAtomicEntityIdentityJournal(input.store.sqlite, {
			jobId: input.jobId,
			outcome: "failed",
			reason: completion?.truncated ? "model_response_truncated" : "model_response_invalid",
			detail: journalDetail(input.projectId, fallback, offeredEntityIds),
		});
		// A failed judgment keeps the prior behavior: mint the deterministic slug identity.
		return current;
	}
	if (answer === "new") {
		const entityId = `entity:${randomUUID()}`;
		// Recorded like a merge, so a store can show which names the judgement kept apart.
		recordAtomicEntityIdentityJournal(input.store.sqlite, {
			jobId: input.jobId,
			outcome: "done",
			reason: "new_entity",
			detail: journalDetail(input.projectId, { ...fallback, entityId }, offeredEntityIds),
		});
		return { entityId, isNew: true, registration: { ...fallback, entityId } };
	}
	if (!offeredEntityIds.includes(answer)) {
		recordAtomicEntityIdentityJournal(input.store.sqlite, {
			jobId: input.jobId,
			outcome: "refused",
			reason: "entity_id_not_offered",
			detail: journalDetail(input.projectId, fallback, offeredEntityIds),
		});
		// A refused judgment keeps the prior behavior: mint the deterministic slug identity.
		return current;
	}
	const mergeId = randomUUID();
	recordAtomicEntityIdentityJournal(input.store.sqlite, {
		jobId: input.jobId,
		outcome: "done",
		detail: {
			project_id: input.projectId,
			display_name: fallback.displayName,
			normalized_name: fallback.normalizedName,
			entity_id: answer,
			merge_id: mergeId,
			offered_entity_ids: offeredEntityIds,
		},
	});
	return {
		entityId: answer,
		mergeId,
		registration: { ...fallback, entityId: answer },
	};
}
