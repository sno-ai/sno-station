import { z } from "zod";
import { recallLifecycleSchema } from "../../config/index";
import { embeddingConfigSchema } from "../../config/plugin-config-embedding-schema";
import {
	extractionConfigSchema,
	memoryReflectionConfigSchema,
	selfImprovementConfigSchema,
	sessionMemoryConfigSchema,
} from "../../config/plugin-config-feature-schema";
import type { LlmRoutingConfig } from "../../config/plugin-config-mode-schema";
import { observeConfigSchema } from "../../config/plugin-config-observe-schema";
import { retrievalConfigSchema } from "../../config/plugin-config-retrieval-schema";
import type { PluginConfig } from "../../config/plugin-config-schema";
import { SESSION_STRATEGIES } from "../../config/session-strategy";

export type EngineSettings = Omit<PluginConfig, keyof LlmRoutingConfig>;

export const engineSettingsSchema: z.ZodType<EngineSettings, unknown> = z.object({
	embedding: embeddingConfigSchema,
	observe: observeConfigSchema,
	dbPath: z.string().optional(),
	provider: z.object({ userId: z.string().trim().optional() }),
	ambientLearning: z.boolean(),
	autoRecall: z.boolean(),
	autoRecallMinLength: z.number().int().min(1).max(200),
	autoRecallMinRepeated: z.number().int().min(0).max(100),
	autoRecallMaxQueryLength: z.number().int().min(100).max(10000),
	autoRecallTimeoutMs: z.number().int().min(500).max(60000),
	autoRecallIncludeAgents: z.array(z.string()),
	autoRecallExcludeAgents: z.array(z.string()),
	captureAssistant: z.boolean(),
	retrieval: retrievalConfigSchema,
	scopes: z.object({
		default: z.string(),
		definitions: z.record(z.string(), z.object({
			description: z.string().optional(),
			metadata: z.record(z.string(), z.json()).optional(),
		})),
		agentAccess: z.record(z.string(), z.array(z.string())),
	}),
	enableManagementTools: z.boolean(),
	sessionStrategy: z.enum(SESSION_STRATEGIES),
	sessionMemory: sessionMemoryConfigSchema,
	compression: z.object({ enabled: z.boolean() }).optional(),
	selfImprovement: selfImprovementConfigSchema,
	extraction: extractionConfigSchema,
	memoryReflection: memoryReflectionConfigSchema,
	recallLifecycle: recallLifecycleSchema,
	memoryTelemetry: z.object({ enabled: z.boolean(), currentKeyVersion: z.number().int().positive() }),
	remOperations: z.array(z.enum(["rem-replace", "rem-update"])).min(1).max(2),
	onboarding: z.object({
		version: z.number().int().positive(),
		completedAt: z.string(),
		profile: z.enum(["local-active", "capture-only", "manual-only", "custom"]),
	}).optional(),
});
