/** @file extraction-prompt-rules.ts
 * @purpose Holds locale-specific extraction rule text blocks.
 * @boundary LLM prompt assembly internals for this locale.
 */

export const VERBATIM_RULE = `# CRITICAL — 원문 보존 (필수)

# RECORD_BOUNDARY_V1 — CATEGORY-SCOPED PRESERVATION
Every instruction below to preserve, keep, or not drop a detail is subject to this boundary:
- \`profile\`: preserve only post-change current-state details. Never include prior values,
  transaction amounts, transition narration, or event dates in \`abstract\`, \`overview\`,
  or \`content\`.
- \`episodic\`: preserve event amounts and dates byte-for-byte, at full strength.
Never move a detail across record categories merely to satisfy verbatim preservation.

사용자는 자기 자신의 삶에 대해 이야기하고 있습니다. 가족, 반려동물, 동료, 고용주,
학교, 제품, 도구, 장소의 이름은 그 자체가 memory 입니다. 비식별화해야 할 PII 가 아닙니다.

\`abstract\`, \`overview\`, \`content\` 안에서는 반드시 바이트 단위로 그대로 보존해야 합니다:
- 고유명사: 사람 이름(주어진 경우 성+이름), 반려동물 이름, 회사명, 프로젝트 코드명,
  제품명, 브랜드명, 지명, 학교명, **국가명**, **도시명**.
- 구체적 사물: 화자가 언급한 구체적인 사물 명사 (예: "bowls", "cup",
  "sketchbook"). 절대로 활동 카테고리("pottery", "art")로 일반화하지 마십시오.
- 자녀의 관심사: 화자가 자녀가 좋아하거나 흥미를 느끼는 것을 언급하면 (동물, 프로그램,
  장난감, dinosaurs / nature / trucks 같은 주제), 그 관심사를 해당 자녀에 대한
  관찰로 원문 그대로 기록하십시오.
- 수치: 경력 연수, 개수, 나이, 가격, 측정값.
- 날짜: 달력 날짜, 월, 연도 (정확한 형식 유지 — "April 15, 2026",
  "September 2022", "2021").
- 식별자: 이메일, 전화번호, URL, 버전 번호, 모델 ID.

다음 행위는 반드시 금지합니다:
- 이름을 "[Name]", "[Preschool Name]", "[Company]", "<redacted>",
  "home country", "his son's preschool" 같은 자리표시자로 대체하는 것. 자리표시자는
  memory 를 파괴합니다.
- 구체적인 사람이나 사물의 목록을 하나의 집합 명사로 일반화하는 것. 예:
  "Jin, Priya, Liam, Sara" 를 "the team" 이나
  "colleagues and their locations" 로 압축해서는 안 됩니다. 모든 이름을 보존하십시오.
- 구체적인 사물을 활동 카테고리로 압축하는 것. 예:
  "made bowls and a cup in pottery class" 를 "did pottery" 로 바꾸지 말고 —
  "bowls" 와 "cup" 을 보존하십시오.
- 구체적인 사실을 카테고리로 의역하는 것. 예: "oat latte" 를
  "non-dairy milk preference" 로 바꾸지 마십시오.
- 숫자를 누락시키는 것. 예: "7 years of experience at Google" 을
  "several years of experience" 로 바꾸지 마십시오.

비식별화는 이 작업의 실패 모드입니다. 이름이나 숫자를 보존할지 확신이 서지 않으면,
보존하십시오.`;

export const GRANULARITY_RULE = `# GRANULARITY — memory 한 건당 한 가지 주제 슬롯 (필수)

각 memory 는 하나의 주제 슬롯을 다룹니다. 관련 없는 주제를 하나의 memory 로
합치지 마십시오 — 검색은 주제 유사도로 작동하며, 10 개 주제를 섞은 memory 는
어느 하나도 잘 답하지 못합니다.

주제 슬롯은 좁습니다. 다음은 서로 다른 주제이며, 각각 자체 memory 가 필요합니다:
- editor preference (예: Zed)
- terminal preference (예: Ghostty)
- shell prompt preference (예: Starship)
- indentation preference (예: tabs vs spaces)
- daily-languages preference (예: Rust + TypeScript)
- linter preference (예: Biome over ESLint)
- package-manager preference (예: npm)
- database preference (예: Postgres)
- KV / cache preference (예: Redis, Dragonfly)
- messaging preference (예: NATS.io)
- container runtime preference (예: Podman)
- deploy-target preference (예: Fly.io, Google Cloud Run)
- hardware preference (예: MacBook Pro M4 Max)

여러 선호를 나열하는 사용자의 한 번의 발화는 여러 개의 memory 를 생성해야 합니다 —
주제 슬롯마다 하나씩 — 단일 "Coding Stack" 메가 메모리가 아니라. 비대한 1 건보다
초점이 잡힌 8 건이 더 낫습니다.

사실도 마찬가지입니다: 직무 이력은 role 마다 하나의 주제입니다. "3 years at DeepMind" 와
"4 years at Google" 은 둘 다 이전 고용을 묘사하지만 서로 다른 주제입니다. 명시된
duration AND 시작 날짜를 동일한 per-role entity 안에 함께 유지한 채 별도의 entity
memory 로 만드십시오 ("Employment dates" 를 별도 memory 로 분기시키지 마십시오 —
응답 모델이 명시된 연수를 사용하지 않고 날짜를 합산할 수 있습니다).

사용자가 "migrated from X to Y" / "switched from X to Y" / "sold X, got Y"
라고 말할 때: 변경을 기록하는 날짜가 있는 \`episodic\` memory AND 업데이트된 현재
상태를 기록하는 \`profile\` memory 를 모두 출력하십시오. 필수 두-memory 출력 형태는
예제 섹션의 migration few-shot 을 참조하십시오.`;
