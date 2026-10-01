import { describe, expect, test } from "vitest";
import { hasAuditProofForEvent } from "./observe-audit-proof";

const eventId = "018f5b9a-7b3c-7cc2-8a4d-123456789abc";
const uuid = "018f5b9a-7b3c-4cc2-8a4d-123456789abc";
const hex64 = "a".repeat(64);

describe("observe audit proof contract", () => {
	test("accepts the current Sno audit verify response shape", () => {
		expect(
			hasAuditProofForEvent(
				{
					anchor_id: uuid,
					computed_root: hex64,
					gdpr_scrubbed: false,
					merkle_path: [{ position: "L", sibling_hex: hex64 }],
					signing_key_id: uuid,
					stored_root: hex64,
					verified: true,
				},
				eventId,
			),
		).toBe(true);
	});

	test("accepts a root-leaf proof with an empty Merkle path", () => {
		expect(
			hasAuditProofForEvent(
				{
					anchor_id: uuid,
					computed_root: hex64,
					gdpr_scrubbed: true,
					merkle_path: [],
					signing_key_id: uuid,
					stored_root: hex64,
					verified: true,
				},
				eventId,
			),
		).toBe(true);
	});

	test("rejects unverified or mismatched proof material", () => {
		expect(
			hasAuditProofForEvent(
				{
					anchor_id: uuid,
					computed_root: hex64,
					gdpr_scrubbed: false,
					merkle_path: [{ position: "R", sibling_hex: hex64 }],
					signing_key_id: uuid,
					stored_root: "b".repeat(64),
					verified: true,
				},
				eventId,
			),
		).toBe(false);
	});

	test("rejects malformed Merkle path entries", () => {
		expect(
			hasAuditProofForEvent(
				{
					anchor_id: uuid,
					computed_root: hex64,
					gdpr_scrubbed: false,
					merkle_path: [{ position: "left", sibling_hex: hex64 }],
					signing_key_id: uuid,
					stored_root: hex64,
					verified: true,
				},
				eventId,
			),
		).toBe(false);
	});
});
