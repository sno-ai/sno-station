/** @file b-profile-section-dictionary-provider.ts
 * @purpose Loads, validates, caches, and atomically activates the B-profile section dictionary.
 * @boundary Fetch transport is injected; this module owns no URL, HTTP client, or retry policy.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "@snoai/utils/logger";
import { z } from "zod";
import type { ProductMode } from "../../../config/plugin-config-mode-schema";
import { getSnoStationMemDataDir } from "../../store/data-paths";
import {
	B_PROFILE_SECTION_REGISTRY,
	type BProfileSectionRegistry,
	normalizeTopicToSectionName as normalizeWithRegistry,
} from "./b-profile-section-registry";
import { SUPPORTED_LOCALES } from "../i18n/locales";

const log = createLogger("sno-station-mem:b-profile-section-dictionary");
const CACHE_FILE_NAME = "b-profile-section-dictionary.json";
const localeTermMapSchema = z
	.object({
		de: z.array(z.string().min(1)).min(1),
		en: z.array(z.string().min(1)).min(1),
		es: z.array(z.string().min(1)).min(1),
		fr: z.array(z.string().min(1)).min(1),
		ja: z.array(z.string().min(1)).min(1),
		ko: z.array(z.string().min(1)).min(1),
		ru: z.array(z.string().min(1)).min(1),
		zh: z.array(z.string().min(1)).min(1),
		"zh-Hant": z.array(z.string().min(1)).min(1),
	})
	.strict();
export const bProfileSectionRegistrySchema: z.ZodType<
	BProfileSectionRegistry,
	unknown
> = z
	.object({
		schema_version: z.number().int().positive(),
		frozen_at: z.string().min(1),
		domains: z.array(z.string().min(1)).min(1),
		gate_prompt: z
				.object({
					instructions: z.string().min(1),
					registry_header: z.string().min(1),
					candidates_header: z.string().min(1),
					output_contract: z.string().min(1),
			})
			.strict(),
		active_task_shape: z
			.object({
				projection_max_items: z.number().int().positive(),
				projection_title_max_tokens: z.number().int().positive(),
			})
			.strict(),
		sections: z
			.array(
				z
					.object({
						name: z.string().min(1),
						domain: z.string().min(1),
						synonyms: localeTermMapSchema,
					})
					.strict(),
			)
			.min(1)
			.max(128),
		section_registry_sha256: z.string().regex(/^[a-f0-9]{64}$/i),
		source_git_rev: z.string().min(1),
	})
	.strict()
	.superRefine((registry, context) => {
		const sectionNames = new Set<string>();
		const termOwners = new Map<string, string>();
		const declaredDomains = new Set(registry.domains);
		if (declaredDomains.size !== registry.domains.length) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "domains must be unique",
				path: ["domains"],
			});
		}
		for (const [index, section] of registry.sections.entries()) {
			const normalized = normalizeRegistryTerm(section.name);
			if (sectionNames.has(normalized)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: "section names must be unique after normalization",
					path: ["sections", index, "name"],
				});
				continue;
			}
			sectionNames.add(normalized);
			termOwners.set(normalized, section.name);
			if (!declaredDomains.has(section.domain)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: "section domain must reference a declared domain",
					path: ["sections", index, "domain"],
				});
			}
			for (const locale of SUPPORTED_LOCALES) {
				for (const synonym of section.synonyms[locale]) {
					const normalized = normalizeRegistryTerm(synonym);
					const owner = termOwners.get(normalized);
					if (owner !== undefined && owner !== section.name) {
						context.addIssue({
							code: z.ZodIssueCode.custom,
							message: "normalized synonyms must map to exactly one section_name",
							path: ["sections", index, "synonyms", locale],
						});
						continue;
					}
					termOwners.set(normalized, section.name);
				}
			}
		}
		if (computeSectionRegistryHash(registry) !== registry.section_registry_sha256) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "section_registry_sha256 must cover the runtime section dictionary",
				path: ["section_registry_sha256"],
			});
		}
	});

export function computeSectionRegistryHash(registry: BProfileSectionRegistry): string {
	return createHash("sha256")
		.update(
				canonicalJson({
					schema_version: registry.schema_version,
					domains: registry.domains,
					gate_prompt: registry.gate_prompt,
					active_task_shape: registry.active_task_shape,
					sections: registry.sections,
				}),
		)
		.digest("hex");
}

const sectionDictionaryCacheStateSchema: z.ZodType<
	{
		activeRegistry: BProfileSectionRegistry;
		fetchedForPluginVersion?: string;
		appliedSchemaVersion?: number;
		canonicalFormRepairVersion?: number;
	},
	unknown
> = z
	.object({
		activeRegistry: bProfileSectionRegistrySchema,
		fetchedForPluginVersion: z.string().min(1).optional(),
		appliedSchemaVersion: z.number().int().positive().optional(),
		canonicalFormRepairVersion: z.number().int().positive().optional(),
	})
	.strict();

export type SectionDictionaryCacheState = z.infer<typeof sectionDictionaryCacheStateSchema>;

export interface SectionDictionaryCache {
	read(): Promise<SectionDictionaryCacheState | undefined>;
	write(state: SectionDictionaryCacheState): Promise<void>;
}

export interface LoadSectionDictionaryResult {
	registry: BProfileSectionRegistry;
	fetched: boolean;
}

let activeRegistry: BProfileSectionRegistry = B_PROFILE_SECTION_REGISTRY;
let loadQueue: Promise<void> = Promise.resolve();

class SectionDictionaryFileCache implements SectionDictionaryCache {
	readonly filePath: string;

	constructor(stateDir: string) {
		this.filePath = join(stateDir, CACHE_FILE_NAME);
	}

	async read(): Promise<SectionDictionaryCacheState | undefined> {
		let raw: string;
		try {
			raw = await readFile(this.filePath, "utf8");
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return undefined;
			throw error;
		}
		const parsedJson: unknown = JSON.parse(raw);
		return sectionDictionaryCacheStateSchema.parse(parsedJson);
	}

	async write(state: SectionDictionaryCacheState): Promise<void> {
		const validated = sectionDictionaryCacheStateSchema.parse(state);
		const stateDir = dirname(this.filePath);
		await mkdir(stateDir, { recursive: true });
		const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(tempPath, "wx", 0o600);
			await handle.writeFile(`${JSON.stringify(validated)}\n`, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(tempPath, this.filePath);
			const directoryHandle = await open(stateDir, "r");
			try {
				await directoryHandle.sync();
			} finally {
				await directoryHandle.close();
			}
		} catch (error) {
			await handle?.close().catch(() => undefined);
			await unlink(tempPath).catch(() => undefined);
			throw error;
		}
	}
}

export function createSectionDictionaryCache(
	stateDir: string = getSnoStationMemDataDir(),
): SectionDictionaryCache {
	return new SectionDictionaryFileCache(stateDir);
}

export function getActiveSectionRegistry(): BProfileSectionRegistry {
	return activeRegistry;
}

export function normalizeTopicToSectionName(
	topic: string,
	registry: BProfileSectionRegistry = activeRegistry,
): string {
	return normalizeWithRegistry(topic, registry);
}

export async function restoreCachedSectionDictionary(args: {
	mode: ProductMode;
	cache: SectionDictionaryCache;
}): Promise<BProfileSectionRegistry> {
	if (args.mode === "local-first") {
		activeRegistry = B_PROFILE_SECTION_REGISTRY;
		return activeRegistry;
	}
	try {
		const cached = await args.cache.read();
		activeRegistry = cached
			? bProfileSectionRegistrySchema.parse(cached.activeRegistry)
			: B_PROFILE_SECTION_REGISTRY;
	} catch (error) {
		activeRegistry = B_PROFILE_SECTION_REGISTRY;
		log.warn("section dictionary cache rejected; using bundled snapshot", {
			error,
		}, {
			event_name: "sno_station_mem.b-profile-section-dictionary-provider.section.dictionary.cache.rejected.using.bundled.snapshot",
			file: "packages/sno-station-mem/src/engine/extraction/b-profile-section-dictionary-provider.ts",
			function: "restoreCachedSectionDictionary",
			site_id: "b-profile-section-dictionary-provider.restoreCachedSectionDictionary.a4518aedd5",
		});
	}
	return activeRegistry;
}

export function loadSectionDictionary(args: {
	mode: ProductMode;
	pluginVersion: string;
	fetchFn: () => Promise<unknown>;
	cache: SectionDictionaryCache;
}): Promise<LoadSectionDictionaryResult> {
	if (args.mode === "local-first") {
		activeRegistry = B_PROFILE_SECTION_REGISTRY;
		return Promise.resolve({ registry: activeRegistry, fetched: false });
	}
	const result = loadQueue.then(() => loadRemoteSectionDictionary(args));
	loadQueue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

async function loadRemoteSectionDictionary(args: {
	pluginVersion: string;
	fetchFn: () => Promise<unknown>;
	cache: SectionDictionaryCache;
}): Promise<LoadSectionDictionaryResult> {
	let cached: SectionDictionaryCacheState | undefined;
	try {
		const candidate = await args.cache.read();
		cached = candidate === undefined ? undefined : sectionDictionaryCacheStateSchema.parse(candidate);
	} catch (error) {
		log.warn("section dictionary cache rejected; using bundled snapshot", {
			error,
		}, {
			event_name: "sno_station_mem.b-profile-section-dictionary-provider.section.dictionary.cache.rejected.using.bundled.snapshot",
			file: "packages/sno-station-mem/src/engine/extraction/b-profile-section-dictionary-provider.ts",
			function: "loadRemoteSectionDictionary",
			site_id: "b-profile-section-dictionary-provider.loadRemoteSectionDictionary.ac5ddcab10",
		});
	}
	const fallbackRegistry = cached?.activeRegistry ?? B_PROFILE_SECTION_REGISTRY;
	activeRegistry = fallbackRegistry;
	if (cached?.fetchedForPluginVersion === args.pluginVersion) {
		return { registry: activeRegistry, fetched: false };
	}

	const attemptState: SectionDictionaryCacheState = {
		activeRegistry: fallbackRegistry,
		fetchedForPluginVersion: args.pluginVersion,
		...(cached?.appliedSchemaVersion === undefined
			? {}
			: { appliedSchemaVersion: cached.appliedSchemaVersion }),
		...(cached?.canonicalFormRepairVersion === undefined
			? {}
			: { canonicalFormRepairVersion: cached.canonicalFormRepairVersion }),
	};
	try {
		// Persist the attempt marker before transport so a crash cannot repeat the
		// same plugin-version fetch on the next boot.
		await args.cache.write(sectionDictionaryCacheStateSchema.parse(attemptState));
	} catch (error) {
		log.warn("section dictionary fetch marker could not be persisted; fetch skipped", {
			version: args.pluginVersion,
			error,
		}, {
			event_name: "sno_station_mem.b-profile-section-dictionary-provider.section.dictionary.fetch.marker.could.not.be.persisted.fetch.skipped",
			file: "packages/sno-station-mem/src/engine/extraction/b-profile-section-dictionary-provider.ts",
			function: "loadRemoteSectionDictionary",
			site_id: "b-profile-section-dictionary-provider.loadRemoteSectionDictionary.a8ecb1a4f2",
		});
		return { registry: activeRegistry, fetched: false };
	}

	try {
		const payload = await args.fetchFn();
		const registry = bProfileSectionRegistrySchema.parse(payload);
		assertAdditiveSectionNames(fallbackRegistry, registry);
		assertStableSynonymOwners(fallbackRegistry, registry);
		await args.cache.write(
			sectionDictionaryCacheStateSchema.parse({ ...attemptState, activeRegistry: registry }),
		);
		activeRegistry = registry;
		return { registry: activeRegistry, fetched: true };
	} catch (error) {
		log.warn("section dictionary fetch rejected; keeping last good registry", {
			version: args.pluginVersion,
			error,
		}, {
			event_name: "sno_station_mem.b-profile-section-dictionary-provider.section.dictionary.fetch.rejected.keeping.last.good.registry",
			file: "packages/sno-station-mem/src/engine/extraction/b-profile-section-dictionary-provider.ts",
			function: "loadRemoteSectionDictionary",
			site_id: "b-profile-section-dictionary-provider.loadRemoteSectionDictionary.15ee874f33",
		});
		return { registry: activeRegistry, fetched: true };
	}
}

function assertStableSynonymOwners(
	previous: BProfileSectionRegistry,
	next: BProfileSectionRegistry,
): void {
	const nextOwners = new Map<string, string>();
	for (const section of next.sections) {
		nextOwners.set(normalizeRegistryTerm(section.name), section.name);
		for (const locale of SUPPORTED_LOCALES) {
			for (const synonym of section.synonyms[locale]) {
				nextOwners.set(normalizeRegistryTerm(synonym), section.name);
			}
		}
	}
	for (const section of previous.sections) {
		for (const locale of SUPPORTED_LOCALES) {
			for (const synonym of section.synonyms[locale]) {
				if (nextOwners.get(normalizeRegistryTerm(synonym)) !== section.name) {
					throw new Error(
						`section dictionary cannot delete or reassign synonym '${synonym}' from '${section.name}'`,
					);
				}
			}
		}
	}
}

function assertAdditiveSectionNames(
	previous: BProfileSectionRegistry,
	next: BProfileSectionRegistry,
): void {
	const nextSectionNames = new Set(next.sections.map((section) => section.name));
	const removedSectionNames = previous.sections
		.map((section) => section.name)
		.filter((sectionName) => !nextSectionNames.has(sectionName));
	if (removedSectionNames.length > 0) {
		throw new Error(
			`section dictionary cannot rename or delete section names: ${removedSectionNames.join(", ")}`,
		);
	}
}

function normalizeRegistryTerm(term: string): string {
	return term.normalize("NFKC").trim().toLowerCase();
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
