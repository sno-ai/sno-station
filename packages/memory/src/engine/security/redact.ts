/** @file redact.ts
 * @purpose Redacts sensitive values before logs, diagnostics, or model-visible text.
 * @boundary Security boundaries, capture payloads, and CLI output hygiene.
 * @see capture-policy-detector.ts, memory-management-cli.ts, memory-tool-registration.ts.
 */

import { redactForStorage } from "@snoai/content-sanitizer";

const REDACTED_SECRET = "[REDACTED_SECRET]";
const NAMED_CREDENTIAL_PATTERN =
	/\b[A-Za-z0-9]+_(?:live|key|secret|token)_[A-Za-z0-9][A-Za-z0-9_-]{11,}\b/gi;
const LABELED_CREDENTIAL_PATTERN =
	/\b((?:api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|auth[\s_-]*token|password|passphrase|secret|credential|token)\s*(?:is|was|=|:)\s*)([A-Za-z0-9][A-Za-z0-9._/+=$:-]{11,})/gi;
const LONG_ALPHANUMERIC_PATTERN = /\b[A-Za-z0-9]{32,}\b/g;

function isHighEntropyCredentialCandidate(value: string): boolean {
	if (/^[A-Fa-f0-9]+$/.test(value)) return false;
	if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return false;
	const counts = new Map<string, number>();
	for (const character of value) {
		counts.set(character, (counts.get(character) ?? 0) + 1);
	}
	const entropy = [...counts.values()].reduce((total, count) => {
		const probability = count / value.length;
		return total - probability * Math.log2(probability);
	}, 0);
	return entropy >= 3.2;
}

function redactGenericCredentials(text: string): string {
	return text
		.replace(NAMED_CREDENTIAL_PATTERN, REDACTED_SECRET)
		.replace(
			LABELED_CREDENTIAL_PATTERN,
			(_match, label: string) => `${label}${REDACTED_SECRET}`,
		)
		.replace(LONG_ALPHANUMERIC_PATTERN, (value) =>
			isHighEntropyCredentialCandidate(value) ? REDACTED_SECRET : value,
		);
}

/** Redacts provider-specific and conservative generic credential forms. */
export function redactSecrets(text: string): string {
	const providerRedacted = redactForStorage(text, {
		source: "generic-text",
		contentType: "plain_text",
	}).text;
	return redactGenericCredentials(providerRedacted);
}
