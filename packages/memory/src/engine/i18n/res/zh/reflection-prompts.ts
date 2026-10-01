/** @file reflection-prompts.ts
 * @purpose Builds reflection prompt + fallback text for the reflection pipeline (zh locale, 简体中文).
 * @see ../../../daily-log-generator/daily-log-generator.ts.
 *
 * Translation policy: prose 用简体中文；machine-contract headings
 * (`## Context`, `## Invariants`, `## Derived`, `## Decisions (durable)`,
 * `## Open loops / next actions` 等) 必须保留英文，因为
 * markdown-slice-parser.ts 用英文 heading 解析。
 */

import type { ReflectionErrorSignalLike } from "../_types";

const REFLECTION_FALLBACK_MARKER = "(fallback) 反思生成失败，仅存储最小占位记录。";

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
			: "- (无)";

	return [
		"你正在为一个 AI 助理系统生成一条持久化的 MEMORY REFLECTION 记录。",
		"对齐 self-improvement 工作流：governance -> distill -> promote。",
		"",
		"目标：抽取高信号的知识与反思素材。不要粘贴原始对话。",
		"输出仅使用 Markdown。简洁但信息密度高。",
		"",
		"硬性规则：",
		"- 不要从对话中抄录长引文。",
		"- 抽取决策、偏好、教训、陷阱与下一步行动。",
		"- 如果出现密钥/令牌/密码，保留为 [REDACTED_SECRET]（永远不要还原）。",
		"- 如果出现工具失败，转化为可执行的 learning/error 候选。",
		"",
		"输出小节（必须使用以下精确英文标题）:",
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
		"对最后两节的指引（保持简短）：",
		"- Invariants = 仅记录跨会话稳定的规则。每条 bullet 必须读起来像规则/政策，不是日记。",
		"- Invariants 用可执行规则形式书写，例如：Always / Never / When X, do Y / Prefer / Avoid / Require。",
		"- 不要把一次性观察、临时跟进或模糊反思放进 Invariants。",
		"- Derived = 仅当次运行的增量。只保留本次运行暴露、且应影响下一次运行的变更。",
		"- Derived 写成具体的下一次运行调整，例如：This run showed ... / Next run ... / Re-check ... / Avoid repeating ...",
		"- 不要在 Derived 中重述长期规则。",
		"",
		"对 'Learning governance candidates'，建议使用以下结构：",
		"- LRN candidate(s)：correction / best_practice / knowledge_gap",
		"- ERR candidate(s)：可复现的失败 signature + 修复方案",
		"- FEAT candidate(s)：缺失能力的需求",
		"- Promotion candidates：AGENTS.md / SOUL.md / TOOLS.md 的简洁规则",
		"- Skill extraction candidate：名称 + 为何可复用 + 来源 learning id 占位",
		"",
		"近期工具错误信号（PostToolUse 风格的检测器输出）：",
		errorHints,
		"",
		"INPUT（清洗后的最近对话；按角色前缀标注）：",
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
		"- (未捕获)",
		"",
		"## User model deltas (about the human)",
		"- (未捕获)",
		"",
		"## Agent model deltas (about the assistant/system)",
		"- (未捕获)",
		"",
		"## Lessons & pitfalls (symptom / cause / fix / prevention)",
		"- (未捕获)",
		"",
		"## Learning governance candidates (.learnings / promotion / skill extraction)",
		"- ERR candidate：调查上一次失败的工具调用，并记录到 .learnings/ERRORS.md",
		"",
		"## Open loops / next actions",
		"- 调查嵌入式 reflection 生成失败的原因。",
		"",
		"## Retrieval tags / keywords",
		"- memory-reflection",
		"",
		"## Invariants",
		"- (未捕获)",
		"",
		"## Derived",
		"- 调查嵌入式 reflection 生成失败的原因，再信任任何下一次运行的 delta。",
	].join("\n");
}
