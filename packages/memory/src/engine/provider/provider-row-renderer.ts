import { FIXED_PROTOCOL_VALUE_77 } from "../../model/signed-registry-constants";
/** @file provider-row-renderer.ts
 * @purpose Renders stored row memories as deterministic provider files.
 * @boundary Pure presentation only; authorization belongs to provider-search-manager.ts.
 */

import type { MemoryEntry } from "../shared/types";

const PROVIDER_ROW_ID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROVIDER_ROW_ARTIFACT_FILE_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/;

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (!value || typeof value !== "object") return value;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		sorted[key] = sortJson((value as Record<string, unknown>)[key]);
	}
	return sorted;
}

function formatMetadata(raw: string): string {
	try {
		return JSON.stringify(sortJson(JSON.parse(raw) as unknown), null, 2);
	} catch {
		return JSON.stringify({ raw }, null, 2);
	}
}

export function isProviderRowId(id: string): boolean {
	return PROVIDER_ROW_ID_RE.test(id);
}

export function isProviderRowArtifactFileName(name: string): boolean {
	return PROVIDER_ROW_ARTIFACT_FILE_RE.test(name);
}

export function providerRowPath(id: string): string {
	if (!isProviderRowId(id)) {
		throw new Error("Provider row id must be a lowercase UUID");
	}
	return `${FIXED_PROTOCOL_VALUE_77}${id}.md`;
}

export function renderProviderRowMemory(entry: MemoryEntry): string {
	const metadata = formatMetadata(entry.metadata);
	return [
		`# ${providerRowPath(entry.id)}`,
		"",
		`- Memory ID: ${entry.id}`,
		`- Category: ${entry.category}`,
		`- Project ID: ${entry.projectId}`,
		`- Timestamp: ${new Date(entry.timestamp).toISOString()}`,
		`- Importance: ${entry.importance}`,
		"",
		"## Memory",
		"",
		entry.text,
		"",
		"## Metadata",
		"",
		"```json",
		metadata,
		"```",
		"",
	].join("\n");
}
