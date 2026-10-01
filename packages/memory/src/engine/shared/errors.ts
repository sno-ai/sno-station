/** @file errors.ts
 * @purpose Defines typed plugin errors and stable codes for callers and CLI output.
 * @boundary Runtime boundaries, CLI error mapping, and test assertions.
 * @see memory-management-cli.ts, sno-station-mem-plugin-runtime.ts, memory-tool-registration.ts.
 */

export class SnoStationMemError extends Error {
	public readonly code: string;

	/**
	 * Initializes typed error reporting collaborators while keeping runtime work in explicit
	 * methods.
	 */
	constructor(code: string, message: string, cause?: unknown) {
		// This operational safety step establishes state that later reads and cleanup paths depend on.
		super(message, cause ? { cause } : undefined);
		// This operational safety step establishes state that later reads and cleanup paths depend on.
		this.name = "SnoStationMemError";
		// This operational safety step establishes state that later reads and cleanup paths depend on.
		this.code = code;
	}
}
export class StorageError extends SnoStationMemError {
	/**
	 * Initializes typed error reporting collaborators while keeping runtime work in explicit
	 * methods.
	 */
	constructor(message: string, cause?: unknown) {
		// This operational safety step establishes state that later reads and cleanup paths depend on.
		super("storage_error", message, cause);
		// This operational safety step establishes state that later reads and cleanup paths depend on.
		this.name = "StorageError";
	}
}
export class EmbeddingError extends SnoStationMemError {
	/**
	 * Initializes typed error reporting collaborators while keeping runtime work in explicit
	 * methods.
	 */
	constructor(message: string, cause?: unknown) {
		// This operational safety step establishes state that later reads and cleanup paths depend on.
		super("embedding_error", message, cause);
		this.name = "EmbeddingError";
	}
}
export class RetrievalError extends SnoStationMemError {
	/**
	 * Carries the cause's own message in `message`, not only in `cause`.
	 *
	 * Retrieval wraps every failure as "Failed to retrieve memories", and every consumer that
	 * reports one — a tool result, an eval harness, an HTTP boundary — reports `message` and drops
	 * the Error. Measured 2026-09-04: a whole evaluation round scored nothing and the only trace
	 * on disk was fifteen identical copies of that sentence, so the reason had to be re-derived by
	 * reproducing the run. The cause stays attached as well; this only makes it survive the trip.
	 */
	constructor(message: string, cause?: unknown) {
		const reason = cause instanceof Error ? cause.message : undefined;
		super("retrieval_error", reason ? `${message}: ${reason}` : message, cause);
		this.name = "RetrievalError";
	}
}
export class ConfigError extends SnoStationMemError {
	/**
	 * Initializes typed error reporting collaborators while keeping runtime work in explicit
	 * methods.
	 */
	constructor(message: string, cause?: unknown) {
		super("config_error", message, cause);
		this.name = "ConfigError";
	}
}
