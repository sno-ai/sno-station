/** @file session-registry.ts
 * @purpose Maps host session identifiers to UUID-v7 values for cloud events.
 * @boundary Observability identity only; local plugin session keys are unchanged.
 */

import {
	canonicalizeUUIDv7Input,
	createUUIDv7,
	isLowercaseCanonicalUUIDv7,
} from "@snoai/common-core";

export function isUuidV7(value: string): boolean {
	return isLowercaseCanonicalUUIDv7(value);
}

export class ObserveSessionRegistry {
	private readonly mapped = new Map<string, string>();

	private normalize(runtimeSessionId: string | undefined): string | undefined {
		const normalized = runtimeSessionId?.trim();
		if (!normalized) return undefined;
		return canonicalizeUUIDv7Input(normalized) ?? normalized;
	}

	resolve(runtimeSessionId: string | undefined): string {
		const normalized = this.normalize(runtimeSessionId);
		if (!normalized) return createUUIDv7();
		const existing = this.mapped.get(normalized);
		if (existing) return existing;
		if (isUuidV7(normalized)) return normalized;
		const created = createUUIDv7();
		this.mapped.set(normalized, created);
		return created;
	}

	lookup(runtimeSessionId: string | undefined): string | undefined {
		const normalized = this.normalize(runtimeSessionId);
		if (!normalized) return undefined;
		const existing = this.mapped.get(normalized);
		if (existing) return existing;
		if (isUuidV7(normalized)) return normalized;
		return undefined;
	}

	link(runtimeSessionId: string | undefined, sessionUuid: string): void {
		const normalized = this.normalize(runtimeSessionId);
		if (!normalized) return;
		if (normalized === sessionUuid) {
			this.mapped.delete(normalized);
			return;
		}
		this.mapped.set(normalized, sessionUuid);
	}

	create(): string {
		return createUUIDv7();
	}

	delete(runtimeSessionId: string | undefined): void {
		const normalized = this.normalize(runtimeSessionId);
		if (!normalized) return;
		this.mapped.delete(normalized);
	}

	deleteSession(sessionUuid: string): void {
		const runtimeSessionIds: string[] = [];
		for (const [runtimeSessionId, mappedSessionUuid] of this.mapped) {
			if (mappedSessionUuid === sessionUuid) {
				runtimeSessionIds.push(runtimeSessionId);
			}
		}
		for (const runtimeSessionId of runtimeSessionIds) {
			this.mapped.delete(runtimeSessionId);
		}
	}
}
