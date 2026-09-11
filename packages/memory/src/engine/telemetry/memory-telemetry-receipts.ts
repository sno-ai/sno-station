import { createHmac, timingSafeEqual } from "node:crypto";
import type {
	MemoryTelemetryKeySet,
	MemoryTelemetryKey,
} from "./memory-telemetry-config";
import type { MemoryTelemetryReceiptStatus } from "./memory-telemetry-types";

const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const TIMESTAMP_MS_PATTERN = /^[0-9]{13}$/;
const RECEIPT_HMAC_PATTERN = /^[a-f0-9]{64}$/;

export interface MemoryTelemetryReceiptInput {
	factId: string;
	contentHash: string;
	timestampMs: number;
}

export interface MemoryTelemetryReceipt extends MemoryTelemetryReceiptInput {
	receiptHmac: string;
	keyVersion: number;
}

export interface MemoryTelemetryReceiptVerification {
	status: MemoryTelemetryReceiptStatus;
	contentHash: string;
	timestampMs: number;
	keyVersion: number;
}

export interface MemoryTelemetryReceiptService {
	sign(input: MemoryTelemetryReceiptInput): MemoryTelemetryReceipt;
	verify(receipt: MemoryTelemetryReceipt): MemoryTelemetryReceiptVerification;
}

export interface MemoryTelemetryReceiptServiceOptions {
	signHmac?: (key: string, canonicalInput: string) => string;
}

export function createMemoryTelemetryReceiptService(
	keySet: MemoryTelemetryKeySet,
	options: MemoryTelemetryReceiptServiceOptions = {},
): MemoryTelemetryReceiptService {
	const signHmac = options.signHmac ?? defaultSignHmac;
	return {
		sign(input) {
			validateReceiptInput(input);
			const current = requireCurrentKey(keySet);
			const canonicalInput = canonicalReceiptInput(input);
			return {
				...input,
				keyVersion: current.version,
				receiptHmac: signHmac(current.key, canonicalInput),
			};
		},
		verify(receipt) {
			validateReceipt(receipt);
			const key = resolveVerificationKey(keySet, receipt.keyVersion);
			if (!key) {
				return verification("key_expired", receipt);
			}
			const expected = signHmac(key.key, canonicalReceiptInput(receipt));
			return verification(safeEqualHex(expected, receipt.receiptHmac) ? "valid" : "tampered", receipt);
		},
	};
}

function requireCurrentKey(keySet: MemoryTelemetryKeySet): MemoryTelemetryKey {
	if (!keySet.enabled || !keySet.current) {
		throw new Error("memory telemetry receipt signing requires an enabled current key");
	}
	return keySet.current;
}

function resolveVerificationKey(
	keySet: MemoryTelemetryKeySet,
	keyVersion: number,
): MemoryTelemetryKey | null {
	if (keySet.current?.version === keyVersion) return keySet.current;
	const historicKey = keySet.historic.get(keyVersion);
	if (!historicKey) return null;
	return { version: keyVersion, key: historicKey };
}

function canonicalReceiptInput(input: MemoryTelemetryReceiptInput): string {
	return `${input.factId}${input.contentHash}${String(input.timestampMs)}`;
}

function validateReceiptInput(input: MemoryTelemetryReceiptInput): void {
	if (input.factId.length === 0) {
		throw new Error("fact_id must be non-empty for receipt signing");
	}
	if (!CONTENT_HASH_PATTERN.test(input.contentHash)) {
		throw new Error("content_hash must be a 64-character lowercase hex SHA-256");
	}
	if (!TIMESTAMP_MS_PATTERN.test(String(input.timestampMs))) {
		throw new Error("timestamp_ms must serialize to exactly 13 decimal digits");
	}
}

function validateReceipt(receipt: MemoryTelemetryReceipt): void {
	validateReceiptInput(receipt);
	if (!Number.isInteger(receipt.keyVersion) || receipt.keyVersion <= 0) {
		throw new Error("key_version must be a positive integer");
	}
	if (!RECEIPT_HMAC_PATTERN.test(receipt.receiptHmac)) {
		throw new Error("receipt_hmac must be a 64-character lowercase hex HMAC-SHA256");
	}
}

function defaultSignHmac(key: string, canonicalInput: string): string {
	return createHmac("sha256", key).update(canonicalInput, "utf8").digest("hex");
}

function safeEqualHex(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left, "hex");
	const rightBuffer = Buffer.from(right, "hex");
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function verification(
	status: MemoryTelemetryReceiptStatus,
	receipt: MemoryTelemetryReceipt,
): MemoryTelemetryReceiptVerification {
	return {
		status,
		contentHash: receipt.contentHash,
		timestampMs: receipt.timestampMs,
		keyVersion: receipt.keyVersion,
	};
}
