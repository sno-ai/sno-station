/** @file reflection-prompts.ts (ru, Русский)
 * @purpose Builds reflection prompt + fallback text for the reflection pipeline (ru locale).
 * @see ../../../daily-log-generator/daily-log-generator.ts.
 *
 * Translation policy: проза на русском; заголовки machine-contract
 * (`## Context`, `## Invariants`, `## Derived`, `## Decisions (durable)`,
 * `## Open loops / next actions` и т. д.) ДОЛЖНЫ оставаться на английском,
 * так как markdown-slice-parser.ts парсит именно английские заголовки.
 */

import type { ReflectionErrorSignalLike } from "../_types";

const REFLECTION_FALLBACK_MARKER =
	"(fallback) Сбой генерации рефлексии; сохранён только минимальный указатель.";

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
			: "- (нет)";

	return [
		"Вы создаёте постоянную запись MEMORY REFLECTION для системы ИИ-ассистента.",
		"Согласуйте с потоком самосовершенствования: governance -> distill -> promote.",
		"",
		"Цель: извлечь высокосигнальный материал знаний и рефлексии. НЕ вставляйте сырые транскрипты.",
		"Пишите ТОЛЬКО Markdown. Кратко, но информационно плотно.",
		"",
		"Жёсткие правила:",
		"- НЕ копируйте длинные цитаты из разговора.",
		"- Извлекайте решения, предпочтения, уроки, ловушки и следующие шаги.",
		"- Если появляются секреты/токены/пароли, сохраняйте как [REDACTED_SECRET] (никогда не восстанавливать).",
		"- Если были сбои инструментов, превратите их в действенные learning/error-кандидаты.",
		"",
		"Разделы вывода (используйте точно эти английские заголовки):",
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
		"Указания к двум последним секциям (держите кратко):",
		"- Invariants = только стабильные межсессионные правила. Каждый bullet должен читаться как правило/политика, а не дневник.",
		"- Пишите Invariants в форме исполняемого правила, например: Always / Never / When X, do Y / Prefer / Avoid / Require.",
		"- НЕ помещайте в Invariants разовые наблюдения, временные follow-up или расплывчатые рефлексии.",
		"- Derived = только дельты этого запуска. Сохраняйте лишь изменения, которые ЭТОТ запуск выявил и которые должны повлиять на СЛЕДУЮЩИЙ.",
		"- Пишите bullets в Derived как конкретные настройки на следующий запуск, например: This run showed ... / Next run ... / Re-check ... / Avoid repeating ...",
		"- НЕ повторяйте долгосрочные правила в Derived.",
		"",
		"Для 'Learning governance candidates' предпочитайте структуру:",
		"- LRN candidate(s): correction / best_practice / knowledge_gap",
		"- ERR candidate(s): воспроизводимая failure-signature + исправление",
		"- FEAT candidate(s): отсутствующее требование к возможности",
		"- Promotion candidates: краткие правила для AGENTS.md / SOUL.md / TOOLS.md",
		"- Skill extraction candidate: имя + почему переиспользуем + плейсхолдер id source learning",
		"",
		"Недавние сигналы ошибок инструментов (детектор PostToolUse-стиля):",
		errorHints,
		"",
		"INPUT (очищенный недавний разговор; с префиксом роли):",
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
		"- (не зафиксировано)",
		"",
		"## User model deltas (about the human)",
		"- (не зафиксировано)",
		"",
		"## Agent model deltas (about the assistant/system)",
		"- (не зафиксировано)",
		"",
		"## Lessons & pitfalls (symptom / cause / fix / prevention)",
		"- (не зафиксировано)",
		"",
		"## Learning governance candidates (.learnings / promotion / skill extraction)",
		"- ERR candidate: расследовать последний неуспешный вызов инструмента и записать в .learnings/ERRORS.md",
		"",
		"## Open loops / next actions",
		"- Расследовать причину сбоя встроенной генерации reflection.",
		"",
		"## Retrieval tags / keywords",
		"- memory-reflection",
		"",
		"## Invariants",
		"- (не зафиксировано)",
		"",
		"## Derived",
		"- Расследовать причину сбоя встроенной генерации reflection прежде чем доверять любой delta следующего запуска.",
	].join("\n");
}
