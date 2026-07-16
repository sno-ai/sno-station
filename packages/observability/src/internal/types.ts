export const SDK_VERSION = "0.1.0";

export const AGENT_IDS = ["openclaw", "hermes", "claude-code", "codex"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const CONSENT_VALUES = ["off", "metadata-only", "full"] as const;
export type ConsentValue = (typeof CONSENT_VALUES)[number];

export const EVENT_TYPES = [
	"agent.identify",
	"memory.write",
	"memory.read",
	"memory.snapshot",
	"memory.telemetry",
	"llm.call",
	"tool.call",
	"session.start",
	"session.end",
	"prompt.submit",
	"permission.request",
	"consent.change",
	"error",
	"cost.summary",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_LANES = ["memory", "llm", "skill", "security"] as const;
export type EventLane = (typeof EVENT_LANES)[number];

export type ExportFormat = "tarball" | "jsonl" | "csv";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface Identity {
	version: 1;
	user_cuid: string;
	machine_uuid: string;
	machine_secret: string;
	created_at: string;
	default_project_id?: string | null;
	user_account_id?: string | null;
}

export interface EventScope extends JsonObject {
	user_id: string;
	machine_id: string;
	agent_id: AgentId;
	project_id?: string;
	user_account_id?: string;
}

export interface HashChain {
	prev: string;
	self: string;
}

export interface WireEnvelope {
	schema_version: "v1";
	event_id: string;
	event_type: EventType;
	lane: EventLane;
	ts_edge_ms: number;
	consent_level: ConsentValue;
	redacted: boolean;
	chain_epoch: number;
	seq: number;
	scope: EventScope;
	hash_chain: HashChain;
	payload: JsonObject;
}

export interface ParsedEvent {
	eventId?: string;
	eventType: EventType;
	lane: EventLane;
	agentId: AgentId;
	tsEdgeMs?: number;
	consentLevel?: ConsentValue;
	scope: JsonObject;
	payload: JsonObject;
}

export interface Event {
	event_id?: string;
	event_type: EventType;
	lane: EventLane;
	agent_id: AgentId;
	ts_edge_ms?: number;
	consent_level?: ConsentValue;
	scope?: JsonObject;
	payload: JsonObject;
}

export interface EmitResult {
	accepted: boolean;
	eventId: string;
	reason?: "buffer_safeguard" | "chain_retired" | "consent_off" | "tool_unsampled";
	rowid?: number;
	seq?: number;
	chainEpoch?: number;
}

export interface SubscribeEvent {
	eventId: string;
	eventType: EventType;
	accepted: boolean;
	reason?: EmitResult["reason"];
}

export type Subscription = (event: SubscribeEvent) => void;

export type DoctorCheckName = "identity" | "buffer" | "consent" | "last_ship" | "lockfile";
export type DoctorCheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
	name: DoctorCheckName;
	status: DoctorCheckStatus;
	detail: string;
	path?: string;
}

export type DoctorReport = Record<DoctorCheckName, DoctorCheck>;

export interface AuditVerifyResult {
	verified: boolean;
	gdpr_scrubbed?: boolean;
	anchor_id?: string;
	signing_key_id?: string;
	merkle_path?: string[];
	computed_root?: string;
	stored_root?: string;
}

export interface ShutdownResult {
	flushedCount: number;
	failedCount: number;
	lastError?: string;
}

export interface ExportResult {
	format: ExportFormat;
	path?: string;
	rowCount: number;
	bytes: number;
	data?: string | Uint8Array;
	tarballSha256?: string;
}
