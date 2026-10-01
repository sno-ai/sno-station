/** @file reflection-prompts.ts (fr, Français)
 * @purpose Builds reflection prompt + fallback text for the reflection pipeline (fr locale).
 * @see ../../../daily-log-generator/daily-log-generator.ts.
 *
 * Translation policy: prose en français ; les en-têtes de contrat machine
 * (`## Context`, `## Invariants`, `## Derived`, `## Decisions (durable)`,
 * `## Open loops / next actions`, etc.) DOIVENT rester en anglais car
 * markdown-slice-parser.ts les parse en anglais.
 */

import type { ReflectionErrorSignalLike } from "../_types";

const REFLECTION_FALLBACK_MARKER =
	"(fallback) Échec de la génération de la réflexion ; seul un pointeur minimal est stocké.";

export function buildReflectionPrompt(
	conversation: string,
	maxInputChars: number,
	toolErrorSignals: ReadonlyArray<ReflectionErrorSignalLike> = [],
): string {
	void maxInputChars;
	const promptInput = conversation;
	const errorHints =
		toolErrorSignals.length > 0
			? toolErrorSignals
					.map(
						(e, i) => `${i + 1}. [${e.toolName}] ${e.summary} (sig:${e.signatureHash.slice(0, 8)})`,
					)
					.join("\n")
			: "- (aucun)";

	return [
		"Tu génères une entrée MEMORY REFLECTION persistante pour un système assistant IA.",
		"Aligne-toi sur un flux d'auto-amélioration : governance -> distill -> promote.",
		"",
		"Objectif : extraire du matériel de connaissance et de réflexion à fort signal. NE colle PAS la transcription brute.",
		"Écris UNIQUEMENT en Markdown. Sois concis mais dense en information.",
		"",
		"Règles strictes :",
		"- NE copie PAS de longues citations de la conversation.",
		"- Extrais les décisions, préférences, leçons, pièges et prochaines étapes.",
		"- Si des secrets/jetons/mots de passe apparaissent, conserve-les comme [REDACTED_SECRET] (jamais reconstruits).",
		"- Si des erreurs d'outils sont survenues, transforme-les en candidats actionnables learning/error.",
		"",
		"Sections de sortie (utilise exactement ces titres en anglais) :",
		"## Context",
		"## Decisions (durable)",
		"## User model deltas (about the human)",
		"## Agent model deltas (about the assistant/system)",
		"## Lessons & pitfalls (symptom / cause / fix / prevention)",
		"## Learning governance candidates (.learnings / promotion / skill extraction)",
		"## Open loops / next actions",
		"## Retrieval tags / keywords",
		"## Invariants",
		"## Derived",
		"",
		"Indications pour les deux dernières sections (les garder courtes) :",
		"- Invariants = uniquement des règles stables inter-sessions. Chaque puce doit se lire comme une règle/politique, pas un journal.",
		"- Écris les Invariants sous forme de règle exécutable, ex. : Always / Never / When X, do Y / Prefer / Avoid / Require.",
		"- NE place PAS d'observations ponctuelles, de suivis temporaires ou de réflexions floues dans Invariants.",
		"- Derived = uniquement les deltas de cette exécution. Ne garde que les changements que CETTE exécution révèle et qui devraient influencer la PROCHAINE.",
		"- Écris les puces de Derived comme des ajustements concrets pour la prochaine exécution, ex. : This run showed ... / Next run ... / Re-check ... / Avoid repeating ...",
		"- NE répète PAS les règles de long terme dans Derived.",
		"",
		"Pour 'Learning governance candidates', privilégie cette structure :",
		"- LRN candidate(s) : correction / best_practice / knowledge_gap",
		"- ERR candidate(s) : signature d'échec reproductible + correctif",
		"- FEAT candidate(s) : exigence de capacité manquante",
		"- Promotion candidates : règles concises pour AGENTS.md / SOUL.md / TOOLS.md",
		"- Skill extraction candidate : nom + raison de réutilisabilité + placeholder d'id de learning source",
		"",
		"Signaux récents d'erreur d'outils (style détecteur PostToolUse) :",
		errorHints,
		"",
		"INPUT (conversation récente nettoyée ; avec préfixes de rôle) :",
		"```",
		promptInput,
		"```",
	].join("\n");
}

export function buildReflectionFallbackText(): string {
	return [
		"## Context",
		`- ${REFLECTION_FALLBACK_MARKER}`,
		"",
		"## Decisions (durable)",
		"- (non capturé)",
		"",
		"## User model deltas (about the human)",
		"- (non capturé)",
		"",
		"## Agent model deltas (about the assistant/system)",
		"- (non capturé)",
		"",
		"## Lessons & pitfalls (symptom / cause / fix / prevention)",
		"- (non capturé)",
		"",
		"## Learning governance candidates (.learnings / promotion / skill extraction)",
		"- ERR candidate : enquêter sur le dernier appel d'outil échoué et le consigner dans .learnings/ERRORS.md",
		"",
		"## Open loops / next actions",
		"- Enquêter sur la cause de l'échec de la génération de réflexion embarquée.",
		"",
		"## Retrieval tags / keywords",
		"- memory-reflection",
		"",
		"## Invariants",
		"- (non capturé)",
		"",
		"## Derived",
		"- Enquêter sur la cause de l'échec de la génération de réflexion embarquée avant de faire confiance à un quelconque delta de la prochaine exécution.",
	].join("\n");
}
