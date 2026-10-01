/** @file reflection-prompts.ts
 * @purpose Builds reflection prompt + fallback text for the reflection pipeline (zh-Hant locale, 繁體中文).
 * @see ../../../daily-log-generator/daily-log-generator.ts.
 *
 * Translation policy: prose 用繁體中文；machine-contract headings
 * (`## Context`, `## Invariants`, `## Derived`, `## Decisions (durable)`,
 * `## Open loops / next actions` 等) 必須保留英文，因為
 * markdown-slice-parser.ts 用英文 heading 解析。
 */

import type { ReflectionErrorSignalLike } from "../_types";

const REFLECTION_FALLBACK_MARKER = "(fallback) 反思生成失敗，僅儲存最小佔位記錄。";

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
			: "- (無)";

	return [
		"你正在為一個 AI 助理系統生成一條持久化的 MEMORY REFLECTION 記錄。",
		"對齊 self-improvement 工作流程：governance -> distill -> promote。",
		"",
		"目標：抽取高訊號的知識與反思素材。不要貼上原始對話。",
		"輸出僅使用 Markdown。簡潔但訊息密度高。",
		"",
		"硬性規則：",
		"- 不要從對話中抄錄長引文。",
		"- 抽取決策、偏好、教訓、陷阱與下一步行動。",
		"- 如果出現密鑰/權杖/密碼，保留為 [REDACTED_SECRET]（永遠不要還原）。",
		"- 如果出現工具失敗，轉化為可執行的 learning/error 候選。",
		"",
		"輸出小節（必須使用以下精確的英文標題）：",
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
		"對最後兩節的指引（保持簡短）：",
		"- Invariants = 僅記錄跨工作階段穩定的規則。每條 bullet 必須讀起來像規則/政策，不是日記。",
		"- Invariants 用可執行規則形式書寫，例如：Always / Never / When X, do Y / Prefer / Avoid / Require。",
		"- 不要把一次性觀察、暫時跟進或模糊反思放進 Invariants。",
		"- Derived = 僅當次執行的增量。只保留本次執行暴露、且應影響下一次執行的變更。",
		"- Derived 寫成具體的下一次執行調整，例如：This run showed ... / Next run ... / Re-check ... / Avoid repeating ...",
		"- 不要在 Derived 中重述長期規則。",
		"",
		"對 'Learning governance candidates'，建議使用以下結構：",
		"- LRN candidate(s)：correction / best_practice / knowledge_gap",
		"- ERR candidate(s)：可重現的失敗 signature + 修復方案",
		"- FEAT candidate(s)：缺失能力的需求",
		"- Promotion candidates：AGENTS.md / SOUL.md / TOOLS.md 的簡潔規則",
		"- Skill extraction candidate：名稱 + 為何可重用 + 來源 learning id 佔位",
		"",
		"近期工具錯誤訊號（PostToolUse 風格的偵測器輸出）：",
		errorHints,
		"",
		"INPUT（清洗後的最近對話；按角色前綴標註）：",
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
		"- (未擷取)",
		"",
		"## User model deltas (about the human)",
		"- (未擷取)",
		"",
		"## Agent model deltas (about the assistant/system)",
		"- (未擷取)",
		"",
		"## Lessons & pitfalls (symptom / cause / fix / prevention)",
		"- (未擷取)",
		"",
		"## Learning governance candidates (.learnings / promotion / skill extraction)",
		"- ERR candidate：調查上一次失敗的工具呼叫，並記錄到 .learnings/ERRORS.md",
		"",
		"## Open loops / next actions",
		"- 調查嵌入式 reflection 生成失敗的原因。",
		"",
		"## Retrieval tags / keywords",
		"- memory-reflection",
		"",
		"## Invariants",
		"- (未擷取)",
		"",
		"## Derived",
		"- 調查嵌入式 reflection 生成失敗的原因，再信任任何下一次執行的 delta。",
	].join("\n");
}
