import { z } from "zod";
import { inputSchemas, type ContractInputs, type ScopeCtx, type Registration, type RecallOptions,
	type Turn, type Mutation, type Inspection, type UsageSignal, type Message } from "./inputs";
import { outputSchemas, type ContractOutputs } from "./results";
import { ContractError } from "./error";

export * from "./inputs";
export * from "./results";
export * from "./settings";
export * from "./error";
export * from "./routes";

export type ContractMethod = keyof ContractInputs;
export interface MemoryContract {
	init(scope: ScopeCtx, registration: Registration): Promise<ContractOutputs["init"]>;
	getRecall(query: string, scope: ScopeCtx, options: RecallOptions): Promise<ContractOutputs["getRecall"]>;
	capture(turn: Turn, scope: ScopeCtx): Promise<ContractOutputs["capture"]>;
	mutate(op: Mutation, scope: ScopeCtx): Promise<ContractOutputs["mutate"]>;
	inspect(op: Inspection, scope: ScopeCtx): Promise<ContractOutputs["inspect"]>;
	recordUsage(recallId: string, signal: UsageSignal, scope: ScopeCtx): Promise<ContractOutputs["recordUsage"]>;
	onSessionEnd(messages: Message[], scope: ScopeCtx): Promise<ContractOutputs["onSessionEnd"]>;
	staticBlock(scope: ScopeCtx): Promise<ContractOutputs["staticBlock"]>;
}

export function parseInput<K extends ContractMethod>(method: K, input: unknown): ContractInputs[K] {
	const parsed = inputSchemas[method].safeParse(input);
	if (!parsed.success) throw new ContractError("invalid-input");
	return parsed.data;
}

export function parseOutput<K extends ContractMethod>(method: K, output: unknown): ContractOutputs[K] {
	const parsed = outputSchemas[method].safeParse(output);
	if (!parsed.success) throw new ContractError("engine-failed");
	return parsed.data;
}

export function contractJsonSchemas(method: ContractMethod): {
	input: z.core.JSONSchema.JSONSchema;
	output: z.core.JSONSchema.JSONSchema;
} {
	return {
		input: z.toJSONSchema(inputSchemas[method], { io: "input" }),
		output: z.toJSONSchema(outputSchemas[method]),
	};
}
