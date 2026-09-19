/** @file b-profile-section-rekey.ts
 * @purpose Re-keys fall-through B-profile rows after a section dictionary upgrade.
 * @boundary Deterministic store mutations only; no LLM or network calls.
 */

import { createLogger } from "@snoai/utils/logger";
import { MAX_LIST_LIMIT } from "../../../config/index";
import { recordTokenCounter } from "../../store/memory-store-write-validation";
import { canonicalizeProfileSectionName } from "./b-profile-section-canonicalizer";
import {
	getActiveSectionRegistry,
	normalizeTopicToSectionName,
	restoreCachedSectionDictionary,
	type SectionDictionaryCache,
} from "./b-profile-section-dictionary-provider";
import { boundSectionContent, buildIndexedText } from "./extraction-text-sanitizer";
import {
	buildInsightMetadata,
	deriveFactKey,
	parseInsightMetadata,
	stringifyInsightMetadata,
} from "./memory-metadata-codec";
import type { ProductMode } from "../../../config/plugin-config-mode-schema";
import type { MemoryEntry } from "../shared/types";
import type { MemoryStore } from "../../store/store";

const log = createLogger("sno-station-mem:b-profile-section-rekey");
const GENERAL_SECTION = "preferences.general";
const MISSING_TOPIC_FLAG = "profile.preference.missing_topic";
export const B_PROFILE_CANONICAL_FORM_REPAIR_VERSION = 1;

export interface BProfileSectionRekeyReport {
	sourceRows: number;
	targetKeys: number;
	collisions: number;
	migrated: number;
	merged: number;
	rejected: number;
	missingRawPhrase: number;
	unchanged: number;
	finalCount: number;
	separatorSplitGroups: number;
	domainPrefixSplitGroups: number;
	crossPathSplitGroups: number;
}

export interface BProfileSectionRekeyResult {
	dryRun: BProfileSectionRekeyReport;
	applied: BProfileSectionRekeyReport;
	skippedByVersion: boolean;
}

type PlannedAction = {
	kind: "migrate" | "merge";
	source: MemoryEntry;
	targetFactKey: string;
	newSection: string;
};

type RekeyPlan = {
	report: BProfileSectionRekeyReport;
	actions: PlannedAction[];
	projectIdFilter: string[] | undefined;
};

type CanonicalRepairAction =
	| {
			kind: "migrate";
			sources: [MemoryEntry];
			newSection: string;
	  }
	| {
			kind: "merge";
			sources: MemoryEntry[];
			newSection: string;
	  };

type CanonicalRepairPlan = {
	report: BProfileSectionRekeyReport;
	actions: CanonicalRepairAction[];
	projectIdFilter: string[] | undefined;
};

