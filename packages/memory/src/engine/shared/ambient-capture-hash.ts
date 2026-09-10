/** @file ambient-capture-hash.ts
 * @purpose Defines deterministic content-hash input for local-first ambient chunks.
 * @boundary Shared by the ambient hook producer and MemoryStore hash writer only.
 */

import type { ContentType } from "@snoai/chunking";

export interface AmbientCaptureHashMetadata {
	source: "agent_end";
	role: "user" | "assistant";
	session_key?: string;
	session_id?: string;
	chunk_index: number;
	chunk_count: number;
	chunking_version: string;
	content_type: ContentType;
}

function normalizeAmbientCaptureHashMetadata(
	metadata: AmbientCaptureHashMetadata,
): AmbientCaptureHashMetadata {
	return {
		source: metadata.source,
		role: metadata.role,
		...(metadata.session_key ? { session_key: metadata.session_key } : {}),
		...(metadata.session_id ? { session_id: metadata.session_id } : {}),
		chunk_index: metadata.chunk_index,
		chunk_count: metadata.chunk_count,
		chunking_version: metadata.chunking_version,
		content_type: metadata.content_type,
	};
}

export function buildAmbientCaptureHashInput(
	text: string,
	metadata: AmbientCaptureHashMetadata,
): string {
	return JSON.stringify([
		"sno-station-mem:ambient-chunk:v1",
		text,
		normalizeAmbientCaptureHashMetadata(metadata),
	]);
}

export function readAmbientCaptureHashMetadata(
	metadata: Record<string, unknown>,
): AmbientCaptureHashMetadata | undefined {
	if (metadata.source !== "agent_end") return undefined;
	if (metadata.role !== "user" && metadata.role !== "assistant") return undefined;
	if (typeof metadata.chunk_index !== "number") return undefined;
	if (typeof metadata.chunk_count !== "number") return undefined;
	if (typeof metadata.chunking_version !== "string") return undefined;
	if (
		metadata.content_type !== "conversation" &&
		metadata.content_type !== "prose" &&
		metadata.content_type !== "structured"
	) {
		return undefined;
	}
	return {
		source: metadata.source,
		role: metadata.role,
		...(typeof metadata.session_key === "string" ? { session_key: metadata.session_key } : {}),
		...(typeof metadata.session_id === "string" ? { session_id: metadata.session_id } : {}),
		chunk_index: metadata.chunk_index,
		chunk_count: metadata.chunk_count,
		chunking_version: metadata.chunking_version,
		content_type: metadata.content_type,
	};
}
