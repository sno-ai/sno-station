import { validate as validateUuidFormat } from "uuid";
import { isLowercaseCanonicalUUIDv7 } from "../../../../../packages/common-core/src/index.ts";
import {
	getArrayField,
	getStringField,
	isRecord,
	parseJsonMaybe,
} from "./json";

export function hasAuditProofForEvent(
	value: unknown,
	eventId: string,
): boolean {
	if (!isLowercaseCanonicalUUIDv7(eventId)) {
		return false;
	}
	const parsed = typeof value === "string" ? parseJsonMaybe(value) : value;
	if (!isRecord(parsed)) {
		return false;
	}
	return (
		parsed.verified === true &&
		typeof parsed.gdpr_scrubbed === "boolean" &&
		isLowercaseCanonicalUuid(getStringField(parsed, "anchor_id")) &&
		isLowercaseCanonicalUuid(getStringField(parsed, "signing_key_id")) &&
		isHex64(getStringField(parsed, "computed_root")) &&
		getStringField(parsed, "computed_root") ===
			getStringField(parsed, "stored_root") &&
		hasValidMerklePath(parsed)
	);
}

function hasValidMerklePath(value: unknown): boolean {
	const path = getArrayField(value, "merkle_path");
	return path.every(
		(item) =>
			isRecord(item) &&
			isHex64(getStringField(item, "sibling_hex")) &&
			(item.position === "L" || item.position === "R"),
	);
}

function isLowercaseCanonicalUuid(value: string | undefined): boolean {
	return (
		value !== undefined &&
		value === value.toLowerCase() &&
		validateUuidFormat(value)
	);
}

function isHex64(value: string | undefined): boolean {
	return value !== undefined && /^[0-9a-f]{64}$/.test(value);
}
