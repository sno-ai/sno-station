/** @file sno-station-mem-hook-types.ts
 * @purpose Names local SnoStationMem hook payload aliases that are not exported by the SDK.
 * @boundary Type aliases only; hook behavior lives in dedicated hook modules.
 */

// Local hook aliases for SDK types that are not exported by plugin-sdk.

export type PluginHookAgentContext = {
	agentId?: string;
	sessionKey?: string;
	sessionId?: string;
	sessionTimezone?: string;
	workspaceDir?: string;
	messageProvider?: string;
};
export type PluginHookBeforeAgentStartEvent = {
	prompt: string;
	messages?: unknown[];
};
export type PluginHookBeforeAgentStartResult = {
	systemPrompt?: string;
	prependContext?: string;
	modelOverride?: string;
	providerOverride?: string;
};
export type PluginHookLlmOutputEvent = {
	model?: unknown;
	provider?: unknown;
	sessionId?: unknown;
	usage?: unknown;
};
export type PluginHookAgentEndEvent = {
	messages: unknown[];
	success: boolean;
	error?: string;
	durationMs?: number;
};
export type PluginHookBeforeResetEvent = {
	sessionFile?: string;
	messages?: unknown[];
	reason?: string;
};
export type PluginHookSessionContext = {
	agentId?: string;
	sessionId: string;
};
export type PluginHookSessionEndEvent = {
	sessionId: string;
	messageCount: number;
	durationMs?: number;
};
export type PluginHookGatewayStartEvent = { port: number };
export type PluginHookGatewayContext = { port?: number };
