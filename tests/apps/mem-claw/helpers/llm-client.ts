import type {
	LlmClient,
	MemoryLlmRequest,
} from "../../../../packages/memory/src/model/llm-client.ts";

type JsonCompletion = <T>(request: MemoryLlmRequest) => Promise<T | null>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readEligibleClauses(prompt: string): Array<{ value: string }> {
	const line = prompt.split("\n").find((candidate) => candidate.startsWith("Eligible clauses: "));
	if (!line) return [];
	try {
		const parsed: unknown = JSON.parse(line.slice("Eligible clauses: ".length));
		return Array.isArray(parsed)
			? parsed.filter(
					(item): item is { value: string } =>
						isRecord(item) && typeof item["value"] === "string",
				)
			: [];
	} catch {
		return [];
	}
}

/**
 * Keeps historical writer-behaviour fixtures focused on their original assertion while the
 * dedicated split suite owns the new two-call contract. Production never accepts this old shape.
 */
function adaptProfileSplitFixtures(completeJson: JsonCompletion): JsonCompletion {
	const pendingTextResponses: Record<string, unknown>[] = [];
	return async <T>(request: MemoryLlmRequest): Promise<T | null> => {
		// Legacy fixtures assume every retirement the judge named goes through; the second key
		// (model call P3, retirement recheck) did not exist when they were written, so it agrees here.
		if (request.callId === "P3") return { retire: true } as T;
		if (request.callId === "P5") {
			const fused = pendingTextResponses.shift();
			if (fused) {
				return {
					abstract: typeof fused["abstract"] === "string" ? fused["abstract"] : "Current state",
					overview:
						typeof fused["overview"] === "string" ? fused["overview"] : "- Current state",
					content: typeof fused["content"] === "string" ? fused["content"] : "",
				} as T;
			}
		}
		const response = await completeJson<unknown>(request);
		if (
			request.callId !== "P4" ||
			!isRecord(response) ||
			typeof response["action"] !== "string"
		) {
			return response as T | null;
		}
		const action = response["action"];
		const clauses = readEligibleClauses(request.prompt);
		const superseded = Array.isArray(response["superseded"])
			? response["superseded"].filter((item): item is string => typeof item === "string")
			: [];
		const indices = superseded.map((value) => {
			const index = clauses.findIndex((clause) => clause.value === value);
			return index < 0 ? clauses.length : index;
		});
		if (action === "merge") pendingTextResponses.push(response);
		return {
			verdict: action,
			retired_clause_indices: action === "merge" ? indices : [],
		} as T;
	};
}

export function createTestLlmClient(overrides: Partial<LlmClient> = {}): LlmClient {
	return {
		completeText: async () => null,
		getResolvedConfig: async () => ({
			preset: "mem_claw/sno_ai_extract",
			provider: "sno-gpu",
			model: "test",
		}),
		getLastError: () => null,
		getLastUsage: () => null,
		...overrides,
		completeJson: overrides.completeJson ?? (async () => null),
	};
}

export function createLegacyProfileTestLlmClient(
	overrides: Partial<LlmClient> = {},
): LlmClient {
	return createTestLlmClient({
		...overrides,
		completeJson: overrides.completeJson
			? adaptProfileSplitFixtures(overrides.completeJson)
			: async () => null,
	});
}
