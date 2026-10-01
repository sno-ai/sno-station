export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type CommandOptions = {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	forwardStderr?: boolean;
	input?: string;
	timeoutMs?: number;
};

export type CommandResult = {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
};

export type HttpResult = {
	statusCode: number;
	body: unknown;
	text: string;
	headers: Record<string, string | string[] | undefined>;
};

export type TestConfig = {
	artifactDir: string;
	gatewayModel: string;
	gatewayTimeoutMs: number;
	gatewayUrl: string;
	observeBaseUrl: string;
	observePollMs: number;
	observeTimeoutMs: number;
	openClawHost: string;
	openClawProfile: string;
	openClawToken: string;
	openClawVm: string;
	rejectUnauthorized: boolean;
	remoteAuditPath: string;
	remoteDbPath: string;
	remoteIdentityPath: string;
	remoteStateDir: string;
};

export type GatewayTurn = {
	body: unknown;
	text: string;
	usage: JsonObject;
};

export type GatewayUsageSummary = {
	completionTokens: number;
	promptTokens: number;
};

export const expectedEventTypes = [
	"agent.identify",
	"session.start",
	"prompt.submit",
	"llm.call",
	"tool.call",
	"memory.write",
	"memory.read",
	"error",
	"cost.summary",
	"memory.snapshot",
	"session.end",
] as const;

export type ExpectedEventType = (typeof expectedEventTypes)[number];

export type EventSummary = {
	agentCliVersion?: string;
	agentPluginVersion?: string;
	byteLen?: number;
	contentTokens?: number;
	errorKind?: string;
	eventId: string;
	eventType: ExpectedEventType;
	hitCount?: number;
	hostAgentCompletionTokens?: number;
	hostAgentPromptTokens?: number;
	keyHash?: string;
	localMemoryInputTokens?: number;
	localMemoryOutputTokens?: number;
	llmCompletionTokens?: number;
	llmModel?: string;
	llmPreset?: string;
	llmPromptTokens?: number;
	llmProvider?: string;
	llmResolvedModel?: string;
	payloadSessionUuid?: string;
	pluginInternalCompletionTokens?: number;
	pluginInternalPromptTokens?: number;
	promptHash?: string;
	queryHash?: string;
	queryTokens?: number;
	resultTokens?: number;
	scopeProjectId?: string;
	scopeSessionUuid?: string;
	snapshotReason?: string;
	tokenSource?: string;
	tokensMethod?: string;
	tokensIn?: number;
	tokensOut?: number;
	toolName?: string;
};

export type EventCriteria = {
	machineUuid: string;
	sdkUserCuid: string;
	sessionUuids?: Set<string>;
};

export type AgentRunState = {
	artifactDir: string;
	cjkFact?: string;
	cjkNonce?: string;
	cjkRecallSession?: string;
	cjkTeachSession?: string;
	consentOffNonce?: string;
	consentOffObserveSession?: string;
	consentOffSession?: string;
	consentUserCuid?: string;
	consentOnNonce?: string;
	consentOnObserveSession?: string;
	consentOnSession?: string;
	exactCode?: string;
	exactRecallSession?: string;
	exactTeachSession?: string;
	fact: string;
	isolationSession?: string;
	isolationUserCuid?: string;
	multilingualFact?: string;
	multilingualMarker?: string;
	multilingualNonce?: string;
	multilingualRecallSession?: string;
	multilingualTeachSession?: string;
	noiseNonce?: string;
	noiseObserveSession?: string;
	noiseUserCuid?: string;
	noiseSession?: string;
	nonce: string;
	observeApiBaseUrl?: string;
	observeFirstEventId?: string;
	observeMachineUuid?: string;
	observeOriginalConsentLevel?: "off" | "metadata-only" | "full";
	observeUserCuid?: string;
	qaObserveSession?: string;
	qaGatewayUsage?: GatewayUsageSummary;
	qaSession: string;
	restartFact?: string;
	restartNonce?: string;
	restartRecallSession?: string;
	restartTeachSession?: string;
	runId: string;
	similarCorrectCode?: string;
	similarDecoyCode?: string;
	similarMarker?: string;
	similarRecallSession?: string;
	similarTeachSession?: string;
	startedAt: string;
	teachObserveSession?: string;
	teachPromptObserveSession?: string;
	teachSession: string;
	teachGatewayUsage?: GatewayUsageSummary;
	updateNewNonce?: string;
	updateOldNonce?: string;
	updateQaObserveSession?: string;
	updateQaSession?: string;
	updateSubject?: string;
	updateTeachObserveSession?: string;
	updateTeachSession?: string;
	/** OpenClaw Gateway conversation user; Sno Observe SDK events use observeUserCuid. */
	userCuid: string;
};

export class NonRetryableEvidenceError extends Error {}
