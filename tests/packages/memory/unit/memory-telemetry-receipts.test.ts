import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadMemoryTelemetryKeySet } from "../../../../apps/mem-claw/src/telemetry/memory-telemetry-config.ts";
import {
	createMemoryTelemetryReceiptService,
	type MemoryTelemetryReceiptInput,
} from "../../../../apps/mem-claw/src/telemetry/memory-telemetry-receipts.ts";

const VALID_HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const TIMESTAMP_MS = 1_700_000_000_000;

function expectedHmac(key: string, input: MemoryTelemetryReceiptInput): string {
	return createHmac("sha256", key)
		.update(`${input.factId}${input.contentHash}${String(input.timestampMs)}`, "utf8")
		.digest("hex");
}

describe("memory telemetry receipt service", () => {
	it("loads the current key fail-closed and defaults current version to 1", () => {
		expect(() => loadMemoryTelemetryKeySet({ enabled: true, env: {} })).toThrow(
			/SNO_MEM_TELEMETRY_HMAC_KEY/,
		);
		expect(loadMemoryTelemetryKeySet({ enabled: false, env: {} })).toEqual({
			enabled: false,
			current: null,
			historic: new Map(),
		});

		const keySet = loadMemoryTelemetryKeySet({
			enabled: true,
			env: { SNO_MEM_TELEMETRY_HMAC_KEY: "current-key" },
		});
		expect(keySet.current?.version).toBe(1);
		expect(keySet.current?.key).toBe("current-key");
	});

	it("signs the PRD canonical byte concatenation and verifies the receipt", () => {
		const keySet = loadMemoryTelemetryKeySet({
			enabled: true,
			env: { SNO_MEM_TELEMETRY_HMAC_KEY: "current-key" },
		});
		const service = createMemoryTelemetryReceiptService(keySet);
		const input: MemoryTelemetryReceiptInput = {
			factId: "fact-abc",
			contentHash: VALID_HASH,
			timestampMs: TIMESTAMP_MS,
		};

		const receipt = service.sign(input);

		expect(receipt).toEqual({
			...input,
			keyVersion: 1,
			receiptHmac: expectedHmac("current-key", input),
		});
		expect(service.verify(receipt)).toEqual({
			status: "valid",
			contentHash: VALID_HASH,
			timestampMs: TIMESTAMP_MS,
			keyVersion: 1,
		});
	});

	it("rejects ambiguous receipt field shapes before signing or verifying", () => {
		const keySet = loadMemoryTelemetryKeySet({
			enabled: true,
			env: { SNO_MEM_TELEMETRY_HMAC_KEY: "current-key" },
		});
		const service = createMemoryTelemetryReceiptService(keySet);

		expect(() => service.sign({ factId: "", contentHash: VALID_HASH, timestampMs: TIMESTAMP_MS })).toThrow(
			/fact_id/,
		);
		expect(() =>
			service.sign({ factId: "fact-abc", contentHash: "not-a-sha256", timestampMs: TIMESTAMP_MS }),
		).toThrow(/content_hash/);
		expect(() =>
			service.sign({ factId: "fact-abc", contentHash: VALID_HASH, timestampMs: 1_700_000 }),
		).toThrow(/timestamp_ms/);
		expect(() =>
			service.verify({
				factId: "fact-abc",
				contentHash: VALID_HASH,
				timestampMs: TIMESTAMP_MS,
				keyVersion: 1,
				receiptHmac: "not-hex",
			}),
		).toThrow(/receipt_hmac/);
	});

	it("reports tampered content as invalid, not valid", () => {
		const keySet = loadMemoryTelemetryKeySet({
			enabled: true,
			env: { SNO_MEM_TELEMETRY_HMAC_KEY: "current-key" },
		});
		const service = createMemoryTelemetryReceiptService(keySet);
		const receipt = service.sign({
			factId: "fact-abc",
			contentHash: VALID_HASH,
			timestampMs: TIMESTAMP_MS,
		});

		expect(service.verify({ ...receipt, contentHash: OTHER_HASH })).toEqual({
			status: "tampered",
			contentHash: OTHER_HASH,
			timestampMs: TIMESTAMP_MS,
			keyVersion: 1,
		});
	});

	it("uses historic keys for old receipts and reports unavailable keys as expired", () => {
		const oldKeySet = loadMemoryTelemetryKeySet({
			enabled: true,
			env: { SNO_MEM_TELEMETRY_HMAC_KEY: "old-key" },
		});
		const oldReceipt = createMemoryTelemetryReceiptService(oldKeySet).sign({
			factId: "fact-abc",
			contentHash: VALID_HASH,
			timestampMs: TIMESTAMP_MS,
		});

		const rotatedKeySet = loadMemoryTelemetryKeySet({
			enabled: true,
			currentKeyVersion: 2,
			env: {
				SNO_MEM_TELEMETRY_HMAC_KEY: "new-key",
				SNO_MEM_TELEMETRY_HMAC_KEY_V1: "old-key",
			},
		});
		expect(createMemoryTelemetryReceiptService(rotatedKeySet).verify(oldReceipt).status).toBe("valid");

		const missingOldKeySet = loadMemoryTelemetryKeySet({
			enabled: true,
			currentKeyVersion: 2,
			env: { SNO_MEM_TELEMETRY_HMAC_KEY: "new-key" },
		});
		expect(createMemoryTelemetryReceiptService(missingOldKeySet).verify(oldReceipt)).toEqual({
			status: "key_expired",
			contentHash: VALID_HASH,
			timestampMs: TIMESTAMP_MS,
			keyVersion: 1,
		});
	});

	it("propagates runtime signing failures", () => {
		const keySet = loadMemoryTelemetryKeySet({
			enabled: true,
			env: { SNO_MEM_TELEMETRY_HMAC_KEY: "current-key" },
		});
		const service = createMemoryTelemetryReceiptService(keySet, {
			signHmac: () => {
				throw new Error("hmac provider failed");
			},
		});

		expect(() =>
			service.sign({
				factId: "fact-abc",
				contentHash: VALID_HASH,
				timestampMs: TIMESTAMP_MS,
			}),
		).toThrow(/hmac provider failed/);
	});
});
