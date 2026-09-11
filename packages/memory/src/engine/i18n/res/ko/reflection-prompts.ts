/** @file reflection-prompts.ts (ko, 한국어)
 * @purpose Builds reflection prompt + fallback text for the reflection pipeline (ko locale).
 * @see ../../../daily-log-generator/daily-log-generator.ts.
 *
 * Translation policy: 산문은 한국어. machine-contract 헤더
 * (`## Context`, `## Invariants`, `## Derived`, `## Decisions (durable)`,
 * `## Open loops / next actions` 등) 은 markdown-slice-parser.ts 가
 * 영어 헤더로 파싱하므로 반드시 영어 그대로 유지할 것.
 */

import type { ReflectionErrorSignalLike } from "../_types";

const REFLECTION_FALLBACK_MARKER = "(fallback) 리플렉션 생성 실패; 최소 포인터만 저장.";

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
			: "- (없음)";

	return [
		"당신은 AI 어시스턴트 시스템을 위한 영구 MEMORY REFLECTION 항목을 생성하고 있습니다.",
		"자기 개선 워크플로 governance -> distill -> promote 에 정렬하십시오.",
		"",
		"목표: 신호가 강한 지식과 반성 자료를 추출. 원시 대화 사본을 붙여넣지 마십시오.",
		"출력은 Markdown 만 사용. 간결하지만 정보 밀도는 높게.",
		"",
		"엄격한 규칙:",
		"- 대화의 긴 인용을 복사하지 마십시오.",
		"- 결정, 선호, 교훈, 함정, 다음 단계를 추출하십시오.",
		"- 비밀/토큰/비밀번호가 나타나면 [REDACTED_SECRET] 그대로 유지 (절대 복원 금지).",
		"- 도구 실패가 있었다면 실행 가능한 learning/error 후보로 변환하십시오.",
		"",
		"출력 섹션 (정확히 다음 영어 헤더를 사용하십시오):",
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
		"마지막 두 섹션 가이드 (짧게 유지):",
		"- Invariants = 세션 간 안정된 규칙만. 각 bullet 은 일기가 아닌 규칙/정책처럼 읽혀야 합니다.",
		"- Invariants 는 실행 가능한 규칙 형식으로 작성: Always / Never / When X, do Y / Prefer / Avoid / Require.",
		"- 일회성 관찰, 임시 후속 작업, 모호한 반성을 Invariants 에 넣지 마십시오.",
		"- Derived = 이번 실행의 델타만. 이번 실행이 드러내고 다음 실행에 영향을 줘야 할 변경만 유지.",
		"- Derived bullet 은 다음 실행을 위한 구체적 조정으로 작성: This run showed ... / Next run ... / Re-check ... / Avoid repeating ...",
		"- 장기 규칙을 Derived 에서 반복하지 마십시오.",
		"",
		"'Learning governance candidates' 에는 다음 구조를 권장:",
		"- LRN candidate(s): correction / best_practice / knowledge_gap",
		"- ERR candidate(s): 재현 가능한 실패 signature + 수정",
		"- FEAT candidate(s): 누락된 capability 요구사항",
		"- Promotion candidates: AGENTS.md / SOUL.md / TOOLS.md 의 간결한 규칙",
		"- Skill extraction candidate: 이름 + 재사용 가능한 이유 + 소스 learning id 자리 표시자",
		"",
		"최근 도구 오류 시그널 (PostToolUse 스타일 감지기 출력):",
		errorHints,
		"",
		"INPUT (정제된 최근 대화; 역할 접두사 포함):",
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
		"- (캡처되지 않음)",
		"",
		"## User model deltas (about the human)",
		"- (캡처되지 않음)",
		"",
		"## Agent model deltas (about the assistant/system)",
		"- (캡처되지 않음)",
		"",
		"## Lessons & pitfalls (symptom / cause / fix / prevention)",
		"- (캡처되지 않음)",
		"",
		"## Learning governance candidates (.learnings / promotion / skill extraction)",
		"- ERR candidate: 마지막으로 실패한 도구 호출을 조사하고 .learnings/ERRORS.md 에 기록",
		"",
		"## Open loops / next actions",
		"- 임베디드 reflection 생성 실패 원인을 조사.",
		"",
		"## Retrieval tags / keywords",
		"- memory-reflection",
		"",
		"## Invariants",
		"- (캡처되지 않음)",
		"",
		"## Derived",
		"- 임베디드 reflection 생성 실패 원인을 조사한 후에야 다음 실행의 어떤 delta 든 신뢰할 것.",
	].join("\n");
}
