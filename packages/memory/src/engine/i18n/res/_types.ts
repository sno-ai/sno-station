export type TemporalIntervalAnchor =
	| "today"
	| "yesterday"
	| "tomorrow"
	| "day_after_tomorrow"
	| "this_week"
	| "next_week"
	| "last_week"
	| "this_month"
	| "next_month"
	| "tonight"
	| "this_morning"
	| "recent";

export interface TemporalPhraseRule {
	patterns: ReadonlyArray<RegExp>;
	anchor: TemporalIntervalAnchor;
}

export interface CategoryRoutingNs {
	identity: ReadonlyArray<RegExp>;
	preference: ReadonlyArray<RegExp>;
	entity: ReadonlyArray<RegExp>;
	event: ReadonlyArray<RegExp>;
	lesson: ReadonlyArray<RegExp>;
}

export interface CaptureTriggersNs {
	categoryRouting: CategoryRoutingNs;
	identityPattern: RegExp;
	preferencePattern: RegExp;
	entityPattern: RegExp;
	eventPattern: RegExp;
	lessonPattern: RegExp;
	temporalPhrases?: ReadonlyArray<TemporalPhraseRule>;
	/**
	 * Matches a clock time stated in this locale's own words, e.g. Korean "오후 3시" or "세 시".
	 *
	 * `temporalPhrases` only knows day-sized anchors. A sentence that names a day AND an hour is
	 * therefore only partly readable from the table, and the hour is the part a model has to read.
	 * Declaring the marker here — beside the phrases it qualifies — keeps the natural language in
	 * the locale resource, where a reader of that language can check it, rather than inline in the
	 * resolver.
	 */
	temporalClockTimePattern?: RegExp;
	weekStartDay: 0 | 1 | 2 | 3 | 4 | 5 | 6;
	/**
	 * Native imperative patterns the user issues to explicitly persist a memory
	 * (e.g. English "Remember X", Chinese "记住 X"). Used by the parser's
	 * deterministic fallback when LLM extraction misses an explicit teach.
	 * Each pattern must encode its own gating — bare "save" / "store" variants
	 * are intentionally excluded.
	 */
	explicitMemoryCommandPositivePatterns: ReadonlyArray<RegExp>;
	/**
	 * Native question forms that ask the system to recall a prior memory
	 * (e.g. English "do you remember", Chinese "你还记得...吗"). Must NOT
	 * be treated as a store-imperative.
	 */
	explicitMemoryCommandRecallQuestionPatterns: ReadonlyArray<RegExp>;
	/**
	 * Native verbs that ask the system to drop or clear a memory
	 * (e.g. English "forget", Chinese "忘记"). Must NOT be treated as
	 * a store-imperative.
	 */
	explicitMemoryCommandManagementPatterns: ReadonlyArray<RegExp>;
}

export interface NoiseNs {
	denialPatterns: ReadonlyArray<RegExp>;
	correctionSignals: ReadonlyArray<RegExp>;
	metaQuestionPatterns: ReadonlyArray<RegExp>;
	/** User frustration aimed at the memory system ("you never remember", "why is my memory broken"). */
	metaFrustrationPatterns: ReadonlyArray<RegExp>;
	ackTokens: ReadonlyArray<RegExp>;
	memoryIntent: ReadonlyArray<RegExp>;
}



export interface ToolDescriptionsNs {
	memoryRecall: string;
	memoryStore: string;
	memoryForget: string;
	memoryUpdate: string;
	memoryStats: string;
	memoryList: string;
}

export interface ExtractionPromptsNs {
	buildDateResolutionPrompt(): string;
	buildExtractionPrompt(
		conversationText: string,
		user: string,
		sessionDateTime?: string,
		sessionTimezone?: string,
		activeProfileSectionNames?: readonly string[],
	): string;
	buildDedupPrompt(
		candidateAbstract: string,
		candidateOverview: string,
		candidateContent: string,
		existingMemories: string,
	): string;
}

export interface ReflectionErrorSignalLike {
	toolName: string;
	summary: string;
	signatureHash: string;
}

export interface ReflectionPromptsNs {
	buildReflectionPrompt(
		conversation: string,
		maxInputChars: number,
		toolErrorSignals?: ReadonlyArray<ReflectionErrorSignalLike>,
	): string;
	buildReflectionFallbackText(): string;
}

export interface ReflectionSliceClassifiersNs {
	invariantSignals: ReadonlyArray<RegExp>;
	derivedSignals: ReadonlyArray<RegExp>;
	openLoopSignals: ReadonlyArray<RegExp>;
	invariantLegacySignals: ReadonlyArray<RegExp>;
	derivedLegacySignals: ReadonlyArray<RegExp>;
}

export interface LocaleResources {
	captureTriggers: CaptureTriggersNs;
	noise: NoiseNs;
	toolDescriptions: ToolDescriptionsNs;
	extractionPrompts: ExtractionPromptsNs;
	reflectionPrompts: ReflectionPromptsNs;
	reflectionSliceClassifiers: ReflectionSliceClassifiersNs;
}

export type Namespace = keyof LocaleResources;

export const ALL_NAMESPACES: ReadonlyArray<Namespace> = [
	"captureTriggers",
	"noise",
	"toolDescriptions",
	"extractionPrompts",
	"reflectionPrompts",
	"reflectionSliceClassifiers",
] as const;
