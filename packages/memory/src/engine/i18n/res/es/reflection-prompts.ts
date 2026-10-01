/** @file reflection-prompts.ts (es, Español)
 * @purpose Builds reflection prompt + fallback text for the reflection pipeline (es locale).
 * @see ../../../daily-log-generator/daily-log-generator.ts.
 *
 * Translation policy: prosa en español; los encabezados de contrato de máquina
 * (`## Context`, `## Invariants`, `## Derived`, `## Decisions (durable)`,
 * `## Open loops / next actions`, etc.) DEBEN permanecer en inglés porque
 * markdown-slice-parser.ts los analiza en inglés.
 */

import type { ReflectionErrorSignalLike } from "../_types";

const REFLECTION_FALLBACK_MARKER =
	"(fallback) Falló la generación de la reflexión; solo se almacena un puntero mínimo.";

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
			: "- (ninguno)";

	return [
		"Estás generando una entrada persistente de MEMORY REFLECTION para un sistema asistente de IA.",
		"Alíneate con un flujo de auto-mejora: governance -> distill -> promote.",
		"",
		"Objetivo: extrae material de conocimiento y reflexión de alta señal. NO pegues transcripciones brutas.",
		"Escribe SOLO Markdown. Sé conciso pero denso en información.",
		"",
		"Reglas estrictas:",
		"- NO copies citas largas de la conversación.",
		"- Extrae decisiones, preferencias, lecciones, trampas y próximos pasos.",
		"- Si aparecen secretos/tokens/contraseñas, mantenlos como [REDACTED_SECRET] (nunca reconstruir).",
		"- Si ocurrieron fallos de herramientas, conviértelos en candidatos accionables de learning/error.",
		"",
		"Secciones de salida (usa exactamente estos encabezados en inglés):",
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
		"Indicaciones para las dos últimas secciones (mantenerlas breves):",
		"- Invariants = solo reglas estables entre sesiones. Cada bullet debe leerse como regla/política, no como diario.",
		"- Escribe Invariants en forma de regla ejecutable, p. ej.: Always / Never / When X, do Y / Prefer / Avoid / Require.",
		"- NO pongas observaciones puntuales, follow-ups temporales ni reflexiones vagas en Invariants.",
		"- Derived = solo deltas de esta ejecución. Conserva únicamente cambios que ESTA ejecución reveló y que deberían influir en la PRÓXIMA.",
		"- Escribe los bullets de Derived como ajustes concretos para la próxima ejecución, p. ej.: This run showed ... / Next run ... / Re-check ... / Avoid repeating ...",
		"- NO repitas reglas de largo plazo en Derived.",
		"",
		"Para 'Learning governance candidates', prefiere esta estructura:",
		"- LRN candidate(s): correction / best_practice / knowledge_gap",
		"- ERR candidate(s): firma de fallo reproducible + corrección",
		"- FEAT candidate(s): requisito de capacidad faltante",
		"- Promotion candidates: reglas concisas para AGENTS.md / SOUL.md / TOOLS.md",
		"- Skill extraction candidate: nombre + por qué es reutilizable + marcador de id de learning fuente",
		"",
		"Señales recientes de error de herramientas (estilo detector PostToolUse):",
		errorHints,
		"",
		"INPUT (conversación reciente saneada; con prefijo de rol):",
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
		"- (no capturado)",
		"",
		"## User model deltas (about the human)",
		"- (no capturado)",
		"",
		"## Agent model deltas (about the assistant/system)",
		"- (no capturado)",
		"",
		"## Lessons & pitfalls (symptom / cause / fix / prevention)",
		"- (no capturado)",
		"",
		"## Learning governance candidates (.learnings / promotion / skill extraction)",
		"- ERR candidate: investigar la última llamada de herramienta fallida y registrarla en .learnings/ERRORS.md",
		"",
		"## Open loops / next actions",
		"- Investigar por qué falló la generación de reflexión embebida.",
		"",
		"## Retrieval tags / keywords",
		"- memory-reflection",
		"",
		"## Invariants",
		"- (no capturado)",
		"",
		"## Derived",
		"- Investigar por qué falló la generación de reflexión embebida antes de confiar en cualquier delta de la próxima ejecución.",
	].join("\n");
}