export async function runBProfileSectionRekey(args: {
	store: MemoryStore;
	cache: SectionDictionaryCache;
	projectIdFilter?: string[];
}): Promise<BProfileSectionRekeyResult> {
	const registry = getActiveSectionRegistry();
	let cached: Awaited<ReturnType<SectionDictionaryCache["read"]>>;
	try {
		cached = await args.cache.read();
	} catch (error) {
		log.warn("section dictionary cache rejected during re-key; treating it as absent", {
			error,
		}, {
			event_name: "sno_station_mem.b-profile-section-rekey.section.dictionary.cache.rejected.during.re.key.treating.it.as.absent",
			file: "packages/sno-station-mem/src/engine/extraction/b-profile-section-rekey.ts",
			function: "runBProfileSectionRekey",
			site_id: "b-profile-section-rekey.runBProfileSectionRekey.b452a7657e",
		});
		cached = undefined;
	}
	const registryRepairPending = cached?.appliedSchemaVersion !== registry.schema_version;
	const canonicalRepairPending =
		cached?.canonicalFormRepairVersion !== B_PROFILE_CANONICAL_FORM_REPAIR_VERSION;
	if (!registryRepairPending && !canonicalRepairPending) {
		const empty = emptyReport();
		return { dryRun: empty, applied: empty, skippedByVersion: true };
	}

	let dryRun = emptyReport();
	let applied = emptyReport();
	if (canonicalRepairPending) {
		const plan = await buildCanonicalRepairPlan(args.store, args.projectIdFilter);
		log.info("B-profile canonical-form repair dry run", plan.report, {
			event_name: "sno_station_mem.b-profile-section-rekey.b.profile.canonical.form.repair.dry.run",
			file: "packages/sno-station-mem/src/engine/extraction/b-profile-section-rekey.ts",
			function: "runBProfileSectionRekey",
			site_id: "b-profile-section-rekey.runBProfileSectionRekey.4494531e35",
		});
		assertCanonicalPlanReconciles(plan);
		const canonicalApplied = await applyCanonicalRepairPlan(args.store, plan);
		if (!reportsEqual(plan.report, canonicalApplied)) {
			log.error("B-profile canonical-form repair reconciliation failed", {
				dryRun: plan.report,
				applied: canonicalApplied,
			}, {
				event_name: "sno_station_mem.b-profile-section-rekey.b.profile.canonical.form.repair.reconciliation.failed",
				file: "packages/sno-station-mem/src/engine/extraction/b-profile-section-rekey.ts",
				function: "runBProfileSectionRekey",
				site_id: "b-profile-section-rekey.runBProfileSectionRekey.5276d7dfea",
			});
			throw new Error("B-profile canonical-form repair applied counts diverged from dry run");
		}
		dryRun = combineReports(dryRun, plan.report);
		applied = combineReports(applied, canonicalApplied);
	}
	if (registryRepairPending || canonicalRepairPending) {
		const plan = await buildRekeyPlan(args.store, args.projectIdFilter);
		log.info("B-profile section re-key dry run", plan.report, {
			event_name: "sno_station_mem.b-profile-section-rekey.b.profile.section.re.key.dry.run",
			file: "packages/sno-station-mem/src/engine/extraction/b-profile-section-rekey.ts",
			function: "runBProfileSectionRekey",
			site_id: "b-profile-section-rekey.runBProfileSectionRekey.1acb6c65f8",
		});
		assertPlanReconciles(plan.report);
		const registryApplied = await applyRekeyPlan(args.store, plan);
		if (!reportsEqual(plan.report, registryApplied)) {
			log.error("B-profile section re-key reconciliation failed", {
				dryRun: plan.report,
				applied: registryApplied,
			}, {
				event_name: "sno_station_mem.b-profile-section-rekey.b.profile.section.re.key.reconciliation.failed",
				file: "packages/sno-station-mem/src/engine/extraction/b-profile-section-rekey.ts",
				function: "runBProfileSectionRekey",
				site_id: "b-profile-section-rekey.runBProfileSectionRekey.d8bb76de51",
			});
			throw new Error("B-profile section re-key applied counts diverged from dry run");
		}
		dryRun = combineReports(dryRun, plan.report);
		applied = combineReports(applied, registryApplied);
	}

	if (args.projectIdFilter === undefined) {
		await args.cache.write({
			activeRegistry: registry,
			...(cached?.fetchedForPluginVersion === undefined
				? {}
				: { fetchedForPluginVersion: cached.fetchedForPluginVersion }),
			appliedSchemaVersion: registry.schema_version,
			canonicalFormRepairVersion: B_PROFILE_CANONICAL_FORM_REPAIR_VERSION,
		});
	}
	log.info("B-profile section re-key applied", applied, {
		event_name: "sno_station_mem.b-profile-section-rekey.b.profile.section.re.key.applied",
		file: "packages/sno-station-mem/src/engine/extraction/b-profile-section-rekey.ts",
		function: "runBProfileSectionRekey",
		site_id: "b-profile-section-rekey.runBProfileSectionRekey.ce06a215a3",
	});
	return { dryRun, applied, skippedByVersion: false };
}

export function scheduleBProfileSectionRekey(args: {
	mode: ProductMode;
	store: MemoryStore;
	cache: SectionDictionaryCache;
}): void {
	// The store's update/supersede APIs serialize each row mutation with the
	// normal capture writer. A lost live race is safe because the plan aborts on
	// divergence and the row-level transform is idempotent on the next boot.
	void (async () => {
		await restoreCachedSectionDictionary({ mode: args.mode, cache: args.cache });
		await runBProfileSectionRekey({ store: args.store, cache: args.cache });
	})().catch((error: unknown) => {
		log.error("detached B-profile section re-key failed", {
			error,
		}, {
			event_name: "sno_station_mem.b-profile-section-rekey.detached.b.profile.section.re.key.failed",
			file: "packages/sno-station-mem/src/engine/extraction/b-profile-section-rekey.ts",
			function: "<anonymous callback>",
			site_id: "b-profile-section-rekey.<anonymous callback>.9cc8218e54",
		});
	});
}

