/** @file reflection-markdown-sections.ts
 * @purpose Extracts named markdown sections and bullet lists from reflection payloads.
 * @boundary Raw markdown parsing only; no reflection-domain classification.
 */

/** Extracts section markdown from raw runtime payloads with partial-data tolerance. */
export function extractSectionMarkdown(markdown: string, heading: string): string {
	const lines = markdown.split(/\r?\n/);
	const headingNeedle = `## ${heading}`.toLowerCase();
	let inSection = false;
	const collected: string[] = [];

	for (const raw of lines) {
		const line = raw.trim();
		const lower = line.toLowerCase();

		if (lower.startsWith("## ")) {
			if (inSection && lower !== headingNeedle) break;
			inSection = lower === headingNeedle;
			continue;
		}

		if (!inSection) continue;
		collected.push(raw);
	}

	return collected.join("\n").trim();
}

/** Parses section bullets into the normalized shape used by reflection text slicing. */
export function parseSectionBullets(markdown: string, heading: string): string[] {
	const lines = extractSectionMarkdown(markdown, heading).split(/\r?\n/);
	const collected: string[] = [];

	for (const raw of lines) {
		const line = raw.trim();

		if (line.startsWith("- ") || line.startsWith("* ")) {
			const normalized = line.slice(2).trim();
			if (normalized) collected.push(normalized);
		}
	}

	return collected;
}
