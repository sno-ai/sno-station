export class SnoObserveError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = new.target.name;
		this.code = code;
	}
}

export class InvalidAgentIdError extends SnoObserveError {
	constructor(agentId: string) {
		super(
			"invalid_agent_id",
			`agent_id must be one of openclaw, hermes, claude-code, codex: ${agentId}`,
		);
	}
}

export class InvalidConsentError extends SnoObserveError {
	constructor(consent: string) {
		super("invalid_consent", `consent must be off, metadata-only, or full: ${consent}`);
	}
}

export class InvalidEventTypeError extends SnoObserveError {
	constructor(eventType: string) {
		super("invalid_event_type", `event_type is not supported by sno-observe: ${eventType}`);
	}
}

export class InvalidEventPayloadError extends SnoObserveError {
	constructor(message: string) {
		super("invalid_event_payload", message);
	}
}

export class ChainSeedError extends SnoObserveError {
	constructor() {
		super("chain_seed_required", "seq=0 of a chain epoch must be agent.identify with GENESIS prev");
	}
}

export class ChainContentionError extends SnoObserveError {
	constructor() {
		super("chain_contention", "could not advance hash chain after bounded retries");
	}
}

export class ChainUnavailableError extends SnoObserveError {
	constructor(readonly state: "reseed_required" | "retired") {
		super("chain_unavailable", `chain cannot accept events while ${state}`);
	}
}

export class BufferCapacityError extends SnoObserveError {
	constructor() {
		super("buffer_capacity", "event would exceed the sender buffer capacity");
	}
}

export class TransportError extends SnoObserveError {
	constructor(message: string) {
		super("transport_error", message);
	}
}
