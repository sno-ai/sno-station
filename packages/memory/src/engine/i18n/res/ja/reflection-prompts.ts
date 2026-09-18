/** @file reflection-prompts.ts (ja, 日本語)
 * @purpose Builds reflection prompt + fallback text for the reflection pipeline (ja locale).
 * @see ../../../daily-log-generator/daily-log-generator.ts.
 *
 * Translation policy: 散文は日本語。machine-contract の見出し
 * (`## Context`, `## Invariants`, `## Derived`, `## Decisions (durable)`,
 * `## Open loops / next actions` など) は markdown-slice-parser.ts が
 * 英語見出しでパースするため、必ず英語のままにすること。
 */

import type { ReflectionErrorSignalLike } from "../_types";

const REFLECTION_FALLBACK_MARKER = "(fallback) リフレクション生成に失敗。最小ポインタのみを保存。";

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
			: "- (なし)";

	return [
		"あなたは AI アシスタントシステム向けに永続的な MEMORY REFLECTION エントリを生成しています。",
		"自己改善ワークフロー governance -> distill -> promote に整合させてください。",
		"",
		"目的: 高シグナルの知識・反省素材を抽出する。生のトランスクリプトを貼り付けないこと。",
		"出力は Markdown のみ。簡潔だが情報密度を高く。",
		"",
		"厳守ルール:",
		"- 会話からの長い引用をコピーしない。",
		"- 決定、選好、教訓、落とし穴、次のアクションを抽出する。",
		"- 秘密情報/トークン/パスワードが現れた場合は [REDACTED_SECRET] のまま保持する（決して復元しない）。",
		"- ツール失敗があれば、実行可能な learning/error 候補に変換する。",
		"",
		"出力セクション（次の英語見出しを正確に使うこと）:",
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
		"最後の 2 セクションへの指針（短く保つ）:",
		"- Invariants = セッション横断で安定したルールのみ。各 bullet はルール/ポリシーとして読めること。日記ではない。",
		"- Invariants は実行可能なルール形式で書く。例: Always / Never / When X, do Y / Prefer / Avoid / Require。",
		"- 一回限りの観察、暫定的なフォローアップ、曖昧な反省を Invariants に入れない。",
		"- Derived = 当該実行の差分のみ。今回の実行で明らかになり、次回の実行に影響すべき変更だけ残す。",
		"- Derived の bullet は次回実行への具体的な調整として書く。例: This run showed ... / Next run ... / Re-check ... / Avoid repeating ...",
		"- 長期ルールを Derived で繰り返さない。",
		"",
		"'Learning governance candidates' には以下の構造を推奨:",
		"- LRN candidate(s): correction / best_practice / knowledge_gap",
		"- ERR candidate(s): 再現可能な失敗 signature と修正策",
		"- FEAT candidate(s): 不足している capability 要件",
		"- Promotion candidates: AGENTS.md / SOUL.md / TOOLS.md 用の簡潔なルール",
		"- Skill extraction candidate: 名称 + 再利用可能な理由 + ソース learning id プレースホルダ",
		"",
		"直近のツールエラーシグナル（PostToolUse スタイルの検知器出力）:",
		errorHints,
		"",
		"INPUT（クリーンアップ後の最近の会話、ロールプレフィックス付き）:",
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
		"- (未取得)",
		"",
		"## User model deltas (about the human)",
		"- (未取得)",
		"",
		"## Agent model deltas (about the assistant/system)",
		"- (未取得)",
		"",
		"## Lessons & pitfalls (symptom / cause / fix / prevention)",
		"- (未取得)",
		"",
		"## Learning governance candidates (.learnings / promotion / skill extraction)",
		"- ERR candidate: 直近の失敗したツール呼び出しを調査し、.learnings/ERRORS.md に記録する",
		"",
		"## Open loops / next actions",
		"- 埋め込み reflection 生成の失敗原因を調査する。",
		"",
		"## Retrieval tags / keywords",
		"- memory-reflection",
		"",
		"## Invariants",
		"- (未取得)",
		"",
		"## Derived",
		"- 埋め込み reflection 生成の失敗原因を調査してから、次回実行のいかなる delta も信頼しないこと。",
	].join("\n");
}
