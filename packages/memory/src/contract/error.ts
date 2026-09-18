export const DEGRADED_REASONS: readonly [
	"sidecar-unreachable", "sidecar-unresponsive", "principal-mismatch", "store-mismatch",
	"no-agent-endpoint", "invalid-input", "timeout", "storage-unavailable", "engine-failed",
] = [
	"sidecar-unreachable", "sidecar-unresponsive", "principal-mismatch", "store-mismatch",
	"no-agent-endpoint", "invalid-input", "timeout", "storage-unavailable", "engine-failed",
];
export type DegradedReason = (typeof DEGRADED_REASONS)[number];

export class ContractError extends Error {
	readonly degraded = true;
	constructor(readonly reason: DegradedReason) {
		super(reason);
		this.name = "ContractError";
	}
}
