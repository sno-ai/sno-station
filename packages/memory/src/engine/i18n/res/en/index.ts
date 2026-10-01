import type { LocaleResources } from "../_types";
import { defineLocaleResources } from "../locale-resource-helpers";
import { buildDateResolutionPrompt } from "../date-resolution-prompt";
import { buildDedupPrompt, buildExtractionPrompt } from "./extraction-prompts";
import { buildReflectionFallbackText, buildReflectionPrompt } from "./reflection-prompts";

const captureTriggers = {
	identityPattern:
		/\b(my name is|i am|i'm|i live in|i work at|my role is|my email is|my phone is|allergic to)\b/i,
	preferencePattern:
		/\b(i|we)\s+(prefer|like|love|hate|want|need|care about)\b|\b(favou?rite|preferred)\b/i,
	entityPattern:
		/\+\d{10,}|[\w.-]+@[\w.-]+\.\w+|\b(project|team|company|organization|manager|spouse|wife|husband|son|daughter|pet|repo|service)\b/i,
	eventPattern:
		/\b(decided|chose|switched|migrated|shipped|released|deployed|incident|happened|will use|we'll use|going forward|from now on)\b/i,
	lessonPattern:
		/\b(learned|lesson|next time|mistake|avoid|never again|root cause|fix was|solution was|sop)\b/i,
	explicitMemoryCommandPositivePatterns: [
		/^\s*(?:please\s+)?remember\b/i,
		/^\s*(?:please\s+)?(?:save|store)\b[^\n]{0,200}\b(?:as|to|in)\s+(?:a\s+|an\s+)?(?:long[- ]term\s+)?memor(?:y|ies)\b/i,
		/^\s*(?:please\s+)?(?:save|store)\b[^\n]{0,200}\b(?:for\s+later|future\s+recall)\b/i,
	],
	explicitMemoryCommandRecallQuestionPatterns: [
		/^\s*(?:do|did|can|could|would|will|what|where|when|why|how|have|has|is|are)\b.{0,80}\b(?:remember|recall|memor(?:y|ies))\b/i,
	],
	explicitMemoryCommandManagementPatterns: [
		/^\s*(?:please\s+)?(?:forget|delete|remove|clear|drop|purge)\b/i,
	],
	weekStartDay: 1,
} as const;

const noise = {
	denialPatterns: [
		/i don'?t have (any )?(information|data|memory|record)/i,
		/i'?m not sure about/i,
		/i don'?t recall/i,
		/i don'?t remember/i,
		/it looks like i don'?t/i,
		/i wasn'?t able to find/i,
		/no (relevant )?memories found/i,
		/i don'?t have access to/i,
	],
	metaQuestionPatterns: [
		/\bdo you (remember|recall|know about)\b/i,
		/\bcan you (remember|recall)\b/i,
		/\bdid i (tell|mention|say|share)\b/i,
		/\bhave i (told|mentioned|said)\b/i,
		/\bwhat did i (tell|say|mention)\b/i,
		/\bwhat\s+(?:is|are)\s+(?:my|our)\b.{0,80}\b(code|identifier|nonce|token|preference|favorite|favourite|saved|remembered|memory|memories)\b/i,
		// i18n-allow: prompt-injection probe pattern; payload is ASCII English by design.
		/\banswer with only\b.{0,80}\b(code|identifier|nonce|token|value|name|color|colour)\b/i,
	],
	metaFrustrationPatterns: [
		/\byou (never|can'?t|cannot|don'?t|do not|won'?t|will not|keep|kept) (remember|recall|forget|forgetting|losing)\b/i,
		/\bwhy (can'?t|cannot|don'?t|do not|won'?t|will not) you (ever |even )?(remember|recall)\b/i,
		/\bwhy do you (keep|always) (forget|forgetting|losing)\b/i,
		/\bdid you (even )?(get|understand|read|remember) what i (said|told you|meant|wrote)\b/i,
		/\bwhy (is|are) (my|the|our) memor(y|ies) (wrong|missing|broken|gone|empty|not working|messed up)\b/i,
		/\bwhat happened to (my|the|our) (saved |stored )?(memor(y|ies)|notes?|data)\b/i,
		/^\s*what (just )?changed\??\s*$/i,
	],
} as const;



const extractionPrompts = {
	buildDateResolutionPrompt,
	buildExtractionPrompt,
	buildDedupPrompt,
} as const;

const reflectionPrompts = {
	buildReflectionPrompt,
	buildReflectionFallbackText,
} as const;

const reflectionSliceClassifiers = {
	invariantSignals: [/\b(always|never|must|should|require|avoid|rule|invariant|decision)\b/i],
	derivedSignals: [
		/\b(this run|next run|learned|observed|reflection|derived|delta|verify|change)\b/i,
	],
	openLoopSignals: [/\b(todo|follow up|next|action|verify|re-check)\b/i],
	invariantLegacySignals: [/\b(always|never|must|should|require|avoid|rule|invariant|decision)\b/i],
	derivedLegacySignals: [
		/\b(this run|next run|learned|observed|reflection|derived|delta|verify|change)\b/i,
	],
} as const;

const toolDescriptions = {
	memoryRecall:
		"Search through long-term memories using precision recall retrieval (vector + keyword search).",
	memoryStore: "Save important information in long-term memory.",
	memoryForget: "Delete specific memories by ID or by query.",
	memoryUpdate: "Update a stored memory by ID.",
	memoryStats: "Show memory usage statistics.",
	memoryList: "List stored memories with pagination and filters.",
} as const;

export const resources: LocaleResources = defineLocaleResources(
	{
		captureTriggers,
		noise,
		toolDescriptions,
		extractionPrompts,
		reflectionPrompts,
	},
	{
		correctionSignals: [
			/\bactually\b(?=.{0,80}\b(?:correct|correction|need|needs|should|must|wrong|not|instead|rather|update|use|set|switch|change|make)\b)/i,
			/\bcorrection\b/i,
			/^\s*(?:no|nah),?\s+(?:use|set|switch|change|make)\b/i,
		],
		ackTokens: [
			/^(got it|understood|ok|okay|sure|thanks|thank you|yep|cool|nice|alright|👍)\s*[.!]?$/i,
		],
		memoryIntent: [/\b(?:remember|don'?t forget|note that)\b/i],
		reflectionSliceClassifiers,
	},
);
