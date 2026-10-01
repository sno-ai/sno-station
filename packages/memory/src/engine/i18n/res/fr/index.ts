import type { LocaleResources } from "../_types";
import { defineLocaleResources } from "../locale-resource-helpers";
import { buildDateResolutionPrompt } from "../date-resolution-prompt";
import { buildDedupPrompt, buildExtractionPrompt } from "./extraction-prompts";
import { buildReflectionFallbackText, buildReflectionPrompt } from "./reflection-prompts";

const captureTriggers = {
	identityPattern:
		/\b(je m'appelle|mon nom est|je suis|je vis à|je vis a|j'habite|je travaille|mon rôle est|mon email est|mon téléphone est|allergique à)\b/i,
	preferencePattern:
		/\b(je|nous)\s+(préfère|préférons|aime|aimons|adore|déteste|veux|voulons|besoin)\b|\b(préfère|préférence|préféré)\b/i,
	entityPattern:
		/\+\d{10,}|[\w.-]+@[\w.-]+\.\w+|\b(projet|équipe|entreprise|organisation|manager|responsable|épouse|mari|fils|fille|animal|repo|service)\b/i,
	eventPattern: /\b(décidé|choisi|changé|migré|publié|déployé|incident|arrivé|désormais)\b/i,
	lessonPattern:
		/\b(appris|leçon|prochaine fois|erreur|éviter|plus jamais|cause racine|la solution était|sop)\b/i,
	explicitMemoryCommandPositivePatterns: [
		/^\s*(?:s'il\s+(?:te|vous)\s+pla[iî]t,?\s+)?(?:souviens-toi|souvenez-vous|mémorise|memorise|retiens|rappelle-toi)\b/i,
		/^\s*(?:enregistre|sauvegarde|conserve)\b[^\n]{0,200}\b(?:comme|en\s+tant\s+que|dans\s+la)\s+(?:une\s+|la\s+)?(?:mémoire|memoire)(?:\s+à\s+long\s+terme)?\b/i,
		/^\s*(?:enregistre|sauvegarde)\b[^\n]{0,200}\bpour\s+plus\s+tard\b/i,
	],
	explicitMemoryCommandRecallQuestionPatterns: [
		/^\s*(?:te\s+souviens-tu|tu\s+te\s+souviens|te\s+rappelles-tu|vous\s+souvenez-vous)\b/i,
		/^\s*peux-tu\s+\S{0,30}\s*te\s+souvenir\b/i,
	],
	explicitMemoryCommandManagementPatterns: [
		/^\s*(?:s'il\s+(?:te|vous)\s+pla[iî]t,?\s+)?(?:oublie|oubliez|supprime|efface|enlève|enleve|vide|jette)\b/i,
	],
	weekStartDay: 1,
} as const;

const noise = {
	denialPatterns: [
		/je n'ai (aucune )?(information|donnée|mémoire|trace)/i,
		/je ne suis pas sûr/i,
		/je ne me rappelle pas/i,
		/je ne me souviens pas/i,
		/il semble que je n'ai pas/i,
		/je n'ai pas pu trouver/i,
		/aucune mémoire (pertinente )?trouvée/i,
		/je n'ai pas accès à/i,
	],
	metaQuestionPatterns: [
		/\btu (te souviens|te rappelles|sais (à propos|sur))\b/i,
		/\bpeux-tu (te souvenir|te rappeler)\b/i,
		/\best-ce que je (t'ai )?(dit|mentionné|partagé|raconté)\b/i,
		/\bje t'ai (déjà )?(dit|mentionné)\b/i,
		/\bqu'est-ce que je (t'ai )?(dit|raconté|mentionné)\b/i,
	],
	metaFrustrationPatterns: [
		/\btu (ne te souviens|te souviens) (jamais|plus de rien)\b/i,
		/\btu oublies (toujours|tout|tout le temps)\b/i,
		/\bpourquoi (tu oublies|tu ne te souviens|tu ne te rappelles)\b/i,
		/\b(ma|la) mémoire (est|ne) (cassée|vide|effacée|marche pas|fonctionne pas)\b/i,
	],
} as const;



const toolDescriptions = {
	memoryRecall:
		"Recherche dans les mémoires à long terme via une récupération précision-rappel (vecteur + recherche par mots-clés).",
	memoryStore: "Enregistre des informations importantes dans la mémoire à long terme.",
	memoryForget: "Supprime des mémoires spécifiques par ID ou par requête.",
	memoryUpdate: "Met à jour une mémoire stockée par ID.",
	memoryStats: "Affiche les statistiques d'utilisation de la mémoire.",
	memoryList: "Liste les mémoires stockées avec pagination et filtres.",
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
	invariantSignals: [/\b(toujours|jamais|doit|devrait|règle|regle|invariant|décision)\b/i],
	derivedSignals: [
		/\b(appris|observé|observe|réflexion|reflexion|dérivé|delta|vérifier|changement)\b/i,
	],
	openLoopSignals: [/\b(todo|suivi|suivant|action|vérifier|verifier|revoir)\b/i],
	invariantLegacySignals: [/\b(toujours|jamais|doit|devrait|règle|regle|invariant|décision)\b/i],
	derivedLegacySignals: [
		/\b(appris|observé|observe|réflexion|reflexion|dérivé|delta|vérifier|changement)\b/i,
	],
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
		correctionSignals: [/en fait/i, /\bcorrection\b/i],
		ackTokens: [/^(compris|ok|okay|d'accord|bien)\s*[.!]?$/i],
		memoryIntent: [/souviens-toi|souviens|mémorise|memorise/i],
		reflectionSliceClassifiers,
	},
);
