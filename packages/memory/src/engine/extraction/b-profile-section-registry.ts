/** @file b-profile-section-registry.ts
 * @purpose Exposes the bundled B-profile section resource and pure topic normalization.
 * @boundary Matching code consumes registry data; taxonomy strings live in the JSON resource.
 */

import registryResource from "../../../config/b-profile-section-registry.json" with { type: "json" };
import type { Locale } from "../i18n/locales";

export type BProfileSectionLocaleMap = Record<Locale, readonly string[]>;

export interface BProfileSectionDefinition {
	name: string;
	domain: string;
	synonyms: BProfileSectionLocaleMap;
}

export interface BProfileSectionRegistry {
	schema_version: number;
	frozen_at: string;
	domains: readonly string[];
	gate_prompt: {
		instructions: string;
		registry_header: string;
		candidates_header: string;
		output_contract: string;
	};
	active_task_shape: {
		projection_max_items: number;
		projection_title_max_tokens: number;
	};
	sections: readonly BProfileSectionDefinition[];
	section_registry_sha256: string;
	source_git_rev: string;
}

export const B_PROFILE_SECTION_REGISTRY: BProfileSectionRegistry = registryResource;

function buildSynonymIndex(registry: BProfileSectionRegistry): ReadonlyMap<string, string> {
	const index = new Map<string, string>();
	for (const section of registry.sections) {
		index.set(normalizeRegistryTerm(section.name), section.name);
		for (const synonym of section.synonyms.en) {
			index.set(normalizeRegistryTerm(synonym), section.name);
		}
	}
	return index;
}

export function slugifyTopic(topic: string): string {
	return (
		topic.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") ||
		"general"
	);
}

export function normalizeTopicToSectionName(
	topic: string,
	registry: BProfileSectionRegistry = B_PROFILE_SECTION_REGISTRY,
): string {
	const synonymIndex = buildSynonymIndex(registry);
	const key = normalizeRegistryTerm(topic);
	const exact = synonymIndex.get(key);
	if (exact) return exact;

	const keyTokens = tokenizeTopic(key);
	const phrases = [...synonymIndex.keys()].sort((left, right) => right.length - left.length);
	for (const phrase of phrases) {
		if (containsTokenRun(keyTokens, tokenizeTopic(phrase))) {
			return synonymIndex.get(phrase) ?? "preferences.general";
		}
	}
	return "preferences.general";
}

function normalizeRegistryTerm(value: string): string {
	return value.normalize("NFKC").trim().toLowerCase();
}

function tokenizeTopic(value: string): string[] {
	return value.split(/[^a-z0-9]+/).filter(Boolean);
}

function containsTokenRun(haystack: readonly string[], needle: readonly string[]): boolean {
	if (needle.length === 0 || needle.length > haystack.length) return false;
	for (let start = 0; start + needle.length <= haystack.length; start++) {
		let matched = true;
		for (let offset = 0; offset < needle.length; offset++) {
			if (haystack[start + offset] !== needle[offset]) {
				matched = false;
				break;
			}
		}
		if (matched) return true;
	}
	return false;
}
