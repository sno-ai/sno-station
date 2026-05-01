// Tests redaction false-positive guardrails per task §20.5.
// Per spec: emails inside code samples (`"foo@bar"`) still redact — this is intentional.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactEventPayload } from "../../../../packages/sno-observe/dist/internal/redact.js";

describe("redact — false-positive guardrails", () => {
	it("redacts email-like strings even when they appear inside code samples (20.5)", () => {
		const result = redactEventPayload(
			{
				note: 'sample = "support@acme.com"; const email = "foo@bar.io";',
			},
			"metadata-only",
		);
		const serialized = JSON.stringify(result.value);
		// Both emails redacted, regardless of code-sample wrapping.
		assert.equal(serialized.includes("support@acme.com"), false);
		assert.equal(serialized.includes("foo@bar.io"), false);
		assert.equal(serialized.includes("<email>"), true);
		assert.equal(result.redacted, true);
	});

	it("redacts emails embedded in JSON-quoted strings (intentional false-positive)", () => {
		// `"foo@bar.com"` substring inside a longer string still triggers redaction.
		const result = redactEventPayload(
			{ raw: 'log line: user="ada@example.com" t=12345' },
			"metadata-only",
		);
		assert.equal(JSON.stringify(result.value).includes("ada@example.com"), false);
	});

	it("does not redact non-email strings that resemble emails (no @ + TLD)", () => {
		const result = redactEventPayload(
			{ note: "see PR #foo@bar (just a ref); also @user mention" },
			"metadata-only",
		);
		// "foo@bar" has no TLD -> not redacted; "@user" has no @local -> not redacted.
		const serialized = JSON.stringify(result.value);
		assert.equal(serialized.includes("foo@bar"), true);
		assert.equal(serialized.includes("@user"), true);
		assert.equal(result.redacted, false);
	});

	it("redacts AWS access key + Stripe sk_live_ + ghp_ tokens", () => {
		const result = redactEventPayload(
			{
				note:
					"AKIA1234567890ABCDEF and sk_live_<REDACTED> and ghp_<REDACTED>",
			},
			"metadata-only",
		);
		const serialized = JSON.stringify(result.value);
		assert.equal(serialized.includes("AKIA1234567890ABCDEF"), false);
		assert.equal(serialized.includes("sk_live_<REDACTED>"), false);
		assert.equal(serialized.includes("ghp_<REDACTED>"), false);
		assert.equal((serialized.match(/<api-key>/gu) ?? []).length, 3);
	});

	it("at consent=off, sensitive-key string values are dropped wholesale", () => {
		const result = redactEventPayload(
			{ message: "raw error text", input: "raw input", note: "ada@example.com" },
			"off",
		);
		const serialized = JSON.stringify(result.value);
		// `<content>` placeholder (per redact.ts) replaces sensitive-key string values.
		assert.equal(serialized.includes("raw error text"), false);
		assert.equal(serialized.includes("raw input"), false);
		assert.equal(serialized.includes("ada@example.com"), false);
		assert.equal(result.redacted, true);
	});
});
