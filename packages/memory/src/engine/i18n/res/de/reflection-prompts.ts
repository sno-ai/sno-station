/** @file reflection-prompts.ts (de, Deutsch)
 * @purpose Builds reflection prompt + fallback text for the reflection pipeline (de locale).
 * @see ../../../daily-log-generator/daily-log-generator.ts.
 *
 * Translation policy: Prosa auf Deutsch; machine-contract Headings
 * (`## Context`, `## Invariants`, `## Derived`, `## Decisions (durable)`,
 * `## Open loops / next actions` etc.) MÜSSEN auf Englisch bleiben, da
 * markdown-slice-parser.ts diese englischen Headings parst.
 */

import type { ReflectionErrorSignalLike } from "../_types";

const REFLECTION_FALLBACK_MARKER =
	"(fallback) Reflection-Generierung fehlgeschlagen; nur Minimalverweis gespeichert.";

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
			: "- (keine)";

	return [
		"Du erstellst einen dauerhaften MEMORY REFLECTION-Eintrag für ein KI-Assistenzsystem.",
		"Richte dich nach einem Self-Improvement-Workflow: governance -> distill -> promote.",
		"",
		"Ziel: Extrahiere wissensreiches und reflexives Material. Kopiere KEINE Rohtranskripte.",
		"Schreibe AUSSCHLIESSLICH Markdown. Sei knapp aber informationsdicht.",
		"",
		"Harte Regeln:",
		"- Kopiere KEINE langen Zitate aus der Konversation.",
		"- Extrahiere Entscheidungen, Präferenzen, Lektionen, Fallstricke und nächste Schritte.",
		"- Falls Geheimnisse/Tokens/Passwörter erscheinen, behalte sie als [REDACTED_SECRET] (niemals rekonstruieren).",
		"- Falls Tool-Fehler auftraten, wandle sie in umsetzbare learning/error-Kandidaten um.",
		"",
		"Ausgabesektionen (verwende exakt diese englischen Überschriften):",
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
		"Hinweise zu den letzten beiden Sektionen (kurz halten):",
		"- Invariants = nur stabile sitzungsübergreifende Regeln. Jeder Bullet muss wie eine Regel/Policy klingen, nicht wie ein Tagebucheintrag.",
		"- Schreibe Invariants in ausführbarer Regelform, z. B.: Always / Never / When X, do Y / Prefer / Avoid / Require.",
		"- Stecke KEINE einmaligen Beobachtungen, temporären Follow-ups oder vagen Reflexionen in Invariants.",
		"- Derived = nur Deltas dieses Laufs. Behalte nur Änderungen, die DIESER Lauf zeigt und die den NÄCHSTEN Lauf beeinflussen sollen.",
		"- Schreibe Derived-Bullets als konkrete next-run Anpassungen, z. B.: This run showed ... / Next run ... / Re-check ... / Avoid repeating ...",
		"- Wiederhole KEINE langfristigen Regeln in Derived.",
		"",
		"Für 'Learning governance candidates' bevorzuge folgende Struktur:",
		"- LRN candidate(s): correction / best_practice / knowledge_gap",
		"- ERR candidate(s): reproduzierbare Failure-Signature + Fix",
		"- FEAT candidate(s): fehlende Capability-Anforderung",
		"- Promotion candidates: AGENTS.md / SOUL.md / TOOLS.md prägnante Regeln",
		"- Skill extraction candidate: Name + warum wiederverwendbar + Source learning id Platzhalter",
		"",
		"Aktuelle Tool-Fehlersignale (PostToolUse-style detector):",
		errorHints,
		"",
		"INPUT (bereinigte aktuelle Konversation; mit Rollenpräfix):",
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
		"- (nichts erfasst)",
		"",
		"## User model deltas (about the human)",
		"- (nichts erfasst)",
		"",
		"## Agent model deltas (about the assistant/system)",
		"- (nichts erfasst)",
		"",
		"## Lessons & pitfalls (symptom / cause / fix / prevention)",
		"- (nichts erfasst)",
		"",
		"## Learning governance candidates (.learnings / promotion / skill extraction)",
		"- ERR candidate: letzten fehlgeschlagenen Tool-Aufruf untersuchen und in .learnings/ERRORS.md protokollieren",
		"",
		"## Open loops / next actions",
		"- Untersuchen, warum die eingebettete Reflection-Generierung fehlgeschlagen ist.",
		"",
		"## Retrieval tags / keywords",
		"- memory-reflection",
		"",
		"## Invariants",
		"- (nichts erfasst)",
		"",
		"## Derived",
		"- Untersuchen, warum die eingebettete Reflection-Generierung fehlgeschlagen ist, bevor irgendein next-run Delta vertraut wird.",
	].join("\n");
}
