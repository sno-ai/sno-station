import { ContractError, type Mutation } from "@snoai/memory/client";
import { readRecallSettings } from "./settings.js";
import { isDegradedConnection, connectMemory } from "./memory-client.js";
import { manualScope, workspaceRoot } from "./scope.js";

export interface CommandResult {
	ok: boolean;
	text: string;
}

async function context(): Promise<
	| { ok: true; client: Exclude<Awaited<ReturnType<typeof connectMemory>>, { degraded: true }>; project: string; recallLimit: number }
	| { ok: false; reason: string }
> {
	let recallLimit: number;
	try { recallLimit = readRecallSettings().explicitLimit; }
	catch (error) { return { ok: false, reason: error instanceof Error ? error.message : "engine-failed" }; }
	const project = await workspaceRoot(process.cwd());
	const client = await connectMemory();
	if (isDegradedConnection(client)) return { ok: false, reason: client.error ?? client.reason };
	return { ok: true, client, project, recallLimit };
}

export async function recallCommand(query: string): Promise<CommandResult> {
	if (!query.trim()) return { ok: false, text: "invalid-input" };
	const current = await context();
	if (!current.ok) return { ok: false, text: current.reason };
	const recalled = await current.client.getRecall(query, manualScope(current.project), {
		source: "manual",
		limit: current.recallLimit,
		includeMetadata: true,
	});
	if (recalled.degraded) return { ok: false, text: recalled.error ?? recalled.reason };
	if (recalled.toolResult?.isError) {
		const reason = recalled.toolResult.content.map(item => item.text).join("\n");
		return { ok: false, text: reason || "engine-failed" };
	}
	return recalled.contextText
		? { ok: true, text: recalled.contextText }
		: { ok: false, text: "engine-failed" };
}

export async function getCommand(id: string): Promise<CommandResult> {
	if (!id.trim()) return { ok: false, text: "invalid-input" };
	const current = await context();
	if (!current.ok) return { ok: false, text: current.reason };
	const inspected = await current.client.inspect({ op: "get", id }, manualScope(current.project));
	if (inspected.degraded) return { ok: false, text: inspected.error ?? inspected.reason };
	if (inspected.result.op !== "get" || !inspected.result.entry) return { ok: false, text: "not-found" };
	const entry = inspected.result.entry;
	return { ok: true, text: `${entry.id}\n${entry.text}` };
}

async function mutateCommand(op: Mutation): Promise<CommandResult> {
	const current = await context();
	if (!current.ok) return { ok: false, text: current.reason };
	try {
		const mutated = await current.client.mutate(op, manualScope(current.project));
		if (mutated.degraded) return { ok: false, text: mutated.error ?? mutated.reason };
		if (mutated.result.isError) {
			const text = mutated.result.content.map(item => item.text).join("\n");
			const reason = mutated.result.details["errorCode"];
			return { ok: false, text: text || (typeof reason === "string" ? reason : "engine-failed") };
		}
		const id = mutated.result.details["id"];
		return typeof id === "string" && id.length > 0
			? { ok: true, text: id }
			: { ok: false, text: "engine-failed" };
	} catch (error) {
		if (error instanceof ContractError) return { ok: false, text: error.message };
		throw error;
	}
}

export async function rememberCommand(content: string): Promise<CommandResult> {
	if (!content.trim()) return { ok: false, text: "invalid-input" };
	return mutateCommand({ op: "store", content, category: "episodic" });
}

export async function correctCommand(id: string, content: string): Promise<CommandResult> {
	if (!id.trim() || !content.trim()) return { ok: false, text: "invalid-input" };
	return mutateCommand({ op: "correct", id, content });
}
