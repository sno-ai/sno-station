/** @file b-profile-section-canonicalizer.ts
 * @purpose Canonicalizes the written form of open B-profile section keys.
 * @boundary Pure deterministic transform; no registry lookup, I/O, or rejection.
 */

const DOMAIN_ALIASES = new Map([
	["interests", "preferences"],
	["goals", "preferences"],
	["work", "preferences"],
]);
const GENERAL_SECTION = "preferences.general";

export function canonicalizeProfileSectionName(sectionName: string): string {
	const normalized = normalizeProfileSectionForm(sectionName);
	if (!normalized) return GENERAL_SECTION;
	if (normalized.split(".").some((segment) => !segment)) return GENERAL_SECTION;

	const separator = normalized.indexOf(".");
	if (separator < 0) return normalized;
	const domain = normalized.slice(0, separator);
	const topic = normalized.slice(separator + 1);
	const canonicalDomain = DOMAIN_ALIASES.get(domain) ?? domain;
	return topic ? `${canonicalDomain}.${topic}` : canonicalDomain;
}

export function normalizeProfileSectionForm(sectionName: string): string {
	return sectionName
		.normalize("NFKC")
		.trim()
		.toLowerCase()
		.replace(/[-_\s]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.replace(/_*\._*/g, ".");
}
