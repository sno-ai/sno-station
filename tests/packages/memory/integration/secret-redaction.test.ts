/**
 * Integration tests for the redactSecrets() utility function.
 *
 * Tests the pure-function secret redaction against all 15 scenarios from the spec.
 * No mocking — function is pure, no external dependencies.
 *
 * Spec: openspec/changes/mem-claw-catchup/specs/secret-redaction/spec.md
 *   - 15 scenarios covering all secret pattern categories, deviation cases
 *     (file paths, emails, Windows paths preserved), idempotency, and mixed content.
 */

import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../../../packages/memory/src/engine/security/redact.ts";

describe("redactSecrets", () => {
	// ── Scenario 1: OpenAI API key redacted ──────────────────────────

	it("redacts OpenAI API keys (sk-proj- prefix)", () => {
		const input = "My key is sk-proj-<REDACTED>";
		const result = redactSecrets(input);
		expect(result).toBe("My key is [REDACTED_SECRET]");
		expect(result).not.toContain("sk-proj-");
	});

	// ── Scenario 2: GitHub PAT redacted ──────────────────────────────

	it("redacts GitHub personal access tokens (ghp_ prefix)", () => {
		const input = "ghp_<REDACTED>";
		const result = redactSecrets(input);
		expect(result).toBe("[REDACTED_SECRET]");
		expect(result).not.toContain("ghp_");
	});

	// ── Scenario 3: Bearer token redacted ────────────────────────────

	it("redacts Bearer tokens", () => {
		const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIs";
		const result = redactSecrets(input);
		expect(result).toBe("Authorization: Bearer [REDACTED_SECRET]");
		expect(result).not.toContain("eyJhbGciOiJIUzI1NiIs");
	});

	it("redacts Basic auth headers", () => {
		const input = "Authorization: Basic ZGVtbzpzM2NyM3Q=";
		const result = redactSecrets(input);
		expect(result).toBe("Authorization: Basic [REDACTED_SECRET]");
		expect(result).not.toContain("ZGVtbzpzM2NyM3Q=");
	});

	// ── Scenario 4: Slack token redacted ─────────────────────────────

	it("redacts Slack tokens (xoxb- prefix)", () => {
		const input = "SLACK_TOKEN=xox_<REDACTED>";
		const result = redactSecrets(input);
		expect(result).not.toContain("xox_<REDACTED>");
		expect(result).toContain("[REDACTED_SECRET]");
	});

	// ── Scenario 5: AWS access key redacted ──────────────────────────

	it("redacts AWS access keys (AKIA prefix)", () => {
		const input = "aws_access_key_id = AKIAIOSFODNN7EXAMPLE";
		const result = redactSecrets(input);
		expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
		expect(result).toContain("[REDACTED_SECRET]");
	});

	// ── Scenario 6: PEM private key redacted ─────────────────────────

	it("redacts PEM private key blocks", () => {
		const input = [
			"Here is a key:",
			"-----BEGIN RSA PRIVATE KEY (redacted)-----",
			"MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF...",
			"-----END RSA PRIVATE KEY (redacted)-----",
			"End of key.",
		].join("\n");
		const result = redactSecrets(input);
		expect(result).not.toContain("BEGIN RSA PRIVATE KEY");
		expect(result).not.toContain("MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn");
		expect(result).not.toContain("END RSA PRIVATE KEY");
		expect(result).toContain("[REDACTED_SECRET]");
		expect(result).toContain("Here is a key:");
		expect(result).toContain("End of key.");
	});

	// ── Scenario 7: URL credentials redacted ─────────────────────────

	it("redacts URL credentials (user:pass@host)", () => {
		const input = "https://user:s3cret@host.com/path";
		const result = redactSecrets(input);
		expect(result).not.toContain("user:s3cret");
		expect(result).toContain("[REDACTED_SECRET]");
		expect(result).toContain("host.com/path");
	});

	it("redacts scheme-less credentials while preserving ordinary email-like prose", () => {
		const input = "Contact foo:bar@example; connect to admin:s3cret@db.internal:6379";
		const result = redactSecrets(input);
		expect(result).toContain("foo:bar@example");
		expect(result).toContain("[REDACTED_SECRET]@db.internal:6379");
		expect(result).not.toContain("admin:s3cret");
	});

	// ── Scenario 8: File paths preserved (deviation) ─────────────────

	it("preserves Unix file paths unchanged", () => {
		const input = "/home/user/projects/code/file.ts";
		const result = redactSecrets(input);
		expect(result).toBe("/home/user/projects/code/file.ts");
	});

	// ── Scenario 9: Windows paths preserved (deviation) ──────────────

	it("preserves Windows file paths unchanged", () => {
		const input = "C:\\Users\\dev\\project\\file.ts";
		const result = redactSecrets(input);
		expect(result).toBe("C:\\Users\\dev\\project\\file.ts");
	});

	// ── Scenario 10: Email addresses preserved (deviation) ───────────

	it("preserves email addresses unchanged", () => {
		const input = "Contact user@example.com for details";
		const result = redactSecrets(input);
		expect(result).toBe("Contact user@example.com for details");
	});

	// ── Scenario 11: Non-secret text unchanged ───────────────────────

	it("passes through non-secret text unchanged", () => {
		const input = "This is normal text with no secrets";
		const result = redactSecrets(input);
		expect(result).toBe("This is normal text with no secrets");
	});

	it("preserves bare hexadecimal identifiers", () => {
		const input = [
			"Commit 0123456789abcdef0123456789abcdef01234567",
			"Digest 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			"UUID 550e8400e29b41d4a716446655440000",
		].join("\n");
		expect(redactSecrets(input)).toBe(input);
	});

	// ── Scenario 12: Idempotent on already-redacted text ─────────────

	it("is idempotent on already-redacted text", () => {
		const input = "The key was [REDACTED_SECRET] and Bearer [REDACTED_SECRET]";
		const result = redactSecrets(input);
		expect(result).toBe("The key was [REDACTED_SECRET] and Bearer [REDACTED_SECRET]");
	});

	// ── Scenario 13: Mixed content with secrets ──────────────────────

	it("redacts exactly 3 embedded keys in mixed content, preserving all other text", () => {
		const input = [
			"User said: please configure these keys.",
			"OpenAI: sk-proj-<REDACTED>",
			"GitHub: ghp_<REDACTED>",
			"Slack: xox_<REDACTED>",
			"Then the user continued chatting about TypeScript.",
		].join("\n");

		const result = redactSecrets(input);

		const redactedCount = (result.match(/\[REDACTED_SECRET\]/g) ?? []).length;
		expect(redactedCount).toBe(3);

		// Surrounding text preserved
		expect(result).toContain("User said: please configure these keys.");
		expect(result).toContain("Then the user continued chatting about TypeScript.");

		// Secrets removed
		expect(result).not.toContain("sk-proj-abc123");
		expect(result).not.toContain("ghp_xxxx");
		expect(result).not.toContain("xoxb-123");
	});

	// ── Scenario 14: Generic key-value pattern redacted ──────────────

	it("redacts generic key-value patterns (token=, api_key=)", () => {
		const input = "token=abc123xyz789&api_key=<REDACTED>";
		const result = redactSecrets(input);
		expect(result).not.toContain("abc123xyz789");
		expect(result).not.toContain("def456uvw012");
		expect(result).toContain("[REDACTED_SECRET]");
	});

	it("redacts token-bearing query params while preserving URL structure", () => {
		const input =
			"https://example.com/callback?access_token=abc123xyz789&mode=test";
		const result = redactSecrets(input);
		expect(result).toBe(
			"https://example.com/callback?access_token=[REDACTED_SECRET]&mode=test",
		);
		expect(result).not.toContain("abc123xyz789");
	});

	// ── Scenario 15: Additional secret pattern coverage ──────────────

	it("redacts sk-ant- (Anthropic) keys and Google API keys", () => {
		const input = [
			"Anthropic: sk-ant-api03-abcdef1234567890abcdef",
			"Google: AIzaSyDaGmWKa4JsXZ7hkN3Rl9bXzE_abc123",
		].join("\n");

		const result = redactSecrets(input);

		expect(result).not.toContain("sk-ant-api03");
		expect(result).not.toContain("AIzaSyDaGmWKa4JsXZ7");
		const redactedCount = (result.match(/\[REDACTED_SECRET\]/g) ?? []).length;
		expect(redactedCount).toBe(2);
	});

	it("redacts JWTs, Stripe keys, and Google OAuth access tokens", () => {
		const input = [
			"JWT: <REDACTED-JWT>",
			"Stripe secret: sk_live_<REDACTED>",
			"Stripe publishable: pk_test_1234567890abcdefABCDEF12",
			"Google OAuth: ya29.<REDACTED>",
		].join("\n");

		const result = redactSecrets(input);

		expect(result).not.toContain("eyJhbGciOiJIUzI1NiIs");
		expect(result).not.toContain("sk_live_<REDACTED>");
		expect(result).not.toContain("pk_test_1234567890");
		expect(result).not.toContain("ya29.<REDACTED>");
		const redactedCount = (result.match(/\[REDACTED_SECRET\]/g) ?? []).length;
		expect(redactedCount).toBe(4);
	});
});