async function buildCanonicalRepairPlan(
	store: MemoryStore,
	projectIdFilter: string[] | undefined,
): Promise<CanonicalRepairPlan> {
	const rows = await listAllProfileRows(store, projectIdFilter);
	const parsedRows = rows
		.map((row) => parseRow(row))
		.filter((row): row is ParsedRow => row !== undefined)
		.sort(compareRows);
	const activeRows = parsedRows.filter(
		(row) =>
			row.metadata.invalidated_at === undefined && isCanonicalRepairEligible(row.metadata),
	);
	const report = emptyReport();
	report.sourceRows = activeRows.length;
	const groups = new Map<string, { sectionName: string; rows: ParsedRow[] }>();
	for (const row of activeRows) {
		const sectionName = canonicalRepairTargetSection(row);
		const groupKey = `${row.entry.projectId}\u0000${sectionName}`;
		const group = groups.get(groupKey);
		if (group) {
			group.rows.push(row);
		} else {
			groups.set(groupKey, { sectionName, rows: [row] });
		}
	}
	Object.assign(report, measureSplitGroups(activeRows));

	const actions: CanonicalRepairAction[] = [];
	let finalCount = activeRows.length;
	for (const group of groups.values()) {
		const actionRows =
			group.rows.length === 1
				? group.rows
				: group.rows.filter((row) => {
						const redirectedFromGeneral =
							canonicalizeProfileSectionName(row.sectionName) === GENERAL_SECTION &&
							group.sectionName !== GENERAL_SECTION;
						if (
							redirectedFromGeneral &&
							!hasMergeablePreferenceClause(row.metadata.l2_content)
						) {
							report.unchanged += 1;
							return false;
						}
						return true;
					});
		if (actionRows.length === 1) {
			const source = actionRows[0];
			if (!source) continue;
			if (source.sectionName === group.sectionName) {
				report.unchanged += 1;
				continue;
			}
			actions.push({
				kind: "migrate",
				sources: [source.entry],
				newSection: group.sectionName,
			});
			report.migrated += 1;
			report.targetKeys += 1;
			continue;
		}
		if (actionRows.length === 0) continue;
		actions.push({
			kind: "merge",
			sources: actionRows.map((row) => row.entry),
			newSection: group.sectionName,
		});
		report.collisions += 1;
		report.merged += 1;
		report.targetKeys += 1;
		finalCount -= actionRows.length - 1;
	}
	report.finalCount = finalCount;
	return { report, actions, projectIdFilter };
}

async function applyCanonicalRepairPlan(
	store: MemoryStore,
	plan: CanonicalRepairPlan,
): Promise<BProfileSectionRekeyReport> {
	if (plan.actions.length === 0) return plan.report;

	for (const action of plan.actions) {
		const sources = action.sources.map((planned) => {
			const current = store.getById(planned.id);
			if (
				!current ||
				current.contentHash !== planned.contentHash ||
				current.metadata !== planned.metadata
			) {
				throw new Error("B-profile canonical-form repair source changed after dry run");
			}
			const metadata = parseInsightMetadata(current.metadata, current);
			if (
				typeof metadata.section_name !== "string" ||
				metadata.invalidated_at !== undefined ||
				!isCanonicalRepairEligible(metadata) ||
				canonicalRepairTargetSection({
					metadata,
					sectionName: metadata.section_name,
				}) !== action.newSection
			) {
				throw new Error("B-profile canonical-form repair source no longer matches its plan");
			}
			return current;
		});
		if (action.kind === "migrate") {
			const source = sources[0];
			if (!source) throw new Error("B-profile canonical-form repair migration source missing");
			await rekeyInPlace(store, source, action.newSection, action.newSection !== GENERAL_SECTION);
		} else {
			await mergeCanonicalCollision(store, sources, action.newSection);
		}
	}

	const finalRows = await listAllProfileRows(store, plan.projectIdFilter);
	const finalCount = finalRows.filter((row) => {
		const parsed = parseRow(row);
		if (!parsed) return false;
		return (
			parsed.metadata.invalidated_at === undefined &&
			isCanonicalRepairEligible(parsed.metadata)
		);
	}).length;
	return { ...plan.report, finalCount };
}

function canonicalRepairTargetSection(
	row: Pick<ParsedRow, "metadata" | "sectionName">,
): string {
	const canonicalSection = canonicalizeProfileSectionName(row.sectionName);
	if (canonicalSection !== GENERAL_SECTION) return canonicalSection;
	const rawTopicPhrase = row.metadata.rawTopicPhrase;
	if (typeof rawTopicPhrase !== "string" || rawTopicPhrase.trim().length === 0) {
		return canonicalSection;
	}
	return normalizeTopicToSectionName(rawTopicPhrase);
}

function isCanonicalRepairEligible(metadata: ParsedRow["metadata"]): boolean {
	return (
		metadata.active_task_kind !== "task" &&
		metadata.active_task_kind !== "projection"
	);
}

function measureSplitGroups(
	laneActiveRows: ParsedRow[],
): Pick<
	BProfileSectionRekeyReport,
	"separatorSplitGroups" | "domainPrefixSplitGroups" | "crossPathSplitGroups"
