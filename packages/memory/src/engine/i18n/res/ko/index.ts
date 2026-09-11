import type { LocaleResources } from "../_types";
import { defineLocaleResources } from "../locale-resource-helpers";
import { buildDateResolutionPrompt } from "../date-resolution-prompt";
import { buildDedupPrompt, buildExtractionPrompt } from "./extraction-prompts";
import { buildReflectionFallbackText, buildReflectionPrompt } from "./reflection-prompts";

const captureTriggers = {
	identityPattern: /제 이름|나는|살고|일해|역할|이메일|전화|알레르기/,
	preferencePattern: /선호|좋아|싫어|원해|필요|습관/,
	entityPattern:
		/\+\d{10,}|[\w.-]+@[\w.-]+\.\w+|프로젝트|팀|회사|조직|매니저|가족|반려동물|저장소|서비스/,
	eventPattern: /결정|선택|전환|마이그레이션|릴리스|배포|사고|발생|앞으로/,
	lessonPattern: /배웠|교훈|다음번|실수|피하|다시는|근본 원인|해결책|회고/,
	temporalPhrases: [
		{ patterns: [/오늘/], anchor: "today" },
		{ patterns: [/어제/], anchor: "yesterday" },
		{ patterns: [/모레/], anchor: "day_after_tomorrow" },
		{ patterns: [/내일/], anchor: "tomorrow" },
		{ patterns: [/이번 주/], anchor: "this_week" },
		{ patterns: [/다음 주/], anchor: "next_week" },
		{ patterns: [/지난 주/], anchor: "last_week" },
		{ patterns: [/이번\s?달/], anchor: "this_month" },
		{ patterns: [/다음\s?달/], anchor: "next_month" },
		{ patterns: [/오늘 밤/], anchor: "tonight" },
		{ patterns: [/오늘\s?아침/], anchor: "this_morning" },
		{ patterns: [/최근|지금|방금/], anchor: "recent" },
	],
	// 시 is the hour counter, written either with digits ("3시") or with a native numeral
	// ("세 시"). Both mean the sentence states a clock time the day-anchor table above cannot
	// express. Two things this must NOT do: match 시간, which counts a DURATION ("3시간 일했다",
	// worked three hours) and states no clock time at all; and match a bare 오전/오후, which
	// names a half-day, not an hour — every real clock time carries 시 anyway. The native
	// numerals are ordered longest-first so 열 does not eat 열한 and 열두.
	temporalClockTimePattern: /(?:\d+|열두|열한|열|아홉|여덟|일곱|여섯|다섯|네|세|두|한)\s*시(?!간)/,
	explicitMemoryCommandPositivePatterns: [
		/^\s*(?:이걸|이를|이\s*내용을)?\s*기억해(?:\s*둬|\s*주세요|\s*줘|\s*두세요)?/,
		/(?:장기\s*기억으로|장기\s*메모리로|기억으로)\s*\S{0,80}저장/,
		/나중에\s*\S{0,30}(?:참조|회상|기억)할\s*수\s*있도록\s*\S{0,30}저장/,
	],
	explicitMemoryCommandRecallQuestionPatterns: [
		/(?:기억해\?|기억하니\?|기억나\?|기억하세요\??|기억하십니까\??)\s*$/,
	],
	explicitMemoryCommandManagementPatterns: [/^\s*(?:잊어|잊어버려|삭제해|지워|비워|제거해|폐기해)/],
	weekStartDay: 1,
} as const;

const noise = {
	denialPatterns: [
		/(정보|데이터|기억|기록)(이|가)\s?없(습니다|어요|다)/,
		/잘\s?모르겠/,
		/기억(이\s)?안\s?(나|납니다)/,
		/생각이\s?안\s?(나|납니다)/,
		/찾을\s?수\s?없(었|었습니다)/,
		/(관련|관련된)?\s?기억(을|이)\s?찾을\s?수\s?없/,
		/접근(할\s?수\s?없|권한이\s?없)/,
		/모릅니다/,
	],
	metaQuestionPatterns: [
		/기억(하|나)(세요|니|시나요)/,
		/기억\s?안\s?나(시|니)/,
		/(내|제)가\s?(말했|얘기했|언급했)/,
		/(내|제)가\s?(말한\s?적|얘기한\s?적|언급한\s?적)/,
		/내가\s?뭐라고\s?(말|얘기)했/,
	],
	metaFrustrationPatterns: [
		// Assistant-targeted (benefactive 해주 / explicit 2nd person) or system failure
		// only — bare "I always forget" self-facts are legitimate memories, not noise.
		/기억(을)?\s?(못\s?해\s?주|안\s?해\s?주)/,
		/기억이\s?(사라졌|틀렸|없어졌|망가졌)/,
		/왜\s?(너|니가|네가|당신).{0,5}(기억|까먹|잊어)/,
	],
} as const;



const toolDescriptions = {
	memoryRecall: "하이브리드 검색(벡터 + 키워드)으로 장기 기억을 검색합니다.",
	memoryStore: "중요한 정보를 장기 기억에 저장합니다.",
	memoryForget: "ID 또는 쿼리로 특정 기억을 삭제합니다.",
	memoryUpdate: "ID로 저장된 기억을 업데이트합니다.",
	memoryStats: "기억 사용 통계를 표시합니다.",
	memoryList: "페이징과 필터로 저장된 기억을 목록화합니다.",
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
	invariantSignals: [/항상|절대|규칙|불변|결정|안정/],
	derivedSignals: [/배움|관찰|회고|반성|파생|변경|확인/],
	openLoopSignals: [/TODO|후속|다음|액션|확인|재확인/i],
	invariantLegacySignals: [/항상|절대|규칙|불변|결정|안정/],
	derivedLegacySignals: [/배움|관찰|회고|반성|파생|변경|확인/],
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
		correctionSignals: [/사실|아니|정정|이어야/],
		ackTokens: [/^(알겠습니다|알겠|알았|네|좋아요)\s*[.!]?$/],
		memoryIntent: [/기억|저장|기록/],
		reflectionSliceClassifiers,
	},
);
