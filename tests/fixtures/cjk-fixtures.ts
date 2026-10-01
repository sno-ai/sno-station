export const CJK_I18N_FIXTURES = {
	sessionTimestamp: Date.UTC(2026, 4, 12, 9, 30, 0),
	jaNextMonth: "来月に請求プロジェクトを再確認します。",
	koTonight: "오늘 밤 배포 절차를 다시 확인해.",
	koCorrection: "아니, 이름은 민수여야 해.",
	koMemoryIntent: "이 배포 절차를 기억해줘.",
	esEntityFact: "El proyecto Hercules tiene como contacto a Laura.",
	zhFts: "茶太郎の病院 + 血液検査",
	governanceMarkdown: `## Learning governance candidates (.learnings / promotion / skill extraction)

### Entry 1
**Priority**: high
**Status**: pending
**Area**: i18n
### Summary
CJK temporal anchors must stay locale-owned.
### Details
Japanese and Korean month-level anchors are resource data, not English-only code constants.
### Suggested Action
Keep the locale bundle as the source of truth.

### Entry項目
### Summary
This malformed CJK-suffixed heading must not split into a second entry.
`,
	esReflectionMarkdown: `## Invariants & Reflections

- regla estable: siempre conserva los anclajes temporales por locale.
- reflexión heredada: verificar la ruta CJK después del cambio.
`,
} as const;

export const CJK_LOCALES = ["zh", "zh-Hant", "ja", "ko"] as const;

export const CJK_I18N_FIXTURE_MATRIX = {
	explicitRemember: {
		zh: "请记住 Atlas 的部署规则。",
		"zh-Hant": "請記住 Atlas 的部署規則。",
		ja: "Atlas のデプロイルールを覚えてください。",
		ko: "Atlas 배포 규칙을 기억해 주세요.",
	},
	recallQuestion: {
		zh: "你还记得 Atlas 的部署规则吗？",
		"zh-Hant": "你還記得 Atlas 的部署規則嗎？",
		ja: "Atlas のデプロイルールを覚えていますか？",
		ko: "Atlas 배포 규칙을 기억해?",
	},
	replyControlSuffix: {
		zh: "好的，我会处理。<final>",
		"zh-Hant": "好的，我會處理。<final>",
		ja: "はい、対応します。<final>",
		ko: "네, 처리할게요.<final>",
	},
	denial: {
		zh: "我没有找到相关记忆。",
		"zh-Hant": "我沒有找到相關記憶。",
		ja: "関連する記憶が見つかりません。",
		ko: "관련 기억을 찾지 못했어요.",
	},
	boilerplate: {
		zh: "你好",
		"zh-Hant": "你好",
		ja: "こんにちは",
		ko: "안녕하세요",
	},
	metaQuestion: {
		zh: "你还记得我之前说过的吗？",
		"zh-Hant": "你還記得我之前提過的事嗎？",
		ja: "前に話したことを覚えていますか？",
		ko: "전에 말한 걸 기억해?",
	},
	roleLabelPrefix: {
		zh: "用户: 请记住我的名字。",
		"zh-Hant": "使用者: 請記住我的名字。",
		ja: "ユーザー: 私の名前を覚えてください。",
		ko: "사용자: 내 이름을 기억해 주세요.",
	},
	temporality: {
		zh: "下个月复查部署。",
		"zh-Hant": "下個月複查部署。",
		ja: "来月にデプロイを確認します。",
		ko: "다음 달 배포를 확인해.",
	},
	categoryRouting: {
		zh: "项目 Atlas 的联系人是 Dana。",
		"zh-Hant": "專案 Atlas 的聯絡人是 Dana。",
		ja: "プロジェクト Atlas の連絡先は Dana です。",
		ko: "프로젝트 Atlas 연락처는 Dana입니다.",
	},
	reflectionSlices: {
		zh: "稳定规则：始终保留 locale 拥有的时间锚点。",
		"zh-Hant": "穩定規則：始終保留 locale 擁有的時間錨點。",
		ja: "安定ルール: locale 所有の時間アンカーを常に保持する。",
		ko: "안정 규칙: locale 소유 시간 앵커를 항상 유지한다.",
	},
} as const;