> {
	const rawSections = new Set(laneActiveRows.map((row) => row.sectionName));
	const sectionsByForm = new Map<string, Set<string>>();
	const sectionsByTopic = new Map<string, Set<string>>();
	for (const section of rawSections) {
		const form = normalizeSplitMeasurementKey(section);
		const matchingForms = sectionsByForm.get(form) ?? new Set<string>();
		matchingForms.add(section);
		sectionsByForm.set(form, matchingForms);

		const separator = section.indexOf(".");
		if (separator < 0) continue;
		const topic = normalizeSplitMeasurementKey(section.slice(separator + 1));
		const matchingTopics = sectionsByTopic.get(topic) ?? new Set<string>();
		matchingTopics.add(section);
		sectionsByTopic.set(topic, matchingTopics);
	}

	const separatorSplitGroups = Array.from(sectionsByForm.values()).filter(
		(sections) => sections.size > 1,
	).length;
	const domainPrefixSplitGroups = Array.from(sectionsByTopic.values()).filter((sections) => {
		const domains = new Set(
			Array.from(sections, (section) => section.slice(0, section.indexOf("."))),
		);
		return domains.size > 1;
	}).length;

	const canonicalSections = new Set(
		laneActiveRows.map((row) => canonicalizeProfileSectionName(row.sectionName)),
	);
	const crossPathPairs = new Set<string>();
	for (const row of laneActiveRows) {
		const section = canonicalizeProfileSectionName(row.sectionName);
		const prefix = "preferences.";
		if (!section.startsWith(prefix)) continue;
		const topic = section.slice(prefix.length);
		const candidates = [
			topic,
			...(typeof row.metadata.rawTopicPhrase === "string"
				? [row.metadata.rawTopicPhrase]
				: []),
		];
		for (const candidate of candidates) {
			const registrySection = normalizeTopicToSectionName(candidate);
			if (
				registrySection === GENERAL_SECTION ||
				registrySection === section ||
				!canonicalSections.has(registrySection)
			) {
				continue;
			}
			crossPathPairs.add([section, registrySection].sort().join("\u0000"));
		}
	}
	return {
		separatorSplitGroups,
		domainPrefixSplitGroups,
		crossPathSplitGroups: crossPathPairs.size,
	};
}

function normalizeSplitMeasurementKey(value: string): string {
	return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

async function mergeCanonicalCollision(
	store: MemoryStore,
	sources: MemoryEntry[],
	newSection: string,
): Promise<void> {
	const sourceMetadata = sources.map((source) => parseInsightMetadata(source.metadata, source));
	const targetFactKey = deriveFactKey({ kind: "profile", section_name: newSection });
	if (!targetFactKey) {
		throw new Error(`B-profile canonical-form repair target '${newSection}' is invalid`);
	}
	const activeFactGuard = {
		factKey: targetFactKey,
		expectedIds: sources
			.filter((_, index) => sourceMetadata[index]?.fact_key === targetFactKey)
			.map((source) => source.id),
	};
	const mergedContent = combineUniquePreferenceClauses(
		...sourceMetadata.map((metadata) => metadata.l2_content),
	);
	const at = Math.max(Date.now(), ...sources.map((source) => source.timestamp));
	const mergedClauseKeys = new Set(
		splitPreferenceClauses(mergedContent).map(normalizeClause).filter(Boolean),
	);
	let exactTargetIndex = -1;
	let exactAliasTargetIndex = -1;
	for (let index = sourceMetadata.length - 1; index >= 0; index -= 1) {
		const metadata = sourceMetadata[index];
		if (!metadata) continue;
		const targetClauseKeys = new Set(
			splitPreferenceClauses(metadata.l2_content).map(normalizeClause).filter(Boolean),
		);
		const exactMatch =
			targetClauseKeys.size === mergedClauseKeys.size &&
			Array.from(targetClauseKeys).every((clause) => mergedClauseKeys.has(clause));
		if (!exactMatch) continue;
		if (metadata.section_name === newSection) {
			exactTargetIndex = index;
			break;
		}
		if (exactAliasTargetIndex < 0) exactAliasTargetIndex = index;
	}
	if (exactTargetIndex < 0) exactTargetIndex = exactAliasTargetIndex;
	if (exactTargetIndex >= 0) {
		const target = sources[exactTargetIndex];
		if (!target) throw new Error("B-profile canonical-form repair exact target disappeared");
		const targetMetadata = sourceMetadata[exactTargetIndex];
		if (!targetMetadata) {
			throw new Error("B-profile canonical-form repair exact target metadata disappeared");
		}
		const finalTargetMetadata =
			targetMetadata.section_name === newSection
				? target.metadata
				: metadataForSection(target, newSection);
		const preserved = await store.supersede({
			create: {
				text: target.text,
				category: target.category,
				projectId: target.projectId,
				importance: target.importance,
				timestamp: target.timestamp,
				metadata: finalTargetMetadata,
				trusted: true,
			},
			activeFactGuard,
			preserveExisting: {
				id: target.id,
				expectedContentHash: target.contentHash,
				expectedMetadata: target.metadata,
			},
			closes: sources
				.filter((source) => source.id !== target.id)
				.map((source) => ({
					id: source.id,
					expectedContentHash: source.contentHash,
					expectedMetadata: source.metadata,
					buildMetadata: (createdId: string): string =>
						closedMetadata(source, createdId, at, newSection, true),
				})),
		});
		if (preserved.id !== target.id) {
			throw new Error("B-profile canonical-form repair exact target was not preserved");
		}
		return;
	}

	const target = sources[0];
	if (!target) throw new Error("B-profile canonical-form repair collision has no rows");
	const targetMetadata = sourceMetadata[0];
	if (!targetMetadata) throw new Error("B-profile canonical-form repair target metadata missing");
	const abstract = firstSentence(mergedContent);
	// Merging two sections into one can cross the per-record ceiling the store refuses to write.
	const boundedContent = boundSectionContent(
		mergedContent,
		abstract,
		await recordTokenCounter(store.embedder),
	);
	const replacementMetadata = buildInsightMetadata(
		{ text: boundedContent, category: "profile", timestamp: at },
		{
			...metadataForMergeProduct(targetMetadata),
			l0_abstract: abstract,
			l1_overview: boundedContent,
			l2_content: boundedContent,
			section_name: newSection,
			supersedes: target.id,
			valid_from: at,
			asserted_at: at,
		},
	);
	await store.supersede({
		create: {
			text: buildIndexedText(abstract, boundedContent),
			category: "profile",
			projectId: target.projectId,
			importance: Math.max(...sources.map((source) => source.importance)),
			timestamp: at,
			metadata: stringifyInsightMetadata(replacementMetadata),
			trusted: true,
		},
		activeFactGuard,
		closes: sources.map((source) => ({
			id: source.id,
			expectedContentHash: source.contentHash,
			expectedMetadata: source.metadata,
			buildMetadata: (createdId: string): string =>
				closedMetadata(source, createdId, at, newSection, true),
		})),
	});
}

async function buildRekeyPlan(
	store: MemoryStore,
	projectIdFilter: string[] | undefined,
): Promise<RekeyPlan> {
	const rows = await listAllProfileRows(store, projectIdFilter);
	const parsedRows = rows
		.map((row) => parseRow(row))
		.filter((row): row is ParsedRow => row !== undefined);
	const activeRows = parsedRows.filter((row) => row.metadata.invalidated_at === undefined);
	const sources = activeRows
		.filter((row) => row.metadata.section_name === GENERAL_SECTION)
		.sort(compareRows)
		.map((row) => row.entry);
	const report = emptyReport();
	report.sourceRows = sources.length;
	const actions: PlannedAction[] = [];
	const plannedTargets = new Set<string>();
	const targetKeys = new Set<string>();

	for (const source of sources) {
		const metadata = parseInsightMetadata(source.metadata, source);
		const rawTopicPhrase = metadata.rawTopicPhrase;
		if (typeof rawTopicPhrase !== "string" || !rawTopicPhrase.trim()) {
			report.missingRawPhrase += 1;
			continue;
		}
		const newSection = normalizeTopicToSectionName(rawTopicPhrase);
		if (newSection === GENERAL_SECTION || newSection === metadata.section_name) {
			report.unchanged += 1;
			continue;
		}
		const targetFactKey = deriveFactKey({ kind: "profile", section_name: newSection });
		if (!targetFactKey) {
			report.rejected += 1;
			continue;
		}
		const planKey = `${source.projectId}\u0000${targetFactKey}`;
		targetKeys.add(planKey);
		const existingTarget = store.getByFactKey(source.projectId, targetFactKey);
		if (existingTarget) {
			try {
				parseInsightMetadata(existingTarget.metadata, existingTarget);
			} catch {
				report.rejected += 1;
				continue;
			}
		}
		const kind = existingTarget || plannedTargets.has(planKey) ? "merge" : "migrate";
		if (kind === "merge" && !hasMergeablePreferenceClause(metadata.l2_content)) {
			report.rejected += 1;
			continue;
		}
		actions.push({ kind, source, targetFactKey, newSection });
		plannedTargets.add(planKey);
		if (kind === "merge") {
			report.collisions += 1;
			report.merged += 1;
		} else {
			report.migrated += 1;
		}
	}

	report.targetKeys = targetKeys.size;
	report.finalCount = activeRows.length - report.merged;
	return { report, actions, projectIdFilter };
}

export async function applyRekeyPlan(
	store: MemoryStore,
	plan: RekeyPlan,
): Promise<BProfileSectionRekeyReport> {
	if (plan.actions.length === 0) return plan.report;

	let migrated = 0;
	let merged = 0;
	for (const action of plan.actions) {
		const source = store.getById(action.source.id);
		if (
			!source ||
			source.contentHash !== action.source.contentHash ||
			source.metadata !== action.source.metadata ||
			!sourceStillMatchesPlan(source, action.newSection)
		) {
			throwReconciliationError("source row changed after dry run", action);
		}
		const target = store.getByFactKey(source.projectId, action.targetFactKey);
		if (action.kind === "migrate") {
			if (target) throwReconciliationError("unexpected target appeared after dry run", action);
			await rekeyInPlace(store, source, action.newSection);
			migrated += 1;
			continue;
		}
		if (!target) throwReconciliationError("expected collision target disappeared", action);
		await mergeCollision(store, source, target, action.newSection);
		merged += 1;
	}

	const finalRows = await listAllProfileRows(store, plan.projectIdFilter);
	const finalCount = finalRows.filter((row) => {
		const parsed = parseRow(row);
		return parsed?.metadata.invalidated_at === undefined;
	}).length;
	return {
		...plan.report,
		migrated,
		merged,
		collisions: merged,
		finalCount,
	};
}

async function rekeyInPlace(
	store: MemoryStore,
	source: MemoryEntry,
	newSection: string,
	expectTargetAbsent = true,
): Promise<void> {
	const targetFactKey = deriveFactKey({ kind: "profile", section_name: newSection });
	if (!targetFactKey) throw new Error(`B-profile section re-key target '${newSection}' is invalid`);
	const updated = await store.update(source.id, {
		writerAuthority: "profile-writer",
		metadata: metadataForSection(source, newSection),
		expectedContentHash: source.contentHash,
		expectedMetadata: source.metadata,
		...(expectTargetAbsent ? { expectedAbsentFactKey: targetFactKey } : {}),
	});
	if (!updated) throw new Error(`B-profile section re-key source '${source.id}' disappeared`);
}

function metadataForSection(source: MemoryEntry, newSection: string): string {
	const metadata = buildInsightMetadata(source, {
		...parseInsightMetadata(source.metadata, source),
		section_name: newSection,
	});
	const nextMetadata: Record<string, unknown> = { ...metadata };
	delete nextMetadata[MISSING_TOPIC_FLAG];
	return stringifyInsightMetadata(nextMetadata);
}

async function mergeCollision(
	store: MemoryStore,
	source: MemoryEntry,
	target: MemoryEntry,
	newSection: string,
): Promise<void> {
	const sourceMetadata = parseInsightMetadata(source.metadata, source);
	const targetMetadata = parseInsightMetadata(target.metadata, target);
	const sourceContent = sourceMetadata.l2_content;
	const targetContent = targetMetadata.l2_content;
	const normalizedTargetContent = combineUniquePreferenceClauses(targetContent);
	const mergedContent = combineUniquePreferenceClauses(targetContent, sourceContent);
	const at = Math.max(Date.now(), source.timestamp, target.timestamp);

	if (mergedContent === normalizedTargetContent) {
		const targetFactKey = deriveFactKey({ kind: "profile", section_name: newSection });
		if (!targetFactKey) {
			throw new Error(`B-profile section re-key target '${newSection}' is invalid`);
		}
		const preserved = await store.supersede({
			create: {
				text: target.text,
				category: target.category,
				projectId: target.projectId,
				importance: target.importance,
				timestamp: target.timestamp,
				metadata: target.metadata,
				trusted: true,
			},
			closes: [closeSource(source, newSection, at)],
			activeFactGuard: {
				factKey: targetFactKey,
				expectedId: target.id,
			},
			preserveExisting: {
				id: target.id,
				expectedContentHash: target.contentHash,
				expectedMetadata: target.metadata,
			},
		});
		if (preserved.id !== target.id) {
			throw new Error("B-profile section re-key exact target was not preserved");
		}
		return;
	}

	const abstract = firstSentence(mergedContent);
	// Merging two sections into one can cross the per-record ceiling the store refuses to write.
	const boundedContent = boundSectionContent(
		mergedContent,
		abstract,
		await recordTokenCounter(store.embedder),
	);
	const replacementMetadata = buildInsightMetadata(
		{ text: boundedContent, category: "profile", timestamp: at },
		{
			...metadataForMergeProduct(targetMetadata),
			l0_abstract: abstract,
			l1_overview: boundedContent,
			l2_content: boundedContent,
			section_name: newSection,
			supersedes: target.id,
			valid_from: at,
			asserted_at: at,
		},
	);
	await store.supersede({
		create: {
			text: buildIndexedText(abstract, boundedContent),
			category: "profile",
			projectId: target.projectId,
			importance: Math.max(source.importance, target.importance),
			timestamp: at,
			metadata: stringifyInsightMetadata(replacementMetadata),
			trusted: true,
		},
		closes: [closeTarget(target, at), closeSource(source, newSection, at)],
	});
}

function metadataForMergeProduct(
	metadata: ReturnType<typeof parseInsightMetadata>,
): Record<string, unknown> {
	const product: Record<string, unknown> = { ...metadata };
	delete product.idempotency_key;
	delete product.merge_lineage;
	delete product.mappedKind;
	if (product.source === "agent_end") {
		for (const key of [
			"source",
			"role",
			"session_key",
			"session_id",
			"chunk_index",
			"chunk_count",
			"chunking_version",
			"content_type",
		]) {
			delete product[key];
		}
	}
	return product;
}

function closeSource(source: MemoryEntry, newSection: string, at: number) {
	return {
		id: source.id,
		expectedContentHash: source.contentHash,
		expectedMetadata: source.metadata,
		buildMetadata: (createdId: string): string =>
			closedMetadata(source, createdId, at, newSection, true),
	};
}

function closeTarget(target: MemoryEntry, at: number) {
	return {
		id: target.id,
		expectedContentHash: target.contentHash,
		expectedMetadata: target.metadata,
		buildMetadata: (createdId: string): string =>
			closedMetadata(target, createdId, at, undefined, false),
	};
}

function closedMetadata(
	row: MemoryEntry,
	createdId: string,
	at: number,
	sectionName: string | undefined,
	dropMissingTopicFlag: boolean,
): string {
	const current = parseInsightMetadata(row.metadata, row);
	const metadata = buildInsightMetadata(row, {
		...current,
		...(sectionName ? { section_name: sectionName } : {}),
		invalidated_at: current.valid_from === undefined ? at : Math.max(at, current.valid_from),
		superseded_by: createdId,
	});
	const nextMetadata: Record<string, unknown> = { ...metadata };
	if (dropMissingTopicFlag) delete nextMetadata[MISSING_TOPIC_FLAG];
	return stringifyInsightMetadata(nextMetadata);
}

type ParsedRow = {
	entry: MemoryEntry;
	metadata: ReturnType<typeof parseInsightMetadata>;
	sectionName: string;
};

function parseRow(entry: MemoryEntry): ParsedRow | undefined {
	try {
		const metadata = parseInsightMetadata(entry.metadata, entry);
		if (typeof metadata.section_name !== "string") return undefined;
		return { entry, metadata, sectionName: metadata.section_name };
	} catch {
		return undefined;
	}
}

async function listAllProfileRows(
	store: MemoryStore,
	projectIdFilter: string[] | undefined,
): Promise<MemoryEntry[]> {
	const rows: MemoryEntry[] = [];
	for (let offset = 0; ; offset += MAX_LIST_LIMIT) {
		const page = await store.list({
			category: "profile",
			limit: MAX_LIST_LIMIT,
			offset,
			...(projectIdFilter === undefined ? {} : { projectIdFilter }),
		});
		if (page.length === 0) return rows;
		rows.push(...page);
	}
}

function sourceStillMatchesPlan(source: MemoryEntry, newSection: string): boolean {
	const metadata = parseInsightMetadata(source.metadata, source);
	const rawTopicPhrase = metadata.rawTopicPhrase;
	return (
		metadata.invalidated_at === undefined &&
		metadata.section_name === GENERAL_SECTION &&
		typeof rawTopicPhrase === "string" &&
		normalizeTopicToSectionName(rawTopicPhrase) === newSection
	);
}

function assertPlanReconciles(report: BProfileSectionRekeyReport): void {
	const classified =
		report.migrated +
		report.merged +
		report.rejected +
		report.missingRawPhrase +
		report.unchanged;
	if (classified === report.sourceRows) return;
	log.error("B-profile section re-key dry-run counts do not reconcile", report, {
		event_name: "sno_station_mem.b-profile-section-rekey.b.profile.section.re.key.dry.run.counts.do.not.reconcile",
		file: "packages/sno-station-mem/src/engine/extraction/b-profile-section-rekey.ts",
		function: "assertPlanReconciles",
		site_id: "b-profile-section-rekey.assertPlanReconciles.03748b5c20",
	});
	throw new Error("B-profile section re-key dry-run counts do not reconcile");
}

function assertCanonicalPlanReconciles(plan: CanonicalRepairPlan): void {
	const plannedRows = plan.actions.reduce((count, action) => count + action.sources.length, 0);
	if (plannedRows + plan.report.unchanged === plan.report.sourceRows) return;
	log.error("B-profile canonical-form repair dry-run counts do not reconcile", plan.report, {
		event_name: "sno_station_mem.b-profile-section-rekey.b.profile.canonical.form.repair.dry.run.counts.do.not.reconcile",
		file: "packages/sno-station-mem/src/engine/extraction/b-profile-section-rekey.ts",
		function: "assertCanonicalPlanReconciles",
		site_id: "b-profile-section-rekey.assertCanonicalPlanReconciles.2ad72089d1",
	});
	throw new Error("B-profile canonical-form repair dry-run counts do not reconcile");
}

function throwReconciliationError(reason: string, action: PlannedAction): never {
	log.error("B-profile section re-key aborted after dry-run divergence", {
		reason_code: reason.replace(/[^a-z0-9]+/gi, "_").toLowerCase(),
		memory_id: action.source.id,
		projectId: action.source.projectId,
		targetFactKey: action.targetFactKey,
	}, {
		event_name: "sno_station_mem.b-profile-section-rekey.b.profile.section.re.key.aborted.after.dry.run.divergence",
		file: "packages/sno-station-mem/src/engine/extraction/b-profile-section-rekey.ts",
		function: "throwReconciliationError",
		site_id: "b-profile-section-rekey.throwReconciliationError.b59b599311",
	});
	throw new Error(`B-profile section re-key aborted: ${reason}`);
}

function reportsEqual(
	left: BProfileSectionRekeyReport,
	right: BProfileSectionRekeyReport,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function combineReports(
	left: BProfileSectionRekeyReport,
	right: BProfileSectionRekeyReport,
): BProfileSectionRekeyReport {
	return {
		sourceRows: Math.max(left.sourceRows, right.sourceRows),
		targetKeys: left.targetKeys + right.targetKeys,
		collisions: left.collisions + right.collisions,
		migrated: left.migrated + right.migrated,
		merged: left.merged + right.merged,
		rejected: left.rejected + right.rejected,
		missingRawPhrase: left.missingRawPhrase + right.missingRawPhrase,
		unchanged: left.unchanged + right.unchanged,
		finalCount: right.finalCount,
		separatorSplitGroups: left.separatorSplitGroups + right.separatorSplitGroups,
		domainPrefixSplitGroups:
			left.domainPrefixSplitGroups + right.domainPrefixSplitGroups,
		crossPathSplitGroups: left.crossPathSplitGroups + right.crossPathSplitGroups,
	};
}

function emptyReport(): BProfileSectionRekeyReport {
	return {
		sourceRows: 0,
		targetKeys: 0,
		collisions: 0,
		migrated: 0,
		merged: 0,
		rejected: 0,
		missingRawPhrase: 0,
		unchanged: 0,
		finalCount: 0,
		separatorSplitGroups: 0,
		domainPrefixSplitGroups: 0,
		crossPathSplitGroups: 0,
	};
}

function compareRows(left: ParsedRow, right: ParsedRow): number {
	return (
		left.entry.projectId.localeCompare(right.entry.projectId) ||
		left.entry.timestamp - right.entry.timestamp ||
		left.entry.id.localeCompare(right.entry.id)
	);
}

function combineUniquePreferenceClauses(...texts: string[]): string {
	const seen = new Set<string>();
	const clauses: string[] = [];
	for (const text of texts) {
		for (const clause of splitPreferenceClauses(text)) {
			const key = normalizeClause(clause);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			clauses.push(clause);
		}
	}
	return clauses.join("\n");
}

function hasMergeablePreferenceClause(text: string): boolean {
	return splitPreferenceClauses(text).some((clause) => normalizeClause(clause).length > 0);
}

function splitPreferenceClauses(text: string): string[] {
	return text
		.split(/\n+|(?<=[.!?])\s+/)
		.map((item) => item.trim())
		.filter(Boolean);
}

/**
 * Clause identity for dedup and for the exact-match check that decides which row survives a
 * merge. Case, Unicode form and whitespace do not change what a clause says, so they are
 * normalized away — and nothing else is.
 *
 * This used to delete every non-alphanumeric character, which merged clauses stating different
 * facts: "I use C." and "I use C++." both became "i use c", so one of the two preferences was
 * closed as a duplicate of the other and the count check still passed. Every symbol that
 * distinguishes a name — `+`, `#`, `/`, `.` inside a word — is meaning, not formatting.
 * A trailing sentence terminator is not, so the same clause with and without its full stop
 * stays one clause.
 */
function normalizeClause(text: string): string {
	const normalized = text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[.!?]+$/u, "")
		.trim();
	// A clause carrying no letter and no digit says nothing. Keeping it empty preserves the
	// emptiness the old rule produced, so punctuation-only fragments still drop out of the
	// dedup and out of `hasMergeablePreferenceClause`.
	return /[\p{L}\p{N}]/u.test(normalized) ? normalized : "";
}

function firstSentence(text: string): string {
	return text.split(/(?<=[.!?])\s+/)[0]?.trim() || text;
}
